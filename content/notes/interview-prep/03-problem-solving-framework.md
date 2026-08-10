# Chapter 3: The Problem-Solving Framework

> **Relearning log.** The biggest regression in my rusty state wasn't algorithms — it was
> *choreography*. Given a problem, I'd silently stare, have an insight, and start typing. In a real
> loop that reads as "candidate went quiet, then produced code I couldn't follow." I had to
> re-learn that the interview is a **performance with a fixed script**, and the script is what gets
> scored. The other thing I'd forgotten: **the brute force is not a waste of time — it's a scored
> move.** Stating the obvious O(n²) and then saying "now let me beat that" demonstrates exactly the
> problem-solving axis the rubric is looking for. I used to skip it to "save time" and silently lose
> the signal.

This is the 45-minute script I run on every coding problem. It's the same regardless of company; it
just runs faster at Meta (two problems) than at Google.

---

## 3.1 The script: C-C-C-C-C

```
CLARIFY → CHART (examples) → CRACK (brute → optimal) → CODE → CONFIRM (test) → COMPLEXITY
   ~3min        ~2min              ~8min               ~15min     ~5min          ~1min
```

I narrate every phase out loud. Silence is the enemy; the interviewer is filling in a feedback form
in real time and needs words to quote.

### Phase 1 — CLARIFY (≈3 min)

Restate the problem in my own words, then ask the questions that actually change the solution:

- **Input domain & size.** "Can the array be empty? Negative numbers? How large is n — 10³ or 10⁹?"
  (Size dictates target complexity — see [Ch 4](04-complexity-mental-models.md).)
- **Output shape.** "Return the indices or the values? If multiple answers, any one or all?"
- **Edge cases up front.** "Duplicates allowed? Is the input sorted? Unicode or ASCII?"
- **Constraints that unlock tricks.** "Are values bounded? Can I mutate the input? Is it streamed?"

> Asking "how big is n?" is not a stalling tactic — it's how a senior engineer *derives the target
> complexity before writing anything*. It's a hire signal. (n ≤ 20 → exponential is fine; n ≤ 10³ →
> O(n²) ok; n ≤ 10⁵–10⁶ → need O(n log n) or O(n); n ≥ 10⁹ → O(log n) or O(1).)

### Phase 2 — CHART an example (≈2 min)

Write a concrete small example with the expected output. This:
- confirms I understood the problem (cheap insurance against solving the wrong thing),
- becomes my test case at the CONFIRM step,
- often reveals the pattern ("oh, the answer only depends on the previous element → DP/sliding").

Pick an example with a *twist* (a duplicate, a negative, an empty region), not the trivial one.

### Phase 3 — CRACK it (≈8 min): brute force, then optimize

1. **State the brute force explicitly**, with its complexity. "Naively I check every pair — O(n²).
   Let me see if I can do better." This is a scored move; never skip it.
2. **Find the bottleneck.** What is the O(n²) actually doing? Usually it's *recomputing* something
   (→ memoize / prefix sums) or *re-scanning* something (→ hash map / two pointers / sorting).
3. **Match to a pattern.** Run the recognition checklist from the pattern chapters
   ([Ch 5–12](05-pattern-arrays-strings-two-pointers-sliding-window.md)). "Looking for a pair that
   sums to a target in an unsorted array → hash map for O(n)."
4. **Get a yes before coding.** "My plan is a single pass with a hash map of value→index. Sound
   good?" This invites course-correction *before* I've sunk 15 minutes into code.

### Phase 4 — CODE (≈15 min)

- Announce structure first: "I'll write a helper for X, then the main loop."
- Write **clean, compilable** code. Real names (`leftBound`, not `l2`). It's read as an artifact,
  especially at Google.
- Narrate as I go, but don't dictate every keystroke — narrate *decisions*: "I'll use a `Deque` as a
  stack here so I can also peek."
- Handle the edge cases I named in Phase 1 *in the code*, and point at them: "empty input returns
  early here."

### Phase 5 — CONFIRM (≈5 min)

- **Trace my Phase-2 example through the finished code, line by line, out loud.** Track variable
  values. This is the single highest-ROI, most-skipped step.
- Then trace an **edge case** (empty, single element, all-duplicates).
- If I find a bug, *narrate the fix* — finding your own bug is a strong positive signal, not a
  negative one.

### Phase 6 — COMPLEXITY (≈1 min)

State time and space, and *why*. "O(n) time — single pass; O(n) space — the hash map can hold all n
keys." If asked, discuss how to reduce space or what changes at scale (the L5 follow-up).

---

## 3.2 The recovery-when-stuck playbook

I *will* get stuck. The difference between a hire and a no-hire is often how I behave when stuck.
Ranked moves:

1. **Go back to the example.** Re-trace it by hand; the mechanism I need is usually visible there.
2. **Solve a simpler version.** "What if the array were sorted?" / "What if k = 1?" Then generalize.
3. **Name the bottleneck out loud.** "My O(n²) is recomputing the max of each window. I want that in
   O(1)..." — naming it often surfaces the structure (here: monotonic deque).
4. **Reach for the pattern toolbox.** Mentally walk: hash map? two pointers? sorting? heap? stack?
   BFS/DFS? binary search on the answer? DP? One usually fits.
5. **Take the hint gracefully.** If the interviewer nudges, *take it, integrate it, and keep
   driving.* Resisting a hint is the real red flag, not needing one.

> Being stuck is not the failure. **Being stuck *and silent*** is the failure. Narrate the stuckness:
> "I know two-pointer needs sorted input and mine isn't, so either I sort — O(n log n) — or I find an
> O(n) hash approach. Let me try the hash approach." That sentence *is* the signal.

---

## 3.3 Communication scripts I keep ready

- Opening: *"Let me make sure I understand… [restate]. A few questions: [size, edges, output]."*
- Transition to solving: *"Naive approach is [X], which is O(…). The bottleneck is [Y]. I think I
  can use [pattern] to get [target]."*
- Asking for buy-in: *"My plan: [3 bullets]. Does that sound reasonable before I code?"*
- While coding: *"I'm handling the empty case here… using a deque so I can peek both ends…"*
- Closing: *"Let me trace [example]… [values]… returns [X], correct. Edge case [empty] → handled.
  Complexity is [T/S] because […]."*

---

## 3.4 Time management by company

| Company | Format | Implication for the script |
|---------|--------|----------------------------|
| Google | 1 problem / 45 min | Full script; invest in clean code & verification |
| Meta | 2 problems / ~35–40 min | Compress CLARIFY/CHART; recognize pattern *fast*; ~18 min each |
| Microsoft | 1–2 problems / 45–60 min | Full script; may include debugging — read existing code carefully |

> Meta's two-problem format punishes slow pattern recognition more than anything else. That's why
> [Ch 5–12](05-pattern-arrays-strings-two-pointers-sliding-window.md) drill *triggers*, not just
> solutions.

---

## Interview Drills

- **D3.1 [E]** List the six phases of the script and the one sentence you say at each transition.
- **D3.2 [M]** The interviewer gives `n ≤ 20`. What does that immediately tell you about acceptable
  complexity, and which pattern chapter does it point at? *(Exponential is fine →
  [backtracking/bitmask (Ch 11)](11-pattern-recursion-backtracking.md) or
  [DP over subsets (Ch 12)](12-pattern-dynamic-programming.md).)*
- **D3.3 [M]** You're 20 minutes in and your approach is wrong. Walk through your recovery, out loud,
  in five sentences.
- **D3.4 [H]** Why is stating the brute force a *scored* move rather than wasted time?

## Key Takeaways

1. **The interview is a scripted performance.** Run CLARIFY → CHART → CRACK → CODE → CONFIRM →
   COMPLEXITY and narrate every phase.
2. **Derive the target complexity from n before coding.** "How big is n?" is a senior move.
3. **State the brute force and the bottleneck explicitly** — they're the problem-solving signal.
4. **Always trace a concrete example through the finished code out loud** — cheapest, most-skipped
   point.
5. **Stuck-and-silent loses; stuck-and-narrating wins.** Take hints gracefully and keep driving.
