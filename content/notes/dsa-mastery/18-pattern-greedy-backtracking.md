# Chapter 18: Patterns -- Greedy, Backtracking & Divide and Conquer

## The Art of Choosing: One Shot, All Shots, and Splitting the Problem

There are exactly three ways to handle a decision at any step of an algorithm. You can commit to the locally best choice and never look back -- that is greedy. You can explore every possible choice, recursing forward and undoing when you hit a dead end -- that is backtracking. Or you can split the problem into independent subproblems, solve each, and merge the results -- that is divide and conquer. These three paradigms, taken together, cover an enormous fraction of algorithmic problem solving. They are also, critically, the paradigms most frequently confused.

I have seen 15-year production veterans reach for dynamic programming when greedy suffices, or attempt greedy on problems that demand exhaustive search. The distinction is not academic -- it determines whether your solution runs in O(N log N) or O(2^N), whether your system handles ten million scheduling events per second or chokes on a thousand. In production, the scheduler inside your Kafka consumer group that decides which partitions to assign? Greedy. The constraint solver that generates valid database migration plans? Backtracking. The merge sort underpinning your parallel MapReduce shuffle? Divide and conquer.

This chapter builds the mental framework for recognizing which paradigm a problem demands, proves why each one works when it works, and provides the battle-tested Java implementations you need for both interviews and production systems.

---

## PART A: GREEDY ALGORITHMS

### 18.1 When Greedy Works -- And Why It So Often Seems Like It Should But Does Not

A greedy algorithm makes the locally optimal choice at each step, hoping that local optima cascade into a global optimum. The critical word is "hoping." Most problems do not have this property. When they do, greedy is spectacularly efficient. When they do not, greedy produces confidently wrong answers.

#### 18.1.1 The Two Pillars: Greedy Choice Property and Optimal Substructure

A greedy algorithm is provably correct if and only if the problem exhibits both:

**Greedy Choice Property:** There exists an optimal solution that includes the greedy choice. In other words, you can always make the locally best move without eliminating the possibility of reaching the globally best outcome.

**Optimal Substructure:** After making the greedy choice, the remaining subproblem is itself an optimization problem of the same form, and the optimal solution to the subproblem combined with the greedy choice yields the optimal solution to the original problem.

```
Decision flowchart -- when to attempt greedy:

Problem asks to maximize/minimize something?
    │
    ├── Yes ──→ Can you identify a clear "locally best" choice?
    │               │
    │               ├── Yes ──→ Does making that choice leave a valid subproblem?
    │               │               │
    │               │               ├── Yes ──→ Can you prove no better choice exists?
    │               │               │               │
    │               │               │               ├── Yes ──→ GREEDY WORKS
    │               │               │               └── No  ──→ Need DP or exhaustive search
    │               │               └── No  ──→ Greedy does not apply
    │               └── No  ──→ Not a greedy candidate
    └── No  ──→ Usually not greedy (unless counting, partitioning)
```

#### 18.1.2 The Exchange Argument: The Standard Proof Technique

When you need to prove a greedy algorithm is correct, the exchange argument is your tool of choice. The structure is:

1. Assume there exists an optimal solution OPT that differs from the greedy solution G.
2. Find the first point of disagreement -- where OPT makes choice X while G makes choice Y.
3. Show that swapping X for Y in OPT produces a solution OPT' that is at least as good as OPT.
4. Since OPT' is at least as good and agrees with G on one more choice, repeat until OPT is transformed into G.
5. Conclude: the greedy solution is optimal.

**Concrete example -- Activity Selection:**

Problem: given activities with start and finish times, select the maximum number of non-overlapping activities.

Greedy strategy: always pick the activity that finishes earliest.

Exchange proof:
- Let OPT be an optimal set that does not start with the earliest-finishing activity a1.
- OPT starts with some activity a_k where finish(a_k) >= finish(a1).
- Replace a_k with a1 in OPT. Since a1 finishes no later than a_k, every activity that was compatible with a_k after it is also compatible with a1.
- OPT' = OPT with a_k swapped for a1 has the same size and is still valid.
- Repeat this argument for each subsequent greedy choice.
- Therefore, the greedy solution has the same size as OPT -- it is optimal.

#### 18.1.3 Matroid Theory Intuition

For the mathematically inclined, there is a deep reason why greedy works on certain structures. A matroid is a combinatorial structure (E, I) where E is a ground set and I is a family of "independent sets" satisfying:

1. The empty set is independent.
2. If A is in I and B is a subset of A, then B is in I (hereditary property).
3. If A and B are in I with |A| < |B|, then there exists an element in B - A that can be added to A to keep it independent (exchange axiom).

When your problem can be formulated as finding a maximum-weight independent set in a matroid, a greedy algorithm that adds elements in decreasing weight order is guaranteed to find the optimum.

**Real-world matroid examples:**
- **Graphic matroid:** edges of a graph, independent sets are forests. Kruskal's MST algorithm is greedy on this matroid.
- **Uniform matroid:** any subset of size at most k is independent. The top-k problem is greedy on this matroid.
- **Partition matroid:** elements partitioned into groups, at most one from each group. Job scheduling with categories.

You do not need to formally verify matroid axioms in an interview. But the intuition helps: if the problem has a "you can always extend a partial solution by adding more elements without breaking constraints" flavor, greedy is likely correct.

#### 18.1.4 Greedy vs Dynamic Programming

The relationship is precise. Both require optimal substructure. The difference:

```
Greedy:  Make ONE choice (the locally best) → solve ONE remaining subproblem
DP:      Consider ALL choices → solve ALL resulting subproblems → pick the best

Greedy: O(N) or O(N log N) typically, O(1) or O(N) space
DP:     O(N^2) or O(N × K) typically, O(N) or O(N × K) space
```

**The diagnostic test:** Can you construct a counterexample where the greedy choice leads to a suboptimal result?

- Coin change with denominations [1, 3, 4], amount 6: Greedy picks 4+1+1=3 coins. DP finds 3+3=2 coins. Greedy fails because the denomination set lacks the "greedy-safe" property that standard US coins have.
- Activity selection: Greedy works because picking the earliest-finishing activity can never prevent you from achieving the optimal count.

---

### 18.2 Greedy Pattern 1: Interval Scheduling

This is the canonical greedy family. The recognition signal is any problem involving intervals that must be selected, removed, or counted based on overlapping relationships.

**The Master Strategy:** Sort by end time (for selection) or start time (for merging/counting), then greedily process.

#### Why Sort by End Time for Selection?

Sorting by end time ensures that each greedy pick leaves the maximum possible time range for subsequent activities. If you sort by start time, you might pick an early-starting but late-ending interval that blocks many shorter ones. If you sort by duration, you miss that a short interval might overlap with many others while a slightly longer one overlaps with none.

```
Counterexample -- why not sort by start time:

Intervals: [1,10], [2,3], [4,5], [6,7], [8,9]

Sort by start: pick [1,10] → only 1 interval selected (blocks all others)
Sort by end:   pick [2,3] → [4,5] → [6,7] → [8,9] → 4 intervals selected

Sort by end is optimal.
```

**JVM Implementation Notes:**

```java
// Sorting intervals by end time -- the idiomatic Java approach
Arrays.sort(intervals, (a, b) -> Integer.compare(a[1], b[1]));

// WARNING: Do NOT use (a, b) -> a[1] - b[1] for the comparator.
// If a[1] = Integer.MAX_VALUE and b[1] = -1, then a[1] - b[1] overflows,
// returning a negative number and giving the WRONG ordering.
// Integer.compare avoids this by using conditional logic, not subtraction.

// Alternative with Comparator.comparingInt (slightly more allocation):
Arrays.sort(intervals, Comparator.comparingInt(a -> a[1]));
// This boxes the int to Integer internally via autoboxing.
// For performance-critical code with millions of intervals, the lambda
// with Integer.compare is faster because it avoids autoboxing.
```

---

### 18.3 Greedy Pattern 2: Huffman Coding

Huffman coding builds a binary tree from the bottom up, always merging the two nodes with the smallest frequency. This is the backbone of lossless compression -- gzip, DEFLATE, JPEG's entropy coding stage, and the initial pass of many MP3 encoders all use Huffman or its close relatives.

**Why it works:** At each step, the two least frequent symbols should be siblings at the maximum depth of the tree, because placing a frequent symbol at maximum depth would increase total encoded length. The exchange argument shows that any optimal tree can be rearranged to match the Huffman tree.

```
Building a Huffman tree for frequencies: a=5, b=9, c=12, d=13, e=16, f=45

Step 1: Merge two smallest (a=5, b=9) → node(14)
        PQ: [c=12, d=13, node(14), e=16, f=45]

Step 2: Merge (c=12, d=13) → node(25)
        PQ: [node(14), e=16, node(25), f=45]

Step 3: Merge (node(14), e=16) → node(30)
        PQ: [node(25), node(30), f=45]

Step 4: Merge (node(25), node(30)) → node(55)
        PQ: [f=45, node(55)]

Step 5: Merge (f=45, node(55)) → root(100)

Result tree:
              (100)
             /     \
          f(45)   (55)
                 /    \
              (25)    (30)
              / \     / \
           c(12) d(13) (14) e(16)
                      / \
                   a(5)  b(9)

Codes: f=0, c=100, d=101, a=1100, b=1101, e=111
Average bits: (5×4 + 9×4 + 12×3 + 13×3 + 16×3 + 45×1) / 100 = 224/100 = 2.24 bits/symbol
```

**JVM `PriorityQueue` behavior:**
```java
PriorityQueue<Integer> pq = new PriorityQueue<>();
// Default capacity: 11 (NOT a power of 2 -- historical quirk)
// Grow strategy: if old capacity < 64, double+2; else grow by 50%
// This is a min-heap backed by an Object[] array
// offer() and poll() are both O(log N)
// peek() is O(1)

// For Huffman, we need to merge N-1 times, each merge does 2 polls + 1 offer
// Total: O(N log N) -- N initial inserts + (N-1) rounds of 2×poll + 1×offer
```

---

### 18.4 Greedy Pattern 3: Activity Selection / Scheduling

This extends interval scheduling to problems where activities have deadlines, profits, or processing times. The greedy strategy varies based on what you are optimizing.

**Job Scheduling with Deadlines and Profits:**
- Sort by profit (descending).
- For each job, schedule it in the latest available slot before its deadline.
- Uses a Union-Find structure or simple array to find available slots efficiently.

**Task Scheduling (CPU intervals):**
- The constraint is a cooldown period between identical tasks.
- Greedy: always schedule the most frequent remaining task. Fill cooldown gaps with less frequent tasks.
- The formula: result = max(total_tasks, (maxFreq - 1) * (n + 1) + countOfMaxFreq)

**Reorganize String:**
- Place the most frequent character, ensuring no two adjacent are the same.
- Use a PriorityQueue to always pick the most frequent remaining character that differs from the last placed.

---

### 18.5 Greedy Pattern 4: Greedy on Sorted Data

Many greedy problems reduce to: sort the data by some criterion, then make a single pass assigning or pairing elements.

**Recognition signal:** The problem involves matching, assigning, or partitioning elements, and the optimal strategy becomes obvious once the data is sorted.

**Examples:**
- Assign cookies: sort children by greed factor and cookies by size. Match smallest satisfiable cookie to least greedy child.
- Boats to save people: sort by weight. Two pointers -- pair lightest with heaviest if they fit, otherwise heaviest goes alone.
- Queue reconstruction by height: sort by height descending, then by k ascending. Insert each person at index k.

---

### 18.6 Greedy Pattern 5: Jump/Reach Greedy

These problems involve moving through an array where each element defines a reachable range. The greedy strategy tracks the farthest reachable position and makes decisions based on that frontier.

**Template:**
```java
int farthest = 0;
int currentEnd = 0;
int jumps = 0;

for (int i = 0; i < nums.length - 1; i++) {
    farthest = Math.max(farthest, i + nums[i]);
    if (i == currentEnd) {        // must jump now
        jumps++;
        currentEnd = farthest;
        if (currentEnd >= nums.length - 1) break;
    }
}
```

**Why this works:** At each "level" (positions reachable with k jumps), you compute the farthest position reachable with k+1 jumps. This is essentially BFS where each level represents one jump.

**Gas Station (circular route):** If total gas >= total cost, a solution exists. The greedy insight: start from the position after the point where cumulative surplus is at its minimum. This avoids an O(N^2) brute-force check of all starting positions.

---

## Problems -- Part A: Greedy

---

**P18.01** [M] -- Non-overlapping Intervals (LeetCode 435)

Given an array of intervals, find the minimum number of intervals to remove to make the rest non-overlapping.

```
Pattern: Interval scheduling. Equivalent to: find the maximum number of non-overlapping
intervals, then subtract from total. Sort by end time, greedily keep non-overlapping.
```

```java
public int eraseOverlapIntervals(int[][] intervals) {
    if (intervals.length <= 1) return 0;
    
    // Sort by end time -- the key greedy choice
    Arrays.sort(intervals, (a, b) -> Integer.compare(a[1], b[1]));
    
    int kept = 1;               // keep the first interval
    int prevEnd = intervals[0][1];
    
    for (int i = 1; i < intervals.length; i++) {
        if (intervals[i][0] >= prevEnd) {   // no overlap
            kept++;
            prevEnd = intervals[i][1];
        }
        // If overlap, skip this interval (remove it) -- prevEnd stays the same
        // because we already have the interval that ends earliest
    }
    
    return intervals.length - kept;
}
```

```
Time:  O(N log N) for sort + O(N) scan = O(N log N)
Space: O(log N) for sort (Arrays.sort on Object[] uses TimSort, O(N) space;
       but the sort space for primitives would be O(log N) -- here we sort Object[],
       so it is O(N) for TimSort's merge buffer)
JVM note: Arrays.sort for int[][] dispatches to TimSort (not dual-pivot quicksort,
  which is only for primitive arrays). TimSort is stable and O(N log N) worst case,
  but allocates O(N) temporary storage for merges.
Real-world: meeting room deconfliction, TV broadcast scheduling, bandwidth allocation.
```

---

**P18.02** [M] -- Minimum Number of Arrows to Burst Balloons (LeetCode 452)

Balloons span horizontal ranges [x_start, x_end]. An arrow shot at x bursts all balloons where x_start <= x <= x_end. Find the minimum arrows needed.

```
Pattern: Interval scheduling variant. Each arrow covers overlapping balloons.
Equivalent to finding the maximum set of non-overlapping ranges + counting the groups.
Sort by end. Shoot arrow at end of first unbursted balloon.
```

```java
public int findMinArrowShots(int[][] points) {
    if (points.length == 0) return 0;
    
    // Sort by end coordinate
    // MUST use Integer.compare to avoid overflow with extreme values
    Arrays.sort(points, (a, b) -> Integer.compare(a[1], b[1]));
    
    int arrows = 1;
    int arrowPos = points[0][1];  // shoot at end of first balloon
    
    for (int i = 1; i < points.length; i++) {
        if (points[i][0] > arrowPos) {
            // This balloon starts after current arrow position -- need new arrow
            arrows++;
            arrowPos = points[i][1];
        }
        // else: current arrow already bursts this balloon
    }
    
    return arrows;
}
```

```
Time:  O(N log N)
Space: O(log N) to O(N) depending on sort implementation
Key subtlety: this problem uses <= (touching counts as overlap), unlike P18.01
  which uses >= (touching means non-overlapping). Read the problem statement carefully.
Real-world: minimum sensors to cover overlapping detection zones, minimum probes to
  test overlapping test ranges in hardware verification.
```

---

**P18.03** [M] -- Merge Intervals (LeetCode 56)

Given a collection of intervals, merge all overlapping intervals.

```
Pattern: Interval merging. Sort by start time, then merge greedily.
Not a "selection" problem but a "combine" problem -- different sort criterion.
```

```java
public int[][] merge(int[][] intervals) {
    if (intervals.length <= 1) return intervals;
    
    // Sort by start time for merging
    Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));
    
    List<int[]> merged = new ArrayList<>();
    int[] current = intervals[0];
    merged.add(current);
    
    for (int i = 1; i < intervals.length; i++) {
        if (intervals[i][0] <= current[1]) {
            // Overlapping -- extend current interval
            current[1] = Math.max(current[1], intervals[i][1]);
        } else {
            // No overlap -- start new interval
            current = intervals[i];
            merged.add(current);
        }
    }
    
    return merged.toArray(new int[merged.size()][]);
}
```

```
Time:  O(N log N)
Space: O(N) for the output list (O(log N) for sort if ignoring output)
JVM note: merged.toArray(new int[merged.size()][]) allocates a new array and copies
  references. The int[] elements themselves are NOT copied -- they point to the same
  objects added during iteration. This is safe here because we do not modify them after.
Real-world: consolidating overlapping time ranges in log aggregation, merging
  overlapping IP address ranges in firewall rules, calendar event deconfliction.
```

---

**P18.04** [E] -- Meeting Rooms (LeetCode 252)

Given an array of meeting time intervals, determine if a person could attend all meetings.

```
Pattern: Overlap detection. Sort by start time, check if any consecutive pair overlaps.
Simplest interval problem -- good warm-up.
```

```java
public boolean canAttendMeetings(int[][] intervals) {
    Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));
    
    for (int i = 1; i < intervals.length; i++) {
        if (intervals[i][0] < intervals[i - 1][1]) {
            return false;  // overlap detected
        }
    }
    return true;
}
```

```
Time:  O(N log N)
Space: O(log N) for sort
Real-world: validating a single resource's schedule for conflicts.
```

---

**P18.05** [M] -- Meeting Rooms II (LeetCode 253)

Given meeting time intervals, find the minimum number of conference rooms required.

```
Pattern: Sweep line / event-based greedy. Track concurrent meetings.
Two equivalent approaches: min-heap of end times, or event sorting.
```

```java
// Approach 1: Min-heap of end times
public int minMeetingRooms(int[][] intervals) {
    Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));
    
    PriorityQueue<Integer> endTimes = new PriorityQueue<>();
    
    for (int[] interval : intervals) {
        if (!endTimes.isEmpty() && endTimes.peek() <= interval[0]) {
            endTimes.poll();  // reuse the room that finishes earliest
        }
        endTimes.offer(interval[1]);
    }
    
    return endTimes.size();
}

// Approach 2: Event sorting (sweep line) -- often cleaner for variants
public int minMeetingRooms2(int[][] intervals) {
    int n = intervals.length;
    int[] starts = new int[n];
    int[] ends = new int[n];
    
    for (int i = 0; i < n; i++) {
        starts[i] = intervals[i][0];
        ends[i] = intervals[i][1];
    }
    
    Arrays.sort(starts);
    Arrays.sort(ends);
    
    int rooms = 0, endPtr = 0;
    for (int i = 0; i < n; i++) {
        if (starts[i] < ends[endPtr]) {
            rooms++;       // need a new room
        } else {
            endPtr++;      // free up a room
        }
    }
    return rooms;
}
```

```
Time:  O(N log N) for both approaches
Space: O(N) for the heap or the sorted arrays
Approach 2 is faster in practice: Arrays.sort on int[] uses dual-pivot quicksort
  (no object overhead), while the PriorityQueue autoboxes every int to Integer.
  For 100K meetings, this autoboxing creates 200K Integer objects vs zero for approach 2.
Real-world: cloud resource provisioning (minimum VMs needed for concurrent jobs),
  database connection pool sizing, thread pool capacity planning.
```

---

**P18.06** [M] -- Insert Interval (LeetCode 57)

Insert a new interval into a sorted list of non-overlapping intervals and merge if necessary.

```
Pattern: Three-phase interval processing. Add all intervals before the new one,
merge overlapping ones, add all intervals after.
```

```java
public int[][] insert(int[][] intervals, int[] newInterval) {
    List<int[]> result = new ArrayList<>();
    int i = 0;
    int n = intervals.length;
    
    // Phase 1: add all intervals ending before newInterval starts
    while (i < n && intervals[i][1] < newInterval[0]) {
        result.add(intervals[i]);
        i++;
    }
    
    // Phase 2: merge overlapping intervals with newInterval
    while (i < n && intervals[i][0] <= newInterval[1]) {
        newInterval[0] = Math.min(newInterval[0], intervals[i][0]);
        newInterval[1] = Math.max(newInterval[1], intervals[i][1]);
        i++;
    }
    result.add(newInterval);
    
    // Phase 3: add all remaining intervals
    while (i < n) {
        result.add(intervals[i]);
        i++;
    }
    
    return result.toArray(new int[result.size()][]);
}
```

```
Time:  O(N) -- single pass through the sorted intervals (no sorting needed)
Space: O(N) for the output
Key insight: the input is already sorted, so no need to re-sort. This is O(N), not
  O(N log N). Many candidates miss this and sort unnecessarily.
Real-world: inserting a new reservation into a sorted schedule, adding a memory
  allocation to a sorted free-list in a custom allocator.
```

---

**P18.07** [M] -- Minimum Cost to Connect Sticks (LeetCode 1167)

Given N sticks of various lengths, connect them into one stick. The cost of connecting two sticks is the sum of their lengths. Find the minimum total cost.

```
Pattern: Huffman coding. Always merge the two shortest sticks first.
Merging short sticks early minimizes the total because their cost is counted in
every subsequent merge that includes their combined stick.
```

```java
public int connectSticks(int[] sticks) {
    PriorityQueue<Integer> pq = new PriorityQueue<>();
    for (int s : sticks) pq.offer(s);
    
    int totalCost = 0;
    
    while (pq.size() > 1) {
        int first = pq.poll();
        int second = pq.poll();
        int combined = first + second;
        totalCost += combined;
        pq.offer(combined);
    }
    
    return totalCost;
}
```

```
Time:  O(N log N) -- N-1 merges, each with O(log N) heap operations
Space: O(N) for the heap
This is literally Huffman's algorithm applied to stick merging. The exchange argument
  proof is identical: merging two longer sticks early creates a large combined weight
  that incurs higher costs in subsequent merges.
Real-world: optimal file merge strategy (merging sorted files of different sizes,
  cost proportional to total size), database merge-sort of multiple sorted runs.
```

---

**P18.08** [M] -- Task Scheduler (LeetCode 621)

Given tasks and a cooldown interval n, find the minimum number of intervals to complete all tasks.

```
Pattern: Frequency-based greedy scheduling. Most frequent task determines the frame.
Formula: max(total_tasks, (maxFreq - 1) * (n + 1) + countOfMaxFreq)
```

```java
public int leastInterval(char[] tasks, int n) {
    int[] freq = new int[26];
    for (char t : tasks) freq[t - 'A']++;
    
    int maxFreq = 0;
    int countOfMax = 0;
    for (int f : freq) {
        if (f > maxFreq) {
            maxFreq = f;
            countOfMax = 1;
        } else if (f == maxFreq) {
            countOfMax++;
        }
    }
    
    // Frame: (maxFreq-1) blocks of size (n+1), plus a final partial block
    int frameSlots = (maxFreq - 1) * (n + 1) + countOfMax;
    
    // Answer is the maximum of: the frame (with idle slots) or the total tasks
    // (if there are enough different tasks to fill all idle slots)
    return Math.max(tasks.length, frameSlots);
}
```

```
Time:  O(N) where N is number of tasks (one pass to count, constant work for 26 letters)
Space: O(1) -- 26-element frequency array
Visualization for tasks=[A,A,A,B,B,B,C,C], n=2:
  Frame: A _ _ | A _ _ | A B C    (maxFreq-1=2 blocks of size 3, plus final block)
  Fill:  A B C | A B C | A B      (no idle slots needed -- enough variety)
  Result: max(8, 2*3+2) = max(8, 8) = 8
Real-world: thread pool with cooldown (rate limiting), CPU scheduling with cache
  invalidation delays, job scheduling with machine setup times.
```

---

**P18.09** [M] -- Reorganize String (LeetCode 767)

Rearrange a string so that no two adjacent characters are the same. Return "" if impossible.

```
Pattern: Greedy with max-heap. Always place the most frequent unused character
that differs from the last placed character.
```

```java
public String reorganizeString(String s) {
    int[] freq = new int[26];
    for (char c : s.toCharArray()) freq[c - 'a']++;
    
    // Check feasibility: most frequent char cannot exceed (len+1)/2
    int maxFreq = 0;
    for (int f : freq) maxFreq = Math.max(maxFreq, f);
    if (maxFreq > (s.length() + 1) / 2) return "";
    
    // Max-heap of (frequency, character)
    PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> b[0] - a[0]);
    for (int i = 0; i < 26; i++) {
        if (freq[i] > 0) pq.offer(new int[]{freq[i], i});
    }
    
    StringBuilder sb = new StringBuilder();
    
    while (pq.size() >= 2) {
        int[] first = pq.poll();    // most frequent
        int[] second = pq.poll();   // second most frequent
        
        sb.append((char) (first[1] + 'a'));
        sb.append((char) (second[1] + 'a'));
        
        first[0]--;
        second[0]--;
        
        if (first[0] > 0) pq.offer(first);
        if (second[0] > 0) pq.offer(second);
    }
    
    if (!pq.isEmpty()) {
        sb.append((char) (pq.poll()[1] + 'a'));
    }
    
    return sb.toString();
}
```

```
Time:  O(N log 26) = O(N) -- at most 26 entries in the heap
Space: O(N) for the StringBuilder (O(1) auxiliary since heap has at most 26 entries)
The b[0] - a[0] comparator is safe here because frequencies are non-negative and at most
  N (no overflow risk for any reasonable string length).
Real-world: interleaving tasks from different categories, distributing items on a
  conveyor belt to avoid consecutive same-type items.
```

---

**P18.10** [H] -- IPO (LeetCode 502)

Given N projects with profits and capital requirements, and starting capital W, maximize capital after completing at most K projects.

```
Pattern: Two-heap greedy. Sort by capital requirement, use a max-heap for available profits.
At each step, unlock all projects affordable with current capital, then pick the
most profitable one.
```

```java
public int findMaximizedCapital(int k, int w, int[] profits, int[] capital) {
    int n = profits.length;
    int[][] projects = new int[n][2];
    for (int i = 0; i < n; i++) {
        projects[i][0] = capital[i];
        projects[i][1] = profits[i];
    }
    
    // Sort by capital requirement (ascending)
    Arrays.sort(projects, (a, b) -> Integer.compare(a[0], b[0]));
    
    // Max-heap of profits for affordable projects
    PriorityQueue<Integer> maxProfit = new PriorityQueue<>(Collections.reverseOrder());
    
    int idx = 0;
    for (int i = 0; i < k; i++) {
        // Unlock all newly affordable projects
        while (idx < n && projects[idx][0] <= w) {
            maxProfit.offer(projects[idx][1]);
            idx++;
        }
        
        if (maxProfit.isEmpty()) break;  // no affordable project
        w += maxProfit.poll();            // do the most profitable one
    }
    
    return w;
}
```

```
Time:  O(N log N) for sorting + O(N log N) for heap operations = O(N log N)
Space: O(N) for the heap
The two-heap (or sort + heap) pattern appears frequently: one structure orders
  the unlocking condition, the other selects the best among unlocked choices.
Real-world: venture capital investment strategy (invest in what you can afford
  that yields the most, then use returns to unlock larger investments).
```

---

**P18.11** [E] -- Assign Cookies (LeetCode 455)

Assign cookies to children. Each child has a greed factor; each cookie has a size. A cookie satisfies a child if size >= greed factor. Maximize the number of satisfied children.

```
Pattern: Greedy on sorted data. Sort both arrays, match smallest sufficient cookie
to least greedy child.
```

```java
public int findContentChildren(int[] g, int[] s) {
    Arrays.sort(g);  // children's greed factors
    Arrays.sort(s);  // cookie sizes
    
    int child = 0, cookie = 0;
    while (child < g.length && cookie < s.length) {
        if (s[cookie] >= g[child]) {
            child++;  // child satisfied
        }
        cookie++;     // cookie used (or too small, skip it)
    }
    return child;
}
```

```
Time:  O(N log N + M log M) for sorting
Space: O(log N + log M) for sort (dual-pivot quicksort on int[])
Exchange argument: if you assign a larger cookie to a less greedy child when a smaller
  cookie would suffice, you waste capacity. The greedy matching is optimal.
Real-world: resource allocation where you want to satisfy the maximum number of
  requests with limited resources.
```

---

**P18.12** [M] -- Boats to Save People (LeetCode 881)

People with weights, boats with weight limit. Each boat carries at most 2 people. Minimize boats.

```
Pattern: Two-pointer greedy on sorted data. Pair heaviest with lightest if they fit.
```

```java
public int numRescueBoats(int[] people, int limit) {
    Arrays.sort(people);
    int lo = 0, hi = people.length - 1;
    int boats = 0;
    
    while (lo <= hi) {
        if (people[lo] + people[hi] <= limit) {
            lo++;  // lightest person pairs with heaviest
        }
        hi--;      // heaviest person always boards
        boats++;
    }
    
    return boats;
}
```

```
Time:  O(N log N) for sort + O(N) two-pointer pass
Space: O(log N) for sort
Why pair heaviest with lightest? The heaviest person must go on a boat. If they can
  share with the lightest remaining person, we save a boat. If not, they go alone --
  and no other pairing partner could work either (since lightest is the best candidate).
Real-world: bin packing with maximum 2 items per bin, vehicle load balancing.
```

---

**P18.13** [M] -- Partition Labels (LeetCode 763)

Partition a string into the fewest parts so that each letter appears in at most one part.

```
Pattern: Greedy interval merging in disguise. Each character defines an interval
[first occurrence, last occurrence]. Find the minimum set of intervals covering all characters.
```

```java
public List<Integer> partitionLabels(String s) {
    int[] lastIndex = new int[26];
    for (int i = 0; i < s.length(); i++) {
        lastIndex[s.charAt(i) - 'a'] = i;
    }
    
    List<Integer> result = new ArrayList<>();
    int start = 0, end = 0;
    
    for (int i = 0; i < s.length(); i++) {
        end = Math.max(end, lastIndex[s.charAt(i) - 'a']);
        if (i == end) {
            result.add(end - start + 1);
            start = end + 1;
        }
    }
    
    return result;
}
```

```
Time:  O(N) -- two passes over the string
Space: O(1) -- 26-element array
The key insight: as we scan left to right, the current partition must extend to at
  least the last occurrence of every character we have seen. When our position reaches
  the current partition's end, we know no character in this partition appears later.
Real-world: log file segmentation where each session's events must be in one segment.
```

---

**P18.14** [M] -- Queue Reconstruction by Height (LeetCode 406)

People described by (h, k) where h is height and k is the number of people taller or equal in front of them. Reconstruct the queue.

```
Pattern: Greedy on sorted data with insertion. Sort tallest first; for same height,
sort by k ascending. Insert each person at index k.
```

```java
public int[][] reconstructQueue(int[][] people) {
    // Sort: tallest first; if same height, fewer people in front first
    Arrays.sort(people, (a, b) -> a[0] == b[0] ? a[1] - b[1] : b[0] - a[0]);
    
    List<int[]> result = new LinkedList<>();
    for (int[] p : people) {
        result.add(p[1], p);  // insert at index k
    }
    
    return result.toArray(new int[people.length][]);
}
```

```
Time:  O(N^2) -- each LinkedList.add(index, element) is O(N) due to traversal
Space: O(N) for the result list
JVM trap: LinkedList.add(int index, E element) is O(N) -- it must traverse to the
  insertion point. Despite being a "linked list," random-access insertion is NOT O(1).
  An ArrayList would be O(N) too due to array shifting, but with better cache behavior.
  For large N, consider a BIT-based approach for O(N log^2 N).
Why this works: when we insert a tall person at index k, only taller-or-equal people
  already placed count. Shorter people inserted later do not affect k for taller people.
Real-world: reconstructing orderings from partial rank information.
```

---

**P18.15** [M] -- Minimum Number of Platforms (Variation of Meeting Rooms II)

Given arrival and departure times of trains, find minimum platforms needed.

```
Pattern: Event sweep line. Identical to Meeting Rooms II.
```

```java
public int findPlatform(int[] arr, int[] dep) {
    Arrays.sort(arr);
    Arrays.sort(dep);
    
    int platforms = 0, maxPlatforms = 0;
    int i = 0, j = 0;
    
    while (i < arr.length) {
        if (arr[i] <= dep[j]) {
            platforms++;
            i++;
        } else {
            platforms--;
            j++;
        }
        maxPlatforms = Math.max(maxPlatforms, platforms);
    }
    
    return maxPlatforms;
}
```

```
Time:  O(N log N) for sorting
Space: O(log N) for sort
Note the <= in arr[i] <= dep[j]: if a train arrives at the same time another departs,
  they need separate platforms (problem-specific rule -- always verify).
Real-world: airport gate scheduling, server capacity planning for concurrent requests.
```

---

**P18.16** [M] -- Jump Game (LeetCode 55)

Given an integer array, you start at index 0. Each element represents the maximum jump length. Return whether you can reach the last index.

```
Pattern: Reach greedy. Track the farthest reachable index.
```

```java
public boolean canJump(int[] nums) {
    int farthest = 0;
    
    for (int i = 0; i < nums.length; i++) {
        if (i > farthest) return false;  // stuck -- cannot reach this index
        farthest = Math.max(farthest, i + nums[i]);
        if (farthest >= nums.length - 1) return true;
    }
    
    return true;
}
```

```
Time:  O(N) -- single pass
Space: O(1)
The greedy invariant: at index i, if i <= farthest, we can reach i. We update farthest
  with the maximum of all jumps seen so far. If at any point i > farthest, we are stuck.
Real-world: reachability analysis in network hops, determining if a sequence of
  buffer sizes allows data to flow through a pipeline.
```

---

**P18.17** [M] -- Jump Game II (LeetCode 45)

Same setup, but find the minimum number of jumps to reach the last index.

```
Pattern: BFS-like reach greedy. Count "levels" where each level is the range
reachable with one more jump.
```

```java
public int jump(int[] nums) {
    int jumps = 0;
    int currentEnd = 0;    // end of current BFS level
    int farthest = 0;      // farthest reach in current level
    
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
```

```
Time:  O(N)
Space: O(1)
This is implicit BFS: currentEnd marks the frontier of "positions reachable in k jumps."
  When we reach currentEnd, we must take another jump, and farthest becomes the new frontier.
Real-world: minimum-hop routing in networks, minimum number of relay stations.
```

---

**P18.18** [M] -- Gas Station (LeetCode 134)

N gas stations in a circle. gas[i] is fuel gained at station i, cost[i] is fuel to reach station i+1. Find the starting station to complete a circuit, or -1.

```
Pattern: Cumulative surplus greedy. If total gas >= total cost, solution exists.
Start from the position after the minimum surplus point.
```

```java
public int canCompleteCircuit(int[] gas, int[] cost) {
    int totalSurplus = 0;
    int currentSurplus = 0;
    int startStation = 0;
    
    for (int i = 0; i < gas.length; i++) {
        int surplus = gas[i] - cost[i];
        totalSurplus += surplus;
        currentSurplus += surplus;
        
        if (currentSurplus < 0) {
            // Cannot start from startStation or any station between
            // startStation and i -- their prefixes all lead to deficit here
            startStation = i + 1;
            currentSurplus = 0;
        }
    }
    
    return totalSurplus >= 0 ? startStation : -1;
}
```

```
Time:  O(N)
Space: O(1)
Proof: if currentSurplus drops below 0 at station i, no station in [start..i] can be
  a valid start (they would all hit the same deficit at i or earlier). So start must be
  after i. If totalSurplus >= 0, the "after minimum" start is guaranteed to work.
Real-world: circular delivery route planning with fuel/supply constraints.
```

---

**P18.19** [H] -- Candy (LeetCode 135)

Distribute candies to children in a line. Each child gets at least 1. Children with a higher rating than their neighbor must get more. Minimize total candies.

```
Pattern: Two-pass greedy. Left-to-right satisfies left neighbors,
right-to-left satisfies right neighbors. Take max at each position.
```

```java
public int candy(int[] ratings) {
    int n = ratings.length;
    int[] candies = new int[n];
    Arrays.fill(candies, 1);
    
    // Left to right: if rating[i] > rating[i-1], give more than left neighbor
    for (int i = 1; i < n; i++) {
        if (ratings[i] > ratings[i - 1]) {
            candies[i] = candies[i - 1] + 1;
        }
    }
    
    // Right to left: if rating[i] > rating[i+1], need more than right neighbor
    for (int i = n - 2; i >= 0; i--) {
        if (ratings[i] > ratings[i + 1]) {
            candies[i] = Math.max(candies[i], candies[i + 1] + 1);
        }
    }
    
    int total = 0;
    for (int c : candies) total += c;
    return total;
}
```

```
Time:  O(N) -- three passes
Space: O(N) for the candies array
Why two passes? A single left-to-right pass only enforces the left constraint.
  Example: ratings = [1, 3, 2]. Left-to-right gives [1, 2, 1]. But position 1 (rating 3)
  must also have more than position 2 (rating 2). Right-to-left fixes this to [1, 2, 1].
  Actually [1, 2, 1] is already correct here. Consider [1, 3, 4, 2]:
  Left-to-right: [1, 2, 3, 1]. Right-to-left: max with [1, 1, 2, 1] = [1, 2, 3, 1]. Correct.
Real-world: performance-based compensation with relative fairness constraints.
```

---

**P18.20** [M] -- Job Sequencing with Deadlines

Given jobs with deadlines and profits, schedule to maximize profit. Each job takes 1 unit.

```
Pattern: Sort by profit descending, assign to latest available slot before deadline.
Uses a disjoint-set for O(N * alpha(N)) slot finding.
```

```java
public int jobSequencing(int[][] jobs) {
    // jobs[i] = {id, deadline, profit}
    Arrays.sort(jobs, (a, b) -> b[2] - a[2]);  // sort by profit descending
    
    int maxDeadline = 0;
    for (int[] j : jobs) maxDeadline = Math.max(maxDeadline, j[1]);
    
    boolean[] slot = new boolean[maxDeadline + 1];
    int totalProfit = 0;
    int count = 0;
    
    for (int[] job : jobs) {
        // Find the latest available slot at or before the deadline
        for (int t = job[1]; t >= 1; t--) {
            if (!slot[t]) {
                slot[t] = true;
                totalProfit += job[2];
                count++;
                break;
            }
        }
    }
    
    return totalProfit;
}
```

```
Time:  O(N^2) for naive slot search; O(N log N) with Union-Find optimization
Space: O(maxDeadline)
The Union-Find optimization: parent[t] points to the latest available slot at or before t.
  After using slot t, union t with t-1. Find(t) then returns the latest free slot in O(α).
Real-world: deadline-driven task scheduling in project management, print job scheduling.
```

---

**P18.21** [M] -- Minimum Number of Refueling Stops (LeetCode 871)

Start with some fuel, heading to a target. Gas stations along the way. Each stop has fuel. Find minimum stops. (Can skip stations.)

```
Pattern: Lazy greedy with max-heap. Drive as far as possible, then if stuck,
"retroactively" refuel at the best station you passed.
```

```java
public int minRefuelStops(int target, int startFuel, int[][] stations) {
    PriorityQueue<Integer> maxFuel = new PriorityQueue<>(Collections.reverseOrder());
    int fuel = startFuel;
    int stops = 0;
    int prev = 0;
    
    for (int i = 0; i <= stations.length; i++) {
        int location = (i < stations.length) ? stations[i][0] : target;
        fuel -= (location - prev);
        
        // If we run out of fuel, use the best station(s) we passed
        while (fuel < 0 && !maxFuel.isEmpty()) {
            fuel += maxFuel.poll();
            stops++;
        }
        
        if (fuel < 0) return -1;  // cannot reach even with all past stations
        
        if (i < stations.length) {
            maxFuel.offer(stations[i][1]);
        }
        prev = location;
    }
    
    return stops;
}
```

```
Time:  O(N log N) -- each station enters and exits the heap at most once
Space: O(N) for the heap
The "lazy" greedy insight: we do not decide whether to stop at a station when we reach it.
  Instead, we remember it and only "use" it when we need fuel. This way we always
  retroactively pick the station with the most fuel -- optimal by exchange argument.
Real-world: logistics route planning where fuel stops incur time penalties.
```

---

**P18.22** [E] -- Lemonade Change (LeetCode 860)

Customers pay $5, $10, or $20 for $5 lemonade. Return true if you can provide correct change for every customer.

```
Pattern: Greedy change-making. Always prefer $10 bills for $20 change (save $5 bills).
```

```java
public boolean lemonadeChange(int[] bills) {
    int fives = 0, tens = 0;
    
    for (int bill : bills) {
        if (bill == 5) {
            fives++;
        } else if (bill == 10) {
            if (fives == 0) return false;
            fives--;
            tens++;
        } else { // bill == 20
            if (tens > 0 && fives > 0) {
                tens--;
                fives--;
            } else if (fives >= 3) {
                fives -= 3;
            } else {
                return false;
            }
        }
    }
    return true;
}
```

```
Time:  O(N)
Space: O(1)
The greedy choice for $20: prefer giving $10+$5 over $5+$5+$5. The $5 bill is more
  versatile (works as change for both $10 and $20), so we conserve it.
Real-world: cash register management, making change with limited denominations.
```

---

**P18.23** [E] -- Maximum Units on a Truck (LeetCode 1710)

Load boxes onto a truck with limited capacity. Each box type has a count and units per box. Maximize total units.

```
Pattern: Fractional knapsack (greedy). Sort by units per box descending, load greedily.
```

```java
public int maximumUnits(int[][] boxTypes, int truckSize) {
    Arrays.sort(boxTypes, (a, b) -> b[1] - a[1]);  // sort by units desc
    
    int totalUnits = 0;
    for (int[] box : boxTypes) {
        int count = Math.min(box[0], truckSize);
        totalUnits += count * box[1];
        truckSize -= count;
        if (truckSize == 0) break;
    }
    
    return totalUnits;
}
```

```
Time:  O(N log N)
Space: O(log N) for sort
This is the fractional knapsack problem (where items are divisible -- you can take
  partial box types). Greedy works for fractional knapsack but NOT for 0/1 knapsack.
Real-world: warehouse loading optimization, container packing by value density.
```

---

**P18.24** [E] -- Largest Perimeter Triangle (LeetCode 976)

Find the largest perimeter of a triangle that can be formed from an array of lengths.

```
Pattern: Sort descending, check consecutive triples. Triangle inequality: a < b + c.
```

```java
public int largestPerimeter(int[] nums) {
    Arrays.sort(nums);
    
    // Check from the largest triple downward
    for (int i = nums.length - 1; i >= 2; i--) {
        if (nums[i] < nums[i - 1] + nums[i - 2]) {
            return nums[i] + nums[i - 1] + nums[i - 2];
        }
    }
    
    return 0;  // no valid triangle
}
```

```
Time:  O(N log N)
Space: O(log N)
Why consecutive triples? After sorting, if nums[i] >= nums[i-1] + nums[i-2], then
  nums[i] >= nums[j] + nums[k] for all j, k < i-1. So no smaller pair can form a
  triangle with nums[i]. Move to the next triple.
```

---

**P18.25** [E] -- Minimum Subsequence in Non-Increasing Order (LeetCode 1403)

Return a subsequence of the array such that its sum is strictly greater than the sum of the remaining elements, with minimum size. Return it in non-increasing order.

```
Pattern: Sort descending, take elements greedily until sum > remaining.
```

```java
public List<Integer> minSubsequence(int[] nums) {
    Arrays.sort(nums);
    int totalSum = 0;
    for (int n : nums) totalSum += n;
    
    List<Integer> result = new ArrayList<>();
    int subSum = 0;
    
    for (int i = nums.length - 1; i >= 0; i--) {
        subSum += nums[i];
        result.add(nums[i]);
        if (subSum > totalSum - subSum) break;
    }
    
    return result;
}
```

```
Time:  O(N log N)
Space: O(log N) for sort, O(K) for output where K is result size
Greedy correctness: taking the largest remaining element maximizes our sum gain per
  element taken, minimizing the number of elements needed.
```

---

## PART B: BACKTRACKING

### 18.7 The Backtracking Paradigm: Systematic Exhaustive Search

Backtracking is the algorithmic equivalent of exploring a maze: walk forward, hit a wall, retrace your steps, try a different path. More formally, it explores a decision tree where each node represents a partial solution and each branch represents extending that solution by one choice. When a branch violates constraints or cannot lead to a valid complete solution, we prune it -- cutting off an entire subtree of exploration.

#### 18.7.1 The Decision Tree

Every backtracking problem can be visualized as a tree:

```
Subsets of {1, 2, 3} -- decision tree:

                        []
                    /        \
              include 1     skip 1
                /    \        /    \
          inc 2  skip 2   inc 2  skip 2
          / \     / \      / \     / \
        i3  s3  i3  s3   i3  s3  i3  s3
       [1,2,3] [1,2] [1,3] [1] [2,3] [2] [3] []

8 leaf nodes = 2^3 subsets
```

```
Permutations of {1, 2, 3} -- decision tree:

                        []
                /        |        \
              1           2          3
           /    \       /   \      /   \
          2      3     1     3    1     2
          |      |     |     |    |     |
          3      2     3     1    2     1
        [1,2,3] [1,3,2] [2,1,3] [2,3,1] [3,1,2] [3,2,1]

6 leaf nodes = 3! permutations
```

#### 18.7.2 The Universal Backtracking Template

```java
void backtrack(State state, List<Result> results) {
    // Base case: if state is a complete solution
    if (isComplete(state)) {
        results.add(new Result(state));   // copy state into results
        return;
    }
    
    for (Choice choice : getChoices(state)) {
        if (!isValid(state, choice)) continue;  // PRUNE
        
        applyChoice(state, choice);              // CHOOSE
        backtrack(state, results);               // EXPLORE
        undoChoice(state, choice);               // UNCHOOSE (backtrack)
    }
}
```

The three steps -- choose, explore, unchoose -- are the heartbeat of every backtracking algorithm. The "unchoose" step is what distinguishes backtracking from plain DFS: we must restore state exactly as it was before we made the choice.

#### 18.7.3 Pruning: The Art of Not Exploring

Raw backtracking explores the entire decision tree -- O(2^N) for subsets, O(N!) for permutations. Pruning cuts branches early:

```
Without pruning:  explore all 2^N or N! leaves
With pruning:     skip subtrees where constraints are already violated

Example: Combination Sum with target 7, candidates [2, 3, 6, 7]
  If current sum is 8 and target is 7 → PRUNE (sum exceeds target)
  If remaining candidates cannot reach target → PRUNE
  
Effective pruning can reduce runtime by orders of magnitude.
Worst case remains O(2^N) or O(N!) but average case improves dramatically.
```

#### 18.7.4 JVM Considerations for Backtracking

```
Stack depth: Each recursive call adds a frame. For N up to 20-30, this is fine.
  For N > 5000, risk StackOverflowError. Most backtracking problems have small N
  (constraints are typically N <= 20 because 2^20 = 1M is the practical limit).

Object creation: Avoid creating new lists at every recursive call.
  BAD:  backtrack(new ArrayList<>(current), ...) at every branch
  GOOD: current.add(x); backtrack(current, ...); current.remove(current.size() - 1);
  
  The bad pattern creates O(2^N) ArrayList objects, each requiring GC.
  The good pattern reuses one ArrayList, modifying and restoring it.

String building: Use StringBuilder, not String concatenation.
  BAD:  backtrack(path + "(" , ...) -- creates a new String every time
  GOOD: sb.append('('); backtrack(sb, ...); sb.deleteCharAt(sb.length() - 1);
```

#### 18.7.5 Time Complexity of Backtracking

```
Subsets:       O(2^N) subsets × O(N) to copy each = O(N × 2^N)
Permutations:  O(N!) permutations × O(N) to copy each = O(N × N!)
Combinations:  O(C(N,K)) combinations × O(K) to copy each
N-Queens:      O(N!) worst case, but pruning reduces to roughly O(N! / e) average

The space for the recursion stack is O(N) for all of these (depth of decision tree).
```

---

### 18.8 Backtracking Pattern 1: Subsets and Combinations

**Recognition signal:** "Find all subsets", "find all combinations of size k", "find combinations that sum to target."

**Key technique:** Use a start index to avoid duplicates. For subsets, at each position decide include/skip. For combinations, iterate from start to N.

**Handling duplicates:** Sort the array first, then skip `nums[i]` if `nums[i] == nums[i-1]` and `i > start` (the previous identical element was skipped at this level of recursion).

---

### 18.9 Backtracking Pattern 2: Permutations

**Recognition signal:** "Find all orderings", "find all arrangements."

**Key technique:** Use a `boolean[] used` array to track which elements are placed. At each position, try every unused element.

**Handling duplicates:** Sort first. Skip `nums[i]` if `used[i]` or if `nums[i] == nums[i-1]` and `!used[i-1]` (ensures duplicates are used in order).

---

### 18.10 Backtracking Pattern 3: Board/Grid Backtracking

**Recognition signal:** "Place N queens", "solve sudoku", "find a word on a board."

**Key technique:** Use the grid itself as state (mark visited cells by modifying the grid). The choose/unchoose pattern restores cells after exploration.

**Constraint propagation for Sudoku:** Track used numbers per row, column, and 3x3 box using bitmasks or boolean arrays. This prunes invalid placements immediately rather than waiting for a conflict.

---

### 18.11 Backtracking Pattern 4: Partition/Split

**Recognition signal:** "Split string into valid parts", "generate all valid expressions."

**Key technique:** At each position, try all possible split points. Validate the current segment, recurse on the remainder.

---

## Problems -- Part B: Backtracking

---

**P18.26** [M] -- Subsets (LeetCode 78)

Given an integer array with unique elements, return all possible subsets.

```
Pattern: Subset enumeration. At each index, include or skip the element.
```

```java
public List<List<Integer>> subsets(int[] nums) {
    List<List<Integer>> result = new ArrayList<>();
    backtrack(nums, 0, new ArrayList<>(), result);
    return result;
}

private void backtrack(int[] nums, int start, List<Integer> current, 
                       List<List<Integer>> result) {
    result.add(new ArrayList<>(current));  // every node is a valid subset
    
    for (int i = start; i < nums.length; i++) {
        current.add(nums[i]);               // choose
        backtrack(nums, i + 1, current, result);  // explore
        current.remove(current.size() - 1); // unchoose
    }
}
```

```
Time:  O(N × 2^N) -- 2^N subsets, each takes O(N) to copy
Space: O(N) recursion depth + O(N × 2^N) for output
JVM note: new ArrayList<>(current) calls System.arraycopy internally to copy
  the backing array. For a list of size K, this copies K references (4 or 8 bytes each).
  Total copy cost across all subsets: sum over k=0..N of C(N,k)*k = N × 2^(N-1).
Real-world: feature flag combinations for A/B testing, power set enumeration
  for configuration testing.
```

---

**P18.27** [M] -- Subsets II (LeetCode 90)

Same as above but the array may contain duplicates. Return unique subsets.

```
Pattern: Subset enumeration with duplicate skipping. Sort first, skip duplicates.
```

```java
public List<List<Integer>> subsetsWithDup(int[] nums) {
    Arrays.sort(nums);  // MUST sort to group duplicates
    List<List<Integer>> result = new ArrayList<>();
    backtrack(nums, 0, new ArrayList<>(), result);
    return result;
}

private void backtrack(int[] nums, int start, List<Integer> current, 
                       List<List<Integer>> result) {
    result.add(new ArrayList<>(current));
    
    for (int i = start; i < nums.length; i++) {
        // Skip duplicate: if nums[i] == nums[i-1] and i > start,
        // the previous identical value was already explored at this recursion level
        if (i > start && nums[i] == nums[i - 1]) continue;
        
        current.add(nums[i]);
        backtrack(nums, i + 1, current, result);
        current.remove(current.size() - 1);
    }
}
```

```
Time:  O(N × 2^N) worst case (all unique), much less with many duplicates
Space: O(N) recursion depth
The condition i > start (not i > 0) is critical. It means: "skip this duplicate only
  if we already processed an identical value at THIS level of the decision tree."
  At deeper levels (i == start), we can still use the duplicate.
```

---

**P18.28** [M] -- Combinations (LeetCode 77)

Given N and K, return all combinations of K numbers from [1, N].

```
Pattern: Combination enumeration. Like subsets but only collect at size K.
Prune: if remaining elements cannot fill K slots, stop.
```

```java
public List<List<Integer>> combine(int n, int k) {
    List<List<Integer>> result = new ArrayList<>();
    backtrack(n, k, 1, new ArrayList<>(), result);
    return result;
}

private void backtrack(int n, int k, int start, List<Integer> current, 
                       List<List<Integer>> result) {
    if (current.size() == k) {
        result.add(new ArrayList<>(current));
        return;
    }
    
    // Pruning: need (k - current.size()) more elements.
    // Can pick from [start..n], which has (n - start + 1) elements.
    // If n - start + 1 < k - current.size(), impossible. Equivalently:
    // i <= n - (k - current.size()) + 1
    int need = k - current.size();
    for (int i = start; i <= n - need + 1; i++) {
        current.add(i);
        backtrack(n, k, i + 1, current, result);
        current.remove(current.size() - 1);
    }
}
```

```
Time:  O(K × C(N,K)) -- C(N,K) combinations, each takes O(K) to copy
Space: O(K) recursion depth
The pruning condition i <= n - need + 1 is powerful. For N=20, K=18, without pruning
  we explore many branches that cannot possibly produce 18-element combinations.
  With pruning, we only explore C(20,18) = 190 valid branches.
```

---

**P18.29** [M] -- Combination Sum (LeetCode 39)

Given candidates (no duplicates, can reuse elements), find all combinations summing to target.

```
Pattern: Combination with repetition. Pass i (not i+1) to allow reuse.
```

```java
public List<List<Integer>> combinationSum(int[] candidates, int target) {
    Arrays.sort(candidates);  // enables sum-based pruning
    List<List<Integer>> result = new ArrayList<>();
    backtrack(candidates, target, 0, new ArrayList<>(), result);
    return result;
}

private void backtrack(int[] candidates, int remaining, int start, 
                       List<Integer> current, List<List<Integer>> result) {
    if (remaining == 0) {
        result.add(new ArrayList<>(current));
        return;
    }
    
    for (int i = start; i < candidates.length; i++) {
        if (candidates[i] > remaining) break;  // PRUNE: sorted, so all following are too large
        
        current.add(candidates[i]);
        backtrack(candidates, remaining - candidates[i], i, current, result);  // i, not i+1
        current.remove(current.size() - 1);
    }
}
```

```
Time:  O(N^(T/M)) where T is target and M is minimum candidate value
       (maximum recursion depth is T/M, branching factor is N)
Space: O(T/M) recursion depth
The break (not continue) on the pruning line leverages sorted order: if candidates[i]
  exceeds remaining, all candidates[j] for j > i also exceed it. This converts an
  O(N) scan at each level into an early termination.
```

---

**P18.30** [M] -- Combination Sum II (LeetCode 40)

Each candidate can be used at most once. Candidates may have duplicates. Find unique combinations summing to target.

```
Pattern: Combination Sum + duplicate handling (same as Subsets II).
```

```java
public List<List<Integer>> combinationSum2(int[] candidates, int target) {
    Arrays.sort(candidates);
    List<List<Integer>> result = new ArrayList<>();
    backtrack(candidates, target, 0, new ArrayList<>(), result);
    return result;
}

private void backtrack(int[] candidates, int remaining, int start, 
                       List<Integer> current, List<List<Integer>> result) {
    if (remaining == 0) {
        result.add(new ArrayList<>(current));
        return;
    }
    
    for (int i = start; i < candidates.length; i++) {
        if (candidates[i] > remaining) break;
        if (i > start && candidates[i] == candidates[i - 1]) continue; // skip dup
        
        current.add(candidates[i]);
        backtrack(candidates, remaining - candidates[i], i + 1, current, result);  // i+1
        current.remove(current.size() - 1);
    }
}
```

```
Time:  O(2^N) worst case
Space: O(N) recursion depth
Combines three techniques: (1) sort for pruning, (2) i+1 for no-reuse,
  (3) i > start skip for duplicate avoidance. Master these three and you handle
  every combination variant.
```

---

**P18.31** [M] -- Combination Sum III (LeetCode 216)

Find all valid combinations of K numbers (1-9, no repeats) that sum to N.

```
Pattern: Constrained combination. Fixed pool [1..9], exact size K, exact sum N.
```

```java
public List<List<Integer>> combinationSum3(int k, int n) {
    List<List<Integer>> result = new ArrayList<>();
    backtrack(k, n, 1, new ArrayList<>(), result);
    return result;
}

private void backtrack(int k, int remaining, int start, 
                       List<Integer> current, List<List<Integer>> result) {
    if (current.size() == k) {
        if (remaining == 0) result.add(new ArrayList<>(current));
        return;
    }
    
    for (int i = start; i <= 9; i++) {
        if (i > remaining) break;  // prune: even smallest addition exceeds target
        
        current.add(i);
        backtrack(k, remaining - i, i + 1, current, result);
        current.remove(current.size() - 1);
    }
}
```

```
Time:  O(C(9, K)) -- at most C(9, K) combinations, bounded by C(9, 4) = 126
Space: O(K) recursion depth
This is heavily constrained: only digits 1-9, so the search space is tiny.
  Maximum possible combinations: sum of C(9,k) for k=1..9 = 2^9 - 1 = 511.
```

---

**P18.32** [M] -- Permutations (LeetCode 46)

Given an array of distinct integers, return all permutations.

```
Pattern: Permutation enumeration with used array.
```

```java
public List<List<Integer>> permute(int[] nums) {
    List<List<Integer>> result = new ArrayList<>();
    backtrack(nums, new boolean[nums.length], new ArrayList<>(), result);
    return result;
}

private void backtrack(int[] nums, boolean[] used, List<Integer> current, 
                       List<List<Integer>> result) {
    if (current.size() == nums.length) {
        result.add(new ArrayList<>(current));
        return;
    }
    
    for (int i = 0; i < nums.length; i++) {
        if (used[i]) continue;
        
        used[i] = true;
        current.add(nums[i]);
        backtrack(nums, used, current, result);
        current.remove(current.size() - 1);
        used[i] = false;
    }
}
```

```
Time:  O(N × N!) -- N! permutations, each takes O(N) to copy
Space: O(N) for recursion depth and used array
Alternative: swap-based approach avoids the used array by swapping elements into
  position. Less intuitive but avoids the O(N) scan for unused elements:
  swap(nums, start, i); recurse(start+1); swap(nums, start, i);
  The used-array approach is clearer for interviews.
```

---

**P18.33** [M] -- Permutations II (LeetCode 47)

Array may contain duplicates. Return all unique permutations.

```
Pattern: Permutation + duplicate handling. Sort first, enforce usage order for duplicates.
```

```java
public List<List<Integer>> permuteUnique(int[] nums) {
    Arrays.sort(nums);
    List<List<Integer>> result = new ArrayList<>();
    backtrack(nums, new boolean[nums.length], new ArrayList<>(), result);
    return result;
}

private void backtrack(int[] nums, boolean[] used, List<Integer> current, 
                       List<List<Integer>> result) {
    if (current.size() == nums.length) {
        result.add(new ArrayList<>(current));
        return;
    }
    
    for (int i = 0; i < nums.length; i++) {
        if (used[i]) continue;
        // If this is a duplicate of the previous element, only use it
        // if the previous one is already used (enforces order among duplicates)
        if (i > 0 && nums[i] == nums[i - 1] && !used[i - 1]) continue;
        
        used[i] = true;
        current.add(nums[i]);
        backtrack(nums, used, current, result);
        current.remove(current.size() - 1);
        used[i] = false;
    }
}
```

```
Time:  O(N × N!) worst case (all unique), much less with duplicates
Space: O(N)
The condition !used[i-1] ensures that among identical elements, we always use them
  left-to-right. If nums = [1, 1, 2], we only generate [1a, 1b, 2], never [1b, 1a, 2].
  You could also use used[i-1] (the opposite), which also works but prunes less effectively.
```

---

**P18.34** [M] -- Next Permutation (LeetCode 31)

Find the next lexicographically greater permutation in-place.

```
Pattern: Not backtracking but a direct algorithm. Included here because it
complements the permutation family.
Algorithm: (1) find rightmost ascent, (2) find rightmost element larger than it,
(3) swap, (4) reverse suffix.
```

```java
public void nextPermutation(int[] nums) {
    int n = nums.length;
    
    // Step 1: find the rightmost ascent (i such that nums[i] < nums[i+1])
    int i = n - 2;
    while (i >= 0 && nums[i] >= nums[i + 1]) i--;
    
    if (i >= 0) {
        // Step 2: find rightmost element > nums[i]
        int j = n - 1;
        while (nums[j] <= nums[i]) j--;
        
        // Step 3: swap
        int temp = nums[i];
        nums[i] = nums[j];
        nums[j] = temp;
    }
    
    // Step 4: reverse the suffix after position i
    int left = i + 1, right = n - 1;
    while (left < right) {
        int temp = nums[left];
        nums[left] = nums[right];
        nums[right] = temp;
        left++;
        right--;
    }
}
```

```
Time:  O(N)
Space: O(1) -- in-place
This is a classical algorithm from the 1960s. The suffix after the rightmost ascent is
  in descending order. Swapping the ascent point with the smallest element in the suffix
  that is larger than it, then reversing the suffix, produces the next permutation.
  If no ascent exists (fully descending), the reversal produces the smallest permutation.
```

---

**P18.35** [H] -- N-Queens (LeetCode 51)

Place N queens on an N x N chessboard so that no two queens threaten each other.

```
Pattern: Board backtracking with constraint tracking. Place one queen per row.
Track attacked columns, diagonals, and anti-diagonals.
```

```java
public List<List<String>> solveNQueens(int n) {
    List<List<String>> result = new ArrayList<>();
    boolean[] cols = new boolean[n];
    boolean[] diag = new boolean[2 * n - 1];      // row - col + (n-1) maps to [0, 2n-2]
    boolean[] antiDiag = new boolean[2 * n - 1];   // row + col maps to [0, 2n-2]
    int[] queens = new int[n];  // queens[row] = column
    
    backtrack(n, 0, queens, cols, diag, antiDiag, result);
    return result;
}

private void backtrack(int n, int row, int[] queens, boolean[] cols, 
                       boolean[] diag, boolean[] antiDiag, 
                       List<List<String>> result) {
    if (row == n) {
        result.add(buildBoard(queens, n));
        return;
    }
    
    for (int col = 0; col < n; col++) {
        int d = row - col + n - 1;
        int ad = row + col;
        
        if (cols[col] || diag[d] || antiDiag[ad]) continue;  // PRUNE
        
        queens[row] = col;
        cols[col] = diag[d] = antiDiag[ad] = true;
        
        backtrack(n, row + 1, queens, cols, diag, antiDiag, result);
        
        cols[col] = diag[d] = antiDiag[ad] = false;  // unchoose
    }
}

private List<String> buildBoard(int[] queens, int n) {
    List<String> board = new ArrayList<>();
    for (int row = 0; row < n; row++) {
        char[] line = new char[n];
        Arrays.fill(line, '.');
        line[queens[row]] = 'Q';
        board.add(new String(line));
    }
    return board;
}
```

```
Time:  O(N!) -- at most N choices for row 0, N-1 for row 1 (minus pruned), etc.
Space: O(N) for the recursion stack and constraint arrays
N=8: 92 solutions. N=12: 14,200 solutions. N=15: 2,279,184 solutions.
The constraint arrays avoid O(N) queen-conflict checks per placement.
  Without them, each placement requires scanning all previously placed queens.
  With them, each check is O(1) using array lookups.
Alternative: use bitmasks (int cols, int diag, int antiDiag) for even faster checks.
  Bit operations are faster than array access for small N.
Real-world: constraint satisfaction in VLSI placement, non-attacking resource allocation.
```

---

**P18.36** [H] -- N-Queens II (LeetCode 52)

Return the count of distinct N-Queens solutions (no need to build boards).

```
Pattern: Same backtracking, just count instead of collecting solutions.
```

```java
public int totalNQueens(int n) {
    return backtrack(n, 0, new boolean[n], new boolean[2*n-1], new boolean[2*n-1]);
}

private int backtrack(int n, int row, boolean[] cols, 
                      boolean[] diag, boolean[] antiDiag) {
    if (row == n) return 1;
    
    int count = 0;
    for (int col = 0; col < n; col++) {
        int d = row - col + n - 1, ad = row + col;
        if (cols[col] || diag[d] || antiDiag[ad]) continue;
        
        cols[col] = diag[d] = antiDiag[ad] = true;
        count += backtrack(n, row + 1, cols, diag, antiDiag);
        cols[col] = diag[d] = antiDiag[ad] = false;
    }
    return count;
}
```

```
Time:  O(N!) with pruning
Space: O(N)
Faster than P18.35 because we skip board construction and list allocation.
  For N=15, this is the difference between ~5 seconds and ~15 seconds on a modern JVM.
```

---

**P18.37** [H] -- Sudoku Solver (LeetCode 37)

Fill a 9x9 Sudoku board.

```
Pattern: Grid backtracking with heavy constraint tracking.
For each empty cell, try digits 1-9, validate, recurse.
```

```java
public void solveSudoku(char[][] board) {
    boolean[][] rows = new boolean[9][10];
    boolean[][] cols = new boolean[9][10];
    boolean[][] boxes = new boolean[9][10];
    
    // Initialize constraint arrays from the given board
    for (int r = 0; r < 9; r++) {
        for (int c = 0; c < 9; c++) {
            if (board[r][c] != '.') {
                int num = board[r][c] - '0';
                int box = (r / 3) * 3 + c / 3;
                rows[r][num] = cols[c][num] = boxes[box][num] = true;
            }
        }
    }
    
    solve(board, rows, cols, boxes, 0, 0);
}

private boolean solve(char[][] board, boolean[][] rows, boolean[][] cols, 
                      boolean[][] boxes, int r, int c) {
    if (r == 9) return true;  // all cells filled
    int nextR = (c == 8) ? r + 1 : r;
    int nextC = (c == 8) ? 0 : c + 1;
    
    if (board[r][c] != '.') {
        return solve(board, rows, cols, boxes, nextR, nextC);
    }
    
    int box = (r / 3) * 3 + c / 3;
    for (int num = 1; num <= 9; num++) {
        if (rows[r][num] || cols[c][num] || boxes[box][num]) continue;
        
        board[r][c] = (char) ('0' + num);
        rows[r][num] = cols[c][num] = boxes[box][num] = true;
        
        if (solve(board, rows, cols, boxes, nextR, nextC)) return true;
        
        board[r][c] = '.';
        rows[r][num] = cols[c][num] = boxes[box][num] = false;
    }
    
    return false;  // no valid digit for this cell -- backtrack
}
```

```
Time:  O(9^(empty cells)) worst case, but pruning makes it much faster in practice.
       Typical Sudoku puzzles (17+ clues) solve in microseconds.
Space: O(81) for recursion depth (at most 81 cells) = O(1)
The constraint arrays convert O(9) validity checks (scan row/col/box) into O(1) lookups.
  For the 81 × 9 = 729 potential placements, this saves thousands of operations.
Advanced: use bitmasks (int rowMask[9], colMask[9], boxMask[9]) where bit i indicates
  digit i is used. Then available digits = ~(rowMask[r] | colMask[c] | boxMask[box]) & 0x3FE.
  Iterate set bits for even faster enumeration.
Real-world: constraint satisfaction problems in AI, SAT solvers, configuration validation.
```

---

**P18.38** [M] -- Word Search (LeetCode 79)

Given a 2D board of characters and a word, find if the word exists in the board by following adjacent cells (no reuse).

```
Pattern: Grid DFS with backtracking. Try each cell as starting point, DFS for the word.
```

```java
public boolean exist(char[][] board, String word) {
    int m = board.length, n = board[0].length;
    
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (dfs(board, word, i, j, 0)) return true;
        }
    }
    return false;
}

private boolean dfs(char[][] board, String word, int r, int c, int idx) {
    if (idx == word.length()) return true;
    if (r < 0 || r >= board.length || c < 0 || c >= board[0].length) return false;
    if (board[r][c] != word.charAt(idx)) return false;
    
    char temp = board[r][c];
    board[r][c] = '#';  // mark visited (modify grid to avoid boolean[][])
    
    boolean found = dfs(board, word, r + 1, c, idx + 1)
                 || dfs(board, word, r - 1, c, idx + 1)
                 || dfs(board, word, r, c + 1, idx + 1)
                 || dfs(board, word, r, c - 1, idx + 1);
    
    board[r][c] = temp;  // unchoose: restore original character
    return found;
}
```

```
Time:  O(M × N × 3^L) where L is word length. From each cell, 3 choices (not 4,
       because we do not revisit the cell we came from).
Space: O(L) recursion depth
JVM note: the short-circuit || evaluation means we stop exploring as soon as one
  direction finds the word. This is significant pruning in practice.
  Also: modifying board[r][c] to '#' avoids allocating a boolean[M][N] visited array.
  For a 200×200 board, that saves 40,000 bytes of heap allocation per word search.
```

---

**P18.39** [H] -- Word Search II (LeetCode 212)

Find all words from a dictionary that exist on the board.

```
Pattern: Trie + backtracking. Build a Trie from the word list, then DFS on the board
using the Trie to prune dead-end paths.
```

```java
class TrieNode {
    TrieNode[] children = new TrieNode[26];
    String word = null;  // store the complete word at terminal nodes
}

public List<String> findWords(char[][] board, String[] words) {
    // Build Trie
    TrieNode root = new TrieNode();
    for (String w : words) {
        TrieNode node = root;
        for (char c : w.toCharArray()) {
            int idx = c - 'a';
            if (node.children[idx] == null) node.children[idx] = new TrieNode();
            node = node.children[idx];
        }
        node.word = w;
    }
    
    List<String> result = new ArrayList<>();
    int m = board.length, n = board[0].length;
    
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
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
        node.word = null;  // avoid duplicates -- de-register after finding
    }
    
    board[r][c] = '#';  // mark visited
    
    dfs(board, r + 1, c, node, result);
    dfs(board, r - 1, c, node, result);
    dfs(board, r, c + 1, node, result);
    dfs(board, r, c - 1, node, result);
    
    board[r][c] = ch;  // restore
    
    // Optimization: prune empty Trie branches to speed up future searches
    // If all children are null and word is null, this node is dead -- but the
    // cleanup is complex and rarely needed for interview.
}
```

```
Time:  O(M × N × 4 × 3^(L-1)) per word, but the Trie prunes massively.
       Shared prefixes are explored only once per starting cell.
Space: O(total characters in words) for the Trie + O(L) recursion depth
The Trie transforms this from O(W × M × N × 3^L) (naive: search each word separately)
  to exploring each cell path once while simultaneously checking against all words.
  For W=10000 words of length 10, this is the difference between TLE and accepted.
Real-world: spell checking on a game board (Boggle), pattern matching across a grid.
```

---

**P18.40** [M] -- Palindrome Partitioning (LeetCode 131)

Partition a string into substrings where every substring is a palindrome.

```
Pattern: String partition backtracking. At each position, try all split points
where the prefix is a palindrome.
```

```java
public List<List<String>> partition(String s) {
    List<List<String>> result = new ArrayList<>();
    backtrack(s, 0, new ArrayList<>(), result);
    return result;
}

private void backtrack(String s, int start, List<String> current, 
                       List<List<String>> result) {
    if (start == s.length()) {
        result.add(new ArrayList<>(current));
        return;
    }
    
    for (int end = start + 1; end <= s.length(); end++) {
        if (isPalindrome(s, start, end - 1)) {
            current.add(s.substring(start, end));
            backtrack(s, end, current, result);
            current.remove(current.size() - 1);
        }
    }
}

private boolean isPalindrome(String s, int lo, int hi) {
    while (lo < hi) {
        if (s.charAt(lo++) != s.charAt(hi--)) return false;
    }
    return true;
}
```

```
Time:  O(N × 2^N) -- 2^(N-1) possible partitions (each gap is split or not),
       O(N) palindrome check per partition
Space: O(N) recursion depth
Optimization: precompute a boolean[][] isPalin where isPalin[i][j] = true if s[i..j]
  is a palindrome. This uses O(N^2) space but avoids redundant palindrome checks.
  Compute via DP: isPalin[i][j] = (s[i]==s[j]) && (j-i<=2 || isPalin[i+1][j-1]).
Real-world: text segmentation in NLP where each segment must satisfy a constraint.
```

---

**P18.41** [M] -- Restore IP Addresses (LeetCode 93)

Given a string of digits, return all valid IP addresses that can be formed.

```
Pattern: String partition backtracking with strict constraints (4 parts, each 0-255).
```

```java
public List<String> restoreIpAddresses(String s) {
    List<String> result = new ArrayList<>();
    backtrack(s, 0, 0, new StringBuilder(), result);
    return result;
}

private void backtrack(String s, int start, int parts, StringBuilder sb, 
                       List<String> result) {
    if (parts == 4) {
        if (start == s.length()) {
            result.add(sb.substring(0, sb.length() - 1)); // remove trailing dot
        }
        return;
    }
    
    // Each part is 1-3 digits
    for (int len = 1; len <= 3 && start + len <= s.length(); len++) {
        String segment = s.substring(start, start + len);
        
        // Prune: no leading zeros (except "0" itself), value must be <= 255
        if (segment.length() > 1 && segment.charAt(0) == '0') break;
        if (Integer.parseInt(segment) > 255) break;
        
        // Prune: check remaining digits can form enough parts
        int remaining = s.length() - start - len;
        int partsLeft = 3 - parts;
        if (remaining < partsLeft || remaining > partsLeft * 3) continue;
        
        int prevLen = sb.length();
        sb.append(segment).append('.');
        backtrack(s, start + len, parts + 1, sb, result);
        sb.setLength(prevLen);  // unchoose
    }
}
```

```
Time:  O(1) -- the string is at most 12 digits (4 parts × 3 digits).
       The total number of valid IP addresses from a 12-digit string is bounded.
Space: O(1) -- fixed maximum depth of 4
The pruning on remaining digits is powerful. If we have consumed 3 digits for the first
  part and have 1 digit left but need 3 more parts, we can stop immediately.
Real-world: parsing network addresses, log file field extraction.
```

---

**P18.42** [M] -- Letter Combinations of a Phone Number (LeetCode 17)

Given a string of digits 2-9, return all possible letter combinations.

```
Pattern: Multi-way branching backtracking. Each digit maps to 3-4 letters.
```

```java
private static final String[] MAPPING = {
    "", "", "abc", "def", "ghi", "jkl", "mno", "pqrs", "tuv", "wxyz"
};

public List<String> letterCombinations(String digits) {
    List<String> result = new ArrayList<>();
    if (digits.isEmpty()) return result;
    
    backtrack(digits, 0, new StringBuilder(), result);
    return result;
}

private void backtrack(String digits, int idx, StringBuilder sb, List<String> result) {
    if (idx == digits.length()) {
        result.add(sb.toString());
        return;
    }
    
    String letters = MAPPING[digits.charAt(idx) - '0'];
    for (int i = 0; i < letters.length(); i++) {
        sb.append(letters.charAt(i));
        backtrack(digits, idx + 1, sb, result);
        sb.deleteCharAt(sb.length() - 1);
    }
}
```

```
Time:  O(4^N × N) where N is number of digits (4 because digits 7 and 9 map to 4 letters)
Space: O(N) recursion depth
For N = 4 digits: at most 4^4 = 256 combinations. Even for N = 10 (a phone number),
  4^10 = ~1 million -- easily feasible.
JVM note: StringBuilder.deleteCharAt(length-1) is O(1) -- it just decrements the count
  field. No array shifting needed when deleting the last character.
```

---

**P18.43** [M] -- Generate Parentheses (LeetCode 22)

Generate all valid combinations of N pairs of parentheses.

```
Pattern: Constraint-guided backtracking. At each position, can add '(' if open < n,
can add ')' if close < open.
```

```java
public List<String> generateParenthesis(int n) {
    List<String> result = new ArrayList<>();
    backtrack(n, 0, 0, new StringBuilder(), result);
    return result;
}

private void backtrack(int n, int open, int close, StringBuilder sb, 
                       List<String> result) {
    if (sb.length() == 2 * n) {
        result.add(sb.toString());
        return;
    }
    
    if (open < n) {
        sb.append('(');
        backtrack(n, open + 1, close, sb, result);
        sb.deleteCharAt(sb.length() - 1);
    }
    
    if (close < open) {
        sb.append(')');
        backtrack(n, open, close + 1, sb, result);
        sb.deleteCharAt(sb.length() - 1);
    }
}
```

```
Time:  O(4^N / sqrt(N)) -- the Nth Catalan number C(N) = C(2N,N)/(N+1) ≈ 4^N / (N^1.5 × sqrt(pi))
Space: O(N) recursion depth
The Catalan number grows exponentially but slower than 2^(2N) because we never generate
  invalid sequences. The constraint close < open is the key pruning rule.
Real-world: generating valid expression trees, matching bracket patterns in code analysis.
```

---

## PART C: DIVIDE AND CONQUER

### 18.12 The Divide and Conquer Paradigm

Divide and conquer is the most structurally clean paradigm: split the problem into independent subproblems, solve each recursively, and merge the results. Unlike backtracking (which explores one path at a time) and greedy (which makes one choice and moves on), divide and conquer processes ALL subproblems and combines them.

```
Paradigm comparison:

Greedy:    make one choice → solve one subproblem → done
Backtrack: try all choices → one at a time → undo and retry
D&C:       split into parts → solve ALL parts → merge results

D&C structure:
  1. DIVIDE: split input into subproblems (typically 2 halves)
  2. CONQUER: recursively solve each subproblem
  3. COMBINE: merge subproblem solutions into the overall solution
```

#### 18.12.1 The Master Theorem

For recurrences of the form T(n) = aT(n/b) + f(n):

```
Given T(n) = aT(n/b) + O(n^d):

Case 1: d < log_b(a)  →  T(n) = O(n^(log_b(a)))
    Subproblems dominate. Example: Strassen's matrix multiply (T(n) = 7T(n/2) + O(n^2))
    
Case 2: d = log_b(a)  →  T(n) = O(n^d × log n)
    Work balanced. Example: merge sort (T(n) = 2T(n/2) + O(n), d=1, log_2(2)=1)
    
Case 3: d > log_b(a)  →  T(n) = O(n^d)
    Combine step dominates. Example: median of medians select (T(n) = T(n/5) + T(7n/10) + O(n))
    
Common recurrences:
  Merge sort:  T(n) = 2T(n/2) + O(n)  → O(n log n)
  Binary search: T(n) = T(n/2) + O(1) → O(log n)
  Quickselect: T(n) = T(n/2) + O(n)   → O(n) average
```

#### 18.12.2 Merge Sort: The Canonical D&C Algorithm

Merge sort is the purest divide and conquer algorithm. The divide step is trivial (split in half), the conquer step is recursive, and the combine step (merging two sorted arrays) is where all the work happens.

```
Merge sort properties:
  Time:   O(n log n) worst case -- guaranteed, unlike quicksort
  Space:  O(n) auxiliary for the merge buffer
  Stable: yes -- equal elements maintain their relative order
  Cache:  sequential access pattern during merge -- good cache behavior
  
JVM sort choices:
  Arrays.sort(int[]):      dual-pivot quicksort (unstable, O(n log n) average, O(n^2) worst)
  Arrays.sort(Object[]):   TimSort (stable, O(n log n) worst, O(n) extra space)
  Collections.sort(List):  delegates to Arrays.sort(Object[]) -- also TimSort
  
TimSort is a hybrid merge-sort/insertion-sort that exploits existing order in the data.
  It identifies "runs" (pre-sorted subsequences) and merges them. For nearly-sorted data,
  it approaches O(n). For random data, it is standard O(n log n).
```

#### 18.12.3 Quickselect: Finding the Kth Element in O(N) Average

Quickselect applies the partition step of quicksort but only recurses into ONE half -- the half containing the kth element. This reduces the recurrence from T(n) = 2T(n/2) + O(n) to T(n) = T(n/2) + O(n), yielding O(n) average.

```
Quickselect vs full sort:
  Full sort: T(n) = 2T(n/2) + O(n) = O(n log n)  (recurse into both halves)
  Quickselect: T(n) = T(n/2) + O(n) = O(n)        (recurse into one half)
  
The sum n + n/2 + n/4 + ... = 2n = O(n). Only processing one half makes
  the geometric series converge instead of multiplying by log n levels.
```

#### 18.12.4 Real-World Divide and Conquer

```
MapReduce: the Map phase DIVIDES data across nodes, each node CONQUERS its partition,
  the Reduce phase COMBINES results. Google's original MapReduce paper is D&C at scale.

GPU computation: CUDA kernels divide work into thread blocks, each block processes
  a portion, results are reduced across blocks.

Database parallel query: a query on a partitioned table divides across partitions,
  each partition is queried independently, results are unioned.

Fork/Join Framework (java.util.concurrent): Java's ForkJoinPool is explicitly designed
  for D&C algorithms. RecursiveTask and RecursiveAction split work and merge results.
  
  ForkJoinPool pool = new ForkJoinPool();
  long result = pool.invoke(new MergeSortTask(array, 0, array.length));
  // ForkJoinPool uses work-stealing: idle threads steal tasks from busy threads' queues.
```

---

## Problems -- Part C: Divide and Conquer

---

**P18.44** [M] -- Sort an Array (LeetCode 912)

Sort an array using merge sort.

```
Pattern: Canonical merge sort. Divide in half, sort each half, merge.
```

```java
public int[] sortArray(int[] nums) {
    if (nums.length <= 1) return nums;
    mergeSort(nums, 0, nums.length - 1, new int[nums.length]);
    return nums;
}

private void mergeSort(int[] nums, int lo, int hi, int[] temp) {
    if (lo >= hi) return;
    
    int mid = lo + (hi - lo) / 2;  // avoid overflow vs (lo+hi)/2
    mergeSort(nums, lo, mid, temp);
    mergeSort(nums, mid + 1, hi, temp);
    merge(nums, lo, mid, hi, temp);
}

private void merge(int[] nums, int lo, int mid, int hi, int[] temp) {
    // Optimization: if already sorted, skip merge
    if (nums[mid] <= nums[mid + 1]) return;
    
    System.arraycopy(nums, lo, temp, lo, hi - lo + 1);
    
    int i = lo, j = mid + 1, k = lo;
    while (i <= mid && j <= hi) {
        if (temp[i] <= temp[j]) {  // <= for stability
            nums[k++] = temp[i++];
        } else {
            nums[k++] = temp[j++];
        }
    }
    // Copy remaining from left half (right half is already in place)
    while (i <= mid) {
        nums[k++] = temp[i++];
    }
}
```

```
Time:  O(N log N) guaranteed
Space: O(N) for the temp array (allocated once and reused across all merge calls)
JVM note: allocating temp once in sortArray and passing it down avoids creating
  O(N log N) temporary arrays across recursion levels. This is a common optimization
  missed by those who allocate new int[] in each merge call.
The System.arraycopy is a JVM intrinsic -- it compiles to highly optimized machine code
  (often a single rep movsb/movsd instruction on x86), faster than a manual loop.
```

---

**P18.45** [M] -- Kth Largest Element in an Array (LeetCode 215)

Find the kth largest element.

```
Pattern: Quickselect. Partition, recurse into the half containing kth position.
```

```java
public int findKthLargest(int[] nums, int k) {
    // kth largest = (n-k)th smallest in 0-indexed
    int target = nums.length - k;
    return quickselect(nums, 0, nums.length - 1, target);
}

private int quickselect(int[] nums, int lo, int hi, int target) {
    if (lo == hi) return nums[lo];
    
    // Randomized pivot to avoid O(N^2) worst case
    int pivotIdx = lo + (int) (Math.random() * (hi - lo + 1));
    swap(nums, pivotIdx, hi);
    
    int pivot = nums[hi];
    int storeIdx = lo;
    
    for (int i = lo; i < hi; i++) {
        if (nums[i] < pivot) {
            swap(nums, storeIdx, i);
            storeIdx++;
        }
    }
    swap(nums, storeIdx, hi);
    
    if (storeIdx == target) return nums[storeIdx];
    else if (storeIdx < target) return quickselect(nums, storeIdx + 1, hi, target);
    else return quickselect(nums, lo, storeIdx - 1, target);
}

private void swap(int[] nums, int i, int j) {
    int temp = nums[i];
    nums[i] = nums[j];
    nums[j] = temp;
}
```

```
Time:  O(N) average, O(N^2) worst case (mitigated by random pivot)
Space: O(log N) average for recursion (can be made O(1) with iterative version)
The randomized pivot ensures O(N) expected time regardless of input distribution.
  Without randomization, sorted/reverse-sorted input triggers O(N^2).
Alternative: median-of-medians guarantees O(N) worst case but has a large constant
  factor (roughly 5x slower in practice). Randomized quickselect is preferred.
JVM note: Math.random() is synchronized in older JDKs. For concurrent use, prefer
  ThreadLocalRandom.current().nextInt(hi - lo + 1).
Real-world: finding percentiles in monitoring data, top-K elements in real-time streams.
```

---

**P18.46** [H] -- Closest Pair of Points

Given N points in 2D, find the pair with minimum Euclidean distance.

```
Pattern: Classic divide and conquer. Split by x-coordinate, solve each half,
then check cross-strip pairs.
```

```java
public double closestPair(int[][] points) {
    int[][] sortedByX = points.clone();
    Arrays.sort(sortedByX, (a, b) -> Integer.compare(a[0], b[0]));
    return closestRec(sortedByX, 0, sortedByX.length - 1);
}

private double closestRec(int[][] pts, int lo, int hi) {
    if (hi - lo < 3) {
        return bruteForce(pts, lo, hi);
    }
    
    int mid = lo + (hi - lo) / 2;
    int midX = pts[mid][0];
    
    double dLeft = closestRec(pts, lo, mid);
    double dRight = closestRec(pts, mid + 1, hi);
    double d = Math.min(dLeft, dRight);
    
    // Build strip: points within distance d of the dividing line
    List<int[]> strip = new ArrayList<>();
    for (int i = lo; i <= hi; i++) {
        if (Math.abs(pts[i][0] - midX) < d) {
            strip.add(pts[i]);
        }
    }
    
    // Sort strip by y-coordinate
    strip.sort((a, b) -> Integer.compare(a[1], b[1]));
    
    // Check strip pairs -- at most 6 comparisons per point (geometric argument)
    for (int i = 0; i < strip.size(); i++) {
        for (int j = i + 1; j < strip.size(); j++) {
            double dy = strip.get(j)[1] - strip.get(i)[1];
            if (dy >= d) break;
            d = Math.min(d, dist(strip.get(i), strip.get(j)));
        }
    }
    
    return d;
}

private double bruteForce(int[][] pts, int lo, int hi) {
    double minDist = Double.MAX_VALUE;
    for (int i = lo; i <= hi; i++) {
        for (int j = i + 1; j <= hi; j++) {
            minDist = Math.min(minDist, dist(pts[i], pts[j]));
        }
    }
    return minDist;
}

private double dist(int[] p1, int[] p2) {
    double dx = p1[0] - p2[0];
    double dy = p1[1] - p2[1];
    return Math.sqrt(dx * dx + dy * dy);
}
```

```
Time:  O(N log^2 N) with the strip sort. Can be optimized to O(N log N) by
       maintaining a globally y-sorted list and filtering during merge.
Space: O(N) for the strip list
The key insight: the strip has width 2d, and in any d × d square within the strip,
  at most 4 points fit (otherwise two would be closer than d, contradicting our
  recursive result). So each point has at most 7 neighbors to check.
Real-world: computational geometry in GIS systems, collision detection in games.
```

---

**P18.47** [H] -- Count of Smaller Numbers After Self (LeetCode 315)

For each element, count how many elements to its right are smaller.

```
Pattern: Merge sort with count tracking. During merge, count inversions.
```

```java
public List<Integer> countSmaller(int[] nums) {
    int n = nums.length;
    int[] counts = new int[n];
    int[] indices = new int[n];  // track original positions through sorting
    for (int i = 0; i < n; i++) indices[i] = i;
    
    mergeSort(nums, indices, counts, 0, n - 1, new int[n], new int[n]);
    
    List<Integer> result = new ArrayList<>();
    for (int c : counts) result.add(c);
    return result;
}

private void mergeSort(int[] nums, int[] indices, int[] counts, 
                       int lo, int hi, int[] tempNums, int[] tempIdx) {
    if (lo >= hi) return;
    
    int mid = lo + (hi - lo) / 2;
    mergeSort(nums, indices, counts, lo, mid, tempNums, tempIdx);
    mergeSort(nums, indices, counts, mid + 1, hi, tempNums, tempIdx);
    merge(nums, indices, counts, lo, mid, hi, tempNums, tempIdx);
}

private void merge(int[] nums, int[] indices, int[] counts, 
                   int lo, int mid, int hi, int[] tempNums, int[] tempIdx) {
    for (int i = lo; i <= hi; i++) {
        tempNums[i] = nums[i];
        tempIdx[i] = indices[i];
    }
    
    int i = lo, j = mid + 1, k = lo;
    
    while (i <= mid && j <= hi) {
        if (tempNums[i] <= tempNums[j]) {
            // Element from left half: all elements from right half that were
            // already placed (j - mid - 1) are smaller and were to its right
            counts[tempIdx[i]] += (j - mid - 1);
            nums[k] = tempNums[i];
            indices[k] = tempIdx[i];
            i++;
        } else {
            nums[k] = tempNums[j];
            indices[k] = tempIdx[j];
            j++;
        }
        k++;
    }
    
    while (i <= mid) {
        counts[tempIdx[i]] += (j - mid - 1);
        nums[k] = tempNums[i];
        indices[k] = tempIdx[i];
        i++;
        k++;
    }
    
    while (j <= hi) {
        nums[k] = tempNums[j];
        indices[k] = tempIdx[j];
        j++;
        k++;
    }
}
```

```
Time:  O(N log N) -- merge sort with constant extra work per merge step
Space: O(N) for temp arrays and index tracking
The insight: during merge, when we place an element from the LEFT half, every element
  from the RIGHT half that has already been placed is smaller (and was originally to the
  right). So the count for that left element increases by (j - (mid+1)).
Real-world: counting inversions in ranked data (e.g., how many items are out of order
  in a recommendation ranking vs ground truth).
```

---

**P18.48** [H] -- Reverse Pairs (LeetCode 493)

Count the number of important reverse pairs: i < j and nums[i] > 2 * nums[j].

```
Pattern: Merge sort with pre-merge counting. Count pairs before merging,
then merge normally.
```

```java
public int reversePairs(int[] nums) {
    return mergeSort(nums, 0, nums.length - 1, new int[nums.length]);
}

private int mergeSort(int[] nums, int lo, int hi, int[] temp) {
    if (lo >= hi) return 0;
    
    int mid = lo + (hi - lo) / 2;
    int count = mergeSort(nums, lo, mid, temp) + mergeSort(nums, mid + 1, hi, temp);
    
    // Count cross-half reverse pairs BEFORE merging
    int j = mid + 1;
    for (int i = lo; i <= mid; i++) {
        while (j <= hi && (long) nums[i] > 2L * nums[j]) j++;
        count += (j - mid - 1);
    }
    
    // Standard merge
    System.arraycopy(nums, lo, temp, lo, hi - lo + 1);
    int p1 = lo, p2 = mid + 1, k = lo;
    while (p1 <= mid && p2 <= hi) {
        if (temp[p1] <= temp[p2]) nums[k++] = temp[p1++];
        else nums[k++] = temp[p2++];
    }
    while (p1 <= mid) nums[k++] = temp[p1++];
    
    return count;
}
```

```
Time:  O(N log N) -- the counting loop and merge loop are both O(N) per level
Space: O(N)
Critical: cast to long in the comparison (long)nums[i] > 2L * nums[j].
  If nums[i] = Integer.MAX_VALUE and nums[j] = -1, then 2*nums[j] = -2 (int),
  but we need the comparison to be correct. Using 2L ensures long multiplication
  which avoids overflow.
```

---

**P18.49** [M] -- Different Ways to Add Parentheses (LeetCode 241)

Given a string of numbers and operators, compute all possible results from different groupings.

```
Pattern: D&C on expression. Split at each operator, recursively evaluate left and right,
combine all pairs of results.
```

```java
public List<Integer> diffWaysToCompute(String expression) {
    List<Integer> result = new ArrayList<>();
    
    for (int i = 0; i < expression.length(); i++) {
        char c = expression.charAt(i);
        if (c == '+' || c == '-' || c == '*') {
            // Split at this operator
            List<Integer> left = diffWaysToCompute(expression.substring(0, i));
            List<Integer> right = diffWaysToCompute(expression.substring(i + 1));
            
            // Combine all pairs
            for (int l : left) {
                for (int r : right) {
                    if (c == '+') result.add(l + r);
                    else if (c == '-') result.add(l - r);
                    else result.add(l * r);
                }
            }
        }
    }
    
    // Base case: no operator found -- this is a number
    if (result.isEmpty()) {
        result.add(Integer.parseInt(expression));
    }
    
    return result;
}
```

```
Time:  O(C_n × N) where C_n is the nth Catalan number (number of binary trees with n nodes)
       C_n ≈ 4^n / (n^1.5 × sqrt(pi))
Space: O(C_n) for all results
Optimization: memoize with a HashMap<String, List<Integer>> to avoid recomputing
  the same subexpression. This reduces the time significantly for expressions with
  repeated subexpressions.
JVM note: expression.substring(0, i) creates a new String with its own char[] backing
  (since JDK 7u6). For many splits, this creates many short-lived String objects.
  Passing indices instead of substrings would reduce GC pressure.
Real-world: expression tree enumeration in query optimizers (different join orders).
```

---

**P18.50** [M] -- Beautiful Arrangement (LeetCode 526)

Count permutations of 1..N where perm[i] is divisible by i or i is divisible by perm[i].

```
Pattern: Backtracking with pruning (not pure D&C, but completes the 50-problem set).
Place numbers 1..N at positions 1..N, prune invalid placements.
```

```java
public int countArrangement(int n) {
    return backtrack(n, 1, new boolean[n + 1]);
}

private int backtrack(int n, int pos, boolean[] used) {
    if (pos > n) return 1;
    
    int count = 0;
    for (int num = 1; num <= n; num++) {
        if (used[num]) continue;
        if (num % pos != 0 && pos % num != 0) continue;  // prune
        
        used[num] = true;
        count += backtrack(n, pos + 1, used);
        used[num] = false;
    }
    
    return count;
}
```

```
Time:  O(N!) worst case, but pruning reduces dramatically.
       N=15: only 24679 valid arrangements out of 15! = 1.3 trillion permutations.
Space: O(N) for the recursion stack and used array.
Optimization: fill from position N down to 1. Higher positions have fewer valid numbers
  (fewer divisors), so they prune more aggressively, reducing the effective branching factor.
Alternative: bitmask DP where state is a bitmask of used numbers. This runs in O(N × 2^N)
  which for N=15 is 15 × 32768 ≈ 500K -- much faster than backtracking.
```

---

## Key Takeaways

1. **Greedy works when local optimality cascades to global optimality.** The two requirements are the greedy choice property (a locally optimal choice is part of some globally optimal solution) and optimal substructure (the remaining problem after the greedy choice is itself optimal). Use the exchange argument to prove correctness: assume a non-greedy optimal, show swapping to greedy is no worse.

2. **Interval scheduling is the gateway greedy pattern.** Sort by end time to maximize non-overlapping selections, sort by start time to merge overlapping intervals. The comparator choice matters deeply: Integer.compare avoids overflow, while subtraction-based comparators silently produce wrong answers on extreme values. Know both the selection and merging variants.

3. **Huffman and two-heap patterns extend greedy to priority-based selection.** Huffman always merges the two smallest. The two-heap pattern (sort by unlock condition, max-heap for selection) appears in IPO, minimum refueling stops, and similar "unlock then pick the best" problems. Java's PriorityQueue autoboxes, so for performance-critical paths, consider alternative data structures.

4. **Greedy fails when it fails silently.** A greedy solution that produces incorrect results does not throw an exception -- it confidently returns the wrong answer. Always ask: "Can I construct an input where the greedy choice provably misses the optimum?" If yes, switch to DP or exhaustive search. Coin change with non-standard denominations is the canonical counterexample.

5. **Backtracking is systematic exhaustive search with pruning.** The choose-explore-unchoose template is universal across subsets, permutations, grid search, and string partitioning. The unchoose step must perfectly restore state, or downstream branches produce corrupt results. Reuse a single mutable list (add/remove) rather than copying at every recursion level.

6. **Duplicate handling in backtracking requires sorting plus conditional skipping.** For subsets and combinations: `if (i > start && nums[i] == nums[i-1]) continue`. For permutations: `if (i > 0 && nums[i] == nums[i-1] && !used[i-1]) continue`. These conditions ensure each group of identical elements is used in exactly one order, eliminating duplicate results without a HashSet.

7. **Pruning transforms exponential algorithms into practical ones.** N-Queens with column/diagonal/anti-diagonal tracking reduces per-placement checks from O(N) to O(1). Sudoku with constraint arrays eliminates impossible digits immediately. Combination sum with sorted input enables early termination when the candidate exceeds the remaining target. Effective pruning often reduces 2^N branches to a manageable fraction.

8. **Divide and conquer splits, solves independently, and merges.** The Master Theorem T(n) = aT(n/b) + O(n^d) determines complexity: d < log_b(a) is subproblem-dominated, d = log_b(a) gives n^d log n, d > log_b(a) is merge-dominated. Merge sort is O(n log n) guaranteed with O(n) space. Quickselect is O(n) average for kth element by recursing into only one half.

9. **Merge sort is the backbone of counting problems.** Count of smaller numbers after self, reverse pairs, and inversion count all augment merge sort's merge step to count cross-half relationships in O(n) per level. The total is O(n log n), dramatically better than the O(n^2) brute force. Track original indices through an auxiliary array to map counts back to positions.

10. **These three paradigms map directly to production systems.** Greedy: Kafka partition assignment, Huffman compression in gzip/JPEG, CPU task scheduling. Backtracking: Sudoku solvers, constraint-satisfaction in database migration planners, SAT solvers underlying SMT tools. Divide and conquer: MapReduce, Java's ForkJoinPool, parallel database queries, TimSort. Recognizing which paradigm fits is the first and most impactful decision in algorithm design.

---

[Previous: Chapter 17 -- Bit Manipulation and Math Patterns](17-bit-manipulation-and-math-patterns.md) | [Next: Chapter 19 -- Dynamic Programming Patterns](19-dynamic-programming-patterns.md)
