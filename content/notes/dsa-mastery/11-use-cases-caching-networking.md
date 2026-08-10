# Chapter 11: Use Cases — Caching, Networking, & Load Balancing

## Where Data Structures Meet the Real World

Every chapter so far has built your understanding of data structures in isolation — how a `HashMap` resolves collisions, how a `PriorityQueue` sifts, how a `ConcurrentSkipListMap` achieves lock-free reads. But production systems do not use data structures in isolation. They compose them into caches, load balancers, rate limiters, connection pools, and DNS resolvers. The data structure *is* the infrastructure.

This chapter is where theory becomes architecture. We will implement the exact data structure combinations that power Caffeine, HikariCP, Nginx, Guava, and every CDN you have ever hit. You will not just know *that* an LRU cache uses a hash map plus a doubly linked list — you will understand *why* that combination gives O(1) for every operation, how `LinkedHashMap`'s access-order mode implements it in 3 lines, and what happens at the JVM level when you evict 10 million entries under GC pressure.

We will start with cache eviction strategies — the most data-structure-intensive area in systems design — then move through connection pooling, load balancing, rate limiting, and DNS resolution. Each section connects the abstract structure to the concrete JVM bytecode, memory layout, and production deployment where it lives.

---

## 11.1 Cache Eviction Strategies: The Data Structure Core of Every Cache

A cache is fundamentally two things: a fast lookup structure (almost always a hash map) and an eviction policy (the algorithm that decides what to remove when the cache is full). The eviction policy determines which data structure you pair with the hash map. Get the pairing wrong, and you have O(n) eviction in a system that needs O(1).

### 11.1.1 LRU (Least Recently Used)

LRU is the most common eviction policy. The invariant: when the cache is full, evict the entry that was accessed least recently. Every `get` and `put` must update recency. This means we need:

1. O(1) lookup by key — hash map
2. O(1) move-to-front on access — doubly linked list
3. O(1) eviction from the tail — doubly linked list tail removal

The combination of HashMap + DoublyLinkedList gives O(1) for all three operations.

#### Approach 1: LinkedHashMap with accessOrder=true

Java's `LinkedHashMap` is secretly an LRU cache waiting to happen. It extends `HashMap` and maintains a doubly linked list threading through all entries. When `accessOrder` is set to `true`, every `get()` or `put()` moves the accessed entry to the tail of the linked list. The head of the list is the least recently used entry.

```java
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * LRU Cache using LinkedHashMap — the JDK's built-in LRU mechanism.
 * 
 * LinkedHashMap.Entry extends HashMap.Node and adds:
 *   Entry<K,V> before, after;  // doubly linked list pointers
 * 
 * When accessOrder=true:
 *   - get() calls afterNodeAccess() → moves entry to tail
 *   - put() calls afterNodeInsertion() → may call removeEldestEntry()
 *   - The head (eldest) of the linked list is the LRU candidate
 * 
 * Memory per entry: 32 bytes (HashMap.Node) + 16 bytes (before/after pointers)
 *                 = 48 bytes per entry (vs 32 for plain HashMap.Node)
 */
public class LRUCacheLinkedHashMap<K, V> extends LinkedHashMap<K, V> {
    private final int capacity;

    public LRUCacheLinkedHashMap(int capacity) {
        // initialCapacity, loadFactor, accessOrder
        super(capacity, 0.75f, true);
        this.capacity = capacity;
    }

    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        // Called after every put(). If returns true, the eldest entry is removed.
        // eldest is always the head of the internal linked list — the LRU entry.
        return size() > capacity;
    }

    // Usage:
    // LRUCacheLinkedHashMap<String, byte[]> cache = new LRUCacheLinkedHashMap<>(10_000);
    // cache.put("key1", data);
    // cache.get("key1");  // moves "key1" to most-recently-used position
    // cache.put("key10001", data);  // triggers removeEldestEntry → evicts LRU
}
```

**How LinkedHashMap.afterNodeAccess() works internally (JDK 17 source):**

```
Before access to node B:
  HEAD ←→ A ←→ [B] ←→ C ←→ D ←→ TAIL

afterNodeAccess(B):
  1. Unlink B:  A.after = C;  C.before = A;
  2. Link B at tail:  D.after = B;  B.before = D;  B.after = null;  tail = B;

After:
  HEAD ←→ A ←→ C ←→ D ←→ [B] ←→ TAIL
```

This is four pointer assignments — O(1), no iteration.

**JVM insight**: `LinkedHashMap.Entry` has two extra reference fields (`before`, `after`) compared to `HashMap.Node`. With compressed OOPs, that is 8 bytes extra per entry. For 10 million entries, that is 80 MB of additional memory just for the LRU ordering pointers. If you do not need LRU, use plain `HashMap`.

**Thread safety caveat**: `LinkedHashMap` is NOT thread-safe. Even `get()` mutates the linked list (moves the accessed entry). You cannot use `Collections.synchronizedMap()` naively because iterators would still be unsafe. For concurrent LRU, you need either external synchronization or a purpose-built concurrent LRU (like Caffeine).

#### Approach 2: HashMap + Custom Doubly Linked List (From Scratch)

This is the classic interview implementation and what most caching libraries use internally, because it gives full control over the eviction mechanics.

```java
import java.util.HashMap;
import java.util.Map;

/**
 * LRU Cache with HashMap + explicit DoublyLinkedList.
 * 
 * Data structure layout:
 * 
 *   HashMap<K, Node<K,V>>
 *       key1 → Node{key1, val1, prev, next}
 *       key2 → Node{key2, val2, prev, next}
 *       ...
 * 
 *   DoublyLinkedList (sentinel-based):
 *       HEAD_SENTINEL ←→ [MRU] ←→ ... ←→ [LRU] ←→ TAIL_SENTINEL
 * 
 * Sentinels eliminate all null checks in link/unlink operations.
 * The node CLOSEST to head is most recently used.
 * The node CLOSEST to tail is least recently used.
 * 
 * Every operation is O(1):
 *   get(key):  HashMap.get → O(1), moveToHead → O(1)
 *   put(key):  HashMap.put → O(1), addToHead → O(1), evict from tail → O(1)
 */
public class LRUCache<K, V> {

    private static class Node<K, V> {
        K key;
        V value;
        Node<K, V> prev;
        Node<K, V> next;

        Node() {} // sentinel constructor
        Node(K key, V value) {
            this.key = key;
            this.value = value;
        }
        // Memory layout (compressed OOPs):
        // Object header:  12 bytes
        // K key:           4 bytes (reference)
        // V value:         4 bytes (reference)
        // Node prev:       4 bytes (reference)
        // Node next:       4 bytes (reference)
        // Padding:         4 bytes
        // Total:          32 bytes per Node
    }

    private final int capacity;
    private final Map<K, Node<K, V>> map;
    private final Node<K, V> head; // sentinel — head.next is MRU
    private final Node<K, V> tail; // sentinel — tail.prev is LRU

    public LRUCache(int capacity) {
        this.capacity = capacity;
        this.map = new HashMap<>(capacity * 4 / 3 + 1); // avoid rehash
        this.head = new Node<>();
        this.tail = new Node<>();
        head.next = tail;
        tail.prev = head;
    }

    public V get(K key) {
        Node<K, V> node = map.get(key);
        if (node == null) return null;
        moveToHead(node);
        return node.value;
    }

    public void put(K key, V value) {
        Node<K, V> existing = map.get(key);
        if (existing != null) {
            existing.value = value;
            moveToHead(existing);
            return;
        }

        Node<K, V> newNode = new Node<>(key, value);
        map.put(key, newNode);
        addAfterHead(newNode);

        if (map.size() > capacity) {
            Node<K, V> lru = tail.prev; // the LRU node
            removeNode(lru);
            map.remove(lru.key);
            // lru is now unreferenced → eligible for GC
        }
    }

    private void moveToHead(Node<K, V> node) {
        removeNode(node);
        addAfterHead(node);
    }

    private void removeNode(Node<K, V> node) {
        // Unlink from current position
        node.prev.next = node.next;
        node.next.prev = node.prev;
        // 2 pointer writes — CPU pipeline friendly, no branch
    }

    private void addAfterHead(Node<K, V> node) {
        // Insert between head sentinel and head.next
        node.next = head.next;
        node.prev = head;
        head.next.prev = node;
        head.next = node;
        // 4 pointer writes
    }

    public int size() {
        return map.size();
    }
}
```

**Why sentinels matter**: Without sentinel nodes, every `removeNode` and `addAfterHead` would need null checks: "is this the head? is this the tail? is the list empty?" Those branches cause branch misprediction in tight loops. Sentinels guarantee that `node.prev` and `node.next` are never null, eliminating all conditional logic. The LMAX Disruptor, Netty's linked buffer lists, and the Linux kernel's `list_head` all use sentinels for the same reason.

**GC consideration**: When evicting, we remove the node from the linked list and the map. The node, its key, and its value become unreachable and are collected in the next minor GC (assuming they are still in Young Gen). If the cache is long-lived and entries are promoted to Old Gen, eviction creates garbage in Old Gen that accumulates until a major GC. This is why production caches (Caffeine, Guava) use sophisticated eviction buffers to batch evictions and reduce Old Gen fragmentation.

---

### 11.1.2 LFU (Least Frequently Used)

LFU evicts the entry that has been accessed the fewest times. The challenge: naively tracking frequencies requires O(n) to find the minimum-frequency entry. The O(1) LFU design uses a doubly linked list of frequency buckets, each containing a doubly linked list of entries with that frequency.

```
Frequency buckets (doubly linked):
  freq=1 ←→ freq=2 ←→ freq=5 ←→ freq=12

Within each bucket, entries are ordered by recency (LRU within same freq):
  freq=1: [entry_A ←→ entry_B ←→ entry_C]  (C is oldest in freq=1)
  freq=2: [entry_D ←→ entry_E]
  ...

minFreq pointer → freq=1 bucket

On access(entry_B):
  1. Remove entry_B from freq=1 bucket
  2. Move entry_B to freq=2 bucket (create if needed)
  3. If freq=1 bucket is now empty AND minFreq==1, increment minFreq

On evict:
  1. Go to minFreq bucket → freq=1
  2. Remove the TAIL entry (oldest in that frequency) → entry_C
  3. If bucket is now empty, it will be cleaned up naturally
```

#### Full O(1) LFU Implementation

```java
import java.util.HashMap;
import java.util.Map;

/**
 * O(1) LFU Cache.
 * 
 * Three data structures working together:
 * 1. keyToNode: HashMap<K, Node<K,V>> — O(1) lookup by key
 * 2. freqToList: HashMap<Integer, DoublyLinkedList<Node>> — O(1) access to frequency bucket
 * 3. minFreq: int — tracks the current minimum frequency for O(1) eviction
 * 
 * Paper: "An O(1) algorithm for implementing the LFU cache eviction scheme"
 *        by Prof. Ketan Shah, 2010
 */
public class LFUCache<K, V> {

    private static class Node<K, V> {
        K key;
        V value;
        int freq;
        Node<K, V> prev, next;

        Node(K key, V value) {
            this.key = key;
            this.value = value;
            this.freq = 1;
        }
    }

    /**
     * A doubly linked list with sentinels, representing one frequency bucket.
     * Entries near the head are most recently used (within this frequency).
     * Entries near the tail are least recently used (within this frequency).
     */
    private static class FreqBucket<K, V> {
        final Node<K, V> head = new Node<>(null, null);
        final Node<K, V> tail = new Node<>(null, null);
        int size;

        FreqBucket() {
            head.next = tail;
            tail.prev = head;
            size = 0;
        }

        void addFirst(Node<K, V> node) {
            node.next = head.next;
            node.prev = head;
            head.next.prev = node;
            head.next = node;
            size++;
        }

        void remove(Node<K, V> node) {
            node.prev.next = node.next;
            node.next.prev = node.prev;
            size--;
        }

        Node<K, V> removeLast() {
            if (size == 0) return null;
            Node<K, V> last = tail.prev;
            remove(last);
            return last;
        }

        boolean isEmpty() {
            return size == 0;
        }
    }

    private final int capacity;
    private int minFreq;
    private final Map<K, Node<K, V>> keyToNode;
    private final Map<Integer, FreqBucket<K, V>> freqToBucket;

    public LFUCache(int capacity) {
        this.capacity = capacity;
        this.minFreq = 0;
        this.keyToNode = new HashMap<>();
        this.freqToBucket = new HashMap<>();
    }

    public V get(K key) {
        Node<K, V> node = keyToNode.get(key);
        if (node == null) return null;
        incrementFreq(node);
        return node.value;
    }

    public void put(K key, V value) {
        if (capacity <= 0) return;

        Node<K, V> existing = keyToNode.get(key);
        if (existing != null) {
            existing.value = value;
            incrementFreq(existing);
            return;
        }

        // Evict if full
        if (keyToNode.size() >= capacity) {
            FreqBucket<K, V> minBucket = freqToBucket.get(minFreq);
            Node<K, V> evicted = minBucket.removeLast();
            keyToNode.remove(evicted.key);
            if (minBucket.isEmpty()) {
                freqToBucket.remove(minFreq);
            }
        }

        // Insert new entry
        Node<K, V> newNode = new Node<>(key, value);
        keyToNode.put(key, newNode);
        freqToBucket.computeIfAbsent(1, f -> new FreqBucket<>()).addFirst(newNode);
        minFreq = 1; // new entry always has freq=1, which is always the minimum
    }

    private void incrementFreq(Node<K, V> node) {
        int oldFreq = node.freq;
        FreqBucket<K, V> oldBucket = freqToBucket.get(oldFreq);
        oldBucket.remove(node);

        // If old bucket is now empty and it was the minFreq, bump minFreq
        if (oldBucket.isEmpty()) {
            freqToBucket.remove(oldFreq);
            if (minFreq == oldFreq) {
                minFreq++;
            }
        }

        node.freq++;
        freqToBucket.computeIfAbsent(node.freq, f -> new FreqBucket<>()).addFirst(node);
    }

    /**
     * Complexity:
     *   get(): O(1) — HashMap lookup + frequency bucket operations (all pointer ops)
     *   put(): O(1) — HashMap + frequency bucket operations + potential eviction
     * 
     * Memory per entry:
     *   Node: 32 bytes (header + key + value + freq + prev + next + padding)
     *   HashMap.Node in keyToNode: 32 bytes
     *   Total: ~64 bytes per entry + overhead from FreqBucket objects
     *   FreqBucket count = number of distinct frequencies (typically small)
     * 
     * The key insight for O(1) eviction:
     *   minFreq always points to the bucket with the lowest frequency.
     *   It only changes in two cases:
     *     1. A new entry is inserted → minFreq = 1
     *     2. The minFreq bucket becomes empty during incrementFreq → minFreq++
     *   Case 2 is O(1) because we just increment — we never search.
     *   The invariant: the minFreq bucket is never skipped because we only
     *   increment minFreq when that bucket empties.
     */
}
```

**LFU vs LRU — when to use which**: LFU is better when access frequency matters more than recency — for example, a CDN caching popular assets where a viral video should stay cached even if not accessed in the last few seconds. LRU is better for temporal locality patterns — database query caches, web session data. The downside of LFU is **cache pollution**: a burst of accesses to a key inflates its frequency, and it stays in the cache long after it stops being useful. This is why Adaptive Replacement Cache (ARC) and W-TinyLFU were invented.

---

### 11.1.3 ARC (Adaptive Replacement Cache)

ARC, developed by IBM Research (Megiddo & Modha, 2003), dynamically balances between LRU and LFU by maintaining four lists and a tuning parameter that adapts based on workload.

```
                        ┌─────────────────────────────────────┐
                        │           ARC Cache (size c)         │
                        │                                      │
  Ghost list B1         │   T1 (recent)    T2 (frequent)      │   Ghost list B2
  (recently evicted     │   ┌──────────┐   ┌──────────┐      │   (recently evicted
   from T1, metadata    │   │  LRU of  │   │  LRU of  │      │    from T2, metadata
   only, no values)     │   │  items   │   │  items   │      │    only, no values)
                        │   │  seen    │   │  seen    │      │
  [b1_old ← ... ← b1]  │   │  once    │   │  >= 2x   │      │   [b2_old ← ... ← b2]
                        │   └──────────┘   └──────────┘      │
                        │                                      │
                        │   ←── p ──→│←── c-p ──→             │
                        │   (target size for T1)               │
                        └─────────────────────────────────────┘

  |T1| + |T2| <= c    (actual cache holds at most c items)
  |T1| + |B1| <= c    (T1 + its ghost list bounded by c)
  |T2| + |B2| <= c    (T2 + its ghost list bounded by c)

  Parameter p: target size of T1. Adapts:
    - Hit in B1 (ghost of T1): "we evicted from T1 too aggressively" → increase p
    - Hit in B2 (ghost of T2): "we evicted from T2 too aggressively" → decrease p
```

#### ARC Implementation

```java
import java.util.HashMap;
import java.util.Map;

/**
 * Adaptive Replacement Cache (ARC).
 * 
 * Self-tuning cache that balances between recency (LRU) and frequency.
 * Uses 4 LRU lists:
 *   T1: pages seen exactly once recently (recency)
 *   T2: pages seen at least twice recently (frequency)
 *   B1: ghost entries evicted from T1 (only keys, no values)
 *   B2: ghost entries evicted from T2 (only keys, no values)
 * 
 * Parameter p: target size of T1. Adapts based on ghost list hits.
 * 
 * Patent note: ARC was patented by IBM (US Patent 6,996,676).
 * The patent expired in 2023. ZFS, PostgreSQL, and others use it.
 */
public class ARCCache<K, V> {

    private static class Node<K, V> {
        K key;
        V value;
        Node<K, V> prev, next;
        Node() {}
        Node(K key, V value) { this.key = key; this.value = value; }
    }

    /** Doubly linked list with sentinel nodes and O(1) operations. */
    private static class DList<K, V> {
        final Node<K, V> head = new Node<>();
        final Node<K, V> tail = new Node<>();
        int size;

        DList() { head.next = tail; tail.prev = head; }

        void addFront(Node<K, V> n) {
            n.next = head.next; n.prev = head;
            head.next.prev = n; head.next = n;
            size++;
        }

        void remove(Node<K, V> n) {
            n.prev.next = n.next; n.next.prev = n.prev;
            size--;
        }

        Node<K, V> removeLast() {
            if (size == 0) return null;
            Node<K, V> n = tail.prev;
            remove(n);
            return n;
        }

        boolean isEmpty() { return size == 0; }
    }

    private final int capacity;
    private int p; // target size of T1

    private final DList<K, V> t1 = new DList<>(); // recent, seen once
    private final DList<K, V> t2 = new DList<>(); // frequent, seen >= 2x
    private final DList<K, V> b1 = new DList<>(); // ghost of T1
    private final DList<K, V> b2 = new DList<>(); // ghost of T2

    // Maps for O(1) lookup: which list is this key in?
    private final Map<K, Node<K, V>> mapT1 = new HashMap<>();
    private final Map<K, Node<K, V>> mapT2 = new HashMap<>();
    private final Map<K, Node<K, V>> mapB1 = new HashMap<>();
    private final Map<K, Node<K, V>> mapB2 = new HashMap<>();

    public ARCCache(int capacity) {
        this.capacity = capacity;
        this.p = 0;
    }

    public V get(K key) {
        // Case 1: hit in T1 — promote to T2 (now seen >= 2x)
        if (mapT1.containsKey(key)) {
            Node<K, V> node = mapT1.remove(key);
            t1.remove(node);
            t2.addFront(node);
            mapT2.put(key, node);
            return node.value;
        }
        // Case 2: hit in T2 — move to front of T2 (standard LRU within T2)
        if (mapT2.containsKey(key)) {
            Node<K, V> node = mapT2.get(key);
            t2.remove(node);
            t2.addFront(node);
            return node.value;
        }
        // Case 3 & 4 (ghost hits) are handled in put()
        return null; // cache miss
    }

    public void put(K key, V value) {
        // Already in T1 — update value, promote to T2
        if (mapT1.containsKey(key)) {
            Node<K, V> node = mapT1.remove(key);
            t1.remove(node);
            node.value = value;
            t2.addFront(node);
            mapT2.put(key, node);
            return;
        }
        // Already in T2 — update value, move to front of T2
        if (mapT2.containsKey(key)) {
            Node<K, V> node = mapT2.get(key);
            t2.remove(node);
            node.value = value;
            t2.addFront(node);
            return;
        }

        // Ghost hit in B1 — T1 was too small, increase p
        if (mapB1.containsKey(key)) {
            int delta = Math.max(1, b2.size / Math.max(1, b1.size));
            p = Math.min(p + delta, capacity);
            Node<K, V> ghost = mapB1.remove(key);
            b1.remove(ghost);
            replace(key);
            ghost.value = value;
            t2.addFront(ghost);
            mapT2.put(key, ghost);
            return;
        }

        // Ghost hit in B2 — T2 was too small, decrease p
        if (mapB2.containsKey(key)) {
            int delta = Math.max(1, b1.size / Math.max(1, b2.size));
            p = Math.max(p - delta, 0);
            Node<K, V> ghost = mapB2.remove(key);
            b2.remove(ghost);
            replace(key);
            ghost.value = value;
            t2.addFront(ghost);
            mapT2.put(key, ghost);
            return;
        }

        // Complete miss — not in any list
        int totalT = t1.size + t2.size;
        int totalAll = totalT + b1.size + b2.size;

        if (totalT == capacity) {
            // Cache is full
            if (t1.size < capacity) {
                // Evict from B1 ghost list to make room
                Node<K, V> evicted = b1.removeLast();
                if (evicted != null) mapB1.remove(evicted.key);
                replace(key);
            } else {
                // T1 fills the entire cache — evict from T1 directly
                Node<K, V> evicted = t1.removeLast();
                if (evicted != null) mapT1.remove(evicted.key);
            }
        } else if (totalAll >= capacity) {
            if (totalAll >= 2 * capacity) {
                Node<K, V> evicted = b2.removeLast();
                if (evicted != null) mapB2.remove(evicted.key);
            }
            replace(key);
        }

        // Insert into T1 (new entry, seen once)
        Node<K, V> newNode = new Node<>(key, value);
        t1.addFront(newNode);
        mapT1.put(key, newNode);
    }

    /**
     * Replace: evict one entry from either T1 or T2 based on parameter p.
     * The evicted entry's key moves to the appropriate ghost list.
     */
    private void replace(K incomingKey) {
        if (t1.size > 0 && (t1.size > p || (mapB2.containsKey(incomingKey) && t1.size == p))) {
            // Evict from T1, add ghost to B1
            Node<K, V> evicted = t1.removeLast();
            mapT1.remove(evicted.key);
            evicted.value = null; // release value for GC
            b1.addFront(evicted);
            mapB1.put(evicted.key, evicted);
        } else if (t2.size > 0) {
            // Evict from T2, add ghost to B2
            Node<K, V> evicted = t2.removeLast();
            mapT2.remove(evicted.key);
            evicted.value = null;
            b2.addFront(evicted);
            mapB2.put(evicted.key, evicted);
        }
    }

    /*
     * Complexity: All operations O(1).
     * 
     * Memory overhead: Higher than plain LRU because we maintain ghost lists.
     * Ghost entries store keys but null out values, so the overhead is:
     *   - Up to c ghost entries in B1 + c ghost entries in B2
     *   - Each ghost: ~32 bytes (Node with null value) + key object
     *   - Worst case: 3x the memory of a plain LRU cache of size c
     * 
     * Real-world: ZFS ARC cache, PostgreSQL buffer cache, IBM DS8000 storage.
     * ARC is scan-resistant: a single full-table-scan does not flush the cache,
     * because scanned items enter T1 and are evicted before polluting T2.
     */
}
```

---

### 11.1.4 FIFO and Clock Algorithm

FIFO is the simplest eviction policy: evict whatever was inserted first, regardless of access pattern. The Clock algorithm is a practical approximation of LRU that uses FIFO structure with a "used" bit — cheaper than full LRU because it avoids moving nodes on every access.

#### FIFO Cache with ArrayDeque

```java
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;

/**
 * FIFO Cache using ArrayDeque (circular array internally).
 * 
 * ArrayDeque is backed by a circular Object[] array.
 * addLast() and removeFirst() are O(1) amortized.
 * 
 * FIFO ignores access patterns — bad for temporal locality workloads,
 * but excellent for sequential scans (database table scans, log processing).
 */
public class FIFOCache<K, V> {
    private final int capacity;
    private final Map<K, V> map;
    private final ArrayDeque<K> order; // insertion order

    public FIFOCache(int capacity) {
        this.capacity = capacity;
        this.map = new HashMap<>(capacity * 4 / 3 + 1);
        this.order = new ArrayDeque<>(capacity);
    }

    public V get(K key) {
        return map.get(key); // no reordering — this is FIFO, not LRU
    }

    public void put(K key, V value) {
        if (map.containsKey(key)) {
            map.put(key, value); // update in place, no change to order
            return;
        }
        if (map.size() >= capacity) {
            K oldest = order.pollFirst(); // O(1) — circular array head removal
            map.remove(oldest);
        }
        map.put(key, value);
        order.addLast(key); // O(1) — circular array tail insertion
    }

    // Memory: HashMap overhead + ArrayDeque overhead (one Object[] of size capacity)
    // ArrayDeque stores references to keys — 4 bytes each (compressed OOPs)
    // Total: ~40 bytes per entry (HashMap.Node + ArrayDeque reference + key/value)
}
```

#### Clock (Second-Chance) Algorithm

The Clock algorithm uses a circular buffer with a "used" bit per entry. On eviction, it sweeps the clock hand around the buffer. If an entry's used bit is set, it clears it and moves on (giving it a "second chance"). If the bit is already clear, that entry is evicted.

```java
import java.util.HashMap;
import java.util.Map;

/**
 * Clock (Second-Chance) Page Replacement Algorithm.
 * 
 * Approximates LRU with O(1) access (no list reordering) and amortized O(1) eviction.
 * 
 * Used in: Linux kernel page cache, PostgreSQL buffer pool, OS virtual memory.
 * 
 * Data structure: Circular array of slots, each with key, value, and usedBit.
 * A "hand" pointer sweeps the array for eviction candidates.
 * 
 * Why it approximates LRU:
 *   - Accessed entries get usedBit=true (like "moving to front" in LRU)
 *   - On eviction, the hand clears used bits (aging) before evicting
 *   - Entries accessed frequently keep getting their bit set → survive
 *   - Entries not accessed → bit stays clear → evicted quickly
 */
public class ClockCache<K, V> {

    private static class Slot<K, V> {
        K key;
        V value;
        boolean used;
        boolean occupied;

        void set(K key, V value) {
            this.key = key;
            this.value = value;
            this.used = true;
            this.occupied = true;
        }

        void clear() {
            this.key = null;
            this.value = null;
            this.used = false;
            this.occupied = false;
        }
    }

    @SuppressWarnings("unchecked")
    private final Slot<K, V>[] slots;
    private final Map<K, Integer> keyToSlot; // key → slot index
    private final int capacity;
    private int hand; // clock hand position
    private int size;

    @SuppressWarnings("unchecked")
    public ClockCache(int capacity) {
        this.capacity = capacity;
        this.slots = new Slot[capacity];
        for (int i = 0; i < capacity; i++) {
            slots[i] = new Slot<>();
        }
        this.keyToSlot = new HashMap<>(capacity * 4 / 3 + 1);
        this.hand = 0;
        this.size = 0;
    }

    public V get(K key) {
        Integer slotIdx = keyToSlot.get(key);
        if (slotIdx == null) return null;
        slots[slotIdx].used = true; // mark as recently used — O(1), no list manipulation
        return slots[slotIdx].value;
    }

    public void put(K key, V value) {
        Integer existing = keyToSlot.get(key);
        if (existing != null) {
            slots[existing].value = value;
            slots[existing].used = true;
            return;
        }

        // Find a slot: either an empty one or evict via clock sweep
        int slot;
        if (size < capacity) {
            slot = findEmptySlot();
            size++;
        } else {
            slot = evictClock();
        }

        slots[slot].set(key, value);
        keyToSlot.put(key, slot);
    }

    private int findEmptySlot() {
        while (slots[hand].occupied) {
            hand = (hand + 1) % capacity;
        }
        return hand;
    }

    private int evictClock() {
        // Sweep until we find a slot with used=false
        while (true) {
            if (!slots[hand].used) {
                // Evict this slot
                keyToSlot.remove(slots[hand].key);
                int evictedSlot = hand;
                hand = (hand + 1) % capacity;
                return evictedSlot;
            }
            // Second chance: clear the used bit, move on
            slots[hand].used = false;
            hand = (hand + 1) % capacity;
        }
        // Worst case: one full sweep (all bits set) → clears all, then evicts on next pass
        // Amortized O(1) because each set+clear is charged to the access that set it
    }

    /**
     * Clock vs LRU tradeoffs:
     * 
     * LRU:   get() = O(1) but moves node in linked list (6 pointer writes)
     *        evict() = O(1) — just remove tail
     *        Memory: HashMap.Node + DList.Node per entry
     * 
     * Clock: get() = O(1) with just 1 boolean write (no pointer manipulation)
     *        evict() = amortized O(1) with sweep
     *        Memory: Slot array + HashMap.Node per entry (no linked list overhead)
     * 
     * Clock wins when:
     *   - Read-heavy workload (get() is cheaper)
     *   - Memory constrained (no linked list pointers)
     *   - Concurrent access (boolean write vs pointer manipulation)
     * 
     * LRU wins when:
     *   - Strict LRU ordering is needed
     *   - Eviction must be worst-case O(1), not amortized
     */
}
```

**JVM insight**: The `Slot[]` array stores references to Slot objects, each scattered on the heap. For cache-line friendliness, you could flatten this into parallel arrays (`K[] keys`, `V[] values`, `boolean[] used`, `boolean[] occupied`), which gives sequential memory access during clock sweeps. The Linux kernel uses this flat layout for its page frame array.

---

### 11.1.5 TTL-Based Eviction

Time-To-Live (TTL) caches expire entries after a fixed duration. The data structure challenge: how do you efficiently find and remove expired entries without scanning the entire cache?

**Two approaches:**

1. **Lazy expiration**: Check TTL on `get()`. O(1) per access, but expired entries consume memory until accessed.
2. **Eager expiration**: Background thread removes expired entries. Requires a structure that yields the next-to-expire entry efficiently.

#### TTL Cache with HashMap + PriorityQueue

```java
import java.util.*;
import java.util.concurrent.*;

/**
 * TTL Cache: HashMap for O(1) lookup + PriorityQueue for efficient expiration.
 * 
 * PriorityQueue (min-heap) ordered by expiry time → O(1) to peek the
 * soonest-to-expire entry, O(log n) to poll it.
 * 
 * Lazy + eager hybrid: lazy check on get(), eager cleanup via background thread.
 */
public class TTLCache<K, V> {

    private static class Entry<K, V> implements Comparable<Entry<K, V>> {
        final K key;
        V value;
        long expiryTimeNanos;

        Entry(K key, V value, long ttlNanos) {
            this.key = key;
            this.value = value;
            this.expiryTimeNanos = System.nanoTime() + ttlNanos;
        }

        @Override
        public int compareTo(Entry<K, V> other) {
            return Long.compare(this.expiryTimeNanos, other.expiryTimeNanos);
        }

        boolean isExpired() {
            return System.nanoTime() >= expiryTimeNanos;
        }
    }

    private final Map<K, Entry<K, V>> map;
    private final PriorityQueue<Entry<K, V>> expiryQueue; // min-heap by expiry time
    private final long defaultTTLNanos;

    public TTLCache(long ttl, TimeUnit unit) {
        this.map = new ConcurrentHashMap<>();
        this.expiryQueue = new PriorityQueue<>();
        this.defaultTTLNanos = unit.toNanos(ttl);
    }

    public V get(K key) {
        Entry<K, V> entry = map.get(key);
        if (entry == null) return null;
        if (entry.isExpired()) {
            // Lazy expiration
            map.remove(key);
            // Note: entry remains in PQ until cleanup — this is a tombstone
            return null;
        }
        return entry.value;
    }

    public void put(K key, V value) {
        Entry<K, V> entry = new Entry<>(key, value, defaultTTLNanos);
        Entry<K, V> old = map.put(key, entry);
        // Old entry becomes a tombstone in the PQ — cleaned up lazily
        expiryQueue.offer(entry); // O(log n)
    }

    /**
     * Eager cleanup: call periodically from a ScheduledExecutorService.
     * Drains all expired entries from the PQ.
     */
    public void cleanUp() {
        long now = System.nanoTime();
        while (!expiryQueue.isEmpty() && expiryQueue.peek().expiryTimeNanos <= now) {
            Entry<K, V> expired = expiryQueue.poll(); // O(log n)
            // Only remove from map if this is still the current entry
            // (it might have been replaced by a new put() with the same key)
            map.remove(expired.key, expired);
        }
    }

    /**
     * Complexity:
     *   get(): O(1) average (HashMap lookup + expiry check)
     *   put(): O(log n) (PriorityQueue.offer)
     *   cleanUp(): O(k log n) where k = number of expired entries
     * 
     * Alternative: Use DelayQueue (which wraps PriorityQueue + ReentrantLock)
     * for built-in blocking take() that waits until the next expiry.
     */
}
```

#### TTL Cache with DelayQueue

```java
import java.util.concurrent.*;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * TTL Cache using DelayQueue — the JDK's built-in TTL mechanism.
 * 
 * DelayQueue internally uses:
 *   - PriorityQueue (min-heap) ordered by delay remaining
 *   - ReentrantLock for thread safety
 *   - Condition variable for blocking take()
 * 
 * A background thread calls take() which blocks until the next entry expires.
 * This is more efficient than periodic polling because there is zero CPU
 * usage while waiting — the thread is parked by the OS scheduler.
 */
public class TTLCacheDelayQueue<K, V> {

    private static class DelayedEntry<K, V> implements Delayed {
        final K key;
        final V value;
        final long expiryNanos;

        DelayedEntry(K key, V value, long ttlNanos) {
            this.key = key;
            this.value = value;
            this.expiryNanos = System.nanoTime() + ttlNanos;
        }

        @Override
        public long getDelay(TimeUnit unit) {
            return unit.convert(expiryNanos - System.nanoTime(), TimeUnit.NANOSECONDS);
        }

        @Override
        public int compareTo(Delayed o) {
            return Long.compare(this.expiryNanos, ((DelayedEntry<?, ?>) o).expiryNanos);
        }
    }

    private final Map<K, DelayedEntry<K, V>> map = new ConcurrentHashMap<>();
    private final DelayQueue<DelayedEntry<K, V>> delayQueue = new DelayQueue<>();
    private final long defaultTTLNanos;

    public TTLCacheDelayQueue(long ttl, TimeUnit unit) {
        this.defaultTTLNanos = unit.toNanos(ttl);
        startCleanupThread();
    }

    public V get(K key) {
        DelayedEntry<K, V> entry = map.get(key);
        if (entry == null) return null;
        if (entry.getDelay(TimeUnit.NANOSECONDS) <= 0) {
            map.remove(key);
            return null;
        }
        return entry.value;
    }

    public void put(K key, V value) {
        DelayedEntry<K, V> entry = new DelayedEntry<>(key, value, defaultTTLNanos);
        map.put(key, entry);
        delayQueue.offer(entry);
    }

    private void startCleanupThread() {
        Thread cleaner = new Thread(() -> {
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    DelayedEntry<K, V> expired = delayQueue.take(); // blocks until next expiry
                    map.remove(expired.key, expired);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }, "ttl-cache-cleaner");
        cleaner.setDaemon(true);
        cleaner.start();
    }
}
```

---

### 11.1.6 W-TinyLFU (Caffeine's Algorithm)

Caffeine, the high-performance Java caching library that replaced Guava Cache, uses Window-TinyLFU — a near-optimal eviction policy that combines a frequency sketch (count-min sketch) as an admission filter with a segmented LRU for the main cache.

```
                    ┌──────────────────────────────────────────────┐
                    │              Caffeine W-TinyLFU               │
                    │                                               │
  New entries ──→  │  ┌────────────┐     ┌──────────────────────┐ │
                    │  │  Window     │     │     Main Cache        │ │
                    │  │  (1% of    │────→│  ┌────────────────┐  │ │
                    │  │  capacity) │     │  │  Probation      │  │ │
                    │  │  LRU       │admit│  │  (20% of main)  │  │ │
                    │  │            │ if  │  │  Newly admitted  │  │ │
                    │  └────────────┘freq │  │  entries         │  │ │
                    │                > vic│  └───────┬──────────┘  │ │
                    │                tim  │          │ promote     │ │
                    │                     │          ↓ on access   │ │
                    │                     │  ┌────────────────┐  │ │
                    │                     │  │  Protected      │  │ │
                    │  ┌──────────────┐  │  │  (80% of main)  │  │ │
                    │  │ Count-Min    │  │  │  Frequently      │  │ │
                    │  │ Sketch       │  │  │  accessed entries│  │ │
                    │  │ (frequency   │  │  └────────────────┘  │ │
                    │  │  estimator)  │  │                       │ │
                    │  └──────────────┘  └──────────────────────┘ │
                    └──────────────────────────────────────────────┘

  Admission policy:
    When Window evicts entry W and Main (probation) evicts victim V:
      if sketch.frequency(W) > sketch.frequency(V):
          admit W into Probation, evict V entirely
      else:
          evict W entirely, keep V

  The Count-Min Sketch uses 4 hash functions and a compact array
  of 4-bit counters to estimate frequency with minimal memory.
  Periodic halving prevents stale frequencies from dominating.
```

```java
/**
 * Simplified W-TinyLFU demonstration.
 * Production Caffeine is far more optimized — this captures the key ideas.
 * 
 * Count-Min Sketch: 
 *   - 4 rows of counters, each row has W counters (W = nearest power of 2 >= capacity)
 *   - Each counter is 4 bits (max value 15)
 *   - To estimate frequency(key): take min across 4 rows
 *   - To increment: increment all 4 rows (capped at 15)
 *   - Periodic reset: halve all counters when total increments reach W * 10
 *   - Memory: 4 * W * 4 bits = 2W bytes (e.g., 2MB for 1M-entry cache)
 *   
 * Why Count-Min Sketch, not HashMap<K, Integer>?
 *   - HashMap: 64+ bytes per key. For 1M keys = 64MB just for frequency tracking.
 *   - CMS: 2 bytes per slot. For 1M slots = 2MB. 32x less memory.
 *   - CMS over-estimates (never under-estimates) — safe for admission filtering.
 */
public class WTinyLFUCache<K, V> {

    // ---- Count-Min Sketch ----
    private final long[] sketchTable; // packed 4-bit counters, 16 per long
    private final int sketchMask;
    private int sketchSize;
    private static final int SKETCH_DEPTH = 4;
    private static final long[] SEEDS = {0xc3a5c85c97cb3127L, 0xb492b66fbe98f273L,
                                          0x9ae16a3b2f90404fL, 0xcbf29ce484222325L};

    // ---- Window (small LRU, ~1% of total capacity) ----
    private final LRUCache<K, V> window;
    private final int windowCapacity;

    // ---- Main cache (segmented LRU, ~99% of total capacity) ----
    // Simplified: using a single LRU for the main cache
    // Full implementation would have probation + protected segments
    private final LRUCache<K, V> mainCache;
    private final int mainCapacity;

    // ---- Unified map for O(1) lookup ----
    private final Map<K, V> lookupMap;

    public WTinyLFUCache(int capacity) {
        this.windowCapacity = Math.max(1, capacity / 100);  // 1% window
        this.mainCapacity = capacity - windowCapacity;       // 99% main
        this.window = new LRUCache<>(windowCapacity);
        this.mainCache = new LRUCache<>(mainCapacity);
        this.lookupMap = new HashMap<>();

        // Sketch size: next power of 2 >= capacity
        int sketchSlots = Integer.highestOneBit(capacity - 1) << 1;
        this.sketchMask = sketchSlots - 1;
        this.sketchTable = new long[SKETCH_DEPTH * (sketchSlots >>> 4)]; // 16 counters per long
        this.sketchSize = 0;
    }

    private int sketchFrequency(K key) {
        int hash = spread(key.hashCode());
        int min = Integer.MAX_VALUE;
        for (int i = 0; i < SKETCH_DEPTH; i++) {
            int index = ((int) (hash * SEEDS[i] >>> 32)) & sketchMask;
            int arrayIdx = i * ((sketchMask + 1) >>> 4) + (index >>> 4);
            int shift = (index & 0xF) << 2;
            int count = (int) ((sketchTable[arrayIdx] >>> shift) & 0xFL);
            min = Math.min(min, count);
        }
        return min;
    }

    private void sketchIncrement(K key) {
        int hash = spread(key.hashCode());
        for (int i = 0; i < SKETCH_DEPTH; i++) {
            int index = ((int) (hash * SEEDS[i] >>> 32)) & sketchMask;
            int arrayIdx = i * ((sketchMask + 1) >>> 4) + (index >>> 4);
            int shift = (index & 0xF) << 2;
            long mask = 0xFL << shift;
            long current = (sketchTable[arrayIdx] >>> shift) & 0xFL;
            if (current < 15) { // 4-bit max
                sketchTable[arrayIdx] += (1L << shift);
            }
        }
        if (++sketchSize >= (sketchMask + 1) * 10) {
            resetSketch(); // periodic halving to prevent stale frequencies
        }
    }

    private void resetSketch() {
        // Halve all counters: for each 4-bit counter, shift right by 1
        // This ages old frequencies so the sketch adapts to changing access patterns
        for (int i = 0; i < sketchTable.length; i++) {
            // Mask to halve each 4-bit nibble: shift right by 1 within each nibble
            sketchTable[i] = (sketchTable[i] >>> 1) & 0x7777777777777777L;
        }
        sketchSize /= 2;
    }

    private static int spread(int x) {
        // MurmurHash3 finalizer — better distribution for sketch indexing
        x ^= x >>> 16;
        x *= 0x85ebca6b;
        x ^= x >>> 13;
        x *= 0xc2b2ae35;
        x ^= x >>> 16;
        return x;
    }

    /**
     * Real Caffeine performance characteristics:
     * 
     * - Near-optimal hit rate: within 1-2% of Belady's OPT for most workloads
     * - O(1) amortized for get/put
     * - Frequency sketch: ~8 bytes per entry (vs ~64 bytes for HashMap-based counter)
     * - Concurrent: uses striped ring buffers for recording accesses,
     *   drained by a single maintenance thread (avoids lock contention on get())
     * - GC-friendly: no per-access object allocation (unlike Guava which creates
     *   AccessQueue.Entry objects)
     * 
     * JVM insight: Caffeine uses sun.misc.Unsafe for atomic operations on the
     * sketch array, avoiding the overhead of AtomicLongArray's bounds checking.
     * The ring buffer uses padded fields to avoid false sharing between producer
     * (application threads) and consumer (maintenance thread).
     */
}
```

---

## 11.2 Cache Hierarchies: L1 to CDN

Understanding how caches compose is essential for systems design. Every request flows through multiple cache layers, each using different data structures.

### 11.2.1 CPU Cache Hierarchy (L1/L2/L3)

```
┌──────────────────────────────────────────────────────────────────┐
│ Core 0                          Core 1                           │
│ ┌──────────────┐               ┌──────────────┐                │
│ │ L1i   (32KB) │               │ L1i   (32KB) │  i = instruction│
│ │ L1d   (48KB) │               │ L1d   (48KB) │  d = data       │
│ │ ~4 cycles     │               │ ~4 cycles     │                │
│ └──────┬───────┘               └──────┬───────┘                │
│ ┌──────┴───────┐               ┌──────┴───────┐                │
│ │ L2   (1.25MB)│               │ L2   (1.25MB)│                │
│ │ ~12 cycles    │               │ ~12 cycles    │                │
│ └──────┬───────┘               └──────┴───────┘                │
│        └────────────┬───────────────┘                           │
│              ┌──────┴──────────┐                                │
│              │ L3 (shared, 30MB)│  (Intel 12th gen typical)     │
│              │ ~40 cycles       │                                │
│              └──────┬──────────┘                                │
│                     │                                            │
│              ┌──────┴──────────┐                                │
│              │ Main Memory     │                                │
│              │ ~200+ cycles    │                                │
│              └─────────────────┘                                │
└──────────────────────────────────────────────────────────────────┘

Cache line size: 64 bytes (hardware unit of transfer)
Associativity: L1 typically 8-way, L2 8-way, L3 16-way set-associative
Replacement: Pseudo-LRU (tree-PLRU) — not true LRU at hardware level
```

**Hardware LRU vs software LRU**: CPU caches do NOT use true LRU (tracking exact access order for 8-16 ways would require too many bits). They use tree-PLRU (Pseudo-LRU) which maintains a binary tree of decision bits to approximate which way was least recently used. Each access flips O(log ways) bits. Eviction traverses the tree in O(log ways) to find an approximate LRU victim. This is analogous to our Clock algorithm — a lightweight approximation of LRU.

**Why this matters for Java data structures**: When you iterate an `int[]`, the CPU prefetcher detects the sequential pattern and preloads future cache lines before you need them. L1 hits are ~1 ns, main memory is ~50-100 ns. An `int[]` traversal of 1M elements gets ~15M cache line prefetches for free. A `LinkedList` traversal of 1M nodes: the CPU cannot prefetch because the next address is unknown until the current node's `next` pointer is dereferenced. Every node access is a potential L1 miss → L2 miss → L3 miss → main memory.

### 11.2.2 Browser Cache

```
Browser Request Flow:
  1. Memory Cache (HashMap<URL, CachedResource>)
     - Fastest, limited by tab's memory
     - Eviction: typically LRU, bounded by memory pressure
  
  2. Disk Cache (SQLite or LevelDB-based)
     - Persistent across sessions
     - Key: URL hash → file on disk
     - Eviction: LRU with size bounds (e.g., 200MB)
     - Chrome uses "Simple Cache" (one file per entry + index)
  
  3. Service Worker Cache (programmatic, Cache API)
     - HashMap<Request, Response> in IndexedDB
     - Developer-controlled eviction
  
  4. HTTP Cache-Control headers determine cacheability:
     - max-age=3600 → TTL-based
     - no-cache → must revalidate (ETag/Last-Modified)
     - no-store → never cache
```

### 11.2.3 CDN Cache (Edge Nodes)

```
CDN Architecture:
  ┌───────────────────────────────────────────────────────┐
  │                     Origin Server                      │
  │               (source of truth)                        │
  └────────────┬──────────────────────────────────────────┘
               │
       ┌───────┴───────┐
       │ Mid-tier Cache │  (regional, shared by multiple edges)
       │ LRU + TTL      │
       └──┬────────┬────┘
          │        │
   ┌──────┴───┐ ┌──┴──────────┐
   │ Edge POP │ │  Edge POP   │   (Point of Presence, closest to users)
   │ NYC      │ │  London     │
   │          │ │             │
   │ Cache:   │ │ Cache:      │
   │ HashMap  │ │ HashMap     │
   │ URL →    │ │ URL →       │
   │ content  │ │ content     │
   │          │ │             │
   │ Eviction:│ │ Eviction:   │
   │ LRU+TTL  │ │ LRU+TTL    │
   │          │ │             │
   │ Routing: │ │ Routing:    │
   │ Consistent│ │ Consistent │
   │ hashing  │ │ hashing    │
   └──────────┘ └─────────────┘

  Each edge POP may have multiple cache servers.
  Content is distributed across them using consistent hashing:
    server = ring.ceilingEntry(hash(URL)).getValue()
  This ensures each URL maps to one server — no duplication within a POP.
```

**Consistent hashing for CDN** is the same `TreeMap` + virtual nodes structure we will implement in section 11.5. When a cache server goes down, only 1/N of the keys need to be redistributed (vs all keys with modular hashing).

---

## 11.3 Connection Pooling

Connection pooling is a producer-consumer pattern backed by a bounded collection of pre-established connections. The data structure choice directly affects connection acquisition latency, which is on the critical path of every database query.

### 11.3.1 ArrayBlockingQueue-Based Pool

```java
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Simple Connection Pool using ArrayBlockingQueue.
 * 
 * ArrayBlockingQueue internals:
 *   - Circular Object[] array (like ArrayDeque but thread-safe)
 *   - Single ReentrantLock + two Conditions (notEmpty, notFull)
 *   - put() blocks when full, take() blocks when empty
 *   - O(1) for offer/poll (no resize, fixed capacity)
 * 
 * Memory layout: Object[poolSize] holding connection references
 *   + ReentrantLock (96 bytes) + 2 Condition objects (~64 bytes each)
 *   Total overhead: ~250 bytes + 4*poolSize bytes (references)
 */
public class SimpleConnectionPool<C> {
    private final ArrayBlockingQueue<C> available;
    private final ConnectionFactory<C> factory;
    private final int maxSize;

    @FunctionalInterface
    public interface ConnectionFactory<C> {
        C create() throws Exception;
    }

    public SimpleConnectionPool(int maxSize, ConnectionFactory<C> factory) throws Exception {
        this.maxSize = maxSize;
        this.factory = factory;
        this.available = new ArrayBlockingQueue<>(maxSize);
        // Pre-create connections
        for (int i = 0; i < maxSize; i++) {
            available.offer(factory.create());
        }
    }

    /**
     * Borrow a connection. Blocks up to timeout if none available.
     */
    public C borrow(long timeout, TimeUnit unit) throws Exception {
        C conn = available.poll(timeout, unit);
        if (conn == null) {
            throw new RuntimeException("Connection pool exhausted, timeout after " +
                timeout + " " + unit);
        }
        return conn;
    }

    /**
     * Return a connection to the pool.
     */
    public void release(C conn) {
        if (!available.offer(conn)) {
            // Pool is full (should not happen in normal operation)
            // Close the connection instead
            closeQuietly(conn);
        }
    }

    private void closeQuietly(C conn) {
        try {
            if (conn instanceof AutoCloseable) ((AutoCloseable) conn).close();
        } catch (Exception ignored) {}
    }
}
```

### 11.3.2 HikariCP's ConcurrentBag

HikariCP, the fastest Java connection pool, uses a custom `ConcurrentBag` instead of `ArrayBlockingQueue`. Understanding its data structure choices explains why it is 10-20x faster than traditional pools.

```java
/**
 * HikariCP ConcurrentBag internals (simplified):
 * 
 * Traditional pool (DBCP, C3P0):
 *   ArrayBlockingQueue → single lock → all threads contend on borrow/return
 *   Under 100 concurrent threads: lock contention dominates latency
 * 
 * HikariCP ConcurrentBag:
 *   1. ThreadLocal<List<Entry>> → each thread remembers which connections
 *      it previously used. On borrow, check ThreadLocal first — O(1), NO LOCK.
 *   
 *   2. CopyOnWriteArrayList<Entry> sharedList → all pooled connections.
 *      If ThreadLocal miss, scan this list using CAS to claim a connection.
 *      CopyOnWriteArrayList: no lock on read (volatile array reference).
 *   
 *   3. SynchronousQueue<Entry> handoff → if no connection available,
 *      wait for another thread to return one (direct handoff, no intermediate buffer).
 * 
 * Entry states (managed by AtomicInteger):
 *   NOT_IN_USE (0) → available for borrowing
 *   IN_USE (1)     → currently borrowed by a thread
 *   REMOVED (-1)   → connection is being evicted (TTL, error, etc.)
 *   RESERVED (-2)  → reserved for housekeeping
 * 
 * Borrow fast path:
 *   1. Check ThreadLocal list → find entry with state NOT_IN_USE → CAS to IN_USE
 *      Success? Return immediately. No lock, no contention, ~10 nanoseconds.
 *   
 *   2. Scan sharedList → find any NOT_IN_USE entry → CAS to IN_USE
 *      CopyOnWriteArrayList iteration: lock-free, sequential array scan.
 *   
 *   3. Block on SynchronousQueue.poll(timeout) → wait for handoff
 *      Last resort, only when pool is fully utilized.
 * 
 * Return:
 *   1. CAS entry state from IN_USE → NOT_IN_USE
 *   2. If any thread is waiting on SynchronousQueue, hand off directly
 * 
 * Why this is fast:
 *   - Thread affinity: threads reuse the same connection (warm in CPU cache)
 *   - Lock-free fast path: CAS-only, no ReentrantLock
 *   - No queue: connections are not shuffled through a shared queue
 *   - Memory layout: CopyOnWriteArrayList's internal array is contiguous
 *     → scanning 10-20 entries is a single cache line read
 * 
 * JVM insight: The CAS operations compile to x86 LOCK CMPXCHG instructions.
 * On modern CPUs, uncontended CAS takes ~5 ns. Compare with ReentrantLock:
 * ~20 ns uncontended (must still check owner thread), ~10 us under contention
 * (OS context switch). HikariCP's CAS-first approach avoids the lock entirely
 * in the common case.
 */
```

---

## 11.4 Rate Limiting

Rate limiters control the rate of requests. Each algorithm uses a different data structure, and the choice depends on the precision required, the memory budget, and whether the limiter must be distributed.

### 11.4.1 Token Bucket

The token bucket is the most common rate limiter. Tokens are added at a fixed rate. Each request consumes one token. If no tokens are available, the request is rejected.

```java
import java.util.concurrent.atomic.AtomicLong;

/**
 * Token Bucket Rate Limiter.
 * 
 * Data structure: just two numbers — current token count and last refill timestamp.
 * No queue, no list, no map. This is why token bucket is so efficient.
 * 
 * The key insight: we do not actually add tokens over time. Instead, we compute
 * how many tokens WOULD HAVE BEEN added since the last request, and add them
 * lazily. This is O(1) with no background thread.
 */
public class TokenBucketLimiter {
    private final long maxTokens;
    private final long refillRatePerSecond;
    private final AtomicLong tokens;
    private volatile long lastRefillNanos;

    public TokenBucketLimiter(long maxTokens, long refillRatePerSecond) {
        this.maxTokens = maxTokens;
        this.refillRatePerSecond = refillRatePerSecond;
        this.tokens = new AtomicLong(maxTokens);
        this.lastRefillNanos = System.nanoTime();
    }

    public boolean tryAcquire() {
        refill();
        long current = tokens.get();
        while (current > 0) {
            if (tokens.compareAndSet(current, current - 1)) {
                return true; // acquired
            }
            current = tokens.get(); // CAS failed, retry
        }
        return false; // no tokens available
    }

    private void refill() {
        long now = System.nanoTime();
        long elapsed = now - lastRefillNanos;
        long newTokens = elapsed * refillRatePerSecond / 1_000_000_000L;
        if (newTokens > 0) {
            long currentTokens = tokens.get();
            long newTotal = Math.min(maxTokens, currentTokens + newTokens);
            // CAS loop to atomically update tokens
            if (tokens.compareAndSet(currentTokens, newTotal)) {
                lastRefillNanos = now; // benign race: worst case, tokens accumulate slightly less
            }
        }
    }

    /**
     * Complexity: O(1) — two reads, one arithmetic, one CAS.
     * Memory: 32 bytes (3 longs + 1 AtomicLong object).
     * Thread-safe via CAS — no locks.
     * 
     * Token bucket allows bursts: if maxTokens=100 and rate=10/sec,
     * a client that waits 10 seconds accumulates 100 tokens and can
     * send 100 requests instantly. This is intentional — it smooths
     * bursty traffic while maintaining an average rate.
     * 
     * Used by: AWS API Gateway, Stripe, Google Cloud.
     */
}
```

### 11.4.2 Sliding Window Counter

The sliding window counter divides time into fixed-size windows and counts requests per window. It approximates a true sliding window by interpolating between the current and previous window.

```java
import java.util.TreeMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Sliding Window Counter using TreeMap.
 * 
 * TreeMap<Long, AtomicInteger> where:
 *   key = window start timestamp (floored to window boundary)
 *   value = count of requests in that window
 * 
 * For a rate limit of N requests per T seconds:
 *   1. Floor current time to window boundary
 *   2. Sum counts from all windows within [now - T, now]
 *   3. If sum < N, allow and increment current window counter
 * 
 * TreeMap operations:
 *   subMap(fromKey, toKey): O(log n) to find range, O(k) to iterate k windows
 *   put(key, value): O(log n)
 *   
 * In practice, the number of windows is small (e.g., 60 one-second windows
 * for a per-minute rate limit), so this is effectively O(1).
 */
public class SlidingWindowCounter {
    private final int maxRequests;
    private final long windowSizeMillis;
    private final TreeMap<Long, AtomicInteger> windows;

    public SlidingWindowCounter(int maxRequests, long windowSizeMillis) {
        this.maxRequests = maxRequests;
        this.windowSizeMillis = windowSizeMillis;
        this.windows = new TreeMap<>();
    }

    public synchronized boolean tryAcquire() {
        long now = System.currentTimeMillis();
        long currentWindow = now / windowSizeMillis * windowSizeMillis;
        long cutoff = now - windowSizeMillis;

        // Remove expired windows
        windows.headMap(cutoff).clear(); // O(log n + expired count)

        // Count requests in the sliding window
        int count = 0;
        for (AtomicInteger c : windows.tailMap(cutoff).values()) {
            count += c.get();
        }

        if (count >= maxRequests) {
            return false;
        }

        windows.computeIfAbsent(currentWindow, k -> new AtomicInteger()).incrementAndGet();
        return true;
    }

    /**
     * Improvement: weighted interpolation between current and previous window.
     * 
     * If window size = 60s, current time is 75s into the window:
     *   weight = (60 - 15) / 60 = 0.75 (75% of previous window counts)
     *   estimated = prevCount * 0.75 + currentCount
     * 
     * This smooths the count across window boundaries, reducing the
     * "spike at window edge" problem that fixed windows have.
     */
}
```

### 11.4.3 Sliding Window Log

The sliding window log records the exact timestamp of every request. It is the most precise but most memory-intensive approach.

```java
import java.util.LinkedList;
import java.util.Deque;

/**
 * Sliding Window Log using LinkedList.
 * 
 * Stores the exact timestamp of every request within the window.
 * Most precise rate limiting — no approximation.
 * 
 * LinkedList (as Deque):
 *   - addLast(timestamp): O(1) — append new request timestamp
 *   - peekFirst(): O(1) — check oldest timestamp
 *   - removeFirst(): O(1) — evict expired timestamps
 *   - size(): O(1) — count requests in window
 * 
 * Memory: 40 bytes per request (Node object with prev/next pointers + Long value)
 *         For 10,000 requests/sec: 400 KB per second of window
 */
public class SlidingWindowLog {
    private final int maxRequests;
    private final long windowMillis;
    private final Deque<Long> timestamps;

    public SlidingWindowLog(int maxRequests, long windowMillis) {
        this.maxRequests = maxRequests;
        this.windowMillis = windowMillis;
        this.timestamps = new LinkedList<>();
    }

    public synchronized boolean tryAcquire() {
        long now = System.currentTimeMillis();
        long cutoff = now - windowMillis;

        // Remove expired timestamps from the front
        while (!timestamps.isEmpty() && timestamps.peekFirst() <= cutoff) {
            timestamps.removeFirst(); // O(1)
        }

        if (timestamps.size() >= maxRequests) {
            return false;
        }

        timestamps.addLast(now); // O(1)
        return true;
    }

    /**
     * Tradeoff vs sliding window counter:
     *   Log: exact counting, O(n) memory where n = requests in window
     *   Counter: approximate, O(w) memory where w = number of sub-windows
     * 
     * Use log when precision matters (billing, strict SLAs).
     * Use counter when memory matters (high-volume API gateway).
     */
}
```

### 11.4.4 Leaky Bucket

The leaky bucket processes requests at a fixed rate. Excess requests queue up (or are rejected if the queue is full). Unlike token bucket which allows bursts, leaky bucket enforces a smooth output rate.

```java
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Leaky Bucket Rate Limiter.
 * 
 * Model: a bucket (queue) with a hole at the bottom.
 *   - Requests pour in from the top (enqueue).
 *   - Requests leak out at a fixed rate (dequeue by processor).
 *   - If the bucket overflows (queue full), requests are rejected.
 * 
 * Data structure: bounded queue (LinkedBlockingQueue or ArrayBlockingQueue).
 * 
 * The "leak" is a background thread or timer that dequeues at a fixed rate.
 * Alternatively, we can calculate mathematically without a real queue.
 */
public class LeakyBucketLimiter {
    private final int bucketCapacity;    // max queue size
    private final long leakIntervalNanos; // time between leaks (1/rate)
    private volatile long lastLeakNanos;
    private volatile int waterLevel;      // current queue size

    public LeakyBucketLimiter(int capacity, int ratePerSecond) {
        this.bucketCapacity = capacity;
        this.leakIntervalNanos = 1_000_000_000L / ratePerSecond;
        this.lastLeakNanos = System.nanoTime();
        this.waterLevel = 0;
    }

    public synchronized boolean tryAcquire() {
        leak();
        if (waterLevel >= bucketCapacity) {
            return false; // bucket overflow → reject
        }
        waterLevel++;
        return true;
    }

    private void leak() {
        long now = System.nanoTime();
        long elapsed = now - lastLeakNanos;
        long leaked = elapsed / leakIntervalNanos;
        if (leaked > 0) {
            waterLevel = (int) Math.max(0, waterLevel - leaked);
            lastLeakNanos = now;
        }
    }

    /**
     * Token bucket vs Leaky bucket:
     * 
     * Token bucket: allows BURSTS up to maxTokens, then rate-limits.
     *   Good for: APIs where occasional bursts are acceptable.
     *   DS: just two counters (tokens + timestamp).
     * 
     * Leaky bucket: enforces CONSTANT output rate. No bursts.
     *   Good for: network traffic shaping, video streaming bitrate.
     *   DS: queue or counter with leak calculation.
     * 
     * Both are O(1) per request, O(1) memory.
     * The difference is behavioral, not structural.
     */
}
```

### 11.4.5 Fixed Window Counter

```java
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Fixed Window Counter using ConcurrentHashMap.
 * 
 * Simplest rate limiter. Divides time into fixed windows.
 * Each window has a counter. Reset at window boundary.
 * 
 * ConcurrentHashMap<Long, AtomicInteger>:
 *   key = window number (timestamp / windowSize)
 *   value = request count in that window
 * 
 * Problem: boundary effect. If limit = 100/minute and a client sends
 * 100 requests at 0:59 and 100 at 1:00, they sent 200 in 2 seconds
 * but both pass (different windows). Sliding window fixes this.
 */
public class FixedWindowLimiter {
    private final int maxRequests;
    private final long windowSizeMillis;
    private final ConcurrentHashMap<Long, AtomicInteger> windows;

    public FixedWindowLimiter(int maxRequests, long windowSizeMillis) {
        this.maxRequests = maxRequests;
        this.windowSizeMillis = windowSizeMillis;
        this.windows = new ConcurrentHashMap<>();
    }

    public boolean tryAcquire() {
        long windowKey = System.currentTimeMillis() / windowSizeMillis;
        AtomicInteger counter = windows.computeIfAbsent(windowKey, k -> new AtomicInteger());
        int current = counter.incrementAndGet();

        // Lazy cleanup: remove old windows
        long oldKey = windowKey - 2;
        windows.remove(oldKey);

        return current <= maxRequests;
    }

    /**
     * Thread safety: ConcurrentHashMap.computeIfAbsent + AtomicInteger.incrementAndGet
     * are both lock-free (CAS-based). No synchronized block needed.
     * 
     * Memory: one HashMap.Node + one AtomicInteger per active window.
     * With 1-second windows: ~2 active windows at any time = ~100 bytes.
     * Extremely memory-efficient.
     */
}
```

---

## 11.5 Load Balancing

Load balancing distributes work across a set of servers. The data structure behind the balancer determines fairness, locality, and failure handling.

### 11.5.1 Round-Robin

```java
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Round-Robin Load Balancer.
 * 
 * Data structure: array/list of servers + atomic counter.
 * Each request goes to servers[counter++ % servers.size()].
 * 
 * No priority, no weighting — pure rotation. O(1) per request.
 */
public class RoundRobinBalancer<S> {
    private final List<S> servers;
    private final AtomicInteger counter = new AtomicInteger(0);

    public RoundRobinBalancer(List<S> servers) {
        this.servers = List.copyOf(servers); // immutable snapshot
    }

    public S next() {
        int idx = counter.getAndIncrement();
        // Use bitwise AND if servers.size() is power of 2, else modulo
        return servers.get(Math.floorMod(idx, servers.size()));
    }

    /**
     * AtomicInteger.getAndIncrement() compiles to LOCK XADD on x86.
     * Single atomic instruction — ~5 ns uncontended.
     * 
     * Overflow: int wraps around at Integer.MAX_VALUE → Integer.MIN_VALUE.
     * Math.floorMod handles negative values correctly (unlike %).
     * 
     * Used by: Nginx (default), HAProxy, Kubernetes Service (iptables mode).
     */
}
```

### 11.5.2 Weighted Round-Robin

```java
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Weighted Round-Robin Load Balancer.
 * 
 * Approach 1: Expanded list.
 *   If server A has weight 3 and server B has weight 1:
 *   expandedList = [A, A, A, B]
 *   Round-robin over expandedList gives A 75% traffic, B 25%.
 * 
 * Memory: O(sum of weights) — for reasonable weights (1-100), this is fine.
 * Problem: bursty — A gets 3 requests in a row before B gets any.
 * 
 * Approach 2: Smooth Weighted Round-Robin (Nginx algorithm).
 *   Avoids burstiness by interleaving based on effective weight.
 */
public class WeightedRoundRobin<S> {

    // ---- Approach 1: Expanded List ----
    private final List<S> expandedList;
    private final AtomicInteger counter = new AtomicInteger(0);

    public WeightedRoundRobin(Map<S, Integer> serverWeights) {
        List<S> expanded = new ArrayList<>();
        for (Map.Entry<S, Integer> e : serverWeights.entrySet()) {
            for (int i = 0; i < e.getValue(); i++) {
                expanded.add(e.getKey());
            }
        }
        // Shuffle to distribute load more evenly within the rotation
        Collections.shuffle(expanded);
        this.expandedList = List.copyOf(expanded);
    }

    public S next() {
        int idx = counter.getAndIncrement();
        return expandedList.get(Math.floorMod(idx, expandedList.size()));
    }

    // ---- Approach 2: Smooth Weighted Round-Robin (Nginx) ----
    // Each server maintains:
    //   weight: configured weight
    //   currentWeight: starts at 0, adjusted each round
    //
    // Algorithm per request:
    //   1. For each server: currentWeight += weight
    //   2. Select server with highest currentWeight
    //   3. Selected server: currentWeight -= totalWeight
    //
    // Example: A(weight=5), B(weight=1), C(weight=1), totalWeight=7
    //   Round 1: A=5, B=1, C=1 → select A, A becomes 5-7=-2
    //   Round 2: A=3, B=2, C=2 → select A, A becomes 3-7=-4
    //   Round 3: A=1, B=3, C=3 → select B, B becomes 3-7=-4
    //   Round 4: A=6, B=-3, C=4 → select A, A becomes 6-7=-1
    //   ... perfectly smooth distribution: A gets 5/7, B gets 1/7, C gets 1/7
}
```

### 11.5.3 Least Connections

```java
import java.util.*;

/**
 * Least-Connections Load Balancer using PriorityQueue.
 * 
 * PriorityQueue (min-heap) ordered by active connection count.
 * The server with the fewest active connections is at the top.
 * 
 * On request:  poll() → get server with fewest connections, increment, re-add
 * On response: find server in map, decrement, rebuild heap position
 * 
 * Problem: PriorityQueue.remove(server) is O(n) because it scans the array.
 * Solution: Use an indexed priority queue or a TreeMap with compound key.
 */
public class LeastConnectionsBalancer {

    private static class ServerState implements Comparable<ServerState> {
        final String server;
        int activeConnections;

        ServerState(String server) {
            this.server = server;
            this.activeConnections = 0;
        }

        @Override
        public int compareTo(ServerState other) {
            int cmp = Integer.compare(this.activeConnections, other.activeConnections);
            if (cmp != 0) return cmp;
            return this.server.compareTo(other.server); // tiebreaker for TreeSet
        }
    }

    // TreeSet gives O(log n) for first(), remove(), and add().
    // Unlike PriorityQueue, TreeSet.remove() is O(log n), not O(n).
    private final TreeSet<ServerState> queue;
    private final Map<String, ServerState> serverMap;

    public LeastConnectionsBalancer(List<String> servers) {
        this.queue = new TreeSet<>();
        this.serverMap = new HashMap<>();
        for (String s : servers) {
            ServerState state = new ServerState(s);
            queue.add(state);
            serverMap.put(s, state);
        }
    }

    public synchronized String acquireServer() {
        ServerState least = queue.first();
        queue.remove(least);         // O(log n) — TreeSet uses Red-Black tree
        least.activeConnections++;
        queue.add(least);            // O(log n) — reinsert at new position
        return least.server;
    }

    public synchronized void releaseServer(String server) {
        ServerState state = serverMap.get(server);
        if (state != null) {
            queue.remove(state);     // O(log n)
            state.activeConnections--;
            queue.add(state);        // O(log n)
        }
    }

    /**
     * Complexity: O(log n) per acquire/release where n = number of servers.
     * For typical server counts (10-1000), log n < 10 — effectively O(1).
     * 
     * Alternative: for very large server pools, use a bucket queue:
     *   Array where index = connection count, each bucket is a list of servers.
     *   O(1) to find minimum (track minBucket index).
     *   Used by: HAProxy's "leastconn" algorithm.
     */
}
```

### 11.5.4 Consistent Hashing

Consistent hashing maps both keys and servers to positions on a virtual ring. Each key is served by the next server clockwise on the ring. Adding or removing a server only affects keys in one segment of the ring.

```java
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;

/**
 * Consistent Hashing Ring using TreeMap.
 * 
 * TreeMap (Red-Black tree) provides:
 *   ceilingEntry(hash): O(log n) — find the next server clockwise
 *   put(hash, server): O(log n) — add a virtual node
 *   remove(hash): O(log n) — remove a virtual node
 * 
 * Virtual nodes: each physical server gets multiple positions on the ring.
 * This distributes load more evenly and reduces hotspots when servers
 * are added/removed. Typical: 100-200 virtual nodes per physical server.
 * 
 * Without virtual nodes, N servers divide the ring into N unequal arcs
 * (standard deviation ~= 1/sqrt(N) of the ring). With V virtual nodes
 * per server, deviation drops to ~= 1/sqrt(N*V).
 */
public class ConsistentHashRing<S> {
    private final TreeMap<Long, S> ring;
    private final int virtualNodes;
    private final Map<S, List<Long>> serverToHashes; // for removal

    public ConsistentHashRing(int virtualNodes) {
        this.ring = new TreeMap<>();
        this.virtualNodes = virtualNodes;
        this.serverToHashes = new HashMap<>();
    }

    public void addServer(S server) {
        List<Long> hashes = new ArrayList<>(virtualNodes);
        for (int i = 0; i < virtualNodes; i++) {
            long hash = hash(server.toString() + "#" + i);
            ring.put(hash, server);
            hashes.add(hash);
        }
        serverToHashes.put(server, hashes);
    }

    public void removeServer(S server) {
        List<Long> hashes = serverToHashes.remove(server);
        if (hashes != null) {
            for (long hash : hashes) {
                ring.remove(hash);
            }
        }
    }

    public S getServer(String key) {
        if (ring.isEmpty()) return null;
        long hash = hash(key);
        // Find the first server position >= hash (clockwise)
        Map.Entry<Long, S> entry = ring.ceilingEntry(hash);
        if (entry == null) {
            // Wrap around to the first server on the ring
            entry = ring.firstEntry();
        }
        return entry.getValue();
    }

    /**
     * When a server is removed, only keys that mapped to that server
     * are redistributed to the next server clockwise.
     * Expected keys moved: K/N where K = total keys, N = total servers.
     * 
     * Without consistent hashing (modular): adding a server remaps ~K*(N-1)/N keys.
     * With consistent hashing: adding a server remaps ~K/N keys. Much less disruption.
     */

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

    /**
     * Real-world usage:
     * - Amazon DynamoDB: consistent hashing for partition placement
     * - Apache Cassandra: Murmur3Partitioner on a ring
     * - Memcached: ketama consistent hashing (by Last.fm)
     * - Akka Cluster: sharding with consistent hash ring
     * 
     * JVM note: MD5 MessageDigest is NOT thread-safe.
     * Each call to hash() creates a new instance.
     * In production, use ThreadLocal<MessageDigest> or MurmurHash3 (no allocation).
     */
}
```

### 11.5.5 Power-of-Two-Choices

```java
import java.util.*;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Power-of-Two-Choices Load Balancer.
 * 
 * Algorithm: randomly pick 2 servers, route to the one with fewer connections.
 * 
 * Theorem (Mitzenmacher, 2001): with N servers, random placement gives
 * max load O(log N / log log N). Power-of-two-choices gives max load
 * O(log log N) — an exponential improvement.
 * 
 * Data structure: just an array of servers with connection counts.
 * O(1) per request (two random indexes + one comparison).
 */
public class PowerOfTwoChoicesBalancer {
    private final String[] servers;
    private final int[] activeConnections;

    public PowerOfTwoChoicesBalancer(List<String> serverList) {
        this.servers = serverList.toArray(new String[0]);
        this.activeConnections = new int[servers.length];
    }

    public synchronized String acquireServer() {
        int n = servers.length;
        int i = ThreadLocalRandom.current().nextInt(n);
        int j = ThreadLocalRandom.current().nextInt(n);
        // Ensure i != j
        while (j == i && n > 1) {
            j = ThreadLocalRandom.current().nextInt(n);
        }

        int choice = activeConnections[i] <= activeConnections[j] ? i : j;
        activeConnections[choice]++;
        return servers[choice];
    }

    public synchronized void releaseServer(String server) {
        for (int i = 0; i < servers.length; i++) {
            if (servers[i].equals(server)) {
                activeConnections[i]--;
                return;
            }
        }
    }

    /**
     * Why this is surprisingly effective:
     * - Random: max load = O(log n / log log n) — some servers get hammered
     * - Two-choices: max load = O(log log n) — exponentially more balanced
     * - Three-choices: negligible improvement over two-choices
     * 
     * The "power of two choices" paradigm is used in:
     * - Nginx EWMA (exponentially weighted moving average) + two-choices
     * - Envoy proxy's "least request" with P2C
     * - gRPC client-side load balancing
     * 
     * For n=1000 servers:
     *   Random: max load ≈ O(log 1000 / log log 1000) ≈ 3-4x average
     *   P2C: max load ≈ O(log log 1000) ≈ 1.1x average
     */
}
```

### 11.5.6 Hash-Based Sticky Sessions

```java
import java.util.*;

/**
 * Sticky Session Load Balancer using consistent hashing.
 * 
 * Routes requests from the same client to the same server.
 * This is critical for: session state, shopping carts, WebSocket connections.
 * 
 * Approach 1: HashMap<SessionID, Server> — direct mapping.
 *   Problem: if a server goes down, all its sessions are lost.
 *   Memory: O(sessions), which can be millions.
 * 
 * Approach 2: Consistent hashing on session ID.
 *   No per-session state. hash(sessionID) → server on the ring.
 *   If a server goes down, only its sessions remap.
 *   Memory: O(servers * virtualNodes), independent of session count.
 */
public class StickySessionBalancer {
    private final ConsistentHashRing<String> ring;

    public StickySessionBalancer(List<String> servers, int virtualNodesPerServer) {
        this.ring = new ConsistentHashRing<>(virtualNodesPerServer);
        for (String server : servers) {
            ring.addServer(server);
        }
    }

    public String route(String sessionId) {
        return ring.getServer(sessionId);
    }

    /**
     * Sticky sessions + consistent hashing is used by:
     * - AWS ALB: cookie-based stickiness
     * - Nginx: ip_hash directive (hashes client IP to server)
     * - Envoy: ring_hash load balancer
     * 
     * The tradeoff: stickiness can cause hotspots if one client
     * generates disproportionate traffic. Combine with circuit breakers
     * and overflow routing for resilience.
     */
}
```

---

## 11.6 DNS Resolution Cache

DNS resolution maps domain names to IP addresses. Every HTTP client, browser, and OS maintains a DNS cache to avoid repeated lookups. The data structure is a `HashMap` with TTL-based expiration, often organized hierarchically.

```java
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * DNS Cache with TTL and hierarchical lookup.
 * 
 * DNS resolution hierarchy:
 *   1. Application cache (this class)
 *   2. OS resolver cache (nscd on Linux, dnsmasq)
 *   3. Router cache
 *   4. ISP recursive resolver cache
 *   5. Root → TLD → Authoritative nameservers
 * 
 * Each level is essentially a HashMap<DomainName, DNSRecord> with TTL.
 * The TTL is set by the authoritative nameserver in the DNS response.
 */
public class DNSCache {

    private static class DNSEntry {
        final List<String> ipAddresses; // A/AAAA records (multiple for load balancing)
        final long expiryTimeMillis;

        DNSEntry(List<String> ips, long ttlSeconds) {
            this.ipAddresses = List.copyOf(ips);
            this.expiryTimeMillis = System.currentTimeMillis() + ttlSeconds * 1000;
        }

        boolean isExpired() {
            return System.currentTimeMillis() >= expiryTimeMillis;
        }
    }

    private final ConcurrentHashMap<String, DNSEntry> cache;
    private final int maxEntries;

    public DNSCache(int maxEntries) {
        this.cache = new ConcurrentHashMap<>();
        this.maxEntries = maxEntries;
    }

    public List<String> resolve(String domain) {
        // Normalize domain to lowercase (DNS is case-insensitive)
        domain = domain.toLowerCase();

        DNSEntry entry = cache.get(domain); // O(1)
        if (entry != null && !entry.isExpired()) {
            return entry.ipAddresses;
        }

        // Cache miss or expired — perform actual DNS lookup
        cache.remove(domain);
        return null; // caller should perform actual DNS resolution
    }

    public void cacheResult(String domain, List<String> ips, long ttlSeconds) {
        domain = domain.toLowerCase();
        if (cache.size() >= maxEntries) {
            evictExpired();
        }
        cache.put(domain, new DNSEntry(ips, ttlSeconds));
    }

    private void evictExpired() {
        cache.entrySet().removeIf(e -> e.getValue().isExpired());
    }

    /**
     * JVM DNS caching gotcha:
     * 
     * Java caches DNS results in InetAddress, controlled by:
     *   networkaddress.cache.ttl (positive cache, default: 30s in JDK 12+)
     *   networkaddress.cache.negative.ttl (negative cache for failed lookups, default: 10s)
     * 
     * Prior to JDK 12, the default was to cache FOREVER if a SecurityManager
     * was installed. This caused production incidents where DNS changes
     * (like failovers) were never picked up by the JVM.
     * 
     * For cloud environments (AWS ELB, Kubernetes Services) where IPs change
     * frequently, set:
     *   java.security.Security.setProperty("networkaddress.cache.ttl", "60");
     * 
     * Real-world: Netflix Ribbon, Spring Cloud, and gRPC Java all override
     * the JVM DNS cache TTL for cloud deployments.
     */
}
```

---

## Problems

### Cache Eviction Problems

**P11.01** [E] — Basic LRU Cache
Design and implement an LRU cache with `get(key)` and `put(key, value)` operations, both O(1).

```java
/**
 * LeetCode 146: LRU Cache
 * 
 * Approach: HashMap<Integer, Node> + DoublyLinkedList with sentinels.
 * See Section 11.1.1 Approach 2 for the full implementation.
 * 
 * Complexity: O(1) for both get and put.
 * Space: O(capacity) — one Node per entry + HashMap overhead.
 * 
 * JVM insight: Each Node is 32 bytes. For capacity=10000, the Node overhead
 * alone is 320 KB. The HashMap.Node[] table at load factor 0.75 with capacity
 * 13334 (next power of 2 = 16384) costs 64 KB. Total structural overhead: ~384 KB.
 * 
 * Real-world: Android's LruCache, Guava's Cache, OkHttp's response cache.
 */
public class LRUCacheBasic {
    private static class Node {
        int key, value;
        Node prev, next;
        Node(int k, int v) { key = k; value = v; }
        Node() {}
    }

    private final int capacity;
    private final Map<Integer, Node> map;
    private final Node head, tail;

    public LRUCacheBasic(int capacity) {
        this.capacity = capacity;
        this.map = new HashMap<>();
        head = new Node();
        tail = new Node();
        head.next = tail;
        tail.prev = head;
    }

    public int get(int key) {
        Node node = map.get(key);
        if (node == null) return -1;
        moveToHead(node);
        return node.value;
    }

    public void put(int key, int value) {
        Node existing = map.get(key);
        if (existing != null) {
            existing.value = value;
            moveToHead(existing);
            return;
        }
        Node node = new Node(key, value);
        map.put(key, node);
        addAfterHead(node);
        if (map.size() > capacity) {
            Node lru = tail.prev;
            removeNode(lru);
            map.remove(lru.key);
        }
    }

    private void moveToHead(Node n) { removeNode(n); addAfterHead(n); }
    private void removeNode(Node n) { n.prev.next = n.next; n.next.prev = n.prev; }
    private void addAfterHead(Node n) {
        n.next = head.next; n.prev = head;
        head.next.prev = n; head.next = n;
    }
}
```

**P11.02** [E] — LRU Cache Using LinkedHashMap
Implement an LRU cache in the minimum number of lines using `LinkedHashMap`.

```java
/**
 * LinkedHashMap LRU — the 10-line production shortcut.
 * 
 * accessOrder=true: get() triggers afterNodeAccess() → moves entry to tail.
 * removeEldestEntry(): called after put() → returns true to auto-evict eldest.
 * 
 * This is how Android's LruCache works internally.
 */
public class LRULinkedHashMap<K, V> extends LinkedHashMap<K, V> {
    private final int cap;

    public LRULinkedHashMap(int capacity) {
        super(capacity, 0.75f, true); // accessOrder=true is the magic flag
        this.cap = capacity;
    }

    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        return size() > cap;
    }
    // That is it. get() and put() are inherited from LinkedHashMap.
    // Complexity: O(1) for both, identical to the manual implementation.
}
```

**P11.03** [E] — FIFO Cache
Implement a FIFO cache using `ArrayDeque`.

```java
/**
 * FIFO Cache: evicts the oldest inserted entry, ignoring access patterns.
 * 
 * ArrayDeque: circular array, O(1) addLast/removeFirst.
 * HashMap: O(1) lookup.
 * 
 * Use case: log processing, event buffers, simple page caches.
 */
public class FIFOCacheImpl<K, V> {
    private final int capacity;
    private final Map<K, V> map = new HashMap<>();
    private final ArrayDeque<K> queue = new ArrayDeque<>();

    public FIFOCacheImpl(int capacity) { this.capacity = capacity; }

    public V get(K key) { return map.get(key); } // no reordering

    public void put(K key, V value) {
        if (map.containsKey(key)) { map.put(key, value); return; }
        if (map.size() >= capacity) {
            K oldest = queue.pollFirst();
            map.remove(oldest);
        }
        map.put(key, value);
        queue.addLast(key);
    }
    // Complexity: O(1) for get and put.
    // Space: O(capacity) for map + O(capacity) for queue references.
}
```

**P11.04** [E] — Cache Hit Rate Calculator
Design a data structure that tracks cache hit rate over the last N requests using a sliding window.

```java
/**
 * Sliding window hit rate tracker using a circular boolean array.
 * 
 * Circular array of size N: each slot records hit (true) or miss (false).
 * Maintain a running count of hits — no need to scan the array.
 * 
 * This is effectively a fixed-size ring buffer.
 */
public class HitRateTracker {
    private final boolean[] window;
    private int head;
    private int hits;
    private int filled;

    public HitRateTracker(int windowSize) {
        this.window = new boolean[windowSize];
        this.head = 0;
        this.hits = 0;
        this.filled = 0;
    }

    public void record(boolean hit) {
        if (filled == window.length) {
            // Remove the oldest entry
            if (window[head]) hits--;
        } else {
            filled++;
        }
        window[head] = hit;
        if (hit) hits++;
        head = (head + 1) % window.length;
    }

    public double hitRate() {
        return filled == 0 ? 0.0 : (double) hits / filled;
    }
    // O(1) per record, O(1) for hitRate. Memory: N bytes (boolean array).
}
```

**P11.05** [E] — Fixed Window Rate Limiter
Implement a basic fixed-window rate limiter for a single API key.

```java
/**
 * Fixed window rate limiter: N requests per T-second window.
 * Simplest possible implementation — HashMap with window key.
 */
public class FixedWindowRateLimiter {
    private final int maxRequests;
    private final long windowMillis;
    private long currentWindowStart;
    private int count;

    public FixedWindowRateLimiter(int maxRequests, long windowMillis) {
        this.maxRequests = maxRequests;
        this.windowMillis = windowMillis;
        this.currentWindowStart = System.currentTimeMillis();
        this.count = 0;
    }

    public synchronized boolean allow() {
        long now = System.currentTimeMillis();
        if (now - currentWindowStart >= windowMillis) {
            currentWindowStart = now;
            count = 0;
        }
        if (count < maxRequests) {
            count++;
            return true;
        }
        return false;
    }
    // O(1), 16 bytes of state. Production: add per-key HashMap for multi-tenant.
}
```

**P11.06** [E] — Key-Value Store with Get/Set
Implement a simple in-memory key-value store supporting `get`, `set`, and `delete`.

```java
/**
 * Basic key-value store — HashMap wrapper with explicit API.
 * Foundation for all cache implementations.
 */
public class KeyValueStore<K, V> {
    private final Map<K, V> store = new HashMap<>();

    public V get(K key) { return store.get(key); }
    public void set(K key, V value) { store.put(key, value); }
    public boolean delete(K key) { return store.remove(key) != null; }
    public boolean exists(K key) { return store.containsKey(key); }
    public int size() { return store.size(); }
    // O(1) for all operations. This is the API contract every cache extends.
}
```

**P11.07** [E] — Max Size Bounded HashMap
Implement a HashMap that automatically evicts the oldest entry when exceeding max size (using insertion-order `LinkedHashMap`).

```java
/**
 * Insertion-order bounded map using LinkedHashMap with accessOrder=false.
 * 
 * Unlike LRU (accessOrder=true), this evicts by insertion order.
 * Useful for: audit logs, event buffers, deduplication caches.
 */
public class BoundedMap<K, V> extends LinkedHashMap<K, V> {
    private final int maxSize;

    public BoundedMap(int maxSize) {
        super(maxSize * 4 / 3 + 1, 0.75f, false); // accessOrder=false → insertion order
        this.maxSize = maxSize;
    }

    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        return size() > maxSize;
    }
    // get() does NOT reorder. Eviction is strictly by insertion time.
}
```

**P11.08** [E] — Round-Robin Server Selection
Implement a round-robin selector that cycles through a list of servers.

```java
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Thread-safe round-robin using AtomicInteger modulo server count.
 */
public class RoundRobinSelector {
    private final List<String> servers;
    private final AtomicInteger idx = new AtomicInteger(0);

    public RoundRobinSelector(List<String> servers) {
        this.servers = List.copyOf(servers);
    }

    public String next() {
        return servers.get(Math.floorMod(idx.getAndIncrement(), servers.size()));
    }
    // O(1). Lock-free via LOCK XADD instruction.
}
```

**P11.09** [E] — Simple Object Pool
Implement a basic object pool that pre-creates objects and lends/returns them.

```java
import java.util.concurrent.ArrayBlockingQueue;

/**
 * Object pool using ArrayBlockingQueue.
 * borrow() blocks when pool is empty, return() hands back the object.
 */
public class SimpleObjectPool<T> {
    private final ArrayBlockingQueue<T> pool;

    @FunctionalInterface
    public interface Factory<T> { T create(); }

    public SimpleObjectPool(int size, Factory<T> factory) {
        pool = new ArrayBlockingQueue<>(size);
        for (int i = 0; i < size; i++) pool.offer(factory.create());
    }

    public T borrow() throws InterruptedException {
        return pool.take(); // blocks if empty
    }

    public void release(T obj) {
        pool.offer(obj); // non-blocking; drops if full (should not happen)
    }
    // O(1) for both. Backed by circular array + single ReentrantLock.
}
```

**P11.10** [E] — Token Bucket (Simplified)
Implement a token bucket that allows up to N requests per second with burst capacity B.

```java
/**
 * Simplified token bucket — calculates tokens lazily.
 */
public class SimpleTokenBucket {
    private final double maxTokens;
    private final double refillRate; // tokens per nanosecond
    private double tokens;
    private long lastRefillTime;

    public SimpleTokenBucket(double maxTokens, double tokensPerSecond) {
        this.maxTokens = maxTokens;
        this.refillRate = tokensPerSecond / 1_000_000_000.0;
        this.tokens = maxTokens;
        this.lastRefillTime = System.nanoTime();
    }

    public synchronized boolean tryAcquire() {
        refill();
        if (tokens >= 1.0) {
            tokens -= 1.0;
            return true;
        }
        return false;
    }

    private void refill() {
        long now = System.nanoTime();
        double added = (now - lastRefillTime) * refillRate;
        tokens = Math.min(maxTokens, tokens + added);
        lastRefillTime = now;
    }
    // O(1). Two floating-point ops + one comparison.
}
```

**P11.11** [E] — DNS Cache Lookup
Implement a simple DNS cache with TTL support.

```java
/**
 * DNS cache: HashMap<domain, (ip, expiryTime)>.
 * Lazy expiration on get().
 */
public class SimpleDNSCache {
    private record Entry(String ip, long expiryMillis) {
        boolean expired() { return System.currentTimeMillis() > expiryMillis; }
    }

    private final Map<String, Entry> cache = new HashMap<>();

    public String resolve(String domain) {
        Entry e = cache.get(domain.toLowerCase());
        if (e != null && !e.expired()) return e.ip;
        cache.remove(domain.toLowerCase());
        return null;
    }

    public void cache(String domain, String ip, long ttlSeconds) {
        cache.put(domain.toLowerCase(),
                  new Entry(ip, System.currentTimeMillis() + ttlSeconds * 1000));
    }
    // O(1) for resolve and cache.
}
```

**P11.12** [E] — Leaky Bucket Rate Limiter
Implement a leaky bucket that processes requests at a fixed rate.

```java
/**
 * Leaky bucket: enforces constant output rate.
 * Unlike token bucket, does NOT allow bursts.
 */
public class SimpleLeakyBucket {
    private final int capacity;
    private final double leakRatePerNano;
    private double water;
    private long lastLeakTime;

    public SimpleLeakyBucket(int capacity, int leaksPerSecond) {
        this.capacity = capacity;
        this.leakRatePerNano = leaksPerSecond / 1_000_000_000.0;
        this.water = 0;
        this.lastLeakTime = System.nanoTime();
    }

    public synchronized boolean tryAcquire() {
        leak();
        if (water < capacity) {
            water += 1.0;
            return true;
        }
        return false; // bucket full → reject
    }

    private void leak() {
        long now = System.nanoTime();
        double leaked = (now - lastLeakTime) * leakRatePerNano;
        water = Math.max(0, water - leaked);
        lastLeakTime = now;
    }
    // O(1). Behavioral difference from token bucket: no burst allowance.
}
```

**P11.13** [E] — Weighted Random Server Selection
Select a server randomly with probability proportional to its weight.

```java
import java.util.*;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Weighted random selection using prefix sums + binary search.
 * 
 * Precompute cumulative weights: [3, 1, 2] → [3, 4, 6]
 * Generate random in [0, totalWeight): map to server via binary search.
 * 
 * Construction: O(n). Selection: O(log n).
 */
public class WeightedRandomSelector {
    private final String[] servers;
    private final int[] cumulativeWeights;
    private final int totalWeight;

    public WeightedRandomSelector(Map<String, Integer> serverWeights) {
        int n = serverWeights.size();
        servers = new String[n];
        cumulativeWeights = new int[n];
        int i = 0, cum = 0;
        for (var entry : serverWeights.entrySet()) {
            servers[i] = entry.getKey();
            cum += entry.getValue();
            cumulativeWeights[i] = cum;
            i++;
        }
        totalWeight = cum;
    }

    public String select() {
        int r = ThreadLocalRandom.current().nextInt(totalWeight);
        int idx = Arrays.binarySearch(cumulativeWeights, r + 1);
        if (idx < 0) idx = -idx - 1;
        return servers[idx];
    }
    // O(log n) per selection. Memory: O(n).
}
```

**P11.14** [E] — Cache Entry Counter
Count the total number of unique keys that have ever been cached, even after eviction.

```java
/**
 * LRU Cache that tracks total unique keys ever inserted.
 * Uses a separate counter — the map.size() only tracks current entries.
 */
public class CountingLRUCache<K, V> {
    private final LRUCacheLinkedHashMap<K, V> cache;
    private final Set<K> everSeen = new HashSet<>();

    public CountingLRUCache(int capacity) {
        cache = new LRUCacheLinkedHashMap<>(capacity);
    }

    public V get(K key) { return cache.get(key); }

    public void put(K key, V value) {
        everSeen.add(key);
        cache.put(key, value);
    }

    public long totalUniqueSeen() { return everSeen.size(); }
    public int currentSize() { return cache.size(); }
    // Trade-off: unbounded memory in everSeen. Use HyperLogLog for approximate count.
}
```

**P11.15** [E] — Connection Pool Health Check
Extend the simple connection pool to periodically validate idle connections.

```java
import java.util.*;
import java.util.concurrent.*;

/**
 * Connection pool with idle connection validation.
 * 
 * Idle connections may be closed by the server (TCP timeout, firewall).
 * We validate them before handing to the caller, or in a background thread.
 */
public class HealthCheckPool<C> {
    private final ArrayBlockingQueue<C> pool;
    private final java.util.function.Predicate<C> validator;
    private final java.util.function.Supplier<C> factory;

    public HealthCheckPool(int size, java.util.function.Supplier<C> factory,
                            java.util.function.Predicate<C> validator) {
        this.pool = new ArrayBlockingQueue<>(size);
        this.factory = factory;
        this.validator = validator;
        for (int i = 0; i < size; i++) pool.offer(factory.get());
    }

    public C borrow(long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            C conn = pool.poll(deadline - System.currentTimeMillis(), TimeUnit.MILLISECONDS);
            if (conn == null) throw new TimeoutException("Pool exhausted");
            if (validator.test(conn)) return conn; // healthy
            // Unhealthy — discard and try to create a replacement
            pool.offer(factory.get());
        }
        throw new TimeoutException("Pool exhausted");
    }

    public void release(C conn) { pool.offer(conn); }
    // O(1) amortized. Validation adds latency but prevents using dead connections.
}
```

---

### Medium Problems

**P11.16** [M] — LFU Cache
Design and implement an O(1) LFU cache with `get` and `put`.

```java
/**
 * LeetCode 460: LFU Cache
 * 
 * See Section 11.1.2 for the full O(1) LFU implementation with frequency buckets.
 * 
 * Key insight: maintaining a minFreq integer eliminates the need to search
 * for the minimum-frequency bucket. It only changes in two controlled ways:
 *   1. New insert → minFreq = 1
 *   2. incrementFreq empties the minFreq bucket → minFreq++
 * 
 * Complexity: O(1) for get and put.
 * Space: O(capacity) + O(distinct frequencies) for bucket overhead.
 * 
 * Real-world: Redis's allkeys-lfu and volatile-lfu eviction policies use
 * an approximate LFU with a probabilistic counter (Morris counter) to
 * reduce memory from a full frequency count to 8 bits per key.
 */
// Implementation: see LFUCache class in Section 11.1.2
```

**P11.17** [M] — TTL Cache with Lazy + Eager Expiration
Implement a cache where entries expire after a configurable TTL, using both lazy checks and a background cleanup thread.

```java
/**
 * Hybrid TTL cache combining lazy and eager expiration.
 * See Section 11.1.5 for full PriorityQueue and DelayQueue implementations.
 * 
 * The hybrid approach:
 *   - Lazy: check expiry on get() → never return stale data
 *   - Eager: background thread cleans expired entries → free memory
 * 
 * Why both? Lazy alone leaves expired entries in memory (memory leak).
 * Eager alone might have a window where stale data is returned before cleanup runs.
 * Together they guarantee correctness AND memory efficiency.
 */
public class HybridTTLCache<K, V> {
    private record TimedEntry<K, V>(K key, V value, long expiryNanos) {}

    private final ConcurrentHashMap<K, TimedEntry<K, V>> map = new ConcurrentHashMap<>();
    private final PriorityQueue<TimedEntry<K, V>> expiryHeap =
        new PriorityQueue<>(Comparator.comparingLong(e -> e.expiryNanos));
    private final long defaultTTLNanos;

    public HybridTTLCache(long ttlSeconds) {
        this.defaultTTLNanos = ttlSeconds * 1_000_000_000L;
        startEagerCleanup();
    }

    public V get(K key) {
        TimedEntry<K, V> e = map.get(key);
        if (e == null) return null;
        if (System.nanoTime() > e.expiryNanos) {
            map.remove(key, e); // lazy expiration
            return null;
        }
        return e.value;
    }

    public void put(K key, V value) {
        TimedEntry<K, V> entry = new TimedEntry<>(key, value, System.nanoTime() + defaultTTLNanos);
        map.put(key, entry);
        synchronized (expiryHeap) {
            expiryHeap.offer(entry);
        }
    }

    private void startEagerCleanup() {
        ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "ttl-cleanup");
            t.setDaemon(true);
            return t;
        });
        scheduler.scheduleAtFixedRate(() -> {
            long now = System.nanoTime();
            synchronized (expiryHeap) {
                while (!expiryHeap.isEmpty() && expiryHeap.peek().expiryNanos <= now) {
                    TimedEntry<K, V> expired = expiryHeap.poll();
                    map.remove(expired.key, expired);
                }
            }
        }, 1, 1, TimeUnit.SECONDS);
    }
    // get(): O(1). put(): O(log n) due to heap insertion. Cleanup: O(k log n).
}
```

**P11.18** [M] — Sliding Window Rate Limiter
Implement a precise sliding-window rate limiter using a sorted structure.

```java
/**
 * Sliding window log using TreeMap for multi-key rate limiting.
 * 
 * For each API key, maintain a TreeMap<Long, Integer> where:
 *   key = timestamp (millisecond precision)
 *   value = request count at that millisecond
 * 
 * To check rate: sum counts in [now-window, now].
 * TreeMap.subMap gives this range in O(log n).
 */
public class SlidingWindowRateLimiter {
    private final int maxRequests;
    private final long windowMillis;
    private final Map<String, TreeMap<Long, Integer>> perKeyWindows = new HashMap<>();

    public SlidingWindowRateLimiter(int maxRequests, long windowMillis) {
        this.maxRequests = maxRequests;
        this.windowMillis = windowMillis;
    }

    public synchronized boolean allow(String apiKey) {
        long now = System.currentTimeMillis();
        TreeMap<Long, Integer> window = perKeyWindows.computeIfAbsent(apiKey, k -> new TreeMap<>());

        // Remove expired entries
        window.headMap(now - windowMillis).clear();

        // Count requests in window
        int count = window.values().stream().mapToInt(Integer::intValue).sum();

        if (count >= maxRequests) return false;

        window.merge(now, 1, Integer::sum);
        return true;
    }
    // O(log n + k) per check where k = entries in window. For small windows, k is small.
}
```

**P11.19** [M] — Consistent Hashing with Virtual Nodes
Implement a consistent hashing ring with configurable virtual nodes per server.

```java
/**
 * Full consistent hashing implementation — see Section 11.5.4.
 * 
 * Key additions for this problem:
 *   - Track which keys map to which server (for redistribution analysis)
 *   - Report redistribution impact when servers are added/removed
 */
public class ConsistentHashingFull {
    private final TreeMap<Long, String> ring = new TreeMap<>();
    private final int vNodes;
    private final Map<String, Set<Long>> serverPositions = new HashMap<>();

    public ConsistentHashingFull(int virtualNodesPerServer) {
        this.vNodes = virtualNodesPerServer;
    }

    public void addServer(String server) {
        Set<Long> positions = new HashSet<>();
        for (int i = 0; i < vNodes; i++) {
            long hash = fnv1a(server + "-vn" + i);
            ring.put(hash, server);
            positions.add(hash);
        }
        serverPositions.put(server, positions);
    }

    public void removeServer(String server) {
        Set<Long> positions = serverPositions.remove(server);
        if (positions != null) positions.forEach(ring::remove);
    }

    public String route(String key) {
        if (ring.isEmpty()) return null;
        long hash = fnv1a(key);
        Map.Entry<Long, String> entry = ring.ceilingEntry(hash);
        return entry != null ? entry.getValue() : ring.firstEntry().getValue();
    }

    private static long fnv1a(String s) {
        long hash = 0xcbf29ce484222325L;
        for (int i = 0; i < s.length(); i++) {
            hash ^= s.charAt(i);
            hash *= 0x100000001b3L;
        }
        return hash;
    }
    // O(log(N*V)) per route. V virtual nodes per N servers.
    // With V=150, N=10: log(1500) ≈ 11 comparisons. Practically O(1).
}
```

**P11.20** [M] — Connection Pool with Max Wait and Timeout
Design a connection pool that supports max-wait timeout and idle-connection eviction.

```java
import java.util.concurrent.*;

/**
 * Production-grade connection pool features:
 *   - Max wait timeout for borrowing
 *   - Idle timeout: connections unused for too long are closed
 *   - Min/max pool size
 */
public class AdvancedConnectionPool {
    private final ArrayBlockingQueue<PooledConnection> idle;
    private final int maxSize;
    private final long idleTimeoutNanos;
    private int totalCreated;

    private static class PooledConnection {
        final Object connection; // actual JDBC connection / socket
        long lastUsedNanos;

        PooledConnection(Object conn) {
            this.connection = conn;
            this.lastUsedNanos = System.nanoTime();
        }

        boolean isIdleTooLong(long timeoutNanos) {
            return System.nanoTime() - lastUsedNanos > timeoutNanos;
        }
    }

    public AdvancedConnectionPool(int maxSize, long idleTimeoutSeconds) {
        this.idle = new ArrayBlockingQueue<>(maxSize);
        this.maxSize = maxSize;
        this.idleTimeoutNanos = idleTimeoutSeconds * 1_000_000_000L;
        this.totalCreated = 0;
    }

    public Object borrow(long timeoutMs) throws Exception {
        // Try to get an idle connection
        PooledConnection pc = idle.poll();
        if (pc != null) {
            if (!pc.isIdleTooLong(idleTimeoutNanos)) {
                pc.lastUsedNanos = System.nanoTime();
                return pc.connection;
            }
            // Idle too long — discard and create new
            close(pc);
            totalCreated--;
        }

        // Create new if under max
        synchronized (this) {
            if (totalCreated < maxSize) {
                totalCreated++;
                return createConnection();
            }
        }

        // At max — wait for a return
        pc = idle.poll(timeoutMs, TimeUnit.MILLISECONDS);
        if (pc == null) throw new TimeoutException("Connection pool timeout");
        pc.lastUsedNanos = System.nanoTime();
        return pc.connection;
    }

    public void release(Object conn) {
        idle.offer(new PooledConnection(conn));
    }

    private Object createConnection() { return new Object(); /* placeholder */ }
    private void close(PooledConnection pc) { /* close actual connection */ }
}
```

**P11.21** [M] — Read-Through Cache
Implement a read-through cache that automatically fetches missing values from a data source.

```java
import java.util.function.Function;

/**
 * Read-through cache: on miss, automatically loads from the backing store.
 * 
 * Combines LRU eviction with transparent loading.
 * This is exactly what Guava Cache and Caffeine provide.
 */
public class ReadThroughCache<K, V> {
    private final LRUCache<K, V> cache;
    private final Function<K, V> loader;

    public ReadThroughCache(int capacity, Function<K, V> loader) {
        this.cache = new LRUCache<>(capacity);
        this.loader = loader;
    }

    public V get(K key) {
        V cached = cache.get(key);
        if (cached != null) return cached;

        // Cache miss — load from source
        V value = loader.apply(key);
        if (value != null) {
            cache.put(key, value);
        }
        return value;
    }

    /**
     * Problem: thundering herd. If 100 threads call get("popular_key")
     * simultaneously and all miss, they all call loader.apply("popular_key").
     * 
     * Fix: use ConcurrentHashMap.computeIfAbsent or a loading lock per key.
     * Caffeine handles this with a per-key ReentrantLock stored in the cache entry.
     */
}
```

**P11.22** [M] — Write-Through Cache
Implement a write-through cache that persists writes to the backing store synchronously.

```java
import java.util.function.BiConsumer;

/**
 * Write-through cache: every put() writes to both cache and backing store.
 * Guarantees consistency: cache always reflects the store.
 * 
 * Tradeoff: higher write latency (must wait for store write).
 * Alternative: write-behind (async write to store, lower latency, eventual consistency).
 */
public class WriteThroughCache<K, V> {
    private final LRUCache<K, V> cache;
    private final BiConsumer<K, V> storageWriter;
    private final Function<K, V> storageReader;

    public WriteThroughCache(int capacity, BiConsumer<K, V> writer,
                              Function<K, V> reader) {
        this.cache = new LRUCache<>(capacity);
        this.storageWriter = writer;
        this.storageReader = reader;
    }

    public V get(K key) {
        V cached = cache.get(key);
        if (cached != null) return cached;
        V value = storageReader.apply(key);
        if (value != null) cache.put(key, value);
        return value;
    }

    public void put(K key, V value) {
        storageWriter.accept(key, value); // write to store FIRST
        cache.put(key, value);            // then update cache
        // If store write fails, exception propagates — cache not updated.
        // This ensures cache never has data that the store does not.
    }
    // Write-through: strong consistency, higher write latency.
    // Write-behind: eventual consistency, lower write latency.
    // Write-around: only cache on read, never on write.
}
```

**P11.23** [M] — Least-Connections Load Balancer
Implement a load balancer that always routes to the server with the fewest active connections.

```java
/**
 * See Section 11.5.3 for TreeSet-based implementation.
 * 
 * Alternative O(1) approach: bucket queue.
 * Array where index = connection count, each bucket is a set of servers.
 * Track minBucket globally for O(1) minimum lookup.
 */
public class BucketLeastConnections {
    private final Map<String, Integer> serverConns = new HashMap<>();
    private final List<Set<String>> buckets; // index = connection count
    private int minBucket = 0;

    public BucketLeastConnections(List<String> servers, int maxConns) {
        buckets = new ArrayList<>(maxConns + 1);
        for (int i = 0; i <= maxConns; i++) buckets.add(new LinkedHashSet<>());
        for (String s : servers) {
            serverConns.put(s, 0);
            buckets.get(0).add(s);
        }
    }

    public synchronized String acquire() {
        while (minBucket < buckets.size() && buckets.get(minBucket).isEmpty()) {
            minBucket++;
        }
        String server = buckets.get(minBucket).iterator().next();
        buckets.get(minBucket).remove(server);
        int newCount = minBucket + 1;
        serverConns.put(server, newCount);
        buckets.get(newCount).add(server);
        return server;
    }

    public synchronized void release(String server) {
        int current = serverConns.get(server);
        buckets.get(current).remove(server);
        int newCount = current - 1;
        serverConns.put(server, newCount);
        buckets.get(newCount).add(server);
        if (newCount < minBucket) minBucket = newCount;
    }
    // O(1) for acquire and release. Memory: O(servers * maxConns).
}
```

**P11.24** [M] — CDN Cache with Request Coalescing
Implement a cache that coalesces concurrent requests for the same key, ensuring only one fetch happens.

```java
import java.util.concurrent.*;
import java.util.function.Function;

/**
 * Request coalescing (singleflight) cache.
 * 
 * When multiple threads request the same uncached key simultaneously,
 * only ONE thread fetches from origin. Others wait for the result.
 * 
 * DS: ConcurrentHashMap<K, CompletableFuture<V>> for in-flight requests.
 * 
 * This is critical for CDNs: a cache miss for a popular URL can trigger
 * thousands of origin requests simultaneously ("thundering herd").
 * Coalescing reduces this to exactly one.
 */
public class CoalescingCache<K, V> {
    private final ConcurrentHashMap<K, V> cache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<K, CompletableFuture<V>> inFlight = new ConcurrentHashMap<>();
    private final Function<K, V> fetcher;

    public CoalescingCache(Function<K, V> fetcher) {
        this.fetcher = fetcher;
    }

    public V get(K key) throws Exception {
        // Check cache first
        V cached = cache.get(key);
        if (cached != null) return cached;

        // Check if another thread is already fetching this key
        CompletableFuture<V> existing = inFlight.get(key);
        if (existing != null) {
            return existing.get(); // wait for the other thread's result
        }

        // We are the first — create a future and start fetching
        CompletableFuture<V> future = new CompletableFuture<>();
        CompletableFuture<V> race = inFlight.putIfAbsent(key, future);
        if (race != null) {
            return race.get(); // another thread won the race
        }

        try {
            V value = fetcher.apply(key);
            cache.put(key, value);
            future.complete(value);
            return value;
        } catch (Exception e) {
            future.completeExceptionally(e);
            throw e;
        } finally {
            inFlight.remove(key);
        }
    }
    /**
     * Real-world: Nginx proxy_cache_lock, Varnish coalescing, Cloudflare request collapsing.
     * 
     * JVM insight: CompletableFuture.get() parks the thread (via LockSupport.park()).
     * No busy-waiting. The OS scheduler wakes the thread when complete() is called.
     * Cost: ~1 us for park/unpark (OS context switch), far cheaper than redundant fetches.
     */
}
```

**P11.25** [M] — Key-Value Store with Expiry
Implement a key-value store where each key can have an individual TTL.

```java
/**
 * Per-key TTL cache using HashMap + PriorityQueue.
 * Each key can have a different TTL set at put() time.
 */
public class ExpiringKVStore<K, V> {
    private record Entry<K, V>(K key, V value, long expiryNanos)
            implements Comparable<Entry<K, V>> {
        @Override
        public int compareTo(Entry<K, V> o) {
            return Long.compare(this.expiryNanos, o.expiryNanos);
        }
    }

    private final Map<K, Entry<K, V>> map = new HashMap<>();
    private final PriorityQueue<Entry<K, V>> expiryQueue = new PriorityQueue<>();

    public V get(K key) {
        Entry<K, V> e = map.get(key);
        if (e == null) return null;
        if (System.nanoTime() > e.expiryNanos) {
            map.remove(key);
            return null;
        }
        return e.value;
    }

    public void put(K key, V value, long ttlSeconds) {
        Entry<K, V> entry = new Entry<>(key, value, System.nanoTime() + ttlSeconds * 1_000_000_000L);
        map.put(key, entry);
        expiryQueue.offer(entry);
    }

    public void cleanUp() {
        long now = System.nanoTime();
        while (!expiryQueue.isEmpty() && expiryQueue.peek().expiryNanos <= now) {
            Entry<K, V> expired = expiryQueue.poll();
            map.remove(expired.key, expired);
        }
    }
    // get(): O(1). put(): O(log n). cleanUp(): O(k log n).
}
```

**P11.26** [M] — Multi-Tier Cache (L1 + L2)
Implement a two-level cache: fast L1 (small, in-memory LRU) and slower L2 (large, disk-backed or remote).

```java
import java.util.function.Function;

/**
 * Two-level cache: L1 (small, fast) → L2 (large, slower) → origin.
 * 
 * On miss at L1: check L2. If hit in L2, promote to L1.
 * On miss at L2: fetch from origin, populate both L1 and L2.
 * 
 * Models: CPU L1/L2, browser memory/disk cache, CDN edge/origin.
 */
public class TwoLevelCache<K, V> {
    private final LRUCache<K, V> l1;
    private final LRUCache<K, V> l2;
    private final Function<K, V> origin;

    public TwoLevelCache(int l1Size, int l2Size, Function<K, V> origin) {
        this.l1 = new LRUCache<>(l1Size);
        this.l2 = new LRUCache<>(l2Size);
        this.origin = origin;
    }

    public V get(K key) {
        // L1 check
        V value = l1.get(key);
        if (value != null) return value; // L1 hit

        // L2 check
        value = l2.get(key);
        if (value != null) {
            l1.put(key, value); // promote to L1
            return value;       // L2 hit
        }

        // Origin fetch
        value = origin.apply(key);
        if (value != null) {
            l2.put(key, value); // populate L2
            l1.put(key, value); // populate L1
        }
        return value; // origin response (or null)
    }

    public void put(K key, V value) {
        l1.put(key, value);
        l2.put(key, value);
    }
    // L1 hit: O(1). L2 hit: O(1) + L1 insert O(1). Origin: depends on backend.
}
```

**P11.27** [M] — API Gateway Rate Limiter (Per-Client)
Implement a rate limiter that enforces per-client rate limits using sliding windows.

```java
/**
 * Per-client rate limiter using HashMap<ClientID, SlidingWindowLog>.
 * Each client gets its own sliding window.
 * 
 * Memory consideration: with 100K clients and 100-entry windows,
 * that is 10M timestamps × 8 bytes = 80 MB. Use fixed-window counters
 * if memory is a concern.
 */
public class PerClientRateLimiter {
    private final int maxRequests;
    private final long windowMillis;
    private final ConcurrentHashMap<String, Deque<Long>> clientWindows =
        new ConcurrentHashMap<>();

    public PerClientRateLimiter(int maxRequests, long windowMillis) {
        this.maxRequests = maxRequests;
        this.windowMillis = windowMillis;
    }

    public boolean allow(String clientId) {
        Deque<Long> window = clientWindows.computeIfAbsent(clientId,
            k -> new ConcurrentLinkedDeque<>());

        long now = System.currentTimeMillis();
        long cutoff = now - windowMillis;

        // Evict old timestamps
        while (!window.isEmpty() && window.peekFirst() <= cutoff) {
            window.pollFirst();
        }

        if (window.size() >= maxRequests) return false;
        window.addLast(now);
        return true;
    }

    public void cleanup() {
        // Remove empty or expired client entries to free memory
        clientWindows.entrySet().removeIf(e -> e.getValue().isEmpty());
    }
    // O(1) amortized per request. Total memory: O(clients × maxRequests).
}
```

**P11.28** [M] — Power-of-Two-Choices Load Balancer
Implement the P2C algorithm with connection tracking.

```java
/**
 * See Section 11.5.5 for the core algorithm.
 * 
 * Enhancement: use Exponentially Weighted Moving Average (EWMA) of
 * response latency instead of raw connection count for better load estimation.
 * This is what Envoy and Finagle use.
 */
public class P2CWithEWMA {
    private static class ServerStats {
        final String name;
        int activeConns;
        double ewmaLatencyMs; // exponentially weighted moving average
        static final double ALPHA = 0.3; // decay factor

        ServerStats(String name) { this.name = name; }

        void recordLatency(long latencyMs) {
            ewmaLatencyMs = ALPHA * latencyMs + (1 - ALPHA) * ewmaLatencyMs;
        }

        double score() {
            return activeConns * (1 + ewmaLatencyMs / 100.0); // composite score
        }
    }

    private final ServerStats[] servers;

    public P2CWithEWMA(List<String> serverNames) {
        servers = serverNames.stream().map(ServerStats::new).toArray(ServerStats[]::new);
    }

    public synchronized String acquire() {
        int i = ThreadLocalRandom.current().nextInt(servers.length);
        int j = ThreadLocalRandom.current().nextInt(servers.length);
        while (j == i && servers.length > 1) j = ThreadLocalRandom.current().nextInt(servers.length);

        ServerStats chosen = servers[i].score() <= servers[j].score() ? servers[i] : servers[j];
        chosen.activeConns++;
        return chosen.name;
    }

    public synchronized void release(String server, long latencyMs) {
        for (ServerStats s : servers) {
            if (s.name.equals(server)) {
                s.activeConns--;
                s.recordLatency(latencyMs);
                return;
            }
        }
    }
    // O(1). The EWMA decays old latency measurements, adapting to changing conditions.
}
```

**P11.29** [M] — Distributed Rate Limiter (Token Bucket with Redis-like Semantics)
Design a rate limiter that works across multiple application instances by using a shared counter with atomic operations.

```java
/**
 * Simulates distributed rate limiting using a shared AtomicLong
 * (in production, this would be a Redis INCR + EXPIRE).
 * 
 * The token bucket is stored externally. Each application instance
 * atomically decrements the shared counter.
 * 
 * Redis Lua script equivalent:
 *   local current = redis.call('GET', KEYS[1])
 *   if current and tonumber(current) >= tonumber(ARGV[1]) then
 *     return 0  -- rate limited
 *   end
 *   redis.call('INCR', KEYS[1])
 *   redis.call('EXPIRE', KEYS[1], ARGV[2])
 *   return 1  -- allowed
 */
public class DistributedRateLimiter {
    // Simulating shared state (in production: Redis, Memcached, or ZooKeeper)
    private final AtomicLong sharedCounter = new AtomicLong(0);
    private volatile long windowStart = System.currentTimeMillis();
    private final int maxRequests;
    private final long windowMillis;

    public DistributedRateLimiter(int maxRequests, long windowMillis) {
        this.maxRequests = maxRequests;
        this.windowMillis = windowMillis;
    }

    public boolean tryAcquire() {
        long now = System.currentTimeMillis();
        if (now - windowStart >= windowMillis) {
            // New window — reset atomically
            synchronized (this) {
                if (now - windowStart >= windowMillis) {
                    sharedCounter.set(0);
                    windowStart = now;
                }
            }
        }

        long current = sharedCounter.incrementAndGet();
        return current <= maxRequests;
    }
    // In production with Redis: MULTI/EXEC or Lua scripts ensure atomicity.
    // Latency: ~1ms per Redis roundtrip. Acceptable for API gateways.
}
```

**P11.30** [M] — Cache with Write-Behind (Async Persistence)
Implement a cache that buffers writes and flushes them to the backing store asynchronously.

```java
/**
 * Write-behind cache: writes are buffered and flushed asynchronously.
 * Lower write latency than write-through, but eventual consistency.
 * 
 * DS: LRU cache + LinkedBlockingQueue (write buffer) + background flush thread.
 */
public class WriteBehindCache<K, V> {
    private final LRUCache<K, V> cache;
    private final LinkedBlockingQueue<Map.Entry<K, V>> writeBuffer;
    private final BiConsumer<K, V> storageWriter;

    public WriteBehindCache(int cacheSize, int bufferSize,
                             BiConsumer<K, V> writer) {
        this.cache = new LRUCache<>(cacheSize);
        this.writeBuffer = new LinkedBlockingQueue<>(bufferSize);
        this.storageWriter = writer;
        startFlushThread();
    }

    public V get(K key) { return cache.get(key); }

    public void put(K key, V value) {
        cache.put(key, value); // update cache immediately
        writeBuffer.offer(Map.entry(key, value)); // buffer the write (non-blocking)
    }

    private void startFlushThread() {
        Thread flusher = new Thread(() -> {
            List<Map.Entry<K, V>> batch = new ArrayList<>();
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    batch.clear();
                    // Block until at least one write is available
                    batch.add(writeBuffer.take());
                    // Drain additional writes (up to 100) for batching
                    writeBuffer.drainTo(batch, 99);
                    // Flush batch to storage
                    for (var entry : batch) {
                        storageWriter.accept(entry.getKey(), entry.getValue());
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }, "write-behind-flusher");
        flusher.setDaemon(true);
        flusher.start();
    }
    // put(): O(1) — no storage I/O on the caller's thread.
    // Batching: amortizes storage write overhead.
    // Risk: data loss if the process crashes before flush.
}
```

**P11.31** [M] — LRU Cache with Statistics
Extend an LRU cache to track hit rate, miss rate, eviction count, and average access time.

```java
/**
 * LRU cache with built-in statistics tracking.
 * Every cache in production (Caffeine, Guava, EhCache) provides these metrics.
 */
public class StatsLRUCache<K, V> {
    private final LRUCache<K, V> cache;
    private long hits, misses, evictions;
    private long totalAccessTimeNanos;
    private long accessCount;

    public StatsLRUCache(int capacity) {
        this.cache = new LRUCache<>(capacity);
    }

    public V get(K key) {
        long start = System.nanoTime();
        V value = cache.get(key);
        totalAccessTimeNanos += System.nanoTime() - start;
        accessCount++;
        if (value != null) hits++;
        else misses++;
        return value;
    }

    public void put(K key, V value) {
        int sizeBefore = cache.size();
        cache.put(key, value);
        if (sizeBefore == cache.size() && !key.equals(null)) {
            // Size did not grow — either update or eviction happened
            // Simple heuristic: if this was a new key, an eviction occurred
        }
    }

    public double hitRate() { return hits + misses == 0 ? 0 : (double) hits / (hits + misses); }
    public double missRate() { return 1.0 - hitRate(); }
    public double avgAccessNanos() { return accessCount == 0 ? 0 : (double) totalAccessTimeNanos / accessCount; }
    // Caffeine tracks these with LongAdder (lock-free, scalable counters).
}
```

**P11.32** [M] — Thread-Safe LRU Cache
Make the LRU cache thread-safe using ReentrantReadWriteLock.

```java
import java.util.concurrent.locks.*;

/**
 * Thread-safe LRU with ReadWriteLock.
 * 
 * Read lock for get() — multiple concurrent readers.
 * Write lock for put() and eviction — exclusive.
 * 
 * Problem: get() in LRU mutates the linked list (moveToHead).
 * So get() also needs the write lock. ReadWriteLock gives no benefit!
 * 
 * Solution: Caffeine's approach — record accesses in a lock-free ring buffer,
 * process them asynchronously in a single maintenance thread.
 */
public class ThreadSafeLRU<K, V> {
    private final LRUCache<K, V> cache;
    private final ReentrantLock lock = new ReentrantLock();

    public ThreadSafeLRU(int capacity) {
        this.cache = new LRUCache<>(capacity);
    }

    public V get(K key) {
        lock.lock();
        try {
            return cache.get(key);
        } finally {
            lock.unlock();
        }
    }

    public void put(K key, V value) {
        lock.lock();
        try {
            cache.put(key, value);
        } finally {
            lock.unlock();
        }
    }
    /**
     * Better approaches for high concurrency:
     * 
     * 1. Caffeine: lock-free reads via ConcurrentHashMap + ring buffer for
     *    recording accesses + single maintenance thread for LRU reordering.
     *    get() throughput: ~100M ops/sec.
     * 
     * 2. Striped locking: partition the key space into N segments, each with
     *    its own lock and LRU list. Reduces contention by N.
     *    ConcurrentHashMap uses this internally (16 segments in JDK 7).
     * 
     * 3. Read-optimized: ConcurrentHashMap for reads, synchronized eviction.
     *    Works when reads >> writes (typical for caches).
     */
}
```

**P11.33** [M] — Cache Stampede Prevention
Implement a cache that prevents stampedes using probabilistic early recomputation.

```java
/**
 * Probabilistic early recomputation (XFetch algorithm).
 * 
 * Before an entry expires, recompute it with probability that increases
 * as the expiry approaches. This spreads recomputations over time instead
 * of all hitting at once when the entry expires.
 * 
 * P(recompute) = exp(-delta / (beta * remaining_ttl))
 *   where delta = random variable, beta = tuning parameter
 */
public class StampedePreventionCache<K, V> {
    private record Entry<V>(V value, long expiryNanos, long ttlNanos) {}

    private final Map<K, Entry<V>> cache = new ConcurrentHashMap<>();
    private final Function<K, V> loader;
    private final double beta; // tuning: higher = earlier recomputation

    public StampedePreventionCache(Function<K, V> loader, double beta) {
        this.loader = loader;
        this.beta = beta;
    }

    public V get(K key, long ttlSeconds) {
        Entry<V> entry = cache.get(key);
        if (entry != null) {
            long remaining = entry.expiryNanos - System.nanoTime();
            if (remaining > 0) {
                // Probabilistic early recomputation
                double random = -Math.log(ThreadLocalRandom.current().nextDouble());
                if (random * beta * entry.ttlNanos < remaining) {
                    return entry.value; // not recomputing yet
                }
                // Recompute early to prevent stampede
            }
        }
        // Miss or early recompute
        V value = loader.apply(key);
        long ttlNanos = ttlSeconds * 1_000_000_000L;
        cache.put(key, new Entry<>(value, System.nanoTime() + ttlNanos, ttlNanos));
        return value;
    }
    // Spreads recomputation load. Netflix, Facebook use similar approaches.
}
```

**P11.34** [M] — Hash Ring Rebalancing
Given a consistent hash ring, compute the set of keys that need to move when a server is added.

```java
/**
 * Key redistribution analysis for consistent hashing.
 * When adding server S, keys that previously mapped to the server
 * clockwise from S now map to S instead.
 */
public class HashRingRebalancer {
    private final TreeMap<Long, String> ring;
    private final int vNodes;

    public HashRingRebalancer(TreeMap<Long, String> ring, int vNodes) {
        this.ring = ring;
        this.vNodes = vNodes;
    }

    /**
     * Returns the ranges of hash space that would be claimed by a new server.
     */
    public List<long[]> computeRedistribution(String newServer) {
        List<long[]> claimedRanges = new ArrayList<>();
        for (int i = 0; i < vNodes; i++) {
            long hash = fnv1a(newServer + "-vn" + i);
            // This position would be inserted. Keys between the previous position
            // and this hash that currently map to the next server would now map to newServer.
            Map.Entry<Long, String> next = ring.ceilingEntry(hash);
            if (next == null) next = ring.firstEntry();

            Map.Entry<Long, String> prev = ring.lowerEntry(hash);
            if (prev == null) prev = ring.lastEntry();

            // Keys in range (prev.key, hash] would move from next.server to newServer
            claimedRanges.add(new long[]{prev.getKey() + 1, hash});
        }
        return claimedRanges;
    }

    private static long fnv1a(String s) {
        long hash = 0xcbf29ce484222325L;
        for (int i = 0; i < s.length(); i++) {
            hash ^= s.charAt(i);
            hash *= 0x100000001b3L;
        }
        return hash;
    }
    // O(V * log(N*V)) where V = virtual nodes, N = servers.
}
```

**P11.35** [M] — Weighted Consistent Hashing
Modify consistent hashing so that servers with higher weights get proportionally more virtual nodes.

```java
/**
 * Weighted consistent hashing: weight determines virtual node count.
 * A server with weight 3 gets 3x more virtual nodes than weight 1.
 * 
 * This naturally gives higher-capacity servers more traffic.
 */
public class WeightedConsistentHash {
    private final TreeMap<Long, String> ring = new TreeMap<>();
    private final int baseVNodes; // virtual nodes for weight=1

    public WeightedConsistentHash(int baseVNodes) {
        this.baseVNodes = baseVNodes;
    }

    public void addServer(String server, int weight) {
        int vnCount = baseVNodes * weight;
        for (int i = 0; i < vnCount; i++) {
            long hash = fnv1a(server + "#" + i);
            ring.put(hash, server);
        }
    }

    public String route(String key) {
        if (ring.isEmpty()) return null;
        Map.Entry<Long, String> e = ring.ceilingEntry(fnv1a(key));
        return e != null ? e.getValue() : ring.firstEntry().getValue();
    }

    private static long fnv1a(String s) {
        long h = 0xcbf29ce484222325L;
        for (char c : s.toCharArray()) { h ^= c; h *= 0x100000001b3L; }
        return h;
    }
    // Server with weight 5 and baseVNodes=100 gets 500 virtual nodes.
    // It receives ~5x traffic of a weight-1 server.
}
```

**P11.36** [M] — Cache Warming Strategy
Design a cache that pre-loads hot keys on startup based on historical access data.

```java
/**
 * Cache warmer: pre-populates cache on startup using access frequency data.
 * 
 * Uses a PriorityQueue to load the top-K most accessed keys first.
 */
public class CacheWarmer<K, V> {
    private final LRUCache<K, V> cache;
    private final Function<K, V> loader;

    public CacheWarmer(int cacheSize, Function<K, V> loader) {
        this.cache = new LRUCache<>(cacheSize);
        this.loader = loader;
    }

    /**
     * Warm the cache with the top-K keys by access count.
     * @param accessCounts historical key → access count
     */
    public void warm(Map<K, Long> accessCounts) {
        // Use max-heap to find top-K keys
        PriorityQueue<Map.Entry<K, Long>> topK = new PriorityQueue<>(
            Comparator.<Map.Entry<K, Long>>comparingLong(Map.Entry::getValue).reversed()
        );
        topK.addAll(accessCounts.entrySet());

        int loaded = 0;
        while (!topK.isEmpty() && loaded < cache.size()) {
            K key = topK.poll().getKey();
            V value = loader.apply(key);
            if (value != null) {
                cache.put(key, value);
                loaded++;
            }
        }
    }

    public V get(K key) { return cache.get(key); }
    public void put(K key, V value) { cache.put(key, value); }
    // Warming eliminates the "cold start" problem where a freshly deployed
    // instance has 100% cache misses until the cache is populated organically.
}
```

**P11.37** [M] — Ring Buffer for Access Logging
Implement a fixed-size ring buffer that logs the last N cache accesses for debugging.

```java
/**
 * Ring buffer for access logging: fixed memory, O(1) append, never allocates.
 * 
 * Used in: Caffeine's read/write buffers, LMAX Disruptor, kernel ring buffers.
 */
public class AccessRingBuffer<T> {
    private final Object[] buffer;
    private int head; // next write position
    private int size;

    public AccessRingBuffer(int capacity) {
        this.buffer = new Object[capacity];
    }

    public void record(T access) {
        buffer[head] = access;
        head = (head + 1) % buffer.length;
        if (size < buffer.length) size++;
    }

    @SuppressWarnings("unchecked")
    public List<T> getRecent(int count) {
        int n = Math.min(count, size);
        List<T> result = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            int idx = ((head - 1 - i) % buffer.length + buffer.length) % buffer.length;
            result.add((T) buffer[idx]);
        }
        return result;
    }
    // O(1) record, O(k) getRecent. Fixed memory: capacity * 4 bytes (references).
}
```

**P11.38** [M] — Rate Limiter with Retry-After Header
Implement a rate limiter that returns the number of seconds until the next available slot.

```java
/**
 * Rate limiter that computes Retry-After: how long until the client can retry.
 * Essential for HTTP 429 Too Many Requests responses.
 */
public class RetryAfterRateLimiter {
    private final int maxRequests;
    private final long windowMillis;
    private final Deque<Long> timestamps = new LinkedList<>();

    public RetryAfterRateLimiter(int maxRequests, long windowMillis) {
        this.maxRequests = maxRequests;
        this.windowMillis = windowMillis;
    }

    public synchronized RateLimitResult tryAcquire() {
        long now = System.currentTimeMillis();
        while (!timestamps.isEmpty() && timestamps.peekFirst() <= now - windowMillis) {
            timestamps.pollFirst();
        }

        if (timestamps.size() < maxRequests) {
            timestamps.addLast(now);
            return new RateLimitResult(true, 0);
        }

        // Calculate retry-after: when does the oldest request leave the window?
        long oldestInWindow = timestamps.peekFirst();
        long retryAfterMs = oldestInWindow + windowMillis - now;
        return new RateLimitResult(false, retryAfterMs);
    }

    public record RateLimitResult(boolean allowed, long retryAfterMs) {}
    // O(1) amortized. retryAfterMs can be set as HTTP Retry-After header.
}
```

**P11.39** [M] — Cache Invalidation by Tag
Implement a cache that supports tag-based invalidation: invalidating a tag removes all entries with that tag.

```java
/**
 * Tag-based cache invalidation.
 * 
 * Each entry can have multiple tags. Invalidating a tag removes all entries with that tag.
 * Used in: Varnish (xkey), CDNs, Drupal cache, Next.js revalidateTag().
 * 
 * DS: HashMap<K, Entry> + HashMap<Tag, Set<K>> (reverse index).
 */
public class TaggedCache<K, V> {
    private final Map<K, V> cache = new HashMap<>();
    private final Map<K, Set<String>> keyToTags = new HashMap<>();
    private final Map<String, Set<K>> tagToKeys = new HashMap<>();

    public V get(K key) { return cache.get(key); }

    public void put(K key, V value, Set<String> tags) {
        cache.put(key, value);
        // Remove old tag associations
        Set<String> oldTags = keyToTags.remove(key);
        if (oldTags != null) {
            for (String tag : oldTags) {
                Set<K> keys = tagToKeys.get(tag);
                if (keys != null) keys.remove(key);
            }
        }
        // Add new tag associations
        keyToTags.put(key, new HashSet<>(tags));
        for (String tag : tags) {
            tagToKeys.computeIfAbsent(tag, t -> new HashSet<>()).add(key);
        }
    }

    public int invalidateTag(String tag) {
        Set<K> keys = tagToKeys.remove(tag);
        if (keys == null) return 0;
        for (K key : keys) {
            cache.remove(key);
            Set<String> tags = keyToTags.remove(key);
            if (tags != null) {
                for (String t : tags) {
                    if (!t.equals(tag)) {
                        Set<K> s = tagToKeys.get(t);
                        if (s != null) s.remove(key);
                    }
                }
            }
        }
        return keys.size();
    }
    // invalidateTag: O(k * t) where k = keys with tag, t = avg tags per key.
    // For typical use (few tags per entry): effectively O(k).
}
```

**P11.40** [M] — Bloom Filter as Cache Admission Gate
Implement a Bloom filter that prevents one-hit-wonders from polluting the cache.

```java
/**
 * Bloom filter admission gate.
 * 
 * Before inserting into the main cache, check if the key has been
 * seen before using a Bloom filter. Only admit keys seen at least twice.
 * This prevents scan pollution (one-time-access keys evicting popular ones).
 * 
 * Caffeine uses a similar approach with its Count-Min Sketch admission filter.
 */
public class BloomFilterAdmission<K, V> {
    private final long[] bloomBits;
    private final int bloomSize;
    private final int numHashes;
    private final LRUCache<K, V> cache;

    public BloomFilterAdmission(int cacheCapacity, int bloomSizeBits, int numHashes) {
        this.cache = new LRUCache<>(cacheCapacity);
        this.bloomSize = bloomSizeBits;
        this.bloomBits = new long[(bloomSizeBits + 63) / 64];
        this.numHashes = numHashes;
    }

    public V get(K key) { return cache.get(key); }

    public void put(K key, V value) {
        if (mightContain(key)) {
            // Seen before (probably) — admit to cache
            cache.put(key, value);
        }
        // Always add to Bloom filter
        addToBloom(key);
    }

    private void addToBloom(K key) {
        int hash = key.hashCode();
        for (int i = 0; i < numHashes; i++) {
            int bit = Math.floorMod(hash + i * (hash >>> 16), bloomSize);
            bloomBits[bit / 64] |= (1L << (bit % 64));
        }
    }

    private boolean mightContain(K key) {
        int hash = key.hashCode();
        for (int i = 0; i < numHashes; i++) {
            int bit = Math.floorMod(hash + i * (hash >>> 16), bloomSize);
            if ((bloomBits[bit / 64] & (1L << (bit % 64))) == 0) return false;
        }
        return true;
    }
    // Bloom filter: ~10 bits per expected key for 1% false positive rate.
    // For 1M expected keys: 10M bits = 1.25 MB. Far cheaper than storing keys.
}
```

**P11.41** [M] — Adaptive Rate Limiting
Implement a rate limiter that adjusts its limit based on server health (increase limit when healthy, decrease when stressed).

```java
/**
 * Adaptive rate limiter: adjusts rate based on error rate feedback.
 * When server returns errors, reduce the rate. When healthy, increase.
 * 
 * This is a simplified version of Netflix's concurrency limiter (Netflix/concurrency-limits).
 */
public class AdaptiveRateLimiter {
    private volatile int currentLimit;
    private final int minLimit;
    private final int maxLimit;
    private final double increaseRatio;
    private final double decreaseRatio;
    private final AtomicInteger inflight = new AtomicInteger(0);

    public AdaptiveRateLimiter(int initialLimit, int minLimit, int maxLimit) {
        this.currentLimit = initialLimit;
        this.minLimit = minLimit;
        this.maxLimit = maxLimit;
        this.increaseRatio = 1.05; // increase 5% on success
        this.decreaseRatio = 0.75; // decrease 25% on failure (aggressive backoff)
    }

    public boolean tryAcquire() {
        int current = inflight.get();
        if (current >= currentLimit) return false;
        return inflight.compareAndSet(current, current + 1);
    }

    public void onSuccess() {
        inflight.decrementAndGet();
        currentLimit = Math.min(maxLimit, (int)(currentLimit * increaseRatio));
    }

    public void onError() {
        inflight.decrementAndGet();
        currentLimit = Math.max(minLimit, (int)(currentLimit * decreaseRatio));
    }
    // Additive increase, multiplicative decrease (AIMD) — the same algorithm
    // TCP congestion control uses. Proven stable since 1988.
}
```

**P11.42** [M] — Cache Size Estimator
Estimate the memory footprint of a cache based on entry count, key size, and value size.

```java
/**
 * JVM-aware memory estimator for cache sizing.
 * Accounts for object headers, padding, HashMap overhead, and compressed OOPs.
 */
public class CacheSizeEstimator {

    public static long estimateLRUCacheBytes(int entries, int avgKeyBytes, int avgValueBytes) {
        // HashMap.Node per entry: 32 bytes (header + hash + key + value + next)
        long hashMapNodes = (long) entries * 32;

        // HashMap.Node[] table at 0.75 load factor
        int tableSize = Integer.highestOneBit((int)(entries / 0.75f)) << 1;
        long hashMapTable = 16L + 4 * tableSize; // array header + references

        // DoublyLinkedList Node per entry: 32 bytes (header + key + value + prev + next)
        long listNodes = (long) entries * 32;

        // Key objects (assume String): 40 bytes header + char array
        long keyObjects = (long) entries * (40 + avgKeyBytes);

        // Value objects
        long valueObjects = (long) entries * (16 + avgValueBytes); // minimal header + data

        // HashMap object: 48 bytes
        // LRUCache object: ~40 bytes (header + fields)
        // Sentinels: 2 * 32 = 64 bytes
        long fixed = 48 + 40 + 64;

        return fixed + hashMapNodes + hashMapTable + listNodes + keyObjects + valueObjects;
    }

    /**
     * Example: 100,000 entries, 20-byte keys, 100-byte values
     * Estimate: 48 + 40 + 64 + 3.2M + 0.5M + 3.2M + 6M + 11.6M ≈ 24.5 MB
     * 
     * This matches JOL measurements within ~10%.
     * Always validate with JOL in production: GraphLayout.parseInstance(cache).totalSize()
     */
}
```

**P11.43** [M] — Priority-Based Cache Eviction
Implement a cache that evicts based on a priority score (cost × freshness).

```java
/**
 * Priority cache: evicts the entry with the lowest priority score.
 * Score = accessCount * (1 / age) — balances frequency and recency.
 * 
 * Uses TreeMap ordered by score for O(log n) eviction.
 */
public class PriorityCache<K, V> {
    private record Entry<K, V>(K key, V value, double score) implements Comparable<Entry<K, V>> {
        @Override
        public int compareTo(Entry<K, V> o) {
            int cmp = Double.compare(this.score, o.score);
            return cmp != 0 ? cmp : System.identityHashCode(this) - System.identityHashCode(o);
        }
    }

    private final int capacity;
    private final Map<K, Entry<K, V>> map = new HashMap<>();
    private final TreeSet<Entry<K, V>> sorted = new TreeSet<>();

    public PriorityCache(int capacity) { this.capacity = capacity; }

    public V get(K key) {
        Entry<K, V> e = map.get(key);
        if (e == null) return null;
        // Boost priority on access
        sorted.remove(e);
        Entry<K, V> updated = new Entry<>(key, e.value, e.score * 1.5);
        map.put(key, updated);
        sorted.add(updated);
        return e.value;
    }

    public void put(K key, V value, double initialPriority) {
        if (map.containsKey(key)) {
            Entry<K, V> old = map.remove(key);
            sorted.remove(old);
        }
        if (map.size() >= capacity) {
            Entry<K, V> lowest = sorted.first();
            sorted.remove(lowest);
            map.remove(lowest.key);
        }
        Entry<K, V> e = new Entry<>(key, value, initialPriority);
        map.put(key, e);
        sorted.add(e);
    }
    // O(log n) for all operations.
}
```

**P11.44** [M] — Circuit Breaker with Ring Buffer State
Implement a circuit breaker that tracks recent failures using a ring buffer.

```java
/**
 * Circuit breaker: prevents cascading failures by short-circuiting
 * requests to a failing service.
 * 
 * States: CLOSED (normal) → OPEN (failing) → HALF_OPEN (testing recovery)
 * 
 * DS: Ring buffer of recent results for failure rate calculation.
 * Resilience4j uses exactly this design.
 */
public class CircuitBreaker {
    enum State { CLOSED, OPEN, HALF_OPEN }

    private final boolean[] resultBuffer; // true = success, false = failure
    private int bufferHead;
    private int failures;
    private int bufferFilled;
    private volatile State state = State.CLOSED;
    private long openedAt;
    private final double failureThreshold; // e.g., 0.5 = 50% failure rate
    private final long cooldownMillis;

    public CircuitBreaker(int windowSize, double failureThreshold, long cooldownMillis) {
        this.resultBuffer = new boolean[windowSize];
        this.failureThreshold = failureThreshold;
        this.cooldownMillis = cooldownMillis;
    }

    public synchronized boolean allowRequest() {
        switch (state) {
            case CLOSED: return true;
            case OPEN:
                if (System.currentTimeMillis() - openedAt > cooldownMillis) {
                    state = State.HALF_OPEN;
                    return true; // allow one test request
                }
                return false;
            case HALF_OPEN: return false; // only one test request at a time
            default: return true;
        }
    }

    public synchronized void recordResult(boolean success) {
        if (state == State.HALF_OPEN) {
            state = success ? State.CLOSED : State.OPEN;
            if (!success) openedAt = System.currentTimeMillis();
            return;
        }

        // Update ring buffer
        if (bufferFilled == resultBuffer.length && !resultBuffer[bufferHead]) {
            failures--; // removing an old failure
        }
        resultBuffer[bufferHead] = success;
        if (!success) failures++;
        bufferHead = (bufferHead + 1) % resultBuffer.length;
        if (bufferFilled < resultBuffer.length) bufferFilled++;

        // Check threshold
        if (bufferFilled == resultBuffer.length) {
            double failureRate = (double) failures / bufferFilled;
            if (failureRate >= failureThreshold) {
                state = State.OPEN;
                openedAt = System.currentTimeMillis();
            }
        }
    }
    // O(1) for allowRequest and recordResult. Memory: windowSize bytes + fixed overhead.
}
```

**P11.45** [M] — Hierarchical Rate Limiter
Implement a rate limiter with global and per-user limits (global: 1000 req/s, per-user: 100 req/s).

```java
/**
 * Hierarchical rate limiter: requests must pass BOTH global AND per-user limits.
 * 
 * Architecture: global TokenBucket + per-user HashMap<userId, TokenBucket>
 */
public class HierarchicalRateLimiter {
    private final SimpleTokenBucket globalLimiter;
    private final ConcurrentHashMap<String, SimpleTokenBucket> userLimiters;
    private final int perUserMaxTokens;
    private final int perUserRefillRate;

    public HierarchicalRateLimiter(int globalMax, int globalRate,
                                     int perUserMax, int perUserRate) {
        this.globalLimiter = new SimpleTokenBucket(globalMax, globalRate);
        this.userLimiters = new ConcurrentHashMap<>();
        this.perUserMaxTokens = perUserMax;
        this.perUserRefillRate = perUserRate;
    }

    public boolean allow(String userId) {
        // Check global limit first (cheaper, fails fast)
        if (!globalLimiter.tryAcquire()) return false;

        // Check per-user limit
        SimpleTokenBucket userBucket = userLimiters.computeIfAbsent(
            userId, k -> new SimpleTokenBucket(perUserMaxTokens, perUserRefillRate));
        return userBucket.tryAcquire();
    }
    // O(1) per request. Memory: O(unique users) for per-user buckets.
    // Periodically evict inactive user buckets to prevent memory leak.
}
```

---

### Hard Problems

**P11.46** [H] — ARC Cache Implementation
Implement the full Adaptive Replacement Cache with T1, T2, B1, B2 lists and self-tuning parameter p.

```java
/**
 * Full ARC implementation — see Section 11.1.3.
 * 
 * The key insight of ARC: the ghost lists (B1, B2) act as a learning mechanism.
 * A hit in B1 means "we should have kept more recently-seen items" → increase p.
 * A hit in B2 means "we should have kept more frequently-seen items" → decrease p.
 * 
 * This makes ARC self-tuning: it adapts to workload changes without manual configuration.
 * LRU requires choosing the right cache size; ARC requires nothing — it tunes itself.
 * 
 * Complexity: O(1) for all operations.
 * Memory: up to 2c entries (c in cache + c in ghost lists), but ghost entries
 *         only store keys (null values), reducing actual memory to ~1.5c entries.
 * 
 * Real-world: ZFS ARC, PostgreSQL buffer manager, IBM DS8000.
 * The patent expired in 2023, making it freely available.
 */
// See full implementation in Section 11.1.3.
```

**P11.47** [H] — Clock Page Replacement
Implement the Clock (Second-Chance) algorithm with a circular buffer and used bits.

```java
/**
 * Full Clock implementation — see Section 11.1.4.
 * 
 * Advanced variant: CLOCK-Pro (used in Linux kernel since 2.6.x).
 * CLOCK-Pro extends Clock with:
 *   - Hot and cold pages (like ARC's T1/T2)
 *   - Test pages (like ARC's ghost lists)
 *   - Three hands instead of one (hot hand, cold hand, test hand)
 * 
 * CLOCK-Pro approximates ARC's behavior with lower per-access overhead
 * because it only modifies a boolean bit on access (vs moving nodes in
 * a doubly linked list for true LRU).
 * 
 * JVM parallel: Java's SoftReference behaves like a clock-managed cache entry.
 * The GC clears SoftReferences under memory pressure, keeping recently-accessed
 * ones longer (LRU-like behavior controlled by -XX:SoftRefLRUPolicyMSPerMB).
 */
// See full implementation in Section 11.1.4.
```

**P11.48** [H] — Thread-Safe Object Pool (HikariCP-Style)
Implement a high-performance object pool using ThreadLocal + CAS, inspired by HikariCP's ConcurrentBag.

```java
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.*;
import java.util.*;

/**
 * High-performance object pool inspired by HikariCP's ConcurrentBag.
 * 
 * Three-tier borrow strategy:
 *   1. ThreadLocal: check if this thread has a recently-returned object (no contention)
 *   2. Shared list: CAS-scan for any available object
 *   3. Handoff queue: block and wait for a return
 */
public class HighPerfPool<T> {
    private static final int STATE_FREE = 0;
    private static final int STATE_USED = 1;
    private static final int STATE_REMOVED = -1;

    private static class PoolEntry<T> {
        final T object;
        final AtomicInteger state = new AtomicInteger(STATE_FREE);

        PoolEntry(T object) { this.object = object; }

        boolean casFromFreeTo(int newState) {
            return state.compareAndSet(STATE_FREE, newState);
        }
    }

    private final CopyOnWriteArrayList<PoolEntry<T>> entries = new CopyOnWriteArrayList<>();
    private final ThreadLocal<List<PoolEntry<T>>> threadLocalEntries =
        ThreadLocal.withInitial(ArrayList::new);
    private final SynchronousQueue<PoolEntry<T>> handoff = new SynchronousQueue<>(true);
    private final int maxSize;

    public HighPerfPool(int maxSize, Supplier<T> factory) {
        this.maxSize = maxSize;
        for (int i = 0; i < maxSize; i++) {
            entries.add(new PoolEntry<>(factory.get()));
        }
    }

    public T borrow(long timeoutMs) throws InterruptedException, TimeoutException {
        // 1. Try ThreadLocal first (no contention)
        List<PoolEntry<T>> local = threadLocalEntries.get();
        for (int i = local.size() - 1; i >= 0; i--) {
            PoolEntry<T> entry = local.get(i);
            if (entry.casFromFreeTo(STATE_USED)) {
                return entry.object; // ~5 ns, no lock
            }
        }

        // 2. Scan shared list with CAS
        for (PoolEntry<T> entry : entries) { // CopyOnWriteArrayList: lock-free iteration
            if (entry.casFromFreeTo(STATE_USED)) {
                threadLocalEntries.get().add(entry); // remember for next time
                return entry.object; // ~20-50 ns
            }
        }

        // 3. Block on handoff queue
        PoolEntry<T> handed = handoff.poll(timeoutMs, TimeUnit.MILLISECONDS);
        if (handed == null) throw new TimeoutException("Pool exhausted");
        handed.state.set(STATE_USED);
        threadLocalEntries.get().add(handed);
        return handed.object;
    }

    public void release(T object) {
        for (PoolEntry<T> entry : entries) {
            if (entry.object == object) { // identity comparison
                entry.state.set(STATE_FREE);
                // Try to hand off to a waiting borrower
                handoff.offer(entry);
                return;
            }
        }
    }
    /**
     * Performance characteristics:
     *   ThreadLocal hit: ~5 ns (no contention, no CAS, no lock)
     *   Shared scan hit: ~20-50 ns (CAS per attempted entry)
     *   Handoff: ~1-10 us (thread park/unpark via OS scheduler)
     * 
     * vs ArrayBlockingQueue pool: ~200-500 ns (ReentrantLock acquisition under contention)
     * 
     * HikariCP's ConcurrentBag achieves ~10M borrows/sec.
     * A lock-based pool tops out at ~1M borrows/sec.
     */
}
```

**P11.49** [H] — W-TinyLFU Cache (Production-Grade)
Implement a simplified but complete W-TinyLFU cache with Count-Min Sketch admission, window LRU, and segmented main cache.

```java
/**
 * See Section 11.1.6 for the architecture and Count-Min Sketch implementation.
 * 
 * Production considerations for a full W-TinyLFU:
 * 
 * 1. Ring buffers for access recording:
 *    Instead of locking on every get(), Caffeine records accesses in a
 *    lock-free MPSC (multiple-producer, single-consumer) ring buffer.
 *    The maintenance thread drains the buffer and updates the LRU lists.
 *    This decouples the hot path (get) from the maintenance path (reorder).
 * 
 * 2. Write buffer:
 *    Writes go through a similar ring buffer to avoid locking the hash map.
 * 
 * 3. Sketch aging:
 *    Every W*10 increments, all 4-bit counters are halved (right-shift by 1).
 *    This prevents historical frequencies from dominating current patterns.
 *    The halving is a single bitwise operation per long: table[i] = (table[i] >>> 1) & MASK.
 * 
 * 4. Segmented LRU (SLRU):
 *    The main cache is split into probation (20%) and protected (80%).
 *    New admissions enter probation. On re-access, they promote to protected.
 *    Eviction from protected → demoted to probation (not evicted entirely).
 *    This prevents a single re-access from permanently protecting an entry.
 * 
 * 5. GC-awareness:
 *    Caffeine optionally supports soft/weak references for entries.
 *    When the GC clears a reference, the maintenance thread removes the entry.
 *    This allows the cache to shrink under memory pressure without explicit eviction.
 * 
 * Caffeine's performance: 100M+ reads/sec on 8 cores, near-optimal hit rate.
 */
```

**P11.50** [H] — Distributed Consistent Hashing with Bounded Loads
Implement consistent hashing with bounded loads: no server receives more than (1 + epsilon) * average load.

```java
/**
 * Consistent Hashing with Bounded Loads (Mirrokni et al., Google, 2018).
 * 
 * Problem: standard consistent hashing can create hotspots. One server
 * might receive 2-3x average traffic due to hash distribution.
 * 
 * Solution: set a capacity ceiling per server = ceil((1 + epsilon) * avgLoad).
 * When routing, if the nearest clockwise server is at capacity, skip to the next.
 * 
 * Uses TreeMap for the ring + HashMap for load tracking.
 */
public class BoundedLoadHashRing {
    private final TreeMap<Long, String> ring = new TreeMap<>();
    private final Map<String, Integer> serverLoad = new HashMap<>();
    private final Map<String, Integer> serverCapacity = new HashMap<>();
    private final int vNodes;
    private int totalKeys;
    private final double epsilon;

    public BoundedLoadHashRing(int virtualNodes, double epsilon) {
        this.vNodes = virtualNodes;
        this.epsilon = epsilon;
    }

    public void addServer(String server) {
        for (int i = 0; i < vNodes; i++) {
            ring.put(fnv1a(server + "#" + i), server);
        }
        serverLoad.put(server, 0);
        recalcCapacities();
    }

    public String route(String key) {
        if (ring.isEmpty()) return null;
        long hash = fnv1a(key);
        Long pos = ring.ceilingKey(hash);
        if (pos == null) pos = ring.firstKey();

        // Walk clockwise until we find a server under capacity
        Long startPos = pos;
        do {
            String server = ring.get(pos);
            if (serverLoad.getOrDefault(server, 0) < serverCapacity.getOrDefault(server, 1)) {
                serverLoad.merge(server, 1, Integer::sum);
                totalKeys++;
                recalcCapacities();
                return server;
            }
            pos = ring.higherKey(pos);
            if (pos == null) pos = ring.firstKey();
        } while (!pos.equals(startPos));

        // All servers at capacity — should not happen with correct epsilon
        return ring.get(startPos);
    }

    private void recalcCapacities() {
        int numServers = serverLoad.size();
        if (numServers == 0) return;
        double avg = (double) totalKeys / numServers;
        int cap = (int) Math.ceil((1 + epsilon) * avg) + 1;
        for (String s : serverLoad.keySet()) {
            serverCapacity.put(s, cap);
        }
    }

    private long fnv1a(String s) {
        long h = 0xcbf29ce484222325L;
        for (char c : s.toCharArray()) { h ^= c; h *= 0x100000001b3L; }
        return h;
    }
    // Used by: Google's Maglev load balancer, Vimeo's consistent hashing.
    // Guarantees no server exceeds (1+epsilon)*average load at any time.
}
```

**P11.51** [H] — Lock-Free Rate Limiter (CAS-Only)
Implement a thread-safe token bucket rate limiter using only CAS operations, no locks.

```java
import java.util.concurrent.atomic.AtomicLong;

/**
 * Lock-free token bucket using CAS (compare-and-swap) only.
 * No ReentrantLock, no synchronized, no volatile (only atomics).
 * 
 * The challenge: we must atomically update both the token count
 * AND the last-refill timestamp. We pack both into a single AtomicLong.
 * 
 * Packing: upper 32 bits = tokens, lower 32 bits = timestamp (seconds since epoch)
 */
public class LockFreeTokenBucket {
    private final AtomicLong state; // packed: [tokens(32) | timestamp(32)]
    private final int maxTokens;
    private final int refillRate; // tokens per second

    public LockFreeTokenBucket(int maxTokens, int refillRate) {
        this.maxTokens = maxTokens;
        this.refillRate = refillRate;
        long now = System.currentTimeMillis() / 1000;
        this.state = new AtomicLong(pack(maxTokens, now));
    }

    public boolean tryAcquire() {
        while (true) { // CAS retry loop
            long current = state.get();
            int tokens = unpackTokens(current);
            long lastRefill = unpackTimestamp(current);
            long now = System.currentTimeMillis() / 1000;

            // Refill
            long elapsed = now - lastRefill;
            if (elapsed > 0) {
                tokens = (int) Math.min(maxTokens, tokens + elapsed * refillRate);
                lastRefill = now;
            }

            if (tokens <= 0) return false;

            long newState = pack(tokens - 1, lastRefill);
            if (state.compareAndSet(current, newState)) {
                return true;
            }
            // CAS failed — another thread modified state. Retry.
            // Under contention, this loop runs 1-3 iterations on average.
        }
    }

    private static long pack(int tokens, long timestamp) {
        return ((long) tokens << 32) | (timestamp & 0xFFFFFFFFL);
    }
    private static int unpackTokens(long packed) { return (int)(packed >>> 32); }
    private static long unpackTimestamp(long packed) { return packed & 0xFFFFFFFFL; }

    /**
     * JVM insight: AtomicLong.compareAndSet compiles to LOCK CMPXCHG8B on x86.
     * Uncontended CAS: ~5 ns. Under contention: CAS retry adds ~10-50 ns per retry.
     * Still 5-10x faster than ReentrantLock under contention (~200-500 ns).
     * 
     * This packing trick works because:
     *   - Token count fits in 32 bits (max 2B tokens — more than enough)
     *   - Timestamp in seconds since epoch fits in 32 bits until year 2106
     *   - A single CAS atomically updates both values
     */
}
```

**P11.52** [H] — Count-Min Sketch for Frequency Estimation
Implement a Count-Min Sketch and use it to estimate the frequency of items in a stream.

```java
/**
 * Count-Min Sketch: probabilistic frequency estimator.
 * 
 * Structure: 2D array of counters, depth × width.
 * Each row uses a different hash function.
 * Increment: hash key with each function, increment corresponding counter.
 * Query: take minimum across all rows (minimum is the tightest upper bound).
 * 
 * Guarantees: estimate >= true count (never underestimates).
 * Error bound: E[overcount] <= totalCount * (e / width) with probability >= 1 - (1/e)^depth
 *   where e ≈ 2.718 (Euler's number)
 * 
 * For width=2048, depth=4: overcount <= 0.13% of total with 98% probability.
 */
public class CountMinSketch {
    private final int[][] table;
    private final int width;
    private final int depth;
    private final long[] seeds;
    private int totalCount;

    public CountMinSketch(int width, int depth) {
        this.width = width;
        this.depth = depth;
        this.table = new int[depth][width];
        this.seeds = new long[depth];
        Random rng = new Random(42);
        for (int i = 0; i < depth; i++) seeds[i] = rng.nextLong();
    }

    public void increment(Object key) {
        int hash = key.hashCode();
        for (int i = 0; i < depth; i++) {
            int idx = Math.floorMod(hash * (int)(seeds[i] >>> 32) + (int) seeds[i], width);
            table[i][idx]++;
        }
        totalCount++;
    }

    public int estimate(Object key) {
        int hash = key.hashCode();
        int min = Integer.MAX_VALUE;
        for (int i = 0; i < depth; i++) {
            int idx = Math.floorMod(hash * (int)(seeds[i] >>> 32) + (int) seeds[i], width);
            min = Math.min(min, table[i][idx]);
        }
        return min;
    }

    /** Halve all counters — for aging (used in W-TinyLFU). */
    public void halve() {
        for (int i = 0; i < depth; i++) {
            for (int j = 0; j < width; j++) {
                table[i][j] /= 2;
            }
        }
        totalCount /= 2;
    }

    /**
     * Memory: depth * width * 4 bytes (int counters).
     * For depth=4, width=65536: 4 * 65536 * 4 = 1 MB.
     * 
     * Optimization: use 4-bit counters (nibbles) packed into longs.
     * 16 counters per long → 16x memory reduction.
     * Caffeine does this: 4 * 65536 * 0.25 bytes = 64 KB for 65K-entry cache.
     * 
     * vs HashMap<Object, Integer>: 
     *   For 65K keys: 65K * ~64 bytes ≈ 4 MB. CMS uses 64 KB. 62x less.
     */
}
```

**P11.53** [H] — Cuckoo Hash for High-Occupancy Cache
Implement a cuckoo hash table that supports 95%+ load factor for memory-efficient caching.

```java
/**
 * Cuckoo Hashing: two hash functions, two tables.
 * Insert: try table1[h1(key)]. If occupied, evict the occupant to table2[h2(key)].
 * The evicted key may itself evict another key, creating a chain.
 * If the chain exceeds a threshold (O(log n)), resize.
 * 
 * Advantage: O(1) worst-case lookup (check exactly 2 positions).
 * Load factor: up to ~50% with 2 tables, ~90%+ with 2 hash functions + 4-way buckets.
 * 
 * Used in: Intel DPDK (network packet processing), MemC3, Cuckoo Filter.
 */
public class CuckooHashMap<K, V> {
    private static final int MAX_KICKS = 500;

    @SuppressWarnings("unchecked")
    private Object[][] keys;
    @SuppressWarnings("unchecked")
    private Object[][] values;
    private int capacity;
    private int size;

    public CuckooHashMap(int capacity) {
        this.capacity = capacity;
        this.keys = new Object[2][capacity];
        this.values = new Object[2][capacity];
    }

    @SuppressWarnings("unchecked")
    public V get(K key) {
        int h1 = hash1(key);
        if (key.equals(keys[0][h1])) return (V) values[0][h1];
        int h2 = hash2(key);
        if (key.equals(keys[1][h2])) return (V) values[1][h2];
        return null; // guaranteed O(1): check exactly 2 positions
    }

    public void put(K key, V value) {
        // Check if key already exists
        int h1 = hash1(key);
        if (key.equals(keys[0][h1])) { values[0][h1] = value; return; }
        int h2 = hash2(key);
        if (key.equals(keys[1][h2])) { values[1][h2] = value; return; }

        // Try to insert with cuckoo displacement chain
        K curKey = key;
        V curVal = value;
        int table = 0;

        for (int i = 0; i < MAX_KICKS; i++) {
            int pos = (table == 0) ? hash1(curKey) : hash2(curKey);

            // If slot is empty, insert and done
            if (keys[table][pos] == null) {
                keys[table][pos] = curKey;
                values[table][pos] = curVal;
                size++;
                return;
            }

            // Evict current occupant
            @SuppressWarnings("unchecked")
            K evictedKey = (K) keys[table][pos];
            @SuppressWarnings("unchecked")
            V evictedVal = (V) values[table][pos];
            keys[table][pos] = curKey;
            values[table][pos] = curVal;

            curKey = evictedKey;
            curVal = evictedVal;
            table = 1 - table; // alternate between table 0 and 1
        }

        // Max kicks exceeded — resize and rehash
        resize();
        put(curKey, curVal);
    }

    private void resize() {
        Object[][] oldKeys = keys;
        Object[][] oldValues = values;
        int oldCapacity = capacity;
        capacity *= 2;
        keys = new Object[2][capacity];
        values = new Object[2][capacity];
        size = 0;
        for (int t = 0; t < 2; t++) {
            for (int i = 0; i < oldCapacity; i++) {
                if (oldKeys[t][i] != null) {
                    @SuppressWarnings("unchecked")
                    K k = (K) oldKeys[t][i];
                    @SuppressWarnings("unchecked")
                    V v = (V) oldValues[t][i];
                    put(k, v);
                }
            }
        }
    }

    private int hash1(K key) { return Math.floorMod(key.hashCode(), capacity); }
    private int hash2(K key) { return Math.floorMod(key.hashCode() * 0x9e3779b9, capacity); }

    /**
     * Lookup: O(1) worst case (exactly 2 array accesses — perfect for CPU cache).
     * Insert: O(1) amortized (cuckoo chain is O(log n) expected, resize is rare).
     * Space: 2 arrays × capacity. Load factor ~50% with 2 tables.
     * 
     * With 4-way buckets (each slot holds 4 entries), load factor reaches 95%.
     * This is how Intel DPDK's hash table achieves both high occupancy and O(1) lookup.
     */
}
```

**P11.54** [H] — Multi-Level Consistent Hashing (CDN Edge + Origin)
Implement a two-tier routing system where requests first go to the nearest edge (geo hashing), then within the edge, to a specific cache server (consistent hashing).

```java
/**
 * Two-tier CDN routing:
 *   Tier 1: Route to nearest edge POP based on client geography
 *   Tier 2: Within the POP, route to specific cache server via consistent hashing
 * 
 * This avoids caching the same content on all servers within a POP.
 */
public class TwoTierCDNRouter {
    // Tier 1: Geo-based routing (simplified as region → POP mapping)
    private final Map<String, String> regionToPOP; // "us-east" → "nyc-pop"

    // Tier 2: Per-POP consistent hashing
    private final Map<String, ConsistentHashRing<String>> popToRing;

    public TwoTierCDNRouter() {
        regionToPOP = new HashMap<>();
        popToRing = new HashMap<>();
    }

    public void addPOP(String region, String pop, List<String> servers) {
        regionToPOP.put(region, pop);
        ConsistentHashRing<String> ring = new ConsistentHashRing<>(150);
        for (String server : servers) ring.addServer(server);
        popToRing.put(pop, ring);
    }

    public String route(String clientRegion, String url) {
        // Tier 1: find nearest POP
        String pop = regionToPOP.get(clientRegion);
        if (pop == null) pop = regionToPOP.values().iterator().next(); // fallback

        // Tier 2: consistent hash within POP
        ConsistentHashRing<String> ring = popToRing.get(pop);
        return ring.getServer(url);
    }

    /**
     * Benefits:
     *   - Each URL maps to exactly one server per POP → no duplication
     *   - If a server in the POP goes down, only 1/N URLs remap
     *   - Cross-POP, the same URL may be cached on different servers
     *     (each POP serves its local users independently)
     * 
     * Real-world: Cloudflare, Akamai, and Fastly all use hierarchical
     * consistent hashing for CDN cache distribution.
     */
}
```

**P11.55** [H] — Self-Resizing Cache Based on Memory Pressure
Implement a cache that monitors JVM heap usage and evicts entries when memory is low.

```java
/**
 * Memory-aware cache that shrinks under GC pressure.
 * 
 * Monitors Runtime.freeMemory() and aggressively evicts when
 * heap usage exceeds a threshold.
 * 
 * Alternative: use SoftReference values — the GC clears them automatically.
 * But SoftReferences have unpredictable clearing behavior and can cause
 * GC thrashing. Explicit memory monitoring is more predictable.
 */
public class MemoryAwareCache<K, V> {
    private final LRUCache<K, V> cache;
    private final double maxHeapUsageRatio; // e.g., 0.8 = 80%

    public MemoryAwareCache(int maxCapacity, double maxHeapUsageRatio) {
        this.cache = new LRUCache<>(maxCapacity);
        this.maxHeapUsageRatio = maxHeapUsageRatio;
    }

    public V get(K key) {
        return cache.get(key);
    }

    public void put(K key, V value) {
        evictIfMemoryPressure();
        cache.put(key, value);
    }

    private void evictIfMemoryPressure() {
        Runtime rt = Runtime.getRuntime();
        long maxMem = rt.maxMemory();
        long usedMem = rt.totalMemory() - rt.freeMemory();
        double usage = (double) usedMem / maxMem;

        if (usage > maxHeapUsageRatio) {
            // Evict 10% of cache to relieve pressure
            int toEvict = Math.max(1, cache.size() / 10);
            for (int i = 0; i < toEvict && cache.size() > 0; i++) {
                // Remove LRU entries (implementation would expose removeLRU())
            }
        }
    }

    /**
     * JVM insight:
     *   Runtime.freeMemory() is cheap (~10 ns) — reads a field, no syscall.
     *   BUT: it only reflects the current heap state. After a GC, freeMemory jumps.
     *   
     *   Better approach: register a GC notification listener:
     *     ManagementFactory.getGarbageCollectorMXBeans().forEach(gc ->
     *       ((NotificationEmitter) gc).addNotificationListener(listener, null, null));
     *   
     *   This fires AFTER each GC with details about freed memory, GC duration,
     *   and cause. React to GC pressure by evicting when GC frequency or
     *   pause duration exceeds thresholds.
     * 
     * Caffeine supports -XX:SoftRefLRUPolicyMSPerMB-based sizing via SoftReference values.
     * EhCache monitors heap via JMX and evicts to disk when memory is constrained.
     */
}
```

**P11.56** [H] — Write-Ahead Log for Cache Persistence
Implement a write-ahead log (WAL) that allows a cache to recover its state after a restart.

```java
import java.io.*;
import java.nio.file.*;

/**
 * Write-Ahead Log for cache durability.
 * 
 * Every put() is first appended to a log file, then applied to the in-memory cache.
 * On crash recovery, replay the log to reconstruct the cache.
 * 
 * Used by: Redis AOF, Apache Kafka, PostgreSQL WAL, LevelDB/RocksDB.
 */
public class WALCache<K extends Serializable, V extends Serializable> {
    private final LRUCache<K, V> cache;
    private final Path walPath;
    private ObjectOutputStream walWriter;

    private enum OpType { PUT, DELETE }

    private record WALEntry<K, V>(OpType op, K key, V value) implements Serializable {}

    public WALCache(int capacity, String walFilePath) throws IOException {
        this.cache = new LRUCache<>(capacity);
        this.walPath = Paths.get(walFilePath);
        this.walWriter = new ObjectOutputStream(
            new BufferedOutputStream(Files.newOutputStream(walPath, StandardOpenOption.CREATE,
                StandardOpenOption.APPEND)));
    }

    public V get(K key) {
        return cache.get(key);
    }

    public void put(K key, V value) throws IOException {
        // Write to log FIRST (write-ahead)
        WALEntry<K, V> entry = new WALEntry<>(OpType.PUT, key, value);
        walWriter.writeObject(entry);
        walWriter.flush(); // fsync for durability
        // Then apply to cache
        cache.put(key, value);
    }

    @SuppressWarnings("unchecked")
    public void recover() throws IOException, ClassNotFoundException {
        if (!Files.exists(walPath)) return;
        try (ObjectInputStream ois = new ObjectInputStream(
                new BufferedInputStream(Files.newInputStream(walPath)))) {
            while (true) {
                try {
                    WALEntry<K, V> entry = (WALEntry<K, V>) ois.readObject();
                    if (entry.op == OpType.PUT) {
                        cache.put(entry.key, entry.value);
                    }
                } catch (EOFException e) {
                    break; // end of log
                }
            }
        }
    }

    /**
     * Compaction: periodically, snapshot the current cache state and truncate the WAL.
     * Without compaction, the WAL grows unboundedly.
     * Redis does this with BGSAVE (snapshot) + AOF rewrite (compacted log).
     * 
     * Performance trade-off:
     *   - fsync on every write: durable but slow (~1ms for disk fsync)
     *   - fsync periodically (every 1s): fast but may lose last second of writes
     *   - No fsync (OS buffering): fastest but may lose data on power failure
     */
}
```

**P11.57** [H] — Concurrent LRU with Striped Locking
Implement a concurrent LRU cache that uses striped locking to reduce contention.

```java
import java.util.concurrent.locks.ReentrantLock;

/**
 * Striped-lock LRU: partitions the key space into N segments,
 * each with its own lock and LRU list.
 * 
 * Under N concurrent threads, contention is reduced by ~N.
 * This is the approach ConcurrentHashMap used in JDK 7.
 */
public class StripedLRUCache<K, V> {
    private final int stripeCount;
    private final LRUCache<K, V>[] stripes;
    private final ReentrantLock[] locks;

    @SuppressWarnings("unchecked")
    public StripedLRUCache(int totalCapacity, int stripeCount) {
        this.stripeCount = stripeCount;
        this.stripes = new LRUCache[stripeCount];
        this.locks = new ReentrantLock[stripeCount];
        int perStripe = Math.max(1, totalCapacity / stripeCount);
        for (int i = 0; i < stripeCount; i++) {
            stripes[i] = new LRUCache<>(perStripe);
            locks[i] = new ReentrantLock();
        }
    }

    private int stripeIndex(K key) {
        // Spread the hash to reduce clustering
        int h = key.hashCode();
        h ^= (h >>> 16);
        return Math.floorMod(h, stripeCount);
    }

    public V get(K key) {
        int idx = stripeIndex(key);
        locks[idx].lock();
        try {
            return stripes[idx].get(key);
        } finally {
            locks[idx].unlock();
        }
    }

    public void put(K key, V value) {
        int idx = stripeIndex(key);
        locks[idx].lock();
        try {
            stripes[idx].put(key, value);
        } finally {
            locks[idx].unlock();
        }
    }

    /**
     * With 16 stripes and 16 threads: each lock has ~1 thread contending on average.
     * Throughput: ~16x a single-lock LRU.
     * 
     * Downside: LRU ordering is per-stripe, not global. The "least recently used"
     * entry globally might not be evicted first — only the LRU within its stripe.
     * For most use cases, this approximation is acceptable.
     * 
     * Caffeine avoids this trade-off by using a global ConcurrentHashMap +
     * lock-free ring buffers + single maintenance thread. This gives global LRU
     * ordering without per-key locking.
     */
}
```

**P11.58** [H] — Implement ConcurrentBag (HikariCP Pattern)
Full ConcurrentBag implementation with ThreadLocal, CAS, and handoff — as described in Section 11.3.2.

```java
/**
 * See P11.48 for the full implementation.
 * 
 * Additional production features HikariCP implements:
 * 
 * 1. Leak detection: if a connection is borrowed but not returned within
 *    leakDetectionThreshold (default 0 = disabled), log a stack trace.
 *    Implementation: ScheduledExecutorService checks borrowed entries.
 * 
 * 2. Connection test: HikariCP uses Connection.isValid(timeout) — a JDBC 4.0 method
 *    that sends a lightweight ping to the database. It does NOT use "SELECT 1"
 *    (which creates a server-side query plan). isValid() compiles to a TCP ping.
 * 
 * 3. Max lifetime: connections are retired after maxLifetime (default 30 min)
 *    to prevent issues with database-side connection limits and memory leaks.
 *    Each connection schedules its own retirement task via ScheduledExecutorService.
 * 
 * 4. Metrics: HikariCP exposes pool metrics via Micrometer:
 *    - hikaricp.connections.active (gauge)
 *    - hikaricp.connections.idle (gauge)
 *    - hikaricp.connections.pending (gauge)
 *    - hikaricp.connections.acquire (timer)
 *    
 *    DS behind metrics: LongAdder for counters (lock-free), AtomicLong for gauges.
 */
```

**P11.59** [H] — API Gateway with Rate Limiting, Caching, and Load Balancing
Design an API gateway that combines rate limiting, response caching, and load balancing.

```java
/**
 * Composite API Gateway combining three subsystems:
 *   1. Rate limiter (token bucket per client)
 *   2. Response cache (LRU with TTL)
 *   3. Load balancer (power-of-two-choices)
 * 
 * Request flow:
 *   Client → Rate Limiter → Cache Check → Load Balancer → Backend
 *                ↓ reject      ↓ hit          ↓ route
 *            HTTP 429       return cached    forward request
 */
public class APIGateway {
    private final HierarchicalRateLimiter rateLimiter;
    private final HybridTTLCache<String, String> responseCache;
    private final P2CWithEWMA loadBalancer;

    public APIGateway(List<String> backends) {
        this.rateLimiter = new HierarchicalRateLimiter(10000, 10000, 100, 100);
        this.responseCache = new HybridTTLCache<>(60); // 60 second TTL
        this.loadBalancer = new P2CWithEWMA(backends);
    }

    public GatewayResponse handle(String clientId, String requestPath) {
        // 1. Rate limiting
        if (!rateLimiter.allow(clientId)) {
            return new GatewayResponse(429, "Rate limit exceeded", null);
        }

        // 2. Cache check (for GET requests)
        String cacheKey = requestPath; // simplified
        String cached = responseCache.get(cacheKey);
        if (cached != null) {
            return new GatewayResponse(200, cached, "cache-hit");
        }

        // 3. Load balance and forward
        String backend = loadBalancer.acquire();
        long start = System.nanoTime();
        try {
            String response = forwardToBackend(backend, requestPath);
            long latency = (System.nanoTime() - start) / 1_000_000;
            loadBalancer.release(backend, latency);

            // Cache the response
            responseCache.put(cacheKey, response);
            return new GatewayResponse(200, response, backend);
        } catch (Exception e) {
            long latency = (System.nanoTime() - start) / 1_000_000;
            loadBalancer.release(backend, latency);
            return new GatewayResponse(502, "Backend error", backend);
        }
    }

    private String forwardToBackend(String backend, String path) {
        return "response from " + backend; // placeholder
    }

    public record GatewayResponse(int statusCode, String body, String servedBy) {}

    /**
     * Production API gateways (Kong, Envoy, Nginx):
     * - Use shared memory (mmap) for rate limit counters across worker processes
     * - Use consistent hashing for cache distribution across gateway instances
     * - Use circuit breakers per backend to prevent cascading failures
     * - Use Bloom filters to avoid caching uncacheable responses
     * 
     * Total DS used: TokenBucket, HashMap, PriorityQueue (TTL), TreeMap (consistent hash),
     * AtomicLong (CAS), ConcurrentHashMap (thread-safe cache), ArrayDeque (request queue).
     */
}
```

**P11.60** [H] — Cache Coherence Protocol (Simulated MESI)
Simulate the MESI cache coherence protocol using data structures to model L1 caches across multiple cores.

```java
/**
 * MESI Protocol Simulation.
 * 
 * MESI states for each cache line:
 *   M (Modified): only copy, dirty (written but not flushed to memory)
 *   E (Exclusive): only copy, clean (matches memory)
 *   S (Shared): multiple copies exist across caches, all clean
 *   I (Invalid): not in this cache (or invalidated by another cache)
 * 
 * State transitions triggered by read/write from local core or snoop from bus.
 * This models what happens when two threads access the same HashMap bucket
 * on different cores — the cache lines bounce between M and I states.
 */
public class MESISimulator {
    enum State { MODIFIED, EXCLUSIVE, SHARED, INVALID }

    private static class CacheLine {
        long address;
        State state;
        long data;

        CacheLine(long address) {
            this.address = address;
            this.state = State.INVALID;
        }
    }

    private static class L1Cache {
        final String coreName;
        final Map<Long, CacheLine> lines = new HashMap<>();

        L1Cache(String name) { this.coreName = name; }

        CacheLine getLine(long address) {
            return lines.computeIfAbsent(address, CacheLine::new);
        }
    }

    private final L1Cache[] caches;
    private final Map<Long, Long> mainMemory = new HashMap<>();
    private final List<String> busLog = new ArrayList<>();

    public MESISimulator(int numCores) {
        caches = new L1Cache[numCores];
        for (int i = 0; i < numCores; i++) {
            caches[i] = new L1Cache("Core" + i);
        }
    }

    public long read(int coreId, long address) {
        CacheLine line = caches[coreId].getLine(address);
        switch (line.state) {
            case MODIFIED:
            case EXCLUSIVE:
            case SHARED:
                busLog.add(caches[coreId].coreName + " READ " + address + " → HIT (" + line.state + ")");
                return line.data;
            case INVALID:
                // Bus read: check other caches
                for (int i = 0; i < caches.length; i++) {
                    if (i == coreId) continue;
                    CacheLine other = caches[i].lines.get(address);
                    if (other != null && other.state != State.INVALID) {
                        if (other.state == State.MODIFIED) {
                            // Flush to memory first
                            mainMemory.put(address, other.data);
                            busLog.add(caches[i].coreName + " FLUSH " + address);
                        }
                        other.state = State.SHARED;
                        line.data = other.data;
                        line.state = State.SHARED;
                        busLog.add(caches[coreId].coreName + " READ " + address +
                                   " → SHARED (from " + caches[i].coreName + ")");
                        return line.data;
                    }
                }
                // Not in any cache — read from main memory
                line.data = mainMemory.getOrDefault(address, 0L);
                line.state = State.EXCLUSIVE; // only copy
                busLog.add(caches[coreId].coreName + " READ " + address + " → EXCLUSIVE (from memory)");
                return line.data;
        }
        return 0;
    }

    public void write(int coreId, long address, long value) {
        CacheLine line = caches[coreId].getLine(address);
        // Invalidate all other caches (bus invalidation)
        for (int i = 0; i < caches.length; i++) {
            if (i == coreId) continue;
            CacheLine other = caches[i].lines.get(address);
            if (other != null && other.state != State.INVALID) {
                busLog.add(caches[i].coreName + " INVALIDATE " + address);
                other.state = State.INVALID;
            }
        }
        line.data = value;
        line.state = State.MODIFIED;
        busLog.add(caches[coreId].coreName + " WRITE " + address + " → MODIFIED");
    }

    public List<String> getBusLog() { return Collections.unmodifiableList(busLog); }

    /**
     * This simulation shows why false sharing is so expensive:
     * 
     * Two threads writing to adjacent fields (same cache line) cause:
     *   Core0: WRITE addr → MODIFIED
     *   Core1: WRITE addr → INVALIDATE on Core0 → Core0 reloads → MODIFIED on Core1
     *   Core0: WRITE addr → INVALIDATE on Core1 → Core1 reloads → MODIFIED on Core0
     *   ... cache line bounces between cores every write: "ping-pong"
     * 
     * Each invalidation costs ~40-100 cycles (L3 roundtrip).
     * At 3 GHz: ~13-33 ns per write instead of ~1 ns (L1 hit).
     * This is the hardware reality behind Java's false sharing problem.
     * 
     * @Contended annotation pads fields to separate cache lines,
     * preventing this ping-pong entirely.
     */
}
```

---

## Key Takeaways

1. **LRU = HashMap + DoublyLinkedList, always.** `LinkedHashMap(accessOrder=true)` gives you this in three lines. For custom behavior, build it from scratch with sentinel nodes. Every O(1) LRU cache in production (Caffeine, Guava, Android LruCache) uses this exact pairing.

2. **LFU adds a frequency dimension but risks cache pollution.** The O(1) LFU design uses frequency buckets (doubly linked list of doubly linked lists) plus a `minFreq` integer. In practice, W-TinyLFU (Caffeine) with a Count-Min Sketch admission filter gives better hit rates than pure LFU.

3. **ARC self-tunes between recency and frequency.** Its four lists (T1, T2, B1, B2) and adaptive parameter `p` eliminate the need to manually choose between LRU and LFU. Ghost list hits act as feedback signals — a data structure that learns from its own evictions.

4. **Token bucket is the optimal rate limiter for most scenarios.** Two numbers (token count + last refill timestamp), O(1) per request, lock-free with CAS. Allows controlled bursts. For strict smoothing, use leaky bucket. For precision, use sliding window log. For memory efficiency, use fixed-window counters.

5. **Consistent hashing (TreeMap + virtual nodes) is the foundation of distributed systems.** `TreeMap.ceilingEntry()` gives O(log n) routing. Virtual nodes (100-200 per server) ensure even distribution. When a server fails, only 1/N of keys remap. DynamoDB, Cassandra, and every CDN use this.

6. **Connection pooling performance is dominated by the borrow strategy.** `ArrayBlockingQueue` uses a single lock — contention bottleneck. HikariCP's `ConcurrentBag` uses ThreadLocal + CAS + SynchronousQueue handoff — 10-20x faster because the fast path (ThreadLocal hit) is lock-free.

7. **The Clock algorithm approximates LRU with less overhead.** A boolean `used` bit per entry (1 write on access) vs doubly linked list reordering (6 pointer writes on access). The Linux kernel, PostgreSQL, and most OS page caches use Clock or its variants (CLOCK-Pro) because the per-access cost is lower.

8. **Cache coherence is the hardware root of all concurrency costs.** MESI protocol invalidations (cache line ping-pong) are why false sharing, lock contention, and CAS retries are expensive. Every `synchronized`, `volatile`, and `CAS` operation ultimately triggers MESI state transitions on the bus.

9. **Request coalescing prevents thundering herds.** `ConcurrentHashMap<K, CompletableFuture<V>>` ensures only one fetch per cache miss, even under 1000 concurrent requests for the same key. CDNs (Cloudflare, Nginx), caching libraries (Caffeine), and service meshes (Envoy) all implement this.

10. **Measure cache memory with JOL, not intuition.** An LRU cache with 1 million entries consumes ~64 MB of structural overhead (HashMap.Node + DList.Node) before counting keys and values. `GraphLayout.parseInstance(cache).totalSize()` gives the true number. Cache sizing without measurement is guesswork.

---

[Previous: Chapter 10 — Graph Representations & Algorithms](10-graph-representations-and-algorithms.md) | [Next: Chapter 12 — Use Cases — Concurrency & Scheduling](12-use-cases-concurrency-scheduling.md)
