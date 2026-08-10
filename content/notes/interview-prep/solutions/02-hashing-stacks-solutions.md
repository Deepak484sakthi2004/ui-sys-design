# Worked Solutions 02 — Hashing, Stacks & Monotonic Structures

> Home chapter: [Ch 6](../06-pattern-hashing-stacks-queues-monotonic.md). Format: [solutions index](00-solutions-index.md).
> Several bugs here are about **Java semantics** (array `hashCode`, empty-stack pops) — exactly the
> kind of "knows the language deeply" mistake that, caught live, impresses an interviewer.

---

## P1 — Two Sum (unsorted) `[E]`

**PROBLEM.** Return indices of the two numbers summing to `target`. Exactly one answer; no reuse.

**RECOGNITION.** Unsorted + find-a-pair → **hash map of value→index** ("have I seen the complement?").
Can't two-pointer without losing original indices.

**THOUGHT.** "One pass: for each `x`, ask whether `target - x` was already seen. If yes, done. Store
`x` *after* the check so I never pair an element with itself."

**BUGGY ATTEMPT.**
```java
int[] twoSum(int[] a, int target) {
    Map<Integer, Integer> seen = new HashMap<>();
    for (int i = 0; i < a.length; i++) {
        seen.put(a[i], i);                          // <-- the bug: store before checking
        if (seen.containsKey(target - a[i]))
            return new int[]{seen.get(target - a[i]), i};
    }
    return new int[]{};
}
```

**SPOT THE BUG.** Storing `a[i]` *before* the lookup lets the element match **itself** when
`2 * a[i] == target`. Failing input: `a=[3,2,4], target=6` — at `i=0`, store `{3:0}`, then check
`target-3 = 3` → present → returns `{0,0}` (index 0 paired with itself), but the real answer is
`{1,2}` (2+4). **Fix: check first, then put.**

**CLEAN.**
```java
int[] twoSum(int[] a, int target) {                 // O(n) time, O(n) space
    Map<Integer, Integer> seen = new HashMap<>();   // value -> index
    for (int i = 0; i < a.length; i++) {
        Integer j = seen.get(target - a[i]);        // ask BEFORE inserting self
        if (j != null) return new int[]{j, i};
        seen.put(a[i], i);
    }
    return new int[]{};
}
```

**EDGE CASES.** `target = 2*x` with a single `x` (must NOT self-pair — the bug); duplicate values
that legitimately pair (`[3,3], target 6` → `{0,1}` works because the second 3 finds the first);
negative numbers.

**COMPLEXITY.** O(n) time, O(n) space (the map). The space is the price of not sorting; if O(1) space
is demanded and the array can be sorted, sort + two-pointer ([WS-01 P1](01-arrays-windows-solutions.md)).

**DRY RUN.** `[3,2,4], t=6`: i=0 get(3)→null, put{3:0}; i=1 get(4)→null, put{3:0,2:1}; i=2 get(2)→1 →
return `{1,2}`. ✓

**FOLLOW-UPS.** *Sorted input?* → two pointers, O(1) space. *Count all pairs?* → frequency map, handle
`x == target-x` carefully (choose 2). *3Sum / 4Sum?* → fix elements + this as the inner step.

---

## P2 — Group Anagrams `[M]`

**PROBLEM.** Group words that are anagrams of each other.

**RECOGNITION.** "Group by a canonical key" → **hash map from a normalized signature → list**. The
signature: sorted characters, or a 26-count fingerprint.

**THOUGHT.** "Two words are anagrams iff their letter multisets match. I'll map each word to a key
that's identical for anagrams. Sorting the word is O(L log L); a count-array fingerprint is O(L).
Either works — but the *key type* matters in Java."

**BUGGY ATTEMPT.**
```java
List<List<String>> groupAnagrams(String[] words) {
    Map<int[], List<String>> groups = new HashMap<>();   // <-- the bug: int[] as a key
    for (String w : words) {
        int[] count = new int[26];
        for (char c : w.toCharArray()) count[c - 'a']++;
        groups.computeIfAbsent(count, k -> new ArrayList<>()).add(w);
    }
    return new ArrayList<>(groups.values());
}
```

**SPOT THE BUG.** A Java **array uses identity-based `hashCode`/`equals`** — two distinct `int[]`
objects with identical contents are *never* equal keys. So every word lands in its own group; anagrams
are never grouped. Failing input: `["eat","tea"]` → returns `[["eat"],["tea"]]` instead of
`[["eat","tea"]]`. **Fix: use a value-based key** — a `String` built from the counts (or the sorted
word), e.g. `Arrays.toString(count)` or `new String(sortedChars)`.

**CLEAN.**
```java
List<List<String>> groupAnagrams(String[] words) {      // O(N * L) with count-key
    Map<String, List<String>> groups = new HashMap<>();
    for (String w : words) {
        int[] count = new int[26];
        for (char c : w.toCharArray()) count[c - 'a']++;
        StringBuilder key = new StringBuilder();          // value-based key — the fix
        for (int c : count) key.append('#').append(c);    // '#' delimiter avoids "1,11" vs "11,1" clashes
        groups.computeIfAbsent(key.toString(), k -> new ArrayList<>()).add(w);
    }
    return new ArrayList<>(groups.values());
}
```

**EDGE CASES.** Empty string (its own anagram group); single word; words of different lengths (can't
be anagrams — their count-keys differ); the **delimiter** matters: without `#`, counts `[1,11]` and
`[11,1]` would both stringify to `111` — a real collision. Mention the delimiter; it shows care.

**COMPLEXITY.** O(N·L) with the count-key (N words, length L) — beats O(N·L log L) sorting-key. O(N·L)
space.

**DRY RUN.** `["eat","tea","tan","ate","nat","bat"]`: "eat"/"tea"/"ate" share key
`#0#0...#1(a)...#1(e)#1(t)`; "tan"/"nat" share another; "bat" alone → 3 groups. ✓

**FOLLOW-UPS.** *Why count-key over sorted-key?* O(L) vs O(L log L). *Unicode / huge alphabet?* → sorted
key or a `HashMap<Character,Integer>` fingerprint instead of `int[26]`.

> This is the single most "Java-depth-revealing" bug in the set. Saying *"I can't use `int[]` as a
> map key — arrays don't override `hashCode`"* unprompted signals you understand the language's object
> model, not just its syntax.

---

## P3 — Valid Parentheses `[E]`

**PROBLEM.** Given a string of `()[]{}`, return whether all brackets are correctly matched and nested.

**RECOGNITION.** "Matching / nesting / most-recent-unmatched" → **stack**.

**THOUGHT.** "Push openers; on a closer, the top must be its matching opener. Two failure modes: a
closer with an empty stack, and leftover openers at the end. Both must be checked."

**BUGGY ATTEMPT.**
```java
boolean isValid(String s) {
    Deque<Character> st = new ArrayDeque<>();
    Map<Character, Character> match = Map.of(')', '(', ']', '[', '}', '{');
    for (char c : s.toCharArray()) {
        if (match.containsKey(c)) {
            if (st.pop() != match.get(c)) return false;   // <-- pops a possibly-empty stack
        } else st.push(c);
    }
    return true;                                          // <-- and never checks leftovers
}
```

**SPOT THE BUG (two of them).** (1) `st.pop()` on an **empty** stack throws
`NoSuchElementException` — failing input `")"` (a closer first). (2) Returning `true` unconditionally
**ignores unmatched openers** — failing input `"("` returns `true` but should be `false`. **Fix:**
guard the pop with `st.isEmpty()`, and `return st.isEmpty()` at the end.

**CLEAN.**
```java
boolean isValid(String s) {                              // O(n) time, O(n) space
    Deque<Character> st = new ArrayDeque<>();
    Map<Character, Character> match = Map.of(')', '(', ']', '[', '}', '{');
    for (char c : s.toCharArray()) {
        if (match.containsKey(c)) {                       // a closer
            if (st.isEmpty() || st.pop() != match.get(c)) return false;  // guard the pop — fix 1
        } else {
            st.push(c);                                   // an opener
        }
    }
    return st.isEmpty();                                  // no leftovers — fix 2
}
```

**EDGE CASES.** `""` → true; closer-first `")"`; opener-left `"("`; interleaved-wrong `"(]"`; correct
nesting `"([{}])"`; odd length is always false (a quick early-out you can mention).

**COMPLEXITY.** O(n) time, O(n) space (worst case all openers, e.g. `"((((("`).

**DRY RUN.** `"([)]"`: push `(`, push `[`, see `)` → top `[` ≠ `(` → **false**. ✓ (Correctly rejects
crossed nesting.) `"()"`: push `(`, see `)` → pop `(` matches; end stack empty → true. ✓

**FOLLOW-UPS.** *Longest valid parentheses substring?* → stack of indices, or DP
([WS-06](06-heaps-backtracking-dp-solutions.md)). *Minimum insertions/removals to balance?* → counter
of open/needed. *Generate all valid combinations?* → backtracking ([WS-06](06-heaps-backtracking-dp-solutions.md)).

---

## P4 — Daily Temperatures `[M]`

**PROBLEM.** For each day, how many days until a **warmer** temperature (0 if none).

**RECOGNITION.** "For each element, the next strictly-greater to the right" → **monotonic decreasing
stack of indices**.

**THOUGHT.** "Keep a stack of indices whose temperatures are decreasing. When today is warmer than the
stack top, today is that day's answer — pop and record the day-gap. Store *indices*, because I need
the distance, not the value. And 'warmer' is *strictly* greater, so I pop on `>` only."

**BUGGY ATTEMPT.**
```java
int[] dailyTemperatures(int[] t) {
    int n = t.length;
    int[] res = new int[n];
    Deque<Integer> st = new ArrayDeque<>();
    for (int i = 0; i < n; i++) {
        while (!st.isEmpty() && t[i] >= t[st.peek()]) {   // <-- the bug: >= pops equal temps
            int day = st.pop();
            res[day] = i - day;
        }
        st.push(i);
    }
    return res;
}
```

**SPOT THE BUG.** `>=` treats an **equal** temperature as "warmer," recording a same-temp day as the
answer. Failing input: `[73, 73, 74]`.
- Correct: day 0's next warmer is day 2 (74) → `res[0] = 2`; day 1 → 1; day 2 → 0. Answer `[2,1,0]`.
- With `>=`: at i=1, `t[1]=73 >= t[0]=73` → pop day0, `res[0] = 1` (claims day 1 is warmer — it's
  equal!). Answer `[1,1,0]`, wrong. **Fix: `while (t[i] > t[st.peek()])`** — strict.

**CLEAN.**
```java
int[] dailyTemperatures(int[] t) {                       // O(n) time, O(n) space
    int n = t.length;
    int[] res = new int[n];                              // default 0 = "no warmer day"
    Deque<Integer> st = new ArrayDeque<>();              // indices, temps strictly decreasing
    for (int i = 0; i < n; i++) {
        while (!st.isEmpty() && t[i] > t[st.peek()]) {   // strict — equal is NOT warmer (fix)
            int day = st.pop();
            res[day] = i - day;
        }
        st.push(i);
    }
    return res;
}
```

**EDGE CASES.** Monotonically decreasing input → all 0; monotonically increasing → all 1 except last;
all-equal `[70,70,70]` → all 0 (this is exactly what the `>=` bug breaks); single day → `[0]`.

**COMPLEXITY.** O(n) — each index is pushed once and popped at most once, so 2n stack ops despite the
inner `while`. O(n) space. (Have the amortized argument ready.)

**DRY RUN.** `[73,74,75,71,69,72,76,73]` → `[1,1,4,2,1,1,0,0]`. Spot-check index 2 (75): next warmer
is 76 at index 6 → 6-2=4. ✓

**FOLLOW-UPS.** *Next greater element (circular array)?* → iterate `2n` with `i % n`. *Previous smaller?*
→ increasing stack. *Stock span?* → same monotonic-stack idea looking left.

---

## P5 — Largest Rectangle in Histogram `[H]`

**PROBLEM.** Largest rectangle area in a histogram of bar heights.

**RECOGNITION.** For each bar, the widest rectangle of its height extends until a *shorter* bar on
each side → **monotonic increasing stack** finds both boundaries in O(n).

**THOUGHT.** "Maintain a stack of indices with increasing heights. When a shorter bar arrives, the
bars taller than it are 'closed' — each popped bar's rectangle spans from just-after-the-new-stack-top
to just-before the current index. I need a trailing **sentinel of height 0** to flush everything at
the end."

**BUGGY ATTEMPT.**
```java
int largestRectangleArea(int[] h) {
    Deque<Integer> st = new ArrayDeque<>();
    int best = 0;
    for (int i = 0; i < h.length; i++) {              // <-- the bug: loop ends at n, no flush
        while (!st.isEmpty() && h[i] < h[st.peek()]) {
            int height = h[st.pop()];
            int leftBound = st.isEmpty() ? -1 : st.peek();
            best = Math.max(best, height * (i - leftBound - 1));
        }
        st.push(i);
    }
    return best;
}
```

**SPOT THE BUG.** The loop stops at `i = n`, so any bars still on the stack (a trailing
non-decreasing run that was never "closed" by a shorter bar) are **never measured**. Failing input:
`[2, 4]` — nothing ever pops (heights only increase), loop ends, `best` stays **0**; the true answer
is `4` (the `2×2` rectangle, or `4×1`). **Fix: run the index to `n` inclusive, using a virtual height
of 0 as a sentinel that flushes the stack.**

**CLEAN.**
```java
int largestRectangleArea(int[] h) {                  // O(n) time, O(n) space
    Deque<Integer> st = new ArrayDeque<>();           // indices, heights increasing
    int best = 0, n = h.length;
    for (int i = 0; i <= n; i++) {                    // i == n is the sentinel pass — the fix
        int cur = (i == n) ? 0 : h[i];                // height 0 forces every remaining bar to flush
        while (!st.isEmpty() && cur < h[st.peek()]) {
            int height = h[st.pop()];
            int leftBound = st.isEmpty() ? -1 : st.peek();
            int width = i - leftBound - 1;            // span between the two shorter boundaries
            best = Math.max(best, height * width);
        }
        st.push(i);                                   // (pushing n is harmless; loop ends)
    }
    return best;
}
```

**WHY `width = i - leftBound - 1`.** When we pop bar `p`, the current index `i` is the first shorter
bar to its **right** (right boundary, exclusive), and the new stack top is the first shorter bar to
its **left** (left boundary, exclusive). The rectangle of height `h[p]` spans the *open* interval
between them → width `i - leftBound - 1`. The most common off-by-one is dropping the `-1`.

**EDGE CASES.** Strictly increasing (needs the sentinel — the bug); strictly decreasing (pops every
step); all equal `[3,3,3]` → `9`; single bar; a zero-height bar splitting the histogram.

**COMPLEXITY.** O(n) — each index pushed and popped once. O(n) space.

**DRY RUN.** `[2,1,5,6,2,3]` → `10` (heights 5,6 over width 2 → `5×2=10`). At the bar=2 (index4), the
5 and 6 get popped: popping 6 → width `4-2-1=1` → 6; popping 5 → leftBound=1 → width `4-1-1=2` → 10. ✓

**FOLLOW-UPS.** *Maximal rectangle in a binary matrix?* → build a histogram per row (heights of
consecutive 1s) and run this on each row — O(rows × cols). A beautiful reduction; know it.

---

## P6 — Subarray Sum Equals K `[M]`

**PROBLEM.** Count contiguous subarrays summing to exactly `k` (values may be negative).

**RECOGNITION.** "Count subarrays with sum k" → **prefix sums + hash map of prefix frequencies**. A
subarray `(i, j]` sums to k iff `prefix[j] - prefix[i] = k`, i.e. an earlier prefix equals
`prefix[j] - k`.

**THOUGHT.** "Running prefix sum. For each prefix `P`, the number of subarrays ending here with sum k
= how many earlier prefixes equaled `P - k`. Seed the map with `{0:1}` to count subarrays that start
at index 0."

**BUGGY ATTEMPT.**
```java
int subarraySum(int[] a, int k) {
    Map<Integer, Integer> count = new HashMap<>();   // <-- the bug: not seeded with {0:1}
    int prefix = 0, ans = 0;
    for (int x : a) {
        prefix += x;
        ans += count.getOrDefault(prefix - k, 0);
        count.merge(prefix, 1, Integer::sum);
    }
    return ans;
}
```

**SPOT THE BUG.** Without seeding `count.put(0, 1)`, any subarray that **starts at index 0** (whose
prefix itself equals `k`) is missed, because there's no recorded "empty prefix" of 0 to match against.
Failing input: `a=[1,1,1], k=2`.
- Expected: 2 (subarrays `[0,1]` and `[1,2]`).
- Buggy: prefixes 1,2,3. At prefix=2, `prefix-k=0` not in map → misses the `[0,1]` subarray. Returns
  **1**, not 2. **Fix: `count.put(0, 1)` before the loop.**

**CLEAN.**
```java
int subarraySum(int[] a, int k) {                    // O(n) time, O(n) space
    Map<Integer, Integer> count = new HashMap<>();
    count.put(0, 1);                                  // empty prefix — the fix
    int prefix = 0, ans = 0;
    for (int x : a) {
        prefix += x;
        ans += count.getOrDefault(prefix - k, 0);     // earlier prefixes equal to prefix-k
        count.merge(prefix, 1, Integer::sum);         // record AFTER counting (no self-match)
    }
    return ans;
}
```

**Two ordering subtleties worth narrating.** (1) The `{0:1}` seed. (2) We count *before* inserting the
current prefix, so a zero-length subarray (`k=0` case) isn't falsely counted at its own position.

**EDGE CASES.** `k=0` with zeros in the array (e.g. `[0,0,0]` → 6 subarrays); all negatives;
prefix that equals `k` exactly at the start (the seed); large sums → prefix fits in `int` for typical
constraints but use `long` if values can be large.

**COMPLEXITY.** O(n) time, O(n) space. (The brute force is O(n²); the map turns the inner "how many
earlier prefixes" scan into O(1).)

**DRY RUN.** `[1,2,3], k=3`: seed{0:1}. x=1 prefix1, want -2→0, put{0:1,1:1}; x=2 prefix3, want 0→1
(ans=1), put{...,3:1}; x=3 prefix6, want 3→1 (ans=2), put. → 2 (`[1,2]` and `[3]`). ✓

**FOLLOW-UPS.** *Subarray with sum divisible by k?* → map of `prefix mod k`. *Longest subarray summing
to k?* → map of `prefix → earliest index`. *Contiguous subarray with equal 0s and 1s?* → map 0→−1
trick. These are all the same prefix+map skeleton — a whole family.

---

## Debugging Dojo

One planted bug each. Find the failing input, explain, fix.

**Dojo-1 — first unique character index (−1 if none)**
```java
int firstUniqChar(String s) {
    Map<Character, Integer> freq = new HashMap<>();
    for (char c : s.toCharArray()) freq.merge(c, 1, Integer::sum);
    for (char c : s.toCharArray())
        if (freq.get(c) == 1) return c;          // think about the return value
    return -1;
}
```

**Dojo-2 — min-stack: push/pop/top/getMin all O(1)**
```java
class MinStack {
    Deque<Integer> st = new ArrayDeque<>();
    int min = Integer.MAX_VALUE;
    void push(int x) { if (x < min) min = x; st.push(x); }
    int pop() { return st.pop(); }               // think about min after a pop
    int top() { return st.peek(); }
    int getMin() { return min; }
}
```

**Dojo-3 — evaluate Reverse Polish Notation**
```java
int evalRPN(String[] tokens) {
    Deque<Integer> st = new ArrayDeque<>();
    for (String t : tokens) {
        switch (t) {
            case "+": st.push(st.pop() + st.pop()); break;
            case "-": st.push(st.pop() - st.pop()); break;   // think about operand order
            case "*": st.push(st.pop() * st.pop()); break;
            case "/": st.push(st.pop() / st.pop()); break;   // and here
            default:  st.push(Integer.parseInt(t));
        }
    }
    return st.pop();
}
```

---

### Dojo answers

**Dojo-1.** `return c;` returns the **character**, but the function must return its **index**. Also
`freq.get(c) == 1` does autoboxed `Integer` comparison — fine for value 1 (small Integer cache) but
fragile in general; prefer `freq.get(c) == 1` only because 1 is cached, or use `.intValue()`. Primary
bug: returns char instead of index. Failing input: `"leetcode"` → first unique is 'l' at index 0 →
should return `0`; returns `108` ('l's code). **Fix: track the index — `return s.indexOf(c)` is O(n²);
better, loop with an index `for (int i...) if (freq.get(s.charAt(i)) == 1) return i;`.** (Bug-class 5
+ a Java autoboxing trap.)

**Dojo-2.** `min` is a single field; after `pop()` removes the current minimum, `min` is **stale** —
it still holds the popped value, so `getMin()` is wrong. Failing input: push 5, push 2, pop → `getMin`
returns 2 (should be 5). **Fix: keep a parallel min-stack (or store the running min alongside each
element) so popping restores the previous min.** (Bug-class 4: state not maintained on removal.)

**Dojo-3.** For non-commutative `-` and `/`, the **operand order is reversed**: the first `pop()` is
the *right* operand. Failing input: `["5","1","-"]` means `5 - 1 = 4`, but `st.pop()` gives 1 then 5 →
computes `1 - 5 = -4`. **Fix: `int b = st.pop(); int a = st.pop(); st.push(a - b);`** (and same for
`/`). (Bug-class 4: order of evaluation.)

---

## Key Takeaways

1. **Check the hash map *before* inserting** the current element, or it pairs with itself (Two Sum).
2. **Arrays can't be hash-map keys** — identity `hashCode`. Use a value-based `String`/sorted key, and
   a **delimiter** to avoid count collisions (Group Anagrams). This is the top Java-depth signal.
3. **Guard `pop()` against an empty stack, and check `isEmpty()` at the end** (Valid Parentheses).
4. **Monotonic stacks: `>` vs `>=` decides how equals are treated;** store **indices** when you need
   distances; add a **sentinel** to flush the stack (Daily Temperatures, Histogram).
5. **Prefix-sum + map: seed `{0:1}` and count before inserting** (Subarray Sum K) — the family extends
   to mod-k, longest, and equal-0/1 variants.
6. **Run the bug-class checklist aloud**: empty-collection access, order-of-operands, stale auxiliary
   state after a removal.
