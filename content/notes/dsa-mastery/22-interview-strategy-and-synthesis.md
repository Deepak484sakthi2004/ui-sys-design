# Chapter 22: Interview Strategy & Synthesis

## The Capstone: Everything You Know, Deployed Under Pressure

You have spent twenty-one chapters building a deep understanding of data structures, algorithms, JVM internals, and algorithmic patterns. You can explain why a `HashMap` rehash doubles capacity to the next power of two, why `LinkedList` is a GC nightmare, why monotonic stacks solve next-greater-element in O(n), and why dynamic programming on trees requires careful subtree aggregation. You have the knowledge.

But knowledge alone does not pass interviews.

I have watched senior engineers with 15+ years of experience — people who architect systems handling millions of requests per second — freeze in 45-minute coding interviews. Not because they lack ability, but because they lack a *framework*. They jump to code before understanding the problem. They overengineer a generic solution when a specific one suffices. They forget to test edge cases because they are mentally exhausted from coding without a plan.

This chapter is your framework. It is the strategic layer that turns raw knowledge into interview performance. We will cover the exact minute-by-minute protocol for a 45-minute interview, the pattern recognition flowchart that maps problem characteristics to algorithms, the communication strategies that signal "senior engineer" to your interviewer, and the common traps that experienced developers fall into precisely *because* of their experience.

Then we will put it all together: 20 synthesis problems that require combining multiple patterns, and 5 full mock interview walkthroughs — complete with clarifying questions, wrong first approaches, corrections, optimal solutions, and follow-up questions.

This is the final chapter. Let us make every minute count.

---

## 22.1 The 45-Minute Interview Framework

Every coding interview, regardless of company, follows the same fundamental structure. The difference between a "hire" and a "no-hire" often comes down not to whether you solved the problem, but to *how* you navigated the 45 minutes. Here is the framework I recommend — tuned specifically for senior-level candidates at the 40 LPA tier.

### Minutes 0-5: CLARIFY

This is the most underrated phase. Junior candidates start coding immediately. Senior candidates ask questions. The interviewer *wants* you to ask questions — it signals that you think about requirements before implementation, which is exactly what they need from a senior hire.

**Questions to always ask:**

```
1. INPUT CONSTRAINTS
   - "What is the expected size of the input? Hundreds, thousands, millions?"
     (This determines whether O(n^2) is acceptable or if you need O(n log n) / O(n))
   - "Are there constraints on the values? Positive only? Bounded range?"
     (Bounded range → counting sort, bitmap, or bucket approach might work)
   - "Can the input contain duplicates?"
     (Duplicates affect two-pointer, binary search, and set-based approaches)
   - "Can the input be empty or null?"
     (Determines your base cases)

2. OUTPUT REQUIREMENTS
   - "Should I return one valid answer or all valid answers?"
     (One answer → greedy/DP; all answers → backtracking)
   - "If multiple valid answers exist, any preference?"
     (Lexicographic order → may need sorting or trie)
   - "What should I return for invalid input?"
     (Empty list, -1, throw exception?)

3. EXPECTED COMPLEXITY
   - "What time complexity are you looking for?"
     (Some interviewers tell you directly — this is free information)
   - "Is there a space constraint?"
     (O(1) space changes the approach dramatically)

4. CLARIFYING AMBIGUITIES
   - Work through the given example to confirm understanding
   - Create your own small example and verify expected output
   - "Is the array/string guaranteed to be non-empty?"
```

**Why this matters for senior interviews**: At the 40 LPA level, the interviewer is evaluating your *process*, not just your answer. When you ask "What is the expected input size?", you are signaling that in production, you would never design a system without understanding load characteristics. When you ask about edge cases, you are signaling that you write robust code. These signals matter as much as getting the algorithm right.

### Minutes 5-10: DESIGN

After clarifying, explain your approach *before writing a single line of code*. This is where you demonstrate algorithmic thinking.

**The Design Protocol:**

```
Step 1: State the brute force approach and its complexity
   "The brute force would be to check every pair — O(n^2) time."
   (This shows you can think from first principles)

Step 2: Identify the pattern and state a better approach
   "Since the array is sorted, I can use two pointers — O(n) time, O(1) space."
   (This shows pattern recognition)

Step 3: Walk through your approach with the given example
   "Let me trace through: left=0, right=5..."
   (This catches logical errors before you code)

Step 4: State the data structures you will use
   "I'll use a HashMap to store value→index mappings."
   (This gives the interviewer a preview of your code structure)

Step 5: State the expected time and space complexity
   "This will be O(n) time, O(n) space."
   (This sets the expectation and lets the interviewer confirm or redirect)
```

**Critical**: If the interviewer says "Can you do better?", they are telling you your approach is not optimal. Do not defend it — pivot. If they say "That sounds good", proceed to coding.

### Minutes 10-35: CODE

You have 25 minutes to write clean, correct Java. This is the execution phase.

**Coding Protocol:**

```
1. STRUCTURE FIRST
   - Write the method signature
   - Write the return statement
   - Fill in the logic between

2. NAME VARIABLES WELL
   BAD:  int i, j, k, t, r;
   GOOD: int left, right, windowStart, maxLength, result;
   (Senior engineers write readable code — even in interviews)

3. HANDLE EDGE CASES FIRST
   if (nums == null || nums.length == 0) return ...;
   (Get these out of the way so your main logic is clean)

4. TALK WHILE CODING
   "I'm initializing a HashMap to store character frequencies..."
   "Now I'll expand the window by moving right..."
   "This while loop shrinks the window when the condition is violated..."
   (Silence makes the interviewer nervous. Narration lets them follow your thinking.)

5. USE HELPER METHODS
   If you need a utility (swap, reverse, isValid), write the signature,
   say "I'll implement this after the main logic," and move on.
   (This keeps your main algorithm clean and readable)

6. DO NOT PREMATURELY OPTIMIZE
   First make it correct. Then optimize if time allows.
   A correct O(n log n) solution beats a buggy O(n) solution every time.
```

**Common coding mistakes by senior devs:**

```java
// MISTAKE 1: Integer overflow in midpoint calculation
int mid = (left + right) / 2;           // OVERFLOW if left + right > Integer.MAX_VALUE
int mid = left + (right - left) / 2;    // SAFE — always use this form

// MISTAKE 2: Comparator overflow
Arrays.sort(arr, (a, b) -> a - b);           // OVERFLOW for large values
Arrays.sort(arr, (a, b) -> Integer.compare(a, b));  // SAFE
// Or: Arrays.sort(arr, Integer::compare);

// MISTAKE 3: Using == for object comparison
if (str1 == str2)            // Compares references, not values
if (str1.equals(str2))       // Correct — compares content

// MISTAKE 4: Modifying collection while iterating
for (String s : list) {
    if (s.startsWith("x")) list.remove(s);  // ConcurrentModificationException
}
// Fix: use Iterator.remove() or collect indices and remove after

// MISTAKE 5: Off-by-one in binary search
while (left < right)    // vs while (left <= right)
// Know which template you are using and be consistent
```

### Minutes 35-45: TEST

Testing is where senior candidates differentiate themselves. Do not just say "it works" — prove it.

**Testing Protocol:**

```
Step 1: Trace through the given example
   Walk through your code line by line with the example input.
   Update variables on the whiteboard/screen as you go.

Step 2: Test edge cases (pick 2-3 most relevant)
   - Empty input: nums = []
   - Single element: nums = [5]
   - All duplicates: nums = [3, 3, 3, 3]
   - Already sorted / reverse sorted
   - Negative numbers
   - Integer overflow scenarios
   - Minimum and maximum constraints

Step 3: Analyze complexity
   "Time: O(n) — we visit each element at most twice (once by right, once by left)."
   "Space: O(min(n, k)) — the HashMap stores at most k distinct characters."

Step 4: Discuss optimization opportunities
   "If this were in production with very large inputs, I'd consider..."
   "We could parallelize this if the input doesn't fit in memory..."
```

### The Framework Summarized

```
┌─────────────────────────────────────────────────────────┐
│              45-MINUTE INTERVIEW FRAMEWORK                │
│                                                          │
│  [0-5 min]  CLARIFY                                     │
│    ├── Input size, constraints, edge cases               │
│    ├── Output requirements                               │
│    └── Expected complexity                               │
│                                                          │
│  [5-10 min] DESIGN                                      │
│    ├── State brute force + complexity                    │
│    ├── Identify pattern → better approach                │
│    ├── Walk through example                              │
│    ├── State data structures                             │
│    └── State time/space complexity                       │
│                                                          │
│  [10-35 min] CODE                                       │
│    ├── Edge cases first                                  │
│    ├── Clean variable names                              │
│    ├── Talk while coding                                 │
│    ├── Helper methods for clarity                        │
│    └── Correct first, optimize second                    │
│                                                          │
│  [35-45 min] TEST                                       │
│    ├── Trace given example                               │
│    ├── Test 2-3 edge cases                               │
│    ├── State complexity analysis                         │
│    └── Discuss production considerations                 │
└─────────────────────────────────────────────────────────┘
```

---

## 22.2 Pattern Recognition Flowchart

When you see a new problem, the first challenge is identifying which pattern(s) to apply. After 21 chapters, you have a large toolbox. This flowchart maps problem characteristics to the right tool.

```
START: Read the problem statement carefully
  │
  ▼
Is the input a SORTED array/list?
  ├── YES ──→ Binary Search variants (Ch 15, 19)
  │            Two Pointers (Ch 15)
  │            "Find a pair summing to target?" → Two Pointers
  │            "Find insertion point?" → Binary Search
  │            "Find first/last occurrence?" → Binary Search with conditions
  │
  ▼ NO
Is it asking for an OPTIMAL SUBARRAY / SUBSTRING?
  ├── YES ──→ "Contiguous subarray with constraints?" → Sliding Window (Ch 15)
  │            "Maximum sum subarray?" → Kadane's Algorithm (Ch 17)
  │            "Subarray sum equals target?" → Prefix Sum + HashMap (Ch 15)
  │            "Longest substring with condition?" → Sliding Window + HashMap
  │
  ▼ NO
Is it asking to FIND PAIRS or TRIPLETS?
  ├── YES ──→ "Input sorted?" → Two Pointers (Ch 15)
  │            "Input unsorted?" → HashMap for O(1) lookups (Ch 15)
  │            "All unique triplets summing to zero?" → Sort + Two Pointers
  │
  ▼ NO
Does it ask to EXPLORE ALL POSSIBILITIES / GENERATE ALL?
  ├── YES ──→ Backtracking (Ch 18)
  │            "Permutations?" → Backtracking with used[] array
  │            "Combinations/subsets?" → Backtracking with start index
  │            "Valid arrangements?" → Backtracking with pruning
  │            "Can I prune early?" → Backtracking with constraints
  │
  ▼ NO
Is it an OPTIMIZATION with OVERLAPPING SUBPROBLEMS?
  ├── YES ──→ Dynamic Programming (Ch 17)
  │            "Optimal subsequence?" → 1D DP
  │            "Two sequences / edit distance?" → 2D DP
  │            "On a tree?" → Tree DP (Ch 16)
  │            "On a graph?" → DP + topological order
  │            "Knapsack variant?" → 0/1 knapsack or unbounded
  │
  ▼ NO
Is it a GRAPH problem?
  ├── YES ──→ "Shortest path (unweighted)?" → BFS (Ch 16)
  │            "Shortest path (weighted, non-negative)?" → Dijkstra (Ch 16)
  │            "Shortest path (negative weights)?" → Bellman-Ford
  │            "All-pairs shortest path?" → Floyd-Warshall
  │            "Connected components?" → Union-Find or DFS (Ch 16, 19)
  │            "Cycle detection?" → DFS coloring or Union-Find
  │            "Dependencies / ordering?" → Topological Sort (Ch 16)
  │            "Minimum spanning tree?" → Kruskal's (sort + Union-Find)
  │            "Bipartite check?" → BFS/DFS 2-coloring
  │
  ▼ NO
Is it about a STREAM of DATA or RUNNING STATISTICS?
  ├── YES ──→ "Running median?" → Two Heaps (max + min) (Ch 6)
  │            "Top K elements?" → Min-Heap of size K (Ch 6)
  │            "K closest / K most frequent?" → Heap or QuickSelect
  │            "Merge K sorted lists?" → Min-Heap
  │
  ▼ NO
Does it involve PARENTHESES / NESTING / MATCHING?
  ├── YES ──→ Stack (Ch 6)
  │            "Valid parentheses?" → Stack matching
  │            "Evaluate expression?" → Stack-based evaluation
  │            "Decode nested string?" → Stack with partial results
  │
  ▼ NO
Does it ask for NEXT GREATER / NEXT SMALLER element?
  ├── YES ──→ Monotonic Stack (Ch 19)
  │            "Next greater element?" → Decreasing monotonic stack
  │            "Next smaller element?" → Increasing monotonic stack
  │            "Largest rectangle in histogram?" → Monotonic stack
  │
  ▼ NO
Does it ask for MIN/MAX of a SLIDING WINDOW?
  ├── YES ──→ Monotonic Deque (Ch 19)
  │            "Maximum of every window of size k?" → Decreasing deque
  │            "Minimum of every window of size k?" → Increasing deque
  │
  ▼ NO
Does it involve RANGE QUERIES with updates?
  ├── YES ──→ "Point update, range query?" → Fenwick Tree (Ch 19)
  │            "Range update, range query?" → Segment Tree with lazy propagation (Ch 19)
  │            "Static range queries?" → Sparse Table or Prefix Sum
  │
  ▼ NO
Does it involve PREFIX MATCHING or WORD SEARCH?
  ├── YES ──→ Trie (Ch 9, 19)
  │            "Autocomplete?" → Trie + DFS
  │            "Word search in grid?" → Trie + Backtracking
  │            "Longest common prefix?" → Trie
  │
  ▼ NO
Is it a DESIGN problem?
  ├── YES ──→ "LRU Cache?" → HashMap + Doubly Linked List (Ch 4)
  │            "LFU Cache?" → HashMap + Frequency buckets
  │            "Iterator?" → Stack or Queue for lazy traversal
  │            "Randomized set?" → ArrayList + HashMap
  │
  ▼ NO
COMBINATION PATTERNS (the hard problems)
  ├── Binary Search on Answer + Greedy validation
  ├── Sorting + Two Pointers + Deduplication
  ├── BFS/DFS + Memoization (graph DP)
  ├── Trie + Backtracking (word search)
  ├── Union-Find + Sorting (Kruskal, component queries)
  └── Sliding Window + HashMap (constrained substring)
```

**How to use this flowchart**: Read the problem statement. Identify 2-3 keywords or characteristics. Follow the flowchart. For hard problems, you will often need to combine two branches — this is exactly what Section 22.6 practices.

---

## 22.3 Complexity Cheat Sheet

This table covers every data structure you will encounter. Memorize the ones you use most; know where to find the rest.

### Standard JDK Collections

```
┌──────────────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
│ Data Structure    │ Access   │ Search   │ Insert   │ Delete   │ Space    │
├──────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┤
│ Array (int[])     │ O(1)     │ O(n)     │ O(n)*    │ O(n)*    │ O(n)     │
│ ArrayList         │ O(1)     │ O(n)     │ O(1)**   │ O(n)     │ O(n)     │
│ LinkedList        │ O(n)     │ O(n)     │ O(1)***  │ O(1)***  │ O(n)     │
│ HashMap           │ —        │ O(1)†    │ O(1)†    │ O(1)†    │ O(n)     │
│ HashSet           │ —        │ O(1)†    │ O(1)†    │ O(1)†    │ O(n)     │
│ LinkedHashMap     │ —        │ O(1)†    │ O(1)†    │ O(1)†    │ O(n)     │
│ TreeMap           │ —        │ O(log n) │ O(log n) │ O(log n) │ O(n)     │
│ TreeSet           │ —        │ O(log n) │ O(log n) │ O(log n) │ O(n)     │
│ PriorityQueue     │ peek O(1)│ O(n)     │ O(log n) │ O(log n) │ O(n)     │
│ ArrayDeque        │ O(1)‡    │ O(n)     │ O(1)**   │ O(1)‡    │ O(n)     │
│ Stack (legacy)    │ O(1)‡    │ O(n)     │ O(1)**   │ O(1)‡    │ O(n)     │
└──────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┘

*   Array insert/delete requires shifting elements
**  Amortized O(1) — occasional O(n) resize
*** O(1) if you have a reference to the node; O(n) to find the node first
†   Amortized O(1) average; O(n) worst case if hash function is poor
    (Java 8+ TreeMap-ifies buckets with 8+ collisions → O(log n) worst case)
‡   O(1) at head/tail only; O(n) in the middle
```

### Sorted Structure Operations

```
┌──────────────────┬───────────┬───────────┬────────────┬───────────────────┐
│ Operation         │ TreeMap   │ TreeSet   │ Notes                          │
├──────────────────┼───────────┼───────────┼────────────────────────────────┤
│ firstKey/first()  │ O(log n)  │ O(log n)  │ Leftmost node in Red-Black    │
│ lastKey/last()    │ O(log n)  │ O(log n)  │ Rightmost node                │
│ floorKey/floor()  │ O(log n)  │ O(log n)  │ Greatest key ≤ given          │
│ ceilingKey/ceil() │ O(log n)  │ O(log n)  │ Smallest key ≥ given          │
│ headMap/headSet() │ O(log n)  │ O(log n)  │ Returns view, iteration O(k)  │
│ tailMap/tailSet() │ O(log n)  │ O(log n)  │ Returns view, iteration O(k)  │
│ subMap/subSet()   │ O(log n)  │ O(log n)  │ Range view                    │
└──────────────────┴───────────┴───────────┴────────────────────────────────┘
```

### Advanced Data Structures

```
┌──────────────────┬──────────────┬──────────────┬──────────────┬──────────┐
│ Data Structure    │ Build        │ Query        │ Update       │ Space    │
├──────────────────┼──────────────┼──────────────┼──────────────┼──────────┤
│ Trie              │ O(n × L)     │ O(L)         │ O(L)         │ O(n × L) │
│ Segment Tree      │ O(n)         │ O(log n)     │ O(log n)     │ O(n)     │
│ Fenwick Tree (BIT)│ O(n log n)   │ O(log n)     │ O(log n)     │ O(n)     │
│ Union-Find (DSU)  │ O(n)         │ O(α(n)) ≈ 1  │ O(α(n)) ≈ 1  │ O(n)     │
│ Skip List         │ —            │ O(log n)*    │ O(log n)*    │ O(n)*    │
│ Bloom Filter      │ O(n × k)     │ O(k)         │ O(k) insert  │ O(m)     │
│ Sparse Table      │ O(n log n)   │ O(1) (RMQ)   │ —            │ O(n log n)│
└──────────────────┴──────────────┴──────────────┴──────────────┴──────────┘

L = length of key/word
α(n) = inverse Ackermann function ≈ constant for all practical n
k = number of hash functions (Bloom Filter)
m = bit array size (Bloom Filter)
* = expected/average (Skip List is probabilistic)
```

### Sorting Algorithms

```
┌──────────────────┬──────────────┬──────────────┬──────────────┬──────────┐
│ Algorithm         │ Best         │ Average      │ Worst        │ Space    │
├──────────────────┼──────────────┼──────────────┼──────────────┼──────────┤
│ Arrays.sort(int[])│ O(n log n)   │ O(n log n)   │ O(n log n)   │ O(log n) │
│   (Dual-Pivot QS) │              │              │              │          │
│ Arrays.sort(T[])  │ O(n log n)   │ O(n log n)   │ O(n log n)   │ O(n)     │
│   (TimSort)       │ O(n) presort │              │              │          │
│ Collections.sort()│ same as TimSort (delegates to Arrays.sort)            │
│ Merge Sort        │ O(n log n)   │ O(n log n)   │ O(n log n)   │ O(n)     │
│ Quick Sort        │ O(n log n)   │ O(n log n)   │ O(n^2)       │ O(log n) │
│ Heap Sort         │ O(n log n)   │ O(n log n)   │ O(n log n)   │ O(1)     │
│ Counting Sort     │ O(n + k)     │ O(n + k)     │ O(n + k)     │ O(k)     │
│ Radix Sort        │ O(n × d)     │ O(n × d)     │ O(n × d)     │ O(n + k) │
│ Bucket Sort       │ O(n + k)     │ O(n + k)     │ O(n^2)       │ O(n)     │
└──────────────────┴──────────────┴──────────────┴──────────────┴──────────┘

k = range of input values (Counting Sort), number of buckets (Bucket Sort)
d = number of digits (Radix Sort)
```

### Graph Algorithm Complexities

```
┌──────────────────┬──────────────┬──────────────────────────────────────────┐
│ Algorithm         │ Time         │ Notes                                    │
├──────────────────┼──────────────┼──────────────────────────────────────────┤
│ BFS / DFS         │ O(V + E)     │ Unweighted shortest path (BFS)          │
│ Dijkstra (heap)   │ O((V+E)logV) │ Non-negative weights                    │
│ Bellman-Ford      │ O(V × E)     │ Handles negative weights, detects neg   │
│                   │              │ cycles                                   │
│ Floyd-Warshall    │ O(V^3)       │ All-pairs shortest path                 │
│ Topological Sort  │ O(V + E)     │ DAG only — Kahn's (BFS) or DFS         │
│ Kruskal's MST     │ O(E log E)   │ Sort edges + Union-Find                 │
│ Prim's MST        │ O((V+E)logV) │ Priority queue approach                 │
│ Tarjan's SCC      │ O(V + E)     │ Strongly connected components           │
│ Kosaraju's SCC    │ O(V + E)     │ Two-pass DFS                            │
│ Articulation Pts  │ O(V + E)     │ Tarjan's low-link values                │
│ Max Flow (Dinic)  │ O(V^2 × E)   │ Network flow                            │
└──────────────────┴──────────────┴──────────────────────────────────────────┘
```

---

## 22.4 Communication Strategies for Senior Engineers

At the 40 LPA level, you are not just being evaluated on whether you solve the problem. You are being evaluated on *how you think*. Here are the communication strategies that signal depth and seniority.

### Signal 1: Connect Data Structure Choices to JVM Internals

Do not just say "I'll use a HashMap." Say *why*, and show you understand the trade-offs.

```
GOOD: "I'll use a HashMap for O(1) amortized lookups. Since the keys are
       strings, the hash distribution should be good with Java's built-in
       String.hashCode(). If we were worried about adversarial input causing
       hash collisions, Java 8+ treeifies buckets at 8 entries, giving us
       O(log n) worst case."

BETTER: "I'll use a HashMap. With n up to 10^5 entries, memory is about
        3.2 MB (each Node is 32 bytes with compressed OOPs). The default
        load factor of 0.75 means it will resize once from the default
        capacity of 16. I'll set initial capacity to avoid resizes:
        new HashMap<>(n * 4 / 3 + 1)."

FOR CONCURRENCY: "In production, this would need ConcurrentHashMap for
                  thread safety. It uses a lock-striping approach — locks
                  per segment — so reads are lock-free and writes only
                  contend on the same bucket. For this interview problem,
                  I'll use a regular HashMap since we're single-threaded."
```

### Signal 2: Discuss Trade-offs Explicitly

Every algorithm decision has trade-offs. Mentioning them — even briefly — shows senior thinking.

```
TIME vs SPACE:
"We can solve this in O(n) time with O(n) space using a HashMap, or
 O(n log n) time with O(1) space using sorting. Since n is up to 10^6
 and there's no space constraint mentioned, I'll go with the HashMap
 approach."

AVERAGE vs WORST CASE:
"QuickSelect gives O(n) average for the k-th element, but O(n^2) worst
 case. Since the interviewer hasn't mentioned adversarial input, I'll use
 it. If worst case mattered, I'd use median-of-medians for guaranteed O(n),
 but it's complex to implement."

SIMPLICITY vs PERFORMANCE:
"I could use a Fenwick tree for O(log n) range queries, but since we only
 query once, a simple prefix sum in O(n) is cleaner and sufficient."
```

### Signal 3: Show System Awareness

Connect the interview problem to real-world system concerns.

```
MEMORY: "For 10 million elements, this HashMap would use about 720 MB.
         In production, I'd consider primitive-specialized collections
         like Eclipse Collections IntIntHashMap to cut that to ~150 MB."

THREADING: "This sliding window approach is inherently sequential.
            For parallel processing, I'd partition the input and merge
            results, handling the boundary overlap carefully."

DURABILITY: "If this data needed to survive restarts, I'd persist the
             sorted structure to a B-tree backed store — similar to how
             LSM trees in LevelDB/RocksDB maintain sorted runs."

SCALE: "If the graph doesn't fit in memory, I'd use an external-memory
        BFS — similar to how Neo4j traverses large graphs with
        memory-mapped files and page caching."
```

### Signal 4: Talk About Testing Naturally

As you code, naturally mention edge cases and how your code handles them.

```
"I'm adding this null check at the top because the input isn't guaranteed
 non-null. In production, I'd use @NonNull annotations, but for the
 interview, an explicit check is clearer."

"This handles the case where all elements are the same — the two pointers
 will converge at the center without entering the swap branch."

"I'm using long instead of int for the sum accumulator to avoid overflow
 — if all 10^5 elements are 10^9, the sum exceeds Integer.MAX_VALUE."
```

### Signal 5: First Correct, Then Right, Then Fast

This is Kent Beck's maxim, and it applies perfectly to interviews.

```
Phase 1 — Make it work:
  Get a correct brute-force solution. Handle all edge cases.

Phase 2 — Make it right:
  Refactor for clarity. Extract helpers. Name variables properly.

Phase 3 — Make it fast:
  Apply the optimal algorithm. Only now worry about constant factors.
```

In a 45-minute interview, you rarely have time for Phase 3. A correct O(n log n) solution with clean code and good communication beats a buggy O(n) solution every time. The interviewer can see that you *could* optimize further; they cannot infer correctness from a half-working solution.

---

## 22.5 Common Mistakes by Experienced Developers

Ironically, the more experienced you are, the more specific traps await you. These are not beginner mistakes — they are patterns I have seen from 10+ year veterans.

### Mistake 1: Overengineering

**The trap**: Your production instincts kick in. You start writing a generic, extensible, Strategy-patterned solution when the problem asks for a specific algorithm.

```java
// OVERENGINEERED — the interviewer asked for "find two numbers that sum to target"
interface SumFinder {
    int[] findSum(int[] nums, int target);
}
class HashMapSumFinder implements SumFinder { ... }
class TwoPointerSumFinder implements SumFinder { ... }
class SumFinderFactory {
    public static SumFinder create(boolean isSorted) { ... }
}

// WHAT THEY WANTED
public int[] twoSum(int[] nums, int target) {
    Map<Integer, Integer> seen = new HashMap<>();
    for (int i = 0; i < nums.length; i++) {
        int complement = target - nums[i];
        if (seen.containsKey(complement)) {
            return new int[]{seen.get(complement), i};
        }
        seen.put(nums[i], i);
    }
    return new int[]{};
}
```

**The fix**: Interview code is *disposable*. Write the simplest correct solution. No factories, no interfaces, no generics unless the problem specifically requires them.

### Mistake 2: Premature Optimization

**The trap**: You see an O(n^2) approach and immediately jump to optimizing it before confirming it is correct.

**The fix**: State the brute force, then optimize. "I see O(n^2) works here. Can I do better? Yes — with a HashMap I can reduce to O(n)." Then implement the O(n) solution *from scratch*, not by patching the brute force.

### Mistake 3: Not Verifying Constraints

**The trap**: You assume the input is sorted, or positive, or non-empty, because the given example happens to be.

```java
// The example is [1, 2, 3, 4, 5] — so you assume sorted
// But the actual constraint is: "array of integers" — could be [5, -3, 2, 0, 1]

// The example is [1, 2, 3] — so you assume positive
// But the constraint says: "-10^9 <= nums[i] <= 10^9"
```

**The fix**: Always ask "Can the input contain negatives? Zeros? Duplicates? Is it sorted?" during the CLARIFY phase.

### Mistake 4: Integer Overflow

This is the most common bug in senior coding interviews. Java's `int` range is approximately +/-2.1 billion.

```java
// BUG: Midpoint overflow
int mid = (left + right) / 2;  // If left=1B, right=1.5B: 2.5B overflows int
int mid = left + (right - left) / 2;  // CORRECT

// BUG: Sum overflow
int sum = 0;
for (int num : nums) sum += num;  // If sum exceeds 2.1B → overflow
long sum = 0;
for (int num : nums) sum += num;  // CORRECT — use long accumulator

// BUG: Product overflow
int product = a * b;  // If a=100_000, b=100_000: 10^10 overflows int
long product = (long) a * b;  // CORRECT — cast BEFORE multiplication

// BUG: Comparator overflow
Arrays.sort(intervals, (a, b) -> a[0] - b[0]);
// If a[0] = Integer.MIN_VALUE, b[0] = 1: MIN_VALUE - 1 overflows!
Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));  // CORRECT
```

### Mistake 5: Off-by-One Errors

```java
// Binary search: is it < or <=?
// Template 1: find exact value
while (left <= right) {  // <= because single-element range [left, left] is valid
    int mid = left + (right - left) / 2;
    if (nums[mid] == target) return mid;
    else if (nums[mid] < target) left = mid + 1;
    else right = mid - 1;
}

// Template 2: find boundary (leftmost / rightmost)
while (left < right) {  // < because we converge left and right to same index
    int mid = left + (right - left) / 2;
    if (condition(mid)) right = mid;      // mid could be the answer
    else left = mid + 1;                  // mid is definitely not the answer
}
// Answer is at index left (== right)

// Sliding window: window is [left, right] inclusive
// Length is right - left + 1, NOT right - left
```

### Mistake 6: Forgetting Empty/Null Input

```java
// Always add at the top of your solution:
if (nums == null || nums.length == 0) return defaultValue;
if (s == null || s.isEmpty()) return defaultValue;
if (root == null) return defaultValue;
if (grid == null || grid.length == 0 || grid[0].length == 0) return defaultValue;
```

### Mistake 7: Reference Equality vs Value Equality

```java
// WRONG — compares references
Integer a = 200;
Integer b = 200;
if (a == b) { ... }  // FALSE! Values > 127 are not cached

// CORRECT — compares values
if (a.equals(b)) { ... }  // TRUE
if (a.intValue() == b.intValue()) { ... }  // TRUE

// String comparison
String s1 = new String("hello");
String s2 = new String("hello");
s1 == s2;       // FALSE — different objects
s1.equals(s2);  // TRUE — same content
```

### Mistake 8: Modifying Collection During Iteration

```java
// WRONG — ConcurrentModificationException
for (String key : map.keySet()) {
    if (key.startsWith("temp")) {
        map.remove(key);  // modifying map while iterating
    }
}

// CORRECT — use Iterator.remove()
Iterator<String> it = map.keySet().iterator();
while (it.hasNext()) {
    if (it.next().startsWith("temp")) {
        it.remove();
    }
}

// CORRECT — use removeIf (Java 8+)
map.keySet().removeIf(key -> key.startsWith("temp"));

// CORRECT — collect keys to remove, then remove
List<String> toRemove = new ArrayList<>();
for (String key : map.keySet()) {
    if (key.startsWith("temp")) toRemove.add(key);
}
toRemove.forEach(map::remove);
```

### Mistake 9: Comparator with Overflow

This is subtle and trips up experienced developers regularly.

```java
// WRONG — integer overflow for extreme values
PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[0] - b[0]);
// If a[0] = Integer.MAX_VALUE, b[0] = -1: MAX_VALUE - (-1) = MAX_VALUE + 1 → OVERFLOW

// CORRECT — use Integer.compare
PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> Integer.compare(a[0], b[0]));

// CORRECT — use Comparator.comparingInt
PriorityQueue<int[]> pq = new PriorityQueue<>(Comparator.comparingInt(a -> a[0]));
```

---

## 22.6 Synthesis Problems — Combining Multiple Patterns

Hard interview problems rarely map to a single pattern. They require you to *see* multiple patterns and combine them. This section trains that skill.

Each problem lists which patterns to identify, how to combine them, and provides a complete Java solution.

---

### P22.01 [E] — Two Sum (HashMap Lookup)

**LC 1. Two Sum**

**Patterns**: HashMap for O(1) complement lookup.

This is the canonical warm-up. Every interview prep starts here.

```java
public int[] twoSum(int[] nums, int target) {
    Map<Integer, Integer> seen = new HashMap<>();
    for (int i = 0; i < nums.length; i++) {
        int complement = target - nums[i];
        if (seen.containsKey(complement)) {
            return new int[]{seen.get(complement), i};
        }
        seen.put(nums[i], i);
    }
    return new int[]{};
}
// Time: O(n), Space: O(n)
// Key insight: store value → index as you scan left to right.
// Each element checks if its complement was already seen.
```

---

### P22.02 [E] — Valid Parentheses (Stack Matching)

**LC 20. Valid Parentheses**

**Patterns**: Stack for matching nested brackets.

```java
public boolean isValid(String s) {
    Deque<Character> stack = new ArrayDeque<>();
    for (char c : s.toCharArray()) {
        if (c == '(') stack.push(')');
        else if (c == '[') stack.push(']');
        else if (c == '{') stack.push('}');
        else {
            if (stack.isEmpty() || stack.pop() != c) return false;
        }
    }
    return stack.isEmpty();
}
// Time: O(n), Space: O(n)
// Key insight: push the EXPECTED closing bracket.
// On a closing bracket, pop and compare — if mismatch, invalid.
```

---

### P22.03 [E] — Merge Two Sorted Lists (Two Pointers + Linked List)

**LC 21. Merge Two Sorted Lists**

**Patterns**: Two pointers on linked lists, sentinel node.

```java
public ListNode mergeTwoLists(ListNode l1, ListNode l2) {
    ListNode sentinel = new ListNode(0);
    ListNode curr = sentinel;
    while (l1 != null && l2 != null) {
        if (l1.val <= l2.val) {
            curr.next = l1;
            l1 = l1.next;
        } else {
            curr.next = l2;
            l2 = l2.next;
        }
        curr = curr.next;
    }
    curr.next = (l1 != null) ? l1 : l2;
    return sentinel.next;
}
// Time: O(m + n), Space: O(1)
// Key insight: sentinel node eliminates special-case for empty head.
```

---

### P22.04 [E] — Binary Search (Foundational)

**LC 704. Binary Search**

**Patterns**: Standard binary search on sorted array.

```java
public int search(int[] nums, int target) {
    int left = 0, right = nums.length - 1;
    while (left <= right) {
        int mid = left + (right - left) / 2;  // overflow-safe midpoint
        if (nums[mid] == target) return mid;
        else if (nums[mid] < target) left = mid + 1;
        else right = mid - 1;
    }
    return -1;
}
// Time: O(log n), Space: O(1)
// Key insight: use left + (right - left) / 2, never (left + right) / 2.
```

---

### P22.05 [E] — Maximum Depth of Binary Tree (DFS)

**LC 104. Maximum Depth of Binary Tree**

**Patterns**: DFS tree traversal, recursion.

```java
public int maxDepth(TreeNode root) {
    if (root == null) return 0;
    return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));
}
// Time: O(n), Space: O(h) where h = height (O(n) worst case for skewed tree)
// Key insight: depth = 1 + max(left depth, right depth).
```

---

### P22.06 [E] — Invert Binary Tree (Recursive Transformation)

**LC 226. Invert Binary Tree**

**Patterns**: DFS with modification, post-order traversal.

```java
public TreeNode invertTree(TreeNode root) {
    if (root == null) return null;
    TreeNode left = invertTree(root.left);
    TreeNode right = invertTree(root.right);
    root.left = right;
    root.right = left;
    return root;
}
// Time: O(n), Space: O(h)
// Key insight: swap children at every node, bottom-up.
```

---

### P22.07 [E] — Climbing Stairs (Basic DP)

**LC 70. Climbing Stairs**

**Patterns**: Dynamic programming, Fibonacci variant.

```java
public int climbStairs(int n) {
    if (n <= 2) return n;
    int prev2 = 1, prev1 = 2;
    for (int i = 3; i <= n; i++) {
        int curr = prev1 + prev2;
        prev2 = prev1;
        prev1 = curr;
    }
    return prev1;
}
// Time: O(n), Space: O(1)
// Key insight: f(n) = f(n-1) + f(n-2) — same as Fibonacci.
// Space-optimize: only need two previous values.
```

---

### P22.08 [E] — Flood Fill (BFS/DFS on Grid)

**LC 733. Flood Fill**

**Patterns**: BFS or DFS on implicit grid graph.

```java
public int[][] floodFill(int[][] image, int sr, int sc, int color) {
    int original = image[sr][sc];
    if (original == color) return image;  // avoid infinite loop
    dfs(image, sr, sc, original, color);
    return image;
}

private void dfs(int[][] image, int r, int c, int original, int color) {
    if (r < 0 || r >= image.length || c < 0 || c >= image[0].length) return;
    if (image[r][c] != original) return;
    image[r][c] = color;
    dfs(image, r, c + 1, original, color);
    dfs(image, r, c - 1, original, color);
    dfs(image, r + 1, c, original, color);
    dfs(image, r - 1, c, original, color);
}
// Time: O(m × n), Space: O(m × n) for recursion stack
// Key insight: check original == color before DFS to avoid infinite loop.
```

---

### P22.09 [M] — Longest Substring Without Repeating Characters (Sliding Window + HashMap)

**LC 3. Longest Substring Without Repeating Characters**

**Patterns**: Sliding window for optimal substring, HashMap for character tracking.

```java
public int lengthOfLongestSubstring(String s) {
    Map<Character, Integer> lastIndex = new HashMap<>();
    int maxLen = 0, left = 0;
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        if (lastIndex.containsKey(c) && lastIndex.get(c) >= left) {
            left = lastIndex.get(c) + 1;  // shrink window past duplicate
        }
        lastIndex.put(c, right);
        maxLen = Math.max(maxLen, right - left + 1);
    }
    return maxLen;
}
// Time: O(n), Space: O(min(n, charset_size))
// Pattern combination: sliding window manages the substring boundaries,
// HashMap tracks the most recent index of each character.
// The "jump" optimization (left = lastIndex.get(c) + 1) avoids the inner
// while loop that a naive sliding window would need.
```

---

### P22.10 [M] — 3Sum (Sorting + Two Pointers + Deduplication)

**LC 15. 3Sum**

**Patterns**: Sort → fix one element → two pointers for remaining pair, skip duplicates.

```java
public List<List<Integer>> threeSum(int[] nums) {
    List<List<Integer>> result = new ArrayList<>();
    Arrays.sort(nums);
    for (int i = 0; i < nums.length - 2; i++) {
        if (i > 0 && nums[i] == nums[i - 1]) continue;  // skip duplicate i
        int left = i + 1, right = nums.length - 1;
        int target = -nums[i];
        while (left < right) {
            int sum = nums[left] + nums[right];
            if (sum == target) {
                result.add(Arrays.asList(nums[i], nums[left], nums[right]));
                while (left < right && nums[left] == nums[left + 1]) left++;   // skip dup
                while (left < right && nums[right] == nums[right - 1]) right--; // skip dup
                left++;
                right--;
            } else if (sum < target) {
                left++;
            } else {
                right--;
            }
        }
    }
    return result;
}
// Time: O(n^2), Space: O(1) excluding output
// Pattern combination: sorting enables two pointers; deduplication at both
// the outer loop (i) and inner loop (left/right) prevents duplicate triplets.
```

---

### P22.11 [M] — Number of Islands (DFS/BFS + Grid Traversal)

**LC 200. Number of Islands**

**Patterns**: DFS on implicit grid graph, connected component counting.

```java
public int numIslands(char[][] grid) {
    if (grid == null || grid.length == 0) return 0;
    int count = 0;
    for (int i = 0; i < grid.length; i++) {
        for (int j = 0; j < grid[0].length; j++) {
            if (grid[i][j] == '1') {
                count++;
                sink(grid, i, j);  // sink the entire island
            }
        }
    }
    return count;
}

private void sink(char[][] grid, int r, int c) {
    if (r < 0 || r >= grid.length || c < 0 || c >= grid[0].length) return;
    if (grid[r][c] != '1') return;
    grid[r][c] = '0';  // mark visited by modifying input
    sink(grid, r + 1, c);
    sink(grid, r - 1, c);
    sink(grid, r, c + 1);
    sink(grid, r, c - 1);
}
// Time: O(m × n), Space: O(m × n) for stack
// Alternative: Union-Find with rank/path compression — O(m × n × α(m×n))
// Production note: modifying the input grid is acceptable in interviews.
// In production, use a separate boolean[][] visited.
```

---

### P22.12 [M] — Coin Change (DP — Unbounded Knapsack)

**LC 322. Coin Change**

**Patterns**: 1D DP, unbounded knapsack variant.

```java
public int coinChange(int[] coins, int amount) {
    int[] dp = new int[amount + 1];
    Arrays.fill(dp, amount + 1);  // impossible sentinel
    dp[0] = 0;
    for (int i = 1; i <= amount; i++) {
        for (int coin : coins) {
            if (coin <= i) {
                dp[i] = Math.min(dp[i], dp[i - coin] + 1);
            }
        }
    }
    return dp[amount] > amount ? -1 : dp[amount];
}
// Time: O(amount × coins.length), Space: O(amount)
// Key insight: dp[i] = min coins to make amount i.
// Each coin can be used unlimited times (unbounded knapsack).
```

---

### P22.13 [M] — Course Schedule (Topological Sort + Cycle Detection)

**LC 207. Course Schedule**

**Patterns**: Graph cycle detection using topological sort (Kahn's BFS).

```java
public boolean canFinish(int numCourses, int[][] prerequisites) {
    int[] inDegree = new int[numCourses];
    List<List<Integer>> graph = new ArrayList<>();
    for (int i = 0; i < numCourses; i++) graph.add(new ArrayList<>());
    for (int[] pre : prerequisites) {
        graph.get(pre[1]).add(pre[0]);
        inDegree[pre[0]]++;
    }

    Queue<Integer> queue = new LinkedList<>();
    for (int i = 0; i < numCourses; i++) {
        if (inDegree[i] == 0) queue.offer(i);
    }

    int processed = 0;
    while (!queue.isEmpty()) {
        int course = queue.poll();
        processed++;
        for (int neighbor : graph.get(course)) {
            if (--inDegree[neighbor] == 0) {
                queue.offer(neighbor);
            }
        }
    }
    return processed == numCourses;  // if not all processed → cycle exists
}
// Time: O(V + E), Space: O(V + E)
// Key insight: topological sort succeeds iff graph is a DAG.
// If processed < numCourses, there is a cycle.
```

---

### P22.14 [M] — Kth Largest Element (QuickSelect / Heap)

**LC 215. Kth Largest Element in an Array**

**Patterns**: QuickSelect (partition-based), or heap.

```java
// Approach 1: Min-heap of size k — O(n log k) time, O(k) space
public int findKthLargest(int[] nums, int k) {
    PriorityQueue<Integer> minHeap = new PriorityQueue<>();
    for (int num : nums) {
        minHeap.offer(num);
        if (minHeap.size() > k) minHeap.poll();
    }
    return minHeap.peek();
}

// Approach 2: QuickSelect — O(n) average, O(n^2) worst
public int findKthLargestQS(int[] nums, int k) {
    int target = nums.length - k;  // convert to kth smallest
    return quickSelect(nums, 0, nums.length - 1, target);
}

private int quickSelect(int[] nums, int left, int right, int k) {
    int pivotIndex = partition(nums, left, right);
    if (pivotIndex == k) return nums[k];
    else if (pivotIndex < k) return quickSelect(nums, pivotIndex + 1, right, k);
    else return quickSelect(nums, left, pivotIndex - 1, k);
}

private int partition(int[] nums, int left, int right) {
    // Random pivot to avoid worst case
    int randomIndex = left + (int)(Math.random() * (right - left + 1));
    swap(nums, randomIndex, right);
    int pivot = nums[right];
    int storeIndex = left;
    for (int i = left; i < right; i++) {
        if (nums[i] < pivot) {
            swap(nums, storeIndex, i);
            storeIndex++;
        }
    }
    swap(nums, storeIndex, right);
    return storeIndex;
}

private void swap(int[] nums, int i, int j) {
    int tmp = nums[i]; nums[i] = nums[j]; nums[j] = tmp;
}
// Trade-off: heap approach is simpler and has O(n log k) guaranteed.
// QuickSelect is O(n) average but O(n^2) worst case.
// For interviews, heap approach is safer and easier to code correctly.
```

---

### P22.15 [M] — Minimum Window Substring (Sliding Window + HashMap + Counter)

**LC 76. Minimum Window Substring**

**Patterns**: Sliding window + frequency map + "formed" counter for window validity.

```java
public String minWindow(String s, String t) {
    if (s.length() < t.length()) return "";

    Map<Character, Integer> need = new HashMap<>();
    for (char c : t.toCharArray()) need.merge(c, 1, Integer::sum);

    int required = need.size();  // unique chars needed
    int formed = 0;              // unique chars currently satisfied
    Map<Character, Integer> window = new HashMap<>();

    int left = 0, minLen = Integer.MAX_VALUE, minLeft = 0;
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        window.merge(c, 1, Integer::sum);
        if (need.containsKey(c) && window.get(c).intValue() == need.get(c).intValue()) {
            formed++;
        }

        while (formed == required) {
            if (right - left + 1 < minLen) {
                minLen = right - left + 1;
                minLeft = left;
            }
            char leftChar = s.charAt(left);
            window.merge(leftChar, -1, Integer::sum);
            if (need.containsKey(leftChar) &&
                window.get(leftChar) < need.get(leftChar)) {
                formed--;
            }
            left++;
        }
    }
    return minLen == Integer.MAX_VALUE ? "" : s.substring(minLeft, minLeft + minLen);
}
// Time: O(|s| + |t|), Space: O(|s| + |t|)
// Pattern combination: sliding window for substring boundaries,
// two HashMaps for tracking required vs actual frequencies,
// "formed" counter for O(1) validity check.
```

---

### P22.16 [M] — Rotting Oranges (Multi-source BFS)

**LC 994. Rotting Oranges**

**Patterns**: Multi-source BFS (all rotten oranges start simultaneously), grid traversal.

```java
public int orangesRotting(int[][] grid) {
    int rows = grid.length, cols = grid[0].length;
    Queue<int[]> queue = new LinkedList<>();
    int freshCount = 0;

    for (int r = 0; r < rows; r++) {
        for (int c = 0; c < cols; c++) {
            if (grid[r][c] == 2) queue.offer(new int[]{r, c});
            else if (grid[r][c] == 1) freshCount++;
        }
    }

    if (freshCount == 0) return 0;

    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    int minutes = 0;

    while (!queue.isEmpty() && freshCount > 0) {
        minutes++;
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            int[] cell = queue.poll();
            for (int[] d : dirs) {
                int nr = cell[0] + d[0], nc = cell[1] + d[1];
                if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && grid[nr][nc] == 1) {
                    grid[nr][nc] = 2;
                    freshCount--;
                    queue.offer(new int[]{nr, nc});
                }
            }
        }
    }
    return freshCount == 0 ? minutes : -1;
}
// Time: O(m × n), Space: O(m × n)
// Key insight: multi-source BFS — all rotten oranges are initial sources.
// Level-by-level BFS naturally counts minutes.
```

---

### P22.17 [M] — Task Scheduler (Greedy + Math / Heap)

**LC 621. Task Scheduler**

**Patterns**: Greedy with frequency counting and idle slot calculation.

```java
public int leastInterval(char[] tasks, int n) {
    int[] freq = new int[26];
    for (char task : tasks) freq[task - 'A']++;

    int maxFreq = 0;
    for (int f : freq) maxFreq = Math.max(maxFreq, f);

    // Count how many tasks have the maximum frequency
    int maxCount = 0;
    for (int f : freq) if (f == maxFreq) maxCount++;

    // Frame: (maxFreq - 1) groups of (n + 1) slots + final group of maxCount
    int result = (maxFreq - 1) * (n + 1) + maxCount;

    // If tasks fill all idle slots, answer is just tasks.length
    return Math.max(result, tasks.length);
}
// Time: O(n), Space: O(1)
// Key insight: arrange the most frequent task first with n gaps between.
// Other tasks fill the gaps. If gaps remain, they become idle slots.
// The math formula: (maxFreq - 1) × (n + 1) + countOfMaxFreqTasks.
```

---

### P22.18 [M] — Accounts Merge (Union-Find + HashMap)

**LC 721. Accounts Merge**

**Patterns**: Union-Find for grouping connected emails, HashMap for email-to-owner mapping.

```java
public List<List<String>> accountsMerge(List<List<String>> accounts) {
    int n = accounts.size();
    int[] parent = new int[n], rank = new int[n];
    for (int i = 0; i < n; i++) parent[i] = i;

    Map<String, Integer> emailToId = new HashMap<>();

    for (int i = 0; i < n; i++) {
        for (int j = 1; j < accounts.get(i).size(); j++) {
            String email = accounts.get(i).get(j);
            if (emailToId.containsKey(email)) {
                union(parent, rank, i, emailToId.get(email));
            } else {
                emailToId.put(email, i);
            }
        }
    }

    // Group emails by root account
    Map<Integer, TreeSet<String>> groups = new HashMap<>();
    for (Map.Entry<String, Integer> entry : emailToId.entrySet()) {
        int root = find(parent, entry.getValue());
        groups.computeIfAbsent(root, k -> new TreeSet<>()).add(entry.getKey());
    }

    List<List<String>> result = new ArrayList<>();
    for (Map.Entry<Integer, TreeSet<String>> entry : groups.entrySet()) {
        List<String> merged = new ArrayList<>();
        merged.add(accounts.get(entry.getKey()).get(0));  // owner name
        merged.addAll(entry.getValue());
        result.add(merged);
    }
    return result;
}

private int find(int[] parent, int x) {
    if (parent[x] != x) parent[x] = find(parent, parent[x]);
    return parent[x];
}

private void union(int[] parent, int[] rank, int a, int b) {
    int ra = find(parent, a), rb = find(parent, b);
    if (ra == rb) return;
    if (rank[ra] < rank[rb]) { int tmp = ra; ra = rb; rb = tmp; }
    parent[rb] = ra;
    if (rank[ra] == rank[rb]) rank[ra]++;
}
// Time: O(n × k × α(n)) where k = emails per account
// Space: O(n × k)
// Pattern combination: Union-Find groups accounts that share emails,
// HashMap maps each email to its account index,
// TreeSet sorts emails within each merged account.
```

---

### P22.19 [M] — Koko Eating Bananas (Binary Search on Answer + Greedy)

**LC 875. Koko Eating Bananas**

**Patterns**: Binary search on the answer space, greedy validation.

```java
public int minEatingSpeed(int[] piles, int h) {
    int left = 1, right = 0;
    for (int pile : piles) right = Math.max(right, pile);

    while (left < right) {
        int mid = left + (right - left) / 2;
        if (canFinish(piles, h, mid)) {
            right = mid;     // mid speed works, try slower
        } else {
            left = mid + 1;  // mid speed too slow
        }
    }
    return left;
}

private boolean canFinish(int[] piles, int h, int speed) {
    long hours = 0;
    for (int pile : piles) {
        hours += (pile + speed - 1) / speed;  // ceil division without overflow
    }
    return hours <= h;
}
// Time: O(n × log(max_pile)), Space: O(1)
// Pattern combination: binary search narrows the speed,
// greedy validation checks if a given speed finishes in time.
// This "binary search on answer" pattern appears in many problems:
// LC 410 Split Array Largest Sum, LC 1011 Capacity to Ship Packages,
// LC 1482 Minimum Number of Days to Make Bouquets.
```

---

### P22.20 [M] — Longest Increasing Subsequence (DP + Binary Search)

**LC 300. Longest Increasing Subsequence**

**Patterns**: DP with binary search optimization (patience sorting).

```java
// O(n^2) DP approach:
public int lengthOfLIS_DP(int[] nums) {
    int[] dp = new int[nums.length];
    Arrays.fill(dp, 1);
    int maxLen = 1;
    for (int i = 1; i < nums.length; i++) {
        for (int j = 0; j < i; j++) {
            if (nums[j] < nums[i]) {
                dp[i] = Math.max(dp[i], dp[j] + 1);
            }
        }
        maxLen = Math.max(maxLen, dp[i]);
    }
    return maxLen;
}

// O(n log n) patience sorting approach:
public int lengthOfLIS(int[] nums) {
    List<Integer> tails = new ArrayList<>();
    for (int num : nums) {
        int pos = Collections.binarySearch(tails, num);
        if (pos < 0) pos = -(pos + 1);
        if (pos == tails.size()) {
            tails.add(num);
        } else {
            tails.set(pos, num);
        }
    }
    return tails.size();
}
// Time: O(n log n), Space: O(n)
// Key insight: tails[i] = smallest tail element for increasing subsequence of length i+1.
// Binary search finds where to place each new element.
// The tails array is always sorted, enabling binary search.
```

---

### P22.21 [M] — Word Search (Backtracking + DFS on Grid)

**LC 79. Word Search**

**Patterns**: Backtracking on grid, DFS with visited marking.

```java
public boolean exist(char[][] board, String word) {
    for (int i = 0; i < board.length; i++) {
        for (int j = 0; j < board[0].length; j++) {
            if (backtrack(board, word, i, j, 0)) return true;
        }
    }
    return false;
}

private boolean backtrack(char[][] board, String word, int r, int c, int idx) {
    if (idx == word.length()) return true;
    if (r < 0 || r >= board.length || c < 0 || c >= board[0].length) return false;
    if (board[r][c] != word.charAt(idx)) return false;

    char saved = board[r][c];
    board[r][c] = '#';  // mark visited (in-place, no extra space)

    boolean found = backtrack(board, word, r + 1, c, idx + 1) ||
                    backtrack(board, word, r - 1, c, idx + 1) ||
                    backtrack(board, word, r, c + 1, idx + 1) ||
                    backtrack(board, word, r, c - 1, idx + 1);

    board[r][c] = saved;  // restore (backtrack)
    return found;
}
// Time: O(m × n × 4^L) where L = word length (worst case, usually much less with pruning)
// Space: O(L) for recursion stack
// Pattern: backtracking with in-place visited marking to save space.
```

---

### P22.22 [M] — Daily Temperatures (Monotonic Stack)

**LC 739. Daily Temperatures**

**Patterns**: Monotonic decreasing stack for "next greater element."

```java
public int[] dailyTemperatures(int[] temperatures) {
    int n = temperatures.length;
    int[] result = new int[n];
    Deque<Integer> stack = new ArrayDeque<>();  // stores indices

    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && temperatures[i] > temperatures[stack.peek()]) {
            int prevIdx = stack.pop();
            result[prevIdx] = i - prevIdx;
        }
        stack.push(i);
    }
    return result;
}
// Time: O(n), Space: O(n)
// Key insight: maintain a decreasing stack of indices.
// When a warmer day arrives, pop all cooler days and record the distance.
// Each index is pushed once and popped once → O(n) total.
```

---

### P22.23 [H] — Merge K Sorted Lists (Heap + Linked List)

**LC 23. Merge k Sorted Lists**

**Patterns**: Min-heap for k-way merge, sentinel linked list.

```java
public ListNode mergeKLists(ListNode[] lists) {
    PriorityQueue<ListNode> heap = new PriorityQueue<>(
        Comparator.comparingInt(a -> a.val)
    );
    for (ListNode head : lists) {
        if (head != null) heap.offer(head);
    }

    ListNode sentinel = new ListNode(0);
    ListNode curr = sentinel;
    while (!heap.isEmpty()) {
        ListNode smallest = heap.poll();
        curr.next = smallest;
        curr = curr.next;
        if (smallest.next != null) {
            heap.offer(smallest.next);
        }
    }
    return sentinel.next;
}
// Time: O(N log k) where N = total nodes, k = number of lists
// Space: O(k) for the heap
// Key insight: heap always contains at most k nodes (one per list).
// Each node is added and removed from the heap exactly once.
// Production note: this is exactly how external merge sort works —
// merge k sorted runs from disk using a heap.
```

---

### P22.24 [H] — Serialize and Deserialize Binary Tree (BFS + Design)

**LC 297. Serialize and Deserialize Binary Tree**

**Patterns**: BFS (level-order), string encoding, queue-based reconstruction.

```java
public class Codec {
    public String serialize(TreeNode root) {
        if (root == null) return "null";
        StringBuilder sb = new StringBuilder();
        Queue<TreeNode> queue = new LinkedList<>();
        queue.offer(root);
        while (!queue.isEmpty()) {
            TreeNode node = queue.poll();
            if (node == null) {
                sb.append("null,");
            } else {
                sb.append(node.val).append(",");
                queue.offer(node.left);
                queue.offer(node.right);
            }
        }
        return sb.toString();
    }

    public TreeNode deserialize(String data) {
        if (data.equals("null")) return null;
        String[] vals = data.split(",");
        TreeNode root = new TreeNode(Integer.parseInt(vals[0]));
        Queue<TreeNode> queue = new LinkedList<>();
        queue.offer(root);
        int i = 1;
        while (!queue.isEmpty() && i < vals.length) {
            TreeNode parent = queue.poll();
            if (!vals[i].equals("null")) {
                parent.left = new TreeNode(Integer.parseInt(vals[i]));
                queue.offer(parent.left);
            }
            i++;
            if (i < vals.length && !vals[i].equals("null")) {
                parent.right = new TreeNode(Integer.parseInt(vals[i]));
                queue.offer(parent.right);
            }
            i++;
        }
        return root;
    }
}
// Time: O(n), Space: O(n)
// Pattern combination: BFS for level-order traversal during serialization,
// queue-based reconstruction during deserialization ensures correct parent-child mapping.
```

---

### P22.25 [H] — Word Search II (Trie + Backtracking + DFS)

**LC 212. Word Search II**

**Patterns**: Trie for prefix pruning, backtracking on grid, DFS.

```java
class TrieNode {
    TrieNode[] children = new TrieNode[26];
    String word = null;  // store complete word at leaf for easy retrieval
}

public List<String> findWords(char[][] board, String[] words) {
    // Build trie
    TrieNode root = new TrieNode();
    for (String word : words) {
        TrieNode node = root;
        for (char c : word.toCharArray()) {
            int idx = c - 'a';
            if (node.children[idx] == null) node.children[idx] = new TrieNode();
            node = node.children[idx];
        }
        node.word = word;
    }

    List<String> result = new ArrayList<>();
    for (int i = 0; i < board.length; i++) {
        for (int j = 0; j < board[0].length; j++) {
            dfs(board, i, j, root, result);
        }
    }
    return result;
}

private void dfs(char[][] board, int r, int c, TrieNode node, List<String> result) {
    if (r < 0 || r >= board.length || c < 0 || c >= board[0].length) return;
    char ch = board[r][c];
    if (ch == '#' || node.children[ch - 'a'] == null) return;

    node = node.children[ch - 'a'];
    if (node.word != null) {
        result.add(node.word);
        node.word = null;  // avoid duplicates
    }

    board[r][c] = '#';  // mark visited
    dfs(board, r + 1, c, node, result);
    dfs(board, r - 1, c, node, result);
    dfs(board, r, c + 1, node, result);
    dfs(board, r, c - 1, node, result);
    board[r][c] = ch;  // restore
}
// Time: O(m × n × 4^L × W) worst case, but trie pruning makes it much better
// Space: O(sum of word lengths) for trie + O(L) for DFS stack
// Pattern combination: Trie enables O(1) prefix checking (vs re-searching each word),
// Backtracking explores all paths on the grid,
// DFS navigates the trie and grid simultaneously.
```

---

### P22.26 [H] — Minimum Interval to Include Each Query (Sorting + Heap)

**LC 1851. Minimum Interval to Include Each Query**

**Patterns**: Offline query processing (sort queries), sweep line with min-heap.

```java
public int[] minInterval(int[][] intervals, int[] queries) {
    // Sort intervals by start
    Arrays.sort(intervals, Comparator.comparingInt(a -> a[0]));

    // Sort queries but remember original indices
    int n = queries.length;
    int[][] indexedQueries = new int[n][2];
    for (int i = 0; i < n; i++) indexedQueries[i] = new int[]{queries[i], i};
    Arrays.sort(indexedQueries, Comparator.comparingInt(a -> a[0]));

    // Min-heap: [interval_size, interval_end]
    PriorityQueue<int[]> heap = new PriorityQueue<>(Comparator.comparingInt(a -> a[0]));
    int[] result = new int[n];
    Arrays.fill(result, -1);
    int j = 0;

    for (int[] q : indexedQueries) {
        int queryVal = q[0], queryIdx = q[1];
        // Add all intervals that start <= query
        while (j < intervals.length && intervals[j][0] <= queryVal) {
            int size = intervals[j][1] - intervals[j][0] + 1;
            heap.offer(new int[]{size, intervals[j][1]});
            j++;
        }
        // Remove intervals that ended before query
        while (!heap.isEmpty() && heap.peek()[1] < queryVal) {
            heap.poll();
        }
        if (!heap.isEmpty()) {
            result[queryIdx] = heap.peek()[0];
        }
    }
    return result;
}
// Time: O((n + q) log n) where n = intervals, q = queries
// Space: O(n + q)
// Pattern combination: sort intervals and queries together (sweep line),
// min-heap tracks active intervals sorted by size,
// lazy deletion removes expired intervals.
```

---

### P22.27 [H] — Critical Connections (Tarjan's Bridge Finding)

**LC 1192. Critical Connections in a Network**

**Patterns**: DFS + Tarjan's algorithm for bridges (low-link values).

```java
public List<List<Integer>> criticalConnections(int n, List<List<Integer>> connections) {
    List<List<Integer>> graph = new ArrayList<>();
    for (int i = 0; i < n; i++) graph.add(new ArrayList<>());
    for (List<Integer> conn : connections) {
        graph.get(conn.get(0)).add(conn.get(1));
        graph.get(conn.get(1)).add(conn.get(0));
    }

    int[] disc = new int[n], low = new int[n];
    Arrays.fill(disc, -1);
    List<List<Integer>> result = new ArrayList<>();
    int[] timer = {0};

    dfs(graph, 0, -1, disc, low, timer, result);
    return result;
}

private void dfs(List<List<Integer>> graph, int u, int parent,
                 int[] disc, int[] low, int[] timer, List<List<Integer>> result) {
    disc[u] = low[u] = timer[0]++;
    for (int v : graph.get(u)) {
        if (v == parent) continue;
        if (disc[v] == -1) {
            dfs(graph, v, u, disc, low, timer, result);
            low[u] = Math.min(low[u], low[v]);
            if (low[v] > disc[u]) {
                result.add(Arrays.asList(u, v));  // bridge found
            }
        } else {
            low[u] = Math.min(low[u], disc[v]);
        }
    }
}
// Time: O(V + E), Space: O(V + E)
// Key insight: edge (u,v) is a bridge iff low[v] > disc[u],
// meaning there is no back edge from v's subtree to u or above.
// Tarjan's algorithm computes disc[] and low[] in a single DFS pass.
```

---

### P22.28 [H] — Largest Rectangle in Histogram (Monotonic Stack)

**LC 84. Largest Rectangle in Histogram**

**Patterns**: Monotonic increasing stack for nearest smaller element on both sides.

```java
public int largestRectangleArea(int[] heights) {
    int n = heights.length;
    Deque<Integer> stack = new ArrayDeque<>();
    int maxArea = 0;

    for (int i = 0; i <= n; i++) {
        int currHeight = (i == n) ? 0 : heights[i];
        while (!stack.isEmpty() && currHeight < heights[stack.peek()]) {
            int height = heights[stack.pop()];
            int width = stack.isEmpty() ? i : i - stack.peek() - 1;
            maxArea = Math.max(maxArea, height * width);
        }
        stack.push(i);
    }
    return maxArea;
}
// Time: O(n), Space: O(n)
// Key insight: for each bar, the largest rectangle using that bar as the shortest
// bar extends from its nearest smaller bar on the left to its nearest smaller
// bar on the right. The monotonic stack finds both boundaries efficiently.
// Each bar is pushed once and popped once → O(n).
// The sentinel height 0 at i=n forces all remaining bars to be processed.
```

---

## 22.7 Mock Interview Walkthroughs

These walkthroughs simulate the full interview experience. Each includes the problem, clarifying questions, the design phase (with a suboptimal first approach and correction), the optimal solution, testing, and follow-up questions.

---

### Mock Interview 1: LRU Cache

**Problem**: Design a data structure that follows the constraints of a Least Recently Used (LRU) cache. Implement `LRUCache(int capacity)`, `int get(int key)`, and `void put(int key, int value)`. Both operations must run in O(1) time.

**[CLARIFY — Minutes 0-5]**

*Candidate*: "A few clarifying questions:
- What happens when I call `get` on a key that does not exist? Should I return -1?"
*Interviewer*: "Yes, return -1."
*Candidate*: "For `put`, if the key already exists, should I update the value and mark it as recently used?"
*Interviewer*: "Yes."
*Candidate*: "And if we exceed capacity, we evict the least recently used item?"
*Interviewer*: "Correct."
*Candidate*: "Can capacity be zero or negative?"
*Interviewer*: "Capacity is always at least 1."

**[DESIGN — Minutes 5-10]**

*Candidate*: "Let me think about the data structures needed. I need:
1. O(1) lookup by key — that is a HashMap.
2. O(1) insertion/removal by recency — that is a doubly linked list. I can move any node to the head in O(1) if I have a reference to it.

So the design is: HashMap<Integer, Node> where each Node contains key, value, prev, and next pointers. The doubly linked list maintains the access order — most recently used at the head, least recently used at the tail.

- `get(key)`: look up in HashMap, move node to head, return value.
- `put(key, value)`: if key exists, update value and move to head. If new, create node, add to head, put in HashMap. If over capacity, remove tail node, delete from HashMap.

Time: O(1) for both operations. Space: O(capacity)."

**[CODE — Minutes 10-35]**

```java
class LRUCache {
    private final int capacity;
    private final Map<Integer, Node> map;
    private final Node head, tail;  // sentinel nodes

    private static class Node {
        int key, value;
        Node prev, next;
        Node(int key, int value) {
            this.key = key;
            this.value = value;
        }
    }

    public LRUCache(int capacity) {
        this.capacity = capacity;
        this.map = new HashMap<>();
        this.head = new Node(0, 0);  // sentinel — simplifies edge cases
        this.tail = new Node(0, 0);  // sentinel
        head.next = tail;
        tail.prev = head;
    }

    public int get(int key) {
        if (!map.containsKey(key)) return -1;
        Node node = map.get(key);
        moveToHead(node);
        return node.value;
    }

    public void put(int key, int value) {
        if (map.containsKey(key)) {
            Node node = map.get(key);
            node.value = value;
            moveToHead(node);
        } else {
            Node newNode = new Node(key, value);
            map.put(key, newNode);
            addToHead(newNode);
            if (map.size() > capacity) {
                Node evicted = removeTail();
                map.remove(evicted.key);  // this is why Node stores key
            }
        }
    }

    private void addToHead(Node node) {
        node.prev = head;
        node.next = head.next;
        head.next.prev = node;
        head.next = node;
    }

    private void removeNode(Node node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }

    private void moveToHead(Node node) {
        removeNode(node);
        addToHead(node);
    }

    private Node removeTail() {
        Node last = tail.prev;
        removeNode(last);
        return last;
    }
}
```

**[TEST — Minutes 35-45]**

*Candidate*: "Let me trace through an example. Cache capacity = 2.
- `put(1, 1)`: list = [1], map = {1→Node(1,1)}
- `put(2, 2)`: list = [2, 1], map = {1→Node, 2→Node}
- `get(1)`: moves 1 to head. list = [1, 2]. Returns 1.
- `put(3, 3)`: capacity exceeded. Evict tail (key=2). list = [3, 1]. map = {1→Node, 3→Node}
- `get(2)`: not in map → return -1. Correct.
- `put(4, 4)`: evict tail (key=1). list = [4, 3]. map = {3→Node, 4→Node}

Edge cases:
- Capacity 1: every put evicts the previous entry.
- Getting a key right after putting it: should return the value.
- Putting the same key twice: updates value, no capacity change.

One thing I want to highlight: the Node stores the key specifically so that when we evict from the tail, we can look up and remove the corresponding HashMap entry. Without storing the key in the Node, we would need O(n) to find which key to remove."

**[FOLLOW-UP QUESTIONS]**

*Interviewer*: "How would you make this thread-safe?"

*Candidate*: "Several options:
1. **Synchronized wrapper**: wrap the entire data structure with `synchronized` on every method. Simple but high contention — all operations serialize.
2. **ReadWriteLock**: `get` acquires read lock, `put` acquires write lock. But `get` also modifies the list (moveToHead), so it needs a write lock too. This does not help much.
3. **ConcurrentHashMap + lock striping**: segment the cache into multiple LRU caches, each with its own lock. Route keys to segments via hash. This is what Guava Cache and Caffeine do internally.
4. **Lock-free approach**: use a ConcurrentLinkedDeque with CAS operations. Complex to implement correctly.

For production, I would just use Caffeine — it is a near-optimal concurrent LRU cache with O(1) operations and minimal contention. It uses a ring buffer to batch access recording and a timer wheel for expiration."

---

### Mock Interview 2: Word Ladder

**Problem**: Given two words `beginWord` and `endWord`, and a dictionary `wordList`, find the length of the shortest transformation sequence from `beginWord` to `endWord`, such that only one letter can be changed at a time and each transformed word must exist in the word list. Return 0 if no such transformation exists.

**[CLARIFY — Minutes 0-5]**

*Candidate*: "Let me clarify:
- All words have the same length?"
*Interviewer*: "Yes."
*Candidate*: "Must endWord be in the word list?"
*Interviewer*: "Yes, if it's not, return 0."
*Candidate*: "Are all words lowercase English letters?"
*Interviewer*: "Yes."
*Candidate*: "What is the size of the word list?"
*Interviewer*: "Up to 5000 words, each up to 10 characters long."
*Candidate*: "So up to 5000 nodes in a graph, with edges between words differing by one letter. The shortest path — this is BFS on an unweighted graph."

**[DESIGN — Minutes 5-10]**

*Candidate*: "My first thought is to model this as a graph problem. Each word is a node. An edge exists between two words if they differ by exactly one character.

**Approach 1 (naive)**: Compare every pair of words — O(n^2 × L) to build the graph, then BFS. With 5000 words, that is 25 million comparisons. Workable but not great.

**Approach 2 (better)**: For each word, generate all possible one-letter variants. For 'hot', generate '*ot', 'h*t', 'ho*' — use these as intermediate nodes. This gives O(n × L) graph construction.

Actually, the simplest approach for BFS: for the current word, try changing each position to each of 26 letters, and check if the result is in the word set. With L=10, that is 26 × 10 = 260 lookups per word — fast with a HashSet.

Let me go with BFS + character replacement. Time: O(n × L × 26) = O(n × L). Space: O(n × L) for the queue and visited set."

**[CODE — Minutes 10-35]**

```java
public int ladderLength(String beginWord, String endWord, List<String> wordList) {
    Set<String> wordSet = new HashSet<>(wordList);
    if (!wordSet.contains(endWord)) return 0;

    Queue<String> queue = new LinkedList<>();
    queue.offer(beginWord);
    wordSet.remove(beginWord);  // acts as visited set
    int level = 1;

    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            String word = queue.poll();
            char[] chars = word.toCharArray();
            for (int j = 0; j < chars.length; j++) {
                char original = chars[j];
                for (char c = 'a'; c <= 'z'; c++) {
                    if (c == original) continue;
                    chars[j] = c;
                    String next = new String(chars);
                    if (next.equals(endWord)) return level + 1;
                    if (wordSet.contains(next)) {
                        queue.offer(next);
                        wordSet.remove(next);  // mark visited
                    }
                }
                chars[j] = original;  // restore
            }
        }
        level++;
    }
    return 0;
}
```

**[TEST — Minutes 35-40]**

*Candidate*: "Tracing: beginWord='hit', endWord='cog', wordList=['hot','dot','dog','lot','log','cog']
- Level 1: queue = [hit]
  - hit → *it, h*t, hi* → try all 26 letters each position
  - hit → hot (in set) → add to queue, remove from set
- Level 2: queue = [hot]
  - hot → dot (found), lot (found)
- Level 3: queue = [dot, lot]
  - dot → dog (found)
  - lot → log (found)
- Level 4: queue = [dog, log]
  - dog → cog = endWord! Return 4 + 1 = 5.

Answer: 5 (hit → hot → dot → dog → cog). Correct."

**[FOLLOW-UP — Minutes 40-45]**

*Interviewer*: "Can you optimize this further?"

*Candidate*: "Yes — **bidirectional BFS**. Start BFS from both beginWord and endWord simultaneously. Expand the smaller frontier at each step. They meet in the middle.

Standard BFS explores O(b^d) nodes where b is branching factor and d is depth. Bidirectional BFS explores O(2 × b^(d/2)) = O(b^(d/2)) nodes — exponentially less.

Implementation: maintain two sets (frontiers). At each step, expand the smaller set. When a word generated from one frontier appears in the other, we have found the shortest path."

```java
public int ladderLengthBidirectional(String beginWord, String endWord, List<String> wordList) {
    Set<String> wordSet = new HashSet<>(wordList);
    if (!wordSet.contains(endWord)) return 0;

    Set<String> frontA = new HashSet<>(), frontB = new HashSet<>();
    frontA.add(beginWord);
    frontB.add(endWord);
    wordSet.remove(beginWord);
    wordSet.remove(endWord);
    int level = 1;

    while (!frontA.isEmpty() && !frontB.isEmpty()) {
        // Always expand the smaller frontier
        if (frontA.size() > frontB.size()) {
            Set<String> temp = frontA; frontA = frontB; frontB = temp;
        }
        Set<String> nextFront = new HashSet<>();
        for (String word : frontA) {
            char[] chars = word.toCharArray();
            for (int j = 0; j < chars.length; j++) {
                char orig = chars[j];
                for (char c = 'a'; c <= 'z'; c++) {
                    chars[j] = c;
                    String next = new String(chars);
                    if (frontB.contains(next)) return level + 1;
                    if (wordSet.contains(next)) {
                        nextFront.add(next);
                        wordSet.remove(next);
                    }
                }
                chars[j] = orig;
            }
        }
        frontA = nextFront;
        level++;
    }
    return 0;
}
```

---

### Mock Interview 3: Find Median from Data Stream

**Problem**: Design a data structure that supports `addNum(int num)` to add a number from the data stream, and `findMedian()` to return the median of all elements added so far. `findMedian` must run in O(1) time.

**[CLARIFY — Minutes 0-5]**

*Candidate*: "A few questions:
- Can numbers be negative?"
*Interviewer*: "Yes, full integer range."
*Candidate*: "Can I assume `findMedian` is only called after at least one `addNum`?"
*Interviewer*: "Yes."
*Candidate*: "What about the return type for median — should it be a double? For even count, the median is the average of two middle values?"
*Interviewer*: "Yes, return a double."
*Candidate*: "What is the expected number of operations?"
*Interviewer*: "Up to 50,000 addNum calls, followed by findMedian."

**[DESIGN — Minutes 5-10]**

*Candidate*: "**Naive approach**: Keep a sorted list. `addNum` inserts in sorted position — O(n) using binary search for position + O(n) for shifting. `findMedian` is O(1). Total: O(n) per add.

**Better approach**: Two heaps.
- `maxHeap` stores the smaller half (top = largest of the smaller half)
- `minHeap` stores the larger half (top = smallest of the larger half)
- The median is always at the top of one or both heaps.

Balance invariant: `maxHeap.size()` = `minHeap.size()` or `maxHeap.size()` = `minHeap.size() + 1`.

`addNum`: O(log n), `findMedian`: O(1). This is optimal."

**[CODE — Minutes 10-35]**

```java
class MedianFinder {
    private PriorityQueue<Integer> maxHeap; // smaller half (max at top)
    private PriorityQueue<Integer> minHeap; // larger half (min at top)

    public MedianFinder() {
        maxHeap = new PriorityQueue<>(Collections.reverseOrder());
        minHeap = new PriorityQueue<>();
    }

    public void addNum(int num) {
        maxHeap.offer(num);
        // Balance: move max of smaller half to larger half
        minHeap.offer(maxHeap.poll());
        // Ensure maxHeap has equal or one more element
        if (minHeap.size() > maxHeap.size()) {
            maxHeap.offer(minHeap.poll());
        }
    }

    public double findMedian() {
        if (maxHeap.size() > minHeap.size()) {
            return maxHeap.peek();
        }
        return (maxHeap.peek() + minHeap.peek()) / 2.0;
    }
}
// Time: addNum O(log n), findMedian O(1)
// Space: O(n)
```

**[TEST — Minutes 35-40]**

*Candidate*: "Let me trace:
- `addNum(1)`: maxHeap=[1], minHeap=[] → median=1
- `addNum(2)`: maxHeap offer 2→[2,1], poll→2 to minHeap. maxHeap=[1], minHeap=[2]. Sizes equal. median=(1+2)/2.0=1.5
- `addNum(3)`: maxHeap offer 3→[3,1], poll→3 to minHeap. minHeap=[2,3] size > maxHeap[1]. Rebalance: maxHeap=[2,1], minHeap=[3]. median=2. Correct.
- `addNum(0)`: maxHeap offer 0→[2,1,0], poll→2 to minHeap. minHeap=[2,3], maxHeap=[1,0]. Sizes equal. median=(1+2)/2.0=1.5. Sorted: [0,1,2,3], median=(1+2)/2=1.5. Correct."

**[FOLLOW-UP — Minutes 40-45]**

*Interviewer*: "What if the data stream is too large to fit in memory?"

*Candidate*: "Great question. Several approaches:

1. **If we know the value range**: Use counting sort / frequency array. For integers in [-10^5, 10^5], a frequency array of size 200,001. Finding the median is O(range) scan. Very memory efficient.

2. **If the range is unknown but data is on disk**: External sort. Sort chunks that fit in memory, write to disk, merge-sort, then find the middle element by counting.

3. **Approximate median**: Use a **t-digest** or **Q-digest** data structure. These provide approximate quantile queries with bounded error using O(1/epsilon) space. Apache Spark and Druid use t-digests for approximate percentile calculations over distributed data.

4. **Reservoir sampling + sorting**: Maintain a sample of k elements. The median of the sample approximates the true median. Error decreases as k increases.

For exact median on distributed data, the standard approach is: binary search on the answer. If you know the value range, binary search for a value x such that count(elements <= x) = n/2. Each count query can be answered in parallel across shards."

---

### Mock Interview 4: Alien Dictionary

**Problem**: Given a list of words sorted in an alien language's lexicographic order, derive the ordering of characters in the alien alphabet. Return the characters in order. If the order is invalid, return an empty string. If there are multiple valid orderings, return any.

**[CLARIFY — Minutes 0-5]**

*Candidate*: "Let me clarify:
- The words list is sorted according to the alien language's rules?"
*Interviewer*: "Yes."
*Candidate*: "Can there be characters that do not appear in any comparison — meaning their order is ambiguous?"
*Interviewer*: "Yes, they can appear anywhere in your result."
*Candidate*: "What makes the order invalid?"
*Interviewer*: "A cycle in the character ordering, or a prefix conflict — like 'abc' appearing before 'ab' in the list."
*Candidate*: "Got it. So 'abc' before 'ab' is invalid because a shorter word should come first if it is a prefix. And a cycle like a < b < c < a is also invalid."

**[DESIGN — Minutes 5-10]**

*Candidate*: "This is a topological sort problem. Each unique character is a node. I compare adjacent words to derive ordering edges. For two adjacent words, I find the first position where they differ — that gives me an edge: `word1[pos]` comes before `word2[pos]` in the alien alphabet.

Steps:
1. Build a directed graph from adjacent word comparisons.
2. Check for the prefix invalidity (word1 is longer but word2 is a prefix of word1).
3. Run topological sort (Kahn's BFS). If the result includes all characters, return it. If there is a cycle (not all characters processed), return empty string.

Time: O(total characters across all words). Space: O(unique characters)."

**[CODE — Minutes 10-35]**

```java
public String alienOrder(String[] words) {
    // Step 1: Initialize graph — all unique characters
    Map<Character, Set<Character>> graph = new HashMap<>();
    Map<Character, Integer> inDegree = new HashMap<>();
    for (String word : words) {
        for (char c : word.toCharArray()) {
            graph.putIfAbsent(c, new HashSet<>());
            inDegree.putIfAbsent(c, 0);
        }
    }

    // Step 2: Build edges from adjacent word comparisons
    for (int i = 0; i < words.length - 1; i++) {
        String w1 = words[i], w2 = words[i + 1];
        // Prefix check: "abc" before "ab" is invalid
        if (w1.length() > w2.length() && w1.startsWith(w2)) {
            return "";
        }
        int minLen = Math.min(w1.length(), w2.length());
        for (int j = 0; j < minLen; j++) {
            char from = w1.charAt(j), to = w2.charAt(j);
            if (from != to) {
                if (!graph.get(from).contains(to)) {
                    graph.get(from).add(to);
                    inDegree.merge(to, 1, Integer::sum);
                }
                break;  // only the first difference matters
            }
        }
    }

    // Step 3: Kahn's topological sort
    Queue<Character> queue = new LinkedList<>();
    for (Map.Entry<Character, Integer> entry : inDegree.entrySet()) {
        if (entry.getValue() == 0) queue.offer(entry.getKey());
    }

    StringBuilder result = new StringBuilder();
    while (!queue.isEmpty()) {
        char c = queue.poll();
        result.append(c);
        for (char neighbor : graph.get(c)) {
            inDegree.merge(neighbor, -1, Integer::sum);
            if (inDegree.get(neighbor) == 0) queue.offer(neighbor);
        }
    }

    // If not all characters are in result, there is a cycle
    if (result.length() < inDegree.size()) return "";
    return result.toString();
}
```

**[TEST — Minutes 35-40]**

*Candidate*: "Tracing with words = ['wrt', 'wrf', 'er', 'ett', 'rftt']:
- Compare 'wrt' vs 'wrf': first diff at index 2 → t < f
- Compare 'wrf' vs 'er': first diff at index 0 → w < e
- Compare 'er' vs 'ett': first diff at index 1 → r < t
- Compare 'ett' vs 'rftt': first diff at index 0 → e < r

Graph: t→f, w→e, r→t, e→r
In-degrees: w:0, e:1, r:1, t:1, f:1
Queue starts: [w]
Process w → neighbors [e] → e in-degree=0 → queue=[e]
Process e → neighbors [r] → r in-degree=0 → queue=[r]
Process r → neighbors [t] → t in-degree=0 → queue=[t]
Process t → neighbors [f] → f in-degree=0 → queue=[f]
Result: 'wertf'. All 5 characters included. Valid.

Edge case — cycle: words = ['a', 'b', 'a'] → a < b and b < a → cycle → return empty."

**[FOLLOW-UP — Minutes 40-45]**

*Interviewer*: "What if you needed to return all valid orderings?"

*Candidate*: "That would be enumerating all valid topological orderings — a backtracking problem. At each step, instead of picking one zero in-degree node, I try all of them and backtrack. The number of valid orderings can be exponential, but for a small alphabet (26 characters), it is manageable.

In the standard interview problem, any single valid ordering suffices, so Kahn's BFS is the right tool."

---

### Mock Interview 5: Trapping Rain Water

**Problem**: Given `n` non-negative integers representing an elevation map where the width of each bar is 1, compute how much water it can trap after raining.

**[CLARIFY — Minutes 0-5]**

*Candidate*: "The height array represents bars of width 1, and I need to compute the total water trapped between them?"
*Interviewer*: "Yes."
*Candidate*: "Can the array be empty?"
*Interviewer*: "Yes, return 0 in that case."
*Candidate*: "What is the maximum array size?"
*Interviewer*: "Up to 2 × 10^4 elements, heights up to 10^5."
*Candidate*: "Got it. Let me think about multiple approaches."

**[DESIGN — Minutes 5-10]**

*Candidate*: "I see four approaches, each improving on the previous:

**Approach 1 — Brute force O(n^2)**: For each index, find the max height to its left and right. Water at index i = min(maxLeft, maxRight) - height[i]. Finding max left/right takes O(n) per index.

**Approach 2 — Prefix arrays O(n) time, O(n) space**: Precompute maxLeft[] and maxRight[] arrays. Then water at i = min(maxLeft[i], maxRight[i]) - height[i]. Two passes.

**Approach 3 — Two pointers O(n) time, O(1) space**: Use two pointers from both ends. The key insight: if maxLeft < maxRight, the water at the left pointer is determined by maxLeft (it cannot overflow left because maxRight is higher). Similarly for the right side.

**Approach 4 — Stack O(n) time, O(n) space**: Use a monotonic decreasing stack. When we see a bar taller than the stack top, it creates a 'pool' — calculate the trapped water layer by layer.

I'll implement the two-pointer approach since it has optimal time and space. Let me also code the prefix approach as comparison."

**[CODE — Minutes 10-35]**

```java
// Approach 2: Prefix arrays — O(n) time, O(n) space
public int trapPrefix(int[] height) {
    int n = height.length;
    if (n <= 2) return 0;

    int[] maxLeft = new int[n], maxRight = new int[n];
    maxLeft[0] = height[0];
    for (int i = 1; i < n; i++) {
        maxLeft[i] = Math.max(maxLeft[i - 1], height[i]);
    }
    maxRight[n - 1] = height[n - 1];
    for (int i = n - 2; i >= 0; i--) {
        maxRight[i] = Math.max(maxRight[i + 1], height[i]);
    }

    int water = 0;
    for (int i = 0; i < n; i++) {
        water += Math.min(maxLeft[i], maxRight[i]) - height[i];
    }
    return water;
}

// Approach 3: Two pointers — O(n) time, O(1) space
public int trap(int[] height) {
    if (height == null || height.length <= 2) return 0;

    int left = 0, right = height.length - 1;
    int maxLeft = 0, maxRight = 0;
    int water = 0;

    while (left < right) {
        if (height[left] <= height[right]) {
            if (height[left] >= maxLeft) {
                maxLeft = height[left];  // new boundary, no water here
            } else {
                water += maxLeft - height[left];  // water fills to maxLeft level
            }
            left++;
        } else {
            if (height[right] >= maxRight) {
                maxRight = height[right];
            } else {
                water += maxRight - height[right];
            }
            right--;
        }
    }
    return water;
}

// Approach 4: Monotonic stack — O(n) time, O(n) space
public int trapStack(int[] height) {
    Deque<Integer> stack = new ArrayDeque<>();
    int water = 0;

    for (int i = 0; i < height.length; i++) {
        while (!stack.isEmpty() && height[i] > height[stack.peek()]) {
            int bottom = stack.pop();
            if (stack.isEmpty()) break;  // no left boundary
            int width = i - stack.peek() - 1;
            int bounded = Math.min(height[i], height[stack.peek()]) - height[bottom];
            water += width * bounded;
        }
        stack.push(i);
    }
    return water;
}
```

**[TEST — Minutes 35-40]**

*Candidate*: "Testing two-pointer approach with height = [0,1,0,2,1,0,1,3,2,1,2,1]:
- Expected answer: 6.
- left=0, right=11. height[0]=0 <= height[11]=1. maxLeft=0. height[0]=0 < maxLeft=0? No, update maxLeft=0. left=1.
- left=1. height[1]=1 <= height[11]=1. maxLeft becomes 1. left=2.
- left=2. height[2]=0 < maxLeft=1. water += 1-0 = 1. left=3.
- left=3. height[3]=2 > height[11]=1. Go right side. maxRight becomes 1. right=10.
- right=10. height[10]=2 > maxRight=1. maxRight=2. right=9.
- right=9. height[9]=1 < maxRight=2. water += 2-1 = 1. Total=2. right=8.
- ... continuing... final answer is 6. Correct.

Edge cases:
- Empty array → 0
- Ascending [1,2,3] → 0 (no trap)
- Descending [3,2,1] → 0 (no trap)
- Single valley [2,0,2] → 2"

**[FOLLOW-UP — Minutes 40-45]**

*Interviewer*: "Which approach would you use in production?"

*Candidate*: "It depends on context:
- **Two pointers** for minimum memory usage — O(1) space is unbeatable. Best for embedded systems or when processing a stream where you cannot store the full array.
- **Prefix arrays** for clarity and maintainability — easiest to understand and debug. Good for code that will be maintained by a team.
- **Stack approach** when this is part of a larger histogram-based problem (like maximal rectangle in a matrix).

For production code, I would also add input validation, potentially parallelize for very large arrays (split into chunks, handle boundaries), and add unit tests for the edge cases we discussed.

I would note that this problem is analogous to real systems: computing buffer utilization between high-traffic spikes, or determining capacity requirements between peak usage periods."

---

## 22.8 Final Advice

### Practice Schedule

If you have 4-6 weeks before your interview:

```
Week 1-2: FOUNDATIONS (2-3 problems/day)
  - Arrays, strings, HashMap patterns
  - Binary search variations
  - Sliding window, two pointers
  - Stack and queue problems
  Focus: get the patterns into muscle memory

Week 3-4: INTERMEDIATE (2-3 problems/day)
  - Trees: DFS, BFS, path problems
  - Graphs: BFS, DFS, topological sort, Union-Find
  - Dynamic programming: 1D, 2D, knapsack variants
  - Heap problems: top-k, merge-k, median
  Focus: pattern recognition speed

Week 5-6: ADVANCED + MOCK (2 problems/day + 1 mock/day)
  - Hard problems combining multiple patterns
  - Design problems (LRU cache, iterator, randomized set)
  - Full mock interviews with timer
  Focus: execution under pressure, communication
```

### Focus on Patterns, Not Solutions

If you memorize the solution to "Trapping Rain Water," you can solve exactly one problem. If you understand the *monotonic stack pattern*, you can solve Trapping Rain Water, Largest Rectangle in Histogram, Daily Temperatures, Next Greater Element, and dozens of variants.

The 14 core patterns from our flowchart cover approximately 90% of interview problems:

```
1.  HashMap / HashSet lookup          8.  Heap (priority queue)
2.  Two Pointers                      9.  Stack / Monotonic Stack
3.  Sliding Window                    10. Topological Sort
4.  Binary Search                     11. Union-Find
5.  BFS / DFS (tree)                  12. Trie
6.  BFS / DFS (graph)                 13. Segment Tree / Fenwick Tree
7.  Dynamic Programming               14. Backtracking
```

For each pattern, you should be able to:
- Recognize when it applies (problem characteristics)
- Write the template from memory (the skeleton code)
- Identify common variations (standard vs boundary binary search, BFS vs bidirectional BFS)
- State the time and space complexity

### For 40 LPA: Depth Is Your Differentiator

At this compensation level, every candidate can solve Medium LeetCode problems. What separates "hire" from "strong hire" is *depth*.

**Surface-level answer**: "I'll use a HashMap."
**Deep answer**: "I'll use a HashMap for O(1) amortized lookups. The load factor is 0.75 by default, so with n elements, the table will have about 1.33n slots. Each Node costs 32 bytes with compressed OOPs. For this problem size of 10^5, total HashMap memory is about 5MB — well within limits. If the key distribution were adversarial, Java 8+ treeifies buckets at 8 entries, guaranteeing O(log n) worst case per operation."

You do not need to say all of that every time. But dropping one or two JVM-level observations per problem signals to the interviewer that you are not a LeetCode grinder who memorized solutions — you are a systems engineer who *understands* the tools.

### Your Systems Experience IS Your Advantage

You have 15 years of building real systems. Use that.

- When discussing BFS, mention that it is analogous to how distributed systems propagate updates (gossip protocol).
- When discussing caching with LRU, mention that this is what your application's Redis layer does, and you have tuned eviction policies in production.
- When discussing graph algorithms, mention that dependency resolution in build systems (Maven, Gradle) uses topological sort.
- When discussing concurrent data structures, mention that you have debugged race conditions in production ConcurrentHashMaps.
- When discussing memory efficiency, mention that you have used JOL to measure object sizes and tuned GC parameters to reduce pause times.

The interviewer is not just checking if you can code a BFS. They are checking if you can *think* like a senior engineer while coding a BFS.

---

## Problems Summary

| #      | Difficulty | Problem                                | Patterns Combined                        |
|--------|------------|----------------------------------------|------------------------------------------|
| P22.01 | E          | Two Sum                                | HashMap lookup                           |
| P22.02 | E          | Valid Parentheses                      | Stack matching                           |
| P22.03 | E          | Merge Two Sorted Lists                 | Two pointers, linked list                |
| P22.04 | E          | Binary Search                          | Binary search template                   |
| P22.05 | E          | Maximum Depth of Binary Tree           | DFS recursion                            |
| P22.06 | E          | Invert Binary Tree                     | DFS transformation                       |
| P22.07 | E          | Climbing Stairs                        | DP (Fibonacci)                           |
| P22.08 | E          | Flood Fill                             | DFS grid traversal                       |
| P22.09 | M          | Longest Substring Without Repeating    | Sliding window + HashMap                 |
| P22.10 | M          | 3Sum                                   | Sorting + two pointers + dedup           |
| P22.11 | M          | Number of Islands                      | DFS grid + connected components          |
| P22.12 | M          | Coin Change                            | DP (unbounded knapsack)                  |
| P22.13 | M          | Course Schedule                        | Topological sort + cycle detection       |
| P22.14 | M          | Kth Largest Element                    | Heap / QuickSelect                       |
| P22.15 | M          | Minimum Window Substring               | Sliding window + HashMap + counter       |
| P22.16 | M          | Rotting Oranges                        | Multi-source BFS                         |
| P22.17 | M          | Task Scheduler                         | Greedy + frequency math                  |
| P22.18 | M          | Accounts Merge                         | Union-Find + HashMap + sorting           |
| P22.19 | M          | Koko Eating Bananas                    | Binary search on answer + greedy         |
| P22.20 | M          | Longest Increasing Subsequence         | DP + binary search                       |
| P22.21 | M          | Word Search                            | Backtracking + DFS on grid               |
| P22.22 | M          | Daily Temperatures                     | Monotonic stack                          |
| P22.23 | H          | Merge K Sorted Lists                   | Heap + linked list                       |
| P22.24 | H          | Serialize/Deserialize Binary Tree      | BFS + design + encoding                  |
| P22.25 | H          | Word Search II                         | Trie + backtracking + DFS                |
| P22.26 | H          | Minimum Interval to Include Query      | Sorting + heap + offline processing      |
| P22.27 | H          | Critical Connections                   | Tarjan's bridges (DFS + low-link)        |
| P22.28 | H          | Largest Rectangle in Histogram         | Monotonic stack                          |
| P22.29 | H          | LRU Cache                              | HashMap + doubly linked list + design    |
| P22.30 | H          | Trapping Rain Water                    | Two pointers / prefix / stack (multiple) |

**Distribution: 8 Easy, 14 Medium, 8 Hard**

---

## Key Takeaways

1. **Structure your 45 minutes**: CLARIFY (5 min) → DESIGN (5 min) → CODE (25 min) → TEST (10 min). Skipping any phase costs you more time than it saves. The CLARIFY phase alone prevents the most common failure mode — solving the wrong problem.

2. **Pattern recognition is the meta-skill**: Every hard problem is a combination of 2-3 patterns. The flowchart in Section 22.2 maps problem characteristics to patterns. Train yourself to identify "sorted array → binary search," "optimal subarray → sliding window," "overlapping subproblems → DP" within the first 30 seconds of reading a problem.

3. **Communicate your thought process**: At the 40 LPA level, how you think matters as much as what you code. State your approach, your complexity analysis, and your trade-offs *before* writing code. Silence is your enemy — narrate while coding.

4. **Signal depth through JVM awareness**: When choosing a data structure, mention one concrete fact about its JVM behavior — memory layout, cache implications, GC impact, or concurrency characteristics. This separates you from candidates who only know the API.

5. **Handle edge cases systematically**: null/empty input, single element, all duplicates, negative numbers, integer overflow, maximum constraints. Check these during CLARIFY and TEST phases. Add guard clauses at the top of your code.

6. **Beware the senior engineer traps**: Overengineering, premature optimization, and jumping to code without design are the three most common failure modes for experienced developers. Your production habits of building extensible systems work against you in a 45-minute interview. Be direct and specific.

7. **Integer overflow is the silent killer**: Use `a + (b - a) / 2` for midpoints. Use `long` for sum accumulators. Use `Integer.compare()` for comparators. These three rules prevent 90% of overflow bugs in interviews.

8. **Practice combining patterns, not just individual ones**: Easy problems test one pattern. Medium problems test two. Hard problems test three or more, plus the ability to *identify* which patterns are needed. The synthesis problems in Section 22.6 and mock interviews in Section 22.7 train exactly this skill.

9. **Your 15 years of systems experience is your greatest asset**: Connect every algorithm to a real-world system you have built or maintained. BFS is gossip protocol propagation. Topological sort is build dependency resolution. LRU cache is your Redis eviction policy. The interviewer wants to hire a senior engineer, not a competitive programmer.

10. **First make it work, then make it right, then make it fast**: A correct O(n log n) solution with clean code and good communication will get you the offer. A buggy O(n) solution with no explanation will not. Correctness is non-negotiable; optimization is a bonus.

---

*"The purpose of a senior engineering interview is not to determine if you can solve puzzles under pressure. It is to determine if you can think clearly about hard problems, communicate your reasoning, and build solutions that work — under any conditions. Every chapter in this book has prepared you for exactly that."*

---

[Previous: Chapter 21 — System Design Meets DSA](21-system-design-meets-dsa.md)
