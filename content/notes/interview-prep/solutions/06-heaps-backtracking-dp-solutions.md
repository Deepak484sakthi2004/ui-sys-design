# Worked Solutions 06 — Heaps/Greedy, Backtracking & DP

> Home chapters: [Ch 10](../10-pattern-heaps-intervals-greedy.md), [Ch 11](../11-pattern-recursion-backtracking.md),
> [Ch 12](../12-pattern-dynamic-programming.md). Format: [solutions index](00-solutions-index.md).
> The marquee bugs here — heap polarity, the backtracking shallow-copy, the knapsack loop direction,
> DP base-case initialization — are *the* classic "I see exactly why that's wrong" moments.

---

## P1 — Kth Largest Element in an Array `[M]`

**PROBLEM.** Return the k-th largest element (k-th in sorted-descending order, duplicates count).

**RECOGNITION.** "K-th largest from a stream/array" → **min-heap of size k** (counterintuitive but
correct), or quickselect for average O(n).

**THOUGHT.** "Keep a min-heap holding only the k largest seen so far. When it overflows k, evict the
smallest. After processing everything, the heap's *root* (its minimum) is exactly the k-th largest."

**BUGGY ATTEMPT.**
```java
int findKthLargest(int[] a, int k) {
    PriorityQueue<Integer> heap = new PriorityQueue<>();   // min-heap
    for (int x : a) heap.offer(x);                          // <-- the bug: never capped at size k
    return heap.peek();
}
```

**SPOT THE BUG.** It adds everything and returns `peek()` — the **global minimum**, i.e. the k-th
*smallest*, not largest. The size was never capped at k. Failing input: `a=[3,2,1,5,6,4], k=2` →
k-th largest is **5**, but `peek()` of a full min-heap is **1**. **Fix: after each `offer`, if
`heap.size() > k` then `heap.poll()`** — so the heap retains exactly the k largest and its root is the
answer.

**CLEAN.**
```java
int findKthLargest(int[] a, int k) {               // O(n log k) time, O(k) space
    PriorityQueue<Integer> heap = new PriorityQueue<>();   // min-heap of the k largest so far
    for (int x : a) {
        heap.offer(x);
        if (heap.size() > k) heap.poll();           // evict the smallest — the fix
    }
    return heap.peek();                             // root = smallest of the k largest = kth largest
}
```

**Why min-heap (not max-heap) for k-th *largest*.** A max-heap would put the global max on top; you'd
poll k times. The size-k *min*-heap is better when k ≪ n: O(n log k) time and O(k) space, and it
streams. The mnemonic from [Ch 10](../10-pattern-heaps-intervals-greedy.md): **k largest → min-heap of
size k.**

**EDGE CASES.** k = 1 (the maximum); k = n (the minimum); duplicates (`[2,2,2], k=2` → 2); negative
numbers; k > n (clarify / guard).

**COMPLEXITY.** O(n log k) time, O(k) space. (Quickselect: average O(n), worst O(n²) — mention as the
alternative if asked to beat O(n log k).)

**DRY RUN.** `[3,2,1,5,6,4], k=2`: heap evolves keeping the 2 largest → after all, holds {5,6}, root 5
→ **5**. ✓

**FOLLOW-UPS.** *Kth largest in a *stream* (online)?* → keep the size-k min-heap as a field; `add`
returns the current k-th largest in O(log k). *Top-k frequent elements?* → frequency map → size-k
min-heap by frequency.

---

## P2 — Merge Intervals `[M]`

**PROBLEM.** Merge all overlapping intervals.

**RECOGNITION.** Interval problem → **sort first**. For merging/overlap, sort by **start**, then sweep.

**THOUGHT.** "Sort by start so overlapping intervals are adjacent. Walk, extending the current
interval's end while the next starts within it; otherwise close the current and start a new one. The
sort key is everything — sort by the wrong field and the sweep is meaningless."

**BUGGY ATTEMPT.**
```java
int[][] merge(int[][] iv) {
    Arrays.sort(iv, (x, y) -> Integer.compare(x[1], y[1]));   // <-- the bug: sort by END
    List<int[]> out = new ArrayList<>();
    int[] cur = iv[0];
    for (int i = 1; i < iv.length; i++) {
        if (iv[i][0] <= cur[1]) cur[1] = Math.max(cur[1], iv[i][1]);
        else { out.add(cur); cur = iv[i]; }
    }
    out.add(cur);
    return out.toArray(new int[0][]);
}
```

**SPOT THE BUG.** Sorting by **end** breaks the adjacency assumption the sweep relies on: a later
interval can have an earlier *start*, so the merged result loses the true minimum start. Failing input:
`[[1,4],[2,3]]`.
- Sort by end → `[[2,3],[1,4]]`. cur=`[2,3]`; next `[1,4]`, `1 <= 3` → merge `cur[1]=max(3,4)=4` →
  `cur=[2,4]`. Output `[[2,4]]`, but the correct merge is **`[[1,4]]`** (start should be 1). **Fix:
  sort by *start*.**

**CLEAN.**
```java
int[][] merge(int[][] iv) {                        // O(n log n) time, O(n) space
    Arrays.sort(iv, (x, y) -> Integer.compare(x[0], y[0]));   // sort by START — the fix
    List<int[]> out = new ArrayList<>();
    int[] cur = iv[0];
    for (int i = 1; i < iv.length; i++) {
        if (iv[i][0] <= cur[1]) cur[1] = Math.max(cur[1], iv[i][1]);  // overlap → extend end
        else { out.add(cur); cur = iv[i]; }                            // gap → close and restart
    }
    out.add(cur);                                   // don't forget the last interval
    return out.toArray(new int[0][]);
}
```

**Note on the comparator.** Use `Integer.compare(x[0], y[0])`, **not** `x[0] - y[0]` — the subtraction
**overflows** for large/negative coordinates and silently mis-sorts. (Bug-class 2; a frequent live
catch.)

**EDGE CASES.** Single interval; no overlaps (all kept); fully nested `[[1,10],[2,3]]` → `[[1,10]]`;
touching `[[1,4],[4,5]]` → merge to `[[1,5]]` (uses `<=`); forgetting to add the final `cur`.

**COMPLEXITY.** O(n log n) time (the sort dominates), O(n) space.

**DRY RUN.** `[[1,3],[2,6],[8,10],[15,18]]` → sort stays; merge [1,3]&[2,6]→[1,6]; gap→[8,10]; gap→
[15,18] → `[[1,6],[8,10],[15,18]]`. ✓

**FOLLOW-UPS.** *Insert one interval into a sorted non-overlapping list?* → linear merge, no full sort.
*Minimum rooms / max overlap?* → sort + min-heap of ends, or sweep line ([Ch 10](../10-pattern-heaps-intervals-greedy.md)).
*Non-overlapping intervals (min removals)?* → sort by **end**, greedy.

---

## P3 — Subsets `[M]`

**PROBLEM.** Return all subsets of a distinct-integer array (the power set).

**RECOGNITION.** "All combinations / power set" → **backtracking** (include/exclude each element).

**THOUGHT.** "Build a `path` incrementally; at each leaf record a snapshot. The non-negotiable rule:
record a **copy** of `path`, because `path` is mutated as the recursion unwinds."

**BUGGY ATTEMPT.**
```java
List<List<Integer>> subsets(int[] a) {
    List<List<Integer>> res = new ArrayList<>();
    dfs(a, 0, new ArrayList<>(), res);
    return res;
}
void dfs(int[] a, int start, List<Integer> path, List<List<Integer>> res) {
    res.add(path);                                  // <-- the bug: stores the live reference
    for (int i = start; i < a.length; i++) {
        path.add(a[i]);
        dfs(a, i + 1, path, res);
        path.remove(path.size() - 1);
    }
}
```

**SPOT THE BUG.** `res.add(path)` stores a **reference** to the single, continually-mutated `path`
list. Every entry in `res` points at the *same* object, which is empty again by the time recursion
finishes → `res` is a list of N identical (empty) lists. Failing input: `[1,2]` → expected
`[[],[1],[1,2],[2]]`; actual `[[],[],[],[]]`. **Fix: store a copy — `res.add(new ArrayList<>(path));`.**

**CLEAN.**
```java
List<List<Integer>> subsets(int[] a) {             // O(2^n * n) time, O(n) recursion depth
    List<List<Integer>> res = new ArrayList<>();
    dfs(a, 0, new ArrayList<>(), res);
    return res;
}
void dfs(int[] a, int start, List<Integer> path, List<List<Integer>> res) {
    res.add(new ArrayList<>(path));                 // snapshot a COPY — the fix
    for (int i = start; i < a.length; i++) {
        path.add(a[i]);                             // choose
        dfs(a, i + 1, path, res);                   // explore (start = i+1: no reuse, no reorder)
        path.remove(path.size() - 1);               // un-choose
    }
}
```

**EDGE CASES.** Empty input → `[[]]` (the empty subset still exists); single element → `[[],[x]]`;
the count must be 2ⁿ (a quick self-check); with duplicates → sort + skip `i > start && a[i]==a[i-1]`
(Subsets II).

**COMPLEXITY.** O(2ⁿ · n) — 2ⁿ subsets, each up to length n to copy. O(n) recursion depth (output not
counted).

**DRY RUN.** `[1,2]`: add []; i=0 add 1 → add [1]; i=1 add 2 → add [1,2]; backtrack; i=1 add 2 → add
[2] → `[[],[1],[1,2],[2]]`. ✓

**FOLLOW-UPS.** *Permutations?* → `used[]` instead of a `start` index (order matters). *Combinations
(choose k)?* → stop at `path.size() == k`. *Subsets with duplicates?* → sort + sibling-skip.

---

## P4 — Combination Sum `[M]`

**PROBLEM.** Distinct candidates, a target; return all unique combinations summing to target. **Each
candidate may be reused unlimited times.**

**RECOGNITION.** "All combinations summing to target, with reuse" → backtracking; reuse is encoded by
passing the **same** start index (not `i + 1`) into the recursion.

**THOUGHT.** "Try each candidate from `start` onward; subtract it and recurse *still allowing the same
index* (reuse). Use `start` (not 0) to avoid permutations of the same combination. Prune when the
remaining target goes negative."

**BUGGY ATTEMPT.**
```java
void dfs(int[] c, int start, int remain, List<Integer> path, List<List<Integer>> res) {
    if (remain == 0) { res.add(new ArrayList<>(path)); return; }
    if (remain < 0) return;
    for (int i = start; i < c.length; i++) {
        path.add(c[i]);
        dfs(c, i + 1, remain - c[i], path, res);    // <-- the bug: i + 1 forbids reuse
        path.remove(path.size() - 1);
    }
}
```

**SPOT THE BUG.** Passing `i + 1` advances past the current candidate, so each number is used **at most
once** — but the problem allows unlimited reuse. Failing input: `candidates=[2,3,6,7], target=7` →
expected `[[2,2,3],[7]]`; the bug can't form `[2,2,3]` (it would need to reuse 2) → returns only
`[[7]]`. **Fix: recurse with `i` (same index) to permit reuse.**

**CLEAN.**
```java
List<List<Integer>> combinationSum(int[] candidates, int target) {
    List<List<Integer>> res = new ArrayList<>();
    dfs(candidates, 0, target, new ArrayList<>(), res);
    return res;
}
void dfs(int[] c, int start, int remain, List<Integer> path, List<List<Integer>> res) {
    if (remain == 0) { res.add(new ArrayList<>(path)); return; }
    if (remain < 0) return;                          // prune: overshot
    for (int i = start; i < c.length; i++) {
        path.add(c[i]);
        dfs(c, i, remain - c[i], path, res);         // pass i (NOT i+1) → reuse allowed — the fix
        path.remove(path.size() - 1);
    }
}
```

**Contrast with Combination Sum II** (no reuse, duplicates in input): there you *do* pass `i + 1`
**and** add the sibling-skip `if (i > start && c[i] == c[i-1]) continue;` after sorting. Articulating
the difference between the two is a strong signal.

**EDGE CASES.** No combination reaches target → `[]`; target smaller than the min candidate; a single
candidate dividing the target (`[2], target=6` → `[[2,2,2]]`); large target (the pruning matters).

**COMPLEXITY.** Exponential in the worst case (bounded by the number of combinations); the `remain < 0`
prune is what keeps it tractable. O(target/min) recursion depth.

**DRY RUN.** `[2,3,6,7], target=7`: 2→2→… `[2,2,3]` (sum 7) recorded; …; 7 → `[7]` recorded →
`[[2,2,3],[7]]`. ✓

**FOLLOW-UPS.** *Count combinations only (not list them)?* → DP (unbounded knapsack count). *No reuse
+ input duplicates?* → Combination Sum II as above.

---

## P5 — Coin Change (fewest coins) `[M]`

**PROBLEM.** Fewest coins summing to `amount` (unlimited coins of each denomination), or −1 if
impossible.

**RECOGNITION.** "Min count to reach a target with reusable items" → **unbounded-knapsack DP**;
`dp[x]` = fewest coins to make `x`.

**THOUGHT.** "`dp[x] = 1 + min over coins of dp[x - coin]`. Base `dp[0] = 0`. Unreachable amounts must
stay an 'infinity' sentinel so the `min` never picks them — initializing the table to 0 silently makes
every amount free."

**BUGGY ATTEMPT.**
```java
int coinChange(int[] coins, int amount) {
    int[] dp = new int[amount + 1];                 // <-- the bug: defaults to all 0
    for (int x = 1; x <= amount; x++)
        for (int coin : coins)
            if (coin <= x) dp[x] = Math.min(dp[x], dp[x - coin] + 1);
    return dp[amount];                              // and never distinguishes "impossible"
}
```

**SPOT THE BUG.** `new int[amount+1]` initializes every entry to **0**, so `dp[x] = min(0, …)` stays 0
forever — the algorithm reports that every amount needs 0 coins. There's also no −1 for the impossible
case. Failing input: `coins=[2], amount=3` → expected **−1** (can't make 3 from 2s); returns **0**.
**Fix: initialize `dp[1..amount]` to a sentinel (`amount + 1`, an unreachable upper bound), keep
`dp[0] = 0`, and map a still-sentinel result to −1.**

**CLEAN.**
```java
int coinChange(int[] coins, int amount) {          // O(amount * coins) time, O(amount) space
    int[] dp = new int[amount + 1];
    Arrays.fill(dp, amount + 1);                    // sentinel = "infinity" (unreachable) — the fix
    dp[0] = 0;                                       // base case
    for (int x = 1; x <= amount; x++)
        for (int coin : coins)
            if (coin <= x) dp[x] = Math.min(dp[x], dp[x - coin] + 1);
    return dp[amount] > amount ? -1 : dp[amount];   // still sentinel → impossible
}
```

**Why `amount + 1` as the sentinel (not `Integer.MAX_VALUE`).** Using `MAX_VALUE` then doing
`dp[x-coin] + 1` would **overflow** to a negative number and corrupt the `min`. `amount + 1` is safely
larger than any real answer (which is ≤ amount, using all 1-coins) and never overflows. (Bug-class 2,
avoided by design.)

**EDGE CASES.** `amount = 0` → 0; impossible amount → −1 (the sentinel check); a coin equal to the
amount → 1; large amount with `MAX_VALUE` sentinel would overflow (why we use `amount+1`).

**COMPLEXITY.** O(amount · |coins|) time, O(amount) space.

**DRY RUN.** `coins=[1,2,5], amount=11` → dp[11]=3 (5+5+1). ✓ `coins=[2], amount=3` → dp[3] stays
sentinel 4 > 3 → **−1**. ✓

**FOLLOW-UPS.** *Count the number of ways (Coin Change II)?* → `dp[x] += dp[x-coin]`, and **loop coins
on the outside** to count combinations not permutations. *Fewest with each coin once?* → 0/1 knapsack
(P6's loop direction).

---

## P6 — Partition Equal Subset Sum (0/1 knapsack loop direction) `[M]`

**PROBLEM.** Can the array be split into two subsets with equal sum?

**RECOGNITION.** Equal split ⇔ a subset sums to `total/2` → **0/1 subset-sum knapsack**; `dp[s]` = "can
we reach sum s using each element at most once."

**THOUGHT.** "If total is odd, impossible. Else target = total/2; `dp[s] |= dp[s - x]` for each item x.
With a 1D array, iterate the capacity **descending** so each item is used at most once — ascending
turns it into *unbounded* knapsack (reuse), which is a different, wrong problem."

**BUGGY ATTEMPT.**
```java
boolean canPartition(int[] a) {
    int total = Arrays.stream(a).sum();
    if (total % 2 != 0) return false;
    int target = total / 2;
    boolean[] dp = new boolean[target + 1];
    dp[0] = true;
    for (int x : a)
        for (int s = x; s <= target; s++)          // <-- the bug: ASCENDING → reuses item x
            dp[s] |= dp[s - x];
    return dp[target];
}
```

**SPOT THE BUG.** Iterating `s` **ascending** lets the same element `x` be counted multiple times in
one pass (`dp[s-x]` may already include `x` from earlier in *this* loop) — that's *unbounded* knapsack,
allowing reuse. Failing input: `a=[1, 2, 5]` (total 8, target 4). No subset sums to 4 → answer
**false**. But ascending lets 2 be used twice (`dp[2]` true → `dp[4] |= dp[2]`) → returns **true**.
**Fix: iterate the capacity **descending** (`s` from `target` down to `x`)** so each item updates
larger sums *before* its own smaller sums are revisited → used at most once.

**CLEAN.**
```java
boolean canPartition(int[] a) {                    // O(n * sum) time, O(sum) space
    int total = 0;
    for (int x : a) total += x;
    if (total % 2 != 0) return false;
    int target = total / 2;
    boolean[] dp = new boolean[target + 1];
    dp[0] = true;
    for (int x : a)
        for (int s = target; s >= x; s--)          // DESCENDING → each item used once — the fix
            dp[s] |= dp[s - x];
    return dp[target];
}
```

**The mnemonic to memorize** ([Ch 12](../12-pattern-dynamic-programming.md)): **0/1 knapsack → loop
capacity descending (use once); unbounded knapsack → ascending (reuse).** This one-bit difference is
among the most-tested DP traps.

**EDGE CASES.** Odd total → false immediately; single element (can't split → false unless 0); all
equal even count; a zero in the array (doesn't change reachability); large sum (watch memory).

**COMPLEXITY.** O(n · sum) time, O(sum) space.

**DRY RUN.** `[1,5,11,5]` total 22, target 11: descending updates reach `dp[11]` via 11, or 1+5+5 →
true. ✓ `[1,2,5]` target 4 → descending never sets `dp[4]` (no real subset) → **false**. ✓

**FOLLOW-UPS.** *Target sum (assign ± signs)?* → reduces to subset-sum. *Minimum subset difference?* →
find the largest reachable sum ≤ total/2. *Count partitions?* → switch boolean to integer counts.

---

## Debugging Dojo

One planted bug each. Find the failing input, explain, fix.

**Dojo-1 — k closest points to origin (max-heap of size k)**
```java
int[][] kClosest(int[][] points, int k) {
    PriorityQueue<int[]> heap = new PriorityQueue<>(
        (p, q) -> (q[0]*q[0] + q[1]*q[1]) - (p[0]*p[0] + p[1]*p[1]));   // max-heap by distance
    for (int[] p : points) {
        heap.offer(p);
        if (heap.size() > k) heap.poll();
    }
    return heap.toArray(new int[0][]);              // think about the comparator
}
```

**Dojo-2 — permutations of distinct integers**
```java
void permute(int[] a, List<Integer> path, boolean[] used, List<List<Integer>> res) {
    if (path.size() == a.length) { res.add(new ArrayList<>(path)); return; }
    for (int i = 0; i < a.length; i++) {
        if (used[i]) continue;
        used[i] = true; path.add(a[i]);
        permute(a, path, used, res);
        path.remove(path.size() - 1);               // think: did we reset everything?
    }
}
```

**Dojo-3 — longest increasing subsequence (O(n²))**
```java
int lengthOfLIS(int[] a) {
    int n = a.length, best = 0;
    int[] dp = new int[n];                           // think about the initial value
    for (int i = 0; i < n; i++)
        for (int j = 0; j < i; j++)
            if (a[j] < a[i]) dp[i] = Math.max(dp[i], dp[j] + 1);
    for (int v : dp) best = Math.max(best, v);
    return best;
}
```

---

### Dojo answers

**Dojo-1.** The comparator does `q·q − p·p` on **`int`**, which **overflows** for large coordinates
(e.g. `±10⁴` → squares ~10⁸, sums ~2×10⁸, differences can exceed `int` when combined). Failing input:
points near `±30000`. **Fix: compare with `Integer.compare`/`Long.compare` on `long` distances —
`Long.compare((long)q[0]*q[0]+(long)q[1]*q[1], (long)p[0]*p[0]+(long)p[1]*p[1])`.** (Bug-class 2:
comparator overflow — the same trap as `a - b`.)

**Dojo-2.** It removes the last path element on backtrack but **never resets `used[i] = false`**, so
each index is marked used once and never freed → only the first permutation (or a truncated set) is
produced. Failing input: `[1,2,3]` → expects 6 permutations, gets far fewer. **Fix: after the recursive
call, `used[i] = false;` alongside the `path.remove`.** (Bug-class 4: incomplete un-choose.)

**Dojo-3.** `dp` defaults to **0**, but every element is an increasing subsequence of length **1** on
its own, so the base should be 1. As written, lengths undercount by one (and a strictly-decreasing
array returns 0 instead of 1). Failing input: `[10,9,2,5,3,7,101,18]` → true LIS length 4, this returns
3. **Fix: `Arrays.fill(dp, 1);`** before the loops. (Bug-class 5: wrong base-case initialization.)

---

## Key Takeaways

1. **K largest → min-heap of size k** (cap it!); the uncapped heap returns the *smallest*. Comparators
   must use `Integer/Long.compare`, never `a - b` (overflow).
2. **Intervals: sort by *start* for merging;** sort-by-end loses the true minimum start.
3. **Backtracking: store a *copy* of the path, fully un-choose (`remove` *and* reset `used`),** and use
   `start` vs `i+1`/`i` deliberately (reuse vs no-reuse vs no-reorder).
4. **DP base cases and sentinels are bugs waiting to happen:** init coin-change to `amount+1` (not 0,
   not `MAX_VALUE`), init LIS `dp` to 1.
5. **0/1 knapsack loops capacity *descending* (use once); unbounded loops *ascending* (reuse)** — the
   single-bit trap that flips correctness (Partition Equal Subset).
6. **The bug-class checklist pays off most in DP/backtracking:** copy-vs-reference, base-case init,
   loop direction, and overflow in sentinels/comparators.
