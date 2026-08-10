# Chapter 1: JVM Memory Model Foundations

## The Machine Beneath Your Data Structures

Before we examine a single `HashMap` bucket or `ArrayList` resize, we need to understand the machine that runs them. Every data structure decision you make in Java — `ArrayList` vs `LinkedList`, `int[]` vs `Integer[]`, `HashMap` initial capacity — is ultimately a decision about how bytes are laid out in memory, how the CPU cache fetches them, and how the garbage collector traces them.

This chapter gives you X-ray vision into the JVM. After reading it, you will never again wonder "why is this slow?" — you will *see* the memory layout and know.

---

## 1.1 The JVM Memory Regions

The JVM divides memory into several distinct regions. Understanding these is critical because different data structures stress different regions.

```
┌─────────────────────────────────────────────────────────┐
│                      JVM Process                         │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │                    HEAP                            │   │
│  │  ┌─────────────┐  ┌──────────────────────────┐   │   │
│  │  │  Young Gen   │  │        Old Gen            │   │   │
│  │  │ ┌────┐┌────┐│  │                            │   │   │
│  │  │ │Eden││ S0 ││  │  Long-lived objects        │   │   │
│  │  │ │    ││ S1 ││  │  (promoted from Young)     │   │   │
│  │  │ └────┘└────┘│  │                            │   │   │
│  │  └─────────────┘  └──────────────────────────┘   │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────┐     │
│  │  Metaspace   │  │  Thread  │  │  Code Cache   │     │
│  │  (off-heap)  │  │  Stacks  │  │  (JIT compiled)│     │
│  │  Class meta  │  │  (per    │  │               │     │
│  │  Method meta │  │  thread) │  │               │     │
│  └──────────────┘  └──────────┘  └───────────────┘     │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Native Memory                        │   │
│  │  Direct ByteBuffers, JNI, thread stacks           │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Heap

Where all object instances live. Managed by the garbage collector. When you write `new HashMap<>()`, the `HashMap` object, its internal `Node<K,V>[]` table, and every `Node` — all allocated on the heap.

- **Young Generation (Eden + Survivor spaces S0/S1)**: New objects are allocated here via TLAB (Thread-Local Allocation Buffer). Most objects die young — the "generational hypothesis." Minor GC collects this region.
- **Old Generation (Tenured)**: Objects that survive multiple minor GC cycles get promoted here. Major/Full GC collects this region — expensive.

**Why this matters for DSA**: A `LinkedList` of 1 million elements creates 1 million `Node` objects scattered across the heap. Each minor GC must trace all live nodes. An `ArrayList` with the same data? One contiguous `Object[]` — one reference for the GC to trace.

### Thread Stacks

Each thread gets its own stack (default 512KB-1MB). Stores:
- Local variables (primitives stored directly, object references as pointers)
- Method call frames
- Operand stack for bytecode execution

**Why this matters for DSA**: Recursive DFS on a graph with 100,000 nodes? Each recursive call adds a stack frame (~32-64 bytes). That is 3-6MB of stack. Default stack size is 512KB-1MB. You will get `StackOverflowError`. This is why iterative DFS with an explicit `ArrayDeque` is not just "a different approach" — it is a necessity at scale.

### Metaspace (Off-Heap)

Replaced PermGen in JDK 8. Stores class metadata, method bytecode, constant pool. Allocated in native memory, not on the Java heap. Grows dynamically.

### Code Cache

JIT-compiled native code lives here. When HotSpot compiles your `HashMap.get()` from bytecode to x86 assembly, the result is stored in the code cache.

---

## 1.2 Object Memory Layout

Every Java object on the heap has a fixed structure. Understanding this structure explains why `Integer` costs 16 bytes while `int` costs 4, and why an empty `HashMap` already costs 48 bytes.

### Object Header

Every object starts with a header. On a 64-bit JVM with compressed OOPs (default for heaps < 32GB):

```
┌──────────────────────────────────────────────────────┐
│                   Object Header (12 bytes)             │
│  ┌─────────────────────────┐  ┌────────────────────┐ │
│  │     Mark Word (8 bytes)  │  │ Klass Pointer (4B) │ │
│  └─────────────────────────┘  └────────────────────┘ │
│  + Padding to 8-byte boundary (4 bytes for alignment) │
│  = 16 bytes total minimum object size                  │
└──────────────────────────────────────────────────────┘
```

### Mark Word (8 bytes)

The mark word is the most complex part of the object header. It is a multi-purpose field whose layout changes based on the object's current state:

```
State           | Mark Word Layout (64 bits)
----------------|----------------------------------------------------------
Unlocked        | [unused:25 | identity_hashcode:31 | unused:1 | age:4 | biased:1 | lock:2=01]
Biased          | [thread_id:54 | epoch:2 | unused:1 | age:4 | biased:1 | lock:2=01]
Thin Lock       | [pointer_to_lock_record:62 | lock:2=00]
Fat Lock        | [pointer_to_monitor:62 | lock:2=10]
Marked for GC   | [forwarding_address:62 | lock:2=11]
```

Key fields:
- **identity_hashcode** (31 bits): The value returned by `System.identityHashCode()`. Stored lazily — only computed and written when first requested. Once written, the object can never be biased-locked (because the hash code occupies the space where the thread ID would go).
- **age** (4 bits): Number of GC cycles survived. Max 15 (this is why `-XX:MaxTenuringThreshold` caps at 15). When age exceeds the tenuring threshold, the object is promoted to Old Gen.
- **lock bits** (2 bits): `01` = unlocked/biased, `00` = thin lock, `10` = fat lock, `11` = marked for GC.

**Why this matters for DSA**: When you use an object as a `HashMap` key, calling `hashCode()` on it (if not overridden) triggers `System.identityHashCode()`, which writes the hash into the mark word. This permanently disables biased locking for that object. In a highly concurrent `ConcurrentHashMap`, this interaction between hashing and locking is real.

### Klass Pointer (4 bytes with compressed OOPs)

Points to the class metadata in Metaspace. Without compressed OOPs, this would be 8 bytes. With compressed OOPs (default for heaps < 32GB), it is 4 bytes via bit-shifting:

```
actual_address = compressed_pointer << 3
```

This works because all objects are 8-byte aligned, so the bottom 3 bits are always zero — we can shift them out and recover them later. This is why Java objects must be 8-byte aligned.

### Alignment Padding

The JVM rounds every object size up to a multiple of 8 bytes. This is not waste — it is a CPU requirement. Modern x86 CPUs load data in cache lines of 64 bytes. Unaligned access that crosses a cache line boundary requires two cache line fetches instead of one.

---

## 1.3 Primitive Types vs. Boxed Types: The Cost of Abstraction

This is one of the most critical performance concepts for data structures in Java. The difference between `int` and `Integer` is not just syntactic — it is a 4x memory difference and a cache-miss difference.

### Memory Layout Comparison

```
int (primitive):          4 bytes, stored inline (on stack or in array slot)

Integer (object):         16 bytes total
  ┌─────────────────────────┐
  │ Mark Word      (8 bytes) │
  │ Klass Pointer  (4 bytes) │
  │ int value      (4 bytes) │
  │ = 16 bytes (already aligned) │
  └─────────────────────────┘
  + 4-8 byte reference to it from wherever it is used
```

**An `int` costs 4 bytes. An `Integer` costs 16 bytes (object) + 4 bytes (reference) = 20 bytes. That is a 5x overhead.**

### Array Comparison

```
int[1000]:
  Object header:   16 bytes
  Array length:     4 bytes
  1000 × int:    4000 bytes
  Padding:          4 bytes (to align to 8)
  Total:         4024 bytes
  Layout: [header][len][int|int|int|int|...] ← contiguous in memory

Integer[1000]:
  Array object:     16 + 4 + 4000 + 4 = 4024 bytes (array of references)
  1000 × Integer: 1000 × 16 = 16,000 bytes (scattered across heap)
  Total:          20,024 bytes (5x more)
  Layout: [header][len][ref|ref|ref|...] → [Integer obj] → [Integer obj] → ...
                                            ↑ scattered across heap
                                            ↑ every access is a pointer chase
                                            ↑ every pointer chase is a potential cache miss
```

### Why This Matters: Cache Lines

A CPU cache line is 64 bytes. When you access `int[0]`, the CPU fetches 64 bytes — which means `int[0]` through `int[15]` are now in L1 cache. Sequential access to `int[1]`, `int[2]`, etc. are **cache hits** — essentially free.

When you access `Integer[0]`, you first load the reference (cache line fetch #1), then dereference it to reach the `Integer` object somewhere else on the heap (cache line fetch #2). The next `Integer` object is likely on a completely different cache line. Every access is a **cache miss**.

This is why `int[]` is not "slightly faster" than `Integer[]` — it can be **10-50x faster** for sequential access patterns.

### The Autoboxing Trap

```java
// This looks innocent but creates 1 million Integer objects:
List<Integer> list = new ArrayList<>();
for (int i = 0; i < 1_000_000; i++) {
    list.add(i);  // autoboxing: Integer.valueOf(i) called implicitly
}

// Integer.valueOf() has a cache for -128 to 127.
// For i >= 128, each call creates a new Integer object on the heap.
// That is 999,872 objects × 16 bytes = ~15.6 MB of Integer objects
// Plus the ArrayList's Object[] array: ~8 MB of references
// Total: ~23.6 MB

// Compare with int[]:
int[] arr = new int[1_000_000];  // 4 bytes × 1M + 16 header = ~3.8 MB
// 6.2x less memory, and contiguous for cache efficiency
```

### Real-World Impact

**Redis** stores numbers as raw bytes, not objects. **Netty** uses `int[]` and `byte[]` buffers instead of `Integer[]` and `Byte[]`. **Eclipse Collections** and **HPPC** provide primitive-specialized collections (`IntArrayList`, `IntIntHashMap`) specifically to avoid boxing overhead. When you are processing millions of records per second, the 5x memory overhead and cache misses from boxing are the difference between meeting and missing your SLA.

---

## 1.4 Arrays in JVM Memory

Arrays are the most fundamental data structure in Java, and understanding their JVM representation explains why `ArrayList`, `HashMap`, `PriorityQueue`, and nearly every JDK collection is backed by an array.

### Array Object Layout

```
┌────────────────────────────────────────────┐
│          Array Object in Memory             │
│  Mark Word          (8 bytes)               │
│  Klass Pointer      (4 bytes, compressed)   │
│  Array Length        (4 bytes, int)          │
│  Element [0]        (element_size bytes)     │
│  Element [1]        (element_size bytes)     │
│  ...                                        │
│  Element [length-1] (element_size bytes)     │
│  Padding            (to 8-byte boundary)    │
└────────────────────────────────────────────┘
```

The array length field is always 4 bytes (`int`), which is why Java arrays have a maximum length of `Integer.MAX_VALUE` (2^31 - 1 = 2,147,483,647).

### Bounds Checking in Bytecode

When you write `arr[i]`, the JVM inserts a bounds check. Let us see the actual bytecode:

```java
public static int get(int[] arr, int i) {
    return arr[i];
}
```

Compiled to bytecode (`javap -c`):

```
public static int get(int[], int);
  Code:
    0: aload_0          // push array reference onto operand stack
    1: iload_1          // push index i onto operand stack
    2: iaload           // load int from array (includes bounds check)
    3: ireturn          // return the int
```

The `iaload` instruction performs:
1. Null check on the array reference
2. Bounds check: `if (i < 0 || i >= arr.length) throw ArrayIndexOutOfBoundsException`
3. Compute address: `base_address + 16 + (i * 4)` (16 = header size for int[])
4. Load the 4-byte int from that address

**JIT optimization**: HotSpot's C2 compiler aggressively eliminates bounds checks when it can prove they are unnecessary. In a loop like `for (int i = 0; i < arr.length; i++)`, the JIT proves `i` is always in bounds and removes the check entirely. This is called **range check elimination**. It is one reason why indexed `for` loops on arrays are faster than Iterator-based loops.

### Multi-Dimensional Arrays: The Hidden Cost

```java
int[][] matrix = new int[1000][1000];
```

This is **not** a contiguous 1000x1000 block. It is:
- 1 array object holding 1000 references (array of arrays)
- 1000 separate array objects, each holding 1000 ints

```
matrix (Object[], 1000 refs)
  ├── int[1000]  ← somewhere on heap
  ├── int[1000]  ← somewhere else on heap
  ├── int[1000]  ← somewhere else on heap
  ...
```

Accessing `matrix[i][j]` requires two pointer dereferences: first to find `matrix[i]` (the row array), then to find the element within that row. The 1000 row arrays are separate objects scattered across the heap.

**Optimization for cache locality**: If you need a true 2D matrix and performance matters, flatten it:

```java
int[] matrix = new int[1000 * 1000];
// Access (i, j):
int value = matrix[i * 1000 + j];
```

Now the entire matrix is one contiguous block. Row-major traversal hits cache lines sequentially.

### `System.arraycopy()` — The Fastest Way to Copy

```java
System.arraycopy(src, srcPos, dest, destPos, length);
```

This is a native method that the JVM intrinsifies — it does not call through JNI. On x86, HotSpot compiles it to `rep movsb` or `rep movsq` (or even AVX/SSE vector instructions for large copies). It is essentially a `memcpy` with Java safety checks.

This is why `ArrayList.add()` (which calls `Arrays.copyOf()` → `System.arraycopy()`) is fast despite "copying the whole array" on resize — the copy is a single CPU instruction that moves 64 bytes per clock cycle.

---

## 1.5 TLAB: Thread-Local Allocation Buffers

Object allocation in Java is remarkably fast — often just a pointer bump. This is because of TLABs.

```
Heap (Eden Space):
┌──────────────────────────────────────────────────────┐
│  ┌─────────┐  ┌─────────┐  ┌─────────┐             │
│  │ Thread 1 │  │ Thread 2 │  │ Thread 3 │  free...   │
│  │ TLAB     │  │ TLAB     │  │ TLAB     │             │
│  │ ████░░░░ │  │ ██░░░░░░ │  │ ██████░░ │             │
│  │ used free│  │ used free│  │ used free│             │
│  └─────────┘  └─────────┘  └─────────┘             │
└──────────────────────────────────────────────────────┘
```

Each thread gets a private chunk of Eden space (the TLAB). Allocating an object is:

```
if (tlab_pointer + object_size <= tlab_end) {
    object_address = tlab_pointer;
    tlab_pointer += object_size;  // just a pointer bump!
    return object_address;
}
// Slow path: allocate new TLAB or allocate in shared Eden
```

**No locking required.** Each thread allocates from its own TLAB without contention. This is why `new Object()` in Java is incredibly fast — often 10-20 nanoseconds.

**Why this matters for DSA**: Creating temporary objects in hot loops (like `new int[]{x, y}` for BFS coordinates, or `Map.Entry` iteration) is nearly free due to TLABs. Do not prematurely optimize by reusing objects — the JVM's allocator is faster than your manual object pool in most cases. The cost comes at GC time, not allocation time.

---

## 1.6 Garbage Collection Fundamentals

Every data structure you choose affects GC behavior. The three things that make GC expensive are:

1. **Live object count**: GC must trace every live object starting from GC roots. More live objects = longer GC pause.
2. **Reference density**: Every reference field in an object must be followed during tracing. `LinkedList` with 1M nodes has 2M references (next + prev per node). `ArrayList` with 1M elements has just one reference (to the backing array) plus the array's references.
3. **Object graph depth**: Deep reference chains (linked lists, trees) cause deeper GC tracing stacks.

### GC Impact of Data Structure Choices

```
Data Structure          Objects for N elements   References    GC-friendliness
────────────────────────────────────────────────────────────────────────────
int[]                   1 (the array itself)     0             Excellent
Integer[]               N + 1                    N             Poor
ArrayList<Integer>      N + 2 (list + array)     N + 1         Poor (due to boxing)
LinkedList<Integer>     2N + 1 (N nodes + N Integers + 1 list)  3N    Terrible
HashMap<Integer,Integer> ~3N + 1 (N entries + N keys + N values + table)  ~5N   Terrible
TreeMap<Integer,Integer> ~3N + 1 (N entries + N keys + N values + root) ~7N    Worst
```

### Young Generation and the Generational Hypothesis

The "weak generational hypothesis" states: most objects die young. GC exploits this by collecting the Young Generation (Eden + Survivors) frequently and cheaply, and the Old Generation rarely.

**Implication**: Temporary data structures that you create, use, and discard within a method (like a `HashSet` for deduplication in a single function call) are allocated in Eden, collected in the next minor GC, and never promoted. This is cheap. Long-lived data structures (like a cache stored as a class field) get promoted to Old Gen and must survive full GC cycles.

---

## 1.7 Reading `javap` Output: Your X-Ray Vision

`javap -c -v` is your tool for seeing exactly what the JVM does with your code. Let us read a simple example:

```java
public class ArraySum {
    public static int sum(int[] arr) {
        int total = 0;
        for (int i = 0; i < arr.length; i++) {
            total += arr[i];
        }
        return total;
    }
}
```

```
$ javac ArraySum.java && javap -c ArraySum

public static int sum(int[]);
  Code:
     0: iconst_0           // push 0 (initial total)
     1: istore_1           // store in local variable 1 (total = 0)
     2: iconst_0           // push 0 (initial i)
     3: istore_2           // store in local variable 2 (i = 0)
     4: iload_2            // push i
     5: aload_0            // push arr reference
     6: arraylength        // get arr.length (single field read, no method call)
     7: if_icmpge 20       // if i >= arr.length, jump to return
    10: iload_1            // push total
    11: aload_0            // push arr
    12: iload_2            // push i
    13: iaload             // arr[i] — bounds check + load
    14: iadd               // total + arr[i]
    15: istore_1           // store result in total
    16: iinc 2, 1          // i++ (increment local var 2 by 1, no push/pop)
    19: goto 4             // back to loop start
    20: iload_1            // push total
    21: ireturn            // return total
```

Key observations:
- `arraylength` is a single bytecode instruction, not a method call. `arr.length` is free.
- `iaload` at instruction 13 includes the bounds check. The JIT will eliminate it because the loop guard at instruction 7 already ensures `i < arr.length`.
- `iinc` is a special bytecode for incrementing a local variable — it does not go through the operand stack. This is why `i++` on a local int is essentially free.

---

## 1.8 JOL (Java Object Layout) — Measuring What You Build

JOL is the definitive tool for seeing exactly how much memory your data structures consume. It is developed by Aleksey Shipilev (the same person who built JMH).

### Setup

```xml
<!-- Maven -->
<dependency>
    <groupId>org.openjdk.jol</groupId>
    <artifactId>jol-core</artifactId>
    <version>0.17</version>
</dependency>
```

### Example: Measuring HashMap

```java
import org.openjdk.jol.info.ClassLayout;
import org.openjdk.jol.info.GraphLayout;

public class MeasureHashMap {
    public static void main(String[] args) {
        // Empty HashMap
        HashMap<String, String> map = new HashMap<>();
        System.out.println(ClassLayout.parseInstance(map).toPrintable());
        System.out.println("Total size: " + GraphLayout.parseInstance(map).totalSize() + " bytes");

        // HashMap with 1000 entries
        for (int i = 0; i < 1000; i++) {
            map.put("key" + i, "value" + i);
        }
        System.out.println("Total size with 1000 entries: " +
            GraphLayout.parseInstance(map).totalSize() + " bytes");
    }
}
```

**Typical output for empty HashMap (JDK 17, 64-bit, compressed OOPs):**

```
java.util.HashMap object internals:
OFF  SZ                        TYPE DESCRIPTION
  0   8                             (object header: mark word)
  8   4                             (object header: klass pointer)
 12   4             float           HashMap.loadFactor          (0.75)
 16   4               int           HashMap.threshold           (0)
 20   4               int           HashMap.size                (0)
 24   4               int           HashMap.modCount            (0)
 28   4   java.util.HashMap.Node[]  HashMap.table               (null)
 32   4         java.util.Set       HashMap.entrySet            (null)
 36   4                             (padding)
Instance size: 48 bytes (includes padding to align internal arrays, the actual usable space is 40)
```

**An empty HashMap costs 48 bytes.** Once you put the first entry, it allocates a `Node[]` table of default capacity 16:
- `Node[16]` array: 16 + 4 + (16 × 4) + 4 = 88 bytes
- One `Node` object: ~32 bytes
- Total after first put: 48 + 88 + 32 = ~168 bytes + key + value objects

---

## 1.9 Compressed OOPs (Ordinary Object Pointers)

On a 64-bit JVM, a raw object pointer is 8 bytes. But most applications do not use more than 32GB of heap. Compressed OOPs exploit this:

```
Uncompressed (64-bit pointer):   8 bytes per reference
Compressed (32-bit + shift):     4 bytes per reference

How it works:
  real_address = compressed_pointer << 3    (shift left by 3 bits)

  Since all objects are 8-byte aligned, the bottom 3 bits are always 0.
  We can encode 2^32 × 8 = 32 GB of address space in 32 bits.

  This is why heap > 32 GB disables compressed OOPs,
  and object references suddenly double from 4 to 8 bytes.
  A 33 GB heap can actually use MORE memory than a 31 GB heap.
```

**Impact on data structures**: Every reference field in a data structure (Node.next, Node.key, Node.value, array elements of type Object) costs 4 bytes with compressed OOPs, 8 bytes without. A `HashMap.Node` has 4 reference fields (hash, key, value, next) — that is 16 bytes vs 32 bytes. For a HashMap with 1 million entries, the difference is 16 MB.

**Rule of thumb**: Keep heap under 32 GB. If you need more memory, use off-heap storage (direct ByteBuffers, memory-mapped files) rather than inflating the heap past the compressed OOPs threshold.

---

## 1.10 Escape Analysis and Scalar Replacement

The JIT compiler can analyze whether an object "escapes" the method that created it. If it does not escape, the JVM can:

1. **Stack allocation**: Allocate the object on the thread stack instead of the heap (no GC needed).
2. **Scalar replacement**: Decompose the object into its individual fields and store them as local variables.
3. **Lock elision**: Remove synchronization on non-escaping objects.

```java
public int sumPair(int a, int b) {
    int[] pair = new int[]{a, b};  // Does this array escape? No.
    return pair[0] + pair[1];
}

// After escape analysis + scalar replacement, the JIT sees this as:
public int sumPair(int a, int b) {
    return a + b;  // No array allocation at all
}
```

**Why this matters for DSA**: Temporary arrays and objects created inside methods (like `new int[]{row, col}` for BFS, or `new AbstractMap.SimpleEntry<>(k, v)`) are often eliminated entirely by the JIT. Do not avoid creating small temporary objects out of premature optimization fears — the JVM handles them.

However, escape analysis has limits:
- Objects stored in arrays generally escape (the array might escape)
- Objects passed to other methods may escape if the JIT cannot inline the callee
- Objects stored in fields always escape
- Megamorphic call sites (many implementations of an interface) defeat inlining, which defeats escape analysis

---

## 1.11 Cache Lines and Data Structure Performance

The CPU does not read individual bytes from main memory. It reads **cache lines** — contiguous blocks of 64 bytes (on x86).

```
Main Memory (DDR4/DDR5):         ~80-100 ns latency
    ↕
L3 Cache (shared, 8-64 MB):     ~10-20 ns latency
    ↕
L2 Cache (per-core, 256KB-1MB): ~3-5 ns latency
    ↕
L1 Cache (per-core, 32-64KB):   ~1-2 ns latency
    ↕
CPU Registers:                    <1 ns
```

**Sequential access to `int[]`**: When you read `arr[0]`, the CPU loads 64 bytes (16 ints) into L1 cache. Reading `arr[1]` through `arr[15]` are L1 cache hits (~1 ns each). This is called **spatial locality**.

**Pointer chasing in `LinkedList`**: When you read `node.next`, the next Node is somewhere else on the heap. Each dereference is potentially a cache miss (~10-100 ns). For a list of 1M nodes, traversal can be 50-100x slower than traversing an array of the same data.

### False Sharing

When two threads write to different variables that happen to be on the same 64-byte cache line, the CPU must invalidate and reload the entire cache line on both cores. This is called **false sharing** and can reduce multi-threaded performance by 10-50x.

```java
// False sharing example — both fields on the same cache line
class Counter {
    volatile long count1;  // Thread 1 writes this
    volatile long count2;  // Thread 2 writes this
    // Both are within 64 bytes of each other = same cache line = false sharing
}

// Fix: pad to separate cache lines
class Counter {
    volatile long count1;
    long p1, p2, p3, p4, p5, p6, p7;  // 56 bytes of padding
    volatile long count2;  // Now on a different cache line
}

// Or use @Contended (JDK 8+, requires -XX:-RestrictContended)
class Counter {
    @jdk.internal.vm.annotation.Contended
    volatile long count1;
    @jdk.internal.vm.annotation.Contended
    volatile long count2;
}
```

**Real-world**: The LMAX Disruptor ring buffer pads its sequence counters to separate cache lines. `ConcurrentHashMap`'s internal counter cells use `@Contended` to avoid false sharing. `LongAdder` uses a striped array of cells, each on its own cache line.

---

## 1.12 The Memory Cost of Common Data Structures

Here is the complete memory accounting for every major JDK collection, storing N = 1,000,000 `int` values (using JOL measurements on JDK 17, 64-bit, compressed OOPs):

```
Structure                  Total Memory    Per Element   Overhead vs int[]
────────────────────────────────────────────────────────────────────────
int[1_000_000]             ~4.0 MB         4.0 bytes     1.0x (baseline)
Integer[1_000_000]         ~20.0 MB        20.0 bytes    5.0x
ArrayList<Integer>         ~20.1 MB        20.1 bytes    5.0x
LinkedList<Integer>        ~40.0 MB        40.0 bytes    10.0x
HashSet<Integer>           ~52.0 MB        52.0 bytes    13.0x
HashMap<Integer,Integer>   ~72.0 MB        72.0 bytes    18.0x
TreeMap<Integer,Integer>   ~80.0 MB        80.0 bytes    20.0x
```

Breakdown for `HashMap<Integer, Integer>` with 1M entries:
- HashMap object: 48 bytes
- Node[] table (capacity 1,048,576 after resize): ~4.2 MB
- 1,000,000 Node objects (32 bytes each): ~32 MB
- 1,000,000 Integer keys (16 bytes each): ~16 MB
- 1,000,000 Integer values (16 bytes each): ~16 MB
- **Total: ~68 MB** (plus alignment padding → ~72 MB)

Compare with two `int[]` arrays (keys + values): **~8 MB**. A factor of **9x**.

This is why libraries like Eclipse Collections provide `IntIntHashMap` — storing ints directly without boxing, in open-addressing flat arrays, reducing memory by 5-10x.

---

## Problems

### Understanding JVM Memory Layout

**P01.01** [E] — Calculate Object Size
Given a class with fields `int x`, `long y`, `boolean z`, calculate the total memory footprint including header and padding.

```java
// Object header: 12 bytes (8 mark word + 4 klass pointer)
// int x: 4 bytes
// long y: 8 bytes
// boolean z: 1 byte
// Subtotal: 12 + 4 + 8 + 1 = 25 bytes
// Padding to 8-byte boundary: 7 bytes
// Total: 32 bytes
//
// But wait — the JVM reorders fields to minimize padding!
// Optimal layout: header(12) + long(8) + int(4) + boolean(1) + padding(7) = 32
// OR: header(12) + int(4) + long(8) + boolean(1) + padding(7) = 32
// In this case, total is 32 bytes regardless of ordering.
//
// JVM field ordering rules (HotSpot):
// 1. longs/doubles (8 bytes)
// 2. ints/floats (4 bytes)
// 3. shorts/chars (2 bytes)
// 4. bytes/booleans (1 byte)
// 5. object references (4 bytes with compressed OOPs)
```

**P01.02** [E] — Array Memory Calculation
Calculate the exact memory of `double[100]`.

```java
// Array header: 16 bytes (8 mark + 4 klass + 4 length)
// 100 doubles: 100 × 8 = 800 bytes
// Total: 816 bytes (already 8-byte aligned)
```

**P01.03** [M] — Compare Collection Memory
Calculate the memory ratio of `ArrayList<Integer>` vs `int[]` for storing 10,000 integers.

```java
// int[10_000]:
//   Header: 16 bytes
//   Data: 10_000 × 4 = 40,000 bytes
//   Total: 40,016 bytes ≈ 39.1 KB

// ArrayList<Integer> with 10,000 elements:
//   ArrayList object: 48 bytes (header + fields)
//   Object[] internal array (capacity likely 10,000 or next growth):
//     Header: 16 bytes + 10,000 × 4 = 40,016 bytes (references)
//   10,000 Integer objects: 10,000 × 16 = 160,000 bytes
//   Total: 48 + 40,016 + 160,000 = 200,064 bytes ≈ 195.4 KB
//   Ratio: 200,064 / 40,016 ≈ 5.0x
```

**P01.04** [M] — TLAB vs Synchronized Allocation
Explain why `new Object()` in a multi-threaded environment does not require a lock.

```java
// Answer: Each thread has its own TLAB (Thread-Local Allocation Buffer),
// a private chunk of Eden space. Allocation is just a pointer bump:
//   address = tlab_pointer;
//   tlab_pointer += object_size;
//
// No lock, no CAS, no contention. When the TLAB is exhausted,
// the thread requests a new TLAB from the shared Eden space
// (this requires a CAS, but happens infrequently — amortized over
// thousands of allocations).
//
// This is why Java's allocation speed is competitive with C's malloc,
// and often faster (malloc requires thread-safe free-list management).
```

**P01.05** [M] — Escape Analysis Prediction
Which of these objects will be eliminated by escape analysis?

```java
public int process(int[] data) {
    // Object A: temporary array for swap
    int[] temp = new int[]{data[0], data[1]};  // Does not escape → eliminated

    // Object B: StringBuilder for logging
    StringBuilder sb = new StringBuilder();
    sb.append("Processing ").append(data.length);
    System.out.println(sb.toString());  // Escapes via println → NOT eliminated

    // Object C: iterator from enhanced for-loop
    List<Integer> list = Arrays.asList(1, 2, 3);
    int sum = 0;
    for (int val : list) {  // Iterator created here
        sum += val;          // Iterator may or may not escape depending on inlining
    }

    // Object D: lambda capture
    IntUnaryOperator doubler = x -> x * 2;  // Non-capturing lambda → singleton, no allocation
    return doubler.applyAsInt(temp[0] + sum);
}

// Answer:
// A: Eliminated (scalar replacement → just uses data[0] and data[1] directly)
// B: NOT eliminated (escapes through System.out.println)
// C: Depends on JIT inlining depth. If Arrays.asList().iterator() is fully
//    inlined, the iterator may be scalar-replaced. Often it is.
// D: No allocation at all — non-capturing lambdas are cached as singletons
//    by the LambdaMetafactory. Only the first invocation allocates.
```

**P01.06** [H] — False Sharing Detection
Two threads increment separate counters. Explain why this is slow and fix it.

```java
// Slow version — false sharing
class Counters {
    volatile long counter1 = 0;
    volatile long counter2 = 0;
}

// Thread 1: counters.counter1++ in a loop
// Thread 2: counters.counter2++ in a loop
//
// Problem: counter1 and counter2 are adjacent in memory (within 64 bytes).
// They share the same cache line. When Thread 1 writes counter1, it
// invalidates the cache line on Thread 2's core. Thread 2 must reload
// the entire cache line from L3/main memory before it can write counter2.
// And vice versa. This is called "cache line ping-pong."
//
// Performance impact: can be 10-50x slower than if they were on separate lines.

// Fix 1: Manual padding
class Counters {
    volatile long counter1 = 0;
    long p1, p2, p3, p4, p5, p6, p7;  // 7 longs = 56 bytes padding
    volatile long counter2 = 0;
}
// Now counter1 and counter2 are on different 64-byte cache lines.

// Fix 2: Use LongAdder (JDK 8+)
// LongAdder internally uses a Cell[] array where each Cell is @Contended,
// spreading updates across cache lines automatically.
LongAdder counter1 = new LongAdder();
LongAdder counter2 = new LongAdder();

// Fix 3: Use @Contended annotation (requires -XX:-RestrictContended)
class Counters {
    @jdk.internal.vm.annotation.Contended
    volatile long counter1 = 0;
    @jdk.internal.vm.annotation.Contended
    volatile long counter2 = 0;
}
// JVM adds 128 bytes of padding around each @Contended field.
```
**Real-world**: ConcurrentHashMap's CounterCell class is `@Contended`. The LMAX Disruptor pads all sequence counters. Netty's internal reference counting uses padded atomic counters.

**P01.07** [M] — Compressed OOPs Threshold
A production system uses a HashMap holding 50 million entries. Calculate the memory impact of crossing the 32 GB compressed OOPs boundary.

```java
// With compressed OOPs (heap ≤ 32 GB):
// Each HashMap.Node has:
//   header: 12 bytes (8 mark + 4 klass)
//   int hash: 4 bytes
//   ref key: 4 bytes (compressed)
//   ref value: 4 bytes (compressed)
//   ref next: 4 bytes (compressed)
//   padding: 4 bytes
//   = 32 bytes per Node
//
// 50M nodes: 50_000_000 × 32 = 1.6 GB (just for nodes)
// Plus Node[] table (~64M slots × 4 bytes = 256 MB)
// Plus key/value objects

// WITHOUT compressed OOPs (heap > 32 GB):
// Each HashMap.Node:
//   header: 16 bytes (8 mark + 8 klass — no compression)
//   int hash: 4 bytes
//   ref key: 8 bytes (uncompressed)
//   ref value: 8 bytes (uncompressed)
//   ref next: 8 bytes (uncompressed)
//   padding: 4 bytes
//   = 48 bytes per Node (50% larger!)
//
// 50M nodes: 50_000_000 × 48 = 2.4 GB
// Plus Node[] table (~64M slots × 8 bytes = 512 MB)
//
// Difference: ~1.0 GB just from disabling compressed OOPs
// This is why a 33 GB heap can be WORSE than a 31 GB heap.
```

**P01.08** [E] — Mark Word States
An object is used as a synchronized lock and then stored in a HashMap. Trace the mark word state transitions.

```java
Object obj = new Object();
// Mark word: [identity_hash(unset) | age:0 | biased:1 | lock:01]
// State: Biased (if biased locking is enabled; disabled by default since JDK 15)
// On JDK 15+: State: Unlocked [unused | age:0 | biased:0 | lock:01]

synchronized (obj) {
    // State: Thin Lock [ptr_to_lock_record | lock:00]
    // The current thread's stack frame address is stored in mark word
}
// After exiting synchronized: back to Unlocked

int h = System.identityHashCode(obj);
// State: Unlocked [identity_hash:31bits | age | biased:0 | lock:01]
// identity hash is now permanently stored in the mark word

map.put(obj, "value");
// When map calls obj.hashCode() (which defaults to identityHashCode),
// it reads the already-stored hash from the mark word. No state change.

synchronized (obj) {
    // Cannot use biased locking — identity hash occupies that space
    // Goes directly to thin lock: [ptr_to_lock_record | lock:00]
    // If contended, inflates to fat lock: [ptr_to_monitor | lock:10]
}
```

**P01.09** [M] — GC Impact Comparison
Compare the GC behavior of processing 1M records using `ArrayList<Record>` vs `Record[]`.

```java
record Record(int id, String name, double value) {}

// Approach 1: ArrayList<Record>
ArrayList<Record> list = new ArrayList<>();
for (int i = 0; i < 1_000_000; i++) {
    list.add(new Record(i, "item" + i, i * 1.1));
}

// GC perspective:
// - ArrayList object: 1 root → 1 Object[]
// - Object[]: ~1M references to trace
// - 1M Record objects: each with 1 reference field (String name)
// - 1M String objects: each with 1 reference field (byte[] value)
// - 1M byte[] objects: no references
// Total objects: ~4M    Total references to trace: ~3M
// Young Gen pressure: high (all created in burst)
// If ArrayList survives minor GC → promoted to Old Gen
// Old Gen: GC must scan 1M references in the array on every major GC

// Approach 2: Parallel arrays (SoA — Structure of Arrays)
int[] ids = new int[1_000_000];
String[] names = new String[1_000_000];
double[] values = new double[1_000_000];
// GC perspective:
// - 3 array objects, ~1M String references to trace (just the names array)
// - 1M String objects + 1M byte[] objects
// Total objects: ~2M    Total references to trace: ~1M
// 3x fewer references for GC to trace
// Cache-friendly: scanning int[] and double[] for computation is sequential

// Approach 3: If names are from a fixed set, intern them
// Then many names share the same String object → even fewer objects
```

**P01.10** [H] — Predict JIT Behavior
Analyze this code and predict which optimizations the JIT compiler will apply.

```java
public long sumList(List<Integer> list) {
    long total = 0;
    for (int i = 0; i < list.size(); i++) {
        total += list.get(i);
    }
    return total;
}

// If called with ArrayList:
// 1. Type profiling: JIT records that `list` is always ArrayList
// 2. Monomorphic dispatch: list.get(i) devirtualizes to ArrayList.get(i)
// 3. Inlining: ArrayList.get(i) is inlined:
//      rangeCheck(i);              → bounds check
//      return elementData[i];      → array access
// 4. Range check elimination: since i < list.size() from loop guard,
//    the rangeCheck inside get(i) is redundant → eliminated
// 5. Null check elimination: elementData is always non-null in a valid ArrayList
// 6. Unboxing: Integer.intValue() is inlined and the Integer object might be
//    scalar-replaced if the JIT is aggressive enough
// 7. Loop unrolling: the JIT may process 2-4 iterations per loop body
//
// Result: the JIT-compiled code is nearly as fast as summing an int[] directly.
//
// BUT if called with both ArrayList AND LinkedList (polymorphic):
// 1. Type profiling shows 2 types → bimorphic dispatch (2 type checks)
// 2. If >2 types → megamorphic: no inlining, virtual dispatch via vtable
// 3. No range check elimination (can't inline to see the internal structure)
// 4. Performance drops dramatically
//
// This is why consistent types matter more than you think.
```

**P01.11** [M] — Memory-Efficient Counter
Design a counter for counting word frequencies in a 10GB text file. Compare HashMap<String, Integer> vs HashMap<String, int[]> vs a primitive-specialized map.

```java
// Approach 1: HashMap<String, Integer>
// Each put/increment involves:
//   map.put(word, map.getOrDefault(word, 0) + 1);
//   Every increment creates a new Integer object (autoboxing)
//   For 100,000 unique words with avg 100 occurrences each:
//     100,000 entries × 32 bytes (Node) = 3.2 MB
//     100,000 Integer values × 16 bytes = 1.6 MB (but 10M total Integer objects created!)
//   GC pressure: 10 million short-lived Integer objects per pass

// Approach 2: HashMap<String, int[]>
Map<String, int[]> counts = new HashMap<>();
counts.computeIfAbsent(word, k -> new int[1])[0]++;
//   Only 1 int[] per word (mutable, no new object on increment)
//   100,000 int[] objects × 24 bytes = 2.4 MB
//   No autoboxing, no GC pressure from incrementing
//   But int[] has 24 bytes overhead for a single int (header + length + value + padding)

// Approach 3: Eclipse Collections IntObjectHashMap or similar
// Stores int values directly in the backing array — no boxing, no wrapper objects
// ~4 bytes per value instead of 16-24
// Best for extreme scale

// Approach 4: merge() method (best idiomatic Java)
Map<String, Integer> counts = new HashMap<>();
counts.merge(word, 1, Integer::sum);
// Still boxes, but cleaner. Good enough for most cases.
// The real optimization is Approach 2 or 3 when processing 10GB+.
```

**P01.12** [H] — Off-Heap Data Structure
Explain how you would implement an off-heap hash map for 100 million entries that never triggers GC.

```java
// Concept: Use sun.misc.Unsafe or ByteBuffer.allocateDirect to allocate
// memory outside the Java heap. GC never sees it.

// Step 1: Allocate off-heap memory
// long capacity = 100_000_000;
// long entrySize = 8 (key hash) + 8 (value) = 16 bytes per slot
// long totalBytes = capacity * entrySize;
// long baseAddress = UNSAFE.allocateMemory(totalBytes);

// Step 2: Open addressing (linear probing)
// int slot = hash(key) & (capacity - 1);  // capacity must be power of 2
// long address = baseAddress + slot * entrySize;
// long storedHash = UNSAFE.getLong(address);
// if (storedHash == 0) { /* empty slot */ }
// else if (storedHash == keyHash) { /* found */ }
// else { slot = (slot + 1) & (capacity - 1); /* probe next */ }

// Step 3: No GC impact
// The entire hash map is invisible to GC — no object headers, no references
// to trace. Perfect for large caches that would cause GC pauses.

// Real-world examples:
// - Apache Ignite: off-heap memory for distributed cache
// - Chronicle Map: off-heap concurrent hash map (open source)
// - Cassandra: off-heap memtables and key cache
// - Netty: PooledByteBufAllocator for network buffers

// Downsides:
// - Manual memory management (must call UNSAFE.freeMemory)
// - No type safety (everything is raw bytes)
// - Serialization/deserialization cost for complex objects
// - Cannot store object references (only primitives and bytes)
```

**P01.13** [E] — Stack vs Heap Decision
For each variable below, state whether it lives on the stack or heap and why.

```java
public void method() {
    int x = 42;                    // Stack: primitive local variable
    Integer y = 42;                // y (reference) on stack, Integer object on heap
                                   // BUT: Integer.valueOf(42) returns cached instance (-128 to 127)
    String s = "hello";            // s (reference) on stack, String in string pool (heap, interned)
    String s2 = new String("hello"); // s2 on stack, new String object on heap (NOT interned)
    int[] arr = new int[10];       // arr (reference) on stack, array object on heap
    int[] arr2 = {1, 2};           // Same as above. The literal syntax still creates a heap array.

    // After escape analysis (JIT):
    // If x, y, arr2 don't escape this method, the JIT may:
    //   x: already on stack
    //   y: scalar replace → just the int 42 on stack (no Integer object)
    //   arr: if size is known and small, may be stack-allocated or scalar-replaced
    //   arr2: likely scalar-replaced to two stack variables (arr2_0=1, arr2_1=2)
}
```

**P01.14** [M] — Alignment Puzzle
A class has these fields: `byte a`, `int b`, `byte c`, `long d`, `byte e`. Calculate the object size with and without field reordering.

```java
// Without reordering (naive layout):
// header:  12 bytes (offset 0-11)
// byte a:   1 byte  (offset 12)
// padding:  3 bytes (to align int to 4-byte boundary)
// int b:    4 bytes (offset 16-19)
// byte c:   1 byte  (offset 20)
// padding:  3 bytes (to align long to 8-byte boundary)
// long d:   8 bytes (offset 24-31)
// byte e:   1 byte  (offset 32)
// padding:  7 bytes (to align object to 8-byte boundary)
// Total: 40 bytes

// With HotSpot's field reordering:
// header:  12 bytes (offset 0-11)
// int b:    4 bytes (offset 12-15)  ← 4-byte field fills the gap after header
// long d:   8 bytes (offset 16-23) ← 8-byte aligned
// byte a:   1 byte  (offset 24)
// byte c:   1 byte  (offset 25)
// byte e:   1 byte  (offset 26)
// padding:  5 bytes (to align to 8-byte boundary)
// Total: 32 bytes  ← 8 bytes saved!

// HotSpot groups fields by size (largest first) and packs smaller fields
// into alignment gaps. This is why field declaration order in Java
// does NOT determine memory layout.
```

**P01.15** [H] — Design a Memory-Aware Data Structure
Design a cache that stores 10 million key-value pairs (long keys, long values) with minimal GC impact.

```java
// Requirements: 10M entries, long→long, minimal GC
// Option 1: HashMap<Long, Long> — terrible
//   10M Node objects + 10M Long keys + 10M Long values = 30M objects
//   Memory: ~480 MB. GC must trace 50M+ references.

// Option 2: Two parallel long[] arrays with open addressing
public class LongLongMap {
    private long[] keys;
    private long[] values;
    private boolean[] occupied;  // or use a special sentinel key like Long.MIN_VALUE
    private int capacity;
    private int size;

    public LongLongMap(int expectedSize) {
        // Load factor 0.75: capacity = expectedSize * 4/3, rounded to power of 2
        this.capacity = Integer.highestOneBit(expectedSize * 4 / 3) << 1;
        this.keys = new long[capacity];
        this.values = new long[capacity];
        this.occupied = new boolean[capacity];
    }

    public void put(long key, long value) {
        int slot = (int)(key * 0x9E3779B97F4A7C15L >>> (64 - Integer.numberOfTrailingZeros(capacity)));
        // Fibonacci hashing for better distribution
        while (occupied[slot]) {
            if (keys[slot] == key) {
                values[slot] = value;
                return;
            }
            slot = (slot + 1) & (capacity - 1);
        }
        keys[slot] = key;
        values[slot] = value;
        occupied[slot] = true;
        size++;
    }

    public long get(long key, long defaultValue) {
        int slot = (int)(key * 0x9E3779B97F4A7C15L >>> (64 - Integer.numberOfTrailingZeros(capacity)));
        while (occupied[slot]) {
            if (keys[slot] == key) return values[slot];
            slot = (slot + 1) & (capacity - 1);
        }
        return defaultValue;
    }
}

// Memory: 3 arrays
//   long[13_333_333]: ~107 MB (keys)
//   long[13_333_333]: ~107 MB (values)
//   boolean[13_333_333]: ~13 MB
//   Total: ~227 MB (vs ~480 MB for HashMap)
//   Objects: 4 (the map + 3 arrays). GC traces 0 references in the arrays.
//
// 2x less memory, ~0 GC overhead, cache-friendly sequential probing.
// This is essentially what Eclipse Collections LongLongHashMap does.
```

---

## Key Takeaways

1. **Every Java object costs at least 16 bytes** — 12 bytes header + padding. An `Integer` holding the value `42` costs 16 bytes vs 4 bytes for a bare `int`. This 4x overhead compounds across millions of elements.

2. **Arrays are contiguous; linked structures are scattered.** `int[1000]` is one 4KB block that fills ~63 cache lines sequentially. `LinkedList` with 1000 nodes is 1000 separate objects scattered across the heap, each access a potential cache miss.

3. **Compressed OOPs halve reference sizes.** Keep heap under 32GB. A 33GB heap can use more memory than 31GB because references double from 4 to 8 bytes.

4. **The mark word is multipurpose.** It stores identity hash, GC age, lock state, and forwarding pointers — never all at once. Calling `identityHashCode()` permanently prevents biased locking.

5. **TLAB allocation is a pointer bump — nearly free.** Do not avoid temporary objects. The cost is at GC time (tracing live objects), not allocation time.

6. **Escape analysis eliminates many temporary objects.** Small arrays, iterators, and lambda captures created within a method are often scalar-replaced or stack-allocated by the JIT.

7. **Cache lines are 64 bytes.** Sequential data access (arrays) gets hardware prefetching for free. Pointer chasing (linked structures) defeats prefetching and incurs 10-100x latency per access.

8. **False sharing kills multi-threaded performance.** Two threads writing to adjacent memory (same cache line) cause invalidation storms. Pad hot fields to separate cache lines.

9. **GC cost is proportional to live object count and reference density.** `LinkedList` creates 2N objects with 3N references. `ArrayList` creates N+2 objects with N+1 references. For GC, ArrayList wins decisively.

10. **Use JOL to measure, not guess.** `ClassLayout.parseInstance(obj).toPrintable()` shows exact memory layout. `GraphLayout.parseInstance(obj).totalSize()` shows total reachable size. Never assume — measure.

---

[Next: Chapter 2 — Arrays & Strings Internals →](02-arrays-and-strings-internals.md)
