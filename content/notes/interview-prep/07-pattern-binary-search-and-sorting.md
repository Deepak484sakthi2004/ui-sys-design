# Chapter 7: Binary Search & Sorting

> **Relearning log.** Binary search is the pattern I'm most *embarrassed* to have gotten rusty on,
> because the bugs are always the same three: the `mid` overflow, the `lo <= hi` vs `lo < hi`
> boundary, and the infinite loop when the window doesn't shrink. The fix that saved me: **pick ONE
> template and never improvise.** I memorized a single "find leftmost index where predicate is true"
> template and now I express every binary search as a predicate. The second, bigger recovery:
> **"binary search on the answer."** Half the medium-hard BS problems aren't searching an array at
> all — they're searching a *range of possible answers* and asking "is this answer feasible?" Once I
> saw "minimize the maximum / maximize the minimum" as a feasibility binary search, a whole class
> opened up.

---

## 7.1 The one template I trust

Search for the **leftmost** value `x` in `[lo, hi)` for which `predicate(x)` is true. `predicate`
must be **monotonic**: false…false, true…true.

```java
// Returns the smallest index in [lo, hi) where pred is true, or hi if never. O(log n) evals.
int binarySearch(int lo, int hi, IntPredicate pred) {
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;     // overflow-safe
        if (pred.test(mid)) hi = mid;     // answer is mid or to the left
        else lo = mid + 1;                // answer is strictly right
    }
    return lo;                            // == hi: first true (or hi if none)
}
```

Everything reduces to choosing `pred`:
- **First index ≥ target** (lower_bound): `pred = (i) -> a[i] >= target`.
- **First index > target** (upper_bound): `pred = (i) -> a[i] > target`.
- **Exact find:** compute lower_bound, then check `a[idx] == target`.
- **Count of target** = upper_bound − lower_bound.

> The whole bug surface collapses if you commit to `[lo, hi)` half-open, `lo < hi`,
> `mid = lo + (hi-lo)/2`, and the `pred` framing. I never write `lo <= hi` versions anymore — one
> template, zero off-by-ones.

---

## 7.2 Binary search on the answer (the high-value pattern)

When the problem says **"minimize the maximum X"** or **"maximize the minimum X"** or **"smallest
capacity/speed/days such that it works,"** binary-search the *answer space* with a feasibility
predicate.

**Worked example — ship packages within D days (min capacity).** Capacity is monotonic: if capacity
`c` works, any `> c` works. Binary search capacity; `feasible(c)` greedily counts days.

```java
int shipWithinDays(int[] weights, int days) {            // O(n log(sum)) time
    int lo = 0, hi = 0;
    for (int w : weights) { lo = Math.max(lo, w); hi += w; }   // min & max possible capacity
    while (lo < hi) {
        int cap = lo + (hi - lo) / 2;
        if (feasible(weights, cap, days)) hi = cap;      // works → try smaller
        else lo = cap + 1;                               // too small → bigger
    }
    return lo;
}
boolean feasible(int[] w, int cap, int days) {
    int needed = 1, load = 0;
    for (int x : w) {
        if (load + x > cap) { needed++; load = 0; }      // start a new day
        load += x;
    }
    return needed <= days;
}
```

Same shape solves: Koko eating bananas (min speed), split array largest sum, minimum days to make
bouquets, allocate books/pages. **Recognition: "smallest/largest value such that a check passes,"
and the check is monotonic in that value.**

---

## 7.3 Binary search on rotated / 2D / unknown-size inputs

- **Rotated sorted array:** one half is always sorted; decide which half is sorted, then check if the
  target lies in it. Still the predicate idea, just a custom comparison at `mid`.
- **Search in a sorted matrix:** start top-right (or bottom-left); each comparison eliminates a row
  or column — O(m+n). (Or treat row-sorted matrix as a flat array for true O(log mn).)
- **Peak element:** binary search toward the higher neighbor — O(log n) with no sorted array at all
  (predicate = "a[mid] < a[mid+1]" → peak is to the right).

```java
// Search rotated sorted array (distinct values). O(log n).
int searchRotated(int[] a, int target) {
    int lo = 0, hi = a.length - 1;
    while (lo <= hi) {                         // here a classic closed-interval form reads cleaner
        int mid = lo + (hi - lo) / 2;
        if (a[mid] == target) return mid;
        if (a[lo] <= a[mid]) {                 // left half sorted
            if (a[lo] <= target && target < a[mid]) hi = mid - 1;
            else lo = mid + 1;
        } else {                               // right half sorted
            if (a[mid] < target && target <= a[hi]) lo = mid + 1;
            else hi = mid - 1;
        }
    }
    return -1;
}
```

> I keep two templates only: the half-open `pred` template (default, for "find boundary" and "search
> on answer"), and the closed-interval exact-match form above for rotated/exact problems where
> comparing against `a[mid]` directly reads cleaner. Two templates, memorized, never improvised.

---

## 7.4 Sorting — what to actually know

You won't implement quicksort in an interview, but you must know:

| Algorithm | Time | Space | Stable? | When it matters |
|-----------|------|-------|---------|-----------------|
| Merge sort | O(n log n) | O(n) | yes | stable; basis for counting inversions, external sort |
| Quicksort | O(n log n) avg, O(n²) worst | O(log n) | no | in-place; Java primitives use dual-pivot quicksort |
| Heap sort | O(n log n) | O(1) | no | in-place, no recursion |
| Counting / radix | O(n + k) | O(n + k) | yes | bounded integer keys → beats n log n |

Java specifics worth saying: `Arrays.sort(int[])` is dual-pivot quicksort (not stable, no comparator);
`Arrays.sort(Object[])` / `Collections.sort` is **TimSort** (stable, O(n) on nearly-sorted input).

**Custom comparators** are the common interview use:

```java
// Sort intervals by start; ties by end. Avoid (a,b)->a-b on ints that can overflow.
Arrays.sort(intervals, (x, y) -> x[0] != y[0] ? Integer.compare(x[0], y[0])
                                              : Integer.compare(x[1], y[1]));
```

**Quickselect** — find the k-th smallest in average O(n) without full sort (partition like
quicksort, recurse into one side only). Know it for "k-th largest element" when a heap's O(n log k)
isn't good enough.

---

## 7.5 Common pitfalls

- `(lo + hi) / 2` **overflows** for large indices → always `lo + (hi - lo) / 2`.
- **Non-monotonic predicate** — binary search is only valid if `pred` flips once. State the
  monotonicity out loud.
- **Infinite loop** when the interval doesn't shrink (e.g., `lo = mid` instead of `mid + 1`).
- `a - b` comparator **overflow** for large ints → use `Integer.compare`.
- Forgetting `Arrays.sort(int[])` is **not stable** and takes **no comparator** (box to `Integer[]`
  if you need either).

## Interview Drills

- **D7.1 [E]** Find first and last position of a target in a sorted array. *(lower_bound &
  upper_bound.)*
- **D7.2 [E]** Sqrt(x) integer part. *(BS on the answer: largest m with m*m ≤ x.)*
- **D7.3 [M]** Koko eating bananas / min eating speed. *(BS on the answer + feasibility.)*
- **D7.4 [M]** Search in rotated sorted array (above); then with duplicates.
- **D7.5 [H]** Median of two sorted arrays in O(log(m+n)). *(Binary search the partition.)*
- **D7.6 [H]** Split array into k subarrays minimizing the largest sum. *(BS on the answer.)*

## Key Takeaways

1. **One half-open `pred` template** kills the off-by-one and overflow bugs. Express every search as
   a monotonic predicate.
2. **"Minimize the max / smallest value that works" = binary search on the answer** with a
   feasibility check — one of the highest-yield medium-hard patterns.
3. **Rotated arrays:** one half is always sorted; decide which, then test if the target is in it.
4. **Know sorting properties** (stable? in-place? n log n vs n+k) and Java's defaults (dual-pivot
   quicksort for primitives, TimSort for objects).
5. **Quickselect** gives k-th element in average O(n).
