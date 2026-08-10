# Appendix A: Cheatsheets (for the night before)

> **Relearning log.** This is the only thing I read in the last 48 hours. Everything in the book
> distilled to what fits on a glance — the tables and one-liners that jog the full memory. If I can
> read these and the full chapter snaps back, I'm ready. Each section links to its home chapter.

---

## A.1 Coding — the problem-solving script ([Ch 3](03-problem-solving-framework.md))

```
CLARIFY (size? edges? output?) → CHART example → CRACK (brute → bottleneck → pattern → buy-in)
→ CODE (clean, narrate decisions) → CONFIRM (trace example + edge) → COMPLEXITY (T/S + why)
```
Stuck? → re-trace example · solve simpler version · name the bottleneck · walk the toolbox · take the hint.

---

## A.2 Complexity from constraints ([Ch 4](04-complexity-mental-models.md))

| n ≤ | Target | Patterns |
|-----|--------|----------|
| 10–12 | O(n!) | permutations |
| 20–25 | O(2ⁿ) | subsets / backtracking / bitmask DP |
| 100–500 | O(n³) | Floyd-Warshall, interval DP |
| 5,000 | O(n²) | 2D DP, nested two-pointer |
| 10⁵–10⁶ | O(n log n) / O(n) | sort, heap, sliding window, hash |
| ≥10⁷ | O(log n) / O(1) | binary search, math |

Recurrences: `2T(n/2)+O(n)`→n log n · `T(n/2)+O(1)`→log n · `2T(n−1)`→2ⁿ. Say "**amortized**" for
dynamic arrays / hash maps. State **space** separately (recursion stack = O(depth)).

---

## A.3 Pattern → trigger map ([Ch 5–12](05-pattern-arrays-strings-two-pointers-sliding-window.md))

| Trigger | Pattern | Chapter |
|---------|---------|---------|
| contiguous subarray/substring + property | sliding window | [5](05-pattern-arrays-strings-two-pointers-sliding-window.md) |
| sorted array, find pair | two pointers (ends) | [5](05-pattern-arrays-strings-two-pointers-sliding-window.md) |
| cycle / middle / find duplicate | fast & slow pointers | [5](05-pattern-arrays-strings-two-pointers-sliding-window.md) |
| "have I seen X / count of X" | hash map/set | [6](06-pattern-hashing-stacks-queues-monotonic.md) |
| subarray sum = K | prefix sum + hash map | [6](06-pattern-hashing-stacks-queues-monotonic.md) |
| nearest greater/smaller, histogram | monotonic stack | [6](06-pattern-hashing-stacks-queues-monotonic.md) |
| sliding window max | monotonic deque | [6](06-pattern-hashing-stacks-queues-monotonic.md) |
| "smallest/largest value such that check passes" | binary search on answer | [7](07-pattern-binary-search-and-sorting.md) |
| sorted/rotated lookup | binary search (pred template) | [7](07-pattern-binary-search-and-sorting.md) |
| tree: combine children → answer | recursion contract | [8](08-pattern-trees-bst-tries.md) |
| BST + sorted order helps | in-order traversal | [8](08-pattern-trees-bst-tries.md) |
| prefix / autocomplete / dictionary | trie | [8](08-pattern-trees-bst-tries.md) |
| grid / connected / reachable | BFS/DFS | [9](09-pattern-graphs-bfs-dfs-topo-union-find.md) |
| shortest path, unweighted | BFS | [9](09-pattern-graphs-bfs-dfs-topo-union-find.md) |
| spread from many starts | multi-source BFS | [9](09-pattern-graphs-bfs-dfs-topo-union-find.md) |
| ordering with prerequisites / cycle in DAG | topological sort | [9](09-pattern-graphs-bfs-dfs-topo-union-find.md) |
| same group? components? undirected cycle? | union-find | [9](09-pattern-graphs-bfs-dfs-topo-union-find.md) |
| weighted shortest path (non-neg) | Dijkstra (min-heap) | [9](09-pattern-graphs-bfs-dfs-topo-union-find.md) |
| top-K / merge-K / running median | heap | [10](10-pattern-heaps-intervals-greedy.md) |
| overlapping / scheduling | sort intervals + sweep/heap | [10](10-pattern-heaps-intervals-greedy.md) |
| all subsets/perms/combos | backtracking | [11](11-pattern-recursion-backtracking.md) |
| count ways / min-max cost / overlapping subproblems | DP | [12](12-pattern-dynamic-programming.md) |

**Heap polarity:** K largest → **min**-heap of size K; K smallest → **max**-heap of size K.
**Intervals:** merge→sort by *start*; max non-overlap→sort by *end*.
**Backtrack:** choose→recurse→**un-choose**; store a **copy**; `start` for combos, `used[]` for perms;
dup-skip `i>start && a[i]==a[i-1]`.
**DP:** recursion + memo first; "what's the last decision, what subproblem remains?"; knapsack 0/1
loops capacity **descending**, unbounded **ascending**.

---

## A.4 System design — the 7-step ([Ch 14](14-system-design-framework.md))

```
1 REQUIREMENTS (functional + non-functional + scale; scope ruthlessly; ask read:write & consistency)
2 ESTIMATE     (QPS, storage; writes/sec = daily/1e5; peak ≈ 2–3×; tie numbers to decisions)
3 API          (few endpoints; cursor pagination; idempotency keys)
4 DATA MODEL   (access pattern → store choice)
5 HIGH-LEVEL   (boxes + happy-path flow; stateless app servers; cache-aside; async boundary)
6 DEEP DIVE    (CHOOSE the bottleneck, go deep unprompted)
7 WRAP         (SPOFs, failure modes, what changes at 10×)
```
Every decision: **"X over Y because [requirement]; tradeoff is [cost]."**

**Reusable design checklist:** estimate → cache reads → async via queue → shard by access-pattern key
→ solve the hot key (hybrid) → state consistency cost.

---

## A.5 Building blocks & numbers ([Ch 15](15-building-blocks-and-back-of-envelope.md))

**Latency:** L1 ~1ns · RAM ~100ns · SSD read ~100µs · same-DC RTT ~0.5ms · cross-continent RTT
~150ms. (RAM ≈100× L1; SSD ≈1000× RAM; cross-continent ≈300× same-DC.)
**Magnitudes:** day ≈ 10⁵ s · KB/MB/GB/TB = 10³/10⁶/10⁹/10¹².

| Block | Reach for it when | Tradeoff one-liner |
|-------|-------------------|--------------------|
| Load balancer | >1 app server | L7 smart routing/TLS vs L4 speed |
| Cache (cache-aside) | read:write ≫ 1, hot keys | speed vs stale window + invalidation |
| SQL | transactions, joins, ad-hoc queries | consistency vs horizontal write scale |
| NoSQL (wide-column/doc) | write scale, key access, flexible schema | scale vs joins/strong consistency |
| Redis (in-mem KV) | sub-ms, counters, pub/sub, geo | speed vs durability/memory cost |
| Message queue | spikes, decouple, async, fan-out | latency/ops vs decoupling+resilience |
| CDN/edge | static, geo-distributed reads | kills cross-continent RTT |

**CAP:** under partition, pick C or A. **PACELC:** else, pick Latency or Consistency. Feed→eventual;
ledger→strong. **Sharding:** consistent hashing resizes cheaply; pick key for even load + query
pattern; hot key → split/replicate/special-case. **Resilience:** retry+backoff+**jitter**, circuit
breaker, bulkhead, rate limit, timeouts, **idempotency** (= at-least-once + dedup ≈ exactly-once).

---

## A.6 LLD / OOD ([Ch 17](17-ood-solid-and-patterns.md))

Process: **clarify → entities → relationships → the ONE pattern → concurrency.** Restraint wins.
**SOLID:** S(one reason to change) O(extend, don't modify) L(subtype substitutable) I(small
interfaces) D(depend on abstractions). Lead with **O + D**.

| Pattern | Problem it solves |
|---------|-------------------|
| Strategy | swappable behavior/algorithm at runtime (pricing, splits, scheduling) |
| Observer | notify many on change (notifications, pub/sub) |
| Factory | hide which concrete class is built |
| State | behavior by mode + legal transitions (lifecycles) |
| Decorator | stackable add-ons |
| Singleton | one instance — holder idiom or enum |

**Concurrency:** name the shared mutable state; narrowest fix — atomics/CAS → concurrent collections
→ per-resource lock → (last) global lock; immutability beats all. `LinkedHashMap(accessOrder=true)`
= free LRU.

---

## A.7 Behavioral ([Ch 19](19-behavioral-star-and-story-bank.md)) & company signals ([Ch 20](20-company-signals-and-leadership-principles.md))

**STAR:** Situation(15%) Task(15%) **Action(50%, "I" not "we")** Result(20%, **quantified +
learning**). Headline first. 3–4 min, rehearse beats not script.
**Scope = leveling:** "I saw it, owned it, drove it across people, moved [metric], it lasted."
**Always rehearse:** conflict, failure, ambiguity.

**5 universal signals:** impact/scope · ownership/drive · collaboration/conflict · growth ·
judgment.

| Company | Framing | Lead with |
|---------|---------|-----------|
| Google | Googleyness + GCA | structured thinking, ambiguity, **intellectual humility** (changed mind w/ data) |
| Meta | speed + impact + bold ownership | concise, decisive, quantified; conflict needs *resolution* |
| Microsoft | growth mindset + Model/Coach/Care | learning, mentorship, cross-silo; **real failure→growth** |

Same bank, re-pointed and re-worded per company. Prepare a genuine "why this company."

---

## A.8 Negotiation ([Ch 21](21-negotiation-and-offer.md))

Leverage order: **level > equity > sign-on > base.** Never accept on the call. Don't anchor first.
Compare **TC over the vest**, not base. Get real competing offers. India: model RSUs conservatively,
ask vest schedule + refreshers, use sign-on for notice-period buyout, discount illiquid ESOPs.

---

## A.9 Level bar ([Ch 1](01-levels-loops-and-rubrics.md)) — the one-liner

> **L4 = solve a defined problem cleanly. L5 = define and own an ambiguous one.** Prepare to L5.
> The interviewer is a note-taker for a committee — generate quotable, level-justifying evidence.

Loops: **Google** (HC reads writeups; clean code; Googleyness). **Meta** (2 problems/round, fast;
behavioral weighted). **Microsoft** ("As Appropriate" swing round; growth mindset; pragmatism).
