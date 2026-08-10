# Distributed Systems Fundamentals — Deep Technical Reference

> Target: Senior Java/Systems developer, 15yr exp, 40 LPA interview preparation.
> Depth: Production-grade reasoning, not textbook summaries.

---

## Table of Contents

1. Fallacies of Distributed Computing
2. CAP Theorem
3. PACELC Theorem
4. Consistency Models Spectrum
5. Consensus Algorithms: Paxos & Raft
6. Distributed Transactions
7. Vector Clocks & Lamport Timestamps
8. Gossip Protocols
9. Consistent Hashing
10. Failure Detection
11. Split-Brain & Fencing Tokens

---

## 1. Fallacies of Distributed Computing (Peter Deutsch, 1994)

Peter Deutsch at Sun Microsystems enumerated 8 assumptions developers mistakenly make about distributed networks. Every single one has caused production outages.

### Fallacy 1: The Network Is Reliable

**What developers assume:** If I send a message, it arrives. TCP guarantees delivery.

**Reality:** TCP guarantees delivery *if the connection stays up*. Networks drop packets. Switches fail. NICs go bad. AWS had a 2011 outage where EC2 instances lost connectivity due to a network reconfiguration triggering a re-mirroring storm. Services that assumed reliable delivery got stuck waiting for responses that never came.

**Production failure pattern:**
```
Service A ──── HTTP POST ───→ Service B
                               (B processes and commits)
              ← TCP RST ─────  (network blips before response)
Service A thinks request failed, retries
Service B processes AGAIN → duplicate order created
```

**Fix:** Idempotency keys on every mutating call. Design for at-least-once delivery.

---

### Fallacy 2: Latency Is Zero

**What developers assume:** Calling a service is like calling a local method.

**Reality:** A local method call takes nanoseconds. A cross-DC RPC is 1–100ms. Chatty APIs that work fine locally become catastrophically slow in production.

**Production failure pattern:**
A Java monolith decomposed into microservices. The checkout flow that called 3 methods locally now makes 12 synchronous HTTP calls. P99 latency goes from 50ms to 1.2s. Under load, connection pools exhaust. The system falls over.

**N+1 query problem in distributed form:**
```java
// Loading 100 orders, then fetching customer for each
for (Order order : orders) {
    Customer c = customerService.get(order.customerId()); // 100 RPC calls!
}
// Fix: batch API, or data denormalization
```

**Fix:** Batch APIs, async fan-out, circuit breakers, timeout budgets.

---

### Fallacy 3: Bandwidth Is Infinite

**What developers assume:** I can send whatever payload I want.

**Reality:** Serializing large objects and shipping them over the wire is expensive. JSON is verbose. In high-throughput systems, serialization CPU and network bandwidth become bottlenecks.

**Production failure pattern:**
A Kafka consumer fetching 10MB messages. Garbage collection spikes because large byte arrays are allocated for each message. The application goes into GC pause loops. Consumer lag builds. The partition falls behind.

**Numbers to internalize:**
- Gigabit Ethernet: ~125 MB/s theoretical, ~100 MB/s practical
- Cross-AZ bandwidth: typically throttled at 10 Gbps per instance type
- Serializing 1M objects with Jackson vs Protobuf: 3–5x size difference

**Fix:** Use binary protocols (Protobuf, Avro), compress payloads, paginate, avoid chatty designs.

---

### Fallacy 4: The Network Is Secure

**What developers assume:** Internal network traffic is safe; only external traffic needs encryption.

**Reality:** The 2013 Target breach started with an HVAC vendor's credentials. The attacker moved laterally across the internal network because internal traffic was unencrypted and unverified.

**Production failure pattern:**
Service-to-service calls over HTTP inside a VPC. An attacker who compromises one pod can sniff all internal traffic (ARP spoofing, DNS poisoning). The "internal" assumption is a dangerous monoculture.

**Fix:** mTLS between services (service mesh: Istio, Linkerd), zero-trust networking, encrypt data in transit even internally.

---

### Fallacy 5: Topology Doesn't Change

**What developers assume:** The set of IPs/hosts I start with stays constant.

**Reality:** In cloud environments, instances start and stop continuously. Kubernetes pod IPs change on restart. Auto-scaling groups add and remove nodes. Service discovery is not a one-time lookup.

**Production failure pattern:**
A Java application that resolves DNS at startup and caches the IP forever. When the backend IP changes (failover, scale-out), the app keeps sending traffic to the old dead IP. It takes a restart to recover — during which the service is down.

**Fix:** DNS TTL-aware caching (Java's `networkaddress.cache.ttl` defaults to forever in security manager contexts). Service discovery (Consul, Kubernetes DNS with short TTL). Never cache service addresses across request boundaries.

---

### Fallacy 6: There Is One Administrator

**What developers assume:** Someone has global visibility and control over all systems.

**Reality:** Large organizations have separate teams managing different layers. A database DBA, a network team, a Kubernetes team. No one person can see the full picture simultaneously.

**Production failure pattern:**
A network team changes firewall rules to block port 5432 for security compliance. The application team doesn't know. All database connections start failing. Incident takes 4 hours to diagnose because the two teams aren't communicating.

**Fix:** Infrastructure as code, change management processes, automated dependency documentation, health dashboards that surface all dependency failures.

---

### Fallacy 7: Transport Cost Is Zero

**What developers assume:** Sending data between systems has no overhead beyond the data itself.

**Reality:** Serialization, connection setup (TCP handshake, TLS handshake), routing through load balancers, cross-AZ data transfer costs (AWS charges for cross-AZ traffic) — all of this adds up.

**Numbers:**
- TLS handshake: 1–2 round trips = 2–4ms additional latency
- AWS cross-AZ data: $0.01/GB (minor per-call, massive at scale)
- Connection pool overhead: each idle connection holds memory on both sides

**Fix:** HTTP/2 and gRPC (multiplexing, connection reuse), connection pooling, data locality (keep hot data close to compute).

---

### Fallacy 8: The Network Is Homogeneous

**What developers assume:** All nodes run the same OS, same hardware, same network stack.

**Reality:** A heterogeneous environment is the norm. Java 11 on one service, Java 17 on another. Linux kernel 5.4 vs 5.15. Different NIC drivers. Subtle byte-order issues. Clock drift.

**Production failure pattern:**
A gRPC client compiled against Protobuf 3.15 sends a message with a new field (field number 10) to a server still on Protobuf 3.12. The server silently ignores the unknown field. Business logic proceeds with missing data, producing wrong results for weeks before anyone notices.

**Fix:** Backward-compatible schema evolution (Avro, Protobuf with reserved field numbers), contract testing (consumer-driven contracts with Pact), version negotiation.

---

## 2. CAP Theorem

### Formal Statement

In any distributed data store, during a network partition, you must choose between:
- **Consistency (C):** Every read receives the most recent write or an error.
- **Availability (A):** Every request receives a non-error response, but it might be stale.
- **Partition Tolerance (P):** The system continues operating despite network partitions.

### Why P Is Not Optional

The common mistake: "We can pick CA." **This is impossible in a distributed system.**

A network partition is not a failure you prevent — it is a failure you *handle*. If you run on two machines, those machines will at some point fail to communicate. When that happens, you have two choices:

1. **Stop accepting writes on the minority side** (CP — sacrifice availability)
2. **Keep accepting writes on both sides knowing they may diverge** (AP — sacrifice consistency)

There is no option 3 where you continue serving consistent data from both sides during a partition. You would need to communicate to achieve consistency, but the partition prevents communication.

**Formal proof intuition (Gilbert & Lynch, 2002):**
```
Node A ──────── [PARTITION] ──────── Node B

Client writes X=1 to Node A.
Client reads X from Node B.
Node B has not received the write (partition).

If B returns X=1: B must have consulted A → partition broken (impossible)
If B returns error: system is unavailable (not A)
If B returns X=0: system is inconsistent (not C)

QED: During partition, you cannot have both A and C.
```

### CP vs AP Systems — Real Databases

| System | Choice | Reasoning |
|--------|--------|-----------|
| ZooKeeper | CP | Quorum writes; minority partition refuses writes |
| etcd | CP | Raft consensus; leader required for writes |
| HBase | CP | HDFS master; no split-brain allowed |
| Cassandra | AP (tunable) | Quorum adjustable; default allows stale reads |
| DynamoDB | AP (default) | Eventual consistency by default; strong consistency opt-in |
| Couchbase | AP | Multi-master; eventual consistency |
| MongoDB | CP (default) | Primary-based writes; secondaries lag |
| Riak | AP | Vector clock reconciliation |

**Critical nuance:** CAP is binary but production systems use *tunable consistency*. Cassandra with `QUORUM` reads/writes behaves as CP. With `ONE`, it's AP. The theorem still applies, but you choose your position dynamically.

### CAP Is Not Enough: Real-World Subtlety

CAP was formalized for atomic reads/writes only. It does not capture:
- Latency tradeoffs (PACELC addresses this)
- Partial failures vs full partitions
- Different consistency levels within the same system
- The cost of achieving consistency (coordinator overhead)

Martin Kleppmann's critique (2015): CAP's definition of consistency (linearizability) is just one point on the consistency spectrum. The theorem is true but too narrow to drive practical decisions.

---

## 3. PACELC Theorem (Daniel Abadi, 2010)

PACELC extends CAP by recognizing that even when the system is running *normally* (no partition), there is a fundamental tradeoff between **latency** and **consistency**.

```
      PARTITION?
      /          \
    YES           NO
   /                \
  A vs C          L vs C
(CAP part)     (PACELC part)
```

**Full statement:** If there is a Partition (P), a system must choose between Availability (A) and Consistency (C); Else (E), when running normally, the system must choose between Latency (L) and Consistency (C).

### Why the Else Clause Matters

To achieve linearizable consistency, a write must be:
1. Accepted by a quorum of replicas
2. Acknowledged only after majority confirms

This involves at least one extra round trip (proposal + acknowledgment) that adds latency — typically 1–50ms per write depending on replica placement.

A system like Cassandra with `ONE` consistency level returns after the first replica acknowledges. Latency: ~1ms. But if that replica fails, you lose the write.

A system with `QUORUM` on a 3-node cluster requires 2 acknowledgments. If replicas are cross-AZ, that's 2ms+ per write, every write.

### PACELC Classification of Real Systems

| System | Partition Choice | Normal Choice | Classification |
|--------|-----------------|---------------|----------------|
| Cassandra | AP | EL (default) | PA/EL |
| DynamoDB | AP | EL | PA/EL |
| Spanner | CP | EC | PC/EC |
| CockroachDB | CP | EC | PC/EC |
| MySQL (single primary) | CP | EC | PC/EC |
| MongoDB (default) | CP | EL | PC/EL |
| Riak | AP | EL | PA/EL |

**Interview insight:** When asked "how does Google Spanner guarantee global consistency?", the answer is PC/EC — they sacrifice availability during partition AND add latency in normal operation (commit wait for TrueTime). That's why Spanner uses GPS clocks and atomic clocks to minimize the commit-wait window.

---

## 4. Consistency Models Spectrum

From strongest to weakest:

```
Linearizability (Strict)
    |
Sequential Consistency
    |
Causal Consistency
    |
FIFO Consistency (Pipelined RAM)
    |
Eventual Consistency (Weakest)
```

### Linearizability (Strongest)

**Definition:** Every operation appears to take effect instantaneously at some point between its invocation and completion. The global ordering is consistent with real-time ordering.

**What it means:** If write W completes before read R starts, R must see W. There is a single global timeline.

**Implementation cost:** Requires synchronization on every read (not just write). Even reads must consult a quorum or a single authoritative source.

```
Timeline:
  Write X=1  [-----]
                      Read X  [---]   → must return 1

  Write X=1  [----]
             Read X [-----]            → may return 0 or 1 (concurrent)
                    Read X       [-]  → must return 1
```

**Databases:** Spanner (TrueTime), etcd (Raft), ZooKeeper (Zab).

**Java analogy:** Like `volatile` reads in Java — every read sees the latest globally committed value. More precisely, like using `synchronized` on every read and write.

---

### Sequential Consistency

**Definition:** The result of any execution is the same as if operations were executed in *some* sequential order, and operations of each process appear in program order.

**What it means:** There's a global sequential order that all nodes agree on, but it doesn't have to match real-time ordering. A read can return an older value even if a newer value was written "before" in wall-clock time, as long as all nodes see the same sequence.

**Difference from linearizability:** Linearizability adds the real-time constraint. Sequential consistency only requires intra-process ordering.

```
Process P1: W(x)=1, W(x)=2
Process P2: R(x) → 1, R(x) → 1  ← Sequential but NOT linearizable
                                    (P2 reads stale 1 even after W(x)=2 completed)
```

**Practical use:** Multiprocessor memory models (x86 TSO is close to sequential consistency but weaker).

---

### Causal Consistency

**Definition:** Writes that are causally related must be seen in the same order by all processes. Concurrent writes may be seen in different orders.

**Causally related:** A causes B if A happened-before B (A→B). Happens-before: same process ordering, or B reads a value written by A.

**What this enables:**
```
P1: W(x)=1
P2: R(x)→1, W(y)=2   ← P2 saw x=1, so W(y)=2 is causally dependent on W(x)=1
P3: must see W(x)=1 before W(y)=2
P4: sees W(y)=2 → must also see W(x)=1
```

**Practical implementations:** COPS (Clusters of Order-Preserving Servers), MongoDB's causally consistent sessions, Cosmos DB's session consistency.

**Use case:** Social feed. If you post a reply to a post, followers must see the original post before your reply. Causal consistency guarantees this without needing full linearizability.

---

### Eventual Consistency

**Definition:** If no new updates are made to a given data item, eventually all accesses will return the last updated value.

**What this says and doesn't say:**
- It says: *eventually* converge. No time bound specified.
- It doesn't say: how long "eventually" takes.
- It doesn't say: what happens during the convergence window.

**Conflict resolution strategies required:**
1. **Last-Write-Wins (LWW):** Use timestamps. Risk: clock skew causes data loss.
2. **Multi-value (siblings):** Store all concurrent values, let application reconcile (Riak).
3. **CRDTs (Conflict-free Replicated Data Types):** Data structures mathematically guaranteed to merge without conflicts (counters, sets, maps).

**CRDT example — G-Counter (grow-only counter):**
```
Node A: [3, 0, 0]  (A incremented 3 times)
Node B: [0, 5, 0]  (B incremented 5 times)
Merge:  [3, 5, 0]  (element-wise max)
Value:  3 + 5 = 8  ← no conflict possible
```

**Databases:** Cassandra (default), DynamoDB (default), Couchbase, Riak.

---

## 5. Consensus Algorithms

### Why Consensus Is Hard

The **FLP Impossibility** (Fischer, Lynch, Paterson, 1985): In an asynchronous distributed system, there is no deterministic algorithm that can reach consensus in the presence of even a single crash failure.

This means: you cannot build a perfectly reliable consensus algorithm for purely asynchronous systems. Practical systems get around this by assuming *partial synchrony* (messages arrive within unknown but finite time bounds).

---

### Paxos

Proposed by Leslie Lamport (1989, published 1998). The canonical consensus algorithm. Notoriously difficult to implement correctly.

**Roles:**
- **Proposers:** Propose values
- **Acceptors:** Accept/reject proposals (the quorum participants)
- **Learners:** Learn the decided value

**Phase 1 (Prepare/Promise):**
```
Proposer                    Acceptors (majority)
   |                              |
   |── PREPARE(n) ──────────────→ |  (n = proposal number, monotonically increasing)
   |                              |
   |← PROMISE(n, accepted_val) ──|  (acceptor promises not to accept < n)
   |                              |  (returns highest accepted proposal if any)
```

**Phase 2 (Accept/Accepted):**
```
Proposer                    Acceptors
   |                              |
   |── ACCEPT(n, value) ────────→ |  (value: from phase 1 if any were returned, else proposer's value)
   |                              |
   |← ACCEPTED(n) ──────────────|
   |                              |
   When majority accepts → value is CHOSEN
```

**Multi-Paxos (for log replication):**

Basic Paxos decides one value. For a replicated log, you need Multi-Paxos which elects a *distinguished leader* who can skip Phase 1 for subsequent proposals (the leader "leases" authority):

```
Epoch 1: Leader L1 wins Phase 1, gets authority.
          L1 can now propose log entries using Phase 2 only.
          Phase 1 is amortized across many entries.
Epoch 2: If L1 fails, a new candidate runs Phase 1 again.
```

**Why Paxos is hard to implement:**
1. Leader election is not part of the protocol — you have to build it separately.
2. Multiple proposers can conflict (livelock — two proposers keep incrementing n).
3. Recovering from a failed leader requires careful state reconstruction.
4. The paper describes only single-decree consensus; log replication requires significant additional design.
5. No canonical reference implementation — every system (Chubby, Zookeeper's Zab, Viewstamped Replication) implements a Paxos variant.

**Lamport's own words:** "There is only one consensus protocol, and that's Paxos — all other approaches are just a broken version of Paxos." But also: "The dirty little secret is that everyone implements Paxos differently."

---

### Raft

Designed by Diego Ongaro and John Ousterhout (2014) explicitly for understandability. Same safety guarantees as Multi-Paxos, but decomposed into three subproblems:

1. **Leader Election**
2. **Log Replication**
3. **Safety (Log Commitment)**

**Server states:**
```
          timeout, start election
Follower ────────────────────────→ Candidate
   ↑                                   |
   | receives AppendEntries            | wins election
   | from leader (heartbeat)           ↓
   └────────────────────────────── Leader
```

#### 5.1 Leader Election

**Terms:** Raft divides time into *terms* (monotonically increasing integers). Each term begins with an election.

**Election mechanism:**
1. Follower has *election timeout* (randomized: 150–300ms by default).
2. If no heartbeat received before timeout: follower becomes candidate.
3. Candidate increments `currentTerm`, votes for itself, sends `RequestVote` RPC to all.
4. Wins if it receives votes from a majority (including itself).

**RequestVote RPC:**
```
RequestVote(term, candidateId, lastLogIndex, lastLogTerm)

Voter grants vote IF:
  1. term >= voter's currentTerm
  2. voter has not already voted in this term (or voted for this candidate)
  3. candidate's log is at least as up-to-date as voter's log
     (lastLogTerm > voter's lastLogTerm) OR
     (lastLogTerm == voter's lastLogTerm AND lastLogIndex >= voter's log length)
```

Condition 3 is critical for **safety**: prevents a candidate with a stale log from becoming leader and overwriting committed entries.

**Split vote handling:**
If no candidate wins majority (split vote), all candidates wait a new randomized timeout and try again. The randomization makes it unlikely two candidates time out simultaneously.

**Why randomized timeouts work:**
With 5 nodes, each with timeout uniform in [150, 300]ms:
- Probability that two nodes fire within 10ms of each other = ~3.3%
- In practice, leaders stabilize within 1–2 election rounds

#### 5.2 Log Replication

```
Client                Leader              Followers (F2, F3, F4)
   |                    |                       |
   |── command ────────→|                       |
   |                    |── AppendEntries ──────→|  (log entry + prevLogIndex + prevLogTerm)
   |                    |← success ─────────────|
   |                    |── AppendEntries ──────→|
   |                    |← success ─────────────|
   | (majority = 3)     |                       |
   |← response ─────────|  ← COMMITTED          |
   |                    |── AppendEntries ──────→|  (commit index updated)
```

**AppendEntries RPC:**
```
AppendEntries(term, leaderId, prevLogIndex, prevLogTerm, entries[], leaderCommit)

Follower rejects IF:
  1. term < currentTerm
  2. log doesn't contain entry at prevLogIndex with term prevLogTerm
     → Leader retries with decremented nextIndex (log backtracking)

Follower accepts:
  - Appends entries to log
  - If leaderCommit > commitIndex: update commitIndex = min(leaderCommit, last new entry)
```

**Log matching property (safety invariant):**
- If two entries in different logs have the same index and term, they store the same command.
- If two entries in different logs have the same index and term, all preceding entries are identical.

This is enforced by the `prevLogIndex + prevLogTerm` check in AppendEntries.

#### 5.3 Commitment and Safety

An entry is **committed** when stored on a majority of servers. Committed entries are durable — they will never be lost.

**Leader commitment rule:**
```
Leader can only commit entries from the CURRENT term.
It cannot commit entries from previous terms directly.
```

Why? Consider this scenario:
```
Term 1: Leader L1 replicates entry E to F1 and F2, then crashes.
Term 2: L2 wins, replicates its own entry to majority.
Term 3: L1 restarts, somehow becomes leader.
         If L1 counts E as committed, it may overwrite L2's committed entries.
```

Raft's fix: L3 (new leader in term 3) only counts entries as committed if it can commit *a new entry from its own term* which forces all previous entries to be visible.

#### 5.4 Snapshotting (Log Compaction)

The log grows indefinitely without compaction. Raft supports snapshotting:

```
Log: [1: set x=1][2: set y=2][3: set x=3][4: del y][...]
                                 ↓
Snapshot (state at index 4): {x: 3}  + snapshot index=4, snapshot term=2
Log:                         [5: ...][6: ...]
```

**InstallSnapshot RPC:** Leader sends snapshot to lagging followers who have fallen too far behind to catch up via normal AppendEntries.

#### 5.5 Practical Raft Implementations

| System | Raft Implementation Notes |
|--------|--------------------------|
| etcd | Reference implementation in Go; used by Kubernetes |
| CockroachDB | Multi-Raft (one Raft group per range/shard) |
| TiKV | Multi-Raft like CockroachDB |
| Consul | Leader election and KV consensus |
| InfluxDB | Single Raft group for metadata |

**Performance numbers:**
- etcd: ~10,000–50,000 writes/sec on commodity hardware
- Writes require majority acknowledgment → latency tied to slowest replica in quorum
- Cross-AZ deployment: ~4–8ms per write (one extra round trip)

---

## 6. Distributed Transactions

### Two-Phase Commit (2PC)

**Roles:** Coordinator, Participants (cohorts)

```
Phase 1 (Prepare):
Coordinator ──── PREPARE ──────→ Participant A
            ──── PREPARE ──────→ Participant B
            ←─── VOTE_YES ─────  Participant A  (A locks resources, writes to WAL)
            ←─── VOTE_YES ─────  Participant B

Phase 2 (Commit):
Coordinator ──── COMMIT ───────→ Participant A
            ──── COMMIT ───────→ Participant B
            ←─── ACK ──────────  Participant A  (A releases locks)
            ←─── ACK ──────────  Participant B
```

**The blocking problem:**

After sending PREPARE, participants lock their resources and *wait*. If the coordinator crashes at exactly this point:

```
Participants: voted YES, resources locked, waiting for COMMIT or ABORT.
              They CANNOT proceed. They CANNOT release locks.
              They must wait for coordinator to recover.
```

This blocking window is the fundamental flaw of 2PC. The coordinator is a single point of failure that can block the entire transaction indefinitely.

**How long can participants be blocked?**
Until the coordinator recovers. If the coordinator's disk failed, that could be hours. During this time, all locked rows are inaccessible.

**Coordinator recovery:**
The coordinator writes its decision to a WAL *before* sending commit messages. On restart, it re-reads the WAL and re-sends the decision to all participants who haven't acknowledged. This recovers from coordinator crashes after the decision point.

**The unrecoverable case:**
Coordinator crashes *between* receiving all VOTE_YES messages and writing the decision to WAL. State is indeterminate — the coordinator doesn't know if it decided commit or abort. The participants are stuck.

---

### Three-Phase Commit (3PC)

Designed to eliminate the blocking problem of 2PC by adding a pre-commit phase:

```
Phase 1 (CanCommit):    Coordinator → CanCommit? → Participants respond Yes/No
Phase 2 (PreCommit):    Coordinator → PreCommit  → Participants ACK
Phase 3 (DoCommit):     Coordinator → Commit     → Participants commit
```

**The key property:** After PreCommit, if coordinator fails, participants *can* decide to commit on their own (because all participants know all others voted yes).

**Why 3PC is still problematic:**
3PC is only non-blocking under **no network partitions**. With partitions:
- If a partition occurs during PreCommit, some participants may have received PreCommit (and will commit on timeout) while others didn't (and will abort on timeout).
- Result: split-brain — some nodes committed, others aborted.

3PC assumes a synchronous network model. In real networks (which are asynchronous), 3PC doesn't fully solve the problem.

**Why 2PC is used in practice anyway:**
- XA protocol (JTA in Java) implements 2PC.
- The blocking window is typically short (milliseconds).
- For databases co-located in the same datacenter, the risk is acceptable.
- For cross-datacenter transactions, you don't use 2PC at all — you use Saga.

---

### Saga Pattern

Saga decomposes a distributed transaction into a sequence of local transactions, each of which publishes events or messages. If any step fails, compensating transactions undo the previous steps.

**Key insight:** No locks held across services. Each service commits locally. Eventual consistency is accepted.

#### Choreography-based Saga

Each service listens to events and reacts independently. No central coordinator.

```
[Order Service]       [Payment Service]      [Inventory Service]
      |                      |                       |
 OrderCreated ──────────────→|                       |
                    PaymentCompleted ───────────────→|
                                            InventoryReserved ──→ [done]

Failure path:
 OrderCreated ──────────────→|                       |
                    PaymentFailed ──────────────────→|
                                           (no inventory reservation)
      |←─── OrderCancelled ─────────────────────────|
```

**Advantages:**
- Loose coupling. Services don't know about each other.
- No single point of failure.
- Natural fit for event-driven systems.

**Disadvantages:**
- Hard to understand the overall transaction flow.
- Difficult to add error handling / timeouts globally.
- Testing requires simulating complex event sequences.
- Hard to debug: which service caused the failure?

#### Orchestration-based Saga

A central orchestrator (saga orchestrator) commands each service and tracks state.

```
[Saga Orchestrator]
      |
      |── CreateOrder ──────→ [Order Service]
      |← OrderCreated ────────────────────────
      |
      |── ChargePayment ────→ [Payment Service]
      |← PaymentCharged ──────────────────────
      |
      |── ReserveInventory →  [Inventory Service]
      |← InventoryReserved ───────────────────
      |
      Done ✓

Failure path:
      |── ReserveInventory →  [Inventory Service]
      |← InventoryFailed ─────────────────────
      |── RefundPayment ─────→ [Payment Service]   ← compensating transaction
      |← PaymentRefunded ─────────────────────
      |── CancelOrder ───────→ [Order Service]
      Done (rolled back) ✓
```

**Advantages:**
- Clear transaction flow visible in one place.
- Easy to add timeouts, retries, error handling.
- Better observability — orchestrator state machine is auditable.

**Disadvantages:**
- Orchestrator is a single point of complexity (not failure, if made resilient).
- More coupling — orchestrator knows about all services.
- Needs persistence for orchestrator state (e.g., stored in DB, or using Temporal).

#### TCC Pattern (Try-Confirm-Cancel)

Two-phase approach at the application level:

```
Phase 1 (Try):     Reserve resources, don't commit. Validation only.
Phase 2a (Confirm): If all try succeeded → confirm all.
Phase 2b (Cancel):  If any try failed → cancel all.
```

```java
// Try phase - reserve $100 from account
boolean try_debitAccount(String txId, String accountId, long amount) {
    // Lock $100 in "reserved" state, not yet debited
    return reservationRepo.createReservation(txId, accountId, amount);
}

// Confirm phase - actually debit
void confirm_debitAccount(String txId) {
    Reservation r = reservationRepo.get(txId);
    accountRepo.debit(r.accountId(), r.amount());
    reservationRepo.delete(txId);
}

// Cancel phase - release reservation
void cancel_debitAccount(String txId) {
    reservationRepo.delete(txId); // release lock, no actual debit
}
```

**Advantage over Saga:** Resources are locked during the Try phase, preventing concurrent modifications. Closer to ACID semantics.

**Disadvantage:** Requires participating services to implement try/confirm/cancel interfaces — invasive.

**Used in:** Alibaba's Seata framework uses TCC as one of its transaction modes.

---

## 7. Vector Clocks & Lamport Timestamps

### Lamport Timestamps

**The problem:** In distributed systems, there is no global clock. You can't order events across machines by wall time (clock drift is ±100ms or more).

**Lamport's solution (1978):** Logical clocks that respect the *happens-before* relation.

**Happens-before (→):**
1. If a and b are events in the same process and a comes before b: a → b
2. If a is sending a message and b is receiving that message: a → b
3. Transitivity: if a → b and b → c then a → c
4. If neither a → b nor b → a: *concurrent* (a || b)

**Lamport clock algorithm:**
```
Each process maintains counter C, initialized to 0.

On every local event: C = C + 1
On send(message):     C = C + 1; attach C to message
On receive(message):  C = max(C, message.C) + 1
```

**What Lamport timestamps guarantee:**
- If a → b then C(a) < C(b)
- **But NOT:** If C(a) < C(b) then a → b  ← this is NOT guaranteed

Two events may have C(a) < C(b) but still be concurrent (a || b). Lamport clocks can't distinguish causality from concurrency.

```
P1: C=1 (event e1)
P2: C=1 (event e2)
     e1 || e2 (concurrent), but both have timestamp 1
     Adding node ID as tiebreaker gives total order, but it's arbitrary.
```

**Use cases:** Log ordering (append-only), lock ordering (total order needed but not causal).

---

### Vector Clocks

**Invented by:** Colin Fidge and Friedemann Mattern (independently, 1988)

**Data structure:** Each node maintains a vector V of size N (number of nodes). V[i] = number of events node i has had that are known to this node.

**Algorithm:**
```
Node i starts: V = [0, 0, ..., 0]

On local event:     V[i] = V[i] + 1
On send(message):   V[i] = V[i] + 1; attach V to message
On receive(message M from node j):
    V[k] = max(V[k], M.V[k]) for all k
    V[i] = V[i] + 1
```

**Comparison:**
```
V1 = [3, 2, 1], V2 = [4, 1, 2]

V1 < V2 (causally before): ∀k: V1[k] ≤ V2[k] AND ∃k: V1[k] < V2[k]
V1 and V2 are concurrent: neither V1 < V2 nor V2 < V1

Here: V1[0]=3 < V2[0]=4 ✓, V1[1]=2 > V2[1]=1 ✗
       → V1 and V2 are CONCURRENT
```

**What vector clocks guarantee:**
- a → b iff VC(a) < VC(b) (element-wise less-or-equal, at least one strict)
- a || b iff neither VC(a) < VC(b) nor VC(b) < VC(a)

This is a complete characterization of the happens-before relation.

**How Dynamo/Riak uses vector clocks:**
```
Client writes key="cart" value=["milk"]:
    Node A: V = {A:1} → stored with vector clock {A:1}

Client reads, then writes key="cart" value=["milk", "bread"]:
    Node A: V = {A:2} → stored with {A:2}

Concurrent write (partition, client 2 connected to Node B):
    Node B: V = {A:1, B:1} → stored with {A:1, B:1}

After partition heals, Node A has {A:2}, Node B has {A:1, B:1}:
    {A:2} vs {A:1, B:1}: neither is ancestor of other → CONFLICT
    Application resolves: merge both carts → ["milk", "bread"] ∪ ["milk", "eggs"]
```

**Vector clock overhead:**
Vector size grows with the number of nodes. With thousands of nodes, this becomes expensive. DynamoDB's original vector clock implementation had a pruning mechanism that removed old entries, which could cause false "no conflict" determination.

**Amazon's solution:** DynamoDB now uses a simpler approach — last-write-wins with version numbers, accepting some data loss. They published a paper (Vogels, 2007) acknowledging this tradeoff.

---

## 8. Gossip Protocols

### Overview

Gossip (also called epidemic protocols) is a peer-to-peer communication paradigm where nodes periodically exchange state with a small random subset of other nodes. Information spreads through the network like a rumor.

**Why gossip instead of broadcast:**
- Broadcast: O(N) messages from coordinator, coordinator is bottleneck
- Gossip: O(N log N) messages total, fully decentralized, tolerates node failures

### Anti-Entropy (Reconciliation)

Each node periodically selects a random peer and syncs state by exchanging and merging differences.

```
Node A (state: {x:1, y:2})  →  Node B (state: {x:1, z:3})

After gossip: A = {x:1, y:2, z:3}, B = {x:1, y:2, z:3}
```

**Convergence time:** O(log N) rounds for any update to reach all N nodes.

### Rumor-Spreading (Infection)

When a node receives new information, it becomes "infected" and starts actively gossiping that information to random peers. Once it has spread the rumor k times, it becomes "removed" and stops spreading.

**Reliability:** Some nodes might never receive the information. Anti-entropy is more reliable but more expensive.

### How Cassandra Uses Gossip

Cassandra uses gossip for:
1. **Membership:** Which nodes are in the cluster?
2. **Node state:** Is a node UP, DOWN, LEAVING, JOINING?
3. **Schema:** Which version of the schema does each node have?
4. **Token ownership:** Which tokens does each node own?

**GossipDigestSyn / GossipDigestAck / GossipDigestAck2 — the 3-message protocol:**
```
Node A                          Node B
   |                                |
   |── GossipDigestSyn ────────────→|  (A's digest: {nodeId: version} map)
   |                                |
   |← GossipDigestAck ─────────────|  (B's digest + deltas for entries A is behind on)
   |                                |
   |── GossipDigestAck2 ───────────→|  (deltas for entries B is behind on)
```

**Round-1 initiator:** Each node initiates gossip with:
1. A random live node
2. A random unreachable node (to detect recovery)
3. A random seed node (to handle initial cluster formation)

**Versioning:** Each node's state has an `ApplicationState` map with `HeartBeatState` version. Versions are monotonically increasing. During reconciliation, higher version wins.

**Failure detection via gossip:** If Node B stops updating its heartbeat version, Node A's gossip rounds will see the version frozen. After a threshold, A marks B as DOWN and gossips that determination to others.

---

## 9. Consistent Hashing

### The Rehashing Problem

With modulo hashing (nodeIndex = hash(key) % N):
- Adding/removing a node changes N
- Almost every key maps to a different node
- Massive data reshuffling required — infeasible for production systems

**Example:** 3 nodes → 4 nodes. For a key with hash value 100:
- Before: 100 % 3 = 1 (Node 1)
- After:  100 % 4 = 0 (Node 0)
- ~75% of keys remapped

### Consistent Hashing Algorithm

**The ring:** Map both nodes and keys to a circular hash space [0, 2^32) or [0, 2^64).

```
         0
      ╔═══╗
 Node A   Node B
    ║         ║
    ╚═══════╝
         Node C

Key K: walk clockwise from hash(K) until you hit a node.
```

**Adding/removing a node:**
```
Before: A owns [0,A], B owns (A,B], C owns (B,C(=max)]
Add D between A and B: D owns (A,D], B now owns (D,B]
Only keys in (A,D] need to move: from B to D.
~1/N keys remapped (not ~(N-1)/N as with modulo)
```

### Virtual Nodes (VNodes)

**Problem with basic consistent hashing:**
With 3 physical nodes and 3 positions on ring:
- Positions may cluster, causing uneven load
- Adding 1 node only redistributes from 1 neighbor
- If one node is twice as powerful, it should own twice the ring

**Solution: Virtual nodes (tokens)**

Each physical node owns multiple positions on the ring. A physical node with more capacity gets more virtual nodes.

```
Physical Ring with vnodes (simplified):
0──────A1──B1──C1──A2──B2──C2──A3──B3──C3──(max)

Node A's vnodes: A1, A2, A3 → owns 1/3 of ring
Node B's vnodes: B1, B2, B3 → owns 1/3 of ring
Node C's vnodes: C1, C2, C3 → owns 1/3 of ring
```

**Benefits:**
1. Even distribution even with few physical nodes
2. When a node fails, its load distributes across ALL remaining nodes (not just its neighbors)
3. Heterogeneous hardware: powerful nodes get more vnodes

**Cassandra specifics:**
- Default: 256 vnodes per node (since Cassandra 4.0)
- Hash function: Murmur3 on the partition key
- Ring size: 2^64 tokens
- TreeMap<Long, Node> for O(log N) token lookup

```java
// Simplified consistent hashing in Java
TreeMap<Long, String> ring = new TreeMap<>();

// Adding a node with 256 vnodes
void addNode(String nodeId) {
    for (int i = 0; i < 256; i++) {
        long token = murmur3Hash(nodeId + "-vnode-" + i);
        ring.put(token, nodeId);
    }
}

// Finding responsible node for a key
String getNode(String key) {
    long hash = murmur3Hash(key);
    Map.Entry<Long, String> entry = ring.ceilingEntry(hash);
    if (entry == null) {
        entry = ring.firstEntry(); // wrap around
    }
    return entry.getValue();
}
```

### Replication with Consistent Hashing

Cassandra replication (RF=3): walk clockwise from the key's position, pick the next 3 *distinct physical nodes* (skipping vnodes of the same node).

```
Key K lands at vnode position X (owned by Node A).
Replica 1: Node A (the coordinator)
Replica 2: Next distinct physical node clockwise = Node B
Replica 3: Next distinct physical node clockwise = Node C
```

**NetworkTopologyStrategy:** Cassandra is rack-aware. For RF=3, it picks nodes from different racks to survive rack-level failures.

---

## 10. Failure Detection

### Why Fixed Timeouts Are Problematic

A fixed timeout T for declaring a node failed:
- Too small (T=1s): False positives under GC pause. A Java node in GC pause for 2s gets falsely declared dead → unnecessary failovers.
- Too large (T=30s): Slow failure detection. During the timeout window, requests continue routing to the dead node.

**GC pause example:**
```
Node A: Full GC pause, 4 seconds (G1GC promotion failure)
Failure detector: T=3s timeout, declares A dead at t=3
Recovery: A finishes GC at t=4, comes back alive
          But the cluster already rerouted traffic, initiated re-replication
          Unnecessary churn
```

### Phi Accrual Failure Detector (Hayashibara et al., 2004)

Instead of a binary alive/dead decision, the Phi detector outputs a continuous **suspicion level φ** based on historical inter-arrival times of heartbeats.

**How it works:**
1. Track the last N heartbeat arrival times for each node.
2. Compute the distribution of inter-arrival intervals (modeled as normal distribution or exponential).
3. For any point in time t: φ(t) = -log₁₀(P_later(t - t_last))
   where P_later is the probability that the next heartbeat arrives AFTER time t given the distribution.

```
φ = 1:  probability that node is dead = 90%
φ = 2:  probability = 99%
φ = 3:  probability = 99.9%
φ = 10: probability = 99.9999999% (10 nines)
```

**Threshold:** Application sets a threshold φ_threshold. If φ(t) > φ_threshold, the node is declared suspect/dead.

**Adaptive behavior:**
- Slow network → larger inter-arrival variance → φ rises slowly → fewer false positives
- Fast network → small variance → φ rises quickly → faster failure detection

**Cassandra implementation:**
```yaml
# cassandra.yaml
phi_convict_threshold: 8  # default
# φ=8 means ~99.999999% confidence before declaring dead
# Trades off: higher = fewer false positives, slower detection
```

**Akka implementation:** Akka's cluster uses the Phi accrual detector with configurable thresholds.

```scala
// akka.cluster in application.conf
akka.cluster {
  failure-detector {
    implementation-class = "akka.remote.PhiAccrualFailureDetector"
    threshold = 8.0
    max-sample-size = 1000
    min-std-deviation = 100 ms
    acceptable-heartbeat-pause = 3 s
    heartbeat-interval = 1 s
  }
}
```

---

## 11. Split-Brain Problem & Fencing Tokens

### The Split-Brain Problem

A network partition can create two groups of nodes that each believe they are the majority. Both elect a leader. Both accept writes. When the partition heals, you have two divergent data histories.

```
Before partition:
  Node A (leader), Node B, Node C, Node D, Node E

Partition:
  [Node A, Node B] ──── PARTITION ──── [Node C, Node D, Node E]

Node A, B: still believe A is leader, accept writes
Node C, D, E: elect C as new leader (majority), accept writes

BOTH process writes to the same data. After partition heals: CONFLICT.
```

### The Fencing Token Approach (Martin Kleppmann)

**The problem with locks:**
```
Client 1 acquires lease from ZooKeeper (valid for 30s).
Client 1 enters a GC pause for 35s.
The lease expires. Client 2 acquires the lease.
Client 2 starts writing to the shared resource.
Client 1 wakes up from GC, believes it still holds the lease (it doesn't know time passed).
Client 1 starts writing. TWO CLIENTS WRITING SIMULTANEOUSLY.
```

**Fencing tokens:** Every time a lease is granted, the lock server issues a monotonically increasing *fencing token*. The storage service **rejects** any write with a token lower than the highest token it has seen.

```
t=0: Client 1 acquires lease, gets token 33
t=10: Client 1 GC pause starts
t=20: Lease expires. Client 2 acquires lease, gets token 34
t=25: Client 2 writes with token 34. Storage accepts. maxToken = 34.
t=35: Client 1 wakes up, writes with token 33.
      Storage REJECTS: 33 < 34 (maxToken). Client 1's write is blocked.
```

**Implementation requirement:** The storage layer must enforce token ordering. ZooKeeper's `zxid` can serve as a fencing token. Etcd's revision numbers work similarly.

**ZooKeeper fencing pattern:**
```java
// Acquire lock
Stat stat = zk.exists("/leader-lock", false);
long fencingToken = stat.getCzxid(); // use ZooKeeper transaction ID as token

// Pass fencingToken to every resource operation
// Resource rejects operations with token < stored maxToken
```

### STONITH (Shoot The Other Node In The Head)

For databases where fencing tokens are impractical, split-brain is resolved by STONITH: forcibly killing the suspected node using out-of-band means (IPMI, power switch, hypervisor API).

**Example:** PostgreSQL + Pacemaker + Corosync cluster:
1. Network partition detected.
2. Minority partition (1 node) gets STONITH'd by the majority partition.
3. Guarantee: at most one node is writable at any time.
4. Downside: if STONITH fails, both nodes disable themselves (safest fallback).

**Why STONITH for databases:**
Databases with write-ahead logs can't easily use fencing tokens — the storage (disk) doesn't know about tokens. Physical node termination is the only safe way to ensure a stale leader stops writing.

---

## Summary: Interview Decision Framework

```
Question: Should this system be CP or AP?
  → What happens if users get stale data? (AP acceptable)
  → What happens if the system rejects writes during partition? (CP acceptable)
  → Financial data, locks, leader election: CP (ZooKeeper, etcd)
  → User feeds, caches, counters: AP (Cassandra, DynamoDB)

Question: What consistency model do I need?
  → Bank balance: Linearizability (Spanner, strict serializable DB)
  → "Read your own writes": Session consistency or causal consistency
  → Shopping cart: Eventual consistency + CRDT
  → Analytics counter: Eventual consistency + LWW

Question: Distributed transaction or Saga?
  → Within one DB or one data center, same team controls all services: 2PC/XA
  → Cross-service, cross-team, eventual consistency acceptable: Saga
  → Need ACID-like guarantees across services with compensation: TCC

Question: How to detect failures?
  → Simple system, predictable network: fixed timeout
  → Variable GC pauses, heterogeneous latency: Phi accrual detector
  → Need safe leader protection: fencing tokens
```

---

Sources consulted:
- [A closer look at Raft internals](https://codilime.com/blog/closer-look-at-raft-internals-log-replication-leader-election/)
- [Consistent Hashing for System Design Interviews](https://www.hellointerview.com/learn/system-design/core-concepts/consistent-hashing)
- [Cassandra Architecture: Dynamo](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html)
- [CAP Theorem - Wikipedia](https://en.wikipedia.org/wiki/CAP_theorem)
- [Consistency and Partition Tolerance: CAP vs PACELC](https://blog.bytebytego.com/p/consistency-and-partition-tolerance)
- [Vector Clocks - Kevin Sookocheff](https://sookocheff.com/post/time/vector-clocks/)
