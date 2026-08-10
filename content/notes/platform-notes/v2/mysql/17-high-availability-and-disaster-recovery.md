# Chapter 17: High Availability and Disaster Recovery

## Zero-Downtime and Zero-Data-Loss Architecture

---

MySQL does not fail gracefully by default. A single mysqld process dies, and every
application connected to it gets a broken pipe. Replication gives you a copy of the
data, but it does not give you automatic failover, split-brain prevention, or
point-in-time recovery. Those require deliberate architecture.

This chapter builds HA and DR systems from first principles. We start with the metrics
that define availability, then work through every failover mechanism from manual VIP
swaps to Paxos-based consensus. We end with backup strategies and disaster recovery
patterns that protect against the failure modes replication cannot cover: data
corruption, operator error, and regional outages.

Every recommendation is grounded in the replication internals from Chapter 12 and the
crash recovery mechanics from Chapter 8.

---

## 1. HA Fundamentals — Defining What "Available" Means

### 1.1 RPO and RTO — The Two Numbers That Define Every HA Architecture

Every HA discussion starts with two metrics. If you cannot state these numbers for
your system, you do not have an HA architecture — you have hope.

**RPO (Recovery Point Objective)**: How much data loss is acceptable when a failure
occurs. Measured in time. RPO=0 means zero data loss — every committed transaction
must survive any single-node failure. RPO=5m means you accept losing up to 5 minutes
of committed writes.

**RTO (Recovery Time Objective)**: How quickly must service be restored after a failure
is detected. RTO=30s means the system must be accepting read-write traffic within 30
seconds of the primary going down. RTO=4h means you can tolerate a four-hour outage.

```
                       RPO and RTO on a Timeline

  Last backup      Failure occurs        Service restored
      |                  |                      |
      v                  v                      v
  ----+------------------+----------------------+----------> time
      |<--- RPO -------->|                      |
      |  (data at risk)  |<------ RTO --------->|
                         |  (service is down)   |
```

The relationship between RPO, RTO, and cost is nonlinear:

```
  Cost ($$$)
    |
    |                                          *  RPO=0, RTO<10s
    |                                       *     (Group Replication,
    |                                    *         multi-node consensus)
    |                                *
    |                          *              RPO~0, RTO<30s
    |                    *                    (semi-sync + Orchestrator)
    |              *
    |         *                               RPO=minutes, RTO=minutes
    |      *                                  (async + MHA)
    |   *
    | *                                       RPO=hours, RTO=hours
    |*                                        (backup + restore)
    +-------------------------------------------------> Availability
```

>>> RPO and RTO are the first things to establish in any system design interview that
involves databases. State them explicitly: "For this payment system, RPO must be zero
and RTO must be under 30 seconds. That rules out async replication and mandates either
Group Replication or a synchronous protocol." This immediately signals architectural
maturity.

### 1.2 Availability Tiers

Availability is measured in "nines." Each additional nine represents a 10x reduction in
permitted downtime. The jump from 99.9% to 99.99% is not a tuning exercise — it is
an entirely different architecture.

| Level   | Nines | Downtime/year | Downtime/month | Typical approach               |
|---------|-------|---------------|----------------|---------------------------------|
| 99%     | 2     | 3.65 days     | 7.31 hours     | Manual failover, single node    |
| 99.9%   | 3     | 8.77 hours    | 43.8 minutes   | Automated failover, async repl  |
| 99.99%  | 4     | 52.6 minutes  | 4.38 minutes   | Multi-node replication, proxy   |
| 99.999% | 5     | 5.26 minutes  | 25.9 seconds   | Multi-region, consensus-based   |

What counts as "downtime" matters. If your SLA measures HTTP 200 rates from the
application's perspective, a 10-second failover that causes 500 connection errors
and 30 seconds of connection pool refill is 40 seconds of effective downtime, not 10.

```
  Timeline of a "10-second" failover as seen by applications:

  Primary dies
       |
       v
  -----+--[detection: 3s]--[election: 2s]--[promotion: 5s]--[DNS/VIP: 2s]--+---->
       |                                                                     |
       |<--- connections failing, apps retrying, pool draining ------------->|
       |                                                                     |
       |  Actual application-visible downtime: 12-40 seconds                 |
       |  (depends on connection pool config, retry logic, health checks)    |
```

### 1.3 Single Point of Failure (SPOF) Analysis

An HA architecture is only as strong as its weakest SPOF. Walk through every
component in the write path:

```
  Application
      |
   Load Balancer        <-- SPOF? (pair them, active/passive)
      |
   Connection Pool      <-- SPOF? (runs inside app JVM, single instance?)
      |
   ProxySQL / Router    <-- SPOF? (run 2+ instances, sidecar or cluster)
      |
   MySQL Primary        <-- SPOF? (this is the one you MUST eliminate)
      |
   Storage (EBS/SAN)    <-- SPOF? (use replicated block storage or local NVMe + repl)
      |
   Network Switch       <-- SPOF? (dual-homed NICs, redundant switches)
      |
   Power / Rack         <-- SPOF? (distribute nodes across racks/AZs)
      |
   Region               <-- SPOF? (multi-region DR for regional outages)
```

Every box in the write path must either be redundant or have an automated failover
mechanism. The primary MySQL node is the most critical SPOF — eliminating it is the
central problem of this entire chapter.

>>> In interviews, when asked "how would you make this MySQL deployment highly
available," start by drawing the full component stack and labeling every SPOF. This
demonstrates that HA is not just about the database — it is about the entire path
from the application to durable storage.

---

## 2. Replication-Based HA — Primary-Replica Failover

### 2.1 The Foundation: One Primary, N Replicas

The simplest HA architecture uses standard MySQL replication (Chapter 12):

```
                     +------------------+
                     |  Application     |
                     +--------+---------+
                              |
                     +--------v---------+
                     |  MySQL Primary   |
                     |  (read-write)    |
                     +--------+---------+
                              |
              +---------------+---------------+
              |                               |
     +--------v---------+           +--------v---------+
     |  MySQL Replica 1 |           |  MySQL Replica 2 |
     |  (read-only)     |           |  (read-only)     |
     +------------------+           +------------------+
```

When the primary fails, you must:
1. Detect the failure
2. Choose which replica to promote
3. Promote the chosen replica (stop replication, set `read_only=OFF`)
4. Redirect application traffic to the new primary
5. Point remaining replicas at the new primary

Each step introduces latency and failure modes.

### 2.2 The Replica Selection Problem

When the primary dies, different replicas may have received different amounts of data.
With asynchronous replication, the primary's binary log may be ahead of what any
replica has received. With semi-synchronous replication, at least one replica has
acknowledged receipt of the last committed transaction.

```
  Primary binlog position:  binlog.000042:98765432
  
  Replica A (GTID):  gtid_executed = ...:1-50000
  Replica B (GTID):  gtid_executed = ...:1-49998
  Replica C (GTID):  gtid_executed = ...:1-49995
  
  Best candidate: Replica A (most transactions applied)
  Data loss: whatever was committed on primary after GTID :50000
```

With GTID-based replication, the selection is straightforward — the replica with the
highest executed GTID set is the most up-to-date. Without GTID, you must compare
`Relay_Master_Log_File` and `Exec_Master_Log_Pos`, which is fragile across topology
changes.

### 2.3 Data Loss Window by Replication Mode

| Replication Mode         | Data Loss on Primary Failure             | RPO        |
|--------------------------|------------------------------------------|------------|
| Async                    | All transactions not yet sent to replica | Seconds    |
| Semi-sync (AFTER_COMMIT) | Last transaction (committed but unacked) | ~0 (1 txn) |
| Semi-sync (AFTER_SYNC)   | Zero (committed only after ack)          | 0          |
| Group Replication        | Zero (consensus before commit)           | 0          |

```
  Async replication — data loss window:

  Primary:   [T1 commit] [T2 commit] [T3 commit] [T4 commit] [CRASH]
  Replica:   [T1 applied] [T2 received]
                                       |<-- T3, T4 lost -->|

  Semi-sync AFTER_SYNC — no data loss:

  Primary:   [T1: write binlog → wait ack → commit → return to client]
  Replica:   [T1: receive → ack → apply]
             If primary crashes after binlog write but before commit,
             T1 is on replica but was never committed on primary.
             Replica has the data. Promote replica → no loss.
```

>>> "What is the difference between AFTER_SYNC and AFTER_COMMIT in semi-synchronous
replication?" is a frequently asked interview question. AFTER_SYNC (the default since
MySQL 5.7.2) waits for the replica acknowledgment BEFORE committing on the primary and
returning to the client. This means the client never sees a committed transaction that
the replica does not have. AFTER_COMMIT commits first, then waits — creating a window
where the client sees a committed transaction that might be lost if the primary crashes
before the replica acknowledges.

### 2.4 Traffic Redirection — DNS, VIP, and Proxy

Once a new primary is elected, applications must connect to it. Three mechanisms:

**DNS-based failover:**
```
  mysql-primary.example.com  →  A record: 10.0.1.10  (old primary)
  
  On failover:
  mysql-primary.example.com  →  A record: 10.0.1.11  (new primary)
  
  Problem: DNS TTL. Even with TTL=30s, clients cache DNS resolutions.
  Java's InetAddress caches indefinitely by default (networkaddress.cache.ttl).
  Set networkaddress.cache.ttl=30 in java.security or as JVM property.
  Some connection pools (HikariCP) do periodic DNS re-resolution.
```

**VIP (Virtual IP) failover:**
```
  VIP 10.0.1.100 floats between nodes.
  
  Before failover:
    Node A (primary):   eth0: 10.0.1.10, eth0:1: 10.0.1.100 (VIP)
    Node B (replica):   eth0: 10.0.1.11
  
  After failover:
    Node A (dead):      ---
    Node B (new primary): eth0: 10.0.1.11, eth0:1: 10.0.1.100 (VIP)
  
  + No DNS caching issues — IP is the same
  + Fast — gratuitous ARP updates switch MAC tables in milliseconds
  - Only works within same L2 network segment (same subnet/VLAN)
  - Does not work across regions or cloud VPCs without overlay networking
```

**Proxy-based failover (ProxySQL, MySQL Router):**
```
  Application → ProxySQL → MySQL Primary
                         → MySQL Replica 1 (read pool)
                         → MySQL Replica 2 (read pool)
  
  ProxySQL monitors primary via health checks.
  On primary failure:
    1. ProxySQL detects failure (configurable check interval, typically 1-3s)
    2. Removes old primary from writer hostgroup
    3. Promotes new primary to writer hostgroup
    4. Application connections seamlessly route to new primary
  
  + No DNS/VIP issues — proxy handles routing transparently
  + Can split read/write traffic automatically
  + Works across subnets, VPCs, regions
  - Proxy itself is a SPOF (run 2+ instances)
  - Additional network hop (~100-300 us latency)
```

>>> In a system design interview, always mention the proxy approach. ProxySQL is the
industry-standard answer for MySQL traffic management. It eliminates the DNS TTL
problem, handles read/write splitting, and integrates with Orchestrator for automated
failover. The latency overhead (~200 us) is negligible compared to a typical query
execution time.

---

## 3. InnoDB Cluster (MySQL 8.0) — Built-In Paxos-Based HA

### 3.1 Architecture Overview

InnoDB Cluster is MySQL's integrated HA solution, introduced in MySQL 8.0. It
combines three components into a turnkey cluster:

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                        Application                                  │
  │                   (JDBC / Connector)                                │
  └─────────────────────────┬───────────────────────────────────────────┘
                            │
  ┌─────────────────────────v───────────────────────────────────────────┐
  │                     MySQL Router                                    │
  │               port 6446 = Read-Write                                │
  │               port 6447 = Read-Only                                 │
  │         (routes based on primary/secondary status)                  │
  └──────────┬──────────────┬──────────────┬────────────────────────────┘
             │              │              │
  ┌──────────v──────┐ ┌─────v──────┐ ┌─────v──────┐
  │   GR Node 1     │ │  GR Node 2 │ │  GR Node 3 │
  │   (PRIMARY)     │ │ (SECONDARY)│ │ (SECONDARY)│
  │                 │ │            │ │            │
  │  read-write     │ │  read-only │ │  read-only │
  └────────┬────────┘ └─────┬──────┘ └─────┬──────┘
           │                │              │
           └────────────────┼──────────────┘
                            │
                   Paxos Consensus
              (Group Communication System)
```

**Component 1 — Group Replication (GR):**

Group Replication is the data replication layer. It uses the Paxos consensus
algorithm (specifically, a variant called XCom) to ensure that all nodes in the
group agree on the order of transactions. A transaction is committed only after a
majority of nodes have acknowledged it.

This is fundamentally different from semi-sync replication:

| Aspect                 | Semi-sync                        | Group Replication                |
|------------------------|----------------------------------|----------------------------------|
| Protocol               | Primary waits for 1 ack          | Paxos consensus (majority ack)   |
| Ordering guarantee     | None — replicas may diverge      | Total order — all nodes agree    |
| Conflict detection     | None — last-writer-wins          | Certification-based — conflicts abort |
| Failover               | External tool required           | Built-in primary election        |
| Minimum nodes          | 2 (primary + replica)            | 3 (Paxos majority requires 2/3) |
| Data loss on failure   | Near-zero (AFTER_SYNC)           | Zero (consensus-confirmed)       |

**Component 2 — MySQL Shell:**

The administrative interface. Provides JavaScript and Python APIs for cluster
lifecycle management:

```javascript
// Create a new InnoDB Cluster
var cluster = dba.createCluster('production');

// Add nodes to the cluster
cluster.addInstance('node2.example.com:3306');
cluster.addInstance('node3.example.com:3306');

// Check cluster health
cluster.status();
// Output:
// {
//   "clusterName": "production",
//   "status": "OK",
//   "statusText": "Cluster is ONLINE and can tolerate up to ONE failure.",
//   "topology": {
//     "node1:3306": { "status": "ONLINE", "memberRole": "PRIMARY" },
//     "node2:3306": { "status": "ONLINE", "memberRole": "SECONDARY" },
//     "node3:3306": { "status": "ONLINE", "memberRole": "SECONDARY" }
//   }
// }

// Force-remove a problematic node
cluster.removeInstance('node3.example.com:3306', {force: true});

// Reboot cluster from complete outage
dba.rebootClusterFromCompleteOutage();
```

**Component 3 — MySQL Router:**

The application-facing proxy. Deployed as a sidecar or centralized proxy:

```
  MySQL Router configuration (auto-generated by bootstrap):
  
  [routing:production_rw]
  bind_address = 0.0.0.0
  bind_port = 6446
  destinations = metadata-cache://production/?role=PRIMARY
  routing_strategy = first-available
  protocol = classic
  
  [routing:production_ro]
  bind_address = 0.0.0.0
  bind_port = 6447
  destinations = metadata-cache://production/?role=SECONDARY
  routing_strategy = round-robin-with-fallback
  protocol = classic
```

Application JDBC configuration:
```
jdbc:mysql://router-host:6446/mydb           # writes (routed to PRIMARY)
jdbc:mysql://router-host:6447/mydb           # reads (round-robin across SECONDARIES)
```

### 3.2 How Group Replication Consensus Works

When a transaction commits on the primary node, the following sequence occurs:

```
  Step 1: Transaction executes locally on primary
          (reads, writes to buffer pool, generates binlog events)
  
  Step 2: Primary broadcasts writeset to group via XCom (Paxos)
          Writeset = {table, primary key, modified columns}
  
  Step 3: XCom delivers the message to all nodes in agreed total order
          (this is the Paxos consensus round)
  
  Step 4: Each node performs CERTIFICATION
          - Check: does this writeset conflict with any concurrent certified
            but not-yet-applied writeset?
          - Conflict = overlapping primary keys with concurrent transaction
          - If conflict: ABORT the transaction on the originating node
          - If no conflict: CERTIFY (approve) the transaction
  
  Step 5: On the originating node: commit and return OK to client
          On secondary nodes: apply the transaction via applier thread
```

```
  Certification conflict detection:

  Node 1 (primary): UPDATE accounts SET balance=100 WHERE id=42;
  Node 2 (primary in multi-primary mode): UPDATE accounts SET balance=200 WHERE id=42;
  
  Both broadcast their writesets concurrently.
  XCom delivers them in some total order: T1 first, then T2.
  
  Certification of T1: no conflict → certified
  Certification of T2: conflict with T1 (same PK: id=42) → ABORTED
  
  T2's originating node receives a certification failure.
  Application gets ERROR 1180: "Deadlock found when trying to get lock"
  Application must retry.
```

### 3.3 Automatic Failover Sequence

When the primary node fails:

```
  Time 0s:    Primary (Node 1) crashes
  
  Time 0-5s:  GR suspicion mechanism activates
              - Nodes 2 and 3 stop receiving heartbeats from Node 1
              - After group_replication_member_expel_timeout (default 5s),
                Node 1 is expelled from the group
  
  Time 5-6s:  Primary election
              - Remaining nodes hold an election
              - Node with lowest server_uuid wins (by default)
              - Or: configured via group_replication_member_weight
  
  Time 6-7s:  New primary (Node 2) sets super_read_only=OFF
              - MySQL Router detects metadata change
              - Router redirects write traffic to Node 2
  
  Time 7s+:   Service restored
              - New connections go to Node 2 (writes) and Node 3 (reads)
              - RPO = 0 (consensus-confirmed transactions only)
              - RTO = ~5-10 seconds (dominated by expel timeout)
```

You can tune the detection speed:

```sql
-- Faster detection (more aggressive, higher false-positive risk)
SET GLOBAL group_replication_member_expel_timeout = 0;
-- Default: 5 seconds. Range: 0-3600.

-- Reduce the suspicion period
-- (internal GR parameter, not directly exposed in all versions)

-- Control which node becomes primary
SET GLOBAL group_replication_member_weight = 80;  -- higher = preferred
-- Default: 50. Range: 0-100.
```

### 3.4 Limitations

InnoDB Cluster is powerful but not universal:

**Minimum 3 nodes for fault tolerance.** Paxos requires a majority to make progress.
With 3 nodes, you tolerate 1 failure (2/3 majority). With 5 nodes, you tolerate 2
failures (3/5 majority). With 2 nodes, a single failure means no majority — the
surviving node cannot commit.

```
  Node count vs fault tolerance:
  
  Nodes   Majority   Tolerates   Notes
  -----   --------   ---------   -----
    1        1           0        No HA at all
    2        2           0        Both must be alive for writes
    3        2           1        Standard production minimum
    5        3           2        Recommended for critical systems
    7        4           3        Rarely needed; more consensus overhead
```

**Write latency includes consensus round-trip.** Every write transaction must be
broadcast to the group and acknowledged by a majority before committing. In a 3-node
cluster within the same datacenter (RTT ~0.5ms), this adds ~1-2ms to commit latency.
Across regions (RTT ~30-80ms), this makes Paxos-based writes prohibitively slow.

**All nodes should be in the same region.** Cross-region Paxos is technically possible
but adds 30-80ms per commit. This is why InnoDB ClusterSet exists — Group Replication
within a region, async replication across regions.

**Certification conflicts in multi-primary mode.** When multiple nodes accept writes
simultaneously, conflicting transactions (touching the same rows) are aborted on all
but one node. High-conflict workloads suffer high abort rates in multi-primary mode.
Single-primary mode avoids this entirely.

>>> "When would you NOT use InnoDB Cluster?" — when you need multi-region writes with
low latency (use ClusterSet instead), when you have only 2 nodes (semi-sync + failover
tool), when your workload has extremely high write contention on the same rows
(certification conflicts), or when you need MySQL 5.7 compatibility (GR was
experimental in 5.7).

---

## 4. InnoDB ClusterSet — Multi-Region HA

### 4.1 The Multi-Region Problem

Group Replication cannot span regions efficiently because Paxos consensus requires
a majority acknowledgment for every write. With 3 nodes across 3 regions (us-east,
us-west, eu-west), every commit waits for at least one cross-region round-trip:

```
  3-node GR across regions:
  
  us-east (primary) ──── 30ms RTT ──── us-west
         \                                /
          \___ 80ms RTT ____  ___80ms ___/
                            \/
                          eu-west
  
  Commit latency: ~30ms minimum (must wait for us-west ack)
  This is unacceptable for OLTP workloads expecting <5ms commits.
```

InnoDB ClusterSet solves this by running synchronous Group Replication WITHIN each
region and asynchronous replication ACROSS regions.

### 4.2 Architecture

```
  ┌────────────────────────────────────────────────────────────────┐
  │  Region: us-east (PRIMARY CLUSTER)                             │
  │                                                                │
  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                    │
  │  │ Node 1   │  │ Node 2   │  │ Node 3   │                    │
  │  │ (PRIMARY)│  │(SECONDARY│  │(SECONDARY│                    │
  │  │ R/W      │  │  R/O)    │  │  R/O)    │                    │
  │  └─────┬────┘  └─────┬────┘  └─────┬────┘                    │
  │        └──── Paxos ───┴──── Paxos ──┘                         │
  │                       │                                        │
  │              MySQL Router (6446 RW, 6447 RO)                  │
  └───────────────────────┬────────────────────────────────────────┘
                          │
                    Async Replication
                    (binary log shipping)
                          │
  ┌───────────────────────v────────────────────────────────────────┐
  │  Region: eu-west (REPLICA CLUSTER — read-only)                 │
  │                                                                │
  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                    │
  │  │ Node 4   │  │ Node 5   │  │ Node 6   │                    │
  │  │ (PRIMARY)│  │(SECONDARY│  │(SECONDARY│                    │
  │  │ R/O      │  │  R/O)    │  │  R/O)    │                    │
  │  └─────┬────┘  └─────┬────┘  └─────┬────┘                    │
  │        └──── Paxos ───┴──── Paxos ──┘                         │
  │                       │                                        │
  │              MySQL Router (6447 RO only)                      │
  └────────────────────────────────────────────────────────────────┘
```

Key properties:
- **Within each region**: Group Replication (Paxos) — RPO=0, RTO=seconds
- **Across regions**: Asynchronous replication — RPO=seconds (replication lag)
- **Write traffic**: only the primary cluster accepts writes
- **Read traffic**: both clusters serve reads (local reads in eu-west = low latency)

### 4.3 Cross-Region Failover

When the primary cluster (us-east) goes down entirely:

```javascript
// MySQL Shell — promote the eu-west cluster to primary
var cs = dba.getClusterSet();
cs.forcePrimaryCluster('eu-west-cluster');

// This:
// 1. Stops async replication channel on eu-west cluster
// 2. Applies any remaining relay log events
// 3. Sets eu-west cluster as read-write
// 4. MySQL Router in eu-west starts accepting writes on port 6446
```

This is a manual (or scripted) operation — InnoDB ClusterSet does not auto-failover
across regions by default. The reason: cross-region failure detection is unreliable.
A network partition between regions looks identical to a regional outage. Automatic
cross-region failover risks split-brain.

```
  Controlled switchover (planned maintenance, no data loss):
  cs.setPrimaryCluster('eu-west-cluster');
  
  Emergency failover (us-east is dead, possible data loss):
  cs.forcePrimaryCluster('eu-west-cluster');
  // Data loss = whatever async replication had not yet delivered
```

>>> InnoDB ClusterSet is MySQL's answer to multi-region HA. Within a region:
synchronous (Group Replication, RPO=0). Across regions: asynchronous (RPO=seconds of
replication lag). This is the same pattern used by Amazon Aurora Global Database and
Google Cloud SQL — synchronous locally, asynchronous globally. Know this layered
approach for system design interviews.

---

## 5. InnoDB ReplicaSet — Simpler Async HA

### 5.1 When Group Replication Is Overkill

Not every deployment needs Paxos consensus. InnoDB ReplicaSet provides a managed
async replication topology with MySQL Shell integration, without the overhead of
Group Replication.

```
  InnoDB ReplicaSet architecture:

  ┌──────────────────────────────────────────┐
  │  MySQL Shell (management)                │
  └──────────────┬───────────────────────────┘
                 │
  ┌──────────────v───────────────────────────┐
  │  MySQL Router (6446 RW, 6447 RO)        │
  └──────┬───────────────┬───────────────────┘
         │               │
  ┌──────v──────┐ ┌──────v──────┐
  │  Primary    │ │  Replica    │
  │  (R/W)      │ │  (R/O)     │
  │             │ │            │
  │  Async      │ │            │
  │  binlog ────┼─┤            │
  └─────────────┘ └────────────┘
```

### 5.2 Setup and Management

```javascript
// Create the ReplicaSet
var rs = dba.createReplicaSet('myReplicaSet');

// Add a replica
rs.addInstance('replica1.example.com:3306');

// Check status
rs.status();

// Planned switchover (no data loss — waits for replica to catch up)
rs.setPrimaryInstance('replica1.example.com:3306');

// Emergency failover (replica may be behind — potential data loss)
rs.forcePrimaryInstance('replica1.example.com:3306');
```

### 5.3 InnoDB ReplicaSet vs InnoDB Cluster

| Aspect               | InnoDB ReplicaSet              | InnoDB Cluster                 |
|----------------------|-------------------------------|-------------------------------|
| Replication          | Async (or semi-sync)           | Group Replication (Paxos)      |
| RPO                  | Seconds (async) / ~0 (semi)   | 0 (consensus)                  |
| Automatic failover   | No (manual via MySQL Shell)    | Yes (built-in election)        |
| Minimum nodes        | 2                              | 3                              |
| Write latency        | No consensus overhead          | +1-2ms per commit (same DC)    |
| Certification conflicts | None                        | Possible in multi-primary      |
| Operational overhead | Lower                          | Higher                         |
| Best for             | Smaller deployments, cost-     | Mission-critical, RPO=0        |
|                      | sensitive, RPO-flexible        | requirements                   |

>>> InnoDB ReplicaSet is not widely discussed in interviews, but knowing it exists
shows depth. The key insight: it is MySQL Shell's management layer on top of standard
async replication. It gives you the operational tooling (status, switchover,
forcePrimary) without the consensus overhead.

---

## 6. Orchestrator — GitHub's MySQL Topology Manager

### 6.1 What Orchestrator Does

Orchestrator is an open-source MySQL HA and topology management tool, created and
battle-tested at GitHub, where it manages thousands of MySQL clusters. Unlike InnoDB
Cluster, it works with standard async and semi-sync replication — no Group Replication
required.

```
  Orchestrator's role in the HA stack:

  ┌─────────────────────────────────────────────────────────┐
  │                    Orchestrator                          │
  │                                                         │
  │  ┌──────────┐  ┌──────────┐  ┌────────────────────┐    │
  │  │ Discovery│  │ Failure  │  │ Automated          │    │
  │  │ & Topo   │  │ Detection│  │ Failover           │    │
  │  │ Mapping  │  │          │  │                    │    │
  │  └──────────┘  └──────────┘  └────────────────────┘    │
  │                                                         │
  │  ┌──────────┐  ┌──────────┐  ┌────────────────────┐    │
  │  │ Anti-    │  │ Hooks    │  │ Web UI &           │    │
  │  │ Flapping │  │ (scripts │  │ API                │    │
  │  │          │  │  on topo │  │                    │    │
  │  │          │  │  changes)│  │                    │    │
  │  └──────────┘  └──────────┘  └────────────────────┘    │
  └─────────────────────────────────────────────────────────┘
         │              │              │
  ┌──────v──────┐ ┌─────v──────┐ ┌─────v──────┐
  │ MySQL       │ │ MySQL      │ │ MySQL      │
  │ Primary     │ │ Replica A  │ │ Replica B  │
  └─────────────┘ └────────────┘ └────────────┘
```

### 6.2 Core Features

**Topology Discovery:**
Orchestrator connects to every MySQL instance it knows about, reads
`SHOW SLAVE STATUS` / `SHOW REPLICA STATUS`, and builds a complete replication
topology graph. It discovers new nodes automatically by following replication links.

**Failure Detection:**
Orchestrator actively probes each node. When the primary becomes unreachable, it
waits for a configurable number of consecutive failures before declaring a dead
primary. It uses multiple detection paths — direct connection failure, replica I/O
thread failure, and cross-checking with other Orchestrator nodes.

**Automated Failover — Replica Promotion:**

```
  Failover decision tree:

  Primary unreachable?
      │
      ├── Yes, confirmed by multiple probes
      │       │
      │       ├── Find best replica candidate:
      │       │     1. Most up-to-date (highest GTID executed)
      │       │     2. Same binlog format as primary
      │       │     3. Not in "promotion blacklist" (maintenance nodes)
      │       │     4. Preferred datacenter/rack
      │       │     5. Configured promotion rules (prefer semi-sync replicas)
      │       │
      │       ├── Promote chosen replica:
      │       │     1. STOP SLAVE on candidate
      │       │     2. Wait for relay log to drain (apply pending events)
      │       │     3. RESET SLAVE ALL
      │       │     4. SET GLOBAL read_only = OFF
      │       │     5. SET GLOBAL super_read_only = OFF
      │       │
      │       ├── Repoint remaining replicas:
      │       │     CHANGE MASTER TO MASTER_HOST='new-primary' ...
      │       │     (uses GTID auto-positioning for safety)
      │       │
      │       └── Execute hooks:
      │             - Update ProxySQL hostgroups
      │             - Update DNS/VIP
      │             - Send PagerDuty alert
      │             - Run custom scripts
      │
      └── No → continue monitoring
```

**Complex Topology Support:**
Orchestrator handles intermediate masters (cascading replication), co-masters
(circular replication), and can refactor topologies — moving replicas between
masters without downtime.

**Anti-Flapping:**
After performing a failover, Orchestrator enters a cooldown period. If the old
primary comes back momentarily and then fails again, Orchestrator does not perform
a second failover within the grace period. This prevents cascading failovers during
network instability.

### 6.3 Orchestrator's Own HA — RAFT

Orchestrator itself must be highly available. A single Orchestrator node is a SPOF.
The solution: run Orchestrator as a 3-node RAFT cluster.

```
  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
  │ Orchestrator 1 │  │ Orchestrator 2 │  │ Orchestrator 3 │
  │ (RAFT Leader)  │  │ (RAFT Follower)│  │ (RAFT Follower)│
  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘
          │                   │                   │
          └───── RAFT consensus log ──────────────┘
          
  Only the RAFT leader performs active monitoring and failover.
  If the leader dies, a new leader is elected and resumes operations.
  Shared state is replicated via RAFT — no external database needed
  (though backend MySQL/SQLite is used for Orchestrator's own metadata).
```

### 6.4 Orchestrator vs InnoDB Cluster

| Aspect                  | Orchestrator                     | InnoDB Cluster                  |
|-------------------------|----------------------------------|---------------------------------|
| Replication protocol    | Async / semi-sync                | Group Replication (Paxos)       |
| RPO                     | Depends on repl mode             | 0 (consensus)                   |
| Failover automation     | Yes (configurable)               | Yes (built-in)                  |
| Split-brain prevention  | Hooks + external fencing         | Inherent (Paxos majority)       |
| Topology flexibility    | Cascading, co-master, etc.       | Flat group only                 |
| MySQL version           | 5.6+ (works with anything)       | 8.0+ only                       |
| External dependency     | Orchestrator binary              | Built into MySQL                |
| Used by                 | GitHub, Booking.com, Shopify     | Oracle-recommended deployments  |
| Operational maturity    | Battle-tested at massive scale   | Newer, fewer large deployments  |

>>> In interviews, knowing Orchestrator signals real production experience.
The key talking point: Orchestrator works with ANY MySQL replication topology and
does not require Group Replication. This makes it the pragmatic choice for existing
large-scale deployments that cannot migrate to InnoDB Cluster.

---

## 7. MHA — Master High Availability Manager

### 7.1 How MHA Works

MHA (Master High Availability Manager) was created by Yoshinori Matsuura at DeNA
and later used extensively at Facebook. It is a Perl-based tool that automates
primary failover with minimal data loss.

MHA consists of two components:

- **MHA Manager**: runs on a dedicated node, monitors the primary
- **MHA Node**: runs on every MySQL node, handles relay log operations

### 7.2 Failover Sequence

```
  MHA failover — step by step:

  1. MHA Manager detects primary failure
     (configurable: ping, MySQL connection, SSH check)

  2. MHA connects to ALL replicas via SSH
     Reads each replica's relay log position:
       Replica A: relay-log.000005, pos 12345
       Replica B: relay-log.000005, pos 12100
       Replica C: relay-log.000005, pos 11800

  3. Identify the most up-to-date replica (Replica A)

  4. If possible, SSH into dead primary and copy remaining binlog events
     that haven't reached any replica yet (best-effort data salvage)

  5. Generate "differential relay logs" — the events that Replica A has
     but Replica B and C do not

  6. Apply differential relay logs to Replica B and C
     Now all replicas have identical data

  7. Promote Replica A as new primary:
     - STOP SLAVE
     - RESET SLAVE ALL
     - SET GLOBAL read_only = OFF

  8. Point Replica B and C to new primary (Replica A)

  9. Execute failover scripts (VIP swap, DNS update, etc.)
```

```
  Relay log differential — the key MHA innovation:

  Primary binlog:     [...event100...event101...event102...event103]
                                                         ^ primary died here
  
  Replica A relay:    [...event100...event101...event102]  ← most complete
  Replica B relay:    [...event100...event101]             ← missing event102
  Replica C relay:    [...event100]                        ← missing 101, 102
  
  MHA generates:
    diff_for_B = [event102]         ← apply to bring B up to A's level
    diff_for_C = [event101, event102] ← apply to bring C up to A's level
  
  After applying diffs, all replicas are at event102.
  Promote Replica A. Zero divergence among replicas.
```

### 7.3 MHA Limitations and Status

MHA achieves near-zero data loss with semi-sync replication and zero data divergence
among replicas. However:

- It performs a single failover and then exits. It does not continuously manage the
  topology like Orchestrator.
- It is Perl-based and requires SSH access between all nodes.
- It does not have a web UI or API.
- It is no longer actively developed — Orchestrator and InnoDB Cluster have largely
  superseded it.

MHA is still running in production at many organizations, but new deployments
generally choose Orchestrator or InnoDB Cluster.

>>> MHA appears in interviews as a "what did people use before InnoDB Cluster" question.
The key insight to mention: MHA's relay log differential technique — it computes the
difference between replicas' relay logs and fills the gaps, ensuring all replicas
converge to the same state before promotion. This is more sophisticated than simply
promoting the most up-to-date replica.

---

## 8. Split-Brain Prevention — The Hardest Problem in HA

### 8.1 What Split-Brain Is and Why It Is Catastrophic

Split-brain occurs when two nodes simultaneously believe they are the primary and
both accept writes. The result is data divergence that is extremely difficult —
sometimes impossible — to reconcile.

```
  Split-brain scenario:

  Time 0:  Network partition between Node A (primary) and Node B (replica)
  
  Time 1:  Failover tool detects Node A as "unreachable" (but it's alive)
           Promotes Node B to primary
  
  Time 2:  Node A is alive and still accepting writes (old primary)
           Node B is alive and accepting writes (new primary)
  
           App Server 1 → Node A:  INSERT INTO orders (id=1001, amount=500)
           App Server 2 → Node B:  INSERT INTO orders (id=1001, amount=700)
  
  Time 3:  Network heals. Two nodes have conflicting data for id=1001.
           Which is correct? Both are. This is the split-brain disaster.
```

### 8.2 Prevention Mechanisms

**Mechanism 1: STONITH (Shoot The Other Node In The Head)**

Before promoting a new primary, forcibly kill the old one. This is the most reliable
split-brain prevention method.

```
  STONITH sequence:

  1. Failover tool detects primary failure
  2. BEFORE promoting replica, issue kill command to old primary:
     - IPMI/BMC power off (hardware-level)
     - Cloud API: aws ec2 stop-instances --instance-ids i-xxx
     - SSH + shutdown: ssh old-primary "sudo systemctl stop mysqld"
  3. Verify old primary is actually dead (power state check)
  4. Only THEN promote the replica
  
  If you cannot confirm the old primary is dead → DO NOT PROMOTE.
  Manual intervention required. This is the safe choice.
```

**Mechanism 2: super_read_only**

```sql
-- Set on ALL replicas at all times:
SET GLOBAL super_read_only = ON;

-- On primary only:
SET GLOBAL super_read_only = OFF;
-- (super_read_only=ON blocks writes even from SUPER-privileged users)

-- On failover:
-- Step 1: SET super_read_only=ON on old primary (if reachable)
-- Step 2: Promote replica: SET super_read_only=OFF on new primary

-- If old primary is unreachable, it might still have super_read_only=OFF.
-- This is why STONITH is still needed as a backup.
```

**Mechanism 3: Lease-Based Fencing**

```
  Lease mechanism:

  Primary must renew a lease (in ZooKeeper, etcd, or a shared DB) every N seconds.
  
  Primary:  acquire_lease(ttl=10s) → write OK
            ...
            renew_lease() → OK
            ...
            renew_lease() → OK
            ...
            [network partition — cannot reach lease store]
            renew_lease() → FAILED
            → Immediately set super_read_only=ON, stop accepting writes
  
  Failover tool:
            lease_expired() == true → safe to promote replica
            (old primary has demoted itself)
  
  This is how MySQL with Consul/ZooKeeper achieves safe fencing.
```

**Mechanism 4: Group Replication's Inherent Protection**

Group Replication prevents split-brain by design. A partition that isolates a minority
of nodes forces that minority into ERROR state — they cannot commit transactions.

```
  5-node Group Replication cluster:

  Network partition:
  
  Partition A: [Node 1, Node 2, Node 3]  ← majority (3/5)
               Continue operating normally.
               Elect new primary if needed.
  
  Partition B: [Node 4, Node 5]          ← minority (2/5)
               Cannot reach consensus (need 3).
               Enter SUPER_READ_ONLY state.
               All writes rejected.
               NO split-brain possible.
```

### 8.3 ProxySQL's Role in Split-Brain Prevention

```
  ProxySQL hostgroup configuration:

  Writer hostgroup (HG 10):  only ONE node at a time
  Reader hostgroup (HG 20):  all replicas
  
  ProxySQL checks:
  - mysql_server_connect:   can I connect?
  - mysql_server_ping:      is it alive?
  - read_only check:        is read_only=OFF? (writer must have read_only=OFF)
  
  If old primary comes back with read_only=OFF (stale state):
    ProxySQL sees TWO nodes with read_only=OFF → CONFLICT
    Resolution: ProxySQL uses the "writer_is_also_reader" flag and
    hostgroup priority to ensure only one writer hostgroup member.
  
  Additional safety:
    mysql_query_rules can enforce that writes only go to HG 10.
    Even if the old primary is reachable, if it's not in HG 10,
    no writes reach it through ProxySQL.
```

>>> Split-brain prevention is a high-value interview topic. The answer pattern:
"We use a layered approach — STONITH to kill the old primary, super_read_only as a
software guard, and ProxySQL as a routing guard. No single mechanism is sufficient
alone. Group Replication eliminates the problem entirely through Paxos majority, but
for async/semi-sync deployments, you need external fencing."

---

## 9. Backup Strategies — Your Last Line of Defense

Replication protects against node failure. Backups protect against everything else:
data corruption, application bugs, operator error, ransomware, and the one failure
mode nobody anticipated.

### 9.1 Logical Backup — mysqldump

The oldest and most portable MySQL backup tool. Produces SQL statements that recreate
the schema and data.

```bash
# Full logical backup with consistent snapshot
mysqldump \
  --single-transaction \       # InnoDB MVCC snapshot (no table locks)
  --routines \                 # Include stored procedures and functions
  --triggers \                 # Include triggers
  --events \                   # Include events
  --set-gtid-purged=ON \       # Include GTID state for replica setup
  --master-data=2 \            # Comment with binlog position (for PITR)
  --all-databases \
  > full_backup_$(date +%Y%m%d_%H%M%S).sql
```

How `--single-transaction` works:
```
  mysqldump starts a transaction with REPEATABLE READ.
  This acquires an MVCC snapshot at the start.
  All subsequent reads see the database as of that snapshot.
  No table locks required for InnoDB tables (MyISAM still locks).
  
  This means:
  - The backup is consistent (point-in-time snapshot)
  - The server continues accepting writes during backup
  - Backup may take hours for large databases — all reads see the old snapshot
  - Long-running MVCC snapshot prevents purge of old undo versions → 
    potential undo log bloat (Chapter 9)
```

Limitations:
- **Slow for large databases**: a 1 TB database may take 4-8 hours to dump and
  12-24 hours to restore (every row is an INSERT statement, indexes rebuilt from scratch).
- **Single-threaded**: mysqldump processes one table at a time.
- **Restore is slow**: must replay all INSERT statements and rebuild all indexes.

### 9.2 Logical Backup — mysqlpump (MySQL 8.0) and mydumper

**mysqlpump** adds parallelism to logical backup:

```bash
# Parallel dump — 4 threads for tables, 2 for databases
mysqlpump --default-parallelism=4 --all-databases > backup.sql
```

Note: mysqlpump has known issues with view dependencies and is deprecated in MySQL
8.0.34 in favor of mysqldump or MySQL Shell's `util.dumpInstance()`.

**mydumper/myloader** (community tool by Max Vallejo, maintained by Percona):

```bash
# Multi-threaded backup — 8 threads, consistent snapshot
mydumper \
  --threads 8 \
  --trx-consistency-only \    # FTWRL only briefly, then per-table consistent dump
  --compress \
  --outputdir /backup/mydumper_$(date +%Y%m%d)

# Multi-threaded restore — 8 threads
myloader \
  --threads 8 \
  --directory /backup/mydumper_20240615 \
  --overwrite-tables
```

mydumper is significantly faster than mysqldump for multi-table databases because it
dumps tables in parallel. Each table gets its own file, enabling parallel restore.

### 9.3 MySQL Shell Dump/Load Utilities

```javascript
// MySQL Shell — parallel, compressed dump
util.dumpInstance('/backup/full', {
  threads: 8,
  compression: 'zstd',
  consistent: true       // FTWRL + MVCC snapshot
});

// Parallel restore
util.loadDump('/backup/full', {
  threads: 8,
  resetProgress: true
});
```

MySQL Shell's utilities are the modern replacement for mysqldump, with parallelism,
compression, progress tracking, and cloud storage support (Oracle Cloud, S3).

### 9.4 Physical Backup — Percona XtraBackup

XtraBackup is the industry standard for physical backups of InnoDB. It copies the
raw data files (`.ibd`, `ibdata1`, redo logs) while the server is running.

```
  How XtraBackup works — internal mechanics:

  Phase 1: BACKUP
  ┌─────────────────────────────────────────────────────────────┐
  │                                                             │
  │  1. Start copying .ibd files (data pages)                   │
  │     While copying, new writes continue on the server.       │
  │     The .ibd copies are "fuzzy" — pages may be inconsistent │
  │                                                             │
  │  2. Simultaneously, tail the InnoDB redo log                │
  │     Capture all redo entries generated during the copy       │
  │     This ensures we can fix the fuzzy pages later           │
  │                                                             │
  │  3. Briefly acquire FTWRL (Flush Tables With Read Lock)     │
  │     or use backup lock (Percona Server)                     │
  │     Purpose: get a consistent binlog position               │
  │     Duration: milliseconds to seconds                       │
  │                                                             │
  │  4. Record binlog position and GTID state                   │
  │     Release lock                                            │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘

  Phase 2: PREPARE
  ┌─────────────────────────────────────────────────────────────┐
  │                                                             │
  │  1. Replay captured redo log entries against fuzzy pages    │
  │     This is crash recovery — same as InnoDB startup after   │
  │     a crash (Chapter 8)                                     │
  │                                                             │
  │  2. Roll back uncommitted transactions using undo log       │
  │                                                             │
  │  3. Result: a consistent, crash-recovered data directory    │
  │     Ready to be started by mysqld                           │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘

  Phase 3: RESTORE
  ┌─────────────────────────────────────────────────────────────┐
  │                                                             │
  │  1. Stop mysqld on target server                            │
  │  2. Copy prepared backup files to MySQL data directory      │
  │  3. Fix file ownership (chown mysql:mysql)                  │
  │  4. Start mysqld — server comes up with consistent data     │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
```

Commands:

```bash
# Phase 1: Full backup
xtrabackup --backup \
  --target-dir=/backup/full \
  --user=backup_user \
  --password=xxx

# Phase 2: Prepare (apply redo log)
xtrabackup --prepare \
  --target-dir=/backup/full

# Phase 3: Restore
systemctl stop mysqld
rm -rf /var/lib/mysql/*
xtrabackup --copy-back \
  --target-dir=/backup/full
chown -R mysql:mysql /var/lib/mysql
systemctl start mysqld
```

### 9.5 Incremental Backups with XtraBackup

XtraBackup supports incremental backups based on the InnoDB Log Sequence Number (LSN).
Each incremental backup contains only the pages modified since the last backup.

```bash
# Day 1: Full backup
xtrabackup --backup --target-dir=/backup/full

# Day 2: Incremental (only pages changed since full backup)
xtrabackup --backup \
  --target-dir=/backup/inc1 \
  --incremental-basedir=/backup/full

# Day 3: Incremental (only pages changed since inc1)
xtrabackup --backup \
  --target-dir=/backup/inc2 \
  --incremental-basedir=/backup/inc1

# Prepare for restore: apply incrementals to full backup
xtrabackup --prepare --apply-log-only --target-dir=/backup/full
xtrabackup --prepare --apply-log-only \
  --target-dir=/backup/full \
  --incremental-dir=/backup/inc1
xtrabackup --prepare \
  --target-dir=/backup/full \
  --incremental-dir=/backup/inc2
# Note: --apply-log-only on all but the last prepare step
# (last step rolls back uncommitted transactions)
```

```
  Incremental backup — what is actually stored:

  Full backup (Day 1):
    All .ibd pages, all system tablespace pages
    LSN at start: 1000000
    LSN at end:   1050000
  
  Incremental backup (Day 2):
    Only pages with LSN > 1050000 (modified since Day 1)
    If a 100 GB database had 2 GB of modified pages → inc1 = ~2 GB
    Dramatically smaller and faster than a full backup
  
  Restore requires: full + inc1 + inc2 applied in order
  Trade-off: restore is slower (multiple apply steps), but backups are fast
```

### 9.6 Backup Strategy Comparison

| Tool              | Type     | Speed (backup) | Speed (restore) | Consistency    | Parallelism |
|-------------------|----------|----------------|-----------------|----------------|-------------|
| mysqldump         | Logical  | Slow           | Very slow        | MVCC snapshot  | Single-threaded |
| mydumper          | Logical  | Medium         | Medium           | FTWRL/per-table| Multi-threaded  |
| MySQL Shell dump  | Logical  | Medium         | Medium           | FTWRL + MVCC   | Multi-threaded  |
| XtraBackup (full) | Physical | Fast           | Fast             | Redo + FTWRL   | Single (I/O bound) |
| XtraBackup (incr) | Physical | Very fast      | Medium (apply)   | Redo + FTWRL   | Single (I/O bound) |
| MySQL Enterprise  | Physical | Fast           | Fast             | Same as Xtra   | Multi-threaded  |

For a 1 TB InnoDB database on modern NVMe storage:

| Operation            | mysqldump     | mydumper (8t)  | XtraBackup     |
|----------------------|---------------|----------------|----------------|
| Backup time          | 4-8 hours     | 1-2 hours      | 15-30 minutes  |
| Backup size          | ~200 GB (SQL) | ~200 GB        | ~1 TB (raw)    |
| Backup (compressed)  | ~50 GB        | ~50 GB         | ~300 GB        |
| Restore time         | 12-24 hours   | 3-6 hours      | 20-40 minutes  |

>>> In interviews, always recommend XtraBackup for production MySQL deployments above
100 GB. The key reason: restore time. Logical backups restore by replaying INSERT
statements and rebuilding indexes — this is CPU-bound and takes hours. Physical backups
restore by copying files — this is I/O-bound and takes minutes. When your production
database is down, the difference between a 30-minute restore and a 12-hour restore is
the difference between an incident and a disaster.

---

## 10. Point-in-Time Recovery (PITR) — The Last Line of Defense

### 10.1 The Scenario That Only PITR Can Solve

```
  Timeline:

  02:00    Full backup completes (XtraBackup, nightly)
  08:00    Application processes orders normally
  14:30    Developer deploys code with bug:
           UPDATE accounts SET balance = 0 WHERE status = 'active';
           (missing WHERE clause on account_id — wipes all balances)
  14:35    Bug discovered. All account balances are zero.
  
  Replication does not help — the bug replicated to all replicas.
  The last full backup is from 02:00 — 12 hours of orders would be lost.
  
  PITR solution: restore the 02:00 backup, then replay binlogs up to 14:29:59.
  Data loss: zero (assuming binlogs are available from 02:00 onward).
```

### 10.2 PITR Process

```
  Step 1: Identify the disaster timestamp
          Review binlogs to find the exact GTID or timestamp of the bad statement
  
  Step 2: Restore full backup to a recovery instance
          xtrabackup --prepare --target-dir=/backup/full
          xtrabackup --copy-back --target-dir=/backup/full
  
  Step 3: Replay binlogs from backup point to just before the disaster
```

```bash
# Find the bad statement in binlogs
mysqlbinlog --start-datetime='2024-06-15 14:25:00' \
            --stop-datetime='2024-06-15 14:35:00' \
            --verbose \
            binlog.000042 binlog.000043 | grep -A5 "UPDATE accounts"

# Replay binlogs up to just before the bad statement
# Method 1: by timestamp
mysqlbinlog --stop-datetime='2024-06-15 14:29:59' \
            binlog.000038 binlog.000039 binlog.000040 \
            binlog.000041 binlog.000042 | mysql -u root

# Method 2: by GTID (more precise)
# Exclude the specific bad transaction GTID
mysqlbinlog --exclude-gtids='server-uuid:50001' \
            binlog.000038 binlog.000039 binlog.000040 \
            binlog.000041 binlog.000042 | mysql -u root

# Method 3: by binlog position (most precise)
mysqlbinlog --stop-position=98765000 \
            binlog.000042 | mysql -u root
```

### 10.3 PITR Requirements

For PITR to work, you need:

1. **Binary logging enabled**: `log_bin = ON` (default in MySQL 8.0)
2. **Sufficient binlog retention**: binlogs must cover the window from the last full
   backup to the point of recovery
   ```sql
   -- MySQL 8.0: retain binlogs for 7 days
   SET GLOBAL binlog_expire_logs_seconds = 604800;
   
   -- MySQL 5.7: 
   SET GLOBAL expire_logs_days = 7;
   ```
3. **Binlog format**: ROW format is preferred for PITR because it records the actual
   data changes (before/after images), making it possible to identify and skip specific
   problematic changes. STATEMENT format records the SQL — you cannot partially
   skip a statement's effects.
4. **Backup includes binlog position**: `--master-data=2` in mysqldump or
   `xtrabackup_binlog_info` from XtraBackup.

### 10.4 Flashback — Reverse PITR

MySQL 8.0 with ROW-based binlog format supports a powerful technique: flashback.
Because ROW format records both the before-image and after-image of each row
modification, you can reverse the operation by swapping them.

```
  ROW binlog event for: UPDATE accounts SET balance=0 WHERE id=42;
  
  Before-image:  {id=42, balance=5000, status='active'}
  After-image:   {id=42, balance=0,    status='active'}
  
  Flashback generates the reverse:
  UPDATE accounts SET balance=5000 WHERE id=42;
  
  This is faster than full PITR — you only undo the specific bad transaction
  without restoring the entire database.
```

```bash
# mysqlbinlog with --flashback flag (MariaDB, or Percona-patched)
mysqlbinlog --flashback binlog.000042 \
  --start-position=98765000 \
  --stop-position=98766000 | mysql

# This reverses all operations in the given range:
# INSERT → DELETE, UPDATE → reverse UPDATE, DELETE → INSERT
```

>>> PITR is the last line of defense against application bugs. Without binlogs, you
can only restore to the last full backup — potentially losing hours or days of data.
In interviews, always mention: "We configure binlog_expire_logs_seconds to cover at
least twice the backup interval. If we take daily backups, we retain 48 hours of
binlogs. This guarantees PITR coverage even if the latest backup is corrupted."

---

## 11. Disaster Recovery Patterns

### 11.1 Hot Standby

```
  Architecture:

  ┌─────────────────────────┐        ┌─────────────────────────┐
  │  Region: us-east-1      │        │  Region: eu-west-1      │
  │  (PRIMARY)              │        │  (DR STANDBY)           │
  │                         │  async │                         │
  │  ┌───────────────┐      │  repl  │  ┌───────────────┐      │
  │  │ MySQL Primary │──────┼────────┼──│ MySQL Replica │      │
  │  │ (R/W)         │      │        │  │ (R/O)         │      │
  │  └───────────────┘      │        │  └───────────────┘      │
  │                         │        │                         │
  │  RPO: 0 (within region) │        │  RPO: seconds (cross-   │
  │  RTO: seconds           │        │       region lag)       │
  │                         │        │  RTO: minutes (manual   │
  │                         │        │       promotion)        │
  └─────────────────────────┘        └─────────────────────────┘

  Characteristics:
  - Replica is continuously updated (async replication)
  - Can serve read traffic (reduces cross-region read latency)
  - Failover: promote DR replica to primary, redirect traffic
  - Data loss: replication lag (typically 100ms-5s)
  - Cost: full MySQL instance running in DR region
```

### 11.2 Warm Standby

```
  Architecture:

  ┌─────────────────────────┐        ┌─────────────────────────┐
  │  Region: us-east-1      │        │  Region: eu-west-1      │
  │  (PRIMARY)              │        │  (DR — WARM STANDBY)    │
  │                         │ backup │                         │
  │  ┌───────────────┐      │ ship   │  ┌───────────────┐      │
  │  │ MySQL Primary │──────┼───(S3)─┼──│ MySQL (off or │      │
  │  │ (R/W)         │      │ every  │  │  standby)     │      │
  │  └───────────────┘      │ 1-6h   │  └───────────────┘      │
  │                         │        │                         │
  │                         │        │  RPO: hours             │
  │                         │        │  RTO: 1-4 hours         │
  │                         │        │  (restore from backup)  │
  └─────────────────────────┘        └─────────────────────────┘

  Characteristics:
  - Periodic backups shipped to DR region (XtraBackup → S3 → DR)
  - DR instance may or may not be running
  - Recovery: restore latest backup + replay available binlogs
  - Lower cost than hot standby (no running replica)
  - Higher RPO and RTO
```

### 11.3 Cold Standby

```
  Architecture:

  ┌─────────────────────────┐        ┌─────────────────────────┐
  │  Region: us-east-1      │        │  Object Storage (S3)    │
  │  (PRIMARY)              │        │  (OFF-SITE BACKUP)      │
  │                         │ daily  │                         │
  │  ┌───────────────┐      │ backup │  ┌───────────────┐      │
  │  │ MySQL Primary │──────┼────────┼──│  Backup files │      │
  │  │ (R/W)         │      │        │  │  (compressed) │      │
  │  └───────────────┘      │        │  └───────────────┘      │
  │                         │        │                         │
  │                         │        │  RPO: hours/days        │
  │                         │        │  RTO: hours/days        │
  │                         │        │  (provision + restore)  │
  └─────────────────────────┘        └─────────────────────────┘

  Characteristics:
  - Backups stored in durable object storage (S3, GCS)
  - No running DR infrastructure
  - Recovery: provision new server → download backup → restore → apply binlogs
  - Lowest cost
  - Highest RPO and RTO
  - Suitable for non-critical data, compliance/archival requirements
```

### 11.4 DR Comparison

| Aspect          | Hot Standby           | Warm Standby          | Cold Standby          |
|-----------------|----------------------|----------------------|----------------------|
| RPO             | Seconds              | Hours                 | Hours/Days            |
| RTO             | Minutes              | 1-4 hours             | 4-24 hours            |
| Cost            | High (running infra) | Medium (periodic)     | Low (storage only)    |
| Complexity      | High                 | Medium                | Low                   |
| Read offload    | Yes                  | No                    | No                    |
| Data currency   | Near-real-time       | Hours behind          | Hours/days behind     |
| Best for        | Mission-critical     | Important, non-critical | Archive, compliance |

### 11.5 DR Testing — Untested DR Is Not DR

```
  DR Test Checklist:

  1. Quarterly DR failover test
     - Promote DR replica to primary
     - Verify application can connect and operate
     - Verify data integrity (checksums, row counts)
     - Measure actual RTO (not theoretical)
     - Fail back to original primary
  
  2. Monthly backup restore test
     - Restore latest backup to test instance
     - Verify the database starts and serves queries
     - Verify PITR works: replay binlogs to a specific timestamp
     - Document restore time
  
  3. Continuous backup monitoring
     - Alert if backup job fails
     - Alert if backup size deviates > 20% from expected
     - Alert if binlog gap detected (missing sequence numbers)
     - Monitor replication lag to DR replica
  
  Rule: if you have not restored a backup in the last 90 days,
  you do not have backups. You have files.
```

>>> In system design interviews, always mention DR testing. A common follow-up to
"how would you handle a regional outage" is "how do you know your DR plan works?"
The answer: "We run quarterly DR drills where we promote the DR region and serve
production traffic from it for 30 minutes. We measure actual RTO and verify data
integrity. We also restore a backup to a test instance monthly and validate PITR
by replaying binlogs to a random timestamp and checking query results."

---

## 12. HA Decision Matrix — Choosing the Right Architecture

### 12.1 Decision by Requirements

| Requirement                     | Recommended Solution                              |
|---------------------------------|---------------------------------------------------|
| RPO=0, single region            | InnoDB Cluster (Group Replication)                 |
| RPO=0, multi-region             | InnoDB ClusterSet (GR within + async across)       |
| RPO~0, operational simplicity   | Semi-sync replication + Orchestrator               |
| Cost-sensitive, RPO=minutes     | Async replication + MHA/Orchestrator               |
| Read scale + HA                 | ProxySQL + read replicas + Orchestrator             |
| Fully managed                   | Aurora MySQL, Cloud SQL HA, PlanetScale             |
| Existing large deployment       | Orchestrator (works with any replication topology)  |
| Green-field MySQL 8.0           | InnoDB Cluster (simplest integrated solution)       |

### 12.2 Decision by Scale

```
  Decision tree:

  How critical is the data?
      │
      ├── "We cannot lose a single transaction" (payments, financial)
      │       │
      │       ├── Single region?
      │       │     → InnoDB Cluster (3+ nodes, Group Replication)
      │       │       RPO=0, RTO=5-10s, consensus-based
      │       │
      │       └── Multi-region required?
      │             → InnoDB ClusterSet
      │               GR within region (RPO=0 for node failures)
      │               Async across regions (RPO=seconds for regional failures)
      │
      ├── "A few seconds of data loss is acceptable" (e-commerce, SaaS)
      │       │
      │       ├── Need operational simplicity?
      │       │     → Semi-sync + Orchestrator
      │       │       RPO~0, RTO=10-30s, battle-tested
      │       │
      │       └── Budget constrained?
      │             → Async + Orchestrator
      │               RPO=seconds, RTO=10-30s, minimal overhead
      │
      └── "Hours of data loss are acceptable" (analytics, staging)
              │
              → Async replication + daily backups
                RPO=hours, RTO=hours, minimal cost
```

### 12.3 Full Architecture: Production-Grade MySQL HA

Putting it all together for a mission-critical deployment:

```
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                          Application Tier                               │
  │                                                                         │
  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐           │
  │  │ App Pod 1 │  │ App Pod 2 │  │ App Pod 3 │  │ App Pod N │           │
  │  │ HikariCP  │  │ HikariCP  │  │ HikariCP  │  │ HikariCP  │           │
  │  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘           │
  │        └───────────────┼───────────────┼───────────────┘               │
  │                        │               │                                │
  └────────────────────────┼───────────────┼────────────────────────────────┘
                           │               │
  ┌────────────────────────v───────────────v────────────────────────────────┐
  │                     ProxySQL Cluster (2+ nodes)                         │
  │                                                                         │
  │  Port 6033 (writes) → Writer Hostgroup (HG 10)                         │
  │  Port 6034 (reads)  → Reader Hostgroup (HG 20)                         │
  │                                                                         │
  │  Health checks: mysql_server_connect, read_only check                  │
  │  Integration: Orchestrator hooks update hostgroup membership            │
  └───────────┬───────────────────────────┬────────────────────────────────┘
              │                           │
  ┌───────────v───────────┐   ┌───────────v───────────┐
  │  MySQL Primary        │   │  MySQL Replicas (N)   │
  │  semi-sync (AFTER_SYNC│   │  async from primary   │
  │  + 1 semi-sync replica│   │  read-only traffic    │
  │  read_only = OFF      │   │  super_read_only = ON │
  └───────────┬───────────┘   └───────────────────────┘
              │
              │ semi-sync ack
  ┌───────────v───────────┐
  │  Semi-sync Replica    │
  │  (failover candidate) │
  │  super_read_only = ON │
  └───────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Orchestrator (3-node RAFT cluster)                                     │
  │                                                                         │
  │  - Monitors all MySQL nodes                                             │
  │  - Detects primary failure                                              │
  │  - Promotes semi-sync replica to primary                                │
  │  - Hooks update ProxySQL hostgroups + DNS                               │
  │  - Anti-flapping prevents cascading failovers                           │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Backup + DR                                                            │
  │                                                                         │
  │  - XtraBackup: nightly full, hourly incremental                        │
  │  - Binlogs shipped to S3 every 5 minutes                               │
  │  - DR replica in eu-west-1 (async, hot standby)                        │
  │  - Monthly backup restore test                                         │
  │  - Quarterly DR failover drill                                         │
  └─────────────────────────────────────────────────────────────────────────┘
```

### 12.4 Configuration Summary for Production HA

```sql
-- Primary server
SET GLOBAL super_read_only = OFF;
SET GLOBAL rpl_semi_sync_master_enabled = ON;
SET GLOBAL rpl_semi_sync_master_wait_for_slave_count = 1;
SET GLOBAL rpl_semi_sync_master_timeout = 10000;    -- 10s fallback to async
SET GLOBAL rpl_semi_sync_master_wait_point = 'AFTER_SYNC';  -- default in 5.7.2+
SET GLOBAL binlog_expire_logs_seconds = 604800;      -- 7 days retention
SET GLOBAL sync_binlog = 1;                          -- fsync every commit
SET GLOBAL innodb_flush_log_at_trx_commit = 1;       -- full durability

-- Semi-sync replica (failover candidate)
SET GLOBAL super_read_only = ON;
SET GLOBAL rpl_semi_sync_slave_enabled = ON;
SET GLOBAL relay_log_recovery = ON;                  -- auto-recover relay log on crash
SET GLOBAL relay_log_info_repository = 'TABLE';      -- crash-safe replication metadata

-- Async replicas (read scale)
SET GLOBAL super_read_only = ON;
SET GLOBAL slave_parallel_workers = 16;              -- parallel applier
SET GLOBAL slave_parallel_type = 'LOGICAL_CLOCK';    -- dependency-based parallelism
SET GLOBAL slave_preserve_commit_order = ON;          -- maintain commit order
```

### 12.5 Failover Runbook

```
  AUTOMATED FAILOVER (Orchestrator handles this):

  1. Orchestrator detects primary unreachable (3 consecutive failed probes, ~9s)
  2. Cross-check with other Orchestrator nodes (RAFT consensus)
  3. Confirm failure is real (not just Orchestrator network issue)
  4. Select best replica:
     a. Prefer semi-sync replica (guaranteed to have latest data)
     b. Highest GTID executed
     c. Not in promotion blacklist
     d. Same datacenter as old primary (minimize network changes)
  5. Promote selected replica:
     a. Wait for relay log to drain
     b. SET GLOBAL read_only = OFF
     c. SET GLOBAL super_read_only = OFF
  6. Repoint other replicas to new primary (GTID auto-positioning)
  7. Execute hooks:
     a. Update ProxySQL writer hostgroup
     b. Update DNS (if VIP-based)
     c. Alert on-call engineer (PagerDuty)
  8. Enter anti-flap cooldown (default: 1 hour)

  MANUAL FAILOVER STEPS (if Orchestrator is unavailable):

  1. Verify primary is truly dead:
     mysql -h primary -e "SELECT 1"    -- must fail
     ssh primary "pgrep mysqld"         -- must return empty
  
  2. Identify most up-to-date replica:
     On each replica:
     mysql -e "SELECT @@gtid_executed"
     → Select replica with highest GTID set
  
  3. Fence the old primary:
     ssh primary "sudo systemctl stop mysqld" || \
     aws ec2 stop-instances --instance-ids i-xxx
  
  4. Promote the chosen replica:
     mysql -h new_primary -e "
       STOP SLAVE;
       RESET SLAVE ALL;
       SET GLOBAL read_only = OFF;
       SET GLOBAL super_read_only = OFF;
     "
  
  5. Repoint other replicas:
     mysql -h other_replica -e "
       STOP SLAVE;
       CHANGE MASTER TO MASTER_HOST='new_primary', 
         MASTER_AUTO_POSITION=1;
       START SLAVE;
     "
  
  6. Update ProxySQL:
     mysql -h proxysql_admin -P 6032 -e "
       UPDATE mysql_servers SET hostgroup_id=10 
         WHERE hostname='new_primary';
       UPDATE mysql_servers SET hostgroup_id=20 
         WHERE hostname='old_primary';
       LOAD MYSQL SERVERS TO RUNTIME;
       SAVE MYSQL SERVERS TO DISK;
     "
  
  7. Verify:
     mysql -h new_primary -e "SHOW MASTER STATUS"
     On each replica: "SHOW SLAVE STATUS\G" → Seconds_Behind_Master = 0
```

---

## 13. Common Failure Modes and Responses

### 13.1 Failure Mode Matrix

| Failure                      | Detection                    | Response                       | RPO Impact      | RTO Impact       |
|------------------------------|------------------------------|-------------------------------|-----------------|------------------|
| MySQL process crash          | Connection failure           | Restart mysqld (crash recovery) | 0 (redo log)   | 10-60s (recovery)|
| Server hardware failure      | Connection + SSH failure     | Promote replica               | Depends on repl | 10-60s (auto)    |
| Storage failure (disk)       | I/O errors in error log      | Promote replica               | Depends on repl | 10-60s (auto)    |
| Network partition            | Partial connectivity         | Careful — risk of split-brain | Depends         | Complex          |
| Data corruption (silent)     | Checksum mismatch            | Restore from backup + PITR   | Depends on backup| Hours            |
| Application bug (bad DML)    | Application monitoring       | PITR to before bad statement  | 0 (with PITR)  | Hours            |
| Regional outage              | All nodes unreachable        | Promote DR region             | Cross-region lag| Minutes-hours    |
| Operator error (DROP TABLE)  | Immediate (hopefully)        | PITR or flashback             | 0 (with PITR)  | Hours            |
| Replication lag (excessive)  | Seconds_Behind_Master        | Throttle writes, parallel repl| N/A (degraded) | N/A              |

### 13.2 The One Failure Replication Cannot Solve

Replication faithfully copies every operation from primary to replica — including
destructive ones. `DROP TABLE orders` on the primary immediately executes on all
replicas. `UPDATE accounts SET balance=0` (missing WHERE clause) propagates everywhere.

This is why backups and PITR are not optional, even with perfect replication HA.
They protect against a fundamentally different class of failure: logical corruption
caused by application bugs, bad migrations, and human error.

```
  Protection layers:

  Layer 1: Replication HA (Orchestrator / GR)
           Protects against: node failure, hardware failure, network failure
           Does NOT protect against: bad SQL, data corruption, bugs
  
  Layer 2: Backups (XtraBackup, nightly + incremental)
           Protects against: complete data loss, regional disaster
           RPO = time since last backup (hours)
  
  Layer 3: PITR (binlog replay)
           Protects against: application bugs, bad DML, operator error
           RPO = 0 (down to the specific GTID/timestamp)
  
  Layer 4: Delayed replica
           SET GLOBAL MASTER_DELAY = 3600;  -- 1 hour behind primary
           Protects against: bad DML with detection within 1 hour
           Can stop replication, recover data, without full PITR
  
  All four layers are needed for a production-grade deployment.
```

>>> The delayed replica is an underappreciated tool. Run one replica with
`MASTER_DELAY=3600` (1 hour behind). When someone runs a bad query, you have a 1-hour
window to stop the delayed replica before the bad query reaches it, extract the correct
data, and apply it to the primary. This is faster than full PITR and requires no backup
restoration.

---

## 14. Interview Patterns — HA and DR Questions

### 14.1 Common Questions and Framework Answers

**Q: "How would you make MySQL highly available for a payment system?"**

Framework answer:
```
  1. State requirements: RPO=0 (cannot lose transactions), RTO<30s
  2. Choose replication: semi-sync with AFTER_SYNC (or Group Replication)
  3. Failover automation: Orchestrator (RAFT cluster, 3 nodes)
  4. Traffic routing: ProxySQL (2 instances, failover via Orchestrator hooks)
  5. Split-brain prevention: STONITH + super_read_only + ProxySQL routing
  6. Backup: XtraBackup nightly full, hourly incremental
  7. PITR: binlog retention 7 days, covers 7x backup interval
  8. DR: async replica in second region, quarterly DR drills
  9. Monitoring: replication lag, backup success, Orchestrator health
```

**Q: "Your primary MySQL server just died. Walk me through what happens."**

```
  T+0s:    Primary stops responding. Active connections get errors.
  T+0-3s:  Orchestrator probes fail. Counter increments.
  T+9s:    3 consecutive failures. Orchestrator declares DeadMaster.
  T+9-10s: Orchestrator selects best replica (highest GTID, semi-sync preferred).
  T+10-12s: Orchestrator promotes: drain relay log, set read_only=OFF.
  T+12-13s: Hooks fire: ProxySQL writer hostgroup updated. DNS updated.
  T+13-15s: Application connection pools detect stale connections, reconnect.
  T+15-20s: New connections flow to new primary. Service restored.
  
  Total RTO: ~15-20 seconds (including connection pool recovery).
  RPO: 0 with semi-sync AFTER_SYNC (promoted replica has all committed txns).
```

**Q: "How do you handle a situation where someone accidentally dropped a table?"**

```
  Immediate actions:
  1. Stop the delayed replica (if you have one): STOP SLAVE;
  2. The delayed replica still has the table — extract the data.
  
  If no delayed replica:
  1. Identify the DROP TABLE timestamp (error log, binlog, audit log)
  2. Provision a recovery instance
  3. Restore latest XtraBackup to recovery instance
  4. Replay binlogs up to just before the DROP TABLE
  5. Extract the table data from recovery instance
  6. Import into production
  
  Prevention:
  - sql_safe_updates = ON (prevents UPDATE/DELETE without WHERE)
  - Restrict DROP privilege to DBA accounts only
  - Delayed replica with MASTER_DELAY=3600
```

### 14.2 Red Flags in HA Design Discussions

Things that signal a weak HA design in an interview:

| Red Flag                                      | Why It's Wrong                              |
|-----------------------------------------------|---------------------------------------------|
| "We use async replication, RPO=0"             | Async replication cannot guarantee RPO=0    |
| "We have two GR nodes for HA"                 | Paxos needs majority; 2 nodes = no fault tolerance |
| "We'll just promote any replica"              | Must choose most up-to-date to minimize data loss |
| "DNS failover with 5-minute TTL"              | 5 minutes of downtime on every failover      |
| "We have backups but never tested restore"    | Untested backups are not backups             |
| "Replication handles everything"              | Replication replicates bugs and bad DML too  |
| "We'll handle split-brain manually"           | Manual intervention is too slow; dual writes happen in seconds |

---

## 15. Summary — HA and DR at a Glance

```
  The HA/DR Pyramid:

                    ┌─────────┐
                    │ RPO=0   │  Group Replication / InnoDB Cluster
                    │ RTO<10s │  Paxos consensus, automatic election
                    ├─────────┤
                    │ RPO~0   │  Semi-sync + Orchestrator
                    │ RTO<30s │  AFTER_SYNC, automated promotion
                    ├─────────┤
                    │ RPO=min │  Async + Orchestrator/MHA
                    │ RTO<60s │  Standard replication, scripted failover
                    ├─────────┤
                    │ RPO=hrs │  Backups + PITR
                    │ RTO=hrs │  XtraBackup + binlog replay
                    ├─────────┤
                    │ RPO=day │  Cold backup to object storage
                    │ RTO=day │  Restore from S3/GCS
                    └─────────┘
  
  Every layer above depends on the layers below.
  Even with RPO=0 replication, you still need backups for logical corruption.
  Even with automated failover, you still need DR drills.
  Even with multi-region, you still need PITR for application bugs.
```

Key takeaways:
1. **RPO and RTO define the architecture.** State them first, then choose tools.
2. **Group Replication (InnoDB Cluster) is the only way to achieve RPO=0** within MySQL
   without external consensus systems.
3. **Semi-sync AFTER_SYNC + Orchestrator** is the pragmatic choice for near-zero RPO
   without the overhead of consensus.
4. **Split-brain prevention requires multiple layers**: STONITH, super_read_only,
   and proxy routing. No single mechanism is sufficient.
5. **Backups protect against what replication cannot**: application bugs, data corruption,
   and operator error. XtraBackup for speed, PITR for precision.
6. **Untested DR is not DR.** Schedule quarterly failover drills and monthly backup
   restore tests.
7. **The delayed replica** is the cheapest insurance against bad DML — it gives you a
   time-windowed copy of the data before the damage.

---
