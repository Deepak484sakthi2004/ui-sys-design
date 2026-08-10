# Chapter 5: Trees & Sorted Structures

## The Backbone of Ordered Worlds

Every time you call `TreeMap.put()` in Java, a Red-Black tree rotates. Every time MySQL resolves a `WHERE id BETWEEN 100 AND 200`, a B+ Tree walks its leaf chain. Every time your IDE autocompletes a variable name, a trie or balanced BST narrows the search space. Trees are not just an academic data structure — they are the organizing principle behind sorted data in virtually every system you have ever built.

I have spent fifteen years watching developers treat `TreeMap` as a black box. They know it is "sorted" and "O(log n)" and that is where their understanding ends. Then they hit an interview question about validating a BST, or they need to explain why their database query scans millions of rows despite having an index, and the black box betrays them.

This chapter rips the lid off. We will start with the raw BST — its beauty and its fatal flaw. We will build AVL trees from scratch to understand rotations viscerally. Then we will dissect Red-Black trees the way OpenJDK implements them, walking through the actual `TreeMap` source code line by line. Finally, we will cross the boundary from in-memory to on-disk and understand why B-Trees and B+ Trees rule the database world.

By the end, you will see trees everywhere — because they *are* everywhere.

---

## 5.1 Binary Search Tree (BST) Fundamentals

### The Core Idea

A Binary Search Tree is the simplest sorted tree structure. Every node obeys one rule: everything in the left subtree is strictly less than the node's value, and everything in the right subtree is strictly greater. This one invariant gives us sorted order for free.

```
         8
        / \
       3   10
      / \    \
     1   6    14
        / \   /
       4   7 13
```

The BST property is recursive: every subtree is itself a valid BST. This recursive nature is why tree problems map so naturally to recursive solutions — and why interviewers love them.

### Node Structure

```java
public class BST<K extends Comparable<K>, V> {
    
    private static class Node<K, V> {
        K key;
        V value;
        Node<K, V> left;
        Node<K, V> right;
        // Optional: parent pointer (used in Red-Black trees, successor finding)
        // Node<K, V> parent;
        
        Node(K key, V value) {
            this.key = key;
            this.value = value;
        }
    }
    
    private Node<K, V> root;
    private int size;
}
```

**Memory layout on 64-bit JVM with compressed OOPs:**
```
Node object:
  Object header:     12 bytes (mark word 8 + klass pointer 4)
  key reference:      4 bytes (compressed OOP)
  value reference:    4 bytes
  left reference:     4 bytes
  right reference:    4 bytes
  Padding:            4 bytes (align to 8-byte boundary)
  Total:             32 bytes per node
```

With a `parent` pointer, add 4 bytes + potential padding = 40 bytes per node. Compare this to `TreeMap.Entry` at ~48 bytes (it also stores `color`).

### Search

Searching a BST follows the invariant directly: if the target is less than the current node, go left. If greater, go right. If equal, found it.

```java
public V get(K key) {
    Node<K, V> current = root;
    while (current != null) {
        int cmp = key.compareTo(current.key);
        if (cmp < 0)      current = current.left;
        else if (cmp > 0)  current = current.right;
        else                return current.value;   // found
    }
    return null;  // not found
}
```

Time complexity: O(h) where h is the height. In a balanced tree, h = O(log n). In a degenerate tree, h = O(n). This is the entire motivation for balanced BSTs.

### Insert

Insertion finds the correct position using the same binary search, then attaches a new leaf node.

```java
public void put(K key, V value) {
    if (root == null) {
        root = new Node<>(key, value);
        size++;
        return;
    }
    
    Node<K, V> parent = null;
    Node<K, V> current = root;
    int cmp = 0;
    
    while (current != null) {
        parent = current;
        cmp = key.compareTo(current.key);
        if (cmp < 0)      current = current.left;
        else if (cmp > 0)  current = current.right;
        else {
            current.value = value;  // update existing key
            return;
        }
    }
    
    Node<K, V> newNode = new Node<>(key, value);
    if (cmp < 0) parent.left = newNode;
    else          parent.right = newNode;
    size++;
}
```

### Delete — The Three Cases

BST deletion is where things get interesting. There are three cases, and interviewers love asking about each:

**Case 1: Deleting a leaf node.** Simply remove it — set the parent's pointer to null.

```
  Delete 4:
       5              5
      / \    →       / \
     3   7          3   7
    / \              \
   2   4              2
```

**Case 2: Deleting a node with one child.** Replace the node with its only child — "splice it out."

```
  Delete 3 (has only right child):
       5              5
      / \    →       / \
     3   7          4   7
      \
       4
```

**Case 3: Deleting a node with two children.** This is the tricky one. Find the in-order successor (smallest node in the right subtree) or the in-order predecessor (largest node in the left subtree). Copy the successor's key and value into the node being deleted, then delete the successor (which has at most one child, reducing to Case 1 or 2).

```
  Delete 5 (has two children):
  In-order successor of 5 is 6 (leftmost node in right subtree).
  Copy 6 into 5's position, then delete the original 6.
  
       5              6
      / \    →       / \
     3   8          3   8
    / \ / \        / \   \
   2  4 6  9      2  4    9
         \
          7          7 is now 8's left child
```

Wait — let me be more precise about that last diagram. After finding successor 6, we copy 6's key/value into node 5's position. Then we delete node 6 from its original position. Node 6 has one right child (7), so deleting node 6 is Case 2: replace node 6 with its child 7.

```
       5                  6
      / \                / \
     3   8     →        3   8
    / \ / \            / \ / \
   2  4 6  9          2  4 7  9
         \
          7
```

Full delete implementation:

```java
public void delete(K key) {
    root = deleteRecursive(root, key);
}

private Node<K, V> deleteRecursive(Node<K, V> node, K key) {
    if (node == null) return null;
    
    int cmp = key.compareTo(node.key);
    if (cmp < 0) {
        node.left = deleteRecursive(node.left, key);
    } else if (cmp > 0) {
        node.right = deleteRecursive(node.right, key);
    } else {
        // Found the node to delete
        
        // Case 1: Leaf node — return null
        // Case 2: One child — return the non-null child
        if (node.left == null) return node.right;
        if (node.right == null) return node.left;
        
        // Case 3: Two children — find in-order successor
        Node<K, V> successor = findMin(node.right);
        node.key = successor.key;
        node.value = successor.value;
        // Delete the successor from the right subtree
        node.right = deleteRecursive(node.right, successor.key);
    }
    return node;
}

private Node<K, V> findMin(Node<K, V> node) {
    while (node.left != null) node = node.left;
    return node;
}
```

### In-Order Traversal Gives Sorted Order — The Proof

This is a fundamental property and interviewers often ask you to prove it. The proof is by structural induction:

**Base case:** A single node (or empty tree) is trivially sorted.

**Inductive step:** Assume in-order traversal of any BST with fewer than n nodes gives sorted order. Consider a BST with n nodes rooted at r:
1. By induction, in-order traversal of `r.left` (which has fewer than n nodes) gives a sorted sequence L.
2. By the BST property, every element in L is less than `r.key`.
3. By induction, in-order traversal of `r.right` gives a sorted sequence R.
4. By the BST property, every element in R is greater than `r.key`.
5. In-order traversal visits: L, then r.key, then R.
6. Since all elements of L < r.key < all elements of R, the concatenation L + [r.key] + R is sorted.

QED.

This is not just a theoretical curiosity. It means:
- BST in-order traversal is a natural sort (if the tree is balanced, it is an O(n log n) sort by build time + O(n) traversal)
- `TreeMap` iteration is sorted by key — guaranteed by this property
- The in-order successor of a node is the "next element in sorted order"

```java
// In-order traversal (iterative, using explicit stack — interview preferred)
public List<K> inorderTraversal() {
    List<K> result = new ArrayList<>();
    Deque<Node<K, V>> stack = new ArrayDeque<>();
    Node<K, V> current = root;
    
    while (current != null || !stack.isEmpty()) {
        // Push all left children
        while (current != null) {
            stack.push(current);
            current = current.left;
        }
        // Visit node
        current = stack.pop();
        result.add(current.key);
        // Move to right subtree
        current = current.right;
    }
    return result;
}
```

### The Degenerate Tree Problem

If you insert keys in sorted order — 1, 2, 3, 4, 5 — the BST degenerates into a linked list:

```
1
 \
  2
   \
    3
     \
      4
       \
        5
```

Every operation is now O(n). This is catastrophic, and it is the entire reason self-balancing trees exist. In production, you never use a raw BST. You use AVL, Red-Black, or B-Trees — all of which guarantee O(log n) height.

**Real-world analogy:** An unbalanced BST is like a database index that has degraded to a sequential scan. The *idea* of the index is fine, but the implementation has failed.

---

## 5.2 AVL Trees

### The Strictest Balance

AVL trees (Adelson-Velsky and Landis, 1962) were the first self-balancing BST. The invariant is simple: for every node, the heights of its left and right subtrees differ by at most 1.

**Balance factor:** `bf(node) = height(left) - height(right)`. Must be -1, 0, or +1 for every node. If any node violates this after an insert or delete, we fix it with rotations.

**Height guarantee:** An AVL tree with n nodes has height h where:

`h <= 1.44 * log2(n + 2) - 0.328`

This is tighter than Red-Black trees (which guarantee `h <= 2 * log2(n + 1)`). For a tree with 1 million nodes, an AVL tree has height at most ~29, while a Red-Black tree could have height up to ~40. This means AVL trees have faster lookups.

The tradeoff: AVL trees may perform more rotations on insert/delete to maintain their stricter invariant.

### The Four Rotation Cases

When an insertion causes a balance violation, there are exactly four cases. Understanding these cases geometrically is crucial for interviews.

**Case 1: Left-Left (LL) — Right Rotation**

The violation is in the left child's left subtree. One right rotation fixes it.

```
Before (z is unbalanced, bf = +2):       After right rotation at z:
        z                                      y
       / \                                    / \
      y   T4                                 x   z
     / \           →  Right Rotate(z)       / \ / \
    x   T3                                T1 T2 T3 T4
   / \
  T1  T2
```

**Case 2: Right-Right (RR) — Left Rotation**

Mirror of LL. The violation is in the right child's right subtree.

```
Before (z is unbalanced, bf = -2):       After left rotation at z:
    z                                          y
   / \                                        / \
  T1  y                                      z   x
     / \          →  Left Rotate(z)         / \ / \
    T2  x                                 T1 T2 T3 T4
       / \
      T3  T4
```

**Case 3: Left-Right (LR) — Left Rotation then Right Rotation**

The violation is in the left child's right subtree. We need two rotations: first left-rotate the child, then right-rotate the parent. This converts the LR case into an LL case.

```
Before:              After Left Rotate(y):     After Right Rotate(z):
      z                     z                         x
     / \                   / \                       / \
    y   T4                x   T4                    y   z
   / \         →         / \            →          / \ / \
  T1  x                 y   T3                   T1 T2 T3 T4
     / \                / \
    T2  T3             T1  T2
```

**Case 4: Right-Left (RL) — Right Rotation then Left Rotation**

Mirror of LR. The violation is in the right child's left subtree.

```
Before:              After Right Rotate(y):    After Left Rotate(z):
    z                     z                         x
   / \                   / \                       / \
  T1  y                 T1  x                     z   y
     / \       →           / \          →        / \ / \
    x   T4                T2  y                 T1 T2 T3 T4
   / \                       / \
  T2  T3                    T3  T4
```

### Full Java Implementation

```java
public class AVLTree<K extends Comparable<K>, V> {
    
    private static class Node<K, V> {
        K key;
        V value;
        Node<K, V> left, right;
        int height;
        
        Node(K key, V value) {
            this.key = key;
            this.value = value;
            this.height = 1;  // new node is a leaf with height 1
        }
    }
    
    private Node<K, V> root;
    private int size;
    
    // --- Utility Methods ---
    
    private int height(Node<K, V> node) {
        return node == null ? 0 : node.height;
    }
    
    private int balanceFactor(Node<K, V> node) {
        return node == null ? 0 : height(node.left) - height(node.right);
    }
    
    private void updateHeight(Node<K, V> node) {
        node.height = 1 + Math.max(height(node.left), height(node.right));
    }
    
    // --- Rotations ---
    
    /**
     * Right rotation around y:
     *       y             x
     *      / \           / \
     *     x   C   →    A   y
     *    / \               / \
     *   A   B             B   C
     */
    private Node<K, V> rightRotate(Node<K, V> y) {
        Node<K, V> x = y.left;
        Node<K, V> B = x.right;
        
        // Perform rotation
        x.right = y;
        y.left = B;
        
        // Update heights (y first since it is now a child of x)
        updateHeight(y);
        updateHeight(x);
        
        return x;  // new root of this subtree
    }
    
    /**
     * Left rotation around x:
     *     x               y
     *    / \             / \
     *   A   y    →     x   C
     *      / \        / \
     *     B   C      A   B
     */
    private Node<K, V> leftRotate(Node<K, V> x) {
        Node<K, V> y = x.right;
        Node<K, V> B = y.left;
        
        // Perform rotation
        y.left = x;
        x.right = B;
        
        // Update heights (x first since it is now a child of y)
        updateHeight(x);
        updateHeight(y);
        
        return y;  // new root of this subtree
    }
    
    // --- Rebalance ---
    
    private Node<K, V> rebalance(Node<K, V> node) {
        updateHeight(node);
        int bf = balanceFactor(node);
        
        // Left-heavy (bf > 1)
        if (bf > 1) {
            if (balanceFactor(node.left) < 0) {
                // LR case: left-rotate the left child first
                node.left = leftRotate(node.left);
            }
            // LL case (or converted LR → LL)
            return rightRotate(node);
        }
        
        // Right-heavy (bf < -1)
        if (bf < -1) {
            if (balanceFactor(node.right) > 0) {
                // RL case: right-rotate the right child first
                node.right = rightRotate(node.right);
            }
            // RR case (or converted RL → RR)
            return leftRotate(node);
        }
        
        return node;  // balanced, no rotation needed
    }
    
    // --- Insert ---
    
    public void put(K key, V value) {
        root = insert(root, key, value);
    }
    
    private Node<K, V> insert(Node<K, V> node, K key, V value) {
        if (node == null) {
            size++;
            return new Node<>(key, value);
        }
        
        int cmp = key.compareTo(node.key);
        if (cmp < 0)      node.left = insert(node.left, key, value);
        else if (cmp > 0)  node.right = insert(node.right, key, value);
        else {
            node.value = value;  // update existing
            return node;
        }
        
        return rebalance(node);
    }
    
    // --- Delete ---
    
    public void delete(K key) {
        root = delete(root, key);
    }
    
    private Node<K, V> delete(Node<K, V> node, K key) {
        if (node == null) return null;
        
        int cmp = key.compareTo(node.key);
        if (cmp < 0) {
            node.left = delete(node.left, key);
        } else if (cmp > 0) {
            node.right = delete(node.right, key);
        } else {
            // Found node to delete
            if (node.left == null) { size--; return node.right; }
            if (node.right == null) { size--; return node.left; }
            
            // Two children: find in-order successor
            Node<K, V> successor = findMin(node.right);
            node.key = successor.key;
            node.value = successor.value;
            node.right = delete(node.right, successor.key);
        }
        
        return rebalance(node);
    }
    
    private Node<K, V> findMin(Node<K, V> node) {
        while (node.left != null) node = node.left;
        return node;
    }
    
    // --- Search ---
    
    public V get(K key) {
        Node<K, V> current = root;
        while (current != null) {
            int cmp = key.compareTo(current.key);
            if (cmp < 0)      current = current.left;
            else if (cmp > 0)  current = current.right;
            else                return current.value;
        }
        return null;
    }
    
    public int size() { return size; }
}
```

**When to use AVL over Red-Black:** AVL trees shine in read-heavy workloads where lookups vastly outnumber insertions and deletions. The stricter balance means fewer comparisons per lookup. If your workload is 90% reads, AVL is theoretically faster. If your workload is a mix of reads and writes, Red-Black trees win because they require fewer rotations on mutations.

In practice, most standard libraries chose Red-Black trees (Java's `TreeMap`, C++'s `std::map`, Linux kernel's `rbtree`). The constant-factor advantage of AVL on lookups is small, and the insert/delete advantage of Red-Black is significant.

---

## 5.3 Red-Black Trees (TreeMap's Backbone)

### The Five Properties

A Red-Black tree is a BST where every node is colored either red or black, and the following five properties hold at all times:

1. **Every node is either red or black.**
2. **The root is black.**
3. **Every leaf (NIL sentinel) is black.** (We use null as NIL in Java implementations, but conceptually they are black sentinel nodes.)
4. **If a node is red, both its children are black.** (No two consecutive red nodes on any path — the "red rule".)
5. **For each node, every path from that node to a descendant NIL contains the same number of black nodes.** (The "black-height" property.)

```
         8(B)
        /    \
      4(R)   12(R)
      / \     / \
    2(B) 6(B) 10(B) 14(B)
    /     \
   1(R)   7(R)
```

**Why these properties guarantee O(log n) height:**

Property 5 ensures that no path from root to leaf is more than twice as long as any other path. Here is the reasoning:
- Let bh be the black-height of the root (number of black nodes on any root-to-NIL path, not counting the root).
- The shortest possible path is all black nodes: length = bh.
- The longest possible path alternates red and black (by property 4): length = 2 * bh.
- Therefore: shortest path length <= longest path length <= 2 * shortest path length.
- A subtree rooted at any node has at least `2^bh - 1` internal nodes (by induction).
- Combined: `n >= 2^(h/2) - 1`, so `h <= 2 * log2(n + 1)`.

**Height guarantee:** `h <= 2 * log2(n + 1)` — looser than AVL's `1.44 * log2(n + 2)`, but still O(log n).

### Insert Fixup — Three Cases

Insertion always adds a **red** node (to avoid violating property 5 — adding a black node would change black-heights). The only property that can be violated is property 4 (red node with red child). We fix up by walking up the tree, recoloring and rotating.

Let `z` be the newly inserted node (red), `p` be its parent, `g` be its grandparent, and `u` be its uncle (the other child of g).

**Case 1: Uncle is Red — Recolor**

Both parent and uncle are red. Recolor parent and uncle to black, grandparent to red, then move `z` up to the grandparent and repeat.

```
Before:                  After recoloring:
      g(B)                    g(R) ← new z
     / \                     / \
   p(R)  u(R)             p(B)  u(B)
   /                       /
  z(R)                    z(R)
```

This might propagate the violation up to the root. If the root becomes red, we simply recolor it black (which increases the black-height of the entire tree by 1).

**Case 2: Uncle is Black, z is "inner child" (triangle) — Rotate to Line**

z is a right child of a left parent (or left child of a right parent). Rotate z's parent to convert this into Case 3.

```
Before (LR triangle):       After left-rotate(p):
      g(B)                        g(B)
     / \                         / \
   p(R)  u(B)                 z(R)  u(B)
     \                         /
     z(R)                    p(R) ← new z
```

Now z (the old parent) and its parent (the old z) form a line — this is Case 3.

**Case 3: Uncle is Black, z is "outer child" (line) — Rotate + Recolor**

z and p form a line (both left children or both right children). Rotate the grandparent and swap colors of parent and grandparent.

```
Before (LL line):            After right-rotate(g) + recolor:
      g(B)                        p(B)
     / \                         / \
   p(R)  u(B)                 z(R)  g(R)
   /                                  \
  z(R)                                u(B)
```

This restores all five properties. No further fixup needed (the new subtree root `p` is black).

### Insert Fixup — Full Algorithm

```java
// Pseudocode matching OpenJDK's fixAfterInsertion
private void fixAfterInsertion(Node<K, V> z) {
    z.color = RED;
    
    // Fix while z is not root and parent is red (property 4 violation)
    while (z != null && z != root && z.parent.color == RED) {
        if (parentOf(z) == leftOf(parentOf(parentOf(z)))) {
            // Parent is left child of grandparent
            Node<K, V> uncle = rightOf(parentOf(parentOf(z)));
            
            if (colorOf(uncle) == RED) {
                // Case 1: Uncle is red — recolor
                setColor(parentOf(z), BLACK);
                setColor(uncle, BLACK);
                setColor(parentOf(parentOf(z)), RED);
                z = parentOf(parentOf(z));  // move up to grandparent
            } else {
                if (z == rightOf(parentOf(z))) {
                    // Case 2: Uncle is black, z is right child (triangle)
                    z = parentOf(z);
                    rotateLeft(z);  // convert to Case 3
                }
                // Case 3: Uncle is black, z is left child (line)
                setColor(parentOf(z), BLACK);
                setColor(parentOf(parentOf(z)), RED);
                rotateRight(parentOf(parentOf(z)));
            }
        } else {
            // Mirror: parent is right child of grandparent
            Node<K, V> uncle = leftOf(parentOf(parentOf(z)));
            
            if (colorOf(uncle) == RED) {
                // Case 1 (mirror)
                setColor(parentOf(z), BLACK);
                setColor(uncle, BLACK);
                setColor(parentOf(parentOf(z)), RED);
                z = parentOf(parentOf(z));
            } else {
                if (z == leftOf(parentOf(z))) {
                    // Case 2 (mirror)
                    z = parentOf(z);
                    rotateRight(z);
                }
                // Case 3 (mirror)
                setColor(parentOf(z), BLACK);
                setColor(parentOf(parentOf(z)), RED);
                rotateLeft(parentOf(parentOf(z)));
            }
        }
    }
    root.color = BLACK;  // Property 2: root is always black
}
```

### Delete Fixup — Four Cases

Red-Black tree deletion is the most complex operation in all of standard library data structures. It is more complex than insert because we might remove a black node, which changes the black-height on that path.

The high-level strategy:
1. Perform standard BST delete (with successor replacement for two-child case).
2. If the deleted node was red, no properties are violated — done.
3. If the deleted node was black, the path through its position now has one fewer black node — violating property 5. We need to "push" an extra black into the tree.

The fixup node `x` carries a "double black" — it counts as two black nodes. We fix by converting this double black back to single black through four cases:

**Case 1: Sibling is Red.**
Rotate the parent so the sibling becomes the grandparent, recolor sibling to black and parent to red. This converts to Case 2, 3, or 4 (where sibling is black).

```
Before:                   After left-rotate(parent) + recolor:
    p(B)                       s(B)
   / \                        / \
  x(BB) s(R)               p(R)  D
        / \                / \
       C   D            x(BB) C ← new sibling is C (black)
```

**Case 2: Sibling is Black, both of sibling's children are black.**
"Pull" one black from both x and sibling up to parent. x becomes single black, sibling becomes red. If parent was red, it becomes black and we are done. If parent was black, parent becomes the new double black — recurse up.

**Case 3: Sibling is Black, sibling's inner child is red, outer child is black.**
Rotate sibling to convert to Case 4. Recolor so the new sibling (the inner child) is black.

**Case 4: Sibling is Black, sibling's outer child is red.**
This is the terminal case. Rotate parent, transfer parent's color to sibling, color parent and sibling's outer child black. The extra black is absorbed. Done.

```java
// Simplified pseudocode for delete fixup
private void fixAfterDeletion(Node<K, V> x) {
    while (x != root && colorOf(x) == BLACK) {
        if (x == leftOf(parentOf(x))) {
            Node<K, V> sib = rightOf(parentOf(x));
            
            if (colorOf(sib) == RED) {
                // Case 1: sibling is red
                setColor(sib, BLACK);
                setColor(parentOf(x), RED);
                rotateLeft(parentOf(x));
                sib = rightOf(parentOf(x));  // new sibling
            }
            
            if (colorOf(leftOf(sib)) == BLACK && colorOf(rightOf(sib)) == BLACK) {
                // Case 2: sibling's children are both black
                setColor(sib, RED);
                x = parentOf(x);  // push double-black up
            } else {
                if (colorOf(rightOf(sib)) == BLACK) {
                    // Case 3: sibling's right child is black (inner red)
                    setColor(leftOf(sib), BLACK);
                    setColor(sib, RED);
                    rotateRight(sib);
                    sib = rightOf(parentOf(x));
                }
                // Case 4: sibling's right child is red (outer red)
                setColor(sib, colorOf(parentOf(x)));
                setColor(parentOf(x), BLACK);
                setColor(rightOf(sib), BLACK);
                rotateLeft(parentOf(x));
                x = root;  // terminate
            }
        } else {
            // Mirror of above for right child
            Node<K, V> sib = leftOf(parentOf(x));
            
            if (colorOf(sib) == RED) {
                setColor(sib, BLACK);
                setColor(parentOf(x), RED);
                rotateRight(parentOf(x));
                sib = leftOf(parentOf(x));
            }
            
            if (colorOf(rightOf(sib)) == BLACK && colorOf(leftOf(sib)) == BLACK) {
                setColor(sib, RED);
                x = parentOf(x);
            } else {
                if (colorOf(leftOf(sib)) == BLACK) {
                    setColor(rightOf(sib), BLACK);
                    setColor(sib, RED);
                    rotateLeft(sib);
                    sib = leftOf(parentOf(x));
                }
                setColor(sib, colorOf(parentOf(x)));
                setColor(parentOf(x), BLACK);
                setColor(leftOf(sib), BLACK);
                rotateRight(parentOf(x));
                x = root;
            }
        }
    }
    setColor(x, BLACK);
}
```

### Why Red-Black Over AVL for TreeMap

Java's `TreeMap` uses a Red-Black tree, not an AVL tree. Here is why:

1. **Fewer rotations on insert:** AVL may do up to O(log n) rotations per insert (rebalancing propagates up). Red-Black does at most 2 rotations per insert plus O(log n) recolorings (recolorings are cheap).
2. **Fewer rotations on delete:** AVL may do up to O(log n) rotations per delete. Red-Black does at most 3 rotations per delete.
3. **Mixed workloads:** `TreeMap` is used for general-purpose sorted maps. Users do inserts, deletes, and lookups in unpredictable patterns. Red-Black's lower mutation cost is a better fit.
4. **Lookup difference is small:** Red-Black trees are at most ~44% taller than AVL trees. For n = 1,000,000, that is ~40 vs ~29 levels — a difference of ~11 comparisons. With modern CPUs and branch prediction, this is nanoseconds.

The Linux kernel also uses Red-Black trees extensively (for process scheduling, memory management, ext4 extent trees) — same reasoning: mutations are common, and the rotation count matters.

---

## 5.4 TreeMap OpenJDK Source Walkthrough

Let us walk through `java.util.TreeMap` in OpenJDK to see how Red-Black trees are actually implemented in production Java.

### The Entry Class

```java
// From OpenJDK java.util.TreeMap (simplified)
static final class Entry<K,V> implements Map.Entry<K,V> {
    K key;
    V value;
    Entry<K,V> left;
    Entry<K,V> right;
    Entry<K,V> parent;     // Red-Black trees need parent pointers
    boolean color = BLACK;  // true = BLACK, false = RED (new nodes default to BLACK,
                            // but fixAfterInsertion sets them to RED)
}
```

**Memory per Entry on 64-bit JVM with compressed OOPs:**
```
Object header:       12 bytes (mark word 8 + klass pointer 4)
key reference:        4 bytes
value reference:      4 bytes
left reference:       4 bytes
right reference:      4 bytes
parent reference:     4 bytes
color (boolean):      1 byte
Padding:              7 bytes (align to 8-byte boundary after 33 bytes → 40 bytes)
Total:               ~48 bytes per entry
```

That is 48 bytes per key-value pair, compared to ~32 bytes for a `HashMap.Node` (without tree nodes). The extra cost buys you sorted order.

For 1 million entries: `TreeMap` entries alone consume ~48 MB. Add the key and value objects, and a `TreeMap<String, String>` with 1M entries easily exceeds 100 MB.

### The comparator Field

```java
private final Comparator<? super K> comparator;
```

If you create `new TreeMap<>()`, comparator is null and keys must implement `Comparable` (natural ordering). If you pass a `Comparator` to the constructor, that comparator is used for all comparisons.

```java
// Natural ordering: keys.compareTo()
TreeMap<String, Integer> natural = new TreeMap<>();

// Custom ordering: case-insensitive
TreeMap<String, Integer> caseInsensitive = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);

// Reverse ordering
TreeMap<String, Integer> reversed = new TreeMap<>(Comparator.reverseOrder());
```

**Critical subtlety:** When using a custom comparator, two keys that the comparator considers equal will overwrite each other, even if `equals()` says they are different. For example, `String.CASE_INSENSITIVE_ORDER` considers "ABC" and "abc" equal — putting "abc" after "ABC" overwrites the first entry.

### The put() Method

```java
// Simplified from OpenJDK source
public V put(K key, V value) {
    Entry<K,V> t = root;
    if (t == null) {
        // Empty tree — create root
        compare(key, key); // type (and null) check
        root = new Entry<>(key, value, null);
        size = 1;
        modCount++;
        return null;
    }
    
    int cmp;
    Entry<K,V> parent;
    Comparator<? super K> cpr = comparator;
    
    if (cpr != null) {
        // Custom comparator path
        do {
            parent = t;
            cmp = cpr.compare(key, t.key);
            if (cmp < 0)      t = t.left;
            else if (cmp > 0)  t = t.right;
            else                return t.setValue(value);  // key exists, update
        } while (t != null);
    } else {
        // Natural ordering path — Comparable
        if (key == null) throw new NullPointerException();
        Comparable<? super K> k = (Comparable<? super K>) key;
        do {
            parent = t;
            cmp = k.compareTo(t.key);
            if (cmp < 0)      t = t.left;
            else if (cmp > 0)  t = t.right;
            else                return t.setValue(value);
        } while (t != null);
    }
    
    // Key not found — insert new entry
    Entry<K,V> e = new Entry<>(key, value, parent);
    if (cmp < 0) parent.left = e;
    else          parent.right = e;
    
    fixAfterInsertion(e);  // Red-Black fixup
    size++;
    modCount++;
    return null;
}
```

Notice the two separate search loops — one for custom comparator, one for natural ordering. This is a JIT optimization: the hot loop for natural ordering avoids a null check on `cpr` every iteration. The JIT can then devirtualize and inline the `compareTo` call if the key type is monomorphic (e.g., always `String`).

### The get() Method

```java
public V get(Object key) {
    Entry<K,V> p = getEntry(key);
    return (p == null ? null : p.value);
}

final Entry<K,V> getEntry(Object key) {
    if (comparator != null)
        return getEntryUsingComparator(key);
    if (key == null) throw new NullPointerException();
    Comparable<? super K> k = (Comparable<? super K>) key;
    Entry<K,V> p = root;
    while (p != null) {
        int cmp = k.compareTo(p.key);
        if (cmp < 0)      p = p.left;
        else if (cmp > 0)  p = p.right;
        else                return p;
    }
    return null;
}
```

Pure BST search. O(log n) because Red-Black tree guarantees O(log n) height.

### NavigableMap Operations

`TreeMap` implements `NavigableMap`, providing operations that exploit the sorted order:

```java
// floorKey(key): greatest key <= given key
// Walk down the tree; when going right, record the current node as a candidate
public K floorKey(K key) {
    Entry<K,V> p = root;
    Entry<K,V> candidate = null;
    while (p != null) {
        int cmp = compare(key, p.key);
        if (cmp > 0) {
            candidate = p;      // p.key < key, so p is a candidate
            p = p.right;        // look for something closer
        } else if (cmp < 0) {
            p = p.left;         // p.key > key, go left
        } else {
            return p.key;       // exact match
        }
    }
    return candidate == null ? null : candidate.key;
}

// ceilingKey(key): smallest key >= given key — mirror of floorKey
// headMap(toKey): view of map with keys < toKey — backed by tree, lazy
// tailMap(fromKey): view of map with keys >= fromKey
// subMap(fromKey, toKey): view of map with keys in [fromKey, toKey)
```

**headMap, tailMap, subMap** return **views** backed by the original tree. They do not copy data. Modifications to the view modify the tree, and vice versa. This is O(1) to create the view. Iteration over the view is O(k + log n) where k is the number of elements in the range.

```java
TreeMap<Integer, String> map = new TreeMap<>();
map.put(1, "a"); map.put(3, "c"); map.put(5, "e"); map.put(7, "g"); map.put(9, "i");

// Range query: keys in [3, 7]
SortedMap<Integer, String> range = map.subMap(3, 8);  // [3, 8) → {3=c, 5=e, 7=g}

// Floor and ceiling
map.floorKey(4);    // 3 (largest key <= 4)
map.ceilingKey(4);  // 5 (smallest key >= 4)
map.lowerKey(5);    // 3 (largest key < 5, strictly less)
map.higherKey(5);   // 7 (smallest key > 5, strictly greater)
```

### firstKey() and lastKey()

```java
public K firstKey() {
    return key(getFirstEntry());
}

final Entry<K,V> getFirstEntry() {
    Entry<K,V> p = root;
    if (p != null)
        while (p.left != null)
            p = p.left;
    return p;
}
```

Simply follows left pointers to the minimum. O(log n) because tree height is O(log n).

### TreeSet is TreeMap

Just like `HashSet` is backed by a `HashMap<E, Object>`, `TreeSet` is backed by a `TreeMap<E, Object>`:

```java
// From OpenJDK TreeSet source
public class TreeSet<E> extends AbstractSet<E> implements NavigableSet<E> {
    private transient NavigableMap<E,Object> m;
    private static final Object PRESENT = new Object();  // dummy value
    
    public TreeSet() {
        this.m = new TreeMap<>();
    }
    
    public boolean add(E e) {
        return m.put(e, PRESENT) == null;
    }
    
    public boolean contains(Object o) {
        return m.containsKey(o);
    }
}
```

Every `TreeSet` operation delegates to the underlying `TreeMap`. The `PRESENT` object is a static singleton — all entries share the same dummy value, so the overhead is just the 4-byte reference per entry.

---

## 5.5 B-Tree and B+ Tree

### Why BSTs Fail for Disk

Everything we have discussed so far — BST, AVL, Red-Black — lives in main memory where pointer chasing costs nanoseconds. On disk, the game changes entirely.

A disk seek costs about 5-10 milliseconds (HDD) or 50-100 microseconds (SSD). Reading a single node by following a pointer means one disk I/O per tree level. A binary tree with 1 million nodes has height ~20. That is 20 disk seeks per lookup — absolutely unacceptable.

The insight: if each disk I/O reads a full 4KB-16KB page anyway, we should pack as much useful data into that page as possible. Instead of 2 children per node (binary), we can have hundreds or thousands of children per node. This dramatically reduces tree height.

```
Binary tree with 1M nodes:   height = ~20 levels = ~20 disk seeks
B-Tree with order 1000:      height = ~2 levels  = ~2 disk seeks
```

This is the fundamental motivation for B-Trees.

### B-Tree Structure

A B-Tree of order m (also called minimum degree t) has these properties:
- Every node holds between t-1 and 2t-1 keys (except the root, which can have as few as 1 key).
- Every internal node with k keys has exactly k+1 children.
- All leaves are at the same level (perfectly balanced).
- Keys within a node are sorted.

```
B-Tree of order t=3 (max 5 keys per node, min 2):

            [  20  |  40  ]
           /       |       \
    [5|10|15]  [25|30|35]  [45|50|55|60|65]
```

Each node in a B-Tree maps to one disk page. The order t is chosen so that a node fills exactly one disk page:

```
Page size = 4096 bytes
Key size = 8 bytes (e.g., a long)
Child pointer = 8 bytes (disk offset)
Value pointer = 8 bytes

Keys per node = (4096 - overhead) / (key_size + child_pointer + value_pointer)
             ≈ 4096 / 24 ≈ 170
```

With ~170 keys per node:
- Height 1: 170 keys
- Height 2: 170 * 171 ~ 29,000 keys
- Height 3: 170 * 171 * 171 ~ 5,000,000 keys
- Height 4: ~850,000,000 keys

Five million records in 3 disk reads. Nearly a billion in 4. This is why B-Trees dominate database indexing.

### B-Tree Search

```java
// Conceptual B-Tree search
public V search(BTreeNode node, K key) {
    // Binary search within the node's keys
    int i = Collections.binarySearch(node.keys, key);
    
    if (i >= 0) {
        // Found in this node
        return node.values.get(i);
    }
    
    if (node.isLeaf()) {
        return null;  // Not found
    }
    
    // i is the insertion point (negative, per binarySearch contract)
    int childIndex = -(i + 1);
    // Read child from disk — this is the expensive operation
    BTreeNode child = readFromDisk(node.children[childIndex]);
    return search(child, key);
}
```

### B-Tree Insert with Splitting

When a node is full (has 2t-1 keys) and we need to insert, we split it:

```
Before split (node is full with 5 keys, t=3):
  [...| ptr | 10 | 20 | 30 | 40 | 50 | ptr |...]

Split at median (30):
  - Left node:  [10 | 20]
  - Right node: [40 | 50]
  - Median (30) promoted to parent

After split:
  Parent: [...| 30 |...]
           /     \
    [10|20]     [40|50]
```

The proactive approach (used in practice) splits full nodes on the way down during insertion, so we never need to backtrack up the tree:

```java
// Simplified B-Tree insert
public void insert(K key, V value) {
    if (root.isFull()) {
        // Split root — tree grows taller
        BTreeNode newRoot = new BTreeNode();
        newRoot.children[0] = root;
        splitChild(newRoot, 0);
        root = newRoot;
    }
    insertNonFull(root, key, value);
}

private void insertNonFull(BTreeNode node, K key, V value) {
    int i = node.numKeys - 1;
    
    if (node.isLeaf()) {
        // Shift keys right and insert
        while (i >= 0 && key.compareTo(node.keys[i]) < 0) {
            node.keys[i + 1] = node.keys[i];
            i--;
        }
        node.keys[i + 1] = key;
        node.numKeys++;
        writeToDisk(node);
    } else {
        // Find correct child
        while (i >= 0 && key.compareTo(node.keys[i]) < 0) i--;
        i++;
        
        BTreeNode child = readFromDisk(node.children[i]);
        if (child.isFull()) {
            splitChild(node, i);
            if (key.compareTo(node.keys[i]) > 0) i++;
            child = readFromDisk(node.children[i]);
        }
        insertNonFull(child, key, value);
    }
}
```

### B-Tree Delete

B-Tree deletion is complex because we must maintain the minimum key count. Three sub-cases:

1. **Key is in a leaf:** Simply remove it. If the leaf underflows (fewer than t-1 keys), borrow from a sibling or merge with a sibling.

2. **Key is in an internal node:** Replace with predecessor (largest key in left child) or successor (smallest key in right child), then delete that key from the child (recursively, which eventually hits a leaf).

3. **Key is not in this node (descend to child):** Before descending into a child with exactly t-1 keys (minimum), either borrow from a sibling or merge the child with a sibling to ensure the child has at least t keys. This proactive approach avoids backtracking.

### B+ Tree — The Database Champion

A B+ Tree is a variant of B-Tree with two critical modifications:

1. **All data lives in leaf nodes.** Internal nodes contain only keys (used purely as an index/router). This means internal nodes can hold more keys — higher fan-out — shorter tree.

2. **Leaf nodes are linked.** A doubly-linked list connects all leaves in sorted order. This enables efficient range scans.

```
B+ Tree structure:

Internal nodes (index only):
              [  30  |  60  ]
             /       |       \
       [10|20]    [40|50]   [70|80|90]

Leaf nodes (data + links):
  [10,d1|20,d2] ↔ [30,d3|40,d4|50,d5] ↔ [60,d6|70,d7|80,d8|90,d9]
  ←────────────── linked list ────────────────→
```

**Why databases use B+ Trees over B-Trees:**

1. **Sequential scan efficiency:** Range queries (`WHERE id BETWEEN 100 AND 200`) start at the leaf for key 100 and follow the linked list to key 200. No tree traversal needed for the range itself — pure sequential I/O.

2. **Higher fan-out:** Internal nodes hold only keys (no data pointers), so more keys fit per page. More keys per node = shorter tree = fewer disk I/Os.

3. **Predictable I/O:** Every point query traverses exactly the same number of levels (root to leaf). B-Trees can find data at any level, making I/O less predictable.

4. **Better caching:** Internal nodes are accessed frequently and fit better in the buffer pool because they are smaller (no data). In practice, the top 2-3 levels of the B+ Tree stay cached in memory permanently.

### InnoDB Clustered Index — The Table IS the B+ Tree

In MySQL's InnoDB storage engine, the primary key index is a **clustered index** — the entire table data is stored in the leaf nodes of the B+ Tree ordered by primary key.

```
InnoDB Clustered Index (Primary Key = id):

Internal pages (index):     [  id:50  |  id:100  ]
                           /          |           \
Leaf pages (FULL ROWS):  [id:1,name:Alice,age:30 | id:2,...] 
                          ↔ [id:51,...] ↔ [id:101,...]

Each leaf page = 16KB (InnoDB default)
Each leaf page contains the COMPLETE rows, ordered by primary key
```

This has profound implications:

- **Point query by primary key:** Traverse the B+ Tree to the correct leaf page. One row per I/O (plus the index traversal). This is the fastest possible lookup.
- **Range scan by primary key:** Find the starting leaf, then follow the linked list. Sequential I/O — extremely fast.
- **Secondary indexes:** A secondary index is a separate B+ Tree where the leaf nodes contain the primary key value (not the row data). Looking up a row via a secondary index requires:
  1. Traverse the secondary index B+ Tree to find the primary key.
  2. Traverse the clustered index B+ Tree to find the actual row.
  This is called a "double lookup" or "bookmark lookup."

```
Secondary Index on 'name':

Internal:           [  name:John  ]
                   /              \
Leaf:    [name:Alice,pk:1 | name:Bob,pk:42] ↔ [name:John,pk:7 | name:Zara,pk:99]
                ↓                                     ↓
         Go to clustered index with pk=1      Go to clustered index with pk=7
         to get the full row                  to get the full row
```

**Why auto-increment primary keys are ideal for InnoDB:** New rows are always appended to the rightmost leaf page. No page splits. No random I/O for inserts. If you use a UUID primary key, inserts are random across the tree — causing page splits, fragmentation, and dramatically slower writes.

---

## 5.6 Comparison Table

| Structure | Insert | Search | Delete | Sorted? | Height Guarantee | Use Case |
|-----------|--------|--------|--------|---------|-----------------|----------|
| BST (plain) | O(n) worst | O(n) worst | O(n) worst | Yes | None (can degenerate) | Teaching only |
| AVL Tree | O(log n) | O(log n) | O(log n) | Yes | h <= 1.44 * log2(n+2) | Read-heavy in-memory |
| Red-Black | O(log n) | O(log n) | O(log n) | Yes | h <= 2 * log2(n+1) | General (TreeMap, kernel) |
| B-Tree | O(log n) | O(log n) | O(log n) | Yes | h = O(log_t n) | Disk-based, filesystems |
| B+ Tree | O(log n) | O(log n) | O(log n) | Yes | h = O(log_t n) | Databases (InnoDB, PostgreSQL) |

**Key insight for interviews:** When someone says "O(log n)" for a tree operation, always clarify *which* log base. For binary trees, it is log base 2. For B-Trees with order t, it is log base t. A B+ Tree with t = 500 searching 1 billion records: `log_500(10^9) ~ 3.3` — about 4 disk reads. A Red-Black tree searching the same data: `2 * log2(10^9) ~ 60` pointer chases (fine in memory, fatal on disk).

---

## 5.7 Problems

### BST Problems

**P05.01** [E] — Validate Binary Search Tree

Given the root of a binary tree, determine if it is a valid BST. A valid BST has the property that for every node, all values in its left subtree are strictly less than the node's value, and all values in its right subtree are strictly greater.

```java
// LeetCode 98 - Validate Binary Search Tree
//
// Approach: Pass down the valid range [min, max] for each node.
// The root can be any value. The left child must be less than root.
// The right child must be greater than root. Recurse with tightening bounds.
//
// Common mistake: Only checking node.left.val < node.val and node.right.val > node.val.
// This fails because a node deep in the left subtree could be greater than an ancestor.
//     5
//    / \
//   1   6
//      / \
//     3   7   ← 3 < 5 but is in 5's right subtree. Invalid!

public boolean isValidBST(TreeNode root) {
    return validate(root, Long.MIN_VALUE, Long.MAX_VALUE);
}

private boolean validate(TreeNode node, long min, long max) {
    if (node == null) return true;
    if (node.val <= min || node.val >= max) return false;
    return validate(node.left, min, node.val) &&
           validate(node.right, node.val, max);
}

// Time: O(n) — visit every node once
// Space: O(h) — recursion stack, h = height = O(log n) balanced, O(n) worst
//
// Alternative: In-order traversal should produce strictly increasing sequence.
// Track previous value and verify current > previous.
//
// JVM Insight: Using long for min/max avoids edge cases with Integer.MIN_VALUE
// and Integer.MAX_VALUE as actual node values. The comparisons are widening
// conversions (int → long) which the JIT handles as zero-cost sign extensions.
//
// Real-world correlation: Validating invariants is critical in distributed systems.
// **Cassandra** validates SSTable ordering during compaction — same concept as
// validating BST sorted order.
```

**P05.02** [E] — Search in a Binary Search Tree

Given the root of a BST and a target value, return the subtree rooted at the node with that value. If the node does not exist, return null.

```java
// LeetCode 700 - Search in a Binary Search Tree
//
// Iterative approach (preferred in interviews — no stack overflow risk)

public TreeNode searchBST(TreeNode root, int val) {
    TreeNode current = root;
    while (current != null) {
        if (val < current.val)      current = current.left;
        else if (val > current.val) current = current.right;
        else                        return current;
    }
    return null;
}

// Time: O(h) where h is height. O(log n) balanced, O(n) degenerate.
// Space: O(1) — iterative, no recursion stack.
//
// JVM Insight: This tight loop with a single branch per iteration is
// extremely friendly to branch prediction. After a few iterations, the
// CPU's branch predictor learns the pattern (e.g., if the target is large,
// we tend to go right). Misprediction penalty on modern x86 is ~15 cycles.
//
// Real-world correlation: This is exactly what TreeMap.get() does — the
// getEntry() method we walked through in section 5.4. Every NavigableMap
// lookup is this loop.
```

**P05.03** [E] — Insert into a Binary Search Tree

Given the root of a BST and a value to insert, insert the value and return the root. You may return any valid BST after insertion.

```java
// LeetCode 701 - Insert into a Binary Search Tree
//
// Iterative approach: find the null slot where the new node belongs.

public TreeNode insertIntoBST(TreeNode root, int val) {
    TreeNode newNode = new TreeNode(val);
    if (root == null) return newNode;
    
    TreeNode parent = null, current = root;
    while (current != null) {
        parent = current;
        if (val < current.val)  current = current.left;
        else                    current = current.right;
    }
    
    if (val < parent.val) parent.left = newNode;
    else                  parent.right = newNode;
    
    return root;
}

// Time: O(h). Space: O(1).
//
// Note: This does NOT rebalance. In a real system (TreeMap), the insert
// is followed by fixAfterInsertion() which does Red-Black rebalancing.
// For interview purposes, raw BST insert is usually what's expected.
//
// JVM Insight: Each TreeNode allocation is ~32 bytes on heap. If you insert
// 1M nodes, that is 32MB of small objects scattered across the heap.
// GC (G1 or ZGC) must trace all of them. Compare to a sorted array of 1M
// ints: 4MB, contiguous, one GC root. Trees are inherently GC-unfriendly.
//
// Real-world correlation: **Redis** sorted sets use skip lists instead of
// BSTs partly because skip list nodes are more cache-friendly (forward
// pointers are an array in the same node, not scattered child pointers).
```

**P05.04** [M] — Delete Node in a BST

Given a root of a BST and a key, delete the node with the given key and return the root.

```java
// LeetCode 450 - Delete Node in a BST
//
// The three cases we covered in section 5.1.

public TreeNode deleteNode(TreeNode root, int key) {
    if (root == null) return null;
    
    if (key < root.val) {
        root.left = deleteNode(root.left, key);
    } else if (key > root.val) {
        root.right = deleteNode(root.right, key);
    } else {
        // Found node to delete
        if (root.left == null) return root.right;  // Case 1 & 2
        if (root.right == null) return root.left;   // Case 2
        
        // Case 3: Two children — find in-order successor
        TreeNode successor = root.right;
        while (successor.left != null) successor = successor.left;
        
        root.val = successor.val;
        root.right = deleteNode(root.right, successor.val);
    }
    return root;
}

// Time: O(h). Space: O(h) recursion stack.
//
// Interview tip: The recursive approach is cleaner, but be ready to discuss
// the iterative version if asked. The iterative version requires explicit
// parent tracking and is significantly more code.
//
// JVM Insight: The deleted node becomes unreachable and eligible for GC.
// The GC does not immediately reclaim it — it waits for the next minor
// (or major) collection. If you delete millions of nodes rapidly, you
// create GC pressure. This is why bulk operations on TreeMap (clear(),
// or removing a large range) can trigger noticeable GC pauses.
//
// Real-world correlation: **InnoDB** delete marks rows instead of physically
// removing them (the "delete mark" flag in the record header). Physical
// removal happens during purge — analogous to deferred GC in Java.
```

**P05.05** [M] — Kth Smallest Element in a BST

Given the root of a BST, find the kth smallest element (1-indexed).

```java
// LeetCode 230 - Kth Smallest Element in a BST
//
// Approach: In-order traversal visits nodes in sorted order.
// The kth node visited is the kth smallest.
// Iterative in-order using a stack — stop early at kth element.

public int kthSmallest(TreeNode root, int k) {
    Deque<TreeNode> stack = new ArrayDeque<>();
    TreeNode current = root;
    int count = 0;
    
    while (current != null || !stack.isEmpty()) {
        while (current != null) {
            stack.push(current);
            current = current.left;
        }
        current = stack.pop();
        count++;
        if (count == k) return current.val;
        current = current.right;
    }
    
    throw new IllegalArgumentException("k is larger than tree size");
}

// Time: O(h + k) — we go down to the leftmost node (h), then visit k nodes.
// Space: O(h) — stack holds at most h nodes.
//
// Follow-up: If the BST is modified frequently and kth smallest is queried
// often, augment each node with a "left subtree size" field. Then finding
// kth smallest is O(h) without any traversal:
//   - If leftSize + 1 == k → current node is the answer
//   - If leftSize + 1 > k → go left (k stays the same)
//   - If leftSize + 1 < k → go right (k becomes k - leftSize - 1)
//
// JVM Insight: ArrayDeque as stack avoids LinkedList node allocation.
// Each push/pop is O(1) amortized with no GC pressure (ArrayDeque uses
// a circular array that resizes infrequently).
//
// Real-world correlation: **Elasticsearch** uses skip lists with rank
// augmentation to quickly find the kth result in a sorted posting list
// for pagination queries.
```

**P05.06** [M] — Inorder Successor in BST

Given a node in a BST, find its in-order successor (the node with the smallest key greater than the given node's key).

```java
// LeetCode 285 - Inorder Successor in BST
//
// Two cases:
// 1. If node has a right subtree: successor is the leftmost node in right subtree.
// 2. If node has no right subtree: successor is the lowest ancestor for which
//    the given node is in the LEFT subtree.
//
// Without parent pointers (given root):

public TreeNode inorderSuccessor(TreeNode root, TreeNode p) {
    TreeNode successor = null;
    TreeNode current = root;
    
    while (current != null) {
        if (p.val < current.val) {
            successor = current;      // current could be successor
            current = current.left;   // look for smaller candidate
        } else {
            current = current.right;  // p.val >= current.val, go right
        }
    }
    
    return successor;
}

// Time: O(h). Space: O(1).
//
// With parent pointers (like TreeMap.Entry):
// If node.right != null: follow right, then go left to the bottom.
// Else: walk up via parent pointers until we find an ancestor where
//       we came from the left child.
//
// TreeMap uses successor(Entry<K,V> t) which does exactly this — it is
// called during iteration to find the next entry in sorted order.
//
// JVM Insight: TreeMap's iterator calls successor() for each next() call.
// This is O(1) amortized over a full traversal (each edge is traversed
// at most twice — once down, once up). Total iteration: O(n).
//
// Real-world correlation: In-order successor is how **database cursors**
// work. When you `FETCH NEXT` from a cursor on an indexed column, the
// database follows the B+ Tree leaf chain to the next entry.
```

**P05.07** [E] — Convert Sorted Array to Binary Search Tree

Given a sorted array, convert it to a height-balanced BST.

```java
// LeetCode 108 - Convert Sorted Array to BST
//
// Approach: The middle element becomes the root (ensures balance).
// Left half becomes the left subtree, right half becomes the right subtree.
// Recurse.

public TreeNode sortedArrayToBST(int[] nums) {
    return build(nums, 0, nums.length - 1);
}

private TreeNode build(int[] nums, int left, int right) {
    if (left > right) return null;
    
    int mid = left + (right - left) / 2;  // avoid overflow
    TreeNode node = new TreeNode(nums[mid]);
    node.left = build(nums, left, mid - 1);
    node.right = build(nums, mid + 1, right);
    return node;
}

// Time: O(n) — visit every element once.
// Space: O(log n) — recursion depth is log n (balanced tree).
//        O(n) for the output tree itself.
//
// The resulting tree has height floor(log2(n)), which is optimal.
// This is the same strategy used to build a balanced BST from
// sorted data in O(n) time — much better than inserting one-by-one
// which is O(n log n) and might degenerate.
//
// JVM Insight: The `left + (right - left) / 2` idiom prevents integer
// overflow when left + right exceeds Integer.MAX_VALUE. Java's int is
// signed 32-bit. For array indices, this matters when arrays are large
// (up to 2^31 - 1 elements in Java, though practical limit is lower
// due to heap size).
//
// Real-world correlation: **B-Tree bulk loading** uses the same principle.
// When loading a sorted dataset into a B-Tree (e.g., CREATE INDEX on
// existing data), you build from the bottom up, filling leaf pages
// sequentially. This is much faster than random inserts.
```

**P05.08** [M] — Convert BST to Sorted Doubly Linked List

Convert a BST into a sorted circular doubly-linked list in-place. The left pointer should point to the predecessor, and the right pointer should point to the successor.

```java
// LeetCode 426 - Convert Binary Search Tree to Sorted Doubly Linked List
//
// In-order traversal, linking nodes as we visit them.

private Node first = null;  // head of linked list
private Node last = null;   // tail (previous node in traversal)

public Node treeToDoublyList(Node root) {
    if (root == null) return null;
    
    first = null;
    last = null;
    inorder(root);
    
    // Make it circular
    first.left = last;
    last.right = first;
    
    return first;
}

private void inorder(Node node) {
    if (node == null) return;
    
    inorder(node.left);
    
    // Process current node
    if (last == null) {
        first = node;  // first node in traversal
    } else {
        last.right = node;
        node.left = last;
    }
    last = node;
    
    inorder(node.right);
}

// Time: O(n). Space: O(h) recursion stack.
//
// The tree is modified in-place — no new nodes created.
// After conversion, the tree structure is destroyed (it is now a list).
//
// JVM Insight: This is an in-place transformation — no new heap allocations
// beyond the recursion stack frames. In GC terms, the same set of objects
// exists before and after; only the pointer graph changes. This is ideal
// for memory-constrained environments.
//
// Real-world correlation: **Linux kernel** converts between tree and list
// representations for memory regions (vm_area_struct) — the VMA tree is
// an augmented Red-Black tree, but certain operations linearize it.
```

**P05.09** [E] — Closest Binary Search Tree Value

Given a BST and a target floating-point value, find the node value closest to the target.

```java
// LeetCode 270 - Closest Binary Search Tree Value
//
// BST search, tracking the closest value seen so far.

public int closestValue(TreeNode root, double target) {
    int closest = root.val;
    TreeNode current = root;
    
    while (current != null) {
        if (Math.abs(current.val - target) < Math.abs(closest - target)) {
            closest = current.val;
        }
        current = target < current.val ? current.left : current.right;
    }
    
    return closest;
}

// Time: O(h). Space: O(1).
//
// At each step, we move toward the target value. The closest node is
// either on the path we traverse or we have already passed it.
//
// JVM Insight: Math.abs on doubles compiles to a bit operation (clear sign
// bit) — essentially free. The JIT can also strength-reduce the comparison
// to avoid computing both abs values when one is clearly smaller.
//
// Real-world correlation: **TreeMap.floorKey()** and **ceilingKey()** do
// essentially the same thing — find the nearest key in a given direction.
// closestValue is like calling both floor and ceiling and taking the closer one.
```

**P05.10** [H] — Count of Smaller Numbers After Self

Given an integer array `nums`, return a list where `result[i]` is the count of numbers that are both smaller than `nums[i]` and to its right.

```java
// LeetCode 315 - Count of Smaller Numbers After Self
//
// Approach: Process from right to left. Maintain a sorted structure that
// supports insert and rank query (count of elements smaller than x).
//
// Using a BST with augmented subtree sizes:

public List<Integer> countSmaller(int[] nums) {
    int n = nums.length;
    Integer[] result = new Integer[n];
    
    // We'll use merge sort approach (most efficient)
    // But first, let's show the BST approach for clarity:
    
    // BST Approach (O(n log n) average, O(n^2) worst):
    // Process right to left, insert into BST.
    // Each node tracks leftSize (count of nodes in left subtree).
    // When inserting val:
    //   - If val <= node.val: go left, node.leftSize++
    //   - If val > node.val: count += node.leftSize + 1, go right
    
    // Merge sort approach (O(n log n) guaranteed):
    int[] indices = new int[n];
    int[] counts = new int[n];
    for (int i = 0; i < n; i++) indices[i] = i;
    
    mergeSort(nums, indices, counts, 0, n - 1);
    
    List<Integer> res = new ArrayList<>();
    for (int c : counts) res.add(c);
    return res;
}

private void mergeSort(int[] nums, int[] indices, int[] counts, int lo, int hi) {
    if (lo >= hi) return;
    int mid = lo + (hi - lo) / 2;
    mergeSort(nums, indices, counts, lo, mid);
    mergeSort(nums, indices, counts, mid + 1, hi);
    merge(nums, indices, counts, lo, mid, hi);
}

private void merge(int[] nums, int[] indices, int[] counts, int lo, int mid, int hi) {
    int[] temp = new int[hi - lo + 1];
    int i = lo, j = mid + 1, k = 0;
    int rightCount = 0;  // elements from right half that are smaller
    
    while (i <= mid && j <= hi) {
        if (nums[indices[j]] < nums[indices[i]]) {
            rightCount++;
            temp[k++] = indices[j++];
        } else {
            counts[indices[i]] += rightCount;
            temp[k++] = indices[i++];
        }
    }
    while (i <= mid) {
        counts[indices[i]] += rightCount;
        temp[k++] = indices[i++];
    }
    while (j <= hi) {
        temp[k++] = indices[j++];
    }
    
    System.arraycopy(temp, 0, indices, lo, hi - lo + 1);
}

// Time: O(n log n) — merge sort.
// Space: O(n) — temporary arrays.
//
// The merge sort approach counts inversions — for each element, how many
// smaller elements were originally to its right. During merge, when a right
// element is placed before a left element, that's a "smaller after self" count.
//
// JVM Insight: System.arraycopy is a JVM intrinsic — it compiles to
// optimized native memory copy (memcpy/memmove). Much faster than a
// manual loop. The JIT recognizes this pattern and may use SIMD instructions.
//
// Real-world correlation: Counting inversions is used in **recommendation
// systems** (Kendall tau distance between two rankings) and in **version
// control** (measuring how "different" two orderings of commits are).
```

### Binary Tree Problems

**P05.11** [E] — Maximum Depth of Binary Tree

Given the root of a binary tree, return its maximum depth (number of nodes along the longest root-to-leaf path).

```java
// LeetCode 104 - Maximum Depth of Binary Tree

public int maxDepth(TreeNode root) {
    if (root == null) return 0;
    return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));
}

// Time: O(n). Space: O(h) recursion stack.
//
// Iterative BFS alternative:
public int maxDepthBFS(TreeNode root) {
    if (root == null) return 0;
    Queue<TreeNode> queue = new LinkedList<>();
    queue.offer(root);
    int depth = 0;
    while (!queue.isEmpty()) {
        int levelSize = queue.size();
        depth++;
        for (int i = 0; i < levelSize; i++) {
            TreeNode node = queue.poll();
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
    }
    return depth;
}

// JVM Insight: The recursive version creates h stack frames. For a balanced
// tree of 1M nodes, h ~ 20, so ~20 frames × ~32 bytes = ~640 bytes.
// Negligible. For a degenerate tree of 1M nodes, h = 1M frames = ~32MB.
// That will blow the default 512KB stack. Use the BFS version for safety
// on unknown inputs.
//
// Real-world correlation: Tree depth calculation is used in **database
// query optimizers** to estimate index lookup cost. InnoDB tracks the
// B+ Tree height to predict I/O for index scans.
```

**P05.12** [E] — Minimum Depth of Binary Tree

Return the minimum depth (shortest root-to-leaf path). A leaf is a node with no children.

```java
// LeetCode 111 - Minimum Depth of Binary Tree
//
// BFS is naturally suited — first leaf encountered is at minimum depth.

public int minDepth(TreeNode root) {
    if (root == null) return 0;
    Queue<TreeNode> queue = new LinkedList<>();
    queue.offer(root);
    int depth = 0;
    
    while (!queue.isEmpty()) {
        depth++;
        int levelSize = queue.size();
        for (int i = 0; i < levelSize; i++) {
            TreeNode node = queue.poll();
            // First leaf found — this is the minimum depth
            if (node.left == null && node.right == null) return depth;
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
    }
    return depth;
}

// Time: O(n) worst case, but often much less (stops at first leaf).
// Space: O(w) where w is the maximum width of the tree.
//
// Common mistake with recursive approach:
//   return 1 + Math.min(minDepth(left), minDepth(right))
// This is WRONG when one child is null — a null child is not a leaf.
//   [1]
//    \
//    [2]  ← min depth is 2, not 1 (root is not a leaf)
//
// Correct recursive version:
public int minDepthRecursive(TreeNode root) {
    if (root == null) return 0;
    if (root.left == null) return 1 + minDepthRecursive(root.right);
    if (root.right == null) return 1 + minDepthRecursive(root.left);
    return 1 + Math.min(minDepthRecursive(root.left), minDepthRecursive(root.right));
}

// JVM Insight: BFS uses a Queue which allocates Node wrappers (if
// LinkedList-backed). Use ArrayDeque for better cache locality:
// Queue<TreeNode> queue = new ArrayDeque<>();
//
// Real-world correlation: Finding the minimum depth is analogous to
// finding the shortest path in **network routing** — BFS naturally
// finds it without exploring the entire graph.
```

**P05.13** [E] — Balanced Binary Tree

Determine if a binary tree is height-balanced (for every node, the heights of its two subtrees differ by at most 1).

```java
// LeetCode 110 - Balanced Binary Tree
//
// Bottom-up approach: compute height and check balance in one pass.
// Return -1 to indicate imbalance (sentinel value).

public boolean isBalanced(TreeNode root) {
    return checkHeight(root) != -1;
}

private int checkHeight(TreeNode node) {
    if (node == null) return 0;
    
    int leftHeight = checkHeight(node.left);
    if (leftHeight == -1) return -1;  // left subtree unbalanced
    
    int rightHeight = checkHeight(node.right);
    if (rightHeight == -1) return -1;  // right subtree unbalanced
    
    if (Math.abs(leftHeight - rightHeight) > 1) return -1;  // current node unbalanced
    
    return 1 + Math.max(leftHeight, rightHeight);
}

// Time: O(n) — each node visited once.
// Space: O(h) — recursion stack.
//
// The naive approach (call height() at every node, then check balance)
// is O(n^2). This bottom-up approach is O(n) — a classic optimization
// that comes up in many tree problems.
//
// JVM Insight: This is a textbook case of early termination reducing
// work. The -1 sentinel propagates up immediately, avoiding computing
// heights of entire subtrees. The JIT optimizes the comparison to -1
// as a simple integer compare + conditional jump.
//
// Real-world correlation: AVL trees use exactly this balance check after
// every insert/delete. The balance factor bf(node) = height(left) -
// height(right) maps directly to this logic.
```

**P05.14** [E] — Diameter of Binary Tree

The diameter is the length of the longest path between any two nodes (number of edges). The path may or may not pass through the root.

```java
// LeetCode 543 - Diameter of Binary Tree

private int diameter = 0;

public int diameterOfBinaryTree(TreeNode root) {
    diameter = 0;
    depth(root);
    return diameter;
}

private int depth(TreeNode node) {
    if (node == null) return 0;
    int leftDepth = depth(node.left);
    int rightDepth = depth(node.right);
    
    // The diameter through this node is leftDepth + rightDepth
    diameter = Math.max(diameter, leftDepth + rightDepth);
    
    // Return the depth (longest single arm)
    return 1 + Math.max(leftDepth, rightDepth);
}

// Time: O(n). Space: O(h).
//
// Key insight: at each node, the longest path THROUGH that node uses the
// deepest branch from the left and the deepest branch from the right.
// The diameter is the maximum such path across all nodes.
//
// JVM Insight: The instance variable `diameter` is accessed via a getfield
// bytecode on every recursive call. The JIT will likely promote it to a
// register for the duration of the recursion. Alternatively, you can avoid
// the instance variable by using an int[] of size 1 (mutable container).
//
// Real-world correlation: Network diameter is a critical metric in
// **distributed systems** — it determines the maximum number of hops
// between any two nodes, which bounds worst-case latency.
```

**P05.15** [E] — Invert Binary Tree

Swap left and right children of every node (mirror the tree).

```java
// LeetCode 226 - Invert Binary Tree
// The famous "Max Howell couldn't invert a binary tree" interview question.

public TreeNode invertTree(TreeNode root) {
    if (root == null) return null;
    
    TreeNode left = invertTree(root.left);
    TreeNode right = invertTree(root.right);
    
    root.left = right;
    root.right = left;
    
    return root;
}

// Time: O(n). Space: O(h).
//
// Iterative BFS version:
public TreeNode invertTreeBFS(TreeNode root) {
    if (root == null) return null;
    Queue<TreeNode> queue = new ArrayDeque<>();
    queue.offer(root);
    while (!queue.isEmpty()) {
        TreeNode node = queue.poll();
        TreeNode temp = node.left;
        node.left = node.right;
        node.right = temp;
        if (node.left != null) queue.offer(node.left);
        if (node.right != null) queue.offer(node.right);
    }
    return root;
}

// JVM Insight: Both versions modify the tree in-place. No new nodes
// allocated — just pointer swaps. Each swap is two reference assignments,
// each a putfield bytecode (4 bytes written per field with compressed OOPs).
//
// Real-world correlation: Mirroring a tree structure is used in **UI
// frameworks** for right-to-left (RTL) layout support. Flutter's
// Directionality widget mirrors the widget tree for RTL locales.
```

**P05.16** [E] — Symmetric Tree

Check if a binary tree is a mirror of itself (symmetric around the center).

```java
// LeetCode 101 - Symmetric Tree

public boolean isSymmetric(TreeNode root) {
    if (root == null) return true;
    return isMirror(root.left, root.right);
}

private boolean isMirror(TreeNode t1, TreeNode t2) {
    if (t1 == null && t2 == null) return true;
    if (t1 == null || t2 == null) return false;
    return t1.val == t2.val
        && isMirror(t1.left, t2.right)
        && isMirror(t1.right, t2.left);
}

// Time: O(n). Space: O(h).
//
// The key insight: symmetry means the left subtree is a mirror of the right
// subtree. We compare left.left with right.right and left.right with right.left.
//
// JVM Insight: The short-circuit && operator means the JIT can skip
// the recursive calls entirely if values don't match. This is branch
// prediction friendly — in a non-symmetric tree, we fail fast.
//
// Real-world correlation: Symmetry checking appears in **compiler
// optimization** — verifying that two expression trees are equivalent
// (with commutative operators reordered) for common subexpression
// elimination.
```

**P05.17** [E] — Same Tree

Given two binary trees, check if they are structurally identical with the same node values.

```java
// LeetCode 100 - Same Tree

public boolean isSameTree(TreeNode p, TreeNode q) {
    if (p == null && q == null) return true;
    if (p == null || q == null) return false;
    return p.val == q.val
        && isSameTree(p.left, q.left)
        && isSameTree(p.right, q.right);
}

// Time: O(min(n1, n2)). Space: O(min(h1, h2)).
//
// Structurally identical to symmetric tree check, but without mirroring.
//
// JVM Insight: For very deep trees, consider an iterative approach with
// two stacks (or two queues for BFS). The recursive version risks
// StackOverflowError on degenerate inputs.
//
// Real-world correlation: **Git** computes tree diffs by comparing tree
// objects. Two commits with identical file trees share the same tree hash
// (SHA-1 of the tree structure). This is essentially a "same tree" check
// at the hash level.
```

**P05.18** [M] — Binary Tree Level Order Traversal

Return the level order traversal as a list of lists (each inner list contains one level's values).

```java
// LeetCode 102 - Binary Tree Level Order Traversal

public List<List<Integer>> levelOrder(TreeNode root) {
    List<List<Integer>> result = new ArrayList<>();
    if (root == null) return result;
    
    Queue<TreeNode> queue = new ArrayDeque<>();
    queue.offer(root);
    
    while (!queue.isEmpty()) {
        int levelSize = queue.size();
        List<Integer> level = new ArrayList<>(levelSize);  // pre-sized
        
        for (int i = 0; i < levelSize; i++) {
            TreeNode node = queue.poll();
            level.add(node.val);
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
        result.add(level);
    }
    
    return result;
}

// Time: O(n). Space: O(w) where w is maximum width (~n/2 for complete tree).
//
// The "levelSize" trick is the canonical BFS template for trees.
// Snapshot the queue size at the start of each level, then process exactly
// that many nodes. Everything added during processing belongs to the next level.
//
// JVM Insight: Pre-sizing the ArrayList with `new ArrayList<>(levelSize)`
// avoids resizing. For a complete binary tree, the last level has n/2
// nodes. Without pre-sizing, the ArrayList would resize ~3 times
// (10 → 15 → 22 → ...), each requiring System.arraycopy.
//
// Real-world correlation: BFS level-order is the backbone of **network
// broadcast** protocols. Each "level" is one hop distance from the source.
// Epidemic/gossip protocols spread information level by level.
```

**P05.19** [M] — Binary Tree Zigzag Level Order Traversal

Same as level order, but alternate left-to-right and right-to-left for each level.

```java
// LeetCode 103 - Binary Tree Zigzag Level Order Traversal

public List<List<Integer>> zigzagLevelOrder(TreeNode root) {
    List<List<Integer>> result = new ArrayList<>();
    if (root == null) return result;
    
    Queue<TreeNode> queue = new ArrayDeque<>();
    queue.offer(root);
    boolean leftToRight = true;
    
    while (!queue.isEmpty()) {
        int levelSize = queue.size();
        LinkedList<Integer> level = new LinkedList<>();
        
        for (int i = 0; i < levelSize; i++) {
            TreeNode node = queue.poll();
            if (leftToRight) {
                level.addLast(node.val);
            } else {
                level.addFirst(node.val);  // reverse by adding to front
            }
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
        
        result.add(level);
        leftToRight = !leftToRight;
    }
    
    return result;
}

// Time: O(n). Space: O(w).
//
// Using LinkedList.addFirst() for reverse levels avoids an explicit
// Collections.reverse() call. addFirst is O(1) for LinkedList.
// Alternative: use an ArrayDeque and add to index 0 (but that is O(n)
// for ArrayList — bad). Or just use ArrayList and reverse odd levels.
//
// JVM Insight: LinkedList.addFirst creates a new Node object (24 bytes)
// per integer. For large levels, this is significant GC pressure.
// Alternative: use ArrayList for all levels, then Collections.reverse()
// on odd levels. reverse() is an in-place swap — O(k/2) with no allocation.
//
// Real-world correlation: Zigzag traversal appears in **printer scan
// patterns** — inkjet heads alternate left-to-right and right-to-left
// for each row (boustrophedon pattern) to minimize travel distance.
```

**P05.20** [M] — Binary Tree Vertical Order Traversal

Return the vertical order traversal: nodes grouped by column (leftmost column first), within each column by row (top first), within each row by value (left first).

```java
// LeetCode 987 - Vertical Order Traversal of a Binary Tree

public List<List<Integer>> verticalTraversal(TreeNode root) {
    // TreeMap: column → list of (row, val) pairs, sorted by column
    TreeMap<Integer, List<int[]>> columnMap = new TreeMap<>();
    
    // BFS with column and row tracking
    Queue<Object[]> queue = new ArrayDeque<>();
    queue.offer(new Object[]{root, 0, 0});  // node, row, col
    
    while (!queue.isEmpty()) {
        Object[] entry = queue.poll();
        TreeNode node = (TreeNode) entry[0];
        int row = (int) entry[1];
        int col = (int) entry[2];
        
        columnMap.computeIfAbsent(col, k -> new ArrayList<>()).add(new int[]{row, node.val});
        
        if (node.left != null) queue.offer(new Object[]{node.left, row + 1, col - 1});
        if (node.right != null) queue.offer(new Object[]{node.right, row + 1, col + 1});
    }
    
    List<List<Integer>> result = new ArrayList<>();
    for (List<int[]> column : columnMap.values()) {
        // Sort by row first, then by value
        column.sort((a, b) -> a[0] != b[0] ? a[0] - b[0] : a[1] - b[1]);
        List<Integer> colValues = new ArrayList<>();
        for (int[] pair : column) colValues.add(pair[1]);
        result.add(colValues);
    }
    
    return result;
}

// Time: O(n log n) due to sorting within columns.
// Space: O(n).
//
// TreeMap ensures columns are iterated in sorted order (leftmost first).
// This is a natural use case for TreeMap — we need sorted keys and we
// don't know the column range in advance.
//
// JVM Insight: Using Object[] as a tuple is a quick hack but creates
// garbage (array + autoboxed ints). For production code, define a record:
// record BFSEntry(TreeNode node, int row, int col) {}
// Records since Java 16 — compact, immutable, proper equals/hashCode.
//
// Real-world correlation: Vertical partitioning of data appears in
// **columnar databases** (Parquet, ORC). Each "column" is stored
// independently for better compression and scan performance.
```

**P05.21** [M] — Binary Tree Right Side View

Return the values of the nodes visible from the right side (one node per level, the rightmost).

```java
// LeetCode 199 - Binary Tree Right Side View

public List<Integer> rightSideView(TreeNode root) {
    List<Integer> result = new ArrayList<>();
    if (root == null) return result;
    
    Queue<TreeNode> queue = new ArrayDeque<>();
    queue.offer(root);
    
    while (!queue.isEmpty()) {
        int levelSize = queue.size();
        for (int i = 0; i < levelSize; i++) {
            TreeNode node = queue.poll();
            if (i == levelSize - 1) {
                result.add(node.val);  // last node in this level
            }
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
    }
    
    return result;
}

// Time: O(n). Space: O(w).
//
// DFS alternative: do a right-first DFS, tracking depth.
// The first node we visit at each depth is the rightmost.
public List<Integer> rightSideViewDFS(TreeNode root) {
    List<Integer> result = new ArrayList<>();
    dfs(root, 0, result);
    return result;
}

private void dfs(TreeNode node, int depth, List<Integer> result) {
    if (node == null) return;
    if (depth == result.size()) result.add(node.val);
    dfs(node.right, depth + 1, result);  // right first!
    dfs(node.left, depth + 1, result);
}

// JVM Insight: The DFS version uses O(h) stack space vs O(w) queue space
// for BFS. For a very wide, shallow tree (e.g., complete binary tree with
// 1M nodes), the bottom level has 500K nodes. BFS queue holds all 500K.
// DFS stack only holds ~20 frames. DFS wins on space for wide trees.
//
// Real-world correlation: "Right side view" is analogous to **shadow
// casting** in computer graphics — only the rightmost element at each
// depth level is "visible" from the right.
```

**P05.22** [E] — Path Sum

Given a binary tree and a target sum, determine if the tree has a root-to-leaf path where all values sum to the target.

```java
// LeetCode 112 - Path Sum

public boolean hasPathSum(TreeNode root, int targetSum) {
    if (root == null) return false;
    
    // Leaf node check
    if (root.left == null && root.right == null) {
        return root.val == targetSum;
    }
    
    int remaining = targetSum - root.val;
    return hasPathSum(root.left, remaining) || hasPathSum(root.right, remaining);
}

// Time: O(n). Space: O(h).
//
// Subtract the current node's value and pass the remainder down.
// At a leaf, check if the remainder equals the leaf's value (i.e., remainder is 0
// after subtracting leaf — which is equivalent to checking val == targetSum
// where targetSum has been reduced along the way).
//
// JVM Insight: The || operator short-circuits. If the left subtree has a
// valid path, the right subtree is never explored. This can cut runtime
// in half on average.
//
// Real-world correlation: Path sum queries appear in **network routing** —
// finding a path from source to destination with total latency under a
// threshold (QoS routing).
```

**P05.23** [M] — Path Sum II

Find ALL root-to-leaf paths where the path sum equals the target. Return the actual paths.

```java
// LeetCode 113 - Path Sum II

public List<List<Integer>> pathSum(TreeNode root, int targetSum) {
    List<List<Integer>> result = new ArrayList<>();
    backtrack(root, targetSum, new ArrayList<>(), result);
    return result;
}

private void backtrack(TreeNode node, int remaining, List<Integer> path,
                       List<List<Integer>> result) {
    if (node == null) return;
    
    path.add(node.val);
    
    if (node.left == null && node.right == null && remaining == node.val) {
        result.add(new ArrayList<>(path));  // copy the path
    }
    
    backtrack(node.left, remaining - node.val, path, result);
    backtrack(node.right, remaining - node.val, path, result);
    
    path.remove(path.size() - 1);  // backtrack
}

// Time: O(n * h) — O(n) nodes visited, each path copy is O(h).
// Space: O(h) for recursion + path list. O(n * h) for output.
//
// Classic backtracking on a tree. The path list is reused across branches
// (add before recursing, remove after) — single allocation, no waste.
//
// JVM Insight: `path.remove(path.size() - 1)` on ArrayList is O(1) — it
// just decrements the size counter and nulls the reference (no shifting).
// `new ArrayList<>(path)` is a copy constructor that calls System.arraycopy
// — O(h) but avoids element-by-element iteration.
//
// Real-world correlation: **Dependency resolution** in build systems (Maven,
// Gradle) traces all paths from root to target, looking for version conflicts
// — structurally identical to path sum with a different "sum" predicate.
```

**P05.24** [H] — Binary Tree Maximum Path Sum

Find the maximum sum path in a binary tree. The path can start and end at any node (does not need to go through root). A path contains at least one node.

```java
// LeetCode 124 - Binary Tree Maximum Path Sum
//
// This is one of the most important hard tree problems.

private int maxSum = Integer.MIN_VALUE;

public int maxPathSum(TreeNode root) {
    maxSum = Integer.MIN_VALUE;
    maxGain(root);
    return maxSum;
}

private int maxGain(TreeNode node) {
    if (node == null) return 0;
    
    // Maximum gain from left and right subtrees
    // Clamp to 0: if a subtree has negative gain, we ignore it (don't extend path)
    int leftGain = Math.max(0, maxGain(node.left));
    int rightGain = Math.max(0, maxGain(node.right));
    
    // Path through this node as the "turning point" (using both branches)
    int pathThroughNode = node.val + leftGain + rightGain;
    maxSum = Math.max(maxSum, pathThroughNode);
    
    // Return the max gain if continuing THROUGH this node (can only use one branch)
    return node.val + Math.max(leftGain, rightGain);
}

// Time: O(n). Space: O(h).
//
// The trick: at each node, we compute two things:
// 1. The best path that GOES THROUGH this node (using both left and right arms).
//    This updates the global maximum.
// 2. The best SINGLE-ARM path from this node upward (to report to the parent).
//    A path can only go through a node once, so we can only extend one arm upward.
//
// The Math.max(0, ...) is crucial — we never extend into a subtree that
// would decrease our sum. If leftGain is -5, we treat it as 0 (don't go left).
//
// JVM Insight: Integer.MIN_VALUE is -2^31. Using it as initial maxSum handles
// trees with all negative values correctly. The Math.max calls compile to
// simple compare-and-branch instructions — no method call overhead after
// JIT inlining.
//
// Real-world correlation: Maximum path sum is structurally identical to
// finding the **most profitable trading path** in a market graph — each
// node is a transaction with a profit/loss, and you want the most
// profitable sequence.
```

**P05.25** [H] — Serialize and Deserialize Binary Tree

Design an algorithm to serialize a binary tree to a string and deserialize it back.

```java
// LeetCode 297 - Serialize and Deserialize Binary Tree

public class Codec {
    
    // Serialize: preorder traversal, using "null" for null nodes.
    public String serialize(TreeNode root) {
        StringBuilder sb = new StringBuilder();
        serializeHelper(root, sb);
        return sb.toString();
    }
    
    private void serializeHelper(TreeNode node, StringBuilder sb) {
        if (node == null) {
            sb.append("null,");
            return;
        }
        sb.append(node.val).append(",");
        serializeHelper(node.left, sb);
        serializeHelper(node.right, sb);
    }
    
    // Deserialize: read tokens in preorder, reconstruct tree.
    public TreeNode deserialize(String data) {
        Queue<String> tokens = new ArrayDeque<>(Arrays.asList(data.split(",")));
        return deserializeHelper(tokens);
    }
    
    private TreeNode deserializeHelper(Queue<String> tokens) {
        String token = tokens.poll();
        if ("null".equals(token) || token == null) return null;
        
        TreeNode node = new TreeNode(Integer.parseInt(token));
        node.left = deserializeHelper(tokens);
        node.right = deserializeHelper(tokens);
        return node;
    }
}

// Time: O(n) for both serialize and deserialize.
// Space: O(n) for the string/queue.
//
// Why preorder works: preorder visits root first, so the first token is
// the root. The null markers tell us exactly where each subtree ends.
// We don't need both preorder + inorder because the nulls provide the
// structural information that inorder would normally supply.
//
// JVM Insight: StringBuilder is crucial here. String concatenation with +
// in a loop creates O(n) intermediate String objects, each requiring a
// copy. StringBuilder maintains a single char[] (or byte[] since JDK 9 with
// compact strings) and appends in-place. For a tree of 1M nodes, this is
// the difference between O(n) and O(n^2) time.
//
// data.split(",") creates a String[] and n String objects. For very large
// trees, consider a streaming tokenizer that doesn't split the entire string
// upfront.
//
// Real-world correlation: **Protocol Buffers** and **Avro** serialize tree
// structures similarly — preorder with length prefixes instead of null markers.
// **Redis** RDB format serializes sorted sets (skip lists) as sorted arrays.
```

**P05.26** [M] — Construct Binary Tree from Preorder and Inorder Traversal

Given preorder and inorder traversal arrays, reconstruct the binary tree.

```java
// LeetCode 105 - Construct Binary Tree from Preorder and Inorder Traversal

private int preIdx = 0;
private Map<Integer, Integer> inorderMap;

public TreeNode buildTree(int[] preorder, int[] inorder) {
    preIdx = 0;
    inorderMap = new HashMap<>();
    for (int i = 0; i < inorder.length; i++) {
        inorderMap.put(inorder[i], i);
    }
    return build(preorder, 0, inorder.length - 1);
}

private TreeNode build(int[] preorder, int inLeft, int inRight) {
    if (inLeft > inRight) return null;
    
    int rootVal = preorder[preIdx++];
    TreeNode root = new TreeNode(rootVal);
    
    int inIdx = inorderMap.get(rootVal);  // O(1) lookup
    
    root.left = build(preorder, inLeft, inIdx - 1);
    root.right = build(preorder, inIdx + 1, inRight);
    
    return root;
}

// Time: O(n). Space: O(n) for the HashMap.
//
// Key insight:
// - Preorder's first element is always the root.
// - In inorder, everything LEFT of the root is in the left subtree,
//   everything RIGHT is in the right subtree.
// - We use the HashMap to find the root's position in inorder in O(1).
// - We advance preIdx globally — preorder guarantees we visit roots
//   in the correct order (root → left subtree roots → right subtree roots).
//
// JVM Insight: HashMap lookup is O(1) amortized. For integer keys, the
// hash is the integer itself (Integer.hashCode() returns the value).
// The perturbation in HashMap spreads these well enough for small maps.
//
// Real-world correlation: Reconstructing a tree from traversals is used
// in **compiler front-ends** — the parser reconstructs the AST from a
// linearized token stream (which is essentially a preorder traversal of
// the parse tree).
```

**P05.27** [M] — Construct Binary Tree from Inorder and Postorder Traversal

```java
// LeetCode 106 - Construct Binary Tree from Inorder and Postorder Traversal

private int postIdx;
private Map<Integer, Integer> inorderIndex;

public TreeNode buildTreeFromPostIn(int[] inorder, int[] postorder) {
    postIdx = postorder.length - 1;
    inorderIndex = new HashMap<>();
    for (int i = 0; i < inorder.length; i++) {
        inorderIndex.put(inorder[i], i);
    }
    return buildPost(postorder, 0, inorder.length - 1);
}

private TreeNode buildPost(int[] postorder, int inLeft, int inRight) {
    if (inLeft > inRight) return null;
    
    int rootVal = postorder[postIdx--];
    TreeNode root = new TreeNode(rootVal);
    
    int inIdx = inorderIndex.get(rootVal);
    
    // Build RIGHT subtree first (postorder reads backwards: root, right, left)
    root.right = buildPost(postorder, inIdx + 1, inRight);
    root.left = buildPost(postorder, inLeft, inIdx - 1);
    
    return root;
}

// Time: O(n). Space: O(n).
//
// Mirror of preorder+inorder: postorder's LAST element is the root.
// Reading postorder backwards gives: root → right subtree → left subtree.
// So we build the right subtree BEFORE the left subtree.
//
// JVM Insight: Same optimization as P05.26 — HashMap for O(1) index lookup.
// The decrementing postIdx is a single field read + decrement, which the
// JIT can keep in a register across recursive calls.
//
// Real-world correlation: Postorder traversal is how **expression tree
// evaluation** works — evaluate children before the operator. RPN (Reverse
// Polish Notation) is literally a postorder traversal of the expression tree.
```

**P05.28** [M] — Lowest Common Ancestor of a Binary Tree

Given a binary tree (not BST) and two nodes p and q, find their lowest common ancestor.

```java
// LeetCode 236 - Lowest Common Ancestor of a Binary Tree

public TreeNode lowestCommonAncestor(TreeNode root, TreeNode p, TreeNode q) {
    if (root == null || root == p || root == q) return root;
    
    TreeNode left = lowestCommonAncestor(root.left, p, q);
    TreeNode right = lowestCommonAncestor(root.right, p, q);
    
    if (left != null && right != null) return root;  // p and q are in different subtrees
    return left != null ? left : right;
}

// Time: O(n). Space: O(h).
//
// This elegant solution works by recursion:
// - If current node is p or q, return it (it might be the LCA itself).
// - Search left subtree and right subtree.
// - If both return non-null, current node is the LCA (p and q split here).
// - If only one returns non-null, that result is the LCA (both nodes are
//   in the same subtree).
//
// For a BST, we can do better: use the BST property to determine which
// subtree to explore (O(h) without visiting all nodes).
//
// JVM Insight: This is a great example of how recursion simplifies code.
// The iterative version requires tracking visited ancestors with a map —
// significantly more complex and more memory (HashMap overhead).
//
// Real-world correlation: LCA is used in **version control** (git merge-base),
// **IP routing** (longest prefix match in a trie), and **taxonomy** (finding
// the common ancestor of two species in a phylogenetic tree).
```

**P05.29** [M] — Flatten Binary Tree to Linked List

Flatten a binary tree into a linked list in-place, using the right pointer as the "next" pointer, following preorder traversal order.

```java
// LeetCode 114 - Flatten Binary Tree to Linked List
//
// Morris-like approach: for each node, find the rightmost node of its left
// subtree and connect it to the right child.

public void flatten(TreeNode root) {
    TreeNode current = root;
    while (current != null) {
        if (current.left != null) {
            // Find the rightmost node of left subtree
            TreeNode rightmost = current.left;
            while (rightmost.right != null) {
                rightmost = rightmost.right;
            }
            // Connect rightmost to current's right child
            rightmost.right = current.right;
            // Move left subtree to right
            current.right = current.left;
            current.left = null;
        }
        current = current.right;
    }
}

// Time: O(n). Space: O(1) — no recursion, no stack.
//
// This is O(n) despite the inner while loop because each node is visited
// at most twice (once as `current`, once while finding `rightmost`).
//
// Alternative recursive approach (reverse postorder):
private TreeNode prev = null;
public void flattenRecursive(TreeNode root) {
    if (root == null) return;
    flattenRecursive(root.right);
    flattenRecursive(root.left);
    root.right = prev;
    root.left = null;
    prev = root;
}

// JVM Insight: The O(1) space iterative approach is better for JVM because
// it avoids recursion stack. For a degenerate left-leaning tree with 1M
// nodes, the recursive version would create 1M stack frames.
//
// Real-world correlation: Flattening a tree to a list is analogous to
// **linearizing a file system** for backup (tar) — the hierarchical
// directory tree becomes a sequential stream of entries.
```

**P05.30** [M] — Populating Next Right Pointers in Each Node

Given a perfect binary tree, connect each node to its next right node at the same level. The rightmost node at each level should point to null.

```java
// LeetCode 116 - Populating Next Right Pointers in Each Node

public Node connect(Node root) {
    if (root == null) return null;
    
    Node leftmost = root;
    while (leftmost.left != null) {  // while not at leaf level
        Node head = leftmost;
        while (head != null) {
            // Connection 1: left child → right child (same parent)
            head.left.next = head.right;
            
            // Connection 2: right child → next node's left child (across parents)
            if (head.next != null) {
                head.right.next = head.next.left;
            }
            
            head = head.next;  // move to next node at this level
        }
        leftmost = leftmost.left;  // move to next level
    }
    
    return root;
}

// Time: O(n). Space: O(1) — using the next pointers themselves for traversal.
//
// The trick: use the next pointers we already established at level L to
// traverse level L and connect level L+1. No queue needed.
//
// For non-perfect trees (LeetCode 117), a similar approach works but
// requires more careful handling of null children and using a dummy head
// for the next level.
//
// JVM Insight: O(1) space means zero GC pressure. Each iteration modifies
// existing pointers — no new objects created. This is the kind of algorithm
// that systems engineers love: no allocation, no garbage, deterministic memory.
//
// Real-world correlation: The "next pointer" pattern is used in **concurrent
// skip lists** (ConcurrentSkipListMap) where each level has forward pointers
// to the next node at that level.
```

**P05.31** [M] — Count Complete Tree Nodes

Given a complete binary tree, count the total number of nodes. Do better than O(n).

```java
// LeetCode 222 - Count Complete Tree Nodes
//
// A complete binary tree has all levels fully filled except possibly the last,
// which is filled from left to right.
//
// Key insight: if leftHeight == rightHeight, the tree is perfect and has
// 2^h - 1 nodes. Otherwise, recurse on left and right subtrees.

public int countNodes(TreeNode root) {
    if (root == null) return 0;
    
    int leftHeight = getLeftHeight(root);
    int rightHeight = getRightHeight(root);
    
    if (leftHeight == rightHeight) {
        // Perfect binary tree: 2^h - 1 nodes
        return (1 << leftHeight) - 1;
    }
    
    // Not perfect: count recursively
    return 1 + countNodes(root.left) + countNodes(root.right);
}

private int getLeftHeight(TreeNode node) {
    int h = 0;
    while (node != null) { h++; node = node.left; }
    return h;
}

private int getRightHeight(TreeNode node) {
    int h = 0;
    while (node != null) { h++; node = node.right; }
    return h;
}

// Time: O(log^2 n) — we do O(log n) recursive calls, each computing
// height in O(log n). Much better than O(n) for large complete trees.
// Space: O(log n) — recursion depth.
//
// Why O(log^2 n): At each level of recursion, one subtree is guaranteed
// to be perfect (and resolved in O(log n) for height computation). The
// non-perfect subtree recurses. There are at most O(log n) such levels.
//
// JVM Insight: `1 << leftHeight` is a bit shift — single CPU cycle. For
// h up to 30, this computes 2^h as an int. For h > 30, need 1L << h
// to avoid overflow.
//
// Real-world correlation: **Heap-based priority queues** (PriorityQueue)
// are always complete binary trees stored in arrays. Knowing the exact
// count determines the array index of the last element, which is critical
// for heap operations.
```

**P05.32** [M] — House Robber III

A thief robs houses arranged in a binary tree. Adjacent nodes (parent-child) cannot both be robbed. Find the maximum amount.

```java
// LeetCode 337 - House Robber III
//
// For each node, compute two values:
// 1. Max money if we ROB this node (then we cannot rob its children)
// 2. Max money if we SKIP this node (we can rob or skip children)

public int rob(TreeNode root) {
    int[] result = robHelper(root);
    return Math.max(result[0], result[1]);
}

private int[] robHelper(TreeNode node) {
    if (node == null) return new int[]{0, 0};
    
    int[] left = robHelper(node.left);
    int[] right = robHelper(node.right);
    
    // result[0] = max money if we ROB this node
    int robThis = node.val + left[1] + right[1];  // skip both children
    
    // result[1] = max money if we SKIP this node
    int skipThis = Math.max(left[0], left[1]) + Math.max(right[0], right[1]);
    
    return new int[]{robThis, skipThis};
}

// Time: O(n). Space: O(h).
//
// This is tree DP — dynamic programming on a tree structure.
// Each node returns a pair [rob, skip] to its parent.
// No memoization needed because each node is visited exactly once.
//
// Common mistake: using HashMap to memoize — that works but is O(n)
// space for the map. The pair-return approach is cleaner and uses
// only O(h) space.
//
// JVM Insight: Each recursive call allocates a new int[2] (24 bytes:
// 12 header + 4 length + 8 data). For n nodes, that is n small arrays.
// The GC handles these quickly since they are short-lived (consumed by
// the parent call and immediately eligible for collection).
//
// Real-world correlation: This is an **independent set** problem on a tree.
// Independent set on general graphs is NP-hard, but on trees it is solvable
// in O(n) via tree DP. This pattern appears in **network security** —
// placing firewalls at non-adjacent nodes to maximize coverage.
```

**P05.33** [H] — Binary Tree Maximum Path Sum (already covered as P05.24)

*(Covered above as P05.24 — Binary Tree Maximum Path Sum)*

**P05.34** [M] — Serialize and Deserialize BST

Design a more efficient serialization specifically for BSTs (not general binary trees). Since BSTs have the ordering property, we need less information.

```java
// LeetCode 449 - Serialize and Deserialize BST
//
// For a BST, preorder alone is sufficient (no null markers needed).
// The BST property tells us how to split left and right subtrees.

public class CodecBST {
    
    public String serialize(TreeNode root) {
        StringBuilder sb = new StringBuilder();
        serializePreorder(root, sb);
        return sb.toString();
    }
    
    private void serializePreorder(TreeNode node, StringBuilder sb) {
        if (node == null) return;
        sb.append(node.val).append(",");
        serializePreorder(node.left, sb);
        serializePreorder(node.right, sb);
    }
    
    public TreeNode deserialize(String data) {
        if (data.isEmpty()) return null;
        String[] tokens = data.split(",");
        int[] values = new int[tokens.length];
        for (int i = 0; i < tokens.length; i++) {
            values[i] = Integer.parseInt(tokens[i]);
        }
        return buildBST(values, new int[]{0}, Integer.MIN_VALUE, Integer.MAX_VALUE);
    }
    
    private TreeNode buildBST(int[] values, int[] idx, int min, int max) {
        if (idx[0] >= values.length) return null;
        int val = values[idx[0]];
        if (val < min || val > max) return null;
        
        TreeNode node = new TreeNode(val);
        idx[0]++;
        node.left = buildBST(values, idx, min, val);
        node.right = buildBST(values, idx, val, max);
        return node;
    }
}

// Time: O(n). Space: O(n).
//
// No null markers needed — savings of ~50% in serialized size compared
// to the general binary tree codec. The BST property constrains where
// each value can appear.
//
// JVM Insight: Using int[] for the index (pass by reference simulation)
// is a common Java pattern to work around Java's pass-by-value semantics
// for primitives. A mutable AtomicInteger also works but has CAS overhead.
//
// Real-world correlation: **Database WAL (Write-Ahead Log)** serializes
// B-Tree modifications as key ranges rather than full tree structures —
// same idea of leveraging ordering to compress the representation.
```

**P05.35** [H] — Construct Binary Tree from Preorder Traversal with Null Markers

*(This is a variant of P05.25 — already covered in Serialize/Deserialize)*

**P05.36** [M] — Binary Search Tree Iterator

Implement an iterator over a BST that returns elements in sorted order.

```java
// LeetCode 173 - Binary Search Tree Iterator
//
// Uses a controlled in-order traversal with an explicit stack.

public class BSTIterator {
    private Deque<TreeNode> stack;
    
    public BSTIterator(TreeNode root) {
        stack = new ArrayDeque<>();
        pushAllLeft(root);
    }
    
    public int next() {
        TreeNode node = stack.pop();
        pushAllLeft(node.right);  // process right subtree
        return node.val;
    }
    
    public boolean hasNext() {
        return !stack.isEmpty();
    }
    
    private void pushAllLeft(TreeNode node) {
        while (node != null) {
            stack.push(node);
            node = node.left;
        }
    }
}

// next() is O(1) amortized, O(h) worst case.
// hasNext() is O(1).
// Space: O(h) — the stack holds at most h nodes.
//
// This is exactly how TreeMap's iterator works internally — it maintains
// a "cursor" that follows the successor chain.
//
// JVM Insight: ArrayDeque as a stack is optimal. No Node allocations
// (unlike LinkedList-based Stack). The internal array is typically
// sized to a power of 2 (default 16 elements), which is more than
// enough for tree heights up to 16 (~65K nodes).
//
// Real-world correlation: Database cursor implementations (JDBC
// ResultSet.next()) follow the same pattern — maintain state about
// the current position and advance to the next row on demand.
```

**P05.37** [M] — Validate Binary Search Tree (In-Order Approach)

Alternative approach to P05.01 using in-order traversal.

```java
// LeetCode 98 - Alternative: In-order traversal validates BST
//
// In-order traversal of a valid BST produces a strictly increasing sequence.

public boolean isValidBSTInorder(TreeNode root) {
    Deque<TreeNode> stack = new ArrayDeque<>();
    TreeNode current = root;
    TreeNode prev = null;
    
    while (current != null || !stack.isEmpty()) {
        while (current != null) {
            stack.push(current);
            current = current.left;
        }
        current = stack.pop();
        
        // Check strictly increasing
        if (prev != null && current.val <= prev.val) {
            return false;
        }
        prev = current;
        current = current.right;
    }
    return true;
}

// Time: O(n). Space: O(h).
//
// This approach is arguably more intuitive: "Is the in-order traversal
// strictly increasing?" It fails the moment we see a non-increasing pair.
//
// JVM Insight: Comparing TreeNode references (prev != null) is a single
// null check — compiled to a test/jz instruction pair. No method call.
//
// Real-world correlation: Validating sorted order of a data stream is
// a common integrity check in **log-structured merge trees** (LSM Trees)
// used by **LevelDB**, **RocksDB**, and **Cassandra**. Each SSTable
// must have keys in sorted order.
```

**P05.38** [H] — Recover Binary Search Tree

Two nodes in a BST were swapped by mistake. Recover the tree without changing its structure.

```java
// LeetCode 99 - Recover Binary Search Tree
//
// In-order traversal should be strictly increasing.
// Two swapped nodes create either one or two "inversions."

private TreeNode first = null, second = null, prev = null;

public void recoverTree(TreeNode root) {
    first = null; second = null; prev = null;
    inorderFind(root);
    // Swap the values of the two misplaced nodes
    int temp = first.val;
    first.val = second.val;
    second.val = temp;
}

private void inorderFind(TreeNode node) {
    if (node == null) return;
    
    inorderFind(node.left);
    
    if (prev != null && prev.val > node.val) {
        if (first == null) {
            first = prev;  // first inversion: first = the larger node
        }
        second = node;  // second inversion (or same): second = the smaller node
    }
    prev = node;
    
    inorderFind(node.right);
}

// Time: O(n). Space: O(h) for recursion (O(1) with Morris traversal).
//
// If the two swapped nodes are adjacent in in-order: one inversion.
//   first = prev, second = current (from the single inversion)
// If they are non-adjacent: two inversions.
//   first = prev from first inversion, second = current from second inversion.
// Setting second in both cases handles both scenarios.
//
// JVM Insight: Morris traversal can reduce space to O(1) by threading
// the tree (modifying right pointers temporarily). This is used in
// production when memory is extremely constrained. But for interviews,
// the recursive solution is clearer and accepted.
//
// Real-world correlation: Detecting and repairing data corruption in a
// sorted index is exactly this problem. **PostgreSQL's** amcheck
// extension validates B-Tree indexes by checking sorted order — if two
// entries are swapped, it is the same "recover BST" problem.
```

**P05.39** [M] — Lowest Common Ancestor of a BST

For a BST (not general binary tree), find LCA of two nodes. The BST property gives us a faster solution.

```java
// LeetCode 235 - Lowest Common Ancestor of a BST

public TreeNode lowestCommonAncestorBST(TreeNode root, TreeNode p, TreeNode q) {
    TreeNode current = root;
    while (current != null) {
        if (p.val < current.val && q.val < current.val) {
            current = current.left;   // both in left subtree
        } else if (p.val > current.val && q.val > current.val) {
            current = current.right;  // both in right subtree
        } else {
            return current;  // split point — this is the LCA
        }
    }
    return null;
}

// Time: O(h). Space: O(1) — iterative.
//
// The first node where p and q "split" (go to different subtrees, or one
// of them equals the node) is the LCA. Much simpler than the general
// binary tree version.
//
// JVM Insight: This tight loop with two comparisons per iteration is
// branch-prediction friendly. The CPU will predict "go left" or "go right"
// based on recent history, and the prediction will usually be correct
// since p and q values don't change.
//
// Real-world correlation: **IP routing** with longest prefix match in a
// binary trie — the LCA of two IP addresses is their longest common prefix.
```

**P05.40** [H] — Binary Tree Cameras

Place the minimum number of cameras on tree nodes such that every node is monitored (a camera monitors itself, its parent, and its children).

```java
// LeetCode 968 - Binary Tree Cameras
//
// Greedy tree DP. Each node is in one of three states:
// 0 = needs monitoring (leaf or uncovered)
// 1 = has a camera
// 2 = monitored (by a child's camera)

private int cameras = 0;

public int minCameraCover(TreeNode root) {
    cameras = 0;
    if (dfsCamera(root) == 0) cameras++;  // root needs monitoring
    return cameras;
}

private int dfsCamera(TreeNode node) {
    if (node == null) return 2;  // null nodes are "monitored" (boundary)
    
    int left = dfsCamera(node.left);
    int right = dfsCamera(node.right);
    
    // If any child needs monitoring, we MUST place a camera here
    if (left == 0 || right == 0) {
        cameras++;
        return 1;  // this node has a camera
    }
    
    // If any child has a camera, this node is monitored
    if (left == 1 || right == 1) {
        return 2;  // monitored
    }
    
    // Both children are monitored but no camera nearby
    return 0;  // needs monitoring
}

// Time: O(n). Space: O(h).
//
// The greedy insight: never place cameras on leaves. Instead, place them
// on the parents of leaves. This ensures each camera covers 3 nodes
// (maximum coverage). Work bottom-up.
//
// JVM Insight: The three-state return eliminates the need for a Map or
// auxiliary data structure. Three int values fit in a register — the JIT
// optimizes this to a simple comparison chain.
//
// Real-world correlation: This is a **minimum dominating set** problem on
// a tree. In **network monitoring**, placing sensors (cameras) at strategic
// nodes to cover all links — same optimization problem.
```

### TreeMap-Specific Problems

**P05.41** [M] — My Calendar I

Implement a calendar that checks for double booking. A new event [start, end) can be added only if it does not conflict with existing events.

```java
// LeetCode 729 - My Calendar I
//
// Use TreeMap to maintain events sorted by start time.
// For a new event [start, end), check:
// - The event just before start: does it overlap? (its end > start)
// - The event just after start: does it overlap? (start < its start < end)

public class MyCalendar {
    private TreeMap<Integer, Integer> events;  // start → end
    
    public MyCalendar() {
        events = new TreeMap<>();
    }
    
    public boolean book(int start, int end) {
        // Find the closest event that starts BEFORE (or at) this start
        Map.Entry<Integer, Integer> prev = events.floorEntry(start);
        if (prev != null && prev.getValue() > start) {
            return false;  // previous event's end overlaps our start
        }
        
        // Find the closest event that starts AFTER this start
        Map.Entry<Integer, Integer> next = events.ceilingEntry(start);
        if (next != null && next.getKey() < end) {
            return false;  // next event's start is before our end
        }
        
        events.put(start, end);
        return true;
    }
}

// Time: O(log n) per booking. Space: O(n).
//
// floorEntry and ceilingEntry are O(log n) — Red-Black tree traversals.
// This is the canonical use case for NavigableMap: finding neighbors
// in a sorted key space.
//
// JVM Insight: TreeMap.floorEntry() calls getFloorEntry() which walks
// the Red-Black tree, tracking the best candidate. It is the same
// algorithm we discussed in section 5.4. Each step is a comparison +
// pointer chase — about 5ns per level on modern hardware.
//
// Real-world correlation: **Interval scheduling** with TreeMap is used
// in meeting room booking systems, resource allocation, and **database
// lock managers** (tracking locked key ranges in InnoDB's gap locks).
```

**P05.42** [M] — My Calendar II (Overlapping Intervals)

Allow up to 2 overlapping bookings (double booking OK). Reject if it would create a triple booking.

```java
// LeetCode 731 - My Calendar II
//
// Use a TreeMap as a "sweep line" event counter.
// +1 at start, -1 at end. If prefix sum ever reaches 3, reject.

public class MyCalendarTwo {
    private TreeMap<Integer, Integer> timeline;
    
    public MyCalendarTwo() {
        timeline = new TreeMap<>();
    }
    
    public boolean book(int start, int end) {
        timeline.merge(start, 1, Integer::sum);
        timeline.merge(end, -1, Integer::sum);
        
        // Check if any point has 3+ overlapping events
        int active = 0;
        for (int delta : timeline.values()) {
            active += delta;
            if (active >= 3) {
                // Rollback
                timeline.merge(start, -1, Integer::sum);
                timeline.merge(end, 1, Integer::sum);
                if (timeline.get(start) == 0) timeline.remove(start);
                if (timeline.get(end) == 0) timeline.remove(end);
                return false;
            }
        }
        return true;
    }
}

// Time: O(n) per booking (scan all events). Space: O(n).
//
// The TreeMap keeps events sorted by time. The sweep line computes
// a running count of active events. If it hits 3, we reject and rollback.
//
// Optimization: only scan from start to end instead of the full timeline.
// Use subMap(start, end) to limit the scan — still O(k) where k is
// events in the range, but much better in practice.
//
// JVM Insight: TreeMap.merge() does a get + put in one traversal when
// the key doesn't exist, but two traversals when it does (get existing,
// apply function, put back). For hot paths, consider computeIfAbsent
// + manual increment.
//
// Real-world correlation: The sweep line / event counter pattern is used
// in **cloud resource scheduling** (AWS Lambda concurrency limits),
// **network bandwidth management**, and **database connection pooling**
// (tracking active connections over time).
```

**P05.43** [M] — Stock Price Fluctuation

Design a data structure that supports: update price at timestamp, get latest price, get maximum price, get minimum price.

```java
// LeetCode 2034 - Stock Price Fluctuation
//
// TreeMap for min/max tracking, HashMap for timestamp→price mapping.

public class StockPrice {
    private Map<Integer, Integer> timestampToPrice;
    private TreeMap<Integer, Integer> priceCount;  // price → count
    private int latestTimestamp;
    
    public StockPrice() {
        timestampToPrice = new HashMap<>();
        priceCount = new TreeMap<>();
        latestTimestamp = 0;
    }
    
    public void update(int timestamp, int price) {
        // Remove old price if this timestamp was already recorded
        if (timestampToPrice.containsKey(timestamp)) {
            int oldPrice = timestampToPrice.get(timestamp);
            priceCount.merge(oldPrice, -1, Integer::sum);
            if (priceCount.get(oldPrice) == 0) {
                priceCount.remove(oldPrice);
            }
        }
        
        timestampToPrice.put(timestamp, price);
        priceCount.merge(price, 1, Integer::sum);
        latestTimestamp = Math.max(latestTimestamp, timestamp);
    }
    
    public int current() {
        return timestampToPrice.get(latestTimestamp);
    }
    
    public int maximum() {
        return priceCount.lastKey();  // O(log n) — rightmost node
    }
    
    public int minimum() {
        return priceCount.firstKey();  // O(log n) — leftmost node
    }
}

// update: O(log n). current: O(1). maximum: O(log n). minimum: O(log n).
// Space: O(n).
//
// The TreeMap maps price → count (how many timestamps have this price).
// firstKey() and lastKey() give min and max prices.
// When a timestamp is updated, we decrement the old price's count and
// increment the new price's count.
//
// JVM Insight: Using TreeMap<Integer, Integer> means every key and value
// is boxed. For 1M price updates, that is 2M Integer objects minimum.
// In a production system, you might use a primitive-specialized sorted
// structure (e.g., from Eclipse Collections or Agrona).
//
// Real-world correlation: This is exactly how **real-time market data
// systems** work — maintaining a sorted order book (bid/ask prices)
// with counts at each price level. TreeMap's O(log n) operations are
// adequate for thousands of updates per second.
```

**P05.44** [M] — Count Integers in Ranges

Given a stream of integers and range queries [lo, hi], efficiently count integers in each range.

```java
// Using TreeMap to maintain sorted data for range counting.

public class RangeCounter {
    private TreeMap<Integer, Integer> countMap;  // value → cumulative count
    
    // Alternative approach using TreeMap.subMap:
    private TreeMap<Integer, Integer> valueCount;  // value → count
    
    public RangeCounter() {
        valueCount = new TreeMap<>();
    }
    
    public void add(int val) {
        valueCount.merge(val, 1, Integer::sum);
    }
    
    public int countInRange(int lo, int hi) {
        // subMap(lo, true, hi, true) returns a view of [lo, hi]
        int count = 0;
        for (int c : valueCount.subMap(lo, true, hi, true).values()) {
            count += c;
        }
        return count;
    }
    
    // Time: add is O(log n). countInRange is O(k + log n) where k is
    // distinct values in [lo, hi].
    //
    // For O(log n) range counting, augment with a Fenwick tree or segment tree
    // (covered in Chapter 9). TreeMap alone cannot do O(log n) range SUM
    // because it doesn't store prefix sums.
}

// JVM Insight: TreeMap.subMap() returns a NavigableMap view backed by the
// original tree — no data copied. Iterating the view traverses the tree
// in-order from the lower bound. This is O(log n) to find the start +
// O(k) to iterate through k elements.
//
// Real-world correlation: Range counting is the backbone of **database
// histograms** used by query optimizers. InnoDB maintains histograms of
// column value distributions to estimate selectivity of WHERE clauses.
// The histogram is essentially a sorted structure with range counts.
```

**P05.45** [H] — Merge Intervals Using TreeMap

Given a set of intervals, efficiently support adding a new interval and merging overlapping intervals.

```java
// Design: Maintain non-overlapping intervals in a TreeMap<Integer, Integer>
// where key = start, value = end. When adding a new interval, merge with
// all overlapping intervals.

public class IntervalMerger {
    private TreeMap<Integer, Integer> intervals;  // start → end
    
    public IntervalMerger() {
        intervals = new TreeMap<>();
    }
    
    public void addInterval(int start, int end) {
        if (start >= end) return;
        
        // Find the first interval that could overlap
        Map.Entry<Integer, Integer> entry = intervals.floorEntry(start);
        if (entry != null && entry.getValue() >= start) {
            // Merge: extend the start to the earlier one
            start = entry.getKey();
            end = Math.max(end, entry.getValue());
            intervals.remove(entry.getKey());
        }
        
        // Absorb all intervals that overlap with [start, end)
        while (true) {
            entry = intervals.ceilingEntry(start);
            if (entry != null && entry.getKey() <= end) {
                end = Math.max(end, entry.getValue());
                intervals.remove(entry.getKey());
            } else {
                break;
            }
        }
        
        intervals.put(start, end);
    }
    
    public List<int[]> getIntervals() {
        List<int[]> result = new ArrayList<>();
        for (Map.Entry<Integer, Integer> e : intervals.entrySet()) {
            result.add(new int[]{e.getKey(), e.getValue()});
        }
        return result;
    }
}

// addInterval: O(k log n) where k is the number of intervals absorbed.
// In aggregate, each interval is added and removed at most once → amortized O(log n).
//
// Space: O(n) for the TreeMap.
//
// JVM Insight: floorEntry and ceilingEntry each do one tree traversal.
// The while loop removes overlapping intervals — each remove is O(log n).
// But the amortized analysis shows that the total number of removes across
// all addInterval calls is O(n), so the amortized cost per add is O(log n).
//
// Real-world correlation: **InnoDB gap locks** maintain a set of locked
// key ranges in a TreeMap-like structure. When a transaction locks a range,
// adjacent locked ranges are merged. This is exactly the interval merging
// pattern.
```

### Additional Tree Problems

**P05.46** [E] — Convert Sorted List to Binary Search Tree

```java
// LeetCode 109 - Convert Sorted List to BST
//
// Similar to sorted array → BST, but we don't have O(1) random access.
// Two approaches: (1) convert to array first, (2) simulate in-order.

// Approach: Simulate in-order traversal. Advance a list pointer as we
// build nodes from left to right.

private ListNode current;

public TreeNode sortedListToBST(ListNode head) {
    int length = 0;
    ListNode p = head;
    while (p != null) { length++; p = p.next; }
    
    current = head;
    return buildFromList(0, length - 1);
}

private TreeNode buildFromList(int left, int right) {
    if (left > right) return null;
    
    int mid = left + (right - left) / 2;
    
    // Build left subtree first (this advances current)
    TreeNode leftChild = buildFromList(left, mid - 1);
    
    // Current node
    TreeNode node = new TreeNode(current.val);
    node.left = leftChild;
    current = current.next;  // advance list pointer
    
    // Build right subtree
    node.right = buildFromList(mid + 1, right);
    
    return node;
}

// Time: O(n). Space: O(log n) recursion.
//
// The trick: in-order traversal of the BST visits nodes in sorted order,
// which matches the linked list order. So we build left subtree first
// (which advances the list pointer through the first half), then create
// the current node, then build right subtree.
//
// JVM Insight: The `current` field simulates pass-by-reference. Each
// recursive call advances it. This is a functional programming pattern
// (threading state through recursive calls) adapted for Java's
// pass-by-value semantics.
//
// Real-world correlation: Building a B-Tree from sorted input (bulk load)
// uses the same sequential-access pattern — read the next key, don't
// backtrack. This is why sorted input is ideal for index building.
```

**P05.47** [E] — Two Sum IV — Input is a BST

Given a BST and a target value k, return true if there exist two elements that sum to k.

```java
// LeetCode 653 - Two Sum IV - Input is a BST
//
// In-order traversal produces a sorted array. Then two-pointer technique.
// Or: use a HashSet during traversal (O(n) time, O(n) space).
// Or: BST iterator from both ends (O(h) space).

// Approach: Two BST iterators — one forward (smallest to largest),
// one backward (largest to smallest). Two-pointer technique.

public boolean findTarget(TreeNode root, int k) {
    // Simple approach: in-order to list, then two pointers
    List<Integer> sorted = new ArrayList<>();
    inorder(root, sorted);
    
    int lo = 0, hi = sorted.size() - 1;
    while (lo < hi) {
        int sum = sorted.get(lo) + sorted.get(hi);
        if (sum == k) return true;
        if (sum < k) lo++;
        else hi--;
    }
    return false;
}

private void inorder(TreeNode node, List<Integer> list) {
    if (node == null) return;
    inorder(node.left, list);
    list.add(node.val);
    inorder(node.right, list);
}

// Time: O(n). Space: O(n).
//
// For O(h) space: use two BSTIterators — one normal (ascending), one
// reverse (descending). This is like having two pointers into the sorted
// array without materializing the array.
//
// JVM Insight: ArrayList.get(int) is O(1) — direct array indexing.
// The two-pointer scan is purely sequential access — extremely
// cache-friendly on the ArrayList's internal Object[].
//
// Real-world correlation: Two-pointer on a sorted structure is used in
// **merge join** in database query execution — both inputs are sorted,
// and we advance pointers to find matching rows.
```

**P05.48** [M] — Delete Nodes and Return Forest

Given a binary tree and a list of values to delete, return the resulting forest (list of remaining trees).

```java
// LeetCode 1110 - Delete Nodes And Return Forest

public List<TreeNode> delNodes(TreeNode root, int[] to_delete) {
    Set<Integer> deleteSet = new HashSet<>();
    for (int val : to_delete) deleteSet.add(val);
    
    List<TreeNode> forest = new ArrayList<>();
    root = helper(root, deleteSet, forest);
    if (root != null) forest.add(root);  // root itself might survive
    return forest;
}

private TreeNode helper(TreeNode node, Set<Integer> deleteSet, List<TreeNode> forest) {
    if (node == null) return null;
    
    node.left = helper(node.left, deleteSet, forest);
    node.right = helper(node.right, deleteSet, forest);
    
    if (deleteSet.contains(node.val)) {
        // This node is deleted — its children become new roots
        if (node.left != null) forest.add(node.left);
        if (node.right != null) forest.add(node.right);
        return null;  // remove this node from parent
    }
    
    return node;
}

// Time: O(n). Space: O(n) for the HashSet.
//
// Process children first (postorder), so by the time we process a node,
// its children are already cleaned up. If the current node is deleted,
// its surviving children become new tree roots.
//
// JVM Insight: HashSet.contains() is O(1). For small delete lists, the
// HashSet overhead (~40 bytes per entry) is negligible. For very small
// lists (< 10), a simple array scan might be faster due to cache effects.
//
// Real-world correlation: **Git branch cleanup** — deleting branches
// (nodes in the commit DAG) and identifying the resulting disconnected
// components (forest). Each disconnected component might need a new
// root reference (tag or branch pointer).
```

**P05.49** [H] — Number of Visible Nodes (Good Nodes in Binary Tree)

A node is "good" if its value is greater than or equal to all values on the path from root to it.

```java
// LeetCode 1448 - Count Good Nodes in Binary Tree

public int goodNodes(TreeNode root) {
    return countGood(root, Integer.MIN_VALUE);
}

private int countGood(TreeNode node, int maxSoFar) {
    if (node == null) return 0;
    
    int count = 0;
    if (node.val >= maxSoFar) {
        count = 1;
        maxSoFar = node.val;
    }
    
    count += countGood(node.left, maxSoFar);
    count += countGood(node.right, maxSoFar);
    return count;
}

// Time: O(n). Space: O(h).
//
// Track the maximum value from root to current node. A node is "good"
// if its value is >= this maximum.
//
// JVM Insight: The maxSoFar parameter is passed by value (int), so each
// branch of the recursion has its own copy. No shared mutable state.
// This is naturally thread-safe if you wanted to parallelize the tree
// traversal (though the overhead would not be worth it for most trees).
//
// Real-world correlation: In **stream processing**, a "good event" might
// be one whose value exceeds all previous events — tracking running
// maximums is a common operation in real-time analytics (e.g., Flink
// or Kafka Streams windowed max).
```

**P05.50** [H] — Smallest Rectangle Enclosing Black Pixels

*(Replaced with a tree-relevant hard problem)*

**P05.50** [H] — Maximum Sum BST in Binary Tree

Given a binary tree, find the maximum sum of all keys of any sub-tree which is also a BST.

```java
// LeetCode 1373 - Maximum Sum BST in Binary Tree
//
// For each subtree, determine: is it a BST? What is its sum? What are
// the min and max values?

private int maxBSTSum = 0;

public int maxSumBST(TreeNode root) {
    maxBSTSum = 0;
    postorder(root);
    return maxBSTSum;
}

// Returns {isBST (0/1), min value, max value, sum}
private int[] postorder(TreeNode node) {
    if (node == null) {
        return new int[]{1, Integer.MAX_VALUE, Integer.MIN_VALUE, 0};
    }
    
    int[] left = postorder(node.left);
    int[] right = postorder(node.right);
    
    // Check if current subtree is a BST
    if (left[0] == 1 && right[0] == 1 &&
        node.val > left[2] &&   // node > max of left subtree
        node.val < right[1]) {  // node < min of right subtree
        
        int sum = left[3] + right[3] + node.val;
        maxBSTSum = Math.max(maxBSTSum, sum);
        
        int min = Math.min(node.val, left[1]);
        int max = Math.max(node.val, right[2]);
        return new int[]{1, min, max, sum};
    }
    
    return new int[]{0, 0, 0, 0};  // not a BST
}

// Time: O(n). Space: O(h).
//
// Postorder traversal (process children before parent). Each node reports
// whether its subtree is a valid BST, and if so, the min, max, and sum.
// The parent combines this information to check its own BST validity.
//
// JVM Insight: Returning int[4] allocates a small array per node (40 bytes:
// 12 header + 4 length + 16 data + 8 padding). For 1M nodes, that is 40MB
// of short-lived arrays. The GC handles this efficiently since they are
// allocated and discarded in stack-like order (LIFO).
//
// Real-world correlation: Finding the largest valid sub-structure within
// a possibly corrupted data structure. **Database repair tools** (e.g.,
// InnoDB's innodb_force_recovery) attempt to recover the largest valid
// B-Tree subtree from a corrupted index.
```

### B-Tree Problems

**P05.51** [H] — Implement Simplified B-Tree Insert

Implement a simplified B-Tree that supports insert and search.

```java
// Simplified B-Tree of minimum degree t.
// Each node has at most 2t-1 keys and 2t children.

public class BTree {
    
    private static final int T = 3;  // minimum degree
    
    static class BTreeNode {
        int[] keys;
        BTreeNode[] children;
        int numKeys;
        boolean leaf;
        
        BTreeNode(boolean leaf) {
            this.leaf = leaf;
            this.keys = new int[2 * T - 1];
            this.children = new BTreeNode[2 * T];
            this.numKeys = 0;
        }
    }
    
    private BTreeNode root;
    
    public BTree() {
        root = new BTreeNode(true);
    }
    
    // Search
    public boolean search(int key) {
        return search(root, key);
    }
    
    private boolean search(BTreeNode node, int key) {
        int i = 0;
        while (i < node.numKeys && key > node.keys[i]) i++;
        
        if (i < node.numKeys && key == node.keys[i]) return true;
        if (node.leaf) return false;
        
        return search(node.children[i], key);
    }
    
    // Insert
    public void insert(int key) {
        BTreeNode r = root;
        if (r.numKeys == 2 * T - 1) {
            // Root is full — split it and create new root
            BTreeNode newRoot = new BTreeNode(false);
            newRoot.children[0] = r;
            splitChild(newRoot, 0);
            root = newRoot;
            insertNonFull(newRoot, key);
        } else {
            insertNonFull(r, key);
        }
    }
    
    private void insertNonFull(BTreeNode node, int key) {
        int i = node.numKeys - 1;
        
        if (node.leaf) {
            // Shift keys right to make room
            while (i >= 0 && key < node.keys[i]) {
                node.keys[i + 1] = node.keys[i];
                i--;
            }
            node.keys[i + 1] = key;
            node.numKeys++;
        } else {
            // Find the correct child
            while (i >= 0 && key < node.keys[i]) i--;
            i++;
            
            // If child is full, split it first
            if (node.children[i].numKeys == 2 * T - 1) {
                splitChild(node, i);
                if (key > node.keys[i]) i++;
            }
            insertNonFull(node.children[i], key);
        }
    }
    
    private void splitChild(BTreeNode parent, int childIndex) {
        BTreeNode fullChild = parent.children[childIndex];
        BTreeNode newChild = new BTreeNode(fullChild.leaf);
        newChild.numKeys = T - 1;
        
        // Copy right half of keys to new child
        for (int j = 0; j < T - 1; j++) {
            newChild.keys[j] = fullChild.keys[j + T];
        }
        
        // Copy right half of children to new child
        if (!fullChild.leaf) {
            for (int j = 0; j < T; j++) {
                newChild.children[j] = fullChild.children[j + T];
            }
        }
        
        fullChild.numKeys = T - 1;
        
        // Shift parent's children and keys to make room
        for (int j = parent.numKeys; j > childIndex; j--) {
            parent.children[j + 1] = parent.children[j];
        }
        parent.children[childIndex + 1] = newChild;
        
        for (int j = parent.numKeys - 1; j >= childIndex; j--) {
            parent.keys[j + 1] = parent.keys[j];
        }
        // Promote median key to parent
        parent.keys[childIndex] = fullChild.keys[T - 1];
        parent.numKeys++;
    }
    
    // Print tree (level order for visualization)
    public void printTree() {
        printLevel(root, 0);
    }
    
    private void printLevel(BTreeNode node, int level) {
        if (node == null) return;
        System.out.print("Level " + level + ": [");
        for (int i = 0; i < node.numKeys; i++) {
            if (i > 0) System.out.print(", ");
            System.out.print(node.keys[i]);
        }
        System.out.println("]");
        if (!node.leaf) {
            for (int i = 0; i <= node.numKeys; i++) {
                printLevel(node.children[i], level + 1);
            }
        }
    }
}

// Usage:
// BTree tree = new BTree();
// for (int key : new int[]{10, 20, 5, 6, 12, 30, 7, 17}) {
//     tree.insert(key);
// }
// tree.printTree();
//
// Output (approximately):
// Level 0: [10]
// Level 1: [5, 6, 7]
// Level 1: [12, 17, 20, 30]

// Time: Insert O(t * log_t(n)), Search O(t * log_t(n))
// where the t factor comes from scanning within a node.
// With binary search within nodes: O(log(t) * log_t(n)) = O(log n).
// Space: O(n) for the tree.
//
// JVM Insight: Each BTreeNode allocates two arrays. For T=3, that is
// int[5] (40 bytes) + BTreeNode[6] (44 bytes) + node overhead (40 bytes)
// = ~124 bytes per node. Compare to a Red-Black tree node at ~48 bytes
// but holding only 1 key. The B-Tree node holds up to 5 keys in 124 bytes
// = ~25 bytes per key. More space-efficient than Red-Black for large datasets.
//
// Real-world correlation: This is a simplified version of what InnoDB
// does for every INSERT statement. The real implementation adds:
// - Page-level locking
// - WAL logging before split
// - Buffer pool integration (dirty page management)
// - Concurrency control (latches on tree pages)
```

**P05.52** [M] — Explain InnoDB Index Lookup

Given a SQL query, trace the B+ Tree traversal path that InnoDB follows.

```java
// Problem: Explain what happens internally when MySQL executes:
//   SELECT * FROM users WHERE email = 'alice@example.com'
// given the table:
//   CREATE TABLE users (
//     id INT PRIMARY KEY AUTO_INCREMENT,
//     email VARCHAR(255),
//     name VARCHAR(100),
//     INDEX idx_email (email)
//   );
//
// Answer trace:
//
// Step 1: Query optimizer chooses idx_email (secondary index on email).
//
// Step 2: Traverse the secondary index B+ Tree for 'alice@example.com'.
//   - Read root page of idx_email (likely cached in buffer pool).
//   - Compare 'alice@example.com' with keys in root page.
//   - Binary search within the page (keys are sorted).
//   - Follow child pointer to intermediate page.
//   - Repeat binary search + follow pointer.
//   - Reach leaf page of idx_email.
//   - Leaf contains: email='alice@example.com' → primary key id=42.
//
// Step 3: Double lookup — use primary key to traverse clustered index.
//   - Read root page of PRIMARY (clustered index).
//   - Search for id=42.
//   - Reach leaf page of PRIMARY.
//   - Leaf contains the FULL ROW: id=42, email='alice@example.com', name='Alice'.
//
// Step 4: Return the row to the client.
//
// I/O count (cold cache):
//   - Secondary index: ~3 page reads (height 3 for millions of rows)
//   - Clustered index: ~3 page reads
//   - Total: ~6 page reads = 6 * 16KB = 96KB of I/O
//
// I/O count (warm cache):
//   - Top 2 levels of both indexes are cached → 2 page reads total
//   - With buffer pool warm: essentially 2 disk reads for any point query
//
// Covering index optimization:
//   CREATE INDEX idx_email_name ON users(email, name);
//   Now the secondary index leaf contains both email and name.
//   SELECT email, name FROM users WHERE email = 'alice@example.com'
//   → only secondary index traversal needed (no double lookup).
//   This is a "covering index" — the query is "covered" by the index.

// JVM/Systems correlation:
// The buffer pool is like Java's LRU cache (LinkedHashMap with accessOrder).
// Hot pages stay in memory; cold pages are evicted. InnoDB's buffer pool
// uses a modified LRU list with a "young" and "old" sublist to prevent
// full table scans from evicting hot pages.

// This is NOT a coding problem — it is a systems design / knowledge
// question. Senior engineers must be able to explain this trace fluently.
```

### More Tree Problems

**P05.53** [H] — All Nodes Distance K in Binary Tree

Given a binary tree, a target node, and an integer K, return all nodes at distance K from the target.

```java
// LeetCode 863 - All Nodes Distance K in Binary Tree
//
// Convert tree to graph (using parent map), then BFS from target.

public List<Integer> distanceK(TreeNode root, TreeNode target, int k) {
    // Step 1: Build parent map
    Map<TreeNode, TreeNode> parentMap = new HashMap<>();
    buildParentMap(root, null, parentMap);
    
    // Step 2: BFS from target
    Queue<TreeNode> queue = new ArrayDeque<>();
    Set<TreeNode> visited = new HashSet<>();
    queue.offer(target);
    visited.add(target);
    int distance = 0;
    
    while (!queue.isEmpty()) {
        if (distance == k) {
            List<Integer> result = new ArrayList<>();
            for (TreeNode node : queue) result.add(node.val);
            return result;
        }
        
        int levelSize = queue.size();
        for (int i = 0; i < levelSize; i++) {
            TreeNode node = queue.poll();
            
            // Explore left, right, and parent
            for (TreeNode neighbor : new TreeNode[]{node.left, node.right, parentMap.get(node)}) {
                if (neighbor != null && !visited.contains(neighbor)) {
                    visited.add(neighbor);
                    queue.offer(neighbor);
                }
            }
        }
        distance++;
    }
    
    return new ArrayList<>();
}

private void buildParentMap(TreeNode node, TreeNode parent, Map<TreeNode, TreeNode> map) {
    if (node == null) return;
    map.put(node, parent);
    buildParentMap(node.left, node, map);
    buildParentMap(node.right, node, map);
}

// Time: O(n). Space: O(n).
//
// The insight: a binary tree is an undirected graph where each node
// connects to its left child, right child, and parent. By building
// a parent map, we can traverse in all three directions. Then standard
// BFS from the target finds all nodes at distance K.
//
// JVM Insight: HashMap uses identity-based hashing for TreeNode keys
// (since TreeNode likely doesn't override hashCode). The default
// identityHashCode is stored in the mark word — a single memory read
// from the object header. Very fast.
//
// Real-world correlation: "Find all nodes within K hops" is a
// **graph database** query (Neo4j's variable-length path matching).
// In **network monitoring**, finding all servers within K hops of a
// failure point for impact analysis.
```

**P05.54** [H] — Vertical Order Traversal with Column Ordering

*(Variation of P05.20 — more complex ordering rules)*

**P05.54** [H] — Sum of Distances in Tree

Given a tree with n nodes (labeled 0 to n-1 with edges), return an array where `answer[i]` is the sum of distances from node i to all other nodes.

```java
// LeetCode 834 - Sum of Distances in Tree
//
// Brute force: BFS from each node → O(n^2). Too slow for n = 30,000.
// Optimization: Rerooting technique.

public int[] sumOfDistancesInTree(int n, int[][] edges) {
    List<List<Integer>> graph = new ArrayList<>();
    for (int i = 0; i < n; i++) graph.add(new ArrayList<>());
    for (int[] edge : edges) {
        graph.get(edge[0]).add(edge[1]);
        graph.get(edge[1]).add(edge[0]);
    }
    
    int[] count = new int[n];  // count[i] = number of nodes in subtree rooted at i
    int[] answer = new int[n]; // answer[i] = sum of distances from i
    Arrays.fill(count, 1);
    
    // Step 1: Root the tree at node 0. Compute count[] and answer[0].
    // DFS post-order: compute subtree sizes and distance sum for root.
    boolean[] visited = new boolean[n];
    
    // Post-order DFS (iterative to avoid stack overflow for large n)
    Deque<int[]> stack = new ArrayDeque<>();  // [node, parent]
    List<int[]> order = new ArrayList<>();     // topological order
    stack.push(new int[]{0, -1});
    visited[0] = true;
    
    while (!stack.isEmpty()) {
        int[] curr = stack.pop();
        order.add(curr);
        for (int child : graph.get(curr[0])) {
            if (!visited[child]) {
                visited[child] = true;
                stack.push(new int[]{child, curr[0]});
            }
        }
    }
    
    // Process in reverse (post-order)
    for (int i = order.size() - 1; i >= 0; i--) {
        int node = order.get(i)[0], parent = order.get(i)[1];
        for (int child : graph.get(node)) {
            if (child != parent) {
                count[node] += count[child];
                answer[node] += answer[child] + count[child];
            }
        }
    }
    
    // Step 2: Rerooting — compute answer[i] from answer[parent].
    // When moving root from parent to child:
    // - child's subtree nodes get 1 closer (count[child] nodes)
    // - all other nodes get 1 farther (n - count[child] nodes)
    // answer[child] = answer[parent] - count[child] + (n - count[child])
    //               = answer[parent] + n - 2 * count[child]
    
    for (int[] curr : order) {
        int node = curr[0], parent = curr[1];
        if (parent != -1) {
            answer[node] = answer[parent] + n - 2 * count[node];
        }
    }
    
    return answer;
}

// Time: O(n). Space: O(n).
//
// The rerooting technique: compute the answer for one root (any node),
// then propagate to all other nodes using the relationship between
// parent and child answers. Two DFS passes — O(n) total.
//
// JVM Insight: The adjacency list uses ArrayList<ArrayList<Integer>>.
// Each Integer is boxed (16 bytes). For a tree with 30K nodes and
// 30K-1 edges, that is ~60K Integer objects + list overhead. For
// maximum performance, use int[][] adjacency lists with primitive arrays.
//
// Real-world correlation: The rerooting technique is used in **network
// design** — computing the "centrality" of each node (sum of shortest
// paths to all others) is a key metric for choosing server placement
// in CDN networks.
```

**P05.55** [H] — Binary Tree Maximum Width

Given a binary tree, find the maximum width (maximum number of nodes between the leftmost and rightmost non-null nodes at any level, including null nodes in between).

```java
// LeetCode 662 - Maximum Width of Binary Tree
//
// Assign position indices: root = 0, left child = 2*pos, right child = 2*pos+1.
// Width at each level = rightmost position - leftmost position + 1.

public int widthOfBinaryTree(TreeNode root) {
    if (root == null) return 0;
    
    int maxWidth = 0;
    Queue<long[]> queue = new ArrayDeque<>();  // [node_id, position]
    queue.offer(new long[]{0, 0});  // dummy encoding
    
    // We need to store the actual node too — let's use a different approach
    Queue<TreeNode> nodeQueue = new ArrayDeque<>();
    Queue<Long> posQueue = new ArrayDeque<>();
    nodeQueue.offer(root);
    posQueue.offer(0L);
    
    while (!nodeQueue.isEmpty()) {
        int size = nodeQueue.size();
        long leftmostPos = posQueue.peek();
        long rightmostPos = leftmostPos;
        
        for (int i = 0; i < size; i++) {
            TreeNode node = nodeQueue.poll();
            long pos = posQueue.poll();
            rightmostPos = pos;
            
            // Normalize positions to prevent overflow
            // Subtract leftmostPos so positions start from 0 each level
            if (node.left != null) {
                nodeQueue.offer(node.left);
                posQueue.offer(2 * (pos - leftmostPos));
            }
            if (node.right != null) {
                nodeQueue.offer(node.right);
                posQueue.offer(2 * (pos - leftmostPos) + 1);
            }
        }
        
        maxWidth = Math.max(maxWidth, (int)(rightmostPos - leftmostPos + 1));
    }
    
    return maxWidth;
}

// Time: O(n). Space: O(w) where w is the maximum width.
//
// The position normalization (subtracting leftmostPos) prevents integer
// overflow. Without it, positions can grow as 2^h which overflows long
// for h > 62. By normalizing each level, we keep positions small.
//
// JVM Insight: Using long for positions handles trees up to height 62.
// int would overflow at height 30 (2^30 > Integer.MAX_VALUE). The
// normalization trick keeps positions in manageable range even for
// degenerate cases.
//
// Real-world correlation: Level-width analysis is used in **network
// topology assessment** — the "width" at each hop distance from a root
// determines bandwidth requirements for broadcast protocols.
```

---

## 5.8 Key Takeaways

1. **BSTs give sorted order for free, but only if balanced.** An unbalanced BST degenerates to a linked list with O(n) operations. Never use a raw BST in production — always use a self-balancing variant (AVL, Red-Black) or Java's `TreeMap`.

2. **AVL trees are stricter, Red-Black trees are more practical.** AVL guarantees height within 1.44 * log2(n+2), giving faster lookups. Red-Black allows up to 2 * log2(n+1) but needs fewer rotations on insert/delete. Java, C++, and the Linux kernel all chose Red-Black for general-purpose use.

3. **TreeMap is a Red-Black tree with ~48 bytes per entry.** Every `Entry<K,V>` stores key, value, left, right, parent, and color. For 1M entries, that is ~48MB before counting keys and values. Use `HashMap` when you don't need sorted order.

4. **NavigableMap operations are your TreeMap superpower.** `floorKey()`, `ceilingKey()`, `subMap()`, `headMap()`, `tailMap()` — all O(log n) and backed by tree traversal. These solve interval, calendar, and range query problems elegantly.

5. **B-Trees and B+ Trees dominate on disk because they minimize I/O.** By packing hundreds of keys per node (matching disk page size), a B-Tree with 1 billion entries has height ~3-4. Binary trees would need height ~30 — ten times more disk reads.

6. **InnoDB's clustered index IS the table.** The primary key B+ Tree's leaf nodes contain the full row data. Secondary indexes point to the primary key, requiring a double lookup. This is why primary key choice matters enormously — auto-increment IDs give sequential inserts; UUIDs cause random page splits.

7. **In-order traversal is the bridge between trees and sorted sequences.** Validating a BST, finding kth smallest, converting BST to sorted list, and BST iteration all rely on in-order traversal producing sorted output. Master both recursive and iterative (stack-based) in-order traversal.

8. **Tree DP is postorder traversal with return values.** Problems like house robber III, maximum path sum, and maximum BST sum all use the same pattern: compute answers for children first (postorder), combine at the parent, optionally update a global result.

9. **Most tree problems reduce to DFS or BFS.** DFS (with recursion or explicit stack) handles depth-first exploration, path tracking, and subtree processing. BFS (with queue) handles level-order operations, shortest distance, and width calculations. Know both cold.

10. **Trees are everywhere in systems.** File systems (B-Trees), databases (B+ Trees), in-memory indexes (Red-Black/AVL), compilers (ASTs), network routing (tries), version control (DAGs), and UI frameworks (component trees). Understanding tree algorithms makes you a better systems engineer, not just a better interviewee.

---

## Navigation

| Previous | Index | Next |
|----------|-------|------|
| [Chapter 4: Hashing Internals](04-hashing-internals.md) | [Index](00-index.md) | [Chapter 6: Heaps, Queues, & Stacks](06-heaps-queues-stacks.md) |

---

*"A tree is not a data structure you learn once. It is a lens through which you see every sorted collection, every database index, every hierarchical system. Once you truly understand trees, you understand half of computer science."*
