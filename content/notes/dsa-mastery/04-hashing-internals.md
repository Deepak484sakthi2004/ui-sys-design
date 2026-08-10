# Chapter 4: Hashing Internals

## The O(1) That Powers Everything

If you have built production systems for any length of time, you already rely on hashing thousands of times per second — every HTTP session lookup, every database connection pool fetch, every cache hit, every DNS resolution. You use `HashMap` like breathing. But do you know *why* `HashMap` XORs the top 16 bits of the hash code into the bottom 16? Do you know why the capacity is always a power of 2, and exactly how the resize operation avoids recomputing bucket indices? Do you know what happens inside the JVM when you call `hashCode()` on an object that has never had its hash code requested before?

This is the chapter where we crack open the hood on the single most important data structure in professional software engineering. We will walk through OpenJDK source line by line, understand the mathematical guarantees that make hashing work, and build the intuition that turns "I think it is O(1)" into "I know exactly why it is O(1), when it degrades, and how to prevent that degradation."

This chapter is the longest in the book for good reason. Hashing appears in more interview problems than any other concept, and understanding it at the JVM level gives you an unfair advantage.

---

## 4.1 Hash Function Theory

A hash function maps an input of arbitrary size to a fixed-size output. That sounds simple. The difficulty is doing it *well*.

### What Makes a Good Hash Function

A hash function `h: U → {0, 1, ..., m-1}` maps keys from a universe `U` into `m` buckets. Three properties determine quality:

**1. Uniformity (even distribution)**

For a random key `k`, the probability of landing in any bucket should be `1/m`. If some buckets are preferred over others, chains grow unevenly. One overloaded bucket degrades `get()` from O(1) to O(n).

```
Good hash (uniform):      |██|██|██|██|██|██|██|██|   (balanced)
Bad hash (clustered):     |████████|█|█||||||█|        (hot spots)
```

**2. Avalanche Effect**

Changing a single bit in the input should change approximately half the bits in the output. This ensures that similar keys do not cluster in adjacent buckets.

```
"cat" → 0x7A3F29B1
"bat" → 0xE10C7D44   (completely different, even though only 1 character changed)
```

The avalanche effect is why Java's hash perturbation function exists — `Object.hashCode()` implementations often have poor avalanche properties (e.g., sequential integers produce sequential hash codes), so `HashMap` applies additional mixing.

**3. Collision Resistance**

Two distinct keys should rarely map to the same bucket. There are two flavors:
- **Weak collision resistance**: Given a key `k1`, it is computationally hard to find `k2 != k1` such that `h(k1) == h(k2)`.
- **Strong collision resistance**: It is hard to find *any* pair `(k1, k2)` with `h(k1) == h(k2)`.

For hash tables, we do not need cryptographic collision resistance — we just need statistical uniformity. For security-sensitive uses (hash-based message authentication), we need much stronger guarantees.

### The Birthday Paradox: Why Collisions Are Inevitable

The birthday paradox is the most counterintuitive result in probability, and it governs everything about hash table design.

**The classic version**: In a room of 23 people, there is a >50% chance two share a birthday. With 365 possible birthdays, you might expect to need ~183 people. But you only need 23. Why?

The math: With `n` people and `m` possible birthdays, the probability that all birthdays are distinct is:

```
P(no collision) = (m/m) × ((m-1)/m) × ((m-2)/m) × ... × ((m-n+1)/m)
                = m! / (m^n × (m-n)!)

P(collision) = 1 - P(no collision)
```

For `m = 365`, this exceeds 0.5 at `n = 23`.

**The general rule**: In a hash space of size `m`, you expect the first collision after approximately `√(π × m / 2) ≈ 1.177 √m` insertions.

**What this means for hash tables**:
- A 32-bit hash space (4 billion values) expects its first collision after ~77,000 insertions.
- A 16-bit hash space expects its first collision after ~300 insertions.
- If your `HashMap` has 16 buckets (`m = 16`), you expect the first collision after ~5 insertions.

This is why hash tables *must* handle collisions. It is not an edge case — it is the normal case. And it is why `HashMap`'s default load factor of 0.75 (resize when 75% full) is a carefully chosen tradeoff between collision rate and memory usage.

### Universal Hashing

Universal hashing is a technique to defend against adversarial inputs. If an attacker knows your hash function, they can craft keys that all hash to the same bucket, degrading your O(1) map to O(n).

A **universal hash family** `H` is a collection of hash functions such that for any two distinct keys `k1 != k2`:

```
P(h(k1) == h(k2)) ≤ 1/m,  for h chosen uniformly at random from H
```

At runtime, you randomly select a function from the family. The attacker cannot predict which function is in use, so they cannot craft adversarial inputs.

A classic universal hash family for integer keys:

```
h_{a,b}(k) = ((a × k + b) mod p) mod m
```

where `p` is a prime larger than the key universe, and `a ∈ {1, ..., p-1}`, `b ∈ {0, ..., p-1}` are chosen at random.

**Real-world**: Java's `HashMap` does not use universal hashing, but it does use hash perturbation (XOR-folding) and treeification as defenses. Python 3.3+ randomizes the hash seed at startup for `str` objects to defend against hash collision denial-of-service attacks (CVE-2012-1150). Rust's `HashMap` uses SipHash by default — a cryptographically strong hash function that resists collision attacks.

### Perfect Hashing

A **perfect hash function** maps `n` known keys to `n` distinct buckets with zero collisions. A **minimal perfect hash function** maps `n` keys to exactly `n` buckets (no wasted space).

Perfect hashing works only when the key set is known in advance and does not change. It is constructed offline:

1. First level: use a universal hash function to distribute keys into buckets.
2. Second level: for each bucket with collisions, construct a secondary hash function that resolves collisions within that bucket.

**Where you see perfect hashing**:
- Compiler keyword tables (the set of keywords is fixed)
- `gperf` tool generates perfect hash functions for static key sets
- **Database hash indexes** on columns with a fixed domain (e.g., US state codes)

For interview purposes, you rarely implement perfect hashing. But knowing it exists demonstrates depth when discussing hash function tradeoffs.

---

## 4.2 Object.hashCode() in the JVM

When you call `hashCode()` on a Java object that has not overridden it, what actually happens inside the JVM? The answer involves the mark word, a pseudorandom number generator, and a subtle interaction with the locking subsystem.

### Default Identity Hash Code

If you do not override `hashCode()`, `Object.hashCode()` calls `System.identityHashCode(obj)`. This is a native method implemented in the HotSpot VM.

In OpenJDK 17+, the default identity hash code generator uses a **thread-local Marsaglia XOR-shift PRNG**. The relevant C++ code in `synchronizer.cpp`:

```cpp
// From hotspot/share/runtime/synchronizer.cpp (simplified)
static inline intptr_t get_next_hash(Thread* current, oop obj) {
    intptr_t value = 0;
    // hashCode == 5 is the default in modern JDK (Marsaglia XOR-shift)
    unsigned t = current->_hashStateX;
    t ^= (t << 11);
    current->_hashStateX = current->_hashStateY;
    current->_hashStateY = current->_hashStateZ;
    current->_hashStateZ = current->_hashStateW;
    unsigned v = current->_hashStateW;
    v = (v ^ (v >> 19)) ^ (t ^ (t >> 8));
    current->_hashStateW = v;
    value = v;
    // ...
    return value;
}
```

Key points:
- **Thread-local**: Each thread has its own PRNG state (`_hashStateX/Y/Z/W`). No synchronization needed.
- **Marsaglia XOR-shift**: A fast, well-distributed PRNG. Not cryptographically secure, but excellent statistical properties for hash codes.
- **31 bits**: The result is masked to 31 bits (non-negative) before storage.

### Storage in the Mark Word

The identity hash code is stored in the object's mark word. Recall from Chapter 1:

```
Mark Word layout (64-bit, unlocked state):
[unused:25 | identity_hashcode:31 | unused:1 | age:4 | biased:1 | lock:2=01]
```

The hash code occupies 31 bits of the mark word. Critical implications:

**Lazy computation**: The hash code is NOT computed at object creation. It is computed on the *first call* to `hashCode()` or `identityHashCode()`, then stored permanently in the mark word.

```java
Object obj = new Object();
// Mark word: [0...0 | hashcode:0 (not yet computed) | age:0 | 0 | 01]

int h = obj.hashCode();
// Now mark word: [0...0 | hashcode:31bits | age:0 | 0 | 01]
// Hash code is permanently stored. Subsequent calls read from mark word.
```

**Biased locking conflict**: The hash code storage overlaps with the space used for biased locking thread ID. Once an identity hash code is written, biased locking is permanently disabled for that object. This was one of the reasons biased locking was deprecated in JDK 15 (JEP 374) and removed in JDK 18.

**Lock inflation**: If an object is currently thin-locked (mark word stores lock record pointer) or fat-locked (mark word stores monitor pointer), and someone calls `identityHashCode()`, the hash code must be preserved. For thin locks, the hash code is stored in the displaced mark word on the stack. For fat locks, it is stored in the ObjectMonitor structure. This is a subtle but real performance interaction.

### The hashCode Contract

The contract specified in `java.lang.Object`:

1. **Consistency**: Multiple calls to `hashCode()` on the same object must return the same value (assuming no fields used in `equals()` changed). This is satisfied trivially for identity hash — it is computed once and stored.

2. **equals implies hashCode match**: If `a.equals(b)` returns `true`, then `a.hashCode() == b.hashCode()` MUST be true. Violating this contract breaks HashMap, HashSet, and every hash-based collection.

3. **hashCode match does NOT imply equals**: Two unequal objects may have the same hash code (collisions are allowed). This is the birthday paradox — collisions are inevitable.

**The most common bug in Java**: Overriding `equals()` without overriding `hashCode()`. Two logically equal objects get different hash codes (identity hash), so `HashMap` puts them in different buckets. The map appears to "lose" entries.

```java
// BROKEN — violates the contract
class Point {
    int x, y;
    
    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Point p)) return false;
        return x == p.x && y == p.y;
    }
    // Missing hashCode override!
    // Two Points with same (x,y) get different identity hash codes.
}

Point p1 = new Point(1, 2);
Point p2 = new Point(1, 2);
p1.equals(p2);  // true
p1.hashCode() == p2.hashCode();  // almost certainly false!

Set<Point> set = new HashSet<>();
set.add(p1);
set.contains(p2);  // false! — p2 is in a different bucket than p1
```

### Common hashCode Implementations

**1. Objects.hash() (varargs convenience)**

```java
@Override
public int hashCode() {
    return Objects.hash(firstName, lastName, age);
}
// Internally calls Arrays.hashCode(Object[]):
// result = 1;
// result = 31 * result + (e == null ? 0 : e.hashCode());  // for each element
```

Convenient but creates a varargs `Object[]` array on every call (autoboxing primitives too). In hot paths, avoid it.

**2. Manual polynomial hash (recommended for performance)**

```java
@Override
public int hashCode() {
    int result = firstName.hashCode();
    result = 31 * result + lastName.hashCode();
    result = 31 * result + age;
    return result;
}
```

Why 31?
- It is an odd prime, which reduces the chance of systematic collisions.
- `31 * x` can be optimized by the JIT to `(x << 5) - x` — a shift and subtract, which is faster than a multiply instruction on some architectures. HotSpot does this automatically.
- Joshua Bloch chose 31 after empirical testing showed it produced fewer collisions than other small primes for typical Java strings.

**3. String.hashCode() — the textbook polynomial hash**

```java
// From java.lang.String (simplified)
public int hashCode() {
    int h = hash;  // cached value
    if (h == 0 && !hashIsZero) {
        for (int i = 0; i < value.length; i++) {
            h = 31 * h + value[i];
        }
        if (h == 0) {
            hashIsZero = true;
        } else {
            hash = h;
        }
    }
    return h;
}
// Computes: s[0]*31^(n-1) + s[1]*31^(n-2) + ... + s[n-1]
// Cached in the `hash` field after first computation.
// Note the hashIsZero flag — needed because 0 is also a valid hash code
// (e.g., empty string has hash 0), so we cannot use hash==0 as "not computed."
```

---

## 4.3 HashMap Deep Dive — OpenJDK Source Walkthrough

This is the heart of the chapter. We will walk through the OpenJDK 17 `HashMap` implementation field by field, method by method.

### Internal Fields

```java
public class HashMap<K,V> extends AbstractMap<K,V> implements Map<K,V> {
    
    // --- Constants ---
    static final int DEFAULT_INITIAL_CAPACITY = 1 << 4;     // 16
    static final int MAXIMUM_CAPACITY = 1 << 30;             // ~1 billion
    static final float DEFAULT_LOAD_FACTOR = 0.75f;
    static final int TREEIFY_THRESHOLD = 8;                  // chain → tree
    static final int UNTREEIFY_THRESHOLD = 6;                // tree → chain
    static final int MIN_TREEIFY_CAPACITY = 64;              // min table size to treeify
    
    // --- Instance fields ---
    transient Node<K,V>[] table;      // the bucket array (lazily allocated)
    transient Set<Map.Entry<K,V>> entrySet;
    transient int size;               // number of key-value pairs
    transient int modCount;           // structural modification counter (fail-fast)
    int threshold;                     // size at which we resize (capacity × loadFactor)
    final float loadFactor;
}
```

**Memory layout of an empty HashMap** (from JOL, JDK 17, compressed OOPs):

```
Offset  Size  Type                 Field
     0     8  (mark word)
     8     4  (klass pointer)
    12     4  float                loadFactor      = 0.75
    16     4  int                  threshold       = 0
    20     4  int                  size            = 0
    24     4  int                  modCount        = 0
    28     4  Node[]               table           = null
    32     4  Set                  entrySet        = null
    36     4  (padding)
Total: 48 bytes (before any entries are added)
```

The `table` is null until the first `put()`. This is lazy initialization — constructing a HashMap costs only 48 bytes.

### The Node Structure

```java
static class Node<K,V> implements Map.Entry<K,V> {
    final int hash;       // 4 bytes — cached hash code
    final K key;          // 4 bytes (compressed ref)
    V value;              // 4 bytes (compressed ref)
    Node<K,V> next;       // 4 bytes (compressed ref) — linked list pointer
    
    // Total: 12 (header) + 4 + 4 + 4 + 4 = 28 → padded to 32 bytes
}
```

Each `Node` costs 32 bytes with compressed OOPs. For 1 million entries, that is 32 MB just for nodes — not counting keys and values.

Notice that `hash` is stored as a field rather than recomputed from `key.hashCode()`. This is an optimization: `get()` compares `hash` first (fast integer comparison) before calling the potentially expensive `equals()`.

### Hash Perturbation: The Spread Function

```java
static final int hash(Object key) {
    int h;
    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
}
```

This is one of the most elegant lines in the JDK. Let me break it down:

**The problem**: HashMap computes the bucket index as `(n - 1) & hash`, where `n` is the table capacity (always a power of 2). If `n = 16`, then `n - 1 = 0x0000000F` (binary: `0000...01111`). The AND mask uses only the *bottom 4 bits* of the hash code. The top 28 bits are completely ignored!

For many hashCode implementations, the low bits have poor distribution. Sequential integers (`0, 1, 2, ...`) have identical high bits and only differ in low bits — which happens to work fine. But consider hash codes from `String.hashCode()` applied to similar strings — the high bits contain useful distributional information that gets thrown away.

**The fix**: XOR the top 16 bits into the bottom 16 bits:

```
Original hash:    1011 0100 1110 0011 | 0001 0110 1010 1100
                  ~~~~~~~~~~~~~~~~~~~~   (top 16 bits)
Shifted:          0000 0000 0000 0000 | 1011 0100 1110 0011
                                        (top 16 shifted to bottom)
XOR result:       1011 0100 1110 0011 | 1010 0010 0100 1111
                                        ^^^^^^^^^^^^^^^^^^^^
                                        Bottom bits now incorporate
                                        information from top bits
```

The top bits remain almost unchanged (XORed with zeros), but the bottom bits now contain information from both halves. This is a cheap (one shift, one XOR) way to ensure that the bucket index incorporates all 32 bits of the hash code, even when the table is small.

**Why not use modulo?** Because `hash % n` for arbitrary `n` requires division, which is slow. `hash & (n - 1)` when `n` is a power of 2 is a single AND instruction — orders of magnitude faster.

### Bucket Index Calculation

```java
// Computing the bucket for a key:
int index = (n - 1) & hash;
```

Since `n` is always a power of 2, `n - 1` is a bitmask with all lower bits set:

```
n = 16:     n - 1 = 0b00001111   (mask: bottom 4 bits)
n = 32:     n - 1 = 0b00011111   (mask: bottom 5 bits)
n = 1024:   n - 1 = 0b1111111111 (mask: bottom 10 bits)
```

The bitwise AND extracts the appropriate number of low bits from the hash, giving a value in `[0, n-1]`. This is equivalent to `hash % n` but uses a single CPU instruction instead of an expensive division.

**Why power-of-2 capacity?** Three reasons:
1. **Speed**: `&` is faster than `%`.
2. **Resize optimization**: When doubling from `n` to `2n`, each entry either stays in its current bucket or moves to `bucket + n`. This can be determined by checking a single bit (explained in the resize section).
3. **Simplicity**: No need to find primes or handle non-power-of-2 sizes.

The downside: if the hash function has patterns in its low bits (e.g., all even numbers), collisions cluster. The perturbation function (XOR-folding) mitigates this.

### put(K key, V value) — Full Walkthrough

Let me walk through the actual OpenJDK `putVal` method:

```java
public V put(K key, V value) {
    return putVal(hash(key), key, value, false, true);
}

final V putVal(int hash, K key, V value, boolean onlyIfAbsent, boolean evict) {
    Node<K,V>[] tab; Node<K,V> p; int n, i;
    
    // Step 1: Initialize table if necessary (lazy init)
    if ((tab = table) == null || (n = tab.length) == 0)
        n = (tab = resize()).length;
    
    // Step 2: Compute bucket index, check if bucket is empty
    if ((p = tab[i = (n - 1) & hash]) == null)
        // Bucket is empty — create new node directly
        tab[i] = newNode(hash, key, value, null);
    else {
        // Bucket is NOT empty — collision handling
        Node<K,V> e; K k;
        
        // Step 3a: Check if first node matches
        if (p.hash == hash &&
            ((k = p.key) == key || (key != null && key.equals(k))))
            // First node is the key we are looking for
            e = p;
        
        // Step 3b: If bucket is a tree, use tree insertion
        else if (p instanceof TreeNode)
            e = ((TreeNode<K,V>)p).putTreeVal(this, tab, hash, key, value);
        
        // Step 3c: Traverse linked list
        else {
            for (int binCount = 0; ; ++binCount) {
                if ((e = p.next) == null) {
                    // Reached end of chain — append new node
                    p.next = newNode(hash, key, value, null);
                    // Check if chain is long enough to treeify
                    if (binCount >= TREEIFY_THRESHOLD - 1) // -1 because 0-indexed
                        treeifyBin(tab, hash);
                    break;
                }
                // Check if current node matches
                if (e.hash == hash &&
                    ((k = e.key) == key || (key != null && key.equals(k))))
                    break;
                p = e;
            }
        }
        
        // Step 4: If key already existed, update value
        if (e != null) {
            V oldValue = e.value;
            if (!onlyIfAbsent || oldValue == null)
                e.value = value;
            afterNodeAccess(e);  // callback for LinkedHashMap
            return oldValue;
        }
    }
    
    // Step 5: Increment modCount and check if resize needed
    ++modCount;
    if (++size > threshold)
        resize();
    afterNodeInsertion(evict);  // callback for LinkedHashMap
    return null;
}
```

**Observation about the equals check pattern**: Notice `p.hash == hash && ((k = p.key) == key || key.equals(k))`. This is a three-level fast path:
1. Compare cached `hash` integers first — O(1) integer comparison. If hashes differ, the keys are definitely different. This rejects most non-matches instantly.
2. Compare references with `==` — catches the case where the same object is used as a key.
3. Call `equals()` — the expensive deep comparison, only reached if hashes match and references differ.

This ordering is critical for performance. In a bucket with 8 nodes, step 1 rejects 7 of them with a single integer comparison. Only 1 proceeds to `equals()`.

### get(Object key) — Full Walkthrough

```java
public V get(Object key) {
    Node<K,V> e;
    return (e = getNode(hash(key), key)) == null ? null : e.value;
}

final Node<K,V> getNode(int hash, Object key) {
    Node<K,V>[] tab; Node<K,V> first, e; int n; K k;
    
    // Step 1: Table must exist and bucket must be non-null
    if ((tab = table) != null && (n = tab.length) > 0 &&
        (first = tab[(n - 1) & hash]) != null) {
        
        // Step 2: Check first node (optimization — most buckets have 0 or 1 entries)
        if (first.hash == hash &&
            ((k = first.key) == key || (key != null && key.equals(k))))
            return first;
        
        // Step 3: Traverse remaining nodes
        if ((e = first.next) != null) {
            // If it is a tree, use tree search (O(log n) in bucket)
            if (first instanceof TreeNode)
                return ((TreeNode<K,V>)first).getTreeNode(hash, key);
            // Otherwise, linear search through linked list
            do {
                if (e.hash == hash &&
                    ((k = e.key) == key || (key != null && key.equals(k))))
                    return e;
            } while ((e = e.next) != null);
        }
    }
    return null;
}
```

The fast path (bucket has exactly one entry) is two comparisons and zero iterations. This is the common case at load factor 0.75 — most buckets have 0 or 1 entries.

### Treeification (Java 8+)

Before Java 8, HashMap buckets were always linked lists. A hash collision attack could degrade a bucket to O(n), causing DoS. Java 8 introduced treeification: when a bucket exceeds `TREEIFY_THRESHOLD = 8` entries, it converts from a linked list to a Red-Black tree.

```java
final void treeifyBin(Node<K,V>[] tab, int hash) {
    int n, index; Node<K,V> e;
    // Won't treeify if table is too small — resize instead
    if (tab == null || (n = tab.length) < MIN_TREEIFY_CAPACITY)
        resize();
    else if ((e = tab[index = (n - 1) & hash]) != null) {
        TreeNode<K,V> hd = null, tl = null;
        // Convert linked list nodes to tree nodes
        do {
            TreeNode<K,V> p = replacementTreeNode(e, null);
            if (tl == null)
                hd = p;
            else {
                p.prev = tl;
                tl.next = p;
            }
            tl = p;
        } while ((e = e.next) != null);
        if ((tab[index] = hd) != null)
            hd.treeify(tab);  // Build the Red-Black tree structure
    }
}
```

**The three thresholds**:
- `TREEIFY_THRESHOLD = 8`: Convert chain to tree when bucket has >8 entries.
- `UNTREEIFY_THRESHOLD = 6`: Convert tree back to chain during resize when bucket shrinks to ≤6 entries.
- `MIN_TREEIFY_CAPACITY = 64`: Do not treeify if the table has fewer than 64 buckets — resize the table instead.

**Why 8?** Under a random hash function, the probability of `k` entries in a single bucket follows a Poisson distribution with parameter `λ = loadFactor = 0.75`. The probability of 8 entries in one bucket is approximately 0.00000006 (6 in 100 million). So treeification should almost never happen with a good hash function — it is a safety net for pathological cases.

**Why the gap between 8 and 6 (hysteresis)?** If we used the same threshold for both directions, a bucket hovering at the threshold would repeatedly convert between list and tree. The gap of 2 prevents this oscillation.

**TreeNode memory cost**: A `TreeNode<K,V>` extends `LinkedHashMap.Entry<K,V>` (which extends `HashMap.Node<K,V>`), adding `parent`, `left`, `right`, `prev` references and a `boolean red` flag:

```java
static final class TreeNode<K,V> extends LinkedHashMap.Entry<K,V> {
    TreeNode<K,V> parent;   // 4 bytes (compressed ref)
    TreeNode<K,V> left;     // 4 bytes
    TreeNode<K,V> right;    // 4 bytes
    TreeNode<K,V> prev;     // 4 bytes (for unlinking on delete)
    boolean red;            // 1 byte
    // From Node: hash(4) + key(4) + value(4) + next(4)
    // From LinkedHashMap.Entry: before(4) + after(4)
    // Header: 12 bytes
    // Total: 12 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 1 + padding = 56 bytes
}
```

A TreeNode costs 56 bytes vs 32 bytes for a regular Node — 75% more memory. This is acceptable because treeification only happens for pathological collision patterns, and the bucket is small (usually ~8-10 entries).

### resize() — The Clever Rehash

When `size > threshold` (default: `capacity × 0.75`), the table doubles in capacity. The resize logic contains one of the most elegant bit-manipulation tricks in the JDK:

```java
final Node<K,V>[] resize() {
    Node<K,V>[] oldTab = table;
    int oldCap = (oldTab == null) ? 0 : oldTab.length;
    int oldThr = threshold;
    int newCap, newThr = 0;
    
    if (oldCap > 0) {
        if (oldCap >= MAXIMUM_CAPACITY) {
            threshold = Integer.MAX_VALUE;
            return oldTab;  // Cannot grow further
        }
        newCap = oldCap << 1;  // Double capacity
        newThr = oldThr << 1;  // Double threshold
    }
    // ... (initial capacity handling omitted for clarity)
    
    Node<K,V>[] newTab = (Node<K,V>[]) new Node[newCap];
    table = newTab;
    
    if (oldTab != null) {
        for (int j = 0; j < oldCap; ++j) {
            Node<K,V> e;
            if ((e = oldTab[j]) != null) {
                oldTab[j] = null;  // Help GC
                
                if (e.next == null)
                    // Only one entry in bucket — rehash directly
                    newTab[e.hash & (newCap - 1)] = e;
                else if (e instanceof TreeNode)
                    // Tree bucket — split the tree
                    ((TreeNode<K,V>)e).split(this, newTab, j, oldCap);
                else {
                    // THE CLEVER TRICK: split linked list without recomputing bucket
                    Node<K,V> loHead = null, loTail = null;  // stays in same bucket
                    Node<K,V> hiHead = null, hiTail = null;  // moves to bucket+oldCap
                    Node<K,V> next;
                    do {
                        next = e.next;
                        // Check if the bit at position oldCap is 0 or 1
                        if ((e.hash & oldCap) == 0) {
                            // Bit is 0 → stays in same bucket index
                            if (loTail == null) loHead = e;
                            else loTail.next = e;
                            loTail = e;
                        } else {
                            // Bit is 1 → moves to bucket + oldCap
                            if (hiTail == null) hiHead = e;
                            else hiTail.next = e;
                            hiTail = e;
                        }
                    } while ((e = next) != null);
                    
                    if (loTail != null) {
                        loTail.next = null;
                        newTab[j] = loHead;
                    }
                    if (hiTail != null) {
                        hiTail.next = null;
                        newTab[j + oldCap] = hiHead;
                    }
                }
            }
        }
    }
    return newTab;
}
```

**The bit trick explained**:

When capacity doubles from `oldCap` to `2 × oldCap`, the bucket mask changes from `(oldCap - 1)` to `(2 × oldCap - 1)`. The new mask has exactly one more bit set than the old mask:

```
oldCap = 16:    mask = 0b01111  (4 bits: positions 0-3)
newCap = 32:    mask = 0b11111  (5 bits: positions 0-4)
                                 ^
                                 This is the new bit (position 4 = oldCap)
```

For each entry, the new bucket index is either:
- **Same as before**: if the hash bit at position `log2(oldCap)` is 0.
- **Old bucket + oldCap**: if the hash bit at position `log2(oldCap)` is 1.

We check this with `(e.hash & oldCap) == 0`. No need to recompute `hash & (newCap - 1)` — just check one bit!

**Example**:

```
hash = 0b10110 = 22
oldCap = 16 (0b10000)
Old bucket: 22 & 0b01111 = 0b00110 = 6

hash & oldCap = 22 & 16 = 0b10110 & 0b10000 = 0b10000 ≠ 0
→ Moves to bucket 6 + 16 = 22

Verify: 22 & 0b11111 = 0b10110 = 22. Correct!
```

This is why HashMap uses power-of-2 capacities. The resize operation is O(n) where n is the number of entries, but each entry only needs a single AND and comparison — no hash recomputation, no modulo.

### Why Load Factor 0.75?

The default load factor of 0.75 is a tradeoff between space and time:

```
Load factor    Avg chain length    Space utilization    Resize frequency
──────────────────────────────────────────────────────────────────────
0.5            ~0.5                50%                  Frequent (wastes memory)
0.75           ~0.75               75%                  Balanced
1.0            ~1.0                100%                 Infrequent (more collisions)
2.0            ~2.0                200% (impossible*)   Never in practice
```

Under a random hash function, the expected number of entries per bucket is exactly the load factor (Poisson distribution with λ = load factor). At 0.75, the probability of any single bucket having more than 3 entries is less than 1.5%. The probability of more than 8 entries (treeification) is negligible.

**Real-world**: If you know the exact number of entries in advance, use `new HashMap<>(n * 4 / 3 + 1)` (or more simply, `new HashMap<>(n, 1.0f)`) to avoid any resizes. A resize copies every entry, so avoiding it in hot paths is worthwhile. Guava's `Maps.newHashMapWithExpectedSize(n)` does this calculation for you.

---

## 4.4 HashSet — A HashMap in Disguise

`HashSet<E>` is one of the simplest classes in the JDK. Its entire implementation delegates to `HashMap<E, Object>`:

```java
public class HashSet<E> extends AbstractSet<E> implements Set<E> {
    
    private transient HashMap<E, Object> map;
    private static final Object PRESENT = new Object();  // dummy value
    
    public HashSet() {
        map = new HashMap<>();
    }
    
    public boolean add(E e) {
        return map.put(e, PRESENT) == null;
    }
    
    public boolean remove(Object o) {
        return map.remove(o) == PRESENT;
    }
    
    public boolean contains(Object o) {
        return map.containsKey(o);
    }
    
    public int size() {
        return map.size();
    }
    
    public Iterator<E> iterator() {
        return map.keySet().iterator();
    }
    // ... that is essentially it
}
```

**The PRESENT constant**: Every element in the HashSet has a dummy `Object` as its value. This wastes 4 bytes per entry (the reference to `PRESENT` in each `Node`). There is also the `PRESENT` object itself (16 bytes), but that is shared across all entries.

**Total memory per element in HashSet**:
- Node: 32 bytes (hash + key ref + value ref [→PRESENT] + next ref)
- The key object itself
- Total overhead per element beyond the key: 32 bytes

Compare with a hypothetical dedicated `HashSet` that does not use `HashMap`:
- Entry: 20 bytes (hash + key ref + next ref, padded to 24 bytes)
- Saves 8 bytes per entry (no value ref, tighter packing)
- For 1M entries: ~8 MB wasted

This is a pragmatic design decision. Code reuse and maintenance simplicity outweigh the 25% memory overhead for most applications.

---

## 4.5 LinkedHashMap — Insertion Order and LRU

`LinkedHashMap<K,V>` extends `HashMap<K,V>` and overlays a doubly-linked list through all entries, preserving insertion order (or access order).

### Internal Structure

```java
public class LinkedHashMap<K,V> extends HashMap<K,V> {
    
    // Entry extends HashMap.Node with before/after pointers
    static class Entry<K,V> extends HashMap.Node<K,V> {
        Entry<K,V> before, after;  // doubly-linked list pointers
        
        Entry(int hash, K key, V value, Node<K,V> next) {
            super(hash, key, value, next);
        }
    }
    // Total Entry size: 32 (Node) + 4 (before) + 4 (after) = 40 bytes
    
    transient LinkedHashMap.Entry<K,V> head;  // eldest entry
    transient LinkedHashMap.Entry<K,V> tail;  // youngest entry
    final boolean accessOrder;  // false=insertion order, true=access order
}
```

**Memory layout**: Each entry costs 40 bytes (vs 32 for HashMap.Node). The `head` and `tail` pointers maintain the doubly-linked list. Iteration is O(n) in the number of entries, not O(capacity) like HashMap (where you must skip empty buckets).

### Insertion Order (Default)

```java
Map<String, Integer> map = new LinkedHashMap<>();
map.put("banana", 2);
map.put("apple", 1);
map.put("cherry", 3);

// Iteration order: banana→apple→cherry (insertion order)
for (Map.Entry<String, Integer> entry : map.entrySet()) {
    System.out.println(entry.getKey());  // banana, apple, cherry
}

// Overwriting a key does NOT change its position:
map.put("banana", 5);
// Order is still: banana→apple→cherry
```

### Access Order and LRU Cache

```java
Map<String, Integer> map = new LinkedHashMap<>(16, 0.75f, true);
//                                                         ^^^^
//                                              accessOrder = true

map.put("a", 1);
map.put("b", 2);
map.put("c", 3);
// Order: a→b→c

map.get("a");  // Accessing "a" moves it to the tail
// Order: b→c→a

map.get("b");  // Accessing "b" moves it to the tail
// Order: c→a→b
```

With `accessOrder=true`, every `get()` or `put()` (on an existing key) moves the accessed entry to the tail. The head is always the *least recently used* entry.

### Building an LRU Cache in 5 Lines

```java
public class LRUCache<K, V> extends LinkedHashMap<K, V> {
    private final int capacity;
    
    public LRUCache(int capacity) {
        super(capacity, 0.75f, true);  // accessOrder = true
        this.capacity = capacity;
    }
    
    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        return size() > capacity;  // Remove LRU entry when over capacity
    }
}
```

`removeEldestEntry()` is called by `put()` after inserting a new entry. If it returns `true`, the `head` entry (least recently used) is automatically removed. The entire LRU eviction policy is implemented in a single line: `return size() > capacity`.

**How the access-order reordering works internally**:

```java
// Inside LinkedHashMap (simplified)
void afterNodeAccess(Node<K,V> e) {
    LinkedHashMap.Entry<K,V> last;
    if (accessOrder && (last = tail) != e) {
        // Unlink e from its current position
        LinkedHashMap.Entry<K,V> p = (LinkedHashMap.Entry<K,V>)e;
        LinkedHashMap.Entry<K,V> b = p.before, a = p.after;
        p.after = null;
        if (b == null) head = a;
        else b.after = a;
        if (a != null) a.before = b;
        else last = b;
        // Link e at the tail
        if (last == null) head = p;
        else { p.before = last; last.after = p; }
        tail = p;
        ++modCount;
    }
}
```

This is O(1) — unlink from the middle of a doubly-linked list and append to the tail. Every `get()` calls `afterNodeAccess()`, making the LRU maintenance overhead constant.

**Caveat**: `LinkedHashMap` is NOT thread-safe. For concurrent LRU, you need either `Collections.synchronizedMap(new LinkedHashMap<>(...))` (coarse locking, poor scalability) or a custom implementation with `ConcurrentHashMap` and a concurrent doubly-linked list (what Caffeine cache does).

---

## 4.6 Collision Resolution Strategies

Java's `HashMap` uses separate chaining. But there are many other approaches, each with different performance characteristics.

### Separate Chaining (Java's Approach)

Each bucket holds a linked list (or tree) of entries that hash to that bucket.

```
Bucket 0: → [A] → [B] → null
Bucket 1: → [C] → null
Bucket 2: → null (empty)
Bucket 3: → [D] → [E] → [F] → null
```

**Pros**: Simple, handles high load factors gracefully, never "full."
**Cons**: Memory overhead per entry (next pointer), poor cache locality (each node is a separate heap object), GC pressure.

### Open Addressing: Linear Probing

When a collision occurs, probe the next slot linearly: `slot = (slot + 1) % capacity`.

```
Insert A(hash=3), B(hash=3), C(hash=3):
Index: [0] [1] [2] [3] [4] [5] [6] [7]
Data:                  [A] [B] [C]
```

**Pros**: Excellent cache locality (sequential memory access), no extra pointers, GC-friendly (one flat array).
**Cons**: Clustering — long runs of occupied slots cause longer probes. Deletion is tricky (need "tombstone" markers or backward-shift deletion). Load factor must stay below ~0.7 for good performance.

**Java's IdentityHashMap uses linear probing**:

```java
// IdentityHashMap stores keys and values in a single flat Object[] array:
// [key0, val0, key1, val1, key2, val2, ...]
// Uses == for comparison instead of equals()
// Linear probing with step size 2 (skip key-value pairs)
```

### Quadratic Probing

Probe sequence: `slot = (original + i^2) % capacity` for `i = 0, 1, 2, ...`

```
Collision at slot 3:
  i=0: try slot 3 (occupied)
  i=1: try slot 3+1=4 (occupied)
  i=2: try slot 3+4=7 (empty → insert)
```

**Pros**: Less clustering than linear probing.
**Cons**: May not visit all slots (must use specific capacity to guarantee full coverage). Secondary clustering — keys with the same hash follow the same probe sequence.

### Double Hashing

Use a second hash function to determine the probe step: `slot = (hash1(key) + i × hash2(key)) % capacity`

**Pros**: Best distribution among simple probing methods. Nearly eliminates clustering.
**Cons**: Two hash computations per probe. The second hash must never be zero (otherwise the probe does not advance).

### Robin Hood Hashing

A variation of open addressing where, during insertion, if the new element's "displacement" (how far it is from its home slot) exceeds the existing element's displacement, they swap. This equalizes chain lengths.

```
Home slots:    [3] [3] [5] [5] [5]
Displacements: [0] [1] [0] [1] [2]
After Robin Hood: max displacement is minimized
```

**Pros**: More predictable worst-case performance. Lookups can terminate early — if you find an entry with a smaller displacement than your current probe distance, the key is not in the table.
**Cons**: More complex insertion logic.

**Where you see it**: Rust's `HashMap` (before switching to SwissTable) used Robin Hood hashing. Zig's standard library hash map uses it.

### Cuckoo Hashing

Use two hash functions and two tables. Each key can be in exactly one of two locations: `table1[h1(key)]` or `table2[h2(key)]`. Lookup is always O(1) worst-case (check exactly 2 positions).

Insertion: if both positions are occupied, evict one existing entry and re-insert it into *its* alternative position. This may cascade.

```
h1(A)=2, h2(A)=5:  table1[2]=A  OR  table2[5]=A
Lookup A: check table1[2], then table2[5]. Exactly 2 lookups, always.
```

**Pros**: O(1) worst-case lookup (not amortized). Simple deletion.
**Cons**: Insertion can cascade and occasionally require full rehash. Load factor must stay below ~50% per table.

**Where you see it**: Network switches (TCAM lookup tables), hardware-accelerated hash tables, some database engines.

---

## 4.7 Real-World Correlations

### DNS Caching

A DNS cache is essentially a `HashMap<String, DNSRecord>` with TTL-based eviction. Each DNS record has a time-to-live, after which it must be re-resolved. In Java, `InetAddress` caches DNS lookups internally using a private `LinkedHashMap` with time-based expiry (controlled by `networkaddress.cache.ttl` security property).

### Database Connection Pool

`HikariCP` (the fastest Java connection pool) maintains connections in structures similar to `ConcurrentHashMap<String, Connection>`. Connection lookup by datasource URL must be O(1) — a pool that takes O(n) to find a free connection becomes the bottleneck under high concurrency.

### HTTP Session Storage

Application servers store HTTP sessions in `ConcurrentHashMap<String, HttpSession>`. The session ID (a random 128-bit hex string) is the key. At Google-scale, this is a distributed hash map spanning thousands of servers, but the local shard is still a hash table.

### Python dict vs Java HashMap

Python's `dict` uses open addressing with a custom probing sequence. Keys and values are stored in a compact, flat array. Since Python 3.7, `dict` maintains insertion order (like Java's `LinkedHashMap`). The contrast:

```
Java HashMap:   Separate chaining → tree on collision
Python dict:    Open addressing → probing on collision

Java HashMap:   Unordered (HashMap) or ordered (LinkedHashMap)
Python dict:    Always ordered (since 3.7)

Java HashMap:   Power-of-2 capacity, load factor 0.75
Python dict:    Power-of-2 capacity, load factor 2/3
```

### Redis Hash Tables

Redis uses two hash tables for incremental rehashing. When a resize is triggered, Redis does not rehash all entries at once (that would block the single-threaded event loop). Instead:
1. Allocate the new table.
2. On each subsequent operation, rehash a small batch of entries from the old table to the new table.
3. Eventually, all entries are migrated and the old table is freed.

This is **incremental rehashing** — spreading the O(n) resize cost across many operations. Java's `HashMap.resize()` does it all at once (acceptable in most cases because the JIT-compiled copy loop is very fast).

### Consistent Hashing for Distributed Caches

Standard hashing (`hash(key) % N` where N = number of servers) breaks when a server is added or removed — nearly all keys get remapped. Consistent hashing fixes this.

Imagine servers placed on a ring (hash space 0 to 2^32-1). Each key hashes to a point on the ring, and it is served by the next server clockwise. Adding or removing a server only affects keys in its adjacent region — approximately `K/N` keys (where K = total keys, N = total servers) instead of nearly all keys.

Virtual nodes: Each physical server maps to multiple points on the ring (e.g., 150 virtual nodes). This ensures even distribution even with few physical servers.

```
Ring:     0 ────── S1 ────── S2 ────── S3 ────── 2^32
Keys:     .... k1 ↑    k2 ↑    k3 ↑    k4 ↑
          assigned to:  S1       S2       S3       S1

Add S4:   0 ── S1 ── S4 ── S2 ── S3 ── 2^32
          Only keys between S1 and S4 move from S2 to S4. Others unchanged.
```

**Where you see it**: Memcached, Amazon DynamoDB, Apache Cassandra, Akamai CDN.

---

## Problems

### Core Hashing (P4.01 -- P4.11)

---

**P4.01** [E] — Two Sum

**Problem**: Given an array of integers `nums` and a target, return indices of two numbers that add up to target. Exactly one solution exists.

**Solution**:

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
    throw new IllegalArgumentException("No solution");
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: Each `nums[i]` is autoboxed to `Integer` when used as a HashMap key. For values in `[-128, 127]`, `Integer.valueOf()` returns cached instances — no new objects created. For values outside that range, a new `Integer` object (16 bytes) is created per insertion. For an array of 10,000 elements with large values, that is ~160 KB of Integer objects just for keys.

**Real-World Correlation**: **Financial reconciliation** — matching debit and credit entries that sum to zero. The O(n^2) nested loop approach times out on millions of transactions; the HashMap approach completes in milliseconds.

---

**P4.02** [E] — Valid Anagram

**Problem**: Given two strings `s` and `t`, return true if `t` is an anagram of `s`.

**Solution**:

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

**Complexity**: O(n) time, O(1) space (fixed 26-element array).

**JVM Insight**: Using `int[26]` instead of `HashMap<Character, Integer>` avoids autoboxing entirely. The array is 120 bytes (16 header + 4 length + 26 × 4) vs a HashMap that would create 26 Node objects (832 bytes) plus 26 Character + 26 Integer objects (~832 more bytes). For a problem this small, the constant factor matters more than asymptotic complexity.

**Real-World Correlation**: **Spell-checking and fuzzy search** — anagram detection is a building block for finding similar words. Search engines use character frequency vectors (a generalization of this approach) for approximate string matching.

---

**P4.03** [M] — Group Anagrams

**Problem**: Given an array of strings, group anagrams together.

**Solution**:

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

**Alternative** — frequency-based key (avoids sorting):

```java
public List<List<String>> groupAnagrams(String[] strs) {
    Map<String, List<String>> map = new HashMap<>();
    for (String s : strs) {
        int[] count = new int[26];
        for (char c : s.toCharArray()) count[c - 'a']++;
        // Build a canonical key from frequency counts
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 26; i++) {
            sb.append('#').append(count[i]);
        }
        String key = sb.toString();
        map.computeIfAbsent(key, k -> new ArrayList<>()).add(s);
    }
    return new ArrayList<>(map.values());
}
```

**Complexity**: O(n × k log k) for sort approach, O(n × k) for frequency approach, where k = max string length. O(n × k) space.

**JVM Insight**: `computeIfAbsent` is a single hash table probe. Without it, you would write `map.containsKey(key)` followed by `map.get(key)` or `map.put(key, new ArrayList<>())` — that is 2-3 probes for the same bucket. `computeIfAbsent` is not just cleaner — it is faster because it traverses the bucket chain only once.

**Real-World Correlation**: **Log aggregation** — grouping log entries by a canonical form (e.g., parameterized query template) to identify high-frequency patterns. Datadog and Splunk use similar grouping for log pattern recognition.

---

**P4.04** [E] — Contains Duplicate

**Problem**: Given an integer array, return true if any value appears at least twice.

**Solution**:

```java
public boolean containsDuplicate(int[] nums) {
    Set<Integer> seen = new HashSet<>();
    for (int num : nums) {
        if (!seen.add(num)) return true;
    }
    return false;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: `HashSet.add()` returns `false` if the element already exists — it delegates to `HashMap.put()` which returns the previous value (non-null if key existed). We exploit the return value to avoid a separate `contains()` call. One probe instead of two. The HashSet internally stores each element as a key in a HashMap with a dummy `PRESENT` value — 32 bytes per element plus the boxed Integer (16 bytes) = 48 bytes per unique number.

**Real-World Correlation**: **Deduplication in event processing** — message queues like Kafka guarantee at-least-once delivery. Consumers use a HashSet of recently processed message IDs to detect and skip duplicates.

---

**P4.05** [M] — Contains Duplicate II (Nearby Duplicate)

**Problem**: Given `nums` and `k`, return true if `nums[i] == nums[j]` and `|i - j| <= k`.

**Solution**:

```java
public boolean containsNearbyDuplicate(int[] nums, int k) {
    Set<Integer> window = new HashSet<>();
    for (int i = 0; i < nums.length; i++) {
        if (i > k) window.remove(nums[i - k - 1]);
        if (!window.add(nums[i])) return true;
    }
    return false;
}
```

**Complexity**: O(n) time, O(min(n, k)) space.

**JVM Insight**: The sliding window HashSet maintains at most `k+1` elements. When `k` is small (say, 10), the HashSet's internal HashMap has 16 buckets (default initial capacity) and never resizes. When `k` is large (say, 1M), preallocating `new HashSet<>(k * 4 / 3 + 1)` avoids multiple resizes during the initial fill.

**Real-World Correlation**: **Rate limiting** — detecting duplicate requests within a sliding time window. API gateways maintain a set of recent request hashes to reject duplicates within a configurable window.

---

**P4.06** [H] — Contains Duplicate III (Nearby Almost Duplicate)

**Problem**: Given `nums`, `indexDiff`, and `valueDiff`, return true if there exist indices `i != j` such that `|i - j| <= indexDiff` and `|nums[i] - nums[j]| <= valueDiff`.

**Solution** — Bucket Sort approach:

```java
public boolean containsNearbyAlmostDuplicate(int[] nums, int indexDiff, int valueDiff) {
    if (valueDiff < 0) return false;
    Map<Long, Long> buckets = new HashMap<>();
    long w = (long) valueDiff + 1;  // bucket width
    
    for (int i = 0; i < nums.length; i++) {
        long id = getBucketId(nums[i], w);
        
        // Check same bucket
        if (buckets.containsKey(id)) return true;
        // Check adjacent buckets
        if (buckets.containsKey(id - 1) && Math.abs(nums[i] - buckets.get(id - 1)) <= valueDiff)
            return true;
        if (buckets.containsKey(id + 1) && Math.abs(nums[i] - buckets.get(id + 1)) <= valueDiff)
            return true;
        
        buckets.put(id, (long) nums[i]);
        if (i >= indexDiff) buckets.remove(getBucketId(nums[i - indexDiff], w));
    }
    return false;
}

private long getBucketId(long num, long w) {
    return num >= 0 ? num / w : (num + 1) / w - 1;
}
```

**Complexity**: O(n) time, O(min(n, indexDiff)) space.

**JVM Insight**: We use `Long` keys and values (not `Integer`) because `nums[i]` can be `Integer.MIN_VALUE` and the bucket ID computation may overflow int range. Each `Long` object is 24 bytes (16 header + 8 value, or 16 with compressed OOPs if value is within Long cache range [-128, 127]). For large `indexDiff`, the HashMap contains many Long objects — each costing 24 bytes for key + 24 bytes for value + 32 bytes for Node = 80 bytes per active element.

**Real-World Correlation**: **Geospatial proximity detection** — this is the one-dimensional version of finding nearby points. GPS-based services use spatial hashing (geohash) to bucket locations and check adjacent buckets for nearby entities, exactly analogous to this algorithm.

---

**P4.07** [E] — First Unique Character in a String

**Problem**: Given a string `s`, find the first non-repeating character and return its index. Return -1 if none.

**Solution**:

```java
public int firstUniqChar(String s) {
    int[] count = new int[26];
    for (int i = 0; i < s.length(); i++) {
        count[s.charAt(i) - 'a']++;
    }
    for (int i = 0; i < s.length(); i++) {
        if (count[s.charAt(i) - 'a'] == 1) return i;
    }
    return -1;
}
```

**Complexity**: O(n) time, O(1) space (fixed 26-element array).

**JVM Insight**: Two passes over the string. In JDK 9+ with compact strings (Latin-1 encoding for ASCII), `s.charAt(i)` reads a single byte from the internal `byte[]` array — sequential access with perfect cache behavior. The `int[26]` array fits entirely within a single cache line (104 bytes for data, but the access pattern hits only ~26 of them). For Unicode strings, you would use `HashMap<Character, Integer>` at ~48 bytes per unique character.

**Real-World Correlation**: **Log parsing for error detection** — finding the first unique error code in a stream of log entries. The two-pass approach is used when the stream can be replayed; for single-pass streams, you would use a `LinkedHashMap` to maintain insertion order.

---

**P4.08** [E] — Intersection of Two Arrays

**Problem**: Given two integer arrays, return their intersection (each element in the result must be unique).

**Solution**:

```java
public int[] intersection(int[] nums1, int[] nums2) {
    Set<Integer> set1 = new HashSet<>();
    for (int n : nums1) set1.add(n);
    
    Set<Integer> result = new HashSet<>();
    for (int n : nums2) {
        if (set1.contains(n)) result.add(n);
    }
    
    int[] arr = new int[result.size()];
    int i = 0;
    for (int n : result) arr[i++] = n;
    return arr;
}
```

**Complexity**: O(n + m) time, O(n + m) space.

**JVM Insight**: The `retainAll` method on `Set` could replace the manual loop, but `set1.retainAll(set2)` modifies `set1` in place by iterating `set1` and calling `set2.contains()` for each element — same complexity, but less control over which set we iterate (we want to iterate the smaller set for fewer `contains()` calls).

**Real-World Correlation**: **Access control** — computing the intersection of a user's roles and a resource's required permissions. RBAC (Role-Based Access Control) systems evaluate `userRoles.retainAll(requiredRoles)` on every request.

---

**P4.09** [E] — Happy Number

**Problem**: A happy number reaches 1 when you repeatedly replace it with the sum of the squares of its digits. Detect if `n` is happy (if not, it cycles).

**Solution**:

```java
public boolean isHappy(int n) {
    Set<Integer> seen = new HashSet<>();
    while (n != 1) {
        if (!seen.add(n)) return false;  // cycle detected
        n = sumOfSquares(n);
    }
    return true;
}

private int sumOfSquares(int n) {
    int sum = 0;
    while (n > 0) {
        int d = n % 10;
        sum += d * d;
        n /= 10;
    }
    return sum;
}
```

**Alternative** — Floyd's cycle detection (O(1) space):

```java
public boolean isHappy(int n) {
    int slow = n, fast = sumOfSquares(n);
    while (fast != 1 && slow != fast) {
        slow = sumOfSquares(slow);
        fast = sumOfSquares(sumOfSquares(fast));
    }
    return fast == 1;
}
```

**Complexity**: O(log n) time per step, O(log n) steps typical. HashSet approach: O(k) space where k = cycle length. Floyd approach: O(1) space.

**JVM Insight**: The Floyd approach eliminates the HashSet entirely — no object allocation, no autoboxing, no HashMap overhead. For a problem where the cycle length is bounded (the sum of digit squares for any int quickly enters a small cycle), this saves creating ~20-30 Integer objects and their associated Node objects in the HashSet's internal HashMap.

**Real-World Correlation**: **Cycle detection in distributed systems** — detecting routing loops in network packets (TTL), deadlock detection in database transaction wait-for graphs, and infinite redirect loops in HTTP.

---

**P4.10** [E] — Isomorphic Strings

**Problem**: Given two strings `s` and `t`, determine if they are isomorphic (each character in `s` can be replaced to get `t`, with a bijective mapping).

**Solution**:

```java
public boolean isIsomorphic(String s, String t) {
    if (s.length() != t.length()) return false;
    int[] mapST = new int[256];
    int[] mapTS = new int[256];
    Arrays.fill(mapST, -1);
    Arrays.fill(mapTS, -1);
    
    for (int i = 0; i < s.length(); i++) {
        char cs = s.charAt(i), ct = t.charAt(i);
        if (mapST[cs] == -1 && mapTS[ct] == -1) {
            mapST[cs] = ct;
            mapTS[ct] = cs;
        } else if (mapST[cs] != ct || mapTS[ct] != cs) {
            return false;
        }
    }
    return true;
}
```

**Complexity**: O(n) time, O(1) space (fixed 256-element arrays).

**JVM Insight**: Using `int[256]` arrays (1 KB each) instead of `HashMap<Character, Character>` avoids all autoboxing and hashing overhead. The arrays fit in L1 cache together (2 KB). With HashMap, each mapping would require a Character key (16 bytes), Character value (16 bytes), and Node (32 bytes) = 64 bytes per mapping, plus hash computation. For ASCII characters, the array approach is orders of magnitude faster.

**Real-World Correlation**: **Character encoding conversion** — verifying that a character encoding mapping is bijective (each source character maps to exactly one target character and vice versa). The ICU library uses similar bidirectional mapping tables for Unicode normalization.

---

**P4.11** [E] — Word Pattern

**Problem**: Given a `pattern` like `"abba"` and a string `s` like `"dog cat cat dog"`, check if `s` follows the same pattern (bijective mapping from pattern chars to words).

**Solution**:

```java
public boolean wordPattern(String pattern, String s) {
    String[] words = s.split(" ");
    if (pattern.length() != words.length) return false;
    
    Map<Character, String> charToWord = new HashMap<>();
    Map<String, Character> wordToChar = new HashMap<>();
    
    for (int i = 0; i < pattern.length(); i++) {
        char c = pattern.charAt(i);
        String w = words[i];
        
        if (charToWord.containsKey(c) && !charToWord.get(c).equals(w)) return false;
        if (wordToChar.containsKey(w) && wordToChar.get(w) != c) return false;
        
        charToWord.put(c, w);
        wordToChar.put(w, c);
    }
    return true;
}
```

**Complexity**: O(n) time, O(n) space where n = number of words.

**JVM Insight**: `s.split(" ")` compiles the regex pattern `" "` each time. For repeated calls, precompile with `Pattern.compile(" ").split(s)`. However, HotSpot optimizes single-character regex splits — when the pattern is a single literal character, `String.split` uses a fast path that avoids regex compilation entirely (check the OpenJDK source for `String.split`). This optimization was added in JDK 7.

**Real-World Correlation**: **URL routing** — web frameworks like Spring MVC match URL patterns (`/users/{id}/posts/{postId}`) to controller methods. The pattern-to-value bijection is the same concept — each path variable maps to a specific segment value.

---

### Frequency and Counting (P4.12 -- P4.17)

---

**P4.12** [M] — Top K Frequent Elements

**Problem**: Given an integer array and integer k, return the k most frequent elements.

**Solution** — Bucket Sort O(n):

```java
public int[] topKFrequent(int[] nums, int k) {
    Map<Integer, Integer> countMap = new HashMap<>();
    for (int n : nums) countMap.merge(n, 1, Integer::sum);
    
    // Bucket sort: index = frequency, value = list of numbers with that frequency
    @SuppressWarnings("unchecked")
    List<Integer>[] buckets = new List[nums.length + 1];
    for (var entry : countMap.entrySet()) {
        int freq = entry.getValue();
        if (buckets[freq] == null) buckets[freq] = new ArrayList<>();
        buckets[freq].add(entry.getKey());
    }
    
    int[] result = new int[k];
    int idx = 0;
    for (int freq = buckets.length - 1; freq >= 0 && idx < k; freq--) {
        if (buckets[freq] != null) {
            for (int num : buckets[freq]) {
                result[idx++] = num;
                if (idx == k) break;
            }
        }
    }
    return result;
}
```

**Complexity**: O(n) time (bucket sort), O(n) space.

**JVM Insight**: The generic array creation `new List[nums.length + 1]` creates an array of references (4 bytes each with compressed OOPs). Most slots are null — only slots at frequencies that actually occur are populated. This is wasteful if `nums.length` is huge but the number of distinct frequencies is small. An alternative is `TreeMap<Integer, List<Integer>>` sorted by frequency, but that is O(n log n).

**Real-World Correlation**: **Real-time analytics dashboards** — finding the top K most visited URLs, most active users, or most common error codes. Systems like Apache Druid use approximate top-K algorithms (Count-Min Sketch + heap) for streaming data, but for batch processing, the bucket sort approach here is exact and optimal.

---

**P4.13** [M] — Sort Characters by Frequency

**Problem**: Given a string, sort it in decreasing order based on character frequency.

**Solution**:

```java
public String frequencySort(String s) {
    int[] freq = new int[128];
    for (char c : s.toCharArray()) freq[c]++;
    
    // Build priority queue of (char, frequency) pairs
    // Or use bucket sort for O(n):
    @SuppressWarnings("unchecked")
    List<Character>[] buckets = new List[s.length() + 1];
    for (int i = 0; i < 128; i++) {
        if (freq[i] > 0) {
            if (buckets[freq[i]] == null) buckets[freq[i]] = new ArrayList<>();
            buckets[freq[i]].add((char) i);
        }
    }
    
    StringBuilder sb = new StringBuilder(s.length());
    for (int f = buckets.length - 1; f > 0; f--) {
        if (buckets[f] != null) {
            for (char c : buckets[f]) {
                sb.append(String.valueOf(c).repeat(f));
            }
        }
    }
    return sb.toString();
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: `StringBuilder(s.length())` preallocates the exact capacity needed — no resizes during building. Without preallocation, `StringBuilder` starts at 16 characters and doubles on each resize, creating intermediate `byte[]` arrays that become garbage. For a 10,000-character string, preallocation avoids ~9 resize operations and ~10 discarded arrays.

**Real-World Correlation**: **Huffman coding** — the first step in Huffman compression is computing character frequencies and sorting them. ZIP files, gzip, and DEFLATE all begin with frequency analysis of the input data.

---

**P4.14** [H] — First Missing Positive

**Problem**: Given an unsorted integer array, find the smallest missing positive integer. O(n) time, O(1) space.

**Solution** — Array-as-HashMap trick:

```java
public int firstMissingPositive(int[] nums) {
    int n = nums.length;
    
    // Step 1: Place each number in its "correct" position
    // nums[i] should hold value i+1
    for (int i = 0; i < n; i++) {
        while (nums[i] > 0 && nums[i] <= n && nums[nums[i] - 1] != nums[i]) {
            // Swap nums[i] to its correct position nums[nums[i]-1]
            int temp = nums[nums[i] - 1];
            nums[nums[i] - 1] = nums[i];
            nums[i] = temp;
        }
    }
    
    // Step 2: Find the first position where nums[i] != i+1
    for (int i = 0; i < n; i++) {
        if (nums[i] != i + 1) return i + 1;
    }
    return n + 1;
}
```

**Complexity**: O(n) time (each element is swapped at most once), O(1) space.

**JVM Insight**: This is the "array as hash map" trick — the array itself serves as the hash table, with `hash(x) = x - 1` mapping value `x` to index `x-1`. No extra data structure needed. Each swap places one element in its correct position, and each element is moved at most once, so the total swaps across all iterations is O(n). The while loop inside the for loop does not make this O(n^2) — it is amortized O(1) per element.

**Real-World Correlation**: **Memory allocator bitmap** — free page tracking in OS memory management uses the array itself as a bitmap/hash: page N's status is stored at position N. The Linux buddy allocator tracks free blocks using this exact "position encodes identity" principle.

---

**P4.15** [M] — Majority Element (Boyer-Moore)

**Problem**: Given an array of size n, find the element that appears more than n/2 times.

**Solution** — Boyer-Moore Voting Algorithm:

```java
public int majorityElement(int[] nums) {
    int candidate = 0, count = 0;
    for (int num : nums) {
        if (count == 0) candidate = num;
        count += (num == candidate) ? 1 : -1;
    }
    return candidate;
}
```

**HashMap approach** (for comparison):

```java
public int majorityElement(int[] nums) {
    Map<Integer, Integer> counts = new HashMap<>();
    for (int num : nums) {
        int c = counts.merge(num, 1, Integer::sum);
        if (c > nums.length / 2) return num;
    }
    throw new IllegalArgumentException("No majority element");
}
```

**Complexity**: Boyer-Moore: O(n) time, O(1) space. HashMap: O(n) time, O(n) space.

**JVM Insight**: Boyer-Moore uses zero heap allocation — just two stack variables. The HashMap approach creates `O(distinct_elements)` Node objects, Integer keys, and Integer values. For an array of 10 million elements, Boyer-Moore processes at ~2 billion elements/second (limited by memory bandwidth). The HashMap approach is ~10x slower due to autoboxing, hash computation, and cache misses from pointer chasing through Nodes.

**Real-World Correlation**: **Leader election in distributed systems** — the Raft consensus protocol elects a leader when a candidate receives votes from a majority of nodes. The Boyer-Moore intuition (a majority element survives all cancellations) is the mathematical basis for why majority-based quorums work.

---

**P4.16** [M] — Find All Duplicates in an Array

**Problem**: Given an array of n integers where each integer is in [1, n], some elements appear twice and others once. Find all elements that appear twice. O(n) time, O(1) extra space.

**Solution** — Negation trick (array as hash set):

```java
public List<Integer> findDuplicates(int[] nums) {
    List<Integer> result = new ArrayList<>();
    for (int i = 0; i < nums.length; i++) {
        int idx = Math.abs(nums[i]) - 1;
        if (nums[idx] < 0) {
            result.add(idx + 1);  // already visited → duplicate
        } else {
            nums[idx] = -nums[idx];  // mark as visited
        }
    }
    return result;
}
```

**Complexity**: O(n) time, O(1) extra space (output list excluded).

**JVM Insight**: This is another "array as hash set" trick. Instead of allocating a `HashSet<Integer>` (which would cost ~48 bytes per unique element — Node + boxed Integer), we encode the visited state in the sign bit of the array elements. The array serves as both data and metadata. `Math.abs()` is intrinsified by HotSpot to a branchless instruction on x86 (`CMOV` or bitwise tricks), making it essentially free.

**Real-World Correlation**: **Database duplicate detection** — finding duplicate rows in a table where the primary key is a contiguous range. Database engines use bitmap indexes for this: each bit represents a key value, set to 1 when encountered. This negation trick is the same concept using sign bits instead of a separate bitmap.

---

**P4.17** [M] — Find All Numbers Disappeared in an Array

**Problem**: Given an array of n integers where each integer is in [1, n], find all integers in [1, n] that do not appear. O(n) time, O(1) extra space.

**Solution**:

```java
public List<Integer> findDisappearedNumbers(int[] nums) {
    for (int i = 0; i < nums.length; i++) {
        int idx = Math.abs(nums[i]) - 1;
        if (nums[idx] > 0) nums[idx] = -nums[idx];
    }
    List<Integer> result = new ArrayList<>();
    for (int i = 0; i < nums.length; i++) {
        if (nums[i] > 0) result.add(i + 1);
    }
    return result;
}
```

**Complexity**: O(n) time, O(1) extra space.

**JVM Insight**: Same negation trick as P4.16. The key JVM detail: `result.add(i + 1)` autoboxes the int to Integer. If the missing numbers are in `[-128, 127]` (unlikely for large arrays), the Integer cache avoids allocation. For larger values, each `add` creates a new Integer object on the heap. If you know the result size in advance, `new ArrayList<>(expectedSize)` avoids array resizes in the ArrayList.

**Real-World Correlation**: **Data integrity checks** — verifying sequence completeness in financial transaction IDs, log sequence numbers, or database auto-increment keys. Missing numbers indicate dropped messages or failed transactions.

---

### Subarray Problems with Hashing (P4.18 -- P4.27)

---

**P4.18** [M] — Subarray Sum Equals K

**Problem**: Given an array and an integer k, find the total number of continuous subarrays whose sum equals k.

**Solution** — Prefix Sum + HashMap:

```java
public int subarraySum(int[] nums, int k) {
    Map<Integer, Integer> prefixCount = new HashMap<>();
    prefixCount.put(0, 1);  // empty prefix has sum 0
    int sum = 0, count = 0;
    
    for (int num : nums) {
        sum += num;
        // If (sum - k) was a previous prefix sum, then subarray from
        // that prefix to current index has sum k
        count += prefixCount.getOrDefault(sum - k, 0);
        prefixCount.merge(sum, 1, Integer::sum);
    }
    return count;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: `prefixCount.merge(sum, 1, Integer::sum)` is a single probe operation. The lambda `Integer::sum` is a method reference to `Integer.sum(int, int)`, which the JIT inlines to a single `iadd` instruction. The `merge` method avoids the read-modify-write pattern of `put(key, getOrDefault(key, 0) + 1)` which would require two probes.

**Real-World Correlation**: **Network traffic analysis** — finding time windows where total byte count equals a threshold. Prefix sum + HashMap is the standard technique for any "find subarrays with target aggregate" query over streaming data.

---

**P4.19** [M] — Longest Consecutive Sequence

**Problem**: Given an unsorted array, find the length of the longest consecutive elements sequence in O(n) time.

**Solution**:

```java
public int longestConsecutive(int[] nums) {
    Set<Integer> set = new HashSet<>();
    for (int num : nums) set.add(num);
    
    int longest = 0;
    for (int num : set) {
        // Only start counting from the beginning of a sequence
        if (!set.contains(num - 1)) {
            int length = 1;
            while (set.contains(num + length)) length++;
            longest = Math.max(longest, length);
        }
    }
    return longest;
}
```

**Complexity**: O(n) time (each element is visited at most twice — once in the outer loop, once in an inner while), O(n) space.

**JVM Insight**: The key optimization is iterating over `set` instead of `nums`. Iterating `nums` would re-process duplicates. Iterating `set` processes each unique value exactly once. The `set.contains(num - 1)` check is the "sequence start" filter — it ensures we only begin counting from the smallest element in each sequence, making the inner while loop execute at most n times total across all outer iterations.

**Real-World Correlation**: **Time series gap detection** — finding the longest uninterrupted sequence of timestamps in monitoring data. If a server reports health every second, gaps in the sequence indicate downtime. This algorithm finds the longest uptime window in O(n).

---

**P4.20** [M] — Contiguous Array (Equal 0s and 1s)

**Problem**: Given a binary array, find the maximum length of a contiguous subarray with equal number of 0 and 1.

**Solution**:

```java
public int findMaxLength(int[] nums) {
    Map<Integer, Integer> map = new HashMap<>();
    map.put(0, -1);  // prefix sum 0 at index -1 (before array starts)
    int sum = 0, maxLen = 0;
    
    for (int i = 0; i < nums.length; i++) {
        sum += nums[i] == 0 ? -1 : 1;  // treat 0 as -1
        if (map.containsKey(sum)) {
            maxLen = Math.max(maxLen, i - map.get(sum));
        } else {
            map.put(sum, i);  // store FIRST occurrence only
        }
    }
    return maxLen;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: By treating 0 as -1, the problem reduces to "find longest subarray with sum 0" — a prefix sum problem. The HashMap stores at most 2n+1 distinct prefix sums (range [-n, n]). For a binary array of length 10,000, the map might have ~500-1000 entries. Using `containsKey` + `get` is two probes; combining into `Integer prev = map.get(sum)` and checking `prev != null` would be one probe, but the null check is dangerous because the value could legitimately be stored as index 0.

**Real-World Correlation**: **Network traffic balancing** — finding the longest time window where inbound and outbound traffic are equal. ISPs monitor traffic balance to detect asymmetric routing issues.

---

**P4.21** [H] — Minimum Window Substring

**Problem**: Given strings `s` and `t`, find the minimum window in `s` that contains all characters of `t`.

**Solution**:

```java
public String minWindow(String s, String t) {
    if (s.length() < t.length()) return "";
    
    int[] need = new int[128];
    for (char c : t.toCharArray()) need[c]++;
    int required = t.length();
    
    int left = 0, minLen = Integer.MAX_VALUE, minStart = 0;
    
    for (int right = 0; right < s.length(); right++) {
        if (need[s.charAt(right)]-- > 0) required--;
        
        while (required == 0) {
            if (right - left + 1 < minLen) {
                minLen = right - left + 1;
                minStart = left;
            }
            if (++need[s.charAt(left)] > 0) required++;
            left++;
        }
    }
    return minLen == Integer.MAX_VALUE ? "" : s.substring(minStart, minStart + minLen);
}
```

**Complexity**: O(n) time where n = s.length(), O(1) space (fixed 128-element array).

**JVM Insight**: Using `int[128]` instead of `HashMap<Character, Integer>` makes this problem's constant factor tiny. The array fits in two cache lines. Every character access is a direct array index — no hashing, no equals comparison, no node traversal. `s.substring(minStart, minStart + minLen)` in JDK 7+ creates a new String with its own backing array (no more shared backing arrays as in JDK 6), costing O(minLen) time and memory.

**Real-World Correlation**: **Search engine snippet extraction** — given a query with multiple terms, find the shortest passage in a document that contains all query terms. This is exactly minimum window substring applied to document search.

---

**P4.22** [M] — Longest Substring Without Repeating Characters

**Problem**: Given a string, find the length of the longest substring without repeating characters.

**Solution**:

```java
public int lengthOfLongestSubstring(String s) {
    int[] lastSeen = new int[128];
    Arrays.fill(lastSeen, -1);
    int maxLen = 0, left = 0;
    
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        if (lastSeen[c] >= left) {
            left = lastSeen[c] + 1;
        }
        lastSeen[c] = right;
        maxLen = Math.max(maxLen, right - left + 1);
    }
    return maxLen;
}
```

**Complexity**: O(n) time, O(1) space (fixed 128-element array).

**JVM Insight**: `Arrays.fill(lastSeen, -1)` is intrinsified by HotSpot to a vectorized store operation (fills 16 ints per instruction with AVX-512). The single-pass sliding window never backtracks `right` — every character is visited exactly once. With `HashMap<Character, Integer>`, each iteration would involve autoboxing the character, computing its hash, traversing the bucket chain, and potentially creating a new Node. The array approach is ~10x faster for ASCII input.

**Real-World Correlation**: **Network protocol parsing** — finding the longest header field without duplicate characters (relevant in some binary protocols). More practically, this sliding window pattern is the foundation of TCP's receive window management.

---

**P4.23** [M] — Longest Substring with At Most K Distinct Characters

**Problem**: Given a string and integer k, find the length of the longest substring with at most k distinct characters.

**Solution**:

```java
public int lengthOfLongestSubstringKDistinct(String s, int k) {
    if (k == 0 || s.isEmpty()) return 0;
    
    int[] count = new int[128];
    int distinct = 0, left = 0, maxLen = 0;
    
    for (int right = 0; right < s.length(); right++) {
        if (count[s.charAt(right)]++ == 0) distinct++;
        
        while (distinct > k) {
            if (--count[s.charAt(left)] == 0) distinct--;
            left++;
        }
        maxLen = Math.max(maxLen, right - left + 1);
    }
    return maxLen;
}
```

**Complexity**: O(n) time, O(1) space.

**JVM Insight**: The `count` array tracks how many times each character appears in the current window. Incrementing `count[c]` and checking `== 0` in one expression (`count[c]++ == 0`) is a post-increment: it reads the old value (checks if 0), then increments. The decrement side (`--count[c] == 0`) is a pre-decrement: decrements first, then checks. These are single bytecode instructions (`iaload`, `iastore`, `iinc`) — no method calls, no boxing.

**Real-World Correlation**: **Database query optimization** — finding the longest range of consecutive rows in a sorted index that have at most k distinct values in a column. This determines selectivity for range scans and helps the query planner decide between index scan and table scan.

---

**P4.24** [H] — Substring with Concatenation of All Words

**Problem**: Given a string `s` and a list of equal-length words, find all starting indices of substrings in `s` that are a concatenation of all words (each used exactly once, in any order).

**Solution**:

```java
public List<Integer> findSubstring(String s, String[] words) {
    List<Integer> result = new ArrayList<>();
    if (s.isEmpty() || words.length == 0) return result;
    
    int wordLen = words[0].length();
    int totalLen = wordLen * words.length;
    
    Map<String, Integer> wordCount = new HashMap<>();
    for (String w : words) wordCount.merge(w, 1, Integer::sum);
    
    // Slide in steps of wordLen, with wordLen different starting offsets
    for (int offset = 0; offset < wordLen; offset++) {
        Map<String, Integer> window = new HashMap<>();
        int matched = 0;
        
        for (int right = offset; right + wordLen <= s.length(); right += wordLen) {
            String word = s.substring(right, right + wordLen);
            
            if (wordCount.containsKey(word)) {
                window.merge(word, 1, Integer::sum);
                matched++;
                
                // Shrink window if a word appears too many times
                while (window.get(word) > wordCount.get(word)) {
                    int left = right - (matched - 1) * wordLen;
                    String leftWord = s.substring(left, left + wordLen);
                    window.merge(leftWord, -1, Integer::sum);
                    matched--;
                }
                
                if (matched == words.length) {
                    result.add(right - (matched - 1) * wordLen);
                }
            } else {
                window.clear();
                matched = 0;
            }
        }
    }
    return result;
}
```

**Complexity**: O(n × wordLen) time, O(numWords) space.

**JVM Insight**: `s.substring(right, right + wordLen)` creates a new String object each time (JDK 7+). For a string of 10,000 characters and word length 5, this creates ~2,000 String objects per offset, ~10,000 total. Each String has a 16-byte header + 4-byte hash + 4-byte coder + 4-byte reference to byte[] = ~40 bytes, plus the byte[] array (~24 bytes for a 5-char ASCII string). Total: ~640 KB of temporary Strings. These are short-lived and collected in minor GC. For extreme performance, you could hash the substring range directly without creating String objects, but the JVM handles this well.

**Real-World Correlation**: **Protein sequence analysis** — finding all positions in a DNA/protein sequence where a set of known motifs appear contiguously. Bioinformatics tools like BLAST use windowed hashing to search for multi-pattern matches in genomic data.

---

**P4.25** [M] — Longest Palindrome

**Problem**: Given a string of lowercase and uppercase letters, find the length of the longest palindrome that can be built with those letters.

**Solution**:

```java
public int longestPalindrome(String s) {
    int[] freq = new int[128];
    for (char c : s.toCharArray()) freq[c]++;
    
    int length = 0;
    boolean hasOdd = false;
    for (int f : freq) {
        length += f / 2 * 2;  // use pairs
        if (f % 2 == 1) hasOdd = true;
    }
    return hasOdd ? length + 1 : length;  // one odd character can go in center
}
```

**Complexity**: O(n) time, O(1) space.

**JVM Insight**: `f / 2 * 2` is equivalent to `f & ~1` (clear the lowest bit). Both produce the largest even number <= f. The JIT may optimize the division-then-multiplication into a single AND instruction. Using `int[128]` for frequency counting is consistently faster than HashMap — no autoboxing, no hashing, no Node allocation. For this problem, the array approach processes ~1 billion characters per second on modern hardware.

**Real-World Correlation**: **Data compression** — palindromic structures in data enable efficient encoding. The LZ77 algorithm (used in gzip) exploits repeated patterns including palindromic sequences for compression.

---

**P4.26** [M] — Encode and Decode TinyURL

**Problem**: Design a URL shortening service with `encode()` and `decode()` methods.

**Solution**:

```java
public class Codec {
    private Map<String, String> shortToLong = new HashMap<>();
    private Map<String, String> longToShort = new HashMap<>();
    private static final String BASE = "http://tinyurl.com/";
    private static final String CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    private Random random = new Random();
    
    public String encode(String longUrl) {
        if (longToShort.containsKey(longUrl)) return longToShort.get(longUrl);
        
        String code;
        do {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 6; i++) {
                sb.append(CHARS.charAt(random.nextInt(CHARS.length())));
            }
            code = sb.toString();
        } while (shortToLong.containsKey(code));
        
        String shortUrl = BASE + code;
        shortToLong.put(code, longUrl);
        longToShort.put(longUrl, shortUrl);
        return shortUrl;
    }
    
    public String decode(String shortUrl) {
        return shortToLong.get(shortUrl.substring(BASE.length()));
    }
}
```

**Complexity**: O(1) amortized for both encode and decode. Space: O(n) for n URLs.

**JVM Insight**: The 6-character code from 62 characters gives 62^6 = ~56.8 billion possible codes. By the birthday paradox, collisions start around √(56.8B) = ~238,000 URLs. The `do-while` retry loop handles collisions but is extremely rare for reasonable URL counts. For production scale, you would use a database sequence (auto-increment ID → base62 encode) instead of random generation to guarantee no collisions without a retry loop.

**Real-World Correlation**: **Bit.ly, TinyURL, and URL shorteners** use exactly this pattern. Production systems use a globally unique ID generator (Snowflake ID, database sequence) instead of random codes. The decode lookup is a single hash table probe — the core operation that must be sub-millisecond for billions of redirects per day.

---

**P4.27** [M] — Copy List with Random Pointer

**Problem**: Deep copy a linked list where each node has a `next` pointer and a `random` pointer to any node in the list or null.

**Solution** — HashMap approach:

```java
public Node copyRandomList(Node head) {
    if (head == null) return null;
    
    Map<Node, Node> map = new HashMap<>();
    
    // First pass: create all node copies
    Node curr = head;
    while (curr != null) {
        map.put(curr, new Node(curr.val));
        curr = curr.next;
    }
    
    // Second pass: wire up next and random pointers
    curr = head;
    while (curr != null) {
        map.get(curr).next = map.get(curr.next);
        map.get(curr).random = map.get(curr.random);
        curr = curr.next;
    }
    
    return map.get(head);
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: The HashMap keys are `Node` objects using identity hash (reference-based). Since `Node` does not override `hashCode()` or `equals()`, HashMap uses `System.identityHashCode()` — the hash stored in the node's mark word. This is ideal here: we want identity-based mapping (each original node maps to its unique copy). If Node overrode `hashCode()` based on `val`, two nodes with the same value would collide, breaking the copy.

**Real-World Correlation**: **Object graph serialization** — Java's `ObjectOutputStream` uses an identity map to track which objects have already been serialized, handling circular references. Protobuf and FlatBuffers serializers use similar "seen object" maps to detect shared references in object graphs.

---

### Design Problems (P4.28 -- P4.40)

---

**P4.28** [M] — Design HashMap

**Problem**: Implement a HashMap from scratch with `put`, `get`, and `remove` operations.

**Solution**:

```java
class MyHashMap {
    private static final int DEFAULT_CAPACITY = 16;
    private static final float LOAD_FACTOR = 0.75f;
    
    private Node[] table;
    private int size;
    
    static class Node {
        int key, value;
        Node next;
        Node(int key, int value, Node next) {
            this.key = key;
            this.value = value;
            this.next = next;
        }
    }
    
    public MyHashMap() {
        table = new Node[DEFAULT_CAPACITY];
    }
    
    private int hash(int key) {
        int h = Integer.hashCode(key);
        return (h ^ (h >>> 16)) & (table.length - 1);
    }
    
    public void put(int key, int value) {
        int idx = hash(key);
        Node curr = table[idx];
        while (curr != null) {
            if (curr.key == key) {
                curr.value = value;
                return;
            }
            curr = curr.next;
        }
        // Insert at head of chain
        table[idx] = new Node(key, value, table[idx]);
        size++;
        if (size > table.length * LOAD_FACTOR) resize();
    }
    
    public int get(int key) {
        int idx = hash(key);
        Node curr = table[idx];
        while (curr != null) {
            if (curr.key == key) return curr.value;
            curr = curr.next;
        }
        return -1;
    }
    
    public void remove(int key) {
        int idx = hash(key);
        Node dummy = new Node(0, 0, table[idx]);
        Node prev = dummy;
        while (prev.next != null) {
            if (prev.next.key == key) {
                prev.next = prev.next.next;
                size--;
                table[idx] = dummy.next;
                return;
            }
            prev = prev.next;
        }
        table[idx] = dummy.next;
    }
    
    private void resize() {
        Node[] oldTable = table;
        table = new Node[oldTable.length * 2];
        size = 0;
        for (Node head : oldTable) {
            while (head != null) {
                put(head.key, head.value);
                head = head.next;
            }
        }
    }
}
```

**Complexity**: O(1) amortized for all operations. O(n) worst case per bucket (linked list). O(n) for resize.

**JVM Insight**: Our `Node` stores `int key, int value` directly — no boxing. Each Node is 12 (header) + 4 (key) + 4 (value) + 4 (next ref) = 24 bytes, padded to 24. Compare with JDK's `HashMap.Node` which stores boxed keys and values: 32 bytes per Node PLUS the key and value objects. Our approach for int→int mapping is ~3x more memory-efficient. This is exactly what Eclipse Collections' `IntIntHashMap` does.

**Real-World Correlation**: **Embedded systems** — custom hash maps with primitive keys/values are standard in latency-sensitive applications (trading systems, game engines) where GC pauses from boxed objects are unacceptable.

---

**P4.29** [E] — Design HashSet

**Problem**: Implement a HashSet without using any built-in hash table libraries.

**Solution**:

```java
class MyHashSet {
    private static final int CAPACITY = 1009;  // prime for better distribution
    private List<Integer>[] buckets;
    
    @SuppressWarnings("unchecked")
    public MyHashSet() {
        buckets = new LinkedList[CAPACITY];
    }
    
    private int hash(int key) {
        return key % CAPACITY;
    }
    
    public void add(int key) {
        int idx = hash(key);
        if (buckets[idx] == null) buckets[idx] = new LinkedList<>();
        if (!buckets[idx].contains(key)) buckets[idx].add(key);
    }
    
    public void remove(int key) {
        int idx = hash(key);
        if (buckets[idx] != null) buckets[idx].remove(Integer.valueOf(key));
    }
    
    public boolean contains(int key) {
        int idx = hash(key);
        return buckets[idx] != null && buckets[idx].contains(key);
    }
}
```

**Complexity**: O(n/k) average per operation where k = number of buckets.

**JVM Insight**: Using a prime number for capacity (`1009`) gives better distribution with modulo than a power of 2 when the hash function is simple (just `key % capacity`). Power-of-2 with bitwise AND only works well when the hash function has good avalanche properties. For a simple modulo hash, primes are safer. `LinkedList.remove(Integer.valueOf(key))` calls the `remove(Object)` overload (not `remove(int index)`) — a common source of bugs. `Integer.valueOf(key)` creates a boxed Integer so the list can match by `.equals()`.

**Real-World Correlation**: **Bloom filter backing** — a simplified Bloom filter is essentially multiple hash sets with different hash functions. The separate chaining approach here is the simplest collision resolution strategy, suitable for teaching and low-scale use.

---

**P4.30** [H] — LRU Cache (HashMap + Doubly Linked List)

**Problem**: Design a data structure that follows the constraints of a Least Recently Used (LRU) cache. `get` and `put` in O(1).

**Solution** — HashMap + Doubly Linked List:

```java
class LRUCache {
    private final int capacity;
    private final Map<Integer, DNode> map;
    private final DNode head, tail;  // sentinel nodes
    
    static class DNode {
        int key, value;
        DNode prev, next;
        DNode(int key, int value) {
            this.key = key;
            this.value = value;
        }
    }
    
    public LRUCache(int capacity) {
        this.capacity = capacity;
        this.map = new HashMap<>();
        this.head = new DNode(0, 0);
        this.tail = new DNode(0, 0);
        head.next = tail;
        tail.prev = head;
    }
    
    public int get(int key) {
        DNode node = map.get(key);
        if (node == null) return -1;
        moveToHead(node);
        return node.value;
    }
    
    public void put(int key, int value) {
        DNode node = map.get(key);
        if (node != null) {
            node.value = value;
            moveToHead(node);
        } else {
            DNode newNode = new DNode(key, value);
            map.put(key, newNode);
            addToHead(newNode);
            if (map.size() > capacity) {
                DNode lru = tail.prev;
                removeNode(lru);
                map.remove(lru.key);
            }
        }
    }
    
    private void addToHead(DNode node) {
        node.prev = head;
        node.next = head.next;
        head.next.prev = node;
        head.next = node;
    }
    
    private void removeNode(DNode node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }
    
    private void moveToHead(DNode node) {
        removeNode(node);
        addToHead(node);
    }
}
```

**Solution** — LinkedHashMap (5-line version):

```java
class LRUCache extends LinkedHashMap<Integer, Integer> {
    private final int capacity;
    
    public LRUCache(int capacity) {
        super(capacity, 0.75f, true);
        this.capacity = capacity;
    }
    
    @Override
    protected boolean removeEldestEntry(Map.Entry<Integer, Integer> eldest) {
        return size() > capacity;
    }
    
    public int get(int key) {
        return super.getOrDefault(key, -1);
    }
}
```

**Complexity**: O(1) for both `get` and `put`.

**JVM Insight**: The manual implementation stores `key` in both the `DNode` and as the HashMap key. This duplication is necessary because when evicting the LRU node (accessed via the linked list tail), we need the key to remove the HashMap entry. The DNode costs 12 (header) + 4 (key) + 4 (value) + 4 (prev) + 4 (next) = 28, padded to 32 bytes. Plus the HashMap.Node: 32 bytes. Plus the Integer key in HashMap: 16 bytes. Total per cached entry: ~80 bytes. The LinkedHashMap approach is slightly more memory-efficient because it uses a single Entry object (40 bytes) that serves as both the map entry and the linked list node.

**Real-World Correlation**: **CPU L1/L2 caches** use LRU (or pseudo-LRU) eviction. **Memcached** uses a slab-based LRU. **Caffeine** (successor to Guava Cache) uses Window TinyLFU, which outperforms pure LRU. The manual doubly-linked-list approach here is exactly what Redis uses for its LRU eviction policy (with sampling optimization to avoid maintaining the full linked list).

---

**P4.31** [H] — Design Consistent Hashing Ring

**Problem**: Implement a consistent hashing ring with add/remove server and key lookup.

**Solution**:

```java
class ConsistentHashRing {
    private final TreeMap<Integer, String> ring = new TreeMap<>();
    private final int virtualNodes;
    private final MessageDigest md;
    
    public ConsistentHashRing(int virtualNodes) {
        this.virtualNodes = virtualNodes;
        try {
            this.md = MessageDigest.getInstance("MD5");
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
    
    public void addServer(String server) {
        for (int i = 0; i < virtualNodes; i++) {
            int hash = hash(server + "#" + i);
            ring.put(hash, server);
        }
    }
    
    public void removeServer(String server) {
        for (int i = 0; i < virtualNodes; i++) {
            int hash = hash(server + "#" + i);
            ring.remove(hash);
        }
    }
    
    public String getServer(String key) {
        if (ring.isEmpty()) return null;
        int hash = hash(key);
        // Find the first server clockwise from the key's hash
        Map.Entry<Integer, String> entry = ring.ceilingEntry(hash);
        if (entry == null) entry = ring.firstEntry();  // wrap around
        return entry.getValue();
    }
    
    private int hash(String key) {
        md.reset();
        byte[] digest = md.digest(key.getBytes());
        return ((digest[0] & 0xFF) << 24) | ((digest[1] & 0xFF) << 16) |
               ((digest[2] & 0xFF) << 8)  | (digest[3] & 0xFF);
    }
}
```

**Complexity**: `addServer`/`removeServer`: O(V log(NV)) where V = virtual nodes, N = servers. `getServer`: O(log(NV)).

**JVM Insight**: `TreeMap.ceilingEntry()` uses Red-Black tree search — O(log n) with good cache behavior because TreeMap nodes are allocated close together (created sequentially during `addServer`). The `MessageDigest` is reused (with `reset()`) to avoid re-creating the digest object on every hash call. MD5 is chosen for distribution quality, not security — for consistent hashing, we need uniform distribution, not collision resistance.

**Real-World Correlation**: **Amazon DynamoDB, Apache Cassandra, and Memcached** all use consistent hashing for data partitioning. DynamoDB uses 150 virtual nodes per physical node. When a server fails, only its adjacent range is redistributed — approximately `1/N` of the total keys. Without consistent hashing, adding/removing a server would remap nearly all keys.

---

**P4.32** [M] — Time-Based Key-Value Store

**Problem**: Design a time-based key-value store where `set(key, value, timestamp)` stores value at time, and `get(key, timestamp)` returns the value with the largest timestamp <= given timestamp.

**Solution**:

```java
class TimeMap {
    private Map<String, List<int[]>> map;
    private Map<String, List<String>> values;
    
    public TimeMap() {
        map = new HashMap<>();
        values = new HashMap<>();
    }
    
    public void set(String key, String value, int timestamp) {
        map.computeIfAbsent(key, k -> new ArrayList<>()).add(new int[]{timestamp});
        values.computeIfAbsent(key, k -> new ArrayList<>()).add(value);
    }
    
    public String get(String key, int timestamp) {
        if (!map.containsKey(key)) return "";
        List<int[]> times = map.get(key);
        List<String> vals = values.get(key);
        
        // Binary search for largest timestamp <= given
        int lo = 0, hi = times.size() - 1, result = -1;
        while (lo <= hi) {
            int mid = lo + (hi - lo) / 2;
            if (times.get(mid)[0] <= timestamp) {
                result = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return result == -1 ? "" : vals.get(result);
    }
}
```

**Simpler solution** using TreeMap per key:

```java
class TimeMap {
    private Map<String, TreeMap<Integer, String>> map = new HashMap<>();
    
    public void set(String key, String value, int timestamp) {
        map.computeIfAbsent(key, k -> new TreeMap<>()).put(timestamp, value);
    }
    
    public String get(String key, int timestamp) {
        TreeMap<Integer, String> tree = map.get(key);
        if (tree == null) return "";
        Map.Entry<Integer, String> entry = tree.floorEntry(timestamp);
        return entry == null ? "" : entry.getValue();
    }
}
```

**Complexity**: Set: O(1) for ArrayList, O(log n) for TreeMap. Get: O(log n) for both.

**JVM Insight**: The TreeMap approach is cleaner but uses more memory: each TreeMap.Entry is ~48 bytes (header + key ref + value ref + left + right + parent + color). The ArrayList approach with binary search stores timestamps in a flat list with excellent cache locality. For a key with 1M timestamps, ArrayList binary search does ~20 comparisons on contiguous memory; TreeMap does ~20 comparisons with 20 pointer dereferences to scattered heap objects.

**Real-World Correlation**: **Time-series databases** like InfluxDB and TimescaleDB store values indexed by timestamp. The `get(key, timestamp)` operation is a "point-in-time query" — finding the value as of a specific time. This is fundamental to database MVCC (Multi-Version Concurrency Control), where each row version has a timestamp.

---

**P4.33** [H] — All O(1) Data Structure

**Problem**: Design a data structure with `inc(key)`, `dec(key)`, `getMaxKey()`, `getMinKey()` all in O(1).

**Solution**:

```java
class AllOne {
    private Map<String, Node> keyToNode = new HashMap<>();
    private Node head, tail;  // sentinel nodes for doubly-linked list of count buckets
    
    static class Node {
        int count;
        Set<String> keys = new LinkedHashSet<>();
        Node prev, next;
        Node(int count) { this.count = count; }
    }
    
    public AllOne() {
        head = new Node(Integer.MIN_VALUE);
        tail = new Node(Integer.MAX_VALUE);
        head.next = tail;
        tail.prev = head;
    }
    
    public void inc(String key) {
        if (keyToNode.containsKey(key)) {
            Node curr = keyToNode.get(key);
            int newCount = curr.count + 1;
            Node next = curr.next;
            if (next == tail || next.count != newCount) {
                next = insertAfter(curr, newCount);
            }
            next.keys.add(key);
            keyToNode.put(key, next);
            curr.keys.remove(key);
            if (curr.keys.isEmpty()) removeNode(curr);
        } else {
            Node first = head.next;
            if (first == tail || first.count != 1) {
                first = insertAfter(head, 1);
            }
            first.keys.add(key);
            keyToNode.put(key, first);
        }
    }
    
    public void dec(String key) {
        if (!keyToNode.containsKey(key)) return;
        Node curr = keyToNode.get(key);
        if (curr.count == 1) {
            keyToNode.remove(key);
        } else {
            int newCount = curr.count - 1;
            Node prev = curr.prev;
            if (prev == head || prev.count != newCount) {
                prev = insertAfter(curr.prev, newCount);
            }
            prev.keys.add(key);
            keyToNode.put(key, prev);
        }
        curr.keys.remove(key);
        if (curr.keys.isEmpty()) removeNode(curr);
    }
    
    public String getMaxKey() {
        return tail.prev == head ? "" : tail.prev.keys.iterator().next();
    }
    
    public String getMinKey() {
        return head.next == tail ? "" : head.next.keys.iterator().next();
    }
    
    private Node insertAfter(Node node, int count) {
        Node newNode = new Node(count);
        newNode.prev = node;
        newNode.next = node.next;
        node.next.prev = newNode;
        node.next = newNode;
        return newNode;
    }
    
    private void removeNode(Node node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }
}
```

**Complexity**: All operations O(1).

**JVM Insight**: The doubly-linked list of count buckets is sorted by count. Each bucket holds a `LinkedHashSet` of keys with that count. `LinkedHashSet` provides O(1) add/remove/contains AND maintains insertion order (so `iterator().next()` returns the oldest key in the bucket in O(1)). This is a three-level data structure: HashMap → linked list of count nodes → set of keys per count. The memory overhead is significant but justified by the O(1) guarantee.

**Real-World Correlation**: **Rate limiting with frequency tracking** — tracking API call frequencies per client and instantly identifying the highest and lowest consumers. Load balancers like HAProxy maintain per-server request counts and route to the least-loaded server, requiring O(1) min-key access.

---

**P4.34** [H] — Insert Delete GetRandom O(1)

**Problem**: Design a data structure supporting `insert`, `remove`, and `getRandom` each in average O(1) time.

**Solution**:

```java
class RandomizedSet {
    private Map<Integer, Integer> valToIndex;
    private List<Integer> values;
    private Random rand;
    
    public RandomizedSet() {
        valToIndex = new HashMap<>();
        values = new ArrayList<>();
        rand = new Random();
    }
    
    public boolean insert(int val) {
        if (valToIndex.containsKey(val)) return false;
        valToIndex.put(val, values.size());
        values.add(val);
        return true;
    }
    
    public boolean remove(int val) {
        if (!valToIndex.containsKey(val)) return false;
        int idx = valToIndex.get(val);
        int lastVal = values.get(values.size() - 1);
        
        // Move last element to the removed element's position
        values.set(idx, lastVal);
        valToIndex.put(lastVal, idx);
        
        // Remove last element
        values.remove(values.size() - 1);
        valToIndex.remove(val);
        return true;
    }
    
    public int getRandom() {
        return values.get(rand.nextInt(values.size()));
    }
}
```

**Complexity**: All operations O(1) average.

**JVM Insight**: The trick is maintaining a dense `ArrayList` (no gaps) by swapping the removed element with the last element. `ArrayList.remove(size-1)` is O(1) — it just decrements the size counter, no shifting needed. `HashMap` provides O(1) lookup from value to index. `Random.nextInt(bound)` uses a single call to the underlying PRNG — on JDK 17+ with the default `L64X128MixRandom` generator, this is a few multiplies and XORs.

**Real-World Correlation**: **Load balancer random selection** — when multiple backend servers are available, random selection with equal probability is a simple and effective load balancing strategy. The data structure here supports dynamic server addition/removal while maintaining uniform random selection.

---

**P4.35** [M] — Implement LFU Cache

**Problem**: Design a Least Frequently Used cache with `get` and `put` in O(1). On tie, evict the least recently used.

**Solution**:

```java
class LFUCache {
    private int capacity, minFreq;
    private Map<Integer, int[]> keyToValFreq;           // key → [value, freq]
    private Map<Integer, LinkedHashSet<Integer>> freqToKeys;  // freq → keys (in order)
    
    public LFUCache(int capacity) {
        this.capacity = capacity;
        keyToValFreq = new HashMap<>();
        freqToKeys = new HashMap<>();
    }
    
    public int get(int key) {
        if (!keyToValFreq.containsKey(key)) return -1;
        int[] vf = keyToValFreq.get(key);
        incrementFreq(key, vf);
        return vf[0];
    }
    
    public void put(int key, int value) {
        if (capacity == 0) return;
        
        if (keyToValFreq.containsKey(key)) {
            int[] vf = keyToValFreq.get(key);
            vf[0] = value;
            incrementFreq(key, vf);
        } else {
            if (keyToValFreq.size() >= capacity) {
                // Evict least frequent (and least recent among those)
                LinkedHashSet<Integer> minSet = freqToKeys.get(minFreq);
                int evict = minSet.iterator().next();
                minSet.remove(evict);
                if (minSet.isEmpty()) freqToKeys.remove(minFreq);
                keyToValFreq.remove(evict);
            }
            keyToValFreq.put(key, new int[]{value, 1});
            freqToKeys.computeIfAbsent(1, k -> new LinkedHashSet<>()).add(key);
            minFreq = 1;
        }
    }
    
    private void incrementFreq(int key, int[] vf) {
        int freq = vf[1];
        LinkedHashSet<Integer> set = freqToKeys.get(freq);
        set.remove(key);
        if (set.isEmpty()) {
            freqToKeys.remove(freq);
            if (minFreq == freq) minFreq++;
        }
        vf[1] = freq + 1;
        freqToKeys.computeIfAbsent(freq + 1, k -> new LinkedHashSet<>()).add(key);
    }
}
```

**Complexity**: O(1) for both `get` and `put`.

**JVM Insight**: `LinkedHashSet` maintains insertion order, so `iterator().next()` returns the least recently used key among keys with the same frequency — achieving the LRU tie-breaking in O(1). The `int[]` value array avoids creating a separate value class — a common interview trick to store (value, freq) in a mutable container without defining a new class. Each `int[2]` costs 24 bytes (16 header + 4 length + 8 data), which is less than a custom class (which would be 32 bytes with header + fields + padding).

**Real-World Correlation**: **CPU cache replacement** — modern processors use pseudo-LFU policies (e.g., Intel's adaptive replacement policy). **Redis** supports LFU eviction (`maxmemory-policy allkeys-lfu`) since Redis 4.0, using a logarithmic counter that decays over time to approximate recency-weighted frequency.

---

**P4.36** [M] — Design Underground System

**Problem**: Track passenger check-in/check-out at stations and compute average travel times.

**Solution**:

```java
class UndergroundSystem {
    private Map<Integer, String[]> checkInMap;  // id → [station, time as string]
    private Map<String, long[]> travelMap;       // "from→to" → [totalTime, count]
    
    public UndergroundSystem() {
        checkInMap = new HashMap<>();
        travelMap = new HashMap<>();
    }
    
    public void checkIn(int id, String stationName, int t) {
        checkInMap.put(id, new String[]{stationName, String.valueOf(t)});
    }
    
    public void checkOut(int id, String stationName, int t) {
        String[] checkIn = checkInMap.remove(id);
        String route = checkIn[0] + "→" + stationName;
        long[] stats = travelMap.computeIfAbsent(route, k -> new long[2]);
        stats[0] += t - Integer.parseInt(checkIn[1]);
        stats[1]++;
    }
    
    public double getAverageTime(String startStation, String endStation) {
        long[] stats = travelMap.get(startStation + "→" + endStation);
        return (double) stats[0] / stats[1];
    }
}
```

**Complexity**: All operations O(1) average.

**JVM Insight**: Using `long[]` for the stats accumulator avoids creating a custom class and avoids autoboxing. The route key `"from→to"` creates a new String on each check-out — for high-throughput systems, you would intern route strings or use a composite key object. `HashMap.remove(id)` returns the removed value, allowing atomic check-and-remove in one probe.

**Real-World Correlation**: **Transit analytics systems** — TfL (Transport for London) uses exactly this pattern for Oyster card data: check-in at a station tap-in gate, check-out at a tap-out gate, compute average journey times for capacity planning.

---

**P4.37** [M] — Design a Number Container System

**Problem**: Design a system that supports inserting/replacing numbers at indices and finding the smallest index for a given number.

**Solution**:

```java
class NumberContainers {
    private Map<Integer, Integer> indexToNum;
    private Map<Integer, TreeSet<Integer>> numToIndices;
    
    public NumberContainers() {
        indexToNum = new HashMap<>();
        numToIndices = new HashMap<>();
    }
    
    public void change(int index, int number) {
        if (indexToNum.containsKey(index)) {
            int oldNum = indexToNum.get(index);
            TreeSet<Integer> set = numToIndices.get(oldNum);
            set.remove(index);
            if (set.isEmpty()) numToIndices.remove(oldNum);
        }
        indexToNum.put(index, number);
        numToIndices.computeIfAbsent(number, k -> new TreeSet<>()).add(index);
    }
    
    public int find(int number) {
        TreeSet<Integer> set = numToIndices.get(number);
        return (set == null || set.isEmpty()) ? -1 : set.first();
    }
}
```

**Complexity**: `change`: O(log n). `find`: O(log n) for TreeSet.first() (though often O(1) if the implementation caches the leftmost node).

**JVM Insight**: `TreeSet.first()` in OpenJDK navigates to the leftmost node of the Red-Black tree — this is O(log n) in the worst case but O(1) if the tree caches it (some implementations do). An alternative using `PriorityQueue` would give O(1) peek but O(log n) for removal, and lazy deletion makes it tricky to maintain consistency. The TreeSet approach is clean and correct.

**Real-World Correlation**: **Database index management** — maintaining secondary indexes that map values back to row positions. When a cell value changes, the old index entry must be removed and a new one added, exactly as this `change` method does.

---

**P4.38** [M] — Design Browser History

**Problem**: Implement browser history with `visit`, `back`, and `forward`.

**Solution**:

```java
class BrowserHistory {
    private List<String> history;
    private int current;
    
    public BrowserHistory(String homepage) {
        history = new ArrayList<>();
        history.add(homepage);
        current = 0;
    }
    
    public void visit(String url) {
        // Clear forward history
        while (history.size() > current + 1) {
            history.remove(history.size() - 1);
        }
        history.add(url);
        current++;
    }
    
    public String back(int steps) {
        current = Math.max(0, current - steps);
        return history.get(current);
    }
    
    public String forward(int steps) {
        current = Math.min(history.size() - 1, current + steps);
        return history.get(current);
    }
}
```

**Complexity**: `visit`: O(k) where k = forward history to clear. `back`/`forward`: O(1).

**JVM Insight**: Using `ArrayList` gives O(1) indexed access for `back` and `forward`. The `visit` method truncates forward history by removing from the end — `ArrayList.remove(size - 1)` is O(1). An alternative using two stacks (back-stack, forward-stack) is also O(1) per operation but requires pushing/popping on every navigation, which creates more temporary objects.

**Real-World Correlation**: **Browser engines** — Chrome's navigation controller maintains a history list with a current index, exactly this data structure. The "clear forward history on new navigation" behavior is the standard web navigation model defined in the HTML spec.

---

**P4.39** [M] — Custom Sort String

**Problem**: Given an order string and a string s, permute s so characters appear in the same order as in the order string. Characters not in order can appear in any position at the end.

**Solution**:

```java
public String customSortString(String order, String s) {
    int[] count = new int[26];
    for (char c : s.toCharArray()) count[c - 'a']++;
    
    StringBuilder sb = new StringBuilder(s.length());
    for (char c : order.toCharArray()) {
        while (count[c - 'a']-- > 0) sb.append(c);
    }
    for (int i = 0; i < 26; i++) {
        while (count[i]-- > 0) sb.append((char)('a' + i));
    }
    return sb.toString();
}
```

**Complexity**: O(n) time, O(1) space (fixed 26-element array).

**JVM Insight**: Preallocating `StringBuilder(s.length())` ensures exactly one array allocation. The counting sort approach is O(n) — better than a comparison-based sort (O(n log n)). The `count[c - 'a']--` in the while condition is a post-decrement: it checks the current value against 0, then decrements. When count reaches 0, the loop exits and count becomes -1, but subsequent characters in the second loop correctly skip because `count[i]--` evaluates the negative value.

**Real-World Correlation**: **Log level prioritization** — sorting log entries by priority (ERROR before WARN before INFO) uses a similar counting approach. The "order" string defines the priority, and counting sort is optimal when the priority set is small and fixed.

---

**P4.40** [M] — Snapshot Array

**Problem**: Implement a SnapshotArray that supports `set(index, val)`, `snap()` (take snapshot, return snap_id), and `get(index, snap_id)`.

**Solution**:

```java
class SnapshotArray {
    private List<int[]>[] snaps;  // snaps[index] = list of [snap_id, value]
    private int snapId;
    
    @SuppressWarnings("unchecked")
    public SnapshotArray(int length) {
        snaps = new ArrayList[length];
        for (int i = 0; i < length; i++) {
            snaps[i] = new ArrayList<>();
            snaps[i].add(new int[]{0, 0});
        }
    }
    
    public void set(int index, int val) {
        List<int[]> list = snaps[index];
        int[] last = list.get(list.size() - 1);
        if (last[0] == snapId) {
            last[1] = val;
        } else {
            list.add(new int[]{snapId, val});
        }
    }
    
    public int snap() {
        return snapId++;
    }
    
    public int get(int index, int snap_id) {
        List<int[]> list = snaps[index];
        // Binary search for largest snap_id <= given
        int lo = 0, hi = list.size() - 1;
        while (lo < hi) {
            int mid = lo + (hi - lo + 1) / 2;
            if (list.get(mid)[0] <= snap_id) lo = mid;
            else hi = mid - 1;
        }
        return list.get(lo)[1];
    }
}
```

**Complexity**: `set`: O(1). `snap`: O(1). `get`: O(log S) where S = number of snapshots affecting that index.

**JVM Insight**: This is a copy-on-write approach — only store values that change, not the entire array on every snap. For a 100,000 element array with 1,000 snapshots where only 100 elements change per snapshot, naive snapshotting would cost 100,000 × 1,000 = 100M entries. This approach costs only 100 × 1,000 = 100K entries. The trade-off is O(log S) get vs O(1) get for the naive approach.

**Real-World Correlation**: **Database MVCC (Multi-Version Concurrency Control)** — PostgreSQL and MySQL/InnoDB maintain multiple versions of each row, indexed by transaction ID. A `SELECT` at a given transaction reads the latest version visible to that transaction, using binary search on the version chain — exactly this algorithm.

---

### Advanced Problems (P4.41 -- P4.55)

---

**P4.41** [H] — Word Ladder

**Problem**: Given a begin word, end word, and dictionary, find the shortest transformation sequence where each step changes exactly one letter.

**Solution**:

```java
public int ladderLength(String beginWord, String endWord, List<String> wordList) {
    Set<String> dict = new HashSet<>(wordList);
    if (!dict.contains(endWord)) return 0;
    
    Set<String> beginSet = new HashSet<>(), endSet = new HashSet<>();
    beginSet.add(beginWord);
    endSet.add(endWord);
    Set<String> visited = new HashSet<>();
    visited.add(beginWord);
    visited.add(endWord);
    
    int steps = 1;
    while (!beginSet.isEmpty() && !endSet.isEmpty()) {
        // Always expand the smaller set (bidirectional BFS optimization)
        if (beginSet.size() > endSet.size()) {
            Set<String> temp = beginSet;
            beginSet = endSet;
            endSet = temp;
        }
        
        Set<String> nextSet = new HashSet<>();
        for (String word : beginSet) {
            char[] chars = word.toCharArray();
            for (int i = 0; i < chars.length; i++) {
                char original = chars[i];
                for (char c = 'a'; c <= 'z'; c++) {
                    if (c == original) continue;
                    chars[i] = c;
                    String next = new String(chars);
                    if (endSet.contains(next)) return steps + 1;
                    if (dict.contains(next) && !visited.contains(next)) {
                        nextSet.add(next);
                        visited.add(next);
                    }
                }
                chars[i] = original;
            }
        }
        beginSet = nextSet;
        steps++;
    }
    return 0;
}
```

**Complexity**: O(M^2 × N) where M = word length, N = dictionary size. Space: O(N).

**JVM Insight**: Bidirectional BFS dramatically reduces the search space. Standard BFS explores O(26^d) nodes at depth d; bidirectional BFS explores O(2 × 26^(d/2)), which is exponentially smaller. The `HashSet.contains()` for dictionary lookup is O(M) because String.equals() compares characters. `new String(chars)` creates a new String object per character change — 26 × M allocations per word. For hot code paths, the JIT may optimize `new String(char[])` to avoid the defensive copy if it proves the char[] does not escape.

**Real-World Correlation**: **Network routing — OSPF** (Open Shortest Path First) uses BFS (Dijkstra for weighted graphs) to find shortest paths between routers. The "dictionary" is the network topology, and "one-letter changes" are direct links between adjacent routers.

---

**P4.42** [M] — Alien Dictionary Verification

**Problem**: Given a sequence of words sorted lexicographically according to an alien alphabet, verify that the words are sorted correctly.

**Solution**:

```java
public boolean isAlienSorted(String[] words, String order) {
    int[] priority = new int[26];
    for (int i = 0; i < order.length(); i++) {
        priority[order.charAt(i) - 'a'] = i;
    }
    
    for (int i = 0; i < words.length - 1; i++) {
        if (!isOrdered(words[i], words[i + 1], priority)) return false;
    }
    return true;
}

private boolean isOrdered(String w1, String w2, int[] priority) {
    int len = Math.min(w1.length(), w2.length());
    for (int i = 0; i < len; i++) {
        int diff = priority[w1.charAt(i) - 'a'] - priority[w2.charAt(i) - 'a'];
        if (diff < 0) return true;
        if (diff > 0) return false;
    }
    return w1.length() <= w2.length();  // "app" before "apple"
}
```

**Complexity**: O(total characters across all words) time, O(1) space.

**JVM Insight**: The `priority` array is a hash map from character to its rank in the alien alphabet — using a flat `int[26]` array for O(1) lookup. This is the same principle as the `int[26]` frequency arrays we have been using: when the key space is small and known (26 lowercase letters), a flat array beats HashMap in every dimension — speed, memory, and cache behavior.

**Real-World Correlation**: **Database collation** — SQL databases support custom collation orders (e.g., `COLLATE utf8_turkish_ci` where 'I' sorts differently). The collation definition is essentially a priority array mapping characters to sort positions, exactly like this problem.

---

**P4.43** [H] — Longest Duplicate Substring

**Problem**: Given a string, find the longest substring that occurs at least twice.

**Solution** — Binary Search + Rabin-Karp Rolling Hash:

```java
public String longestDupSubstring(String s) {
    int lo = 1, hi = s.length() - 1;
    String result = "";
    
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        String dup = findDuplicate(s, mid);
        if (dup != null) {
            result = dup;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return result;
}

private String findDuplicate(String s, int len) {
    long MOD = (1L << 61) - 1;  // Mersenne prime
    long BASE = 31;
    long hash = 0, power = 1;
    
    // Compute hash of first window and power = BASE^(len-1)
    for (int i = 0; i < len; i++) {
        hash = (hash * BASE + (s.charAt(i) - 'a' + 1)) % MOD;
        if (i < len - 1) power = (power * BASE) % MOD;
    }
    
    Map<Long, List<Integer>> seen = new HashMap<>();
    seen.computeIfAbsent(hash, k -> new ArrayList<>()).add(0);
    
    for (int i = 1; i + len <= s.length(); i++) {
        // Rolling hash: remove leftmost, add rightmost
        hash = (hash - (s.charAt(i - 1) - 'a' + 1) * power % MOD + MOD) % MOD;
        hash = (hash * BASE + (s.charAt(i + len - 1) - 'a' + 1)) % MOD;
        
        List<Integer> positions = seen.get(hash);
        if (positions != null) {
            String candidate = s.substring(i, i + len);
            for (int pos : positions) {
                if (s.substring(pos, pos + len).equals(candidate)) {
                    return candidate;
                }
            }
        }
        seen.computeIfAbsent(hash, k -> new ArrayList<>()).add(i);
    }
    return null;
}
```

**Complexity**: O(n log n) average time, O(n) space.

**JVM Insight**: The Mersenne prime `(1L << 61) - 1` is used as the modulus because modular arithmetic with Mersenne primes can be optimized using bitwise operations (though in practice, HotSpot's division is fast enough). The rolling hash avoids O(len) work per position — each slide is O(1). The HashMap stores hash → list of positions for collision verification. Using `Long` as HashMap key triggers autoboxing, but since the hashes are typically large values outside the `[-128, 127]` cache range, each creates a new `Long` object.

**Real-World Correlation**: **Plagiarism detection** — tools like Turnitin use rolling hash (Rabin-Karp) to find duplicate passages across millions of documents. The binary search on length + rolling hash approach here is the same algorithmic core.

---

**P4.44** [M] — Group Shifted Strings

**Problem**: Given a list of strings, group strings that belong to the same shifting sequence (each character shifted by the same amount wraps around).

**Solution**:

```java
public List<List<String>> groupStrings(String[] strings) {
    Map<String, List<String>> map = new HashMap<>();
    
    for (String s : strings) {
        StringBuilder key = new StringBuilder();
        for (int i = 1; i < s.length(); i++) {
            int diff = (s.charAt(i) - s.charAt(i - 1) + 26) % 26;
            key.append(diff).append(',');
        }
        map.computeIfAbsent(key.toString(), k -> new ArrayList<>()).add(s);
    }
    return new ArrayList<>(map.values());
}
```

**Complexity**: O(n × k) where n = number of strings, k = max string length. O(n × k) space.

**JVM Insight**: The canonical key encodes the *differences* between adjacent characters, normalized to [0, 25]. The `+26` before `%26` handles negative differences (when wrapping from 'z' to 'a'). `key.toString()` creates a new String for each input string, which becomes the HashMap key. String.hashCode() is O(key length) on first call, then cached. For strings of similar length, the key strings are similar in length, so hash computation is uniform.

**Real-World Correlation**: **Caesar cipher analysis** — this is literally detecting Caesar cipher groups. Cryptanalysis tools group ciphertexts by their shift pattern to identify which ones were encrypted with the same key.

---

**P4.45** [M] — Brick Wall

**Problem**: Given a wall of rows of bricks with different widths, find a vertical line that crosses the fewest bricks.

**Solution**:

```java
public int leastBricks(List<List<Integer>> wall) {
    Map<Integer, Integer> edgeCount = new HashMap<>();
    int maxEdges = 0;
    
    for (List<Integer> row : wall) {
        int sum = 0;
        for (int i = 0; i < row.size() - 1; i++) {  // exclude last brick
            sum += row.get(i);
            int count = edgeCount.merge(sum, 1, Integer::sum);
            maxEdges = Math.max(maxEdges, count);
        }
    }
    return wall.size() - maxEdges;
}
```

**Complexity**: O(total bricks) time, O(total bricks) space.

**JVM Insight**: `edgeCount.merge(sum, 1, Integer::sum)` returns the *new* value after merging, which we use directly for the max computation — avoiding a separate `get()` call. The HashMap keys are prefix sums (Integer values). If brick widths are small, prefix sums stay within the Integer cache range `[-128, 127]`, saving boxing allocations. For typical wall widths, sums exceed 127 and each `merge` call autoboxes both the key and the increment value.

**Real-World Correlation**: **Seam carving in image processing** — finding the vertical path that crosses the fewest "high-energy" edges (content-aware image resizing). The concept of finding minimum-crossing lines through structured data is identical.

---

**P4.46** [M] — 4Sum II

**Problem**: Given four integer arrays, find how many tuples `(i, j, k, l)` satisfy `A[i] + B[j] + C[k] + D[l] == 0`.

**Solution**:

```java
public int fourSumCount(int[] A, int[] B, int[] C, int[] D) {
    Map<Integer, Integer> sumAB = new HashMap<>();
    for (int a : A) {
        for (int b : B) {
            sumAB.merge(a + b, 1, Integer::sum);
        }
    }
    
    int count = 0;
    for (int c : C) {
        for (int d : D) {
            count += sumAB.getOrDefault(-(c + d), 0);
        }
    }
    return count;
}
```

**Complexity**: O(n^2) time, O(n^2) space.

**JVM Insight**: This is the "meet in the middle" technique — reducing O(n^4) to O(n^2) by splitting into two halves and using a HashMap as the bridge. The HashMap stores up to n^2 entries. For arrays of length 500, that is 250,000 entries — about 12 MB of HashMap overhead (Nodes + boxed Integers). `getOrDefault` avoids the null check pattern and is a single probe.

**Real-World Correlation**: **Database join optimization** — hash join splits the operation into a build phase (hash one table) and a probe phase (scan the other table and probe the hash). This is exactly the same split: build phase = sumAB map, probe phase = iterate C and D.

---

**P4.47** [H] — Palindrome Pairs

**Problem**: Given a list of unique words, find all pairs (i, j) where the concatenation `words[i] + words[j]` is a palindrome.

**Solution**:

```java
public List<List<Integer>> palindromePairs(String[] words) {
    Map<String, Integer> map = new HashMap<>();
    for (int i = 0; i < words.length; i++) {
        map.put(words[i], i);
    }
    
    List<List<Integer>> result = new ArrayList<>();
    for (int i = 0; i < words.length; i++) {
        String word = words[i];
        for (int j = 0; j <= word.length(); j++) {
            String left = word.substring(0, j);
            String right = word.substring(j);
            
            // Case 1: left is palindrome, reverse of right exists in map
            if (isPalindrome(left)) {
                String revRight = new StringBuilder(right).reverse().toString();
                Integer idx = map.get(revRight);
                if (idx != null && idx != i) {
                    result.add(Arrays.asList(idx, i));
                }
            }
            
            // Case 2: right is palindrome, reverse of left exists in map
            if (j < word.length() && isPalindrome(right)) {
                String revLeft = new StringBuilder(left).reverse().toString();
                Integer idx = map.get(revLeft);
                if (idx != null && idx != i) {
                    result.add(Arrays.asList(i, idx));
                }
            }
        }
    }
    return result;
}

private boolean isPalindrome(String s) {
    int lo = 0, hi = s.length() - 1;
    while (lo < hi) {
        if (s.charAt(lo++) != s.charAt(hi--)) return false;
    }
    return true;
}
```

**Complexity**: O(n × k^2) where k = max word length. O(n × k) space.

**JVM Insight**: `new StringBuilder(right).reverse().toString()` creates three objects per call: StringBuilder, its internal byte[], and the resulting String. For a word of length k, this is called O(k) times, creating O(k) temporary objects per word. Across all words, that is O(n × k^2) temporary objects. However, these are short-lived (die in the current iteration) and collected cheaply in minor GC. The alternative — reversing in a char array without StringBuilder — would save object allocation but add code complexity with minimal real performance difference for typical inputs.

**Real-World Correlation**: **Natural language processing** — finding word pairs that form palindromic phrases is a building block for computational linguistics puzzles and wordplay analysis in NLP systems.

---

**P4.48** [M] — Longest Harmonious Subsequence

**Problem**: Find the longest harmonious subsequence where the difference between max and min elements is exactly 1.

**Solution**:

```java
public int findLHS(int[] nums) {
    Map<Integer, Integer> count = new HashMap<>();
    for (int n : nums) count.merge(n, 1, Integer::sum);
    
    int maxLen = 0;
    for (var entry : count.entrySet()) {
        int key = entry.getKey();
        if (count.containsKey(key + 1)) {
            maxLen = Math.max(maxLen, entry.getValue() + count.get(key + 1));
        }
    }
    return maxLen;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: Iterating `count.entrySet()` avoids two separate `keySet` and `get` lookups. Each `Map.Entry` is actually the `HashMap.Node` itself (since `Node implements Map.Entry`) — no additional object is created for iteration. The `containsKey(key + 1)` autoboxes the `int` to `Integer`. If we wanted to avoid this, we could iterate entries in sorted order using `TreeMap`, but that changes the complexity to O(n log n).

**Real-World Correlation**: **Signal processing** — finding the longest segment of audio where frequency components are within one semitone of each other. Music analysis tools use frequency counting and neighbor checks similar to this algorithm.

---

**P4.49** [E] — Ransom Note

**Problem**: Given two strings `ransomNote` and `magazine`, return true if ransomNote can be constructed from magazine letters.

**Solution**:

```java
public boolean canConstruct(String ransomNote, String magazine) {
    int[] count = new int[26];
    for (char c : magazine.toCharArray()) count[c - 'a']++;
    for (char c : ransomNote.toCharArray()) {
        if (--count[c - 'a'] < 0) return false;
    }
    return true;
}
```

**Complexity**: O(n + m) time, O(1) space.

**JVM Insight**: `magazine.toCharArray()` creates a new `char[]` copy of the string's internal data. For a very long magazine (millions of characters), this allocates a large temporary array. An alternative without allocation: iterate by index with `magazine.charAt(i)`. With JDK 9+ compact strings, `charAt(i)` on an ASCII string reads a single byte from the internal `byte[]` — no character conversion needed.

**Real-World Correlation**: **Inventory management** — checking if a customer order can be fulfilled from warehouse stock. Each magazine letter is a unit of stock, each ransom note letter is an ordered item. The decrement-and-check pattern is the same as inventory reservation systems.

---

**P4.50** [E] — Jewels and Stones

**Problem**: Given a string of jewels (each char is a type) and a string of stones, count how many stones are jewels.

**Solution**:

```java
public int numJewelsInStones(String jewels, String stones) {
    boolean[] isJewel = new boolean[128];
    for (char c : jewels.toCharArray()) isJewel[c] = true;
    
    int count = 0;
    for (char c : stones.toCharArray()) {
        if (isJewel[c]) count++;
    }
    return count;
}
```

**Complexity**: O(j + s) time, O(1) space.

**JVM Insight**: Using `boolean[128]` instead of `HashSet<Character>` avoids all boxing and hashing. The boolean array is 128 bytes (16 header + 4 length + 128 × 1 byte). A HashSet with 50 jewel types would use 50 × (32 Node + 16 Character) = 2,400 bytes plus the backing HashMap array. The flat boolean array is 20x more memory-efficient and has perfect cache behavior.

**Real-World Correlation**: **Content filtering** — checking if network packets contain bytes from a blacklist. Intrusion detection systems (Snort, Suricata) use flat lookup tables (similar to the boolean array) for high-speed byte pattern matching.

---

**P4.51** [M] — Repeated DNA Sequences

**Problem**: Find all 10-letter sequences that occur more than once in a DNA string.

**Solution**:

```java
public List<String> findRepeatedDnaSequences(String s) {
    Set<String> seen = new HashSet<>(), repeated = new HashSet<>();
    for (int i = 0; i + 10 <= s.length(); i++) {
        String sub = s.substring(i, i + 10);
        if (!seen.add(sub)) repeated.add(sub);
    }
    return new ArrayList<>(repeated);
}
```

**Optimized** — rolling hash with 2-bit encoding:

```java
public List<String> findRepeatedDnaSequences(String s) {
    if (s.length() < 10) return new ArrayList<>();
    
    Map<Character, Integer> encode = Map.of('A', 0, 'C', 1, 'G', 2, 'T', 3);
    Set<Integer> seen = new HashSet<>(), added = new HashSet<>();
    List<String> result = new ArrayList<>();
    
    int hash = 0, mask = (1 << 20) - 1;  // 10 chars × 2 bits = 20 bits
    for (int i = 0; i < s.length(); i++) {
        hash = ((hash << 2) | encode.get(s.charAt(i))) & mask;
        if (i >= 9) {
            if (!seen.add(hash)) {
                if (added.add(hash)) {
                    result.add(s.substring(i - 9, i + 1));
                }
            }
        }
    }
    return result;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: The rolling hash approach encodes each 10-character DNA substring as a 20-bit integer. With only 2^20 = ~1M possible values, using `HashSet<Integer>` with values in [0, 1M) benefits from the Integer cache for values in [-128, 127] — but most values exceed 127, so boxing still occurs. A `BitSet` of size 1M (125 KB) would be even more efficient: `bitSet.get(hash)` and `bitSet.set(hash)` are O(1) with no boxing at all.

**Real-World Correlation**: **Genomics** — finding repeated motifs in DNA sequences is fundamental to genome assembly and gene annotation. Real bioinformatics tools like RepeatMasker use k-mer hashing (generalization of this problem to arbitrary k) to identify repetitive elements in genomes.

---

**P4.52** [E] — Number of Good Pairs

**Problem**: Given an array, count pairs (i, j) where `i < j` and `nums[i] == nums[j]`.

**Solution**:

```java
public int numIdenticalPairs(int[] nums) {
    int[] count = new int[101];  // nums[i] in [1, 100]
    int pairs = 0;
    for (int n : nums) {
        pairs += count[n];  // each existing occurrence forms a new pair
        count[n]++;
    }
    return pairs;
}
```

**Complexity**: O(n) time, O(1) space (fixed array for known range).

**JVM Insight**: The insight is that when we see the k-th occurrence of a value, it forms `k-1` new pairs with the previous `k-1` occurrences. So we just add the current count before incrementing. No HashMap needed because the value range is bounded [1, 100]. The `int[101]` array is 420 bytes — fits in a single cache line cluster. This is a textbook example of exploiting bounded key ranges to avoid hash table overhead.

**Real-World Correlation**: **Social network friend recommendations** — counting common interests between users. If users A and B both like items X, Y, Z, the number of "matching pairs" determines recommendation strength.

---

**P4.53** [H] — Minimum Window Subsequence

**Problem**: Given strings `s` and `t`, find the minimum length window of `s` that contains `t` as a subsequence.

**Solution**:

```java
public String minWindow(String s, String t) {
    int m = s.length(), n = t.length();
    int minLen = Integer.MAX_VALUE, start = -1;
    
    int i = 0;
    while (i < m) {
        // Forward pass: find end of window containing t as subsequence
        int j = 0;
        while (i < m && j < n) {
            if (s.charAt(i) == t.charAt(j)) j++;
            i++;
        }
        if (j < n) break;  // t not found as subsequence
        
        int end = i;
        
        // Backward pass: minimize window by finding rightmost start
        j = n - 1;
        i--;
        while (j >= 0) {
            if (s.charAt(i) == t.charAt(j)) j--;
            i--;
        }
        i++;
        
        if (end - i < minLen) {
            minLen = end - i;
            start = i;
        }
        i++;  // advance to find next window
    }
    return start == -1 ? "" : s.substring(start, start + minLen);
}
```

**Complexity**: O(m × n) time, O(1) space.

**JVM Insight**: This is a two-pointer approach without any hash table — pure index manipulation. Each step accesses characters via `s.charAt(i)`, which in JDK 9+ compact strings is a byte array access (for ASCII). The forward and backward passes exploit the structure of subsequence matching. No extra data structures means zero GC pressure — this runs entirely on stack variables. The JIT will likely inline `charAt()` to a direct array bounds check plus byte load.

**Real-World Correlation**: **Log pattern matching** — finding the shortest time window in a log stream that contains a specific sequence of events (e.g., login → permission check → data access). Security audit tools scan for these patterns to detect suspicious activity sequences.

---

**P4.54** [H] — Count of Smaller Numbers After Self

**Problem**: Given an array, for each element count the number of smaller elements to its right.

**Solution** — Modified merge sort (not pure hashing, but commonly paired with hash-based approaches):

```java
public List<Integer> countSmaller(int[] nums) {
    int n = nums.length;
    int[] result = new int[n];
    int[] indices = new int[n];
    for (int i = 0; i < n; i++) indices[i] = i;
    
    mergeSort(nums, indices, result, 0, n - 1);
    
    List<Integer> list = new ArrayList<>();
    for (int r : result) list.add(r);
    return list;
}

private void mergeSort(int[] nums, int[] indices, int[] result, int lo, int hi) {
    if (lo >= hi) return;
    int mid = lo + (hi - lo) / 2;
    mergeSort(nums, indices, result, lo, mid);
    mergeSort(nums, indices, result, mid + 1, hi);
    merge(nums, indices, result, lo, mid, hi);
}

private void merge(int[] nums, int[] indices, int[] result, int lo, int mid, int hi) {
    int[] temp = new int[hi - lo + 1];
    int i = lo, j = mid + 1, k = 0;
    
    while (i <= mid && j <= hi) {
        if (nums[indices[i]] <= nums[indices[j]]) {
            // All elements from j to hi that were already placed are smaller
            result[indices[i]] += j - (mid + 1);
            temp[k++] = indices[i++];
        } else {
            temp[k++] = indices[j++];
        }
    }
    while (i <= mid) {
        result[indices[i]] += j - (mid + 1);
        temp[k++] = indices[i++];
    }
    while (j <= hi) temp[k++] = indices[j++];
    
    System.arraycopy(temp, 0, indices, lo, temp.length);
}
```

**Complexity**: O(n log n) time, O(n) space.

**JVM Insight**: `System.arraycopy(temp, 0, indices, lo, temp.length)` is an intrinsified native method — the JVM compiles it to a CPU-level block copy instruction (`rep movsq` on x86). This is significantly faster than a manual `for` loop copy, especially for large arrays. The merge sort creates O(n log n) temporary `int[]` arrays, but since they are allocated in the TLAB (thread-local allocation buffer), allocation is a pointer bump. They die immediately after each merge, so minor GC collects them cheaply.

**Real-World Correlation**: **Financial analysis** — counting how many subsequent days had lower stock prices than the current day. Inversion counting (the generalized form of this problem) is used in ranking correlation metrics (Kendall tau distance) for recommendation systems.

---

**P4.55** [H] — Subarrays with K Different Integers

**Problem**: Return the number of subarrays with exactly K distinct integers.

**Solution**:

```java
public int subarraysWithKDistinct(int[] nums, int k) {
    return atMostK(nums, k) - atMostK(nums, k - 1);
}

private int atMostK(int[] nums, int k) {
    int[] count = new int[nums.length + 1];
    int distinct = 0, left = 0, result = 0;
    
    for (int right = 0; right < nums.length; right++) {
        if (count[nums[right]]++ == 0) distinct++;
        
        while (distinct > k) {
            if (--count[nums[left]] == 0) distinct--;
            left++;
        }
        result += right - left + 1;
    }
    return result;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: The "exactly K = at most K minus at most (K-1)" technique reduces the exact-count problem to two at-most problems, each solvable with a single sliding window pass. The `count` array is sized to `nums.length + 1` because values are in `[1, nums.length]`. Two passes over the array means two cache-warming iterations — the second pass benefits from data already in L2/L3 cache. Total work is 2n iterations with O(1) work each.

**Real-World Correlation**: **Network traffic diversity monitoring** — counting time windows with exactly K distinct source IPs. Security teams use this to detect distributed attacks (many distinct sources) or targeted attacks (few distinct sources but many requests).

---

### Additional Problems (P4.56 -- P4.70)

---

**P4.56** [E] — Two Sum Less Than K

**Problem**: Given an array and integer K, return the maximum sum of a pair whose sum is less than K. Return -1 if no such pair.

**Solution**:

```java
public int twoSumLessThanK(int[] nums, int k) {
    Arrays.sort(nums);
    int lo = 0, hi = nums.length - 1, maxSum = -1;
    while (lo < hi) {
        int sum = nums[lo] + nums[hi];
        if (sum < k) {
            maxSum = Math.max(maxSum, sum);
            lo++;
        } else {
            hi--;
        }
    }
    return maxSum;
}
```

**Complexity**: O(n log n) time (sort), O(1) space.

**JVM Insight**: `Arrays.sort(int[])` uses Dual-Pivot Quicksort (JDK 7+), which outperforms classic quicksort on modern hardware due to better cache utilization. For small arrays (< 47 elements), it falls back to insertion sort. The two-pointer approach after sorting avoids any hash table — this is one of those problems where sorting + pointers beats hashing in both constant factor and space.

**Real-World Correlation**: **Budget optimization** — finding the most expensive pair of items a customer can buy within a budget. E-commerce recommendation engines use similar constraint-satisfaction techniques.

---

**P4.57** [M] — Subarray Sums Divisible by K

**Problem**: Given an array and K, return the number of subarrays with sum divisible by K.

**Solution**:

```java
public int subarraysDivByK(int[] nums, int k) {
    int[] remainderCount = new int[k];
    remainderCount[0] = 1;  // empty prefix has remainder 0
    int sum = 0, count = 0;
    
    for (int num : nums) {
        sum = ((sum + num) % k + k) % k;  // handle negative remainders
        count += remainderCount[sum];
        remainderCount[sum]++;
    }
    return count;
}
```

**Complexity**: O(n) time, O(k) space.

**JVM Insight**: Using `int[k]` instead of `HashMap<Integer, Integer>` is possible because remainders are in `[0, k-1]` — a bounded range. For k = 5, the array is 36 bytes. A HashMap with 5 entries would use 5 × (32 + 16 + 16) = 320 bytes — nearly 10x more. The `((sum + num) % k + k) % k` pattern handles Java's negative modulo behavior: in Java, `-3 % 5 = -3` (not 2 as in Python). Adding k before the second modulo ensures a non-negative result.

**Real-World Correlation**: **Distributed data partitioning** — determining which shard a data range falls into when sharding by modulo. The remainder calculation is the same as the hash-to-shard mapping in distributed databases.

---

**P4.58** [E] — Unique Email Addresses

**Problem**: Count unique email addresses after applying rules: ignore dots in local name, ignore everything after '+' in local name.

**Solution**:

```java
public int numUniqueEmails(String[] emails) {
    Set<String> unique = new HashSet<>();
    for (String email : emails) {
        String[] parts = email.split("@");
        String local = parts[0].split("\\+")[0].replace(".", "");
        unique.add(local + "@" + parts[1]);
    }
    return unique.size();
}
```

**Complexity**: O(n × L) where L = email length. O(n × L) space.

**JVM Insight**: `String.split()` with a regex pattern compiles the pattern on each call. For `"@"`, HotSpot has a fast-path optimization that detects single-character patterns and avoids regex compilation. For `"\\+"`, it uses the full regex engine (slower). `replace(".", "")` iterates the string creating a new String. Chaining `.split().replace()` creates multiple intermediate String objects per email. For performance-critical email processing, a single-pass character-by-character scanner would avoid all intermediate allocations.

**Real-World Correlation**: **Email canonicalization** — Gmail actually implements these rules. Spam filters normalize email addresses before deduplication. The HashSet deduplication here is exactly what email delivery systems use to prevent sending duplicates.

---

**P4.59** [M] — Find Original Array From Doubled Array

**Problem**: Given an array that was formed by taking an original array and appending each element doubled, recover the original array.

**Solution**:

```java
public int[] findOriginalArray(int[] changed) {
    if (changed.length % 2 != 0) return new int[0];
    
    TreeMap<Integer, Integer> count = new TreeMap<>();
    for (int n : changed) count.merge(n, 1, Integer::sum);
    
    int[] result = new int[changed.length / 2];
    int idx = 0;
    
    for (int key : count.keySet()) {
        int freq = count.getOrDefault(key, 0);
        if (freq == 0) continue;
        
        int doubled = key * 2;
        int doubledFreq = count.getOrDefault(doubled, 0);
        if (doubledFreq < freq) return new int[0];
        
        for (int i = 0; i < freq; i++) result[idx++] = key;
        count.put(key, 0);
        count.put(doubled, doubledFreq - freq);
    }
    return result;
}
```

**Complexity**: O(n log n) time, O(n) space.

**JVM Insight**: `TreeMap` provides sorted iteration, which is essential here — we must process smaller values first to correctly pair them with their doubles. Using `HashMap` would require collecting and sorting keys separately. `TreeMap.keySet()` returns a navigable set backed by the tree, so iteration follows the Red-Black tree's in-order traversal. Each `merge` and `getOrDefault` call is O(log n) for TreeMap vs O(1) for HashMap, but the sorted order is worth the trade-off.

**Real-World Correlation**: **Data deduplication** — reconstructing original data from redundant copies. RAID systems and erasure coding schemes must identify and match original and parity data blocks, similar to matching originals with their doubled counterparts.

---

**P4.60** [M] — Longest Square Streak in an Array

**Problem**: Find the longest sequence where each element is the square of the previous.

**Solution**:

```java
public int longestSquareStreak(int[] nums) {
    Set<Long> set = new HashSet<>();
    for (int n : nums) set.add((long) n);
    
    int maxLen = -1;
    for (int n : nums) {
        long current = n;
        int len = 0;
        while (set.contains(current)) {
            len++;
            if (current > 100_000) break;  // next square would exceed int range
            current = current * current;
        }
        if (len >= 2) maxLen = Math.max(maxLen, len);
    }
    return maxLen;
}
```

**Complexity**: O(n × log(log(max))) time (chain length is logarithmic). O(n) space.

**JVM Insight**: Using `Long` in the HashSet because `current * current` can overflow `int`. The square chain grows super-exponentially: 2 → 4 → 16 → 256 → 65536 → overflow. So the inner while loop runs at most 5-6 times per starting number. The `set.contains(current)` call autoboxes `long` to `Long`. For values <= 127, the Long cache provides the object; for larger values (which is almost always the case here since we are squaring), a new Long object is created per call.

**Real-World Correlation**: **Mathematical sequence detection** — finding exponential growth patterns in financial data (compound returns), population growth curves, or computational complexity analysis.

---

**P4.61** [E] — Valid Sudoku

**Problem**: Determine if a 9x9 Sudoku board is valid (no duplicates in rows, columns, or 3x3 boxes).

**Solution**:

```java
public boolean isValidSudoku(char[][] board) {
    boolean[][] rows = new boolean[9][9];
    boolean[][] cols = new boolean[9][9];
    boolean[][] boxes = new boolean[9][9];
    
    for (int r = 0; r < 9; r++) {
        for (int c = 0; c < 9; c++) {
            if (board[r][c] == '.') continue;
            int val = board[r][c] - '1';
            int box = (r / 3) * 3 + c / 3;
            
            if (rows[r][val] || cols[c][val] || boxes[box][val]) return false;
            rows[r][val] = cols[c][val] = boxes[box][val] = true;
        }
    }
    return true;
}
```

**Complexity**: O(1) time (fixed 81 cells), O(1) space (fixed 3 × 9 × 9 arrays).

**JVM Insight**: Three `boolean[9][9]` arrays replace three `HashSet<Integer>` arrays. Each boolean array is a 2D Java array — actually an array of 9 `boolean[9]` arrays (10 objects total). Each `boolean[9]` is 25 bytes (16 header + 4 length + 9 booleans). Total for all three: 30 objects, ~750 bytes. With `HashSet<Integer>[9]` per dimension, each set has overhead of ~100 bytes when empty, and each added element costs ~48 bytes. The boolean array approach is ~50x more memory-efficient.

**Real-World Correlation**: **Constraint satisfaction problems** — validating database constraints (unique per partition). SQL `UNIQUE` constraints on composite keys work the same way: check uniqueness within defined groups (rows/columns/boxes in Sudoku, partition keys in databases).

---

**P4.62** [M] — Longest Substring with At Least K Repeating Characters

**Problem**: Find the length of the longest substring where every character appears at least k times.

**Solution**:

```java
public int longestSubstring(String s, int k) {
    return helper(s, 0, s.length(), k);
}

private int helper(String s, int start, int end, int k) {
    if (end - start < k) return 0;
    
    int[] count = new int[26];
    for (int i = start; i < end; i++) count[s.charAt(i) - 'a']++;
    
    for (int i = start; i < end; i++) {
        if (count[s.charAt(i) - 'a'] < k) {
            // This character cannot be in any valid substring
            // Split and recurse on both sides
            int j = i + 1;
            while (j < end && count[s.charAt(j) - 'a'] < k) j++;
            return Math.max(helper(s, start, i, k), helper(s, j, end, k));
        }
    }
    return end - start;  // all characters appear >= k times
}
```

**Complexity**: O(26 × n) = O(n) amortized. O(n) stack space.

**JVM Insight**: The recursion depth is at most 26 (each level eliminates at least one character from the alphabet). Each level scans the substring once. Total work: at most 26 × n character comparisons. The `int[26]` array is created per recursion level — 26 levels × 120 bytes = ~3 KB of temporary arrays. These are allocated on the stack via scalar replacement if the JIT's escape analysis determines they do not escape the helper method (likely for small arrays in non-escaping context).

**Real-World Correlation**: **Quality control in manufacturing** — finding the longest production run where every defect type appears at least k times (ensuring statistical significance). The divide-and-conquer approach handles irregular defect distributions.

---

**P4.63** [M] — Maximum Number of Balloons

**Problem**: Given a string, find how many times you can form the word "balloon" from its characters.

**Solution**:

```java
public int maxNumberOfBalloons(String text) {
    int[] count = new int[26];
    for (char c : text.toCharArray()) count[c - 'a']++;
    
    int min = count['b' - 'a'];
    min = Math.min(min, count['a' - 'a']);
    min = Math.min(min, count['l' - 'a'] / 2);
    min = Math.min(min, count['o' - 'a'] / 2);
    min = Math.min(min, count['n' - 'a']);
    return min;
}
```

**Complexity**: O(n) time, O(1) space.

**JVM Insight**: This is a pure frequency counting problem. No HashMap needed. The `/ 2` for 'l' and 'o' accounts for them appearing twice in "balloon". The five `Math.min` calls are likely inlined by the JIT to five `CMOV` (conditional move) instructions — branchless comparison. This is the kind of problem where overthinking the data structure hurts; a flat array and five comparisons is optimal.

**Real-World Correlation**: **Resource scheduling** — determining how many complete tasks can be executed given limited resources. Each resource type (like each letter) has a quota requirement, and the bottleneck resource determines throughput — the theory of constraints in manufacturing.

---

**P4.64** [E] — Count Elements With Strictly Smaller and Greater

**Problem**: Given an array, count elements that have both a strictly smaller and a strictly greater element.

**Solution**:

```java
public int countElements(int[] nums) {
    int min = Integer.MAX_VALUE, max = Integer.MIN_VALUE;
    for (int n : nums) {
        min = Math.min(min, n);
        max = Math.max(max, n);
    }
    
    int count = 0;
    for (int n : nums) {
        if (n > min && n < max) count++;
    }
    return count;
}
```

**Complexity**: O(n) time, O(1) space.

**JVM Insight**: Two passes with zero allocation. The first pass finds min/max using `Math.min`/`Math.max`, which the JIT compiles to branch-free conditional moves. The second pass is a sequential scan with a single comparison per element. Total memory: two stack ints. This demonstrates that sometimes no hashing is needed — understanding the problem structure reveals that only the global min and max matter.

**Real-World Correlation**: **Outlier detection in monitoring** — in a stream of server response times, identifying values that are neither the minimum (best case) nor the maximum (worst case) — the "normal range" observations.

---

**P4.65** [M] — Unique Length-3 Palindromic Subsequences

**Problem**: Count the number of unique palindromic subsequences of length 3.

**Solution**:

```java
public int countPalindromicSubsequence(String s) {
    int[] first = new int[26], last = new int[26];
    Arrays.fill(first, Integer.MAX_VALUE);
    
    for (int i = 0; i < s.length(); i++) {
        int c = s.charAt(i) - 'a';
        first[c] = Math.min(first[c], i);
        last[c] = i;
    }
    
    int count = 0;
    for (int c = 0; c < 26; c++) {
        if (first[c] < last[c]) {
            // Count distinct characters between first[c] and last[c]
            Set<Character> between = new HashSet<>();
            for (int i = first[c] + 1; i < last[c]; i++) {
                between.add(s.charAt(i));
            }
            count += between.size();
        }
    }
    return count;
}
```

**Complexity**: O(26 × n) = O(n) time, O(26) space.

**JVM Insight**: For each of the 26 possible outer characters, we find the first and last occurrence, then count distinct characters between them. The inner `HashSet` can be replaced with a `boolean[26]` array (or even a single `int` used as a 26-bit bitmask) for maximum efficiency. With a bitmask: `mask |= (1 << (c - 'a'))` to set, `Integer.bitCount(mask)` to count — no heap allocation at all.

**Real-World Correlation**: **Sequence motif counting in bioinformatics** — counting distinct 3-character palindromic patterns in DNA sequences. Palindromic sequences in DNA (reading the same on both strands) are biologically significant as restriction enzyme recognition sites.

---

**P4.66** [H] — Number of Atoms

**Problem**: Parse a chemical formula and return atom counts sorted by name.

**Solution**:

```java
public String countOfAtoms(String formula) {
    Deque<Map<String, Integer>> stack = new ArrayDeque<>();
    stack.push(new TreeMap<>());
    int i = 0, n = formula.length();
    
    while (i < n) {
        if (formula.charAt(i) == '(') {
            stack.push(new TreeMap<>());
            i++;
        } else if (formula.charAt(i) == ')') {
            i++;
            int num = 0;
            while (i < n && Character.isDigit(formula.charAt(i))) {
                num = num * 10 + (formula.charAt(i++) - '0');
            }
            if (num == 0) num = 1;
            Map<String, Integer> top = stack.pop();
            Map<String, Integer> curr = stack.peek();
            for (var entry : top.entrySet()) {
                curr.merge(entry.getKey(), entry.getValue() * num, Integer::sum);
            }
        } else {
            // Parse element name
            int start = i++;
            while (i < n && Character.isLowerCase(formula.charAt(i))) i++;
            String elem = formula.substring(start, i);
            // Parse count
            int num = 0;
            while (i < n && Character.isDigit(formula.charAt(i))) {
                num = num * 10 + (formula.charAt(i++) - '0');
            }
            if (num == 0) num = 1;
            stack.peek().merge(elem, num, Integer::sum);
        }
    }
    
    StringBuilder sb = new StringBuilder();
    for (var entry : stack.peek().entrySet()) {
        sb.append(entry.getKey());
        if (entry.getValue() > 1) sb.append(entry.getValue());
    }
    return sb.toString();
}
```

**Complexity**: O(n^2) worst case (nested parentheses), O(n) typical. O(n) space.

**JVM Insight**: Using `TreeMap` on the stack gives sorted output for free. `ArrayDeque` as the stack avoids `Stack`'s synchronization overhead (Stack extends Vector, which is synchronized). The `merge` method with `Integer::sum` handles both new elements (initial count) and existing elements (add to count) in a single call. Each parenthesis level creates a new TreeMap on the heap — for deeply nested formulas, this could create many small TreeMaps, but typical chemical formulas have at most 3-4 nesting levels.

**Real-World Correlation**: **Chemical informatics** — this is a real problem in cheminformatics. RDKit and Open Babel parse SMILES/InChI chemical notations using similar stack-based parsers with atom counting.

---

**P4.67** [M] — Design a Food Rating System

**Problem**: Support `changeRating(food, newRating)` and `highestRated(cuisine)`.

**Solution**:

```java
class FoodRatings {
    private Map<String, String> foodToCuisine;
    private Map<String, Integer> foodToRating;
    private Map<String, TreeSet<String>> cuisineToFoods;
    
    public FoodRatings(String[] foods, String[] cuisines, int[] ratings) {
        foodToCuisine = new HashMap<>();
        foodToRating = new HashMap<>();
        cuisineToFoods = new HashMap<>();
        
        for (int i = 0; i < foods.length; i++) {
            foodToCuisine.put(foods[i], cuisines[i]);
            foodToRating.put(foods[i], ratings[i]);
            cuisineToFoods.computeIfAbsent(cuisines[i], k -> new TreeSet<>((a, b) -> {
                int cmp = foodToRating.get(b) - foodToRating.get(a);
                return cmp != 0 ? cmp : a.compareTo(b);
            })).add(foods[i]);
        }
    }
    
    public void changeRating(String food, int newRating) {
        String cuisine = foodToCuisine.get(food);
        TreeSet<String> set = cuisineToFoods.get(cuisine);
        set.remove(food);
        foodToRating.put(food, newRating);
        set.add(food);
    }
    
    public String highestRated(String cuisine) {
        return cuisineToFoods.get(cuisine).first();
    }
}
```

**Complexity**: `changeRating`: O(log n). `highestRated`: O(log n).

**JVM Insight**: The `TreeSet` comparator captures `foodToRating` by reference, creating a closure. The comparator must be consistent with equals — here, two foods with the same rating are disambiguated by name (lexicographic order). The `remove` + `add` in `changeRating` is necessary because TreeSet orders by the comparator, and changing the rating changes the ordering key. You must remove BEFORE changing the rating, then add AFTER, because TreeSet uses the comparator for both lookup and insertion.

**Real-World Correlation**: **Restaurant recommendation systems** — Yelp and Google Maps maintain cuisine-indexed collections of restaurants sorted by rating, supporting real-time rating updates and "top rated" queries.

---

**P4.68** [E] — Path Crossing

**Problem**: Given a string path of 'N', 'S', 'E', 'W' moves, determine if the path crosses itself.

**Solution**:

```java
public boolean isPathCrossing(String path) {
    Set<Long> visited = new HashSet<>();
    int x = 0, y = 0;
    visited.add(encode(x, y));
    
    for (char c : path.toCharArray()) {
        switch (c) {
            case 'N' -> y++;
            case 'S' -> y--;
            case 'E' -> x++;
            case 'W' -> x--;
        }
        if (!visited.add(encode(x, y))) return true;
    }
    return false;
}

private long encode(int x, int y) {
    return ((long) x << 32) | (y & 0xFFFFFFFFL);
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: Encoding (x, y) as a single `long` avoids creating a `new int[]{x, y}` or `new Point(x, y)` for each position. The encoding packs two 32-bit ints into one 64-bit long using bit shifting. `HashSet<Long>` autoboxes each long — for values outside [-128, 127] (which is almost always), each add creates a new Long object (24 bytes). An alternative is encoding as a String (`x + "," + y`) but that is slower due to string concatenation and longer hash computation.

**Real-World Correlation**: **Robot path planning** — detecting when a robot revisits a position (which may indicate a stuck state or infinite loop). Industrial robot controllers use position hashing to detect cycles in exploration algorithms.

---

**P4.69** [M] — Equal Row and Column Pairs

**Problem**: Given an n x n matrix, count pairs where row i equals column j.

**Solution**:

```java
public int equalPairs(int[][] grid) {
    int n = grid.length;
    Map<String, Integer> rowMap = new HashMap<>();
    
    for (int[] row : grid) {
        String key = Arrays.toString(row);
        rowMap.merge(key, 1, Integer::sum);
    }
    
    int count = 0;
    for (int j = 0; j < n; j++) {
        StringBuilder col = new StringBuilder();
        col.append('[');
        for (int i = 0; i < n; i++) {
            if (i > 0) col.append(", ");
            col.append(grid[i][j]);
        }
        col.append(']');
        count += rowMap.getOrDefault(col.toString(), 0);
    }
    return count;
}
```

**Complexity**: O(n^2) time, O(n^2) space.

**JVM Insight**: `Arrays.toString(row)` creates a canonical string representation of each row. We use the same format for columns so that `String.equals()` correctly identifies matches. An alternative is using `List<Integer>` as keys (which implements `equals` and `hashCode` based on content), but that autoboxes every int. The string approach creates one String per row/column, while the list approach creates n Integer objects per row/column. For large matrices, the string approach uses less memory because the string representation shares the representation compactly.

**Real-World Correlation**: **Matrix symmetry analysis** — checking which rows and columns of a correlation matrix are identical, indicating perfectly correlated features. Feature selection algorithms in machine learning use similar comparisons to identify and eliminate redundant features.

---

**P4.70** [H] — Maximum Sum of 3 Non-Overlapping Subarrays

**Problem**: Given array and integer k, find three non-overlapping subarrays of length k with maximum sum. Return their starting indices.

**Solution**:

```java
public int[] maxSumOfThreeSubarrays(int[] nums, int k) {
    int n = nums.length;
    int[] sums = new int[n - k + 1];
    
    // Compute window sums
    int windowSum = 0;
    for (int i = 0; i < k; i++) windowSum += nums[i];
    sums[0] = windowSum;
    for (int i = 1; i <= n - k; i++) {
        windowSum += nums[i + k - 1] - nums[i - 1];
        sums[i] = windowSum;
    }
    
    // Left[i] = index of max sum subarray in sums[0..i]
    int[] left = new int[sums.length];
    int bestIdx = 0;
    for (int i = 0; i < sums.length; i++) {
        if (sums[i] > sums[bestIdx]) bestIdx = i;
        left[i] = bestIdx;
    }
    
    // Right[i] = index of max sum subarray in sums[i..end]
    int[] right = new int[sums.length];
    bestIdx = sums.length - 1;
    for (int i = sums.length - 1; i >= 0; i--) {
        if (sums[i] >= sums[bestIdx]) bestIdx = i;
        right[i] = bestIdx;
    }
    
    // Try all possible middle subarrays
    int[] result = new int[3];
    int maxTotal = 0;
    for (int mid = k; mid <= n - 2 * k; mid++) {
        int l = left[mid - k], r = right[mid + k];
        int total = sums[l] + sums[mid] + sums[r];
        if (total > maxTotal) {
            maxTotal = total;
            result = new int[]{l, mid, r};
        }
    }
    return result;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: Four linear passes over arrays — extremely cache-friendly. No hash tables in this solution, but the preprocessing pattern (precompute left-best and right-best) is a fundamental technique that pairs well with hashing in other contexts. The `sums`, `left`, and `right` arrays are three contiguous `int[]` allocations. On a typical JVM with TLAB allocation, these three are likely contiguous in memory (allocated sequentially in the same TLAB), giving excellent spatial locality.

**Real-World Correlation**: **Financial portfolio optimization** — selecting three non-overlapping investment periods with maximum returns. Trading systems use similar interval optimization algorithms to identify the best entry/exit points across multiple trades.

---

## Key Takeaways

1. **The hash perturbation `(h = key.hashCode()) ^ (h >>> 16)` is not optional.** Without it, only the bottom log2(capacity) bits of the hash code determine the bucket. XOR-folding the top bits into the bottom bits ensures all 32 bits contribute to the bucket index, even when the table is small.

2. **HashMap capacity is always a power of 2 for three reasons.** First, `(n-1) & hash` is a single AND instruction, faster than modulo. Second, the resize trick (`(e.hash & oldCap) == 0`) splits entries by checking a single bit, avoiding index recomputation. Third, `tableSizeFor()` rounds up to the next power of 2 using bit manipulation, guaranteeing the invariant is maintained.

3. **Treeification at threshold 8 is a safety net, not a common case.** Under a random hash function with load factor 0.75, the probability of 8 entries in one bucket is 0.000006%. Treeification converts O(n) chain traversal to O(log n) Red-Black tree search, defending against hash collision attacks. The hysteresis gap (treeify at 8, untreeify at 6) prevents oscillation.

4. **HashSet is literally `HashMap<E, PRESENT>`.** Every HashSet operation delegates to the backing HashMap. This wastes 4 bytes per element (the PRESENT reference) but reuses all HashMap optimizations. Know this when asked "how does HashSet work" in interviews.

5. **LinkedHashMap adds doubly-linked list pointers to each entry for order maintenance.** With `accessOrder=true`, it becomes an LRU cache in 5 lines. The `removeEldestEntry()` callback is the eviction hook. This is the simplest LRU implementation in Java — but not thread-safe.

6. **The `int[]` array is the best hash map for bounded integer keys.** When key ranges are small and known (character frequencies, digit counts, small enumerations), a flat array beats HashMap in every dimension: 10x less memory, 10x faster access, zero GC pressure, perfect cache behavior. Use HashMap only when key space is large or unbounded.

7. **Prefix sum + HashMap is the universal technique for subarray problems.** "Find subarrays with target sum/property" almost always reduces to: compute running prefix, store prefixes in HashMap, check if `current_prefix - target` exists. This pattern solves subarray sum equals K, longest subarray with equal 0s and 1s, subarrays divisible by K, and many more.

8. **The "array as hash map" trick uses the input array as its own hash table.** When elements are in range [1, n] and the array has n slots, mapping value `x` to index `x-1` (with sign-flipping for visited marking) gives O(1) space solutions. This technique solves first missing positive, find all duplicates, and find all disappeared numbers.

9. **Open addressing (linear probing) beats separate chaining for cache performance.** Java's HashMap uses chaining (linked list/tree per bucket), which causes pointer chasing. IdentityHashMap uses linear probing on a flat array. For primitive-key maps, open addressing with flat arrays (like Eclipse Collections) is 5-10x faster and uses 3-5x less memory than standard HashMap.

10. **Consistent hashing is the bridge between single-machine hash tables and distributed systems.** Standard `hash % N` breaks when N changes (nearly all keys remap). Consistent hashing with virtual nodes ensures only `K/N` keys move when a server is added or removed. This is the foundation of every distributed cache and database partition scheme.

---

[Previous: Chapter 3 -- Dynamic Arrays & Lists](03-dynamic-arrays-and-lists.md) | [Next: Chapter 5 -- Trees & Sorted Structures](05-trees-and-sorted-structures.md)
