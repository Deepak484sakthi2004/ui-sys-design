# Chapter 20: Real-World Correlations

## The Capstone Mapping — Every Data Structure Has a Production Twin

This is the chapter where everything converges. Every data structure, every algorithmic pattern, every JVM optimization we have studied across nineteen chapters — they all exist in production systems you already use. Not as academic abstractions, but as the literal implementation strategy chosen by the engineers who built Redis, Linux, Kafka, Elasticsearch, TCP/IP, and the JDK itself.

I have spent years reading kernel source, database internals, distributed systems papers, and JDK source code. The pattern is always the same: the engineers who build real systems do not invent new data structures. They reach for the same ones you study in DSA — arrays, hash tables, trees, graphs, queues, heaps — and they choose them for the same reasons: time complexity, space complexity, cache behavior, and concurrency characteristics.

This chapter is the definitive mapping. After reading it, you will never again see a data structure as a textbook exercise. You will see it as the TCP sliding window. As the Linux CFS scheduler. As the InnoDB B+ tree. As the Kafka append-only log. Every interview question becomes a system design question, and every system design question becomes a data structure question.

---

## 20.1 Master Mapping Table

Before we dive into each domain, here is the complete mapping table. This is your reference card — the single page you pin above your desk.

```
┌──────────────────────────────┬──────────────────────────────────────┬───────────────────────────────────────────────────────┐
│ Data Structure / Pattern     │ Real-World System                    │ How It Is Used                                        │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Array (contiguous)           │ Kafka log segment                    │ Append-only mmap'd file as sequential array           │
│                              │ CPU L1/L2 cache line                 │ 64-byte blocks, sequential int[] beats LinkedList 50x │
│                              │ Netty ByteBuf                        │ byte[] backing for zero-copy network I/O               │
│                              │ InnoDB page                          │ 16KB fixed-size page, B+ tree node is an array of keys│
│                              │ Vector clocks                        │ int[] per process for causal ordering                  │
│                              │ Bitmap index                         │ BitSet per column value (low-cardinality indexing)     │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Dynamic Array (ArrayList)    │ Raft/Paxos log                       │ ArrayList<LogEntry> — append-only, index by term       │
│                              │ JVM ArrayList/StringBuilder          │ 1.5x growth, System.arraycopy for resize               │
│                              │ Redis SDS (Simple Dynamic String)    │ Pre-allocated buffer with length + capacity tracking   │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Linked List                  │ Linux kernel task lists               │ Doubly linked circular list of processes               │
│                              │ LRU eviction (doubly linked)         │ LinkedHashMap: O(1) move-to-front on access            │
│                              │ Epoll ready list                     │ Kernel linked list of fds with pending events          │
│                              │ Free list allocators                 │ Slab allocator: linked list of free blocks per size    │
│                              │ Undo log chain (InnoDB)              │ Linked list of undo records for MVCC                  │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ HashMap / Hash Table         │ ARP cache                            │ IP → MAC mapping with TTL expiration                  │
│                              │ Connection tracking (netfilter)      │ HashMap<5-tuple, ConnState> for stateful firewall     │
│                              │ DNS cache                            │ Domain → IP with TTL                                  │
│                              │ Spring bean container                │ HashMap<BeanName, Object>                             │
│                              │ Hibernate L2 cache                   │ ConcurrentHashMap<EntityKey, Entity>                  │
│                              │ Redis dict                           │ Two hash tables for incremental rehash                │
│                              │ Query plan cache                     │ HashMap<SQL fingerprint, ExecutionPlan>               │
│                              │ Git object store                     │ HashMap<SHA1, Blob/Tree/Commit>                       │
│                              │ JVM string intern table              │ Hash table of canonical String instances               │
│                              │ Page table TLB                       │ Hardware hash table for virtual→physical translation  │
│                              │ Load balancer (consistent hashing)   │ TreeMap as hash ring for server assignment             │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ TreeMap / Red-Black Tree     │ Linux CFS scheduler                  │ RB-tree of tasks keyed by vruntime                    │
│                              │ Epoll fd tracking                    │ RB-tree for O(log n) fd insert/remove                 │
│                              │ Java TreeMap / ConcurrentSkipListMap │ Sorted key-value with O(log n) range queries          │
│                              │ Consistent hashing ring              │ TreeMap<hash, server> with ceilingEntry()             │
│                              │ Interval scheduling                  │ TreeMap for finding overlapping intervals              │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ B+ Tree                      │ InnoDB clustered index               │ Primary key → row data, all rows stored in leaf nodes │
│                              │ InnoDB secondary index               │ Secondary key → primary key pointer                   │
│                              │ PostgreSQL btree index               │ Default index type for range + equality queries       │
│                              │ Filesystem directory index (ext4)    │ HTree = hashed B-tree for directory entries            │
│                              │ LMDB (Lightning Memory-Mapped DB)    │ Copy-on-write B+ tree with mmap                      │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ LSM Tree                     │ LevelDB / RocksDB                    │ memtable (TreeMap) → SSTable (sorted array on disk)   │
│                              │ Cassandra                            │ Write-optimized: all writes go to memtable first      │
│                              │ HBase                                │ Region server = LSM tree per column family            │
│                              │ Elasticsearch segment merge          │ Lucene segments = LSM-style compaction                │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Trie / Prefix Tree           │ IP routing table                     │ Longest prefix match for CIDR routing                 │
│                              │ Autocomplete / search suggestion     │ Prefix lookup in O(prefix length)                     │
│                              │ HTTP router (Radix tree)             │ Gin (Go), Netty path matching                        │
│                              │ Linux page table                     │ Multi-level radix tree (4-level on x86_64)            │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Heap / Priority Queue        │ OS process scheduler (legacy)        │ Priority queue of runnable processes                  │
│                              │ Network QoS packet scheduling        │ Priority queue per traffic class                      │
│                              │ Timer wheel (Kafka, Netty)           │ Hierarchical timing wheel for scheduled tasks         │
│                              │ Dijkstra's algorithm                 │ Min-heap for shortest path (OSPF routing)             │
│                              │ Merge K sorted streams               │ Min-heap of stream heads (external sort, LSM merge)   │
│                              │ Top-K (real-time analytics)          │ Min-heap of size K for streaming top-K                │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Queue / Deque                │ Tomcat thread pool                   │ ArrayBlockingQueue as work queue                      │
│                              │ Netty event loop                     │ MPSC queue (multi-producer single-consumer)            │
│                              │ BFS (graph traversal)                │ ArrayDeque as FIFO for level-order traversal          │
│                              │ Message broker                       │ Kafka partition = ordered queue of messages            │
│                              │ Pipe/socket buffer                   │ Circular buffer (ring buffer) for I/O                 │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Stack                        │ JVM call stack                       │ Method frames pushed/popped per call                  │
│                              │ Expression evaluation                │ Shunting-yard algorithm, postfix evaluation            │
│                              │ DFS (graph traversal)                │ Explicit stack or recursion stack                     │
│                              │ Undo/redo                            │ Two stacks: undo stack + redo stack                   │
│                              │ Browser history (back/forward)       │ Two stacks of URLs                                   │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Ring Buffer (Circular Array) │ LMAX Disruptor                       │ Lock-free ring buffer for inter-thread messaging      │
│                              │ Log4j2 AsyncLogger                   │ Disruptor ring buffer for async log events            │
│                              │ Linux kernel net_device rx ring      │ NIC driver ring buffer for incoming packets           │
│                              │ TCP send/receive buffer              │ Circular buffer of bytes for flow control             │
│                              │ Kafka log segment (conceptual)       │ Append at tail, expire from head by retention policy  │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Bloom Filter                 │ Cassandra SSTable lookup              │ Skip disk reads for absent keys                      │
│                              │ HBase block filter                   │ Reduce I/O for block-level key lookup                 │
│                              │ Chrome malicious URL check           │ Probabilistic check before full DB query              │
│                              │ Squid proxy cache                    │ Avoid cache-miss disk reads                           │
│                              │ Bitcoin SPV node                     │ Filter transactions without downloading full blocks   │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Skip List                    │ Redis sorted sets (ZSET)             │ Skip list + hash table for O(log n) rank queries     │
│                              │ ConcurrentSkipListMap (JDK)          │ Lock-free sorted concurrent map                      │
│                              │ LevelDB MemTable                     │ In-memory sorted structure before flush to SSTable    │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Graph (adjacency list/matrix)│ Social networks                      │ User → friends (adjacency list)                      │
│                              │ Dependency resolution (Maven/Gradle) │ DAG of artifacts, topological sort                    │
│                              │ Microservice dependency graph        │ Service → dependencies, cycle detection               │
│                              │ Network topology                     │ Router → neighbors, shortest path routing             │
│                              │ Git commit graph                     │ DAG of commits (each commit points to parents)        │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Merkle Tree                  │ Git integrity                        │ Hash of every tree/blob, root hash = commit id        │
│                              │ Blockchain                           │ Transaction Merkle root in block header               │
│                              │ Cassandra anti-entropy repair        │ Compare Merkle trees across replicas to find diffs    │
│                              │ IPFS / content-addressed storage     │ Content hash as address, Merkle DAG for directories   │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Sliding Window               │ TCP congestion control               │ Window of unacknowledged bytes                        │
│                              │ Rate limiting                        │ Fixed/sliding window of request timestamps            │
│                              │ Stream processing (Flink, Kafka)     │ Time-based or count-based windows for aggregation     │
│                              │ Substring problems                   │ Two-pointer window for pattern matching               │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Two Pointers / Fast-Slow     │ Floyd's cycle detection              │ Linked list cycle detection (fast/slow pointers)      │
│                              │ GC mark phase                        │ Tri-color marking: white/gray/black pointer states    │
│                              │ TCP flow control                     │ Producer/consumer window pointers                    │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Union-Find (Disjoint Set)    │ Network connectivity                 │ "Are these two nodes in the same network partition?"  │
│                              │ Kruskal's MST (network topology)     │ Minimum cost spanning tree for network links          │
│                              │ Image segmentation                   │ Connected component labeling in pixel grids           │
│                              │ Distributed cluster membership       │ Merging partitions after network heals                │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Topological Sort             │ Build systems (Make, Gradle, Bazel)  │ Dependency order for compilation                     │
│                              │ Package managers (apt, npm)           │ Install dependencies in correct order                 │
│                              │ Data pipeline orchestration (Airflow)│ DAG of tasks with dependency edges                   │
│                              │ Spring bean initialization order     │ Resolve @DependsOn annotations                       │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Dynamic Programming          │ TCP AIMD congestion control          │ Additive increase, multiplicative decrease (optimal)  │
│                              │ Database query optimizer              │ Optimal join order (exponential → DP memoization)    │
│                              │ Text diff (git diff, Myers algorithm)│ Shortest edit script = longest common subsequence     │
│                              │ Spell checker                        │ Edit distance (Levenshtein) via DP                   │
│                              │ Resource allocation / bin packing    │ Knapsack variant for VM placement                    │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Greedy                       │ Huffman coding (gzip, zlib)          │ Greedy character frequency encoding                  │
│                              │ TCP Nagle's algorithm                │ Greedily buffer small packets                        │
│                              │ Job scheduling (SJF)                 │ Shortest job first = greedy by duration               │
│                              │ Prim's MST (network design)          │ Greedily add cheapest edge to growing tree            │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Backtracking                 │ Constraint solvers (SAT, CSP)        │ Try assignment, detect conflict, backtrack            │
│                              │ Regex engine (NFA backtracking)      │ Java Pattern: backtrack on failed partial match       │
│                              │ Database query optimizer (exhaustive)│ Try join orders, prune infeasible plans               │
│                              │ Sudoku / puzzle solvers              │ Place, validate, recurse or undo                     │
├──────────────────────────────┼──────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Divide and Conquer           │ MapReduce                            │ Split data → process shards → merge results           │
│                              │ Merge sort (external sort)           │ Split → sort chunks → merge (used in DB sort spill)  │
│                              │ Binary search                        │ B+ tree index lookup, sorted SSTable key search       │
│                              │ Fork/Join framework (JDK)            │ Recursive task splitting with work stealing           │
└──────────────────────────────┴──────────────────────────────────────┴───────────────────────────────────────────────────────┘
```

Now let us go deep into each domain.

---

## 20.2 Networking — Where Algorithms Run at Wire Speed

Every packet that flows through a network stack is processed by data structures and algorithms we study in DSA. Networking is where algorithms meet microsecond latency budgets, and where a poor choice means dropped packets under load.

### 20.2.1 TCP Sliding Window → Sliding Window Pattern

The TCP sliding window is the canonical real-world example of the sliding window pattern from Chapter 15. When you solve "longest substring without repeating characters" or "minimum window substring," you are implementing the same state machine that TCP uses for flow control.

```
TCP Sender's View:
                                 ┌─── window_size (advertised by receiver) ───┐
                                 │                                              │
    [ACK'd and done] [Sent, not ACK'd] [Can send]        [Cannot send yet]
    ─────────────────────────────────────────────────────────────────────────
    | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10| 11| 12| 13| 14| 15| 16| ...
    ─────────────────────────────────────────────────────────────────────────
              ↑                               ↑                ↑
         send_base                      next_seq_num      send_base + window_size
         (left pointer)                 (right pointer)

    When ACK for packet 4 arrives:
      - Slide left pointer to 5
      - Window "slides" right, allowing packet 13 to be sent
      - Exactly like: while (left condition met) left++;
```

In Java terms, if you were implementing a simplified TCP sender:

```java
public class TcpSlidingWindow {
    private final byte[] sendBuffer;        // circular buffer of outgoing data
    private int sendBase;                   // left pointer: oldest unACK'd byte
    private int nextSeqNum;                 // right pointer: next byte to send
    private int windowSize;                 // advertised by receiver (rwnd)
    private int congestionWindow;           // sender-side congestion window (cwnd)

    // Effective window = min(rwnd, cwnd) - (nextSeqNum - sendBase)
    public int availableWindow() {
        int effectiveWindow = Math.min(windowSize, congestionWindow);
        int inFlight = nextSeqNum - sendBase;
        return Math.max(0, effectiveWindow - inFlight);
    }

    // When data is ready to send:
    public void send(byte[] data) {
        while (availableWindow() > 0 && hasDataToSend()) {
            // Send next segment, advance right pointer
            sendSegment(nextSeqNum);
            nextSeqNum += segmentSize;          // expand window right
        }
    }

    // When ACK arrives:
    public void onAck(int ackNum) {
        if (ackNum > sendBase) {
            sendBase = ackNum;                   // slide window left
            // Window slides right implicitly (availableWindow increases)
            // Try to send more data now that window opened up
            send(null);
        }
    }
}
```

**Congestion control** adds a second dimension. TCP's AIMD (Additive Increase, Multiplicative Decrease) is a greedy/DP hybrid:

- **Additive increase**: each RTT without loss, `cwnd += MSS` (linear growth — cautiously explore bandwidth)
- **Multiplicative decrease**: on loss, `cwnd = cwnd / 2` (aggressive backoff — avoid congestion collapse)

This is a form of online optimization where the algorithm must balance throughput (send as fast as possible) against congestion (do not overwhelm the network). The "sliding window" pattern here is not just about the data structure — it is about the state machine that advances the window boundaries.

**Duplicate ACK detection** uses counting within the window. Three duplicate ACKs for the same sequence number trigger fast retransmit — the sender infers that the next segment was lost without waiting for a timeout. This is pattern matching within a stream, directly analogous to "count occurrences in a sliding window" problems.

### 20.2.2 IP Routing Table → Trie (Longest Prefix Match)

When a router receives a packet destined for `192.168.1.42`, it must find the most specific matching route. The routing table might contain:

```
0.0.0.0/0        → default gateway
192.0.0.0/8      → interface eth0
192.168.0.0/16   → interface eth1
192.168.1.0/24   → interface eth2
192.168.1.32/27  → interface eth3
```

All five routes match `192.168.1.42`. The correct one is `192.168.1.32/27` — the longest prefix match. This is a trie lookup on the binary representation of the IP address.

```
Binary trie for IP routing:
                        root
                       /    \
                      1      0 → default (0.0.0.0/0)
                     /
                    1
                   /
                  0
                 / \
                0   0
               /     \
              ...    ...
             /
            (192.168.1.0/24 match)
           / \
          0   1 → 192.168.1.32/27 (deeper = more specific)
```

```java
// Simplified binary trie for IP routing
public class IpRoutingTrie {
    private static class TrieNode {
        TrieNode[] children = new TrieNode[2]; // 0 and 1
        String nextHop;                        // non-null if this is a valid prefix endpoint
    }

    private final TrieNode root = new TrieNode();

    // Insert a route: e.g., prefix = 192.168.1.0, prefixLength = 24, nextHop = "eth2"
    public void addRoute(int prefix, int prefixLength, String nextHop) {
        TrieNode node = root;
        for (int i = 31; i >= (32 - prefixLength); i--) {
            int bit = (prefix >>> i) & 1;
            if (node.children[bit] == null) {
                node.children[bit] = new TrieNode();
            }
            node = node.children[bit];
        }
        node.nextHop = nextHop;  // mark this prefix as a valid route
    }

    // Longest prefix match: walk the trie bit by bit, remember the last match
    public String lookup(int destIp) {
        TrieNode node = root;
        String bestMatch = root.nextHop;  // default route if set

        for (int i = 31; i >= 0; i--) {
            int bit = (destIp >>> i) & 1;
            if (node.children[bit] == null) break;  // no deeper match
            node = node.children[bit];
            if (node.nextHop != null) {
                bestMatch = node.nextHop;  // longer prefix = more specific = better
            }
        }
        return bestMatch;
    }
}
```

In practice, routers use compressed tries (Patricia/Radix trees) or multi-bit stride tries (DIR-24-8) for faster lookup. The Linux kernel's routing table (`fib_trie`) is a level-compressed trie. Hardware routers use TCAM (Ternary Content-Addressable Memory) for O(1) longest prefix match — essentially a hardware-parallel trie.

### 20.2.3 ARP Cache → HashMap with TTL

The ARP (Address Resolution Protocol) cache maps IP addresses to MAC addresses on a local network segment. It is a `HashMap<IpAddress, MacEntry>` where each entry has a TTL.

```java
public class ArpCache {
    private static class ArpEntry {
        byte[] macAddress;
        long expirationTimeNanos;
        // State: INCOMPLETE, REACHABLE, STALE, DELAY, PROBE
    }

    // This is literally a HashMap with time-based expiration.
    // Linux kernel: struct neighbour + hash table (neigh_hash_table)
    private final Map<Integer, ArpEntry> cache = new ConcurrentHashMap<>();

    public byte[] resolve(int ipAddress) {
        ArpEntry entry = cache.get(ipAddress);
        if (entry != null && System.nanoTime() < entry.expirationTimeNanos) {
            return entry.macAddress;   // cache hit
        }
        // Cache miss: send ARP request (broadcast), wait for ARP reply
        // Update cache with new entry, TTL typically 30-300 seconds
        return sendArpRequest(ipAddress);
    }
}
```

The Linux kernel's neighbor table uses a hash table with chain buckets, periodic garbage collection of stale entries, and state machine transitions (INCOMPLETE → REACHABLE → STALE → ...). This is the exact same pattern as any TTL cache: `HashMap` for O(1) lookup + lazy or periodic expiration.

### 20.2.4 OSPF Routing → Dijkstra's Algorithm

OSPF (Open Shortest Path First) is a link-state routing protocol. Every router in the area floods its link-state advertisements (LSAs) so every router has a complete map of the network topology. Then each router runs Dijkstra's shortest-path algorithm to compute the best route to every destination.

```java
// OSPF's SPF (Shortest Path First) calculation — this IS Dijkstra's algorithm
public class OspfSpfCalculation {

    static class Link {
        int neighborRouterId;
        int cost;                  // metric: usually based on bandwidth (10^8 / bandwidth_bps)
    }

    // adjacency list: router_id → list of links
    // This IS the "graph" representation from Chapter 10
    Map<Integer, List<Link>> linkStateDatabase;

    // Dijkstra's algorithm — exactly as studied, but the "nodes" are routers
    // and "edges" are network links with costs
    public Map<Integer, Integer> computeRoutingTable(int myRouterId) {
        Map<Integer, Integer> dist = new HashMap<>();       // router → shortest cost
        Map<Integer, Integer> nextHop = new HashMap<>();    // router → next hop router
        PriorityQueue<int[]> pq = new PriorityQueue<>(Comparator.comparingInt(a -> a[1]));

        dist.put(myRouterId, 0);
        pq.offer(new int[]{myRouterId, 0});

        while (!pq.isEmpty()) {
            int[] curr = pq.poll();
            int u = curr[0], d = curr[1];
            if (d > dist.getOrDefault(u, Integer.MAX_VALUE)) continue;

            for (Link link : linkStateDatabase.getOrDefault(u, List.of())) {
                int v = link.neighborRouterId;
                int newDist = d + link.cost;
                if (newDist < dist.getOrDefault(v, Integer.MAX_VALUE)) {
                    dist.put(v, newDist);
                    nextHop.put(v, (u == myRouterId) ? v : nextHop.get(u));
                    pq.offer(new int[]{v, newDist});
                }
            }
        }
        return nextHop;  // routing table: destination → next hop
    }
}
```

OSPF runs Dijkstra's algorithm every time the link-state database changes (link up/down, cost change). For a network with N routers and E links, SPF calculation is O((N + E) log N) — the same complexity as textbook Dijkstra with a min-heap. Large OSPF deployments use areas to partition the graph and limit SPF computation scope.

### 20.2.5 BGP Routing → Bellman-Ford (Distance-Vector with Policy)

While OSPF is a link-state protocol using Dijkstra, BGP (Border Gateway Protocol) is a path-vector protocol that is fundamentally based on Bellman-Ford relaxation with policy overlays.

```
Bellman-Ford core equation:
    dist[v] = min(dist[v], dist[u] + weight(u, v))    for each edge (u, v)

BGP adaptation:
    route_to[prefix] = best_path(
        current_route,
        neighbor_route + local_policy_adjustments
    )

BGP "best path" selection (simplified):
    1. Highest LOCAL_PREF (local policy preference)
    2. Shortest AS_PATH length (fewest autonomous system hops)
    3. Lowest ORIGIN type (IGP < EGP < INCOMPLETE)
    4. Lowest MED (multi-exit discriminator)
    5. Prefer eBGP over iBGP
    6. Lowest IGP cost to next hop
    7. Lowest router ID (tiebreaker)
```

BGP converges slower than OSPF because it processes route updates iteratively (like Bellman-Ford) rather than computing from a global view (like Dijkstra). BGP's count-to-infinity problem is mitigated by path vectors — each route carries the full AS path, so a router can detect loops by checking if its own AS number appears in the path.

```java
// Conceptual BGP decision process — Bellman-Ford with policy
public class BgpDecision {
    static class BgpRoute {
        String prefix;          // e.g., "192.168.0.0/16"
        int localPref;          // local policy preference (higher = better)
        int[] asPath;           // sequence of AS numbers (shorter = better)
        String nextHop;
        int med;                // multi-exit discriminator
    }

    // BGP best path selection — this is the "relaxation" step
    public BgpRoute selectBest(BgpRoute current, BgpRoute candidate) {
        if (current == null) return candidate;

        // Step 1: highest LOCAL_PREF
        if (candidate.localPref != current.localPref)
            return candidate.localPref > current.localPref ? candidate : current;

        // Step 2: shortest AS_PATH
        if (candidate.asPath.length != current.asPath.length)
            return candidate.asPath.length < current.asPath.length ? candidate : current;

        // Step 3: lowest MED (if from same neighbor AS)
        if (candidate.med != current.med)
            return candidate.med < current.med ? candidate : current;

        return current;  // tiebreakers omitted for brevity
    }
}
```

### 20.2.6 Packet Queuing → PriorityQueue (QoS) and Ring Buffer

Network interfaces use multiple queue data structures simultaneously:

**QoS scheduling** uses a priority queue. When the outbound link is congested, packets are dequeued by priority class (voice > video > best-effort). This is exactly a `PriorityQueue<Packet>` where priority is the DSCP (Differentiated Services Code Point) value in the IP header.

**NIC ring buffers** are circular arrays shared between the NIC hardware and the OS kernel. The NIC writes incoming packets to the ring buffer using DMA; the kernel reads them. Two pointers (head and tail) track the producer/consumer positions.

```java
// NIC ring buffer — circular array, same concept as ArrayDeque
public class NicRingBuffer {
    private final PacketDescriptor[] ring;  // fixed-size power-of-2 array
    private int head;                        // NIC writes here (producer)
    private int tail;                        // Kernel reads here (consumer)
    private final int mask;                  // capacity - 1 for fast modulo

    public NicRingBuffer(int capacity) {
        // capacity MUST be power of 2 for bitwise modulo
        this.ring = new PacketDescriptor[capacity];
        this.mask = capacity - 1;
    }

    // NIC calls this via DMA:
    public boolean produce(PacketDescriptor desc) {
        int next = (head + 1) & mask;
        if (next == tail) return false;  // ring full — packet dropped
        ring[head] = desc;
        head = next;
        return true;
    }

    // Kernel NAPI poll calls this:
    public PacketDescriptor consume() {
        if (tail == head) return null;   // ring empty
        PacketDescriptor desc = ring[tail];
        tail = (tail + 1) & mask;
        return desc;
    }
}
```

The Linux kernel's `sk_buff` (socket buffer) structures are managed in linked lists for in-flight packets but use ring buffers at the NIC driver level. This dual strategy — ring buffer for hardware interaction, linked list for protocol processing — is a common pattern in systems programming.

### 20.2.7 Connection Tracking → HashMap<5-tuple, ConnectionState>

Stateful firewalls and NAT devices track every active connection using a hash table keyed by the 5-tuple: `{protocol, src_ip, src_port, dst_ip, dst_port}`.

```java
// Netfilter conntrack — simplified
public class ConnectionTracker {
    static class FiveTuple {
        int protocol;        // TCP=6, UDP=17
        int srcIp, dstIp;
        int srcPort, dstPort;

        // hashCode and equals based on all 5 fields
        @Override
        public int hashCode() {
            return protocol * 31 + srcIp * 37 + dstIp * 41 + srcPort * 43 + dstPort * 47;
        }
    }

    static class ConnState {
        enum State { NEW, ESTABLISHED, RELATED, INVALID, TIME_WAIT }
        State state;
        long lastSeenNanos;
        long timeoutNanos;
        // NAT translation info, packet counters, etc.
    }

    // The core data structure: a hash table of connections
    private final ConcurrentHashMap<FiveTuple, ConnState> conntrack = new ConcurrentHashMap<>();

    // On every packet:
    public boolean processPacket(Packet pkt) {
        FiveTuple tuple = extractTuple(pkt);
        ConnState state = conntrack.get(tuple);

        if (state == null) {
            // NEW connection — check firewall rules
            if (firewallAllows(pkt)) {
                conntrack.put(tuple, new ConnState(ConnState.State.NEW));
                return true;
            }
            return false;  // DROP
        }

        // ESTABLISHED — allow without rule check (stateful bypass)
        state.lastSeenNanos = System.nanoTime();
        return true;
    }
}
```

Linux's `nf_conntrack` uses a hash table with configurable size (`nf_conntrack_max`). At high connection rates, this hash table becomes the bottleneck. Tuning `nf_conntrack_buckets` is a direct application of hash table sizing — too small means long chains and O(n) worst case, too large wastes memory. The default is usually 16384 buckets; high-traffic systems may need 65536 or more.

### 20.2.8 Load Balancer → Consistent Hashing (TreeMap Ring)

Consistent hashing solves the problem of distributing requests across a dynamic set of servers such that adding or removing a server only remaps a small fraction of keys.

```java
public class ConsistentHashLoadBalancer {
    private final TreeMap<Integer, String> ring = new TreeMap<>();
    private final int virtualNodesPerServer = 150;
    private final MessageDigest md5;

    public ConsistentHashLoadBalancer() throws NoSuchAlgorithmException {
        this.md5 = MessageDigest.getInstance("MD5");
    }

    public void addServer(String server) {
        for (int i = 0; i < virtualNodesPerServer; i++) {
            int hash = hash(server + "#" + i);
            ring.put(hash, server);
        }
    }

    public void removeServer(String server) {
        for (int i = 0; i < virtualNodesPerServer; i++) {
            int hash = hash(server + "#" + i);
            ring.remove(hash);
        }
    }

    // Route a request to a server — O(log n) where n = total virtual nodes
    public String route(String key) {
        if (ring.isEmpty()) throw new IllegalStateException("No servers");
        int hash = hash(key);
        // Find the first server at or after this hash position on the ring
        Map.Entry<Integer, String> entry = ring.ceilingEntry(hash);
        if (entry == null) {
            entry = ring.firstEntry();  // wrap around the ring
        }
        return entry.getValue();
    }

    private int hash(String key) {
        md5.reset();
        byte[] digest = md5.digest(key.getBytes());
        return ((digest[0] & 0xFF) << 24) | ((digest[1] & 0xFF) << 16)
             | ((digest[2] & 0xFF) << 8)  | (digest[3] & 0xFF);
    }
}
```

The key insight: `TreeMap.ceilingEntry()` gives us O(log N) lookup on the ring. With 150 virtual nodes per server and 100 servers, the TreeMap has 15,000 entries — `ceilingEntry` takes about 14 comparisons. When a server dies, only the keys that mapped to its virtual nodes get reassigned — about 1/N of total keys.

This is used in DynamoDB (partition assignment), Cassandra (token ring), Memcached (libketama library), and many CDN systems.

---

## 20.3 Operating Systems — Where Data Structures Meet the Kernel

The Linux kernel is a masterclass in data structure selection. Every structure is chosen for its worst-case complexity guarantees, cache behavior, and concurrency characteristics. Let us trace them.

### 20.3.1 CFS Scheduler → Red-Black Tree (TreeMap) Keyed by vruntime

The Completely Fair Scheduler (CFS) is the default Linux process scheduler. Its goal is fairness: every process should receive an equal share of CPU time, weighted by priority. The key data structure is a Red-Black tree of runnable tasks, keyed by their virtual runtime (vruntime).

```
CFS Red-Black Tree:
                        [task C: vruntime=50]  (black, root)
                       /                      \
          [task A: vruntime=30] (red)    [task E: vruntime=80] (red)
                /       \                     /        \
    [task B: 20] (blk)  [task D: 40] (blk) [task F: 70] (blk)  [task G: 90] (blk)

    Next task to run: leftmost node = task B (vruntime=20) — O(log n) in theory,
    but Linux caches the leftmost node, so pick-next is O(1).

    After task B runs for its time slice:
      - Remove B from tree: O(log n)
      - Update B's vruntime: vruntime += delta_exec * (NICE_0_WEIGHT / task_weight)
      - Reinsert B: O(log n)

    A higher-priority task (lower nice value) has a larger task_weight,
    so its vruntime increases SLOWER — it gets picked more often.
```

```java
// CFS scheduler in Java terms (conceptual)
public class CfsScheduler {
    static class Task implements Comparable<Task> {
        int pid;
        long vruntime;          // virtual runtime in nanoseconds
        int niceValue;          // -20 (highest priority) to +19 (lowest)
        long weight;            // derived from nice value via prio_to_weight table

        @Override
        public int compareTo(Task other) {
            // Primary: sort by vruntime (lower = should run next)
            int cmp = Long.compare(this.vruntime, other.vruntime);
            if (cmp != 0) return cmp;
            return Integer.compare(this.pid, other.pid);  // tiebreaker
        }
    }

    // This IS a TreeMap<vruntime, Task> — a Red-Black tree
    private final TreeMap<Task, Task> rbTree = new TreeMap<>();
    private Task cachedLeftmost;  // O(1) access to next task

    // Pick next task to run: O(1) due to cached leftmost
    public Task pickNext() {
        return cachedLeftmost;  // Linux caches rb_leftmost
    }

    // Put a task back after it used its time slice
    public void putPrev(Task task, long deltaExecNanos) {
        rbTree.remove(task);  // O(log n) removal

        // Update vruntime: higher weight = vruntime grows slower = more CPU time
        // delta_vruntime = delta_exec * (NICE_0_WEIGHT / task.weight)
        task.vruntime += deltaExecNanos * 1024 / task.weight;

        rbTree.put(task, task);  // O(log n) reinsertion
        cachedLeftmost = rbTree.firstKey();  // update cache
    }

    // Enqueue a new/woken task
    public void enqueue(Task task) {
        // Set vruntime to max(task.vruntime, min_vruntime) to prevent starvation
        // min_vruntime = leftmost task's vruntime
        if (cachedLeftmost != null) {
            task.vruntime = Math.max(task.vruntime, cachedLeftmost.vruntime);
        }
        rbTree.put(task, task);
        if (cachedLeftmost == null || task.compareTo(cachedLeftmost) < 0) {
            cachedLeftmost = task;
        }
    }
}
```

Why a Red-Black tree? Because CFS needs:
- O(log n) insertion when a task becomes runnable
- O(log n) removal when a task is selected to run
- O(1) find-minimum (leftmost = lowest vruntime = most deserving of CPU)
- Guaranteed balance (no degenerate cases — the kernel cannot afford O(n) operations)

An AVL tree would also work but requires more rotations on insert/delete. The kernel chose Red-Black trees because they guarantee at most 2 rotations per insertion, minimizing pointer updates in cache-sensitive kernel code.

### 20.3.2 Page Replacement → LRU / Clock / LFU

When physical memory is full and a new page must be loaded, the OS must choose a page to evict. This is the cache eviction problem, and different algorithms correspond directly to different data structures.

**LRU (Least Recently Used) → LinkedHashMap**

```java
// OS page replacement using LRU — identical to LinkedHashMap(capacity, 0.75f, true)
public class LruPageCache {
    // Doubly-linked list node embedded in hash table entry
    static class Page {
        int pageNumber;
        byte[] data;
        Page prev, next;  // LRU list pointers
    }

    private final Map<Integer, Page> pageTable = new HashMap<>(); // O(1) lookup
    private final Page head = new Page();  // MRU end (most recently used)
    private final Page tail = new Page();  // LRU end (least recently used)
    private final int capacity;

    public LruPageCache(int capacity) {
        this.capacity = capacity;
        head.next = tail;
        tail.prev = head;
    }

    // Page access: move to MRU position — O(1)
    public byte[] accessPage(int pageNum) {
        Page page = pageTable.get(pageNum);
        if (page != null) {
            // Hit: unlink and move to head (MRU)
            unlink(page);
            linkAfterHead(page);
            return page.data;
        }
        // Miss: load from disk, evict if full
        if (pageTable.size() >= capacity) {
            Page victim = tail.prev;    // LRU page
            unlink(victim);
            pageTable.remove(victim.pageNumber);
        }
        Page newPage = loadFromDisk(pageNum);
        pageTable.put(pageNum, newPage);
        linkAfterHead(newPage);
        return newPage.data;
    }
}
```

**Clock Algorithm → Circular Array with Reference Bit**

Linux does not use pure LRU (too expensive to maintain strict ordering for all pages). Instead it uses a Clock-like approximation with two lists: active and inactive. Each page has a reference bit.

```java
// Clock page replacement — circular array scan
public class ClockPageReplacement {
    private final int[] pages;         // page numbers in frame slots
    private final boolean[] referenced; // reference (accessed) bit per slot
    private int clockHand;             // current position in circular scan
    private final int numFrames;

    public ClockPageReplacement(int numFrames) {
        this.numFrames = numFrames;
        this.pages = new int[numFrames];
        this.referenced = new boolean[numFrames];
        Arrays.fill(pages, -1);
    }

    public int evictAndReplace(int newPage) {
        while (true) {
            if (!referenced[clockHand]) {
                // Found victim: unreferenced page
                int victim = pages[clockHand];
                pages[clockHand] = newPage;
                referenced[clockHand] = true;
                clockHand = (clockHand + 1) % numFrames;
                return victim;
            }
            // Give second chance: clear reference bit, advance hand
            referenced[clockHand] = false;
            clockHand = (clockHand + 1) % numFrames;
        }
    }
}
```

### 20.3.3 Buddy Allocator → Binary Tree of Power-of-2 Blocks

The Linux buddy allocator manages physical memory pages. Memory is divided into blocks of power-of-2 pages (1, 2, 4, 8, ..., 1024 pages). When a request for n pages arrives, it finds the smallest power-of-2 block that fits, splitting larger blocks as needed.

```
Buddy allocator — binary tree structure:
                        [1024 pages]
                       /            \
              [512 pages]        [512 pages]
              /         \        /         \
        [256 pages] [256 pages] [256] [256]
        ...

Free lists (one per order):
    Order 0 (1 page):   ■ → ■ → ■ → null
    Order 1 (2 pages):  ■ → ■ → null
    Order 2 (4 pages):  ■ → null
    ...
    Order 10 (1024 pages): ■ → null
```

```java
// Simplified buddy allocator
public class BuddyAllocator {
    private static final int MAX_ORDER = 10; // 2^10 = 1024 pages max block
    @SuppressWarnings("unchecked")
    private final LinkedList<Integer>[] freeLists = new LinkedList[MAX_ORDER + 1];

    public BuddyAllocator(int totalPages) {
        for (int i = 0; i <= MAX_ORDER; i++) {
            freeLists[i] = new LinkedList<>();
        }
        // Initially, all memory is one large block
        freeLists[MAX_ORDER].add(0);
    }

    // Allocate 2^order pages
    public int allocate(int order) {
        // Find the smallest available block >= requested order
        for (int i = order; i <= MAX_ORDER; i++) {
            if (!freeLists[i].isEmpty()) {
                int block = freeLists[i].removeFirst();

                // Split larger blocks down to requested size
                while (i > order) {
                    i--;
                    int buddy = block + (1 << i);  // buddy's address
                    freeLists[i].add(buddy);         // put buddy on free list
                }
                return block;
            }
        }
        return -1; // out of memory
    }

    // Free a block — merge with buddy if buddy is also free
    public void free(int block, int order) {
        while (order < MAX_ORDER) {
            int buddy = block ^ (1 << order);  // XOR gives buddy address

            if (freeLists[order].remove((Integer) buddy)) {
                // Buddy is free — merge
                block = Math.min(block, buddy);
                order++;
            } else {
                break;  // buddy is allocated, cannot merge
            }
        }
        freeLists[order].add(block);
    }
}
```

The buddy system is a binary tree where each node represents a memory block, and its two children represent the two halves after splitting. The XOR trick for finding the buddy address (`block ^ (1 << order)`) is one of the most elegant bit manipulation tricks in systems programming.

### 20.3.4 Slab Allocator → HashMap<size, FreeList>

The slab allocator sits on top of the buddy allocator to efficiently allocate small, fixed-size objects (like `struct task_struct`, `struct inode`). It maintains per-size-class free lists.

```java
// Slab allocator concept — HashMap<objectSize, FreeList>
public class SlabAllocator {
    static class Slab {
        byte[] memory;          // one or more pages from buddy allocator
        int objectSize;
        int objectCount;
        Deque<Integer> freeList; // offsets of free slots

        Slab(int objectSize, int pageCount) {
            this.objectSize = objectSize;
            this.memory = new byte[pageCount * 4096];
            this.objectCount = memory.length / objectSize;
            this.freeList = new ArrayDeque<>();
            for (int i = 0; i < objectCount; i++) {
                freeList.push(i * objectSize);
            }
        }

        int allocate() {
            return freeList.isEmpty() ? -1 : freeList.pop();
        }

        void free(int offset) {
            freeList.push(offset);
        }
    }

    // Per-size-class slab caches — like HashMap<size, List<Slab>>
    private final Map<Integer, List<Slab>> caches = new HashMap<>();

    public long allocate(int size) {
        List<Slab> slabs = caches.computeIfAbsent(size, s -> new ArrayList<>());
        for (Slab slab : slabs) {
            int offset = slab.allocate();
            if (offset >= 0) return offset;
        }
        // All slabs full — allocate new slab from buddy allocator
        Slab newSlab = new Slab(size, 1);
        slabs.add(newSlab);
        return newSlab.allocate();
    }
}
```

Netty's `PooledByteBufAllocator` is a Java implementation of slab + buddy allocation for network buffers. It was directly inspired by the Linux kernel's approach.

### 20.3.5 Page Table → Multi-Level Radix Tree, TLB = Hardware Hash Table

On x86_64, the page table is a 4-level radix tree that translates 48-bit virtual addresses to physical addresses.

```
Virtual address (48 bits):
┌──────────┬──────────┬──────────┬──────────┬──────────────┐
│ PML4 (9) │ PDPT (9) │  PD (9)  │  PT (9)  │ Offset (12)  │
└──────────┴──────────┴──────────┴──────────┴──────────────┘

Page table walk (4-level radix tree):
    PML4 Table (512 entries)
        ↓ index = bits[47:39]
    PDPT Table (512 entries)
        ↓ index = bits[38:30]
    Page Directory (512 entries)
        ↓ index = bits[29:21]
    Page Table (512 entries)
        ↓ index = bits[20:12]
    Physical Frame + Offset[11:0]

    Total: 4 memory accesses per translation (without TLB)
```

This is a radix tree (trie) where each level uses 9 bits of the virtual address as the index. The TLB (Translation Lookaside Buffer) is a hardware hash table that caches recent translations — typically 64-1536 entries, fully associative or set-associative, with ~1ns lookup latency. A TLB miss costs 10-30ns (page table walk through 4 levels of memory).

```java
// Multi-level page table — conceptual Java implementation
public class PageTable {
    private static final int LEVELS = 4;
    private static final int BITS_PER_LEVEL = 9;
    private static final int ENTRIES_PER_TABLE = 1 << BITS_PER_LEVEL; // 512

    static class PageTableEntry {
        long physicalAddress;    // if leaf
        PageTableEntry[] next;   // if non-leaf (512 entries)
        boolean present, writable, userAccessible;
    }

    private final PageTableEntry root = new PageTableEntry();

    public long translate(long virtualAddress) {
        PageTableEntry entry = root;
        for (int level = LEVELS - 1; level >= 0; level--) {
            int index = (int)((virtualAddress >>> (12 + level * BITS_PER_LEVEL))
                              & (ENTRIES_PER_TABLE - 1));
            if (entry.next == null || entry.next[index] == null || !entry.next[index].present) {
                throw new RuntimeException("Page fault");  // OS handles this
            }
            entry = entry.next[index];
        }
        long offset = virtualAddress & 0xFFF;  // bottom 12 bits
        return entry.physicalAddress + offset;
    }
}
```

### 20.3.6 Process Tree → Tree (fork/exec Hierarchy)

Every process in Unix/Linux has a parent. The init process (PID 1) is the root. `fork()` creates a child. This forms a tree:

```
init (PID 1)
├── sshd (PID 100)
│   ├── sshd (PID 200)  -- forked for user session
│   │   └── bash (PID 201)
│   │       ├── vim (PID 300)
│   │       └── java (PID 301)
│   │           ├── GC Thread 0 (TID 302)
│   │           ├── GC Thread 1 (TID 303)
│   │           └── Worker Thread 0 (TID 304)
│   └── sshd (PID 210)
│       └── bash (PID 211)
├── systemd-journald (PID 50)
└── cron (PID 60)
```

`pstree` visualizes this tree. `kill -9 -PGID` kills a process group (subtree). When a parent dies, children are re-parented to init (PID 1). This is a rooted tree with explicit parent pointers — the same structure as a tree with parent references that we use in LCA (Lowest Common Ancestor) problems.

### 20.3.7 Pipe/Socket Buffers → Circular Buffer (ArrayDeque)

Unix pipes and TCP socket buffers use circular (ring) buffers internally. A pipe has a fixed-size kernel buffer (default 64KB on Linux) that acts as a bounded producer-consumer queue.

```java
// Kernel pipe buffer — circular buffer
public class PipeBuffer {
    private final byte[] buffer;
    private int readPos;
    private int writePos;
    private int count;
    private final int capacity;

    public PipeBuffer(int capacity) {
        this.buffer = new byte[capacity]; // default 65536 (16 pages)
        this.capacity = capacity;
    }

    // Writer (producer) — blocks if full
    public synchronized int write(byte[] data, int off, int len) throws InterruptedException {
        while (count == capacity) wait();  // buffer full — block writer

        int written = 0;
        while (written < len && count < capacity) {
            buffer[writePos] = data[off + written];
            writePos = (writePos + 1) % capacity;  // circular advance
            count++;
            written++;
        }
        notifyAll();  // wake blocked readers
        return written;
    }

    // Reader (consumer) — blocks if empty
    public synchronized int read(byte[] dest, int off, int len) throws InterruptedException {
        while (count == 0) wait();  // buffer empty — block reader

        int bytesRead = 0;
        while (bytesRead < len && count > 0) {
            dest[off + bytesRead] = buffer[readPos];
            readPos = (readPos + 1) % capacity;
            count--;
            bytesRead++;
        }
        notifyAll();  // wake blocked writers
        return bytesRead;
    }
}
```

This is identical to `ArrayBlockingQueue` in the JDK — both use a fixed-size circular array with separate read and write pointers.

### 20.3.8 Epoll → Red-Black Tree (fd tracking) + Linked List (ready list)

`epoll` is Linux's scalable I/O event notification mechanism. It uses two data structures:

1. **Red-Black tree**: stores all monitored file descriptors. `epoll_ctl(EPOLL_CTL_ADD)` inserts into the tree, `epoll_ctl(EPOLL_CTL_DEL)` removes. O(log n) per operation.

2. **Linked list**: the "ready list" of file descriptors that have pending events. When a socket receives data, the kernel appends its entry to the ready list. `epoll_wait()` returns entries from this list.

```
Epoll internal structure:
┌──────────────────────────────────────────────────────────────────┐
│                     struct eventpoll                              │
│                                                                  │
│  Red-Black Tree (rbr):              Ready List (rdllist):        │
│  All monitored fds                  Fds with pending events      │
│                                                                  │
│         [fd=7]                       fd=3 → fd=9 → fd=12        │
│        /      \                                                  │
│     [fd=3]   [fd=12]                When epoll_wait() returns,   │
│    /    \       \                   it copies from ready list     │
│  [fd=1] [fd=5] [fd=15]             to user-space buffer.        │
│               \                                                  │
│              [fd=9]                                              │
└──────────────────────────────────────────────────────────────────┘
```

```java
// Epoll conceptual implementation
public class Epoll {
    // Red-Black tree for all monitored fds — O(log n) add/remove
    private final TreeMap<Integer, EpollEvent> rbTree = new TreeMap<>();

    // Ready list — linked list of fds with pending events
    private final LinkedList<EpollEvent> readyList = new LinkedList<>();

    // epoll_ctl(EPOLL_CTL_ADD, fd, events)
    public void add(int fd, int events) {
        EpollEvent event = new EpollEvent(fd, events);
        rbTree.put(fd, event);  // O(log n) insertion into RB-tree
    }

    // epoll_ctl(EPOLL_CTL_DEL, fd)
    public void remove(int fd) {
        rbTree.remove(fd);  // O(log n) removal from RB-tree
    }

    // Called by kernel when fd has an event (e.g., data arrived on socket)
    public void notifyEvent(int fd) {
        EpollEvent event = rbTree.get(fd);  // O(log n) lookup
        if (event != null && !event.inReadyList) {
            readyList.add(event);           // O(1) append to ready list
            event.inReadyList = true;
        }
    }

    // epoll_wait() — returns ready events, blocks if none
    public List<EpollEvent> wait(int maxEvents, long timeoutMs) throws InterruptedException {
        // Wait until readyList is non-empty or timeout
        synchronized (readyList) {
            while (readyList.isEmpty()) {
                readyList.wait(timeoutMs);
            }
        }
        List<EpollEvent> result = new ArrayList<>();
        while (!readyList.isEmpty() && result.size() < maxEvents) {
            EpollEvent event = readyList.removeFirst();
            event.inReadyList = false;
            result.add(event);
        }
        return result;
    }
}
```

This is why `epoll` scales to millions of file descriptors: adding/removing fds is O(log n), and returning ready events is O(number of ready events), not O(total monitored events). Compare with `select()`/`poll()` which scan all monitored fds on every call — O(n).

---

## 20.4 Databases — Where Data Structures Store Your Business

Databases are the richest domain for data structure application. Every layer — storage engine, buffer pool, query optimizer, transaction manager — is built on structures we study.

### 20.4.1 B+ Tree Indexes → InnoDB Clustered/Secondary Index

InnoDB's storage engine is fundamentally a B+ tree. Every table is stored as a clustered B+ tree indexed by the primary key. Every secondary index is another B+ tree where leaf nodes contain the primary key (not the row data).

```
InnoDB Clustered Index (B+ Tree):
                              [30 | 60]                    ← internal node (keys only)
                             /    |     \
                   [10|20|30]  [40|50|60]  [70|80|90]      ← internal nodes
                  /  |  |   \   / | | \    / | |  \
    Leaf:  [1-10] [11-20] [21-30] [31-40] [41-50] ...     ← leaf nodes (actual row data)
                 ↔        ↔        ↔        ↔              ← doubly linked for range scans
                 
    Leaf nodes store: primary_key | trx_id | rollback_ptr | col1 | col2 | ...
    Non-leaf nodes store: primary_key | child_page_pointer

    Page size: 16KB (default)
    Fanout: ~500-1000 keys per internal node
    A 3-level B+ tree can index ~500M rows:
      Level 0 (root): 1 page, ~500 keys
      Level 1: ~500 pages, ~250,000 keys
      Level 2: ~250,000 pages, ~125,000,000 keys
      Level 3 (leaf): ~125,000,000 pages with row data

    Point lookup: 3-4 page reads (root usually cached → 2-3 disk I/Os)
    Range scan: find start key in B+ tree, then follow leaf-level linked list
```

```java
// Simplified B+ tree node — shows why branching factor matters
public class BPlusTreePage {
    // 16KB InnoDB page layout (simplified)
    static final int PAGE_SIZE = 16384;
    static final int HEADER_SIZE = 120;      // page header, checksum, LSN, etc.
    static final int KEY_SIZE = 8;           // 8-byte BIGINT primary key
    static final int CHILD_PTR_SIZE = 4;     // page number pointer
    static final int ROW_SIZE = 200;         // average row size

    // Internal node: [key|ptr|key|ptr|...key|ptr]
    // Fanout = (PAGE_SIZE - HEADER_SIZE) / (KEY_SIZE + CHILD_PTR_SIZE)
    //        = (16384 - 120) / (8 + 4) = 1355 children per node

    // Leaf node: [key|row_data|key|row_data|...]
    // Rows per leaf = (PAGE_SIZE - HEADER_SIZE) / (KEY_SIZE + ROW_SIZE)
    //              = (16384 - 120) / (8 + 200) = ~78 rows per leaf page

    // For 100 million rows:
    // Leaf pages: 100M / 78 = ~1.28M pages (~20 GB on disk)
    // Level 1: 1.28M / 1355 = ~945 pages
    // Level 2: 945 / 1355 = 1 page (root)
    // Tree height: 3 levels → max 3 page reads for any point lookup
}
```

**Secondary index** is a separate B+ tree:
```
Secondary Index on (email):
    Leaf nodes store: email_value | primary_key
    NOT the full row — just the primary key

    Query: SELECT * FROM users WHERE email = 'foo@bar.com'
    Step 1: Search secondary index B+ tree for 'foo@bar.com' → find primary_key = 42
    Step 2: Search clustered index B+ tree for primary_key = 42 → find full row
    This second lookup is called a "bookmark lookup" or "index lookup"

    This is why covering indexes avoid the second lookup:
    CREATE INDEX idx ON users(email) INCLUDE (name, age);
    Now the secondary index leaf contains name and age too — no bookmark lookup needed.
```

### 20.4.2 LSM Tree → LevelDB/RocksDB/Cassandra

LSM (Log-Structured Merge) trees optimize for write-heavy workloads by converting random writes into sequential writes.

```
LSM Tree Architecture:
                              ┌─────────────────┐
    Write path:               │    MemTable      │  ← in-memory TreeMap/SkipList
    PUT(key, value) ──────→   │  (sorted by key) │     (typically Red-Black tree or skip list)
                              │    ~64 MB         │
                              └────────┬──────────┘
                                       │ flush when full
                                       ▼
                              ┌─────────────────┐
    Level 0 (L0):            │ SSTable SSTable  │  ← sorted, immutable files on disk
                              │ SSTable SSTable  │     may overlap in key range
                              └────────┬──────────┘
                                       │ compaction (merge sort!)
                                       ▼
                              ┌─────────────────┐
    Level 1 (L1):            │    SSTables      │  ← sorted, non-overlapping
                              │  (total ~640 MB) │     each file covers a key range
                              └────────┬──────────┘
                                       │ compaction
                                       ▼
                              ┌─────────────────┐
    Level 2 (L2):            │    SSTables      │  ← sorted, non-overlapping
                              │  (total ~6.4 GB) │     10x larger than L1
                              └────────┬──────────┘
                                       │ compaction
                                       ▼
                              ...and so on (level ratio typically 10)
```

```java
// LSM tree — memtable IS a TreeMap, SSTable IS a sorted array
public class SimpleLsmTree {
    // MemTable: in-memory sorted structure (TreeMap = Red-Black tree)
    private TreeMap<String, String> memTable = new TreeMap<>();
    private static final int MEMTABLE_THRESHOLD = 65536;

    // Immutable SSTables on disk — each is a sorted array of key-value pairs
    private final List<SSTable> levels = new ArrayList<>();

    public void put(String key, String value) {
        memTable.put(key, value);

        if (memTable.size() >= MEMTABLE_THRESHOLD) {
            flush();  // write memtable to disk as a sorted SSTable
        }
    }

    public String get(String key) {
        // 1. Check memtable first (most recent writes)
        String value = memTable.get(key);
        if (value != null) return value;

        // 2. Check SSTables from newest to oldest
        //    Each SSTable is a sorted array → binary search → O(log n) per table
        for (int i = levels.size() - 1; i >= 0; i--) {
            value = levels.get(i).binarySearch(key);
            if (value != null) return value;
        }
        return null;  // key not found in any level
    }

    private void flush() {
        // Convert TreeMap to sorted array (SSTable) and write to disk
        SSTable sst = SSTable.fromSortedMap(memTable);
        levels.add(sst);
        memTable = new TreeMap<>();  // new empty memtable

        // Trigger compaction if too many SSTables at a level
        compactIfNeeded();
    }

    private void compactIfNeeded() {
        // Compaction = MERGE SORT of overlapping SSTables
        // This is literally the merge step of merge sort:
        // take two sorted files, produce one sorted file, discard duplicates (keep newest)
    }
}
```

Key insight: **Compaction is merge sort.** When two SSTables overlap in key range, they are merged exactly like the merge step of merge sort — two sorted arrays combined into one sorted array. This is why understanding merge sort matters beyond interview questions.

**Bloom filters** are critical for LSM read performance. Without them, every read might probe every SSTable. With a Bloom filter per SSTable, negative lookups (key not present) are filtered with zero disk I/O.

### 20.4.3 WAL (Write-Ahead Log) → Append-Only Log

Every serious database uses a Write-Ahead Log for crash recovery. Before any data page is modified, the change is first written to a sequential, append-only log.

```java
// WAL — append-only log for crash recovery
public class WriteAheadLog {
    // The WAL is fundamentally an append-only ArrayList<LogRecord>
    // written sequentially to disk (fsync'd for durability)
    private final RandomAccessFile logFile;
    private long lsn = 0;  // Log Sequence Number — monotonically increasing

    static class LogRecord {
        long lsn;
        long transactionId;
        enum Type { BEGIN, UPDATE, COMMIT, ABORT, CHECKPOINT }
        Type type;
        int pageId;
        byte[] beforeImage;  // for undo
        byte[] afterImage;   // for redo
    }

    // Every write goes to WAL FIRST:
    public long appendUpdate(long txId, int pageId, byte[] before, byte[] after)
            throws IOException {
        LogRecord record = new LogRecord();
        record.lsn = lsn++;
        record.transactionId = txId;
        record.type = LogRecord.Type.UPDATE;
        record.pageId = pageId;
        record.beforeImage = before;
        record.afterImage = after;

        // Serialize and write to log file
        byte[] serialized = serialize(record);
        logFile.write(serialized);
        logFile.getFD().sync();  // fsync — guarantee it is on disk
        return record.lsn;
    }

    // ARIES recovery protocol:
    // 1. Analysis pass: scan log forward from last checkpoint, determine dirty pages and active txns
    // 2. Redo pass: replay ALL updates (for committed AND uncommitted txns)
    // 3. Undo pass: rollback uncommitted transactions using beforeImage
    //
    // This is scan-forward (redo) + scan-backward (undo) on a sequential log.
}
```

### 20.4.4 Buffer Pool → LRU Page Cache (LinkedHashMap)

The database buffer pool is a fixed-size cache of disk pages in memory. When a page is accessed, it is loaded into the buffer pool. When the pool is full, a page must be evicted — typically using a variant of LRU.

```java
// InnoDB-style buffer pool — LRU with young/old subdivision
public class BufferPool {
    private final int capacity;             // number of page frames
    private final Map<Integer, BufferPage> pageTable = new HashMap<>();
    private final LinkedList<BufferPage> lruList = new LinkedList<>();

    // InnoDB splits the LRU list into "young" (hot, 5/8) and "old" (cold, 3/8)
    // New pages enter at the "old" head, not the "young" head.
    // This prevents a full table scan from flushing the entire buffer pool.
    //
    // Pages in the "old" segment are promoted to "young" only after
    // a configurable delay (innodb_old_blocks_time = 1000ms default).
    // This means a sequential scan touches each page once, it sits in "old"
    // briefly, and gets evicted without disturbing the "young" pages.

    private static final double YOUNG_RATIO = 5.0 / 8.0;
    private int youngSize() { return (int)(capacity * YOUNG_RATIO); }

    public BufferPage getPage(int pageId) {
        BufferPage page = pageTable.get(pageId);
        if (page != null) {
            // Buffer pool hit — move to young head (like LinkedHashMap access-order)
            lruList.remove(page);
            lruList.addFirst(page);
            return page;
        }

        // Buffer pool miss — load from disk
        if (pageTable.size() >= capacity) {
            BufferPage victim = lruList.removeLast();  // evict LRU page
            if (victim.isDirty()) {
                flushToDisk(victim);  // write dirty page to disk before evicting
            }
            pageTable.remove(victim.pageId);
        }

        BufferPage newPage = loadFromDisk(pageId);
        // Insert at midpoint (old segment head), not at front
        int midpoint = youngSize();
        lruList.add(midpoint, newPage);
        pageTable.put(pageId, newPage);
        return newPage;
    }
}
```

### 20.4.5 Query Plan Cache → HashMap<fingerprint, Plan>

Databases cache compiled query plans to avoid re-optimization on every execution. The key is a "query fingerprint" — the SQL text with literal values replaced by placeholders.

```java
// Query plan cache — HashMap with fingerprint key
public class QueryPlanCache {
    static class QueryPlan {
        String sql;
        Object executionTree;    // join order, index choice, etc.
        long estimatedCost;
        long lastUsed;
    }

    // Cache: fingerprint → compiled plan
    private final LinkedHashMap<String, QueryPlan> cache;

    public QueryPlanCache(int maxEntries) {
        // LRU eviction using LinkedHashMap(capacity, loadFactor, accessOrder=true)
        this.cache = new LinkedHashMap<>(maxEntries, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, QueryPlan> eldest) {
                return size() > maxEntries;
            }
        };
    }

    public QueryPlan getOrCompile(String sql) {
        String fingerprint = normalize(sql);
        // e.g., "SELECT * FROM users WHERE id = 42" → "SELECT * FROM users WHERE id = ?"
        QueryPlan plan = cache.get(fingerprint);
        if (plan != null) return plan;  // cache hit

        plan = optimizer.compile(sql);  // expensive: O(n!) join order combinations → DP optimization
        cache.put(fingerprint, plan);
        return plan;
    }

    private String normalize(String sql) {
        // Replace numeric/string literals with placeholders
        return sql.replaceAll("\\d+", "?")
                  .replaceAll("'[^']*'", "?");
    }
}
```

### 20.4.6 Hash Join → HashMap<joinKey, rows>

Hash join is the standard algorithm for equi-joins in databases when neither table is sorted on the join key and the smaller table fits in memory.

```java
// Hash join — BUILD phase creates a HashMap, PROBE phase looks up each row
public class HashJoin {

    // SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id
    public List<ResultRow> hashJoin(List<Row> smallTable, List<Row> largeTable,
                                     String joinColumn) {
        // BUILD phase: load smaller table into HashMap
        // This is exactly HashMap<joinKey, List<Row>>
        Map<Object, List<Row>> hashTable = new HashMap<>();
        for (Row row : smallTable) {
            Object key = row.get(joinColumn);
            hashTable.computeIfAbsent(key, k -> new ArrayList<>()).add(row);
        }

        // PROBE phase: scan larger table, look up each key in hash table
        List<ResultRow> result = new ArrayList<>();
        for (Row row : largeTable) {
            Object key = row.get(joinColumn);
            List<Row> matches = hashTable.get(key);  // O(1) lookup
            if (matches != null) {
                for (Row match : matches) {
                    result.add(combine(row, match));
                }
            }
        }
        return result;
        // Total: O(small + large) time, O(small) space
        // This is why the optimizer always builds on the smaller table.
    }
}
```

### 20.4.7 Sort-Merge Join → Merge of Two Sorted Arrays

When both tables are already sorted on the join key (e.g., both have B+ tree indexes on the join column), the merge join is optimal — it merges two sorted sequences, exactly like the merge step of merge sort.

```java
// Sort-merge join — the merge step of merge sort applied to two tables
public class SortMergeJoin {

    public List<ResultRow> mergeJoin(Iterator<Row> sortedLeft,
                                      Iterator<Row> sortedRight,
                                      String joinColumn) {
        List<ResultRow> result = new ArrayList<>();
        Row left = sortedLeft.hasNext() ? sortedLeft.next() : null;
        Row right = sortedRight.hasNext() ? sortedRight.next() : null;

        while (left != null && right != null) {
            int cmp = compare(left.get(joinColumn), right.get(joinColumn));
            if (cmp < 0) {
                left = sortedLeft.hasNext() ? sortedLeft.next() : null;
            } else if (cmp > 0) {
                right = sortedRight.hasNext() ? sortedRight.next() : null;
            } else {
                // Keys match — collect all rows with this key from both sides
                // (handle duplicates)
                result.add(combine(left, right));
                // advance appropriately for duplicates (omitted for brevity)
                right = sortedRight.hasNext() ? sortedRight.next() : null;
            }
        }
        return result;
        // O(left + right) time if both already sorted (no extra space)
    }
}
```

### 20.4.8 Bloom Filter → Cassandra SSTable, HBase Block Filter

A Bloom filter is a probabilistic data structure that answers "is element X in set S?" with:
- **Yes**: X might be in S (possible false positive)
- **No**: X is definitely not in S (no false negatives)

In Cassandra, each SSTable has an associated Bloom filter. When a read request arrives, Cassandra checks the Bloom filter first. If it says "no," the SSTable is skipped entirely — no disk I/O. With a false positive rate of 1%, 99% of unnecessary disk reads are eliminated.

```java
// Bloom filter — used per SSTable in Cassandra/HBase/RocksDB
public class BloomFilter {
    private final BitSet bits;
    private final int numHashFunctions;
    private final int numBits;

    // Optimal parameters:
    // numBits = -(n * ln(p)) / (ln(2))^2    where n = expected elements, p = false positive rate
    // numHashFunctions = (numBits / n) * ln(2)
    public BloomFilter(int expectedElements, double falsePositiveRate) {
        this.numBits = optimalNumBits(expectedElements, falsePositiveRate);
        this.numHashFunctions = optimalNumHashes(numBits, expectedElements);
        this.bits = new BitSet(numBits);
    }

    public void add(byte[] key) {
        for (int i = 0; i < numHashFunctions; i++) {
            int hash = hash(key, i) % numBits;
            bits.set(Math.abs(hash));
        }
    }

    public boolean mightContain(byte[] key) {
        for (int i = 0; i < numHashFunctions; i++) {
            int hash = hash(key, i) % numBits;
            if (!bits.get(Math.abs(hash))) return false;  // definitely not present
        }
        return true;  // probably present (could be false positive)
    }

    // Cassandra usage:
    // Each SSTable has a BloomFilter built during compaction.
    // On read: check BloomFilter → if false, skip SSTable entirely.
    // Memory cost: ~10 bits per key (for 1% false positive rate).
    // For 10 million keys: ~12.5 MB per SSTable Bloom filter.
}
```

### 20.4.9 Bitmap Index → Low-Cardinality Column Indexing (BitSet per Value)

For columns with few distinct values (gender, status, country), a bitmap index stores a `BitSet` for each distinct value. The i-th bit is set if row i has that value.

```java
// Bitmap index for low-cardinality columns
public class BitmapIndex {
    // Column: status = {ACTIVE, INACTIVE, SUSPENDED}
    // For 10 million rows: 3 BitSets, each 10M bits = ~1.25 MB each
    private final Map<String, BitSet> bitmaps = new HashMap<>();
    private int rowCount = 0;

    public void addRow(int rowId, String value) {
        bitmaps.computeIfAbsent(value, v -> new BitSet()).set(rowId);
        rowCount = Math.max(rowCount, rowId + 1);
    }

    // WHERE status = 'ACTIVE' AND country = 'US'
    // → bitmaps.get("ACTIVE") AND bitmaps.get("US")
    // → result BitSet tells you which row IDs match
    public BitSet query(String column1Value, String column2Value,
                         BitmapIndex otherIndex) {
        BitSet result = (BitSet) bitmaps.get(column1Value).clone();
        result.and(otherIndex.bitmaps.get(column2Value));
        return result;  // bitwise AND — O(n/64) where n = row count
    }

    // COUNT(WHERE status = 'ACTIVE') — just count set bits
    public int count(String value) {
        return bitmaps.getOrDefault(value, new BitSet()).cardinality();
        // BitSet.cardinality() uses Long.bitCount() — hardware POPCNT instruction
    }
}
```

---

## 20.5 Distributed Systems — Where Algorithms Scale Horizontally

Distributed systems are where data structures meet network partitions, eventual consistency, and replication. Every core distributed algorithm maps to a DSA concept.

### 20.5.1 Consistent Hashing → DynamoDB, Cassandra, Memcached

We covered the implementation in Section 20.2.8. Here is how production systems use it:

**DynamoDB**: Partitions a table's key space using consistent hashing. Each partition is assigned to a range on the hash ring. When a partition gets too hot, it is split — the ring is subdivided. DynamoDB also uses "jump consistent hashing" for more uniform distribution.

**Cassandra token ring**: Each node owns a range of tokens on a 2^64 ring. The partition key is hashed (Murmur3) to a 64-bit token. `SELECT * FROM users WHERE user_id = 'alice'` → hash('alice') → token 23847... → find the node owning that token range. Replication factor N means the N nodes clockwise from the token on the ring store replicas.

```java
// Cassandra-style token ring routing
public class CassandraTokenRing {
    private final TreeMap<Long, String> ring = new TreeMap<>(); // token → node
    private final int replicationFactor;

    public CassandraTokenRing(int replicationFactor) {
        this.replicationFactor = replicationFactor;
    }

    public void addNode(String node, long token) {
        ring.put(token, node);
    }

    // Find the N replica nodes for a given partition key
    public List<String> getReplicaNodes(String partitionKey) {
        long token = murmur3Hash(partitionKey);
        List<String> replicas = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        // Walk clockwise from token position
        Map.Entry<Long, String> entry = ring.ceilingEntry(token);
        Iterator<Map.Entry<Long, String>> it;

        if (entry != null) {
            it = ring.tailMap(token, true).entrySet().iterator();
        } else {
            it = ring.entrySet().iterator(); // wrap around
        }

        while (replicas.size() < replicationFactor) {
            if (!it.hasNext()) {
                it = ring.entrySet().iterator(); // wrap around
            }
            String node = it.next().getValue();
            if (seen.add(node)) {
                replicas.add(node);
            }
        }
        return replicas;
    }
}
```

### 20.5.2 Raft/Paxos → Append-Only Log Replication

Raft consensus maintains an append-only log of commands that is replicated across all cluster members. The leader appends entries and replicates them; followers apply entries in order.

```java
// Raft log — an ArrayList<LogEntry> replicated across nodes
public class RaftLog {
    static class LogEntry {
        int term;           // Raft term number (monotonically increasing)
        int index;          // position in the log (1-based)
        byte[] command;     // the actual state machine command
    }

    // The log is an ordered, append-only list — like ArrayList<LogEntry>
    private final List<LogEntry> log = new ArrayList<>();
    private int commitIndex = 0;    // highest index known to be committed
    private int lastApplied = 0;    // highest index applied to state machine

    // Leader appends new entry
    public void appendEntry(int term, byte[] command) {
        LogEntry entry = new LogEntry();
        entry.term = term;
        entry.index = log.size() + 1;
        entry.command = command;
        log.add(entry);
    }

    // After majority of followers have replicated entry at index:
    public void commit(int index) {
        commitIndex = Math.max(commitIndex, index);
        // Apply all committed but not-yet-applied entries to state machine
        while (lastApplied < commitIndex) {
            lastApplied++;
            applyToStateMachine(log.get(lastApplied - 1).command);
        }
    }

    // Followers replicate: AppendEntries RPC
    // Leader sends: prevLogIndex, prevLogTerm, entries[]
    // Follower checks: if my log[prevLogIndex].term == prevLogTerm, append entries
    // Otherwise: reject (log inconsistency — leader retries with earlier index)
    // This is binary search on the log for the matching point — the "log matching property"
}
```

### 20.5.3 Vector Clocks → int[] per Process for Causal Ordering

Vector clocks track causality in distributed systems without a global clock. Each process maintains a vector of integers — one per process in the system.

```java
// Vector clock — int[] per process
public class VectorClock {
    private final int[] clock;  // clock[i] = logical timestamp of process i
    private final int processId;

    public VectorClock(int numProcesses, int processId) {
        this.clock = new int[numProcesses];
        this.processId = processId;
    }

    // Before sending a message: increment own clock, attach vector
    public int[] send() {
        clock[processId]++;
        return clock.clone();
    }

    // On receiving a message: merge vectors (element-wise max), then increment own
    public void receive(int[] senderClock) {
        for (int i = 0; i < clock.length; i++) {
            clock[i] = Math.max(clock[i], senderClock[i]);
        }
        clock[processId]++;
    }

    // Compare two events (vector clocks) for causality:
    // vc1 < vc2 (vc1 happened-before vc2) iff:
    //   for all i: vc1[i] <= vc2[i] AND exists j: vc1[j] < vc2[j]
    //
    // If neither vc1 < vc2 nor vc2 < vc1, the events are concurrent.
    public static boolean happenedBefore(int[] vc1, int[] vc2) {
        boolean atLeastOneStrictlyLess = false;
        for (int i = 0; i < vc1.length; i++) {
            if (vc1[i] > vc2[i]) return false;
            if (vc1[i] < vc2[i]) atLeastOneStrictlyLess = true;
        }
        return atLeastOneStrictlyLess;
    }
}
```

DynamoDB uses vector clocks (simplified as version vectors) to detect conflicting writes during partition events. Riak also used them before switching to CRDTs.

### 20.5.4 Gossip Protocol → Random Graph Walk for State Propagation

Gossip protocols spread information through a cluster by having each node periodically share its state with a randomly chosen peer. This is a random walk on the node connectivity graph.

```java
// Gossip protocol — Cassandra, Consul, Serf
public class GossipProtocol {
    static class NodeState {
        String nodeId;
        Map<String, String> metadata;  // key-value state
        long heartbeatVersion;          // monotonically increasing
        long timestamp;
    }

    // Each node maintains a map of all known nodes and their state
    private final Map<String, NodeState> clusterState = new ConcurrentHashMap<>();
    private final String myNodeId;
    private final Random random = new Random();

    // Periodically (e.g., every 1 second):
    public void gossipRound(List<String> allNodes) {
        // 1. Pick a random peer
        String peer = allNodes.get(random.nextInt(allNodes.size()));

        // 2. Send my state digest to peer
        Map<String, Long> digest = new HashMap<>();
        clusterState.forEach((k, v) -> digest.put(k, v.heartbeatVersion));

        // 3. Peer compares digest with its own state
        //    Sends back any states that are newer than what I have
        //    Also requests any states where I am newer

        // Convergence: after O(log N) rounds, all N nodes have consistent state
        // (with high probability) — this is the "epidemic" or "rumor spreading" property
    }

    // Merge received state — keep newer version for each key
    public void mergeState(Map<String, NodeState> receivedState) {
        receivedState.forEach((nodeId, state) -> {
            clusterState.merge(nodeId, state, (existing, received) ->
                received.heartbeatVersion > existing.heartbeatVersion ? received : existing
            );
        });
    }
}
```

Gossip converges in O(log N) rounds because it mimics epidemic spreading — each round roughly doubles the number of informed nodes. This is the same as binary tree height analysis: starting from 1, doubling each round, reaching N in log2(N) rounds.

### 20.5.5 Merkle Tree → Hash Tree for Data Integrity

Merkle trees enable efficient detection of differences between two copies of a large dataset. Two replicas can compare their root hashes in O(1), and if they differ, walk down the tree to find exactly which blocks differ in O(log N).

```java
// Merkle tree — used in Git, Cassandra anti-entropy, blockchain
public class MerkleTree {
    static class Node {
        byte[] hash;
        Node left, right;
        byte[] data;  // only in leaf nodes
    }

    // Build a Merkle tree from data blocks
    public Node build(List<byte[]> blocks) {
        // Leaf level: hash each block
        List<Node> nodes = new ArrayList<>();
        for (byte[] block : blocks) {
            Node leaf = new Node();
            leaf.data = block;
            leaf.hash = sha256(block);
            nodes.add(leaf);
        }

        // Build tree bottom-up
        while (nodes.size() > 1) {
            List<Node> parents = new ArrayList<>();
            for (int i = 0; i < nodes.size(); i += 2) {
                Node parent = new Node();
                parent.left = nodes.get(i);
                parent.right = (i + 1 < nodes.size()) ? nodes.get(i + 1) : nodes.get(i);
                parent.hash = sha256(concat(parent.left.hash, parent.right.hash));
                parents.add(parent);
            }
            nodes = parents;
        }
        return nodes.get(0);  // root
    }

    // Compare two replicas: find differing blocks in O(log N)
    public List<Integer> findDifferences(Node local, Node remote) {
        List<Integer> diffs = new ArrayList<>();
        findDiffsRecursive(local, remote, 0, diffs);
        return diffs;
    }

    private void findDiffsRecursive(Node a, Node b, int blockIndex, List<Integer> diffs) {
        if (Arrays.equals(a.hash, b.hash)) return;  // subtree identical — prune
        if (a.data != null) {
            diffs.add(blockIndex);  // leaf node — this block differs
            return;
        }
        // Recurse into children — only explore differing subtrees
        findDiffsRecursive(a.left, b.left, blockIndex * 2, diffs);
        findDiffsRecursive(a.right, b.right, blockIndex * 2 + 1, diffs);
    }
}
```

**Cassandra anti-entropy repair**: When two replicas might have diverged (after a network partition), Cassandra builds a Merkle tree over each replica's data. Comparing root hashes immediately tells if they are in sync. If not, walking down the tree identifies exactly which key ranges need repair — transferring only the differing data, not the entire dataset.

### 20.5.6 CRDT → G-Counter, OR-Set, LWW-Register

CRDTs (Conflict-free Replicated Data Types) are data structures that can be merged after concurrent updates without conflicts. They rely on mathematical properties (commutativity, associativity, idempotency) to guarantee eventual consistency.

```java
// G-Counter (Grow-only Counter) — int[] per replica
public class GCounter {
    private final int[] counts;      // counts[i] = increments by replica i
    private final int replicaId;

    public GCounter(int numReplicas, int replicaId) {
        this.counts = new int[numReplicas];
        this.replicaId = replicaId;
    }

    public void increment() {
        counts[replicaId]++;   // only increment own slot
    }

    public int value() {
        int total = 0;
        for (int c : counts) total += c;
        return total;
    }

    // Merge: element-wise max — commutative, associative, idempotent
    public void merge(GCounter other) {
        for (int i = 0; i < counts.length; i++) {
            counts[i] = Math.max(counts[i], other.counts[i]);
        }
    }

    // Example with 3 replicas:
    // Replica A: [5, 0, 0] → value = 5
    // Replica B: [0, 3, 0] → value = 3
    // Replica C: [0, 0, 7] → value = 7
    //
    // After any merge order:
    // merge(A, B) = [5, 3, 0] → value = 8
    // merge(AB, C) = [5, 3, 7] → value = 15
    // merge(A, C) = [5, 0, 7] → value = 12
    // merge(AC, B) = [5, 3, 7] → value = 15  (same result regardless of order!)
}

// LWW-Register (Last-Writer-Wins Register) — uses timestamp for conflict resolution
public class LWWRegister<T> {
    private T value;
    private long timestamp;

    public void set(T value, long timestamp) {
        if (timestamp > this.timestamp) {
            this.value = value;
            this.timestamp = timestamp;
        }
    }

    public void merge(LWWRegister<T> other) {
        if (other.timestamp > this.timestamp) {
            this.value = other.value;
            this.timestamp = other.timestamp;
        }
    }
}
```

---

## 20.6 Java Frameworks — Data Structures in Your Application Stack

Every Java framework you use daily is built on the same data structures. Understanding this mapping helps you reason about performance characteristics, memory usage, and concurrency behavior.

### 20.6.1 Spring Bean Container → HashMap<BeanName, Object>

The core of Spring's ApplicationContext is a `ConcurrentHashMap` that maps bean names to bean instances.

```java
// Spring's DefaultListableBeanFactory (simplified)
// Source: org.springframework.beans.factory.support.DefaultListableBeanFactory
public class SimplifiedBeanFactory {

    // The central data structure: name → bean instance
    // DefaultSingletonBeanRegistry.singletonObjects
    private final Map<String, Object> singletonObjects = new ConcurrentHashMap<>(256);

    // Bean definitions: name → how to create the bean
    private final Map<String, BeanDefinition> beanDefinitionMap = new ConcurrentHashMap<>(256);

    // Dependency resolution uses topological sort:
    // If BeanA depends on BeanB, BeanB must be created first.
    // This is the same topological sort used in build systems.
    public Object getBean(String name) {
        Object bean = singletonObjects.get(name);  // O(1) lookup
        if (bean != null) return bean;

        // Create bean (resolve dependencies recursively — DFS on dependency graph)
        BeanDefinition def = beanDefinitionMap.get(name);
        for (String dependency : def.getDependencies()) {
            getBean(dependency);  // recursive — ensure dependency is created first
        }
        bean = createBeanInstance(def);
        singletonObjects.put(name, bean);

        // Circular dependency detection: Spring uses a 3-level cache:
        // 1. singletonObjects (fully initialized)
        // 2. earlySingletonObjects (partially initialized, exposed for circular refs)
        // 3. singletonFactories (factory for creating early references)
        // This is cycle detection in a directed graph with early exposure.

        return bean;
    }
}
```

### 20.6.2 Hibernate Session Cache → IdentityHashMap

Hibernate's first-level cache (the Session/EntityManager) uses identity-based tracking. It must distinguish between two `User` objects that have the same field values but are different Java objects.

```java
// Hibernate PersistenceContext — uses identity for dirty checking
public class SimplifiedPersistenceContext {

    // EntityKey → entity instance
    // Uses identity comparison (==), not equals(), to track managed entities
    // This is why IdentityHashMap is the conceptual model
    private final Map<EntityKey, Object> entitiesByKey = new HashMap<>();

    // Dirty checking: snapshot comparison
    // When entity is loaded, a snapshot of all field values is saved
    private final Map<EntityKey, Object[]> entitySnapshots = new HashMap<>();

    public void persist(Object entity) {
        EntityKey key = extractKey(entity);
        entitiesByKey.put(key, entity);
        entitySnapshots.put(key, takeSnapshot(entity));  // copy all field values
    }

    // At flush time: compare current state with snapshot
    public List<Object> findDirtyEntities() {
        List<Object> dirty = new ArrayList<>();
        for (Map.Entry<EntityKey, Object> entry : entitiesByKey.entrySet()) {
            Object[] snapshot = entitySnapshots.get(entry.getKey());
            Object[] current = takeSnapshot(entry.getValue());
            if (!Arrays.deepEquals(snapshot, current)) {
                dirty.add(entry.getValue());
            }
        }
        return dirty;
    }

    // Why IdentityHashMap matters:
    // User u1 = session.find(User.class, 1L);  // loads from DB
    // User u2 = session.find(User.class, 1L);  // returns SAME instance (u1 == u2)
    // assert u1 == u2;  // guaranteed by identity map
    // u1.setName("new name");
    // session.flush();  // dirty check on u1 detects change
}
```

### 20.6.3 Hibernate Second-Level Cache → ConcurrentHashMap<EntityKey, Entity>

The second-level cache is shared across sessions and is backed by a `ConcurrentHashMap` (or pluggable providers like EhCache, Hazelcast, or Infinispan).

```java
// Hibernate L2 cache — ConcurrentHashMap at its core
public class SecondLevelCache {
    // Region → ConcurrentHashMap<EntityKey, CacheEntry>
    private final ConcurrentHashMap<String, ConcurrentHashMap<Object, Object[]>> regions
        = new ConcurrentHashMap<>();

    // CacheEntry stores dehydrated state (array of column values), not the entity object
    // This avoids sharing mutable entity objects across sessions
    public Object[] get(String region, Object entityId) {
        ConcurrentHashMap<Object, Object[]> regionCache = regions.get(region);
        return regionCache != null ? regionCache.get(entityId) : null;
    }

    public void put(String region, Object entityId, Object[] dehydratedState) {
        regions.computeIfAbsent(region, r -> new ConcurrentHashMap<>())
               .put(entityId, dehydratedState);
    }

    // Eviction: time-based (TTL) or size-based (LRU)
    // EhCache wraps this with off-heap storage and tiered caching (heap → off-heap → disk)
}
```

### 20.6.4 Netty Event Loop → Queue (Task Queue per Event Loop Thread)

Netty's event loop architecture is a queue-per-thread model. Each `EventLoop` (which is a single thread) has a task queue that buffers incoming I/O events and user-submitted tasks.

```java
// Netty NioEventLoop — simplified
public class SimplifiedEventLoop implements Runnable {

    // Task queue: multi-producer, single-consumer
    // Netty uses MpscQueue (Mpsc = Multi-Producer Single-Consumer)
    // from JCTools library — lock-free, cache-friendly
    private final Queue<Runnable> taskQueue;

    // Scheduled tasks: priority queue ordered by deadline
    private final PriorityQueue<ScheduledTask> scheduledTaskQueue
        = new PriorityQueue<>(Comparator.comparingLong(t -> t.deadline));

    // Selector for I/O multiplexing (wraps epoll on Linux)
    private final Selector selector;

    @Override
    public void run() {
        while (!shutdown) {
            // 1. Poll for I/O events (epoll_wait)
            int readyChannels = selector.select(calculateDeadline());

            // 2. Process I/O events
            if (readyChannels > 0) {
                processSelectedKeys();
            }

            // 3. Run all tasks from the task queue
            Runnable task;
            while ((task = taskQueue.poll()) != null) {
                task.run();
            }

            // 4. Run due scheduled tasks
            while (!scheduledTaskQueue.isEmpty()
                   && scheduledTaskQueue.peek().deadline <= System.nanoTime()) {
                scheduledTaskQueue.poll().task.run();
            }
        }
    }

    // Any thread can submit work to this event loop:
    public void execute(Runnable task) {
        taskQueue.offer(task);   // MPSC enqueue — O(1), lock-free
        selector.wakeup();       // wake the event loop if it is blocked on select()
    }
}
```

### 20.6.5 Netty ByteBuf Pool → Slab Allocator + Buddy Allocator

Netty's `PooledByteBufAllocator` is a Java reimplementation of the Linux kernel's memory allocation strategy, adapted for network buffers.

```
Netty PooledByteBufAllocator architecture:
┌──────────────────────────────────────────────────────────┐
│                   PooledByteBufAllocator                  │
│                                                          │
│  PoolArena[0]  PoolArena[1]  ...  PoolArena[N]          │
│  (per CPU core — minimize contention)                    │
│                                                          │
│  Each PoolArena:                                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Tiny allocations (< 512B):   Slab allocator        │ │
│  │   → sub-page slabs, free list per size class       │ │
│  │                                                    │ │
│  │ Small allocations (512B - 8KB): Slab allocator     │ │
│  │   → sub-page slabs                                 │ │
│  │                                                    │ │
│  │ Normal allocations (8KB - 16MB): Buddy allocator   │ │
│  │   → binary tree of power-of-2 chunks              │ │
│  │                                                    │ │
│  │ Huge allocations (> 16MB): Direct allocation       │ │
│  │   → not pooled, allocated/freed per use            │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  Thread-local cache (PoolThreadCache):                   │
│  → Per-thread free list per size class (like TLAB)      │
│  → Avoid contention on the shared PoolArena             │
└──────────────────────────────────────────────────────────┘
```

This is directly analogous to the JVM's own memory allocation strategy (TLABs for thread-local allocation, generational pools by size), but for network buffer memory.

### 20.6.6 Log4j2 Async → LMAX Disruptor Ring Buffer

Log4j2's AsyncLogger uses the LMAX Disruptor — a lock-free ring buffer that achieves millions of operations per second with predictable latency.

```java
// LMAX Disruptor ring buffer — used by Log4j2 AsyncLogger
public class SimplifiedDisruptor<T> {
    private final Object[] entries;      // ring buffer — power of 2 size
    private final int mask;               // capacity - 1
    private final AtomicLong cursor = new AtomicLong(-1); // producer write position
    private long consumerSequence = -1;                    // consumer read position

    public SimplifiedDisruptor(int capacity) {
        // Capacity MUST be power of 2 for bitwise modulo
        this.entries = new Object[capacity];
        this.mask = capacity - 1;
    }

    // Producer: claim a slot, write, publish
    public void publish(T event) {
        long sequence = cursor.incrementAndGet();  // claim next slot (CAS)

        // Wait if we would overwrite unconsumed entries
        while (sequence - consumerSequence > mask) {
            Thread.onSpinWait();  // busy wait (intentional for ultra-low latency)
        }

        entries[(int)(sequence & mask)] = event;  // write to slot
        // No lock — single-writer guarantee or CAS-based multi-writer
    }

    // Consumer: read, process, advance
    @SuppressWarnings("unchecked")
    public T consume() {
        long nextSequence = consumerSequence + 1;
        while (cursor.get() < nextSequence) {
            Thread.onSpinWait();  // wait for producer to publish
        }
        T event = (T) entries[(int)(nextSequence & mask)];
        consumerSequence = nextSequence;
        return event;
    }

    // Why ring buffer, not LinkedBlockingQueue?
    // 1. No object allocation (slots are pre-allocated) — zero GC pressure
    // 2. Contiguous memory — cache-friendly sequential access
    // 3. No locks — CAS for producers, no contention for single consumer
    // 4. Predictable latency — no GC pauses, no lock contention spikes
    // LinkedBlockingQueue: ~4M ops/sec with lock contention
    // Disruptor: ~100M ops/sec with zero lock contention
}
```

### 20.6.7 Tomcat Thread Pool → ArrayBlockingQueue (ThreadPoolExecutor Work Queue)

Tomcat uses a standard `ThreadPoolExecutor` with an `ArrayBlockingQueue` as the work queue.

```java
// Tomcat's thread pool configuration — mapped to JDK ThreadPoolExecutor
public class TomcatThreadPoolExample {
    // Default Tomcat configuration:
    // minSpareThreads = 10  (corePoolSize)
    // maxThreads = 200      (maximumPoolSize)
    // acceptCount = 100     (queue capacity)

    private final ThreadPoolExecutor executor = new ThreadPoolExecutor(
        10,                                      // corePoolSize (minSpareThreads)
        200,                                     // maximumPoolSize (maxThreads)
        60, TimeUnit.SECONDS,                    // keepAliveTime for excess threads
        new ArrayBlockingQueue<>(100),           // work queue (acceptCount)
        new ThreadPoolExecutor.CallerRunsPolicy() // rejection policy
    );

    // Request flow:
    // 1. If threads < corePoolSize (10): create new thread immediately
    // 2. If threads >= corePoolSize: enqueue in ArrayBlockingQueue
    //    → ArrayBlockingQueue: fixed-size circular array with ReentrantLock
    //    → O(1) enqueue/dequeue, but lock contention under high load
    // 3. If queue is full: create thread up to maximumPoolSize (200)
    // 4. If threads == maximumPoolSize AND queue is full: reject (CallerRunsPolicy)
    //
    // Tuning insight: if you set the queue too large (e.g., 10000),
    // threads will NEVER grow beyond corePoolSize because the queue
    // absorbs all requests. This is a common misconfiguration.
}
```

### 20.6.8 Kafka → Append-Only Log + Consumer Offset HashMap

Kafka's core abstraction is the partitioned, append-only commit log.

```java
// Kafka partition — append-only log (mmap'd file)
public class KafkaPartitionLog {
    // Each partition is a sequence of segments on disk
    // Each segment is an append-only file, memory-mapped for performance
    static class LogSegment {
        long baseOffset;           // first offset in this segment
        MappedByteBuffer dataLog;  // mmap'd file: message data
        MappedByteBuffer indexFile; // sparse index: offset → file position
        long sizeBytes;

        // Append a message — O(1), sequential write
        public long append(byte[] key, byte[] value) {
            long offset = baseOffset + messageCount;
            dataLog.put(serializeMessage(offset, key, value));
            // Index is sparse: one entry per N messages (default 4KB)
            if (sizeBytes % 4096 == 0) {
                indexFile.putLong(offset);
                indexFile.putInt(dataLog.position());
            }
            return offset;
        }
    }

    // Consumer offset tracking — HashMap<ConsumerGroup+Partition, Offset>
    // Stored in a special internal topic: __consumer_offsets
    // The offset is an integer: the next message to read
    private final Map<String, Long> consumerOffsets = new ConcurrentHashMap<>();

    // Read messages from offset — binary search in sparse index, then sequential read
    public List<Message> fetch(long startOffset, int maxBytes) {
        LogSegment segment = findSegment(startOffset);  // binary search on segment base offsets
        int filePosition = segment.lookupPosition(startOffset);  // binary search in sparse index
        // Then sequential read from filePosition — cache-friendly
        return readMessages(segment, filePosition, maxBytes);
    }
}
```

---

## 20.7 Six End-to-End Case Studies

These case studies trace the complete data structure story of production systems. Each one shows how multiple data structures work together.

### Case Study 1: Redis Internals

Redis is a masterclass in data structure engineering. Every Redis data type is backed by one or more carefully chosen internal representations that change based on the data size.

```
Redis Data Structure Mapping:
┌─────────────────┬───────────────────────────────────────────────────────────────────┐
│ Redis Type       │ Internal Encoding(s)                                              │
├─────────────────┼───────────────────────────────────────────────────────────────────┤
│ String           │ int (if numeric, fits in long)                                    │
│                  │ embstr (SDS ≤ 44 bytes, allocated with robj in one malloc)       │
│                  │ raw SDS (> 44 bytes, separate allocation)                        │
├─────────────────┼───────────────────────────────────────────────────────────────────┤
│ List             │ listpack (≤ 128 elements AND all ≤ 64 bytes) — compressed array  │
│                  │ quicklist (linked list of listpacks) — for larger lists           │
├─────────────────┼───────────────────────────────────────────────────────────────────┤
│ Set              │ listpack (≤ 128 elements AND all integers)                       │
│                  │ intset (sorted int array, binary search) for small integer sets   │
│                  │ hashtable (dict) for larger/mixed sets                            │
├─────────────────┼───────────────────────────────────────────────────────────────────┤
│ Hash             │ listpack (≤ 128 field-value pairs AND all ≤ 64 bytes)            │
│                  │ hashtable (dict) for larger hashes                                │
├─────────────────┼───────────────────────────────────────────────────────────────────┤
│ Sorted Set (ZSET)│ listpack (≤ 128 elements AND all ≤ 64 bytes)                    │
│                  │ skiplist + dict (for larger sorted sets)                          │
│                  │   skiplist: O(log n) range queries, rank queries                  │
│                  │   dict: O(1) score lookup by member                              │
├─────────────────┼───────────────────────────────────────────────────────────────────┤
│ Stream           │ Radix tree of listpacks (trie of compressed message sequences)   │
└─────────────────┴───────────────────────────────────────────────────────────────────┘
```

**Redis dict (hash table)** uses two hash tables for incremental rehashing:

```java
// Redis dict — two hash tables for incremental rehash
public class RedisDict<K, V> {
    static class DictEntry<K, V> {
        K key;
        V value;
        DictEntry<K, V> next;  // separate chaining
    }

    private DictEntry<K, V>[] ht0;  // current hash table
    private DictEntry<K, V>[] ht1;  // rehash target (only allocated during rehash)
    private int rehashIndex = -1;    // -1 = not rehashing, 0+ = current bucket being rehashed

    // Incremental rehash: move one bucket per operation (get/set/delete)
    // This avoids a single long pause when the table doubles
    private void rehashStep() {
        if (rehashIndex < 0) return;  // not rehashing

        // Move all entries from ht0[rehashIndex] to ht1
        DictEntry<K, V> entry = ht0[rehashIndex];
        while (entry != null) {
            DictEntry<K, V> next = entry.next;
            int newIndex = hash(entry.key) & (ht1.length - 1);
            entry.next = ht1[newIndex];
            ht1[newIndex] = entry;
            entry = next;
        }
        ht0[rehashIndex] = null;
        rehashIndex++;

        if (rehashIndex >= ht0.length) {
            // Rehash complete — swap tables
            ht0 = ht1;
            ht1 = null;
            rehashIndex = -1;
        }
    }

    // During rehash, lookups check BOTH tables:
    public V get(K key) {
        rehashStep();  // one step of incremental rehash

        // Check ht0
        int idx0 = hash(key) & (ht0.length - 1);
        for (DictEntry<K, V> e = ht0[idx0]; e != null; e = e.next) {
            if (e.key.equals(key)) return e.value;
        }

        // If rehashing, also check ht1
        if (ht1 != null) {
            int idx1 = hash(key) & (ht1.length - 1);
            for (DictEntry<K, V> e = ht1[idx1]; e != null; e = e.next) {
                if (e.key.equals(key)) return e.value;
            }
        }
        return null;
    }
}
```

**Redis skip list** (used for sorted sets):

```java
// Redis skip list for ZSET — O(log n) range queries + O(1) score lookup via companion dict
public class RedisSkipList {
    static final int MAX_LEVEL = 32;
    static final double P = 0.25;  // probability of level promotion

    static class SkipListNode {
        String member;
        double score;
        SkipListNode backward;  // for reverse iteration
        SkipListLevel[] levels;

        static class SkipListLevel {
            SkipListNode forward;
            int span;  // number of nodes skipped — enables O(log n) rank queries
        }
    }

    private SkipListNode header;
    private SkipListNode tail;
    private int level;  // current max level
    private int length;

    // ZRANGEBYSCORE key min max — range query
    // Walk through skip list levels to find start, then iterate forward
    // O(log n) to find start + O(k) to iterate k results

    // ZRANK key member — rank query
    // Walk from header, summing span values → O(log n)
    // This is unique to Redis's skip list implementation: span tracking in each level
}
```

**Redis key expiration** uses a combination of lazy and periodic deletion:

```java
// Redis expire — lazy + active (sampling-based)
public class RedisExpire {
    private final Map<String, Long> expires = new HashMap<>();  // key → expiry timestamp

    // Lazy: check on every key access
    public String get(String key) {
        Long expiry = expires.get(key);
        if (expiry != null && System.currentTimeMillis() > expiry) {
            delete(key);  // expired — delete now
            return null;
        }
        return database.get(key);
    }

    // Active (periodic, 10 times/sec):
    // 1. Sample 20 random keys from expires dict
    // 2. Delete expired ones
    // 3. If more than 25% were expired, repeat immediately
    // This probabilistic approach avoids scanning all keys (O(n))
    // while ensuring expired keys are cleaned up in bounded time
    public void activeExpireCycle() {
        int sampled = 0, expired = 0;
        for (Map.Entry<String, Long> entry : randomSample(expires, 20)) {
            sampled++;
            if (System.currentTimeMillis() > entry.getValue()) {
                delete(entry.getKey());
                expired++;
            }
        }
        // If expired/sampled > 0.25, repeat
    }
}
```

### Case Study 2: Kafka Internals

Kafka's architecture is built around three core concepts, each mapped to a data structure:

**Partitioned append-only log**: Each topic partition is a sequence of segment files. Messages are appended sequentially — writes are O(1) and sequential (disk-friendly). The offset is a 64-bit integer that serves as the unique identifier for each message.

```java
// Kafka broker — core data structures
public class KafkaBrokerInternals {

    // 1. Partition log = sequence of immutable segment files
    // Each segment: [baseOffset].log (data) + [baseOffset].index (offset→position) + [baseOffset].timeindex
    // Active segment: currently being appended to
    // Closed segments: immutable, eligible for compaction/deletion

    // 2. In-Sync Replicas (ISR) — a dynamic set of replicas that are "caught up"
    // Maintained as a Set<Integer> of replica IDs
    // Leader writes message, waits for all ISR members to replicate before acknowledging
    // If a replica falls behind (offset lag > threshold), it is removed from ISR
    private final Set<Integer> isr = new ConcurrentSkipListSet<>();  // ordered for deterministic leader election

    // 3. Consumer group coordination
    // __consumer_offsets topic: HashMap<GroupId+TopicPartition, Offset>
    // Group coordinator assigns partitions to consumers via "range" or "round-robin" strategy
    // This is a partitioning problem: assign N partitions to M consumers to minimize imbalance

    // 4. Zero-copy: sendfile() system call
    // Instead of: disk → kernel buffer → user buffer → socket buffer → NIC
    // sendfile():  disk → kernel buffer → socket buffer → NIC
    // Eliminates two memory copies and two context switches
    // Java: FileChannel.transferTo() → calls sendfile() on Linux
    public long zeroCopySend(FileChannel source, SocketChannel dest, long position, long count)
            throws IOException {
        return source.transferTo(position, count, dest);
        // This IS the "zero-copy" that makes Kafka fast
        // No data is copied to JVM heap — kernel handles it
    }
}
```

### Case Study 3: Elasticsearch / Lucene

Elasticsearch is built on Apache Lucene. The core data structures are:

**Inverted index**: Maps each term to the list of documents containing it. This is a `HashMap<Term, PostingsList>` where each posting list is a sorted array of document IDs.

```java
// Lucene inverted index — simplified
public class InvertedIndex {
    // Term → sorted list of document IDs (posting list)
    // In practice, posting lists are compressed using delta encoding + variable-length encoding
    private final Map<String, List<Integer>> index = new TreeMap<>();

    // Index a document
    public void indexDocument(int docId, String text) {
        for (String term : tokenize(text)) {
            index.computeIfAbsent(term, k -> new ArrayList<>()).add(docId);
        }
    }

    // Boolean query: "java AND performance"
    // = intersection of posting lists for "java" and "performance"
    // This is the "merge two sorted arrays" problem!
    public List<Integer> andQuery(String term1, String term2) {
        List<Integer> list1 = index.getOrDefault(term1, List.of());
        List<Integer> list2 = index.getOrDefault(term2, List.of());
        return intersectSorted(list1, list2);
    }

    // Two-pointer intersection of sorted lists — O(n + m)
    private List<Integer> intersectSorted(List<Integer> a, List<Integer> b) {
        List<Integer> result = new ArrayList<>();
        int i = 0, j = 0;
        while (i < a.size() && j < b.size()) {
            int cmp = a.get(i).compareTo(b.get(j));
            if (cmp == 0) {
                result.add(a.get(i));
                i++; j++;
            } else if (cmp < 0) {
                i++;
            } else {
                j++;
            }
        }
        return result;
    }
}
```

**BKD tree** (Block K-D tree): Lucene uses BKD trees for numeric and geo-spatial range queries. A BKD tree is a variant of a K-D tree that is block-oriented for disk-friendly access.

```
BKD tree for range queries on numeric fields:
    Query: price >= 100 AND price <= 500

    BKD tree structure (conceptual):
                    [300]
                   /      \
            [150]          [700]
           /    \         /    \
      [50-200] [200-300] [300-700] [700-1000]
         ↑ leaf blocks contain sorted arrays of values + doc IDs

    Leaf blocks are sorted → binary search within block
    Internal nodes guide to correct leaf block
    Range query: find entry leaf, scan sequentially until exit leaf

    This is why numeric range queries in Elasticsearch are fast:
    the BKD tree prunes entire subtrees that are outside the range.
```

**Segment merge** (LSM-style compaction): Lucene segments are immutable — new documents go to a new segment. Periodically, multiple small segments are merged into one larger segment. This is the same merge operation as LSM tree compaction.

```
Lucene segment lifecycle:
    1. New documents → in-memory buffer (like LSM memtable)
    2. Buffer full → flush to new segment on disk (immutable)
    3. Background merge: small segments → larger segments
       This IS merge sort: merge multiple sorted posting lists into one
    4. Deleted documents: marked in .del bitset, physically removed during merge
```

### Case Study 4: Linux CFS Scheduler — Deep Dive

We covered CFS in Section 20.3.1. Here is the deeper dive with vruntime calculation.

```
CFS vruntime calculation:
    vruntime += delta_exec * (NICE_0_WEIGHT / task_weight)

    Where:
    - delta_exec = wall-clock time the task actually ran (nanoseconds)
    - NICE_0_WEIGHT = 1024 (the weight of a nice-0 process)
    - task_weight = prio_to_weight[nice + 20]

    Nice-to-weight mapping (partial):
    nice  |  weight   | vruntime multiplier (relative to nice 0)
    ------+-----------+------------------------------------------
      -20 |   88761   |  0.0115 (vruntime grows 87x slower)
      -10 |    9548   |  0.107  (vruntime grows 9.3x slower)
       -5 |    3121   |  0.328  (vruntime grows 3x slower)
        0 |    1024   |  1.0    (baseline)
        5 |     335   |  3.06   (vruntime grows 3x faster)
       10 |     110   |  9.31   (vruntime grows 9.3x faster)
       19 |      15   |  68.3   (vruntime grows 68x faster)

    Effect: a nice -20 task's vruntime grows 87x slower than nice 0.
    Since CFS always picks the task with LOWEST vruntime, the nice -20 task
    gets picked ~87x more often.

    Time complexity:
    - pick_next_task: O(1) — cached leftmost node of RB-tree
    - enqueue_task: O(log n) — insert into RB-tree
    - dequeue_task: O(log n) — remove from RB-tree
    - update_curr: O(1) — update vruntime of current task

    For a system with 1000 runnable tasks:
    - Context switch: ~10 microseconds
    - RB-tree insert/remove: ~20 comparisons = ~200 nanoseconds
    - Overhead is negligible compared to the context switch itself
```

### Case Study 5: TCP/IP Stack — Deep Dive

The TCP/IP stack layers data structures from hardware to application:

```
TCP/IP Data Structure Stack:
┌─────────────────────────────────────────────────────────────────────┐
│ Application Layer (HTTP, DNS, etc.)                                 │
│   HashMap<String, String> headers                                   │
│   byte[] body                                                       │
├─────────────────────────────────────────────────────────────────────┤
│ Transport Layer (TCP)                                               │
│   Sliding window (circular buffer of segments)                      │
│   Retransmission queue (priority queue by timeout)                  │
│   Connection table (HashMap<4-tuple, TCB>)                         │
│   SYN cookies (hash function: no data structure needed!)            │
├─────────────────────────────────────────────────────────────────────┤
│ Network Layer (IP)                                                  │
│   Routing table (trie / longest prefix match)                       │
│   ARP cache (HashMap<IP, MAC> with TTL)                            │
│   Fragment reassembly (HashMap<fragID, LinkedList<fragments>>)     │
├─────────────────────────────────────────────────────────────────────┤
│ Data Link Layer (Ethernet)                                          │
│   MAC address table (HashMap<MAC, Port> — switch learning)          │
│   NIC ring buffer (circular array for DMA)                         │
└─────────────────────────────────────────────────────────────────────┘
```

**Nagle's algorithm** is a greedy buffering strategy: accumulate small outgoing data until either (a) a full MSS (Maximum Segment Size) is ready, or (b) the outstanding ACK is received. This trades latency for throughput — a greedy optimization that minimizes packet overhead for bulk transfers but adds latency for interactive protocols.

```java
// Nagle's algorithm — greedy buffering
public class NagleAlgorithm {
    private byte[] sendBuffer = new byte[MSS]; // accumulate small writes
    private int buffered = 0;
    private boolean unackedDataExists;

    public void write(byte[] data) {
        System.arraycopy(data, 0, sendBuffer, buffered, data.length);
        buffered += data.length;

        if (buffered >= MSS) {
            sendSegment(sendBuffer, buffered);  // full MSS — send immediately
            buffered = 0;
        } else if (!unackedDataExists) {
            sendSegment(sendBuffer, buffered);  // no outstanding ACK — send now
            buffered = 0;
            unackedDataExists = true;
        }
        // Otherwise: buffer the data and wait for ACK
        // This is why SSH feels "laggy" over high-latency links with Nagle enabled.
        // Fix: TCP_NODELAY option disables Nagle's algorithm.
    }
}
```

**SYN cookies** are a hash-based defense against SYN flood attacks:

```java
// SYN cookies — hash-based defense (no data structure allocation per SYN)
public class SynCookies {
    // Normal TCP: on SYN, allocate a TCB (Transmission Control Block) in a HashMap
    // Problem: attacker sends millions of SYN packets, exhausting memory

    // SYN cookie: encode state IN the ISN (Initial Sequence Number)
    // No per-connection state needed until the handshake completes

    public int generateSynCookie(int srcIp, int dstIp, int srcPort, int dstPort, long time) {
        // ISN = hash(src_ip, src_port, dst_ip, dst_port, secret) + (time_counter << 24)
        //       + (MSS_index << 0)
        int hash = cryptoHash(srcIp, srcPort, dstIp, dstPort, SECRET_KEY);
        int timeCounter = (int)(time / 60_000) & 0x1F;  // 5 bits, ~32 minute cycle
        int mssIndex = encodeMss(negotiatedMss());       // 3 bits
        return hash + (timeCounter << 24) + mssIndex;
    }

    // On ACK (final handshake step):
    // Recompute expected ISN from the 5-tuple and current time
    // If received ACK number matches expected ISN + 1, handshake is valid
    // NOW allocate TCB — only for completed handshakes
    public boolean verifySynCookie(int ackNum, int srcIp, int dstIp, int srcPort, int dstPort) {
        for (int timeOffset = 0; timeOffset <= 1; timeOffset++) {
            int expectedIsn = generateSynCookie(srcIp, dstIp, srcPort, dstPort,
                                                System.currentTimeMillis() - timeOffset * 60_000);
            if (ackNum == expectedIsn + 1) return true;
        }
        return false;
    }
    // Brilliant: no HashMap allocation per SYN — state is encoded in the cookie itself
}
```

### Case Study 6: Git Internals

Git is a content-addressable filesystem. Every object is stored by its SHA-1 hash.

```
Git object model:
┌─────────────────────────────────────────────────────────────────────┐
│                        commit abc123                                 │
│  tree: def456                                                       │
│  parent: 789abc                                                     │
│  author: ...                                                        │
│  message: "Fix bug"                                                 │
├─────────────────────────────────────────────────────────────────────┤
│                        tree def456                                   │
│  blob a1b2c3  README.md                                             │
│  blob d4e5f6  src/Main.java                                        │
│  tree 789012  src/util/                                             │
├─────────────────────────────────────────────────────────────────────┤
│                    tree 789012 (src/util/)                           │
│  blob aabbcc  Helper.java                                           │
├─────────────────────────────────────────────────────────────────────┤
│                    blob a1b2c3 (README.md content)                  │
│  "# My Project\n..."                                                │
└─────────────────────────────────────────────────────────────────────┘

Data structures:
1. Content-addressable store = HashMap<SHA1, Object>
   git cat-file -p abc123  → retrieve object by its hash
   Two objects with identical content have the same SHA1 → automatic dedup

2. Tree objects = directory tree
   Each tree entry: mode + name + SHA1 of child (blob or tree)
   Directories ARE trees, files ARE blobs (leaves)

3. Merkle tree for integrity
   Changing a single byte in any file changes its blob hash,
   which changes the parent tree hash, which changes the commit hash.
   The root hash (commit ID) is a fingerprint of the ENTIRE project state.

4. Commit graph = DAG (Directed Acyclic Graph)
   Each commit points to parent commit(s)
   Merge commit has 2+ parents
   git log --graph shows the DAG
   Finding merge base = LCA (Lowest Common Ancestor) in the DAG

5. Packfiles = delta compression
   Loose objects: one file per object (efficient for small repos)
   Packfile: multiple objects compressed together with delta encoding
   Object A is stored as: "Object B (base) + delta (differences)"
   This is similar to video compression: keyframes + delta frames
```

```java
// Git content-addressable store
public class GitObjectStore {
    // The core data structure: SHA1 → compressed object bytes
    private final Map<String, byte[]> objects = new HashMap<>();

    // Store a blob (file content)
    public String storeBlob(byte[] content) {
        byte[] header = ("blob " + content.length + "\0").getBytes();
        byte[] fullObject = concat(header, content);
        String sha1 = sha1Hash(fullObject);
        objects.put(sha1, compress(fullObject));
        return sha1;
    }

    // Store a tree (directory listing)
    public String storeTree(List<TreeEntry> entries) {
        // Sort entries by name (Git requirement)
        entries.sort(Comparator.comparing(e -> e.name));
        byte[] content = serializeTree(entries);
        byte[] header = ("tree " + content.length + "\0").getBytes();
        byte[] fullObject = concat(header, content);
        String sha1 = sha1Hash(fullObject);
        objects.put(sha1, compress(fullObject));
        return sha1;
    }

    // Store a commit
    public String storeCommit(String treeSha1, String parentSha1, String message) {
        String content = "tree " + treeSha1 + "\n"
                       + "parent " + parentSha1 + "\n"
                       + "author " + authorInfo() + "\n"
                       + "committer " + committerInfo() + "\n"
                       + "\n" + message;
        byte[] header = ("commit " + content.length() + "\0").getBytes();
        byte[] fullObject = concat(header, content.getBytes());
        String sha1 = sha1Hash(fullObject);
        objects.put(sha1, compress(fullObject));
        return sha1;
    }

    // git diff — uses Myers diff algorithm (LCS / edit distance DP)
    // Finds the shortest edit script to transform file A into file B
    // This is the same dynamic programming approach as LCS / edit distance
}
```

---

## Problems

### Easy Problems (P20.01 — P20.08)

**P20.01** [E] — Identify the Data Structure: Redis Sorted Set

Redis's ZRANGEBYSCORE command returns all members of a sorted set with scores between min and max, in O(log n + k) time where k is the number of results. What data structure enables this?

```java
// Answer: Skip list
//
// Redis sorted sets use a skip list for the ordered data.
// ZRANGEBYSCORE min max:
// 1. Binary-search-style traversal down the skip list levels to find the
//    first element with score >= min — O(log n)
// 2. Sequential forward iteration along the bottom level until score > max — O(k)
//
// Why not a balanced BST (Red-Black tree)?
// Skip lists are simpler to implement, have comparable performance,
// and are easier to make concurrent (lock-free skip lists exist).
// Redis is single-threaded, so concurrency is not the reason —
// Antirez (Redis author) chose skip lists for implementation simplicity
// and because they are easy to modify for rank queries (span tracking).
//
// The companion dict (hash table) provides O(1) lookup by member name:
// ZSCORE key member → dict.get(member) → O(1)
//
// Java equivalent: ConcurrentSkipListMap for thread-safe sorted operations,
// or TreeMap for single-threaded sorted operations.
```

**P20.02** [E] — Identify the Data Structure: Cassandra Read Path

When Cassandra reads a key that might be in any of 5 SSTables on disk, it first checks a small in-memory data structure per SSTable to avoid unnecessary disk reads. What is this structure?

```java
// Answer: Bloom filter
//
// Each SSTable has an associated Bloom filter loaded in memory.
// Read path:
// 1. Check memtable (in-memory TreeMap/skip list) — O(log n)
// 2. For each SSTable (newest first):
//    a. Check Bloom filter: mightContain(key)?
//       - If NO: skip this SSTable entirely (no disk I/O)
//       - If YES: proceed to step b (might be a false positive)
//    b. Check partition index (sparse index) → binary search for key
//    c. Read data block from disk
//
// With a 1% false positive rate and 5 SSTables:
// Expected unnecessary disk reads per miss = 5 × 0.01 = 0.05
// That is: 95% of the time, a key absent from ALL SSTables causes ZERO disk reads.
//
// Memory cost: ~10 bits per key × number of keys per SSTable
// For 10 million keys: ~12.5 MB per SSTable Bloom filter
//
// Java: BitSet or third-party Guava BloomFilter
// Cassandra uses its own optimized implementation with Murmur3 hash.
```

**P20.03** [E] — Identify the Data Structure: epoll

Linux epoll uses two data structures internally. What are they and why?

```java
// Answer: Red-Black tree + linked list
//
// 1. Red-Black tree (rbtree):
//    - Stores ALL monitored file descriptors
//    - epoll_ctl(EPOLL_CTL_ADD) → insert into RB-tree: O(log n)
//    - epoll_ctl(EPOLL_CTL_DEL) → remove from RB-tree: O(log n)
//    - Why RB-tree? Need O(log n) insert/delete for dynamic fd management.
//      A hash table would also work, but the kernel prefers RB-trees for
//      their bounded worst-case and no-rehashing property.
//
// 2. Linked list (rdllist — ready list):
//    - Contains ONLY file descriptors with pending events
//    - When a socket receives data, the kernel callback appends the fd's
//      epoll entry to the ready list: O(1)
//    - epoll_wait() returns entries from the ready list: O(ready count)
//    - Why linked list? Only need append and drain — both O(1) per element.
//
// This combination gives epoll its O(1) per-event efficiency:
// - Adding/removing fds: O(log n) — happens rarely
// - Returning ready events: O(ready count) — happens on every epoll_wait()
// - Compare with poll(): O(n) per call (scans all fds)
```

**P20.04** [E] — Identify the Data Structure: InnoDB Buffer Pool

InnoDB's buffer pool uses a modified LRU list split into "young" and "old" sublists. What problem does the split solve, and what data structure is it?

```java
// Answer: Modified LRU using a doubly-linked list with a midpoint insertion strategy
// (functionally similar to LinkedHashMap with access-order and a custom eviction policy)
//
// Problem without split:
// A full table scan (SELECT * FROM huge_table) reads every page.
// With standard LRU, these pages push all existing hot pages out of the buffer pool.
// After the scan, the buffer pool is full of cold scan pages and must reload
// all frequently-accessed pages from disk. This is called "LRU pollution."
//
// Solution: split the LRU into young (5/8) and old (3/8)
// New pages enter at the head of the OLD sublist, not the young sublist.
// A page is promoted to the YOUNG sublist only after it is accessed again
// AND at least innodb_old_blocks_time (default 1000ms) has passed.
//
// Effect on table scan:
// - Scan pages enter at old head
// - They are accessed once (during the scan) and never again
// - They stay in the old sublist and are quickly evicted
// - Hot pages in the young sublist are untouched
//
// Data structure: one doubly-linked list with a marker at the 5/8 point
// Operations: move-to-head (O(1)), remove-from-tail (O(1)), midpoint insert (O(1))
// HashMap for page lookup: pageId → list node (O(1))
```

**P20.05** [E] — Identify the Data Structure: Git Object Store

Git stores every file, directory, and commit as an object identified by its SHA-1 hash. What data structure is the object store?

```java
// Answer: Content-addressable hash map (HashMap<SHA1, Object>)
//
// Git's object store is a hash table where:
//   Key = SHA-1 hash of the object content (20 bytes / 40 hex chars)
//   Value = compressed object data (blob, tree, commit, or tag)
//
// Properties:
// 1. Deduplication: two files with identical content produce the same SHA-1
//    → stored only once. Renaming a file without changing content costs zero storage.
// 2. Integrity: any bit flip changes the hash → corruption is detected immediately.
// 3. Merkle tree: tree objects hash their children's hashes. The root commit hash
//    is a fingerprint of the entire project state.
//
// Storage:
// - Loose objects: .git/objects/ab/cdef1234... (one file per object, first 2 chars = directory)
//   This IS a hash table with 256 buckets (00-ff directories)
// - Packfiles: .git/objects/pack/ (multiple objects delta-compressed together)
//   Indexed by a .idx file (sorted by SHA-1 for binary search)
//
// Java equivalent: HashMap<String, byte[]> where key = hex SHA-1 string
```

**P20.06** [E] — Identify the Data Structure: DNS Cache

A DNS resolver caches domain→IP mappings with TTL. What data structure?

```java
// Answer: HashMap<String, DnsEntry> with time-based expiration
//
// DNS cache is a hash map where:
//   Key = domain name (e.g., "www.google.com")
//   Value = DNS record (IP address + TTL + timestamp)
//
// On lookup:
//   1. Check cache: O(1)
//   2. If hit and not expired (currentTime < insertTime + TTL): return cached IP
//   3. If miss or expired: query upstream DNS server, cache result with new TTL
//
// Java: ConcurrentHashMap<String, DnsCacheEntry> with lazy expiration
// JDK's own DNS cache: java.net.InetAddress caches DNS lookups.
//   networkaddress.cache.ttl = 30 (seconds, default in security manager)
//   networkaddress.cache.negative.ttl = 10 (cache "not found" results too)
//
// This is the same pattern as ARP cache (Section 20.2.3) and any TTL-based cache.
```

**P20.07** [E] — Identify the Data Structure: Build System Dependency Resolution

Maven/Gradle resolves dependencies by computing a build order. What algorithm and data structure are used?

```java
// Answer: Topological sort on a Directed Acyclic Graph (DAG)
//
// The dependency graph:
//   Nodes = modules/artifacts
//   Edges = "depends on" relationships (A → B means A depends on B)
//
// Build order = reverse topological sort:
//   B must be built before A (because A depends on B)
//
// Cycle detection: if the dependency graph has a cycle (A → B → C → A),
//   the build fails with "circular dependency detected."
//   This is cycle detection in a directed graph (DFS with back-edge detection).
//
// Algorithm: Kahn's algorithm (BFS-based topological sort)
//   1. Count in-degrees of all nodes
//   2. Enqueue nodes with in-degree 0 (no dependencies)
//   3. Process queue: dequeue node, reduce in-degree of dependents
//   4. Repeat until queue is empty
//   5. If processed count < total nodes: cycle exists
//
// Java: adjacency list (HashMap<String, List<String>>) + BFS queue (ArrayDeque)
//
// Spring @DependsOn uses the same algorithm for bean initialization order.
// Airflow uses it for DAG task scheduling.
```

**P20.08** [E] — Identify the Data Structure: CPU Cache Line

When the CPU loads a single int from main memory, it actually loads 64 bytes. What data structure concept does this map to?

```java
// Answer: Array with spatial locality (contiguous memory block)
//
// A CPU cache line is a fixed-size contiguous block (64 bytes on x86).
// When you access int[0], the CPU loads the entire 64 bytes containing:
//   int[0], int[1], int[2], ..., int[15] (16 ints × 4 bytes = 64 bytes)
//
// This is why arrays dominate linked structures for performance:
// - int[] traversal: 1 cache miss per 16 elements (sequential prefetching)
// - LinkedList traversal: up to 1 cache miss per element (random pointer chasing)
//
// Data structure implications:
// - ArrayList (backed by Object[]): good spatial locality for the reference array
//   (but objects pointed to are scattered on heap)
// - HashMap (backed by Node[]): reasonable locality for the bucket array,
//   but Node chains are pointer chases
// - int[]: best possible locality — contiguous, no indirection
//
// This is why "cache-oblivious" and "cache-aware" algorithms exist:
// they design access patterns to maximize cache line utilization.
// B+ trees have high fanout specifically to fit more keys per cache line / disk page.
```

### Medium Problems (P20.09 — P20.22)

**P20.09** [M] — Design: Rate Limiter with Sliding Window

Design a rate limiter that allows at most K requests per T-second window. Map this to the sliding window pattern and choose appropriate data structures.

```java
// Solution: Sliding window log using a Queue (ArrayDeque)
public class SlidingWindowRateLimiter {
    private final int maxRequests;        // K
    private final long windowSizeMs;      // T * 1000
    private final Deque<Long> timestamps; // queue of request timestamps

    public SlidingWindowRateLimiter(int maxRequests, long windowSizeMs) {
        this.maxRequests = maxRequests;
        this.windowSizeMs = windowSizeMs;
        this.timestamps = new ArrayDeque<>();
    }

    public synchronized boolean allowRequest() {
        long now = System.currentTimeMillis();
        long windowStart = now - windowSizeMs;

        // Slide window: remove expired timestamps from the front
        while (!timestamps.isEmpty() && timestamps.peekFirst() <= windowStart) {
            timestamps.pollFirst();  // O(1) — same as sliding window left pointer
        }

        if (timestamps.size() < maxRequests) {
            timestamps.addLast(now);  // O(1) — same as sliding window right pointer
            return true;
        }
        return false;  // rate limit exceeded
    }

    // Analysis:
    // Time: O(1) amortized (each timestamp is added once, removed once)
    // Space: O(K) — at most K timestamps in the queue
    //
    // Real-world mapping:
    // - TCP sliding window: window of unACK'd bytes ↔ window of request timestamps
    // - Kafka consumer: window of uncommitted offsets
    // - Stream processing: time-based tumbling/sliding windows
    //
    // For distributed rate limiting: use Redis sorted set
    // ZADD key timestamp timestamp
    // ZREMRANGEBYSCORE key 0 (now - window)
    // ZCARD key → current count
    // All O(log n) operations on Redis skip list
}

// Alternative: Fixed window counter (simpler but less accurate)
// HashMap<windowId, AtomicInteger> where windowId = currentSecond / T
// Problem: burst at window boundary allows 2K requests in T seconds
```

**P20.10** [M] — Design: LRU Cache with O(1) Operations

Implement an LRU cache that maps directly to how database buffer pools and CPU caches work.

```java
// Solution: HashMap + doubly-linked list (same as LinkedHashMap accessOrder=true)
public class LRUCache<K, V> {
    private static class Node<K, V> {
        K key;
        V value;
        Node<K, V> prev, next;
        Node(K key, V value) { this.key = key; this.value = value; }
    }

    private final int capacity;
    private final Map<K, Node<K, V>> map;   // O(1) lookup
    private final Node<K, V> head, tail;     // doubly-linked list for LRU ordering

    public LRUCache(int capacity) {
        this.capacity = capacity;
        this.map = new HashMap<>(capacity);
        head = new Node<>(null, null);
        tail = new Node<>(null, null);
        head.next = tail;
        tail.prev = head;
    }

    public V get(K key) {
        Node<K, V> node = map.get(key);
        if (node == null) return null;
        moveToFront(node);   // mark as most recently used
        return node.value;
    }

    public void put(K key, V value) {
        Node<K, V> node = map.get(key);
        if (node != null) {
            node.value = value;
            moveToFront(node);
            return;
        }
        if (map.size() >= capacity) {
            Node<K, V> victim = tail.prev;   // LRU node
            removeNode(victim);
            map.remove(victim.key);
        }
        node = new Node<>(key, value);
        addToFront(node);
        map.put(key, node);
    }

    private void moveToFront(Node<K, V> node) {
        removeNode(node);
        addToFront(node);
    }

    private void removeNode(Node<K, V> node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }

    private void addToFront(Node<K, V> node) {
        node.next = head.next;
        node.prev = head;
        head.next.prev = node;
        head.next = node;
    }

    // Real-world instances of this EXACT data structure:
    // 1. InnoDB buffer pool (Section 20.4.4)
    // 2. Linux page cache (struct page + LRU list)
    // 3. CPU TLB replacement (hardware LRU approximation)
    // 4. Redis maxmemory-policy allkeys-lru (approximated LRU via sampling)
    // 5. Memcached slab LRU (per-slab-class LRU list)
    // 6. LinkedHashMap(capacity, 0.75f, true) in JDK
}
```

**P20.11** [M] — Design: Consistent Hash Ring with Virtual Nodes

Given a system with 5 servers and 1000 keys, demonstrate that adding a 6th server only remaps ~1/6 of keys.

```java
// Solution: TreeMap-based consistent hash ring
public class ConsistentHashDemo {
    private final TreeMap<Integer, String> ring = new TreeMap<>();
    private final int virtualNodes;
    private final Map<String, Set<Integer>> serverHashes = new HashMap<>();

    public ConsistentHashDemo(int virtualNodes) {
        this.virtualNodes = virtualNodes;
    }

    public void addServer(String server) {
        Set<Integer> hashes = new HashSet<>();
        for (int i = 0; i < virtualNodes; i++) {
            int hash = hash(server + "#" + i);
            ring.put(hash, server);
            hashes.add(hash);
        }
        serverHashes.put(server, hashes);
    }

    public void removeServer(String server) {
        Set<Integer> hashes = serverHashes.remove(server);
        if (hashes != null) {
            for (int hash : hashes) ring.remove(hash);
        }
    }

    public String getServer(String key) {
        if (ring.isEmpty()) return null;
        int hash = hash(key);
        Map.Entry<Integer, String> entry = ring.ceilingEntry(hash);
        return entry != null ? entry.getValue() : ring.firstEntry().getValue();
    }

    public static void demonstrateMinimalDisruption() {
        ConsistentHashDemo ch = new ConsistentHashDemo(150);

        // Add 5 servers
        for (int i = 1; i <= 5; i++) ch.addServer("server" + i);

        // Map 1000 keys
        Map<String, String> before = new HashMap<>();
        for (int i = 0; i < 1000; i++) {
            String key = "key" + i;
            before.put(key, ch.getServer(key));
        }

        // Add 6th server
        ch.addServer("server6");

        // Check how many keys changed
        int remapped = 0;
        for (int i = 0; i < 1000; i++) {
            String key = "key" + i;
            if (!before.get(key).equals(ch.getServer(key))) {
                remapped++;
            }
        }

        // Expected: ~1000/6 ≈ 167 keys remapped (only ~16.7%)
        // Without consistent hashing (modulo N): ~833 keys remapped (83.3%)
        System.out.println("Keys remapped: " + remapped + " / 1000");
    }

    private int hash(String key) {
        // Use a good hash function (MurmurHash3 or MD5 truncated)
        int h = key.hashCode();
        h ^= (h >>> 16);
        return h;
    }
}
```

**P20.12** [M] — Design: Log-Structured Merge Tree Write Path

Implement the write path of an LSM tree, showing how writes flow from memtable to SSTable.

```java
// Solution: TreeMap memtable → sorted SSTable flush → merge compaction
public class LsmWritePath {
    private TreeMap<String, String> activeMemtable = new TreeMap<>();
    private TreeMap<String, String> immutableMemtable = null;
    private final List<SortedSSTable> sstables = new ArrayList<>();
    private static final int MEMTABLE_SIZE_LIMIT = 4_000_000; // 4MB
    private int currentSize = 0;

    // Write: always goes to memtable (in-memory, sorted)
    public void put(String key, String value) {
        activeMemtable.put(key, value);
        currentSize += key.length() + value.length();

        if (currentSize >= MEMTABLE_SIZE_LIMIT) {
            flushMemtable();
        }
    }

    // Delete: write a tombstone marker
    public void delete(String key) {
        put(key, "TOMBSTONE");  // same write path, special value
        // Tombstone is kept until compaction removes it
    }

    private void flushMemtable() {
        // 1. Swap: current memtable becomes immutable, create new active
        immutableMemtable = activeMemtable;
        activeMemtable = new TreeMap<>();
        currentSize = 0;

        // 2. Write immutable memtable as sorted SSTable to disk
        // Since TreeMap is already sorted, iteration is sequential
        SortedSSTable sst = new SortedSSTable();
        for (Map.Entry<String, String> entry : immutableMemtable.entrySet()) {
            sst.append(entry.getKey(), entry.getValue());
        }
        sst.writeBloomFilter();   // build Bloom filter for this SSTable
        sst.writeIndex();         // write sparse index (every Nth key → file offset)
        sst.close();
        sstables.add(sst);

        immutableMemtable = null;

        // 3. Check if compaction is needed (too many SSTables at a level)
        maybeCompact();
    }

    private void maybeCompact() {
        // Compaction = merge sort of two or more SSTables
        // Produces one new SSTable, discards duplicates (keep newest)
        // This is the merge step from merge sort — two sorted sequences → one
        if (sstables.size() > 4) {
            SortedSSTable merged = mergeSSTables(sstables.subList(0, 4));
            sstables.subList(0, 4).clear();
            sstables.add(0, merged);
        }
    }

    private SortedSSTable mergeSSTables(List<SortedSSTable> tables) {
        // K-way merge using a PriorityQueue (min-heap)
        // This is "merge K sorted lists" — a classic heap problem
        PriorityQueue<SSTIterator> pq = new PriorityQueue<>(
            Comparator.comparing(SSTIterator::currentKey));

        for (SortedSSTable sst : tables) {
            SSTIterator it = sst.iterator();
            if (it.hasNext()) {
                it.advance();
                pq.offer(it);
            }
        }

        SortedSSTable result = new SortedSSTable();
        String lastKey = null;
        while (!pq.isEmpty()) {
            SSTIterator it = pq.poll();
            String key = it.currentKey();
            String value = it.currentValue();

            // Skip duplicates (keep first = newest because of ordering)
            if (!key.equals(lastKey)) {
                if (!"TOMBSTONE".equals(value)) {
                    result.append(key, value);
                }
                lastKey = key;
            }

            if (it.hasNext()) {
                it.advance();
                pq.offer(it);
            }
        }
        return result;
    }
}
```

**P20.13** [M] — Analyze: Why Does CFS Use a Red-Black Tree?

Compare the CFS scheduler's choice of Red-Black tree against alternatives (heap, sorted array, hash table). Justify the kernel's choice.

```java
// Analysis:
//
// CFS needs these operations on its run queue:
// 1. Insert (task becomes runnable): O(log n)
// 2. Remove (task is selected to run or blocks): O(log n)
// 3. Find minimum (lowest vruntime — next task to run): O(1) with caching
// 4. Iterate in order (for debugging/monitoring): O(n)
//
// Alternative 1: Min-Heap (PriorityQueue)
//   Insert: O(log n) ✓
//   Remove min: O(log n) ✓
//   Remove arbitrary: O(n) ✗ — heap does not support efficient arbitrary removal
//   Problem: when a task blocks (e.g., waiting for I/O), it must be removed
//   from the run queue. In a heap, finding an arbitrary element is O(n).
//   CFS removes tasks frequently (on every context switch and I/O block).
//   VERDICT: O(n) arbitrary removal is unacceptable in a scheduler.
//
// Alternative 2: Sorted Array
//   Insert: O(n) — must shift elements to maintain order
//   Remove: O(n) — must shift elements to fill gap
//   Find min: O(1) ✓
//   Problem: O(n) insert/remove. With 1000 runnable tasks, every context
//   switch (every ~4ms) would require shifting hundreds of elements.
//   VERDICT: O(n) operations in the scheduler hot path are unacceptable.
//
// Alternative 3: Hash Table
//   Insert: O(1) ✓
//   Remove: O(1) ✓
//   Find min: O(n) ✗ — must scan all entries to find minimum
//   Problem: CFS picks the task with lowest vruntime on every context switch.
//   O(n) find-min means every scheduling decision is O(n).
//   VERDICT: O(n) find-min defeats the purpose of a scheduler.
//
// Alternative 4: AVL Tree
//   Same complexity as Red-Black tree for all operations.
//   But AVL trees require more rotations on average (stricter balance).
//   More rotations = more pointer updates = more cache line invalidations.
//   Red-Black trees guarantee at most 2 rotations per insert.
//   VERDICT: Red-Black is slightly better for write-heavy workloads.
//
// Red-Black Tree:
//   Insert: O(log n) ✓ (at most 2 rotations)
//   Remove: O(log n) ✓ (at most 3 rotations)
//   Find min: O(1) with cached leftmost ✓
//   Remove arbitrary: O(log n) ✓ (given pointer to node)
//   VERDICT: Best overall for CFS's operation mix.
//
// The kernel also needs the guarantee of bounded worst-case behavior.
// Hash tables have amortized O(1) but worst-case O(n) during rehash.
// The scheduler cannot pause for a rehash during a context switch.
// Red-Black trees have O(log n) WORST CASE — no surprises.
```

**P20.14** [M] — Design: Connection Pool

Design a database connection pool. Map every data structure choice to a real-world analogy.

```java
// Solution: Queue + Semaphore + HashMap for tracking
public class ConnectionPool {
    private final BlockingQueue<Connection> availableConnections; // idle connections
    private final Set<Connection> activeConnections;              // in-use connections
    private final Semaphore permits;                              // limit concurrency
    private final int maxPoolSize;

    public ConnectionPool(int maxPoolSize) {
        this.maxPoolSize = maxPoolSize;
        // ArrayBlockingQueue: bounded, FIFO — like Tomcat's thread pool work queue
        this.availableConnections = new ArrayBlockingQueue<>(maxPoolSize);
        // ConcurrentHashMap.newKeySet: for tracking active connections
        this.activeConnections = ConcurrentHashMap.newKeySet();
        this.permits = new Semaphore(maxPoolSize);
    }

    public Connection acquire(long timeoutMs) throws InterruptedException, SQLException {
        // Semaphore: like TCP's congestion window — limits concurrent usage
        if (!permits.tryAcquire(timeoutMs, TimeUnit.MILLISECONDS)) {
            throw new SQLException("Connection pool exhausted");
        }

        // Try to get existing idle connection (FIFO — like queue)
        Connection conn = availableConnections.poll();

        if (conn == null || !conn.isValid(1)) {
            // No idle connection or it is stale — create new one
            // Like slab allocator: check free list first, allocate new if empty
            conn = createNewConnection();
        }

        activeConnections.add(conn);  // track active connections (HashSet)
        return conn;
    }

    public void release(Connection conn) {
        activeConnections.remove(conn);

        if (conn.isValid(1)) {
            availableConnections.offer(conn);  // return to pool (enqueue)
        } else {
            closeQuietly(conn);                // discard invalid connection
        }
        permits.release();  // allow another thread to acquire
    }

    // Data structure mapping:
    // ArrayBlockingQueue (idle pool) ↔ circular buffer of ready connections
    // ConcurrentHashMap.newKeySet (active tracking) ↔ connection tracking table (like netfilter)
    // Semaphore ↔ TCP congestion window (limits concurrent usage)
    // Connection validation ↔ health check / heartbeat (like TCP keepalive)
}
```

**P20.15** [M] — Design: Distributed Cache Read Path

Trace the complete data structure path for a cache read in a distributed system like Memcached.

```java
// Solution: client-side consistent hash → network → server-side hash table
public class DistributedCacheRead {

    // Step 1: Client-side — consistent hashing to find the right server
    // Data structure: TreeMap<Integer, ServerNode> (consistent hash ring)
    public ServerNode findServer(String key) {
        int hash = murmur3(key);
        // TreeMap.ceilingEntry: O(log n) where n = total virtual nodes (~500-1000)
        Map.Entry<Integer, ServerNode> entry = ring.ceilingEntry(hash);
        return entry != null ? entry.getValue() : ring.firstEntry().getValue();
    }

    // Step 2: Network — TCP connection to server
    // Data structure: connection pool (ArrayBlockingQueue of Socket connections)
    // Protocol: binary memcached protocol (key length + key + flags)
    // See P20.14 for connection pool design

    // Step 3: Server-side — hash table lookup
    // Data structure: HashMap<byte[], CacheItem> (Memcached uses its own hash table)
    // Memcached hash table: open addressing with linear probing
    // Each item: key + value + flags + TTL + CAS token
    // LRU eviction per slab class when memory is full

    // Step 4: Slab allocator for memory management
    // Data structure: array of slab classes (each class = free list of fixed-size chunks)
    // Slab class 1: chunks of 96 bytes (items up to 96B)
    // Slab class 2: chunks of 120 bytes
    // ...
    // Slab class 42: chunks of 1 MB (maximum item size)
    // Within each class: free list of available chunks (like Linux slab allocator)

    // Complete read path:
    // 1. murmur3(key) → consistent hash ring → server3          [O(log V), V=virtual nodes]
    // 2. pool.acquire() → TCP socket to server3                  [O(1) amortized]
    // 3. send("GET key\r\n") → network                          [network latency]
    // 4. server3.hashtable.get(key)                              [O(1)]
    // 5. if hit: return value via TCP                            [network latency]
    //    if miss: return MISS, application fetches from DB
    //
    // Total: ~2 network hops + O(log V) + O(1)
    // Typical latency: 0.5-2ms (dominated by network, not data structures)
}
```

**P20.16** [M] — Analyze: Git Merge Algorithm

When Git performs a three-way merge, it finds the LCA of two commits in the DAG and then runs a diff algorithm. Map each step to DSA concepts.

```java
// Analysis:
//
// Step 1: Find the merge base (LCA)
//   Git commit graph is a DAG (Directed Acyclic Graph)
//   Finding the merge base = finding the Lowest Common Ancestor (LCA)
//
//   git merge-base branch1 branch2
//   Algorithm: BFS from both commits simultaneously, first shared ancestor is LCA
//   This is bidirectional BFS on a DAG — O(N) where N = commits between tips and LCA
//
//   More precisely, Git uses the "recursive merge" strategy which can handle
//   multiple merge bases (criss-cross merges) by recursively merging the merge bases.

// Step 2: Three-way diff
//   Given: BASE (LCA), OURS (branch1), THEIRS (branch2)
//   For each file:
//     diff(BASE, OURS)   → our changes
//     diff(BASE, THEIRS) → their changes
//   The diff algorithm is Myers' diff: finds shortest edit script (SES)
//   This is LCS (Longest Common Subsequence) via DP — O(ND) where
//   N = file length, D = number of differences

// Step 3: Three-way merge
//   For each hunk:
//     If only OURS changed: take our change
//     If only THEIRS changed: take their change
//     If both changed the same region: CONFLICT (manual resolution needed)
//     If both made the identical change: take either (auto-resolve)
//
// Data structures involved:
//   1. Commit DAG: adjacency list (commit → parent commits)
//   2. BFS for LCA: Queue (ArrayDeque) + visited Set (HashSet)
//   3. Myers' diff: DP matrix (2D array, optimized to 1D)
//   4. Three-way merge: merge of two diff sequences (like merge sort merge step)
//   5. Conflict markers: in-place text insertion

// Java pseudocode for merge base:
public String findMergeBase(String commit1, String commit2,
                             Map<String, List<String>> parents) {
    Set<String> ancestors1 = new HashSet<>();
    Queue<String> queue1 = new ArrayDeque<>();
    Queue<String> queue2 = new ArrayDeque<>();

    queue1.add(commit1);
    queue2.add(commit2);

    // BFS from both commits — find first common ancestor
    while (!queue1.isEmpty() || !queue2.isEmpty()) {
        if (!queue1.isEmpty()) {
            String c = queue1.poll();
            if (!ancestors1.add(c)) continue;
            queue1.addAll(parents.getOrDefault(c, List.of()));
        }
        // Check if commit2's ancestors hit ancestors1
        if (!queue2.isEmpty()) {
            String c = queue2.poll();
            if (ancestors1.contains(c)) return c;  // found LCA
            queue2.addAll(parents.getOrDefault(c, List.of()));
        }
    }
    return null; // no common ancestor (unrelated histories)
}
```

**P20.17** [M] — Design: Implement a Timer Wheel

Design a timer system like those used in Kafka, Netty, and the Linux kernel. Explain why a priority queue is not ideal for millions of timers.

```java
// Solution: Hierarchical timing wheel (used by Kafka, Netty, Linux)
public class TimerWheel {
    // Problem with PriorityQueue:
    // - Insert: O(log n) — with 10 million timers, that is 23 comparisons per insert
    // - Cancel: O(n) to find the timer, O(log n) to remove
    // - For a high-throughput server with millions of timers: too slow
    //
    // Timer wheel: O(1) insert, O(1) cancel, O(1) expire per timer

    static class TimerTask {
        Runnable action;
        long deadline;
        int bucketIndex;        // for O(1) cancel
        TimerTask prev, next;   // doubly-linked list within bucket
    }

    private final TimerTask[] wheel;   // circular array of bucket linked lists
    private final int wheelSize;       // number of buckets (e.g., 512)
    private final long tickDuration;   // time per bucket (e.g., 1ms)
    private int currentTick = 0;

    public TimerWheel(int wheelSize, long tickDurationMs) {
        this.wheelSize = wheelSize;
        this.tickDuration = tickDurationMs;
        this.wheel = new TimerTask[wheelSize];  // sentinel nodes for each bucket
    }

    // Insert: O(1) — compute bucket index, append to bucket's linked list
    public void schedule(TimerTask task, long delayMs) {
        long ticks = delayMs / tickDuration;
        int bucket = (int)((currentTick + ticks) % wheelSize);
        task.bucketIndex = bucket;

        // Add to bucket's doubly-linked list
        TimerTask head = wheel[bucket];
        if (head != null) {
            task.next = head;
            head.prev = task;
        }
        wheel[bucket] = task;
    }

    // Cancel: O(1) — unlink from doubly-linked list
    public void cancel(TimerTask task) {
        if (task.prev != null) task.prev.next = task.next;
        if (task.next != null) task.next.prev = task.prev;
        if (wheel[task.bucketIndex] == task) {
            wheel[task.bucketIndex] = task.next;
        }
    }

    // Tick: expire all timers in current bucket
    public void tick() {
        TimerTask task = wheel[currentTick];
        while (task != null) {
            TimerTask next = task.next;
            task.action.run();  // fire the timer
            task = next;
        }
        wheel[currentTick] = null;
        currentTick = (currentTick + 1) % wheelSize;
    }

    // For timers with delays > wheelSize * tickDuration:
    // Use hierarchical wheels (like Kafka):
    // Wheel 1: 1ms resolution, 512 buckets = 512ms range
    // Wheel 2: 512ms resolution, 512 buckets = 262s range
    // Wheel 3: 262s resolution, 512 buckets = ~37 hours range
    // Timer cascades from higher wheel to lower wheel as deadline approaches.
}
```

**P20.18** [M] — Analyze: Kafka vs. RabbitMQ Data Structures

Compare the core data structures of Kafka (append-only log) vs. RabbitMQ (priority queue). When does each win?

```java
// Analysis:
//
// Kafka: append-only partitioned log
//   Write: append to end of log segment — O(1), sequential I/O
//   Read: seek to offset, read forward — O(1) seek + O(k) sequential read
//   Ordering: total order within a partition (offset = sequence number)
//   Persistence: all messages persisted (no concept of "consumed = deleted")
//   Consumer state: consumer maintains its own offset (HashMap<partition, offset>)
//   Replay: consumers can re-read from any offset (rewind)
//
//   Data structures:
//   - Log segment: append-only file (array on disk)
//   - Segment index: sparse offset→position map (sorted array, binary search)
//   - Consumer offset: HashMap in __consumer_offsets topic
//   - Partition assignment: consistent hashing / range partitioning
//
// RabbitMQ: message broker with queues
//   Write: enqueue to named queue — O(1)
//   Read: dequeue + ACK — O(1) (message deleted after ACK)
//   Ordering: FIFO within a queue
//   Persistence: optional, message deleted after consumer ACK
//   Consumer state: broker tracks delivery state (UNACKED, ACKED, NACKED)
//   Replay: not possible (message deleted after ACK)
//
//   Data structures:
//   - Queue: linked list or array-based queue (persistent: written to disk)
//   - Exchange routing: topic exchange = trie (for wildcard matching)
//   - Priority queue: for messages with priority (PriorityQueue<Message>)
//   - Consumer tracking: HashMap<deliveryTag, ConsumerState>
//
// When Kafka wins:
// - High throughput (100K+ msgs/sec): sequential I/O >> random I/O
// - Consumer replay needed: event sourcing, stream processing
// - Multiple consumers need the same data: each consumer reads independently
// - Long retention needed (hours/days/weeks)
//
// When RabbitMQ wins:
// - Message priority needed: RabbitMQ has built-in priority queues
// - Complex routing (topic/header matching): RabbitMQ's exchange system
// - Low latency for small messages: simpler protocol, less overhead
// - Traditional work queue (each message processed by exactly one worker)
//
// Hybrid approach: many production systems use both:
// Kafka for event streaming (high volume, ordered, replayable)
// RabbitMQ for task queues (work distribution, priority, ACK-based)
```

**P20.19** [M] — Design: Implement a Bloom Filter for SSTable

Build a Bloom filter that Cassandra would use for an SSTable with 1 million keys and a target 1% false positive rate.

```java
// Solution: Bloom filter with optimal parameters
public class SSTableBloomFilter {
    private final long[] bits;      // bit array (using long[] for 64-bit words)
    private final int numBits;
    private final int numHashFunctions;

    // For n=1,000,000 elements, p=0.01 (1% false positive):
    // numBits = -(n * ln(p)) / (ln(2))^2 = -(1M * ln(0.01)) / (ln(2))^2
    //         = -(1M * -4.605) / 0.4805 = 9,585,059 ≈ 9.6 million bits ≈ 1.2 MB
    // numHashFunctions = (numBits/n) * ln(2) = 9.58 * 0.693 = 6.64 ≈ 7

    public SSTableBloomFilter(int expectedElements, double falsePositiveRate) {
        this.numBits = optimalBits(expectedElements, falsePositiveRate);
        this.numHashFunctions = optimalHashes(numBits, expectedElements);
        this.bits = new long[(numBits + 63) / 64]; // round up to long boundary
    }

    public void add(byte[] key) {
        long hash64 = murmur3_64(key);
        int h1 = (int) hash64;
        int h2 = (int) (hash64 >>> 32);

        // Double hashing technique: h(i) = h1 + i*h2
        // Generates k independent hash functions from 2 hash values
        for (int i = 0; i < numHashFunctions; i++) {
            int combinedHash = h1 + i * h2;
            int bitIndex = (combinedHash & Integer.MAX_VALUE) % numBits;
            bits[bitIndex / 64] |= (1L << (bitIndex % 64));
        }
    }

    public boolean mightContain(byte[] key) {
        long hash64 = murmur3_64(key);
        int h1 = (int) hash64;
        int h2 = (int) (hash64 >>> 32);

        for (int i = 0; i < numHashFunctions; i++) {
            int combinedHash = h1 + i * h2;
            int bitIndex = (combinedHash & Integer.MAX_VALUE) % numBits;
            if ((bits[bitIndex / 64] & (1L << (bitIndex % 64))) == 0) {
                return false;  // definitely not present
            }
        }
        return true;  // probably present
    }

    private static int optimalBits(int n, double p) {
        return (int) Math.ceil(-n * Math.log(p) / (Math.log(2) * Math.log(2)));
    }

    private static int optimalHashes(int m, int n) {
        return Math.max(1, (int) Math.round((double) m / n * Math.log(2)));
    }

    // Performance analysis for Cassandra read path:
    //
    // Without Bloom filter:
    //   Read miss → check ALL SSTables → 5 disk reads (if 5 SSTables)
    //   Latency: 5 × 5ms (SSD random read) = 25ms
    //
    // With Bloom filter (1% false positive):
    //   Read miss → check Bloom filter per SSTable
    //   Expected disk reads: 5 × 0.01 = 0.05 (5% chance of ONE unnecessary read)
    //   Latency: 0.05 × 5ms = 0.25ms average
    //   Speedup: 100x for read misses
    //
    // Memory cost: 1.2 MB per SSTable × 100 SSTables = 120 MB
    //   Easily fits in RAM, saves thousands of disk I/Os per second
}
```

**P20.20** [M] — Design: Event Sourcing Store

Design an event store using append-only logs. Map to Kafka, WAL, and Raft log concepts.

```java
// Solution: Append-only event log with snapshots
public class EventStore {
    // Events are IMMUTABLE — append-only, never modified
    // Same concept as: Kafka log, database WAL, Raft log, Git commit history
    static class Event {
        final long sequenceNumber;    // like Kafka offset, WAL LSN, Raft log index
        final long timestamp;
        final String aggregateId;     // which entity this event belongs to
        final String eventType;       // "OrderCreated", "OrderShipped", etc.
        final byte[] data;            // serialized event data
    }

    // Log: append-only list of events (partitioned by aggregate ID)
    // Like Kafka: partition key = aggregateId, offset = sequenceNumber
    private final Map<String, List<Event>> eventLog = new ConcurrentHashMap<>();
    private final AtomicLong globalSequence = new AtomicLong(0);

    // Append event — O(1), sequential write
    public long append(String aggregateId, String eventType, byte[] data) {
        Event event = new Event();
        // ... set fields with globalSequence.incrementAndGet() ...
        eventLog.computeIfAbsent(aggregateId, k -> new ArrayList<>()).add(event);
        return event.sequenceNumber;
    }

    // Replay: rebuild state from events (like Raft applying log to state machine)
    public Object replayAggregate(String aggregateId) {
        List<Event> events = eventLog.getOrDefault(aggregateId, List.of());
        Object state = null;
        for (Event event : events) {
            state = applyEvent(state, event);  // fold over events
        }
        return state;
    }

    // Optimization: snapshots (like database checkpoints, Raft snapshots)
    // Every N events, save a snapshot of the current state
    // Replay: load last snapshot + replay events since snapshot
    // Same concept as Raft compaction: replace prefix of log with snapshot
    private final Map<String, Object[]> snapshots = new ConcurrentHashMap<>(); // aggregateId → [state, lastEventSeq]

    public Object replayWithSnapshot(String aggregateId) {
        Object[] snapshot = snapshots.get(aggregateId);
        Object state = snapshot != null ? snapshot[0] : null;
        long startSeq = snapshot != null ? (long) snapshot[1] + 1 : 0;

        List<Event> events = eventLog.getOrDefault(aggregateId, List.of());
        for (Event event : events) {
            if (event.sequenceNumber >= startSeq) {
                state = applyEvent(state, event);
            }
        }
        return state;
    }
}
```

**P20.21** [M] — Analyze: HashMap vs. TreeMap in Production Contexts

For each real-world scenario, choose HashMap or TreeMap and justify with complexity and cache analysis.

```java
// Scenario 1: Spring bean container (bean name → bean instance)
// Answer: HashMap (ConcurrentHashMap)
// Justification: bean lookup is always by exact name (O(1)).
// No need for range queries or sorted iteration.
// Spring has ~hundreds to thousands of beans — HashMap is ideal.

// Scenario 2: CFS scheduler (vruntime → task)
// Answer: TreeMap (Red-Black tree)
// Justification: CFS needs find-min (lowest vruntime) on every context switch.
// HashMap cannot find min in O(1) — would need O(n) scan.
// TreeMap: O(1) firstKey(), O(log n) insert/remove.

// Scenario 3: DNS cache (domain → IP)
// Answer: HashMap
// Justification: DNS lookups are always exact-match (O(1)).
// No need to find "all domains starting with 'google'" (that would be a trie).

// Scenario 4: Database index on a column with range queries
// Answer: TreeMap (B+ tree in practice)
// Justification: WHERE price BETWEEN 100 AND 500 requires range iteration.
// HashMap can only do exact-match lookups.
// B+ tree (which is a disk-oriented TreeMap): O(log n) seek + O(k) range scan.

// Scenario 5: Consistent hash ring (hash → server)
// Answer: TreeMap
// Justification: consistent hashing needs ceilingEntry(hash) — find the
// first server at or after the hash position. This is a range operation.
// HashMap has no concept of "next key after X."

// Scenario 6: Memcached key-value cache (key → value)
// Answer: HashMap
// Justification: cache lookups are always by exact key. O(1) required
// for million-request-per-second throughput. TreeMap's O(log n) adds
// 20+ comparisons per lookup — too slow for latency-critical caches.

// Scenario 7: IP routing table (prefix → next hop)
// Answer: Neither — Trie (but TreeMap can approximate)
// Justification: need longest prefix match, not exact match or range scan.
// A trie walks the prefix bit by bit. TreeMap.floorEntry could work
// for prefix matching but is less efficient than a specialized trie.

// Summary rule:
// HashMap: exact-match lookups, maximum throughput, cache-friendly (array-backed)
// TreeMap: ordered data, range queries, find-min/max, floor/ceiling operations
```

**P20.22** [M] — Design: Implement Vector Clock Merge

Implement vector clock comparison and merge for a distributed key-value store, handling concurrent writes.

```java
// Solution: Vector clock with comparison and merge
public class VectorClockStore {

    enum Relationship { BEFORE, AFTER, CONCURRENT, EQUAL }

    static class VectorClock {
        private final int[] clock;

        VectorClock(int numNodes) { this.clock = new int[numNodes]; }
        VectorClock(int[] clock) { this.clock = clock.clone(); }

        void increment(int nodeId) { clock[nodeId]++; }

        static Relationship compare(VectorClock a, VectorClock b) {
            boolean aBeforeB = false, bBeforeA = false;
            for (int i = 0; i < a.clock.length; i++) {
                if (a.clock[i] < b.clock[i]) aBeforeB = true;
                if (a.clock[i] > b.clock[i]) bBeforeA = true;
            }
            if (!aBeforeB && !bBeforeA) return Relationship.EQUAL;
            if (aBeforeB && !bBeforeA) return Relationship.BEFORE;
            if (bBeforeA && !aBeforeB) return Relationship.AFTER;
            return Relationship.CONCURRENT;  // incomparable — conflict!
        }

        static VectorClock merge(VectorClock a, VectorClock b) {
            int[] merged = new int[a.clock.length];
            for (int i = 0; i < merged.length; i++) {
                merged[i] = Math.max(a.clock[i], b.clock[i]);
            }
            return new VectorClock(merged);
        }
    }

    // Distributed KV store with conflict detection
    static class VersionedValue {
        String value;
        VectorClock version;
    }

    private final Map<String, List<VersionedValue>> store = new ConcurrentHashMap<>();

    public void put(String key, String value, VectorClock clientClock, int nodeId) {
        clientClock.increment(nodeId);

        List<VersionedValue> existing = store.getOrDefault(key, new ArrayList<>());
        List<VersionedValue> surviving = new ArrayList<>();

        for (VersionedValue ev : existing) {
            Relationship rel = VectorClock.compare(ev.version, clientClock);
            if (rel == Relationship.BEFORE || rel == Relationship.EQUAL) {
                // Old version — superseded by new write. Discard.
            } else if (rel == Relationship.AFTER) {
                // Existing version is NEWER than our write. Keep existing, discard ours.
                surviving.add(ev);
                store.put(key, surviving);
                return;
            } else {
                // CONCURRENT — keep both (sibling values)
                surviving.add(ev);
            }
        }

        VersionedValue newEntry = new VersionedValue();
        newEntry.value = value;
        newEntry.version = clientClock;
        surviving.add(newEntry);
        store.put(key, surviving);

        // If surviving.size() > 1, we have siblings (concurrent writes)
        // Client must resolve on next read (read-repair)
        // DynamoDB: returns all siblings, application decides
        // Riak: same approach (before switching to CRDTs)
    }
}
```

### Hard Problems (P20.23 — P20.30)

**P20.23** [H] — Design: Full LSM Tree with Compaction

Implement a complete LSM tree with leveled compaction, Bloom filters, and sparse indexes. Analyze the write amplification.

```java
// Solution: Full LSM tree with leveled compaction
public class LeveledLsmTree {
    private static final int MEMTABLE_SIZE = 4_000_000;   // 4 MB
    private static final int LEVEL_SIZE_RATIO = 10;        // each level is 10x larger
    private static final int L0_COMPACTION_TRIGGER = 4;    // compact when L0 has 4 SSTables

    private TreeMap<String, String> memtable = new TreeMap<>();
    private int memtableSize = 0;

    // levels[i] = list of SSTables at level i
    // Each SSTable has: sorted data, Bloom filter, sparse index
    private final List<List<SSTable>> levels = new ArrayList<>();

    static class SSTable {
        String[] keys;          // sorted keys
        String[] values;        // values parallel to keys
        BloomFilter bloom;      // for negative lookups
        int[] sparseIndex;      // every 16th key → position (for binary search)
        long minKey, maxKey;    // key range for level-overlap detection
        long size;              // bytes

        String get(String key) {
            if (!bloom.mightContain(key.getBytes())) return null;  // Bloom says no
            int pos = Arrays.binarySearch(keys, key);
            return pos >= 0 ? values[pos] : null;
        }
    }

    public void put(String key, String value) {
        memtable.put(key, value);
        memtableSize += key.length() + value.length();

        if (memtableSize >= MEMTABLE_SIZE) {
            flushToL0();
        }
    }

    public String get(String key) {
        // 1. MemTable (newest data)
        String v = memtable.get(key);
        if (v != null) return v.equals("__TOMBSTONE__") ? null : v;

        // 2. L0 SSTables (may overlap, check all, newest first)
        if (levels.size() > 0) {
            List<SSTable> l0 = levels.get(0);
            for (int i = l0.size() - 1; i >= 0; i--) {
                v = l0.get(i).get(key);
                if (v != null) return v.equals("__TOMBSTONE__") ? null : v;
            }
        }

        // 3. L1+ SSTables (non-overlapping, binary search to find correct SSTable)
        for (int level = 1; level < levels.size(); level++) {
            List<SSTable> levelTables = levels.get(level);
            // Binary search to find SSTable whose key range contains key
            SSTable sst = findSSTableForKey(levelTables, key);
            if (sst != null) {
                v = sst.get(key);
                if (v != null) return v.equals("__TOMBSTONE__") ? null : v;
            }
        }
        return null;
    }

    private void flushToL0() {
        SSTable sst = buildSSTable(memtable);
        ensureLevel(0);
        levels.get(0).add(sst);
        memtable = new TreeMap<>();
        memtableSize = 0;

        if (levels.get(0).size() >= L0_COMPACTION_TRIGGER) {
            compact(0);
        }
    }

    // Leveled compaction: merge L_i SSTable with overlapping L_{i+1} SSTables
    private void compact(int level) {
        ensureLevel(level + 1);
        List<SSTable> currentLevel = levels.get(level);
        List<SSTable> nextLevel = levels.get(level + 1);

        // Pick one SSTable from current level
        SSTable source = currentLevel.remove(0);

        // Find all SSTables in next level that overlap source's key range
        List<SSTable> overlapping = new ArrayList<>();
        Iterator<SSTable> it = nextLevel.iterator();
        while (it.hasNext()) {
            SSTable sst = it.next();
            if (overlaps(source, sst)) {
                overlapping.add(sst);
                it.remove();
            }
        }

        // Merge source + overlapping → new SSTables in next level
        // This IS the K-way merge using a PriorityQueue
        List<SSTable> merged = kWayMerge(source, overlapping);
        nextLevel.addAll(merged);
        nextLevel.sort(Comparator.comparing(s -> s.keys[0]));

        // Check if next level needs compaction too (cascading)
        long levelMaxSize = MEMTABLE_SIZE * (long) Math.pow(LEVEL_SIZE_RATIO, level + 1);
        long currentLevelSize = nextLevel.stream().mapToLong(s -> s.size).sum();
        if (currentLevelSize > levelMaxSize) {
            compact(level + 1);
        }
    }

    // Write amplification analysis:
    // Each key-value pair is written:
    //   1x to memtable (WAL flush)
    //   1x to L0 SSTable (memtable flush)
    //   ~1x per level during compaction (merge with next level)
    //
    // With level ratio T=10 and N levels:
    //   Write amplification = ~T * N = 10 * N
    //   For 1TB of data: N = log_10(1TB / 4MB) ≈ 6 levels
    //   Write amplification ≈ 60x
    //
    // This means writing 1 byte of user data causes ~60 bytes of actual disk I/O.
    // This is the fundamental trade-off of LSM trees:
    // Excellent write throughput (sequential I/O) at the cost of write amplification.
    //
    // Compared to B+ tree (like InnoDB):
    // B+ tree write amplification: ~10-30x (page splits, WAL, double-write buffer)
    // B+ tree read amplification: O(1) — just traverse the tree
    // LSM read amplification: may check multiple levels (mitigated by Bloom filters)

    private void ensureLevel(int level) {
        while (levels.size() <= level) levels.add(new ArrayList<>());
    }

    private boolean overlaps(SSTable a, SSTable b) {
        return a.keys[0].compareTo(b.keys[b.keys.length - 1]) <= 0
            && a.keys[a.keys.length - 1].compareTo(b.keys[0]) >= 0;
    }

    // ... kWayMerge, buildSSTable, findSSTableForKey implementations ...
}
```

**P20.24** [H] — Design: Distributed Consistent Hashing with Replication and Failure Handling

Implement a complete consistent hashing ring with replication, failure detection, and handoff. This is the core of DynamoDB/Cassandra.

```java
// Solution: Production-grade consistent hashing with replication
public class DistributedHashRing {
    private final TreeMap<Long, String> ring = new TreeMap<>();
    private final Map<String, Set<Long>> nodeTokens = new HashMap<>();
    private final int replicationFactor;
    private final Set<String> deadNodes = ConcurrentHashMap.newKeySet();

    // Hinted handoff: when a node is down, another node stores data temporarily
    // HashMap<targetNode, Queue<HintedData>>
    private final Map<String, Queue<byte[]>> hintedHandoffStore = new ConcurrentHashMap<>();

    public DistributedHashRing(int replicationFactor) {
        this.replicationFactor = replicationFactor;
    }

    public void addNode(String node, int numVirtualNodes) {
        Set<Long> tokens = new HashSet<>();
        for (int i = 0; i < numVirtualNodes; i++) {
            long token = hash64(node + ":" + i);
            ring.put(token, node);
            tokens.add(token);
        }
        nodeTokens.put(node, tokens);
    }

    // Write path: find N replica nodes, write to all, handle failures
    public boolean write(String key, byte[] value) {
        List<String> replicas = getPreferenceList(key);
        int successCount = 0;

        for (String replica : replicas) {
            if (deadNodes.contains(replica)) {
                // Node is down — hinted handoff to next available node
                String handoffNode = findNextAliveNode(replica);
                if (handoffNode != null) {
                    hintedHandoffStore.computeIfAbsent(replica, k -> new ConcurrentLinkedQueue<>())
                                      .offer(value);
                    successCount++;
                }
            } else {
                boolean ok = sendToNode(replica, key, value);
                if (ok) successCount++;
            }
        }

        // Quorum write: W = replicationFactor/2 + 1 (majority)
        int W = replicationFactor / 2 + 1;
        return successCount >= W;
    }

    // Read path: read from N replicas, return based on quorum
    public byte[] read(String key) {
        List<String> replicas = getPreferenceList(key);
        int R = replicationFactor / 2 + 1;  // read quorum

        // Read from R replicas, return the value with highest version
        List<VersionedValue> responses = new ArrayList<>();
        for (String replica : replicas) {
            if (!deadNodes.contains(replica)) {
                VersionedValue vv = readFromNode(replica, key);
                if (vv != null) responses.add(vv);
                if (responses.size() >= R) break;
            }
        }

        if (responses.isEmpty()) return null;

        // Return newest version; trigger read-repair for stale replicas
        responses.sort(Comparator.comparingLong(v -> -v.version));
        return responses.get(0).value;
    }

    // Preference list: N distinct physical nodes clockwise from the key's position
    public List<String> getPreferenceList(String key) {
        long hash = hash64(key);
        List<String> nodes = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        Map.Entry<Long, String> entry = ring.ceilingEntry(hash);
        if (entry == null) entry = ring.firstEntry();

        Iterator<Map.Entry<Long, String>> it = ring.tailMap(entry.getKey()).entrySet().iterator();
        while (nodes.size() < replicationFactor) {
            if (!it.hasNext()) it = ring.entrySet().iterator(); // wrap around
            String node = it.next().getValue();
            if (seen.add(node) && !deadNodes.contains(node)) {
                nodes.add(node);
            }
        }
        return nodes;
    }

    // When a dead node comes back: replay hinted handoff data
    public void onNodeRecovery(String node) {
        deadNodes.remove(node);
        Queue<byte[]> hints = hintedHandoffStore.remove(node);
        if (hints != null) {
            for (byte[] data : hints) {
                sendToNode(node, extractKey(data), data);
            }
        }
    }

    // Quorum math:
    // W + R > N guarantees consistency (read sees latest write)
    // N=3, W=2, R=2: read always sees at least one replica with latest write
    // N=3, W=1, R=3: fast writes, slow reads (read all replicas)
    // N=3, W=3, R=1: slow writes, fast reads (write all replicas)

    private long hash64(String key) {
        // MurmurHash3 128-bit, take upper 64 bits
        return key.hashCode() * 0x9E3779B97F4A7C15L; // simplified
    }

    // placeholder methods
    private boolean sendToNode(String node, String key, byte[] value) { return true; }
    private VersionedValue readFromNode(String node, String key) { return null; }
    private String findNextAliveNode(String deadNode) { return null; }
    private String extractKey(byte[] data) { return ""; }
    static class VersionedValue { byte[] value; long version; }
}
```

**P20.25** [H] — Design: Redis-Style Incremental Rehash for Zero-Downtime Resizing

Implement a hash table that resizes without any single long pause, suitable for a real-time system.

```java
// Solution: Incremental rehash (Redis dict approach)
public class IncrementalRehashMap<K, V> {
    static class Entry<K, V> {
        final K key;
        V value;
        Entry<K, V> next;
        Entry(K key, V value) { this.key = key; this.value = value; }
    }

    private Entry<K, V>[] table0;  // primary table
    private Entry<K, V>[] table1;  // rehash target (null when not rehashing)
    private int size;
    private int rehashIndex = -1;  // -1 = not rehashing
    private static final float LOAD_FACTOR = 0.75f;

    @SuppressWarnings("unchecked")
    public IncrementalRehashMap(int initialCapacity) {
        table0 = new Entry[initialCapacity];
    }

    public V get(K key) {
        incrementalRehashStep();  // piggyback on every operation

        int h = spread(key.hashCode());

        // Check table0
        Entry<K, V> e = table0[h & (table0.length - 1)];
        while (e != null) {
            if (e.key.equals(key)) return e.value;
            e = e.next;
        }

        // If rehashing, also check table1
        if (table1 != null) {
            e = table1[h & (table1.length - 1)];
            while (e != null) {
                if (e.key.equals(key)) return e.value;
                e = e.next;
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    public void put(K key, V value) {
        incrementalRehashStep();

        // If rehashing, new entries go to table1
        Entry<K, V>[] target = (table1 != null) ? table1 : table0;
        int h = spread(key.hashCode());
        int idx = h & (target.length - 1);

        // Check for existing key
        for (Entry<K, V> e = target[idx]; e != null; e = e.next) {
            if (e.key.equals(key)) { e.value = value; return; }
        }

        // Insert new entry
        Entry<K, V> newEntry = new Entry<>(key, value);
        newEntry.next = target[idx];
        target[idx] = newEntry;
        size++;

        // Trigger rehash if load factor exceeded
        if (table1 == null && size > table0.length * LOAD_FACTOR) {
            startRehash();
        }
    }

    @SuppressWarnings("unchecked")
    private void startRehash() {
        table1 = new Entry[table0.length * 2];
        rehashIndex = 0;
    }

    // Move ONE bucket per operation — O(1) amortized cost per API call
    private void incrementalRehashStep() {
        if (rehashIndex < 0 || table1 == null) return;

        // Find next non-empty bucket
        while (rehashIndex < table0.length && table0[rehashIndex] == null) {
            rehashIndex++;
        }

        if (rehashIndex >= table0.length) {
            // Rehash complete
            table0 = table1;
            table1 = null;
            rehashIndex = -1;
            return;
        }

        // Move all entries from this bucket to table1
        Entry<K, V> entry = table0[rehashIndex];
        while (entry != null) {
            Entry<K, V> next = entry.next;
            int newIdx = spread(entry.key.hashCode()) & (table1.length - 1);
            entry.next = table1[newIdx];
            table1[newIdx] = entry;
            entry = next;
        }
        table0[rehashIndex] = null;
        rehashIndex++;
    }

    private int spread(int h) {
        return h ^ (h >>> 16);
    }

    // Analysis:
    // Standard HashMap.resize(): O(n) — copies all entries at once
    //   For 10M entries: ~100ms pause (unacceptable for Redis at 100K ops/sec)
    //
    // Incremental rehash: O(1) per operation
    //   Each get/put/delete moves one bucket (amortized ~1 entry)
    //   Rehash completes after ~n operations (where n = table0.length)
    //   No single operation takes more than O(bucket_size) — typically O(1)
    //
    // Trade-off: during rehash, memory usage is 3x (table0 + table1 + entries)
    // But no latency spike. For real-time systems, this is the right trade-off.
}
```

**P20.26** [H] — Design: Epoll-Style Event Notification System

Implement an event notification system that scales to 100K file descriptors. Explain why Red-Black tree + linked list beats alternatives.

```java
// Solution: Epoll-style event system with RB-tree + ready list
public class ScalableEventSystem {
    // All monitored entries: Red-Black tree for O(log n) add/remove
    private final TreeMap<Integer, EventEntry> allEntries = new TreeMap<>();

    // Ready entries: linked list for O(1) append/drain
    private final LinkedList<EventEntry> readyList = new LinkedList<>();

    // Lock for ready list modifications
    private final Object readyLock = new Object();

    static class EventEntry {
        int fd;
        int events;          // EPOLLIN, EPOLLOUT, etc.
        int readyEvents;     // events that fired
        boolean inReadyList; // avoid duplicate insertion
    }

    // Register: O(log n) — insert into RB-tree
    public void register(int fd, int events) {
        EventEntry entry = new EventEntry();
        entry.fd = fd;
        entry.events = events;
        allEntries.put(fd, entry);  // O(log n)
    }

    // Unregister: O(log n) — remove from RB-tree
    public void unregister(int fd) {
        EventEntry entry = allEntries.remove(fd);  // O(log n)
        if (entry != null && entry.inReadyList) {
            synchronized (readyLock) {
                readyList.remove(entry);  // O(n) in worst case, but rare
            }
        }
    }

    // Callback from kernel: O(1) — append to ready list
    public void notifyReady(int fd, int readyEvents) {
        EventEntry entry = allEntries.get(fd);  // O(log n) in tree, O(1) if cached
        if (entry != null) {
            entry.readyEvents = readyEvents;
            synchronized (readyLock) {
                if (!entry.inReadyList) {
                    readyList.addLast(entry);  // O(1) append
                    entry.inReadyList = true;
                    readyLock.notifyAll();
                }
            }
        }
    }

    // Wait for events: returns ready entries, blocks if none
    public List<EventEntry> waitForEvents(int maxEvents, long timeoutMs)
            throws InterruptedException {
        synchronized (readyLock) {
            if (readyList.isEmpty()) {
                readyLock.wait(timeoutMs);
            }

            List<EventEntry> result = new ArrayList<>(Math.min(maxEvents, readyList.size()));
            while (!readyList.isEmpty() && result.size() < maxEvents) {
                EventEntry entry = readyList.removeFirst();  // O(1)
                entry.inReadyList = false;
                result.add(entry);
            }
            return result;
        }
    }

    // Why this design beats alternatives:
    //
    // Alternative 1: HashMap for all entries + scan for ready
    //   register/unregister: O(1)
    //   But: no ready list → must scan ALL entries to find ready ones
    //   waitForEvents: O(n) per call ← this is what poll() does!
    //
    // Alternative 2: HashMap for all + HashSet for ready
    //   register: O(1), notify: O(1), wait: O(ready count)
    //   But: HashSet iteration is unordered and has overhead
    //   LinkedList ready list is simpler and cache-friendlier for drain
    //
    // Alternative 3: Sorted array for all entries
    //   register: O(n) — must shift elements
    //   Binary search for fd: O(log n)
    //   Unacceptable for dynamic fd registration
    //
    // The RB-tree + linked list combination:
    //   register: O(log n)
    //   unregister: O(log n)
    //   notify: O(1) amortized
    //   wait: O(ready count) — only iterates ready entries, not all entries
    //   Scales to millions of fds where only hundreds are ready per call
}
```

**P20.27** [H] — Design: Complete B+ Tree Index

Implement a B+ tree suitable for a database index. Show page splits, range scans via leaf-level linked list, and bulk loading.

```java
// Solution: B+ tree with page splits and range scans
public class BPlusTree<K extends Comparable<K>, V> {
    private static final int ORDER = 128;  // max keys per node (simulating 16KB page)
    private static final int MIN_KEYS = ORDER / 2;

    abstract static class Node<K, V> { int keyCount; }

    static class InternalNode<K extends Comparable<K>, V> extends Node<K, V> {
        K[] keys;
        Node<K, V>[] children;
    }

    static class LeafNode<K extends Comparable<K>, V> extends Node<K, V> {
        K[] keys;
        V[] values;
        LeafNode<K, V> next;  // linked list for range scans
        LeafNode<K, V> prev;
    }

    private Node<K, V> root;

    // Point lookup: O(log_B n) where B = branching factor (~128)
    public V get(K key) {
        LeafNode<K, V> leaf = findLeaf(key);
        int idx = binarySearch(leaf.keys, leaf.keyCount, key);
        return (idx >= 0) ? leaf.values[idx] : null;
    }

    // Range scan: O(log_B n + k) where k = result count
    public List<V> range(K from, K to) {
        LeafNode<K, V> leaf = findLeaf(from);
        List<V> result = new ArrayList<>();

        while (leaf != null) {
            for (int i = 0; i < leaf.keyCount; i++) {
                if (leaf.keys[i].compareTo(from) >= 0 && leaf.keys[i].compareTo(to) <= 0) {
                    result.add(leaf.values[i]);
                } else if (leaf.keys[i].compareTo(to) > 0) {
                    return result;  // past the range — done
                }
            }
            leaf = leaf.next;  // follow leaf-level linked list
        }
        return result;
    }

    // Insert with page split
    public void put(K key, V value) {
        if (root == null) {
            LeafNode<K, V> leaf = createLeaf();
            leaf.keys[0] = key;
            leaf.values[0] = value;
            leaf.keyCount = 1;
            root = leaf;
            return;
        }

        // Find leaf and insert
        Object[] result = insertRecursive(root, key, value);
        if (result != null) {
            // Root was split — create new root
            InternalNode<K, V> newRoot = createInternal();
            newRoot.keys[0] = (K) result[0];
            newRoot.children[0] = root;
            newRoot.children[1] = (Node<K, V>) result[1];
            newRoot.keyCount = 1;
            root = newRoot;
        }
    }

    // Returns null if no split, or [promotedKey, newNode] if split occurred
    private Object[] insertRecursive(Node<K, V> node, K key, V value) {
        if (node instanceof LeafNode) {
            LeafNode<K, V> leaf = (LeafNode<K, V>) node;
            insertIntoLeaf(leaf, key, value);

            if (leaf.keyCount > ORDER - 1) {
                return splitLeaf(leaf);  // returns [promotedKey, newLeaf]
            }
            return null;
        }

        InternalNode<K, V> internal = (InternalNode<K, V>) node;
        int childIdx = findChildIndex(internal, key);
        Object[] result = insertRecursive(internal.children[childIdx], key, value);

        if (result != null) {
            insertIntoInternal(internal, (K) result[0], (Node<K, V>) result[1], childIdx);
            if (internal.keyCount > ORDER - 1) {
                return splitInternal(internal);
            }
        }
        return null;
    }

    private Object[] splitLeaf(LeafNode<K, V> leaf) {
        LeafNode<K, V> newLeaf = createLeaf();
        int mid = leaf.keyCount / 2;

        // Move upper half to new leaf
        for (int i = mid; i < leaf.keyCount; i++) {
            newLeaf.keys[i - mid] = leaf.keys[i];
            newLeaf.values[i - mid] = leaf.values[i];
        }
        newLeaf.keyCount = leaf.keyCount - mid;
        leaf.keyCount = mid;

        // Maintain leaf-level linked list
        newLeaf.next = leaf.next;
        newLeaf.prev = leaf;
        if (leaf.next != null) leaf.next.prev = newLeaf;
        leaf.next = newLeaf;

        return new Object[]{newLeaf.keys[0], newLeaf};
    }

    // Height of a B+ tree with ORDER=128 and N rows:
    // Height = ceil(log_128(N))
    // N = 1M:     height = 3  (128^3 = 2M > 1M)
    // N = 100M:   height = 4  (128^4 = 268M > 100M)
    // N = 10B:    height = 5  (128^5 = 34B > 10B)
    //
    // With root and level-1 pages cached in buffer pool,
    // a point lookup needs 1-2 disk I/Os for up to 10 billion rows.
    // This is why B+ trees are the default index for databases.

    // Bulk loading: sorted insert fills pages sequentially (no splits)
    // Much faster than random inserts (O(n) vs O(n log n) I/Os)
    // This is why CREATE INDEX on a large table first sorts the data.

    @SuppressWarnings("unchecked")
    private LeafNode<K, V> createLeaf() { return new LeafNode<>(); }
    @SuppressWarnings("unchecked")
    private InternalNode<K, V> createInternal() { return new InternalNode<>(); }
    private LeafNode<K, V> findLeaf(K key) { /* traverse from root */ return null; }
    private int binarySearch(K[] keys, int count, K key) { return Arrays.binarySearch(keys, 0, count, key); }
    private int findChildIndex(InternalNode<K, V> node, K key) { return 0; }
    private void insertIntoLeaf(LeafNode<K, V> leaf, K key, V value) { /* ... */ }
    private void insertIntoInternal(InternalNode<K, V> node, K key, Node<K, V> child, int idx) { /* ... */ }
    private Object[] splitInternal(InternalNode<K, V> node) { return null; }
}
```

**P20.28** [H] — Design: Raft Consensus Log Replication

Implement the core of Raft log replication with leader election, AppendEntries RPC, and commit tracking.

```java
// Solution: Raft consensus — core data structures and replication
public class RaftNode {
    enum Role { FOLLOWER, CANDIDATE, LEADER }

    // Persistent state (must survive crash):
    private int currentTerm = 0;
    private Integer votedFor = null;
    private final List<LogEntry> log = new ArrayList<>();  // append-only log

    // Volatile state (all servers):
    private int commitIndex = 0;    // highest log index known to be committed
    private int lastApplied = 0;    // highest log index applied to state machine
    private Role role = Role.FOLLOWER;

    // Volatile state (leaders only):
    private int[] nextIndex;   // for each follower: next log index to send
    private int[] matchIndex;  // for each follower: highest log index known replicated

    private final int nodeId;
    private final int clusterSize;

    static class LogEntry {
        int term;
        byte[] command;
    }

    public RaftNode(int nodeId, int clusterSize) {
        this.nodeId = nodeId;
        this.clusterSize = clusterSize;
    }

    // Leader: replicate log entry to followers
    public boolean replicateEntry(byte[] command) {
        if (role != Role.LEADER) return false;

        // Append to own log
        LogEntry entry = new LogEntry();
        entry.term = currentTerm;
        entry.command = command;
        log.add(entry);

        // Send AppendEntries RPC to each follower
        int replicatedCount = 1;  // self
        for (int i = 0; i < clusterSize; i++) {
            if (i == nodeId) continue;

            boolean success = sendAppendEntries(i);
            if (success) {
                matchIndex[i] = log.size();
                nextIndex[i] = log.size() + 1;
                replicatedCount++;
            } else {
                // Log inconsistency — decrement nextIndex and retry
                // This is binary search for the matching point:
                // keep decrementing nextIndex until follower accepts
                nextIndex[i]--;
                // In optimized Raft: follower sends conflicting term's first index
                // → leader can skip directly to the right position
            }
        }

        // Check if majority have replicated
        if (replicatedCount > clusterSize / 2) {
            // Commit: advance commitIndex
            updateCommitIndex();
            return true;
        }
        return false;
    }

    // Follower: handle AppendEntries RPC
    public boolean onAppendEntries(int leaderTerm, int prevLogIndex, int prevLogTerm,
                                    List<LogEntry> entries, int leaderCommit) {
        if (leaderTerm < currentTerm) return false;  // stale leader

        currentTerm = leaderTerm;
        role = Role.FOLLOWER;

        // Log matching: check if our log matches at prevLogIndex
        if (prevLogIndex > 0) {
            if (prevLogIndex > log.size()) return false;   // gap in log
            if (log.get(prevLogIndex - 1).term != prevLogTerm) {
                // Conflict: delete this entry and all after it
                while (log.size() >= prevLogIndex) {
                    log.remove(log.size() - 1);
                }
                return false;
            }
        }

        // Append new entries (skip already-present entries)
        for (int i = 0; i < entries.size(); i++) {
            int logIndex = prevLogIndex + i;  // 0-based
            if (logIndex < log.size()) {
                if (log.get(logIndex).term != entries.get(i).term) {
                    // Conflict: truncate and append
                    while (log.size() > logIndex) log.remove(log.size() - 1);
                    log.add(entries.get(i));
                }
                // else: already have this entry, skip
            } else {
                log.add(entries.get(i));
            }
        }

        // Update commit index
        if (leaderCommit > commitIndex) {
            commitIndex = Math.min(leaderCommit, log.size());
            applyCommittedEntries();
        }
        return true;
    }

    // Apply committed entries to state machine
    private void applyCommittedEntries() {
        while (lastApplied < commitIndex) {
            lastApplied++;
            applyToStateMachine(log.get(lastApplied - 1).command);
        }
    }

    // Update commit index based on matchIndex majority
    private void updateCommitIndex() {
        // Find the highest N such that a majority of matchIndex[i] >= N
        // AND log[N].term == currentTerm
        for (int n = log.size(); n > commitIndex; n--) {
            if (log.get(n - 1).term != currentTerm) continue;

            int count = 1;  // self
            for (int i = 0; i < clusterSize; i++) {
                if (i != nodeId && matchIndex[i] >= n) count++;
            }
            if (count > clusterSize / 2) {
                commitIndex = n;
                applyCommittedEntries();
                break;
            }
        }
    }

    // Data structure analysis:
    // Log: ArrayList<LogEntry> — append-only, index by position O(1)
    // nextIndex[]: int[] — per-follower tracking of replication progress
    // matchIndex[]: int[] — per-follower tracking of confirmed replication
    // Commit determination: scan matchIndex for majority — O(clusterSize)
    //   In practice, cluster size is 3, 5, or 7 — O(1) effectively
    //
    // Log compaction: when log grows too large, snapshot state machine
    // and discard prefix of log. Same concept as LSM compaction.

    private boolean sendAppendEntries(int followerId) { return true; }
    private void applyToStateMachine(byte[] command) { /* apply command */ }
}
```

**P20.29** [H] — Design: Complete Inverted Index with TF-IDF Scoring

Build a search engine's inverted index with term frequency scoring, document frequency, and BM25 ranking.

```java
// Solution: Inverted index with BM25 scoring
public class SearchEngine {
    // Inverted index: term → posting list (sorted by docId)
    static class Posting {
        int docId;
        int termFrequency;  // how many times term appears in this doc
        // In Lucene: also stores positions for phrase queries
    }

    private final Map<String, List<Posting>> invertedIndex = new HashMap<>();
    private final Map<Integer, Integer> docLengths = new HashMap<>();  // docId → word count
    private int totalDocs = 0;
    private double avgDocLength = 0;

    // Index a document
    public void indexDocument(int docId, String text) {
        String[] tokens = tokenize(text);
        docLengths.put(docId, tokens.length);
        totalDocs++;
        avgDocLength = docLengths.values().stream().mapToInt(i -> i).average().orElse(0);

        // Count term frequencies
        Map<String, Integer> termFreqs = new HashMap<>();
        for (String token : tokens) {
            termFreqs.merge(token, 1, Integer::sum);
        }

        // Add to inverted index
        for (Map.Entry<String, Integer> entry : termFreqs.entrySet()) {
            Posting posting = new Posting();
            posting.docId = docId;
            posting.termFrequency = entry.getValue();
            invertedIndex.computeIfAbsent(entry.getKey(), k -> new ArrayList<>())
                         .add(posting);
        }
    }

    // Search with BM25 ranking
    public List<int[]> search(String query, int topK) {
        String[] queryTerms = tokenize(query);

        // Score each document using BM25
        // BM25 is the standard ranking function for modern search engines
        Map<Integer, Double> scores = new HashMap<>();
        double k1 = 1.2, b = 0.75;  // BM25 parameters

        for (String term : queryTerms) {
            List<Posting> postings = invertedIndex.get(term);
            if (postings == null) continue;

            // IDF (Inverse Document Frequency)
            double idf = Math.log((totalDocs - postings.size() + 0.5)
                                  / (postings.size() + 0.5) + 1);

            for (Posting p : postings) {
                int docLen = docLengths.get(p.docId);
                // BM25 term score
                double tf = p.termFrequency;
                double numerator = tf * (k1 + 1);
                double denominator = tf + k1 * (1 - b + b * docLen / avgDocLength);
                double score = idf * numerator / denominator;
                scores.merge(p.docId, score, Double::sum);
            }
        }

        // Top-K using a min-heap (PriorityQueue of size K)
        PriorityQueue<int[]> topKHeap = new PriorityQueue<>(
            Comparator.comparingDouble(a -> scores.get(a[0])));

        for (Map.Entry<Integer, Double> entry : scores.entrySet()) {
            int[] docScore = {entry.getKey()};
            if (topKHeap.size() < topK) {
                topKHeap.offer(docScore);
            } else if (entry.getValue() > scores.get(topKHeap.peek()[0])) {
                topKHeap.poll();
                topKHeap.offer(docScore);
            }
        }

        // Extract results in descending score order
        List<int[]> result = new ArrayList<>(topKHeap);
        result.sort((a, c) -> Double.compare(scores.get(c[0]), scores.get(a[0])));
        return result;
    }

    // Data structure analysis:
    // Inverted index: HashMap<String, List<Posting>> — O(1) term lookup
    //   Lucene stores posting lists as compressed byte arrays (vInt encoding)
    //   with skip pointers for fast intersection
    //
    // Boolean AND query: two-pointer intersection of sorted posting lists — O(n+m)
    //   Same as merge step in merge sort, applied to two sorted arrays
    //
    // Top-K ranking: min-heap of size K — O(D log K) where D = matching docs
    //   This is the classic "top K elements from stream" problem
    //
    // BM25 scoring: TF-IDF variant with document length normalization
    //   IDF = log((N-df+0.5)/(df+0.5)+1) where df = docs containing term
    //   TF component uses saturation (diminishing returns for repeated terms)
    //
    // Lucene additionally uses:
    // - BKD trees for numeric range queries (geo, dates, prices)
    // - FST (Finite State Transducer) for term dictionary compression
    // - Segment merging (LSM-style compaction of immutable segments)

    private String[] tokenize(String text) {
        return text.toLowerCase().split("\\W+");
    }
}
```

**P20.30** [H] — Capstone: Design a Complete Key-Value Store

Design a production-grade key-value store that combines: LSM tree for storage, Bloom filter for read optimization, WAL for durability, consistent hashing for distribution, and vector clocks for conflict resolution. Identify every data structure and its role.

```java
// Solution: Full-stack key-value store — every data structure mapped
public class DistributedKVStore {

    // ==================== DISTRIBUTION LAYER ====================

    // Consistent hash ring: TreeMap<Long, NodeId>
    // Purpose: route keys to the correct storage node
    // Operations: ceilingEntry() for routing — O(log V) where V = virtual nodes
    private final TreeMap<Long, Integer> hashRing = new TreeMap<>();

    // Node membership: gossip protocol
    // Purpose: detect node failures, propagate cluster state
    // Data structure: ConcurrentHashMap<NodeId, NodeState>
    // Update: periodic random peer exchange — converges in O(log N) rounds
    private final ConcurrentHashMap<Integer, NodeState> clusterState = new ConcurrentHashMap<>();

    // Replication: preference list of N nodes
    // Purpose: data durability (survive node failures)
    // Data structure: List<NodeId> from consistent hash ring traversal

    // ==================== DURABILITY LAYER ====================

    // Write-Ahead Log: append-only sequential file
    // Purpose: crash recovery — replay log to restore memtable
    // Data structure: append-only ArrayList<WALRecord> on disk
    // Operations: append O(1), replay O(n) on recovery
    private final WAL wal = new WAL();

    // ==================== STORAGE ENGINE (LSM Tree) ====================

    // MemTable: TreeMap<byte[], byte[]> (in-memory sorted map)
    // Purpose: buffer writes in memory, sort by key
    // Operations: put O(log n), get O(log n)
    // Flush: write as sorted SSTable when size exceeds threshold
    private TreeMap<ByteArray, VersionedValue> memtable = new TreeMap<>();

    // Immutable MemTable: same as memtable, being flushed to disk
    private TreeMap<ByteArray, VersionedValue> immutableMemtable = null;

    // SSTables: sorted array on disk (one per flush)
    // Purpose: persistent sorted key-value storage
    // Operations: binary search O(log n), range scan O(k)
    // Compaction: merge sort of multiple SSTables — O(n) sequential I/O
    private final List<SSTable> sstables = new ArrayList<>();

    // Bloom filter: one per SSTable
    // Purpose: skip SSTables that definitely do not contain the key
    // Operations: mightContain O(k) where k = hash functions (~7)
    // False positive rate: ~1% (configurable)

    // Sparse index: one per SSTable
    // Purpose: map key → approximate file offset for binary search
    // Data structure: sorted array of (key, offset) pairs

    // ==================== CONFLICT RESOLUTION ====================

    // Vector clocks: int[] per key per node
    // Purpose: detect concurrent writes, determine causal ordering
    // Operations: compare O(N), merge O(N) where N = cluster size

    static class VersionedValue {
        byte[] value;
        int[] vectorClock;
    }

    // ==================== READ PATH ====================

    public VersionedValue get(byte[] key) {
        // Step 1: Route to correct node
        int nodeId = route(key);                // TreeMap.ceilingEntry — O(log V)

        // Step 2: Check memtable (newest data)
        ByteArray k = new ByteArray(key);
        VersionedValue v = memtable.get(k);     // TreeMap.get — O(log m)
        if (v != null) return v;

        // Step 3: Check immutable memtable (being flushed)
        if (immutableMemtable != null) {
            v = immutableMemtable.get(k);       // TreeMap.get — O(log m)
            if (v != null) return v;
        }

        // Step 4: Check SSTables (newest first)
        for (int i = sstables.size() - 1; i >= 0; i--) {
            SSTable sst = sstables.get(i);

            // Step 4a: Bloom filter check
            if (!sst.bloomFilter.mightContain(key)) continue;  // O(1)

            // Step 4b: Sparse index → binary search for approximate position
            int offset = sst.sparseIndex.findOffset(key);       // O(log s)

            // Step 4c: Sequential scan from offset to find exact key
            v = sst.readFromOffset(offset, key);                // O(block_size)
            if (v != null) return v;
        }

        return null;  // key not found
    }

    // ==================== WRITE PATH ====================

    public void put(byte[] key, byte[] value, int[] clientVectorClock) {
        // Step 1: Route to correct node
        int nodeId = route(key);                // O(log V)

        // Step 2: Write to WAL (durability)
        wal.append(key, value);                 // O(1) sequential write + fsync

        // Step 3: Update vector clock
        int[] newClock = clientVectorClock.clone();
        newClock[nodeId]++;

        // Step 4: Write to memtable
        VersionedValue vv = new VersionedValue();
        vv.value = value;
        vv.vectorClock = newClock;
        memtable.put(new ByteArray(key), vv);   // O(log m)

        // Step 5: Flush memtable if too large
        if (memtableSize() > MEMTABLE_THRESHOLD) {
            flushMemtable();
        }

        // Step 6: Replicate to N-1 other nodes (async or sync based on W quorum)
        replicateToReplicas(key, vv);
    }

    private void flushMemtable() {
        immutableMemtable = memtable;
        memtable = new TreeMap<>();

        // Build SSTable from sorted memtable
        SSTable sst = new SSTable();
        // Iterate TreeMap in order — already sorted!
        for (Map.Entry<ByteArray, VersionedValue> entry : immutableMemtable.entrySet()) {
            sst.append(entry.getKey().bytes, entry.getValue());
        }
        sst.buildBloomFilter();      // O(n) scan, O(1) per insert
        sst.buildSparseIndex();      // O(n) scan, record every Nth key
        sst.close();
        sstables.add(sst);

        immutableMemtable = null;

        // Trigger compaction if needed
        maybeCompact();
    }

    // ==================== COMPLETE DATA STRUCTURE INVENTORY ====================
    //
    // Layer              | Data Structure       | Purpose                    | Complexity
    // -------------------|---------------------|---------------------------|----------
    // Distribution       | TreeMap (hash ring)  | Route keys to nodes       | O(log V)
    // Membership         | ConcurrentHashMap    | Node state tracking       | O(1)
    // Gossip             | Random peer exchange | Failure detection          | O(log N) rounds
    // Durability         | Append-only log      | Crash recovery (WAL)      | O(1) write
    // Write buffer       | TreeMap (memtable)   | In-memory sorted buffer   | O(log m)
    // Persistent store   | Sorted array (SST)   | On-disk sorted data       | O(log n) search
    // Read optimization  | Bloom filter         | Skip absent SSTables      | O(k) check
    // Index              | Sparse sorted array  | Key → file offset         | O(log s) search
    // Compaction         | K-way merge (heap)   | Merge SSTables            | O(n log k)
    // Conflict detection | Vector clock (int[]) | Causal ordering           | O(N) compare
    // Replication        | Preference list      | Data durability           | O(R) factor
    // Anti-entropy       | Merkle tree          | Detect replica divergence | O(log n) diff
    //
    // This single system uses: TreeMap, HashMap, ArrayList, array, BitSet,
    // PriorityQueue, linked list, sorted array, Bloom filter, Merkle tree,
    // vector clock, append-only log, and ring buffer concepts.
    // Every data structure studied in this book has a home here.

    private int route(byte[] key) { return 0; }
    private int memtableSize() { return 0; }
    private void maybeCompact() { }
    private void replicateToReplicas(byte[] key, VersionedValue vv) { }

    // Placeholder types
    static class ByteArray implements Comparable<ByteArray> {
        byte[] bytes;
        ByteArray(byte[] b) { this.bytes = b; }
        public int compareTo(ByteArray o) { return Arrays.compare(bytes, o.bytes); }
        public boolean equals(Object o) { return o instanceof ByteArray && Arrays.equals(bytes, ((ByteArray) o).bytes); }
        public int hashCode() { return Arrays.hashCode(bytes); }
    }
    static class WAL { void append(byte[] k, byte[] v) {} }
    static class SSTable {
        BloomFilter bloomFilter;
        SparseIndex sparseIndex;
        void append(byte[] k, VersionedValue v) {}
        VersionedValue readFromOffset(int offset, byte[] key) { return null; }
        void buildBloomFilter() {}
        void buildSparseIndex() {}
        void close() {}
    }
    static class BloomFilter { boolean mightContain(byte[] key) { return false; } }
    static class SparseIndex { int findOffset(byte[] key) { return 0; } }
    static class NodeState { long heartbeat; Map<String, String> metadata; }
}
```

---

## Key Takeaways

1. **Every production system is built from DSA primitives.** Redis uses skip lists and hash tables. Linux CFS uses a Red-Black tree. InnoDB uses B+ trees. Kafka uses append-only arrays. There are no "new" data structures in production — only well-chosen combinations of the ones you study.

2. **The choice between HashMap and TreeMap is the most common decision in systems design.** HashMap wins for exact-match lookups (DNS cache, Spring beans, connection tracking). TreeMap wins when you need ordering (CFS scheduler, consistent hashing, range queries). Know the trade-off cold.

3. **Append-only logs are everywhere.** WAL, Kafka topics, Raft logs, event sourcing stores, Git commit history — all are append-only sequences where the append position (offset, LSN, log index) serves as the primary identifier. This is the simplest and most durable write pattern.

4. **The merge step of merge sort is the most reused algorithm in production.** LSM compaction, sort-merge join, Lucene segment merge, K-way external sort — all are the same "merge two sorted sequences" operation. Master it once, recognize it everywhere.

5. **Bloom filters are the universal read optimization.** Any system that might do an expensive check (disk I/O, network request, database query) for a key that is probably absent benefits from a Bloom filter. Cost: ~10 bits per key for 1% false positive rate. Benefit: eliminate 99% of unnecessary checks.

6. **Consistent hashing solves the distributed routing problem.** Any time you need to map keys to servers with minimal disruption when servers join or leave, use a TreeMap ring with virtual nodes. DynamoDB, Cassandra, Memcached, and most CDNs use this exact approach.

7. **Red-Black trees dominate kernel data structures for a reason.** O(log n) worst-case for all operations, bounded rotations per modification, and no rehashing pauses. When you cannot afford worst-case O(n) (schedulers, epoll, connection tracking), Red-Black trees are the standard choice.

8. **Ring buffers are the universal high-performance queue.** NIC drivers, LMAX Disruptor, Log4j2, TCP send/receive buffers, and kernel pipe buffers all use ring buffers. They offer cache-friendly sequential access, zero allocation overhead, and lock-free producer-consumer patterns.

9. **Merkle trees enable efficient distributed data comparison.** Comparing two copies of a billion-row dataset would normally require O(n) comparison. Merkle trees reduce this to O(log n) by hierarchical hashing. Git uses them for integrity, Cassandra for anti-entropy repair, and blockchain for transaction verification.

10. **The real skill is not knowing data structures — it is recognizing which one a system needs.** When someone describes a system requirement ("we need to route requests to the nearest available server with minimal disruption during scaling"), you should immediately see the data structure (consistent hash ring → TreeMap). This chapter is your training ground for that recognition.

---

[Previous: Chapter 19 — Advanced Techniques →](19-pattern-advanced-techniques.md) | [Index →](00-index.md)
