# Chapter 11: Recursion & Backtracking

> **Relearning log.** Backtracking is where my rust showed worst, because the *code* is easy but the
> *template* is unforgiving — one misplaced `add`/`remove` or a shallow-vs-deep copy and you get
> garbage. The recovery: memorize **one template** — `choose → recurse → un-choose` — and treat
> every problem (subsets, permutations, combinations, N-Queens, word search) as a fill-in of that
> template's three blanks: *what's a choice, what makes a complete solution, and how do I prune.*
> The other recovery: **the recursion tree is the complexity** — drawing it tells me it's O(2ⁿ) for
> subsets, O(n!) for permutations, and *that's expected* (these are exponential by nature; the
> interviewer set `n ≤ 20` on purpose — see [Ch 4](04-complexity-mental-models.md)).

---

## 11.1 The universal backtracking template

```java
void backtrack(State state, Choices remaining, List<Solution> results) {
    if (isComplete(state)) {                 // base case: record a full solution
        results.add(copyOf(state));          // COPY — state is mutated on the way back up
        return;
    }
    for (Choice c : validChoices(remaining, state)) {  // prune here
        apply(state, c);                     // choose
        backtrack(state, advance(remaining, c), results);  // explore
        undo(state, c);                      // un-choose (the "back" in backtrack)
    }
}
```

The three blanks I fill for every problem:
1. **What is a choice?** (the next element to include, the next cell to fill, the next character.)
2. **When is a solution complete?** (used all elements / reached length k / filled the board.)
3. **How do I prune?** (skip used elements, skip duplicates, abandon invalid partials early.)

> The bug that cost me hours: **adding `state` directly to `results` instead of a copy.** Because we
> mutate `state` on the way back up, every stored reference ends up pointing at the same (eventually
> empty) list. Always `new ArrayList<>(path)`.

---

## 11.2 The four canonical shapes

### Subsets (include/exclude each element) — O(2ⁿ · n)

```java
List<List<Integer>> subsets(int[] a) {
    List<List<Integer>> res = new ArrayList<>();
    dfs(a, 0, new ArrayList<>(), res);
    return res;
}
void dfs(int[] a, int i, List<Integer> path, List<List<Integer>> res) {
    if (i == a.length) { res.add(new ArrayList<>(path)); return; }
    dfs(a, i + 1, path, res);          // exclude a[i]
    path.add(a[i]);
    dfs(a, i + 1, path, res);          // include a[i]
    path.remove(path.size() - 1);      // un-choose
}
```

### Combinations (choose k from n, order doesn't matter) — use a `start` index

```java
void combine(int n, int k, int start, List<Integer> path, List<List<Integer>> res) {
    if (path.size() == k) { res.add(new ArrayList<>(path)); return; }
    for (int i = start; i <= n; i++) {     // start prevents reusing earlier elements → no perms
        path.add(i);
        combine(n, k, i + 1, path, res);
        path.remove(path.size() - 1);
    }
}
```

### Permutations (order matters) — use a `used[]` set

```java
void permute(int[] a, boolean[] used, List<Integer> path, List<List<Integer>> res) {
    if (path.size() == a.length) { res.add(new ArrayList<>(path)); return; }
    for (int i = 0; i < a.length; i++) {
        if (used[i]) continue;
        used[i] = true; path.add(a[i]);
        permute(a, used, path, res);
        path.remove(path.size() - 1); used[i] = false;
    }
}
```

### Constraint satisfaction (N-Queens, Sudoku, word search) — validity check + prune

```java
// Word search in a grid: DFS from each cell, mark visited, backtrack. O(m*n*4^L).
boolean exist(char[][] b, String w) {
    for (int i = 0; i < b.length; i++)
        for (int j = 0; j < b[0].length; j++)
            if (dfs(b, i, j, w, 0)) return true;
    return false;
}
boolean dfs(char[][] b, int i, int j, String w, int k) {
    if (k == w.length()) return true;
    if (i < 0 || j < 0 || i >= b.length || j >= b[0].length || b[i][j] != w.charAt(k)) return false;
    char tmp = b[i][j]; b[i][j] = '#';     // mark visited (choose)
    boolean found = dfs(b, i+1, j, w, k+1) || dfs(b, i-1, j, w, k+1)
                 || dfs(b, i, j+1, w, k+1) || dfs(b, i, j-1, w, k+1);
    b[i][j] = tmp;                          // restore (un-choose)
    return found;
}
```

---

## 11.3 Handling duplicates (the subtle part)

When the input has duplicates and you must avoid duplicate *solutions*: **sort first**, then skip a
choice if it equals the previous one *and the previous one wasn't used at this level*.

```java
// Subsets II / Combination Sum II — sorted input, skip same-value siblings.
for (int i = start; i < a.length; i++) {
    if (i > start && a[i] == a[i - 1]) continue;   // skip duplicate at the same tree level
    path.add(a[i]);
    dfs(a, i + 1, path, res);
    path.remove(path.size() - 1);
}
```

> The `i > start` (not `i > 0`) is the whole trick: it skips duplicates that are *siblings* in the
> recursion tree while still allowing the same value deeper down the path. Getting this exactly
> right is a strong signal; hand-waving it is a tell.

---

## 11.4 Pruning = the difference between AC and TLE

Backtracking is exponential; pruning is what makes it pass. Prune by:
- **Early termination** when a partial solution can't possibly complete (e.g., remaining sum < 0 in
  combination-sum → `break` since input is sorted).
- **Constraint propagation** (N-Queens: track attacked columns/diagonals in sets for O(1) validity).
- **Ordering choices** to hit dead-ends sooner.

> Always say "this is exponential in the worst case, but the pruning cuts the branches that can't
> lead to a solution." That sentence shows you understand both the cost and the mitigation.

---

## 11.5 Recursion hygiene & common pitfalls

- **Storing references instead of copies** of the path (the #1 bug).
- **Forgetting to un-choose** (`remove` / reset `used` / restore the cell).
- **Stack depth** — recursion depth is O(n) space; mention it, and the iterative alternative for
  pathological depth.
- **`start` vs `used[]`**: combinations use a `start` index (no reordering); permutations use
  `used[]` (every position available).
- **Duplicate skip using `i > 0`** instead of `i > start` — wrong; over-prunes.

## Interview Drills

- **D11.1 [E]** Subsets; subsets II (with duplicates).
- **D11.2 [E]** Permutations; permutations II.
- **D11.3 [M]** Combination sum (reuse allowed); combination sum II (no reuse, duplicates in input).
- **D11.4 [M]** Letter combinations of a phone number; generate parentheses (prune by open/close
  counts).
- **D11.5 [M]** Word search (above); palindrome partitioning.
- **D11.6 [H]** N-Queens (constraint sets for columns and both diagonals).
- **D11.7 [H]** Sudoku solver (constraint propagation + backtracking).

## Key Takeaways

1. **One template: choose → recurse → un-choose.** Fill three blanks: what's a choice, what's a
   complete solution, how do I prune.
2. **Always store a *copy* of the path**, never the mutated reference.
3. **`start` index for combinations, `used[]` for permutations.**
4. **Duplicates: sort, then skip `i > start && a[i] == a[i-1]`** — siblings only, not deeper paths.
5. **Pruning turns exponential into passing;** state both the worst-case cost and why the pruning
   tames it. Small `n` (≤ ~20) is the interviewer telling you exponential is expected.
