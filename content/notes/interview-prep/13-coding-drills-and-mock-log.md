# Chapter 13: Coding Drills & Mock Log

> **Relearning log.** This is the chapter I'll actually *live in*. Everything before it is theory;
> this is where I log reps. The realization that reframed my prep: **a mock with a real human (or
> recording myself) exposes flaws no amount of solo solving does** — the long silences, the "wait,
> let me re-read the problem" three times, the forgetting to state complexity. My solo solutions were
> "correct"; my mock performances were not *hireable*. So this chapter holds (1) a curated rep set
> per pattern so I'm not paralyzed by the LeetCode firehose, and (2) my running mock transcripts and
> a brutally honest "what I flubbed" retro that feeds the
> [mistakes log in Ch 2](02-study-plan-and-tracker.md).

---

## 13.1 The curated rep set (quality over quantity)

I'm deliberately **not** doing 500 problems. I'm doing ~8–12 per pattern that are *representative* —
each teaches the trigger and one twist. After each, I write the **pattern + trigger** in one line.
Re-attempts follow the [spaced-repetition schedule](02-study-plan-and-tracker.md).

| Pattern (chapter) | Core reps | The twist rep |
|-------------------|-----------|---------------|
| [Two-ptr / window (5)](05-pattern-arrays-strings-two-pointers-sliding-window.md) | two-sum sorted, longest-no-repeat, max-window-ones | min-window-substring, subarrays-K-distinct |
| [Hash / stack / mono (6)](06-pattern-hashing-stacks-queues-monotonic.md) | two-sum, group-anagrams, valid-parens | subarray-sum-K, daily-temps, histogram |
| [Binary search (7)](07-pattern-binary-search-and-sorting.md) | first/last position, sqrt | Koko bananas, rotated array, split-array-largest-sum |
| [Trees / BST (8)](08-pattern-trees-bst-tries.md) | maxdepth, level-order, validate-BST | max-path-sum, serialize/deserialize, LCA |
| [Graphs (9)](09-pattern-graphs-bfs-dfs-topo-union-find.md) | num-islands, clone-graph, course-schedule | rotting-oranges, word-ladder, alien-dictionary |
| [Heap / interval / greedy (10)](10-pattern-heaps-intervals-greedy.md) | top-K-frequent, merge-intervals, meeting-rooms-II | median-stream, task-scheduler |
| [Backtracking (11)](11-pattern-recursion-backtracking.md) | subsets, permutations, combination-sum | word-search, N-Queens, palindrome-partition |
| [DP (12)](12-pattern-dynamic-programming.md) | climbing-stairs, house-robber, coin-change, LIS | edit-distance, partition-equal-subset, stock-with-cooldown, burst-balloons |

> The rule I enforce: **after every problem, write the one-line trigger** — "unsorted pair sum → hash
> map," "smallest value that passes a check → binary search on answer." The trigger is what I'm
> actually training; the solution is a byproduct.

> **Deeply-worked versions of these reps live in the [`solutions/`](solutions/00-solutions-index.md)
> companion** — each with a buggy first attempt, a spot-the-bug walkthrough, edge cases, and a
> Debugging Dojo. Drill order: (1) cover the clean solution and re-derive cold; (2) read only the buggy
> attempt and find the bug in under 60 seconds; (3) do the Dojo. That's how the *trigger* recognition
> here turns into the *correctness-under-pressure* signal that wins offers.

---

## 13.2 The drill log template

| Date | Problem | Pattern | Trigger I should've seen | Result | Time | Notes / re-attempt date |
|------|---------|---------|--------------------------|--------|------|--------------------------|
| | | | | solved cold / hint / failed | mm:ss | |

Filled example rows (the format I keep honest):

| Date | Problem | Pattern | Trigger | Result | Time | Notes |
|------|---------|---------|---------|--------|------|-------|
| W2 | Koko bananas | BS on answer | "min speed such that finishes in H hrs" = feasibility BS | hint | 24:00 | Forgot it was answer-space BS; +1d |
| W2 | Daily temperatures | monotonic stack | "next warmer day" = next-greater | cold | 12:00 | Clean; retire after +21d |
| W3 | Course schedule II | topo sort | "ordering with prerequisites" | cold | 16:00 | Kahn's; remember cycle = idx<n |
| W4 | Edit distance | 2D DP | "transform one string to another" | failed | 35:00 | Mis-stated state; rewatch [Ch 12](12-pattern-dynamic-programming.md); +1d |

---

## 13.3 Mock interview transcripts (annotated)

I record my mocks and transcribe the moments that mattered. The point isn't the solution — it's the
*behavior*. Here's a representative annotated mock so future-me remembers what good and bad look
like.

### Mock #1 — "Subarray sum equals K" (45-min coding, self-recorded)

```
[00:00] Interviewer states problem.
[00:30] ME: "Let me restate — count contiguous subarrays summing to exactly k.
         Questions: can values be negative? (yes) Empty array? (return 0)
         How big is n?" (up to 1e5)
   ✅ GOOD: clarified domain + derived target complexity (1e5 → need O(n)/O(n log n)).
[01:30] ME: "Brute force is all O(n^2) subarrays, summing each — O(n^2). Too slow for 1e5.
         The bottleneck is recomputing sums. Prefix sums + a hash map of prefix
         frequencies gets O(n)."
   ✅ GOOD: stated brute force, named the bottleneck, matched the pattern out loud.
[02:30] ME: "Plan: running prefix sum; for each, add count of earlier prefixes equal
         to (prefix - k); seed map with {0:1}. Sound good?"
   ✅ GOOD: asked for buy-in before coding.
[03:00–11:00] Coded it cleanly. Narrated the {0:1} seed.
[11:00] ME: traced [1,1,1], k=2 → returns 2. Then edge: empty → 0.
   ✅ GOOD: verification step done, found no bug but proved correctness.
[12:30] ME: "O(n) time, O(n) space — map holds up to n prefixes."
   ⚠️ FLUB: I almost forgot to state complexity; caught it at the end. → mistakes log:
            "make complexity the last sentence, always."
```

### Mock #2 — "Word ladder" (the one that exposed rust)

```
[00:00] Problem stated (shortest transformation sequence length).
[02:00] ME: went quiet for ~90 seconds trying to be clever.
   ❌ FLUB: silence. Should have narrated: "shortest path on an unweighted graph of words
            differing by one letter → BFS." Instead I sat silent and the interviewer had
            to prompt me. Root cause tag: COMMUNICATION + slow pattern recognition.
[04:00] Took the hint, recovered: built neighbors by changing each char a–z.
[18:00] Working BFS, but O(N * L * 26 * L) — slow neighbor gen.
[20:00] Interviewer: "can you speed up neighbor finding?" 
        ME: "wildcard buckets — map 'h*t' → [hot, hit]." 
   ✅ GOOD: took the optimization hint and ran with it.
```

> Mock #2 is the most valuable artifact in this whole book for me: it proved that my *failure mode
> is silence under uncertainty*, not lack of knowledge. That single insight redirected week 4 toward
> talk-out-loud reps instead of more problems. **The mock log is a diagnostic instrument, not a
> scoreboard.**

---

## 13.4 The "what I flubbed" retro (rolls up to Ch 2)

Every Sunday I tally flubs by **root cause**, because the cause dictates the cure:

| Root cause | Count this week | Cure |
|------------|-----------------|------|
| Communication (silence, no narration) | | More mocks; pre-scripted transition lines from [Ch 3](03-problem-solving-framework.md) |
| Slow pattern recognition | | Trigger drills — read problem, name pattern in 30s, don't solve |
| Careless bug (off-by-one, edge) | | Verification step discipline; trace 2 examples |
| Algorithm gap (didn't know the technique) | | Targeted study of that pattern chapter |
| Time management (ran out) | | Hard timebox in practice; Meta-style 18-min drills |

> The meta-lesson: **counting flubs by root cause tells me what to practice next.** If 70% are
> communication, doing more LeetCode is the *wrong medicine* — I need reps with my mouth moving.

---

## 13.5 Trigger-recognition drill (my secret weapon)

Once a week I do a *recognition-only* drill: read 20 problem statements and, for each, say the
pattern and trigger in under 30 seconds — **without solving**. This trains the exact muscle that
Meta's two-problem format stresses. Sample:

| Statement fragment | Pattern (say it in 30s) |
|--------------------|--------------------------|
| "longest substring with at most 2 distinct" | variable sliding window |
| "kth largest in a stream" | min-heap of size k |
| "can finish all courses given prerequisites" | topological sort |
| "min number of coins" | DP (unbounded knapsack) |
| "smallest divisor such that sum ≤ threshold" | binary search on the answer |
| "all subsets that sum to target" | backtracking |
| "next greater element" | monotonic stack |
| "are these two accounts the same person" | union-find |

## Interview Drills

- **D13.1** Do one full recognition-only drill (20 fragments, 30s each). Log how many you missed and
  their patterns.
- **D13.2** Record yourself solving one medium cold. Transcribe the silences. Tag the root cause.
- **D13.3** Re-attempt every "failed" or "hint" entry in your drill log that's past its
  spaced-repetition date, from blank.

## Key Takeaways

1. **A curated ~8–12 reps per pattern beats grinding 500 problems** — train *triggers*, not problem
   count.
2. **After every problem, log the one-line trigger.** That's the thing being trained.
3. **Mocks (or recordings) expose behavior solo solving hides** — silence, no complexity, re-reading.
   They're a diagnostic, not a scoreboard.
4. **Tally flubs by root cause** (communication / recognition / careless / algorithm / time) — the
   cause dictates the cure.
5. **Weekly recognition-only drills** build the fast pattern-matching that Meta's two-problem format
   demands.
