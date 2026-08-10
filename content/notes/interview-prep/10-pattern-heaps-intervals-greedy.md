# Chapter 10: Heaps, Intervals & Greedy

> **Relearning log.** Three things came back here. (1) The heap is **"I need the current best/worst
> repeatedly, and the set keeps changing"** — top-K, merge-K, running median, scheduling. I'd been
> sorting when a heap was the right incremental tool. (2) For **top-K largest, you use a MIN-heap of
> size K** (counterintuitive — you keep the K best by repeatedly evicting the smallest). I got that
> backwards every time until I wrote the reason down. (3) **Interval problems almost always start by
> sorting** — by start or by end — and the choice of which decides the whole solution. And greedy is
> the scariest because it's only correct when you can *argue* it (exchange argument); I now force
> myself to state *why* the greedy choice is safe.

---

## 10.1 Heaps (priority queues)

Java's `PriorityQueue` is a **min-heap** by default. `offer`/`poll`/`peek` are O(log n); `peek` is
O(1). For a max-heap: `new PriorityQueue<>(Collections.reverseOrder())` or a comparator.

```java
PriorityQueue<Integer> minHeap = new PriorityQueue<>();
PriorityQueue<Integer> maxHeap = new PriorityQueue<>(Collections.reverseOrder());
```

### Top-K — min-heap of size K

```java
// K largest elements. O(n log k) time, O(k) space — beats full sort's O(n log n) for k << n.
int[] topKLargest(int[] a, int k) {
    PriorityQueue<Integer> heap = new PriorityQueue<>();   // MIN-heap of the k best so far
    for (int x : a) {
        heap.offer(x);
        if (heap.size() > k) heap.poll();   // evict the smallest → keep the k largest
    }
    return heap.stream().mapToInt(i -> i).toArray();
}
```

> The mantra: **K largest → min-heap of size K; K smallest → max-heap of size K.** You keep a heap
> of "the K best so far" and evict the *worst of the best* whenever it overflows. For k-th largest
> specifically, the heap's root after the pass is the answer. (Quickselect from
> [Ch 7](07-pattern-binary-search-and-sorting.md) does it in average O(n) if asked to beat
> O(n log k).)

### Merge K sorted lists / streams

```java
// Merge k sorted lists. O(N log k) where N = total elements.
ListNode mergeKLists(ListNode[] lists) {
    PriorityQueue<ListNode> pq = new PriorityQueue<>((a, b) -> a.val - b.val);
    for (ListNode l : lists) if (l != null) pq.offer(l);
    ListNode dummy = new ListNode(0), tail = dummy;
    while (!pq.isEmpty()) {
        ListNode n = pq.poll();
        tail.next = n; tail = n;
        if (n.next != null) pq.offer(n.next);
    }
    return dummy.next;
}
```

### Two-heap trick — running median

A **max-heap** for the lower half and a **min-heap** for the upper half, kept balanced. Median is the
top of one (odd) or the average of both tops (even). The pattern generalizes to "median of a data
stream" and "sliding window median."

---

## 10.2 Intervals — sort first, then sweep

The decision that drives every interval problem: **sort by start or by end?**

```java
// Merge overlapping intervals. Sort by START. O(n log n).
int[][] merge(int[][] iv) {
    Arrays.sort(iv, (a, b) -> Integer.compare(a[0], b[0]));
    List<int[]> out = new ArrayList<>();
    int[] cur = iv[0];
    for (int i = 1; i < iv.length; i++) {
        if (iv[i][0] <= cur[1]) cur[1] = Math.max(cur[1], iv[i][1]);  // overlap → extend
        else { out.add(cur); cur = iv[i]; }                            // gap → close current
    }
    out.add(cur);
    return out.toArray(new int[0][]);
}
```

- **Merge / insert / overlap detection** → sort by **start**.
- **Maximum non-overlapping intervals / activity selection / minimum removals** → sort by **end**,
  greedily take the earliest-ending compatible interval (classic exchange-argument greedy).
- **Minimum meeting rooms** → either a min-heap of end times (sort by start, poll rooms that freed),
  or the "sweep line" of +1/−1 events.

```java
// Minimum meeting rooms. Sort starts; min-heap of end times. O(n log n).
int minMeetingRooms(int[][] iv) {
    Arrays.sort(iv, (a, b) -> Integer.compare(a[0], b[0]));
    PriorityQueue<Integer> ends = new PriorityQueue<>();  // earliest-ending room on top
    for (int[] m : iv) {
        if (!ends.isEmpty() && ends.peek() <= m[0]) ends.poll();  // a room freed up → reuse
        ends.offer(m[1]);
    }
    return ends.size();                                   // peak concurrency = rooms needed
}
```

> **Sweep line**: turn each interval into a `+1` event at start and `−1` at end, sort events, and
> track the running sum — its max is the peak overlap. Great for "max concurrent X" and "car
> pooling / booking" problems.

---

## 10.3 Greedy — only when you can justify it

Greedy makes a locally optimal choice and never reconsiders. It's correct *only* if a greedy choice
is provably safe. I force myself to state the argument:

- **Exchange argument:** "If an optimal solution didn't make my greedy choice, I can swap to my
  choice without making it worse." (Activity selection: taking the earliest-ending interval is
  always at least as good.)
- **Greedy-stays-ahead:** "After each step my partial solution is at least as good as any other
  partial solution."

Classic safely-greedy problems: interval scheduling (earliest end), jump game (track farthest
reachable), gas station (if total gas ≥ cost, the unique start is just after the lowest running
deficit), Huffman coding (always merge the two smallest), and assigning cookies.

```java
// Jump game: can you reach the last index? Greedy farthest-reach. O(n).
boolean canJump(int[] a) {
    int reach = 0;
    for (int i = 0; i < a.length; i++) {
        if (i > reach) return false;            // stuck before here
        reach = Math.max(reach, i + a[i]);
    }
    return true;
}
```

> **Greedy vs DP discriminator:** if a locally optimal choice provably can't hurt the global
> optimum, greedy (and it's faster). If choices interact and you might need to "undo," it's
> [DP (Ch 12)](12-pattern-dynamic-programming.md). When unsure in the room, I propose DP as the
> safe default and *then* argue whether greedy is provably enough — that ordering shows judgment.

---

## 10.4 Common pitfalls

- **Top-K with the wrong heap polarity** (max-heap for k-largest) → O(n log n) or wrong answer.
  K-largest = min-heap.
- **Building a heap by inserting one-by-one** is O(n log n); **heapify** of an existing array is O(n)
  — mention it if asked to build from a batch.
- **Interval sort key**: merging needs start-sort; activity selection needs end-sort. Pick wrong and
  the greedy breaks.
- **Asserting greedy without an argument** — interviewers will hand you a counterexample. State the
  exchange argument or fall back to DP.
- **Comparator overflow** (`a - b` for large/long values) → use `Integer.compare` / `Long.compare`.

## Interview Drills

- **D10.1 [E]** K closest points to origin. *(Max-heap of size k by distance, or quickselect.)*
- **D10.2 [E]** Last stone weight. *(Max-heap, repeatedly smash the two largest.)*
- **D10.3 [M]** Top K frequent elements. *(Frequency map → min-heap of size k, or bucket sort.)*
- **D10.4 [M]** Merge intervals; insert interval; non-overlapping intervals (min removals).
- **D10.5 [M]** Meeting rooms II (above); car pooling. *(Heap / sweep line.)*
- **D10.6 [H]** Find median from a data stream. *(Two heaps.)*
- **D10.7 [H]** Task scheduler / reorganize string. *(Greedy with a max-heap of counts.)*

## Key Takeaways

1. **Heap = repeatedly need the current best from a changing set.** Top-K, merge-K, running median,
   scheduling.
2. **K largest → min-heap of size K; K smallest → max-heap of size K.** Keep the K best, evict the
   worst.
3. **Two heaps (max-heap low half + min-heap high half) = running median.**
4. **Intervals: sort first** — by *start* for merge/overlap, by *end* for max non-overlapping;
   heap or sweep-line for max concurrency.
5. **Greedy only with a justification** (exchange argument / stays-ahead). When in doubt, DP is the
   safe default; argue greedy down from there.
