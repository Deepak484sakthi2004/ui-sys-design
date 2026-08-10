# Chapter 17: Patterns — Dynamic Programming

## The Art of Remembering What You Have Already Computed

Dynamic programming is not a data structure. It is not an algorithm. It is a *paradigm* -- a way of thinking about problems that transforms exponential brute force into polynomial elegance by recognizing that most recursive computations solve the same subproblems over and over again. If you have ever tuned a database query by materializing an intermediate view instead of recomputing it on every join, you already understand the soul of DP. If you have ever cached an expensive service call behind Redis so that the next thousand requests hit O(1) instead of O(n), you have applied memoization in production.

And yet, dynamic programming is the single most feared topic in technical interviews. Not because it is inherently harder than graph algorithms or system design -- but because it requires a different mode of thinking. You cannot "template" your way through DP the way you can with BFS or binary search. Each problem demands that you identify the *right subproblem*, define the *right state*, and discover the *right transition*. The templates I will give you in this chapter are scaffolding, not solutions.

Here is what this chapter delivers. Nine DP sub-patterns, each with a precise methodology for identifying the subproblem structure, defining states, writing transitions, and choosing between top-down memoization and bottom-up tabulation. Ninety problems that span the full difficulty range, each with a complete Java solution, complexity analysis, JVM-level insight, and a real-world system correlation. By the end of this chapter, you will not just "know DP" -- you will recognize it instantly in interview problems, production caches, build systems, compiler optimizers, network routing protocols, and bioinformatics pipelines.

Let us begin with the foundations.

---

## 17.1 DP Foundations: The Two Properties That Make It Work

Every DP problem exhibits two properties. If both are present, DP applies. If either is missing, it does not.

### Property 1: Overlapping Subproblems

The recursive solution to the problem solves the same subproblems multiple times. The classic example is Fibonacci:

```
fib(5)
├── fib(4)
│   ├── fib(3)
│   │   ├── fib(2) ★
│   │   └── fib(1)
│   └── fib(2) ★
└── fib(3)
    ├── fib(2) ★
    └── fib(1)
```

`fib(2)` is computed three times. `fib(3)` is computed twice. Without memoization, the call tree has O(2^n) nodes. With memoization, each unique subproblem is computed exactly once: O(n) total.

**Contrast with divide-and-conquer**: Merge sort also decomposes a problem recursively, but each subarray is unique -- there are no overlapping subproblems. That is why merge sort is divide-and-conquer, not DP.

### Property 2: Optimal Substructure

The optimal solution to the problem can be constructed from optimal solutions to its subproblems. More formally: if you have the optimal answer for smaller inputs, you can combine them to get the optimal answer for the larger input.

**Example**: Shortest path from A to D passing through B. If the shortest path from A to D goes through B, then the sub-path from A to B must itself be the shortest path from A to B. If it were not, you could replace it with the actual shortest A-to-B path and get a shorter A-to-D path -- contradiction.

**Counter-example**: Longest simple path in a graph does NOT have optimal substructure. The longest path from A to D through B does not necessarily use the longest path from A to B, because the longest A-to-B path might consume vertices that the B-to-D portion needs.

### The Two Implementation Strategies

#### Top-Down Memoization: Recursive + Cache

```java
// Template: top-down memoization with HashMap
private Map<StateKey, Integer> memo = new HashMap<>();

public int solve(StateKey state) {
    // Base case
    if (isBaseCase(state)) return baseCaseValue(state);
    
    // Check memo
    if (memo.containsKey(state)) return memo.get(state);
    
    // Compute: try all transitions, pick the best
    int result = /* combine subproblem solutions */;
    
    memo.put(state, result);
    return result;
}
```

```java
// Template: top-down memoization with array (when state is integer-indexable)
private int[] memo;  // or int[][] for 2D state

public int solve(int i) {
    if (i <= 0) return baseCase;
    if (memo[i] != -1) return memo[i];  // -1 as sentinel
    
    memo[i] = /* recurrence */;
    return memo[i];
}
```

**Advantages of top-down**:
- More intuitive -- you write the recurrence naturally, add caching
- Only computes states that are actually reachable (lazy evaluation)
- Easier to handle complex state spaces where many states are unreachable

**JVM considerations for top-down**:
- Recursion depth matters. Default JVM stack size is 512KB to 1MB per thread. Each stack frame for a recursive call is typically 32-64 bytes (local variables + operand stack + frame metadata). For `n = 10,000`, that is roughly 640KB -- borderline. For `n = 100,000`, you will hit `StackOverflowError`.
- Fix: `-Xss4m` increases thread stack size. But this is a band-aid; bottom-up avoids the issue entirely.
- `HashMap<Integer, Integer>` for memoization involves boxing. Each `Integer` is a 16-byte object. Each `HashMap.Node` is 32 bytes. For 100K entries: ~4.8 MB just for the cache structure. An `int[]` of the same size: 400 KB.
- Autoboxing in the hot path (`memo.containsKey(i)`, `memo.get(i)`, `memo.put(i, result)`) generates garbage on every cache miss. The JIT can sometimes eliminate this with escape analysis, but do not count on it.

#### Bottom-Up Tabulation: Iterative + Table

```java
// Template: bottom-up tabulation
public int solve(int n) {
    int[] dp = new int[n + 1];
    
    // Base cases
    dp[0] = baseCase0;
    dp[1] = baseCase1;
    
    // Fill table in topological order (smallest subproblems first)
    for (int i = 2; i <= n; i++) {
        dp[i] = /* recurrence using dp[i-1], dp[i-2], etc. */;
    }
    
    return dp[n];
}
```

**Advantages of bottom-up**:
- No recursion overhead (no stack frames, no `StackOverflowError`)
- Better cache behavior -- sequential array access is preferable for L1/L2 cache prefetchers
- Enables space optimization (often only need last 1-2 rows of the table)
- Easier to reason about time complexity -- every cell is filled exactly once

**JVM considerations for bottom-up**:
- Primitive arrays (`int[]`, `long[]`, `boolean[]`) are contiguous in memory. Sequential iteration gets hardware prefetcher benefits.
- For 2D DP: `int[n][m]` is a jagged array (array of arrays). Row-major iteration (`dp[i][j]` with `j` in the inner loop) gives sequential cache hits within each row. Column-major iteration causes cache misses on every access.
- Space optimization with rolling arrays: instead of `int[n][m]`, use `int[2][m]` and alternate rows with `dp[i % 2][j]`. Cuts memory from O(n*m) to O(m).

### State Reduction: From N-D to (N-1)-D

Many DP problems that appear to need a 2D table can be reduced to 1D:

```java
// 2D: dp[i][w] = max value using first i items with capacity w
// Transition: dp[i][w] = max(dp[i-1][w], dp[i-1][w-weight[i]] + value[i])
// Notice: row i depends ONLY on row i-1

// Reduce to 1D: iterate w from RIGHT to LEFT
int[] dp = new int[W + 1];
for (int i = 0; i < n; i++) {
    for (int w = W; w >= weight[i]; w--) {  // right-to-left!
        dp[w] = Math.max(dp[w], dp[w - weight[i]] + value[i]);
    }
}
```

The right-to-left iteration is crucial: it ensures we use `dp[w - weight[i]]` from the *previous* row (before it is overwritten), preserving 0/1 knapsack semantics. Left-to-right would allow using each item multiple times (unbounded knapsack).

### The DP Problem-Solving Framework

For every problem in this chapter, I follow this framework:

1. **Identify the subproblem**: What smaller version of the problem do I need to solve?
2. **Define the state**: What variables uniquely describe a subproblem? This becomes your DP table dimensions.
3. **Write the transition**: How does the current state relate to previously computed states?
4. **Determine base cases**: What are the smallest subproblems with known answers?
5. **Determine computation order**: Which states must be computed first? (For bottom-up, this is the iteration order.)
6. **Identify the answer**: Where in the table is the final answer?
7. **Optimize space**: Can I reduce the table dimensions?

Let us now apply this to nine distinct sub-patterns.

---

## 17.2 Sub-Pattern 1: 1D Linear DP

### What It Is

The simplest DP family. The input is a 1D sequence (array, string, number), and the state is a single index: `dp[i]` represents the answer for the first `i` elements (or the answer ending at index `i`). The transition looks backward at `dp[i-1]`, `dp[i-2]`, or in general `dp[j]` for some `j < i`.

### How to Identify the Subproblem Structure

Ask: "If I knew the optimal answer for the first `i-1` elements, can I extend it to the first `i` elements?" If yes, you are in 1D linear DP territory. The key insight is that the problem has a natural left-to-right processing order.

### State Definition and Transition

```
State:    dp[i] = answer considering elements 0..i-1 (or ending at index i)
Transition: dp[i] = f(dp[i-1], dp[i-2], ..., dp[0], input[i])
Base case:  dp[0] = initial value (often 0 or 1)
Answer:     dp[n] or max(dp[0..n-1])
```

### Template Code

```java
// Top-down memoization
private int[] memo;

public int solveTopDown(int[] nums) {
    int n = nums.length;
    memo = new int[n];
    Arrays.fill(memo, -1);
    return dp(nums, n - 1);
}

private int dp(int[] nums, int i) {
    if (i < 0) return 0;  // base case
    if (memo[i] != -1) return memo[i];
    
    // Transition: depends on the specific problem
    memo[i] = Math.max(
        dp(nums, i - 1),                       // skip element i
        dp(nums, i - 2) + nums[i]              // take element i
    );
    return memo[i];
}

// Bottom-up tabulation
public int solveBottomUp(int[] nums) {
    int n = nums.length;
    if (n == 0) return 0;
    if (n == 1) return nums[0];
    
    int[] dp = new int[n];
    dp[0] = nums[0];
    dp[1] = Math.max(nums[0], nums[1]);
    
    for (int i = 2; i < n; i++) {
        dp[i] = Math.max(dp[i - 1], dp[i - 2] + nums[i]);
    }
    return dp[n - 1];
}

// Space-optimized (O(1))
public int solveOptimized(int[] nums) {
    int n = nums.length;
    if (n == 0) return 0;
    if (n == 1) return nums[0];
    
    int prev2 = nums[0];
    int prev1 = Math.max(nums[0], nums[1]);
    
    for (int i = 2; i < n; i++) {
        int curr = Math.max(prev1, prev2 + nums[i]);
        prev2 = prev1;
        prev1 = curr;
    }
    return prev1;
}
```

### Real-World Correlation

**Build system dependency resolution**: When a build system like Gradle resolves task execution order, it essentially computes "what is the minimum cost to build up to module i?" where each module depends on previous modules. The 1D linear structure mirrors a sequential pipeline.

**TCP congestion window sizing**: The TCP window size at time step `t` depends on the window size at `t-1` and the acknowledgment status -- a 1D state-transition model that is fundamentally linear DP over time steps.

### Problems

---

**P17.1** [E] -- Climbing Stairs (LeetCode 70)

You are climbing a staircase with `n` steps. Each time you can climb 1 or 2 steps. In how many distinct ways can you reach the top?

This is literally Fibonacci in disguise. The number of ways to reach step `i` equals the number of ways to reach step `i-1` (then take 1 step) plus the number of ways to reach step `i-2` (then take 2 steps).

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
```

```
Time:  O(n)
Space: O(1)
```

**JVM insight**: For `n > 46`, the result overflows `int` (Fibonacci grows exponentially). Use `long` for `n` up to ~92, or `BigInteger` beyond that. In interviews, clarify the constraint range -- if `n <= 45` (LeetCode's constraint), `int` suffices.

**Real-world correlation**: **Combinatorial path counting** appears in network routing. The number of shortest paths between two nodes in a grid network follows the same recurrence -- it is the foundation of ECMP (Equal-Cost Multi-Path) routing in data center fabrics.

---

**P17.2** [E] -- Min Cost Climbing Stairs (LeetCode 746)

Given `cost[i]` = cost to step on stair `i`, find minimum cost to reach the top. You can start from step 0 or step 1.

```java
public int minCostClimbingStairs(int[] cost) {
    int n = cost.length;
    // dp[i] = minimum cost to reach step i
    // We want to reach step n (beyond the last stair)
    int prev2 = 0, prev1 = 0;  // can start at 0 or 1 for free
    for (int i = 2; i <= n; i++) {
        int curr = Math.min(prev1 + cost[i - 1], prev2 + cost[i - 2]);
        prev2 = prev1;
        prev1 = curr;
    }
    return prev1;
}
```

```
Time:  O(n)
Space: O(1)
```

**JVM insight**: The `Math.min` call is intrinsified by HotSpot -- it compiles to a single `cmov` instruction (conditional move) on x86, avoiding a branch prediction penalty. This matters in tight inner loops.

**Real-world correlation**: **Cost-optimized pipeline scheduling**. In CI/CD pipelines, each stage has a cost (time or compute). Finding the cheapest way to get from start to deploy, where some stages can be skipped, is exactly this problem.

---

**P17.3** [E] -- N-th Tribonacci Number (LeetCode 1137)

T(0) = 0, T(1) = 1, T(2) = 1. T(n) = T(n-1) + T(n-2) + T(n-3).

```java
public int tribonacci(int n) {
    if (n == 0) return 0;
    if (n <= 2) return 1;
    int a = 0, b = 1, c = 1;
    for (int i = 3; i <= n; i++) {
        int next = a + b + c;
        a = b;
        b = c;
        c = next;
    }
    return c;
}
```

```
Time:  O(n)
Space: O(1)
```

**JVM insight**: The JIT compiler will keep `a`, `b`, `c`, and `next` in registers for this tight loop -- no memory access needed. This is a textbook example of register allocation optimization. For very large `n`, the matrix exponentiation approach achieves O(log n) using 3x3 matrix multiplication, though the constant factor is higher.

---

**P17.4** [M] -- House Robber (LeetCode 198)

Rob houses along a street. Cannot rob two adjacent houses. Maximize total money.

```java
public int rob(int[] nums) {
    int n = nums.length;
    if (n == 0) return 0;
    if (n == 1) return nums[0];
    
    // dp[i] = max money robbing from houses 0..i
    // Either rob house i (add nums[i] + dp[i-2]) or skip it (dp[i-1])
    int prev2 = 0, prev1 = nums[0];
    for (int i = 1; i < n; i++) {
        int curr = Math.max(prev1, prev2 + nums[i]);
        prev2 = prev1;
        prev1 = curr;
    }
    return prev1;
}
```

```
Time:  O(n)
Space: O(1)
```

**JVM insight**: This is the exact template from Section 17.2. The transition `dp[i] = max(dp[i-1], dp[i-2] + nums[i])` is the canonical "include or exclude" 1D DP pattern. Notice that we need only the last two values, making space optimization trivial.

**Real-world correlation**: **Non-overlapping resource scheduling**. In cloud computing, allocating non-overlapping compute slots to maximize revenue follows this same "take or skip, no two adjacent" structure. AWS spot instance bidding involves similar optimization.

---

**P17.5** [M] -- House Robber II (LeetCode 213)

Same as House Robber, but houses are arranged in a circle (first and last are adjacent).

```java
public int rob(int[] nums) {
    int n = nums.length;
    if (n == 1) return nums[0];
    // Either skip house 0 (rob from 1..n-1) or skip house n-1 (rob from 0..n-2)
    return Math.max(robLinear(nums, 0, n - 2), robLinear(nums, 1, n - 1));
}

private int robLinear(int[] nums, int lo, int hi) {
    int prev2 = 0, prev1 = 0;
    for (int i = lo; i <= hi; i++) {
        int curr = Math.max(prev1, prev2 + nums[i]);
        prev2 = prev1;
        prev1 = curr;
    }
    return prev1;
}
```

```
Time:  O(n)
Space: O(1)
```

**JVM insight**: Calling `robLinear` twice scans the array twice. Since the array is already in L1 cache from the first scan, the second scan is virtually free in terms of cache misses -- a nice side effect of temporal locality.

**Real-world correlation**: **Circular buffer resource allocation**. Ring buffers (like those in LMAX Disruptor or Kafka partitions) have this same circular adjacency constraint when allocating non-overlapping segments.

---

**P17.6** [M] -- Decode Ways (LeetCode 91)

A message encoded as digits "1"-"26" maps to 'A'-'Z'. Given a digit string, count the number of ways to decode it.

```java
public int numDecodings(String s) {
    int n = s.length();
    if (n == 0 || s.charAt(0) == '0') return 0;
    
    // dp[i] = number of ways to decode s[0..i-1]
    int prev2 = 1;  // dp[0]: empty string, 1 way
    int prev1 = 1;  // dp[1]: single non-zero digit, 1 way
    
    for (int i = 2; i <= n; i++) {
        int curr = 0;
        int oneDigit = s.charAt(i - 1) - '0';
        int twoDigit = (s.charAt(i - 2) - '0') * 10 + oneDigit;
        
        if (oneDigit >= 1) curr += prev1;          // single digit decode
        if (twoDigit >= 10 && twoDigit <= 26) curr += prev2;  // two digit decode
        
        prev2 = prev1;
        prev1 = curr;
    }
    return prev1;
}
```

```
Time:  O(n)
Space: O(1)
```

**JVM insight**: `s.charAt(i)` on a `String` backed by a `byte[]` (compact strings, JDK 9+) is a single array access with bounds check. The JIT eliminates the bounds check when it can prove `i` is within range (loop variable bounded by `s.length()`). This makes the character access as fast as a primitive array lookup.

**Real-world correlation**: **Protocol decoding ambiguity**. Variable-length encoding schemes (like UTF-8, protobuf varint) face the same problem: given a byte stream, how many valid parses exist? The forward-reference constraint ("a byte's meaning depends on the previous byte") is exactly this DP structure.

---

**P17.7** [M] -- Delete and Earn (LeetCode 740)

Given an array, if you pick a value `k`, you earn `k` points but must delete all `k-1` and `k+1` instances. Maximize points.

```java
public int deleteAndEarn(int[] nums) {
    int max = 0;
    for (int num : nums) max = Math.max(max, num);
    
    // Aggregate: sum[k] = total points from all occurrences of k
    int[] sum = new int[max + 1];
    for (int num : nums) sum[num] += num;
    
    // Now it is exactly House Robber on the sum array!
    // Cannot take adjacent values (taking k means deleting k-1 and k+1)
    int prev2 = 0, prev1 = sum[0];
    for (int k = 1; k <= max; k++) {
        int curr = Math.max(prev1, prev2 + sum[k]);
        prev2 = prev1;
        prev1 = curr;
    }
    return prev1;
}
```

```
Time:  O(n + max(nums))
Space: O(max(nums))
```

**JVM insight**: The `sum` array allocation size depends on `max(nums)`. If `max(nums)` is 10^4 (LeetCode constraint), that is 40 KB -- fits in L1 cache. If the constraint were 10^9, you would need a `HashMap<Integer, Integer>` instead, trading O(1) array access for HashMap overhead.

**Real-world correlation**: **Cache eviction with proximity constraints**. In some cache replacement policies, evicting a page also invalidates nearby pages (e.g., prefetch groups). Maximizing hit rate under this constraint mirrors Delete and Earn.

---

**P17.8** [M] -- Word Break (LeetCode 139)

Given a string `s` and a dictionary `wordDict`, determine if `s` can be segmented into dictionary words.

```java
public boolean wordBreak(String s, List<String> wordDict) {
    Set<String> dict = new HashSet<>(wordDict);
    int n = s.length();
    
    // dp[i] = true if s[0..i-1] can be segmented into dictionary words
    boolean[] dp = new boolean[n + 1];
    dp[0] = true;  // empty string
    
    for (int i = 1; i <= n; i++) {
        for (int j = 0; j < i; j++) {
            if (dp[j] && dict.contains(s.substring(j, i))) {
                dp[i] = true;
                break;  // no need to check other j values
            }
        }
    }
    return dp[n];
}
```

```
Time:  O(n^2 × L) where L = average word length (for substring + hash)
Space: O(n + dictionary size)
```

**Optimization with max word length**:

```java
public boolean wordBreakOptimized(String s, List<String> wordDict) {
    Set<String> dict = new HashSet<>(wordDict);
    int n = s.length();
    int maxLen = 0;
    for (String w : wordDict) maxLen = Math.max(maxLen, w.length());
    
    boolean[] dp = new boolean[n + 1];
    dp[0] = true;
    
    for (int i = 1; i <= n; i++) {
        // Only check substrings up to maxLen characters back
        for (int j = Math.max(0, i - maxLen); j < i; j++) {
            if (dp[j] && dict.contains(s.substring(j, i))) {
                dp[i] = true;
                break;
            }
        }
    }
    return dp[n];
}
```

**JVM insight**: `s.substring(j, i)` in Java 7+ creates a new `String` object with a copy of the underlying character data (unlike Java 6 which shared the backing array). For each `(i, j)` pair, this allocates a new `byte[]` on the heap. With `n^2` pairs in the worst case, that is significant GC pressure. A Trie-based approach avoids substring creation entirely.

**Real-world correlation**: **Lexical analysis / tokenization**. Every compiler and interpreter faces exactly this problem: given a source string, can it be segmented into valid tokens? The Dragon Book's maximal munch algorithm is a greedy variant, but the DP approach handles ambiguous grammars. **NLP word segmentation** for languages without explicit word boundaries (Chinese, Japanese) uses this same DP formulation.

---

**P17.9** [M] -- Jump Game (LeetCode 55)

Given an array where `nums[i]` = maximum jump length from position `i`, determine if you can reach the last index.

```java
// Greedy approach (optimal for this problem)
public boolean canJump(int[] nums) {
    int maxReach = 0;
    for (int i = 0; i < nums.length; i++) {
        if (i > maxReach) return false;  // can't reach position i
        maxReach = Math.max(maxReach, i + nums[i]);
        if (maxReach >= nums.length - 1) return true;
    }
    return true;
}

// DP approach (for learning)
public boolean canJumpDP(int[] nums) {
    int n = nums.length;
    boolean[] dp = new boolean[n];
    dp[0] = true;
    for (int i = 1; i < n; i++) {
        for (int j = i - 1; j >= 0; j--) {
            if (dp[j] && j + nums[j] >= i) {
                dp[i] = true;
                break;
            }
        }
    }
    return dp[n - 1];
}
```

```
Time:  Greedy: O(n). DP: O(n^2)
Space: Greedy: O(1). DP: O(n)
```

**JVM insight**: The greedy approach is O(n) with a single pass -- the JIT will auto-vectorize the `Math.max` computation if the loop body is simple enough, though in this case the early `return` breaks vectorization potential.

**Real-world correlation**: **Network reachability analysis**. In software-defined networking, determining whether a packet can reach a destination through a series of hops with varying forwarding capabilities is exactly Jump Game. Each switch (node) has a "reach" based on its forwarding table entries.

---

**P17.10** [M] -- Jump Game II (LeetCode 45)

Minimum number of jumps to reach the last index. Guaranteed reachable.

```java
// BFS-like greedy (optimal)
public int jump(int[] nums) {
    int jumps = 0, currentEnd = 0, farthest = 0;
    for (int i = 0; i < nums.length - 1; i++) {
        farthest = Math.max(farthest, i + nums[i]);
        if (i == currentEnd) {
            jumps++;
            currentEnd = farthest;
            if (currentEnd >= nums.length - 1) break;
        }
    }
    return jumps;
}

// DP approach
public int jumpDP(int[] nums) {
    int n = nums.length;
    int[] dp = new int[n];
    Arrays.fill(dp, Integer.MAX_VALUE);
    dp[0] = 0;
    for (int i = 0; i < n; i++) {
        for (int j = 1; j <= nums[i] && i + j < n; j++) {
            dp[i + j] = Math.min(dp[i + j], dp[i] + 1);
        }
    }
    return dp[n - 1];
}
```

```
Time:  Greedy: O(n). DP: O(n × max(nums[i]))
Space: Both: O(1) greedy, O(n) DP
```

**JVM insight**: The greedy approach treats the problem as BFS on implicit graph layers. Each "jump" is a BFS level. The `currentEnd` marks the boundary of the current BFS layer. This is the same technique used in BFS-based shortest path on unweighted graphs.

**Real-world correlation**: **Minimum hop routing**. In networks where each node can reach a set of neighbors, finding the minimum number of hops to reach a destination is this exact problem. RIP (Routing Information Protocol) uses hop count as its metric.

---

**P17.11** [M] -- Longest Increasing Subsequence (LeetCode 300)

Find the length of the longest strictly increasing subsequence.

```java
// O(n^2) DP approach
public int lengthOfLIS(int[] nums) {
    int n = nums.length;
    int[] dp = new int[n];  // dp[i] = length of LIS ending at index i
    Arrays.fill(dp, 1);     // every element is a subsequence of length 1
    int maxLen = 1;
    
    for (int i = 1; i < n; i++) {
        for (int j = 0; j < i; j++) {
            if (nums[j] < nums[i]) {
                dp[i] = Math.max(dp[i], dp[j] + 1);
            }
        }
        maxLen = Math.max(maxLen, dp[i]);
    }
    return maxLen;
}

// O(n log n) patience sorting approach
public int lengthOfLISOptimal(int[] nums) {
    // tails[i] = smallest tail element for increasing subsequences of length i+1
    List<Integer> tails = new ArrayList<>();
    
    for (int num : nums) {
        int pos = Collections.binarySearch(tails, num);
        if (pos < 0) pos = -(pos + 1);  // insertion point
        
        if (pos == tails.size()) {
            tails.add(num);
        } else {
            tails.set(pos, num);
        }
    }
    return tails.size();
}
```

```
Time:  O(n^2) DP / O(n log n) patience sort
Space: O(n)
```

**JVM insight**: The O(n log n) approach uses `Collections.binarySearch`, which delegates to `ArrayList`'s internal array. Since `ArrayList` backs onto `Object[]`, each element is a boxed `Integer`. For better performance, use an `int[]` with `Arrays.binarySearch`:

```java
public int lengthOfLISFast(int[] nums) {
    int[] tails = new int[nums.length];
    int size = 0;
    for (int num : nums) {
        int lo = 0, hi = size;
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (tails[mid] < num) lo = mid + 1;
            else hi = mid;
        }
        tails[lo] = num;
        if (lo == size) size++;
    }
    return size;
}
```

This avoids all boxing and uses a contiguous `int[]` for the binary search -- a significant constant-factor improvement.

**Real-world correlation**: **Version ordering / deployment sequencing**. Given a stream of software versions with varying build numbers, finding the longest monotonically increasing sequence helps identify the "main branch" of development. **Stock trading**: the longest increasing subsequence of prices identifies the theoretical maximum number of profitable buy-then-sell-higher trades.

---

## 17.3 Sub-Pattern 2: 2D Grid/String DP

### What It Is

Problems where the state requires two indices. This naturally arises in two contexts: (1) grid problems where `dp[i][j]` represents something about cell `(i, j)`, and (2) string problems where `dp[i][j]` represents something about the first `i` characters of string 1 and the first `j` characters of string 2.

### How to Identify the Subproblem Structure

**Grid**: "Starting from (0,0), how many ways / what is the min cost to reach (i,j)?" The answer at (i,j) depends on answers at (i-1,j) and (i,j-1) -- the cells directly above and to the left.

**Two strings**: "What is the answer for s1[0..i-1] and s2[0..j-1]?" The answer depends on matching/not matching the current characters and reducing to smaller substrings.

### State Definition and Transition

```
Grid:
  State:     dp[i][j] = answer for reaching cell (i, j)
  Transition: dp[i][j] = f(dp[i-1][j], dp[i][j-1], grid[i][j])
  Base:       dp[0][0] = initial value, first row/column filled from one direction
  Answer:     dp[m-1][n-1]

Two strings:
  State:     dp[i][j] = answer for s1[0..i-1] and s2[0..j-1]
  Transition: if s1[i-1] == s2[j-1]: dp[i][j] = dp[i-1][j-1] + ...
              else: dp[i][j] = f(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
  Base:       dp[0][j] and dp[i][0] represent empty string cases
  Answer:     dp[m][n]
```

### Template Code

```java
// 2D Grid DP template (bottom-up)
public int solveGrid(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    int[][] dp = new int[m][n];
    
    dp[0][0] = grid[0][0];
    // Fill first row
    for (int j = 1; j < n; j++) dp[0][j] = dp[0][j-1] + grid[0][j];
    // Fill first column
    for (int i = 1; i < m; i++) dp[i][0] = dp[i-1][0] + grid[i][0];
    
    // Fill rest
    for (int i = 1; i < m; i++) {
        for (int j = 1; j < n; j++) {
            dp[i][j] = grid[i][j] + Math.min(dp[i-1][j], dp[i][j-1]);
        }
    }
    return dp[m-1][n-1];
}

// Space-optimized: use single row
public int solveGridOptimized(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    int[] dp = new int[n];
    dp[0] = grid[0][0];
    for (int j = 1; j < n; j++) dp[j] = dp[j-1] + grid[0][j];
    
    for (int i = 1; i < m; i++) {
        dp[0] += grid[i][0];
        for (int j = 1; j < n; j++) {
            dp[j] = grid[i][j] + Math.min(dp[j], dp[j-1]);
            // dp[j] on right side = dp[i-1][j] (from above, not yet overwritten)
            // dp[j-1] = dp[i][j-1] (from left, already overwritten this row)
        }
    }
    return dp[n-1];
}

// Two-string DP template
public int solveTwoStrings(String s1, String s2) {
    int m = s1.length(), n = s2.length();
    int[][] dp = new int[m + 1][n + 1];
    
    // Base cases: dp[0][j] and dp[i][0]
    
    for (int i = 1; i <= m; i++) {
        for (int j = 1; j <= n; j++) {
            if (s1.charAt(i - 1) == s2.charAt(j - 1)) {
                dp[i][j] = dp[i-1][j-1] + 1;  // characters match
            } else {
                dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);  // skip one
            }
        }
    }
    return dp[m][n];
}
```

### Real-World Correlation

**Grid DP**: Robot path planning in warehouses (Amazon robotics), pixel cost minimization in image processing (seam carving), and terrain pathfinding in games all use grid DP.

**String DP**: `git diff` uses LCS (Longest Common Subsequence) to compute the minimal difference between two file versions. DNA sequence alignment in bioinformatics (BLAST algorithm) is edit distance at its core. Spell checkers use edit distance to suggest corrections.

### Problems

---

**P17.12** [M] -- Unique Paths (LeetCode 62)

A robot is in the top-left corner of an `m x n` grid. It can only move right or down. How many unique paths to the bottom-right corner?

```java
public int uniquePaths(int m, int n) {
    int[] dp = new int[n];
    Arrays.fill(dp, 1);  // first row: only one way to reach each cell (all right)
    
    for (int i = 1; i < m; i++) {
        for (int j = 1; j < n; j++) {
            dp[j] += dp[j - 1];  // dp[j] (from above) + dp[j-1] (from left)
        }
    }
    return dp[n - 1];
}

// Math approach: C(m+n-2, m-1) -- choose which m-1 moves are "down"
public int uniquePathsMath(int m, int n) {
    long result = 1;
    for (int i = 0; i < Math.min(m, n) - 1; i++) {
        result = result * (m + n - 2 - i) / (i + 1);
    }
    return (int) result;
}
```

```
Time:  DP: O(m × n). Math: O(min(m, n))
Space: DP: O(n). Math: O(1)
```

**JVM insight**: The math approach avoids any array allocation, but watch for overflow in the intermediate `result * (m + n - 2 - i)` computation. Using `long` gives us up to ~9.2 × 10^18, which is sufficient for the LeetCode constraints (m, n <= 100). The order of multiplication then division matters -- always multiply first, then divide, to maintain integer precision.

---

**P17.13** [M] -- Unique Paths II (LeetCode 63)

Same as above but with obstacles. `obstacleGrid[i][j] = 1` means blocked.

```java
public int uniquePathsWithObstacles(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    if (grid[0][0] == 1 || grid[m-1][n-1] == 1) return 0;
    
    int[] dp = new int[n];
    dp[0] = 1;
    
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == 1) {
                dp[j] = 0;
            } else if (j > 0) {
                dp[j] += dp[j - 1];
            }
        }
    }
    return dp[n - 1];
}
```

```
Time:  O(m × n)
Space: O(n)
```

**Real-world correlation**: **Network routing with failed links**. When links fail in a network topology, some paths become unavailable. Computing alternative path counts under failure scenarios is exactly unique paths with obstacles.

---

**P17.14** [M] -- Minimum Path Sum (LeetCode 64)

Find a path from top-left to bottom-right in a grid that minimizes the sum of values along the path. Move only right or down.

```java
public int minPathSum(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    int[] dp = new int[n];
    dp[0] = grid[0][0];
    for (int j = 1; j < n; j++) dp[j] = dp[j - 1] + grid[0][j];
    
    for (int i = 1; i < m; i++) {
        dp[0] += grid[i][0];
        for (int j = 1; j < n; j++) {
            dp[j] = grid[i][j] + Math.min(dp[j], dp[j - 1]);
        }
    }
    return dp[n - 1];
}
```

```
Time:  O(m × n)
Space: O(n)
```

**JVM insight**: We could also modify the input grid in-place (`grid[i][j] += min(grid[i-1][j], grid[i][j-1])`) to achieve O(1) extra space. But mutating input parameters is generally bad practice in production code and some interviewers frown on it. Explicitly state the trade-off if you take that approach.

**Real-world correlation**: **Seam carving** in image processing uses exactly this DP to find the minimum-energy vertical or horizontal seam to remove from an image for content-aware resizing. Adobe Photoshop's content-aware scaling uses this algorithm.

---

**P17.15** [M] -- Longest Common Subsequence (LeetCode 1143)

Given two strings, find the length of their longest common subsequence.

```java
public int longestCommonSubsequence(String text1, String text2) {
    int m = text1.length(), n = text2.length();
    
    // Ensure text2 is shorter (for space optimization)
    if (m < n) return longestCommonSubsequence(text2, text1);
    
    int[] dp = new int[n + 1];
    
    for (int i = 1; i <= m; i++) {
        int prev = 0;  // dp[i-1][j-1]
        for (int j = 1; j <= n; j++) {
            int temp = dp[j];  // save dp[i-1][j] before overwriting
            if (text1.charAt(i - 1) == text2.charAt(j - 1)) {
                dp[j] = prev + 1;
            } else {
                dp[j] = Math.max(dp[j], dp[j - 1]);
            }
            prev = temp;
        }
    }
    return dp[n];
}
```

```
Time:  O(m × n)
Space: O(min(m, n))
```

**JVM insight**: The space optimization from O(m*n) to O(n) is critical for long strings. For two 5000-character strings, the 2D table would be 100 MB (25M ints), while the 1D approach uses 20 KB. The `prev` variable elegantly captures the diagonal value that would otherwise be lost when overwriting.

**Real-world correlation**: **`git diff` and `diff` utilities** compute LCS to find the minimal set of changes between two files. The Myers diff algorithm (used by Git) is an O((M+N)D) algorithm where D is the edit distance, which is faster than O(MN) for similar files. **Bioinformatics**: BLAST and Smith-Waterman sequence alignment are LCS variants with scoring matrices.

---

**P17.16** [M] -- Longest Common Substring (not on LeetCode, but fundamental)

Given two strings, find the length of their longest common *contiguous* substring.

```java
public int longestCommonSubstring(String s1, String s2) {
    int m = s1.length(), n = s2.length();
    int[] dp = new int[n + 1];
    int maxLen = 0;
    
    for (int i = 1; i <= m; i++) {
        // Must iterate j from right to left to avoid using updated values
        int prev = 0;
        for (int j = 1; j <= n; j++) {
            int temp = dp[j];
            if (s1.charAt(i - 1) == s2.charAt(j - 1)) {
                dp[j] = prev + 1;
                maxLen = Math.max(maxLen, dp[j]);
            } else {
                dp[j] = 0;  // substring must be contiguous
            }
            prev = temp;
        }
    }
    return maxLen;
}
```

```
Time:  O(m × n)
Space: O(n)
```

**Key difference from LCS**: When characters do not match, LCS takes `max(dp[i-1][j], dp[i][j-1])` but common substring resets to 0. The contiguity constraint eliminates the "skip" options.

**Real-world correlation**: **Plagiarism detection**. Finding the longest common substring between two documents identifies copied passages. The suffix array approach achieves O((m+n) log(m+n)) which is superior for very long texts.

---

**P17.17** [H] -- Edit Distance (LeetCode 72)

Given two strings, find the minimum number of operations (insert, delete, replace) to convert one to the other.

```java
public int minDistance(String word1, String word2) {
    int m = word1.length(), n = word2.length();
    int[] dp = new int[n + 1];
    
    // Base case: dp[0][j] = j (insert j characters)
    for (int j = 0; j <= n; j++) dp[j] = j;
    
    for (int i = 1; i <= m; i++) {
        int prev = dp[0];  // dp[i-1][0]
        dp[0] = i;          // dp[i][0] = i (delete i characters)
        
        for (int j = 1; j <= n; j++) {
            int temp = dp[j];
            if (word1.charAt(i - 1) == word2.charAt(j - 1)) {
                dp[j] = prev;  // no operation needed
            } else {
                dp[j] = 1 + Math.min(prev,           // replace
                            Math.min(dp[j],           // delete (dp[i-1][j])
                                     dp[j - 1]));     // insert (dp[i][j-1])
            }
            prev = temp;
        }
    }
    return dp[n];
}
```

```
Time:  O(m × n)
Space: O(n)
```

**Top-down version for comparison**:

```java
private int[][] memo;

public int minDistanceMemo(String word1, String word2) {
    int m = word1.length(), n = word2.length();
    memo = new int[m][n];
    for (int[] row : memo) Arrays.fill(row, -1);
    return dp(word1, word2, m - 1, n - 1);
}

private int dp(String w1, String w2, int i, int j) {
    if (i < 0) return j + 1;  // insert remaining j+1 characters
    if (j < 0) return i + 1;  // delete remaining i+1 characters
    if (memo[i][j] != -1) return memo[i][j];
    
    if (w1.charAt(i) == w2.charAt(j)) {
        memo[i][j] = dp(w1, w2, i - 1, j - 1);
    } else {
        memo[i][j] = 1 + Math.min(dp(w1, w2, i - 1, j - 1),  // replace
                         Math.min(dp(w1, w2, i - 1, j),        // delete
                                  dp(w1, w2, i, j - 1)));      // insert
    }
    return memo[i][j];
}
```

**JVM insight**: The top-down version uses `int[][]` memoization, which is cleaner than `HashMap<String, Integer>`. Each `memo[i][j]` access is two array dereferences (jagged array), but both the outer and inner arrays are likely in L1 cache during computation. The bottom-up version with the 1D rolling array is more cache-friendly overall.

**Real-world correlation**: **Spell checking**: Levenshtein distance powers spell checkers (suggested corrections are words within edit distance 1-2). **DNA alignment**: The Needleman-Wunsch algorithm is edit distance with variable costs per operation (match/mismatch/gap penalties). **diff tools**: The Unix `diff` command computes edit distance (insertions and deletions only, no replacements) to show file differences.

---

**P17.18** [M] -- Interleaving String (LeetCode 97)

Given `s1`, `s2`, and `s3`, determine if `s3` is formed by interleaving `s1` and `s2`.

```java
public boolean isInterleave(String s1, String s2, String s3) {
    int m = s1.length(), n = s2.length();
    if (m + n != s3.length()) return false;
    
    // dp[j] = can s1[0..i-1] and s2[0..j-1] interleave to form s3[0..i+j-1]
    boolean[] dp = new boolean[n + 1];
    
    for (int i = 0; i <= m; i++) {
        for (int j = 0; j <= n; j++) {
            if (i == 0 && j == 0) {
                dp[j] = true;
            } else if (i == 0) {
                dp[j] = dp[j - 1] && s2.charAt(j - 1) == s3.charAt(j - 1);
            } else if (j == 0) {
                dp[j] = dp[j] && s1.charAt(i - 1) == s3.charAt(i - 1);
            } else {
                dp[j] = (dp[j] && s1.charAt(i - 1) == s3.charAt(i + j - 1)) ||
                         (dp[j - 1] && s2.charAt(j - 1) == s3.charAt(i + j - 1));
            }
        }
    }
    return dp[n];
}
```

```
Time:  O(m × n)
Space: O(n)
```

**Real-world correlation**: **Multiplexed stream reassembly**. HTTP/2 multiplexes multiple logical streams over a single TCP connection. Determining whether a received byte sequence is a valid interleaving of the individual streams is this exact problem.

---

**P17.19** [H] -- Distinct Subsequences (LeetCode 115)

Given strings `s` and `t`, count the number of distinct subsequences of `s` that equal `t`.

```java
public int numDistinct(String s, String t) {
    int m = s.length(), n = t.length();
    // dp[j] = number of ways to form t[0..j-1] using a prefix of s
    int[] dp = new int[n + 1];
    dp[0] = 1;  // empty t can be formed from any prefix of s in exactly 1 way
    
    for (int i = 1; i <= m; i++) {
        // Iterate j from RIGHT to LEFT to preserve dp[j-1] from previous row
        for (int j = Math.min(i, n); j >= 1; j--) {
            if (s.charAt(i - 1) == t.charAt(j - 1)) {
                dp[j] += dp[j - 1];
            }
            // If chars don't match, dp[j] stays the same (inherited from row above)
        }
    }
    return dp[n];
}
```

```
Time:  O(m × n)
Space: O(n)
```

**JVM insight**: The right-to-left iteration for space optimization is the same trick as 0/1 knapsack: we need the "previous row" values, which get overwritten left-to-right but are preserved right-to-left. The `Math.min(i, n)` optimization skips impossible states where we have fewer characters in `s` than needed for the current `j`.

**Real-world correlation**: **Log pattern matching**. Counting how many ways a pattern appears as a subsequence in a log line helps in fuzzy log analysis -- detecting whether a series of events occurred in order, regardless of interleaving noise.

---

**P17.20** [M] -- Minimum ASCII Delete Sum for Two Strings (LeetCode 712)

Find the minimum ASCII sum of deleted characters to make two strings equal.

```java
public int minimumDeleteSum(String s1, String s2) {
    int m = s1.length(), n = s2.length();
    int[] dp = new int[n + 1];
    
    // Base case: delete all of s2
    for (int j = 1; j <= n; j++) dp[j] = dp[j - 1] + s2.charAt(j - 1);
    
    for (int i = 1; i <= m; i++) {
        int prev = dp[0];
        dp[0] += s1.charAt(i - 1);  // delete all of s1[0..i-1]
        
        for (int j = 1; j <= n; j++) {
            int temp = dp[j];
            if (s1.charAt(i - 1) == s2.charAt(j - 1)) {
                dp[j] = prev;  // no deletion needed
            } else {
                dp[j] = Math.min(dp[j] + s1.charAt(i - 1),     // delete s1[i-1]
                                 dp[j - 1] + s2.charAt(j - 1)); // delete s2[j-1]
            }
            prev = temp;
        }
    }
    return dp[n];
}
```

```
Time:  O(m × n)
Space: O(n)
```

**JVM insight**: `s.charAt(i)` returns a `char` which is an unsigned 16-bit value (0-65535). For ASCII characters, this is the ASCII code directly. Summing `char` values in an `int` accumulator cannot overflow for reasonable string lengths (65535 × 1000 = 65.5M, well within `int` range).

---

## 17.4 Sub-Pattern 3: Knapsack Family

### What It Is

The knapsack family is arguably the most important DP sub-pattern for interviews and real-world applications. The core idea: given items with weights and values, and a capacity constraint, maximize value (or determine feasibility). Every resource allocation problem in computing -- memory budgets, CPU scheduling, portfolio optimization, container packing -- is a knapsack variant.

### The Four Knapsack Variants

```
1. 0/1 Knapsack:     Each item used AT MOST once
2. Unbounded Knapsack: Each item used UNLIMITED times
3. Bounded Knapsack:   Each item has a specific count limit
4. Subset Sum:         Special case — can we reach exact target?
```

### How to Identify

Ask: "Am I choosing from a set of items, each with a cost and a benefit, subject to a capacity constraint?" If yes, it is knapsack. The variant depends on how many times each item can be used.

### State Definition and Transition

```
0/1 Knapsack:
  State:      dp[i][w] = max value using items 0..i-1, capacity w
  Transition: dp[i][w] = max(dp[i-1][w],  // skip item i
                              dp[i-1][w-weight[i]] + value[i])  // take item i
  Space-optimized: iterate w from RIGHT to LEFT

Unbounded Knapsack:
  State:      dp[w] = max value with capacity w (items can repeat)
  Transition: dp[w] = max(dp[w], dp[w-weight[i]] + value[i]) for each item i
  Space-optimized: iterate w from LEFT to RIGHT (allows reuse)

Subset Sum:
  State:      dp[s] = can we reach sum s?
  Transition: dp[s] = dp[s] || dp[s - nums[i]]
```

### Template Code

```java
// 0/1 Knapsack (space-optimized)
public int knapsack01(int[] weights, int[] values, int W) {
    int n = weights.length;
    int[] dp = new int[W + 1];
    
    for (int i = 0; i < n; i++) {
        // RIGHT to LEFT: ensures each item is used at most once
        for (int w = W; w >= weights[i]; w--) {
            dp[w] = Math.max(dp[w], dp[w - weights[i]] + values[i]);
        }
    }
    return dp[W];
}

// Unbounded Knapsack (space-optimized)
public int knapsackUnbounded(int[] weights, int[] values, int W) {
    int[] dp = new int[W + 1];
    
    for (int w = 1; w <= W; w++) {
        for (int i = 0; i < weights.length; i++) {
            if (weights[i] <= w) {
                // LEFT to RIGHT: allows reusing same item
                dp[w] = Math.max(dp[w], dp[w - weights[i]] + values[i]);
            }
        }
    }
    return dp[W];
}

// Subset Sum
public boolean subsetSum(int[] nums, int target) {
    boolean[] dp = new boolean[target + 1];
    dp[0] = true;
    
    for (int num : nums) {
        for (int s = target; s >= num; s--) {  // right-to-left for 0/1
            dp[s] = dp[s] || dp[s - num];
        }
    }
    return dp[target];
}
```

**Critical insight -- direction of iteration determines knapsack type**:
- Right-to-left inner loop = 0/1 knapsack (each item used at most once)
- Left-to-right inner loop = unbounded knapsack (items reusable)

This is the single most important thing to remember about knapsack DP. The iteration direction controls whether you are reading from "current row" (allows reuse) or "previous row" (prevents reuse).

### Real-World Correlation

**Cloud resource allocation**: You have a budget (capacity) and a set of VM instances with different costs and performance characteristics. Maximizing throughput within budget is 0/1 knapsack (each instance type used once) or bounded knapsack (up to K of each type). AWS instance selection, GCP machine type selection -- they are all knapsack.

**Container bin packing**: Kubernetes pod scheduling is a multi-dimensional knapsack: each pod requires CPU and memory (multiple weight dimensions), and each node has CPU and memory capacity. The scheduler maximizes utilization.

**Portfolio optimization**: Given a budget and investment options with expected returns, the Markowitz portfolio problem is knapsack with continuous relaxation.

### Problems

---

**P17.21** [M] -- 0/1 Knapsack (Classic, not on LeetCode)

Given `n` items with weights and values, and a knapsack of capacity `W`, find the maximum value.

```java
public int knapsack(int[] weights, int[] values, int W) {
    int n = weights.length;
    int[] dp = new int[W + 1];
    
    for (int i = 0; i < n; i++) {
        for (int w = W; w >= weights[i]; w--) {
            dp[w] = Math.max(dp[w], dp[w - weights[i]] + values[i]);
        }
    }
    return dp[W];
}
```

```
Time:  O(n × W) -- pseudo-polynomial (polynomial in W, not in input size)
Space: O(W)
```

**JVM insight**: The `dp` array of size `W+1` must fit in memory. For `W = 10^7`, that is 40 MB as `int[]`. For `W = 10^9`, you cannot use tabulation -- you would need the top-down approach with a HashMap that only stores reachable states. This is a case where top-down memoization is *strictly better* than bottom-up tabulation.

**Why it is "pseudo-polynomial"**: The input size is O(n + log W) (the number of bits needed to encode W). The algorithm's time is O(n * W), which is exponential in log W. True polynomial would be O(n * (log W)^k). This is why 0/1 Knapsack is NP-complete despite having a DP solution.

---

**P17.22** [M] -- Coin Change (LeetCode 322)

Find the fewest number of coins needed to make a given amount. Unlimited supply of each denomination.

```java
public int coinChange(int[] coins, int amount) {
    int[] dp = new int[amount + 1];
    Arrays.fill(dp, amount + 1);  // impossible sentinel (larger than any valid answer)
    dp[0] = 0;
    
    for (int a = 1; a <= amount; a++) {
        for (int coin : coins) {
            if (coin <= a) {
                dp[a] = Math.min(dp[a], dp[a - coin] + 1);
            }
        }
    }
    return dp[amount] > amount ? -1 : dp[amount];
}
```

```
Time:  O(amount × coins.length)
Space: O(amount)
```

**JVM insight**: Using `amount + 1` as the sentinel instead of `Integer.MAX_VALUE` avoids overflow when computing `dp[a - coin] + 1`. This is a subtle but critical correctness detail -- `Integer.MAX_VALUE + 1` wraps around to `Integer.MIN_VALUE` in Java's signed 32-bit arithmetic, making the `Math.min` comparison produce the wrong result.

**Real-world correlation**: **Making change** is the literal application. But more broadly, this is **resource provisioning with discrete units**: allocating the minimum number of servers of various capacities to handle a total load, or the minimum number of network links of various bandwidths to carry aggregate traffic.

---

**P17.23** [M] -- Coin Change II (LeetCode 518)

Count the number of distinct combinations to make a given amount. Order does not matter (combinations, not permutations).

```java
public int change(int amount, int[] coins) {
    int[] dp = new int[amount + 1];
    dp[0] = 1;  // one way to make amount 0: use no coins
    
    // Outer loop over coins, inner loop over amounts
    // This ensures each combination is counted ONCE (order doesn't matter)
    for (int coin : coins) {
        for (int a = coin; a <= amount; a++) {
            dp[a] += dp[a - coin];
        }
    }
    return dp[amount];
}
```

**Contrast with permutation counting**:

```java
// If we wanted permutations (order matters), swap the loops:
public int changePerm(int amount, int[] coins) {
    int[] dp = new int[amount + 1];
    dp[0] = 1;
    
    for (int a = 1; a <= amount; a++) {
        for (int coin : coins) {
            if (coin <= a) dp[a] += dp[a - coin];
        }
    }
    return dp[amount];
}
```

```
Time:  O(amount × coins.length)
Space: O(amount)
```

**Critical insight**: The loop order determines whether you count combinations or permutations.
- **Outer coins, inner amounts** = combinations (each coin denomination processed in order, preventing duplicate orderings)
- **Outer amounts, inner coins** = permutations (at each amount, all coins are considered, allowing `[1,2]` and `[2,1]` as separate)

**Real-world correlation**: **Denomination design**. Central banks optimize coin/bill denominations to minimize the average number of coins in change. The greedy algorithm works for standard denominations (1, 5, 10, 25) but fails for arbitrary denominations -- that is when you need this DP.

---

**P17.24** [M] -- Partition Equal Subset Sum (LeetCode 416)

Can you partition an array into two subsets with equal sum?

```java
public boolean canPartition(int[] nums) {
    int sum = 0;
    for (int num : nums) sum += num;
    if (sum % 2 != 0) return false;  // odd sum => impossible
    
    int target = sum / 2;
    boolean[] dp = new boolean[target + 1];
    dp[0] = true;
    
    for (int num : nums) {
        for (int s = target; s >= num; s--) {  // right-to-left (0/1 knapsack)
            dp[s] = dp[s] || dp[s - num];
        }
    }
    return dp[target];
}
```

```
Time:  O(n × sum/2)
Space: O(sum/2)
```

**JVM insight**: The `boolean[]` in Java uses 1 byte per element (not 1 bit), so a `boolean[10000]` is 10 KB. If space is critical, use a `BitSet` which packs 64 booleans per `long`:

```java
public boolean canPartitionBitSet(int[] nums) {
    int sum = 0;
    for (int num : nums) sum += num;
    if (sum % 2 != 0) return false;
    int target = sum / 2;
    
    BitSet dp = new BitSet(target + 1);
    dp.set(0);
    for (int num : nums) {
        // Shift the entire bitset left by num and OR with existing
        // This is equivalent to the right-to-left loop
        dp.or(shiftLeft(dp, num, target));
    }
    return dp.get(target);
}

private BitSet shiftLeft(BitSet bs, int shift, int limit) {
    BitSet result = new BitSet(limit + 1);
    for (int i = bs.nextSetBit(0); i >= 0 && i + shift <= limit; i = bs.nextSetBit(i + 1)) {
        result.set(i + shift);
    }
    return result;
}
```

**Real-world correlation**: **Load balancing across two servers**. Given a set of tasks with known sizes, can you split them evenly across two machines? This is exactly partition equal subset sum. More generally, the multiway partition problem (K servers) is NP-hard but has practical heuristics.

---

**P17.25** [M] -- Target Sum (LeetCode 494)

Assign `+` or `-` to each number to reach a target sum. Count the number of ways.

```java
public int findTargetSumWays(int[] nums, int target) {
    int sum = 0;
    for (int num : nums) sum += num;
    
    // Let P = sum of positive subset, N = sum of negative subset
    // P - N = target, P + N = sum
    // => P = (sum + target) / 2
    if ((sum + target) % 2 != 0 || sum + target < 0) return 0;
    int subsetSum = (sum + target) / 2;
    
    // Now: count subsets that sum to subsetSum (0/1 knapsack count)
    int[] dp = new int[subsetSum + 1];
    dp[0] = 1;
    
    for (int num : nums) {
        for (int s = subsetSum; s >= num; s--) {
            dp[s] += dp[s - num];
        }
    }
    return dp[subsetSum];
}
```

```
Time:  O(n × (sum + target) / 2)
Space: O((sum + target) / 2)
```

**JVM insight**: The mathematical reduction from "assign signs" to "find subsets summing to P" is the key. Without this reduction, a direct DP with `dp[i][s]` where `s` ranges from `-sum` to `+sum` would require handling negative indices (use offset) and double the state space.

**Real-world correlation**: **Feature toggle optimization**. Given a set of feature flags that each affect performance (positive or negative), finding assignments that achieve a target performance delta is this exact problem.

---

**P17.26** [M] -- Last Stone Weight II (LeetCode 1049)

Smash stones together (result = |x - y|). Minimize the final stone weight.

```java
public int lastStoneWeightII(int[] stones) {
    int sum = 0;
    for (int s : stones) sum += s;
    
    // Partition into two groups, minimize |group1 - group2|
    // Same as: find subset with sum closest to sum/2
    int target = sum / 2;
    boolean[] dp = new boolean[target + 1];
    dp[0] = true;
    
    for (int stone : stones) {
        for (int s = target; s >= stone; s--) {
            dp[s] = dp[s] || dp[s - stone];
        }
    }
    
    // Find the largest achievable sum <= target
    for (int s = target; s >= 0; s--) {
        if (dp[s]) return sum - 2 * s;
    }
    return sum;  // unreachable
}
```

```
Time:  O(n × sum/2)
Space: O(sum/2)
```

**Real-world correlation**: **Balanced sharding**. When splitting data across two partitions (database sharding, MapReduce), minimizing the imbalance is exactly this problem.

---

**P17.27** [M] -- Ones and Zeroes (LeetCode 474)

Given binary strings and limits `m` zeros and `n` ones, find the max number of strings you can form.

```java
public int findMaxForm(String[] strs, int m, int n) {
    // 2D knapsack: two capacities (zeros and ones)
    int[][] dp = new int[m + 1][n + 1];
    
    for (String s : strs) {
        int zeros = 0, ones = 0;
        for (char c : s.toCharArray()) {
            if (c == '0') zeros++;
            else ones++;
        }
        
        // 0/1 knapsack: iterate backwards on both dimensions
        for (int i = m; i >= zeros; i--) {
            for (int j = n; j >= ones; j--) {
                dp[i][j] = Math.max(dp[i][j], dp[i - zeros][j - ones] + 1);
            }
        }
    }
    return dp[m][n];
}
```

```
Time:  O(L × m × n) where L = number of strings
Space: O(m × n)
```

**JVM insight**: This is a 2D knapsack (two capacity dimensions). The same right-to-left iteration trick applies independently on each dimension. The `dp` array is `(m+1) × (n+1)`, so for `m = n = 100`, that is ~40 KB -- easily fits in L1 cache.

---

**P17.28** [H] -- Profitable Schemes (LeetCode 879)

Given `n` people, a profit threshold, and crimes with required people and profit, count schemes that achieve at least the profit threshold.

```java
public int profitableSchemes(int n, int minProfit, int[] group, int[] profit) {
    int MOD = 1_000_000_007;
    // dp[j][k] = number of schemes using at most j people with at least k profit
    int[][] dp = new int[n + 1][minProfit + 1];
    
    // Base case: 0 crimes, 0 people, 0 profit = 1 scheme (do nothing)
    for (int j = 0; j <= n; j++) dp[j][0] = 1;
    
    for (int i = 0; i < group.length; i++) {
        int g = group[i], p = profit[i];
        // 0/1 knapsack: iterate backwards
        for (int j = n; j >= g; j--) {
            for (int k = minProfit; k >= 0; k--) {
                int newProfit = Math.min(k + p, minProfit);
                // min clamps to minProfit because we only care "at least minProfit"
                dp[j][newProfit] = (dp[j][newProfit] + dp[j - g][k]) % MOD;
            }
        }
    }
    return dp[n][minProfit];
}
```

```
Time:  O(crimes × n × minProfit)
Space: O(n × minProfit)
```

**JVM insight**: The `% MOD` operation is necessary because the count can be astronomically large. The modular arithmetic ensures all intermediate values fit in `int`. Note that `(a + b) % MOD` is safe when `a` and `b` are both less than MOD (2^31 - 7), since their sum fits in `long` but we use `int` here because MOD < 2^30 means `a + b < 2^31`.

---

## 17.5 Sub-Pattern 4: Interval DP

### What It Is

Problems where the subproblem is defined over a *contiguous interval* `[i, j]` of the input. You solve for all intervals of length 1, then length 2, and so on up to length `n`. The transition typically tries all split points `k` in `[i, j-1]`, combining the solutions for `[i, k]` and `[k+1, j]`.

### How to Identify the Subproblem Structure

Ask: "Does the problem involve choosing where to split/merge/partition a sequence, and the cost depends on the sub-results?" If the order of operations matters (like matrix chain multiplication, where the grouping changes the cost), it is interval DP.

### State Definition and Transition

```
State:      dp[i][j] = optimal answer for subarray/substring from index i to j
Transition: dp[i][j] = optimal over all k in [i, j-1]:
                combine(dp[i][k], dp[k+1][j], cost(i, j, k))
Base:       dp[i][i] = base value for single element
Fill order: by increasing interval length (len = j - i + 1)
Answer:     dp[0][n-1]
```

### Template Code

```java
// Bottom-up interval DP
public int solveInterval(int[] arr) {
    int n = arr.length;
    int[][] dp = new int[n][n];
    
    // Base cases: intervals of length 1
    for (int i = 0; i < n; i++) dp[i][i] = baseCaseValue(arr, i);
    
    // Fill by increasing interval length
    for (int len = 2; len <= n; len++) {
        for (int i = 0; i <= n - len; i++) {
            int j = i + len - 1;
            dp[i][j] = Integer.MAX_VALUE;  // or MIN_VALUE for maximization
            
            // Try all split points
            for (int k = i; k < j; k++) {
                int cost = dp[i][k] + dp[k + 1][j] + mergeCost(arr, i, j, k);
                dp[i][j] = Math.min(dp[i][j], cost);
            }
        }
    }
    return dp[0][n - 1];
}

// Top-down interval DP
private int[][] memo;

public int solveIntervalMemo(int[] arr) {
    int n = arr.length;
    memo = new int[n][n];
    for (int[] row : memo) Arrays.fill(row, -1);
    return dp(arr, 0, n - 1);
}

private int dp(int[] arr, int i, int j) {
    if (i == j) return baseCaseValue(arr, i);
    if (memo[i][j] != -1) return memo[i][j];
    
    int best = Integer.MAX_VALUE;
    for (int k = i; k < j; k++) {
        best = Math.min(best, dp(arr, i, k) + dp(arr, k + 1, j) + mergeCost(arr, i, j, k));
    }
    memo[i][j] = best;
    return best;
}
```

### Real-World Correlation

**Compiler optimization**: Optimal instruction scheduling and register allocation use interval DP. Determining the best order to evaluate sub-expressions in a syntax tree is matrix chain multiplication in disguise.

**Database query planning**: When a query joins multiple tables, the optimizer must choose the join order. For N tables, there are Catalan(N) possible join trees. The optimal join order is computed using interval DP (or the Selinger algorithm in System R).

### Problems

---

**P17.29** [H] -- Burst Balloons (LeetCode 312)

Given `n` balloons with values, bursting balloon `i` earns `nums[i-1] * nums[i] * nums[i+1]`. Find the maximum coins.

```java
public int maxCoins(int[] nums) {
    int n = nums.length;
    // Pad with 1 on both sides
    int[] arr = new int[n + 2];
    arr[0] = arr[n + 1] = 1;
    for (int i = 0; i < n; i++) arr[i + 1] = nums[i];
    
    // dp[i][j] = max coins from bursting all balloons between i and j (exclusive)
    int[][] dp = new int[n + 2][n + 2];
    
    for (int len = 1; len <= n; len++) {
        for (int i = 1; i <= n - len + 1; i++) {
            int j = i + len - 1;
            for (int k = i; k <= j; k++) {
                // k is the LAST balloon to burst in range [i, j]
                int coins = arr[i - 1] * arr[k] * arr[j + 1]
                           + dp[i][k - 1] + dp[k + 1][j];
                dp[i][j] = Math.max(dp[i][j], coins);
            }
        }
    }
    return dp[1][n];
}
```

```
Time:  O(n^3)
Space: O(n^2)
```

**Key insight**: The trick is to think of `k` as the *last* balloon to burst, not the first. If `k` is last, then `arr[i-1]` and `arr[j+1]` are its neighbors (everything else in `[i,j]` has already been burst). This gives clean subproblems: `[i, k-1]` and `[k+1, j]` are independent.

**JVM insight**: The triple nested loop with n up to 300 means up to 27 million iterations. The inner loop body is simple arithmetic (two multiplications, two additions, one comparison), so each iteration is a few nanoseconds. Total: ~100ms on modern hardware.

**Real-world correlation**: **Merge-based cost optimization**. File merging (like Hadoop's compaction of small files into larger ones) has a cost proportional to the sizes of the merged files. The optimal merge order is interval DP.

---

**P17.30** [M] -- Matrix Chain Multiplication (Classic)

Given dimensions of N matrices, find the minimum number of scalar multiplications needed.

```java
public int matrixChainOrder(int[] dims) {
    // dims[i-1] x dims[i] is the dimension of matrix i
    int n = dims.length - 1;  // number of matrices
    int[][] dp = new int[n][n];
    
    for (int len = 2; len <= n; len++) {
        for (int i = 0; i < n - len + 1; i++) {
            int j = i + len - 1;
            dp[i][j] = Integer.MAX_VALUE;
            for (int k = i; k < j; k++) {
                int cost = dp[i][k] + dp[k + 1][j] + dims[i] * dims[k + 1] * dims[j + 1];
                dp[i][j] = Math.min(dp[i][j], cost);
            }
        }
    }
    return dp[0][n - 1];
}
```

```
Time:  O(n^3)
Space: O(n^2)
```

**Real-world correlation**: **Tensor contraction order in ML frameworks**. TensorFlow and PyTorch must decide the order to contract (multiply) tensors in a computational graph. The optimal contraction order is exactly matrix chain multiplication. Getting this wrong can mean the difference between fitting in GPU memory or not.

---

**P17.31** [M] -- Minimum Cost Tree From Leaf Values (LeetCode 1130)

Build a binary tree from leaf values such that the sum of non-leaf nodes is minimized.

```java
public int mctFromLeafValues(int[] arr) {
    int n = arr.length;
    // dp[i][j] = min sum of non-leaf nodes for the subtree spanning arr[i..j]
    // maxVal[i][j] = max value in arr[i..j]
    int[][] dp = new int[n][n];
    int[][] maxVal = new int[n][n];
    
    for (int i = 0; i < n; i++) maxVal[i][i] = arr[i];
    for (int len = 2; len <= n; len++) {
        for (int i = 0; i <= n - len; i++) {
            int j = i + len - 1;
            maxVal[i][j] = Math.max(maxVal[i][j - 1], arr[j]);
            dp[i][j] = Integer.MAX_VALUE;
            for (int k = i; k < j; k++) {
                int cost = dp[i][k] + dp[k + 1][j] + maxVal[i][k] * maxVal[k + 1][j];
                dp[i][j] = Math.min(dp[i][j], cost);
            }
        }
    }
    return dp[0][n - 1];
}
```

```
Time:  O(n^3)
Space: O(n^2)
```

**Note**: There is a clever O(n) monotonic stack solution, but the interval DP approach is the natural way to reason about this problem and demonstrates the pattern.

---

**P17.32** [H] -- Palindrome Partitioning II (LeetCode 132)

Find the minimum number of cuts to partition a string into palindromes.

```java
public int minCut(String s) {
    int n = s.length();
    
    // Step 1: precompute isPalin[i][j]
    boolean[][] isPalin = new boolean[n][n];
    for (int i = n - 1; i >= 0; i--) {
        for (int j = i; j < n; j++) {
            if (s.charAt(i) == s.charAt(j) && (j - i <= 2 || isPalin[i + 1][j - 1])) {
                isPalin[i][j] = true;
            }
        }
    }
    
    // Step 2: dp[i] = min cuts for s[0..i]
    int[] dp = new int[n];
    for (int i = 0; i < n; i++) {
        if (isPalin[0][i]) {
            dp[i] = 0;  // entire prefix is a palindrome
        } else {
            dp[i] = i;  // worst case: cut every character
            for (int j = 1; j <= i; j++) {
                if (isPalin[j][i]) {
                    dp[i] = Math.min(dp[i], dp[j - 1] + 1);
                }
            }
        }
    }
    return dp[n - 1];
}
```

```
Time:  O(n^2)
Space: O(n^2) for isPalin table
```

**JVM insight**: The `boolean[n][n]` table uses `n^2` bytes. For `n = 2000` (LeetCode constraint), that is 4 MB. If `n` were larger, we could compute palindromes on-the-fly using Manacher's algorithm (O(n) precomputation), then use it during the DP phase.

---

**P17.33** [H] -- Strange Printer (LeetCode 664)

A printer can print a sequence of same characters at once. Find the minimum number of turns to print a string.

```java
public int strangePrinter(String s) {
    int n = s.length();
    int[][] dp = new int[n][n];
    
    for (int i = 0; i < n; i++) dp[i][i] = 1;  // single char = 1 turn
    
    for (int len = 2; len <= n; len++) {
        for (int i = 0; i <= n - len; i++) {
            int j = i + len - 1;
            dp[i][j] = dp[i + 1][j] + 1;  // print s[i] alone, then handle rest
            
            for (int k = i + 1; k <= j; k++) {
                if (s.charAt(k) == s.charAt(i)) {
                    // s[i] can be printed together with s[k]
                    dp[i][j] = Math.min(dp[i][j], dp[i + 1][k] + (k + 1 <= j ? dp[k + 1][j] : 0));
                }
            }
        }
    }
    return dp[0][n - 1];
}
```

```
Time:  O(n^3)
Space: O(n^2)
```

---

**P17.34** [H] -- Minimum Cost to Merge Stones (LeetCode 1000)

Merge `K` consecutive piles. Cost = sum of merged stones. Find minimum total cost.

```java
public int mergeStones(int[] stones, int K) {
    int n = stones.length;
    if ((n - 1) % (K - 1) != 0) return -1;  // impossible
    
    int[] prefix = new int[n + 1];
    for (int i = 0; i < n; i++) prefix[i + 1] = prefix[i] + stones[i];
    
    int[][] dp = new int[n][n];
    
    for (int len = K; len <= n; len++) {
        for (int i = 0; i <= n - len; i++) {
            int j = i + len - 1;
            dp[i][j] = Integer.MAX_VALUE;
            
            // Split: jump by K-1 (each sub-merge reduces K piles to 1)
            for (int k = i; k < j; k += K - 1) {
                dp[i][j] = Math.min(dp[i][j], dp[i][k] + dp[k + 1][j]);
            }
            
            // If this range can be fully merged into 1 pile
            if ((len - 1) % (K - 1) == 0) {
                dp[i][j] += prefix[j + 1] - prefix[i];
            }
        }
    }
    return dp[0][n - 1];
}
```

```
Time:  O(n^3 / K)
Space: O(n^2)
```

**Real-world correlation**: **Log compaction in LSM trees**. LevelDB, RocksDB, and Cassandra merge SSTables in groups. The cost of merging depends on the sizes of the involved SSTables. Finding the optimal merge schedule is a generalized merge-stones problem.

---

## 17.6 Sub-Pattern 5: Tree DP

### What It Is

Dynamic programming on tree structures. The state is associated with tree nodes, and the transition flows from children to parents (post-order traversal). Each node's DP value is computed from its children's values.

### How to Identify

Ask: "Is the input a tree (or can it be modeled as one)? Does the answer at a node depend on the answers at its children?" If yes, it is tree DP.

### State Definition and Transition

```
State:      dp[node] = answer for the subtree rooted at node
            Often: dp[node][0] = answer when node is NOT included
                   dp[node][1] = answer when node IS included
Transition: dp[node][0] = f(dp[child][0], dp[child][1]) for all children
            dp[node][1] = g(dp[child][0]) for all children (usually can't take adjacent)
Fill order: post-order traversal (children before parent)
Answer:     f(dp[root][0], dp[root][1])
```

### Template Code

```java
// Tree DP template (post-order DFS)
private int[] dpInclude, dpExclude;  // or use int[][] dp

public int solveTreeDP(TreeNode root) {
    int[] result = dfs(root);
    return Math.max(result[0], result[1]);
}

// Returns [exclude_root, include_root]
private int[] dfs(TreeNode node) {
    if (node == null) return new int[]{0, 0};
    
    int[] left = dfs(node.left);
    int[] right = dfs(node.right);
    
    int exclude = Math.max(left[0], left[1]) + Math.max(right[0], right[1]);
    int include = node.val + left[0] + right[0];
    
    return new int[]{exclude, include};
}
```

### Real-World Correlation

**Organizational hierarchy optimization**. A company needs to select employees for a project. Some employees (managers) have reports. Selecting a manager might conflict with selecting their reports. Maximizing total skill while respecting the hierarchy is tree DP.

**File system analysis**. Computing disk usage (du), finding the largest directories, or pruning the file tree to fit a quota -- all tree DP on the file system's inode tree.

### Problems

---

**P17.35** [M] -- House Robber III (LeetCode 337)

Rob houses arranged in a binary tree. Cannot rob directly connected houses (parent-child).

```java
public int rob(TreeNode root) {
    int[] result = dfs(root);
    return Math.max(result[0], result[1]);
}

// result[0] = max money NOT robbing this node
// result[1] = max money robbing this node
private int[] dfs(TreeNode node) {
    if (node == null) return new int[]{0, 0};
    
    int[] left = dfs(node.left);
    int[] right = dfs(node.right);
    
    int notRob = Math.max(left[0], left[1]) + Math.max(right[0], right[1]);
    int rob = node.val + left[0] + right[0];  // can't rob children
    
    return new int[]{notRob, rob};
}
```

```
Time:  O(n) where n = number of nodes
Space: O(h) where h = height of tree (recursion stack)
```

**JVM insight**: Each recursive call allocates a 2-element `int[]` on the heap. For `n` nodes, that is `n` small arrays. These are short-lived and will be collected in the next young-generation GC. The JIT might apply escape analysis and scalar-replace them into stack variables, eliminating the allocation entirely.

**Alternative**: Use a `HashMap<TreeNode, int[]>` for memoization if using the naive recursive approach without the two-state return.

---

**P17.36** [H] -- Binary Tree Cameras (LeetCode 968)

Place cameras on tree nodes. A camera monitors itself, its parent, and its children. Find the minimum cameras to monitor all nodes.

```java
private int cameras = 0;

public int minCameraCover(TreeNode root) {
    cameras = 0;
    int rootState = dfs(root);
    // If root is not monitored, it needs a camera
    if (rootState == 0) cameras++;
    return cameras;
}

// Returns: 0 = NOT monitored, 1 = HAS camera, 2 = monitored (no camera)
private int dfs(TreeNode node) {
    if (node == null) return 2;  // null nodes are "monitored" (no need)
    
    int left = dfs(node.left);
    int right = dfs(node.right);
    
    // If any child is NOT monitored, this node MUST have a camera
    if (left == 0 || right == 0) {
        cameras++;
        return 1;
    }
    
    // If any child HAS a camera, this node is monitored
    if (left == 1 || right == 1) return 2;
    
    // Both children are monitored but have no cameras => this node is NOT monitored
    return 0;
}
```

```
Time:  O(n)
Space: O(h)
```

**JVM insight**: The instance variable `cameras` makes this solution non-thread-safe. In production code, you would pass a mutable counter or use `AtomicInteger`. For interviews, instance variables are fine.

**Real-world correlation**: **Security camera placement** is the literal application. In network security, placing IDS (Intrusion Detection Systems) at network nodes to monitor all traffic with minimum hardware is this same dominating-set problem on a tree.

---

**P17.37** [M] -- Diameter of Binary Tree (LeetCode 543)

Find the length of the longest path between any two nodes (the path does not need to pass through the root).

```java
private int diameter = 0;

public int diameterOfBinaryTree(TreeNode root) {
    diameter = 0;
    depth(root);
    return diameter;
}

private int depth(TreeNode node) {
    if (node == null) return 0;
    int left = depth(node.left);
    int right = depth(node.right);
    diameter = Math.max(diameter, left + right);  // path through this node
    return 1 + Math.max(left, right);  // return height for parent
}
```

```
Time:  O(n)
Space: O(h)
```

**Real-world correlation**: **Network diameter**. In a tree-structured network (like a spanning tree), the diameter determines the worst-case latency between any two nodes. This directly affects SLA guarantees for distributed systems.

---

**P17.38** [M] -- Distribute Coins in Binary Tree (LeetCode 979)

Each node has some coins. In one move, transfer one coin between adjacent nodes. Find minimum moves to give every node exactly one coin.

```java
private int moves = 0;

public int distributeCoins(TreeNode root) {
    moves = 0;
    dfs(root);
    return moves;
}

// Returns excess coins in subtree (positive = excess, negative = deficit)
private int dfs(TreeNode node) {
    if (node == null) return 0;
    int leftExcess = dfs(node.left);
    int rightExcess = dfs(node.right);
    
    // Each unit of excess/deficit in children requires one move per unit across the edge
    moves += Math.abs(leftExcess) + Math.abs(rightExcess);
    
    // This node's excess: its coins - 1 (for itself) + children's excess
    return node.val - 1 + leftExcess + rightExcess;
}
```

```
Time:  O(n)
Space: O(h)
```

**Real-world correlation**: **Load redistribution in distributed storage**. When data nodes in HDFS or Cassandra become unbalanced (some hold too much data, others too little), the rebalancing algorithm computes the minimum data transfers -- exactly this problem on the cluster topology tree.

---

**P17.39** [M] -- Maximum Product of Splitted Binary Tree (LeetCode 1339)

Split a binary tree by removing one edge. Maximize the product of the two subtree sums.

```java
private long totalSum;
private long maxProduct;

public int maxProduct(TreeNode root) {
    totalSum = 0;
    maxProduct = 0;
    
    // First pass: compute total sum
    totalSum = computeSum(root);
    
    // Second pass: for each subtree sum s, product = s * (totalSum - s)
    computeSum2(root);
    
    return (int)(maxProduct % 1_000_000_007);
}

private long computeSum(TreeNode node) {
    if (node == null) return 0;
    return node.val + computeSum(node.left) + computeSum(node.right);
}

private long computeSum2(TreeNode node) {
    if (node == null) return 0;
    long subtreeSum = node.val + computeSum2(node.left) + computeSum2(node.right);
    maxProduct = Math.max(maxProduct, subtreeSum * (totalSum - subtreeSum));
    return subtreeSum;
}
```

```
Time:  O(n)
Space: O(h)
```

**JVM insight**: Using `long` is critical here. Two subtree sums each up to 10^5 * 10^4 = 10^9. Their product is up to 10^18, which overflows `int` but fits in `long`. The modular reduction happens only at the end.

---

## 17.7 Sub-Pattern 6: Bitmask DP

### What It Is

When the problem involves choosing subsets from a *small* set (N <= 20-25), we can represent the chosen subset as a bitmask and use `dp[mask]` to store the answer for that subset. This converts an exponential search space into a structured DP table of size 2^N.

### How to Identify

- The input has N items where N is small (typically N <= 20)
- You need to consider all subsets or permutations
- The problem involves assignment/matching/visiting all elements
- Brute force is N! or 2^N, but with DP it becomes N * 2^N or N^2 * 2^N

### State Definition and Transition

```
State:      dp[mask] = answer when the set of used/visited elements is mask
            Sometimes: dp[mask][last] = answer when used elements = mask and last used = last
Transition: dp[mask | (1 << j)] = f(dp[mask], cost of adding element j)
            where j is not yet in mask: (mask & (1 << j)) == 0
Base:       dp[0] = initial value (empty set)
Answer:     dp[(1 << N) - 1] (all elements used)
```

### Template Code

```java
// Bitmask DP template
public int solveBitmask(int n, int[][] cost) {
    int fullMask = (1 << n) - 1;
    int[] dp = new int[1 << n];
    Arrays.fill(dp, Integer.MAX_VALUE);
    dp[0] = 0;  // base case: empty set
    
    for (int mask = 0; mask < (1 << n); mask++) {
        if (dp[mask] == Integer.MAX_VALUE) continue;
        
        int bits = Integer.bitCount(mask);  // number of elements already used
        // bits tells us which "position" we are filling next
        
        for (int j = 0; j < n; j++) {
            if ((mask & (1 << j)) != 0) continue;  // j already used
            int newMask = mask | (1 << j);
            dp[newMask] = Math.min(dp[newMask], dp[mask] + cost[bits][j]);
        }
    }
    return dp[fullMask];
}

// TSP variant: dp[mask][last] = min cost to visit cities in mask, ending at last
public int tsp(int n, int[][] dist) {
    int[][] dp = new int[1 << n][n];
    for (int[] row : dp) Arrays.fill(row, Integer.MAX_VALUE);
    dp[1][0] = 0;  // start at city 0
    
    for (int mask = 1; mask < (1 << n); mask++) {
        for (int u = 0; u < n; u++) {
            if (dp[mask][u] == Integer.MAX_VALUE) continue;
            if ((mask & (1 << u)) == 0) continue;  // u must be in mask
            
            for (int v = 0; v < n; v++) {
                if ((mask & (1 << v)) != 0) continue;  // v must not be in mask
                int newMask = mask | (1 << v);
                dp[newMask][v] = Math.min(dp[newMask][v], dp[mask][u] + dist[u][v]);
            }
        }
    }
    
    int ans = Integer.MAX_VALUE;
    for (int u = 0; u < n; u++) {
        if (dp[(1 << n) - 1][u] != Integer.MAX_VALUE) {
            ans = Math.min(ans, dp[(1 << n) - 1][u] + dist[u][0]);  // return to start
        }
    }
    return ans;
}
```

### Real-World Correlation

**Task assignment / scheduling**: Assign N tasks to N workers (or M machines) where each has different costs. With N = 20, bitmask DP handles it in O(N * 2^N) instead of O(N!).

**Hardware configuration**: Selecting a subset of hardware features to enable, where interactions between features create complex costs, is bitmask DP when the feature count is small.

**Test suite optimization**: Selecting the minimum set of test cases that cover all code paths (set cover approximation with bitmask for small path counts).

### Problems

---

**P17.40** [H] -- Traveling Salesman Problem (Classic)

Visit all N cities exactly once and return to start. Minimize total distance.

```java
public int tsp(int[][] dist) {
    int n = dist.length;
    int[][] dp = new int[1 << n][n];
    for (int[] row : dp) Arrays.fill(row, Integer.MAX_VALUE);
    dp[1][0] = 0;  // start at city 0
    
    for (int mask = 1; mask < (1 << n); mask++) {
        for (int u = 0; u < n; u++) {
            if (dp[mask][u] == Integer.MAX_VALUE) continue;
            if ((mask & (1 << u)) == 0) continue;
            
            for (int v = 0; v < n; v++) {
                if ((mask & (1 << v)) != 0) continue;
                int newMask = mask | (1 << v);
                dp[newMask][v] = Math.min(dp[newMask][v], dp[mask][u] + dist[u][v]);
            }
        }
    }
    
    int fullMask = (1 << n) - 1;
    int ans = Integer.MAX_VALUE;
    for (int u = 0; u < n; u++) {
        if (dp[fullMask][u] != Integer.MAX_VALUE) {
            ans = Math.min(ans, dp[fullMask][u] + dist[u][0]);
        }
    }
    return ans;
}
```

```
Time:  O(n^2 × 2^n)
Space: O(n × 2^n)
```

**JVM insight**: For `n = 20`, the DP table is `20 × 2^20 = 20 × 1,048,576 = 20,971,520` ints = ~80 MB. This fits in a standard JVM heap but is significant. For `n = 25`, it is ~3.2 GB -- you need `-Xmx4g`. For `n > 25`, this approach becomes impractical.

**Real-world correlation**: **Delivery route optimization** (FedEx, UPS, Amazon delivery), **PCB drill path optimization** (minimizing head movement), **genome assembly** (finding Hamiltonian paths through overlap graphs).

---

**P17.41** [M] -- Partition to K Equal Sum Subsets (LeetCode 698)

Can you partition an array into K subsets with equal sum?

```java
public boolean canPartitionKSubsets(int[] nums, int k) {
    int sum = 0;
    for (int num : nums) sum += num;
    if (sum % k != 0) return false;
    int target = sum / k;
    
    int n = nums.length;
    int[] dp = new int[1 << n];
    Arrays.fill(dp, -1);
    dp[0] = 0;  // sum of current bucket for empty set = 0
    
    Arrays.sort(nums);  // optimization: try larger numbers first to prune
    
    for (int mask = 0; mask < (1 << n); mask++) {
        if (dp[mask] == -1) continue;
        
        for (int j = 0; j < n; j++) {
            if ((mask & (1 << j)) != 0) continue;  // j already used
            int newSum = dp[mask] + nums[j];
            if (newSum > target) continue;  // would exceed target for current bucket
            
            int newMask = mask | (1 << j);
            dp[newMask] = newSum % target;
            // When newSum == target, the bucket is full, reset to 0
        }
    }
    return dp[(1 << n) - 1] == 0;
}
```

```
Time:  O(n × 2^n)
Space: O(2^n)
```

**JVM insight**: `Arrays.sort(nums)` before the bitmask loop does not change correctness but can improve cache behavior by processing elements in a predictable order. The `% target` reset when a bucket fills is the key trick -- it avoids tracking which bucket we are filling.

---

**P17.42** [H] -- Shortest Superstring (LeetCode 943)

Find the shortest string that contains each word as a substring.

```java
public String shortestSuperstring(String[] words) {
    int n = words.length;
    
    // Precompute overlap[i][j] = length of suffix of words[i] that matches prefix of words[j]
    int[][] overlap = new int[n][n];
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < n; j++) {
            if (i == j) continue;
            for (int k = Math.min(words[i].length(), words[j].length()); k >= 0; k--) {
                if (words[i].endsWith(words[j].substring(0, k))) {
                    overlap[i][j] = k;
                    break;
                }
            }
        }
    }
    
    // dp[mask][last] = max total overlap when used words = mask, ending with words[last]
    int[][] dp = new int[1 << n][n];
    int[][] parent = new int[1 << n][n];  // for reconstruction
    for (int[] row : parent) Arrays.fill(row, -1);
    
    for (int mask = 0; mask < (1 << n); mask++) {
        for (int last = 0; last < n; last++) {
            if ((mask & (1 << last)) == 0) continue;
            int prevMask = mask ^ (1 << last);
            if (prevMask == 0) continue;
            
            for (int prev = 0; prev < n; prev++) {
                if ((prevMask & (1 << prev)) == 0) continue;
                int val = dp[prevMask][prev] + overlap[prev][last];
                if (val > dp[mask][last]) {
                    dp[mask][last] = val;
                    parent[mask][last] = prev;
                }
            }
        }
    }
    
    // Find best ending word
    int fullMask = (1 << n) - 1;
    int last = 0;
    for (int i = 1; i < n; i++) {
        if (dp[fullMask][i] > dp[fullMask][last]) last = i;
    }
    
    // Reconstruct
    int[] order = new int[n];
    int mask = fullMask;
    for (int i = n - 1; i >= 0; i--) {
        order[i] = last;
        int prev = parent[mask][last];
        mask ^= (1 << last);
        last = prev;
    }
    
    // Build result
    StringBuilder sb = new StringBuilder(words[order[0]]);
    for (int i = 1; i < n; i++) {
        int ov = overlap[order[i - 1]][order[i]];
        sb.append(words[order[i]].substring(ov));
    }
    return sb.toString();
}
```

```
Time:  O(n^2 × 2^n)
Space: O(n × 2^n)
```

**Real-world correlation**: **Genome assembly**. Short DNA reads from sequencing machines must be assembled into a full genome. Finding the shortest superstring of all reads is the core computational challenge. In practice, heuristics are used for thousands of reads, but the exact DP solution handles small instances.

---

**P17.43** [M] -- Can I Win (LeetCode 464)

Two players take turns picking from 1 to maxChoosableInteger (no reuse). First to reach or exceed desiredTotal wins. Can player 1 win with optimal play?

```java
public boolean canIWin(int maxChoosableInteger, int desiredTotal) {
    int sum = maxChoosableInteger * (maxChoosableInteger + 1) / 2;
    if (sum < desiredTotal) return false;  // impossible to reach total
    if (desiredTotal <= 0) return true;
    
    Map<Integer, Boolean> memo = new HashMap<>();
    return canWin(0, desiredTotal, maxChoosableInteger, memo);
}

private boolean canWin(int mask, int remaining, int max, Map<Integer, Boolean> memo) {
    if (memo.containsKey(mask)) return memo.get(mask);
    
    for (int i = 1; i <= max; i++) {
        if ((mask & (1 << i)) != 0) continue;  // i already used
        
        // Current player picks i
        if (i >= remaining || !canWin(mask | (1 << i), remaining - i, max, memo)) {
            // Either we win immediately, or opponent loses from the new state
            memo.put(mask, true);
            return true;
        }
    }
    
    memo.put(mask, false);
    return false;
}
```

```
Time:  O(2^n × n) where n = maxChoosableInteger
Space: O(2^n)
```

**JVM insight**: The `HashMap<Integer, Boolean>` uses boxed types. For `maxChoosableInteger = 20`, there are up to 2^20 = 1M states. Each HashMap entry is ~50 bytes (Node + boxed Integer + boxed Boolean). Total: ~50 MB. An `int[]` or `byte[]` indexed by mask would be far more efficient:

```java
// Optimization: use byte array (0=unvisited, 1=true, 2=false)
byte[] memo = new byte[1 << (max + 1)];
```

---

**P17.44** [H] -- Maximum Students Taking Exam (LeetCode 1349)

Place students in seats (some broken). No cheating (no adjacent students to left, right, upper-left, upper-right).

```java
public int maxStudents(char[][] seats) {
    int m = seats.length, n = seats[0].length;
    int[] validMask = new int[m];
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (seats[i][j] == '.') validMask[i] |= (1 << j);
        }
    }
    
    // dp[mask] = max students in previous row with seating pattern = mask
    int[] dp = new int[1 << n];
    Arrays.fill(dp, -1);
    dp[0] = 0;
    int ans = 0;
    
    for (int i = 0; i < m; i++) {
        int[] newDp = new int[1 << n];
        Arrays.fill(newDp, -1);
        
        for (int curr = validMask[i]; ; curr = (curr - 1) & validMask[i]) {
            // Check no two adjacent in curr
            if ((curr & (curr << 1)) != 0) {
                if (curr == 0) break;
                continue;
            }
            
            int count = Integer.bitCount(curr);
            
            for (int prev = 0; prev < (1 << n); prev++) {
                if (dp[prev] == -1) continue;
                // Check no upper-left or upper-right cheating
                if ((curr & (prev << 1)) != 0 || (curr & (prev >> 1)) != 0) continue;
                
                int total = dp[prev] + count;
                newDp[curr] = Math.max(newDp[curr], total);
                ans = Math.max(ans, total);
            }
            
            if (curr == 0) break;
        }
        dp = newDp;
    }
    return ans;
}
```

```
Time:  O(m × 4^n) worst case, practically much less due to pruning
Space: O(2^n)
```

**JVM insight**: The trick `curr = (curr - 1) & validMask[i]` enumerates all submasks of `validMask[i]` in O(3^n) total across all starting masks. This bit manipulation avoids iterating over invalid masks entirely.

---

**P17.45** [H] -- Number of Ways to Wear Different Hats (LeetCode 1434)

`n` people, 40 hats. Each person has a preference list. Count ways to assign distinct hats.

```java
public int numberWays(List<List<Integer>> hats) {
    int n = hats.size();  // n <= 10
    int MOD = 1_000_000_007;
    
    // Invert: for each hat, which people can wear it
    List<List<Integer>> hatToPeople = new ArrayList<>();
    for (int h = 0; h <= 40; h++) hatToPeople.add(new ArrayList<>());
    for (int p = 0; p < n; p++) {
        for (int h : hats.get(p)) {
            hatToPeople.get(h).add(p);
        }
    }
    
    int fullMask = (1 << n) - 1;
    // dp[mask] = number of ways to assign hats to people in mask
    int[] dp = new int[1 << n];
    dp[0] = 1;
    
    for (int h = 1; h <= 40; h++) {
        if (hatToPeople.get(h).isEmpty()) continue;
        // Iterate masks in REVERSE to avoid reusing hat h
        for (int mask = fullMask; mask >= 0; mask--) {
            for (int p : hatToPeople.get(h)) {
                if ((mask & (1 << p)) != 0) continue;  // person p already has a hat
                dp[mask | (1 << p)] = (int)((dp[mask | (1 << p)] + (long)dp[mask]) % MOD);
            }
        }
    }
    return dp[fullMask];
}
```

```
Time:  O(40 × 2^n × n)
Space: O(2^n)
```

**Key insight**: Bitmask over *people* (n <= 10), not hats (up to 40). This keeps the mask size manageable (2^10 = 1024 vs 2^40 which is impossible).

---

## 17.8 Sub-Pattern 7: String DP

### What It Is

A specialized family of 2D DP problems focused on string operations: pattern matching (regex, wildcards), palindrome analysis, and subsequence problems. While there is overlap with Section 17.3 (2D String DP), the problems here have more complex transitions specific to string semantics.

### How to Identify

The problem involves:
- Matching a string against a pattern (regex, wildcard, templates)
- Palindrome detection, construction, or transformation
- String transformation with specific allowed operations

### State Definition and Transition

```
Pattern Matching:
  State:      dp[i][j] = does pattern[0..i-1] match text[0..j-1]?
  Transition: depends on pattern character (literal, '.', '*', '?')

Palindrome:
  State:      dp[i][j] = is s[i..j] a palindrome? (or: answer for substring s[i..j])
  Transition: dp[i][j] = (s[i] == s[j]) && dp[i+1][j-1]
```

### Template Code

```java
// Palindrome substring DP template
public boolean[][] computePalindromes(String s) {
    int n = s.length();
    boolean[][] isPalin = new boolean[n][n];
    
    // Base: single characters are palindromes
    for (int i = 0; i < n; i++) isPalin[i][i] = true;
    
    // Base: two-character palindromes
    for (int i = 0; i < n - 1; i++) {
        isPalin[i][i + 1] = (s.charAt(i) == s.charAt(i + 1));
    }
    
    // Fill by increasing length
    for (int len = 3; len <= n; len++) {
        for (int i = 0; i <= n - len; i++) {
            int j = i + len - 1;
            isPalin[i][j] = (s.charAt(i) == s.charAt(j)) && isPalin[i + 1][j - 1];
        }
    }
    return isPalin;
}
```

### Real-World Correlation

**Regex engines**: Every regex match in your web framework, log parser, or data validation layer is running a form of string DP. The NFA/DFA-based engines use state machines, but backtracking engines effectively run memoized recursion.

**DNA analysis**: Finding palindromic sequences in DNA (restriction enzyme recognition sites) and computing edit distances for sequence alignment are direct applications.

### Problems

---

**P17.46** [H] -- Regular Expression Matching (LeetCode 10)

Implement regex matching with `.` (matches any single character) and `*` (zero or more of the preceding element).

```java
public boolean isMatch(String s, String p) {
    int m = s.length(), n = p.length();
    boolean[][] dp = new boolean[m + 1][n + 1];
    dp[0][0] = true;
    
    // Base case: empty string matches patterns like a*, a*b*, a*b*c*
    for (int j = 2; j <= n; j++) {
        if (p.charAt(j - 1) == '*') {
            dp[0][j] = dp[0][j - 2];
        }
    }
    
    for (int i = 1; i <= m; i++) {
        for (int j = 1; j <= n; j++) {
            char pc = p.charAt(j - 1);
            char sc = s.charAt(i - 1);
            
            if (pc == '*') {
                // Option 1: zero occurrences of the preceding element
                dp[i][j] = dp[i][j - 2];
                // Option 2: one or more occurrences (if preceding matches)
                char preceding = p.charAt(j - 2);
                if (preceding == '.' || preceding == sc) {
                    dp[i][j] = dp[i][j] || dp[i - 1][j];
                }
            } else if (pc == '.' || pc == sc) {
                dp[i][j] = dp[i - 1][j - 1];
            }
        }
    }
    return dp[m][n];
}
```

```
Time:  O(m × n)
Space: O(m × n), reducible to O(n)
```

**JVM insight**: Java's `Pattern.compile` and `Matcher` use a compiled NFA (actually a specialized backtracking engine). For pathological patterns like `a*a*a*a*...b` on input `aaa...a`, the backtracking engine can be exponential. The DP approach here is always O(m*n) -- no pathological cases.

**Real-world correlation**: **ReDoS (Regular Expression Denial of Service)**. The reason why you should never use user-supplied regex on a server: backtracking regex engines can be exponentially slow. The DP approach is immune to ReDoS because it guarantees O(m*n) time.

---

**P17.47** [H] -- Wildcard Matching (LeetCode 44)

Match with `?` (any single character) and `*` (any sequence of characters, including empty).

```java
public boolean isMatch(String s, String p) {
    int m = s.length(), n = p.length();
    boolean[][] dp = new boolean[m + 1][n + 1];
    dp[0][0] = true;
    
    // Base case: empty string matches leading *s
    for (int j = 1; j <= n; j++) {
        if (p.charAt(j - 1) == '*') dp[0][j] = dp[0][j - 1];
    }
    
    for (int i = 1; i <= m; i++) {
        for (int j = 1; j <= n; j++) {
            char pc = p.charAt(j - 1);
            if (pc == '*') {
                dp[i][j] = dp[i][j - 1] ||  // * matches empty
                            dp[i - 1][j];    // * matches one more character
            } else if (pc == '?' || pc == s.charAt(i - 1)) {
                dp[i][j] = dp[i - 1][j - 1];
            }
        }
    }
    return dp[m][n];
}
```

```
Time:  O(m × n)
Space: O(m × n), reducible to O(n)
```

**Key difference from regex**: In wildcard matching, `*` is standalone and matches any sequence. In regex, `*` modifies the preceding character. This makes wildcard matching simpler (no need to look back two positions for `x*` patterns).

**Real-world correlation**: **File globbing**. When you type `ls *.java` in a shell, the glob expansion uses wildcard matching. Kubernetes uses glob patterns for pod selectors, and Nginx uses them for location matching.

---

**P17.48** [M] -- Palindrome Partitioning (LeetCode 131)

Partition a string such that every substring is a palindrome. Return all partitions.

```java
public List<List<String>> partition(String s) {
    int n = s.length();
    boolean[][] isPalin = new boolean[n][n];
    
    // Precompute palindromes
    for (int i = n - 1; i >= 0; i--) {
        for (int j = i; j < n; j++) {
            isPalin[i][j] = (s.charAt(i) == s.charAt(j)) &&
                            (j - i <= 2 || isPalin[i + 1][j - 1]);
        }
    }
    
    List<List<String>> result = new ArrayList<>();
    backtrack(s, 0, isPalin, new ArrayList<>(), result);
    return result;
}

private void backtrack(String s, int start, boolean[][] isPalin,
                       List<String> current, List<List<String>> result) {
    if (start == s.length()) {
        result.add(new ArrayList<>(current));
        return;
    }
    for (int end = start; end < s.length(); end++) {
        if (isPalin[start][end]) {
            current.add(s.substring(start, end + 1));
            backtrack(s, end + 1, isPalin, current, result);
            current.remove(current.size() - 1);
        }
    }
}
```

```
Time:  O(n × 2^n) worst case (exponential partitions possible)
Space: O(n^2) for palindrome table + O(n) for recursion
```

**JVM insight**: The `s.substring(start, end + 1)` creates a new String on each call. For the backtracking approach, these strings are immediately added to `current` and then removed -- short-lived objects that the young generation GC handles efficiently. If memory is a concern, store indices instead of substrings and build strings only for the final result.

---

**P17.49** [M] -- Longest Palindromic Subsequence (LeetCode 516)

Find the length of the longest palindromic subsequence.

```java
public int longestPalinSubseq(String s) {
    int n = s.length();
    int[] dp = new int[n];
    Arrays.fill(dp, 1);  // single characters
    
    for (int i = n - 2; i >= 0; i--) {
        int prev = 0;  // dp[i+1][j-1] in the 2D version
        for (int j = i + 1; j < n; j++) {
            int temp = dp[j];
            if (s.charAt(i) == s.charAt(j)) {
                dp[j] = prev + 2;
            } else {
                dp[j] = Math.max(dp[j], dp[j - 1]);
            }
            prev = temp;
        }
    }
    return dp[n - 1];
}
```

```
Time:  O(n^2)
Space: O(n)
```

**Alternative insight**: LPS(s) = LCS(s, reverse(s)). This reduction works because the longest common subsequence of a string and its reverse is exactly the longest palindromic subsequence.

**Real-world correlation**: **RNA structure prediction**. RNA molecules fold back on themselves, forming palindromic base-pair sequences. The longest palindromic subsequence helps predict secondary structure folding patterns.

---

**P17.50** [M] -- Minimum Insertions to Make a String Palindrome (LeetCode 1312)

Find the minimum number of insertions to make the string a palindrome.

```java
public int minInsertions(String s) {
    // Answer = n - LPS(s)
    // Characters not in the LPS need one insertion each to "mirror" them
    return s.length() - longestPalinSubseq(s);
}

private int longestPalinSubseq(String s) {
    int n = s.length();
    int[] dp = new int[n];
    Arrays.fill(dp, 1);
    
    for (int i = n - 2; i >= 0; i--) {
        int prev = 0;
        for (int j = i + 1; j < n; j++) {
            int temp = dp[j];
            if (s.charAt(i) == s.charAt(j)) {
                dp[j] = prev + 2;
            } else {
                dp[j] = Math.max(dp[j], dp[j - 1]);
            }
            prev = temp;
        }
    }
    return dp[n - 1];
}
```

```
Time:  O(n^2)
Space: O(n)
```

---

**P17.51** [H] -- Scramble String (LeetCode 87)

Given two strings, determine if one is a "scramble" of the other (recursively split and optionally swap).

```java
public boolean isScramble(String s1, String s2) {
    int n = s1.length();
    if (n != s2.length()) return false;
    
    // dp[len][i][j] = is s1[i..i+len-1] a scramble of s2[j..j+len-1]
    boolean[][][] dp = new boolean[n + 1][n][n];
    
    // Base case: length 1
    for (int i = 0; i < n; i++)
        for (int j = 0; j < n; j++)
            dp[1][i][j] = (s1.charAt(i) == s2.charAt(j));
    
    for (int len = 2; len <= n; len++) {
        for (int i = 0; i <= n - len; i++) {
            for (int j = 0; j <= n - len; j++) {
                for (int k = 1; k < len; k++) {
                    // No swap: left with left, right with right
                    if (dp[k][i][j] && dp[len - k][i + k][j + k]) {
                        dp[len][i][j] = true;
                        break;
                    }
                    // Swap: left with right, right with left
                    if (dp[k][i][j + len - k] && dp[len - k][i + k][j]) {
                        dp[len][i][j] = true;
                        break;
                    }
                }
            }
        }
    }
    return dp[n][0][0];
}
```

```
Time:  O(n^4)
Space: O(n^3)
```

**JVM insight**: The 3D `boolean[n+1][n][n]` array for `n = 30` is `31 × 30 × 30 = 27,900` bytes -- trivial. But for the top-down approach, the memoization key would be `(i, j, len)` which maps cleanly to this 3D array.

---

## 17.9 Sub-Pattern 8: State Machine DP

### What It Is

Problems where you model the situation as a finite state machine. At each step, you are in one of several states, and you can transition between states according to rules. `dp[i][state]` represents the optimal value at step `i` while in `state`.

### How to Identify

The problem has:
- A sequence of decisions over time steps
- A small number of "modes" or "statuses" at each step
- Transitions depend on the current mode and the input at that step
- The classic example: stock buy/sell problems with constraints

### State Definition and Transition

```
State:      dp[i][s] = optimal value at time step i in state s
Transition: dp[i][s'] = f(dp[i-1][s], input[i]) for each valid transition s → s'
Base:       dp[0][initial_state] = initial value
Answer:     max/min over all valid ending states at step n
```

### Template Code

```java
// State machine DP template (stock trading example)
public int solve(int[] prices) {
    int n = prices.length;
    // States: HOLDING, NOT_HOLDING (possibly COOLDOWN)
    int[][] dp = new int[n][NUM_STATES];
    
    // Base cases at day 0
    dp[0][HOLDING] = -prices[0];     // bought on day 0
    dp[0][NOT_HOLDING] = 0;          // did nothing on day 0
    
    for (int i = 1; i < n; i++) {
        dp[i][HOLDING] = Math.max(dp[i-1][HOLDING],          // hold
                                  dp[i-1][NOT_HOLDING] - prices[i]); // buy
        dp[i][NOT_HOLDING] = Math.max(dp[i-1][NOT_HOLDING],  // rest
                                      dp[i-1][HOLDING] + prices[i]); // sell
    }
    return dp[n-1][NOT_HOLDING];
}
```

### Real-World Correlation

**TCP connection states**: The TCP state machine (LISTEN, SYN_SENT, SYN_RECEIVED, ESTABLISHED, FIN_WAIT_1, etc.) can be modeled as state machine DP for analyzing protocol behavior over time.

**Thread scheduling**: The JVM thread states (NEW, RUNNABLE, BLOCKED, WAITING, TIMED_WAITING, TERMINATED) form a state machine. Optimizing throughput given scheduling constraints is state machine DP.

**Viterbi algorithm**: The most famous state machine DP in practice -- used in speech recognition, HMM decoding, error-correcting codes, and bioinformatics. Given a Hidden Markov Model, find the most likely state sequence given observations.

### Problems: Best Time to Buy and Sell Stock (All 6 Variants)

---

**P17.52** [E] -- Best Time to Buy and Sell Stock I (LeetCode 121)

One transaction allowed. Find maximum profit.

```java
public int maxProfit(int[] prices) {
    int minPrice = Integer.MAX_VALUE;
    int maxProfit = 0;
    
    for (int price : prices) {
        minPrice = Math.min(minPrice, price);
        maxProfit = Math.max(maxProfit, price - minPrice);
    }
    return maxProfit;
}
```

```
Time:  O(n)
Space: O(1)
```

**State machine view**:
```
States: NOT_HOLDING (start), HOLDING (after buy), SOLD (after sell, terminal)
dp[i][NOT_HOLDING] = 0 (haven't bought yet, profit = 0)
dp[i][HOLDING] = max(dp[i-1][HOLDING], -prices[i])  // best price to buy
dp[i][SOLD] = max(dp[i-1][SOLD], dp[i-1][HOLDING] + prices[i])
```

**JVM insight**: This single-pass algorithm is ideal for stream processing. You could process a live price feed and maintain max profit in O(1) per tick.

---

**P17.53** [M] -- Best Time to Buy and Sell Stock II (LeetCode 122)

Unlimited transactions. Find maximum profit.

```java
public int maxProfit(int[] prices) {
    int profit = 0;
    for (int i = 1; i < prices.length; i++) {
        if (prices[i] > prices[i - 1]) {
            profit += prices[i] - prices[i - 1];
        }
    }
    return profit;
}

// State machine version (more generalizable)
public int maxProfitSM(int[] prices) {
    int hold = -prices[0];  // dp[HOLDING]
    int notHold = 0;        // dp[NOT_HOLDING]
    
    for (int i = 1; i < prices.length; i++) {
        int newHold = Math.max(hold, notHold - prices[i]);    // buy
        int newNotHold = Math.max(notHold, hold + prices[i]); // sell
        hold = newHold;
        notHold = newNotHold;
    }
    return notHold;
}
```

```
Time:  O(n)
Space: O(1)
```

**Key insight**: The greedy approach (take every upward slope) works because there is no limit on transactions. The state machine approach generalizes to all variants.

---

**P17.54** [H] -- Best Time to Buy and Sell Stock III (LeetCode 123)

At most 2 transactions. Find maximum profit.

```java
public int maxProfit(int[] prices) {
    // 4 states: after 1st buy, after 1st sell, after 2nd buy, after 2nd sell
    int buy1 = Integer.MIN_VALUE, sell1 = 0;
    int buy2 = Integer.MIN_VALUE, sell2 = 0;
    
    for (int price : prices) {
        buy1 = Math.max(buy1, -price);            // buy 1st stock
        sell1 = Math.max(sell1, buy1 + price);     // sell 1st stock
        buy2 = Math.max(buy2, sell1 - price);      // buy 2nd stock
        sell2 = Math.max(sell2, buy2 + price);     // sell 2nd stock
    }
    return sell2;
}
```

```
Time:  O(n)
Space: O(1)
```

**JVM insight**: The four variables (`buy1`, `sell1`, `buy2`, `sell2`) will all be register-allocated by the JIT. This entire loop runs without a single memory access (after the array element load). The order of updates within the loop matters: updating `sell2` last ensures it sees the new `buy2`, which sees the new `sell1`, which sees the new `buy1` -- all from the same day's price. This is correct because you cannot buy and sell on the same day (buying "resets" to the best state seen so far).

---

**P17.55** [H] -- Best Time to Buy and Sell Stock IV (LeetCode 188)

At most `k` transactions. Find maximum profit.

```java
public int maxProfit(int k, int[] prices) {
    int n = prices.length;
    if (n == 0 || k == 0) return 0;
    
    // Optimization: if k >= n/2, it's unlimited transactions
    if (k >= n / 2) {
        int profit = 0;
        for (int i = 1; i < n; i++) {
            profit += Math.max(0, prices[i] - prices[i - 1]);
        }
        return profit;
    }
    
    // dp: buy[j] = best profit after j-th buy
    //     sell[j] = best profit after j-th sell
    int[] buy = new int[k + 1];
    int[] sell = new int[k + 1];
    Arrays.fill(buy, Integer.MIN_VALUE);
    
    for (int price : prices) {
        for (int j = 1; j <= k; j++) {
            buy[j] = Math.max(buy[j], sell[j - 1] - price);
            sell[j] = Math.max(sell[j], buy[j] + price);
        }
    }
    return sell[k];
}
```

```
Time:  O(n × k)
Space: O(k)
```

**JVM insight**: The `k >= n/2` optimization is critical. Without it, `k = 10^9` would create a 4 GB array. This optimization reduces to the unlimited transaction case when `k` is large enough that the constraint is never binding.

---

**P17.56** [M] -- Best Time to Buy and Sell Stock with Cooldown (LeetCode 309)

Unlimited transactions, but must wait 1 day after selling before buying again.

```java
public int maxProfit(int[] prices) {
    int n = prices.length;
    if (n <= 1) return 0;
    
    int hold = -prices[0];   // holding stock
    int sold = 0;             // just sold (cooldown next day)
    int rest = 0;             // not holding, not in cooldown
    
    for (int i = 1; i < n; i++) {
        int newHold = Math.max(hold, rest - prices[i]);     // buy from rest
        int newSold = hold + prices[i];                      // sell
        int newRest = Math.max(rest, sold);                  // cooldown or stay
        
        hold = newHold;
        sold = newSold;
        rest = newRest;
    }
    return Math.max(sold, rest);
}
```

```
Time:  O(n)
Space: O(1)
```

**State transition diagram**:
```
          buy                sell
  REST --------→ HOLD --------→ SOLD
    ↑                              │
    └──────── cooldown ────────────┘
```

**Real-world correlation**: **Rate-limited API trading**. Many stock exchanges enforce cooldown periods between orders (to prevent high-frequency manipulation). This DP models optimal trading under such constraints.

---

**P17.57** [M] -- Best Time to Buy and Sell Stock with Transaction Fee (LeetCode 714)

Unlimited transactions, but each transaction incurs a fee.

```java
public int maxProfit(int[] prices, int fee) {
    int hold = -prices[0];  // holding stock
    int notHold = 0;        // not holding stock
    
    for (int i = 1; i < prices.length; i++) {
        int newHold = Math.max(hold, notHold - prices[i]);
        int newNotHold = Math.max(notHold, hold + prices[i] - fee);
        hold = newHold;
        notHold = newNotHold;
    }
    return notHold;
}
```

```
Time:  O(n)
Space: O(1)
```

**JVM insight**: Subtracting `fee` on sell (not buy) is arbitrary but consistent. If `hold + prices[i] - fee` could overflow, use `long`. With stock prices up to 50000 and fee up to 50000, the max intermediate value is ~100000, well within `int` range.

**Real-world correlation**: **Brokerage optimization**. This is the literal model for optimizing trading profits when each trade incurs a fixed commission. The fee threshold determines whether a small price movement is worth trading on.

---

## 17.10 Sub-Pattern 9: Digit DP (Advanced)

### What It Is

Count numbers in a range `[L, R]` that satisfy certain digit-based properties. The key insight: count(L, R) = count(0, R) - count(0, L-1). Then count(0, N) is computed digit by digit using DP.

### How to Identify

The problem asks: "How many numbers from L to R have property X?" where X depends on the digits of the number (e.g., all digits unique, no repeated digits, digit sum equals K, etc.).

### State Definition and Transition

```
State: dp(pos, tight, started, extra_state)
  - pos:     current digit position (0 to numDigits-1)
  - tight:   are we still bounded by the upper limit?
  - started: have we placed a non-zero digit yet? (for leading zeros)
  - extra:   problem-specific state (digit mask, digit sum, etc.)

Transition: for each digit d from 0 to (tight ? digits[pos] : 9):
  dp(pos, tight, started, extra) += dp(pos+1, tight && d==digits[pos],
                                       started || d>0, updateExtra(extra, d))
```

### Template Code

```java
// Digit DP template
private String numStr;
private int[][] memo;  // or higher-dimensional

public int countUpTo(int N) {
    numStr = String.valueOf(N);
    memo = new int[numStr.length()][/* extra state size */];
    for (int[] row : memo) Arrays.fill(row, -1);
    return digitDP(0, true, false, 0);
}

private int digitDP(int pos, boolean tight, boolean started, int extra) {
    if (pos == numStr.length()) {
        return started ? 1 : 0;  // don't count "0" as a valid number if needed
    }
    
    // Memo lookup (only when not tight -- tight states are computed once)
    if (!tight && started && memo[pos][extra] != -1) {
        return memo[pos][extra];
    }
    
    int limit = tight ? (numStr.charAt(pos) - '0') : 9;
    int count = 0;
    
    for (int d = 0; d <= limit; d++) {
        if (!isValid(d, extra)) continue;  // problem-specific validity check
        count += digitDP(pos + 1,
                         tight && (d == limit),
                         started || (d > 0),
                         updateExtra(extra, d, started));
    }
    
    if (!tight && started) memo[pos][extra] = count;
    return count;
}
```

### Real-World Correlation

**Log analysis**: Counting entries in a numeric range with specific patterns (e.g., "how many request IDs between 10000 and 99999 have no repeated digits?").

**Generating valid identifiers**: Counting or enumerating valid serial numbers, credit card numbers (with digit constraints), or license plates.

### Problems

---

**P17.58** [M] -- Count Numbers with Unique Digits (LeetCode 357)

Given `n`, count numbers in `[0, 10^n)` with all unique digits.

```java
public int countNumbersWithUniqueDigits(int n) {
    if (n == 0) return 1;
    
    // Combinatorial approach (faster than digit DP for this specific problem)
    int result = 10;  // for n=1: 0-9
    int uniqueDigits = 9;  // first digit: 1-9
    int availableDigits = 9;  // remaining choices
    
    for (int i = 2; i <= n && i <= 10; i++) {
        uniqueDigits *= availableDigits;
        result += uniqueDigits;
        availableDigits--;
    }
    return result;
}

// Digit DP approach (generalizable)
public int countNumbersWithUniqueDigitsDP(int n) {
    if (n == 0) return 1;
    int limit = (int) Math.pow(10, n) - 1;
    return countUpTo(limit);
}

private int countUpTo(int N) {
    String s = String.valueOf(N);
    int len = s.length();
    // memo[pos][mask] where mask is bitmask of used digits
    Integer[][] memo = new Integer[len][1 << 10];
    return digitDP(s, 0, true, false, 0, memo) + 1; // +1 for 0
}

private int digitDP(String s, int pos, boolean tight, boolean started, int mask, Integer[][] memo) {
    if (pos == s.length()) return started ? 1 : 0;
    
    if (!tight && started && memo[pos][mask] != null) return memo[pos][mask];
    
    int limit = tight ? (s.charAt(pos) - '0') : 9;
    int count = 0;
    
    for (int d = 0; d <= limit; d++) {
        if (started && (mask & (1 << d)) != 0) continue;  // digit already used
        count += digitDP(s, pos + 1, tight && (d == limit),
                         started || (d > 0),
                         started || d > 0 ? mask | (1 << d) : mask, memo);
    }
    
    if (!tight && started) memo[pos][mask] = count;
    return count;
}
```

```
Time:  O(n × 2^10 × 10) for digit DP; O(n) for combinatorial
Space: O(n × 2^10) for digit DP; O(1) for combinatorial
```

**JVM insight**: The `Integer[][]` memo uses boxed Integers, where `null` serves as "unvisited". Using `int[][]` with `-1` as sentinel would be more memory-efficient but requires initialization with `Arrays.fill`.

---

**P17.59** [H] -- Numbers At Most N Given Digit Set (LeetCode 902)

Given a set of digits and an upper bound N, count numbers formed only from those digits.

```java
public int atMostNGivenDigitSet(String[] digits, int n) {
    String s = String.valueOf(n);
    int len = s.length();
    int d = digits.length;
    int count = 0;
    
    // Count numbers with fewer digits than N
    for (int i = 1; i < len; i++) {
        count += (int) Math.pow(d, i);
    }
    
    // Count numbers with same number of digits as N
    for (int i = 0; i < len; i++) {
        boolean hasSame = false;
        for (String digit : digits) {
            int di = digit.charAt(0) - '0';
            int ni = s.charAt(i) - '0';
            
            if (di < ni) {
                // All remaining positions can be any digit
                count += (int) Math.pow(d, len - i - 1);
            } else if (di == ni) {
                hasSame = true;
            }
        }
        if (!hasSame) break;
        if (i == len - 1) count++;  // N itself is valid
    }
    return count;
}
```

```
Time:  O(len × d) where len = number of digits in N
Space: O(1)
```

---

**P17.60** [H] -- Numbers with Repeated Digits (LeetCode 1012)

Count positive integers up to N that have at least one repeated digit.

```java
public int numDupDigitsAtMostN(int n) {
    // count(repeated) = n - count(all unique digits)
    return n - countUniqueDigits(n);
}

private int countUniqueDigits(int n) {
    String s = String.valueOf(n);
    int len = s.length();
    int count = 0;
    
    // Numbers with fewer digits than n (all unique)
    for (int i = 1; i < len; i++) {
        count += 9 * permutation(9, i - 1);  // first digit: 1-9, rest: any unused
    }
    
    // Numbers with same number of digits as n
    Set<Integer> used = new HashSet<>();
    for (int i = 0; i < len; i++) {
        int digit = s.charAt(i) - '0';
        int start = (i == 0) ? 1 : 0;
        
        for (int d = start; d < digit; d++) {
            if (used.contains(d)) continue;
            count += permutation(10 - i - 1, len - i - 1);
        }
        
        if (used.contains(digit)) break;
        used.add(digit);
        
        if (i == len - 1) count++;  // n itself has all unique digits
    }
    return count;
}

private int permutation(int n, int k) {
    int result = 1;
    for (int i = 0; i < k; i++) {
        result *= (n - i);
    }
    return result;
}
```

```
Time:  O(len^2) where len = number of digits
Space: O(len)
```

---

## 17.11 Additional Problems by Pattern

The following problems complete the 90-problem count, organized by the pattern they best demonstrate.

### Additional 1D DP

---

**P17.61** [E] -- Maximum Subarray (LeetCode 53) -- Kadane's Algorithm

Find the contiguous subarray with the largest sum.

```java
public int maxSubArray(int[] nums) {
    int maxSum = nums[0];
    int currentSum = nums[0];
    
    for (int i = 1; i < nums.length; i++) {
        currentSum = Math.max(nums[i], currentSum + nums[i]);
        maxSum = Math.max(maxSum, currentSum);
    }
    return maxSum;
}
```

```
Time:  O(n)
Space: O(1)
```

**DP interpretation**: `dp[i] = max subarray sum ending at index i`. Transition: `dp[i] = max(nums[i], dp[i-1] + nums[i])`. If the accumulated sum is negative, start fresh.

**JVM insight**: Kadane's algorithm is one of the most cache-friendly algorithms possible: a single forward pass through a contiguous array. The hardware prefetcher predicts every access perfectly. On a modern CPU with 64-byte cache lines and 4-byte ints, each cache line fetch provides 16 elements before the next miss.

**Real-world correlation**: **Maximum profit time window**. Finding the most profitable contiguous period for a business, the peak load window for capacity planning, or the highest-throughput interval in a benchmark -- all Kadane's.

---

**P17.62** [E] -- Counting Bits (LeetCode 338)

For every number from 0 to n, count the number of 1 bits.

```java
public int[] countBits(int n) {
    int[] dp = new int[n + 1];
    for (int i = 1; i <= n; i++) {
        dp[i] = dp[i >> 1] + (i & 1);
        // dp[i] = count for i/2 + last bit
    }
    return dp;
}
```

```
Time:  O(n)
Space: O(n)
```

**JVM insight**: `Integer.bitCount(i)` is a JVM intrinsic that compiles to a single `popcnt` instruction on x86 with SSE4.2. But the DP approach avoids calling `bitCount` n times and uses a different recurrence: the number of bits in `i` equals the number of bits in `i >> 1` (which we already computed) plus `i & 1` (the least significant bit).

---

**P17.63** [M] -- Maximum Product Subarray (LeetCode 152)

Find the contiguous subarray with the largest product.

```java
public int maxProduct(int[] nums) {
    int maxProd = nums[0], minProd = nums[0], result = nums[0];
    
    for (int i = 1; i < nums.length; i++) {
        if (nums[i] < 0) {
            // Swap: negative number flips max/min
            int temp = maxProd;
            maxProd = minProd;
            minProd = temp;
        }
        
        maxProd = Math.max(nums[i], maxProd * nums[i]);
        minProd = Math.min(nums[i], minProd * nums[i]);
        result = Math.max(result, maxProd);
    }
    return result;
}
```

```
Time:  O(n)
Space: O(1)
```

**Key insight**: We track both `maxProd` and `minProd` because a negative minimum can become the maximum when multiplied by another negative number. This is a state machine with two states.

---

**P17.64** [M] -- Longest Turbulent Subarray (LeetCode 978)

Find the length of the maximum-length turbulent subarray (alternating comparisons).

```java
public int maxTurbulenceSize(int[] arr) {
    int n = arr.length;
    if (n == 1) return 1;
    
    int inc = 1, dec = 1, result = 1;
    
    for (int i = 1; i < n; i++) {
        if (arr[i] > arr[i - 1]) {
            inc = dec + 1;
            dec = 1;
        } else if (arr[i] < arr[i - 1]) {
            dec = inc + 1;
            inc = 1;
        } else {
            inc = 1;
            dec = 1;
        }
        result = Math.max(result, Math.max(inc, dec));
    }
    return result;
}
```

```
Time:  O(n)
Space: O(1)
```

---

**P17.65** [M] -- Perfect Squares (LeetCode 279)

Find the minimum number of perfect squares that sum to `n`.

```java
public int numSquares(int n) {
    int[] dp = new int[n + 1];
    Arrays.fill(dp, Integer.MAX_VALUE);
    dp[0] = 0;
    
    for (int i = 1; i <= n; i++) {
        for (int j = 1; j * j <= i; j++) {
            dp[i] = Math.min(dp[i], dp[i - j * j] + 1);
        }
    }
    return dp[n];
}
```

```
Time:  O(n × sqrt(n))
Space: O(n)
```

**Mathematical insight**: By Lagrange's Four-Square Theorem, the answer is always 1, 2, 3, or 4. There is an O(sqrt(n)) mathematical solution using Legendre's three-square theorem, but the DP approach demonstrates unbounded knapsack thinking.

**Real-world correlation**: **Resource quantization**. When resources come in fixed sizes (e.g., memory pages of 4KB, 2MB, 1GB), finding the minimum number of pages to allocate exactly `n` bytes is a variant.

---

**P17.66** [M] -- Integer Break (LeetCode 343)

Break a positive integer `n` into at least two positive integers that sum to `n`. Maximize their product.

```java
public int integerBreak(int n) {
    int[] dp = new int[n + 1];
    dp[1] = 1;
    
    for (int i = 2; i <= n; i++) {
        for (int j = 1; j < i; j++) {
            dp[i] = Math.max(dp[i], Math.max(j, dp[j]) * (i - j));
            // j * (i-j): break into exactly two parts
            // dp[j] * (i-j): break j further, keep (i-j)
        }
    }
    return dp[n];
}
```

```
Time:  O(n^2)
Space: O(n)
```

**Mathematical insight**: The optimal strategy is to use as many 3s as possible (with adjustments for remainders). `integerBreak(n)` = `3^(n/3)` when `n % 3 == 0`, and similar for other remainders. This O(1) math approach is faster but the DP demonstrates the pattern.

---

### Additional 2D/Grid DP

---

**P17.67** [M] -- Maximal Square (LeetCode 221)

Find the area of the largest square of 1s in a binary matrix.

```java
public int maximalSquare(char[][] matrix) {
    int m = matrix.length, n = matrix[0].length;
    int[] dp = new int[n + 1];  // dp[j] = side length of largest square ending at (i,j)
    int maxSide = 0, prev = 0;
    
    for (int i = 1; i <= m; i++) {
        for (int j = 1; j <= n; j++) {
            int temp = dp[j];
            if (matrix[i - 1][j - 1] == '1') {
                dp[j] = Math.min(prev, Math.min(dp[j], dp[j - 1])) + 1;
                maxSide = Math.max(maxSide, dp[j]);
            } else {
                dp[j] = 0;
            }
            prev = temp;
        }
        prev = 0;  // reset for next row
    }
    return maxSide * maxSide;
}
```

```
Time:  O(m × n)
Space: O(n)
```

**Real-world correlation**: **Image processing / feature detection**. Finding the largest uniform region in an image is this problem. Industrial quality control systems use it to detect the largest defect-free area on a manufactured surface.

---

**P17.68** [H] -- Maximal Rectangle (LeetCode 85)

Find the area of the largest rectangle of 1s in a binary matrix.

```java
public int maximalRectangle(char[][] matrix) {
    if (matrix.length == 0) return 0;
    int n = matrix[0].length;
    int[] heights = new int[n];
    int maxArea = 0;
    
    for (char[] row : matrix) {
        for (int j = 0; j < n; j++) {
            heights[j] = row[j] == '1' ? heights[j] + 1 : 0;
        }
        maxArea = Math.max(maxArea, largestRectangleInHistogram(heights));
    }
    return maxArea;
}

private int largestRectangleInHistogram(int[] heights) {
    int n = heights.length;
    Deque<Integer> stack = new ArrayDeque<>();
    int maxArea = 0;
    
    for (int i = 0; i <= n; i++) {
        int h = (i == n) ? 0 : heights[i];
        while (!stack.isEmpty() && h < heights[stack.peek()]) {
            int height = heights[stack.pop()];
            int width = stack.isEmpty() ? i : i - stack.peek() - 1;
            maxArea = Math.max(maxArea, height * width);
        }
        stack.push(i);
    }
    return maxArea;
}
```

```
Time:  O(m × n)
Space: O(n)
```

**JVM insight**: This combines DP (building height histograms row by row) with a monotonic stack (finding the largest rectangle in each histogram). The `ArrayDeque` is used as a stack -- it is more efficient than `Stack` (which is synchronized) and `LinkedList` (which allocates nodes).

---

**P17.69** [M] -- Triangle (LeetCode 120)

Find the minimum path sum from top to bottom in a triangle.

```java
public int minimumTotal(List<List<Integer>> triangle) {
    int n = triangle.size();
    int[] dp = new int[n];
    
    // Start from the bottom row
    for (int j = 0; j < n; j++) dp[j] = triangle.get(n - 1).get(j);
    
    // Work upward
    for (int i = n - 2; i >= 0; i--) {
        for (int j = 0; j <= i; j++) {
            dp[j] = triangle.get(i).get(j) + Math.min(dp[j], dp[j + 1]);
        }
    }
    return dp[0];
}
```

```
Time:  O(n^2) where n = number of rows
Space: O(n)
```

---

**P17.70** [H] -- Dungeon Game (LeetCode 174)

Find the minimum initial health to reach the bottom-right of a grid (health must always be > 0).

```java
public int calculateMinimumHP(int[][] dungeon) {
    int m = dungeon.length, n = dungeon[0].length;
    int[] dp = new int[n + 1];
    Arrays.fill(dp, Integer.MAX_VALUE);
    dp[n - 1] = 1;  // need at least 1 HP at the princess
    
    for (int i = m - 1; i >= 0; i--) {
        for (int j = n - 1; j >= 0; j--) {
            int minHpNeeded = Math.min(dp[j], dp[j + 1]) - dungeon[i][j];
            dp[j] = Math.max(1, minHpNeeded);
        }
        dp[n] = Integer.MAX_VALUE;  // sentinel for rightmost column
    }
    return dp[0];
}
```

```
Time:  O(m × n)
Space: O(n)
```

**Key insight**: Process bottom-up and right-to-left. At each cell, compute the minimum HP needed to survive from that cell to the end. This reversal is necessary because the forward direction does not have optimal substructure (a path that maximizes health at an intermediate point might not minimize starting health).

---

### Additional Knapsack

---

**P17.71** [M] -- Combination Sum IV (LeetCode 377)

Given an array and a target, find the number of combinations (where order matters) that add up to the target.

```java
public int combinationSum4(int[] nums, int target) {
    int[] dp = new int[target + 1];
    dp[0] = 1;
    
    // Outer loop: amounts. Inner loop: nums. This counts PERMUTATIONS.
    for (int t = 1; t <= target; t++) {
        for (int num : nums) {
            if (num <= t) dp[t] += dp[t - num];
        }
    }
    return dp[target];
}
```

```
Time:  O(target × n)
Space: O(target)
```

**Key insight**: This is the "permutation" version of Coin Change II. The outer-amounts/inner-nums loop order counts different orderings as distinct.

---

**P17.72** [M] -- Shopping Offers (LeetCode 638)

Given items with prices, special offers (bundles at reduced prices), and desired quantities, find minimum cost.

```java
public int shoppingOffers(List<Integer> price, List<List<Integer>> special, List<Integer> needs) {
    Map<List<Integer>, Integer> memo = new HashMap<>();
    return dfs(price, special, needs, memo);
}

private int dfs(List<Integer> price, List<List<Integer>> special,
                List<Integer> needs, Map<List<Integer>, Integer> memo) {
    if (memo.containsKey(needs)) return memo.get(needs);
    
    // Base: buy everything individually
    int cost = 0;
    for (int i = 0; i < needs.size(); i++) cost += needs.get(i) * price.get(i);
    
    // Try each special offer
    for (List<Integer> offer : special) {
        List<Integer> remaining = new ArrayList<>();
        boolean valid = true;
        for (int i = 0; i < needs.size(); i++) {
            int rem = needs.get(i) - offer.get(i);
            if (rem < 0) { valid = false; break; }
            remaining.add(rem);
        }
        if (valid) {
            cost = Math.min(cost, offer.get(offer.size() - 1) + dfs(price, special, remaining, memo));
        }
    }
    
    memo.put(needs, cost);
    return cost;
}
```

```
Time:  O(product of all needs × number of offers)
Space: O(product of all needs) for memoization
```

**JVM insight**: Using `List<Integer>` as a HashMap key works because `List.hashCode()` and `List.equals()` consider element values. However, each lookup computes a hash over all elements. For higher performance, encode the needs as a single integer (if values are small) or use `Arrays.hashCode` on an int[].

---

### Additional String DP

---

**P17.73** [H] -- Longest Valid Parentheses (LeetCode 32)

Find the length of the longest valid parentheses substring.

```java
public int longestValidParentheses(String s) {
    int n = s.length();
    int[] dp = new int[n];  // dp[i] = length of longest valid parens ending at i
    int max = 0;
    
    for (int i = 1; i < n; i++) {
        if (s.charAt(i) == ')') {
            if (s.charAt(i - 1) == '(') {
                // ...()
                dp[i] = (i >= 2 ? dp[i - 2] : 0) + 2;
            } else if (dp[i - 1] > 0) {
                // ...))
                int matchIdx = i - dp[i - 1] - 1;
                if (matchIdx >= 0 && s.charAt(matchIdx) == '(') {
                    dp[i] = dp[i - 1] + 2 + (matchIdx >= 1 ? dp[matchIdx - 1] : 0);
                }
            }
            max = Math.max(max, dp[i]);
        }
    }
    return max;
}
```

```
Time:  O(n)
Space: O(n)
```

**Real-world correlation**: **JSON/XML validation depth**. Validating balanced brackets in configuration files, detecting the longest well-formed nested structure in a partial parse, or recovering from syntax errors in an IDE all use this pattern.

---

**P17.74** [H] -- Word Break II (LeetCode 140)

Return all possible sentences from word break.

```java
public List<String> wordBreak(String s, List<String> wordDict) {
    Set<String> dict = new HashSet<>(wordDict);
    Map<Integer, List<String>> memo = new HashMap<>();
    return dfs(s, 0, dict, memo);
}

private List<String> dfs(String s, int start, Set<String> dict, Map<Integer, List<String>> memo) {
    if (memo.containsKey(start)) return memo.get(start);
    
    List<String> result = new ArrayList<>();
    if (start == s.length()) {
        result.add("");
        return result;
    }
    
    for (int end = start + 1; end <= s.length(); end++) {
        String word = s.substring(start, end);
        if (dict.contains(word)) {
            List<String> subResults = dfs(s, end, dict, memo);
            for (String sub : subResults) {
                result.add(word + (sub.isEmpty() ? "" : " " + sub));
            }
        }
    }
    
    memo.put(start, result);
    return result;
}
```

```
Time:  O(n^2 × 2^n) worst case (exponential number of results)
Space: O(n × 2^n) for all possible sentences
```

**JVM insight**: The memoization stores `List<String>` at each position. For pathological inputs (like `s = "aaa...a"` with `dict = ["a", "aa", "aaa", ...]`), the number of valid sentences is exponential. The memo prevents recomputation but cannot reduce the output size.

---

**P17.75** [E] -- Palindromic Substrings (LeetCode 647)

Count all palindromic substrings.

```java
public int countSubstrings(String s) {
    int n = s.length();
    int count = 0;
    
    // Expand from center (more efficient than DP for counting)
    for (int center = 0; center < 2 * n - 1; center++) {
        int left = center / 2;
        int right = left + (center % 2);
        
        while (left >= 0 && right < n && s.charAt(left) == s.charAt(right)) {
            count++;
            left--;
            right++;
        }
    }
    return count;
}
```

```
Time:  O(n^2)
Space: O(1)
```

**DP alternative**: Use the `boolean[][] isPalin` table and count all `true` entries. Same time, O(n^2) space.

---

**P17.76** [M] -- Longest Palindromic Substring (LeetCode 5)

Find the longest palindromic substring.

```java
public String longestPalindrome(String s) {
    int n = s.length();
    int start = 0, maxLen = 1;
    
    for (int center = 0; center < 2 * n - 1; center++) {
        int left = center / 2;
        int right = left + (center % 2);
        
        while (left >= 0 && right < n && s.charAt(left) == s.charAt(right)) {
            if (right - left + 1 > maxLen) {
                start = left;
                maxLen = right - left + 1;
            }
            left--;
            right++;
        }
    }
    return s.substring(start, start + maxLen);
}
```

```
Time:  O(n^2)
Space: O(1)
```

**JVM insight**: Manacher's algorithm solves this in O(n) with O(n) space, but the expand-from-center approach is simpler and usually sufficient. For n = 1000, O(n^2) is 1M operations -- under 1ms. The break-even point where Manacher's constant-factor overhead pays off is roughly n > 100,000.

---

### Additional State Machine DP

---

**P17.77** [M] -- Paint House (LeetCode 256)

Paint N houses with 3 colors. No two adjacent houses share the same color. Minimize total cost.

```java
public int minCost(int[][] costs) {
    int n = costs.length;
    int r = 0, g = 0, b = 0;  // costs for coloring previous house
    
    for (int i = 0; i < n; i++) {
        int newR = costs[i][0] + Math.min(g, b);
        int newG = costs[i][1] + Math.min(r, b);
        int newB = costs[i][2] + Math.min(r, g);
        r = newR; g = newG; b = newB;
    }
    return Math.min(r, Math.min(g, b));
}
```

```
Time:  O(n)
Space: O(1)
```

**State machine view**: Three states (RED, GREEN, BLUE). From RED, you can transition to GREEN or BLUE. This is a 3-state DP with clear transition rules.

---

**P17.78** [H] -- Paint House II (LeetCode 265)

Paint N houses with K colors. No two adjacent houses share the same color. Minimize total cost.

```java
public int minCostII(int[][] costs) {
    int n = costs.length, k = costs[0].length;
    
    int min1 = 0, min2 = 0, minIdx = -1;  // cheapest and second cheapest
    
    for (int i = 0; i < n; i++) {
        int newMin1 = Integer.MAX_VALUE, newMin2 = Integer.MAX_VALUE, newMinIdx = -1;
        
        for (int j = 0; j < k; j++) {
            int cost = costs[i][j] + (j == minIdx ? min2 : min1);
            
            if (cost < newMin1) {
                newMin2 = newMin1;
                newMin1 = cost;
                newMinIdx = j;
            } else if (cost < newMin2) {
                newMin2 = cost;
            }
        }
        
        min1 = newMin1; min2 = newMin2; minIdx = newMinIdx;
    }
    return min1;
}
```

```
Time:  O(n × k)
Space: O(1)
```

**Key insight**: For K colors, the naive approach is O(n * k^2) -- for each house and color, check all previous colors. The optimization tracks only the two cheapest previous colors, reducing to O(n * k). If the current color matches the cheapest, use the second cheapest.

---

**P17.79** [M] -- Flip String to Monotone Increasing (LeetCode 926)

Find the minimum number of flips to make a binary string monotone increasing (all 0s before all 1s).

```java
public int minFlipsMonoIncr(String s) {
    int onesBeforeFlip = 0;  // count of 1s seen so far (would need to flip to 0)
    int flips = 0;           // minimum flips to make s[0..i] monotone
    
    for (char c : s.toCharArray()) {
        if (c == '1') {
            onesBeforeFlip++;
        } else {
            // Either flip this 0 to 1, or flip all previous 1s to 0
            flips = Math.min(flips + 1, onesBeforeFlip);
        }
    }
    return flips;
}
```

```
Time:  O(n)
Space: O(1)
```

**State machine view**: Two states -- "we are still in the 0-prefix" and "we have transitioned to the 1-suffix". The transition point is what we are optimizing.

---

### Additional Tree DP

---

**P17.80** [M] -- Longest ZigZag Path in a Binary Tree (LeetCode 1372)

Find the longest path that alternates between left and right child moves.

```java
private int maxLen = 0;

public int longestZigZag(TreeNode root) {
    dfs(root);
    return maxLen;
}

// Returns [leftZigZag, rightZigZag] ending at this node
private int[] dfs(TreeNode node) {
    if (node == null) return new int[]{-1, -1};
    
    int[] left = dfs(node.left);
    int[] right = dfs(node.right);
    
    int goLeft = left[1] + 1;   // went left, then previous was going right
    int goRight = right[0] + 1; // went right, then previous was going left
    
    maxLen = Math.max(maxLen, Math.max(goLeft, goRight));
    return new int[]{goLeft, goRight};
}
```

```
Time:  O(n)
Space: O(h)
```

---

**P17.81** [M] -- Sum of Distances in Tree (LeetCode 834)

For each node, compute the sum of distances to all other nodes.

```java
public int[] sumOfDistancesInTree(int n, int[][] edges) {
    List<List<Integer>> adj = new ArrayList<>();
    for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
    for (int[] e : edges) {
        adj.get(e[0]).add(e[1]);
        adj.get(e[1]).add(e[0]);
    }
    
    int[] count = new int[n];  // subtree size
    int[] ans = new int[n];    // sum of distances
    Arrays.fill(count, 1);
    
    // Post-order: compute subtree sizes and initial distances from root
    dfs1(0, -1, adj, count, ans);
    
    // Pre-order: re-root to compute all answers
    dfs2(0, -1, adj, count, ans, n);
    
    return ans;
}

private void dfs1(int node, int parent, List<List<Integer>> adj, int[] count, int[] ans) {
    for (int child : adj.get(node)) {
        if (child == parent) continue;
        dfs1(child, node, adj, count, ans);
        count[node] += count[child];
        ans[node] += ans[child] + count[child];
    }
}

private void dfs2(int node, int parent, List<List<Integer>> adj, int[] count, int[] ans, int n) {
    for (int child : adj.get(node)) {
        if (child == parent) continue;
        // Re-root from node to child:
        // child's subtree nodes get 1 closer, all others get 1 farther
        ans[child] = ans[node] - count[child] + (n - count[child]);
        dfs2(child, node, adj, count, ans, n);
    }
}
```

```
Time:  O(n)
Space: O(n)
```

**Key insight**: The "re-rooting" technique uses two passes. First pass (post-order) computes the answer for one root. Second pass (pre-order) derives all other answers by adjusting for the root change: moving the root to a child makes all nodes in the child's subtree 1 closer and all other nodes 1 farther.

**Real-world correlation**: **Network latency analysis**. Computing the average latency from every node to every other node in a tree-structured network is this exact problem. The re-rooting technique avoids O(n^2) BFS from every node.

---

### Additional Interval DP

---

**P17.82** [H] -- Encode String with Shortest Length (LeetCode 471)

Find the shortest encoded form of a string, where `k[pattern]` means `pattern` repeated `k` times.

```java
public String encode(String s) {
    int n = s.length();
    String[][] dp = new String[n][n];
    
    for (int len = 1; len <= n; len++) {
        for (int i = 0; i <= n - len; i++) {
            int j = i + len - 1;
            String sub = s.substring(i, j + 1);
            dp[i][j] = sub;  // default: no encoding
            
            if (len >= 5) {
                // Try encoding sub as k[pattern]
                String doubled = sub + sub;
                int idx = doubled.indexOf(sub, 1);
                if (idx < len) {
                    int repeat = len / idx;
                    String encoded = repeat + "[" + dp[i][i + idx - 1] + "]";
                    if (encoded.length() < dp[i][j].length()) {
                        dp[i][j] = encoded;
                    }
                }
                
                // Try splitting at every point
                for (int k = i; k < j; k++) {
                    String candidate = dp[i][k] + dp[k + 1][j];
                    if (candidate.length() < dp[i][j].length()) {
                        dp[i][j] = candidate;
                    }
                }
            }
        }
    }
    return dp[0][n - 1];
}
```

```
Time:  O(n^3)
Space: O(n^2)
```

**Key insight**: The `doubled.indexOf(sub, 1)` trick detects the shortest repeating pattern. If `s + s` contains `s` at position `p` (where 0 < p < n), then `s` is a repetition of `s[0..p-1]` with period `p`.

---

**P17.83** [H] -- Minimum Score Triangulation of Polygon (LeetCode 1039)

Triangulate a convex polygon to minimize the sum of triangle scores.

```java
public int minScoreTriangulation(int[] values) {
    int n = values.length;
    int[][] dp = new int[n][n];
    
    for (int len = 3; len <= n; len++) {
        for (int i = 0; i <= n - len; i++) {
            int j = i + len - 1;
            dp[i][j] = Integer.MAX_VALUE;
            for (int k = i + 1; k < j; k++) {
                int cost = values[i] * values[k] * values[j] + dp[i][k] + dp[k][j];
                dp[i][j] = Math.min(dp[i][j], cost);
            }
        }
    }
    return dp[0][n - 1];
}
```

```
Time:  O(n^3)
Space: O(n^2)
```

---

### Additional Bitmask DP

---

**P17.84** [H] -- Find the Shortest Superstring (LeetCode 943, alternative approach)

This was covered in P17.42. Here is a cleaner memoization-based approach.

```java
public String shortestSuperstring(String[] words) {
    int n = words.length;
    int[][] overlap = computeOverlap(words);
    
    // dp[mask][last] = max overlap
    int[][] dp = new int[1 << n][n];
    int[][] parent = new int[1 << n][n];
    for (int[] row : parent) Arrays.fill(row, -1);
    
    // Fill DP
    for (int mask = 0; mask < (1 << n); mask++) {
        for (int last = 0; last < n; last++) {
            if ((mask & (1 << last)) == 0) continue;
            int prevMask = mask ^ (1 << last);
            
            for (int prev = 0; prev < n; prev++) {
                if ((prevMask & (1 << prev)) == 0) continue;
                int val = dp[prevMask][prev] + overlap[prev][last];
                if (val > dp[mask][last]) {
                    dp[mask][last] = val;
                    parent[mask][last] = prev;
                }
            }
        }
    }
    
    // Reconstruct (same as P17.42)
    int fullMask = (1 << n) - 1;
    int last = 0;
    for (int i = 1; i < n; i++) {
        if (dp[fullMask][i] > dp[fullMask][last]) last = i;
    }
    
    int[] order = new int[n];
    int mask = fullMask;
    for (int idx = n - 1; idx >= 0; idx--) {
        order[idx] = last;
        int prev = parent[mask][last];
        mask ^= (1 << last);
        last = prev;
    }
    
    StringBuilder sb = new StringBuilder(words[order[0]]);
    for (int i = 1; i < n; i++) {
        sb.append(words[order[i]].substring(overlap[order[i-1]][order[i]]));
    }
    return sb.toString();
}

private int[][] computeOverlap(String[] words) {
    int n = words.length;
    int[][] overlap = new int[n][n];
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < n; j++) {
            if (i == j) continue;
            int maxOv = Math.min(words[i].length(), words[j].length());
            for (int k = maxOv; k >= 1; k--) {
                if (words[i].endsWith(words[j].substring(0, k))) {
                    overlap[i][j] = k;
                    break;
                }
            }
        }
    }
    return overlap;
}
```

```
Time:  O(n^2 × 2^n + n^2 × L) where L = avg word length
Space: O(n × 2^n)
```

---

### Additional Digit DP

---

**P17.85** [H] -- Non-negative Integers without Consecutive Ones (LeetCode 600)

Count non-negative integers up to `n` with no consecutive 1s in binary.

```java
public int findIntegers(int n) {
    // Fibonacci-based approach on binary digits
    String binary = Integer.toBinaryString(n);
    int len = binary.length();
    
    // fib[i] = count of binary strings of length i with no consecutive 1s
    int[] fib = new int[len + 1];
    fib[0] = 1; fib[1] = 2;
    for (int i = 2; i <= len; i++) fib[i] = fib[i - 1] + fib[i - 2];
    
    int count = 0;
    boolean prevBit = false;
    
    for (int i = 0; i < len; i++) {
        if (binary.charAt(i) == '1') {
            // Count all numbers with 0 at position i (these are all less than n)
            count += fib[len - i - 1];
            
            if (prevBit) return count;  // two consecutive 1s: n itself is invalid
            prevBit = true;
        } else {
            prevBit = false;
        }
    }
    return count + 1;  // +1 for n itself (which has no consecutive 1s)
}
```

```
Time:  O(log n)
Space: O(log n)
```

**Real-world correlation**: **Error-correcting codes**. Fibonacci codes (used in some data compression schemes) have no consecutive 1s. Counting valid codewords up to a given length is this problem.

---

### Additional Problems (Completing the 90)

---

**P17.86** [E] -- Is Subsequence (LeetCode 392)

Check if `s` is a subsequence of `t`.

```java
public boolean isSubsequence(String s, String t) {
    int si = 0;
    for (int ti = 0; ti < t.length() && si < s.length(); ti++) {
        if (s.charAt(si) == t.charAt(ti)) si++;
    }
    return si == s.length();
}

// DP approach for follow-up: many s queries against same t
// Precompute: next[i][c] = next occurrence of char c at or after position i in t
public boolean isSubsequenceDP(String s, String t) {
    int n = t.length();
    int[][] next = new int[n + 1][26];
    Arrays.fill(next[n], -1);
    
    for (int i = n - 1; i >= 0; i--) {
        for (int c = 0; c < 26; c++) next[i][c] = next[i + 1][c];
        next[i][t.charAt(i) - 'a'] = i;
    }
    
    int pos = 0;
    for (char c : s.toCharArray()) {
        if (pos >= n + 1 || next[pos][c - 'a'] == -1) return false;
        pos = next[pos][c - 'a'] + 1;
    }
    return true;
}
```

```
Time:  Greedy: O(|t|). DP: O(|t| × 26) precomputation, O(|s|) per query
Space: Greedy: O(1). DP: O(|t| × 26)
```

---

**P17.87** [E] -- Range Sum Query - Immutable (LeetCode 303)

Given an integer array, compute sums of sub-ranges efficiently.

```java
class NumArray {
    private int[] prefix;
    
    public NumArray(int[] nums) {
        prefix = new int[nums.length + 1];
        for (int i = 0; i < nums.length; i++) {
            prefix[i + 1] = prefix[i] + nums[i];
        }
    }
    
    public int sumRange(int left, int right) {
        return prefix[right + 1] - prefix[left];
    }
}
```

```
Time:  O(n) construction, O(1) per query
Space: O(n)
```

**JVM insight**: Prefix sums are one of the most fundamental DP patterns. The `prefix` array is computed once and supports O(1) range queries. This is the 1D analog of 2D prefix sums used in image processing (integral images).

**Real-world correlation**: **Monitoring dashboards**. Time-series databases like Prometheus use prefix sums (or similar accumulators) to answer "what was the total over the last 5 minutes?" in O(1).

---

**P17.88** [E] -- Min Cost Climbing Stairs (variant) (LeetCode 746)

Already covered in P17.2. Here is the top-down memoization version for completeness.

```java
private int[] memo;

public int minCostClimbingStairsTopDown(int[] cost) {
    int n = cost.length;
    memo = new int[n + 1];
    Arrays.fill(memo, -1);
    return dp(cost, n);
}

private int dp(int[] cost, int i) {
    if (i <= 1) return 0;
    if (memo[i] != -1) return memo[i];
    memo[i] = Math.min(dp(cost, i - 1) + cost[i - 1], dp(cost, i - 2) + cost[i - 2]);
    return memo[i];
}
```

```
Time:  O(n)
Space: O(n)
```

---

**P17.89** [E] -- Divisor Game (LeetCode 1025)

Alice and Bob take turns. On each turn, choose x where 0 < x < n and n % x == 0, then replace n with n - x. The player who cannot move loses. Return whether Alice wins if both play optimally.

```java
public boolean divisorGame(int n) {
    // Mathematical insight: Alice wins iff n is even
    return n % 2 == 0;
    
    // DP proof:
    // boolean[] dp = new boolean[n + 1];
    // dp[1] = false;  // Alice loses (no valid move)
    // for (int i = 2; i <= n; i++) {
    //     for (int x = 1; x < i; x++) {
    //         if (i % x == 0 && !dp[i - x]) {
    //             dp[i] = true;
    //             break;
    //         }
    //     }
    // }
    // return dp[n];
}
```

```
Time:  O(1) for math solution; O(n^2) for DP
Space: O(1) for math; O(n) for DP
```

---

**P17.90** [H] -- Frog Jump (LeetCode 403)

A frog crosses a river by jumping on stones. From stone at position `stones[i]` with last jump size `k`, the frog can jump `k-1`, `k`, or `k+1` units.

```java
public boolean canCross(int[] stones) {
    int n = stones.length;
    Map<Integer, Set<Integer>> posToJumps = new HashMap<>();
    for (int stone : stones) posToJumps.put(stone, new HashSet<>());
    posToJumps.get(stones[0]).add(0);
    
    for (int stone : stones) {
        for (int k : posToJumps.get(stone)) {
            for (int jump = k - 1; jump <= k + 1; jump++) {
                if (jump > 0 && posToJumps.containsKey(stone + jump)) {
                    posToJumps.get(stone + jump).add(jump);
                }
            }
        }
    }
    return !posToJumps.get(stones[n - 1]).isEmpty();
}
```

```
Time:  O(n^2) worst case
Space: O(n^2)
```

**JVM insight**: The `HashMap<Integer, Set<Integer>>` structure involves heavy boxing. For competitive performance, encode the state as `position * MAX_JUMP + jumpSize` in a `HashSet<Long>`. But for interview purposes, the clarity of the map-of-sets approach is preferred.

**Real-world correlation**: **Network protocol state machines with variable timing**. In protocols where the next allowed action depends on the previous action's parameters (like adaptive bitrate streaming where the next segment size depends on the previous segment's download speed), the frog jump model applies.

---

## 17.12 Real-World Correlations Summary

Let me consolidate the real-world connections across all nine sub-patterns. These are not contrived analogies -- these are actual uses of DP in production systems.

### Edit Distance
- **Spell checkers**: Suggest corrections within edit distance 1-2 (Hunspell, aspell)
- **DNA sequence alignment**: Needleman-Wunsch (global) and Smith-Waterman (local) are weighted edit distance variants. BLAST searches entire genomes using heuristic edit distance.
- **diff tools**: `git diff`, `diff`, `vimdiff` all compute edit scripts (minimum edits to transform one file to another)
- **Fuzzy matching**: Elasticsearch's fuzzy queries use Levenshtein automata (DP-compiled into a finite automaton)

### Longest Common Subsequence
- **Version control**: `git diff` uses LCS (Myers algorithm) to compute the minimal set of line additions/deletions
- **File comparison**: `diff` and `patch` utilities are LCS-based
- **Merge conflict detection**: Three-way merge in Git computes LCS between the common ancestor and both branches

### Knapsack
- **Cloud resource allocation**: AWS/GCP VM instance selection under budget constraints
- **Kubernetes scheduling**: Pod placement is multi-dimensional knapsack (CPU, memory, GPU)
- **Portfolio optimization**: Markowitz mean-variance optimization is continuous knapsack
- **Compiler register allocation**: Assigning variables to a limited number of registers

### Shortest Path (Bellman-Ford as DP)
- **BGP routing**: Border Gateway Protocol uses a distributed Bellman-Ford to find best inter-AS routes
- **Network routing**: Distance-vector protocols (RIP) are DP on graph distances

### Regex Matching
- **Web application firewalls**: Pattern matching against known attack signatures
- **Log analysis**: grep, awk, and log aggregation tools compile patterns to DFA/NFA
- **ReDoS prevention**: DP-based matchers guarantee polynomial time, preventing denial-of-service

### Viterbi Algorithm
- **Speech recognition**: Decoding the most likely word sequence from acoustic observations
- **Natural language processing**: Part-of-speech tagging using Hidden Markov Models
- **Error correction**: Decoding convolutional codes in communication systems (WiFi, 4G)
- **Bioinformatics**: Gene finding algorithms use HMMs decoded with Viterbi

### Matrix Chain / Interval DP
- **Database query optimization**: The Selinger algorithm (System R) chooses optimal join order using DP
- **Tensor contraction**: TensorFlow/PyTorch optimizers choose contraction order for efficiency
- **Compiler instruction scheduling**: Choosing evaluation order for expression trees

### State Machine DP
- **TCP**: Modeling the TCP connection state machine for protocol analysis
- **Algorithmic trading**: Optimizing buy/sell decisions under constraints (cooldown, fees, position limits)
- **Game AI**: Finite state machines for NPC behavior use state-based optimization

### Digit DP
- **Combinatorial enumeration**: Counting valid serial numbers, license plates, or codes
- **Number theory computations**: Counting numbers with specific digit properties in cryptographic applications

---

## 17.13 Key Takeaways

1. **The two properties are non-negotiable.** Before reaching for DP, verify both overlapping subproblems AND optimal substructure. If overlapping subproblems are absent, divide-and-conquer suffices. If optimal substructure is absent (like longest simple path in general graphs), DP cannot help.

2. **State definition is the hardest and most important step.** Everything else flows from the state. If your state is wrong, no amount of transition engineering will save you. The state must capture *exactly* the information needed to make future decisions, and nothing more. Extra dimensions waste time and space; missing dimensions produce incorrect answers.

3. **Top-down vs bottom-up is a trade-off, not a preference.** Top-down (memoization) is more intuitive and computes only reachable states. Bottom-up (tabulation) avoids stack overflow, has better cache behavior, and enables space optimization. When the state space has many unreachable states, top-down wins. When you need space optimization or the state space is dense, bottom-up wins. In interviews, start with whichever you find easier to code correctly, then optimize if asked.

4. **Space optimization follows a mechanical process.** If row `i` depends only on row `i-1`, use two rows or a single row with careful iteration direction. If the transition uses only `dp[i-1][j]` and `dp[i][j-1]`, a single row suffices. For knapsack, right-to-left iteration gives 0/1 behavior; left-to-right gives unbounded behavior. This is the single most important mechanical rule in DP.

5. **The nine sub-patterns cover 95% of interview DP problems.** 1D linear, 2D grid/string, knapsack, interval, tree, bitmask, string, state machine, and digit DP. When you see a new problem, ask: "Which of these nine patterns does it most resemble?" Then adapt the template.

6. **Knapsack identification relies on one question: how many times can each item be used?** At most once = 0/1 knapsack (iterate right-to-left). Unlimited = unbounded knapsack (iterate left-to-right). Fixed count = bounded knapsack (binary decomposition). Exact target = subset sum. The loop structure (which loop is outer, which is inner, which direction) completely determines the variant.

7. **Interval DP always involves "choosing where to split."** If the problem asks about an optimal way to partition, merge, or group a sequence, think interval DP. The key insight is usually choosing the *last* operation (last balloon burst, last merge, last split) to create independent subproblems.

8. **Bitmask DP is your tool for small N (N <= 20-25).** Any time you see a problem with N items, all subsets matter, and N is small, bitmask DP converts an O(N!) search into O(N * 2^N) or O(N^2 * 2^N). Always check: is N small enough? For N = 20, 2^20 = 1M (fine). For N = 25, 2^25 = 33M (borderline). For N = 30, 2^30 = 1B (too large).

9. **State machine DP reveals itself when there are "modes" or "statuses."** If you can draw a state transition diagram (like the stock trading diagrams), you have a state machine DP. The number of states is usually small (2-5), making the DP table very efficient. The stock trading problems are the canonical examples, but thread scheduling, protocol analysis, and game theory all use this pattern.

10. **Every DP algorithm exists in production code you have already deployed.** Edit distance runs in your spell checker. LCS runs in your version control. Knapsack runs in your cloud resource allocator. Bellman-Ford runs in your network router. Viterbi runs in your speech recognizer. When you solve a DP problem, you are not doing an abstract exercise -- you are understanding the computational core of systems you use every day.

---

## Navigation

| Previous | Index | Next |
|----------|-------|------|
| [Ch 16: Patterns — Trees & Graphs](16-pattern-trees-graphs.md) | [Index](00-index.md) | [Ch 18: Patterns — Greedy & Backtracking](18-pattern-greedy-backtracking.md) |

---

*"Dynamic programming is the art of solving a problem by first solving all of its subproblems -- but being smart enough to solve each one only once."*

*Every cache hit in your Redis cluster is memoization. Every materialized view in your database is tabulation. You have been doing DP in production for years -- this chapter just gives it a name.*
