# Chapter 4: Complexity Mental Models

> **Relearning log.** I never *forgot* Big-O — I forgot how to **use it as a forward tool**. Rusty
> me treated complexity as something you state at the end. Sharp me uses it at the *start*: the
> constraint `n ≤ 10⁵` is the interviewer *handing me the answer's shape* before I've written a
> line. The other rust: I'd gotten sloppy about amortized vs. worst-case (saying `ArrayList.add` is
> O(1) without the word "amortized") and about *space* complexity, which interviewers probe at L5
> ("can you do it in O(1) extra space?"). This chapter is the small set of models I need fluent.

---

## 4.1 The complexity ladder

```
O(1)        constant      hash lookup, array index, math
O(log n)    logarithmic   binary search, balanced-tree op, heap push/pop
O(n)        linear        single scan, hash-based counting
O(n log n)  linearithmic  sorting, heap of n, divide-and-conquer merge
O(n²)       quadratic     nested loops, all pairs
O(2^n)      exponential   subsets, naive recursion w/ branching
O(n!)       factorial     permutations
```

Memorize the **growth at n = 10⁶**: O(n) ≈ 10⁶ ops (fine), O(n log n) ≈ 2×10⁷ (fine),
O(n²) ≈ 10¹² (dead). A CPU does roughly 10⁸–10⁹ simple ops/sec, so ~10⁸ is the rough "fits in a
second" budget.

---

## 4.2 The killer trick: target complexity *from* the constraint

This is the model I most needed to rebuild. The input size tells me the intended complexity:

| Constraint on n | Ops budget (~10⁸) | Intended complexity | Patterns it points at |
|-----------------|-------------------|---------------------|------------------------|
| n ≤ 10–12 | n! / 2ⁿ·n | O(n!), O(2ⁿ·n) | permutations, [bitmask DP](12-pattern-dynamic-programming.md) |
| n ≤ 20–25 | 2ⁿ | O(2ⁿ) | [subsets / backtracking (Ch 11)](11-pattern-recursion-backtracking.md) |
| n ≤ 100–500 | n³ | O(n³) | Floyd-Warshall, [interval DP](12-pattern-dynamic-programming.md) |
| n ≤ 5,000 | n² | O(n²) | [2D DP](12-pattern-dynamic-programming.md), nested two-pointer |
| n ≤ 10⁵–10⁶ | n log n | O(n log n), O(n) | sort, [heap (Ch 10)](10-pattern-heaps-intervals-greedy.md), [sliding window (Ch 5)](05-pattern-arrays-strings-two-pointers-sliding-window.md) |
| n ≥ 10⁷–10⁹ | log n / 1 | O(log n), O(1) | [binary search (Ch 7)](07-pattern-binary-search-and-sorting.md), math, two-pointer |

> When the interviewer says "n can be up to a million," they've just told me the answer is
> **O(n) or O(n log n)** — so two nested loops are off the table and I should be thinking hash map,
> sorting, sliding window, or heap. I say this out loud: *"n is 10⁶, so I need roughly linear; that
> rules out the O(n²) pair scan."* Pure hire signal.

---

## 4.3 Amortized analysis (the word I kept dropping)

Amortized = average per operation over a sequence, even if one operation is occasionally expensive.

- **`ArrayList.add` / dynamic array append: amortized O(1).** Most appends are O(1); the occasional
  doubling-resize is O(n), but resizes are rare enough that the *average* is O(1). Say "amortized" —
  it shows you know the resize exists.
- **HashMap get/put: amortized/average O(1)**, worst case O(n) (or O(log n) in Java 8+ once a bucket
  treeifies). At L5, mention the worst case and what causes it (bad hashCode / collisions).
- **Two-pointer / sliding window: O(n)** even though it looks nested — each pointer advances at most
  n times *total*, so it's O(n), not O(n²). I rehearse this justification because interviewers
  challenge it.

> "Amortized O(1)" vs "O(1)" is a senior-vs-junior tell. The amortized cases (resize, rehash) are
> exactly where systems break at scale, which is why the word earns the signal.

---

## 4.4 Recursion → complexity (recurrences without the algebra)

I don't need the full Master Theorem in the room, just three reflexes:

| Recurrence | Shape | Complexity | Example |
|------------|-------|------------|---------|
| T(n) = 2T(n/2) + O(n) | divide in half, linear merge | **O(n log n)** | merge sort |
| T(n) = 2T(n/2) + O(1) | divide in half, constant work | **O(n)** | tree size |
| T(n) = T(n/2) + O(1) | discard half each step | **O(log n)** | binary search |
| T(n) = T(n−1) + O(1) | peel one, constant work | **O(n)** | linear recursion |
| T(n) = 2T(n−1) + O(1) | branch into two each step | **O(2ⁿ)** | naive fib |

> The "branch into two each level, n levels deep" → **O(2ⁿ)** reflex is what tells me a naive
> recursion needs **memoization** to collapse to polynomial. That recognition is the gateway to all
> of [DP (Ch 12)](12-pattern-dynamic-programming.md).

For recursion **space**, remember the **call stack**: depth-d recursion is O(d) space even if it
returns nothing — e.g., DFS on a skewed tree is O(n) stack space. Interviewers love this at L5.

---

## 4.5 Space complexity (the half I neglected)

Always state space, separately from time. Count:
- **Output** usually doesn't count toward "extra" space (clarify if unsure).
- **Auxiliary structures** (hash maps, the recursion stack, DP tables) do.
- **In-place** means O(1) extra — a frequent L5 follow-up: "can you avoid the extra array?"
  (e.g., reverse with two pointers, mark-visited by sign-flipping, rolling DP array).

Common space reductions to keep ready:
- 2D DP → **two rows or one row** (rolling array) when each cell depends only on the previous row.
- Recursion → iteration with an explicit stack to bound/avoid stack overflow.
- Hash set of "seen" → in-place marking when values index into the array (the "negation" trick).

---

## 4.6 Practical constants (don't over-index, but know them)

Big-O hides constants, but in the room I acknowledge them when they matter:
- Hash maps have real overhead; for tiny fixed-size keys an array/bitset can crush a HashMap.
- O(n log n) sort then two-pointer can *beat* an O(n) hash solution in practice for small n / cache
  reasons — I mention this as a tradeoff, never as the headline.
- `O(n)` with two passes is still `O(n)` — don't contort code to "one pass" if it hurts clarity;
  say "two passes, still linear."

---

## Interview Drills

- **D4.1 [E]** For n ≤ 22, what complexity is the interviewer signaling, and which two chapters?
- **D4.2 [E]** Why is sliding window O(n) and not O(n²) despite the inner `while`? *(Each pointer
  moves ≤ n times total → 2n pointer moves → O(n).)*
- **D4.3 [M]** A naive recursive solution is O(2ⁿ). What's the single transformation that usually
  makes it polynomial, and what does it cost in space? *(Memoization; O(states) space.)*
- **D4.4 [M]** You have an O(n) time / O(n) space solution. The interviewer asks for O(1) extra
  space. Name two general techniques you'd reach for. *(In-place marking / two pointers; rolling
  array for DP.)*
- **D4.5 [H]** When might an O(n log n) solution be preferable to an O(n) one in practice? *(Smaller
  constants / better cache locality / no hashing overhead; simpler, fewer bugs.)*

## Key Takeaways

1. **Use complexity forward, not backward:** the constraint on n hands you the target complexity
   before you code.
2. **Memorize the constraint→complexity table** and say the deduction out loud.
3. **Say "amortized"** for dynamic arrays and hash maps; know the worst cases — they're where scale
   breaks.
4. **Three recurrence reflexes** (halve+linear → n log n; branch-two → 2ⁿ; halve+const → log n)
   cover most interview recursion.
5. **Always state space separately;** keep in-place / rolling-array reductions ready for the L5
   "can you do better on space?" follow-up.
