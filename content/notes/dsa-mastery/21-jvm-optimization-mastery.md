# Chapter 21: JVM Optimization Mastery

## The Machine Sympathist's Playbook

Chapter 1 gave you X-ray vision into the JVM — you learned how objects are laid out, how the GC traces them, and why `int[]` crushes `Integer[]`. This chapter goes deeper. Much deeper. We are going to descend into the bit-level layout of object headers, understand exactly how the CPU cache interacts with your data structures, learn what the JIT compiler does behind the curtain, and exploit all of it to write code that runs at the theoretical limits of the hardware.

This is not about micro-optimization for its own sake. This is about understanding why a `ConcurrentHashMap` uses `@Contended` on its counter cells, why the LMAX Disruptor pads its sequences, why crossing 32GB of heap can make your application slower, and why sorting an array before summing it conditionally can be 5-10x faster. When you see a performance anomaly in production, the material in this chapter is what separates "I have no idea" from "I know exactly what is happening."

If Chapter 1 was the foundation, this chapter is the armory.

---

## 21.1 Object Header Deep Dive

We touched on the object header in Chapter 1. Now we are going to examine every bit.

### Mark Word: Full Bit Layout (64-bit HotSpot)

The mark word is 8 bytes (64 bits). Its layout changes depending on the object's state. Here is the complete specification, bit by bit:

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  MARK WORD BIT LAYOUTS (64-bit HotSpot JVM)                                ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  State: UNLOCKED (normal, no lock held)                                      ║
║  ┌───────────────────────────────────────────────────────────────┬──────┐   ║
║  │ unused:25 │ identity_hashcode:31 │ unused:1 │ age:4 │ 0 │ 01  │   ║
║  │ bits 63-39│ bits 38-8            │ bit 7    │bits 6-3│bit2│bits1-0║
║  └───────────────────────────────────────────────────────────────┴──────┘   ║
║  Total: 25 + 31 + 1 + 4 + 1 + 2 = 64 bits                                 ║
║  Lock bits = 01, biased bit = 0 → unlocked                                  ║
║                                                                              ║
║  State: BIASED (JDK < 15 only, deprecated JDK 15, removed JDK 18)          ║
║  ┌───────────────────────────────────────────────────────────────┬──────┐   ║
║  │ thread_id:54          │ epoch:2 │ unused:1 │ age:4 │ 1 │ 01  │   ║
║  │ bits 63-10            │bits 9-8 │ bit 7    │bits 6-3│bit2│bits1-0║
║  └───────────────────────────────────────────────────────────────┴──────┘   ║
║  Lock bits = 01, biased bit = 1 → biased locking mode                       ║
║  thread_id: the JavaThread* that owns the bias                              ║
║  epoch: compared against class's prototype epoch for bulk rebiasing         ║
║                                                                              ║
║  State: THIN LOCK (lightweight locking, uncontended)                        ║
║  ┌───────────────────────────────────────────────────────────────┬──────┐   ║
║  │ pointer_to_lock_record:62                                │ 00  │   ║
║  │ bits 63-2                                                  │bits1-0║
║  └───────────────────────────────────────────────────────────────┴──────┘   ║
║  Lock bits = 00 → thin lock (CAS-based, on locking thread's stack)          ║
║  lock_record: points to a BasicObjectLock on the owning thread's stack      ║
║                                                                              ║
║  State: FAT LOCK (heavyweight monitor, contended)                           ║
║  ┌───────────────────────────────────────────────────────────────┬──────┐   ║
║  │ pointer_to_heavyweight_monitor:62                        │ 10  │   ║
║  │ bits 63-2                                                  │bits1-0║
║  └───────────────────────────────────────────────────────────────┴──────┘   ║
║  Lock bits = 10 → fat lock (ObjectMonitor in native heap)                   ║
║  The ObjectMonitor contains: owner thread, entry count, wait set,           ║
║  cxq (contention queue), recursion count, identity hashcode backup          ║
║                                                                              ║
║  State: GC MARKED (during garbage collection)                               ║
║  ┌───────────────────────────────────────────────────────────────┬──────┐   ║
║  │ forwarding_address:62 (or GC-specific data)              │ 11  │   ║
║  │ bits 63-2                                                  │bits1-0║
║  └───────────────────────────────────────────────────────────────┴──────┘   ║
║  Lock bits = 11 → marked for GC                                             ║
║  Used during compaction: stores the address where the object will be moved  ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

Let me walk through why each state exists and how transitions happen.

### Unlocked State

This is the default state for a newly created object (on JDK 15+ where biased locking is disabled). The identity hash code field is initially all zeros — it is only populated when `System.identityHashCode()` or the default `Object.hashCode()` is called for the first time. This is called *lazy identity hash computation*.

Once the identity hash is written, it occupies 31 bits of the mark word permanently. This has a critical consequence: those 31 bits are in the same position where biased locking would store a thread ID. So an object that has had its identity hash computed can never be biased. This is why calling `System.identityHashCode()` on a lock object is a subtle performance hazard in pre-JDK 15 code.

The 31-bit hash means `System.identityHashCode()` returns values in the range [0, 2^31 - 1]. It is computed using a per-thread Marsaglia xor-shift PRNG (not the object's address, despite the name "identity" hash code).

### Biased Locking: What It Was, Why It Died

Biased locking was an optimization based on the observation that most locks in Java are uncontended — only one thread ever acquires them. The idea: when a thread first acquires a lock, "bias" the object to that thread by writing the thread's ID into the mark word. On subsequent acquisitions by the same thread, no atomic CAS operation is needed — just a check that the stored thread ID matches the current thread.

```
Biased Locking State Machine (JDK < 15):

  new Object()
      │
      ▼
  [Anonymously Biased]  ← mark word has biased=1 but no thread ID
      │
      │ First synchronized(obj) by Thread-A
      ▼
  [Biased to Thread-A]  ← thread_id = A, no CAS needed
      │
      │ Thread-A synchronizes again → just compare thread IDs → instant
      │
      │ Thread-B tries to synchronize → REVOCATION
      │   1. VM safepoint (stop-the-world!)
      │   2. Walk Thread-A's stack for lock records
      │   3. If Thread-A still holds the lock → inflate to thin/fat lock
      │   4. If Thread-A released it → rebias to Thread-B or revoke entirely
      ▼
  [Thin Lock or Revoked]
```

The problem: bias revocation requires a safepoint — a stop-the-world pause that halts all application threads. In modern applications with thread pools, container startup, and dynamic class loading, revocations happened frequently. The JEP 374 analysis found that the overhead of maintaining biased locking infrastructure (safepoints, revocation logic, bulk rebiasing) exceeded the benefit for most workloads.

**Removed in JDK 18** (JEP 374). On JDK 15-17, it is disabled by default but can be re-enabled with `-XX:+UseBiasedLocking`. On JDK 18+, the code is gone entirely. If you see biased locking flags in a JDK 18+ JVM, they are silently ignored.

Modern replacement: HotSpot now uses a more efficient thin-lock implementation that makes uncontended lock acquisition nearly as fast as biased locking (one CAS vs zero CAS — the difference is ~1-2ns on modern hardware).

### Thin Lock Mechanics

When a thread enters a `synchronized` block on an unlocked object:

1. The JVM allocates a *lock record* on the locking thread's stack frame
2. It copies the current mark word into the lock record (displaced header)
3. It attempts a CAS: `markWord.compareAndSwap(currentValue, pointerToLockRecord)`
4. If the CAS succeeds, the lock bits become `00` and the mark word points to the stack lock record
5. On unlock, CAS the displaced header back into the mark word

This is fast because:
- No kernel involvement (entirely user-space)
- The lock record is on the stack (already in L1 cache)
- Uncontended CAS on modern x86 takes ~10-20ns

### Fat Lock Inflation

If a second thread tries to acquire a thin lock held by the first thread:

1. The CAS fails (mark word already points to Thread-A's lock record)
2. The JVM *inflates* the lock: allocates an `ObjectMonitor` in native memory
3. The mark word is updated to point to the `ObjectMonitor` with lock bits `10`
4. The waiting thread parks (kernel-level sleep via `futex` on Linux, `pthread_mutex` on macOS)
5. On release, the owner signals the monitor, which wakes a waiting thread

Fat locks are expensive because they involve kernel transitions (park/unpark). This is why `java.util.concurrent` locks (`ReentrantLock`, `StampedLock`) are preferred for contended scenarios — they use CLH queues with spinning before parking, which avoids kernel transitions for short wait times.

### GC Mark State

During garbage collection, the mark word is overwritten with GC-specific data:
- **Copying collectors** (Serial, Parallel, G1 young gen): store the forwarding address (where the object was copied to in the to-space)
- **Mark-sweep-compact** (G1 old gen): use the mark bits to track liveness
- **ZGC/Shenandoah**: use colored pointers instead of the mark word, so they do not need to modify the object header at all (this is a key advantage — no header contention during concurrent marking)

After GC, the original mark word is restored. During the brief period when the mark word is overwritten, if another thread tries to lock the object, the JVM must coordinate through the GC's safepoint or load barrier mechanism.

### Klass Pointer and Compressed Class Space

The 4-byte klass pointer (with compressed class pointers enabled) points into the *compressed class space* — a contiguous region of native memory allocated at JVM startup.

```
Metaspace Layout:
┌────────────────────────────────────────────────────────┐
│                    Native Memory                        │
│                                                         │
│  ┌──────────────────────────┐  ┌─────────────────────┐ │
│  │  Compressed Class Space  │  │   Non-Class          │ │
│  │  (fixed size, default    │  │   Metaspace          │ │
│  │   1 GB, contiguous)      │  │   (grows dynamically)│ │
│  │                          │  │                      │ │
│  │  Klass structures:       │  │  Method metadata     │ │
│  │  - vtable                │  │  Constant pool       │ │
│  │  - itable                │  │  Annotations         │ │
│  │  - field layout info     │  │  Bytecode            │ │
│  │  - superclass pointer    │  │                      │ │
│  └──────────────────────────┘  └─────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

The compressed class pointer works like compressed OOPs:

```
actual_klass_address = compressed_class_base + (compressed_klass_pointer << 3)
```

The compressed class base is the start address of the compressed class space. The shift is 3 bits (because klass structures are 8-byte aligned). With 32-bit compressed pointers, this addresses 2^32 * 8 = 32GB of class space — far more than the 1GB default.

You can tune this with:
- `-XX:CompressedClassSpaceSize=512m` — shrink if you have few classes
- Compressed class pointers require compressed OOPs to be enabled
- On JDK 15+, compressed class pointers can be enabled independently of compressed OOPs with Lilliput experimental features

---

## 21.2 Compressed OOPs: The 32GB Threshold

Chapter 1 introduced compressed OOPs. Now we go into the full mechanics.

### How Compression Works

On a 64-bit JVM, every object reference is normally 8 bytes. Compressed OOPs reduce this to 4 bytes through bit-shifting.

```
Encoding (storing a reference):
  compressed = actual_address >> shift

Decoding (reading a reference):
  actual_address = compressed_base + (compressed << shift)

Default shift = 3 (because objects are 8-byte aligned)
  → 4 bytes can address 2^32 × 8 = 34,359,738,368 bytes ≈ 32 GB
```

There are three modes of compressed OOPs:

```
Mode 1: Zero-Based (heap starts at address 0, or can be mapped to 0)
  actual_address = compressed << 3
  No base addition needed → fastest decode (single shift instruction)
  Works when the OS maps the heap starting at virtual address 0
  JVM attempts this first

Mode 2: Zero-Based with Non-Zero Start
  actual_address = heap_base + (compressed << 3)
  One addition + one shift
  Used when heap cannot be mapped at address 0 but heap_base
  can be encoded in a single instruction

Mode 3: Heap-Base-Relative (general case)
  actual_address = heap_base + (compressed << 3)
  Same formula, but heap_base may require a register load
  Slightly slower due to register pressure
  Used when the OS cannot map heap at a convenient address
```

You can check which mode your JVM uses:

```bash
java -XX:+UnlockDiagnosticVMOptions -XX:+PrintCompressedOopsMode -version

# Output examples:
# "heap address: 0x0000000000000000, size: 8192 MB, Compressed Oops mode: 32-bit"
#   → Zero-based, best case
# "heap address: 0x0000000700000000, size: 31744 MB, Compressed Oops mode: Zero based"
#   → Zero-based with offset
# "Compressed Oops mode: Non-zero disjoint base"
#   → Heap-base-relative, slowest compressed mode
```

### Why 32GB Is a Cliff, Not a Slope

When heap exceeds the compressed OOP addressable range, the JVM disables compression entirely. Every reference field jumps from 4 to 8 bytes. Here is what that looks like for a `HashMap.Node`:

```
HashMap.Node with Compressed OOPs (heap <= 32 GB):
  ┌─────────────────────────────┐
  │ mark word        8 bytes    │
  │ klass pointer    4 bytes    │ (compressed)
  │ int hash         4 bytes    │
  │ ref key          4 bytes    │ (compressed)
  │ ref value        4 bytes    │ (compressed)
  │ ref next         4 bytes    │ (compressed)
  │ padding          4 bytes    │
  │ TOTAL:          32 bytes    │
  └─────────────────────────────┘

HashMap.Node WITHOUT Compressed OOPs (heap > 32 GB):
  ┌─────────────────────────────┐
  │ mark word        8 bytes    │
  │ klass pointer    8 bytes    │ (uncompressed)
  │ int hash         4 bytes    │
  │ padding          4 bytes    │ (align next field to 8)
  │ ref key          8 bytes    │ (uncompressed)
  │ ref value        8 bytes    │ (uncompressed)
  │ ref next         8 bytes    │ (uncompressed)
  │ TOTAL:          48 bytes    │
  └─────────────────────────────┘
```

That is a 50% increase per Node. For 10 million HashMap entries, this is 160 MB of additional overhead. And the array table (`Node[]`) itself also inflates — each slot goes from 4 to 8 bytes, so a 16M-slot table goes from 64 MB to 128 MB.

The practical consequence: a 33 GB heap can hold *fewer* objects than a 31 GB heap.

```
Scenario: Application uses 31 GB heap with compressed OOPs
  Available for objects: 31 GB
  Reference size: 4 bytes
  Effective capacity: baseline

Scenario: Application uses 33 GB heap without compressed OOPs
  Available for objects: 33 GB
  But reference sizes doubled → objects are 30-50% larger
  Effective capacity: 33 / 1.4 ≈ 23.6 GB equivalent
  NET LOSS: ~7 GB of effective capacity despite 2 GB more heap
```

### Stretching Beyond 32GB with Object Alignment

You can increase the compressed OOP range by changing the object alignment:

```bash
# Default: 8-byte alignment, shift=3, max heap = 32 GB
java -Xmx32g -XX:ObjectAlignmentInBytes=8

# 16-byte alignment, shift=4, max heap = 64 GB
java -Xmx60g -XX:ObjectAlignmentInBytes=16

# 32-byte alignment, shift=5, max heap = 128 GB
java -Xmx120g -XX:ObjectAlignmentInBytes=32
```

The tradeoff: every object is padded to the alignment boundary. With 16-byte alignment:
- An object that naturally fits in 17 bytes gets padded to 32 bytes (15 bytes wasted)
- Small objects (Boolean, Byte, Short wrappers) go from 16 bytes to 32 bytes — 100% overhead

This is only worth it when you have a heap-dominated application with large objects (arrays, buffers) where the padding overhead is small relative to the payload. For applications with millions of small objects, 16-byte alignment can make performance worse than disabling compressed OOPs entirely.

**Rule of thumb**: Stay under 32 GB. If you need more, use off-heap memory (Section 21.13) rather than inflating alignment. If off-heap is not an option, benchmark both 16-byte alignment and uncompressed OOPs and pick whichever your workload prefers.

---

## 21.3 Cache Line Optimization

The CPU cache is the single most important performance factor for data-intensive code. Understanding it transforms how you think about data structures.

### The Cache Hierarchy

```
┌──────────────────────────────────────────────────────────────┐
│                        CPU Core 0                             │
│  ┌──────────┐  ┌──────────┐                                  │
│  │ L1-I     │  │ L1-D     │  ← 32-64 KB each, ~1ns / 4 cycles│
│  │ (instr)  │  │ (data)   │    split instruction/data cache   │
│  └────┬─────┘  └────┬─────┘                                  │
│       └──────┬───────┘                                        │
│              ▼                                                │
│  ┌──────────────────┐                                        │
│  │   L2 (unified)    │  ← 256KB-1MB, ~3-5ns / 12 cycles     │
│  └────────┬─────────┘                                        │
└───────────┼──────────────────────────────────────────────────┘
            ▼
┌──────────────────────┐
│  L3 (shared, all     │  ← 8-64 MB, ~10-20ns / 40 cycles
│  cores)              │    inclusive or exclusive depending on arch
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  Main Memory (DRAM)  │  ← ~60-100ns / 200+ cycles
└──────────────────────┘
```

Key facts on modern Intel/AMD x86:
- **Cache line size: 64 bytes** (this is THE number to memorize)
- L1 associativity: 8-way (8 cache lines per set)
- Hardware prefetcher: detects sequential and strided access, fetches ahead
- Prefetch distance: typically 2-4 cache lines ahead for sequential access
- Write-back policy: modified cache lines are written to L2/L3 lazily (not immediately)

### Spatial Locality: Arrays Win

When you read `array[0]`, the CPU loads the entire 64-byte cache line containing `array[0]`. For an `int[]`, that is 16 consecutive ints. Accessing `array[1]` through `array[15]` are all L1 cache hits — essentially free (~1 cycle each).

```
int[] array = new int[1_000_000];

Reading array[0]:
  CPU loads cache line at address (array_base & ~63)
  Cache line contains: array[0] through array[15]
  Cost: ~100ns (main memory miss on first access)

Reading array[1]:
  Already in L1 cache!
  Cost: ~1ns

Reading array[16]:
  New cache line needed, but hardware prefetcher anticipated this
  Likely already fetched into L1/L2
  Cost: ~3-5ns (L2 hit from prefetch)

Sequential int[] traversal: ~0.25 ns per element (4 bytes / cycle at 4 GHz)
```

Compare with a linked list:

```
LinkedList<Integer> list = /* 1,000,000 elements */

Reading first node:
  Follow head pointer → Node object somewhere on heap
  Node object: [mark|klass|item_ref|next_ref|prev_ref]
  CPU loads 64-byte cache line containing this Node
  Cost: ~100ns (cache miss — node is at an unpredictable address)

Reading next node:
  Follow node.next pointer → another Node somewhere else on heap
  Likely NOT in any cache (nodes are scattered across heap)
  Cost: ~100ns (another cache miss)

LinkedList traversal: ~100 ns per element
  → 400x slower than int[] for sequential access
  → Even Integer[] with scattered Integer objects: ~50-100ns per element
```

This is not a theoretical number. Let me give you a concrete benchmark.

```java
// JMH benchmark: sequential traversal
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.MILLISECONDS)
@State(Scope.Thread)
public class TraversalBenchmark {
    private static final int N = 1_000_000;
    private int[] intArray;
    private ArrayList<Integer> arrayList;
    private LinkedList<Integer> linkedList;

    @Setup
    public void setup() {
        intArray = new int[N];
        arrayList = new ArrayList<>(N);
        linkedList = new LinkedList<>();
        Random rng = new Random(42);
        for (int i = 0; i < N; i++) {
            int val = rng.nextInt();
            intArray[i] = val;
            arrayList.add(val);
            linkedList.add(val);
        }
    }

    @Benchmark
    public long sumIntArray() {
        long sum = 0;
        for (int i = 0; i < intArray.length; i++) {
            sum += intArray[i];
        }
        return sum;
    }

    @Benchmark
    public long sumArrayList() {
        long sum = 0;
        for (int i = 0; i < arrayList.size(); i++) {
            sum += arrayList.get(i);    // unboxing + pointer chase to Integer
        }
        return sum;
    }

    @Benchmark
    public long sumLinkedList() {
        long sum = 0;
        for (Integer val : linkedList) {
            sum += val;   // pointer chase to Node, then to Integer
        }
        return sum;
    }
}

// Typical results on Intel i7, JDK 17:
// sumIntArray:    0.3 ms   (sequential cache-line reads, SIMD auto-vectorization)
// sumArrayList:   3.1 ms   (pointer chase to Integer objects, ~10x slower)
// sumLinkedList: 14.7 ms   (double pointer chase per element, ~49x slower)
```

### Temporal Locality: Keep Hot Data Hot

Temporal locality means recently accessed data is likely to be accessed again soon. The cache exploits this by keeping recently accessed lines in L1.

**Implication for algorithms**: If you need to access a data structure repeatedly in a tight loop, keep it small enough to fit in L1 (32-64 KB) or L2 (256KB-1MB). A working set that fits in L1 will run 10-50x faster than one that spills to L3 or main memory.

```
Working set size vs throughput:

  < 32 KB:  L1 speed   (~4 GB/s per core, single-cycle latency)
  < 256 KB: L2 speed   (~2 GB/s per core, ~5 cycle latency)
  < 8 MB:   L3 speed   (~1 GB/s per core, ~40 cycle latency)
  > 8 MB:   DRAM speed (~0.1-0.3 GB/s per core, ~200 cycle latency)
```

This is why hash table implementations with open addressing (linear probing) that keep entries compact can outperform chained hashing — the probed entries are adjacent in memory and fit in cache.

### Hardware Prefetcher Behavior

Modern CPUs have hardware prefetchers that detect access patterns and fetch cache lines before you need them:

- **Sequential (stream) prefetcher**: Detects sequential reads (stride = 1 cache line) and prefetches 2-4 lines ahead. This is why `int[]` traversal is so fast — the prefetcher runs ahead of your loop.
- **Stride prefetcher**: Detects regular strides (e.g., accessing every 4th cache line). Works for strided array access and `struct`-like patterns.
- **Spatial prefetcher**: Fetches the adjacent cache line (brings both halves of a 128-byte aligned pair).

What defeats the prefetcher:
- Random access (hash table lookups with random keys)
- Pointer chasing (linked lists, tree traversals)
- Access patterns with strides > ~2KB (exceeds stride prefetcher's tracking window)

### `@Contended` Annotation

The `@jdk.internal.vm.annotation.Contended` annotation tells the JVM to add padding around a field or all fields of a class:

```java
// Field-level: pad this specific field
class Example {
    @jdk.internal.vm.annotation.Contended
    volatile long hotCounter;

    int coldField;
}

// Class-level: pad all fields of this class
@jdk.internal.vm.annotation.Contended
class HotCell {
    volatile long value;
}
```

The JVM adds **128 bytes** of padding (not 64!) — 64 bytes before and 64 bytes after. Why 128 and not 64? Because the spatial prefetcher fetches adjacent cache lines in pairs. Two fields 64 bytes apart but in the same 128-byte aligned region can still interfere. The 128-byte padding ensures they land in completely independent prefetch regions.

**Requirements**:
- JDK 8: `-XX:-RestrictContended` to allow use outside `java.base` module
- JDK 9+: must open the internal API or use `--add-exports`
- Or use it in JDK internal code (ConcurrentHashMap, LongAdder already do)

```java
// How ConcurrentHashMap uses @Contended internally:
// (from java.util.concurrent.ConcurrentHashMap)
@jdk.internal.vm.annotation.Contended
static final class CounterCell {
    volatile long value;
    CounterCell(long x) { value = x; }
}
// Each CounterCell is on its own cache line (+ padding)
// Multiple threads can update different cells without false sharing
```

---

## 21.4 False Sharing: The Silent Performance Killer

False sharing is one of the most insidious performance problems in concurrent Java code. It is invisible in profilers (no locks, no contention in the traditional sense) and can cause 10-50x slowdowns.

### The Mechanism

When two threads write to different variables that reside on the same 64-byte cache line, the MESI protocol (or its variants — MOESI, MESIF) forces cache line invalidation:

```
Core 0                              Core 1
┌──────────────┐                    ┌──────────────┐
│ L1 Cache     │                    │ L1 Cache     │
│ ┌──────────┐ │                    │ ┌──────────┐ │
│ │cache line │ │  ← INVALIDATE ←   │ │cache line │ │
│ │[A][B]     │ │                    │ │[A][B]     │ │
│ └──────────┘ │                    │ └──────────┘ │
└──────────────┘                    └──────────────┘
   Thread 0                            Thread 1
   writes A                            writes B

Step 1: Thread 0 writes variable A
  → Core 0's cache line is Modified (M state)
  → Core 1's copy is Invalidated (I state)

Step 2: Thread 1 wants to write variable B (SAME cache line!)
  → Core 1 must fetch the updated cache line from Core 0's L1
  → This requires a cache-to-cache transfer via L3 (~40-70 cycles)
  → Core 1's cache line becomes Modified
  → Core 0's copy is Invalidated

Step 3: Thread 0 wants to write A again
  → Core 0 must fetch from Core 1
  → Another cache-to-cache transfer

This "ping-pong" repeats on EVERY write, regardless of the fact
that the threads are writing to DIFFERENT variables.
```

### Detailed Benchmark

```java
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
@State(Scope.Group)
@Fork(3)
@Warmup(iterations = 5, time = 1)
@Measurement(iterations = 5, time = 1)
public class FalseSharingBenchmark {

    // BAD: Both fields on the same cache line (within 64 bytes)
    static class SharedLine {
        volatile long counter1;
        volatile long counter2;
    }

    // GOOD: Fields on separate cache lines (manual padding)
    static class PaddedLine {
        volatile long counter1;
        long p1, p2, p3, p4, p5, p6, p7;  // 56 bytes padding
        volatile long counter2;
    }

    // GOOD: Using @Contended
    static class ContendedLine {
        @jdk.internal.vm.annotation.Contended("group1")
        volatile long counter1;
        @jdk.internal.vm.annotation.Contended("group2")
        volatile long counter2;
    }

    private SharedLine shared = new SharedLine();
    private PaddedLine padded = new PaddedLine();

    @Benchmark
    @Group("shared")
    @GroupThreads(1)
    public void sharedWrite1() {
        shared.counter1++;
    }

    @Benchmark
    @Group("shared")
    @GroupThreads(1)
    public void sharedWrite2() {
        shared.counter2++;
    }

    @Benchmark
    @Group("padded")
    @GroupThreads(1)
    public void paddedWrite1() {
        padded.counter1++;
    }

    @Benchmark
    @Group("padded")
    @GroupThreads(1)
    public void paddedWrite2() {
        padded.counter2++;
    }
}

// Typical results (Intel i7-12700, JDK 17):
//
// Benchmark               Mode  Cnt    Score    Error  Units
// shared.sharedWrite1     avgt   15   45.2 ±   2.1   ns/op  ← FALSE SHARING
// shared.sharedWrite2     avgt   15   44.8 ±   1.9   ns/op  ← FALSE SHARING
// padded.paddedWrite1     avgt   15    3.1 ±   0.2   ns/op  ← NO FALSE SHARING
// padded.paddedWrite2     avgt   15    3.0 ±   0.1   ns/op  ← NO FALSE SHARING
//
// The false-sharing version is ~15x slower per operation!
```

### Three Fixes for False Sharing

**Fix 1: Manual padding**

```java
class Counters {
    volatile long counter1;
    long p1, p2, p3, p4, p5, p6, p7;  // 7 longs = 56 bytes
    volatile long counter2;
}
// counter1 at offset ~16, counter2 at offset ~80 → different cache lines
// Note: the JVM may reorder fields. Use 7 padding fields to be safe.
```

**Fix 2: `LongAdder` / `LongAccumulator`**

```java
LongAdder counter1 = new LongAdder();
LongAdder counter2 = new LongAdder();

// LongAdder internally uses a Cell[] array
// Each Cell is @Contended, so cells are on separate cache lines
// Multiple threads hash to different cells, minimizing contention
// counter1.increment() → updates a per-thread cell
// counter1.sum() → sums all cells (eventual consistency)
```

`LongAdder` is ideal when writes vastly outnumber reads. It trades read cost (must sum all cells) for write throughput (no false sharing, no CAS contention).

**Fix 3: `@Contended` annotation**

```java
class Counters {
    @jdk.internal.vm.annotation.Contended
    volatile long counter1;

    @jdk.internal.vm.annotation.Contended
    volatile long counter2;
}
// JVM adds 128 bytes of padding around each @Contended field
// Most robust solution, but requires JVM flag: -XX:-RestrictContended
```

### Real-World False Sharing: ConcurrentHashMap

`ConcurrentHashMap` uses a `CounterCell` array to track size without a global atomic counter. Each `CounterCell` is `@Contended`:

```java
// From ConcurrentHashMap source (simplified):
@Contended
static final class CounterCell {
    volatile long value;
    CounterCell(long x) { value = x; }
}

// Size tracking:
// Instead of a single AtomicLong (would be a contention hotspot),
// CHM maintains an array of CounterCell objects.
// Each thread hashes to a cell and updates that cell.
// size() sums all cells.
//
// Without @Contended, adjacent CounterCells would false-share,
// defeating the purpose of the striped design.
```

### Real-World False Sharing: LMAX Disruptor

The LMAX Disruptor pads its `Sequence` class (equivalent to an atomic long counter):

```java
// Simplified from LMAX Disruptor source:
class LhsPadding {
    long p1, p2, p3, p4, p5, p6, p7;
}

class Value extends LhsPadding {
    volatile long value;
}

class RhsPadding extends Value {
    long p9, p10, p11, p12, p13, p14, p15;
}

public class Sequence extends RhsPadding {
    // The volatile long `value` is sandwiched between
    // 7 longs of left padding and 7 longs of right padding
    // Total padding: 112 bytes → value is on its own cache line
}
```

Why inheritance rather than fields in one class? Because the JVM's field reordering rules apply per class in the hierarchy. Padding fields in a superclass are laid out before subclass fields. This guarantees the padding arrangement survives JVM field reordering.

---

## 21.5 Escape Analysis Deep Dive

Escape analysis is the JIT's most powerful optimization enabler. It determines whether an object's lifetime is confined to a single method (or thread), enabling three subsequent optimizations.

### The Three Optimizations

**1. Scalar Replacement**

The JIT decomposes the object into its constituent fields and stores them as local variables (scalars) in registers or on the stack.

```java
public double distance(double x1, double y1, double x2, double y2) {
    // Before escape analysis:
    Point p1 = new Point(x1, y1);  // allocates on heap
    Point p2 = new Point(x2, y2);  // allocates on heap
    double dx = p2.x - p1.x;
    double dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
}

// After escape analysis + scalar replacement:
// p1 and p2 do not escape. The JIT replaces them:
public double distance(double x1, double y1, double x2, double y2) {
    // No allocation! Fields become local variables:
    // double p1_x = x1, p1_y = y1, p2_x = x2, p2_y = y2;
    double dx = x2 - x1;
    double dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
}
```

**2. Stack Allocation**

If an object does not escape the method but cannot be scalar-replaced (e.g., it is too large or its fields are accessed through array indexing), the JIT can allocate it on the thread's stack instead of the heap. Stack allocation means:
- No TLAB pointer bump (even faster)
- No GC involvement (the object is deallocated when the method returns)
- Guaranteed L1 cache locality (stack is always hot in cache)

Note: In HotSpot, true stack allocation is rare. Scalar replacement is strongly preferred. Graal compiler does more stack allocation than C2.

**3. Lock Elision**

If a `synchronized` block operates on a non-escaping object, the lock is meaningless (no other thread can see the object). The JIT removes the lock entirely.

```java
public String buildMessage(int code) {
    StringBuffer sb = new StringBuffer();  // StringBuffer is synchronized
    sb.append("Error: ");
    sb.append(code);
    return sb.toString();
}

// After escape analysis:
// The StringBuffer does not escape (it is created and consumed locally).
// All synchronization on sb is removed (lock elision).
// The StringBuffer may be scalar-replaced into its internal char[]/byte[].
// Effective compiled code is equivalent to simple string concatenation.
```

### What Defeats Escape Analysis

Understanding what prevents escape analysis is critical. If any of these conditions hold, the object "escapes" and must be heap-allocated:

**1. Stored in an array element**

```java
Object[] holder = new Object[1];
Point p = new Point(1, 2);
holder[0] = p;  // p escapes — the JIT cannot prove holder's scope
// Even if holder itself does not escape, array element stores
// are conservatively treated as escaping in HotSpot's C2 compiler
```

**2. Passed to a method that is not inlined**

```java
Point p = new Point(1, 2);
processPoint(p);  // If processPoint is not inlined, p escapes

// Why? The JIT cannot see inside non-inlined methods.
// It must assume the method might store p in a field or static variable.
```

**3. Stored in an instance or static field**

```java
class Holder {
    Point cached;
    void store(int x, int y) {
        cached = new Point(x, y);  // escapes — stored in instance field
    }
}
```

**4. Megamorphic call sites**

```java
interface Shape { double area(); }
// If there are 3+ Shape implementations seen at this call site:
Shape s = createShape();  // megamorphic — JIT cannot inline
s.area();                 // virtual dispatch, no inlining
// → s is not scalar-replaceable because its type is unknown
```

**5. Object too large**

The JIT has a limit on the size of objects it will scalar-replace. Very large objects (exact threshold is JVM-internal, roughly ~64 fields or ~512 bytes) will not be decomposed.

### Verifying Escape Analysis

```bash
# Show which allocations are eliminated (JDK 8-11):
java -XX:+PrintEscapeAnalysis -XX:+PrintEliminateAllocations MyApp

# JDK 17+ (unified logging):
java -Xlog:jit+escape=debug MyApp

# In JMH, verify no allocation with -prof gc:
# If "gc.alloc.rate.norm" is 0 bytes/op, escape analysis eliminated everything
```

**Important**: Escape analysis only works on JIT-compiled code. Interpreted code (first ~10,000 invocations) always heap-allocates. This is why microbenchmarks without proper warmup show incorrect allocation behavior — they measure the interpreter, not the JIT.

---

## 21.6 JIT Compilation

The Just-In-Time compiler is the reason Java can match (and sometimes exceed) C++ performance. Understanding its mechanics lets you write code the JIT loves.

### Two Compilers: C1 and C2

HotSpot has two JIT compilers:

```
C1 (Client Compiler):
  - Fast compilation (~1ms per method)
  - Simple optimizations: inlining, constant folding, null check elimination
  - Generates decent code quickly
  - Used for methods at "warm" level (tier 1-3)

C2 (Server Compiler):
  - Slow compilation (~10-100ms per method)
  - Aggressive optimizations: loop unrolling, vectorization, escape analysis,
    range check elimination, dead code elimination, strength reduction
  - Generates highly optimized native code
  - Used for methods at "hot" level (tier 4)

Graal (optional, JDK 17+ via GraalVM):
  - Written in Java (easier to maintain and extend than C2 which is C++)
  - Competitive with C2, better in some cases (partial escape analysis)
  - Used as a drop-in C2 replacement
```

### Tiered Compilation (Default Since JDK 8)

Tiered compilation uses both C1 and C2 in stages:

```
Method Execution Lifecycle:

  [Interpreter] → [C1 Level 1] → [C1 Level 2] → [C1 Level 3] → [C2 Level 4]
       │              │               │               │               │
       │         Quick compile    + counters      + profiling     Full optimize
       │         No profiling     Basic profile    Full profile    Best code
       │              │               │               │               │
       │         Invocations:    Invocations:    Invocations:    Invocations:
       │            ~100           ~1,000          ~5,000          ~10,000+
       │              │               │               │               │
       └──────────────┴───────────────┴───────────────┘               │
                                                                      │
                           C2 uses profile data from Level 3          │
                           to make optimal compilation decisions       │
                           (devirtualization, branch prediction,       │
                            type specialization)                       │
```

The beauty of tiered compilation: C1 compiles quickly to get past interpreted mode, then C2 compiles the hottest methods with full optimization using profile data collected by C1.

### Compilation Thresholds

```bash
# Key JVM flags:
-XX:Tier3CompileThreshold=2000    # Invocations to trigger C1 full profiling
-XX:Tier4CompileThreshold=15000   # Invocations to trigger C2 compilation

# Legacy (non-tiered):
-XX:CompileThreshold=10000        # Invocations for compilation (C1 or C2)

# View compilations in real-time:
java -XX:+PrintCompilation MyApp
```

`-XX:+PrintCompilation` output format:

```
  timestamp compile_id attributes tier method_name size deopt
  123   456       %        4     com.example.MyClass::hotMethod (120 bytes)

  Attributes:
    %  = On-Stack Replacement (OSR) compilation
    s  = synchronized method
    !  = has exception handler
    b  = blocking compilation (rare)
    n  = native wrapper
```

### On-Stack Replacement (OSR)

What happens when a long-running loop is still in its first invocation? The method has not hit the compilation threshold (based on method invocations), but the loop is clearly hot. OSR handles this:

```java
public void processLargeFile(File file) {
    // This method is called once, but the loop runs millions of times
    try (BufferedReader reader = new BufferedReader(new FileReader(file))) {
        String line;
        while ((line = reader.readLine()) != null) {  // ← hot loop
            processLine(line);
        }
    }
}

// Without OSR: method runs entirely in interpreter (called once → no JIT trigger)
// With OSR: JIT detects the hot loop (via back-edge counter), compiles the loop,
// and REPLACES the currently executing interpreted frame with a compiled frame
// — mid-execution, without restarting the method.
```

OSR is triggered by the back-edge counter — it counts loop iterations (backward jumps in bytecode). When the counter exceeds a threshold, OSR compilation begins.

```
Back-edge counter threshold:
  -XX:OnStackReplacePercentage=140 (default)
  Effective OSR threshold = CompileThreshold × (OnStackReplacePercentage - InterpreterProfilePercentage) / 100
  With defaults: 10000 × (140 - 33) / 100 = 10700 back-edges
```

### Intrinsics

Some methods are so performance-critical that the JIT replaces them with hand-crafted assembly rather than compiling the Java bytecode. These are called *intrinsics*.

```
Important JIT Intrinsics:

Method                          Replacement
──────────────────────────────────────────────────────────────────
Math.min(int, int)              cmov instruction (branchless)
Math.max(int, int)              cmov instruction (branchless)
Math.abs(int)                   CDQ + XOR + SUB (branchless)
Integer.numberOfLeadingZeros()  BSR/LZCNT instruction
Integer.numberOfTrailingZeros() BSF/TZCNT instruction
Integer.bitCount()              POPCNT instruction
Long.reverseBytes()             BSWAP instruction

System.arraycopy()              REP MOVSB/MOVSQ or AVX memcpy
Arrays.fill()                   REP STOSB/STOSQ or AVX memset
String.equals()                 SIMD (SSE4.2/AVX2) string comparison
String.indexOf()                PCMPESTRI (SSE4.2 string search)
Arrays.sort() (for primitives)  Dual-pivot quicksort with handwritten swap logic

Object.hashCode()               Reads mark word directly (no method call)
Thread.currentThread()          Reads thread-local storage directly

Unsafe.compareAndSwapInt()      LOCK CMPXCHG instruction
Unsafe.getIntVolatile()         MOV with memory fence
VarHandle.compareAndSet()       LOCK CMPXCHG instruction

Arrays.equals(byte[], byte[])   AVX2 vectorized comparison (32 bytes at a time)
```

**Why this matters**: When you use `Integer.bitCount()` in a popcount-heavy algorithm, the JIT emits a single POPCNT instruction (~1 cycle). If you wrote the bit-counting loop manually, the JIT would compile it to ~15 instructions. Always prefer JDK library methods that have intrinsic implementations — they are literally free at the CPU level.

### Viewing JIT Decisions

```bash
# Print which methods are compiled and when:
java -XX:+PrintCompilation MyApp

# Print inlining decisions (very verbose):
java -XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining MyApp

# Print generated assembly (requires hsdis plugin):
java -XX:+UnlockDiagnosticVMOptions -XX:+PrintAssembly MyApp

# JMH integration — see JIT output for benchmark methods:
# Run with: -prof perfasm (Linux) or -prof dtraceasm (macOS)
```

---

## 21.7 Inlining: The Mother of All Optimizations

Inlining is the most important JIT optimization — not because it is the most impactful directly, but because it *enables* all other optimizations. Without inlining, the JIT cannot see across method boundaries, and escape analysis, constant folding, dead code elimination, and range check elimination all fail.

### Why Inlining Matters

```java
public long sumList(List<Integer> list) {
    long sum = 0;
    for (int i = 0; i < list.size(); i++) {
        sum += list.get(i);   // virtual call: which get()?
    }
    return sum;
}
```

Without inlining, each call to `list.get(i)` is a virtual dispatch through the vtable. The JIT sees a black box and cannot optimize:
- Cannot eliminate the null check inside `get()`
- Cannot eliminate the bounds check inside `get()`
- Cannot escape-analyze the `Integer` returned by `get()`
- Cannot unroll the loop (iteration count unknown across the call)

With inlining (assuming monomorphic ArrayList):

```java
// After inlining ArrayList.get():
public long sumList(ArrayList<Integer> list) {
    long sum = 0;
    Object[] elementData = list.elementData;  // field access, inlined
    int size = list.size;                      // field access, inlined
    for (int i = 0; i < size; i++) {
        // Bounds check: eliminated (i < size guarantees in-range)
        // Null check on elementData: eliminated (known non-null)
        Integer boxed = (Integer) elementData[i];
        // Unboxing: Integer.intValue() → inlined → direct field read
        sum += boxed.value;
    }
    return sum;
}

// After further optimization:
// - Loop unrolling: process 4 elements per iteration
// - Auto-vectorization: use SIMD to add 4 ints at once (if applicable)
// - The resulting native code is nearly as fast as summing a raw int[]
```

### Monomorphic, Bimorphic, Megamorphic

The JIT's ability to inline depends on how many concrete types it has observed at each call site:

```
Call Site Type     Types Seen    JIT Action                    Performance
────────────────────────────────────────────────────────────────────────────
Monomorphic        1             Devirtualize + inline         Best
Bimorphic          2             Type check + inline both      Good
Megamorphic        3+            Virtual dispatch (vtable)     Worst

Example — Monomorphic:
  // JIT profiling shows: list.get() is ALWAYS ArrayList.get()
  // JIT generates:
  if (list.getClass() != ArrayList.class) { uncommonTrap(); }
  // Inline ArrayList.get() directly
  // The uncommon trap is never taken → branch predictor handles it

Example — Bimorphic:
  // JIT sees: sometimes ArrayList.get(), sometimes CopyOnWriteArrayList.get()
  // JIT generates:
  if (list.getClass() == ArrayList.class) {
      // inlined ArrayList.get()
  } else if (list.getClass() == CopyOnWriteArrayList.class) {
      // inlined CopyOnWriteArrayList.get()
  } else {
      uncommonTrap();  // never seen a third type
  }
  // Two type checks → still fast, but 2x the code size

Example — Megamorphic (3+ types):
  // JIT has seen ArrayList, LinkedList, and CopyOnWriteArrayList
  // JIT gives up on inlining → virtual dispatch via vtable
  // vtable lookup: ~5-10ns overhead per call
  // No inlining → no escape analysis → no range check elimination
  // Dramatically slower in tight loops
```

### The Interface Trap

This is a subtle performance insight that most Java developers miss:

```java
// Code style 1: Programming to the interface
List<Integer> list = new ArrayList<>();
processData(list);

// Code style 2: Programming to the implementation
ArrayList<Integer> list = new ArrayList<>();
processData(list);
```

The Java community correctly advocates "program to the interface" for clean architecture. But there is a hidden performance cost:

```java
void processData(List<Integer> list) {
    for (int i = 0; i < list.size(); i++) {
        // If the JIT only ever sees ArrayList here → monomorphic → inlined
        // If the JIT sees ArrayList AND LinkedList → bimorphic → type checks
        // If 3+ types → megamorphic → no inlining
        doSomething(list.get(i));
    }
}
```

If `processData` is called from many places with different `List` implementations, the call site for `list.get(i)` becomes megamorphic, and inlining breaks down.

**Practical advice**: For public APIs and long-lived code, program to the interface — correctness and maintainability outweigh inline optimization. For hot inner loops in performance-critical paths, the concrete type matters. The JIT will figure it out as long as you are consistent.

### Inlining Thresholds

```bash
# Maximum bytecode size of a method to be inlined (for "cold" calls):
-XX:MaxInlineSize=35

# Maximum bytecode size of a method to be inlined (for "hot" calls,
# i.e., called frequently and profiled as hot):
-XX:FreqInlineSize=325

# Maximum inlining depth (method A inlines B which inlines C...):
-XX:MaxInlineLevel=15

# Maximum total bytecode size after inlining (to prevent code bloat):
-XX:InlineSmallCode=2000

# Disable inlining entirely (for debugging):
-XX:-Inline
```

**35 bytes** is very small. A typical getter method is 5-10 bytes. A method with a few lines of logic is 50-100 bytes. So "cold" methods over 35 bytes are not inlined, even if they are called occasionally.

**325 bytes** is the threshold for "hot" methods — those profiled as frequently executed. Most practical methods that are called in loops will be under this.

If a method is too large to inline, consider splitting it:

```java
// Too large to inline (hypothetical 400 bytes):
public int processRecord(Record r) {
    // 50 lines of validation
    // 30 lines of transformation
    // 20 lines of computation
    return result;
}

// Refactored — hot path is small enough to inline:
public int processRecord(Record r) {
    if (!isValid(r)) return handleInvalid(r);  // cold path, not inlined
    return computeResult(r);  // hot path, 80 bytes, inlined
}
```

---

## 21.8 Branch Prediction

Modern CPUs execute instructions out of order in a pipeline 15-20 stages deep. When a conditional branch is encountered, the CPU must predict which way it goes *before* it knows the condition result. If the prediction is wrong, the entire pipeline must be flushed — wasting 15-20 cycles.

### How Branch Prediction Works

```
CPU Pipeline (simplified, 15 stages):
  Fetch → Decode → Rename → Dispatch → Execute → ... → Commit

When the CPU encounters: if (x > 0) { ... } else { ... }
  1. Predict: "x > 0 is TRUE" (based on history)
  2. Speculatively fetch and execute the TRUE branch
  3. When the actual condition is evaluated:
     - Prediction correct: continue (no penalty)
     - Prediction wrong: flush pipeline (15-20 cycle penalty)

Branch Prediction Hardware:
  - Branch History Table (BHT): tracks whether recent branches were taken
  - Branch Target Buffer (BTB): stores the target address of taken branches
  - Return Stack Buffer: predicts return addresses for function calls
  - Modern predictors (TAGE, Perceptron): use global history patterns
    across multiple branches — accuracy > 97% for regular patterns
```

### The Famous Sorted Array Benchmark

This is one of the most referenced performance demonstrations:

```java
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.MILLISECONDS)
@State(Scope.Thread)
public class BranchPredictionBenchmark {
    private static final int N = 1_000_000;
    private int[] sorted;
    private int[] unsorted;
    private int threshold;

    @Setup
    public void setup() {
        Random rng = new Random(42);
        unsorted = new int[N];
        for (int i = 0; i < N; i++) {
            unsorted[i] = rng.nextInt(256);  // values 0-255
        }
        sorted = unsorted.clone();
        Arrays.sort(sorted);
        threshold = 128;  // half the values pass the condition
    }

    @Benchmark
    public long sumSorted() {
        long sum = 0;
        for (int val : sorted) {
            if (val >= threshold) {  // PREDICTABLE: first half < 128, second half >= 128
                sum += val;
            }
        }
        return sum;
    }

    @Benchmark
    public long sumUnsorted() {
        long sum = 0;
        for (int val : unsorted) {
            if (val >= threshold) {  // UNPREDICTABLE: random pattern
                sum += val;
            }
        }
        return sum;
    }

    @Benchmark
    public long sumBranchless() {
        long sum = 0;
        for (int val : unsorted) {
            // Branchless: no conditional branch at all
            // ~(val - threshold) >> 31 produces 0 when val >= threshold, -1 otherwise
            // But simpler: use Math.max which compiles to cmov
            sum += Math.max(val - threshold, 0) > 0 ? val : 0;
            // Even simpler — the JIT often compiles this to cmov automatically
        }
        return sum;
    }
}

// Results (Intel i7, JDK 17):
// sumSorted:     0.9 ms   ← branch predictor has ~99.9% accuracy
// sumUnsorted:   5.3 ms   ← branch predictor has ~50% accuracy (random)
// sumBranchless: 1.1 ms   ← no branch to predict
//
// sorted is ~6x faster than unsorted — same data, same computation,
// different branch prediction behavior!
```

Why sorted is fast: After sorting, all values less than 128 come first, then all values >= 128. The branch predictor sees a long run of "not taken" followed by a long run of "taken" — it learns the pattern quickly. Mispredictions only happen at the single transition point.

Why unsorted is slow: Each branch direction is essentially random (50/50). The predictor cannot learn a pattern. About 50% of branches are mispredicted, costing ~15 cycles each.

### Branchless Techniques

When branches are unpredictable and performance matters, eliminate them:

```java
// BRANCHING (bad for unpredictable conditions):
int result = (a > b) ? a : b;

// BRANCHLESS — the JIT often compiles Math.max to cmov:
int result = Math.max(a, b);
// x86 assembly: CMP a, b; CMOVGE result, a  (conditional move, no branch)

// BRANCHLESS: absolute value
int abs = Math.abs(x);
// x86 assembly: CDQ; XOR eax, edx; SUB eax, edx  (no branch)

// BRANCHLESS: clamp to non-negative
int clamped = x & ~(x >> 31);  // if x < 0, x >> 31 = -1 → ~(-1) = 0 → x & 0 = 0
                                 // if x >= 0, x >> 31 = 0 → ~0 = -1 → x & -1 = x

// BRANCHLESS: conditional increment
// Instead of: if (condition) count++;
count += condition ? 1 : 0;  // JIT compiles to: SETE + ADD (no branch)

// BRANCHLESS: binary search direction
// Instead of: if (arr[mid] < target) lo = mid + 1; else hi = mid;
// Some implementations use:
int cmp = (arr[mid] < target) ? 1 : 0;
lo += cmp * (mid + 1 - lo);
hi += (1 - cmp) * (mid - hi);
// But this is usually NOT worth it — binary search branches are well-predicted
// because the tree structure gives the predictor a pattern.
```

**When to use branchless code**: Only when the branch is truly unpredictable (random data, hash comparisons) AND the code is in a hot loop. For most code, the branch predictor does fine, and branchless alternatives are harder to read. Profile first.

---

## 21.9 Primitive vs Boxed: The Full Cost Analysis

Chapter 1 covered the basics. Here we go into the complete cost model.

### Memory Cost Breakdown

```
Type          Stack/Inline    Heap Object    Total with Reference
─────────────────────────────────────────────────────────────────
boolean       1 byte*         16 bytes       20 bytes (ref=4)
byte          1 byte*         16 bytes       20 bytes
short         2 bytes         16 bytes       20 bytes
char          2 bytes         16 bytes       20 bytes
int           4 bytes         16 bytes       20 bytes
float         4 bytes         16 bytes       20 bytes
long          8 bytes         24 bytes       28 bytes
double        8 bytes         24 bytes       28 bytes

* On the JVM stack, boolean/byte/short/char occupy 4 bytes (one stack slot)
  In arrays, they use their actual size: boolean[]=1 byte, short[]=2 bytes
  In objects, HotSpot packs them tightly (after field reordering)
```

### Autoboxing Cost in Detail

```java
// Integer.valueOf(int) source:
public static Integer valueOf(int i) {
    if (i >= IntegerCache.low && i <= IntegerCache.high)
        return IntegerCache.cache[i + (-IntegerCache.low)];
    return new Integer(i);  // heap allocation!
}

// IntegerCache:
//   Default range: [-128, 127] (256 cached instances)
//   Can extend upper bound: -XX:AutoBoxCacheMax=<size>
//   Cannot extend lower bound (always -128)

// Implications:
Integer a = 127;  // cached — no allocation (Integer.valueOf(127))
Integer b = 127;  // same cached instance
assert a == b;    // TRUE — same object reference

Integer c = 128;  // NOT cached — new heap allocation
Integer d = 128;  // another heap allocation
assert c == d;    // FALSE — different objects!
assert c.equals(d);  // TRUE — .equals() compares values

// In a hot loop:
long sum = 0;
for (Integer val : hugeListOfIntegers) {
    sum += val;  // unboxing: val.intValue() — but val must be dereferenced from heap
}
// Each val.intValue() is a pointer dereference — potential cache miss
```

### Stream Pipelines: `IntStream` vs `Stream<Integer>`

```java
List<Integer> list = /* 1 million integers */;

// BOXING version:
long sum1 = list.stream()
    .filter(x -> x > 100)      // x unboxed for comparison, result re-boxed? No — predicate takes Integer
    .map(x -> x * 2)            // x.intValue() * 2 → Integer.valueOf(result) → BOXING
    .reduce(0, Integer::sum);   // more unboxing/boxing per element

// PRIMITIVE version:
long sum2 = list.stream()
    .mapToInt(Integer::intValue)  // unbox ONCE to int
    .filter(x -> x > 100)         // no boxing — int comparison
    .map(x -> x * 2)              // no boxing — int arithmetic
    .sum();                        // no boxing — int accumulation

// The mapToInt() call at the start converts Stream<Integer> to IntStream.
// Every subsequent operation works with raw ints — no boxing, no allocation.
// For 1M elements, this avoids ~1M Integer object allocations.
```

### Primitive-Specialized Collections

When the JDK collections box your primitives, these libraries store them directly:

```java
// Eclipse Collections (recommended):
IntArrayList ints = new IntArrayList();      // backed by int[]
IntIntHashMap map = new IntIntHashMap();       // int keys, int values
IntHashSet set = new IntHashSet();             // int elements

// Memory comparison for 1M int values:
// ArrayList<Integer>:        ~20 MB (boxed)
// IntArrayList:              ~4 MB  (primitive int[])
// Savings: 5x memory, plus cache-friendly sequential access

// HPPC (High Performance Primitive Collections):
IntIntHashMap map = new IntIntHashMap();  // similar API to Eclipse Collections

// Koloboke:
// Uses open addressing with linear probing — even more cache-friendly
// than Eclipse Collections' separate-chaining approach
HashIntIntMap map = HashIntIntMaps.newMutableMap();

// Agrona (from Aeron/LMAX):
Int2IntHashMap map = new Int2IntHashMap(Integer.MIN_VALUE);  // sentinel-based
// No boxing, open addressing, used in ultra-low-latency systems
```

### Valhalla Value Types (Preview, JDK 24+)

Project Valhalla introduces *value classes* — objects that are inlined into their container, eliminating the header overhead and pointer indirection:

```java
// Future syntax (preview):
value class Point {
    int x;
    int y;
}

// With value class:
Point[] points = new Point[1000];
// Memory: just 1000 × 8 bytes = 8000 bytes + array header
// Layout: [header][x0|y0][x1|y1][x2|y2]... ← contiguous, like a struct array in C

// Without value class (today):
Point[] points = new Point[1000];
// Memory: 1000 × 4 bytes (refs) + 1000 × 24 bytes (objects) = 28000 bytes
// Layout: [header][ref][ref][ref]... → [Point obj] → [Point obj]...
//                                       ↑ scattered, pointer chasing
```

Value types will also enable generic specialization:

```java
// Future: List<int> (not List<Integer>!)
// No boxing, no pointer chasing, contiguous memory
// This will make the "primitive vs boxed" distinction largely disappear
```

---

## 21.10 HashMap Capacity Tuning

`HashMap` is the most-used data structure in Java. Getting its capacity right eliminates resizes, which are expensive because they rehash every entry.

### The Resize Mechanics

```java
// HashMap internal behavior:
// capacity: number of buckets (always a power of 2)
// size: number of entries currently stored
// loadFactor: default 0.75
// threshold: capacity × loadFactor (triggers resize when size > threshold)

// Default: new HashMap<>()
// capacity = 16, threshold = 12, loadFactor = 0.75

// When 13th entry is added:
// 1. Allocate new Node[] of size 32 (double current capacity)
// 2. Rehash every existing entry: newIndex = hash & (newCapacity - 1)
// 3. Copy all entries to new table
// 4. Old table becomes garbage
// Cost: O(N) per resize, and the old table causes a GC spike
```

### Sizing for Known Capacity

If you know you will store N entries, pre-size to avoid resizes:

```java
// WRONG — common mistake:
Map<String, String> map = new HashMap<>(1000);
// capacity = 1024 (next power of 2), threshold = 768
// If you add 800 entries → resize at 769th entry!
// You wanted space for 1000, but threshold is only 768.

// CORRECT — account for load factor:
Map<String, String> map = new HashMap<>((int)(1000 / 0.75) + 1);
// = new HashMap<>(1334)
// capacity = 2048 (next power of 2), threshold = 1536
// Room for 1536 entries without resize → 1000 fits easily

// Simpler formula:
Map<String, String> map = new HashMap<>(expectedSize * 4 / 3 + 1);
// This is mathematically equivalent and avoids floating-point

// Or just use Guava:
Map<String, String> map = Maps.newHashMapWithExpectedSize(1000);
// Guava does the math for you: allocates capacity = ceilPow2(1000 / 0.75)
```

### Why Load Factor 0.75 Is Almost Always Right

The default load factor of 0.75 is a balance between space and time:

```
Load Factor   Avg Probe Length (chaining)   Space Efficiency   Collision Rate
─────────────────────────────────────────────────────────────────────────────
0.5           ~1.25 probes                  50% slots empty    Low
0.75          ~1.5 probes                   25% slots empty    Moderate (good)
1.0           ~2.0 probes                   0% slots empty     High
1.5           ~3.0+ probes                  Over-full          Very high

At load factor 0.75:
  - Average successful lookup: ~1.5 hash comparisons
  - Average unsuccessful lookup: ~2.0 hash comparisons
  - Memory waste: ~25% empty buckets
  - This is the sweet spot where both performance and memory are reasonable
```

Changing the load factor is almost never the right optimization:
- Lower (e.g., 0.5): wastes 50% of table space, marginal lookup improvement
- Higher (e.g., 1.0): saves some space, but collision chains grow longer, and the O(1) average degrades

If you need a more memory-efficient map, use a different implementation (open addressing with linear probing, Robin Hood hashing) rather than tuning HashMap's load factor.

### Power-of-Two Capacity

HashMap always rounds capacity to the next power of 2. This allows the index calculation to use bitwise AND instead of modulo:

```java
// HashMap.putVal():
int index = (n - 1) & hash;   // equivalent to: hash % n, but only if n is power of 2
// Bitwise AND is ~1 cycle. Modulo (%) is ~20-40 cycles.
```

The `tableSizeFor()` method rounds up:

```java
// HashMap.tableSizeFor(cap):
static final int tableSizeFor(int cap) {
    int n = -1 >>> Integer.numberOfLeadingZeros(cap - 1);
    return (n < 0) ? 1 : (n >= MAXIMUM_CAPACITY) ? MAXIMUM_CAPACITY : n + 1;
}
// new HashMap<>(1000) → tableSizeFor(1000) → 1024
// new HashMap<>(1025) → tableSizeFor(1025) → 2048
```

---

## 21.11 GC Implications for Data Structures

Every data structure choice has GC consequences. Here is the full picture.

### G1 GC: Regions and Remembered Sets

G1 divides the heap into equal-sized regions (default 1-32 MB, auto-tuned):

```
G1 Heap Layout:
┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐
│ E │ E │ S │ O │ O │ O │ O │ H │ H │ O │ E │ E │ F │
└───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
  E = Eden    S = Survivor    O = Old    H = Humongous    F = Free

Region size: max(heap_size / 2048, 1MB), rounded to power of 2
  4 GB heap → 2 MB regions (2048 regions)
  32 GB heap → 16 MB regions (2048 regions)
```

**Remembered sets**: G1 collects individual regions, not the entire heap. But what if an object in a collected region is referenced by an object in a non-collected region? G1 tracks these cross-region references using *remembered sets* (RSets):

```
Region A (being collected)          Region B (NOT collected)
┌──────────────────┐               ┌──────────────────┐
│ Object X ←──────────────────────── Object Y.ref     │
│ (is X alive?)    │               │ (Y keeps X alive)│
└──────────────────┘               └──────────────────┘

Without RSets: G1 would have to scan ALL regions to find references into Region A
With RSets: Region A's RSet records "Region B has a reference into me"
  → G1 only scans Region B's relevant cards (512-byte chunks) for references
```

**Data structure implication**: A large `HashMap` with millions of entries spans many regions. Each `Node` may reference keys and values in different regions. These cross-region references bloat remembered sets, increasing:
- Memory overhead (RSets can consume 5-20% of heap in worst case)
- GC pause time (scanning RSets is proportional to their size)

**Mitigation**: Keep related objects together. Use compact representations (parallel arrays instead of objects with reference fields). Use primitive-specialized maps to eliminate boxing references.

### Humongous Objects

G1 treats objects larger than 50% of a region as "humongous":

```
Region size: 4 MB
Humongous threshold: 2 MB

// An int[600_000] is ~2.4 MB → humongous!
// It gets allocated in contiguous "humongous" regions
// These regions are NOT part of normal young/old gen collection
// They are collected during concurrent marking or Full GC

Problems with humongous objects:
1. Allocation: must find contiguous free regions (may trigger GC)
2. Collection: only collected during marking cycles (slower to reclaim)
3. Fragmentation: humongous regions cannot be shared or reused partially
4. Before JDK 8u40: humongous objects were NEVER collected during young GC
   (leaked memory until full GC)
```

**What triggers humongous allocation?**

```java
// With 4 MB regions:
byte[] buf = new byte[2_100_000];       // humongous (>2 MB)
int[] arr = new int[525_000];            // humongous (525K × 4 = 2.1 MB)
Object[] refs = new Object[525_000];     // humongous (525K × 4 = 2.1 MB, compressed)
String[] strs = new String[525_000];     // humongous

// ArrayList internal resize can create humongous arrays:
ArrayList<String> list = new ArrayList<>();
// At capacity 524,288 (512K), internal Object[] is ~2 MB → just under threshold
// At capacity 786,432 (768K), internal Object[] is ~3 MB → humongous!
// The resize copies to a new humongous array, and the old one becomes
// humongous garbage
```

**Mitigation**: Use `-XX:G1HeapRegionSize` to increase region size (e.g., 16 MB or 32 MB) so that your large arrays stay below the humongous threshold. Or split large arrays into smaller chunks.

### ZGC and Shenandoah: Concurrent Low-Pause

For applications with large heaps (>8 GB) and strict latency requirements, ZGC and Shenandoah offer sub-millisecond pauses:

```
GC           Pause Time      Heap Range    Concurrent    Key Mechanism
─────────────────────────────────────────────────────────────────────────
G1           5-200 ms        4-64 GB       Partially     Region-based, RSets
ZGC          < 1 ms          8 GB-16 TB    Fully         Colored pointers, load barriers
Shenandoah   < 10 ms         4 GB-8 TB     Fully         Brooks pointers, load barriers

ZGC Colored Pointers:
  Reference bits: [metadata:4 | unused:18 | address:42]
  The 4 metadata bits encode GC state (marked, remapped, finalizable)
  Load barrier: every reference load checks the metadata bits
  If stale → fix up the reference (concurrent relocation)
  No stop-the-world for marking or compaction!

Shenandoah:
  Uses a forwarding pointer (Brooks pointer) per object
  Every object has an indirection pointer before the header
  Load barrier: every reference load goes through the forwarding pointer
  Slightly higher per-access overhead than ZGC, but works on smaller heaps
```

**Data structure implication**: With ZGC/Shenandoah, GC pauses are no longer proportional to heap size or live object count. This means large in-memory caches (millions of objects) that would cause 500ms+ G1 pauses become feasible. However, the load barriers add ~5% constant overhead to all reference accesses. Pointer-heavy structures (trees, linked lists) pay more barrier cost than compact arrays.

### String Deduplication

```bash
# Enable (G1 only, JDK 8u20+):
java -XX:+UseStringDeduplication -XX:+UseG1GC MyApp

# How it works:
# During young GC, G1 checks newly promoted String objects.
# If two Strings have identical char[]/byte[] contents, G1 makes them
# share the same backing array (updates one String's internal reference).
# The duplicate array becomes garbage and is collected.
#
# This happens concurrently — no additional pause time.
# Only deduplicates Strings that survive to old gen (not short-lived ones).
```

**When it helps**: Applications with many duplicate strings — configuration processing, XML/JSON parsing, log processing. One production system at a financial firm reduced heap from 12 GB to 8 GB just by enabling string dedup.

**When it does not help**: If your strings are already interned (`String.intern()`), or if you have few duplicate strings (scientific computing, unique identifiers).

---

## 21.12 Off-Heap Memory

When GC pauses are unacceptable or your data exceeds practical heap sizes, off-heap memory bypasses the GC entirely.

### `ByteBuffer.allocateDirect()`

```java
// Allocate 256 MB off-heap:
ByteBuffer buffer = ByteBuffer.allocateDirect(256 * 1024 * 1024);

// Write data:
buffer.putInt(0, 42);           // write int at position 0
buffer.putLong(4, 1234567890L); // write long at position 4
buffer.put(12, (byte) 0xFF);   // write byte at position 12

// Read data:
int value = buffer.getInt(0);   // read int from position 0

// Properties:
// - Allocated in native memory (not on Java heap)
// - Not subject to GC pauses (no tracing, no compaction)
// - Supports zero-copy I/O: kernel can DMA directly to/from this buffer
//   (heap ByteBuffers require a copy to a native buffer before I/O)
// - The ByteBuffer Java object itself is on-heap (~50 bytes, trivial)
//   It acts as a handle to the native memory
// - Deallocated when the ByteBuffer is garbage collected (via Cleaner/phantom ref)
//   Or explicitly via: ((sun.nio.ch.DirectBuffer) buffer).cleaner().clean();
```

**Downsides**:
- Allocation is slower than heap allocation (~microseconds vs nanoseconds for TLAB)
- No bounds checking by default (corrupted data instead of exceptions for Unsafe)
- Memory leaks if not deallocated (GC eventually gets the ByteBuffer object, but late)
- Not suitable for many small allocations (fragmentation)

### `sun.misc.Unsafe` (JDK < 21)

```java
// Get Unsafe instance (via reflection):
Field f = Unsafe.class.getDeclaredField("theUnsafe");
f.setAccessible(true);
Unsafe unsafe = (Unsafe) f.get(null);

// Allocate raw memory:
long address = unsafe.allocateMemory(1024 * 1024);  // 1 MB

// Write:
unsafe.putInt(address, 42);
unsafe.putLong(address + 4, 1234567890L);

// Read:
int value = unsafe.getInt(address);

// Free (MUST call or you leak memory):
unsafe.freeMemory(address);

// CAS operations (used by AtomicInteger, ConcurrentHashMap, etc.):
unsafe.compareAndSwapInt(object, fieldOffset, expected, newValue);
unsafe.compareAndSwapLong(object, fieldOffset, expected, newValue);
```

Used by: Netty (PooledByteBufAllocator), Cassandra (off-heap memtables), Hazelcast (off-heap storage), Ehcache (off-heap tier), MapDB (memory-mapped B-trees).

### Panama Foreign Memory API (JDK 21+)

The modern, safe replacement for `sun.misc.Unsafe`:

```java
// JDK 21+ (finalized API):
import java.lang.foreign.*;

// Allocate with automatic deallocation:
try (Arena arena = Arena.ofConfined()) {
    MemorySegment segment = arena.allocate(1024 * 1024);  // 1 MB

    // Write:
    segment.setAtIndex(ValueLayout.JAVA_INT, 0, 42);
    segment.setAtIndex(ValueLayout.JAVA_LONG, 1, 1234567890L);

    // Read:
    int value = segment.getAtIndex(ValueLayout.JAVA_INT, 0);

    // Bounds checking: accessing beyond segment size throws
    // → safer than Unsafe

}  // segment automatically freed when arena closes

// Arena types:
// Arena.ofConfined() — single-thread access, fastest
// Arena.ofShared()   — multi-thread safe, slightly slower
// Arena.ofAuto()     — GC-managed lifetime (like DirectByteBuffer)
// Arena.global()     — never freed (for process-lifetime data)
```

**When to go off-heap**:
- Large caches (>4 GB) where GC pauses would be prohibitive
- Memory-mapped files for persistent data structures
- Network buffers for zero-copy I/O
- Inter-process communication (shared memory)
- When you need deterministic deallocation (not GC-dependent)

---

## 21.13 LMAX Disruptor: Mechanical Sympathy in Action

The LMAX Disruptor is the definitive example of building a data structure for how CPUs actually work. It processes 6 million messages per second on a single thread, outperforming `BlockingQueue` by orders of magnitude.

### Ring Buffer Design

```
Traditional BlockingQueue:
  ┌─────────────────────────────────┐
  │  ArrayBlockingQueue             │
  │  ┌─────┐ ┌─────┐ ┌─────┐      │
  │  │Lock │ │Cond │ │Cond │      │  ← 2 conditions + 1 lock per operation
  │  │     │ │notFull│ │notEmpty│   │  ← Context switch on contention
  │  └─────┘ └─────┘ └─────┘      │
  │  Object[] items                 │  ← Entries are object references
  │  [ref][ref][ref][ref][ref]...   │     → pointer chasing to actual objects
  │  int takeIndex, putIndex        │  ← Modified by producer AND consumer
  │                                 │     → false sharing!
  └─────────────────────────────────┘

Disruptor Ring Buffer:
  ┌───────────────────────────────────────────────────┐
  │  RingBuffer<Event>                                 │
  │                                                    │
  │  Event[] entries (PRE-ALLOCATED at startup)        │
  │  ┌───────┐┌───────┐┌───────┐┌───────┐┌───────┐  │
  │  │Event 0││Event 1││Event 2││Event 3││Event 4│  │
  │  │(reused)││(reused)││(reused)││(reused)││(reused)│ │
  │  └───────┘└───────┘└───────┘└───────┘└───────┘  │
  │  ↑ contiguous in memory, sequential access        │
  │  ↑ NO allocation during operation (pre-allocated) │
  │  ↑ Events are REUSED, not created/discarded       │
  │                                                    │
  │  Sequence cursor (producer position)               │
  │  [padded to own cache line — no false sharing]     │
  │                                                    │
  │  Sequence[] gatingSequences (consumer positions)   │
  │  [each padded to own cache line]                   │
  └───────────────────────────────────────────────────┘
```

### Why It Is Faster Than BlockingQueue

**1. No locks (CAS only)**

The producer advances the cursor with a single CAS:
```java
long nextSequence = cursor.get() + 1;
// Wait for consumers to catch up (spin or yield — no kernel call)
cursor.compareAndSet(expected, nextSequence);
```

`ArrayBlockingQueue` uses a `ReentrantLock` — even in the uncontended case, this involves monitor enter/exit overhead. Under contention, it parks the thread (kernel transition: ~5-10us).

**2. No garbage (pre-allocated events)**

Events are allocated once at startup and reused:
```java
RingBuffer<OrderEvent> ringBuffer = RingBuffer.create(
    ProducerType.SINGLE,
    OrderEvent::new,    // factory: creates events once
    1024,               // buffer size (power of 2)
    new YieldingWaitStrategy()
);

// Publish:
long sequence = ringBuffer.next();
OrderEvent event = ringBuffer.get(sequence);  // get pre-allocated event
event.setOrderId(12345);                       // populate — no allocation
event.setPrice(99.95);
ringBuffer.publish(sequence);                  // make visible to consumers
```

`BlockingQueue.put(new Event(...))` allocates a new object every time → GC pressure.

**3. Cache-friendly (sequential access)**

The ring buffer is backed by a contiguous `Event[]`. Producer and consumers access events in sequence order. The hardware prefetcher anticipates the next access.

`BlockingQueue` entries are `Object[]` slots holding references to heap-allocated events. Each access requires a pointer dereference to a random heap location.

**4. Padding eliminates false sharing**

The Disruptor's `Sequence` class (as shown in Section 21.4) pads the volatile long value with 7 longs on each side. The producer's cursor and each consumer's sequence are on separate cache lines. No cache ping-pong.

```
Performance Comparison (single producer, single consumer):

Data Structure          Ops/Second    Latency (p99)
────────────────────────────────────────────────────────
ArrayBlockingQueue      ~3M           ~500 ns
LinkedBlockingQueue     ~2M           ~800 ns
Disruptor (yield)       ~25M          ~50 ns
Disruptor (busy-spin)   ~100M+        ~10 ns

The Disruptor is 10-50x faster than BlockingQueue.
```

---

## 21.14 JMH Benchmarking

If you are not benchmarking with JMH, you are not benchmarking. Naive benchmarks in Java are almost always wrong.

### Why Naive Benchmarks Fail

```java
// WRONG — every measurement here is meaningless:
public static void main(String[] args) {
    long start = System.nanoTime();

    int sum = 0;
    for (int i = 0; i < 1_000_000; i++) {
        sum += i;                          // Problem 1: dead code elimination
    }

    long elapsed = System.nanoTime() - start;
    System.out.println("Time: " + elapsed + " ns");
    // Problem 2: No warmup — measuring interpreter, not JIT-compiled code
    // Problem 3: Single iteration — no statistical rigor
    // Problem 4: No fork — previous JIT decisions pollute this run
    // Problem 5: The JIT might compute sum at compile time (constant folding)
}
```

What actually happens:
1. The JIT computes `sum = 0 + 1 + 2 + ... + 999999 = 499999500000` at compile time → loop eliminated entirely
2. Then `sum` is never used (not printed, not returned) → dead code elimination removes the entire computation
3. The JIT literally reduces this to: `long elapsed = System.nanoTime() - System.nanoTime();`
4. You measure ~10 nanoseconds and conclude "Java is amazingly fast" — you measured nothing.

### JMH: The Correct Approach

```java
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
@Warmup(iterations = 5, time = 1)       // 5 warmup iterations, 1 second each
@Measurement(iterations = 5, time = 1)  // 5 measurement iterations
@Fork(3)                                 // 3 separate JVM forks
@State(Scope.Thread)                     // each thread gets its own state
public class CollectionBenchmark {

    @Param({"100", "10000", "1000000"})
    private int size;

    private ArrayList<Integer> arrayList;
    private LinkedList<Integer> linkedList;

    @Setup(Level.Trial)
    public void setup() {
        arrayList = new ArrayList<>();
        linkedList = new LinkedList<>();
        Random rng = new Random(42);
        for (int i = 0; i < size; i++) {
            int val = rng.nextInt();
            arrayList.add(val);
            linkedList.add(val);
        }
    }

    @Benchmark
    public int sumArrayList(Blackhole bh) {
        int sum = 0;
        for (int i = 0; i < arrayList.size(); i++) {
            sum += arrayList.get(i);
        }
        return sum;  // returning the value prevents dead code elimination
        // Alternative: bh.consume(sum) — Blackhole is JMH's way to prevent DCE
    }

    @Benchmark
    public int sumLinkedList(Blackhole bh) {
        int sum = 0;
        for (int val : linkedList) {
            sum += val;
        }
        return sum;
    }
}
```

Key JMH mechanisms:
- **`@Warmup`**: Runs iterations before measurement to let the JIT compile and stabilize
- **`@Fork`**: Each measurement runs in a fresh JVM to prevent cross-benchmark JIT pollution
- **`Blackhole`**: Consumes computed values so the JIT cannot eliminate "unused" results
- **`@State`**: Controls how benchmark state (data structures) is shared across threads
- **Statistical output**: Reports mean, standard deviation, confidence intervals

### Running JMH

```bash
# Setup with Maven:
mvn archetype:generate \
  -DarchetypeGroupId=org.openjdk.jmh \
  -DarchetypeArtifactId=jmh-java-benchmark-archetype \
  -DarchetypeVersion=1.37

# Run:
mvn clean package
java -jar target/benchmarks.jar

# With profilers:
java -jar target/benchmarks.jar -prof gc          # GC allocation rate
java -jar target/benchmarks.jar -prof perfasm      # assembly output (Linux)
java -jar target/benchmarks.jar -prof stack        # stack profiler
java -jar target/benchmarks.jar -prof jfr          # JDK Flight Recorder
```

### JMH Output Interpretation

```
Benchmark                      (size)   Mode  Cnt     Score     Error  Units
CollectionBenchmark.sumArrayList  100   avgt   15     52.3 ±    1.2  ns/op
CollectionBenchmark.sumArrayList  10000  avgt   15   4823.1 ±   98.7  ns/op
CollectionBenchmark.sumArrayList  1000000 avgt  15 584210.3 ± 8921.4  ns/op
CollectionBenchmark.sumLinkedList  100   avgt   15    287.9 ±    5.3  ns/op
CollectionBenchmark.sumLinkedList  10000  avgt   15  58921.3 ± 1203.1  ns/op
CollectionBenchmark.sumLinkedList  1000000 avgt  15 14729321.0 ± 239847.2  ns/op

# Reading: "sumLinkedList with 1M elements takes 14.7 ms per operation,
# which is 25x slower than sumArrayList's 0.58 ms"
# The ± value is the 99.9% confidence interval
# Cnt = number of measurement iterations across all forks (5 iters × 3 forks = 15)
```

---

## Problems

### Object Header and Memory Layout

**P21.01** [E] -- Mark Word State Diagram

Trace the mark word state transitions for the following code. Assume JDK 17 (biased locking disabled).

```java
Object lock = new Object();

// State 1: immediately after creation
// Mark word: [00000...00000 | hashcode:0 | unused:0 | age:0000 | biased:0 | lock:01]
// State: Unlocked, no identity hash computed yet
// All 25+31+1 upper bits are zero (hash not yet computed)

synchronized (lock) {
    // State 2: inside synchronized block
    // Mark word: [pointer_to_lock_record:62 | lock:00]
    // State: Thin Lock
    // The lock record is on the current thread's stack frame
    // The displaced header (original mark word) is saved in the lock record
    Thread.sleep(0);  // trivial operation inside lock
}

// State 3: after leaving synchronized
// Mark word restored from displaced header in lock record
// Back to: [00000...00000 | hashcode:0 | unused:0 | age:0000 | biased:0 | lock:01]
// State: Unlocked

int hash = System.identityHashCode(lock);

// State 4: after identityHashCode
// Mark word: [unused:25 | identity_hash:31 | unused:1 | age:0000 | biased:0 | lock:01]
// State: Unlocked, but now hash is permanently stored
// The 31-bit hash value is non-zero (unless extremely unlikely zero hash)

// State 5: What happens if we try biased locking now?
// Answer: Impossible. Even on JDK < 15, once the identity hash is stored,
// those 31 bits cannot be reused for a thread ID.
// On JDK 17, biased locking does not exist anyway.
```

---

**P21.02** [E] -- Object Size with Compressed Class Pointer

Calculate the exact memory layout of this class with and without compressed class pointers:

```java
class Metrics {
    long timestamp;     // 8 bytes
    int count;          // 4 bytes
    short status;       // 2 bytes
    boolean active;     // 1 byte
}

// WITH compressed class pointers (default, heap < 32 GB):
// Offset  Size  Field
// 0       8     mark word
// 8       4     klass pointer (compressed)
// 12      4     int count        ← 4-byte field fills gap after 12-byte header
// 16      8     long timestamp   ← 8-byte aligned at offset 16
// 24      2     short status
// 26      1     boolean active
// 27      5     padding (to 8-byte boundary → 32 bytes)
// TOTAL: 32 bytes

// WITHOUT compressed class pointers (heap > 32 GB):
// Offset  Size  Field
// 0       8     mark word
// 8       8     klass pointer (full 64-bit)
// 16      8     long timestamp   ← naturally 8-byte aligned
// 24      4     int count
// 28      2     short status
// 30      1     boolean active
// 31      1     padding (to 8-byte boundary → 32 bytes)
// TOTAL: 32 bytes
//
// In this case, both happen to be 32 bytes! But that is coincidence.
// The compressed version has 5 bytes of padding; the uncompressed has 1 byte.
// With more reference fields, the difference would be dramatic.
```

---

**P21.03** [M] -- Fat Lock Inflation Scenario

Two threads contend on the same lock. Trace the mark word transitions and explain the performance impact.

```java
Object lock = new Object();

// Thread A:
new Thread(() -> {
    synchronized (lock) {
        // Mark word → Thin Lock: [ptr_to_A_lock_record | 00]
        // Lock record on Thread A's stack contains displaced mark word
        try { Thread.sleep(100); } catch (InterruptedException e) {}
    }
}, "Thread-A").start();

// Thread B (starts 10ms later, Thread A still holds the lock):
new Thread(() -> {
    synchronized (lock) {
        // Thread B attempts CAS to acquire thin lock → FAILS
        // (mark word already points to A's lock record)
        //
        // Inflation process:
        // 1. JVM allocates an ObjectMonitor (native memory, ~200 bytes)
        // 2. ObjectMonitor.owner = Thread-A
        // 3. ObjectMonitor._count = 1 (Thread-A holds it once)
        // 4. Mark word → Fat Lock: [ptr_to_ObjectMonitor | 10]
        // 5. Thread-B is enqueued on ObjectMonitor._cxq (contention queue)
        // 6. Thread-B calls park() → kernel transition → thread sleeps
        //
        // When Thread-A releases:
        // 1. ObjectMonitor.owner = null
        // 2. ObjectMonitor notifies Thread-B via unpark()
        // 3. Thread-B wakes up (kernel transition again)
        // 4. Thread-B CAS on ObjectMonitor.owner → succeeds
        //
        // Performance impact:
        // Thin lock acquire/release: ~20ns (user-space CAS)
        // Fat lock park/unpark: ~5000-10000ns (kernel transitions)
        // → 250-500x slower!
        //
        // The ObjectMonitor is NOT immediately deflated after both threads finish.
        // It persists until the JVM's async deflation thread reclaims it
        // (JDK 14+: -XX:+AsyncDeflateMonitors, default on).
        // Before JDK 14: monitors deflated at safepoints → additional STW pause.
    }
}, "Thread-B").start();
```

---

**P21.04** [E] -- Compressed OOP Calculation

Given heap base = 0x700000000 and compressed OOP value = 0x12345678, calculate the actual object address.

```java
// Formula: actual_address = compressed_base + (compressed << shift)
// compressed_base = 0x700000000 (JVM heap start address)
// compressed = 0x12345678
// shift = 3 (default, 8-byte alignment)

// Step 1: Shift
// 0x12345678 << 3 = 0x91A2B3C0
// In decimal: 0x12345678 = 305,419,896
// 305,419,896 << 3 = 305,419,896 × 8 = 2,443,359,168 = 0x91A2B3C0

// Step 2: Add base
// 0x700000000 + 0x91A2B3C0 = 0x791A2B3C0

// Actual address: 0x791A2B3C0
// This address is within the heap (starts at 0x700000000)
// And is 8-byte aligned (low 3 bits of 0x791A2B3C0 = 0b000 ✓)

// Reverse (encoding):
// Given actual address 0x791A2B3C0:
// compressed = (0x791A2B3C0 - 0x700000000) >> 3
// = 0x91A2B3C0 >> 3
// = 0x12345678 ✓
```

---

**P21.05** [M] -- 32GB Cliff Impact Analysis

An application uses a `ConcurrentHashMap` with 20 million entries (String keys, byte[] values, average 200 bytes per value). Calculate the memory impact of going from 31 GB to 33 GB heap.

```java
// ConcurrentHashMap.Node fields:
// int hash, K key, V value, Node<K,V> next

// WITH compressed OOPs (31 GB heap):
// Node layout:
//   mark word:     8 bytes
//   klass ptr:     4 bytes (compressed)
//   int hash:      4 bytes
//   ref key:       4 bytes (compressed)
//   ref value:     4 bytes (compressed)
//   ref next:      4 bytes (compressed)
//   padding:       4 bytes
//   TOTAL:        32 bytes per Node

// Node[] table (capacity ~32M for 20M entries at 0.75 load factor):
//   header:        16 bytes
//   32M × 4 bytes: 128 MB (compressed references)
//   TOTAL:         ~128 MB

// 20M Nodes:        20M × 32 = 640 MB
// 20M String keys:  ~20M × 48 bytes avg = 960 MB (object + char[])
// 20M byte[] values: ~20M × 216 bytes avg = 4,320 MB (object + 200 bytes data)
// Table:            128 MB
// Total:            ~6,048 MB ≈ 5.9 GB

// WITHOUT compressed OOPs (33 GB heap):
// Node layout:
//   mark word:     8 bytes
//   klass ptr:     8 bytes (uncompressed)
//   int hash:      4 bytes
//   padding:       4 bytes (align references to 8)
//   ref key:       8 bytes (uncompressed)
//   ref value:     8 bytes (uncompressed)
//   ref next:      8 bytes (uncompressed)
//   TOTAL:        48 bytes per Node (+50%)

// Node[] table:
//   32M × 8 bytes: 256 MB (+100%)

// 20M Nodes:        20M × 48 = 960 MB (+320 MB)
// 20M String keys:  ~20M × 64 bytes = 1,280 MB (+320 MB, references in String inflate)
// 20M byte[] values: ~20M × 224 bytes = 4,480 MB (+160 MB, headers inflate)
// Table:            256 MB (+128 MB)
// Total:            ~6,976 MB ≈ 6.8 GB

// Difference: ~928 MB MORE memory used just from disabling compressed OOPs
// That is nearly 1 GB of overhead for a 2 GB heap increase!
// Net gain: only ~1.1 GB usable, not the 2 GB you expected.
//
// Recommendation: Stay at 31 GB. If more memory is needed, consider:
// 1. Off-heap storage for byte[] values (direct ByteBuffers)
// 2. Compressed byte[] (if values are compressible)
// 3. Memory-mapped files for less-frequently accessed values
```

---

### Cache and False Sharing

**P21.06** [M] -- Cache Line Calculation

How many cache lines does each of these arrays occupy?

```java
// Cache line = 64 bytes

int[] a = new int[100];
// Array header: 16 bytes
// Data: 100 × 4 = 400 bytes
// Total: 416 bytes
// Cache lines: ceil(416 / 64) = 7 cache lines
// First line: header + first 12 ints (16 + 48 = 64 bytes)
// Lines 2-7: 16 ints each (64 bytes each)
// Last line partially filled: 4 ints (16 bytes) + 48 bytes unused

long[] b = new long[100];
// Header: 16 bytes
// Data: 100 × 8 = 800 bytes
// Total: 816 bytes
// Cache lines: ceil(816 / 64) = 13 cache lines

Object[] c = new Object[100];  // with compressed OOPs
// Header: 16 bytes
// Data: 100 × 4 = 400 bytes (compressed references)
// Total: 416 bytes
// Cache lines: 7 cache lines
// NOTE: accessing c[i] is just the reference — accessing the object at c[i]
// is a separate cache line fetch (the object is elsewhere on the heap)

boolean[] d = new boolean[100];
// Header: 16 bytes
// Data: 100 × 1 = 100 bytes
// Total: 116 bytes
// Cache lines: ceil(116 / 64) = 2 cache lines
// Very compact! Boolean arrays are byte-per-element, not bit-per-element.
// For bit-level packing, use BitSet.
```

---

**P21.07** [M] -- False Sharing Detection

This code runs slower than expected on a 4-core machine. Identify the false sharing and fix it.

```java
// SLOW VERSION:
class ThreadLocalCounters {
    final long[] counters = new long[4];  // one counter per thread

    void increment(int threadIndex) {
        counters[threadIndex]++;  // each thread writes its own index
    }

    long total() {
        long sum = 0;
        for (long c : counters) sum += c;
        return sum;
    }
}

// PROBLEM:
// long[4] occupies 16 + 32 = 48 bytes total (header + 4 × 8)
// All 4 counters fit in a SINGLE 64-byte cache line!
//
// Memory layout:
// [header: 16 bytes][counter0: 8][counter1: 8][counter2: 8][counter3: 8]
// ├────────────────── all within one 64-byte cache line ────────────────────┤
//
// Thread 0 writes counter[0] → invalidates cache line on cores 1, 2, 3
// Thread 1 writes counter[1] → invalidates cache line on cores 0, 2, 3
// ... constant ping-pong across all 4 cores

// FIX 1: Pad each counter to its own cache line
class ThreadLocalCounters {
    // 8 longs per "slot" = 64 bytes = 1 cache line
    final long[] counters = new long[4 * 8];  // 32 longs

    void increment(int threadIndex) {
        counters[threadIndex * 8]++;  // stride of 8 longs = 64 bytes
    }

    long total() {
        long sum = 0;
        for (int i = 0; i < 4; i++) sum += counters[i * 8];
        return sum;
    }
}
// Now each counter is at offset 0, 64, 128, 192 — separate cache lines.

// FIX 2: Use LongAdder (one per logical counter)
// LongAdder internally handles striping and padding.
LongAdder[] counters = new LongAdder[4];
// But this introduces object overhead. For 4 counters, Fix 1 is simpler.

// FIX 3: Use AtomicLongArray with manual padding
// AtomicLongArray does NOT pad between elements — same problem.
// You must pad manually, just like Fix 1.

// Performance improvement: typically 10-30x faster with the fix.
```

---

**P21.08** [M] -- Design a Cache-Line-Optimized Queue

Design a single-producer, single-consumer bounded queue that is optimized for cache lines.

```java
public class SPSCQueue<E> {
    // Pad the head counter to its own cache line
    private long p1, p2, p3, p4, p5, p6, p7;
    private volatile long head = 0;
    private long p9, p10, p11, p12, p13, p14, p15;

    // Pad the tail counter to its own cache line
    private long p17, p18, p19, p20, p21, p22, p23;
    private volatile long tail = 0;
    private long p25, p26, p27, p28, p29, p30, p31;

    private final Object[] buffer;
    private final int mask;

    // Cached copies: producer caches consumer's head, consumer caches producer's tail
    // This avoids reading the other thread's volatile on every operation
    private long cachedHead = 0;  // producer-side cache of head
    private long cachedTail = 0;  // consumer-side cache of tail

    public SPSCQueue(int capacity) {
        // Round up to power of 2
        int cap = Integer.highestOneBit(capacity - 1) << 1;
        this.buffer = new Object[cap];
        this.mask = cap - 1;
    }

    // Producer: called from exactly one thread
    public boolean offer(E item) {
        long currentTail = tail;
        long nextTail = currentTail + 1;

        // Check if full using cached head (avoids volatile read of head)
        if (nextTail - cachedHead > mask) {
            cachedHead = head;  // refresh cache — volatile read
            if (nextTail - cachedHead > mask) {
                return false;  // truly full
            }
        }

        buffer[(int)(currentTail & mask)] = item;
        tail = nextTail;  // volatile write — makes item visible to consumer
        return true;
    }

    // Consumer: called from exactly one thread
    @SuppressWarnings("unchecked")
    public E poll() {
        long currentHead = head;

        // Check if empty using cached tail
        if (currentHead >= cachedTail) {
            cachedTail = tail;  // refresh cache — volatile read
            if (currentHead >= cachedTail) {
                return null;  // truly empty
            }
        }

        E item = (E) buffer[(int)(currentHead & mask)];
        buffer[(int)(currentHead & mask)] = null;  // help GC
        head = currentHead + 1;  // volatile write
        return item;
    }
}

// Key optimizations:
// 1. head and tail are on separate cache lines (padding)
//    → no false sharing between producer and consumer
// 2. Cached copies of the other thread's counter
//    → reduces cross-core volatile reads from every-op to periodic
// 3. Power-of-2 capacity with mask
//    → bitwise AND instead of modulo for index calculation
// 4. Pre-allocated Object[] array
//    → sequential memory access, no allocation during operation
//
// This is essentially the JCTools SPSC queue pattern.
// Performance: ~150M ops/sec (vs ~5M for ArrayBlockingQueue)
```

---

**P21.09** [M] -- Spatial Locality Benchmark Analysis

Explain why this matrix multiplication order matters:

```java
static double[][] multiply(double[][] a, double[][] b, int n) {
    double[][] c = new double[n][n];

    // Version 1: i-j-k (standard row-major)
    for (int i = 0; i < n; i++)
        for (int j = 0; j < n; j++)
            for (int k = 0; k < n; k++)
                c[i][j] += a[i][k] * b[k][j];

    // Version 2: i-k-j (cache-friendly)
    for (int i = 0; i < n; i++)
        for (int k = 0; k < n; k++)
            for (int j = 0; j < n; j++)
                c[i][j] += a[i][k] * b[k][j];

    return c;
}

// Analysis:
//
// Version 1 (i-j-k):
// Inner loop iterates k: a[i][k] → sequential access to row a[i] ✓
//                        b[k][j] → COLUMN access to b (stride = n doubles)
// For n=1000: b[k][j] jumps 8000 bytes between accesses (1000 × 8 bytes)
// That is 125 cache lines apart! Every access to b is a cache miss.
// Cache misses for b: n^3 (every access)
//
// Version 2 (i-k-j):
// Inner loop iterates j: c[i][j] → sequential access to row c[i] ✓
//                        b[k][j] → sequential access to row b[k] ✓
//                        a[i][k] → invariant in inner loop ✓ (loaded once into register)
// All three accesses are cache-friendly in the inner loop!
// Cache misses for b: n^2 (one miss per row start, then 15 hits per cache line)
//
// Performance difference for n=1000:
// Version 1: ~4.5 seconds
// Version 2: ~0.9 seconds  ← 5x faster, same algorithm, same result
//
// For n=2000 (matrix exceeds L2 cache):
// Version 1: ~90 seconds
// Version 2: ~12 seconds  ← 7.5x faster (cache effects amplify with size)
//
// Further optimization: tile the loops to keep blocks in L1 cache.
// Tiled version with 64×64 blocks: ~0.5 seconds for n=1000.
```

---

### Escape Analysis and JIT

**P21.10** [M] -- Escape Analysis Prediction

For each allocation below, predict whether escape analysis will eliminate it.

```java
public class EscapeAnalysisQuiz {

    // Case 1: Iterator from enhanced for-loop over ArrayList
    public int sumList(ArrayList<Integer> list) {
        int sum = 0;
        for (Integer val : list) {  // creates Iterator object
            sum += val;
        }
        return sum;
    }
    // Answer: The Iterator is created by ArrayList.iterator().
    // If the method is hot and ArrayList is the only type seen (monomorphic):
    //   1. ArrayList.iterator() is inlined
    //   2. The Itr object does not escape the loop
    //   3. Scalar replacement: Itr.cursor, Itr.expectedModCount become locals
    //   → Iterator ELIMINATED
    // If ArrayList AND LinkedList are both seen (bimorphic/megamorphic):
    //   → iterator() is not inlined → Iterator ESCAPES → heap allocated

    // Case 2: Pair object returned from method
    record Pair(int first, int second) {}

    public Pair findMinMax(int[] arr) {
        int min = arr[0], max = arr[0];
        for (int i = 1; i < arr.length; i++) {
            if (arr[i] < min) min = arr[i];
            if (arr[i] > max) max = arr[i];
        }
        return new Pair(min, max);  // escapes via return!
    }
    // Answer: The Pair ESCAPES. It is returned to the caller.
    // The JIT cannot scalar-replace it because the caller may store it.
    //
    // HOWEVER: if the CALLER is also inlined, the picture changes:
    //   void process(int[] arr) {
    //       Pair p = findMinMax(arr);  // if findMinMax is inlined here...
    //       System.out.println(p.first() + ", " + p.second());
    //       // ...and p does not escape from process()...
    //       // then Pair can be scalar-replaced to two ints!
    //   }
    // This is why inlining depth matters: the deeper the JIT inlines,
    // the more escape analysis can eliminate.

    // Case 3: Object stored in an array
    public void processCoordinates(int[][] points) {
        int[] temp = new int[2];
        for (int[] point : points) {
            temp[0] = point[0] * 2;
            temp[1] = point[1] * 2;
            handle(temp[0], temp[1]);  // if handle is inlined, temp does not escape
        }
    }
    // Answer: It depends on whether handle() is inlined.
    //   If handle() IS inlined and does not store temp: → temp ELIMINATED
    //   If handle() is NOT inlined: → temp might escape (conservatively allocated)
    //   Note: temp is NOT stored in an array here — it IS an array.
    //   The JIT can scalar-replace small arrays (temp[0] → local int, temp[1] → local int).

    // Case 4: Lambda capture
    public int computeWithLambda(int x) {
        int factor = x * 2;
        IntUnaryOperator op = n -> n * factor;  // captures `factor`
        return op.applyAsInt(10);
    }
    // Answer: The lambda captures `factor` (an int).
    //   In HotSpot, the LambdaMetafactory generates a class at first invocation.
    //   For subsequent invocations, if factor is different each time,
    //   a new lambda instance is created to hold the captured value.
    //   If applyAsInt is inlined, the lambda object can be scalar-replaced:
    //   → the captured `factor` becomes a local variable
    //   → the lambda object is ELIMINATED
    //
    //   Non-capturing lambdas (no captured variables) are ALWAYS singletons
    //   → zero allocation after the first invocation.

    // Case 5: Lock on non-escaping object
    public int synchronizedCompute(int a, int b) {
        Object lock = new Object();
        synchronized (lock) {
            return a + b;
        }
    }
    // Answer:
    //   1. lock does not escape (created and used locally)
    //   2. Lock elision: synchronized block removed entirely
    //   3. Scalar replacement: Object has no fields → nothing to replace
    //   4. The allocation is eliminated entirely
    //   → Both the Object AND the synchronization are ELIMINATED
}
```

---

**P21.11** [H] -- JIT Deoptimization Trap

Explain why this code has a sudden performance cliff after running for a while:

```java
interface Processor { int process(int x); }

class FastProcessor implements Processor {
    public int process(int x) { return x * 2; }
}

class SlowProcessor implements Processor {
    public int process(int x) {
        // some complex logic
        return (int)(Math.log(x) * Math.sqrt(x));
    }
}

public class DeoptDemo {
    static int runWorkload(Processor p, int[] data) {
        int sum = 0;
        for (int val : data) {
            sum += p.process(val);  // hot call site
        }
        return sum;
    }

    public static void main(String[] args) {
        int[] data = new int[1_000_000];
        Arrays.fill(data, 42);
        Processor fast = new FastProcessor();
        Processor slow = new SlowProcessor();

        // Phase 1: 10000 iterations with FastProcessor only
        for (int i = 0; i < 10000; i++) {
            runWorkload(fast, data);
        }
        // Phase 2: suddenly introduce SlowProcessor
        runWorkload(slow, data);  // <-- PERFORMANCE CLIFF HERE
    }
}

// Analysis:
//
// Phase 1 (monomorphic):
// The JIT profiles p.process() and sees ONLY FastProcessor.
// It devirtualizes and inlines: p.process(val) → val * 2
// The loop is incredibly fast (just multiplication, no method call overhead).
// The JIT inserts an uncommon trap: "if p is NOT FastProcessor, deoptimize"
//
// Phase 2 (type profile invalidated):
// When runWorkload(slow, data) is called:
// 1. The uncommon trap fires on the FIRST iteration
//    (p.getClass() != FastProcessor → BOOM)
// 2. The JIT DEOPTIMIZES the compiled method:
//    - Discards the compiled native code
//    - Falls back to interpreter or C1-compiled version
//    - All optimizations (inlining, escape analysis) are lost
// 3. The entire 1M-element loop runs in interpreter/C1 → MUCH slower
//
// After deoptimization:
// The JIT recompiles with a bimorphic profile (FastProcessor + SlowProcessor)
// → type check + two inlined paths
// → Still fast, but not as fast as the monomorphic version
//
// The cliff: a single call with a new type can invalidate the JIT's optimistic
// assumptions and force deoptimization. This is called an "uncommon trap"
// or "deoptimization event."
//
// Detection:
// -XX:+PrintCompilation shows: "made not entrant" for the deoptimized method
// -XX:+TraceDeoptimization (debug build) shows the specific uncommon trap
//
// Mitigation:
// 1. Warm up with ALL types during startup
// 2. Avoid megamorphic call sites in hot loops
// 3. Use concrete types instead of interfaces in hot paths
```

---

**P21.12** [M] -- Inlining Failure Investigation

This code is unexpectedly slow. Diagnose the inlining failure.

```java
interface Hasher {
    int hash(String key);
}

class MurmurHasher implements Hasher {
    public int hash(String key) { /* 80 bytes of bytecode */ return murmur3(key); }
}
class XXHasher implements Hasher {
    public int hash(String key) { /* 90 bytes of bytecode */ return xxhash(key); }
}
class CityHasher implements Hasher {
    public int hash(String key) { /* 75 bytes of bytecode */ return cityhash(key); }
}

void processKeys(Hasher hasher, String[] keys) {
    for (String key : keys) {
        int h = hasher.hash(key);  // Why is this slow?
        // ... use h ...
    }
}

// This is called with all three Hasher implementations at different times.

// Diagnosis:
// 1. MEGAMORPHIC call site: 3 types seen at hasher.hash(key)
//    → JIT cannot inline. Virtual dispatch via vtable every iteration.
//    → ~5-10ns overhead per call (vtable lookup + indirect branch)
//
// 2. Without inlining:
//    - No escape analysis on intermediate objects inside hash()
//    - No constant folding of hash constants
//    - No dead code elimination of unused intermediate results
//    - The method call itself prevents loop unrolling
//
// 3. Even if it were bimorphic (2 types), the hash methods are 75-90 bytes
//    of bytecode — larger than MaxInlineSize=35 (for cold paths)
//    For hot paths, FreqInlineSize=325 would allow them.
//    But megamorphic → no inlining attempt regardless of size.
//
// Fixes:
// Option A: Use a single concrete class
//   class ConfigurableHasher {
//       enum Strategy { MURMUR, XX, CITY }
//       Strategy strategy;
//       int hash(String key) {
//           switch (strategy) { ... }
//       }
//   }
//   Now there is only 1 type → monomorphic → inlined.
//   The switch inside is well-predicted (strategy does not change per call).
//
// Option B: Separate hot loops per hasher type
//   if (hasher instanceof MurmurHasher mh) {
//       for (String key : keys) mh.hash(key);  // monomorphic!
//   } else if (hasher instanceof XXHasher xh) {
//       for (String key : keys) xh.hash(key);  // monomorphic!
//   } ...
//   Each loop is monomorphic → JIT inlines each hash implementation.
//
// Option C: Accept the overhead
//   For hasher methods that take >100ns (complex computation),
//   the 5-10ns vtable overhead is negligible. Only optimize if
//   the hash function itself is very fast (<20ns).
```

---

**P21.13** [E] -- JIT Intrinsic Identification

Which of these methods are JIT intrinsics (replaced with hand-optimized assembly)?

```java
// 1. Math.max(a, b)
// → YES. Compiled to CMOV (conditional move) instruction. No branch.

// 2. Integer.numberOfLeadingZeros(x)
// → YES. Compiled to BSR (bit scan reverse) or LZCNT instruction.
// Single cycle on modern CPUs.

// 3. Arrays.sort(int[])
// → PARTIALLY. The overall algorithm (dual-pivot quicksort) is not intrinsified,
// but internal operations like element swaps and comparisons are optimized.
// System.arraycopy() used inside IS an intrinsic.

// 4. String.hashCode()
// → NO (as of JDK 17). The hash computation loop is JIT-compiled normally,
// but it benefits from loop unrolling and auto-vectorization.
// String.equals() IS an intrinsic (SIMD comparison).

// 5. Object.getClass()
// → YES. Compiled to a direct memory read of the klass pointer in the
// object header. No method call overhead.

// 6. Thread.currentThread()
// → YES. Reads directly from the thread-local storage register (r15 on x86-64).
// Zero overhead — the current thread pointer is always in a register.

// 7. System.arraycopy(src, 0, dest, 0, len)
// → YES. Compiled to REP MOVSQ (for long/double arrays) or
// vectorized memcpy using AVX2/AVX-512. Copies 32-64 bytes per cycle.

// 8. Math.log(x)
// → NO. FPU instruction (fyl2x or lookup table + polynomial approximation).
// It is a native method but not intrinsified to a single instruction.
// Still fast (~20ns) but not as trivially replaced as Math.max.

// 9. Integer.bitCount(x)
// → YES. Compiled to POPCNT instruction (if CPU supports it).
// 1 cycle, 1 instruction. The pure-Java fallback is ~15 instructions.

// 10. Unsafe.compareAndSwapInt(obj, offset, expected, newValue)
// → YES. Compiled to LOCK CMPXCHG instruction. This IS the CAS operation
// that AtomicInteger, ConcurrentHashMap, and all lock-free structures use.
```

---

**P21.14** [E] -- Branch Prediction Analysis

Predict which version is faster and by how much:

```java
int[] data = new int[1_000_000];  // random values 0-255

// Version A: unpredictable branch
long sumA = 0;
for (int val : data) {
    if (val > 128) {  // ~50% taken — unpredictable
        sumA += val;
    }
}

// Version B: branchless equivalent
long sumB = 0;
for (int val : data) {
    // (val > 128) evaluates to 0 or 1
    // When false (0): val * 0 = 0 → nothing added
    // When true (1): val * 1 = val → val added
    sumB += val * ((val > 128) ? 1 : 0);
    // The JIT compiles (val > 128) ? 1 : 0 to:
    //   CMP val, 128
    //   SETG al      (set al to 1 if greater, 0 otherwise)
    //   MOVZX eax, al (zero-extend to int)
    // Then: IMUL eax, val; ADD sumB, eax
    // No branch! No misprediction penalty.
}

// Analysis:
// Version A with random data:
//   ~50% branch mispredictions
//   1M iterations × 50% × ~15 cycles penalty = 7.5M wasted cycles
//   At 4 GHz: ~1.9 ms of misprediction overhead alone
//   Total: ~3-5 ms

// Version B (branchless):
//   No branches → no mispredictions
//   Slight overhead from multiply (1 cycle) and extra SETG instruction
//   Total: ~0.5-1.0 ms

// Speedup: ~3-5x for random data
//
// BUT: if data were sorted:
//   Version A: branch predictor has >99.9% accuracy
//   Version A: ~0.5-1.0 ms (predictor works perfectly)
//   Version B: ~0.5-1.0 ms (same — no branch to predict either way)
//   → No difference when branches are predictable!
//
// Rule: branchless only helps when branches are unpredictable.
```

---

**P21.15** [E] -- Autoboxing Trap

How many Integer objects are created in this code?

```java
Map<Integer, Integer> map = new HashMap<>();
for (int i = 0; i < 10_000; i++) {
    map.put(i, i * i);
}

// Answer:
// map.put(i, i * i) autoboxes both the key (i) and the value (i*i).
//
// Keys (i from 0 to 9999):
//   i = 0 to 127: Integer.valueOf() returns cached instances → 0 new objects
//   i = 128 to 9999: new Integer() each time → 9,872 new objects
//   Total key objects created: 9,872
//
// Values (i*i from 0 to 99,980,001):
//   i*i = 0 (i=0): cached → 0 new
//   i*i = 1 (i=1): cached → 0 new
//   ...
//   i*i = 121 (i=11): cached → 0 new
//   i*i = 144 (i=12): NOT cached (144 > 127) → new object
//   ...all subsequent values > 127 → new objects
//   i = 0 to 11: i*i is in [0, 121] → cached (12 values)
//   i = 12 to 9999: i*i > 127 → new objects (9,988 values)
//   Total value objects created: 9,988
//
// But wait — some values equal keys that were already cached:
//   i=0: key=0 (cached), value=0 (same cached instance!)
//   This doesn't matter for object count — we count CREATIONS, not live objects.
//
// Grand total new Integer objects: 9,872 (keys) + 9,988 (values) = 19,860
//
// PLUS: HashMap.Node objects: 10,000 (one per entry)
// PLUS: Node[] table resizes: initial 16 → 32 → 64 → ... → 16,384
//   Each resize creates a new Node[] and discards the old one.
//   Number of resizes: log2(16384/16) = 10 resizes
//   Each creates a Node[] of increasing size → ~10 discarded arrays
//
// Optimization: new HashMap<>((int)(10000 / 0.75) + 1) → 0 resizes
```

---

**P21.16** [M] -- Stream Boxing Analysis

Rewrite this to eliminate all boxing:

```java
// ORIGINAL — boxing everywhere:
List<Integer> prices = getPrices();  // returns List<Integer>
double avgAbove100 = prices.stream()
    .filter(p -> p > 100)           // p unboxed for comparison, but result is Stream<Integer>
    .mapToDouble(p -> p * 1.1)      // p unboxed, result is DoubleStream (good!)
    .average()
    .orElse(0.0);

// IMPROVED — minimize boxing:
double avgAbove100 = prices.stream()
    .mapToInt(Integer::intValue)    // unbox ONCE to IntStream
    .filter(p -> p > 100)           // int comparison, no boxing
    .mapToDouble(p -> p * 1.1)      // int → double, no boxing
    .average()
    .orElse(0.0);

// EVEN BETTER — if you control the data source:
int[] pricesArray = getPricesArray();  // return int[] instead of List<Integer>
double avgAbove100 = IntStream.of(pricesArray)
    .filter(p -> p > 100)
    .mapToDouble(p -> p * 1.1)
    .average()
    .orElse(0.0);
// ZERO boxing throughout the entire pipeline.

// BEST for known data — avoid streams entirely:
int[] prices = getPricesArray();
double sum = 0;
int count = 0;
for (int p : prices) {
    if (p > 100) {
        sum += p * 1.1;
        count++;
    }
}
double avgAbove100 = count > 0 ? sum / count : 0.0;
// Plain loop: no boxing, no stream overhead, no lambda overhead,
// JIT can auto-vectorize and unroll the loop.
// For 1M elements: ~2x faster than the IntStream version.
```

---

**P21.17** [H] -- Escape Analysis Defeat Patterns

Explain why escape analysis fails in each case and suggest a fix:

```java
// Case 1: Object stored in array
public void bfsTraversal(int[][] grid, int startRow, int startCol) {
    Queue<int[]> queue = new ArrayDeque<>();
    queue.add(new int[]{startRow, startCol});  // ESCAPES: stored in ArrayDeque's Object[]

    while (!queue.isEmpty()) {
        int[] pos = queue.poll();
        int r = pos[0], c = pos[1];
        // ... process and add neighbors:
        queue.add(new int[]{r + 1, c});  // ESCAPES every iteration
        queue.add(new int[]{r, c + 1});  // ESCAPES
    }
}

// Why EA fails: ArrayDeque stores elements in an Object[] array.
// Any object stored in an array escapes (the array itself may escape,
// and the JIT cannot track individual array element lifetimes).

// Fix: Encode coordinates as a single long (no object allocation):
public void bfsTraversal(int[][] grid, int startRow, int startCol) {
    ArrayDeque<Long> queue = new ArrayDeque<>();  // still boxes Long, but...
    queue.add(encode(startRow, startCol));

    while (!queue.isEmpty()) {
        long pos = queue.poll();  // unboxing
        int r = decodeRow(pos), c = decodeCol(pos);
        queue.add(encode(r + 1, c));
        queue.add(encode(r, c + 1));
    }
}

static long encode(int row, int col) { return ((long) row << 32) | (col & 0xFFFFFFFFL); }
static int decodeRow(long encoded) { return (int) (encoded >> 32); }
static int decodeCol(long encoded) { return (int) encoded; }

// Even better: use an IntArrayDeque from a primitive collections library,
// encoding both coordinates into a single int (if grid < 65536 × 65536).

// ────────────────────────────────────────────────────────────────

// Case 2: Object passed to non-inlined method
public int computeScore(int x, int y) {
    Score s = new Score(x, y);
    return ExternalLibrary.evaluate(s);  // not inlined (third-party, too large, or native)
}

// Why EA fails: evaluate() is not inlined, so the JIT cannot prove
// that s is not stored in a field or static variable inside evaluate().
// Conservative assumption: s escapes.

// Fix A: Inline manually — copy the relevant logic from ExternalLibrary
// Fix B: Pass primitives instead of objects:
//   return ExternalLibrary.evaluate(x, y);  // no object to escape
// Fix C: Use a method reference with @ForceInline (JDK internal)
//   Not available to application code, but JDK classes use it.

// ────────────────────────────────────────────────────────────────

// Case 3: Megamorphic call defeats inlining, which defeats EA
public double computeArea(Shape shape) {
    // If Shape has 3+ implementations at this call site: megamorphic
    // shape.area() is NOT inlined
    // Any object created inside area() is NOT escape-analyzed
    // from the perspective of computeArea()
    return shape.area();
}

// Fix: Reduce polymorphism at hot call sites.
// Use the "profile pollution" avoidance pattern:
// Separate hot monomorphic paths from cold polymorphic paths.
//
// Instead of one method called with many types:
//   processAll(List<Shape> shapes) { for (Shape s : shapes) s.area(); }
//
// Split by type:
//   processCircles(List<Circle> circles) { ... }  // monomorphic
//   processRects(List<Rectangle> rects) { ... }    // monomorphic
```

---

### Optimization and Benchmarking

**P21.18** [M] -- HashMap Pre-sizing

A method processes exactly 50,000 records and stores results in a HashMap. Calculate the optimal initial capacity and compare memory/time with the default.

```java
// DEFAULT (no pre-sizing):
Map<String, Result> results = new HashMap<>();
// Initial capacity: 16, threshold: 12
// Resizes: 16→32→64→128→256→512→1024→2048→4096→8192→16384→32768→65536
// That is 12 resizes, each copying all existing entries!
// At the last resize (32768 → 65536):
//   Allocating a Node[65536] array: ~262 KB
//   Rehashing ~40,000 entries: iterating all of them
//   The old Node[32768] becomes garbage: ~131 KB GC pressure

// PRE-SIZED:
Map<String, Result> results = new HashMap<>(50_000 * 4 / 3 + 1);
// = new HashMap<>(66_668)
// tableSizeFor(66_668) = 131_072 (next power of 2: 2^17)
// threshold = 131_072 × 0.75 = 98_304
// Room for 98,304 entries without resize — 50,000 fits with room to spare

// Wait — that allocated 131,072 slots for 50,000 entries. Is 66% empty too wasteful?
// Let's check: new HashMap<>(50_000 * 4 / 3 + 1) → capacity 131,072
// Better: new HashMap<>((int)(50_000 / 0.75) + 1) → same result
// Even better: new HashMap<>(50_001 * 4 / 3 + 1) is equivalent

// Alternative: accept one resize
// new HashMap<>(50_000) → capacity 65,536, threshold 49,152
// At 49,153rd entry → resize to 131,072
// Only 1 resize instead of 12, and it happens near the end.
// Starting capacity 65,536 uses half the memory upfront.

// Memory comparison:
// Default path: 12 transient Node[] arrays created and discarded
//   GC pressure from discarded arrays: ~500 KB total
//   Final Node[] size: same (65,536 slots, since 50K > 49152 threshold)
// Pre-sized path: 1 Node[] array created, never discarded
//   Zero GC pressure from resizing

// Time comparison for 50,000 puts:
// Default: ~2.5 ms (includes 12 resize-and-rehash operations)
// Pre-sized: ~1.8 ms (no resizing)
// Pre-sizing: ~30% faster for the puts themselves
```

---

**P21.19** [E] -- Primitive Collection Comparison

Compare the memory usage of HashMap<Integer, Double> vs a primitive IntDoubleHashMap for 1 million entries.

```java
// HashMap<Integer, Double> with 1M entries:
//
// Node[] table:
//   Capacity: tableSizeFor(1M / 0.75) = 2,097,152 slots
//   Size: 16 + 2,097,152 × 4 = ~8.4 MB (compressed refs)
//
// 1M HashMap.Node objects:
//   32 bytes each = 32 MB
//
// 1M Integer keys:
//   16 bytes each = 16 MB (most above cache range 127)
//
// 1M Double values:
//   24 bytes each = 24 MB (object header 12 + double 8 + padding 4)
//
// Total: 8.4 + 32 + 16 + 24 = ~80.4 MB
// Objects: ~3M (Nodes + Integers + Doubles)

// Eclipse Collections IntDoubleHashMap with 1M entries (open addressing):
//
// int[] keys:
//   Capacity: ~1.5M (load factor ~0.67 for open addressing)
//   Size: 16 + 1,500,000 × 4 = ~6 MB
//
// double[] values:
//   Size: 16 + 1,500,000 × 8 = ~12 MB
//
// boolean[] (or bit array) for occupied slots:
//   ~200 KB
//
// Total: 6 + 12 + 0.2 = ~18.2 MB
// Objects: 4 (map + 2 arrays + state tracking)

// Savings: 80.4 / 18.2 = 4.4x less memory
// GC: 3M objects vs 4 objects — GC overhead reduced by ~99.99%
// Cache: parallel int[] and double[] are sequential → cache-friendly
```

---

**P21.20** [M] -- G1 Humongous Object Problem

This application creates large temporary buffers and experiences frequent Full GCs. Diagnose and fix.

```java
// Application code:
void processRequest(byte[] requestData) {
    // Create a temporary buffer for processing
    byte[] buffer = new byte[8 * 1024 * 1024];  // 8 MB buffer

    // Process into buffer
    System.arraycopy(requestData, 0, buffer, 0, requestData.length);
    transform(buffer);
    sendResponse(buffer);
    // buffer becomes garbage after method returns
}
// Called 1000 times per second

// Problem diagnosis with GC logs:
// -Xlog:gc*:file=gc.log:time,uptime,level,tags
//
// [gc,humongous] Humongous allocation size: 8388608 bytes
// [gc,humongous] Region size: 4194304 bytes (4 MB)
// [gc] GC(42) Full GC (G1 Humongous Allocation)
//
// Root cause:
// G1 region size = heap_size / 2048
// For a 4 GB heap: 4 GB / 2048 = 2 MB regions
// Humongous threshold: 50% of region = 1 MB
// An 8 MB buffer needs 4 contiguous regions!
//
// Humongous objects are:
// 1. Allocated directly in old gen (bypass young gen)
// 2. Only collected during concurrent marking or Full GC
// 3. Require contiguous free regions (fragmentation-sensitive)
// 4. At 1000/sec: 1000 humongous allocations per second → frequent Full GC

// Fix 1: Increase G1 region size
// -XX:G1HeapRegionSize=16m
// Now threshold = 8 MB → 8 MB buffers are NOT humongous
// They go to eden → collected in young GC → fast

// Fix 2: Pool the buffers (avoid repeated allocation)
private static final ThreadLocal<byte[]> BUFFER_POOL =
    ThreadLocal.withInitial(() -> new byte[8 * 1024 * 1024]);

void processRequest(byte[] requestData) {
    byte[] buffer = BUFFER_POOL.get();  // reuse buffer
    Arrays.fill(buffer, (byte) 0);       // clear (security)
    System.arraycopy(requestData, 0, buffer, 0, requestData.length);
    transform(buffer);
    sendResponse(buffer);
    // buffer is NOT garbage — it stays in the ThreadLocal
}
// Zero allocation per request. Buffer is long-lived → promoted to old gen once.

// Fix 3: Use off-heap (direct ByteBuffer)
void processRequest(byte[] requestData) {
    ByteBuffer buffer = ByteBuffer.allocateDirect(8 * 1024 * 1024);
    buffer.put(requestData);
    transformDirect(buffer);
    sendResponseDirect(buffer);
    // Direct buffers are off-heap — invisible to GC entirely
    // But: allocateDirect is slow (~microseconds). Pool these too.
}

// Fix 4: Use smaller buffers if possible
// Process in chunks of 1 MB (below humongous threshold) instead of 8 MB.
```

---

**P21.21** [H] -- JMH Benchmark Design

Design a JMH benchmark to compare HashMap vs TreeMap vs ConcurrentHashMap for read-heavy workloads (95% reads, 5% writes) with varying key distribution.

```java
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.MICROSECONDS)
@State(Scope.Benchmark)   // shared across threads → tests true concurrency
@Fork(3)
@Warmup(iterations = 5, time = 2)
@Measurement(iterations = 5, time = 2)
public class MapReadHeavyBenchmark {

    @Param({"HashMap", "TreeMap", "ConcurrentHashMap"})
    private String mapType;

    @Param({"UNIFORM", "ZIPFIAN", "SEQUENTIAL"})
    private String distribution;

    @Param({"4"})  // threads
    private int threadCount;

    private Map<Integer, Integer> map;
    private int[] readKeys;   // pre-generated read keys
    private int[] writeKeys;  // pre-generated write keys
    private int mapSize = 1_000_000;

    @Setup(Level.Trial)
    public void setup() {
        // Create and populate the map
        switch (mapType) {
            case "HashMap" -> map = Collections.synchronizedMap(new HashMap<>(mapSize * 4 / 3 + 1));
            case "TreeMap" -> map = Collections.synchronizedSortedMap(new TreeMap<>());
            case "ConcurrentHashMap" -> map = new ConcurrentHashMap<>(mapSize * 4 / 3 + 1);
        }
        for (int i = 0; i < mapSize; i++) {
            map.put(i, i);
        }

        // Pre-generate key distribution
        Random rng = new Random(42);
        readKeys = new int[1_000_000];
        writeKeys = new int[1_000_000];
        for (int i = 0; i < readKeys.length; i++) {
            readKeys[i] = generateKey(distribution, rng, mapSize);
            writeKeys[i] = generateKey(distribution, rng, mapSize);
        }
    }

    private int generateKey(String dist, Random rng, int range) {
        return switch (dist) {
            case "UNIFORM" -> rng.nextInt(range);
            case "ZIPFIAN" -> (int)(range * Math.pow(rng.nextDouble(), 2));  // simplified Zipf
            case "SEQUENTIAL" -> rng.nextInt(range);  // sequential batches would be better
            default -> rng.nextInt(range);
        };
    }

    @State(Scope.Thread)
    public static class ThreadState {
        int readIndex = 0;
        int writeIndex = 0;
    }

    @Benchmark
    @Group("readHeavy")
    @GroupThreads(19)  // 95% of 20 = 19 reader threads
    public Integer read(ThreadState ts) {
        int key = readKeys[ts.readIndex++ % readKeys.length];
        return map.get(key);
    }

    @Benchmark
    @Group("readHeavy")
    @GroupThreads(1)  // 5% of 20 = 1 writer thread
    public Integer write(ThreadState ts) {
        int key = writeKeys[ts.writeIndex++ % writeKeys.length];
        return map.put(key, key + 1);
    }
}

// Expected results:
//
// ConcurrentHashMap: highest throughput for read-heavy workloads
//   - Lock-free reads (no synchronization for get())
//   - Lock-striped writes (per-bucket granularity)
//   - UNIFORM and ZIPFIAN: similar read performance
//   - ~10-50M reads/sec with 19 threads
//
// HashMap (synchronized): lower throughput
//   - Single global lock for ALL operations
//   - Readers block each other (even though reads are safe)
//   - ~1-5M reads/sec (limited by lock contention)
//
// TreeMap (synchronized): lowest throughput
//   - Same lock contention as HashMap
//   - O(log n) per operation vs O(1) for HashMap
//   - ~0.5-2M reads/sec
//
// Key insight: for read-heavy concurrent workloads, ConcurrentHashMap
// is 5-10x faster than synchronized HashMap, because reads do not
// need any synchronization at all.
```

---

**P21.22** [M] -- String Deduplication Impact

Estimate the memory savings from string deduplication for this application:

```java
// Application: web server that logs HTTP requests
// Each request creates:
//   - Method string: "GET", "POST", "PUT", "DELETE" (4 unique values)
//   - Content-Type header: "application/json", "text/html", etc. (~20 unique values)
//   - User-Agent header: ~5000 unique values (many duplicates among users)
//   - URL path: ~100,000 unique values

// 1 million requests processed, keeping recent 100K requests in memory:

// Without dedup:
// method: 100,000 × String object (48 bytes) = 4.8 MB
//   But only 4 unique values → 99,996 duplicate strings
// contentType: 100,000 × String (avg 64 bytes) = 6.4 MB
//   But only ~20 unique → 99,980 duplicates
// userAgent: 100,000 × String (avg 120 bytes) = 12 MB
//   ~5000 unique → ~95,000 duplicates
// urlPath: 100,000 × String (avg 80 bytes) = 8 MB
//   ~50,000 unique in 100K requests → ~50,000 duplicates

// G1 String Deduplication savings:
// method: 4 unique byte[] + 99,996 strings sharing those 4 byte[]
//   Savings: ~4.7 MB (99.6% of strings share backing arrays)
// contentType: ~20 unique byte[] shared
//   Savings: ~6.2 MB
// userAgent: ~5000 unique byte[] shared among ~100K strings
//   Before: 100K × avg 108 byte[] = 10.8 MB in byte[]
//   After: 5K × avg 108 = 540 KB + 95K strings with shared backing
//   Savings: ~10.3 MB
// urlPath: ~50K unique → savings from ~50K duplicates
//   Savings: ~4 MB

// Total estimated savings: ~25 MB out of ~31 MB = ~80% reduction
// in byte[] backing array memory.
//
// NOTE: String dedup does NOT eliminate the String objects themselves
// (the 40-48 byte shell). It only deduplicates the internal byte[] arrays.
// So the String objects still consume: 100K × 4 strings × ~48 bytes = ~19 MB
// The byte[] dedup saves: ~25 MB
//
// Additional note: String.intern() would be more aggressive (eliminates
// the String objects themselves for truly interned strings), but has
// overhead (hashtable lookup) and can cause memory leaks if not careful.
//
// Best practice for this case:
// Intern known constants: "GET", "POST", content types
// Let G1 dedup handle user agents and URLs automatically
```

---

**P21.23** [E] -- GC Collector Selection

For each scenario, which GC is optimal and why?

```java
// Scenario 1: Microservice, 2 GB heap, 100ms max latency SLA
// Answer: G1 GC (-XX:+UseG1GC, default since JDK 9)
//   - Default, well-tuned for 2-8 GB heaps
//   - Max pause target: -XX:MaxGCPauseMillis=50 (set to half of SLA)
//   - Pause times: typically 10-50ms for 2 GB heap
//   - ZGC is overkill for this small a heap

// Scenario 2: Trading platform, 64 GB heap, 1ms max latency
// Answer: ZGC (-XX:+UseZGC)
//   - Sub-millisecond pauses regardless of heap size
//   - Handles 64 GB+ easily
//   - Pause time: <1ms (typically 200-500 us)
//   - Tradeoff: ~5% throughput overhead from load barriers

// Scenario 3: Batch processing, 16 GB heap, throughput matters, latency does not
// Answer: Parallel GC (-XX:+UseParallelGC)
//   - Optimized for throughput (minimize total GC time)
//   - Pause times: 500ms-5s (but rare, and batch jobs can tolerate this)
//   - Higher throughput than G1 for bulk processing
//   - Or: G1 with -XX:MaxGCPauseMillis=5000 (relaxed pause target)

// Scenario 4: Container, 512 MB heap, startup time matters
// Answer: Serial GC (-XX:+UseSerialGC)
//   - Lowest overhead for tiny heaps
//   - Single-threaded GC = less memory for GC threads
//   - Fastest startup (no parallel GC thread initialization)
//   - Or: G1 with -XX:+UseG1GC is also fine at 512 MB since JDK 17

// Scenario 5: Large in-memory cache, 256 GB heap, mixed reads/writes
// Answer: ZGC
//   - Scales to 16 TB heap with sub-ms pauses
//   - Concurrent marking and compaction
//   - Handles the massive object graph without proportional pause increases
//   - Shenandoah is also viable (slightly higher pauses but lower throughput overhead)
```

---

**P21.24** [H] -- Off-Heap Cache Design

Design an off-heap LRU cache for 10 million entries with String keys and byte[] values. Explain the memory layout and access patterns.

```java
// Architecture:
//
// On-heap component (small, GC-friendly):
//   - ConcurrentHashMap<String, Long> index
//     Maps keys to off-heap addresses
//     ~10M entries × ~100 bytes = ~1 GB on-heap
//
// Off-heap component (large, no GC):
//   - Pre-allocated memory region via Panama MemorySegment (or ByteBuffer.allocateDirect)
//   - Fixed-size slots with slab allocation
//
// Off-heap slot layout:
// ┌────────────────────────────────────────────────────────┐
// │ Slot (fixed 512 bytes)                                  │
// │  ┌──────────────┬──────────────┬────────────────────┐  │
// │  │ prev_offset  │ next_offset  │ key_length (2B)    │  │
// │  │ (8 bytes)    │ (8 bytes)    │                    │  │
// │  ├──────────────┴──────────────┤ value_length (4B)  │  │
// │  │ key_bytes (var, max 128)    │ access_time (8B)   │  │
// │  │ value_bytes (var, max ~350) │                    │  │
// │  │ padding to 512 bytes        │                    │  │
// │  └─────────────────────────────┴────────────────────┘  │
// └────────────────────────────────────────────────────────┘
//
// Total off-heap: 10M × 512 = 5 GB
// LRU linked list: prev_offset/next_offset form a doubly-linked list
//                  entirely in off-heap memory

public class OffHeapLRUCache implements AutoCloseable {
    private static final int SLOT_SIZE = 512;
    private static final int MAX_KEY_LENGTH = 128;
    private static final int HEADER_SIZE = 30;  // prev(8)+next(8)+keyLen(2)+valLen(4)+time(8)

    private final Arena arena;
    private final MemorySegment slab;
    private final ConcurrentHashMap<String, Long> index;
    private final int maxEntries;

    // LRU head/tail (off-heap offsets)
    private long lruHead = -1;  // most recently used
    private long lruTail = -1;  // least recently used

    public OffHeapLRUCache(int maxEntries) {
        this.maxEntries = maxEntries;
        this.arena = Arena.ofShared();
        this.slab = arena.allocate((long) maxEntries * SLOT_SIZE);
        this.index = new ConcurrentHashMap<>(maxEntries * 4 / 3 + 1);
    }

    public byte[] get(String key) {
        Long offset = index.get(key);
        if (offset == null) return null;

        // Read value from off-heap
        int keyLen = slab.get(ValueLayout.JAVA_SHORT, offset + 16);
        int valLen = slab.get(ValueLayout.JAVA_INT, offset + 18);
        byte[] value = new byte[valLen];
        MemorySegment.copy(slab, offset + HEADER_SIZE + keyLen, 
                          MemorySegment.ofArray(value), 0, valLen);

        // Move to head of LRU (most recently used)
        moveToHead(offset);
        return value;
    }

    public void put(String key, byte[] value) {
        if (index.size() >= maxEntries) {
            evictLRU();  // remove least recently used
        }
        long offset = allocateSlot();
        writeEntry(offset, key, value);
        index.put(key, offset);
        addToHead(offset);
    }

    private void evictLRU() {
        // Read key from tail slot, remove from index and LRU list
        long tailOffset = lruTail;
        String tailKey = readKeyFromSlot(tailOffset);
        index.remove(tailKey);
        removeFromList(tailOffset);
        freeSlot(tailOffset);
    }

    @Override
    public void close() {
        arena.close();  // frees all off-heap memory
    }
}

// Benefits:
// 1. GC only sees ~1 GB (the ConcurrentHashMap index)
//    The 5 GB of actual data is invisible to GC
// 2. Sub-ms GC pauses even with 10M entries
// 3. Deterministic memory usage (no fragmentation surprises)
//
// Tradeoffs:
// 1. Serialization overhead: must convert String → bytes and back
// 2. No automatic memory management (must handle eviction manually)
// 3. More complex code than a simple HashMap cache
// 4. Fixed slot size wastes space for small values (but avoids fragmentation)
//
// Production alternatives:
// - Chronicle Map: off-heap, concurrent, persistent
// - Caffeine with off-heap tier (via Ohcache)
// - Apache Ignite: distributed off-heap cache
```

---

**P21.25** [M] -- Disruptor vs BlockingQueue Analysis

Explain each performance advantage of the Disruptor over ArrayBlockingQueue:

```java
// Dimension 1: Synchronization
//
// ArrayBlockingQueue:
//   put(): lock.lockInterruptibly() → putIndex++ → notEmpty.signal() → lock.unlock()
//   take(): lock.lockInterruptibly() → takeIndex++ → notFull.signal() → lock.unlock()
//   Lock acquisition: even uncontended ReentrantLock does CAS + memory fence
//   Under contention: thread parking (kernel transition ~5-10 us)
//
// Disruptor:
//   publish(): sequence.compareAndSet() → single CAS, no lock
//   consume(): check sequence >= expected → volatile read, no CAS
//   Wait strategy: BusySpinWaitStrategy → no kernel transition at all
//   No condition variables, no signal/await

// Dimension 2: Memory allocation
//
// ArrayBlockingQueue:
//   put(new Event(...)): caller creates a new Event object per message
//   take() returns the Event, which becomes garbage after processing
//   Result: N messages = N allocations + N GC'd objects
//
// Disruptor:
//   Events pre-allocated at ring buffer creation
//   publish: ring.get(seq).setData(...)  // mutate existing event
//   consume: ring.get(seq).getData()     // read existing event
//   Result: 0 allocations during operation, 0 GC pressure

// Dimension 3: Cache behavior
//
// ArrayBlockingQueue:
//   Object[] items — array of references, each pointing to an Event on heap
//   Sequential access to items[takeIndex] → cache hit for the reference
//   But dereferencing → Event object somewhere else on heap → cache miss
//   takeIndex and putIndex may be on same cache line → false sharing
//
// Disruptor:
//   Event[] — array of pre-allocated Event objects
//   Events are allocated contiguously (allocated in sequence during init)
//   Sequential consumption: event[seq], event[seq+1], event[seq+2]...
//   → hardware prefetcher anticipates next event → cache hit
//   Sequence counters padded to separate cache lines → no false sharing

// Dimension 4: Batching
//
// ArrayBlockingQueue:
//   take() returns one element at a time
//   To batch: drainTo(collection, maxElements) — but still locks per drain
//
// Disruptor:
//   Consumer can batch: availableSequence = sequencer.getHighestPublished()
//   Process everything from lastConsumed+1 to availableSequence in one batch
//   Single volatile read → process N events → single volatile write
//   Amortizes synchronization cost over N events

// Summary:
// ABQ: lock per op + allocation per op + cache miss per op + no batching
// Disruptor: CAS per op + 0 allocation + cache hit per op + natural batching
// Result: 10-100x throughput improvement
```

---

**P21.26** [M] -- JMH Pitfall Identification

Identify the benchmarking mistakes:

```java
// MISTAKE 1: Dead code elimination
@Benchmark
public void testSort() {
    int[] arr = data.clone();
    Arrays.sort(arr);
    // arr is never used → JIT eliminates Arrays.sort() and clone()!
}
// FIX: return arr; or use Blackhole: bh.consume(arr);

// MISTAKE 2: Constant folding
@Benchmark
public int testCompute() {
    return fibonacci(30);  // fibonacci(30) is always 832040
    // The JIT computes this ONCE and returns the constant forever!
}
// FIX: use @State to provide varying inputs
// @Param({"10", "20", "30"}) int input;

// MISTAKE 3: Loop optimization
@Benchmark
public long testSum() {
    long sum = 0;
    for (int i = 0; i < 1000; i++) {
        sum += i;
    }
    return sum;
    // JIT compiles this to: return 499500; (sum formula applied at compile time)
}
// FIX: use data from @State that the JIT cannot predict

// MISTAKE 4: No warmup
// Running with @Warmup(iterations = 0) — measuring interpreter performance!
// The JIT needs thousands of invocations to compile and optimize.
// Default 5 warmup iterations of 1 second each is usually sufficient.

// MISTAKE 5: Single fork
// @Fork(1) — the JIT from previous benchmarks pollutes this one.
// Profile data from Benchmark A affects Benchmark B's compilation.
// Use @Fork(3) minimum — each fork is a fresh JVM.

// MISTAKE 6: Measuring in main()
public static void main(String[] args) {
    long start = System.nanoTime();
    myBenchmark();
    long time = System.nanoTime() - start;
    System.out.println(time);
}
// Problems: no warmup, no fork, no statistical analysis, nanoTime overhead,
// System.nanoTime() granularity (~30ns on some platforms means you cannot
// measure sub-30ns operations), dead code elimination of myBenchmark().

// CORRECT JMH template:
@Benchmark
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.NANOSECONDS)
@Fork(3)
@Warmup(iterations = 5, time = 1)
@Measurement(iterations = 5, time = 1)
public int correctBenchmark(MyState state) {
    // Use state to prevent constant folding
    // Return result to prevent dead code elimination
    return computeSomething(state.input);
}
```

---

**P21.27** [H] -- Memory Layout Puzzle

Given this class hierarchy, calculate the exact object layout and size with JOL on JDK 17 (compressed OOPs enabled):

```java
class Base {
    long id;           // 8 bytes
    int type;          // 4 bytes
}

class Middle extends Base {
    boolean active;    // 1 byte
    Object ref;        // 4 bytes (compressed)
    short code;        // 2 bytes
}

class Derived extends Middle {
    double value;      // 8 bytes
    byte flags;        // 1 byte
}

// HotSpot field layout rules:
// 1. Superclass fields come first, in their own block
// 2. Within each class, fields are sorted by size (largest first)
// 3. The gap after the header (if any) can be filled by "field packing"
// 4. Fields from different classes DO NOT intermix (since JDK 15)
//    (Before JDK 15, subclass fields could fill gaps in superclass layout)
//
// Layout for Derived (JDK 17, compressed OOPs):
//
// Offset  Size  Source     Field
// ------  ----  ---------  ------
//   0      8    header     mark word
//   8      4    header     klass pointer (compressed)
//  12      4    Base       int type         ← fills 4-byte gap after header
//  16      8    Base       long id          ← 8-byte aligned
//  24      4    Middle     Object ref       ← reference (4 bytes compressed)
//  28      2    Middle     short code
//  30      1    Middle     boolean active
//  31      1    (padding)  alignment gap within Middle
//  32      8    Derived    double value     ← 8-byte aligned
//  40      1    Derived    byte flags
//  41      7    (padding)  align to 8-byte object boundary
// ------
// TOTAL: 48 bytes
//
// Without compressed OOPs:
//   0      8    header     mark word
//   8      8    header     klass pointer (uncompressed)
//  16      8    Base       long id          ← 8-byte aligned
//  24      4    Base       int type
//  28      4    (padding)  align to 8 for next 8-byte field? No — Middle has no 8-byte field
//  28      4    Middle     Object ref (8 bytes uncompressed) — wait, ref is 8 bytes now!
//
//  Let me redo without compressed OOPs:
//   0      8    header     mark word
//   8      8    header     klass pointer (uncompressed)
//  16      8    Base       long id
//  24      4    Base       int type
//  28      4    (padding)  align ref to 8
//  32      8    Middle     Object ref (uncompressed)
//  40      2    Middle     short code
//  42      1    Middle     boolean active
//  43      5    (padding)  align double to 8
//  48      8    Derived    double value
//  56      1    Derived    byte flags
//  57      7    (padding)  align to 8-byte boundary
// TOTAL: 64 bytes
//
// Compressed OOPs saves 16 bytes (48 vs 64) — 25% reduction.
```

---

**P21.28** [M] -- JIT Warm-Up Analysis

This service has slow responses for the first 30 seconds after deployment. Explain and fix.

```java
// Symptom: p99 latency is 50ms for first 30 seconds, then drops to 2ms.

// Root cause: JIT compilation is not instant.
// 1. First 10,000 invocations: method runs in interpreter (~10-50x slower)
// 2. Then C1 compiles (Tier 1-3): method runs faster but not optimal
// 3. After profiling data accumulates: C2 compiles (Tier 4): optimal speed
//
// For a complex request handler with 20+ methods in the call chain:
// Each method must individually reach its compilation threshold.
// Deep call chains delay full optimization.
//
// Additional delays:
// - Class loading: first request triggers loading hundreds of classes
// - Lambda metafactory: first lambda invocation generates bytecode on-the-fly
// - JIT compilation itself consumes CPU (compile threads compete with app threads)

// Fix 1: Warm-up route (most common)
@PostConstruct
public void warmUp() {
    // Send synthetic requests to trigger JIT compilation
    for (int i = 0; i < 20_000; i++) {
        processRequest(createSyntheticRequest());
    }
    // After 20K iterations, most methods are C2-compiled
    // Discard results — this is purely to trigger JIT
}

// Fix 2: CDS (Class Data Sharing)
// Pre-load classes at build time:
//   java -Xshare:dump -XX:SharedClassListFile=classes.list -XX:SharedArchiveFile=app.jsa
// At runtime:
//   java -Xshare:on -XX:SharedArchiveFile=app.jsa MyApp
// Saves ~1-2 seconds of class loading time.

// Fix 3: AOT compilation (GraalVM Native Image)
// Compile to native binary ahead of time → no JIT warmup needed
// native-image -jar myapp.jar → myapp (native binary)
// Startup: <100ms, but peak throughput may be lower than JIT-optimized code.

// Fix 4: Tiered compilation tuning
// -XX:Tier3CompileThreshold=500    (lower → faster C1 profiling)
// -XX:Tier4CompileThreshold=5000   (lower → faster C2 compilation)
// Tradeoff: less profile data → potentially worse C2 optimizations.

// Fix 5: Load balancer warm-up
// Use Kubernetes readiness probes that only pass after warm-up:
// readinessProbe:
//   httpGet: /health/ready
//   initialDelaySeconds: 30
// The pod does not receive traffic until warm-up is complete.
```

---

**P21.29** [M] -- Mechanical Sympathy Comparison

Rank these data structures by mechanical sympathy (cache-friendliness, GC-friendliness, prefetcher-friendliness) for a sequential scan of 1M elements:

```java
// Rank from best to worst for sequential scan:

// 1. int[] (primitive array)
//    Cache: contiguous 4 bytes per element, 16 elements per cache line
//    Prefetcher: perfect — sequential stride detected immediately
//    GC: 1 object, 0 references to trace
//    Throughput: ~4 GB/s per core (limited by L1 bandwidth)
//    Score: 10/10

// 2. int[][] flattened to int[] (flat matrix)
//    Same as int[] — contiguous, sequential, perfect
//    Score: 10/10

// 3. ArrayList<Integer> with sequential index access (get(i))
//    Cache: Object[] is contiguous, but each element is a reference to an Integer
//           on the heap. Two reads per element: ref from array + Integer object.
//           Integer objects may be sequential if allocated together (GC may compact)
//    Prefetcher: array references are sequential (prefetchable), but Integer
//                objects are at unpredictable addresses (not prefetchable)
//    GC: N+2 objects, N references
//    Score: 5/10

// 4. Integer[] (object array)
//    Same as ArrayList's internal Object[] — pointer chasing to Integer objects
//    Score: 5/10

// 5. LinkedList<Integer>
//    Cache: each Node is a separate object (24 bytes + header = ~40 bytes)
//           Each node.next points to another Node at an unpredictable address
//           Each node.item points to an Integer at another unpredictable address
//    Prefetcher: completely defeated — no detectable stride
//    GC: 2N+1 objects, 3N references (next + prev + item per node)
//    Access: TWO pointer chases per element (node.next, then node.item)
//    Score: 1/10

// 6. TreeMap<Integer, Integer> (in-order traversal)
//    Cache: tree nodes scattered across heap, binary tree traversal
//           follows left/right pointers at unpredictable addresses
//    Prefetcher: completely defeated
//    GC: 3N objects (entry + key + value), 5N+ references
//    Access: Tree traversal is NOT sequential — follows left/right links
//    Score: 1/10

// 7. HashMap<Integer, Integer> (iterate via entrySet)
//    Cache: iterates Node[] table sequentially (good), but follows
//           chains at unpredictable addresses (bad), and keys/values
//           are separate objects (bad)
//    Prefetcher: table access is sequential, but chain following is not
//    GC: 3N objects, 5N references
//    Score: 3/10 (better than LinkedList due to partially sequential table scan)
//
// Summary:
// Primitive arrays >> Object arrays > Hash tables > Trees ≈ Linked lists
```

---

**P21.30** [E] -- Identify the Optimization

Name the JIT optimization applied in each transformation:

```java
// Transformation 1:
// Before:
synchronized (new Object()) { x++; }
// After (JIT):
x++;
// Optimization: LOCK ELISION (new Object() does not escape → lock is meaningless)

// Transformation 2:
// Before:
Point p = new Point(a, b);
double d = Math.sqrt(p.x * p.x + p.y * p.y);
// After (JIT):
double d = Math.sqrt(a * a + b * b);
// Optimization: SCALAR REPLACEMENT (Point is decomposed into fields a, b)

// Transformation 3:
// Before:
for (int i = 0; i < arr.length; i++) {
    if (i < 0 || i >= arr.length) throw new AIOOBE();
    sum += arr[i];
}
// After (JIT):
for (int i = 0; i < arr.length; i++) {
    sum += arr[i];  // bounds check removed
}
// Optimization: RANGE CHECK ELIMINATION (loop guard proves i is in bounds)

// Transformation 4:
// Before:
list.get(i)  // where list is always ArrayList at this call site
// After (JIT):
((ArrayList)list).elementData[i]  // direct field access, no virtual dispatch
// Optimization: DEVIRTUALIZATION + INLINING (monomorphic call site)

// Transformation 5:
// Before:
for (int i = 0; i < 1000; i++) { sum += arr[i]; }
// After (JIT):
for (int i = 0; i < 1000; i += 4) {
    sum += arr[i] + arr[i+1] + arr[i+2] + arr[i+3];
}
// Optimization: LOOP UNROLLING (process multiple iterations per loop body)

// Transformation 6:
// Before:
int x = a * 8;
// After (JIT):
int x = a << 3;
// Optimization: STRENGTH REDUCTION (replace expensive operation with cheaper one)

// Transformation 7:
// Before:
boolean b = computeExpensiveCondition();
if (b) { doRareAction(); }
// After (JIT, profile shows b is almost always false):
if (b) { uncommonTrap(); }  // fast path assumes b=false, deoptimize if true
// Optimization: PROFILE-GUIDED OPTIMIZATION (speculative optimization based on runtime data)
```

---

**P21.31** [H] -- Full System Optimization

This production code processes 100K events per second but needs to handle 500K/sec. Profile and optimize it.

```java
// Original code:
class EventProcessor {
    private final Map<String, List<Handler>> handlers = new HashMap<>();

    void processEvent(Event event) {
        String type = event.getType();
        List<Handler> list = handlers.getOrDefault(type, Collections.emptyList());
        for (Handler h : list) {      // enhanced for creates Iterator
            Result r = h.handle(event); // polymorphic — many Handler implementations
            if (r.isSuccess()) {
                log(r);               // logging on hot path
            }
        }
    }
}

// OPTIMIZATION 1: Eliminate polymorphic dispatch
// handlers map likely has many Handler types → megamorphic h.handle()
// Fix: separate handlers by type, use arrays instead of lists
class EventProcessor {
    // Map to arrays of specific handler types where possible
    private final Handler[][] handlersByTypeOrdinal;  // indexed by event type ordinal

    // If you can control handler types, use concrete classes:
    private final FastHandler[] fastHandlers;
    private final SlowHandler[] slowHandlers;
    // Each loop is monomorphic → JIT inlines handle()
}

// OPTIMIZATION 2: Avoid Iterator allocation
// for (Handler h : list) creates an Iterator every invocation
// Fix: use indexed for loop on ArrayList, or use arrays
for (int i = 0; i < handlers.length; i++) {
    handlers[i].handle(event);  // no Iterator object
}

// OPTIMIZATION 3: Remove logging from hot path
// log(r) likely involves: String concatenation, IO, synchronization
// Fix: batch logs, use async logging (Log4j2 AsyncAppender), or
//      only log on failure (if logging is for debugging)
if (!r.isSuccess()) {
    asyncLogger.logFailure(r);  // log only failures, asynchronously
}

// OPTIMIZATION 4: Avoid HashMap lookup per event
// handlers.getOrDefault(type, ...) does: type.hashCode() → bucket lookup → equals()
// Fix: if event types are an enum, use an array indexed by ordinal
Handler[][] handlers = new Handler[EventType.values().length][];
// Access: handlers[event.getType().ordinal()] — array index, not hash lookup

// OPTIMIZATION 5: Pre-size and avoid boxing
// If Event has an int type code, avoid String type entirely
// String → int conversion per event is unnecessary

// OPTIMIZATION 6: Object reuse
// If Result is created per handler invocation:
//   Result r = h.handle(event);  // new Result every time
// Fix: make Handler write results into a pre-allocated Result object
//   h.handle(event, reusableResult);  // mutate instead of allocate

// OPTIMIZATION 7: Batch processing
// Instead of processing events one at a time:
//   for (Event e : events) processEvent(e);
// Batch by type:
//   Map<String, List<Event>> batched = groupByType(events);
//   for (var entry : batched.entrySet()) {
//       Handler[] h = handlers[entry.getKey()];
//       for (Event e : entry.getValue()) {
//           h.handle(e);  // monomorphic within each batch
//       }
//   }
// Batching improves: cache locality (same handlers hot in cache),
//                     JIT optimization (monomorphic dispatch per batch),
//                     and can enable SIMD vectorization if handlers are simple.

// Expected improvement: 3-5x throughput increase from these combined changes.
// The biggest wins are typically: eliminating megamorphic dispatch (#1),
// removing allocation from the hot path (#6), and async logging (#3).
```

---

**P21.32** [H] -- False Sharing in Real Code

The LongAdder benchmark below shows unexpected results. Explain why.

```java
// Benchmark State:
@State(Scope.Group)
public class AdderBenchmark {
    final AtomicLong atomicLong = new AtomicLong();
    final LongAdder longAdder = new LongAdder();
    final long[] manualCounters = new long[Runtime.getRuntime().availableProcessors()];
    // ↑ PROBLEM HERE

    @Benchmark @Group("atomic") @GroupThreads(4)
    public void atomicIncrement() { atomicLong.incrementAndGet(); }

    @Benchmark @Group("adder") @GroupThreads(4)
    public void adderIncrement() { longAdder.increment(); }

    @Benchmark @Group("manual") @GroupThreads(4)
    public void manualIncrement(ThreadState ts) {
        manualCounters[ts.threadIndex]++;
    }
}

// Expected: manual > adder > atomic
// Actual: adder > manual ≈ atomic   ← manual is as slow as atomic!

// Explanation:
// manualCounters = new long[8] (assuming 8 CPUs)
// Total size: 16 (header) + 8 × 8 (longs) = 80 bytes
// All 8 counters fit in TWO cache lines (64 + 16 bytes)
//
// Thread 0 writes manualCounters[0]: invalidates cache line → cores 1-3 stall
// Thread 1 writes manualCounters[1]: same cache line → core 0 stalls
// Thread 2 writes manualCounters[2]: same cache line → all others stall
// Thread 3 writes manualCounters[3]: same cache line
//
// This is FALSE SHARING in disguise! Each thread has "its own" counter,
// but they all share cache lines.
//
// LongAdder avoids this because its internal Cell class is @Contended:
//   @Contended static class Cell { volatile long value; }
// Each Cell is padded to its own cache line → no false sharing.
//
// Fix for manual:
final long[] manualCounters = new long[Runtime.getRuntime().availableProcessors() * 8];
// Now thread i uses manualCounters[i * 8] → 64-byte stride → separate cache lines

// After fix:
// manual (padded) > adder > atomic
// Because padded manual has zero CAS overhead (just a plain write),
// while LongAdder uses CAS internally (though rarely fails).
```

---

**P21.33** [M] -- Compressed OOP Mode Detection

Write code that detects whether compressed OOPs are enabled at runtime:

```java
// Method 1: Check JVM flags via ManagementFactory
import java.lang.management.ManagementFactory;
import java.lang.management.RuntimeMXBean;

public static boolean isCompressedOopsEnabled() {
    RuntimeMXBean runtimeMxBean = ManagementFactory.getRuntimeMXBean();
    List<String> args = runtimeMxBean.getInputArguments();

    // Check explicit flag
    for (String arg : args) {
        if (arg.equals("-XX:+UseCompressedOops")) return true;
        if (arg.equals("-XX:-UseCompressedOops")) return false;
    }

    // Default: enabled if heap <= ~32 GB
    long maxHeap = Runtime.getRuntime().maxMemory();
    return maxHeap < 32L * 1024 * 1024 * 1024;  // rough approximation
}

// Method 2: Use Unsafe to measure reference size
// (More reliable — tests actual behavior)
public static boolean detectCompressedOops() {
    try {
        Field f = Unsafe.class.getDeclaredField("theUnsafe");
        f.setAccessible(true);
        Unsafe unsafe = (Unsafe) f.get(null);

        // Measure offset between two adjacent reference fields
        // in an object with known layout
        class Probe {
            Object ref1;
            Object ref2;
        }
        long offset1 = unsafe.objectFieldOffset(Probe.class.getDeclaredField("ref1"));
        long offset2 = unsafe.objectFieldOffset(Probe.class.getDeclaredField("ref2"));
        int refSize = (int)(offset2 - offset1);

        return refSize == 4;  // 4 = compressed, 8 = uncompressed
    } catch (Exception e) {
        throw new RuntimeException(e);
    }
}

// Method 3: Use JOL
import org.openjdk.jol.vm.VM;
System.out.println(VM.current().details());
// Output includes: "Compressed Oops: true/false"
// Also shows: reference size, object alignment, compressed klass info

// Method 4: JDK 9+ module system
// HotSpotDiagnosticMXBean can query VM flags:
import com.sun.management.HotSpotDiagnosticMXBean;
HotSpotDiagnosticMXBean hsBean = ManagementFactory.getPlatformMXBean(
    HotSpotDiagnosticMXBean.class);
String val = hsBean.getVMOption("UseCompressedOops").getValue();
boolean compressed = Boolean.parseBoolean(val);
```

---

**P21.34** [H] -- End-to-End Optimization

A real-time analytics engine processes 1M events per second. Each event is a record with: `long timestamp, int userId, short eventType, byte[] payload (avg 200 bytes)`. Design the optimal in-memory storage for the last 10 minutes of events (600M events), considering all the JVM optimization techniques from this chapter.

```java
// Requirements:
// - 600M events retained (10 minutes at 1M/sec)
// - Fast time-range queries: "all events in the last 30 seconds"
// - Fast user queries: "all events for userId X"
// - Minimal GC impact

// ──── STORAGE DESIGN ────

// Layer 1: Time-bucketed ring buffers (off-heap)
// Divide 10 minutes into 600 one-second buckets
// Each bucket is an off-heap memory region

class TimeSlotStore {
    // 600 one-second buckets, each holding ~1M events
    private final MemorySegment[] slots = new MemorySegment[600];
    private final Arena arena = Arena.ofShared();
    private int currentSlot = 0;

    // Event layout in off-heap memory (fixed 256 bytes per event):
    // Offset  Size   Field
    // 0       8      timestamp (long)
    // 8       4      userId (int)
    // 12      2      eventType (short)
    // 14      2      payloadLength (short)
    // 16      240    payload (padded to fixed size)
    // Total: 256 bytes (power of 2 → nice cache alignment)

    static final int EVENT_SIZE = 256;
    static final int EVENTS_PER_SLOT = 1_100_000;  // 10% headroom
    static final long SLOT_SIZE = (long) EVENT_SIZE * EVENTS_PER_SLOT;  // ~282 MB

    void init() {
        for (int i = 0; i < 600; i++) {
            slots[i] = arena.allocate(SLOT_SIZE);
        }
        // Total off-heap: 600 × 282 MB = ~165 GB
        // This is off-heap — invisible to GC!
    }
}

// Why this works:
// 1. OFF-HEAP: 165 GB of data invisible to GC → sub-ms pauses
// 2. SEQUENTIAL ACCESS: time-range queries scan contiguous memory
//    → hardware prefetcher activated → ~4 GB/s scan speed per core
// 3. FIXED-SIZE EVENTS: no fragmentation, O(1) index to any event
//    → event[i] = slot_base + i * 256
// 4. NO OBJECT HEADERS: zero per-event object overhead
//    → 256 bytes per event instead of 256 + 16 (header) + 4 (ref) = 276 bytes
// 5. NO BOXING: timestamp, userId, eventType stored as raw primitives

// Layer 2: User index (on-heap, compact)
// For userId queries: IntObjectHashMap<IntArrayList> from Eclipse Collections
// Key: userId (int, no boxing)
// Value: list of (slotIndex, eventIndex) pairs encoded as ints

class UserIndex {
    // Eclipse Collections IntObjectHashMap: int keys, no boxing
    private final IntObjectHashMap<IntArrayList> userEvents = new IntObjectHashMap<>();

    void indexEvent(int userId, int slotIndex, int eventIndex) {
        // Encode slot + index as single int: (slotIndex << 20) | eventIndex
        // Supports up to 1M events per slot (2^20) and 4096 slots (2^12)
        int encoded = (slotIndex << 20) | eventIndex;
        userEvents.getIfAbsentPut(userId, IntArrayList::new).add(encoded);
    }
}

// Why IntObjectHashMap + IntArrayList:
// - int keys → no Integer boxing → 4 bytes vs 20 bytes per key
// - IntArrayList → no int[] boxing → contiguous int storage
// - Estimated size: ~10M unique users × (4 + 60 × 4) bytes ≈ ~2.4 GB on-heap
//   (assuming avg 60 events per user in 10 minutes)
// - This is the ONLY on-heap data → GC manages ~2.4 GB, not 165 GB

// Layer 3: Cache line optimization for hot path
// The event writing path is extremely hot (1M/sec):

@jdk.internal.vm.annotation.Contended
static class WriterState {
    volatile int writeIndex;  // per-slot write position
    // @Contended ensures no false sharing between writer threads
}

// Each second-bucket has its own WriterState, padded to its own cache line.
// The producer increments writeIndex with a simple volatile write (single writer)
// or CAS (if multiple producers).

// ──── QUERY PERFORMANCE ────

// Time-range query (last 30 seconds):
// Scan 30 contiguous slots × 1M events × 256 bytes = ~7.5 GB
// At ~4 GB/s per core → ~2 seconds per core
// With 8 cores in parallel → ~250 ms
// Further optimization: SIMD filtering on timestamp field

// User query:
// UserIndex lookup: O(1) hash lookup → IntArrayList of encoded positions
// Decode each position → direct off-heap read at computed offset
// For 60 events: 60 × ~100ns (random access to different slots) ≈ 6 us

// ──── GC ANALYSIS ────
// On-heap: ~2.4 GB (UserIndex only)
// GC collector: ZGC (sub-ms pauses for 2.4 GB)
// Off-heap: ~165 GB (invisible to GC)
// GC pause: <1 ms regardless of load
// This is the fundamental insight: move bulk data off-heap,
// keep only indexes on-heap, use ZGC for the small on-heap portion.
```

---

**P21.35** [H] -- Performance Forensics

A Java service shows 10x throughput degradation after deploying a minor code change. The change: added a new implementation of `Processor` interface used in the hot path.

```java
// Before change (FAST):
interface Processor { int process(int input); }
class AlphaProcessor implements Processor { ... }
class BetaProcessor implements Processor { ... }

void hotLoop(Processor p, int[] data) {
    for (int d : data) {
        int result = p.process(d);  // bimorphic: Alpha + Beta
        accumulate(result);
    }
}
// JIT sees 2 types → bimorphic dispatch:
//   if (p.getClass() == AlphaProcessor.class) { inline Alpha.process() }
//   else if (p.getClass() == BetaProcessor.class) { inline Beta.process() }
//   else { uncommonTrap() }
// Both implementations inlined → escape analysis works → fast

// After change (10x SLOWER):
class GammaProcessor implements Processor { ... }  // NEW
// Now hotLoop sees 3 types at p.process() call site → MEGAMORPHIC

// JIT behavior:
// 1. Type profile shows 3+ types → megamorphic
// 2. JIT gives up on inlining → virtual dispatch via vtable
// 3. Without inlining:
//    - No escape analysis (objects created inside process() escape)
//    - No constant folding (constants inside process() not visible)
//    - No range check elimination (array accesses inside process() checked)
//    - No loop unrolling (loop body too opaque)
// 4. Plus: vtable lookup adds ~5-10ns per call
// 5. Indirect branch (vtable) may mispredict → 15-20 cycle penalty

// Diagnosis steps:
// 1. -XX:+PrintCompilation → look for "made not entrant" (deoptimization)
// 2. -XX:+PrintInlining → confirm "hot method too big" or "no static binding"
// 3. JMH with -prof perfasm → check for indirect CALL instructions (vtable)
// 4. perf stat → check branch-miss rate (high = indirect branch misprediction)

// Fix options:

// Fix A: Manual dispatch (convert megamorphic → multiple monomorphic)
void hotLoop(Processor p, int[] data) {
    if (p instanceof AlphaProcessor ap) {
        for (int d : data) accumulate(ap.process(d));  // monomorphic!
    } else if (p instanceof BetaProcessor bp) {
        for (int d : data) accumulate(bp.process(d));  // monomorphic!
    } else if (p instanceof GammaProcessor gp) {
        for (int d : data) accumulate(gp.process(d));  // monomorphic!
    }
    // Each loop body is monomorphic → inlined → all optimizations apply
}

// Fix B: Clone the hot method per type
// If hotLoop is called from different places with different types,
// create type-specific versions:
void hotLoopAlpha(AlphaProcessor p, int[] data) { /* same code */ }
void hotLoopBeta(BetaProcessor p, int[] data) { /* same code */ }
void hotLoopGamma(GammaProcessor p, int[] data) { /* same code */ }
// Each method is monomorphic at its call site.

// Fix C: Use a strategy that avoids interface dispatch
// Convert the Processor implementations to a single class with a mode field:
class UnifiedProcessor {
    enum Mode { ALPHA, BETA, GAMMA }
    final Mode mode;
    int process(int input) {
        return switch (mode) {
            case ALPHA -> /* alpha logic */;
            case BETA -> /* beta logic */;
            case GAMMA -> /* gamma logic */;
        };
    }
}
// Now there is only 1 type → monomorphic → inlined
// The switch compiles to a jump table (O(1)) and is well-predicted

// Fix D: Accept the overhead if it does not matter
// If process() itself takes >1 microsecond (complex computation),
// the 5-10ns vtable overhead is <1% — not worth optimizing.
// Only fix if process() is very fast (<50ns).
```

---

## Key Takeaways

1. **The object header is 12 bytes (compressed) or 16 bytes (uncompressed), and the mark word changes layout for locking, hashing, and GC.** Calling `identityHashCode()` permanently occupies 31 bits that can never be used for biased locking. Fat lock inflation requires kernel transitions — 250x slower than thin locks.

2. **Compressed OOPs save 4 bytes per reference, but crossing 32 GB disables them entirely.** A 33 GB heap holds fewer effective objects than a 31 GB heap. If you need more memory, use off-heap storage or 16-byte alignment (`-XX:ObjectAlignmentInBytes=16` for up to 64 GB), but benchmark the padding overhead.

3. **Cache lines are 64 bytes, and they dictate everything.** Sequential array access is prefetched automatically and runs at memory bandwidth limits. Pointer chasing (linked lists, trees) defeats the prefetcher and runs 50-400x slower per element. Design data structures for sequential access.

4. **False sharing causes 10-50x slowdowns in concurrent code and is invisible to profilers.** Any two volatile fields within 64 bytes of each other will false-share under concurrent writes. Fix with manual padding (7 longs), `@Contended` (128 bytes padding), or `LongAdder` (internally padded cells).

5. **Escape analysis eliminates temporary objects — but only when inlining succeeds.** Storing objects in arrays, passing them to non-inlined methods, or having megamorphic call sites all defeat escape analysis. Keep hot-path code monomorphic and methods small enough to inline (under 325 bytes for hot methods).

6. **The JIT's most important job is inlining.** Monomorphic call sites (1 type) get devirtualized and inlined. Bimorphic (2 types) get type-checked inlining. Megamorphic (3+ types) get virtual dispatch with no inlining — and all downstream optimizations fail. Adding a third implementation to a hot interface can cause a 10x slowdown.

7. **Branch prediction failures cost 15-20 cycles each.** Random conditional branches (like filtering unsorted data) can be 5-10x slower than predictable ones (sorted data) or branchless alternatives (`cmov`, arithmetic). Use branchless techniques only when branches are genuinely unpredictable.

8. **Primitive types use 4-8 bytes; boxed types use 16-28 bytes plus a 4-byte reference.** Autoboxing in hot loops creates millions of garbage objects. Use `IntStream` instead of `Stream<Integer>`, primitive-specialized collections (Eclipse Collections, HPPC) instead of `HashMap<Integer, Integer>`, and `int[]` instead of `Integer[]`.

9. **G1's humongous objects (>50% of region size) cause allocation stalls and deferred collection.** Size your G1 region (`-XX:G1HeapRegionSize`) so that your largest arrays stay below the humongous threshold. For very large heaps with latency requirements, use ZGC (sub-ms pauses regardless of heap size).

10. **Always benchmark with JMH — naive benchmarks measure JIT artifacts, not your code.** JMH handles warmup, dead code elimination, constant folding, and statistical rigor. Use `-prof gc` to measure allocation rates, `-prof perfasm` to see generated assembly, and `@Fork(3)` to ensure independent JVM instances.

---

[Previous: Chapter 20](20-system-design-meets-dsa.md) | [Index](00-index.md) | [Next: Chapter 22](22-concurrency-patterns-and-lock-free-algorithms.md)
