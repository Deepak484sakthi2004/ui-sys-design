# Worked Solutions 03 — Binary Search (incl. Search on the Answer)

> Home chapter: [Ch 7](../07-pattern-binary-search-and-sorting.md). Format: [solutions index](00-solutions-index.md).
> Binary search is the single most bug-prone pattern — overflow, off-by-one, infinite loops, and
> wrong boundary directions. Catching these on sight is a *huge* correctness signal.

---

## P1 — Classic Binary Search `[E]`

**PROBLEM.** Return the index of `target` in a sorted array, or −1.

**RECOGNITION.** Sorted + lookup → binary search. Use the disciplined template, never improvise.

**THOUGHT.** "Halve the search interval each step by comparing the middle. The two eternal traps are
the `mid` computation (overflow) and the loop's termination (infinite loop / off-by-one)."

**BUGGY ATTEMPT.**
```java
int search(int[] a, int target) {
    int lo = 0, hi = a.length - 1;
    while (lo <= hi) {
        int mid = (lo + hi) / 2;                  // <-- the bug: can overflow
        if (a[mid] == target) return mid;
        if (a[mid] < target) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}
```

**SPOT THE BUG.** `(lo + hi) / 2` **overflows `int`** when `lo + hi > Integer.MAX_VALUE` (large
arrays / large indices). It silently goes negative → `a[mid]` throws or behaves wrongly. This is the
*famous* binary-search bug that lived in the JDK's own `Arrays.binarySearch` for years. **Fix:
`mid = lo + (hi - lo) / 2`** — mathematically identical, never overflows. (The `lo <= hi` /
`mid ± 1` structure here is correct for exact-match search.)

**CLEAN.**
```java
int search(int[] a, int target) {                 // O(log n) time, O(1) space
    int lo = 0, hi = a.length - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;              // overflow-safe — the fix
        if (a[mid] == target) return mid;
        if (a[mid] < target) lo = mid + 1;         // mid is excluded → no infinite loop
        else hi = mid - 1;
    }
    return -1;
}
```

**EDGE CASES.** Empty array (`hi = -1`, loop never runs → −1); single element; target smaller/larger
than all; target at the very ends; **large arrays** (the overflow case).

**COMPLEXITY.** O(log n) time, O(1) space.

**DRY RUN.** `[1,3,5,7,9], t=7`: lo0hi4 mid2 a=5<7→lo3; lo3hi4 mid3 a=7 → return 3. ✓

**FOLLOW-UPS.** *Duplicates, find first/last?* → P2. *Why prefer the half-open `pred` template?* →
P2/P4 show how it kills off-by-ones for boundary problems.

> Saying *"I'll write `lo + (hi - lo) / 2` to avoid the classic overflow"* — unprompted — is a tiny
> sentence that signals you've internalized a famous real-world bug. Cheap, high-value.

---

## P2 — Find First and Last Position `[M]`

**PROBLEM.** In a sorted array with duplicates, return the first and last index of `target`
(`[-1,-1]` if absent).

**RECOGNITION.** "First/last occurrence" → **lower bound** (first index `≥ target`) and **upper
bound** (first index `> target`). Last position = upperBound − 1.

**THOUGHT.** "Two boundary searches with the half-open `pred` template. The off-by-one trap is
forgetting that upper bound points *one past* the last occurrence."

**BUGGY ATTEMPT.**
```java
int[] searchRange(int[] a, int target) {
    int first = lowerBound(a, target);
    if (first == a.length || a[first] != target) return new int[]{-1, -1};
    int last = upperBound(a, target);            // <-- the bug: this is ONE PAST the last
    return new int[]{first, last};
}
// lowerBound: first i with a[i] >= target ; upperBound: first i with a[i] > target
int lowerBound(int[] a, int t) {
    int lo = 0, hi = a.length;
    while (lo < hi) { int m = lo + (hi - lo) / 2; if (a[m] >= t) hi = m; else lo = m + 1; }
    return lo;
}
int upperBound(int[] a, int t) {
    int lo = 0, hi = a.length;
    while (lo < hi) { int m = lo + (hi - lo) / 2; if (a[m] > t) hi = m; else lo = m + 1; }
    return lo;
}
```

**SPOT THE BUG.** `upperBound` returns the first index *strictly greater* than `target` — i.e. **one
past** the last occurrence. Returning it directly as `last` is off by one. Failing input:
`a=[5,7,7,8,8,10], target=8` → first=3, upperBound=5 (index of 10); returns `[3,5]`, but the last 8
is at index **4**. **Fix: `last = upperBound(a, target) - 1`.**

**CLEAN.**
```java
int[] searchRange(int[] a, int target) {          // O(log n) time, O(1) space
    int first = lowerBound(a, target);
    if (first == a.length || a[first] != target) return new int[]{-1, -1};
    int last = upperBound(a, target) - 1;          // step back to the actual last — the fix
    return new int[]{first, last};
}
```
(`lowerBound`/`upperBound` as above — both correct.)

**EDGE CASES.** Target absent (the `a[first] != target` guard); single occurrence (first == last);
all elements equal to target (`[0, n-1]`); target beyond array bounds (`first == a.length`).

**COMPLEXITY.** O(log n) (two searches), O(1).

**DRY RUN.** `[5,7,7,8,8,10], t=8`: lowerBound → 3; upperBound → 5; last = 4 → `[3,4]`. ✓ Count of
target = upperBound − lowerBound = 2.

**FOLLOW-UPS.** *Count occurrences?* → `upper − lower`. *Insert position?* → lowerBound itself.

---

## P3 — Koko Eating Bananas (search on the answer) `[M]`

**PROBLEM.** Piles of bananas; eat at speed `s` bananas/hour (one pile per hour max). Find the minimum
integer speed to finish all piles within `h` hours.

**RECOGNITION.** "Smallest speed such that a feasibility check passes" + monotone (faster → fewer
hours) → **binary search on the answer**.

**THOUGHT.** "Search the speed in `[1, max(piles)]`. `hours(s) = Σ ceil(pile / s)`. The ceiling is the
crux — a pile of 3 at speed 4 still costs a *whole* hour, not 0."

**BUGGY ATTEMPT.**
```java
int minEatingSpeed(int[] piles, int h) {
    int lo = 1, hi = 0;
    for (int p : piles) hi = Math.max(hi, p);
    while (lo < hi) {
        int speed = lo + (hi - lo) / 2;
        long hours = 0;
        for (int p : piles) hours += p / speed;          // <-- the bug: floor, not ceil
        if (hours <= h) hi = speed; else lo = speed + 1;
    }
    return lo;
}
```

**SPOT THE BUG.** `p / speed` is **integer floor division** — it under-counts hours (a partial pile is
treated as 0 extra hours), making `feasible` too optimistic and returning a speed that's too small.
Failing input: `piles=[3,6,7,11], h=8`.
- Correct (ceil): speed 4 → 1+2+2+3 = 8 ≤ 8 ✓; speed 3 → 1+2+3+4 = 10 > 8 ✗ → answer **4**.
- Buggy (floor): speed 3 → 1+2+2+3 = 8 ≤ 8 (floor(7/3)=2, floor(11/3)=3) → returns **3**. Wrong, and
  at speed 3 the piles actually take 10 hours.

**Fix: ceiling division — `(p + speed - 1) / speed`.**

**CLEAN.**
```java
int minEatingSpeed(int[] piles, int h) {           // O(n log maxPile) time, O(1) space
    int lo = 1, hi = 0;
    for (int p : piles) hi = Math.max(hi, p);
    while (lo < hi) {
        int speed = lo + (hi - lo) / 2;
        if (hoursNeeded(piles, speed) <= h) hi = speed;   // feasible → try slower
        else lo = speed + 1;                              // too slow → faster
    }
    return lo;
}
long hoursNeeded(int[] piles, int speed) {
    long hours = 0;
    for (int p : piles) hours += (p + speed - 1) / speed; // CEIL division — the fix
    return hours;
}
```

**EDGE CASES.** `h == piles.length` → must eat each pile in one hour → speed = max pile; one pile;
huge piles (use `long` for the hour sum to avoid overflow); `h` very large → speed 1.

**COMPLEXITY.** O(n log(maxPile)) — log over the *answer space*, n per feasibility check. O(1) space.

**DRY RUN.** `[3,6,7,11], h=8`: lo1 hi11 → mid6 hours=1+1+2+2=6≤8→hi6; mid3 hours=1+2+3+4=10>8→lo4;
mid5 hours 1+2+2+3=8≤8→hi5; mid4 hours 8≤8→hi4; lo==hi=4 → **4**. ✓

**FOLLOW-UPS.** Same skeleton: *ship packages in D days* (sum into days), *split array largest sum*,
*minimum days for bouquets*, *minimize max distance to gas station*. Recognizing the family — "smallest
X such that a monotone check passes" — is the whole skill.

---

## P4 — Search in Rotated Sorted Array `[M]`

**PROBLEM.** A sorted array rotated at an unknown pivot (distinct values); find `target`'s index or −1.

**RECOGNITION.** Sorted-but-rotated → modified binary search: at each `mid`, **one half is always
sorted**; decide which, then test if target lies within it.

**THOUGHT.** "Compare `a[lo]` and `a[mid]`. If `a[lo] <= a[mid]`, the left half is sorted; check if
target is in `[a[lo], a[mid])`. Else the right half is sorted. The boundary comparison must be `<=`,
not `<`, to handle the two-element case where `lo == mid`."

**BUGGY ATTEMPT.**
```java
int search(int[] a, int target) {
    int lo = 0, hi = a.length - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] == target) return mid;
        if (a[lo] < a[mid]) {                     // <-- the bug: < instead of <=
            if (a[lo] <= target && target < a[mid]) hi = mid - 1;
            else lo = mid + 1;
        } else {
            if (a[mid] < target && target <= a[hi]) lo = mid + 1;
            else hi = mid - 1;
        }
    }
    return -1;
}
```

**SPOT THE BUG.** When the search window shrinks to **two elements**, `lo == mid`, so `a[lo] == a[mid]`
and `a[lo] < a[mid]` is **false** — the code wrongly takes the "right half sorted" branch and can
discard the half containing the target. Failing input: `a=[3,1], target=1`.
- lo=0,hi=1,mid=0,a[0]=3≠1. `a[lo] < a[mid]` → `3 < 3` false → else branch: `a[mid] < target <= a[hi]`
  → `3 < 1`? false → `hi = mid - 1 = -1` → loop ends → returns **−1**, but 1 is at index 1. **Fix:
  `a[lo] <= a[mid]`.**

**CLEAN.**
```java
int search(int[] a, int target) {                 // O(log n) time, O(1) space
    int lo = 0, hi = a.length - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] == target) return mid;
        if (a[lo] <= a[mid]) {                     // left half sorted (incl. lo==mid) — the fix
            if (a[lo] <= target && target < a[mid]) hi = mid - 1;  // target in sorted left
            else lo = mid + 1;
        } else {                                   // right half sorted
            if (a[mid] < target && target <= a[hi]) lo = mid + 1;  // target in sorted right
            else hi = mid - 1;
        }
    }
    return -1;
}
```

**EDGE CASES.** No rotation (still works — whole array is the sorted left half); rotation at index 1;
two elements (the `<=` case); target at the pivot; single element; target absent.

**COMPLEXITY.** O(log n), O(1).

**DRY RUN.** `[4,5,6,7,0,1,2], t=0`: lo0hi6 mid3 a=7≠0; a[0]=4<=7 left sorted; 4<=0<7? no → lo4;
lo4hi6 mid5 a=1≠0; a[4]=0<=1 left sorted; 0<=0<1? yes → hi4; lo4hi4 mid4 a=0 → return 4. ✓

**FOLLOW-UPS.** *Duplicates allowed (e.g. `[1,0,1,1,1]`)?* → when `a[lo]==a[mid]==a[hi]` you can't tell
which half is sorted → shrink both ends by one (`lo++, hi--`), worst case O(n). Knowing why the
distinct-values O(log n) degrades is a great follow-up answer.

---

## P5 — Find Minimum in Rotated Sorted Array `[M]`

**PROBLEM.** Find the minimum in a rotated sorted array of distinct values.

**RECOGNITION.** The minimum is the rotation pivot. Binary search comparing `a[mid]` against the
**right** end tells us which side the pivot is on.

**THOUGHT.** "If `a[mid] > a[hi]`, the minimum is strictly to the right of mid (the rotation is in the
right half). Otherwise it's at mid or to the left. Compare against `a[hi]`, **not** `a[lo]` — comparing
against `a[lo]` fails on an already-sorted array."

**BUGGY ATTEMPT.**
```java
int findMin(int[] a) {
    int lo = 0, hi = a.length - 1;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] > a[lo]) lo = mid + 1;         // <-- the bug: compare to a[lo]
        else hi = mid;
    }
    return a[lo];
}
```

**SPOT THE BUG.** Comparing `a[mid]` to `a[lo]` breaks when the array isn't rotated (already sorted),
because then `a[mid] > a[lo]` is true throughout and it walks `lo` all the way to the right end —
returning the **maximum**. Failing input: `a=[1,2,3,4,5]` (rotation 0).
- lo0hi4 mid2 a=3 > a[0]=1 → lo3; lo3hi4 mid3 a=4 > a[0]=1 → lo4; lo==hi=4 → returns `a[4]=5`. The
  minimum is **1**. **Fix: compare `a[mid]` against `a[hi]`.**

**CLEAN.**
```java
int findMin(int[] a) {                            // O(log n) time, O(1) space
    int lo = 0, hi = a.length - 1;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] > a[hi]) lo = mid + 1;          // pivot (min) is to the RIGHT of mid — the fix
        else hi = mid;                             // min is mid or to the left (a[mid] <= a[hi])
    }
    return a[lo];                                  // lo == hi == index of minimum
}
```

**WHY compare with `a[hi]`, not `a[lo]`.** The right end `a[hi]` is a stable reference: in a rotated
sorted array, `a[mid] > a[hi]` *iff* the dip (minimum) lies strictly right of `mid`. `a[lo]` gives no
such clean signal once the left portion is itself sorted. This subtle reference choice is the whole
problem.

**EDGE CASES.** Not rotated (`[1,2,3]` → 1, the case the bug breaks); rotated by 1; two elements;
single element; minimum at the start vs. middle.

**COMPLEXITY.** O(log n), O(1).

**DRY RUN.** `[4,5,6,7,0,1,2]`: lo0hi6 mid3 a=7>a[6]=2→lo4; lo4hi6 mid5 a=1>2? no→hi5; lo4hi5 mid4
a=0>1? no→hi4; lo==hi=4 → a[4]=0. ✓

**FOLLOW-UPS.** *Find the rotation count?* = the returned index. *With duplicates?* → `a[mid]==a[hi]`
ambiguous → `hi--`; worst case O(n).

---

## P6 — Find Peak Element `[M]`

**PROBLEM.** An element strictly greater than its neighbors (treat out-of-bounds as −∞). Return the
index of **any** peak in O(log n). Adjacent elements differ.

**RECOGNITION.** "Find any peak in log time" → binary search **without a sorted array** — move toward
the higher neighbor; you're guaranteed to climb into a peak.

**THOUGHT.** "If `a[mid] < a[mid+1]`, an ascending slope means a peak exists to the *right* (the array
ends, bounded by −∞, so going up must eventually come down) → search right. Otherwise search left
(including mid). Move toward the *uphill* side."

**BUGGY ATTEMPT.**
```java
int findPeakElement(int[] a) {
    int lo = 0, hi = a.length - 1;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] > a[mid + 1]) lo = mid + 1;    // <-- the bug: direction reversed
        else hi = mid;
    }
    return lo;
}
```

**SPOT THE BUG.** The direction is inverted: when `a[mid] > a[mid+1]` we're on a *downhill* to the
right, so the peak is to the **left** (at mid or earlier) — we should set `hi = mid`, not move right.
Failing input: `a=[1,2,3,1]` (peak at index 2).
- lo0hi3 mid1 a[1]=2 > a[2]=3? no → hi=1; lo0hi1 mid0 a[0]=1 > a[1]=2? no → hi=0; return 0. But
  `a[0]=1` is **not** a peak (`a[1]=2 > 1`). **Fix: climb toward the larger neighbor —
  `if (a[mid] < a[mid+1]) lo = mid+1; else hi = mid;`.**

**CLEAN.**
```java
int findPeakElement(int[] a) {                    // O(log n) time, O(1) space
    int lo = 0, hi = a.length - 1;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] < a[mid + 1]) lo = mid + 1;     // uphill to the right → a peak is right of mid
        else hi = mid;                             // downhill (or equal-excluded) → peak at mid/left
    }
    return lo;                                     // lo == hi is a peak
}
```

**WHY this always finds a peak.** `mid + 1` is always in bounds because `lo < hi` ⇒ `mid < hi`. Each
step keeps a "there is a peak in `[lo, hi]`" invariant: we always move toward a higher neighbor, and
the −∞ boundaries guarantee the slope turns over. So `lo == hi` must be a peak.

**EDGE CASES.** Strictly increasing → peak is the last index; strictly decreasing → index 0; single
element → 0; two elements → the larger's index.

**COMPLEXITY.** O(log n), O(1). (Beating the trivial O(n) scan — the point of the problem.)

**DRY RUN.** `[1,2,1,3,5,6,4]`: lo0hi6 mid3 a[3]=3 < a[4]=5 → lo4; lo4hi6 mid5 a[5]=6 < a[6]=4? no →
hi5; lo4hi5 mid4 a[4]=5 < a[5]=6 → lo5; lo==hi=5 → index 5 (value 6, a peak). ✓

**FOLLOW-UPS.** *2D peak (greater than 4 neighbors)?* → binary search on columns, find the global max
of a column band — a genuine step up.

---

## Debugging Dojo

One planted bug each. Find the failing input, explain, fix.

**Dojo-1 — `sqrt(x)` integer part**
```java
int mySqrt(int x) {
    int lo = 0, hi = x;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (mid * mid <= x) lo = mid;            // think: termination + overflow
        else hi = mid - 1;
    }
    return lo;
}
```

**Dojo-2 — lower bound (first index ≥ target)**
```java
int lowerBound(int[] a, int target) {
    int lo = 0, hi = a.length - 1;               // think: can the answer be a.length?
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] >= target) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}
```

**Dojo-3 — binary search a value, half-open**
```java
boolean contains(int[] a, int target) {
    int lo = 0, hi = a.length;
    while (lo <= hi) {                           // think: bound + termination
        int mid = lo + (hi - lo) / 2;
        if (a[mid] == target) return true;
        if (a[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return false;
}
```

---

### Dojo answers

**Dojo-1.** Two bugs. (a) `lo = mid` (not `mid + 1`) with `lo < hi` causes an **infinite loop** when
`hi == lo + 1` and the condition holds (mid stays `lo` forever). (b) `mid * mid` **overflows `int`**
for large `x` (e.g. `x = 2_000_000_000`). **Fix: use the "largest mid with `mid*mid <= x`" pattern
with `lo = mid` only under a ceiling-mid, or simpler — `long square = (long) mid * mid;` and structure
as `if (square <= x) lo = mid + 1; else hi = mid - 1;` returning `hi`.** Failing inputs: `x=2`
(infinite loop) and large `x` (overflow). (Bug-classes 1 + 2.)

**Dojo-2.** `hi = a.length - 1` can't represent the answer when **target is greater than every
element** — lower bound should be able to return `a.length` (the insertion point at the end). Failing
input: `a=[1,2,3], target=5` → correct lower bound is 3, but this returns 2. **Fix: `hi = a.length`
(half-open).** (Bug-class 1: the search interval can't express the valid answer.)

**Dojo-3.** With half-open `hi = a.length`, the loop must be `lo < hi` and the else branch `hi = mid`.
Here `lo <= hi` plus `hi = mid` means when `lo == hi == a.length` initially-ish, `mid` can equal
`a.length` → **`a[mid]` is out of bounds**. Failing input: `target` larger than all, e.g.
`a=[1], target=2` → eventually `mid = 1`, `a[1]` throws. **Fix: `while (lo < hi)` (and this becomes a
"contains" via lowerBound + check), or use the closed-interval form `hi = a.length - 1` with
`hi = mid - 1`.** (Bug-class 1: mismatched interval convention → out-of-bounds.)

---

## Key Takeaways

1. **`mid = lo + (hi - lo) / 2`** — always; the `(lo+hi)/2` overflow is the famous one.
2. **Pick ONE interval convention and stick to it.** Half-open (`hi = n`, `lo < hi`, `hi = mid`) for
   boundary/lower-upper-bound; closed (`hi = n-1`, `lo <= hi`, `mid ± 1`) for exact match. Mixing them
   causes infinite loops and out-of-bounds.
3. **Upper bound is one past the last** — last position = `upperBound - 1`.
4. **"Search on the answer"** needs a *correct, monotone* feasibility check — watch **ceil vs floor**
   division (Koko).
5. **Rotated arrays: `a[lo] <= a[mid]` (not `<`)** for the sorted-half test; **find-min compares
   against `a[hi]`, not `a[lo]`**; **find-peak climbs toward the larger neighbor**. Each is a one-token
   bug with a clean failing input.
6. **State the invariant out loud** ("there is a [target/peak/min] in `[lo, hi]`") — it's how you and
   the interviewer both verify termination and correctness.
