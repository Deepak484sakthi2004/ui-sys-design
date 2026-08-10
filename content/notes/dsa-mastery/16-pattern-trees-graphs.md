# Chapter 16: Patterns -- Trees & Graphs

## Every System You Have Built Is a Tree or a Graph. Now Learn to Solve Them Under Pressure.

You have spent 15 years building systems that are, at their core, trees and graphs. Your microservice call graph is a directed graph. Your Gradle build files form a DAG. Your DNS resolution walks a tree from root to TLD to domain. Your garbage collector performs BFS from GC roots. Your Kafka consumer group rebalancing computes a bipartite matching on a graph. Your database query planner walks a tree of execution nodes.

This chapter is not about learning BFS and DFS from scratch -- Chapter 10 already covered the algorithms in detail. This chapter is about **pattern recognition**. When you see a problem, you need to identify which tree or graph pattern applies, reach for the right template, and adapt it to the specific constraints. After this chapter, you will not think "this looks like a graph problem." You will think "this is multi-source BFS with state expansion, and I know the exact template."

We cover seven patterns. Each pattern includes recognition triggers, a reusable Java template, real-world correlations to systems you have already built, and 8-12 problems with full solutions. Every problem includes time/space complexity analysis, JVM-level insights, and a real-world mapping.

The patterns:

1. **BFS (Breadth-First Search)** -- level-order, multi-source, 0-1 BFS, bidirectional
2. **DFS (Depth-First Search)** -- recursive, iterative, traversal orders, graph DFS
3. **Tree Recursion (Post-order / Bottom-up)** -- solve children first, combine for parent
4. **Topological Sort** -- dependency ordering via Kahn's and DFS
5. **Union-Find Patterns** -- dynamic connectivity, component merging
6. **Shortest Path Patterns** -- Dijkstra, Bellman-Ford, BFS variants
7. **Lowest Common Ancestor (LCA)** -- brute force to binary lifting

75 problems total: 19 Easy, 37 Medium, 19 Hard.

---

## 16.1 Pattern 1: BFS (Breadth-First Search)

### What It Is

BFS explores a graph or tree level by level, visiting all nodes at distance `d` before any node at distance `d+1`. It uses a queue (FIFO) as its core data structure. In Java, that queue is `ArrayDeque` -- never `LinkedList`, because `ArrayDeque` is backed by a circular array with cache-friendly sequential access, while `LinkedList` allocates a separate `Node` object per element, each with `prev`/`next` pointers, scattered across the heap.

The fundamental guarantee of BFS: **the first time a node is dequeued, the path that reached it is the shortest path** (in an unweighted graph or when all edge weights are equal). This is the single most important property in competitive problem-solving. If a problem asks for "shortest", "minimum steps", "fewest moves", or "nearest" in an unweighted or unit-weighted context, BFS is your first instinct.

### Recognition Triggers

- "Shortest path" in an unweighted graph
- "Minimum number of steps/moves/operations"
- "Level by level" or "layer by layer"
- "Nearest" or "closest" (from one or multiple sources)
- Grid problems asking for minimum distance
- "All nodes at distance K"
- Word transformation with minimum steps
- State-space exploration with unit cost transitions

### Sub-patterns

#### Sub-pattern 1A: Standard BFS with Queue

The simplest form. Start from a source, explore neighbors level by level, mark visited.

```java
// Template: Standard BFS on adjacency list graph
public int bfs(List<List<Integer>> graph, int source, int target) {
    int n = graph.size();
    boolean[] visited = new boolean[n];
    Queue<Integer> queue = new ArrayDeque<>();
    
    queue.offer(source);
    visited[source] = true;
    int distance = 0;
    
    while (!queue.isEmpty()) {
        int size = queue.size(); // snapshot current level size
        for (int i = 0; i < size; i++) {
            int node = queue.poll();
            if (node == target) return distance;
            
            for (int neighbor : graph.get(node)) {
                if (!visited[neighbor]) {
                    visited[neighbor] = true; // mark when ENQUEUING, not dequeuing
                    queue.offer(neighbor);
                }
            }
        }
        distance++;
    }
    return -1; // target unreachable
}
```

**Critical JVM detail**: Mark visited when enqueuing, not when dequeuing. If you mark when dequeuing, the same node can be added to the queue multiple times by different predecessors. For a grid of 1000x1000, this can mean the queue grows to millions of entries instead of at most 1,000,000, causing `OutOfMemoryError` on constrained heaps.

#### Sub-pattern 1B: Level-Order BFS (the `queue.size()` trick)

When you need to process nodes level by level -- not just find the shortest distance, but do something with each complete level -- you snapshot the queue size at the start of each level:

```java
// Template: Level-order traversal of binary tree
public List<List<Integer>> levelOrder(TreeNode root) {
    List<List<Integer>> result = new ArrayList<>();
    if (root == null) return result;
    
    Queue<TreeNode> queue = new ArrayDeque<>();
    queue.offer(root);
    
    while (!queue.isEmpty()) {
        int levelSize = queue.size(); // HOW MANY NODES IN THIS LEVEL
        List<Integer> currentLevel = new ArrayList<>(levelSize);
        
        for (int i = 0; i < levelSize; i++) {
            TreeNode node = queue.poll();
            currentLevel.add(node.val);
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
        result.add(currentLevel);
    }
    return result;
}
```

The `queue.size()` trick works because after processing all nodes at level `d`, the queue contains exactly the nodes at level `d+1`. By snapshotting the size before the inner loop, we process exactly one level per outer iteration.

#### Sub-pattern 1C: Multi-Source BFS

When the problem has multiple starting points and asks "what is the nearest source to each cell?" -- add ALL sources to the queue initially. The BFS then expands from all sources simultaneously, like dropping multiple stones in a pond.

```java
// Template: Multi-source BFS on a grid
public int[][] multiSourceBFS(int[][] grid, List<int[]> sources) {
    int m = grid.length, n = grid[0].length;
    int[][] dist = new int[m][n];
    for (int[] row : dist) Arrays.fill(row, Integer.MAX_VALUE);
    
    Queue<int[]> queue = new ArrayDeque<>();
    
    // Enqueue ALL sources at distance 0
    for (int[] src : sources) {
        queue.offer(src);
        dist[src[0]][src[1]] = 0;
    }
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    
    while (!queue.isEmpty()) {
        int[] cell = queue.poll();
        int r = cell[0], c = cell[1];
        
        for (int[] d : dirs) {
            int nr = r + d[0], nc = c + d[1];
            if (nr >= 0 && nr < m && nc >= 0 && nc < n
                && dist[nr][nc] == Integer.MAX_VALUE) {
                dist[nr][nc] = dist[r][c] + 1;
                queue.offer(new int[]{nr, nc});
            }
        }
    }
    return dist;
}
```

**Why it works**: Think of it as adding a virtual super-source node connected to all real sources with zero-weight edges. BFS from the super-source gives the same result as multi-source BFS.

**Real-world correlation**: **DNS anycast routing**. Multiple DNS servers advertise the same IP prefix. BGP propagates routes from all of them simultaneously, and each router picks the nearest. This is multi-source shortest path.

#### Sub-pattern 1D: 0-1 BFS

When edge weights are only 0 or 1, you can solve shortest path in O(V+E) using a `Deque` instead of a `PriorityQueue`. Weight-0 edges go to the front (`addFirst`), weight-1 edges go to the back (`addLast`). This maintains the invariant that the deque is sorted by distance.

```java
// Template: 0-1 BFS
public int zeroOneBFS(List<int[]>[] graph, int source, int target) {
    // graph[u] = list of {v, weight} where weight is 0 or 1
    int n = graph.length;
    int[] dist = new int[n];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[source] = 0;
    
    Deque<Integer> deque = new ArrayDeque<>();
    deque.addFirst(source);
    
    while (!deque.isEmpty()) {
        int u = deque.pollFirst();
        
        for (int[] edge : graph[u]) {
            int v = edge[0], w = edge[1];
            if (dist[u] + w < dist[v]) {
                dist[v] = dist[u] + w;
                if (w == 0) deque.addFirst(v); // free edge: front of deque
                else        deque.addLast(v);  // cost-1 edge: back of deque
            }
        }
    }
    return dist[target];
}
```

**Why it works**: The deque maintains the same ordering as a priority queue would, but without the O(log n) insertion cost. Elements at the front have the smallest distance. Adding weight-0 neighbors to the front keeps them at the same distance level. Adding weight-1 neighbors to the back puts them at the next distance level. This is equivalent to Dijkstra with only two possible priority values.

#### Sub-pattern 1E: Bidirectional BFS

When searching from source to target, search from both ends simultaneously. Each step expands the smaller frontier. When the two frontiers meet, the shortest path is found. This reduces search space from O(b^d) to O(b^{d/2}), where `b` is the branching factor and `d` is the shortest path length.

```java
// Template: Bidirectional BFS
public int bidirectionalBFS(Map<String, List<String>> graph, 
                            String source, String target) {
    if (source.equals(target)) return 0;
    
    Set<String> frontA = new HashSet<>();
    Set<String> frontB = new HashSet<>();
    Set<String> visitedA = new HashSet<>();
    Set<String> visitedB = new HashSet<>();
    
    frontA.add(source);
    frontB.add(target);
    visitedA.add(source);
    visitedB.add(target);
    int steps = 0;
    
    while (!frontA.isEmpty() && !frontB.isEmpty()) {
        // Always expand the smaller frontier
        if (frontA.size() > frontB.size()) {
            Set<String> temp = frontA; frontA = frontB; frontB = temp;
            Set<String> tempV = visitedA; visitedA = visitedB; visitedB = tempV;
        }
        
        Set<String> nextFront = new HashSet<>();
        for (String node : frontA) {
            for (String neighbor : graph.getOrDefault(node, List.of())) {
                if (visitedB.contains(neighbor)) return steps + 1;
                if (visitedA.add(neighbor)) {
                    nextFront.add(neighbor);
                }
            }
        }
        frontA = nextFront;
        steps++;
    }
    return -1; // no path
}
```

**Real-world correlation**: **Social network "degrees of separation"**. LinkedIn computes connection degrees by expanding from both the viewer and the target profile. Expanding from both ends is dramatically faster than single-source BFS when the graph has high branching factor (average user has 500+ connections).

### Real-World Correlations

- **Web crawler (Googlebot)**: BFS ensures breadth of coverage before depth. A BFS crawler discovers the most-linked pages first, which tend to be the most important. Google's early crawler used a BFS-like strategy with priority modifications.
- **Social network degrees**: Facebook's "People You May Know" uses multi-source BFS from your friends to find friends-of-friends.
- **GPS shortest route (unweighted)**: In road networks where segments have similar length, BFS on the intersection graph gives a fast approximation of shortest route.
- **JVM garbage collector mark phase**: ZGC and G1 mark live objects using BFS from GC roots (stack variables, static fields). Multi-source BFS from all roots simultaneously. The `visited` set is the mark bit in each object header's mark word.
- **Network broadcast flooding**: When a switch receives a broadcast frame, it forwards to all ports except the source -- this is BFS through the network topology.

### Problems

---

**P16.1** [M] -- Binary Tree Level Order Traversal (LeetCode 102)

Given a binary tree, return the level-order traversal as a list of lists.

```
Input:       3
            / \
           9  20
              / \
             15  7

Output: [[3], [9, 20], [15, 7]]
```

```java
public List<List<Integer>> levelOrder(TreeNode root) {
    List<List<Integer>> result = new ArrayList<>();
    if (root == null) return result;
    
    Queue<TreeNode> queue = new ArrayDeque<>();
    queue.offer(root);
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        List<Integer> level = new ArrayList<>(size);
        
        for (int i = 0; i < size; i++) {
            TreeNode node = queue.poll();
            level.add(node.val);
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
        result.add(level);
    }
    return result;
}
```

```
Time:  O(N) — every node visited exactly once
Space: O(W) where W is maximum width of tree (up to N/2 for complete tree)
Pattern: Level-order BFS (sub-pattern 1B)
JVM insight: ArrayList(size) pre-allocates, avoiding resize copies.
  ArrayDeque internally doubles when full — for a complete binary tree with
  1M nodes, the last level has ~500K nodes, so the queue's backing array
  may reach 512K or 1M entries. Each entry is an object reference (4 or 8
  bytes with compressed OOPs), so ~4MB. Negligible for modern heaps.
Real-world: Log aggregation by timestamp bucket — group events by the
  "level" (time window) they occurred in, then process each window.
```

---

**P16.2** [M] -- Binary Tree Zigzag Level Order Traversal (LeetCode 103)

Return the zigzag level order: left-to-right, then right-to-left, alternating.

```
Input:       3
            / \
           9  20
              / \
             15  7

Output: [[3], [20, 9], [15, 7]]
```

```java
public List<List<Integer>> zigzagLevelOrder(TreeNode root) {
    List<List<Integer>> result = new ArrayList<>();
    if (root == null) return result;
    
    Queue<TreeNode> queue = new ArrayDeque<>();
    queue.offer(root);
    boolean leftToRight = true;
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        // Use LinkedList for O(1) addFirst when going right-to-left
        LinkedList<Integer> level = new LinkedList<>();
        
        for (int i = 0; i < size; i++) {
            TreeNode node = queue.poll();
            if (leftToRight) {
                level.addLast(node.val);
            } else {
                level.addFirst(node.val);
            }
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
        result.add(level);
        leftToRight = !leftToRight;
    }
    return result;
}
```

```
Time:  O(N)
Space: O(W) — maximum width of tree
Pattern: Level-order BFS with direction flag
JVM insight: We use LinkedList specifically for the level list (not the
  queue!) because addFirst is O(1). An alternative is to use ArrayList
  and Collections.reverse() on odd levels, but reverse copies O(W)
  elements. A third option: use a deque as the level accumulator.
  For the BFS queue itself, ArrayDeque remains the right choice.
Real-world: Printer paper tray — alternating paper feed direction to
  prevent curl, a zigzag mechanical pattern.
```

---

**P16.3** [E] -- Minimum Depth of Binary Tree (LeetCode 111)

Find the minimum depth -- shortest root-to-leaf path.

```java
public int minDepth(TreeNode root) {
    if (root == null) return 0;
    
    Queue<TreeNode> queue = new ArrayDeque<>();
    queue.offer(root);
    int depth = 1;
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            TreeNode node = queue.poll();
            // First LEAF we encounter in BFS is at minimum depth
            if (node.left == null && node.right == null) {
                return depth;
            }
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
        depth++;
    }
    return depth; // unreachable if root != null
}
```

```
Time:  O(N) worst case, but BFS terminates early at the shallowest leaf
Space: O(W)
Pattern: Standard BFS — first leaf found is minimum depth
Why BFS over DFS: DFS would explore the entire tree to find the minimum.
  BFS stops at the first leaf, which could be at depth 2 in a tree with
  depth 1,000,000. For a skewed tree with one short branch, BFS is
  dramatically faster in practice.
JVM insight: Early termination means fewer TreeNode dereferences and
  fewer cache misses. BFS is the optimal strategy here.
Real-world: Circuit breaker trip — the shortest failure path determines
  how quickly a cascading failure reaches the user.
```

---

**P16.4** [H] -- Word Ladder (LeetCode 127)

Given `beginWord`, `endWord`, and a dictionary, find the shortest transformation sequence length where each step changes exactly one letter.

```
Input: beginWord = "hit", endWord = "cog"
       wordList = ["hot","dot","dog","lot","log","cog"]
Output: 5 (hit -> hot -> dot -> dog -> cog)
```

```java
public int ladderLength(String beginWord, String endWord, List<String> wordList) {
    Set<String> wordSet = new HashSet<>(wordList);
    if (!wordSet.contains(endWord)) return 0;
    
    Queue<String> queue = new ArrayDeque<>();
    queue.offer(beginWord);
    wordSet.remove(beginWord); // visited = removed from set
    int steps = 1;
    
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
                    String newWord = new String(chars);
                    
                    if (newWord.equals(endWord)) return steps + 1;
                    if (wordSet.remove(newWord)) {
                        queue.offer(newWord);
                    }
                }
                chars[j] = original;
            }
        }
        steps++;
    }
    return 0;
}
```

```
Time:  O(M^2 * N) where M = word length, N = dictionary size
  - For each word, try M positions x 26 chars = 26M mutations
  - Each mutation creates a new String in O(M)
  - Process at most N words total
Space: O(M * N) for the word set
Pattern: BFS on implicit graph — words are nodes, edges connect words
  differing by one character
JVM insight: new String(chars) allocates on heap each iteration. For
  M=5, that is 130 String allocations per word processed. With compact
  Strings (JDK 9+), each 5-char word is 56 bytes (16 header + 12 fields
  + 5 byte[] payload + padding). For a 5000-word dictionary, that is
  ~650K String objects = ~36MB. Young gen can handle this, but be aware
  of GC pressure in tight interview constraints.
Real-world: Network routing table convergence — each routing update
  changes one route entry, and you want the minimum number of updates
  to reach the target configuration.
```

---

**P16.5** [H] -- Word Ladder II (LeetCode 126)

Find ALL shortest transformation sequences.

```java
public List<List<String>> findLadders(String beginWord, String endWord,
                                       List<String> wordList) {
    Set<String> wordSet = new HashSet<>(wordList);
    List<List<String>> result = new ArrayList<>();
    if (!wordSet.contains(endWord)) return result;
    
    // BFS to build shortest-path DAG (parent map)
    Map<String, List<String>> parents = new HashMap<>();
    Set<String> currentLevel = new HashSet<>();
    currentLevel.add(beginWord);
    wordSet.remove(beginWord);
    boolean found = false;
    
    while (!currentLevel.isEmpty() && !found) {
        Set<String> nextLevel = new HashSet<>();
        // Remove entire current level from wordSet AFTER processing
        // (so siblings at same level can still discover each other's children)
        
        for (String word : currentLevel) {
            char[] chars = word.toCharArray();
            for (int j = 0; j < chars.length; j++) {
                char original = chars[j];
                for (char c = 'a'; c <= 'z'; c++) {
                    if (c == original) continue;
                    chars[j] = c;
                    String newWord = new String(chars);
                    
                    if (wordSet.contains(newWord) || nextLevel.contains(newWord)) {
                        if (nextLevel.add(newWord)) {
                            // first time seeing newWord at this level
                        }
                        parents.computeIfAbsent(newWord, k -> new ArrayList<>())
                               .add(word);
                        if (newWord.equals(endWord)) found = true;
                    }
                }
                chars[j] = original;
            }
        }
        wordSet.removeAll(nextLevel); // remove after entire level processed
        currentLevel = nextLevel;
    }
    
    if (!found) return result;
    
    // DFS backtrack from endWord to beginWord using parent map
    List<String> path = new LinkedList<>();
    path.add(endWord);
    backtrack(endWord, beginWord, parents, path, result);
    return result;
}

private void backtrack(String word, String beginWord,
                       Map<String, List<String>> parents,
                       List<String> path, List<List<String>> result) {
    if (word.equals(beginWord)) {
        result.add(new ArrayList<>(path));
        return;
    }
    for (String parent : parents.getOrDefault(word, List.of())) {
        ((LinkedList<String>) path).addFirst(parent);
        backtrack(parent, beginWord, parents, path, result);
        ((LinkedList<String>) path).removeFirst();
    }
}
```

```
Time:  O(M^2 * N) for BFS + O(P * L) for backtracking where P = number
       of shortest paths, L = path length
Space: O(M * N) for parent map + word set
Pattern: BFS to build shortest-path DAG, then DFS to enumerate all paths
Key insight: We must remove nodes from wordSet AFTER processing the
  entire level, not one-by-one. Otherwise, a node discovered by word A
  would be removed before word B (at the same level) gets to discover it,
  causing us to miss valid shortest paths.
JVM insight: The parent map uses String keys hashed via String.hashCode().
  Java caches String hash codes after first computation (the hash field),
  so subsequent lookups into the parents map are fast — no rehashing.
Real-world: Network fault analysis — find ALL shortest failure paths
  between two nodes to identify which links are most critical.
```

---

**P16.6** [M] -- Rotting Oranges (LeetCode 994)

Grid with 0 (empty), 1 (fresh), 2 (rotten). Each minute, fresh oranges adjacent to rotten ones become rotten. Return minutes until no fresh oranges remain, or -1 if impossible.

```java
public int orangesRotting(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    Queue<int[]> queue = new ArrayDeque<>();
    int fresh = 0;
    
    // Multi-source: enqueue ALL rotten oranges
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == 2) queue.offer(new int[]{i, j});
            else if (grid[i][j] == 1) fresh++;
        }
    }
    
    if (fresh == 0) return 0;
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    int minutes = 0;
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        boolean rotted = false;
        
        for (int i = 0; i < size; i++) {
            int[] cell = queue.poll();
            for (int[] d : dirs) {
                int nr = cell[0] + d[0], nc = cell[1] + d[1];
                if (nr >= 0 && nr < m && nc >= 0 && nc < n && grid[nr][nc] == 1) {
                    grid[nr][nc] = 2;
                    queue.offer(new int[]{nr, nc});
                    fresh--;
                    rotted = true;
                }
            }
        }
        if (rotted) minutes++;
    }
    
    return fresh == 0 ? minutes : -1;
}
```

```
Time:  O(M * N) — each cell processed at most once
Space: O(M * N) — queue can hold all cells
Pattern: Multi-source BFS (sub-pattern 1C)
Key insight: All initially rotten oranges are sources. BFS propagates
  rot simultaneously from all sources. The answer is the number of BFS
  levels (minutes) until all fresh oranges are consumed.
JVM insight: new int[]{i, j} allocates a 2-element array per cell.
  For a 100x100 grid, that is up to 10,000 tiny arrays on the heap.
  Each int[] has 16-byte header + 8 bytes data + 0 padding = 24 bytes.
  Total: 240KB. Negligible, but in ultra-hot paths, you could encode
  (i * n + j) as a single int to halve allocations.
Real-world: Epidemic simulation — disease spreading from multiple initial
  infection sites simultaneously. Each BFS level is one time step.
  Also: cache invalidation propagation in a CDN — staleness spreads from
  the origin server outward to edge nodes.
```

---

**P16.7** [M] -- Walls and Gates (LeetCode 286)

Grid with -1 (wall), 0 (gate), INF (empty). Fill each empty room with distance to nearest gate.

```java
public void wallsAndGates(int[][] rooms) {
    int m = rooms.length, n = rooms[0].length;
    Queue<int[]> queue = new ArrayDeque<>();
    
    // Multi-source: all gates are sources at distance 0
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (rooms[i][j] == 0) {
                queue.offer(new int[]{i, j});
            }
        }
    }
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    
    while (!queue.isEmpty()) {
        int[] cell = queue.poll();
        int r = cell[0], c = cell[1];
        
        for (int[] d : dirs) {
            int nr = r + d[0], nc = c + d[1];
            if (nr >= 0 && nr < m && nc >= 0 && nc < n
                && rooms[nr][nc] == Integer.MAX_VALUE) {
                rooms[nr][nc] = rooms[r][c] + 1;
                queue.offer(new int[]{nr, nc});
            }
        }
    }
}
```

```
Time:  O(M * N) — each cell enqueued at most once
Space: O(M * N) — queue size
Pattern: Multi-source BFS (sub-pattern 1C)
The INF cells serve as the "visited" check — once filled with a distance,
  they are no longer INF and will not be re-enqueued.
Real-world: Data center fire exit planning — compute distance from each
  server rack to the nearest emergency exit. Also: CDN cache placement —
  how far is each user region from the nearest cache node?
```

---

**P16.8** [M] -- Shortest Path in Binary Matrix (LeetCode 1091)

Find shortest path from top-left to bottom-right in a binary grid (0 = open, 1 = blocked), moving in 8 directions.

```java
public int shortestPathBinaryMatrix(int[][] grid) {
    int n = grid.length;
    if (grid[0][0] == 1 || grid[n-1][n-1] == 1) return -1;
    
    Queue<int[]> queue = new ArrayDeque<>();
    queue.offer(new int[]{0, 0});
    grid[0][0] = 1; // mark visited by setting to 1
    int path = 1;
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0},{1,1},{1,-1},{-1,1},{-1,-1}};
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            int[] cell = queue.poll();
            if (cell[0] == n - 1 && cell[1] == n - 1) return path;
            
            for (int[] d : dirs) {
                int nr = cell[0] + d[0], nc = cell[1] + d[1];
                if (nr >= 0 && nr < n && nc >= 0 && nc < n && grid[nr][nc] == 0) {
                    grid[nr][nc] = 1;
                    queue.offer(new int[]{nr, nc});
                }
            }
        }
        path++;
    }
    return -1;
}
```

```
Time:  O(N^2) — grid has N^2 cells, each visited once
Space: O(N^2) — queue size
Pattern: Standard BFS on grid with 8-directional movement
Note the 8-direction array — Chebyshev distance (king's moves in chess).
  BFS naturally handles this; the first time we reach the destination, the
  path length is minimal.
JVM insight: Mutating the input grid to mark visited saves O(N^2) boolean
  array allocation. In interview, always ask "can I modify the input?"
Real-world: Robot path planning on a grid map — find shortest 8-connected
  path avoiding obstacles.
```

---

**P16.9** [M] -- Open the Lock (LeetCode 752)

Four circular dials, each 0-9. Start at "0000", reach target. Some combinations are deadends. Find minimum turns.

```java
public int openLock(String[] deadends, String target) {
    Set<String> dead = new HashSet<>(Arrays.asList(deadends));
    if (dead.contains("0000")) return -1;
    if ("0000".equals(target)) return 0;
    
    Queue<String> queue = new ArrayDeque<>();
    Set<String> visited = new HashSet<>();
    queue.offer("0000");
    visited.add("0000");
    int turns = 0;
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        turns++;
        for (int i = 0; i < size; i++) {
            String state = queue.poll();
            
            // Generate all 8 neighbors (4 dials x 2 directions)
            for (int j = 0; j < 4; j++) {
                for (int delta : new int[]{1, -1}) {
                    char[] chars = state.toCharArray();
                    chars[j] = (char) (((chars[j] - '0') + delta + 10) % 10 + '0');
                    String next = new String(chars);
                    
                    if (next.equals(target)) return turns;
                    if (!dead.contains(next) && visited.add(next)) {
                        queue.offer(next);
                    }
                }
            }
        }
    }
    return -1;
}
```

```
Time:  O(10^4 * 4) = O(40,000) — at most 10,000 states, each generating 8 neighbors
Space: O(10^4) for visited set
Pattern: BFS on implicit state graph
This is a classic state-space BFS. The "graph" is not given explicitly —
  we generate neighbors on the fly. Each state is a 4-digit combination,
  the edges are dial turns. Deadends are blocked nodes.
JVM insight: 10,000 String objects of length 4 = 10,000 * ~56 bytes =
  ~560KB. The HashSet overhead adds ~40 bytes per entry (Entry object +
  pointer), so ~400KB more. Total: ~1MB. Well within limits.
  Bidirectional BFS would reduce this to ~O(10^2) = O(200) states expanded.
Real-world: Configuration search — finding the minimum number of config
  parameter changes to reach a target system state, avoiding known-bad
  configurations (deadends).
```

---

**P16.10** [M] -- Snakes and Ladders (LeetCode 909)

An n*n board with snakes and ladders. From cell `i`, you can move to cells `i+1` through `i+6` (dice roll). If the destination has a snake or ladder, you teleport. Find minimum moves from cell 1 to cell n*n.

```java
public int snakesAndLadders(int[][] board) {
    int n = board.length;
    int target = n * n;
    boolean[] visited = new boolean[target + 1];
    
    Queue<Integer> queue = new ArrayDeque<>();
    queue.offer(1);
    visited[1] = true;
    int moves = 0;
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        moves++;
        for (int i = 0; i < size; i++) {
            int curr = queue.poll();
            
            for (int dice = 1; dice <= 6; dice++) {
                int next = curr + dice;
                if (next > target) continue;
                
                // Convert 1-indexed cell to board coordinates
                // Board is numbered boustrophedon (alternating direction)
                int[] rc = cellToCoord(next, n);
                if (board[rc[0]][rc[1]] != -1) {
                    next = board[rc[0]][rc[1]]; // snake or ladder
                }
                
                if (next == target) return moves;
                if (!visited[next]) {
                    visited[next] = true;
                    queue.offer(next);
                }
            }
        }
    }
    return -1;
}

private int[] cellToCoord(int cell, int n) {
    int quot = (cell - 1) / n;
    int rem = (cell - 1) % n;
    int row = n - 1 - quot;
    int col = (quot % 2 == 0) ? rem : (n - 1 - rem);
    return new int[]{row, col};
}
```

```
Time:  O(N^2) — at most N^2 cells, each with 6 edges
Space: O(N^2) for visited array
Pattern: BFS on implicit graph with teleportation (snakes/ladders)
The tricky part is coordinate conversion: the board numbers in
  boustrophedon order (bottom-left starts at 1, snaking left-right,
  right-left on alternating rows).
Real-world: Network routing with shortcuts (CDN edge redirects) — some
  hops teleport you closer to the destination, others send you backward.
```

---

**P16.11** [H] -- Bus Routes (LeetCode 815)

Given bus routes (each route is a list of stops), find minimum number of buses to take from source stop to target stop.

```java
public int numBusesToDestination(int[][] routes, int source, int target) {
    if (source == target) return 0;
    
    // Build stop -> list of route indices
    Map<Integer, List<Integer>> stopToRoutes = new HashMap<>();
    for (int i = 0; i < routes.length; i++) {
        for (int stop : routes[i]) {
            stopToRoutes.computeIfAbsent(stop, k -> new ArrayList<>()).add(i);
        }
    }
    
    // BFS on ROUTES, not stops
    Queue<Integer> queue = new ArrayDeque<>(); // queue of route indices
    boolean[] visitedRoute = new boolean[routes.length];
    Set<Integer> visitedStop = new HashSet<>();
    
    // Enqueue all routes that contain the source stop
    for (int route : stopToRoutes.getOrDefault(source, List.of())) {
        queue.offer(route);
        visitedRoute[route] = true;
    }
    visitedStop.add(source);
    int buses = 1;
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            int route = queue.poll();
            
            for (int stop : routes[route]) {
                if (stop == target) return buses;
                if (visitedStop.add(stop)) {
                    for (int nextRoute : stopToRoutes.getOrDefault(stop, List.of())) {
                        if (!visitedRoute[nextRoute]) {
                            visitedRoute[nextRoute] = true;
                            queue.offer(nextRoute);
                        }
                    }
                }
            }
        }
        buses++;
    }
    return -1;
}
```

```
Time:  O(N * S) where N = number of routes, S = total stops across all routes
Space: O(N * S) for the stop-to-routes mapping
Pattern: BFS on a transformed graph
Key insight: Do not BFS on stops (too many). BFS on routes. Two routes
  are "adjacent" if they share a stop. We want the minimum number of route
  transitions (bus changes). The graph transformation is the creative step.
JVM insight: stopToRoutes uses Integer autoboxing for keys. For stop
  numbers in [-128, 127], Integer.valueOf returns cached instances (the
  Integer cache). For larger stop numbers, each creates a new Integer
  object. With potentially millions of stops, this can pressure the heap.
  Using an int[] or IntOpenHashMap (from Eclipse Collections or fastutil)
  would eliminate boxing.
Real-world: Multi-modal transit routing — "minimum number of transfers"
  between bus/train/subway lines, exactly the formulation used by Google
  Maps transit directions.
```

---

**P16.12** [H] -- Cut Off Trees for Golf Event (LeetCode 675)

A grid with tree heights. Cut trees in increasing height order. Find total minimum steps, or -1 if impossible.

```java
public int cutOffTree(List<List<Integer>> forest) {
    int m = forest.size(), n = forest.get(0).size();
    
    // Collect all trees and sort by height
    List<int[]> trees = new ArrayList<>();
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            int h = forest.get(i).get(j);
            if (h > 1) trees.add(new int[]{h, i, j});
        }
    }
    trees.sort((a, b) -> a[0] - b[0]);
    
    int totalSteps = 0;
    int startR = 0, startC = 0;
    
    for (int[] tree : trees) {
        int steps = bfsGrid(forest, startR, startC, tree[1], tree[2], m, n);
        if (steps == -1) return -1;
        totalSteps += steps;
        startR = tree[1];
        startC = tree[2];
    }
    return totalSteps;
}

private int bfsGrid(List<List<Integer>> forest, int sr, int sc,
                    int tr, int tc, int m, int n) {
    if (sr == tr && sc == tc) return 0;
    boolean[][] visited = new boolean[m][n];
    Queue<int[]> queue = new ArrayDeque<>();
    queue.offer(new int[]{sr, sc});
    visited[sr][sc] = true;
    int steps = 0;
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        steps++;
        for (int i = 0; i < size; i++) {
            int[] cell = queue.poll();
            for (int[] d : dirs) {
                int nr = cell[0] + d[0], nc = cell[1] + d[1];
                if (nr >= 0 && nr < m && nc >= 0 && nc < n
                    && !visited[nr][nc]
                    && forest.get(nr).get(nc) > 0) {
                    if (nr == tr && nc == tc) return steps;
                    visited[nr][nc] = true;
                    queue.offer(new int[]{nr, nc});
                }
            }
        }
    }
    return -1;
}
```

```
Time:  O(T * M * N) where T = number of trees — BFS from each tree to next
Space: O(M * N) for visited array per BFS call
Pattern: Repeated BFS between consecutive targets
The key insight is that trees must be cut in height order (greedy —
  smallest first), and between each pair of consecutive trees, we run a
  standard BFS to find the shortest path. Total distance is the sum of
  all pairwise BFS distances.
JVM insight: We allocate a new boolean[m][n] for every BFS call. For
  T trees on a 50x50 grid, that is T * 2500 * 1 byte = T * 2.5KB.
  With T up to 2500, total allocation is ~6MB across all calls, but
  only one lives at a time. The JVM's young gen handles this well.
Real-world: Warehouse order picking — visit shelf locations in a specific
  order (pick list), minimizing total walking distance. Each "pick" is
  a BFS on the warehouse floor plan.
```

---

## 16.2 Pattern 2: DFS (Depth-First Search)

### What It Is

DFS explores as deeply as possible along each branch before backtracking. Where BFS uses a queue, DFS uses a stack -- either the call stack (recursion) or an explicit `ArrayDeque` used as a stack. DFS is the natural choice when you need to explore all possible paths, detect cycles, find connected components, or process tree nodes in pre-order, in-order, or post-order.

The fundamental property of DFS: it produces a DFS tree with back edges, forward edges, and cross edges. **Back edges indicate cycles** -- this is how cycle detection works. If during DFS you encounter a node that is already on the current recursion stack (not just visited, but actively being processed), you have found a cycle.

### Recognition Triggers

- "Explore all paths" or "all possible routes"
- "Connected components" (undirected graph)
- "Cycle detection"
- "Backtracking" or "enumerate all solutions"
- "Can we reach node X from node Y?"
- Tree traversal (pre-order, in-order, post-order)
- "Number of islands" or "flood fill"
- "Clone" a graph or tree

### Sub-patterns

#### Sub-pattern 2A: Recursive DFS

The most natural form. The call stack manages the backtracking state.

```java
// Template: Recursive DFS on binary tree (pre-order)
public void dfsPreOrder(TreeNode root) {
    if (root == null) return;
    process(root);           // pre-order: process BEFORE children
    dfsPreOrder(root.left);
    dfsPreOrder(root.right);
}

// Template: Recursive DFS on graph
public void dfsGraph(List<List<Integer>> graph, int node, boolean[] visited) {
    visited[node] = true;
    process(node);
    for (int neighbor : graph.get(node)) {
        if (!visited[neighbor]) {
            dfsGraph(graph, neighbor, visited);
        }
    }
}
```

**JVM stack depth warning**: Each recursive call consumes one stack frame. The default thread stack size is 512KB to 1MB (configurable via `-Xss`). Each frame for a simple DFS method is roughly 50-100 bytes. That gives you roughly 5,000 to 20,000 recursion levels before `StackOverflowError`. For trees with up to 10^4 nodes (especially skewed), this is fine. For graphs with 10^5 nodes in a line, you MUST use iterative DFS.

#### Sub-pattern 2B: Iterative DFS with Explicit Stack

```java
// Template: Iterative DFS on graph
public void dfsIterative(List<List<Integer>> graph, int start) {
    boolean[] visited = new boolean[graph.size()];
    Deque<Integer> stack = new ArrayDeque<>();
    stack.push(start);
    
    while (!stack.isEmpty()) {
        int node = stack.pop();
        if (visited[node]) continue;
        visited[node] = true;
        process(node);
        
        for (int neighbor : graph.get(node)) {
            if (!visited[neighbor]) {
                stack.push(neighbor);
            }
        }
    }
}
```

**Note**: Iterative DFS processes nodes in a different order than recursive DFS (neighbors are pushed in forward order but popped in reverse). For most problems this does not matter, but for strict traversal-order requirements, reverse the neighbor list before pushing.

#### Sub-pattern 2C: DFS on Graphs with Cycle Detection

For directed graphs, use a three-state coloring scheme:
- **White (0)**: unvisited
- **Gray (1)**: currently being processed (on the recursion stack)
- **Black (2)**: fully processed (all descendants explored)

A back edge (gray -> gray) indicates a cycle.

```java
// Template: Cycle detection in directed graph
public boolean hasCycle(List<List<Integer>> graph) {
    int n = graph.size();
    int[] color = new int[n]; // 0=white, 1=gray, 2=black
    
    for (int i = 0; i < n; i++) {
        if (color[i] == 0 && dfsCycle(graph, i, color)) {
            return true;
        }
    }
    return false;
}

private boolean dfsCycle(List<List<Integer>> graph, int node, int[] color) {
    color[node] = 1; // gray: entering recursion
    
    for (int neighbor : graph.get(node)) {
        if (color[neighbor] == 1) return true; // back edge = cycle
        if (color[neighbor] == 0 && dfsCycle(graph, neighbor, color)) {
            return true;
        }
    }
    
    color[node] = 2; // black: fully explored
    return false;
}
```

### Real-World Correlations

- **File system traversal (`find` command)**: `find / -name "*.log"` is DFS through the directory tree. It goes deep into subdirectories before coming back.
- **GC reachability analysis**: The garbage collector determines which objects are reachable from GC roots using DFS (or BFS). Unreachable objects are garbage.
- **Maze generation**: Randomized DFS produces mazes with long corridors and few dead ends. The algorithm carves passages by DFS-exploring a grid, and the DFS tree edges become the maze passages.
- **Compiler dead code elimination**: DFS from the entry point of a control flow graph marks reachable basic blocks. Unmarked blocks are dead code.

### Problems

---

**P16.13** [E] -- Maximum Depth of Binary Tree (LeetCode 104)

```java
public int maxDepth(TreeNode root) {
    if (root == null) return 0;
    return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));
}
```

```
Time:  O(N) — visit every node
Space: O(H) — recursion depth equals tree height, O(N) worst case (skewed)
Pattern: Recursive DFS (post-order — compute children first, then combine)
This is simultaneously DFS and tree recursion (Pattern 3). The recursion
  computes depth bottom-up: leaf returns 0, parent takes max of children + 1.
JVM insight: For a balanced tree with 1M nodes, depth ~20, so 20 stack
  frames. For a completely skewed tree, depth = 1M, stack overflow. In
  production code, convert to iterative for untrusted tree structures.
Real-world: Dependency chain depth — the longest chain of transitive
  dependencies in a Maven project determines build latency.
```

---

**P16.14** [E] -- Path Sum (LeetCode 112)

Does any root-to-leaf path sum to `targetSum`?

```java
public boolean hasPathSum(TreeNode root, int targetSum) {
    if (root == null) return false;
    
    // Leaf node check
    if (root.left == null && root.right == null) {
        return root.val == targetSum;
    }
    
    int remaining = targetSum - root.val;
    return hasPathSum(root.left, remaining) || hasPathSum(root.right, remaining);
}
```

```
Time:  O(N) — visit every node in worst case
Space: O(H) — recursion stack
Pattern: DFS with carry-forward state (remaining sum)
Subtract current node's value and check if any leaf has the remaining sum.
  The base case is a leaf where remaining == 0.
Real-world: Budget allocation path — does any department allocation chain
  from CEO to individual contributor exactly equal the budget target?
```

---

**P16.15** [M] -- Path Sum II (LeetCode 113)

Find ALL root-to-leaf paths that sum to `targetSum`.

```java
public List<List<Integer>> pathSum(TreeNode root, int targetSum) {
    List<List<Integer>> result = new ArrayList<>();
    dfs(root, targetSum, new ArrayList<>(), result);
    return result;
}

private void dfs(TreeNode node, int remaining, List<Integer> path,
                 List<List<Integer>> result) {
    if (node == null) return;
    
    path.add(node.val);
    
    if (node.left == null && node.right == null && remaining == node.val) {
        result.add(new ArrayList<>(path)); // deep copy!
    }
    
    dfs(node.left, remaining - node.val, path, result);
    dfs(node.right, remaining - node.val, path, result);
    
    path.remove(path.size() - 1); // backtrack
}
```

```
Time:  O(N * H) — visit N nodes, copying paths of length H
Space: O(H) for recursion stack + path, O(N * H) for output
Pattern: DFS with backtracking
The path list is shared across all recursion branches. We add the current
  node before recursing and remove it after (backtracking). When a valid
  leaf is found, we deep-copy the path into the result.
JVM insight: new ArrayList<>(path) is a copy constructor that calls
  Arrays.copyOf internally. For H = 20, that is copying 20 Integer
  references = 80 or 160 bytes. Cheap.
Real-world: Call trace analysis — find all execution paths from entry to
  a specific exception that exceed a latency threshold.
```

---

**P16.16** [E] -- Binary Tree Paths (LeetCode 257)

Return all root-to-leaf paths as strings.

```java
public List<String> binaryTreePaths(TreeNode root) {
    List<String> result = new ArrayList<>();
    if (root == null) return result;
    dfs(root, new StringBuilder(), result);
    return result;
}

private void dfs(TreeNode node, StringBuilder path, List<String> result) {
    int lenBefore = path.length();
    if (path.length() > 0) path.append("->");
    path.append(node.val);
    
    if (node.left == null && node.right == null) {
        result.add(path.toString());
    } else {
        if (node.left != null) dfs(node.left, path, result);
        if (node.right != null) dfs(node.right, path, result);
    }
    
    path.setLength(lenBefore); // backtrack — restore StringBuilder state
}
```

```
Time:  O(N * H) — N nodes, string building takes O(H) per path
Space: O(H) for StringBuilder + recursion
Pattern: DFS with StringBuilder backtracking
Using StringBuilder instead of String concatenation avoids creating
  intermediate String objects at each level. The setLength trick for
  backtracking is more efficient than delete(start, end).
JVM insight: StringBuilder.setLength(len) just sets the count field.
  It does NOT shrink the internal char[]. So the buffer stays allocated
  at its maximum size, avoiding reallocation on subsequent appends.
  This is exactly the behavior we want for backtracking.
Real-world: URL path enumeration in a web sitemap tree.
```

---

**P16.17** [M] -- Number of Islands (LeetCode 200)

Count the number of islands in a 2D grid of '1' (land) and '0' (water).

```java
public int numIslands(char[][] grid) {
    int m = grid.length, n = grid[0].length;
    int count = 0;
    
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == '1') {
                count++;
                dfsSink(grid, i, j, m, n);
            }
        }
    }
    return count;
}

private void dfsSink(char[][] grid, int r, int c, int m, int n) {
    if (r < 0 || r >= m || c < 0 || c >= n || grid[r][c] != '1') return;
    grid[r][c] = '0'; // sink the land (mark visited)
    dfsSink(grid, r + 1, c, m, n);
    dfsSink(grid, r - 1, c, m, n);
    dfsSink(grid, r, c + 1, m, n);
    dfsSink(grid, r, c - 1, m, n);
}
```

```
Time:  O(M * N) — each cell visited once
Space: O(M * N) worst case for recursion stack (all land in a line)
Pattern: DFS flood fill — mark connected components
Each unvisited '1' starts a new island. DFS sinks all connected '1' cells
  into '0' so they are not counted again. The number of DFS calls from the
  main loop equals the number of islands.
JVM insight: Modifying the input grid avoids allocating a boolean[][]
  visited array. For a 300x300 grid, the worst-case recursion depth is
  90,000 — this WILL overflow the default stack. Either use iterative DFS
  with an explicit ArrayDeque stack, or increase -Xss. In an interview,
  mention this edge case.
Real-world: Connected component analysis in network topology — how many
  independent network segments exist after link failures?
```

---

**P16.18** [M] -- Clone Graph (LeetCode 133)

Deep clone an undirected graph given a reference to a node.

```java
public Node cloneGraph(Node node) {
    if (node == null) return null;
    Map<Node, Node> cloned = new HashMap<>();
    return dfs(node, cloned);
}

private Node dfs(Node original, Map<Node, Node> cloned) {
    if (cloned.containsKey(original)) return cloned.get(original);
    
    Node copy = new Node(original.val);
    cloned.put(original, copy); // map BEFORE recursing to handle cycles
    
    for (Node neighbor : original.neighbors) {
        copy.neighbors.add(dfs(neighbor, cloned));
    }
    return copy;
}
```

```
Time:  O(V + E) — visit every node and edge
Space: O(V) for the cloned map + recursion stack
Pattern: DFS with memoization (cloned map prevents revisiting)
The critical detail: put the clone into the map BEFORE recursing into
  neighbors. Otherwise, a cycle (A -> B -> A) causes infinite recursion.
  When we encounter a node already in the map, we return the existing
  clone — this correctly wires up the cycle in the cloned graph.
JVM insight: HashMap uses identity-based hashing (Node's default
  hashCode from Object, which is typically the memory address or a
  random value assigned once). This works correctly because we are
  comparing object identity, not structural equality.
Real-world: Service mesh deep copy for simulation — clone the entire
  service dependency graph to run chaos engineering experiments without
  affecting production.
```

---

**P16.19** [M] -- Surrounded Regions (LeetCode 130)

Capture all 'O' regions surrounded by 'X'. 'O' regions on the border are not captured.

```java
public void solve(char[][] board) {
    int m = board.length, n = board[0].length;
    
    // DFS from all border 'O' cells — mark them as safe
    for (int i = 0; i < m; i++) {
        if (board[i][0] == 'O') dfsMark(board, i, 0, m, n);
        if (board[i][n-1] == 'O') dfsMark(board, i, n-1, m, n);
    }
    for (int j = 0; j < n; j++) {
        if (board[0][j] == 'O') dfsMark(board, 0, j, m, n);
        if (board[m-1][j] == 'O') dfsMark(board, m-1, j, m, n);
    }
    
    // Flip: remaining 'O' -> 'X' (surrounded), 'S' -> 'O' (safe)
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (board[i][j] == 'O') board[i][j] = 'X';
            else if (board[i][j] == 'S') board[i][j] = 'O';
        }
    }
}

private void dfsMark(char[][] board, int r, int c, int m, int n) {
    if (r < 0 || r >= m || c < 0 || c >= n || board[r][c] != 'O') return;
    board[r][c] = 'S'; // safe
    dfsMark(board, r+1, c, m, n);
    dfsMark(board, r-1, c, m, n);
    dfsMark(board, r, c+1, m, n);
    dfsMark(board, r, c-1, m, n);
}
```

```
Time:  O(M * N)
Space: O(M * N) worst case for recursion
Pattern: DFS from boundary — reverse thinking
The key insight is REVERSE THINKING: instead of finding surrounded regions
  (hard — must prove no path to border), find UNsurrounded regions (easy —
  DFS from all border 'O' cells) and flip everything else.
Real-world: Firewall rule analysis — identify internal-only traffic that
  never reaches the network border. Border-connected flows are "safe";
  everything else is contained.
```

---

**P16.20** [M] -- Pacific Atlantic Water Flow (LeetCode 417)

Find cells where water can flow to both the Pacific (top/left edges) and Atlantic (bottom/right edges).

```java
public List<List<Integer>> pacificAtlantic(int[][] heights) {
    int m = heights.length, n = heights[0].length;
    boolean[][] pacific = new boolean[m][n];
    boolean[][] atlantic = new boolean[m][n];
    
    // DFS from Pacific border (top + left)
    for (int i = 0; i < m; i++) {
        dfsFill(heights, pacific, i, 0, m, n);
        dfsFill(heights, atlantic, i, n-1, m, n);
    }
    for (int j = 0; j < n; j++) {
        dfsFill(heights, pacific, 0, j, m, n);
        dfsFill(heights, atlantic, m-1, j, m, n);
    }
    
    List<List<Integer>> result = new ArrayList<>();
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (pacific[i][j] && atlantic[i][j]) {
                result.add(List.of(i, j));
            }
        }
    }
    return result;
}

private void dfsFill(int[][] heights, boolean[][] reachable,
                     int r, int c, int m, int n) {
    if (reachable[r][c]) return;
    reachable[r][c] = true;
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    for (int[] d : dirs) {
        int nr = r + d[0], nc = c + d[1];
        if (nr >= 0 && nr < m && nc >= 0 && nc < n
            && !reachable[nr][nc]
            && heights[nr][nc] >= heights[r][c]) { // can flow UP (reverse)
            dfsFill(heights, reachable, nr, nc, m, n);
        }
    }
}
```

```
Time:  O(M * N) — each cell visited at most twice (once per ocean)
Space: O(M * N) for the two boolean grids + recursion
Pattern: DFS from boundary — reverse flow direction
Instead of asking "where can water flow from this cell?" (hard — must
  check all possible downstream paths to both oceans), we reverse it:
  "from which cells can we reach this ocean by flowing UPHILL?" DFS from
  ocean borders, allowing movement to cells >= current height.
  Intersection of Pacific-reachable and Atlantic-reachable = answer.
Real-world: Network partition analysis — which nodes can reach both
  data center A (Pacific) and data center B (Atlantic)? Reverse DFS from
  each DC finds its reachable set; intersection gives dually-connected nodes.
```

---

**P16.21** [M] -- All Paths From Source to Target (LeetCode 797)

Find all paths from node 0 to node n-1 in a DAG.

```java
public List<List<Integer>> allPathsSourceTarget(int[][] graph) {
    List<List<Integer>> result = new ArrayList<>();
    List<Integer> path = new ArrayList<>();
    path.add(0);
    dfs(graph, 0, path, result);
    return result;
}

private void dfs(int[][] graph, int node, List<Integer> path,
                 List<List<Integer>> result) {
    if (node == graph.length - 1) {
        result.add(new ArrayList<>(path));
        return;
    }
    for (int next : graph[node]) {
        path.add(next);
        dfs(graph, next, path, result);
        path.remove(path.size() - 1);
    }
}
```

```
Time:  O(2^N * N) — exponentially many paths possible in DAG, each of length O(N)
Space: O(N) for the recursion path (excluding output)
Pattern: DFS backtracking on DAG — no visited set needed
Because the graph is a DAG (no cycles), we do NOT need a visited set.
  We will never revisit a node on the same path (no cycles), and we WANT
  to visit nodes on different paths (different choices from earlier nodes).
JVM insight: The result can be exponentially large. For a DAG where each
  node connects to all later nodes, the number of paths is O(2^N). With
  N = 15, that is 32K paths of average length 8, totaling ~256K integers.
  Each ArrayList entry is a reference (4 or 8 bytes), so ~2MB. Manageable.
Real-world: Execution path enumeration in a build pipeline — all possible
  orderings of independent build steps.
```

---

**P16.22** [M] -- Number of Connected Components (LeetCode 323)

Given n nodes and edges, find the number of connected components.

```java
public int countComponents(int n, int[][] edges) {
    List<List<Integer>> graph = new ArrayList<>();
    for (int i = 0; i < n; i++) graph.add(new ArrayList<>());
    for (int[] e : edges) {
        graph.get(e[0]).add(e[1]);
        graph.get(e[1]).add(e[0]);
    }
    
    boolean[] visited = new boolean[n];
    int components = 0;
    
    for (int i = 0; i < n; i++) {
        if (!visited[i]) {
            components++;
            dfs(graph, i, visited);
        }
    }
    return components;
}

private void dfs(List<List<Integer>> graph, int node, boolean[] visited) {
    visited[node] = true;
    for (int neighbor : graph.get(node)) {
        if (!visited[neighbor]) {
            dfs(graph, neighbor, visited);
        }
    }
}
```

```
Time:  O(V + E) — standard DFS/BFS complexity
Space: O(V + E) for adjacency list + O(V) for visited
Pattern: DFS/BFS for connected components — each unvisited node starts
  a new component
This is also solvable with Union-Find (Pattern 5). DFS-based approach
  is simpler; Union-Find is better when edges arrive dynamically.
Real-world: Network segment discovery — after deploying monitoring
  agents, discover how many isolated network segments exist.
```

---

**P16.23** [M] -- Graph Valid Tree (LeetCode 261)

Given n nodes and edges, check if the graph forms a valid tree. A valid tree has n-1 edges, is connected, and has no cycles.

```java
public boolean validTree(int n, int[][] edges) {
    // A tree with n nodes has exactly n-1 edges
    if (edges.length != n - 1) return false;
    
    // Build adjacency list
    List<List<Integer>> graph = new ArrayList<>();
    for (int i = 0; i < n; i++) graph.add(new ArrayList<>());
    for (int[] e : edges) {
        graph.get(e[0]).add(e[1]);
        graph.get(e[1]).add(e[0]);
    }
    
    // BFS/DFS to check connectivity — if all n nodes reachable, it is a tree
    boolean[] visited = new boolean[n];
    Queue<Integer> queue = new ArrayDeque<>();
    queue.offer(0);
    visited[0] = true;
    int count = 1;
    
    while (!queue.isEmpty()) {
        int node = queue.poll();
        for (int neighbor : graph.get(node)) {
            if (!visited[neighbor]) {
                visited[neighbor] = true;
                count++;
                queue.offer(neighbor);
            }
        }
    }
    return count == n; // all nodes reachable = connected + n-1 edges = tree
}
```

```
Time:  O(V + E)
Space: O(V + E)
Pattern: Edge count check + connectivity check
Key theorem: An undirected graph with n nodes is a tree if and only if
  it has exactly n-1 edges AND is connected. The edge count check catches
  multi-component forests (too few edges) and graphs with cycles (too
  many edges if connected). The BFS check confirms connectivity.
Real-world: Configuration validation — verify that a service mesh
  topology forms a spanning tree (for broadcast protocols), not a graph
  with redundant cycles that could cause broadcast storms.
```

---

## 16.3 Pattern 3: Tree Recursion (Post-order / Bottom-up)

### What It Is

This is the most natural pattern for tree problems, and the one that experienced developers often find most intuitive. The idea: solve the problem for each subtree first (children), then combine the results at the parent. This is fundamentally post-order traversal -- left, right, then current.

The template question to ask yourself: **"What information do I need from my left and right children to compute my answer?"**

For height: I need the height of my children. My height is `max(left_height, right_height) + 1`.
For diameter: I need the height of my children. The diameter through me is `left_height + right_height`. The global diameter is the max across all nodes.
For balance: I need the heights of my children. I am balanced if `|left_height - right_height| <= 1` AND both children are balanced.

The pattern often uses a return value from the recursive function that is different from the "answer" to the overall problem. The return value carries information up the tree (like height), while a separate variable tracks the global answer (like diameter).

### Recognition Triggers

- "Height", "depth" of a tree
- "Diameter" or "longest path"
- "Balanced" tree
- "Maximum path sum"
- "Subtree" properties (is a subtree of another tree?)
- "Same tree", "symmetric tree", "mirror"
- Problems where the answer for a node depends on its descendants

### Template

```java
// Template: Post-order recursion with global tracker
class Solution {
    private int globalAnswer = 0; // tracks the overall answer
    
    public int solve(TreeNode root) {
        globalAnswer = 0; // reset
        postOrder(root);
        return globalAnswer;
    }
    
    // Returns information needed by parent (e.g., height, max chain length)
    private int postOrder(TreeNode node) {
        if (node == null) return 0; // base case
        
        int leftResult = postOrder(node.left);
        int rightResult = postOrder(node.right);
        
        // Update global answer using both children's results
        globalAnswer = Math.max(globalAnswer, combine(leftResult, rightResult));
        
        // Return what the PARENT needs
        return returnForParent(leftResult, rightResult, node.val);
    }
}
```

### Real-World Correlations

- **Gradle/Maven dependency tree evaluation**: Build a project by building all dependencies first (children), then the project itself (parent). The build time is the longest dependency chain (height).
- **File system disk usage (`du -sh`)**: To compute a directory's size, first compute sizes of all subdirectories (children), then sum them plus the directory's own files. This is post-order traversal.
- **HTML DOM rendering**: The browser computes layout bottom-up -- leaf elements compute their intrinsic sizes, then parent elements compute layout based on children's sizes.
- **Abstract Syntax Tree (AST) evaluation**: An expression `(3 + 4) * 5` is evaluated bottom-up: compute `3 + 4 = 7` (left subtree), then `7 * 5 = 35` (parent).

### Problems

---

**P16.24** [E] -- Balanced Binary Tree (LeetCode 110)

Determine if a binary tree is height-balanced (difference in heights of subtrees at every node is at most 1).

```java
public boolean isBalanced(TreeNode root) {
    return height(root) != -1;
}

// Returns height if balanced, -1 if unbalanced (sentinel)
private int height(TreeNode node) {
    if (node == null) return 0;
    
    int leftH = height(node.left);
    if (leftH == -1) return -1; // early termination
    
    int rightH = height(node.right);
    if (rightH == -1) return -1;
    
    if (Math.abs(leftH - rightH) > 1) return -1;
    
    return Math.max(leftH, rightH) + 1;
}
```

```
Time:  O(N) — each node visited once
Space: O(H) — recursion depth
Pattern: Post-order with sentinel return
The key optimization: return -1 as a sentinel for "unbalanced" instead of
  computing height and checking balance separately (which would be O(N log N)
  for the naive approach of calling height() at every node). This computes
  height and validates balance in a single pass.
JVM insight: The early termination (checking -1 before recursing into the
  right subtree) means for a tree unbalanced near the root-left, we skip
  the entire right subtree. In practice this makes the function sublinear
  for many unbalanced trees.
Real-world: Load balancer health check — verify that the load distribution
  tree is balanced (no partition has significantly more load than its sibling).
```

---

**P16.25** [M] -- Diameter of Binary Tree (LeetCode 543)

The diameter is the length of the longest path between any two nodes (measured in edges).

```java
public int diameterOfBinaryTree(TreeNode root) {
    int[] maxDiameter = {0};
    depth(root, maxDiameter);
    return maxDiameter[0];
}

private int depth(TreeNode node, int[] maxDiameter) {
    if (node == null) return 0;
    
    int leftDepth = depth(node.left, maxDiameter);
    int rightDepth = depth(node.right, maxDiameter);
    
    // Diameter through this node = left depth + right depth
    maxDiameter[0] = Math.max(maxDiameter[0], leftDepth + rightDepth);
    
    // Return depth for parent to use
    return Math.max(leftDepth, rightDepth) + 1;
}
```

```
Time:  O(N)
Space: O(H)
Pattern: Post-order with decoupled return value and answer
The function RETURNS depth (what the parent needs) but UPDATES diameter
  (the global answer). The diameter through any node is leftDepth +
  rightDepth. The overall diameter is the maximum across all nodes.
Why int[1] instead of a class field? Both work, but int[1] makes the
  solution self-contained within a method chain and thread-safe (each
  call to diameterOfBinaryTree gets its own array). A class field would
  require resetting before each call.
Real-world: Network diameter — the longest shortest path between any
  two nodes in a data center network. Determines worst-case latency.
```

---

**P16.26** [H] -- Binary Tree Maximum Path Sum (LeetCode 124)

Find the maximum path sum. A path can start and end at any node.

```java
public int maxPathSum(TreeNode root) {
    int[] maxSum = {Integer.MIN_VALUE};
    maxGain(root, maxSum);
    return maxSum[0];
}

private int maxGain(TreeNode node, int[] maxSum) {
    if (node == null) return 0;
    
    // Max gain from left/right subtree (take 0 if negative — do not extend)
    int leftGain = Math.max(maxGain(node.left, maxSum), 0);
    int rightGain = Math.max(maxGain(node.right, maxSum), 0);
    
    // Path through this node: left arm + node + right arm
    int pathSum = node.val + leftGain + rightGain;
    maxSum[0] = Math.max(maxSum[0], pathSum);
    
    // Return max single-arm gain for parent (can only extend one direction)
    return node.val + Math.max(leftGain, rightGain);
}
```

```
Time:  O(N)
Space: O(H)
Pattern: Post-order with gain computation
Critical insight: the RETURN value is a single arm (can extend to
  parent), but the UPDATE considers both arms (path turns at this node).
  A parent can only use one arm from a child — if the path turns at a
  child, it cannot extend further upward.
  
The max(gain, 0) is essential: if a subtree's best path sum is negative,
  we simply do not include it (the path does not need to traverse every
  node). This handles trees with all-negative values correctly.
  
JVM insight: Integer.MIN_VALUE is -2^31 = -2,147,483,648. Node values
  can be negative. Initializing maxSum to MIN_VALUE ensures even a tree
  of all-negative values produces the correct (least negative) answer.
Real-world: Supply chain optimization — find the most profitable path
  through a supplier network where each node has a profit/cost. The path
  can start and end at any node, and you want to maximize total profit.
```

---

**P16.27** [M] -- Longest Univalue Path (LeetCode 687)

Find the longest path where all nodes have the same value (measured in edges).

```java
public int longestUnivaluePath(TreeNode root) {
    int[] longest = {0};
    dfs(root, longest);
    return longest[0];
}

private int dfs(TreeNode node, int[] longest) {
    if (node == null) return 0;
    
    int leftLen = dfs(node.left, longest);
    int rightLen = dfs(node.right, longest);
    
    int leftArm = 0, rightArm = 0;
    if (node.left != null && node.left.val == node.val) {
        leftArm = leftLen + 1;
    }
    if (node.right != null && node.right.val == node.val) {
        rightArm = rightLen + 1;
    }
    
    longest[0] = Math.max(longest[0], leftArm + rightArm);
    return Math.max(leftArm, rightArm);
}
```

```
Time:  O(N)
Space: O(H)
Pattern: Post-order — same structure as diameter but with value matching
The function returns the longest single-arm univalue chain extending
  upward from this node. The arm is 0 if the child's value differs.
  The global update considers both arms (path turns at this node).
Real-world: Fiber optic network — find the longest segment of the same
  cable type (same bandwidth capacity) for upgrade planning.
```

---

**P16.28** [M] -- House Robber III (LeetCode 337)

Binary tree of houses. Cannot rob adjacent nodes (parent-child). Maximize loot.

```java
public int rob(TreeNode root) {
    int[] result = dfs(root);
    return Math.max(result[0], result[1]);
}

// Returns {max if NOT robbing this node, max if robbing this node}
private int[] dfs(TreeNode node) {
    if (node == null) return new int[]{0, 0};
    
    int[] left = dfs(node.left);
    int[] right = dfs(node.right);
    
    // Not rob this node: take max of each child (rob or not rob each)
    int notRob = Math.max(left[0], left[1]) + Math.max(right[0], right[1]);
    
    // Rob this node: cannot rob children
    int rob = node.val + left[0] + right[0];
    
    return new int[]{notRob, rob};
}
```

```
Time:  O(N)
Space: O(H) — recursion stack + O(N) for the int[2] arrays (each node creates one)
Pattern: Post-order with multi-state return (tree DP)
This is tree dynamic programming. Each node returns two values: the
  optimal loot when robbing this node, and when not robbing. The parent
  combines these to make its own optimal decision.
JVM insight: Each recursive call allocates int[2] = 24 bytes (16 header
  + 8 data). For a tree with 10,000 nodes, that is 240KB of int[] arrays
  allocated across the recursion. These are short-lived, created in the
  child call and consumed by the parent. The JVM's young gen (TLAB
  allocation) handles this without GC pause: allocate, use, discard.
Real-world: Resource allocation with exclusion constraints — allocate
  compute resources in a hierarchy where a parent partition cannot be
  active simultaneously with its children (like CPU core affinity groups).
```

---

**P16.29** [M] -- Count Good Nodes in Binary Tree (LeetCode 1448)

A node is "good" if the path from root has no node with a greater value.

```java
public int goodNodes(TreeNode root) {
    return dfs(root, Integer.MIN_VALUE);
}

private int dfs(TreeNode node, int maxSoFar) {
    if (node == null) return 0;
    
    int count = 0;
    if (node.val >= maxSoFar) {
        count = 1;
        maxSoFar = node.val;
    }
    
    count += dfs(node.left, maxSoFar);
    count += dfs(node.right, maxSoFar);
    return count;
}
```

```
Time:  O(N) — visit every node
Space: O(H) — recursion depth
Pattern: DFS with carry-down state (max so far on path from root)
This is pre-order DFS: we check the current node BEFORE recursing.
  The maxSoFar parameter carries the running maximum down the path.
  Java's pass-by-value for primitives means each recursive branch gets
  its own copy of maxSoFar — no backtracking needed.
Real-world: Monitoring alert escalation — a server is "critical" if it
  is the worst performer on the path from the root load balancer. Count
  how many servers trigger escalation.
```

---

**P16.30** [E] -- Subtree of Another Tree (LeetCode 572)

Check if `subRoot` is a subtree of `root`.

```java
public boolean isSubtree(TreeNode root, TreeNode subRoot) {
    if (root == null) return false;
    if (isSameTree(root, subRoot)) return true;
    return isSubtree(root.left, subRoot) || isSubtree(root.right, subRoot);
}

private boolean isSameTree(TreeNode p, TreeNode q) {
    if (p == null && q == null) return true;
    if (p == null || q == null) return false;
    return p.val == q.val && isSameTree(p.left, q.left)
                          && isSameTree(p.right, q.right);
}
```

```
Time:  O(M * N) where M = nodes in root, N = nodes in subRoot
  For each of M nodes, we may do an O(N) comparison. In practice, early
  termination makes this much faster.
Space: O(H_root + H_sub) for the nested recursion
Pattern: DFS with nested tree comparison
For each node in root, check if the subtree rooted there equals subRoot.
  The isSameTree function is a standard post-order comparison.
  
Optimization: O(M + N) is achievable using tree hashing (serialize to
  string and use KMP/Rabin-Karp) or Merkle hashing (hash each subtree).
Real-world: Configuration template matching — check if a known "bad"
  configuration subtree appears anywhere in the full config tree.
```

---

**P16.31** [E] -- Invert Binary Tree (LeetCode 226)

Mirror a binary tree.

```java
public TreeNode invertTree(TreeNode root) {
    if (root == null) return null;
    
    TreeNode left = invertTree(root.left);
    TreeNode right = invertTree(root.right);
    
    root.left = right;
    root.right = left;
    return root;
}
```

```
Time:  O(N) — visit every node
Space: O(H) — recursion depth
Pattern: Post-order — invert children first, then swap at parent
This is pure post-order: solve left, solve right, combine (swap).
  The famous "Homebrew author failed this in an interview" problem.
JVM insight: No new nodes allocated — we just reassign existing node
  references. This is an in-place transformation. The reference
  assignments are just pointer writes, which the JVM can optimize to
  simple store instructions.
Real-world: Mirror transformation in UI layout — convert a left-to-right
  layout to right-to-left (RTL) by inverting the layout tree.
```

---

**P16.32** [E] -- Same Tree (LeetCode 100)

Check if two binary trees are structurally identical with same values.

```java
public boolean isSameTree(TreeNode p, TreeNode q) {
    if (p == null && q == null) return true;
    if (p == null || q == null) return false;
    return p.val == q.val && isSameTree(p.left, q.left)
                          && isSameTree(p.right, q.right);
}
```

```
Time:  O(min(M, N)) — stops at first difference
Space: O(min(H_p, H_q))
Pattern: Simultaneous recursive traversal
Short-circuit evaluation (&&) means if p.val != q.val, we do not recurse.
  If the left subtrees differ, we do not check the right.
Real-world: Configuration drift detection — compare the expected config
  tree against the actual config tree, stopping at the first difference.
```

---

**P16.33** [E] -- Symmetric Tree (LeetCode 101)

Check if a binary tree is a mirror of itself.

```java
public boolean isSymmetric(TreeNode root) {
    if (root == null) return true;
    return isMirror(root.left, root.right);
}

private boolean isMirror(TreeNode left, TreeNode right) {
    if (left == null && right == null) return true;
    if (left == null || right == null) return false;
    return left.val == right.val
        && isMirror(left.left, right.right)
        && isMirror(left.right, right.left);
}
```

```
Time:  O(N) — each node visited once
Space: O(H)
Pattern: Dual pointer recursion — compare mirrored positions
The trick: compare left.left with right.right (outer pair) and left.right
  with right.left (inner pair). This is the mirror check.
Real-world: RAID array verification — check that the primary and mirror
  storage trees have identical structure and content.
```

---

**P16.34** [E] -- Merge Two Binary Trees (LeetCode 617)

Merge two trees by summing overlapping nodes.

```java
public TreeNode mergeTrees(TreeNode t1, TreeNode t2) {
    if (t1 == null) return t2;
    if (t2 == null) return t1;
    
    t1.val += t2.val;
    t1.left = mergeTrees(t1.left, t2.left);
    t1.right = mergeTrees(t1.right, t2.right);
    return t1;
}
```

```
Time:  O(min(M, N)) — only visits nodes that exist in both trees
Space: O(min(H1, H2))
Pattern: Simultaneous tree traversal with merge
We modify t1 in-place. Where both nodes exist, sum values. Where only
  one exists, take that subtree as-is.
JVM insight: This modifies t1 in-place (no new TreeNode allocations for
  overlapping nodes). The non-overlapping subtrees from t2 are reused
  by reference — t1's children point to t2's subtree nodes. This is safe
  if t2 is not used afterward (ask in interview: "can I modify inputs?").
Real-world: Config merging — merge a base configuration tree with an
  override tree, where overlapping values are combined (summed, replaced,
  or merged according to policy).
```

---

## 16.4 Pattern 4: Topological Sort

### What It Is

Topological sort produces a linear ordering of vertices in a directed acyclic graph (DAG) such that for every edge `u -> v`, vertex `u` comes before `v`. If the graph has a cycle, no topological ordering exists.

There are two standard approaches:

1. **Kahn's Algorithm (BFS-based)**: Count in-degrees, process nodes with in-degree 0, decrement neighbors' in-degrees, repeat. Also detects cycles (if fewer than V nodes are processed, a cycle exists).

2. **DFS-based**: Run DFS. When a node finishes (all descendants explored), push it onto a stack. Pop the stack for the topological order (reverse post-order). Detects cycles via back edges.

### Recognition Triggers

- "Order with prerequisites" or "order with dependencies"
- "Build order" or "compilation order"
- "Can all courses be finished?"
- "Is there a valid ordering?"
- "Parallel courses" (longest path in DAG = minimum time with parallelism)
- Any problem involving a DAG where order matters

### Templates

```java
// Template: Kahn's Algorithm (BFS-based topological sort)
public List<Integer> topologicalSortKahn(int numNodes, int[][] edges) {
    List<List<Integer>> graph = new ArrayList<>();
    int[] inDegree = new int[numNodes];
    
    for (int i = 0; i < numNodes; i++) graph.add(new ArrayList<>());
    for (int[] e : edges) {
        graph.get(e[0]).add(e[1]);
        inDegree[e[1]]++;
    }
    
    Queue<Integer> queue = new ArrayDeque<>();
    for (int i = 0; i < numNodes; i++) {
        if (inDegree[i] == 0) queue.offer(i);
    }
    
    List<Integer> order = new ArrayList<>();
    while (!queue.isEmpty()) {
        int node = queue.poll();
        order.add(node);
        for (int neighbor : graph.get(node)) {
            inDegree[neighbor]--;
            if (inDegree[neighbor] == 0) {
                queue.offer(neighbor);
            }
        }
    }
    
    return order.size() == numNodes ? order : List.of(); // empty = cycle detected
}
```

```java
// Template: DFS-based topological sort
public List<Integer> topologicalSortDFS(int numNodes, int[][] edges) {
    List<List<Integer>> graph = new ArrayList<>();
    for (int i = 0; i < numNodes; i++) graph.add(new ArrayList<>());
    for (int[] e : edges) graph.get(e[0]).add(e[1]);
    
    int[] color = new int[numNodes]; // 0=white, 1=gray, 2=black
    Deque<Integer> stack = new ArrayDeque<>();
    
    for (int i = 0; i < numNodes; i++) {
        if (color[i] == 0 && !dfs(graph, i, color, stack)) {
            return List.of(); // cycle detected
        }
    }
    
    List<Integer> order = new ArrayList<>();
    while (!stack.isEmpty()) order.add(stack.pop());
    return order;
}

private boolean dfs(List<List<Integer>> graph, int node,
                    int[] color, Deque<Integer> stack) {
    color[node] = 1; // gray
    for (int neighbor : graph.get(node)) {
        if (color[neighbor] == 1) return false; // back edge = cycle
        if (color[neighbor] == 0 && !dfs(graph, neighbor, color, stack)) {
            return false;
        }
    }
    color[node] = 2; // black
    stack.push(node); // push after all descendants processed
    return true;
}
```

### Real-World Correlations

- **Maven/Gradle dependency resolution**: Build tools topologically sort the dependency graph to determine compilation order. If there is a cycle, the build fails with a "circular dependency" error.
- **Course prerequisites**: University course catalogs are DAGs. Topological sort produces a valid semester sequence.
- **Spreadsheet cell evaluation**: Excel evaluates cells in topological order of their dependency graph. If A1 = B1 + C1, then B1 and C1 must be evaluated before A1.
- **Compiler instruction scheduling**: Instruction dependencies form a DAG. The compiler schedules instructions in topological order, maximizing pipeline utilization.
- **Database migration scripts**: Run migrations in dependency order. Migration 003 depends on 002 depends on 001.

### Problems

---

**P16.35** [M] -- Course Schedule (LeetCode 207)

Can you finish all courses? (Cycle detection in directed graph.)

```java
public boolean canFinish(int numCourses, int[][] prerequisites) {
    List<List<Integer>> graph = new ArrayList<>();
    int[] inDegree = new int[numCourses];
    
    for (int i = 0; i < numCourses; i++) graph.add(new ArrayList<>());
    for (int[] p : prerequisites) {
        graph.get(p[1]).add(p[0]); // p[1] -> p[0] (prereq -> course)
        inDegree[p[0]]++;
    }
    
    Queue<Integer> queue = new ArrayDeque<>();
    for (int i = 0; i < numCourses; i++) {
        if (inDegree[i] == 0) queue.offer(i);
    }
    
    int processed = 0;
    while (!queue.isEmpty()) {
        int course = queue.poll();
        processed++;
        for (int next : graph.get(course)) {
            if (--inDegree[next] == 0) {
                queue.offer(next);
            }
        }
    }
    return processed == numCourses; // if not, there is a cycle
}
```

```
Time:  O(V + E) — V = courses, E = prerequisites
Space: O(V + E) for graph + in-degree array
Pattern: Kahn's algorithm — topological sort with cycle detection
If Kahn's processes all V nodes, the graph is a DAG (no cycles), so all
  courses can be finished. If fewer than V nodes are processed, a cycle
  exists (mutual prerequisites that can never be satisfied).
JVM insight: The inDegree array is a flat int[] — contiguous memory,
  excellent cache locality. The graph adjacency list uses ArrayList of
  ArrayList — jagged allocation. For V=2000, E=5000, the total graph
  memory is modest: 2000 ArrayList objects (~64KB) + 5000 Integer
  entries (~80KB with boxing). Actually, graph stores int primitives
  via ArrayList<Integer>, so autoboxing applies.
Real-world: Microservice deployment ordering — can we deploy all services
  given their dependency constraints? A cycle means a circular dependency
  that must be broken (e.g., by deploying a stub service first).
```

---

**P16.36** [M] -- Course Schedule II (LeetCode 210)

Return a valid course order (topological sort).

```java
public int[] findOrder(int numCourses, int[][] prerequisites) {
    List<List<Integer>> graph = new ArrayList<>();
    int[] inDegree = new int[numCourses];
    
    for (int i = 0; i < numCourses; i++) graph.add(new ArrayList<>());
    for (int[] p : prerequisites) {
        graph.get(p[1]).add(p[0]);
        inDegree[p[0]]++;
    }
    
    Queue<Integer> queue = new ArrayDeque<>();
    for (int i = 0; i < numCourses; i++) {
        if (inDegree[i] == 0) queue.offer(i);
    }
    
    int[] order = new int[numCourses];
    int idx = 0;
    while (!queue.isEmpty()) {
        int course = queue.poll();
        order[idx++] = course;
        for (int next : graph.get(course)) {
            if (--inDegree[next] == 0) {
                queue.offer(next);
            }
        }
    }
    return idx == numCourses ? order : new int[0];
}
```

```
Time:  O(V + E)
Space: O(V + E)
Pattern: Kahn's algorithm — same as P16.35 but return the order
Note: there may be MULTIPLE valid topological orderings. Kahn's with a
  regular queue produces one. Using a PriorityQueue (min-heap) as the
  "queue" produces the lexicographically smallest ordering.
Real-world: CI/CD pipeline step ordering — compute the order to execute
  build/test/deploy stages respecting dependencies.
```

---

**P16.37** [H] -- Alien Dictionary (LeetCode 269)

Given words in alien language sorted lexicographically, derive the character ordering.

```java
public String alienOrder(String[] words) {
    // Build graph: character -> set of characters that come after it
    Map<Character, Set<Character>> graph = new HashMap<>();
    Map<Character, Integer> inDegree = new HashMap<>();
    
    // Initialize all characters
    for (String word : words) {
        for (char c : word.toCharArray()) {
            graph.putIfAbsent(c, new HashSet<>());
            inDegree.putIfAbsent(c, 0);
        }
    }
    
    // Compare adjacent words to extract ordering constraints
    for (int i = 0; i < words.length - 1; i++) {
        String w1 = words[i], w2 = words[i + 1];
        
        // Check invalid case: "abc" before "ab" (longer prefix first)
        if (w1.length() > w2.length() && w1.startsWith(w2)) return "";
        
        for (int j = 0; j < Math.min(w1.length(), w2.length()); j++) {
            char c1 = w1.charAt(j), c2 = w2.charAt(j);
            if (c1 != c2) {
                if (graph.get(c1).add(c2)) { // new edge
                    inDegree.merge(c2, 1, Integer::sum);
                }
                break; // only the first differing character gives info
            }
        }
    }
    
    // Kahn's topological sort
    Queue<Character> queue = new ArrayDeque<>();
    for (var entry : inDegree.entrySet()) {
        if (entry.getValue() == 0) queue.offer(entry.getKey());
    }
    
    StringBuilder sb = new StringBuilder();
    while (!queue.isEmpty()) {
        char c = queue.poll();
        sb.append(c);
        for (char next : graph.get(c)) {
            inDegree.merge(next, -1, Integer::sum);
            if (inDegree.get(next) == 0) queue.offer(next);
        }
    }
    
    return sb.length() == inDegree.size() ? sb.toString() : "";
}
```

```
Time:  O(C) where C = total characters across all words
Space: O(U + min(U^2, N)) where U = unique characters, N = number of words
  At most U^2 edges (all character pairs), at most N-1 edges from adjacent
  word comparisons.
Pattern: Build DAG from constraints, then topological sort
The graph extraction is the hard part: compare adjacent words character by
  character. The first differing character gives an ordering edge. All
  subsequent characters give NO information (we do not know their order
  within the differing-character context).
JVM insight: Using Set<Character> for graph edges causes Character
  autoboxing. With only 26 possible characters, all values are in
  [-128, 127], so Character.valueOf returns cached instances. No boxing
  overhead in practice.
Real-world: Protocol reverse engineering — given sorted packet samples,
  infer the field ordering rules of an unknown binary protocol.
```

---

**P16.38** [M] -- Parallel Courses (LeetCode 1136)

Given N courses and prerequisites, find minimum semesters to finish all if you can take unlimited courses per semester (no prerequisite conflicts). Return -1 if impossible.

```java
public int minimumSemesters(int n, int[][] relations) {
    List<List<Integer>> graph = new ArrayList<>();
    int[] inDegree = new int[n + 1]; // 1-indexed
    
    for (int i = 0; i <= n; i++) graph.add(new ArrayList<>());
    for (int[] r : relations) {
        graph.get(r[0]).add(r[1]);
        inDegree[r[1]]++;
    }
    
    Queue<Integer> queue = new ArrayDeque<>();
    for (int i = 1; i <= n; i++) {
        if (inDegree[i] == 0) queue.offer(i);
    }
    
    int semesters = 0, completed = 0;
    while (!queue.isEmpty()) {
        int size = queue.size();
        semesters++;
        for (int i = 0; i < size; i++) {
            int course = queue.poll();
            completed++;
            for (int next : graph.get(course)) {
                if (--inDegree[next] == 0) {
                    queue.offer(next);
                }
            }
        }
    }
    return completed == n ? semesters : -1;
}
```

```
Time:  O(V + E)
Space: O(V + E)
Pattern: Kahn's with level counting = longest path in DAG
The number of semesters equals the number of levels in the topological
  BFS, which equals the length of the longest path in the DAG + 1.
  This is the critical path — the bottleneck chain of dependencies.
Real-world: Build pipeline critical path — the minimum wall-clock time
  to build a project equals the longest chain of sequential dependencies,
  even with unlimited parallelism. This is exactly Kahn's with level counting.
```

---

**P16.39** [M] -- Sequence Reconstruction (LeetCode 444)

Given sequences, check if `org` is the unique shortest supersequence.

```java
public boolean sequenceReconstruction(int[] org, List<List<Integer>> seqs) {
    int n = org.length;
    Map<Integer, Set<Integer>> graph = new HashMap<>();
    Map<Integer, Integer> inDegree = new HashMap<>();
    
    // Build graph from sequences
    for (List<Integer> seq : seqs) {
        for (int num : seq) {
            graph.putIfAbsent(num, new HashSet<>());
            inDegree.putIfAbsent(num, 0);
        }
        for (int i = 0; i < seq.size() - 1; i++) {
            if (graph.get(seq.get(i)).add(seq.get(i + 1))) {
                inDegree.merge(seq.get(i + 1), 1, Integer::sum);
            }
        }
    }
    
    if (inDegree.size() != n) return false;
    
    // Kahn's — the topological order must be unique (queue never has >1 element)
    Queue<Integer> queue = new ArrayDeque<>();
    for (var entry : inDegree.entrySet()) {
        if (entry.getValue() == 0) queue.offer(entry.getKey());
    }
    
    int idx = 0;
    while (!queue.isEmpty()) {
        if (queue.size() > 1) return false; // ambiguous order
        int node = queue.poll();
        if (idx >= n || node != org[idx]) return false;
        idx++;
        for (int next : graph.get(node)) {
            inDegree.merge(next, -1, Integer::sum);
            if (inDegree.get(next) == 0) queue.offer(next);
        }
    }
    return idx == n;
}
```

```
Time:  O(V + E) where V = distinct numbers, E = total pairs from sequences
Space: O(V + E)
Pattern: Topological sort uniqueness check
If at any point the queue has more than one element, there are multiple
  valid orderings, so the sequence is ambiguous. A unique topological order
  requires every level to have exactly one node.
Real-world: Event ordering reconstruction from distributed logs — given
  partial orderings from multiple log sources, can we reconstruct the
  unique total order? If the topological sort is ambiguous, we need more
  information (vector clocks, Lamport timestamps).
```

---

**P16.40** [M] -- Minimum Height Trees (LeetCode 310)

Find all root nodes that produce minimum-height trees. Return their labels.

```java
public List<Integer> findMinHeightTrees(int n, int[][] edges) {
    if (n == 1) return List.of(0);
    
    List<Set<Integer>> graph = new ArrayList<>();
    for (int i = 0; i < n; i++) graph.add(new HashSet<>());
    for (int[] e : edges) {
        graph.get(e[0]).add(e[1]);
        graph.get(e[1]).add(e[0]);
    }
    
    // Start with all leaves (degree 1)
    Queue<Integer> leaves = new ArrayDeque<>();
    for (int i = 0; i < n; i++) {
        if (graph.get(i).size() == 1) leaves.offer(i);
    }
    
    int remaining = n;
    while (remaining > 2) {
        int size = leaves.size();
        remaining -= size;
        Queue<Integer> newLeaves = new ArrayDeque<>();
        
        for (int i = 0; i < size; i++) {
            int leaf = leaves.poll();
            int neighbor = graph.get(leaf).iterator().next();
            graph.get(neighbor).remove(leaf);
            if (graph.get(neighbor).size() == 1) {
                newLeaves.offer(neighbor);
            }
        }
        leaves = newLeaves;
    }
    return new ArrayList<>(leaves);
}
```

```
Time:  O(V + E) — each node removed once, each edge processed once
Space: O(V + E) for adjacency sets
Pattern: Topological peeling (iterative leaf removal)
This is not traditional topological sort but uses the same "peel layers"
  intuition. Repeatedly remove all leaf nodes (degree 1). The last 1-2
  remaining nodes are the centers of the tree, which minimize height.
  
Intuition: a tree has at most 2 centers (the middle of the longest path).
  Peeling leaves inward converges to the center(s), like peeling an onion.
  
JVM insight: Using HashSet<Integer> for adjacency allows O(1) remove.
  ArrayList would require O(degree) for remove. For trees with high-degree
  hub nodes, the HashSet approach is significantly faster.
Real-world: Network topology — find the optimal root server location(s)
  that minimize maximum latency to any leaf server.
```

---

**P16.41** [H] -- Longest Increasing Path in a Matrix (LeetCode 329)

Find the longest strictly increasing path in a matrix.

```java
public int longestIncreasingPath(int[][] matrix) {
    int m = matrix.length, n = matrix[0].length;
    int[][] memo = new int[m][n]; // 0 = not computed
    int longest = 0;
    
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            longest = Math.max(longest, dfs(matrix, memo, i, j, m, n));
        }
    }
    return longest;
}

private int dfs(int[][] matrix, int[][] memo, int r, int c, int m, int n) {
    if (memo[r][c] != 0) return memo[r][c];
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    int maxPath = 1;
    
    for (int[] d : dirs) {
        int nr = r + d[0], nc = c + d[1];
        if (nr >= 0 && nr < m && nc >= 0 && nc < n
            && matrix[nr][nc] > matrix[r][c]) {
            maxPath = Math.max(maxPath, 1 + dfs(matrix, memo, nr, nc, m, n));
        }
    }
    
    memo[r][c] = maxPath;
    return maxPath;
}
```

```
Time:  O(M * N) — each cell computed once due to memoization
Space: O(M * N) for memo array + recursion stack
Pattern: DFS with memoization on implicit DAG
The key insight: the "strictly increasing" constraint means no cycles.
  If we can only move to strictly larger values, we can never return to
  a previously visited cell. The implicit graph is a DAG, and we are
  finding the longest path in it.
  
This is also solvable with topological sort: sort all cells by value,
  process from smallest to largest. Each cell's path length = 1 + max
  of its smaller neighbors' path lengths.
  
JVM insight: The memoization array avoids recomputation. Without it,
  the time complexity would be O(4^(M*N)) in the worst case — exponential.
  With memoization, each cell's DFS is called once, and subsequent calls
  return in O(1).
Real-world: Version dependency chain — find the longest chain of library
  versions where each depends on a strictly newer version of the previous.
```

---

## 16.5 Pattern 5: Union-Find Patterns

### What It Is

Union-Find (Disjoint Set Union, DSU) is a data structure that tracks a set of elements partitioned into disjoint subsets. It supports two operations:

- **Find(x)**: Determine which set `x` belongs to (return the set representative/root)
- **Union(x, y)**: Merge the sets containing `x` and `y`

With path compression and union by rank, both operations run in O(alpha(n)) amortized time, where alpha is the inverse Ackermann function -- effectively O(1) for all practical purposes.

### Recognition Triggers

- "Connected components" that change over time (edges added)
- "Group merging" or "equivalence classes"
- "Are X and Y in the same group?"
- "Number of groups/components" after a series of operations
- Problems where you merge sets and query connectivity
- "Redundant connection" (adding an edge that creates a cycle)
- Kruskal's MST (Union-Find to detect cycles when adding edges)

### Template

```java
// Template: Union-Find with path compression + union by rank
class UnionFind {
    int[] parent;
    int[] rank;
    int components;
    
    UnionFind(int n) {
        parent = new int[n];
        rank = new int[n];
        components = n;
        for (int i = 0; i < n; i++) parent[i] = i;
    }
    
    int find(int x) {
        if (parent[x] != x) {
            parent[x] = find(parent[x]); // path compression
        }
        return parent[x];
    }
    
    boolean union(int x, int y) {
        int rx = find(x), ry = find(y);
        if (rx == ry) return false; // already in same set
        
        // Union by rank
        if (rank[rx] < rank[ry]) parent[rx] = ry;
        else if (rank[rx] > rank[ry]) parent[ry] = rx;
        else { parent[ry] = rx; rank[rx]++; }
        
        components--;
        return true;
    }
    
    boolean connected(int x, int y) {
        return find(x) == find(y);
    }
}
```

**Path compression**: After find(x), every node on the path from x to the root points directly to the root. This flattens the tree for future queries.

**Union by rank**: Attach the shorter tree under the root of the taller tree. This keeps tree height logarithmic. Combined with path compression, amortized complexity is O(alpha(n)).

**JVM insight**: The parent[] and rank[] arrays are contiguous in memory. find() traverses parent[x] -> parent[parent[x]] -> ... which is sequential array access (after path compression). This is extremely cache-friendly. Compare to tree-based structures where each node is a separate heap object with pointer chasing.

### Real-World Correlations

- **Network connectivity monitoring**: As links go up/down, union-find tracks which nodes remain reachable from each other.
- **Kruskal's MST**: Sort edges by weight, add each edge if it does not create a cycle (union-find check). This builds the minimum spanning tree.
- **Social network friend groups**: "Are Alice and Bob in the same friend network?" Union-Find answers in O(1) after merging friend connections.
- **Image segmentation**: Group adjacent pixels with similar colors into segments. Each pixel starts as its own set; merge adjacent similar pixels.
- **Version control merge base**: In some VCS implementations, union-find tracks which commits are in the same branch lineage.

### Problems

---

**P16.42** [M] -- Number of Provinces (LeetCode 547)

Given adjacency matrix of cities, find number of provinces (connected components).

```java
public int findCircleNum(int[][] isConnected) {
    int n = isConnected.length;
    UnionFind uf = new UnionFind(n);
    
    for (int i = 0; i < n; i++) {
        for (int j = i + 1; j < n; j++) {
            if (isConnected[i][j] == 1) {
                uf.union(i, j);
            }
        }
    }
    return uf.components;
}
```

```
Time:  O(N^2 * alpha(N)) ~ O(N^2) — scan upper triangle of matrix
Space: O(N) for Union-Find
Pattern: Basic Union-Find — count components after merging
This is equivalent to DFS/BFS connected components (P16.22), but
  Union-Find is more natural when the input is already an adjacency
  matrix and we want to count components.
Real-world: Regional network segmentation — given a connectivity matrix
  of offices, how many isolated network segments exist?
```

---

**P16.43** [M] -- Redundant Connection (LeetCode 684)

Find the edge that, when removed, makes the graph a tree. Return the last such edge.

```java
public int[] findRedundantConnection(int[][] edges) {
    int n = edges.length;
    UnionFind uf = new UnionFind(n + 1); // 1-indexed
    
    for (int[] edge : edges) {
        if (!uf.union(edge[0], edge[1])) {
            return edge; // this edge creates a cycle
        }
    }
    return new int[0]; // should not reach here
}
```

```
Time:  O(N * alpha(N)) ~ O(N)
Space: O(N)
Pattern: Union-Find cycle detection — the edge that fails to union is
  the redundant one (both endpoints already connected)
A tree with N nodes has exactly N-1 edges. Adding one more edge creates
  exactly one cycle. The last edge in the input that creates a cycle is
  the answer.
JVM insight: The union method returns a boolean — true if a merge
  happened, false if the nodes were already connected. This boolean
  return is the cycle detection mechanism. Zero overhead beyond the
  union operation itself.
Real-world: Network loop detection — in spanning tree protocol (STP),
  the switch that detects a redundant link blocks its port to prevent
  broadcast storms. Union-Find can identify which link to block.
```

---

**P16.44** [M] -- Accounts Merge (LeetCode 721)

Merge accounts that share an email address.

```java
public List<List<String>> accountsMerge(List<List<String>> accounts) {
    // email -> first account index that owns it
    Map<String, Integer> emailToId = new HashMap<>();
    UnionFind uf = new UnionFind(accounts.size());
    
    for (int i = 0; i < accounts.size(); i++) {
        for (int j = 1; j < accounts.get(i).size(); j++) {
            String email = accounts.get(i).get(j);
            if (emailToId.containsKey(email)) {
                uf.union(i, emailToId.get(email));
            } else {
                emailToId.put(email, i);
            }
        }
    }
    
    // Group emails by root account
    Map<Integer, TreeSet<String>> rootToEmails = new HashMap<>();
    for (var entry : emailToId.entrySet()) {
        int root = uf.find(entry.getValue());
        rootToEmails.computeIfAbsent(root, k -> new TreeSet<>()).add(entry.getKey());
    }
    
    List<List<String>> result = new ArrayList<>();
    for (var entry : rootToEmails.entrySet()) {
        List<String> merged = new ArrayList<>();
        merged.add(accounts.get(entry.getKey()).get(0)); // name
        merged.addAll(entry.getValue()); // sorted emails
        result.add(merged);
    }
    return result;
}
```

```
Time:  O(N * K * alpha(NK) + NK log NK) where N = accounts, K = max emails per account
  The NK log NK term is from TreeSet insertion.
Space: O(NK) for email-to-id map
Pattern: Union-Find for equivalence class merging
The key insight: if two accounts share an email, they belong to the same
  person. This is transitivity — if A shares email with B, and B shares
  with C, then A, B, C are the same person. Union-Find handles transitivity
  naturally through the transitive closure of union operations.
JVM insight: TreeSet uses a Red-Black tree (TreeMap underneath). For small
  email sets (< 100), the overhead of tree balancing is negligible. The
  sorting happens during insertion, so no separate sort step is needed.
Real-world: Customer identity resolution — merge customer records across
  systems where the same person may have different accounts. Shared email,
  phone, or address links them.
```

---

**P16.45** [M] -- Most Stones Removed with Same Row or Column (LeetCode 947)

Remove stones that share a row or column with another stone. Maximize removals.

```java
public int removeStones(int[][] stones) {
    int n = stones.length;
    UnionFind uf = new UnionFind(n);
    
    // Stones in the same row or column belong to the same component
    Map<Integer, Integer> rowFirst = new HashMap<>();
    Map<Integer, Integer> colFirst = new HashMap<>();
    
    for (int i = 0; i < n; i++) {
        int row = stones[i][0], col = stones[i][1];
        
        if (rowFirst.containsKey(row)) {
            uf.union(i, rowFirst.get(row));
        } else {
            rowFirst.put(row, i);
        }
        
        if (colFirst.containsKey(col)) {
            uf.union(i, colFirst.get(col));
        } else {
            colFirst.put(col, i);
        }
    }
    
    return n - uf.components; // max removals = total - components
}
```

```
Time:  O(N * alpha(N)) ~ O(N)
Space: O(N) for Union-Find + maps
Pattern: Union-Find — answer = N - components
Key insight: within each connected component, we can always remove all
  stones except one (by removing them in the right order — always remove
  a stone that shares row/col with a remaining stone). So max removals =
  total stones - number of components.
Real-world: Database deduplication — records connected by shared
  attributes form groups, and all but one can be removed from each group.
```

---

**P16.46** [M] -- Satisfiability of Equality Equations (LeetCode 990)

Given equations like "a==b" and "a!=b", determine if all can be satisfied simultaneously.

```java
public boolean equationsPossible(String[] equations) {
    UnionFind uf = new UnionFind(26); // 26 lowercase letters
    
    // Process '==' first: union equal variables
    for (String eq : equations) {
        if (eq.charAt(1) == '=') {
            uf.union(eq.charAt(0) - 'a', eq.charAt(3) - 'a');
        }
    }
    
    // Check '!=' constraints: unequal variables must be in different sets
    for (String eq : equations) {
        if (eq.charAt(1) == '!') {
            if (uf.connected(eq.charAt(0) - 'a', eq.charAt(3) - 'a')) {
                return false; // contradiction: a==b but a!=b
            }
        }
    }
    return true;
}
```

```
Time:  O(N * alpha(26)) ~ O(N) where N = number of equations
Space: O(26) = O(1)
Pattern: Union-Find for constraint satisfaction
Two-pass approach: first merge all equality constraints, then check
  that no inequality constraint is violated. If two variables are in
  the same equivalence class (connected by == chain) but also required
  to be != , return false.
Real-world: Type inference in compilers — the type checker unions
  variables with the same type and then checks for contradictions.
```

---

**P16.47** [M] -- Smallest String With Swaps (LeetCode 1202)

Given a string and pairs of indices that can be swapped, return the lexicographically smallest string.

```java
public String smallestStringWithSwaps(String s, List<List<Integer>> pairs) {
    int n = s.length();
    UnionFind uf = new UnionFind(n);
    
    for (List<Integer> pair : pairs) {
        uf.union(pair.get(0), pair.get(1));
    }
    
    // Group indices by their root
    Map<Integer, PriorityQueue<Character>> groups = new HashMap<>();
    for (int i = 0; i < n; i++) {
        int root = uf.find(i);
        groups.computeIfAbsent(root, k -> new PriorityQueue<>()).offer(s.charAt(i));
    }
    
    // Build result: for each index, poll smallest available char from its group
    char[] result = new char[n];
    for (int i = 0; i < n; i++) {
        result[i] = groups.get(uf.find(i)).poll();
    }
    return new String(result);
}
```

```
Time:  O(N log N) — sorting characters within each group via PriorityQueue
Space: O(N)
Pattern: Union-Find to identify swappable groups, then sort within groups
Insight: if index i can swap with j, and j with k, then i,j,k form a
  connected component where characters can be freely rearranged (bubble
  sort within the group). So within each component, sort characters and
  assign the smallest to the smallest index.
JVM insight: PriorityQueue<Character> involves autoboxing. For a string
  of length 100,000, that is 100,000 Character objects. With JDK cached
  Character instances for values 0-127, ASCII lowercase letters (97-122)
  are all cached. No boxing overhead — Character.valueOf('a') returns a
  cached singleton.
Real-world: Parallel sort with constraints — items can only be compared
  (and swapped) within their assigned partition. Find the optimal arrangement.
```

---

**P16.48** [M] -- Number of Operations to Make Network Connected (LeetCode 1319)

Given n computers and connections, find minimum cables to move to connect all computers.

```java
public int makeConnected(int n, int[][] connections) {
    if (connections.length < n - 1) return -1; // not enough cables
    
    UnionFind uf = new UnionFind(n);
    for (int[] conn : connections) {
        uf.union(conn[0], conn[1]);
    }
    
    return uf.components - 1; // need (components - 1) cables to connect all
}
```

```
Time:  O(E * alpha(N)) ~ O(E)
Space: O(N)
Pattern: Union-Find for component counting with feasibility check
First: check if we have enough cables. A connected graph with N nodes
  needs at least N-1 edges. If we have fewer, return -1.
Second: count connected components. To connect C components, we need
  C-1 additional cables. These cables come from redundant connections
  within components (any edge that does not reduce components is surplus).
Real-world: Data center network repair — after switch failures, how many
  fiber links must be rerouted to restore full connectivity?
```

---

**P16.49** [M] -- Earliest Moment When Everyone Becomes Friends (LeetCode 1101)

Given timestamped friendships, find earliest time when all people are friends.

```java
public int earliestAcq(int[][] logs, int n) {
    Arrays.sort(logs, (a, b) -> a[0] - b[0]); // sort by timestamp
    UnionFind uf = new UnionFind(n);
    
    for (int[] log : logs) {
        uf.union(log[1], log[2]);
        if (uf.components == 1) return log[0]; // everyone connected
    }
    return -1;
}
```

```
Time:  O(E log E + E * alpha(N)) — sort + union operations
Space: O(N + E)
Pattern: Union-Find with temporal ordering — process events in order,
  stop when fully connected
This is the online connectivity problem: process edges in timestamp
  order, union after each, check if all connected. The first moment
  where components == 1 is the answer.
JVM insight: Arrays.sort on int[][] uses a merge sort variant (TimSort
  for object arrays). For 10^5 edges, this is ~17 * 10^5 comparisons.
  Each comparison accesses log[0], which is the first element of a small
  array — cache-friendly within each log entry.
Real-world: Social network viral threshold — when does a new feature
  reach everyone through friend-of-friend sharing?
```

---

## 16.6 Pattern 6: Shortest Path Patterns

### What It Is

When edge weights vary (not all 0 or 1), BFS alone is insufficient. You need weighted shortest path algorithms:

- **Dijkstra's Algorithm**: Works for non-negative edge weights. Uses a priority queue (min-heap). Greedy: always expand the node with the smallest known distance. Time: O((V + E) log V) with binary heap.

- **Bellman-Ford Algorithm**: Works for ANY edge weights, including negative (but not negative cycles). Relaxes all edges V-1 times. Time: O(V * E). The K-relaxation variant solves "shortest path with at most K edges."

- **BFS for unweighted graphs**: Special case of Dijkstra where all weights are 1. O(V + E). Covered in Pattern 1.

### Recognition Triggers

- "Minimum cost path" or "cheapest path"
- "Shortest weighted path"
- Edge weights that vary (not all 0/1)
- "At most K stops/edges" (Bellman-Ford variant)
- "Maximum probability" (negate log or use max-heap)
- Grid problems with varying cell costs

### Templates

```java
// Template: Dijkstra's Algorithm (lazy deletion)
public int[] dijkstra(List<int[]>[] graph, int source) {
    int n = graph.length;
    int[] dist = new int[n];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[source] = 0;
    
    // PriorityQueue stores {distance, node}
    PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[0] - b[0]);
    pq.offer(new int[]{0, source});
    
    while (!pq.isEmpty()) {
        int[] curr = pq.poll();
        int d = curr[0], u = curr[1];
        
        if (d > dist[u]) continue; // lazy deletion — stale entry
        
        for (int[] edge : graph[u]) {
            int v = edge[0], w = edge[1];
            if (dist[u] + w < dist[v]) {
                dist[v] = dist[u] + w;
                pq.offer(new int[]{dist[v], v});
            }
        }
    }
    return dist;
}
```

```java
// Template: Bellman-Ford with at most K edges
public int bellmanFordK(int n, int[][] edges, int src, int dst, int K) {
    int[] dist = new int[n];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[src] = 0;
    
    for (int i = 0; i < K; i++) {
        int[] newDist = dist.clone(); // clone to prevent using updates from this round
        for (int[] edge : edges) {
            int u = edge[0], v = edge[1], w = edge[2];
            if (dist[u] != Integer.MAX_VALUE && dist[u] + w < newDist[v]) {
                newDist[v] = dist[u] + w;
            }
        }
        dist = newDist;
    }
    return dist[dst];
}
```

**JVM insight on Dijkstra**: Java's `PriorityQueue` does not support decrease-key. Instead, we use "lazy deletion": when we find a shorter path to a node, we add a NEW entry to the priority queue with the updated distance. When we poll a node and its distance is stale (`d > dist[u]`), we skip it. This can add at most E extra entries to the priority queue, changing time complexity from O((V+E) log V) to O((V+E) log E). Since log E <= 2 log V for connected graphs, this is at most a constant factor slower. In practice, lazy deletion is faster than Fibonacci heaps due to cache locality of the array-backed `PriorityQueue`.

### Real-World Correlations

- **OSPF routing protocol**: Uses Dijkstra to compute shortest paths from each router to all destinations. Every router runs Dijkstra on the same link-state database.
- **BGP routing protocol**: Uses a Bellman-Ford variant (path-vector protocol). Each autonomous system propagates route updates to neighbors, which relax their distances. Convergence takes multiple rounds.
- **Google Maps navigation**: Hierarchical Dijkstra with contraction hierarchies — preprocess the road network into layers, run Dijkstra on the condensed graph.
- **AWS Cost Explorer**: Finding the cheapest path through a graph of pricing tiers and data transfer costs.

### Problems

---

**P16.50** [M] -- Network Delay Time (LeetCode 743)

Given a network of nodes with weighted directed edges and a source, find the time for all nodes to receive a signal.

```java
public int networkDelayTime(int[][] times, int n, int k) {
    // Build adjacency list
    List<int[]>[] graph = new ArrayList[n + 1]; // 1-indexed
    for (int i = 0; i <= n; i++) graph[i] = new ArrayList<>();
    for (int[] t : times) {
        graph[t[0]].add(new int[]{t[1], t[2]});
    }
    
    int[] dist = new int[n + 1];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[k] = 0;
    
    PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[0] - b[0]);
    pq.offer(new int[]{0, k});
    
    while (!pq.isEmpty()) {
        int[] curr = pq.poll();
        int d = curr[0], u = curr[1];
        if (d > dist[u]) continue;
        
        for (int[] edge : graph[u]) {
            int v = edge[0], w = edge[1];
            if (dist[u] + w < dist[v]) {
                dist[v] = dist[u] + w;
                pq.offer(new int[]{dist[v], v});
            }
        }
    }
    
    int maxDist = 0;
    for (int i = 1; i <= n; i++) {
        if (dist[i] == Integer.MAX_VALUE) return -1;
        maxDist = Math.max(maxDist, dist[i]);
    }
    return maxDist;
}
```

```
Time:  O((V + E) log V) — Dijkstra with binary heap
Space: O(V + E)
Pattern: Dijkstra — single source shortest path, answer = max distance
The signal reaches all nodes when the FARTHEST node receives it. So the
  answer is the maximum shortest-path distance from source to any node.
  If any node is unreachable (dist = INF), return -1.
Real-world: Network broadcast delay — how long until a configuration
  update propagates to all servers? The answer is the worst-case latency
  path.
```

---

**P16.51** [M] -- Cheapest Flights Within K Stops (LeetCode 787)

Find cheapest flight from src to dst with at most K stops.

```java
public int findCheapestPrice(int n, int[][] flights, int src, int dst, int k) {
    int[] dist = new int[n];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[src] = 0;
    
    // Bellman-Ford with k+1 relaxation passes (k stops = k+1 edges)
    for (int i = 0; i <= k; i++) {
        int[] newDist = dist.clone();
        for (int[] flight : flights) {
            int u = flight[0], v = flight[1], w = flight[2];
            if (dist[u] != Integer.MAX_VALUE && dist[u] + w < newDist[v]) {
                newDist[v] = dist[u] + w;
            }
        }
        dist = newDist;
    }
    return dist[dst] == Integer.MAX_VALUE ? -1 : dist[dst];
}
```

```
Time:  O(K * E) — K+1 passes over all edges
Space: O(V) — distance array (clone per iteration)
Pattern: Bellman-Ford with K relaxation passes
Why Bellman-Ford and not Dijkstra? Dijkstra finds shortest path regardless
  of hop count. We need shortest path with AT MOST K+1 edges. Bellman-Ford's
  i-th iteration finds shortest paths using at most i edges. After K+1
  iterations, we have our answer.

Critical detail: we clone dist before each iteration. Without cloning,
  updates from this iteration's early edges could be used by later edges
  in the same iteration, effectively allowing more hops than intended.
JVM insight: Arrays.clone() for int[N] does a fast native memcpy. For
  N = 100, that is 400 bytes — essentially free.
Real-world: Airline route pricing with layover limit — "cheapest flight
  from NYC to Tokyo with at most 2 stops." This is exactly the problem.
```

---

**P16.52** [M] -- Path With Minimum Effort (LeetCode 1631)

Find path from top-left to bottom-right in a grid where the effort is the maximum absolute difference in heights between consecutive cells. Minimize maximum effort.

```java
public int minimumEffortPath(int[][] heights) {
    int m = heights.length, n = heights[0].length;
    int[][] effort = new int[m][n];
    for (int[] row : effort) Arrays.fill(row, Integer.MAX_VALUE);
    effort[0][0] = 0;
    
    // Dijkstra: edge weight = |height difference|
    PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[0] - b[0]);
    pq.offer(new int[]{0, 0, 0}); // {effort, row, col}
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    
    while (!pq.isEmpty()) {
        int[] curr = pq.poll();
        int e = curr[0], r = curr[1], c = curr[2];
        
        if (r == m - 1 && c == n - 1) return e;
        if (e > effort[r][c]) continue;
        
        for (int[] d : dirs) {
            int nr = r + d[0], nc = c + d[1];
            if (nr >= 0 && nr < m && nc >= 0 && nc < n) {
                int newEffort = Math.max(e, Math.abs(heights[r][c] - heights[nr][nc]));
                if (newEffort < effort[nr][nc]) {
                    effort[nr][nc] = newEffort;
                    pq.offer(new int[]{newEffort, nr, nc});
                }
            }
        }
    }
    return 0;
}
```

```
Time:  O(M * N * log(M * N)) — Dijkstra on grid
Space: O(M * N)
Pattern: Modified Dijkstra — edge weight = height difference, path cost =
  max edge weight (not sum)
The "cost" function is different: instead of summing edge weights, we
  take the maximum. This is a minimax path problem. Dijkstra still works
  because max is monotonically non-decreasing along the path — once the
  max effort is X, it can only stay X or increase, never decrease.
  So the greedy property (smallest first) still holds.
  
Also solvable with binary search + BFS/DFS: binary search on the answer
  (effort threshold), and for each threshold, check if a path exists
  using only edges with effort <= threshold.
Real-world: Network bandwidth provisioning — find the path from source
  to destination that maximizes the minimum bandwidth (bottleneck path),
  which is the dual of this problem.
```

---

**P16.53** [M] -- Path with Maximum Probability (LeetCode 1514)

Find the path from start to end with maximum success probability.

```java
public double maxProbability(int n, int[][] edges, double[] succProb,
                              int start, int end) {
    List<double[]>[] graph = new ArrayList[n];
    for (int i = 0; i < n; i++) graph[i] = new ArrayList<>();
    for (int i = 0; i < edges.length; i++) {
        int u = edges[i][0], v = edges[i][1];
        double p = succProb[i];
        graph[u].add(new double[]{v, p});
        graph[v].add(new double[]{u, p});
    }
    
    double[] prob = new double[n];
    prob[start] = 1.0;
    
    // Max-heap Dijkstra (maximize probability)
    PriorityQueue<double[]> pq = new PriorityQueue<>((a, b) -> Double.compare(b[0], a[0]));
    pq.offer(new double[]{1.0, start});
    
    while (!pq.isEmpty()) {
        double[] curr = pq.poll();
        double p = curr[0];
        int u = (int) curr[1];
        
        if (u == end) return p;
        if (p < prob[u]) continue;
        
        for (double[] edge : graph[u]) {
            int v = (int) edge[0];
            double newP = p * edge[1];
            if (newP > prob[v]) {
                prob[v] = newP;
                pq.offer(new double[]{newP, v});
            }
        }
    }
    return 0.0;
}
```

```
Time:  O((V + E) log V) — Dijkstra with max-heap
Space: O(V + E)
Pattern: Modified Dijkstra — maximize product instead of minimize sum
Since probabilities are in [0,1], multiplying along a path only decreases
  the probability. The maximum-probability path is analogous to shortest
  path by taking -log of probabilities (turns product into sum, max into
  min). But we can directly use a max-heap Dijkstra instead.
JVM insight: double[] arrays avoid autoboxing. PriorityQueue<double[]>
  stores references to 2-element double arrays, each 32 bytes (16 header
  + 16 data). For V + E entries, memory is manageable.
Real-world: Reliability engineering — find the most reliable path through
  a system where each component has a probability of success.
```

---

**P16.54** [H] -- Swim in Rising Water (LeetCode 778)

N x N grid with elevation. At time t, you can swim through cells with elevation <= t. Find minimum t to reach (n-1, n-1) from (0,0).

```java
public int swimInWater(int[][] grid) {
    int n = grid.length;
    int[][] dist = new int[n][n];
    for (int[] row : dist) Arrays.fill(row, Integer.MAX_VALUE);
    dist[0][0] = grid[0][0];
    
    PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[0] - b[0]);
    pq.offer(new int[]{grid[0][0], 0, 0});
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    
    while (!pq.isEmpty()) {
        int[] curr = pq.poll();
        int t = curr[0], r = curr[1], c = curr[2];
        
        if (r == n - 1 && c == n - 1) return t;
        if (t > dist[r][c]) continue;
        
        for (int[] d : dirs) {
            int nr = r + d[0], nc = c + d[1];
            if (nr >= 0 && nr < n && nc >= 0 && nc < n) {
                int newT = Math.max(t, grid[nr][nc]);
                if (newT < dist[nr][nc]) {
                    dist[nr][nc] = newT;
                    pq.offer(new int[]{newT, nr, nc});
                }
            }
        }
    }
    return -1;
}
```

```
Time:  O(N^2 log N) — Dijkstra on N^2 cells
Space: O(N^2)
Pattern: Modified Dijkstra — minimax path (same as minimum effort)
The path cost is the maximum elevation along the path. We want the path
  with the minimum such maximum. Dijkstra with max() as the cost combiner.
Also solvable with binary search + BFS, or Union-Find (sort cells by
  elevation, union adjacent cells, check when (0,0) and (n-1,n-1) connect).
Real-world: Flood routing — find the path through terrain that requires
  the lowest water level to traverse. Emergency evacuation route planning.
```

---

**P16.55** [H] -- Minimum Cost to Make at Least One Valid Path in a Grid (LeetCode 1368)

Grid cells have arrows (right/left/down/up). Moving in the arrow's direction is free; changing direction costs 1. Find minimum cost from (0,0) to (m-1,n-1).

```java
public int minCost(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    int[][] dist = new int[m][n];
    for (int[] row : dist) Arrays.fill(row, Integer.MAX_VALUE);
    dist[0][0] = 0;
    
    // 0-1 BFS: cost 0 to follow arrow, cost 1 to change direction
    Deque<int[]> deque = new ArrayDeque<>();
    deque.addFirst(new int[]{0, 0});
    
    // grid values: 1=right, 2=left, 3=down, 4=up
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    
    while (!deque.isEmpty()) {
        int[] curr = deque.pollFirst();
        int r = curr[0], c = curr[1];
        
        for (int d = 0; d < 4; d++) {
            int nr = r + dirs[d][0], nc = c + dirs[d][1];
            if (nr >= 0 && nr < m && nc >= 0 && nc < n) {
                int cost = (grid[r][c] == d + 1) ? 0 : 1;
                int newDist = dist[r][c] + cost;
                if (newDist < dist[nr][nc]) {
                    dist[nr][nc] = newDist;
                    if (cost == 0) deque.addFirst(new int[]{nr, nc});
                    else           deque.addLast(new int[]{nr, nc});
                }
            }
        }
    }
    return dist[m-1][n-1];
}
```

```
Time:  O(M * N) — 0-1 BFS processes each cell in O(1) amortized
Space: O(M * N)
Pattern: 0-1 BFS (sub-pattern 1D)
Following the arrow = weight 0 edge (addFirst), changing direction = 
  weight 1 edge (addLast). The deque maintains sorted order by distance.
  This is O(M*N) compared to Dijkstra's O(MN log MN).
JVM insight: Deque as ArrayDeque backed by a circular array. Both
  addFirst and addLast are O(1) amortized. The deque never exceeds
  O(M*N) elements, so memory is bounded.
Real-world: Network traffic engineering — forwarding rules (arrows)
  are pre-configured, but can be overridden at a cost (SDN rule change).
  Find the cheapest set of rule changes to establish a path.
```

---

## 16.7 Pattern 7: Lowest Common Ancestor (LCA)

### What It Is

The Lowest Common Ancestor of two nodes `p` and `q` in a rooted tree is the deepest node that is an ancestor of both `p` and `q`. LCA appears in many forms:

1. **BST LCA**: Use BST property to binary search down the tree. O(H) per query.
2. **Binary Tree LCA**: Recursive post-order traversal. O(N) per query.
3. **Parent pointer LCA**: Walk up from both nodes like linked list intersection. O(H) per query.
4. **Binary Lifting**: Preprocess in O(N log N), then O(log N) per query. Ideal for multiple queries.
5. **Euler Tour + Sparse Table**: Preprocess in O(N log N), then O(1) per query. Fastest for many queries.

### Recognition Triggers

- "Lowest common ancestor" or "nearest common ancestor"
- "Distance between two nodes in a tree"
- "Path between two nodes" (often LCA + two paths)
- "Common manager" in an org chart
- "Merge base" in version control

### Real-World Correlations

- **DNS domain hierarchy**: The LCA of `api.us-east.prod.example.com` and `web.us-west.prod.example.com` is `prod.example.com`.
- **File system common directory**: The LCA of `/home/user/docs/a.txt` and `/home/user/code/b.py` is `/home/user`.
- **Git merge base**: `git merge-base branch-a branch-b` computes the LCA in the commit DAG (actually, a DAG-LCA, which is more complex than tree-LCA).
- **Organizational structure**: "Who is the lowest common manager of Alice and Bob?"

### Problems

---

**P16.56** [M] -- Lowest Common Ancestor of a BST (LeetCode 235)

```java
public TreeNode lowestCommonAncestor(TreeNode root, TreeNode p, TreeNode q) {
    TreeNode node = root;
    while (node != null) {
        if (p.val < node.val && q.val < node.val) {
            node = node.left;  // both in left subtree
        } else if (p.val > node.val && q.val > node.val) {
            node = node.right; // both in right subtree
        } else {
            return node; // split point — one left, one right (or one is current)
        }
    }
    return null;
}
```

```
Time:  O(H) — at most one path from root to LCA
Space: O(1) — iterative
Pattern: BST property — binary search for split point
The LCA in a BST is the first node where p and q diverge to different
  subtrees (or one equals the current node). This is because BST ordering
  guarantees that if both are less than current, both are in the left
  subtree, and the LCA must be deeper. If they split, the current node
  is the LCA — any deeper node would have only one of them in its subtree.
JVM insight: Iterative solution uses O(1) space. The recursive version
  would use O(H) stack space. For a balanced BST of 1M nodes, H ~ 20,
  so recursion is fine. For a skewed BST, H = N, so iterative is safer.
Real-world: Range query routing in a BST index — finding the partition
  point where a range [lo, hi] splits into left and right subtree queries.
  The split point is the LCA of lo and hi in the BST structure.
```

---

**P16.57** [M] -- Lowest Common Ancestor of a Binary Tree (LeetCode 236)

```java
public TreeNode lowestCommonAncestor(TreeNode root, TreeNode p, TreeNode q) {
    if (root == null || root == p || root == q) return root;
    
    TreeNode left = lowestCommonAncestor(root.left, p, q);
    TreeNode right = lowestCommonAncestor(root.right, p, q);
    
    if (left != null && right != null) return root; // p and q in different subtrees
    return left != null ? left : right;
}
```

```
Time:  O(N) — visit every node in worst case
Space: O(H) — recursion depth
Pattern: Post-order recursion — find from children, combine at parent
This is elegant and requires careful understanding:
  - If current node is p or q, return it (found one target)
  - Recurse left and right
  - If both return non-null, current node is LCA (targets are split)
  - If only one returns non-null, propagate it up (both targets in same subtree)
  - If both return null, neither target is in this subtree

The recursion naturally finds the deepest node where p and q are in
  different subtrees, which is the LCA.
  
Assumption: both p and q exist in the tree. If one might not exist,
  you need a two-pass approach: first verify both exist, then find LCA.
JVM insight: Reference comparison (root == p) compares memory addresses.
  This is valid because we are looking for the exact node objects, not
  value equality. In Java, == on objects checks identity, not equals().
Real-world: Org chart — find the lowest common manager of two employees.
  In a company with 100K employees (tree nodes), this is O(100K) per
  query. For frequent queries, preprocess with binary lifting.
```

---

**P16.58** [M] -- LCA with Parent Pointers (LeetCode 1650)

Each node has a `parent` pointer. Find LCA without root access.

```java
public Node lowestCommonAncestor(Node p, Node q) {
    Node a = p, b = q;
    while (a != b) {
        a = (a != null) ? a.parent : q;
        b = (b != null) ? b.parent : p;
    }
    return a;
}
```

```
Time:  O(H) — where H is the height of the tree
Space: O(1)
Pattern: Two-pointer intersection — IDENTICAL to linked list intersection
This is the same algorithm as finding the intersection of two linked
  lists (LeetCode 160). Walk from p upward and from q upward. When one
  reaches null (root's parent), redirect it to the OTHER node's starting
  point. When they meet, that is the LCA.

Why it works: Let depth(p) = dp, depth(q) = dq, depth(LCA) = d.
  Pointer a travels: (dp - d) + 1 + (dq - d) steps to reach LCA
  Pointer b travels: (dq - d) + 1 + (dp - d) steps to reach LCA
  Both travel the same total distance, so they meet at LCA.
  
Real-world: Finding common prefix of two file paths by walking up the
  directory tree from both files.
```

---

**P16.59** [M] -- Distance Between Nodes in a Binary Tree

Find the distance (number of edges) between two nodes in a binary tree.

```java
public int findDistance(TreeNode root, int p, int q) {
    TreeNode lca = findLCA(root, p, q);
    return depth(lca, p, 0) + depth(lca, q, 0);
}

private TreeNode findLCA(TreeNode root, int p, int q) {
    if (root == null || root.val == p || root.val == q) return root;
    TreeNode left = findLCA(root.left, p, q);
    TreeNode right = findLCA(root.right, p, q);
    if (left != null && right != null) return root;
    return left != null ? left : right;
}

private int depth(TreeNode root, int target, int d) {
    if (root == null) return -1;
    if (root.val == target) return d;
    int left = depth(root.left, target, d + 1);
    if (left != -1) return left;
    return depth(root.right, target, d + 1);
}
```

```
Time:  O(N) — LCA is O(N), two depth searches are O(N) each
Space: O(H) — recursion depth
Pattern: LCA + depth measurement
Distance(p, q) = depth(p from LCA) + depth(q from LCA).
  First find the LCA, then compute the depth of each node from the LCA.
  
For multiple distance queries on the same tree, preprocess with:
  - Euler tour + sparse table for O(1) LCA, O(1) depth lookup
  - Binary lifting for O(log N) LCA
  Then distance = depth[p] + depth[q] - 2 * depth[LCA].
Real-world: Network hop count between two nodes — used in latency
  estimation for peer-to-peer networks.
```

---

Now, let me present the Binary Lifting approach for completeness, as it is critical for production systems handling many LCA queries.

### Binary Lifting — O(N log N) Preprocessing, O(log N) per Query

```java
// Binary Lifting for LCA — efficient for multiple queries
class BinaryLiftingLCA {
    int LOG;
    int[][] up; // up[k][v] = 2^k-th ancestor of v
    int[] depth;
    List<List<Integer>> tree;
    
    void preprocess(int root, List<List<Integer>> tree) {
        int n = tree.size();
        this.tree = tree;
        LOG = (int) (Math.ceil(Math.log(n) / Math.log(2))) + 1;
        up = new int[LOG][n];
        depth = new int[n];
        
        for (int[] row : up) Arrays.fill(row, -1); // -1 = no ancestor
        
        // BFS to compute depth and direct parent (up[0][v])
        Queue<Integer> queue = new ArrayDeque<>();
        boolean[] visited = new boolean[n];
        queue.offer(root);
        visited[root] = true;
        depth[root] = 0;
        
        while (!queue.isEmpty()) {
            int u = queue.poll();
            for (int v : tree.get(u)) {
                if (!visited[v]) {
                    visited[v] = true;
                    depth[v] = depth[u] + 1;
                    up[0][v] = u;
                    queue.offer(v);
                }
            }
        }
        
        // Fill sparse table: up[k][v] = up[k-1][up[k-1][v]]
        for (int k = 1; k < LOG; k++) {
            for (int v = 0; v < n; v++) {
                if (up[k-1][v] != -1) {
                    up[k][v] = up[k-1][up[k-1][v]];
                }
            }
        }
    }
    
    int lca(int u, int v) {
        // Ensure u is deeper
        if (depth[u] < depth[v]) { int temp = u; u = v; v = temp; }
        
        // Lift u to same depth as v
        int diff = depth[u] - depth[v];
        for (int k = 0; k < LOG; k++) {
            if (((diff >> k) & 1) == 1) {
                u = up[k][u];
            }
        }
        
        if (u == v) return u;
        
        // Lift both until just below LCA
        for (int k = LOG - 1; k >= 0; k--) {
            if (up[k][u] != up[k][v]) {
                u = up[k][u];
                v = up[k][v];
            }
        }
        return up[0][u]; // parent of u (and v) is the LCA
    }
    
    int distance(int u, int v) {
        return depth[u] + depth[v] - 2 * depth[lca(u, v)];
    }
}
```

```
Preprocessing: O(N log N) time, O(N log N) space for the sparse table
Query: O(log N) per LCA query
The key data structure: up[k][v] stores the 2^k-th ancestor of node v.
  up[0][v] = parent of v
  up[1][v] = grandparent of v = up[0][up[0][v]]
  up[2][v] = 4th ancestor = up[1][up[1][v]]
  
To find LCA: equalize depths using binary representation of depth
  difference, then binary search for the LCA by trying to jump both
  nodes by 2^k, 2^(k-1), ..., 2^0.
  
JVM insight: up[][] is a 2D int array of size LOG x N. For N = 100,000
  and LOG = 17, that is 1.7M ints = 6.8MB. Fits easily in L2/L3 cache
  on modern CPUs. The innermost loop accesses up[k][u] — striding across
  columns of the same row. Since Java arrays are row-major, accessing
  up[k][...] for a fixed k is a sequential scan of one int[] row —
  excellent cache locality.
Real-world: DNS resolution with hierarchical caching. Preprocessing
  the DNS tree with binary lifting allows O(log N) lookups for the
  lowest shared domain between any two hostnames — used in CDN cache
  hierarchy optimization.
```

---

## 16.8 Comprehensive Problem Set — Advanced Mixed Patterns

These problems require combining multiple patterns or applying patterns in non-obvious ways.

---

**P16.60** [H] -- Word Ladder II — Optimized (LeetCode 126)

See P16.5 above for the full solution. This revisits the problem with bidirectional BFS for additional optimization.

```java
public List<List<String>> findLadders(String beginWord, String endWord,
                                       List<String> wordList) {
    Set<String> dict = new HashSet<>(wordList);
    List<List<String>> result = new ArrayList<>();
    if (!dict.contains(endWord)) return result;
    
    // Bidirectional BFS
    Set<String> frontA = new HashSet<>(Set.of(beginWord));
    Set<String> frontB = new HashSet<>(Set.of(endWord));
    Map<String, List<String>> parents = new HashMap<>();
    dict.remove(beginWord);
    boolean found = false, reversed = false;
    
    while (!frontA.isEmpty() && !found) {
        // Expand smaller frontier
        if (frontA.size() > frontB.size()) {
            Set<String> temp = frontA; frontA = frontB; frontB = temp;
            reversed = !reversed;
        }
        
        dict.removeAll(frontA);
        Set<String> nextFront = new HashSet<>();
        
        for (String word : frontA) {
            char[] chars = word.toCharArray();
            for (int i = 0; i < chars.length; i++) {
                char original = chars[i];
                for (char c = 'a'; c <= 'z'; c++) {
                    if (c == original) continue;
                    chars[i] = c;
                    String newWord = new String(chars);
                    
                    if (frontB.contains(newWord) || dict.contains(newWord)) {
                        if (frontB.contains(newWord)) found = true;
                        nextFront.add(newWord);
                        // Direction-aware parent tracking
                        String parent = reversed ? newWord : word;
                        String child = reversed ? word : newWord;
                        parents.computeIfAbsent(child, k -> new ArrayList<>()).add(parent);
                    }
                }
                chars[i] = original;
            }
        }
        frontA = nextFront;
    }
    
    if (!found) return result;
    List<String> path = new LinkedList<>();
    path.add(endWord);
    backtrackPaths(endWord, beginWord, parents, path, result);
    return result;
}

private void backtrackPaths(String word, String beginWord,
                            Map<String, List<String>> parents,
                            List<String> path, List<List<String>> result) {
    if (word.equals(beginWord)) {
        result.add(new ArrayList<>(path));
        return;
    }
    for (String p : parents.getOrDefault(word, List.of())) {
        ((LinkedList<String>) path).addFirst(p);
        backtrackPaths(p, beginWord, parents, path, result);
        ((LinkedList<String>) path).removeFirst();
    }
}
```

```
Time:  O(M^2 * N) with much smaller constant due to bidirectional BFS
Space: O(M * N)
Pattern: Bidirectional BFS + DFS backtracking
The bidirectional optimization reduces the search space from O(b^d) to
  O(b^{d/2}) where b is the branching factor. For word ladders with
  b ~ 20 (mutations per word) and d ~ 10, this is 20^10 vs 2 * 20^5 =
  ~10 trillion vs ~6.4 million. Massive improvement.
```

---

**P16.61** [M] -- Binary Tree Right Side View (LeetCode 199)

Return the values visible from the right side of the tree.

```java
public List<Integer> rightSideView(TreeNode root) {
    List<Integer> result = new ArrayList<>();
    if (root == null) return result;
    
    Queue<TreeNode> queue = new ArrayDeque<>();
    queue.offer(root);
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            TreeNode node = queue.poll();
            if (i == size - 1) result.add(node.val); // last node in level
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
    }
    return result;
}
```

```
Time:  O(N)
Space: O(W)
Pattern: Level-order BFS — take the last node of each level
Alternative DFS approach: preorder but right-first (root, right, left).
  Track the max depth seen. If current depth > max depth, this is the
  first node we see at this depth from the right.
Real-world: Dashboard view — in a hierarchical navigation tree, show
  only the rightmost (most recently added?) item at each depth level.
```

---

**P16.62** [M] -- Populating Next Right Pointers in Each Node (LeetCode 116)

Connect each node's `next` pointer to its right neighbor at the same level. Perfect binary tree.

```java
public Node connect(Node root) {
    if (root == null) return null;
    
    Node leftmost = root;
    while (leftmost.left != null) { // there is a next level
        Node curr = leftmost;
        while (curr != null) {
            curr.left.next = curr.right; // connect children
            if (curr.next != null) {
                curr.right.next = curr.next.left; // connect across parent boundary
            }
            curr = curr.next; // move to next node via already-set pointers
        }
        leftmost = leftmost.left; // move to next level
    }
    return root;
}
```

```
Time:  O(N)
Space: O(1) — no queue needed! We use the next pointers as our "queue"
Pattern: Level-order traversal using pre-existing structure
The clever insight: once level k's next pointers are set, we can traverse
  level k without a queue (just follow next). While traversing level k,
  we set level k+1's next pointers. This eliminates the O(W) queue.
JVM insight: O(1) extra space means zero heap allocations during the
  algorithm (beyond the already-existing nodes). This is optimal for
  GC pressure — no young gen allocation means no minor GC triggered.
Real-world: Slab allocator free lists — each memory slab points to the
  "next" free slab at the same size class, forming level-ordered chains.
```

---

**P16.63** [M] -- Validate Binary Search Tree (LeetCode 98)

Check if a binary tree is a valid BST.

```java
public boolean isValidBST(TreeNode root) {
    return validate(root, Long.MIN_VALUE, Long.MAX_VALUE);
}

private boolean validate(TreeNode node, long min, long max) {
    if (node == null) return true;
    if (node.val <= min || node.val >= max) return false;
    return validate(node.left, min, node.val) &&
           validate(node.right, node.val, max);
}
```

```
Time:  O(N)
Space: O(H)
Pattern: DFS with range propagation
Each node must satisfy min < node.val < max. The left child inherits
  [min, node.val) and the right inherits (node.val, max]. We use long
  for bounds because node values can be Integer.MIN_VALUE or MAX_VALUE.
Alternative: in-order traversal should produce strictly increasing sequence.
  Maintain a prev variable and verify each node > prev.
JVM insight: Using long instead of int for bounds avoids edge cases with
  Integer.MIN_VALUE/MAX_VALUE nodes. Long.MIN_VALUE is -2^63, safely
  below any int value. The JVM handles long comparisons in two 32-bit
  registers on 32-bit systems, but on 64-bit (all modern JVMs), it is
  a single register comparison.
Real-world: Database index validation — verify that a B+ tree index
  maintains sorted order after crash recovery.
```

---

**P16.64** [M] -- Construct Binary Tree from Preorder and Inorder (LeetCode 105)

```java
public TreeNode buildTree(int[] preorder, int[] inorder) {
    Map<Integer, Integer> inMap = new HashMap<>();
    for (int i = 0; i < inorder.length; i++) inMap.put(inorder[i], i);
    return build(preorder, inMap, 0, 0, inorder.length - 1);
}

private TreeNode build(int[] preorder, Map<Integer, Integer> inMap,
                       int preStart, int inStart, int inEnd) {
    if (inStart > inEnd) return null;
    
    TreeNode root = new TreeNode(preorder[preStart]);
    int inRoot = inMap.get(root.val);
    int leftSize = inRoot - inStart;
    
    root.left = build(preorder, inMap, preStart + 1, inStart, inRoot - 1);
    root.right = build(preorder, inMap, preStart + 1 + leftSize, inRoot + 1, inEnd);
    return root;
}
```

```
Time:  O(N) — each node constructed once, HashMap lookup O(1)
Space: O(N) for HashMap + O(H) recursion
Pattern: Divide and conquer with index mapping
Preorder: [root, ...left subtree..., ...right subtree...]
Inorder:  [...left subtree..., root, ...right subtree...]
The root is always preorder[preStart]. Its position in inorder divides
  left and right subtrees. The left subtree size determines where the
  right subtree starts in preorder.
JVM insight: The HashMap avoids O(N) linear search in inorder for each
  node, reducing overall time from O(N^2) to O(N). With Integer auto-
  boxing, the HashMap stores Integer keys. For values in [-128, 127],
  the Integer cache avoids allocations.
Real-world: Reconstructing a parse tree from prefix and infix
  representations of an expression — used in compiler deserialization.
```

---

**P16.65** [H] -- Serialize and Deserialize Binary Tree (LeetCode 297)

```java
public class Codec {
    // Serialize: preorder with "null" markers
    public String serialize(TreeNode root) {
        StringBuilder sb = new StringBuilder();
        serializeDFS(root, sb);
        return sb.toString();
    }
    
    private void serializeDFS(TreeNode node, StringBuilder sb) {
        if (node == null) {
            sb.append("#,");
            return;
        }
        sb.append(node.val).append(",");
        serializeDFS(node.left, sb);
        serializeDFS(node.right, sb);
    }
    
    // Deserialize: consume tokens left to right
    public TreeNode deserialize(String data) {
        Queue<String> tokens = new ArrayDeque<>(Arrays.asList(data.split(",")));
        return deserializeDFS(tokens);
    }
    
    private TreeNode deserializeDFS(Queue<String> tokens) {
        String val = tokens.poll();
        if ("#".equals(val)) return null;
        
        TreeNode node = new TreeNode(Integer.parseInt(val));
        node.left = deserializeDFS(tokens);
        node.right = deserializeDFS(tokens);
        return node;
    }
}
```

```
Time:  O(N) for both serialize and deserialize
Space: O(N) for the serialized string
Pattern: Preorder DFS with null markers
Preorder is the natural choice for serialization: process root first, then
  children. Null markers (#) indicate absent children, eliminating
  ambiguity. Deserialization consumes tokens in the same preorder sequence.
  
Why not level-order? Level-order also works but wastes space on deep
  trees: a skewed tree of depth N produces O(2^N) tokens in level-order
  (all the nulls at each level), but only O(N) in preorder.
JVM insight: data.split(",") creates a String[] and then wraps it in an
  ArrayDeque. For a tree of 10K nodes, that is ~20K tokens (nodes + nulls),
  each a small String. The split operation itself allocates the array
  plus all substrings. In JDK 9+, String.split uses compact strings,
  so each token is a Latin1 byte array.
Real-world: Object serialization for distributed caching — serialize a
  complex object tree for storage in Redis/Memcached, deserialize on
  cache hit. Java's built-in serialization (ObjectOutputStream) follows
  a similar DFS approach but with much more metadata overhead.
```

---

**P16.66** [H] -- Critical Connections in a Network (LeetCode 1192)

Find all bridges (critical edges whose removal disconnects the graph).

```java
public List<List<Integer>> criticalConnections(int n, List<List<Integer>> connections) {
    List<List<Integer>> graph = new ArrayList<>();
    for (int i = 0; i < n; i++) graph.add(new ArrayList<>());
    for (List<Integer> conn : connections) {
        graph.get(conn.get(0)).add(conn.get(1));
        graph.get(conn.get(1)).add(conn.get(0));
    }
    
    List<List<Integer>> bridges = new ArrayList<>();
    int[] disc = new int[n]; // discovery time
    int[] low = new int[n];  // lowest reachable discovery time
    Arrays.fill(disc, -1);
    int[] timer = {0};
    
    // DFS from node 0 (graph is connected per problem statement)
    dfsBridge(graph, 0, -1, disc, low, timer, bridges);
    return bridges;
}

private void dfsBridge(List<List<Integer>> graph, int u, int parent,
                       int[] disc, int[] low, int[] timer,
                       List<List<Integer>> bridges) {
    disc[u] = low[u] = timer[0]++;
    
    for (int v : graph.get(u)) {
        if (v == parent) continue; // skip the edge we came from
        
        if (disc[v] == -1) { // unvisited — tree edge
            dfsBridge(graph, v, u, disc, low, timer, bridges);
            low[u] = Math.min(low[u], low[v]);
            
            if (low[v] > disc[u]) { // bridge: no back edge from v's subtree to u or above
                bridges.add(List.of(u, v));
            }
        } else { // visited — back edge
            low[u] = Math.min(low[u], disc[v]);
        }
    }
}
```

```
Time:  O(V + E) — single DFS pass
Space: O(V + E) for graph + O(V) for disc/low arrays
Pattern: Tarjan's bridge-finding algorithm (DFS with low-link values)
An edge (u,v) is a bridge if low[v] > disc[u], meaning there is NO back
  edge from v's subtree that reaches u or any ancestor of u. Removing
  (u,v) would disconnect v's subtree from the rest of the graph.

low[u] = minimum of:
  - disc[u] (u's own discovery time)
  - disc[w] for all back edges (u,w) where w is already visited
  - low[v] for all tree edges (u,v) where v is a child in DFS tree

JVM insight: The timer is stored as int[1] (mutable box) to pass by
  reference through recursion. Alternatively, use a class field. The
  int[1] approach avoids the overhead of a separate AtomicInteger or
  wrapper object — it is just 24 bytes (16 header + 4 data + 4 padding).
Real-world: Network reliability engineering — identify single points of
  failure (SPOF) in a network. Bridges are links whose failure partitions
  the network. Redundancy must be added at these points.
```

---

**P16.67** [H] -- Binary Tree Cameras (LeetCode 968)

Place minimum cameras on tree nodes to monitor all nodes. A camera monitors itself, its parent, and its children.

```java
public int minCameraCover(TreeNode root) {
    int[] cameras = {0};
    // If root is NOT monitored after DFS, add a camera at root
    if (dfs(root, cameras) == 0) cameras[0]++;
    return cameras[0];
}

// Returns: 0 = not monitored, 1 = monitored (no camera), 2 = has camera
private int dfs(TreeNode node, int[] cameras) {
    if (node == null) return 1; // null nodes are "monitored" (do not need coverage)
    
    int left = dfs(node.left, cameras);
    int right = dfs(node.right, cameras);
    
    // If any child is not monitored, this node MUST have a camera
    if (left == 0 || right == 0) {
        cameras[0]++;
        return 2;
    }
    
    // If any child has a camera, this node is monitored
    if (left == 2 || right == 2) {
        return 1;
    }
    
    // Both children are monitored but have no camera — this node is NOT monitored
    return 0;
}
```

```
Time:  O(N)
Space: O(H)
Pattern: Post-order greedy with three states
This is a greedy tree DP. The three states propagate bottom-up:
  - State 0 (not monitored): needs a camera from parent
  - State 1 (monitored): safe, no camera needed here
  - State 2 (has camera): monitors self, parent, and children

The greedy rule: prefer placing cameras at parents of leaves rather
  than at leaves. A leaf camera monitors 2 nodes (self + parent). A
  parent-of-leaf camera monitors 3-4 nodes. So we delay camera
  placement as high as possible, which the post-order naturally achieves.
Real-world: Security camera placement in a building with a tree-shaped
  corridor layout — minimize cameras while covering every junction.
```

---

**P16.68** [E] -- Flood Fill (LeetCode 733)

Change color of all connected cells with the same original color.

```java
public int[][] floodFill(int[][] image, int sr, int sc, int color) {
    int original = image[sr][sc];
    if (original == color) return image; // avoid infinite loop
    dfs(image, sr, sc, original, color);
    return image;
}

private void dfs(int[][] image, int r, int c, int original, int color) {
    if (r < 0 || r >= image.length || c < 0 || c >= image[0].length) return;
    if (image[r][c] != original) return;
    
    image[r][c] = color;
    dfs(image, r + 1, c, original, color);
    dfs(image, r - 1, c, original, color);
    dfs(image, r, c + 1, original, color);
    dfs(image, r, c - 1, original, color);
}
```

```
Time:  O(M * N)
Space: O(M * N) worst case recursion
Pattern: DFS flood fill — connected component recoloring
The early return when original == color prevents infinite recursion
  (the cell would match forever). This is the classic "paint bucket"
  tool in image editors.
Real-world: The actual paint bucket tool in Photoshop/GIMP. Also used
  in image segmentation for region growing algorithms.
```

---

**P16.69** [M] -- Course Schedule IV (LeetCode 1462)

Given prerequisites and queries, answer "is course A a prerequisite of course B?"

```java
public List<Boolean> checkIfPrerequisite(int numCourses, int[][] prerequisites,
                                          int[][] queries) {
    // Transitive closure via Floyd-Warshall (or BFS from each node)
    boolean[][] isPrereq = new boolean[numCourses][numCourses];
    
    // Build adjacency list and compute transitive closure via BFS
    List<List<Integer>> graph = new ArrayList<>();
    for (int i = 0; i < numCourses; i++) graph.add(new ArrayList<>());
    for (int[] p : prerequisites) {
        graph.get(p[0]).add(p[1]);
    }
    
    // BFS from each node to find all reachable nodes
    for (int i = 0; i < numCourses; i++) {
        Queue<Integer> queue = new ArrayDeque<>();
        queue.offer(i);
        while (!queue.isEmpty()) {
            int curr = queue.poll();
            for (int next : graph.get(curr)) {
                if (!isPrereq[i][next]) {
                    isPrereq[i][next] = true;
                    queue.offer(next);
                }
            }
        }
    }
    
    List<Boolean> result = new ArrayList<>();
    for (int[] q : queries) {
        result.add(isPrereq[q[0]][q[1]]);
    }
    return result;
}
```

```
Time:  O(V * (V + E) + Q) — BFS from each node + answering queries
Space: O(V^2) for the reachability matrix
Pattern: Transitive closure (precompute all-pairs reachability)
Alternative: Floyd-Warshall in O(V^3):
  for (k) for (i) for (j) isPrereq[i][j] |= isPrereq[i][k] && isPrereq[k][j]
Both approaches precompute the full reachability matrix, then answer
  each query in O(1).
Real-world: Permission checking in RBAC — precompute the transitive
  closure of the role hierarchy to quickly answer "does role A inherit
  permission from role B?"
```

---

**P16.70** [M] -- Keys and Rooms (LeetCode 841)

N rooms, each with keys to other rooms. Start in room 0. Can you visit all rooms?

```java
public boolean canVisitAllRooms(List<List<Integer>> rooms) {
    boolean[] visited = new boolean[rooms.size()];
    Deque<Integer> stack = new ArrayDeque<>();
    stack.push(0);
    visited[0] = true;
    int count = 1;
    
    while (!stack.isEmpty()) {
        int room = stack.pop();
        for (int key : rooms.get(room)) {
            if (!visited[key]) {
                visited[key] = true;
                count++;
                stack.push(key);
            }
        }
    }
    return count == rooms.size();
}
```

```
Time:  O(V + E) where V = rooms, E = total keys
Space: O(V)
Pattern: DFS/BFS reachability from source
Simple graph reachability: can we reach all nodes from node 0? This is
  the same as "is the directed graph rooted at 0 strongly connected to
  all nodes?" — just a DFS/BFS from node 0 checking if all nodes are visited.
Real-world: Access control graph traversal — starting with initial
  credentials (room 0), can an attacker reach all systems?
```

---

**P16.71** [M] -- Evaluate Division (LeetCode 399)

Given equations like a/b = 2.0 and b/c = 3.0, answer queries like a/c = ?

```java
public double[] calcEquation(List<List<String>> equations, double[] values,
                              List<List<String>> queries) {
    // Build weighted directed graph
    Map<String, Map<String, Double>> graph = new HashMap<>();
    
    for (int i = 0; i < equations.size(); i++) {
        String a = equations.get(i).get(0), b = equations.get(i).get(1);
        double val = values[i];
        graph.computeIfAbsent(a, k -> new HashMap<>()).put(b, val);
        graph.computeIfAbsent(b, k -> new HashMap<>()).put(a, 1.0 / val);
    }
    
    double[] result = new double[queries.size()];
    for (int i = 0; i < queries.size(); i++) {
        String src = queries.get(i).get(0), dst = queries.get(i).get(1);
        if (!graph.containsKey(src) || !graph.containsKey(dst)) {
            result[i] = -1.0;
        } else if (src.equals(dst)) {
            result[i] = 1.0;
        } else {
            result[i] = dfs(graph, src, dst, new HashSet<>());
        }
    }
    return result;
}

private double dfs(Map<String, Map<String, Double>> graph,
                   String curr, String target, Set<String> visited) {
    if (curr.equals(target)) return 1.0;
    visited.add(curr);
    
    for (var entry : graph.get(curr).entrySet()) {
        if (!visited.contains(entry.getKey())) {
            double result = dfs(graph, entry.getKey(), target, visited);
            if (result != -1.0) return entry.getValue() * result;
        }
    }
    return -1.0;
}
```

```
Time:  O(Q * (V + E)) — DFS per query
Space: O(V + E) for graph
Pattern: DFS on weighted graph — multiply edge weights along path
Model a/b = k as a directed edge a -> b with weight k, and b -> a with
  weight 1/k. To compute a/c, find a path from a to c and multiply the
  edge weights along the path.
  
Also solvable with Union-Find (weighted union-find where each node has
  a weight relative to its root).
Real-world: Currency exchange rate computation — given known exchange
  rates between some currency pairs, derive rates for unknown pairs by
  multiplying along a path of known exchanges.
```

---

**P16.72** [M] -- Number of Enclaves (LeetCode 1020)

Count land cells NOT reachable from the border.

```java
public int numEnclaves(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    
    // DFS from all border land cells — sink them
    for (int i = 0; i < m; i++) {
        if (grid[i][0] == 1) sink(grid, i, 0, m, n);
        if (grid[i][n-1] == 1) sink(grid, i, n-1, m, n);
    }
    for (int j = 0; j < n; j++) {
        if (grid[0][j] == 1) sink(grid, 0, j, m, n);
        if (grid[m-1][j] == 1) sink(grid, m-1, j, m, n);
    }
    
    // Count remaining land cells
    int count = 0;
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == 1) count++;
        }
    }
    return count;
}

private void sink(int[][] grid, int r, int c, int m, int n) {
    if (r < 0 || r >= m || c < 0 || c >= n || grid[r][c] != 1) return;
    grid[r][c] = 0;
    sink(grid, r+1, c, m, n);
    sink(grid, r-1, c, m, n);
    sink(grid, r, c+1, m, n);
    sink(grid, r, c-1, m, n);
}
```

```
Time:  O(M * N)
Space: O(M * N) recursion stack worst case
Pattern: DFS from boundary (same as Surrounded Regions P16.19)
Same reverse-thinking technique: instead of finding enclosed land (hard),
  eliminate border-connected land (easy), count what remains.
Real-world: Geofencing — count cells (server zones) completely enclosed
  within a secure perimeter, not reachable from the external network.
```

---

**P16.73** [H] -- Shortest Path to Get All Keys (LeetCode 864)

Grid with keys (lowercase) and locks (uppercase). Find shortest path to collect all keys.

```java
public int shortestPathAllKeys(String[] grid) {
    int m = grid.length, n = grid[0].length();
    int startR = 0, startC = 0, totalKeys = 0;
    
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            char c = grid[i].charAt(j);
            if (c == '@') { startR = i; startC = j; }
            if (c >= 'a' && c <= 'f') totalKeys++;
        }
    }
    
    int allKeys = (1 << totalKeys) - 1; // bitmask of all keys
    
    // State: (row, col, keys_held) — BFS on expanded state space
    boolean[][][] visited = new boolean[m][n][allKeys + 1];
    Queue<int[]> queue = new ArrayDeque<>();
    queue.offer(new int[]{startR, startC, 0});
    visited[startR][startC][0] = true;
    int steps = 0;
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            int[] curr = queue.poll();
            int r = curr[0], c = curr[1], keys = curr[2];
            
            if (keys == allKeys) return steps;
            
            for (int[] d : dirs) {
                int nr = r + d[0], nc = c + d[1], nk = keys;
                if (nr < 0 || nr >= m || nc < 0 || nc >= n) continue;
                
                char cell = grid[nr].charAt(nc);
                if (cell == '#') continue; // wall
                if (cell >= 'A' && cell <= 'F' && (keys & (1 << (cell - 'A'))) == 0)
                    continue; // lock without key
                if (cell >= 'a' && cell <= 'f')
                    nk |= (1 << (cell - 'a')); // pick up key
                
                if (!visited[nr][nc][nk]) {
                    visited[nr][nc][nk] = true;
                    queue.offer(new int[]{nr, nc, nk});
                }
            }
        }
        steps++;
    }
    return -1;
}
```

```
Time:  O(M * N * 2^K) where K = number of keys (max 6)
Space: O(M * N * 2^K) for the visited array
Pattern: BFS on expanded state space (state = position + bitmask of keys)
The state is not just (row, col) but (row, col, keys_held). Two visits
  to the same cell with different key sets are DIFFERENT states. The
  bitmask encodes which keys are held: bit i = 1 means key 'a'+i is held.
  
With K <= 6, the state space multiplier is 2^6 = 64. For a 30x30 grid,
  total states = 30 * 30 * 64 = 57,600. Very manageable.
JVM insight: boolean[30][30][64] = 57,600 booleans = 57,600 bytes =
  56KB. Fits in L1 cache. The BFS accesses this array with good locality
  because adjacent grid cells map to adjacent memory.
Real-world: Robot task planning — a robot navigates a warehouse collecting
  items (keys) to access restricted zones (locks). Find the shortest
  route to collect all required items.
```

---

**P16.74** [H] -- Making A Large Island (LeetCode 827)

Change at most one 0 to 1. Find the largest island.

```java
public int largestIsland(int[][] grid) {
    int n = grid.length;
    Map<Integer, Integer> sizeMap = new HashMap<>();
    int islandId = 2; // start labeling from 2 (0 and 1 are used)
    
    // Step 1: Label all islands with unique IDs and record sizes
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == 1) {
                int size = dfsLabel(grid, i, j, n, islandId);
                sizeMap.put(islandId, size);
                islandId++;
            }
        }
    }
    
    // Step 2: For each 0, check what islands it would connect
    int maxSize = sizeMap.values().stream().mapToInt(Integer::intValue).max().orElse(0);
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == 0) {
                Set<Integer> adjacentIslands = new HashSet<>();
                for (int[] d : dirs) {
                    int ni = i + d[0], nj = j + d[1];
                    if (ni >= 0 && ni < n && nj >= 0 && nj < n && grid[ni][nj] > 1) {
                        adjacentIslands.add(grid[ni][nj]);
                    }
                }
                int total = 1; // the flipped cell itself
                for (int id : adjacentIslands) total += sizeMap.get(id);
                maxSize = Math.max(maxSize, total);
            }
        }
    }
    return maxSize;
}

private int dfsLabel(int[][] grid, int r, int c, int n, int id) {
    if (r < 0 || r >= n || c < 0 || c >= n || grid[r][c] != 1) return 0;
    grid[r][c] = id;
    return 1 + dfsLabel(grid, r+1, c, n, id)
             + dfsLabel(grid, r-1, c, n, id)
             + dfsLabel(grid, r, c+1, n, id)
             + dfsLabel(grid, r, c-1, n, id);
}
```

```
Time:  O(N^2) — label all cells + check all zero cells
Space: O(N^2) for recursion + size map
Pattern: DFS labeling + adjacency check
Two-pass approach:
  1. DFS to label each island with unique ID and compute its size
  2. For each 0 cell, find adjacent unique island IDs, sum their sizes + 1
The HashSet prevents double-counting when a zero cell borders the same
  island on multiple sides.
JVM insight: Using a HashSet of island IDs (Integer) for each zero cell
  creates many small short-lived HashSets. For N=500, that is up to 250K
  HashSets. Each is tiny (1-4 entries), but the allocation pressure adds
  up. Optimization: use a boolean[islandId] or sort-and-dedup.
Real-world: Network design — if you can add one link, which zero-cell
  placement maximizes the connected component size? This is the "best
  single infrastructure investment" problem.
```

---

**P16.75** [H] -- Alien Dictionary — Verify Order (Advanced variant)

Given a dictionary of words in an alien language, return the sorted character order. If multiple valid orderings exist, return the lexicographically smallest one.

```java
public String alienOrderSmallest(String[] words) {
    Map<Character, Set<Character>> graph = new HashMap<>();
    Map<Character, Integer> inDegree = new HashMap<>();
    
    for (String word : words) {
        for (char c : word.toCharArray()) {
            graph.putIfAbsent(c, new HashSet<>());
            inDegree.putIfAbsent(c, 0);
        }
    }
    
    for (int i = 0; i < words.length - 1; i++) {
        String w1 = words[i], w2 = words[i + 1];
        if (w1.length() > w2.length() && w1.startsWith(w2)) return "";
        for (int j = 0; j < Math.min(w1.length(), w2.length()); j++) {
            if (w1.charAt(j) != w2.charAt(j)) {
                if (graph.get(w1.charAt(j)).add(w2.charAt(j))) {
                    inDegree.merge(w2.charAt(j), 1, Integer::sum);
                }
                break;
            }
        }
    }
    
    // Kahn's with PriorityQueue for lexicographically smallest order
    PriorityQueue<Character> pq = new PriorityQueue<>();
    for (var entry : inDegree.entrySet()) {
        if (entry.getValue() == 0) pq.offer(entry.getKey());
    }
    
    StringBuilder sb = new StringBuilder();
    while (!pq.isEmpty()) {
        char c = pq.poll();
        sb.append(c);
        for (char next : graph.get(c)) {
            inDegree.merge(next, -1, Integer::sum);
            if (inDegree.get(next) == 0) pq.offer(next);
        }
    }
    return sb.length() == inDegree.size() ? sb.toString() : "";
}
```

```
Time:  O(C + U * log U) where C = total chars, U = unique chars
  The PriorityQueue adds log U per operation, but U <= 26, so log U <= 5.
Space: O(U^2) worst case for graph edges
Pattern: Topological sort with lexicographic tiebreaking
The only change from standard Kahn's: use a PriorityQueue (min-heap)
  instead of a regular Queue. When multiple nodes have in-degree 0,
  pick the smallest character. This guarantees the lexicographically
  smallest valid topological order.
Real-world: When multiple valid build orderings exist, choose the one
  that alphabetically orders modules — useful for deterministic,
  reproducible builds.
```

---

## Key Takeaways

1. **BFS is for shortest paths in unweighted graphs. Period.** The first time BFS reaches a node is via the shortest path. For weighted graphs, use Dijkstra (non-negative) or Bellman-Ford (negative edges). For 0/1 weights, use 0-1 BFS with a Deque for O(V+E) instead of O((V+E) log V). Multi-source BFS handles "nearest from any source" by enqueuing all sources initially.

2. **DFS is for structure, exhaustive exploration, and backtracking.** DFS finds connected components, detects cycles (back edges in directed graphs), and powers backtracking. Use iterative DFS with `ArrayDeque` when recursion depth exceeds 10,000 to avoid `StackOverflowError`. Mark visited when enqueuing (BFS) or upon entry (DFS) to prevent redundant exploration.

3. **Tree recursion is bottom-up: ask "what do I need from my children?"** The post-order pattern solves children first, then combines at the parent. The function RETURNS information the parent needs (height, max chain, gain) while UPDATING a separate global variable (diameter, max path sum). This decoupling of return value and answer is the most common interview pattern for tree problems.

4. **Topological sort encodes dependency order; cycle detection is a byproduct.** Kahn's algorithm (BFS with in-degree counting) naturally detects cycles: if fewer than V nodes are processed, a cycle exists. The number of BFS levels equals the longest dependency chain (critical path). DFS-based topological sort uses reverse post-order and detects cycles via back edges (gray-to-gray in 3-color scheme).

5. **Union-Find answers connectivity in O(alpha(N)) -- effectively O(1).** With path compression and union by rank, Union-Find is the fastest way to answer "are X and Y connected?" after a series of merge operations. The `components` counter tracks the number of disjoint sets. Key formula: `max removable = N - components`. Use when edges arrive dynamically; use DFS/BFS when the graph is static.

6. **Dijkstra with lazy deletion is the practical shortest-path workhorse.** Java's `PriorityQueue` lacks decrease-key, so add new entries and skip stale ones (distance > current best). This is simpler and often faster than theoretically superior Fibonacci heap implementations. For grid problems, Dijkstra runs in O(MN log MN). For minimax paths (minimize maximum edge), Dijkstra still works because the cost function is monotonically non-decreasing.

7. **State-space expansion unlocks BFS for complex problems.** When the state is more than just position -- keys held (bitmask), steps remaining, direction facing -- expand the BFS state accordingly. The visited array grows multiplicatively: `visited[row][col][keys]`. BFS on the expanded state still guarantees shortest path. Common expansions: bitmask (up to 2^K), remaining budget (up to K), direction (4 or 8).

8. **LCA is a building block for tree distance and path queries.** `distance(u, v) = depth[u] + depth[v] - 2 * depth[LCA(u,v)]`. For single queries, O(N) recursive LCA suffices. For many queries, preprocess with binary lifting (O(N log N) preprocessing, O(log N) per query) or Euler tour + sparse table (O(N log N) preprocessing, O(1) per query). The parent-pointer LCA trick (walk up from both nodes) is identical to linked list intersection.

9. **Reverse thinking simplifies boundary problems.** Instead of "find cells enclosed by walls" (hard), find "cells connected to the border" (easy) and flip everything else. Instead of "which cells can water flow FROM" (forward, complex), find "which cells can water flow TO each ocean" (backward from border, simple). This applies to Surrounded Regions, Pacific Atlantic, and Number of Enclaves.

10. **Every tree/graph pattern maps to production systems.** BFS = GC mark phase, web crawlers, network broadcast. DFS = `find` command, dead code elimination, maze generation. Topological sort = build order, spreadsheet evaluation, migration sequencing. Union-Find = network monitoring, friend groups, MST. Dijkstra = OSPF routing. Bellman-Ford = BGP routing. LCA = DNS hierarchy, git merge-base. You have been using these algorithms for 15 years in production. Now you know their names.

---

[Previous: Chapter 15 -- Patterns: Arrays & Strings](15-pattern-arrays-strings.md) | [Next: Chapter 17 -- Patterns: Dynamic Programming](17-pattern-dynamic-programming.md)
