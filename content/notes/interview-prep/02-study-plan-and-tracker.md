# Chapter 2: Study Plan & Tracker

> **Relearning log.** My first instinct was to "grind LeetCode" — open the problem list and start
> at #1. That's how I wasted a week last time. The thing I'd forgotten: **interview prep is recall
> training, not knowledge acquisition.** I already *know* DFS. What's broken is the speed of
> recognizing "this is a DFS problem" and the muscle of writing it bug-free in one pass. So the plan
> below is built around **patterns, not problems**, and around **spaced retrieval, not re-reading**.
> The second thing I'd forgotten: behavioral and design compound slowly, so they have to start in
> week 1, not week 7. A story bank you build over six weeks is far better than one you cram.

This chapter is the operating system for the rest of the book: an 8-week plan, a spaced-repetition
schedule, and the two running logs I keep (the *mistakes log* and the *self-assessment tracker*).

---

## 2.1 Principles I'm holding myself to

1. **Patterns over problems.** Learn the ~15 patterns ([Ch 5–12](05-pattern-arrays-strings-two-pointers-sliding-window.md));
   each problem is just a labeled rep of a pattern. After solving, I write down *which pattern* and
   *the trigger* that should have told me.
2. **Active recall beats re-reading.** Re-solving a problem from blank > reading my old solution.
3. **Spaced repetition.** A solved problem gets re-attempted at day +1, +3, +7, +21. If I can't
   reproduce it from scratch, it goes back to day +1.
4. **Timeboxes are real.** 25 min thinking on a new problem, then look at the *idea* (not the code),
   then implement. In mock mode, hard 35–40 min cap.
5. **Talk out loud, always.** Even alone. The room scores communication; silent solving doesn't
   train it.
6. **Behavioral + design start week 1.** Low daily dose, high compounding.
7. **Mocks are the real practice.** 2 mocks/week from week 3. Nothing else simulates the pressure.

> The cheapest 10% improvement available to me: **stop re-reading solutions and start re-deriving
> them cold.** Recognition feels like mastery and isn't.

---

## 2.2 The 8-week plan

Assumes ~2–3 focused hours/weekday + a longer weekend block. Compress to 4–5 weeks by doubling daily
load if the timeline is tight (see the Cram path in [00-index](00-index.md)).

| Week | Coding (primary) | Design / LLD | Behavioral | Mocks |
|------|------------------|--------------|------------|-------|
| **1** | [Framework (Ch 3)](03-problem-solving-framework.md) + [Complexity (Ch 4)](04-complexity-mental-models.md); Arrays/Two-pointer/Sliding window ([Ch 5](05-pattern-arrays-strings-two-pointers-sliding-window.md)) | Read [Design framework (Ch 14)](14-system-design-framework.md) | Draft 6 raw stories ([Ch 19](19-behavioral-star-and-story-bank.md)) | — |
| **2** | Hashing/Stack/Monotonic ([Ch 6](06-pattern-hashing-stacks-queues-monotonic.md)); Binary search ([Ch 7](07-pattern-binary-search-and-sorting.md)) | [Building blocks (Ch 15)](15-building-blocks-and-back-of-envelope.md) | STAR-ify 4 stories | — |
| **3** | Trees & tries ([Ch 8](08-pattern-trees-bst-tries.md)); Graphs ([Ch 9](09-pattern-graphs-bfs-dfs-topo-union-find.md)) | [Worked design #1–2 (Ch 16)](16-system-design-worked-problems.md) | Map stories → signals ([Ch 20](20-company-signals-and-leadership-principles.md)) | 1 coding |
| **4** | Heaps/Intervals/Greedy ([Ch 10](10-pattern-heaps-intervals-greedy.md)); Backtracking ([Ch 11](11-pattern-recursion-backtracking.md)) | Worked design #3–4 | Polish to crisp 3-min versions | 1 coding + 1 design |
| **5** | DP ([Ch 12](12-pattern-dynamic-programming.md)) — the big one, give it the week | [OOD/SOLID (Ch 17)](17-ood-solid-and-patterns.md) | Conflict + failure stories deep | 1 coding + 1 behavioral |
| **6** | Mixed review; weak patterns from tracker | [LLD problems (Ch 18)](18-lld-worked-problems.md) | Company-specific framing | 2 (1 coding, 1 design) |
| **7** | Spaced re-attempts of all flubbed problems ([Ch 13](13-coding-drills-and-mock-log.md)) | 2 more worked designs, timed | Mock behavioral, get feedback | 2 mixed |
| **8** | Light — keep warm, no new material | Re-read [cheatsheets (App A)](A-cheatsheets.md) | Rehearse top 8 stories aloud | 1 full loop simulation |

> **Week 5 (DP) is where most people quietly fall behind.** I'm pre-committing the whole week to it
> and accepting slower progress elsewhere. DP is the highest-variance topic in the coding round.

---

## 2.3 Spaced-repetition schedule

Every problem I solve gets logged with a *next-attempt date*. The intervals:

```
Solve (cold or with hint)
   │
   ├─ reproduce from blank at +1 day  ── fail → reset to +1
   │                                  └─ pass → +3 days
   ├─ +3 days   ── fail → +1   └─ pass → +7
   ├─ +7 days   ── fail → +1   └─ pass → +21
   └─ +21 days  → "retired" (I own this pattern instance)
```

I don't re-type the whole solution every time after the first pass — I re-derive the *key idea and
the tricky line* (the part that's actually hard to recall), and only fully re-implement if I can't.

---

## 2.4 The mistakes log (my most valuable file)

A running table. Every bug, every "I should have seen that," every mock flub goes here. I review it
every Sunday and it directly drives the next week's focus. Template:

| Date | Problem / round | What went wrong | Root cause (pattern? careless? communication?) | Fix / drill |
|------|-----------------|-----------------|------------------------------------------------|-------------|
| | | | | |

Seed entries from past experience (so I start honest):

| Date | Problem / round | What went wrong | Root cause | Fix |
|------|-----------------|-----------------|-----------|-----|
| W1 | (self-review) | Jump to code before stating brute force | Communication | Force the "brute force out loud" step from [Ch 3](03-problem-solving-framework.md) |
| W1 | (self-review) | Off-by-one in binary search mid/hi | Pattern fluency | Memorize one [BS template (Ch 7)](07-pattern-binary-search-and-sorting.md) and never deviate |
| W1 | (self-review) | Forget to state complexity at the end | Verification axis | Make it the last sentence, always |

> Root-cause tagging is the trick. If 60% of my flubs are *communication* not *algorithm*, then more
> LeetCode is the wrong medicine — I need more *talking-out-loud* reps. The log tells me which.

---

## 2.5 Self-assessment tracker

Rated 1–5 (1 = forgotten, 5 = interview-ready). Re-score weekly; it's the dashboard.

| Area | Wk1 | Wk4 | Wk8 | Target |
|------|-----|-----|-----|--------|
| Arrays / two-pointer / sliding window | | | | 5 |
| Hashing / stack / monotonic | | | | 5 |
| Binary search / sorting | | | | 5 |
| Trees / BST / tries | | | | 4 |
| Graphs (BFS/DFS/topo/union-find) | | | | 5 |
| Heaps / intervals / greedy | | | | 4 |
| Backtracking | | | | 4 |
| Dynamic programming | | | | 4 |
| System design framework + driving | | | | 5 |
| Building blocks + estimation | | | | 4 |
| LLD / OOD | | | | 4 |
| Behavioral story bank (count + polish) | | | | 5 |
| Company signals knowledge | | | | 4 |

> A "4" target on DP and backtracking is deliberate — chasing a "5" on the hardest topics has
> diminishing returns versus shoring up a "3" elsewhere. **Cover the breadth to a 4 before you
> chase a 5 anywhere.** A loop fails on your weakest round, not your strongest.

---

## 2.6 Daily template

```
[ ] Warm-up: re-derive 1 due spaced-repetition problem (15 min)
[ ] New pattern reps: 2–3 problems, talk out loud, timeboxed (75–90 min)
[ ] Log: pattern + trigger for each; any flub → mistakes log
[ ] Behavioral micro-dose: refine 1 story OR read 1 signal (15 min)
[ ] (M/W/F) Design or LLD: 1 building block or 1 partial design (30 min)
[ ] Sunday: review mistakes log, re-score tracker, plan the week
```

---

## Interview Drills

- **D2.1 [E]** Why "patterns over problems"? *(Recall speed is the bottleneck, not knowledge;
  patterns are the unit of recognition.)*
- **D2.2 [M]** Your mistakes log shows 7 of 10 recent flubs tagged "communication," not "algorithm."
  What changes in next week's plan? *(Shift reps from new problems to talk-out-loud mocks; record
  yourself; practice the [Ch 3](03-problem-solving-framework.md) narration explicitly.)*
- **D2.3 [M]** Why do behavioral and design start in week 1 even though coding dominates? *(They
  compound slowly — a 6-week story bank and design vocabulary can't be crammed.)*

## Key Takeaways

1. **Prep is recall training, not learning.** Optimize for re-derivation speed and one-pass
   bug-free implementation.
2. **Patterns over problems; active recall over re-reading; spaced repetition with reset-on-fail.**
3. **The mistakes log with root-cause tags is the steering wheel** — it tells you whether to drill
   algorithms or communication.
4. **Breadth to a 4 before depth to a 5;** loops fail on the weakest round.
5. **Behavioral and design start week 1** because they compound. **Mocks from week 3** because
   nothing else simulates the pressure.
