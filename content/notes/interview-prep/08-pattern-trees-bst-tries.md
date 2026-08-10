# Chapter 8: Trees, BST & Tries

> **Relearning log.** Trees came back fastest, but two things had decayed. First, I'd lost the
> reflex that **almost every tree problem is "define what one node returns to its parent, and let
> recursion do the rest."** Once I frame the recursion as a contract — "this function returns the
> height / the sum / whether-balanced of the subtree rooted here" — the code writes itself. Second,
> I'd forgotten that **in-order traversal of a BST is a sorted sequence**, which is the secret
> behind half of all BST problems (validate, k-th smallest, closest value). And I had genuinely
> forgotten tries existed until a prefix problem reminded me.

---

## 8.1 Traversals — the four you must write cold

```java
class TreeNode { int val; TreeNode left, right; }

// Recursive in-order (left, node, right). Pre = node first; post = node last.
void inorder(TreeNode n, List<Integer> out) {
    if (n == null) return;
    inorder(n.left, out);
    out.add(n.val);
    inorder(n.right, out);
}

// Iterative in-order with an explicit stack (when recursion depth is a worry). O(n)/O(h).
List<Integer> inorderIter(TreeNode root) {
    List<Integer> out = new ArrayList<>();
    Deque<TreeNode> st = new ArrayDeque<>();
    TreeNode cur = root;
    while (cur != null || !st.isEmpty()) {
        while (cur != null) { st.push(cur); cur = cur.left; }   // go left as far as possible
        cur = st.pop();
        out.add(cur.val);
        cur = cur.right;
    }
    return out;
}

// Level-order (BFS) — the basis for "by level" problems. O(n)/O(width).
List<List<Integer>> levelOrder(TreeNode root) {
    List<List<Integer>> res = new ArrayList<>();
    if (root == null) return res;
    Queue<TreeNode> q = new ArrayDeque<>();
    q.offer(root);
    while (!q.isEmpty()) {
        int sz = q.size();                  // snapshot: exactly this level
        List<Integer> level = new ArrayList<>();
        for (int i = 0; i < sz; i++) {
            TreeNode n = q.poll();
            level.add(n.val);
            if (n.left != null) q.offer(n.left);
            if (n.right != null) q.offer(n.right);
        }
        res.add(level);
    }
    return res;
}
```

> The `int sz = q.size()` snapshot before draining is the trick that makes level-order produce
> *per-level* lists. Forgetting it is the #1 BFS-on-trees bug.

---

## 8.2 The "return a contract" recursion pattern

Pick what each node returns to its parent; combine children's returns; this solves most tree
problems. Examples of the contract:

```java
// Max depth: returns height of subtree. O(n)/O(h).
int maxDepth(TreeNode n) {
    if (n == null) return 0;
    return 1 + Math.max(maxDepth(n.left), maxDepth(n.right));
}

// Balanced? Return height, use -1 as a "not balanced" sentinel to short-circuit. O(n)/O(h).
int height(TreeNode n) {
    if (n == null) return 0;
    int l = height(n.left);  if (l == -1) return -1;
    int r = height(n.right); if (r == -1) return -1;
    if (Math.abs(l - r) > 1) return -1;
    return 1 + Math.max(l, r);
}

// Diameter: each node returns its height; we update a global best = l + r at each node.
int best = 0;
int depthForDiameter(TreeNode n) {
    if (n == null) return 0;
    int l = depthForDiameter(n.left), r = depthForDiameter(n.right);
    best = Math.max(best, l + r);     // longest path THROUGH this node
    return 1 + Math.max(l, r);        // height returned to parent
}
```

**The general recipe I narrate:** *"What does each node need from its children to compute its own
answer, and what does it pass up?"* For "path through node" problems, the value used *at* the node
(`l + r`) differs from the value *returned* (`1 + max(l, r)`) — calling that out is an L5 signal.

**Worked example — Lowest Common Ancestor (general binary tree).** Return the node if it *is* p or q,
else recurse; if both sides return non-null, *this* node is the LCA.

```java
TreeNode lca(TreeNode n, TreeNode p, TreeNode q) {   // O(n)/O(h)
    if (n == null || n == p || n == q) return n;
    TreeNode l = lca(n.left, p, q), r = lca(n.right, p, q);
    if (l != null && r != null) return n;            // p and q split here → LCA
    return l != null ? l : r;                        // both on one side (or none)
}
```

---

## 8.3 BST — exploit the ordering

**Invariant:** every node's left subtree < node < right subtree. Consequences I keep ready:

- **In-order traversal = sorted order.** → validate BST, k-th smallest, find closest, two-sum in
  BST.
- **Search / insert / delete = O(h)** — O(log n) if balanced, O(n) if degenerate.
- **Validate BST:** pass down `(min, max)` bounds, not just compare with the parent (the classic
  bug — a node can be > its parent but still violate a grandparent's bound).

```java
boolean isValidBST(TreeNode n, long min, long max) {   // call with (root, MIN, MAX). O(n)/O(h).
    if (n == null) return true;
    if (n.val <= min || n.val >= max) return false;
    return isValidBST(n.left, min, n.val) && isValidBST(n.right, n.val, max);
}

// k-th smallest via in-order, stopping early. O(h + k)/O(h).
int kthSmallest(TreeNode root, int k) {
    Deque<TreeNode> st = new ArrayDeque<>();
    TreeNode cur = root;
    while (cur != null || !st.isEmpty()) {
        while (cur != null) { st.push(cur); cur = cur.left; }
        cur = st.pop();
        if (--k == 0) return cur.val;
        cur = cur.right;
    }
    return -1;
}
```

> "Is this a BST problem?" → ask "would the sorted order of values help?" If yes, **think in-order
> traversal first.** It's the BST master key.

---

## 8.4 Tries (prefix trees)

For prefix queries, autocomplete, word dictionaries, and "find words sharing a prefix." Each node
has up to 26 children + an `isWord` flag. Insert/search/prefix are O(L) in word length, independent
of dictionary size.

```java
class Trie {
    private final Trie[] next = new Trie[26];
    private boolean isWord;

    void insert(String w) {
        Trie node = this;
        for (char c : w.toCharArray()) {
            int i = c - 'a';
            if (node.next[i] == null) node.next[i] = new Trie();
            node = node.next[i];
        }
        node.isWord = true;
    }
    boolean search(String w)        { Trie n = walk(w); return n != null && n.isWord; }
    boolean startsWith(String pre)  { return walk(pre) != null; }

    private Trie walk(String s) {
        Trie node = this;
        for (char c : s.toCharArray()) {
            node = node.next[c - 'a'];
            if (node == null) return null;
        }
        return node;
    }
}
```

Tries also power **word-search-II** (DFS a grid against a trie) and **word break / prefix matching**.

---

## 8.5 Common pitfalls

- **Validate BST by comparing only to the immediate parent** — wrong; carry `(min, max)` bounds.
- **Forgetting the `q.size()` snapshot** in level-order.
- **Recursion depth on a skewed tree** is O(n) stack — for very deep trees, use the iterative form
  (mention this at L5).
- **`int` overflow** when summing path values or using `Integer.MIN_VALUE` as a BST bound → use
  `long`.
- Mixing up the value used **at** a node vs **returned** to the parent (diameter, max path sum).

## Interview Drills

- **D8.1 [E]** Invert a binary tree; symmetric tree check.
- **D8.2 [E]** Level-order, then zigzag level-order. *(Reverse alternate levels.)*
- **D8.3 [M]** Validate BST (bounds); k-th smallest in a BST.
- **D8.4 [M]** Lowest common ancestor (general tree, above); then LCA in a BST (use ordering for
  O(h)).
- **D8.5 [H]** Binary tree maximum path sum. *(At each node: gain = max(0, l, r) up; best = node + l
  + r.)*
- **D8.6 [H]** Serialize and deserialize a binary tree. *(Pre-order with null markers.)*
- **D8.7 [H]** Implement a Trie; then Word Search II over a grid.

## Key Takeaways

1. **Most tree problems = define each node's return contract;** combine children, pass up. Distinguish
   the value used *at* the node from the value *returned*.
2. **Memorize all four traversals cold,** including iterative in-order and the `q.size()` level-order
   snapshot.
3. **BST in-order = sorted order** — the master key to validate / k-th / closest / two-sum.
4. **Validate a BST with (min,max) bounds,** not parent comparison; use `long` to avoid overflow.
5. **Tries** give O(L) prefix operations independent of dictionary size; reach for them on
   prefix/autocomplete/word-dictionary problems.
