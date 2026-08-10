# Chapter 12: Use Cases — Databases & Storage

## The Data Structures That Power Every Query You Run

Every time you execute `SELECT * FROM orders WHERE customer_id = 42`, a cascade of data structure operations fires beneath the SQL parser. A B+ tree walks its internal nodes to find the leaf page holding row 42. A buffer pool checks whether that page is already in memory or must be fetched from disk. A WAL ensures that if the server crashes mid-write, no committed transaction is lost. An inverted index in Elasticsearch tokenizes your full-text search and intersects posting lists in milliseconds.

These are not abstract concepts. They are concrete data structures — the same trees, hash maps, linked lists, and arrays you have been studying — deployed at the storage engine layer where every cache miss costs 100 microseconds and every unnecessary disk seek costs 10 milliseconds. Understanding them transforms you from someone who writes SQL to someone who understands *why* your query is slow and *what* the optimizer is actually doing.

This chapter builds every major database data structure from scratch in Java, with full implementations, JVM-level analysis, and direct mappings to production systems like InnoDB, PostgreSQL, RocksDB, Cassandra, and Elasticsearch.

---

## 12.1 B+ Tree Indexes (InnoDB)

The B+ tree is the backbone of relational databases. Every InnoDB table is a B+ tree. Every secondary index is a B+ tree. Understanding this structure is understanding how MySQL works.

### Why B+ Trees, Not Binary Trees

A binary search tree with 10 million keys has depth ~23 (log2(10M)). Each level is a random disk seek. At 10ms per seek, finding a key takes 230ms. Unacceptable.

A B+ tree with fan-out 500 and 10 million keys has depth 3 (log500(10M) ≈ 2.6). Three disk reads. At 10ms each, that is 30ms — and the root and first level are always cached, so it is really one disk read: 10ms.

The key insight: **disk reads are not proportional to data size but to tree height, and B+ trees minimize height by maximizing fan-out.**

### Anatomy of a B+ Tree

```
                    ┌──────────────────────────┐
                    │   Internal Node (Root)    │
                    │  [30 | 60 | 90]          │
                    │ /    |     |    \         │
                    └──────────────────────────┘
                   /       |       |        \
    ┌─────────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
    │ Internal     │  │ Internal │  │ Internal │  │ Internal │
    │ [10|20]      │  │ [40|50]  │  │ [70|80]  │  │ [100|110]│
    │ / | \        │  │ / | \    │  │ / | \    │  │ / | \    │
    └─────────────┘  └──────────┘  └──────────┘  └──────────┘
     /   |   \        /   |   \
   ┌───┐┌───┐┌───┐ ┌───┐┌───┐┌───┐
   │1-9││10 ││20 │ │30 ││40 ││50 │  ...
   │   ││-19││-29│ │-39││-49││-59│
   └───┘└───┘└───┘ └───┘└───┘└───┘
     ↔    ↔    ↔     ↔    ↔    ↔     ← Leaf nodes linked (doubly)
```

**Internal nodes**: Store keys and child pointers. No data. A node with `k` keys has `k+1` child pointers. Purpose: route searches to the correct leaf.

**Leaf nodes**: Store keys AND data (or pointers to data). Linked together in a doubly-linked list for range scans. This is the critical difference from B-trees — in a B-tree, data lives in internal nodes too.

### InnoDB Page Structure

InnoDB uses a fixed page size of **16KB** (configurable: 4KB, 8KB, 16KB, 32KB, 64KB). Each B+ tree node is one page.

```
┌─────────────────────────────────────────────────┐
│              InnoDB Page (16 KB)                  │
│                                                   │
│  Page Header (38 bytes)                           │
│    - page number, LSN, page type                  │
│    - pointers to prev/next page (leaf linking)    │
│                                                   │
│  Page Directory                                   │
│    - sparse index of record offsets               │
│    - enables binary search within the page        │
│                                                   │
│  Records Area                                     │
│    - actual key-value pairs (leaves)              │
│    - or key-pointer pairs (internal nodes)        │
│    - records stored in a singly-linked list       │
│      within the page, ordered by key              │
│                                                   │
│  Free Space                                       │
│                                                   │
│  Page Trailer (8 bytes)                           │
│    - checksum for corruption detection            │
└─────────────────────────────────────────────────┘
```

### Fan-Out Calculation

For an internal node storing `(key, child_pointer)` pairs:
- Page size: 16,384 bytes
- Page header + trailer + overhead: ~200 bytes
- Usable: ~16,184 bytes
- Key size (BIGINT): 8 bytes
- Child pointer (page number): 4 bytes
- Per-entry overhead (record header): ~5 bytes
- Bytes per entry: ~17 bytes
- Fan-out: 16,184 / 17 ≈ **952 children per internal node**

For leaf nodes with clustered index (key + full row):
- Usable: ~16,184 bytes
- Row size (say 200 bytes for a typical row): 200 bytes
- Records per leaf: ~80

**Tree height for 1 billion rows:**
- Level 0 (root): 1 node, 952 pointers
- Level 1: 952 nodes, 952 × 952 = 906,304 pointers
- Level 2: 906,304 nodes, each with ~80 rows = 72.5M rows
- Need one more level: 952 × 952 × 952 = 863M pointers at level 3
- **Height = 4** for a billion rows. Four disk reads maximum, two or three cached.

### Clustered vs Secondary Index

**Clustered index** (primary key in InnoDB): The leaf nodes contain the actual row data. The table *is* the B+ tree. There is only one clustered index per table.

```
Clustered Index (PRIMARY KEY):
Leaf node: [PK=1, name="Alice", age=30, ...full row...]
           [PK=2, name="Bob", age=25, ...full row...]
           [PK=3, name="Carol", age=28, ...full row...]
```

**Secondary index**: Leaf nodes contain the indexed column value plus the primary key. To get the full row, you must do a "bookmark lookup" — follow the primary key back to the clustered index.

```
Secondary Index on (name):
Leaf node: [name="Alice", PK=1]
           [name="Bob", PK=2]
           [name="Carol", PK=3]

Query: SELECT * FROM users WHERE name = 'Bob'
Step 1: Search secondary index → find PK=2
Step 2: Search clustered index with PK=2 → get full row
       (This is the "double lookup" cost of secondary indexes)
```

This is why InnoDB's primary key choice matters enormously. A UUID primary key means random inserts across the B+ tree, causing page splits. An auto-increment BIGINT means sequential inserts at the rightmost leaf — no splits, no fragmentation.

### Simplified B+ Tree Java Implementation

```java
import java.util.*;

/**
 * Simplified B+ Tree implementation demonstrating core mechanics.
 * Real databases use page-based storage; this uses in-memory nodes.
 *
 * Properties:
 * - Internal nodes: keys + child pointers, no data
 * - Leaf nodes: keys + values, linked list for range scans
 * - All data lives in leaves
 * - All leaves at the same depth
 */
public class BPlusTree<K extends Comparable<K>, V> {

    private static final int DEFAULT_ORDER = 128; // Fan-out: max children per node

    private final int order;        // Maximum children per internal node
    private final int maxKeys;      // order - 1
    private final int minKeys;      // ceil(order/2) - 1
    private Node root;
    private LeafNode firstLeaf;     // Head of leaf linked list for range scans
    private int size;
    private int height;

    // --- Node hierarchy ---

    private abstract class Node {
        List<K> keys;

        Node() {
            this.keys = new ArrayList<>();
        }

        abstract boolean isLeaf();
        abstract V search(K key);
        abstract SplitResult insert(K key, V value);
    }

    private class InternalNode extends Node {
        List<Node> children;

        InternalNode() {
            super();
            this.children = new ArrayList<>();
        }

        @Override
        boolean isLeaf() { return false; }

        @Override
        V search(K key) {
            // Binary search for the correct child
            int idx = Collections.binarySearch(keys, key);
            int childIdx = idx >= 0 ? idx + 1 : -(idx + 1);
            return children.get(childIdx).search(key);
        }

        @Override
        SplitResult insert(K key, V value) {
            // Find child to descend into
            int idx = Collections.binarySearch(keys, key);
            int childIdx = idx >= 0 ? idx + 1 : -(idx + 1);

            SplitResult childSplit = children.get(childIdx).insert(key, value);
            if (childSplit == null) return null; // No split needed

            // Child split — insert the promoted key and new child
            keys.add(childSplit.insertionIndex(this), childSplit.promotedKey);
            children.add(childSplit.insertionIndex(this) + 1, childSplit.newNode);

            // Check if this node needs to split
            if (keys.size() > maxKeys) {
                return splitInternal();
            }
            return null;
        }

        private SplitResult splitInternal() {
            int mid = keys.size() / 2;
            K promotedKey = keys.get(mid);

            InternalNode newNode = new InternalNode();
            // Move right half of keys to new node (exclude the promoted key)
            newNode.keys.addAll(keys.subList(mid + 1, keys.size()));
            newNode.children.addAll(children.subList(mid + 1, children.size()));

            // Truncate this node
            keys.subList(mid, keys.size()).clear();
            children.subList(mid + 1, children.size()).clear();

            return new SplitResult(promotedKey, newNode);
        }
    }

    private class LeafNode extends Node {
        List<V> values;
        LeafNode next;  // For range scans
        LeafNode prev;

        LeafNode() {
            super();
            this.values = new ArrayList<>();
        }

        @Override
        boolean isLeaf() { return true; }

        @Override
        V search(K key) {
            int idx = Collections.binarySearch(keys, key);
            return idx >= 0 ? values.get(idx) : null;
        }

        @Override
        SplitResult insert(K key, V value) {
            int idx = Collections.binarySearch(keys, key);
            if (idx >= 0) {
                // Key exists — update value
                values.set(idx, value);
                return null;
            }

            int insertPos = -(idx + 1);
            keys.add(insertPos, key);
            values.add(insertPos, value);
            size++;

            if (keys.size() > maxKeys) {
                return splitLeaf();
            }
            return null;
        }

        private SplitResult splitLeaf() {
            int mid = keys.size() / 2;

            LeafNode newLeaf = new LeafNode();
            newLeaf.keys.addAll(keys.subList(mid, keys.size()));
            newLeaf.values.addAll(values.subList(mid, values.size()));

            // Update linked list
            newLeaf.next = this.next;
            newLeaf.prev = this;
            if (this.next != null) this.next.prev = newLeaf;
            this.next = newLeaf;

            // Truncate this leaf
            keys.subList(mid, keys.size()).clear();
            values.subList(mid, values.size()).clear();

            // Promote a COPY of the first key in the new leaf
            // (unlike internal split, the key stays in the leaf)
            return new SplitResult(newLeaf.keys.get(0), newLeaf);
        }
    }

    private class SplitResult {
        K promotedKey;
        Node newNode;

        SplitResult(K promotedKey, Node newNode) {
            this.promotedKey = promotedKey;
            this.newNode = newNode;
        }

        int insertionIndex(InternalNode parent) {
            int idx = Collections.binarySearch(parent.keys, promotedKey);
            return idx >= 0 ? idx : -(idx + 1);
        }
    }

    // --- Public API ---

    public BPlusTree() {
        this(DEFAULT_ORDER);
    }

    public BPlusTree(int order) {
        if (order < 3) throw new IllegalArgumentException("Order must be >= 3");
        this.order = order;
        this.maxKeys = order - 1;
        this.minKeys = (int) Math.ceil(order / 2.0) - 1;
        this.root = new LeafNode();
        this.firstLeaf = (LeafNode) root;
        this.height = 0;
    }

    /**
     * Point query: O(log_B N) where B is the fan-out.
     * In InnoDB with B=500 and N=10M, this is ~3 comparisons at the node level,
     * with binary search within each node: O(log2(B)) per level.
     * Total: O(log_B(N) * log2(B)) = O(log2(N)) — same as binary search,
     * but with far fewer disk I/Os.
     */
    public V search(K key) {
        return root.search(key);
    }

    /**
     * Insert: O(log_B N) amortized.
     * Worst case triggers a cascade of splits up to the root.
     * InnoDB optimistically latches only the leaf for non-splitting inserts.
     */
    public void put(K key, V value) {
        SplitResult split = root.insert(key, value);
        if (split != null) {
            // Root split — create a new root
            InternalNode newRoot = new InternalNode();
            newRoot.keys.add(split.promotedKey);
            newRoot.children.add(root);
            newRoot.children.add(split.newNode);
            root = newRoot;
            height++;
        }
    }

    /**
     * Range query: O(log_B N + R) where R is the number of results.
     * After finding the start leaf, we follow the linked list.
     * This is why B+ trees dominate for range queries — no need to
     * revisit internal nodes.
     *
     * In InnoDB, this is a "range scan": find the first leaf page,
     * then sequentially read linked leaf pages. Sequential I/O is
     * 100x faster than random I/O on spinning disks and 10x faster on SSDs.
     */
    public List<V> rangeQuery(K start, K end) {
        List<V> results = new ArrayList<>();

        // Find the leaf containing 'start'
        LeafNode leaf = findLeaf(start);

        // Scan forward through linked leaves
        while (leaf != null) {
            for (int i = 0; i < leaf.keys.size(); i++) {
                K key = leaf.keys.get(i);
                if (key.compareTo(start) >= 0 && key.compareTo(end) <= 0) {
                    results.add(leaf.values.get(i));
                } else if (key.compareTo(end) > 0) {
                    return results; // Past the end
                }
            }
            leaf = leaf.next;
        }
        return results;
    }

    private LeafNode findLeaf(K key) {
        Node node = root;
        while (!node.isLeaf()) {
            InternalNode internal = (InternalNode) node;
            int idx = Collections.binarySearch(internal.keys, key);
            int childIdx = idx >= 0 ? idx + 1 : -(idx + 1);
            node = internal.children.get(childIdx);
        }
        return (LeafNode) node;
    }

    /**
     * Full scan via leaf linked list.
     * This is what "SELECT * FROM table" does — walks the leaf chain.
     */
    public void forEach(java.util.function.BiConsumer<K, V> consumer) {
        LeafNode leaf = firstLeaf;
        while (leaf != null) {
            for (int i = 0; i < leaf.keys.size(); i++) {
                consumer.accept(leaf.keys.get(i), leaf.values.get(i));
            }
            leaf = leaf.next;
        }
    }

    public int size() { return size; }
    public int height() { return height; }
}
```

**JVM Insight**: In this in-memory implementation, each node is a separate object with `ArrayList` fields — scattered heap allocations, pointer chasing on every tree traversal. A real database like InnoDB serializes nodes into fixed-size byte arrays (pages) and uses `ByteBuffer` or off-heap memory for cache-friendly sequential access within a page. If you were building a production Java storage engine, you would use `sun.misc.Unsafe` or `java.nio.MappedByteBuffer` to manage pages as flat byte arrays, avoiding the per-node object overhead entirely.

**Complexity:**
- Search: O(log_B N) I/Os, O(log N) comparisons
- Insert: O(log_B N) amortized
- Range query: O(log_B N + K/B) where K is result count
- Space: O(N) with ~50-70% utilization after random inserts

---

## 12.2 LSM Trees (Log-Structured Merge Trees)

B+ trees are optimized for reads. But what if your workload is 90% writes? Write-heavy workloads — time-series data, event logging, messaging — need a different structure. The LSM tree trades read performance for dramatically better write throughput.

### The Core Insight

**B+ tree write**: Find the leaf page (random I/O), modify it in place, write it back (random I/O). For a busy table, every insert is a random disk write. HDDs manage ~200 random writes/sec. SSDs manage ~50,000. Still limited.

**LSM tree write**: Append to a sequential log (sequential I/O), buffer in memory, flush sorted runs to disk when the buffer is full. Sequential I/O is 100-1000x faster than random I/O. An HDD can do 100+ MB/s sequential writes. An SSD can do 500+ MB/s.

### LSM Tree Architecture

```
                         WRITE PATH
                         ──────────
    Application
        │
        ▼
   ┌─────────┐
   │   WAL   │  1. Write to append-only log (durability)
   │ (disk)  │     Sequential writes only — fast
   └─────────┘
        │
        ▼
   ┌──────────┐
   │ MemTable │  2. Insert into in-memory sorted structure
   │ (memory) │     TreeMap or ConcurrentSkipListMap
   │ ~64 MB   │     Writes are O(log N) in memory — microseconds
   └──────────┘
        │ (when full)
        ▼
   ┌──────────┐
   │ Immutable│  3. Freeze the memtable, start a new one
   │ MemTable │     Background thread flushes to disk
   └──────────┘
        │ (flush)
        ▼
   ┌──────────────────────────────────────────────┐
   │              SSTable Files (disk)              │
   │                                                │
   │  Level 0: [SST-1] [SST-2] [SST-3]            │
   │           (may have overlapping key ranges)    │
   │                                                │
   │  Level 1: [────SST-A────] [────SST-B────]     │
   │           (non-overlapping, merged)            │
   │                                                │
   │  Level 2: [──SST-X──] [──SST-Y──] [──SST-Z──]│
   │           (non-overlapping, larger)            │
   │                                                │
   └──────────────────────────────────────────────┘
```

### Write Path: WAL → MemTable → SSTable

```java
import java.io.*;
import java.nio.*;
import java.nio.channels.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.concurrent.locks.*;

/**
 * LSM Tree implementation demonstrating the write path.
 * Production systems (RocksDB, LevelDB) add bloom filters,
 * compression, concurrent compaction, and much more.
 */
public class LSMTree {

    private static final int MEMTABLE_SIZE_LIMIT = 4 * 1024 * 1024; // 4 MB

    // Active memtable — all writes go here
    // ConcurrentSkipListMap: thread-safe, sorted, O(log N) insert
    // This is what RocksDB uses internally (as a skip list)
    private volatile ConcurrentSkipListMap<String, byte[]> memtable;

    // Immutable memtable being flushed to disk
    private volatile ConcurrentSkipListMap<String, byte[]> immutableMemtable;

    // WAL for durability
    private final WriteAheadLog wal;

    // SSTable files on disk, organized by level
    // Level 0: direct flushes from memtable (may overlap)
    // Level 1+: compacted, non-overlapping
    private final List<List<SSTable>> levels;

    // Bloom filters for each SSTable — avoid unnecessary disk reads
    private final Map<String, BloomFilter> bloomFilters;

    private final AtomicInteger memtableSize = new AtomicInteger(0);
    private final ReadWriteLock switchLock = new ReentrantReadWriteLock();
    private final String dataDir;

    public LSMTree(String dataDir) throws IOException {
        this.dataDir = dataDir;
        this.memtable = new ConcurrentSkipListMap<>();
        this.wal = new WriteAheadLog(dataDir + "/wal");
        this.levels = new ArrayList<>();
        for (int i = 0; i < 7; i++) { // 7 levels (like RocksDB default)
            levels.add(new CopyOnWriteArrayList<>());
        }
        this.bloomFilters = new ConcurrentHashMap<>();
    }

    /**
     * Write: WAL → MemTable. O(log N) where N is memtable size.
     *
     * Why this is fast:
     * 1. WAL is append-only (sequential I/O)
     * 2. MemTable insert is in-memory O(log N)
     * 3. No random disk I/O on the write path
     *
     * RocksDB achieves 400K-800K writes/sec with this approach.
     * InnoDB B+ tree: 50K-100K writes/sec (random I/O limited).
     */
    public void put(String key, byte[] value) throws IOException {
        switchLock.readLock().lock();
        try {
            // Step 1: Write to WAL (durability)
            wal.append(key, value);

            // Step 2: Insert into memtable
            memtable.put(key, value);
            int size = memtableSize.addAndGet(key.length() + value.length);

            // Step 3: Check if memtable is full
            if (size >= MEMTABLE_SIZE_LIMIT) {
                switchMemtable();
            }
        } finally {
            switchLock.readLock().unlock();
        }
    }

    /**
     * Delete: Write a tombstone marker.
     * LSM trees never delete in place — they append a tombstone.
     * The actual removal happens during compaction.
     */
    public void delete(String key) throws IOException {
        put(key, TOMBSTONE);
    }

    private static final byte[] TOMBSTONE = new byte[0]; // Sentinel for deletion

    /**
     * Freeze the current memtable and start a new one.
     * The frozen memtable will be flushed to an SSTable in the background.
     */
    private void switchMemtable() throws IOException {
        switchLock.writeLock().lock();
        try {
            if (memtableSize.get() < MEMTABLE_SIZE_LIMIT) return; // Double-check

            // Wait for any previous flush to complete
            while (immutableMemtable != null) {
                // In production, this would signal the flush thread and wait
                flushImmutableMemtable();
            }

            immutableMemtable = memtable;
            memtable = new ConcurrentSkipListMap<>();
            memtableSize.set(0);
            wal.rotate(); // Start a new WAL file

            // Flush in background (simplified: doing it synchronously here)
            flushImmutableMemtable();
        } finally {
            switchLock.writeLock().unlock();
        }
    }

    /**
     * Flush the immutable memtable to a new Level-0 SSTable.
     * The memtable is already sorted (it is a TreeMap/SkipListMap),
     * so we just write it sequentially — O(N) sequential I/O.
     */
    private void flushImmutableMemtable() throws IOException {
        if (immutableMemtable == null) return;

        SSTable sst = SSTable.flush(immutableMemtable, dataDir);
        levels.get(0).add(sst);
        bloomFilters.put(sst.filename(), sst.bloomFilter());

        immutableMemtable = null;

        // Trigger compaction if Level 0 has too many files
        if (levels.get(0).size() > 4) {
            compact(0);
        }
    }

    /**
     * Read path: MemTable → Immutable MemTable → Level 0 → Level 1 → ...
     *
     * This is why LSM reads are slower than B+ tree reads.
     * Mitigations:
     * 1. Bloom filters: skip SSTables that definitely don't contain the key
     * 2. Block cache: cache frequently read SSTable blocks in memory
     * 3. Compaction: reduce the number of levels/files to search
     */
    public byte[] get(String key) throws IOException {
        // 1. Check active memtable (fastest — in memory)
        byte[] value = memtable.get(key);
        if (value != null) {
            return value == TOMBSTONE ? null : value;
        }

        // 2. Check immutable memtable (if exists)
        ConcurrentSkipListMap<String, byte[]> immutable = immutableMemtable;
        if (immutable != null) {
            value = immutable.get(key);
            if (value != null) {
                return value == TOMBSTONE ? null : value;
            }
        }

        // 3. Check SSTables level by level (newest first)
        for (int level = 0; level < levels.size(); level++) {
            List<SSTable> ssts = levels.get(level);

            if (level == 0) {
                // Level 0: check all files (they may overlap), newest first
                for (int i = ssts.size() - 1; i >= 0; i--) {
                    SSTable sst = ssts.get(i);
                    // Bloom filter check: O(1), saves a disk read
                    BloomFilter bf = bloomFilters.get(sst.filename());
                    if (bf != null && !bf.mightContain(key)) continue;

                    value = sst.get(key);
                    if (value != null) {
                        return value == TOMBSTONE ? null : value;
                    }
                }
            } else {
                // Level 1+: files are non-overlapping, binary search for the right file
                SSTable sst = findSSTable(ssts, key);
                if (sst == null) continue;

                BloomFilter bf = bloomFilters.get(sst.filename());
                if (bf != null && !bf.mightContain(key)) continue;

                value = sst.get(key);
                if (value != null) {
                    return value == TOMBSTONE ? null : value;
                }
            }
        }

        return null; // Key not found
    }

    private SSTable findSSTable(List<SSTable> ssts, String key) {
        // Binary search over non-overlapping SSTables by key range
        int lo = 0, hi = ssts.size() - 1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            SSTable sst = ssts.get(mid);
            if (key.compareTo(sst.minKey()) < 0) hi = mid - 1;
            else if (key.compareTo(sst.maxKey()) > 0) lo = mid + 1;
            else return sst;
        }
        return null;
    }

    /**
     * Compaction: Merge overlapping SSTables into non-overlapping ones.
     *
     * Leveled compaction (used by LevelDB, RocksDB):
     * - Level L files are merged with overlapping Level L+1 files
     * - Produces new non-overlapping Level L+1 files
     * - Each level is 10x larger than the previous
     * - Read amplification: O(levels) = O(log N)
     * - Write amplification: O(10-30x) — each key may be rewritten
     *   as it is compacted through levels
     *
     * Size-tiered compaction (used by Cassandra):
     * - Group SSTables of similar size and merge them
     * - Lower write amplification but higher space amplification
     * - Better for write-heavy workloads
     */
    private void compact(int level) throws IOException {
        // Simplified leveled compaction
        List<SSTable> sourceFiles = levels.get(level);
        List<SSTable> targetFiles = levels.get(level + 1);

        // Merge all source files with overlapping target files
        List<SSTable> toMerge = new ArrayList<>(sourceFiles);
        // In production, only merge overlapping ranges

        // k-way merge of sorted files
        List<SSTable> merged = SSTable.merge(toMerge, dataDir, level + 1);

        // Replace files atomically
        levels.get(level).clear();
        levels.set(level + 1, new CopyOnWriteArrayList<>(merged));

        // Delete old files
        for (SSTable old : toMerge) {
            old.delete();
            bloomFilters.remove(old.filename());
        }
        for (SSTable sst : merged) {
            bloomFilters.put(sst.filename(), sst.bloomFilter());
        }
    }
}
```

### SSTable (Sorted String Table)

An SSTable is an immutable, sorted file on disk. Once written, it is never modified — only replaced during compaction.

```java
/**
 * SSTable: immutable sorted file with index and bloom filter.
 *
 * File format:
 * ┌──────────────────────┐
 * │ Data Blocks          │  Sorted key-value pairs, grouped in 4KB blocks
 * │   Block 0            │
 * │   Block 1            │
 * │   ...                │
 * ├──────────────────────┤
 * │ Index Block          │  Maps last key of each data block → offset
 * ├──────────────────────┤
 * │ Bloom Filter         │  Bit array for probabilistic membership test
 * ├──────────────────────┤
 * │ Footer               │  Offsets to index block and bloom filter
 * └──────────────────────┘
 */
public class SSTable {
    private final String filename;
    private final String minKey;
    private final String maxKey;
    private final NavigableMap<String, Long> sparseIndex; // key → file offset
    private final BloomFilter bloomFilter;
    private final RandomAccessFile file;

    // Private constructor — SSTables are created via flush() or merge()
    private SSTable(String filename, String minKey, String maxKey,
                    NavigableMap<String, Long> sparseIndex,
                    BloomFilter bloomFilter, RandomAccessFile file) {
        this.filename = filename;
        this.minKey = minKey;
        this.maxKey = maxKey;
        this.sparseIndex = sparseIndex;
        this.bloomFilter = bloomFilter;
        this.file = file;
    }

    /**
     * Flush a sorted memtable to disk as an SSTable.
     * O(N) sequential write — the memtable is already sorted.
     */
    public static SSTable flush(NavigableMap<String, byte[]> memtable,
                                 String dir) throws IOException {
        String filename = dir + "/sst_" + System.nanoTime() + ".db";
        NavigableMap<String, Long> index = new TreeMap<>();
        BloomFilter bf = new BloomFilter(memtable.size());

        try (DataOutputStream out = new DataOutputStream(
                new BufferedOutputStream(new FileOutputStream(filename), 65536))) {
            long offset = 0;
            int count = 0;

            for (Map.Entry<String, byte[]> entry : memtable.entrySet()) {
                String key = entry.getKey();
                byte[] value = entry.getValue();

                // Build sparse index (every 16th key)
                if (count % 16 == 0) {
                    index.put(key, offset);
                }

                // Add to bloom filter
                bf.add(key);

                // Write key-value pair
                byte[] keyBytes = key.getBytes("UTF-8");
                out.writeInt(keyBytes.length);
                out.write(keyBytes);
                out.writeInt(value.length);
                out.write(value);
                offset += 4 + keyBytes.length + 4 + value.length;
                count++;
            }
        }

        return new SSTable(filename,
                memtable.firstKey(), memtable.lastKey(),
                index, bf,
                new RandomAccessFile(filename, "r"));
    }

    /**
     * Search for a key in this SSTable.
     * 1. Check bloom filter (O(1))
     * 2. Binary search sparse index for the right block
     * 3. Sequential scan within the block
     */
    public byte[] get(String key) throws IOException {
        // Use sparse index to find the block
        Map.Entry<String, Long> entry = sparseIndex.floorEntry(key);
        if (entry == null) return null;

        // Seek to block start and scan
        file.seek(entry.getValue());
        while (file.getFilePointer() < file.length()) {
            int keyLen = file.readInt();
            byte[] keyBytes = new byte[keyLen];
            file.readFully(keyBytes);
            String readKey = new String(keyBytes, "UTF-8");

            int valueLen = file.readInt();
            byte[] value = new byte[valueLen];
            file.readFully(value);

            int cmp = readKey.compareTo(key);
            if (cmp == 0) return value;
            if (cmp > 0) return null; // Past the key — not found
        }
        return null;
    }

    /**
     * K-way merge of multiple SSTables.
     * Uses a min-heap (PriorityQueue) to efficiently merge K sorted streams.
     * Time: O(N log K) where N is total entries and K is number of files.
     * This is the same algorithm used in external merge sort.
     */
    public static List<SSTable> merge(List<SSTable> inputs, String dir,
                                       int targetLevel) throws IOException {
        // Use PriorityQueue for k-way merge
        PriorityQueue<MergeEntry> heap = new PriorityQueue<>(
            Comparator.comparing((MergeEntry e) -> e.key)
                      .thenComparingInt(e -> -e.sourceIndex) // newer wins ties
        );

        List<Iterator<Map.Entry<String, byte[]>>> iterators = new ArrayList<>();
        for (int i = 0; i < inputs.size(); i++) {
            Iterator<Map.Entry<String, byte[]>> it = inputs.get(i).iterator();
            if (it.hasNext()) {
                Map.Entry<String, byte[]> entry = it.next();
                heap.offer(new MergeEntry(entry.getKey(), entry.getValue(), i, it));
            }
        }

        // Merge into a new sorted stream
        NavigableMap<String, byte[]> merged = new TreeMap<>();
        String lastKey = null;

        while (!heap.isEmpty()) {
            MergeEntry entry = heap.poll();

            // Skip duplicate keys (keep the newest version)
            if (!entry.key.equals(lastKey)) {
                // Skip tombstones at the last level
                if (entry.value.length > 0 || targetLevel < 6) {
                    merged.put(entry.key, entry.value);
                }
                lastKey = entry.key;
            }

            // Advance the iterator for this source
            if (entry.iterator.hasNext()) {
                Map.Entry<String, byte[]> next = entry.iterator.next();
                heap.offer(new MergeEntry(next.getKey(), next.getValue(),
                                          entry.sourceIndex, entry.iterator));
            }

            // Flush when merged map is large enough (produce multiple output files)
            if (merged.size() >= 65536) {
                // Would flush to a new SSTable file here
            }
        }

        // Flush remaining
        List<SSTable> result = new ArrayList<>();
        if (!merged.isEmpty()) {
            result.add(SSTable.flush(merged, dir));
        }
        return result;
    }

    public String filename() { return filename; }
    public String minKey() { return minKey; }
    public String maxKey() { return maxKey; }
    public BloomFilter bloomFilter() { return bloomFilter; }

    public void delete() throws IOException {
        file.close();
        new java.io.File(filename).delete();
    }

    public Iterator<Map.Entry<String, byte[]>> iterator() {
        // Simplified: would read the file sequentially
        return Collections.emptyIterator();
    }

    private static class MergeEntry {
        String key;
        byte[] value;
        int sourceIndex;
        Iterator<Map.Entry<String, byte[]>> iterator;

        MergeEntry(String key, byte[] value, int sourceIndex,
                   Iterator<Map.Entry<String, byte[]>> iterator) {
            this.key = key;
            this.value = value;
            this.sourceIndex = sourceIndex;
            this.iterator = iterator;
        }
    }
}
```

### B+ Tree vs LSM Tree — When to Use Which

```
                        B+ Tree (InnoDB)          LSM Tree (RocksDB)
                        ─────────────────         ──────────────────
Write throughput        Moderate                  Excellent
                        (random I/O)              (sequential I/O)

Read latency            Excellent                 Good
                        (single tree walk)        (check multiple levels)

Range scans             Excellent                 Good
                        (follow leaf links)       (merge iterators)

Space amplification     Low (~1.5x)               Higher (~1.1-1.3x leveled)

Write amplification     1x (write once)           10-30x (rewrite during
                                                  compaction)

Read amplification      1x (one tree walk)        O(levels) with bloom
                                                  filters

Use case                OLTP, mixed workloads     Write-heavy, time-series,
                                                  event logs, key-value stores

Examples                MySQL/InnoDB              RocksDB, LevelDB,
                        PostgreSQL                Cassandra, HBase,
                        Oracle                    CockroachDB (storage layer)
```

---

## 12.3 Write-Ahead Log (WAL)

The WAL is arguably the most critical data structure in any database. It guarantees durability: once a transaction is committed, its effects survive any crash.

### The Protocol

```
Transaction Lifecycle:
1. BEGIN TRANSACTION
2. Write changes to WAL (sequential append) ← happens first
3. Acknowledge commit to client             ← "committed"
4. Apply changes to actual data pages       ← can happen later
5. Checkpoint: flush dirty pages, truncate WAL

Crash Recovery:
1. Read WAL from last checkpoint
2. Replay committed transactions (REDO)
3. Undo uncommitted transactions (UNDO)
```

The key guarantee: **the WAL is written BEFORE the data pages.** This is why it is called "write-ahead." If the system crashes after step 2 but before step 4, the WAL contains enough information to recover.

### WAL Implementation

```java
/**
 * Write-Ahead Log for crash recovery.
 *
 * Design principles:
 * - Append-only: never modify existing entries (sequential I/O)
 * - Sync on commit: fsync() ensures durability (no data in OS buffer cache)
 * - Group commit: batch multiple transactions into a single fsync()
 *
 * InnoDB WAL: ib_logfile0, ib_logfile1 (circular, default 48MB each)
 * PostgreSQL WAL: pg_wal/ directory, 16MB segment files
 */
public class WriteAheadLog implements Closeable {

    private final String directory;
    private FileChannel currentFile;
    private long currentLSN; // Log Sequence Number — monotonically increasing
    private final ByteBuffer writeBuffer;
    private final Lock writeLock = new ReentrantLock();

    // Group commit support
    private final List<CompletableFuture<Void>> pendingCommits = new ArrayList<>();
    private volatile long lastSyncedLSN = 0;

    public WriteAheadLog(String directory) throws IOException {
        this.directory = directory;
        new java.io.File(directory).mkdirs();
        this.currentFile = FileChannel.open(
            java.nio.file.Path.of(directory, "wal_" + System.currentTimeMillis() + ".log"),
            java.nio.file.StandardOpenOption.CREATE,
            java.nio.file.StandardOpenOption.APPEND,
            java.nio.file.StandardOpenOption.DSYNC // Every write is durable
        );
        this.currentLSN = 0;
        // 4MB write buffer for batching writes
        this.writeBuffer = ByteBuffer.allocateDirect(4 * 1024 * 1024);
    }

    /**
     * Append a key-value write to the WAL.
     * Returns the LSN (Log Sequence Number) for this entry.
     *
     * The LSN is crucial: it is the monotonic timestamp that orders
     * all changes in the database. InnoDB stores the LSN in every
     * page header to track which WAL entries have been applied.
     */
    public long append(String key, byte[] value) throws IOException {
        writeLock.lock();
        try {
            long lsn = currentLSN++;

            // WAL record format:
            // [LSN:8][key_length:4][key:var][value_length:4][value:var][checksum:4]
            byte[] keyBytes = key.getBytes("UTF-8");
            int recordSize = 8 + 4 + keyBytes.length + 4 + value.length + 4;

            if (writeBuffer.remaining() < recordSize) {
                flushBuffer();
            }

            writeBuffer.putLong(lsn);
            writeBuffer.putInt(keyBytes.length);
            writeBuffer.put(keyBytes);
            writeBuffer.putInt(value.length);
            writeBuffer.put(value);
            writeBuffer.putInt(computeChecksum(keyBytes, value));

            return lsn;
        } finally {
            writeLock.unlock();
        }
    }

    /**
     * Commit: ensure all WAL entries up to this LSN are durable.
     *
     * Group commit optimization: instead of fsync() per transaction,
     * batch multiple transactions and fsync() once.
     *
     * PostgreSQL group commit: waits up to commit_delay microseconds
     * to batch fsync() calls. With 100 concurrent transactions,
     * group commit reduces fsync() calls from 100/sec to ~10/sec,
     * a 10x throughput improvement.
     *
     * InnoDB: innodb_flush_log_at_trx_commit controls this:
     *   1 = fsync on every commit (safest, slowest)
     *   2 = write to OS buffer, fsync every second (faster, might lose 1s)
     *   0 = write to buffer, no fsync (fastest, unsafe)
     */
    public void commit(long lsn) throws IOException {
        writeLock.lock();
        try {
            if (lsn > lastSyncedLSN) {
                flushBuffer();
                currentFile.force(false); // fsync — force to stable storage
                lastSyncedLSN = currentLSN;
            }
        } finally {
            writeLock.unlock();
        }
    }

    /**
     * Checkpoint: signal that all data pages up to this LSN
     * have been written to their final location.
     * WAL entries before this LSN can be discarded.
     */
    public void checkpoint(long lsn) throws IOException {
        // Write checkpoint record
        append("__CHECKPOINT__", longToBytes(lsn));
        commit(currentLSN);
        // In production: truncate or recycle old WAL segments
    }

    /**
     * Recover: replay WAL entries after the last checkpoint.
     * This is called on database startup after a crash.
     */
    public List<WALEntry> recover() throws IOException {
        List<WALEntry> entries = new ArrayList<>();
        // Read all WAL files in order
        java.io.File dir = new java.io.File(directory);
        java.io.File[] walFiles = dir.listFiles((d, name) -> name.startsWith("wal_"));
        if (walFiles == null) return entries;

        Arrays.sort(walFiles); // Chronological order

        for (java.io.File f : walFiles) {
            try (DataInputStream in = new DataInputStream(
                    new BufferedInputStream(new FileInputStream(f)))) {
                while (in.available() > 0) {
                    try {
                        long lsn = in.readLong();
                        int keyLen = in.readInt();
                        byte[] keyBytes = new byte[keyLen];
                        in.readFully(keyBytes);
                        int valueLen = in.readInt();
                        byte[] value = new byte[valueLen];
                        in.readFully(value);
                        int checksum = in.readInt();

                        // Verify checksum — corrupted entries are discarded
                        if (checksum == computeChecksum(keyBytes, value)) {
                            entries.add(new WALEntry(lsn,
                                new String(keyBytes, "UTF-8"), value));
                        } else {
                            break; // Partial write — stop here
                        }
                    } catch (EOFException e) {
                        break; // Partial write at end of file
                    }
                }
            }
        }
        return entries;
    }

    public void rotate() throws IOException {
        writeLock.lock();
        try {
            flushBuffer();
            currentFile.force(false);
            currentFile.close();
            currentFile = FileChannel.open(
                java.nio.file.Path.of(directory, "wal_" + System.currentTimeMillis() + ".log"),
                java.nio.file.StandardOpenOption.CREATE,
                java.nio.file.StandardOpenOption.APPEND
            );
        } finally {
            writeLock.unlock();
        }
    }

    private void flushBuffer() throws IOException {
        writeBuffer.flip();
        while (writeBuffer.hasRemaining()) {
            currentFile.write(writeBuffer);
        }
        writeBuffer.clear();
    }

    private int computeChecksum(byte[] key, byte[] value) {
        int hash = 17;
        for (byte b : key) hash = hash * 31 + b;
        for (byte b : value) hash = hash * 31 + b;
        return hash;
    }

    private byte[] longToBytes(long v) {
        return ByteBuffer.allocate(8).putLong(v).array();
    }

    @Override
    public void close() throws IOException {
        flushBuffer();
        currentFile.force(false);
        currentFile.close();
    }

    public record WALEntry(long lsn, String key, byte[] value) {}
}
```

**JVM Insight**: We use `ByteBuffer.allocateDirect(4MB)` for the write buffer. Direct byte buffers are allocated off-heap in native memory — the GC does not scan them. This is critical for I/O-intensive paths: a heap-allocated `byte[]` would be copied by the JVM for every channel write (to pin it during the I/O system call), while a direct buffer avoids the copy entirely. This is the same reason Netty uses `PooledDirectByteBuf` for network I/O.

---

## 12.4 Query Plan Cache

When you execute `SELECT * FROM users WHERE id = ?`, the database must parse the SQL, validate table/column names, check permissions, generate candidate execution plans, cost-estimate them, and choose the optimal plan. This is expensive — potentially milliseconds of CPU time.

The query plan cache avoids re-doing this work for repeated queries.

### Implementation

```java
/**
 * Query Plan Cache: HashMap<fingerprint, PreparedPlan>
 *
 * PostgreSQL: uses a hash table of plans per prepared statement.
 * MySQL: Query Cache (deprecated in 8.0, removed) cached results, not plans.
 *        Prepared statements cache parse trees in the session.
 *
 * The fingerprint normalizes the query:
 *   "SELECT * FROM users WHERE id = 42"  →  "SELECT * FROM users WHERE id = ?"
 *   "SELECT * FROM users WHERE id = 99"  →  same fingerprint
 */
public class QueryPlanCache {

    private final Map<String, CachedPlan> cache;
    private final int maxSize;
    private final AtomicLong hits = new AtomicLong();
    private final AtomicLong misses = new AtomicLong();
    private final long schemaVersion;

    public QueryPlanCache(int maxSize) {
        this.maxSize = maxSize;
        this.schemaVersion = 0;
        // LinkedHashMap with access-order for LRU eviction
        this.cache = Collections.synchronizedMap(
            new LinkedHashMap<String, CachedPlan>(maxSize, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, CachedPlan> eldest) {
                    return size() > maxSize;
                }
            }
        );
    }

    /**
     * Get or compile a query plan.
     *
     * Fingerprinting: strip literals, normalize whitespace.
     * "SELECT * FROM users WHERE name = 'Alice' AND age > 30"
     * → "SELECT * FROM users WHERE name = ? AND age > ?"
     *
     * This is what pg_stat_statements does in PostgreSQL.
     */
    public QueryPlan getPlan(String sql, long currentSchemaVersion) {
        String fingerprint = fingerprint(sql);

        CachedPlan cached = cache.get(fingerprint);
        if (cached != null && cached.schemaVersion == currentSchemaVersion) {
            hits.incrementAndGet();
            return cached.plan;
        }

        // Cache miss or stale — compile new plan
        misses.incrementAndGet();
        QueryPlan plan = compilePlan(sql);
        cache.put(fingerprint, new CachedPlan(plan, currentSchemaVersion));
        return plan;
    }

    /**
     * Invalidate all plans when schema changes.
     * DDL (ALTER TABLE, CREATE INDEX) increments the schema version.
     * Stale plans reference dropped columns or missing indexes.
     *
     * PostgreSQL: invalidates plans via the sinval (shared invalidation) system.
     * InnoDB: prepared statement plan cache is per-session; ALTER TABLE
     *         closes all table handles, forcing re-preparation.
     */
    public void invalidateAll() {
        cache.clear();
    }

    public void invalidateTable(String tableName) {
        cache.entrySet().removeIf(e ->
            e.getValue().plan.referencedTables().contains(tableName));
    }

    /**
     * Normalize SQL to a fingerprint.
     * Replace all literal values with placeholders.
     */
    private String fingerprint(String sql) {
        return sql
            .replaceAll("'[^']*'", "?")        // String literals
            .replaceAll("\\b\\d+\\b", "?")      // Numeric literals
            .replaceAll("\\s+", " ")            // Normalize whitespace
            .trim()
            .toUpperCase();
    }

    private QueryPlan compilePlan(String sql) {
        // In a real database: parse → analyze → optimize → plan
        return new QueryPlan(sql, List.of(), "FULL_SCAN");
    }

    public double hitRate() {
        long total = hits.get() + misses.get();
        return total == 0 ? 0.0 : (double) hits.get() / total;
    }

    private record CachedPlan(QueryPlan plan, long schemaVersion) {}
    public record QueryPlan(String sql, List<String> referencedTables, String strategy) {}
}
```

---

## 12.5 Buffer Pool (Page Cache)

Databases do not read from disk on every query. They maintain a buffer pool — a large region of memory holding recently-accessed disk pages. The buffer pool is to a database what the CPU cache is to a processor.

### InnoDB Buffer Pool

InnoDB's buffer pool is typically 70-80% of available RAM (e.g., 100GB on a 128GB machine). It caches B+ tree pages, undo log pages, change buffer pages, and adaptive hash index entries.

```
┌──────────────────────────────────────────────────────┐
│                   Buffer Pool (e.g., 100 GB)          │
│                                                        │
│  ┌────────────────────────────────────────────────┐   │
│  │              Page Hash Table                    │   │
│  │  HashMap<(space_id, page_no), BufferPage>      │   │
│  │  O(1) lookup: "Is page 42 of table X cached?"  │   │
│  └────────────────────────────────────────────────┘   │
│                                                        │
│  ┌────────────────────────────────────────────────┐   │
│  │           LRU List (with midpoint)              │   │
│  │                                                  │   │
│  │  HOT end ←──── midpoint (5/8) ────→ COLD end   │   │
│  │  [frequently   [new pages        [eviction      │   │
│  │   accessed      inserted          candidates]    │   │
│  │   pages]        HERE]                            │   │
│  └────────────────────────────────────────────────┘   │
│                                                        │
│  ┌────────────────────────────────────────────────┐   │
│  │              Flush List                         │   │
│  │  Dirty pages ordered by oldest_modification LSN │   │
│  │  Background thread flushes oldest dirty pages   │   │
│  └────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

### Midpoint Insertion — Solving Scan Pollution

A naive LRU evicts the least recently used page. But consider a full table scan: it reads every page once, filling the buffer pool with pages that will never be accessed again, evicting frequently-used index pages. This is **scan pollution**.

InnoDB's solution: **midpoint insertion**. New pages enter the LRU list at the 5/8 point (the "old" sublist), not at the head. Only if a page is accessed again after `innodb_old_blocks_time` (default 1000ms), it is promoted to the "young" sublist (hot end).

A full table scan reads each page once. Each page enters the old sublist, is never re-accessed within 1000ms, and is evicted without polluting the hot end.

### Buffer Pool LRU Implementation

```java
/**
 * Buffer Pool with midpoint-insertion LRU.
 * Models InnoDB's buffer pool behavior.
 *
 * Key concepts:
 * - Page hash: O(1) lookup for cached pages
 * - LRU with midpoint: prevents scan pollution
 * - Pin count: prevent eviction of in-use pages
 * - Dirty page tracking: for write-back
 */
public class BufferPool {

    private static final int PAGE_SIZE = 16 * 1024; // 16KB, matching InnoDB

    private final int capacity;          // Max pages in pool
    private final int midpointPosition;  // Where new pages are inserted (5/8 from hot end)
    private final long oldBlocksTimeMs;  // Time before promotion to young sublist

    // Page hash table: O(1) lookup by (tableId, pageNo)
    private final Map<Long, BufferPage> pageHash;

    // LRU list: doubly-linked list for O(1) move-to-head and eviction
    private BufferPage lruHead; // Most recently used (hot end)
    private BufferPage lruTail; // Least recently used (cold end — eviction candidate)
    private int currentSize;

    // Dirty pages for write-back
    private final TreeMap<Long, BufferPage> flushList; // Ordered by oldest_modification LSN

    private final ReentrantLock lock = new ReentrantLock();

    // Stats
    private long hits;
    private long misses;

    public BufferPool(int capacityPages) {
        this.capacity = capacityPages;
        this.midpointPosition = capacityPages * 5 / 8;
        this.oldBlocksTimeMs = 1000; // innodb_old_blocks_time default
        this.pageHash = new HashMap<>(capacityPages * 2);
        this.flushList = new TreeMap<>();
        this.currentSize = 0;
    }

    /**
     * Fetch a page. Returns the cached version if available,
     * otherwise reads from disk.
     *
     * InnoDB flow:
     * 1. Hash lookup in page hash table → O(1)
     * 2. If hit: update LRU position (maybe promote to young sublist)
     * 3. If miss: evict a page from cold end, read from disk, insert at midpoint
     */
    public BufferPage fetchPage(int tableId, int pageNo) throws IOException {
        long pageKey = ((long) tableId << 32) | pageNo;

        lock.lock();
        try {
            BufferPage page = pageHash.get(pageKey);
            if (page != null) {
                hits++;
                // Promotion check: only promote if page has been in old sublist
                // long enough (prevents scan pollution)
                if (page.inOldSublist &&
                    System.currentTimeMillis() - page.firstAccessTime > oldBlocksTimeMs) {
                    moveToHead(page);
                    page.inOldSublist = false;
                }
                page.pinCount++;
                return page;
            }

            // Cache miss
            misses++;

            // Evict if necessary
            if (currentSize >= capacity) {
                evict();
            }

            // Read page from disk (simulated)
            byte[] data = readPageFromDisk(tableId, pageNo);
            page = new BufferPage(pageKey, tableId, pageNo, data);
            page.firstAccessTime = System.currentTimeMillis();
            page.inOldSublist = true;
            page.pinCount = 1;

            // Insert at midpoint (not head)
            insertAtMidpoint(page);
            pageHash.put(pageKey, page);
            currentSize++;

            return page;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Release a page (unpin it so it can be evicted).
     */
    public void releasePage(BufferPage page) {
        lock.lock();
        try {
            page.pinCount--;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Mark a page as dirty (modified).
     * Dirty pages must be flushed to disk before eviction.
     */
    public void markDirty(BufferPage page, long lsn) {
        lock.lock();
        try {
            if (!page.isDirty) {
                page.isDirty = true;
                page.oldestModificationLSN = lsn;
                flushList.put(lsn, page);
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * Evict the coldest unpinned page.
     * InnoDB scans from the tail of the LRU list for an unpinned page.
     */
    private void evict() throws IOException {
        BufferPage victim = lruTail;
        while (victim != null && victim.pinCount > 0) {
            victim = victim.prev;
        }
        if (victim == null) {
            throw new IOException("Buffer pool exhausted — all pages pinned");
        }

        // Write dirty page to disk before eviction
        if (victim.isDirty) {
            writePageToDisk(victim);
            flushList.remove(victim.oldestModificationLSN);
        }

        removeFromLRU(victim);
        pageHash.remove(victim.pageKey);
        currentSize--;
    }

    /**
     * Background flush: write oldest dirty pages to disk.
     * This reduces the cost of eviction (fewer synchronous writes).
     * InnoDB's page cleaner threads do this continuously.
     */
    public void backgroundFlush(int pagesToFlush) throws IOException {
        lock.lock();
        try {
            Iterator<Map.Entry<Long, BufferPage>> it = flushList.entrySet().iterator();
            int flushed = 0;
            while (it.hasNext() && flushed < pagesToFlush) {
                BufferPage page = it.next().getValue();
                if (page.pinCount == 0) {
                    writePageToDisk(page);
                    page.isDirty = false;
                    it.remove();
                    flushed++;
                }
            }
        } finally {
            lock.unlock();
        }
    }

    // --- LRU list operations (all O(1) with doubly-linked list) ---

    private void moveToHead(BufferPage page) {
        removeFromLRU(page);
        addToHead(page);
    }

    private void addToHead(BufferPage page) {
        page.prev = null;
        page.next = lruHead;
        if (lruHead != null) lruHead.prev = page;
        lruHead = page;
        if (lruTail == null) lruTail = page;
    }

    private void insertAtMidpoint(BufferPage page) {
        if (currentSize < midpointPosition || lruHead == null) {
            addToHead(page);
            return;
        }
        // Walk to midpoint position
        BufferPage current = lruHead;
        for (int i = 0; i < midpointPosition - 1 && current.next != null; i++) {
            current = current.next;
        }
        // Insert after 'current'
        page.next = current.next;
        page.prev = current;
        if (current.next != null) current.next.prev = page;
        else lruTail = page;
        current.next = page;
    }

    private void removeFromLRU(BufferPage page) {
        if (page.prev != null) page.prev.next = page.next;
        else lruHead = page.next;
        if (page.next != null) page.next.prev = page.prev;
        else lruTail = page.prev;
        page.prev = null;
        page.next = null;
    }

    private byte[] readPageFromDisk(int tableId, int pageNo) {
        return new byte[PAGE_SIZE]; // Simulated
    }

    private void writePageToDisk(BufferPage page) {
        // Simulated disk write
    }

    public double hitRate() {
        long total = hits + misses;
        return total == 0 ? 0 : (double) hits / total;
    }

    // --- Buffer Page ---

    public static class BufferPage {
        final long pageKey;
        final int tableId;
        final int pageNo;
        byte[] data;

        // LRU linked list pointers
        BufferPage prev;
        BufferPage next;

        // State
        int pinCount;
        boolean isDirty;
        long oldestModificationLSN;
        boolean inOldSublist;
        long firstAccessTime;

        BufferPage(long pageKey, int tableId, int pageNo, byte[] data) {
            this.pageKey = pageKey;
            this.tableId = tableId;
            this.pageNo = pageNo;
            this.data = data;
        }
    }
}
```

### PostgreSQL Clock-Sweep

PostgreSQL uses a different algorithm: **clock-sweep** (a variant of the CLOCK page replacement algorithm). It is simpler than LRU and avoids the overhead of maintaining a doubly-linked list.

```java
/**
 * Clock-sweep buffer replacement, as used by PostgreSQL.
 *
 * Each buffer has a "usage count" (0-5). On access, the count
 * is incremented (up to 5). On eviction, a clock hand sweeps
 * through buffers, decrementing usage counts. A buffer with
 * usage count 0 is evicted.
 *
 * Advantage over LRU: no linked-list maintenance on every access.
 * The clock hand is a single integer. Access is just an atomic
 * increment of the usage count.
 */
public class ClockSweepPool {

    private final BufferSlot[] buffers;
    private final Map<Long, Integer> pageIndex; // pageKey → slot index
    private final int capacity;
    private int clockHand;

    public ClockSweepPool(int capacity) {
        this.capacity = capacity;
        this.buffers = new BufferSlot[capacity];
        this.pageIndex = new HashMap<>(capacity * 2);
        this.clockHand = 0;
        for (int i = 0; i < capacity; i++) {
            buffers[i] = new BufferSlot();
        }
    }

    public byte[] fetchPage(long pageKey) {
        Integer slotIdx = pageIndex.get(pageKey);
        if (slotIdx != null) {
            BufferSlot slot = buffers[slotIdx];
            // Increment usage count (cap at 5)
            if (slot.usageCount < 5) slot.usageCount++;
            return slot.data;
        }

        // Cache miss — find a victim via clock sweep
        int victimSlot = findVictim();

        // Evict victim
        if (buffers[victimSlot].pageKey != -1) {
            if (buffers[victimSlot].dirty) {
                flushToDisk(buffers[victimSlot]);
            }
            pageIndex.remove(buffers[victimSlot].pageKey);
        }

        // Load new page
        byte[] data = readFromDisk(pageKey);
        buffers[victimSlot].pageKey = pageKey;
        buffers[victimSlot].data = data;
        buffers[victimSlot].usageCount = 1;
        buffers[victimSlot].dirty = false;
        buffers[victimSlot].pinCount = 0;
        pageIndex.put(pageKey, victimSlot);

        return data;
    }

    /**
     * Clock sweep: rotate through buffers, decrementing usage counts.
     * Evict the first buffer with usage count 0.
     *
     * Frequently accessed pages have high usage counts (up to 5),
     * so the clock hand passes over them multiple times before eviction.
     * Infrequently accessed pages drop to 0 quickly.
     */
    private int findVictim() {
        while (true) {
            BufferSlot slot = buffers[clockHand];
            if (slot.pinCount == 0) {
                if (slot.usageCount == 0) {
                    int victim = clockHand;
                    clockHand = (clockHand + 1) % capacity;
                    return victim;
                }
                slot.usageCount--; // Give it another chance
            }
            clockHand = (clockHand + 1) % capacity;
        }
    }

    private byte[] readFromDisk(long pageKey) { return new byte[8192]; }
    private void flushToDisk(BufferSlot slot) { /* write to disk */ }

    static class BufferSlot {
        long pageKey = -1;
        byte[] data;
        int usageCount;
        boolean dirty;
        int pinCount;
    }
}
```

---

## 12.6 Inverted Index (Elasticsearch/Lucene)

When you search for "java concurrency tutorial" in Elasticsearch, it does not scan every document. It uses an **inverted index** — a mapping from every term to the list of documents containing that term.

### Structure

```
Document 0: "Java concurrency is hard"
Document 1: "Python concurrency is easy"
Document 2: "Java performance tuning guide"

Inverted Index:
Term            → Posting List (doc IDs + positions)
─────────────────────────────────────────────────
"concurrency"   → [(doc:0, pos:1), (doc:1, pos:1)]
"easy"          → [(doc:1, pos:3)]
"guide"         → [(doc:2, pos:3)]
"hard"          → [(doc:0, pos:3)]
"is"            → [(doc:0, pos:2), (doc:1, pos:2)]
"java"          → [(doc:0, pos:0), (doc:2, pos:0)]
"performance"   → [(doc:2, pos:1)]
"python"        → [(doc:1, pos:0)]
"tuning"        → [(doc:2, pos:2)]
```

**Query "java concurrency"**: Intersect posting lists for "java" and "concurrency":
- "java": {0, 2}
- "concurrency": {0, 1}
- Intersection: {0} → Document 0 matches

### Full Implementation with TF-IDF Scoring

```java
import java.util.*;
import java.util.stream.*;

/**
 * Inverted Index with TF-IDF scoring.
 *
 * Lucene's inverted index is far more sophisticated:
 * - Terms stored in a FST (Finite State Transducer) for prefix compression
 * - Posting lists compressed with variable-byte encoding (PForDelta)
 * - Skip lists within posting lists for fast intersection
 * - Per-field indexes
 * - Doc values for sorting/aggregation (column-oriented storage)
 *
 * But the core concept is exactly this: term → sorted doc ID list.
 */
public class InvertedIndex {

    // Term → PostingList (sorted by docId for efficient intersection)
    private final Map<String, PostingList> index;
    private final Map<Integer, String> documents;     // docId → original text
    private final Map<Integer, Integer> docLengths;   // docId → term count
    private int totalDocs;
    private double avgDocLength;

    public InvertedIndex() {
        this.index = new HashMap<>();
        this.documents = new HashMap<>();
        this.docLengths = new HashMap<>();
        this.totalDocs = 0;
        this.avgDocLength = 0;
    }

    /**
     * Index a document.
     * Pipeline: tokenize → lowercase → stem → insert into posting lists.
     *
     * Lucene's analysis pipeline:
     * 1. CharFilter: strip HTML, normalize unicode
     * 2. Tokenizer: split on whitespace/punctuation
     * 3. TokenFilter: lowercase, stop word removal, stemming (Porter),
     *    synonym expansion, n-gram generation
     */
    public void addDocument(int docId, String text) {
        documents.put(docId, text);

        // Tokenize and normalize
        List<String> tokens = tokenize(text);
        docLengths.put(docId, tokens.size());
        totalDocs++;
        avgDocLength = docLengths.values().stream()
            .mapToInt(Integer::intValue).average().orElse(0);

        // Build posting list entries with positions
        Map<String, List<Integer>> termPositions = new HashMap<>();
        for (int pos = 0; pos < tokens.size(); pos++) {
            String term = tokens.get(pos);
            termPositions.computeIfAbsent(term, k -> new ArrayList<>()).add(pos);
        }

        // Insert into inverted index
        for (Map.Entry<String, List<Integer>> entry : termPositions.entrySet()) {
            String term = entry.getKey();
            List<Integer> positions = entry.getValue();
            int termFreq = positions.size();

            index.computeIfAbsent(term, k -> new PostingList())
                 .addPosting(new Posting(docId, termFreq, positions));
        }
    }

    /**
     * Boolean AND query: intersect posting lists.
     *
     * Algorithm: two-pointer merge on sorted posting lists.
     * Time: O(min(|P1|, |P2|)) with skip pointers
     * Without skip pointers: O(|P1| + |P2|)
     *
     * Lucene uses skip lists within posting lists to jump ahead
     * when one list is much shorter than the other.
     */
    public List<SearchResult> search(String query) {
        List<String> queryTerms = tokenize(query);
        if (queryTerms.isEmpty()) return Collections.emptyList();

        // Get posting lists for all query terms
        List<PostingList> postingLists = queryTerms.stream()
            .map(index::get)
            .filter(Objects::nonNull)
            .sorted(Comparator.comparingInt(PostingList::size)) // Process shortest first
            .collect(Collectors.toList());

        if (postingLists.isEmpty()) return Collections.emptyList();

        // Intersect posting lists (AND semantics)
        Set<Integer> matchingDocs = new HashSet<>(postingLists.get(0).getDocIds());
        for (int i = 1; i < postingLists.size(); i++) {
            matchingDocs.retainAll(postingLists.get(i).getDocIds());
        }

        // Score matching documents using TF-IDF
        List<SearchResult> results = new ArrayList<>();
        for (int docId : matchingDocs) {
            double score = 0;
            for (String term : queryTerms) {
                PostingList pl = index.get(term);
                if (pl != null) {
                    Posting posting = pl.getPosting(docId);
                    if (posting != null) {
                        score += tfidf(posting.termFreq, pl.size(),
                                      totalDocs, docLengths.get(docId));
                    }
                }
            }
            results.add(new SearchResult(docId, score, documents.get(docId)));
        }

        // Sort by score descending
        results.sort(Comparator.comparingDouble(SearchResult::score).reversed());
        return results;
    }

    /**
     * TF-IDF scoring.
     *
     * TF (Term Frequency): how often the term appears in this document.
     *   tf = sqrt(termFreq)  — sublinear scaling (10 occurrences != 10x more relevant)
     *
     * IDF (Inverse Document Frequency): how rare the term is across all documents.
     *   idf = log(totalDocs / docFreq)  — rare terms are more discriminating
     *
     * Lucene/Elasticsearch uses BM25 by default (since ES 5.0), which adds:
     * - Document length normalization
     * - Saturation function for TF (diminishing returns)
     */
    private double tfidf(int termFreq, int docFreq, int totalDocs, int docLength) {
        double tf = Math.sqrt(termFreq);
        double idf = Math.log((double) totalDocs / docFreq);
        double lengthNorm = 1.0 / Math.sqrt(docLength); // Favor shorter docs
        return tf * idf * lengthNorm;
    }

    /**
     * Phrase query: find documents where terms appear in exact order.
     * "java concurrency" matches "Java concurrency is hard" but not "concurrency in Java".
     *
     * Uses positional information in postings.
     */
    public List<SearchResult> phraseSearch(String phrase) {
        List<String> terms = tokenize(phrase);
        if (terms.size() < 2) return search(phrase);

        // Get posting lists
        List<PostingList> postingLists = terms.stream()
            .map(index::get)
            .collect(Collectors.toList());

        if (postingLists.stream().anyMatch(Objects::isNull)) {
            return Collections.emptyList();
        }

        // Find documents containing all terms
        Set<Integer> candidates = new HashSet<>(postingLists.get(0).getDocIds());
        for (PostingList pl : postingLists) {
            candidates.retainAll(pl.getDocIds());
        }

        // Check positional constraints
        List<SearchResult> results = new ArrayList<>();
        for (int docId : candidates) {
            // Get positions for the first term
            List<Integer> positions = postingLists.get(0).getPosting(docId).positions;
            for (int startPos : positions) {
                boolean match = true;
                for (int i = 1; i < terms.size(); i++) {
                    Posting posting = postingLists.get(i).getPosting(docId);
                    if (!posting.positions.contains(startPos + i)) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    results.add(new SearchResult(docId, 1.0, documents.get(docId)));
                    break; // Found at least one position match
                }
            }
        }
        return results;
    }

    private List<String> tokenize(String text) {
        return Arrays.stream(text.toLowerCase().split("[^a-z0-9]+"))
            .filter(s -> !s.isEmpty())
            .filter(s -> !STOP_WORDS.contains(s)) // Remove stop words
            .map(this::stem)                        // Apply simple stemming
            .collect(Collectors.toList());
    }

    /**
     * Extremely simplified Porter stemmer.
     * Real systems use Lucene's PorterStemFilter or Snowball stemmer.
     */
    private String stem(String word) {
        if (word.endsWith("ing") && word.length() > 5) {
            return word.substring(0, word.length() - 3);
        }
        if (word.endsWith("ed") && word.length() > 4) {
            return word.substring(0, word.length() - 2);
        }
        if (word.endsWith("s") && !word.endsWith("ss") && word.length() > 3) {
            return word.substring(0, word.length() - 1);
        }
        return word;
    }

    private static final Set<String> STOP_WORDS = Set.of(
        "a", "an", "the", "is", "are", "was", "were", "be", "been",
        "in", "on", "at", "to", "for", "of", "and", "or", "not", "it"
    );

    // --- Data classes ---

    static class PostingList {
        private final TreeMap<Integer, Posting> postings = new TreeMap<>(); // docId → Posting

        void addPosting(Posting posting) {
            postings.put(posting.docId, posting);
        }

        int size() { return postings.size(); }
        Set<Integer> getDocIds() { return postings.keySet(); }
        Posting getPosting(int docId) { return postings.get(docId); }
    }

    record Posting(int docId, int termFreq, List<Integer> positions) {}
    public record SearchResult(int docId, double score, String document) {}
}
```

**JVM Insight**: In Lucene, posting lists are stored as compressed integer arrays on disk, not as `TreeMap` objects. Lucene uses techniques like PForDelta encoding and variable-byte encoding to compress doc ID deltas to 1-2 bytes per doc ID (instead of 4 bytes for an `int`). The in-memory representation during query processing uses primitive `int[]` arrays allocated from a reusable buffer pool to minimize GC pressure. When Elasticsearch reports "32GB heap for 500M documents," most of that heap is Lucene's field caches, segment readers, and the doc values (column store), not the inverted index itself — which lives mostly on disk in memory-mapped files accessed via `MappedByteBuffer`.

---

## 12.7 Bitmap Indexes

When a column has low cardinality (few distinct values) — like `gender`, `status`, `country` — bitmap indexes shine. Instead of a B+ tree or hash index, we store one bit per row per distinct value.

### Concept

```
Table (8 rows):
Row  | Status
─────|────────
 0   | ACTIVE
 1   | INACTIVE
 2   | ACTIVE
 3   | PENDING
 4   | ACTIVE
 5   | INACTIVE
 6   | PENDING
 7   | ACTIVE

Bitmap Index on Status:
ACTIVE:   [1, 0, 1, 0, 1, 0, 0, 1]  = 0b10101001 (bitset)
INACTIVE: [0, 1, 0, 0, 0, 1, 0, 0]  = 0b01000100
PENDING:  [0, 0, 0, 1, 0, 0, 1, 0]  = 0b00010010

Query: WHERE status = 'ACTIVE' AND country = 'US'
  bitmap_active   = [1, 0, 1, 0, 1, 0, 0, 1]
  bitmap_us       = [1, 1, 0, 0, 1, 1, 0, 1]
  AND result      = [1, 0, 0, 0, 1, 0, 0, 1]  → rows 0, 4, 7
  
One CPU instruction (AND on 64-bit words) processes 64 rows at once.
```

### Implementation with Roaring Bitmaps

```java
import java.util.*;

/**
 * Bitmap Index for low-cardinality columns.
 *
 * Uses Java's BitSet internally. For production use, switch to
 * Roaring Bitmaps (org.roaringbitmap:RoaringBitmap) which compress
 * sparse bitmaps using run-length encoding + array containers.
 *
 * Used by:
 * - Apache Druid: bitmap indexes on all dimensions
 * - Apache Pinot: bitmap indexes for filter queries
 * - Oracle: bitmap indexes (CREATE BITMAP INDEX ...)
 * - ClickHouse: bitmap functions for analytics
 */
public class BitmapIndex<V> {

    private final Map<V, BitSet> bitmaps;  // value → bitmap of matching row IDs
    private int rowCount;

    public BitmapIndex() {
        this.bitmaps = new HashMap<>();
        this.rowCount = 0;
    }

    /**
     * Add a row to the index.
     */
    public void addRow(int rowId, V value) {
        bitmaps.computeIfAbsent(value, k -> new BitSet()).set(rowId);
        rowCount = Math.max(rowCount, rowId + 1);
    }

    /**
     * Equality query: WHERE column = value
     * O(1) to get the bitmap, O(N/64) to scan it.
     */
    public BitSet eq(V value) {
        BitSet result = bitmaps.get(value);
        return result != null ? (BitSet) result.clone() : new BitSet();
    }

    /**
     * AND: WHERE column1 = v1 AND column2 = v2
     * One CPU instruction per 64 rows — massively parallel.
     *
     * For 100M rows: 100M / 64 = 1.56M AND operations.
     * At 1 GHz, this takes ~1.5ms. Compare with 100M row scans.
     */
    public static BitSet and(BitSet a, BitSet b) {
        BitSet result = (BitSet) a.clone();
        result.and(b);
        return result;
    }

    /**
     * OR: WHERE column = v1 OR column = v2
     */
    public static BitSet or(BitSet a, BitSet b) {
        BitSet result = (BitSet) a.clone();
        result.or(b);
        return result;
    }

    /**
     * NOT: WHERE column != value
     */
    public BitSet not(V value) {
        BitSet result = eq(value);
        result.flip(0, rowCount);
        return result;
    }

    /**
     * IN: WHERE column IN (v1, v2, v3)
     */
    public BitSet in(Collection<V> values) {
        BitSet result = new BitSet();
        for (V value : values) {
            BitSet bm = bitmaps.get(value);
            if (bm != null) result.or(bm);
        }
        return result;
    }

    /**
     * Count matching rows.
     * BitSet.cardinality() uses Long.bitCount() which maps to
     * the POPCNT CPU instruction — counts set bits in one cycle.
     */
    public static int count(BitSet bitmap) {
        return bitmap.cardinality();
    }

    /**
     * Get matching row IDs from a bitmap.
     */
    public static List<Integer> toRowIds(BitSet bitmap) {
        List<Integer> rows = new ArrayList<>();
        for (int i = bitmap.nextSetBit(0); i >= 0; i = bitmap.nextSetBit(i + 1)) {
            rows.add(i);
        }
        return rows;
    }

    /**
     * Memory estimation.
     * Dense bitmap: N/8 bytes per distinct value.
     * For 100M rows, 10 distinct values: 10 × 100M/8 = 125 MB
     *
     * Roaring Bitmap compression for sparse bitmaps:
     * - Divides the ID space into chunks of 2^16
     * - Dense chunks (>4096 set bits): store as 8KB bitmap
     * - Sparse chunks (<4096 set bits): store as sorted short array
     * - Run-length chunks: store as runs of consecutive bits
     * - Typically 10-100x smaller than dense BitSet for real data
     */
    public long estimatedSizeBytes() {
        long size = 0;
        for (BitSet bs : bitmaps.values()) {
            size += bs.size() / 8; // BitSet.size() returns capacity in bits
        }
        return size;
    }
}

/**
 * Simplified Roaring Bitmap container to illustrate the compression idea.
 *
 * Real Roaring Bitmaps (used by Lucene, Druid, Spark) use three container types:
 * 1. ArrayContainer: sorted short[] for sparse chunks (<4096 values)
 * 2. BitmapContainer: long[1024] for dense chunks (>=4096 values)
 * 3. RunContainer: run-length encoded for sequential ranges
 *
 * The key insight: choose the container type dynamically based on density.
 * Sparse data uses arrays (small), dense data uses bitmaps (fast),
 * sequential data uses runs (tiny).
 */
class RoaringBitmapSimplified {

    // Each chunk covers 2^16 = 65536 values
    private final TreeMap<Short, Container> chunks = new TreeMap<>();

    public void add(int value) {
        short highBits = (short) (value >>> 16);
        short lowBits = (short) (value & 0xFFFF);
        chunks.computeIfAbsent(highBits, k -> new ArrayContainer()).add(lowBits);
    }

    public boolean contains(int value) {
        short highBits = (short) (value >>> 16);
        short lowBits = (short) (value & 0xFFFF);
        Container c = chunks.get(highBits);
        return c != null && c.contains(lowBits);
    }

    interface Container {
        void add(short value);
        boolean contains(short value);
    }

    static class ArrayContainer implements Container {
        short[] values = new short[4];
        int size = 0;

        @Override
        public void add(short value) {
            int idx = Arrays.binarySearch(values, 0, size, value);
            if (idx >= 0) return; // Already present
            int insertPos = -(idx + 1);
            if (size == values.length) {
                values = Arrays.copyOf(values, values.length * 2);
            }
            System.arraycopy(values, insertPos, values, insertPos + 1, size - insertPos);
            values[insertPos] = value;
            size++;
            // If size > 4096, convert to BitmapContainer (not shown)
        }

        @Override
        public boolean contains(short value) {
            return Arrays.binarySearch(values, 0, size, value) >= 0;
        }
    }
}
```

**JVM Insight**: Java's `BitSet` is backed by a `long[]` array. The `and()`, `or()`, and `xor()` operations iterate over the array doing `word[i] &= other.word[i]` — one 64-bit operation per 64 rows. The JIT compiler vectorizes this loop using AVX2 instructions, processing 256 bits (256 rows) per CPU instruction. `BitSet.cardinality()` calls `Long.bitCount()`, which the JIT compiles to the x86 `POPCNT` instruction — counting 64 set bits in a single cycle. This is why bitmap operations on 100 million rows take milliseconds, not seconds.

---

## 12.8 Time-Series Storage

Time-series databases (InfluxDB, TimescaleDB, Prometheus) store metrics with timestamps: CPU usage every second, stock prices every millisecond, IoT sensor readings. The access pattern is unique: always appending at the current time, querying recent data far more than old data, and aggregating over time windows.

### Ring Buffer for Recent Data

```java
/**
 * Ring buffer (circular buffer) for time-series data.
 * Stores the most recent N data points with O(1) append.
 *
 * Used by:
 * - Prometheus: in-memory head block (last 2 hours)
 * - Grafana: recent data rendering
 * - Metrics libraries (Micrometer, Dropwizard): sliding window stats
 */
public class TimeSeriesRingBuffer {

    private final long[] timestamps;
    private final double[] values;
    private final int capacity;
    private int head;       // Next write position
    private int size;
    private long totalCount;

    public TimeSeriesRingBuffer(int capacity) {
        this.capacity = capacity;
        this.timestamps = new long[capacity];
        this.values = new double[capacity];
        this.head = 0;
        this.size = 0;
    }

    /**
     * Append a data point. O(1).
     * Overwrites the oldest point when full — no allocation, no GC.
     */
    public void append(long timestamp, double value) {
        timestamps[head] = timestamp;
        values[head] = value;
        head = (head + 1) % capacity;
        if (size < capacity) size++;
        totalCount++;
    }

    /**
     * Query a time range. O(N) scan within the ring buffer.
     * Since data is ordered by insertion time, we scan and filter.
     *
     * Production systems use a time-partitioned index to avoid scanning
     * the entire buffer.
     */
    public List<DataPoint> query(long startTime, long endTime) {
        List<DataPoint> results = new ArrayList<>();
        int start = (head - size + capacity) % capacity;
        for (int i = 0; i < size; i++) {
            int idx = (start + i) % capacity;
            if (timestamps[idx] >= startTime && timestamps[idx] <= endTime) {
                results.add(new DataPoint(timestamps[idx], values[idx]));
            }
        }
        return results;
    }

    /**
     * Downsampling: reduce resolution for older data.
     * Keep 1-second resolution for last hour,
     * 1-minute averages for last day,
     * 1-hour averages for last month.
     *
     * This is how Prometheus and InfluxDB manage storage:
     * raw data compacts into progressively coarser aggregates.
     */
    public List<DataPoint> downsample(long startTime, long endTime,
                                       long bucketSizeMs) {
        Map<Long, DoubleSummaryStatistics> buckets = new TreeMap<>();

        int start = (head - size + capacity) % capacity;
        for (int i = 0; i < size; i++) {
            int idx = (start + i) % capacity;
            if (timestamps[idx] >= startTime && timestamps[idx] <= endTime) {
                long bucketKey = (timestamps[idx] / bucketSizeMs) * bucketSizeMs;
                buckets.computeIfAbsent(bucketKey, k -> new DoubleSummaryStatistics())
                       .accept(values[idx]);
            }
        }

        return buckets.entrySet().stream()
            .map(e -> new DataPoint(e.getKey(), e.getValue().getAverage()))
            .collect(Collectors.toList());
    }

    /**
     * Aggregation functions on a time window.
     */
    public double average(long startTime, long endTime) {
        double sum = 0;
        int count = 0;
        int start = (head - size + capacity) % capacity;
        for (int i = 0; i < size; i++) {
            int idx = (start + i) % capacity;
            if (timestamps[idx] >= startTime && timestamps[idx] <= endTime) {
                sum += values[idx];
                count++;
            }
        }
        return count > 0 ? sum / count : 0;
    }

    public int size() { return size; }
    public long totalCount() { return totalCount; }

    public record DataPoint(long timestamp, double value) {}
}
```

### Append-Only Time-Series File

```java
/**
 * Time-series storage file with timestamp ordering.
 * Data is written in append-only fashion (like an SSTable)
 * and indexed by time ranges for efficient queries.
 *
 * Prometheus TSDB: stores 2-hour blocks, each with:
 * - chunks/ directory: compressed time-series data
 * - index: series ID → chunk offsets
 * - meta.json: block metadata
 * - tombstones: deleted series
 *
 * InfluxDB TSM (Time-Structured Merge Tree):
 * - WAL → in-memory cache → TSM files (sorted by time)
 * - Compression: delta-of-delta for timestamps, XOR for floats
 *   (Gorilla compression — Facebook's paper)
 */
public class TimeSeriesFile {

    private final String filename;
    private final DataOutputStream writer;
    private long minTimestamp = Long.MAX_VALUE;
    private long maxTimestamp = Long.MIN_VALUE;
    private int count;

    // Sparse index: timestamp → file offset (every 1000th point)
    private final TreeMap<Long, Long> timeIndex = new TreeMap<>();
    private long currentOffset;

    public TimeSeriesFile(String filename) throws IOException {
        this.filename = filename;
        this.writer = new DataOutputStream(
            new BufferedOutputStream(new FileOutputStream(filename), 65536));
        this.currentOffset = 0;
    }

    /**
     * Append a data point. Must be called with non-decreasing timestamps.
     *
     * Compression techniques used by production time-series DBs:
     * 1. Delta-of-delta encoding for timestamps:
     *    timestamps: [1000, 1010, 1020, 1030]
     *    deltas:     [-, 10, 10, 10]
     *    delta-of-delta: [-, -, 0, 0]  → mostly zeros → compresses well
     *
     * 2. XOR encoding for float values (Gorilla):
     *    xor(prev, current) is often small → few significant bits
     *    Store: leading zeros count + meaningful bits + trailing zeros count
     */
    public void append(long timestamp, double value) throws IOException {
        if (count % 1000 == 0) {
            timeIndex.put(timestamp, currentOffset);
        }

        writer.writeLong(timestamp);
        writer.writeDouble(value);
        currentOffset += 16;

        minTimestamp = Math.min(minTimestamp, timestamp);
        maxTimestamp = Math.max(maxTimestamp, timestamp);
        count++;
    }

    public void close() throws IOException {
        writer.flush();
        writer.close();
    }

    public long minTimestamp() { return minTimestamp; }
    public long maxTimestamp() { return maxTimestamp; }
    public int count() { return count; }
}
```

---

## 12.9 Bloom Filter (Quick Refresher for Storage Context)

Bloom filters appear throughout storage engines. They are the first line of defense against unnecessary disk reads.

```java
/**
 * Bloom filter for probabilistic membership testing.
 *
 * False positive rate ≈ (1 - e^(-kn/m))^k
 * where k = number of hash functions, n = elements, m = bits
 *
 * Optimal k = (m/n) * ln(2)
 * For 1% FP rate: ~10 bits per element, 7 hash functions
 *
 * Used by:
 * - LevelDB/RocksDB: per-SSTable bloom filter (skip files that don't have the key)
 * - Cassandra: per-SSTable (and per-partition) bloom filter
 * - HBase: per-StoreFile bloom filter
 * - InnoDB: NOT used (relies on B+ tree binary search)
 */
public class BloomFilter {

    private final BitSet bits;
    private final int numBits;
    private final int numHashFunctions;
    private int count;

    public BloomFilter(int expectedElements) {
        this(expectedElements, 0.01); // 1% false positive rate
    }

    public BloomFilter(int expectedElements, double falsePositiveRate) {
        // Calculate optimal number of bits
        this.numBits = (int) (-expectedElements * Math.log(falsePositiveRate) /
                              (Math.log(2) * Math.log(2)));
        this.numHashFunctions = Math.max(1, (int) Math.round(
            (double) numBits / expectedElements * Math.log(2)));
        this.bits = new BitSet(numBits);
    }

    public void add(String key) {
        long hash1 = murmurHash(key, 0);
        long hash2 = murmurHash(key, hash1);
        for (int i = 0; i < numHashFunctions; i++) {
            int idx = (int) (Math.abs(hash1 + i * hash2) % numBits);
            bits.set(idx);
        }
        count++;
    }

    /**
     * Test if key MIGHT be in the set.
     * Returns false: DEFINITELY not in set (100% certain)
     * Returns true: PROBABLY in set (with falsePositiveRate chance of being wrong)
     *
     * In RocksDB, this saves a disk read ~99% of the time for keys
     * not in an SSTable. Without bloom filters, every SSTable would
     * need a binary search on its index block.
     */
    public boolean mightContain(String key) {
        long hash1 = murmurHash(key, 0);
        long hash2 = murmurHash(key, hash1);
        for (int i = 0; i < numHashFunctions; i++) {
            int idx = (int) (Math.abs(hash1 + i * hash2) % numBits);
            if (!bits.get(idx)) return false;
        }
        return true;
    }

    private long murmurHash(String key, long seed) {
        long h = seed;
        for (int i = 0; i < key.length(); i++) {
            h = h * 0x5bd1e9955bd1e995L + key.charAt(i);
            h ^= h >>> 47;
        }
        return h;
    }

    public int count() { return count; }
    public int bitsUsed() { return numBits; }
    public double estimatedFalsePositiveRate() {
        double fraction = (double) bits.cardinality() / numBits;
        return Math.pow(fraction, numHashFunctions);
    }
}
```

---

## Problems

### B+ Tree Operations

**P12.01** [E] — B+ Tree Point Search

Implement `search(key)` in a B+ tree. Walk from root to leaf using binary search at each internal node.

```java
// Given the BPlusTree implementation above:
// search(key) at each internal node does:
//   int idx = Collections.binarySearch(keys, key);
//   int childIdx = idx >= 0 ? idx + 1 : -(idx + 1);
//   recurse into children.get(childIdx)
//
// At leaf node:
//   int idx = Collections.binarySearch(keys, key);
//   return idx >= 0 ? values.get(idx) : null;
//
// Complexity: O(log_B N) node visits × O(log B) binary search per node = O(log N)
// Disk I/O: O(log_B N) = O(3-4) for typical databases
// JVM: Each node is a separate heap object with ArrayList fields.
// In production, nodes are serialized into fixed-size byte[] pages.

BPlusTree<Integer, String> tree = new BPlusTree<>(128);
for (int i = 0; i < 1_000_000; i++) {
    tree.put(i, "value_" + i);
}
String result = tree.search(500_000);  // O(log_128 1M) ≈ 3 node visits
```

**P12.02** [E] — B+ Tree Insert with Page Split

Trace the split process when inserting into a full leaf node.

```java
// Given a B+ tree of order 4 (max 3 keys per node):
// Leaf: [10, 20, 30] → FULL
// Insert key 25:
//
// Step 1: Find correct leaf (binary search through internal nodes)
// Step 2: Leaf is full → SPLIT
//   Left leaf:  [10, 20]      (first half)
//   Right leaf: [25, 30]      (second half, includes new key in sorted position)
//   Promote key 25 to parent (copy — key stays in leaf too)
//
// Step 3: Insert promoted key into parent
//   Parent before: [key_a | key_b]
//   Parent after:  [key_a | 25 | key_b]  (with new child pointer to right leaf)
//
// Step 4: If parent is now full → split parent too (cascade)
//   Parent split promotes a key to grandparent.
//   In the worst case, splits cascade to the root, creating a new root
//   and increasing tree height by 1.
//
// This is why B+ tree height grows logarithmically and uniformly:
// the tree grows from the root UP, not the leaves DOWN.

// Complexity: O(log_B N) amortized — splits are rare (1 in B inserts)
// InnoDB optimization: when inserting sequential keys (auto-increment PK),
// InnoDB detects the pattern and pre-splits, avoiding random page splits.
```

**P12.03** [M] — B+ Tree Range Query

Implement `rangeQuery(start, end)` using the leaf linked list.

```java
public List<V> rangeQuery(K start, K end) {
    List<V> results = new ArrayList<>();
    
    // Step 1: Find the leaf containing 'start'
    // This is a single tree traversal: O(log_B N)
    LeafNode leaf = findLeaf(start);
    
    // Step 2: Scan the leaf linked list until we pass 'end'
    // This is sequential I/O: O(R/B) where R is result count and B is keys per leaf
    while (leaf != null) {
        for (int i = 0; i < leaf.keys.size(); i++) {
            K key = leaf.keys.get(i);
            if (key.compareTo(start) >= 0 && key.compareTo(end) <= 0) {
                results.add(leaf.values.get(i));
            } else if (key.compareTo(end) > 0) {
                return results;
            }
        }
        leaf = leaf.next;  // Follow the linked list — sequential I/O on disk
    }
    return results;
}

// Example: SELECT * FROM orders WHERE order_date BETWEEN '2024-01-01' AND '2024-01-31'
// With a B+ tree index on order_date:
// 1. Tree walk to find the leaf containing '2024-01-01': 3-4 random I/Os
// 2. Sequential scan of leaf pages for 31 days of data: sequential I/O
// 
// Without the leaf linked list (regular B-tree), we would need to
// do an in-order traversal revisiting internal nodes — random I/O.
// This is THE reason B+ trees use leaf links: range scans are sequential.
//
// Complexity: O(log_B N + R/B) I/Os
```

**P12.04** [M] — B+ Tree Delete with Merge/Redistribute

Handle underflow when deleting from a B+ tree.

```java
// Delete key 20 from leaf [10, 20, 30] (order 5, minKeys = 2):
// After deletion: [10, 30] — still has minKeys, no underflow.
//
// Delete key 30 from leaf [30] (only one key, minKeys = 2):
// UNDERFLOW! Two options:
//
// Option A: Redistribute from sibling
//   If left sibling [10, 15, 20] has more than minKeys:
//   - Borrow the rightmost key (20) from left sibling
//   - Move it to the underflowing leaf: [20]
//   - Update parent key to reflect new boundary
//
// Option B: Merge with sibling
//   If left sibling [10, 15] has exactly minKeys:
//   - Merge: [10, 15] + [30] → [10, 15, 30]
//   - Remove the parent key that separated them
//   - If parent now underflows → cascade merge upward
//
// InnoDB optimization: InnoDB does NOT eagerly merge underfull pages.
// It marks pages as "can be merged" and lets the background merge thread
// handle it later. This avoids cascading merges during peak traffic.
// The innodb_merge_threshold parameter (default 50%) controls when
// adjacent pages are merged.
//
// Complexity: O(log_B N) amortized (merges are rare, like splits)

public void delete(K key) {
    DeleteResult result = root.delete(key);
    if (result != null && root instanceof InternalNode) {
        InternalNode internal = (InternalNode) root;
        if (internal.keys.isEmpty()) {
            root = internal.children.get(0); // Shrink tree height
            height--;
        }
    }
}
```

**P12.05** [H] — B+ Tree Bulk Load

Build a B+ tree from sorted data in O(N) instead of O(N log N).

```java
/**
 * Bulk load: build a B+ tree bottom-up from sorted data.
 * 
 * Instead of inserting one key at a time (O(N log N)),
 * build leaf nodes left-to-right, then build internal levels bottom-up.
 *
 * This is what MySQL's ALTER TABLE ... ORDER BY or LOAD DATA INFILE does
 * when building a new index on sorted data — it constructs the B+ tree
 * bottom-up in O(N) time.
 */
public static <K extends Comparable<K>, V> BPlusTree<K, V> bulkLoad(
        List<Map.Entry<K, V>> sortedData, int order) {
    
    BPlusTree<K, V> tree = new BPlusTree<>(order);
    int maxKeys = order - 1;
    
    // Step 1: Build leaf nodes (fill each to ~2/3 capacity for future inserts)
    int fillFactor = maxKeys * 2 / 3;
    List<LeafNode> leaves = new ArrayList<>();
    
    for (int i = 0; i < sortedData.size(); i += fillFactor) {
        LeafNode leaf = tree.new LeafNode();
        int end = Math.min(i + fillFactor, sortedData.size());
        for (int j = i; j < end; j++) {
            leaf.keys.add(sortedData.get(j).getKey());
            leaf.values.add(sortedData.get(j).getValue());
        }
        leaves.add(leaf);
    }
    
    // Step 2: Link leaves
    for (int i = 0; i < leaves.size() - 1; i++) {
        leaves.get(i).next = leaves.get(i + 1);
        leaves.get(i + 1).prev = leaves.get(i);
    }
    tree.firstLeaf = leaves.get(0);
    
    // Step 3: Build internal levels bottom-up
    List<Node> currentLevel = new ArrayList<>(leaves);
    while (currentLevel.size() > 1) {
        List<Node> nextLevel = new ArrayList<>();
        for (int i = 0; i < currentLevel.size(); i += order) {
            InternalNode internal = tree.new InternalNode();
            int end = Math.min(i + order, currentLevel.size());
            for (int j = i; j < end; j++) {
                internal.children.add(currentLevel.get(j));
                if (j > i) {
                    // Promote the first key of this child
                    internal.keys.add(currentLevel.get(j).keys.get(0));
                }
            }
            nextLevel.add(internal);
        }
        currentLevel = nextLevel;
        tree.height++;
    }
    
    tree.root = currentLevel.get(0);
    tree.size = sortedData.size();
    return tree;
}

// Complexity: O(N) — each entry is processed exactly once
// Compare with N individual inserts: O(N log_B N)
// For 100M rows: bulk load ≈ 1 minute, individual inserts ≈ 30 minutes
```

### Key-Value Store and WAL

**P12.06** [M] — Design a Key-Value Store with WAL

Build a simple persistent key-value store with crash recovery.

```java
/**
 * Persistent key-value store: WAL + in-memory HashMap + periodic snapshots.
 * This is the simplest database architecture.
 *
 * Redis RDB+AOF follows this pattern:
 * - AOF (Append-Only File) = WAL
 * - RDB (Redis Database file) = periodic snapshot
 * - In-memory HashMap = the actual data
 */
public class PersistentKVStore {

    private final ConcurrentHashMap<String, byte[]> data;
    private final WriteAheadLog wal;
    private final String snapshotPath;
    private final AtomicLong operationCount = new AtomicLong(0);

    public PersistentKVStore(String directory) throws IOException {
        this.snapshotPath = directory + "/snapshot.dat";
        this.wal = new WriteAheadLog(directory);
        this.data = new ConcurrentHashMap<>();

        // Recovery: load snapshot + replay WAL
        loadSnapshot();
        replayWAL();
    }

    public void put(String key, byte[] value) throws IOException {
        wal.append(key, value);
        data.put(key, value);

        if (operationCount.incrementAndGet() % 10_000 == 0) {
            checkpoint();
        }
    }

    public byte[] get(String key) {
        return data.get(key);
    }

    public void delete(String key) throws IOException {
        wal.append(key, new byte[0]); // Tombstone
        data.remove(key);
    }

    /**
     * Checkpoint: save a consistent snapshot and truncate the WAL.
     * After a checkpoint, recovery only needs to replay the WAL
     * entries after the checkpoint.
     */
    private void checkpoint() throws IOException {
        // Write snapshot atomically (write to temp file, then rename)
        String tempPath = snapshotPath + ".tmp";
        try (ObjectOutputStream out = new ObjectOutputStream(
                new BufferedOutputStream(new FileOutputStream(tempPath)))) {
            out.writeInt(data.size());
            for (Map.Entry<String, byte[]> entry : data.entrySet()) {
                out.writeUTF(entry.getKey());
                out.writeInt(entry.getValue().length);
                out.write(entry.getValue());
            }
        }
        new java.io.File(tempPath).renameTo(new java.io.File(snapshotPath));
        wal.rotate(); // Start fresh WAL
    }

    private void loadSnapshot() throws IOException {
        java.io.File f = new java.io.File(snapshotPath);
        if (!f.exists()) return;

        try (ObjectInputStream in = new ObjectInputStream(
                new BufferedInputStream(new FileInputStream(f)))) {
            int count = in.readInt();
            for (int i = 0; i < count; i++) {
                String key = in.readUTF();
                int len = in.readInt();
                byte[] value = new byte[len];
                in.readFully(value);
                data.put(key, value);
            }
        }
    }

    private void replayWAL() throws IOException {
        for (WriteAheadLog.WALEntry entry : wal.recover()) {
            if (entry.value().length == 0) {
                data.remove(entry.key());
            } else {
                data.put(entry.key(), entry.value());
            }
        }
    }
}

// Complexity:
//   put/delete: O(1) hash map + O(1) WAL append (amortized)
//   get: O(1) hash map lookup
//   checkpoint: O(N) — full snapshot write
//   recovery: O(N) snapshot load + O(W) WAL replay
//
// JVM: ConcurrentHashMap uses ~72 bytes per entry (see Chapter 1).
//   For 10M entries: ~720 MB heap. If this is too much, switch to
//   off-heap storage (Chronicle Map, MapDB) or an LSM tree.
```

**P12.07** [E] — WAL Append and Recover

Implement the core WAL operations: append, commit, and recover.

```java
// See the WriteAheadLog implementation in Section 12.3.
// Key operations:
//
// append(key, value):
//   1. Serialize: [LSN:8][keyLen:4][key:var][valLen:4][val:var][checksum:4]
//   2. Write to buffer (buffered I/O for throughput)
//   3. Return LSN for this entry
//
// commit(lsn):
//   1. Flush buffer to file
//   2. fsync() — force to stable storage
//   3. Update lastSyncedLSN
//
// recover():
//   1. Open all WAL files in chronological order
//   2. Read entries sequentially
//   3. Verify checksums (discard corrupted entries at the tail)
//   4. Return list of valid entries for replay
//
// The checksum at the end of each entry detects partial writes:
// if the system crashed mid-write, the checksum will not match,
// and we know to discard that entry (it was never committed).
//
// Group commit in PostgreSQL:
//   Instead of fsync() per transaction, the commit_delay parameter
//   makes the first committer wait (e.g., 10us) for other transactions
//   to join the batch. Then one fsync() commits them all.
//   Throughput improvement: 5-50x under concurrent workloads.
```

**P12.08** [E] — Implement MemTable (In-Memory Sorted Structure)

```java
/**
 * MemTable: in-memory sorted buffer for LSM tree writes.
 * Uses ConcurrentSkipListMap for thread-safe sorted access.
 *
 * Why SkipList over TreeMap?
 * - ConcurrentSkipListMap: lock-free reads, fine-grained locking on writes
 * - TreeMap: requires external synchronization (coarse-grained locking)
 * - For concurrent writes (common in databases), SkipList wins
 *
 * RocksDB's MemTable options:
 * 1. SkipList (default): good for range scans + point queries
 * 2. HashSkipList: O(1) point queries, O(N) range scans
 * 3. HashLinkedList: O(1) point queries, no range scans
 * 4. Vector: O(1) append, good for bulk loading
 */
public class MemTable {
    private final ConcurrentSkipListMap<String, byte[]> data;
    private final AtomicInteger approximateSize;
    private final int sizeLimit;
    private volatile boolean immutable;

    public MemTable(int sizeLimit) {
        this.data = new ConcurrentSkipListMap<>();
        this.approximateSize = new AtomicInteger(0);
        this.sizeLimit = sizeLimit;
        this.immutable = false;
    }

    public void put(String key, byte[] value) {
        if (immutable) throw new IllegalStateException("MemTable is immutable");
        byte[] old = data.put(key, value);
        int delta = key.length() + value.length;
        if (old != null) delta -= (key.length() + old.length);
        approximateSize.addAndGet(delta);
    }

    public byte[] get(String key) {
        return data.get(key);
    }

    /**
     * Range scan over the memtable.
     * ConcurrentSkipListMap.subMap() returns a view — no copying.
     */
    public NavigableMap<String, byte[]> range(String start, String end) {
        return data.subMap(start, true, end, true);
    }

    public boolean isFull() {
        return approximateSize.get() >= sizeLimit;
    }

    public void makeImmutable() {
        this.immutable = true;
    }

    public NavigableMap<String, byte[]> getData() {
        return Collections.unmodifiableNavigableMap(data);
    }

    public int approximateSize() { return approximateSize.get(); }
}

// Complexity:
//   put: O(log N) — skip list insertion
//   get: O(log N) — skip list search
//   range: O(log N + K) — skip list range scan
// where N = entries in memtable (typically 64K-256K entries)
//
// JVM: ConcurrentSkipListMap creates a Node object per entry (~48 bytes)
//   plus index nodes at higher levels (~32 bytes each, O(N) total).
//   For a 64MB memtable with 1M entries: ~80MB actual heap usage.
//   The skip list's probabilistic balancing avoids the red-black tree's
//   rebalancing rotations, which require CAS-heavy pointer swaps
//   under concurrency.
```

**P12.09** [M] — Design SSTable Reader/Writer

```java
// See SSTable implementation in Section 12.2.
//
// Writer (flush from memtable):
//   - Input: sorted key-value pairs from memtable
//   - Write data blocks (4KB each): key-value pairs in sorted order
//   - Build sparse index: every Nth key → file offset
//   - Build bloom filter: add every key
//   - Write index block at end of file
//   - Write bloom filter at end of file
//   - Write footer with offsets
//
// Reader (point query):
//   1. Check bloom filter → if negative, return null (no disk read saved)
//   2. Binary search sparse index → find the data block
//   3. Sequential scan within data block → find the key
//   Total disk reads: 0-2 (bloom filter + 1 data block)
//
// Reader (range query):
//   1. Binary search sparse index → find starting data block
//   2. Sequential read of data blocks until past end of range
//   Total disk reads: proportional to result size
//
// File format details:
//   - Data blocks use prefix compression: if consecutive keys share a prefix,
//     store the prefix once. "user:1001", "user:1002" → prefix "user:100",
//     suffixes "1", "2". LevelDB calls these "restart points."
//   - Compression: Snappy or LZ4 per data block (4KB → ~2KB typical)
//   - Checksum: CRC32 per data block for corruption detection
```

**P12.10** [M] — Implement Compaction (Merge Sorted Files)

```java
/**
 * Merge K sorted SSTable files into fewer, non-overlapping files.
 * This is the core compaction operation in LSM trees.
 *
 * Uses a min-heap (PriorityQueue) for efficient K-way merge.
 * Same algorithm as external merge sort.
 */
public class Compaction {

    /**
     * K-way merge of sorted iterators.
     * Time: O(N log K) where N = total entries, K = number of files
     * Space: O(K) for the heap
     */
    public static Iterator<Map.Entry<String, byte[]>> kWayMerge(
            List<Iterator<Map.Entry<String, byte[]>>> iterators) {

        PriorityQueue<IndexedEntry> heap = new PriorityQueue<>(
            Comparator.comparing(e -> e.entry.getKey())
        );

        // Seed the heap with the first entry from each iterator
        for (int i = 0; i < iterators.size(); i++) {
            if (iterators.get(i).hasNext()) {
                heap.offer(new IndexedEntry(iterators.get(i).next(), i));
            }
        }

        return new Iterator<>() {
            private String lastKey = null;

            @Override
            public boolean hasNext() {
                return !heap.isEmpty();
            }

            @Override
            public Map.Entry<String, byte[]> next() {
                while (!heap.isEmpty()) {
                    IndexedEntry ie = heap.poll();

                    // Advance the source iterator
                    Iterator<Map.Entry<String, byte[]>> source =
                        iterators.get(ie.sourceIndex);
                    if (source.hasNext()) {
                        heap.offer(new IndexedEntry(source.next(), ie.sourceIndex));
                    }

                    // Deduplicate: skip if same key as previous (keep newest)
                    if (!ie.entry.getKey().equals(lastKey)) {
                        lastKey = ie.entry.getKey();
                        return ie.entry;
                    }
                }
                throw new NoSuchElementException();
            }
        };
    }

    private record IndexedEntry(Map.Entry<String, byte[]> entry, int sourceIndex) {}
}

// JVM: The PriorityQueue holds at most K entries. For typical compaction
// with K=4-10, the heap fits in L1 cache. The bottleneck is disk I/O,
// not the merge algorithm. Using buffered I/O (64KB buffers per file)
// ensures sequential reads and writes dominate.
//
// RocksDB compaction strategies:
// 1. Leveled: merge L_i files into L_{i+1}. Each level 10x larger.
//    Read amp: low. Write amp: high (10-30x). Space amp: low (~1.1x).
// 2. Size-tiered (Universal): merge similarly-sized files.
//    Read amp: higher. Write amp: lower. Space amp: higher (~2x).
// 3. FIFO: simple; delete oldest files when size limit reached.
//    Good for time-series with TTL.
```

### Inverted Index and Search

**P12.11** [E] — Build an Inverted Index

```java
// See the full InvertedIndex implementation in Section 12.6.
// Simplified version for indexing a corpus of strings:

Map<String, List<Integer>> invertedIndex = new HashMap<>();

void index(int docId, String text) {
    String[] tokens = text.toLowerCase().split("\\W+");
    for (String token : tokens) {
        invertedIndex.computeIfAbsent(token, k -> new ArrayList<>()).add(docId);
    }
}

List<Integer> search(String term) {
    return invertedIndex.getOrDefault(term.toLowerCase(), Collections.emptyList());
}

// Complexity: O(T) per document where T is token count
// Search: O(1) hash lookup + O(R) to return results
// Space: O(sum of all tokens across all documents)
```

**P12.12** [M] — Intersect Posting Lists for AND Query

```java
/**
 * Intersect two sorted posting lists using two-pointer technique.
 * This is the core operation for AND queries in search engines.
 *
 * Both lists must be sorted by document ID.
 * Time: O(|A| + |B|) — linear scan of both lists
 * Space: O(min(|A|, |B|)) for the result
 */
public static List<Integer> intersect(List<Integer> a, List<Integer> b) {
    List<Integer> result = new ArrayList<>();
    int i = 0, j = 0;
    while (i < a.size() && j < b.size()) {
        int cmp = Integer.compare(a.get(i), b.get(j));
        if (cmp == 0) {
            result.add(a.get(i));
            i++;
            j++;
        } else if (cmp < 0) {
            i++;
        } else {
            j++;
        }
    }
    return result;
}

/**
 * Optimized intersection with skip pointers (galloping).
 * When one list is much shorter than the other,
 * use binary search to skip ahead in the longer list.
 *
 * Time: O(min(|A|, |B|) * log(max(|A|, |B|)/min(|A|, |B|)))
 * This is significantly better when |A| << |B|.
 */
public static List<Integer> intersectWithSkip(List<Integer> small, List<Integer> large) {
    if (small.size() > large.size()) return intersectWithSkip(large, small);

    List<Integer> result = new ArrayList<>();
    int largeIdx = 0;
    for (int docId : small) {
        // Binary search in the remaining portion of 'large'
        int idx = Collections.binarySearch(
            large.subList(largeIdx, large.size()), docId);
        if (idx >= 0) {
            result.add(docId);
            largeIdx += idx + 1;
        } else {
            largeIdx += -(idx + 1);
        }
    }
    return result;
}

// Lucene's approach: posting lists are stored with skip pointers
// every sqrt(N) elements. This allows O(sqrt(N)) skip during intersection
// instead of linear scan. For very large posting lists (millions of docs),
// this is a massive speedup.
```

**P12.13** [M] — TF-IDF Scoring

```java
/**
 * Score documents using TF-IDF.
 * See the full implementation in InvertedIndex.search().
 *
 * TF-IDF(term, doc) = TF(term, doc) × IDF(term)
 *
 * TF (Term Frequency): how important is the term in THIS document?
 *   Raw TF: count of term in document
 *   Log-normalized TF: 1 + log(count) — diminishing returns
 *   Why: A document mentioning "java" 10 times isn't 10x more relevant
 *         than one mentioning it once.
 *
 * IDF (Inverse Document Frequency): how important is the term GLOBALLY?
 *   IDF = log(N / df) where N = total docs, df = docs containing term
 *   Why: "the" appears in every doc → IDF ≈ 0 (not discriminating)
 *         "concurrency" appears in 1% of docs → high IDF (discriminating)
 *
 * BM25 (used by Elasticsearch since v5.0):
 *   Improves on TF-IDF with:
 *   - Term frequency saturation: TF / (TF + k1) — bounded contribution
 *   - Document length normalization: |D| / avgDL — penalize verbose docs
 *   - Parameters k1 (1.2) and b (0.75) tunable per field
 */
public double bm25(int termFreq, int docLength, double avgDocLength,
                   int docFreq, int totalDocs) {
    double k1 = 1.2;
    double b = 0.75;

    double idf = Math.log((totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1);
    double tfNorm = (termFreq * (k1 + 1)) /
                    (termFreq + k1 * (1 - b + b * docLength / avgDocLength));
    return idf * tfNorm;
}
```

**P12.14** [H] — Build a Search Engine Indexer

```java
/**
 * Full search engine indexer with:
 * - Document tokenization and normalization
 * - Inverted index construction
 * - TF-IDF/BM25 scoring
 * - Boolean queries (AND, OR, NOT)
 * - Phrase queries
 *
 * This is a miniature Lucene.
 */
public class SearchEngineIndexer {

    private final InvertedIndex index = new InvertedIndex();
    private int docCount = 0;

    public void indexDocument(String title, String body) {
        String fullText = title + " " + title + " " + body; // Title boosted 2x
        index.addDocument(docCount++, fullText);
    }

    public void indexDocuments(List<String> documents) {
        for (String doc : documents) {
            index.addDocument(docCount++, doc);
        }
    }

    /**
     * Parse and execute a query.
     * Supports: "term1 AND term2", "term1 OR term2", "NOT term",
     *           "\"exact phrase\""
     */
    public List<InvertedIndex.SearchResult> query(String queryString) {
        if (queryString.startsWith("\"") && queryString.endsWith("\"")) {
            // Phrase query
            return index.phraseSearch(queryString.substring(1, queryString.length() - 1));
        }
        // Default: AND semantics (all terms must match)
        return index.search(queryString);
    }

    public int documentCount() { return docCount; }
}

// Complexity:
//   Indexing: O(T) per document where T = tokens
//   Query: O(Q × log N + R) where Q = query terms, N = vocab size, R = results
//   Space: O(sum of all token occurrences) — the inverted index
//
// Lucene optimizations NOT shown here:
// 1. Segment-based architecture: new documents go to in-memory segment,
//    periodically flushed to disk. Segments are immutable and merged
//    in the background — this is an LSM-like approach.
// 2. FST (Finite State Transducer) for term dictionary: O(|term|) lookup
//    with prefix compression. Better than HashMap for millions of terms.
// 3. Doc values: column-oriented storage for sorting/aggregation fields.
// 4. Points/BKD-tree: for numeric range queries and geo queries.
```

### Bitmap Index Operations

**P12.15** [E] — Build a Bitmap Index

```java
// See BitmapIndex implementation in Section 12.7.
// Basic usage:

BitmapIndex<String> statusIndex = new BitmapIndex<>();
statusIndex.addRow(0, "ACTIVE");
statusIndex.addRow(1, "INACTIVE");
statusIndex.addRow(2, "ACTIVE");
statusIndex.addRow(3, "PENDING");

BitSet activeRows = statusIndex.eq("ACTIVE");    // {0, 2}
BitSet pendingRows = statusIndex.eq("PENDING");   // {3}
BitSet notInactive = statusIndex.not("INACTIVE"); // {0, 2, 3}

// Count active rows:
int activeCount = BitmapIndex.count(activeRows);   // 2

// Complexity: O(1) to get bitmap, O(N/64) for operations
// For 1 billion rows, AND operation: 1B/64 = 15.6M long operations
// At 1 GHz: ~15ms. Compare with 1B row scan at ~1 second.
```

**P12.16** [M] — Multi-Column Bitmap Query

```java
/**
 * Combine bitmap indexes from multiple columns for complex queries.
 *
 * Query: WHERE status = 'ACTIVE' AND region IN ('US', 'EU') AND age_group != 'CHILD'
 */
public BitSet evaluateQuery(BitmapIndex<String> statusIdx,
                            BitmapIndex<String> regionIdx,
                            BitmapIndex<String> ageIdx) {
    // Each operation is O(N/64)
    BitSet result = statusIdx.eq("ACTIVE");

    BitSet regionBitmap = BitmapIndex.or(regionIdx.eq("US"), regionIdx.eq("EU"));
    result.and(regionBitmap);

    BitSet notChild = ageIdx.not("CHILD");
    result.and(notChild);

    return result; // Set bits = matching row IDs
}

// Total: 5 bitmap operations × O(N/64) = O(N/64)
// For 100M rows: ~5 × 100M/64 = ~8M operations ≈ 8ms
// Compare with B+ tree: 3 index lookups + intersection ≈ 30ms
// Bitmap wins for low-cardinality columns with complex boolean logic.
//
// When NOT to use bitmaps:
// - High cardinality (millions of distinct values): one bitmap per value = too much space
// - Frequent updates: updating a bitmap requires rewriting the entire column
// - Single-key lookups: B+ tree O(log N) beats bitmap O(N/64) scan
```

### Buffer Pool and Page Replacement

**P12.17** [E] — FIFO Page Replacement

```java
/**
 * FIFO page replacement: evict the oldest page.
 * Simple but suffers from Belady's anomaly: adding more frames
 * can increase page faults.
 */
public class FIFOPageCache {
    private final Map<Integer, byte[]> cache;
    private final Queue<Integer> order;
    private final int capacity;
    private int hits, misses;

    public FIFOPageCache(int capacity) {
        this.capacity = capacity;
        this.cache = new HashMap<>(capacity * 2);
        this.order = new LinkedList<>();
    }

    public byte[] getPage(int pageId) {
        if (cache.containsKey(pageId)) {
            hits++;
            return cache.get(pageId);
        }
        misses++;
        if (cache.size() >= capacity) {
            int evicted = order.poll();
            cache.remove(evicted);
        }
        byte[] page = loadFromDisk(pageId);
        cache.put(pageId, page);
        order.offer(pageId);
        return page;
    }

    private byte[] loadFromDisk(int pageId) { return new byte[4096]; }
    public double hitRate() { return (double) hits / (hits + misses); }
}
// Complexity: O(1) for all operations
// Problem: no frequency or recency awareness — evicts useful pages
```

**P12.18** [M] — LRU Page Replacement

```java
/**
 * LRU using LinkedHashMap (access-ordered).
 * Java's LinkedHashMap with accessOrder=true is a perfect LRU cache.
 */
public class LRUPageCache {
    private final LinkedHashMap<Integer, byte[]> cache;
    private int hits, misses;

    public LRUPageCache(int capacity) {
        this.cache = new LinkedHashMap<Integer, byte[]>(capacity, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<Integer, byte[]> eldest) {
                return size() > capacity;
            }
        };
    }

    public byte[] getPage(int pageId) {
        byte[] page = cache.get(pageId);
        if (page != null) {
            hits++;
            return page;
        }
        misses++;
        page = loadFromDisk(pageId);
        cache.put(pageId, page);
        return page;
    }

    private byte[] loadFromDisk(int pageId) { return new byte[4096]; }
    public double hitRate() { return (double) hits / (hits + misses); }
}
// Complexity: O(1) amortized for get/put
// LinkedHashMap internally maintains a doubly-linked list threaded through entries.
// Every access moves the entry to the tail (most recent).
// Eviction removes from the head (least recent).
//
// Problem: full table scans pollute the cache (scan pollution).
// InnoDB's midpoint insertion (Section 12.5) addresses this.
```

**P12.19** [M] — LFU Page Replacement

```java
/**
 * LFU (Least Frequently Used) page replacement.
 * Evicts the page with the fewest accesses.
 *
 * O(1) implementation using two HashMaps and a frequency-to-DLL map.
 * This is the O(1) LFU algorithm by Prof. Ketan Shah (2010).
 */
public class LFUPageCache {
    private final int capacity;
    private int minFreq;
    private final Map<Integer, byte[]> values;
    private final Map<Integer, Integer> frequencies;
    private final Map<Integer, LinkedHashSet<Integer>> freqToKeys; // freq → keys (insertion order)
    private int hits, misses;

    public LFUPageCache(int capacity) {
        this.capacity = capacity;
        this.minFreq = 0;
        this.values = new HashMap<>();
        this.frequencies = new HashMap<>();
        this.freqToKeys = new HashMap<>();
    }

    public byte[] getPage(int pageId) {
        if (!values.containsKey(pageId)) {
            misses++;
            if (values.size() >= capacity) evict();
            byte[] page = loadFromDisk(pageId);
            values.put(pageId, page);
            frequencies.put(pageId, 1);
            freqToKeys.computeIfAbsent(1, k -> new LinkedHashSet<>()).add(pageId);
            minFreq = 1;
            return page;
        }

        hits++;
        // Update frequency
        int freq = frequencies.get(pageId);
        frequencies.put(pageId, freq + 1);
        freqToKeys.get(freq).remove(pageId);
        if (freqToKeys.get(freq).isEmpty()) {
            freqToKeys.remove(freq);
            if (minFreq == freq) minFreq++;
        }
        freqToKeys.computeIfAbsent(freq + 1, k -> new LinkedHashSet<>()).add(pageId);

        return values.get(pageId);
    }

    private void evict() {
        LinkedHashSet<Integer> keys = freqToKeys.get(minFreq);
        int evicted = keys.iterator().next(); // Oldest with min frequency
        keys.remove(evicted);
        if (keys.isEmpty()) freqToKeys.remove(minFreq);
        values.remove(evicted);
        frequencies.remove(evicted);
    }

    private byte[] loadFromDisk(int pageId) { return new byte[4096]; }
}
// Complexity: O(1) for all operations
// Advantage over LRU: resistant to scan pollution (infrequent pages get low freq)
// Disadvantage: does not adapt to changing access patterns quickly
```

**P12.20** [H] — Clock Page Replacement

```java
// See ClockSweepPool implementation in Section 12.5.
//
// The clock algorithm is an approximation of LRU:
// - Each page has a usage count (0-5)
// - On access: increment usage count (cap at max)
// - On eviction: sweep clockwise, decrementing counts
//   - First page with count 0 is evicted
//
// Why PostgreSQL chose clock-sweep over LRU:
// 1. No linked list to maintain — just an integer per buffer
// 2. No pointer swaps on every buffer access
// 3. Lock-free access counter (atomic increment)
// 4. Good enough approximation of LRU for database workloads
//
// PostgreSQL source: src/backend/storage/buffer/freelist.c
// The clock hand is a single integer (nextVictimBuffer) that sweeps
// through the buffer array. Each sweep decrements usage_count.
// Pages with high usage_count survive multiple sweeps = frequently used.
```

### Time-Series and Specialized Storage

**P12.21** [E] — Ring Buffer for Metrics

```java
// See TimeSeriesRingBuffer in Section 12.8.
// A ring buffer is the simplest fixed-memory time-series store.
//
// For a metrics dashboard showing the last 24 hours at 1-second resolution:
//   capacity = 86,400 data points
//   Memory: 86,400 × (8 bytes timestamp + 8 bytes value) = 1.35 MB
//
// No GC pressure: primitive arrays, no object allocation per data point.
// Perfect for in-process metrics (Micrometer, Dropwizard Metrics).
```

**P12.22** [M] — Downsampling Time-Series Data

```java
/**
 * Downsample high-resolution data into lower-resolution aggregates.
 *
 * Prometheus retention:
 * - Raw (15s resolution): last 2 hours in memory (head block)
 * - 2-hour blocks on disk: up to 15 days
 * - Downsampled (5m resolution): up to 90 days in Thanos/Cortex
 *
 * Algorithm: group data points into time buckets, compute aggregate (avg/min/max/sum).
 */
public List<DataPoint> downsample(List<DataPoint> data,
                                   long bucketSizeMs,
                                   AggregationFunction aggFn) {
    TreeMap<Long, List<Double>> buckets = new TreeMap<>();
    for (DataPoint dp : data) {
        long bucketStart = (dp.timestamp() / bucketSizeMs) * bucketSizeMs;
        buckets.computeIfAbsent(bucketStart, k -> new ArrayList<>()).add(dp.value());
    }

    return buckets.entrySet().stream()
        .map(e -> new DataPoint(e.getKey(), aggFn.apply(e.getValue())))
        .collect(Collectors.toList());
}

enum AggregationFunction {
    AVG(vals -> vals.stream().mapToDouble(Double::doubleValue).average().orElse(0)),
    MIN(vals -> vals.stream().mapToDouble(Double::doubleValue).min().orElse(0)),
    MAX(vals -> vals.stream().mapToDouble(Double::doubleValue).max().orElse(0)),
    SUM(vals -> vals.stream().mapToDouble(Double::doubleValue).sum()),
    COUNT(vals -> (double) vals.size());

    private final java.util.function.Function<List<Double>, Double> fn;
    AggregationFunction(java.util.function.Function<List<Double>, Double> fn) { this.fn = fn; }
    double apply(List<Double> values) { return fn.apply(values); }
}

// Complexity: O(N) where N = data points
// Space: O(N/bucket_size) for the result
// Downsampling from 1s to 1m resolution: 60x data reduction
// From 1s to 1h: 3600x data reduction
```

**P12.23** [M] — Time-Series Compression (Gorilla/Delta-of-Delta)

```java
/**
 * Delta-of-delta encoding for timestamps.
 * Gorilla compression (Facebook, 2015) exploits the regularity of
 * time-series data: timestamps often have constant intervals.
 *
 * Raw timestamps:    [1000, 1060, 1120, 1180, 1240]  → 8 bytes each = 40 bytes
 * Deltas:            [-, 60, 60, 60, 60]
 * Delta-of-deltas:   [-, -, 0, 0, 0]                 → mostly zeros
 * Encoded: first timestamp + first delta + zeros       → ~10 bytes = 4x compression
 */
public class GorillaTSCompressor {

    private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    private long prevTimestamp = -1;
    private long prevDelta = 0;
    private double prevValue = 0;
    private int count = 0;

    public void addPoint(long timestamp, double value) throws IOException {
        if (count == 0) {
            // First point: store full timestamp and value
            writeLong(timestamp);
            writeDouble(value);
        } else if (count == 1) {
            // Second point: store delta
            long delta = timestamp - prevTimestamp;
            writeLong(delta);
            // XOR encoding for value
            long xored = Double.doubleToLongBits(value) ^
                         Double.doubleToLongBits(prevValue);
            writeLong(xored);
            prevDelta = delta;
        } else {
            // Subsequent points: delta-of-delta for timestamp
            long delta = timestamp - prevTimestamp;
            long dod = delta - prevDelta;

            // Variable-length encoding based on dod magnitude
            if (dod == 0) {
                buffer.write(0); // 1 bit marker: no change
            } else if (dod >= -63 && dod <= 64) {
                buffer.write(1); // Marker
                writeShort((short) dod); // 7 bits
            } else {
                buffer.write(2); // Marker
                writeLong(dod); // Full encoding
            }

            // XOR encoding for value
            long xored = Double.doubleToLongBits(value) ^
                         Double.doubleToLongBits(prevValue);
            writeLong(xored); // In production: store only significant bits

            prevDelta = delta;
        }

        prevTimestamp = timestamp;
        prevValue = value;
        count++;
    }

    public byte[] getCompressed() {
        return buffer.toByteArray();
    }

    private void writeLong(long v) throws IOException {
        for (int i = 7; i >= 0; i--) buffer.write((int) (v >>> (i * 8)) & 0xFF);
    }

    private void writeShort(short v) throws IOException {
        buffer.write((v >>> 8) & 0xFF);
        buffer.write(v & 0xFF);
    }

    private void writeDouble(double v) throws IOException {
        writeLong(Double.doubleToLongBits(v));
    }
}

// Compression ratios (from Facebook's Gorilla paper):
// - Timestamps: 96% compression (avg 1.37 bits per timestamp vs 64 bits)
// - Values: 59% compression (avg 26.1 bits per value vs 64 bits)
// - Overall: ~12x compression ratio for typical metrics data
//
// This is how Prometheus stores data in its TSDB head block,
// and how InfluxDB's TSM engine compresses time-series data.
```

### Connection Pool and Statement Cache

**P12.24** [E] — DB Connection Pool

```java
/**
 * Simple database connection pool.
 * 
 * Production pools (HikariCP, c3p0, DBCP2) add:
 * - Connection validation (test-on-borrow, test-on-return)
 * - Leak detection (connections not returned within timeout)
 * - Metrics (wait time, usage time, pool size)
 * - Min/max sizing with idle timeout
 *
 * HikariCP (default in Spring Boot) uses a ConcurrentBag:
 * - Thread-local affinity: try to reuse the connection the thread used last
 * - CopyOnWriteArrayList for shared bag
 * - SynchronousQueue for handoff when no cached connection available
 */
public class ConnectionPool {

    private final BlockingQueue<Connection> available;
    private final Set<Connection> inUse;
    private final int maxSize;
    private final String jdbcUrl;
    private int created;

    public ConnectionPool(String jdbcUrl, int maxSize) {
        this.jdbcUrl = jdbcUrl;
        this.maxSize = maxSize;
        this.available = new LinkedBlockingQueue<>();
        this.inUse = ConcurrentHashMap.newKeySet();
    }

    /**
     * Borrow a connection. O(1) if available, blocks if pool exhausted.
     */
    public Connection borrow(long timeoutMs) throws Exception {
        // Try to get an existing connection
        Connection conn = available.poll();
        if (conn != null && isValid(conn)) {
            inUse.add(conn);
            return conn;
        }

        // Create a new connection if under max
        synchronized (this) {
            if (created < maxSize) {
                conn = createConnection();
                created++;
                inUse.add(conn);
                return conn;
            }
        }

        // Wait for a connection to be returned
        conn = available.poll(timeoutMs, TimeUnit.MILLISECONDS);
        if (conn == null) {
            throw new RuntimeException("Connection pool exhausted (timeout: " + timeoutMs + "ms)");
        }
        inUse.add(conn);
        return conn;
    }

    /**
     * Return a connection to the pool.
     */
    public void release(Connection conn) {
        inUse.remove(conn);
        available.offer(conn);
    }

    private Connection createConnection() throws Exception {
        return java.sql.DriverManager.getConnection(jdbcUrl);
    }

    private boolean isValid(Connection conn) {
        try { return conn != null && !conn.isClosed(); }
        catch (Exception e) { return false; }
    }

    public int availableCount() { return available.size(); }
    public int inUseCount() { return inUse.size(); }
}
```

**P12.25** [M] — Statement Cache per Connection

```java
/**
 * PreparedStatement cache per database connection.
 *
 * Preparing a statement involves:
 * 1. Parse SQL → AST
 * 2. Semantic analysis (table/column resolution)
 * 3. Query optimization (plan generation)
 * 4. Send prepared handle to server
 *
 * Caching the PreparedStatement skips all 4 steps on subsequent calls.
 * HikariCP's statement cache: LRU per connection, default 250 statements.
 *
 * MySQL: server-side prepared statements cached by connection.
 * PostgreSQL: PREPARE/EXECUTE protocol; PgJDBC caches parse results.
 */
public class StatementCache {

    private final Connection connection;
    private final LinkedHashMap<String, PreparedStatement> cache;

    public StatementCache(Connection connection, int maxStatements) {
        this.connection = connection;
        this.cache = new LinkedHashMap<>(maxStatements, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, PreparedStatement> eldest) {
                if (size() > maxStatements) {
                    try { eldest.getValue().close(); } catch (Exception ignored) {}
                    return true;
                }
                return false;
            }
        };
    }

    /**
     * Get or create a prepared statement.
     * First call: prepare (round trip to DB server) — ~1ms
     * Subsequent calls: cache hit — ~0.01ms
     */
    public PreparedStatement prepare(String sql) throws SQLException {
        PreparedStatement ps = cache.get(sql);
        if (ps != null && !ps.isClosed()) {
            ps.clearParameters(); // Reset for reuse
            return ps;
        }

        ps = connection.prepareStatement(sql);
        cache.put(sql, ps);
        return ps;
    }

    public void close() {
        for (PreparedStatement ps : cache.values()) {
            try { ps.close(); } catch (Exception ignored) {}
        }
        cache.clear();
    }

    public int size() { return cache.size(); }
}
```

### Advanced Problems

**P12.26** [M] — Query Result Cache with TTL

```java
/**
 * Query result cache: cache SELECT results with expiration.
 *
 * MySQL's old Query Cache (removed in 8.0) cached query results,
 * but was invalidated on ANY write to ANY table referenced in the query.
 * This caused contention on the global query cache mutex.
 *
 * Better approach: application-level result cache with:
 * - Per-query TTL
 * - Explicit invalidation on relevant writes
 * - Bounded memory with LRU eviction
 */
public class QueryResultCache {

    private final int maxEntries;
    private final Map<String, CacheEntry> cache;

    public QueryResultCache(int maxEntries) {
        this.maxEntries = maxEntries;
        this.cache = Collections.synchronizedMap(
            new LinkedHashMap<String, CacheEntry>(maxEntries, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, CacheEntry> eldest) {
                    return size() > maxEntries;
                }
            }
        );
    }

    /**
     * Cache a query result with TTL.
     */
    public void put(String queryFingerprint, List<Map<String, Object>> result,
                    long ttlMs) {
        cache.put(queryFingerprint, new CacheEntry(result,
            System.currentTimeMillis() + ttlMs, queryFingerprint));
    }

    /**
     * Get cached result. Returns null if not found or expired.
     */
    public List<Map<String, Object>> get(String queryFingerprint) {
        CacheEntry entry = cache.get(queryFingerprint);
        if (entry == null) return null;
        if (System.currentTimeMillis() > entry.expiresAt) {
            cache.remove(queryFingerprint);
            return null;
        }
        return entry.result;
    }

    /**
     * Invalidate all cached results for a given table.
     * Called on INSERT, UPDATE, DELETE to that table.
     */
    public void invalidateTable(String tableName) {
        cache.entrySet().removeIf(e ->
            e.getValue().queryFingerprint.toUpperCase().contains(tableName.toUpperCase()));
    }

    private record CacheEntry(List<Map<String, Object>> result, long expiresAt,
                               String queryFingerprint) {}
}

// Complexity: O(1) get/put, O(N) invalidation by table name
// JVM: Each cached result set holds references to row Map objects.
// For large result sets, this can be significant heap usage.
// Consider serializing results to byte[] for memory efficiency,
// or using off-heap storage (Caffeine with soft references, OHC).
```

**P12.27** [E] — Implement a Simple Bloom Filter

```java
// See BloomFilter implementation in Section 12.9.
// Quick test:

BloomFilter bf = new BloomFilter(1_000_000, 0.01); // 1M elements, 1% FP rate
for (int i = 0; i < 1_000_000; i++) {
    bf.add("key_" + i);
}

// True positive: key we added
assert bf.mightContain("key_500000") == true;

// True negative: key we never added (with 1% false positive rate)
// Most of these will return false:
int falsePositives = 0;
for (int i = 0; i < 10_000; i++) {
    if (bf.mightContain("nonexistent_" + i)) falsePositives++;
}
// Expected: ~100 false positives (1% of 10,000)

// Memory: ~9.6 million bits = 1.2 MB for 1M elements at 1% FP
// Compare with HashSet<String>: ~60 MB (String objects + Node wrappers)
// Bloom filter: 50x less memory, but approximate (no false negatives though)
```

**P12.28** [H] — Distributed Key-Value Store

```java
/**
 * Distributed key-value store with consistent hashing and replication.
 * Simplified model of Cassandra/DynamoDB/Riak.
 *
 * Architecture:
 * - Consistent hash ring partitions keys across nodes
 * - Each key is replicated to N nodes (replication factor)
 * - Reads/writes use quorum (W + R > N guarantees consistency)
 * - Each node runs an LSM tree (or B+ tree) storage engine
 */
public class DistributedKVStore {

    private final int replicationFactor;
    private final TreeMap<Long, String> ring;          // hash → nodeId
    private final Map<String, LSMTree> nodeEngines;    // nodeId → storage
    private final int virtualNodes;

    public DistributedKVStore(List<String> nodes, int replicationFactor,
                               int virtualNodes) throws IOException {
        this.replicationFactor = replicationFactor;
        this.virtualNodes = virtualNodes;
        this.ring = new TreeMap<>();
        this.nodeEngines = new HashMap<>();

        for (String node : nodes) {
            addNode(node);
        }
    }

    private void addNode(String nodeId) throws IOException {
        // Add virtual nodes for better distribution
        for (int i = 0; i < virtualNodes; i++) {
            long hash = hash(nodeId + "#" + i);
            ring.put(hash, nodeId);
        }
        nodeEngines.put(nodeId, new LSMTree("/tmp/dkv/" + nodeId));
    }

    /**
     * Write to all replica nodes.
     * Quorum write: succeed if W replicas acknowledge.
     */
    public void put(String key, byte[] value) throws IOException {
        List<String> replicas = getReplicaNodes(key);
        int acks = 0;
        for (String node : replicas) {
            try {
                nodeEngines.get(node).put(key, value);
                acks++;
            } catch (Exception e) {
                // Hinted handoff: store write for failed node, replay later
            }
        }
        int quorum = replicationFactor / 2 + 1;
        if (acks < quorum) {
            throw new IOException("Write quorum not met: " + acks + " < " + quorum);
        }
    }

    /**
     * Read from replica nodes with quorum.
     * Read repair: if replicas disagree, update stale replicas.
     */
    public byte[] get(String key) throws IOException {
        List<String> replicas = getReplicaNodes(key);
        Map<String, byte[]> responses = new HashMap<>();

        for (String node : replicas) {
            try {
                byte[] value = nodeEngines.get(node).get(key);
                if (value != null) {
                    responses.put(node, value);
                }
            } catch (Exception e) {
                // Node unavailable — skip
            }
        }

        int quorum = replicationFactor / 2 + 1;
        if (responses.size() < quorum) {
            throw new IOException("Read quorum not met");
        }

        // Return the most common response (simplified conflict resolution)
        return responses.values().iterator().next();
    }

    /**
     * Find N replica nodes for a key using consistent hashing.
     * Walk clockwise around the ring from the key's hash position.
     */
    private List<String> getReplicaNodes(String key) {
        long hash = hash(key);
        List<String> replicas = new ArrayList<>();
        Set<String> seen = new HashSet<>();

        Map.Entry<Long, String> entry = ring.ceilingEntry(hash);
        if (entry == null) entry = ring.firstEntry();

        while (replicas.size() < replicationFactor) {
            String node = entry.getValue();
            if (seen.add(node)) { // Skip virtual nodes of the same physical node
                replicas.add(node);
            }
            // Move clockwise
            entry = ring.higherEntry(entry.getKey());
            if (entry == null) entry = ring.firstEntry();
        }
        return replicas;
    }

    private long hash(String key) {
        long h = 0;
        for (int i = 0; i < key.length(); i++) {
            h = h * 31 + key.charAt(i);
        }
        return h;
    }
}

// Key data structures:
// - TreeMap for the consistent hash ring: O(log N) node lookup
// - LSMTree per node: O(log N) writes, O(log N × levels) reads
// - HashMap for node → engine mapping: O(1) lookup
//
// Cassandra's actual architecture:
// - Murmur3Partitioner for hash ring (better distribution than our naive hash)
// - Virtual nodes (256 per physical node by default)
// - LSM tree storage engine (memtable → SSTable with leveled compaction)
// - Bloom filter per SSTable (skip 99% of non-matching files)
// - Row cache + key cache + chunk cache for hot data
```

**P12.29** [M] — Log-Structured Storage Engine

```java
/**
 * Bitcask-style log-structured key-value store.
 * Used by Riak's Bitcask backend.
 *
 * Simple design:
 * - All writes append to a log file (sequential I/O)
 * - In-memory hash map maps key → (file, offset)
 * - Reads: hash lookup → seek in file → read value
 * - Compaction: merge old files, keep only latest value per key
 *
 * Constraint: all keys must fit in memory (values can be larger than RAM).
 */
public class BitcaskStore {

    private final String directory;
    private DataOutputStream activeFile;
    private String activeFileName;
    private long activeOffset;

    // Key directory: key → (fileName, offset, length)
    private final Map<String, KeyEntry> keyDir;

    public BitcaskStore(String directory) throws IOException {
        this.directory = directory;
        this.keyDir = new ConcurrentHashMap<>();
        rotateFile();
    }

    public void put(String key, byte[] value) throws IOException {
        // Write to append-only file
        byte[] keyBytes = key.getBytes("UTF-8");
        long offset = activeOffset;

        activeFile.writeInt(keyBytes.length);
        activeFile.write(keyBytes);
        activeFile.writeInt(value.length);
        activeFile.write(value);
        activeFile.flush();

        int recordSize = 4 + keyBytes.length + 4 + value.length;
        activeOffset += recordSize;

        // Update in-memory key directory
        keyDir.put(key, new KeyEntry(activeFileName, offset, recordSize));
    }

    public byte[] get(String key) throws IOException {
        KeyEntry entry = keyDir.get(key);
        if (entry == null) return null;

        try (RandomAccessFile file = new RandomAccessFile(entry.fileName, "r")) {
            file.seek(entry.offset);
            int keyLen = file.readInt();
            file.skipBytes(keyLen); // Skip key
            int valueLen = file.readInt();
            byte[] value = new byte[valueLen];
            file.readFully(value);
            return value;
        }
    }

    private void rotateFile() throws IOException {
        if (activeFile != null) activeFile.close();
        activeFileName = directory + "/data_" + System.currentTimeMillis() + ".log";
        activeFile = new DataOutputStream(
            new BufferedOutputStream(new FileOutputStream(activeFileName)));
        activeOffset = 0;
    }

    private record KeyEntry(String fileName, long offset, int length) {}
}

// Complexity:
//   Write: O(1) — append to file + hash map update
//   Read: O(1) — hash map lookup + 1 disk seek + 1 disk read
//   Space: O(K) in memory where K = number of unique keys
//
// Trade-off vs LSM tree:
//   Bitcask: faster reads (single disk seek), but ALL keys must fit in RAM
//   LSM tree: keys can be on disk (more scalable), but reads check multiple levels
```

**P12.30** [H] — Design a Time-Series Database

```java
/**
 * Simple time-series database combining:
 * - In-memory ring buffer for recent data (hot tier)
 * - Append-only files for historical data (cold tier)
 * - Downsampling for long-term retention
 *
 * Models the architecture of Prometheus TSDB / InfluxDB.
 */
public class TimeSeriesDB {

    private final Map<String, TimeSeriesRingBuffer> hotData; // metric → recent data
    private final Map<String, List<TimeSeriesFile>> coldData; // metric → historical files
    private final int hotCapacity;       // Data points in memory per metric
    private final long flushIntervalMs;  // How often to flush to disk
    private final String dataDir;

    public TimeSeriesDB(String dataDir, int hotCapacity, long flushIntervalMs) {
        this.dataDir = dataDir;
        this.hotCapacity = hotCapacity;
        this.flushIntervalMs = flushIntervalMs;
        this.hotData = new ConcurrentHashMap<>();
        this.coldData = new ConcurrentHashMap<>();
    }

    /**
     * Ingest a data point. O(1).
     */
    public void write(String metric, long timestamp, double value) {
        hotData.computeIfAbsent(metric, k -> new TimeSeriesRingBuffer(hotCapacity))
               .append(timestamp, value);
    }

    /**
     * Query a time range. Merges hot (memory) and cold (disk) data.
     */
    public List<TimeSeriesRingBuffer.DataPoint> query(String metric,
                                                       long startTime,
                                                       long endTime) {
        List<TimeSeriesRingBuffer.DataPoint> results = new ArrayList<>();

        // Check hot data (in memory)
        TimeSeriesRingBuffer hot = hotData.get(metric);
        if (hot != null) {
            results.addAll(hot.query(startTime, endTime));
        }

        // Check cold data (on disk)
        List<TimeSeriesFile> files = coldData.getOrDefault(metric, Collections.emptyList());
        for (TimeSeriesFile file : files) {
            if (file.maxTimestamp() >= startTime && file.minTimestamp() <= endTime) {
                // Read from file (not shown: actual file reading)
            }
        }

        results.sort(Comparator.comparingLong(TimeSeriesRingBuffer.DataPoint::timestamp));
        return results;
    }

    /**
     * Aggregate query: compute AVG/MIN/MAX/SUM over a time window.
     */
    public double aggregate(String metric, long startTime, long endTime,
                            String function) {
        TimeSeriesRingBuffer hot = hotData.get(metric);
        if (hot == null) return 0;

        return switch (function.toUpperCase()) {
            case "AVG" -> hot.average(startTime, endTime);
            default -> throw new IllegalArgumentException("Unknown function: " + function);
        };
    }
}
```

### More Database Problems

**P12.31** [E] — Calculate B+ Tree Height

```java
/**
 * Given a table size and page parameters, calculate the B+ tree height.
 */
public static int bplusTreeHeight(long rowCount, int pageSize,
                                    int keySize, int rowSize) {
    // Internal node fan-out
    int ptrSize = 4; // Page number
    int overheadPerEntry = 5; // Record header
    int usable = pageSize - 200; // Header/trailer overhead
    int fanOut = usable / (keySize + ptrSize + overheadPerEntry);

    // Leaf node capacity
    int leafCapacity = usable / (rowSize + overheadPerEntry);

    // Calculate height
    long capacity = leafCapacity; // Height 1: single leaf
    int height = 1;
    while (capacity < rowCount) {
        capacity *= fanOut;
        height++;
    }
    return height;
}

// Examples:
// 10M rows, 16KB pages, 8-byte key, 200-byte row:
//   Fan-out: ~952, Leaf capacity: ~80
//   Height 1: 80 rows
//   Height 2: 80 × 952 = 76,160 rows
//   Height 3: 76,160 × 952 = 72.5M rows → sufficient
//   Height = 3 (root + 1 internal level + leaves)
//
// 1B rows: Height = 4
// 100B rows: Height = 5 (still only 5 disk reads!)
```

**P12.32** [E] — Explain Clustered vs Secondary Index Lookup

```java
// Clustered index lookup (by primary key):
//   SELECT * FROM users WHERE id = 42
//   1. Search B+ tree root → internal node → leaf node
//   2. Leaf node contains the FULL ROW data
//   3. Done. 3-4 I/Os.

// Secondary index lookup (by non-primary column):
//   SELECT * FROM users WHERE email = 'alice@example.com'
//   1. Search secondary index B+ tree → find PK value (id = 42)
//   2. Search clustered index B+ tree with PK = 42 → get full row
//   3. Done. 6-8 I/Os (double the cost).

// Covering index (avoids the double lookup):
//   CREATE INDEX idx_email_name ON users(email, name);
//   SELECT name FROM users WHERE email = 'alice@example.com'
//   1. Search secondary index → leaf contains (email, name, PK)
//   2. 'name' is IN the index — no need to visit clustered index!
//   3. Done. 3-4 I/Os. This is a "covering index" or "index-only scan."
//
// EXPLAIN output shows "Using index" for covering index queries.
```

**P12.33** [E] — Compare B+ Tree vs Hash Index

```java
// Hash index (InnoDB Adaptive Hash Index, PostgreSQL hash index):
//   Equality: O(1) → faster than B+ tree O(log N)
//   Range:    NOT SUPPORTED — hash destroys ordering
//   Sorting:  NOT SUPPORTED
//   Prefix:   NOT SUPPORTED
//
// B+ tree index:
//   Equality: O(log N) → slightly slower
//   Range:    O(log N + K) → follow leaf links
//   Sorting:  Supported (index is sorted)
//   Prefix:   Supported (leftmost prefix of composite index)
//
// InnoDB's Adaptive Hash Index (AHI):
//   InnoDB automatically builds a hash index on top of frequently
//   accessed B+ tree pages. It is a cache, not a replacement.
//   Disable with innodb_adaptive_hash_index=OFF if it causes contention.
//
// When to use hash index:
//   - Exact key-value lookups (cache, session store)
//   - Never need range queries or sorting
//   - Example: Redis (hash table), Memcached (hash table)
```

**P12.34** [M] — Implement a Simple Database Buffer Manager

```java
/**
 * Buffer manager that coordinates between buffer pool and disk.
 * Implements the pin/unpin protocol used by PostgreSQL and InnoDB.
 */
public class BufferManager {

    private final BufferPool pool;
    private final Map<Long, byte[]> diskPages; // Simulated disk

    public BufferManager(int poolSize) {
        this.pool = new BufferPool(poolSize);
        this.diskPages = new ConcurrentHashMap<>();
    }

    /**
     * Pin a page: fetch it into the buffer pool and prevent eviction.
     * The caller MUST call unpin() when done.
     *
     * PostgreSQL: PinBuffer() increments refcount.
     *             Buffer with refcount > 0 cannot be evicted.
     *             Forgetting to unpin = buffer leak = pool exhaustion.
     */
    public BufferPool.BufferPage pin(int tableId, int pageNo) throws IOException {
        return pool.fetchPage(tableId, pageNo);
    }

    /**
     * Unpin a page: allow eviction.
     * The page stays in the pool until evicted — subsequent accesses are cache hits.
     */
    public void unpin(BufferPool.BufferPage page) {
        pool.releasePage(page);
    }

    /**
     * Modify a page in the buffer pool.
     * Marks it dirty so it will be written back to disk on eviction or checkpoint.
     */
    public void modifyPage(BufferPool.BufferPage page, long lsn,
                           java.util.function.Consumer<byte[]> modifier) {
        modifier.accept(page.data);
        pool.markDirty(page, lsn);
    }

    public double hitRate() { return pool.hitRate(); }
}

// Pin/unpin is the database equivalent of reference counting in C/C++.
// It is why database connection leaks are so dangerous: a leaked
// connection holds pinned buffers that can never be evicted,
// eventually exhausting the buffer pool.
```

**P12.35** [M] — Implement Sorted String Table Merge

```java
/**
 * Merge two sorted arrays (representing SSTable data blocks)
 * into one sorted array. This is the fundamental operation
 * in LSM tree compaction and external merge sort.
 */
public static String[] mergeSorted(String[] a, String[] b) {
    String[] result = new String[a.length + b.length];
    int i = 0, j = 0, k = 0;

    while (i < a.length && j < b.length) {
        if (a[i].compareTo(b[j]) <= 0) {
            result[k++] = a[i++];
        } else {
            result[k++] = b[j++];
        }
    }
    while (i < a.length) result[k++] = a[i++];
    while (j < b.length) result[k++] = b[j++];

    return result;
}

// Complexity: O(N + M) time, O(N + M) space
// This is the merge step of merge sort — the same algorithm
// used in LSM compaction, external sort, and the UNION ALL
// of two sorted result sets in a database query plan.
//
// For K-way merge (compaction of K SSTables): use PriorityQueue
// Time: O(N log K) where N = total entries
```

**P12.36** [M] — Column Store vs Row Store

```java
/**
 * Demonstrate the difference between row-oriented and column-oriented storage.
 *
 * Row store (InnoDB, PostgreSQL): store all columns of a row together
 *   Good for: OLTP (SELECT * WHERE id = X, INSERT full row)
 *   Bad for:  Analytics (SELECT AVG(price) — reads all columns but uses one)
 *
 * Column store (ClickHouse, Parquet, Redshift): store each column separately
 *   Good for: Analytics (SELECT AVG(price) — reads only the price column)
 *   Bad for:  OLTP (INSERT — must write to every column file)
 */
public class ColumnStore {

    // Each column stored as a separate array — contiguous in memory
    private int[] ids;
    private String[] names;
    private double[] prices;
    private int size;

    public ColumnStore(int capacity) {
        this.ids = new int[capacity];
        this.names = new String[capacity];
        this.prices = new double[capacity];
    }

    public void addRow(int id, String name, double price) {
        ids[size] = id;
        names[size] = name;
        prices[size] = price;
        size++;
    }

    /**
     * Columnar aggregation: only reads the price column.
     * Memory access: sequential scan of double[] — perfect cache utilization.
     * If table has 100 columns, we read 1/100th of the data.
     */
    public double averagePrice() {
        double sum = 0;
        for (int i = 0; i < size; i++) {
            sum += prices[i]; // Sequential access → hardware prefetching
        }
        return sum / size;
    }

    /**
     * Columnar filter: scan status column, then fetch matching rows.
     */
    public List<Integer> findByPriceRange(double min, double max) {
        List<Integer> matchingIds = new ArrayList<>();
        for (int i = 0; i < size; i++) {
            if (prices[i] >= min && prices[i] <= max) {
                matchingIds.add(ids[i]); // Only access id column for matches
            }
        }
        return matchingIds;
    }
}

// JVM insight:
// The double[] prices array is contiguous in memory.
// For 10M rows: 80 MB of doubles, filling ~1.25M cache lines.
// Hardware prefetcher detects the sequential pattern and preloads.
// A row store with 100 columns × 10M rows: accessing prices touches
// all 100 columns per row = 100x more memory traffic (and cache misses).
//
// This is why ClickHouse can scan billions of rows per second:
// columnar storage + vectorized execution + SIMD on contiguous arrays.
```

**P12.37** [E] — Write-Ahead Log Group Commit

```java
/**
 * Group commit: batch multiple transaction commits into a single fsync().
 *
 * Without group commit:
 *   100 concurrent transactions → 100 fsync() calls/second
 *   fsync() on SSD: ~0.1ms → max 10,000 commits/second
 *   fsync() on HDD: ~10ms → max 100 commits/second
 *
 * With group commit:
 *   100 concurrent transactions → 1 fsync() commits all of them
 *   Throughput: 10-100x improvement
 */
public class GroupCommitWAL {

    private final FileChannel channel;
    private final ByteBuffer buffer;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition commitReady = lock.newCondition();
    private long pendingLSN;
    private long syncedLSN;
    private int pendingCount;

    // Configuration
    private final int groupCommitDelay;  // Microseconds to wait for batch
    private final int maxGroupSize;       // Max transactions per group

    public GroupCommitWAL(FileChannel channel, int groupCommitDelayUs,
                          int maxGroupSize) {
        this.channel = channel;
        this.buffer = ByteBuffer.allocateDirect(4 * 1024 * 1024);
        this.groupCommitDelay = groupCommitDelayUs;
        this.maxGroupSize = maxGroupSize;
    }

    /**
     * Commit a transaction. May wait briefly to batch with other commits.
     */
    public void commitTransaction(long lsn) throws IOException {
        lock.lock();
        try {
            pendingCount++;
            pendingLSN = Math.max(pendingLSN, lsn);

            // If we are the first in the group, wait for more to join
            if (pendingCount == 1) {
                try {
                    commitReady.await(groupCommitDelay, TimeUnit.MICROSECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }

            // If group is full or we are the first, perform the sync
            if (pendingCount >= maxGroupSize || pendingLSN > syncedLSN) {
                flushAndSync();
                pendingCount = 0;
                syncedLSN = pendingLSN;
                commitReady.signalAll(); // Wake up all waiting committers
            } else {
                // Wait for the leader to sync
                while (syncedLSN < lsn) {
                    try { commitReady.await(); } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
        } finally {
            lock.unlock();
        }
    }

    private void flushAndSync() throws IOException {
        buffer.flip();
        while (buffer.hasRemaining()) channel.write(buffer);
        buffer.clear();
        channel.force(false); // Single fsync for the entire group
    }
}
```

**P12.38** [H] — Implement MVCC (Multi-Version Concurrency Control)

```java
/**
 * Simplified MVCC: each row has multiple versions, readers see a
 * consistent snapshot without blocking writers.
 *
 * PostgreSQL MVCC: each row version has xmin (creating transaction)
 *   and xmax (deleting transaction). A transaction sees a row if:
 *   xmin <= my_txn_id AND (xmax is null OR xmax > my_txn_id)
 *
 * InnoDB MVCC: uses undo log to reconstruct old versions.
 *   Current row → undo record → older undo record → ...
 *   A read creates a "read view" (snapshot of active transactions).
 */
public class MVCCStore {

    private final Map<String, List<VersionedValue>> store;
    private final AtomicLong txnCounter = new AtomicLong(0);
    private final Set<Long> activeTxns = ConcurrentHashMap.newKeySet();

    public MVCCStore() {
        this.store = new ConcurrentHashMap<>();
    }

    public long beginTransaction() {
        long txnId = txnCounter.incrementAndGet();
        activeTxns.add(txnId);
        return txnId;
    }

    public void put(long txnId, String key, String value) {
        store.computeIfAbsent(key, k -> new CopyOnWriteArrayList<>())
             .add(new VersionedValue(value, txnId, Long.MAX_VALUE));
    }

    /**
     * Read: find the latest version visible to this transaction.
     * A version is visible if:
     *   1. It was created by a committed transaction with id <= mine
     *   2. It has not been deleted by a committed transaction with id <= mine
     */
    public String get(long txnId, String key) {
        List<VersionedValue> versions = store.get(key);
        if (versions == null) return null;

        // Scan versions newest-first
        for (int i = versions.size() - 1; i >= 0; i--) {
            VersionedValue v = versions.get(i);
            if (v.createdBy <= txnId && !activeTxns.contains(v.createdBy)) {
                if (v.deletedBy > txnId || activeTxns.contains(v.deletedBy)) {
                    return v.value; // This version is visible
                }
            }
        }
        return null;
    }

    public void commit(long txnId) {
        activeTxns.remove(txnId);
    }

    public void rollback(long txnId) {
        // Remove all versions created by this transaction
        for (List<VersionedValue> versions : store.values()) {
            versions.removeIf(v -> v.createdBy == txnId);
        }
        activeTxns.remove(txnId);
    }

    private record VersionedValue(String value, long createdBy, long deletedBy) {}
}

// This is extremely simplified. Real MVCC systems:
// - PostgreSQL: stores old versions in the heap (causes table bloat → VACUUM)
// - InnoDB: stores old versions in undo log (separate tablespace)
// - CockroachDB: stores versions in the LSM tree with timestamps as key suffix
```

**P12.39** [M] — Skip List MemTable

```java
/**
 * Skip list implementation for use as an LSM tree memtable.
 * ConcurrentSkipListMap is the JDK implementation, but understanding
 * the skip list structure helps understand why it is chosen over TreeMap.
 *
 * Why skip list for memtable?
 * - Lock-free reads (compare-and-swap for inserts)
 * - O(log N) search/insert like balanced BST
 * - No rebalancing rotations (unlike red-black tree)
 * - Cache-friendlier than tree nodes (forward pointers are arrays)
 */
public class SkipListMemTable<K extends Comparable<K>, V> {

    private static final int MAX_LEVEL = 32;
    private static final double PROBABILITY = 0.25; // 1/4 chance per level

    @SuppressWarnings("unchecked")
    private final Node<K, V>[] head = new Node[MAX_LEVEL];
    private int currentLevel = 0;
    private int size = 0;
    private final ThreadLocalRandom random = ThreadLocalRandom.current();

    private static class Node<K, V> {
        final K key;
        volatile V value;
        final Node<K, V>[] forward;

        @SuppressWarnings("unchecked")
        Node(K key, V value, int level) {
            this.key = key;
            this.value = value;
            this.forward = new Node[level + 1];
        }
    }

    @SuppressWarnings("unchecked")
    public void put(K key, V value) {
        Node<K, V>[] update = new Node[MAX_LEVEL];
        Node<K, V> current = null;

        // Search from top level down
        for (int i = currentLevel; i >= 0; i--) {
            Node<K, V> node = (i == currentLevel) ? head[i] : (current != null ? current : head[i]);
            current = null;
            while (node != null) {
                Node<K, V> next = node.forward[i];
                if (next != null && next.key.compareTo(key) < 0) {
                    node = next;
                } else if (next != null && next.key.compareTo(key) == 0) {
                    next.value = value; // Update existing key
                    return;
                } else {
                    update[i] = node;
                    current = node;
                    break;
                }
            }
            if (current == null) update[i] = null;
        }

        // Random level for new node
        int newLevel = randomLevel();
        if (newLevel > currentLevel) {
            for (int i = currentLevel + 1; i <= newLevel; i++) {
                head[i] = head[i]; // Ensure head exists at this level
                update[i] = null;
            }
            currentLevel = newLevel;
        }

        Node<K, V> newNode = new Node<>(key, value, newLevel);
        for (int i = 0; i <= newLevel; i++) {
            if (update[i] != null) {
                newNode.forward[i] = update[i].forward[i];
                update[i].forward[i] = newNode;
            } else {
                newNode.forward[i] = head[i];
                head[i] = newNode;
            }
        }
        size++;
    }

    public V get(K key) {
        for (int i = currentLevel; i >= 0; i--) {
            Node<K, V> node = head[i];
            while (node != null) {
                int cmp = node.key.compareTo(key);
                if (cmp == 0) return node.value;
                if (cmp > 0) break;
                Node<K, V> next = node.forward[i];
                if (next == null || next.key.compareTo(key) > 0) break;
                node = next;
            }
        }
        return null;
    }

    private int randomLevel() {
        int level = 0;
        while (level < MAX_LEVEL - 1 && random.nextDouble() < PROBABILITY) {
            level++;
        }
        return level;
    }

    public int size() { return size; }
}

// Expected height: O(log_{1/p} N) = O(log4 N) with p=0.25
// Search/Insert: O(log N) expected
// Space: O(N) expected (each node has 1/(1-p) = 1.33 forward pointers on average)
//
// RocksDB's skip list uses memory pools (arena allocation) to minimize
// heap fragmentation and GC pressure. Each memtable's skip list allocates
// from a pre-allocated byte[] arena instead of individual new Node() calls.
```

**P12.40** [H] — Page Split Visualization

```java
/**
 * Visualize a B+ tree page split step by step.
 * This is what happens when you INSERT into a full InnoDB page.
 */
public class PageSplitDemo {

    public static void demonstrate() {
        // Initial state: order-5 B+ tree (max 4 keys per node)
        // Leaf node L1: [10, 20, 30, 40] → FULL
        // Parent: [...| 50 |...] with L1 and L2 as children

        System.out.println("=== Before Insert(25) ===");
        System.out.println("Parent: [50]");
        System.out.println("  L1: [10, 20, 30, 40] (full!)");
        System.out.println("  L2: [50, 60, 70]");

        // Insert 25: goes into L1, but L1 is full → SPLIT
        System.out.println("\n=== Split L1 ===");
        System.out.println("Step 1: Insert 25 into sorted position → [10, 20, 25, 30, 40]");
        System.out.println("Step 2: Split at midpoint:");
        System.out.println("  L1 (left):  [10, 20]");
        System.out.println("  L3 (right): [25, 30, 40]");
        System.out.println("Step 3: Promote first key of L3 (25) to parent");
        System.out.println("Step 4: Link L1 → L3 → L2 (update leaf linked list)");

        System.out.println("\n=== After Insert(25) ===");
        System.out.println("Parent: [25, 50]");
        System.out.println("  L1: [10, 20]  →  L3: [25, 30, 40]  →  L2: [50, 60, 70]");

        // Impact on InnoDB:
        System.out.println("\n=== InnoDB Impact ===");
        System.out.println("1. Allocate new 16KB page for L3");
        System.out.println("2. Copy half of L1's records to L3");
        System.out.println("3. Update L1's next-page pointer to L3");
        System.out.println("4. Update L3's next-page pointer to L2");
        System.out.println("5. Insert separator key into parent page");
        System.out.println("6. Write all 3 modified pages to WAL (redo log)");
        System.out.println("7. Mark all 3 pages dirty in buffer pool");
        System.out.println("\nWhy UUID PKs are bad: random UUIDs cause splits on EVERY");
        System.out.println("leaf page across the tree → massive I/O amplification.");
        System.out.println("Auto-increment PKs: inserts always at the rightmost leaf →");
        System.out.println("only that leaf ever splits → predictable, sequential I/O.");
    }
}
```

**P12.41** [E] — Serialize/Deserialize Key-Value Pair

```java
/**
 * Binary serialization of key-value pairs for SSTable storage.
 * The format must be self-describing (include lengths) for sequential reading.
 */
public class KVSerializer {

    /**
     * Serialize: [keyLen:4][key:var][valLen:4][val:var]
     */
    public static byte[] serialize(String key, byte[] value) {
        byte[] keyBytes = key.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        ByteBuffer buf = ByteBuffer.allocate(4 + keyBytes.length + 4 + value.length);
        buf.putInt(keyBytes.length);
        buf.put(keyBytes);
        buf.putInt(value.length);
        buf.put(value);
        return buf.array();
    }

    /**
     * Deserialize from a ByteBuffer (positioned at the start of a record).
     */
    public static Map.Entry<String, byte[]> deserialize(ByteBuffer buf) {
        int keyLen = buf.getInt();
        byte[] keyBytes = new byte[keyLen];
        buf.get(keyBytes);
        String key = new String(keyBytes, java.nio.charset.StandardCharsets.UTF_8);

        int valLen = buf.getInt();
        byte[] value = new byte[valLen];
        buf.get(value);

        return Map.entry(key, value);
    }
}

// This is the exact format used in LevelDB's log files.
// Production formats add:
// - CRC32 checksum per record
// - Record type (PUT/DELETE/MERGE)
// - Sequence number (for MVCC ordering)
// - Compression flag
```

**P12.42** [M] — Implement a Write-Optimized B-Tree (Fractal Tree)

```java
/**
 * Fractal tree (simplified): a B-tree where each internal node
 * has a message buffer. Writes are buffered and pushed down lazily.
 *
 * Used by TokuDB (MySQL), PerconaFT (Percona Server).
 *
 * Write performance: O(log_B(N) / B) amortized per insert
 * (B times better than B+ tree's O(log_B(N)))
 *
 * The message buffer amortizes the cost of random I/O:
 * instead of writing to a random leaf on each insert,
 * buffer many inserts in internal nodes and push them down
 * in batches — converting random writes to sequential writes.
 */
public class FractalTree<K extends Comparable<K>, V> {

    private final int order;
    private final int bufferSize; // Messages per node buffer

    private class FractalNode {
        List<K> keys;
        List<FractalNode> children;
        List<Message<K, V>> messageBuffer; // Buffered writes

        FractalNode() {
            keys = new ArrayList<>();
            children = new ArrayList<>();
            messageBuffer = new ArrayList<>();
        }

        void bufferMessage(Message<K, V> msg) {
            messageBuffer.add(msg);
            if (messageBuffer.size() >= bufferSize) {
                flushBuffer();
            }
        }

        void flushBuffer() {
            // Sort messages by key
            messageBuffer.sort(Comparator.comparing(m -> m.key));

            // Push messages to appropriate children
            for (Message<K, V> msg : messageBuffer) {
                int childIdx = findChild(msg.key);
                if (children.isEmpty()) {
                    // Leaf: apply the message directly
                    applyMessage(msg);
                } else {
                    children.get(childIdx).bufferMessage(msg);
                }
            }
            messageBuffer.clear();
        }

        private int findChild(K key) {
            int idx = Collections.binarySearch(keys, key);
            return idx >= 0 ? idx + 1 : -(idx + 1);
        }

        private void applyMessage(Message<K, V> msg) {
            // Apply insert/update/delete to the leaf
        }
    }

    private record Message<K, V>(K key, V value, MessageType type) {}
    private enum MessageType { INSERT, UPDATE, DELETE }

    public FractalTree(int order, int bufferSize) {
        this.order = order;
        this.bufferSize = bufferSize;
    }
}

// The fractal tree's key innovation: each internal node dedicates
// sqrt(B) space to keys/pointers and sqrt(B) space to message buffer.
// When the buffer fills, messages are flushed to children in one
// sequential I/O — amortizing the cost over B/sqrt(B) = sqrt(B) messages.
//
// Result: write throughput 10-50x better than B+ tree for random workloads,
// while maintaining O(log N) read performance.
```

**P12.43** [H] — Implement a Persistent Red-Black Tree (Functional/Immutable)

```java
/**
 * Persistent (immutable) red-black tree: every modification
 * creates a new version of the tree, sharing structure with old versions.
 *
 * Used by:
 * - Datomic database: immutable database with full history
 * - CouchDB: append-only B-tree with MVCC
 * - Git: immutable tree of commits
 *
 * Path copying: only nodes on the root-to-modified-leaf path are cloned.
 * For a balanced tree of N nodes, this is O(log N) new nodes per update.
 */
public class PersistentRBTree<K extends Comparable<K>, V> {

    private static final boolean RED = true;
    private static final boolean BLACK = false;

    private record Node<K, V>(K key, V value, Node<K, V> left, Node<K, V> right,
                                boolean color) {}

    private final Node<K, V> root;
    private final int size;

    public PersistentRBTree() {
        this.root = null;
        this.size = 0;
    }

    private PersistentRBTree(Node<K, V> root, int size) {
        this.root = root;
        this.size = size;
    }

    /**
     * Insert returns a NEW tree. The old tree is unchanged.
     * O(log N) time and space (path copying).
     */
    public PersistentRBTree<K, V> put(K key, V value) {
        Node<K, V> newRoot = insert(root, key, value);
        // Force root to be black
        newRoot = new Node<>(newRoot.key, newRoot.value, newRoot.left, newRoot.right, BLACK);
        return new PersistentRBTree<>(newRoot, size + 1);
    }

    public V get(K key) {
        Node<K, V> node = root;
        while (node != null) {
            int cmp = key.compareTo(node.key);
            if (cmp < 0) node = node.left;
            else if (cmp > 0) node = node.right;
            else return node.value;
        }
        return null;
    }

    private Node<K, V> insert(Node<K, V> node, K key, V value) {
        if (node == null) return new Node<>(key, value, null, null, RED);

        int cmp = key.compareTo(node.key);
        Node<K, V> left = node.left, right = node.right;

        if (cmp < 0) left = insert(left, key, value);
        else if (cmp > 0) right = insert(right, key, value);
        else return new Node<>(key, value, left, right, node.color); // Update

        // Create new node (path copying) with rebalancing
        Node<K, V> result = new Node<>(node.key, node.value, left, right, node.color);

        // Red-black tree fixups (left-leaning variant)
        if (isRed(right) && !isRed(left)) result = rotateLeft(result);
        if (isRed(result.left) && isRed(result.left.left)) result = rotateRight(result);
        if (isRed(result.left) && isRed(result.right)) result = flipColors(result);

        return result;
    }

    private boolean isRed(Node<K, V> node) { return node != null && node.color == RED; }

    private Node<K, V> rotateLeft(Node<K, V> h) {
        Node<K, V> x = h.right;
        return new Node<>(x.key, x.value,
            new Node<>(h.key, h.value, h.left, x.left, RED),
            x.right, h.color);
    }

    private Node<K, V> rotateRight(Node<K, V> h) {
        Node<K, V> x = h.left;
        return new Node<>(x.key, x.value, x.left,
            new Node<>(h.key, h.value, x.right, h.right, RED),
            h.color);
    }

    private Node<K, V> flipColors(Node<K, V> h) {
        return new Node<>(h.key, h.value,
            new Node<>(h.left.key, h.left.value, h.left.left, h.left.right, BLACK),
            new Node<>(h.right.key, h.right.value, h.right.left, h.right.right, BLACK),
            RED);
    }

    public int size() { return size; }
}

// Space per version: O(log N) new nodes (shared structure with previous version)
// Time per insert: O(log N)
// Total space for V versions: O(N + V log N)
//
// JVM insight: every insert creates O(log N) new Node objects.
// For a tree with 1M entries, each insert creates ~20 new Nodes × 40 bytes = 800 bytes.
// With millions of versions, this generates significant GC pressure.
// Production systems (Datomic) use off-heap storage or serialized segments.
```

**P12.44** [E] — Consistent Hashing for Database Sharding

```java
/**
 * Consistent hashing for distributing data across database shards.
 * Used by: Cassandra, DynamoDB, Riak, Redis Cluster.
 *
 * Property: adding/removing a shard only moves ~1/N of the keys
 * (vs. naive modular hashing which moves ~(N-1)/N keys).
 */
public class ConsistentHashRing<T> {

    private final TreeMap<Long, T> ring = new TreeMap<>();
    private final int virtualNodes;
    private final java.util.function.Function<String, Long> hashFn;

    public ConsistentHashRing(int virtualNodes) {
        this.virtualNodes = virtualNodes;
        this.hashFn = this::hash;
    }

    public void addNode(T node) {
        for (int i = 0; i < virtualNodes; i++) {
            long h = hashFn.apply(node.toString() + "#" + i);
            ring.put(h, node);
        }
    }

    public void removeNode(T node) {
        for (int i = 0; i < virtualNodes; i++) {
            long h = hashFn.apply(node.toString() + "#" + i);
            ring.remove(h);
        }
    }

    /**
     * Find the node responsible for a given key.
     * O(log N) using TreeMap.ceilingEntry().
     */
    public T getNode(String key) {
        if (ring.isEmpty()) return null;
        long h = hashFn.apply(key);
        Map.Entry<Long, T> entry = ring.ceilingEntry(h);
        return (entry != null ? entry : ring.firstEntry()).getValue();
    }

    private long hash(String key) {
        long h = 0xcbf29ce484222325L;
        for (int i = 0; i < key.length(); i++) {
            h ^= key.charAt(i);
            h *= 0x100000001b3L;
        }
        return h;
    }
}

// Virtual nodes solve the load balancing problem:
// With 1 point per node, the ring is uneven → hot spots.
// With 150+ virtual nodes per physical node, the ring is well-distributed.
// Cassandra default: 256 virtual nodes per physical node (num_tokens).
```

**P12.45** [M] — Implement a Database Lock Manager

```java
/**
 * Lock manager for database transactions.
 * Supports shared (read) and exclusive (write) locks.
 *
 * PostgreSQL: heavyweight locks managed by the lock manager
 * InnoDB: row-level locks stored in the lock system hash table
 */
public class LockManager {

    private final Map<String, LockEntry> lockTable = new ConcurrentHashMap<>();

    public boolean acquireShared(String resource, long txnId, long timeoutMs)
            throws InterruptedException {
        LockEntry entry = lockTable.computeIfAbsent(resource, k -> new LockEntry());
        synchronized (entry) {
            long deadline = System.currentTimeMillis() + timeoutMs;
            while (entry.exclusiveOwner != -1 && entry.exclusiveOwner != txnId) {
                long wait = deadline - System.currentTimeMillis();
                if (wait <= 0) return false; // Timeout → deadlock avoidance
                entry.wait(wait);
            }
            entry.sharedOwners.add(txnId);
            return true;
        }
    }

    public boolean acquireExclusive(String resource, long txnId, long timeoutMs)
            throws InterruptedException {
        LockEntry entry = lockTable.computeIfAbsent(resource, k -> new LockEntry());
        synchronized (entry) {
            long deadline = System.currentTimeMillis() + timeoutMs;
            while ((entry.exclusiveOwner != -1 && entry.exclusiveOwner != txnId) ||
                   (!entry.sharedOwners.isEmpty() &&
                    !(entry.sharedOwners.size() == 1 && entry.sharedOwners.contains(txnId)))) {
                long wait = deadline - System.currentTimeMillis();
                if (wait <= 0) return false;
                entry.wait(wait);
            }
            entry.exclusiveOwner = txnId;
            return true;
        }
    }

    public void release(String resource, long txnId) {
        LockEntry entry = lockTable.get(resource);
        if (entry == null) return;
        synchronized (entry) {
            entry.sharedOwners.remove(txnId);
            if (entry.exclusiveOwner == txnId) entry.exclusiveOwner = -1;
            entry.notifyAll();
        }
    }

    private static class LockEntry {
        final Set<Long> sharedOwners = new HashSet<>();
        long exclusiveOwner = -1;
    }
}

// Complexity: O(1) per lock/unlock operation
// Deadlock detection: build a wait-for graph (directed graph where
// edge A→B means txn A waits for a lock held by txn B).
// If the graph has a cycle → deadlock. Abort one transaction.
// InnoDB checks for deadlock cycles on every lock wait.
```

**P12.46** [H] — Implement an External Merge Sort

```java
/**
 * External merge sort: sort data larger than available memory.
 * Used by databases for ORDER BY on large result sets,
 * and by LSM tree compaction.
 *
 * Phase 1 (Sort runs): read chunks that fit in memory, sort them, write to temp files.
 * Phase 2 (Merge): k-way merge the sorted temp files.
 */
public class ExternalMergeSort {

    private final int chunkSize; // Records per chunk (limited by memory)

    public ExternalMergeSort(int chunkSize) {
        this.chunkSize = chunkSize;
    }

    /**
     * Sort a large file using external merge sort.
     * Time: O(N log N) total, O(N log K) for merge phase
     * Disk I/O: O(N/M × log_{M}(N/M)) passes, each reading N records
     * where M = records per chunk
     */
    public void sort(String inputFile, String outputFile) throws IOException {
        // Phase 1: Create sorted runs
        List<String> runFiles = createSortedRuns(inputFile);

        // Phase 2: K-way merge
        mergeRuns(runFiles, outputFile);

        // Cleanup temp files
        for (String f : runFiles) new java.io.File(f).delete();
    }

    private List<String> createSortedRuns(String inputFile) throws IOException {
        List<String> runFiles = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new FileReader(inputFile))) {
            List<String> chunk = new ArrayList<>(chunkSize);
            String line;
            int runCount = 0;

            while ((line = reader.readLine()) != null) {
                chunk.add(line);
                if (chunk.size() >= chunkSize) {
                    // Sort in memory
                    Collections.sort(chunk);
                    // Write sorted run to temp file
                    String runFile = inputFile + ".run_" + runCount++;
                    try (BufferedWriter writer = new BufferedWriter(new FileWriter(runFile))) {
                        for (String s : chunk) {
                            writer.write(s);
                            writer.newLine();
                        }
                    }
                    runFiles.add(runFile);
                    chunk.clear();
                }
            }

            // Handle remaining records
            if (!chunk.isEmpty()) {
                Collections.sort(chunk);
                String runFile = inputFile + ".run_" + runCount;
                try (BufferedWriter writer = new BufferedWriter(new FileWriter(runFile))) {
                    for (String s : chunk) {
                        writer.write(s);
                        writer.newLine();
                    }
                }
                runFiles.add(runFile);
            }
        }
        return runFiles;
    }

    private void mergeRuns(List<String> runFiles, String outputFile) throws IOException {
        PriorityQueue<RunReader> heap = new PriorityQueue<>(
            Comparator.comparing(r -> r.currentLine)
        );

        // Open all run files
        List<BufferedReader> readers = new ArrayList<>();
        for (String runFile : runFiles) {
            BufferedReader reader = new BufferedReader(new FileReader(runFile));
            readers.add(reader);
            String firstLine = reader.readLine();
            if (firstLine != null) {
                heap.offer(new RunReader(firstLine, reader));
            }
        }

        // K-way merge
        try (BufferedWriter writer = new BufferedWriter(new FileWriter(outputFile))) {
            while (!heap.isEmpty()) {
                RunReader min = heap.poll();
                writer.write(min.currentLine);
                writer.newLine();

                String nextLine = min.reader.readLine();
                if (nextLine != null) {
                    heap.offer(new RunReader(nextLine, min.reader));
                }
            }
        }

        // Close all readers
        for (BufferedReader reader : readers) reader.close();
    }

    private record RunReader(String currentLine, BufferedReader reader) {}
}

// PostgreSQL's sort:
// - work_mem controls chunk size (default 4MB)
// - If data fits in work_mem → quicksort in memory
// - If data exceeds work_mem → external merge sort with temp files
// - EXPLAIN shows "Sort Method: external merge Disk: XXkB"
//
// Complexity:
//   Phase 1: O(N log M) where M = chunk size (in-memory sort per chunk)
//   Phase 2: O(N log K) where K = number of runs (k-way merge)
//   Total disk I/O: O(N × ceil(log_M(N))) — each pass reads/writes all data
//   For 1TB of data with 1GB memory: ceil(log_1000(1_000_000)) = 2 passes
```

**P12.47** [E] — Hash Join Implementation

```java
/**
 * Hash join: the most common join algorithm in databases.
 * Used when joining two tables without a useful index.
 *
 * Phase 1 (Build): hash the smaller table into a hash table
 * Phase 2 (Probe): scan the larger table, probe the hash table
 *
 * PostgreSQL: Hash Join
 * InnoDB: Block Nested Loop Join (no hash join until MySQL 8.0.18)
 */
public class HashJoin {

    /**
     * Join two tables on a key column.
     * Time: O(N + M) where N = build table size, M = probe table size
     * Space: O(N) for the hash table (smaller table)
     */
    public static <K, L, R> List<JoinResult<L, R>> hashJoin(
            List<L> buildTable,
            List<R> probeTable,
            java.util.function.Function<L, K> buildKey,
            java.util.function.Function<R, K> probeKey) {

        // Phase 1: Build hash table from smaller table
        Map<K, List<L>> hashTable = new HashMap<>();
        for (L row : buildTable) {
            hashTable.computeIfAbsent(buildKey.apply(row), k -> new ArrayList<>()).add(row);
        }

        // Phase 2: Probe with larger table
        List<JoinResult<L, R>> results = new ArrayList<>();
        for (R row : probeTable) {
            K key = probeKey.apply(row);
            List<L> matches = hashTable.get(key);
            if (matches != null) {
                for (L match : matches) {
                    results.add(new JoinResult<>(match, row));
                }
            }
        }

        return results;
    }

    public record JoinResult<L, R>(L left, R right) {}
}

// The optimizer chooses which table to build:
// - Always build the smaller table (fits in memory)
// - Probe the larger table (streaming, no memory needed)
//
// Grace Hash Join: if the build table does not fit in memory,
// partition both tables by hash into buckets, then join each bucket pair.
// This is external hashing — similar to external merge sort.
```

**P12.48** [M] — Implement a Simple Query Executor

```java
/**
 * Simple query executor demonstrating SCAN → FILTER → PROJECT pipeline.
 * This is the volcano/iterator model used by most databases.
 */
public class QueryExecutor {

    interface Operator extends Iterator<Map<String, Object>> {}

    /**
     * Table scan: iterate over all rows.
     * This is the "full table scan" you see in EXPLAIN.
     */
    static class TableScan implements Operator {
        private final Iterator<Map<String, Object>> rows;

        TableScan(List<Map<String, Object>> table) {
            this.rows = table.iterator();
        }

        @Override public boolean hasNext() { return rows.hasNext(); }
        @Override public Map<String, Object> next() { return rows.next(); }
    }

    /**
     * Filter: WHERE clause.
     */
    static class Filter implements Operator {
        private final Operator input;
        private final java.util.function.Predicate<Map<String, Object>> predicate;
        private Map<String, Object> nextRow;

        Filter(Operator input, java.util.function.Predicate<Map<String, Object>> predicate) {
            this.input = input;
            this.predicate = predicate;
            advance();
        }

        private void advance() {
            nextRow = null;
            while (input.hasNext()) {
                Map<String, Object> row = input.next();
                if (predicate.test(row)) {
                    nextRow = row;
                    return;
                }
            }
        }

        @Override public boolean hasNext() { return nextRow != null; }
        @Override
        public Map<String, Object> next() {
            Map<String, Object> result = nextRow;
            advance();
            return result;
        }
    }

    /**
     * Projection: SELECT specific columns.
     */
    static class Project implements Operator {
        private final Operator input;
        private final Set<String> columns;

        Project(Operator input, Set<String> columns) {
            this.input = input;
            this.columns = columns;
        }

        @Override public boolean hasNext() { return input.hasNext(); }
        @Override
        public Map<String, Object> next() {
            Map<String, Object> row = input.next();
            Map<String, Object> projected = new LinkedHashMap<>();
            for (String col : columns) {
                if (row.containsKey(col)) projected.put(col, row.get(col));
            }
            return projected;
        }
    }

    /**
     * Execute: SELECT name, age FROM users WHERE age > 25
     */
    public static List<Map<String, Object>> execute(List<Map<String, Object>> table) {
        // Build operator pipeline (bottom-up):
        Operator scan = new TableScan(table);
        Operator filter = new Filter(scan, row -> ((int) row.get("age")) > 25);
        Operator project = new Project(filter, Set.of("name", "age"));

        // Pull results through the pipeline
        List<Map<String, Object>> results = new ArrayList<>();
        while (project.hasNext()) {
            results.add(project.next());
        }
        return results;
    }
}

// This is the volcano/iterator model:
// - Each operator has next() — "pull" model
// - Data flows one row at a time from bottom to top
// - No intermediate materialization (rows are not stored between operators)
// - Pipeline breakers: sort, hash build, aggregation (must see all input first)
//
// Modern databases (Vectorized execution):
// - Process batches of 1024 rows at a time instead of one row
// - Enables SIMD vectorization (process 4-16 values per CPU instruction)
// - Used by ClickHouse, DuckDB, Velox, DataFusion
```

**P12.49** [M] — Implement a Trie-Based Index for Prefix Queries

```java
/**
 * Trie index for prefix matching queries.
 * Used by: autocomplete, IP routing tables, Lucene's FST-based term dictionary.
 *
 * SELECT * FROM products WHERE name LIKE 'java%'
 * A B+ tree can handle this if the index is on 'name' (leftmost prefix).
 * A trie is even better for pure prefix lookups: O(|prefix|) vs O(log N).
 */
public class TrieIndex {

    private static final int ALPHABET_SIZE = 128; // ASCII

    private static class TrieNode {
        TrieNode[] children = new TrieNode[ALPHABET_SIZE];
        List<Integer> docIds; // Documents containing this prefix

        void addDocId(int docId) {
            if (docIds == null) docIds = new ArrayList<>();
            docIds.add(docId);
        }
    }

    private final TrieNode root = new TrieNode();

    public void insert(String term, int docId) {
        TrieNode node = root;
        for (char c : term.toCharArray()) {
            if (node.children[c] == null) {
                node.children[c] = new TrieNode();
            }
            node = node.children[c];
        }
        node.addDocId(docId);
    }

    /**
     * Find all documents matching a prefix.
     * O(|prefix| + results) — faster than B+ tree for prefix queries.
     */
    public List<Integer> prefixSearch(String prefix) {
        TrieNode node = root;
        for (char c : prefix.toCharArray()) {
            node = node.children[c];
            if (node == null) return Collections.emptyList();
        }
        // Collect all docIds in the subtree
        List<Integer> results = new ArrayList<>();
        collectDocIds(node, results);
        return results;
    }

    private void collectDocIds(TrieNode node, List<Integer> results) {
        if (node.docIds != null) results.addAll(node.docIds);
        for (TrieNode child : node.children) {
            if (child != null) collectDocIds(child, results);
        }
    }
}

// Space: O(ALPHABET × N × avg_key_length) — can be large
// Lucene's FST (Finite State Transducer) compresses this:
// - Shares common suffixes (not just prefixes)
// - Typically 3-5x smaller than a trie
// - Used for the term dictionary in every Lucene segment
```

**P12.50** [H] — Implement a Log-Structured Hash Table (Bitcask)

```java
// See BitcaskStore implementation in P12.29.
// Additional detail: compaction

/**
 * Bitcask compaction: merge multiple data files into one,
 * keeping only the latest version of each key.
 *
 * Before compaction:
 *   file_1.log: [k1=v1_old, k2=v2, k3=v3]
 *   file_2.log: [k1=v1_new, k4=v4]
 *   file_3.log: [k2=TOMBSTONE, k5=v5]
 *
 * After compaction:
 *   file_merged.log: [k1=v1_new, k3=v3, k4=v4, k5=v5]
 *   (k2 removed because it was deleted)
 *   (k1 keeps latest value)
 */
public static void compactBitcask(BitcaskStore store, String directory)
        throws IOException {
    // Read all keys from key directory
    // For each key, read its latest value
    // Write all live key-value pairs to a new file
    // Update the key directory to point to the new file
    // Delete old files
    //
    // This is the same as LSM compaction but simpler:
    // no levels, no merge — just rewrite everything.
    // Runs periodically or when dead data exceeds a threshold.
}

// Riak Bitcask: triggers compaction when dead bytes > threshold
// or when number of data files exceeds limit.
// During compaction, reads still work (old files are not deleted
// until the new file is complete and keydir is updated).
```

**P12.51** [M] — Database Index Selection Advisor

```java
/**
 * Simulates an index advisor that recommends indexes based on query patterns.
 * 
 * Real tools: pg_stat_user_indexes, MySQL's sys schema, EverSQL, Percona's pt-index-usage.
 */
public class IndexAdvisor {

    private final Map<String, QueryStats> queryPatterns = new LinkedHashMap<>();

    public void recordQuery(String fingerprint, List<String> filterColumns,
                            List<String> orderColumns, long executionTimeMs) {
        queryPatterns.computeIfAbsent(fingerprint, k -> new QueryStats())
                     .record(filterColumns, orderColumns, executionTimeMs);
    }

    public List<IndexRecommendation> recommend() {
        Map<List<String>, Double> candidateIndexes = new HashMap<>();

        for (QueryStats stats : queryPatterns.values()) {
            // Weight = frequency × average execution time (high = worth indexing)
            double weight = stats.count * stats.avgTimeMs();

            // Recommend composite index on filter + order columns
            List<String> columns = new ArrayList<>(stats.mostCommonFilters());
            columns.addAll(stats.mostCommonOrder());
            if (!columns.isEmpty()) {
                candidateIndexes.merge(columns, weight, Double::sum);
            }
        }

        return candidateIndexes.entrySet().stream()
            .sorted(Map.Entry.<List<String>, Double>comparingByValue().reversed())
            .limit(10)
            .map(e -> new IndexRecommendation(e.getKey(), e.getValue()))
            .collect(Collectors.toList());
    }

    private static class QueryStats {
        int count;
        long totalTimeMs;
        Map<List<String>, Integer> filterPatterns = new HashMap<>();
        Map<List<String>, Integer> orderPatterns = new HashMap<>();

        void record(List<String> filters, List<String> orders, long timeMs) {
            count++;
            totalTimeMs += timeMs;
            filterPatterns.merge(filters, 1, Integer::sum);
            orderPatterns.merge(orders, 1, Integer::sum);
        }

        double avgTimeMs() { return (double) totalTimeMs / count; }

        List<String> mostCommonFilters() {
            return filterPatterns.entrySet().stream()
                .max(Map.Entry.comparingByValue())
                .map(Map.Entry::getKey)
                .orElse(Collections.emptyList());
        }

        List<String> mostCommonOrder() {
            return orderPatterns.entrySet().stream()
                .max(Map.Entry.comparingByValue())
                .map(Map.Entry::getKey)
                .orElse(Collections.emptyList());
        }
    }

    public record IndexRecommendation(List<String> columns, double priority) {}
}
```

**P12.52** [E] — Explain Write Amplification in LSM Trees

```java
// Write amplification = total bytes written to disk / bytes written by application
//
// In an LSM tree with leveled compaction:
// - Application writes 1 byte
// - Written to WAL: 1 byte (write amp = 1)
// - Flushed from memtable to L0: 1 byte (write amp = 2)
// - Compacted L0 → L1: 1 byte (write amp = 3)
// - Compacted L1 → L2: 1 byte (write amp = 4)
// - ... up to L6
// Total write amplification: ~10-30x
//
// Each level is 10x larger than the previous.
// Compacting L_i into L_{i+1} may rewrite up to 10 files in L_{i+1}
// (because one L_i file overlaps with ~10 L_{i+1} files).
// Per level: ~10x write amp. With 7 levels: ~10 × 7 = 70x worst case.
// In practice, average ~10-30x.
//
// Comparison:
//   B+ tree: write amp = 1-2x (write page once, maybe twice with WAL)
//   LSM leveled: 10-30x
//   LSM size-tiered: 2-4x (but higher space amplification)
//
// This is the fundamental trade-off of LSM trees:
// Better write THROUGHPUT (sequential I/O) at the cost of write AMPLIFICATION.
// For SSDs with limited write endurance (P/E cycles), write amplification matters.
// RocksDB mitigates this with adaptive compaction and tiered storage.
```

**P12.53** [H] — Implement a Database Transaction Log

```java
/**
 * Transaction log with REDO and UNDO records.
 * Supports the ARIES recovery algorithm (used by InnoDB, SQL Server, DB2).
 *
 * ARIES principles:
 * 1. Write-ahead logging: log before modifying data
 * 2. Repeating history during redo: replay ALL log records, even for uncommitted txns
 * 3. Logging changes during undo: log compensating records during rollback
 */
public class TransactionLog {

    private final List<LogRecord> log = new ArrayList<>();
    private final Map<Long, String> committedTxns = new HashMap<>();
    private long lastCheckpointLSN = -1;

    public long writeRedo(long txnId, String pageId, byte[] beforeImage,
                          byte[] afterImage) {
        long lsn = log.size();
        log.add(new LogRecord(lsn, txnId, LogType.REDO_UNDO, pageId,
                              beforeImage, afterImage));
        return lsn;
    }

    public void writeCommit(long txnId) {
        long lsn = log.size();
        log.add(new LogRecord(lsn, txnId, LogType.COMMIT, null, null, null));
        committedTxns.put(txnId, "COMMITTED");
    }

    public void writeAbort(long txnId) {
        long lsn = log.size();
        log.add(new LogRecord(lsn, txnId, LogType.ABORT, null, null, null));
    }

    public void checkpoint(Set<Long> activeTxns) {
        long lsn = log.size();
        log.add(new LogRecord(lsn, -1, LogType.CHECKPOINT, null, null, null));
        lastCheckpointLSN = lsn;
    }

    /**
     * ARIES Recovery: 3 phases
     *
     * 1. Analysis: scan log from last checkpoint to find:
     *    - Active transactions at crash time
     *    - Dirty pages that need redo
     *
     * 2. Redo: replay ALL log records from the earliest dirty page LSN
     *    (even for uncommitted transactions — "repeating history")
     *
     * 3. Undo: rollback all transactions that were active at crash time
     *    (they never committed — their changes must be undone)
     */
    public void recover(Map<String, byte[]> dataPages) {
        // Phase 1: Analysis
        Set<Long> activeTxns = new HashSet<>();
        for (int i = (int) Math.max(0, lastCheckpointLSN); i < log.size(); i++) {
            LogRecord record = log.get(i);
            switch (record.type) {
                case REDO_UNDO -> activeTxns.add(record.txnId);
                case COMMIT, ABORT -> activeTxns.remove(record.txnId);
                default -> {}
            }
        }

        // Phase 2: Redo (replay everything)
        for (int i = 0; i < log.size(); i++) {
            LogRecord record = log.get(i);
            if (record.type == LogType.REDO_UNDO && record.afterImage != null) {
                dataPages.put(record.pageId, record.afterImage);
            }
        }

        // Phase 3: Undo (rollback uncommitted transactions)
        for (int i = log.size() - 1; i >= 0; i--) {
            LogRecord record = log.get(i);
            if (record.type == LogType.REDO_UNDO && activeTxns.contains(record.txnId)) {
                if (record.beforeImage != null) {
                    dataPages.put(record.pageId, record.beforeImage);
                }
            }
        }
    }

    private enum LogType { REDO_UNDO, COMMIT, ABORT, CHECKPOINT, CLR }

    private record LogRecord(long lsn, long txnId, LogType type,
                              String pageId, byte[] beforeImage,
                              byte[] afterImage) {}
}
```

**P12.54** [M] — Implement Database Cursor with Pagination

```java
/**
 * Database cursor for paginated results.
 * More efficient than OFFSET/LIMIT for deep pagination.
 *
 * OFFSET/LIMIT problem:
 *   SELECT * FROM users ORDER BY id LIMIT 20 OFFSET 1000000
 *   The database must skip 1M rows → O(1M) even though you only want 20.
 *
 * Cursor-based (keyset) pagination:
 *   SELECT * FROM users WHERE id > last_seen_id ORDER BY id LIMIT 20
 *   Uses the index directly → O(log N + 20) regardless of page depth.
 */
public class CursorPaginator<T> {

    private final BPlusTree<Integer, T> index;
    private final int pageSize;

    public CursorPaginator(BPlusTree<Integer, T> index, int pageSize) {
        this.index = index;
        this.pageSize = pageSize;
    }

    /**
     * Get the next page after the given cursor (last seen key).
     * O(log N + pageSize) regardless of how deep into the result set we are.
     */
    public Page<T> getPage(Integer cursor) {
        int start = (cursor == null) ? Integer.MIN_VALUE : cursor + 1;
        int end = Integer.MAX_VALUE;

        List<T> items = index.rangeQuery(start, end);

        // Trim to page size
        List<T> page = items.subList(0, Math.min(pageSize, items.size()));

        // Next cursor is the key of the last item
        Integer nextCursor = page.isEmpty() ? null : start + page.size() - 1;
        boolean hasMore = items.size() > pageSize;

        return new Page<>(page, nextCursor, hasMore);
    }

    public record Page<T>(List<T> items, Integer nextCursor, boolean hasMore) {}
}

// Real-world: Slack, Twitter, Facebook all use cursor-based pagination
// for their APIs because OFFSET/LIMIT degrades at scale.
// The cursor is typically an opaque token (base64-encoded key).
```

**P12.55** [H] — Implement a Mini Storage Engine

```java
/**
 * Complete mini storage engine combining all concepts:
 * WAL + MemTable + SSTable + Buffer Pool + Bloom Filters
 *
 * This is a simplified but functional key-value storage engine.
 */
public class MiniStorageEngine implements Closeable {

    private final String dataDir;
    private final WriteAheadLog wal;
    private volatile MemTable activeMemTable;
    private volatile MemTable immutableMemTable;
    private final List<SSTable> sstables;
    private final BufferPool bufferPool;
    private final Map<String, BloomFilter> bloomFilters;
    private final ReadWriteLock rwLock = new ReentrantReadWriteLock();

    private static final int MEMTABLE_SIZE = 4 * 1024 * 1024; // 4MB
    private static final int BUFFER_POOL_PAGES = 1024;         // 16MB

    public MiniStorageEngine(String dataDir) throws IOException {
        this.dataDir = dataDir;
        new java.io.File(dataDir).mkdirs();

        this.wal = new WriteAheadLog(dataDir + "/wal");
        this.activeMemTable = new MemTable(MEMTABLE_SIZE);
        this.sstables = new CopyOnWriteArrayList<>();
        this.bufferPool = new BufferPool(BUFFER_POOL_PAGES);
        this.bloomFilters = new ConcurrentHashMap<>();

        // Recovery: replay WAL
        recover();
    }

    public void put(String key, byte[] value) throws IOException {
        rwLock.readLock().lock();
        try {
            // 1. Write to WAL
            long lsn = wal.append(key, value);

            // 2. Write to active memtable
            activeMemTable.put(key, value);

            // 3. Check if memtable needs flushing
            if (activeMemTable.isFull()) {
                flush();
            }
        } finally {
            rwLock.readLock().unlock();
        }
    }

    public byte[] get(String key) throws IOException {
        // 1. Check active memtable
        byte[] value = activeMemTable.get(key);
        if (value != null) return value;

        // 2. Check immutable memtable
        MemTable immutable = immutableMemTable;
        if (immutable != null) {
            value = immutable.get(key);
            if (value != null) return value;
        }

        // 3. Check SSTables (newest first)
        for (int i = sstables.size() - 1; i >= 0; i--) {
            SSTable sst = sstables.get(i);
            BloomFilter bf = bloomFilters.get(sst.filename());
            if (bf != null && !bf.mightContain(key)) continue; // Bloom filter skip
            value = sst.get(key);
            if (value != null) return value;
        }

        return null; // Not found
    }

    private void flush() throws IOException {
        rwLock.writeLock().lock();
        try {
            if (!activeMemTable.isFull()) return; // Double-check

            immutableMemTable = activeMemTable;
            activeMemTable = new MemTable(MEMTABLE_SIZE);
            wal.rotate();

            // Flush immutable memtable to SSTable
            immutableMemTable.makeImmutable();
            SSTable sst = SSTable.flush(immutableMemTable.getData(), dataDir);
            sstables.add(sst);
            bloomFilters.put(sst.filename(), sst.bloomFilter());

            immutableMemTable = null;
        } finally {
            rwLock.writeLock().unlock();
        }
    }

    private void recover() throws IOException {
        for (WriteAheadLog.WALEntry entry : wal.recover()) {
            activeMemTable.put(entry.key(), entry.value());
        }
    }

    @Override
    public void close() throws IOException {
        if (!activeMemTable.getData().isEmpty()) {
            immutableMemTable = activeMemTable;
            immutableMemTable.makeImmutable();
            SSTable sst = SSTable.flush(immutableMemTable.getData(), dataDir);
            sstables.add(sst);
        }
        wal.close();
    }
}

// This mini engine demonstrates the complete lifecycle:
//
// WRITE: client → WAL (durability) → MemTable (speed)
//        → SSTable flush (persistence) → compaction (cleanup)
//
// READ: MemTable (memory, O(log N))
//       → Bloom filter check (skip, O(1))
//       → SSTable search (disk, O(log N) per file)
//
// RECOVERY: Replay WAL entries after last checkpoint
//
// This is essentially LevelDB/RocksDB in ~100 lines.
// Production adds: concurrent compaction, compression, rate limiting,
// column families, transactions, snapshots, iterators, and much more.
//
// JVM considerations:
// - MemTable (ConcurrentSkipListMap): ~80 bytes per entry on heap
// - SSTable bloom filters: off-heap or mmap'd for minimal GC impact
// - Buffer pool: could use off-heap DirectByteBuffers to avoid GC
// - WAL writes: use DirectByteBuffer for zero-copy I/O
// - For a production Java storage engine, see Apache Cassandra's
//   storage engine or Apache HBase's HFile implementation.
```

---

## Key Takeaways

1. **B+ trees minimize disk I/O by maximizing fan-out.** With fan-out 500-1000 and 16KB pages, a B+ tree holds billions of rows in 3-4 levels. Each level is one disk seek. The leaf linked list converts range queries from random I/O to sequential I/O — this single design decision is why SQL databases handle range queries efficiently.

2. **LSM trees trade read performance for write throughput.** By buffering writes in memory and flushing sorted runs sequentially, LSM trees achieve 5-10x the write throughput of B+ trees. The cost is read amplification (checking multiple levels) and write amplification (compaction rewrites data 10-30x). Bloom filters mitigate read amplification by skipping SSTables that definitely do not contain the key.

3. **The WAL is the foundation of database durability.** Append-only sequential writes are fast. Group commit batches multiple transactions into a single fsync(), multiplying throughput 10-100x. The recovery protocol (ARIES: Analysis → Redo → Undo) guarantees that committed transactions survive any crash and uncommitted transactions are rolled back.

4. **Buffer pools are the database's memory manager.** InnoDB's midpoint-insertion LRU prevents full table scans from evicting hot index pages. PostgreSQL's clock-sweep is simpler (no linked list maintenance) and approximates LRU well enough. Pin counts prevent eviction of in-use pages — leaked connections that hold pins can exhaust the pool.

5. **Inverted indexes power full-text search by mapping terms to document lists.** The core operations — posting list intersection for AND, union for OR — use the same two-pointer merge technique as merge sort. Lucene adds FST-based term dictionaries, skip pointers for fast intersection, and BM25 scoring that improves on TF-IDF with term frequency saturation and document length normalization.

6. **Bitmap indexes dominate for low-cardinality analytics.** One CPU instruction (AND on 64-bit words) processes 64 rows simultaneously. For 100M rows with boolean filters, bitmap AND operations complete in milliseconds. Roaring Bitmaps adaptively choose between array, bitmap, and run-length containers based on density — compressing sparse bitmaps by 10-100x.

7. **Time-series storage exploits temporal ordering.** Ring buffers give O(1) append with fixed memory. Delta-of-delta encoding compresses timestamps to ~1.4 bits each (Gorilla compression). Downsampling reduces storage for historical data by orders of magnitude while preserving aggregate accuracy.

8. **Every database data structure has a JVM cost.** B+ tree nodes as Java objects create GC-visible pointer chains. Production storage engines (Cassandra, HBase) serialize nodes into `byte[]` pages or off-heap memory to minimize GC impact. Bloom filters use `BitSet` backed by `long[]` — GC-friendly primitive arrays. MemTables use `ConcurrentSkipListMap` for lock-free concurrent access, but each entry costs ~80 bytes of heap.

9. **Compaction is the merge sort of storage engines.** K-way merge using a `PriorityQueue` combines K sorted SSTables in O(N log K) time. The choice between leveled compaction (low read/space amplification, high write amplification) and size-tiered compaction (low write amplification, high space amplification) depends on whether your workload is read-heavy or write-heavy.

10. **The right storage engine depends on the access pattern.** B+ trees for read-heavy OLTP with range queries. LSM trees for write-heavy workloads with point queries. Column stores for analytical aggregations. Inverted indexes for full-text search. Bitmap indexes for low-cardinality filtering. Hash tables for exact key-value lookups. Know the trade-offs — read amplification, write amplification, space amplification — and choose accordingly.

---

[Previous: Chapter 11 — Use Cases: Caching & Networking](11-use-cases-caching-networking.md) | [Next: Chapter 13 — Use Cases: OS & Distributed Systems](13-use-cases-os-distributed-systems.md)
