# Chapter 19: Patterns -- Advanced Techniques

## The Toolkit That Separates Senior from Staff

Every chapter before this one focused on a single data structure or a single family of algorithms. This chapter is different. Here, we collect the techniques that do not belong to any one structure but show up everywhere, the meta-patterns that experienced developers recognize instantly but struggle to articulate. Monotonic stacks. Monotonic deques. Binary search on answer. Bit manipulation. Mathematical patterns. Line sweep. Design problems.

These are the techniques I reach for after the obvious approach fails. When a brute-force O(n^2) "next greater element" scan stares at me and I know there must be an O(n) path, the monotonic stack appears. When a sliding window needs not just a sum but a running maximum, the monotonic deque steps in. When the answer itself is monotonic -- "if 5 servers can handle the load, so can 6" -- I stop searching the data and binary-search the answer space. When I need to find two unique numbers in an array where everything else appears twice, XOR does in O(n) what HashSets do with 10x the memory.

These are not exotic tricks. They are the standard vocabulary of high-performance systems programming. The JVM's own garbage collectors use bit manipulation for mark bitmaps. The kernel's TCP stack uses monotonic deques for receive-window management. Your monitoring system's alert thresholds use binary search on answer for capacity planning. Unix permissions are bit flags. Java's own `EnumSet` is a single long bitmask.

After this chapter, you will have 50 more problems under your belt, and more importantly, you will have seven distinct "lenses" through which to view unfamiliar problems. Each lens transforms an intractable brute-force approach into an elegant linear or log-linear solution.

---

## 19.1 Monotonic Stack

### The Concept

A monotonic stack is a stack that maintains its elements in sorted order -- either strictly increasing from bottom to top, or strictly decreasing. It is not a new data structure. It is a regular `ArrayDeque` used as a stack with a disciplined insertion protocol: before pushing a new element, pop everything that violates the monotonic invariant.

The magic is what happens during those pops. Each pop represents a resolved relationship -- "I just found the next greater element for this guy" or "this histogram bar's right boundary has been determined." The pop is not wasted work; it is the answer.

```
Monotonic Increasing Stack (bottom to top, smallest at bottom):

State after processing [3, 1, 4, 1, 5, 9]:

Push 3:  [3]
Push 1:  [1]          (3 popped? No — 1 < 3, so push. Wait, INCREASING means
                       we pop when new element is SMALLER. Let me clarify.)

Actually, there are two conventions and they confuse everyone.
Let me be precise:

MONOTONIC INCREASING STACK:
  - Elements increase from bottom to top
  - We pop when the new element is SMALLER than or equal to the top
  - After all pops, push the new element
  - Result: the stack always has elements in increasing order, bottom to top
  - Use case: finding PREVIOUS SMALLER element (what's below me in the stack)

MONOTONIC DECREASING STACK:
  - Elements decrease from bottom to top
  - We pop when the new element is LARGER than or equal to the top
  - After all pops, push the new element
  - Result: the stack always has elements in decreasing order, bottom to top
  - Use case: finding NEXT GREATER element (the new element is the answer for popped elements)
```

### The Template

Here is the canonical monotonic stack template. I use this exact structure for at least 80% of monotonic stack problems:

```java
// Template: find next greater element for each position
// Uses a DECREASING stack (bottom to top: largest to smallest)
public int[] nextGreaterElement(int[] nums) {
    int n = nums.length;
    int[] result = new int[n];
    Arrays.fill(result, -1);  // default: no greater element found
    
    Deque<Integer> stack = new ArrayDeque<>();  // stores INDICES, not values
    
    for (int i = 0; i < n; i++) {
        // Pop all elements that the current element is greater than
        while (!stack.isEmpty() && nums[stack.peek()] < nums[i]) {
            int idx = stack.pop();
            result[idx] = nums[i];  // nums[i] is the next greater element for nums[idx]
        }
        stack.push(i);
    }
    
    return result;
}
```

```
Trace for nums = [2, 1, 2, 4, 3]:

i=0, nums[0]=2:  stack empty, push 0.          stack: [0]
i=1, nums[1]=1:  1 < nums[0]=2, no pop. push 1.  stack: [0, 1]
i=2, nums[2]=2:  2 > nums[1]=1, pop 1 → result[1]=2.
                  2 = nums[0]=2, not strictly greater, stop.
                  push 2.                        stack: [0, 2]
i=3, nums[3]=4:  4 > nums[2]=2, pop 2 → result[2]=4.
                  4 > nums[0]=2, pop 0 → result[0]=4.
                  stack empty, push 3.            stack: [3]
i=4, nums[4]=3:  3 < nums[3]=4, no pop. push 4. stack: [3, 4]

result = [4, 2, 4, -1, -1]
         ↑  ↑  ↑   ↑   ↑
         |  |  |   no next greater
         |  |  next greater is 4
         |  next greater is 2
         next greater is 4
```

**Why this is O(n):** Each element is pushed exactly once and popped at most once. The inner while loop across all iterations of the outer for loop performs at most n pops total. This is the classic amortized analysis -- the total work is O(n), even though individual iterations might pop multiple elements.

### When to Recognize It

The signal phrases are unmistakable once you know them:

- "Next greater element" or "next smaller element"
- "Previous greater/smaller element"
- "Largest rectangle in histogram" (classic monotonic stack)
- "Stock span" (how many consecutive days was the price lower?)
- "Remove digits to make smallest number"
- Any problem where you need to look left or right for the first element that breaks a condition

### JVM Implementation Notes

```java
// ALWAYS use ArrayDeque, never Stack.
// java.util.Stack extends Vector → synchronized → 30-50% slower.
// ArrayDeque is backed by a circular array → cache-friendly, no sync overhead.

Deque<Integer> stack = new ArrayDeque<>();  // push/pop/peek on this end

// Store indices, not values. You can always get the value from nums[idx],
// but you cannot get the index from the value (duplicates!).
```

**Memory cost of storing indices:** Each `Integer` on the stack is an autoboxed object. For values -128 to 127, Java's `IntegerCache` reuses instances (no allocation). For larger indices, each autoboxed Integer costs 16 bytes (object header) + 4 bytes (int field) + 4 bytes padding = 24 bytes. For n = 100,000 elements, worst case stack holds all n, costing ~2.4 MB. This is negligible compared to the input array itself.

### Real-World Correlations

**Stock price analysis:** "What is the next day the stock price exceeds today's price?" is literally the Next Greater Element problem. Financial systems that compute these lookups over streaming data use monotonic stacks internally, processing each new price in amortized O(1).

**Histogram rendering:** When rendering variable-width bar charts, computing the largest rectangle that fits within the bars (Largest Rectangle in Histogram) directly applies monotonic stacks. This is also the core subroutine for the Maximal Rectangle in a binary matrix problem.

**CPU instruction scheduling:** Out-of-order execution pipelines maintain structures analogous to monotonic stacks when resolving data dependencies -- the next instruction that writes to a register "resolves" all pending reads, similar to how the next greater element resolves pending stack entries.

---

## 19.2 Monotonic Deque

### The Concept

A monotonic deque extends the monotonic stack idea to sliding windows. When you need the maximum (or minimum) element within a window that slides across the array, a naive approach recomputes the max for each window position in O(k) time, giving O(nk) overall. The monotonic deque achieves O(n) total.

The key insight: maintain a deque of indices whose corresponding values are in decreasing order (for max queries). The front of the deque is always the index of the current window's maximum. Two maintenance operations keep the deque correct:

1. **Remove from front** when the front index falls out of the window (index < i - k + 1).
2. **Remove from back** when the new element is greater than or equal to the back element -- those elements can never be the maximum of any future window because the new element is both larger and has a later expiration.

```
Sliding Window Maximum: nums = [1, 3, -1, -3, 5, 3, 6, 7], k = 3

Deque stores indices. Values shown for clarity.

i=0 (val=1):  deque=[] → push 0.  deque=[0(1)]
i=1 (val=3):  back val=1 < 3 → pop 0. deque=[] → push 1.  deque=[1(3)]
i=2 (val=-1): back val=3 > -1 → push 2.  deque=[1(3), 2(-1)]
              Window [0,2]: max = nums[deque.front] = nums[1] = 3  ✓

i=3 (val=-3): back val=-1 > -3 → push 3.  deque=[1(3), 2(-1), 3(-3)]
              Front=1, window=[1,3]: 1 >= 3-3+1=1, front is valid.
              max = nums[1] = 3  ✓

i=4 (val=5):  back val=-3 < 5 → pop 3. back val=-1 < 5 → pop 2. 
              back val=3 < 5 → pop 1. deque=[] → push 4.  deque=[4(5)]
              max = nums[4] = 5  ✓

i=5 (val=3):  back val=5 > 3 → push 5.  deque=[4(5), 5(3)]
              max = nums[4] = 5  ✓

i=6 (val=6):  back val=3 < 6 → pop 5. back val=5 < 6 → pop 4.
              deque=[] → push 6.  deque=[6(6)]
              max = nums[6] = 6  ✓

i=7 (val=7):  back val=6 < 7 → pop 6. deque=[] → push 7.  deque=[7(7)]
              max = nums[7] = 7  ✓

Result: [3, 3, 5, 5, 6, 7]
```

### The Template

```java
public int[] maxSlidingWindow(int[] nums, int k) {
    int n = nums.length;
    int[] result = new int[n - k + 1];
    Deque<Integer> deque = new ArrayDeque<>();  // indices, decreasing values
    
    for (int i = 0; i < n; i++) {
        // Remove from front if out of window
        while (!deque.isEmpty() && deque.peekFirst() < i - k + 1) {
            deque.pollFirst();
        }
        
        // Remove from back if current value >= back value (maintain decreasing)
        while (!deque.isEmpty() && nums[deque.peekLast()] <= nums[i]) {
            deque.pollLast();
        }
        
        deque.offerLast(i);
        
        // Record result once we have a full window
        if (i >= k - 1) {
            result[i - k + 1] = nums[deque.peekFirst()];
        }
    }
    return result;
}
```

**Why O(n):** Each index enters the deque exactly once (via `offerLast`) and leaves exactly once (via `pollFirst` or `pollLast`). Total operations across all iterations: at most 2n. This is the same amortized argument as the monotonic stack.

### The Difference from Monotonic Stack

A monotonic stack only operates on one end (the top). A monotonic deque operates on both ends -- the front for expiration (elements leaving the window) and the back for value comparison (elements that can never win). The deque is strictly more powerful: a monotonic stack is a monotonic deque where you never need to remove from the front.

### Real-World Correlations

**TCP receive window:** The TCP protocol tracks the maximum sequence number in a sliding receive window. Implementations that need to quickly report the maximum use a structure analogous to a monotonic deque.

**Sensor data monitoring:** "What is the maximum temperature reading from this sensor in the last 60 seconds?" with readings arriving at variable rates. A monotonic deque gives O(1) amortized per reading.

**Real-time gaming:** Frame rate monitoring (max/min frame time in last N frames), latency tracking in multiplayer games, damage-per-second calculations over sliding time windows.

---

## 19.3 Binary Search on Answer

### The Concept

This is perhaps the most underappreciated pattern in competitive programming and interviews. The idea: instead of searching through the data for the answer, you binary-search the answer space itself.

The precondition is monotonicity of feasibility. If the answer X is feasible (the task can be completed with capacity X), then X+1 is also feasible. Conversely, if X is not feasible, then X-1 is also not feasible. This creates a clean partition of the answer space:

```
Answer space:   [lo .......................... hi]
Feasibility:     NO  NO  NO  NO  YES  YES  YES  YES
                                  ↑
                          We want this boundary
```

The template is simple:

```java
// Template: find minimum feasible answer
public int binarySearchOnAnswer(int[] nums, int target) {
    int lo = minPossibleAnswer;    // e.g., 1, or min(nums)
    int hi = maxPossibleAnswer;    // e.g., sum(nums), or max(nums)
    
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;  // avoid overflow
        if (isFeasible(nums, mid, target)) {
            hi = mid;       // mid works, but maybe something smaller also works
        } else {
            lo = mid + 1;   // mid doesn't work, need larger
        }
    }
    return lo;  // lo == hi == minimum feasible answer
}

private boolean isFeasible(int[] nums, int capacity, int target) {
    // Problem-specific: can we achieve the target with this capacity?
    // Usually a greedy simulation
}
```

### Why This Works

The binary search runs O(log(hi - lo)) iterations. Each iteration calls `isFeasible()`, which typically runs in O(n). Total: O(n log(answer_range)). For many problems, the answer range is bounded by something like 10^9, so log(answer_range) is about 30. That makes the total O(30n) = O(n) for practical purposes.

Compare this to the brute-force approach of trying every possible answer from lo to hi: O(n * (hi - lo)). When hi - lo is 10^9, that is catastrophically slow. Binary search reduces it to 30 iterations.

### When to Recognize It

The killer phrases:

- "Minimize the maximum..." (split array so the maximum sum among subarrays is minimized)
- "Maximize the minimum..." (place objects so the minimum distance is maximized)
- "Minimum time/capacity/speed such that..." (can we do it in time T? Binary search T.)
- "Find the smallest X such that condition holds"

The thought process: "If I knew the answer was X, could I verify it in O(n)? And is the feasibility monotonic?" If both answers are yes, binary-search the answer.

### Real-World Correlations

**Capacity planning:** "What is the minimum number of servers needed to handle peak load?" If 10 servers can handle it, 11 can too. Binary search over server count, with a simulation checking if each count is sufficient.

**Monitoring thresholds:** "What is the minimum alert threshold such that we get fewer than K false alarms per day?" If threshold T gives few enough alarms, T+1 gives even fewer. Binary search.

**Build system parallelism:** "What is the minimum number of parallel workers to complete the build in under T seconds?" Monotonic: more workers can only help (or be neutral).

**Network bandwidth allocation:** "What is the minimum bandwidth per connection such that all N streams finish within the deadline?" Classic binary search on answer.

---

## 19.4 Bit Manipulation

### The Core Operations

Bit manipulation operates on the binary representation of integers. On the JVM, `int` is 32 bits (signed, two's complement) and `long` is 64 bits. Here are the six operators:

```java
// AND: both bits must be 1
  0b1010
& 0b1100
--------
  0b1000   // only the bit at position 3 survives

// OR: either bit can be 1
  0b1010
| 0b1100
--------
  0b1110   // union of set bits

// XOR: bits must differ
  0b1010
^ 0b1100
--------
  0b0110   // bits that differ

// NOT: flip all bits (unary)
~ 0b00001010
-----------
  0b11110101   // all 32 bits flipped (showing last 8 for brevity)

// LEFT SHIFT: multiply by 2^k
  0b0010 << 1 = 0b0100   // 2 << 1 = 4
  0b0010 << 3 = 0b10000  // 2 << 3 = 16

// RIGHT SHIFT (arithmetic, preserves sign):
  0b1000 >> 1 = 0b0100   // 8 >> 1 = 4
  -8 >> 1 = -4           // sign bit preserved

// UNSIGNED RIGHT SHIFT (logical, fills with 0):
  -1 >>> 1 = Integer.MAX_VALUE  // sign bit not preserved
```

### The Essential Tricks

These are not mere curiosities. They are the building blocks that the JVM itself uses in `Integer.bitCount()`, `Integer.numberOfTrailingZeros()`, and `Long.highestOneBit()`.

```java
// 1. Isolate lowest set bit: x & (-x)
//    -x is two's complement: flip all bits and add 1
//    Example: x = 0b101100
//            -x = 0b010100
//         x & -x = 0b000100  ← lowest set bit isolated
//    Used in: Fenwick tree (Binary Indexed Tree) for index navigation

// 2. Clear lowest set bit: x & (x - 1)
//    x - 1 flips the lowest set bit and all bits below it
//    Example: x   = 0b101100
//            x-1 = 0b101011
//       x & (x-1) = 0b101000  ← lowest set bit cleared
//    Used in: Brian Kernighan's bit counting algorithm

// 3. Check power of two: x > 0 && (x & (x - 1)) == 0
//    A power of two has exactly one bit set.
//    Clearing that bit gives 0.
//    Example: 16 = 0b10000, 16-1 = 0b01111, AND = 0

// 4. Get the k-th bit: (x >> k) & 1
//    Shift bit k to position 0, mask everything else.

// 5. Set the k-th bit: x | (1 << k)

// 6. Clear the k-th bit: x & ~(1 << k)

// 7. Toggle the k-th bit: x ^ (1 << k)

// 8. Count set bits (Brian Kernighan):
int count = 0;
while (x != 0) {
    x &= (x - 1);  // clear lowest set bit
    count++;
}
// Runs in O(number of set bits), not O(32)

// 9. JVM intrinsic: Integer.bitCount(x)
//    Compiles to a single POPCNT instruction on x86-64 with SSE4.2.
//    Faster than any manual loop. Always prefer this in production.
```

### XOR: The Cancellation Swiss Army Knife

XOR has three properties that make it uniquely powerful:

```
a ^ a = 0         (self-cancellation)
a ^ 0 = a         (identity)
a ^ b ^ a = b     (cancellation across operations)
Commutative: a ^ b = b ^ a
Associative: (a ^ b) ^ c = a ^ (b ^ c)
```

These properties mean that XOR-ing a collection of numbers cancels out pairs. If every number appears twice except one, XOR-ing all numbers yields the unique number. No extra space. No hash set. Just O(n) XOR operations and O(1) memory.

```java
// Find the single number that appears once (all others appear twice)
int single = 0;
for (int num : nums) {
    single ^= num;  // pairs cancel: 5 ^ 3 ^ 5 = (5^5) ^ 3 = 0 ^ 3 = 3
}
return single;
```

### Real-World Correlations

**Network subnet masks:** `192.168.1.0/24` means the first 24 bits are the network, last 8 bits are the host. Computing the network address is: `ip & mask`. Computing the broadcast address is: `ip | ~mask`. These are AND and OR on bit patterns.

**Unix permissions:** `chmod 755` means `rwxr-xr-x` = `0b111101101`. Checking read permission for group: `(mode >> 3) & 0b100`. This is `get-bit` at the group-read position.

**Java's EnumSet:** Internally stores a single `long` bitmask. Adding an enum value is `bits |= (1L << ordinal)`. Removing is `bits &= ~(1L << ordinal)`. Contains-check is `(bits & (1L << ordinal)) != 0`. Maximum 64 enum constants, one machine word, zero object overhead per element. It is the most cache-friendly Set implementation in the JDK.

**Bloom filters:** Each hash function sets a bit position via OR. Membership test uses AND to check if all bit positions are set. The entire structure is bit manipulation over a `long[]`.

**CPU flag registers:** The x86 FLAGS register packs condition codes (carry, zero, sign, overflow) into individual bits. The JVM's own JIT compiler checks these flags after arithmetic operations using bitwise tests.

---

## 19.5 Math Patterns

### GCD and LCM

The Euclidean algorithm computes the greatest common divisor in O(log(min(a,b))) steps:

```java
// Iterative Euclidean GCD (preferred — no stack frames)
public int gcd(int a, int b) {
    while (b != 0) {
        int temp = b;
        b = a % b;
        a = temp;
    }
    return a;
}

// LCM via GCD (avoid overflow by dividing first):
public long lcm(long a, long b) {
    return a / gcd(a, b) * b;  // divide before multiply to prevent overflow
}
```

**Why O(log(min(a,b))):** After two iterations of the Euclidean algorithm, the larger number is reduced by at least half. This is because if `b <= a/2`, then `a % b < b <= a/2`. If `b > a/2`, then `a % b = a - b < a/2`. Either way, after two steps we have halved the problem. This gives at most 2 * log2(min(a,b)) iterations.

### Prime Sieve (Sieve of Eratosthenes)

```java
// Sieve of Eratosthenes using BitSet — memory efficient
public int countPrimes(int n) {
    if (n <= 2) return 0;
    
    BitSet composite = new BitSet(n);  // false = prime, true = composite
    // Only need to sieve up to sqrt(n)
    for (int i = 2; (long) i * i < n; i++) {
        if (!composite.get(i)) {
            // Mark all multiples of i starting from i*i
            for (int j = i * i; j < n; j += i) {
                composite.set(j);
            }
        }
    }
    
    int count = 0;
    for (int i = 2; i < n; i++) {
        if (!composite.get(i)) count++;
    }
    return count;
}
```

**JVM note on BitSet:** `java.util.BitSet` stores bits in a `long[]` array. Each long holds 64 bits. For n = 10^7, the BitSet uses ~1.25 MB (10^7 / 8 bytes). Compare to a `boolean[]` of the same size: 10 MB (JVM stores each boolean as 1 byte, not 1 bit). The BitSet is 8x more memory-efficient and better for cache because more data fits in each cache line.

**Complexity:** O(n log log n). The inner loop runs n/2 + n/3 + n/5 + n/7 + ... times (summing over primes p up to sqrt(n)), which by Mertens' theorem converges to O(n log log n).

### Modular Arithmetic

When numbers grow huge (as in combinatorics), we work modulo a prime (typically 10^9 + 7):

```java
static final int MOD = 1_000_000_007;

// Modular addition: (a + b) % MOD
long add(long a, long b) {
    return (a + b) % MOD;
}

// Modular multiplication: (a * b) % MOD
long mul(long a, long b) {
    return (a % MOD) * (b % MOD) % MOD;
}

// Modular exponentiation: a^b % MOD in O(log b)
long power(long base, long exp, long mod) {
    long result = 1;
    base %= mod;
    while (exp > 0) {
        if ((exp & 1) == 1) {
            result = result * base % mod;
        }
        exp >>= 1;
        base = base * base % mod;
    }
    return result;
}

// Modular inverse (when MOD is prime): a^(-1) ≡ a^(MOD-2) mod MOD
// By Fermat's little theorem
long modInverse(long a, long mod) {
    return power(a, mod - 2, mod);
}
```

**Why 10^9 + 7?** It is prime (required for modular inverse), large enough that results are meaningful, and small enough that two such numbers multiplied fit in a `long` without overflow: (10^9)^2 = 10^18 < 9.2 * 10^18 = Long.MAX_VALUE.

### Combinatorics with DP

Pascal's triangle computes binomial coefficients without factorials (avoiding overflow):

```java
// nCr using Pascal's triangle DP
// C(n, r) = C(n-1, r-1) + C(n-1, r)
public long nCr(int n, int r) {
    if (r > n) return 0;
    if (r == 0 || r == n) return 1;
    
    long[] dp = new long[r + 1];
    dp[0] = 1;
    
    for (int i = 1; i <= n; i++) {
        // Traverse right to left to avoid overwriting values we still need
        for (int j = Math.min(i, r); j > 0; j--) {
            dp[j] = (dp[j] + dp[j - 1]) % MOD;
        }
    }
    return dp[r];
}
```

### Real-World Correlations

**Cryptography:** RSA encryption computes `m^e mod n` where e and n are large. This is modular exponentiation. The security rests on the difficulty of factoring n into its prime components.

**Hash function design:** Many hash functions use prime numbers for table sizes and modular arithmetic for distribution. `HashMap`'s supplemental hash function (`HashMap.hash()`) uses XOR and shifts to spread bits -- combining bit manipulation and mathematical hashing.

**Consistent hashing / load balancing:** Distributing requests across N servers uses `hash(key) % N`. When N changes, consistent hashing minimizes redistribution, but the core operation is modular arithmetic.

---

## 19.6 Line Sweep

### The Concept

Line sweep (also called sweep line or event processing) is a technique where you sort events by position or time, then process them left to right, maintaining an "active set" of currently relevant objects.

The pattern has three phases:

1. **Create events** from the input (e.g., interval start and interval end become two events).
2. **Sort events** by position/time (break ties carefully -- start before end? end before start? depends on the problem).
3. **Sweep** left to right, updating an active data structure (often a PriorityQueue or TreeMap).

```
Example: Meeting Rooms II — how many rooms do we need?

Meetings: [0,30], [5,10], [15,20]

Events (sorted by time):
  t=0:  START  [0,30]
  t=5:  START  [5,10]
  t=10: END    [5,10]
  t=15: START  [15,20]
  t=20: END    [15,20]
  t=30: END    [0,30]

Sweep:
  t=0:  active=1  (room allocated for [0,30])
  t=5:  active=2  (room allocated for [5,10]) ← peak!
  t=10: active=1  (room freed from [5,10])
  t=15: active=2  (room allocated for [15,20]) ← peak!
  t=20: active=1  (room freed from [15,20])
  t=30: active=0  (room freed from [0,30])

Answer: max active = 2 rooms
```

### The Template (Difference Array Variant)

For problems that only need the count of overlapping events at each point, a difference array is often simpler than explicit event processing:

```java
// Difference array approach for counting overlaps
// When intervals map to integer coordinates
public int minMeetingRooms(int[][] intervals) {
    TreeMap<Integer, Integer> events = new TreeMap<>();
    
    for (int[] interval : intervals) {
        events.merge(interval[0], 1, Integer::sum);   // +1 at start
        events.merge(interval[1], -1, Integer::sum);  // -1 at end
    }
    
    int maxRooms = 0, currentRooms = 0;
    for (int delta : events.values()) {
        currentRooms += delta;
        maxRooms = Math.max(maxRooms, currentRooms);
    }
    return maxRooms;
}
```

**Why TreeMap instead of sorting two arrays:** The TreeMap naturally handles coinciding events (merge with `Integer::sum`) and iterates in sorted order. For problems with large coordinate ranges but few events, TreeMap's O(n log n) is better than allocating a huge difference array.

### When to Recognize It

- "Minimum number of rooms/resources for overlapping intervals"
- "Skyline" or "building outline" problems
- "Calendar" problems (can I book this time slot?)
- "Rectangle area" with overlapping rectangles
- Any problem involving intervals where you process them by their boundaries

### Real-World Correlations

**Event processing systems:** Kafka consumers processing time-ordered events. The sweep is literally what your event handler does: process each event in order, update state.

**Calendar scheduling:** Google Calendar's "find a time" feature sweeps through all participants' busy intervals to find gaps. The line sweep finds the minimum number of "tracks" (rooms) needed to schedule all events without conflict.

**Computational geometry:** Ray casting, polygon clipping, and Voronoi diagram algorithms all use sweep line as a foundational technique. If you have ever written code that processes geometric objects left to right, you have implemented a sweep.

**Database query planning:** Range-based index scans process sorted key ranges and join intervals -- a form of sweep.

---

## 19.7 Design Problems

### The Pattern

Design problems ask you to implement a data structure from scratch. They test your ability to choose the right internal structures, define a clean interface, and handle edge cases. The "design" is not about system architecture -- it is about data structure engineering.

The approach:

1. **Clarify the interface:** What operations are supported? What are the time complexity requirements?
2. **Choose internal structures:** HashMap for O(1) lookup? LinkedList for O(1) insertion/removal? Both? A combination?
3. **Implement:** Write clean code. Handle edge cases (empty, single element, capacity limits).
4. **Analyze:** State the time and space complexity of each operation.

Design problems in this chapter serve as capstones that combine multiple techniques from earlier patterns.

---

## Problems

### Monotonic Stack Problems

---

**P19.01** [E] -- Next Greater Element I (LeetCode 496)

Given two arrays `nums1` (subset of `nums2`) and `nums2`, for each element in `nums1`, find its next greater element in `nums2`. If none exists, return -1.

```
Pattern: Monotonic decreasing stack to find next greater element, plus HashMap for lookup.
```

```java
public int[] nextGreaterElement(int[] nums1, int[] nums2) {
    Map<Integer, Integer> nextGreater = new HashMap<>();
    Deque<Integer> stack = new ArrayDeque<>();
    
    for (int num : nums2) {
        while (!stack.isEmpty() && stack.peek() < num) {
            nextGreater.put(stack.pop(), num);
        }
        stack.push(num);
    }
    
    int[] result = new int[nums1.length];
    for (int i = 0; i < nums1.length; i++) {
        result[i] = nextGreater.getOrDefault(nums1[i], -1);
    }
    return result;
}
```

```
Time:  O(n + m) where n = nums2.length, m = nums1.length
Space: O(n) for the HashMap and stack
Since all elements in nums2 are unique, we store value→nextGreater in the map.
Each element enters and leaves the stack at most once → amortized O(n).
```

---

**P19.02** [M] -- Next Greater Element II (LeetCode 503)

Given a circular array, find the next greater element for each position. The search wraps around.

```
Pattern: Monotonic stack with circular traversal — iterate 2n times using i % n.
```

```java
public int[] nextGreaterElements(int[] nums) {
    int n = nums.length;
    int[] result = new int[n];
    Arrays.fill(result, -1);
    Deque<Integer> stack = new ArrayDeque<>();  // stores indices
    
    // Two passes: simulate circular array by iterating 0..2n-1
    for (int i = 0; i < 2 * n; i++) {
        int num = nums[i % n];
        while (!stack.isEmpty() && nums[stack.peek()] < num) {
            result[stack.pop()] = num;
        }
        if (i < n) {
            stack.push(i);  // only push indices from first pass
        }
    }
    return result;
}
```

```
Time:  O(n) — each index pushed once, popped at most once
Space: O(n) for stack and result array
The circular trick: iterating 2n positions means every element gets a chance to be
the "next greater" for elements that wrap around. We only push indices < n to avoid
duplicates in the stack.
```

---

**P19.03** [E] -- Daily Temperatures (LeetCode 739)

Given daily temperatures, for each day, how many days until a warmer temperature? Return 0 if never.

```
Pattern: Monotonic decreasing stack. When a warmer day arrives, pop and compute distance.
```

```java
public int[] dailyTemperatures(int[] temperatures) {
    int n = temperatures.length;
    int[] result = new int[n];
    Deque<Integer> stack = new ArrayDeque<>();  // indices of days
    
    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && temperatures[stack.peek()] < temperatures[i]) {
            int prevDay = stack.pop();
            result[prevDay] = i - prevDay;
        }
        stack.push(i);
    }
    return result;
}
```

```
Time:  O(n)
Space: O(n)
This is the purest form of the monotonic stack template. The result is the
INDEX DIFFERENCE (i - prevDay), not the value. Storing indices in the stack
makes this trivial.
```

---

**P19.04** [M] -- Online Stock Span (LeetCode 901)

Design a class that collects daily stock prices and returns the span: the number of consecutive days (including today) where the price was less than or equal to today's price.

```
Pattern: Monotonic decreasing stack storing (price, span) pairs.
```

```java
class StockSpanner {
    // Stack stores [price, span] pairs, decreasing by price
    private Deque<int[]> stack;
    
    public StockSpanner() {
        stack = new ArrayDeque<>();
    }
    
    public int next(int price) {
        int span = 1;
        // Pop all days with price <= current price, absorb their spans
        while (!stack.isEmpty() && stack.peek()[0] <= price) {
            span += stack.pop()[1];
        }
        stack.push(new int[]{price, span});
        return span;
    }
}
```

```
Time:  O(1) amortized per call — each element pushed and popped at most once
Space: O(n) for n total calls
The span "absorbs" popped elements: if we pop a day with span 3, those 3 days
are now included in the current day's span. This avoids counting backwards.
```

---

**P19.05** [H] -- Largest Rectangle in Histogram (LeetCode 84)

Given an array of bar heights, find the area of the largest rectangle that fits within the histogram.

```
Pattern: Monotonic increasing stack. When a bar is shorter than the top, the top bar's
rectangle is bounded: left boundary is the element below it in stack, right boundary is current.
```

```java
public int largestRectangleArea(int[] heights) {
    int n = heights.length;
    int maxArea = 0;
    Deque<Integer> stack = new ArrayDeque<>();  // indices, increasing heights
    
    for (int i = 0; i <= n; i++) {
        int currentHeight = (i == n) ? 0 : heights[i];  // sentinel at end
        
        while (!stack.isEmpty() && heights[stack.peek()] > currentHeight) {
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
Time:  O(n)
Space: O(n)
The sentinel (height 0 at position n) ensures all remaining bars in the stack
get processed. Without it, you'd need a separate loop after the main iteration.
Width calculation: if stack is empty after pop, the popped bar extends all the way
to the left edge → width = i. Otherwise, width = i - stack.peek() - 1.
JVM note: the sentinel avoids a branch in the cleanup code. Clean code = fewer
branch mispredictions in tight loops, though the effect is marginal here.
```

---

**P19.06** [H] -- Maximal Rectangle (LeetCode 85)

Given a binary matrix of 0s and 1s, find the area of the largest rectangle containing only 1s.

```
Pattern: Reduce to Largest Rectangle in Histogram. Build histogram heights row by row,
apply P19.05 to each row's histogram.
```

```java
public int maximalRectangle(char[][] matrix) {
    if (matrix.length == 0) return 0;
    int cols = matrix[0].length;
    int[] heights = new int[cols];
    int maxArea = 0;
    
    for (char[] row : matrix) {
        // Update histogram heights
        for (int j = 0; j < cols; j++) {
            heights[j] = (row[j] == '1') ? heights[j] + 1 : 0;
        }
        // Apply largest rectangle in histogram
        maxArea = Math.max(maxArea, largestRectangleArea(heights));
    }
    return maxArea;
}

// Reuse solution from P19.05
private int largestRectangleArea(int[] heights) {
    int n = heights.length;
    int maxArea = 0;
    Deque<Integer> stack = new ArrayDeque<>();
    
    for (int i = 0; i <= n; i++) {
        int h = (i == n) ? 0 : heights[i];
        while (!stack.isEmpty() && heights[stack.peek()] > h) {
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
Time:  O(M × N) — each row builds histogram in O(N), solves histogram in O(N)
Space: O(N) for heights array and stack
This is one of the most elegant reductions in algorithmic problem-solving:
a 2D problem reduced to M independent 1D problems, each solved in O(N).
```

---

**P19.07** [H] -- Trapping Rain Water (LeetCode 42)

Given elevation bars, compute how much rain water can be trapped between them.

```
Pattern: Monotonic stack approach — process bars left to right, use stack to find
bounded regions where water can pool.
```

```java
public int trap(int[] height) {
    int n = height.length;
    int water = 0;
    Deque<Integer> stack = new ArrayDeque<>();
    
    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && height[stack.peek()] < height[i]) {
            int bottom = stack.pop();
            if (stack.isEmpty()) break;  // no left boundary
            int left = stack.peek();
            int width = i - left - 1;
            int boundedHeight = Math.min(height[left], height[i]) - height[bottom];
            water += width * boundedHeight;
        }
        stack.push(i);
    }
    return water;
}
```

```
Time:  O(n)
Space: O(n) for stack
This computes water layer by layer (horizontal slices) rather than column by column.
When we pop index 'bottom', the water above that bottom is bounded by:
  - left wall: stack.peek() (the element below bottom in the stack)
  - right wall: current index i
  - depth: min(left wall height, right wall height) - bottom height
Alternative approaches: two-pointer (O(1) space), prefix max arrays. The monotonic
stack approach is included here because it demonstrates the stack pattern beautifully.
```

---

**P19.08** [M] -- Remove K Digits (LeetCode 402)

Given a string of digits and integer k, remove k digits to make the smallest possible number.

```
Pattern: Monotonic increasing stack of digits. Remove larger digits when a smaller digit follows.
Greedy: always remove the leftmost digit that is greater than its successor.
```

```java
public String removeKdigits(String num, int k) {
    Deque<Character> stack = new ArrayDeque<>();
    
    for (char c : num.toCharArray()) {
        while (k > 0 && !stack.isEmpty() && stack.peek() > c) {
            stack.pop();
            k--;
        }
        stack.push(c);
    }
    
    // If k > 0, remove from the end (stack is now non-decreasing, tail is largest)
    while (k > 0) {
        stack.pop();
        k--;
    }
    
    // Build result, skip leading zeros
    StringBuilder sb = new StringBuilder();
    boolean leadingZero = true;
    // Stack is LIFO; we need FIFO order. Use descendingIterator or reverse.
    // Actually, ArrayDeque iteration is from first to last (bottom to top for push/pop on same end).
    // Since we used push (addFirst), iteration goes top to bottom. We need bottom to top.
    // Simplest: dump to array and reverse, or use pollLast.
    while (!stack.isEmpty()) {
        sb.append(stack.pollLast());
    }
    
    // Remove leading zeros
    int start = 0;
    while (start < sb.length() && sb.charAt(start) == '0') start++;
    String result = sb.substring(start);
    
    return result.isEmpty() ? "0" : result;
}
```

```
Time:  O(n) where n = num.length()
Space: O(n) for the stack
The monotonic stack ensures we greedily keep the smallest possible prefix.
Each digit enters the stack once and leaves at most once.
Edge case: "10200" with k=1 → remove '1' → "0200" → "200". Leading zero handling is essential.
Edge case: "1111" with k=2 → nothing to pop (non-decreasing) → remove from end → "11".
```

---

**P19.09** [M] -- Sum of Subarray Minimums (LeetCode 907)

Given an array, find the sum of min(subarray) for all subarrays. Return modulo 10^9+7.

```
Pattern: For each element, determine how many subarrays it is the minimum of.
Use monotonic stack to find previous-less and next-less elements.
```

```java
public int sumSubarrayMins(int[] arr) {
    int n = arr.length;
    int MOD = 1_000_000_007;
    
    // left[i] = number of subarrays ending at i where arr[i] is the min
    //         = distance to previous smaller element (or left boundary)
    // right[i] = number of subarrays starting at i where arr[i] is the min
    //          = distance to next strictly smaller element (or right boundary)
    int[] left = new int[n];
    int[] right = new int[n];
    
    Deque<Integer> stack = new ArrayDeque<>();
    
    // Find previous less or equal (use <= to handle duplicates: left uses <=, right uses <)
    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && arr[stack.peek()] >= arr[i]) {
            stack.pop();
        }
        left[i] = stack.isEmpty() ? i + 1 : i - stack.peek();
        stack.push(i);
    }
    
    stack.clear();
    
    // Find next strictly less
    for (int i = n - 1; i >= 0; i--) {
        while (!stack.isEmpty() && arr[stack.peek()] > arr[i]) {
            stack.pop();
        }
        right[i] = stack.isEmpty() ? n - i : stack.peek() - i;
        stack.push(i);
    }
    
    // Contribution of arr[i] = arr[i] * left[i] * right[i]
    long sum = 0;
    for (int i = 0; i < n; i++) {
        sum = (sum + (long) arr[i] * left[i] % MOD * right[i]) % MOD;
    }
    return (int) sum;
}
```

```
Time:  O(n) — two monotonic stack passes + one contribution pass
Space: O(n)
The key subtlety: handling duplicates. We use >= for left boundary and > for right
boundary (or vice versa). This ensures each subarray's minimum is counted exactly once.
Without this asymmetry, subarrays with duplicate minimums would be double-counted.
Contribution formula: arr[i] appears as the minimum in left[i] * right[i] subarrays.
```

---

**P19.10** [H] -- Sum of Subarray Ranges (LeetCode 2104)

The range of a subarray is max - min. Find the sum of ranges over all subarrays.

```
Pattern: sum(ranges) = sum(max of each subarray) - sum(min of each subarray).
Apply the technique from P19.09 twice: once for minimums, once for maximums.
```

```java
public long subArrayRanges(int[] nums) {
    int n = nums.length;
    return sumOfSubarrayMaxs(nums, n) - sumOfSubarrayMins(nums, n);
}

private long sumOfSubarrayMins(int[] arr, int n) {
    int[] left = new int[n], right = new int[n];
    Deque<Integer> stack = new ArrayDeque<>();
    
    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && arr[stack.peek()] >= arr[i]) stack.pop();
        left[i] = stack.isEmpty() ? i + 1 : i - stack.peek();
        stack.push(i);
    }
    stack.clear();
    for (int i = n - 1; i >= 0; i--) {
        while (!stack.isEmpty() && arr[stack.peek()] > arr[i]) stack.pop();
        right[i] = stack.isEmpty() ? n - i : stack.peek() - i;
        stack.push(i);
    }
    
    long sum = 0;
    for (int i = 0; i < n; i++) sum += (long) arr[i] * left[i] * right[i];
    return sum;
}

private long sumOfSubarrayMaxs(int[] arr, int n) {
    int[] left = new int[n], right = new int[n];
    Deque<Integer> stack = new ArrayDeque<>();
    
    // Previous greater or equal
    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && arr[stack.peek()] <= arr[i]) stack.pop();
        left[i] = stack.isEmpty() ? i + 1 : i - stack.peek();
        stack.push(i);
    }
    stack.clear();
    // Next strictly greater
    for (int i = n - 1; i >= 0; i--) {
        while (!stack.isEmpty() && arr[stack.peek()] < arr[i]) stack.pop();
        right[i] = stack.isEmpty() ? n - i : stack.peek() - i;
        stack.push(i);
    }
    
    long sum = 0;
    for (int i = 0; i < n; i++) sum += (long) arr[i] * left[i] * right[i];
    return sum;
}
```

```
Time:  O(n) — four monotonic stack passes
Space: O(n)
This problem beautifully demonstrates the power of decomposition. Instead of
computing range = max - min for each of O(n²) subarrays, we compute the total
contribution of each element as a maximum and as a minimum independently.
The modular arithmetic is not needed here (result fits in long for typical constraints).
```

---

### Monotonic Deque Problems

---

**P19.11** [H] -- Sliding Window Maximum (LeetCode 239)

Given an array and window size k, return the maximum in each window position.

```
Pattern: Monotonic decreasing deque of indices. Classic application.
```

```java
public int[] maxSlidingWindow(int[] nums, int k) {
    int n = nums.length;
    int[] result = new int[n - k + 1];
    Deque<Integer> deque = new ArrayDeque<>();
    
    for (int i = 0; i < n; i++) {
        // Remove indices outside window
        while (!deque.isEmpty() && deque.peekFirst() < i - k + 1) {
            deque.pollFirst();
        }
        // Remove smaller elements from back (they can never be the max)
        while (!deque.isEmpty() && nums[deque.peekLast()] <= nums[i]) {
            deque.pollLast();
        }
        deque.offerLast(i);
        
        if (i >= k - 1) {
            result[i - k + 1] = nums[deque.peekFirst()];
        }
    }
    return result;
}
```

```
Time:  O(n) — each element enters and leaves deque at most once
Space: O(k) for the deque
JVM note: ArrayDeque's circular buffer means both offerLast and pollFirst are O(1)
with no memory allocation (unless resize needed). For k up to 10^5, the deque
fits comfortably in L1 cache when storing int indices.
```

---

**P19.12** [H] -- Shortest Subarray with Sum at Least K (LeetCode 862)

Given an integer array (may contain negatives), find the shortest subarray with sum >= k.

```
Pattern: Prefix sums + monotonic deque. The deque maintains increasing prefix sums.
Key insight: negative numbers make the sliding window approach fail (shrinking the
window might increase the sum). Prefix sums + deque handles this.
```

```java
public int shortestSubarray(int[] nums, int k) {
    int n = nums.length;
    long[] prefix = new long[n + 1];
    for (int i = 0; i < n; i++) {
        prefix[i + 1] = prefix[i] + nums[i];
    }
    
    int minLen = n + 1;
    Deque<Integer> deque = new ArrayDeque<>();  // indices into prefix, increasing values
    
    for (int i = 0; i <= n; i++) {
        // If prefix[i] - prefix[deque.front] >= k, we found a valid subarray
        while (!deque.isEmpty() && prefix[i] - prefix[deque.peekFirst()] >= k) {
            minLen = Math.min(minLen, i - deque.pollFirst());
        }
        // Maintain increasing order: remove from back if prefix[i] <= prefix[back]
        while (!deque.isEmpty() && prefix[deque.peekLast()] >= prefix[i]) {
            deque.pollLast();
        }
        deque.offerLast(i);
    }
    
    return minLen <= n ? minLen : -1;
}
```

```
Time:  O(n)
Space: O(n) for prefix array and deque
Why increasing deque? If prefix[j] >= prefix[i] where j > i, then j is never useful
as a left boundary: i gives a larger sum (prefix[right] - prefix[i] >= prefix[right] - prefix[j])
and a longer subarray. So j is dominated and can be removed from the back.
Why poll from front? Once prefix[i] - prefix[front] >= k, any future i' > i would give
a longer subarray with the same left boundary. So front has served its purpose.
```

---

**P19.13** [H] -- Constrained Subsequence Sum (LeetCode 1425)

Find the maximum sum of a subsequence such that no two selected elements have indices differing by more than k.

```
Pattern: DP + monotonic deque. dp[i] = max sum ending at index i.
dp[i] = nums[i] + max(0, max(dp[i-k]...dp[i-1])).
Use monotonic deque to find max of last k dp values in O(1).
```

```java
public int constrainedSubsetSum(int[] nums, int k) {
    int n = nums.length;
    int[] dp = new int[n];
    Deque<Integer> deque = new ArrayDeque<>();  // indices, dp values decreasing
    int maxSum = Integer.MIN_VALUE;
    
    for (int i = 0; i < n; i++) {
        // Remove out-of-window indices
        while (!deque.isEmpty() && deque.peekFirst() < i - k) {
            deque.pollFirst();
        }
        
        // dp[i] = nums[i] + max(0, dp[deque.front])
        dp[i] = nums[i];
        if (!deque.isEmpty()) {
            dp[i] = Math.max(dp[i], dp[deque.peekFirst()] + nums[i]);
        }
        
        // Maintain decreasing deque of dp values
        while (!deque.isEmpty() && dp[deque.peekLast()] <= dp[i]) {
            deque.pollLast();
        }
        deque.offerLast(i);
        
        maxSum = Math.max(maxSum, dp[i]);
    }
    return maxSum;
}
```

```
Time:  O(n)
Space: O(n) for dp array, O(k) for deque
Without the deque, finding max(dp[i-k]...dp[i-1]) takes O(k) per element → O(nk) total.
The deque reduces each query to O(1) amortized, giving O(n) total.
This pattern — DP + monotonic deque — appears whenever the DP transition looks back
at a window of previous states and takes the max/min.
```

---

**P19.14** [M] -- Longest Continuous Subarray with Absolute Diff <= Limit (LeetCode 1438)

Find the longest subarray where the difference between max and min elements is at most `limit`.

```
Pattern: Two monotonic deques — one for max, one for min — within a sliding window.
```

```java
public int longestSubarray(int[] nums, int limit) {
    Deque<Integer> maxDeque = new ArrayDeque<>();  // decreasing, front = max
    Deque<Integer> minDeque = new ArrayDeque<>();  // increasing, front = min
    int left = 0, maxLen = 0;
    
    for (int right = 0; right < nums.length; right++) {
        // Maintain max deque (decreasing)
        while (!maxDeque.isEmpty() && nums[maxDeque.peekLast()] <= nums[right]) {
            maxDeque.pollLast();
        }
        maxDeque.offerLast(right);
        
        // Maintain min deque (increasing)
        while (!minDeque.isEmpty() && nums[minDeque.peekLast()] >= nums[right]) {
            minDeque.pollLast();
        }
        minDeque.offerLast(right);
        
        // Shrink window if constraint violated
        while (nums[maxDeque.peekFirst()] - nums[minDeque.peekFirst()] > limit) {
            left++;
            if (maxDeque.peekFirst() < left) maxDeque.pollFirst();
            if (minDeque.peekFirst() < left) minDeque.pollFirst();
        }
        
        maxLen = Math.max(maxLen, right - left + 1);
    }
    return maxLen;
}
```

```
Time:  O(n) — each element enters/leaves each deque at most once
Space: O(n) for the two deques
Alternative: TreeMap<Integer, Integer> as a sorted multiset, giving O(n log n).
The two-deque approach is faster by a constant factor because deque operations
are simple array index manipulations, while TreeMap involves Red-Black tree rotations.
```

---

**P19.15** [M] -- Jump Game VI (LeetCode 1696)

Starting at index 0, you can jump at most k steps. Find the maximum score reaching the last index.

```
Pattern: DP where dp[i] = nums[i] + max(dp[i-k]...dp[i-1]). Same deque-optimized DP as P19.13.
```

```java
public int maxResult(int[] nums, int k) {
    int n = nums.length;
    int[] dp = new int[n];
    dp[0] = nums[0];
    Deque<Integer> deque = new ArrayDeque<>();
    deque.offerLast(0);
    
    for (int i = 1; i < n; i++) {
        // Remove out-of-window
        while (!deque.isEmpty() && deque.peekFirst() < i - k) {
            deque.pollFirst();
        }
        
        dp[i] = nums[i] + dp[deque.peekFirst()];
        
        // Maintain decreasing deque
        while (!deque.isEmpty() && dp[deque.peekLast()] <= dp[i]) {
            deque.pollLast();
        }
        deque.offerLast(i);
    }
    return dp[n - 1];
}
```

```
Time:  O(n)
Space: O(n) for dp, O(k) for deque
Compared to P19.13, this is simpler because we MUST reach index n-1 (no choice to skip it)
and we always start from index 0. The deque optimization is identical.
Note: dp[i] can be negative (if nums has large negative values), so we cannot use
max(0, ...) like in P19.13. We must always take the best previous dp value.
```

---

### Binary Search on Answer Problems

---

**P19.16** [M] -- Koko Eating Bananas (LeetCode 875)

Koko eats bananas at speed k (bananas per hour). She has h hours to eat all piles. Find the minimum k.

```
Pattern: Binary search on answer. If speed k works, speed k+1 also works (monotonic feasibility).
```

```java
public int minEatingSpeed(int[] piles, int h) {
    int lo = 1;
    int hi = 0;
    for (int pile : piles) hi = Math.max(hi, pile);  // max pile = max possible speed
    
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (canFinish(piles, mid, h)) {
            hi = mid;    // mid speed works, try slower
        } else {
            lo = mid + 1;  // mid speed too slow
        }
    }
    return lo;
}

private boolean canFinish(int[] piles, int speed, int h) {
    int hours = 0;
    for (int pile : piles) {
        hours += (pile + speed - 1) / speed;  // ceiling division without floating point
    }
    return hours <= h;
}
```

```
Time:  O(n log M) where n = piles.length, M = max pile size
Space: O(1)
The ceiling division trick: (a + b - 1) / b = ceil(a/b) for positive integers.
This avoids Math.ceil((double) pile / speed) which involves floating-point conversion
and potential precision issues. Always prefer integer arithmetic.
```

---

**P19.17** [M] -- Capacity to Ship Packages Within D Days (LeetCode 1011)

Find the minimum ship capacity to ship all packages in order within D days.

```
Pattern: Binary search on answer. lo = max(weights), hi = sum(weights).
```

```java
public int shipWithinDays(int[] weights, int days) {
    int lo = 0, hi = 0;
    for (int w : weights) {
        lo = Math.max(lo, w);  // must hold the heaviest package
        hi += w;               // could ship everything in one day
    }
    
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (canShip(weights, mid, days)) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo;
}

private boolean canShip(int[] weights, int capacity, int days) {
    int daysNeeded = 1, currentLoad = 0;
    for (int w : weights) {
        if (currentLoad + w > capacity) {
            daysNeeded++;
            currentLoad = 0;
        }
        currentLoad += w;
    }
    return daysNeeded <= days;
}
```

```
Time:  O(n log S) where S = sum(weights)
Space: O(1)
lo = max(weights) because the ship must be able to hold at least the heaviest package.
hi = sum(weights) because shipping everything in one day requires capacity = total weight.
The feasibility check is a greedy simulation: pack greedily, start a new day when capacity is exceeded.
```

---

**P19.18** [H] -- Split Array Largest Sum (LeetCode 410)

Split array into m subarrays to minimize the largest subarray sum.

```
Pattern: Binary search on the answer (the largest sum). If we can split with max sum ≤ X,
we can also split with max sum ≤ X+1. Greedy check: count how many splits are needed.
```

```java
public int splitArray(int[] nums, int m) {
    int lo = 0, hi = 0;
    for (int num : nums) {
        lo = Math.max(lo, num);
        hi += num;
    }
    
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (canSplit(nums, mid, m)) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo;
}

private boolean canSplit(int[] nums, int maxSum, int m) {
    int splits = 1, currentSum = 0;
    for (int num : nums) {
        if (currentSum + num > maxSum) {
            splits++;
            currentSum = 0;
        }
        currentSum += num;
    }
    return splits <= m;
}
```

```
Time:  O(n log S) where S = sum(nums)
Space: O(1)
This problem is IDENTICAL in structure to P19.17. Ship capacity = max subarray sum.
Days = m splits. The feasibility check is the same greedy packing.
This is a powerful insight: "minimize the maximum" problems share the same template.
Also solvable with DP in O(n² × m), but binary search is cleaner and faster.
```

---

**P19.19** [M] -- Magnetic Force Between Two Balls (LeetCode 1552)

Place m balls in n baskets (at given positions) to maximize the minimum distance between any two balls.

```
Pattern: Binary search on the minimum distance. "Maximize the minimum" → binary search.
```

```java
public int maxDistance(int[] position, int m) {
    Arrays.sort(position);
    int lo = 1;
    int hi = position[position.length - 1] - position[0];
    
    while (lo < hi) {
        int mid = lo + (hi - lo + 1) / 2;  // upper-mid to avoid infinite loop
        if (canPlace(position, mid, m)) {
            lo = mid;       // mid works, try larger distance
        } else {
            hi = mid - 1;   // mid too large
        }
    }
    return lo;
}

private boolean canPlace(int[] pos, int minDist, int m) {
    int count = 1, lastPos = pos[0];
    for (int i = 1; i < pos.length; i++) {
        if (pos[i] - lastPos >= minDist) {
            count++;
            lastPos = pos[i];
            if (count >= m) return true;
        }
    }
    return false;
}
```

```
Time:  O(n log n + n log D) where D = max position range
Space: O(1) (sort is in-place for primitives on most JVM implementations)
CRITICAL: "Maximize the minimum" uses the OPPOSITE binary search direction.
  - We want the LARGEST feasible answer, not the smallest.
  - When feasible: lo = mid (not hi = mid).
  - Use upper-mid: mid = lo + (hi - lo + 1) / 2 to avoid infinite loop when lo = hi - 1.
  The standard lo + (hi - lo) / 2 would always give lo, creating an infinite loop.
```

---

**P19.20** [M] -- Minimum Time to Complete Trips (LeetCode 2187)

Given bus travel times, find the minimum total time for all buses combined to complete at least `totalTrips` trips.

```
Pattern: Binary search on time. At time T, bus i completes T / time[i] trips.
```

```java
public long minimumTime(int[] time, int totalTrips) {
    long lo = 1;
    long hi = (long) Arrays.stream(time).min().getAsInt() * totalTrips;
    
    while (lo < hi) {
        long mid = lo + (hi - lo) / 2;
        if (canComplete(time, mid, totalTrips)) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo;
}

private boolean canComplete(int[] time, long totalTime, int totalTrips) {
    long trips = 0;
    for (int t : time) {
        trips += totalTime / t;
        if (trips >= totalTrips) return true;  // early exit
    }
    return false;
}
```

```
Time:  O(n log(minTime × totalTrips))
Space: O(1)
The early exit in canComplete prevents overflow: trips could exceed Long.MAX_VALUE
if we sum all trips without checking. The moment we hit totalTrips, we return true.
hi = minTime × totalTrips because the fastest bus alone could complete all trips by then.
```

---

**P19.21** [M] -- Minimum Speed to Arrive on Time (LeetCode 1870)

Given distances and a time limit, find the minimum integer speed to arrive on time. Each leg takes `ceil(dist[i] / speed)` hours except the last, which takes `dist[i] / speed` exactly.

```
Pattern: Binary search on speed. Higher speed → less time (monotonic).
```

```java
public int minSpeedOnTime(int[] dist, double hour) {
    int n = dist.length;
    if (hour <= n - 1) return -1;  // impossible: each leg takes at least 1 hour
    
    int lo = 1, hi = 10_000_000;  // max speed from constraints
    
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (canArrive(dist, mid, hour)) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    
    return canArrive(dist, lo, hour) ? lo : -1;
}

private boolean canArrive(int[] dist, int speed, double hour) {
    double time = 0;
    for (int i = 0; i < dist.length - 1; i++) {
        time += (dist[i] + speed - 1) / speed;  // ceiling division (integer)
    }
    time += (double) dist[dist.length - 1] / speed;  // last leg: exact
    return time <= hour;
}
```

```
Time:  O(n log M) where M = max speed
Space: O(1)
Subtlety: the last leg does NOT round up. You arrive at a fractional time.
All previous legs must be whole hours (you wait at the station for the next departure).
The ceiling division for intermediate legs uses integer arithmetic: (dist + speed - 1) / speed.
```

---

**P19.22** [M] -- House Robber IV (LeetCode 2560)

Find the minimum capability (maximum money stolen in one robbery) such that you can rob at least k houses with no two adjacent.

```
Pattern: Binary search on capability. Greedy check: can we rob k non-adjacent houses
where each has value ≤ capability?
```

```java
public int minCapability(int[] nums, int k) {
    int lo = 1, hi = 0;
    for (int num : nums) hi = Math.max(hi, num);
    
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (canRob(nums, mid, k)) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo;
}

private boolean canRob(int[] nums, int capability, int k) {
    int count = 0;
    int i = 0;
    while (i < nums.length) {
        if (nums[i] <= capability) {
            count++;
            i += 2;  // skip adjacent
        } else {
            i++;
        }
        if (count >= k) return true;
    }
    return false;
}
```

```
Time:  O(n log M) where M = max house value
Space: O(1)
The greedy check is simple: scan left to right, rob every house you can (≤ capability),
then skip the next house. This greedy strategy is optimal because robbing earlier
frees up more houses later. If this greedy can rob k houses, the capability is feasible.
```

---

**P19.23** [E] -- Find the Smallest Divisor Given a Threshold (LeetCode 1283)

Find the smallest divisor such that the sum of `ceil(nums[i] / divisor)` for all elements is at most the threshold.

```
Pattern: Binary search on divisor. Larger divisor → smaller sum (monotonic).
```

```java
public int smallestDivisor(int[] nums, int threshold) {
    int lo = 1, hi = 0;
    for (int num : nums) hi = Math.max(hi, num);
    
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (sumWithDivisor(nums, mid) <= threshold) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo;
}

private long sumWithDivisor(int[] nums, int divisor) {
    long sum = 0;
    for (int num : nums) {
        sum += (num + divisor - 1) / divisor;
    }
    return sum;
}
```

```
Time:  O(n log M) where M = max(nums)
Space: O(1)
Again the ceiling division pattern: (num + divisor - 1) / divisor.
This is structurally identical to Koko Eating Bananas (P19.16) — the banana pile
is the number, the eating speed is the divisor, and the hour limit is the threshold.
```

---

**P19.24** [M] -- Maximum Candies Allocated to K Children (LeetCode 2226)

Given candy piles, split each pile into sub-piles. Maximize the size of sub-piles given to exactly k children (one sub-pile each).

```
Pattern: Binary search on the sub-pile size. "Maximize X such that ..." → binary search.
```

```java
public int maximumCandies(int[] candies, long k) {
    int lo = 0, hi = 0;
    for (int c : candies) hi = Math.max(hi, c);
    
    while (lo < hi) {
        int mid = lo + (hi - lo + 1) / 2;  // upper-mid (maximize)
        if (canAllocate(candies, mid, k)) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
}

private boolean canAllocate(int[] candies, int size, long k) {
    long count = 0;
    for (int c : candies) {
        count += c / size;
        if (count >= k) return true;
    }
    return false;
}
```

```
Time:  O(n log M) where M = max pile
Space: O(1)
"Maximize" → lo = mid, use upper-mid. Same pattern as P19.19 (Magnetic Force).
lo starts at 0 (not 1) because it's possible that no allocation works, returning 0.
```

---

**P19.25** [H] -- Aggressive Cows (Classic / SPOJ AGGRCOW)

Place c cows in n stalls to maximize the minimum distance between any two cows.

```
Pattern: Identical to P19.19 (Magnetic Force). Binary search on minimum distance.
This is the original problem that inspired the LeetCode version.
```

```java
public int aggressiveCows(int[] stalls, int c) {
    Arrays.sort(stalls);
    int lo = 1;
    int hi = stalls[stalls.length - 1] - stalls[0];
    
    while (lo < hi) {
        int mid = lo + (hi - lo + 1) / 2;
        if (canPlaceCows(stalls, mid, c)) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
}

private boolean canPlaceCows(int[] stalls, int minDist, int c) {
    int placed = 1, lastPos = stalls[0];
    for (int i = 1; i < stalls.length; i++) {
        if (stalls[i] - lastPos >= minDist) {
            placed++;
            lastPos = stalls[i];
            if (placed >= c) return true;
        }
    }
    return false;
}
```

```
Time:  O(n log n + n log D)
Space: O(1)
This problem is a classic in competitive programming circles. It predates the LeetCode
era and appears in SPOJ, Codeforces, and USACO. The template is identical to P19.19.
Recognition: "maximize the minimum distance" = binary search on answer, maximize variant.
```

---

### Bit Manipulation Problems

---

**P19.26** [E] -- Single Number (LeetCode 136)

Every element appears twice except one. Find the single element.

```
Pattern: XOR cancellation. a ^ a = 0, so all pairs cancel, leaving the single element.
```

```java
public int singleNumber(int[] nums) {
    int result = 0;
    for (int num : nums) {
        result ^= num;
    }
    return result;
}
```

```
Time:  O(n)
Space: O(1)
The most elegant O(1)-space solution possible. No HashMap, no sorting.
XOR is commutative and associative, so the order doesn't matter.
5 ^ 3 ^ 5 = (5 ^ 5) ^ 3 = 0 ^ 3 = 3.
```

---

**P19.27** [M] -- Single Number II (LeetCode 137)

Every element appears three times except one. Find the single element.

```
Pattern: Count bits modulo 3. For each bit position, count how many numbers have
that bit set. If count % 3 != 0, the single number has that bit set.
```

```java
public int singleNumber(int[] nums) {
    int result = 0;
    for (int i = 0; i < 32; i++) {
        int bitCount = 0;
        for (int num : nums) {
            bitCount += (num >> i) & 1;
        }
        if (bitCount % 3 != 0) {
            result |= (1 << i);
        }
    }
    return result;
}
```

```
Time:  O(32n) = O(n)
Space: O(1)
Alternative: use two state variables (ones, twos) to simulate a ternary counter per bit:
  ones = (ones ^ num) & ~twos;
  twos = (twos ^ num) & ~ones;
This processes each number in O(1) but is harder to derive from scratch.
The bit-counting approach generalizes to any k appearances: count % k.
```

---

**P19.28** [M] -- Single Number III (LeetCode 260)

Two elements appear once; all others appear twice. Find both single elements.

```
Pattern: XOR all → get xor of the two unique numbers. Use any set bit to partition
the array into two groups, each containing one unique number.
```

```java
public int[] singleNumber(int[] nums) {
    int xor = 0;
    for (int num : nums) xor ^= num;
    
    // xor = a ^ b (a and b are the two unique numbers)
    // Find any bit where a and b differ (any set bit in xor)
    int diffBit = xor & (-xor);  // isolate lowest set bit
    
    int a = 0;
    for (int num : nums) {
        if ((num & diffBit) != 0) {
            a ^= num;  // only XOR numbers with this bit set
        }
    }
    
    return new int[]{a, xor ^ a};  // b = xor ^ a
}
```

```
Time:  O(n)
Space: O(1)
The insight: since a != b, xor has at least one set bit. That bit is 1 in one of a,b
and 0 in the other. Numbers appearing twice have the same bit, so they still cancel
within their group. Each group is left with exactly one unique number.
```

---

**P19.29** [E] -- Counting Bits (LeetCode 338)

For every number from 0 to n, return the number of 1-bits.

```
Pattern: DP using the "clear lowest set bit" trick: dp[i] = dp[i & (i-1)] + 1.
```

```java
public int[] countBits(int n) {
    int[] dp = new int[n + 1];
    for (int i = 1; i <= n; i++) {
        dp[i] = dp[i & (i - 1)] + 1;  // clear lowest bit → one fewer 1-bit
    }
    return dp;
}
```

```
Time:  O(n)
Space: O(n) for the output (O(1) extra)
i & (i-1) clears the lowest set bit of i. So dp[i] = 1 + dp[i with lowest bit cleared].
Example: i=6 (110), i&(i-1)=4 (100). dp[6] = dp[4] + 1 = 1 + 1 = 2. ✓
Alternative: dp[i] = dp[i >> 1] + (i & 1). This uses the relationship:
  number of bits in i = number of bits in i/2 + bottom bit.
Both are O(n) and clean.
```

---

**P19.30** [E] -- Reverse Bits (LeetCode 190)

Reverse all 32 bits of a given unsigned integer.

```
Pattern: Extract each bit from the right, shift result left, OR the extracted bit in.
```

```java
public int reverseBits(int n) {
    int result = 0;
    for (int i = 0; i < 32; i++) {
        result = (result << 1) | (n & 1);
        n >>= 1;
    }
    return result;
}
```

```
Time:  O(1) — exactly 32 iterations
Space: O(1)
JVM note: Integer.reverse(n) does this in O(1) using a clever divide-and-conquer
bit swap sequence. It swaps adjacent bits, then adjacent pairs, then nibbles,
then bytes, then shorts. 5 operations total. The JIT may even compile this to
a BSWAP instruction on x86 (though BSWAP reverses bytes, not bits).
In interviews, write the loop. In production, use Integer.reverse().
```

---

**P19.31** [E] -- Hamming Distance (LeetCode 461)

Count the number of bit positions where two integers differ.

```
Pattern: XOR the two numbers → set bits in the result are positions where they differ.
Count set bits with Brian Kernighan's or Integer.bitCount().
```

```java
public int hammingDistance(int x, int y) {
    return Integer.bitCount(x ^ y);
}
```

```
Time:  O(1)
Space: O(1)
This is perhaps the shortest non-trivial LeetCode solution. XOR gives 1 where bits differ.
bitCount gives the number of 1s. On modern JVMs, Integer.bitCount compiles to POPCNT.
```

---

**P19.32** [M] -- Total Hamming Distance (LeetCode 477)

Find the sum of Hamming distances between all pairs in an array.

```
Pattern: For each bit position, count how many numbers have 1 and how many have 0.
Contribution of that bit = count_ones × count_zeros.
```

```java
public int totalHammingDistance(int[] nums) {
    int total = 0;
    int n = nums.length;
    
    for (int bit = 0; bit < 32; bit++) {
        int ones = 0;
        for (int num : nums) {
            ones += (num >> bit) & 1;
        }
        int zeros = n - ones;
        total += ones * zeros;
    }
    return total;
}
```

```
Time:  O(32n) = O(n)
Space: O(1)
Brute force would be O(n²) for all pairs. The bit-counting trick reduces it to O(n).
For each bit position, each (one, zero) pair contributes 1 to the total Hamming distance.
Number of such pairs = ones × zeros. Sum across all 32 bit positions.
```

---

**P19.33** [M] -- Bitwise AND of Numbers Range (LeetCode 201)

Find the bitwise AND of all numbers in [left, right].

```
Pattern: Find the common prefix of left and right in binary.
Bits that differ will be AND-ed with both 0 and 1 → they become 0.
```

```java
public int rangeBitwiseAnd(int left, int right) {
    int shift = 0;
    while (left != right) {
        left >>= 1;
        right >>= 1;
        shift++;
    }
    return left << shift;
}
```

```
Time:  O(1) — at most 32 iterations
Space: O(1)
Intuition: AND accumulates zeros. Any bit position where there exists both a 0 and a 1
in the range will result in 0. The only bits that survive are the common prefix of left
and right. We shift both right until they match (finding the common prefix), then shift
left back to restore the position.
Alternative: use Brian Kernighan's trick on 'right': while (right > left) right &= right - 1.
This clears the lowest set bit of right until right falls to the common prefix.
```

---

**P19.34** [M] -- Maximum XOR of Two Numbers in an Array (LeetCode 421)

Find the maximum XOR of any two numbers in the array.

```
Pattern: Greedy bit-by-bit construction using a HashSet.
For each bit from high to low, check if we can set it to 1 in the result.
```

```java
public int findMaximumXOR(int[] nums) {
    int maxXor = 0;
    int mask = 0;
    
    for (int bit = 31; bit >= 0; bit--) {
        mask |= (1 << bit);
        
        Set<Integer> prefixes = new HashSet<>();
        for (int num : nums) {
            prefixes.add(num & mask);  // keep only the top bits
        }
        
        // Try to set this bit in the result
        int candidate = maxXor | (1 << bit);
        for (int prefix : prefixes) {
            // If prefix ^ candidate exists in set, then two numbers XOR to candidate
            // Because if a ^ b = candidate, then a ^ candidate = b
            if (prefixes.contains(prefix ^ candidate)) {
                maxXor = candidate;
                break;
            }
        }
    }
    return maxXor;
}
```

```
Time:  O(32n) = O(n)
Space: O(n) for the HashSet
The key insight: if a ^ b = target, then a ^ target = b. So for each candidate result,
we check if any prefix XOR'd with the candidate produces another prefix in the set.
Greedy: try to set each bit from the highest position downward.
Alternative: Trie-based solution processes each number's binary representation, achieving
O(n) with explicit tree traversal. The HashSet approach is simpler to code in interviews.
```

---

**P19.35** [M] -- Minimum Flips to Make a OR b Equal to c (LeetCode 1318)

Find the minimum bit flips to make `a | b == c`.

```
Pattern: Check each bit position independently. Count required flips based on current
and target bit values.
```

```java
public int minFlips(int a, int b, int c) {
    int flips = 0;
    for (int i = 0; i < 32; i++) {
        int bitA = (a >> i) & 1;
        int bitB = (b >> i) & 1;
        int bitC = (c >> i) & 1;
        
        if (bitC == 1) {
            // Need at least one 1 in a|b at this position
            if (bitA == 0 && bitB == 0) flips += 1;  // flip one of them to 1
        } else {
            // Need both to be 0 at this position
            flips += bitA + bitB;  // flip each 1 to 0
        }
    }
    return flips;
}
```

```
Time:  O(1) — 32 iterations
Space: O(1)
When c's bit is 0: both a and b must have 0 at that position. If either has 1, that's a flip.
If both have 1, that's 2 flips (we cannot flip just the OR; we must flip the sources).
When c's bit is 1: at least one of a, b must have 1. If neither does, one flip suffices.
```

---

### Math Pattern Problems

---

**P19.36** [M] -- Count Primes (LeetCode 204)

Count the number of primes less than n.

```
Pattern: Sieve of Eratosthenes.
```

```java
public int countPrimes(int n) {
    if (n <= 2) return 0;
    
    boolean[] isComposite = new boolean[n];
    
    for (int i = 2; (long) i * i < n; i++) {
        if (!isComposite[i]) {
            for (int j = i * i; j < n; j += i) {
                isComposite[j] = true;
            }
        }
    }
    
    int count = 0;
    for (int i = 2; i < n; i++) {
        if (!isComposite[i]) count++;
    }
    return count;
}
```

```
Time:  O(n log log n)
Space: O(n)
The (long) i * i cast prevents integer overflow for large n.
Starting the inner loop at i*i (not 2*i): all multiples of i below i*i have already been
marked by smaller primes. This optimization roughly halves the work.
JVM note: boolean[] uses 1 byte per element. For n = 5 × 10^6, that's 5 MB.
BitSet would use 625 KB but adds bitwise extraction overhead per access.
```

---

**P19.37** [E] -- Ugly Number (LeetCode 263)

Check if a number is ugly (only prime factors are 2, 3, 5).

```
Pattern: Repeatedly divide by 2, 3, 5. If the result is 1, it is ugly.
```

```java
public boolean isUgly(int n) {
    if (n <= 0) return false;
    while (n % 2 == 0) n /= 2;
    while (n % 3 == 0) n /= 3;
    while (n % 5 == 0) n /= 5;
    return n == 1;
}
```

```
Time:  O(log n) — each division at least halves the number
Space: O(1)
Simple and clean. The order of divisions doesn't matter.
Edge case: n <= 0 is not ugly by definition (1 IS ugly: its prime factorization is empty).
```

---

**P19.38** [M] -- Ugly Number II (LeetCode 264)

Find the n-th ugly number.

```
Pattern: Three-pointer merge. Maintain pointers for ×2, ×3, ×5. Pick the smallest product.
```

```java
public int nthUglyNumber(int n) {
    int[] ugly = new int[n];
    ugly[0] = 1;
    int p2 = 0, p3 = 0, p5 = 0;
    
    for (int i = 1; i < n; i++) {
        int next2 = ugly[p2] * 2;
        int next3 = ugly[p3] * 3;
        int next5 = ugly[p5] * 5;
        
        ugly[i] = Math.min(next2, Math.min(next3, next5));
        
        // Advance ALL pointers that match (handles duplicates like 6 = 2×3 = 3×2)
        if (ugly[i] == next2) p2++;
        if (ugly[i] == next3) p3++;
        if (ugly[i] == next5) p5++;
    }
    return ugly[n - 1];
}
```

```
Time:  O(n)
Space: O(n)
This is a k-way merge where k=3. Each pointer tracks "the smallest ugly number whose
product with its factor hasn't been added yet." All three if-checks (not else-if) handle
the duplicate case: 6 is produced by both p2 and p3, so both must advance.
```

---

**P19.39** [M] -- Super Ugly Number (LeetCode 313)

Find the n-th ugly number whose prime factors are a given list of primes.

```
Pattern: Generalized version of P19.38 with k pointers. Use a PriorityQueue for k-way merge.
```

```java
public int nthSuperUglyNumber(int n, int[] primes) {
    int k = primes.length;
    int[] ugly = new int[n];
    ugly[0] = 1;
    int[] pointers = new int[k];  // all start at 0
    
    for (int i = 1; i < n; i++) {
        int minVal = Integer.MAX_VALUE;
        for (int j = 0; j < k; j++) {
            minVal = Math.min(minVal, ugly[pointers[j]] * primes[j]);
        }
        ugly[i] = minVal;
        for (int j = 0; j < k; j++) {
            if (ugly[pointers[j]] * primes[j] == minVal) {
                pointers[j]++;
            }
        }
    }
    return ugly[n - 1];
}
```

```
Time:  O(n × k) where k = number of primes
Space: O(n + k)
For large k, a PriorityQueue gives O(n log k). For small k (≤ 10 or so), the linear
scan is faster due to lower constant factors — no heap allocation or sift operations.
The PriorityQueue version: store (value, primeIndex, uglyIndex) tuples, extract min.
Beware overflow: ugly[pointers[j]] * primes[j] can overflow int for large n. Use long.
```

---

**P19.40** [E] -- Power of Three (LeetCode 326)

Check if n is a power of three.

```
Pattern: Mathematical approach — the largest power of 3 fitting in an int (3^19 = 1162261467)
is divisible by all smaller powers of 3.
```

```java
public boolean isPowerOfThree(int n) {
    // 3^19 = 1162261467 is the largest power of 3 that fits in a 32-bit signed int
    return n > 0 && 1162261467 % n == 0;
}
```

```
Time:  O(1)
Space: O(1)
Why this works: 3 is prime. So the only divisors of 3^19 are 3^0, 3^1, ..., 3^19.
If n > 0 and 3^19 % n == 0, then n must be a power of 3.
This trick works for any prime base. It does NOT work for composite bases like 4
because 4^k = 2^(2k), and 2^(2k) is divisible by non-powers-of-4 like 2, 8, 32.
Loop alternative: while (n > 1 && n % 3 == 0) n /= 3; return n == 1; — O(log n).
```

---

**P19.41** [E] -- Happy Number (LeetCode 202)

A number is happy if iterating the sum of squares of digits eventually reaches 1. Detect if it loops forever.

```
Pattern: Floyd's cycle detection (slow/fast pointers) on the digit-sum sequence.
```

```java
public boolean isHappy(int n) {
    int slow = n, fast = n;
    do {
        slow = digitSquareSum(slow);
        fast = digitSquareSum(digitSquareSum(fast));
    } while (slow != fast);
    return slow == 1;
}

private int digitSquareSum(int n) {
    int sum = 0;
    while (n > 0) {
        int d = n % 10;
        sum += d * d;
        n /= 10;
    }
    return sum;
}
```

```
Time:  O(log n) — the sequence converges quickly; values are bounded by 81 × digits
Space: O(1) — no HashSet needed thanks to Floyd's cycle detection
Why Floyd's works here: the digit-square-sum function maps integers to integers.
Since the range is bounded (for n < 10^10, sum ≤ 810), the sequence must eventually
cycle. If it cycles through 1, n is happy. Otherwise, the cycle doesn't include 1.
HashSet alternative: store seen values, check for revisit. O(log n) space.
```

---

**P19.42** [M] -- Fraction to Recurring Decimal (LeetCode 166)

Convert a fraction to a string, with repeating parts in parentheses. E.g., 1/3 = "0.(3)".

```
Pattern: Long division simulation. Track remainders with HashMap to detect the repeat point.
```

```java
public String fractionToDecimal(int numerator, int denominator) {
    if (numerator == 0) return "0";
    
    StringBuilder sb = new StringBuilder();
    
    // Handle sign
    if ((numerator > 0) ^ (denominator > 0)) sb.append('-');
    
    // Use long to handle Integer.MIN_VALUE
    long num = Math.abs((long) numerator);
    long den = Math.abs((long) denominator);
    
    // Integer part
    sb.append(num / den);
    long remainder = num % den;
    if (remainder == 0) return sb.toString();
    
    sb.append('.');
    
    // Decimal part: track remainder → position
    Map<Long, Integer> remainderMap = new HashMap<>();
    
    while (remainder != 0) {
        if (remainderMap.containsKey(remainder)) {
            sb.insert(remainderMap.get(remainder), "(");
            sb.append(')');
            break;
        }
        remainderMap.put(remainder, sb.length());
        remainder *= 10;
        sb.append(remainder / den);
        remainder %= den;
    }
    
    return sb.toString();
}
```

```
Time:  O(d) where d = length of the decimal representation (bounded by denominator)
Space: O(d) for the HashMap and StringBuilder
The key insight: a repeating decimal repeats when the same remainder appears again in
long division. The HashMap maps each remainder to its position in the string, so we
know exactly where to insert the opening parenthesis.
Edge case: Integer.MIN_VALUE / -1 would overflow int. Using long prevents this.
Edge case: negative results — XOR of signs determines the sign.
```

---

**P19.43** [M] -- Integer Break (LeetCode 343)

Break a positive integer n into at least two positive integers that sum to n. Maximize their product.

```
Pattern: Mathematical insight — always break into 3s (with special handling for remainder).
```

```java
public int integerBreak(int n) {
    if (n == 2) return 1;
    if (n == 3) return 2;
    
    int product = 1;
    while (n > 4) {
        product *= 3;
        n -= 3;
    }
    return product * n;  // n is now 2, 3, or 4
}
```

```
Time:  O(n/3) = O(n)
Space: O(1)
Why 3? By AM-GM inequality, for a fixed sum, the product is maximized when all parts
are equal. The optimal part size is e ≈ 2.718, so we choose 3 (closest integer).
Why not 2? 3×3 = 9 > 2×2×2 = 8 for the same sum of 6. So 3s beat 2s.
Why not 4? 4 = 2×2 with same product, so 4 is equivalent to two 2s. No harm.
Why "n > 4" instead of "n > 3"? Because when n=4, breaking into 1+3 gives 3,
but keeping 4 gives 4. We avoid breaking down to 1 (which kills the product).
DP alternative: dp[i] = max over j of (j × max(i-j, dp[i-j])). O(n²) but instructive.
```

---

### Line Sweep Problems

---

**P19.44** [M] -- Meeting Rooms II (LeetCode 253)

Find the minimum number of meeting rooms required.

```
Pattern: Line sweep with events. +1 at start, -1 at end. Max concurrent = answer.
```

```java
public int minMeetingRooms(int[][] intervals) {
    // Difference array approach with TreeMap
    TreeMap<Integer, Integer> events = new TreeMap<>();
    for (int[] interval : intervals) {
        events.merge(interval[0], 1, Integer::sum);
        events.merge(interval[1], -1, Integer::sum);
    }
    
    int maxRooms = 0, current = 0;
    for (int delta : events.values()) {
        current += delta;
        maxRooms = Math.max(maxRooms, current);
    }
    return maxRooms;
}
```

```
Time:  O(n log n) — TreeMap insertions
Space: O(n)
Why TreeMap? It sorts events by time automatically and merges coinciding events.
Alternative: sort two arrays (starts and ends) separately, use two pointers.
  This avoids TreeMap overhead but loses the elegance of a single data structure.
Alternative: PriorityQueue (min-heap) of end times. For each meeting, if start >= heap.peek(),
  reuse that room (poll and offer new end). Else allocate new room (offer new end).
  Answer = heap.size(). Same O(n log n), different style.
```

---

**P19.45** [H] -- The Skyline Problem (LeetCode 218)

Given building rectangles [left, right, height], compute the skyline contour.

```
Pattern: Line sweep with events + TreeMap (or max-heap) for active heights.
Events: building start (add height), building end (remove height).
```

```java
public List<List<Integer>> getSkyline(int[][] buildings) {
    List<int[]> events = new ArrayList<>();
    for (int[] b : buildings) {
        events.add(new int[]{b[0], -b[2]});  // start: negative height (sort: start before end)
        events.add(new int[]{b[1], b[2]});   // end: positive height
    }
    
    // Sort by x. If same x: start before end (negative before positive).
    // If both starts: taller first (more negative first).
    // If both ends: shorter first (smaller positive first).
    events.sort((a, b) -> a[0] != b[0] ? a[0] - b[0] : a[1] - b[1]);
    
    // TreeMap as a sorted multiset of active heights
    TreeMap<Integer, Integer> heights = new TreeMap<>();
    heights.put(0, 1);  // ground level always present
    int prevMax = 0;
    
    List<List<Integer>> result = new ArrayList<>();
    
    for (int[] event : events) {
        int x = event[0], h = Math.abs(event[1]);
        
        if (event[1] < 0) {
            // Building start: add height
            heights.merge(h, 1, Integer::sum);
        } else {
            // Building end: remove height
            int count = heights.get(h);
            if (count == 1) heights.remove(h);
            else heights.put(h, count - 1);
        }
        
        int currentMax = heights.lastKey();
        if (currentMax != prevMax) {
            result.add(Arrays.asList(x, currentMax));
            prevMax = currentMax;
        }
    }
    return result;
}
```

```
Time:  O(n log n) — sorting events + TreeMap operations
Space: O(n)
The sorting tiebreaker is critical:
  - Same x, both starts: process taller first (so the shorter one doesn't create
    a spurious skyline point that the taller one immediately overrides).
  - Same x, both ends: process shorter first (so removing shorter doesn't falsely
    report a height change if taller is also ending).
  - Same x, start vs. end: process start first (building that starts at x=5 and
    building that ends at x=5 should show the starting building's height).
The negative-height trick for starts handles all three cases with a single comparator.
```

---

**P19.46** [M] -- My Calendar I (LeetCode 729)

Implement a calendar that rejects double-bookings.

```
Pattern: TreeMap for ordered intervals. Use floorKey/ceilingKey to check overlap.
```

```java
class MyCalendar {
    private TreeMap<Integer, Integer> calendar;  // start → end
    
    public MyCalendar() {
        calendar = new TreeMap<>();
    }
    
    public boolean book(int start, int end) {
        // Check if the previous event overlaps
        Map.Entry<Integer, Integer> prev = calendar.floorEntry(start);
        if (prev != null && prev.getValue() > start) return false;
        
        // Check if the next event overlaps
        Map.Entry<Integer, Integer> next = calendar.ceilingEntry(start);
        if (next != null && next.getKey() < end) return false;
        
        calendar.put(start, end);
        return true;
    }
}
```

```
Time:  O(log n) per booking (TreeMap operations)
Space: O(n) for stored events
floorEntry(start): the event with the largest start time ≤ our start.
  If its end > our start, it overlaps.
ceilingEntry(start): the event with the smallest start time ≥ our start.
  If its start < our end, it overlaps.
This is O(log n) per query — much better than linear scanning all events.
```

---

**P19.47** [M] -- My Calendar II (LeetCode 731)

Allow double-bookings but reject triple-bookings.

```
Pattern: Line sweep with TreeMap. At each point, if the count reaches 3, reject.
```

```java
class MyCalendarTwo {
    private TreeMap<Integer, Integer> events;
    
    public MyCalendarTwo() {
        events = new TreeMap<>();
    }
    
    public boolean book(int start, int end) {
        events.merge(start, 1, Integer::sum);
        events.merge(end, -1, Integer::sum);
        
        // Check if any point has 3 overlaps
        int active = 0;
        for (int delta : events.values()) {
            active += delta;
            if (active >= 3) {
                // Undo the booking
                events.merge(start, -1, Integer::sum);
                events.merge(end, 1, Integer::sum);
                if (events.get(start) == 0) events.remove(start);
                if (events.get(end) == 0) events.remove(end);
                return false;
            }
        }
        return true;
    }
}
```

```
Time:  O(n) per booking (sweep through all events)
Space: O(n)
This uses the difference-array / sweep approach from Meeting Rooms II.
Each booking tentatively adds its events, then sweeps to check for triple-overlap.
If found, undo the tentative addition.
For O(log n) per query, use two interval-tracking structures (one for single bookings,
one for double bookings), similar to My Calendar I with two TreeMaps.
```

---

**P19.48** [H] -- My Calendar III (LeetCode 732)

Return the maximum number of concurrent events after each booking.

```
Pattern: Line sweep. After each booking, sweep through all events to find the max overlap.
```

```java
class MyCalendarThree {
    private TreeMap<Integer, Integer> events;
    
    public MyCalendarThree() {
        events = new TreeMap<>();
    }
    
    public int book(int start, int end) {
        events.merge(start, 1, Integer::sum);
        events.merge(end, -1, Integer::sum);
        
        int maxOverlap = 0, active = 0;
        for (int delta : events.values()) {
            active += delta;
            maxOverlap = Math.max(maxOverlap, active);
        }
        return maxOverlap;
    }
}
```

```
Time:  O(n) per booking
Space: O(n)
This is the simplest of the three calendar problems. No rejection, just report the max.
The sweep is the same as Meeting Rooms II. A Segment Tree with lazy propagation
would give O(log C) per query where C is the coordinate range, but for interview purposes
the TreeMap sweep is clean and sufficient.
```

---

**P19.49** [H] -- Rectangle Area II (LeetCode 850)

Given a list of axis-aligned rectangles, find the total area covered (counting overlapping area once).

```
Pattern: Line sweep + coordinate compression. Sweep vertical lines, maintain active
horizontal segments, compute area between consecutive x-coordinates.
```

```java
public int rectangleArea(int[][] rectangles) {
    int MOD = 1_000_000_007;
    
    // Collect all x-coordinates
    Set<Integer> xSet = new TreeSet<>();
    for (int[] r : rectangles) {
        xSet.add(r[0]);
        xSet.add(r[2]);
    }
    Integer[] xs = xSet.toArray(new Integer[0]);
    
    // For each vertical strip between consecutive x-coordinates,
    // find the union of y-intervals
    long totalArea = 0;
    
    for (int i = 0; i < xs.length - 1; i++) {
        int x1 = xs[i], x2 = xs[i + 1];
        
        // Collect all y-intervals active in this strip
        List<int[]> yIntervals = new ArrayList<>();
        for (int[] r : rectangles) {
            if (r[0] <= x1 && r[2] >= x2) {
                yIntervals.add(new int[]{r[1], r[3]});
            }
        }
        
        // Merge y-intervals
        yIntervals.sort((a, b) -> a[0] != b[0] ? a[0] - b[0] : a[1] - b[1]);
        long yLength = 0;
        int curStart = -1, curEnd = -1;
        for (int[] interval : yIntervals) {
            if (interval[0] > curEnd) {
                yLength += curEnd - curStart;
                curStart = interval[0];
                curEnd = interval[1];
            } else {
                curEnd = Math.max(curEnd, interval[1]);
            }
        }
        yLength += curEnd - curStart;
        
        totalArea = (totalArea + (long)(x2 - x1) * yLength) % MOD;
    }
    return (int) totalArea;
}
```

```
Time:  O(n² log n) — for each of O(n) strips, sort O(n) intervals
Space: O(n)
Coordinate compression: we only process x-coordinates where rectangles start/end.
Between consecutive x-coordinates, the set of active rectangles doesn't change.
Interval merging: within each strip, sort y-intervals and merge overlapping ones to
compute the total y-length covered. Area of strip = width × y-length.
For O(n log² n), use a segment tree on compressed y-coordinates.
```

---

**P19.50** [M] -- Corporate Flight Bookings (LeetCode 1109)

Given bookings [first, last, seats] and n flights, return the total seats reserved for each flight.

```
Pattern: Difference array. Classic O(n) sweep after O(b) event creation.
```

```java
public int[] corpFlightBookings(int[][] bookings, int n) {
    int[] seats = new int[n];
    
    for (int[] booking : bookings) {
        int first = booking[0] - 1;  // 0-indexed
        int last = booking[1];        // exclusive end
        int count = booking[2];
        
        seats[first] += count;
        if (last < n) seats[last] -= count;
    }
    
    // Prefix sum to get actual values
    for (int i = 1; i < n; i++) {
        seats[i] += seats[i - 1];
    }
    return seats;
}
```

```
Time:  O(n + b) where b = number of bookings
Space: O(n) for the output
The difference array is the discrete version of line sweep. Instead of a TreeMap of events,
we use an array where position[start] += count and position[end+1] -= count.
A prefix sum converts the difference array into actual values.
This is O(n + b), much better than O(n × b) of the naive approach.
JVM note: the difference array fits entirely in L1 cache for typical n values (≤ 20,000),
making the prefix sum loop extremely fast — one sequential memory access per iteration.
```

---

### Design Problems

---

**P19.51** [M] -- LRU Cache (LeetCode 146)

Design a data structure that supports `get` and `put` in O(1) with LRU eviction.

```
Pattern: HashMap + doubly linked list. HashMap gives O(1) lookup.
Doubly linked list gives O(1) move-to-front and remove-from-tail.
```

```java
class LRUCache {
    private final int capacity;
    private final Map<Integer, Node> map;
    private final Node head, tail;  // sentinel nodes
    
    private static class Node {
        int key, value;
        Node prev, next;
        Node(int key, int value) { this.key = key; this.value = value; }
    }
    
    public LRUCache(int capacity) {
        this.capacity = capacity;
        this.map = new HashMap<>();
        head = new Node(0, 0);
        tail = new Node(0, 0);
        head.next = tail;
        tail.prev = head;
    }
    
    public int get(int key) {
        Node node = map.get(key);
        if (node == null) return -1;
        moveToFront(node);
        return node.value;
    }
    
    public void put(int key, int value) {
        Node node = map.get(key);
        if (node != null) {
            node.value = value;
            moveToFront(node);
        } else {
            if (map.size() == capacity) {
                Node lru = tail.prev;
                removeNode(lru);
                map.remove(lru.key);
            }
            Node newNode = new Node(key, value);
            addToFront(newNode);
            map.put(key, newNode);
        }
    }
    
    private void moveToFront(Node node) {
        removeNode(node);
        addToFront(node);
    }
    
    private void removeNode(Node node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }
    
    private void addToFront(Node node) {
        node.next = head.next;
        node.prev = head;
        head.next.prev = node;
        head.next = node;
    }
}
```

```
Time:  O(1) for both get and put
Space: O(capacity)
Sentinel nodes (head, tail) eliminate null checks in addToFront and removeNode.
Without sentinels, every pointer operation requires if-null guards — sentinel nodes
make the code cleaner AND branch-free.
Why not LinkedHashMap? Java's LinkedHashMap with accessOrder=true IS an LRU cache.
But interviewers want you to build it from scratch to prove you understand the internals.
In production: absolutely use LinkedHashMap or Caffeine cache.
JVM note: each Node is a separate heap object. For capacity = 10,000:
  10,000 nodes × ~40 bytes each = 400 KB + HashMap overhead.
  LinkedHashMap does the same thing under the hood but with one fewer object per entry
  (the Entry IS the node).
```

---

**P19.52** [H] -- LFU Cache (LeetCode 460)

Design a data structure that supports `get` and `put` in O(1) with LFU eviction (least frequently used; ties broken by LRU).

```
Pattern: HashMap for key→value, HashMap for key→frequency, HashMap for frequency→doubly-linked-list.
Track the minimum frequency.
```

```java
class LFUCache {
    private final int capacity;
    private int minFreq;
    private final Map<Integer, Node> keyMap;           // key → node
    private final Map<Integer, LinkedList<Node>> freqMap;  // freq → list of nodes
    
    private static class Node {
        int key, value, freq;
        Node(int key, int value) { this.key = key; this.value = value; this.freq = 1; }
    }
    
    public LFUCache(int capacity) {
        this.capacity = capacity;
        this.minFreq = 0;
        this.keyMap = new HashMap<>();
        this.freqMap = new HashMap<>();
    }
    
    public int get(int key) {
        Node node = keyMap.get(key);
        if (node == null) return -1;
        updateFreq(node);
        return node.value;
    }
    
    public void put(int key, int value) {
        if (capacity == 0) return;
        
        Node node = keyMap.get(key);
        if (node != null) {
            node.value = value;
            updateFreq(node);
        } else {
            if (keyMap.size() == capacity) {
                // Evict LFU (ties by LRU: remove from tail of minFreq list)
                LinkedList<Node> minList = freqMap.get(minFreq);
                Node evict = minList.removeLast();
                keyMap.remove(evict.key);
                if (minList.isEmpty()) freqMap.remove(minFreq);
            }
            Node newNode = new Node(key, value);
            keyMap.put(key, newNode);
            freqMap.computeIfAbsent(1, k -> new LinkedList<>()).addFirst(newNode);
            minFreq = 1;
        }
    }
    
    private void updateFreq(Node node) {
        int oldFreq = node.freq;
        LinkedList<Node> oldList = freqMap.get(oldFreq);
        oldList.remove(node);  // O(1) if we used a custom DLL; O(n) with java.util.LinkedList
        if (oldList.isEmpty()) {
            freqMap.remove(oldFreq);
            if (minFreq == oldFreq) minFreq++;
        }
        node.freq++;
        freqMap.computeIfAbsent(node.freq, k -> new LinkedList<>()).addFirst(node);
    }
}
```

```
Time:  O(1) for get and put (with custom doubly linked list; O(n) with java.util.LinkedList.remove(Object))
Space: O(capacity)
IMPORTANT: java.util.LinkedList.remove(Object) is O(n) because it searches for the object.
For true O(1), implement a custom doubly linked list where each node has prev/next pointers,
and removal is done by pointer manipulation (like in LRU Cache). The above code uses
java.util.LinkedList for clarity; a production implementation would use a custom DLL.
The minFreq tracking is key: when a new element is inserted, minFreq resets to 1.
When the minFreq list becomes empty after an updateFreq, minFreq increments by 1
(the node that just left was the last one at that frequency).
```

---

## Key Takeaways

1. **Monotonic stacks resolve "next greater/smaller" in O(n).** Each element enters the stack once and leaves once. The pop is not wasted work -- it IS the answer. Store indices, not values, so you can compute distances and look up values. Always use `ArrayDeque`, never `java.util.Stack`.

2. **Monotonic deques extend the pattern to sliding windows.** The deque operates on both ends: the front for window expiration, the back for value dominance. This gives O(1) amortized per window position for sliding max/min queries. The DP + monotonic deque combination handles any recurrence that takes max/min over a window of previous states.

3. **Binary search on answer replaces search-in-data with search-in-answer-space.** The precondition is monotonic feasibility: if X works, X+1 works. "Minimize the maximum" uses `hi = mid`. "Maximize the minimum" uses `lo = mid` with upper-mid `(lo + hi + 1) / 2`. The feasibility check is always a greedy simulation in O(n). Total: O(n log(answer_range)).

4. **Bit manipulation gives O(1)-space solutions where hash-based approaches need O(n).** XOR cancels pairs. `x & (x-1)` clears the lowest set bit. `x & (-x)` isolates it. `Integer.bitCount()` compiles to POPCNT on modern x86. For counting problems across bit positions, process each of the 32 bits independently: contribution = ones x zeros.

5. **Math patterns have closed-form shortcuts that dominate brute force.** GCD in O(log n) via Euclid. Prime sieve in O(n log log n). Modular exponentiation in O(log n). Power-of-prime test in O(1). These are not tricks -- they are fundamental algorithms that appear in cryptography, hashing, and load balancing.

6. **Line sweep converts 2D overlap problems to 1D processing.** Create events at interval boundaries, sort by position, sweep with an active data structure. The difference array is the discrete version: `+1` at start, `-1` at end, prefix sum to reconstruct. TreeMap handles sparse coordinates; arrays handle dense ones.

7. **Design problems combine multiple data structures.** LRU Cache = HashMap + doubly linked list. LFU Cache = two HashMaps + frequency-indexed linked lists. The sentinel node pattern eliminates null checks and simplifies pointer manipulation. In production, use `LinkedHashMap` or Caffeine; in interviews, build from scratch.

8. **Amortized O(n) is the recurring theme.** Monotonic stacks, monotonic deques, and two-pointer techniques all share the same amortized argument: each element participates in a constant number of operations across the entire algorithm. The inner loop may fire multiple times for one iteration, but the total across all iterations is bounded by n.

9. **Recognize the problem shape before choosing the tool.** "Next greater" = monotonic stack. "Sliding window max" = monotonic deque. "Minimize the maximum" = binary search on answer. "Find the unique element" = XOR. "Count overlapping intervals" = line sweep. Pattern recognition is the meta-skill that makes all other skills useful.

10. **Every technique maps to production systems.** Monotonic stacks power financial analysis. Monotonic deques drive real-time monitoring. Binary search on answer solves capacity planning. Bit manipulation underlies permissions, bloom filters, and `EnumSet`. Line sweep drives calendar scheduling and event processing. Design problems ARE the data structures inside your caches and queues. These are not interview tricks -- they are engineering tools.

---

[Previous: Chapter 18 -- Dynamic Programming II: Advanced State Machines](18-dp-advanced-state-machines.md) | [Next: Chapter 20 -- String Algorithms and Pattern Matching](20-string-algorithms-pattern-matching.md)
