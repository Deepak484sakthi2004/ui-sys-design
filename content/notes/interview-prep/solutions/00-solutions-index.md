# Worked Solutions — The Debugging Dojo

> **Why this companion exists.** The [main book](../00-index.md) trains *recognition* — seeing that a
> problem is a monotonic-stack problem in 90 seconds. This companion trains the thing that actually
> makes an interviewer lean forward: **the ability to write code, find my own bug before they do,
> reason about exactly why it's correct, and predict every edge case that would break a weaker
> solution.** Interviewers at Google don't just score "did it work" — they score *how you think
> about correctness*. A candidate who says "wait, this breaks when the array has a single element
> because my `right - 1` underflows — let me guard that" is demonstrating the single highest-value
> signal there is: **you catch bugs the way a senior engineer catches them in code review.**

Every solution here is deliberately worked in a format that surfaces that signal.

---

## The format (every problem)

```
PROBLEM        the ask in one line
RECOGNITION    the 30-second tell — what trigger fires, and why
THOUGHT        the narration I'd actually say in the room (brute → bottleneck → plan)
BUGGY ATTEMPT  a plausible first version with a SUBTLE, realistic bug
SPOT THE BUG   the exact failing input, why it fails, and the one-line fix
CLEAN          the correct, commented solution
EDGE CASES     the inputs that break naive solutions (table)
COMPLEXITY     time & space, with the WHY (not just the letter)
DRY RUN        a concrete trace proving correctness out loud
FOLLOW-UPS     what the interviewer asks next, and how I'd extend
```

> The **BUGGY ATTEMPT → SPOT THE BUG** section is the whole point. These are not strawmen — they are
> the *exact* mistakes I (and most strong candidates) actually make under pressure: off-by-one window
> lengths, `mid` overflow, shallow-copying a backtracking path, marking visited at the wrong moment,
> integer overflow in a comparator. Training myself to *find* them cold is what lets me catch them
> live and narrate the catch — the move that makes the interviewer trust my correctness.

---

## How to drill this companion

1. **Cover the CLEAN solution.** Read PROBLEM + RECOGNITION, then write your own solution from blank.
2. **Read only the BUGGY ATTEMPT and try to SPOT THE BUG yourself** before reading the answer. Time
   it — aim for under 60 seconds. This is the exact skill of self-review.
3. **Run the DRY RUN in your head**, tracking every variable. If your mental trace disagrees with the
   stated output, *you* found a bug — in your understanding or in the trace.
4. **Answer the FOLLOW-UPS out loud.** The follow-up is where L5 is won.
5. **Do the Debugging Dojo** at the end of each file: planted bugs, no hints — find and fix.

> The mantra from [Ch 3](../03-problem-solving-framework.md): *I never write a solution I can't
> explain out loud.* This companion is where I prove I can explain not just why it's right, but why
> every nearby version is **wrong**.

---

## The map

| File | Pattern | Home chapter |
|------|---------|--------------|
| [01](01-arrays-windows-solutions.md) | Arrays, two pointers, sliding window | [Ch 5](../05-pattern-arrays-strings-two-pointers-sliding-window.md) |
| [02](02-hashing-stacks-solutions.md) | Hashing, stacks, monotonic | [Ch 6](../06-pattern-hashing-stacks-queues-monotonic.md) |
| [03](03-binary-search-solutions.md) | Binary search (incl. on the answer) | [Ch 7](../07-pattern-binary-search-and-sorting.md) |
| [04](04-trees-solutions.md) | Trees, BST, tries | [Ch 8](../08-pattern-trees-bst-tries.md) |
| [05](05-graphs-solutions.md) | Graphs: BFS/DFS/topo/union-find | [Ch 9](../09-pattern-graphs-bfs-dfs-topo-union-find.md) |
| [06](06-heaps-backtracking-dp-solutions.md) | Heaps/greedy, backtracking, DP | [Ch 10](../10-pattern-heaps-intervals-greedy.md)–[12](../12-pattern-dynamic-programming.md) |

---

## The seven bug-classes I'm training myself to catch on sight

These recur across every pattern. When I review my own code live, I run this checklist — out loud,
because narrating the check *is* the signal:

1. **Off-by-one / boundary** — `<` vs `<=`, `right - left + 1`, `n - 1` vs `n`, empty/single-element.
2. **Integer overflow** — `(lo + hi) / 2`, `a - b` comparators, summing into `int`, `Integer.MAX_VALUE + 1`.
3. **Aliasing / shallow copy** — storing a mutated reference (backtracking paths, 2D arrays).
4. **State updated at the wrong time** — marking visited at dequeue vs discovery, updating `prev`
   before vs after using it.
5. **Uninitialized / wrong base case** — empty input, `dp[0]`, null root, single node.
6. **Wrong invariant direction** — heap polarity (min vs max for top-K), knapsack loop direction,
   monotonic stack `<` vs `<=`.
7. **Mutation during iteration / concurrency** — modifying a collection while looping, shared state.

> When I finish coding in an interview, I don't say "I think it works." I say: *"Let me check my
> usual suspects — boundaries… overflow… the empty case… visited-marking timing."* Then I trace one
> example. Running this checklist aloud is what converts "wrote correct code" into "thinks about
> correctness like a senior engineer."
