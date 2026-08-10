# Chapter 2: Arrays & Strings Internals

## The Two Primitives Everything Else Is Built On

Every data structure in the JDK — `ArrayList`, `HashMap`, `PriorityQueue`, `StringBuilder`, `String` itself — is backed by an array. Every piece of data your systems process — request bodies, database rows, log entries, serialized protobuf — eventually becomes a string or a sequence of bytes in an array. If you understand arrays and strings at the JVM level, you understand the foundation beneath every collection, every I/O buffer, every serialization framework.

This chapter tears both apart. We will look at how the JVM lays out arrays in memory (building on the object model from Chapter 1), how bounds checks work at the bytecode and JIT level, why `System.arraycopy()` compiles to a single CPU instruction, and why multi-dimensional arrays in Java are fundamentally different from C. Then we will dissect `String` — from the JDK 9 compact strings revolution to string interning's weak references, from `invokedynamic`-based concatenation to the rolling hash inside Rabin-Karp. Every concept will be grounded in the machine.

---

## 2.1 JVM Array Layout — The Contiguous Block

We covered array basics in Chapter 1, Section 1.4. Now we go deeper. An array in Java is a special kind of object — it has an object header like any other object, but with an extra 4-byte length field wedged between the klass pointer and the element data.

### The Exact Memory Layout

```
┌──────────────────────────────────────────────────────────────┐
│                  Array Object in Memory                       │
│                                                               │
│  ┌──────────────────┐  Offset 0                              │
│  │  Mark Word        │  8 bytes — GC age, lock state, hash    │
│  ├──────────────────┤  Offset 8                              │
│  │  Klass Pointer    │  4 bytes (compressed OOPs)             │
│  ├──────────────────┤  Offset 12                             │
│  │  Array Length     │  4 bytes (int — max 2^31 - 1)          │
│  ├──────────────────┤  Offset 16  ← element data starts here │
│  │  Element [0]      │  element_size bytes                    │
│  │  Element [1]      │  element_size bytes                    │
│  │  ...              │                                        │
│  │  Element [n-1]    │  element_size bytes                    │
│  ├──────────────────┤                                        │
│  │  Padding          │  0-7 bytes (to 8-byte boundary)        │
│  └──────────────────┘                                        │
└──────────────────────────────────────────────────────────────┘
```

Let us calculate concrete sizes:

```
Type          Header  Length  Data per element  Example: n=1000     Total
─────────────────────────────────────────────────────────────────────────
byte[1000]    8+4=12  4       1 byte            1000 bytes          1016 → 1016 (8-aligned)
char[1000]    12      4       2 bytes           2000 bytes          2016 → 2016 (8-aligned)
int[1000]     12      4       4 bytes           4000 bytes          4016 → 4016 (8-aligned)
long[1000]    12      4       8 bytes           8000 bytes          8016 → 8016 (8-aligned)
Object[1000]  12      4       4 bytes (cOOP)    4000 bytes          4016 → 4016 (8-aligned)
```

Notice that the header is always 16 bytes (8 mark word + 4 klass pointer + 4 length). The element data starts at offset 16. This is critical for JIT-generated address calculations — the JIT computes `base + 16 + index * element_size` to reach any element.

### Why Array Length Is an `int`

The length field is 4 bytes — a Java `int`. This means arrays have a hard maximum of `Integer.MAX_VALUE` (2,147,483,647) elements. You cannot create a `byte[]` larger than ~2 GB in a single allocation, even if your heap is 64 GB. This is a fundamental JVM limitation baked into the bytecode: the `arraylength` instruction returns an `int`, and the `newarray`/`anewarray` instructions take an `int` count.

For larger buffers, you need `ByteBuffer.allocateDirect()` (off-heap), memory-mapped files (`MappedByteBuffer`), or segmented arrays (an array of arrays). Project Panama's `MemorySegment` in JDK 21+ finally gives us a clean API for buffers larger than 2 GB.

### Array Type Encoding in the Klass Pointer

Each primitive array type has its own klass in the JVM. `int[]` and `long[]` point to different klass metadata. The JVM uses this to determine element size at runtime. When the GC walks the heap, it reads the klass pointer to know whether to treat the array body as references (for `Object[]`) or raw data (for `int[]`). This is why primitive arrays have zero GC tracing cost for their elements — the GC knows they contain no references.

---

## 2.2 Bounds Checking: From Bytecode to JIT Elimination

Every array access in Java is bounds-checked. This is the safety guarantee that makes Java immune to buffer overflows — the same class of bug that produces 70% of CVEs in C/C++ systems. But safety has a cost... unless the JIT eliminates it.

### The Bytecode Level

There are separate load/store instructions for each array type:

```
Instruction   Array Type        Operation
─────────────────────────────────────────────
iaload        int[]             Load int from array
laload        long[]            Load long from array
faload        float[]           Load float from array
daload        double[]          Load double from array
aaload        Object[]          Load reference from array
baload        byte[]/boolean[]  Load byte/boolean from array
caload        char[]            Load char from array
saload        short[]           Load short from array

iastore       int[]             Store int to array
lastore       long[]            Store long to array
...           ...               (same pattern for stores)
```

Every one of these instructions implicitly performs:

```
1. Null check:   if (arrayRef == null) throw NullPointerException
2. Bounds check: if (index < 0 || index >= arrayRef.length) throw ArrayIndexOutOfBoundsException
3. Address calc: address = arrayRef + HEADER_SIZE + index * ELEMENT_SIZE
4. Load/store:   read from or write to that address
```

Let us look at a concrete example:

```java
public static int accessElement(int[] arr, int i) {
    return arr[i];
}
```

```
Bytecode (javap -c):
  0: aload_0          // push array reference
  1: iload_1          // push index
  2: iaload           // null check + bounds check + load
  3: ireturn
```

The `iaload` instruction does all three steps atomically from the JVM's perspective. In the interpreter, this is a C++ function that performs explicit comparisons. But in JIT-compiled code, the story is very different.

### JIT-Level Range Check Elimination

HotSpot's C2 compiler (the server-tier JIT) performs **range check elimination** (RCE) — one of its most impactful optimizations. Consider:

```java
public static long sum(int[] arr) {
    long total = 0;
    for (int i = 0; i < arr.length; i++) {
        total += arr[i];  // bounds check on every iteration?
    }
    return total;
}
```

The C2 compiler sees that the loop guard (`i < arr.length`) already guarantees `0 <= i < arr.length` for every iteration. It removes the bounds check from the `iaload` entirely. The JIT-compiled x86 assembly for the loop body becomes approximately:

```asm
; After RCE — no bounds check
.loop:
    movsxd  rax, dword [rdi + rsi*4 + 16]   ; load arr[i], 16 = array header
    add     rcx, rax                          ; total += arr[i]
    inc     esi                               ; i++
    cmp     esi, edx                          ; compare i with arr.length
    jl      .loop                             ; if i < length, continue
```

No branch for bounds checking. No comparison with 0 or `arr.length` inside the loop body. The load is a single `mov` instruction.

### When Range Check Elimination Fails

RCE requires the JIT to prove that the index is always within bounds. It fails in several cases:

```java
// Case 1: Index computed from external input — cannot prove bounds
public static int get(int[] arr, int userInput) {
    return arr[userInput];  // bounds check KEPT — userInput could be anything
}

// Case 2: Multiple arrays with different lengths
public static void copy(int[] src, int[] dst) {
    for (int i = 0; i < src.length; i++) {
        dst[i] = src[i];  // src bounds check eliminated
                           // dst bounds check: DEPENDS — if JIT can prove dst.length >= src.length, eliminated
                           // Otherwise, kept for dst
    }
}

// Case 3: Complex index expressions
public static int diagSum(int[][] matrix, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
        sum += matrix[i][n - 1 - i];  // Two bounds checks (outer array + inner array)
                                        // Inner array length may vary (jagged array)
                                        // JIT typically cannot eliminate inner check
    }
    return sum;
}
```

### Implicit Null Checks via SEGV Traps

For the null check, HotSpot uses an optimization called **implicit null checking**. Instead of inserting an explicit `if (ref == null)` branch, it simply accesses the memory. If the reference is null, this causes a SIGSEGV (segmentation fault) on Linux or an access violation on Windows. The JVM catches this signal and converts it to a `NullPointerException`.

This sounds expensive (signal handling!), but it is an optimization for the common case: when the reference is non-null (99.99% of the time), there is zero overhead — no branch, no comparison. The signal path only fires for the rare null case, and exceptions are expensive anyway.

```
// Explicit null check (interpreter):
if (arrayRef == null) throw NPE;   // branch instruction — cost even when not null

// Implicit null check (JIT):
mov eax, [arrayRef + offset]       // just access it — if null, SIGSEGV → NPE
                                    // zero overhead when non-null
```

---

## 2.3 `System.arraycopy()` — The Native Intrinsic

`System.arraycopy()` is the workhorse behind `ArrayList.add()`, `Arrays.copyOf()`, `ArrayList.remove()`, `StringBuilder.append()`, and dozens of other JDK methods. Understanding its implementation explains why array-backed data structures are so much faster than they should be.

### The Signature

```java
public static native void arraycopy(Object src, int srcPos,
                                     Object dest, int destPos,
                                     int length);
```

It is declared `native`, but it is not a regular JNI call. It is an **intrinsic** — the JIT compiler recognizes it by name and replaces it with hand-optimized machine code, bypassing the JNI overhead entirely.

### What the JIT Actually Generates

For `int[]` to `int[]` copies, the JIT generates different code depending on the copy length:

```
Small copies (< 8 elements):
  Unrolled individual mov instructions:
    mov eax, [src + srcPos*4 + 16]
    mov [dst + dstPos*4 + 16], eax
    mov eax, [src + srcPos*4 + 20]
    mov [dst + dstPos*4 + 20], eax
    ...

Medium copies (8-64 elements):
  SSE/AVX vector moves:
    vmovdqu ymm0, [src + offset]        ; load 32 bytes (8 ints) at once
    vmovdqu [dst + offset], ymm0         ; store 32 bytes at once
    vmovdqu ymm0, [src + offset + 32]
    vmovdqu [dst + offset + 32], ymm0
    ...

Large copies (> 64 elements):
  rep movsq (on x86):
    mov rsi, src_addr    ; source address
    mov rdi, dst_addr    ; destination address
    mov rcx, count       ; number of 8-byte quadwords
    rep movsq            ; hardware-optimized bulk copy
```

The `rep movsq` instruction is a hardware-level memory copy. On modern Intel/AMD CPUs, it uses an "enhanced REP MOVSB/STOSB" microarchitecture that can copy at near-memory-bandwidth speeds — 20-40 GB/s. A single `rep movsq` copying 4000 bytes (1000 ints) takes approximately 100-200 nanoseconds.

### Why This Is Faster Than a Manual Loop

```java
// Manual loop:
for (int i = 0; i < length; i++) {
    dst[dstPos + i] = src[srcPos + i];
}

// System.arraycopy:
System.arraycopy(src, srcPos, dst, dstPos, length);
```

The manual loop, even after JIT optimization, has loop overhead (increment, compare, branch) and operates on one element at a time (or 2-4 with auto-vectorization if the JIT is aggressive). `System.arraycopy()` with `rep movsq` has no loop at all — it is a single instruction that the CPU's memory controller executes at full bandwidth.

Benchmark numbers (typical, JDK 17, modern x86):

```
Copy size     Manual loop    System.arraycopy    Speedup
──────────────────────────────────────────────────────────
10 ints       ~8 ns          ~5 ns               1.6x
100 ints      ~50 ns         ~15 ns              3.3x
1000 ints     ~400 ns        ~80 ns              5.0x
10000 ints    ~3500 ns       ~600 ns             5.8x
100000 ints   ~35000 ns      ~5000 ns            7.0x
```

### Overlapping Copies

`System.arraycopy()` handles overlapping regions correctly. When `src == dst` and the ranges overlap, it detects the direction and copies accordingly (forward or backward) to avoid data corruption. This is equivalent to C's `memmove()` rather than `memcpy()`. This is critical for operations like `ArrayList.remove(int index)`, which shifts elements within the same array:

```java
// Inside ArrayList.remove(int index):
int numMoved = size - index - 1;
if (numMoved > 0) {
    System.arraycopy(elementData, index + 1, elementData, index, numMoved);
    // src and dst are the SAME array — overlapping copy
    // System.arraycopy handles this correctly
}
```

### Object Array Copies and Store Checks

For `Object[]` copies, there is an additional complication: the **array store check**. Java arrays are covariant — `String[]` is a subtype of `Object[]`. But this means you could have:

```java
Object[] arr = new String[10];
arr[0] = new Integer(42);  // Compiles! But throws ArrayStoreException at runtime
```

When `System.arraycopy()` copies between `Object[]` arrays, it must check that each element is type-compatible with the destination array's component type. For primitive arrays, no such check exists — `int[]` can only hold `int`s.

---

## 2.4 Multi-Dimensional Arrays: Jagged vs. Flat

Java does not have true multi-dimensional arrays. What it has are arrays of arrays — and this distinction has profound performance implications.

### Jagged Arrays (Java's Default)

```java
int[][] matrix = new int[1000][1000];
```

This creates **1001 objects**:
- 1 `int[][]` object (an array of 1000 references)
- 1000 `int[]` objects (each holding 1000 ints)

```
matrix (Object[1000], references to int[] arrays)
  ┌─────────────────────────────────────────────┐
  │ ref → int[1000]  (somewhere on heap)         │
  │ ref → int[1000]  (somewhere else on heap)    │
  │ ref → int[1000]  (somewhere else on heap)    │
  │ ...                                          │
  │ ref → int[1000]  (somewhere else on heap)    │
  └─────────────────────────────────────────────┘
```

Memory cost:
```
Outer array:     16 (header) + 1000 × 4 (refs) = 4,016 bytes
1000 inner arrays: 1000 × (16 + 1000 × 4) = 1000 × 4,016 = 4,016,000 bytes
Total: 4,020,016 bytes ≈ 3.83 MB
Plus overhead: 1001 object headers for GC to manage
```

### Cache Locality Problem

Accessing `matrix[i][j]` requires:
1. Load `matrix` reference (already in register from loop)
2. Load `matrix[i]` — dereference pointer to find the i-th row array (possible cache miss)
3. Load `matrix[i][j]` — dereference pointer within that row array

The 1000 row arrays are allocated sequentially in Eden (due to TLAB), so initially they are cache-friendly. But after GC, the garbage collector may relocate them to different heap regions, destroying spatial locality. After several GC cycles, the rows can be scattered across the Old Generation.

### Row-Major vs. Column-Major Traversal

```java
// Row-major (cache-friendly):
for (int i = 0; i < n; i++)
    for (int j = 0; j < n; j++)
        sum += matrix[i][j];    // sequential access within each row

// Column-major (cache-hostile):
for (int j = 0; j < n; j++)
    for (int i = 0; i < n; i++)
        sum += matrix[i][j];    // jumps to a different row array on every access
```

Each `int[]` row is a contiguous 4000-byte block (1000 ints × 4 bytes). Row-major traversal reads sequentially through each row — the CPU prefetcher loads subsequent cache lines automatically. Column-major traversal accesses one element from each of the 1000 different row arrays in sequence — 1000 potential cache misses per column.

Benchmark (1000x1000 int matrix, JDK 17):
```
Row-major traversal:    ~0.8 ms
Column-major traversal: ~4.5 ms  (5.6x slower)
```

### Flat Array Alternative

```java
int[] matrix = new int[1000 * 1000];

// Access (i, j):
int value = matrix[i * 1000 + j];

// Set (i, j):
matrix[i * 1000 + j] = value;
```

Memory cost:
```
Single array: 16 (header) + 1,000,000 × 4 = 4,000,016 bytes ≈ 3.81 MB
Objects: 1 (instead of 1001)
```

Advantages:
- One contiguous block — perfect spatial locality
- Single object header — trivial for GC
- No pointer chasing — address is computed arithmetically
- Column-major traversal is still not ideal (stride of 4000 bytes between elements), but no worse than jagged
- `System.arraycopy()` can copy entire rows or the whole matrix in one call

The trade-off is readability. You lose `matrix[i][j]` syntax and must manually compute indices. For performance-critical code (image processing, scientific computing, matrix operations), the flat representation is always faster.

### Three-Dimensional and Beyond

The problem compounds with more dimensions:

```java
int[][][] cube = new int[100][100][100];
// Creates: 1 + 100 + 100*100 = 10,101 objects
// That is 10,101 object headers, 10,101 GC-traceable references

// Flat:
int[] cube = new int[100 * 100 * 100];
// Access (i, j, k): cube[i * 10000 + j * 100 + k]
// 1 object, 1 header, 0 pointer chasing
```

---

## 2.5 `Arrays.sort()`: Dual-Pivot Quicksort vs. TimSort

The JDK uses two completely different sorting algorithms depending on whether you are sorting primitives or objects. This is not an arbitrary choice — it is driven by the fundamental difference between value types and reference types.

### Primitives: Dual-Pivot Quicksort

```java
int[] arr = {5, 3, 8, 1, 9, 2};
Arrays.sort(arr);  // Uses dual-pivot quicksort (DualPivotQuicksort.sort)
```

**Why quicksort for primitives?**

1. **No stability requirement.** Primitive values have no identity — two `5`s are indistinguishable. There is no concept of "preserving the relative order of equal elements" because equal elements are identical.

2. **Cache efficiency.** Quicksort operates in-place with excellent cache locality. The partitioning scans forward and backward through a contiguous `int[]`. Compare-and-swap on adjacent elements hits L1 cache consistently.

3. **Fewer comparisons.** Dual-pivot quicksort (Yaroslavskiy's algorithm, in JDK since Java 7) uses two pivots that partition the array into three segments. On average, it performs ~1.9n ln n comparisons vs ~2n ln n for classic single-pivot quicksort — a 5% improvement that matters at scale.

**The dual-pivot algorithm:**

```
Choose two pivots P1 < P2 from the array.
Partition into three segments:
  [elements < P1] [elements >= P1 and <= P2] [elements > P2]

┌──────────────┬────────────────────┬──────────────┐
│  < P1        │  P1 <= x <= P2     │  > P2        │
└──────────────┴────────────────────┴──────────────┘
       ↓                 ↓                  ↓
  recurse             recurse           recurse
```

The actual implementation in `DualPivotQuicksort.java` is much more sophisticated:
- For small arrays (< 47 elements): **insertion sort** (low overhead, cache-friendly)
- For small-medium arrays (< 286 elements): **single-pivot quicksort** (simpler, less overhead)
- For larger arrays: **dual-pivot quicksort** with median-of-five pivot selection
- If too many equal elements detected: switches to a **merging** strategy to avoid O(n^2) worst case

### Objects: TimSort

```java
String[] names = {"Charlie", "Alice", "Bob"};
Arrays.sort(names);  // Uses TimSort (ComparableTimSort or TimSort with Comparator)
```

**Why TimSort for objects?**

1. **Stability required.** Objects have identity. If you sort a list of `Employee` objects by department, you want employees within the same department to retain their original order. Quicksort is not stable — equal elements may be reordered. TimSort guarantees stability.

2. **Exploits pre-existing order.** Real-world data is often partially sorted — logs with timestamps, database results, incremental updates. TimSort finds natural "runs" (already-sorted subsequences) and merges them. On partially sorted data, TimSort approaches O(n). Quicksort always does O(n log n) regardless of existing order.

3. **Comparable contract.** The `Comparable` contract requires a total order (reflexive, antisymmetric, transitive). TimSort's merge strategy relies on this. Quicksort's correctness does not — it works even with inconsistent comparators (though the result is unspecified).

**TimSort algorithm:**

```
1. Scan the array for natural "runs" (ascending or descending sequences)
2. If a run is too short (< minRun, typically 32), extend it using binary insertion sort
3. Push runs onto a stack
4. Merge adjacent runs using a merge strategy that maintains stack invariants:
   - If stack has [A, B, C]: merge so that |A| > |B| + |C| and |B| > |C|
   - This ensures O(n log n) merges in total
5. The merge uses a temporary buffer (galloping mode for large merges)
```

**Memory overhead:** TimSort allocates a temporary array of size n/2 for merging. This is the trade-off for stability — quicksort sorts in-place with O(log n) stack space, while TimSort needs O(n) extra space.

### Performance Comparison

```
Scenario              Dual-Pivot QS (primitives)    TimSort (objects)
──────────────────────────────────────────────────────────────────────
Random data           Fastest (cache + in-place)     ~1.5x slower
Partially sorted      No benefit                     Near-O(n), much faster
Already sorted        O(n log n)                     O(n) — detects runs
Reverse sorted        O(n log n)                     O(n) — detects desc runs
Many duplicates       Good (3-way partitioning)      Good (stable merge)
Memory overhead       O(log n) stack                 O(n) temp array
```

### Parallel Sort

```java
Arrays.parallelSort(arr);  // Available since JDK 8
```

Uses fork-join to split the array, sort pieces in parallel, then merge. For arrays larger than 8192 elements, this can provide near-linear speedup on multi-core machines. The threshold (8192) exists because the overhead of task submission and synchronization makes parallelism counterproductive for small arrays.

---

## 2.6 `Arrays.binarySearch()`: Implementation Details

Binary search is the canonical O(log n) algorithm, but the JDK implementation has specific behaviors that catch people in interviews.

### The Implementation

```java
// Simplified from java.util.Arrays (JDK 17)
public static int binarySearch(int[] a, int key) {
    int low = 0;
    int high = a.length - 1;

    while (low <= high) {
        int mid = (low + high) >>> 1;  // unsigned right shift — avoids overflow!
        int midVal = a[mid];

        if (midVal < key)
            low = mid + 1;
        else if (midVal > key)
            high = mid - 1;
        else
            return mid;  // key found
    }
    return -(low + 1);  // key not found — returns insertion point
}
```

### The `>>>` Overflow Fix

The classic binary search bug (famously documented by Joshua Bloch) is:
```java
int mid = (low + high) / 2;  // BUG: if low + high > Integer.MAX_VALUE, overflow!
```

When `low` and `high` are both large (say, 1.5 billion each), their sum overflows to a negative number, and dividing by 2 gives a negative index. The fix:
```java
int mid = (low + high) >>> 1;  // unsigned right shift: treats the int as unsigned
```

The `>>>` operator shifts right without sign extension. Even if `low + high` overflows to a negative bit pattern, `>>>` 1 divides the unsigned value by 2, giving the correct positive midpoint.

### Behavior with Duplicates

`Arrays.binarySearch()` does **not** guarantee which occurrence of a duplicate it returns. From the Javadoc: "If the array contains multiple elements with the specified value, there is no guarantee which one will be found."

This is a critical interview point. If you need the **first** or **last** occurrence, you must write your own binary search:

```java
// Find first occurrence of target
public static int findFirst(int[] arr, int target) {
    int low = 0, high = arr.length - 1, result = -1;
    while (low <= high) {
        int mid = (low + high) >>> 1;
        if (arr[mid] == target) {
            result = mid;
            high = mid - 1;  // keep searching left
        } else if (arr[mid] < target) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return result;
}

// Find last occurrence of target
public static int findLast(int[] arr, int target) {
    int low = 0, high = arr.length - 1, result = -1;
    while (low <= high) {
        int mid = (low + high) >>> 1;
        if (arr[mid] == target) {
            result = mid;
            low = mid + 1;  // keep searching right
        } else if (arr[mid] < target) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return result;
}
```

### The Insertion Point

When the key is not found, the return value is `-(insertion point) - 1`, where the insertion point is the index at which the key would be inserted to maintain sorted order. This allows you to recover the insertion point:

```java
int index = Arrays.binarySearch(arr, key);
if (index < 0) {
    int insertionPoint = -(index + 1);
    // arr[insertionPoint] is the first element greater than key
    // (or insertionPoint == arr.length if key is greater than all elements)
}
```

This is useful for range queries: to find all elements in `[lo, hi]`, binary search for `lo` to find the start position and `hi` to find the end position.

---

## 2.7 Array-Based Techniques: Prefix Sums, Difference Arrays, Two Pointers

These three techniques exploit the contiguous nature of arrays to solve problems in O(n) that would otherwise require O(n^2).

### Prefix Sums

The prefix sum array `P[i]` stores the sum of `arr[0..i-1]`. This lets you compute any subarray sum in O(1):

```
Original:  arr = [3, 1, 4, 1, 5, 9, 2, 6]
Prefix:    P   = [0, 3, 4, 8, 9, 14, 23, 25, 31]
                  ^  ^
                  |  P[1] = arr[0] = 3
                  P[0] = 0 (identity element)

Sum of arr[2..5] = P[6] - P[2] = 23 - 4 = 19
Verify: 4 + 1 + 5 + 9 = 19  ✓
```

```java
public static long[] prefixSum(int[] arr) {
    long[] prefix = new long[arr.length + 1];
    for (int i = 0; i < arr.length; i++) {
        prefix[i + 1] = prefix[i] + arr[i];
    }
    return prefix;
}

public static long rangeSum(long[] prefix, int left, int right) {
    return prefix[right + 1] - prefix[left];  // sum of arr[left..right]
}
```

**JVM insight**: Using `long[]` for prefix sums even when the original array is `int[]` prevents overflow. The prefix sum loop is a textbook case for range check elimination — the JIT eliminates bounds checks on both `prefix` and `arr`.

### Difference Arrays

The inverse of prefix sums. A difference array lets you apply range updates in O(1) and reconstruct the result in O(n):

```
To add +5 to arr[2..5]:
  diff[2] += 5      // start of range
  diff[6] -= 5      // one past end of range

After all updates, reconstruct by prefix-summing the diff array.
```

```java
public static void rangeAdd(int[] diff, int left, int right, int val) {
    diff[left] += val;
    if (right + 1 < diff.length) {
        diff[right + 1] -= val;
    }
}

public static int[] reconstruct(int[] diff) {
    int[] result = new int[diff.length];
    result[0] = diff[0];
    for (int i = 1; i < diff.length; i++) {
        result[i] = result[i - 1] + diff[i];
    }
    return result;
}
```

**Real-world use**: Flight booking systems where you need to add passengers to all flights in a date range. Calendar systems marking busy blocks. Network bandwidth allocation across time slots.

### Two Pointers

Two pointers work on sorted arrays or arrays with monotonic properties. The key insight is that moving one pointer constrains the valid range for the other, avoiding the need for nested loops.

```
Pattern 1: Converging pointers (opposite ends)
  [─────────────────────────]
  ↑ left                right ↑
  Move left right or right left based on comparison

Pattern 2: Sliding window (same direction)
  [─────────────────────────]
  ↑ left  right ↑
  Both move rightward, maintaining a window invariant

Pattern 3: Fast-slow pointers
  [─────────────────────────]
  ↑ slow  ↑ fast
  Fast moves 2x speed, slow moves 1x — for cycle detection, midpoint finding
```

We will see all three patterns extensively in the problems section.

---

## 2.8 String Internal Representation: JDK 8 vs. JDK 9+ Compact Strings

This is one of the most significant internal changes in the JDK's history. It reduced the heap footprint of typical Java applications by 10-15% with zero API changes.

### JDK 8 and Earlier: `char[]`

```java
// JDK 8 String internals:
public final class String {
    private final char[] value;    // UTF-16 encoded, 2 bytes per character
    private int hash;              // cached hash code (0 means not computed)
    // ...
}
```

Every character is stored as a `char` (16 bits, UTF-16). The ASCII string `"hello"` occupies:

```
String object:    header(12) + ref value(4) + int hash(4) + padding(4) = 24 bytes
char[5] array:    header(16) + 5 × 2 bytes = 26 → 32 bytes (padded)
Total:            56 bytes for a 5-character ASCII string
```

The problem: the vast majority of strings in real applications contain only ASCII characters (Latin-1, U+0000 to U+00FF). English text, JSON keys, URLs, SQL, XML, log messages — all ASCII. Storing each character in 2 bytes wastes 50% of the space.

### JDK 9+: Compact Strings (`byte[]` + `coder`)

```java
// JDK 9+ String internals:
public final class String {
    private final byte[] value;    // character data (1 or 2 bytes per char)
    private final byte coder;      // 0 = LATIN1, 1 = UTF16
    private int hash;              // cached hash code
    private boolean hashIsZero;    // JDK 15+: disambiguates hash=0 from "not computed"
    // ...
}
```

The `coder` field is the key:

```
coder = 0 (LATIN1): each byte in value[] is one character (ISO-8859-1)
                     "hello" → value = [104, 101, 108, 108, 111]  (5 bytes)

coder = 1 (UTF16):  every two bytes in value[] form one UTF-16 code unit
                     "hello" → value = [0,104, 0,101, 0,108, 0,108, 0,111]  (10 bytes)
                     Used when ANY character is outside Latin-1 (U+0100+)
```

The memory savings for `"hello"`:

```
JDK 9+ String:     header(12) + ref value(4) + byte coder(1) + int hash(4)
                    + boolean hashIsZero(1) + padding(2) = 24 bytes
byte[5] array:     header(16) + 5 × 1 bytes = 21 → 24 bytes (padded)
Total:             48 bytes  (vs 56 in JDK 8 — 14% savings)
```

For longer strings, the savings are more dramatic:

```
String of length 100 (ASCII):
  JDK 8:   24 + (16 + 200) = 240 bytes
  JDK 9+:  24 + (16 + 100) = 140 bytes  — 42% smaller

String of length 1000 (ASCII):
  JDK 8:   24 + (16 + 2000) = 2040 bytes
  JDK 9+:  24 + (16 + 1000) = 1040 bytes — 49% smaller
```

### How Methods Switch on `coder`

Every `String` method that accesses characters checks the `coder` field to determine the encoding:

```java
// Simplified from JDK source
public char charAt(int index) {
    if (isLatin1()) {
        return (char)(value[index] & 0xFF);       // 1-byte read, zero-extend
    } else {
        return StringUTF16.charAt(value, index);   // 2-byte read from byte[]
    }
}

// isLatin1() is: (coder == LATIN1)
// The JIT inlines this and often eliminates the branch for monomorphic call sites
// (i.e., if a method always receives Latin-1 strings, the UTF-16 path is dead code)
```

The JIT's profile-guided optimization is key here. If 99% of strings at a call site are Latin-1, the JIT generates code with an optimistic Latin-1 fast path and an uncommon trap for UTF-16. The UTF-16 path is not even generated in the compiled code — it falls back to the interpreter if triggered.

### When a String Becomes UTF-16

A single non-Latin-1 character forces the entire string to UTF-16 encoding:

```java
String ascii = "hello";         // coder = 0, value = byte[5]
String mixed = "hello" + "ñ";   // coder = 1, value = byte[12] (6 chars × 2 bytes)
String emoji = "hi" + "😀";     // coder = 1, value = byte[8]  (2 chars + 1 surrogate pair = 4 code units × 2 bytes)
```

There is no going back — once UTF-16, the concatenation result is UTF-16 even if the other operand is Latin-1. This is a one-way escalation.

**Real-world impact**: In microservices processing JSON (ASCII keys, ASCII or Latin-1 values), compact strings save 30-50% of String heap. For applications handling Chinese/Japanese/Korean (CJK) text heavily, the savings are minimal since those characters require UTF-16. The flag `-XX:-CompactStrings` disables the feature (forcing all strings to UTF-16), but there is almost never a reason to do so.

---

## 2.9 String Immutability: Security and the `final` Value Array

`String` is immutable. The `value` array is declared `private final`. Once a String is created, its character data never changes. This is not just a design choice — it is a security requirement.

### Why `value` Is `final`

```java
public final class String {
    private final byte[] value;  // cannot be reassigned after construction
    // ...
}
```

The `final` keyword on the field means:
1. The field cannot be reassigned after the constructor completes.
2. The JVM guarantees that other threads see the fully initialized `value` reference (the JMM's `final` field semantics provide a happens-before guarantee).

But `final` only prevents reassignment of the reference — it does not prevent modification of the array contents. So why can we not modify `value`?

1. **`private` access**: No external code can access the `value` field directly.
2. **No mutating methods**: `String` exposes no methods that modify `value`.
3. **Defensive copies**: Methods like `String(char[] value)` copy the input array rather than storing the reference:

```java
// From JDK source (simplified):
public String(char[] value) {
    this.value = Arrays.copyOf(value, value.length);  // defensive copy!
    // Even if the caller modifies their char[] afterward, this String is unaffected
}
```

### Security Implications

String immutability is relied upon by:

1. **ClassLoader**: Class names are strings. If a malicious library could mutate a class name string after the security manager approved it but before the classloader loaded it, it could trick the JVM into loading a different class.

```java
String className = "java.lang.String";  // security check passes
// If mutable: className.value[10] = 'X';  // now it is "java.lang.Xtring"
// ClassLoader would load a malicious class!
```

2. **Network connections**: `URL` and `Socket` store hostnames as strings. If the hostname could be mutated after a security check but before the connection is made, traffic could be redirected.

3. **HashMap keys**: Strings are by far the most common `HashMap` key type. If a string's value could change after insertion, its hash code would change, and the entry would be "lost" — `map.get(key)` would search the wrong bucket. Immutability guarantees that `String.hashCode()` always returns the same value.

4. **String pool**: Interned strings are shared across the entire JVM. If one thread could mutate a shared interned string, every other thread using that string would see the mutation.

### Reflection Attack

You can actually bypass immutability using reflection — this is a known (and intentional) escape hatch:

```java
String s = "hello";
Field valueField = String.class.getDeclaredField("value");
valueField.setAccessible(true);
byte[] value = (byte[]) valueField.get(s);
value[0] = 72;  // 'H'
System.out.println(s);  // "Hello" — the "immutable" string was mutated!
// WARNING: This also mutates every other reference to the interned "hello"!
```

In JDK 16+, `setAccessible(true)` on core JDK classes throws `InaccessibleObjectException` by default (strong encapsulation via the module system). You must add `--add-opens java.base/java.lang=ALL-UNNAMED` to the JVM flags. This is a deliberate security hardening.

---

## 2.10 String Interning: The StringTable

String interning is the process of deduplicating identical strings so they share the same object reference. The JVM maintains a global hash table called the **StringTable** for this purpose.

### How Interning Works

```java
String s1 = "hello";           // literal → automatically interned
String s2 = "hello";           // same literal → same reference from StringTable
String s3 = new String("hello"); // new object on heap — NOT interned
String s4 = s3.intern();       // explicitly intern → returns reference from StringTable

System.out.println(s1 == s2);  // true  (same reference)
System.out.println(s1 == s3);  // false (different objects)
System.out.println(s1 == s4);  // true  (intern returns the canonical instance)
```

### The StringTable Implementation

The StringTable is a native-side hash table (not a Java `HashMap`). Key details:

1. **Location**: In JDK 7+, the StringTable lives on the **heap** (not PermGen/Metaspace). This means interned strings are garbage-collected when no longer referenced.

2. **Weak references**: The StringTable holds **weak references** to interned strings. If no strong reference exists to an interned string, it can be GC'd. This prevents the StringTable from being an unbounded memory leak.

3. **Size**: Controlled by `-XX:StringTableSize=N` (default 65,536 in JDK 11+, was 1,009 in JDK 7 — a notorious bottleneck). The size should be a prime number for optimal hashing. If your application interns many strings, increase this:

```
-XX:StringTableSize=1000003   // prime number, good for ~500K interned strings
```

4. **Hash collisions**: The StringTable uses open addressing with linear probing. A too-small table with too many entries degrades to O(n) lookup — `String.intern()` becomes a performance bottleneck instead of an optimization.

### When to Intern (and When Not To)

**Good use case**: You are processing millions of JSON records where the key set is small and repeated (e.g., `"name"`, `"age"`, `"email"` appearing in every record). Without interning, each `"name"` from each record is a separate String object. With interning, all share one instance.

```java
// Without interning: 1M records × 3 keys × ~48 bytes = ~144 MB of duplicate Strings
// With interning: 3 canonical Strings + 1M records × 3 references = ~12 MB + negligible
```

**Bad use case**: You are interning unique strings (UUIDs, user IDs, timestamps). Each call to `intern()` adds an entry to the StringTable, which is searched linearly on collision. Millions of unique interned strings bloat the table and slow down all future `intern()` calls.

### G1 String Deduplication

Since JDK 8u20, the G1 garbage collector can deduplicate strings automatically:

```
-XX:+UseG1GC -XX:+UseStringDeduplication
```

G1 detects strings with identical `value` arrays and makes them share the same backing `byte[]`. This is different from interning — the String objects remain separate (different identity), but they point to the same `value` array. This saves memory without the overhead of explicit `intern()` calls and without polluting the StringTable.

---

## 2.11 String Concatenation Evolution

The way Java compiles `String s = a + b + c;` has changed dramatically across JDK versions. Understanding this evolution explains why some "rules" from older Java no longer apply.

### JDK 1-4: Naive Concatenation

```java
String s = a + b + c;
// Compiled to (approximately):
String s = new StringBuffer().append(a).append(b).append(c).toString();
```

`StringBuffer` is synchronized — every `append()` acquires a lock. For single-threaded string building, this synchronization is pure waste.

### JDK 5-8: StringBuilder

```java
String s = a + b + c;
// Compiled to:
String s = new StringBuilder().append(a).append(b).append(c).toString();
```

The compiler switched from `StringBuffer` to `StringBuilder` (unsynchronized). Better, but still creates a `StringBuilder` object, potentially resizes its internal array multiple times, and creates a final String from it.

The problem with the StringBuilder approach:

```java
String s = a + b + c + d + e;
// Creates: 1 StringBuilder, possibly 2-3 internal array resizes,
// then 1 String with a final array copy.
// The StringBuilder's initial capacity is 16 characters — often too small.
```

### JDK 9+: `invokedynamic` + `StringConcatFactory`

```java
String s = a + b + c;
// Compiled to bytecode:
invokedynamic #makeConcatWithConstants (String, String, String) → String
```

The `invokedynamic` instruction delegates to `java.lang.invoke.StringConcatFactory` at link time. The factory generates an optimized strategy at runtime based on the actual types and sizes of the operands. The strategies include:

1. **BC_SB (StringBuilder-based)**: Falls back to StringBuilder for complex cases.
2. **BC_SB_SIZED**: Creates a StringBuilder with a pre-computed capacity.
3. **BC_SB_SIZED_EXACT**: Creates a StringBuilder with the exact needed capacity.
4. **MH_SB_SIZED**: MethodHandle chains to StringBuilder with sizing.
5. **MH_SB_SIZED_EXACT**: MethodHandle chains with exact sizing.
6. **MH_INLINE_SIZED_EXACT** (default): The most optimized strategy — directly allocates a `byte[]` of the exact needed size, copies all operands into it, and wraps it in a String. No StringBuilder, no resizing, no intermediate copies.

The default strategy (`MH_INLINE_SIZED_EXACT`) is significantly faster because:
- It pre-computes the exact size needed (sum of all operand lengths)
- It allocates one `byte[]` of exactly that size
- It copies each operand directly into position (no intermediate buffer)
- No object creation except the final String
- No array resizing

```
JDK 8 (StringBuilder):
  alloc StringBuilder(16) → append(a) → possible resize → append(b) → append(c) → toString() → alloc String → arraycopy
  Objects created: 2-3 (StringBuilder, internal char[], final String)
  Array copies: 2-4

JDK 9+ (MH_INLINE_SIZED_EXACT):
  compute size → alloc byte[size] → copy a → copy b → copy c → wrap in String
  Objects created: 1 (the String, which wraps the byte[] directly — no copy)
  Array copies: 0 (writes directly to final byte[])
```

### Implications for Code Style

The old advice "use StringBuilder in a loop, never concatenate with `+`" is still valid **in loops**. The `invokedynamic` approach optimizes individual concatenation expressions, not loop-accumulated concatenation:

```java
// STILL BAD (every iteration creates a new String):
String result = "";
for (String item : items) {
    result = result + item;  // JDK 9+ makes each + faster, but still O(n^2) total
}

// GOOD:
StringBuilder sb = new StringBuilder();
for (String item : items) {
    sb.append(item);
}
String result = sb.toString();
```

The `+` in a loop is O(n^2) because each iteration copies the entire accumulated string. No amount of JIT optimization fixes the algorithmic complexity.

---

## 2.12 `StringBuilder` vs. `StringBuffer` Internals

Both `StringBuilder` and `StringBuffer` extend `AbstractStringBuilder` and share the same internal representation. The only difference is synchronization.

### Internal Representation (JDK 9+)

```java
abstract class AbstractStringBuilder {
    byte[] value;      // backing storage (same compact string encoding as String)
    byte coder;        // 0 = LATIN1, 1 = UTF16
    int count;         // number of characters used (NOT bytes used)
    // ...
}
```

### Growth Strategy

When the backing `byte[]` is full and you `append()` more data, it grows:

```java
// From AbstractStringBuilder:
private int newCapacity(int minCapacity) {
    int oldLength = value.length;
    int newLength = minCapacity << coder;  // multiply by 1 (Latin1) or 2 (UTF16)
    int growth = oldLength + (2 << coder); // oldLength + 2 (Latin1) or + 4 (UTF16)
    // But the actual formula simplifies to:
    // newCapacity = max(minCapacity, oldCapacity * 2 + 2)
    // The "+2" ensures growth even when oldCapacity is 0
    // ...
}
```

The growth strategy is `oldCapacity * 2 + 2`. The `+ 2` prevents stagnation at capacity 0 or 1. Let us trace it:

```
Initial capacity: 16 (default constructor)
After overflow:   16 * 2 + 2 = 34
After overflow:   34 * 2 + 2 = 70
After overflow:   70 * 2 + 2 = 142
After overflow:   142 * 2 + 2 = 286
...
```

Each resize involves `Arrays.copyOf()` → `System.arraycopy()` — fast, but still O(n) per resize. The doubling ensures amortized O(1) append.

### Why StringBuffer's Synchronization Is Almost Never Needed

`StringBuffer` synchronizes every method:

```java
// StringBuffer:
@Override
public synchronized StringBuffer append(String str) {
    toStringCache = null;
    super.append(str);
    return this;
}

// StringBuilder:
@Override
public StringBuilder append(String str) {
    super.append(str);
    return this;
}
```

The `synchronized` keyword acquires the monitor on the `StringBuffer` instance for every `append()`. In theory, this makes `StringBuffer` thread-safe. In practice:

1. **String building is almost always single-threaded.** You build a string in one method, in one thread. Sharing a `StringBuilder` across threads is a code smell, not a pattern.

2. **Per-method synchronization is insufficient.** Even if two threads share a `StringBuffer`, the synchronization only guarantees atomicity of individual `append()` calls. A sequence like `sb.append(a); sb.append(b);` is not atomic — another thread can insert between the two appends. For true thread safety, you need external synchronization anyway.

3. **Biased locking (JDK 8-14) / thin locking eliminates most overhead.** HotSpot's lock coarsening and lock elision can often remove the synchronization entirely when the JIT proves the StringBuffer does not escape the thread. But this optimization is not guaranteed.

**Rule**: Always use `StringBuilder`. Use `StringBuffer` only if you explicitly need to share a string builder across threads (and even then, reconsider your design).

### Pre-sizing

If you know the approximate final size, pre-size the `StringBuilder` to avoid resizes:

```java
// Bad: default capacity 16, may resize 5+ times for a 1000-char string
StringBuilder sb = new StringBuilder();

// Good: allocate once, no resizes
StringBuilder sb = new StringBuilder(1024);
```

---

## 2.13 String Matching Algorithms

String matching — finding occurrences of a pattern `P` in a text `T` — is a fundamental problem that appears in text editors, search engines, bioinformatics, log analysis, and intrusion detection systems. We cover four algorithms in increasing sophistication.

### Brute Force: O(n * m)

```java
public static int bruteForceSearch(String text, String pattern) {
    int n = text.length(), m = pattern.length();
    for (int i = 0; i <= n - m; i++) {
        int j = 0;
        while (j < m && text.charAt(i + j) == pattern.charAt(j)) {
            j++;
        }
        if (j == m) return i;  // match found at index i
    }
    return -1;  // no match
}
```

For each position `i` in the text, we compare up to `m` characters. Worst case: `T = "aaa...aab"`, `P = "aab"` — almost-matches at every position, O(n * m).

### KMP (Knuth-Morris-Pratt): O(n + m)

KMP's key insight: when a mismatch occurs, we have already matched some characters. The **failure function** (also called the prefix function or partial match table) tells us the longest proper prefix of the pattern that is also a suffix of the matched portion. We can skip to that position instead of restarting from the beginning.

**The failure function:**

For pattern `P`, `fail[i]` = length of the longest proper prefix of `P[0..i]` that is also a suffix of `P[0..i]`.

```
Pattern:  a  b  a  b  a  c
Index:    0  1  2  3  4  5
fail[]:   0  0  1  2  3  0

Explanation:
  fail[0] = 0  (single char, no proper prefix/suffix)
  fail[1] = 0  "ab" — no proper prefix equals suffix
  fail[2] = 1  "aba" — "a" is both prefix and suffix (length 1)
  fail[3] = 2  "abab" — "ab" is both prefix and suffix (length 2)
  fail[4] = 3  "ababa" — "aba" is both prefix and suffix (length 3)
  fail[5] = 0  "ababac" — no proper prefix equals suffix
```

**Full KMP implementation:**

```java
public static int[] computeFailure(String pattern) {
    int m = pattern.length();
    int[] fail = new int[m];
    fail[0] = 0;
    int len = 0;  // length of the previous longest prefix-suffix
    int i = 1;
    while (i < m) {
        if (pattern.charAt(i) == pattern.charAt(len)) {
            len++;
            fail[i] = len;
            i++;
        } else {
            if (len != 0) {
                len = fail[len - 1];  // fall back — do NOT increment i
            } else {
                fail[i] = 0;
                i++;
            }
        }
    }
    return fail;
}

public static int kmpSearch(String text, String pattern) {
    int n = text.length(), m = pattern.length();
    if (m == 0) return 0;
    int[] fail = computeFailure(pattern);
    int i = 0;  // index in text
    int j = 0;  // index in pattern
    while (i < n) {
        if (text.charAt(i) == pattern.charAt(j)) {
            i++;
            j++;
        }
        if (j == m) {
            return i - m;  // match found
            // For all occurrences: record (i - m), then j = fail[j - 1]; continue;
        } else if (i < n && text.charAt(i) != pattern.charAt(j)) {
            if (j != 0) {
                j = fail[j - 1];  // use failure function — no backtracking on i
            } else {
                i++;
            }
        }
    }
    return -1;
}
```

**Why O(n + m)**: The text pointer `i` never goes backward. Each character in the text is compared at most once for a forward step. The failure function backtracks only on the pattern pointer `j`, and each backtrack is bounded by the total forward progress of `j`. Computing the failure function is O(m) by the same argument.

### Rabin-Karp: O(n + m) Average, O(nm) Worst

Rabin-Karp uses a **rolling hash** to compare windows of text with the pattern. Instead of comparing characters, it computes hash values. If hashes match, it verifies with a character-by-character comparison (to handle collisions).

**The rolling hash:**

```
Hash of string s[0..m-1] using base d and modulus q:
  H = (s[0] * d^(m-1) + s[1] * d^(m-2) + ... + s[m-1]) mod q

To slide the window one position right (remove s[i], add s[i+m]):
  H_new = (d * (H_old - s[i] * d^(m-1)) + s[i + m]) mod q
```

This is a constant-time operation — we do not recompute the entire hash.

```java
public static int rabinKarp(String text, String pattern) {
    int n = text.length(), m = pattern.length();
    if (m > n) return -1;

    long d = 256;       // number of characters in alphabet
    long q = 1_000_000_007;  // a large prime
    long h = 1;         // d^(m-1) mod q

    // Precompute h = d^(m-1) % q
    for (int i = 0; i < m - 1; i++) {
        h = (h * d) % q;
    }

    // Compute initial hash values for pattern and first window of text
    long pHash = 0, tHash = 0;
    for (int i = 0; i < m; i++) {
        pHash = (d * pHash + pattern.charAt(i)) % q;
        tHash = (d * tHash + text.charAt(i)) % q;
    }

    // Slide the window
    for (int i = 0; i <= n - m; i++) {
        if (pHash == tHash) {
            // Hash match — verify character by character (handles collisions)
            boolean match = true;
            for (int j = 0; j < m; j++) {
                if (text.charAt(i + j) != pattern.charAt(j)) {
                    match = false;
                    break;
                }
            }
            if (match) return i;
        }
        // Compute hash for next window
        if (i < n - m) {
            tHash = (d * (tHash - text.charAt(i) * h) + text.charAt(i + m)) % q;
            if (tHash < 0) tHash += q;  // ensure positive
        }
    }
    return -1;
}
```

**Why Rabin-Karp over KMP?** Rabin-Karp generalizes easily to:
- **Multiple pattern search**: Compute hashes for all patterns, store in a HashSet, check each window against the set. O(n * k) for k patterns, vs O(n * m * k) brute force.
- **2D pattern matching**: Compute row hashes, then column hashes over the row hashes.
- **Plagiarism detection**: Rolling hash on overlapping chunks of documents.

### Z-Algorithm: O(n + m)

The Z-array for a string `S` is defined as: `Z[i]` = length of the longest substring starting at position `i` that matches a prefix of `S`.

For pattern matching, we concatenate `pattern + "$" + text` (where `$` is a character not in either string) and compute the Z-array. Any position where `Z[i] == pattern.length()` indicates a match.

```java
public static int[] zFunction(String s) {
    int n = s.length();
    int[] z = new int[n];
    z[0] = n;  // by convention (or sometimes left as 0)
    int l = 0, r = 0;
    for (int i = 1; i < n; i++) {
        if (i < r) {
            z[i] = Math.min(r - i, z[i - l]);
        }
        while (i + z[i] < n && s.charAt(z[i]) == s.charAt(i + z[i])) {
            z[i]++;
        }
        if (i + z[i] > r) {
            l = i;
            r = i + z[i];
        }
    }
    return z;
}

public static int zSearch(String text, String pattern) {
    String combined = pattern + "$" + text;
    int[] z = zFunction(combined);
    int m = pattern.length();
    for (int i = m + 1; i < combined.length(); i++) {
        if (z[i] == m) {
            return i - m - 1;  // match at this position in original text
        }
    }
    return -1;
}
```

The Z-algorithm is often easier to implement correctly than KMP and has the same O(n + m) complexity. It is widely used in competitive programming for this reason.

---

## 2.14 `String.hashCode()`: Why 31?

The hash code of a Java String is computed as:

```
s[0]*31^(n-1) + s[1]*31^(n-2) + ... + s[n-1]
```

```java
// From JDK source (simplified):
public int hashCode() {
    int h = hash;
    if (h == 0 && !hashIsZero) {
        for (int i = 0; i < value.length; i++) {
            h = 31 * h + charAt(i);
        }
        if (h == 0) {
            hashIsZero = true;
        } else {
            hash = h;
        }
    }
    return h;
}
```

### Why 31?

The number 31 was chosen for three specific reasons:

1. **Odd prime**: Using a prime reduces hash collisions because the multiplication distributes bits more uniformly. Using an even number would lose information (left shift discards the high bit). Using a non-prime would cause more clustering.

2. **JIT optimization**: `31 * i` can be replaced by `(i << 5) - i` — a shift and subtract, which is faster than multiplication on older CPUs. Modern x86 CPUs have fast multiplication (3-cycle latency for `imul`), so this matters less today, but the JIT still applies this optimization.

3. **Good distribution**: Empirical testing by the JDK team showed that 31 produces fewer collisions than other small primes (29, 37, etc.) on typical Java string data (class names, method names, English words).

### The `hashIsZero` Field (JDK 15+)

The old code had a subtle inefficiency:

```java
// Pre-JDK 15:
public int hashCode() {
    int h = hash;
    if (h == 0 && value.length > 0) {  // hash == 0 could mean "not computed" OR "computed and is 0"
        for (byte v : value) {
            h = 31 * h + (v & 0xff);
        }
        hash = h;  // if h happens to be 0, we recompute EVERY TIME
    }
    return h;
}
```

The string `"" + (char)0` hashes to 0. With the old code, its hash would be recomputed on every call to `hashCode()`. The `hashIsZero` boolean (JDK 15+) distinguishes "not computed" from "computed and is zero."

### Collision Behavior

The polynomial hash `31^n * c0 + 31^(n-1) * c1 + ...` is not collision-resistant in a cryptographic sense. It is easy to find collisions:

```java
"Aa".hashCode() == "BB".hashCode()  // both equal 2112
// Because: 'A'*31 + 'a' = 65*31 + 97 = 2112
//          'B'*31 + 'B' = 66*31 + 66 = 2112
```

You can extend this to build arbitrarily long colliding strings. This is the basis of **hash-flooding attacks** against `HashMap`. JDK 8 mitigated this by converting long chains to balanced trees (red-black trees) when a bucket exceeds 8 entries (the TREEIFY_THRESHOLD). We will cover this in the HashMap chapter.

---

## Problems

We now apply everything from this chapter — and Chapter 1 — to 50 problems covering arrays, strings, and their intersection. Every solution includes the JVM-level insight that separates a senior engineer from a memorized-solutions candidate.

---

### Problem 1: Two Sum (Easy)

**Problem**: Given an integer array `nums` and an integer `target`, return indices of the two numbers that add up to `target`. Each input has exactly one solution, and you may not use the same element twice.

```java
public int[] twoSum(int[] nums, int target) {
    Map<Integer, Integer> map = new HashMap<>();
    for (int i = 0; i < nums.length; i++) {
        int complement = target - nums[i];
        if (map.containsKey(complement)) {
            return new int[]{map.get(complement), i};
        }
        map.put(nums[i], i);
    }
    throw new IllegalArgumentException("No two sum solution");
}
```

**Time**: O(n) — single pass with O(1) HashMap lookups.
**Space**: O(n) — HashMap stores up to n entries.

**JVM insight**: The `nums[i]` autoboxes to `Integer` for the HashMap key. Values -128 to 127 return cached `Integer` instances (`Integer.valueOf()` cache), avoiding heap allocation. For larger values, each `put()` creates a new `Integer` object (16 bytes) and a `HashMap.Node` (32 bytes). For n = 10^6, that is ~48 MB just for the map. In production systems with extreme constraints, a primitive `int`-to-`int` map (Eclipse Collections `IntIntHashMap`) eliminates boxing entirely.

**Real-world correlation**: Index lookups in caching layers — given a request ID, find the matching response. The pattern of building a lookup map on the first pass is identical to how in-memory index construction works in databases.

---

### Problem 2: Best Time to Buy and Sell Stock (Easy)

**Problem**: Given an array `prices` where `prices[i]` is the price on day `i`, find the maximum profit from one buy-sell transaction. If no profit is possible, return 0.

```java
public int maxProfit(int[] prices) {
    int minPrice = Integer.MAX_VALUE;
    int maxProfit = 0;
    for (int price : prices) {
        if (price < minPrice) {
            minPrice = price;
        } else {
            maxProfit = Math.max(maxProfit, price - minPrice);
        }
    }
    return maxProfit;
}
```

**Time**: O(n) — single pass.
**Space**: O(1) — two variables.

**JVM insight**: This is an ideal loop for JIT optimization. The `for-each` over `int[]` compiles to an indexed loop with range check elimination. `Math.max()` is a JIT intrinsic that compiles to a conditional move (`cmov`) instruction on x86 — no branch, no branch misprediction. The loop body is ~5 machine instructions with zero memory allocation.

**Real-world correlation**: Sliding-window profit analysis in trading systems. The single-pass approach mirrors how real-time price feeds are processed — you cannot look backward through the stream, you track the running minimum and maximum delta.

---

### Problem 3: Contains Duplicate (Easy)

**Problem**: Given an integer array `nums`, return `true` if any value appears at least twice.

```java
public boolean containsDuplicate(int[] nums) {
    Set<Integer> seen = new HashSet<>();
    for (int num : nums) {
        if (!seen.add(num)) {
            return true;  // add returns false if element already present
        }
    }
    return false;
}
```

**Time**: O(n) average.
**Space**: O(n) worst case.

**JVM insight**: `HashSet<Integer>` is backed by `HashMap<Integer, Object>` where every value is the same dummy `PRESENT` object. Each element requires: 1 `Integer` (16 bytes) + 1 `HashMap.Node` (32 bytes) = 48 bytes. For large arrays of primitives, consider `Arrays.sort()` + adjacent comparison: O(n log n) time but O(1) extra space (sort is in-place for primitives), and no autoboxing or HashMap overhead. The sort approach uses the CPU cache far more efficiently since it operates on contiguous `int[]` data.

**Real-world correlation**: Deduplication in ETL pipelines. When ingesting millions of records, checking for duplicates is the same operation. In production, Bloom filters provide a probabilistic alternative with O(1) space per element and no false negatives for "not seen" — HBase and Cassandra use them for exactly this.

---

### Problem 4: Maximum Subarray — Kadane's Algorithm (Medium)

**Problem**: Given an integer array `nums`, find the contiguous subarray with the largest sum and return its sum.

```java
public int maxSubArray(int[] nums) {
    int currentMax = nums[0];
    int globalMax = nums[0];
    for (int i = 1; i < nums.length; i++) {
        currentMax = Math.max(nums[i], currentMax + nums[i]);
        globalMax = Math.max(globalMax, currentMax);
    }
    return globalMax;
}
```

**Time**: O(n) — single pass.
**Space**: O(1).

**JVM insight**: Kadane's algorithm is a dynamic programming solution that keeps only the previous state (one variable). The JIT can auto-vectorize this in theory, but the data dependency (`currentMax` depends on the previous iteration's `currentMax`) prevents vectorization — this is a serial dependency chain. Each iteration depends on the result of the previous one, so the CPU cannot execute multiple iterations in parallel. Despite this, the loop is tight enough (~4 instructions per iteration) that it processes at near-memory-bandwidth speed.

**Real-world correlation**: Maximum contiguous revenue period analysis. Also the core of signal processing — finding the strongest signal burst in a noisy data stream. In finance, Kadane's algorithm applied to daily returns finds the best continuous holding period.

---

### Problem 5: Merge Intervals (Medium)

**Problem**: Given an array of intervals where `intervals[i] = [start_i, end_i]`, merge all overlapping intervals and return the non-overlapping intervals.

```java
public int[][] merge(int[][] intervals) {
    if (intervals.length <= 1) return intervals;
    Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));
    List<int[]> merged = new ArrayList<>();
    int[] current = intervals[0];
    merged.add(current);
    for (int i = 1; i < intervals.length; i++) {
        if (intervals[i][0] <= current[1]) {
            current[1] = Math.max(current[1], intervals[i][1]);
        } else {
            current = intervals[i];
            merged.add(current);
        }
    }
    return merged.toArray(new int[merged.size()][]);
}
```

**Time**: O(n log n) — dominated by sorting.
**Space**: O(n) — for the output list (O(log n) for sort stack).

**JVM insight**: `Arrays.sort(intervals, comparator)` uses TimSort because we are sorting objects (`int[]` references). The comparator `(a, b) -> Integer.compare(a[0], b[0])` is a lambda that the JIT can inline aggressively. Each `int[]` in `intervals` is a separate heap object — when TimSort moves elements, it moves 4-byte references, not the arrays themselves. The `merged.toArray(new int[size][])` call at the end allocates a fresh `int[][]` and copies references — the actual `int[]` arrays are shared between the input and output (no deep copy).

**Real-world correlation**: Calendar conflict detection, network bandwidth reservation, database range lock coalescing. In distributed systems, merging overlapping time ranges is essential for log aggregation and time-series data compaction.

---

### Problem 6: Product of Array Except Self (Medium)

**Problem**: Given an integer array `nums`, return an array `answer` such that `answer[i]` is the product of all elements of `nums` except `nums[i]`, without using division.

```java
public int[] productExceptSelf(int[] nums) {
    int n = nums.length;
    int[] answer = new int[n];

    // Left pass: answer[i] = product of all elements to the left of i
    answer[0] = 1;
    for (int i = 1; i < n; i++) {
        answer[i] = answer[i - 1] * nums[i - 1];
    }

    // Right pass: multiply by product of all elements to the right of i
    int rightProduct = 1;
    for (int i = n - 1; i >= 0; i--) {
        answer[i] *= rightProduct;
        rightProduct *= nums[i];
    }

    return answer;
}
```

**Time**: O(n) — two passes.
**Space**: O(1) extra (output array is not counted).

**JVM insight**: This is essentially a prefix product and suffix product combined. Both passes traverse the array sequentially — the CPU prefetcher loads cache lines ahead of the access pattern. The reverse pass (decrementing `i`) is also prefetcher-friendly on modern CPUs that support backward prefetching. The multiplication `*` on `int` is a single-cycle instruction on x86 (`imul`). No autoboxing, no object allocation, no GC pressure — this runs at near-hardware speed.

**Real-world correlation**: Computing relative contribution percentages in analytics dashboards. When you need "total minus this element" for each element, the prefix/suffix decomposition avoids the O(n^2) approach of recomputing the total for each element.

---

### Problem 7: Next Permutation (Medium)

**Problem**: Given an array of integers `nums`, rearrange them into the lexicographically next greater permutation. If no such permutation exists (the array is in descending order), rearrange to the lowest possible order (ascending).

```java
public void nextPermutation(int[] nums) {
    int n = nums.length;
    int i = n - 2;

    // Step 1: Find the first decreasing element from the right
    while (i >= 0 && nums[i] >= nums[i + 1]) {
        i--;
    }

    if (i >= 0) {
        // Step 2: Find the smallest element larger than nums[i] to the right
        int j = n - 1;
        while (nums[j] <= nums[i]) {
            j--;
        }
        // Step 3: Swap nums[i] and nums[j]
        swap(nums, i, j);
    }

    // Step 4: Reverse the suffix after position i
    reverse(nums, i + 1, n - 1);
}

private void swap(int[] nums, int i, int j) {
    int temp = nums[i];
    nums[i] = nums[j];
    nums[j] = temp;
}

private void reverse(int[] nums, int left, int right) {
    while (left < right) {
        swap(nums, left++, right--);
    }
}
```

**Time**: O(n) — at most two passes.
**Space**: O(1) — in-place.

**JVM insight**: The `swap` method is a prime candidate for JIT inlining — it is small, called frequently, and operates on stack-local variables. After inlining, the JIT may keep `temp` in a CPU register instead of spilling to stack memory. The `reverse` method uses the converging two-pointer pattern — both pointers access the same `int[]`, and the JIT eliminates bounds checks because `left` and `right` are both bounded by array indices established earlier.

**Real-world correlation**: Generating test permutations in combinatorial testing. The algorithm is also the foundation of `std::next_permutation` in C++ and is used in constraint solvers that enumerate solutions in lexicographic order.

---

### Problem 8: Container With Most Water (Medium)

**Problem**: Given `n` non-negative integers `height[0..n-1]` representing vertical lines, find two lines that together with the x-axis form a container that holds the most water.

```java
public int maxArea(int[] height) {
    int left = 0, right = height.length - 1;
    int maxWater = 0;
    while (left < right) {
        int width = right - left;
        int h = Math.min(height[left], height[right]);
        maxWater = Math.max(maxWater, width * h);
        if (height[left] < height[right]) {
            left++;
        } else {
            right--;
        }
    }
    return maxWater;
}
```

**Time**: O(n) — two pointers, each moves at most n times.
**Space**: O(1).

**JVM insight**: The two-pointer pattern accesses `height[left]` and `height[right]` which are at opposite ends of the array. Initially, these are on different cache lines (64 bytes apart or more for arrays > 16 elements). As the pointers converge, they may end up on the same cache line — at that point, both accesses are L1 cache hits. `Math.min` and `Math.max` are both JIT intrinsics compiled to `cmov` (conditional move) — branchless, no pipeline stalls.

**Real-world correlation**: Resource allocation with two constraints. The greedy two-pointer approach appears in database query optimization (merge join), network flow problems, and any scenario where you need to maximize a function of two variables while one increases and the other decreases.

---

### Problem 9: Set Matrix Zeroes (Medium)

**Problem**: Given an `m x n` integer matrix, if an element is 0, set its entire row and column to 0. Do it in-place.

```java
public void setZeroes(int[][] matrix) {
    int m = matrix.length, n = matrix[0].length;
    boolean firstRowZero = false, firstColZero = false;

    // Check if first row or first column has any zeroes
    for (int j = 0; j < n; j++) {
        if (matrix[0][j] == 0) { firstRowZero = true; break; }
    }
    for (int i = 0; i < m; i++) {
        if (matrix[i][0] == 0) { firstColZero = true; break; }
    }

    // Use first row and first column as markers
    for (int i = 1; i < m; i++) {
        for (int j = 1; j < n; j++) {
            if (matrix[i][j] == 0) {
                matrix[i][0] = 0;
                matrix[0][j] = 0;
            }
        }
    }

    // Zero out cells based on markers
    for (int i = 1; i < m; i++) {
        for (int j = 1; j < n; j++) {
            if (matrix[i][0] == 0 || matrix[0][j] == 0) {
                matrix[i][j] = 0;
            }
        }
    }

    // Handle first row and column
    if (firstRowZero) {
        for (int j = 0; j < n; j++) matrix[0][j] = 0;
    }
    if (firstColZero) {
        for (int i = 0; i < m; i++) matrix[i][0] = 0;
    }
}
```

**Time**: O(m * n).
**Space**: O(1) — uses the matrix itself as storage for markers.

**JVM insight**: This is a jagged array (`int[][]`). Each `matrix[i]` is a separate `int[]` on the heap. The nested loop `for (i) for (j)` accesses rows sequentially (row-major order), which is cache-friendly within each row. The trick of using the first row/column as markers avoids allocating separate `boolean[]` arrays — saving both memory and GC overhead. For a 1000x1000 matrix, that is 8 KB of boolean arrays avoided (trivial), but more importantly, it avoids the pattern of checking external arrays that might be on different cache lines than the matrix data.

**Real-world correlation**: Sparse matrix operations. In graph adjacency matrices, zeroing out rows and columns corresponds to removing a vertex and all its edges — used in vertex elimination algorithms for solving linear systems.

---

### Problem 10: Rotate Array (Easy)

**Problem**: Given an integer array `nums`, rotate the array to the right by `k` steps.

```java
public void rotate(int[] nums, int k) {
    int n = nums.length;
    k = k % n;
    if (k == 0) return;

    // Three reverses: the elegance of the approach
    reverse(nums, 0, n - 1);       // reverse entire array
    reverse(nums, 0, k - 1);       // reverse first k elements
    reverse(nums, k, n - 1);       // reverse remaining elements
}

private void reverse(int[] nums, int left, int right) {
    while (left < right) {
        int temp = nums[left];
        nums[left] = nums[right];
        nums[right] = temp;
        left++;
        right--;
    }
}
```

**Time**: O(n) — each element is touched exactly twice.
**Space**: O(1) — in-place.

**JVM insight**: The triple-reverse technique is pure in-place manipulation of a contiguous `int[]`. An alternative approach uses `System.arraycopy()` with a temporary array, which is faster for large arrays (vectorized copy) but requires O(k) extra space. The reverse method's swap loop writes to both ends of a subarray simultaneously — this hits two cache lines per iteration, but since the working set is small (the swapped values), the L1 cache handles it. The `k = k % n` handles k > n, and the JIT optimizes the modulo on a power of 2 to a bitwise AND — though here `n` is typically not a power of 2, so a real division is used.

**Real-world correlation**: Log rotation, circular buffer management. The "rotate array" operation is mathematically equivalent to a circular shift, which is fundamental in cipher algorithms (bit rotation in AES/DES) and signal processing (circular convolution).

---

### Problem 11: Spiral Matrix (Medium)

**Problem**: Given an `m x n` matrix, return all elements in spiral order.

```java
public List<Integer> spiralOrder(int[][] matrix) {
    List<Integer> result = new ArrayList<>();
    if (matrix.length == 0) return result;

    int top = 0, bottom = matrix.length - 1;
    int left = 0, right = matrix[0].length - 1;

    while (top <= bottom && left <= right) {
        // Traverse right
        for (int j = left; j <= right; j++) {
            result.add(matrix[top][j]);
        }
        top++;

        // Traverse down
        for (int i = top; i <= bottom; i++) {
            result.add(matrix[i][right]);
        }
        right--;

        // Traverse left
        if (top <= bottom) {
            for (int j = right; j >= left; j--) {
                result.add(matrix[bottom][j]);
            }
            bottom--;
        }

        // Traverse up
        if (left <= right) {
            for (int i = bottom; i >= top; i--) {
                result.add(matrix[i][left]);
            }
            left++;
        }
    }
    return result;
}
```

**Time**: O(m * n) — visits each element once.
**Space**: O(1) extra (output list not counted).

**JVM insight**: Each `result.add(matrix[i][j])` autoboxes the `int` to `Integer`. For m*n elements, that is m*n `Integer` objects (16 bytes each) plus m*n references in the ArrayList's backing `Object[]`. For a 1000x1000 matrix: 1M `Integer` objects = 16 MB + 4 MB references = 20 MB. If you need to avoid this, return an `int[]` instead and populate it with direct index writes. The spiral traversal accesses the matrix in a pattern that is inherently cache-unfriendly — it alternates between row-major (left/right traversal) and column-major (up/down traversal) access patterns.

**Real-world correlation**: Image processing scan patterns. Spiral scanning is used in JPEG's zigzag coefficient ordering and in some memory-mapped I/O patterns where you process data in concentric rings (e.g., radar data processing).

---

### Problem 12: Rotate Image (Medium)

**Problem**: Rotate an `n x n` 2D matrix 90 degrees clockwise, in-place.

```java
public void rotate(int[][] matrix) {
    int n = matrix.length;

    // Step 1: Transpose the matrix (swap matrix[i][j] with matrix[j][i])
    for (int i = 0; i < n; i++) {
        for (int j = i + 1; j < n; j++) {
            int temp = matrix[i][j];
            matrix[i][j] = matrix[j][i];
            matrix[j][i] = temp;
        }
    }

    // Step 2: Reverse each row
    for (int i = 0; i < n; i++) {
        for (int left = 0, right = n - 1; left < right; left++, right--) {
            int temp = matrix[i][left];
            matrix[i][left] = matrix[i][right];
            matrix[i][right] = temp;
        }
    }
}
```

**Time**: O(n^2).
**Space**: O(1) — in-place.

**JVM insight**: The transpose step accesses `matrix[i][j]` and `matrix[j][i]` — these are elements in different row arrays (different `int[]` objects on the heap). Each swap dereferences two different arrays. For large matrices, this causes cache thrashing because the two row arrays may be on different cache lines. The row reversal step, by contrast, is perfectly cache-friendly — it accesses elements within a single `int[]` row. If performance is critical, the flat-array representation (`int[n*n]`) makes transpose much more cache-friendly because both `[i*n+j]` and `[j*n+i]` are in the same contiguous block.

**Real-world correlation**: Image rotation in graphics pipelines. GPU texture rotation uses the same transpose-then-reverse logic, but operates on pixel buffers in VRAM. In OLAP databases, matrix transposition is the core of the "pivot" operation.

---

### Problem 13: First Missing Positive (Hard)

**Problem**: Given an unsorted integer array `nums`, return the smallest missing positive integer. Must run in O(n) time and O(1) extra space.

```java
public int firstMissingPositive(int[] nums) {
    int n = nums.length;

    // Place each number in its "correct" position: nums[i] should hold i+1
    for (int i = 0; i < n; i++) {
        while (nums[i] > 0 && nums[i] <= n && nums[nums[i] - 1] != nums[i]) {
            // Swap nums[i] with nums[nums[i] - 1]
            int correctIdx = nums[i] - 1;
            int temp = nums[correctIdx];
            nums[correctIdx] = nums[i];
            nums[i] = temp;
        }
    }

    // Find the first position where nums[i] != i + 1
    for (int i = 0; i < n; i++) {
        if (nums[i] != i + 1) {
            return i + 1;
        }
    }

    return n + 1;
}
```

**Time**: O(n) — each element is swapped at most once to its correct position.
**Space**: O(1) — in-place.

**JVM insight**: This uses the array itself as a hash map — index `i` stores value `i+1`. The while loop performs swaps using `nums[nums[i] - 1]` as the target index, which is a computed array access. The JIT cannot eliminate the bounds check on `nums[nums[i] - 1]` through range check elimination because the index is data-dependent (comes from the array contents). However, the explicit check `nums[i] > 0 && nums[i] <= n` in the while condition ensures the access is always valid — the JIT may use this for speculative optimization but typically keeps the hardware bounds check.

**Real-world correlation**: Gap detection in sequence number tracking. In distributed systems, messages arrive out of order with sequence numbers. Finding the first missing sequence number tells you the earliest message you are still waiting for — this is the core of TCP's receive window management and Kafka's offset tracking.

---

### Problem 14: Trapping Rain Water (Hard)

**Problem**: Given `n` non-negative integers representing an elevation map where the width of each bar is 1, compute how much water it can trap after raining.

```java
public int trap(int[] height) {
    int left = 0, right = height.length - 1;
    int leftMax = 0, rightMax = 0;
    int water = 0;

    while (left < right) {
        if (height[left] < height[right]) {
            if (height[left] >= leftMax) {
                leftMax = height[left];
            } else {
                water += leftMax - height[left];
            }
            left++;
        } else {
            if (height[right] >= rightMax) {
                rightMax = height[right];
            } else {
                water += rightMax - height[right];
            }
            right--;
        }
    }

    return water;
}
```

**Time**: O(n) — two pointers, single pass.
**Space**: O(1).

**JVM insight**: The two-pointer approach is optimal because it avoids the O(n) space of the prefix-max/suffix-max approach. Each iteration accesses either `height[left]` or `height[right]` — both at the edges of the working range. As the pointers converge, the accessed memory becomes more and more cache-local. The arithmetic is all integer addition/subtraction on stack-local variables — the JIT keeps everything in registers. No branches are unpredictable: the `height[left] < height[right]` comparison is essentially random (depends on input data), causing ~50% branch misprediction. But at ~15 cycles per misprediction and millions of iterations per second, this is still negligible.

**Real-world correlation**: Capacity planning in reservoir systems. Also appears in stock analysis as the "water fill" metaphor for calculating cumulative deficit/surplus between supply and demand curves. In image processing, it is used for watershed segmentation.

---

### Problem 15: Jump Game (Medium)

**Problem**: Given an integer array `nums` where `nums[i]` is the maximum jump length from position `i`, determine if you can reach the last index starting from index 0.

```java
public boolean canJump(int[] nums) {
    int maxReach = 0;
    for (int i = 0; i < nums.length; i++) {
        if (i > maxReach) return false;  // cannot reach this position
        maxReach = Math.max(maxReach, i + nums[i]);
        if (maxReach >= nums.length - 1) return true;  // early exit
    }
    return true;
}
```

**Time**: O(n).
**Space**: O(1).

**JVM insight**: This is a greedy algorithm with the simplest possible loop body. The early exit (`maxReach >= nums.length - 1`) avoids unnecessary iterations when the answer is clear. The JIT compiles this to a tight loop with `Math.max` as a `cmov` instruction. The sequential `int[]` access pattern is perfect for hardware prefetching. For an array of 10^5 elements, this loop executes in ~50 microseconds — bottlenecked by instruction throughput, not memory latency.

**Real-world correlation**: Network hop reachability analysis. Can a packet reach its destination given the maximum hop distance at each router? Also used in game AI for determining whether a character can traverse a platforming level.

---

### Problem 16: Search in Rotated Sorted Array (Medium)

**Problem**: Given a sorted array that has been rotated at an unknown pivot, and a target value, find the index of the target or return -1. The array has no duplicates.

```java
public int search(int[] nums, int target) {
    int lo = 0, hi = nums.length - 1;
    while (lo <= hi) {
        int mid = (lo + hi) >>> 1;
        if (nums[mid] == target) return mid;

        if (nums[lo] <= nums[mid]) {
            // Left half is sorted
            if (target >= nums[lo] && target < nums[mid]) {
                hi = mid - 1;
            } else {
                lo = mid + 1;
            }
        } else {
            // Right half is sorted
            if (target > nums[mid] && target <= nums[hi]) {
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
    }
    return -1;
}
```

**Time**: O(log n).
**Space**: O(1).

**JVM insight**: Binary search on a contiguous `int[]` has near-perfect cache behavior for the first few iterations (the entire array fits in L2/L3 for typical interview sizes). For very large arrays, the initial accesses are cache misses (start, middle, quarter points), but the working set halves each iteration, quickly falling into cache. The `>>>` unsigned right shift prevents `(lo + hi)` integer overflow — this is the same fix used in `Arrays.binarySearch()`. The JIT eliminates bounds checks on `nums[mid]` because `mid` is bounded by `lo` and `hi`, which are bounded by `0` and `nums.length - 1`.

**Real-world correlation**: Searching in log-structured merge (LSM) trees where sorted runs may be "rotated" by key-range splits. Also relevant in time-series databases where data wraps around circular buffers.

---

### Problem 17: Find Peak Element (Medium)

**Problem**: Given an array `nums` where `nums[i] != nums[i+1]` for all valid `i`, find a peak element (strictly greater than its neighbors) and return its index. The array may contain multiple peaks; return any one.

```java
public int findPeakElement(int[] nums) {
    int lo = 0, hi = nums.length - 1;
    while (lo < hi) {
        int mid = (lo + hi) >>> 1;
        if (nums[mid] > nums[mid + 1]) {
            hi = mid;       // peak is at mid or to the left
        } else {
            lo = mid + 1;   // peak is to the right
        }
    }
    return lo;
}
```

**Time**: O(log n).
**Space**: O(1).

**JVM insight**: This binary search variant uses `lo < hi` (not `lo <= hi`) because we narrow the range to a single element. The comparison `nums[mid] > nums[mid + 1]` accesses two adjacent elements in the array — they are on the same cache line (or at most adjacent cache lines), so this is always a single cache-line fetch. The loop terminates when `lo == hi`, which is the peak index. The JIT can prove `mid + 1 <= hi` from the loop condition (`lo < hi` and `mid = (lo + hi) >>> 1` imply `mid < hi`), enabling bounds check elimination.

**Real-world correlation**: Finding local maxima in signal processing. In load testing, finding the peak throughput point where performance degrades. In binary search on a unimodal function (ternary search variant), this is the same logic.

---

### Problem 18: Median of Two Sorted Arrays (Hard)

**Problem**: Given two sorted arrays `nums1` and `nums2` of sizes `m` and `n`, return the median of the combined sorted array. Must run in O(log(min(m, n))) time.

```java
public double findMedianSortedArrays(int[] nums1, int[] nums2) {
    // Ensure nums1 is the shorter array
    if (nums1.length > nums2.length) {
        return findMedianSortedArrays(nums2, nums1);
    }

    int m = nums1.length, n = nums2.length;
    int lo = 0, hi = m;

    while (lo <= hi) {
        int i = (lo + hi) >>> 1;       // partition in nums1
        int j = (m + n + 1) / 2 - i;   // partition in nums2

        int maxLeft1 = (i == 0) ? Integer.MIN_VALUE : nums1[i - 1];
        int minRight1 = (i == m) ? Integer.MAX_VALUE : nums1[i];
        int maxLeft2 = (j == 0) ? Integer.MIN_VALUE : nums2[j - 1];
        int minRight2 = (j == n) ? Integer.MAX_VALUE : nums2[j];

        if (maxLeft1 <= minRight2 && maxLeft2 <= minRight1) {
            // Found the correct partition
            if ((m + n) % 2 == 0) {
                return (Math.max(maxLeft1, maxLeft2) + Math.min(minRight1, minRight2)) / 2.0;
            } else {
                return Math.max(maxLeft1, maxLeft2);
            }
        } else if (maxLeft1 > minRight2) {
            hi = i - 1;
        } else {
            lo = i + 1;
        }
    }

    throw new IllegalArgumentException("Input arrays are not sorted");
}
```

**Time**: O(log(min(m, n))).
**Space**: O(1).

**JVM insight**: The `Integer.MIN_VALUE` and `Integer.MAX_VALUE` sentinel values are compile-time constants that the JIT folds directly into comparison instructions — there is no "loading a constant from memory" overhead. The division `/ 2.0` promotes the int sum to double — this is a single `cvtsi2sd` instruction on x86 (convert signed int to scalar double). The recursive swap at the top (`if (nums1.length > nums2.length)`) is a tail-call pattern that the JIT may convert to a branch rather than an actual recursive call, though Java does not guarantee tail-call optimization.

**Real-world correlation**: Merging sorted result sets from multiple database shards. When each shard returns sorted results, finding the global median without merging all results is exactly this problem. It appears in distributed percentile calculations (P50, P99) across partitioned data.

---

### Problem 19: Reverse Words in a String (Medium)

**Problem**: Given a string `s`, reverse the order of words. Words are separated by spaces. Remove leading/trailing spaces and reduce multiple spaces to a single space.

```java
public String reverseWords(String s) {
    char[] chars = s.toCharArray();
    int n = chars.length;

    // Step 1: Reverse entire array
    reverse(chars, 0, n - 1);

    // Step 2: Reverse each word
    int start = 0;
    for (int end = 0; end <= n; end++) {
        if (end == n || chars[end] == ' ') {
            reverse(chars, start, end - 1);
            start = end + 1;
        }
    }

    // Step 3: Clean up spaces — compact in place
    int write = 0;
    for (int read = 0; read < n; read++) {
        if (chars[read] != ' ') {
            if (write > 0) chars[write++] = ' ';
            while (read < n && chars[read] != ' ') {
                chars[write++] = chars[read++];
            }
        }
    }

    return new String(chars, 0, write);
}

private void reverse(char[] chars, int left, int right) {
    while (left < right) {
        char temp = chars[left];
        chars[left++] = chars[right];
        chars[right--] = temp;
    }
}
```

**Time**: O(n).
**Space**: O(n) — for the `char[]` copy (Java strings are immutable, so we must work on a copy).

**JVM insight**: `s.toCharArray()` allocates a new `char[]` and copies the string's internal `byte[]` to it (expanding from Latin-1 to UTF-16 if needed). In JDK 9+, if the string is Latin-1, each byte is zero-extended to a `char` during the copy — this is a widening conversion that the JIT vectorizes. The `new String(chars, 0, write)` at the end re-encodes the characters back to the compact representation — if all characters are Latin-1, it compresses back to `byte[]`. This round-trip (decompress → process → recompress) is the hidden cost of character-level string manipulation in JDK 9+.

**Real-world correlation**: Log line reformatting. When you need to reverse the field order in a log line (e.g., moving timestamp from end to beginning), this in-place reversal technique avoids creating intermediate strings. In text editors, word-level operations use similar character-array manipulation.

---

### Problem 20: Valid Palindrome (Easy)

**Problem**: Given a string `s`, determine if it is a palindrome considering only alphanumeric characters and ignoring case.

```java
public boolean isPalindrome(String s) {
    int left = 0, right = s.length() - 1;
    while (left < right) {
        while (left < right && !Character.isLetterOrDigit(s.charAt(left))) {
            left++;
        }
        while (left < right && !Character.isLetterOrDigit(s.charAt(right))) {
            right--;
        }
        if (Character.toLowerCase(s.charAt(left)) != Character.toLowerCase(s.charAt(right))) {
            return false;
        }
        left++;
        right--;
    }
    return true;
}
```

**Time**: O(n).
**Space**: O(1).

**JVM insight**: `s.charAt(i)` on a JDK 9+ compact string checks the `coder` byte to decide whether to read 1 byte (Latin-1) or 2 bytes (UTF-16). For ASCII input, this is a single byte read + zero-extension. `Character.isLetterOrDigit()` and `Character.toLowerCase()` use lookup tables (character property tables in `Character` class). These tables are large (~65KB) but hot tables stay in L2 cache during string processing. The two-pointer approach avoids creating a filtered/normalized copy of the string — saving both memory and the GC cost of a temporary string.

**Real-world correlation**: Input validation and normalization. Checking palindromes is a specific case of the general pattern: validate input by scanning from both ends toward the middle, skipping irrelevant characters. URL normalization, bracket matching, and DNA sequence analysis (palindromic sequences in genetics) use the same two-pointer structure.

---

### Problem 21: Longest Palindromic Substring (Medium)

**Problem**: Given a string `s`, return the longest palindromic substring.

```java
public String longestPalindrome(String s) {
    if (s.length() < 2) return s;
    int start = 0, maxLen = 1;

    for (int i = 0; i < s.length(); i++) {
        // Expand around center — odd length palindromes
        int len1 = expandAroundCenter(s, i, i);
        // Expand around center — even length palindromes
        int len2 = expandAroundCenter(s, i, i + 1);
        int len = Math.max(len1, len2);
        if (len > maxLen) {
            maxLen = len;
            start = i - (len - 1) / 2;
        }
    }

    return s.substring(start, start + maxLen);
}

private int expandAroundCenter(String s, int left, int right) {
    while (left >= 0 && right < s.length() &&
           s.charAt(left) == s.charAt(right)) {
        left--;
        right++;
    }
    return right - left - 1;
}
```

**Time**: O(n^2) — O(n) centers, each expansion is O(n) worst case.
**Space**: O(1) — excluding the output string.

**JVM insight**: `s.substring(start, start + maxLen)` in JDK 7+ creates a new String object with a new backing `byte[]` — it does not share the original string's array (this changed from JDK 6 where substring shared the backing `char[]`, causing memory leaks when a small substring kept a large parent string alive). The `expandAroundCenter` method is called 2n times and is a hot method — the JIT will inline it aggressively. The `s.charAt()` calls within the expansion loop are sequential accesses (left goes backward, right goes forward), which is favorable for the CPU prefetcher.

**Real-world correlation**: DNA sequence analysis — finding palindromic sequences in genomic data is used to identify restriction enzyme sites and hairpin structures. In text analysis, detecting palindromes helps identify symmetry in encoded messages. Manacher's algorithm (O(n)) exists for this problem but is rarely expected in interviews.

---

### Problem 22: Group Anagrams (Medium)

**Problem**: Given an array of strings, group the anagrams together.

```java
public List<List<String>> groupAnagrams(String[] strs) {
    Map<String, List<String>> map = new HashMap<>();
    for (String s : strs) {
        char[] chars = s.toCharArray();
        Arrays.sort(chars);
        String key = new String(chars);
        map.computeIfAbsent(key, k -> new ArrayList<>()).add(s);
    }
    return new ArrayList<>(map.values());
}
```

**Time**: O(n * k log k) where n is the number of strings and k is the maximum string length.
**Space**: O(n * k) for the map.

**JVM insight**: For each string, we create a `char[]` (via `toCharArray()`), sort it (`Arrays.sort(char[])` uses dual-pivot quicksort — same as `int[]`, because `char` is a primitive), then create a new `String` from it. That is 2 object allocations per string (the `char[]` and the `String`). These are short-lived — they die after the HashMap lookup and are collected in the next minor GC. `computeIfAbsent` avoids the double-lookup of `containsKey` + `get` — it is a single hash computation and bucket traversal. The sorted-string key approach uses `String.hashCode()` (the polynomial hash we discussed in Section 2.14) for bucket selection.

An alternative O(n * k) approach uses character frequency as the key:

```java
// O(n * k) alternative — no sorting
int[] count = new int[26];
for (char c : s.toCharArray()) count[c - 'a']++;
String key = Arrays.toString(count);
```

This is asymptotically faster but creates a longer key string (up to 80+ characters for the `[0, 0, 1, ...]` format), and `Arrays.toString()` allocates a StringBuilder internally. In practice, sorting wins for short strings (k < 20) due to lower constant factors.

**Real-world correlation**: Deduplication in search engines — grouping pages with the same content in different word order. Also used in plagiarism detection (group documents with the same word frequency distribution) and in Scrabble/word-game solvers.

---

### Problem 23: Longest Substring Without Repeating Characters (Medium)

**Problem**: Given a string `s`, find the length of the longest substring without repeating characters.

```java
public int lengthOfLongestSubstring(String s) {
    int[] lastSeen = new int[128];  // ASCII characters
    Arrays.fill(lastSeen, -1);
    int maxLen = 0;
    int start = 0;

    for (int end = 0; end < s.length(); end++) {
        char c = s.charAt(end);
        if (lastSeen[c] >= start) {
            start = lastSeen[c] + 1;
        }
        lastSeen[c] = end;
        maxLen = Math.max(maxLen, end - start + 1);
    }

    return maxLen;
}
```

**Time**: O(n) — single pass.
**Space**: O(1) — fixed 128-element array (or 256 for extended ASCII).

**JVM insight**: The `int[128]` array is 16 (header) + 128 * 4 = 528 bytes — it fits entirely in a single L1 cache page (4 KB). All lookups into `lastSeen` are L1 cache hits after the first access. `Arrays.fill(lastSeen, -1)` is intrinsified by the JIT to a vectorized fill — on x86 with AVX2, it can fill 8 ints (32 bytes) per cycle, completing the 512-byte fill in ~16 cycles (~5 ns). Compare this to a `HashMap<Character, Integer>` approach: each entry costs ~48 bytes (Node + Character boxing), and a hash table of 128 entries would use ~6 KB scattered across the heap. The array approach is both faster (direct addressing vs. hash computation) and smaller.

**Real-world correlation**: Network session management — tracking the longest active connection without duplicate packet IDs. In database query optimization, finding the longest independent subquery chain. In text editors, calculating the undo buffer's distinct-operations window.

---

### Problem 24: Minimum Window Substring (Hard)

**Problem**: Given strings `s` and `t`, return the minimum window in `s` that contains all characters of `t`. If no such window exists, return `""`.

```java
public String minWindow(String s, String t) {
    if (s.length() < t.length()) return "";

    int[] need = new int[128];
    int[] have = new int[128];
    for (char c : t.toCharArray()) {
        need[c]++;
    }

    int required = 0;
    for (int n : need) {
        if (n > 0) required++;
    }

    int formed = 0;
    int minLen = Integer.MAX_VALUE;
    int minStart = 0;
    int left = 0;

    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        have[c]++;
        if (need[c] > 0 && have[c] == need[c]) {
            formed++;
        }

        while (formed == required) {
            int windowLen = right - left + 1;
            if (windowLen < minLen) {
                minLen = windowLen;
                minStart = left;
            }
            char leftChar = s.charAt(left);
            have[leftChar]--;
            if (need[leftChar] > 0 && have[leftChar] < need[leftChar]) {
                formed--;
            }
            left++;
        }
    }

    return minLen == Integer.MAX_VALUE ? "" : s.substring(minStart, minStart + minLen);
}
```

**Time**: O(|s| + |t|) — each character in `s` is visited at most twice (once by `right`, once by `left`).
**Space**: O(1) — two fixed arrays of size 128.

**JVM insight**: Two `int[128]` arrays = 1056 bytes total. Both fit in L1 cache with room to spare. The sliding window technique is a masterclass in cache efficiency — all data accessed in the inner loop is either in registers (loop variables) or in a small, hot array (need/have). The `s.charAt()` calls are sequential on the right pointer and near-sequential on the left pointer — both benefit from prefetching. The `s.substring()` at the end is O(minLen) in JDK 7+ — it allocates and copies. In JDK 6, it was O(1) but caused memory leaks.

**Real-world correlation**: Log pattern matching — finding the smallest time window containing all required events. In network security, identifying the minimum packet sequence containing all signatures of an attack pattern. In bioinformatics, finding the minimum genome region containing all target gene markers.

---

### Problem 25: String to Integer (atoi) (Medium)

**Problem**: Implement `atoi` which converts a string to a 32-bit signed integer. Handle leading whitespace, optional sign, overflow, and invalid characters.

```java
public int myAtoi(String s) {
    int i = 0, n = s.length();
    if (n == 0) return 0;

    // Skip leading whitespace
    while (i < n && s.charAt(i) == ' ') {
        i++;
    }
    if (i == n) return 0;

    // Handle sign
    int sign = 1;
    if (s.charAt(i) == '+' || s.charAt(i) == '-') {
        sign = s.charAt(i) == '-' ? -1 : 1;
        i++;
    }

    // Parse digits with overflow detection
    int result = 0;
    while (i < n && s.charAt(i) >= '0' && s.charAt(i) <= '9') {
        int digit = s.charAt(i) - '0';

        // Check for overflow BEFORE multiplying
        if (result > Integer.MAX_VALUE / 10 ||
            (result == Integer.MAX_VALUE / 10 && digit > Integer.MAX_VALUE % 10)) {
            return sign == 1 ? Integer.MAX_VALUE : Integer.MIN_VALUE;
        }

        result = result * 10 + digit;
        i++;
    }

    return result * sign;
}
```

**Time**: O(n).
**Space**: O(1).

**JVM insight**: The overflow check `result > Integer.MAX_VALUE / 10` uses integer division by a constant. The JIT optimizes `/ 10` to a multiply-and-shift sequence: `x / 10` becomes approximately `(x * 0xCCCCCCCD) >>> 35` — faster than a hardware `div` instruction (which takes 20-40 cycles on x86, vs 3 cycles for `imul` + shift). Similarly, `% 10` is optimized to `x - (x / 10) * 10` using the same multiplication trick. This is a general JIT optimization for division by constant.

**Real-world correlation**: This is exactly what `Integer.parseInt()` does internally, plus locale-aware number parsing in `NumberFormat`. The overflow-checking pattern is essential in any system that parses untrusted numeric input — HTTP headers, configuration files, protocol buffers. Without overflow checking, an attacker can cause integer wraparound leading to buffer under-allocation.

---

### Problem 26: Implement strStr — KMP (Medium)

**Problem**: Return the index of the first occurrence of `needle` in `haystack`, or -1 if not found. Implement using the KMP algorithm.

```java
public int strStr(String haystack, String needle) {
    if (needle.isEmpty()) return 0;
    int n = haystack.length(), m = needle.length();
    if (m > n) return -1;

    // Build failure function
    int[] fail = new int[m];
    int len = 0;
    int i = 1;
    while (i < m) {
        if (needle.charAt(i) == needle.charAt(len)) {
            len++;
            fail[i] = len;
            i++;
        } else {
            if (len != 0) {
                len = fail[len - 1];
            } else {
                fail[i] = 0;
                i++;
            }
        }
    }

    // Search
    i = 0;
    int j = 0;
    while (i < n) {
        if (haystack.charAt(i) == needle.charAt(j)) {
            i++;
            j++;
        }
        if (j == m) {
            return i - m;
        } else if (i < n && haystack.charAt(i) != needle.charAt(j)) {
            if (j != 0) {
                j = fail[j - 1];
            } else {
                i++;
            }
        }
    }
    return -1;
}
```

**Time**: O(n + m).
**Space**: O(m) for the failure function.

**JVM insight**: The `int[m]` failure function is allocated once and is small (typically < 1 KB for interview problems). It fits entirely in L1 cache. The search loop's access pattern is sequential on `haystack` (pointer `i` never goes backward) and jumps on `needle` (pointer `j` uses the failure function). Since `needle` is short, it stays in cache. The `charAt()` calls on both strings benefit from JDK 9+ compact strings — if both are Latin-1, each character access is a single byte read. JDK's actual `String.indexOf(String)` uses a different algorithm — a simplified brute-force for short patterns (< 8 chars) with SIMD vectorization in JDK 21+ for longer patterns.

**Real-world correlation**: Text editor search (Ctrl+F). Log analysis tools like grep. Intrusion detection systems matching network traffic against signature patterns. DNA sequence alignment's core loop is pattern matching.

---

### Problem 27: Encode and Decode Strings (Medium)

**Problem**: Design an algorithm to encode a list of strings into a single string, and decode it back. The strings may contain any character.

```java
public class Codec {
    // Encode: prefix each string with its length and a delimiter
    public String encode(List<String> strs) {
        StringBuilder sb = new StringBuilder();
        for (String s : strs) {
            sb.append(s.length()).append('#').append(s);
        }
        return sb.toString();
    }

    // Decode: read length, skip delimiter, extract substring
    public List<String> decode(String s) {
        List<String> result = new ArrayList<>();
        int i = 0;
        while (i < s.length()) {
            int hashIdx = s.indexOf('#', i);
            int len = Integer.parseInt(s.substring(i, hashIdx));
            String str = s.substring(hashIdx + 1, hashIdx + 1 + len);
            result.add(str);
            i = hashIdx + 1 + len;
        }
        return result;
    }
}
```

**Time**: O(n) for both encode and decode, where n is the total length of all strings.
**Space**: O(n).

**JVM insight**: The encode method uses `StringBuilder` — good practice in a loop. The `sb.append(s.length())` internally converts the int to a string and appends. In JDK 9+, this goes through the `StringConcatFactory` path if the JIT inlines aggressively. The decode method uses `s.substring()` and `Integer.parseInt()` — each `substring()` allocates a new String + byte[] (JDK 7+). For n strings, that is 2n object allocations for decoding. An optimization: use `s.charAt()` to parse the length digit-by-digit instead of `substring()` + `parseInt()`, avoiding intermediate String allocations.

**Real-world correlation**: Serialization protocols. This length-prefixed encoding is the basis of Protocol Buffers' string encoding, HTTP/2's HPACK header compression, and Redis's RESP protocol. The pattern "length + delimiter + data" is ubiquitous in binary protocols because it handles arbitrary content (including delimiters within the data).

---

### Problem 28: Zigzag Conversion (Medium)

**Problem**: Write a string in a zigzag pattern on `numRows` rows, then read it line by line. For example, `"PAYPALISHIRING"` with 3 rows becomes `"PAHNAPLSIIGYIR"`.

```java
public String convert(String s, int numRows) {
    if (numRows == 1 || numRows >= s.length()) return s;

    StringBuilder[] rows = new StringBuilder[numRows];
    for (int i = 0; i < numRows; i++) {
        rows[i] = new StringBuilder();
    }

    int currentRow = 0;
    boolean goingDown = false;

    for (char c : s.toCharArray()) {
        rows[currentRow].append(c);
        if (currentRow == 0 || currentRow == numRows - 1) {
            goingDown = !goingDown;
        }
        currentRow += goingDown ? 1 : -1;
    }

    StringBuilder result = rows[0];
    for (int i = 1; i < numRows; i++) {
        result.append(rows[i]);
    }
    return result.toString();
}
```

**Time**: O(n) where n = s.length().
**Space**: O(n).

**JVM insight**: We create `numRows` StringBuilder objects. Each starts with default capacity 16. For a string of length n distributed across `numRows` rows, each StringBuilder will hold approximately n/numRows characters. The initial capacity of 16 is often too small, causing 1-3 resizes. Pre-sizing with `new StringBuilder(n / numRows + 1)` eliminates resizes. The final concatenation `result.append(rows[i])` uses `System.arraycopy()` internally — each append copies the source StringBuilder's internal `byte[]` directly into the destination. The `s.toCharArray()` allocates an unnecessary copy if we use `s.charAt(i)` instead.

**Real-world correlation**: Data interleaving in communication protocols. Zigzag encoding is used in progressive image rendering (JPEG uses zigzag scan of DCT coefficients) and in error-correcting codes where data is interleaved across rows to spread burst errors.

---

### Problem 29: Longest Common Prefix (Easy)

**Problem**: Find the longest common prefix string amongst an array of strings. Return `""` if there is no common prefix.

```java
public String longestCommonPrefix(String[] strs) {
    if (strs == null || strs.length == 0) return "";
    String prefix = strs[0];

    for (int i = 1; i < strs.length; i++) {
        while (strs[i].indexOf(prefix) != 0) {
            prefix = prefix.substring(0, prefix.length() - 1);
            if (prefix.isEmpty()) return "";
        }
    }

    return prefix;
}
```

**Time**: O(S) where S is the sum of all characters in all strings.
**Space**: O(1) — excluding output.

**JVM insight**: `prefix.substring(0, len - 1)` creates a new String object each time (JDK 7+). For a prefix that shrinks by one character at a time, this creates O(m) intermediate String objects where m is the original prefix length. A more JVM-friendly approach uses a simple index:

```java
// Index-based approach — zero allocations until the final return
public String longestCommonPrefix(String[] strs) {
    if (strs == null || strs.length == 0) return "";
    int prefixLen = strs[0].length();
    for (int i = 1; i < strs.length; i++) {
        prefixLen = Math.min(prefixLen, strs[i].length());
        for (int j = 0; j < prefixLen; j++) {
            if (strs[0].charAt(j) != strs[i].charAt(j)) {
                prefixLen = j;
                break;
            }
        }
    }
    return strs[0].substring(0, prefixLen);  // single allocation
}
```

This creates exactly one String object (the final substring) vs potentially O(m * n) with the shrinking approach.

**Real-world correlation**: Autocomplete systems. The longest common prefix of all matching entries determines the portion that can be auto-filled. In routing tables, the longest prefix match determines which route applies to a given IP address — this is the core of IP routing.

---

### Problem 30: Subarray Sum Equals K (Medium)

**Problem**: Given an array of integers `nums` and an integer `k`, return the total number of contiguous subarrays whose sum equals `k`.

```java
public int subarraySum(int[] nums, int k) {
    Map<Integer, Integer> prefixSumCount = new HashMap<>();
    prefixSumCount.put(0, 1);  // empty prefix has sum 0
    int sum = 0, count = 0;

    for (int num : nums) {
        sum += num;
        // If (sum - k) was seen before, then subarrays ending here sum to k
        count += prefixSumCount.getOrDefault(sum - k, 0);
        prefixSumCount.merge(sum, 1, Integer::sum);
    }

    return count;
}
```

**Time**: O(n).
**Space**: O(n) for the prefix sum map.

**JVM insight**: This is the prefix sum technique from Section 2.7, combined with a HashMap. Every `sum` value is autoboxed to `Integer` for use as a HashMap key. The `Integer::sum` method reference in `merge()` is a stateless lambda — the LambdaMetafactory creates a singleton instance on first call, so there is no per-call allocation for the merge function. The `getOrDefault` method avoids the overhead of `containsKey` + `get` (double hash computation). For arrays with many distinct prefix sums, the HashMap grows to n entries = ~48n bytes of HashMap overhead. For arrays with few distinct prefix sums (many repeated sums), the map stays small.

**Real-world correlation**: Detecting time windows with specific cumulative behavior. In network monitoring, counting the number of intervals where total throughput equals a target value. In finance, counting trading periods where cumulative returns match a benchmark.

---

### Problem 31: Minimum Size Subarray Sum (Medium)

**Problem**: Given an array of positive integers `nums` and a positive integer `target`, return the minimal length of a contiguous subarray whose sum is greater than or equal to `target`. Return 0 if no such subarray exists.

```java
public int minSubArrayLen(int target, int[] nums) {
    int left = 0, sum = 0;
    int minLen = Integer.MAX_VALUE;

    for (int right = 0; right < nums.length; right++) {
        sum += nums[right];
        while (sum >= target) {
            minLen = Math.min(minLen, right - left + 1);
            sum -= nums[left];
            left++;
        }
    }

    return minLen == Integer.MAX_VALUE ? 0 : minLen;
}
```

**Time**: O(n) — each element is added and removed from the window at most once.
**Space**: O(1).

**JVM insight**: This is the sliding window pattern at its purest — no data structures, no allocations, just arithmetic on stack-local variables. The JIT compiles this to approximately 8 machine instructions per iteration of the outer loop (including the amortized inner loop work). With `int[]` sequential access, the CPU prefetcher keeps the data warm in L1 cache. For n = 10^6, this completes in approximately 2-3 milliseconds — bounded by memory bandwidth for the initial array read. The `Integer.MAX_VALUE` sentinel and the final ternary are both branch-free after JIT optimization (`cmov` for the min, `cmov` or constant propagation for the ternary).

**Real-world correlation**: Network buffer sizing — finding the minimum buffer window that handles a burst of traffic. In SLA monitoring, finding the smallest time window where cumulative latency exceeds a threshold. The sliding window is the core mechanism of TCP's congestion control.

---

### Problem 32: 3Sum (Medium)

**Problem**: Given an integer array `nums`, return all unique triplets `[nums[i], nums[j], nums[k]]` such that `i != j`, `i != k`, `j != k`, and `nums[i] + nums[j] + nums[k] == 0`.

```java
public List<List<Integer>> threeSum(int[] nums) {
    List<List<Integer>> result = new ArrayList<>();
    Arrays.sort(nums);  // dual-pivot quicksort: O(n log n)

    for (int i = 0; i < nums.length - 2; i++) {
        if (i > 0 && nums[i] == nums[i - 1]) continue;  // skip duplicate i
        if (nums[i] > 0) break;  // optimization: no triplet possible

        int left = i + 1, right = nums.length - 1;
        while (left < right) {
            int sum = nums[i] + nums[left] + nums[right];
            if (sum == 0) {
                result.add(Arrays.asList(nums[i], nums[left], nums[right]));
                while (left < right && nums[left] == nums[left + 1]) left++;
                while (left < right && nums[right] == nums[right - 1]) right--;
                left++;
                right--;
            } else if (sum < 0) {
                left++;
            } else {
                right--;
            }
        }
    }

    return result;
}
```

**Time**: O(n^2) — sorting O(n log n) + two-pointer for each element O(n^2).
**Space**: O(log n) for sort stack (output not counted).

**JVM insight**: `Arrays.asList(nums[i], nums[left], nums[right])` autoboxes three `int` values to `Integer`. For values in [-128, 127], `Integer.valueOf()` returns cached instances — no heap allocation. For values outside this range, 3 `Integer` objects are created per triplet. `Arrays.asList()` returns a fixed-size `List` backed by the varargs array — it is a single-object wrapper, not an `ArrayList`. The sort is in-place (`int[]` dual-pivot quicksort), so the only significant allocation is the output list. The `nums[i] > 0` break optimization is critical: once the smallest remaining element is positive, no three positive numbers can sum to zero. This prunes large portions of the search space.

**Real-world correlation**: Finding balanced portfolios where three asset positions net to zero (hedging). In chemistry, finding molecular combinations that balance a reaction equation. The sort-then-two-pointer pattern is the standard approach for any k-sum problem.

---

### Problem 33: Longest Consecutive Sequence (Medium)

**Problem**: Given an unsorted array of integers `nums`, return the length of the longest consecutive elements sequence. Must run in O(n) time.

```java
public int longestConsecutive(int[] nums) {
    Set<Integer> set = new HashSet<>();
    for (int num : nums) {
        set.add(num);
    }

    int longest = 0;
    for (int num : set) {
        // Only start counting from the beginning of a sequence
        if (!set.contains(num - 1)) {
            int current = num;
            int length = 1;
            while (set.contains(current + 1)) {
                current++;
                length++;
            }
            longest = Math.max(longest, length);
        }
    }

    return longest;
}
```

**Time**: O(n) — each element is visited at most twice (once in the for loop, once in a while chain).
**Space**: O(n) for the HashSet.

**JVM insight**: The `HashSet<Integer>` stores autoboxed integers. The key insight that makes this O(n) is the `!set.contains(num - 1)` guard — it ensures we only start counting from sequence beginnings, so the while loop's total work across all iterations is O(n). The `set.contains()` call computes `Integer.hashCode()` which for `Integer` is just the `int` value itself (identity function). This means integers that are consecutive have consecutive hash codes, leading to clustered bucket distribution in the HashSet. With the default load factor of 0.75, this causes some chain-length variation but remains O(1) amortized.

**Real-world correlation**: Gap detection in time-series data — finding the longest uninterrupted sequence of timestamps. In database indexing, identifying contiguous page ranges for sequential I/O. In distributed systems, finding the longest consecutive message sequence without drops.

---

### Problem 34: Sliding Window Maximum (Hard)

**Problem**: Given an array `nums` and a window size `k`, return the maximum element in each window as it slides from left to right.

```java
public int[] maxSlidingWindow(int[] nums, int k) {
    if (nums.length == 0 || k == 0) return new int[0];
    int n = nums.length;
    int[] result = new int[n - k + 1];
    Deque<Integer> deque = new ArrayDeque<>();  // stores indices

    for (int i = 0; i < n; i++) {
        // Remove indices outside the current window
        while (!deque.isEmpty() && deque.peekFirst() < i - k + 1) {
            deque.pollFirst();
        }

        // Remove indices of elements smaller than current (they can never be the max)
        while (!deque.isEmpty() && nums[deque.peekLast()] < nums[i]) {
            deque.pollLast();
        }

        deque.offerLast(i);

        // Record the maximum (front of deque) once we have a full window
        if (i >= k - 1) {
            result[i - k + 1] = nums[deque.peekFirst()];
        }
    }

    return result;
}
```

**Time**: O(n) — each element is added to and removed from the deque at most once.
**Space**: O(k) for the deque.

**JVM insight**: `ArrayDeque` is backed by a circular `Object[]` array. The indices stored are autoboxed `Integer` objects. For k <= 128, many indices hit the `Integer.valueOf()` cache, but for larger windows, each index creates a new `Integer`. A more JVM-efficient approach uses a raw `int[]` as a circular buffer:

```java
int[] deque = new int[k];
int head = 0, tail = 0;
```

This eliminates all autoboxing. `ArrayDeque` itself is a good choice though — its operations are O(1), and its backing array is contiguous in memory. The deque's maximum size is bounded by k, so the array never resizes if initialized with `new ArrayDeque<>(k)`.

**Real-world correlation**: Real-time analytics — maintaining the maximum/minimum over a rolling time window. Stock trading systems track the highest price in the last k minutes. Network monitoring tracks the peak bandwidth in a sliding window. Redis's `XRANGE` with `MAX` is essentially this operation over a stream.

---

### Problem 35: Move Zeroes (Easy)

**Problem**: Given an integer array `nums`, move all 0s to the end while maintaining the relative order of non-zero elements. Do it in-place.

```java
public void moveZeroes(int[] nums) {
    int writeIdx = 0;
    for (int readIdx = 0; readIdx < nums.length; readIdx++) {
        if (nums[readIdx] != 0) {
            nums[writeIdx++] = nums[readIdx];
        }
    }
    while (writeIdx < nums.length) {
        nums[writeIdx++] = 0;
    }
}
```

**Time**: O(n).
**Space**: O(1).

**JVM insight**: This is the classic partition/compaction pattern — a read pointer scans forward, a write pointer marks the destination. Both access the same `int[]` sequentially. The JIT eliminates the bounds check on `nums[readIdx]` (loop guard `readIdx < nums.length`) and on `nums[writeIdx]` (provable because `writeIdx <= readIdx < nums.length`). The second loop (filling zeroes) is a memory fill that the JIT may vectorize or replace with `Arrays.fill(nums, writeIdx, nums.length, 0)` if it recognizes the pattern. The operation is effectively a stable partition — non-zero elements maintain their relative order, just like partition in quicksort. This is the in-place analog of `List.removeAll(Collections.singleton(0))`.

**Real-world correlation**: Compaction in log-structured storage — moving live data to the front and marking freed space at the end. In memory allocators (like jemalloc), compaction moves live objects to reduce fragmentation. This is the same logic the GC's copying collector uses when it evacuates live objects from Eden to Survivor space.

---

### Problem 36: Missing Number (Easy)

**Problem**: Given an array `nums` containing `n` distinct numbers from the range `[0, n]`, return the one number that is missing.

```java
public int missingNumber(int[] nums) {
    int n = nums.length;
    int expectedSum = n * (n + 1) / 2;
    int actualSum = 0;
    for (int num : nums) {
        actualSum += num;
    }
    return expectedSum - actualSum;
}
```

**Time**: O(n).
**Space**: O(1).

**JVM insight**: The Gauss formula `n * (n + 1) / 2` computes in constant time using three machine instructions (multiply, add, shift-right-by-1). The sum loop is a simple reduction over `int[]` — after JIT compilation, it is approximately 3 instructions per iteration (load, add, loop control). For n up to ~46,340, the `expectedSum` fits in an `int` without overflow. For larger n, use `long`:

```java
long expectedSum = (long) n * (n + 1) / 2;
```

An alternative using XOR avoids any overflow concern:

```java
public int missingNumber(int[] nums) {
    int xor = nums.length;
    for (int i = 0; i < nums.length; i++) {
        xor ^= i ^ nums[i];
    }
    return xor;
}
```

The XOR approach exploits the identity `a ^ a = 0` — every number that appears in both `[0..n]` and `nums` cancels out, leaving only the missing number.

**Real-world correlation**: Data integrity checks in distributed systems. When replicating a set of records, XOR-based checksums detect missing records without transmitting the full dataset. RAID 5 uses XOR parity for exactly this purpose — one missing disk's data can be recovered by XOR-ing all the others.

---

### Problem 37: Single Number (Easy)

**Problem**: Given a non-empty array of integers `nums`, every element appears twice except for one. Find that single one.

```java
public int singleNumber(int[] nums) {
    int result = 0;
    for (int num : nums) {
        result ^= num;
    }
    return result;
}
```

**Time**: O(n).
**Space**: O(1).

**JVM insight**: The XOR loop is the simplest possible reduction — one `xor` instruction per iteration. The JIT may auto-vectorize this using SIMD: with AVX2, four `int` XOR operations can execute simultaneously per cycle (128-bit `vpxor`), giving a theoretical 4x speedup. Whether the JIT actually vectorizes depends on the loop structure and alignment. Even without vectorization, the loop processes one `int` per cycle on a modern out-of-order CPU — for n = 10^6, it completes in ~300 microseconds (memory bandwidth limited). This is a pure compute kernel with zero memory allocation, zero GC pressure, and zero branch misprediction.

**Real-world correlation**: Error detection in network protocols. XOR is the basis of simple parity checks. In database systems, XOR-based checksums quickly identify records that differ between two replicas (anti-entropy repair in Dynamo-style databases).

---

### Problem 38: Valid Anagram (Easy)

**Problem**: Given two strings `s` and `t`, determine if `t` is an anagram of `s`.

```java
public boolean isAnagram(String s, String t) {
    if (s.length() != t.length()) return false;

    int[] count = new int[26];
    for (int i = 0; i < s.length(); i++) {
        count[s.charAt(i) - 'a']++;
        count[t.charAt(i) - 'a']--;
    }

    for (int c : count) {
        if (c != 0) return false;
    }
    return true;
}
```

**Time**: O(n).
**Space**: O(1) — 26-element array.

**JVM insight**: The `int[26]` is 16 (header) + 26 * 4 = 120 bytes — fits in two cache lines. The single-pass approach (increment for `s`, decrement for `t` in the same loop) has better cache behavior than two separate passes because `s.charAt(i)` and `t.charAt(i)` access sequential positions in both strings simultaneously. The subtraction `s.charAt(i) - 'a'` is a single `sub` instruction that produces the array index directly — no hash computation needed. This is faster than a `HashMap<Character, Integer>` by an order of magnitude: no boxing, no hashing, no node allocation, no pointer chasing.

**Real-world correlation**: Cryptographic hash verification — checking if two messages have the same character distribution (frequency analysis in classical cryptography). In natural language processing, character frequency vectors are features for language detection and authorship attribution.

---

### Problem 39: Palindrome Number (Easy)

**Problem**: Given an integer `x`, return `true` if `x` is a palindrome. Do not convert to string.

```java
public boolean isPalindrome(int x) {
    if (x < 0 || (x % 10 == 0 && x != 0)) return false;

    int reversed = 0;
    while (x > reversed) {
        reversed = reversed * 10 + x % 10;
        x /= 10;
    }

    return x == reversed || x == reversed / 10;
}
```

**Time**: O(log10(x)) — number of digits.
**Space**: O(1).

**JVM insight**: We only reverse half the digits (loop until `x <= reversed`), which also prevents overflow — we never hold more than half the original digits in `reversed`. The `% 10` and `/ 10` operations are division by a constant — the JIT replaces them with the multiply-and-shift trick: `x / 10` becomes `(x * 0xCCCCCCCD) >>> 35` (approximately). This is 5-10x faster than a hardware `div` instruction. The `x == reversed / 10` handles odd-length numbers (middle digit does not need to match). The early exit for `x < 0` and `x % 10 == 0` (numbers ending in 0 cannot be palindromes, except 0 itself) prunes the search space.

**Real-world correlation**: Data validation without string conversion. In embedded systems with limited memory, avoiding string allocation for numeric checks is critical. The half-reversal technique generalizes to any comparison that needs to check symmetry of a sequence — it halves the work and prevents overflow simultaneously.

---

### Problem 40: Find All Duplicates in an Array (Medium)

**Problem**: Given an integer array `nums` of length `n` where all integers are in the range `[1, n]` and each appears once or twice, return all integers that appear twice. Must be O(n) time and O(1) extra space.

```java
public List<Integer> findDuplicates(int[] nums) {
    List<Integer> result = new ArrayList<>();
    for (int i = 0; i < nums.length; i++) {
        int idx = Math.abs(nums[i]) - 1;
        if (nums[idx] < 0) {
            result.add(idx + 1);
        } else {
            nums[idx] = -nums[idx];
        }
    }
    return result;
}
```

**Time**: O(n).
**Space**: O(1) extra (output list not counted).

**JVM insight**: This technique uses the sign bit of each element as a "visited" flag, turning the array into a bitmap-like structure with 1 bit of metadata per element. The constraint `nums[i] in [1, n]` ensures that `Math.abs(nums[i]) - 1` is always a valid index. `Math.abs()` is a JIT intrinsic that compiles to a branchless sequence on x86: `mov + neg + cmov` (three instructions). The array is modified in-place — no additional data structures. The trade-off is that the input is mutated, which is acceptable in many interview contexts but may not be in production (consider restoring the array after processing by taking absolute values of all elements).

**Real-world correlation**: In-place duplicate detection in fixed-range ID systems. When processing event logs where event IDs are sequential, this technique identifies retransmitted events without additional memory. Database deadlock detection uses a similar "mark visited" pattern when traversing wait-for graphs.

---

### Problem 41: Sort Colors (Dutch National Flag) (Medium)

**Problem**: Given an array with elements 0, 1, and 2, sort them in-place in a single pass.

```java
public void sortColors(int[] nums) {
    int lo = 0, mid = 0, hi = nums.length - 1;

    while (mid <= hi) {
        switch (nums[mid]) {
            case 0:
                swap(nums, lo++, mid++);
                break;
            case 1:
                mid++;
                break;
            case 2:
                swap(nums, mid, hi--);
                break;
        }
    }
}

private void swap(int[] nums, int i, int j) {
    int temp = nums[i];
    nums[i] = nums[j];
    nums[j] = temp;
}
```

**Time**: O(n) — single pass.
**Space**: O(1).

**JVM insight**: The switch statement on 3 values (0, 1, 2) compiles to a `tableswitch` bytecode instruction — a direct index lookup (O(1) dispatch), not a chain of if-else comparisons. The JIT compiles `tableswitch` with 3 entries to a computed jump: `jmp [base + nums[mid] * 8]`. Each case body is 2-3 instructions (swap + increment). The three-pointer technique processes each element exactly once. Note that when case 2 fires, `mid` is NOT incremented — the swapped element from the end needs to be examined. This is a common bug in implementations. The algorithm is also known as Dijkstra's Dutch National Flag problem and generalizes to k-way partitioning.

**Real-world correlation**: Three-way partitioning is the core of quicksort's handling of duplicate keys. In priority queue systems (high/medium/low), this partitions requests in a single pass. In network packet classification (drop/queue/forward), three-way decisions must be made at line rate.

---

### Problem 42: Maximum Product Subarray (Medium)

**Problem**: Given an integer array `nums`, find the contiguous subarray within the array that has the largest product, and return its product.

```java
public int maxProduct(int[] nums) {
    int maxSoFar = nums[0];
    int currentMax = nums[0];
    int currentMin = nums[0];

    for (int i = 1; i < nums.length; i++) {
        if (nums[i] < 0) {
            // Negative number flips max and min
            int temp = currentMax;
            currentMax = currentMin;
            currentMin = temp;
        }

        currentMax = Math.max(nums[i], currentMax * nums[i]);
        currentMin = Math.min(nums[i], currentMin * nums[i]);
        maxSoFar = Math.max(maxSoFar, currentMax);
    }

    return maxSoFar;
}
```

**Time**: O(n).
**Space**: O(1).

**JVM insight**: This is a variant of Kadane's algorithm that tracks both the running maximum and minimum products (because multiplying by a negative number flips the sign — a large negative minimum can become a large positive maximum). The swap of `currentMax` and `currentMin` when `nums[i] < 0` uses a temporary stack variable — the JIT keeps all three values (`maxSoFar`, `currentMax`, `currentMin`) in CPU registers throughout the loop. No memory access for loop variables after the initial load. Integer multiplication (`*`) on `int` is a single-cycle `imul` instruction. Watch for overflow: if the product exceeds `Integer.MAX_VALUE`, the result wraps around silently. For production code, use `long` or `Math.multiplyHigh()` (JDK 9+).

**Real-world correlation**: Risk analysis in financial models — the maximum cumulative return over a sequence of daily multipliers. In signal processing, finding the peak energy burst in a modulated signal. The key insight (tracking both max and min) applies to any problem where a "sign flip" can convert a bad state into a good one.

---

### Problem 43: Word Break (Medium)

**Problem**: Given a string `s` and a dictionary of strings `wordDict`, determine if `s` can be segmented into a space-separated sequence of dictionary words.

```java
public boolean wordBreak(String s, List<String> wordDict) {
    Set<String> dict = new HashSet<>(wordDict);
    int n = s.length();
    boolean[] dp = new boolean[n + 1];
    dp[0] = true;  // empty string is always achievable

    for (int i = 1; i <= n; i++) {
        for (int j = 0; j < i; j++) {
            if (dp[j] && dict.contains(s.substring(j, i))) {
                dp[i] = true;
                break;
            }
        }
    }

    return dp[n];
}
```

**Time**: O(n^2 * m) where n is the string length and m is the average substring length (for hashing).
**Space**: O(n) for the DP array + O(k) for the dictionary set.

**JVM insight**: `s.substring(j, i)` creates a new String object on every call — that is O(n^2) String allocations in the worst case, each requiring a `byte[]` copy. This generates significant garbage. An optimization: limit `j` to only check substring lengths that exist in the dictionary:

```java
int maxWordLen = wordDict.stream().mapToInt(String::length).max().orElse(0);
for (int j = Math.max(0, i - maxWordLen); j < i; j++) { ... }
```

This bounds the inner loop to `maxWordLen` iterations, reducing both substring allocations and total work. The `HashSet.contains(substring)` computes `String.hashCode()` — the polynomial hash from Section 2.14. For short substrings, the hash computation is fast. For long substrings, the hash is O(m) — but it is computed lazily and cached for reuse.

**Real-world correlation**: Natural language tokenization. Chinese/Japanese word segmentation is exactly this problem — given a sequence of characters and a dictionary, find a valid word segmentation. Search engines use word break algorithms for query interpretation. URL slug parsing (breaking `"thequickbrownfox"` into words) is the same problem.

---

### Problem 44: Majority Element (Easy)

**Problem**: Given an array `nums` of size `n`, return the majority element (appears more than `n/2` times). The majority element always exists.

```java
public int majorityElement(int[] nums) {
    int candidate = nums[0];
    int count = 1;

    for (int i = 1; i < nums.length; i++) {
        if (count == 0) {
            candidate = nums[i];
            count = 1;
        } else if (nums[i] == candidate) {
            count++;
        } else {
            count--;
        }
    }

    return candidate;
}
```

**Time**: O(n).
**Space**: O(1).

**JVM insight**: Boyer-Moore Voting Algorithm. The loop body is 3 comparisons and 1 increment/decrement — all on stack-local `int` variables. The JIT compiles this to ~6 machine instructions per iteration. There are no branches that are systematically mispredicted (the branch outcome depends on the data distribution, not a pattern the predictor can learn). Sequential `int[]` access ensures full cache-line utilization. This is perhaps the most elegant algorithm in computer science — it finds the majority element in a single pass with two variables, by observing that "pairing off" distinct elements always leaves the majority.

**Real-world correlation**: Leader election in distributed consensus. If you need to find which server has the majority of votes from n replicas, this algorithm works in a single pass over the vote stream without storing all votes. Also used in stream processing to find dominant values (heavy hitters) in real-time data feeds.

---

### Problem 45: Kth Largest Element (Medium)

**Problem**: Given an integer array `nums` and an integer `k`, return the `k`th largest element. It is the `k`th largest in sorted order, not the `k`th distinct element.

```java
public int findKthLargest(int[] nums, int k) {
    int targetIdx = nums.length - k;
    return quickSelect(nums, 0, nums.length - 1, targetIdx);
}

private int quickSelect(int[] nums, int lo, int hi, int targetIdx) {
    while (lo < hi) {
        int pivotIdx = partition(nums, lo, hi);
        if (pivotIdx == targetIdx) {
            return nums[pivotIdx];
        } else if (pivotIdx < targetIdx) {
            lo = pivotIdx + 1;
        } else {
            hi = pivotIdx - 1;
        }
    }
    return nums[lo];
}

private int partition(int[] nums, int lo, int hi) {
    // Median-of-three pivot selection to avoid worst case
    int mid = lo + (hi - lo) / 2;
    if (nums[mid] < nums[lo]) swap(nums, lo, mid);
    if (nums[hi] < nums[lo]) swap(nums, lo, hi);
    if (nums[mid] < nums[hi]) swap(nums, mid, hi);
    int pivot = nums[hi];

    int i = lo - 1;
    for (int j = lo; j < hi; j++) {
        if (nums[j] <= pivot) {
            i++;
            swap(nums, i, j);
        }
    }
    swap(nums, i + 1, hi);
    return i + 1;
}

private void swap(int[] nums, int i, int j) {
    int temp = nums[i];
    nums[i] = nums[j];
    nums[j] = temp;
}
```

**Time**: O(n) average, O(n^2) worst case. With median-of-three, worst case is extremely unlikely.
**Space**: O(1) — iterative quickselect.

**JVM insight**: Quickselect is an in-place selection algorithm — it partitions the array without allocating additional data structures. The iterative version (shown here) avoids recursion and its stack overhead. The median-of-three pivot selection reduces the probability of worst-case O(n^2) behavior from 1/n! to near zero for practical inputs. The partition loop is a single pass over contiguous `int[]` — ideal for cache performance. Compare with `PriorityQueue`-based approach (maintain a min-heap of size k): O(n log k) time, but O(k) extra space plus O(k) `Integer` autoboxing overhead. For large k, quickselect is faster; for small k relative to n, the heap approach can be competitive.

**Real-world correlation**: Percentile computation in monitoring systems. Finding P99 latency requires the 99th-percentile element — this is kth largest where k = n/100. Database query `ORDER BY x LIMIT k OFFSET m` uses selection algorithms internally. Quickselect is the foundation of `Arrays.sort()` for partial sorting.

---

### Problem 46: Longest Increasing Subsequence (Medium)

**Problem**: Given an integer array `nums`, return the length of the longest strictly increasing subsequence.

```java
public int lengthOfLIS(int[] nums) {
    // tails[i] = smallest tail element of all increasing subsequences of length i+1
    int[] tails = new int[nums.length];
    int size = 0;

    for (int num : nums) {
        // Binary search for the position to insert/replace
        int lo = 0, hi = size;
        while (lo < hi) {
            int mid = (lo + hi) >>> 1;
            if (tails[mid] < num) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        tails[lo] = num;
        if (lo == size) size++;
    }

    return size;
}
```

**Time**: O(n log n) — binary search for each element.
**Space**: O(n) for the tails array.

**JVM insight**: The `tails` array is always sorted and its effective length `size` grows monotonically. The binary search operates on a contiguous `int[]` subrange `[0, size)` — for typical interview sizes (n < 10^5), this fits entirely in L1 cache after the first few iterations. The `>>> 1` unsigned right shift for midpoint computation avoids the classic integer overflow bug. The algorithm maintains the invariant that `tails[i]` is the smallest possible tail for a subsequence of length `i+1` — this is a patience sorting variant. The JIT can prove `lo < tails.length` throughout the binary search (because `lo <= size <= nums.length = tails.length`) and eliminate bounds checks.

**Real-world correlation**: Version control — finding the longest chain of compatible dependency versions. In project scheduling, the longest increasing subsequence of task deadlines determines the critical path. In bioinformatics, LIS corresponds to finding the longest conserved gene order between two species.

---

### Problem 47: Minimum Path Sum (Medium)

**Problem**: Given an `m x n` grid filled with non-negative numbers, find a path from top-left to bottom-right that minimizes the sum. You can only move right or down.

```java
public int minPathSum(int[][] grid) {
    int m = grid.length, n = grid[0].length;

    // Modify grid in-place for O(1) extra space
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (i == 0 && j == 0) continue;
            else if (i == 0) grid[i][j] += grid[i][j - 1];
            else if (j == 0) grid[i][j] += grid[i - 1][j];
            else grid[i][j] += Math.min(grid[i - 1][j], grid[i][j - 1]);
        }
    }

    return grid[m - 1][n - 1];
}
```

**Time**: O(m * n).
**Space**: O(1) — modifies input grid in-place.

**JVM insight**: The nested loop accesses `grid[i][j]`, `grid[i][j-1]` (same row), and `grid[i-1][j]` (previous row). Same-row access is cache-friendly (contiguous `int[]`). Previous-row access (`grid[i-1][j]`) loads from a different `int[]` object — but since we process rows top-to-bottom, the previous row was just accessed in the prior iteration and is likely still in L2 cache. The in-place modification avoids allocating a separate DP table. If mutating the input is unacceptable, use a single `int[n]` rolling array:

```java
int[] dp = new int[n];
// Process row by row, overwriting dp[j] with min path to (i, j)
```

This reduces space from O(m * n) to O(n) — a standard DP space optimization.

**Real-world correlation**: Network routing — finding the minimum-cost path through a weighted grid (hop-by-hop routing). In image processing, seam carving uses a similar DP to find the minimum-energy vertical or horizontal seam for content-aware image resizing. In warehouse robotics, minimum path sum determines the optimal picking route.

---

### Problem 48: Decode Ways (Medium)

**Problem**: Given a string `s` containing only digits, return the number of ways to decode it, where `'1' → 'A'`, `'2' → 'B'`, ..., `'26' → 'Z'`.

```java
public int numDecodings(String s) {
    if (s.charAt(0) == '0') return 0;
    int n = s.length();
    int prev2 = 1;  // dp[i-2]
    int prev1 = 1;  // dp[i-1]

    for (int i = 1; i < n; i++) {
        int current = 0;
        int oneDigit = s.charAt(i) - '0';
        int twoDigit = (s.charAt(i - 1) - '0') * 10 + oneDigit;

        if (oneDigit >= 1) {
            current += prev1;
        }
        if (twoDigit >= 10 && twoDigit <= 26) {
            current += prev2;
        }

        prev2 = prev1;
        prev1 = current;
    }

    return prev1;
}
```

**Time**: O(n).
**Space**: O(1) — two rolling variables instead of an array.

**JVM insight**: The rolling-variable optimization (`prev1`, `prev2`) replaces a `dp[n]` array, saving n*4 bytes and the array header. For a 1000-character string, that is 4 KB saved — which is one L1 cache page. The character-to-digit conversion `s.charAt(i) - '0'` is a single `sub` instruction. The two-digit parsing `(s.charAt(i-1) - '0') * 10 + oneDigit` uses a multiply by constant 10, which the JIT optimizes to `lea eax, [rax + rax*4]` followed by `add eax, eax` (or `imul` on modern cores where multiply is fast). The entire loop body is ~10 instructions with zero memory allocation. This is a textbook example of DP space optimization — Fibonacci-style recurrence needs only the last two values.

**Real-world correlation**: Parsing ambiguous encodings — this exact problem appears in barcode decoding (a sequence of bars can represent different digit combinations). In natural language processing, decoding variable-length character encodings (like UTF-8) involves the same kind of prefix-dependent branching. In telecommunications, signal decoding from a continuous bit stream faces the same ambiguity.

---

### Problem 49: Multiply Strings (Medium)

**Problem**: Given two non-negative integers represented as strings, return their product as a string. Do not use BigInteger or convert directly to integer.

```java
public String multiply(String num1, String num2) {
    int m = num1.length(), n = num2.length();
    int[] result = new int[m + n];

    // Multiply digit by digit
    for (int i = m - 1; i >= 0; i--) {
        for (int j = n - 1; j >= 0; j--) {
            int mul = (num1.charAt(i) - '0') * (num2.charAt(j) - '0');
            int p1 = i + j;      // tens position
            int p2 = i + j + 1;  // ones position
            int sum = mul + result[p2];

            result[p2] = sum % 10;
            result[p1] += sum / 10;
        }
    }

    StringBuilder sb = new StringBuilder();
    for (int digit : result) {
        if (sb.length() == 0 && digit == 0) continue;  // skip leading zeros
        sb.append(digit);
    }

    return sb.length() == 0 ? "0" : sb.toString();
}
```

**Time**: O(m * n).
**Space**: O(m + n) for the result array.

**JVM insight**: The `int[m + n]` result array stores intermediate digit sums. Each element can temporarily exceed 9 (partial products accumulate before carry propagation), but the final propagation ensures single digits. The `% 10` and `/ 10` on small integers (< 81 + carry) are optimized by the JIT to the multiply-and-shift trick. The `StringBuilder.append(digit)` for single-digit values (0-9) is efficient — it writes one byte (Latin-1 encoding) and the internal buffer rarely needs resizing. The entire algorithm mimics grade-school long multiplication, which is O(m * n). For extremely large numbers (thousands of digits), Karatsuba multiplication (O(n^1.585)) or FFT-based multiplication (O(n log n)) would be faster — but O(m * n) is standard for interview contexts.

**Real-world correlation**: Arbitrary-precision arithmetic in cryptographic systems. RSA key generation requires multiplying 1024+ bit numbers. `BigInteger.multiply()` in the JDK uses Karatsuba above a threshold (~80 digits) and Toom-Cook above ~240 digits. Payment processing systems that cannot tolerate floating-point rounding use exact decimal multiplication — the same digit-by-digit approach.

---

### Problem 50: Text Justification (Hard)

**Problem**: Given an array of words and a maxWidth, format the text such that each line has exactly maxWidth characters and is fully (left and right) justified. The last line is left-justified.

```java
public List<String> fullJustify(String[] words, int maxWidth) {
    List<String> result = new ArrayList<>();
    int i = 0;

    while (i < words.length) {
        // Determine how many words fit on this line
        int lineLen = words[i].length();
        int j = i + 1;
        while (j < words.length && lineLen + 1 + words[j].length() <= maxWidth) {
            lineLen += 1 + words[j].length();
            j++;
        }

        int numWords = j - i;
        int totalSpaces = maxWidth - (lineLen - (numWords - 1)); // total chars minus word chars
        // Correction: recalculate character count properly
        int charCount = 0;
        for (int k = i; k < j; k++) charCount += words[k].length();
        totalSpaces = maxWidth - charCount;

        StringBuilder sb = new StringBuilder();

        if (numWords == 1 || j == words.length) {
            // Single word or last line: left justify
            for (int k = i; k < j; k++) {
                if (k > i) sb.append(' ');
                sb.append(words[k]);
            }
            // Pad with spaces on the right
            while (sb.length() < maxWidth) sb.append(' ');
        } else {
            // Multiple words, not last line: distribute spaces
            int gaps = numWords - 1;
            int spacesPerGap = totalSpaces / gaps;
            int extraSpaces = totalSpaces % gaps;

            for (int k = i; k < j; k++) {
                sb.append(words[k]);
                if (k < j - 1) {
                    int spaces = spacesPerGap + (k - i < extraSpaces ? 1 : 0);
                    for (int s = 0; s < spaces; s++) sb.append(' ');
                }
            }
        }

        result.add(sb.toString());
        i = j;
    }

    return result;
}
```

**Time**: O(n) where n is the total number of characters across all words.
**Space**: O(maxWidth) per line for the StringBuilder.

**JVM insight**: Each line constructs a `StringBuilder` and calls `toString()`. In JDK 9+, the `StringBuilder.toString()` checks if the internal encoding is Latin-1 (which it always is here, since we only append ASCII characters). If so, it shares the internal `byte[]` directly with the new String via a trusted constructor — no copy. This is a JDK optimization called "StringBuilder sharing" (it sets a flag to mark the buffer as shared, so subsequent appends to the StringBuilder allocate a new buffer). The space distribution `totalSpaces / gaps` and `totalSpaces % gaps` are division-by-variable, which the JIT cannot optimize to multiply-and-shift (unlike division by constant). These are actual `idiv` instructions — but they execute only once per line, so the cost is negligible.

**Real-world correlation**: Document rendering in word processors (Microsoft Word, Google Docs). PDF generation libraries justify text using this exact algorithm. Monospace terminal output formatting. The algorithm is also relevant in typesetting systems like TeX (Knuth's work), though TeX uses a more sophisticated approach based on dynamic programming over paragraph break points.

---

### Problem P51 (Bonus): Implement a Simple String Builder from Scratch (Hard)

**Problem**: Implement a minimal `StringBuilder` that supports `append(String)`, `append(char)`, `toString()`, and grows dynamically. Demonstrate the growth strategy.

```java
public class SimpleStringBuilder {
    private byte[] buffer;
    private int count;

    public SimpleStringBuilder() {
        this(16);  // default capacity, same as JDK
    }

    public SimpleStringBuilder(int capacity) {
        buffer = new byte[capacity];
        count = 0;
    }

    public SimpleStringBuilder append(char c) {
        ensureCapacity(count + 1);
        buffer[count++] = (byte) c;  // assumes Latin-1
        return this;
    }

    public SimpleStringBuilder append(String s) {
        int len = s.length();
        ensureCapacity(count + len);
        for (int i = 0; i < len; i++) {
            buffer[count + i] = (byte) s.charAt(i);  // assumes Latin-1
        }
        count += len;
        return this;
    }

    private void ensureCapacity(int minCapacity) {
        if (minCapacity > buffer.length) {
            int newCapacity = buffer.length * 2 + 2;  // same as JDK: double + 2
            if (newCapacity < minCapacity) {
                newCapacity = minCapacity;
            }
            byte[] newBuffer = new byte[newCapacity];
            System.arraycopy(buffer, 0, newBuffer, 0, count);
            buffer = newBuffer;
        }
    }

    @Override
    public String toString() {
        return new String(buffer, 0, count);
    }

    public int length() {
        return count;
    }

    public int capacity() {
        return buffer.length;
    }
}
```

**Time**: O(1) amortized for `append`, O(n) for `toString`.
**Space**: O(n) where n is the total appended length.

**JVM insight**: This mimics `AbstractStringBuilder` from the JDK. The growth strategy `capacity * 2 + 2` ensures geometric growth, giving O(1) amortized append. The `System.arraycopy()` in `ensureCapacity` is the intrinsic we discussed in Section 2.3 — it compiles to `rep movsq` for large copies. The `new String(buffer, 0, count)` constructor in JDK 9+ detects that the input is already Latin-1 and copies the bytes directly — no encoding conversion. In production, the JDK's `StringBuilder` handles both Latin-1 and UTF-16 via the `coder` field, which adds a branch on every `append`. Our simplified version assumes Latin-1 only, which is valid for ASCII-only workloads like log formatting, SQL building, and JSON construction.

**Real-world correlation**: This is the exact data structure used inside every logging framework (Log4j, SLF4J), every JSON serializer (Jackson, Gson), every template engine (Freemarker, Thymeleaf), and every SQL builder (JOOQ, Hibernate). Understanding its internals lets you pre-size appropriately (avoiding resizes) and choose between `StringBuilder` and direct `byte[]` manipulation for extreme throughput requirements.

---

### Problem P52 (Bonus): Rabin-Karp Multi-Pattern Search (Hard)

**Problem**: Given a text and multiple patterns, find all occurrences of any pattern in the text. Use Rabin-Karp with a hash set for pattern hashes.

```java
public class MultiPatternSearch {
    public List<int[]> search(String text, String[] patterns) {
        List<int[]> results = new ArrayList<>();
        if (patterns.length == 0) return results;

        // Group patterns by length
        Map<Integer, Set<Long>> hashByLength = new HashMap<>();
        Map<Integer, List<String>> patternsByLength = new HashMap<>();
        long d = 256, q = 1_000_000_007L;

        for (int idx = 0; idx < patterns.length; idx++) {
            int len = patterns[idx].length();
            long hash = 0;
            for (int i = 0; i < len; i++) {
                hash = (hash * d + patterns[idx].charAt(i)) % q;
            }
            hashByLength.computeIfAbsent(len, k -> new HashSet<>()).add(hash);
            patternsByLength.computeIfAbsent(len, k -> new ArrayList<>()).add(patterns[idx]);
        }

        int n = text.length();
        for (Map.Entry<Integer, Set<Long>> entry : hashByLength.entrySet()) {
            int m = entry.getKey();
            Set<Long> targetHashes = entry.getValue();
            List<String> targetPatterns = patternsByLength.get(m);
            if (m > n) continue;

            long h = 1;
            for (int i = 0; i < m - 1; i++) h = (h * d) % q;

            long textHash = 0;
            for (int i = 0; i < m; i++) {
                textHash = (textHash * d + text.charAt(i)) % q;
            }

            for (int i = 0; i <= n - m; i++) {
                if (targetHashes.contains(textHash)) {
                    // Verify — hash collision possible
                    String window = text.substring(i, i + m);
                    for (int p = 0; p < targetPatterns.size(); p++) {
                        if (window.equals(targetPatterns.get(p))) {
                            results.add(new int[]{i, p});
                        }
                    }
                }
                if (i < n - m) {
                    textHash = (d * (textHash - text.charAt(i) * h) + text.charAt(i + m)) % q;
                    if (textHash < 0) textHash += q;
                }
            }
        }

        return results;
    }
}
```

**Time**: O(n * L + P * m) where L is the number of distinct pattern lengths, n is the text length, P is the number of patterns, and m is the average pattern length.
**Space**: O(P) for the hash sets.

**JVM insight**: Grouping patterns by length is essential — each length requires a separate rolling-hash pass over the text. The `Set<Long>` stores hashes as `Long` objects (autoboxed from `long`). Since hash values are typically > 127, each is a heap-allocated `Long` object (24 bytes: 16 header + 8 long). For thousands of patterns, this is significant. An alternative: use a `long[]` sorted array with binary search — eliminates boxing entirely. The rolling hash computation uses `long` arithmetic to avoid `int` overflow during intermediate products. The modular arithmetic (`% q`) prevents overflow while maintaining hash distribution.

**Real-world correlation**: Intrusion detection systems (Snort, Suricata) that match network traffic against thousands of malware signatures simultaneously. Anti-virus scanners that check file contents against millions of known-bad byte patterns. In bioinformatics, searching a genome for multiple gene markers at once. Aho-Corasick (a trie-based approach) is the production standard for this problem at massive scale, but Rabin-Karp's simplicity makes it ideal for moderate pattern counts.

---

## Key Takeaways

1. **Arrays are the JVM's most cache-friendly data structure.** Elements are contiguous in memory starting at offset 16 (header). Sequential access fills cache lines automatically. This is why every high-performance JDK collection (`ArrayList`, `HashMap`, `PriorityQueue`) is backed by an array, not a linked structure.

2. **Bounds checking is free in practice.** The JIT's range check elimination removes bounds checks from standard loop patterns. The safety of Java arrays (no buffer overflows) comes at zero runtime cost for idiomatic code. Only computed indices from untrusted input retain the check — and you want that check.

3. **`System.arraycopy()` is a hardware-level memory copy.** It compiles to `rep movsq` or AVX vector instructions — 5-7x faster than a manual loop for large arrays. Every time you see `ArrayList.add()`, `StringBuilder.append()`, or `Arrays.copyOf()`, this intrinsic is doing the heavy lifting.

4. **Multi-dimensional arrays in Java are jagged by default.** Each `int[][]` row is a separate heap object. For matrix algorithms, consider flat `int[m * n]` representation — one contiguous block, one header, zero pointer chasing, perfect cache locality.

5. **JDK 9+ compact strings halve memory for ASCII text.** The `byte[] + coder` representation stores Latin-1 strings at 1 byte per character instead of 2. Most real-world strings (JSON keys, URLs, SQL, log messages) are ASCII — the savings are dramatic at scale.

6. **String immutability is a security boundary, not just a design choice.** The `final byte[] value` field, combined with defensive copying in constructors and the absence of mutating methods, protects the classloader, network connections, HashMap keys, and the string pool from corruption.

7. **String concatenation evolved from synchronized `StringBuffer` to `invokedynamic`.** JDK 9+ concatenation allocates the exact-sized `byte[]` directly — no StringBuilder, no resizing. But loop concatenation is still O(n^2) — always use `StringBuilder` in loops.

8. **KMP, Rabin-Karp, and Z-algorithm all achieve O(n + m) string matching, but serve different use cases.** KMP for single-pattern with no false positives. Rabin-Karp for multi-pattern search and 2D matching. Z-algorithm for simpler implementation with the same guarantees. In practice, the JDK's `String.indexOf()` uses a vectorized brute-force that outperforms all three for short patterns thanks to SIMD instructions.

9. **`String.hashCode()` uses 31 as the multiplier because it is an odd prime that the JIT optimizes to a shift-and-subtract.** The formula `s[0]*31^(n-1) + ... + s[n-1]` is cached after first computation. Be aware that collisions are easy to construct — this is why `HashMap` tree-ifies long chains since JDK 8.

10. **Array-based techniques (prefix sums, difference arrays, two pointers) exploit contiguity to solve O(n^2) problems in O(n).** These techniques are not just algorithmic tricks — they are cache-optimal because they scan arrays sequentially. A prefix sum pass over `int[n]` runs at memory bandwidth (~20 GB/s on modern hardware), processing 5 billion integers per second.

---

[← Chapter 1: JVM Memory Model Foundations](01-jvm-memory-model-foundations.md) | [Chapter 3: Linked Lists & Pointer Mechanics →](03-linked-lists-and-pointer-mechanics.md)
