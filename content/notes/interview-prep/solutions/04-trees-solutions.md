# Worked Solutions 04 — Trees, BST & Tries

> Home chapter: [Ch 8](../08-pattern-trees-bst-tries.md). Format: [solutions index](00-solutions-index.md).
> Tree bugs are about *recursion contracts* — what each call returns, when state updates, and the
> difference between the value used **at** a node and the value passed **up**. Catching these reveals
> genuine understanding, not memorized code. Node type used throughout:
> `class TreeNode { int val; TreeNode left, right; }`.

---

## P1 — Validate Binary Search Tree `[M]`

**PROBLEM.** Is the tree a valid BST? (Left subtree < node < right subtree, *strictly*, recursively.)

**RECOGNITION.** BST validity is a *whole-subtree* constraint, not a local one → carry `(min, max)`
bounds down the recursion (or do an in-order traversal and check it's strictly increasing).

**THOUGHT.** "A node is valid only if it lies within an open interval that *tightens* as we descend.
Going left tightens the upper bound to the node's value; going right tightens the lower bound. The
trap is checking only against the immediate parent."

**BUGGY ATTEMPT.**
```java
boolean isValidBST(TreeNode root) {
    if (root == null) return true;
    if (root.left != null && root.left.val >= root.val) return false;   // <-- the bug: parent-only
    if (root.right != null && root.right.val <= root.val) return false;
    return isValidBST(root.left) && isValidBST(root.right);
}
```

**SPOT THE BUG.** It only compares each node to its **immediate children**, missing violations against
an *ancestor*. A node can be greater than its parent yet still illegally small relative to a
grandparent. Failing input:
```
      5
     / \
    1   4        <- 4 is in 5's RIGHT subtree, so it must be > 5, but 4 < 5
       / \
      3   6
```
Every parent/child pair here is locally fine (4>3, 4<6, 5>1), so the buggy check returns **true**, but
this is **not** a BST (3 and 4 are right-of-5 yet less than 5). **Fix: pass down `(low, high)` bounds.**

**CLEAN.**
```java
boolean isValidBST(TreeNode root) {
    return valid(root, Long.MIN_VALUE, Long.MAX_VALUE);   // long bounds avoid int-overflow edge
}
boolean valid(TreeNode node, long low, long high) {        // O(n) time, O(h) stack
    if (node == null) return true;
    if (node.val <= low || node.val >= high) return false; // strict: outside the open interval
    return valid(node.left, low, node.val)                 // left: upper bound tightens to node
        && valid(node.right, node.val, high);              // right: lower bound tightens to node
}
```

**Why `long` bounds.** If a node holds `Integer.MIN_VALUE` or `MAX_VALUE` and you used `int` sentinels,
the `<=`/`>=` comparison gives a false negative/positive at the extremes. `long` (or passing
`Integer` and null-checking) sidesteps it — a classic overflow-class edge the interviewer may plant.

**EDGE CASES.** Single node (valid); the grandparent-violation tree above; duplicate values (a BST is
usually defined strict → duplicates invalid); a node equal to `Integer.MAX_VALUE` (the `long` fix);
a right-leaning chain that's actually valid.

**COMPLEXITY.** O(n) time (visit each node once), O(h) space (recursion stack; O(n) for a skewed tree).

**DRY RUN.** The failing tree: `valid(5, -∞, +∞)` ok → right child `valid(4, 5, +∞)`: `4 >= ... ` —
`4 <= low(5)`? `4 <= 5` → **false**. Correctly rejected. ✓

**FOLLOW-UPS.** *In-order alternative?* → in-order traversal of a BST is strictly increasing; track the
previous value and fail on `prev >= cur`. *Recover a BST with two swapped nodes?* → in-order + find the
two misordered nodes.

---

## P2 — Kth Smallest Element in a BST `[M]`

**PROBLEM.** Return the k-th smallest (1-indexed) value in a BST.

**RECOGNITION.** **In-order traversal of a BST yields sorted order** → the k-th node visited in-order
is the answer. Stop early.

**THOUGHT.** "Iterative in-order with a stack: go left as far as possible, pop, that's the next
smallest; decrement k; when k hits 0, that popped node is the answer."

**BUGGY ATTEMPT.**
```java
int kthSmallest(TreeNode root, int k) {
    Deque<TreeNode> st = new ArrayDeque<>();
    TreeNode cur = root;
    while (cur != null || !st.isEmpty()) {
        while (cur != null) { st.push(cur); cur = cur.left; }
        cur = st.pop();
        if (k-- == 0) return cur.val;     // <-- the bug: post-decrement compares to 0
        cur = cur.right;
    }
    return -1;
}
```

**SPOT THE BUG.** `k-- == 0` compares `k` to 0 **before** decrementing. Since `k` starts at ≥ 1, it's
never 0 at the first (smallest) node, and the off-by-one means it triggers one node *too late* — or
never, returning −1 for `k = 1`. Failing input: tree `[2,1,3]`, `k = 1` → smallest is 1, but `k-- == 0`
at the first pop checks `1 == 0` (false, k becomes 0), at the second pop checks `0 == 0` (true) →
returns the **second** smallest (2). **Fix: pre-decrement — `if (--k == 0) return cur.val;`.**

**CLEAN.**
```java
int kthSmallest(TreeNode root, int k) {           // O(h + k) time, O(h) space
    Deque<TreeNode> st = new ArrayDeque<>();
    TreeNode cur = root;
    while (cur != null || !st.isEmpty()) {
        while (cur != null) { st.push(cur); cur = cur.left; }  // dive to the smallest
        cur = st.pop();
        if (--k == 0) return cur.val;              // decrement THEN test — the fix
        cur = cur.right;                           // in-order: now the right subtree
    }
    return -1;                                     // k > number of nodes
}
```

**EDGE CASES.** `k = 1` (smallest — the case the bug breaks); `k = n` (largest); `k` > n (return −1 or
throw — clarify); single node; left-skewed and right-skewed trees.

**COMPLEXITY.** O(h + k) time (descend h, then pop k), O(h) space.

**DRY RUN.** `[3,1,4,null,2], k=2`: in-order visits 1 (`--k` →1), 2 (`--k` →0 → return **2**). ✓

**FOLLOW-UPS.** *Frequent kth-smallest queries with modifications?* → augment nodes with subtree
counts → O(h) per query. *Kth largest?* → reverse in-order (right, node, left).

---

## P3 — Lowest Common Ancestor of a Binary Tree `[M]`

**PROBLEM.** Given two nodes `p`, `q` (both present), return their lowest common ancestor in a general
binary tree.

**RECOGNITION.** "Lowest node with `p` in one subtree and `q` in the other (or the node itself is `p`
or `q`)" → post-order recursion returning where each target was found.

**THOUGHT.** "Recurse; a call returns non-null if `p` or `q` is found in/at it. If both children return
non-null, *this* node is the split point → the LCA. Crucially, **a node that *is* `p` or `q` must
report itself**, because one target can be an ancestor of the other."

**BUGGY ATTEMPT.**
```java
TreeNode lowestCommonAncestor(TreeNode root, TreeNode p, TreeNode q) {
    if (root == null) return null;                // <-- the bug: missing the p/q base check
    TreeNode l = lowestCommonAncestor(root.left, p, q);
    TreeNode r = lowestCommonAncestor(root.right, p, q);
    if (l != null && r != null) return root;
    return l != null ? l : r;
}
```

**SPOT THE BUG.** The base case never returns when `root` itself **is** `p` or `q`, so when one target
is an **ancestor** of the other, the ancestor is skipped. Failing input: `p` is an ancestor of `q`.
```
    p
     \
      q
```
The correct LCA is `p`. But the buggy code recurses past `p`: at `p`, left=null, right=lca(q-subtree)
returns `q` (only because... actually without the base check, the call at `q` also returns null!).
With the base check missing, **neither** `p` nor `q` is ever detected → returns `null` everywhere.
**Fix: `if (root == null || root == p || root == q) return root;`.**

**CLEAN.**
```java
TreeNode lowestCommonAncestor(TreeNode root, TreeNode p, TreeNode q) {   // O(n) time, O(h) space
    if (root == null || root == p || root == q) return root;  // report a target on sight — the fix
    TreeNode l = lowestCommonAncestor(root.left, p, q);
    TreeNode r = lowestCommonAncestor(root.right, p, q);
    if (l != null && r != null) return root;       // p and q split here → this node is the LCA
    return l != null ? l : r;                       // both targets on one side (or neither)
}
```

**EDGE CASES.** `p` is an ancestor of `q` (the case the bug breaks); `p` and `q` in different subtrees
(the LCA is the split node); the root itself is `p` or `q`; `p == q` (LCA is the node).

**COMPLEXITY.** O(n) time, O(h) space.

**DRY RUN.** Ancestor case (`p → q`): `lca(p,...)` hits base check (`root == p`) → returns `p`
immediately. Correct. ✓ Split case: the deepest node whose two subtree-calls both return non-null is
returned.

**FOLLOW-UPS.** *LCA in a BST?* → use ordering: descend left if both < node, right if both > node, else
this node — O(h), no full search. *Nodes might be absent?* → also verify both were found. *With parent
pointers?* → two-pointer "intersection of linked lists" trick.

---

## P4 — Binary Tree Maximum Path Sum `[H]`

**PROBLEM.** Maximum sum of any path (sequence of adjacent nodes; need not pass through the root; a
path bends at most at one node). Node values may be negative.

**RECOGNITION.** Classic "value used **at** the node vs value returned **up**" recursion. At a node,
the best *bending* path is `node + leftGain + rightGain`; the value returned to the parent is
`node + max(leftGain, rightGain)` (a path can't fork upward).

**THOUGHT.** "Each call returns the best *downward* gain from this node (a straight path). A negative
child gain should be **clamped to 0** — better to take nothing than to subtract. The global answer is
updated at each node as `node + leftGain + rightGain` (the bend)."

**BUGGY ATTEMPT.**
```java
int best = Integer.MIN_VALUE;
int maxPathSum(TreeNode root) { gain(root); return best; }
int gain(TreeNode node) {
    if (node == null) return 0;
    int l = gain(node.left);
    int r = gain(node.right);
    best = Math.max(best, node.val + l + r);     // <-- the bug: l, r not clamped to >= 0
    return node.val + Math.max(l, r);
}
```

**SPOT THE BUG.** Negative child gains are added in without clamping, so a harmful negative subtree
drags the path sum down instead of being skipped. Failing input: `[1, -2, -3]`.
```
    1
   / \
 -2  -3
```
Correct answer: **1** (the lone node 1; both children hurt). Buggy: at node 1, `l = -2`, `r = -3` →
`best = 1 + (-2) + (-3) = -4`; the global best across all nodes ends at **−2** (node −2 alone), not 1.
**Fix: clamp each child gain — `int l = Math.max(0, gain(node.left));`.**

**CLEAN.**
```java
int best;
int maxPathSum(TreeNode root) {
    best = Integer.MIN_VALUE;                     // reset (don't rely on a stale field)
    gain(root);
    return best;
}
int gain(TreeNode node) {                          // O(n) time, O(h) space
    if (node == null) return 0;
    int l = Math.max(0, gain(node.left));          // drop negative subtrees — the fix
    int r = Math.max(0, gain(node.right));
    best = Math.max(best, node.val + l + r);       // best path BENDING at this node
    return node.val + Math.max(l, r);              // straight path returned to parent (no fork)
}
```

**The two distinct quantities (say this aloud).** `node + l + r` is used **at** the node (the bend, a
candidate answer). `node + max(l, r)` is **returned** (a straight extension the parent can build on).
Conflating them is the other classic bug here.

**EDGE CASES.** All negative (`[-3]` → −3; the clamp must not force 0 over the single best node — note
the *answer* uses `node.val + l + r`, so a lone negative node is still considered); single node; a path
not through the root; deep skew (stack depth).

**COMPLEXITY.** O(n) time, O(h) space.

**DRY RUN.** `[-10,9,20,null,null,15,7]` → 42. At node 20: l=15, r=7 → bend = 20+15+7 = 42 → best=42;
returns 20+15=35. At −10: l=9, r=35 → bend = −10+9+35=34 < 42. Answer 42. ✓

**FOLLOW-UPS.** *Return the path itself, not just the sum?* → track the bending node and reconstruct.
*Path must go root-to-leaf?* → simpler downward-only DP.

---

## P5 — Binary Tree Right Side View `[M]`

**PROBLEM.** Return the values visible from the right side, top to bottom (the last node of each
level).

**RECOGNITION.** "Last node per level" → **level-order BFS**, take the last element of each level.

**THOUGHT.** "BFS with the crucial `int sz = q.size()` snapshot so I process exactly one level at a
time; the **last** node in that level (`i == sz - 1`) is the visible one."

**BUGGY ATTEMPT.**
```java
List<Integer> rightSideView(TreeNode root) {
    List<Integer> res = new ArrayList<>();
    if (root == null) return res;
    Queue<TreeNode> q = new ArrayDeque<>();
    q.offer(root);
    while (!q.isEmpty()) {
        int sz = q.size();
        for (int i = 0; i < sz; i++) {
            TreeNode node = q.poll();
            if (i == 0) res.add(node.val);          // <-- the bug: first, not last
            if (node.left != null) q.offer(node.left);
            if (node.right != null) q.offer(node.right);
        }
    }
    return res;
}
```

**SPOT THE BUG.** `i == 0` takes the **first** node of each level → that's the *left* side view, not the
right. Failing input:
```
   1
  / \
 2   3
  \
   5
```
Right side view should be `[1, 3, 5]`; the bug yields `[1, 2, 5]` (leftmost of each level). **Fix:
`if (i == sz - 1)`** — the last node enqueued at this level is the rightmost.

**CLEAN.**
```java
List<Integer> rightSideView(TreeNode root) {       // O(n) time, O(width) space
    List<Integer> res = new ArrayList<>();
    if (root == null) return res;
    Queue<TreeNode> q = new ArrayDeque<>();
    q.offer(root);
    while (!q.isEmpty()) {
        int sz = q.size();                           // snapshot THIS level
        for (int i = 0; i < sz; i++) {
            TreeNode node = q.poll();
            if (i == sz - 1) res.add(node.val);      // the rightmost node of the level — the fix
            if (node.left != null) q.offer(node.left);   // left first, so right ends up last
            if (node.right != null) q.offer(node.right);
        }
    }
    return res;
}
```

**EDGE CASES.** Empty tree → `[]`; left-only tree (every left node is also the rightmost of its level →
all visible); right-only; the staircase above where a deeper-left node is the rightmost of its level.

**COMPLEXITY.** O(n) time, O(width) space (max queue size = widest level).

**DRY RUN.** Tree above: level0 [1] → add 1; level1 [2,3] → i=1 add 3; level2 [5] → add 5 → `[1,3,5]`. ✓

**FOLLOW-UPS.** *Left side view?* → `i == 0`. *Level averages / per-level lists?* → same snapshot,
aggregate the whole level. *Zigzag order?* → reverse alternate levels.

---

## P6 — Balanced Binary Tree `[E/M]`

**PROBLEM.** Is the tree height-balanced (every node's two subtree heights differ by ≤ 1)?

**RECOGNITION.** "Balanced at *every* node" → a recursive height computation that also reports
imbalance; use a `-1` sentinel to short-circuit and keep it O(n).

**THOUGHT.** "Compute height bottom-up; if any subtree is unbalanced (or differs by > 1), propagate
`-1` so the whole tree fails fast. The naive trap is checking only the root, or recomputing height
repeatedly (O(n²))."

**BUGGY ATTEMPT.**
```java
boolean isBalanced(TreeNode root) {
    if (root == null) return true;
    return Math.abs(height(root.left) - height(root.right)) <= 1;   // <-- the bug: root-only
}
int height(TreeNode n) {
    if (n == null) return 0;
    return 1 + Math.max(height(n.left), height(n.right));
}
```

**SPOT THE BUG.** It checks balance **only at the root**, never recursing into subtrees, so a tree
that's balanced at the top but skewed deeper passes incorrectly. Failing input:
```
        1
       / \
      2   2
     /
    3
   /
  4
```
Root's subtree heights are 3 (left) and 1 (right) → `|3-1| = 2 > 1`, so this particular tree fails at
the root too. Better failing input — balanced at root, unbalanced below:
```
         1
        / \
       2   2
      /     \
     3       3
    /         \
   4           4
```
Heights of root's children are both 3 → `|3-3| = 0 ≤ 1` → buggy returns **true**, but each child
subtree (e.g. `2 → 3 → 4`) is a skewed chain that is itself unbalanced. **Fix: also recurse:
`&& isBalanced(left) && isBalanced(right)`**, or better, the `-1`-sentinel O(n) version below.

**CLEAN (O(n), short-circuiting).**
```java
boolean isBalanced(TreeNode root) {                // O(n) time, O(h) space
    return check(root) != -1;
}
int check(TreeNode n) {                            // returns height, or -1 if unbalanced anywhere
    if (n == null) return 0;
    int l = check(n.left);
    if (l == -1) return -1;                         // short-circuit up
    int r = check(n.right);
    if (r == -1) return -1;
    if (Math.abs(l - r) > 1) return -1;            // imbalance here → propagate failure
    return 1 + Math.max(l, r);
}
```

**Why the sentinel beats the naive fix.** The naive `isBalanced(left) && isBalanced(right)` recomputes
heights at every level → O(n²) on a skewed tree. The `-1` sentinel computes each height once → O(n).
Mentioning this complexity improvement unprompted is a senior signal.

**EDGE CASES.** Empty (balanced); single node; perfectly balanced; the deep-skew-under-balanced-root
case above; a tree off-balance by exactly 1 (still balanced).

**COMPLEXITY.** O(n) time (each node once), O(h) space.

**DRY RUN.** The skewed-children tree: `check(2-left-chain)` returns −1 (its subtree heights differ by
2) → propagates up → root returns −1 → `isBalanced` false. ✓

**FOLLOW-UPS.** *Height of the tree?* → `check` without the imbalance test. *Count of unbalanced
nodes?* → don't short-circuit; tally.

---

## Debugging Dojo

One planted bug each. Find the failing input, explain, fix.

**Dojo-1 — maximum depth of a binary tree**
```java
int maxDepth(TreeNode root) {
    if (root == null) return 0;
    return Math.max(maxDepth(root.left), maxDepth(root.right));   // think about the +1
}
```

**Dojo-2 — invert a binary tree**
```java
TreeNode invert(TreeNode root) {
    if (root == null) return null;
    root.left = invert(root.left);
    root.right = invert(root.right);   // think: did we actually swap?
    return root;
}
```

**Dojo-3 — count nodes equal to a target value**
```java
int count(TreeNode root, int target) {
    if (root == null) return 0;
    int c = count(root.left, target) + count(root.right, target);
    if (root.val == target) c++;
    return c;                          // looks fine? check the recursion vs a global
}
```

---

### Dojo answers

**Dojo-1.** Missing the **`1 +`** — it returns the max of subtree depths without counting the current
node, so every depth is off by one (and a leaf returns 0 instead of 1). Failing input: a single node →
returns 0, should be 1. **Fix: `return 1 + Math.max(...)`.** (Bug-class 1: off-by-one in the recursion
contract.)

**Dojo-2.** It recurses but **never swaps** the children — `root.left` is assigned the inverted *left*
(not the inverted right). Failing input: `[1,2,3]` → returns it unchanged, should become `[1,3,2]`.
**Fix: swap — `TreeNode l = invert(root.left); root.left = invert(root.right); root.right = l;`.**
(Bug-class 4: the core operation is missing.)

**Dojo-3.** This one is actually **correct** — the trap is assuming there's a bug. Each node contributes
its own match plus its subtrees' counts; no shared mutable state, clean base case. The lesson: *verify
by tracing, don't pattern-match "looks suspicious."* (Sometimes the senior move is confidently saying
"I traced it — this is correct," which is itself a strong signal of disciplined verification.)

---

## Key Takeaways

1. **BST validity is a subtree constraint** — carry `(low, high)` bounds (use `long`), not parent
   comparisons.
2. **In-order on a BST = sorted;** `--k == 0` (pre-decrement) is the off-by-one that bites kth-smallest.
3. **LCA must report a node when it *is* `p` or `q`** — `root == null || root == p || root == q`;
   otherwise ancestor-of cases fail.
4. **Max path sum: clamp child gains to ≥ 0,** and distinguish the value used **at** the node
   (`node + l + r`, the bend) from the value returned **up** (`node + max(l, r)`).
5. **BFS per-level work needs the `q.size()` snapshot;** `i == sz - 1` is the rightmost, `i == 0` the
   leftmost.
6. **Balance/height: use the `-1` sentinel for O(n)** — the naive recursive check is O(n²); say so.
   And remember: **not every snippet has a bug — verify by tracing.**
