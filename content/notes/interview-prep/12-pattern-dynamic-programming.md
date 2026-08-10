# Chapter 12: Dynamic Programming

> **Relearning log.** DP is the topic I most dreaded re-learning and the one where I'd built up the
> most superstition ("just memorize the recurrences"). The breakthrough on the rebuild: **DP is just
> recursion + memoization, and the recurrence comes from one question — "what's the *last decision*,
> and what subproblem remains after I make it?"** I now *always* start with the brute-force recursion
> (the choices), add a memo to kill the repeated subproblems, and only convert to a bottom-up table
> if asked or if I want to optimize space. Writing the recursion first means I never have to "guess"
> a table formula — the table is just the memo, filled in dependency order. The second recovery:
> **identify the state.** If I can name "what variables fully describe a subproblem," the rest is
> mechanical.

---

## 12.1 The DP recipe (the order I follow every time)

1. **Is it DP?** Signs: "count the number of ways," "min/max cost/length," "can you reach/partition,"
   *and* choices that overlap (the same subproblem recurs). Optimization or counting + overlapping
   subproblems + optimal substructure.
2. **Define the state.** What minimal set of variables identifies a subproblem? `dp[i]` = answer
   considering the first `i` items; `dp[i][j]` = answer for `s1[0..i]` and `s2[0..j]`; etc.
3. **Write the recurrence from the last decision.** "To solve `dp[i]`, what was the last choice, and
   which smaller `dp[...]` does each choice depend on?"
4. **Base cases.** The smallest subproblems (`dp[0]`, empty string, etc.).
5. **Order of evaluation.** Top-down memo (natural, write the recursion) or bottom-up (fill in
   dependency order).
6. **Optimize space** if each state depends only on the last row/few values → rolling array.

> The one sentence that unlocks every DP: **"What is the last decision, and what subproblem is left
> after I make it?"** Get that and the recurrence falls out. I literally say it out loud in the room.

---

## 12.2 Top-down (memoization) — write this first

Memoization is the lowest-risk way to land DP under pressure: write the brute-force recursion, then
cache.

```java
// Coin change: fewest coins to make amount. dp(rem) = min over coins of 1 + dp(rem - coin).
int coinChange(int[] coins, int amount) {
    Integer[] memo = new Integer[amount + 1];
    int r = dp(coins, amount, memo);
    return r == Integer.MAX_VALUE ? -1 : r;
}
int dp(int[] coins, int rem, Integer[] memo) {
    if (rem == 0) return 0;
    if (rem < 0) return Integer.MAX_VALUE;
    if (memo[rem] != null) return memo[rem];
    int best = Integer.MAX_VALUE;
    for (int c : coins) {
        int sub = dp(coins, rem - c, memo);
        if (sub != Integer.MAX_VALUE) best = Math.min(best, 1 + sub);
    }
    return memo[rem] = best;
}
```

Complexity = **(number of states) × (work per state)**. Here: O(amount × coins). Saying it that way
shows you understand *why* memoization collapses the exponential tree.

---

## 12.3 The canonical DP families (recognize → recurrence)

### 1D DP — "decision at each index"

| Problem | State | Recurrence |
|---------|-------|-----------|
| Climbing stairs / Fibonacci | `dp[i]` ways to reach i | `dp[i] = dp[i-1] + dp[i-2]` |
| House robber | `dp[i]` max loot up to i | `dp[i] = max(dp[i-1], dp[i-2] + a[i])` |
| Max subarray (Kadane) | `dp[i]` best ending at i | `dp[i] = max(a[i], dp[i-1] + a[i])` |
| Longest increasing subsequence | `dp[i]` LIS ending at i | `dp[i] = 1 + max(dp[j]) for j<i, a[j]<a[i]` → O(n²); O(n log n) via patience/BS |
| Decode ways / word break | `dp[i]` for prefix length i | sum/OR over valid last segments |

```java
// House robber with O(1) space (rolling). dp[i]=max(skip, rob this).
int rob(int[] a) {
    int prev2 = 0, prev1 = 0;
    for (int x : a) { int cur = Math.max(prev1, prev2 + x); prev2 = prev1; prev1 = cur; }
    return prev1;
}
```

### 2D DP — "two sequences" or "grid"

| Problem | State `dp[i][j]` | Recurrence |
|---------|------------------|-----------|
| Edit distance | min ops to turn `a[0..i]`→`b[0..j]` | match: `dp[i-1][j-1]`; else `1 + min(insert, delete, replace)` |
| Longest common subsequence | LCS of prefixes | match: `1 + dp[i-1][j-1]`; else `max(dp[i-1][j], dp[i][j-1])` |
| Unique paths / min path sum | ways/cost to reach (i,j) | `dp[i][j] = dp[i-1][j] (+/min) dp[i][j-1]` |
| 0/1 knapsack | best value with first i items, cap j | `max(dp[i-1][j], dp[i-1][j-w]+v)` |

```java
// LCS. O(mn) time, O(mn) space (reducible to O(min(m,n)) with two rows).
int lcs(String a, String b) {
    int m = a.length(), n = b.length();
    int[][] dp = new int[m + 1][n + 1];
    for (int i = 1; i <= m; i++)
        for (int j = 1; j <= n; j++)
            dp[i][j] = a.charAt(i-1) == b.charAt(j-1)
                     ? dp[i-1][j-1] + 1
                     : Math.max(dp[i-1][j], dp[i][j-1]);
    return dp[m][n];
}
```

### Knapsack variants — the decision is "take it or not"

- **0/1 knapsack** (each item once): iterate capacity **descending** when using a 1D array, so each
  item is used at most once.
- **Unbounded** (unlimited copies, e.g., coin change ways): iterate capacity **ascending**.
- **Subset sum / partition equal subset** = 0/1 knapsack with boolean `dp[sum]`.

```java
// Partition into two equal-sum subsets. dp[s] = can we hit sum s. O(n*sum).
boolean canPartition(int[] a) {
    int total = Arrays.stream(a).sum();
    if (total % 2 != 0) return false;
    int target = total / 2;
    boolean[] dp = new boolean[target + 1];
    dp[0] = true;
    for (int x : a)
        for (int s = target; s >= x; s--)   // DESCENDING → each item used once
            dp[s] |= dp[s - x];
    return dp[target];
}
```

### Interval DP — "merge / split a range"

State `dp[i][j]` over a subrange `[i,j]`; recurrence tries every split point `k` in the middle.
Examples: matrix-chain multiplication, burst balloons, palindrome partitioning II, stone games.
Usually O(n³).

### DP on subsequences / strings — palindromes

- Longest palindromic subsequence = LCS of `s` and `reverse(s)`.
- Longest palindromic *substring* / count = expand-around-center O(n²) or DP `dp[i][j] = s[i]==s[j]
  && dp[i+1][j-1]`.

### State-machine DP — "buy/sell with states"

Best time to buy/sell stock (with cooldown / fee / k transactions): the state includes *which phase
you're in* (holding vs. not). Define `dp[i][holding]` or `dp[i][k][holding]` and transition between
states.

---

## 12.4 Top-down vs bottom-up — which to write

| | Top-down (memo) | Bottom-up (table) |
|---|-----------------|-------------------|
| Write speed under pressure | **Faster** — just recursion + cache | Slower — must get the fill order right |
| Risk | Stack depth on huge inputs | Off-by-one in loop bounds |
| Space optimization | Harder | **Easier** (rolling array) |
| When I choose it | Default; complex/sparse state | When asked for O(1)/O(n) space or iteration |

> My move in the room: **write top-down memo first** (it's the recursion I already reasoned out),
> get it correct, *then* offer "I can convert this to bottom-up and reduce space to O(n) with a
> rolling array if useful." That sequence demonstrates both correctness and optimization judgment —
> an L5 signal.

---

## 12.5 Common pitfalls

- **Jumping to a table without writing the recursion** → guessed, wrong formula. Recursion first.
- **Wrong iteration direction** in 1D knapsack (ascending vs descending decides reuse).
- **Forgetting base cases** / off-by-one between "first i items" (1-indexed dp) and 0-indexed array.
- **Not identifying the full state** → missing a dimension (e.g., forgetting the "holding" flag in
  stock problems, or `k` transactions).
- **Counting vs optimizing** confusion — counting sums the transitions; optimizing takes min/max.
- **Using `Integer.MAX_VALUE` then adding 1** → overflow; guard before adding.

## Interview Drills

- **D12.1 [E]** Climbing stairs; min cost climbing stairs; house robber I & II (circular).
- **D12.2 [E]** Coin change (fewest) and coin change II (count ways) — note the loop-order difference.
- **D12.3 [M]** Longest increasing subsequence — O(n²) then O(n log n).
- **D12.4 [M]** Longest common subsequence; edit distance.
- **D12.5 [M]** Partition equal subset sum; target sum.
- **D12.6 [M]** Unique paths / minimum path sum / maximal square.
- **D12.7 [H]** Word break II; decode ways.
- **D12.8 [H]** Best time to buy/sell stock with cooldown and with k transactions (state machine).
- **D12.9 [H]** Burst balloons; matrix chain (interval DP).

## Key Takeaways

1. **DP = recursion + memoization.** Write the brute-force recursion first, then cache — the table
   is just the memo in dependency order.
2. **The recurrence comes from one question:** *what's the last decision, and what subproblem
   remains?*
3. **Identify the state** — the minimal variables that define a subproblem. Missing a dimension is
   the most common failure.
4. **Know the families:** 1D (decision per index), 2D (two sequences / grid), knapsack (take or not;
   loop direction), interval (split a range), state-machine (buy/sell phases).
5. **Write top-down first, then offer bottom-up + rolling-array space optimization** — correctness
   then judgment.
