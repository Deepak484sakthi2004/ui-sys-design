# Interview Prep Journal — From Scratch to L4/L5

> **Why this book exists.** I have fifteen-plus years of building real systems, but the
> *interview* is its own sport. The muscles it uses — recalling that this is a monotonic-stack
> problem in 90 seconds, drawing a clean system-design box diagram while narrating tradeoffs,
> telling a three-minute STAR story that lands a leadership signal — atrophy the moment you stop
> practicing them. This is the notebook I'm keeping while I rebuild those muscles from zero, aimed
> at **Google L4/L5, Meta E4/E5, Microsoft 60–63** (90+ LPA, India). It is deliberately
> self-contained: I re-derive the fundamentals here rather than send myself to a reference, because
> the act of re-deriving is the studying.

This is a **journal that became a textbook**. Each chapter opens with a candid *Relearning log* —
what I'd actually forgotten, what tripped me up, the mental model that finally stuck — and then
hardens into structured notes I can revise from the night before an onsite. Code is **Java-first**
(my daily language), pseudocode where it reads cleaner. Every chapter ends with **Interview Drills**
pitched at the senior bar and **Key Takeaways**.

---

## How the loop breaks down (and where each part maps)

A modern L4/L5 onsite at these companies is **four signals**, scored independently:

1. **Coding** (2 rounds usually) — DSA pattern recall + clean implementation under 35–40 min.
2. **System design** (1 round; L5+ weighted heavily) — drive an ambiguous design end-to-end.
3. **LLD / object design** (Meta/MSFT sometimes; some L5 loops) — model a system in classes.
4. **Behavioral / leadership** (1–2 rounds) — scope, impact, collaboration, the company's values.

This book has a part for each, plus a strategy spine and a synthesis section.

---

## Table of Contents

### Part 0 — Orientation & Strategy
| # | Chapter | What it gives me |
|---|---------|------------------|
| 00 | **Index** (this file) | Map, reading paths, conventions |
| 01 | [Levels, Loops & Rubrics](01-levels-loops-and-rubrics.md) | What L4 vs L5 means, the loop per company, what each round *scores* |
| 02 | [Study Plan & Tracker](02-study-plan-and-tracker.md) | 8-week plan, spaced-repetition table, the mistakes log |

### Part 1 — Coding / DSA
| # | Chapter | Core patterns |
|---|---------|---------------|
| 03 | [Problem-Solving Framework](03-problem-solving-framework.md) | The 45-min choreography, communication, recovery-when-stuck |
| 04 | [Complexity Mental Models](04-complexity-mental-models.md) | Big-O, amortization, "target complexity from constraints" |
| 05 | [Arrays, Two Pointers & Sliding Window](05-pattern-arrays-strings-two-pointers-sliding-window.md) | Two-pointer, fast/slow, fixed/variable windows |
| 06 | [Hashing, Stacks, Queues & Monotonic](06-pattern-hashing-stacks-queues-monotonic.md) | Hash maps, monotonic stack/deque, prefix sums |
| 07 | [Binary Search & Sorting](07-pattern-binary-search-and-sorting.md) | Search on answer, custom sorts, partition |
| 08 | [Trees, BST & Tries](08-pattern-trees-bst-tries.md) | Traversals, recursion-on-trees, LCA, tries |
| 09 | [Graphs: BFS, DFS, Topo, Union-Find](09-pattern-graphs-bfs-dfs-topo-union-find.md) | Grids, components, cycles, shortest path |
| 10 | [Heaps, Intervals & Greedy](10-pattern-heaps-intervals-greedy.md) | Top-K, merge intervals, exchange argument |
| 11 | [Recursion & Backtracking](11-pattern-recursion-backtracking.md) | Subsets, permutations, pruning |
| 12 | [Dynamic Programming](12-pattern-dynamic-programming.md) | 1D/2D, knapsack, intervals, state machines |
| 13 | [Coding Drills & Mock Log](13-coding-drills-and-mock-log.md) | Rep set per pattern + my mock transcripts and flubs |

> **Worked Solutions companion → [`solutions/`](solutions/00-solutions-index.md).** The chapters above
> teach *recognition*; the companion teaches the offer-winning skill on top of it — writing code,
> finding my own bug before the interviewer does, and reasoning about exactly why every nearby version
> is wrong. Each problem is worked as *recognition → buggy first attempt → spot-the-bug → clean
> solution → edge cases → complexity → dry run → follow-ups*, with a **Debugging Dojo** of planted bugs
> per file. This is the **debugging/understanding showcase** — the part that makes an interviewer trust
> my correctness.

### Part 2 — System Design
| # | Chapter | Focus |
|---|---------|-------|
| 14 | [System Design Framework](14-system-design-framework.md) | The 7-step drive, L4 vs L5 bar, tradeoff vocabulary |
| 15 | [Building Blocks & Back-of-Envelope](15-building-blocks-and-back-of-envelope.md) | LB, cache, queue, DB, sharding, CAP; estimation math |
| 16 | [Worked Problems](16-system-design-worked-problems.md) | URL shortener, rate limiter, feed, chat, geo, top-K |

### Part 3 — LLD / OOD
| # | Chapter | Focus |
|---|---------|-------|
| 17 | [OOD, SOLID & Patterns](17-ood-solid-and-patterns.md) | The OOD process, SOLID, the 6 patterns that show up |
| 18 | [LLD Worked Problems](18-lld-worked-problems.md) | Parking lot, elevator, rate limiter, KV, Splitwise |

### Part 4 — Behavioral & Leadership
| # | Chapter | Focus |
|---|---------|-------|
| 19 | [Behavioral: STAR & Story Bank](19-behavioral-star-and-story-bank.md) | STAR/CARL, a 12-story bank, scoping to L5 |
| 20 | [Company Signals & Leadership Principles](20-company-signals-and-leadership-principles.md) | Googleyness/GCA, Meta signals, MSFT model-coach-care |
| 21 | [Negotiation & Offer](21-negotiation-and-offer.md) | Leveling, comp components, India market |

### Part 5 — Synthesis
| # | Chapter | Focus |
|---|---------|-------|
| 22 | [Final Week & Mock Retro](22-final-week-and-mock-retro.md) | Day-before checklist, retros, logistics |
| A | [Cheatsheets](A-cheatsheets.md) | One page per domain for the night before |

---

## Reading paths

**Cram (≤ 2 weeks, already strong):** 01 → 03 → 04 → skim 05–12 Key Takeaways → 14 → 15 → 19 → 20 → A.

**Full rebuild (6–8 weeks, the path I'm on):** read in order, do the drills in 13, do 2 mocks/week.

**By round (targeted, when I know the company's loop):**
- Coding-heavy (Google): 03, 04, all of 05–13.
- Design-heavy (L5 anywhere): 14, 15, 16, then 17, 18.
- Behavioral-anxious: 19, 20, 21 first, build the story bank early — it compounds.

---

## Conventions used in this book

- **Relearning log** (`>` blockquote at the top of each chapter): first-person, what I had to
  recover and what trips most people up. Everything after it is polished revision material.
- **Code** is Java unless a language tag says otherwise. It's meant to compile; where I show a
  fragment I mark it `// fragment`.
- **Complexity** is stated as `Time / Space` after every algorithm.
- **`>` callouts** mid-chapter flag the one sentence worth memorizing.
- **Tables** for tradeoffs; **ASCII diagrams** for flows and architectures. No emoji.
- **Cross-links** are relative (`[14](14-system-design-framework.md)`).
- **Drill notation:** `D{chapter}.{n}` with `[E]/[M]/[H]` difficulty.

> The single most important convention: **I never write a solution I can't explain out loud.** If a
> line of code needs a comment to justify *why*, the comment goes in — because in the room, the
> "why" is what's actually being scored.
