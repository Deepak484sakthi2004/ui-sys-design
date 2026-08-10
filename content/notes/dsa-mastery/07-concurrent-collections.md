# Chapter 7: Concurrent Collections

## The War Room Between Threads

Every data structure we have dissected so far assumed a single thread of execution. One reader, one writer, one reality. That is a fantasy. The moment two threads touch the same `HashMap`, the moment one thread writes to an `ArrayList` while another reads from it, you leave the deterministic world and enter a domain governed by hardware store buffers, CPU cache coherence protocols, and the Java Memory Model's carefully drafted rules about what one thread is guaranteed to see of another's writes.

I have debugged production incidents where a `HashMap` resized under concurrent writes and produced an infinite loop in `get()` (JDK 7's linked list cycle during rehash). I have seen a `CopyOnWriteArrayList` used for a write-heavy event log, consuming 12 GB of RAM from copied arrays piling up before GC could reclaim them. I have witnessed a perfectly correct algorithm fail in production because a developer assumed that if Thread A writes a field before Thread B reads it, Thread B will see the write. Without a happens-before edge, that assumption is provably false.

This chapter dissects the concurrent collections in `java.util.concurrent` at the implementation level. We will walk through the actual source code of `ConcurrentHashMap.put()`, examine exactly how `CopyOnWriteArrayList` achieves lock-free reads, understand why `ConcurrentSkipListMap` uses probabilistic balancing, and compare every `BlockingQueue` implementation at the lock and condition variable level. When you finish this chapter, you will not just know which concurrent collection to use. You will know exactly what the CPU is doing when you call their methods.

---

## 7.1 Java Memory Model Primer

Before we can understand concurrent collections, we must understand the rules that govern how threads see each other's writes. The Java Memory Model (JMM), defined in JSR-133 and codified in Chapter 17.4 of the Java Language Specification, does not promise sequential consistency. It promises something weaker, more precisely defined, and absolutely essential to understand: the **happens-before** relationship.

### 7.1.1 Happens-Before Relationships

The happens-before relationship is a partial order over actions in a Java program. If action A happens-before action B, then the effects of A are guaranteed to be visible to B. If there is no happens-before edge between two actions, the JVM, the JIT compiler, and the CPU are all free to reorder them, delay them, or make them invisible to each other.

The key happens-before rules:

```
Rule 1: Program Order
  Within a single thread, every action happens-before the next action
  in program order. (This seems obvious, but it only constrains
  visibility to OTHER threads if combined with another rule.)

Rule 2: Monitor Lock
  An unlock on monitor M happens-before every subsequent lock on M.

  Thread A:                    Thread B:
  synchronized(lock) {         synchronized(lock) {
      x = 42;       ──HB──►       int r = x;  // guaranteed to see 42
  }                            }

Rule 3: Volatile Variable
  A write to a volatile field happens-before every subsequent read
  of that volatile field.

  volatile boolean ready;
  Thread A:                    Thread B:
  x = 42;                     if (ready) {          // volatile read
  ready = true;  ──HB──►          int r = x;        // guaranteed to see 42
                               }

  NOTE: The volatile write of ready also makes the non-volatile write
  of x visible. This is called "piggybacking" on volatile.

Rule 4: Thread Start
  A call to Thread.start() happens-before any action in the started thread.

  x = 42;
  thread.start();   ──HB──►   // thread's run() sees x == 42

Rule 5: Thread Join
  All actions in a thread happen-before the return from Thread.join()
  on that thread.

  // Inside thread: x = 42;
  thread.join();   ──HB──►   int r = x;  // guaranteed to see 42

Rule 6: Transitivity
  If A happens-before B, and B happens-before C, then A happens-before C.
  This is how volatile piggybacking works: A writes x, then volatile-writes
  ready. The volatile read of ready happens-before read of x. By transitivity,
  write of x happens-before read of x.
```

### 7.1.2 Memory Barriers

The JMM is an abstraction. The CPU implements it through memory barriers (also called memory fences). These are hardware instructions that constrain the reordering of memory operations.

```
Barrier Type    Prevents This Reordering               Cost
────────────────────────────────────────────────────────────
LoadLoad        Load1; LoadLoad; Load2                  Low
                Ensures Load1 completes before Load2
                starts. On x86: free (x86 does not
                reorder loads with loads).

StoreStore      Store1; StoreStore; Store2              Low
                Ensures Store1 is visible before Store2.
                On x86: free (x86 does not reorder
                stores with stores).

LoadStore       Load1; LoadStore; Store2                Low
                Ensures Load1 completes before Store2
                is visible. On x86: free.

StoreLoad       Store1; StoreLoad; Load2                EXPENSIVE
                Ensures Store1 is visible to all CPUs
                before Load2 executes. On x86: this is
                the ONLY barrier that costs something.
                Implemented as MFENCE or LOCK prefix.
                Cost: ~20-100 cycles.
```

Why x86 gets away with cheap barriers: the x86 memory model is **Total Store Order (TSO)**, which is stricter than the JMM. The only reordering x86 allows is a store followed by a load to a *different* address (the store buffer hides the store, and the load proceeds before the store drains). A `StoreLoad` barrier (MFENCE) forces the store buffer to drain.

How Java operations map to barriers:

```
Java Operation           Barriers Emitted (x86)
────────────────────────────────────────────────
volatile read            [LoadLoad + LoadStore after read]
                         On x86: no barrier (free)

volatile write           [StoreStore before write] +
                         [StoreLoad after write]
                         On x86: LOCK addl $0, (%rsp)
                         or MFENCE after the write

synchronized enter       [LoadLoad + LoadStore]
                         On x86: no barrier (acquire is free)

synchronized exit        [StoreLoad]
                         On x86: LOCK addl $0, (%rsp)
                         equivalent to MFENCE

CAS (compareAndSwap)     Full barrier (implicit LOCK prefix)
                         On x86: LOCK cmpxchg
```

### 7.1.3 Volatile: Visibility Without Atomicity

`volatile` gives you two guarantees:
1. **Visibility**: A write to a volatile variable is immediately visible to all threads.
2. **Ordering**: Reads and writes to volatile variables cannot be reordered with respect to other memory operations (the barriers enforce this).

What `volatile` does NOT give you: **atomicity of compound operations**.

```java
volatile int counter = 0;

// Thread A and Thread B both do:
counter++;

// counter++ is NOT atomic. It is three operations:
// 1. READ counter (volatile read — sees latest value)
// 2. INCREMENT (local CPU operation)
// 3. WRITE counter (volatile write — publishes new value)
//
// Race condition:
// Thread A: READ counter → 0
// Thread B: READ counter → 0    (before A writes!)
// Thread A: WRITE counter → 1
// Thread B: WRITE counter → 1   (should be 2, but it is 1)
//
// Fix: use AtomicInteger.incrementAndGet() which does CAS in a loop.
```

### 7.1.4 Why This Matters for Data Structures

Without proper synchronization, one thread's structural modifications to a data structure can be completely invisible to another thread.

```java
// BROKEN — no happens-before between put and get
HashMap<String, String> map = new HashMap<>();

// Thread A:
map.put("key", "value");

// Thread B (started after Thread A's put, but no HB edge):
String v = map.get("key");  // v might be null!

// Why? HashMap.put() modifies:
// 1. The Node[] table reference (if first put triggers lazy init)
// 2. The Node at table[hash & (capacity-1)]
// 3. The size field
// Without a happens-before edge, Thread B might see:
// - A stale null table reference (put never happened from B's view)
// - A partially constructed Node (key set but value still null)
// - The old table before resize but the new size after resize
//
// On x86, you might "get lucky" because TSO is relatively strict.
// On ARM or POWER, you will absolutely see these anomalies.
// But even on x86, the JIT compiler can reorder operations,
// so relying on hardware ordering without JMM guarantees is a bug.
```

This is the fundamental reason concurrent collections exist. They internalize the synchronization so that you do not have to reason about memory barriers every time you call `put()` or `get()`.

---

## 7.2 ConcurrentHashMap Deep Dive (JDK 8+ Implementation)

`ConcurrentHashMap` is the workhorse of concurrent Java. It appears in Spring's bean registry, Hibernate's second-level cache, Netty's channel attribute map, and virtually every web server's session storage. Understanding its implementation is non-negotiable for senior-level interviews.

### 7.2.1 Architecture: JDK 7 vs JDK 8+

**JDK 7**: `Segment[]` array where each `Segment` is a separate `ReentrantLock` guarding a sub-hash-table. Default 16 segments. Concurrency was limited to the number of segments — at most 16 threads could write simultaneously.

**JDK 8+**: Complete rewrite. No more segments. The internal structure is:

```
ConcurrentHashMap<K,V>
├── volatile Node<K,V>[] table         // the hash bins
├── volatile Node<K,V>[] nextTable     // used during resize
├── volatile long baseCount            // base counter for size()
├── volatile int sizeCtl               // controls init & resize
├── volatile int transferIndex         // progress indicator for resize
└── volatile CounterCell[] counterCells // striped counter cells

Node<K,V>:
├── final int hash
├── final K key
├── volatile V val      // volatile! Enables lock-free reads
└── volatile Node<K,V> next   // volatile! Lock-free traversal
```

Key insight: The `Node.val` and `Node.next` fields are `volatile`. This means any thread reading a node sees the most recent value and the most recent next pointer, without any locking. This is what enables lock-free `get()`.

### 7.2.2 The `sizeCtl` Field

This single `volatile int` field controls initialization and resizing. Its semantics are overloaded:

```
sizeCtl value          Meaning
────────────────────────────────────────────────
-1                     Table is being initialized
-(1 + nResizers)       Table is being resized; nResizers threads are helping
0                      Table not yet initialized (default)
> 0 (before init)      Initial capacity to use
> 0 (after init)       Next resize threshold (capacity * load factor)
```

The encoding for resize is more nuanced. During resize, `sizeCtl` is set to a negative value derived from the stamp of the old table size:

```java
// resizeStamp(n) returns the number of leading zeros of n, left-shifted
// This creates a unique stamp for each resize generation.
// The high 16 bits are the stamp, the low 16 bits are (1 + number of resizer threads).
int rs = resizeStamp(n) << RESIZE_STAMP_SHIFT;
// sizeCtl = rs + 2 means 1 thread resizing
// sizeCtl = rs + 3 means 2 threads resizing
// etc.
```

### 7.2.3 `put()` Walkthrough

Here is exactly what happens when you call `concurrentHashMap.put(key, value)`:

```java
public V put(K key, V value) {
    return putVal(key, value, false);
}

final V putVal(K key, V value, boolean onlyIfAbsent) {
    // Step 0: ConcurrentHashMap does NOT allow null keys or null values.
    // Unlike HashMap. This is because null is used as a sentinel
    // for "slot is empty" — if get() returns null, it unambiguously
    // means "key not found."
    if (key == null || value == null) throw new NullPointerException();

    // Step 1: Spread the hash.
    int hash = spread(key.hashCode());
    // spread() XORs the high 16 bits into the low 16 bits (same as HashMap)
    // AND masks out the sign bit (hash is always non-negative in CHM).
    // Negative hashes have special meaning: MOVED (-1), TREEBIN (-2).

    int binCount = 0;

    // Step 2: The main loop. We retry until we succeed.
    for (Node<K,V>[] tab = table;;) {
        Node<K,V> f; int n, i, fh;

        // Case A: Table not yet initialized.
        if (tab == null || (n = tab.length) == 0)
            tab = initTable();
            // initTable() uses CAS on sizeCtl to ensure only one
            // thread initializes the table. Others yield and spin.

        // Case B: Target bin is empty.
        else if ((f = tabAt(tab, i = (n - 1) & hash)) == null) {
            // CAS a new node into the empty bin.
            // tabAt() is Unsafe.getObjectVolatile(tab, offset)
            // casTabAt() is Unsafe.compareAndSwapObject(tab, offset, null, newNode)
            if (casTabAt(tab, i, null, new Node<K,V>(hash, key, value)))
                break;  // Success! CAS won. No locking needed.
            // If CAS fails, another thread beat us. Loop retries.
        }

        // Case C: The bin contains a ForwardingNode (hash == MOVED).
        // This means the table is being resized.
        else if ((fh = f.hash) == MOVED)
            tab = helpTransfer(tab, f);
            // THIS thread helps with the resize before retrying its put.
            // Cooperative resizing — brilliant design.

        // Case D: The bin is occupied with a normal node or tree.
        else {
            V oldVal = null;
            synchronized (f) {  // Lock ONLY the head node of this bin.
                // Double-check that f is still the head of the bin.
                // Another thread might have changed it between our read
                // and acquiring the lock.
                if (tabAt(tab, i) == f) {
                    if (fh >= 0) {
                        // Normal linked list bin.
                        binCount = 1;
                        for (Node<K,V> e = f;; ++binCount) {
                            K ek;
                            if (e.hash == hash &&
                                ((ek = e.key) == key ||
                                 (ek != null && key.equals(ek)))) {
                                // Key found — update value.
                                oldVal = e.val;
                                if (!onlyIfAbsent)
                                    e.val = value; // volatile write
                                break;
                            }
                            Node<K,V> pred = e;
                            if ((e = e.next) == null) {
                                // End of chain — append new node.
                                pred.next = new Node<>(hash, key, value);
                                break;
                            }
                        }
                    }
                    else if (f instanceof TreeBin) {
                        // Red-black tree bin.
                        Node<K,V> p;
                        binCount = 2; // signals tree
                        if ((p = ((TreeBin<K,V>)f).putTreeVal(
                                hash, key, value)) != null) {
                            oldVal = p.val;
                            if (!onlyIfAbsent)
                                p.val = value;
                        }
                    }
                }
            }
            // After releasing the lock:
            if (binCount != 0) {
                if (binCount >= TREEIFY_THRESHOLD) // 8
                    treeifyBin(tab, i);
                if (oldVal != null)
                    return oldVal;
                break;
            }
        }
    }
    addCount(1L, binCount);  // Update size counter
    return null;
}
```

The critical design choices:

1. **CAS for empty bins**: No locking overhead for the common case of inserting into an empty slot.
2. **synchronized on head node, not on a global lock or segment lock**: Granularity is per-bin. Two puts to different bins proceed with zero contention.
3. **Cooperative resizing**: Threads that encounter a `ForwardingNode` help with the resize instead of waiting. This distributes the resize cost across multiple threads.

### 7.2.4 Lock-Free `get()`

This is one of the most elegant designs in the JDK:

```java
public V get(Object key) {
    Node<K,V>[] tab; Node<K,V> e, p; int n, eh; K ek;
    int h = spread(key.hashCode());
    if ((tab = table) != null && (n = tab.length) > 0 &&
        (e = tabAt(tab, (n - 1) & h)) != null) {
        // tabAt() = Unsafe.getObjectVolatile — volatile read of the bin head
        if ((eh = e.hash) == h) {
            if ((ek = e.key) == key || (ek != null && key.equals(ek)))
                return e.val;  // volatile read of val
        }
        else if (eh < 0)
            // Special node: ForwardingNode (MOVED) or TreeBin
            return (p = e.find(h, key)) != null ? p.val : null;
        while ((e = e.next) != null) {  // volatile read of next
            if (e.hash == h &&
                ((ek = e.key) == key || (ek != null && key.equals(ek))))
                return e.val;  // volatile read
        }
    }
    return null;
}
```

**No locking. No CAS. No synchronization at all.**

Why is this safe?

1. `table` is `volatile` -- the read of `table` sees the latest array reference.
2. `tabAt()` uses `Unsafe.getObjectVolatile()` -- the read of the bin head is a volatile read.
3. `Node.val` is `volatile` -- the read of the value sees the latest write.
4. `Node.next` is `volatile` -- traversal of the chain sees the latest links.

Because all reads are volatile, and all writes (in `put()`) happen inside `synchronized` blocks (which emit a `StoreLoad` barrier on exit), there is a happens-before chain from every write to every subsequent read. The `get()` is guaranteed to see the result of any `put()` that completed before the `get()` started.

### 7.2.5 Concurrent Resize: The `transfer()` Method

When the table exceeds the load factor threshold, `ConcurrentHashMap` doubles the table size. Unlike `HashMap` which stops the world to rehash, `ConcurrentHashMap` allows multiple threads to cooperate:

```
Old Table (capacity N):
┌────┬────┬────┬────┬────┬────┬────┬────┐
│ FN │ FN │ FN │bin3│bin4│bin5│bin6│bin7│ ← FN = ForwardingNode (done)
└────┴────┴────┴────┴────┴────┴────┴────┘
                 ↑
          transferIndex = 3 (next batch to process)

New Table (capacity 2N):
┌────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┐
│ n0 │ n1 │ n2 │    │    │    │    │    │ n8 │ n9 │n10 │    │    │    │    │    │
└────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┘
  ↑ bins 0-2 have been moved to their new positions
```

The process:

1. **Thread T1** calls `put()`, sees the table needs resizing, and begins `transfer()`.
2. T1 claims a chunk of bins to transfer (typically 16 bins at a time) by CAS-decrementing `transferIndex`.
3. For each bin in the chunk, T1 locks the head node (`synchronized`), splits the chain into two sub-chains (nodes that go to `bin[i]` and nodes that go to `bin[i + oldCapacity]` in the new table, determined by `hash & oldCapacity`), and replaces the old bin with a `ForwardingNode`.
4. **Thread T2** calls `put()` or `get()` and finds a `ForwardingNode`. For `get()`, the `ForwardingNode.find()` method redirects to the new table. For `put()`, T2 calls `helpTransfer()` and joins the resize effort.
5. Multiple threads process different chunks of bins concurrently.

The `ForwardingNode` is a special `Node` with `hash == MOVED (-1)` that holds a reference to the new table. When `get()` encounters it, it follows the reference to the new table and searches there.

### 7.2.6 Counting: LongAdder-Style Striped Counters

A single `AtomicLong` for the size would be a massive contention bottleneck. Instead, `ConcurrentHashMap` uses a scheme inspired by `LongAdder`:

```java
// Fields:
volatile long baseCount;
volatile CounterCell[] counterCells;

// CounterCell is annotated with @Contended to prevent false sharing:
@jdk.internal.vm.annotation.Contended
static final class CounterCell {
    volatile long value;
    CounterCell(long x) { value = x; }
}
```

How `addCount()` works:

```
1. Try CAS on baseCount.
   Success → done.
   Failure → contention detected → go to step 2.

2. Hash the current thread to pick a CounterCell.
   CAS the cell's value.
   Success → done.
   Failure → contention on that cell → try another cell or grow the array.

3. To compute size():
   return baseCount + sum(counterCells[i].value for all i)
```

The `@Contended` annotation on `CounterCell` tells the JVM to pad the field to its own cache line (128 bytes of padding). Without this, adjacent `CounterCell` objects in the array would share cache lines, causing false sharing when different threads update adjacent cells.

This is why `size()` is not an O(1) field read — it is a summation across the counter cells. It is also why the count may be slightly stale under concurrent modification. This is acceptable because in a concurrent map, an "exact" size is meaningless — it could change before you act on it.

### 7.2.7 Treeification in ConcurrentHashMap

Like `HashMap`, bins with 8 or more nodes convert to red-black trees. But `ConcurrentHashMap` cannot use the same `TreeNode` structure because it needs concurrent read/write access to the tree.

The solution: `TreeBin`, a wrapper that holds the root of the red-black tree and implements a read-write lock:

```java
static final class TreeBin<K,V> extends Node<K,V> {
    TreeNode<K,V> root;
    volatile TreeNode<K,V> first;  // head of the linked list (maintained alongside tree)
    volatile int waiter;
    volatile int lockState;
    // lockState bits:
    // WRITER  = 1 (exclusive write lock held)
    // WAITER  = 2 (a thread is waiting for write lock)
    // READER  = 4 (increment for each reader)
}
```

**Why not use `ReentrantReadWriteLock`?** Because `TreeBin`'s lock is lighter weight. It uses CAS on the `lockState` field and `LockSupport.park/unpark` for waiting. No need for a full `AbstractQueuedSynchronizer`. Also, read operations on `TreeBin` fall back to the maintained linked list (the `first` chain) if a writer holds the lock, avoiding reader starvation.

### 7.2.8 Atomic Compound Operations

`ConcurrentHashMap` provides methods that perform check-and-act atomically:

```java
// computeIfAbsent: atomic check-then-insert
cache.computeIfAbsent(key, k -> expensiveComputation(k));
// The lambda runs while the bin is locked. No two threads will
// compute for the same key simultaneously.
// WARNING: Do NOT call other CHM operations inside the lambda — deadlock risk.

// compute: atomic read-modify-write
map.compute(key, (k, v) -> v == null ? 1 : v + 1);
// Atomic increment. The remapping function runs under the bin lock.

// merge: atomic merge with existing value
map.merge(key, 1, Integer::sum);
// If key absent: put(key, 1). If key present: put(key, oldVal + 1). Atomic.

// putIfAbsent: simple conditional put
map.putIfAbsent(key, value);
// Only puts if key is not already present. Returns existing value or null.
```

These are essential for building concurrent caches, counters, and accumulators without external synchronization. The `compute*` and `merge` methods run the lambda under the bin lock, so the entire operation is atomic with respect to other operations on the same key.

### 7.2.9 Bulk Operations (Java 8+)

`ConcurrentHashMap` provides parallel bulk operations with a `parallelismThreshold` parameter:

```java
// forEach with parallelism
map.forEach(10_000, (k, v) -> process(k, v));
// If map.size() > 10_000, the operation runs in parallel using ForkJoinPool.
// If threshold is Long.MAX_VALUE, runs sequentially.
// If threshold is 1, maximum parallelism.

// reduce
int sum = map.reduceValuesToInt(10_000, v -> v.getCount(), 0, Integer::sum);

// search (short-circuits on first non-null result)
String found = map.search(10_000, (k, v) -> v.matches(pattern) ? k : null);
```

These use `ForkJoinPool.commonPool()` internally and split the table into sub-ranges that different threads process.

---

## 7.3 CopyOnWriteArrayList

`CopyOnWriteArrayList` takes the opposite approach from `ConcurrentHashMap`. Instead of fine-grained locking, it makes reads completely lock-free by ensuring that the underlying array is **never modified in place**. Every write creates a new copy.

### 7.3.1 Internal Structure

```java
public class CopyOnWriteArrayList<E> implements List<E> {
    // The lock protects all mutative operations
    final transient Object lock = new Object();

    // The array — volatile so reads see the latest version
    private transient volatile Object[] array;

    final Object[] getArray() { return array; }
    final void setArray(Object[] a) { array = a; }
}
```

The entire state is a single `volatile Object[]` reference. This is the key insight: swapping an array reference is an atomic operation (it is a single pointer write), so readers always see either the old array or the new array, never a partially modified array.

### 7.3.2 Read Operations

```java
public E get(int index) {
    return elementAt(getArray(), index);
}

// getArray() is just: return array;
// This is a volatile read — sees the latest array reference.
// Then elementAt() reads from the array — no locking, no copying.
```

Reads are pure volatile reads. No `synchronized`, no `ReentrantLock`, no CAS. On x86, a volatile read is a plain memory read (no barrier needed due to TSO). This makes reads essentially free.

### 7.3.3 Write Operations

```java
public boolean add(E e) {
    synchronized (lock) {  // Exclusive lock for all writes
        Object[] es = getArray();
        int len = es.length;
        // Step 1: Copy the entire array, one element longer
        es = Arrays.copyOf(es, len + 1);
        // Step 2: Add the new element to the copy
        es[len] = e;
        // Step 3: Swap the reference (volatile write)
        setArray(es);
        return true;
    }
}

public E set(int index, E element) {
    synchronized (lock) {
        Object[] es = getArray();
        E oldValue = elementAt(es, index);
        if (oldValue != element) {
            // Copy the entire array even for a single element change
            es = es.clone();
            es[index] = element;
            setArray(es);  // volatile write
        }
        return oldValue;
    }
}
```

The write path:
1. Acquire the exclusive lock (only one writer at a time).
2. Copy the entire backing array.
3. Modify the copy.
4. Swap the `array` reference (volatile write makes the new array visible to all readers).
5. Release the lock.

The old array becomes eligible for GC once all threads holding references to it (including iterators) are done with it.

### 7.3.4 Iterator: Snapshot Semantics

```java
public Iterator<E> iterator() {
    return new COWIterator<E>(getArray(), 0);
}

static final class COWIterator<E> implements ListIterator<E> {
    private final Object[] snapshot;  // Captured at creation time
    private int cursor;

    COWIterator(Object[] es, int initialCursor) {
        cursor = initialCursor;
        snapshot = es;  // Just stores the reference — no copy!
    }

    public boolean hasNext() { return cursor < snapshot.length; }
    public E next() { return (E) snapshot[cursor++]; }
    // remove(), set(), add() all throw UnsupportedOperationException
}
```

The iterator captures the array reference at creation time. Since the array is never modified in place (any write creates a new array), the iterator is guaranteed to see a consistent snapshot. It will never throw `ConcurrentModificationException`.

This is fundamentally different from `ArrayList`'s iterator, which uses a `modCount` field and throws `ConcurrentModificationException` if the list is structurally modified during iteration. `CopyOnWriteArrayList` provides a stronger guarantee: you can iterate and write simultaneously without any exceptions, at the cost of the iterator not seeing concurrent modifications.

### 7.3.5 When to Use and When to Avoid

```
Use CopyOnWriteArrayList when:
  - Reads vastly outnumber writes (100:1 or better)
  - The list is small (hundreds of elements, not thousands)
  - You need safe iteration during concurrent modification
  - Examples: listener/observer lists (add listener once, fire events many times),
              routing tables (updated rarely, read on every request),
              configuration lists (loaded at startup, read by every thread)

Do NOT use when:
  - Writes are frequent (each write copies the entire array)
  - The list is large (copying 10,000 elements per write is expensive)
  - You need a concurrent queue (use BlockingQueue instead)
  - You need sorted iteration (use ConcurrentSkipListSet)

Memory impact:
  During a write, there are temporarily TWO copies of the array in memory.
  The old array cannot be GC'd until all iterators holding it are done.
  In a system with long-lived iterators and frequent writes, you can accumulate
  many old copies, leading to high memory pressure.
```

### 7.3.6 CopyOnWriteArraySet

`CopyOnWriteArraySet` is simply a `Set` backed by a `CopyOnWriteArrayList` with `addIfAbsent()`. It checks for duplicates by iterating the array (O(n) per `add()`). Only use for small sets.

---

## 7.4 ConcurrentSkipListMap

`ConcurrentSkipListMap` is the only concurrent sorted map in the JDK. It implements `NavigableMap` and `ConcurrentMap`. Where `ConcurrentHashMap` is a hash table, `ConcurrentSkipListMap` is based on a **skip list**, a probabilistic data structure that provides O(log n) expected time for search, insert, and delete.

### 7.4.1 Skip List Structure

A skip list is a layered set of linked lists. The bottom layer (level 0) contains all elements in sorted order. Each higher layer contains a subset of the elements, acting as an "express lane":

```
Level 3:  HEAD ──────────────────────────────────────► 50 ──────────────► NIL
Level 2:  HEAD ──────────► 20 ──────────────────────► 50 ──────────────► NIL
Level 1:  HEAD ──► 10 ──► 20 ──────────► 40 ────────► 50 ──► 60 ──────► NIL
Level 0:  HEAD ──► 10 ──► 20 ──► 25 ──► 40 ──► 45 ──► 50 ──► 60 ──► 70 ──► NIL
```

To search for 45:
1. Start at Level 3, HEAD. Next is 50. 50 > 45, so drop down.
2. Level 2, HEAD. Next is 20. 20 < 45, move right.
3. Level 2, 20. Next is 50. 50 > 45, so drop down.
4. Level 1, 20. Next is 40. 40 < 45, move right.
5. Level 1, 40. Next is 50. 50 > 45, so drop down.
6. Level 0, 40. Next is 45. Found!

We visited 6 nodes instead of scanning all 8 at level 0. For large lists, the savings are dramatic.

### 7.4.2 Probabilistic Balancing

When inserting a new node, the skip list determines its height randomly:

```java
private int randomLevel() {
    int level = 1;
    while (level < MAX_LEVEL && ThreadLocalRandom.current().nextBoolean())
        level++;
    return level;
}
// Each level has a 50% chance of being included.
// Expected height: 2 levels (geometric distribution)
// Probability of height h: (1/2)^h
// This gives O(log n) expected search/insert/delete.
```

This is called **probabilistic balancing**. Unlike a red-black tree, which deterministically maintains balance through rotations, a skip list is "balanced" in expectation through random height assignment. No rotations needed. No rebalancing after deletion. This simplicity is what makes it amenable to lock-free concurrent implementation.

### 7.4.3 Lock-Free CAS-Based Implementation

The JDK's `ConcurrentSkipListMap` is **lock-free**. It uses CAS operations on node references to insert and delete:

```
Insertion of key 35 (height 2):
1. Traverse the skip list to find insertion points at each level.
2. Create the new node with its forward pointers.
3. At level 0: CAS the predecessor's next pointer from the current successor to the new node.
4. At level 1: CAS the predecessor's next pointer.
5. If any CAS fails (another thread modified the same link), restart the operation.

Deletion of key 40:
1. Find the node.
2. Mark the node for deletion (CAS a special marker into its next pointer).
3. Then CAS the predecessor's next pointer to skip over the marked node.
4. The marked node is logically deleted but may still be physically linked.
   Subsequent traversals lazily unlink it.
```

The marking step is critical. It prevents another thread from inserting a node after the one being deleted between the "find" and "unlink" steps. The marker is a sentinel node inserted right after the node being deleted.

### 7.4.4 Comparison with ConcurrentHashMap

```
Feature                   ConcurrentHashMap    ConcurrentSkipListMap
──────────────────────────────────────────────────────────────────
Point query (get)         O(1) expected        O(log n)
Range query               Not supported        O(log n + k) for k results
Sorted iteration          Not supported        Built-in (NavigableMap)
headMap/tailMap/subMap     Not supported        Built-in
Insertion                 O(1) expected        O(log n)
Lock strategy             CAS + synchronized   Lock-free (CAS only)
Memory per entry          ~32 bytes            ~50-80 bytes (variable height)
Throughput (point ops)    Higher (3-5x)        Lower
Use case                  General purpose      Sorted concurrent access
```

### 7.4.5 Why Redis Uses Skip Lists

Redis uses skip lists for its Sorted Set (ZSET) type. The reasons align with `ConcurrentSkipListMap`'s properties:

1. **Range queries**: `ZRANGEBYSCORE`, `ZRANGEBYRANK` — O(log n + k). A hash table cannot do this.
2. **Simpler implementation than balanced BSTs**: No rotation code. Insertion and deletion are pointer manipulations at each level.
3. **Memory efficiency**: Each node has on average 1.33 pointers (at p=0.25 as Redis uses), compared to 2-3 for a balanced BST.
4. **Performance predictability**: Skip list operations have low variance in practice, even though the worst case is O(n).

---

## 7.5 BlockingQueue Implementations

`BlockingQueue` is the abstraction behind producer-consumer patterns. It adds blocking operations to `Queue`:

```
Method     Throws     Returns special value    Blocks          Times out
────────────────────────────────────────────────────────────────────────
Insert     add(e)     offer(e)                 put(e)          offer(e, time, unit)
Remove     remove()   poll()                   take()          poll(time, unit)
Examine    element()  peek()                   N/A             N/A
```

### 7.5.1 ArrayBlockingQueue

A bounded queue backed by a circular array with a single `ReentrantLock` and two `Condition` objects.

```java
public class ArrayBlockingQueue<E> extends AbstractQueue<E>
        implements BlockingQueue<E> {
    final Object[] items;          // the circular buffer
    int takeIndex;                 // index for next take/poll
    int putIndex;                  // index for next put/offer
    int count;                     // number of elements
    final ReentrantLock lock;      // single lock for ALL operations
    private final Condition notEmpty;  // awaited by take()
    private final Condition notFull;   // awaited by put()
}
```

```
Circular buffer visualization (capacity 8):
┌────┬────┬────┬────┬────┬────┬────┬────┐
│ A  │ B  │ C  │    │    │    │    │    │
└────┴────┴────┴────┴────┴────┴────┴────┘
  ↑ takeIndex           ↑ putIndex
count = 3

After take():
┌────┬────┬────┬────┬────┬────┬────┬────┐
│    │ B  │ C  │    │    │    │    │    │
└────┴────┴────┴────┴────┴────┴────┴────┘
       ↑ takeIndex      ↑ putIndex
count = 2, notFull.signal() wakes blocked producer

After put(D), put(E), ..., put(H) — wraps around:
┌────┬────┬────┬────┬────┬────┬────┬────┐
│ H  │ B  │ C  │ D  │ E  │ F  │ G  │    │
└────┴────┴────┴────┴────┴────┴────┴────┘
  ↑ putIndex  ↑ takeIndex
count = 7
```

**Limitation**: A single `ReentrantLock` means producers and consumers contend with each other. If a producer is inserting, a consumer must wait for the lock, and vice versa. This limits throughput under high contention.

### 7.5.2 LinkedBlockingQueue

An optionally bounded queue backed by a linked list with **two separate locks**:

```java
public class LinkedBlockingQueue<E> extends AbstractQueue<E>
        implements BlockingQueue<E> {
    private final int capacity;
    private final AtomicInteger count = new AtomicInteger();
    // Two separate locks for head and tail:
    private final ReentrantLock takeLock = new ReentrantLock();
    private final Condition notEmpty = takeLock.newCondition();
    private final ReentrantLock putLock = new ReentrantLock();
    private final Condition notFull = putLock.newCondition();
    // head is a dummy node; head.next is the actual first element
    transient Node<E> head;
    private transient Node<E> last;
}
```

The **two-lock** design is the key advantage over `ArrayBlockingQueue`:

```
Producer (putLock)              Consumer (takeLock)
─────────────────               ───────────────────
putLock.lock()                  takeLock.lock()
last.next = newNode             Node first = head.next
last = newNode                  head = first  (dequeue)
count.incrementAndGet()         count.decrementAndGet()
putLock.unlock()                takeLock.unlock()

Producers and consumers operate on different ends of the queue
with different locks → no contention between them!
```

The `AtomicInteger count` is shared between the two locks. It is updated with `incrementAndGet()` / `decrementAndGet()` (CAS-based), so no lock contention on the count field.

Default capacity is `Integer.MAX_VALUE` (effectively unbounded). If you do not specify a bound, `put()` never blocks, which can lead to memory exhaustion if the producer outpaces the consumer.

### 7.5.3 SynchronousQueue

A queue with **zero capacity**. It does not store elements at all. Every `put()` must wait for a corresponding `take()`, and vice versa. It is a direct hand-off mechanism.

```
Producer: put("X")  ──blocks──►  Consumer: take() returns "X"
                                 (Producer unblocks)

If no consumer is waiting:  Producer parks (blocks)
If no producer is waiting:  Consumer parks (blocks)
```

`SynchronousQueue` has two modes:
- **Fair mode** (FIFO): Waiting threads are matched in order. Backed by a queue.
- **Unfair mode** (LIFO, default): Most recent waiter is matched first. Backed by a stack. Higher throughput.

**Where it is used**: `Executors.newCachedThreadPool()` uses a `SynchronousQueue` as its work queue. When a task arrives:
1. If a thread is waiting (idle), hand the task directly to that thread.
2. If no thread is waiting, create a new thread.
This is why cached thread pools have zero queuing — tasks are never buffered.

### 7.5.4 PriorityBlockingQueue

An unbounded blocking priority queue backed by a binary heap:

```java
public class PriorityBlockingQueue<E> extends AbstractQueue<E>
        implements BlockingQueue<E> {
    private transient Object[] queue;  // the binary heap
    private transient int size;
    private final ReentrantLock lock;  // single lock
    private final Condition notEmpty;  // no notFull — queue is unbounded
    private transient volatile int allocationSpinLock; // CAS for array growth
}
```

Key behaviors:
- `put()` never blocks (unbounded — grows like `ArrayList`).
- `take()` blocks only when the queue is empty.
- Elements are dequeued in priority order (natural ordering or `Comparator`).
- Single lock means producers and consumers contend.
- Array growth uses a CAS spinlock to avoid blocking other operations during reallocation.

### 7.5.5 DelayQueue

A queue where elements can only be taken after their delay has expired:

```java
public class DelayQueue<E extends Delayed> extends AbstractQueue<E>
        implements BlockingQueue<E> {
    private final PriorityQueue<E> q = new PriorityQueue<E>();
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition available = lock.newCondition();
    // "Leader" thread: the thread waiting for the earliest element
    private Thread leader;
}
```

Elements must implement the `Delayed` interface:

```java
public interface Delayed extends Comparable<Delayed> {
    long getDelay(TimeUnit unit);
}
```

`take()` logic:
1. Peek at the head of the priority queue (earliest expiring element).
2. If `getDelay() > 0`, the element is not yet available. The calling thread becomes the "leader" and calls `available.awaitNanos(delay)`.
3. Other threads waiting on `take()` simply call `available.await()` (no timeout — they let the leader wake them).
4. When the leader wakes up, it takes the element and signals the next waiter.

**Use cases**: Scheduled task execution, cache expiration, rate limiting with time-based windows.

### 7.5.6 LinkedTransferQueue

Combines `LinkedBlockingQueue` and `SynchronousQueue`:

```java
// transfer() — blocks until a consumer takes the element
queue.transfer(element);

// tryTransfer() — if a consumer is waiting, hand off directly; else return false
boolean transferred = queue.tryTransfer(element);
```

`transfer()` behaves like `SynchronousQueue.put()` if a consumer is waiting (direct hand-off), but if no consumer is waiting, it enqueues the element and blocks until a consumer dequeues it. This is more flexible than both `SynchronousQueue` (which never enqueues) and `LinkedBlockingQueue` (which never directly hands off).

---

## 7.6 Other Concurrent Utilities

### 7.6.1 ConcurrentLinkedQueue

A lock-free unbounded queue using the **Michael-Scott algorithm**:

```java
public class ConcurrentLinkedQueue<E> extends AbstractQueue<E>
        implements Queue<E> {
    // Both head and tail are volatile
    private transient volatile Node<E> head;
    private transient volatile Node<E> tail;
}
```

The Michael-Scott algorithm for `offer()`:
1. Read the tail node.
2. If `tail.next` is null, CAS a new node into `tail.next`.
3. CAS `tail` to point to the new node (may be done by another thread — this is the lazy tail update).
4. If `tail.next` is NOT null (another thread beat us), advance `tail` first, then retry.

The lazy tail update is key to performance: the `tail` pointer is allowed to lag behind the actual tail by one node. This reduces the number of CAS operations by half (on average, only one CAS per offer instead of two).

**Use case**: When you need a non-blocking queue without the blocking semantics of `BlockingQueue`. Useful in actor systems, event loops, and situations where the consumer polls rather than blocks.

### 7.6.2 ConcurrentLinkedDeque

A lock-free double-ended queue. Supports `addFirst()`, `addLast()`, `removeFirst()`, `removeLast()`, all using CAS on the doubly-linked node pointers. More complex than `ConcurrentLinkedQueue` because doubly-linked nodes require two pointer updates that cannot be done atomically.

The implementation uses a technique where deletion marks a node (sets a special flag) and then lazily unlinks it on subsequent traversals. This avoids the ABA problem that plagues simple CAS-based doubly-linked structures.

### 7.6.3 Collections.synchronizedMap vs ConcurrentHashMap

```java
// synchronizedMap wraps every method in synchronized(mutex):
Map<K,V> syncMap = Collections.synchronizedMap(new HashMap<>());

// Internally:
public V get(Object key) {
    synchronized (mutex) { return m.get(key); }
}
public V put(K key, V value) {
    synchronized (mutex) { return m.put(key, value); }
}
// EVERY operation acquires the same lock. One thread at a time.
// Even reads block each other.
```

Why `synchronizedMap` is almost always wrong:

1. **No concurrency**: A single mutex means zero read-read parallelism. 100 threads calling `get()` queue up sequentially.
2. **No atomic compound operations**: `putIfAbsent`, `computeIfAbsent`, `merge` — none of these exist. You must manually synchronize:

```java
// This is STILL broken with synchronizedMap:
if (!syncMap.containsKey(key)) {
    syncMap.put(key, value);
}
// Another thread can put between containsKey and put!

// You must do:
synchronized (syncMap) {
    if (!syncMap.containsKey(key)) {
        syncMap.put(key, value);
    }
}
// Now you are back to manual lock management. What was the point of synchronizedMap?
```

3. **Iterator is not safe**: You must externally synchronize during iteration:

```java
synchronized (syncMap) {
    for (Map.Entry<K,V> e : syncMap.entrySet()) { ... }
}
// Holding the lock for the entire iteration blocks all other threads.
```

`ConcurrentHashMap` solves all of these: concurrent reads, fine-grained write locking, atomic compound operations, and weakly consistent iteration that never throws `ConcurrentModificationException`.

### 7.6.4 StampedLock

`StampedLock` (JDK 8+) adds **optimistic read locking** on top of traditional read-write locking:

```java
StampedLock sl = new StampedLock();

// Optimistic read (no lock acquired — just a stamp):
long stamp = sl.tryOptimisticRead();
// Read shared data
double x = this.x;
double y = this.y;
// Validate: did any writer intervene?
if (!sl.validate(stamp)) {
    // Optimistic read failed — fall back to pessimistic read lock
    stamp = sl.readLock();
    try {
        x = this.x;
        y = this.y;
    } finally {
        sl.unlockRead(stamp);
    }
}

// Write lock (exclusive):
long stamp = sl.writeLock();
try {
    this.x = newX;
    this.y = newY;
} finally {
    sl.unlockWrite(stamp);
}
```

**Optimistic reading costs essentially nothing** — it does not modify any shared state, does not contend with other readers, and does not block writers. The `validate()` call checks whether a writer acquired the lock between `tryOptimisticRead()` and `validate()`.

Comparison with `ReentrantReadWriteLock`:
- `ReentrantReadWriteLock`: readers acquire a shared lock (modifies lock state, visible to writers). Under write-heavy workloads, readers and writers contend.
- `StampedLock`: optimistic readers do not modify lock state. In read-heavy workloads with rare writes, optimistic reads are contention-free.
- `StampedLock` is NOT reentrant. Do not call `readLock()` inside `readLock()` — deadlock.
- `StampedLock` does not support `Condition` objects.

---

## 7.7 Real-World Correlations

### ConcurrentHashMap
- **Spring Bean Registry**: `DefaultListableBeanFactory` stores bean definitions in a `ConcurrentHashMap`. Every `@Autowired` injection triggers a map lookup.
- **Hibernate Second-Level Cache**: Region factories use `ConcurrentHashMap` to store cached entities. High read ratio (millions of reads per cache miss), perfect for CHM's lock-free `get()`.
- **Web Server Session Storage**: Tomcat and Jetty store HTTP sessions in `ConcurrentHashMap`. Every request reads the session (lock-free), session creation/invalidation writes (per-bin lock).
- **DNS Cache**: `java.net.InetAddress` caches resolved DNS entries in a `ConcurrentHashMap`.

### CopyOnWriteArrayList
- **Event Listener Lists**: Swing/JavaFX/Spring `ApplicationEventMulticaster` store listeners in `CopyOnWriteArrayList`. Listeners are registered once (startup) and fired many times (runtime). Perfect read-write ratio.
- **Routing Tables**: Load balancers store upstream server lists. Updated on health check failure (rare), read on every request (frequent).
- **Configuration Lists**: Feature flags, rate limit rules, circuit breaker configs. Updated via admin API (rare), read on every request.

### BlockingQueue
- **ThreadPoolExecutor Work Queue**: Every thread pool has a `BlockingQueue` for submitted tasks. `newFixedThreadPool` uses `LinkedBlockingQueue`. `newCachedThreadPool` uses `SynchronousQueue`.
- **Kafka Consumer Buffers**: Consumed messages are placed in a `BlockingQueue` for processing threads. Backpressure is natural — if the queue is full, the consumer pauses.
- **Actor Model Mailboxes**: Akka's actor mailbox is essentially a `ConcurrentLinkedQueue` (unbounded) or bounded `BlockingQueue`.
- **Log Appenders**: Logback's `AsyncAppender` uses an `ArrayBlockingQueue` to buffer log events between the application thread and the I/O thread.

### ConcurrentSkipListMap
- **Redis Sorted Sets**: As discussed, Redis uses skip lists for `ZSET` to enable range queries.
- **Database Indexes with Concurrent Access**: An in-memory B-tree alternative where concurrent sorted access is needed without complex locking.
- **Time-Series Data**: Concurrent accumulation of timestamped events with the ability to query by time range.

### SynchronousQueue
- **Executors.newCachedThreadPool()**: Direct task-to-thread hand-off. No queueing.
- **Pipeline Stage Connectors**: When stages must process at the same rate (no buffering between stages).

---

## Problems

### Problem 7.01 [Easy] -- Producer-Consumer with BlockingQueue

**Statement**: Implement a producer-consumer system where 3 producer threads generate integers 1-100 and 2 consumer threads process them. Use a bounded `BlockingQueue` of capacity 10. Print each consumed item with the consumer thread name. All items must be consumed exactly once.

**Solution**:

```java
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public class ProducerConsumer {
    public static void main(String[] args) throws InterruptedException {
        BlockingQueue<Integer> queue = new ArrayBlockingQueue<>(10);
        AtomicInteger counter = new AtomicInteger(0);
        int totalItems = 100;
        Integer POISON = -1;

        // 3 Producers
        Runnable producer = () -> {
            int val;
            while ((val = counter.incrementAndGet()) <= totalItems) {
                try {
                    queue.put(val);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        };

        // 2 Consumers
        int numConsumers = 2;
        Runnable consumer = () -> {
            while (true) {
                try {
                    Integer val = queue.take();
                    if (val.equals(POISON)) return;
                    System.out.println(Thread.currentThread().getName() + " consumed: " + val);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        };

        ExecutorService pool = Executors.newFixedThreadPool(5);
        // Start producers
        for (int i = 0; i < 3; i++) pool.submit(producer);
        // Start consumers
        for (int i = 0; i < numConsumers; i++) pool.submit(consumer);

        pool.shutdown();
        // Wait for producers to finish, then send poison pills
        // Better approach: use a CountDownLatch for producers
        Thread.sleep(2000); // simplified wait
        for (int i = 0; i < numConsumers; i++) queue.put(POISON);
        pool.awaitTermination(10, TimeUnit.SECONDS);
    }
}
```

**Complexity**: O(N) total work across all threads. Queue operations are O(1). The `AtomicInteger` counter ensures no duplicate production via CAS.

**JVM Insight**: `ArrayBlockingQueue.put()` acquires a `ReentrantLock` and calls `notFull.await()` when the queue is full. Internally, `await()` calls `LockSupport.park()`, which maps to `pthread_cond_wait` on Linux. The thread is removed from the OS scheduler, consuming zero CPU while blocked. When `take()` dequeues an element, it calls `notFull.signal()`, which calls `LockSupport.unpark()`, which wakes exactly one parked thread.

**Real-World**: This is exactly how Logback's `AsyncAppender` works — application threads are producers (logging events), a single I/O thread is the consumer (writing to file/network), and an `ArrayBlockingQueue` provides bounded buffering with backpressure.

---

### Problem 7.02 [Easy] -- Thread-Safe Singleton with Volatile DCL

**Statement**: Implement a thread-safe lazy singleton using the Double-Checked Locking pattern with `volatile`. Explain why `volatile` is mandatory.

**Solution**:

```java
public class Singleton {
    // volatile prevents instruction reordering of object construction
    private static volatile Singleton instance;

    private final Connection connection;

    private Singleton() {
        this.connection = createHeavyConnection();
    }

    public static Singleton getInstance() {
        Singleton local = instance; // volatile read into local for performance
        if (local == null) {        // First check (no lock)
            synchronized (Singleton.class) {
                local = instance;   // Second check (with lock)
                if (local == null) {
                    instance = local = new Singleton();
                }
            }
        }
        return local;
    }
}
```

**Why `volatile` is mandatory**: Without `volatile`, the JVM can reorder the construction steps of `new Singleton()`. Object construction involves three steps:
1. Allocate memory for the Singleton object.
2. Initialize the object's fields (run the constructor).
3. Assign the reference to the `instance` variable.

Without `volatile`, the compiler or CPU can reorder steps 2 and 3. Thread A might publish a non-null `instance` reference (step 3) before the constructor finishes (step 2). Thread B sees a non-null `instance`, skips the `synchronized` block, and uses a partially constructed object with `connection == null`.

With `volatile`, the write to `instance` emits a `StoreStore` barrier before it and a `StoreLoad` barrier after it. This ensures steps 1 and 2 complete before step 3, and step 3 is visible to all threads before any subsequent reads.

**Complexity**: O(1) for `getInstance()` in the common case (single volatile read).

**JVM Insight**: On x86, the volatile read of `instance` is free (no barrier needed — TSO guarantees load-load ordering). The volatile write emits a `LOCK addl $0, (%rsp)` after the write (StoreLoad barrier). So the cost is paid only during construction, not during reads.

**Real-World**: Spring's singleton beans use a similar pattern internally. The `DefaultSingletonBeanRegistry` uses a `singletonObjects` `ConcurrentHashMap` plus synchronized blocks for lazy initialization. The enum singleton pattern (`enum Singleton { INSTANCE; }`) and the holder class pattern (`private static class Holder { static final Singleton INSTANCE = new Singleton(); }`) avoid the complexity of DCL entirely. The holder class pattern works because class loading is inherently synchronized by the JVM.

---

### Problem 7.03 [Easy] -- Concurrent Counter Comparison

**Statement**: Implement a counter incremented by 16 threads, each incrementing 1,000,000 times. Compare three implementations: `synchronized`, `AtomicLong`, and `LongAdder`. Verify correctness and explain performance differences.

**Solution**:

```java
import java.util.concurrent.atomic.*;

public class CounterBenchmark {
    static final int THREADS = 16;
    static final int INCREMENTS = 1_000_000;

    // Approach 1: synchronized
    static long syncCounter = 0;
    static final Object lock = new Object();
    static void syncIncrement() {
        synchronized (lock) { syncCounter++; }
    }

    // Approach 2: AtomicLong
    static AtomicLong atomicCounter = new AtomicLong(0);
    // atomicCounter.incrementAndGet() internally:
    //   do { old = value; } while (!compareAndSet(old, old + 1));
    // On x86: LOCK cmpxchg instruction (CAS loop)

    // Approach 3: LongAdder
    static LongAdder adderCounter = new LongAdder();
    // adderCounter.increment() hashes the thread to a Cell
    // and CAS-increments that Cell's value.
    // sum() aggregates: base + all cells.

    public static void main(String[] args) throws Exception {
        // Run each approach with THREADS threads, INCREMENTS per thread
        // Expected final value: THREADS * INCREMENTS = 16,000,000

        long start, elapsed;
        Thread[] threads = new Thread[THREADS];

        // Synchronized
        start = System.nanoTime();
        for (int i = 0; i < THREADS; i++) {
            threads[i] = new Thread(() -> {
                for (int j = 0; j < INCREMENTS; j++) syncIncrement();
            });
            threads[i].start();
        }
        for (Thread t : threads) t.join();
        elapsed = System.nanoTime() - start;
        System.out.printf("synchronized: %d, %dms%n", syncCounter, elapsed / 1_000_000);

        // AtomicLong
        start = System.nanoTime();
        for (int i = 0; i < THREADS; i++) {
            threads[i] = new Thread(() -> {
                for (int j = 0; j < INCREMENTS; j++) atomicCounter.incrementAndGet();
            });
            threads[i].start();
        }
        for (Thread t : threads) t.join();
        elapsed = System.nanoTime() - start;
        System.out.printf("AtomicLong:   %d, %dms%n", atomicCounter.get(), elapsed / 1_000_000);

        // LongAdder
        start = System.nanoTime();
        for (int i = 0; i < THREADS; i++) {
            threads[i] = new Thread(() -> {
                for (int j = 0; j < INCREMENTS; j++) adderCounter.increment();
            });
            threads[i].start();
        }
        for (Thread t : threads) t.join();
        elapsed = System.nanoTime() - start;
        System.out.printf("LongAdder:    %d, %dms%n", adderCounter.sum(), elapsed / 1_000_000);
    }
}
```

**Expected results** (16 cores):

```
synchronized:  ~2500ms  (heavy lock contention, OS-level parking)
AtomicLong:    ~1200ms  (CAS contention, CPU spinning)
LongAdder:     ~200ms   (distributed across cells, minimal contention)
```

**Complexity**: All are O(1) per increment. But the constant factor differs by 10x due to contention.

**JVM Insight**: `synchronized` under high contention inflates to a fat lock (`ObjectMonitor`), which parks threads with `pthread_mutex_lock`. Context switches are expensive (~5us each). `AtomicLong` spins in a CAS loop — no context switch, but the `LOCK cmpxchg` instruction causes cache line bouncing across cores (each failed CAS invalidates the cache line). `LongAdder` hashes each thread to a separate `CounterCell`, each on its own cache line (`@Contended`). With 16 threads and ~16 cells, there is near-zero contention. The cost of `sum()` (iterating cells) is amortized over many increments.

**Real-World**: `ConcurrentHashMap` internally uses `LongAdder`-style counting (baseCount + CounterCell[]) for exactly this reason. Web servers use `LongAdder` for request counters, metrics systems use it for aggregation. `AtomicLong` is fine for low-contention scenarios (e.g., sequence generators).

---

### Problem 7.04 [Easy] -- Print in Order

**Statement**: Three threads T1, T2, T3 must print "first", "second", "third" in order, regardless of scheduling. Implement using `volatile` flags and busy-wait, then using `CountDownLatch`.

**Solution**:

```java
// Approach 1: Volatile flags
class PrintInOrder {
    private volatile int step = 1;

    public void first(Runnable printFirst) throws InterruptedException {
        printFirst.run();
        step = 2;  // volatile write — visible to all threads
    }

    public void second(Runnable printSecond) throws InterruptedException {
        while (step != 2) Thread.yield();  // busy-wait on volatile read
        printSecond.run();
        step = 3;
    }

    public void third(Runnable printThird) throws InterruptedException {
        while (step != 3) Thread.yield();
        printThird.run();
    }
}

// Approach 2: CountDownLatch (preferred — no busy-wait)
class PrintInOrderLatch {
    private final CountDownLatch latch1 = new CountDownLatch(1);
    private final CountDownLatch latch2 = new CountDownLatch(1);

    public void first(Runnable printFirst) throws InterruptedException {
        printFirst.run();
        latch1.countDown();  // Releases second()
    }

    public void second(Runnable printSecond) throws InterruptedException {
        latch1.await();      // Blocks until first() calls countDown()
        printSecond.run();
        latch2.countDown();  // Releases third()
    }

    public void third(Runnable printThird) throws InterruptedException {
        latch2.await();      // Blocks until second() calls countDown()
        printThird.run();
    }
}
```

**Complexity**: O(1) for the latch approach (no busy-waiting). The volatile approach wastes CPU cycles spinning.

**JVM Insight**: `CountDownLatch` is built on `AbstractQueuedSynchronizer` (AQS). `await()` parks the thread with `LockSupport.park()` — zero CPU usage while waiting. `countDown()` decrements the AQS state via CAS and unparks waiting threads. The volatile approach's `Thread.yield()` is a hint to the scheduler, not a guarantee — on a single-core system, `yield()` might not yield at all.

**Real-World**: Service initialization ordering in microservices. Database connection pool must initialize before the HTTP server starts accepting requests. `CountDownLatch` gates the startup sequence.

---

### Problem 7.05 [Easy] -- FizzBuzz Multithreaded

**Statement**: Four threads execute concurrently: Thread A prints numbers not divisible by 3 or 5, Thread B prints "fizz" for multiples of 3, Thread C prints "buzz" for multiples of 5, Thread D prints "fizzbuzz" for multiples of 15. Print 1 to n in order.

**Solution**:

```java
import java.util.concurrent.Semaphore;
import java.util.function.IntConsumer;

class FizzBuzz {
    private int n;
    private volatile int current = 1;
    private Semaphore semNum = new Semaphore(1);
    private Semaphore semFizz = new Semaphore(0);
    private Semaphore semBuzz = new Semaphore(0);
    private Semaphore semFizzBuzz = new Semaphore(0);

    public FizzBuzz(int n) { this.n = n; }

    public void fizz(Runnable printFizz) throws InterruptedException {
        while (true) {
            semFizz.acquire();
            if (current > n) return;
            printFizz.run();
            current++;
            releaseSemaphore();
        }
    }

    public void buzz(Runnable printBuzz) throws InterruptedException {
        while (true) {
            semBuzz.acquire();
            if (current > n) return;
            printBuzz.run();
            current++;
            releaseSemaphore();
        }
    }

    public void fizzbuzz(Runnable printFizzBuzz) throws InterruptedException {
        while (true) {
            semFizzBuzz.acquire();
            if (current > n) return;
            printFizzBuzz.run();
            current++;
            releaseSemaphore();
        }
    }

    public void number(IntConsumer printNumber) throws InterruptedException {
        while (true) {
            semNum.acquire();
            if (current > n) {
                // Wake all blocked threads so they can exit
                semFizz.release();
                semBuzz.release();
                semFizzBuzz.release();
                return;
            }
            printNumber.accept(current);
            current++;
            releaseSemaphore();
        }
    }

    private void releaseSemaphore() {
        if (current > n) {
            semNum.release(); semFizz.release();
            semBuzz.release(); semFizzBuzz.release();
            return;
        }
        if (current % 15 == 0) semFizzBuzz.release();
        else if (current % 3 == 0) semFizz.release();
        else if (current % 5 == 0) semBuzz.release();
        else semNum.release();
    }
}
```

**Complexity**: O(n) total, each iteration constant time. Semaphore operations are O(1).

**JVM Insight**: `Semaphore` is built on AQS. `acquire()` decrements the permit count via CAS. If permits drop below 0, the thread is parked. `release()` increments permits and unparks one waiter. The fair vs unfair constructor parameter controls whether threads are FIFO-ordered or can barge.

**Real-World**: Thread coordination patterns like this appear in pipeline processing systems where specific stages must process specific types of data.

---

### Problem 7.06 [Easy] -- Bounded Buffer from Scratch

**Statement**: Implement a thread-safe bounded buffer (circular queue) using `synchronized`, `wait()`, and `notifyAll()`. Support `put(E)` (blocks when full) and `take()` (blocks when empty).

**Solution**:

```java
public class BoundedBuffer<E> {
    private final Object[] items;
    private int putIndex, takeIndex, count;

    public BoundedBuffer(int capacity) {
        items = new Object[capacity];
    }

    public synchronized void put(E item) throws InterruptedException {
        while (count == items.length) {
            wait();  // Release lock, park thread, reacquire lock on wake
        }
        items[putIndex] = item;
        putIndex = (putIndex + 1) % items.length;
        count++;
        notifyAll();  // Wake all waiters — some might be take() waiters
    }

    @SuppressWarnings("unchecked")
    public synchronized E take() throws InterruptedException {
        while (count == 0) {
            wait();
        }
        E item = (E) items[takeIndex];
        items[takeIndex] = null;  // Help GC
        takeIndex = (takeIndex + 1) % items.length;
        count--;
        notifyAll();  // Wake all waiters — some might be put() waiters
        return item;
    }

    public synchronized int size() { return count; }
}
```

**Why `while` and not `if`**: Spurious wakeups. The JVM specification allows `wait()` to return without being `notify`'d. Also, `notifyAll()` wakes ALL waiters, including those whose condition is not yet true. The `while` loop re-checks the condition after waking.

**Why `notifyAll()` and not `notify()`**: With `notify()`, only one thread wakes. If a `put()` caller wakes another `put()` caller instead of a `take()` caller, both sleep forever — deadlock. `notifyAll()` wakes everyone, ensuring the right thread eventually proceeds.

**Complexity**: O(1) for both `put` and `take`, excluding wait time.

**JVM Insight**: `synchronized` on `this` uses the object's monitor (mark word transitions from unlocked to thin lock to fat lock under contention). `wait()` releases the monitor, adds the thread to the monitor's wait set, and parks it. `notifyAll()` moves all threads from the wait set to the entry set (they compete for the lock). The thread that acquires the lock proceeds; others re-enter `wait()`.

**Real-World**: This is the pedagogical version of `ArrayBlockingQueue`. The production version uses `ReentrantLock` with two `Condition` objects (`notFull`, `notEmpty`) to avoid the inefficiency of `notifyAll()` waking irrelevant threads.

---

### Problem 7.07 [Easy] -- Thread-Safe Singleton Variants

**Statement**: Implement three thread-safe singleton patterns: Enum, Holder Class, and volatile DCL. Compare their safety guarantees against serialization, reflection, and cloning attacks.

**Solution**:

```java
// Approach 1: Enum Singleton (best for most cases)
public enum EnumSingleton {
    INSTANCE;
    private final Connection connection = createHeavyConnection();
    public Connection getConnection() { return connection; }
    // Pros: serialization-safe (JVM handles it), reflection-safe
    //       (JVM prevents reflective instantiation of enums),
    //       lazy enough (initialized on first access to the enum class)
    // Cons: cannot extend a base class (enums implicitly extend Enum)
}

// Approach 2: Holder Class (Initialization-on-Demand)
public class HolderSingleton {
    private HolderSingleton() {}
    private static class Holder {
        static final HolderSingleton INSTANCE = new HolderSingleton();
    }
    public static HolderSingleton getInstance() {
        return Holder.INSTANCE;
    }
    // JVM guarantees: class initialization is synchronized.
    // Holder class is not loaded until getInstance() is called.
    // Thread-safe without any explicit synchronization.
    // Pros: truly lazy, zero synchronization overhead on access
    // Cons: vulnerable to reflection (can call private constructor)
    //       and serialization (must implement readResolve())
}

// Approach 3: Volatile DCL (already covered in Problem 7.02)
// Useful when you need to pass constructor arguments at creation time,
// which neither Enum nor Holder class supports easily.

// Security comparison:
// Attack        | Enum      | Holder    | DCL
// ─────────────┼───────────┼───────────┼────────
// Serialization | Safe      | Unsafe*   | Unsafe*
// Reflection    | Safe      | Unsafe    | Unsafe
// Cloning       | Safe      | Unsafe**  | Unsafe**
//
// * Must implement readResolve() to prevent deserialization creating new instance
// ** Must not implement Cloneable, or override clone() to return INSTANCE
```

**Complexity**: O(1) for all three on the access path.

**JVM Insight**: The Holder class pattern exploits JLS 12.4 (class initialization). The JVM acquires an initialization lock for class `Holder` the first time it is referenced. Only one thread initializes the class; all other threads wait. After initialization, the lock is never acquired again. This is the most efficient lazy singleton — no volatile reads, no CAS, no synchronized.

**Real-World**: `Runtime.getRuntime()` uses a static field (eager). `java.util.logging.LogManager` uses a holder pattern. Spring's `@Scope("singleton")` beans use `ConcurrentHashMap.computeIfAbsent()` internally.

---

### Problem 7.08 [Medium] -- Concurrent LRU Cache

**Statement**: Design a thread-safe LRU cache with O(1) get and put. Must support concurrent reads and writes. Target: 100K entries, 50 reader threads, 10 writer threads.

**Solution**:

```java
import java.util.concurrent.*;

public class ConcurrentLRUCache<K, V> {
    private final int capacity;
    private final ConcurrentHashMap<K, V> map;
    private final ConcurrentLinkedDeque<K> accessOrder;
    // accessOrder approximates recency. Not perfectly ordered under
    // concurrency, but "good enough" for LRU eviction.

    public ConcurrentLRUCache(int capacity) {
        this.capacity = capacity;
        this.map = new ConcurrentHashMap<>(capacity);
        this.accessOrder = new ConcurrentLinkedDeque<>();
    }

    public V get(K key) {
        V value = map.get(key);  // Lock-free read
        if (value != null) {
            // Move to most-recently-used position.
            // Under high concurrency, remove+addLast is not atomic,
            // so the deque order is approximate. This is acceptable
            // for LRU — we evict roughly the least recently used item.
            accessOrder.remove(key);   // O(n) — see note below
            accessOrder.addLast(key);
        }
        return value;
    }

    public void put(K key, V value) {
        V old = map.put(key, value);
        if (old == null) {
            // New key
            accessOrder.addLast(key);
            while (map.size() > capacity) {
                K evicted = accessOrder.pollFirst();
                if (evicted != null) {
                    map.remove(evicted);
                }
            }
        } else {
            // Existing key updated — move to end
            accessOrder.remove(key);
            accessOrder.addLast(key);
        }
    }
}
```

**The O(n) problem**: `ConcurrentLinkedDeque.remove(Object)` is O(n) because it must scan the deque. For a production LRU cache, use one of these alternatives:

```java
// Alternative 1: Segmented LRU (Caffeine's approach)
// Use a ring buffer per-thread to record accesses.
// A single drain thread periodically processes the buffers
// and updates an access-order doubly-linked list under a lock.
// Reads are lock-free (just append to thread-local buffer).

// Alternative 2: LinkedHashMap with synchronized wrapper
// Simple but single-lock bottleneck.
Collections.synchronizedMap(new LinkedHashMap<K,V>(capacity, 0.75f, true) {
    @Override
    protected boolean removeEldestEntry(Map.Entry<K,V> eldest) {
        return size() > capacity;
    }
});

// Alternative 3: Use Caffeine (production-grade)
// Caffeine uses a W-TinyLFU admission policy + concurrent access recording
// with per-thread ring buffers. It is the state of the art.
Cache<K, V> cache = Caffeine.newBuilder()
    .maximumSize(capacity)
    .build();
```

**Complexity**: `get()` is O(1) for the map lookup but O(n) for the deque removal in the naive version. Production caches like Caffeine achieve amortized O(1) by batching access recording.

**JVM Insight**: `ConcurrentHashMap.get()` is a volatile read — no locking. `ConcurrentLinkedDeque` uses CAS on node pointers for lock-free insertion and deletion. The real bottleneck in the naive version is the O(n) scan during `remove(key)`. Caffeine avoids this by never scanning — it records accesses in fixed-size per-thread buffers and uses a single drain thread with exclusive access to the ordering data structure.

**Real-World**: Guava Cache, Caffeine, and Ehcache all implement concurrent LRU or LRU-like eviction. Caffeine is the default cache in Spring Framework 5+, Hibernate 5.3+, and many other libraries.

---

### Problem 7.09 [Medium] -- Rate Limiter (Token Bucket)

**Statement**: Implement a thread-safe token bucket rate limiter. Support `tryAcquire()` that returns true if a token is available, false otherwise. The bucket refills at a fixed rate. Must handle concurrent access from 100+ threads.

**Solution**:

```java
import java.util.concurrent.atomic.AtomicLong;

public class TokenBucketRateLimiter {
    private final long maxTokens;
    private final long refillRatePerSecond;
    private final AtomicLong availableTokens;
    private final AtomicLong lastRefillTimestamp;

    public TokenBucketRateLimiter(long maxTokens, long refillRatePerSecond) {
        this.maxTokens = maxTokens;
        this.refillRatePerSecond = refillRatePerSecond;
        this.availableTokens = new AtomicLong(maxTokens);
        this.lastRefillTimestamp = new AtomicLong(System.nanoTime());
    }

    public boolean tryAcquire() {
        refill();
        while (true) {
            long current = availableTokens.get();
            if (current <= 0) return false;
            if (availableTokens.compareAndSet(current, current - 1)) {
                return true;
            }
            // CAS failed — another thread decremented. Retry.
        }
    }

    private void refill() {
        long now = System.nanoTime();
        long last = lastRefillTimestamp.get();
        long elapsedNanos = now - last;
        long tokensToAdd = elapsedNanos * refillRatePerSecond / 1_000_000_000L;
        if (tokensToAdd <= 0) return;

        // CAS the timestamp to claim this refill window
        if (lastRefillTimestamp.compareAndSet(last, now)) {
            // We won the refill. Add tokens, capping at max.
            while (true) {
                long current = availableTokens.get();
                long newTokens = Math.min(maxTokens, current + tokensToAdd);
                if (availableTokens.compareAndSet(current, newTokens)) break;
            }
        }
        // If CAS failed, another thread already refilled. That is fine.
    }

    public boolean tryAcquire(int permits) {
        refill();
        while (true) {
            long current = availableTokens.get();
            if (current < permits) return false;
            if (availableTokens.compareAndSet(current, current - permits)) {
                return true;
            }
        }
    }
}
```

**Complexity**: `tryAcquire()` is O(1) amortized. The CAS loop retries are bounded by the number of concurrent threads (at most N retries for N threads contending).

**JVM Insight**: `AtomicLong` uses `Unsafe.compareAndSwapLong()`, which compiles to `LOCK cmpxchg8b` on x86. Under high contention (100+ threads), the cache line holding the atomic variable bounces between cores. If contention is extreme, consider `LongAdder` for the token count — but `LongAdder` does not support `compareAndSet`, so you would need a different design (e.g., per-thread token buckets with periodic rebalancing).

**Real-World**: Google Guava's `RateLimiter` uses a similar approach (Smooth Bursty and Smooth Warming Up variants). Resilience4j's rate limiter uses an `AtomicReference<State>` for CAS-based state transitions. Nginx's `limit_req` module uses the leaky bucket algorithm (dual of token bucket).

---

### Problem 7.10 [Medium] -- Web Crawler with BFS

**Statement**: Implement a multithreaded web crawler. Given a start URL, crawl all pages within the same domain using BFS. Use `ConcurrentHashMap` for visited URLs and `BlockingQueue` for the frontier. Limit to 10 concurrent crawler threads.

**Solution**:

```java
import java.util.*;
import java.util.concurrent.*;

public class ConcurrentWebCrawler {
    private final ConcurrentHashMap<String, Boolean> visited = new ConcurrentHashMap<>();
    private final BlockingQueue<String> frontier = new LinkedBlockingQueue<>();
    private final String domain;
    private final ExecutorService pool;
    private final AtomicInteger activeTasks = new AtomicInteger(0);

    public ConcurrentWebCrawler(String startUrl, int threads) {
        this.domain = extractDomain(startUrl);
        this.pool = Executors.newFixedThreadPool(threads);
        frontier.add(startUrl);
        visited.put(startUrl, true);
    }

    public Set<String> crawl() throws InterruptedException {
        for (int i = 0; i < 10; i++) {
            pool.submit(this::crawlWorker);
        }
        // Wait for completion: when frontier is empty AND no active tasks
        while (!frontier.isEmpty() || activeTasks.get() > 0) {
            Thread.sleep(100);
        }
        pool.shutdownNow();
        return visited.keySet();
    }

    private void crawlWorker() {
        while (true) {
            try {
                String url = frontier.poll(1, TimeUnit.SECONDS);
                if (url == null) {
                    if (activeTasks.get() == 0) return; // All done
                    continue;
                }
                activeTasks.incrementAndGet();
                try {
                    List<String> links = fetchAndParse(url);
                    for (String link : links) {
                        if (extractDomain(link).equals(domain)) {
                            // putIfAbsent returns null if key was absent (we win)
                            // returns existing value if key was present (another thread won)
                            if (visited.putIfAbsent(link, true) == null) {
                                frontier.add(link);
                            }
                        }
                    }
                } finally {
                    activeTasks.decrementAndGet();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    // Stubs for demonstration
    private List<String> fetchAndParse(String url) { return List.of(); }
    private String extractDomain(String url) { return url.split("/")[2]; }
}
```

**Why `ConcurrentHashMap.putIfAbsent` and not `containsKey` + `put`**:

```java
// BROKEN:
if (!visited.containsKey(link)) {   // Thread A checks
    // Thread B also checks — also not visited!
    visited.put(link, true);         // Both threads insert
    frontier.add(link);              // Link crawled twice!
}

// CORRECT:
if (visited.putIfAbsent(link, true) == null) {
    frontier.add(link);  // Only one thread wins the CAS in putIfAbsent
}
```

**Complexity**: O(V + E) where V is the number of unique pages and E is the number of links. Each URL is processed exactly once due to the `ConcurrentHashMap` deduplication.

**JVM Insight**: `putIfAbsent` in `ConcurrentHashMap` is atomic — it uses CAS on the bin head for empty bins and `synchronized` on the bin head for occupied bins. The `LinkedBlockingQueue` allows producers (threads discovering links) and consumers (threads picking URLs to crawl) to operate with separate locks. The `poll(1, SECONDS)` timeout prevents threads from blocking forever when the frontier temporarily empties.

**Real-World**: Apache Nutch, StormCrawler, and Heritrix all use variations of this pattern. The key scaling challenges are politeness (rate limiting per domain), deduplication across restarts (persistent visited set, e.g., Bloom filter or RocksDB), and priority management (important pages first).

---

### Problem 7.11 [Medium] -- Read-Write Lock Implementation

**Statement**: Implement a read-write lock from scratch using `synchronized`, `wait()`, and `notifyAll()`. Multiple readers can hold the lock simultaneously, but a writer requires exclusive access. Prevent writer starvation.

**Solution**:

```java
public class ReadWriteLock {
    private int readers = 0;
    private int writers = 0;
    private int writeRequests = 0;  // Prevents writer starvation

    public synchronized void lockRead() throws InterruptedException {
        // Wait if a writer is active OR if there are pending write requests.
        // The writeRequests check prevents writer starvation:
        // new readers must wait if a writer is queued.
        while (writers > 0 || writeRequests > 0) {
            wait();
        }
        readers++;
    }

    public synchronized void unlockRead() {
        readers--;
        notifyAll();  // Wake writers waiting for readers to drain
    }

    public synchronized void lockWrite() throws InterruptedException {
        writeRequests++;  // Signal that a writer is waiting
        try {
            while (readers > 0 || writers > 0) {
                wait();
            }
            writers++;
        } finally {
            writeRequests--;
        }
    }

    public synchronized void unlockWrite() {
        writers--;
        notifyAll();  // Wake all waiting readers and writers
    }
}
```

**Writer starvation prevention**: Without `writeRequests`, a steady stream of readers could indefinitely postpone writers. Each reader that arrives sees `writers == 0` and proceeds. By checking `writeRequests > 0` in `lockRead()`, new readers queue behind waiting writers.

**Complexity**: O(1) for all lock/unlock operations (excluding wait time).

**JVM Insight**: `ReentrantReadWriteLock` uses a single `int` state in AQS, split into high 16 bits (read hold count) and low 16 bits (write hold count). This limits the maximum number of concurrent readers and reentrant write locks to 65535 each. Our simplified version uses separate `int` fields. The production version supports reentrancy (a writer can acquire the read lock without deadlock) and fairness policies.

**Real-World**: Database engines use read-write locks on page latches. MySQL InnoDB uses a custom `rw_lock_t` with separate reader/writer counters. Java's `ReadWriteLock` is used in caching layers where reads vastly outnumber writes.

---

### Problem 7.12 [Medium] -- Design Concurrent HashMap from Scratch

**Statement**: Design a simplified concurrent hash map with lock striping. Support `get()`, `put()`, and `remove()`. Aim for high concurrency without using `java.util.concurrent`.

**Solution**:

```java
public class StripedConcurrentMap<K, V> {
    private static final int NUM_STRIPES = 16;
    private final Object[] locks;
    private final Node<K,V>[][] buckets;
    private final int capacity;

    static class Node<K, V> {
        final int hash;
        final K key;
        volatile V value;
        volatile Node<K, V> next;
        Node(int hash, K key, V value, Node<K, V> next) {
            this.hash = hash; this.key = key;
            this.value = value; this.next = next;
        }
    }

    @SuppressWarnings("unchecked")
    public StripedConcurrentMap(int capacity) {
        this.capacity = capacity;
        this.buckets = new Node[capacity][];
        // Actually we use a flat array of Node heads
        this.locks = new Object[NUM_STRIPES];
        for (int i = 0; i < NUM_STRIPES; i++) {
            locks[i] = new Object();
        }
    }

    private int hash(Object key) {
        int h = key.hashCode();
        return (h ^ (h >>> 16)) & (capacity - 1);
    }

    private Object lockFor(int bucket) {
        // Map bucket index to a stripe lock.
        // Multiple buckets share the same lock.
        return locks[bucket % NUM_STRIPES];
    }

    public V get(K key) {
        int idx = hash(key);
        // For a truly lock-free get(), we would need volatile reads
        // on Node.value and Node.next (like ConcurrentHashMap).
        // Here we use lock for simplicity.
        synchronized (lockFor(idx)) {
            for (Node<K,V> e = buckets[idx]; e != null; e = e.next) {
                if (e.hash == hash(key) && key.equals(e.key)) {
                    return e.value;
                }
            }
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    public V put(K key, V value) {
        int idx = hash(key);
        synchronized (lockFor(idx)) {
            for (Node<K,V> e = buckets[idx]; e != null; e = e.next) {
                if (e.hash == hash(key) && key.equals(e.key)) {
                    V old = e.value;
                    e.value = value;
                    return old;
                }
            }
            // Not found — prepend new node
            buckets[idx] = new Node<>(hash(key), key, value, buckets[idx]);
            return null;
        }
    }

    public V remove(K key) {
        int idx = hash(key);
        synchronized (lockFor(idx)) {
            Node<K,V> prev = null;
            for (Node<K,V> e = buckets[idx]; e != null; prev = e, e = e.next) {
                if (e.hash == hash(key) && key.equals(e.key)) {
                    V old = e.value;
                    if (prev == null) buckets[idx] = e.next;
                    else prev.next = e.next;
                    return old;
                }
            }
            return null;
        }
    }
}
```

**Lock striping explained**: Instead of one global lock (low concurrency) or one lock per bucket (high memory), we use a fixed number of stripe locks (16). Each bucket is assigned to a stripe: `bucket % NUM_STRIPES`. Operations on buckets in different stripes proceed concurrently. With 16 stripes, up to 16 threads can operate on different buckets simultaneously.

**Complexity**: O(1) average for get/put/remove (assuming good hash distribution). Lock contention depends on the number of stripes vs. threads.

**JVM Insight**: This is essentially the JDK 7 `ConcurrentHashMap` design (Segment-based). JDK 8 evolved beyond this: CAS on empty bins eliminates locks for the common case, and per-bin locking (on the head node itself) provides maximum granularity without the memory cost of N lock objects. Our `locks` array costs 16 objects x 16 bytes = 256 bytes. `ConcurrentHashMap`'s approach of locking on the head node costs zero additional bytes because the head node already exists.

**Real-World**: Lock striping is used in Guava's `Striped` lock utility, database connection pool implementations, and distributed lock managers. The number of stripes should be tuned to the expected concurrency level — too few stripes causes contention, too many wastes memory and cache lines.

---

### Problem 7.13 [Medium] -- Parallel Merge Sort with ForkJoinPool

**Statement**: Implement a parallel merge sort using `ForkJoinPool` and `RecursiveAction`. Compare performance against single-threaded merge sort for 10 million elements.

**Solution**:

```java
import java.util.concurrent.*;

public class ParallelMergeSort {
    private static final int SEQUENTIAL_THRESHOLD = 8192;

    static class MergeSortTask extends RecursiveAction {
        private final int[] arr, temp;
        private final int lo, hi;

        MergeSortTask(int[] arr, int[] temp, int lo, int hi) {
            this.arr = arr; this.temp = temp;
            this.lo = lo; this.hi = hi;
        }

        @Override
        protected void compute() {
            if (hi - lo <= SEQUENTIAL_THRESHOLD) {
                // Below threshold: use Arrays.sort (Dual-Pivot Quicksort)
                // This avoids the overhead of creating too many tasks.
                java.util.Arrays.sort(arr, lo, hi);
                return;
            }
            int mid = lo + (hi - lo) / 2;
            MergeSortTask left = new MergeSortTask(arr, temp, lo, mid);
            MergeSortTask right = new MergeSortTask(arr, temp, mid, hi);

            // Fork left, compute right in current thread, then join left
            left.fork();
            right.compute();
            left.join();

            merge(arr, temp, lo, mid, hi);
        }

        private void merge(int[] arr, int[] temp, int lo, int mid, int hi) {
            System.arraycopy(arr, lo, temp, lo, hi - lo);
            int i = lo, j = mid, k = lo;
            while (i < mid && j < hi) {
                arr[k++] = temp[i] <= temp[j] ? temp[i++] : temp[j++];
            }
            while (i < mid) arr[k++] = temp[i++];
            // No need to copy remaining right half — already in place
        }
    }

    public static void parallelSort(int[] arr) {
        int[] temp = new int[arr.length];
        ForkJoinPool pool = ForkJoinPool.commonPool();
        pool.invoke(new MergeSortTask(arr, temp, 0, arr.length));
    }
}
```

**Why `left.fork()` + `right.compute()` instead of forking both**:

```java
// WRONG (common mistake):
left.fork();
right.fork();     // Creates unnecessary task — current thread idles
left.join();
right.join();

// CORRECT:
left.fork();       // Submit left to the pool
right.compute();   // Current thread processes right directly
left.join();       // Wait for left to complete

// This is called "compute-one, fork-one" — it ensures the current
// thread is always doing useful work instead of creating tasks and waiting.
```

**The `SEQUENTIAL_THRESHOLD`**: Below 8192 elements, the overhead of task creation and fork/join exceeds the benefit of parallelism. `Arrays.sort()` (Dual-Pivot Quicksort) is highly optimized with cache-friendly sequential access, making it faster than parallel merge sort for small arrays.

**Complexity**: O(n log n) work, O(log n) span (critical path). With P processors, expected time is O(n log n / P + log n).

**JVM Insight**: `ForkJoinPool` uses work-stealing: each thread has its own deque of tasks. `fork()` pushes to the current thread's deque. Idle threads steal from the tail of other threads' deques. This provides automatic load balancing. The `commonPool()` (used by parallel streams) has `Runtime.getRuntime().availableProcessors() - 1` threads. `RecursiveAction` tasks are lighter than creating `Thread` objects — they are just objects with a `compute()` method, managed by the pool.

**Real-World**: `Arrays.parallelSort()` (JDK 8+) uses this exact approach internally — it falls back to `Arrays.sort()` below a threshold (currently 8192 for `int[]`). Java parallel streams also use `ForkJoinPool.commonPool()` for parallel operations like `stream.parallel().sorted()`.

---

### Problem 7.14 [Medium] -- Dining Philosophers

**Statement**: Five philosophers sit at a round table with five forks. Each needs two forks to eat. Implement a deadlock-free solution. Demonstrate the deadlock scenario first, then fix it.

**Solution**:

```java
import java.util.concurrent.locks.ReentrantLock;

public class DiningPhilosophers {

    // Approach 1: DEADLOCKS — each philosopher picks up left fork, then right
    // All 5 pick up their left fork simultaneously — circular wait — deadlock.

    // Approach 2: Resource ordering (break circular wait)
    // Always pick up the lower-numbered fork first.
    private final ReentrantLock[] forks = new ReentrantLock[5];

    public DiningPhilosophers() {
        for (int i = 0; i < 5; i++) forks[i] = new ReentrantLock();
    }

    public void wantsToEat(int philosopher,
                           Runnable pickLeftFork, Runnable pickRightFork,
                           Runnable eat,
                           Runnable putLeftFork, Runnable putRightFork)
                           throws InterruptedException {
        int left = philosopher;
        int right = (philosopher + 1) % 5;
        // Always lock lower-numbered fork first
        int first = Math.min(left, right);
        int second = Math.max(left, right);

        forks[first].lock();
        try {
            forks[second].lock();
            try {
                if (first == left) { pickLeftFork.run(); pickRightFork.run(); }
                else { pickRightFork.run(); pickLeftFork.run(); }
                eat.run();
                putLeftFork.run();
                putRightFork.run();
            } finally {
                forks[second].unlock();
            }
        } finally {
            forks[first].unlock();
        }
    }

    // Alternative: Limit concurrent diners with a Semaphore
    // Allow at most 4 philosophers to attempt eating simultaneously.
    // With 5 forks and 4 diners, at least one philosopher can always
    // get both forks. No deadlock possible.
    // java.util.concurrent.Semaphore semaphore = new Semaphore(4);
}
```

**Why resource ordering works**: Deadlock requires four conditions: mutual exclusion, hold and wait, no preemption, and circular wait. By always acquiring locks in a global order (lower ID first), we break the circular wait condition. Philosopher 4 would need fork 4 then fork 0, but the ordering forces fork 0 first, then fork 4. No cycle possible.

**Complexity**: O(1) per dining attempt (just two lock acquisitions).

**JVM Insight**: `ReentrantLock.lock()` first tries a CAS on the state field (fast path). If the lock is free, acquisition is one CAS instruction (~10ns). If contended, the thread enters the AQS wait queue and parks (via `LockSupport.park()`, which calls `pthread_cond_wait` on Linux). The `finally` blocks ensure locks are released even if `eat.run()` throws an exception — this is why `try-finally` is mandatory with explicit locks, unlike `synchronized` which auto-releases on any exit path.

**Real-World**: The resource ordering solution maps directly to database deadlock prevention: always acquire table/row locks in a consistent global order. MySQL InnoDB detects deadlocks via a wait-for graph and rolls back one transaction. The semaphore approach (limiting concurrency) maps to connection pool sizing — limiting the number of concurrent connections prevents resource exhaustion.

---

### Problem 7.15 [Medium] -- H2O Molecule Synchronization

**Statement**: There are threads representing hydrogen and oxygen atoms. To form a water molecule, two hydrogen threads and one oxygen thread must synchronize. Implement `hydrogen()` and `oxygen()` methods that block until a group of 2H + 1O is ready, then all three proceed.

**Solution**:

```java
import java.util.concurrent.*;

class H2O {
    private final Semaphore hSem = new Semaphore(2);  // Max 2 H before O
    private final Semaphore oSem = new Semaphore(1);  // Max 1 O before barrier
    private final CyclicBarrier barrier = new CyclicBarrier(3, () -> {
        // Barrier action: release permits for the next molecule
        hSem.release(2);
        oSem.release(1);
    });

    public H2O() {
        // No need to do anything — permits already set
    }

    public void hydrogen(Runnable releaseHydrogen) throws InterruptedException {
        hSem.acquire();  // At most 2 H threads proceed
        try {
            releaseHydrogen.run();
            barrier.await();  // Wait for 2H + 1O to gather
        } catch (BrokenBarrierException e) {
            throw new RuntimeException(e);
        }
    }

    public void oxygen(Runnable releaseOxygen) throws InterruptedException {
        oSem.acquire();  // At most 1 O thread proceeds
        try {
            releaseOxygen.run();
            barrier.await();  // Wait for 2H + 1O to gather
        } catch (BrokenBarrierException e) {
            throw new RuntimeException(e);
        }
    }
}
```

**Why `CyclicBarrier` and not `CountDownLatch`**: `CyclicBarrier` automatically resets after each group of 3 threads passes through, enabling molecule after molecule to form. `CountDownLatch` is one-shot — it cannot be reused. The barrier action (the `Runnable` passed to the constructor) runs after all 3 threads arrive but before any are released, allowing us to reset the semaphore permits atomically.

**Complexity**: O(1) per thread. Semaphore acquisition is CAS-based, barrier waiting uses AQS.

**JVM Insight**: `CyclicBarrier` internally uses a `ReentrantLock` and a `Condition`. When a thread calls `await()`, it decrements a counter under the lock. The last thread to arrive (counter reaches 0) runs the barrier action, resets the counter, and signals all waiting threads. The `Semaphore` permits are CAS-updated — `acquire()` spins on CAS until it decrements the permit count, or parks if no permits are available.

**Real-World**: This pattern appears in batch processing systems where a fixed group of items must be collected before processing (e.g., batching database writes). It also maps to chemical/physical simulations where particle interactions require specific groupings.

---

### Problem 7.16 [Medium] -- Traffic Light Controlled Intersection

**Statement**: An intersection allows only one road (A or B) to have green at a time. Cars arrive concurrently on both roads. Implement `carArrived(carId, roadId, direction, crossIntersection)` that allows a car to cross only when its road has the green light. Minimize the number of traffic light switches.

**Solution**:

```java
import java.util.concurrent.Semaphore;

class TrafficLight {
    private volatile int greenRoad = 1;  // Road 1 starts green
    private final Semaphore semaphore = new Semaphore(1);

    public void carArrived(int carId, int roadId, int direction,
                           Runnable turnGreen, Runnable crossCar) {
        try {
            semaphore.acquire();
            if (greenRoad != roadId) {
                turnGreen.run();  // Switch light
                greenRoad = roadId;
            }
            crossCar.run();  // Car crosses
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            semaphore.release();
        }
    }
}
```

The semaphore ensures only one car is in the intersection logic at a time. The `greenRoad` check minimizes switches — if consecutive cars are on the same road, no switch occurs. The volatile write to `greenRoad` ensures all threads see the latest state.

**Complexity**: O(1) per car. The semaphore serializes access, so throughput is limited by processing time per car.

**JVM Insight**: The `Semaphore(1)` behaves like a mutex but is not reentrant. The `volatile int greenRoad` ensures visibility across threads. An alternative using `synchronized` would be equivalent but slightly heavier due to monitor inflation under contention.

**Real-World**: Traffic control systems use similar state machines. The real-world version adds timing constraints (minimum green time, pedestrian crossing phases), sensor-triggered phase changes, and priority for emergency vehicles.

---

### Problem 7.17 [Medium] -- Blocking Queue from Scratch with ReentrantLock

**Statement**: Implement a bounded blocking queue using `ReentrantLock` and two `Condition` objects. Support `put()`, `take()`, `offer(timeout)`, and `poll(timeout)`.

**Solution**:

```java
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.*;

public class BlockingQueueImpl<E> {
    private final Object[] items;
    private int head, tail, count;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition notFull = lock.newCondition();
    private final Condition notEmpty = lock.newCondition();

    public BlockingQueueImpl(int capacity) {
        items = new Object[capacity];
    }

    public void put(E item) throws InterruptedException {
        lock.lockInterruptibly();
        try {
            while (count == items.length) {
                notFull.await();  // Release lock, park, reacquire on signal
            }
            enqueue(item);
        } finally {
            lock.unlock();
        }
    }

    @SuppressWarnings("unchecked")
    public E take() throws InterruptedException {
        lock.lockInterruptibly();
        try {
            while (count == 0) {
                notEmpty.await();
            }
            return dequeue();
        } finally {
            lock.unlock();
        }
    }

    public boolean offer(E item, long timeout, TimeUnit unit)
            throws InterruptedException {
        long nanos = unit.toNanos(timeout);
        lock.lockInterruptibly();
        try {
            while (count == items.length) {
                if (nanos <= 0) return false;
                nanos = notFull.awaitNanos(nanos);
                // awaitNanos returns the remaining time.
                // If it returns <= 0, timeout has expired.
            }
            enqueue(item);
            return true;
        } finally {
            lock.unlock();
        }
    }

    @SuppressWarnings("unchecked")
    public E poll(long timeout, TimeUnit unit) throws InterruptedException {
        long nanos = unit.toNanos(timeout);
        lock.lockInterruptibly();
        try {
            while (count == 0) {
                if (nanos <= 0) return null;
                nanos = notEmpty.awaitNanos(nanos);
            }
            return dequeue();
        } finally {
            lock.unlock();
        }
    }

    private void enqueue(E item) {
        items[tail] = item;
        tail = (tail + 1) % items.length;
        count++;
        notEmpty.signal();  // Signal ONE waiting consumer (efficient)
    }

    @SuppressWarnings("unchecked")
    private E dequeue() {
        E item = (E) items[head];
        items[head] = null;  // Prevent memory leak
        head = (head + 1) % items.length;
        count--;
        notFull.signal();  // Signal ONE waiting producer
        return item;
    }

    public int size() {
        lock.lock();
        try { return count; }
        finally { lock.unlock(); }
    }
}
```

**Why `signal()` instead of `signalAll()`**: Unlike Problem 7.06 where we used `notifyAll()`, here we have **two separate conditions** (`notFull` and `notEmpty`). When we enqueue, we know exactly that a consumer might be waiting on `notEmpty`, so we signal `notEmpty`. There is no risk of signaling the wrong type of waiter. `signal()` wakes exactly one thread, which is more efficient than `signalAll()`.

**Complexity**: O(1) for all operations.

**JVM Insight**: `ReentrantLock` uses AQS (AbstractQueuedSynchronizer). The `state` field in AQS is the lock hold count (0 = unlocked, 1+ = locked by the owning thread). `lockInterruptibly()` allows the thread to be interrupted while waiting for the lock — essential for shutdown scenarios. `Condition.await()` atomically releases the lock and adds the thread to the condition's wait queue. On `signal()`, the thread moves from the condition queue to the lock's entry queue, then competes for the lock.

**Real-World**: This is functionally identical to `ArrayBlockingQueue`. The two-condition design (vs. single `wait()/notifyAll()`) reduces unnecessary wakeups by a factor of N (where N is the number of threads of the wrong type that would be woken by `notifyAll()`).

---

### Problem 7.18 [Medium] -- Concurrent Bounded Counter with CAS

**Statement**: Implement a bounded counter (min=0, max=N) using only `AtomicInteger` and CAS. `increment()` returns false when at max, `decrement()` returns false when at 0. Must be lock-free.

**Solution**:

```java
import java.util.concurrent.atomic.AtomicInteger;

public class BoundedCounter {
    private final AtomicInteger count = new AtomicInteger(0);
    private final int max;

    public BoundedCounter(int max) {
        this.max = max;
    }

    public boolean increment() {
        while (true) {
            int current = count.get();
            if (current >= max) return false;
            if (count.compareAndSet(current, current + 1)) return true;
            // CAS failed — another thread modified count. Retry.
        }
    }

    public boolean decrement() {
        while (true) {
            int current = count.get();
            if (current <= 0) return false;
            if (count.compareAndSet(current, current - 1)) return true;
        }
    }

    public int get() { return count.get(); }
}
```

**Why this is lock-free but not wait-free**: In the worst case, a single thread could be starved indefinitely if other threads keep succeeding with their CAS operations. But system-wide progress is always made — at least one thread succeeds per round. Lock-free means "some thread makes progress in every step." Wait-free (stronger) means "every thread makes progress in bounded steps."

**Complexity**: O(1) amortized. The CAS loop retries are bounded by the number of concurrent modifiers.

**JVM Insight**: `AtomicInteger.compareAndSet()` compiles to `LOCK cmpxchg` on x86. The `LOCK` prefix ensures the compare-and-swap is atomic across all cores by locking the cache line. The read (`count.get()`) is a volatile read — on x86, this is a plain `MOV` instruction (no barrier needed). The CAS loop pattern (read, compute, CAS, retry) is called a **CAS spin loop** and is the foundation of all lock-free data structures.

**Real-World**: This pattern is used for semaphore implementations (the Semaphore permit count), connection pool slot management, and rate limiter token tracking.

---

### Problem 7.19 [Medium] -- Concurrent Iterator with Snapshot

**Statement**: Implement a thread-safe list that supports concurrent modifications during iteration. The iterator must reflect a snapshot of the list at the time of creation. Do not use `CopyOnWriteArrayList`.

**Solution**:

```java
import java.util.*;
import java.util.concurrent.locks.ReentrantReadWriteLock;

public class SnapshotList<E> implements Iterable<E> {
    private volatile Object[] elements = new Object[0];
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

    public void add(E item) {
        lock.writeLock().lock();
        try {
            Object[] newElements = Arrays.copyOf(elements, elements.length + 1);
            newElements[elements.length] = item;
            elements = newElements;  // volatile write
        } finally {
            lock.writeLock().unlock();
        }
    }

    @SuppressWarnings("unchecked")
    public E get(int index) {
        // Volatile read of elements gets latest array.
        // Array contents are immutable once published.
        Object[] snapshot = elements;
        if (index < 0 || index >= snapshot.length)
            throw new IndexOutOfBoundsException();
        return (E) snapshot[index];
    }

    public boolean remove(E item) {
        lock.writeLock().lock();
        try {
            Object[] current = elements;
            for (int i = 0; i < current.length; i++) {
                if (Objects.equals(current[i], item)) {
                    Object[] newElements = new Object[current.length - 1];
                    System.arraycopy(current, 0, newElements, 0, i);
                    System.arraycopy(current, i + 1, newElements, i,
                                     current.length - i - 1);
                    elements = newElements;
                    return true;
                }
            }
            return false;
        } finally {
            lock.writeLock().unlock();
        }
    }

    @Override
    public Iterator<E> iterator() {
        // Capture the current array reference — snapshot semantics
        final Object[] snapshot = elements;  // volatile read
        return new Iterator<E>() {
            private int cursor = 0;
            @Override public boolean hasNext() { return cursor < snapshot.length; }
            @SuppressWarnings("unchecked")
            @Override public E next() {
                if (cursor >= snapshot.length) throw new NoSuchElementException();
                return (E) snapshot[cursor++];
            }
        };
    }
}
```

This is essentially what `CopyOnWriteArrayList` does internally. The key guarantee: once an array is published via a volatile write, it is never modified. All future modifications create a new array. Iterators hold a reference to the old array, which remains valid and immutable.

**Complexity**: Read O(1), Write O(n) (array copy), Iteration O(n).

**JVM Insight**: The `volatile` write to `elements` establishes a happens-before edge. Any thread that subsequently reads `elements` is guaranteed to see the full contents of the new array (including all elements written before the volatile store). The old array is eligible for GC once no thread holds a reference to it. If an iterator is iterating over the old array, it keeps the old array alive until iteration completes.

**Real-World**: This copy-on-write pattern is used in Clojure's persistent data structures, Scala's immutable collections, and any system that prefers read performance over write performance.

---

### Problem 7.20 [Medium] -- Phaser-Based Pipeline

**Statement**: Implement a 3-stage pipeline where Stage 1 produces data, Stage 2 transforms it, and Stage 3 consumes it. Each stage must complete processing all items for a batch before any stage starts the next batch. Use `Phaser`.

**Solution**:

```java
import java.util.concurrent.Phaser;

public class PhasedPipeline {
    private final Phaser phaser;
    private final int batches;
    private volatile int[] data;

    public PhasedPipeline(int batches) {
        this.batches = batches;
        // 3 parties: one per stage
        this.phaser = new Phaser(3);
    }

    public void runPipeline() {
        Thread producer = new Thread(() -> {
            for (int batch = 0; batch < batches; batch++) {
                // Phase 0, 3, 6, ... : produce
                data = new int[]{batch * 10, batch * 10 + 1, batch * 10 + 2};
                System.out.println("Produced batch " + batch);
                phaser.arriveAndAwaitAdvance();  // Wait for all stages
                phaser.arriveAndAwaitAdvance();  // Wait for transform
                phaser.arriveAndAwaitAdvance();  // Wait for consume
            }
            phaser.arriveAndDeregister();
        });

        Thread transformer = new Thread(() -> {
            for (int batch = 0; batch < batches; batch++) {
                phaser.arriveAndAwaitAdvance();  // Wait for produce
                // Phase 1, 4, 7, ... : transform
                for (int i = 0; i < data.length; i++) data[i] *= 2;
                System.out.println("Transformed batch " + batch);
                phaser.arriveAndAwaitAdvance();  // Wait for all stages
                phaser.arriveAndAwaitAdvance();  // Wait for consume
            }
            phaser.arriveAndDeregister();
        });

        Thread consumer = new Thread(() -> {
            for (int batch = 0; batch < batches; batch++) {
                phaser.arriveAndAwaitAdvance();  // Wait for produce
                phaser.arriveAndAwaitAdvance();  // Wait for transform
                // Phase 2, 5, 8, ... : consume
                System.out.println("Consumed batch " + batch +
                    ": " + java.util.Arrays.toString(data));
                phaser.arriveAndAwaitAdvance();  // Wait for all stages
            }
            phaser.arriveAndDeregister();
        });

        producer.start(); transformer.start(); consumer.start();
    }
}
```

**`Phaser` vs `CyclicBarrier`**: `Phaser` supports dynamic registration/deregistration of parties. Threads can join or leave between phases. `CyclicBarrier` has a fixed number of parties set at construction. `Phaser` also supports hierarchical phasing (tree of phasers) for scalability.

**Complexity**: O(batches * dataSize). Synchronization overhead is O(1) per phase per thread.

**JVM Insight**: `Phaser` internally uses a single `long state` field packed with phase number, party count, and unarrived count. State transitions use CAS. Waiting threads park with `LockSupport.park()`. The hierarchical phaser design (tiered phasers) reduces CAS contention when hundreds of threads are involved, similar to how `LongAdder` distributes counter updates.

**Real-World**: GPU compute pipelines process data in batches with barrier synchronization between stages. MapReduce frameworks synchronize between map and reduce phases. Game engines use barrier synchronization between physics, rendering, and input processing stages.

---

### Problem 7.21 [Medium] -- Exchanger-Based Double Buffering

**Statement**: Two threads alternate filling and draining a buffer. Thread A fills buffer 1 while Thread B drains buffer 2, then they swap. Implement using `Exchanger`.

**Solution**:

```java
import java.util.*;
import java.util.concurrent.Exchanger;

public class DoubleBuffering {
    public static void main(String[] args) {
        Exchanger<List<Integer>> exchanger = new Exchanger<>();
        int batches = 10;

        Thread producer = new Thread(() -> {
            List<Integer> buffer = new ArrayList<>();
            try {
                for (int batch = 0; batch < batches; batch++) {
                    // Fill the buffer
                    buffer.clear();
                    for (int i = 0; i < 100; i++) {
                        buffer.add(batch * 100 + i);
                    }
                    System.out.println("Producer filled batch " + batch);
                    // Exchange: give full buffer, receive empty buffer
                    buffer = exchanger.exchange(buffer);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });

        Thread consumer = new Thread(() -> {
            List<Integer> buffer = new ArrayList<>();
            try {
                for (int batch = 0; batch < batches; batch++) {
                    // Exchange: give empty buffer, receive full buffer
                    buffer = exchanger.exchange(buffer);
                    System.out.println("Consumer processing batch " + batch +
                        " size=" + buffer.size());
                    // Process and clear
                    long sum = buffer.stream().mapToLong(Integer::longValue).sum();
                    System.out.println("  Sum: " + sum);
                    buffer.clear();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });

        producer.start();
        consumer.start();
    }
}
```

**`Exchanger` semantics**: `exchange(V x)` blocks until another thread calls `exchange(V y)`. Then both threads atomically swap their objects. Thread A receives y, Thread B receives x.

**Complexity**: O(batchSize) per batch. Exchange is O(1).

**JVM Insight**: `Exchanger` uses a slot-based algorithm with arena for high contention. Under low contention, it uses a single slot with CAS. Under high contention (detected by CAS failures), it spreads across an arena of multiple slots to reduce contention, similar to `LongAdder`'s cell spreading.

**Real-World**: Double-buffering is used in GPU rendering (front buffer displayed while back buffer is drawn), audio processing (one buffer played while another is filled), and network I/O (one buffer sent while another is filled by the application). Netty's `ByteBuf` pooling uses similar swap-based patterns.

---

### Problem 7.22 [Medium] -- Lock-Free Stack

**Statement**: Implement a thread-safe stack using CAS. Support `push()` and `pop()`. Must be lock-free.

**Solution**:

```java
import java.util.concurrent.atomic.AtomicReference;

public class LockFreeStack<E> {
    private static class Node<E> {
        final E value;
        Node<E> next;
        Node(E value) { this.value = value; }
    }

    private final AtomicReference<Node<E>> top = new AtomicReference<>(null);

    public void push(E value) {
        Node<E> newNode = new Node<>(value);
        while (true) {
            Node<E> currentTop = top.get();
            newNode.next = currentTop;
            if (top.compareAndSet(currentTop, newNode)) {
                return;  // CAS succeeded — newNode is the new top
            }
            // CAS failed — another thread pushed/popped. Retry.
        }
    }

    public E pop() {
        while (true) {
            Node<E> currentTop = top.get();
            if (currentTop == null) return null;  // Stack is empty
            Node<E> newTop = currentTop.next;
            if (top.compareAndSet(currentTop, newTop)) {
                return currentTop.value;
            }
            // CAS failed — retry
        }
    }

    public E peek() {
        Node<E> t = top.get();
        return t == null ? null : t.value;
    }
}
```

**The ABA problem**: Consider this sequence:
1. Thread A reads top = Node(X) → Node(Y).
2. Thread B pops X, pops Y, pushes X back (with a different next pointer).
3. Thread A does CAS(top, X, Y) — **succeeds** because top is X again. But X's `next` has changed.

For this specific stack implementation, ABA is safe because we set `newNode.next = currentTop` before the CAS, and the CAS only succeeds if `top` still points to `currentTop`. Even if `currentTop` was popped and re-pushed, the stack structure remains valid.

For general lock-free data structures, ABA is solved by `AtomicStampedReference` (adds a version stamp) or by using a garbage-collected language (like Java, where popped nodes are not reused — each `new Node()` creates a unique object).

**Complexity**: O(1) amortized for push and pop. CAS retries are bounded by contention.

**JVM Insight**: `AtomicReference` stores the reference in a field accessed via `Unsafe.compareAndSwapObject()`. On x86, this compiles to `LOCK cmpxchg`. The `Node` objects are allocated on the heap (TLAB fast path). Popped nodes become garbage and are collected by the GC — no explicit memory management needed, which is a huge advantage over C++ lock-free stacks that must deal with memory reclamation (hazard pointers, epoch-based reclamation).

**Real-World**: The Treiber stack (this algorithm) is a classic lock-free data structure. It is used in `ForkJoinPool`'s work-stealing deques (the LIFO end) and in various object pool implementations.

---

### Problem 7.23 [Medium] -- Scheduled Task Executor with DelayQueue

**Statement**: Implement a simple scheduled executor that accepts tasks with delays. Tasks execute after their delay expires, in delay order. Support `schedule(Runnable, delay, TimeUnit)`.

**Solution**:

```java
import java.util.concurrent.*;

public class SimpleScheduledExecutor {
    static class DelayedTask implements Delayed {
        private final Runnable task;
        private final long executeAt;  // nanoTime when task should run

        DelayedTask(Runnable task, long delay, TimeUnit unit) {
            this.task = task;
            this.executeAt = System.nanoTime() + unit.toNanos(delay);
        }

        @Override
        public long getDelay(TimeUnit unit) {
            return unit.convert(executeAt - System.nanoTime(), TimeUnit.NANOSECONDS);
        }

        @Override
        public int compareTo(Delayed o) {
            return Long.compare(this.executeAt, ((DelayedTask) o).executeAt);
        }
    }

    private final DelayQueue<DelayedTask> queue = new DelayQueue<>();
    private final ExecutorService executor;
    private volatile boolean running = true;

    public SimpleScheduledExecutor(int threads) {
        this.executor = Executors.newFixedThreadPool(threads);
        // Start a dispatcher thread
        Thread dispatcher = new Thread(() -> {
            while (running) {
                try {
                    DelayedTask task = queue.take();  // Blocks until task is ready
                    executor.submit(task.task);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }, "scheduler-dispatcher");
        dispatcher.setDaemon(true);
        dispatcher.start();
    }

    public void schedule(Runnable task, long delay, TimeUnit unit) {
        queue.put(new DelayedTask(task, delay, unit));
    }

    public void shutdown() {
        running = false;
        executor.shutdown();
    }
}
```

**Complexity**: `schedule()` is O(log n) (heap insertion in `PriorityQueue` inside `DelayQueue`). `take()` is O(log n) (heap extraction). The dispatcher thread is single-threaded, so task dispatch is serialized, but task execution is parallel via the `ExecutorService`.

**JVM Insight**: `DelayQueue.take()` uses the leader-follower pattern: one thread (the "leader") waits with a timed `await()` for the earliest task, while other threads wait indefinitely. When the leader wakes and takes the task, it signals the next waiter to become the new leader. This minimizes unnecessary timer wakeups. `ScheduledThreadPoolExecutor` uses the same approach internally with a `DelayedWorkQueue`.

**Real-World**: `ScheduledThreadPoolExecutor` is the production version of this. It adds support for periodic scheduling (`scheduleAtFixedRate`, `scheduleWithFixedDelay`), cancellation, and exception handling. Timer-based systems like Netty's `HashedWheelTimer` use a different approach (a circular array of buckets indexed by time) for O(1) insertion at the cost of timing granularity.

---

### Problem 7.24 [Hard] -- Design Thread Pool from Scratch

**Statement**: Implement a simplified `ThreadPoolExecutor` with: fixed number of worker threads, a bounded work queue, rejection when queue is full, and graceful shutdown.

**Solution**:

```java
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

public class SimpleThreadPool {
    private final BlockingQueue<Runnable> workQueue;
    private final Thread[] workers;
    private final AtomicBoolean isShutdown = new AtomicBoolean(false);

    public SimpleThreadPool(int poolSize, int queueCapacity) {
        this.workQueue = new ArrayBlockingQueue<>(queueCapacity);
        this.workers = new Thread[poolSize];
        for (int i = 0; i < poolSize; i++) {
            workers[i] = new Thread(() -> {
                while (!isShutdown.get() || !workQueue.isEmpty()) {
                    try {
                        Runnable task = workQueue.poll(100, TimeUnit.MILLISECONDS);
                        if (task != null) {
                            try {
                                task.run();
                            } catch (Exception e) {
                                // In production: use an UncaughtExceptionHandler
                                System.err.println("Task failed: " + e.getMessage());
                            }
                        }
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            }, "pool-worker-" + i);
            workers[i].setDaemon(false);
            workers[i].start();
        }
    }

    public boolean submit(Runnable task) {
        if (isShutdown.get()) {
            throw new RejectedExecutionException("Pool is shut down");
        }
        return workQueue.offer(task);
        // offer() returns false if queue is full — this is our rejection policy.
        // ThreadPoolExecutor has configurable rejection policies:
        //   AbortPolicy (throw), CallerRunsPolicy (run in submitter's thread),
        //   DiscardPolicy (silently drop), DiscardOldestPolicy (drop oldest, retry)
    }

    public void shutdown() {
        isShutdown.set(true);
        // Workers will drain the queue and exit.
        // We do NOT interrupt workers — let them finish current tasks.
    }

    public void shutdownNow() {
        isShutdown.set(true);
        for (Thread w : workers) {
            w.interrupt();  // Interrupts workers blocked on poll()
        }
    }

    public boolean awaitTermination(long timeout, TimeUnit unit)
            throws InterruptedException {
        long deadline = System.nanoTime() + unit.toNanos(timeout);
        for (Thread w : workers) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) return false;
            w.join(remaining / 1_000_000);
            if (w.isAlive()) return false;
        }
        return true;
    }
}
```

**Complexity**: `submit()` is O(1) (queue offer). Worker threads run tasks sequentially — throughput is `poolSize * taskRate`.

**JVM Insight**: `ThreadPoolExecutor`'s actual implementation is more sophisticated. It uses a single `AtomicInteger ctl` field that packs both the pool state (RUNNING, SHUTDOWN, STOP, TIDYING, TERMINATED) in the high 3 bits and the worker count in the low 29 bits. State transitions use CAS on this field. Worker threads are wrapped in a `Worker` class that extends AQS to implement a non-reentrant lock (to detect whether a worker is executing a task — needed for `shutdownNow` to avoid interrupting idle vs. active workers).

**Real-World**: `ThreadPoolExecutor` is the backbone of Java concurrency. Tomcat, Jetty, Undertow, and every Java web server uses thread pools. Key tuning parameters: core pool size, max pool size, keep-alive time, queue type (bounded vs unbounded), and rejection policy. The most common mistake is using an unbounded queue (`LinkedBlockingQueue` without capacity), which means the pool never creates threads beyond the core size, and the queue grows until OOM.

---

### Problem 7.25 [Hard] -- Lock-Free Ring Buffer (Disruptor Style)

**Statement**: Implement a single-producer, single-consumer lock-free ring buffer using `volatile` sequence counters and spin-waiting. Target: zero object allocation on the critical path.

**Solution**:

```java
public class SPSCRingBuffer<E> {
    private final Object[] buffer;
    private final int mask;

    // Sequence counters on separate cache lines to prevent false sharing
    private volatile long writeSequence = 0;
    private long p1, p2, p3, p4, p5, p6, p7;  // 56 bytes padding
    private volatile long readSequence = 0;
    private long p8, p9, p10, p11, p12, p13, p14;  // 56 bytes padding

    // Cached counterpart sequences (only read by one thread)
    private long cachedReadSequence = 0;   // Producer caches consumer's position
    private long cachedWriteSequence = 0;  // Consumer caches producer's position

    @SuppressWarnings("unchecked")
    public SPSCRingBuffer(int capacity) {
        if (Integer.bitCount(capacity) != 1)
            throw new IllegalArgumentException("Capacity must be power of 2");
        this.buffer = new Object[capacity];
        this.mask = capacity - 1;
    }

    // Called by producer thread ONLY
    public boolean offer(E item) {
        long nextWrite = writeSequence;
        // Check if buffer is full
        // We cache the readSequence to avoid volatile reads on every offer
        if (nextWrite - cachedReadSequence >= buffer.length) {
            cachedReadSequence = readSequence;  // volatile read
            if (nextWrite - cachedReadSequence >= buffer.length) {
                return false;  // Buffer full
            }
        }
        buffer[(int)(nextWrite & mask)] = item;
        writeSequence = nextWrite + 1;  // volatile write — publishes the item
        return true;
    }

    // Called by consumer thread ONLY
    @SuppressWarnings("unchecked")
    public E poll() {
        long nextRead = readSequence;
        // Check if buffer is empty
        if (nextRead >= cachedWriteSequence) {
            cachedWriteSequence = writeSequence;  // volatile read
            if (nextRead >= cachedWriteSequence) {
                return null;  // Buffer empty
            }
        }
        E item = (E) buffer[(int)(nextRead & mask)];
        readSequence = nextRead + 1;  // volatile write — frees the slot
        return item;
    }
}
```

**Why this is fast**:
1. **No locks, no CAS**: Single-producer + single-consumer means no contention on sequence counters. Volatile writes are sufficient.
2. **Cached sequences**: The producer caches the consumer's read position and only refreshes it (volatile read) when it thinks the buffer might be full. This reduces cross-core volatile reads from every operation to once per buffer-full event.
3. **Power-of-2 capacity**: `index & mask` replaces `index % capacity`. Bit masking is one CPU cycle; modulo division is 20-40 cycles.
4. **False sharing prevention**: Padding separates the write and read sequences onto different cache lines.
5. **Zero allocation**: The ring buffer and its backing array are allocated once. No object creation during offer/poll.

**Complexity**: O(1) for both offer and poll. Amortized zero volatile reads due to caching.

**JVM Insight**: The LMAX Disruptor uses this exact pattern (with more sophistication for multi-consumer scenarios). On x86, the volatile write to `writeSequence` emits a `LOCK addl $0, (%rsp)` instruction (StoreLoad barrier), which is the only hardware cost. The volatile read of `readSequence` is free (plain `MOV` on x86). The Disruptor achieves 6+ million messages per second on a single thread pair because the critical path is: array store, volatile long store — about 30ns total.

**Real-World**: LMAX Disruptor (financial exchange matching engine), Aeron (ultra-low-latency messaging), Log4j2 AsyncLogger (lock-free log event buffer). These all use ring buffers with sequence counters for maximum throughput.

---

### Problem 7.26 [Hard] -- Multi-Producer Multi-Consumer Queue

**Statement**: Extend the ring buffer to support multiple producers and multiple consumers. Use CAS for sequence claiming.

**Solution**:

```java
import java.util.concurrent.atomic.AtomicLong;

public class MPMCRingBuffer<E> {
    private final Object[] buffer;
    private final int[] flags;  // Publication status per slot
    private final int mask;
    private final AtomicLong writeCounter = new AtomicLong(0);
    private final AtomicLong readCounter = new AtomicLong(0);

    @SuppressWarnings("unchecked")
    public MPMCRingBuffer(int capacity) {
        if (Integer.bitCount(capacity) != 1)
            throw new IllegalArgumentException("Capacity must be power of 2");
        this.buffer = new Object[capacity];
        this.flags = new int[capacity];
        this.mask = capacity - 1;
    }

    public boolean offer(E item) {
        long claimed;
        do {
            claimed = writeCounter.get();
            long readPos = readCounter.get();
            if (claimed - readPos >= buffer.length) {
                return false;  // Buffer full
            }
        } while (!writeCounter.compareAndSet(claimed, claimed + 1));

        // We have exclusively claimed slot 'claimed'.
        int index = (int)(claimed & mask);
        buffer[index] = item;
        // Publish: signal that this slot is ready for consumption.
        // Use a flag array to handle out-of-order publication.
        // Flag value = wrap count (how many times we have wrapped around).
        // Consumers wait until the flag matches the expected wrap count.
        flags[index] = (int)(claimed / buffer.length) + 1;
        return true;
    }

    @SuppressWarnings("unchecked")
    public E poll() {
        long claimed;
        do {
            claimed = readCounter.get();
            int index = (int)(claimed & mask);
            int expectedFlag = (int)(claimed / buffer.length) + 1;
            if (flags[index] != expectedFlag) {
                return null;  // Slot not yet published (or buffer empty)
            }
        } while (!readCounter.compareAndSet(claimed, claimed + 1));

        int index = (int)(claimed & mask);
        E item = (E) buffer[index];
        buffer[index] = null;
        flags[index] = 0;  // Reset flag
        return item;
    }
}
```

**Why MPMC is harder than SPSC**: With multiple producers, two producers might claim the same slot. CAS on the write counter solves this — only one wins. But the winner might be slow to publish (write the data into the slot). A fast consumer might see the incremented write counter and try to read the slot before data is written. The `flags` array solves this: consumers check the flag to ensure the data is published before reading.

**Complexity**: O(1) amortized. CAS contention bounded by the number of producers/consumers.

**JVM Insight**: The `AtomicLong` CAS on `writeCounter` is the primary contention point. Under high write contention, producers spin on this CAS. The JDK's `ConcurrentLinkedQueue` avoids this bottleneck with the Michael-Scott algorithm, which uses node-level CAS instead of a global counter. For maximum MPMC throughput, JCTools (Java Concurrency Tools library) provides hand-tuned MPMC queues that use padded sequence fields per slot (avoiding the global counter entirely).

**Real-World**: JCTools' `MpmcArrayQueue` is used in Netty, Reactor, and RxJava for internal message passing. Kafka's record accumulator batches records into per-partition buffers using a similar multi-producer pattern.

---

### Problem 7.27 [Hard] -- Concurrent B+ Tree Sketch

**Statement**: Describe the key challenges of implementing a concurrent B+ tree and outline a lock-coupling (crabbing) protocol. Implement the `search()` method with hand-over-hand locking.

**Solution**:

```java
import java.util.concurrent.locks.ReentrantReadWriteLock;

public class ConcurrentBPlusTree<K extends Comparable<K>, V> {
    static class Node<K, V> {
        K[] keys;
        int keyCount;
        boolean isLeaf;
        ReentrantReadWriteLock lock = new ReentrantReadWriteLock();
    }

    static class InternalNode<K, V> extends Node<K, V> {
        Node<K, V>[] children;
    }

    static class LeafNode<K, V> extends Node<K, V> {
        V[] values;
        LeafNode<K, V> next;  // Sibling pointer for range scans
    }

    private volatile Node<K, V> root;

    // Lock-coupling (crabbing) search:
    // 1. Lock the root (read lock).
    // 2. Find the appropriate child.
    // 3. Lock the child (read lock).
    // 4. Unlock the parent. (The child is now "safe" — we hold its lock.)
    // 5. Repeat until we reach the leaf.

    @SuppressWarnings("unchecked")
    public V search(K key) {
        Node<K, V> current = root;
        current.lock.readLock().lock();
        try {
            while (!current.isLeaf) {
                InternalNode<K, V> internal = (InternalNode<K, V>) current;
                int childIndex = findChildIndex(internal, key);
                Node<K, V> child = internal.children[childIndex];

                // Hand-over-hand: lock child, then unlock parent
                child.lock.readLock().lock();
                current.lock.readLock().unlock();
                current = child;
            }
            // current is now the leaf node, with read lock held
            LeafNode<K, V> leaf = (LeafNode<K, V>) current;
            for (int i = 0; i < leaf.keyCount; i++) {
                if (leaf.keys[i].compareTo(key) == 0) {
                    return leaf.values[i];
                }
            }
            return null;
        } finally {
            current.lock.readLock().unlock();
        }
    }

    // For insert: use write locks and check if node is "safe" (won't split).
    // If safe, release all ancestor locks — the insert cannot propagate up.
    // This is the Bayer-Schkolnick crabbing protocol.

    private int findChildIndex(InternalNode<K, V> node, K key) {
        // Binary search in node.keys to find the right child pointer
        int lo = 0, hi = node.keyCount - 1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            int cmp = node.keys[mid].compareTo(key);
            if (cmp <= 0) lo = mid + 1;
            else hi = mid - 1;
        }
        return lo;
    }
}
```

**Lock-coupling protocol**: The key insight is that you hold at most two locks simultaneously — the parent and the child. Once you lock the child, you release the parent. This provides a bounded lock footprint (height of the tree at most) and prevents deadlock (locks are always acquired top-down).

**For inserts**, the protocol is more nuanced: you acquire write locks on the path down. When you reach a node that is "safe" (will not split because it has room), you release ALL ancestor write locks. This means only the nodes that might actually be modified are locked, dramatically reducing contention.

**Complexity**: Search O(log n) with O(1) locks held at any time. Insert O(log n) worst case, but in practice most inserts only lock the leaf.

**JVM Insight**: `ReentrantReadWriteLock` supports lock downgrading (write lock to read lock) but not upgrading. The read lock allows concurrent readers at each node. The write lock provides exclusion during structural modifications. In practice, concurrent B+ trees in database engines (InnoDB, PostgreSQL) use more optimized latch implementations (spinlocks with backoff) rather than `ReentrantReadWriteLock`.

**Real-World**: InnoDB (MySQL) uses a B+ tree with optimistic lock-coupling for searches and pessimistic lock-coupling for inserts. PostgreSQL uses a variant called Lehman-Yao B-trees, which add right-link pointers to handle concurrent splits without holding locks on the parent.

---

### Problem 7.28 [Hard] -- Concurrent Trie (Prefix Map)

**Statement**: Implement a thread-safe trie that supports concurrent `insert()` and `search()`. Use CAS for node creation.

**Solution**:

```java
import java.util.concurrent.atomic.AtomicReferenceArray;

public class ConcurrentTrie {
    static class TrieNode {
        // 26 children for lowercase letters, each accessed atomically
        final AtomicReferenceArray<TrieNode> children
            = new AtomicReferenceArray<>(26);
        volatile boolean isEnd = false;
    }

    private final TrieNode root = new TrieNode();

    public void insert(String word) {
        TrieNode current = root;
        for (int i = 0; i < word.length(); i++) {
            int idx = word.charAt(i) - 'a';
            TrieNode child = current.children.get(idx);
            if (child == null) {
                TrieNode newNode = new TrieNode();
                // CAS: only one thread creates the node for this character
                if (!current.children.compareAndSet(idx, null, newNode)) {
                    // Another thread beat us — use their node
                    child = current.children.get(idx);
                } else {
                    child = newNode;
                }
            }
            current = child;
        }
        current.isEnd = true;  // volatile write
    }

    public boolean search(String word) {
        TrieNode current = root;
        for (int i = 0; i < word.length(); i++) {
            int idx = word.charAt(i) - 'a';
            current = current.children.get(idx);  // volatile read
            if (current == null) return false;
        }
        return current.isEnd;  // volatile read
    }

    public boolean startsWith(String prefix) {
        TrieNode current = root;
        for (int i = 0; i < prefix.length(); i++) {
            int idx = prefix.charAt(i) - 'a';
            current = current.children.get(idx);
            if (current == null) return false;
        }
        return true;
    }
}
```

**Complexity**: Insert O(L) where L is word length. Search O(L). CAS failures during insert are bounded by the number of concurrent inserters for the same character — typically rare.

**JVM Insight**: `AtomicReferenceArray` uses `Unsafe.getObjectVolatile()` and `Unsafe.compareAndSwapObject()` for per-element volatile access. Each element of the internal `Object[]` array is accessed as if it were a `volatile` field. Note that a regular `TrieNode[]` array would NOT provide volatile semantics for individual elements — you would see stale child references. `AtomicReferenceArray` is the correct choice for concurrent access to array elements.

**Real-World**: Concurrent tries are used in IP routing tables (longest prefix match), DNS resolution caches, and auto-complete systems. The Ctrie (concurrent trie) by Prokopec et al. uses a more sophisticated approach with indirection nodes and atomic snapshots for consistent iteration.

---

### Problem 7.29 [Hard] -- Striped Read-Write Lock with StampedLock

**Statement**: Implement a concurrent hash set that uses `StampedLock`'s optimistic reading for `contains()`, falling back to pessimistic read lock on validation failure. Writes use the write lock.

**Solution**:

```java
import java.util.concurrent.locks.StampedLock;

public class OptimisticHashSet<E> {
    private static final int NUM_STRIPES = 16;
    private final StampedLock[] locks;
    private final Object[][] buckets;
    private final int capacity;

    @SuppressWarnings("unchecked")
    public OptimisticHashSet(int capacity) {
        this.capacity = capacity;
        this.buckets = new Object[capacity][];
        this.locks = new StampedLock[NUM_STRIPES];
        for (int i = 0; i < NUM_STRIPES; i++) locks[i] = new StampedLock();
    }

    private int bucket(Object key) {
        return (key.hashCode() & 0x7FFFFFFF) % capacity;
    }

    private int stripe(int bucket) { return bucket % NUM_STRIPES; }

    public boolean contains(E item) {
        int b = bucket(item);
        StampedLock sl = locks[stripe(b)];

        // Optimistic read — no lock acquired!
        long stamp = sl.tryOptimisticRead();
        Object[] chain = buckets[b];
        boolean found = searchChain(chain, item);

        // Validate: was the data modified while we were reading?
        if (sl.validate(stamp)) {
            return found;  // No concurrent write — result is valid
        }

        // Optimistic read failed — fall back to pessimistic read lock
        stamp = sl.readLock();
        try {
            chain = buckets[b];
            return searchChain(chain, item);
        } finally {
            sl.unlockRead(stamp);
        }
    }

    public boolean add(E item) {
        int b = bucket(item);
        StampedLock sl = locks[stripe(b)];
        long stamp = sl.writeLock();
        try {
            Object[] chain = buckets[b];
            if (searchChain(chain, item)) return false;  // Already present

            // Add to chain (copy-on-write for the chain)
            if (chain == null) {
                buckets[b] = new Object[]{item};
            } else {
                Object[] newChain = new Object[chain.length + 1];
                System.arraycopy(chain, 0, newChain, 0, chain.length);
                newChain[chain.length] = item;
                buckets[b] = newChain;
            }
            return true;
        } finally {
            sl.unlockWrite(stamp);
        }
    }

    private boolean searchChain(Object[] chain, E item) {
        if (chain == null) return false;
        for (Object o : chain) {
            if (item.equals(o)) return true;
        }
        return false;
    }
}
```

**Performance advantage of optimistic reads**: Under a 95% read / 5% write workload with 32 threads, optimistic reads avoid modifying the lock's state entirely. With `ReentrantReadWriteLock`, every read lock acquisition increments a shared counter (CAS), causing cache line bouncing under high reader contention. `StampedLock`'s optimistic read simply reads the lock's version stamp — no CAS, no shared state modification, no contention.

**Complexity**: `contains()` O(chain length) with zero synchronization overhead (optimistic path). `add()` O(chain length) with write lock.

**JVM Insight**: `tryOptimisticRead()` reads the stamp (a `volatile long` — essentially the lock's version number). `validate(stamp)` checks if the stamp has changed (another volatile read). On x86, both are plain `MOV` instructions — zero barrier cost. The only cost is the possibility of retry if a writer intervened, which is rare under read-heavy workloads.

**Real-World**: The Java `VarHandle` API (JDK 9+) provides similar optimistic patterns. High-frequency trading systems use `StampedLock` (or custom equivalents) for order book data structures where reads (price lookups) vastly outnumber writes (order insertions/cancellations).

---

### Problem 7.30 [Hard] -- Compare-And-Swap Universal Construction

**Statement**: Demonstrate that CAS can implement any sequential data structure as a concurrent data structure (universal construction). Implement a generic lock-free wrapper that makes any sequential data structure thread-safe.

**Solution**:

```java
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

public class LockFreeWrapper<S> {
    // The state is an immutable snapshot. Every modification creates a new one.
    private final AtomicReference<S> state;

    public LockFreeWrapper(S initialState) {
        this.state = new AtomicReference<>(initialState);
    }

    // Read: just return the current state. Lock-free, wait-free even.
    public S read() {
        return state.get();  // volatile read
    }

    // Modify: apply a function that takes the old state and returns a new state.
    // The function MUST be pure — it may be called multiple times on CAS failure.
    // The function MUST return a new state (not modify the old one).
    public <R> R modify(Function<S, ModifyResult<S, R>> operation) {
        while (true) {
            S current = state.get();
            ModifyResult<S, R> result = operation.apply(current);
            if (state.compareAndSet(current, result.newState)) {
                return result.returnValue;
            }
            // CAS failed — another thread modified state. Retry with fresh state.
        }
    }

    public static class ModifyResult<S, R> {
        final S newState;
        final R returnValue;
        ModifyResult(S newState, R returnValue) {
            this.newState = newState;
            this.returnValue = returnValue;
        }
    }

    // Example: Concurrent counter using universal construction
    // State is an immutable Integer. Each increment creates a new Integer.
    public static void main(String[] args) throws InterruptedException {
        LockFreeWrapper<Integer> counter = new LockFreeWrapper<>(0);

        Thread[] threads = new Thread[10];
        for (int i = 0; i < 10; i++) {
            threads[i] = new Thread(() -> {
                for (int j = 0; j < 10000; j++) {
                    counter.modify(current ->
                        new ModifyResult<>(current + 1, null));
                }
            });
            threads[i].start();
        }
        for (Thread t : threads) t.join();
        System.out.println("Final: " + counter.read());  // 100000
    }
}
```

**Why this is "universal"**: Any sequential data structure can be wrapped this way by making the state immutable and creating new copies on modification. The CAS loop ensures linearizability — every successful CAS establishes a total order on modifications.

**The catch**: This is simple but not efficient. Each modification copies the entire state. For a list of 10,000 elements, each modification copies 10,000 elements. This is why specialized concurrent data structures exist — they exploit the specific structure to allow fine-grained concurrency.

**Persistent data structures** (Clojure's approach) improve on this: instead of copying the entire state, they share structure between old and new versions (structural sharing). A persistent vector can be "modified" in O(log n) by creating new path copies from root to the changed leaf.

**Complexity**: `read()` is O(1). `modify()` is O(copy_cost * expected_retries). For small states, this is efficient. For large states, use a specialized concurrent structure.

**JVM Insight**: This is essentially how `AtomicReference.updateAndGet()` works (added in JDK 8):
```java
AtomicReference<List<String>> ref = new AtomicReference<>(List.of());
ref.updateAndGet(list -> {
    List<String> newList = new ArrayList<>(list);
    newList.add("item");
    return Collections.unmodifiableList(newList);
});
```
The JVM's garbage collector handles the old, discarded states. In a GC-based language, universal construction is more practical than in C++ because discarded state copies are automatically reclaimed.

**Real-World**: Clojure's atoms use exactly this pattern (CAS + immutable state + retry). Scala's `Ref` in STM (Software Transactional Memory) is similar but adds multi-variable transactions. React/Redux's state management uses the same principle — state is immutable, updates create new state objects, and a single atomic reference (the store) holds the current state.

---

## Key Takeaways

1. **The Java Memory Model is your contract.** Without a happens-before edge between a write and a read, the JVM makes zero guarantees about visibility. `volatile` provides visibility through memory barriers. `synchronized` provides both visibility and atomicity. CAS provides both plus lock-freedom. Choose the lightest tool that gives you the guarantee you need.

2. **ConcurrentHashMap is not "HashMap with locks."** JDK 8+ uses CAS on empty bins, synchronized on occupied bins, lock-free reads via volatile Node fields, cooperative resizing with ForwardingNodes, and LongAdder-style striped counters. Understanding these mechanisms is the difference between using it correctly and debugging it at 3 AM.

3. **Lock-free reads are the biggest win.** `ConcurrentHashMap.get()` is a volatile read — no locks, no CAS. `CopyOnWriteArrayList.get()` is a volatile read. `ConcurrentSkipListMap.get()` uses CAS only for cleanup. In read-heavy workloads (the common case), lock-free reads eliminate contention entirely. Design your concurrent data structures to optimize reads.

4. **CopyOnWriteArrayList is a read-optimization that costs writes.** Every write copies the entire array. This is perfect for listener lists (1 write per 10,000 reads) and catastrophic for write-heavy lists. Know your read-write ratio before choosing.

5. **BlockingQueues are not interchangeable.** `ArrayBlockingQueue` has a single lock (simple, lower throughput). `LinkedBlockingQueue` has two locks (higher throughput, more memory). `SynchronousQueue` has zero capacity (direct hand-off). `PriorityBlockingQueue` orders by priority (unbounded). Choose based on your producer-consumer pattern.

6. **CAS loops are the foundation of lock-free programming.** Read the current value, compute the new value, CAS the update. If CAS fails, retry. This pattern underlies `AtomicInteger`, `ConcurrentLinkedQueue`, `ConcurrentSkipListMap`, and every lock-free structure in the JDK. Understand the ABA problem and when it matters.

7. **False sharing is a silent performance killer.** Two threads writing to the same cache line (64 bytes) cause invalidation storms. `@Contended` annotation, manual padding, or `LongAdder`-style cell spreading are the fixes. Always suspect false sharing when multi-threaded code is slower than expected.

8. **`Collections.synchronizedMap()` is almost never the right answer.** Single global lock means zero concurrency. No atomic compound operations. Unsafe iteration. Use `ConcurrentHashMap` for general concurrent maps and `ConcurrentSkipListMap` for sorted concurrent maps.

9. **StampedLock's optimistic read is free until it is not.** Under read-heavy workloads, optimistic reads avoid all shared state modification — zero contention. Under write-heavy workloads, optimistic reads constantly fail validation and fall back to pessimistic locks. Know your workload before choosing `StampedLock` over `ReentrantReadWriteLock`.

10. **Production systems use Caffeine, not hand-rolled caches.** Implementing a correct concurrent LRU cache is deceptively hard. Caffeine handles eviction, expiration, refresh, statistics, and concurrent access recording with near-optimal performance. Your interview answer should demonstrate understanding of the underlying concepts (CAS, volatile, lock-striping), but your production code should use battle-tested libraries.

---

[Previous: Chapter 6 -- Heaps, Queues & Stacks](06-heaps-queues-stacks.md) | [Next: Chapter 8 -- Graph Algorithms](08-graph-algorithms.md)
