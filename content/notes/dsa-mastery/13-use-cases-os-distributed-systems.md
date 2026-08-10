# Chapter 13: Use Cases -- OS & Distributed Systems

## Every Scheduler, Allocator, and Consensus Protocol Is a Data Structure Problem

You have spent your career building systems that sit on top of an operating system and communicate across a network. You have tuned Linux scheduler parameters with `sched_setaffinity`. You have debugged OOM kills by reading `/proc/meminfo`. You have wrestled with split-brain scenarios in your distributed databases and watched Raft elections play out in etcd logs. You have configured Kafka partitions and debugged consumer lag. You have implemented circuit breakers with Resilience4j and watched service meshes route around failed instances.

What you may not have realized is that every one of these systems is, at its core, a data structure problem. The Linux CFS scheduler is a red-black tree. The buddy allocator is a binary tree of power-of-2 blocks. Raft consensus is an append-only log with a state machine. Consistent hashing is a sorted map. Gossip protocols are epidemic simulations on a random graph. Vector clocks are integer arrays with merge semantics.

This chapter takes the OS and distributed systems knowledge you already possess and reveals the data structures underneath. When you finish, you will not just understand these systems at the architectural level -- you will be able to implement them from scratch, analyze their complexity, and recognize when interview problems are asking you to build one.

We cover five major domains: process scheduling, memory management, file systems, distributed systems, and infrastructure patterns (message queues, service discovery, resilience). Each section maps directly to data structures from previous chapters, with full Java implementations and JVM-level analysis.

---

## 13.1 Process Scheduling

Operating system schedulers are the original priority queue consumers. Every scheduling algorithm is fundamentally about maintaining a collection of runnable tasks and efficiently selecting the next one to execute. The data structure choice determines the scheduler's time complexity, fairness properties, and scalability to thousands of CPUs.

### 13.1.1 Completely Fair Scheduler (CFS): The Red-Black Tree Scheduler

Linux's CFS, introduced in kernel 2.6.23, replaced the O(1) scheduler with a design built around a single insight: fairness can be modeled as a minimum virtual runtime problem. Every task tracks its `vruntime` -- a weighted measure of how much CPU time it has consumed. The scheduler always picks the task with the smallest `vruntime`, which is the task that has been treated most unfairly.

The data structure is a red-black tree keyed by `vruntime`. The leftmost node (smallest `vruntime`) is the next task to run. Inserting and removing tasks costs O(log n). Picking the next task is O(1) because CFS caches the leftmost pointer.

```
CFS Red-Black Tree (keyed by vruntime):

              [vruntime=50, PID=3]  (BLACK, root)
              /                     \
    [vruntime=20, PID=1] (RED)     [vruntime=80, PID=5] (RED)
    /                   \           /                   \
 [vruntime=10, PID=7]  [30, P=2] [vruntime=65, PID=4] [vruntime=100, PID=6]
    (BLACK)            (BLACK)      (BLACK)               (BLACK)
    ^
    |
    leftmost (cached) = next to schedule
```

**Key insight:** In the actual Linux kernel, `struct cfs_rq` contains `rb_leftmost` -- a cached pointer to the leftmost node. This gives O(1) pick-next without tree traversal. Java's `TreeMap` does not cache this, but `firstEntry()` achieves O(log n) by walking left from root. For a scheduler simulation, we cache it ourselves.

```java
import java.util.TreeMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Simulates Linux CFS scheduler using a TreeMap (red-black tree).
 * Key = vruntime (virtual runtime), Value = Process.
 * TreeMap provides O(log n) insert/remove, and firstEntry() for pick-next.
 */
public class CFSScheduler {

    static class Process implements Comparable<Process> {
        final int pid;
        final int nice;           // nice value: -20 to 19
        final double weight;      // derived from nice (higher weight = more CPU)
        long vruntime;            // virtual runtime in nanoseconds
        final String name;

        Process(int pid, String name, int nice) {
            this.pid = pid;
            this.name = name;
            this.nice = nice;
            // Weight derived from nice: nice 0 = weight 1024 (Linux convention)
            // Each nice level is ~1.25x factor
            this.weight = 1024.0 / Math.pow(1.25, nice);
            this.vruntime = 0;
        }

        @Override
        public int compareTo(Process other) {
            int cmp = Long.compare(this.vruntime, other.vruntime);
            if (cmp != 0) return cmp;
            return Integer.compare(this.pid, other.pid); // tiebreak by PID
        }

        @Override
        public String toString() {
            return String.format("PID=%d(%s) nice=%d vruntime=%d", 
                pid, name, nice, vruntime);
        }
    }

    // Red-black tree keyed by (vruntime, pid) ordering
    private final TreeMap<Process, Process> runQueue = new TreeMap<>();
    private final long schedulingLatency;  // target latency in ns (e.g., 6ms)
    private final long minGranularity;     // minimum time slice in ns (e.g., 0.75ms)
    private Process current;
    private long wallClock = 0;

    public CFSScheduler(long schedulingLatencyNs, long minGranularityNs) {
        this.schedulingLatency = schedulingLatencyNs;
        this.minGranularity = minGranularityNs;
    }

    /** Add a new process. O(log n). */
    public void addProcess(Process p) {
        // New processes get vruntime = min_vruntime of the tree
        // This prevents starvation of new processes but also prevents them
        // from monopolizing the CPU
        if (!runQueue.isEmpty()) {
            p.vruntime = runQueue.firstKey().vruntime;
        }
        runQueue.put(p, p);
    }

    /** Remove a process (e.g., it exited). O(log n). */
    public void removeProcess(Process p) {
        runQueue.remove(p);
    }

    /** Pick the next process to run. O(log n) in Java's TreeMap. */
    public Process pickNext() {
        if (runQueue.isEmpty()) return null;
        // Leftmost node = smallest vruntime = most "unfairly" treated
        return runQueue.firstKey();
    }

    /** 
     * Calculate time slice for a process.
     * In CFS: slice = (scheduling_latency / nr_running) * (weight / total_weight)
     * But at least min_granularity.
     */
    public long calculateTimeSlice(Process p) {
        int nrRunning = runQueue.size();
        if (nrRunning == 0) return minGranularity;

        double totalWeight = runQueue.keySet().stream()
            .mapToDouble(proc -> proc.weight).sum();
        long slice = (long)(schedulingLatency * (p.weight / totalWeight));
        return Math.max(slice, minGranularity);
    }

    /** 
     * Simulate one scheduling cycle.
     * Returns the process that ran and how long it ran.
     */
    public String tick() {
        Process next = pickNext();
        if (next == null) return "IDLE";

        // Remove from tree (vruntime is about to change)
        runQueue.remove(next);

        long slice = calculateTimeSlice(next);

        // Update vruntime: actual_runtime * (NICE_0_WEIGHT / process_weight)
        // Processes with higher weight accumulate vruntime slower
        long vruntimeDelta = (long)(slice * (1024.0 / next.weight));
        next.vruntime += vruntimeDelta;

        // Re-insert with updated vruntime
        runQueue.put(next, next);

        wallClock += slice;
        current = next;

        return String.format("[t=%d] Scheduled %s for %dns (vruntime now %d)",
            wallClock, next.name, slice, next.vruntime);
    }
}
```

**Complexity:**
- `addProcess`: O(log n) -- TreeMap insertion
- `removeProcess`: O(log n) -- TreeMap removal
- `pickNext`: O(log n) in Java (TreeMap.firstKey walks left); O(1) in Linux kernel (cached `rb_leftmost`)
- `tick` (one scheduling cycle): O(log n) for remove + O(log n) for re-insert = O(log n)

**JVM insight:** The TreeMap's red-black tree stores entries as `TreeMap.Entry` objects. Each entry is a separate heap allocation: 48 bytes (header + key ref + value ref + left/right/parent refs + color bit). For 10,000 runnable processes, the tree alone consumes ~480 KB plus the Process objects. Linux's kernel implementation uses intrusive red-black tree nodes embedded directly in the `struct sched_entity`, avoiding separate allocations entirely.

**Real-world correlation:** **Linux CFS** is this exact algorithm. **Kubernetes CPU scheduling** interacts with CFS through cgroup bandwidth throttling. When you set `resources.limits.cpu: "500m"` in a Pod spec, the CFS bandwidth controller limits the container's cgroup to 50ms per 100ms period.

### 13.1.2 Priority Queue Scheduling

The simplest scheduler model: maintain a max-heap (or min-heap) of processes ordered by priority. Always run the highest-priority process. This is the foundation of real-time scheduling and appears constantly in interview problems.

```java
import java.util.PriorityQueue;

/**
 * Priority-based preemptive scheduler.
 * Higher priority number = higher priority (runs first).
 * Uses PriorityQueue (min-heap) with negated priorities for max-heap behavior.
 */
public class PriorityScheduler {

    static class Task implements Comparable<Task> {
        final int id;
        final int priority;      // higher = more important
        final long burstTime;    // total CPU time needed (ms)
        long remainingTime;      // remaining CPU time
        long arrivalTime;
        long startTime = -1;
        long completionTime;

        Task(int id, int priority, long burstTime, long arrivalTime) {
            this.id = id;
            this.priority = priority;
            this.burstTime = burstTime;
            this.remainingTime = burstTime;
            this.arrivalTime = arrivalTime;
        }

        @Override
        public int compareTo(Task other) {
            // Higher priority first (negate for min-heap)
            int cmp = Integer.compare(other.priority, this.priority);
            if (cmp != 0) return cmp;
            // FCFS tiebreak
            return Long.compare(this.arrivalTime, other.arrivalTime);
        }
    }

    private final PriorityQueue<Task> readyQueue = new PriorityQueue<>();

    /** Preemptive priority scheduling simulation. */
    public void simulate(Task[] tasks) {
        int completed = 0;
        long currentTime = 0;
        int idx = 0;

        // Sort by arrival time
        java.util.Arrays.sort(tasks, (a, b) -> Long.compare(a.arrivalTime, b.arrivalTime));

        while (completed < tasks.length) {
            // Add all tasks that have arrived by currentTime
            while (idx < tasks.length && tasks[idx].arrivalTime <= currentTime) {
                readyQueue.offer(tasks[idx]);
                idx++;
            }

            if (readyQueue.isEmpty()) {
                // CPU idle -- jump to next arrival
                currentTime = tasks[idx].arrivalTime;
                continue;
            }

            Task current = readyQueue.poll();
            if (current.startTime == -1) {
                current.startTime = currentTime;
            }

            // Run for 1 time unit (preemptive: check for higher priority after each unit)
            current.remainingTime--;
            currentTime++;

            // Check if new higher-priority tasks arrived
            while (idx < tasks.length && tasks[idx].arrivalTime <= currentTime) {
                readyQueue.offer(tasks[idx]);
                idx++;
            }

            if (current.remainingTime == 0) {
                current.completionTime = currentTime;
                completed++;
                long turnaround = current.completionTime - current.arrivalTime;
                long waiting = turnaround - current.burstTime;
                System.out.printf("Task %d: turnaround=%d waiting=%d%n",
                    current.id, turnaround, waiting);
            } else {
                // Preempt: put back if a higher priority task is now ready
                readyQueue.offer(current);
            }
        }
    }
}
```

**Complexity:** O(n log n) total for n tasks -- each task is inserted and removed from the heap once, each operation O(log n). The preemptive tick-based simulation is O(T * log n) where T is total time units, but in practice we can optimize by computing the minimum of (next arrival, current task completion) to skip idle time.

### 13.1.3 Round-Robin: The Circular ArrayDeque

Round-robin is the fairness guarantee: every process gets an equal time slice (quantum), then goes to the back of the line. It is a circular queue -- and `ArrayDeque` is the perfect fit.

```java
import java.util.ArrayDeque;

/**
 * Round-robin scheduler using ArrayDeque as circular queue.
 * Each process runs for at most one quantum, then moves to the back.
 */
public class RoundRobinScheduler {

    static class Process {
        final int pid;
        final String name;
        long remainingTime;
        long arrivalTime;
        long completionTime;
        long firstRunTime = -1;

        Process(int pid, String name, long burstTime, long arrivalTime) {
            this.pid = pid;
            this.name = name;
            this.remainingTime = burstTime;
            this.arrivalTime = arrivalTime;
        }
    }

    private final ArrayDeque<Process> readyQueue = new ArrayDeque<>();
    private final long quantum;  // time slice in ms

    public RoundRobinScheduler(long quantum) {
        this.quantum = quantum;
    }

    /**
     * Simulate round-robin scheduling.
     * ArrayDeque gives O(1) pollFirst/offerLast -- perfect circular queue.
     */
    public void simulate(Process[] processes) {
        // Sort by arrival
        java.util.Arrays.sort(processes, 
            (a, b) -> Long.compare(a.arrivalTime, b.arrivalTime));

        long currentTime = 0;
        int idx = 0;
        int completed = 0;
        int total = processes.length;

        // Add initially available processes
        while (idx < total && processes[idx].arrivalTime <= currentTime) {
            readyQueue.offerLast(processes[idx++]);
        }

        while (completed < total) {
            if (readyQueue.isEmpty()) {
                currentTime = processes[idx].arrivalTime;
                while (idx < total && processes[idx].arrivalTime <= currentTime) {
                    readyQueue.offerLast(processes[idx++]);
                }
                continue;
            }

            Process p = readyQueue.pollFirst();  // O(1)
            if (p.firstRunTime == -1) p.firstRunTime = currentTime;

            // Run for min(quantum, remainingTime)
            long runTime = Math.min(quantum, p.remainingTime);
            p.remainingTime -= runTime;
            currentTime += runTime;

            // Add new arrivals during this quantum
            while (idx < total && processes[idx].arrivalTime <= currentTime) {
                readyQueue.offerLast(processes[idx++]);
            }

            if (p.remainingTime == 0) {
                p.completionTime = currentTime;
                completed++;
            } else {
                // Back of the line
                readyQueue.offerLast(p);  // O(1)
            }
        }
    }
}
```

**JVM insight:** `ArrayDeque` uses a circular array internally. The `pollFirst` and `offerLast` operations are O(1) with excellent cache locality -- the elements array is a single contiguous allocation. Contrast with `LinkedList`, which would allocate a new `Node` object (40 bytes on 64-bit JVM) per process in the queue, scattering them across the heap and causing cache misses on every dequeue. For a scheduler running thousands of context switches per second, this matters.

**Real-world correlation:** **Linux SCHED_RR** uses this exact model. Time quantum is typically 100ms. Java's `ScheduledThreadPoolExecutor` with fixed-rate scheduling also produces round-robin-like behavior across a thread pool.

### 13.1.4 Multi-Level Feedback Queue (MLFQ)

MLFQ is the most sophisticated general-purpose scheduler design. It maintains multiple priority queues. New processes start at the highest priority. If a process uses its entire time slice (CPU-bound), it drops to a lower priority. If it blocks for I/O before the slice expires (I/O-bound), it stays at the same level. This automatically classifies processes without requiring prior knowledge.

```java
import java.util.ArrayDeque;

/**
 * Multi-Level Feedback Queue scheduler.
 * - Multiple queues at different priority levels
 * - Higher priority queues get smaller time quanta
 * - Processes demote when they exhaust their quantum
 * - Periodic priority boost prevents starvation
 */
public class MLFQScheduler {

    static class Process {
        final int pid;
        final String name;
        long remainingTime;
        int currentLevel;         // 0 = highest priority
        long lastIoTime;          // track I/O behavior
        boolean usedFullQuantum;

        Process(int pid, String name, long burstTime) {
            this.pid = pid;
            this.name = name;
            this.remainingTime = burstTime;
            this.currentLevel = 0;  // start at highest priority
        }
    }

    private final int numLevels;
    private final ArrayDeque<Process>[] queues;
    private final long[] quanta;          // time quantum per level
    private final long boostInterval;     // how often to boost all to top
    private long wallClock = 0;
    private long lastBoostTime = 0;

    @SuppressWarnings("unchecked")
    public MLFQScheduler(int numLevels, long baseQuantum, long boostInterval) {
        this.numLevels = numLevels;
        this.queues = new ArrayDeque[numLevels];
        this.quanta = new long[numLevels];
        this.boostInterval = boostInterval;

        for (int i = 0; i < numLevels; i++) {
            queues[i] = new ArrayDeque<>();
            // Each level doubles the quantum: 10ms, 20ms, 40ms, ...
            quanta[i] = baseQuantum * (1L << i);
        }
    }

    /** Add a new process at the highest priority. */
    public void addProcess(Process p) {
        p.currentLevel = 0;
        queues[0].offerLast(p);
    }

    /** 
     * Priority boost: move ALL processes to the highest queue.
     * Prevents starvation of CPU-bound processes stuck at low priority.
     * This is Rule 5 of MLFQ (Solaris calls this "interactive boost").
     */
    private void priorityBoost() {
        for (int i = 1; i < numLevels; i++) {
            while (!queues[i].isEmpty()) {
                Process p = queues[i].pollFirst();
                p.currentLevel = 0;
                queues[0].offerLast(p);
            }
        }
        lastBoostTime = wallClock;
    }

    /** Run one scheduling cycle. Returns description of what happened. */
    public String schedule() {
        // Check for priority boost
        if (wallClock - lastBoostTime >= boostInterval) {
            priorityBoost();
        }

        // Find highest-priority non-empty queue
        for (int level = 0; level < numLevels; level++) {
            if (!queues[level].isEmpty()) {
                Process p = queues[level].pollFirst();
                long quantum = quanta[level];
                long runTime = Math.min(quantum, p.remainingTime);
                p.remainingTime -= runTime;
                wallClock += runTime;

                if (p.remainingTime == 0) {
                    return String.format("[t=%d] PID %d (%s) COMPLETED at level %d",
                        wallClock, p.pid, p.name, level);
                }

                // Did it use the full quantum? Demote.
                if (runTime == quantum && level < numLevels - 1) {
                    p.currentLevel = level + 1;
                    queues[level + 1].offerLast(p);
                    return String.format("[t=%d] PID %d (%s) demoted to level %d",
                        wallClock, p.pid, p.name, level + 1);
                } else {
                    // I/O bound or same level -- stay
                    queues[level].offerLast(p);
                    return String.format("[t=%d] PID %d (%s) stays at level %d",
                        wallClock, p.pid, p.name, level);
                }
            }
        }
        wallClock++;
        return String.format("[t=%d] IDLE", wallClock);
    }
}
```

**Complexity:** O(L) per scheduling decision where L is the number of levels (typically 3-8, so effectively O(1)). Priority boost is O(n) but amortized over the boost interval.

**Real-world correlation:** **Windows Thread Scheduler** uses a 32-level priority feedback queue. **Solaris TS (Timesharing) class** implements MLFQ with 60 priority levels. **FreeBSD's ULE scheduler** uses a similar feedback mechanism.

### 13.1.5 Real-Time Scheduling: Earliest Deadline First (EDF)

EDF is optimal among dynamic-priority algorithms: if any scheduler can meet all deadlines, EDF can. It simply runs the task whose absolute deadline is earliest. A `PriorityQueue` ordered by deadline implements this directly.

```java
import java.util.PriorityQueue;
import java.util.Comparator;

/**
 * Earliest Deadline First (EDF) real-time scheduler.
 * Optimal for single-processor preemptive scheduling of periodic tasks.
 * Feasible if and only if total utilization <= 1.0.
 */
public class EDFScheduler {

    static class RealTimeTask {
        final int id;
        final long period;       // period in ms
        final long wcet;         // worst-case execution time
        long remainingTime;
        long absoluteDeadline;   // current absolute deadline
        long nextRelease;        // next release time

        RealTimeTask(int id, long period, long wcet) {
            this.id = id;
            this.period = period;
            this.wcet = wcet;
            this.remainingTime = wcet;
            this.absoluteDeadline = period;
            this.nextRelease = 0;
        }

        double utilization() {
            return (double) wcet / period;
        }
    }

    private final PriorityQueue<RealTimeTask> readyQueue;

    public EDFScheduler() {
        // Min-heap by absolute deadline
        this.readyQueue = new PriorityQueue<>(
            Comparator.comparingLong(t -> t.absoluteDeadline)
        );
    }

    /** Check if task set is feasible under EDF. */
    public boolean isFeasible(RealTimeTask[] tasks) {
        double totalUtil = 0;
        for (RealTimeTask t : tasks) {
            totalUtil += t.utilization();
        }
        // EDF necessary and sufficient condition for preemptive uniprocessor
        return totalUtil <= 1.0;
    }

    /** Simulate for a given duration. Returns true if all deadlines met. */
    public boolean simulate(RealTimeTask[] tasks, long duration) {
        long currentTime = 0;
        boolean allDeadlinesMet = true;

        // Release initial instances
        for (RealTimeTask t : tasks) {
            t.remainingTime = t.wcet;
            t.absoluteDeadline = t.period;
            t.nextRelease = 0;
            readyQueue.offer(t);
        }

        while (currentTime < duration) {
            // Release new periodic instances
            for (RealTimeTask t : tasks) {
                if (currentTime >= t.nextRelease && t.remainingTime == 0) {
                    t.remainingTime = t.wcet;
                    t.absoluteDeadline = t.nextRelease + t.period;
                    t.nextRelease += t.period;
                    readyQueue.remove(t);
                    readyQueue.offer(t);
                }
            }

            if (readyQueue.isEmpty() || readyQueue.peek().remainingTime == 0) {
                currentTime++;
                continue;
            }

            RealTimeTask current = readyQueue.peek();
            current.remainingTime--;
            currentTime++;

            // Check deadline violation
            if (currentTime > current.absoluteDeadline && current.remainingTime > 0) {
                System.out.printf("DEADLINE MISS: Task %d at time %d%n",
                    current.id, currentTime);
                allDeadlinesMet = false;
            }
        }
        return allDeadlinesMet;
    }
}
```

**Real-world correlation:** **SCHED_DEADLINE** in Linux (since 3.14) implements EDF with CBS (Constant Bandwidth Server). **AUTOSAR** in automotive systems uses EDF-based scheduling for brake/steering control tasks.

---

## 13.2 Memory Management

Memory allocators are among the most performance-critical code in any system. The OS kernel allocates physical pages. The C runtime (glibc `malloc`) carves those pages into application-sized chunks. The JVM's garbage collector is itself a sophisticated allocator. Every allocator trades off between speed, fragmentation, and memory utilization -- and every one maps to a well-known data structure.

### 13.2.1 Buddy Allocator: Binary Tree of Power-of-2 Blocks

The buddy allocator is Linux's physical page allocator (the "page frame allocator"). It manages memory in power-of-2 blocks. To allocate, it finds the smallest block that fits, splitting larger blocks in half as needed. To free, it checks if the "buddy" (sibling block) is also free -- if so, they coalesce back into the larger block. This prevents external fragmentation while keeping O(log n) allocation.

```
Buddy allocator state for 64-unit memory:

Order 6 (64): [                    SPLIT                     ]
Order 5 (32): [       SPLIT        ] [       FREE(32)        ]
Order 4 (16): [   SPLIT   ] [ FREE ] [                       ]
Order 3 (8):  [ALLOC] [FREE] [      ] [                       ]

Free lists:
  Order 3 (8):  [block at offset 8]
  Order 4 (16): [block at offset 16]
  Order 5 (32): [block at offset 32]

To allocate 5 units: round up to 8 (order 3).
  - Check order 3 free list: block at offset 8. Allocate it.
  
To allocate 20 units: round up to 32 (order 5).
  - Check order 5 free list: block at offset 32. Allocate it.

To allocate 3 units: round up to 4 (order 2).
  - Order 2 free list: empty.
  - Order 3 free list: empty (we used it).
  - Order 4 free list: block at offset 16. Split into two order-3 blocks.
    -> offset 16 (order 3) and offset 24 (order 3).
    -> Put offset 24 into order-3 free list.
    -> Split offset 16 into two order-2 blocks.
    -> offset 16 (order 2) and offset 20 (order 2).
    -> Put offset 20 into order-2 free list.
    -> Allocate offset 16 (order 2).
```

```java
import java.util.ArrayList;
import java.util.List;

/**
 * Buddy allocator implementation.
 * Manages 2^maxOrder units of memory using power-of-2 block splitting/coalescing.
 * 
 * In Linux, this manages physical page frames. Order 0 = 4KB page.
 * Order 10 (MAX_ORDER-1) = 4MB contiguous block.
 */
public class BuddyAllocator {

    private final int maxOrder;            // maximum block order
    private final int totalSize;           // total units: 2^maxOrder
    private final List<List<Integer>> freeLists;  // freeLists[order] = list of free block offsets
    private final int[] blockOrder;        // blockOrder[offset] = order of allocated block (-1 if not start)
    private final boolean[] allocated;     // whether a block starting at offset is allocated

    public BuddyAllocator(int maxOrder) {
        this.maxOrder = maxOrder;
        this.totalSize = 1 << maxOrder;
        this.freeLists = new ArrayList<>();
        this.blockOrder = new int[totalSize];
        this.allocated = new boolean[totalSize];

        for (int i = 0; i <= maxOrder; i++) {
            freeLists.add(new ArrayList<>());
        }
        java.util.Arrays.fill(blockOrder, -1);

        // Initially, one big free block of order maxOrder at offset 0
        freeLists.get(maxOrder).add(0);
    }

    /**
     * Find the smallest order that can hold 'size' units.
     * order = ceil(log2(size)), minimum 0.
     */
    private int orderFor(int size) {
        int order = 0;
        int blockSize = 1;
        while (blockSize < size) {
            order++;
            blockSize <<= 1;
        }
        return order;
    }

    /**
     * Allocate a block of at least 'size' units.
     * Returns the offset of the allocated block, or -1 if allocation fails.
     * 
     * Algorithm:
     * 1. Round up size to nearest power of 2 (find the required order).
     * 2. Find the smallest free block of at least that order.
     * 3. If the found block is larger than needed, split it repeatedly.
     * 4. Mark as allocated.
     * 
     * Time: O(maxOrder) = O(log N) where N = totalSize.
     */
    public int allocate(int size) {
        if (size <= 0 || size > totalSize) return -1;

        int requiredOrder = orderFor(size);
        if (requiredOrder > maxOrder) return -1;

        // Find the smallest available order >= requiredOrder
        int foundOrder = -1;
        for (int order = requiredOrder; order <= maxOrder; order++) {
            if (!freeLists.get(order).isEmpty()) {
                foundOrder = order;
                break;
            }
        }

        if (foundOrder == -1) return -1;  // out of memory

        // Take the block from the free list
        int offset = freeLists.get(foundOrder).remove(
            freeLists.get(foundOrder).size() - 1);  // remove last for O(1)

        // Split down to the required order
        while (foundOrder > requiredOrder) {
            foundOrder--;
            int buddyOffset = offset + (1 << foundOrder);
            // Put the upper buddy on the free list
            freeLists.get(foundOrder).add(buddyOffset);
        }

        // Mark allocated
        allocated[offset] = true;
        blockOrder[offset] = requiredOrder;

        return offset;
    }

    /**
     * Free a previously allocated block at 'offset'.
     * Coalesces with buddy if buddy is also free.
     * 
     * Algorithm:
     * 1. Look up the order of the block.
     * 2. Compute buddy offset: offset XOR (1 << order).
     * 3. If buddy is free and same order, coalesce: remove buddy from free list,
     *    merge into parent (lower offset, order+1), repeat.
     * 4. If buddy is not free, put this block on the free list.
     * 
     * Time: O(maxOrder) = O(log N).
     */
    public void free(int offset) {
        if (!allocated[offset]) {
            throw new IllegalArgumentException("Block at " + offset + " is not allocated");
        }

        int order = blockOrder[offset];
        allocated[offset] = false;
        blockOrder[offset] = -1;

        // Coalesce with buddy
        while (order < maxOrder) {
            int buddyOffset = offset ^ (1 << order);

            // Check if buddy is free at the same order
            if (buddyOffset < totalSize && !allocated[buddyOffset] 
                    && freeLists.get(order).contains(buddyOffset)) {
                // Remove buddy from free list
                freeLists.get(order).remove(Integer.valueOf(buddyOffset));
                // Merge: take the lower offset
                offset = Math.min(offset, buddyOffset);
                order++;
            } else {
                break;
            }
        }

        // Add coalesced block to free list
        freeLists.get(order).add(offset);
    }

    /** Get allocation state summary. */
    public String status() {
        StringBuilder sb = new StringBuilder("Buddy Allocator Status:\n");
        for (int order = 0; order <= maxOrder; order++) {
            sb.append(String.format("  Order %d (size %d): %d free blocks%n",
                order, 1 << order, freeLists.get(order).size()));
        }
        return sb.toString();
    }
}
```

**Internal fragmentation:** If you request 5 units, you get an 8-unit block. 3 units wasted. Worst case: request N+1, get 2N. Up to ~50% internal fragmentation. This is the fundamental tradeoff of buddy allocation.

**Real-world correlation:** **Linux `alloc_pages()`** is the buddy allocator. You can see its state in `/proc/buddyinfo`. **JVM large page allocation** (when using `-XX:+UseLargePages`) goes through the buddy allocator for huge pages. **jemalloc** and **tcmalloc** use buddy-like splitting for larger size classes.

### 13.2.2 Slab Allocator: Object Pools for Common Sizes

The buddy allocator has a problem: it wastes memory for small allocations (allocating a 64-byte `struct inode` requires a 4KB page). The slab allocator solves this by pre-allocating pools ("slabs") of same-sized objects. Each slab is one or more contiguous pages from the buddy allocator, divided into fixed-size slots.

```
Slab allocator for "struct inode" (size = 512 bytes):

Slab (one 4KB page = 8 slots):
┌──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┐
│ inode│ inode│ FREE │ inode│ FREE │ inode│ FREE │ inode│
│  #1  │  #2  │      │  #4  │      │  #6  │      │  #8  │
└──────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┘
                  │              │              │
                  └──────────────┴──────────────┘
                           Free list

Cache "inode_cache":
  - Object size: 512 bytes
  - Slabs full: 12
  - Slabs partial: 3  (allocate from these first)
  - Slabs empty: 1    (return to buddy if too many)
```

```java
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;

/**
 * Slab allocator simulation.
 * Pre-allocates fixed-size object pools for common sizes.
 * O(1) allocate and free.
 *
 * In Linux, each kernel object type (inode, dentry, task_struct)
 * gets its own slab cache: kmem_cache_create("inode_cache", sizeof(struct inode), ...).
 */
public class SlabAllocator {

    /** A slab is a pre-allocated chunk divided into fixed-size slots. */
    static class Slab {
        final int slotSize;
        final int slotsPerSlab;
        final byte[] memory;
        final ArrayDeque<Integer> freeSlots;  // stack of free slot offsets
        int allocatedCount;

        Slab(int slotSize, int slabSize) {
            this.slotSize = slotSize;
            this.slotsPerSlab = slabSize / slotSize;
            this.memory = new byte[slabSize];
            this.freeSlots = new ArrayDeque<>();
            this.allocatedCount = 0;

            // Initialize free list with all slots
            for (int i = 0; i < slotsPerSlab; i++) {
                freeSlots.push(i * slotSize);
            }
        }

        boolean isFull() { return freeSlots.isEmpty(); }
        boolean isEmpty() { return allocatedCount == 0; }

        /** Allocate one slot. O(1). Returns offset within slab. */
        int allocate() {
            if (isFull()) return -1;
            int offset = freeSlots.pop();
            allocatedCount++;
            return offset;
        }

        /** Free one slot by offset. O(1). */
        void free(int offset) {
            freeSlots.push(offset);
            allocatedCount--;
        }
    }

    /** A cache manages all slabs for a particular object size. */
    static class SlabCache {
        final String name;
        final int objectSize;
        final int slabSize;                        // typically 4096 (one page)
        final ArrayDeque<Slab> partialSlabs;       // have some free slots
        final ArrayDeque<Slab> fullSlabs;          // no free slots
        final ArrayDeque<Slab> emptySlabs;         // all slots free
        long totalAllocations;
        long totalFrees;

        SlabCache(String name, int objectSize, int slabSize) {
            this.name = name;
            this.objectSize = objectSize;
            this.slabSize = slabSize;
            this.partialSlabs = new ArrayDeque<>();
            this.fullSlabs = new ArrayDeque<>();
            this.emptySlabs = new ArrayDeque<>();
        }

        /** Allocate one object. O(1) amortized. */
        SlabAllocation allocate() {
            Slab slab;

            if (!partialSlabs.isEmpty()) {
                slab = partialSlabs.peek();
            } else if (!emptySlabs.isEmpty()) {
                slab = emptySlabs.poll();
                partialSlabs.offer(slab);
            } else {
                // Need a new slab from the page allocator (buddy allocator)
                slab = new Slab(objectSize, slabSize);
                partialSlabs.offer(slab);
            }

            int offset = slab.allocate();
            totalAllocations++;

            // Move slab to full list if it is now full
            if (slab.isFull()) {
                partialSlabs.remove(slab);
                fullSlabs.offer(slab);
            }

            return new SlabAllocation(slab, offset);
        }

        /** Free one object. O(1). */
        void free(SlabAllocation alloc) {
            Slab slab = alloc.slab;
            boolean wasFull = slab.isFull();
            slab.free(alloc.offset);
            totalFrees++;

            if (wasFull) {
                fullSlabs.remove(slab);
                partialSlabs.offer(slab);
            } else if (slab.isEmpty()) {
                partialSlabs.remove(slab);
                emptySlabs.offer(slab);
            }
        }
    }

    static class SlabAllocation {
        final Slab slab;
        final int offset;
        SlabAllocation(Slab slab, int offset) {
            this.slab = slab;
            this.offset = offset;
        }
    }

    // Registry of caches, keyed by name
    private final Map<String, SlabCache> caches = new HashMap<>();

    /** Create a named cache for objects of a specific size. */
    public void createCache(String name, int objectSize) {
        int slabSize = 4096;  // one page
        // Ensure slab can hold at least one object
        if (objectSize > slabSize) slabSize = objectSize;
        caches.put(name, new SlabCache(name, objectSize, slabSize));
    }

    /** Allocate from a named cache. O(1) amortized. */
    public SlabAllocation allocate(String cacheName) {
        SlabCache cache = caches.get(cacheName);
        if (cache == null) throw new IllegalArgumentException("No cache: " + cacheName);
        return cache.allocate();
    }

    /** Free back to a named cache. O(1). */
    public void free(String cacheName, SlabAllocation alloc) {
        SlabCache cache = caches.get(cacheName);
        if (cache == null) throw new IllegalArgumentException("No cache: " + cacheName);
        cache.free(alloc);
    }
}
```

**Complexity:** O(1) for both allocate and free (amortized -- new slab creation from the buddy allocator is O(log n) but amortized over all slots in the slab).

**Real-world correlation:** **Linux SLUB allocator** (default since 2.6.22) is a simplified slab allocator. You can see its caches in `/proc/slabinfo`: `dentry`, `inode_cache`, `task_struct`, `mm_struct`, etc. **TLAB (Thread-Local Allocation Buffers)** in the JVM serve a similar purpose: each thread gets a pre-allocated chunk of eden space for fast, lock-free allocation. **Object pooling** in frameworks like Apache Commons Pool and HikariCP connection pools follow the same pattern.

### 13.2.3 Page Replacement Algorithms

When physical memory is full and a page fault occurs, the OS must evict a page to make room. The choice of which page to evict is the page replacement problem -- one of the most studied problems in CS. Each algorithm corresponds to a different data structure.

```java
import java.util.*;

/**
 * Page replacement algorithm implementations.
 * Each takes a sequence of page references and a frame count,
 * and returns the number of page faults.
 */
public class PageReplacement {

    // ========================================================================
    // FIFO: Queue-based. Evict the oldest page.
    // ========================================================================
    public static int fifo(int[] pages, int frameCount) {
        Set<Integer> frames = new HashSet<>();
        Queue<Integer> queue = new LinkedList<>();  // arrival order
        int faults = 0;

        for (int page : pages) {
            if (!frames.contains(page)) {
                faults++;
                if (frames.size() == frameCount) {
                    int evicted = queue.poll();
                    frames.remove(evicted);
                }
                frames.add(page);
                queue.offer(page);
            }
        }
        return faults;
    }

    // ========================================================================
    // LRU: LinkedHashMap with access-order. Evict least recently used.
    // This is the most common interview question on page replacement.
    // ========================================================================
    public static int lru(int[] pages, int frameCount) {
        // LinkedHashMap with accessOrder=true gives us LRU for free.
        // The eldest entry (head of doubly-linked list) is the LRU page.
        LinkedHashMap<Integer, Boolean> cache = new LinkedHashMap<>(
            frameCount, 0.75f, true  // accessOrder = true
        ) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<Integer, Boolean> eldest) {
                return size() > frameCount;
            }
        };

        int faults = 0;
        for (int page : pages) {
            if (!cache.containsKey(page)) {
                faults++;
            }
            cache.put(page, true);  // this also updates access order
        }
        return faults;
    }

    // ========================================================================
    // Clock (Second Chance): Circular array with use/reference bit.
    // Approximation of LRU with O(1) amortized eviction.
    // ========================================================================
    public static int clock(int[] pages, int frameCount) {
        int[] frames = new int[frameCount];
        boolean[] useBit = new boolean[frameCount];
        Arrays.fill(frames, -1);
        int hand = 0;        // clock hand position
        int loaded = 0;
        int faults = 0;
        Set<Integer> frameSet = new HashSet<>();
        Map<Integer, Integer> pageToSlot = new HashMap<>();

        for (int page : pages) {
            if (frameSet.contains(page)) {
                // Hit: set use bit
                useBit[pageToSlot.get(page)] = true;
                continue;
            }

            faults++;

            if (loaded < frameCount) {
                // Still have empty frames
                frames[loaded] = page;
                useBit[loaded] = true;
                pageToSlot.put(page, loaded);
                frameSet.add(page);
                loaded++;
            } else {
                // Clock sweep: find a page with useBit = false
                while (useBit[hand]) {
                    useBit[hand] = false;  // give second chance
                    hand = (hand + 1) % frameCount;
                }
                // Evict the page at hand
                int evicted = frames[hand];
                frameSet.remove(evicted);
                pageToSlot.remove(evicted);

                frames[hand] = page;
                useBit[hand] = true;
                pageToSlot.put(page, hand);
                frameSet.add(page);

                hand = (hand + 1) % frameCount;
            }
        }
        return faults;
    }

    // ========================================================================
    // LFU: Evict least frequently used page. On tie, evict LRU among them.
    // HashMap + frequency tracking.
    // ========================================================================
    public static int lfu(int[] pages, int frameCount) {
        Map<Integer, Integer> pageFreq = new HashMap<>();   // page -> frequency
        Map<Integer, Integer> pageTime = new HashMap<>();   // page -> last access time
        Set<Integer> frames = new HashSet<>();
        int faults = 0;

        for (int t = 0; t < pages.length; t++) {
            int page = pages[t];

            if (frames.contains(page)) {
                pageFreq.merge(page, 1, Integer::sum);
                pageTime.put(page, t);
                continue;
            }

            faults++;

            if (frames.size() == frameCount) {
                // Find LFU page (LRU on tie)
                int victim = -1;
                int minFreq = Integer.MAX_VALUE;
                int minTime = Integer.MAX_VALUE;

                for (int p : frames) {
                    int freq = pageFreq.getOrDefault(p, 0);
                    int time = pageTime.getOrDefault(p, 0);
                    if (freq < minFreq || (freq == minFreq && time < minTime)) {
                        minFreq = freq;
                        minTime = time;
                        victim = p;
                    }
                }
                frames.remove(victim);
                pageFreq.remove(victim);
                pageTime.remove(victim);
            }

            frames.add(page);
            pageFreq.put(page, 1);
            pageTime.put(page, t);
        }
        return faults;
    }

    // ========================================================================
    // Optimal (Belady): Evict the page that will not be used for the longest time.
    // Not implementable in practice (requires future knowledge), but useful as
    // a baseline for comparison.
    // ========================================================================
    public static int optimal(int[] pages, int frameCount) {
        Set<Integer> frames = new HashSet<>();
        int faults = 0;

        for (int i = 0; i < pages.length; i++) {
            if (frames.contains(pages[i])) continue;

            faults++;

            if (frames.size() == frameCount) {
                // Evict the page used farthest in the future (or never)
                int victim = -1;
                int farthest = -1;
                for (int page : frames) {
                    int nextUse = Integer.MAX_VALUE;
                    for (int j = i + 1; j < pages.length; j++) {
                        if (pages[j] == page) {
                            nextUse = j;
                            break;
                        }
                    }
                    if (nextUse > farthest) {
                        farthest = nextUse;
                        victim = page;
                    }
                }
                frames.remove(victim);
            }
            frames.add(pages[i]);
        }
        return faults;
    }
}
```

**Comparison of approaches:**

| Algorithm | Data Structure | Eviction Cost | Hit Update Cost | Approximation Quality |
|-----------|---------------|---------------|-----------------|----------------------|
| FIFO | Queue + HashSet | O(1) | O(1) | Poor (Belady's anomaly) |
| LRU | LinkedHashMap | O(1) | O(1) | Good |
| Clock | Circular array + bit | O(1) amortized | O(1) | Good (approx. LRU) |
| LFU | HashMap + freq map | O(n) naive | O(1) | Context-dependent |
| Optimal | N/A (oracle) | O(n) | O(1) | Perfect (theoretical) |

**JVM insight:** `LinkedHashMap` with `accessOrder=true` maintains a doubly-linked list threaded through the hash entries. Each `get` or `put` operation moves the accessed entry to the tail. The head is always the LRU entry. This is O(1) for all operations -- the same approach used by **Caffeine** (the caching library used by Spring) and **Guava Cache**. The JVM itself uses an approximation of LRU for code cache eviction (evicting JIT-compiled methods that have not been called recently).

**Real-world correlation:** **Linux** uses a two-list approximation of LRU (active list + inactive list) in its page frame reclaimer. **Redis** uses an approximation of LRU (sampling-based) because true LRU requires per-access metadata updates that are too expensive.

### 13.2.4 Page Table: Multi-Level Radix Tree

A page table maps virtual addresses to physical addresses. A flat array would be enormous (2^48 virtual address space / 4KB pages = 2^36 entries = 64 GB just for the table). Instead, modern architectures use a multi-level page table -- essentially a radix tree with a fixed branching factor.

```
x86-64 4-level page table (each level indexes 9 bits):

Virtual address: 48 bits total
┌──────────┬──────────┬──────────┬──────────┬──────────────┐
│ PML4 (9) │ PDPT (9) │  PD (9)  │  PT (9)  │ Offset (12)  │
└──────────┴──────────┴──────────┴──────────┴──────────────┘

Level 4 (PML4): 512 entries, each points to a PDPT
Level 3 (PDPT): 512 entries, each points to a PD
Level 2 (PD):   512 entries, each points to a PT
Level 1 (PT):   512 entries, each maps to a physical page

Sparse virtual address space: most entries are NULL.
Only populated regions have allocated subtables.
```

```java
/**
 * Simplified multi-level page table (3 levels for demonstration).
 * This is a radix tree: each level indexes a portion of the virtual address.
 * 
 * Real x86-64 has 4 levels, each with 512 (2^9) entries.
 * We simplify to 3 levels with 16 (2^4) entries each, 
 * mapping a 16-bit address space with 16-byte pages.
 */
public class MultiLevelPageTable {

    static final int LEVELS = 3;
    static final int BITS_PER_LEVEL = 4;    // 2^4 = 16 entries per table
    static final int ENTRIES_PER_TABLE = 1 << BITS_PER_LEVEL;
    static final int OFFSET_BITS = 4;       // 16-byte pages
    static final int PAGE_SIZE = 1 << OFFSET_BITS;

    /** Each page table entry: either points to next-level table or to physical page. */
    static class PageTableEntry {
        Object next;         // either PageTableEntry[] (next level) or Integer (physical page number)
        boolean present;
        boolean dirty;
        boolean accessed;

        PageTableEntry() {
            this.present = false;
        }
    }

    private PageTableEntry[] root;  // Level-3 (topmost) page table
    private int nextPhysicalPage = 0;

    public MultiLevelPageTable() {
        root = new PageTableEntry[ENTRIES_PER_TABLE];
        for (int i = 0; i < ENTRIES_PER_TABLE; i++) {
            root[i] = new PageTableEntry();
        }
    }

    /** Extract the index for a given level from a virtual page number. */
    private int getIndex(int vpn, int level) {
        // Level 2 (top): bits 11-8, Level 1: bits 7-4, Level 0: bits 3-0
        int shift = level * BITS_PER_LEVEL;
        return (vpn >> shift) & (ENTRIES_PER_TABLE - 1);
    }

    /**
     * Translate virtual page number to physical page number.
     * Walks the multi-level table (radix tree traversal).
     * 
     * Time: O(LEVELS) = O(1) constant for fixed architecture.
     * But each level is a memory access -- this is why TLBs are critical.
     */
    public int translate(int virtualPageNumber) {
        PageTableEntry[] table = root;

        // Walk levels 2, 1 (intermediate levels)
        for (int level = LEVELS - 1; level > 0; level--) {
            int idx = getIndex(virtualPageNumber, level);
            PageTableEntry entry = table[idx];

            if (!entry.present) {
                return -1;  // page fault: not mapped
            }
            entry.accessed = true;
            table = (PageTableEntry[]) entry.next;
        }

        // Level 0: leaf level, maps to physical page
        int idx = getIndex(virtualPageNumber, 0);
        PageTableEntry entry = table[idx];
        if (!entry.present) {
            return -1;  // page fault
        }
        entry.accessed = true;
        return (Integer) entry.next;
    }

    /**
     * Map a virtual page to a physical page.
     * Creates intermediate table levels as needed (lazy allocation).
     */
    public void mapPage(int virtualPageNumber, int physicalPageNumber) {
        PageTableEntry[] table = root;

        // Walk/create intermediate levels
        for (int level = LEVELS - 1; level > 0; level--) {
            int idx = getIndex(virtualPageNumber, level);
            PageTableEntry entry = table[idx];

            if (!entry.present) {
                // Allocate next-level page table
                PageTableEntry[] nextTable = new PageTableEntry[ENTRIES_PER_TABLE];
                for (int i = 0; i < ENTRIES_PER_TABLE; i++) {
                    nextTable[i] = new PageTableEntry();
                }
                entry.next = nextTable;
                entry.present = true;
            }
            table = (PageTableEntry[]) entry.next;
        }

        // Set leaf entry
        int idx = getIndex(virtualPageNumber, 0);
        table[idx].next = physicalPageNumber;
        table[idx].present = true;
    }
}
```

**TLB simulation (hardware hash table):**

```java
/**
 * TLB (Translation Lookaside Buffer) simulation.
 * A small, fully-associative cache of recent virtual-to-physical translations.
 * 
 * Real TLBs: L1 dTLB = 64 entries (4-way), L2 TLB = 1536 entries (12-way).
 * A TLB miss costs ~7ns (page table walk) vs ~0.5ns for a TLB hit.
 */
public class TLBSimulator {

    private final int capacity;
    private final LinkedHashMap<Integer, Integer> cache;  // VPN -> PPN
    private long hits = 0;
    private long misses = 0;

    public TLBSimulator(int capacity) {
        this.capacity = capacity;
        // LRU eviction using LinkedHashMap
        this.cache = new LinkedHashMap<>(capacity, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<Integer, Integer> eldest) {
                return size() > capacity;
            }
        };
    }

    /** Lookup VPN in TLB. Returns PPN or -1 on miss. */
    public int lookup(int vpn) {
        Integer ppn = cache.get(vpn);
        if (ppn != null) {
            hits++;
            return ppn;
        }
        misses++;
        return -1;
    }

    /** Insert a translation after a TLB miss. */
    public void insert(int vpn, int ppn) {
        cache.put(vpn, ppn);
    }

    /** Flush entire TLB (e.g., on context switch). */
    public void flush() {
        cache.clear();
    }

    public double hitRate() {
        long total = hits + misses;
        return total == 0 ? 0 : (double) hits / total;
    }
}
```

**Real-world correlation:** **x86-64** uses a 4-level page table (PML4/PDPT/PD/PT). **ARM64** uses a similar 4-level scheme. TLB misses are one of the most significant performance bottlenecks in large-heap JVM applications -- a 100GB heap with random access patterns thrashes the TLB mercilessly. This is why **huge pages** (`-XX:+UseLargePages`) help: 2MB pages reduce TLB entries needed by 512x.

---

## 13.3 File System Data Structures

File systems are the most underappreciated data structure showcase in computing. A single file system implementation combines B-trees, bitmaps, linked lists, journals (write-ahead logs), and radix trees. Understanding these internals transforms how you think about storage-layer performance.

### 13.3.1 Directory Structure: B-Tree and Trie

Modern file systems use B-tree variants for directory lookup. ext4's `htree` is a B-tree-like hash tree. For path resolution, a trie structure naturally models the hierarchical path.

```java
import java.util.*;

/**
 * In-memory file system using a trie for path resolution
 * and a B-tree-like sorted structure for directory entries.
 */
public class FileSystemTrie {

    static class FSNode {
        final String name;
        final boolean isDirectory;
        long size;
        long inode;
        long createdAt;
        long modifiedAt;
        // Children: sorted map for directory listing (like ext4 htree)
        final TreeMap<String, FSNode> children;

        FSNode(String name, boolean isDirectory, long inode) {
            this.name = name;
            this.isDirectory = isDirectory;
            this.inode = inode;
            this.createdAt = System.currentTimeMillis();
            this.modifiedAt = this.createdAt;
            this.children = isDirectory ? new TreeMap<>() : null;
        }
    }

    private final FSNode root;
    private long nextInode = 1;

    public FileSystemTrie() {
        this.root = new FSNode("/", true, nextInode++);
    }

    /** 
     * Resolve a path to its FSNode.
     * Path resolution is a trie traversal: /home/user/file.txt 
     * traverses root -> "home" -> "user" -> "file.txt".
     * 
     * Time: O(D * L) where D = depth, L = average name length for comparison.
     * With TreeMap children: O(D * log(B) * L) where B = avg entries per directory.
     */
    public FSNode resolve(String path) {
        if (path.equals("/")) return root;

        String[] parts = path.split("/");
        FSNode current = root;

        for (int i = 1; i < parts.length; i++) {
            if (!current.isDirectory || current.children == null) return null;
            current = current.children.get(parts[i]);
            if (current == null) return null;
        }
        return current;
    }

    /** Create a file at the given path. */
    public boolean createFile(String path) {
        int lastSlash = path.lastIndexOf('/');
        String parentPath = lastSlash == 0 ? "/" : path.substring(0, lastSlash);
        String fileName = path.substring(lastSlash + 1);

        FSNode parent = resolve(parentPath);
        if (parent == null || !parent.isDirectory) return false;
        if (parent.children.containsKey(fileName)) return false;

        parent.children.put(fileName, new FSNode(fileName, false, nextInode++));
        parent.modifiedAt = System.currentTimeMillis();
        return true;
    }

    /** Create a directory (mkdir -p semantics: create intermediate dirs). */
    public boolean mkdirp(String path) {
        String[] parts = path.split("/");
        FSNode current = root;

        for (int i = 1; i < parts.length; i++) {
            if (parts[i].isEmpty()) continue;
            FSNode child = current.children.get(parts[i]);
            if (child == null) {
                child = new FSNode(parts[i], true, nextInode++);
                current.children.put(parts[i], child);
            } else if (!child.isDirectory) {
                return false;  // path component exists as file
            }
            current = child;
        }
        return true;
    }

    /** List directory contents (like `ls`). Returns sorted names. */
    public List<String> listDir(String path) {
        FSNode node = resolve(path);
        if (node == null || !node.isDirectory) return Collections.emptyList();
        return new ArrayList<>(node.children.keySet());  // TreeMap: already sorted
    }

    /** Delete a file or empty directory. */
    public boolean delete(String path) {
        if (path.equals("/")) return false;

        int lastSlash = path.lastIndexOf('/');
        String parentPath = lastSlash == 0 ? "/" : path.substring(0, lastSlash);
        String name = path.substring(lastSlash + 1);

        FSNode parent = resolve(parentPath);
        if (parent == null || !parent.isDirectory) return false;

        FSNode target = parent.children.get(name);
        if (target == null) return false;
        if (target.isDirectory && !target.children.isEmpty()) return false;

        parent.children.remove(name);
        return true;
    }
}
```

**Real-world correlation:** **ext4 htree** uses a hash-based B-tree for directories with more than ~2 entries (the `dx_root` and `dx_entry` structures). **ZFS** uses a hash table (ZAP -- ZFS Attribute Processor) for directory entries. **NTFS** uses a B+ tree for its MFT (Master File Table).

### 13.3.2 Free Block Bitmap

File systems track which disk blocks are free using a bitmap. Each bit represents one block: 1 = free, 0 = allocated (or vice versa). For a 1TB disk with 4KB blocks, the bitmap is 2^30 / 8 = 32 MB.

```java
import java.util.BitSet;

/**
 * Free block bitmap for a file system.
 * BitSet provides O(1) get/set and O(n/64) for finding the next free block
 * (scanning 64 bits at a time using long operations).
 */
public class FreeBlockBitmap {

    private final BitSet bitmap;
    private final int totalBlocks;
    private int freeCount;

    public FreeBlockBitmap(int totalBlocks) {
        this.totalBlocks = totalBlocks;
        this.bitmap = new BitSet(totalBlocks);
        this.bitmap.set(0, totalBlocks);  // all blocks start free (bit=1)
        this.freeCount = totalBlocks;
    }

    /** Allocate a single free block. Returns block number or -1. */
    public int allocateBlock() {
        int block = bitmap.nextSetBit(0);  // find first free block
        if (block == -1 || block >= totalBlocks) return -1;
        bitmap.clear(block);
        freeCount--;
        return block;
    }

    /** Allocate 'count' contiguous blocks. Returns start block or -1. */
    public int allocateContiguous(int count) {
        int start = 0;
        while (start + count <= totalBlocks) {
            // Find next free bit
            start = bitmap.nextSetBit(start);
            if (start == -1 || start + count > totalBlocks) return -1;

            // Check if 'count' consecutive bits are set
            int end = bitmap.nextClearBit(start);
            if (end - start >= count) {
                // Found enough contiguous free blocks
                bitmap.clear(start, start + count);
                freeCount -= count;
                return start;
            }
            // Skip past the allocated region
            start = end + 1;
        }
        return -1;
    }

    /** Free a block. */
    public void freeBlock(int block) {
        if (!bitmap.get(block)) {
            bitmap.set(block);
            freeCount++;
        }
    }

    /** Free a range of blocks. */
    public void freeRange(int start, int count) {
        for (int i = start; i < start + count; i++) {
            freeBlock(i);
        }
    }

    public int getFreeCount() { return freeCount; }
    public double utilizationPercent() { 
        return 100.0 * (totalBlocks - freeCount) / totalBlocks; 
    }
}
```

**JVM insight:** Java's `BitSet` uses a `long[]` internally. Each `long` holds 64 bits. `nextSetBit()` uses `Long.numberOfTrailingZeros()` which compiles to a single `TZCNT` instruction on modern x86 -- scanning 64 bits in one CPU cycle. For a 1 million block file system, the BitSet occupies only ~122 KB. Compare this to a `boolean[]` of the same size: 1 MB (8x larger, because each `boolean` occupies 1 byte in a Java array).

### 13.3.3 Journaling: Write-Ahead Log

Journaling ensures crash consistency. Before modifying file system metadata on disk, write the intended changes to a journal (log). If the system crashes mid-operation, replay the journal on recovery. This is exactly the same WAL (Write-Ahead Log) concept from databases (Chapter 12 cross-reference).

```java
import java.util.*;

/**
 * File system journal (Write-Ahead Log) simulation.
 * ext4 uses JBD2 (Journaling Block Device 2) for this.
 * 
 * Transaction lifecycle:
 * 1. Begin transaction
 * 2. Write all metadata changes to journal
 * 3. Commit record to journal (fsync)
 * 4. Write actual metadata to disk locations
 * 5. Mark journal transaction as complete
 */
public class FileSystemJournal {

    enum OpType { CREATE_INODE, UPDATE_INODE, DELETE_INODE, 
                  ALLOC_BLOCK, FREE_BLOCK, UPDATE_DIR }

    static class JournalEntry {
        final long transactionId;
        final OpType op;
        final long targetBlock;
        final byte[] oldData;   // for undo
        final byte[] newData;   // for redo
        final long timestamp;

        JournalEntry(long txId, OpType op, long targetBlock, 
                     byte[] oldData, byte[] newData) {
            this.transactionId = txId;
            this.op = op;
            this.targetBlock = targetBlock;
            this.oldData = oldData;
            this.newData = newData;
            this.timestamp = System.nanoTime();
        }
    }

    static class Transaction {
        final long id;
        final List<JournalEntry> entries = new ArrayList<>();
        boolean committed = false;
        boolean applied = false;

        Transaction(long id) { this.id = id; }
    }

    private final List<Transaction> journal = new ArrayList<>();  // append-only log
    private long nextTxId = 1;
    private Transaction activeTx = null;

    /** Begin a new transaction. */
    public Transaction begin() {
        if (activeTx != null) {
            throw new IllegalStateException("Nested transactions not supported");
        }
        activeTx = new Transaction(nextTxId++);
        journal.add(activeTx);
        return activeTx;
    }

    /** Add an operation to the active transaction. */
    public void logOperation(OpType op, long targetBlock, 
                             byte[] oldData, byte[] newData) {
        if (activeTx == null) throw new IllegalStateException("No active transaction");
        activeTx.entries.add(
            new JournalEntry(activeTx.id, op, targetBlock, oldData, newData));
    }

    /** Commit the transaction (write commit record). */
    public void commit() {
        if (activeTx == null) throw new IllegalStateException("No active transaction");
        activeTx.committed = true;
        // In real FS: fsync the journal here to ensure durability
        activeTx = null;
    }

    /** Mark transaction as fully applied (checkpoint). */
    public void markApplied(long txId) {
        for (Transaction tx : journal) {
            if (tx.id == txId) {
                tx.applied = true;
                return;
            }
        }
    }

    /**
     * Recovery after crash: replay committed but unapplied transactions.
     * Returns list of operations that need to be re-applied.
     */
    public List<JournalEntry> recover() {
        List<JournalEntry> toReplay = new ArrayList<>();
        for (Transaction tx : journal) {
            if (tx.committed && !tx.applied) {
                toReplay.addAll(tx.entries);
            }
            // Uncommitted transactions are discarded (crash before commit)
        }
        return toReplay;
    }

    /** Trim applied transactions (free journal space). */
    public void checkpoint() {
        journal.removeIf(tx -> tx.applied);
    }
}
```

**Real-world correlation:** **ext4 JBD2** journals metadata operations exactly this way. **XFS** uses a similar log for metadata. **PostgreSQL WAL** and **InnoDB redo log** follow the same pattern (Chapter 12 covers these in depth). The key insight is that sequential writes to a log are fast (one seek), while random writes to scattered metadata blocks are slow (many seeks).

---

## 13.4 Distributed Systems

Distributed systems are where data structures become truly creative. When you have no shared memory, no global clock, and no guarantee that any node will respond, the data structures you choose define the fundamental properties of your system: consistency, availability, partition tolerance. Every distributed system is a collection of local data structures plus a protocol for keeping them coordinated.

### 13.4.1 Consistent Hashing: TreeMap Ring (Cross-reference: Ch09)

Consistent hashing maps both keys and nodes onto a ring (a circular number space). A key is assigned to the first node encountered clockwise from its hash position. When a node joins or leaves, only ~K/N keys need to move (where K = total keys, N = total nodes), compared to rehashing everything.

```
Consistent hash ring with virtual nodes:

              Node A (v0)
                  │
                  ▼
        ┌─────── 0 ────────┐
       /                     \
  Node C (v2)──── 270°   90°── Node B (v0)
      │                         │
      │         RING            │
      │                         │
  Node A (v1)── 180°  135°── Node C (v1)
       \                     /
        └────── 180 ───────┘
                  ▲
                  │
             Node B (v1)

Key "user:123" hashes to position 95°
→ Clockwise next node is Node C (v1) at 135°
→ Route to Node C.
```

```java
import java.util.*;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Consistent hashing implementation using TreeMap as the ring.
 * TreeMap's red-black tree gives O(log n) for ceilingEntry() -- the "find next 
 * node clockwise" operation. With virtual nodes, load balancing improves from
 * O(N) variance to O(log N) variance.
 *
 * Cross-reference: Chapter 09 covers this as an advanced data structure.
 * Here we focus on the distributed systems use case.
 */
public class ConsistentHashRing<T> {

    private final TreeMap<Long, T> ring = new TreeMap<>();
    private final int virtualNodes;
    private final Map<T, Set<Long>> nodePositions = new HashMap<>();

    public ConsistentHashRing(int virtualNodes) {
        this.virtualNodes = virtualNodes;
    }

    /** Hash a string to a position on the ring. */
    private long hash(String key) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] digest = md.digest(key.getBytes());
            // Use first 8 bytes as a long
            long h = 0;
            for (int i = 0; i < 8; i++) {
                h = (h << 8) | (digest[i] & 0xFF);
            }
            return h;
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }

    /** Add a node to the ring with virtual nodes. O(V * log(N*V)). */
    public void addNode(T node) {
        Set<Long> positions = new HashSet<>();
        for (int i = 0; i < virtualNodes; i++) {
            long position = hash(node.toString() + "#" + i);
            ring.put(position, node);
            positions.add(position);
        }
        nodePositions.put(node, positions);
    }

    /** Remove a node from the ring. O(V * log(N*V)). */
    public void removeNode(T node) {
        Set<Long> positions = nodePositions.remove(node);
        if (positions != null) {
            for (long pos : positions) {
                ring.remove(pos);
            }
        }
    }

    /** Find which node a key maps to. O(log(N*V)). */
    public T getNode(String key) {
        if (ring.isEmpty()) return null;
        long hash = hash(key);
        // Find the first node clockwise from the hash position
        Map.Entry<Long, T> entry = ring.ceilingEntry(hash);
        if (entry == null) {
            // Wrap around to the first node on the ring
            entry = ring.firstEntry();
        }
        return entry.getValue();
    }

    /**
     * Get N replicas for a key (for replication).
     * Walk clockwise, skipping virtual nodes of the same physical node.
     */
    public List<T> getNodes(String key, int count) {
        if (ring.isEmpty()) return Collections.emptyList();

        List<T> nodes = new ArrayList<>();
        Set<T> seen = new HashSet<>();
        long hash = hash(key);

        // Get the tail map starting from the hash position
        NavigableMap<Long, T> tail = ring.tailMap(hash, true);
        // Iterate clockwise: tail map, then wrap around from the start
        for (T node : tail.values()) {
            if (seen.add(node)) {
                nodes.add(node);
                if (nodes.size() == count) return nodes;
            }
        }
        for (T node : ring.values()) {
            if (seen.add(node)) {
                nodes.add(node);
                if (nodes.size() == count) return nodes;
            }
        }
        return nodes;
    }
}
```

**Complexity:** `getNode`: O(log(N * V)) where N = physical nodes, V = virtual nodes per physical node. `addNode`/`removeNode`: O(V * log(N * V)).

**Real-world correlation:** **Amazon DynamoDB** and **Apache Cassandra** use consistent hashing for data partitioning. **Nginx** uses consistent hashing for upstream load balancing (`hash $request_uri consistent`). **Memcached** clients use consistent hashing for key distribution across cache servers.

### 13.4.2 Raft Consensus: Append-Only Log + Leader Election

Raft is the consensus algorithm that makes distributed state machines work. It is simpler than Paxos and has become the standard in practice. The core data structures are: an append-only log (ArrayList), a replicated state machine, and timeout-based leader election.

```java
import java.util.*;
import java.util.concurrent.*;

/**
 * Simplified Raft consensus implementation.
 * Focuses on the core data structures: log, state machine, election state.
 * 
 * Real implementations: etcd (Go), hashicorp/raft (Go), Apache Ratis (Java).
 */
public class RaftNode {

    enum State { FOLLOWER, CANDIDATE, LEADER }

    /** A log entry: command + term when it was received by the leader. */
    static class LogEntry {
        final int term;
        final String command;
        final long timestamp;

        LogEntry(int term, String command) {
            this.term = term;
            this.command = command;
            this.timestamp = System.currentTimeMillis();
        }

        @Override
        public String toString() {
            return String.format("[term=%d cmd=%s]", term, command);
        }
    }

    // Persistent state (survives crashes)
    private int currentTerm = 0;
    private Integer votedFor = null;
    private final List<LogEntry> log = new ArrayList<>();  // append-only log (index 0-based)

    // Volatile state
    private State state = State.FOLLOWER;
    private int commitIndex = -1;   // highest log entry known to be committed
    private int lastApplied = -1;   // highest log entry applied to state machine

    // Leader-only state (reinitialized after election)
    private Map<Integer, Integer> nextIndex;   // for each follower: next log index to send
    private Map<Integer, Integer> matchIndex;  // for each follower: highest log index replicated

    private final int nodeId;
    private final int clusterSize;
    private final Map<String, String> stateMachine = new HashMap<>();  // key-value store

    public RaftNode(int nodeId, int clusterSize) {
        this.nodeId = nodeId;
        this.clusterSize = clusterSize;
    }

    // ========================================================================
    // Log Operations
    // ========================================================================

    /** Append a new entry (leader only). O(1) amortized. */
    public int appendEntry(String command) {
        if (state != State.LEADER) {
            throw new IllegalStateException("Not leader");
        }
        LogEntry entry = new LogEntry(currentTerm, command);
        log.add(entry);
        return log.size() - 1;  // return log index
    }

    /** Get log entry at index. O(1) -- ArrayList random access. */
    public LogEntry getEntry(int index) {
        if (index < 0 || index >= log.size()) return null;
        return log.get(index);
    }

    /** Get the term of a log entry, or -1 if index is out of range. */
    public int getTermAt(int index) {
        if (index < 0 || index >= log.size()) return -1;
        return log.get(index).term;
    }

    /** Truncate log from index onward (conflict resolution). */
    public void truncateFrom(int index) {
        if (index < log.size()) {
            log.subList(index, log.size()).clear();
        }
    }

    // ========================================================================
    // AppendEntries RPC (leader -> followers)
    // ========================================================================

    static class AppendEntriesRequest {
        int term;
        int leaderId;
        int prevLogIndex;
        int prevLogTerm;
        List<LogEntry> entries;
        int leaderCommit;
    }

    static class AppendEntriesResponse {
        int term;
        boolean success;
        int matchIndex;
    }

    /**
     * Handle AppendEntries RPC from leader.
     * This is the core of Raft log replication.
     */
    public AppendEntriesResponse handleAppendEntries(AppendEntriesRequest req) {
        AppendEntriesResponse resp = new AppendEntriesResponse();
        resp.term = currentTerm;

        // Rule 1: Reply false if term < currentTerm
        if (req.term < currentTerm) {
            resp.success = false;
            return resp;
        }

        // Update term if stale
        if (req.term > currentTerm) {
            currentTerm = req.term;
            state = State.FOLLOWER;
            votedFor = null;
        }

        // Rule 2: Reply false if log doesn't contain an entry at prevLogIndex
        // with term matching prevLogTerm
        if (req.prevLogIndex >= 0) {
            if (req.prevLogIndex >= log.size() || 
                log.get(req.prevLogIndex).term != req.prevLogTerm) {
                resp.success = false;
                return resp;
            }
        }

        // Rule 3: If existing entry conflicts with new one, delete it and all following
        int insertIdx = req.prevLogIndex + 1;
        for (int i = 0; i < req.entries.size(); i++) {
            int logIdx = insertIdx + i;
            if (logIdx < log.size()) {
                if (log.get(logIdx).term != req.entries.get(i).term) {
                    truncateFrom(logIdx);
                    break;
                }
            }
        }

        // Rule 4: Append any new entries not already in the log
        for (int i = 0; i < req.entries.size(); i++) {
            int logIdx = insertIdx + i;
            if (logIdx >= log.size()) {
                log.add(req.entries.get(i));
            }
        }

        // Rule 5: Update commitIndex
        if (req.leaderCommit > commitIndex) {
            commitIndex = Math.min(req.leaderCommit, log.size() - 1);
            applyCommitted();
        }

        resp.success = true;
        resp.matchIndex = log.size() - 1;
        return resp;
    }

    // ========================================================================
    // RequestVote RPC (candidate -> all nodes)
    // ========================================================================

    static class VoteRequest {
        int term;
        int candidateId;
        int lastLogIndex;
        int lastLogTerm;
    }

    static class VoteResponse {
        int term;
        boolean voteGranted;
    }

    /**
     * Handle RequestVote RPC.
     * The "up-to-date" check ensures the elected leader has all committed entries.
     */
    public VoteResponse handleRequestVote(VoteRequest req) {
        VoteResponse resp = new VoteResponse();
        resp.term = currentTerm;

        if (req.term < currentTerm) {
            resp.voteGranted = false;
            return resp;
        }

        if (req.term > currentTerm) {
            currentTerm = req.term;
            state = State.FOLLOWER;
            votedFor = null;
        }

        // Grant vote if: haven't voted (or voted for this candidate)
        // AND candidate's log is at least as up-to-date as ours
        boolean logUpToDate = isLogUpToDate(req.lastLogIndex, req.lastLogTerm);
        if ((votedFor == null || votedFor == req.candidateId) && logUpToDate) {
            votedFor = req.candidateId;
            resp.voteGranted = true;
        } else {
            resp.voteGranted = false;
        }

        return resp;
    }

    /** Check if candidate's log is at least as up-to-date as ours. */
    private boolean isLogUpToDate(int lastIndex, int lastTerm) {
        int myLastTerm = log.isEmpty() ? -1 : log.get(log.size() - 1).term;
        int myLastIndex = log.size() - 1;

        if (lastTerm != myLastTerm) {
            return lastTerm > myLastTerm;
        }
        return lastIndex >= myLastIndex;
    }

    /** Become leader: initialize nextIndex and matchIndex for all followers. */
    public void becomeLeader() {
        state = State.LEADER;
        nextIndex = new HashMap<>();
        matchIndex = new HashMap<>();
        for (int i = 0; i < clusterSize; i++) {
            if (i != nodeId) {
                nextIndex.put(i, log.size());   // optimistic: assume followers are caught up
                matchIndex.put(i, -1);
            }
        }
    }

    /** Apply committed entries to the state machine. */
    private void applyCommitted() {
        while (lastApplied < commitIndex) {
            lastApplied++;
            LogEntry entry = log.get(lastApplied);
            applyToStateMachine(entry.command);
        }
    }

    /** Apply a command to the key-value state machine. */
    private void applyToStateMachine(String command) {
        // Simple key-value commands: "SET key value" or "DELETE key"
        String[] parts = command.split(" ");
        if (parts[0].equals("SET") && parts.length == 3) {
            stateMachine.put(parts[1], parts[2]);
        } else if (parts[0].equals("DELETE") && parts.length == 2) {
            stateMachine.remove(parts[1]);
        }
    }

    /** Query the state machine (reads go through leader for linearizability). */
    public String get(String key) {
        return stateMachine.get(key);
    }

    public int getLogSize() { return log.size(); }
    public State getState() { return state; }
    public int getCurrentTerm() { return currentTerm; }
}
```

**Complexity:** Log append: O(1) amortized (ArrayList). Log lookup by index: O(1). Log truncation from index i: O(n - i). Leader election: O(n) messages where n = cluster size.

**Real-world correlation:** **etcd** (Kubernetes' backing store) implements Raft. **Consul**, **CockroachDB**, and **TiKV** all use Raft for consensus. **Apache Kafka** uses a Raft variant (KRaft) since version 3.3, replacing ZooKeeper.

### 13.4.3 Vector Clocks: Causality Tracking

Vector clocks establish causal ordering in distributed systems without a global clock. Each process maintains a vector (array) of logical timestamps -- one entry per process. On local events, increment your own entry. When sending a message, attach your vector. On receiving, merge (element-wise max) the received vector with your own.

```java
import java.util.Arrays;

/**
 * Vector clock implementation for distributed causality tracking.
 * 
 * Two events e1, e2 with vector clocks VC(e1), VC(e2):
 * - e1 -> e2 (causally before) iff VC(e1)[i] <= VC(e2)[i] for all i, 
 *   and strictly less for at least one i.
 * - Concurrent (neither caused the other) if neither VC(e1) <= VC(e2) 
 *   nor VC(e2) <= VC(e1).
 */
public class VectorClock {

    private final int[] clock;
    private final int processId;
    private final int numProcesses;

    public VectorClock(int processId, int numProcesses) {
        this.processId = processId;
        this.numProcesses = numProcesses;
        this.clock = new int[numProcesses];
    }

    /** Local event: increment own clock. O(1). */
    public void localEvent() {
        clock[processId]++;
    }

    /** Send event: increment own clock and return a copy. O(n). */
    public int[] send() {
        clock[processId]++;
        return clock.clone();
    }

    /** Receive event: merge with received clock, then increment own. O(n). */
    public void receive(int[] received) {
        for (int i = 0; i < numProcesses; i++) {
            clock[i] = Math.max(clock[i], received[i]);
        }
        clock[processId]++;
    }

    /** Check if this clock is causally before another. O(n). */
    public boolean isBefore(int[] other) {
        boolean strictlyLess = false;
        for (int i = 0; i < numProcesses; i++) {
            if (clock[i] > other[i]) return false;
            if (clock[i] < other[i]) strictlyLess = true;
        }
        return strictlyLess;
    }

    /** Check if this clock is concurrent with another. O(n). */
    public boolean isConcurrentWith(int[] other) {
        boolean thisLess = false, otherLess = false;
        for (int i = 0; i < numProcesses; i++) {
            if (clock[i] < other[i]) thisLess = true;
            if (clock[i] > other[i]) otherLess = true;
        }
        return thisLess && otherLess;
    }

    /** Get a copy of the current clock. */
    public int[] getClock() { return clock.clone(); }

    @Override
    public String toString() {
        return "VC" + processId + Arrays.toString(clock);
    }

    // ========================================================================
    // Example simulation
    // ========================================================================
    public static void main(String[] args) {
        VectorClock p0 = new VectorClock(0, 3);
        VectorClock p1 = new VectorClock(1, 3);
        VectorClock p2 = new VectorClock(2, 3);

        // P0 does a local event
        p0.localEvent();
        System.out.println("P0 local: " + p0);   // VC0[1, 0, 0]

        // P0 sends to P1
        int[] msg1 = p0.send();                    // VC0[2, 0, 0]
        p1.receive(msg1);                           // VC1[2, 1, 0]
        System.out.println("P0 send:  " + p0);
        System.out.println("P1 recv:  " + p1);

        // P2 does a local event (concurrent with P1's receive)
        p2.localEvent();
        System.out.println("P2 local: " + p2);    // VC2[0, 0, 1]

        // P2's event is concurrent with P1's last event
        System.out.println("P1 concurrent with P2? " + 
            p1.isConcurrentWith(p2.getClock()));    // true
    }
}
```

**Complexity:** O(n) for all operations where n = number of processes. Space: O(n) per clock, O(n * E) total if every event stores its clock.

**Scalability problem:** Vector clocks grow linearly with the number of processes. For systems with millions of clients, this is impractical. Solutions include **version vectors** (track only replicas, not clients) and **dotted version vectors** (Amazon's DynamoDB uses these).

**Real-world correlation:** **Amazon DynamoDB** uses vector clocks (via version vectors) for conflict detection. **Riak** used vector clocks before moving to dotted version vectors. **Lamport timestamps** (a scalar simplification) are used in **Google Spanner** via TrueTime.

### 13.4.4 Gossip Protocol: Epidemic Information Dissemination

Gossip protocols spread information through a cluster by having each node periodically communicate with a random subset of peers, like an epidemic. They are robust (no single point of failure), eventually consistent, and scale well.

```java
import java.util.*;

/**
 * Gossip protocol simulation.
 * Each node maintains a state map. Periodically, each node selects a random peer
 * and exchanges state. State propagates epidemically through the cluster.
 * 
 * Convergence time: O(log n) rounds for n nodes (like epidemic spreading).
 */
public class GossipProtocol {

    static class NodeState {
        final int nodeId;
        final Map<String, VersionedValue> state;  // key -> (value, version)
        final Random rng;
        int gossipRound = 0;

        NodeState(int nodeId) {
            this.nodeId = nodeId;
            this.state = new HashMap<>();
            this.rng = new Random(nodeId);
        }

        /** Update a local key. Increments version. */
        void updateLocal(String key, String value) {
            VersionedValue existing = state.get(key);
            int version = (existing == null) ? 1 : existing.version + 1;
            state.put(key, new VersionedValue(value, version, nodeId));
        }

        /**
         * Merge state from a peer. Keep higher-versioned values.
         * This is the core of anti-entropy gossip.
         * Returns number of values updated.
         */
        int merge(Map<String, VersionedValue> peerState) {
            int updated = 0;
            for (Map.Entry<String, VersionedValue> entry : peerState.entrySet()) {
                String key = entry.getKey();
                VersionedValue peerVal = entry.getValue();
                VersionedValue myVal = state.get(key);

                if (myVal == null || peerVal.version > myVal.version) {
                    state.put(key, peerVal);
                    updated++;
                }
            }
            return updated;
        }
    }

    static class VersionedValue {
        final String value;
        final int version;
        final int originNode;

        VersionedValue(String value, int version, int originNode) {
            this.value = value;
            this.version = version;
            this.originNode = originNode;
        }

        @Override
        public String toString() {
            return value + "(v" + version + " from N" + originNode + ")";
        }
    }

    private final List<NodeState> nodes;
    private final int fanout;  // number of peers to gossip with per round
    private final Random rng = new Random(42);
    private int totalRounds = 0;

    public GossipProtocol(int numNodes, int fanout) {
        this.fanout = fanout;
        this.nodes = new ArrayList<>();
        for (int i = 0; i < numNodes; i++) {
            nodes.add(new NodeState(i));
        }
    }

    /** Run one round of gossip: each node contacts 'fanout' random peers. */
    public int runRound() {
        int totalUpdates = 0;
        totalRounds++;

        for (NodeState node : nodes) {
            node.gossipRound = totalRounds;

            // Select 'fanout' random peers (excluding self)
            List<NodeState> peers = selectRandomPeers(node, fanout);

            for (NodeState peer : peers) {
                // Push-pull gossip: exchange state in both directions
                totalUpdates += peer.merge(node.state);
                totalUpdates += node.merge(peer.state);
            }
        }
        return totalUpdates;
    }

    /** Select random peers for gossiping. */
    private List<NodeState> selectRandomPeers(NodeState node, int count) {
        List<NodeState> candidates = new ArrayList<>(nodes);
        candidates.remove(node);
        Collections.shuffle(candidates, rng);
        return candidates.subList(0, Math.min(count, candidates.size()));
    }

    /** Simulate until convergence (all nodes have the same state). */
    public int converge() {
        int rounds = 0;
        while (!isConverged()) {
            runRound();
            rounds++;
            if (rounds > 1000) break;  // safety limit
        }
        return rounds;
    }

    /** Check if all nodes have identical state. */
    public boolean isConverged() {
        if (nodes.isEmpty()) return true;
        Map<String, VersionedValue> reference = nodes.get(0).state;
        for (int i = 1; i < nodes.size(); i++) {
            if (!statesEqual(reference, nodes.get(i).state)) return false;
        }
        return true;
    }

    private boolean statesEqual(Map<String, VersionedValue> a, Map<String, VersionedValue> b) {
        if (a.size() != b.size()) return false;
        for (Map.Entry<String, VersionedValue> entry : a.entrySet()) {
            VersionedValue bVal = b.get(entry.getKey());
            if (bVal == null || bVal.version != entry.getValue().version) return false;
        }
        return true;
    }

    /** Update a value on a specific node. */
    public void updateValue(int nodeId, String key, String value) {
        nodes.get(nodeId).updateLocal(key, value);
    }

    /** Read a value from a specific node. */
    public String readValue(int nodeId, String key) {
        VersionedValue vv = nodes.get(nodeId).state.get(key);
        return vv == null ? null : vv.value;
    }
}
```

**Convergence analysis:** With n nodes and fanout f, information reaches all nodes in O(log_f(n)) rounds. For 1000 nodes with fanout 3, convergence takes ~7 rounds. This is remarkably fast and the reason gossip protocols scale.

**Real-world correlation:** **Apache Cassandra** uses gossip for cluster membership and failure detection. **HashiCorp Serf** (used by Consul and Nomad) implements SWIM gossip. **Redis Cluster** uses gossip for node health. **Amazon S3** uses gossip for anti-entropy.

### 13.4.5 Merkle Tree: Hash Tree for Data Integrity

A Merkle tree is a binary tree where every leaf node contains a hash of a data block, and every internal node contains a hash of its children's hashes. This allows O(log n) detection of which blocks differ between two replicas -- without comparing all the data.

```java
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;

/**
 * Merkle tree for data integrity verification.
 * Used in: Git (object storage), Bitcoin (transaction verification),
 * Cassandra (anti-entropy repair), IPFS, ZFS (checksumming).
 */
public class MerkleTree {

    static class Node {
        byte[] hash;
        Node left, right;
        String data;  // only for leaf nodes

        Node(String data) {
            this.data = data;
            this.hash = computeHash(data);
        }

        Node(Node left, Node right) {
            this.left = left;
            this.right = right;
            // Internal node hash = hash(left.hash + right.hash)
            this.hash = computeHash(left.hash, right.hash);
        }
    }

    private Node root;
    private final List<String> dataBlocks;

    /** Build a Merkle tree from data blocks. O(n). */
    public MerkleTree(List<String> dataBlocks) {
        this.dataBlocks = new ArrayList<>(dataBlocks);
        this.root = buildTree(dataBlocks);
    }

    private Node buildTree(List<String> blocks) {
        if (blocks.isEmpty()) return null;

        // Create leaf nodes
        List<Node> nodes = new ArrayList<>();
        for (String block : blocks) {
            nodes.add(new Node(block));
        }

        // If odd number of leaves, duplicate the last one
        if (nodes.size() % 2 != 0) {
            nodes.add(new Node(blocks.get(blocks.size() - 1)));
        }

        // Build tree bottom-up
        while (nodes.size() > 1) {
            List<Node> parents = new ArrayList<>();
            for (int i = 0; i < nodes.size(); i += 2) {
                Node left = nodes.get(i);
                Node right = (i + 1 < nodes.size()) ? nodes.get(i + 1) : left;
                parents.add(new Node(left, right));
            }
            nodes = parents;
        }

        return nodes.get(0);
    }

    /** Get the root hash. O(1). */
    public byte[] getRootHash() {
        return root == null ? null : root.hash;
    }

    /**
     * Find which data blocks differ between this tree and another.
     * Compares trees top-down. If a subtree's hash matches, skip it entirely.
     * 
     * Time: O(d * log n) where d = number of differences, n = total blocks.
     * Best case (no differences): O(1) -- just compare root hashes.
     * Worst case (all different): O(n).
     */
    public List<Integer> findDifferences(MerkleTree other) {
        List<Integer> diffs = new ArrayList<>();
        findDiffsRecursive(this.root, other.root, 0, dataBlocks.size() - 1, diffs);
        return diffs;
    }

    private void findDiffsRecursive(Node a, Node b, int lo, int hi, List<Integer> diffs) {
        if (a == null && b == null) return;
        if (a == null || b == null) {
            // One tree has data, the other does not -- all blocks differ
            for (int i = lo; i <= hi; i++) diffs.add(i);
            return;
        }

        // If hashes match, entire subtree is identical -- skip
        if (Arrays.equals(a.hash, b.hash)) return;

        // Leaf node: this specific block differs
        if (a.left == null && a.right == null) {
            diffs.add(lo);
            return;
        }

        // Recurse into children
        int mid = lo + (hi - lo) / 2;
        findDiffsRecursive(a.left, b.left, lo, mid, diffs);
        findDiffsRecursive(a.right, b.right, mid + 1, hi, diffs);
    }

    /**
     * Generate a proof that a specific block is in the tree.
     * Returns the list of sibling hashes needed to reconstruct the root hash.
     * Verifier can check the proof without having the full tree.
     * 
     * Time: O(log n). Proof size: O(log n) hashes.
     */
    public List<byte[]> generateProof(int blockIndex) {
        List<byte[]> proof = new ArrayList<>();
        generateProofRecursive(root, 0, dataBlocks.size() - 1, blockIndex, proof);
        return proof;
    }

    private void generateProofRecursive(Node node, int lo, int hi, 
                                         int target, List<byte[]> proof) {
        if (lo == hi) return;

        int mid = lo + (hi - lo) / 2;
        if (target <= mid) {
            // Target is in left subtree; add right hash to proof
            if (node.right != null) proof.add(node.right.hash);
            generateProofRecursive(node.left, lo, mid, target, proof);
        } else {
            // Target is in right subtree; add left hash to proof
            if (node.left != null) proof.add(node.left.hash);
            generateProofRecursive(node.right, mid + 1, hi, target, proof);
        }
    }

    // ========================================================================
    // Hashing utilities
    // ========================================================================

    private static byte[] computeHash(String data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return md.digest(data.getBytes());
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }

    private static byte[] computeHash(byte[] left, byte[] right) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(left);
            md.update(right);
            return md.digest();
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }
}
```

**Real-world correlation:** **Git** is a Merkle tree of commits, trees, and blobs -- `git diff` between commits leverages the tree structure to identify only changed files. **Bitcoin** uses Merkle trees to efficiently verify that a transaction is in a block (SPV -- Simplified Payment Verification). **Apache Cassandra** uses Merkle trees during anti-entropy repair to identify which data ranges differ between replicas.

### 13.4.6 CRDT: Conflict-Free Replicated Data Types

CRDTs are data structures designed for replication without coordination. They guarantee eventual consistency by mathematical construction: concurrent updates always merge to the same result, regardless of order. The simplest CRDT is the G-Counter (grow-only counter).

```java
import java.util.Arrays;

/**
 * G-Counter: Grow-only counter CRDT.
 * Each replica maintains its own counter in an array.
 * Increment: increment your own entry.
 * Merge: element-wise max.
 * Value: sum of all entries.
 * 
 * Guarantees: merge is commutative, associative, and idempotent.
 * These properties ensure eventual consistency without coordination.
 */
public class GCounter {

    private final int[] counts;
    private final int replicaId;

    public GCounter(int replicaId, int numReplicas) {
        this.replicaId = replicaId;
        this.counts = new int[numReplicas];
    }

    /** Increment counter on this replica. O(1). */
    public void increment() {
        counts[replicaId]++;
    }

    public void incrementBy(int amount) {
        if (amount < 0) throw new IllegalArgumentException("G-Counter only grows");
        counts[replicaId] += amount;
    }

    /** Get the counter value (sum of all replicas). O(n). */
    public long value() {
        long sum = 0;
        for (int c : counts) sum += c;
        return sum;
    }

    /** Merge with another replica's state. O(n). */
    public void merge(GCounter other) {
        for (int i = 0; i < counts.length; i++) {
            counts[i] = Math.max(counts[i], other.counts[i]);
        }
    }

    /** Get state for transmission to another replica. */
    public int[] getState() {
        return counts.clone();
    }

    @Override
    public String toString() {
        return "GCounter(id=" + replicaId + ", counts=" + Arrays.toString(counts) + 
               ", value=" + value() + ")";
    }
}

/**
 * PN-Counter: Positive-Negative counter CRDT.
 * Supports both increment and decrement by using two G-Counters.
 * Value = P.value() - N.value()
 */
class PNCounter {

    private final GCounter positive;
    private final GCounter negative;
    private final int replicaId;

    public PNCounter(int replicaId, int numReplicas) {
        this.replicaId = replicaId;
        this.positive = new GCounter(replicaId, numReplicas);
        this.negative = new GCounter(replicaId, numReplicas);
    }

    public void increment() { positive.increment(); }
    public void decrement() { negative.increment(); }

    public long value() { return positive.value() - negative.value(); }

    public void merge(PNCounter other) {
        positive.merge(other.positive);
        negative.merge(other.negative);
    }
}

/**
 * G-Set: Grow-only set CRDT.
 * Elements can only be added, never removed.
 * Merge: union of sets.
 */
class GSet<E> {

    private final java.util.Set<E> elements = new java.util.HashSet<>();

    public void add(E element) { elements.add(element); }

    public boolean contains(E element) { return elements.contains(element); }

    public java.util.Set<E> value() { return java.util.Collections.unmodifiableSet(elements); }

    public void merge(GSet<E> other) { elements.addAll(other.elements); }

    public int size() { return elements.size(); }
}

/**
 * LWW-Register (Last-Writer-Wins Register) CRDT.
 * Each write is tagged with a timestamp. Merge keeps the higher timestamp.
 * Requires loosely synchronized clocks (or use Lamport timestamps).
 */
class LWWRegister<T> {

    private T value;
    private long timestamp;
    private final int replicaId;

    public LWWRegister(int replicaId) {
        this.replicaId = replicaId;
        this.timestamp = 0;
    }

    public void set(T value, long timestamp) {
        if (timestamp > this.timestamp) {
            this.value = value;
            this.timestamp = timestamp;
        }
    }

    public T get() { return value; }

    public void merge(LWWRegister<T> other) {
        if (other.timestamp > this.timestamp) {
            this.value = other.value;
            this.timestamp = other.timestamp;
        } else if (other.timestamp == this.timestamp) {
            // Tiebreak by replica ID (deterministic)
            if (other.replicaId > this.replicaId) {
                this.value = other.value;
            }
        }
    }
}
```

**Real-world correlation:** **Redis CRDT** (Redis Enterprise) uses CRDTs for active-active geo-replication. **Riak** was the pioneer of CRDTs in production databases. **Automerge** and **Yjs** use CRDTs for collaborative editing (Google-Docs-like). **Phoenix/Elixir** uses CRDTs in its PubSub layer.

### 13.4.7 Distributed Hash Table (Chord): Finger Table

Chord is a peer-to-peer lookup protocol. Each node maintains a "finger table" -- an array where entry i points to the node responsible for key (n + 2^i) mod 2^m. This gives O(log n) lookup by halving the remaining distance with each hop.

```java
import java.util.*;

/**
 * Simplified Chord DHT implementation.
 * Each node has an ID in [0, 2^m - 1] and maintains a finger table
 * with m entries. Entry i points to the successor of (nodeId + 2^i).
 * 
 * Lookup: O(log n) hops where n = number of nodes.
 */
public class ChordNode {

    private final int nodeId;
    private final int m;           // number of bits in identifier space
    private final int ringSize;    // 2^m
    private final int[] fingerTable;
    private int predecessor;
    private final Map<Integer, String> data;  // locally stored key-value pairs

    // Reference to all nodes (in a real system, this would be network calls)
    private Map<Integer, ChordNode> allNodes;

    public ChordNode(int nodeId, int m) {
        this.nodeId = nodeId;
        this.m = m;
        this.ringSize = 1 << m;
        this.fingerTable = new int[m];
        this.data = new HashMap<>();
    }

    public void setNetwork(Map<Integer, ChordNode> allNodes) {
        this.allNodes = allNodes;
    }

    /** Initialize finger table. Entry i = successor(nodeId + 2^i). */
    public void initFingerTable(List<Integer> sortedNodeIds) {
        for (int i = 0; i < m; i++) {
            int start = (nodeId + (1 << i)) % ringSize;
            fingerTable[i] = findSuccessorInList(start, sortedNodeIds);
        }
        // Set predecessor
        int idx = Collections.binarySearch(sortedNodeIds, nodeId);
        predecessor = sortedNodeIds.get((idx - 1 + sortedNodeIds.size()) % sortedNodeIds.size());
    }

    private int findSuccessorInList(int id, List<Integer> sortedIds) {
        for (int nodeId : sortedIds) {
            if (inRange(id, nodeId, sortedIds)) return nodeId;
        }
        return sortedIds.get(0);  // wrap around
    }

    private boolean inRange(int target, int candidate, List<Integer> sortedIds) {
        // Is candidate the successor of target on the ring?
        int idx = Collections.binarySearch(sortedIds, candidate);
        int prevIdx = (idx - 1 + sortedIds.size()) % sortedIds.size();
        int prevNode = sortedIds.get(prevIdx);

        if (prevNode < candidate) {
            return target > prevNode && target <= candidate;
        } else {
            // Wraps around
            return target > prevNode || target <= candidate;
        }
    }

    /**
     * Lookup: find the node responsible for a key.
     * Uses finger table for O(log n) hops.
     */
    public int lookup(int key) {
        key = key % ringSize;

        // Am I responsible for this key?
        if (isResponsible(key)) return nodeId;

        // Find the closest preceding node in finger table
        for (int i = m - 1; i >= 0; i--) {
            int finger = fingerTable[i];
            if (isBetween(finger, nodeId, key)) {
                // Forward to this finger
                return allNodes.get(finger).lookup(key);
            }
        }

        // Forward to successor
        return allNodes.get(fingerTable[0]).lookup(key);
    }

    private boolean isResponsible(int key) {
        if (predecessor < nodeId) {
            return key > predecessor && key <= nodeId;
        } else {
            return key > predecessor || key <= nodeId;
        }
    }

    private boolean isBetween(int id, int from, int to) {
        if (from < to) return id > from && id < to;
        return id > from || id < to;
    }

    /** Store a key-value pair. */
    public void store(int key, String value) {
        int responsible = lookup(key);
        allNodes.get(responsible).data.put(key, value);
    }

    /** Retrieve a value by key. */
    public String retrieve(int key) {
        int responsible = lookup(key);
        return allNodes.get(responsible).data.get(key);
    }

    public int getNodeId() { return nodeId; }
    public int[] getFingerTable() { return fingerTable.clone(); }
}
```

**Real-world correlation:** **BitTorrent DHT** uses a Chord-like protocol (Kademlia) for peer discovery. **IPFS** uses Kademlia for content routing. **Amazon DynamoDB** internal routing uses similar finger-table concepts.

---

## 13.5 Message Queues and Infrastructure Patterns

Message queues are the connective tissue of microservice architectures. Every queue, topic, and subscriber model maps to specific data structures. Understanding these internals helps you make better architectural decisions and debug production issues.

### 13.5.1 Bounded Buffer: Producer-Consumer with ArrayBlockingQueue

The bounded buffer is the fundamental producer-consumer pattern. Producers add items; consumers remove them. When the buffer is full, producers block. When empty, consumers block. Java's `ArrayBlockingQueue` implements this with a circular array and two conditions (notFull, notEmpty) on a single lock.

```java
import java.util.concurrent.locks.*;

/**
 * Hand-rolled bounded buffer to show the internals.
 * This is what ArrayBlockingQueue does under the hood (simplified).
 * 
 * In OpenJDK's ArrayBlockingQueue:
 * - Single ReentrantLock (not separate producer/consumer locks)
 * - Two Condition variables: notEmpty, notFull
 * - Circular array with putIndex and takeIndex
 */
public class BoundedBuffer<E> {

    private final Object[] items;
    private int putIndex;
    private int takeIndex;
    private int count;

    private final ReentrantLock lock = new ReentrantLock();
    private final Condition notFull = lock.newCondition();
    private final Condition notEmpty = lock.newCondition();

    public BoundedBuffer(int capacity) {
        this.items = new Object[capacity];
    }

    /** Producer: add item, block if full. */
    public void put(E item) throws InterruptedException {
        lock.lock();
        try {
            while (count == items.length) {
                notFull.await();  // releases lock, waits, reacquires lock
            }
            items[putIndex] = item;
            putIndex = (putIndex + 1) % items.length;  // circular
            count++;
            notEmpty.signal();  // wake one waiting consumer
        } finally {
            lock.unlock();
        }
    }

    /** Consumer: take item, block if empty. */
    @SuppressWarnings("unchecked")
    public E take() throws InterruptedException {
        lock.lock();
        try {
            while (count == 0) {
                notEmpty.await();
            }
            E item = (E) items[takeIndex];
            items[takeIndex] = null;  // help GC
            takeIndex = (takeIndex + 1) % items.length;  // circular
            count--;
            notFull.signal();  // wake one waiting producer
            return item;
        } finally {
            lock.unlock();
        }
    }

    public int size() {
        lock.lock();
        try { return count; } finally { lock.unlock(); }
    }
}
```

**JVM insight:** The `ReentrantLock` + `Condition` pattern compiles to `park`/`unpark` calls in `java.util.concurrent.locks.LockSupport`, which map to `futex` on Linux. A parked thread is removed from the CPU scheduler's run queue entirely -- it consumes zero CPU until signaled. This is fundamentally different from a spin-wait loop.

**Real-world correlation:** **LMAX Disruptor** replaces this pattern with a lock-free ring buffer using CAS operations on sequence numbers, achieving ~100M messages/second. **Kafka** partitions are bounded buffers at the OS level (memory-mapped files with configurable retention).

### 13.5.2 Topic-Based Message Queue with Fan-Out

A message queue with topics allows publishers to send messages to named topics, and subscribers to receive messages from topics they have subscribed to. This is the pub/sub pattern.

```java
import java.util.*;
import java.util.concurrent.*;

/**
 * In-memory message queue with topics, consumer groups, and dead letter queue.
 * Models the Kafka/RabbitMQ pattern using JDK data structures.
 */
public class MessageBroker {

    static class Message {
        final String id;
        final String topic;
        final String payload;
        final long timestamp;
        final Map<String, String> headers;
        int deliveryAttempts;

        Message(String topic, String payload) {
            this.id = UUID.randomUUID().toString();
            this.topic = topic;
            this.payload = payload;
            this.timestamp = System.currentTimeMillis();
            this.headers = new HashMap<>();
            this.deliveryAttempts = 0;
        }
    }

    /** A topic is an append-only log of messages (like Kafka). */
    static class Topic {
        final String name;
        final List<Message> log = new ArrayList<>();  // append-only log
        final Map<String, Integer> consumerOffsets = new ConcurrentHashMap<>();
        // offset per consumer group

        Topic(String name) { this.name = name; }

        /** Publish: append to log. O(1) amortized. */
        void publish(Message msg) {
            log.add(msg);
        }

        /** Consume: read from offset for a consumer group. */
        List<Message> consume(String consumerGroup, int batchSize) {
            int offset = consumerOffsets.getOrDefault(consumerGroup, 0);
            int end = Math.min(offset + batchSize, log.size());
            if (offset >= end) return Collections.emptyList();

            List<Message> batch = log.subList(offset, end);
            // Note: offset is committed after processing (at-least-once semantics)
            return new ArrayList<>(batch);
        }

        /** Commit offset after successful processing. */
        void commitOffset(String consumerGroup, int newOffset) {
            consumerOffsets.put(consumerGroup, newOffset);
        }

        int getOffset(String consumerGroup) {
            return consumerOffsets.getOrDefault(consumerGroup, 0);
        }
    }

    private final Map<String, Topic> topics = new ConcurrentHashMap<>();
    private final Map<String, Set<String>> subscriptions = new ConcurrentHashMap<>();
    // consumerGroup -> set of topics
    private final Topic deadLetterQueue;
    private final int maxDeliveryAttempts;

    public MessageBroker(int maxDeliveryAttempts) {
        this.maxDeliveryAttempts = maxDeliveryAttempts;
        this.deadLetterQueue = new Topic("__dead_letter");
    }

    /** Create a topic. */
    public void createTopic(String topicName) {
        topics.putIfAbsent(topicName, new Topic(topicName));
    }

    /** Subscribe a consumer group to a topic. */
    public void subscribe(String consumerGroup, String topicName) {
        subscriptions.computeIfAbsent(consumerGroup, k -> ConcurrentHashMap.newKeySet())
                     .add(topicName);
    }

    /** Publish a message to a topic. O(1) amortized. */
    public void publish(String topicName, String payload) {
        Topic topic = topics.get(topicName);
        if (topic == null) throw new IllegalArgumentException("Topic not found: " + topicName);
        topic.publish(new Message(topicName, payload));
    }

    /** Consume messages for a consumer group from a subscribed topic. */
    public List<Message> consume(String consumerGroup, String topicName, int batchSize) {
        Topic topic = topics.get(topicName);
        if (topic == null) return Collections.emptyList();
        return topic.consume(consumerGroup, batchSize);
    }

    /** Acknowledge successful processing -- advance offset. */
    public void ack(String consumerGroup, String topicName, int processedCount) {
        Topic topic = topics.get(topicName);
        if (topic == null) return;
        int current = topic.getOffset(consumerGroup);
        topic.commitOffset(consumerGroup, current + processedCount);
    }

    /** Send a message to the dead letter queue after max retries. */
    public void sendToDeadLetter(Message msg) {
        msg.deliveryAttempts++;
        if (msg.deliveryAttempts >= maxDeliveryAttempts) {
            msg.headers.put("dlq-reason", "max-retries-exceeded");
            msg.headers.put("original-topic", msg.topic);
            deadLetterQueue.publish(msg);
        }
    }

    /** Get dead letter queue messages for inspection. */
    public List<Message> getDeadLetters(int count) {
        return deadLetterQueue.consume("dlq-inspector", count);
    }
}
```

**Real-world correlation:** **Apache Kafka** models topics as append-only logs with consumer offsets exactly as shown above. Each Kafka partition is independently ordered. **Amazon SQS** uses a similar DLQ (Dead Letter Queue) model. **RabbitMQ** uses exchange/queue/binding routing which maps to `HashMap<Exchange, List<Queue>>`.

### 13.5.3 Service Registry with Health Checks

Service discovery is how microservices find each other. A registry maintains a map of service names to healthy instances, with heartbeat-based health checking.

```java
import java.util.*;
import java.util.concurrent.*;

/**
 * Service registry with heartbeat-based health checking.
 * Models the Consul/Eureka/etcd pattern.
 */
public class ServiceRegistry {

    static class ServiceInstance {
        final String serviceId;
        final String serviceName;
        final String host;
        final int port;
        volatile long lastHeartbeat;
        volatile boolean healthy;
        final Map<String, String> metadata;

        ServiceInstance(String serviceName, String host, int port) {
            this.serviceId = serviceName + "-" + host + ":" + port;
            this.serviceName = serviceName;
            this.host = host;
            this.port = port;
            this.lastHeartbeat = System.currentTimeMillis();
            this.healthy = true;
            this.metadata = new ConcurrentHashMap<>();
        }

        void heartbeat() {
            this.lastHeartbeat = System.currentTimeMillis();
            this.healthy = true;
        }
    }

    // Service name -> list of instances
    private final ConcurrentHashMap<String, CopyOnWriteArrayList<ServiceInstance>> registry 
        = new ConcurrentHashMap<>();

    // All instances indexed by serviceId for O(1) heartbeat lookup
    private final ConcurrentHashMap<String, ServiceInstance> instanceIndex 
        = new ConcurrentHashMap<>();

    // Health check: priority queue ordered by last heartbeat (oldest first)
    private final PriorityQueue<ServiceInstance> healthCheckQueue
        = new PriorityQueue<>(Comparator.comparingLong(si -> si.lastHeartbeat));

    private final long heartbeatTimeoutMs;
    private final Random loadBalancerRng = new Random();

    public ServiceRegistry(long heartbeatTimeoutMs) {
        this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    }

    /** Register a new service instance. */
    public synchronized ServiceInstance register(String serviceName, String host, int port) {
        ServiceInstance instance = new ServiceInstance(serviceName, host, port);
        registry.computeIfAbsent(serviceName, k -> new CopyOnWriteArrayList<>())
                .add(instance);
        instanceIndex.put(instance.serviceId, instance);
        healthCheckQueue.offer(instance);
        return instance;
    }

    /** Deregister an instance. */
    public synchronized void deregister(String serviceId) {
        ServiceInstance instance = instanceIndex.remove(serviceId);
        if (instance != null) {
            CopyOnWriteArrayList<ServiceInstance> instances = registry.get(instance.serviceName);
            if (instances != null) {
                instances.remove(instance);
            }
            healthCheckQueue.remove(instance);
        }
    }

    /** Process a heartbeat from an instance. O(1) for lookup + O(log n) for requeue. */
    public synchronized void heartbeat(String serviceId) {
        ServiceInstance instance = instanceIndex.get(serviceId);
        if (instance != null) {
            healthCheckQueue.remove(instance);  // O(n) in PQ -- see note below
            instance.heartbeat();
            healthCheckQueue.offer(instance);   // O(log n)
        }
    }

    /**
     * Run health check: mark instances with expired heartbeats as unhealthy.
     * O(k * log n) where k = number of expired instances.
     */
    public synchronized List<ServiceInstance> checkHealth() {
        List<ServiceInstance> unhealthy = new ArrayList<>();
        long now = System.currentTimeMillis();

        while (!healthCheckQueue.isEmpty()) {
            ServiceInstance oldest = healthCheckQueue.peek();
            if (now - oldest.lastHeartbeat > heartbeatTimeoutMs) {
                healthCheckQueue.poll();
                oldest.healthy = false;
                unhealthy.add(oldest);
            } else {
                break;  // remaining instances have newer heartbeats
            }
        }
        return unhealthy;
    }

    /**
     * Discover healthy instances of a service.
     * Used by clients for load balancing.
     */
    public List<ServiceInstance> discover(String serviceName) {
        CopyOnWriteArrayList<ServiceInstance> instances = registry.get(serviceName);
        if (instances == null) return Collections.emptyList();

        List<ServiceInstance> healthy = new ArrayList<>();
        for (ServiceInstance inst : instances) {
            if (inst.healthy) healthy.add(inst);
        }
        return healthy;
    }

    /** Client-side load balancing: random selection among healthy instances. */
    public ServiceInstance loadBalance(String serviceName) {
        List<ServiceInstance> healthy = discover(serviceName);
        if (healthy.isEmpty()) return null;
        return healthy.get(loadBalancerRng.nextInt(healthy.size()));
    }

    /** Round-robin load balancing using an atomic counter. */
    private final ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicInteger> rrCounters
        = new ConcurrentHashMap<>();

    public ServiceInstance loadBalanceRoundRobin(String serviceName) {
        List<ServiceInstance> healthy = discover(serviceName);
        if (healthy.isEmpty()) return null;
        java.util.concurrent.atomic.AtomicInteger counter = 
            rrCounters.computeIfAbsent(serviceName, 
                k -> new java.util.concurrent.atomic.AtomicInteger(0));
        int idx = Math.abs(counter.getAndIncrement() % healthy.size());
        return healthy.get(idx);
    }
}
```

**Design note:** The `PriorityQueue.remove(Object)` is O(n). In a production registry with thousands of instances receiving heartbeats every second, you would use a more efficient approach: a timer wheel (Kafka's `TimingWheel`) or simply a scheduled sweep rather than per-heartbeat queue updates.

**Real-world correlation:** **Netflix Eureka** maintains an in-memory registry with heartbeat-based eviction (default 90s timeout). **HashiCorp Consul** uses gossip-based health checking. **Kubernetes** uses etcd (Raft-based) for service endpoint storage.

---

## 13.6 Resilience Patterns

Production systems need patterns that handle failure gracefully. Circuit breakers, rate limiters, and distributed locks are all data structure problems at their core.

### 13.6.1 Circuit Breaker

The circuit breaker pattern prevents cascading failures by tracking failure rates and "tripping" to stop sending requests to a failing service. It uses a state machine (CLOSED -> OPEN -> HALF_OPEN) with a sliding window of recent results.

```java
import java.util.concurrent.atomic.*;

/**
 * Circuit breaker implementation using a ring buffer (circular array)
 * for sliding window failure tracking.
 * 
 * Models: Resilience4j CircuitBreaker, Netflix Hystrix (deprecated).
 */
public class CircuitBreaker {

    enum State { CLOSED, OPEN, HALF_OPEN }

    private final String name;
    private volatile State state = State.CLOSED;

    // Sliding window: ring buffer of recent call results
    private final boolean[] window;      // true = success, false = failure
    private final AtomicInteger windowIndex = new AtomicInteger(0);
    private final int windowSize;

    // Configuration
    private final double failureThreshold;  // e.g., 0.5 = 50% failure rate
    private final long openDurationMs;      // how long to stay OPEN
    private final int halfOpenPermits;      // calls to allow in HALF_OPEN

    // State tracking
    private volatile long openedAt;
    private final AtomicInteger halfOpenCallCount = new AtomicInteger(0);
    private final AtomicInteger halfOpenSuccessCount = new AtomicInteger(0);
    private final AtomicInteger totalFailures = new AtomicInteger(0);
    private final AtomicInteger totalCalls = new AtomicInteger(0);

    public CircuitBreaker(String name, int windowSize, double failureThreshold,
                          long openDurationMs, int halfOpenPermits) {
        this.name = name;
        this.windowSize = windowSize;
        this.window = new boolean[windowSize];
        java.util.Arrays.fill(window, true);  // start with all "success"
        this.failureThreshold = failureThreshold;
        this.openDurationMs = openDurationMs;
        this.halfOpenPermits = halfOpenPermits;
    }

    /** Check if a call should be allowed. */
    public boolean allowCall() {
        switch (state) {
            case CLOSED:
                return true;
            case OPEN:
                // Check if enough time has passed to transition to HALF_OPEN
                if (System.currentTimeMillis() - openedAt >= openDurationMs) {
                    state = State.HALF_OPEN;
                    halfOpenCallCount.set(0);
                    halfOpenSuccessCount.set(0);
                    return true;
                }
                return false;
            case HALF_OPEN:
                return halfOpenCallCount.get() < halfOpenPermits;
            default:
                return false;
        }
    }

    /** Record a successful call. */
    public void recordSuccess() {
        totalCalls.incrementAndGet();
        int idx = windowIndex.getAndUpdate(i -> (i + 1) % windowSize);
        window[idx] = true;

        if (state == State.HALF_OPEN) {
            halfOpenCallCount.incrementAndGet();
            int successes = halfOpenSuccessCount.incrementAndGet();
            if (successes >= halfOpenPermits) {
                // Enough successes in HALF_OPEN: close the circuit
                state = State.CLOSED;
                totalFailures.set(0);
            }
        }
    }

    /** Record a failed call. */
    public void recordFailure() {
        totalCalls.incrementAndGet();
        totalFailures.incrementAndGet();
        int idx = windowIndex.getAndUpdate(i -> (i + 1) % windowSize);
        window[idx] = false;

        if (state == State.HALF_OPEN) {
            halfOpenCallCount.incrementAndGet();
            // Any failure in HALF_OPEN: reopen
            state = State.OPEN;
            openedAt = System.currentTimeMillis();
            return;
        }

        // Check failure rate in CLOSED state
        if (state == State.CLOSED) {
            double failureRate = calculateFailureRate();
            if (failureRate >= failureThreshold) {
                state = State.OPEN;
                openedAt = System.currentTimeMillis();
            }
        }
    }

    /** Calculate failure rate from the sliding window. */
    private double calculateFailureRate() {
        int failures = 0;
        for (boolean success : window) {
            if (!success) failures++;
        }
        return (double) failures / windowSize;
    }

    public State getState() { return state; }
    public String getName() { return name; }
}
```

### 13.6.2 Rate Limiter: Token Bucket and Sliding Window

```java
import java.util.concurrent.atomic.AtomicLong;
import java.util.ArrayDeque;

/**
 * Token bucket rate limiter.
 * Tokens are added at a fixed rate. Each request consumes one token.
 * If no tokens are available, the request is rejected.
 * 
 * This is the algorithm used by Linux traffic control (tc), Nginx,
 * and most API gateways.
 */
public class TokenBucketRateLimiter {

    private final long capacity;         // max tokens
    private final double refillRate;     // tokens per millisecond
    private double tokens;
    private long lastRefillTime;

    public TokenBucketRateLimiter(long capacity, double tokensPerSecond) {
        this.capacity = capacity;
        this.refillRate = tokensPerSecond / 1000.0;
        this.tokens = capacity;
        this.lastRefillTime = System.currentTimeMillis();
    }

    /** Try to consume one token. Returns true if allowed. */
    public synchronized boolean tryAcquire() {
        refill();
        if (tokens >= 1.0) {
            tokens -= 1.0;
            return true;
        }
        return false;
    }

    /** Try to consume n tokens (for weighted rate limiting). */
    public synchronized boolean tryAcquire(int n) {
        refill();
        if (tokens >= n) {
            tokens -= n;
            return true;
        }
        return false;
    }

    private void refill() {
        long now = System.currentTimeMillis();
        double elapsed = now - lastRefillTime;
        tokens = Math.min(capacity, tokens + elapsed * refillRate);
        lastRefillTime = now;
    }
}

/**
 * Sliding window log rate limiter.
 * Maintains a log of request timestamps. Count requests in the window.
 * More precise than token bucket but uses more memory.
 */
class SlidingWindowLogRateLimiter {

    private final int maxRequests;
    private final long windowMs;
    private final ArrayDeque<Long> requestLog = new ArrayDeque<>();

    public SlidingWindowLogRateLimiter(int maxRequests, long windowMs) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
    }

    /** Try to make a request. O(k) where k = expired entries removed. */
    public synchronized boolean tryAcquire() {
        long now = System.currentTimeMillis();
        long windowStart = now - windowMs;

        // Remove expired entries from the front of the deque
        while (!requestLog.isEmpty() && requestLog.peekFirst() <= windowStart) {
            requestLog.pollFirst();
        }

        if (requestLog.size() < maxRequests) {
            requestLog.offerLast(now);
            return true;
        }
        return false;
    }
}
```

### 13.6.3 Distributed Lock

```java
import java.util.*;
import java.util.concurrent.*;

/**
 * Distributed lock simulation using a central coordinator.
 * Models the Redis RedLock / ZooKeeper / etcd lock pattern.
 * 
 * Real implementations use TTL (time-to-live) to handle holder crashes,
 * and fencing tokens to handle split-brain scenarios.
 */
public class DistributedLock {

    static class LockEntry {
        final String lockId;
        final String holder;
        final long acquiredAt;
        final long ttlMs;
        final long fencingToken;  // monotonically increasing token

        LockEntry(String lockId, String holder, long ttlMs, long fencingToken) {
            this.lockId = lockId;
            this.holder = holder;
            this.acquiredAt = System.currentTimeMillis();
            this.ttlMs = ttlMs;
            this.fencingToken = fencingToken;
        }

        boolean isExpired() {
            return System.currentTimeMillis() - acquiredAt > ttlMs;
        }
    }

    private final ConcurrentHashMap<String, LockEntry> locks = new ConcurrentHashMap<>();
    private final java.util.concurrent.atomic.AtomicLong tokenGenerator 
        = new java.util.concurrent.atomic.AtomicLong(0);

    /**
     * Try to acquire a lock. Returns a fencing token on success, or -1 on failure.
     * 
     * Fencing tokens prevent the "zombie lock" problem:
     * If client A acquires lock, pauses (GC!), lock expires, client B acquires lock,
     * then client A resumes -- it has a stale fencing token that the resource can reject.
     */
    public long tryLock(String lockId, String holder, long ttlMs) {
        LockEntry existing = locks.get(lockId);

        // Check if existing lock is expired
        if (existing != null && !existing.isExpired()) {
            if (existing.holder.equals(holder)) {
                // Re-entrant: extend TTL
                long token = tokenGenerator.incrementAndGet();
                locks.put(lockId, new LockEntry(lockId, holder, ttlMs, token));
                return token;
            }
            return -1;  // lock held by someone else
        }

        // Try to acquire
        long token = tokenGenerator.incrementAndGet();
        LockEntry newEntry = new LockEntry(lockId, holder, ttlMs, token);

        // CAS to handle race conditions
        LockEntry previous = locks.putIfAbsent(lockId, newEntry);
        if (previous == null || previous.isExpired()) {
            locks.put(lockId, newEntry);
            return token;
        }
        return -1;
    }

    /** Release a lock. Only the holder can release. */
    public boolean unlock(String lockId, String holder) {
        LockEntry entry = locks.get(lockId);
        if (entry != null && entry.holder.equals(holder)) {
            locks.remove(lockId);
            return true;
        }
        return false;
    }

    /** Check if a lock is held (and not expired). */
    public boolean isLocked(String lockId) {
        LockEntry entry = locks.get(lockId);
        return entry != null && !entry.isExpired();
    }

    /** Get the current fencing token for a lock. */
    public long getFencingToken(String lockId) {
        LockEntry entry = locks.get(lockId);
        return (entry != null && !entry.isExpired()) ? entry.fencingToken : -1;
    }
}
```

**The GC problem with distributed locks:** This is why fencing tokens matter. A long GC pause (say, a Full GC on a large heap) can cause the JVM to freeze for seconds. During that freeze, the lock's TTL expires, another process acquires the lock, and when the first process resumes, it believes it still holds the lock. The fencing token is a monotonically increasing value -- the resource (database, file, etc.) rejects any operation with a stale token.

---

## 13.7 Problems

### Easy (14 problems)

---

**P13.1 [E] Implement a Basic FIFO Scheduler**

Implement a FIFO (First-Come-First-Served) scheduler. Processes are executed in arrival order. Return the average waiting time.

```java
public class P13_01_FIFOScheduler {

    public static double averageWaitingTime(int[] burstTimes) {
        int n = burstTimes.length;
        int totalWait = 0;
        int currentTime = 0;

        for (int i = 0; i < n; i++) {
            totalWait += currentTime;  // waiting time = current time (all arrive at 0)
            currentTime += burstTimes[i];
        }
        return (double) totalWait / n;
    }
}
```
**Time:** O(n). **Space:** O(1).
**JVM insight:** A pure array traversal with no allocations -- this fits entirely in L1 cache for reasonable process counts.
**Real-world:** FIFO is used for batch processing queues. **AWS Batch** processes jobs in FIFO order within a job queue.

---

**P13.2 [E] Implement a Simple Free List Allocator**

Implement a free list memory allocator with first-fit strategy.

```java
public class P13_02_FreeListAllocator {

    static class Block {
        int start;
        int size;
        Block next;
        Block(int start, int size) { this.start = start; this.size = size; }
    }

    Block freeList;

    public P13_02_FreeListAllocator(int totalMemory) {
        freeList = new Block(0, totalMemory);
    }

    /** First-fit allocation. O(n) where n = number of free blocks. */
    public int allocate(int size) {
        Block prev = null;
        Block curr = freeList;

        while (curr != null) {
            if (curr.size >= size) {
                int addr = curr.start;
                if (curr.size == size) {
                    // Exact fit: remove block
                    if (prev == null) freeList = curr.next;
                    else prev.next = curr.next;
                } else {
                    // Split block
                    curr.start += size;
                    curr.size -= size;
                }
                return addr;
            }
            prev = curr;
            curr = curr.next;
        }
        return -1;  // out of memory
    }

    /** Free a block (simplified: no coalescing). */
    public void free(int start, int size) {
        Block block = new Block(start, size);
        block.next = freeList;
        freeList = block;
    }
}
```
**Time:** O(n) for allocate, O(1) for free. **Space:** O(n) free blocks.
**Real-world:** **glibc malloc** uses a free list (bins) for small allocations. Best-fit reduces fragmentation but costs more to search.

---

**P13.3 [E] Simulate FIFO Page Replacement**

Given a page reference string and frame count, simulate FIFO page replacement and return the number of page faults.

```java
public class P13_03_FIFOPageReplacement {

    public static int pageFaults(int[] pages, int frames) {
        Set<Integer> frameSet = new HashSet<>();
        Queue<Integer> queue = new LinkedList<>();
        int faults = 0;

        for (int page : pages) {
            if (!frameSet.contains(page)) {
                faults++;
                if (frameSet.size() == frames) {
                    int evicted = queue.poll();
                    frameSet.remove(evicted);
                }
                frameSet.add(page);
                queue.offer(page);
            }
        }
        return faults;
    }
}
```
**Time:** O(P) where P = number of page references. **Space:** O(F) where F = number of frames.
**Real-world:** FIFO suffers from **Belady's anomaly** -- more frames can mean more faults. This is why real OS kernels use LRU approximations instead.

---

**P13.4 [E] Implement a Simple Vector Clock**

Implement vector clock send and receive operations for a 3-process system.

```java
public class P13_04_SimpleVectorClock {

    public static int[] send(int[] clock, int processId) {
        int[] result = clock.clone();
        result[processId]++;
        return result;
    }

    public static int[] receive(int[] myClock, int[] received, int processId) {
        int[] result = new int[myClock.length];
        for (int i = 0; i < result.length; i++) {
            result[i] = Math.max(myClock[i], received[i]);
        }
        result[processId]++;
        return result;
    }

    public static boolean happensBefore(int[] a, int[] b) {
        boolean strictlyLess = false;
        for (int i = 0; i < a.length; i++) {
            if (a[i] > b[i]) return false;
            if (a[i] < b[i]) strictlyLess = true;
        }
        return strictlyLess;
    }
}
```
**Time:** O(n) per operation where n = number of processes. **Space:** O(n) per clock.

---

**P13.5 [E] Implement a G-Counter CRDT**

Implement a grow-only distributed counter with increment, value, and merge operations.

```java
public class P13_05_GCounter {

    private final int[] counts;
    private final int replicaId;

    public P13_05_GCounter(int replicaId, int numReplicas) {
        this.replicaId = replicaId;
        this.counts = new int[numReplicas];
    }

    public void increment() { counts[replicaId]++; }

    public long value() {
        long sum = 0;
        for (int c : counts) sum += c;
        return sum;
    }

    public void merge(P13_05_GCounter other) {
        for (int i = 0; i < counts.length; i++) {
            counts[i] = Math.max(counts[i], other.counts[i]);
        }
    }
}
```
**Time:** O(n) for value and merge, O(1) for increment. **Space:** O(n).
**Real-world:** **Redis CRDT** uses this exact pattern for cross-datacenter counter replication.

---

**P13.6 [E] Implement Producer-Consumer with Bounded Buffer**

Use `ArrayBlockingQueue` to implement a simple producer-consumer.

```java
import java.util.concurrent.*;

public class P13_06_ProducerConsumer {

    public static void runSimulation(int bufferSize, int numItems) throws InterruptedException {
        BlockingQueue<Integer> buffer = new ArrayBlockingQueue<>(bufferSize);
        
        Thread producer = new Thread(() -> {
            for (int i = 0; i < numItems; i++) {
                try {
                    buffer.put(i);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        });

        Thread consumer = new Thread(() -> {
            for (int i = 0; i < numItems; i++) {
                try {
                    int item = buffer.take();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        });

        producer.start();
        consumer.start();
        producer.join();
        consumer.join();
    }
}
```
**Time:** O(n) total work, O(1) per put/take. **Space:** O(bufferSize).
**JVM insight:** `ArrayBlockingQueue` uses a single `ReentrantLock` with two `Condition` objects. The `put` call parks the thread on the `notFull` condition when the buffer is full.

---

**P13.7 [E] Implement a BitSet-Based Free Block Tracker**

Track free and allocated disk blocks using a `BitSet`.

```java
import java.util.BitSet;

public class P13_07_FreeBlockTracker {

    private final BitSet blocks;
    private final int total;

    public P13_07_FreeBlockTracker(int totalBlocks) {
        this.total = totalBlocks;
        this.blocks = new BitSet(totalBlocks);
        this.blocks.set(0, totalBlocks);  // all free
    }

    public int allocate() {
        int block = blocks.nextSetBit(0);
        if (block >= 0 && block < total) {
            blocks.clear(block);
            return block;
        }
        return -1;
    }

    public void free(int block) { blocks.set(block); }

    public int freeCount() { return blocks.cardinality(); }
}
```
**Time:** O(n/64) for allocate (scanning longs), O(1) for free. **Space:** O(n/8) bytes.

---

**P13.8 [E] Topic Subscriber Fan-Out**

Implement a simple pub/sub with topic-based fan-out.

```java
import java.util.*;

public class P13_08_PubSubFanOut {

    private final Map<String, List<String>> subscriptions = new HashMap<>();
    private final Map<String, Queue<String>> mailboxes = new HashMap<>();

    public void subscribe(String subscriber, String topic) {
        subscriptions.computeIfAbsent(topic, k -> new ArrayList<>()).add(subscriber);
        mailboxes.putIfAbsent(subscriber, new LinkedList<>());
    }

    public void publish(String topic, String message) {
        List<String> subs = subscriptions.getOrDefault(topic, Collections.emptyList());
        for (String sub : subs) {
            mailboxes.get(sub).offer(message);
        }
    }

    public String consume(String subscriber) {
        Queue<String> q = mailboxes.get(subscriber);
        return (q != null) ? q.poll() : null;
    }
}
```
**Time:** O(S) per publish where S = subscriber count for the topic. **Space:** O(T * S + M) where M = total messages.
**Real-world:** **RabbitMQ fanout exchange** delivers messages to all bound queues. **Redis Pub/Sub** follows this exact pattern.

---

**P13.9 [E] Implement Lamport Timestamps**

Implement scalar Lamport timestamps (simplified version of vector clocks).

```java
public class P13_09_LamportClock {

    private int clock = 0;

    public int localEvent() { return ++clock; }

    public int send() { return ++clock; }

    public int receive(int receivedTimestamp) {
        clock = Math.max(clock, receivedTimestamp) + 1;
        return clock;
    }

    public int getTime() { return clock; }
}
```
**Time:** O(1) all operations. **Space:** O(1).
**Limitation:** Lamport timestamps give you "if a -> b, then L(a) < L(b)" but NOT the converse. You cannot determine causality from timestamps alone. That is why vector clocks are needed.

---

**P13.10 [E] Shortest Job First Scheduler**

Implement SJF (non-preemptive) scheduling using a priority queue.

```java
import java.util.*;

public class P13_10_SJFScheduler {

    public static double averageWaitingTime(int[][] jobs) {
        // jobs[i] = {arrivalTime, burstTime}
        Arrays.sort(jobs, Comparator.comparingInt(a -> a[0]));
        PriorityQueue<int[]> pq = new PriorityQueue<>(Comparator.comparingInt(a -> a[1]));

        int time = 0, idx = 0, n = jobs.length;
        long totalWait = 0;
        int completed = 0;

        while (completed < n) {
            while (idx < n && jobs[idx][0] <= time) {
                pq.offer(jobs[idx++]);
            }
            if (pq.isEmpty()) {
                time = jobs[idx][0];
                continue;
            }
            int[] job = pq.poll();
            totalWait += time - job[0];
            time += job[1];
            completed++;
        }
        return (double) totalWait / n;
    }
}
```
**Time:** O(n log n). **Space:** O(n).
**Real-world:** SJF minimizes average waiting time but requires knowing burst times in advance. **Kubernetes** pod scheduling considers estimated resource usage similarly.

---

**P13.11 [E] Check Vector Clock Ordering**

Given two vector clocks, determine if they are causally ordered or concurrent.

```java
public class P13_11_VectorClockOrdering {

    public static String compare(int[] a, int[] b) {
        boolean aLess = false, bLess = false;
        for (int i = 0; i < a.length; i++) {
            if (a[i] < b[i]) aLess = true;
            if (a[i] > b[i]) bLess = true;
        }
        if (aLess && !bLess) return "BEFORE";      // a -> b
        if (bLess && !aLess) return "AFTER";        // b -> a
        if (!aLess && !bLess) return "EQUAL";       // identical
        return "CONCURRENT";                         // incomparable
    }
}
```
**Time:** O(n). **Space:** O(1).

---

**P13.12 [E] Implement a Simple Token Bucket Rate Limiter**

```java
public class P13_12_TokenBucket {

    private double tokens;
    private final double maxTokens;
    private final double refillRatePerMs;
    private long lastTime;

    public P13_12_TokenBucket(double maxTokens, double tokensPerSecond) {
        this.maxTokens = maxTokens;
        this.tokens = maxTokens;
        this.refillRatePerMs = tokensPerSecond / 1000.0;
        this.lastTime = System.currentTimeMillis();
    }

    public synchronized boolean allow() {
        long now = System.currentTimeMillis();
        tokens = Math.min(maxTokens, tokens + (now - lastTime) * refillRatePerMs);
        lastTime = now;
        if (tokens >= 1) { tokens--; return true; }
        return false;
    }
}
```
**Time:** O(1). **Space:** O(1).
**Real-world:** **Nginx** `limit_req` uses a leaky bucket (similar). **Google Cloud API** quotas use token bucket.

---

**P13.13 [E] Implement an LRU Page Cache**

Using `LinkedHashMap`, implement an LRU page cache that evicts the least recently used page.

```java
import java.util.LinkedHashMap;
import java.util.Map;

public class P13_13_LRUPageCache {

    private final LinkedHashMap<Integer, byte[]> cache;

    public P13_13_LRUPageCache(int maxPages) {
        this.cache = new LinkedHashMap<>(maxPages, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<Integer, byte[]> eldest) {
                return size() > maxPages;
            }
        };
    }

    public byte[] getPage(int pageNum) {
        return cache.get(pageNum);
    }

    public void putPage(int pageNum, byte[] data) {
        cache.put(pageNum, data);
    }

    public int size() { return cache.size(); }
}
```
**Time:** O(1) get and put. **Space:** O(n * pageSize).

---

**P13.14 [E] Dead Letter Queue**

Implement a queue that moves failed messages to a dead letter queue after max retries.

```java
import java.util.*;

public class P13_14_DeadLetterQueue {

    private final Queue<String> mainQueue = new LinkedList<>();
    private final Queue<String> dlq = new LinkedList<>();
    private final Map<String, Integer> retryCount = new HashMap<>();
    private final int maxRetries;

    public P13_14_DeadLetterQueue(int maxRetries) {
        this.maxRetries = maxRetries;
    }

    public void enqueue(String message) { mainQueue.offer(message); }

    public String dequeue() { return mainQueue.poll(); }

    public void nack(String message) {
        int retries = retryCount.merge(message, 1, Integer::sum);
        if (retries >= maxRetries) {
            dlq.offer(message);
            retryCount.remove(message);
        } else {
            mainQueue.offer(message);
        }
    }

    public Queue<String> getDeadLetters() { return dlq; }
}
```
**Time:** O(1) all operations. **Space:** O(n).
**Real-world:** **AWS SQS DLQ**, **RabbitMQ DLX**, **Kafka** error topics all implement this pattern.

---

### Medium (27 problems)

---

**P13.15 [M] Simulate CFS Scheduler**

Implement a CFS-like scheduler with virtual runtime tracking and weighted time slices. Support adding processes with different nice values.

```java
import java.util.*;

public class P13_15_CFSSimulator {

    static class Task implements Comparable<Task> {
        int pid;
        int nice;
        double weight;
        long vruntime;

        Task(int pid, int nice) {
            this.pid = pid;
            this.nice = nice;
            this.weight = 1024.0 / Math.pow(1.25, nice);
        }

        @Override
        public int compareTo(Task o) {
            int c = Long.compare(vruntime, o.vruntime);
            return c != 0 ? c : Integer.compare(pid, o.pid);
        }
    }

    public static List<int[]> simulate(int[][] processes, int rounds) {
        // processes[i] = {pid, nice}
        TreeMap<Task, Task> rq = new TreeMap<>();
        List<int[]> schedule = new ArrayList<>();

        for (int[] p : processes) {
            Task t = new Task(p[0], p[1]);
            rq.put(t, t);
        }

        double totalWeight = rq.keySet().stream().mapToDouble(t -> t.weight).sum();
        long schedLatency = 6_000_000; // 6ms in ns

        for (int i = 0; i < rounds && !rq.isEmpty(); i++) {
            Task next = rq.firstKey();
            rq.remove(next);

            long slice = (long)(schedLatency * (next.weight / totalWeight));
            long vrDelta = (long)(slice * (1024.0 / next.weight));
            next.vruntime += vrDelta;

            schedule.add(new int[]{next.pid, (int)(slice / 1_000_000)});
            rq.put(next, next);
        }
        return schedule;
    }
}
```
**Time:** O(R * log n) for R rounds, n processes. **Space:** O(n).

---

**P13.16 [M] Implement Multi-Level Feedback Queue**

Implement MLFQ with 3 levels, time quantum doubling, and periodic priority boost.

```java
import java.util.*;

public class P13_16_MLFQ {

    @SuppressWarnings("unchecked")
    public static int[] simulate(int[] burstTimes, int baseQuantum) {
        int n = burstTimes.length;
        int levels = 3;
        ArrayDeque<Integer>[] queues = new ArrayDeque[levels];
        for (int i = 0; i < levels; i++) queues[i] = new ArrayDeque<>();
        int[] remaining = burstTimes.clone();
        int[] level = new int[n];
        int[] completion = new int[n];

        for (int i = 0; i < n; i++) queues[0].offer(i);

        int time = 0;
        int done = 0;
        int boostInterval = baseQuantum * 20;
        int lastBoost = 0;

        while (done < n) {
            if (time - lastBoost >= boostInterval) {
                for (int l = 1; l < levels; l++) {
                    while (!queues[l].isEmpty()) {
                        int pid = queues[l].poll();
                        level[pid] = 0;
                        queues[0].offer(pid);
                    }
                }
                lastBoost = time;
            }

            boolean ran = false;
            for (int l = 0; l < levels; l++) {
                if (!queues[l].isEmpty()) {
                    int pid = queues[l].poll();
                    int quantum = baseQuantum * (1 << l);
                    int run = Math.min(quantum, remaining[pid]);
                    remaining[pid] -= run;
                    time += run;

                    if (remaining[pid] == 0) {
                        completion[pid] = time;
                        done++;
                    } else if (run == quantum && l < levels - 1) {
                        level[pid] = l + 1;
                        queues[l + 1].offer(pid);
                    } else {
                        queues[l].offer(pid);
                    }
                    ran = true;
                    break;
                }
            }
            if (!ran) time++;
        }
        return completion;
    }
}
```
**Time:** O(T) where T = sum of burst times / min quantum. **Space:** O(n).

---

**P13.17 [M] Implement Buddy Allocator with Coalescing**

Full buddy allocator supporting allocate and free with buddy coalescing.

(Solution provided in section 13.2.1 above. Complexity: O(log N) for both allocate and free.)

---

**P13.18 [M] Implement Slab Allocator**

Object pool allocator with pre-allocated slabs of fixed-size objects.

(Solution provided in section 13.2.2 above. Complexity: O(1) amortized for allocate and free.)

---

**P13.19 [M] Compare Page Replacement Algorithms**

Given a page reference string and frame count, run all four algorithms (FIFO, LRU, Clock, Optimal) and compare fault counts.

```java
import java.util.*;

public class P13_19_PageReplacementComparison {

    // Uses PageReplacement class from section 13.2.3
    public static Map<String, Integer> compare(int[] pages, int frames) {
        Map<String, Integer> results = new LinkedHashMap<>();
        results.put("FIFO", PageReplacement.fifo(pages, frames));
        results.put("LRU", PageReplacement.lru(pages, frames));
        results.put("Clock", PageReplacement.clock(pages, frames));
        results.put("LFU", PageReplacement.lfu(pages, frames));
        results.put("Optimal", PageReplacement.optimal(pages, frames));
        return results;
    }
}
```
**Key insight:** Optimal always gives the fewest faults (it has future knowledge). LRU is the best practical algorithm. Clock approximates LRU cheaply. FIFO can exhibit Belady's anomaly.

---

**P13.20 [M] Implement an In-Memory File System**

Design a file system with directories, files, read/write operations, and path resolution.

(Solution provided in section 13.3.1 above. Add read/write content methods.)

```java
public class P13_20_InMemoryFS extends FileSystemTrie {

    private final Map<Long, byte[]> fileContent = new HashMap<>();

    public boolean writeFile(String path, byte[] content) {
        FSNode node = resolve(path);
        if (node == null || node.isDirectory) return false;
        fileContent.put(node.inode, content);
        node.size = content.length;
        node.modifiedAt = System.currentTimeMillis();
        return true;
    }

    public byte[] readFile(String path) {
        FSNode node = resolve(path);
        if (node == null || node.isDirectory) return null;
        return fileContent.getOrDefault(node.inode, new byte[0]);
    }
}
```
**Time:** O(D * log B) for path resolution, O(1) for read/write. **Space:** O(files * avgSize).

---

**P13.21 [M] Implement Raft Log Replication**

Implement the AppendEntries RPC handler including log consistency check, conflict resolution, and commit index advancement.

(Solution provided in section 13.4.2 above. The `handleAppendEntries` method is the complete implementation.)

---

**P13.22 [M] Implement Vector Clock Merge and Comparison**

Full vector clock implementation with send, receive, merge, happens-before, and concurrent detection.

(Solution provided in section 13.4.3 above.)

---

**P13.23 [M] Implement Gossip Protocol Convergence Simulation**

Simulate a gossip protocol with configurable fanout and measure rounds to convergence.

```java
public class P13_23_GossipConvergence {

    // Uses GossipProtocol class from section 13.4.4
    public static int measureConvergence(int numNodes, int fanout, int numKeys) {
        GossipProtocol gp = new GossipProtocol(numNodes, fanout);

        // Seed each node with a unique key-value pair
        for (int i = 0; i < numKeys; i++) {
            int sourceNode = i % numNodes;
            gp.updateValue(sourceNode, "key" + i, "value" + i);
        }

        return gp.converge();
    }
}
```
**Expected result:** For 100 nodes with fanout 3, convergence in ~8-10 rounds. O(log n) rounds.

---

**P13.24 [M] Design a Distributed Counter (CRDT)**

Implement a PN-Counter that supports increment, decrement, merge, and value operations across replicas.

(Solution provided in section 13.4.6 above -- PNCounter class.)

---

**P13.25 [M] Implement a Merkle Tree with Diff Detection**

Build a Merkle tree over data blocks and implement efficient difference detection between two trees.

(Solution provided in section 13.4.5 above.)

---

**P13.26 [M] Design a Message Queue with Topics**

Implement a message broker with named topics, consumer groups, and offset tracking (Kafka model).

(Solution provided in section 13.5.2 above -- MessageBroker class.)

---

**P13.27 [M] Design a Service Registry with Health Checks**

Implement service registration, heartbeat-based health checking, and client-side load balancing.

(Solution provided in section 13.5.3 above -- ServiceRegistry class.)

---

**P13.28 [M] Implement a Circuit Breaker**

State machine with CLOSED/OPEN/HALF_OPEN states, sliding window failure tracking, and configurable thresholds.

(Solution provided in section 13.6.1 above.)

---

**P13.29 [M] Implement Leader Election with Bully Algorithm**

```java
import java.util.*;

public class P13_29_BullyElection {

    static class Node {
        final int id;
        boolean alive;
        int leaderId;

        Node(int id) { this.id = id; this.alive = true; this.leaderId = -1; }
    }

    private final List<Node> nodes;

    public P13_29_BullyElection(int numNodes) {
        nodes = new ArrayList<>();
        for (int i = 0; i < numNodes; i++) nodes.add(new Node(i));
    }

    /**
     * Bully election: initiated by a node that detects leader failure.
     * 1. Send ELECTION to all nodes with higher IDs.
     * 2. If no response, declare self as leader.
     * 3. If response, wait for COORDINATOR message.
     * Highest alive node wins.
     */
    public int elect(int initiatorId) {
        Node initiator = nodes.get(initiatorId);
        boolean gotResponse = false;

        // Send to higher-ID nodes
        for (int i = initiatorId + 1; i < nodes.size(); i++) {
            if (nodes.get(i).alive) {
                gotResponse = true;
                // Higher node takes over the election
                elect(i);
                return nodes.get(initiatorId).leaderId;
            }
        }

        if (!gotResponse) {
            // I am the highest alive node -- declare victory
            int newLeader = initiatorId;
            for (Node n : nodes) {
                if (n.alive) n.leaderId = newLeader;
            }
            return newLeader;
        }
        return nodes.get(initiatorId).leaderId;
    }

    public void killNode(int id) { nodes.get(id).alive = false; }
    public void reviveNode(int id) { nodes.get(id).alive = true; }
}
```
**Time:** O(n^2) messages worst case. **Space:** O(n).
**Real-world:** **MongoDB** replica set elections use a variant of the bully algorithm (highest priority wins).

---

**P13.30 [M] Design a Rate-Limited API Gateway**

```java
import java.util.*;
import java.util.concurrent.*;

public class P13_30_APIGateway {

    private final ConcurrentHashMap<String, TokenBucketRateLimiter> clientLimiters;
    private final ConcurrentHashMap<String, TokenBucketRateLimiter> endpointLimiters;
    private final int defaultRatePerSecond;

    public P13_30_APIGateway(int defaultRatePerSecond) {
        this.defaultRatePerSecond = defaultRatePerSecond;
        this.clientLimiters = new ConcurrentHashMap<>();
        this.endpointLimiters = new ConcurrentHashMap<>();
    }

    public void setClientRate(String clientId, int ratePerSecond) {
        clientLimiters.put(clientId, new TokenBucketRateLimiter(
            ratePerSecond, ratePerSecond));
    }

    public void setEndpointRate(String endpoint, int ratePerSecond) {
        endpointLimiters.put(endpoint, new TokenBucketRateLimiter(
            ratePerSecond, ratePerSecond));
    }

    /** Process a request. Returns true if allowed, false if rate-limited. */
    public boolean processRequest(String clientId, String endpoint) {
        // Check client rate limit
        TokenBucketRateLimiter clientLimiter = clientLimiters.computeIfAbsent(
            clientId, k -> new TokenBucketRateLimiter(defaultRatePerSecond, defaultRatePerSecond));
        if (!clientLimiter.tryAcquire()) return false;

        // Check endpoint rate limit
        TokenBucketRateLimiter endpointLimiter = endpointLimiters.get(endpoint);
        if (endpointLimiter != null && !endpointLimiter.tryAcquire()) return false;

        return true;
    }
}
```
**Time:** O(1) per request. **Space:** O(C + E) where C = clients, E = endpoints.
**Real-world:** **Nginx** `limit_req`, **Kong**, **AWS API Gateway** all use per-client + per-endpoint rate limiting.

---

**P13.31 [M] Implement a Distributed Lock with Fencing Tokens**

(Solution provided in section 13.6.3 above -- DistributedLock class.)

---

**P13.32 [M] Implement Clock Page Replacement with Enhanced Clock**

Enhanced clock algorithm: use both a reference bit and a dirty bit to choose eviction priority.

```java
public class P13_32_EnhancedClock {

    public static int simulate(int[] pages, boolean[] isWrite, int frames) {
        int[] frame = new int[frames];
        boolean[] ref = new boolean[frames];
        boolean[] dirty = new boolean[frames];
        Arrays.fill(frame, -1);
        Map<Integer, Integer> pageToSlot = new HashMap<>();
        int hand = 0, loaded = 0, faults = 0;

        for (int i = 0; i < pages.length; i++) {
            int page = pages[i];
            Integer slot = pageToSlot.get(page);

            if (slot != null) {
                ref[slot] = true;
                if (isWrite[i]) dirty[slot] = true;
                continue;
            }

            faults++;
            if (loaded < frames) {
                frame[loaded] = page;
                ref[loaded] = true;
                dirty[loaded] = isWrite[i];
                pageToSlot.put(page, loaded);
                loaded++;
            } else {
                // Enhanced clock: prefer (ref=0, dirty=0) > (ref=0, dirty=1)
                while (true) {
                    if (!ref[hand] && !dirty[hand]) break;
                    if (!ref[hand] && dirty[hand]) {
                        dirty[hand] = false; // "write back"
                    }
                    ref[hand] = false;
                    hand = (hand + 1) % frames;
                }
                pageToSlot.remove(frame[hand]);
                frame[hand] = page;
                ref[hand] = true;
                dirty[hand] = isWrite[i];
                pageToSlot.put(page, hand);
                hand = (hand + 1) % frames;
            }
        }
        return faults;
    }
}
```
**Time:** O(P * F) worst case, O(P) amortized. **Space:** O(F).

---

**P13.33 [M] Implement a Consistent Hash Ring with Replication**

Consistent hash ring that returns N replicas for a key, ensuring they are on distinct physical nodes.

(Solution provided in section 13.4.1 above -- `getNodes` method.)

---

**P13.34 [M] Implement a Priority Message Queue**

Messages have priorities. Higher-priority messages are consumed first within a topic.

```java
import java.util.*;

public class P13_34_PriorityMessageQueue {

    static class PriorityMessage implements Comparable<PriorityMessage> {
        final int priority;
        final String payload;
        final long timestamp;

        PriorityMessage(int priority, String payload) {
            this.priority = priority;
            this.payload = payload;
            this.timestamp = System.nanoTime();
        }

        @Override
        public int compareTo(PriorityMessage o) {
            int c = Integer.compare(o.priority, this.priority); // higher first
            return c != 0 ? c : Long.compare(this.timestamp, o.timestamp); // FIFO tiebreak
        }
    }

    private final Map<String, PriorityQueue<PriorityMessage>> topics = new HashMap<>();

    public void createTopic(String name) {
        topics.putIfAbsent(name, new PriorityQueue<>());
    }

    public void publish(String topic, int priority, String payload) {
        topics.computeIfAbsent(topic, k -> new PriorityQueue<>())
              .offer(new PriorityMessage(priority, payload));
    }

    public String consume(String topic) {
        PriorityQueue<PriorityMessage> pq = topics.get(topic);
        if (pq == null || pq.isEmpty()) return null;
        return pq.poll().payload;
    }
}
```
**Time:** O(log n) publish, O(log n) consume. **Space:** O(n).
**Real-world:** **RabbitMQ priority queues** support up to 255 priority levels using multiple internal queues.

---

**P13.35 [M] Simulate Raft Leader Election**

Simulate the Raft election process with timeouts, vote requests, and term advancement.

```java
import java.util.*;

public class P13_35_RaftElection {

    static class RaftPeer {
        int id, currentTerm, votedFor = -1;
        boolean isLeader = false;
        int lastLogIndex = -1, lastLogTerm = -1;
        boolean alive = true;

        RaftPeer(int id) { this.id = id; }
    }

    public static int electLeader(int numPeers, int failedNode) {
        List<RaftPeer> peers = new ArrayList<>();
        for (int i = 0; i < numPeers; i++) peers.add(new RaftPeer(i));
        if (failedNode >= 0) peers.get(failedNode).alive = false;

        // Random node starts election (first alive non-failed node)
        RaftPeer candidate = null;
        for (RaftPeer p : peers) {
            if (p.alive) { candidate = p; break; }
        }
        if (candidate == null) return -1;

        candidate.currentTerm++;
        candidate.votedFor = candidate.id;
        int votes = 1;

        for (RaftPeer peer : peers) {
            if (peer.id == candidate.id || !peer.alive) continue;
            if (candidate.currentTerm > peer.currentTerm && peer.votedFor == -1) {
                peer.votedFor = candidate.id;
                peer.currentTerm = candidate.currentTerm;
                votes++;
            }
        }

        int majority = numPeers / 2 + 1;
        if (votes >= majority) {
            candidate.isLeader = true;
            return candidate.id;
        }
        return -1;
    }
}
```
**Time:** O(n) per election. **Space:** O(n).

---

**P13.36 [M] Implement Free Block Allocator with Best-Fit**

```java
public class P13_36_BestFitAllocator {

    static class Block implements Comparable<Block> {
        int start, size;
        Block(int start, int size) { this.start = start; this.size = size; }

        @Override
        public int compareTo(Block o) {
            int c = Integer.compare(size, o.size);
            return c != 0 ? c : Integer.compare(start, o.start);
        }
    }

    private TreeMap<Block, Block> freeBlocks = new TreeMap<>();

    public P13_36_BestFitAllocator(int totalSize) {
        Block b = new Block(0, totalSize);
        freeBlocks.put(b, b);
    }

    /** Best-fit: find smallest block >= requested size. O(log n). */
    public int allocate(int size) {
        Block search = new Block(0, size);
        Map.Entry<Block, Block> entry = freeBlocks.ceilingEntry(search);
        if (entry == null) return -1;

        Block block = entry.getKey();
        freeBlocks.remove(block);

        int addr = block.start;
        if (block.size > size) {
            Block remainder = new Block(block.start + size, block.size - size);
            freeBlocks.put(remainder, remainder);
        }
        return addr;
    }

    public void free(int start, int size) {
        Block b = new Block(start, size);
        freeBlocks.put(b, b);
        // Note: coalescing with adjacent blocks omitted for brevity
    }
}
```
**Time:** O(log n) allocate with TreeMap. **Space:** O(n) free blocks.

---

**P13.37 [M] Implement a Sliding Window Rate Limiter**

```java
public class P13_37_SlidingWindow {

    // Fixed window counters + interpolation for sliding window approximation
    private final int maxRequests;
    private final long windowMs;
    private int currentCount = 0;
    private int previousCount = 0;
    private long currentWindowStart;

    public P13_37_SlidingWindow(int maxRequests, long windowMs) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.currentWindowStart = System.currentTimeMillis();
    }

    public synchronized boolean allow() {
        long now = System.currentTimeMillis();
        long elapsed = now - currentWindowStart;

        if (elapsed >= windowMs) {
            previousCount = currentCount;
            currentCount = 0;
            currentWindowStart = now;
            elapsed = 0;
        }

        double windowFraction = (double) elapsed / windowMs;
        double estimatedCount = previousCount * (1 - windowFraction) + currentCount;

        if (estimatedCount < maxRequests) {
            currentCount++;
            return true;
        }
        return false;
    }
}
```
**Time:** O(1). **Space:** O(1).
**Real-world:** **Cloudflare** uses this approximation in their rate limiter. It uses constant memory versus the log-based approach which stores every timestamp.

---

**P13.38 [M] Implement a Two-Phase Commit Coordinator**

```java
import java.util.*;

public class P13_38_TwoPhaseCommit {

    enum Vote { YES, NO, TIMEOUT }
    enum Decision { COMMIT, ABORT }

    static class Participant {
        final String name;
        boolean prepared = false;
        boolean committed = false;

        Participant(String name) { this.name = name; }

        Vote prepare() {
            // Simulate: write to local WAL, acquire locks
            prepared = true;
            return Vote.YES;
        }

        void commit() { committed = true; }
        void abort() { prepared = false; committed = false; }
    }

    private final List<Participant> participants;
    private Decision decision;

    public P13_38_TwoPhaseCommit(List<String> names) {
        participants = new ArrayList<>();
        for (String n : names) participants.add(new Participant(n));
    }

    /** Phase 1: Prepare. Coordinator asks all participants to vote. */
    public boolean prepare() {
        for (Participant p : participants) {
            Vote v = p.prepare();
            if (v != Vote.YES) {
                decision = Decision.ABORT;
                abort();
                return false;
            }
        }
        return true;
    }

    /** Phase 2: Commit or Abort based on votes. */
    public Decision commit() {
        if (prepare()) {
            decision = Decision.COMMIT;
            for (Participant p : participants) p.commit();
        } else {
            decision = Decision.ABORT;
            abort();
        }
        return decision;
    }

    private void abort() {
        for (Participant p : participants) p.abort();
    }

    public Decision getDecision() { return decision; }
}
```
**Time:** O(n) per phase where n = participants. **Space:** O(n).
**Real-world:** **XA transactions** in Java (JTA) implement 2PC. **Google Spanner** uses a variant called 2PC+Paxos.

---

**P13.39 [M] Implement an Event-Sourced System**

Store all state changes as an append-only event log. Derive current state by replaying events.

```java
import java.util.*;

public class P13_39_EventSourcing {

    interface Event { long timestamp(); }

    record AccountCreated(String id, long timestamp) implements Event {}
    record MoneyDeposited(String id, long amount, long timestamp) implements Event {}
    record MoneyWithdrawn(String id, long amount, long timestamp) implements Event {}

    static class Account {
        String id;
        long balance;
    }

    private final List<Event> eventLog = new ArrayList<>();  // append-only

    public void appendEvent(Event event) {
        eventLog.add(event);
    }

    /** Derive current state by replaying all events. */
    public Map<String, Account> rebuildState() {
        Map<String, Account> accounts = new HashMap<>();

        for (Event e : eventLog) {
            if (e instanceof AccountCreated ac) {
                Account a = new Account();
                a.id = ac.id();
                a.balance = 0;
                accounts.put(a.id, a);
            } else if (e instanceof MoneyDeposited md) {
                accounts.get(md.id()).balance += md.amount();
            } else if (e instanceof MoneyWithdrawn mw) {
                accounts.get(mw.id()).balance -= mw.amount();
            }
        }
        return accounts;
    }

    /** Build state up to a specific point in time (time travel). */
    public Map<String, Account> stateAt(long timestamp) {
        Map<String, Account> accounts = new HashMap<>();
        for (Event e : eventLog) {
            if (e.timestamp() > timestamp) break;
            // Same replay logic as above...
            if (e instanceof AccountCreated ac) {
                Account a = new Account();
                a.id = ac.id();
                accounts.put(a.id, a);
            } else if (e instanceof MoneyDeposited md) {
                accounts.get(md.id()).balance += md.amount();
            } else if (e instanceof MoneyWithdrawn mw) {
                accounts.get(mw.id()).balance -= mw.amount();
            }
        }
        return accounts;
    }

    public int eventCount() { return eventLog.size(); }
}
```
**Time:** O(E) for state rebuild. **Space:** O(E) for event log.
**Real-world:** **EventStoreDB**, **Apache Kafka** as event log, **Axon Framework** all use event sourcing.

---

**P13.40 [M] Implement a Retry Strategy with Exponential Backoff**

```java
import java.util.function.Supplier;

public class P13_40_RetryWithBackoff {

    public static <T> T executeWithRetry(Supplier<T> operation, int maxRetries,
                                          long baseDelayMs, double multiplier, long maxDelayMs) 
                                          throws Exception {
        int attempt = 0;
        long delay = baseDelayMs;

        while (true) {
            try {
                return operation.get();
            } catch (Exception e) {
                attempt++;
                if (attempt >= maxRetries) throw e;

                // Add jitter to prevent thundering herd
                long jitter = (long)(delay * Math.random() * 0.3);
                long sleepTime = Math.min(delay + jitter, maxDelayMs);

                Thread.sleep(sleepTime);
                delay = (long)(delay * multiplier);
            }
        }
    }
}
```
**Real-world:** **AWS SDK** uses exponential backoff with jitter (the "Full Jitter" algorithm). **gRPC** retry policy implements similar backoff.

---

**P13.41 [M] Implement a Consistent Hash Ring Rebalancer**

When a node joins or leaves, determine which keys need to migrate.

```java
import java.util.*;

public class P13_41_HashRingRebalancer {

    /** Compute which keys need to migrate when a new node joins. */
    public static <T> Map<T, List<String>> computeMigrations(
            ConsistentHashRing<T> ring, T newNode, List<String> allKeys) {

        // Record current assignments
        Map<String, T> before = new HashMap<>();
        for (String key : allKeys) {
            before.put(key, ring.getNode(key));
        }

        // Add new node
        ring.addNode(newNode);

        // Find keys that changed assignment
        Map<T, List<String>> migrations = new HashMap<>();
        for (String key : allKeys) {
            T newOwner = ring.getNode(key);
            T oldOwner = before.get(key);
            if (!newOwner.equals(oldOwner)) {
                migrations.computeIfAbsent(oldOwner, k -> new ArrayList<>()).add(key);
            }
        }
        return migrations;
    }
}
```
**Time:** O(K * log(N*V)) where K = keys, N = nodes, V = virtual nodes. **Space:** O(K).

---

### Hard (14 problems)

---

**P13.42 [H] Implement a Full Task Scheduler (OS-Style)**

Combine MLFQ, priority scheduling, and CFS with configurable scheduling classes. Support SCHED_FIFO, SCHED_RR, and SCHED_NORMAL scheduling policies.

```java
import java.util.*;

public class P13_42_FullTaskScheduler {

    enum Policy { SCHED_FIFO, SCHED_RR, SCHED_NORMAL }

    static class Task implements Comparable<Task> {
        int pid;
        Policy policy;
        int priority;        // for RT tasks
        long remainingTime;
        long vruntime;       // for SCHED_NORMAL (CFS)
        double weight;

        Task(int pid, Policy policy, int priority, long burstTime) {
            this.pid = pid;
            this.policy = policy;
            this.priority = priority;
            this.remainingTime = burstTime;
            this.weight = 1024.0;
        }

        @Override
        public int compareTo(Task o) {
            int c = Long.compare(vruntime, o.vruntime);
            return c != 0 ? c : Integer.compare(pid, o.pid);
        }
    }

    // RT tasks (SCHED_FIFO, SCHED_RR): priority queues by priority level
    private final PriorityQueue<Task> rtQueue = new PriorityQueue<>(
        (a, b) -> Integer.compare(b.priority, a.priority));

    // Normal tasks (SCHED_NORMAL): CFS red-black tree
    private final TreeMap<Task, Task> cfsTree = new TreeMap<>();

    private final long rrQuantum;

    public P13_42_FullTaskScheduler(long rrQuantum) {
        this.rrQuantum = rrQuantum;
    }

    public void addTask(Task task) {
        switch (task.policy) {
            case SCHED_FIFO, SCHED_RR -> rtQueue.offer(task);
            case SCHED_NORMAL -> cfsTree.put(task, task);
        }
    }

    /** Schedule one task. RT tasks always preempt normal tasks. */
    public String scheduleNext() {
        // Real-time tasks have absolute priority over normal tasks
        if (!rtQueue.isEmpty()) {
            Task rt = rtQueue.poll();

            if (rt.policy == Policy.SCHED_FIFO) {
                // SCHED_FIFO: run to completion (no preemption by same-priority)
                long runTime = rt.remainingTime;
                rt.remainingTime = 0;
                return String.format("RT-FIFO PID=%d ran %dms (complete)", rt.pid, runTime);
            } else {
                // SCHED_RR: run for quantum, then back to queue
                long runTime = Math.min(rrQuantum, rt.remainingTime);
                rt.remainingTime -= runTime;
                if (rt.remainingTime > 0) rtQueue.offer(rt);
                return String.format("RT-RR PID=%d ran %dms (remaining=%d)",
                    rt.pid, runTime, rt.remainingTime);
            }
        }

        // Normal tasks: CFS
        if (!cfsTree.isEmpty()) {
            Task task = cfsTree.firstKey();
            cfsTree.remove(task);

            long slice = Math.min(4, task.remainingTime); // simplified slice
            long vrDelta = (long)(slice * 1024.0 / task.weight);
            task.vruntime += vrDelta;
            task.remainingTime -= slice;

            if (task.remainingTime > 0) cfsTree.put(task, task);
            return String.format("CFS PID=%d ran %dms (vruntime=%d, remaining=%d)",
                task.pid, slice, task.vruntime, task.remainingTime);
        }

        return "IDLE";
    }
}
```
**Time:** O(log n) per scheduling decision. **Space:** O(n).
**Real-world:** This mirrors the actual Linux kernel scheduler architecture with its scheduling classes: `rt_sched_class` (FIFO/RR) > `fair_sched_class` (CFS) > `idle_sched_class`.

---

**P13.43 [H] Implement a Full Raft Consensus Node**

Complete Raft implementation including leader election, log replication, safety checks, and state machine application.

(Solution provided in section 13.4.2 above -- RaftNode class with full AppendEntries and RequestVote handlers.)

---

**P13.44 [H] Implement a Distributed Hash Table (Chord)**

Full Chord implementation with finger table, node join, stabilization, and key lookup.

(Solution provided in section 13.4.7 above -- ChordNode class.)

---

**P13.45 [H] Design a Full Message Broker**

Multi-topic, multi-partition message broker with consumer groups, offset management, and dead letter queue.

```java
import java.util.*;
import java.util.concurrent.*;

public class P13_45_FullMessageBroker {

    static class Partition {
        final List<String> log = new ArrayList<>();
        final Map<String, Integer> offsets = new ConcurrentHashMap<>();

        int append(String msg) {
            log.add(msg);
            return log.size() - 1;
        }

        List<String> fetch(String group, int maxCount) {
            int offset = offsets.getOrDefault(group, 0);
            int end = Math.min(offset + maxCount, log.size());
            return new ArrayList<>(log.subList(offset, end));
        }

        void commit(String group, int count) {
            offsets.merge(group, count, Integer::sum);
        }
    }

    static class TopicConfig {
        final String name;
        final int numPartitions;
        final Partition[] partitions;

        TopicConfig(String name, int numPartitions) {
            this.name = name;
            this.numPartitions = numPartitions;
            this.partitions = new Partition[numPartitions];
            for (int i = 0; i < numPartitions; i++) {
                partitions[i] = new Partition();
            }
        }

        int partitionFor(String key) {
            return Math.abs(key.hashCode()) % numPartitions;
        }
    }

    private final Map<String, TopicConfig> topics = new ConcurrentHashMap<>();
    private final Partition deadLetterPartition = new Partition();

    public void createTopic(String name, int partitions) {
        topics.put(name, new TopicConfig(name, partitions));
    }

    public int produce(String topic, String key, String value) {
        TopicConfig tc = topics.get(topic);
        if (tc == null) throw new IllegalArgumentException("No topic: " + topic);
        int part = tc.partitionFor(key);
        return tc.partitions[part].append(value);
    }

    public List<String> consume(String topic, int partition, String group, int maxCount) {
        TopicConfig tc = topics.get(topic);
        if (tc == null) return Collections.emptyList();
        return tc.partitions[partition].fetch(group, maxCount);
    }

    public void commitOffset(String topic, int partition, String group, int count) {
        TopicConfig tc = topics.get(topic);
        if (tc != null) tc.partitions[partition].commit(group, count);
    }
}
```
**Time:** O(1) produce, O(B) consume where B = batch size. **Space:** O(M) total messages.
**Real-world:** This is a simplified **Apache Kafka** model. Kafka partitions are the unit of parallelism and ordering.

---

**P13.46 [H] Implement a Distributed Lock Manager with Deadlock Detection**

```java
import java.util.*;

public class P13_46_DistributedLockManager {

    private final Map<String, String> lockOwner = new HashMap<>();  // resource -> owner
    private final Map<String, Set<String>> waitGraph = new HashMap<>();  // waiter -> resources waiting for

    public boolean tryAcquire(String resource, String txId) {
        if (!lockOwner.containsKey(resource)) {
            lockOwner.put(resource, txId);
            return true;
        }
        if (lockOwner.get(resource).equals(txId)) return true;

        // Record in wait graph
        waitGraph.computeIfAbsent(txId, k -> new HashSet<>()).add(resource);

        // Check for deadlock
        if (detectDeadlock(txId)) {
            waitGraph.getOrDefault(txId, Collections.emptySet()).remove(resource);
            return false;  // abort to prevent deadlock
        }
        return false;
    }

    public void release(String resource, String txId) {
        if (lockOwner.containsKey(resource) && lockOwner.get(resource).equals(txId)) {
            lockOwner.remove(resource);
        }
    }

    /** Detect deadlock using cycle detection in the wait-for graph. */
    private boolean detectDeadlock(String startTx) {
        Set<String> visited = new HashSet<>();
        Set<String> inStack = new HashSet<>();
        return hasCycle(startTx, visited, inStack);
    }

    private boolean hasCycle(String tx, Set<String> visited, Set<String> inStack) {
        if (inStack.contains(tx)) return true;
        if (visited.contains(tx)) return false;

        visited.add(tx);
        inStack.add(tx);

        Set<String> waitingFor = waitGraph.getOrDefault(tx, Collections.emptySet());
        for (String resource : waitingFor) {
            String owner = lockOwner.get(resource);
            if (owner != null && !owner.equals(tx)) {
                if (hasCycle(owner, visited, inStack)) return true;
            }
        }

        inStack.remove(tx);
        return false;
    }
}
```
**Time:** O(V + E) for deadlock detection where V = transactions, E = wait edges. **Space:** O(V + E).
**Real-world:** **InnoDB** uses a wait-for graph with BFS-based cycle detection. **PostgreSQL** detects deadlocks with a similar approach.

---

**P13.47 [H] Implement a Memtable with Write-Ahead Log**

```java
import java.util.*;

public class P13_47_Memtable {

    // Write-ahead log: persist before acknowledging write
    private final List<String> wal = new ArrayList<>();

    // Memtable: sorted in-memory structure (like an LSM tree component)
    private TreeMap<String, String> memtable = new TreeMap<>();
    private final int maxMemtableSize;
    private final List<TreeMap<String, String>> sstables = new ArrayList<>(); // flushed tables

    public P13_47_Memtable(int maxMemtableSize) {
        this.maxMemtableSize = maxMemtableSize;
    }

    /** Write: append to WAL, then insert into memtable. */
    public void put(String key, String value) {
        // WAL first (crash safety)
        wal.add("PUT " + key + " " + value);

        memtable.put(key, value);

        // Flush if memtable is full
        if (memtable.size() >= maxMemtableSize) {
            flush();
        }
    }

    /** Read: check memtable first, then SSTables in reverse order. */
    public String get(String key) {
        // Check active memtable
        String val = memtable.get(key);
        if (val != null) return val;

        // Check SSTables (newest first)
        for (int i = sstables.size() - 1; i >= 0; i--) {
            val = sstables.get(i).get(key);
            if (val != null) return val;
        }
        return null;
    }

    /** Flush memtable to an SSTable. */
    private void flush() {
        sstables.add(memtable);
        memtable = new TreeMap<>();
        wal.clear();
    }

    /** Recover from WAL after crash. */
    public void recover(List<String> walEntries) {
        for (String entry : walEntries) {
            String[] parts = entry.split(" ", 3);
            if (parts[0].equals("PUT")) {
                memtable.put(parts[1], parts[2]);
            }
        }
    }
}
```
**Time:** O(log n) for put/get in memtable. O(L * log n) for get across L SSTables. **Space:** O(n).
**Real-world:** This is the core of **LevelDB**, **RocksDB**, **Cassandra**, and **HBase** storage engines.

---

**P13.48 [H] Implement a Gossip-Based Failure Detector**

```java
import java.util.*;

public class P13_48_GossipFailureDetector {

    static class MemberState {
        final int nodeId;
        int heartbeatCounter;
        long lastUpdated;
        boolean alive;

        MemberState(int nodeId) {
            this.nodeId = nodeId;
            this.heartbeatCounter = 0;
            this.lastUpdated = System.currentTimeMillis();
            this.alive = true;
        }
    }

    private final int nodeId;
    private final Map<Integer, MemberState> members = new HashMap<>();
    private final long suspectTimeoutMs;
    private final long deadTimeoutMs;
    private final Random rng = new Random();

    public P13_48_GossipFailureDetector(int nodeId, long suspectTimeoutMs, long deadTimeoutMs) {
        this.nodeId = nodeId;
        this.suspectTimeoutMs = suspectTimeoutMs;
        this.deadTimeoutMs = deadTimeoutMs;
        members.put(nodeId, new MemberState(nodeId));
    }

    public void addMember(int id) {
        members.putIfAbsent(id, new MemberState(id));
    }

    /** Increment own heartbeat counter. Called periodically. */
    public void tick() {
        MemberState self = members.get(nodeId);
        self.heartbeatCounter++;
        self.lastUpdated = System.currentTimeMillis();
    }

    /** Merge gossip from another node. */
    public void receiveGossip(Map<Integer, Integer> peerHeartbeats) {
        long now = System.currentTimeMillis();
        for (Map.Entry<Integer, Integer> entry : peerHeartbeats.entrySet()) {
            int peerId = entry.getKey();
            int peerHb = entry.getValue();
            MemberState state = members.get(peerId);

            if (state == null) {
                state = new MemberState(peerId);
                members.put(peerId, state);
            }

            if (peerHb > state.heartbeatCounter) {
                state.heartbeatCounter = peerHb;
                state.lastUpdated = now;
                state.alive = true;
            }
        }
    }

    /** Check for failed nodes. */
    public List<Integer> detectFailures() {
        long now = System.currentTimeMillis();
        List<Integer> failed = new ArrayList<>();

        for (MemberState m : members.values()) {
            if (m.nodeId == nodeId) continue;
            long elapsed = now - m.lastUpdated;
            if (elapsed > deadTimeoutMs) {
                m.alive = false;
                failed.add(m.nodeId);
            }
        }
        return failed;
    }

    /** Get heartbeat state for gossip transmission. */
    public Map<Integer, Integer> getGossipState() {
        Map<Integer, Integer> state = new HashMap<>();
        for (MemberState m : members.values()) {
            if (m.alive) state.put(m.nodeId, m.heartbeatCounter);
        }
        return state;
    }
}
```
**Time:** O(n) per gossip round. **Space:** O(n) per node.
**Real-world:** **SWIM** (Scalable Weakly-consistent Infection-style Process Group Membership) used by **HashiCorp Serf** and **Consul**.

---

**P13.49 [H] Design a Sharded Key-Value Store**

```java
import java.util.*;
import java.util.concurrent.*;

public class P13_49_ShardedKVStore {

    static class Shard {
        private final ConcurrentHashMap<String, String> data = new ConcurrentHashMap<>();
        private final String shardId;

        Shard(String shardId) { this.shardId = shardId; }

        String get(String key) { return data.get(key); }
        void put(String key, String value) { data.put(key, value); }
        void delete(String key) { data.remove(key); }
        int size() { return data.size(); }
    }

    private final ConsistentHashRing<String> ring;
    private final Map<String, Shard> shards = new ConcurrentHashMap<>();
    private final int replicationFactor;

    public P13_49_ShardedKVStore(int virtualNodes, int replicationFactor) {
        this.ring = new ConsistentHashRing<>(virtualNodes);
        this.replicationFactor = replicationFactor;
    }

    public void addShard(String shardId) {
        shards.put(shardId, new Shard(shardId));
        ring.addNode(shardId);
    }

    public void put(String key, String value) {
        List<String> replicas = ring.getNodes(key, replicationFactor);
        for (String r : replicas) {
            shards.get(r).put(key, value);
        }
    }

    public String get(String key) {
        String primary = ring.getNode(key);
        return shards.get(primary).get(key);
    }

    /** Rebalance after adding a new shard. */
    public Map<String, Integer> getShardSizes() {
        Map<String, Integer> sizes = new HashMap<>();
        for (Map.Entry<String, Shard> e : shards.entrySet()) {
            sizes.put(e.getKey(), e.getValue().size());
        }
        return sizes;
    }
}
```
**Time:** O(R * log(N*V)) per put, O(log(N*V)) per get. **Space:** O(K * R) where K = keys, R = replication factor.
**Real-world:** **Amazon DynamoDB**, **Apache Cassandra**, **Riak** all use consistent hashing with replication.

---

**P13.50 [H] Implement a Write-Ahead Log with Checkpointing**

```java
import java.util.*;

public class P13_50_WALWithCheckpoint {

    record LogRecord(long lsn, String operation, String table, 
                     String key, String oldValue, String newValue) {}

    private final List<LogRecord> wal = new ArrayList<>();
    private long nextLSN = 1;
    private long checkpointLSN = 0;
    private final Map<String, Map<String, String>> database = new HashMap<>();

    public long write(String op, String table, String key, String oldVal, String newVal) {
        long lsn = nextLSN++;
        wal.add(new LogRecord(lsn, op, table, key, oldVal, newVal));
        // Apply to database
        database.computeIfAbsent(table, k -> new HashMap<>()).put(key, newVal);
        return lsn;
    }

    /** Checkpoint: mark current position. Everything before can be truncated. */
    public void checkpoint() {
        checkpointLSN = nextLSN - 1;
        // Truncate WAL entries before checkpoint
        wal.removeIf(r -> r.lsn() <= checkpointLSN);
    }

    /** Redo recovery: replay all WAL entries after last checkpoint. */
    public void redo() {
        for (LogRecord record : wal) {
            if (record.lsn() > checkpointLSN) {
                database.computeIfAbsent(record.table(), k -> new HashMap<>())
                        .put(record.key(), record.newValue());
            }
        }
    }

    /** Undo recovery: reverse operations for uncommitted transactions. */
    public void undo(Set<Long> uncommittedLSNs) {
        // Process in reverse order
        for (int i = wal.size() - 1; i >= 0; i--) {
            LogRecord record = wal.get(i);
            if (uncommittedLSNs.contains(record.lsn())) {
                Map<String, String> table = database.get(record.table());
                if (table != null) {
                    if (record.oldValue() == null) {
                        table.remove(record.key());
                    } else {
                        table.put(record.key(), record.oldValue());
                    }
                }
            }
        }
    }

    public int walSize() { return wal.size(); }
}
```
**Time:** O(1) for write, O(W) for recovery where W = WAL entries since checkpoint. **Space:** O(W).
**Real-world:** **PostgreSQL WAL**, **InnoDB redo log**, **ARIES** recovery algorithm.

---

**P13.51 [H] Implement a SWIM Failure Detector**

```java
import java.util.*;

public class P13_51_SWIM {

    enum Status { ALIVE, SUSPECT, DEAD }

    static class Member {
        int id;
        Status status;
        int incarnation;

        Member(int id) { this.id = id; this.status = Status.ALIVE; this.incarnation = 0; }
    }

    private final int selfId;
    private final Map<Integer, Member> members = new HashMap<>();
    private final Random rng = new Random();
    private final int indirectProbes; // k indirect probes

    public P13_51_SWIM(int selfId, int indirectProbes) {
        this.selfId = selfId;
        this.indirectProbes = indirectProbes;
        members.put(selfId, new Member(selfId));
    }

    public void addMember(int id) { members.put(id, new Member(id)); }

    /** 
     * SWIM protocol round:
     * 1. Pick a random member, ping it.
     * 2. If no ack, pick k random members to indirect-ping.
     * 3. If still no ack, mark as suspect -> dead.
     */
    public String protocolRound(Set<Integer> unreachable) {
        List<Integer> candidates = new ArrayList<>();
        for (Member m : members.values()) {
            if (m.id != selfId && m.status != Status.DEAD) candidates.add(m.id);
        }
        if (candidates.isEmpty()) return "no members";

        int target = candidates.get(rng.nextInt(candidates.size()));

        // Direct ping
        if (!unreachable.contains(target)) {
            return "PING " + target + " -> ACK";
        }

        // Indirect probes
        Collections.shuffle(candidates, rng);
        for (int i = 0; i < Math.min(indirectProbes, candidates.size()); i++) {
            int proxy = candidates.get(i);
            if (proxy == target) continue;
            if (!unreachable.contains(proxy) && !unreachable.contains(target)) {
                return "INDIRECT-PING " + target + " via " + proxy + " -> ACK";
            }
        }

        // No ack: mark suspect
        Member m = members.get(target);
        if (m.status == Status.ALIVE) {
            m.status = Status.SUSPECT;
            return "SUSPECT " + target;
        } else if (m.status == Status.SUSPECT) {
            m.status = Status.DEAD;
            return "DEAD " + target;
        }
        return "already DEAD " + target;
    }

    /** Refute a suspicion about self (increment incarnation). */
    public void refuteSuspicion() {
        Member self = members.get(selfId);
        self.incarnation++;
        self.status = Status.ALIVE;
    }

    public Map<Integer, Status> getStatuses() {
        Map<Integer, Status> result = new HashMap<>();
        for (Member m : members.values()) result.put(m.id, m.status);
        return result;
    }
}
```
**Time:** O(1 + k) per round where k = indirect probes. **Space:** O(n).
**Real-world:** **HashiCorp Serf** (used by Consul, Nomad) implements SWIM with suspicion-based failure detection.

---

**P13.52 [H] Implement a Saga Orchestrator**

```java
import java.util.*;
import java.util.function.Supplier;

public class P13_52_SagaOrchestrator {

    static class SagaStep {
        final String name;
        final Supplier<Boolean> action;
        final Runnable compensation;
        boolean completed = false;

        SagaStep(String name, Supplier<Boolean> action, Runnable compensation) {
            this.name = name;
            this.action = action;
            this.compensation = compensation;
        }
    }

    private final List<SagaStep> steps = new ArrayList<>();
    private final List<SagaStep> completedSteps = new ArrayList<>();

    public void addStep(String name, Supplier<Boolean> action, Runnable compensation) {
        steps.add(new SagaStep(name, action, compensation));
    }

    /**
     * Execute the saga. If any step fails, compensate in reverse order.
     * Returns true if all steps succeeded, false if compensated.
     */
    public boolean execute() {
        for (SagaStep step : steps) {
            try {
                boolean success = step.action.get();
                if (!success) {
                    compensate();
                    return false;
                }
                step.completed = true;
                completedSteps.add(step);
            } catch (Exception e) {
                compensate();
                return false;
            }
        }
        return true;
    }

    /** Compensate completed steps in reverse order (undo). */
    private void compensate() {
        for (int i = completedSteps.size() - 1; i >= 0; i--) {
            SagaStep step = completedSteps.get(i);
            try {
                step.compensation.run();
            } catch (Exception e) {
                // Log compensation failure -- may need manual intervention
                System.err.println("Compensation failed for: " + step.name);
            }
        }
        completedSteps.clear();
    }
}
```
**Time:** O(S) for execution, O(S) for compensation where S = steps. **Space:** O(S).
**Real-world:** **Temporal**, **Apache Camel Saga**, **Axon Saga** implement this pattern. Used for distributed transactions in microservices (e.g., order -> payment -> inventory -> shipping).

---

**P13.53 [H] Implement a Multi-Version Concurrency Control (MVCC) Store**

```java
import java.util.*;

public class P13_53_MVCCStore {

    static class Version {
        final String value;
        final long writeTimestamp;
        final long txId;
        boolean committed;

        Version(String value, long writeTs, long txId) {
            this.value = value;
            this.writeTimestamp = writeTs;
            this.txId = txId;
            this.committed = false;
        }
    }

    // Key -> list of versions (sorted by timestamp, newest first)
    private final Map<String, TreeMap<Long, Version>> store = new HashMap<>();
    private long nextTimestamp = 1;

    /** Begin a transaction. Returns a snapshot timestamp. */
    public long beginTransaction() {
        return nextTimestamp++;
    }

    /** Write: create a new version visible only to this transaction until commit. */
    public void write(String key, String value, long txId) {
        store.computeIfAbsent(key, k -> new TreeMap<>())
             .put(txId, new Version(value, txId, txId));
    }

    /** 
     * Read: find the latest committed version visible to this transaction.
     * Snapshot isolation: see only versions committed before our start time.
     */
    public String read(String key, long snapshotTimestamp) {
        TreeMap<Long, Version> versions = store.get(key);
        if (versions == null) return null;

        // Find latest version <= snapshotTimestamp that is committed
        for (Map.Entry<Long, Version> entry : versions.descendingMap().entrySet()) {
            Version v = entry.getValue();
            if (v.writeTimestamp <= snapshotTimestamp && v.committed) {
                return v.value;
            }
        }
        return null;
    }

    /** Commit a transaction: make all its versions visible. */
    public void commit(long txId) {
        for (TreeMap<Long, Version> versions : store.values()) {
            Version v = versions.get(txId);
            if (v != null) v.committed = true;
        }
    }

    /** Abort: remove all versions created by this transaction. */
    public void abort(long txId) {
        for (TreeMap<Long, Version> versions : store.values()) {
            versions.remove(txId);
        }
    }

    /** Garbage collect old versions no longer visible to any active transaction. */
    public void gc(long oldestActiveTimestamp) {
        for (TreeMap<Long, Version> versions : store.values()) {
            versions.headMap(oldestActiveTimestamp).clear();
        }
    }
}
```
**Time:** O(log V) for read/write where V = versions per key. **Space:** O(K * V).
**Real-world:** **PostgreSQL** MVCC keeps old tuple versions in the heap. **InnoDB** uses undo segments for MVCC. **CockroachDB** implements MVCC over RocksDB.

---

**P13.54 [H] Implement a Conflict-Free Replicated JSON Document (CRDT)**

```java
import java.util.*;

public class P13_54_CRDTDocument {

    // OR-Set (Observed-Remove Set): supports both add and remove
    static class ORSet<E> {
        // Each element is tagged with unique add-IDs
        private final Map<E, Set<String>> elements = new HashMap<>();
        // Tombstones: removed add-IDs
        private final Set<String> tombstones = new HashSet<>();
        private int tagCounter = 0;
        private final String replicaId;

        ORSet(String replicaId) { this.replicaId = replicaId; }

        String generateTag() { return replicaId + ":" + (tagCounter++); }

        void add(E element) {
            String tag = generateTag();
            elements.computeIfAbsent(element, k -> new HashSet<>()).add(tag);
        }

        void remove(E element) {
            Set<String> tags = elements.get(element);
            if (tags != null) {
                tombstones.addAll(tags);
                elements.remove(element);
            }
        }

        Set<E> value() {
            Set<E> result = new HashSet<>();
            for (Map.Entry<E, Set<String>> entry : elements.entrySet()) {
                Set<String> liveTags = new HashSet<>(entry.getValue());
                liveTags.removeAll(tombstones);
                if (!liveTags.isEmpty()) result.add(entry.getKey());
            }
            return result;
        }

        void merge(ORSet<E> other) {
            // Add all elements from other that are not in our tombstones
            for (Map.Entry<E, Set<String>> entry : other.elements.entrySet()) {
                Set<String> tags = elements.computeIfAbsent(entry.getKey(), k -> new HashSet<>());
                for (String tag : entry.getValue()) {
                    if (!tombstones.contains(tag)) tags.add(tag);
                }
            }
            tombstones.addAll(other.tombstones);
            // Remove tombstoned tags from elements
            for (Set<String> tags : elements.values()) {
                tags.removeAll(tombstones);
            }
            elements.entrySet().removeIf(e -> e.getValue().isEmpty());
        }
    }

    // LWW-Map: Last-Writer-Wins map for document fields
    static class LWWMap {
        private final Map<String, String> values = new HashMap<>();
        private final Map<String, Long> timestamps = new HashMap<>();

        void put(String key, String value, long timestamp) {
            Long existing = timestamps.get(key);
            if (existing == null || timestamp > existing) {
                values.put(key, value);
                timestamps.put(key, timestamp);
            }
        }

        String get(String key) { return values.get(key); }

        void merge(LWWMap other) {
            for (String key : other.values.keySet()) {
                put(key, other.values.get(key), other.timestamps.get(key));
            }
        }

        Map<String, String> value() { return Collections.unmodifiableMap(values); }
    }
}
```
**Time:** O(n) for merge, O(1) for add. **Space:** O(n * tags).
**Real-world:** **Automerge** and **Yjs** implement CRDT documents for real-time collaboration.

---

**P13.55 [H] Implement a Raft-Based Replicated State Machine**

Full replicated state machine with client request handling, log replication, and consistent reads.

```java
import java.util.*;

public class P13_55_ReplicatedStateMachine {

    static class RSMCluster {
        final List<RaftNode> nodes;
        final int clusterSize;

        RSMCluster(int size) {
            this.clusterSize = size;
            this.nodes = new ArrayList<>();
            for (int i = 0; i < size; i++) {
                nodes.add(new RaftNode(i, size));
            }
        }

        /** Elect a leader (simplified: node 0 wins if alive). */
        RaftNode electLeader() {
            RaftNode leader = nodes.get(0);
            leader.becomeLeader();
            return leader;
        }

        /** Client write: go through leader, replicate to majority. */
        boolean clientWrite(String command) {
            RaftNode leader = null;
            for (RaftNode n : nodes) {
                if (n.getState() == RaftNode.State.LEADER) {
                    leader = n;
                    break;
                }
            }
            if (leader == null) return false;

            // Append to leader's log
            int logIndex = leader.appendEntry(command);

            // Replicate to followers (simplified: synchronous)
            int acks = 1; // leader counts
            RaftNode.AppendEntriesRequest req = new RaftNode.AppendEntriesRequest();
            req.term = leader.getCurrentTerm();
            req.leaderId = 0;
            req.prevLogIndex = logIndex - 1;
            req.prevLogTerm = leader.getTermAt(logIndex - 1);
            req.entries = List.of(leader.getEntry(logIndex));
            req.leaderCommit = logIndex - 1;

            for (int i = 1; i < clusterSize; i++) {
                RaftNode.AppendEntriesResponse resp = nodes.get(i).handleAppendEntries(req);
                if (resp.success) acks++;
            }

            // Commit if majority acked
            return acks > clusterSize / 2;
        }

        /** Client read: read from leader for linearizability. */
        String clientRead(String key) {
            for (RaftNode n : nodes) {
                if (n.getState() == RaftNode.State.LEADER) {
                    return n.get(key);
                }
            }
            return null;
        }
    }
}
```
**Time:** O(n) per client request (replicate to all nodes). **Space:** O(L * n) where L = log size, n = cluster size.
**Real-world:** **etcd**, **CockroachDB**, **TiKV** all implement Raft-based replicated state machines.

---

## 13.8 Key Takeaways

1. **CFS is a red-black tree problem.** The Linux scheduler picks the task with the smallest virtual runtime using `rb_leftmost`. TreeMap models this perfectly, though it lacks the O(1) leftmost cache that the kernel implementation maintains.

2. **Memory allocators are tree and list problems.** The buddy allocator is a binary tree of power-of-2 blocks (O(log n) alloc/free). The slab allocator is an object pool (O(1) amortized). Free lists are linked lists with different fitting strategies (first-fit, best-fit, worst-fit) that trade search time against fragmentation.

3. **Page replacement algorithms are eviction policy problems.** LRU maps to LinkedHashMap (O(1)), Clock approximates LRU with a circular array and reference bit (O(1) amortized), FIFO is a simple queue (O(1)), and LFU requires frequency tracking. The same algorithms appear in CPU caches, TLBs, database buffer pools, and application-level caches.

4. **Raft is an append-only log plus state machine.** The log (ArrayList) provides ordering. AppendEntries replicates entries. Leader election uses majority voting. The safety guarantee comes from the log matching invariant: if two logs contain an entry with the same index and term, they are identical up to that point.

5. **Vector clocks trade space for causality.** An int[] of size N (number of processes) captures the full causal history. The element-wise max merge is the key operation. They degrade for large N -- use version vectors or hybrid logical clocks in practice.

6. **Gossip protocols converge in O(log n) rounds.** The epidemic spreading model means information reaches all nodes exponentially fast. The tradeoff is eventual consistency -- there is a window where nodes have different views. Fanout and frequency control the convergence speed.

7. **CRDTs guarantee convergence by mathematical construction.** G-Counter (int[] per replica, merge = element-wise max), PN-Counter (two G-Counters), G-Set (union merge), and LWW-Register (timestamp-based) are the building blocks for conflict-free replication. The key insight: merge must be commutative, associative, and idempotent.

8. **Merkle trees enable O(log n) difference detection.** Compare root hashes to check equality in O(1). Recurse into subtrees only where hashes differ. This is why `git diff`, Bitcoin SPV, and Cassandra anti-entropy repair are efficient.

9. **Bounded buffers are the foundation of message queues.** ArrayBlockingQueue (circular array + lock + conditions) is the building block. Kafka extends this with append-only logs, partitions, and consumer offsets. Dead letter queues handle poison messages.

10. **Every resilience pattern is a data structure pattern.** Circuit breakers use ring buffers (sliding window of results). Rate limiters use token counters or timestamp deques. Distributed locks use maps with TTLs and fencing tokens. The data structure choice determines the pattern's performance characteristics.

---

## Navigation

| Previous | Index | Next |
|----------|-------|------|
| [Ch 12: Databases & Storage](12-use-cases-databases-storage.md) | [Index](00-index.md) | [Ch 14: Application Domains](14-use-cases-application-domains.md) |

---

*"Every distributed system is a local data structure problem replicated across unreliable networks. Master the local structure, and the distributed design follows."*
