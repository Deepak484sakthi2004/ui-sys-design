# Chapter 8: Specialized JDK Collections

## The Tools Nobody Teaches, That Solve Problems Nothing Else Can

Every Java developer knows `HashMap`, `ArrayList`, `TreeMap`. You have used them ten thousand times. But the JDK ships a set of collections that most engineers never touch — collections designed for specific problem domains where the general-purpose implementations are wasteful, incorrect, or fundamentally the wrong abstraction.

`WeakHashMap` cooperates with the garbage collector to evict entries automatically. `IdentityHashMap` abandons the `.equals()` contract entirely and uses raw object identity. `EnumMap` exploits the finite, ordinal-indexed nature of enums to deliver guaranteed O(1) with zero hashing. `EnumSet` packs up to 64 elements into a single `long` — one machine word, set operations in a single CPU cycle. And `BitSet` gives you a million boolean flags in 125 KB, with bulk bitwise operations that run at memory bandwidth.

These are not curiosities. `WeakHashMap` is what makes ClassLoader metadata caching work without memory leaks. `IdentityHashMap` is what makes Java serialization detect circular references. `EnumSet` is what makes permission systems fit in a CPU register. And `BitSet` is the backbone of Bloom filters in Cassandra, bitmap indexes in databases, and the Sieve of Eratosthenes that generates every prime table you have ever used.

If you have ever written `new HashSet<MyEnum>()` when `EnumSet.noneOf(MyEnum.class)` was the correct call, you wasted 256x the memory. If you have ever cached ClassLoader metadata in a `HashMap` and wondered why the application leaked memory after hot-redeploy, you needed `WeakHashMap`. If you have ever tracked object identity during a graph transformation using `.equals()` and gotten wrong results because two logically-equal but physically-distinct objects collapsed, you needed `IdentityHashMap`.

This chapter takes you inside every one of these collections — OpenJDK source, memory layout, CPU instruction level — and then puts them to work in 25 problems that test the bit manipulation and specialized collection skills that senior interviews demand.

---

## 8.1 WeakHashMap: The GC-Cooperating Cache

### The Core Idea

A `WeakHashMap<K, V>` is a hash map where keys are held via `WeakReference`. When no strong references to a key exist anywhere in the application, the garbage collector is free to reclaim that key. Once the key is reclaimed, the corresponding entry is silently removed from the map.

This is fundamentally different from a normal `HashMap`. A `HashMap` holds strong references to its keys — as long as the map exists, every key it contains is reachable and will never be garbage collected. A `WeakHashMap` says: "I am interested in this key only as long as someone else cares about it too."

### WeakReference Mechanics

To understand `WeakHashMap`, you must first understand Java's reference types:

```
Strong Reference:   Object obj = new Object();
                    GC will NEVER collect obj while this reference exists.

Weak Reference:     WeakReference<Object> weak = new WeakReference<>(obj);
                    GC CAN collect obj if only weak references remain.
                    After collection, weak.get() returns null.

Soft Reference:     SoftReference<Object> soft = new SoftReference<>(obj);
                    GC will collect only under memory pressure.
                    Used for memory-sensitive caches.

Phantom Reference:  PhantomReference<Object> phantom = new PhantomReference<>(obj, queue);
                    get() always returns null. Used for cleanup actions after finalization.
```

The key insight: a `WeakReference` does not prevent garbage collection. If the only path from GC roots to an object goes through weak references, the object is considered *weakly reachable* and eligible for collection.

### Internal Structure

Let me walk through the OpenJDK source. A `WeakHashMap` has:

```java
// OpenJDK WeakHashMap.java (simplified)
public class WeakHashMap<K, V> extends AbstractMap<K, V> {
    // The hash table — an array of Entry chains (separate chaining)
    Entry<K, V>[] table;

    // The reference queue — GC enqueues dead weak references here
    private final ReferenceQueue<Object> queue = new ReferenceQueue<>();

    private int size;
    private int threshold;
    private final float loadFactor;

    // THE CRITICAL DETAIL: Entry extends WeakReference<Object>
    // The entry IS the weak reference to the key.
    private static class Entry<K, V> extends WeakReference<Object>
                                     implements Map.Entry<K, V> {
        V value;          // STRONGLY held
        final int hash;
        Entry<K, V> next;

        Entry(Object key, V value, ReferenceQueue<Object> queue,
              int hash, Entry<K, V> next) {
            super(key, queue);  // WeakReference to key, registered with queue
            this.value = value;
            this.hash = hash;
            this.next = next;
        }
    }
}
```

The memory model is crucial:

```
┌─────────────────────────────────────────────────────┐
│                  WeakHashMap                          │
│                                                      │
│  Entry[] table ──────┐                               │
│  ReferenceQueue queue │                              │
│                       ▼                              │
│  ┌───────────────────────────────────────┐           │
│  │ [0] → null                             │           │
│  │ [1] → Entry ─── weak ref ···> Key obj │ ← weak   │
│  │         │                              │           │
│  │         └── value ════════> Value obj  │ ← STRONG │
│  │ [2] → null                             │           │
│  │ [3] → Entry ─── weak ref ···> Key obj │           │
│  │         │                              │           │
│  │         └── value ════════> Value obj  │           │
│  └───────────────────────────────────────┘           │
│                                                      │
│  Key: ···> = weak reference (GC can break this)      │
│       ══> = strong reference (GC cannot break this)  │
└─────────────────────────────────────────────────────┘
```

### The expungeStaleEntries() Mechanism

When the GC collects a weakly-reachable key, it enqueues the corresponding `WeakReference` (which is the `Entry` itself) into the `ReferenceQueue`. But the entry is still sitting in the hash table. It needs to be removed.

This cleanup happens in `expungeStaleEntries()`, which is called at the start of every `get()`, `put()`, `size()`, and `resize()` operation:

```java
// OpenJDK WeakHashMap.java
private void expungeStaleEntries() {
    // Poll the reference queue for entries whose keys have been GC'd
    for (Object x; (x = queue.poll()) != null; ) {
        synchronized (queue) {
            @SuppressWarnings("unchecked")
            Entry<K, V> e = (Entry<K, V>) x;
            int i = indexFor(e.hash, table.length);

            // Walk the chain at table[i] and remove this entry
            Entry<K, V> prev = table[i];
            Entry<K, V> p = prev;
            while (p != null) {
                Entry<K, V> next = p.next;
                if (p == e) {
                    if (prev == e)
                        table[i] = next;
                    else
                        prev.next = next;
                    // Clear the value reference to help GC
                    e.value = null;
                    size--;
                    break;
                }
                prev = p;
                p = next;
            }
        }
    }
}
```

This is a lazy cleanup model. Dead entries linger until the next map operation triggers `expungeStaleEntries()`. If you stop accessing the map, dead entries accumulate. This is by design — there is no background thread, no periodic sweep. The cost is amortized across map operations.

### The Value-References-Key Trap

This is the most common pitfall with `WeakHashMap`, and I have seen it cause production memory leaks:

```java
// DANGEROUS: value holds a strong reference to the key
Object key = new Object();
WeakHashMap<Object, Object[]> cache = new WeakHashMap<>();
cache.put(key, new Object[]{key});  // value references key!

key = null;  // Drop our strong reference to the key

System.gc();
// The entry is NEVER collected!
// Why? The value (Object[]{key}) is strongly held by the Entry.
// The value contains a strong reference to the key.
// So there is still a strong reference chain: Entry → value → key.
// The key is strongly reachable through the value. Not weakly reachable.
```

```
Entry ─── weak ref ···> Key obj ←──────┐
  │                                      │
  └── value ════════> Object[] ════════┘
                       (strong ref back to key!)

The strong path Entry → value → Object[] → Key keeps Key alive.
The weak reference is irrelevant because a strong path exists.
```

**The fix**: If the value must reference the key, wrap the value in a `WeakReference` too, or restructure so the value does not hold the key.

```java
// Safe: value does not reference key
cache.put(key, computeValueWithoutKeyRef(key));

// Or: use Guava's Cache with weakKeys() AND weakValues()
Cache<Object, Object> cache = CacheBuilder.newBuilder()
    .weakKeys()
    .weakValues()
    .build();
```

### Use Cases

**ClassLoader metadata caching**: When a ClassLoader is garbage collected (after hot-redeploy in an application server), all metadata cached with that ClassLoader as key should be evicted. `WeakHashMap<ClassLoader, Metadata>` handles this automatically.

**ThreadLocal cleanup**: `ThreadLocal` internally uses a structure similar to `WeakHashMap` — entries use `WeakReference` to the `ThreadLocal` key so that when a `ThreadLocal` variable goes out of scope, the entry can be cleaned up. The same value-references-key trap applies here and is a well-known source of ThreadLocal memory leaks.

**IntelliJ IDEA's caching layer**: IDE internals cache PSI (Program Structure Interface) elements using soft and weak references so that memory-intensive caches are evicted under pressure without explicit invalidation logic.

### WeakHashMap vs Guava Cache

Guava's `CacheBuilder` provides a more production-grade solution:

```java
// Guava: more control, explicit eviction policies, statistics
Cache<Key, Value> cache = CacheBuilder.newBuilder()
    .weakKeys()                    // same as WeakHashMap key behavior
    .weakValues()                  // ALSO weak values (WeakHashMap holds values strongly)
    .maximumSize(10_000)           // size-based eviction
    .expireAfterAccess(10, MINUTES) // time-based eviction
    .recordStats()                 // hit rate, eviction count, etc.
    .build();
```

`WeakHashMap` gives you only one policy: "evict when key is unreachable." Guava gives you weak keys, weak values, soft values, size-based eviction, time-based eviction, and explicit invalidation — all composable. For production caching, Guava or Caffeine is almost always the right choice. `WeakHashMap` is right when you specifically want GC-driven eviction with no other policy.

---

## 8.2 IdentityHashMap: When == Is the Only Correct Comparison

### Why .equals() Is Sometimes Wrong

Consider serializing an object graph with circular references:

```java
class Node {
    String name;
    Node next;
}

Node a = new Node("A");
Node b = new Node("A");  // Same name as a, so a.equals(b) might be true
a.next = b;
b.next = a;  // circular reference

// If the serializer uses .equals() to track "already visited":
Set<Node> visited = new HashSet<>();  // Uses .equals()
// If a.equals(b) is true, the serializer thinks b is already serialized
// when it has not been. The object graph is corrupted.

// Correct: use == to track object identity
Set<Node> visited = Collections.newSetFromMap(new IdentityHashMap<>());
// Now a and b are distinct entries even if a.equals(b) is true.
```

An `IdentityHashMap` uses `==` (reference equality) instead of `.equals()`, and `System.identityHashCode()` instead of `.hashCode()`. Two keys are considered equal if and only if they are the same object in memory.

### Internal Structure: Linear Probing on a Flat Array

This is where `IdentityHashMap` gets interesting. Unlike `HashMap` which uses separate chaining (linked list / tree of nodes per bucket), `IdentityHashMap` uses **open addressing with linear probing** on a single flat `Object[]` array:

```java
// OpenJDK IdentityHashMap.java (simplified)
public class IdentityHashMap<K, V> extends AbstractMap<K, V> {
    // Single flat array: keys and values interleaved
    // table[2*i] = key, table[2*i + 1] = value
    transient Object[] table;
    int size;

    // Sentinel for null key
    static final Object NULL_KEY = new Object();
}
```

The layout is:

```
table[0]  = key_0       table[1]  = value_0
table[2]  = key_1       table[3]  = value_1
table[4]  = key_2       table[5]  = value_2
...
table[2i] = key_i       table[2i+1] = value_i
```

Keys and values are interleaved in a single contiguous array. No `Node` objects, no linked lists, no trees. Just a flat array.

### Hash Function and Probing

```java
// OpenJDK IdentityHashMap.java
private static int hash(Object x, int length) {
    int h = System.identityHashCode(x);
    // Multiply by a large odd number for better distribution
    // then mask to table size (which is always a power of 2)
    return ((h << 1) - (h << 8) - (h >>> 14)) & (length - 1);
}
```

The probe sequence is:

```java
// Looking up key k:
int i = hash(k, table.length);
while (true) {
    Object item = table[i];
    if (item == k)          return table[i + 1];  // found: return value
    if (item == null)       return null;           // not found: empty slot
    i = (i + 2) % table.length;                   // probe next pair (step by 2)
}
```

Step by 2 because each key-value pair occupies two consecutive slots. The table is kept at most 2/3 full (load factor ~0.67) to keep probe chains short.

### Why Open Addressing Works Here

`HashMap` uses separate chaining because user-defined `hashCode()` can be terrible — clustered, all-zeros, pathological. With bad hash functions, open addressing degrades to O(n) per operation as clusters grow.

`IdentityHashMap` does not have this problem. `System.identityHashCode()` is generated by the JVM — it is essentially a randomized hash based on the object's memory address at first use (or a thread-local PRNG, depending on the JVM flag `-XX:hashCode=`). The distribution is excellent because users cannot mess it up. This makes open addressing viable and cache-friendly.

### Memory Comparison

```
HashMap<K,V> with N entries:
  HashMap object:        48 bytes
  Node[] table:          16 + capacity * 4 bytes (references)
  N Node objects:        N * 32 bytes (header + hash + key + value + next)
  Total overhead:        ~36 bytes per entry (excluding keys and values)

IdentityHashMap<K,V> with N entries, table at 2/3 capacity:
  IdentityHashMap object: ~40 bytes
  Object[] table:         16 + 3N * 2 * 4 bytes (3N slots for keys + 3N for values at 2/3 load)
  No Node objects.
  Total overhead:         ~24 bytes per entry (just the two array slots per entry)
  Saves ~12 bytes per entry — no Node allocation at all.
```

### Use Cases

**Java serialization**: `ObjectOutputStream` uses an internal identity-based map to track which objects have already been serialized. When it encounters the same object again (by `==`), it writes a back-reference instead of serializing it again. This is how circular references are handled.

**Dependency injection frameworks**: Spring's bean container tracks bean instances by identity. Two beans that are `.equals()` but not `==` are distinct beans.

**Topology-preserving graph transformations**: When you deep-copy a graph, you need to map each original node to its copy by identity, not by equals. If two original nodes are `.equals()`, they still need separate copies.

**JVM internal use (ClassValue)**: `ClassValue` uses identity-based lookup keyed on `Class` objects. Since `Class` objects are singletons per ClassLoader, identity comparison is both correct and fast.

### Contract Violation Warning

`IdentityHashMap` deliberately violates the `Map` contract. The `Map` interface specifies that key comparison uses `.equals()`. `IdentityHashMap` uses `==`. This means:

```java
IdentityHashMap<String, Integer> map = new IdentityHashMap<>();
map.put(new String("hello"), 1);
map.put(new String("hello"), 2);
map.size();  // Returns 2! Two distinct String objects, even though equals() is true.

// But with interned strings:
map.put("hello", 1);       // string literal, interned
map.put("hello", 2);       // same interned reference
map.size();  // Returns 1.  Same object.
```

Never use `IdentityHashMap` as a general-purpose map. It is a specialized tool for when object identity is the semantically correct comparison.

---

## 8.3 EnumMap: O(1) Without Hashing

### The Insight: Enums Are Integers in Disguise

Every Java enum constant has an `ordinal()` — a sequential integer starting from 0. If an enum has N constants, ordinals range from 0 to N-1. This means we can use the ordinal as a direct array index. No hashing. No collision resolution. No probing. Just `array[key.ordinal()]`.

```java
// OpenJDK EnumMap.java (simplified)
public class EnumMap<K extends Enum<K>, V> extends AbstractMap<K, V> {
    // The enum class — needed to know the universe of keys
    private final Class<K> keyType;

    // All enum constants, cached from keyType.getEnumConstants()
    private transient K[] keyUniverse;

    // Values array — indexed by ordinal
    // vals[i] is the value for the enum constant with ordinal i
    private transient Object[] vals;

    // Track which entries are present (since null is a valid value)
    private transient int size;

    // Sentinel to distinguish "key mapped to null" from "key absent"
    private static final Object NULL = new Object();
}
```

### Operations

```java
// put(K key, V value)
public V put(K key, V value) {
    int index = key.ordinal();
    Object oldValue = vals[index];
    vals[index] = maskNull(value);  // wrap null as NULL sentinel
    if (oldValue == null) size++;   // was absent, now present
    return unmaskNull(oldValue);
}

// get(Object key)
public V get(Object key) {
    if (isValidKey(key)) {
        Object val = vals[((Enum<?>) key).ordinal()];
        return unmaskNull(val);
    }
    return null;
}
```

That is it. No hash computation, no modulo, no probe chain, no tree balancing. One array index lookup. Guaranteed O(1), not amortized O(1), not expected O(1) — *actual* O(1) with a tiny constant factor.

### Memory Layout

```
EnumMap for enum with 5 constants:

Object[] vals = new Object[5];

┌────────┬────────┬────────┬────────┬────────┐
│ vals[0]│ vals[1]│ vals[2]│ vals[3]│ vals[4]│
│ = ref  │ = ref  │ = null │ = ref  │ = null │
│ (present) (present) (absent) (present) (absent)
└────────┴────────┴────────┴────────┴────────┘

Total memory: 16 (array header) + 5 * 4 (refs) + 4 (padding) = 40 bytes
Plus the EnumMap object itself: ~48 bytes
Total: ~88 bytes for up to 5 entries

Compare HashMap<MyEnum, V> with 3 entries:
  HashMap object: 48 bytes
  Node[] table (minimum 16 slots): 80 bytes
  3 Node objects: 96 bytes
  Total: 224 bytes — 2.5x more
```

### Iteration Order

`EnumMap` iterates in **natural enum declaration order** (ordinal order). This is guaranteed, unlike `HashMap` which iterates in hash-bucket order (effectively random). This makes `EnumMap` suitable for scenarios where enum ordering matters — state machines, configuration priority, HTTP method precedence.

### Performance vs HashMap

For enum keys, `EnumMap` wins on every dimension:

```
Operation    EnumMap                      HashMap
─────────────────────────────────────────────────────
put          array[ordinal] = val         hash → bucket → chain/tree traversal
get          val = array[ordinal]         hash → bucket → chain/tree traversal
             1 array access               hash computation + array access + equals checks
remove       array[ordinal] = null        hash → bucket → chain/tree traversal + unlink
memory       O(enum_count) always         O(entries) with ~36 bytes per entry overhead
iteration    linear scan of vals[]        scan sparse Node[] table + follow chains
```

There is no reason to use `HashMap<MyEnum, V>` when `EnumMap<MyEnum, V>` exists. Ever.

---

## 8.4 EnumSet: A Set in a Machine Word

### RegularEnumSet: The Single-Long Implementation

For enums with 64 or fewer constants (which covers the vast majority of enums in practice), `EnumSet` stores the entire set in a single `long` field called `elements`:

```java
// OpenJDK RegularEnumSet.java (simplified)
class RegularEnumSet<E extends Enum<E>> extends EnumSet<E> {
    // The entire set is this one 64-bit word
    private long elements = 0L;

    // add: set the bit at the ordinal position
    void addUnchecked(E e) {
        elements |= (1L << e.ordinal());
    }

    // contains: check if the bit is set
    public boolean contains(Object e) {
        if (e == null) return false;
        int eOrdinal = ((Enum<?>) e).ordinal();
        return (elements & (1L << eOrdinal)) != 0;
    }

    // remove: clear the bit
    public boolean remove(Object e) {
        if (e == null) return false;
        int eOrdinal = ((Enum<?>) e).ordinal();
        long oldElements = elements;
        elements &= ~(1L << eOrdinal);
        return elements != oldElements;
    }

    // size: count set bits — this maps to a SINGLE CPU instruction (POPCNT)
    public int size() {
        return Long.bitCount(elements);
    }
}
```

```
Enum with 8 constants: A(0), B(1), C(2), D(3), E(4), F(5), G(6), H(7)

EnumSet containing {A, C, E, G}:
elements = 0b01010101 = 0x55

Bit position:  7 6 5 4 3 2 1 0
               0 1 0 1 0 1 0 1
               H G F E D C B A
               ↑   ↑   ↑   ↑
               G   E   C   A   ← these are in the set
```

### Set Operations in One CPU Instruction

This is where `EnumSet` becomes extraordinary:

```java
// Union (addAll): OR
setA.addAll(setB);        // a.elements |= b.elements;  — ONE instruction

// Intersection (retainAll): AND
setA.retainAll(setB);     // a.elements &= b.elements;  — ONE instruction

// Difference (removeAll): AND NOT
setA.removeAll(setB);     // a.elements &= ~b.elements; — TWO instructions

// Symmetric difference: XOR
// (Not directly in the API but trivially computed)
long symmetricDiff = a.elements ^ b.elements;

// Complement (all elements NOT in the set):
EnumSet.complementOf(setA);  // ~a.elements & universe;
```

Each of these operations executes in exactly one or two CPU cycles. No iteration, no per-element comparison. A union of two sets with 64 elements each is a single bitwise OR on two `long` values.

### JumboEnumSet: For Large Enums

For enums with more than 64 constants, `JumboEnumSet` uses a `long[]` array:

```java
class JumboEnumSet<E extends Enum<E>> extends EnumSet<E> {
    private long[] elements;

    // add: find the right word, set the bit
    void addUnchecked(E e) {
        elements[e.ordinal() >>> 6] |= (1L << e.ordinal());
    }

    // size: sum of bitCount across all words
    public int size() {
        int sum = 0;
        for (long word : elements) sum += Long.bitCount(word);
        return sum;
    }
}
```

`ordinal() >>> 6` divides by 64 to find the word index. `1L << e.ordinal()` auto-masks to the lower 6 bits of the ordinal for the bit position within the word (Java shift operators use only the lower 6 bits of the right operand for `long` shifts).

### Memory: The Killer Advantage

```
For an enum with 64 constants:

EnumSet (RegularEnumSet):
  Object header:    16 bytes
  long elements:     8 bytes
  Total:            24 bytes (for up to 64 elements!)
  Per element:       0.375 bytes (3 bits effective)

HashSet<MyEnum>:
  HashSet object:    48 bytes
  HashMap inside:    48 bytes
  Node[] table:     16 + 64*4 = 272 bytes (at minimum)
  64 Node objects:  64 * 32 = 2,048 bytes
  Total:            ~2,416 bytes
  Per element:       ~37.75 bytes

Ratio: EnumSet is ~100x more memory efficient.
```

For 64 elements, `EnumSet` uses 24 bytes. `HashSet<MyEnum>` uses ~2,416 bytes. That is a factor of 100. And `EnumSet` operations are single CPU instructions vs. hash-compute-probe-compare chains in `HashSet`.

### Factory Methods

`EnumSet` has no public constructor. You use factory methods:

```java
EnumSet.noneOf(Day.class);                    // empty set
EnumSet.allOf(Day.class);                     // all constants
EnumSet.of(Day.MONDAY, Day.FRIDAY);           // specific elements
EnumSet.range(Day.MONDAY, Day.FRIDAY);        // ordinal range [MON, FRI]
EnumSet.complementOf(weekdays);               // everything NOT in weekdays
EnumSet.copyOf(existingCollection);           // copy from any Collection<E>
```

The factory inspects the enum's constant count and returns either `RegularEnumSet` (<=64) or `JumboEnumSet` (>64). You never see the implementation class.

---

## 8.5 BitSet: Million-Bit Vectors at Memory Bandwidth

### Internal Representation

A `BitSet` is conceptually an infinite-length bit vector. Internally, it is a `long[]` array where each `long` holds 64 bits:

```java
// OpenJDK BitSet.java (simplified)
public class BitSet implements Cloneable, Serializable {
    // The internal field that stores the bits
    private long[] words;

    // The logical size: index of the highest long that is in use + 1
    private int wordsInUse;
}
```

```
BitSet with bits 0, 3, 7, 64, 65, 200 set:

words[0] = 0b...10001001  (bits 0, 3, 7)
            bit: 7 6 5 4 3 2 1 0
                 1 0 0 0 1 0 0 1

words[1] = 0b...00000011  (bits 64, 65)
            bit: 65 64
                  1  1

words[2] = 0b...00000000  (all zero)

words[3] = 0b...00000001_00000000 (bit 200 = word 3, bit 8)
            bit 200 = 3*64 + 8
```

### Bit Operations

```java
// set(int bitIndex)
public void set(int bitIndex) {
    int wordIndex = bitIndex >> 6;              // divide by 64
    expandTo(wordIndex);                        // grow if needed
    words[wordIndex] |= (1L << bitIndex);       // set the bit
    // Note: (1L << bitIndex) auto-masks to (1L << (bitIndex & 63))
    // because Java long shifts use only bottom 6 bits of shift amount
}

// get(int bitIndex)
public boolean get(int bitIndex) {
    int wordIndex = bitIndex >> 6;
    return (wordIndex < wordsInUse)
        && ((words[wordIndex] & (1L << bitIndex)) != 0);
}

// clear(int bitIndex)
public void clear(int bitIndex) {
    int wordIndex = bitIndex >> 6;
    if (wordIndex < wordsInUse)
        words[wordIndex] &= ~(1L << bitIndex);
    recalculateWordsInUse();
}
```

### Bulk Bitwise Operations

These operate on the entire `long[]` array, word by word:

```java
// AND: intersection of two BitSets
public void and(BitSet set) {
    int commonWords = Math.min(wordsInUse, set.wordsInUse);
    for (int i = 0; i < commonWords; i++)
        words[i] &= set.words[i];
    // Words beyond commonWords are implicitly zero in the shorter set → clear them
    for (int i = commonWords; i < wordsInUse; i++)
        words[i] = 0;
    recalculateWordsInUse();
}

// OR: union
public void or(BitSet set) {
    int wordsInCommon = Math.min(wordsInUse, set.wordsInUse);
    for (int i = 0; i < wordsInCommon; i++)
        words[i] |= set.words[i];
    for (int i = wordsInCommon; i < set.wordsInUse; i++)
        words[i] = set.words[i];  // copy remaining from set
}

// XOR: symmetric difference
public void xor(BitSet set) { /* similar loop with ^= */ }

// AND NOT: difference (bits in this but not in set)
public void andNot(BitSet set) {
    for (int i = Math.min(wordsInUse, set.wordsInUse) - 1; i >= 0; i--)
        words[i] &= ~set.words[i];
    recalculateWordsInUse();
}
```

Each word operation processes 64 bits simultaneously. For a `BitSet` of 1 million bits, that is only 15,625 `long` operations to process the entire set. Modern CPUs can execute these at memory bandwidth — hundreds of millions of operations per second.

### Cardinality and Scanning

```java
// cardinality(): count of set bits — uses POPCNT hardware instruction
public int cardinality() {
    int sum = 0;
    for (int i = 0; i < wordsInUse; i++)
        sum += Long.bitCount(words[i]);  // POPCNT: single CPU instruction per word
    return sum;
}

// nextSetBit(fromIndex): find next set bit at or after fromIndex
public int nextSetBit(int fromIndex) {
    int u = fromIndex >> 6;
    if (u >= wordsInUse) return -1;

    // Mask out bits below fromIndex in the starting word
    long word = words[u] & (WORD_MASK << fromIndex);

    while (true) {
        if (word != 0)
            return (u * 64) + Long.numberOfTrailingZeros(word);
            // numberOfTrailingZeros maps to BSF/TZCNT — single instruction
        if (++u == wordsInUse) return -1;
        word = words[u];
    }
}
```

`Long.bitCount()` compiles to the x86 `POPCNT` instruction — a single CPU cycle to count all set bits in a 64-bit word. `Long.numberOfTrailingZeros()` compiles to `TZCNT` or `BSF` — also single-cycle. These hardware intrinsics make `BitSet` operations astonishingly fast.

### Auto-Growing

`BitSet` grows automatically when you set a bit beyond the current capacity:

```java
private void expandTo(int wordIndex) {
    int wordsRequired = wordIndex + 1;
    if (wordsInUse < wordsRequired) {
        ensureCapacity(wordsRequired);
        wordsInUse = wordsRequired;
    }
}

private void ensureCapacity(int wordsRequired) {
    if (words.length < wordsRequired) {
        int request = Math.max(2 * words.length, wordsRequired);
        words = Arrays.copyOf(words, request);
    }
}
```

Growth doubles the array, similar to `ArrayList`. But since each word holds 64 bits, a `long[16]` (128 bytes) holds 1,024 bits. The overhead is minimal.

### Memory Comparison

```
1,000,000 boolean flags:

BitSet:
  long[15625] array: 16 header + 15625*8 = 125,016 bytes ≈ 122 KB

boolean[1_000_000]:
  Header: 16 bytes + 1,000,000 * 1 byte = 1,000,016 bytes ≈ 977 KB
  (JVM stores each boolean as 1 byte, not 1 bit)

HashSet<Integer> (sparse set of set indices):
  Depends on how many are "true." For 500,000 true values:
  ~500,000 * 52 bytes ≈ 24.8 MB

BitSet is 8x smaller than boolean[] and ~200x smaller than HashSet for dense sets.
```

### Use Cases

**Bloom filters**: A Bloom filter is essentially k hash functions mapping to positions in a BitSet. Cassandra, HBase, and LevelDB all use Bloom filters backed by bit arrays to avoid unnecessary disk reads.

**Sieve of Eratosthenes**: Mark composite numbers by setting bits. The sieve for finding all primes up to N needs only N bits = N/8 bytes.

**Bitmap indexes in databases**: Each distinct value in a column gets a BitSet where bit i is set if row i has that value. Queries like "WHERE color = 'red' AND size = 'large'" become `redBitmap.and(largeBitmap)` — a single pass over the word arrays.

**Permission flags**: `READ | WRITE | EXECUTE` — each permission is a bit. Combining permissions is OR, checking is AND, revoking is AND NOT.

**Network ACLs**: Firewall rules often use bitmaps to represent allowed ports, IP ranges, or protocol flags.

---

## 8.6 Collections Utility Methods

### Unmodifiable Wrappers

```java
List<String> original = new ArrayList<>(List.of("a", "b", "c"));
List<String> unmodifiable = Collections.unmodifiableList(original);

unmodifiable.add("d");     // Throws UnsupportedOperationException
original.add("d");         // Succeeds! And now unmodifiable.size() == 4!
```

**Critical distinction**: `Collections.unmodifiableList()` returns a *view* that rejects mutation through the wrapper, but the underlying list can still change. It is **not** truly immutable. For true immutability in JDK 9+, use `List.of()` or `List.copyOf()` which create deeply unmodifiable lists.

```java
// Truly immutable (JDK 9+):
List<String> immutable = List.of("a", "b", "c");
immutable.add("d");  // UnsupportedOperationException
// No one can modify it — there is no underlying mutable list.

// The wrapper pattern (JDK 1.2+):
List<String> mutable = new ArrayList<>();
List<String> wrapped = Collections.unmodifiableList(mutable);
// mutable is still accessible and mutable. The wrapper is a facade.
```

### Synchronized Wrappers

```java
List<String> syncList = Collections.synchronizedList(new ArrayList<>());
// Every method call on syncList is synchronized on the wrapper object.
// This is correct but coarse-grained — every read also acquires the lock.
```

The synchronized wrapper acquires a mutex on every operation. This is safe but slow. For concurrent access patterns, use `ConcurrentHashMap`, `CopyOnWriteArrayList`, or other `java.util.concurrent` collections which use fine-grained locking or lock-free algorithms.

**Iteration gotcha**: Even with `synchronizedList`, you must externally synchronize during iteration:

```java
synchronized (syncList) {
    for (String s : syncList) {
        // safe: no other thread can modify during iteration
    }
}
// Without external sync, ConcurrentModificationException is still possible
```

### Checked Wrappers

```java
List<String> raw = new ArrayList<>();
List<String> checked = Collections.checkedList(raw, String.class);

// This exists for interop with pre-generics code that might insert wrong types:
List legacy = checked;         // raw type
legacy.add(42);                // ClassCastException at insertion time!
// Without checked wrapper, the 42 would silently enter the list
// and cause ClassCastException later when retrieved as String.
```

### Singleton and Empty Collections

```java
Collections.singletonList("x");  // Immutable list with exactly one element
Collections.singleton("x");      // Immutable set with exactly one element
Collections.singletonMap("k","v"); // Immutable map with exactly one entry
Collections.emptyList();         // Immutable empty list (singleton instance)
Collections.emptySet();          // Immutable empty set (singleton instance)
Collections.emptyMap();          // Immutable empty map (singleton instance)
```

These are lightweight — no array allocation for empty collections, no list/set overhead for singletons. `emptyList()` returns the same cached instance every time — zero allocation.

### Frequency and Disjoint

```java
// Count occurrences of an element in a collection
int count = Collections.frequency(list, targetElement);  // O(n)

// Check if two collections have no elements in common
boolean noOverlap = Collections.disjoint(list1, list2);  // O(n*m) worst case
// Optimized: if one collection is a Set, effectively O(n)
```

---

## 8.7 Real-World Correlations

### WeakHashMap in the Wild

**ClassLoader metadata caching**: Application servers (Tomcat, Jetty, WildFly) cache metadata keyed by `ClassLoader`. When a web application is undeployed, its `ClassLoader` becomes unreachable. A `WeakHashMap<ClassLoader, Metadata>` ensures the metadata is evicted when the ClassLoader is GC'd. Without this, each redeploy leaks the entire ClassLoader and all loaded classes — a classic application server memory leak.

**ThreadLocal cleanup**: `ThreadLocal` internally uses `ThreadLocalMap` with `WeakReference` keys to the `ThreadLocal` instance. When a `ThreadLocal` variable goes out of scope, GC can reclaim the key, and the next `ThreadLocalMap` operation expunges the stale entry. This is the same pattern as `WeakHashMap`'s `expungeStaleEntries()`.

**IntelliJ IDEA's PSI caches**: The IDE caches parsed program structure (PSI trees) using soft and weak references. When memory pressure rises, the GC evicts cached PSI trees, and the IDE re-parses on demand. This allows the IDE to use available memory for caching without setting hard limits.

### IdentityHashMap in the Wild

**Java serialization (ObjectOutputStream)**: The serialization protocol must detect when the same object is referenced multiple times. It uses an identity-based table: the first time an object is written, it gets an ID. Subsequent references to the *same object* (by `==`) write just the ID. This handles circular references and shared references correctly. Using `.equals()` would collapse logically-equal-but-physically-distinct objects.

**Dependency injection (Spring)**: Bean factories track bean instances by identity. Even if two beans of the same type are `.equals()`, they are distinct managed objects with separate lifecycles.

**AST transformation**: Compiler passes that transform an abstract syntax tree must map each original node to its transformed counterpart by identity. Two nodes with the same content but different positions in the tree are distinct — `IdentityHashMap` prevents them from collapsing.

### EnumMap/EnumSet in the Wild

**HTTP method routing**: Frameworks like Spring MVC and JAX-RS route requests based on HTTP method (`GET`, `POST`, `PUT`, etc.). An `EnumMap<HttpMethod, Handler>` provides O(1) dispatch with zero hashing overhead.

**Permission systems**: Unix permissions (`READ | WRITE | EXECUTE`), AWS IAM actions, and database grants are naturally represented as `EnumSet<Permission>`. Checking `userPermissions.contains(WRITE)` is a single bitwise AND. Combining permissions is bitwise OR. Computing missing permissions is `required.removeAll(granted)` — bitwise AND NOT.

**State machines**: An `EnumMap<State, EnumSet<State>>` maps each state to its allowed transitions. Checking `allowedTransitions.get(currentState).contains(nextState)` is two O(1) lookups — one array index into the `EnumMap`, one bitwise AND in the `EnumSet`.

**Feature flags**: An `EnumMap<Feature, Boolean>` or `EnumSet<Feature>` (for binary flags) provides type-safe, compile-time-checked feature flags with O(1) lookup and zero allocation per check.

### BitSet in the Wild

**Bloom filters in Cassandra/HBase**: Before reading from disk, Cassandra checks a Bloom filter (backed by a bit array) to determine if a key *might* exist in an SSTable. If the Bloom filter says "no," the disk read is skipped entirely. False positive rate of ~1% with 10 bits per element.

**Sieve of Eratosthenes**: Generating all primes up to N requires marking composites — a perfect use case for BitSet. The sieve for N = 10^9 uses only ~120 MB of memory.

**Database bitmap indexes**: Oracle, PostgreSQL, and Druid use bitmap indexes for low-cardinality columns. Each distinct value gets a BitSet; queries combine bitmaps with AND/OR/NOT operations.

**Network ACLs**: Firewall rules can represent allowed port ranges as BitSets. Checking if port 443 is allowed is `allowedPorts.get(443)` — a single array access and bitwise AND.

---

## Problems

### Bit Manipulation Fundamentals

---

**P8.01** [E] -- Single Number (XOR)

**Problem**: Given a non-empty array of integers where every element appears twice except for one, find that single element.

**Solution**:

```java
public int singleNumber(int[] nums) {
    int result = 0;
    for (int num : nums) {
        result ^= num;
    }
    return result;
}
```

**Complexity**: O(n) time, O(1) space.

**JVM Insight**: XOR is associative and commutative: `a ^ a = 0`, `a ^ 0 = a`. Every pair cancels out, leaving only the unique element. The `ixor` bytecode instruction is a single CPU cycle. No heap allocation, no autoboxing. This is the most memory-efficient solution possible — it uses a single `int` register.

**Real-World**: **Error detection in parity bits**. RAID 5 uses XOR across disk blocks — if one disk fails, XOR of the remaining blocks reconstructs the missing data. The same algebraic property (self-inverse) that makes this problem trivial makes RAID recovery work.

---

**P8.02** [M] -- Single Number II

**Problem**: Given an array where every element appears three times except for one, find the unique element.

**Solution**:

```java
public int singleNumber(int[] nums) {
    // Count each bit position modulo 3
    int ones = 0, twos = 0;
    for (int num : nums) {
        // ones: bits that have appeared 1 mod 3 times
        // twos: bits that have appeared 2 mod 3 times
        ones = (ones ^ num) & ~twos;
        twos = (twos ^ num) & ~ones;
    }
    return ones;
}

// Alternative: bit-by-bit counting (clearer but slower)
public int singleNumberClear(int[] nums) {
    int result = 0;
    for (int bit = 0; bit < 32; bit++) {
        int sum = 0;
        for (int num : nums) {
            sum += (num >> bit) & 1;
        }
        if (sum % 3 != 0) {
            result |= (1 << bit);
        }
    }
    return result;
}
```

**Complexity**: O(n) time, O(1) space for both. The first is a single pass; the second is 32 passes but easier to understand.

**JVM Insight**: The bit-counting approach iterates 32 times over the array — 32n total iterations. Despite the larger constant factor, it is still O(n) and the inner loop is trivially simple: shift, mask, add. The JIT will likely unroll the inner loop. The two-variable state machine (`ones`, `twos`) is harder to derive but executes in a single pass with 4 bitwise operations per element.

**Real-World**: **Error-correcting codes** in distributed systems. When N replicas store a value, and one replica is corrupted, the majority bit value at each position recovers the original. This is a generalization of the modular bit counting technique.

---

**P8.03** [M] -- Single Number III

**Problem**: Given an array where every element appears twice except for two elements, find both unique elements.

**Solution**:

```java
public int[] singleNumber(int[] nums) {
    // Step 1: XOR everything — result is xor of the two unique numbers
    int xorAll = 0;
    for (int num : nums) xorAll ^= num;

    // Step 2: Find any set bit in xorAll (this bit differs between the two uniques)
    // Use the lowest set bit: x & (-x) isolates the rightmost 1 bit
    int diffBit = xorAll & (-xorAll);

    // Step 3: Partition into two groups by this bit and XOR within each group
    int a = 0, b = 0;
    for (int num : nums) {
        if ((num & diffBit) != 0) {
            a ^= num;
        } else {
            b ^= num;
        }
    }
    return new int[]{a, b};
}
```

**Complexity**: O(n) time, O(1) space.

**JVM Insight**: `xorAll & (-xorAll)` isolates the lowest set bit. In two's complement, `-x = ~x + 1`. For example, if `xorAll = 0b01100`, then `-xorAll = 0b10100`, and `xorAll & (-xorAll) = 0b00100`. This is the standard bit trick for lowest-set-bit extraction, used extensively in Fenwick trees (Binary Indexed Trees). The JIT compiles `x & (-x)` to `BLSI` on modern x86 CPUs (BMI1 instruction set).

**Real-World**: **Network fault isolation**. If two nodes in a system have failed and all other nodes report matching checksums (pairs that cancel), XOR-based partitioning isolates the two faulty nodes into separate groups for individual identification.

---

**P8.04** [E] -- Power of Two

**Problem**: Determine if a given integer is a power of two.

**Solution**:

```java
public boolean isPowerOfTwo(int n) {
    return n > 0 && (n & (n - 1)) == 0;
}
```

**Complexity**: O(1) time, O(1) space.

**JVM Insight**: `n & (n - 1)` clears the lowest set bit. A power of two has exactly one set bit, so clearing it yields zero. This is the same check that `Integer.bitCount(n) == 1`, but `n & (n - 1)` compiles to two instructions (SUB + AND) vs. POPCNT. Both are O(1), but the bitwise version avoids function call overhead (though HotSpot intrinsifies `Integer.bitCount` to POPCNT).

**Real-World**: **HashMap capacity validation**. `HashMap` requires power-of-2 capacity for the `hash & (capacity - 1)` bitmask trick. The `tableSizeFor()` method uses bit manipulation to round up to the next power of 2. `EnumSet` uses this to decide between `RegularEnumSet` (single long, capacity 64 = 2^6) and `JumboEnumSet`.

---

**P8.05** [E] -- Number of 1-Bits (Hamming Weight)

**Problem**: Return the number of set bits (1-bits) in the binary representation of an unsigned integer.

**Solution**:

```java
public int hammingWeight(int n) {
    return Integer.bitCount(n);
}

// Manual implementation (for understanding):
public int hammingWeightManual(int n) {
    int count = 0;
    while (n != 0) {
        n &= (n - 1);  // clear lowest set bit
        count++;
    }
    return count;
}
```

**Complexity**: O(1) time (fixed 32 bits), O(1) space.

**JVM Insight**: `Integer.bitCount()` is an intrinsic in HotSpot — the JIT replaces it with the x86 `POPCNT` instruction (if the CPU supports it, which all modern x86 CPUs do). This is a single CPU cycle. The manual `n &= (n - 1)` loop runs in O(k) where k is the number of set bits — faster for sparse values but slower for dense values. `BitSet.cardinality()` uses `Long.bitCount()` internally — the same POPCNT instruction, processing 64 bits per invocation.

**Real-World**: **EnumSet.size()** is exactly `Long.bitCount(elements)`. One POPCNT instruction gives you the set cardinality. This is also used in succinct data structures, popcount-based indexing in hash array mapped tries (HAMT, used in Clojure and Scala persistent collections), and network packet classification.

---

**P8.06** [E] -- Counting Bits

**Problem**: Given an integer n, return an array where `result[i]` is the number of 1-bits in the binary representation of `i`, for every `i` from 0 to n.

**Solution**:

```java
public int[] countBits(int n) {
    int[] result = new int[n + 1];
    for (int i = 1; i <= n; i++) {
        // Key insight: i has one more or one fewer set bit than i >> 1
        result[i] = result[i >> 1] + (i & 1);
    }
    return result;
}

// Alternative using the lowest-set-bit trick:
public int[] countBitsAlt(int n) {
    int[] result = new int[n + 1];
    for (int i = 1; i <= n; i++) {
        result[i] = result[i & (i - 1)] + 1;
        // i & (i-1) removes the lowest set bit → has one fewer bit → already computed
    }
    return result;
}
```

**Complexity**: O(n) time, O(n) space.

**JVM Insight**: Both solutions are O(n) with a single pass, using previously computed results (dynamic programming on bits). The first divides by 2 (right shift) and adds the parity of the current number. The second removes the lowest set bit and adds 1. Both avoid calling `Integer.bitCount()` in a loop — while POPCNT is O(1), calling it n+1 times is slower than the DP approach because the DP solution has perfect cache locality (sequential array access) and no function call overhead.

**Real-World**: **Hamming distance tables** in error-correcting codes. Pre-computing bit counts for all values in a range accelerates hamming distance calculations used in image hashing (perceptual hash), DNA sequence comparison, and locality-sensitive hashing.

---

**P8.07** [E] -- Reverse Bits

**Problem**: Reverse the bit order of a 32-bit unsigned integer.

**Solution**:

```java
public int reverseBits(int n) {
    return Integer.reverse(n);
}

// Manual implementation (for understanding):
public int reverseBitsManual(int n) {
    int result = 0;
    for (int i = 0; i < 32; i++) {
        result <<= 1;
        result |= (n & 1);
        n >>>= 1;  // unsigned right shift
    }
    return result;
}

// Divide-and-conquer approach (how Integer.reverse() works):
public int reverseBitsFast(int n) {
    n = ((n & 0x55555555) << 1)  | ((n >>> 1) & 0x55555555);  // swap adjacent bits
    n = ((n & 0x33333333) << 2)  | ((n >>> 2) & 0x33333333);  // swap adjacent pairs
    n = ((n & 0x0f0f0f0f) << 4)  | ((n >>> 4) & 0x0f0f0f0f);  // swap adjacent nibbles
    n = ((n & 0x00ff00ff) << 8)  | ((n >>> 8) & 0x00ff00ff);  // swap adjacent bytes
    n = (n << 16) | (n >>> 16);                                 // swap halves
    return n;
}
```

**Complexity**: O(1) time, O(1) space.

**JVM Insight**: `Integer.reverse()` is intrinsified in HotSpot. On x86, it may compile to the `BSWAP` instruction combined with nibble-level bit reversal, or a lookup table approach. The divide-and-conquer method shown in `reverseBitsFast` is exactly what `Integer.reverse()` does internally — five constant-time bitwise operations to reverse all 32 bits.

**Real-World**: **FFT (Fast Fourier Transform)** uses bit-reversal permutations to reorder input data. Network protocols that transmit bits in MSB-first vs LSB-first order require bit reversal at the boundary. **CRC computation** also involves bit reversal for polynomial division.

---

### BitSet and Sieve Problems

---

**P8.08** [M] -- Sieve of Eratosthenes Using BitSet

**Problem**: Find all prime numbers up to n using the Sieve of Eratosthenes, implemented with a `BitSet`.

**Solution**:

```java
public List<Integer> sieveOfEratosthenes(int n) {
    // BitSet where bit i represents whether i is composite (NOT prime)
    // Initially all bits are 0 (all numbers assumed prime)
    BitSet composite = new BitSet(n + 1);
    composite.set(0);  // 0 is not prime
    composite.set(1);  // 1 is not prime

    // Sieve: mark composites
    for (int i = 2; (long) i * i <= n; i++) {
        if (!composite.get(i)) {
            // i is prime — mark all multiples of i starting from i*i
            for (int j = i * i; j <= n; j += i) {
                composite.set(j);
            }
        }
    }

    // Collect primes using nextClearBit for efficient scanning
    List<Integer> primes = new ArrayList<>();
    for (int i = composite.nextClearBit(2); i <= n; i = composite.nextClearBit(i + 1)) {
        primes.add(i);
    }
    return primes;
}
```

**Complexity**: O(n log log n) time (classic sieve complexity), O(n) space.

**JVM Insight**: The `BitSet` uses n/64 longs = n/8 bytes. For n = 10^7, that is ~1.2 MB — compare to `boolean[10_000_000]` which would be ~10 MB. The `nextClearBit` method is hardware-accelerated: it scans words using `Long.numberOfTrailingZeros()`, which compiles to the `TZCNT` instruction. This means scanning for the next prime skips over 64 composites at a time in a single instruction.

**Real-World**: **Cryptographic key generation** requires finding large primes. While the sieve is not used for very large primes (probabilistic tests like Miller-Rabin are used instead), pre-computed sieve tables for small primes accelerate trial division. **Number theory libraries** like Apache Commons Math use sieve-based prime generation.

---

**P8.09** [M] -- Implement Bloom Filter Using BitSet

**Problem**: Implement a Bloom filter from scratch using `BitSet`. Support `add(item)` and `mightContain(item)` with configurable false positive rate.

**Solution**:

```java
class BloomFilter<T> {
    private final BitSet bits;
    private final int numBits;
    private final int numHashFunctions;

    /**
     * @param expectedInsertions expected number of items
     * @param falsePositiveRate  desired false positive probability (e.g., 0.01 for 1%)
     */
    public BloomFilter(int expectedInsertions, double falsePositiveRate) {
        // Optimal number of bits: m = -(n * ln(p)) / (ln(2))^2
        this.numBits = (int) (-expectedInsertions * Math.log(falsePositiveRate)
                              / (Math.log(2) * Math.log(2)));
        // Optimal number of hash functions: k = (m/n) * ln(2)
        this.numHashFunctions = Math.max(1, (int) Math.round(
            (double) numBits / expectedInsertions * Math.log(2)));
        this.bits = new BitSet(numBits);
    }

    public void add(T item) {
        long hash64 = hash(item);
        int hash1 = (int) hash64;
        int hash2 = (int) (hash64 >>> 32);

        for (int i = 0; i < numHashFunctions; i++) {
            // Kirsch-Mitzenmacher: combine two hashes to simulate k hashes
            int combinedHash = hash1 + i * hash2;
            int index = Math.floorMod(combinedHash, numBits);
            bits.set(index);
        }
    }

    public boolean mightContain(T item) {
        long hash64 = hash(item);
        int hash1 = (int) hash64;
        int hash2 = (int) (hash64 >>> 32);

        for (int i = 0; i < numHashFunctions; i++) {
            int combinedHash = hash1 + i * hash2;
            int index = Math.floorMod(combinedHash, numBits);
            if (!bits.get(index)) return false;  // definitely not present
        }
        return true;  // might be present (could be false positive)
    }

    private long hash(T item) {
        // Use MurmurHash3-style mixing for good distribution
        long h = item.hashCode();
        h ^= h >>> 33;
        h *= 0xff51afd7ed558ccdL;
        h ^= h >>> 33;
        h *= 0xc4ceb9fe1a85ec53L;
        h ^= h >>> 33;
        return h;
    }

    public double expectedFalsePositiveRate() {
        // (1 - e^(-kn/m))^k
        int setBits = bits.cardinality();
        return Math.pow((double) setBits / numBits, numHashFunctions);
    }
}
```

**Complexity**: `add` and `mightContain` are O(k) where k is the number of hash functions (typically 3-10). Space is O(m) bits where m is computed from the desired false positive rate.

**JVM Insight**: The Kirsch-Mitzenmacher optimization generates k hash values from just two base hashes — `h1 + i * h2`. This is mathematically proven to have the same false positive rate as k independent hash functions. Each `bits.set(index)` and `bits.get(index)` is an array access plus a single bitwise operation. For a Bloom filter with 10 million entries at 1% FPR: ~11.5 MB of BitSet memory, 7 hash functions per operation. The entire `mightContain` check touches at most 7 words in the `long[]` array.

**Real-World**: **Cassandra** uses Bloom filters per SSTable to skip disk reads. **Chrome** uses a Bloom filter to check URLs against a malware blacklist before fetching. **Spark** uses Bloom filters for join optimization. **HBase** uses them per HFile to skip block reads.

---

**P8.10** [M] -- Bitwise AND of Numbers Range

**Problem**: Given two integers `left` and `right`, return the bitwise AND of all numbers in the range `[left, right]`.

**Solution**:

```java
public int rangeBitwiseAnd(int left, int right) {
    // Find the common prefix of left and right
    int shift = 0;
    while (left != right) {
        left >>= 1;
        right >>= 1;
        shift++;
    }
    return left << shift;
}

// Alternative: clear the lowest set bit of right until right <= left
public int rangeBitwiseAndAlt(int left, int right) {
    while (right > left) {
        right &= (right - 1);  // clear lowest set bit
    }
    return right;
}
```

**Complexity**: O(log n) time where n is the range width, O(1) space.

**JVM Insight**: The key insight is that ANDing a range preserves only the common prefix bits. Any bit position where `left` and `right` differ will have both 0 and 1 somewhere in the range — ANDing them produces 0. The first approach finds the common prefix by shifting both numbers right until they are equal, then shifts back. The second approach directly strips differing bits from `right`.

**Real-World**: **IP address subnet calculation**. The bitwise AND of a range of IP addresses gives the network prefix. `192.168.1.0 & 192.168.1.255 = 192.168.1.0` — the /24 network address. This is exactly how subnet masks work in routing tables.

---

**P8.11** [M] -- Hamming Distance

**Problem**: Given two integers, return the number of bit positions where their corresponding bits differ.

**Solution**:

```java
public int hammingDistance(int x, int y) {
    return Integer.bitCount(x ^ y);
}
```

**Complexity**: O(1) time, O(1) space.

**JVM Insight**: XOR produces a 1 in every position where the bits differ. `Integer.bitCount()` counts those differing positions. Two instructions: `XOR` + `POPCNT`. This is as fast as possible. The JIT compiles this to literally two CPU instructions plus register load/store.

**Real-World**: **Perceptual hashing** in image search. Images are converted to 64-bit hashes; similar images have small Hamming distances. **DNA sequence comparison** — each nucleotide encoded as 2 bits, Hamming distance measures mutations. **Error detection** — Hamming distance between codewords determines the number of bit errors a code can detect.

---

### EnumSet and EnumMap Problems

---

**P8.12** [M] -- Design Permission System Using EnumSet

**Problem**: Design a permission system supporting READ, WRITE, EXECUTE, DELETE, ADMIN permissions. Users have permission sets. Support granting, revoking, checking, and computing effective permissions with role inheritance.

**Solution**:

```java
enum Permission {
    READ, WRITE, EXECUTE, DELETE, ADMIN
}

class PermissionSystem {
    // Role → base permissions
    private final EnumMap<Role, EnumSet<Permission>> rolePermissions = new EnumMap<>(Role.class);
    // User → explicitly granted permissions
    private final Map<String, EnumSet<Permission>> userPermissions = new HashMap<>();
    // User → assigned roles
    private final Map<String, EnumSet<Role>> userRoles = new HashMap<>();

    enum Role {
        VIEWER, EDITOR, ADMIN
    }

    public PermissionSystem() {
        // Define role hierarchies
        rolePermissions.put(Role.VIEWER, EnumSet.of(Permission.READ));
        rolePermissions.put(Role.EDITOR, EnumSet.of(Permission.READ, Permission.WRITE, Permission.EXECUTE));
        rolePermissions.put(Role.ADMIN, EnumSet.allOf(Permission.class));
    }

    // Grant a permission directly to a user
    public void grant(String user, Permission perm) {
        userPermissions.computeIfAbsent(user, k -> EnumSet.noneOf(Permission.class)).add(perm);
    }

    // Revoke a permission from a user
    public void revoke(String user, Permission perm) {
        EnumSet<Permission> perms = userPermissions.get(user);
        if (perms != null) perms.remove(perm);
    }

    // Assign a role to a user
    public void assignRole(String user, Role role) {
        userRoles.computeIfAbsent(user, k -> EnumSet.noneOf(Role.class)).add(role);
    }

    // Compute effective permissions: union of role permissions + direct grants
    public EnumSet<Permission> effectivePermissions(String user) {
        EnumSet<Permission> effective = EnumSet.noneOf(Permission.class);

        // Add role-based permissions (each add is a bitwise OR)
        EnumSet<Role> roles = userRoles.getOrDefault(user, EnumSet.noneOf(Role.class));
        for (Role role : roles) {
            effective.addAll(rolePermissions.get(role));  // OR operation
        }

        // Add direct grants
        EnumSet<Permission> direct = userPermissions.get(user);
        if (direct != null) effective.addAll(direct);  // OR operation

        return effective;
    }

    // Check permission
    public boolean hasPermission(String user, Permission perm) {
        return effectivePermissions(user).contains(perm);  // single bitwise AND
    }

    // Check if user has ALL of a set of required permissions
    public boolean hasAllPermissions(String user, EnumSet<Permission> required) {
        return effectivePermissions(user).containsAll(required);
        // Internally: (this.elements & required.elements) == required.elements
    }

    // Compute missing permissions
    public EnumSet<Permission> missingPermissions(String user, EnumSet<Permission> required) {
        EnumSet<Permission> missing = EnumSet.copyOf(required);
        missing.removeAll(effectivePermissions(user));  // AND NOT
        return missing;
    }
}
```

**Complexity**: All permission checks are O(1) — single bitwise operations on `long` values.

**JVM Insight**: The entire permission set for a user fits in a single `long` (5 permissions = 5 bits). `contains()` is a bitwise AND. `addAll()` is bitwise OR. `removeAll()` is bitwise AND NOT. `containsAll()` is `(a & b) == b`. Every check is 1-2 CPU cycles. Compare to `HashSet<Permission>` which would involve hash computation, bucket lookup, and equals comparison per check — orders of magnitude slower.

**Real-World**: **Unix file permissions** use exactly this bit pattern: `rwxrwxrwx` = 9 bits. **AWS IAM** policies evaluate permission sets. **Android** and **Java SecurityManager** use permission sets for access control. The kernel checks `DAC_READ_SEARCH` capability with a single bit test.

---

**P8.13** [M] -- Design Feature Flag System Using EnumMap

**Problem**: Design a feature flag system where features can be enabled/disabled globally, per-environment, and per-user with percentage rollouts.

**Solution**:

```java
enum Feature {
    DARK_MODE, NEW_CHECKOUT, BETA_SEARCH, AI_RECOMMENDATIONS, V2_API
}

enum Environment {
    DEV, STAGING, PRODUCTION
}

class FeatureFlagSystem {
    // Global kill switch: if not in this set, feature is off everywhere
    private EnumSet<Feature> globallyEnabled = EnumSet.allOf(Feature.class);

    // Per-environment overrides
    private final EnumMap<Environment, EnumSet<Feature>> envFlags = new EnumMap<>(Environment.class);

    // Percentage rollout: feature → percentage (0-100)
    private final EnumMap<Feature, Integer> rolloutPercentage = new EnumMap<>(Feature.class);

    // Per-user overrides (whitelist)
    private final Map<String, EnumSet<Feature>> userOverrides = new HashMap<>();

    public FeatureFlagSystem() {
        for (Environment env : Environment.values()) {
            envFlags.put(env, EnumSet.allOf(Feature.class));
        }
        for (Feature f : Feature.values()) {
            rolloutPercentage.put(f, 100);
        }
    }

    public void disableGlobally(Feature feature) {
        globallyEnabled.remove(feature);
    }

    public void enableForEnvironment(Environment env, Feature feature) {
        envFlags.get(env).add(feature);
    }

    public void disableForEnvironment(Environment env, Feature feature) {
        envFlags.get(env).remove(feature);
    }

    public void setRolloutPercentage(Feature feature, int percent) {
        rolloutPercentage.put(feature, Math.max(0, Math.min(100, percent)));
    }

    public void enableForUser(String userId, Feature feature) {
        userOverrides.computeIfAbsent(userId, k -> EnumSet.noneOf(Feature.class)).add(feature);
    }

    // Evaluation: check if feature is enabled for a specific user in a specific environment
    public boolean isEnabled(Feature feature, Environment env, String userId) {
        // 1. Global kill switch
        if (!globallyEnabled.contains(feature)) return false;  // O(1) bit test

        // 2. User override (whitelist always wins)
        EnumSet<Feature> overrides = userOverrides.get(userId);
        if (overrides != null && overrides.contains(feature)) return true;

        // 3. Environment check
        if (!envFlags.get(env).contains(feature)) return false;

        // 4. Percentage rollout (deterministic hash so same user always gets same result)
        int percent = rolloutPercentage.get(feature);
        if (percent < 100) {
            int hash = Math.abs((userId + ":" + feature.name()).hashCode());
            return (hash % 100) < percent;
        }

        return true;
    }

    // Get all enabled features for a user/env — useful for sending feature set to frontend
    public EnumSet<Feature> enabledFeatures(Environment env, String userId) {
        EnumSet<Feature> result = EnumSet.noneOf(Feature.class);
        for (Feature f : Feature.values()) {
            if (isEnabled(f, env, userId)) result.add(f);
        }
        return result;
    }
}
```

**Complexity**: `isEnabled` is O(1) for the bit operations. The percentage rollout adds a hash computation which is also O(1).

**JVM Insight**: `EnumMap` lookups are direct array index accesses — `vals[feature.ordinal()]`. No hashing, no probing. The `EnumSet` contains checks are single bitwise ANDs. The entire flag evaluation is a few array accesses and bit operations — sub-microsecond. The percentage rollout uses a deterministic hash of userId + feature name, ensuring the same user consistently sees the same feature state (no flickering).

**Real-World**: **LaunchDarkly**, **Split.io**, and **Unleash** implement feature flag systems with similar evaluation logic. The key insight is that evaluation must be fast because it happens on every request. Using `EnumMap` and `EnumSet` keeps the hot path allocation-free and branch-predictor-friendly.

---

### WeakHashMap and IdentityHashMap Problems

---

**P8.14** [H] -- Implement LRU Cache Using WeakHashMap Concepts

**Problem**: Design an LRU cache where evicted entries can be recovered if they have not been garbage collected yet. Use weak references for evicted entries as a "second chance" before going to the backing store.

**Solution**:

```java
class TwoTierLRUCache<K, V> {
    private final int capacity;
    // Tier 1: Strong references — the LRU cache
    private final LinkedHashMap<K, V> strongCache;
    // Tier 2: Weak references — evicted entries that may still be in memory
    private final Map<K, WeakReference<V>> weakCache = new HashMap<>();

    public TwoTierLRUCache(int capacity) {
        this.capacity = capacity;
        this.strongCache = new LinkedHashMap<K, V>(capacity, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
                if (size() > capacity) {
                    // Demote to weak cache instead of discarding
                    weakCache.put(eldest.getKey(), new WeakReference<>(eldest.getValue()));
                    return true;
                }
                return false;
            }
        };
    }

    public V get(K key) {
        // Check strong cache first (O(1) — LinkedHashMap with access order)
        V value = strongCache.get(key);
        if (value != null) return value;

        // Check weak cache — entry might still be alive in memory
        WeakReference<V> weakRef = weakCache.get(key);
        if (weakRef != null) {
            value = weakRef.get();
            if (value != null) {
                // Promote back to strong cache (it is being used again)
                weakCache.remove(key);
                strongCache.put(key, value);
                return value;
            } else {
                // GC already collected it — clean up
                weakCache.remove(key);
            }
        }
        return null;  // cache miss — caller should fetch from backing store
    }

    public void put(K key, V value) {
        weakCache.remove(key);  // remove from weak tier if present
        strongCache.put(key, value);  // insert into strong tier
    }

    public int strongSize() { return strongCache.size(); }
    public int weakSize() { return weakCache.size(); }
}
```

**Complexity**: O(1) for get and put (amortized, same as LinkedHashMap and HashMap).

**JVM Insight**: This two-tier design exploits the time between LRU eviction and actual garbage collection. When an entry is evicted from the strong cache, its value object may still be alive in memory (referenced by other code, or simply not yet collected). By holding a `WeakReference` to the value, we can recover it without a full cache miss. This is the same principle behind JVM soft reference caches — entries survive until GC needs the memory. The weak tier has zero cost to GC because `WeakReference` objects themselves are small (24 bytes each), and the referenced values would be collected anyway.

**Real-World**: **IntelliJ IDEA** uses a similar two-tier caching strategy for PSI (program structure) elements — recently used elements in a strong cache, others in soft/weak caches. **Android Glide** (image loading library) uses a weak reference pool for recently evicted bitmaps. **JVM ClassLoader** caches use soft references for class metadata that can be regenerated from bytecode.

---

**P8.15** [M] -- Find All Duplicates in Array (Index-as-Hash Trick)

**Problem**: Given an array of n integers where each integer is in the range [1, n], some elements appear twice and others once. Find all elements that appear twice, using O(1) extra space.

**Solution**:

```java
public List<Integer> findDuplicates(int[] nums) {
    List<Integer> duplicates = new ArrayList<>();

    for (int i = 0; i < nums.length; i++) {
        // Use the value as an index (1-indexed → subtract 1)
        int index = Math.abs(nums[i]) - 1;

        if (nums[index] < 0) {
            // Already visited this index → nums[i] is a duplicate
            duplicates.add(index + 1);
        } else {
            // Mark as visited by negating
            nums[index] = -nums[index];
        }
    }

    // Restore the array (optional, for non-destructive approach)
    for (int i = 0; i < nums.length; i++) {
        nums[i] = Math.abs(nums[i]);
    }

    return duplicates;
}
```

**Complexity**: O(n) time, O(1) extra space (ignoring output list).

**JVM Insight**: This is the "array-as-hashmap" trick. Since values are in [1, n] and the array has n slots, each value maps to a valid index. We use the sign bit of each element as a visited flag — effectively using the array itself as a `BitSet` where the sign bit is the "set" indicator. No additional data structure is allocated. The `Math.abs()` call compiles to a conditional move (CMOV) or branch — essentially free. This technique uses zero heap memory beyond the input array.

**Real-World**: This pattern appears in **cycle detection** algorithms (Floyd's tortoise and hare applied to arrays), **in-place deduplication** of database result sets, and **memory-constrained embedded systems** where auxiliary data structures are not available.

---

**P8.16** [E] -- Missing Number

**Problem**: Given an array containing n distinct numbers in the range [0, n], find the missing number.

**Solution**:

```java
public int missingNumber(int[] nums) {
    int n = nums.length;
    int xor = 0;
    for (int i = 0; i <= n; i++) xor ^= i;       // XOR of [0..n]
    for (int num : nums)        xor ^= num;       // XOR with array
    return xor;
    // Pairs cancel: (0^1^...^n) ^ (nums[0]^nums[1]^...^nums[n-1])
    // = missing number
}

// Alternative: sum formula
public int missingNumberSum(int[] nums) {
    int n = nums.length;
    int expectedSum = n * (n + 1) / 2;
    int actualSum = 0;
    for (int num : nums) actualSum += num;
    return expectedSum - actualSum;
}
```

**Complexity**: O(n) time, O(1) space.

**JVM Insight**: The XOR approach avoids potential integer overflow that the sum approach has for large n. For n = 2^31 - 1, the sum `n*(n+1)/2` overflows `int`. The XOR approach never overflows because XOR never produces a value larger than the inputs. However, in Java, integer overflow is well-defined (wraps modulo 2^32), so the sum approach actually works correctly — the overflow in `expectedSum` and `actualSum` cancels out. Still, XOR is conceptually cleaner.

**Real-World**: **Parity check in RAID systems**. If one disk fails, XOR of the remaining disks reconstructs the missing data — identical to this problem but at the block level. **Network packet checksums** use similar XOR-based integrity checks.

---

**P8.17** [H] -- Missing Two Numbers

**Problem**: Given an array of n-2 distinct numbers from the range [1, n], find the two missing numbers.

**Solution**:

```java
public int[] missingTwo(int[] nums) {
    int n = nums.length + 2;

    // Step 1: XOR all numbers [1..n] with all array elements
    // Result is xor of the two missing numbers: a ^ b
    long xorAll = 0;
    for (int i = 1; i <= n; i++) xorAll ^= i;
    for (int num : nums) xorAll ^= num;

    // Step 2: Find a bit where a and b differ
    long diffBit = xorAll & (-xorAll);  // lowest set bit

    // Step 3: Partition and XOR
    int a = 0, b = 0;
    for (int i = 1; i <= n; i++) {
        if ((i & diffBit) != 0) a ^= i; else b ^= i;
    }
    for (int num : nums) {
        if ((num & diffBit) != 0) a ^= num; else b ^= num;
    }
    return new int[]{a, b};
}
```

**Complexity**: O(n) time, O(1) space.

**JVM Insight**: This combines the Single Number III technique with the missing number technique. The XOR of the complete range [1..n] with the array isolates the two missing numbers (like Single Number III isolates two uniques). Then the bit-partitioning trick separates them. Three passes over the data, all with primitive operations — zero heap allocation beyond the 2-element result array.

**Real-World**: **Distributed consensus** — if two nodes in a cluster are unreachable and all other nodes report consistent state, this technique can identify the two missing nodes from their ID checksums. More practically, **data integrity verification** in backup systems uses XOR checksums to detect and identify missing blocks.

---

### Advanced Bit Manipulation

---

**P8.18** [M] -- UTF-8 Validation

**Problem**: Given an array of integers representing bytes (only lowest 8 bits are significant), determine if the sequence is a valid UTF-8 encoding.

**Solution**:

```java
public boolean validUtf8(int[] data) {
    int remainingBytes = 0;  // continuation bytes expected

    for (int b : data) {
        b &= 0xFF;  // keep only lowest 8 bits

        if (remainingBytes == 0) {
            // Determine the number of bytes in this character
            if ((b >> 7) == 0)         remainingBytes = 0;  // 0xxxxxxx: 1-byte char
            else if ((b >> 5) == 0b110) remainingBytes = 1;  // 110xxxxx: 2-byte char
            else if ((b >> 4) == 0b1110) remainingBytes = 2; // 1110xxxx: 3-byte char
            else if ((b >> 3) == 0b11110) remainingBytes = 3; // 11110xxx: 4-byte char
            else return false;  // invalid leading byte
        } else {
            // Expecting a continuation byte: 10xxxxxx
            if ((b >> 6) != 0b10) return false;
            remainingBytes--;
        }
    }
    return remainingBytes == 0;  // all characters must be complete
}
```

**Complexity**: O(n) time, O(1) space.

**JVM Insight**: The bit-shift-and-compare pattern is the standard way to decode UTF-8 headers. `b >> 7` isolates the highest bit. `b >> 5 == 0b110` checks if the top 3 bits are `110`. These are fast: one shift and one comparison per byte. Java's `String` class internally stores UTF-16 (or Latin-1 via compact strings in JDK 9+), so this problem is about validating external byte streams (network I/O, file I/O) before they become Java Strings.

**Real-World**: **Every HTTP server** must validate UTF-8 in request headers and bodies. **JSON parsers** (Jackson, Gson) validate UTF-8 encoding. **Database drivers** validate character encoding on INSERT. Malformed UTF-8 is a common attack vector for injection and bypass attacks — improper validation can cause security vulnerabilities.

---

**P8.19** [M] -- Bitwise OR of Subarrays (Count Distinct Results)

**Problem**: Given an array of integers, find the number of distinct results from bitwise OR of all contiguous subarrays.

**Solution**:

```java
public int subarrayBitwiseORs(int[] arr) {
    Set<Integer> result = new HashSet<>();
    Set<Integer> current = new HashSet<>();  // OR values ending at current position

    for (int num : arr) {
        Set<Integer> next = new HashSet<>();
        next.add(num);

        // For each OR value ending at the previous position,
        // extend it by ORing with current number
        for (int prev : current) {
            next.add(prev | num);
        }

        result.addAll(next);
        current = next;
    }
    return result.size();
}
```

**Complexity**: O(n * W) time where W = 32 (the bit width). At each position, there are at most W distinct OR values because OR can only set bits, never clear them. Space: O(n * W).

**JVM Insight**: The key insight is that `current` (the set of distinct OR values for subarrays ending at the current position) has at most 32 elements. Each OR operation can only set new bits, never clear existing ones. So the sequence of OR accumulations for subarrays ending at position i is non-decreasing in bit count, and there are at most 32 distinct values (one for each bit that gets set). This bounds the inner loop to O(32) per outer iteration.

**Real-World**: **Network packet flow analysis** — computing the union of flag fields across contiguous packet sequences. **Feature combination analysis** — computing all possible feature flag combinations across contiguous configuration windows.

---

**P8.20** [H] -- Implement Frequency Counter with Auto-Eviction

**Problem**: Design a frequency counter that tracks element frequencies but automatically evicts entries for elements that are no longer referenced elsewhere in the application. Inspired by WeakHashMap.

**Solution**:

```java
class AutoEvictingFrequencyCounter<T> {
    // WeakHashMap: keys are weakly held.
    // When the caller no longer holds a strong reference to a key,
    // GC can collect it and the entry is evicted.
    private final WeakHashMap<T, int[]> counts = new WeakHashMap<>();

    // Strong reference set for elements we want to keep counting
    // (optional — use when you want to pin certain elements)
    private final Set<T> pinned = new HashSet<>();

    public void increment(T item) {
        int[] count = counts.get(item);
        if (count == null) {
            count = new int[]{0};
            counts.put(item, count);
        }
        count[0]++;
    }

    public int getCount(T item) {
        int[] count = counts.get(item);
        return count != null ? count[0] : 0;
    }

    public void pin(T item) {
        pinned.add(item);  // strong reference prevents eviction
    }

    public void unpin(T item) {
        pinned.remove(item);
        // item is now eligible for GC eviction (if no other strong refs)
    }

    public int distinctCount() {
        return counts.size();  // triggers expungeStaleEntries()
    }

    // Snapshot of current counts (creates strong references to surviving entries)
    public Map<T, Integer> snapshot() {
        Map<T, Integer> result = new HashMap<>();
        for (Map.Entry<T, int[]> entry : counts.entrySet()) {
            result.put(entry.getKey(), entry.getValue()[0]);
        }
        return result;
    }
}
```

**Complexity**: O(1) amortized for increment and getCount (same as WeakHashMap). `snapshot()` is O(n).

**JVM Insight**: We use `int[]` as the value type instead of `Integer` for two reasons: (1) `int[]` is mutable — we can increment without creating new objects (avoiding autoboxing), and (2) `int[]` does not reference the key — avoiding the value-references-key trap. Each call to `counts.get()`, `counts.put()`, or `counts.size()` internally calls `expungeStaleEntries()`, cleaning up entries whose keys have been GC'd. The `pinned` set holds strong references to keys we want to keep, preventing GC eviction.

**Real-World**: **Application metrics collection** — track method call frequencies, but automatically stop tracking methods from classes that have been unloaded (e.g., after hot-redeploy). **Connection pool monitoring** — count usage frequency per connection, but evict the counter when the connection is closed and GC'd.

---

**P8.21** [H] -- Implement Graph Copy Using IdentityHashMap

**Problem**: Deep-copy a directed graph where nodes may have duplicate values. Preserve the topology exactly — two distinct nodes with the same value must produce two distinct copies.

**Solution**:

```java
class GraphNode {
    int val;
    List<GraphNode> neighbors;

    GraphNode(int val) {
        this.val = val;
        this.neighbors = new ArrayList<>();
    }
}

public GraphNode deepCopy(GraphNode node) {
    if (node == null) return null;

    // IdentityHashMap: maps original node → cloned node by IDENTITY (==)
    // Two nodes with the same val are distinct entries
    IdentityHashMap<GraphNode, GraphNode> cloned = new IdentityHashMap<>();

    return dfs(node, cloned);
}

private GraphNode dfs(GraphNode original, IdentityHashMap<GraphNode, GraphNode> cloned) {
    if (cloned.containsKey(original)) {
        return cloned.get(original);  // already cloned — return existing copy
    }

    // Create clone and register it BEFORE recursing (handles cycles)
    GraphNode copy = new GraphNode(original.val);
    cloned.put(original, copy);  // uses == for key identity

    for (GraphNode neighbor : original.neighbors) {
        copy.neighbors.add(dfs(neighbor, cloned));
    }

    return copy;
}

// Why HashMap would fail:
// If GraphNode.equals() is based on val (content equality),
// and two distinct nodes have the same val,
// HashMap would treat them as the same key.
// The second node would overwrite the first in the map.
// Result: two original nodes map to ONE copy — topology is destroyed.
//
// IdentityHashMap uses == : two distinct objects are always separate entries,
// regardless of equals(). Topology is preserved.
```

**Complexity**: O(V + E) time and space.

**JVM Insight**: `IdentityHashMap` uses `System.identityHashCode()` which is based on the object's memory address (or a PRNG derived from it). Since each `GraphNode` has a unique address, the hash distribution is excellent — no clusters, no collisions from user-defined `hashCode()`. The flat `Object[]` with linear probing gives good cache locality for the DFS traversal pattern where we repeatedly look up recently created nodes.

**Real-World**: **Java serialization (ObjectOutputStream)** uses exactly this pattern. When serializing an object graph, it tracks which objects have been written using identity-based lookup. Circular references emit back-references. **ORM lazy-loading proxies** (Hibernate) use identity maps to ensure that loading the same database row always returns the same Java object instance within a session (first-level cache).

---

**P8.22** [H] -- Total Hamming Distance

**Problem**: Given an array of integers, find the total Hamming distance between all pairs.

**Solution**:

```java
public int totalHammingDistance(int[] nums) {
    int total = 0;
    int n = nums.length;

    // For each bit position, count how many numbers have 0 vs 1
    for (int bit = 0; bit < 32; bit++) {
        int onesCount = 0;
        for (int num : nums) {
            onesCount += (num >> bit) & 1;
        }
        int zerosCount = n - onesCount;
        // Each pair (one with 0, one with 1) contributes 1 to hamming distance
        total += onesCount * zerosCount;
    }
    return total;
}
```

**Complexity**: O(32 * n) = O(n) time, O(1) space.

**JVM Insight**: The brute-force approach (check every pair) is O(n^2). This approach recognizes that each bit position contributes independently to the total. At each bit position, if there are `k` ones and `n-k` zeros, there are `k * (n-k)` pairs that differ at that bit — each contributing 1 to the total Hamming distance. The inner loop is tight: shift, mask, add — the JIT will vectorize this if the array is large enough (auto-vectorization of the reduction pattern).

**Real-World**: **Similarity search** in large-scale systems. When computing aggregate similarity across a dataset (e.g., how diverse is this set of feature vectors?), the total pairwise Hamming distance is a measure of diversity. Used in **genetic algorithm** population diversity metrics and **near-duplicate detection** in web crawling.

---

**P8.23** [M] -- Maximum Product of Word Lengths

**Problem**: Given a list of words, find the maximum value of `word1.length() * word2.length()` where word1 and word2 do not share any common letters.

**Solution**:

```java
public int maxProduct(String[] words) {
    int n = words.length;
    // Encode each word as a bitmask of its letters (26 bits for a-z)
    int[] masks = new int[n];
    for (int i = 0; i < n; i++) {
        for (char c : words[i].toCharArray()) {
            masks[i] |= (1 << (c - 'a'));
        }
    }

    int maxProduct = 0;
    for (int i = 0; i < n; i++) {
        for (int j = i + 1; j < n; j++) {
            // No common letters ↔ bitmasks have no overlapping bits
            if ((masks[i] & masks[j]) == 0) {
                maxProduct = Math.max(maxProduct, words[i].length() * words[j].length());
            }
        }
    }
    return maxProduct;
}
```

**Complexity**: O(n^2 + total_chars) time, O(n) space.

**JVM Insight**: Without bitmasks, checking if two words share letters requires O(len1 * len2) or O(26) with a frequency array. With bitmasks, the check is `(masks[i] & masks[j]) == 0` — a single AND instruction and a comparison. This is the same approach `EnumSet` uses for set disjointness. The 26 lowercase letters fit comfortably in a 32-bit `int`, just as 64 enum constants fit in a `long`. The bitmask encoding converts a string comparison problem into a bit manipulation problem.

**Real-World**: **Database query optimization** — checking if two queries access disjoint column sets (to determine if they can be parallelized). **Compiler register allocation** — checking if two variables have non-overlapping live ranges using bitmask intersection.

---

**P8.24** [H] -- Design State Machine Using EnumMap and EnumSet

**Problem**: Design a type-safe finite state machine for an order processing system with compile-time transition validation using EnumMap and EnumSet.

**Solution**:

```java
enum OrderState {
    CREATED, PAYMENT_PENDING, PAID, PROCESSING, SHIPPED, DELIVERED, CANCELLED, REFUNDED
}

enum OrderEvent {
    SUBMIT, PAY, PROCESS, SHIP, DELIVER, CANCEL, REFUND
}

class OrderStateMachine {
    // State → allowed transitions
    private final EnumMap<OrderState, EnumMap<OrderEvent, OrderState>> transitions;
    // State → allowed events from that state
    private final EnumMap<OrderState, EnumSet<OrderEvent>> allowedEvents;

    private OrderState currentState;
    private final List<String> history = new ArrayList<>();

    public OrderStateMachine() {
        transitions = new EnumMap<>(OrderState.class);
        allowedEvents = new EnumMap<>(OrderState.class);

        // Initialize all states with empty transitions
        for (OrderState state : OrderState.values()) {
            transitions.put(state, new EnumMap<>(OrderEvent.class));
            allowedEvents.put(state, EnumSet.noneOf(OrderEvent.class));
        }

        // Define transitions
        addTransition(OrderState.CREATED,         OrderEvent.SUBMIT,  OrderState.PAYMENT_PENDING);
        addTransition(OrderState.CREATED,         OrderEvent.CANCEL,  OrderState.CANCELLED);
        addTransition(OrderState.PAYMENT_PENDING, OrderEvent.PAY,     OrderState.PAID);
        addTransition(OrderState.PAYMENT_PENDING, OrderEvent.CANCEL,  OrderState.CANCELLED);
        addTransition(OrderState.PAID,            OrderEvent.PROCESS, OrderState.PROCESSING);
        addTransition(OrderState.PAID,            OrderEvent.REFUND,  OrderState.REFUNDED);
        addTransition(OrderState.PROCESSING,      OrderEvent.SHIP,    OrderState.SHIPPED);
        addTransition(OrderState.SHIPPED,         OrderEvent.DELIVER, OrderState.DELIVERED);
        addTransition(OrderState.DELIVERED,       OrderEvent.REFUND,  OrderState.REFUNDED);

        currentState = OrderState.CREATED;
        history.add("Initial state: " + currentState);
    }

    private void addTransition(OrderState from, OrderEvent event, OrderState to) {
        transitions.get(from).put(event, to);
        allowedEvents.get(from).add(event);
    }

    // Fire an event — returns true if transition succeeded
    public boolean fire(OrderEvent event) {
        // Check if event is allowed from current state — O(1) bit test
        if (!allowedEvents.get(currentState).contains(event)) {
            return false;
        }

        OrderState nextState = transitions.get(currentState).get(event);
        history.add(currentState + " --[" + event + "]--> " + nextState);
        currentState = nextState;
        return true;
    }

    // Get all events that can be fired from the current state
    public EnumSet<OrderEvent> availableEvents() {
        return EnumSet.copyOf(allowedEvents.get(currentState));
    }

    // Check if a specific event can be fired
    public boolean canFire(OrderEvent event) {
        return allowedEvents.get(currentState).contains(event);  // O(1)
    }

    public OrderState getCurrentState() { return currentState; }
    public List<String> getHistory() { return Collections.unmodifiableList(history); }

    // Check if current state is terminal (no outgoing transitions)
    public boolean isTerminal() {
        return allowedEvents.get(currentState).isEmpty();  // O(1): check if long == 0
    }
}
```

**Complexity**: All operations are O(1) — `EnumMap` lookups are array index accesses, `EnumSet.contains()` is a single bitwise AND.

**JVM Insight**: The nested `EnumMap<OrderState, EnumMap<OrderEvent, OrderState>>` is a two-dimensional array indexed by ordinals. The outer `EnumMap` lookup returns the inner `EnumMap` for the current state — one array access. The inner `EnumMap` lookup finds the target state for the event — another array access. Total: two array accesses. No hashing, no equals, no probing. The `allowedEvents` check using `EnumSet` is a single bitwise AND on a `long`. The entire `fire()` method has zero heap allocation (no new objects created).

**Real-World**: **Spring StateMachine** and **Akka FSM** implement state machine frameworks. Production order processing systems (Amazon, Shopify) model order lifecycle as a state machine. **TCP connection states** (LISTEN, SYN_SENT, ESTABLISHED, etc.) follow the same pattern. The advantage of `EnumMap` + `EnumSet` is compile-time type safety — you cannot accidentally reference a non-existent state or event.

---

**P8.25** [H] -- Concatenation of Consecutive Binary Representations

**Problem**: Given an integer n, return the decimal value of the binary string formed by concatenating the binary representations of 1 to n. Return the result modulo 10^9 + 7.

**Solution**:

```java
public int concatenatedBinary(int n) {
    long result = 0;
    long MOD = 1_000_000_007;
    int bitLength = 0;

    for (int i = 1; i <= n; i++) {
        // Check if i is a power of 2 — if so, bit length increases by 1
        if ((i & (i - 1)) == 0) {
            bitLength++;
        }
        // Shift result left by bitLength bits and add i
        result = ((result << bitLength) | i) % MOD;
    }
    return (int) result;
}
```

**Complexity**: O(n) time, O(1) space.

**JVM Insight**: The power-of-two check `(i & (i - 1)) == 0` determines when the bit length of `i` increases (at 1, 2, 4, 8, 16, ...). This avoids calling `Integer.numberOfLeadingZeros()` or `Integer.toBinaryString().length()` every iteration. The left shift `result << bitLength` makes room for the new number's bits, and `| i` places the bits. The modulo operation prevents overflow. Note that we use `long` for `result` because `(result << bitLength)` can exceed `int` range before the modulo is applied.

**Real-World**: **Binary encoding in communication protocols**. Variable-length integer encoding (like Protocol Buffers' varint, or UTF-8) concatenates binary representations of varying lengths. The bit-length tracking and shifting pattern is the same.

---

## Key Takeaways

1. **WeakHashMap keys are WeakReferences; values are strong.** When no strong reference to a key exists, GC can collect it, and `expungeStaleEntries()` removes the entry on the next map operation. But if a value references its key, the entry is never collected. Always ensure values do not hold strong references to their keys.

2. **IdentityHashMap uses == and System.identityHashCode().** Its internal structure is a flat `Object[]` with linear probing — keys and values interleaved at `table[2i]` and `table[2i+1]`. Use it when object identity (not logical equality) is the correct comparison: serialization, graph copying, topology preservation. Never use it as a general-purpose map.

3. **EnumMap is O(1) with zero hashing.** It is a flat `Object[]` indexed by `enum.ordinal()`. No hash computation, no collision resolution, no Node objects. For enum keys, it is faster and smaller than `HashMap` in every dimension. There is no reason to use `HashMap<MyEnum, V>` when `EnumMap` exists.

4. **EnumSet packs up to 64 elements in a single long.** `add` is bitwise OR, `contains` is bitwise AND, `size` is POPCNT. Set operations (union, intersection, difference) execute in one CPU instruction. For 64 enums, `EnumSet` uses 24 bytes vs ~2,400 bytes for `HashSet<MyEnum>` — a 100x memory advantage.

5. **BitSet stores one million bits in 125 KB.** Operations like `and()`, `or()`, `xor()`, `andNot()` process 64 bits per loop iteration. `cardinality()` uses hardware POPCNT, `nextSetBit()` uses hardware TZCNT. Use it for Bloom filters, sieves, bitmap indexes, and any scenario involving bulk boolean flags.

6. **n & (n-1) clears the lowest set bit.** This single expression powers: power-of-two detection (`n & (n-1) == 0`), bit counting (clear until zero), and Fenwick tree index computation. `n & (-n)` isolates the lowest set bit. These are the two most important bit manipulation primitives.

7. **XOR is self-inverse: a ^ a = 0, a ^ 0 = a.** This property makes XOR the foundation of: Single Number (find the unique), parity checking, RAID recovery, and partitioning elements by a differentiating bit. Every pair cancels, leaving the unpaired element.

8. **Collections.unmodifiable*() creates views, not copies.** The underlying collection can still be mutated through the original reference. For true immutability, use `List.of()`, `Set.of()`, or `Map.of()` (JDK 9+), which create deeply unmodifiable collections with no mutable backing store.

9. **Bit manipulation converts set problems to integer problems.** Character sets become bitmasks (`EnumSet` approach). Subset enumeration becomes incrementing a binary counter. Set intersection becomes bitwise AND. This transforms O(n) set operations into O(1) bitwise operations whenever the universe is small enough to fit in a machine word.

10. **Know your hardware intrinsics.** `Integer.bitCount()` compiles to POPCNT. `Long.numberOfTrailingZeros()` compiles to TZCNT. `Long.numberOfLeadingZeros()` compiles to LZCNT. `Integer.reverse()` compiles to bit-reversal instructions. These are not library calls — they are single CPU cycles. The JIT replaces them with the corresponding machine instruction.

---

| Previous | Index | Next |
|----------|-------|------|
| [Chapter 7: Concurrent Collections](07-concurrent-collections.md) | [Index](00-index.md) | [Chapter 9: Advanced Structures Beyond JDK](09-advanced-structures-beyond-jdk.md) |
