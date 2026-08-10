# Chapter 6: Hashing, Stacks, Queues & Monotonic Structures

> **Relearning log.** Two recoveries here. First, **the hash map is the universal "I've seen this
> before" memory** — most "do it in one pass / O(n)" optimizations are "replace a re-scan with a
> hash lookup." I'd been brute-forcing things a map trivializes. Second, the **monotonic stack** —
> I'd completely lost the intuition until I re-derived it as: *"for each element, find the nearest
> bigger/smaller one"* → keep a stack that's always increasing (or decreasing), and when the new
> element violates it, the things you pop just found their answer. That "the popped element found
> its boundary" framing is the whole pattern. The monotonic *deque* is the same idea for sliding-
> window max.

---

## 6.1 Hash maps & sets — the "seen before" memory

Recognition: anytime the brute force re-scans to ask *"have I seen X / how many of X / where was
X?"*, a hash structure makes it O(1).

| Question in the problem | Structure |
|--------------------------|-----------|
| "have I seen this value?" | `HashSet` |
| "where/when did I last see it?" | `HashMap<value, index>` |
| "how many of each?" | `HashMap<value, count>` (frequency map) |
| "group these by some key" | `HashMap<key, List<...>>` |

**Worked example — Two Sum (unsorted).** Can't two-pointer (would lose indices / need sort). One
pass, map of `value → index`, ask "have I seen `target - x`?"

```java
int[] twoSum(int[] a, int target) {              // O(n) / O(n)
    Map<Integer, Integer> seen = new HashMap<>();
    for (int i = 0; i < a.length; i++) {
        Integer j = seen.get(target - a[i]);
        if (j != null) return new int[]{j, i};
        seen.put(a[i], i);
    }
    return new int[]{-1, -1};
}
```

**Worked example — subarray sum equals K** (prefix sum + hash map). "Number of subarrays summing to
K" = for each prefix `P`, how many earlier prefixes equal `P - K`.

```java
int subarraySum(int[] a, int k) {                // O(n) / O(n)
    Map<Integer, Integer> prefixCount = new HashMap<>();
    prefixCount.put(0, 1);                        // empty prefix
    int sum = 0, count = 0;
    for (int x : a) {
        sum += x;
        count += prefixCount.getOrDefault(sum - k, 0);  // earlier prefix = sum-k
        prefixCount.merge(sum, 1, Integer::sum);
    }
    return count;
}
```

> The prefix-sum + hash-map combo is one of the highest-yield tricks in the coding round. The
> sentence to remember: **"number of subarrays with sum K = count of earlier prefix sums equal to
> (currentPrefix − K)."**

**Hashing gotchas to mention at L5:** worst-case O(n) on adversarial collisions; Java 8+ treeifies
buckets to O(log n); a bad `hashCode()` or using a mutable object as a key are classic prod bugs.

---

## 6.2 Stacks — LIFO and matching

Recognition: **nesting, matching, "most recent unmatched", undo, expression parsing.**

```java
// Valid parentheses. O(n) / O(n).
boolean isValid(String s) {
    Deque<Character> st = new ArrayDeque<>();
    Map<Character, Character> close = Map.of(')', '(', ']', '[', '}', '{');
    for (char c : s.toCharArray()) {
        if (close.containsValue(c)) st.push(c);                  // opener
        else if (st.isEmpty() || st.pop() != close.get(c)) return false;  // mismatched closer
    }
    return st.isEmpty();
}
```

> Use `ArrayDeque` as both stack and queue in Java — never the legacy `Stack` (synchronized,
> slower). `push/pop/peek` for stack; `offer/poll/peek` for queue.

---

## 6.3 Monotonic stack — nearest greater/smaller

The pattern I had to fully rebuild. **Maintain a stack whose values are monotonic; when the incoming
element breaks monotonicity, the elements you pop have just found their answer.**

```java
// Next greater element to the right for each index (-1 if none). O(n) / O(n).
int[] nextGreater(int[] a) {
    int n = a.length;
    int[] res = new int[n];
    Arrays.fill(res, -1);
    Deque<Integer> st = new ArrayDeque<>();   // indices, values DECREASING from bottom to top
    for (int i = 0; i < n; i++) {
        while (!st.isEmpty() && a[i] > a[st.peek()]) {
            res[st.pop()] = a[i];             // a[i] is the next-greater for the popped index
        }
        st.push(i);
    }
    return res;
}
```

**Worked example — largest rectangle in histogram.** For each bar, the rectangle extends left/right
until a shorter bar. A monotonic-increasing stack finds both boundaries in O(n).

```java
int largestRectangle(int[] h) {                  // O(n) / O(n)
    Deque<Integer> st = new ArrayDeque<>();      // indices, heights increasing
    int best = 0, n = h.length;
    for (int i = 0; i <= n; i++) {
        int cur = (i == n) ? 0 : h[i];           // sentinel 0 flushes the stack at the end
        while (!st.isEmpty() && cur < h[st.peek()]) {
            int height = h[st.pop()];
            int leftBound = st.isEmpty() ? -1 : st.peek();
            int width = i - leftBound - 1;
            best = Math.max(best, height * width);
        }
        st.push(i);
    }
    return best;
}
```

> The mnemonic: **increasing stack → finds the previous/next *smaller*; decreasing stack → finds the
> previous/next *greater*.** When you pop, the popper is the boundary on one side and the new stack
> top is the boundary on the other.

---

## 6.4 Monotonic deque — sliding window maximum

Same idea, but we also evict from the front when elements leave the window. The deque holds indices
whose values are decreasing; the front is always the window's max.

```java
// Max of every window of size k. O(n) / O(k).
int[] maxSlidingWindow(int[] a, int k) {
    Deque<Integer> dq = new ArrayDeque<>();      // indices, values decreasing
    int n = a.length;
    int[] res = new int[n - k + 1];
    for (int i = 0; i < n; i++) {
        while (!dq.isEmpty() && a[dq.peekLast()] <= a[i]) dq.pollLast();  // keep decreasing
        dq.offerLast(i);
        if (dq.peekFirst() <= i - k) dq.pollFirst();   // evict out-of-window front
        if (i >= k - 1) res[i - k + 1] = a[dq.peekFirst()];  // front = window max
    }
    return res;
}
```

---

## 6.5 Queues & deques

- **Queue (FIFO):** the backbone of [BFS (Ch 9)](09-pattern-graphs-bfs-dfs-topo-union-find.md).
- **Deque:** monotonic windows (above), and as a stack/queue hybrid.
- **Priority queue** (heap) gets its own [Chapter 10](10-pattern-heaps-intervals-greedy.md).

---

## 6.6 Common pitfalls

- Storing **values vs indices** in a monotonic stack — store indices when you need widths/positions.
- Forgetting the **sentinel** to flush the monotonic stack at the end (histogram).
- `<` vs `<=` in the monotonic comparison — decides how you treat equal elements (and whether you
  double-count). Pin it down with your traced example.
- Using mutable objects or arrays as `HashMap` keys (arrays use identity `hashCode`!) — use a
  `String`/record/`List` key instead.

## Interview Drills

- **D6.1 [E]** First non-repeating character in a string. *(Frequency map, then scan.)*
- **D6.2 [E]** Group anagrams. *(Map from sorted-string key → list.)*
- **D6.3 [M]** Daily temperatures (days until a warmer day). *(Monotonic decreasing stack of
  indices.)*
- **D6.4 [M]** Longest consecutive sequence in O(n). *(HashSet; start counting only at sequence
  starts.)*
- **D6.5 [H]** Sliding window maximum (above) — why O(n) despite the inner while? *(Each index is
  pushed and popped at most once.)*
- **D6.6 [H]** Largest rectangle in histogram; then "maximal rectangle" in a binary matrix (apply it
  row by row).

## Key Takeaways

1. **The hash map is "have I seen this?" memory** — most O(n) optimizations replace a re-scan with a
   lookup.
2. **Prefix sum + hash map** counts subarrays with a given sum in O(n) — memorize the framing.
3. **Stacks handle nesting/matching;** use `ArrayDeque`, never legacy `Stack`.
4. **Monotonic stack = nearest greater/smaller;** the popped element just found its boundary.
   Increasing→smaller-boundaries, decreasing→greater-boundaries.
5. **Monotonic deque = sliding-window max/min** in O(n); front holds the answer, evict the front
   when it leaves the window.
