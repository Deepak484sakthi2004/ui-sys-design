# Chapter 5: Arrays, Two Pointers & Sliding Window

> **Relearning log.** These are the patterns I *thought* I remembered and kept fumbling. The two
> recoveries that mattered: (1) **sliding window is just two pointers with an invariant** — a left
> and right that only ever move forward, maintaining "the window is always valid." Once I framed it
> as "expand right, and while the window is invalid, shrink left," every variable-window problem
> collapsed into one template. (2) I kept writing O(n²) by restarting the inner pointer; the whole
> point is that **neither pointer ever moves backward**, which is *why* it's O(n) (see
> [Ch 4](04-complexity-mental-models.md)). I now write the invariant as a comment before I write the
> loop.

---

## 5.1 Recognition triggers

| If the problem says… | Reach for |
|----------------------|-----------|
| sorted array + find a pair/triplet with a target | **two pointers** from both ends |
| longest/shortest **contiguous** subarray/substring with a property | **sliding window** |
| "at most K distinct", "no repeating", "sum ≤ target" over a contiguous range | **variable-size window** |
| fixed window size K (max sum of K, averages) | **fixed-size window** |
| in-place rearrange / partition / dedup a sorted array | **two pointers** (slow/fast write index) |
| detect cycle in linked list / find middle | **fast & slow pointers** |

> The discriminator I rehearse: **contiguous → window; sorted-pair → two ends; in-place compaction →
> slow write pointer.** If it's "subsequence" (not contiguous), it's usually [DP](12-pattern-dynamic-programming.md), not a window.

---

## 5.2 Two pointers — opposite ends

Use on a **sorted** array (or a string you read symmetrically). Move the pointer that improves the
objective.

```java
// Two-sum on a SORTED array → indices of a pair summing to target. O(n) / O(1).
int[] twoSumSorted(int[] a, int target) {
    int lo = 0, hi = a.length - 1;
    while (lo < hi) {
        int sum = a[lo] + a[hi];
        if (sum == target) return new int[]{lo, hi};
        if (sum < target) lo++;   // need a bigger sum → raise the low end
        else hi--;                // need a smaller sum → lower the high end
    }
    return new int[]{-1, -1};
}
```

**Worked example — 3Sum (find unique triplets summing to 0).** Sort, fix one element, two-pointer
the rest. The trick everyone forgets is **skipping duplicates** at all three positions.

```java
List<List<Integer>> threeSum(int[] a) {          // O(n^2) / O(1) extra
    Arrays.sort(a);
    List<List<Integer>> res = new ArrayList<>();
    for (int i = 0; i < a.length - 2; i++) {
        if (i > 0 && a[i] == a[i - 1]) continue;             // skip dup anchors
        int lo = i + 1, hi = a.length - 1;
        while (lo < hi) {
            int sum = a[i] + a[lo] + a[hi];
            if (sum == 0) {
                res.add(List.of(a[i], a[lo], a[hi]));
                while (lo < hi && a[lo] == a[lo + 1]) lo++;   // skip dup
                while (lo < hi && a[hi] == a[hi - 1]) hi--;   // skip dup
                lo++; hi--;
            } else if (sum < 0) lo++;
            else hi--;
        }
    }
    return res;
}
```

---

## 5.3 Fast & slow pointers (Floyd)

Cycle detection, finding the middle, finding a duplicate (Floyd's tortoise-hare on an implicit
linked list).

```java
boolean hasCycle(ListNode head) {                // O(n) / O(1)
    ListNode slow = head, fast = head;
    while (fast != null && fast.next != null) {
        slow = slow.next;          // 1 step
        fast = fast.next.next;     // 2 steps
        if (slow == fast) return true;  // they meet inside the cycle
    }
    return false;
}
```

> The reusable insight: two pointers at different *speeds* will meet iff there's a cycle, and the
> meeting point lets you find the cycle's start (reset one pointer to head, advance both at speed 1).
> Same idea solves "find the duplicate number" in O(1) space.

---

## 5.4 Sliding window — the one template

This single template covers nearly all variable-window problems. **Expand right; while the window
is invalid, shrink left; record the answer when valid.**

```java
// Longest substring with at most K distinct characters. O(n) / O(alphabet).
int longestKDistinct(String s, int k) {
    Map<Character, Integer> count = new HashMap<>();
    int left = 0, best = 0;
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        count.merge(c, 1, Integer::sum);          // expand: include s[right]
        while (count.size() > k) {                // window invalid → shrink
            char d = s.charAt(left);
            if (count.merge(d, -1, Integer::sum) == 0) count.remove(d);
            left++;
        }
        best = Math.max(best, right - left + 1);  // window valid here
    }
    return best;
}
```

To adapt:
- **Longest with property P:** shrink `while (!P)`, record after the while (window valid).
- **Shortest with property P:** shrink `while (P)`, record *inside* the while before shrinking.
- **Fixed size K:** no inner while — add `s[right]`, and once `right - left + 1 > K`, pop `s[left++]`.

**Worked example — minimum window substring** (shortest substring of `s` containing all chars of
`t`). Same skeleton: expand right until the window *covers* `t`, then shrink left while it still
covers, recording the minimum.

```java
String minWindow(String s, String t) {           // O(n) / O(alphabet)
    int[] need = new int[128];
    for (char c : t.toCharArray()) need[c]++;
    int required = t.length(), left = 0, bestLen = Integer.MAX_VALUE, bestL = 0;
    for (int right = 0; right < s.length(); right++) {
        if (need[s.charAt(right)]-- > 0) required--;   // this char was needed
        while (required == 0) {                        // window covers t → try to shrink
            if (right - left + 1 < bestLen) { bestLen = right - left + 1; bestL = left; }
            if (need[s.charAt(left++)]++ == 0) required++;  // we dropped a needed char
        }
    }
    return bestLen == Integer.MAX_VALUE ? "" : s.substring(bestL, bestL + bestLen);
}
```

---

## 5.5 Prefix sums (the array sibling)

When you need many range-sum queries, or "subarray summing to K," precompute prefixes. (Combined
with a hash map this turns "count subarrays with sum K" into O(n) — see
[Ch 6](06-pattern-hashing-stacks-queues-monotonic.md).)

```java
// Range sum query: prefix[i] = a[0..i-1]; sum(i,j) = prefix[j+1] - prefix[i]. O(n) build, O(1) query.
int[] prefix = new int[a.length + 1];
for (int i = 0; i < a.length; i++) prefix[i + 1] = prefix[i] + a[i];
```

---

## 5.6 Common pitfalls (my mistakes log seeds)

- **Resetting the inner pointer** → accidental O(n²). Neither pointer moves backward, ever.
- **Off-by-one in window length:** it's `right - left + 1`.
- **Forgetting to remove zero-count keys** from the map → `count.size()` wrong.
- **3Sum/2Sum: dropping duplicate-skipping** → duplicate triplets.
- **Two-pointer on an *unsorted* array** — most two-end techniques require sorted; if I can't sort
  (need original indices), it's a **hash map** problem instead.

---

## Interview Drills

- **D5.1 [E]** Longest substring without repeating characters. *(Sliding window, shrink while a dup
  is in the window.)*
- **D5.2 [E]** Move all zeros to the end in place, preserving order. *(Slow write pointer.)*
- **D5.3 [M]** Max consecutive ones if you can flip at most K zeros. *(Variable window, shrink when
  zeros > K.)*
- **D5.4 [M]** Container with most water. *(Two pointers from ends, move the shorter wall.)*
- **D5.5 [H]** Minimum window substring (above) — explain why it's O(n) despite the inner while.
- **D5.6 [H]** Subarrays with exactly K distinct integers. *(atMost(K) − atMost(K−1), each a window.)*

## Key Takeaways

1. **Sliding window = two forward-only pointers maintaining an invariant.** Expand right; shrink
   left while invalid; record when valid. One template, many problems.
2. **Contiguous → window; sorted pair → two ends; in-place compaction → slow write pointer;
   subsequence → DP, not a window.**
3. **Forward-only movement is why it's O(n)** — rehearse that justification.
4. **Fast/slow pointers** solve cycle, middle, and duplicate-number in O(1) space.
5. **Prefix sums** turn repeated range queries and "subarray sum = K" into O(n) (with a hash map).
