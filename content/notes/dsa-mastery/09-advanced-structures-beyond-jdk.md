# Chapter 9: Advanced Structures Beyond JDK

## The Structures Nobody Ships, But Everybody Needs

The JDK gives you `HashMap`, `TreeMap`, `PriorityQueue`, `ArrayList`. These are workhorses. But walk into any senior systems interview, or open the source of any serious distributed system, and you will encounter structures that the JDK simply does not provide. Tries powering autocomplete at Google. Bloom filters guarding Cassandra SSTables from pointless disk reads. Union-Find binding Kruskal's MST together. Segment trees answering range queries in competitive programming and database internals alike. Skip lists underpinning Redis sorted sets. Consistent hashing distributing keys across DynamoDB nodes.

These are not academic curiosities. They are the load-bearing walls of modern infrastructure. And the JDK ships none of them.

This chapter is different from the previous eight. We are not dissecting JDK internals — we are *building* internals from scratch. Every structure in this chapter gets a full Java implementation: not pseudocode, not hand-waving, but production-grade code you can compile, test, and reason about at the JVM level. For each structure I will explain the theory, walk through the implementation line by line, analyze the memory layout and cache behavior, and show you exactly where this structure lives in real systems.

By the end of this chapter, you will have implemented nine data structures that the JDK does not provide, and you will have solved sixty problems that test your mastery of each one.

---

## 9.1 Trie (Prefix Tree)

### Concept and Theory

A trie is a tree where each node represents a single character of a string, and paths from root to marked nodes spell out words. Unlike a `TreeMap<String, V>` which compares entire strings at each node (O(L log N) lookup for L-length string among N entries), a trie touches exactly L nodes for any operation — completely independent of how many strings are stored.

```
              root
           /   |   \
          a    b    c
         / \   |
        p   n  a    ...
       / \  |  |
      p   e d  t
      |      |
      l      (end)
      |
      e
      |
     (end)
```

Inserting "apple", "ape", "and", "bat" into a trie. The path root->a->p->p->l->e spells "apple". The path root->a->p->e spells "ape". They share the prefix "ap".

The fundamental insight: tries trade space for time. A `HashSet<String>` gives O(L) average lookup but cannot answer prefix queries. A `TreeSet<String>` gives O(L log N) lookup and can do prefix queries via `subSet()`, but slowly. A trie gives O(L) for insert, search, prefix query, and delete — all of them.

### Array-Based Trie Implementation

The simplest trie for lowercase English letters uses a fixed array of 26 children per node.

```java
/**
 * Array-based Trie for lowercase English letters.
 *
 * Memory per node: 12 (header) + 4 (isEnd boolean, padded) + 16 (array header)
 *                  + 26 * 4 (references) = 136 bytes minimum per node.
 * Most of those 26 slots will be null — this is the space cost of O(1) child lookup.
 */
public class ArrayTrie {

    private static class TrieNode {
        TrieNode[] children = new TrieNode[26];
        boolean isEndOfWord;
    }

    private final TrieNode root;
    private int wordCount;

    public ArrayTrie() {
        root = new TrieNode();
        wordCount = 0;
    }

    /**
     * Insert a word into the trie.
     * Time:  O(L) where L = word.length()
     * Space: O(L) new nodes in the worst case (no shared prefix)
     */
    public void insert(String word) {
        TrieNode current = root;
        for (int i = 0; i < word.length(); i++) {
            int index = word.charAt(i) - 'a';
            if (current.children[index] == null) {
                current.children[index] = new TrieNode();
            }
            current = current.children[index];
        }
        if (!current.isEndOfWord) {
            current.isEndOfWord = true;
            wordCount++;
        }
    }

    /**
     * Search for an exact word.
     * Time: O(L)
     */
    public boolean search(String word) {
        TrieNode node = findNode(word);
        return node != null && node.isEndOfWord;
    }

    /**
     * Check if any word in the trie starts with the given prefix.
     * Time: O(L) where L = prefix.length()
     */
    public boolean startsWith(String prefix) {
        return findNode(prefix) != null;
    }

    /**
     * Delete a word from the trie. Returns true if the word was found and deleted.
     * This is the trickiest operation — we must remove nodes that are no longer
     * part of any word, but preserve nodes shared with other words.
     * Time: O(L)
     */
    public boolean delete(String word) {
        return delete(root, word, 0);
    }

    private boolean delete(TrieNode current, String word, int depth) {
        if (current == null) {
            return false;  // word not found
        }

        if (depth == word.length()) {
            // Reached the end of the word
            if (!current.isEndOfWord) {
                return false;  // word not in trie
            }
            current.isEndOfWord = false;
            wordCount--;
            // Return true if this node has no children (can be deleted by parent)
            return !hasChildren(current);
        }

        int index = word.charAt(depth) - 'a';
        boolean shouldDeleteChild = delete(current.children[index], word, depth + 1);

        if (shouldDeleteChild) {
            current.children[index] = null;  // Remove the child reference
            // This node can also be deleted if it is not end of another word
            // and has no other children
            return !current.isEndOfWord && !hasChildren(current);
        }

        return false;
    }

    /**
     * Collect all words with the given prefix — the core of autocomplete.
     * Time: O(P + K) where P = prefix length, K = total characters in matching words
     */
    public List<String> autocomplete(String prefix) {
        List<String> results = new ArrayList<>();
        TrieNode node = findNode(prefix);
        if (node != null) {
            collectWords(node, new StringBuilder(prefix), results);
        }
        return results;
    }

    // --- Private helpers ---

    private TrieNode findNode(String prefix) {
        TrieNode current = root;
        for (int i = 0; i < prefix.length(); i++) {
            int index = prefix.charAt(i) - 'a';
            if (current.children[index] == null) {
                return null;
            }
            current = current.children[index];
        }
        return current;
    }

    private boolean hasChildren(TrieNode node) {
        for (TrieNode child : node.children) {
            if (child != null) return true;
        }
        return false;
    }

    private void collectWords(TrieNode node, StringBuilder path, List<String> results) {
        if (node.isEndOfWord) {
            results.add(path.toString());
        }
        for (int i = 0; i < 26; i++) {
            if (node.children[i] != null) {
                path.append((char) ('a' + i));
                collectWords(node.children[i], path, results);
                path.deleteCharAt(path.length() - 1);
            }
        }
    }

    public int size() {
        return wordCount;
    }
}
```

### HashMap-Based Trie Implementation

When the character set is large (Unicode, mixed case, digits, etc.), a 26-slot array wastes enormous space. A `HashMap<Character, TrieNode>` uses only as much space as there are actual children.

```java
/**
 * HashMap-based Trie — supports any character set.
 *
 * Memory per node: 12 (header) + 4 (isEnd) + ~48 (empty HashMap) = ~64 bytes.
 * With children: HashMap entry is ~32 bytes each + key Character (16 bytes boxed).
 * So each child link costs ~48 bytes. Expensive per link, but no wasted null slots.
 *
 * Use this when: character set is large or unpredictable (Unicode, mixed case + digits).
 * Use array-based when: character set is small and fixed (26 lowercase letters).
 */
public class HashMapTrie {

    private static class TrieNode {
        Map<Character, TrieNode> children = new HashMap<>();
        boolean isEndOfWord;
    }

    private final TrieNode root;

    public HashMapTrie() {
        root = new TrieNode();
    }

    public void insert(String word) {
        TrieNode current = root;
        for (int i = 0; i < word.length(); i++) {
            char ch = word.charAt(i);
            current.children.putIfAbsent(ch, new TrieNode());
            current = current.children.get(ch);
        }
        current.isEndOfWord = true;
    }

    public boolean search(String word) {
        TrieNode node = findNode(word);
        return node != null && node.isEndOfWord;
    }

    public boolean startsWith(String prefix) {
        return findNode(prefix) != null;
    }

    public boolean delete(String word) {
        return delete(root, word, 0);
    }

    private boolean delete(TrieNode current, String word, int depth) {
        if (current == null) return false;

        if (depth == word.length()) {
            if (!current.isEndOfWord) return false;
            current.isEndOfWord = false;
            return current.children.isEmpty();
        }

        char ch = word.charAt(depth);
        TrieNode child = current.children.get(ch);
        boolean shouldDeleteChild = delete(child, word, depth + 1);

        if (shouldDeleteChild) {
            current.children.remove(ch);
            return !current.isEndOfWord && current.children.isEmpty();
        }

        return false;
    }

    private TrieNode findNode(String prefix) {
        TrieNode current = root;
        for (int i = 0; i < prefix.length(); i++) {
            char ch = prefix.charAt(i);
            current = current.children.get(ch);
            if (current == null) return null;
        }
        return current;
    }
}
```

### Compressed Trie (Radix Tree / Patricia Tree)

A standard trie for the words "romane", "romanus", "romulus", "rubens" has many chain nodes where a node has exactly one child. A compressed trie merges these chains: instead of r->o->m, we store a single edge labeled "rom". This dramatically reduces node count and memory usage.

```
Standard Trie:                   Compressed Trie (Radix Tree):
     root                              root
      |                               /    \
      r                            "rom"   "rub"
      |                           /    \       \
      o                        "an"   "ulus"   "ens"
      |                        /   \
      m                      "e"   "us"
     / \
    a    u
    |    |
    n    l
    |    |
    ...  ...
```

```java
/**
 * Compressed Trie (Radix Tree).
 *
 * Edges store strings, not single characters. Chains of single-child nodes
 * are collapsed into a single edge. This reduces node count from O(total chars)
 * to O(number of words) in the best case.
 *
 * Node count: at most 2W - 1 where W = number of words (each word creates
 * at most one branch point and one leaf).
 */
public class RadixTree {

    private static class RadixNode {
        Map<Character, Edge> edges = new HashMap<>();
        boolean isEndOfWord;
    }

    private static class Edge {
        String label;       // The compressed edge label (multiple characters)
        RadixNode target;   // The node this edge leads to

        Edge(String label, RadixNode target) {
            this.label = label;
            this.target = target;
        }
    }

    private final RadixNode root;

    public RadixTree() {
        root = new RadixNode();
    }

    /**
     * Insert a word. If an edge partially matches, split it.
     * Time: O(L) where L = word length
     */
    public void insert(String word) {
        insertHelper(root, word);
    }

    private void insertHelper(RadixNode node, String remaining) {
        if (remaining.isEmpty()) {
            node.isEndOfWord = true;
            return;
        }

        char firstChar = remaining.charAt(0);
        Edge edge = node.edges.get(firstChar);

        if (edge == null) {
            // No matching edge — create a new one
            RadixNode newNode = new RadixNode();
            newNode.isEndOfWord = true;
            node.edges.put(firstChar, new Edge(remaining, newNode));
            return;
        }

        // Find common prefix between remaining word and edge label
        String label = edge.label;
        int commonLen = 0;
        while (commonLen < label.length() && commonLen < remaining.length()
               && label.charAt(commonLen) == remaining.charAt(commonLen)) {
            commonLen++;
        }

        if (commonLen == label.length()) {
            // Edge label is fully consumed — continue down the tree
            insertHelper(edge.target, remaining.substring(commonLen));
        } else {
            // Partial match — split the edge
            // Original edge: node --"label"--> edge.target
            // After split:   node --"label[:commonLen]"--> splitNode --"label[commonLen:]"--> edge.target
            //                                                         \--"remaining[commonLen:]"--> newNode

            RadixNode splitNode = new RadixNode();

            // Move the rest of the old edge under the split node
            String oldSuffix = label.substring(commonLen);
            splitNode.edges.put(oldSuffix.charAt(0), new Edge(oldSuffix, edge.target));

            // Update the current edge to point to the split node
            edge.label = label.substring(0, commonLen);
            edge.target = splitNode;

            // Insert the rest of the new word
            String newSuffix = remaining.substring(commonLen);
            if (newSuffix.isEmpty()) {
                splitNode.isEndOfWord = true;
            } else {
                RadixNode newNode = new RadixNode();
                newNode.isEndOfWord = true;
                splitNode.edges.put(newSuffix.charAt(0), new Edge(newSuffix, newNode));
            }
        }
    }

    /**
     * Search for an exact word.
     * Time: O(L)
     */
    public boolean search(String word) {
        return searchHelper(root, word);
    }

    private boolean searchHelper(RadixNode node, String remaining) {
        if (remaining.isEmpty()) {
            return node.isEndOfWord;
        }

        char firstChar = remaining.charAt(0);
        Edge edge = node.edges.get(firstChar);
        if (edge == null) return false;

        String label = edge.label;
        if (!remaining.startsWith(label)) return false;

        return searchHelper(edge.target, remaining.substring(label.length()));
    }

    /**
     * Check if any word starts with the given prefix.
     * Time: O(P) where P = prefix length
     */
    public boolean startsWith(String prefix) {
        return startsWithHelper(root, prefix);
    }

    private boolean startsWithHelper(RadixNode node, String remaining) {
        if (remaining.isEmpty()) return true;

        char firstChar = remaining.charAt(0);
        Edge edge = node.edges.get(firstChar);
        if (edge == null) return false;

        String label = edge.label;
        if (remaining.length() <= label.length()) {
            // The prefix might be shorter than the edge label
            return label.startsWith(remaining);
        }
        if (!remaining.startsWith(label)) return false;
        return startsWithHelper(edge.target, remaining.substring(label.length()));
    }
}
```

### Memory Analysis: Array vs HashMap vs Radix

```
Structure          Per-Node Memory       1000 words, avg length 8
──────────────────────────────────────────────────────────────────
Array Trie         ~136 bytes            ~8000 nodes × 136 = ~1.06 MB
HashMap Trie       ~64 + 48/child        ~8000 nodes, varies, ~500-700 KB
Radix Tree         ~64 + label overhead  ~2000 nodes × ~80 = ~160 KB
```

The radix tree wins dramatically on memory. But it loses on implementation complexity and the cost of string splitting operations. For interview problems, the array-based trie is almost always what you want — simple, predictable, and fast.

### Real-World Usage

- **Google Search Autocomplete**: As you type, a trie (likely compressed, distributed) returns prefix matches ranked by frequency. The trie is partitioned by first few characters across servers.
- **Spell Checkers**: Tries store dictionaries. Checking if a word exists is O(L). Suggesting corrections: enumerate words within edit distance K from a trie node (harder, but the trie structure enables pruning).
- **IP Routing Tables (Longest Prefix Match)**: Routers store CIDR blocks in a binary trie. Given a destination IP, walk the trie bit by bit — the deepest matching prefix is the route. This is the backbone of internet routing.
- **T9 Predictive Text**: Map number sequences (2="abc", 3="def", ...) to trie paths. Pressing "2-6-3" explores all paths through {a,b,c}->{m,n,o}->{d,e,f} and returns matching words.

---

## 9.2 Segment Tree

### Concept and Theory

Consider this problem: you have an array of N integers, and you need to repeatedly (1) update a single element, and (2) query the sum/min/max over a range [l, r]. A plain array gives O(1) update but O(N) query. A prefix sum array gives O(1) query but O(N) update. A segment tree gives O(log N) for both.

```
Array: [2, 1, 5, 3, 4, 7, 2, 6]

Segment Tree (sum):
                    [30]                    <- sum of [0..7]
                /          \
            [11]            [19]            <- sum of [0..3], [4..7]
           /    \          /    \
         [3]    [8]     [11]    [8]         <- sum of [0..1],[2..3],[4..5],[6..7]
        / \    / \     / \    / \
      [2] [1][5] [3] [4] [7][2] [6]        <- individual elements
```

The tree is a full binary tree with N leaves (the original array elements) and N-1 internal nodes. Total nodes: 2N-1 (but we allocate 4N for safe indexing with 1-based array representation).

### Array Representation

We store the segment tree in a flat array, 1-indexed:
- `tree[1]` = root (range [0, n-1])
- `tree[2*i]` = left child of `tree[i]`
- `tree[2*i + 1]` = right child of `tree[i]`
- Parent of `tree[i]` = `tree[i/2]`

This is identical to how a binary heap is stored — no pointers, no `Node` objects, pure array arithmetic. Cache-friendly, GC-friendly, fast.

### Full Implementation: Segment Tree with Lazy Propagation

```java
/**
 * Segment Tree with Lazy Propagation.
 *
 * Supports:
 * - Point update: set arr[i] = val                    — O(log n)
 * - Range update: add delta to all arr[l..r]          — O(log n) with lazy
 * - Range query: sum/min/max of arr[l..r]             — O(log n)
 *
 * Memory: int[4*n] for tree + int[4*n] for lazy = 8*n ints = 32*n bytes.
 * Compare with a balanced BST approach: each node would be an object (~32 bytes)
 * with left/right pointers. The array approach is 3-4x more memory efficient
 * and infinitely more cache-friendly.
 */
public class SegmentTree {

    private final int[] tree;    // tree[1] is root, tree[2i] left child, tree[2i+1] right child
    private final int[] lazy;    // lazy propagation buffer
    private final int n;         // size of the original array

    /**
     * Build a segment tree from the given array.
     * Time: O(n) — each node is visited exactly once.
     * Space: O(n) — 4*n array slots (safe upper bound for any n).
     */
    public SegmentTree(int[] arr) {
        this.n = arr.length;
        this.tree = new int[4 * n];  // 4n is safe for all n
        this.lazy = new int[4 * n];
        build(arr, 1, 0, n - 1);
    }

    /**
     * Build subtree rooted at node 'node' covering range [start, end].
     * Post-order: build children first, then compute parent from children.
     */
    private void build(int[] arr, int node, int start, int end) {
        if (start == end) {
            tree[node] = arr[start];  // leaf node
            return;
        }
        int mid = start + (end - start) / 2;  // avoid overflow vs (start+end)/2
        build(arr, 2 * node, start, mid);           // left child
        build(arr, 2 * node + 1, mid + 1, end);     // right child
        tree[node] = tree[2 * node] + tree[2 * node + 1];  // merge
    }

    /**
     * Point update: set arr[idx] = val.
     * Time: O(log n) — update leaf, propagate sums up to root.
     */
    public void pointUpdate(int idx, int val) {
        pointUpdate(1, 0, n - 1, idx, val);
    }

    private void pointUpdate(int node, int start, int end, int idx, int val) {
        if (start == end) {
            tree[node] = val;
            return;
        }
        int mid = start + (end - start) / 2;
        if (idx <= mid) {
            pointUpdate(2 * node, start, mid, idx, val);
        } else {
            pointUpdate(2 * node + 1, mid + 1, end, idx, val);
        }
        tree[node] = tree[2 * node] + tree[2 * node + 1];  // recompute from children
    }

    /**
     * Range update: add delta to all elements in arr[l..r].
     * Time: O(log n) with lazy propagation.
     *
     * Without lazy propagation, this would be O(n) in the worst case
     * (updating every leaf individually). Lazy propagation defers the update:
     * mark the node "you owe delta to all your descendants" and only push
     * that debt down when a query or update needs the children.
     */
    public void rangeUpdate(int l, int r, int delta) {
        rangeUpdate(1, 0, n - 1, l, r, delta);
    }

    private void rangeUpdate(int node, int start, int end, int l, int r, int delta) {
        // Push any pending lazy updates to children before modifying this subtree
        pushDown(node, start, end);

        if (r < start || end < l) {
            return;  // completely outside the update range
        }

        if (l <= start && end <= r) {
            // Completely inside the update range — apply lazy update
            tree[node] += delta * (end - start + 1);  // total sum increases by delta * count
            if (start != end) {
                // Defer to children
                lazy[2 * node] += delta;
                lazy[2 * node + 1] += delta;
            }
            return;
        }

        // Partial overlap — recurse into both children
        int mid = start + (end - start) / 2;
        rangeUpdate(2 * node, start, mid, l, r, delta);
        rangeUpdate(2 * node + 1, mid + 1, end, l, r, delta);
        tree[node] = tree[2 * node] + tree[2 * node + 1];
    }

    /**
     * Range query: sum of arr[l..r].
     * Time: O(log n) — at most O(log n) nodes are "partially overlapping"
     * and need recursion; the rest are either completely inside or completely outside.
     */
    public int rangeQuery(int l, int r) {
        return rangeQuery(1, 0, n - 1, l, r);
    }

    private int rangeQuery(int node, int start, int end, int l, int r) {
        // Push pending lazy updates before querying
        pushDown(node, start, end);

        if (r < start || end < l) {
            return 0;  // completely outside query range — identity for sum
        }

        if (l <= start && end <= r) {
            return tree[node];  // completely inside query range
        }

        // Partial overlap
        int mid = start + (end - start) / 2;
        int leftSum = rangeQuery(2 * node, start, mid, l, r);
        int rightSum = rangeQuery(2 * node + 1, mid + 1, end, l, r);
        return leftSum + rightSum;
    }

    /**
     * Push lazy updates from parent to children.
     * This is the heart of lazy propagation: the "debt" accumulated at a node
     * is paid forward to its children only when needed.
     */
    private void pushDown(int node, int start, int end) {
        if (lazy[node] != 0) {
            tree[node] += lazy[node] * (end - start + 1);
            if (start != end) {
                lazy[2 * node] += lazy[node];
                lazy[2 * node + 1] += lazy[node];
            }
            lazy[node] = 0;
        }
    }
}
```

### Segment Tree for Range Minimum Query (RMQ)

The same structure works for min/max — just change the merge operation:

```java
/**
 * Segment Tree for Range Minimum Query.
 * Identical structure, different merge: min instead of sum.
 */
public class MinSegmentTree {

    private final int[] tree;
    private final int n;

    public MinSegmentTree(int[] arr) {
        this.n = arr.length;
        this.tree = new int[4 * n];
        Arrays.fill(tree, Integer.MAX_VALUE);
        build(arr, 1, 0, n - 1);
    }

    private void build(int[] arr, int node, int start, int end) {
        if (start == end) {
            tree[node] = arr[start];
            return;
        }
        int mid = start + (end - start) / 2;
        build(arr, 2 * node, start, mid);
        build(arr, 2 * node + 1, mid + 1, end);
        tree[node] = Math.min(tree[2 * node], tree[2 * node + 1]);
    }

    public void update(int idx, int val) {
        update(1, 0, n - 1, idx, val);
    }

    private void update(int node, int start, int end, int idx, int val) {
        if (start == end) {
            tree[node] = val;
            return;
        }
        int mid = start + (end - start) / 2;
        if (idx <= mid) update(2 * node, start, mid, idx, val);
        else update(2 * node + 1, mid + 1, end, idx, val);
        tree[node] = Math.min(tree[2 * node], tree[2 * node + 1]);
    }

    public int rangeMin(int l, int r) {
        return rangeMin(1, 0, n - 1, l, r);
    }

    private int rangeMin(int node, int start, int end, int l, int r) {
        if (r < start || end < l) return Integer.MAX_VALUE;
        if (l <= start && end <= r) return tree[node];
        int mid = start + (end - start) / 2;
        return Math.min(
            rangeMin(2 * node, start, mid, l, r),
            rangeMin(2 * node + 1, mid + 1, end, l, r)
        );
    }
}
```

### Complexity Analysis

```
Operation          Without Lazy    With Lazy Propagation
─────────────────────────────────────────────────────────
Build              O(n)            O(n)
Point Update       O(log n)        O(log n)
Range Update       O(n)            O(log n)
Range Query        O(log n)        O(log n)
Space              O(n)            O(n)
```

Why O(log n) for range query? At each level of the tree, at most 2 nodes are "partially overlapping" with the query range and require recursion. All other nodes are either completely inside (return immediately) or completely outside (return identity). Since the tree has O(log n) levels, we visit at most O(log n) nodes.

### Real-World Usage

- **Database Range Queries**: When a database needs to answer "what is the minimum value in column X for rows 1000-5000?" with updates happening concurrently, a segment tree (or B-tree with augmented nodes) provides the backbone.
- **Computational Geometry**: Range trees for 2D orthogonal range queries are built from segment trees.
- **Stock Price Min/Max Over Windows**: Given a stream of stock prices, "what was the minimum price in the last K ticks?" is a sliding window minimum — efficiently solved with a segment tree on a circular buffer.
- **Competitive Programming**: Segment trees are the single most important data structure in competitive programming. If you can only learn one advanced structure for contests, learn this one.

---

## 9.3 Fenwick Tree (Binary Indexed Tree)

### Concept and Theory

A Fenwick tree solves the same problem as a segment tree — prefix sums with point updates — but with dramatically simpler code and lower constant factors. The entire data structure is a single `int[]` array with a bit trick.

The core insight: every positive integer can be decomposed based on its lowest set bit. `lowbit(x) = x & (-x)` isolates the lowest set bit. For example:
- `lowbit(12) = lowbit(1100₂) = 0100₂ = 4`
- `lowbit(6) = lowbit(110₂) = 10₂ = 2`
- `lowbit(1) = lowbit(1₂) = 1₂ = 1`

In a Fenwick tree, `tree[i]` stores the sum of a specific range of elements whose length equals `lowbit(i)`. Specifically, `tree[i]` stores the sum of elements from index `(i - lowbit(i) + 1)` to `i`.

```
Index i:   1    2    3    4    5    6    7    8
lowbit:    1    2    1    4    1    2    1    8
Range:   [1,1][1,2][3,3][1,4][5,5][5,6][7,7][1,8]

For example:
  tree[4] stores sum of arr[1..4]  (lowbit(4)=4, range length 4)
  tree[6] stores sum of arr[5..6]  (lowbit(6)=2, range length 2)
  tree[7] stores sum of arr[7..7]  (lowbit(7)=1, range length 1)
```

### Full Implementation

```java
/**
 * Fenwick Tree (Binary Indexed Tree).
 *
 * Supports:
 * - Point update: arr[i] += delta                     — O(log n)
 * - Prefix sum query: sum of arr[1..i]                — O(log n)
 * - Range sum query: sum of arr[l..r]                 — O(log n) via two prefix sums
 *
 * Memory: just int[n+1]. Compare with segment tree's int[4*n].
 * The Fenwick tree uses 4x less memory and has smaller constants.
 *
 * Limitation: less flexible than segment tree. Cannot easily support
 * range updates (without modification), range min/max, or lazy propagation.
 * But for prefix sums with point updates, it is strictly superior.
 *
 * Note: 1-indexed. tree[0] is unused. This simplifies the bit arithmetic.
 */
public class FenwickTree {

    private final int[] tree;
    private final int n;

    /**
     * Initialize from an array.
     * Time: O(n) using the linear-time build trick.
     * Naive approach (n point updates) would be O(n log n).
     */
    public FenwickTree(int[] arr) {
        this.n = arr.length;
        this.tree = new int[n + 1];

        // Copy values into tree (1-indexed)
        for (int i = 0; i < n; i++) {
            tree[i + 1] = arr[i];
        }

        // O(n) build: each node adds its value to its parent
        for (int i = 1; i <= n; i++) {
            int parent = i + (i & (-i));  // i + lowbit(i)
            if (parent <= n) {
                tree[parent] += tree[i];
            }
        }
    }

    /**
     * Point update: add delta to arr[i] (1-indexed).
     *
     * Walk UP the tree: starting from index i, add delta to tree[i],
     * then move to i + lowbit(i). This updates all nodes whose range
     * includes index i.
     *
     * Time: O(log n) — at most log₂(n) iterations.
     *
     * Trace for update(3, +5) with n=8:
     *   i=3: tree[3] += 5, next = 3 + lowbit(3) = 3 + 1 = 4
     *   i=4: tree[4] += 5, next = 4 + lowbit(4) = 4 + 4 = 8
     *   i=8: tree[8] += 5, next = 8 + lowbit(8) = 8 + 8 = 16 > n, stop
     */
    public void update(int i, int delta) {
        while (i <= n) {
            tree[i] += delta;
            i += i & (-i);  // move to parent: i += lowbit(i)
        }
    }

    /**
     * Prefix sum: sum of arr[1..i] (1-indexed).
     *
     * Walk DOWN the tree: starting from index i, add tree[i] to sum,
     * then move to i - lowbit(i). This collects partial sums that
     * together cover the range [1, i].
     *
     * Time: O(log n) — at most log₂(n) iterations.
     *
     * Trace for prefixSum(7) with n=8:
     *   i=7: sum += tree[7] (covers [7,7]),   next = 7 - lowbit(7) = 7 - 1 = 6
     *   i=6: sum += tree[6] (covers [5,6]),   next = 6 - lowbit(6) = 6 - 2 = 4
     *   i=4: sum += tree[4] (covers [1,4]),   next = 4 - lowbit(4) = 4 - 4 = 0, stop
     *   Result = tree[7] + tree[6] + tree[4] = arr[7] + (arr[5]+arr[6]) + (arr[1]+...+arr[4])
     */
    public int prefixSum(int i) {
        int sum = 0;
        while (i > 0) {
            sum += tree[i];
            i -= i & (-i);  // strip lowest set bit: i -= lowbit(i)
        }
        return sum;
    }

    /**
     * Range sum: sum of arr[l..r] (1-indexed).
     * Simple: prefixSum(r) - prefixSum(l - 1).
     */
    public int rangeSum(int l, int r) {
        return prefixSum(r) - prefixSum(l - 1);
    }
}
```

### Fenwick Tree vs Segment Tree

```
Feature             Fenwick Tree         Segment Tree
───────────────────────────────────────────────────────
Space               int[n+1]             int[4*n]
Code complexity     ~20 lines            ~60-100 lines
Constant factor     Smaller (simpler)    Larger (more branching)
Range query (sum)   O(log n)             O(log n)
Point update        O(log n)             O(log n)
Range update        Hard (needs 2 BITs)  Easy (lazy propagation)
Range min/max       Not possible         Supported
Flexibility         Limited              Very flexible
```

Rule of thumb: if you only need prefix sums with point updates, use a Fenwick tree. For anything more complex (range updates, min/max queries, lazy propagation), use a segment tree.

### Real-World Usage

- **Counting Inversions**: Process elements right to left, inserting each into a Fenwick tree indexed by value. The number of elements already inserted that are smaller than the current element is `prefixSum(val - 1)`.
- **Cumulative Frequency Tables**: Given a stream of events with categories 1..K, maintain a BIT to answer "how many events in categories [a, b]?" with O(log K) updates and queries.
- **2D Range Sum Queries**: A 2D Fenwick tree (BIT on both dimensions) handles point updates and rectangle sum queries on a matrix in O(log n * log m).

---

## 9.4 Union-Find (Disjoint Set Union)

### Concept and Theory

Union-Find manages a collection of disjoint sets. It supports two operations:
- `find(x)`: which set does element x belong to? (Returns the representative/root of the set)
- `union(x, y)`: merge the sets containing x and y

The naive implementation (each set is a linked list) gives O(N) for union. A tree-based implementation with two optimizations — path compression and union by rank — achieves amortized O(alpha(N)) per operation, where alpha is the inverse Ackermann function. For all practical purposes, alpha(N) <= 4 for any N that fits in the observable universe. It is effectively O(1).

```
Without path compression:        With path compression:
     find(5) traces up:           find(5) flattens to:
        1                            1
       / \                        / / \ \
      2   3                      2 3  4  5
      |
      4
      |
      5
    (O(N) worst case)            (O(1) subsequent finds)
```

### Full Implementation

```java
/**
 * Union-Find (Disjoint Set Union) with Path Compression and Union by Rank.
 *
 * Time per operation: O(alpha(n)) amortized ≈ O(1) for all practical purposes.
 * Space: O(n) — two int arrays of size n.
 *
 * The inverse Ackermann function alpha(n) grows INCREDIBLY slowly:
 *   alpha(1) = 0
 *   alpha(2) = 1
 *   alpha(2^2^2^2^2) = alpha(2^65536) = 4
 *   No physical input will ever make alpha(n) >= 5.
 *
 * So for any conceivable input, Union-Find operations are effectively constant time.
 */
public class UnionFind {

    private final int[] parent;   // parent[i] = parent of element i
    private final int[] rank;     // rank[i] = upper bound on height of tree rooted at i
    private int componentCount;   // number of disjoint sets

    /**
     * Initialize n elements, each in its own set.
     * parent[i] = i means i is its own root.
     * rank[i] = 0 means it is a single-node tree.
     */
    public UnionFind(int n) {
        parent = new int[n];
        rank = new int[n];
        componentCount = n;
        for (int i = 0; i < n; i++) {
            parent[i] = i;
        }
    }

    /**
     * Find the root representative of the set containing x.
     *
     * PATH COMPRESSION: during the find, set every node's parent directly
     * to the root. This flattens the tree so future finds on the same path
     * are O(1). This is the key to the amortized O(alpha(n)) guarantee.
     *
     * Iterative version (avoids stack overflow on deep trees):
     */
    public int find(int x) {
        // Phase 1: find the root
        int root = x;
        while (root != parent[root]) {
            root = parent[root];
        }
        // Phase 2: path compression — point every node on the path directly to root
        while (x != root) {
            int next = parent[x];
            parent[x] = root;
            x = next;
        }
        return root;
    }

    /**
     * Recursive find with path compression (elegant but risks stack overflow):
     *
     * public int find(int x) {
     *     if (parent[x] != x) {
     *         parent[x] = find(parent[x]);  // path compression in one line
     *     }
     *     return parent[x];
     * }
     */

    /**
     * Merge the sets containing x and y.
     *
     * UNION BY RANK: attach the shorter tree under the root of the taller tree.
     * This keeps trees shallow. Without this, trees could degenerate to linked lists.
     *
     * The rank is an upper bound on tree height (not exact height, because
     * path compression reduces actual height but we do not update rank).
     *
     * Returns true if x and y were in different sets (actual merge happened).
     */
    public boolean union(int x, int y) {
        int rootX = find(x);
        int rootY = find(y);

        if (rootX == rootY) {
            return false;  // already in the same set
        }

        // Union by rank: smaller tree goes under larger tree
        if (rank[rootX] < rank[rootY]) {
            parent[rootX] = rootY;
        } else if (rank[rootX] > rank[rootY]) {
            parent[rootY] = rootX;
        } else {
            // Same rank — arbitrary choice, but increment rank of new root
            parent[rootY] = rootX;
            rank[rootX]++;
        }

        componentCount--;
        return true;
    }

    /**
     * Check if x and y are in the same set.
     */
    public boolean connected(int x, int y) {
        return find(x) == find(y);
    }

    /**
     * Return the number of disjoint sets.
     */
    public int getComponentCount() {
        return componentCount;
    }

    /**
     * Return the size of the set containing x.
     * (Requires an additional size[] array — shown below.)
     */
}
```

### Union-Find with Size Tracking

Often you need to know how many elements are in a set. This requires tracking size:

```java
/**
 * Union-Find with size tracking (union by size instead of rank).
 */
public class UnionFindWithSize {

    private final int[] parent;
    private final int[] size;   // size[i] = number of elements in tree rooted at i
    private int componentCount;

    public UnionFindWithSize(int n) {
        parent = new int[n];
        size = new int[n];
        componentCount = n;
        for (int i = 0; i < n; i++) {
            parent[i] = i;
            size[i] = 1;
        }
    }

    public int find(int x) {
        int root = x;
        while (root != parent[root]) root = parent[root];
        while (x != root) {
            int next = parent[x];
            parent[x] = root;
            x = next;
        }
        return root;
    }

    public boolean union(int x, int y) {
        int rootX = find(x);
        int rootY = find(y);
        if (rootX == rootY) return false;

        // Union by size: smaller tree goes under larger tree
        if (size[rootX] < size[rootY]) {
            parent[rootX] = rootY;
            size[rootY] += size[rootX];
        } else {
            parent[rootY] = rootX;
            size[rootX] += size[rootY];
        }

        componentCount--;
        return true;
    }

    public boolean connected(int x, int y) {
        return find(x) == find(y);
    }

    public int getSize(int x) {
        return size[find(x)];
    }

    public int getComponentCount() {
        return componentCount;
    }
}
```

### Weighted Union-Find

Sometimes you need to track a relationship between each node and its root — for example, relative distance or algebraic relationships:

```java
/**
 * Weighted Union-Find: track the "weight" (distance/offset) from each node
 * to its root. Useful for problems like "a is X heavier than b" where you
 * need to maintain relative differences.
 *
 * weight[x] = the relative value of x compared to its parent.
 * The absolute relationship of x to its root is the sum of weights on the path.
 */
public class WeightedUnionFind {

    private final int[] parent;
    private final int[] rank;
    private final double[] weight;  // weight[x] = relative value of x to parent[x]

    public WeightedUnionFind(int n) {
        parent = new int[n];
        rank = new int[n];
        weight = new double[n];
        for (int i = 0; i < n; i++) {
            parent[i] = i;
            weight[i] = 0.0;  // distance from self to self = 0
        }
    }

    /**
     * Find root and return the cumulative weight from x to root.
     * Path compression updates weights along the way.
     */
    public int find(int x) {
        if (parent[x] != x) {
            int root = find(parent[x]);
            weight[x] += weight[parent[x]];  // accumulate weight to root
            parent[x] = root;
        }
        return parent[x];
    }

    /**
     * Union x and y with the relationship: value(x) / value(y) = w
     * (or equivalently, x - y = w for additive relationships).
     */
    public boolean union(int x, int y, double w) {
        int rootX = find(x);
        int rootY = find(y);

        if (rootX == rootY) {
            // Already connected — check consistency
            return Math.abs(weight[x] - weight[y] - w) < 1e-9;
        }

        if (rank[rootX] < rank[rootY]) {
            parent[rootX] = rootY;
            weight[rootX] = weight[y] + w - weight[x];
        } else if (rank[rootX] > rank[rootY]) {
            parent[rootY] = rootX;
            weight[rootY] = weight[x] - w - weight[y];
        } else {
            parent[rootY] = rootX;
            weight[rootY] = weight[x] - w - weight[y];
            rank[rootX]++;
        }
        return true;
    }

    /**
     * Query: what is value(x) / value(y)?
     * Returns NaN if x and y are not connected.
     */
    public double query(int x, int y) {
        if (find(x) != find(y)) return Double.NaN;
        return weight[x] - weight[y];
    }
}
```

### Real-World Usage

- **Kruskal's MST**: Sort edges by weight, process in order. For each edge (u, v), if `find(u) != find(v)`, add to MST and `union(u, v)`. The MST is built in O(E log E) total.
- **Network Connectivity**: "Are servers A and B reachable from each other?" Union-Find on network links answers this in near-constant time.
- **Image Segmentation**: Adjacent pixels with similar colors are unioned. The resulting components are segments.
- **Social Network Friend Groups**: "How many friend groups exist?" is `getComponentCount()` after unioning all friendship edges.
- **Equivalence Classes**: Compiler optimizations use Union-Find to track equivalent variables (e.g., after `x = y`, the compiler unions x and y to apply constant propagation).

---

## 9.5 Skip List

### Concept and Theory

A skip list is a probabilistic alternative to balanced binary search trees. It is a sorted linked list augmented with multiple levels of "express lanes" that allow O(log n) search by skipping over large sections.

```
Level 3:  HEAD ──────────────────────────────────────────> 50 ──────────> NIL
Level 2:  HEAD ─────────────> 20 ────────────────────────> 50 ──────────> NIL
Level 1:  HEAD ──> 10 ──────> 20 ──────> 30 ──────> 40 ──> 50 ──> 60 ──> NIL
Level 0:  HEAD -> 10 -> 15 -> 20 -> 25 -> 30 -> 35 -> 40 -> 50 -> 55 -> 60 -> NIL
```

Every element exists at level 0. When inserted, an element is "promoted" to higher levels with probability p (typically 0.5 or 0.25). On average, level 0 has N elements, level 1 has N/2, level 2 has N/4, and so on. The expected number of levels is O(log N).

Search starts at the highest level and moves right until the next element is larger than the target, then drops down one level and continues. This is conceptually identical to binary search — each level halves the remaining elements.

### Why Skip Lists Matter

Skip lists have the same expected O(log n) performance as balanced BSTs (AVL, Red-Black trees), but with much simpler implementation. More importantly, skip lists are **inherently concurrent-friendly**. Inserting into a skip list only requires local modifications (update a few pointers at each level), while rebalancing a BST requires rotations that affect the tree globally. This is why `ConcurrentSkipListMap` exists in the JDK — it is far easier to make lock-free than a concurrent red-black tree.

### Full Implementation

```java
/**
 * Skip List: a probabilistic sorted data structure.
 *
 * Expected time complexity: O(log n) search, insert, delete.
 * Space: O(n) expected (each element appears in ~1/(1-p) levels on average).
 *
 * With p=0.5: expected ~2n total node appearances across all levels.
 * With p=0.25: expected ~1.33n total node appearances (more space-efficient).
 *
 * ConcurrentSkipListMap in the JDK uses a similar structure with
 * CAS-based lock-free operations for thread safety.
 */
public class SkipList<K extends Comparable<K>, V> {

    private static final int MAX_LEVEL = 32;    // supports up to 2^32 elements
    private static final double PROBABILITY = 0.5;

    private static class Node<K, V> {
        K key;
        V value;
        Node<K, V>[] forward;  // forward[i] = next node at level i

        @SuppressWarnings("unchecked")
        Node(K key, V value, int level) {
            this.key = key;
            this.value = value;
            this.forward = new Node[level + 1];
        }
    }

    private final Node<K, V> head;       // sentinel head node
    private int currentLevel;             // highest level currently in use
    private int size;
    private final Random random;

    @SuppressWarnings("unchecked")
    public SkipList() {
        this.head = new Node<>(null, null, MAX_LEVEL);
        this.currentLevel = 0;
        this.size = 0;
        this.random = new Random();
    }

    /**
     * Generate a random level for a new node.
     * Each level is added with probability p.
     *
     * Expected level = 1/(1-p). With p=0.5, expected level = 2.
     * Maximum level is capped at MAX_LEVEL.
     *
     * This is where the "probabilistic" nature lives. The randomness gives
     * us expected O(log n) without any deterministic rebalancing.
     */
    private int randomLevel() {
        int level = 0;
        while (level < MAX_LEVEL && random.nextDouble() < PROBABILITY) {
            level++;
        }
        return level;
    }

    /**
     * Search for a key. Returns the associated value, or null if not found.
     *
     * Start at the highest level, move right while the next node's key is
     * less than the target. When the next node is >= target, drop down one level.
     * Repeat until level 0. Then check if we landed on the target.
     *
     * Time: O(log n) expected.
     *
     * Trace for search(30) on the example above:
     *   Level 3: HEAD -> 50 is > 30, drop down
     *   Level 2: HEAD -> 20 is < 30, move right. 20 -> 50 is > 30, drop down
     *   Level 1: 20 -> 30 is == 30, found!
     */
    public V search(K key) {
        Node<K, V> current = head;
        for (int i = currentLevel; i >= 0; i--) {
            while (current.forward[i] != null &&
                   current.forward[i].key.compareTo(key) < 0) {
                current = current.forward[i];  // move right at level i
            }
            // current.forward[i] is null or >= key; drop down
        }
        // Now at level 0, check the next node
        current = current.forward[0];
        if (current != null && current.key.compareTo(key) == 0) {
            return current.value;
        }
        return null;
    }

    /**
     * Insert a key-value pair. If the key already exists, update the value.
     *
     * 1. Find the position at each level where the new node should be inserted.
     *    (Store these in the update[] array — these are the nodes whose forward
     *    pointers need to be modified.)
     * 2. Generate a random level for the new node.
     * 3. Create the new node and splice it into each level.
     *
     * Time: O(log n) expected.
     */
    @SuppressWarnings("unchecked")
    public void insert(K key, V value) {
        // update[i] = the node at level i whose forward pointer we need to change
        Node<K, V>[] update = new Node[MAX_LEVEL + 1];
        Node<K, V> current = head;

        // Find insertion point at each level (highest to lowest)
        for (int i = currentLevel; i >= 0; i--) {
            while (current.forward[i] != null &&
                   current.forward[i].key.compareTo(key) < 0) {
                current = current.forward[i];
            }
            update[i] = current;  // remember where we dropped down
        }

        current = current.forward[0];

        if (current != null && current.key.compareTo(key) == 0) {
            // Key already exists — update value
            current.value = value;
            return;
        }

        // Generate random level for new node
        int newLevel = randomLevel();

        // If new level is higher than current max, update the head's forward pointers
        if (newLevel > currentLevel) {
            for (int i = currentLevel + 1; i <= newLevel; i++) {
                update[i] = head;
            }
            currentLevel = newLevel;
        }

        // Create new node and splice into each level
        Node<K, V> newNode = new Node<>(key, value, newLevel);
        for (int i = 0; i <= newLevel; i++) {
            newNode.forward[i] = update[i].forward[i];   // new node points to what came after
            update[i].forward[i] = newNode;                // predecessor points to new node
        }

        size++;
    }

    /**
     * Delete a key. Returns true if the key was found and deleted.
     *
     * 1. Find the node and its predecessors at each level (same as insert).
     * 2. If found, remove it from each level by updating forward pointers.
     * 3. Reduce currentLevel if the highest levels are now empty.
     *
     * Time: O(log n) expected.
     */
    @SuppressWarnings("unchecked")
    public boolean delete(K key) {
        Node<K, V>[] update = new Node[MAX_LEVEL + 1];
        Node<K, V> current = head;

        for (int i = currentLevel; i >= 0; i--) {
            while (current.forward[i] != null &&
                   current.forward[i].key.compareTo(key) < 0) {
                current = current.forward[i];
            }
            update[i] = current;
        }

        current = current.forward[0];

        if (current == null || current.key.compareTo(key) != 0) {
            return false;  // key not found
        }

        // Remove current from each level it appears in
        for (int i = 0; i <= currentLevel; i++) {
            if (update[i].forward[i] != current) {
                break;  // current does not appear at this level
            }
            update[i].forward[i] = current.forward[i];
        }

        // Reduce level if highest levels are now empty
        while (currentLevel > 0 && head.forward[currentLevel] == null) {
            currentLevel--;
        }

        size--;
        return true;
    }

    public int size() {
        return size;
    }

    public boolean containsKey(K key) {
        return search(key) != null;
    }
}
```

### ConcurrentSkipListMap in the JDK

The JDK's `ConcurrentSkipListMap` is a production-grade concurrent skip list. It uses CAS (Compare-And-Swap) operations for lock-free insertions and deletions. The key insight: inserting into a skip list only modifies local pointers (the predecessor and successor at each level). This makes CAS-based updates straightforward, unlike a red-black tree where a rotation affects multiple nodes and their parent-child relationships.

```java
// JDK ConcurrentSkipListMap — the production skip list
ConcurrentSkipListMap<String, Integer> map = new ConcurrentSkipListMap<>();
map.put("apple", 1);
map.put("banana", 2);
map.put("cherry", 3);

// Sorted iteration — O(n), lock-free
for (Map.Entry<String, Integer> entry : map.entrySet()) {
    System.out.println(entry.getKey() + " = " + entry.getValue());
}

// Range queries — O(log n + k)
SortedMap<String, Integer> sub = map.subMap("a", "c");  // "apple", "banana"

// Thread-safe without external synchronization
// Compare with Collections.synchronizedSortedMap(new TreeMap<>()) which
// requires a global lock on every operation.
```

### Real-World Usage

- **Redis Sorted Sets (ZSET)**: Redis uses a skip list as the primary index for sorted sets. When you run `ZADD myset 3.14 "pi"`, the element is inserted into a skip list sorted by score. `ZRANGEBYSCORE` walks the skip list.
- **LevelDB/RocksDB Memtable**: Before flushing to disk, writes go to an in-memory skip list (the memtable). When the memtable reaches a threshold, it is flushed to an SSTable.
- **Apache Lucene**: Some posting list implementations use skip lists for efficient intersection of search terms.

---

## 9.6 Bloom Filter

### Concept and Theory

A Bloom filter answers the question "is this element in the set?" with two possible answers:
- "Definitely not in the set" — guaranteed correct
- "Probably in the set" — might be wrong (false positive)

There are never false negatives. If the Bloom filter says "no", the element is 100% not present.

The structure is simple: a bit array of m bits and k hash functions. To insert element x, compute k hash values and set those bit positions to 1. To query element x, compute the same k hash values and check if all bit positions are 1. If any bit is 0, the element is definitely not present. If all are 1, the element is probably present (the bits might have been set by different elements).

```
Bloom Filter (m=16 bits, k=3 hash functions):

Insert "apple":  h1("apple")=2, h2("apple")=5, h3("apple")=11
  Bits: 0 0 1 0 0 1 0 0 0 0 0 1 0 0 0 0
             ^         ^               ^

Insert "banana": h1("banana")=3, h2("banana")=8, h3("banana")=11
  Bits: 0 0 1 1 0 1 0 0 1 0 0 1 0 0 0 0
             ^ ^       ^       ^       ^
                                (bit 11 was already set by "apple" — this is OK)

Query "cherry":  h1("cherry")=2, h2("cherry")=8, h3("cherry")=14
  Bits: 0 0 1 1 0 1 0 0 1 0 0 1 0 0 0 0
             ^               ^             [14 is 0 → DEFINITELY NOT PRESENT]

Query "grape":   h1("grape")=2, h2("grape")=3, h3("grape")=5
  Bits: 0 0 1 1 0 1 0 0 1 0 0 1 0 0 0 0
             ^ ^     ^
  All bits are 1 → PROBABLY PRESENT (but "grape" was never inserted — false positive!)
```

### Mathematics of False Positive Rate

After inserting n elements into a Bloom filter with m bits and k hash functions:

- Probability a specific bit is still 0: `(1 - 1/m)^(kn) ≈ e^(-kn/m)`
- False positive probability: `p ≈ (1 - e^(-kn/m))^k`
- Optimal number of hash functions: `k = (m/n) * ln(2) ≈ 0.693 * (m/n)`
- Optimal m for target FP rate p: `m = -n * ln(p) / (ln(2))^2`

Practical numbers for 1% false positive rate:
- 1 million elements: m = 9,585,059 bits ≈ 1.14 MB, k = 7 hash functions
- 10 million elements: m ≈ 11.4 MB, k = 7
- 100 million elements: m ≈ 114 MB, k = 7

That is remarkable: 114 MB to probabilistically track membership of 100 million elements with 99% accuracy. A `HashSet<String>` for the same data would use multiple gigabytes.

### Full Implementation

```java
/**
 * Bloom Filter implementation using double hashing.
 *
 * Double hashing trick: instead of k independent hash functions (hard to find),
 * use two hash functions h1 and h2, and derive k hashes as:
 *   h_i(x) = h1(x) + i * h2(x)  for i = 0, 1, ..., k-1
 *
 * This was proven by Kirsch and Mitzenmacher (2004) to have the same false
 * positive rate as k independent hash functions for practical Bloom filters.
 *
 * Memory: BitSet of m bits. Java's BitSet stores bits in long[] arrays,
 * using m/64 longs = m/8 bytes. Very compact.
 */
public class BloomFilter<T> {

    private final BitSet bitSet;
    private final int m;              // number of bits
    private final int k;              // number of hash functions
    private final int expectedSize;   // expected number of elements
    private int insertedCount;

    /**
     * Create a Bloom filter for n expected elements with target false positive rate p.
     *
     * @param expectedElements  expected number of elements to insert
     * @param falsePositiveRate target false positive probability (e.g., 0.01 for 1%)
     */
    public BloomFilter(int expectedElements, double falsePositiveRate) {
        this.expectedSize = expectedElements;

        // Optimal m: m = -n * ln(p) / (ln(2))^2
        this.m = optimalBitCount(expectedElements, falsePositiveRate);

        // Optimal k: k = (m/n) * ln(2)
        this.k = optimalHashCount(m, expectedElements);

        this.bitSet = new BitSet(m);
        this.insertedCount = 0;
    }

    /**
     * Insert an element into the Bloom filter.
     * Time: O(k) — compute k hashes and set k bits.
     */
    public void insert(T element) {
        int hash1 = element.hashCode();
        int hash2 = spread(hash1);  // secondary hash

        for (int i = 0; i < k; i++) {
            int combinedHash = hash1 + i * hash2;
            int index = Math.floorMod(combinedHash, m);  // always non-negative
            bitSet.set(index);
        }
        insertedCount++;
    }

    /**
     * Query: might this element be in the set?
     * Returns false → DEFINITELY NOT in the set (no false negatives).
     * Returns true  → PROBABLY in the set (possible false positive).
     * Time: O(k)
     */
    public boolean mightContain(T element) {
        int hash1 = element.hashCode();
        int hash2 = spread(hash1);

        for (int i = 0; i < k; i++) {
            int combinedHash = hash1 + i * hash2;
            int index = Math.floorMod(combinedHash, m);
            if (!bitSet.get(index)) {
                return false;  // definitely not present
            }
        }
        return true;  // probably present
    }

    /**
     * Secondary hash function: spread bits to reduce correlation.
     * Based on Java HashMap's spread function.
     */
    private int spread(int hash) {
        hash ^= (hash >>> 16);
        hash *= 0x85ebca6b;
        hash ^= (hash >>> 13);
        hash *= 0xc2b2ae35;
        hash ^= (hash >>> 16);
        return hash;
    }

    /**
     * Approximate current false positive rate given the number of elements inserted.
     */
    public double currentFalsePositiveRate() {
        double exponent = -((double) k * insertedCount) / m;
        return Math.pow(1 - Math.exp(exponent), k);
    }

    /**
     * Optimal bit count for n elements and target false positive rate p.
     * m = -n * ln(p) / (ln(2))^2
     */
    private static int optimalBitCount(int n, double p) {
        return (int) Math.ceil(-n * Math.log(p) / (Math.log(2) * Math.log(2)));
    }

    /**
     * Optimal number of hash functions.
     * k = (m/n) * ln(2)
     */
    private static int optimalHashCount(int m, int n) {
        return Math.max(1, (int) Math.round((double) m / n * Math.log(2)));
    }

    public int getBitCount() { return m; }
    public int getHashCount() { return k; }
    public int getInsertedCount() { return insertedCount; }
}
```

### Real-World Usage

- **Apache Cassandra**: Before reading an SSTable from disk, Cassandra checks a Bloom filter. If the filter says "no", the SSTable definitely does not contain the key — the disk read is skipped entirely. This saves millions of disk seeks per second.
- **Google Chrome Safe Browsing**: Chrome stores a Bloom filter of known malicious URLs. Checking every URL you visit against this filter is O(k) — essentially free. Only when the filter says "might be malicious" does Chrome query Google's servers.
- **Apache HBase**: Uses Bloom filters per HFile to avoid reading blocks that do not contain the target row key.
- **Network Deduplication**: Routers use Bloom filters to detect duplicate packets without storing every packet hash.

---

## 9.7 LRU Cache

### Concept and Theory

An LRU (Least Recently Used) Cache evicts the least recently accessed item when the cache is full. It needs two things simultaneously:
1. O(1) lookup by key (HashMap)
2. O(1) access-order tracking (Doubly Linked List)

Neither data structure alone suffices. The combination gives both: the HashMap provides instant key lookup, and the doubly linked list maintains the access order. When an item is accessed, it is moved to the front of the list. When the cache is full, the tail of the list is evicted.

```
HashMap: {A: nodeA, C: nodeC, B: nodeB}

Doubly Linked List (most recent → least recent):
  HEAD <-> [C] <-> [A] <-> [B] <-> TAIL
           MRU                LRU (evict first)

After accessing A:
  HEAD <-> [A] <-> [C] <-> [B] <-> TAIL
           MRU                LRU

After inserting D (cache full, capacity=3, evict B):
  HEAD <-> [D] <-> [A] <-> [C] <-> TAIL
           MRU                LRU
  HashMap: remove B, add D
```

### Full Implementation from Scratch

```java
/**
 * LRU Cache: HashMap + Doubly Linked List.
 *
 * All operations are O(1):
 * - get(key): HashMap lookup + move-to-front in linked list
 * - put(key, value): HashMap insert + add-to-front, evict tail if full
 *
 * Memory per entry: ~32 bytes (Node object) + HashMap.Node (~32 bytes)
 * + key and value objects. Total: ~64 bytes overhead per cache entry.
 *
 * The sentinel (dummy) head and tail nodes eliminate null checks
 * in every linked list operation. This is a classic technique:
 * instead of checking "is prev null? is next null?", the sentinels
 * guarantee every real node always has a valid prev and next.
 */
public class LRUCache<K, V> {

    private static class DLinkedNode<K, V> {
        K key;
        V value;
        DLinkedNode<K, V> prev;
        DLinkedNode<K, V> next;

        DLinkedNode() {}  // for sentinel nodes

        DLinkedNode(K key, V value) {
            this.key = key;
            this.value = value;
        }
    }

    private final int capacity;
    private int size;
    private final Map<K, DLinkedNode<K, V>> map;
    private final DLinkedNode<K, V> head;   // sentinel: head.next = most recently used
    private final DLinkedNode<K, V> tail;   // sentinel: tail.prev = least recently used

    public LRUCache(int capacity) {
        this.capacity = capacity;
        this.size = 0;
        this.map = new HashMap<>();

        // Initialize sentinel nodes
        head = new DLinkedNode<>();
        tail = new DLinkedNode<>();
        head.next = tail;
        tail.prev = head;
    }

    /**
     * Get the value for a key. Returns null if not found.
     * If found, moves the node to the front (most recently used).
     * Time: O(1)
     */
    public V get(K key) {
        DLinkedNode<K, V> node = map.get(key);
        if (node == null) {
            return null;
        }
        // Move to front (mark as most recently used)
        removeNode(node);
        addToFront(node);
        return node.value;
    }

    /**
     * Put a key-value pair. If key exists, update value and move to front.
     * If key is new and cache is full, evict the least recently used entry.
     * Time: O(1)
     */
    public void put(K key, V value) {
        DLinkedNode<K, V> node = map.get(key);

        if (node != null) {
            // Key exists — update value and move to front
            node.value = value;
            removeNode(node);
            addToFront(node);
        } else {
            // New key
            DLinkedNode<K, V> newNode = new DLinkedNode<>(key, value);
            map.put(key, newNode);
            addToFront(newNode);
            size++;

            if (size > capacity) {
                // Evict the least recently used (tail.prev)
                DLinkedNode<K, V> evicted = tail.prev;
                removeNode(evicted);
                map.remove(evicted.key);  // This is why the node stores the key
                size--;
            }
        }
    }

    /**
     * Remove a node from its current position in the doubly linked list.
     * O(1) — just update prev.next and next.prev.
     * Sentinel nodes guarantee prev and next are never null.
     */
    private void removeNode(DLinkedNode<K, V> node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }

    /**
     * Add a node right after the head sentinel (most recently used position).
     * O(1) — update 4 pointers.
     */
    private void addToFront(DLinkedNode<K, V> node) {
        node.prev = head;
        node.next = head.next;
        head.next.prev = node;
        head.next = node;
    }

    public int size() {
        return size;
    }
}
```

### LinkedHashMap-Based LRU (The JDK Shortcut)

Java provides a much simpler way to build an LRU cache — `LinkedHashMap` with `accessOrder = true`:

```java
/**
 * LRU Cache using LinkedHashMap — elegant but less flexible.
 *
 * LinkedHashMap maintains a doubly-linked list of all entries in
 * insertion order (default) or access order (when accessOrder=true).
 * Override removeEldestEntry() to cap the size.
 *
 * This is functionally identical to our manual implementation above,
 * but in 10 lines instead of 80.
 */
public class LinkedHashMapLRU<K, V> extends LinkedHashMap<K, V> {

    private final int capacity;

    public LinkedHashMapLRU(int capacity) {
        super(capacity, 0.75f, true);  // true = access-order (not insertion-order)
        this.capacity = capacity;
    }

    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        return size() > capacity;
    }
}
```

Why implement from scratch in interviews? Because the interviewer is testing whether you understand the underlying mechanics — the combination of HashMap and doubly linked list, the sentinel node pattern, the O(1) move-to-front operation. Using `LinkedHashMap` demonstrates API knowledge but not data structure understanding.

### Thread-Safe LRU Cache

A production LRU cache must be thread-safe. The simplest correct approach:

```java
/**
 * Thread-safe LRU Cache using synchronized blocks.
 *
 * For higher concurrency, you could use:
 * - Caffeine library (Ben Manes): near-optimal hit rate, highly concurrent
 * - Guava Cache: simpler API, good enough for most use cases
 * - ConcurrentLinkedHashMap: lock-striped, better than global synchronization
 *
 * A fully lock-free LRU is extremely difficult because moving a node to
 * the front requires atomically updating 4 pointers. Most production
 * implementations use sharded/striped locks or approximate LRU.
 */
public class ConcurrentLRUCache<K, V> {

    private final LRUCache<K, V> cache;

    public ConcurrentLRUCache(int capacity) {
        this.cache = new LRUCache<>(capacity);
    }

    public synchronized V get(K key) {
        return cache.get(key);
    }

    public synchronized void put(K key, V value) {
        cache.put(key, value);
    }

    public synchronized int size() {
        return cache.size();
    }
}
```

### Real-World Usage

- **CPU Caches (L1/L2/L3)**: Hardware caches use LRU (or approximations like pseudo-LRU) to decide which cache line to evict when bringing in new data.
- **Database Buffer Pools**: PostgreSQL's buffer pool manager evicts the least recently used pages from memory to make room for pages fetched from disk. MySQL's InnoDB uses a variation of LRU with a "young" and "old" sublist.
- **CDN Edge Caches**: When a CDN node's local storage is full, it evicts the least recently requested content.
- **Operating System Page Replacement**: The OS page cache uses clock (an LRU approximation) to decide which memory pages to evict to disk.
- **Browser Cache**: Firefox and Chrome use LRU-based policies for their HTTP cache.

---

## 9.8 Count-Min Sketch

### Concept and Theory

A Count-Min Sketch is a probabilistic frequency table. It answers "approximately how many times has element x been seen?" using sub-linear space. Like a Bloom filter, it trades accuracy for memory — but where a Bloom filter tracks membership (yes/no), a Count-Min Sketch tracks frequency (count).

The structure is a d x w matrix of counters with d hash functions:
- d (depth) = number of hash functions = number of rows
- w (width) = number of counters per hash function = number of columns

```
Count-Min Sketch (d=3 rows, w=8 columns):

         col: 0  1  2  3  4  5  6  7
h1(x):     [ 0, 3, 0, 1, 0, 5, 0, 2 ]
h2(x):     [ 1, 0, 4, 0, 0, 0, 3, 0 ]
h3(x):     [ 0, 0, 0, 2, 0, 1, 0, 4 ]

Update("apple"):  h1("apple")=5, h2("apple")=2, h3("apple")=3
  Increment matrix[0][5], matrix[1][2], matrix[2][3]

Query("apple"):   min(matrix[0][5], matrix[1][2], matrix[2][3])
  = min(5, 4, 2) = 2
  The true count of "apple" is <= 2.
  (Or more precisely: the result is >= true count, because collisions only add.)
```

Key properties:
- **No underestimation**: The returned count is always >= the true count (counters can only be incremented by collisions, never decremented).
- **Error bound**: With probability >= 1-delta, the overestimate is at most epsilon*N, where N is the total number of updates, w = ceil(e/epsilon), d = ceil(ln(1/delta)).

### Full Implementation

```java
/**
 * Count-Min Sketch: probabilistic frequency estimation.
 *
 * Space: d * w counters. For epsilon=0.01, delta=0.001:
 *   w = ceil(e/0.01) = 272
 *   d = ceil(ln(1/0.001)) = 7
 *   Total: 272 * 7 = 1,904 counters = ~7.4 KB (for int counters)
 *
 * Compare with a HashMap<String, Integer> for 1 million distinct elements:
 * ~72 MB. The Count-Min Sketch is ~10,000x more memory-efficient,
 * at the cost of approximate (overestimated) counts.
 */
public class CountMinSketch {

    private final int[][] matrix;  // d rows x w columns
    private final int depth;       // d = number of hash functions
    private final int width;       // w = number of counters per row
    private final int[] hashSeeds; // one seed per hash function
    private long totalCount;

    /**
     * Create a Count-Min Sketch with specified error bounds.
     *
     * @param epsilon relative error: estimates are within epsilon*N of true count
     * @param delta   probability of exceeding the error bound
     */
    public CountMinSketch(double epsilon, double delta) {
        this.width = (int) Math.ceil(Math.E / epsilon);
        this.depth = (int) Math.ceil(Math.log(1.0 / delta));
        this.matrix = new int[depth][width];
        this.totalCount = 0;

        // Generate random seeds for hash functions
        Random random = new Random(42);  // fixed seed for reproducibility
        this.hashSeeds = new int[depth];
        for (int i = 0; i < depth; i++) {
            hashSeeds[i] = random.nextInt();
        }
    }

    /**
     * Record one occurrence of an element.
     * Time: O(d) — increment one counter in each row.
     */
    public void update(Object element) {
        update(element, 1);
    }

    /**
     * Record multiple occurrences of an element.
     * Time: O(d)
     */
    public void update(Object element, int count) {
        int hash = element.hashCode();
        for (int i = 0; i < depth; i++) {
            int index = getIndex(hash, i);
            matrix[i][index] += count;
        }
        totalCount += count;
    }

    /**
     * Estimate the frequency of an element.
     * Returns the minimum counter value across all rows.
     *
     * Why minimum? Each counter might be inflated by collisions with
     * other elements. The minimum is the least inflated estimate.
     * It is still >= the true count (no underestimation), but it is
     * the tightest upper bound we can get from the sketch.
     *
     * Time: O(d)
     */
    public int estimate(Object element) {
        int hash = element.hashCode();
        int minCount = Integer.MAX_VALUE;
        for (int i = 0; i < depth; i++) {
            int index = getIndex(hash, i);
            minCount = Math.min(minCount, matrix[i][index]);
        }
        return minCount;
    }

    /**
     * Compute the column index for a given element hash and row.
     * Uses the double hashing technique to derive independent hash functions.
     */
    private int getIndex(int hash, int row) {
        // Combine element hash with row-specific seed
        int combined = hash ^ hashSeeds[row];
        combined = (combined * 0x9e3779b9) ^ (combined >>> 16);  // additional mixing
        return Math.floorMod(combined, width);
    }

    public long getTotalCount() { return totalCount; }
    public int getDepth() { return depth; }
    public int getWidth() { return width; }
}
```

### Heavy Hitter Detection with Count-Min Sketch

A common application: find elements whose frequency exceeds a threshold (e.g., "which IPs have sent more than 1% of total traffic?"):

```java
/**
 * Heavy Hitter Detector: find elements that appear more than
 * a threshold fraction of the total count.
 *
 * Uses a Count-Min Sketch for frequency estimation plus a min-heap
 * to track the top candidates.
 */
public class HeavyHitterDetector<T> {

    private final CountMinSketch sketch;
    private final Map<T, Integer> candidates;   // tracked candidates and their estimated counts
    private final int maxCandidates;
    private long totalCount;

    /**
     * @param epsilon error bound for the Count-Min Sketch
     * @param delta   confidence parameter
     * @param maxCandidates maximum number of heavy hitter candidates to track
     */
    public HeavyHitterDetector(double epsilon, double delta, int maxCandidates) {
        this.sketch = new CountMinSketch(epsilon, delta);
        this.candidates = new HashMap<>();
        this.maxCandidates = maxCandidates;
        this.totalCount = 0;
    }

    /**
     * Record an element and update heavy hitter candidates.
     */
    public void observe(T element) {
        sketch.update(element);
        totalCount++;

        int estimatedCount = sketch.estimate(element);
        candidates.put(element, estimatedCount);

        // Prune candidates with low estimated counts
        if (candidates.size() > maxCandidates * 2) {
            long threshold = totalCount / maxCandidates;
            candidates.entrySet().removeIf(e -> e.getValue() < threshold);
        }
    }

    /**
     * Get the current heavy hitters (elements above the threshold fraction).
     * @param fractionThreshold elements with estimated frequency > fractionThreshold * totalCount
     */
    public List<Map.Entry<T, Integer>> getHeavyHitters(double fractionThreshold) {
        long threshold = (long) (totalCount * fractionThreshold);
        List<Map.Entry<T, Integer>> result = new ArrayList<>();
        for (Map.Entry<T, Integer> entry : candidates.entrySet()) {
            // Re-estimate from sketch for freshness
            int freshEstimate = sketch.estimate(entry.getKey());
            if (freshEstimate >= threshold) {
                result.add(Map.entry(entry.getKey(), freshEstimate));
            }
        }
        result.sort((a, b) -> b.getValue() - a.getValue());
        return result;
    }
}
```

### Real-World Usage

- **Network Traffic Monitoring**: ISPs use Count-Min Sketches to identify heavy hitters (IPs generating the most traffic) without storing per-IP counters for billions of packets.
- **Database Query Optimization**: PostgreSQL's `pg_stat_statements` tracks query frequencies. A sketch-based approach could handle far more distinct queries in limited memory.
- **Streaming Analytics**: Apache Flink and Spark Streaming use sketches for approximate frequency counts on unbounded data streams.
- **Ad Click Fraud Detection**: Detecting IPs that click ads disproportionately often, without storing exact click counts for every IP.

---

## 9.9 Consistent Hashing

### Concept and Theory

Consider distributing keys across N cache servers. The naive approach `server = hash(key) % N` works until you add or remove a server — changing N causes almost every key to remap to a different server, invalidating the entire cache.

Consistent hashing solves this: hash both keys and servers onto a ring (0 to 2^32 - 1). Each key maps to the first server clockwise from its hash position. When a server is added or removed, only the keys in the adjacent arc are affected — roughly 1/N of all keys instead of nearly all keys.

```
Hash Ring (0 to 2^32-1, shown as 0 to 360 degrees):

        Server A (hash=60)
          ↓
    ......A..........
   .                  .
  .                    .
 .                      .       Keys in arc (300, 60] → Server A
 .                      .       Keys in arc (60, 180]  → Server B
 .                      .       Keys in arc (180, 300] → Server C
  .                    .
   .                  .
    ......C..........B..
         ↑           ↑
  Server C (300)  Server B (180)

Adding Server D at position 120:
  Now keys in arc (60, 120] move from Server B to Server D.
  Keys in arc (120, 180] stay with Server B.
  Keys with Servers A and C are UNAFFECTED.
  Only ~1/4 of keys need to move (instead of ~3/4 with hash % N).
```

### Virtual Nodes

In practice, three physical servers do not partition the ring evenly. One server might "own" 60% of the ring by bad luck. Virtual nodes solve this: each physical server gets V virtual positions on the ring. With V=150, the distribution becomes statistically uniform.

```
Physical Server A → Virtual nodes: A-1 (hash=60), A-2 (hash=200), A-3 (hash=340)
Physical Server B → Virtual nodes: B-1 (hash=30), B-2 (hash=180), B-3 (hash=310)

The ring now has 6 points. The arcs are more evenly distributed.
As V increases, the distribution converges to perfectly uniform.
```

### Full Implementation

```java
/**
 * Consistent Hashing Ring with Virtual Nodes.
 *
 * Uses a TreeMap (Red-Black tree) as the ring:
 * - Key: hash position on the ring (Integer)
 * - Value: physical server identifier (String)
 *
 * TreeMap.ceilingEntry(hash) finds the first server clockwise from the hash.
 * This is O(log(N*V)) where N = physical servers, V = virtual nodes per server.
 *
 * Why TreeMap and not a sorted array? Because servers are added/removed
 * dynamically, and TreeMap supports O(log n) insertion/deletion.
 * A sorted array would require O(n) shifts.
 */
public class ConsistentHashRing {

    private final TreeMap<Integer, String> ring;       // hash position → server name
    private final Map<String, Set<Integer>> serverPositions; // server → its positions on ring
    private final int virtualNodes;                     // number of virtual nodes per server
    private final MessageDigest md5;

    /**
     * @param virtualNodes number of virtual nodes per physical server.
     *                     Higher = more even distribution, more memory.
     *                     Typical values: 100-200. Amazon DynamoDB uses 150.
     */
    public ConsistentHashRing(int virtualNodes) {
        this.ring = new TreeMap<>();
        this.serverPositions = new HashMap<>();
        this.virtualNodes = virtualNodes;
        try {
            this.md5 = MessageDigest.getInstance("MD5");
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("MD5 not available", e);
        }
    }

    /**
     * Add a physical server to the ring.
     * Creates 'virtualNodes' positions on the ring for this server.
     *
     * Time: O(V * log(N*V)) where V = virtual nodes, N*V = total ring entries.
     */
    public void addServer(String server) {
        Set<Integer> positions = new HashSet<>();
        for (int i = 0; i < virtualNodes; i++) {
            int hash = hash(server + "#" + i);
            ring.put(hash, server);
            positions.add(hash);
        }
        serverPositions.put(server, positions);
    }

    /**
     * Remove a physical server from the ring.
     * Removes all its virtual node positions.
     *
     * Time: O(V * log(N*V))
     *
     * After removal, keys that were mapped to this server automatically
     * fall to the next server clockwise on the ring.
     */
    public void removeServer(String server) {
        Set<Integer> positions = serverPositions.remove(server);
        if (positions != null) {
            for (int pos : positions) {
                ring.remove(pos);
            }
        }
    }

    /**
     * Get the server responsible for a given key.
     *
     * Hash the key, find the first server at or clockwise from that position.
     * If we wrap around (no server with hash >= key hash), take the first server
     * on the ring (wrap around to 0).
     *
     * Time: O(log(N*V)) — one TreeMap lookup.
     */
    public String getServer(String key) {
        if (ring.isEmpty()) {
            throw new IllegalStateException("No servers in the ring");
        }
        int hash = hash(key);

        // Find the first entry with hash >= key's hash
        Map.Entry<Integer, String> entry = ring.ceilingEntry(hash);

        if (entry == null) {
            // Wrap around to the first server on the ring
            entry = ring.firstEntry();
        }

        return entry.getValue();
    }

    /**
     * Get the server and its N-1 successors (for replication).
     * In real systems, each key is replicated to the next N distinct physical servers.
     *
     * @param key the key to look up
     * @param replicationFactor number of distinct physical servers to return
     */
    public List<String> getServersForKey(String key, int replicationFactor) {
        if (ring.isEmpty()) {
            throw new IllegalStateException("No servers in the ring");
        }

        List<String> servers = new ArrayList<>();
        Set<String> seen = new HashSet<>();  // avoid duplicate physical servers
        int hash = hash(key);

        // Walk clockwise from the key's position
        Map.Entry<Integer, String> entry = ring.ceilingEntry(hash);
        Iterator<Map.Entry<Integer, String>> it;

        if (entry != null) {
            it = ring.tailMap(hash, true).entrySet().iterator();
        } else {
            it = ring.entrySet().iterator();
        }

        // Collect distinct physical servers
        while (servers.size() < replicationFactor) {
            if (!it.hasNext()) {
                it = ring.entrySet().iterator();  // wrap around
            }
            Map.Entry<Integer, String> next = it.next();
            String server = next.getValue();
            if (seen.add(server)) {
                servers.add(server);
            }
            if (seen.size() == serverPositions.size()) {
                break;  // all physical servers covered
            }
        }

        return servers;
    }

    /**
     * Simulate: which keys need to move when a server is added?
     * For each virtual node of the new server, keys that were mapped to the
     * NEXT server clockwise will now map to the new server instead.
     */
    public Map<String, String> simulateServerAddition(String newServer, List<String> sampleKeys) {
        Map<String, String> migrations = new HashMap<>();

        // Record current mappings
        Map<String, String> before = new HashMap<>();
        for (String key : sampleKeys) {
            before.put(key, getServer(key));
        }

        // Add the server
        addServer(newServer);

        // Record new mappings and find changes
        for (String key : sampleKeys) {
            String after = getServer(key);
            if (!after.equals(before.get(key))) {
                migrations.put(key, before.get(key) + " -> " + after);
            }
        }

        return migrations;
    }

    /**
     * Hash function: use MD5 and take the first 4 bytes as an int.
     * MD5 is chosen for good distribution, not for security.
     *
     * In production, you might use MurmurHash3 or xxHash for better performance.
     */
    private int hash(String key) {
        md5.reset();
        byte[] digest = md5.digest(key.getBytes(StandardCharsets.UTF_8));
        // Take the first 4 bytes as an integer
        return ((digest[0] & 0xFF) << 24)
             | ((digest[1] & 0xFF) << 16)
             | ((digest[2] & 0xFF) << 8)
             | (digest[3] & 0xFF);
    }

    public int getServerCount() {
        return serverPositions.size();
    }

    public int getRingSize() {
        return ring.size();
    }
}
```

### Key Redistribution Analysis

When a new server is added with V virtual nodes to a ring with N existing servers:
- Each virtual node "steals" a fraction of one arc from one existing server.
- Total keys moved: approximately `K / (N+1)` where K = total keys.
- This is optimal — any scheme that distributes keys evenly across N+1 servers must move at least K/(N+1) keys.

When a server is removed:
- Its keys move to the next clockwise server for each virtual node.
- Total keys moved: approximately `K / N` (the removed server's share).

Compare with `hash(key) % N`: adding one server remaps approximately `K * N/(N+1)` keys — almost all of them.

### Real-World Usage

- **Amazon DynamoDB**: Uses consistent hashing to partition data across storage nodes. Virtual nodes ensure even distribution. When a node fails, its partition is automatically absorbed by the next node on the ring.
- **Apache Cassandra**: Uses a consistent hash ring (the "token ring") to distribute rows across nodes. Each node owns a range of tokens. Adding a node splits an existing range.
- **Akamai CDN**: One of the first large-scale deployments of consistent hashing. Web content is mapped to edge servers using a hash ring, ensuring content locality and minimal disruption during server changes.
- **Memcached Clients**: The `libmemcached` client library uses consistent hashing with virtual nodes to distribute cache keys across Memcached servers.
- **Redis Cluster**: Uses hash slots (0-16383) with a consistent hashing-like scheme. Each node owns a set of hash slots, and keys are mapped to slots via `CRC16(key) % 16384`.

---

## Problems

### Trie Problems

**P09.01** [E] — Implement Trie (Prefix Tree)

Implement a trie with `insert`, `search`, and `startsWith` methods.

```
Example:
  trie.insert("apple")
  trie.search("apple")   → true
  trie.search("app")     → false
  trie.startsWith("app") → true
  trie.insert("app")
  trie.search("app")     → true
```

```java
/*
 * Approach: Standard array-based trie with 26-slot children arrays.
 *
 * Each node has:
 *   - TrieNode[] children of size 26 (one per lowercase letter)
 *   - boolean isEnd to mark complete words
 *
 * insert: walk the trie character by character, creating nodes as needed.
 * search: walk the trie; return true only if we reach the end AND isEnd is true.
 * startsWith: walk the trie; return true if we reach the end of the prefix.
 *
 * Time: O(L) for all operations where L = word/prefix length.
 * Space: O(L) per insert (worst case: no shared prefix).
 *
 * JVM note: each TrieNode creates a TrieNode[26] array on the heap.
 * That is 16 (array header) + 26*4 (references) = 120 bytes per node.
 * For a trie with 100,000 nodes, that is ~12 MB just for children arrays.
 * Most of those 26 slots will be null — this is the cost of O(1) child access.
 */
class Trie {
    private final int[][] children;  // children[nodeId][charIdx] = child nodeId
    private final boolean[] isEnd;
    private int nodeCount;

    public Trie() {
        // Pre-allocate for efficiency — avoids creating thousands of small arrays
        int maxNodes = 100001;  // adjust based on constraints
        children = new int[maxNodes][26];
        isEnd = new boolean[maxNodes];
        for (int[] row : children) Arrays.fill(row, -1);
        nodeCount = 1;  // node 0 is root
    }

    public void insert(String word) {
        int curr = 0;
        for (int i = 0; i < word.length(); i++) {
            int c = word.charAt(i) - 'a';
            if (children[curr][c] == -1) {
                children[curr][c] = nodeCount++;
            }
            curr = children[curr][c];
        }
        isEnd[curr] = true;
    }

    public boolean search(String word) {
        int node = traverse(word);
        return node != -1 && isEnd[node];
    }

    public boolean startsWith(String prefix) {
        return traverse(prefix) != -1;
    }

    private int traverse(String s) {
        int curr = 0;
        for (int i = 0; i < s.length(); i++) {
            int c = s.charAt(i) - 'a';
            if (children[curr][c] == -1) return -1;
            curr = children[curr][c];
        }
        return curr;
    }
}
```

**P09.02** [H] — Word Search II (Trie + Backtracking on Board)

Given an m x n board of characters and a list of words, find all words on the board. Each word must be constructed from sequentially adjacent cells (horizontal or vertical), and each cell may only be used once per word.

```
Board:          Words: ["oath","pea","eat","rain"]
o a a n         Result: ["eat","oath"]
e t a e
i h k r
a i f l
```

```java
/*
 * Approach: Build a trie from the word list, then DFS from every cell on the board.
 * At each cell, check if the current path is a prefix in the trie. If not, prune.
 * If we reach a trie node where isEnd is true, we found a word.
 *
 * Why trie + backtracking? Without the trie, for each word we would need a
 * separate DFS. With W words and M*N cells, that is O(W * M*N * 4^L).
 * With the trie, we do ONE DFS from each cell and simultaneously check all
 * words whose prefix matches the current path. The trie prunes branches
 * that cannot lead to any word.
 *
 * Time: O(M * N * 4^L) where L = max word length, but heavily pruned by the trie.
 * Space: O(W * L) for the trie + O(L) for DFS recursion stack.
 *
 * Optimization: after finding a word, decrement a counter instead of removing
 * the word from the trie. When a node has no children and is not an end,
 * prune it to avoid redundant exploration.
 */
class WordSearchII {
    private int[][] trieChildren;
    private boolean[] trieIsEnd;
    private String[] trieWords;  // store the word at its end node
    private int trieNodeCount;

    public List<String> findWords(char[][] board, String[] words) {
        // Build trie
        int maxNodes = 0;
        for (String w : words) maxNodes += w.length();
        maxNodes += 1;
        trieChildren = new int[maxNodes][26];
        trieIsEnd = new boolean[maxNodes];
        trieWords = new String[maxNodes];
        for (int[] row : trieChildren) Arrays.fill(row, -1);
        trieNodeCount = 1;

        for (String word : words) {
            int curr = 0;
            for (char c : word.toCharArray()) {
                int idx = c - 'a';
                if (trieChildren[curr][idx] == -1) {
                    trieChildren[curr][idx] = trieNodeCount++;
                }
                curr = trieChildren[curr][idx];
            }
            trieIsEnd[curr] = true;
            trieWords[curr] = word;
        }

        List<String> result = new ArrayList<>();
        int m = board.length, n = board[0].length;

        for (int i = 0; i < m; i++) {
            for (int j = 0; j < n; j++) {
                int childIdx = board[i][j] - 'a';
                if (trieChildren[0][childIdx] != -1) {
                    dfs(board, i, j, 0, result);
                }
            }
        }

        return result;
    }

    private void dfs(char[][] board, int r, int c, int trieNode, List<String> result) {
        if (r < 0 || r >= board.length || c < 0 || c >= board[0].length) return;
        char ch = board[r][c];
        if (ch == '#') return;  // visited

        int childIdx = ch - 'a';
        int nextNode = trieChildren[trieNode][childIdx];
        if (nextNode == -1) return;  // no word has this prefix — prune

        if (trieIsEnd[nextNode]) {
            result.add(trieWords[nextNode]);
            trieIsEnd[nextNode] = false;  // avoid duplicates
        }

        board[r][c] = '#';  // mark visited
        dfs(board, r + 1, c, nextNode, result);
        dfs(board, r - 1, c, nextNode, result);
        dfs(board, r, c + 1, nextNode, result);
        dfs(board, r, c - 1, nextNode, result);
        board[r][c] = ch;  // unmark
    }
}
```

**P09.03** [M] — Design Add and Search Words Data Structure

Design a data structure that supports adding words and searching with `.` wildcards (matches any letter).

```java
/*
 * Approach: Trie with modified search. When we encounter '.', try all 26 children.
 *
 * insert: standard trie insert — O(L).
 * search: when char is a letter, follow that child. When char is '.', branch into
 *         all non-null children (DFS/backtracking). Worst case O(26^L) for all dots,
 *         but typically much better due to null children pruning.
 *
 * Time:  insert O(L), search O(26^L) worst case, O(L) for no wildcards.
 * Space: O(total characters across all inserted words).
 */
class WordDictionary {
    private final TrieNode root = new TrieNode();

    private static class TrieNode {
        TrieNode[] children = new TrieNode[26];
        boolean isEnd;
    }

    public void addWord(String word) {
        TrieNode curr = root;
        for (char c : word.toCharArray()) {
            int i = c - 'a';
            if (curr.children[i] == null) curr.children[i] = new TrieNode();
            curr = curr.children[i];
        }
        curr.isEnd = true;
    }

    public boolean search(String word) {
        return searchHelper(root, word, 0);
    }

    private boolean searchHelper(TrieNode node, String word, int idx) {
        if (node == null) return false;
        if (idx == word.length()) return node.isEnd;

        char c = word.charAt(idx);
        if (c != '.') {
            return searchHelper(node.children[c - 'a'], word, idx + 1);
        }
        // Wildcard: try all children
        for (TrieNode child : node.children) {
            if (searchHelper(child, word, idx + 1)) return true;
        }
        return false;
    }
}
```

**P09.04** [M] — Replace Words

Given a dictionary of root words and a sentence, replace every word in the sentence with its shortest root.

```
dictionary: ["cat","bat","rat"]
sentence: "the cattle was rattled by the battery"
Output: "the cat was rat by the bat"
```

```java
/*
 * Approach: Build a trie from the dictionary. For each word in the sentence,
 * walk the trie. The first time we hit isEnd=true, we have found the shortest root.
 *
 * Time: O(D*L + S*L) where D = dictionary size, L = avg word length, S = sentence words.
 * Space: O(D*L) for the trie.
 */
class ReplaceWords {
    public String replaceWords(List<String> dictionary, String sentence) {
        // Build trie from dictionary
        int[][] children = new int[100001][26];
        boolean[] isEnd = new boolean[100001];
        for (int[] row : children) Arrays.fill(row, -1);
        int cnt = 1;

        for (String root : dictionary) {
            int curr = 0;
            for (char c : root.toCharArray()) {
                int idx = c - 'a';
                if (children[curr][idx] == -1) children[curr][idx] = cnt++;
                curr = children[curr][idx];
            }
            isEnd[curr] = true;
        }

        StringBuilder result = new StringBuilder();
        for (String word : sentence.split(" ")) {
            if (result.length() > 0) result.append(' ');
            int curr = 0;
            boolean replaced = false;
            for (int i = 0; i < word.length(); i++) {
                int idx = word.charAt(i) - 'a';
                if (children[curr][idx] == -1) break;
                curr = children[curr][idx];
                if (isEnd[curr]) {
                    result.append(word, 0, i + 1);
                    replaced = true;
                    break;
                }
            }
            if (!replaced) result.append(word);
        }
        return result.toString();
    }
}
```

**P09.05** [M] — Map Sum Pairs

Implement a `MapSum` class: `insert(key, val)` inserts or updates a key-value pair. `sum(prefix)` returns the sum of all values whose key starts with the given prefix.

```java
/*
 * Approach: Trie where each node stores the cumulative sum contribution.
 * On insert, walk the trie and add (newVal - oldVal) at each node along the path.
 * On sum(prefix), walk to the prefix node and return its cumulative value.
 *
 * Time: insert O(L), sum O(P).
 * Space: O(total characters).
 */
class MapSum {
    private final Map<String, Integer> map = new HashMap<>();
    private final int[][] children;
    private final int[] vals;
    private int cnt;

    public MapSum() {
        children = new int[5001][26];
        vals = new int[5001];
        for (int[] row : children) Arrays.fill(row, -1);
        cnt = 1;
    }

    public void insert(String key, int val) {
        int delta = val - map.getOrDefault(key, 0);
        map.put(key, val);
        int curr = 0;
        vals[curr] += delta;
        for (char c : key.toCharArray()) {
            int idx = c - 'a';
            if (children[curr][idx] == -1) children[curr][idx] = cnt++;
            curr = children[curr][idx];
            vals[curr] += delta;
        }
    }

    public int sum(String prefix) {
        int curr = 0;
        for (char c : prefix.toCharArray()) {
            int idx = c - 'a';
            if (children[curr][idx] == -1) return 0;
            curr = children[curr][idx];
        }
        return vals[curr];
    }
}
```

**P09.06** [M] — Longest Word in Dictionary

Given an array of strings, find the longest word that can be built one character at a time by other words in the array.

```java
/*
 * Approach: Insert all words into a trie. Then BFS/DFS from root, only following
 * edges where the intermediate node is also isEnd=true (i.e., the prefix is also
 * a word in the array). Track the longest such path.
 *
 * Time: O(sum of word lengths).
 * Space: O(sum of word lengths).
 */
class LongestWord {
    public String longestWord(String[] words) {
        // Sort: shorter words first, then lexicographic for ties
        Arrays.sort(words);
        Set<String> built = new HashSet<>();
        built.add("");  // empty string is always buildable
        String result = "";

        for (String word : words) {
            String prefix = word.substring(0, word.length() - 1);
            if (built.contains(prefix)) {
                built.add(word);
                if (word.length() > result.length()) {
                    result = word;
                }
            }
        }
        return result;
    }
}
```

**P09.07** [H] — Palindrome Pairs

Given a list of unique words, find all pairs (i, j) where the concatenation `words[i] + words[j]` is a palindrome.

```java
/*
 * Approach: For each word, consider all possible split points. If the left part
 * is a palindrome and the reverse of the right part exists in the map, that forms
 * a valid pair. Similarly for the right part being a palindrome.
 *
 * Use a HashMap for O(1) reverse lookups instead of a trie for simplicity,
 * but a trie solution also works (walk the trie with the reversed word).
 *
 * Time: O(N * L^2) where N = words count, L = max word length.
 * Space: O(N * L).
 */
class PalindromePairs {
    public List<List<Integer>> palindromePairs(String[] words) {
        Map<String, Integer> wordMap = new HashMap<>();
        for (int i = 0; i < words.length; i++) {
            wordMap.put(words[i], i);
        }

        List<List<Integer>> result = new ArrayList<>();
        for (int i = 0; i < words.length; i++) {
            String word = words[i];
            for (int j = 0; j <= word.length(); j++) {
                String left = word.substring(0, j);
                String right = word.substring(j);

                // Case 1: left is palindrome, reverse(right) exists → reverse(right) + word is palindrome
                if (isPalindrome(left)) {
                    String revRight = new StringBuilder(right).reverse().toString();
                    Integer idx = wordMap.get(revRight);
                    if (idx != null && idx != i) {
                        result.add(Arrays.asList(idx, i));
                    }
                }
                // Case 2: right is palindrome, reverse(left) exists → word + reverse(left) is palindrome
                if (right.length() > 0 && isPalindrome(right)) {
                    String revLeft = new StringBuilder(left).reverse().toString();
                    Integer idx = wordMap.get(revLeft);
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
}
```

**P09.08** [H] — Design Search Autocomplete System

Design a search autocomplete system. Given a `sentences` array and their `times` (frequencies), and a user typing character by character, return the top 3 hot sentences that share the current prefix.

```java
/*
 * Approach: Trie where each node maintains a map of sentence → frequency for
 * all sentences that pass through it. On each typed character, navigate the trie
 * and return top 3 by frequency from the current node's map.
 *
 * When '#' is typed, save the current input as a complete sentence.
 *
 * Time: insert O(L * S) amortized, input O(L + S*log(S)) per character where
 *       S = sentences through this prefix, L = sentence length.
 * Space: O(N * L) where N = total sentences.
 */
class AutocompleteSystem {
    private TrieNode root = new TrieNode();
    private TrieNode current;
    private StringBuilder currentInput = new StringBuilder();

    private static class TrieNode {
        Map<Character, TrieNode> children = new HashMap<>();
        Map<String, Integer> sentenceCounts = new HashMap<>();
    }

    public AutocompleteSystem(String[] sentences, int[] times) {
        for (int i = 0; i < sentences.length; i++) {
            addSentence(sentences[i], times[i]);
        }
        current = root;
    }

    private void addSentence(String sentence, int count) {
        TrieNode node = root;
        for (char c : sentence.toCharArray()) {
            node.children.putIfAbsent(c, new TrieNode());
            node = node.children.get(c);
            node.sentenceCounts.merge(sentence, count, Integer::sum);
        }
    }

    public List<String> input(char c) {
        if (c == '#') {
            addSentence(currentInput.toString(), 1);
            currentInput = new StringBuilder();
            current = root;
            return Collections.emptyList();
        }

        currentInput.append(c);
        if (current != null) {
            current = current.children.get(c);
        }

        if (current == null) {
            return Collections.emptyList();
        }

        // Get top 3 by frequency, then lexicographic order
        PriorityQueue<Map.Entry<String, Integer>> pq = new PriorityQueue<>(
            (a, b) -> a.getValue().equals(b.getValue())
                ? b.getKey().compareTo(a.getKey())   // lower lex last (will be first after poll)
                : a.getValue() - b.getValue()         // lower freq first (evicted first)
        );

        for (Map.Entry<String, Integer> entry : current.sentenceCounts.entrySet()) {
            pq.offer(entry);
            if (pq.size() > 3) pq.poll();
        }

        LinkedList<String> result = new LinkedList<>();
        while (!pq.isEmpty()) {
            result.addFirst(pq.poll().getKey());
        }
        return result;
    }
}
```

**P09.09** [H] — Stream of Characters

Implement a `StreamChecker` that checks if a suffix of the characters seen so far matches any word in a given list.

```java
/*
 * Approach: Build a trie of REVERSED words. Maintain a buffer of all characters
 * seen so far. On each query, walk the reversed-word trie backwards through
 * the buffer. If we hit isEnd=true, a word suffix matches.
 *
 * Why reverse? Because we need to match suffixes of the stream, which
 * correspond to prefixes of reversed words. A standard trie matches prefixes,
 * so reversing the words turns suffix matching into prefix matching.
 *
 * Time: query O(L) where L = max word length.
 * Space: O(sum of word lengths + stream length).
 */
class StreamChecker {
    private final int[][] children;
    private final boolean[] isEnd;
    private int cnt;
    private final StringBuilder stream = new StringBuilder();
    private int maxLen;

    public StreamChecker(String[] words) {
        int total = 0;
        for (String w : words) {
            total += w.length();
            maxLen = Math.max(maxLen, w.length());
        }
        children = new int[total + 1][26];
        isEnd = new boolean[total + 1];
        for (int[] row : children) Arrays.fill(row, -1);
        cnt = 1;

        for (String word : words) {
            int curr = 0;
            for (int i = word.length() - 1; i >= 0; i--) {
                int c = word.charAt(i) - 'a';
                if (children[curr][c] == -1) children[curr][c] = cnt++;
                curr = children[curr][c];
            }
            isEnd[curr] = true;
        }
    }

    public boolean query(char letter) {
        stream.append(letter);
        int curr = 0;
        int start = stream.length() - 1;
        int end = Math.max(0, stream.length() - maxLen);
        for (int i = start; i >= end; i--) {
            int c = stream.charAt(i) - 'a';
            if (children[curr][c] == -1) return false;
            curr = children[curr][c];
            if (isEnd[curr]) return true;
        }
        return false;
    }
}
```

### Segment Tree Problems

**P09.10** [M] — Range Sum Query — Mutable

Given an array, implement `update(i, val)` and `sumRange(l, r)`.

```java
/*
 * Approach: Standard segment tree for range sum with point updates.
 * Build: O(n). Update: O(log n). Query: O(log n).
 *
 * This is the canonical segment tree problem. See the full implementation
 * in Section 9.2 above.
 */
class NumArray {
    private final int[] tree;
    private final int n;

    public NumArray(int[] nums) {
        n = nums.length;
        tree = new int[4 * n];
        build(nums, 1, 0, n - 1);
    }

    private void build(int[] nums, int node, int s, int e) {
        if (s == e) { tree[node] = nums[s]; return; }
        int mid = s + (e - s) / 2;
        build(nums, 2 * node, s, mid);
        build(nums, 2 * node + 1, mid + 1, e);
        tree[node] = tree[2 * node] + tree[2 * node + 1];
    }

    public void update(int index, int val) {
        update(1, 0, n - 1, index, val);
    }

    private void update(int node, int s, int e, int idx, int val) {
        if (s == e) { tree[node] = val; return; }
        int mid = s + (e - s) / 2;
        if (idx <= mid) update(2 * node, s, mid, idx, val);
        else update(2 * node + 1, mid + 1, e, idx, val);
        tree[node] = tree[2 * node] + tree[2 * node + 1];
    }

    public int sumRange(int left, int right) {
        return query(1, 0, n - 1, left, right);
    }

    private int query(int node, int s, int e, int l, int r) {
        if (r < s || e < l) return 0;
        if (l <= s && e <= r) return tree[node];
        int mid = s + (e - s) / 2;
        return query(2 * node, s, mid, l, r)
             + query(2 * node + 1, mid + 1, e, l, r);
    }
}
```

**P09.11** [H] — Count of Range Sum

Given an integer array and two integers lower and upper, return the count of range sums S(i,j) that lie in [lower, upper].

```java
/*
 * Approach: Compute prefix sums, then use merge sort to count pairs (i, j)
 * where lower <= prefix[j] - prefix[i] <= upper. During merge, for each
 * element in the left half, use two pointers on the right half to find
 * the valid range.
 *
 * Alternative: Segment tree or BIT on coordinate-compressed prefix sums.
 *
 * Time: O(n log n).
 * Space: O(n).
 */
class CountRangeSum {
    public int countRangeSum(int[] nums, int lower, int upper) {
        int n = nums.length;
        long[] prefix = new long[n + 1];
        for (int i = 0; i < n; i++) {
            prefix[i + 1] = prefix[i] + nums[i];
        }
        return mergeSort(prefix, 0, prefix.length, lower, upper);
    }

    private int mergeSort(long[] arr, int lo, int hi, int lower, int upper) {
        if (hi - lo <= 1) return 0;
        int mid = lo + (hi - lo) / 2;
        int count = mergeSort(arr, lo, mid, lower, upper)
                  + mergeSort(arr, mid, hi, lower, upper);

        int j1 = mid, j2 = mid;
        for (int i = lo; i < mid; i++) {
            while (j1 < hi && arr[j1] - arr[i] < lower) j1++;
            while (j2 < hi && arr[j2] - arr[i] <= upper) j2++;
            count += j2 - j1;
        }

        // Standard merge
        long[] temp = new long[hi - lo];
        int p1 = lo, p2 = mid, k = 0;
        while (p1 < mid && p2 < hi) {
            temp[k++] = arr[p1] <= arr[p2] ? arr[p1++] : arr[p2++];
        }
        while (p1 < mid) temp[k++] = arr[p1++];
        while (p2 < hi) temp[k++] = arr[p2++];
        System.arraycopy(temp, 0, arr, lo, hi - lo);
        return count;
    }
}
```

**P09.12** [H] — Falling Squares

Squares are dropped one by one onto the x-axis. Each square has left edge and side length. Find the height of the tallest stack after each drop.

```java
/*
 * Approach: Coordinate compression + segment tree with lazy propagation.
 * After compressing the x-coordinates, each square drop is a range max-update
 * and the answer after each drop is the global maximum.
 *
 * Alternatively, use a simpler O(n^2) approach for interview: for each new
 * square, check overlap with all previous squares to find the base height.
 *
 * Time: O(n^2) for the simpler approach shown here.
 * Space: O(n).
 */
class FallingSquares {
    public List<Integer> fallingSquares(int[][] positions) {
        List<int[]> intervals = new ArrayList<>();  // [left, right, height]
        List<Integer> result = new ArrayList<>();
        int maxHeight = 0;

        for (int[] pos : positions) {
            int left = pos[0], side = pos[1], right = left + side;
            int baseHeight = 0;

            for (int[] interval : intervals) {
                // Check overlap: intervals overlap if !(right <= interval[0] || left >= interval[1])
                if (right > interval[0] && left < interval[1]) {
                    baseHeight = Math.max(baseHeight, interval[2]);
                }
            }

            int newHeight = baseHeight + side;
            intervals.add(new int[]{left, right, newHeight});
            maxHeight = Math.max(maxHeight, newHeight);
            result.add(maxHeight);
        }
        return result;
    }
}
```

**P09.13** [H] — Rectangle Area II

Given axis-aligned rectangles, find the total area covered by all rectangles (handling overlaps).

```java
/*
 * Approach: Coordinate compression + sweep line + segment tree.
 * Compress y-coordinates. Sweep a vertical line from left to right.
 * At each x-event (rectangle start or end), update the segment tree
 * with the active y-intervals and compute the covered length.
 *
 * Time: O(n^2) with the simplified approach, O(n log n) with segment tree.
 * Space: O(n).
 */
class RectangleArea {
    public int rectangleArea(int[][] rectangles) {
        long MOD = 1_000_000_007;
        // Collect all unique y-coordinates
        Set<Integer> ySet = new TreeSet<>();
        List<int[]> events = new ArrayList<>();  // [x, type, y1, y2] type: 0=open, 1=close

        for (int[] r : rectangles) {
            ySet.add(r[1]); ySet.add(r[3]);
            events.add(new int[]{r[0], 0, r[1], r[3]});  // open
            events.add(new int[]{r[2], 1, r[1], r[3]});  // close
        }
        events.sort((a, b) -> a[0] != b[0] ? a[0] - b[0] : a[1] - b[1]);

        Integer[] ys = ySet.toArray(new Integer[0]);
        Map<Integer, Integer> yIndex = new HashMap<>();
        for (int i = 0; i < ys.length; i++) yIndex.put(ys[i], i);

        int[] count = new int[ys.length];
        long area = 0;
        int prevX = events.get(0)[0];

        for (int[] event : events) {
            int x = event[0];
            // Add covered length * width to area
            long coveredY = 0;
            for (int i = 0; i < ys.length - 1; i++) {
                if (count[i] > 0) coveredY += ys[i + 1] - ys[i];
            }
            area = (area + coveredY * (x - prevX)) % MOD;
            prevX = x;

            int y1 = yIndex.get(event[2]), y2 = yIndex.get(event[3]);
            int delta = event[1] == 0 ? 1 : -1;
            for (int i = y1; i < y2; i++) count[i] += delta;
        }
        return (int) area;
    }
}
```

### Fenwick Tree Problems

**P09.14** [M] — Count Inversions

Count the number of inversions in an array: pairs (i, j) where i < j but arr[i] > arr[j].

```java
/*
 * Approach: Process elements from right to left. For each element arr[i],
 * count how many elements to its right are smaller. This count is the
 * number of inversions involving arr[i].
 *
 * Use a BIT indexed by value (after coordinate compression) to track
 * which values have been seen. prefixSum(arr[i] - 1) gives the count
 * of elements seen so far that are smaller than arr[i].
 *
 * Wait — we process right to left, so "seen so far" means "to the right."
 * So the count of elements to the right that are smaller = prefixSum(val - 1).
 *
 * Time: O(n log n).
 * Space: O(n).
 */
class CountInversions {
    public long countInversions(int[] arr) {
        int n = arr.length;
        // Coordinate compression
        int[] sorted = arr.clone();
        Arrays.sort(sorted);
        Map<Integer, Integer> rank = new HashMap<>();
        int r = 1;
        for (int val : sorted) {
            if (!rank.containsKey(val)) rank.put(val, r++);
        }

        int[] bit = new int[r + 1];
        long inversions = 0;

        // Process right to left
        for (int i = n - 1; i >= 0; i--) {
            int val = rank.get(arr[i]);
            // Count elements to the right that are smaller
            inversions += prefixSum(bit, val - 1);
            // Add current element
            update(bit, val, 1);
        }
        return inversions;
    }

    private void update(int[] bit, int i, int delta) {
        while (i < bit.length) { bit[i] += delta; i += i & (-i); }
    }

    private int prefixSum(int[] bit, int i) {
        int sum = 0;
        while (i > 0) { sum += bit[i]; i -= i & (-i); }
        return sum;
    }
}
```

**P09.15** [H] — Range Sum Query 2D — Mutable

Given a 2D matrix, implement `update(row, col, val)` and `sumRegion(row1, col1, row2, col2)`.

```java
/*
 * Approach: 2D Fenwick Tree (BIT on both dimensions).
 * update(r, c, val): update BIT at (r, c) with delta = val - current.
 * sumRegion: use inclusion-exclusion with four prefix sums.
 *
 * Time: update O(log m * log n), query O(log m * log n).
 * Space: O(m * n).
 */
class NumMatrix {
    private int[][] bit;
    private int[][] matrix;
    private int m, n;

    public NumMatrix(int[][] matrix) {
        this.m = matrix.length;
        this.n = matrix[0].length;
        this.bit = new int[m + 1][n + 1];
        this.matrix = new int[m][n];
        for (int i = 0; i < m; i++)
            for (int j = 0; j < n; j++)
                update(i, j, matrix[i][j]);
    }

    public void update(int row, int col, int val) {
        int delta = val - matrix[row][col];
        matrix[row][col] = val;
        for (int i = row + 1; i <= m; i += i & (-i))
            for (int j = col + 1; j <= n; j += j & (-j))
                bit[i][j] += delta;
    }

    public int sumRegion(int r1, int c1, int r2, int c2) {
        return prefix(r2 + 1, c2 + 1) - prefix(r1, c2 + 1) - prefix(r2 + 1, c1) + prefix(r1, c1);
    }

    private int prefix(int r, int c) {
        int sum = 0;
        for (int i = r; i > 0; i -= i & (-i))
            for (int j = c; j > 0; j -= j & (-j))
                sum += bit[i][j];
        return sum;
    }
}
```

**P09.16** [H] — Count of Smaller Numbers After Self

Given an array `nums`, return an array `counts` where `counts[i]` is the number of elements to the right of `nums[i]` that are smaller.

```java
/*
 * Approach: Process right to left. For each element, use a BIT (indexed by
 * coordinate-compressed value) to count how many smaller elements are to the right.
 *
 * Identical logic to Count Inversions, but we collect per-element counts
 * instead of a single total.
 *
 * Time: O(n log n).
 * Space: O(n).
 */
class CountSmaller {
    public List<Integer> countSmaller(int[] nums) {
        int n = nums.length;
        int[] sorted = nums.clone();
        Arrays.sort(sorted);
        Map<Integer, Integer> rank = new HashMap<>();
        int r = 0;
        for (int val : sorted) {
            if (!rank.containsKey(val)) rank.put(val, ++r);
        }

        int[] bit = new int[r + 2];
        Integer[] result = new Integer[n];

        for (int i = n - 1; i >= 0; i--) {
            int val = rank.get(nums[i]);
            result[i] = query(bit, val - 1);
            update(bit, val, r + 1);
        }
        return Arrays.asList(result);
    }

    private void update(int[] bit, int i, int max) {
        while (i <= max) { bit[i]++; i += i & (-i); }
    }

    private int query(int[] bit, int i) {
        int sum = 0;
        while (i > 0) { sum += bit[i]; i -= i & (-i); }
        return sum;
    }
}
```

### Union-Find Problems

**P09.17** [M] — Number of Islands (Union-Find Approach)

Given a 2D grid of '1's (land) and '0's (water), count the number of islands using Union-Find.

```java
/*
 * Approach: Map each cell to a 1D index (row * cols + col). Initialize UF with
 * all land cells as their own components. For each land cell, union with adjacent
 * land cells. The answer is the number of components.
 *
 * Why UF instead of DFS? Both work for this problem. UF is useful when the grid
 * is updated dynamically (cells added/removed) and we need to maintain connectivity.
 *
 * Time: O(M * N * alpha(M*N)) ≈ O(M*N).
 * Space: O(M * N).
 */
class NumberOfIslandsUF {
    public int numIslands(char[][] grid) {
        int m = grid.length, n = grid[0].length;
        int[] parent = new int[m * n];
        int[] rank = new int[m * n];
        int components = 0;

        for (int i = 0; i < m; i++) {
            for (int j = 0; j < n; j++) {
                int id = i * n + j;
                parent[id] = id;
                if (grid[i][j] == '1') components++;
            }
        }

        int[][] dirs = {{1,0},{0,1}};  // only right and down to avoid double-counting
        for (int i = 0; i < m; i++) {
            for (int j = 0; j < n; j++) {
                if (grid[i][j] == '0') continue;
                for (int[] d : dirs) {
                    int ni = i + d[0], nj = j + d[1];
                    if (ni < m && nj < n && grid[ni][nj] == '1') {
                        int a = find(parent, i * n + j);
                        int b = find(parent, ni * n + nj);
                        if (a != b) {
                            if (rank[a] < rank[b]) parent[a] = b;
                            else if (rank[a] > rank[b]) parent[b] = a;
                            else { parent[b] = a; rank[a]++; }
                            components--;
                        }
                    }
                }
            }
        }
        return components;
    }

    private int find(int[] parent, int x) {
        while (parent[x] != x) {
            parent[x] = parent[parent[x]];  // path halving
            x = parent[x];
        }
        return x;
    }
}
```

**P09.18** [M] — Accounts Merge

Given a list of accounts where each account has a name and a list of emails, merge accounts that share any email.

```java
/*
 * Approach: Each unique email is a node. Union all emails within the same account.
 * After processing, group emails by their root representative. Map each root
 * back to the account name.
 *
 * Time: O(N * L * alpha(N*L)) where N = accounts, L = avg emails per account.
 * Space: O(N * L).
 */
class AccountsMerge {
    private Map<String, String> parent = new HashMap<>();
    private Map<String, String> emailToName = new HashMap<>();

    public List<List<String>> accountsMerge(List<List<String>> accounts) {
        for (List<String> account : accounts) {
            String name = account.get(0);
            for (int i = 1; i < account.size(); i++) {
                parent.putIfAbsent(account.get(i), account.get(i));
                emailToName.put(account.get(i), name);
                if (i > 1) union(account.get(1), account.get(i));
            }
        }

        Map<String, TreeSet<String>> groups = new HashMap<>();
        for (String email : parent.keySet()) {
            String root = find(email);
            groups.computeIfAbsent(root, k -> new TreeSet<>()).add(email);
        }

        List<List<String>> result = new ArrayList<>();
        for (Map.Entry<String, TreeSet<String>> entry : groups.entrySet()) {
            List<String> merged = new ArrayList<>();
            merged.add(emailToName.get(entry.getKey()));
            merged.addAll(entry.getValue());
            result.add(merged);
        }
        return result;
    }

    private String find(String x) {
        while (!parent.get(x).equals(x)) {
            parent.put(x, parent.get(parent.get(x)));
            x = parent.get(x);
        }
        return x;
    }

    private void union(String a, String b) {
        String ra = find(a), rb = find(b);
        if (!ra.equals(rb)) parent.put(ra, rb);
    }
}
```

**P09.19** [M] — Redundant Connection

Find the edge that, when removed, makes the graph a tree (no cycle).

```java
/*
 * Approach: Process edges one by one. For each edge (u, v), if find(u) == find(v),
 * this edge creates a cycle — it is the redundant connection. Otherwise, union(u, v).
 *
 * Time: O(N * alpha(N)) ≈ O(N).
 * Space: O(N).
 */
class RedundantConnection {
    public int[] findRedundantConnection(int[][] edges) {
        int n = edges.length;
        int[] parent = new int[n + 1];
        int[] rank = new int[n + 1];
        for (int i = 1; i <= n; i++) parent[i] = i;

        for (int[] edge : edges) {
            int a = find(parent, edge[0]);
            int b = find(parent, edge[1]);
            if (a == b) return edge;  // cycle detected
            if (rank[a] < rank[b]) parent[a] = b;
            else if (rank[a] > rank[b]) parent[b] = a;
            else { parent[b] = a; rank[a]++; }
        }
        return new int[0];  // should not reach here
    }

    private int find(int[] parent, int x) {
        while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    }
}
```

**P09.20** [M] — Most Stones Removed with Same Row or Column

Given stones on a 2D plane, two stones are connected if they share a row or column. Find the maximum number of stones that can be removed.

```java
/*
 * Approach: This is a connected components problem. If C is the number of
 * connected components, then we can remove N - C stones (each component
 * must keep at least one stone).
 *
 * Union stones that share a row or column. Use Union-Find with
 * coordinate-based keys: map row i to index i, column j to index j + offset.
 *
 * Time: O(N * alpha(N)).
 * Space: O(N + maxCoord).
 */
class MostStonesRemoved {
    private int[] parent;
    private int components;

    public int removeStones(int[][] stones) {
        int n = stones.length;
        // Use a map-based UF to handle arbitrary coordinates
        Map<Integer, Integer> parentMap = new HashMap<>();
        components = 0;

        for (int[] stone : stones) {
            // Use ~col (bitwise complement) to distinguish row and col indices
            union(parentMap, stone[0], ~stone[1]);
        }
        return n - components;
    }

    private int find(Map<Integer, Integer> p, int x) {
        if (!p.containsKey(x)) {
            p.put(x, x);
            components++;
        }
        while (p.get(x) != x) {
            p.put(x, p.get(p.get(x)));
            x = p.get(x);
        }
        return x;
    }

    private void union(Map<Integer, Integer> p, int a, int b) {
        int ra = find(p, a), rb = find(p, b);
        if (ra != rb) {
            p.put(ra, rb);
            components--;
        }
    }
}
```

**P09.21** [E] — Number of Provinces

Given an adjacency matrix, count the number of connected components (provinces).

```java
/*
 * Approach: Standard Union-Find. For each edge (i, j) where isConnected[i][j] == 1,
 * union(i, j). Return the component count.
 *
 * Time: O(n^2 * alpha(n)) ≈ O(n^2).
 * Space: O(n).
 */
class NumberOfProvinces {
    public int findCircleNum(int[][] isConnected) {
        int n = isConnected.length;
        int[] parent = new int[n], rank = new int[n];
        for (int i = 0; i < n; i++) parent[i] = i;
        int components = n;

        for (int i = 0; i < n; i++) {
            for (int j = i + 1; j < n; j++) {
                if (isConnected[i][j] == 1) {
                    int a = find(parent, i), b = find(parent, j);
                    if (a != b) {
                        if (rank[a] < rank[b]) parent[a] = b;
                        else if (rank[a] > rank[b]) parent[b] = a;
                        else { parent[b] = a; rank[a]++; }
                        components--;
                    }
                }
            }
        }
        return components;
    }

    private int find(int[] p, int x) {
        while (p[x] != x) { p[x] = p[p[x]]; x = p[x]; }
        return x;
    }
}
```

**P09.22** [M] — Satisfiability of Equality Equations

Given equations like ["a==b","b!=c","c==a"], determine if they can all be satisfied simultaneously.

```java
/*
 * Approach: Two passes.
 * Pass 1: Process all "==" equations — union the two variables.
 * Pass 2: Process all "!=" equations — if the two variables are in the same
 *         component, it is a contradiction → return false.
 *
 * Time: O(N * alpha(26)) = O(N).
 * Space: O(26) = O(1).
 */
class SatisfiabilityEquations {
    public boolean equationsPossible(String[] equations) {
        int[] parent = new int[26];
        for (int i = 0; i < 26; i++) parent[i] = i;

        // Pass 1: union all equalities
        for (String eq : equations) {
            if (eq.charAt(1) == '=') {
                union(parent, eq.charAt(0) - 'a', eq.charAt(3) - 'a');
            }
        }

        // Pass 2: check all inequalities
        for (String eq : equations) {
            if (eq.charAt(1) == '!') {
                if (find(parent, eq.charAt(0) - 'a') == find(parent, eq.charAt(3) - 'a')) {
                    return false;
                }
            }
        }
        return true;
    }

    private int find(int[] p, int x) {
        while (p[x] != x) { p[x] = p[p[x]]; x = p[x]; }
        return x;
    }

    private void union(int[] p, int a, int b) {
        int ra = find(p, a), rb = find(p, b);
        if (ra != rb) p[ra] = rb;
    }
}
```

**P09.23** [H] — Swim in Rising Water

Given an n x n grid of elevations, find the minimum time T such that you can swim from (0,0) to (n-1,n-1) where at time T, all cells with elevation <= T are underwater.

```java
/*
 * Approach: Binary search + Union-Find (or BFS). Sort all cells by elevation.
 * Process cells in increasing elevation order, unioning adjacent cells that
 * are both "underwater." Check if (0,0) and (n-1,n-1) are connected.
 *
 * Alternative: Kruskal's-like approach — sort cells by elevation, add them
 * one by one, union with neighbors, stop when (0,0) connects to (n-1,n-1).
 *
 * Time: O(n^2 log n) for sorting + O(n^2 * alpha(n^2)) for UF.
 * Space: O(n^2).
 */
class SwimInRisingWater {
    public int swimInWater(int[][] grid) {
        int n = grid.length;
        int[] parent = new int[n * n], rank = new int[n * n];
        for (int i = 0; i < n * n; i++) parent[i] = i;

        // Sort cells by elevation
        int[][] cells = new int[n * n][3]; // {elevation, row, col}
        for (int i = 0; i < n; i++)
            for (int j = 0; j < n; j++)
                cells[i * n + j] = new int[]{grid[i][j], i, j};
        Arrays.sort(cells, (a, b) -> a[0] - b[0]);

        boolean[][] visited = new boolean[n][n];
        int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};

        for (int[] cell : cells) {
            int elev = cell[0], r = cell[1], c = cell[2];
            visited[r][c] = true;

            for (int[] d : dirs) {
                int nr = r + d[0], nc = c + d[1];
                if (nr >= 0 && nr < n && nc >= 0 && nc < n && visited[nr][nc]) {
                    union(parent, rank, r * n + c, nr * n + nc);
                }
            }

            if (find(parent, 0) == find(parent, n * n - 1)) {
                return elev;
            }
        }
        return grid[n - 1][n - 1];  // should not reach here for valid input
    }

    private int find(int[] p, int x) {
        while (p[x] != x) { p[x] = p[p[x]]; x = p[x]; }
        return x;
    }

    private void union(int[] p, int[] r, int a, int b) {
        int ra = find(p, a), rb = find(p, b);
        if (ra != rb) {
            if (r[ra] < r[rb]) p[ra] = rb;
            else if (r[ra] > r[rb]) p[rb] = ra;
            else { p[rb] = ra; r[ra]++; }
        }
    }
}
```

**P09.24** [M] — Smallest String With Swaps

Given a string and a list of index pairs that can be swapped, return the lexicographically smallest string.

```java
/*
 * Approach: Union all indices that can be swapped (directly or transitively).
 * Within each component, sort the characters. Assign sorted characters back
 * to the sorted indices of each component.
 *
 * Time: O(n log n) for sorting within components.
 * Space: O(n).
 */
class SmallestStringWithSwaps {
    public String smallestStringWithSwaps(String s, List<List<Integer>> pairs) {
        int n = s.length();
        int[] parent = new int[n];
        for (int i = 0; i < n; i++) parent[i] = i;

        for (List<Integer> pair : pairs) {
            union(parent, pair.get(0), pair.get(1));
        }

        // Group indices by component
        Map<Integer, List<Integer>> groups = new HashMap<>();
        for (int i = 0; i < n; i++) {
            groups.computeIfAbsent(find(parent, i), k -> new ArrayList<>()).add(i);
        }

        char[] result = new char[n];
        for (List<Integer> indices : groups.values()) {
            // Collect and sort characters in this component
            List<Character> chars = new ArrayList<>();
            for (int idx : indices) chars.add(s.charAt(idx));
            Collections.sort(chars);
            Collections.sort(indices);
            for (int i = 0; i < indices.size(); i++) {
                result[indices.get(i)] = chars.get(i);
            }
        }
        return new String(result);
    }

    private int find(int[] p, int x) {
        while (p[x] != x) { p[x] = p[p[x]]; x = p[x]; }
        return x;
    }

    private void union(int[] p, int a, int b) {
        int ra = find(p, a), rb = find(p, b);
        if (ra != rb) p[ra] = rb;
    }
}
```

### Skip List Problem

**P09.25** [H] — Design Skiplist

Design a Skiplist without using any built-in libraries. Implement `search`, `add`, and `erase`.

```java
/*
 * Approach: Full skip list implementation as in Section 9.5.
 * Use random level generation with p=0.5.
 * Allow duplicate values (erase removes only one occurrence).
 *
 * Time: O(log n) expected for all operations.
 * Space: O(n) expected.
 */
class Skiplist {
    private static final int MAX_LEVEL = 16;
    private static final double P = 0.5;

    private static class Node {
        int val;
        Node[] forward;
        Node(int val, int level) {
            this.val = val;
            this.forward = new Node[level + 1];
        }
    }

    private final Node head = new Node(-1, MAX_LEVEL);
    private int level = 0;
    private final Random rand = new Random();

    public boolean search(int target) {
        Node curr = head;
        for (int i = level; i >= 0; i--) {
            while (curr.forward[i] != null && curr.forward[i].val < target)
                curr = curr.forward[i];
        }
        curr = curr.forward[0];
        return curr != null && curr.val == target;
    }

    public void add(int num) {
        Node[] update = new Node[MAX_LEVEL + 1];
        Node curr = head;
        for (int i = level; i >= 0; i--) {
            while (curr.forward[i] != null && curr.forward[i].val < num)
                curr = curr.forward[i];
            update[i] = curr;
        }

        int newLevel = 0;
        while (newLevel < MAX_LEVEL && rand.nextDouble() < P) newLevel++;

        if (newLevel > level) {
            for (int i = level + 1; i <= newLevel; i++) update[i] = head;
            level = newLevel;
        }

        Node newNode = new Node(num, newLevel);
        for (int i = 0; i <= newLevel; i++) {
            newNode.forward[i] = update[i].forward[i];
            update[i].forward[i] = newNode;
        }
    }

    public boolean erase(int num) {
        Node[] update = new Node[MAX_LEVEL + 1];
        Node curr = head;
        for (int i = level; i >= 0; i--) {
            while (curr.forward[i] != null && curr.forward[i].val < num)
                curr = curr.forward[i];
            update[i] = curr;
        }

        curr = curr.forward[0];
        if (curr == null || curr.val != num) return false;

        for (int i = 0; i <= level; i++) {
            if (update[i].forward[i] != curr) break;
            update[i].forward[i] = curr.forward[i];
        }
        while (level > 0 && head.forward[level] == null) level--;
        return true;
    }
}
```

### Bloom Filter Problems

**P09.26** [M] — Implement Bloom Filter

Implement a Bloom filter with configurable false positive rate and test it.

```java
/*
 * Approach: See full implementation in Section 9.6.
 * Key design decisions:
 * - Use double hashing (h1 + i*h2) instead of k independent hash functions.
 * - Use BitSet for the bit array (backed by long[], 64 bits per long).
 * - Calculate optimal m and k from expected elements and desired FP rate.
 *
 * Test: insert N elements, then test N new elements (not inserted).
 * The observed false positive rate should be close to the configured rate.
 *
 * Time: O(k) per insert and query, where k = number of hash functions.
 * Space: O(m) bits, where m = -n*ln(p)/(ln(2))^2.
 */
class BloomFilterTest {
    public static void main(String[] args) {
        BloomFilter<String> filter = new BloomFilter<>(1_000_000, 0.01);
        // Insert 1M elements
        for (int i = 0; i < 1_000_000; i++) {
            filter.insert("element-" + i);
        }
        // Check: all inserted elements should return true
        for (int i = 0; i < 1_000_000; i++) {
            assert filter.mightContain("element-" + i);
        }
        // Count false positives on 1M non-inserted elements
        int falsePositives = 0;
        for (int i = 1_000_000; i < 2_000_000; i++) {
            if (filter.mightContain("element-" + i)) falsePositives++;
        }
        double observedFP = falsePositives / 1_000_000.0;
        // Expected: ~1% (0.01). Observed should be close.
        System.out.printf("False positive rate: %.4f%% (target: 1%%)%n", observedFP * 100);
    }
}
```

**P09.27** [M] — Detect Duplicates in Streaming Data

Given a stream of strings, detect if a string has been seen before using a Bloom filter. Handle the trade-off between memory and accuracy.

```java
/*
 * Approach: Use a Bloom filter for the initial check (fast, memory-efficient).
 * When the Bloom filter says "probably seen," verify against a secondary store
 * (disk-backed set, database, etc.) to eliminate false positives.
 *
 * This two-tier approach gives:
 * - True negatives handled entirely in memory (vast majority of lookups).
 * - Only potential positives hit the slow path (about FP_rate * total queries).
 *
 * For 100M unique strings with 1% FP rate:
 * - Bloom filter: ~114 MB (vs ~6+ GB for a HashSet<String>)
 * - Slow path queries: ~1% of lookups hit the secondary store.
 *
 * Time: O(k) for Bloom check + O(1) amortized for secondary check.
 * Space: O(m) bits for Bloom + secondary store on disk.
 */
class StreamDeduplicator {
    private final BloomFilter<String> bloomFilter;
    private final Set<String> confirmedSet;  // in production, this would be a database

    public StreamDeduplicator(int expectedElements, double fpRate) {
        this.bloomFilter = new BloomFilter<>(expectedElements, fpRate);
        this.confirmedSet = new HashSet<>();  // simplified; use LevelDB/RocksDB in production
    }

    /**
     * Process a stream element. Returns true if it is a duplicate.
     */
    public boolean isDuplicate(String element) {
        if (!bloomFilter.mightContain(element)) {
            // Definitely new — fast path
            bloomFilter.insert(element);
            confirmedSet.add(element);
            return false;
        }
        // Bloom says "maybe seen" — verify against confirmed set
        if (confirmedSet.contains(element)) {
            return true;  // confirmed duplicate
        }
        // False positive from Bloom filter — element is actually new
        bloomFilter.insert(element);
        confirmedSet.add(element);
        return false;
    }
}
```

### LRU Cache Problems

**P09.28** [M] — LRU Cache (from scratch)

Implement an LRU cache with `get` and `put` operations, both O(1).

```java
/*
 * Approach: HashMap + Doubly Linked List, as described in Section 9.7.
 * See the full LRUCache implementation above.
 *
 * Key insight: the node must store both key and value. The key is needed
 * when evicting the tail — we must remove the corresponding entry from
 * the HashMap, and we only have the node, so the node must know its key.
 *
 * Sentinel head and tail nodes eliminate edge cases in all list operations.
 *
 * Time: O(1) for both get and put.
 * Space: O(capacity).
 */
// See LRUCache implementation in Section 9.7.
```

**P09.29** [H] — LFU Cache

Implement a Least Frequently Used cache. When evicting, remove the element with the lowest access frequency. If there is a tie, remove the least recently used among them.

```java
/*
 * Approach: Three maps:
 * 1. keyToVal: key → value (O(1) lookup)
 * 2. keyToFreq: key → frequency count
 * 3. freqToKeys: frequency → LinkedHashSet of keys (preserves insertion order = LRU within frequency)
 *
 * Plus a minFreq variable tracking the current minimum frequency.
 *
 * get(key): increment frequency, move key from old freq bucket to new.
 *           Update minFreq if the old bucket is now empty and was the min.
 * put(key, val): if key exists, update. If new and full, evict the first
 *                key in the minFreq bucket (it is the LRU among least frequent).
 *
 * Time: O(1) for both get and put.
 * Space: O(capacity).
 */
class LFUCache {
    private final int capacity;
    private int minFreq;
    private final Map<Integer, Integer> keyToVal;
    private final Map<Integer, Integer> keyToFreq;
    private final Map<Integer, LinkedHashSet<Integer>> freqToKeys;

    public LFUCache(int capacity) {
        this.capacity = capacity;
        this.minFreq = 0;
        keyToVal = new HashMap<>();
        keyToFreq = new HashMap<>();
        freqToKeys = new HashMap<>();
    }

    public int get(int key) {
        if (!keyToVal.containsKey(key)) return -1;
        increaseFreq(key);
        return keyToVal.get(key);
    }

    public void put(int key, int value) {
        if (capacity <= 0) return;

        if (keyToVal.containsKey(key)) {
            keyToVal.put(key, value);
            increaseFreq(key);
            return;
        }

        if (keyToVal.size() >= capacity) {
            // Evict LFU (and LRU among tied)
            LinkedHashSet<Integer> minFreqKeys = freqToKeys.get(minFreq);
            int evictKey = minFreqKeys.iterator().next();  // first = LRU
            minFreqKeys.remove(evictKey);
            if (minFreqKeys.isEmpty()) freqToKeys.remove(minFreq);
            keyToVal.remove(evictKey);
            keyToFreq.remove(evictKey);
        }

        keyToVal.put(key, value);
        keyToFreq.put(key, 1);
        freqToKeys.computeIfAbsent(1, k -> new LinkedHashSet<>()).add(key);
        minFreq = 1;  // new key always has frequency 1
    }

    private void increaseFreq(int key) {
        int freq = keyToFreq.get(key);
        keyToFreq.put(key, freq + 1);

        freqToKeys.get(freq).remove(key);
        if (freqToKeys.get(freq).isEmpty()) {
            freqToKeys.remove(freq);
            if (minFreq == freq) minFreq++;
        }

        freqToKeys.computeIfAbsent(freq + 1, k -> new LinkedHashSet<>()).add(key);
    }
}
```

### Count-Min Sketch Problems

**P09.30** [M] — Implement Heavy Hitter Detection

Given a stream of integers, find all elements that appear more than N/K times using a Count-Min Sketch.

```java
/*
 * Approach: Use a Count-Min Sketch to estimate frequencies.
 * Periodically scan tracked candidates to identify heavy hitters
 * (elements whose estimated frequency exceeds the threshold).
 *
 * See HeavyHitterDetector implementation in Section 9.8.
 *
 * Time: O(d) per observation, O(candidates * d) per heavy hitter query.
 * Space: O(d * w) for the sketch + O(maxCandidates) for tracking.
 */
// See implementation in Section 9.8.
```

### Consistent Hashing Problems

**P09.31** [M] — Implement Consistent Hashing Ring

Implement a consistent hashing ring with virtual nodes, server addition/removal, and key lookup.

```java
/*
 * Approach: See full implementation in Section 9.9.
 * Key data structure: TreeMap<Integer, String> where keys are hash positions
 * and values are server identifiers. TreeMap.ceilingEntry() provides O(log n)
 * clockwise lookup.
 *
 * Time: addServer O(V log(N*V)), getServer O(log(N*V)).
 * Space: O(N * V).
 */
// See ConsistentHashRing implementation in Section 9.9.
```

**P09.32** [M] — Simulate Key Redistribution

Given servers and keys, simulate adding and removing servers to observe how many keys need to move.

```java
/*
 * Approach: Use the ConsistentHashRing. Record key→server mappings before
 * and after a server change. Count differences.
 *
 * Expected result: adding 1 server to N servers moves ~K/(N+1) keys.
 * Removing 1 server from N servers moves ~K/N keys.
 *
 * Verify these expectations empirically with different V (virtual nodes).
 * Higher V → more even distribution → actual redistribution closer to ideal.
 */
class KeyRedistributionSimulation {
    public static void main(String[] args) {
        ConsistentHashRing ring = new ConsistentHashRing(150);
        ring.addServer("server-A");
        ring.addServer("server-B");
        ring.addServer("server-C");

        // Assign 10000 keys
        String[] keys = new String[10000];
        Map<String, String> before = new HashMap<>();
        for (int i = 0; i < 10000; i++) {
            keys[i] = "key-" + i;
            before.put(keys[i], ring.getServer(keys[i]));
        }

        // Add a new server
        ring.addServer("server-D");

        int moved = 0;
        for (String key : keys) {
            String after = ring.getServer(key);
            if (!after.equals(before.get(key))) moved++;
        }

        System.out.printf("Keys moved: %d / %d (%.1f%%)%n", moved, keys.length,
            100.0 * moved / keys.length);
        System.out.printf("Expected: ~%.1f%% (1/%d)%n", 100.0 / 4, 4);
        // Expected: ~25% (1/4). Actual should be close with V=150.
    }
}
```

### Combined/Design Problems

**P09.33** [H] — Design Search Autocomplete System (Trie + Priority Queue)

Design a system where the user types characters one at a time, and after each character, the system returns the top K most frequent completions matching the typed prefix.

```java
/*
 * This is a more scalable version of P09.08. Instead of storing all sentences
 * at every trie node (which is O(N*L) space), we store only the top K
 * at each node.
 *
 * Approach:
 * 1. Build a trie where each node stores a min-heap of top K (sentence, freq) pairs.
 * 2. On insert: walk the trie, at each node update the top-K heap.
 * 3. On query: walk to the prefix node, return its top K.
 *
 * Time: insert O(L * K), query O(P) where P = prefix length.
 * Space: O(N * L * K) for trie with top-K at each node.
 *
 * Production optimization: for billions of queries, shard the trie by first
 * 2-3 characters. Each shard fits in memory on one server. Use consistent
 * hashing to route prefix queries to the right shard.
 */
class SearchAutocomplete {
    private static class TrieNode {
        Map<Character, TrieNode> children = new HashMap<>();
        // Min-heap of (frequency, sentence) — min-heap so we can evict the lowest-freq entry
        PriorityQueue<int[]> topK; // store indices into a sentence list
        List<Map.Entry<String, Integer>> topEntries = new ArrayList<>();
    }

    private final TrieNode root = new TrieNode();
    private final Map<String, Integer> freqMap = new HashMap<>();
    private final int k;

    public SearchAutocomplete(int k) {
        this.k = k;
    }

    public void addSentence(String sentence, int frequency) {
        freqMap.merge(sentence, frequency, Integer::sum);
        int freq = freqMap.get(sentence);

        TrieNode node = root;
        for (char c : sentence.toCharArray()) {
            node.children.putIfAbsent(c, new TrieNode());
            node = node.children.get(c);
            updateTopK(node, sentence, freq);
        }
    }

    private void updateTopK(TrieNode node, String sentence, int freq) {
        // Remove old entry for this sentence if present
        node.topEntries.removeIf(e -> e.getKey().equals(sentence));
        node.topEntries.add(Map.entry(sentence, freq));
        // Sort by freq desc, then lex asc
        node.topEntries.sort((a, b) -> a.getValue().equals(b.getValue())
            ? a.getKey().compareTo(b.getKey())
            : b.getValue() - a.getValue());
        // Keep only top K
        if (node.topEntries.size() > k) {
            node.topEntries = new ArrayList<>(node.topEntries.subList(0, k));
        }
    }

    public List<String> query(String prefix) {
        TrieNode node = root;
        for (char c : prefix.toCharArray()) {
            node = node.children.get(c);
            if (node == null) return Collections.emptyList();
        }
        List<String> result = new ArrayList<>();
        for (Map.Entry<String, Integer> entry : node.topEntries) {
            result.add(entry.getKey());
        }
        return result;
    }
}
```

**P09.34** [H] — Design a Distributed Cache (Consistent Hashing + LRU)

Design a distributed cache system with N nodes, where keys are distributed using consistent hashing and each node maintains an LRU cache.

```java
/*
 * Architecture:
 *
 *   Client
 *     |
 *     v
 *   ConsistentHashRing  ──→  Node-A [LRU Cache, capacity=1000]
 *     (with virtual nodes)    Node-B [LRU Cache, capacity=1000]
 *                              Node-C [LRU Cache, capacity=1000]
 *
 * get(key):
 *   1. Hash key → find responsible node via consistent hash ring
 *   2. Forward request to that node
 *   3. Node checks its LRU cache → hit or miss
 *
 * put(key, value):
 *   1. Hash key → find responsible node
 *   2. Store in that node's LRU cache
 *
 * Adding a node:
 *   1. Add to consistent hash ring
 *   2. ~1/(N+1) of keys naturally migrate (lazy: on next access, the old node
 *      will not have the key, so client fetches from origin and stores on new node)
 *
 * Removing a node:
 *   1. Remove from ring
 *   2. Keys that were on this node are lost from cache (cold miss)
 *   3. Next access fetches from origin and stores on the new responsible node
 *
 * Replication: each key is stored on R consecutive nodes on the ring.
 *   Read: try the primary node; on miss, try replicas.
 *   Write: write to primary and asynchronously replicate to R-1 replicas.
 */
class DistributedCache<K, V> {

    private final ConsistentHashRing ring;
    private final Map<String, LRUCache<K, V>> nodeCaches;
    private final int cacheCapacityPerNode;

    public DistributedCache(List<String> nodes, int virtualNodesPerServer,
                            int cacheCapacityPerNode) {
        this.ring = new ConsistentHashRing(virtualNodesPerServer);
        this.nodeCaches = new HashMap<>();
        this.cacheCapacityPerNode = cacheCapacityPerNode;

        for (String node : nodes) {
            ring.addServer(node);
            nodeCaches.put(node, new LRUCache<>(cacheCapacityPerNode));
        }
    }

    public V get(K key) {
        String node = ring.getServer(key.toString());
        LRUCache<K, V> cache = nodeCaches.get(node);
        return cache.get(key);
    }

    public void put(K key, V value) {
        String node = ring.getServer(key.toString());
        LRUCache<K, V> cache = nodeCaches.get(node);
        cache.put(key, value);
    }

    public void addNode(String node) {
        ring.addServer(node);
        nodeCaches.put(node, new LRUCache<>(cacheCapacityPerNode));
        // Keys will lazily migrate on next access
    }

    public void removeNode(String node) {
        ring.removeServer(node);
        nodeCaches.remove(node);
        // Keys on this node are lost; next access will cache-miss and re-fetch
    }
}
```

### Additional Easy Problems

**P09.35** [E] — Trie: Count Words With Prefix

Given a trie, count how many words have a given prefix.

```java
/*
 * Approach: Walk to the prefix node, then DFS to count all isEnd nodes below.
 * Optimization: maintain a count at each node during insert.
 *
 * Time: O(P) with count stored per node.
 */
class CountWordsWithPrefix {
    private final int[][] children = new int[100001][26];
    private final int[] prefixCount = new int[100001];
    private int cnt = 1;

    { for (int[] row : children) Arrays.fill(row, -1); }

    public void insert(String word) {
        int curr = 0;
        for (char c : word.toCharArray()) {
            int idx = c - 'a';
            if (children[curr][idx] == -1) children[curr][idx] = cnt++;
            curr = children[curr][idx];
            prefixCount[curr]++;
        }
    }

    public int countPrefix(String prefix) {
        int curr = 0;
        for (char c : prefix.toCharArray()) {
            int idx = c - 'a';
            if (children[curr][idx] == -1) return 0;
            curr = children[curr][idx];
        }
        return prefixCount[curr];
    }
}
```

**P09.36** [E] — Union-Find: Is Graph Connected?

Given N nodes and edges, determine if the graph is fully connected.

```java
/*
 * Approach: Union all edges. Check if component count == 1.
 * Time: O(E * alpha(N)).
 */
class IsGraphConnected {
    public boolean isConnected(int n, int[][] edges) {
        int[] parent = new int[n];
        for (int i = 0; i < n; i++) parent[i] = i;
        int components = n;

        for (int[] edge : edges) {
            int a = find(parent, edge[0]), b = find(parent, edge[1]);
            if (a != b) { parent[a] = b; components--; }
        }
        return components == 1;
    }

    private int find(int[] p, int x) {
        while (p[x] != x) { p[x] = p[p[x]]; x = p[x]; }
        return x;
    }
}
```

**P09.37** [E] — Fenwick Tree: Single Element Query

Given a Fenwick tree built from an array, retrieve the value of a single element (not prefix sum).

```java
/*
 * Approach: rangeSum(i, i) = prefixSum(i) - prefixSum(i - 1).
 * Time: O(log n).
 *
 * Alternative O(1) approach: maintain the original array alongside the BIT.
 */
class SingleElementQuery {
    public int getElement(FenwickTree bit, int i) {
        return bit.rangeSum(i, i);
    }
}
```

**P09.38** [E] — Bloom Filter: Membership Check for URL Shortener

Use a Bloom filter to quickly check if a shortened URL has already been assigned.

```java
/*
 * Approach: Before generating a new short URL, check the Bloom filter.
 * If "definitely not present," the short URL is available. If "maybe present,"
 * check the database.
 *
 * This avoids a database query for most URL generation attempts (assuming
 * the URL space is large and collisions are rare).
 *
 * Time: O(k) for Bloom check, O(1) amortized with low FP rate.
 */
class URLShortenerBloom {
    private final BloomFilter<String> filter;

    public URLShortenerBloom(int expectedURLs) {
        filter = new BloomFilter<>(expectedURLs, 0.001);
    }

    public boolean mightExist(String shortUrl) {
        return filter.mightContain(shortUrl);
    }

    public void register(String shortUrl) {
        filter.insert(shortUrl);
    }
}
```

**P09.39** [E] — LRU Cache: Basic Operations Trace

Trace the state of an LRU cache (capacity 3) after a sequence of operations.

```java
/*
 * Operations: put(1,1), put(2,2), put(3,3), get(1), put(4,4), get(2)
 *
 * After put(1,1): [1]
 * After put(2,2): [2, 1]          (2 is most recent)
 * After put(3,3): [3, 2, 1]       (full)
 * After get(1):   [1, 3, 2]       (1 moved to front)
 * After put(4,4): [4, 1, 3]       (2 evicted — it was LRU)
 * After get(2):   returns -1       (2 was evicted)
 *               list unchanged: [4, 1, 3]
 */
```

**P09.40** [E] — Consistent Hashing: Identify Server for Key

Given three servers at hash positions 100, 200, 300 on a ring of size 360, determine which server handles keys with hash values 50, 150, 250, 350.

```java
/*
 * Ring:   0 --- 100(A) --- 200(B) --- 300(C) --- 360/0
 *
 * Key hash 50:  → first server clockwise = A (at 100)
 * Key hash 150: → first server clockwise = B (at 200)
 * Key hash 250: → first server clockwise = C (at 300)
 * Key hash 350: → wrap around → A (at 100)
 *
 * Server A handles: (300, 100] → hashes 301-360 and 0-100
 * Server B handles: (100, 200] → hashes 101-200
 * Server C handles: (200, 300] → hashes 201-300
 */
```

**P09.41** [E] — Segment Tree: Build and Single Query

Build a segment tree from [1, 3, 5, 7, 9, 11] and query the sum of range [1, 3].

```java
/*
 * Array: [1, 3, 5, 7, 9, 11]   (indices 0-5)
 *
 * Segment tree (sum):
 *                [36]                    (sum of [0..5])
 *             /        \
 *          [9]          [27]             (sum of [0..2], [3..5])
 *         /   \        /    \
 *       [4]   [5]   [16]   [11]         (sum of [0..1],[2..2],[3..4],[5..5])
 *      / \         / \
 *    [1] [3]     [7] [9]
 *
 * Query sum(1, 3):
 *   = arr[1] + arr[2] + arr[3]
 *   = 3 + 5 + 7 = 15
 *
 * Tree traversal: root covers [0,5]. We need [1,3].
 *   Left child [0,2]: partially overlaps [1,3] → recurse
 *     Left child [0,1]: partially overlaps → recurse
 *       [0,0]: outside → return 0
 *       [1,1]: inside → return 3
 *     [2,2]: inside → return 5
 *   Right child [3,5]: partially overlaps → recurse
 *     [3,4]: partially overlaps → recurse
 *       [3,3]: inside → return 7
 *       [4,4]: outside → return 0
 *     [5,5]: outside → return 0
 *   Total: 3 + 5 + 7 = 15  ✓
 */
```

### Additional Medium Problems

**P09.42** [M] — Trie: Word Frequency Counter

Build a trie that not only stores words but counts their frequency. Return the K most frequent words with a given prefix.

```java
/*
 * Approach: Each trie end-node stores a frequency count. For top-K prefix query,
 * navigate to the prefix node, then DFS collecting all (word, freq) pairs,
 * and use a min-heap of size K to keep the top K.
 *
 * Time: O(P + N * log K) where P = prefix length, N = words under the prefix.
 * Space: O(total characters + K).
 */
class TrieWithFrequency {
    private static class TrieNode {
        TrieNode[] children = new TrieNode[26];
        int frequency;
    }

    private final TrieNode root = new TrieNode();

    public void insert(String word) {
        TrieNode curr = root;
        for (char c : word.toCharArray()) {
            int i = c - 'a';
            if (curr.children[i] == null) curr.children[i] = new TrieNode();
            curr = curr.children[i];
        }
        curr.frequency++;
    }

    public List<String> topKWithPrefix(String prefix, int k) {
        TrieNode node = root;
        for (char c : prefix.toCharArray()) {
            int i = c - 'a';
            if (node.children[i] == null) return Collections.emptyList();
            node = node.children[i];
        }
        // Min-heap: (frequency, word) — evict lowest frequency to keep top K
        PriorityQueue<Map.Entry<String, Integer>> pq = new PriorityQueue<>(
            Comparator.comparingInt(Map.Entry::getValue));
        collectWords(node, new StringBuilder(prefix), pq, k);

        LinkedList<String> result = new LinkedList<>();
        while (!pq.isEmpty()) result.addFirst(pq.poll().getKey());
        return result;
    }

    private void collectWords(TrieNode node, StringBuilder path,
                              PriorityQueue<Map.Entry<String, Integer>> pq, int k) {
        if (node.frequency > 0) {
            pq.offer(Map.entry(path.toString(), node.frequency));
            if (pq.size() > k) pq.poll();
        }
        for (int i = 0; i < 26; i++) {
            if (node.children[i] != null) {
                path.append((char) ('a' + i));
                collectWords(node.children[i], path, pq, k);
                path.deleteCharAt(path.length() - 1);
            }
        }
    }
}
```

**P09.43** [M] — Segment Tree: Range Max with Point Update

Build a segment tree for range maximum query with point updates.

```java
/*
 * Approach: Identical to sum segment tree, but merge is max instead of +,
 * and identity element is Integer.MIN_VALUE instead of 0.
 *
 * Time: build O(n), update O(log n), query O(log n).
 */
class RangeMaxSegTree {
    private final int[] tree;
    private final int n;

    public RangeMaxSegTree(int[] arr) {
        n = arr.length;
        tree = new int[4 * n];
        Arrays.fill(tree, Integer.MIN_VALUE);
        build(arr, 1, 0, n - 1);
    }

    private void build(int[] arr, int node, int s, int e) {
        if (s == e) { tree[node] = arr[s]; return; }
        int mid = s + (e - s) / 2;
        build(arr, 2 * node, s, mid);
        build(arr, 2 * node + 1, mid + 1, e);
        tree[node] = Math.max(tree[2 * node], tree[2 * node + 1]);
    }

    public void update(int idx, int val) { update(1, 0, n - 1, idx, val); }

    private void update(int node, int s, int e, int idx, int val) {
        if (s == e) { tree[node] = val; return; }
        int mid = s + (e - s) / 2;
        if (idx <= mid) update(2 * node, s, mid, idx, val);
        else update(2 * node + 1, mid + 1, e, idx, val);
        tree[node] = Math.max(tree[2 * node], tree[2 * node + 1]);
    }

    public int rangeMax(int l, int r) { return query(1, 0, n - 1, l, r); }

    private int query(int node, int s, int e, int l, int r) {
        if (r < s || e < l) return Integer.MIN_VALUE;
        if (l <= s && e <= r) return tree[node];
        int mid = s + (e - s) / 2;
        return Math.max(query(2 * node, s, mid, l, r),
                        query(2 * node + 1, mid + 1, e, l, r));
    }
}
```

**P09.44** [M] — Fenwick Tree: Point Query After Range Updates

Support range updates (add delta to all elements in [l, r]) and point queries (what is the value at index i?) using a Fenwick tree.

```java
/*
 * Approach: Use the BIT to store the difference array.
 * Range update [l, r] by delta: update(l, +delta), update(r+1, -delta).
 * Point query at i: prefixSum(i) gives the current value.
 *
 * This is the dual of the standard BIT (which supports point updates + prefix queries).
 *
 * Time: O(log n) for both range update and point query.
 * Space: O(n).
 */
class RangeUpdatePointQuery {
    private final int[] bit;
    private final int n;

    public RangeUpdatePointQuery(int n) {
        this.n = n;
        this.bit = new int[n + 2];
    }

    public void rangeUpdate(int l, int r, int delta) {
        update(l, delta);
        update(r + 1, -delta);
    }

    public int pointQuery(int i) {
        return prefixSum(i);
    }

    private void update(int i, int delta) {
        while (i <= n) { bit[i] += delta; i += i & (-i); }
    }

    private int prefixSum(int i) {
        int sum = 0;
        while (i > 0) { sum += bit[i]; i -= i & (-i); }
        return sum;
    }
}
```

**P09.45** [M] — Union-Find with Dynamic Node Creation

Implement Union-Find where nodes are not numbered 0..N-1 but are arbitrary strings.

```java
/*
 * Approach: Use HashMap<String, String> for parent mapping instead of int[].
 * On first find(x), if x is not in the map, add it with parent[x] = x.
 *
 * Time: O(alpha(N)) per operation (amortized).
 * Space: O(N) where N = number of unique elements.
 */
class StringUnionFind {
    private final Map<String, String> parent = new HashMap<>();
    private final Map<String, Integer> rank = new HashMap<>();

    public String find(String x) {
        parent.putIfAbsent(x, x);
        rank.putIfAbsent(x, 0);
        if (!parent.get(x).equals(x)) {
            parent.put(x, find(parent.get(x)));
        }
        return parent.get(x);
    }

    public void union(String a, String b) {
        String ra = find(a), rb = find(b);
        if (ra.equals(rb)) return;
        int rankA = rank.get(ra), rankB = rank.get(rb);
        if (rankA < rankB) parent.put(ra, rb);
        else if (rankA > rankB) parent.put(rb, ra);
        else { parent.put(rb, ra); rank.put(ra, rankA + 1); }
    }

    public boolean connected(String a, String b) {
        return find(a).equals(find(b));
    }
}
```

**P09.46** [M] — Bloom Filter with Counting (Support Deletion)

Extend the Bloom filter to support deletion by using counters instead of single bits.

```java
/*
 * Approach: Instead of a bit array, use an int array (or byte array for space).
 * Insert: increment counters at k positions.
 * Delete: decrement counters at k positions.
 * Query: check if all k counters are > 0.
 *
 * Trade-off: 4x more memory (int vs bit per slot), but supports deletion.
 * Risk: false negatives if a counter underflows due to deletion of an element
 * that was never inserted. Guard against this.
 *
 * Time: O(k) per operation.
 * Space: O(m * 4) bytes for int counters (vs m/8 bytes for BitSet).
 */
class CountingBloomFilter<T> {
    private final int[] counters;
    private final int m, k;

    public CountingBloomFilter(int expectedElements, double fpRate) {
        this.m = (int) Math.ceil(-expectedElements * Math.log(fpRate) / (Math.log(2) * Math.log(2)));
        this.k = Math.max(1, (int) Math.round((double) m / expectedElements * Math.log(2)));
        this.counters = new int[m];
    }

    public void insert(T element) {
        int h1 = element.hashCode(), h2 = spread(h1);
        for (int i = 0; i < k; i++) {
            int idx = Math.floorMod(h1 + i * h2, m);
            counters[idx]++;
        }
    }

    public void delete(T element) {
        if (!mightContain(element)) return;  // guard against underflow
        int h1 = element.hashCode(), h2 = spread(h1);
        for (int i = 0; i < k; i++) {
            int idx = Math.floorMod(h1 + i * h2, m);
            if (counters[idx] > 0) counters[idx]--;
        }
    }

    public boolean mightContain(T element) {
        int h1 = element.hashCode(), h2 = spread(h1);
        for (int i = 0; i < k; i++) {
            int idx = Math.floorMod(h1 + i * h2, m);
            if (counters[idx] == 0) return false;
        }
        return true;
    }

    private int spread(int hash) {
        hash ^= (hash >>> 16); hash *= 0x85ebca6b;
        hash ^= (hash >>> 13); hash *= 0xc2b2ae35;
        hash ^= (hash >>> 16); return hash;
    }
}
```

**P09.47** [M] — LRU Cache with Expiry

Extend the LRU cache to support time-based expiration. Entries expire after a configurable TTL.

```java
/*
 * Approach: Add a timestamp to each node. On get(), check if the entry has
 * expired. If yes, remove it and return null. Optionally, run periodic cleanup.
 *
 * In production (Caffeine, Guava Cache), expiration is handled by a
 * time-ordered queue that is lazily cleaned during access.
 *
 * Time: O(1) for get/put (amortized cleanup is O(expired entries)).
 * Space: O(capacity).
 */
class LRUCacheWithExpiry<K, V> {
    private static class Node<K, V> {
        K key; V value;
        long expiresAt;
        Node<K, V> prev, next;
        Node(K key, V value, long expiresAt) {
            this.key = key; this.value = value; this.expiresAt = expiresAt;
        }
        Node() {}
    }

    private final int capacity;
    private final long ttlMillis;
    private final Map<K, Node<K, V>> map = new HashMap<>();
    private final Node<K, V> head = new Node<>(), tail = new Node<>();
    private int size;

    public LRUCacheWithExpiry(int capacity, long ttlMillis) {
        this.capacity = capacity;
        this.ttlMillis = ttlMillis;
        head.next = tail;
        tail.prev = head;
    }

    public V get(K key) {
        Node<K, V> node = map.get(key);
        if (node == null) return null;
        if (System.currentTimeMillis() > node.expiresAt) {
            removeNode(node);
            map.remove(key);
            size--;
            return null;
        }
        removeNode(node);
        addToFront(node);
        return node.value;
    }

    public void put(K key, V value) {
        Node<K, V> existing = map.get(key);
        if (existing != null) {
            removeNode(existing);
            size--;
        }
        Node<K, V> node = new Node<>(key, value, System.currentTimeMillis() + ttlMillis);
        map.put(key, node);
        addToFront(node);
        size++;
        if (size > capacity) {
            Node<K, V> evicted = tail.prev;
            removeNode(evicted);
            map.remove(evicted.key);
            size--;
        }
    }

    private void removeNode(Node<K, V> n) { n.prev.next = n.next; n.next.prev = n.prev; }
    private void addToFront(Node<K, V> n) {
        n.prev = head; n.next = head.next;
        head.next.prev = n; head.next = n;
    }
}
```

**P09.48** [M] — Skip List: Range Query

Implement a range query on a skip list: return all elements in [lo, hi].

```java
/*
 * Approach: Search for 'lo' to find the starting position at level 0.
 * Then walk forward at level 0, collecting elements until we exceed 'hi'.
 *
 * Time: O(log n + k) where k = number of elements in [lo, hi].
 * Space: O(k) for the result.
 *
 * This is the same principle as TreeMap.subMap() — O(log n) to find the start,
 * then O(k) sequential traversal. Skip list level 0 is a sorted linked list.
 */
class SkipListRangeQuery {
    // Assuming we have a SkipList instance 'skipList'
    public List<Integer> rangeQuery(SkipList<Integer, Integer> skipList, int lo, int hi) {
        // In a real implementation, expose a method that returns the node at or after 'lo'
        // Then iterate forward at level 0 until > hi
        // This is conceptually: skipList.subMap(lo, hi)
        List<Integer> result = new ArrayList<>();
        // ... walk level-0 forward pointers collecting values ...
        return result;
    }
}
```

**P09.49** [M] — Count-Min Sketch: Frequency Comparison

Use a Count-Min Sketch to answer "which of two elements appears more frequently?" in a data stream.

```java
/*
 * Approach: Insert all stream elements into the sketch. For comparison,
 * estimate(a) vs estimate(b). The one with the higher estimate is likely
 * more frequent.
 *
 * Caveat: both estimates have upward bias from collisions. If the estimates
 * are close, the comparison may be wrong. The error bound is epsilon*N.
 * If |estimate(a) - estimate(b)| > 2*epsilon*N, the comparison is reliable.
 *
 * Time: O(d) per query.
 */
class FrequencyComparison {
    private final CountMinSketch sketch;

    public FrequencyComparison(double epsilon, double delta) {
        sketch = new CountMinSketch(epsilon, delta);
    }

    public void observe(Object element) {
        sketch.update(element);
    }

    /**
     * Returns the element estimated to be more frequent.
     * Returns null if estimates are too close to be reliable.
     */
    public Object moreFrequent(Object a, Object b, double reliabilityThreshold) {
        int estA = sketch.estimate(a);
        int estB = sketch.estimate(b);
        long threshold = (long) (sketch.getTotalCount() * reliabilityThreshold);
        if (Math.abs(estA - estB) < threshold) return null;  // too close to call
        return estA >= estB ? a : b;
    }
}
```

**P09.50** [M] — Consistent Hashing: Hot Spot Mitigation

Modify the consistent hashing ring to handle hot keys by replicating them across multiple servers.

```java
/*
 * Approach: For identified hot keys, replicate them to the next R servers
 * clockwise on the ring. Reads for hot keys are load-balanced across
 * all R replicas using round-robin or random selection.
 *
 * Detection: use a Count-Min Sketch to identify hot keys.
 * Mitigation: replicate hot keys to R servers instead of just 1.
 *
 * This is exactly what Amazon's DynamoDB Adaptive Capacity does:
 * detect hot partitions and replicate them across more nodes.
 */
class HotSpotMitigatedCache {
    private final ConsistentHashRing ring;
    private final CountMinSketch accessSketch;
    private final long hotThreshold;
    private final int replicationFactor;
    private final Random random = new Random();

    public HotSpotMitigatedCache(ConsistentHashRing ring, long hotThreshold, int replicationFactor) {
        this.ring = ring;
        this.accessSketch = new CountMinSketch(0.01, 0.001);
        this.hotThreshold = hotThreshold;
        this.replicationFactor = replicationFactor;
    }

    public String getServerForKey(String key) {
        accessSketch.update(key);
        int estimatedFreq = accessSketch.estimate(key);

        if (estimatedFreq > hotThreshold) {
            // Hot key — distribute across replicas
            List<String> servers = ring.getServersForKey(key, replicationFactor);
            return servers.get(random.nextInt(servers.size()));
        }
        return ring.getServer(key);
    }
}
```

### Additional Hard Problems

**P09.51** [H] — Trie: Maximum XOR of Two Numbers

Given an array of non-negative integers, find the maximum XOR of any two elements.

```java
/*
 * Approach: Build a binary trie of all numbers (most significant bit first).
 * For each number, greedily walk the trie choosing the OPPOSITE bit at each
 * level (to maximize XOR). If the opposite bit does not exist, take the same bit.
 *
 * XOR is maximized when bits differ. So at each bit position, we want to go
 * the opposite direction from the current number's bit.
 *
 * Time: O(n * 32) = O(n).
 * Space: O(n * 32) = O(n) for the trie.
 */
class MaxXOR {
    public int findMaximumXOR(int[] nums) {
        // Build binary trie
        int[][] children = new int[nums.length * 32 + 1][2];
        for (int[] row : children) Arrays.fill(row, -1);
        int cnt = 1;

        // Insert all numbers
        for (int num : nums) {
            int curr = 0;
            for (int bit = 31; bit >= 0; bit--) {
                int b = (num >> bit) & 1;
                if (children[curr][b] == -1) children[curr][b] = cnt++;
                curr = children[curr][b];
            }
        }

        // For each number, find the max XOR partner
        int maxXor = 0;
        for (int num : nums) {
            int curr = 0;
            int xorVal = 0;
            for (int bit = 31; bit >= 0; bit--) {
                int b = (num >> bit) & 1;
                int want = 1 - b;  // opposite bit
                if (children[curr][want] != -1) {
                    xorVal |= (1 << bit);
                    curr = children[curr][want];
                } else {
                    curr = children[curr][b];
                }
            }
            maxXor = Math.max(maxXor, xorVal);
        }
        return maxXor;
    }
}
```

**P09.52** [H] — Segment Tree: Merge Sort Tree (Count Elements in Range)

Given an array, answer queries "how many elements in arr[l..r] are less than or equal to K?"

```java
/*
 * Approach: Merge Sort Tree — a segment tree where each node stores the sorted
 * subarray for its range. Query: walk the segment tree, at each matching node,
 * binary search for K to count elements <= K.
 *
 * Build: O(n log n) (merging sorted subarrays).
 * Query: O(log^2 n) — O(log n) nodes visited, O(log n) binary search per node.
 * Space: O(n log n) — each element appears in O(log n) nodes.
 */
class MergeSortTree {
    private final int[][] tree;
    private final int n;

    public MergeSortTree(int[] arr) {
        n = arr.length;
        tree = new int[4 * n][];
        build(arr, 1, 0, n - 1);
    }

    private void build(int[] arr, int node, int s, int e) {
        if (s == e) {
            tree[node] = new int[]{arr[s]};
            return;
        }
        int mid = s + (e - s) / 2;
        build(arr, 2 * node, s, mid);
        build(arr, 2 * node + 1, mid + 1, e);
        tree[node] = merge(tree[2 * node], tree[2 * node + 1]);
    }

    private int[] merge(int[] a, int[] b) {
        int[] result = new int[a.length + b.length];
        int i = 0, j = 0, k = 0;
        while (i < a.length && j < b.length)
            result[k++] = a[i] <= b[j] ? a[i++] : b[j++];
        while (i < a.length) result[k++] = a[i++];
        while (j < b.length) result[k++] = b[j++];
        return result;
    }

    public int countLessOrEqual(int l, int r, int k) {
        return query(1, 0, n - 1, l, r, k);
    }

    private int query(int node, int s, int e, int l, int r, int k) {
        if (r < s || e < l) return 0;
        if (l <= s && e <= r) {
            // Binary search for count of elements <= k
            int lo = 0, hi = tree[node].length;
            while (lo < hi) {
                int mid = (lo + hi) / 2;
                if (tree[node][mid] <= k) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        }
        int mid = s + (e - s) / 2;
        return query(2 * node, s, mid, l, r, k)
             + query(2 * node + 1, mid + 1, e, l, r, k);
    }
}
```

**P09.53** [H] — Union-Find: Number of Islands II (Online)

Starting with an m x n grid of water, process a list of land additions. After each addition, return the number of islands.

```java
/*
 * Approach: Union-Find with dynamic island creation.
 * For each new land cell, create a new component. Then check all 4 neighbors:
 * if a neighbor is also land, union them. Track the component count.
 *
 * This is the classic online connectivity problem — DFS would require
 * re-scanning the grid after each addition (O(M*N) per operation).
 * Union-Find handles it in O(alpha(M*N)) per addition.
 *
 * Time: O(K * alpha(M*N)) where K = number of additions.
 * Space: O(M * N).
 */
class NumberOfIslandsII {
    public List<Integer> numIslands2(int m, int n, int[][] positions) {
        int[] parent = new int[m * n];
        int[] rank = new int[m * n];
        Arrays.fill(parent, -1);
        int components = 0;
        int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
        List<Integer> result = new ArrayList<>();

        for (int[] pos : positions) {
            int r = pos[0], c = pos[1], id = r * n + c;
            if (parent[id] != -1) {
                result.add(components);  // already land
                continue;
            }
            parent[id] = id;
            components++;

            for (int[] d : dirs) {
                int nr = r + d[0], nc = c + d[1], nid = nr * n + nc;
                if (nr >= 0 && nr < m && nc >= 0 && nc < n && parent[nid] != -1) {
                    int a = find(parent, id), b = find(parent, nid);
                    if (a != b) {
                        if (rank[a] < rank[b]) parent[a] = b;
                        else if (rank[a] > rank[b]) parent[b] = a;
                        else { parent[b] = a; rank[a]++; }
                        components--;
                    }
                }
            }
            result.add(components);
        }
        return result;
    }

    private int find(int[] p, int x) {
        while (p[x] != x) { p[x] = p[p[x]]; x = p[x]; }
        return x;
    }
}
```

**P09.54** [H] — Persistent Segment Tree

Implement a segment tree that supports versioning: after each update, you can query any previous version of the tree.

```java
/*
 * Approach: On each update, create new nodes only along the path from root
 * to the updated leaf (O(log n) new nodes). Old versions remain intact
 * because we never modify existing nodes.
 *
 * Each version has its own root. Querying version V uses root[V].
 * Shared structure: nodes not on the update path are shared across versions.
 *
 * Space: O(n) for initial build + O(log n) per update.
 * Time: O(log n) for update and query.
 */
class PersistentSegTree {
    private static final int MAXN = 200001;
    private final int[] left = new int[MAXN * 40];   // left child index
    private final int[] right = new int[MAXN * 40];  // right child index
    private final int[] val = new int[MAXN * 40];    // node value
    private int cnt = 0;
    private final int[] roots;
    private int versionCount = 0;
    private final int n;

    public PersistentSegTree(int[] arr) {
        this.n = arr.length;
        this.roots = new int[MAXN];
        roots[0] = build(arr, 0, n - 1);
    }

    private int build(int[] arr, int s, int e) {
        int node = ++cnt;
        if (s == e) { val[node] = arr[s]; return node; }
        int mid = s + (e - s) / 2;
        left[node] = build(arr, s, mid);
        right[node] = build(arr, mid + 1, e);
        val[node] = val[left[node]] + val[right[node]];
        return node;
    }

    /**
     * Create a new version by updating index idx to newVal.
     * Returns the new version number.
     */
    public int update(int version, int idx, int newVal) {
        versionCount++;
        roots[versionCount] = update(roots[version], 0, n - 1, idx, newVal);
        return versionCount;
    }

    private int update(int prev, int s, int e, int idx, int newVal) {
        int node = ++cnt;
        if (s == e) { val[node] = newVal; return node; }
        int mid = s + (e - s) / 2;
        if (idx <= mid) {
            left[node] = update(left[prev], s, mid, idx, newVal);
            right[node] = right[prev];  // share unchanged subtree
        } else {
            left[node] = left[prev];    // share unchanged subtree
            right[node] = update(right[prev], mid + 1, e, idx, newVal);
        }
        val[node] = val[left[node]] + val[right[node]];
        return node;
    }

    public int query(int version, int l, int r) {
        return query(roots[version], 0, n - 1, l, r);
    }

    private int query(int node, int s, int e, int l, int r) {
        if (node == 0 || r < s || e < l) return 0;
        if (l <= s && e <= r) return val[node];
        int mid = s + (e - s) / 2;
        return query(left[node], s, mid, l, r) + query(right[node], mid + 1, e, l, r);
    }
}
```

**P09.55** [H] — Design an In-Memory Key-Value Store with Bloom + LSM

Design a simplified LSM-tree based key-value store that uses Bloom filters for read optimization.

```java
/*
 * LSM-Tree Architecture:
 *
 *   Write Path:
 *     write(key, value)
 *       → MemTable (in-memory sorted structure — a skip list or TreeMap)
 *       → When MemTable is full, flush to SSTable (sorted, immutable file on disk)
 *
 *   Read Path:
 *     read(key)
 *       → Check MemTable first (most recent writes)
 *       → Check SSTables from newest to oldest:
 *           1. Check Bloom filter → if "definitely not here," skip this SSTable
 *           2. Binary search the SSTable's index → find the value
 *       → First match wins (newest version)
 *
 *   Bloom filter impact: without Bloom filters, each read might scan ALL SSTables.
 *   With Bloom filters (1% FP rate), each SSTable has a 99% chance of being skipped
 *   if the key is not present. For 10 SSTables, the expected unnecessary disk reads
 *   drop from 9 to 0.09.
 *
 * This is exactly how Cassandra, HBase, RocksDB, and LevelDB work.
 */
class SimpleLSMStore {
    private final TreeMap<String, String> memTable = new TreeMap<>();
    private final List<SSTable> ssTables = new ArrayList<>();
    private final int memTableMaxSize;

    public SimpleLSMStore(int memTableMaxSize) {
        this.memTableMaxSize = memTableMaxSize;
    }

    public void put(String key, String value) {
        memTable.put(key, value);
        if (memTable.size() >= memTableMaxSize) {
            flush();
        }
    }

    public String get(String key) {
        // Check memTable first
        if (memTable.containsKey(key)) return memTable.get(key);
        // Check SSTables from newest to oldest
        for (int i = ssTables.size() - 1; i >= 0; i--) {
            SSTable table = ssTables.get(i);
            if (!table.bloomFilter.mightContain(key)) continue;  // Bloom says no → skip
            String value = table.data.get(key);
            if (value != null) return value;
            // Bloom filter false positive — key not in this SSTable
        }
        return null;  // key not found
    }

    private void flush() {
        SSTable table = new SSTable(memTable, memTable.size());
        ssTables.add(table);
        memTable.clear();
    }

    private static class SSTable {
        final Map<String, String> data;  // in reality, this is a sorted file on disk
        final BloomFilter<String> bloomFilter;

        SSTable(Map<String, String> memTable, int size) {
            this.data = new TreeMap<>(memTable);
            this.bloomFilter = new BloomFilter<>(size, 0.01);
            for (String key : data.keySet()) bloomFilter.insert(key);
        }
    }
}
```

**P09.56** [H] — Segment Tree Beats (Ji Driver Segment Tree)

Support range operations: set all elements in [l, r] to min(arr[i], val), and query range max/sum.

```java
/*
 * Approach: Segment Tree Beats — a segment tree that tracks the maximum value,
 * second maximum, and count of maximum. When applying min(arr[i], val):
 * - If val >= max of range: no change.
 * - If secondMax < val < max: update max to val, adjust sum.
 * - If val <= secondMax: recurse into children.
 *
 * This avoids updating every leaf individually, achieving O(n log^2 n) amortized.
 *
 * Time: O(n log^2 n) amortized for all operations.
 * Space: O(n).
 *
 * Used in: competitive programming for complex range modification problems.
 */
class SegmentTreeBeats {
    private final long[] sum;
    private final int[] max, secondMax, maxCount;
    private final int n;

    public SegmentTreeBeats(int[] arr) {
        n = arr.length;
        int sz = 4 * n;
        sum = new long[sz]; max = new int[sz];
        secondMax = new int[sz]; maxCount = new int[sz];
        build(arr, 1, 0, n - 1);
    }

    private void build(int[] arr, int node, int s, int e) {
        if (s == e) {
            sum[node] = max[node] = arr[s];
            secondMax[node] = Integer.MIN_VALUE;
            maxCount[node] = 1;
            return;
        }
        int mid = s + (e - s) / 2;
        build(arr, 2 * node, s, mid);
        build(arr, 2 * node + 1, mid + 1, e);
        pushUp(node);
    }

    private void pushUp(int node) {
        int l = 2 * node, r = 2 * node + 1;
        sum[node] = sum[l] + sum[r];
        if (max[l] == max[r]) {
            max[node] = max[l];
            maxCount[node] = maxCount[l] + maxCount[r];
            secondMax[node] = Math.max(secondMax[l], secondMax[r]);
        } else if (max[l] > max[r]) {
            max[node] = max[l];
            maxCount[node] = maxCount[l];
            secondMax[node] = Math.max(secondMax[l], max[r]);
        } else {
            max[node] = max[r];
            maxCount[node] = maxCount[r];
            secondMax[node] = Math.max(max[l], secondMax[r]);
        }
    }

    /** Apply min(arr[i], val) to all elements in [l, r]. */
    public void updateMin(int l, int r, int val) {
        updateMin(1, 0, n - 1, l, r, val);
    }

    private void updateMin(int node, int s, int e, int l, int r, int val) {
        if (l > e || r < s || val >= max[node]) return;
        if (l <= s && e <= r && val > secondMax[node]) {
            applyMin(node, s, e, val);
            return;
        }
        pushDown(node, s, e);
        int mid = s + (e - s) / 2;
        updateMin(2 * node, s, mid, l, r, val);
        updateMin(2 * node + 1, mid + 1, e, l, r, val);
        pushUp(node);
    }

    private void applyMin(int node, int s, int e, int val) {
        sum[node] -= (long)(max[node] - val) * maxCount[node];
        max[node] = val;
    }

    private void pushDown(int node, int s, int e) {
        int l = 2 * node, r = 2 * node + 1;
        int mid = s + (e - s) / 2;
        if (max[node] < max[l]) applyMin(l, s, mid, max[node]);
        if (max[node] < max[r]) applyMin(r, mid + 1, e, max[node]);
    }

    public long querySum(int l, int r) {
        return querySum(1, 0, n - 1, l, r);
    }

    private long querySum(int node, int s, int e, int l, int r) {
        if (l > e || r < s) return 0;
        if (l <= s && e <= r) return sum[node];
        pushDown(node, s, e);
        int mid = s + (e - s) / 2;
        return querySum(2 * node, s, mid, l, r) + querySum(2 * node + 1, mid + 1, e, l, r);
    }
}
```

**P09.57** [H] — Implement a Rate Limiter (Sliding Window + Bloom/CMS)

Design a rate limiter that limits requests per IP to K requests per T seconds, using a Count-Min Sketch for approximate counting.

```java
/*
 * Approach: Sliding window rate limiting with approximate counting.
 *
 * For exact limiting: HashMap<IP, Queue<Timestamp>>. On each request,
 * remove timestamps older than T seconds, check if queue size < K.
 * Problem: O(N) memory where N = number of IPs.
 *
 * For approximate limiting at scale: Count-Min Sketch with time bucketing.
 * Divide time into buckets of size T/B seconds. Maintain B sketches
 * (one per bucket, rotating). Sum of estimates across B buckets gives
 * the approximate count in the last T seconds.
 *
 * Time: O(d * B) per request.
 * Space: O(d * w * B) for the sketches.
 */
class SlidingWindowRateLimiter {
    private final CountMinSketch[] sketches;
    private final long[] bucketStartTimes;
    private final int bucketCount;
    private final long bucketDurationMs;
    private final int maxRequests;
    private int currentBucket;

    public SlidingWindowRateLimiter(int maxRequests, long windowMs, int bucketCount) {
        this.maxRequests = maxRequests;
        this.bucketCount = bucketCount;
        this.bucketDurationMs = windowMs / bucketCount;
        this.sketches = new CountMinSketch[bucketCount];
        this.bucketStartTimes = new long[bucketCount];
        for (int i = 0; i < bucketCount; i++) {
            sketches[i] = new CountMinSketch(0.01, 0.001);
        }
        currentBucket = 0;
    }

    public boolean allowRequest(String ip) {
        long now = System.currentTimeMillis();
        rotateBuckets(now);

        // Estimate total requests in the window
        int total = 0;
        for (CountMinSketch sketch : sketches) {
            total += sketch.estimate(ip);
        }

        if (total >= maxRequests) {
            return false;  // rate limited
        }

        sketches[currentBucket].update(ip);
        return true;
    }

    private void rotateBuckets(long now) {
        long elapsed = now - bucketStartTimes[currentBucket];
        while (elapsed >= bucketDurationMs) {
            currentBucket = (currentBucket + 1) % bucketCount;
            sketches[currentBucket] = new CountMinSketch(0.01, 0.001);
            bucketStartTimes[currentBucket] = now;
            elapsed -= bucketDurationMs;
        }
    }
}
```

**P09.58** [H] — Offline LCA with Union-Find (Tarjan's Algorithm)

Given a tree and a list of queries (u, v), find the Lowest Common Ancestor for each query using Tarjan's offline algorithm.

```java
/*
 * Approach: Tarjan's Offline LCA uses DFS + Union-Find.
 * For each node u during DFS:
 *   1. Process all children recursively.
 *   2. After processing child c, union(c, u).
 *   3. For all queries (u, v) where v has been visited, LCA(u, v) = find(v).
 *
 * The key insight: after DFS finishes a subtree rooted at c and unions c with
 * its parent u, find(c) returns u. So for any already-visited node v, find(v)
 * returns the highest ancestor of v that has been "closed" — which is the LCA.
 *
 * Time: O((N + Q) * alpha(N)) where Q = number of queries.
 * Space: O(N + Q).
 */
class TarjanLCA {
    private int[] parent, rank2;
    private boolean[] visited;
    private int[] ancestor;  // ancestor[find(x)] = the LCA representative
    private int[] lcaResult;

    public int[] offlineLCA(int n, List<List<Integer>> adj, int[][] queries) {
        parent = new int[n]; rank2 = new int[n]; visited = new boolean[n];
        ancestor = new int[n];
        for (int i = 0; i < n; i++) { parent[i] = i; ancestor[i] = i; }

        // Group queries by node
        Map<Integer, List<int[]>> queryMap = new HashMap<>();
        lcaResult = new int[queries.length];
        for (int i = 0; i < queries.length; i++) {
            int u = queries[i][0], v = queries[i][1];
            queryMap.computeIfAbsent(u, k -> new ArrayList<>()).add(new int[]{v, i});
            queryMap.computeIfAbsent(v, k -> new ArrayList<>()).add(new int[]{u, i});
        }

        dfs(0, -1, adj, queryMap);
        return lcaResult;
    }

    private void dfs(int u, int par, List<List<Integer>> adj, Map<Integer, List<int[]>> queryMap) {
        visited[u] = true;
        ancestor[u] = u;

        for (int child : adj.get(u)) {
            if (child == par) continue;
            dfs(child, u, adj, queryMap);
            union(child, u);
            ancestor[find(u)] = u;
        }

        if (queryMap.containsKey(u)) {
            for (int[] q : queryMap.get(u)) {
                int v = q[0], idx = q[1];
                if (visited[v]) {
                    lcaResult[idx] = ancestor[find(v)];
                }
            }
        }
    }

    private int find(int x) {
        while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    }

    private void union(int a, int b) {
        int ra = find(a), rb = find(b);
        if (ra == rb) return;
        if (rank2[ra] < rank2[rb]) parent[ra] = rb;
        else if (rank2[ra] > rank2[rb]) parent[rb] = ra;
        else { parent[rb] = ra; rank2[ra]++; }
    }
}
```

**P09.59** [H] — Implement a Concurrent Bloom Filter

Design a thread-safe Bloom filter using atomic operations (no global lock).

```java
/*
 * Approach: Use AtomicLongArray instead of BitSet. Each bit is in a long.
 * Setting a bit uses CAS: read the long, set the bit, CAS-write.
 * Checking a bit is a volatile read (AtomicLongArray provides this).
 *
 * No locks needed. Insert might have a spurious retry on CAS contention,
 * but this is extremely rare (different keys hit different bit positions).
 *
 * Time: O(k) per operation (same as single-threaded).
 * Space: O(m/64) longs.
 *
 * This is how production Bloom filters (Guava, Apache Commons) work
 * in concurrent environments.
 */
class ConcurrentBloomFilter<T> {
    private final AtomicLongArray bits;
    private final int m, k;

    public ConcurrentBloomFilter(int expectedElements, double fpRate) {
        this.m = (int) Math.ceil(-expectedElements * Math.log(fpRate) / (Math.log(2) * Math.log(2)));
        this.k = Math.max(1, (int) Math.round((double) m / expectedElements * Math.log(2)));
        this.bits = new AtomicLongArray((m + 63) / 64);  // round up to full longs
    }

    public void insert(T element) {
        int h1 = element.hashCode(), h2 = spread(h1);
        for (int i = 0; i < k; i++) {
            int bitIndex = Math.floorMod(h1 + i * h2, m);
            setBit(bitIndex);
        }
    }

    public boolean mightContain(T element) {
        int h1 = element.hashCode(), h2 = spread(h1);
        for (int i = 0; i < k; i++) {
            int bitIndex = Math.floorMod(h1 + i * h2, m);
            if (!getBit(bitIndex)) return false;
        }
        return true;
    }

    private void setBit(int index) {
        int longIndex = index / 64;
        long mask = 1L << (index % 64);
        long current;
        do {
            current = bits.get(longIndex);
            if ((current & mask) != 0) return;  // already set
        } while (!bits.compareAndSet(longIndex, current, current | mask));
    }

    private boolean getBit(int index) {
        int longIndex = index / 64;
        long mask = 1L << (index % 64);
        return (bits.get(longIndex) & mask) != 0;
    }

    private int spread(int hash) {
        hash ^= (hash >>> 16); hash *= 0x85ebca6b;
        hash ^= (hash >>> 13); hash *= 0xc2b2ae35;
        hash ^= (hash >>> 16); return hash;
    }
}
```

**P09.60** [H] — Design a Distributed Rate-Limited Autocomplete (All Structures Combined)

Design a system combining Trie + Consistent Hashing + Bloom Filter + LRU + Count-Min Sketch.

```java
/*
 * Architecture for a production autocomplete service handling 100K QPS:
 *
 *         Client
 *           |
 *      [API Gateway]
 *           |
 *      [Consistent Hash Ring]  — route prefix to the right shard
 *        /       |       \
 *   Shard A   Shard B   Shard C    — each shard owns prefixes by first 2 chars
 *   ┌──────┐
 *   │ Trie │  — in-memory trie for prefix matching
 *   │ LRU  │  — cache hot prefix results (top-K completions)
 *   │ CMS  │  — track query frequency for ranking
 *   │Bloom │  — quick check: "does any completion exist for this prefix?"
 *   └──────┘
 *
 * Request flow:
 *   1. Client types "ap" → API Gateway receives query prefix "ap"
 *   2. ConsistentHashRing.getServer("ap") → routes to Shard B
 *   3. Shard B:
 *      a. Check LRU cache for "ap" → if hit, return cached result
 *      b. Check Bloom filter → if "definitely no completions," return empty
 *      c. Walk trie from "ap" → collect candidate completions
 *      d. Use Count-Min Sketch to rank candidates by estimated frequency
 *      e. Return top K results, cache in LRU
 *   4. On new search logged: update CMS frequency, update trie if new word
 *
 * Scaling:
 *   - Adding a shard: consistent hashing moves ~1/(N+1) prefixes to new shard
 *   - Hot prefixes ("the", "how"): virtual nodes spread load; dedicated cache
 *   - Memory per shard: ~2 GB (trie) + 100 MB (CMS) + 50 MB (Bloom) + LRU
 *
 * This is a simplified version of what Google Search actually runs.
 */
class DistributedAutocomplete {
    // Combines all the structures we have built in this chapter:
    // - ConsistentHashRing for request routing
    // - ArrayTrie for prefix search on each shard
    // - LRUCache for hot prefix caching
    // - CountMinSketch for frequency-based ranking
    // - BloomFilter for quick non-existence checks

    private final ConsistentHashRing ring;
    private final Map<String, ShardNode> shards;

    public DistributedAutocomplete(List<String> shardNames, int virtualNodes) {
        ring = new ConsistentHashRing(virtualNodes);
        shards = new HashMap<>();
        for (String name : shardNames) {
            ring.addServer(name);
            shards.put(name, new ShardNode());
        }
    }

    public List<String> autocomplete(String prefix, int k) {
        String shard = ring.getServer(prefix);
        return shards.get(shard).query(prefix, k);
    }

    public void recordSearch(String query) {
        String shard = ring.getServer(query.substring(0, Math.min(2, query.length())));
        shards.get(shard).recordSearch(query);
    }

    private static class ShardNode {
        private final ArrayTrie trie = new ArrayTrie();
        private final LRUCache<String, List<String>> cache = new LRUCache<>(10000);
        private final CountMinSketch frequencySketch = new CountMinSketch(0.001, 0.001);
        private final BloomFilter<String> prefixBloom = new BloomFilter<>(1_000_000, 0.01);

        public List<String> query(String prefix, int k) {
            // Check cache first
            List<String> cached = cache.get(prefix);
            if (cached != null) return cached;

            // Quick existence check
            if (!prefixBloom.mightContain(prefix) && !trie.startsWith(prefix)) {
                return Collections.emptyList();
            }

            // Get completions and rank by frequency
            List<String> completions = trie.autocomplete(prefix);
            completions.sort((a, b) ->
                frequencySketch.estimate(b) - frequencySketch.estimate(a));
            List<String> result = completions.subList(0, Math.min(k, completions.size()));

            cache.put(prefix, result);
            return result;
        }

        public void recordSearch(String query) {
            trie.insert(query);
            frequencySketch.update(query);
            // Register all prefixes in the bloom filter
            for (int i = 1; i <= query.length(); i++) {
                prefixBloom.insert(query.substring(0, i));
            }
            // Invalidate affected cache entries (simplified)
            for (int i = 1; i <= query.length(); i++) {
                cache.get(query.substring(0, i));  // this just touches it; a real impl would invalidate
            }
        }
    }
}
```

---

## Key Takeaways

1. **The JDK does not ship tries, segment trees, Fenwick trees, Bloom filters, Union-Find, skip lists, or Count-Min Sketches.** Yet every serious distributed system uses at least three of these. Knowing how to build them from scratch is table stakes for senior interviews.

2. **Tries give O(L) operations independent of dataset size.** A HashMap lookup is O(L) average (hashing the string is O(L)) but cannot answer prefix queries. A trie matches this O(L) and adds prefix search, autocomplete, and wildcard matching. The memory trade-off (26 pointers per node for array-based, HashMap overhead per node) is real but manageable for dictionaries of reasonable size.

3. **Segment trees and Fenwick trees solve the range query + point update problem.** If you need only prefix sums with point updates, use a Fenwick tree — it is 20 lines of code with a single int array. For range updates (lazy propagation), range min/max, or more exotic merge operations, use a segment tree.

4. **Union-Find with path compression and union by rank is effectively O(1).** The inverse Ackermann function alpha(N) never exceeds 4 for any input that fits in the universe. Use it whenever you need dynamic connectivity: Kruskal's MST, online island counting, equivalence classes.

5. **Skip lists are balanced BSTs without the rebalancing.** Probabilistic balance via random level assignment gives expected O(log n) with dramatically simpler code than AVL or Red-Black trees. The real win: skip lists are naturally concurrent — ConcurrentSkipListMap is lock-free. Redis chose skip lists for ZSET for exactly this reason.

6. **Bloom filters trade a tiny false positive rate for massive memory savings.** Checking membership in 100 million elements costs 114 MB with a 1% false positive rate. A HashSet for the same data costs multiple gigabytes. Every LSM-tree database (Cassandra, HBase, RocksDB) uses Bloom filters to avoid pointless disk reads.

7. **LRU caches combine HashMap (O(1) lookup) with doubly linked list (O(1) reordering).** The sentinel node pattern eliminates null checks. In production, use Caffeine or Guava Cache — but in interviews, build it from scratch to demonstrate you understand the mechanics.

8. **Count-Min Sketches provide approximate frequency counting in sub-linear space.** The key property: they never underestimate, only overestimate. Use them for heavy hitter detection, rate limiting, and streaming analytics where exact counts are impractical.

9. **Consistent hashing minimizes key redistribution when nodes change.** Adding a node to N existing nodes moves only ~1/(N+1) of keys. Virtual nodes ensure even distribution. This is the load-balancing backbone of DynamoDB, Cassandra, and every CDN.

10. **These structures compose.** The most powerful interview answers and the most robust production systems combine multiple structures: Trie + Count-Min Sketch for ranked autocomplete, Consistent Hashing + LRU for distributed caching, Bloom Filter + LSM-tree for write-optimized storage. Mastering each structure individually lets you compose them fluently.

---

[Previous: Chapter 8 →](08-graphs-and-traversal-algorithms.md) | [Next: Chapter 10 →](10-dynamic-programming-patterns.md)
