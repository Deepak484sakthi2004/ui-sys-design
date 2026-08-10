# Worked Solutions 01 — Arrays, Two Pointers & Sliding Window

> Home chapter: [Ch 5](../05-pattern-arrays-strings-two-pointers-sliding-window.md). Format and
> drilling method: [solutions index](00-solutions-index.md). Every problem below carries a real,
> subtle bug in its first attempt — train yourself to spot it in under 60 seconds.

---

## P1 — Two Sum II (input array is sorted) `[E]`

**PROBLEM.** Given a 1-indexed sorted array and a target, return the 1-based indices of the two
numbers that add up to target. Exactly one solution; can't use the same element twice.

**RECOGNITION.** Sorted + find-a-pair → **two pointers from the ends** ([Ch 5](../05-pattern-arrays-strings-two-pointers-sliding-window.md)).
Not a hash map — the sortedness is the gift, use it for O(1) space.

**THOUGHT.** "Brute force is all pairs, O(n²). But it's sorted: if `a[lo]+a[hi]` is too big, the only
way to shrink is `hi--`; too small, `lo++`. Each step eliminates one element → O(n), O(1) space."

**BUGGY ATTEMPT.**
```java
int[] twoSum(int[] a, int target) {
    int lo = 0, hi = a.length - 1;
    while (lo <= hi) {                       // <-- the bug lives here
        int sum = a[lo] + a[hi];
        if (sum == target) return new int[]{lo + 1, hi + 1};
        if (sum < target) lo++;
        else hi--;
    }
    return new int[]{};
}
```

**SPOT THE BUG.** `while (lo <= hi)` allows `lo == hi`, which would let the algorithm "use the same
element twice." Failing input: `a = [3, 6]`, `target = 6` — wait, that pair is valid. The real
failure: `a = [1, 2, 3]`, `target = 6` has *no* valid pair (1+2+3, no two sum to 6), but with
`lo <= hi`, when `lo == hi == 2`, `sum = a[2]+a[2] = 6 == target` → returns `[3,3]`, claiming index 3
pairs with *itself*. **Fix: `while (lo < hi)`** — the two indices must be distinct.

**CLEAN.**
```java
int[] twoSum(int[] a, int target) {            // O(n) time, O(1) space
    int lo = 0, hi = a.length - 1;
    while (lo < hi) {                           // strict: distinct indices
        int sum = a[lo] + a[hi];
        if (sum == target) return new int[]{lo + 1, hi + 1};  // 1-indexed
        if (sum < target) lo++;                 // need larger → raise low
        else hi--;                              // need smaller → lower high
    }
    return new int[]{};                         // problem guarantees a solution
}
```

**EDGE CASES.** Two-element array (smallest valid); no-solution input (the `<` guard prevents a false
positive on a self-pair); duplicates like `[3,3]` target 6 → `lo=0, hi=1` works.

**COMPLEXITY.** O(n) — each iteration advances exactly one pointer toward the other, so at most n
steps. O(1) extra space — the whole appeal vs. the hash-map version.

**DRY RUN.** `a=[2,7,11,15], t=9`: lo=0,hi=3 → 2+15=17>9 → hi=2 → 2+11=13>9 → hi=1 → 2+7=9 → return
`[1,2]`. ✓

**FOLLOW-UPS.** *Unsorted input?* → hash map, O(n) space ([P1 in WS-02](02-hashing-stacks-solutions.md)).
*All pairs, not one?* → still two pointers but skip duplicates after a hit. *3Sum?* → fix one
element, two-pointer the rest ([Ch 5](../05-pattern-arrays-strings-two-pointers-sliding-window.md)).

---

## P2 — Longest Substring Without Repeating Characters `[M]`

**PROBLEM.** Length of the longest substring of `s` with all distinct characters.

**RECOGNITION.** "Longest contiguous substring with a property" → **variable sliding window**. The
property: no repeats inside the window.

**THOUGHT.** "Expand `right`; if the new char already sits inside the window, jump `left` past its
previous occurrence. Track the best length. A map of char→last-index lets me jump in O(1)."

**BUGGY ATTEMPT.**
```java
int lengthOfLongestSubstring(String s) {
    Map<Character, Integer> last = new HashMap<>();
    int left = 0, best = 0;
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        if (last.containsKey(c)) {
            left = last.get(c) + 1;          // <-- the bug
        }
        last.put(c, right);
        best = Math.max(best, right - left + 1);
    }
    return best;
}
```

**SPOT THE BUG.** `left = last.get(c) + 1` moves `left` to *just past the previous occurrence* — but
that previous occurrence may be **behind the current `left`**, which drags `left` *backward* and
re-admits characters we'd already excluded. Failing input: `"abba"`.
- right=0 'a': left=0, best=1, last={a:0}
- right=1 'b': left=0, best=2, last={a:0,b:1}
- right=2 'b': seen → left = 1+1 = 2; last={a:0,b:2}; best=max(2, 2-2+1)=2
- right=3 'a': seen, `last.get('a')=0` → **left = 0+1 = 1** (moved *backward* from 2 to 1!) → window
  becomes "ba" but it now wrongly spans index 1..3 = "bba" logic; best = max(2, 3-1+1=3) = **3**.

  The true answer for "abba" is **2** ("ab" or "ab"/"b a"). The bug reports 3. **Fix: never let
  `left` retreat — `left = Math.max(left, last.get(c) + 1)`.**

**CLEAN.**
```java
int lengthOfLongestSubstring(String s) {       // O(n) time, O(min(n, alphabet)) space
    Map<Character, Integer> last = new HashMap<>();
    int left = 0, best = 0;
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        if (last.containsKey(c)) {
            left = Math.max(left, last.get(c) + 1);   // left only moves forward — the fix
        }
        last.put(c, right);
        best = Math.max(best, right - left + 1);
    }
    return best;
}
```

**EDGE CASES.** `""` → 0; all same `"bbbb"` → 1; all distinct `"abcde"` → 5; the `"abba"`
retreat-trap above; `"tmmzuxt"` (a repeat far behind `left`).

**COMPLEXITY.** O(n) — `right` advances n times; `left` only advances (the `max` guarantees it never
moves back), so total pointer movement ≤ 2n. O(alphabet) space.

**DRY RUN.** `"abba"` with the fix: right=3 'a', `last.get('a')=0`, `left=max(2, 1)=2` → best stays 2.
✓ (The `max` is the entire difference between right and wrong.)

**FOLLOW-UPS.** *At most K distinct chars?* → window shrinks while `map.size() > k`
([Ch 5 template](../05-pattern-arrays-strings-two-pointers-sliding-window.md)). *Return the substring
itself?* → track `bestLeft` alongside `best`.

---

## P3 — Minimum Size Subarray Sum `[M]`

**PROBLEM.** Smallest length of a *contiguous* subarray whose sum ≥ `target` (positive ints), or 0 if
none.

**RECOGNITION.** "Shortest contiguous subarray with sum ≥ target", positive numbers → **variable
sliding window**, shrink-while-valid.

**THOUGHT.** "Expand right adding to `sum`; while `sum ≥ target`, the window is valid, so record the
length and shrink from the left to find a shorter valid one. Positivity is what makes shrinking
monotone."

**BUGGY ATTEMPT.**
```java
int minSubArrayLen(int target, int[] a) {
    int left = 0, sum = 0, best = Integer.MAX_VALUE;
    for (int right = 0; right < a.length; right++) {
        sum += a[right];
        if (sum >= target) {                 // <-- the bug: `if`, not `while`
            best = Math.min(best, right - left + 1);
            sum -= a[left++];
        }
    }
    return best == Integer.MAX_VALUE ? 0 : best;
}
```

**SPOT THE BUG.** `if (sum >= target)` shrinks the window **at most once per right-step**. But after
removing one left element the window can *still* be ≥ target, and an even shorter window may exist —
you must keep shrinking. Failing input: `target=7, a=[2,3,1,2,4,3]`.
- The true answer is **2** (`[4,3]`).
- With `if`: when right reaches index 5, the window has accumulated and shrinks only one step per
  iteration, never tightening fully → it reports a longer length (e.g. 3) and misses `[4,3]`.

**Fix: `while (sum >= target)`** — drain the window fully each step.

**CLEAN.**
```java
int minSubArrayLen(int target, int[] a) {      // O(n) time, O(1) space
    int left = 0, sum = 0, best = Integer.MAX_VALUE;
    for (int right = 0; right < a.length; right++) {
        sum += a[right];
        while (sum >= target) {                 // shrink fully while still valid — the fix
            best = Math.min(best, right - left + 1);
            sum -= a[left++];
        }
    }
    return best == Integer.MAX_VALUE ? 0 : best;
}
```

**EDGE CASES.** No subarray reaches target → 0; the whole array is the only answer; a single element
≥ target → 1; record *before* shrinking (the `best = min(...)` must precede `sum -= a[left++]`).

**COMPLEXITY.** O(n) — despite the nested `while`, `left` advances at most n times total across the
whole run, so it's 2n pointer moves, not n². (This is the classic "why is it not O(n²)" challenge —
have the answer ready.) O(1) space.

**DRY RUN.** `target=7, a=[2,3,1,2,4,3]`: window grows to `[2,3,1,2]` sum 8 ≥7 → best=4, drop 2 →
sum6; add 4 → `[3,1,2,4]` sum10 → best=4, drop3→7→best=4,drop1→6; add3→`[2,4,3]` sum9→best=3,drop2→7
→best=min(3, 2)=**2**, drop4→3. Returns 2. ✓

**FOLLOW-UPS.** *Negative numbers allowed?* → sliding window breaks (shrinking isn't monotone); use
**prefix sums + a monotonic deque** or a different technique. State this explicitly — recognizing
*when the window assumption fails* is a senior signal.

---

## P4 — Trapping Rain Water `[H]`

**PROBLEM.** Given bar heights, compute trapped water after rain.

**RECOGNITION.** Water above index `i` = `min(maxLeft, maxRight) - height[i]`. Two-pointer converging
gives O(1) space (vs. O(n) precomputed max arrays).

**THOUGHT.** "Move the pointer on the **shorter** side, because that side's water is *determined* —
it's bounded by the smaller of the two running maxes, and the shorter wall is the binding constraint.
Crucially I must update the running max *before* computing water, or I'll subtract a stale max."

**BUGGY ATTEMPT.**
```java
int trap(int[] h) {
    int l = 0, r = h.length - 1, leftMax = 0, rightMax = 0, water = 0;
    while (l < r) {
        if (h[l] < h[r]) {
            water += leftMax - h[l];          // <-- the bug: compute before updating leftMax
            leftMax = Math.max(leftMax, h[l]);
            l++;
        } else {
            water += rightMax - h[r];
            rightMax = Math.max(rightMax, h[r]);
            r--;
        }
    }
    return water;
}
```

**SPOT THE BUG.** When `h[l]` is a *new* left maximum, `leftMax - h[l]` is **negative** (we subtract
before raising the max), corrupting `water`. Failing input: `[4,2,3]`.
- l=0,r=2: h[0]=4 < h[2]=3? no → else: water += rightMax(0) - 3 = **-3**. Already wrong.

The water can never be negative. **Fix: update the running max *first*, then add `max - h[i]`** (which
is then guaranteed ≥ 0).

**CLEAN.**
```java
int trap(int[] h) {                            // O(n) time, O(1) space
    int l = 0, r = h.length - 1, leftMax = 0, rightMax = 0, water = 0;
    while (l < r) {
        if (h[l] < h[r]) {                      // left wall is the binding constraint
            leftMax = Math.max(leftMax, h[l]);  // update FIRST — guarantees non-negative
            water += leftMax - h[l];
            l++;
        } else {
            rightMax = Math.max(rightMax, h[r]);
            water += rightMax - h[r];
            r--;
        }
    }
    return water;
}
```

**WHY moving the shorter side is correct.** If `h[l] < h[r]`, then whatever happens on the right, the
water over `l` is capped by `leftMax` (because there's *some* wall ≥ `h[r] > h[l]` to the right). So
`leftMax` alone decides `l`'s water — safe to finalize `l` and move on. This argument is the part
interviewers probe; rehearse it.

**EDGE CASES.** Strictly increasing `[1,2,3]` → 0 (no basin); strictly decreasing → 0; flat → 0;
single peak `[0,3,0]` → 0 (edges hold nothing); `[]`/one bar → 0.

**COMPLEXITY.** O(n) one pass, O(1) space — beats the O(n)-space precomputed-max-arrays version.

**DRY RUN.** `[4,2,0,3,2,5]` → 9. Quick check of the trap: at index 2 (h=0), bounded by min(4,5)=4 →
4 units; index1(h=2)→2; index4(h=2)→2; index3(h=3)→1 → 4+2+2+1=9. ✓

**FOLLOW-UPS.** *2D trapping rain water?* → a min-heap of boundary cells, BFS inward from the lowest
boundary ([heaps](../10-pattern-heaps-intervals-greedy.md)) — a genuine step up. *Histogram largest
rectangle?* → different (monotonic stack, [WS-02](02-hashing-stacks-solutions.md)).

---

## P5 — Container With Most Water `[M]`

**PROBLEM.** Two lines at positions form a container; maximize the water area `(j-i) * min(h[i],h[j])`.

**RECOGNITION.** Maximize area between two ends → **two pointers from the ends**, move the limiting
(shorter) wall.

**BUGGY ATTEMPT.**
```java
int maxArea(int[] h) {
    int l = 0, r = h.length - 1, best = 0;
    while (l < r) {
        int area = (r - l) * Math.max(h[l], h[r]);   // <-- the bug: max, not min
        best = Math.max(best, area);
        if (h[l] < h[r]) l++; else r--;
    }
    return best;
}
```

**SPOT THE BUG.** Water height is limited by the **shorter** wall, so it's `Math.min`, not `Math.max`.
Failing input: `[1,8]` → correct area `1 * min(1,8) = 1`; bug gives `1 * max = 8`. The bug
overstates every area. **Fix: `Math.min(h[l], h[r])`.**

**CLEAN.**
```java
int maxArea(int[] h) {                         // O(n) time, O(1) space
    int l = 0, r = h.length - 1, best = 0;
    while (l < r) {
        int area = (r - l) * Math.min(h[l], h[r]);  // bounded by the shorter wall — the fix
        best = Math.max(best, area);
        if (h[l] < h[r]) l++;                   // move the shorter wall; the taller can't improve here
        else r--;
    }
    return best;
}
```

**WHY moving the shorter wall is correct.** Width only shrinks as pointers converge, so to ever beat
the current area we need a *taller* minimum. Moving the taller wall can only lower or keep the
`min` while losing width — pointless. Only moving the shorter wall has upside. (Exchange-argument
style reasoning — say it.)

**EDGE CASES.** Two bars (minimum input); equal heights (move either); strictly increasing/decreasing.

**COMPLEXITY.** O(n), O(1).

**DRY RUN.** `[1,8,6,2,5,4,8,3,7]` → 49 (between index1=8 and index8=7, width7, min7 → 49). ✓

**FOLLOW-UPS.** Contrast with **Trapping Rain Water** (P4): there we *sum* water over every index and
track running maxes; here we *maximize a single pair's* area. Same two-pointer skeleton, different
objective — being able to articulate the difference is the signal.

---

## P6 — Find All Anagrams in a String `[M]`

**PROBLEM.** Return all start indices in `s` where a permutation of `p` occurs.

**RECOGNITION.** "All windows of fixed size `p.length()` matching a frequency profile" → **fixed-size
sliding window** with a running count + a `matches` counter.

**BUGGY ATTEMPT.**
```java
List<Integer> findAnagrams(String s, String p) {
    List<Integer> res = new ArrayList<>();
    if (s.length() < p.length()) return res;
    int[] need = new int[26], have = new int[26];
    for (char c : p.toCharArray()) need[c - 'a']++;
    for (int i = 0; i < s.length(); i++) {
        have[s.charAt(i) - 'a']++;
        if (i >= p.length())
            have[s.charAt(i - p.length()) - 'a']--;   // slide off the left
        if (Arrays.equals(need, have)) res.add(i - p.length());  // <-- the bug
    }
    return res;
}
```

**SPOT THE BUG.** When the window first becomes full (at `i == p.length() - 1`), `i - p.length()` is
**−1**, so a legitimate match at start index 0 is recorded as `-1`. And once `i >= p.length()`, the
correct start is `i - p.length() + 1`, not `i - p.length()`. Failing input: `s="abab", p="ab"` —
expected `[0,1,2]`; the bug emits `-1, 0, 1`. **Fix: the start index is `i - p.length() + 1`.**

**CLEAN.**
```java
List<Integer> findAnagrams(String s, String p) {   // O(n) time, O(1) space (26)
    List<Integer> res = new ArrayList<>();
    int n = s.length(), m = p.length();
    if (n < m) return res;
    int[] need = new int[26], have = new int[26];
    for (char c : p.toCharArray()) need[c - 'a']++;
    for (int i = 0; i < n; i++) {
        have[s.charAt(i) - 'a']++;                  // add the entering char
        if (i >= m) have[s.charAt(i - m) - 'a']--;  // remove the char that just left the window
        if (i >= m - 1 && Arrays.equals(need, have))
            res.add(i - m + 1);                     // window is [i-m+1 .. i] — the fix
    }
    return res;
}
```

**EDGE CASES.** `p` longer than `s` → empty; match at index 0; overlapping matches (`"abab"`);
`p` and `s` equal; repeated chars in `p` (`"aa"`).

**COMPLEXITY.** O(n) — `Arrays.equals` over 26 fixed slots is O(26)=O(1) per step. O(1) extra space.
(If asked to avoid the per-step 26-compare, maintain a `matches` count of how many of the 26 buckets
agree, updating it incrementally — O(1) per step with no array compare.)

**DRY RUN.** `s="cbaebabacd", p="abc"` → matches at start 0 ("cba") and 6 ("bac") → `[0,6]`. With the
fix, when `i=2` (window "cba", full), `i>=m-1`, equals → add `2-3+1=0`. ✓

**FOLLOW-UPS.** *Just check if a permutation exists (Permutation in String)?* → return on first match.
*Incremental match counter* (above) to drop the O(26) compare → strictly O(1)/step.

---

## Debugging Dojo

No hints. Each snippet has exactly one planted bug. Find the failing input, explain the failure, give
the one-line fix. (Answers at the bottom — cover them.)

**Dojo-1 — reverse a string in place**
```java
void reverse(char[] s) {
    int l = 0, r = s.length;
    while (l < r) { char t = s[l]; s[l] = s[r]; s[r] = t; l++; r--; }
}
```

**Dojo-2 — move zeros to the end, keep order**
```java
void moveZeroes(int[] a) {
    int w = 0;
    for (int i = 0; i < a.length; i++)
        if (a[i] != 0) { a[w] = a[i]; w++; }
    // (nothing after the loop)
}
```

**Dojo-3 — max average of a fixed window of size k**
```java
double findMaxAverage(int[] a, int k) {
    int sum = 0;
    for (int i = 0; i < k; i++) sum += a[i];
    int best = sum;
    for (int i = k; i < a.length; i++) {
        sum += a[i] - a[i - k];
        best = Math.max(best, sum);
    }
    return best / k;                 // think carefully
}
```

---

### Dojo answers

**Dojo-1.** `r = s.length` is **out of bounds** — index `length` doesn't exist; the very first swap
throws `ArrayIndexOutOfBoundsException`. Failing input: any non-empty string. **Fix:
`r = s.length - 1`.** (Bug-class 1: off-by-one boundary.)

**Dojo-2.** Logic is fine for compaction but it **never zero-fills the tail**, so trailing slots keep
their old values. Failing input: `[0,1,0,3]` → after the loop `a = [1,3,0,3]` (the last `3` is stale)
instead of `[1,3,0,0]`. **Fix: after the loop, `while (w < a.length) a[w++] = 0;`.** (Bug-class 5:
incomplete write / forgot the tail.)

**Dojo-3.** `best` and `sum` are `int`, and the return is `best / k` → **integer division**, truncating
the average. Also `best` initialized to the first window is correct, but the division loses the
fraction. Failing input: `a=[1,12,-5,-6,50,3], k=4` → true max average `12.75`; `int` division gives
`12`. **Fix: `return (double) best / k;`** (and be wary of `int` overflow on large sums → use `long`
for `sum`). (Bug-class 2: integer division / overflow.)

---

## Key Takeaways

1. **`lo < hi` vs `lo <= hi`** decides whether two-pointer pairs are distinct — the Two Sum II trap.
2. **A sliding-window `left` must only move forward** — `Math.max(left, prev+1)`; the "abba" retreat
   is the canonical bug.
3. **Shrink with `while`, not `if`** — and record the answer *before* shrinking.
4. **Update running maxes before computing** (rain water) — subtracting a stale max yields negatives.
5. **Min vs max for the binding wall** (container) and **`i - m + 1` for window start** (anagrams)
   are the off-by-one/operator bugs that separate "wrote it" from "verified it."
6. **Always run the bug-class checklist aloud** ([index](00-solutions-index.md)): boundaries,
   overflow/division, the empty/single case, and the "why is this O(n) not O(n²)" justification.
