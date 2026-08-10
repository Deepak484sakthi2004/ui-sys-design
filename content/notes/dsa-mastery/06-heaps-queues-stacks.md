# Chapter 6: Heaps, Queues, & Stacks

## The Three Workhorses of Every System You Have Ever Built

You have used all three of these structures today without thinking about them. The OS scheduled your process using a heap. The JVM managed your method calls with a stack. Your web server queued incoming requests through a circular buffer. Every network packet you sent passed through a ring buffer in the kernel. Every event loop you have ever relied on is, at its core, a queue.

This chapter takes you inside the JVM implementations of these structures: the array-backed binary heap that powers `PriorityQueue`, the circular buffer that powers `ArrayDeque`, and the legacy `Stack` class you should never use. We will walk through the OpenJDK source line by line, understand why `ArrayDeque` destroys `LinkedList` at the cache-line level, prove mathematically why `heapify()` is O(n) and not O(n log n), and then solve 45 problems that cover every interview pattern these structures produce.

If you have built production systems for 15 years, you already know the real-world side. This chapter connects it to the algorithmic interview side — and shows you they are the same thing.

---

## 6.1 Binary Heap — The Engine Inside PriorityQueue

### The Heap Property

A binary heap is a complete binary tree that satisfies the heap property:

- **Min-heap**: Every parent node is less than or equal to its children. The minimum element is always at the root.
- **Max-heap**: Every parent node is greater than or equal to its children. The maximum element is always at the root.

```
Min-Heap:                    Max-Heap:
        1                           9
       / \                         / \
      3   2                       7   8
     / \ / \                     / \ / \
    7  6 5  4                   3  6 5  4
```

The key insight: the heap does NOT maintain full sorted order. It only guarantees the root is the extremum. The left child can be larger than the right child. This partial ordering is what makes heap operations O(log n) instead of O(n log n) — we do less work precisely because we maintain less structure.

### Array Representation — Why It Works

A binary heap is always a complete binary tree: every level is fully filled except possibly the last, which is filled left to right. This completeness property means there are no gaps in a level-order traversal. And that means we can map the tree directly to a contiguous array with no wasted space:

```
Array index:    0   1   2   3   4   5   6
Element:       [1] [3] [2] [7] [6] [5] [4]

Tree layout:
Level 0:              arr[0] = 1
                      /         \
Level 1:        arr[1] = 3     arr[2] = 2
                /       \       /       \
Level 2:  arr[3]=7  arr[4]=6  arr[5]=5  arr[6]=4
```

The navigation formulas for 0-based indexing:

```
parent(i)     = (i - 1) / 2       // integer division
leftChild(i)  = 2 * i + 1
rightChild(i) = 2 * i + 2
```

Why these formulas work: in a complete binary tree laid out by level order, level `k` contains indices `[2^k - 1, 2^(k+1) - 2]`. If a node is at index `i`, its children occupy the next level at positions `2i+1` and `2i+2`. You can verify: node at index 1 has children at indices 3 and 4. Node at index 2 has children at indices 5 and 6. The arithmetic is exact — no wasted slots.

**Why this matters for performance**: No pointers. No node objects. No cache misses chasing references across the heap. A binary heap in an array is one of the most cache-friendly tree structures possible. Parent-child traversal is just integer arithmetic. Compare this to a `TreeMap` (Red-Black tree) where every node is a separate heap-allocated object with left/right/parent pointers — each dereference is a potential cache miss.

### OpenJDK PriorityQueue Source Walkthrough

Let us open up `java.util.PriorityQueue` from OpenJDK 21 and trace through the core fields and operations.

```java
// OpenJDK 21: java/util/PriorityQueue.java (simplified, key fields)

public class PriorityQueue<E> extends AbstractQueue<E>
    implements java.io.Serializable {

    private static final int DEFAULT_INITIAL_CAPACITY = 11;

    /**
     * Priority queue represented as a balanced binary heap: the two
     * children of queue[n] are queue[2*n+1] and queue[2*n+2]. The
     * priority queue is ordered by comparator, or by the elements'
     * natural ordering, if comparator is null: For each node n in the
     * heap and each descendant d of n, n <= d.
     */
    transient Object[] queue;  // the backing array — NOT generic E[]

    int size;                  // number of elements currently in the queue

    private final Comparator<? super E> comparator;  // null = natural ordering

    transient int modCount;    // for fail-fast iteration
}
```

Note `Object[] queue` — not `E[]`. This is the same erasure pattern we saw in `ArrayList`. Generic type information is erased at compile time; the JVM stores and retrieves `Object` references. The cast to `E` happens in the accessor methods.

**Memory layout** (64-bit JVM, compressed OOPs, default capacity 11):
```
PriorityQueue object header:     16 bytes  (mark word + klass + padding)
queue (reference to Object[]):    4 bytes
size (int):                       4 bytes
comparator (reference):           4 bytes
modCount (int):                   4 bytes
                                 --------
PriorityQueue shell:             32 bytes

Object[] with capacity 11:
  Array header:                  16 bytes  (mark word + klass + length)
  11 references × 4 bytes:      44 bytes
  Padding to 8-byte boundary:    4 bytes
                                 --------
  Array total:                   64 bytes

Empty PriorityQueue total:       96 bytes
```

### offer(E) — Adding an Element

```java
// OpenJDK 21: PriorityQueue.offer(E)
public boolean offer(E e) {
    if (e == null)
        throw new NullPointerException();  // PQ does NOT allow nulls
    modCount++;
    int i = size;
    if (i >= queue.length)
        grow(i + 1);                       // resize if full
    siftUp(i, e);                          // place at end, bubble up
    size = i + 1;
    return true;
}
```

The algorithm: place the new element at the next available slot (index `size`), then sift it up to restore the heap property.

### siftUp() — Bubbling Up

```java
// OpenJDK 21: PriorityQueue.siftUp (using Comparable, simplified)
private static <T> void siftUpComparable(int k, T x, Object[] es) {
    Comparable<? super T> key = (Comparable<? super T>) x;
    while (k > 0) {
        int parent = (k - 1) >>> 1;       // unsigned right shift = (k-1)/2
        Object e = es[parent];
        if (key.compareTo((T) e) >= 0)    // if new element >= parent, we are done
            break;
        es[k] = e;                         // move parent down
        k = parent;                        // move up to parent's position
    }
    es[k] = key;                           // place element in its final position
}
```

Trace through an example. Start with min-heap `[1, 3, 2, 7, 6, 5, 4]` and insert 0:

```
Step 0: Place 0 at index 7 → [1, 3, 2, 7, 6, 5, 4, 0]
        parent(7) = (7-1)/2 = 3, arr[3] = 7.  0 < 7 → swap
Step 1: Move 7 down → [1, 3, 2, 0, 6, 5, 4, 7]
        parent(3) = (3-1)/2 = 1, arr[1] = 3.  0 < 3 → swap
Step 2: Move 3 down → [1, 0, 2, 3, 6, 5, 4, 7]
        parent(1) = (1-1)/2 = 0, arr[0] = 1.  0 < 1 → swap
Step 3: Move 1 down → [0, 1, 2, 3, 6, 5, 4, 7]
        k = 0, loop exits (k > 0 is false)

Result: [0, 1, 2, 3, 6, 5, 4, 7] — valid min-heap
```

**Time complexity**: O(log n) — at most we traverse the height of the tree, which is floor(log2 n) for a complete binary tree.

**Note the unsigned right shift `>>>`**: OpenJDK uses `(k - 1) >>> 1` instead of `(k - 1) / 2`. For non-negative integers these are identical, but `>>>` avoids a potential issue if `k - 1` somehow became negative (it cannot here, but this is a defensive idiom throughout the JDK source).

### poll() — Removing the Root

```java
// OpenJDK 21: PriorityQueue.poll()
public E poll() {
    final Object[] es;
    final E result;

    if ((result = (E) ((es = queue)[0])) != null) {
        modCount++;
        final int n;
        E x = (E) es[(n = --size)];   // grab the last element
        es[n] = null;                   // clear to help GC
        if (n > 0)
            siftDown(0, x, es, n);     // move last to root, sift down
    }
    return result;
}
```

The algorithm: save the root (minimum), move the last element to the root position, then sift it down to restore the heap property.

### siftDown() — Bubbling Down

```java
// OpenJDK 21: PriorityQueue.siftDownComparable (simplified)
private static <T> void siftDownComparable(int k, T x, Object[] es, int n) {
    Comparable<? super T> key = (Comparable<? super T>) x;
    int half = n >>> 1;                    // loop while a non-leaf
    while (k < half) {
        int child = (k << 1) + 1;         // left child = 2k+1
        Object c = es[child];
        int right = child + 1;
        if (right < n &&
            ((Comparable<? super T>) c).compareTo((T) es[right]) > 0)
            c = es[child = right];         // pick the SMALLER child
        if (key.compareTo((T) c) <= 0)    // if element <= smaller child, done
            break;
        es[k] = c;                         // move smaller child up
        k = child;                         // descend to that child's position
    }
    es[k] = key;                           // place element in final position
}
```

**Critical detail**: We compare with BOTH children and swap with the SMALLER child (in a min-heap). If we swapped with the larger child, the larger child would become the parent of the smaller child, violating the heap property.

**The `half = n >>> 1` optimization**: Nodes at index `n/2` and beyond are all leaves (they have no children). So we only need to sift down as long as `k < half`. This avoids unnecessary child index calculations for leaf nodes.

Trace through: poll from `[0, 1, 2, 3, 6, 5, 4, 7]`:

```
Remove root (0). Move last (7) to root: [7, 1, 2, 3, 6, 5, 4]
n = 7, half = 3

Step 0: k=0, left=1(val=1), right=2(val=2). Smaller child = 1. 7 > 1 → swap
        [1, 7, 2, 3, 6, 5, 4]
Step 1: k=1, left=3(val=3), right=4(val=6). Smaller child = 3. 7 > 3 → swap
        [1, 3, 2, 7, 6, 5, 4]
Step 2: k=3, k >= half (3 >= 3) → exit loop

Result: [1, 3, 2, 7, 6, 5, 4] — valid min-heap
```

### heapify() / buildHeap — The O(n) Proof

This is one of the most commonly misunderstood complexities in all of DSA. Building a heap from an unsorted array is O(n), not O(n log n). Let me prove it rigorously.

**The naive analysis (wrong)**: "We call `siftDown` for each of the n/2 non-leaf nodes, and each `siftDown` is O(log n), so total is O(n log n)."

**The correct analysis**: Not every node sifts down the full height. Most nodes are near the bottom and sift down very little.

```java
// OpenJDK 21: PriorityQueue.heapify()
private void heapify() {
    final Object[] es = queue;
    int n = size, i = (n >>> 1) - 1;   // start from last non-leaf
    // Comparator path shown; Comparable path is analogous
    for (; i >= 0; i--)
        siftDownComparable(i, (E) es[i], es, n);
}
```

**Mathematical proof**:

For a complete binary tree of height `h = floor(log2 n)`:
- Level 0 (root): 1 node, can sift down at most h levels
- Level 1: 2 nodes, can sift down at most h-1 levels
- Level 2: 4 nodes, can sift down at most h-2 levels
- ...
- Level k: 2^k nodes, can sift down at most h-k levels
- Level h (leaves): 2^h nodes, sift down 0 levels (skip entirely)

Total work = sum over all levels of (number of nodes at level) x (max sift distance):

```
T = Σ (k=0 to h) 2^k * (h - k)
```

Substitute j = h - k (so when k=0, j=h; when k=h, j=0):

```
T = Σ (j=0 to h) 2^(h-j) * j
  = 2^h * Σ (j=0 to h) j / 2^j
  = 2^h * Σ (j=0 to h) j * (1/2)^j
```

The key identity: `Σ (j=0 to ∞) j * x^j = x / (1-x)^2` for |x| < 1.

With x = 1/2:

```
Σ (j=0 to ∞) j * (1/2)^j = (1/2) / (1 - 1/2)^2 = (1/2) / (1/4) = 2
```

Therefore:

```
T = 2^h * 2 = 2^(h+1) ≈ 2n
```

Since `2^h ≈ n` for a complete binary tree, the total work is `O(n)`.

**Intuition**: The majority of nodes (about n/2) are leaves that require zero work. The next level (n/4 nodes) requires at most 1 swap each. Only 1 node (the root) requires the full log n sifts. The work is heavily concentrated at the cheap end. Think of it as a geometric series that converges — most of the weight is in the first few terms.

**Why this matters in practice**: When constructing a `PriorityQueue` from a collection, OpenJDK calls `heapify()`. This means `new PriorityQueue<>(existingCollection)` is O(n), not O(n log n). If you instead create an empty PQ and call `offer()` n times, you pay O(n log n). Always prefer the collection constructor when you have all elements upfront:

```java
// O(n) — use this
PriorityQueue<Integer> pq = new PriorityQueue<>(existingList);

// O(n log n) — avoid this when you have all elements
PriorityQueue<Integer> pq = new PriorityQueue<>();
for (int x : existingList) pq.offer(x);
```

### grow() — Capacity Management

```java
// OpenJDK 21: PriorityQueue.grow(int minCapacity)
private void grow(int minCapacity) {
    int oldCapacity = queue.length;
    // Double size if small; grow by 50% if big
    int newCapacity = ArraysSupport.newLength(oldCapacity,
            minCapacity - oldCapacity, /* minimum growth */
            oldCapacity < 64 ? oldCapacity + 2 : oldCapacity >> 1);
    queue = Arrays.copyOf(queue, newCapacity);
}
```

The growth policy:
- **Capacity < 64**: Grow by `oldCapacity + 2` (roughly double plus 2). Small heaps grow aggressively to reduce early resizes.
- **Capacity >= 64**: Grow by 50% (`oldCapacity >> 1`). Large heaps grow more conservatively to avoid wasting memory.

This is different from `ArrayList` (which always grows by 50%) and `ArrayDeque` (which always doubles). The `+2` for small capacities ensures that very small heaps (capacity 1 or 2) still grow meaningfully.

### Thread Safety — PriorityQueue Is NOT Thread-Safe

`PriorityQueue` has no synchronization whatsoever. If multiple threads call `offer()` concurrently, you get corrupted internal state — not an exception, but silently broken heap invariants that produce wrong results later.

```java
// WRONG — data race
PriorityQueue<Task> taskQueue = new PriorityQueue<>();
// Thread 1: taskQueue.offer(task1);  // reads size, writes queue[size], increments size
// Thread 2: taskQueue.offer(task2);  // reads same size, overwrites queue[size]!

// CORRECT options:
// 1. PriorityBlockingQueue — for producer/consumer patterns
PriorityBlockingQueue<Task> taskQueue = new PriorityBlockingQueue<>();

// 2. External synchronization — if you need PQ semantics without blocking
PriorityQueue<Task> pq = new PriorityQueue<>();
synchronized (pq) { pq.offer(task); }

// 3. In practice, most interview problems are single-threaded — use PriorityQueue directly
```

`PriorityBlockingQueue` uses a single `ReentrantLock` for all mutations and a `Condition` for blocking `take()`. It does not use the fine-grained striping of `ConcurrentHashMap` — a priority queue has a single root, so there is no way to partition the work.

### Min-Heap vs Max-Heap

`PriorityQueue` is a min-heap by default. For a max-heap:

```java
// Option 1: Collections.reverseOrder() — cleanest
PriorityQueue<Integer> maxHeap = new PriorityQueue<>(Collections.reverseOrder());

// Option 2: Lambda — concise but BEWARE overflow
PriorityQueue<Integer> maxHeap = new PriorityQueue<>((a, b) -> b - a);
// DANGER: if b = Integer.MAX_VALUE and a = -1, then b - a overflows!
// b - a = 2147483647 - (-1) = -2147483648 (wraps to negative!)
// This makes the comparator return NEGATIVE when it should return POSITIVE.

// Option 3: Safe lambda using Integer.compare
PriorityQueue<Integer> maxHeap = new PriorityQueue<>((a, b) -> Integer.compare(b, a));
// Integer.compare never overflows — it uses branching, not subtraction.

// Option 4: Comparator.reverseOrder() — same as Collections.reverseOrder()
PriorityQueue<Integer> maxHeap = new PriorityQueue<>(Comparator.reverseOrder());
```

The overflow trap in `(a, b) -> b - a` has caused production bugs. I have seen a Dijkstra implementation return wrong shortest paths because edge weights near `Integer.MAX_VALUE` caused the comparator to flip. Always use `Integer.compare` or `Comparator.reverseOrder()`.

### The Two-Heap Technique — O(1) Median

This is one of the most elegant data structure tricks in interview DSA. Maintain two heaps:
- A **max-heap** for the lower half of the data
- A **min-heap** for the upper half of the data

The max-heap's root is the largest element in the lower half. The min-heap's root is the smallest element in the upper half. Keep the heaps balanced (sizes differ by at most 1). The median is always at one or both roots.

```
Data stream: 5, 2, 8, 1, 9, 3

After inserting all:
  maxHeap (lower half): [3, 2, 1]  → root = 3 (max of lower)
  minHeap (upper half): [5, 8, 9]  → root = 5 (min of upper)

Median = (3 + 5) / 2 = 4.0  (even count: average of two roots)

Insert 4:
  4 <= maxHeap.root(3)? No. 4 > 3, so insert into minHeap.
  minHeap: [4, 5, 8, 9] (size 4), maxHeap: [3, 2, 1] (size 3)
  Size difference = 1, within balance → ok
  Median = minHeap.root = 4  (odd count: root of larger heap)
```

Time complexities:
- `addNum()`: O(log n) — one heap insertion + possible rebalance
- `findMedian()`: O(1) — just peek at root(s)

This technique appears everywhere: real-time percentile tracking in monitoring systems (**Prometheus** histograms approximate this), streaming median for sensor data, and online algorithms where you cannot afford to sort.

---

## 6.2 ArrayDeque — The Circular Buffer

### Why ArrayDeque Exists

Before `ArrayDeque` (added in Java 6), the JDK's only `Deque` implementation was `LinkedList`. But `LinkedList` is a terrible queue for reasons we covered in Chapter 3:

- Each `Node` object is 32 bytes of overhead (header + item ref + prev ref + next ref)
- Nodes are scattered across the heap — every `poll()` chases a pointer to a random memory location
- GC must trace every node's `next` and `prev` references

`ArrayDeque` solves all of this with a circular buffer: a single contiguous array with head and tail pointers that wrap around.

### Internal Structure

```java
// OpenJDK 21: java/util/ArrayDeque.java (key fields)
public class ArrayDeque<E> extends AbstractCollection<E>
    implements Deque<E>, Cloneable, Serializable {

    transient Object[] elements;  // the circular buffer
    transient int head;           // index of first element
    transient int tail;           // index PAST the last element (next insertion point)

    // INVARIANT: elements.length is always a power of 2
    // INVARIANT: head == tail means empty (not full!)
}
```

**Power-of-2 sizing is critical**. When the array length is a power of 2, wrapping around can be done with a bitwise AND instead of a modulo operation:

```java
// With power-of-2 length:
int mask = elements.length - 1;       // e.g., 15 for length 16 (0b00001111)
int wrappedIndex = rawIndex & mask;   // strips high bits, wraps to [0, length)

// Without power-of-2 length, you would need:
int wrappedIndex = ((rawIndex % length) + length) % length;  // slow, handles negatives
```

The bitwise AND is a single CPU instruction. The modulo involves integer division, which is one of the slowest arithmetic operations on modern CPUs (often 20-40 cycles vs 1 cycle for AND).

### Visualizing the Circular Buffer

```
Initial state (capacity 8):
  elements: [ _, _, _, _, _, _, _, _ ]
  head = 0, tail = 0 (empty)

After addLast(A), addLast(B), addLast(C):
  elements: [ A, B, C, _, _, _, _, _ ]
  head = 0, tail = 3

After addFirst(X), addFirst(Y):
  elements: [ A, B, C, _, _, _, Y, X ]
  head = 6, tail = 3

  Logical order (head→tail): Y, X, A, B, C
  Physical layout:  [A][B][C][ ][ ][ ][Y][X]
                     ↑tail             ↑head

After pollFirst() (removes Y):
  elements: [ A, B, C, _, _, _, _, X ]
  head = 7, tail = 3

  Logical order: X, A, B, C
```

The beauty: both ends grow and shrink with O(1) index arithmetic. No pointer manipulation. No node allocation.

### addFirst() — Prepend an Element

```java
// OpenJDK 21: ArrayDeque.addFirst(E)
public void addFirst(E e) {
    if (e == null)
        throw new NullPointerException();
    final Object[] es = elements;
    es[head = (head - 1) & (es.length - 1)] = e;  // decrement head with wrap
    if (head == tail)
        grow(1);   // array is full, must resize
}
```

Trace: if `head = 0` and `elements.length = 8`:
```
head = (0 - 1) & 7 = (-1) & 7 = 0xFFFFFFFF & 0x00000007 = 7
```

In Java, `-1` in two's complement is all 1-bits (`0xFFFFFFFF`). ANDing with `7` (`0b111`) gives `7`. The head wraps from index 0 to index 7. This is why power-of-2 sizing works: the bitmask naturally handles the wrap-around for both positive and negative offsets.

### addLast() — Append an Element

```java
// OpenJDK 21: ArrayDeque.addLast(E)
public void addLast(E e) {
    if (e == null)
        throw new NullPointerException();
    final Object[] es = elements;
    es[tail] = e;
    if (head == (tail = (tail + 1) & (es.length - 1)))
        grow(1);
}
```

Note the order: store element THEN increment tail. In `addFirst`, we decrement head THEN store. This asymmetry is because `head` points to the first element (inclusive) while `tail` points past the last element (exclusive). The slot at `tail` is always empty and available for the next `addLast`.

### pollFirst() and pollLast()

```java
// OpenJDK 21: ArrayDeque.pollFirst()
public E pollFirst() {
    final Object[] es;
    final int h;
    E e = elementAt(es = elements, h = head);
    if (e != null) {
        es[h] = null;    // null out to help GC — prevents memory leak
        head = (h + 1) & (es.length - 1);
    }
    return e;
}

// ArrayDeque.pollLast()
public E pollLast() {
    final Object[] es;
    final int t;
    E e = elementAt(es = elements, t = (tail - 1) & (es.length - 1));
    if (e != null) {
        es[tail = t] = null;   // null out and update tail
    }
    return e;
}
```

**The `null` assignment is critical**: Without it, the deque would hold a strong reference to the removed element, preventing garbage collection. This is the same memory leak pattern that plagued the old `Stack` implementation in early JDK versions.

### Growth — When Head Meets Tail

```java
// OpenJDK 21: ArrayDeque.grow(int needed)
private void grow(int needed) {
    final int oldCapacity = elements.length;
    int newCapacity;
    // Double the capacity (jump: always at least 50% of old capacity)
    int jump = oldCapacity < 64 ? (oldCapacity + 2) : (oldCapacity >> 1);
    // Ensure sufficient growth
    newCapacity = ArraysSupport.newLength(oldCapacity, needed, jump);
    final Object[] es = elements = Arrays.copyOf(elements, newCapacity);
    // After resize, head and tail may need adjustment because the old circular
    // layout wrapped around. We need to unwrap it.
    if (tail < head || (tail == head && es[head] != null)) {
        int newSpace = newCapacity - oldCapacity;
        System.arraycopy(es, head, es, head + newSpace, oldCapacity - head);
        for (int i = head, to = i + newSpace; i < to; i++)
            es[i] = null;
        head += newSpace;
    }
}
```

When the circular buffer is full (`head == tail` after an insertion), the array is doubled. The tricky part is unwrapping the circular layout. Consider:

```
Before grow (capacity 8, full):
  [D][E][F][G][A][B][C][ ]
   0  1  2  3  4  5  6  7
              tail^  ^head
  Wait — head=4, tail=3, but the picture shows tail=3 and the last addLast put G at index 3
  Logical order: A, B, C, D, E, F, G

After doubling to capacity 16:
  First, Arrays.copyOf creates:
  [D][E][F][G][A][B][C][ ][ ][ ][ ][ ][ ][ ][ ][ ]
   0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15

  Then, move the head portion (indices 4-7) to the end:
  [D][E][F][G][ ][ ][ ][ ][ ][ ][ ][ ][A][B][C][ ]
   0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15
              ^tail                      ^head=12

  Logical order: A(12), B(13), C(14), D(0), E(1), F(2), G(3) ✓
```

The two-chunk copy is the cost of the circular layout — but it only happens on resize, which is amortized O(1) per operation.

### Why ArrayDeque Beats LinkedList

Let us quantify this. For a queue of N elements:

| Metric | ArrayDeque | LinkedList |
|--------|-----------|------------|
| Memory per element | 4 bytes (reference) | 32 bytes (Node object: 16 header + 4 item + 4 prev + 4 next + 4 padding) |
| Memory overhead for 1M elements | ~4 MB | ~32 MB |
| Cache behavior on poll() | Sequential array access | Pointer chase to random location |
| Allocation on enqueue | None (writes to existing slot) | 1 Node object allocation |
| GC on dequeue | Nulls out reference | Node object becomes garbage |
| L1 cache misses per operation | ~0 (prefetcher predicts) | ~1 (random memory access) |

Benchmarks consistently show `ArrayDeque` is **3-5x faster** than `LinkedList` for queue operations, and the gap widens with more elements due to cache effects. For stack operations (push/pop from one end), `ArrayDeque` is even faster because all accesses are to the same end of the array — maximum cache locality.

**The JDK Javadoc itself says**:
> "This class is likely to be faster than Stack when used as a stack, and faster than LinkedList when used as a queue."

---

## 6.3 Stack — The Legacy Mistake

### Why `Stack<E>` Is Broken

```java
// OpenJDK: java/util/Stack.java
public class Stack<E> extends Vector<E> {
    public E push(E item) {
        addElement(item);   // delegates to Vector.addElement — synchronized
        return item;
    }
    public synchronized E pop() { ... }
    public synchronized E peek() { ... }
    public synchronized int search(Object o) { ... }
}
```

Three design flaws:

**Flaw 1: Inheritance instead of composition**. `Stack extends Vector`, which means `Stack` inherits ALL of `Vector`'s methods: `get(i)`, `set(i, e)`, `remove(i)`, `insertElementAt(e, i)`. You can access any element by index, completely violating the stack abstraction (LIFO access only). A stack should not let you peek at the middle.

```java
Stack<String> stack = new Stack<>();
stack.push("A"); stack.push("B"); stack.push("C");
stack.get(0);    // "A" — this should not be possible on a stack!
stack.remove(1); // removes "B" from the middle — violates LIFO
```

**Flaw 2: Synchronized everything**. Every method is `synchronized` because `Vector` is synchronized. In single-threaded code (which is 99% of stack usage), you pay the synchronization overhead for nothing. Even though modern JVMs can eliminate uncontended locks via biased locking and lock elision, the overhead is still nonzero and the intent is wrong.

**Flaw 3: Iteration order is wrong**. `Stack` iterates bottom-to-top (because it inherits `Vector`'s iterator). A stack should iterate top-to-bottom.

### The Correct Alternative: ArrayDeque

```java
// Use ArrayDeque as a stack — this is the JDK-recommended approach
Deque<String> stack = new ArrayDeque<>();

stack.push("A");    // push = addFirst (adds to front)
stack.push("B");
stack.push("C");

stack.peek();       // "C" — peekFirst
stack.pop();        // "C" — removeFirst
stack.pop();        // "B"

// No get(i). No remove(i). The Deque interface does not expose random access.
// No synchronization overhead.
// Backed by a contiguous array — cache-friendly.
```

Why `push()` maps to `addFirst()` and not `addLast()`: the `Deque` interface defines `push/pop/peek` as operating on the first element. This is an arbitrary convention, but it means the "top" of the stack is at index `head` in the circular buffer.

### The JVM Call Stack

Every thread in the JVM has its own call stack. When a method is invoked, the JVM pushes a new **stack frame** containing:

```
┌──────────────────────────────────────────┐
│            Stack Frame                    │
│  ┌─────────────────────────────────────┐ │
│  │  Local Variable Array                │ │
│  │  [this, arg1, arg2, ..., local1, ..]│ │
│  └─────────────────────────────────────┘ │
│  ┌─────────────────────────────────────┐ │
│  │  Operand Stack                       │ │
│  │  (used for bytecode execution)       │ │
│  └─────────────────────────────────────┘ │
│  ┌─────────────────────────────────────┐ │
│  │  Frame Data                          │ │
│  │  (return address, constant pool ref) │ │
│  └─────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

Default thread stack size: 512KB on 32-bit, 1MB on 64-bit (configurable via `-Xss`). A typical stack frame is 32-128 bytes depending on local variables. So maximum recursion depth is roughly 8,000-30,000 frames before `StackOverflowError`.

This is why deep recursion is dangerous in Java. A recursive DFS on a graph with 100,000 nodes will overflow the stack. The fix: convert to iterative with an explicit `ArrayDeque` as your stack:

```java
// Recursive DFS — will StackOverflow on large graphs
void dfs(int node, boolean[] visited) {
    visited[node] = true;
    for (int neighbor : graph[node]) {
        if (!visited[neighbor]) dfs(neighbor, visited);
    }
}

// Iterative DFS — uses heap memory, no stack limit
void dfs(int start, boolean[] visited) {
    Deque<Integer> stack = new ArrayDeque<>();
    stack.push(start);
    while (!stack.isEmpty()) {
        int node = stack.pop();
        if (visited[node]) continue;
        visited[node] = true;
        for (int neighbor : graph[node]) {
            if (!visited[neighbor]) stack.push(neighbor);
        }
    }
}
```

---

## 6.4 Monotonic Stack and Monotonic Deque

These are not separate data structures — they are usage patterns applied to stacks and deques. They appear so frequently in interviews that they deserve dedicated coverage. We will give a preview here; Chapter 19 covers advanced techniques in full depth.

### Monotonic Stack

A monotonic stack maintains its elements in sorted order (either non-increasing or non-decreasing). When a new element would violate the monotonic property, we pop elements until the invariant is restored.

**Classic problem: Next Greater Element**

For each element in an array, find the first element to its right that is greater.

```
Input:  [4, 2, 6, 1, 8, 3]
Output: [6, 6, 8, 8,-1,-1]

Explanation:
  4 → next greater is 6
  2 → next greater is 6
  6 → next greater is 8
  1 → next greater is 8
  8 → no greater element to the right → -1
  3 → no greater element to the right → -1
```

**Pattern: Process right to left, maintain a decreasing stack.**

```java
int[] nextGreater(int[] nums) {
    int n = nums.length;
    int[] result = new int[n];
    Deque<Integer> stack = new ArrayDeque<>();  // stores values (not indices)

    for (int i = n - 1; i >= 0; i--) {
        // Pop elements that are NOT greater than nums[i]
        while (!stack.isEmpty() && stack.peek() <= nums[i]) {
            stack.pop();
        }
        result[i] = stack.isEmpty() ? -1 : stack.peek();
        stack.push(nums[i]);
    }
    return result;
}
```

**Why this is O(n)**: Each element is pushed once and popped at most once. Total pushes = n, total pops <= n, so total operations = O(n).

The invariant: the stack always contains elements in decreasing order from bottom to top. When we encounter `nums[i]`, any stack element that is <= `nums[i]` can never be the "next greater element" for any future (leftward) element, because `nums[i]` is closer and at least as large. So we safely pop them.

### Monotonic Deque — Sliding Window Maximum

For the sliding window maximum problem, we maintain a deque where elements are in decreasing order. The front always holds the current window's maximum.

```java
int[] maxSlidingWindow(int[] nums, int k) {
    int n = nums.length;
    int[] result = new int[n - k + 1];
    Deque<Integer> deque = new ArrayDeque<>();  // stores indices

    for (int i = 0; i < n; i++) {
        // Remove elements outside the window from the front
        while (!deque.isEmpty() && deque.peekFirst() < i - k + 1) {
            deque.pollFirst();
        }
        // Remove elements smaller than nums[i] from the back
        // They can never be the maximum while nums[i] exists in the window
        while (!deque.isEmpty() && nums[deque.peekLast()] <= nums[i]) {
            deque.pollLast();
        }
        deque.addLast(i);
        if (i >= k - 1) {
            result[i - k + 1] = nums[deque.peekFirst()];
        }
    }
    return result;
}
```

**Why a deque and not just a stack**: We need to remove from BOTH ends. Expired elements leave from the front (they have fallen out of the window). Smaller elements leave from the back (they are superseded by the new element). This two-ended removal is exactly what a deque provides.

---

## 6.5 Real-World Correlations

### PriorityQueue / Heap in Production

**OS Process Scheduling**: The Linux Completely Fair Scheduler (CFS) uses a Red-Black tree, but many older schedulers and real-time schedulers use heaps. The `nice` value determines priority — lower nice = higher priority = closer to root in the min-heap. Processes are dequeued from the heap in priority order.

**Dijkstra's Shortest Path**: The algorithm repeatedly extracts the minimum-distance vertex. A min-heap makes this O(log V) per extraction, giving O((V + E) log V) total. Without a heap, the naive approach scans all vertices for the minimum — O(V^2).

**Event-Driven Simulation**: Discrete event simulators (used in network simulation, game engines, financial modeling) maintain a priority queue of events sorted by timestamp. The next event to process is always the one with the smallest timestamp — a min-heap extraction.

**A* Pathfinding**: The open set in A* is a priority queue ordered by `f(n) = g(n) + h(n)`. Game engines process billions of pathfinding queries using heaps. Many use custom D-ary heaps (4-ary is common) for better cache performance.

**Timer Wheels vs Heaps**: `java.util.Timer` and `ScheduledThreadPoolExecutor` use heaps for scheduling tasks by execution time. Netty's `HashedWheelTimer` uses a different approach (timer wheel) that trades precision for O(1) insertion. Kafka uses a hierarchical timing wheel. The choice between heap and timer wheel depends on whether you need exact ordering (heap) or approximate buckets (wheel).

### ArrayDeque / Circular Buffer in Production

**TCP Send/Receive Buffers**: The kernel maintains a circular buffer for each TCP connection. Data written by the application wraps around the buffer; data acknowledged by the remote end frees space at the beginning. The `head` and `tail` pointers in `ArrayDeque` are conceptually identical to the send buffer's `SND.UNA` and `SND.NXT` pointers.

**Kafka Log Segments**: Each Kafka partition is an append-only log. The log is divided into segments, and within each segment, writes are append-only (like `addLast`). Consumers read from an offset (like `head`). The circular retention policy (delete segments older than N days) mimics circular buffer behavior at a higher level.

**LMAX Disruptor**: The Disruptor is a high-performance inter-thread messaging library used by LMAX Exchange for financial trading. Its core data structure is a ring buffer — a circular array with a sequence number instead of head/tail pointers. It achieves millions of operations per second because it avoids locks, leverages mechanical sympathy (cache lines), and uses the same power-of-2 sizing trick as `ArrayDeque`.

**Linux `io_uring`**: The kernel's modern async I/O interface uses two ring buffers: the submission queue (SQ) and the completion queue (CQ). Applications submit I/O requests to the SQ ring buffer; the kernel posts completions to the CQ ring buffer. Both are circular buffers with the same head/tail/wrap-around semantics as `ArrayDeque`.

### Stack in Production

**JVM Call Stack**: Every thread has one. Frame push on method entry, frame pop on return. `StackOverflowError` when depth exceeds `-Xss` limit.

**Expression Evaluation**: Compilers use the shunting-yard algorithm (Dijkstra, 1961) to convert infix expressions to postfix using a stack. The JVM's own bytecode verifier uses a stack to type-check operand stack usage.

**Undo/Redo**: Two stacks — the undo stack (push on every action) and the redo stack (push on undo, clear on new action). Every text editor, every drawing program, every spreadsheet uses this pattern.

**DFS Traversal**: The explicit stack replaces the call stack for iterative DFS. Used in cycle detection, topological sorting, connected components, and maze solving.

**Compiler Parsing**: Recursive descent parsers use the call stack directly. Bottom-up (shift-reduce) parsers use an explicit stack to track parser states. Every time `javac` compiles your code, it uses stacks.

### Monotonic Stack in Production

**Stock Span Calculation**: For each day, find how many consecutive days before it had a price less than or equal to today's price. This is the "next greater element to the left" problem, used in technical analysis of stock prices.

**Histogram Area (Largest Rectangle)**: Used in image processing, UI layout engines, and geographic information systems to find maximum rectangular regions.

---

## 6.6 Problems

### Heap Problems

---

**P6.01** [E] — Kth Largest Element in an Array

**Problem**: Given an integer array `nums` and an integer `k`, return the kth largest element. Note that it is the kth largest in the sorted order, not the kth distinct element.

**Solution**:

```java
// Approach 1: Min-heap of size k — O(n log k) time, O(k) space
// Maintain a min-heap of the k largest elements seen so far.
// The root of the heap is the kth largest.
public int findKthLargest(int[] nums, int k) {
    PriorityQueue<Integer> minHeap = new PriorityQueue<>();
    for (int num : nums) {
        minHeap.offer(num);
        if (minHeap.size() > k) {
            minHeap.poll();  // evict the smallest — it cannot be in top k
        }
    }
    return minHeap.peek();  // root = smallest among the k largest = kth largest
}

// Approach 2: QuickSelect — O(n) average, O(n^2) worst, O(1) space
// Partition around a pivot. If pivot index == n-k, we found it.
// If pivot index < n-k, recurse on right half. Else, left half.
public int findKthLargestQuickSelect(int[] nums, int k) {
    int target = nums.length - k;
    int lo = 0, hi = nums.length - 1;
    while (lo < hi) {
        int pivot = partition(nums, lo, hi);
        if (pivot == target) return nums[pivot];
        else if (pivot < target) lo = pivot + 1;
        else hi = pivot - 1;
    }
    return nums[lo];
}

private int partition(int[] nums, int lo, int hi) {
    // Median-of-three pivot selection to reduce worst-case probability
    int mid = lo + (hi - lo) / 2;
    if (nums[mid] < nums[lo]) swap(nums, lo, mid);
    if (nums[hi] < nums[lo]) swap(nums, lo, hi);
    if (nums[mid] < nums[hi]) swap(nums, mid, hi);
    int pivot = nums[hi];
    int i = lo;
    for (int j = lo; j < hi; j++) {
        if (nums[j] <= pivot) {
            swap(nums, i, j);
            i++;
        }
    }
    swap(nums, i, hi);
    return i;
}

private void swap(int[] nums, int a, int b) {
    int tmp = nums[a]; nums[a] = nums[b]; nums[b] = tmp;
}
```

**Complexity**: Heap approach: O(n log k) time, O(k) space. QuickSelect: O(n) average time, O(1) space.

**JVM Insight**: For `k` << `n`, the heap approach keeps only `k` objects in the heap, reducing GC pressure. QuickSelect modifies the array in-place but destroys the original order. In production, if the array must not be modified, the heap approach is preferable or you clone first.

**Real-World**: Finding the top-K queries by frequency in a search engine's query log. The min-heap approach is streamable — you can process entries one at a time without loading the entire dataset into memory. This is exactly how distributed top-K works in **Elasticsearch** aggregations.

---

**P6.02** [E] — Kth Largest Element in a Stream

**Problem**: Design a class that finds the kth largest element in a stream. The class accepts an initial array and supports `add(int val)` which adds a value and returns the kth largest.

**Solution**:

```java
class KthLargest {
    private final PriorityQueue<Integer> minHeap;
    private final int k;

    // O(n log k) initialization
    public KthLargest(int k, int[] nums) {
        this.k = k;
        this.minHeap = new PriorityQueue<>();
        for (int num : nums) {
            add(num);
        }
    }

    // O(log k) per call
    public int add(int val) {
        minHeap.offer(val);
        if (minHeap.size() > k) {
            minHeap.poll();
        }
        return minHeap.peek();
    }
}
```

**Complexity**: O(log k) per `add` call. O(k) space for the heap.

**JVM Insight**: The `PriorityQueue` is initialized with default capacity 11. If k is known upfront, pass it as initial capacity to avoid resizes: `new PriorityQueue<>(k)`. Each `Integer` stored costs 16 bytes due to boxing. For extremely high throughput, a primitive int heap would eliminate autoboxing.

**Real-World**: **Monitoring alert thresholds** — "alert when the 95th percentile response time exceeds 500ms." A stream of response times is continuously processed, maintaining a heap of the top 5% of values.

---

**P6.03** [M] — Top K Frequent Elements

**Problem**: Given an integer array `nums` and an integer `k`, return the `k` most frequent elements.

**Solution**:

```java
// Approach 1: Min-heap of size k by frequency — O(n log k)
public int[] topKFrequent(int[] nums, int k) {
    Map<Integer, Integer> freq = new HashMap<>();
    for (int num : nums) freq.merge(num, 1, Integer::sum);

    // Min-heap ordered by frequency
    PriorityQueue<int[]> minHeap = new PriorityQueue<>((a, b) -> a[1] - b[1]);
    for (var entry : freq.entrySet()) {
        minHeap.offer(new int[]{entry.getKey(), entry.getValue()});
        if (minHeap.size() > k) minHeap.poll();
    }

    int[] result = new int[k];
    for (int i = 0; i < k; i++) result[i] = minHeap.poll()[0];
    return result;
}

// Approach 2: Bucket sort by frequency — O(n)
public int[] topKFrequentBucket(int[] nums, int k) {
    Map<Integer, Integer> freq = new HashMap<>();
    for (int num : nums) freq.merge(num, 1, Integer::sum);

    // Bucket index = frequency, bucket value = list of numbers with that frequency
    // Max possible frequency = nums.length
    @SuppressWarnings("unchecked")
    List<Integer>[] buckets = new List[nums.length + 1];
    for (var entry : freq.entrySet()) {
        int f = entry.getValue();
        if (buckets[f] == null) buckets[f] = new ArrayList<>();
        buckets[f].add(entry.getKey());
    }

    int[] result = new int[k];
    int idx = 0;
    for (int i = buckets.length - 1; i >= 0 && idx < k; i--) {
        if (buckets[i] != null) {
            for (int num : buckets[i]) {
                result[idx++] = num;
                if (idx == k) break;
            }
        }
    }
    return result;
}
```

**Complexity**: Heap: O(n log k). Bucket sort: O(n).

**JVM Insight**: The bucket sort creates a `List[]` of length `n+1`, most of which are null. This wastes memory for sparse frequency distributions. The heap approach uses O(distinct elements) for the map plus O(k) for the heap — typically much less memory. Also note the `@SuppressWarnings("unchecked")` — generic array creation is not possible in Java due to type erasure, so we cast `List[]` to `List<Integer>[]`.

**Real-World**: Finding the top-K most requested URLs in an access log. In **Nginx** and **Apache** analytics, this is a standard query. At massive scale, count-min sketch + heap gives approximate top-K in O(n) time with sublinear space.

---

**P6.04** [H] — Find Median from Data Stream (Two Heaps)

**Problem**: Design a data structure that supports `addNum(int num)` and `findMedian()` returning the median of all elements added so far.

**Solution**:

```java
class MedianFinder {
    // maxHeap holds the smaller half, minHeap holds the larger half
    private final PriorityQueue<Integer> maxHeap;  // lower half
    private final PriorityQueue<Integer> minHeap;  // upper half

    public MedianFinder() {
        maxHeap = new PriorityQueue<>(Collections.reverseOrder());
        minHeap = new PriorityQueue<>();
    }

    // O(log n)
    public void addNum(int num) {
        // Step 1: Add to appropriate heap
        if (maxHeap.isEmpty() || num <= maxHeap.peek()) {
            maxHeap.offer(num);
        } else {
            minHeap.offer(num);
        }

        // Step 2: Rebalance — sizes differ by at most 1
        // We keep maxHeap.size() >= minHeap.size() (maxHeap can be 1 larger)
        if (maxHeap.size() > minHeap.size() + 1) {
            minHeap.offer(maxHeap.poll());
        } else if (minHeap.size() > maxHeap.size()) {
            maxHeap.offer(minHeap.poll());
        }
    }

    // O(1)
    public double findMedian() {
        if (maxHeap.size() > minHeap.size()) {
            return maxHeap.peek();
        }
        return (maxHeap.peek() + minHeap.peek()) / 2.0;
    }
}
```

**Complexity**: `addNum`: O(log n). `findMedian`: O(1).

**JVM Insight**: Each heap stores `Integer` objects (boxed). For a stream of 10 million numbers, that is 10M `Integer` objects at 16 bytes each = 160 MB just for the values, plus the two backing arrays. A primitive-based heap implementation would cut memory in half. Also note: `maxHeap.peek() + minHeap.peek()` can overflow if both are near `Integer.MAX_VALUE`. Use `(long) maxHeap.peek() + minHeap.peek()` for safety.

**Real-World**: **Prometheus** and **Datadog** approximate streaming percentiles using similar techniques. Exact percentile tracking for time-series metrics in monitoring systems. Also used in real-time bidding systems where you need the median bid price with O(1) access.

---

**P6.05** [H] — Merge K Sorted Lists

**Problem**: Merge `k` sorted linked lists into one sorted linked list.

**Solution**:

```java
public ListNode mergeKLists(ListNode[] lists) {
    if (lists == null || lists.length == 0) return null;

    // Min-heap of list nodes, ordered by node value
    PriorityQueue<ListNode> minHeap = new PriorityQueue<>(
        lists.length, (a, b) -> Integer.compare(a.val, b.val)
    );

    // Add the head of each non-empty list
    for (ListNode head : lists) {
        if (head != null) minHeap.offer(head);
    }

    ListNode dummy = new ListNode(0);
    ListNode current = dummy;

    while (!minHeap.isEmpty()) {
        ListNode smallest = minHeap.poll();
        current.next = smallest;
        current = current.next;
        if (smallest.next != null) {
            minHeap.offer(smallest.next);   // push the next node from that list
        }
    }
    current.next = null;
    return dummy.next;
}
```

**Complexity**: O(N log k) where N is total number of nodes across all lists. The heap always has at most k elements.

**JVM Insight**: The initial capacity of the PriorityQueue is set to `lists.length` to avoid resizes. The comparator uses `Integer.compare` instead of subtraction — a pattern we should always follow. The dummy node avoids special-casing the first element.

**Real-World**: **Merge phase of external sort** — when sorting data that does not fit in memory, you sort chunks in memory, write sorted runs to disk, then merge them using a k-way merge with a heap. This is exactly how `sort -m` works, how **Hadoop MapReduce** merges sorted mapper outputs, and how **LevelDB/RocksDB** compaction merges sorted SSTables.

---

**P6.06** [M] — Sort Nearly Sorted Array (K-Sorted)

**Problem**: Given an array where each element is at most `k` positions away from its sorted position, sort the array efficiently.

**Solution**:

```java
public void sortKSorted(int[] arr, int k) {
    PriorityQueue<Integer> minHeap = new PriorityQueue<>();
    int idx = 0;

    for (int i = 0; i < arr.length; i++) {
        minHeap.offer(arr[i]);
        // Once heap has more than k+1 elements, the minimum is guaranteed
        // to be in its correct position
        if (minHeap.size() > k) {
            arr[idx++] = minHeap.poll();
        }
    }
    // Drain remaining elements
    while (!minHeap.isEmpty()) {
        arr[idx++] = minHeap.poll();
    }
}
```

**Complexity**: O(n log k) time, O(k) space. Much better than O(n log n) when k << n.

**JVM Insight**: The heap never grows beyond k+1 elements, so memory usage is bounded regardless of array size. This is ideal for streaming scenarios where the full array is not in memory.

**Real-World**: **Timestamp-ordered event streams** often arrive nearly sorted — events from different servers may arrive slightly out of order due to network latency. Kafka consumers with multiple partitions see this pattern. The k-sort algorithm is exactly how **Apache Flink** and **Apache Beam** handle event-time watermarks with allowed lateness.

---

**P6.07** [M] — Task Scheduler

**Problem**: Given an array of tasks represented by characters and a cooldown interval `n`, return the minimum number of intervals needed to complete all tasks. The same task must have at least `n` intervals between two executions.

**Solution**:

```java
public int leastInterval(char[] tasks, int n) {
    int[] freq = new int[26];
    for (char task : tasks) freq[task - 'A']++;

    PriorityQueue<Integer> maxHeap = new PriorityQueue<>(Collections.reverseOrder());
    for (int f : freq) {
        if (f > 0) maxHeap.offer(f);
    }

    Queue<int[]> cooldown = new LinkedList<>();  // [remaining_count, available_time]
    int time = 0;

    while (!maxHeap.isEmpty() || !cooldown.isEmpty()) {
        time++;
        if (!maxHeap.isEmpty()) {
            int remaining = maxHeap.poll() - 1;
            if (remaining > 0) {
                cooldown.offer(new int[]{remaining, time + n});
            }
        }
        // Check if any task has finished its cooldown
        if (!cooldown.isEmpty() && cooldown.peek()[1] == time) {
            maxHeap.offer(cooldown.poll()[0]);
        }
    }
    return time;
}

// Mathematical approach — O(n) time, O(1) space
public int leastIntervalMath(char[] tasks, int n) {
    int[] freq = new int[26];
    int maxFreq = 0;
    for (char task : tasks) {
        freq[task - 'A']++;
        maxFreq = Math.max(maxFreq, freq[task - 'A']);
    }
    // Count how many tasks have the maximum frequency
    int maxCount = 0;
    for (int f : freq) if (f == maxFreq) maxCount++;

    // Formula: (maxFreq - 1) * (n + 1) + maxCount
    // But total tasks may exceed this if n is small
    return Math.max(tasks.length, (maxFreq - 1) * (n + 1) + maxCount);
}
```

**Complexity**: Heap approach: O(T log 26) = O(T) where T = total tasks. Math: O(T).

**JVM Insight**: The heap contains at most 26 elements (26 letters), so all heap operations are effectively O(1) since log(26) ~ 4.7 — a constant. This is a case where asymptotic analysis hides a very favorable constant.

**Real-World**: **OS CPU scheduling with cooldown** — preventing the same process from monopolizing the CPU. Also models rate-limiting in API gateways: each API client can make at most 1 request per `n` time units.

---

**P6.08** [M] — Reorganize String

**Problem**: Given a string `s`, rearrange the characters so that no two adjacent characters are the same. Return any valid rearrangement, or `""` if impossible.

**Solution**:

```java
public String reorganizeString(String s) {
    int[] freq = new int[26];
    for (char c : s.toCharArray()) freq[c - 'a']++;

    // Check impossibility: if any char has frequency > (n+1)/2
    int maxFreq = 0;
    for (int f : freq) maxFreq = Math.max(maxFreq, f);
    if (maxFreq > (s.length() + 1) / 2) return "";

    // Max-heap by frequency
    PriorityQueue<int[]> maxHeap = new PriorityQueue<>((a, b) -> b[1] - a[1]);
    for (int i = 0; i < 26; i++) {
        if (freq[i] > 0) maxHeap.offer(new int[]{i, freq[i]});
    }

    StringBuilder sb = new StringBuilder();
    while (maxHeap.size() >= 2) {
        int[] first = maxHeap.poll();   // most frequent
        int[] second = maxHeap.poll();  // second most frequent

        sb.append((char) (first[0] + 'a'));
        sb.append((char) (second[0] + 'a'));

        if (--first[1] > 0) maxHeap.offer(first);
        if (--second[1] > 0) maxHeap.offer(second);
    }

    if (!maxHeap.isEmpty()) {
        sb.append((char) (maxHeap.poll()[0] + 'a'));
    }

    return sb.toString();
}
```

**Complexity**: O(n log 26) = O(n) time, O(26) = O(1) space.

**JVM Insight**: We use `int[]` pairs instead of `Map.Entry` or custom objects to avoid boxing and object creation overhead. The `StringBuilder` avoids string concatenation's O(n^2) trap. Note that `(a, b) -> b[1] - a[1]` is safe here since frequencies are always non-negative and small — no overflow risk.

**Real-World**: **Disk I/O scheduling** — avoiding consecutive reads from the same disk arm position to reduce seek time. Also similar to **task assignment** in distributed systems where you avoid scheduling the same type of task on consecutive time slots.

---

**P6.09** [M] — K Closest Points to Origin

**Problem**: Given an array of points on the X-Y plane, return the `k` closest points to the origin `(0, 0)`.

**Solution**:

```java
// Max-heap of size k — keep the k closest
public int[][] kClosest(int[][] points, int k) {
    // Max-heap: farthest of the "k closest" at root
    PriorityQueue<int[]> maxHeap = new PriorityQueue<>(
        (a, b) -> (b[0]*b[0] + b[1]*b[1]) - (a[0]*a[0] + a[1]*a[1])
    );

    for (int[] p : points) {
        maxHeap.offer(p);
        if (maxHeap.size() > k) {
            maxHeap.poll();  // remove the farthest among our candidates
        }
    }

    int[][] result = new int[k][2];
    for (int i = 0; i < k; i++) result[i] = maxHeap.poll();
    return result;
}
```

**Complexity**: O(n log k) time, O(k) space.

**JVM Insight**: We compare squared distances to avoid `Math.sqrt()`, which involves floating-point computation. Integer multiplication of coordinates up to 10^4 gives values up to 2 * 10^8, well within int range. But if coordinates could be up to 10^5, use `long` to avoid overflow in `a[0]*a[0]`.

**Real-World**: **Nearest neighbor search** in geographic systems, recommendation engines, and computer vision. At scale, this is done with KD-trees or VP-trees, but for small k, the heap approach is simpler and often faster due to lower constant factors.

---

**P6.10** [H] — Smallest Range Covering Elements from K Lists

**Problem**: Given `k` sorted lists, find the smallest range `[a, b]` such that at least one element from each list falls within the range.

**Solution**:

```java
public int[] smallestRange(List<List<Integer>> nums) {
    // Min-heap: (value, list_index, element_index)
    PriorityQueue<int[]> minHeap = new PriorityQueue<>((a, b) -> a[0] - b[0]);
    int maxVal = Integer.MIN_VALUE;

    // Initialize with the first element of each list
    for (int i = 0; i < nums.size(); i++) {
        int val = nums.get(i).get(0);
        minHeap.offer(new int[]{val, i, 0});
        maxVal = Math.max(maxVal, val);
    }

    int rangeStart = 0, rangeEnd = Integer.MAX_VALUE;

    while (minHeap.size() == nums.size()) {  // all lists still represented
        int[] min = minHeap.poll();
        int minVal = min[0], listIdx = min[1], elemIdx = min[2];

        // Current range: [minVal, maxVal]
        if (maxVal - minVal < rangeEnd - rangeStart) {
            rangeStart = minVal;
            rangeEnd = maxVal;
        }

        // Advance the list that had the minimum
        if (elemIdx + 1 < nums.get(listIdx).size()) {
            int nextVal = nums.get(listIdx).get(elemIdx + 1);
            minHeap.offer(new int[]{nextVal, listIdx, elemIdx + 1});
            maxVal = Math.max(maxVal, nextVal);
        }
        // If any list is exhausted, we stop — can't cover all lists anymore
    }

    return new int[]{rangeStart, rangeEnd};
}
```

**Complexity**: O(N log k) where N = total elements across all lists.

**JVM Insight**: We maintain a running `maxVal` separately because a min-heap does not efficiently provide the maximum. This avoids needing a separate max-heap or scanning the heap for the max.

**Real-World**: **Multi-source data synchronization** — finding the smallest time window where all data sources have reported at least one event. Used in sensor fusion systems and distributed log correlation.

---

**P6.11** [M] — IPO (Capital Maximization)

**Problem**: Given `k` projects you can complete, each with a `capital` requirement and `profit`, and a starting capital `w`, maximize your final capital. You can only start a project if your capital >= its requirement, and you complete projects sequentially.

**Solution**:

```java
public int findMaximizedCapital(int k, int w, int[] profits, int[] capital) {
    int n = profits.length;
    int[][] projects = new int[n][2];
    for (int i = 0; i < n; i++) {
        projects[i] = new int[]{capital[i], profits[i]};
    }
    // Sort by capital requirement
    Arrays.sort(projects, (a, b) -> a[0] - b[0]);

    // Max-heap of profits for affordable projects
    PriorityQueue<Integer> maxHeap = new PriorityQueue<>(Collections.reverseOrder());
    int idx = 0;

    for (int i = 0; i < k; i++) {
        // Add all newly affordable projects
        while (idx < n && projects[idx][0] <= w) {
            maxHeap.offer(projects[idx][1]);
            idx++;
        }
        if (maxHeap.isEmpty()) break;  // no affordable project
        w += maxHeap.poll();           // pick the most profitable
    }
    return w;
}
```

**Complexity**: O(n log n) for sorting + O(n log n) for heap operations = O(n log n).

**JVM Insight**: We sort projects by capital first, then lazily add to the heap as projects become affordable. This avoids putting all projects in the heap upfront. The two-pointer + heap pattern is a recurring interview motif.

**Real-World**: **Venture capital portfolio optimization** — given limited capital, invest in the most profitable projects you can afford. Also models **cloud resource provisioning**: given a budget, which combination of services maximizes throughput?

---

**P6.12** [M] — Ugly Number II

**Problem**: An ugly number is a positive number whose prime factors are limited to 2, 3, and 5. Given `n`, find the nth ugly number (1 is the first ugly number).

**Solution**:

```java
// Approach 1: Min-heap — O(n log n)
public int nthUglyNumber(int n) {
    PriorityQueue<Long> minHeap = new PriorityQueue<>();
    Set<Long> seen = new HashSet<>();
    minHeap.offer(1L);
    seen.add(1L);
    long ugly = 1;

    for (int i = 0; i < n; i++) {
        ugly = minHeap.poll();
        for (long factor : new long[]{2, 3, 5}) {
            long next = ugly * factor;
            if (seen.add(next)) {       // add returns false if already present
                minHeap.offer(next);
            }
        }
    }
    return (int) ugly;
}

// Approach 2: Three pointers — O(n) time, O(n) space (optimal)
public int nthUglyNumberDP(int n) {
    int[] ugly = new int[n];
    ugly[0] = 1;
    int i2 = 0, i3 = 0, i5 = 0;

    for (int i = 1; i < n; i++) {
        int next2 = ugly[i2] * 2;
        int next3 = ugly[i3] * 3;
        int next5 = ugly[i5] * 5;
        int next = Math.min(next2, Math.min(next3, next5));
        ugly[i] = next;
        if (next == next2) i2++;
        if (next == next3) i3++;
        if (next == next5) i5++;
    }
    return ugly[n - 1];
}
```

**Complexity**: Heap: O(n log n). Three pointers: O(n).

**JVM Insight**: The heap approach uses `Long` to avoid overflow (since ugly numbers can grow large during generation). The three-pointer approach stays within `int` range for reasonable `n`. Notice the heap approach uses `Set<Long>` for deduplication — each `Long` is 24 bytes (16 header + 8 value), so memory adds up for large `n`.

**Real-World**: Generating numbers with specific prime factorizations appears in **number-theoretic transforms** (NTT) used in cryptography and in **computing highly composite numbers** for hash table sizing.

---

### Stack Problems

---

**P6.13** [E] — Valid Parentheses

**Problem**: Given a string containing only `(){}[]`, determine if the input is valid: every open bracket has a matching close bracket in the correct order.

**Solution**:

```java
public boolean isValid(String s) {
    Deque<Character> stack = new ArrayDeque<>();
    for (char c : s.toCharArray()) {
        if (c == '(') stack.push(')');
        else if (c == '{') stack.push('}');
        else if (c == '[') stack.push(']');
        else {
            if (stack.isEmpty() || stack.pop() != c) return false;
        }
    }
    return stack.isEmpty();
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: Pushing the expected closing bracket instead of the opening bracket simplifies the check — we just compare `stack.pop() != c` instead of needing a map lookup. The `toCharArray()` creates a copy of the string's underlying byte array (since JDK 9, strings use compact byte arrays). For very large strings, iterate by index with `s.charAt(i)` to avoid the copy.

**Real-World**: **JSON/XML parser validation** — every `{` needs a `}`, every `<tag>` needs a `</tag>`. Compilers use this to validate syntax. Network protocol parsers validate nested message structures the same way.

---

**P6.14** [M] — Min Stack

**Problem**: Design a stack that supports `push`, `pop`, `top`, and `getMin` in O(1) time.

**Solution**:

```java
class MinStack {
    private final Deque<long[]> stack;  // [value, currentMin]

    public MinStack() {
        stack = new ArrayDeque<>();
    }

    public void push(int val) {
        long min = stack.isEmpty() ? val : Math.min(val, stack.peek()[1]);
        stack.push(new long[]{val, min});
    }

    public void pop() {
        stack.pop();
    }

    public int top() {
        return (int) stack.peek()[0];
    }

    public int getMin() {
        return (int) stack.peek()[1];
    }
}

// Space-optimized: single stack, store difference from min
class MinStackOptimized {
    private final Deque<Long> stack;
    private long min;

    public MinStackOptimized() {
        stack = new ArrayDeque<>();
    }

    public void push(int val) {
        if (stack.isEmpty()) {
            stack.push(0L);
            min = val;
        } else {
            stack.push((long) val - min);  // store difference
            if (val < min) min = val;
        }
    }

    public void pop() {
        long diff = stack.pop();
        if (diff < 0) {
            // This element was the min; previous min = min - diff
            min = min - diff;
        }
    }

    public int top() {
        long diff = stack.peek();
        return (int) (diff < 0 ? min : min + diff);
    }

    public int getMin() {
        return (int) min;
    }
}
```

**Complexity**: O(1) for all operations. First approach: O(n) space. Optimized: O(n) space but each element is a `long` instead of a `long[2]`.

**JVM Insight**: The first approach creates a `long[2]` per push — that is 32 bytes per element (16 header + 16 data). The optimized approach stores a single `Long` (24 bytes with boxing, but `ArrayDeque` stores it as an `Object` reference to a boxed `Long`). A truly optimized version would use a primitive long deque.

**Real-World**: **Transaction rollback tracking** — each database transaction tracks the minimum timestamp for MVCC (Multi-Version Concurrency Control). The min stack pattern allows O(1) minimum lookup as transactions are pushed and popped.

---

**P6.15** [M] — Evaluate Reverse Polish Notation

**Problem**: Evaluate an arithmetic expression in Reverse Polish Notation (postfix).

**Solution**:

```java
public int evalRPN(String[] tokens) {
    Deque<Integer> stack = new ArrayDeque<>();
    for (String token : tokens) {
        switch (token) {
            case "+" -> { int b = stack.pop(), a = stack.pop(); stack.push(a + b); }
            case "-" -> { int b = stack.pop(), a = stack.pop(); stack.push(a - b); }
            case "*" -> { int b = stack.pop(), a = stack.pop(); stack.push(a * b); }
            case "/" -> { int b = stack.pop(), a = stack.pop(); stack.push(a / b); }
            default  -> stack.push(Integer.parseInt(token));
        }
    }
    return stack.pop();
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: The `switch` on `String` compiles to a `lookupswitch` on `hashCode()` followed by `equals()` checks. Since we have only 4 operator strings, the JIT will likely convert this to a series of fast comparisons. Note that `Integer.parseInt` is called for every number token — for very long expressions, this parsing overhead is non-trivial.

**Real-World**: **Bytecode execution** in stack-based virtual machines (the JVM itself is a stack machine). The JVM's operand stack evaluates expressions exactly this way: `iadd` pops two ints and pushes the sum. PostScript printers, Forth programming, and HP calculators all use RPN.

---

**P6.16** [M] — Daily Temperatures

**Problem**: Given an array of daily temperatures, return an array where `result[i]` is the number of days you have to wait until a warmer temperature. If no warmer day exists, output 0.

**Solution**:

```java
public int[] dailyTemperatures(int[] temperatures) {
    int n = temperatures.length;
    int[] result = new int[n];
    Deque<Integer> stack = new ArrayDeque<>();  // stores indices

    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && temperatures[stack.peek()] < temperatures[i]) {
            int prevDay = stack.pop();
            result[prevDay] = i - prevDay;
        }
        stack.push(i);
    }
    return result;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: The stack stores indices (int), but `ArrayDeque` boxes them to `Integer`. For n = 10^5, worst case the stack holds all elements — 10^5 `Integer` objects at 16 bytes each = 1.6 MB. Not a concern for interviews, but in production you would use a primitive int stack.

**Real-World**: **Stock price analysis** — "how many days until the stock price exceeds today's?" is exactly this problem. Also used in **meteorological data processing** and **thermal monitoring** of data center servers.

---

**P6.17** [E] — Next Greater Element I

**Problem**: Given two arrays `nums1` (subset of `nums2`), for each element in `nums1`, find the next greater element in `nums2`. If none exists, output -1.

**Solution**:

```java
public int[] nextGreaterElement(int[] nums1, int[] nums2) {
    // Precompute next greater for all elements in nums2
    Map<Integer, Integer> nextGreater = new HashMap<>();
    Deque<Integer> stack = new ArrayDeque<>();

    for (int num : nums2) {
        while (!stack.isEmpty() && stack.peek() < num) {
            nextGreater.put(stack.pop(), num);
        }
        stack.push(num);
    }

    int[] result = new int[nums1.length];
    for (int i = 0; i < nums1.length; i++) {
        result[i] = nextGreater.getOrDefault(nums1[i], -1);
    }
    return result;
}
```

**Complexity**: O(n + m) time, O(n) space where n = nums2.length, m = nums1.length.

**JVM Insight**: We precompute into a `HashMap` for O(1) lookup. The stack processes `nums2` left to right; when we encounter a value greater than the stack top, we have found the next greater element for that stack element.

**Real-World**: **Dependency resolution** — for each version of a library, find the next version that breaks backward compatibility. Package managers like **Maven** and **npm** perform similar queries on version chains.

---

**P6.18** [M] — Next Greater Element II (Circular Array)

**Problem**: Given a circular array, find the next greater element for each element. The array wraps around.

**Solution**:

```java
public int[] nextGreaterElements(int[] nums) {
    int n = nums.length;
    int[] result = new int[n];
    Arrays.fill(result, -1);
    Deque<Integer> stack = new ArrayDeque<>();

    // Process the array twice to handle circular wrap
    for (int i = 0; i < 2 * n; i++) {
        int num = nums[i % n];
        while (!stack.isEmpty() && nums[stack.peek()] < num) {
            result[stack.pop()] = num;
        }
        if (i < n) stack.push(i);  // only push indices from first pass
    }
    return result;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: The `i % n` modulo in the loop body is computed every iteration. If `n` is a power of 2, we could use `i & (n - 1)` for speed — but `n` is arbitrary here, so we cannot. The JIT compiler may strength-reduce this if the loop count is large enough.

**Real-World**: **Circular scheduling** — in round-robin task scheduling, you need to find the next task with higher priority, wrapping around the schedule. This circular next-greater pattern applies directly.

---

**P6.19** [H] — Largest Rectangle in Histogram

**Problem**: Given an array of bar heights representing a histogram, find the area of the largest rectangle that can be formed within the histogram.

**Solution**:

```java
public int largestRectangleArea(int[] heights) {
    int n = heights.length;
    Deque<Integer> stack = new ArrayDeque<>();  // stores indices
    int maxArea = 0;

    for (int i = 0; i <= n; i++) {
        int currHeight = (i == n) ? 0 : heights[i];  // sentinel: height 0 at end

        while (!stack.isEmpty() && heights[stack.peek()] > currHeight) {
            int height = heights[stack.pop()];
            // Width: from the bar after the new stack top to i-1
            int width = stack.isEmpty() ? i : (i - stack.peek() - 1);
            maxArea = Math.max(maxArea, height * width);
        }
        stack.push(i);
    }
    return maxArea;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: The sentinel value (height 0 at index n) ensures all remaining bars in the stack get processed without a separate cleanup loop. Each bar is pushed once and popped once — exactly 2n operations. The stack never exceeds n elements.

**Real-World**: **Maximal rectangle in a binary matrix** — used in image processing for finding the largest rectangular region of pixels meeting a criteria. Also used in **UI layout engines** for computing maximum available space in grid layouts.

---

**P6.20** [H] — Trapping Rain Water (Stack Approach)

**Problem**: Given an elevation map, compute how much water can be trapped after raining.

**Solution**:

```java
// Stack approach: find water layer by layer (horizontal)
public int trap(int[] height) {
    Deque<Integer> stack = new ArrayDeque<>();
    int water = 0;

    for (int i = 0; i < height.length; i++) {
        while (!stack.isEmpty() && height[stack.peek()] < height[i]) {
            int bottom = stack.pop();
            if (stack.isEmpty()) break;  // no left wall
            int left = stack.peek();
            int width = i - left - 1;
            int boundedHeight = Math.min(height[left], height[i]) - height[bottom];
            water += width * boundedHeight;
        }
        stack.push(i);
    }
    return water;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: This approach computes water in horizontal layers (between each pair of walls), unlike the two-pointer approach which computes per column. Both are O(n), but the stack approach uses more memory. The two-pointer approach is O(1) space and is generally preferred in interviews, but the stack approach demonstrates monotonic stack mastery.

**Real-World**: **Terrain analysis in GIS** — computing water accumulation in topographic maps. Also models **network buffer overflow** — when a burst of packets exceeds the buffer capacity at narrow points in the network.

---

**P6.21** [H] — Basic Calculator I

**Problem**: Implement a basic calculator that evaluates a string expression with `+`, `-`, `(`, `)`, and non-negative integers.

**Solution**:

```java
public int calculate(String s) {
    Deque<Integer> stack = new ArrayDeque<>();  // saves signs before parentheses
    int result = 0;
    int num = 0;
    int sign = 1;  // 1 for positive, -1 for negative

    for (int i = 0; i < s.length(); i++) {
        char c = s.charAt(i);
        if (Character.isDigit(c)) {
            num = num * 10 + (c - '0');
        } else if (c == '+') {
            result += sign * num;
            num = 0;
            sign = 1;
        } else if (c == '-') {
            result += sign * num;
            num = 0;
            sign = -1;
        } else if (c == '(') {
            // Save current result and sign, reset for sub-expression
            stack.push(result);
            stack.push(sign);
            result = 0;
            sign = 1;
        } else if (c == ')') {
            result += sign * num;
            num = 0;
            result *= stack.pop();   // saved sign
            result += stack.pop();    // saved result
        }
    }
    result += sign * num;  // last number
    return result;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: We avoid `Integer.parseInt` by building numbers digit by digit. The `Character.isDigit(c)` call is a static method that the JIT will inline to a simple range check. Each `(` pushes exactly 2 values; each `)` pops exactly 2 — the stack depth equals the nesting depth times 2.

**Real-World**: **Expression evaluation in configuration engines** — Spring Expression Language (SpEL), NGINX config variables, and Grafana dashboard queries all parse and evaluate nested expressions. The same stack-based approach powers all of them.

---

**P6.22** [M] — Basic Calculator II

**Problem**: Implement a calculator for expressions with `+`, `-`, `*`, `/` and non-negative integers (no parentheses).

**Solution**:

```java
public int calculate(String s) {
    Deque<Integer> stack = new ArrayDeque<>();
    int num = 0;
    char prevOp = '+';

    for (int i = 0; i < s.length(); i++) {
        char c = s.charAt(i);
        if (Character.isDigit(c)) {
            num = num * 10 + (c - '0');
        }
        if ((!Character.isDigit(c) && c != ' ') || i == s.length() - 1) {
            switch (prevOp) {
                case '+' -> stack.push(num);
                case '-' -> stack.push(-num);
                case '*' -> stack.push(stack.pop() * num);
                case '/' -> stack.push(stack.pop() / num);
            }
            prevOp = c;
            num = 0;
        }
    }

    int result = 0;
    while (!stack.isEmpty()) result += stack.pop();
    return result;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: The `switch` on `char` compiles to a `tableswitch` bytecode (since `+`, `-`, `*`, `/` have ASCII values 42-47, a small range). The JIT will generate a jump table for O(1) dispatch.

**Real-World**: This is operator precedence handling. Multiplication and division are immediately resolved (higher precedence), while addition and subtraction defer to the stack. This is a simplified version of the **shunting-yard algorithm** used in every compiler's expression parser.

---

**P6.23** [M] — Decode String

**Problem**: Decode an encoded string like `"3[a2[c]]"` which means `"accaccacc"`.

**Solution**:

```java
public String decodeString(String s) {
    Deque<StringBuilder> strStack = new ArrayDeque<>();
    Deque<Integer> countStack = new ArrayDeque<>();
    StringBuilder current = new StringBuilder();
    int k = 0;

    for (char c : s.toCharArray()) {
        if (Character.isDigit(c)) {
            k = k * 10 + (c - '0');
        } else if (c == '[') {
            countStack.push(k);
            strStack.push(current);
            current = new StringBuilder();
            k = 0;
        } else if (c == ']') {
            int repeat = countStack.pop();
            StringBuilder prev = strStack.pop();
            String repeated = current.toString();
            for (int i = 0; i < repeat; i++) {
                prev.append(repeated);
            }
            current = prev;
        } else {
            current.append(c);
        }
    }
    return current.toString();
}
```

**Complexity**: O(output length) time and space.

**JVM Insight**: We use two stacks — one for counts, one for partially built strings. Each `[` creates a new `StringBuilder`. The `toString()` inside the `]` handler creates a snapshot for repeated appending. For deeply nested strings with high repeat counts, the output can be exponentially larger than the input — this is by design but can cause `OutOfMemoryError` for adversarial inputs.

**Real-World**: **Template expansion** — Helm charts (`{{ range }}...{{ end }}`), Mustache templates, and macro expansion in C preprocessors all follow this nested expand-and-repeat pattern.

---

**P6.24** [H] — Remove Duplicate Letters

**Problem**: Given a string, remove duplicate letters so that every letter appears once. Return the smallest lexicographic result among all possible results.

**Solution**:

```java
public String removeDuplicateLetters(String s) {
    int[] lastIndex = new int[26];
    for (int i = 0; i < s.length(); i++) {
        lastIndex[s.charAt(i) - 'a'] = i;
    }

    boolean[] inStack = new boolean[26];
    Deque<Character> stack = new ArrayDeque<>();

    for (int i = 0; i < s.length(); i++) {
        char c = s.charAt(i);
        if (inStack[c - 'a']) continue;  // already in result

        // Pop characters that are greater than c AND appear later
        while (!stack.isEmpty() && stack.peek() > c && lastIndex[stack.peek() - 'a'] > i) {
            inStack[stack.pop() - 'a'] = false;
        }

        stack.push(c);
        inStack[c - 'a'] = true;
    }

    StringBuilder sb = new StringBuilder();
    while (!stack.isEmpty()) sb.append(stack.pop());
    return sb.reverse().toString();
}
```

**Complexity**: O(n) time, O(1) space (stack holds at most 26 characters).

**JVM Insight**: The `inStack` boolean array provides O(1) membership checks — faster than a `HashSet<Character>` which involves boxing. The `lastIndex` precomputation allows us to make greedy decisions about whether a character can be safely removed.

**Real-World**: This is a form of **greedy selection with constraints**. Similar logic appears in **compiler register allocation** — choosing the smallest set of registers while respecting usage lifetimes.

---

**P6.25** [M] — Asteroid Collision

**Problem**: Given an array of asteroids moving in a row (positive = right, negative = left), determine the state after all collisions. When two collide, the smaller one explodes. Same size: both explode.

**Solution**:

```java
public int[] asteroidCollision(int[] asteroids) {
    Deque<Integer> stack = new ArrayDeque<>();

    for (int asteroid : asteroids) {
        boolean survived = true;

        // Collision: right-moving in stack, current is left-moving
        while (!stack.isEmpty() && stack.peek() > 0 && asteroid < 0) {
            int top = stack.peek();
            if (top < -asteroid) {
                stack.pop();    // top explodes, asteroid survives — continue checking
            } else if (top == -asteroid) {
                stack.pop();    // both explode
                survived = false;
                break;
            } else {
                survived = false;   // asteroid explodes
                break;
            }
        }
        if (survived) stack.push(asteroid);
    }

    int[] result = new int[stack.size()];
    for (int i = result.length - 1; i >= 0; i--) {
        result[i] = stack.pop();
    }
    return result;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: Each asteroid is pushed at most once and popped at most once — O(n) total operations despite the inner while loop. The result array is filled in reverse because we pop from the stack (LIFO). An alternative: use `stack.toArray()` with the appropriate collection conversion, but manual fill is cleaner.

**Real-World**: **Conflict resolution in distributed systems** — when two updates collide (same key, different values), the "larger" one wins. Last-writer-wins (LWW) registers in CRDTs use a similar model where timestamps determine the survivor.

---

**P6.26** [M] — Car Fleet

**Problem**: N cars are driving toward a destination. Each has a position and speed. A faster car behind a slower car forms a fleet (slows to the slower speed). How many fleets arrive at the destination?

**Solution**:

```java
public int carFleet(int target, int[] position, int[] speed) {
    int n = position.length;
    double[][] cars = new double[n][2];
    for (int i = 0; i < n; i++) {
        cars[i][0] = position[i];
        cars[i][1] = (double) (target - position[i]) / speed[i];  // time to destination
    }

    // Sort by position descending (closest to target first)
    Arrays.sort(cars, (a, b) -> Double.compare(b[0], a[0]));

    int fleets = 0;
    double maxTime = 0;

    for (double[] car : cars) {
        if (car[1] > maxTime) {
            // This car takes longer than all cars ahead — forms a new fleet
            maxTime = car[1];
            fleets++;
        }
        // Otherwise, it catches up to the fleet ahead (absorbed)
    }
    return fleets;
}
```

**Complexity**: O(n log n) time (sorting), O(n) space.

**JVM Insight**: We use `double` for time computation. `Double.compare` handles NaN and -0.0 correctly, unlike `<` operator. The sort by position descending processes cars from closest to farthest from target — a car behind cannot pass one ahead, so if it takes longer, it must be a separate fleet.

**Real-World**: **Network packet coalescing** — packets heading to the same destination at different speeds (different paths through the network) merge into bursts. This model is used in **TCP's Nagle algorithm** analysis.

---

**P6.27** [M] — Score of Parentheses

**Problem**: Given a balanced parentheses string, compute its score: `()` = 1, `AB` = A+B, `(A)` = 2*A.

**Solution**:

```java
public int scoreOfParentheses(String s) {
    Deque<Integer> stack = new ArrayDeque<>();
    stack.push(0);  // base score for outer level

    for (char c : s.toCharArray()) {
        if (c == '(') {
            stack.push(0);  // new scope, score starts at 0
        } else {
            int inner = stack.pop();   // score of inner scope
            int outer = stack.pop();   // score of enclosing scope
            stack.push(outer + Math.max(2 * inner, 1));
            // If inner == 0, this is "()" → score 1
            // If inner > 0, this is "(A)" → score 2*A
        }
    }
    return stack.pop();
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: The stack depth equals the nesting depth. For a balanced string of length n, max nesting depth is n/2 (all opening parens first). The `Math.max(2 * inner, 1)` elegantly handles both base case and recursive case in one expression.

**Real-World**: **Recursive grammar scoring** — parse tree evaluation where nested structures have multiplicative weight. Used in natural language processing scoring of parse trees and in compiler optimization where deeper nesting increases instruction cost.

---

**P6.28** [H] — Longest Valid Parentheses

**Problem**: Given a string containing only `(` and `)`, find the length of the longest valid (well-formed) parentheses substring.

**Solution**:

```java
// Stack approach: store indices
public int longestValidParentheses(String s) {
    Deque<Integer> stack = new ArrayDeque<>();
    stack.push(-1);  // boundary marker for "start of valid substring - 1"
    int maxLen = 0;

    for (int i = 0; i < s.length(); i++) {
        if (s.charAt(i) == '(') {
            stack.push(i);
        } else {
            stack.pop();
            if (stack.isEmpty()) {
                stack.push(i);  // new boundary marker
            } else {
                maxLen = Math.max(maxLen, i - stack.peek());
            }
        }
    }
    return maxLen;
}

// O(1) space: two-pass with counters
public int longestValidParenthesesOptimal(String s) {
    int left = 0, right = 0, maxLen = 0;

    // Left to right
    for (int i = 0; i < s.length(); i++) {
        if (s.charAt(i) == '(') left++; else right++;
        if (left == right) maxLen = Math.max(maxLen, 2 * right);
        else if (right > left) { left = 0; right = 0; }
    }

    left = 0; right = 0;
    // Right to left (catches cases like "(()")
    for (int i = s.length() - 1; i >= 0; i--) {
        if (s.charAt(i) == '(') left++; else right++;
        if (left == right) maxLen = Math.max(maxLen, 2 * left);
        else if (left > right) { left = 0; right = 0; }
    }
    return maxLen;
}
```

**Complexity**: Stack: O(n) time, O(n) space. Counter: O(n) time, O(1) space.

**JVM Insight**: The stack stores indices as boxed `Integer` objects. The counter approach uses only primitive `int` variables — zero heap allocation, zero GC pressure. For strings of length 10^6, this matters.

**Real-World**: **Protocol message parsing** — finding the longest valid message in a corrupted byte stream. TCP reassembly must identify the longest parseable segment from potentially corrupt or out-of-order data.

---

### Queue and Deque Problems

---

**P6.29** [H] — Sliding Window Maximum

**Problem**: Given an array and window size `k`, return the maximum value in each window as it slides from left to right.

**Solution**:

```java
public int[] maxSlidingWindow(int[] nums, int k) {
    int n = nums.length;
    int[] result = new int[n - k + 1];
    Deque<Integer> deque = new ArrayDeque<>();  // indices in decreasing order of value

    for (int i = 0; i < n; i++) {
        // Remove indices outside the current window
        while (!deque.isEmpty() && deque.peekFirst() < i - k + 1) {
            deque.pollFirst();
        }
        // Remove indices whose values are smaller than nums[i]
        // They can never be the max while nums[i] is in the window
        while (!deque.isEmpty() && nums[deque.peekLast()] <= nums[i]) {
            deque.pollLast();
        }
        deque.addLast(i);
        if (i >= k - 1) {
            result[i - k + 1] = nums[deque.peekFirst()];
        }
    }
    return result;
}
```

**Complexity**: O(n) time, O(k) space.

**JVM Insight**: The deque holds at most `k` indices. Each element is enqueued and dequeued at most once from each end — amortized O(1) per element. This is the canonical monotonic deque pattern.

**Real-World**: **Network throughput monitoring** — finding the maximum throughput in a sliding time window. **Load testing analysis** — Gatling and JMeter report peak RPS over sliding windows. **Real-time trading** — identifying the highest price in the last N ticks for stop-loss calculations.

---

**P6.30** [E] — Implement Stack Using Queues

**Problem**: Implement a LIFO stack using only two FIFO queues.

**Solution**:

```java
class MyStack {
    private Queue<Integer> queue;

    public MyStack() {
        queue = new LinkedList<>();
    }

    // O(n) push: rotate queue to put new element at front
    public void push(int x) {
        queue.offer(x);
        int size = queue.size();
        // Rotate: move all previous elements behind the new one
        for (int i = 0; i < size - 1; i++) {
            queue.offer(queue.poll());
        }
    }

    public int pop() { return queue.poll(); }       // O(1)
    public int top() { return queue.peek(); }       // O(1)
    public boolean empty() { return queue.isEmpty(); }
}
```

**Complexity**: push O(n), all others O(1).

**JVM Insight**: We use a single queue with rotation instead of two queues. The rotation moves n-1 elements on each push, making push O(n). This trade-off favors frequent pop/peek over push. Using `LinkedList` here is acceptable since we only access the front — no random access means no cache penalty.

**Real-World**: This is a theoretical exercise demonstrating that stacks and queues are interconvertible. In practice, you would never do this — but it tests understanding of FIFO vs LIFO semantics.

---

**P6.31** [E] — Implement Queue Using Stacks

**Problem**: Implement a FIFO queue using only two LIFO stacks.

**Solution**:

```java
class MyQueue {
    private final Deque<Integer> inStack;
    private final Deque<Integer> outStack;

    public MyQueue() {
        inStack = new ArrayDeque<>();
        outStack = new ArrayDeque<>();
    }

    public void push(int x) {
        inStack.push(x);   // O(1)
    }

    public int pop() {
        if (outStack.isEmpty()) {
            // Transfer all elements from inStack to outStack (reverses order)
            while (!inStack.isEmpty()) {
                outStack.push(inStack.pop());
            }
        }
        return outStack.pop();   // Amortized O(1)
    }

    public int peek() {
        if (outStack.isEmpty()) {
            while (!inStack.isEmpty()) {
                outStack.push(inStack.pop());
            }
        }
        return outStack.peek();
    }

    public boolean empty() {
        return inStack.isEmpty() && outStack.isEmpty();
    }
}
```

**Complexity**: Push O(1). Pop amortized O(1) — each element is transferred exactly once.

**JVM Insight**: The amortized O(1) analysis: each element is pushed to `inStack` once (O(1)), transferred to `outStack` once (O(1)), and popped from `outStack` once (O(1)). Total cost per element over its lifetime: O(1). This is more efficient than the rotate approach in the stack-using-queues problem.

**Real-World**: This is exactly how **BFS with two arrays** works: one array for the current level, one for the next level. Swap when the current level is exhausted. The same pattern appears in **double buffering** in graphics rendering — write to the back buffer, swap to front when complete.

---

**P6.32** [M] — Design Circular Queue

**Problem**: Design a circular queue with `enQueue`, `deQueue`, `Front`, `Rear`, `isEmpty`, `isFull`.

**Solution**:

```java
class MyCircularQueue {
    private final int[] data;
    private int head;
    private int tail;
    private int size;
    private final int capacity;

    public MyCircularQueue(int k) {
        data = new int[k];
        capacity = k;
        head = 0;
        tail = 0;
        size = 0;
    }

    public boolean enQueue(int value) {
        if (isFull()) return false;
        data[tail] = value;
        tail = (tail + 1) % capacity;
        size++;
        return true;
    }

    public boolean deQueue() {
        if (isEmpty()) return false;
        head = (head + 1) % capacity;
        size--;
        return true;
    }

    public int Front() {
        return isEmpty() ? -1 : data[head];
    }

    public int Rear() {
        return isEmpty() ? -1 : data[(tail - 1 + capacity) % capacity];
    }

    public boolean isEmpty() { return size == 0; }
    public boolean isFull() { return size == capacity; }
}
```

**Complexity**: All operations O(1).

**JVM Insight**: We use a separate `size` counter instead of the `head == tail` ambiguity between empty and full. An alternative is to allocate one extra slot (capacity k+1) so that `head == tail` means empty and `(tail+1) % capacity == head` means full — this is what some kernel ring buffers do. Our approach uses all slots. Note: we use `%` instead of `&` because `capacity` may not be a power of 2.

**Real-World**: This is the exact data structure behind **circular log buffers** in embedded systems, **UART receive buffers** in microcontrollers, and the **TCP window** mechanism.

---

**P6.33** [M] — Design Circular Deque

**Problem**: Design a double-ended circular queue supporting `insertFront`, `insertLast`, `deleteFront`, `deleteLast`, `getFront`, `getRear`, `isEmpty`, `isFull`.

**Solution**:

```java
class MyCircularDeque {
    private final int[] data;
    private int head;
    private int tail;
    private int size;
    private final int capacity;

    public MyCircularDeque(int k) {
        data = new int[k];
        capacity = k;
        head = 0;
        tail = 0;
        size = 0;
    }

    public boolean insertFront(int value) {
        if (isFull()) return false;
        head = (head - 1 + capacity) % capacity;
        data[head] = value;
        size++;
        return true;
    }

    public boolean insertLast(int value) {
        if (isFull()) return false;
        data[tail] = value;
        tail = (tail + 1) % capacity;
        size++;
        return true;
    }

    public boolean deleteFront() {
        if (isEmpty()) return false;
        head = (head + 1) % capacity;
        size--;
        return true;
    }

    public boolean deleteLast() {
        if (isEmpty()) return false;
        tail = (tail - 1 + capacity) % capacity;
        size--;
        return true;
    }

    public int getFront() { return isEmpty() ? -1 : data[head]; }
    public int getRear() { return isEmpty() ? -1 : data[(tail - 1 + capacity) % capacity]; }
    public boolean isEmpty() { return size == 0; }
    public boolean isFull() { return size == capacity; }
}
```

**Complexity**: All operations O(1).

**JVM Insight**: The `+ capacity` before `% capacity` handles the negative modulo case. In Java, `-1 % 5` returns `-1` (not `4`). Adding `capacity` before the mod ensures the result is always non-negative. Compare to `ArrayDeque` which uses `& (length - 1)` — that trick only works with power-of-2 sizes where the bitmask naturally wraps negatives.

**Real-World**: **Work-stealing deques** in the Fork/Join framework. Each worker thread has a deque of tasks. The owner pushes and pops from one end (LIFO for locality), while other threads steal from the opposite end (FIFO for load balancing). `ForkJoinPool` implements exactly this.

---

**P6.34** [E] — Moving Average from Data Stream

**Problem**: Given a stream of integers and a window size, calculate the moving average of all integers in the sliding window.

**Solution**:

```java
class MovingAverage {
    private final int[] window;
    private int head;
    private int count;
    private long sum;
    private final int size;

    public MovingAverage(int size) {
        this.size = size;
        window = new int[size];
        head = 0;
        count = 0;
        sum = 0;
    }

    public double next(int val) {
        if (count == size) {
            sum -= window[head];   // subtract the element that will be overwritten
        } else {
            count++;
        }
        window[head] = val;
        sum += val;
        head = (head + 1) % size;
        return (double) sum / count;
    }
}
```

**Complexity**: O(1) per call.

**JVM Insight**: We use a circular buffer (the `window` array) to avoid shifting elements. The `sum` is maintained incrementally — subtract the outgoing element, add the incoming element. We use `long` for `sum` to prevent overflow when summing many `int` values. If each value is up to 10^5 and window size is 10^5, the max sum is 10^10 — exceeds `int` range but fits in `long`.

**Real-World**: **Time-series databases** (InfluxDB, TimescaleDB) compute moving averages for monitoring dashboards. **Signal processing** uses this for smoothing (simple moving average filter). **Network monitoring** tools calculate average throughput over sliding windows.

---

**P6.35** [M] — Walls and Gates (BFS)

**Problem**: In a grid, 0 = gate, -1 = wall, INF = empty room. Fill each empty room with the distance to its nearest gate using multi-source BFS.

**Solution**:

```java
public void wallsAndGates(int[][] rooms) {
    int m = rooms.length, n = rooms[0].length;
    int INF = Integer.MAX_VALUE;
    Queue<int[]> queue = new ArrayDeque<>();

    // Enqueue all gates as BFS starting points
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (rooms[i][j] == 0) {
                queue.offer(new int[]{i, j});
            }
        }
    }

    int[][] dirs = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};
    while (!queue.isEmpty()) {
        int[] cell = queue.poll();
        int row = cell[0], col = cell[1];
        for (int[] d : dirs) {
            int r = row + d[0], c = col + d[1];
            if (r >= 0 && r < m && c >= 0 && c < n && rooms[r][c] == INF) {
                rooms[r][c] = rooms[row][col] + 1;
                queue.offer(new int[]{r, c});
            }
        }
    }
}
```

**Complexity**: O(m * n) time and space.

**JVM Insight**: Multi-source BFS: all gates are enqueued simultaneously at distance 0. BFS guarantees that the first time a room is reached, it is by the shortest path. We use `ArrayDeque` as the queue — significantly faster than `LinkedList` for this pattern due to cache locality.

**Real-World**: **Network latency mapping** — given multiple data centers (gates), compute the latency from each server (room) to its nearest data center. Also used in **game AI** for computing distance fields (used by pathfinding heuristics) and **fire evacuation modeling** (distance to nearest exit).

---

**P6.36** [M] — Rotting Oranges (BFS)

**Problem**: In a grid, 2 = rotten orange, 1 = fresh orange, 0 = empty. Every minute, fresh oranges adjacent to rotten ones become rotten. Return the minutes until no fresh orange remains, or -1 if impossible.

**Solution**:

```java
public int orangesRotting(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    Queue<int[]> queue = new ArrayDeque<>();
    int fresh = 0;

    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == 2) queue.offer(new int[]{i, j});
            else if (grid[i][j] == 1) fresh++;
        }
    }

    if (fresh == 0) return 0;

    int[][] dirs = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};
    int minutes = 0;

    while (!queue.isEmpty() && fresh > 0) {
        int size = queue.size();
        minutes++;
        for (int q = 0; q < size; q++) {
            int[] cell = queue.poll();
            for (int[] d : dirs) {
                int r = cell[0] + d[0], c = cell[1] + d[1];
                if (r >= 0 && r < m && c >= 0 && c < n && grid[r][c] == 1) {
                    grid[r][c] = 2;
                    fresh--;
                    queue.offer(new int[]{r, c});
                }
            }
        }
    }
    return fresh == 0 ? minutes : -1;
}
```

**Complexity**: O(m * n) time and space.

**JVM Insight**: BFS by level: the `for (int q = 0; q < size; q++)` loop processes all cells at the current distance before moving to the next distance. This level-order processing gives us the time dimension for free. Each `int[]{i, j}` allocation is a small object (24 bytes); for large grids, this creates significant GC pressure.

**Real-World**: **Epidemic simulation** — modeling disease spread from initial infection points. This is exactly the SIR model's spatial variant. Also used in **forest fire simulation**, **flood modeling**, and **chemical spill propagation** analysis.

---

### Design Problems

---

**P6.37** [M] — Implement Min Heap from Scratch

**Problem**: Implement a min-heap with `insert`, `extractMin`, `peek`, `size`, and `heapify` (build from array).

**Solution**:

```java
class MinHeap {
    private int[] heap;
    private int size;
    private int capacity;

    public MinHeap(int capacity) {
        this.capacity = capacity;
        this.heap = new int[capacity];
        this.size = 0;
    }

    // Build heap from array — O(n)
    public MinHeap(int[] arr) {
        this.capacity = arr.length;
        this.heap = Arrays.copyOf(arr, arr.length);
        this.size = arr.length;
        // Heapify: sift down from last non-leaf to root
        for (int i = (size / 2) - 1; i >= 0; i--) {
            siftDown(i);
        }
    }

    public void insert(int val) {
        if (size == capacity) {
            capacity = capacity < 64 ? capacity * 2 + 2 : capacity + capacity / 2;
            heap = Arrays.copyOf(heap, capacity);
        }
        heap[size] = val;
        siftUp(size);
        size++;
    }

    public int extractMin() {
        if (size == 0) throw new NoSuchElementException("Heap is empty");
        int min = heap[0];
        heap[0] = heap[--size];
        if (size > 0) siftDown(0);
        return min;
    }

    public int peek() {
        if (size == 0) throw new NoSuchElementException("Heap is empty");
        return heap[0];
    }

    public int size() { return size; }
    public boolean isEmpty() { return size == 0; }

    private void siftUp(int i) {
        int val = heap[i];
        while (i > 0) {
            int parent = (i - 1) >>> 1;
            if (val >= heap[parent]) break;
            heap[i] = heap[parent];
            i = parent;
        }
        heap[i] = val;
    }

    private void siftDown(int i) {
        int val = heap[i];
        int half = size >>> 1;
        while (i < half) {
            int left = (i << 1) + 1;
            int right = left + 1;
            int smallest = left;
            if (right < size && heap[right] < heap[left]) {
                smallest = right;
            }
            if (val <= heap[smallest]) break;
            heap[i] = heap[smallest];
            i = smallest;
        }
        heap[i] = val;
    }
}
```

**Complexity**: insert O(log n), extractMin O(log n), peek O(1), heapify O(n).

**JVM Insight**: This uses a primitive `int[]` — no boxing, no `Integer` objects, no autoboxing overhead. Each element costs exactly 4 bytes vs 16 bytes for a boxed `Integer` in `PriorityQueue`. For a heap of 1 million elements: 4 MB vs ~16 MB (plus the Object[] reference array in PQ). The `siftUp` and `siftDown` methods save the target value and only do single assignments per level instead of full swaps — this is the same optimization OpenJDK uses.

**Real-World**: Production systems that need maximum throughput (financial trading, game engines) often implement custom primitive heaps to avoid boxing overhead. **Chronicle Queue** and similar low-latency libraries take this approach.

---

**P6.38** [M] — Implement Max Priority Queue

**Problem**: Implement a max priority queue with `insert`, `extractMax`, `peekMax`, `increaseKey`, and `delete`.

**Solution**:

```java
class MaxPriorityQueue {
    private int[] heap;
    private int size;
    // Map from value to its index in the heap (for increaseKey/delete)
    // In a real system, you would use a handle or token instead
    private Map<Integer, Integer> indexMap;

    public MaxPriorityQueue(int capacity) {
        heap = new int[capacity];
        size = 0;
        indexMap = new HashMap<>();
    }

    public void insert(int val) {
        if (size == heap.length) {
            heap = Arrays.copyOf(heap, heap.length * 2);
        }
        heap[size] = val;
        indexMap.put(val, size);
        siftUp(size);
        size++;
    }

    public int extractMax() {
        if (size == 0) throw new NoSuchElementException();
        int max = heap[0];
        indexMap.remove(max);
        size--;
        if (size > 0) {
            heap[0] = heap[size];
            indexMap.put(heap[0], 0);
            siftDown(0);
        }
        return max;
    }

    public int peekMax() {
        if (size == 0) throw new NoSuchElementException();
        return heap[0];
    }

    // Increase the value of an element (must increase, not decrease)
    public void increaseKey(int oldVal, int newVal) {
        if (newVal < oldVal) throw new IllegalArgumentException("New value must be larger");
        Integer idx = indexMap.get(oldVal);
        if (idx == null) throw new NoSuchElementException();
        indexMap.remove(oldVal);
        heap[idx] = newVal;
        indexMap.put(newVal, idx);
        siftUp(idx);  // value increased → might need to go up
    }

    public void delete(int val) {
        Integer idx = indexMap.get(val);
        if (idx == null) throw new NoSuchElementException();
        indexMap.remove(val);
        size--;
        if (idx == size) return;  // was the last element
        heap[idx] = heap[size];
        indexMap.put(heap[idx], idx);
        // Might need to go up or down
        siftUp(idx);
        siftDown(idx);
    }

    private void siftUp(int i) {
        int val = heap[i];
        while (i > 0) {
            int parent = (i - 1) >>> 1;
            if (val <= heap[parent]) break;
            heap[i] = heap[parent];
            indexMap.put(heap[parent], i);
            i = parent;
        }
        heap[i] = val;
        indexMap.put(val, i);
    }

    private void siftDown(int i) {
        int val = heap[i];
        int half = size >>> 1;
        while (i < half) {
            int left = (i << 1) + 1;
            int right = left + 1;
            int largest = left;
            if (right < size && heap[right] > heap[left]) {
                largest = right;
            }
            if (val >= heap[largest]) break;
            heap[i] = heap[largest];
            indexMap.put(heap[largest], i);
            i = largest;
        }
        heap[i] = val;
        indexMap.put(val, i);
    }
}
```

**Complexity**: All operations O(log n) except peekMax O(1). `increaseKey` and `delete` require the index map for O(1) lookup.

**JVM Insight**: The `indexMap` adds O(n) space overhead and each sift operation updates the map — this is the cost of supporting `increaseKey` and `delete`. In algorithms like Dijkstra where `decreaseKey` is needed, this indexed priority queue approach is essential. Java's `PriorityQueue` does NOT support efficient `decreaseKey` — `remove(Object)` is O(n) because it does a linear scan.

**Real-World**: Dijkstra's algorithm with a Fibonacci heap achieves O(V log V + E) amortized time because `decreaseKey` is O(1) amortized. With a binary heap and index map, `decreaseKey` is O(log V), giving O((V+E) log V). For sparse graphs (E ~ V), the binary heap is fast enough. For dense graphs (E ~ V^2), Fibonacci heap wins asymptotically but has worse constant factors.

---

**P6.39** [M] — Implement Circular Buffer

**Problem**: Implement a generic circular buffer (ring buffer) with `write`, `read`, `peek`, `isFull`, `isEmpty`, `size`, and `capacity`.

**Solution**:

```java
class CircularBuffer<E> {
    private final Object[] buffer;
    private int head;   // points to the next read position
    private int tail;   // points to the next write position
    private int count;
    private final int capacity;

    public CircularBuffer(int capacity) {
        this.capacity = capacity;
        this.buffer = new Object[capacity];
        this.head = 0;
        this.tail = 0;
        this.count = 0;
    }

    public boolean write(E item) {
        if (isFull()) return false;
        buffer[tail] = item;
        tail = (tail + 1) % capacity;
        count++;
        return true;
    }

    // Overwrite mode: if full, overwrite oldest element
    public void writeOverwrite(E item) {
        if (isFull()) {
            head = (head + 1) % capacity;  // discard oldest
            count--;
        }
        buffer[tail] = item;
        tail = (tail + 1) % capacity;
        count++;
    }

    @SuppressWarnings("unchecked")
    public E read() {
        if (isEmpty()) return null;
        E item = (E) buffer[head];
        buffer[head] = null;  // help GC
        head = (head + 1) % capacity;
        count--;
        return item;
    }

    @SuppressWarnings("unchecked")
    public E peek() {
        return isEmpty() ? null : (E) buffer[head];
    }

    public boolean isFull() { return count == capacity; }
    public boolean isEmpty() { return count == 0; }
    public int size() { return count; }
    public int capacity() { return capacity; }

    // Snapshot of current contents in order
    @SuppressWarnings("unchecked")
    public Object[] toArray() {
        Object[] result = new Object[count];
        for (int i = 0; i < count; i++) {
            result[i] = buffer[(head + i) % capacity];
        }
        return result;
    }
}
```

**Complexity**: All operations O(1). `toArray` is O(n).

**JVM Insight**: The `writeOverwrite` method implements a lossy ring buffer — when full, the oldest element is silently discarded. This is the pattern used in logging systems (`java.util.logging` can be configured with a ring buffer handler) and metrics collection. Setting `buffer[head] = null` prevents memory leaks from stale references — without this, the buffer would hold strong references to objects the caller expects to have been garbage collected.

**Real-World**: **LMAX Disruptor**: The Disruptor's ring buffer is this exact structure but uses a sequence counter (monotonically increasing long) instead of head/tail pointers, and padding to prevent false sharing between producer and consumer sequences. **Linux kfifo**: The kernel's FIFO ring buffer uses power-of-2 sizes with bitmask wrap-around and lock-free single-producer/single-consumer semantics. **Log4j AsyncAppender**: Uses a ring buffer to decouple logging from the application thread.

---

### Additional Problems

---

**P6.40** [E] — Last Stone Weight

**Problem**: Each turn, take the two heaviest stones and smash them. If equal, both destroyed. If not, the lighter is destroyed and the heavier has weight reduced by the lighter. Return the weight of the last stone (or 0).

**Solution**:

```java
public int lastStoneWeight(int[] stones) {
    PriorityQueue<Integer> maxHeap = new PriorityQueue<>(Collections.reverseOrder());
    for (int s : stones) maxHeap.offer(s);

    while (maxHeap.size() > 1) {
        int first = maxHeap.poll();
        int second = maxHeap.poll();
        if (first != second) {
            maxHeap.offer(first - second);
        }
    }
    return maxHeap.isEmpty() ? 0 : maxHeap.poll();
}
```

**Complexity**: O(n log n) time, O(n) space.

**JVM Insight**: Each `poll`/`offer` is O(log n), and we do at most n-1 rounds, so total is O(n log n). The `Collections.reverseOrder()` returns a singleton comparator — no new object is created each time you call it.

**Real-World**: **Resource conflict resolution** — when two processes contend for the same resource, the "heavier" (higher priority) one wins and proceeds with reduced capacity. Similar to **bandwidth allocation** in QoS systems.

---

**P6.41** [E] — Implement Stack with Linked List

**Problem**: Implement a stack using a singly linked list.

**Solution**:

```java
class LinkedStack<E> {
    private static class Node<E> {
        E val;
        Node<E> next;
        Node(E val, Node<E> next) { this.val = val; this.next = next; }
    }

    private Node<E> top;
    private int size;

    public void push(E val) {
        top = new Node<>(val, top);
        size++;
    }

    public E pop() {
        if (top == null) throw new NoSuchElementException();
        E val = top.val;
        top = top.next;
        size--;
        return val;
    }

    public E peek() {
        if (top == null) throw new NoSuchElementException();
        return top.val;
    }

    public boolean isEmpty() { return top == null; }
    public int size() { return size; }
}
```

**Complexity**: All operations O(1).

**JVM Insight**: Each `push` creates a new `Node` object (32 bytes: 16 header + 4 val ref + 4 next ref + 8 padding). For 1M pushes, that is 32 MB of node objects. Compare to `ArrayDeque` which would use ~4 MB (one array of references). The linked approach has one advantage: no resizing pauses. Every operation takes exactly the same time — important for real-time systems where worst-case latency matters more than average throughput.

**Real-World**: **Lock-free stacks** (Treiber stack) use this linked structure with CAS on the top pointer for thread-safe concurrent access. `java.util.concurrent` uses variations of this pattern internally.

---

**P6.42** [E] — Backspace String Compare

**Problem**: Given two strings with `#` representing backspace, determine if they are equal after processing.

**Solution**:

```java
// O(1) space: process from the end
public boolean backspaceCompare(String s, String t) {
    int i = s.length() - 1, j = t.length() - 1;

    while (i >= 0 || j >= 0) {
        i = nextValidChar(s, i);
        j = nextValidChar(t, j);

        if (i >= 0 && j >= 0) {
            if (s.charAt(i) != t.charAt(j)) return false;
        } else if (i >= 0 || j >= 0) {
            return false;  // one has chars remaining, the other does not
        }
        i--; j--;
    }
    return true;
}

private int nextValidChar(String str, int idx) {
    int skip = 0;
    while (idx >= 0) {
        if (str.charAt(idx) == '#') { skip++; idx--; }
        else if (skip > 0) { skip--; idx--; }
        else break;
    }
    return idx;
}
```

**Complexity**: O(n + m) time, O(1) space.

**JVM Insight**: The O(1) space solution processes strings from right to left, tracking backspace count. A stack-based approach would use O(n) space but is simpler to implement. The right-to-left approach is a good demonstration of converting stack-based logic to constant space by reversing the traversal direction.

**Real-World**: **Terminal emulator input processing** — every terminal handles backspace in the input buffer. **Text editor buffer management** — undo (backspace) is processed in real-time on the input stream.

---

**P6.43** [E] — Next Greater Element III

**Problem**: Given a positive integer `n`, find the smallest integer which has exactly the same digits and is greater than `n`. Return -1 if no such integer exists or if the result exceeds 32-bit int range.

**Solution**:

```java
public int nextGreaterElement(int n) {
    char[] digits = String.valueOf(n).toCharArray();
    int len = digits.length;

    // Step 1: Find the first digit from the right that is smaller than its successor
    int i = len - 2;
    while (i >= 0 && digits[i] >= digits[i + 1]) i--;
    if (i < 0) return -1;  // digits are in descending order — no larger permutation

    // Step 2: Find the smallest digit to the right of i that is larger than digits[i]
    int j = len - 1;
    while (digits[j] <= digits[i]) j--;
    swap(digits, i, j);

    // Step 3: Reverse the suffix from i+1 to end
    reverse(digits, i + 1, len - 1);

    // Step 4: Check for 32-bit overflow
    long result = Long.parseLong(new String(digits));
    return result > Integer.MAX_VALUE ? -1 : (int) result;
}

private void swap(char[] arr, int i, int j) {
    char t = arr[i]; arr[i] = arr[j]; arr[j] = t;
}

private void reverse(char[] arr, int lo, int hi) {
    while (lo < hi) { swap(arr, lo++, hi--); }
}
```

**Complexity**: O(d) time where d = number of digits.

**JVM Insight**: This is the "next permutation" algorithm applied to digits. We convert to `char[]` via `String.valueOf(n).toCharArray()` — this creates two objects (the String and the char array). For a single-use computation, this allocation is negligible. The `Long.parseLong` check at the end guards against 32-bit overflow.

**Real-World**: **Version number generation** — finding the next valid version given constraints. **Lexicographic ordering** in database indexes and B+ tree key comparisons use the same next-permutation logic.

---

**P6.44** [H] — Maximum Frequency Stack

**Problem**: Design a stack that pushes elements and pops the most frequent element. If tied, pop the most recently pushed.

**Solution**:

```java
class FreqStack {
    private final Map<Integer, Integer> freq;
    private final Map<Integer, Deque<Integer>> groupByFreq;
    private int maxFreq;

    public FreqStack() {
        freq = new HashMap<>();
        groupByFreq = new HashMap<>();
        maxFreq = 0;
    }

    public void push(int val) {
        int f = freq.merge(val, 1, Integer::sum);
        maxFreq = Math.max(maxFreq, f);
        groupByFreq.computeIfAbsent(f, k -> new ArrayDeque<>()).push(val);
    }

    public int pop() {
        Deque<Integer> stack = groupByFreq.get(maxFreq);
        int val = stack.pop();
        if (stack.isEmpty()) {
            groupByFreq.remove(maxFreq);
            maxFreq--;
        }
        freq.merge(val, -1, Integer::sum);
        return val;
    }
}
```

**Complexity**: O(1) for both push and pop.

**JVM Insight**: The `groupByFreq` map stores a stack for each frequency level. When we push element `x` with current frequency `f`, it appears in stacks for frequencies 1, 2, ..., f. When we pop, we take from the `maxFreq` stack — which is the most recent push among elements with the highest frequency. The `merge` method with `Integer::sum` avoids `getOrDefault` + `put` boilerplate.

**Real-World**: **LFU cache eviction** — the least frequently used item is evicted first, with recency as tiebreaker. **CDN content prioritization** — the most frequently accessed content stays in cache with the most recent version preferred when frequency ties.

---

**P6.45** [H] — Maximum Score of a Good Subarray

**Problem**: Given an array `nums` and index `k`, find the maximum score of a "good" subarray `[i..j]` where `i <= k <= j`. The score is `min(nums[i..j]) * (j - i + 1)`.

**Solution**:

```java
// Monotonic stack approach: similar to largest rectangle in histogram
public int maximumScore(int[] nums, int k) {
    int n = nums.length;

    // Find the nearest smaller element to the left and right of each index
    int[] left = new int[n];   // left[i] = index of nearest smaller element to the left (-1 if none)
    int[] right = new int[n];  // right[i] = index of nearest smaller element to the right (n if none)
    Deque<Integer> stack = new ArrayDeque<>();

    // Left boundaries
    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && nums[stack.peek()] >= nums[i]) stack.pop();
        left[i] = stack.isEmpty() ? -1 : stack.peek();
        stack.push(i);
    }

    stack.clear();

    // Right boundaries
    for (int i = n - 1; i >= 0; i--) {
        while (!stack.isEmpty() && nums[stack.peek()] >= nums[i]) stack.pop();
        right[i] = stack.isEmpty() ? n : stack.peek();
        stack.push(i);
    }

    int maxScore = 0;
    for (int i = 0; i < n; i++) {
        // nums[i] is the minimum in range (left[i], right[i])
        // Check if k falls within this range
        if (left[i] < k && right[i] > k) {
            int width = right[i] - left[i] - 1;
            maxScore = Math.max(maxScore, nums[i] * width);
        }
    }
    return maxScore;
}

// Two-pointer greedy approach: expand from k
public int maximumScoreGreedy(int[] nums, int k) {
    int n = nums.length;
    int i = k, j = k;
    int minVal = nums[k];
    int maxScore = minVal;

    while (i > 0 || j < n - 1) {
        // Expand toward the side with the larger boundary element
        int leftVal = (i > 0) ? nums[i - 1] : 0;
        int rightVal = (j < n - 1) ? nums[j + 1] : 0;

        if (leftVal >= rightVal) {
            i--;
            minVal = Math.min(minVal, nums[i]);
        } else {
            j++;
            minVal = Math.min(minVal, nums[j]);
        }
        maxScore = Math.max(maxScore, minVal * (j - i + 1));
    }
    return maxScore;
}
```

**Complexity**: Both approaches O(n) time, O(n) space for stack approach, O(1) for greedy.

**JVM Insight**: The stack approach computes left/right boundaries for ALL elements — reusable if you need to answer multiple queries. The greedy approach is more space-efficient but answers only one specific query (centered at k). The stack approach creates two `int[]` arrays — with primitive types, no boxing overhead.

**Real-World**: **Quality-of-service optimization** — maximizing the product of throughput (width) and minimum service quality (height) over a time window. Network SLA compliance monitoring uses similar metrics.

---

## Key Takeaways

1. **PriorityQueue is an array-backed binary heap**: No nodes, no pointers, no cache misses. Parent/child navigation is pure arithmetic: `parent = (i-1)/2`, `leftChild = 2i+1`, `rightChild = 2i+2`. The array representation works because a complete binary tree has no gaps — every slot is occupied.

2. **Heapify is O(n), not O(n log n)**: The mathematical proof shows that the sum of heights across all nodes converges to 2n. Most nodes are leaves that require zero work. Always prefer `new PriorityQueue<>(collection)` over repeated `offer()` when you have all elements upfront — it saves a factor of log n.

3. **ArrayDeque is the universal tool**: Use it as a stack (`push/pop/peek`), as a queue (`offerLast/pollFirst`), or as a deque. It beats `LinkedList` by 3-5x for queue operations due to contiguous memory, no node objects, and CPU cache prefetching. The power-of-2 sizing enables `& (length - 1)` wrap-around — a single CPU instruction vs. expensive integer division for modulo.

4. **Never use `Stack<E>`**: It extends `Vector` (synchronized, allows random access, wrong iteration order). Use `ArrayDeque` instead. The `Deque` interface properly hides random access, and the lack of synchronization is correct for the 99% case.

5. **The `(a, b) -> b - a` comparator overflows**: For max-heap, use `Collections.reverseOrder()` or `(a, b) -> Integer.compare(b, a)`. Subtraction-based comparators produce wrong results when the difference exceeds `Integer.MAX_VALUE`. This has caused production bugs in shortest-path algorithms.

6. **Two heaps solve streaming median in O(1) query time**: A max-heap for the lower half and min-heap for the upper half. Balance sizes within 1. The median is always at one or both roots. This pattern extends to any streaming percentile computation.

7. **Monotonic stacks solve "next greater/smaller element" in O(n)**: Each element is pushed once and popped once. The key insight: when a new element arrives, it renders smaller/larger stack elements irrelevant for future queries. The same principle powers histogram rectangle, trapping water, and stock span problems.

8. **Circular buffers are everywhere**: TCP send/receive buffers, Kafka log segments, LMAX Disruptor, Linux `io_uring`, and `ArrayDeque` all use the same head/tail/wrap-around pattern. Power-of-2 sizing with bitmask wrap-around is the canonical implementation. Understanding this one pattern unlocks understanding of half the systems software you have ever used.

9. **BFS with a queue solves shortest-path in unweighted graphs**: Multi-source BFS (start from all sources simultaneously) computes distances from every cell to its nearest source in O(V + E). This is the standard approach for flood-fill, fire spread, and network distance computation problems.

10. **The JVM call stack is a real stack with real limits**: Default 512KB-1MB per thread. Deep recursion (>10K frames) overflows it. Convert to iterative with an explicit `ArrayDeque` for any recursion that might be deep. This is not an optimization — it is a correctness requirement for production code processing large inputs.

---

| Previous | Index | Next |
|----------|-------|------|
| [Chapter 5: Trees & Sorted Structures](05-trees-and-sorted-structures.md) | [Index](00-index.md) | [Chapter 7: Concurrent Collections](07-concurrent-collections.md) |
