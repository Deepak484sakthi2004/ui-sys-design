# Chapter 15: Patterns -- Arrays & Strings

## The Eight Techniques That Solve 80% of Array and String Problems

If you have spent fifteen years building systems, you have already used every technique in this chapter without calling it by name. The moving average in your Grafana dashboard is a fixed-size sliding window. The TCP congestion window that adapts to network conditions is a variable-size sliding window. The `git bisect` you ran last Thursday to find a regression is binary search on an answer space. The `System.arraycopy` that powers your buffer compaction is two-pointer partitioning at the JVM level.

This chapter is about making the implicit explicit. We take eight patterns -- each one a reusable template that maps cleanly to a family of interview problems -- and drill them until recognition is instantaneous. For each pattern, I give you: what it is, how to spot it in an interview, the Java template code you can adapt to any variant, the real-world system it mirrors, and then a set of problems with full solutions.

This is the most problem-dense chapter in the book: 80 problems, each with complete Java solutions, time/space complexity, JVM notes, and real-world correlations. By the end, you will not just "know" sliding window or two pointers -- you will feel which pattern to reach for within the first 30 seconds of reading a problem statement.

A note on how I structured this chapter: the eight patterns are ordered by frequency and difficulty. Sliding window (both variants) and two pointers (both variants) account for roughly half of all array/string interview problems. Prefix sum and binary search cover the next quarter. Kadane's and string matching fill the remainder. Master the first four patterns and you handle most medium-difficulty array problems. Master all eight and hard problems become manageable.

---

## 15.1 Pattern 1: Sliding Window (Fixed Size)

### What It Is

A fixed-size sliding window maintains a contiguous subarray (or substring) of exactly `k` elements and slides it across the array one position at a time. As the window slides right, you add the new element entering the window and remove the element leaving the window. The running computation -- sum, max, frequency count, hash -- updates in O(1) per slide.

```
Array:  [2, 1, 5, 1, 3, 2, 8, 1, 3]     k = 3

Step 0: [2, 1, 5] 1, 3, 2, 8, 1, 3       sum = 8
Step 1:  2,[1, 5, 1] 3, 2, 8, 1, 3        sum = 8 - 2 + 1 = 7
Step 2:  2, 1,[5, 1, 3] 2, 8, 1, 3        sum = 7 - 1 + 3 = 8
Step 3:  2, 1, 5,[1, 3, 2] 8, 1, 3        sum = 8 - 5 + 2 = 6
Step 4:  2, 1, 5, 1,[3, 2, 8] 1, 3        sum = 6 - 1 + 8 = 13
Step 5:  2, 1, 5, 1, 3,[2, 8, 1] 3        sum = 13 - 3 + 1 = 11
Step 6:  2, 1, 5, 1, 3, 2,[8, 1, 3]       sum = 11 - 2 + 3 = 12
```

The key insight is that consecutive windows overlap by `k-1` elements. Recomputing from scratch each time costs O(k) per position, yielding O(n*k) total. Incremental update costs O(1) per position, yielding O(n) total. For k = 100,000 and n = 1,000,000, that is the difference between 100 billion operations and 1 million.

### Recognition Triggers

When you see any of these phrases in a problem, think fixed-size sliding window immediately:

- "subarray of size k" or "contiguous k elements"
- "window of size k"
- "average of every k elements"
- "maximum/minimum of every subarray of size k"
- "find all anagrams" (anagram has a fixed length equal to the pattern)
- "check if string contains a permutation of another string" (permutation has fixed length)

### Template Code

```java
/**
 * Fixed-size sliding window template.
 * 
 * Time:  O(n) — each element enters and leaves the window exactly once
 * Space: O(1) for sum-based windows, O(k) if maintaining a frequency map
 */
public ResultType fixedSlidingWindow(int[] arr, int k) {
    int n = arr.length;
    if (n < k) return /* edge case */;
    
    // Phase 1: Build the first window (indices 0..k-1)
    // Initialize your running computation here
    for (int i = 0; i < k; i++) {
        // Add arr[i] to the window's running state
    }
    // Record result for first window
    
    // Phase 2: Slide the window from index k to n-1
    for (int i = k; i < n; i++) {
        // Add arr[i] (element entering the window from the right)
        // Remove arr[i - k] (element leaving the window from the left)
        // Update result
    }
    
    return result;
}
```

### Real-World Correlations

**TCP fixed congestion window.** In TCP's initial slow-start phase before adaptive congestion control kicks in, the congestion window can be treated as a fixed-size sliding window over segments. The receiver advertises a fixed window size (`rwnd`), and the sender can only have that many unacknowledged bytes in flight. As ACKs arrive, the window slides forward.

**Moving average in monitoring.** Prometheus's `avg_over_time(metric[5m])` computes a moving average over a fixed 5-minute window. Every time a new data point arrives, the oldest data point falls off. This is exactly fixed sliding window with `k` determined by time, not count.

**Ring buffers / circular buffers.** The `ArrayDeque` in the JDK is a circular buffer. When used with a fixed capacity, it is a fixed sliding window over the most recent `k` operations -- exactly how LMAX Disruptor's ring buffer works for inter-thread messaging.

---

### Problems: Sliding Window (Fixed Size)

---

**P15.01** [E] -- Maximum Sum Subarray of Size K

Given an integer array and a positive integer `k`, find the maximum sum of any contiguous subarray of size `k`.

```
Pattern: Fixed sliding window with running sum.
Core idea: Maintain a sum of k elements. Slide right: add new, subtract old. Track max.
```

```java
public int maxSumSubarray(int[] arr, int k) {
    int n = arr.length;
    if (n < k) throw new IllegalArgumentException("Array shorter than k");
    
    // Build first window
    int windowSum = 0;
    for (int i = 0; i < k; i++) {
        windowSum += arr[i];
    }
    int maxSum = windowSum;
    
    // Slide
    for (int i = k; i < n; i++) {
        windowSum += arr[i] - arr[i - k];
        maxSum = Math.max(maxSum, windowSum);
    }
    
    return maxSum;
}
```

```
Time:  O(n) — one pass
Space: O(1)
JVM note: primitive int arithmetic, no boxing. The loop body compiles to roughly
  4 instructions: one iaload for arr[i], one iaload for arr[i-k], one isub+iadd
  for the window update, and a conditional move (cmov) for Math.max.
  C2 will eliminate the bounds checks on arr[i] and arr[i-k] via range check
  elimination since i is bounded by [k, n).
```

---

**P15.02** [E] -- Average of All Subarrays of Size K

Given an array, find the average of all contiguous subarrays of size `k`.

```
Pattern: Fixed sliding window with running sum, divide by k at each position.
```

```java
public double[] findAverages(int[] arr, int k) {
    int n = arr.length;
    double[] result = new double[n - k + 1];
    
    int windowSum = 0;
    for (int i = 0; i < k; i++) {
        windowSum += arr[i];
    }
    result[0] = (double) windowSum / k;
    
    for (int i = k; i < n; i++) {
        windowSum += arr[i] - arr[i - k];
        result[i - k + 1] = (double) windowSum / k;
    }
    
    return result;
}
```

```
Time:  O(n)
Space: O(n - k + 1) for the result array
Real-world: This is exactly what a Prometheus rate() query computes over
  a time window — the average request rate over the last k seconds.
```

---

**P15.03** [M] -- Maximum of All Subarrays of Size K (LeetCode 239)

Given an array and integer `k`, return the max of every contiguous subarray of size `k`. This is the classic "sliding window maximum" problem.

```
Pattern: Fixed sliding window + monotonic deque.
Core idea: A plain sliding window cannot track the max in O(1) because removing
  the leaving element might remove the current max. A monotonic deque solves this:
  maintain elements in decreasing order. The front of the deque is always the max.
```

```java
public int[] maxSlidingWindow(int[] nums, int k) {
    int n = nums.length;
    int[] result = new int[n - k + 1];
    Deque<Integer> deque = new ArrayDeque<>();  // stores indices, not values
    
    for (int i = 0; i < n; i++) {
        // Remove elements outside the current window from the front
        while (!deque.isEmpty() && deque.peekFirst() < i - k + 1) {
            deque.pollFirst();
        }
        
        // Remove elements smaller than nums[i] from the back
        // They can never be the max because nums[i] is larger AND newer
        while (!deque.isEmpty() && nums[deque.peekLast()] < nums[i]) {
            deque.pollLast();
        }
        
        deque.offerLast(i);
        
        // Start recording results once we have a full window
        if (i >= k - 1) {
            result[i - k + 1] = nums[deque.peekFirst()];
        }
    }
    
    return result;
}
```

```
Time:  O(n) — each element enters and leaves the deque at most once
Space: O(k) for the deque
JVM note: ArrayDeque is backed by a circular array (Object[]).
  Each index stored is autoboxed to Integer because ArrayDeque stores Objects.
  For maximum performance, you could use a raw int[] circular buffer to avoid
  Integer boxing — saving 16 bytes per element (the Integer object header).
  For k = 100,000, that is 1.6 MB of avoided garbage.
Real-world: Network quality monitoring — tracking the maximum latency in a
  sliding window of the last k requests. If latency spikes, the window max
  catches it and holds it for k observations before it drops out.
```

---

**P15.04** [M] -- Find All Anagrams in a String (LeetCode 438)

Given a string `s` and a pattern `p`, find all start indices in `s` where an anagram of `p` begins.

```
Pattern: Fixed sliding window of size p.length() with frequency matching.
Core idea: Maintain a frequency count of the current window. Compare with the
  frequency count of p. Instead of comparing two arrays each step (O(26)),
  track how many characters have matching frequencies using a "match" counter.
```

```java
public List<Integer> findAnagrams(String s, String p) {
    List<Integer> result = new ArrayList<>();
    if (s.length() < p.length()) return result;
    
    int[] pCount = new int[26];
    int[] sCount = new int[26];
    
    // Build frequency count for pattern
    for (char c : p.toCharArray()) {
        pCount[c - 'a']++;
    }
    
    int k = p.length();
    
    // Build first window
    for (int i = 0; i < k; i++) {
        sCount[s.charAt(i) - 'a']++;
    }
    if (Arrays.equals(sCount, pCount)) result.add(0);
    
    // Slide
    for (int i = k; i < s.length(); i++) {
        sCount[s.charAt(i) - 'a']++;            // add right
        sCount[s.charAt(i - k) - 'a']--;        // remove left
        if (Arrays.equals(sCount, pCount)) {
            result.add(i - k + 1);
        }
    }
    
    return result;
}
```

The `Arrays.equals` on a 26-element array is O(26) = O(1). But we can optimize further with a match counter:

```java
public List<Integer> findAnagramsOptimized(String s, String p) {
    List<Integer> result = new ArrayList<>();
    if (s.length() < p.length()) return result;
    
    int[] pCount = new int[26];
    int[] sCount = new int[26];
    int k = p.length();
    int matches = 0;  // number of characters with matching frequency
    
    for (char c : p.toCharArray()) pCount[c - 'a']++;
    
    for (int i = 0; i < 26; i++) {
        if (pCount[i] == 0) matches++;  // both are 0 — they match
    }
    
    for (int i = 0; i < s.length(); i++) {
        // Add character entering from the right
        int idx = s.charAt(i) - 'a';
        sCount[idx]++;
        if (sCount[idx] == pCount[idx]) matches++;
        else if (sCount[idx] == pCount[idx] + 1) matches--;  // was matching, now overshot
        
        // Remove character leaving from the left (only after window is full)
        if (i >= k) {
            idx = s.charAt(i - k) - 'a';
            sCount[idx]--;
            if (sCount[idx] == pCount[idx]) matches++;
            else if (sCount[idx] == pCount[idx] - 1) matches--;
        }
        
        if (matches == 26) result.add(i - k + 1);
    }
    
    return result;
}
```

```
Time:  O(n) — O(1) per slide with the match counter
Space: O(1) — two int[26] arrays
JVM note: String.charAt() on a compact string (JDK 9+) is a byte array lookup
  with masking, not a char array lookup. For ASCII strings (Latin1 encoding),
  it is: return (char)(value[index] & 0xFF). No CODER check overhead in the
  hot path because the JIT inlines and specializes based on the string's coder.
Real-world: Plagiarism detection and DNA sequence matching use windowed
  frequency comparison to find approximate matches in long sequences.
```

---

**P15.05** [M] -- Permutation in String (LeetCode 567)

Given two strings `s1` and `s2`, return `true` if `s2` contains a permutation of `s1`.

```
Pattern: Fixed sliding window of size s1.length() over s2. Same as P15.04
  but return true on first match instead of collecting all indices.
```

```java
public boolean checkInclusion(String s1, String s2) {
    if (s1.length() > s2.length()) return false;
    
    int[] count = new int[26];
    int k = s1.length();
    
    // Positive count for s1 chars, negative for s2 window chars
    for (int i = 0; i < k; i++) {
        count[s1.charAt(i) - 'a']++;
        count[s2.charAt(i) - 'a']--;
    }
    if (allZero(count)) return true;
    
    for (int i = k; i < s2.length(); i++) {
        count[s2.charAt(i) - 'a']--;       // add to window
        count[s2.charAt(i - k) - 'a']++;   // remove from window
        if (allZero(count)) return true;
    }
    return false;
}

private boolean allZero(int[] count) {
    for (int c : count) {
        if (c != 0) return false;
    }
    return true;
}
```

```
Time:  O(n) where n = s2.length() — allZero is O(26) = O(1)
Space: O(1)
Key insight: Using a single frequency array (increment for s1, decrement for s2 window)
  instead of two arrays. A permutation exists when all entries are zero.
```

---

**P15.06** [M] -- Dietary Plans: Maximum Calories in K-Day Window

Given a list of daily calorie intakes and a window size `k`, a lower bound, and an upper bound, for each window of `k` days, compute the total calories. If total < lower, the person is under-eating (score -1). If total > upper, over-eating (score +1). Otherwise, score 0. Return the total score.

```
Pattern: Fixed sliding window with running sum and threshold comparison.
```

```java
public int dietPlanPerformance(int[] calories, int k, int lower, int upper) {
    int n = calories.length;
    int score = 0;
    
    int windowSum = 0;
    for (int i = 0; i < k; i++) {
        windowSum += calories[i];
    }
    score += evaluate(windowSum, lower, upper);
    
    for (int i = k; i < n; i++) {
        windowSum += calories[i] - calories[i - k];
        score += evaluate(windowSum, lower, upper);
    }
    
    return score;
}

private int evaluate(int sum, int lower, int upper) {
    if (sum < lower) return -1;
    if (sum > upper) return 1;
    return 0;
}
```

```
Time:  O(n)
Space: O(1)
Real-world: SLA compliance monitoring. In an SLO (Service Level Objective) system,
  you track the error rate over a fixed window. If it exceeds the threshold, you
  burn error budget. This is exactly the same structure — sliding window over
  metrics with threshold comparison.
```

---

**P15.07** [M] -- Maximum Number of Vowels in Substring of Length K (LeetCode 1456)

Given a string `s` and integer `k`, return the maximum number of vowels in any substring of length `k`.

```
Pattern: Fixed sliding window with a character classification counter.
```

```java
public int maxVowels(String s, int k) {
    int vowelCount = 0;
    
    // Build first window
    for (int i = 0; i < k; i++) {
        if (isVowel(s.charAt(i))) vowelCount++;
    }
    int maxVowels = vowelCount;
    
    // Slide
    for (int i = k; i < s.length(); i++) {
        if (isVowel(s.charAt(i))) vowelCount++;
        if (isVowel(s.charAt(i - k))) vowelCount--;
        maxVowels = Math.max(maxVowels, vowelCount);
    }
    
    return maxVowels;
}

private boolean isVowel(char c) {
    return c == 'a' || c == 'e' || c == 'i' || c == 'o' || c == 'u';
}
```

```
Time:  O(n)
Space: O(1)
JVM note: The isVowel method will be inlined by C2. The chain of comparisons
  compiles to a series of cmp/je instructions. An alternative using a boolean
  lookup table (boolean[128]) trades branch misprediction for a memory load —
  generally faster when the character distribution is uniform.
```

---

**P15.08** [E] -- Number of Sub-arrays of Size K with Average >= Threshold (LeetCode 1343)

Given an array, find the number of sub-arrays of size `k` whose average is greater than or equal to a given threshold.

```
Pattern: Fixed sliding window with running sum. Compare sum >= threshold * k
  to avoid floating-point division.
```

```java
public int numOfSubarrays(int[] arr, int k, int threshold) {
    int count = 0;
    int windowSum = 0;
    int target = threshold * k;  // compare sum directly, avoid division
    
    for (int i = 0; i < k; i++) {
        windowSum += arr[i];
    }
    if (windowSum >= target) count++;
    
    for (int i = k; i < arr.length; i++) {
        windowSum += arr[i] - arr[i - k];
        if (windowSum >= target) count++;
    }
    
    return count;
}
```

```
Time:  O(n)
Space: O(1)
Key insight: Multiply threshold by k instead of dividing sum by k. This avoids
  floating-point arithmetic entirely — integer comparison is faster and exact.
  This is a common trick: transform the inequality to avoid division.
```

---

**P15.09** [M] -- Grumpy Bookstore Owner (LeetCode 1052)

A bookstore owner has `customers[i]` customers at minute `i`. The owner is grumpy at minute `i` if `grumpy[i] == 1`. When grumpy, those customers are unsatisfied. The owner can use a technique to suppress grumpiness for `k` consecutive minutes. Find the maximum number of satisfied customers.

```
Pattern: Fixed sliding window over the "grumpy gain" — the additional customers
  saved by suppressing grumpiness in that window.
```

```java
public int maxSatisfied(int[] customers, int[] grumpy, int k) {
    int n = customers.length;
    
    // Count already-satisfied customers (when owner is not grumpy)
    int baseSatisfied = 0;
    for (int i = 0; i < n; i++) {
        if (grumpy[i] == 0) baseSatisfied += customers[i];
    }
    
    // Sliding window of size k: count extra customers saved by suppressing grumpiness
    int extraSaved = 0;
    for (int i = 0; i < k; i++) {
        if (grumpy[i] == 1) extraSaved += customers[i];
    }
    int maxExtraSaved = extraSaved;
    
    for (int i = k; i < n; i++) {
        if (grumpy[i] == 1) extraSaved += customers[i];
        if (grumpy[i - k] == 1) extraSaved -= customers[i - k];
        maxExtraSaved = Math.max(maxExtraSaved, extraSaved);
    }
    
    return baseSatisfied + maxExtraSaved;
}
```

```
Time:  O(n)
Space: O(1)
Key insight: Decompose into base (non-grumpy customers, always satisfied) plus
  the best window of size k over the "recoverable" grumpy customers. This
  separation simplifies the problem — you only window over the grumpy minutes.
Real-world: Feature flag rollout windows. "We can enable a risky feature for k
  consecutive minutes — which k-minute window captures the most traffic?"
```

---

**P15.10** [H] -- Substring with Concatenation of All Words (LeetCode 30)

Given a string `s` and an array of words (all the same length), find all starting indices in `s` of substrings that are a concatenation of all words in any order.

```
Pattern: Fixed sliding window of total length = numWords * wordLen, sliced into
  word-sized chunks. Use a word frequency map.
```

```java
public List<Integer> findSubstring(String s, String[] words) {
    List<Integer> result = new ArrayList<>();
    if (s.isEmpty() || words.length == 0) return result;
    
    int wordLen = words[0].length();
    int numWords = words.length;
    int windowLen = wordLen * numWords;
    
    if (s.length() < windowLen) return result;
    
    // Build target frequency map
    Map<String, Integer> targetFreq = new HashMap<>();
    for (String w : words) {
        targetFreq.merge(w, 1, Integer::sum);
    }
    
    // Try all starting offsets within a word-length span
    for (int offset = 0; offset < wordLen; offset++) {
        Map<String, Integer> windowFreq = new HashMap<>();
        int matched = 0;
        
        for (int i = offset; i + wordLen <= s.length(); i += wordLen) {
            // Add word entering from the right
            String word = s.substring(i, i + wordLen);
            windowFreq.merge(word, 1, Integer::sum);
            if (windowFreq.get(word).equals(targetFreq.get(word))) matched++;
            else if (windowFreq.get(word).equals(targetFreq.getOrDefault(word, 0) + 1)) matched--;
            
            // Remove word leaving from the left (when window exceeds size)
            int windowStart = i - windowLen + wordLen;
            if (windowStart >= offset) {
                String leftWord = s.substring(windowStart - wordLen + offset, windowStart + offset);
                // Recalculate: the left boundary of the window
            }
            
            // Simplified: after we have numWords words in the window, remove leftmost
            int wordsInWindow = (i - offset) / wordLen + 1;
            if (wordsInWindow > numWords) {
                int removeIdx = i - windowLen;
                String removed = s.substring(removeIdx, removeIdx + wordLen);
                if (windowFreq.get(removed).equals(targetFreq.getOrDefault(removed, 0))) matched--;
                windowFreq.merge(removed, -1, Integer::sum);
                if (windowFreq.get(removed) == 0) windowFreq.remove(removed);
                else if (windowFreq.get(removed).equals(targetFreq.get(removed))) matched++;
            }
            
            if (wordsInWindow >= numWords && matched == targetFreq.size()) {
                result.add(i - windowLen + wordLen);
            }
        }
    }
    
    return result;
}
```

Here is the cleaner implementation:

```java
public List<Integer> findSubstring(String s, String[] words) {
    List<Integer> result = new ArrayList<>();
    int wordLen = words[0].length();
    int numWords = words.length;
    int totalLen = wordLen * numWords;
    if (s.length() < totalLen) return result;
    
    Map<String, Integer> target = new HashMap<>();
    for (String w : words) target.merge(w, 1, Integer::sum);
    
    for (int offset = 0; offset < wordLen; offset++) {
        Map<String, Integer> window = new HashMap<>();
        int count = 0;  // words in current window
        
        for (int right = offset; right + wordLen <= s.length(); right += wordLen) {
            String w = s.substring(right, right + wordLen);
            window.merge(w, 1, Integer::sum);
            count++;
            
            // Shrink from left if window has too many words
            while (window.getOrDefault(w, 0) > target.getOrDefault(w, 0)) {
                int left = right - (count - 1) * wordLen;
                String lw = s.substring(left, left + wordLen);
                window.merge(lw, -1, Integer::sum);
                if (window.get(lw) == 0) window.remove(lw);
                count--;
            }
            
            if (count == numWords) {
                result.add(right - (numWords - 1) * wordLen);
            }
        }
    }
    return result;
}
```

```
Time:  O(n * wordLen) — we try wordLen offsets, each processes n/wordLen words
Space: O(numWords * wordLen) for the frequency maps
Key insight: By iterating with step size wordLen from each offset in [0, wordLen),
  we reduce this to a standard sliding window over word-sized chunks. The offset
  loop handles all possible alignments.
JVM note: String.substring() since JDK 7u6 creates a new backing array (no sharing).
  For very long strings, this creates O(n/wordLen) String objects per offset.
  To avoid GC pressure, you could compare using charAt ranges or precompute hashes.
```

---

## 15.2 Pattern 2: Sliding Window (Variable Size)

### What It Is

A variable-size sliding window does not have a predetermined width. Instead, you expand the window by moving the right pointer until some condition is satisfied (or violated), then shrink the window by moving the left pointer until the condition is restored (or re-violated). The window grows and shrinks dynamically.

```
Template structure:

left = 0
for right = 0 to n-1:
    add arr[right] to window state
    while window violates condition:
        remove arr[left] from window state
        left++
    update answer (window [left..right] satisfies condition)
```

The guarantee is that both `left` and `right` move only forward, so the total work across all iterations is O(n), not O(n^2). Each element is added once (when `right` passes over it) and removed at most once (when `left` passes over it).

### Recognition Triggers

- "minimum/shortest subarray/substring satisfying X"
- "longest/maximum subarray/substring satisfying X"
- "subarray with sum >= S" (variable because you do not know the length in advance)
- "at most K distinct characters"
- "longest without repeating"
- "minimum window containing all characters of T"

The key distinction from fixed window: you do not know the window size in advance. It depends on the data.

### Two Sub-patterns

**Shrink-to-satisfy (find minimum window):**
Expand right until condition IS met, then shrink left to find the smallest window that still meets it. Track the minimum.

**Expand-to-violate (find maximum window):**
Expand right freely. When condition is BROKEN, shrink left until condition is restored. Track the maximum.

### Template Code

```java
/**
 * Variable sliding window — find minimum window satisfying condition.
 * 
 * Time:  O(n) — left and right each move at most n times total
 * Space: depends on the condition tracking data structure
 */
public int minWindowSatisfying(int[] arr) {
    int left = 0;
    int minLen = Integer.MAX_VALUE;
    // initialize window state
    
    for (int right = 0; right < arr.length; right++) {
        // expand: add arr[right] to window state
        
        while (/* condition is satisfied */) {
            // record answer: window [left..right]
            minLen = Math.min(minLen, right - left + 1);
            // shrink: remove arr[left] from window state
            left++;
        }
    }
    return minLen == Integer.MAX_VALUE ? -1 : minLen;
}

/**
 * Variable sliding window — find maximum window satisfying condition.
 */
public int maxWindowSatisfying(int[] arr) {
    int left = 0;
    int maxLen = 0;
    // initialize window state
    
    for (int right = 0; right < arr.length; right++) {
        // expand: add arr[right] to window state
        
        while (/* condition is violated */) {
            // shrink: remove arr[left] from window state
            left++;
        }
        // window [left..right] satisfies condition
        maxLen = Math.max(maxLen, right - left + 1);
    }
    return maxLen;
}
```

### Real-World Correlations

**TCP sliding window (variable).** TCP's actual congestion window is variable-size. During slow start, it doubles each RTT. During congestion avoidance, it grows linearly. When packet loss is detected, it shrinks. The window expands to maximize throughput and shrinks when the network signals congestion -- exactly the expand/shrink pattern.

**Rate limiting windows.** A sliding window rate limiter tracks requests in a time window. If the count exceeds the limit, the window shrinks (older requests expire) until the rate drops below the threshold. Redis's sliding window rate limiter (`ZRANGEBYSCORE` with timestamps) is this pattern.

**Connection pool sizing.** A dynamic connection pool (e.g., HikariCP) expands when demand increases and shrinks during idle periods. The "window" is the active connection set, sized by load.

---

### Problems: Sliding Window (Variable Size)

---

**P15.11** [H] -- Minimum Window Substring (LeetCode 76)

Given strings `s` and `t`, find the minimum window in `s` that contains all characters of `t`.

```
Pattern: Variable sliding window, shrink-to-satisfy.
Core idea: Expand right until all characters of t are covered. Then shrink left
  to minimize the window. Track the minimum valid window.
```

```java
public String minWindow(String s, String t) {
    if (s.length() < t.length()) return "";
    
    int[] need = new int[128];    // characters needed from t
    int[] have = new int[128];    // characters in current window
    
    for (char c : t.toCharArray()) need[c]++;
    
    int required = 0;  // distinct characters needed
    for (int n : need) if (n > 0) required++;
    
    int formed = 0;    // distinct characters with sufficient count
    int left = 0;
    int minLen = Integer.MAX_VALUE;
    int minStart = 0;
    
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        have[c]++;
        
        if (need[c] > 0 && have[c] == need[c]) {
            formed++;
        }
        
        // Shrink from left while window still contains all of t
        while (formed == required) {
            // Update minimum
            if (right - left + 1 < minLen) {
                minLen = right - left + 1;
                minStart = left;
            }
            
            // Remove leftmost character
            char leftChar = s.charAt(left);
            have[leftChar]--;
            if (need[leftChar] > 0 && have[leftChar] < need[leftChar]) {
                formed--;
            }
            left++;
        }
    }
    
    return minLen == Integer.MAX_VALUE ? "" : s.substring(minStart, minStart + minLen);
}
```

```
Time:  O(|s| + |t|) — each character added/removed once
Space: O(1) — two int[128] arrays (constant for ASCII)
JVM note: Using int[128] instead of HashMap<Character, Integer> avoids boxing.
  Each HashMap entry costs ~48 bytes (Entry object + Integer key + Integer value).
  With 128 possible characters, HashMap could consume 6 KB vs. 1 KB for int[128].
  More critically, int[] access is a single instruction with no pointer chasing,
  while HashMap.get() involves hashCode(), bucket lookup, and equals().
Real-world: Network packet reassembly — find the minimum contiguous sequence of
  fragments that completes a full packet.
```

---

**P15.12** [M] -- Longest Substring Without Repeating Characters (LeetCode 3)

Find the length of the longest substring without repeating characters.

```
Pattern: Variable sliding window, expand-to-violate.
Core idea: Expand right. When a duplicate is found, shrink left past the previous
  occurrence of the duplicate character.
```

```java
public int lengthOfLongestSubstring(String s) {
    int[] lastSeen = new int[128];  // last index + 1 of each character
    Arrays.fill(lastSeen, 0);       // 0 means "not seen" (1-indexed internally)
    
    int maxLen = 0;
    int left = 0;
    
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        
        // If c was seen and its last position is within the current window
        if (lastSeen[c] > left) {
            left = lastSeen[c];  // jump left past the previous occurrence
        }
        
        lastSeen[c] = right + 1;  // store 1-indexed position
        maxLen = Math.max(maxLen, right - left + 1);
    }
    
    return maxLen;
}
```

```
Time:  O(n) — single pass, no inner while loop because we jump left directly
Space: O(1) — int[128]
Key insight: Instead of shrinking left one step at a time, we jump left directly
  to the position after the last occurrence of the duplicate. This avoids the
  while loop entirely — still O(n) but with a smaller constant factor.
JVM note: The int[128] array is 528 bytes (16-byte header + 128 * 4 bytes).
  It fits comfortably in L1 cache (typically 32-64 KB), so every access is
  a cache hit. Compare with HashSet<Character> where every contains() call
  involves hashCode(), boxing, and pointer chasing.
```

---

**P15.13** [M] -- Longest Substring with At Most K Distinct Characters (LeetCode 340)

Find the length of the longest substring with at most `k` distinct characters.

```
Pattern: Variable sliding window, expand-to-violate.
Core idea: Expand right freely. When distinct character count exceeds k,
  shrink left until it drops back to k.
```

```java
public int lengthOfLongestSubstringKDistinct(String s, int k) {
    if (k == 0) return 0;
    
    int[] freq = new int[128];
    int distinct = 0;
    int left = 0;
    int maxLen = 0;
    
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        if (freq[c] == 0) distinct++;
        freq[c]++;
        
        while (distinct > k) {
            char leftChar = s.charAt(left);
            freq[leftChar]--;
            if (freq[leftChar] == 0) distinct--;
            left++;
        }
        
        maxLen = Math.max(maxLen, right - left + 1);
    }
    
    return maxLen;
}
```

```
Time:  O(n) — left and right each advance at most n times
Space: O(1) — int[128]
Real-world: Log stream partitioning. Given a stream of log entries from different
  services, find the longest continuous sequence that comes from at most k
  distinct services — useful for detecting "burst" periods where a small number
  of services dominate.
```

---

**P15.14** [M] -- Minimum Size Subarray Sum (LeetCode 209)

Given a positive integer array and a target sum, find the minimal length of a contiguous subarray whose sum is >= target. Return 0 if no such subarray exists.

```
Pattern: Variable sliding window, shrink-to-satisfy.
Core idea: Expand right until sum >= target. Shrink left to minimize the window.
```

```java
public int minSubArrayLen(int target, int[] nums) {
    int left = 0;
    int sum = 0;
    int minLen = Integer.MAX_VALUE;
    
    for (int right = 0; right < nums.length; right++) {
        sum += nums[right];
        
        while (sum >= target) {
            minLen = Math.min(minLen, right - left + 1);
            sum -= nums[left];
            left++;
        }
    }
    
    return minLen == Integer.MAX_VALUE ? 0 : minLen;
}
```

```
Time:  O(n)
Space: O(1)
Key insight: This only works because all elements are positive. If elements could
  be negative, expanding right might decrease the sum, breaking the monotonicity
  that the sliding window relies on. For arrays with negatives, use prefix sum
  + binary search (O(n log n)) or prefix sum + sorted set.
```

---

**P15.15** [M] -- Max Consecutive Ones III (LeetCode 1004)

Given a binary array and integer `k`, find the maximum number of consecutive 1s if you can flip at most `k` 0s.

```
Pattern: Variable sliding window, expand-to-violate.
Core idea: Rephrase: find the longest subarray with at most k zeros.
```

```java
public int longestOnes(int[] nums, int k) {
    int left = 0;
    int zeroCount = 0;
    int maxLen = 0;
    
    for (int right = 0; right < nums.length; right++) {
        if (nums[right] == 0) zeroCount++;
        
        while (zeroCount > k) {
            if (nums[left] == 0) zeroCount--;
            left++;
        }
        
        maxLen = Math.max(maxLen, right - left + 1);
    }
    
    return maxLen;
}
```

```
Time:  O(n)
Space: O(1)
Key insight: The reframing is everything. "Flip at most k zeros" becomes "window
  with at most k zeros." This is a pattern: many problems disguise a sliding
  window condition behind a transformation or operation count.
```

---

**P15.16** [M] -- Fruit Into Baskets (LeetCode 904)

You have a row of fruit trees. Each tree produces one type of fruit. You have two baskets, each can hold one type. Starting from any tree, collect fruit moving right. You must stop when you encounter a third type. Find the maximum number of fruits.

```
Pattern: Longest subarray with at most 2 distinct values.
This is exactly P15.13 with k = 2.
```

```java
public int totalFruit(int[] fruits) {
    int[] freq = new int[40001];  // fruit type range per constraints
    int distinct = 0;
    int left = 0;
    int maxLen = 0;
    
    for (int right = 0; right < fruits.length; right++) {
        if (freq[fruits[right]] == 0) distinct++;
        freq[fruits[right]]++;
        
        while (distinct > 2) {
            freq[fruits[left]]--;
            if (freq[fruits[left]] == 0) distinct--;
            left++;
        }
        
        maxLen = Math.max(maxLen, right - left + 1);
    }
    
    return maxLen;
}
```

```
Time:  O(n)
Space: O(1) given the constraint on fruit types
Key insight: Once you recognize this as "at most 2 distinct," the code is
  identical to the K distinct template. Interview success often depends on
  this recognition speed, not coding speed.
```

---

**P15.17** [M] -- Longest Repeating Character Replacement (LeetCode 424)

Given a string and integer `k`, find the length of the longest substring where you can replace at most `k` characters to make all characters the same.

```
Pattern: Variable sliding window. The key invariant: window_size - max_freq <= k.
Core idea: In a valid window, the number of characters that differ from the
  most frequent character must be <= k (those are the ones we replace).
```

```java
public int characterReplacement(String s, int k) {
    int[] freq = new int[26];
    int left = 0;
    int maxFreq = 0;  // max frequency of any single character in current window
    int maxLen = 0;
    
    for (int right = 0; right < s.length(); right++) {
        freq[s.charAt(right) - 'A']++;
        maxFreq = Math.max(maxFreq, freq[s.charAt(right) - 'A']);
        
        // Window is invalid if characters to replace > k
        while ((right - left + 1) - maxFreq > k) {
            freq[s.charAt(left) - 'A']--;
            left++;
        }
        
        maxLen = Math.max(maxLen, right - left + 1);
    }
    
    return maxLen;
}
```

```
Time:  O(n)
Space: O(1) — int[26]
Subtle point: We do NOT update maxFreq when shrinking. maxFreq might be stale
  (too high) after removing the left character. But that is fine — a stale maxFreq
  only means the window will not shrink MORE than needed. The window can only grow
  when a new maxFreq is found, which means a genuinely better answer.
  This is a well-known optimization: maxFreq is monotonically non-decreasing
  across the algorithm. It never needs to decrease because we are looking for
  the MAXIMUM window — we would never want to shrink maxFreq below its peak.
```

---

**P15.18** [H] -- Subarrays with K Different Integers (LeetCode 992)

Given an integer array and integer `k`, return the number of contiguous subarrays with exactly `k` distinct integers.

```
Pattern: exactly(k) = atMost(k) - atMost(k-1).
Core idea: Counting "exactly k" with a sliding window is hard because a valid
  window can spawn multiple valid sub-windows. But "at most k" is easy (P15.13).
  The identity exactly(k) = atMost(k) - atMost(k-1) reduces the hard problem to
  two easy problems.
```

```java
public int subarraysWithKDistinct(int[] nums, int k) {
    return atMost(nums, k) - atMost(nums, k - 1);
}

private int atMost(int[] nums, int k) {
    int[] freq = new int[nums.length + 1];  // values are in [1, nums.length]
    int distinct = 0;
    int left = 0;
    int count = 0;
    
    for (int right = 0; right < nums.length; right++) {
        if (freq[nums[right]] == 0) distinct++;
        freq[nums[right]]++;
        
        while (distinct > k) {
            freq[nums[left]]--;
            if (freq[nums[left]] == 0) distinct--;
            left++;
        }
        
        // Every subarray ending at right with start in [left, right] is valid
        count += right - left + 1;
    }
    
    return count;
}
```

```
Time:  O(n) — two passes of atMost, each O(n)
Space: O(n) for the frequency array (values bounded by n)
Key insight: The "exactly k = atMost k - atMost (k-1)" trick is one of the
  most powerful reductions in sliding window problems. Memorize it.
  It works because every subarray with at most k distinct integers either has
  at most k-1 distinct integers (counted in both terms, cancels out) or has
  exactly k distinct integers (counted only in the first term, survives).
Real-world: Network flow analysis — counting the number of time intervals with
  traffic from exactly k distinct source IPs (for anomaly detection).
```

---

## 15.3 Pattern 3: Two Pointers (Opposite Direction)

### What It Is

Two pointers start at opposite ends of an array (or opposite sides of a search space) and move toward each other based on a comparison or condition. The left pointer moves right when the combined state is "too small" and the right pointer moves left when the combined state is "too large."

```
left = 0, right = n - 1

while left < right:
    compute = f(arr[left], arr[right])
    if compute matches target: record answer
    if compute is too small: left++    (need larger values)
    if compute is too large: right--   (need smaller values)
```

The critical requirement: the array must be sorted (or have some monotonic property) so that moving a pointer predictably changes the computed value in one direction. Without this monotonicity, you cannot reason about which pointer to move.

### Recognition Triggers

- "sorted array" + "pair with sum/difference"
- "two numbers that add to target" (if sorted -- otherwise use hash map)
- "container with most water" or "trapping rain water" (implicit monotonic structure)
- "palindrome checking" (compare from both ends)
- any problem that asks about pairs where you can exploit sorted order

### Template Code

```java
/**
 * Two pointers — opposite direction template.
 * Prerequisite: array is sorted (or has monotonic property).
 * 
 * Time:  O(n) — each pointer moves at most n times total
 * Space: O(1)
 */
public ResultType twoPointersOpposite(int[] arr, int target) {
    int left = 0, right = arr.length - 1;
    
    while (left < right) {
        int current = arr[left] + arr[right];  // or some function of both
        
        if (current == target) {
            // found a match
            // decide: return immediately, or move both pointers to find more
            left++;
            right--;
        } else if (current < target) {
            left++;      // need a larger sum → move left pointer right
        } else {
            right--;     // need a smaller sum → move right pointer left
        }
    }
    
    return result;
}
```

### Real-World Correlations

**Binary search is a special case.** Binary search uses left and right pointers moving toward each other, with the midpoint determining which pointer moves. It is two-pointer opposite direction where the "computed value" is `arr[mid]`.

**Memory compaction (two-pointer defragmentation).** The JVM's G1 GC compaction phase uses a technique analogous to opposite-direction two pointers: one pointer scans from the bottom of a region looking for live objects to move, another scans from the top looking for free space to move them into. They converge in the middle.

**Merge in merge sort.** The merge step of merge sort uses two pointers, each starting at the beginning of a half. But the "two pointers sorted" pattern in interviews typically means opposite-direction on a single array.

---

### Problems: Two Pointers (Opposite Direction)

---

**P15.19** [M] -- Two Sum II - Sorted Array (LeetCode 167)

Given a 1-indexed sorted array, find two numbers that add to a target. Return their indices.

```
Pattern: Two pointers from opposite ends. Move left if sum too small, right if too large.
```

```java
public int[] twoSum(int[] numbers, int target) {
    int left = 0, right = numbers.length - 1;
    
    while (left < right) {
        int sum = numbers[left] + numbers[right];
        if (sum == target) {
            return new int[]{left + 1, right + 1};  // 1-indexed
        } else if (sum < target) {
            left++;
        } else {
            right--;
        }
    }
    
    throw new IllegalArgumentException("No solution");
}
```

```
Time:  O(n)
Space: O(1)
Why it works: If sum < target, moving left forward increases the sum (array is sorted,
  so arr[left+1] >= arr[left]). Moving right backward would decrease the sum further.
  Symmetrically for sum > target. This greedy narrowing is correct because it never
  skips a valid pair.
Proof sketch: Assume the answer is (i, j) with i < j. At some point the pointers are
  at positions where left <= i and right >= j. If sum is too small, left moves right;
  since left <= i, it will eventually reach i. If sum is too large, right moves left;
  since right >= j, it will eventually reach j. The pointers converge on (i, j).
```

---

**P15.20** [M] -- 3Sum (LeetCode 15)

Find all unique triplets in the array that sum to zero.

```
Pattern: Sort + fix one element + two-pointer on the remaining sorted subarray.
Core idea: For each arr[i], find pairs in arr[i+1..n-1] that sum to -arr[i].
  Skip duplicates to avoid duplicate triplets.
```

```java
public List<List<Integer>> threeSum(int[] nums) {
    List<List<Integer>> result = new ArrayList<>();
    Arrays.sort(nums);  // O(n log n)
    
    for (int i = 0; i < nums.length - 2; i++) {
        // Skip duplicate first elements
        if (i > 0 && nums[i] == nums[i - 1]) continue;
        
        // Early termination: if smallest possible sum > 0, done
        if (nums[i] > 0) break;
        
        int target = -nums[i];
        int left = i + 1, right = nums.length - 1;
        
        while (left < right) {
            int sum = nums[left] + nums[right];
            if (sum == target) {
                result.add(Arrays.asList(nums[i], nums[left], nums[right]));
                // Skip duplicates
                while (left < right && nums[left] == nums[left + 1]) left++;
                while (left < right && nums[right] == nums[right - 1]) right--;
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
```

```
Time:  O(n^2) — outer loop O(n), inner two-pointer O(n)
Space: O(1) excluding the result (sorting is in-place for primitives)
JVM note: Arrays.sort(int[]) uses dual-pivot quicksort (JDK 14+).
  For nearly-sorted arrays, it detects runs and uses insertion sort —
  an adaptive strategy that approaches O(n) for partially ordered data.
  The constant factor is excellent because it operates on a contiguous int[].
Key insight: Duplicate skipping is critical. Without it, you get duplicate
  triplets. The pattern is always: skip if current == previous (for the outer
  loop) and skip consecutive equal values in the inner loop after finding a match.
```

---

**P15.21** [M] -- 4Sum (LeetCode 18)

Find all unique quadruplets that sum to a target.

```
Pattern: Sort + fix two elements + two-pointer on the rest. Generalization of 3Sum.
```

```java
public List<List<Integer>> fourSum(int[] nums, int target) {
    List<List<Integer>> result = new ArrayList<>();
    Arrays.sort(nums);
    int n = nums.length;
    
    for (int i = 0; i < n - 3; i++) {
        if (i > 0 && nums[i] == nums[i - 1]) continue;
        
        // Pruning: min possible sum with this i
        if ((long) nums[i] + nums[i+1] + nums[i+2] + nums[i+3] > target) break;
        // Pruning: max possible sum with this i
        if ((long) nums[i] + nums[n-1] + nums[n-2] + nums[n-3] < target) continue;
        
        for (int j = i + 1; j < n - 2; j++) {
            if (j > i + 1 && nums[j] == nums[j - 1]) continue;
            
            // Same pruning for j
            if ((long) nums[i] + nums[j] + nums[j+1] + nums[j+2] > target) break;
            if ((long) nums[i] + nums[j] + nums[n-1] + nums[n-2] < target) continue;
            
            long remaining = (long) target - nums[i] - nums[j];
            int left = j + 1, right = n - 1;
            
            while (left < right) {
                long sum = nums[left] + nums[right];
                if (sum == remaining) {
                    result.add(Arrays.asList(nums[i], nums[j], nums[left], nums[right]));
                    while (left < right && nums[left] == nums[left + 1]) left++;
                    while (left < right && nums[right] == nums[right - 1]) right--;
                    left++;
                    right--;
                } else if (sum < remaining) {
                    left++;
                } else {
                    right--;
                }
            }
        }
    }
    
    return result;
}
```

```
Time:  O(n^3) — two nested loops + two-pointer
Space: O(1) excluding result
Key insight: The pruning bounds (checking min/max possible sums) dramatically
  reduce the constant factor. In practice, these early exits skip most iterations.
  Note the use of (long) casts — integer overflow is a real danger when summing
  four ints. The maximum sum of four ints is ~8.5 billion, well beyond int range.
```

---

**P15.22** [M] -- Container With Most Water (LeetCode 11)

Given heights, find two lines that together with the x-axis form a container holding the most water.

```
Pattern: Two pointers from opposite ends. Greedy: move the shorter line inward.
Core idea: Water = min(height[left], height[right]) * (right - left).
  Moving the taller line inward can only decrease width without increasing height.
  Moving the shorter line inward might find a taller line, potentially increasing area.
```

```java
public int maxArea(int[] height) {
    int left = 0, right = height.length - 1;
    int maxWater = 0;
    
    while (left < right) {
        int width = right - left;
        int h = Math.min(height[left], height[right]);
        maxWater = Math.max(maxWater, width * h);
        
        if (height[left] < height[right]) {
            left++;
        } else {
            right--;
        }
    }
    
    return maxWater;
}
```

```
Time:  O(n)
Space: O(1)
Why greedy works: If height[left] < height[right], then for ANY position right' < right,
  the area with (left, right') <= area with (left, right). Because:
  1. Width decreases: right' - left < right - left
  2. Height is bounded by min(height[left], height[right']) <= height[left]
  So the area can only decrease or stay the same. Therefore, left is the bottleneck,
  and moving left is the only way to potentially improve. QED.
Real-world: Resource capacity planning. Given two service components with different
  throughputs, the system throughput is limited by the weaker component (like water
  limited by the shorter wall). You want to find the pair that maximizes throughput.
```

---

**P15.23** [H] -- Trapping Rain Water (LeetCode 42)

Given elevation heights, compute how much rain water can be trapped.

```
Pattern: Two pointers from opposite ends, tracking left_max and right_max.
Core idea: Water at position i = min(max_left, max_right) - height[i].
  With two pointers, we can compute this without precomputing max arrays.
```

```java
public int trap(int[] height) {
    int left = 0, right = height.length - 1;
    int leftMax = 0, rightMax = 0;
    int water = 0;
    
    while (left < right) {
        if (height[left] < height[right]) {
            // Right side has a taller (or equal) bar somewhere.
            // So the water at left is determined by leftMax.
            if (height[left] >= leftMax) {
                leftMax = height[left];
            } else {
                water += leftMax - height[left];
            }
            left++;
        } else {
            // Left side has a taller (or equal) bar somewhere.
            if (height[right] >= rightMax) {
                rightMax = height[right];
            } else {
                water += rightMax - height[right];
            }
            right--;
        }
    }
    
    return water;
}
```

```
Time:  O(n)
Space: O(1)
Why it works: When height[left] < height[right], we know that the maximum height
  on the right side of left is at least height[right] (it might be higher further
  in, but it is at least this). Therefore, the water at left is determined by
  leftMax (not rightMax), because leftMax <= height[right] <= rightMax.
  So we can safely process left.
Alternative approaches:
  - Prefix max arrays: precompute leftMax[i] and rightMax[i]. O(n) time, O(n) space.
  - Monotonic stack: process bars, pop when we find a taller bar. O(n) time, O(n) space.
  The two-pointer approach achieves O(n) time with O(1) space — strictly optimal.
Real-world: Buffer space allocation. In a pipeline of processing stages with varying
  throughput, the "trapped water" represents the buffer capacity needed between stages.
```

---

**P15.24** [E] -- Valid Palindrome (LeetCode 125)

Given a string, determine if it is a palindrome considering only alphanumeric characters, ignoring case.

```
Pattern: Two pointers from opposite ends, skip non-alphanumeric, compare case-insensitively.
```

```java
public boolean isPalindrome(String s) {
    int left = 0, right = s.length() - 1;
    
    while (left < right) {
        // Skip non-alphanumeric from left
        while (left < right && !Character.isLetterOrDigit(s.charAt(left))) {
            left++;
        }
        // Skip non-alphanumeric from right
        while (left < right && !Character.isLetterOrDigit(s.charAt(right))) {
            right--;
        }
        
        if (Character.toLowerCase(s.charAt(left)) != Character.toLowerCase(s.charAt(right))) {
            return false;
        }
        left++;
        right--;
    }
    
    return true;
}
```

```
Time:  O(n)
Space: O(1)
JVM note: Character.isLetterOrDigit() and Character.toLowerCase() are JDK
  intrinsic candidates. C2 can inline these for ASCII-range characters into
  simple range checks: (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9').
  For non-ASCII (Unicode), it falls back to table lookup. If you know the input
  is ASCII, manual range checks avoid the Unicode code path entirely.
```

---

**P15.25** [E] -- Reverse String (LeetCode 344)

Reverse a character array in place.

```
Pattern: Two pointers from opposite ends, swap.
```

```java
public void reverseString(char[] s) {
    int left = 0, right = s.length - 1;
    while (left < right) {
        char tmp = s[left];
        s[left] = s[right];
        s[right] = tmp;
        left++;
        right--;
    }
}
```

```
Time:  O(n)
Space: O(1)
JVM note: This is the simplest possible swap loop. C2 may vectorize this using
  SIMD instructions (SSE/AVX) on modern hardware, processing multiple character
  swaps per cycle. The access pattern is sequential from both ends, so L1 cache
  prefetchers handle it efficiently.
```

---

**P15.26** [M] -- Sort Colors / Dutch National Flag (LeetCode 75)

Given an array with values 0, 1, 2, sort it in-place in one pass.

```
Pattern: Three-way partition using three pointers (variant of two-pointer).
  Dijkstra's Dutch National Flag algorithm.
```

```java
public void sortColors(int[] nums) {
    int lo = 0;              // next position for 0
    int hi = nums.length - 1; // next position for 2
    int mid = 0;             // current element
    
    while (mid <= hi) {
        if (nums[mid] == 0) {
            swap(nums, lo, mid);
            lo++;
            mid++;
        } else if (nums[mid] == 2) {
            swap(nums, mid, hi);
            hi--;
            // Do NOT increment mid — the swapped element needs inspection
        } else {
            mid++;  // nums[mid] == 1, already in correct region
        }
    }
}

private void swap(int[] nums, int i, int j) {
    int tmp = nums[i];
    nums[i] = nums[j];
    nums[j] = tmp;
}
```

```
Time:  O(n) — single pass
Space: O(1)
Why mid does not advance when swapping with hi: The element swapped from hi to mid
  is unknown — it could be 0, 1, or 2 — and must be inspected. But when swapping
  with lo, the element swapped from lo to mid is either 0 or 1 (because lo <= mid,
  and everything before mid has already been processed). If it is 1, mid can advance.
  If it is 0... it cannot be 0, because lo would have already moved past it.
  So the swapped element is always 1, and mid can advance.
Real-world: This is the partitioning step of three-way quicksort, used by
  Arrays.sort(int[]) when there are many duplicate keys. Dual-pivot quicksort
  in the JDK generalizes this to two pivots and five regions.
```

---

**P15.27** [M] -- Two Sum Less Than K (LeetCode 1099)

Given an array and integer `k`, find the maximum sum of a pair `(arr[i] + arr[j])` that is strictly less than `k`.

```
Pattern: Sort + two pointers from opposite ends. Track the maximum sum < k.
```

```java
public int twoSumLessThanK(int[] arr, int k) {
    Arrays.sort(arr);
    int left = 0, right = arr.length - 1;
    int maxSum = -1;
    
    while (left < right) {
        int sum = arr[left] + arr[right];
        if (sum < k) {
            maxSum = Math.max(maxSum, sum);
            left++;
        } else {
            right--;
        }
    }
    
    return maxSum;
}
```

```
Time:  O(n log n) for sort + O(n) for two pointers
Space: O(1) in-place sort
```

---

## 15.4 Pattern 4: Two Pointers (Same Direction / Fast-Slow)

### What It Is

Two pointers move in the same direction through the array, but at different speeds or under different conditions. The "slow" pointer marks a boundary (e.g., the end of the "processed" region), while the "fast" pointer scans ahead. When the fast pointer finds an element that belongs in the processed region, it gets placed at the slow pointer's position.

```
Slow pointer: marks the write position (or boundary of processed region)
Fast pointer: scans through the array

Example: remove duplicates from sorted [1, 1, 2, 2, 3]
  Fast scans: 1, 1, 2, 2, 3
  When fast finds a new value (different from slow's value), copy to slow+1 and advance slow.
  
  Step 0: slow=0, fast=0  → arr[0]=1, same, fast++
  Step 1: slow=0, fast=1  → arr[1]=1, same as arr[slow], fast++
  Step 2: slow=0, fast=2  → arr[2]=2, different! arr[1]=2, slow=1, fast++
  Step 3: slow=1, fast=3  → arr[3]=2, same as arr[slow], fast++
  Step 4: slow=1, fast=4  → arr[4]=3, different! arr[2]=3, slow=2, fast++
  Result: [1, 2, 3, ...] with length slow+1 = 3
```

### Recognition Triggers

- "remove duplicates in-place"
- "move all X to the end/beginning"
- "partition array around a condition"
- "remove element in-place"
- "cycle detection" (fast/slow at different speeds — Floyd's algorithm)
- "find the middle of a linked list" (fast moves 2x, slow moves 1x)

### Template Code

```java
/**
 * Same-direction two pointers — array partitioning template.
 * 
 * Time:  O(n)
 * Space: O(1) — in-place modification
 */
public int sameDirectionPartition(int[] arr) {
    int slow = 0;  // write position
    
    for (int fast = 0; fast < arr.length; fast++) {
        if (/* arr[fast] should be kept */) {
            arr[slow] = arr[fast];
            slow++;
        }
    }
    
    return slow;  // new length of the valid portion
}
```

### Real-World Correlations

**Floyd's cycle detection in garbage collection.** The JVM's garbage collector needs to detect reference cycles (objects referencing each other but unreachable from roots). While modern GCs use tracing (reachability from roots) rather than reference counting, Floyd's cycle detection appears in weak reference processing and finalization queue management.

**Log compaction in Kafka.** Kafka's log compaction scans a partition's log with two logical pointers: a read pointer scanning forward and a write pointer marking the compacted output position. Duplicate keys are skipped (only the latest value is kept). This is the same-direction two-pointer partitioning pattern applied to append-only logs.

---

### Problems: Two Pointers (Same Direction)

---

**P15.28** [E] -- Remove Duplicates from Sorted Array (LeetCode 26)

Given a sorted array, remove duplicates in-place. Return the new length.

```
Pattern: Same-direction two pointers. Slow marks the last unique position.
```

```java
public int removeDuplicates(int[] nums) {
    if (nums.length == 0) return 0;
    
    int slow = 0;
    
    for (int fast = 1; fast < nums.length; fast++) {
        if (nums[fast] != nums[slow]) {
            slow++;
            nums[slow] = nums[fast];
        }
    }
    
    return slow + 1;
}
```

```
Time:  O(n)
Space: O(1)
JVM note: The assignment nums[slow] = nums[fast] is a single iastore instruction.
  Because slow <= fast, we are always writing to a position we have already read —
  no cache coherency issues. The access pattern is sequential reads (fast) with
  sparse writes (slow), which is very cache-friendly.
```

---

**P15.29** [E] -- Move Zeroes (LeetCode 283)

Move all zeroes to the end while maintaining the relative order of non-zero elements.

```
Pattern: Same-direction two pointers. Slow marks the write position for non-zero elements.
```

```java
public void moveZeroes(int[] nums) {
    int slow = 0;
    
    // Move all non-zero elements to the front
    for (int fast = 0; fast < nums.length; fast++) {
        if (nums[fast] != 0) {
            nums[slow] = nums[fast];
            slow++;
        }
    }
    
    // Fill the rest with zeros
    while (slow < nums.length) {
        nums[slow] = 0;
        slow++;
    }
}
```

Swap variant (avoids the backfill step and minimizes writes):

```java
public void moveZeroesSwap(int[] nums) {
    int slow = 0;
    
    for (int fast = 0; fast < nums.length; fast++) {
        if (nums[fast] != 0) {
            // Swap only if pointers are at different positions
            if (slow != fast) {
                nums[slow] = nums[fast];
                nums[fast] = 0;
            }
            slow++;
        }
    }
}
```

```
Time:  O(n)
Space: O(1)
Key insight: The swap variant writes each non-zero element exactly once and each
  zero exactly once. The backfill variant may write more times (it writes all
  remaining positions with 0). For arrays with few zeros, the swap variant
  executes fewer writes.
```

---

**P15.30** [E] -- Remove Element (LeetCode 27)

Remove all occurrences of a given value in-place. Return the new length.

```
Pattern: Same-direction two pointers. Keep elements that are not equal to val.
```

```java
public int removeElement(int[] nums, int val) {
    int slow = 0;
    
    for (int fast = 0; fast < nums.length; fast++) {
        if (nums[fast] != val) {
            nums[slow] = nums[fast];
            slow++;
        }
    }
    
    return slow;
}
```

```
Time:  O(n)
Space: O(1)
```

---

**P15.31** [E] -- Linked List Cycle (LeetCode 141)

Determine if a linked list has a cycle.

```
Pattern: Floyd's cycle detection — fast pointer moves 2 steps, slow moves 1.
  If there is a cycle, fast will eventually lap slow and they will meet.
  If there is no cycle, fast reaches null.
```

```java
public boolean hasCycle(ListNode head) {
    ListNode slow = head, fast = head;
    
    while (fast != null && fast.next != null) {
        slow = slow.next;
        fast = fast.next.next;
        if (slow == fast) return true;
    }
    
    return false;
}
```

```
Time:  O(n) — in the worst case, fast traverses 2n steps before meeting slow
Space: O(1)
Why they must meet: If there is a cycle of length C, once both pointers are in
  the cycle, the gap between fast and slow decreases by 1 each step (because fast
  moves 2, slow moves 1, so the relative speed is 1). They must meet within C steps.
Proof: Let the distance between slow and fast (measured in the direction of travel)
  be d. After each step, d decreases by 1. When d = 0, they meet. Since d starts
  at some value in [0, C), they meet in at most C steps after both enter the cycle.
```

---

**P15.32** [E] -- Middle of the Linked List (LeetCode 876)

Find the middle node. If two middles, return the second one.

```
Pattern: Fast moves 2 steps, slow moves 1. When fast reaches the end,
  slow is at the middle.
```

```java
public ListNode middleNode(ListNode head) {
    ListNode slow = head, fast = head;
    
    while (fast != null && fast.next != null) {
        slow = slow.next;
        fast = fast.next.next;
    }
    
    return slow;
}
```

```
Time:  O(n)
Space: O(1)
Key insight: For even-length lists, this returns the SECOND middle.
  fast = head vs fast = head.next determines which middle you get for even lengths.
  "fast = head" gives the second middle (as this problem requires).
  "fast = head.next" would give the first middle.
```

---

**P15.33** [E] -- Happy Number (LeetCode 202)

A happy number is one where repeated summing of squares of digits eventually reaches 1. Detect if a number is happy (vs enters an infinite cycle).

```
Pattern: Floyd's cycle detection on the "next number" function.
  The sequence of digit-square sums either reaches 1 or enters a cycle.
```

```java
public boolean isHappy(int n) {
    int slow = n, fast = n;
    
    do {
        slow = sumOfSquaredDigits(slow);
        fast = sumOfSquaredDigits(sumOfSquaredDigits(fast));
    } while (slow != fast);
    
    return slow == 1;
}

private int sumOfSquaredDigits(int n) {
    int sum = 0;
    while (n > 0) {
        int digit = n % 10;
        sum += digit * digit;
        n /= 10;
    }
    return sum;
}
```

```
Time:  O(log n) per step (number of digits), O(k) steps where k is cycle length
Space: O(1) — no HashSet needed, Floyd's detects the cycle
Key insight: Any sequence generated by a function on a finite domain must eventually
  cycle (pigeonhole principle). The digit-square-sum function maps int to int —
  a finite domain. So the sequence must cycle. Floyd's detects the cycle without
  storing the history.
  Alternative: use a HashSet to store seen values. O(k) space but conceptually simpler.
```

---

**P15.34** [M] -- Remove Duplicates from Sorted Array II (LeetCode 80)

Allow at most two duplicates in a sorted array. Remove extras in-place.

```
Pattern: Same-direction two pointers with a count constraint.
```

```java
public int removeDuplicates(int[] nums) {
    if (nums.length <= 2) return nums.length;
    
    int slow = 2;  // first two elements are always valid
    
    for (int fast = 2; fast < nums.length; fast++) {
        // Keep nums[fast] if it differs from nums[slow - 2]
        // This ensures at most 2 consecutive duplicates
        if (nums[fast] != nums[slow - 2]) {
            nums[slow] = nums[fast];
            slow++;
        }
    }
    
    return slow;
}
```

```
Time:  O(n)
Space: O(1)
Key insight: The condition nums[fast] != nums[slow - 2] is the generalization.
  For "at most k duplicates," use nums[fast] != nums[slow - k].
  This works because the array is sorted — if nums[fast] == nums[slow - k],
  then at least k+1 consecutive elements have the same value (everything from
  slow-k to fast), which violates the constraint.
```

---

## 15.5 Pattern 5: Prefix Sum / Difference Array

### What It Is

A prefix sum array stores cumulative sums: `prefix[i] = arr[0] + arr[1] + ... + arr[i-1]`. With this precomputation, the sum of any subarray `arr[l..r]` can be computed in O(1): `prefix[r+1] - prefix[l]`.

```
Array:    [2, 4, 1, 3, 5]
Prefix:   [0, 2, 6, 7, 10, 15]
             ↑  ↑  ↑   ↑   ↑
             0  0+2 0+2+4  ...

Sum(arr[1..3]) = arr[1]+arr[2]+arr[3] = 4+1+3 = 8
               = prefix[4] - prefix[1] = 10 - 2 = 8  ← O(1)!
```

The **difference array** is the inverse operation. Given a difference array `diff[]`, the original array is reconstructed by prefix-summing `diff[]`. This makes range updates O(1): to add `val` to all elements in `[l, r]`, just do `diff[l] += val` and `diff[r+1] -= val`. Then prefix sum to reconstruct.

```
Difference Array for range updates:

Want to add 3 to arr[1..3]:
diff[1] += 3   →  diff = [0, 3, 0, 0, -3, 0]
diff[4] -= 3

Prefix sum of diff: [0, 3, 3, 3, 0, 0]
Original + delta:   [2, 7, 4, 6, 5]  ← exactly arr[i] + 3 for i in [1,3]
```

### Recognition Triggers

- "range sum queries" (multiple queries on the same array)
- "subarray sum equals K"
- "number of subarrays with sum X"
- "range updates" (add value to a range of elements)
- "prefix" or "cumulative" in the problem description
- "equal number of 0s and 1s" (transform 0→-1, then subarray sum = 0)

### Template Code

```java
/**
 * Prefix Sum — precomputation for O(1) range sum queries.
 */
public class PrefixSum {
    private long[] prefix;
    
    public PrefixSum(int[] arr) {
        prefix = new long[arr.length + 1];
        for (int i = 0; i < arr.length; i++) {
            prefix[i + 1] = prefix[i] + arr[i];
        }
    }
    
    // Sum of arr[left..right] (inclusive)
    public long rangeSum(int left, int right) {
        return prefix[right + 1] - prefix[left];
    }
}

/**
 * Difference Array — O(1) range updates, O(n) reconstruction.
 */
public class DifferenceArray {
    private int[] diff;
    
    public DifferenceArray(int size) {
        diff = new int[size + 1];
    }
    
    // Add val to all elements in [left, right]
    public void rangeAdd(int left, int right, int val) {
        diff[left] += val;
        diff[right + 1] -= val;
    }
    
    // Reconstruct the array
    public int[] build() {
        int[] result = new int[diff.length - 1];
        result[0] = diff[0];
        for (int i = 1; i < result.length; i++) {
            result[i] = result[i - 1] + diff[i];
        }
        return result;
    }
}
```

### Real-World Correlations

**Prometheus `rate()` and `increase()`.** Prometheus counters are monotonically increasing (like prefix sums). The `rate()` function computes `(counter[end] - counter[start]) / (end - start)` -- this is exactly a prefix sum range query divided by the time interval. Every time you write `rate(http_requests_total[5m])`, Prometheus is doing a prefix-sum difference.

**IP address range blocking.** When a firewall blocks IP ranges, it can represent each rule as a difference array update: `diff[start_ip] += 1, diff[end_ip + 1] -= 1`. After processing all rules, prefix-summing gives the number of blocking rules at each IP. Any IP with count > 0 is blocked. This handles overlapping ranges efficiently.

**Database aggregate queries.** A cumulative sum column in a database table enables O(1) range aggregates without scanning rows. This is the database equivalent of a prefix sum array.

---

### Problems: Prefix Sum / Difference Array

---

**P15.35** [E] -- Range Sum Query - Immutable (LeetCode 303)

Design a class that supports multiple range sum queries on an immutable array.

```
Pattern: Prefix sum precomputation for O(1) queries.
```

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
Time:  O(n) precomputation, O(1) per query
Space: O(n)
JVM note: If this is queried millions of times (as in a monitoring dashboard),
  the prefix array will be promoted to Old Gen and never collected. The query
  method is trivially inlineable — two array loads and a subtraction.
  C2 will inline sumRange into the caller, eliminating the method call overhead.
```

---

**P15.36** [M] -- Subarray Sum Equals K (LeetCode 560)

Given an array and integer `k`, find the total number of continuous subarrays whose sum equals `k`.

```
Pattern: Prefix sum + hash map.
Core idea: sum(arr[i..j]) = prefix[j+1] - prefix[i] = k
  ↔ prefix[i] = prefix[j+1] - k.
  For each j, count how many previous prefix sums equal prefix[j+1] - k.
```

```java
public int subarraySum(int[] nums, int k) {
    Map<Integer, Integer> prefixCount = new HashMap<>();
    prefixCount.put(0, 1);  // empty prefix has sum 0
    
    int sum = 0;
    int count = 0;
    
    for (int num : nums) {
        sum += num;
        // How many prefixes have sum = (sum - k)?
        count += prefixCount.getOrDefault(sum - k, 0);
        prefixCount.merge(sum, 1, Integer::sum);
    }
    
    return count;
}
```

```
Time:  O(n)
Space: O(n) for the hash map
Key insight: This does NOT use a sliding window because elements can be negative.
  Negative elements break the monotonicity that sliding window requires.
  Prefix sum + hash map handles both positive and negative elements.
  
  The hash map stores (prefix_sum → count_of_occurrences). For each position,
  we ask: "How many earlier prefix sums, when subtracted from the current prefix
  sum, give exactly k?" This is the O(n) version of the O(n^2) brute force that
  checks all (i, j) pairs.
Real-world: Finding time periods in a metrics series where the net change equals
  a threshold — exactly the prefix sum difference condition.
```

---

**P15.37** [M] -- Contiguous Array / Equal 0s and 1s (LeetCode 525)

Given a binary array, find the maximum length of a contiguous subarray with equal number of 0s and 1s.

```
Pattern: Transform + prefix sum + hash map.
Core idea: Replace every 0 with -1. Now "equal 0s and 1s" becomes "subarray sum = 0."
  A subarray sum = 0 means prefix[j] = prefix[i], so find the furthest apart indices
  with the same prefix sum.
```

```java
public int findMaxLength(int[] nums) {
    // Transform: 0 → -1 (conceptually, we do this inline)
    Map<Integer, Integer> firstOccurrence = new HashMap<>();
    firstOccurrence.put(0, -1);  // sum 0 "occurs" at index -1 (before the array)
    
    int sum = 0;
    int maxLen = 0;
    
    for (int i = 0; i < nums.length; i++) {
        sum += (nums[i] == 0) ? -1 : 1;
        
        if (firstOccurrence.containsKey(sum)) {
            maxLen = Math.max(maxLen, i - firstOccurrence.get(sum));
        } else {
            firstOccurrence.put(sum, i);
        }
    }
    
    return maxLen;
}
```

```
Time:  O(n)
Space: O(n)
Key insight: The 0→-1 transformation is the critical creative step. Without it,
  you need to track both counts separately. With it, the problem reduces to a
  standard prefix sum pattern.
  We store only the FIRST occurrence of each prefix sum because we want the
  LONGEST subarray (earliest start - latest end).
```

---

**P15.38** [M] -- Product of Array Except Self (LeetCode 238)

Given an array, return an array where each element is the product of all elements except itself. Do not use division.

```
Pattern: Prefix product from left + suffix product from right.
Core idea: answer[i] = (product of all elements to the left) * (product of all elements to the right).
```

```java
public int[] productExceptSelf(int[] nums) {
    int n = nums.length;
    int[] result = new int[n];
    
    // Left pass: result[i] = product of nums[0..i-1]
    result[0] = 1;
    for (int i = 1; i < n; i++) {
        result[i] = result[i - 1] * nums[i - 1];
    }
    
    // Right pass: multiply by product of nums[i+1..n-1]
    int rightProduct = 1;
    for (int i = n - 2; i >= 0; i--) {
        rightProduct *= nums[i + 1];
        result[i] *= rightProduct;
    }
    
    return result;
}
```

```
Time:  O(n) — two passes
Space: O(1) extra (result array does not count as extra space per problem statement)
Key insight: The "no division" constraint eliminates the obvious approach
  (total product / nums[i]). Instead, decompose into left prefix product and
  right suffix product. The second pass reuses the result array, avoiding
  a separate rightProduct[] array.
JVM note: Two sequential passes over an array is cache-friendly. The first pass
  is a forward scan (sequential prefetch). The second pass is a backward scan
  (hardware prefetchers on modern CPUs also handle reverse sequential patterns).
```

---

**P15.39** [H] -- Count of Range Sum (LeetCode 327)

Given an integer array and a range `[lower, upper]`, count the number of range sums that lie in `[lower, upper]` inclusive. A range sum `S(i, j)` is `sum(nums[i..j])`.

```
Pattern: Prefix sum + merge sort (count inversions variant).
Core idea: S(i, j) = prefix[j+1] - prefix[i]. We need:
  lower <= prefix[j+1] - prefix[i] <= upper
  ↔ prefix[j+1] - upper <= prefix[i] <= prefix[j+1] - lower
  For each j, count how many earlier prefix[i] values fall in this range.
  This is a range count query, solvable with merge sort in O(n log n).
```

```java
public int countRangeSum(int[] nums, int lower, int upper) {
    int n = nums.length;
    long[] prefix = new long[n + 1];
    for (int i = 0; i < n; i++) {
        prefix[i + 1] = prefix[i] + nums[i];
    }
    
    return mergeCount(prefix, 0, prefix.length, lower, upper);
}

private int mergeCount(long[] prefix, int lo, int hi, int lower, int upper) {
    if (hi - lo <= 1) return 0;
    
    int mid = lo + (hi - lo) / 2;
    int count = mergeCount(prefix, lo, mid, lower, upper)
              + mergeCount(prefix, mid, hi, lower, upper);
    
    // Count valid pairs: i in [lo, mid), j in [mid, hi)
    // where lower <= prefix[j] - prefix[i] <= upper
    int j1 = mid, j2 = mid;
    for (int i = lo; i < mid; i++) {
        while (j1 < hi && prefix[j1] - prefix[i] < lower) j1++;
        while (j2 < hi && prefix[j2] - prefix[i] <= upper) j2++;
        count += j2 - j1;
    }
    
    // Standard merge
    long[] sorted = new long[hi - lo];
    int p1 = lo, p2 = mid, idx = 0;
    while (p1 < mid && p2 < hi) {
        if (prefix[p1] <= prefix[p2]) sorted[idx++] = prefix[p1++];
        else sorted[idx++] = prefix[p2++];
    }
    while (p1 < mid) sorted[idx++] = prefix[p1++];
    while (p2 < hi) sorted[idx++] = prefix[p2++];
    System.arraycopy(sorted, 0, prefix, lo, hi - lo);
    
    return count;
}
```

```
Time:  O(n log n) — merge sort with counting
Space: O(n) for the temporary merge array
Key insight: The merge sort approach works because after sorting the left and right
  halves, the j1 and j2 pointers only move forward — they never reset — giving
  O(n) counting per merge level, and O(log n) merge levels.
Alternative: Use a balanced BST (TreeMap) or BIT (Fenwick tree) for O(n log n) with
  different constant factors.
```

---

**P15.40** [M] -- Corporate Flight Bookings (LeetCode 1109)

There are `n` flights labeled 1 to n. Bookings are given as `[first, last, seats]` meaning seats are booked on flights `first` through `last`. Return the total seats on each flight.

```
Pattern: Difference array. Each booking is a range update.
```

```java
public int[] corpFlightBookings(int[][] bookings, int n) {
    int[] diff = new int[n + 1];  // extra element for diff[last+1]
    
    for (int[] booking : bookings) {
        int first = booking[0] - 1;  // 0-indexed
        int last = booking[1] - 1;
        int seats = booking[2];
        
        diff[first] += seats;
        if (last + 1 < n) diff[last + 1] -= seats;
    }
    
    // Prefix sum to reconstruct
    int[] result = new int[n];
    result[0] = diff[0];
    for (int i = 1; i < n; i++) {
        result[i] = result[i - 1] + diff[i];
    }
    
    return result;
}
```

```
Time:  O(n + m) where m = number of bookings
Space: O(n)
Key insight: Without the difference array, each booking requires O(last - first + 1)
  updates. With m bookings over a range of n flights, brute force is O(m*n).
  The difference array reduces all bookings to O(m) point updates + one O(n) prefix sum.
Real-world: Reservation systems, bandwidth allocation (reserve bandwidth on a link
  for a time range), and employee scheduling (assign a shift covering hours X to Y).
```

---

**P15.41** [M] -- Car Pooling (LeetCode 1094)

Given trips `[numPassengers, from, to]` and vehicle capacity, determine if all trips can be completed. Passengers board at `from` and exit at `to`.

```
Pattern: Difference array over stops. Check if any stop exceeds capacity.
```

```java
public boolean carPooling(int[][] trips, int capacity) {
    int[] diff = new int[1001];  // stops range from 0 to 1000
    
    for (int[] trip : trips) {
        int passengers = trip[0];
        int from = trip[1];
        int to = trip[2];
        
        diff[from] += passengers;   // board
        diff[to] -= passengers;     // exit (at stop 'to', they are gone)
    }
    
    // Prefix sum: check if any point exceeds capacity
    int current = 0;
    for (int d : diff) {
        current += d;
        if (current > capacity) return false;
    }
    
    return true;
}
```

```
Time:  O(n + maxStop) — n trips, prefix sum over stops
Space: O(maxStop)
Key insight: Passengers exit AT the 'to' stop, not after it. So we decrement
  at diff[to], not diff[to + 1]. This is a subtle off-by-one that depends on
  problem semantics.
```

---

## 15.6 Pattern 6: Binary Search Variants

### What It Is

Binary search is not just "find a value in a sorted array." It is a general technique for finding boundaries in any monotonic predicate. The four variants every systems engineer must internalize:

1. **Standard**: Find the exact position of a target in a sorted array. O(log n).
2. **Lower bound (leftmost)**: Find the first position where `arr[i] >= target`. The insertion point.
3. **Upper bound (rightmost)**: Find the last position where `arr[i] <= target`.
4. **Search on answer**: Binary search over the answer space when the predicate is monotonic.

```
Monotonic predicate visualization:

Array: [1, 2, 4, 4, 4, 7, 9]    target = 4

Predicate "arr[i] >= 4":
  F  F  T  T  T  T  T
           ↑
           Lower bound (first True) → index 2

Predicate "arr[i] <= 4":
  T  T  T  T  T  F  F
                 ↑
                 Upper bound (last True) → index 4

Predicate "arr[i] == 4":
  F  F  T  T  T  F  F
  (not monotonic — binary search on equality alone does not find boundaries)
```

The "search on answer" variant is the most powerful and least intuitive. Instead of searching through the array, you binary search through the possible answer values:

```
"What is the minimum speed to finish in H hours?"

Predicate: canFinish(speed) — monotonic! If speed X works, all speeds > X also work.

  speed:    1   2   3   4   5   6   7   8   9   10
  works?:   F   F   F   T   T   T   T   T   T   T
                        ↑
                        Binary search finds speed = 4 (first True)
```

### Recognition Triggers

- "sorted array" (classic binary search)
- "find first/last occurrence" (lower/upper bound)
- "rotated sorted array" (modified binary search)
- "minimize the maximum" or "maximize the minimum" (search on answer)
- "is it possible to achieve X?" where X is monotonic (search on answer)
- "peak element" (ternary-like binary search)
- "koko eating bananas," "ship packages," "split array" (search on answer)

### Template Code

```java
/**
 * Lower bound: find the first index where arr[i] >= target.
 * Returns arr.length if all elements < target.
 */
public int lowerBound(int[] arr, int target) {
    int lo = 0, hi = arr.length;
    
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (arr[mid] < target) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/**
 * Upper bound: find the first index where arr[i] > target.
 * (The last element <= target is at index upperBound - 1.)
 */
public int upperBound(int[] arr, int target) {
    int lo = 0, hi = arr.length;
    
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (arr[mid] <= target) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/**
 * Search on answer: find the minimum value in [lo, hi] satisfying a predicate.
 * The predicate must be monotonic: once true, stays true for all larger values.
 */
public int searchOnAnswer(int lo, int hi) {
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (feasible(mid)) {
            hi = mid;       // mid might be the answer, search smaller
        } else {
            lo = mid + 1;   // mid is too small, search larger
        }
    }
    return lo;  // smallest feasible value
}
```

### Real-World Correlations

**`git bisect`** is binary search on answer. The predicate is "does this commit have the bug?" You binary search through the commit history, which is linearly ordered by time. Each test halves the remaining commits. O(log n) tests instead of O(n).

**Database index lookup.** A B+ tree index lookup is a generalized binary search. Each internal node is a sorted array of keys, and the lookup performs binary search within that node to find the child pointer to follow. The "sorted SSTable" in LSM-tree storage engines (RocksDB, LevelDB, Cassandra) uses binary search within each SSTable to find a key.

**JDK's `Arrays.binarySearch()`** uses the standard variant and returns `-(insertion point) - 1` when the element is not found. This encoding allows callers to derive both "element found at index X" and "element should be inserted at index X" from a single return value.

---

### Problems: Binary Search Variants

---

**P15.42** [M] -- Search in Rotated Sorted Array (LeetCode 33)

A sorted array is rotated at some pivot. Search for a target in O(log n).

```
Pattern: Binary search with modified invariant — one half is always sorted.
Core idea: At each step, determine which half is sorted.
  If the target is in the sorted half's range, search there. Otherwise, search the other half.
```

```java
public int search(int[] nums, int target) {
    int lo = 0, hi = nums.length - 1;
    
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        
        if (nums[mid] == target) return mid;
        
        // Left half is sorted
        if (nums[lo] <= nums[mid]) {
            if (target >= nums[lo] && target < nums[mid]) {
                hi = mid - 1;  // target is in the sorted left half
            } else {
                lo = mid + 1;  // target is in the right half
            }
        }
        // Right half is sorted
        else {
            if (target > nums[mid] && target <= nums[hi]) {
                lo = mid + 1;  // target is in the sorted right half
            } else {
                hi = mid - 1;  // target is in the left half
            }
        }
    }
    
    return -1;
}
```

```
Time:  O(log n)
Space: O(1)
Key insight: In a rotated sorted array, at least one half (divided by mid) is always
  properly sorted. We can determine which half is sorted by comparing nums[lo] with
  nums[mid]. Once we know which half is sorted, we check if the target falls in
  that sorted range. If yes, search there. If no, search the other half.
```

---

**P15.43** [M] -- Find First and Last Position of Element in Sorted Array (LeetCode 34)

Find the starting and ending position of a given target value.

```
Pattern: Two binary searches — lower bound for start, upper bound for end.
```

```java
public int[] searchRange(int[] nums, int target) {
    int first = lowerBound(nums, target);
    if (first == nums.length || nums[first] != target) {
        return new int[]{-1, -1};
    }
    int last = upperBound(nums, target) - 1;
    return new int[]{first, last};
}

private int lowerBound(int[] nums, int target) {
    int lo = 0, hi = nums.length;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

private int upperBound(int[] nums, int target) {
    int lo = 0, hi = nums.length;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
```

```
Time:  O(log n) — two binary searches
Space: O(1)
Key insight: Lower bound finds the first index where arr[i] >= target.
  Upper bound finds the first index where arr[i] > target. The last occurrence
  of target is upperBound - 1. Together they give the complete range.
JVM note: This is exactly what Collections.binarySearch and Arrays.binarySearch
  do internally, except they return a single index (or insertion point).
```

---

**P15.44** [M] -- Find Peak Element (LeetCode 162)

A peak element is strictly greater than its neighbors. Find any peak in O(log n). `nums[-1] = nums[n] = -infinity`.

```
Pattern: Binary search on slope.
Core idea: If nums[mid] < nums[mid+1], a peak must exist to the right (because
  the array goes up and must eventually come down to -infinity). Otherwise, a peak
  exists to the left (including mid itself).
```

```java
public int findPeakElement(int[] nums) {
    int lo = 0, hi = nums.length - 1;
    
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] < nums[mid + 1]) {
            lo = mid + 1;  // ascending → peak is to the right
        } else {
            hi = mid;      // descending or peak → peak is here or to the left
        }
    }
    
    return lo;
}
```

```
Time:  O(log n)
Space: O(1)
Why binary search works on an unsorted array: The boundary condition (nums[-1] =
  nums[n] = -infinity) guarantees at least one peak exists. The ascending/descending
  comparison at mid creates a monotonic predicate: "there exists a peak at or to
  the right of mid" transitions from true to false exactly once.
```

---

**P15.45** [M] -- Search a 2D Matrix (LeetCode 74)

Each row is sorted left to right, and the first element of each row is greater than the last element of the previous row. Search for a target.

```
Pattern: Treat the 2D matrix as a flattened 1D sorted array. Single binary search.
```

```java
public boolean searchMatrix(int[][] matrix, int target) {
    int m = matrix.length, n = matrix[0].length;
    int lo = 0, hi = m * n - 1;
    
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        int val = matrix[mid / n][mid % n];  // convert 1D index to 2D
        
        if (val == target) return true;
        else if (val < target) lo = mid + 1;
        else hi = mid - 1;
    }
    
    return false;
}
```

```
Time:  O(log(m * n))
Space: O(1)
Key insight: The 2D-to-1D index conversion (row = mid / n, col = mid % n) avoids
  actually flattening the matrix. This is the same math the JVM uses for flattened
  matrix access (see Chapter 10, adjacency matrix discussion).
```

---

**P15.46** [M] -- Find Minimum in Rotated Sorted Array (LeetCode 153)

Find the minimum element in a rotated sorted array (no duplicates).

```
Pattern: Binary search — the minimum is at the rotation point.
Core idea: Compare nums[mid] with nums[hi]. If nums[mid] > nums[hi], the rotation
  point is in the right half. Otherwise, it is in the left half (including mid).
```

```java
public int findMin(int[] nums) {
    int lo = 0, hi = nums.length - 1;
    
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] > nums[hi]) {
            lo = mid + 1;  // min is in [mid+1, hi]
        } else {
            hi = mid;      // min is in [lo, mid]
        }
    }
    
    return nums[lo];
}
```

```
Time:  O(log n)
Space: O(1)
Why compare with nums[hi] and not nums[lo]: Comparing with nums[lo] is ambiguous.
  If nums[lo] <= nums[mid], the left half could be sorted (min at lo) or the array
  could be fully sorted (min at lo). Both cases point to the left, but we would need
  to check nums[lo] vs nums[hi] separately. Comparing with nums[hi] gives a clean
  binary decision with no ambiguity.
```

---

**P15.47** [H] -- Median of Two Sorted Arrays (LeetCode 4)

Find the median of two sorted arrays in O(log(min(m, n))) time.

```
Pattern: Binary search on partition.
Core idea: Partition both arrays such that all elements on the left side are <=
  all elements on the right side. The partition sizes must sum to (m+n+1)/2.
  Binary search the partition position in the smaller array.
```

```java
public double findMedianSortedArrays(int[] nums1, int[] nums2) {
    // Ensure nums1 is the smaller array
    if (nums1.length > nums2.length) {
        return findMedianSortedArrays(nums2, nums1);
    }
    
    int m = nums1.length, n = nums2.length;
    int lo = 0, hi = m;
    
    while (lo <= hi) {
        int i = lo + (hi - lo) / 2;       // partition in nums1
        int j = (m + n + 1) / 2 - i;      // partition in nums2
        
        int maxLeft1 = (i == 0) ? Integer.MIN_VALUE : nums1[i - 1];
        int minRight1 = (i == m) ? Integer.MAX_VALUE : nums1[i];
        int maxLeft2 = (j == 0) ? Integer.MIN_VALUE : nums2[j - 1];
        int minRight2 = (j == n) ? Integer.MAX_VALUE : nums2[j];
        
        if (maxLeft1 <= minRight2 && maxLeft2 <= minRight1) {
            // Found correct partition
            if ((m + n) % 2 == 0) {
                return (Math.max(maxLeft1, maxLeft2) + Math.min(minRight1, minRight2)) / 2.0;
            } else {
                return Math.max(maxLeft1, maxLeft2);
            }
        } else if (maxLeft1 > minRight2) {
            hi = i - 1;  // too far right in nums1
        } else {
            lo = i + 1;  // too far left in nums1
        }
    }
    
    throw new IllegalArgumentException("Input arrays are not sorted");
}
```

```
Time:  O(log(min(m, n)))
Space: O(1)
Key insight: We binary search only on the smaller array. The partition in the
  larger array is determined by i + j = (m + n + 1) / 2. The correct partition
  satisfies maxLeft1 <= minRight2 AND maxLeft2 <= minRight1 — all left elements
  are <= all right elements. This is the most elegant binary search problem.
Real-world: Distributed percentile computation. When computing the P99 latency
  across two data centers, each with a sorted array of latencies, this algorithm
  finds the median (or any percentile) without merging the arrays.
```

---

**P15.48** [M] -- Koko Eating Bananas (LeetCode 875)

Koko eats bananas at speed `k` (bananas per hour). Each pile takes `ceil(pile / k)` hours. Find the minimum `k` to finish all piles within `h` hours.

```
Pattern: Binary search on answer.
Predicate: canFinish(k, h) — monotonic! If speed k works, all speeds > k also work.
```

```java
public int minEatingSpeed(int[] piles, int h) {
    int lo = 1;
    int hi = 0;
    for (int pile : piles) hi = Math.max(hi, pile);
    
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (canFinish(piles, mid, h)) {
            hi = mid;       // try a smaller speed
        } else {
            lo = mid + 1;   // need a faster speed
        }
    }
    
    return lo;
}

private boolean canFinish(int[] piles, int speed, int h) {
    long hours = 0;
    for (int pile : piles) {
        hours += (pile + speed - 1) / speed;  // ceil division without floating point
        if (hours > h) return false;          // early exit
    }
    return hours <= h;
}
```

```
Time:  O(n * log(maxPile)) — binary search over speeds, O(n) per check
Space: O(1)
Key insight: ceil(a / b) = (a + b - 1) / b using integer arithmetic. This avoids
  floating-point and is faster. The early exit in canFinish() is critical for large
  inputs — once we exceed h hours, we can stop counting.
Real-world: Capacity planning. "What is the minimum server throughput to handle
  all tasks within the deadline?" — binary search on the throughput.
```

---

**P15.49** [M] -- Capacity to Ship Packages (LeetCode 1011)

Find the minimum ship capacity to ship all packages within `days` days. Packages must be shipped in order.

```
Pattern: Binary search on answer.
Predicate: canShip(capacity, days) — monotonic.
```

```java
public int shipWithinDays(int[] weights, int days) {
    int lo = 0, hi = 0;
    for (int w : weights) {
        lo = Math.max(lo, w);  // must carry the heaviest single package
        hi += w;               // worst case: everything in one day
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
    int daysNeeded = 1;
    int currentLoad = 0;
    
    for (int w : weights) {
        if (currentLoad + w > capacity) {
            daysNeeded++;
            currentLoad = 0;
            if (daysNeeded > days) return false;
        }
        currentLoad += w;
    }
    
    return true;
}
```

```
Time:  O(n * log(sum - max))
Space: O(1)
Key insight: The lower bound for capacity is the heaviest package (otherwise it
  cannot be loaded at all). The upper bound is the total weight (ship everything
  in one day). Binary search between these bounds.
```

---

**P15.50** [H] -- Split Array Largest Sum (LeetCode 410)

Split an array into `m` subarrays to minimize the largest sum among them.

```
Pattern: Binary search on answer — the same structure as ship packages!
Predicate: canSplit(maxSum, m) — can we split into m subarrays where each has sum <= maxSum?
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
    int subarrays = 1;
    int currentSum = 0;
    
    for (int num : nums) {
        if (currentSum + num > maxSum) {
            subarrays++;
            currentSum = 0;
            if (subarrays > m) return false;
        }
        currentSum += num;
    }
    
    return true;
}
```

```
Time:  O(n * log(sum - max))
Space: O(1)
Key insight: This problem, "ship packages within D days," and "Koko eating bananas"
  are structurally identical: binary search on the answer with a greedy feasibility check.
  Recognizing this family is worth 5 minutes of interview time.
  The greedy check works because splitting greedily (pack as much as possible before
  starting a new subarray) minimizes the number of subarrays for a given maxSum.
  If greedy can do it in <= m subarrays, the maxSum is feasible.
```

---

**P15.51** [H] -- Magnetic Force Between Two Balls (LeetCode 1552)

Place `m` balls in `n` baskets (at given positions) to maximize the minimum distance between any two balls.

```
Pattern: Binary search on answer — maximize the minimum.
Predicate: canPlace(minDist, m) — can we place m balls with minimum distance >= minDist?
```

```java
public int maxDistance(int[] position, int m) {
    Arrays.sort(position);
    int lo = 1;
    int hi = position[position.length - 1] - position[0];
    
    while (lo < hi) {
        int mid = lo + (hi - lo + 1) / 2;  // round UP to avoid infinite loop
        if (canPlace(position, mid, m)) {
            lo = mid;       // mid works, try larger distance
        } else {
            hi = mid - 1;   // mid too large, try smaller
        }
    }
    
    return lo;
}

private boolean canPlace(int[] position, int minDist, int m) {
    int placed = 1;
    int lastPos = position[0];
    
    for (int i = 1; i < position.length; i++) {
        if (position[i] - lastPos >= minDist) {
            placed++;
            lastPos = position[i];
            if (placed >= m) return true;
        }
    }
    
    return false;
}
```

```
Time:  O(n log n + n * log(maxPos))
Space: O(1)
Key insight: "Maximize the minimum" is the classic signal for binary search on answer.
  Note the rounding: mid = lo + (hi - lo + 1) / 2 rounds UP. This is necessary when
  the search narrows to [lo, lo+1] — rounding down would set mid = lo, and if
  canPlace(lo) is true, we set lo = mid = lo → infinite loop. Rounding up gives
  mid = lo+1, which breaks the tie.
  General rule: when lo = mid (as in the "lo = mid" case), round up. When hi = mid,
  round down (the standard formula).
```

---

## 15.7 Pattern 7: Kadane's Algorithm / Subarray Problems

### What It Is

Kadane's algorithm finds the maximum sum contiguous subarray in O(n). The idea: at each position, decide whether to extend the current subarray or start a new one. If the running sum goes negative, starting fresh is always better.

```
Array: [-2, 1, -3, 4, -1, 2, 1, -5, 4]

Position:  0    1    2    3    4    5    6    7    8
Element:  -2    1   -3    4   -1    2    1   -5    4
Current: -2    1   -2    4    3    5    6    1    5
Global:  -2    1    1    4    4    5    6    6    6

At position 3: currentSum = max(4, -2 + 4) = 4. Starting fresh is better.
At position 6: currentSum = max(1, 5 + 1) = 6. Extending is better.
Answer: 6 (subarray [4, -1, 2, 1])
```

The core recurrence:

```
currentSum[i] = max(arr[i], currentSum[i-1] + arr[i])
globalMax = max(globalMax, currentSum[i])
```

### Recognition Triggers

- "maximum/minimum contiguous subarray sum"
- "maximum product subarray" (variant of Kadane's)
- "maximum circular subarray" (Kadane's + complement trick)
- "longest turbulent subarray" (Kadane's variant with alternating condition)

### Template Code

```java
/**
 * Kadane's Algorithm — Maximum Subarray Sum.
 * Time:  O(n)
 * Space: O(1)
 */
public int kadane(int[] arr) {
    int currentSum = arr[0];
    int globalMax = arr[0];
    
    for (int i = 1; i < arr.length; i++) {
        currentSum = Math.max(arr[i], currentSum + arr[i]);
        globalMax = Math.max(globalMax, currentSum);
    }
    
    return globalMax;
}
```

### Real-World Correlations

**Maximum profit period in trading.** Given a series of daily profit/loss values, the maximum sum subarray is the most profitable continuous period. Hedge funds and trading systems use this for performance attribution.

**Signal processing: maximum energy window.** In audio/RF signal processing, finding the contiguous window with maximum energy (sum of squared amplitudes) uses Kadane's. This is how voice activity detection identifies speech segments in audio streams.

**Network burst detection.** Given a time series of bandwidth usage (above/below average as positive/negative values), the maximum subarray sum identifies the largest burst period.

---

### Problems: Kadane's Algorithm

---

**P15.52** [M] -- Maximum Subarray (LeetCode 53)

Find the contiguous subarray with the largest sum.

```
Pattern: Kadane's algorithm.
```

```java
public int maxSubArray(int[] nums) {
    int currentSum = nums[0];
    int maxSum = nums[0];
    
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
Alternative: Divide and conquer in O(n log n). Useful as an interview discussion
  point but strictly slower. The divide and conquer approach is: max of
  (max left subarray, max right subarray, max crossing subarray).
JVM note: This loop is branch-heavy (two Math.max calls, each typically compiled
  to a conditional move instruction cmov). On modern out-of-order CPUs, cmov avoids
  branch misprediction penalties. Without cmov, the two if-statements per iteration
  would suffer ~25% misprediction rate on random data, costing ~15 cycles per miss.
```

---

**P15.53** [M] -- Maximum Product Subarray (LeetCode 152)

Find the contiguous subarray with the largest product.

```
Pattern: Modified Kadane's — track both max and min products because a negative
  times a negative can become the new maximum.
```

```java
public int maxProduct(int[] nums) {
    int maxProd = nums[0];
    int minProd = nums[0];
    int globalMax = nums[0];
    
    for (int i = 1; i < nums.length; i++) {
        // If nums[i] is negative, max and min swap roles
        if (nums[i] < 0) {
            int tmp = maxProd;
            maxProd = minProd;
            minProd = tmp;
        }
        
        maxProd = Math.max(nums[i], maxProd * nums[i]);
        minProd = Math.min(nums[i], minProd * nums[i]);
        globalMax = Math.max(globalMax, maxProd);
    }
    
    return globalMax;
}
```

```
Time:  O(n)
Space: O(1)
Key insight: Negatives flip the sign: a very negative minimum can become a very
  positive maximum when multiplied by a negative number. So we must track both
  extremes. The swap-when-negative trick is elegant: after the swap, the standard
  Kadane's logic (extend or restart) applies to both maxProd and minProd.
Edge cases: zeros reset both maxProd and minProd to 0 (or rather, to nums[i] = 0
  via the max/min with nums[i]). This naturally handles zero elements.
```

---

**P15.54** [M] -- Maximum Sum Circular Subarray (LeetCode 918)

Find the maximum sum subarray in a circular array (the subarray can wrap around).

```
Pattern: Kadane's + complement trick.
Core idea: The maximum circular subarray is either:
  (a) A normal (non-wrapping) maximum subarray → Kadane's
  (b) A wrapping subarray → total_sum - minimum_subarray
  Answer = max(Kadane's max, total_sum - Kadane's min)
  Edge case: if all elements are negative, total_sum - Kadane's min = 0, which is
  wrong (empty subarray). In this case, the answer is the standard Kadane's max.
```

```java
public int maxSubarraySumCircular(int[] nums) {
    int totalSum = 0;
    int maxSum = nums[0], currentMax = nums[0];
    int minSum = nums[0], currentMin = nums[0];
    
    totalSum += nums[0];
    
    for (int i = 1; i < nums.length; i++) {
        totalSum += nums[i];
        
        currentMax = Math.max(nums[i], currentMax + nums[i]);
        maxSum = Math.max(maxSum, currentMax);
        
        currentMin = Math.min(nums[i], currentMin + nums[i]);
        minSum = Math.min(minSum, currentMin);
    }
    
    // If all elements negative, maxSum is the least negative. Do not use circular.
    if (maxSum < 0) return maxSum;
    
    return Math.max(maxSum, totalSum - minSum);
}
```

```
Time:  O(n)
Space: O(1)
Key insight: A wrapping subarray's complement (the elements NOT in the subarray)
  is a contiguous non-wrapping subarray. Minimizing the complement maximizes the
  wrapping subarray. So: wrap_max = total - non_wrap_min.
  This is one of the most beautiful reductions in competitive programming.
```

---

**P15.55** [M] -- Longest Turbulent Subarray (LeetCode 978)

A turbulent subarray alternates between increasing and decreasing: `a < b > c < d > e...` or `a > b < c > d < e...`.

```
Pattern: Kadane's variant with alternating condition.
```

```java
public int maxTurbulenceSize(int[] arr) {
    int n = arr.length;
    if (n == 1) return 1;
    
    int maxLen = 1;
    int inc = 1;  // length of turbulent subarray ending with an increase
    int dec = 1;  // length of turbulent subarray ending with a decrease
    
    for (int i = 1; i < n; i++) {
        if (arr[i] > arr[i - 1]) {
            inc = dec + 1;  // extend a decreasing sequence with an increase
            dec = 1;
        } else if (arr[i] < arr[i - 1]) {
            dec = inc + 1;  // extend an increasing sequence with a decrease
            inc = 1;
        } else {
            inc = 1;
            dec = 1;
        }
        maxLen = Math.max(maxLen, Math.max(inc, dec));
    }
    
    return maxLen;
}
```

```
Time:  O(n)
Space: O(1)
Key insight: Track two running lengths: one for sequences ending with arr[i] > arr[i-1],
  one for sequences ending with arr[i] < arr[i-1]. Each transition extends the
  opposite sequence. Equal adjacent elements reset both.
```

---

## 15.8 Pattern 8: String Matching (KMP, Rabin-Karp, Z-Algorithm)

### What It Is

String matching is the problem of finding all occurrences of a pattern `P` (length `m`) in a text `T` (length `n`). The naive approach compares P at every position in T, giving O(n*m) worst case. Three classical algorithms achieve O(n+m):

**KMP (Knuth-Morris-Pratt):**
Precomputes a "failure function" (longest proper prefix that is also a suffix) for the pattern. When a mismatch occurs, the failure function tells us how far to shift the pattern without re-examining characters we have already matched.

```
Pattern: ABABC
Failure: [0, 0, 1, 2, 0]

Matching against: ABABABABC
  ABABC       ← mismatch at position 4 (C vs A)
    ABABC     ← failure[3]=2, shift by 2 (not by 1 — we know AB already matches)
      ABABC   ← match!
```

**Rabin-Karp:**
Uses a rolling hash. Compute the hash of the pattern and the hash of each m-length substring of T. Only compare characters when hashes match (to handle collisions). The rolling hash updates in O(1) per position.

**Z-Algorithm:**
Computes the Z-array where `Z[i]` = length of the longest substring starting at position `i` that matches a prefix of the string. By concatenating `P + "$" + T` and computing the Z-array, any position where `Z[i] == m` is a match.

### Recognition Triggers

- "find pattern in text" (implement strStr)
- "repeated substring pattern"
- "shortest palindrome" (KMP on reversed + original)
- "longest happy prefix" (directly the KMP failure function)
- any problem involving pattern matching without regex

### Real-World Correlations

**`grep` / `ripgrep`.** These tools use a combination of string matching algorithms. For fixed strings, they use Boyer-Moore or similar. For short patterns, they may use Rabin-Karp. `ripgrep` uses Aho-Corasick for multiple pattern matching.

**Deep Packet Inspection (DPI).** Network firewalls and intrusion detection systems (Snort, Suricata) match packet payloads against thousands of signature patterns. They use multi-pattern matching algorithms (Aho-Corasick, an extension of KMP to multiple patterns).

**DNA sequence matching.** Bioinformatics tools (BLAST, FASTA) use seed-based matching with rolling hashes (Rabin-Karp variant) to find approximate matches in genomic sequences billions of characters long.

---

### Problems: String Matching

---

**P15.56** [E] -- Implement strStr() / Find the Index of the First Occurrence (LeetCode 28)

Find the first occurrence of `needle` in `haystack`. Return -1 if not found.

**KMP Solution:**

```java
public int strStr(String haystack, String needle) {
    if (needle.isEmpty()) return 0;
    
    int[] lps = buildLPS(needle);
    int i = 0;  // pointer in haystack
    int j = 0;  // pointer in needle
    
    while (i < haystack.length()) {
        if (haystack.charAt(i) == needle.charAt(j)) {
            i++;
            j++;
            if (j == needle.length()) {
                return i - j;  // match found
            }
        } else if (j > 0) {
            j = lps[j - 1];  // fall back using failure function
        } else {
            i++;
        }
    }
    
    return -1;
}

/**
 * Build the LPS (Longest Proper Prefix which is also Suffix) array.
 * Also called the failure function or pi function.
 * 
 * lps[i] = length of the longest proper prefix of needle[0..i] 
 *          that is also a suffix.
 */
private int[] buildLPS(String pattern) {
    int m = pattern.length();
    int[] lps = new int[m];
    int len = 0;  // length of previous longest prefix-suffix
    int i = 1;
    
    while (i < m) {
        if (pattern.charAt(i) == pattern.charAt(len)) {
            len++;
            lps[i] = len;
            i++;
        } else if (len > 0) {
            len = lps[len - 1];  // fall back
        } else {
            lps[i] = 0;
            i++;
        }
    }
    
    return lps;
}
```

**Rabin-Karp Solution:**

```java
public int strStrRabinKarp(String haystack, String needle) {
    int n = haystack.length(), m = needle.length();
    if (m > n) return -1;
    if (m == 0) return 0;
    
    long BASE = 31;
    long MOD = 1_000_000_007;
    
    // Compute hash of needle
    long needleHash = 0;
    long windowHash = 0;
    long power = 1;  // BASE^(m-1) mod MOD
    
    for (int i = 0; i < m; i++) {
        needleHash = (needleHash * BASE + needle.charAt(i)) % MOD;
        windowHash = (windowHash * BASE + haystack.charAt(i)) % MOD;
        if (i > 0) power = (power * BASE) % MOD;
    }
    
    // Check first window
    if (windowHash == needleHash && haystack.substring(0, m).equals(needle)) {
        return 0;
    }
    
    // Slide the window
    for (int i = m; i < n; i++) {
        // Remove leftmost character, add new character
        windowHash = (windowHash - haystack.charAt(i - m) * power % MOD + MOD) % MOD;
        windowHash = (windowHash * BASE + haystack.charAt(i)) % MOD;
        
        if (windowHash == needleHash) {
            // Verify (hash collision possible)
            if (haystack.substring(i - m + 1, i + 1).equals(needle)) {
                return i - m + 1;
            }
        }
    }
    
    return -1;
}
```

```
Time:  KMP: O(n + m). Rabin-Karp: O(n + m) average, O(nm) worst case (hash collisions).
Space: KMP: O(m) for the LPS array. Rabin-Karp: O(1) extra.
JVM note: The Rabin-Karp rolling hash uses long arithmetic to avoid overflow.
  With MOD = 10^9 + 7, intermediate products can reach ~31 * 10^9 ≈ 3.1 * 10^10,
  which fits in a long. The + MOD before % MOD handles negative remainders from
  the subtraction step — Java's % operator preserves sign, unlike mathematical mod.
Real-world: Java's String.indexOf() uses a simple O(nm) algorithm in most JDK versions.
  For short patterns on modern hardware, the O(nm) approach is actually faster than
  KMP due to lower constant factors and better branch prediction. KMP's advantage
  emerges only with adversarial inputs (e.g., pattern "AAAAAB" in text "AAAAAA...").
```

---

**P15.57** [E] -- Repeated Substring Pattern (LeetCode 459)

Given a string, check if it can be constructed by taking a substring and appending multiple copies of it.

```
Pattern: KMP failure function.
Core idea: If the string has a repeating pattern of length L, then the LPS value at
  the last position is n - L. Therefore L = n - lps[n-1]. If L divides n and L < n,
  the string is a repeated pattern.
```

```java
public boolean repeatedSubstringPattern(String s) {
    int n = s.length();
    int[] lps = buildLPS(s);
    
    int longestPrefixSuffix = lps[n - 1];
    int patternLen = n - longestPrefixSuffix;
    
    // The pattern must divide the string length, and must be shorter than s
    return longestPrefixSuffix > 0 && n % patternLen == 0;
}
```

```
Time:  O(n) for building the LPS array
Space: O(n)
Alternative elegant solution: (s + s).indexOf(s, 1) < s.length(). If s is made of
  repeated copies of a pattern, then s appears in s+s at a position before index n.
  But this relies on the built-in indexOf, which is O(nm) worst case.
```

---

**P15.58** [H] -- Shortest Palindrome (LeetCode 214)

Given a string, find the shortest palindrome by adding characters only in front.

```
Pattern: KMP on reversed string + original.
Core idea: Find the longest palindromic prefix. Characters after that prefix need
  to be reversed and prepended. To find the longest palindromic prefix:
  construct s + "#" + reverse(s), compute LPS. The last LPS value is the length
  of the longest palindromic prefix.
```

```java
public String shortestPalindrome(String s) {
    if (s.length() <= 1) return s;
    
    String rev = new StringBuilder(s).reverse().toString();
    String combined = s + "#" + rev;
    int[] lps = buildLPS(combined);
    
    // Length of the longest palindromic prefix
    int palLen = lps[combined.length() - 1];
    
    // Characters to prepend: reverse of s[palLen:]
    String toPrepend = rev.substring(0, s.length() - palLen);
    return toPrepend + s;
}
```

```
Time:  O(n) for LPS construction
Space: O(n)
Key insight: The "#" separator is critical. Without it, the LPS might find a
  prefix-suffix overlap between s and reverse(s) that crosses the boundary,
  giving an incorrect result. The separator ensures the prefix must come entirely
  from s and the suffix entirely from reverse(s).
```

---

**P15.59** [E] -- Longest Happy Prefix (LeetCode 1392)

A happy prefix is a non-empty prefix which is also a suffix (excluding the whole string). Find the longest one.

```
Pattern: This IS the KMP failure function — directly.
```

```java
public String longestPrefix(String s) {
    int[] lps = buildLPS(s);
    int length = lps[s.length() - 1];
    return s.substring(0, length);
}
```

```
Time:  O(n)
Space: O(n)
Key insight: The KMP failure function at the last index gives exactly the length
  of the longest proper prefix that is also a suffix. This problem literally asks
  for the definition of the failure function.
```

---

**P15.60** [M] -- String Matching: Z-Algorithm Implementation

Implement the Z-algorithm and use it for pattern matching.

```
Pattern: Z-array construction.
Z[i] = length of the longest substring starting at i that matches a prefix of the string.
```

```java
public List<Integer> zSearch(String text, String pattern) {
    String combined = pattern + "$" + text;
    int n = combined.length();
    int m = pattern.length();
    int[] z = new int[n];
    
    // Z-algorithm
    int left = 0, right = 0;
    for (int i = 1; i < n; i++) {
        if (i < right) {
            z[i] = Math.min(right - i, z[i - left]);
        }
        while (i + z[i] < n && combined.charAt(z[i]) == combined.charAt(i + z[i])) {
            z[i]++;
        }
        if (i + z[i] > right) {
            left = i;
            right = i + z[i];
        }
    }
    
    // Find matches
    List<Integer> matches = new ArrayList<>();
    for (int i = m + 1; i < n; i++) {
        if (z[i] == m) {
            matches.add(i - m - 1);  // position in original text
        }
    }
    
    return matches;
}
```

```
Time:  O(n + m)
Space: O(n + m)
Key insight: The Z-algorithm maintains a "Z-box" [left, right) — the rightmost
  interval [i, i+z[i]) seen so far. When computing z[i], if i falls inside the
  current Z-box, we can use previously computed Z-values as a starting point.
  This amortizes the character comparisons to O(n + m) total.
When to use Z vs KMP: Z-algorithm is often simpler to implement and reason about.
  KMP is more traditional. Both achieve O(n+m). Z-algorithm also directly solves
  "longest common prefix" variants that KMP handles less naturally.
```

---

## Additional Problems (P15.61 -- P15.80)

The remaining problems cover cross-pattern combinations and harder variants that synthesize multiple techniques from this chapter.

---

**P15.61** [M] -- Longest Palindromic Substring (LeetCode 5)

Find the longest palindromic substring.

```
Pattern: Expand around center — a two-pointer variant.
Core idea: For each possible center (n single chars + n-1 gaps = 2n-1 centers),
  expand outward while characters match.
```

```java
public String longestPalindrome(String s) {
    int start = 0, maxLen = 0;
    
    for (int i = 0; i < s.length(); i++) {
        // Odd length palindrome centered at i
        int len1 = expandAroundCenter(s, i, i);
        // Even length palindrome centered between i and i+1
        int len2 = expandAroundCenter(s, i, i + 1);
        int len = Math.max(len1, len2);
        
        if (len > maxLen) {
            maxLen = len;
            start = i - (len - 1) / 2;
        }
    }
    
    return s.substring(start, start + maxLen);
}

private int expandAroundCenter(String s, int left, int right) {
    while (left >= 0 && right < s.length() && s.charAt(left) == s.charAt(right)) {
        left--;
        right++;
    }
    return right - left - 1;
}
```

```
Time:  O(n^2) worst case, but much faster on average
Space: O(1)
Note: Manacher's algorithm solves this in O(n), but it is rarely expected in
  interviews. The expand-around-center approach is clean, correct, and fast enough.
```

---

**P15.62** [H] -- Longest Palindromic Subsequence (LeetCode 516)

Find the length of the longest palindromic subsequence.

```
Pattern: 2D DP (covered in depth in Chapter 17, but included here for completeness).
Core idea: dp[i][j] = longest palindromic subsequence in s[i..j].
  If s[i] == s[j]: dp[i][j] = dp[i+1][j-1] + 2
  Else: dp[i][j] = max(dp[i+1][j], dp[i][j-1])
```

```java
public int longestPalindromeSubseq(String s) {
    int n = s.length();
    int[] dp = new int[n];  // space-optimized: only need previous row
    int[] dpPrev = new int[n];
    
    // Fill diagonally: length 1, then 2, then 3, ...
    for (int i = n - 1; i >= 0; i--) {
        dp[i] = 1;  // single character is a palindrome
        for (int j = i + 1; j < n; j++) {
            if (s.charAt(i) == s.charAt(j)) {
                dp[j] = dpPrev[j - 1] + 2;
            } else {
                dp[j] = Math.max(dpPrev[j], dp[j - 1]);
            }
        }
        // Save current dp as dpPrev for next iteration
        int[] tmp = dpPrev;
        dpPrev = dp;
        dp = tmp;
    }
    
    return dpPrev[n - 1];
}
```

```
Time:  O(n^2)
Space: O(n) with space optimization (two 1D arrays instead of 2D)
```

---

**P15.63** [M] -- Group Anagrams (LeetCode 49)

Group strings that are anagrams of each other.

```
Pattern: Hash map with sorted-string key (or frequency-count key).
```

```java
public List<List<String>> groupAnagrams(String[] strs) {
    Map<String, List<String>> map = new HashMap<>();
    
    for (String s : strs) {
        char[] chars = s.toCharArray();
        Arrays.sort(chars);
        String key = new String(chars);
        
        map.computeIfAbsent(key, k -> new ArrayList<>()).add(s);
    }
    
    return new ArrayList<>(map.values());
}
```

Frequency-count key (avoids sorting, O(k) per string where k = string length):

```java
public List<List<String>> groupAnagramsFreq(String[] strs) {
    Map<String, List<String>> map = new HashMap<>();
    
    for (String s : strs) {
        int[] freq = new int[26];
        for (char c : s.toCharArray()) freq[c - 'a']++;
        
        // Build a canonical key from frequency counts
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 26; i++) {
            sb.append('#').append(freq[i]);
        }
        String key = sb.toString();
        
        map.computeIfAbsent(key, k -> new ArrayList<>()).add(s);
    }
    
    return new ArrayList<>(map.values());
}
```

```
Time:  Sort approach: O(n * k log k). Frequency approach: O(n * k).
Space: O(n * k)
Key insight: The frequency approach avoids sorting and is asymptotically faster.
  The key "#1#0#0#...#0" is unique per anagram group. The '#' separator prevents
  ambiguity (e.g., frequency 1,12 vs 11,2).
JVM note: computeIfAbsent() is a single hash table lookup+insertion — more efficient
  than getOrDefault followed by a separate put.
```

---

**P15.64** [M] -- Encode and Decode Strings (LeetCode 271)

Design an algorithm to encode a list of strings into a single string and decode it back.

```
Pattern: Length-prefixed encoding.
Core idea: For each string, write its length, a delimiter, then the string itself.
  This handles any character in the strings, including the delimiter itself.
```

```java
public String encode(List<String> strs) {
    StringBuilder sb = new StringBuilder();
    for (String s : strs) {
        sb.append(s.length()).append('#').append(s);
    }
    return sb.toString();
}

public List<String> decode(String s) {
    List<String> result = new ArrayList<>();
    int i = 0;
    
    while (i < s.length()) {
        int hashIdx = s.indexOf('#', i);
        int len = Integer.parseInt(s.substring(i, hashIdx));
        String str = s.substring(hashIdx + 1, hashIdx + 1 + len);
        result.add(str);
        i = hashIdx + 1 + len;
    }
    
    return result;
}
```

```
Time:  O(n) for encode and decode, where n = total characters
Space: O(n)
Real-world: This is exactly how HTTP/2 frames encode headers — length-prefixed
  fields. Protocol buffers (protobuf) use the same encoding for string fields:
  varint-encoded length followed by raw bytes. Redis's RESP protocol uses
  "$<length>\r\n<data>\r\n" — same principle.
```

---

**P15.65** [M] -- Rotate Array (LeetCode 189)

Rotate an array to the right by `k` steps.

```
Pattern: Three reverses (reverse all, reverse first k, reverse rest).
Core idea: Reversing the entire array and then reversing the two halves achieves rotation.
```

```java
public void rotate(int[] nums, int k) {
    int n = nums.length;
    k = k % n;  // handle k > n
    
    reverse(nums, 0, n - 1);      // reverse all
    reverse(nums, 0, k - 1);      // reverse first k
    reverse(nums, k, n - 1);      // reverse rest
}

private void reverse(int[] nums, int start, int end) {
    while (start < end) {
        int tmp = nums[start];
        nums[start] = nums[end];
        nums[end] = tmp;
        start++;
        end--;
    }
}
```

```
Time:  O(n)
Space: O(1) — in-place
Why three reverses work: Let the array be [A | B] where B is the last k elements.
  We want [B | A].
  Reverse all:   [A | B] → [B_rev | A_rev]
  Reverse B_rev: [B | A_rev]
  Reverse A_rev: [B | A]
  This is the standard rotation trick used in block-swap algorithms.
JVM note: System.arraycopy could achieve this with a temporary buffer in O(k) extra
  space. The three-reverse approach trades space for no allocation.
```

---

**P15.66** [M] -- Next Permutation (LeetCode 31)

Implement next permutation, rearranging numbers into the lexicographically next greater permutation.

```
Pattern: Find the rightmost ascending pair, swap, reverse suffix.
```

```java
public void nextPermutation(int[] nums) {
    int n = nums.length;
    
    // Step 1: Find the largest index i such that nums[i] < nums[i+1]
    int i = n - 2;
    while (i >= 0 && nums[i] >= nums[i + 1]) {
        i--;
    }
    
    if (i >= 0) {
        // Step 2: Find the largest index j such that nums[j] > nums[i]
        int j = n - 1;
        while (nums[j] <= nums[i]) {
            j--;
        }
        // Step 3: Swap nums[i] and nums[j]
        swap(nums, i, j);
    }
    
    // Step 4: Reverse the suffix starting at i+1
    reverse(nums, i + 1, n - 1);
}

private void swap(int[] nums, int i, int j) {
    int tmp = nums[i];
    nums[i] = nums[j];
    nums[j] = tmp;
}

private void reverse(int[] nums, int start, int end) {
    while (start < end) {
        swap(nums, start, end);
        start++;
        end--;
    }
}
```

```
Time:  O(n)
Space: O(1)
Key insight: The suffix after index i is in descending order (otherwise i would be
  further right). After swapping nums[i] with the smallest element larger than it
  in the suffix, the suffix is still descending. Reversing it makes it ascending —
  the smallest possible suffix, giving the next permutation.
```

---

**P15.67** [E] -- Is Subsequence (LeetCode 392)

Given strings `s` and `t`, check if `s` is a subsequence of `t`.

```
Pattern: Two pointers (same direction), one on each string.
```

```java
public boolean isSubsequence(String s, String t) {
    int i = 0, j = 0;
    
    while (i < s.length() && j < t.length()) {
        if (s.charAt(i) == t.charAt(j)) {
            i++;
        }
        j++;
    }
    
    return i == s.length();
}
```

```
Time:  O(n) where n = t.length()
Space: O(1)
Follow-up: If there are many s queries against the same t, preprocess t into a
  map of character → sorted list of indices. For each character in s, binary search
  for the next valid index in t. This gives O(m * log n) per query after O(n)
  preprocessing.
```

---

**P15.68** [M] -- Spiral Matrix (LeetCode 54)

Return all elements of an m x n matrix in spiral order.

```
Pattern: Layer-by-layer traversal with four boundaries.
```

```java
public List<Integer> spiralOrder(int[][] matrix) {
    List<Integer> result = new ArrayList<>();
    int top = 0, bottom = matrix.length - 1;
    int left = 0, right = matrix[0].length - 1;
    
    while (top <= bottom && left <= right) {
        // Traverse right
        for (int j = left; j <= right; j++) result.add(matrix[top][j]);
        top++;
        
        // Traverse down
        for (int i = top; i <= bottom; i++) result.add(matrix[i][right]);
        right--;
        
        // Traverse left (check if there is still a row)
        if (top <= bottom) {
            for (int j = right; j >= left; j--) result.add(matrix[bottom][j]);
            bottom--;
        }
        
        // Traverse up (check if there is still a column)
        if (left <= right) {
            for (int i = bottom; i >= top; i--) result.add(matrix[i][left]);
            left++;
        }
    }
    
    return result;
}
```

```
Time:  O(m * n)
Space: O(1) extra (result does not count)
Key insight: The boundary checks (top <= bottom, left <= right) before the third
  and fourth traversals prevent revisiting elements in non-square matrices.
  Without these checks, a single-row or single-column matrix would traverse
  elements twice.
```

---

**P15.69** [M] -- Set Matrix Zeroes (LeetCode 73)

If an element is 0, set its entire row and column to 0. Do it in-place.

```
Pattern: Use first row and first column as markers.
```

```java
public void setZeroes(int[][] matrix) {
    int m = matrix.length, n = matrix[0].length;
    boolean firstRowZero = false, firstColZero = false;
    
    // Check if first row/col should be zeroed
    for (int j = 0; j < n; j++) if (matrix[0][j] == 0) firstRowZero = true;
    for (int i = 0; i < m; i++) if (matrix[i][0] == 0) firstColZero = true;
    
    // Use first row/col as markers
    for (int i = 1; i < m; i++) {
        for (int j = 1; j < n; j++) {
            if (matrix[i][j] == 0) {
                matrix[i][0] = 0;
                matrix[0][j] = 0;
            }
        }
    }
    
    // Zero out based on markers
    for (int i = 1; i < m; i++) {
        for (int j = 1; j < n; j++) {
            if (matrix[i][0] == 0 || matrix[0][j] == 0) {
                matrix[i][j] = 0;
            }
        }
    }
    
    // Handle first row and column
    if (firstRowZero) for (int j = 0; j < n; j++) matrix[0][j] = 0;
    if (firstColZero) for (int i = 0; i < m; i++) matrix[i][0] = 0;
}
```

```
Time:  O(m * n)
Space: O(1) — using the matrix itself as storage
Key insight: The first row and column serve as auxiliary arrays. We need two
  boolean flags to remember if the first row/column themselves should be zeroed
  (since we overwrite their original values during marking).
```

---

**P15.70** [E] -- Merge Sorted Array (LeetCode 88)

Merge two sorted arrays into the first array. `nums1` has enough space.

```
Pattern: Three pointers from the end (reverse merge — fills from right to left).
```

```java
public void merge(int[] nums1, int m, int[] nums2, int n) {
    int i = m - 1;      // pointer in nums1's valid elements
    int j = n - 1;      // pointer in nums2
    int k = m + n - 1;  // write pointer in nums1
    
    while (i >= 0 && j >= 0) {
        if (nums1[i] > nums2[j]) {
            nums1[k--] = nums1[i--];
        } else {
            nums1[k--] = nums2[j--];
        }
    }
    
    // Copy remaining elements from nums2 (if any)
    while (j >= 0) {
        nums1[k--] = nums2[j--];
    }
    // No need to copy remaining nums1 elements — they are already in place
}
```

```
Time:  O(m + n)
Space: O(1)
Key insight: Merge from the end. This avoids overwriting elements in nums1 that
  we have not processed yet. The trick is that the "empty" space in nums1 is at
  the end, so we fill it from right to left.
Real-world: This is exactly how merge sort's merge step works, except merge sort
  typically uses a temporary buffer. The in-place merge-from-the-end trick is used
  in compaction phases of storage engines.
```

---

**P15.71** [M] -- Valid Palindrome II (LeetCode 680)

Given a string, determine if it can be a palindrome after deleting at most one character.

```
Pattern: Two pointers from opposite ends + one recursive check.
```

```java
public boolean validPalindrome(String s) {
    int left = 0, right = s.length() - 1;
    
    while (left < right) {
        if (s.charAt(left) != s.charAt(right)) {
            // Try deleting either left or right character
            return isPalindrome(s, left + 1, right) || isPalindrome(s, left, right - 1);
        }
        left++;
        right--;
    }
    
    return true;
}

private boolean isPalindrome(String s, int left, int right) {
    while (left < right) {
        if (s.charAt(left) != s.charAt(right)) return false;
        left++;
        right--;
    }
    return true;
}
```

```
Time:  O(n)
Space: O(1)
Key insight: We only need to branch once (at the first mismatch). If neither branch
  produces a palindrome, the string cannot become one with a single deletion. This is
  because any further mismatches within the branch would require additional deletions.
```

---

**P15.72** [M] -- String Compression (LeetCode 443)

Compress a character array in-place: consecutive duplicates become char + count.

```
Pattern: Two pointers — read (fast) and write (slow).
```

```java
public int compress(char[] chars) {
    int write = 0;  // slow: write position
    int read = 0;   // fast: read position
    
    while (read < chars.length) {
        char current = chars[read];
        int count = 0;
        
        // Count consecutive characters
        while (read < chars.length && chars[read] == current) {
            read++;
            count++;
        }
        
        // Write character
        chars[write++] = current;
        
        // Write count (if > 1)
        if (count > 1) {
            for (char c : String.valueOf(count).toCharArray()) {
                chars[write++] = c;
            }
        }
    }
    
    return write;
}
```

```
Time:  O(n)
Space: O(1) — in-place
Key insight: The write pointer is always <= the read pointer (compression never
  makes the string longer for single characters, and multi-digit counts only
  appear for runs longer than the digits themselves). So in-place writing is safe.
```

---

**P15.73** [M] -- Minimum Number of Swaps to Make the String Balanced (LeetCode 1963)

Given a string of `[` and `]` brackets, find the minimum number of swaps to make it balanced.

```
Pattern: Greedy with balance counter.
```

```java
public int minSwaps(String s) {
    int unmatched = 0;  // count of unmatched ']'
    int open = 0;       // count of unmatched '['
    
    for (char c : s.toCharArray()) {
        if (c == '[') {
            open++;
        } else {
            if (open > 0) {
                open--;  // matched with a previous '['
            } else {
                unmatched++;  // unmatched ']'
            }
        }
    }
    
    // Each swap fixes two unmatched brackets
    return (unmatched + 1) / 2;
}
```

```
Time:  O(n)
Space: O(1)
Key insight: After greedily matching brackets, the remaining unmatched brackets
  form a pattern like ]]]...[[[... Each swap can fix two unmatched pairs, so we
  need ceil(unmatched / 2) swaps.
```

---

**P15.74** [H] -- Minimum Window Subsequence (LeetCode 727)

Given strings `s1` and `s2`, find the minimum window in `s1` such that `s2` is a subsequence of the window.

```
Pattern: Forward pass to find a window, backward pass to minimize it.
```

```java
public String minWindowSubsequence(String s1, String s2) {
    int m = s1.length(), n = s2.length();
    int minLen = Integer.MAX_VALUE;
    int start = -1;
    
    int j = 0;  // pointer in s2
    
    for (int i = 0; i < m; i++) {
        if (s1.charAt(i) == s2.charAt(j)) {
            j++;
            if (j == n) {
                // Found a window ending at i. Now minimize it by scanning backward.
                int end = i;
                j--;
                while (j >= 0) {
                    if (s1.charAt(i) == s2.charAt(j)) j--;
                    i--;
                }
                i++;  // i now points to the start of the minimum window
                j = 0;
                
                if (end - i + 1 < minLen) {
                    minLen = end - i + 1;
                    start = i;
                }
            }
        }
    }
    
    return start == -1 ? "" : s1.substring(start, start + minLen);
}
```

```
Time:  O(m * n) worst case
Space: O(1)
Key insight: After finding a window where s2 is a subsequence, we scan backward
  from the end of the window to find the latest valid start. This minimizes the
  window without missing any potential overlapping windows.
```

---

**P15.75** [H] -- Longest Substring with At Most Two Distinct Characters (LeetCode 159)

Find the length of the longest substring containing at most 2 distinct characters.

```
Pattern: This is Fruit Into Baskets (P15.16) on a string. Variable sliding window.
```

```java
public int lengthOfLongestSubstringTwoDistinct(String s) {
    int[] freq = new int[128];
    int distinct = 0;
    int left = 0;
    int maxLen = 0;
    
    for (int right = 0; right < s.length(); right++) {
        if (freq[s.charAt(right)] == 0) distinct++;
        freq[s.charAt(right)]++;
        
        while (distinct > 2) {
            freq[s.charAt(left)]--;
            if (freq[s.charAt(left)] == 0) distinct--;
            left++;
        }
        
        maxLen = Math.max(maxLen, right - left + 1);
    }
    
    return maxLen;
}
```

```
Time:  O(n)
Space: O(1)
```

---

**P15.76** [H] -- Sliding Window Median (LeetCode 480)

Find the median of each sliding window of size `k`.

```
Pattern: Two heaps (max-heap for lower half, min-heap for upper half) with lazy deletion.
```

```java
public double[] medianSlidingWindow(int[] nums, int k) {
    // Max-heap for lower half, min-heap for upper half
    TreeMap<int[], Integer> lo = new TreeMap<>((a, b) -> a[0] != b[0] ? Integer.compare(a[0], b[0]) : Integer.compare(a[1], b[1]));
    TreeMap<int[], Integer> hi = new TreeMap<>((a, b) -> a[0] != b[0] ? Integer.compare(a[0], b[0]) : Integer.compare(a[1], b[1]));
    // Simpler approach using two TreeMaps with (value, index) pairs for uniqueness
    
    // Alternative clean approach: use a sorted structure
    double[] result = new double[nums.length - k + 1];
    
    // Use a sortable multiset via TreeMap<Integer, Integer> (value → count)
    // But for cleaner code, use the two-heap simulation:
    
    int[] sortedWindow = new int[k];
    for (int i = 0; i < k; i++) sortedWindow[i] = nums[i];
    Arrays.sort(sortedWindow);
    result[0] = median(sortedWindow, k);
    
    // For each new window, remove the outgoing element and insert the incoming.
    // Use insertion sort maintenance for small k, or balanced BST for large k.
    
    return result;  // simplified — see full solution below
}

// Clean O(n * k) approach (sufficient for most interview contexts):
public double[] medianSlidingWindowSimple(int[] nums, int k) {
    double[] result = new double[nums.length - k + 1];
    List<Integer> window = new ArrayList<>();
    
    for (int i = 0; i < nums.length; i++) {
        // Insert nums[i] in sorted position
        int pos = Collections.binarySearch(window, nums[i]);
        if (pos < 0) pos = -pos - 1;
        window.add(pos, nums[i]);
        
        // Remove outgoing element
        if (window.size() > k) {
            int removeIdx = Collections.binarySearch(window, nums[i - k]);
            window.remove(removeIdx);
        }
        
        if (window.size() == k) {
            if (k % 2 == 0) {
                result[i - k + 1] = ((double) window.get(k / 2 - 1) + window.get(k / 2)) / 2.0;
            } else {
                result[i - k + 1] = window.get(k / 2);
            }
        }
    }
    
    return result;
}

private double median(int[] sorted, int k) {
    if (k % 2 == 0) return ((double) sorted[k / 2 - 1] + sorted[k / 2]) / 2.0;
    return sorted[k / 2];
}
```

```
Time:  O(n * k) for the insertion-sort-based approach. O(n * log k) with two
  TreeMaps or a balanced BST. The interview usually accepts O(n * k).
Space: O(k)
Key insight: Maintaining a sorted window structure where insertion and deletion
  are both efficient is the core challenge. A sorted ArrayList gives O(log k)
  binary search but O(k) insertion (shift elements). Two heaps with lazy deletion
  give O(log k) amortized but are much harder to implement correctly.
```

---

**P15.77** [H] -- Minimum Number of K Consecutive Bit Flips (LeetCode 995)

Given a binary array, find the minimum number of flips of k consecutive bits to make all elements 1.

```
Pattern: Greedy + difference array to track flip state.
Core idea: Scan left to right. When we encounter a 0 (after accounting for
  accumulated flips), we must flip the k-length window starting here. Track
  flips using a difference array to know how many flips affect each position.
```

```java
public int minKBitFlips(int[] nums, int k) {
    int n = nums.length;
    int[] flipDiff = new int[n + 1];  // difference array for flip counts
    int currentFlips = 0;
    int totalFlips = 0;
    
    for (int i = 0; i < n; i++) {
        currentFlips += flipDiff[i];
        
        // After all accumulated flips, is this position still 0?
        if ((nums[i] + currentFlips) % 2 == 0) {
            if (i + k > n) return -1;  // cannot flip — window extends beyond array
            
            flipDiff[i] += 1;
            flipDiff[i + k] -= 1;
            currentFlips += 1;
            totalFlips++;
        }
    }
    
    return totalFlips;
}
```

```
Time:  O(n)
Space: O(n) for the difference array
Key insight: The difference array tracks the cumulative number of flips affecting
  each position without actually flipping k elements each time. This reduces
  each flip operation from O(k) to O(1). The greedy strategy (flip at the leftmost
  0) is optimal because delaying a flip cannot help — the 0 must be flipped
  eventually, and flipping earlier does not create more 0s to the left.
```

---

**P15.78** [H] -- Count Unique Characters of All Substrings (LeetCode 828)

For each substring, count the number of unique characters (characters that appear exactly once). Sum these counts over all substrings.

```
Pattern: Contribution counting — for each character occurrence, compute how many
  substrings it is unique in.
Core idea: Character at position i is unique in a substring [l, r] if and only if
  there is no other occurrence of the same character in [l, r]. If the previous
  occurrence is at index prev and the next is at index next, then l can range from
  (prev+1) to i and r can range from i to (next-1). Total contribution: 
  (i - prev) * (next - i).
```

```java
public int uniqueLetterString(String s) {
    int n = s.length();
    int[][] lastTwo = new int[26][2];  // for each char: [secondToLast, last] occurrence
    
    for (int[] pair : lastTwo) Arrays.fill(pair, -1);
    
    int result = 0;
    
    for (int i = 0; i < n; i++) {
        int c = s.charAt(i) - 'A';
        int prev = lastTwo[c][1];
        int prevPrev = lastTwo[c][0];
        
        // Contribution of this occurrence: extends from (prev+1) to i on the left,
        // and we will compute right extent when the next occurrence comes.
        // Instead, compute contribution of the PREVIOUS occurrence now that we know
        // its right boundary is i.
        // Actually, use the standard formula: contribution at each step.
        
        // Simpler approach: running sum.
        // Let's track the contribution differently.
        
        lastTwo[c][0] = lastTwo[c][1];
        lastTwo[c][1] = i;
    }
    
    // Clean approach:
    return uniqueLetterStringClean(s);
}

public int uniqueLetterStringClean(String s) {
    int n = s.length();
    // For each character position, find previous and next occurrence of the same char
    int[] prev = new int[n];  // previous occurrence of same character
    int[] next = new int[n];  // next occurrence of same character
    int[] lastSeen = new int[26];
    Arrays.fill(lastSeen, -1);
    
    for (int i = 0; i < n; i++) {
        int c = s.charAt(i) - 'A';
        prev[i] = lastSeen[c];
        lastSeen[c] = i;
    }
    
    Arrays.fill(lastSeen, n);
    for (int i = n - 1; i >= 0; i--) {
        int c = s.charAt(i) - 'A';
        next[i] = lastSeen[c];
        lastSeen[c] = i;
    }
    
    long result = 0;
    for (int i = 0; i < n; i++) {
        result += (long)(i - prev[i]) * (next[i] - i);
    }
    
    return (int) result;
}
```

```
Time:  O(n)
Space: O(n) for prev[] and next[] arrays
Key insight: Instead of iterating over all O(n^2) substrings, compute each character's
  contribution: in how many substrings is it the only occurrence of that character?
  This "contribution to the count" technique transforms O(n^2) or O(n^3) problems
  into O(n). It appears in many "sum over all subarrays" problems.
```

---

**P15.79** [H] -- Minimum Operations to Reduce X to Zero (LeetCode 1658)

Given an array and integer `x`, find the minimum number of operations to reduce `x` to zero. Each operation removes either the leftmost or rightmost element.

```
Pattern: Complement — find the LONGEST subarray with sum = totalSum - x.
Core idea: Removing elements from both ends to reach sum x is equivalent to
  keeping a contiguous middle subarray with sum = totalSum - x. Maximize the
  length of this middle subarray → minimize the number of removed elements.
```

```java
public int minOperations(int[] nums, int x) {
    int totalSum = 0;
    for (int num : nums) totalSum += num;
    
    int target = totalSum - x;
    if (target < 0) return -1;
    if (target == 0) return nums.length;
    
    // Find longest subarray with sum = target (all elements positive → sliding window)
    int left = 0;
    int currentSum = 0;
    int maxLen = -1;
    
    for (int right = 0; right < nums.length; right++) {
        currentSum += nums[right];
        
        while (currentSum > target) {
            currentSum -= nums[left];
            left++;
        }
        
        if (currentSum == target) {
            maxLen = Math.max(maxLen, right - left + 1);
        }
    }
    
    return maxLen == -1 ? -1 : nums.length - maxLen;
}
```

```
Time:  O(n)
Space: O(1)
Key insight: The complement trick — "minimize elements removed from ends" becomes
  "maximize contiguous middle." Since all elements are positive, the middle subarray
  sum is monotonic with window size, so sliding window works. This is a pattern:
  many "remove from ends" problems are secretly "find in the middle" problems.
```

---

**P15.80** [H] -- Maximum Number of Visible Points (LeetCode 1610)

Given points on a 2D plane, your location, and a viewing angle, find the maximum number of points visible within the angle.

```
Pattern: Angular sweep + fixed-size sliding window on sorted angles.
Core idea: Convert all points to angles relative to your position. Sort the angles.
  Use a sliding window of size corresponding to the viewing angle.
  Handle the circular nature by duplicating the array (add 360 degrees to each angle).
```

```java
public int visiblePoints(List<List<Integer>> points, int angle, List<Integer> location) {
    int atLocation = 0;
    List<Double> angles = new ArrayList<>();
    
    int lx = location.get(0), ly = location.get(1);
    
    for (List<Integer> p : points) {
        int px = p.get(0), py = p.get(1);
        if (px == lx && py == ly) {
            atLocation++;  // always visible
        } else {
            double a = Math.toDegrees(Math.atan2(py - ly, px - lx));
            if (a < 0) a += 360;
            angles.add(a);
        }
    }
    
    Collections.sort(angles);
    
    // Duplicate for circular handling
    int n = angles.size();
    for (int i = 0; i < n; i++) {
        angles.add(angles.get(i) + 360);
    }
    
    // Sliding window: find max points within 'angle' degrees
    int maxVisible = 0;
    int left = 0;
    
    for (int right = 0; right < angles.size(); right++) {
        while (angles.get(right) - angles.get(left) > angle) {
            left++;
        }
        maxVisible = Math.max(maxVisible, right - left + 1);
    }
    
    return maxVisible + atLocation;
}
```

```
Time:  O(n log n) for sorting
Space: O(n)
Key insight: The circular angle problem is solved by duplicating the sorted angle
  array with +360 offsets. This linearizes the circular structure, allowing a
  standard sliding window. The same duplication trick works for any circular
  sliding window problem.
```

---

## Key Takeaways

**1. Pattern recognition is the multiplier.** The 80 problems in this chapter reduce to 8 templates. In an interview, identifying the pattern within the first minute gives you 40 minutes to implement and optimize, instead of 40 minutes to figure out the approach.

**2. Sliding window (both variants) solves the most problems per template.** If you master nothing else, master sliding window. Fixed window for "k-size" problems, variable window for "minimum/maximum satisfying condition" problems. The variable-size template (expand right, shrink left) covers an enormous problem family.

**3. "Exactly K = AtMost(K) - AtMost(K-1)" is the most powerful reduction.** This identity transforms hard counting problems (exactly K distinct, exactly K occurrences) into two applications of the standard variable sliding window template. Memorize it.

**4. Two-pointer opposite direction requires sorted input.** Without sorted order (or some monotonic structure), you cannot reason about which pointer to move. When the input is not sorted but the problem has two-pointer structure, sort it first (paying O(n log n)).

**5. Same-direction two pointers are really about partitioning.** The slow pointer marks the boundary of the "processed" region. The fast pointer scans for elements to bring into that region. This is the in-place modification pattern for arrays.

**6. Prefix sum turns range queries from O(n) to O(1).** Difference array turns range updates from O(n) to O(1). Together, they are the array analog of lazy propagation in segment trees. When you see "range" and "query" or "update" in the same problem, think prefix sum or difference array first.

**7. Binary search on answer is the most underrecognized pattern.** Many problems that look like optimization problems ("minimize the maximum," "find the minimum capacity") are actually binary search on the answer space with a greedy feasibility check. The feasibility predicate must be monotonic.

**8. Kadane's algorithm is a special case of DP, but learn it as its own pattern.** The "extend or restart" decision is so common (max subarray, max product, max circular) that it deserves its own muscle memory. The variant tracking both max and min (for products with negatives) is especially important.

**9. KMP's failure function solves more problems than KMP matching.** The failure function (longest proper prefix which is also a suffix) directly solves "repeated substring," "shortest palindrome," and "longest happy prefix." Learn the failure function construction independently of the matching algorithm.

**10. Real-world systems use these patterns at every layer.** TCP sliding windows, Prometheus `rate()`, `git bisect`, Kafka log compaction, database index lookups, network packet inspection -- these are not analogies. They are literal implementations of the patterns in this chapter. The interview is testing whether you recognize the same structure in a different context.

---

*Next: [Chapter 16: Patterns -- Trees & Graphs](16-pattern-trees-graphs.md) -- BFS/DFS traversal patterns, topological sort, Union-Find, shortest paths, tree recursion, and LCA.*

*Previous: [Chapter 14: Application Domains](14-use-cases-application-domains.md)*
