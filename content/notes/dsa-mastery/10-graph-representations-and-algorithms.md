# Chapter 10: Graph Representations & Algorithms

## The Connective Tissue of Every System You Have Ever Built

Every distributed system is a graph. Every dependency tree is a graph. Every network route, every social connection, every build pipeline, every database foreign-key relationship -- they are all graphs. When you debug a circular dependency in your microservices, you are detecting a cycle. When your CI/CD pipeline resolves build order, it is running topological sort. When your OSPF router finds the fastest path to a destination, it is running Dijkstra. When your garbage collector determines which objects are alive, it is running BFS from GC roots.

Graphs are not an abstract academic exercise. They are the literal model of how systems connect. And yet, most developers treat them as the "hard topic" they skim before interviews. This chapter changes that. We will build every major graph algorithm from the ground up, understand their JVM behavior, trace their memory footprints, and connect each one to real production systems you have already worked with.

After this chapter, you will not just "know Dijkstra" -- you will know why Java's `PriorityQueue` lacks decrease-key and how lazy deletion compensates, why Bellman-Ford powers BGP while Dijkstra powers OSPF, and why Tarjan's SCC algorithm uses a single DFS while Kosaraju's needs two.

---

## 10.1 Graph Representations: Choosing Your Data Layout

Before a single algorithm runs, you make the most consequential decision: how do you store the graph? This choice determines memory consumption, cache behavior, and algorithmic constant factors. There is no universally best representation -- each optimizes for different access patterns.

### The Three Fundamental Representations

```
Graph Example (5 nodes, 6 edges, directed):
    0 → 1 (weight 4)
    0 → 2 (weight 1)
    1 → 3 (weight 1)
    2 → 1 (weight 2)
    2 → 3 (weight 5)
    3 → 4 (weight 3)
```

### 10.1.1 Adjacency Matrix

Store a V x V grid where `matrix[i][j]` indicates whether an edge exists from node `i` to node `j`.

```java
// Boolean adjacency matrix (unweighted)
boolean[][] adj = new boolean[V][V];
adj[0][1] = true;  // edge 0 → 1
adj[0][2] = true;  // edge 0 → 2

// Integer adjacency matrix (weighted)
int[][] adj = new int[V][V];
Arrays.fill(adj[0], Integer.MAX_VALUE);  // initialize to "no edge"
// ... fill all rows
adj[0][1] = 4;  // edge 0 → 1, weight 4
adj[0][2] = 1;  // edge 0 → 2, weight 1
adj[1][3] = 1;
adj[2][1] = 2;
adj[2][3] = 5;
adj[3][4] = 3;
```

```
Matrix visualization (weights, INF = no edge):

      0    1    2    3    4
  ┌────┬────┬────┬────┬────┐
0 │ INF│  4 │  1 │INF │INF │
  ├────┼────┼────┼────┼────┤
1 │INF │INF │INF │  1 │INF │
  ├────┼────┼────┼────┼────┤
2 │INF │  2 │INF │  5 │INF │
  ├────┼────┼────┼────┼────┤
3 │INF │INF │INF │INF │  3 │
  ├────┼────┼────┼────┼────┤
4 │INF │INF │INF │INF │INF │
  └────┴────┴────┴────┴────┘
```

**Properties:**
- Space: O(V^2). For V = 10,000, that is 100 million entries. With `int[][]`, that is 400 MB. With `boolean[][]`, 100 MB.
- Edge existence check: O(1) -- just `matrix[u][v]`.
- Iterate all neighbors of u: O(V) -- must scan entire row.
- Add/remove edge: O(1).

**When to use:** Dense graphs where E approaches V^2. Floyd-Warshall requires matrix form. Small graphs (V < 1000) where the O(V^2) space is acceptable.

**JVM perspective -- the jagged array trap:**

```java
int[][] matrix = new int[V][V];
```

This is NOT a contiguous 2D block. Java has no true multi-dimensional arrays. This creates:
- 1 array of V references (the outer `int[][]`)
- V separate `int[]` arrays, each of length V

```
matrix (int[][], V references)
  ├─→ int[V]  at address 0x1000  (row 0)
  ├─→ int[V]  at address 0x3000  (row 1, NOT adjacent to row 0!)
  ├─→ int[V]  at address 0x7000  (row 2, scattered)
  ...
```

Accessing `matrix[i][j]` requires TWO pointer dereferences: first load `matrix[i]` (pointer chase to the row array), then load `row[j]`. The V row arrays are separate heap objects, potentially scattered across memory.

**Optimization: flatten to 1D for small dense graphs.**

```java
// Flattened adjacency matrix — single contiguous block
int[] matrix = new int[V * V];

// Access (i, j):
int weight = matrix[i * V + j];

// Set edge:
matrix[i * V + j] = weight;

// Memory: one array object, V*V ints contiguous
// Cache behavior: row-major traversal is sequential cache hits
// No pointer chasing. One header instead of V+1 headers.
```

Memory comparison for V = 1000:
```
int[1000][1000] (jagged):
  Outer array: 16 + 1000 × 4 = 4,016 bytes
  1000 inner arrays: 1000 × (16 + 1000 × 4) = 1000 × 4,016 = 4,016,000 bytes
  Total: ~4.02 MB + 1001 object headers
  GC: must trace 1001 objects

int[1_000_000] (flattened):
  Single array: 16 + 1_000_000 × 4 = 4,000,016 bytes
  Total: ~3.81 MB + 1 object header
  GC: must trace 1 object
```

The flattened array saves about 200 KB in headers and eliminates 1000 pointer chases. For Floyd-Warshall's triple loop over V^3 iterations, this cache improvement is measurable.

### 10.1.2 Adjacency List

For each vertex, store a list of its neighbors (and optionally edge weights).

```java
// Approach 1: List of Lists (most common in interview code)
// Each inner list stores {neighbor, weight} pairs
List<List<int[]>> adj = new ArrayList<>();
for (int i = 0; i < V; i++) {
    adj.add(new ArrayList<>());
}
adj.get(0).add(new int[]{1, 4});  // 0 → 1, weight 4
adj.get(0).add(new int[]{2, 1});  // 0 → 2, weight 1
adj.get(1).add(new int[]{3, 1});  // 1 → 3, weight 1
adj.get(2).add(new int[]{1, 2});  // 2 → 1, weight 2
adj.get(2).add(new int[]{3, 5});  // 2 → 3, weight 5
adj.get(3).add(new int[]{4, 3});  // 3 → 4, weight 3

// Approach 2: Map-based (when nodes are not 0-indexed integers)
Map<String, List<int[]>> adj = new HashMap<>();
// Or with a proper Edge class:
Map<String, List<Edge>> adj = new HashMap<>();

// Approach 3: Array of Lists (fixed node count, slightly faster)
@SuppressWarnings("unchecked")
List<int[]>[] adj = new ArrayList[V];
for (int i = 0; i < V; i++) {
    adj[i] = new ArrayList<>();
}
```

```
Adjacency list visualization:

0 → [(1,4), (2,1)]
1 → [(3,1)]
2 → [(1,2), (3,5)]
3 → [(4,3)]
4 → []
```

**Properties:**
- Space: O(V + E). For sparse graphs (E << V^2), dramatically less than matrix.
- Edge existence check: O(degree(u)) -- must scan u's neighbor list.
- Iterate all neighbors of u: O(degree(u)) -- exactly the data you need, no wasted scans.
- Add edge: O(1) amortized (ArrayList.add).
- Remove edge: O(degree(u)) -- scan to find and remove.

**When to use:** Sparse graphs (most real-world graphs). BFS, DFS, Dijkstra, topological sort all iterate neighbors, which adjacency lists serve perfectly.

**JVM memory analysis for `List<List<int[]>>`:**

```
V = 10,000 nodes, E = 50,000 edges (sparse graph)

Outer ArrayList:
  ArrayList object: 48 bytes
  Object[] backing: 16 + 10,000 × 4 = 40,016 bytes

10,000 inner ArrayLists:
  Each ArrayList: 48 bytes + Object[] backing
  Average degree = 50,000 / 10,000 = 5 edges per node
  Average backing array: 16 + 5 × 4 ≈ 36 bytes (but ArrayList default capacity is 10)
  So: 10,000 × (48 + 56) = ~1.04 MB

50,000 int[] edge arrays (each {neighbor, weight}):
  Each int[2]: 16 header + 8 data = 24 bytes
  50,000 × 24 = 1.2 MB

Total: ~2.3 MB (vs ~400 MB for int[10000][10000] matrix)
Object count: 1 + 10,001 + 50,000 = ~60,002 objects
```

Compare adjacency matrix for the same graph: 400 MB with 10,001 objects. The adjacency list wins by a factor of 170x on memory for this sparse graph. But it creates 60,000 objects for GC to trace vs 10,001.

**Optimization: CSR (Compressed Sparse Row) for read-only graphs.**

If you build the graph once and never modify it, CSR eliminates all per-edge objects:

```java
// CSR representation: 3 flat arrays, 0 per-edge objects
int[] offset = new int[V + 1];   // offset[i] = start index of node i's neighbors
int[] neighbors = new int[E];    // all neighbors concatenated
int[] weights = new int[E];      // corresponding weights

// Build: after counting degrees and computing prefix sums
// offset[0] = 0, offset[1] = 2, offset[2] = 3, offset[3] = 5, offset[4] = 6, offset[5] = 6
// neighbors = [1, 2, 3, 1, 3, 4]
// weights   = [4, 1, 1, 2, 5, 3]

// Iterate neighbors of node u:
for (int i = offset[u]; i < offset[u + 1]; i++) {
    int neighbor = neighbors[i];
    int weight = weights[i];
}

// Total memory for V=10,000, E=50,000:
//   offset: 16 + 10,001 × 4 = ~40 KB
//   neighbors: 16 + 50,000 × 4 = ~200 KB
//   weights: 16 + 50,000 × 4 = ~200 KB
//   Total: ~440 KB — that is 5x less than the adjacency list
//   Objects: 3 arrays. GC traces 3 objects.
```

CSR is what libraries like JGraphT use internally for immutable graphs. Sequential neighbor iteration is cache-perfect because all neighbors are contiguous in the `neighbors` array.

### 10.1.3 Edge List

Simply store all edges as a flat list.

```java
// Each edge: {from, to, weight}
List<int[]> edges = new ArrayList<>();
edges.add(new int[]{0, 1, 4});
edges.add(new int[]{0, 2, 1});
edges.add(new int[]{1, 3, 1});
edges.add(new int[]{2, 1, 2});
edges.add(new int[]{2, 3, 5});
edges.add(new int[]{3, 4, 3});

// Or for Kruskal's (sort by weight):
int[][] edges = new int[][]{{0,2,1}, {1,3,1}, {2,1,2}, {3,4,3}, {0,1,4}, {2,3,5}};
Arrays.sort(edges, (a, b) -> a[2] - b[2]);
```

**Properties:**
- Space: O(E).
- Edge existence check: O(E) -- linear scan.
- Iterate all neighbors of u: O(E) -- must scan all edges.
- Perfect for algorithms that iterate ALL edges: Kruskal's MST, Bellman-Ford.

**When to use:** Kruskal's algorithm (sort all edges by weight), Bellman-Ford (relax all edges V-1 times), or when you receive the graph as a list of edges and only need edge-global operations.

### 10.1.4 Representation Comparison Summary

```
                    Adjacency Matrix    Adjacency List    Edge List
──────────────────────────────────────────────────────────────────────
Space               O(V²)              O(V + E)          O(E)
Edge check          O(1)               O(degree)         O(E)
All neighbors       O(V)               O(degree)         O(E)
Add edge            O(1)               O(1)              O(1)
Remove edge         O(1)               O(degree)         O(E)
All edges           O(V²)              O(V + E)          O(E)
Best for            Dense, Floyd-      BFS, DFS,         Kruskal,
                    Warshall           Dijkstra          Bellman-Ford
JVM objects         V+1 arrays or 1    V + E+ objects    E objects or
                    flat array                           1 flat array
Cache behavior      Good (row scan)    Poor (scattered   Good (sequential)
                    if flattened       edge objects)
```

---

## 10.2 BFS (Breadth-First Search)

BFS explores a graph level by level, like ripples expanding from a stone dropped in water. It is the go-to algorithm for shortest path in unweighted graphs, and its variants power everything from web crawlers to garbage collectors.

### 10.2.1 Standard BFS

```java
/**
 * Standard BFS from a source node.
 * Time:  O(V + E)
 * Space: O(V) for visited set and queue
 */
public List<Integer> bfs(List<List<Integer>> adj, int source) {
    int V = adj.size();
    boolean[] visited = new boolean[V];
    List<Integer> order = new ArrayList<>();
    
    // ALWAYS use ArrayDeque, never LinkedList, for queue operations.
    // ArrayDeque: O(1) amortized offer/poll, contiguous memory, no per-node objects.
    // LinkedList: O(1) offer/poll but creates a Node object per element (40 bytes),
    //   scattered across heap, terrible cache behavior.
    Deque<Integer> queue = new ArrayDeque<>();
    
    visited[source] = true;
    queue.offer(source);
    
    while (!queue.isEmpty()) {
        int u = queue.poll();
        order.add(u);
        
        for (int v : adj.get(u)) {
            if (!visited[v]) {
                visited[v] = true;  // mark visited WHEN ENQUEUING, not when dequeuing
                queue.offer(v);
            }
        }
    }
    return order;
}
```

**Critical detail: mark visited when enqueuing, not when dequeuing.** If you mark visited only when you dequeue, the same node can be added to the queue multiple times by different neighbors, wasting memory and time. For a node with in-degree K, it would be enqueued K times instead of once.

**JVM note on `ArrayDeque` vs `LinkedList`:**

```
ArrayDeque (circular buffer backed by Object[]):
  - Internal array: 16 header + capacity × 4 bytes (references)
  - Default capacity: 16 → 80 bytes
  - Grows by doubling. For BFS on V nodes: at most V elements → ~4V bytes
  - Elements are Integer autoboxed: V × 16 bytes
  - But wait: Integer.valueOf() caches -128 to 127. For graph node indices
    within that range, no new objects. For larger indices, new Integer per enqueue.
  
  Total for V=10,000: ~200 KB (array + Integer objects)

LinkedList (doubly-linked nodes):
  - Each Node: 16 header + 4 item ref + 4 prev ref + 4 next ref + 4 padding = 32 bytes
  - For V=10,000 nodes: 320 KB just for Node objects, scattered across heap
  - Plus Integer objects: same as ArrayDeque
  
  Total for V=10,000: ~520 KB, 10,000 more objects for GC, terrible cache behavior

Verdict: ArrayDeque wins on every metric. The JDK documentation itself recommends
ArrayDeque over LinkedList for queue and stack usage.
```

### 10.2.2 Level-Order BFS (Tracking Depth)

Many problems require knowing the level/depth of each node. There are two clean approaches.

**Approach 1: Size-based (most common, cleanest)**

```java
/**
 * BFS with level tracking using queue size.
 * After processing all nodes at level L, only level L+1 nodes remain in queue.
 */
public int bfsLevels(List<List<Integer>> adj, int source, int target) {
    int V = adj.size();
    boolean[] visited = new boolean[V];
    Deque<Integer> queue = new ArrayDeque<>();
    
    visited[source] = true;
    queue.offer(source);
    int level = 0;
    
    while (!queue.isEmpty()) {
        int size = queue.size();  // snapshot current level size
        for (int i = 0; i < size; i++) {
            int u = queue.poll();
            if (u == target) return level;
            
            for (int v : adj.get(u)) {
                if (!visited[v]) {
                    visited[v] = true;
                    queue.offer(v);
                }
            }
        }
        level++;
    }
    return -1;  // target unreachable
}
```

**Approach 2: Distance array (avoids nested loop)**

```java
/**
 * BFS recording distance to every node.
 * dist[v] = -1 means unvisited (serves double duty as visited check).
 */
public int[] bfsDistances(List<List<Integer>> adj, int source) {
    int V = adj.size();
    int[] dist = new int[V];
    Arrays.fill(dist, -1);
    
    Deque<Integer> queue = new ArrayDeque<>();
    dist[source] = 0;
    queue.offer(source);
    
    while (!queue.isEmpty()) {
        int u = queue.poll();
        for (int v : adj.get(u)) {
            if (dist[v] == -1) {
                dist[v] = dist[u] + 1;
                queue.offer(v);
            }
        }
    }
    return dist;
}
```

The distance-array approach eliminates the nested loop and is cleaner when you need all distances rather than just source-to-target.

### 10.2.3 Multi-Source BFS

Start BFS from multiple sources simultaneously. All sources begin at level 0, and the BFS wavefront expands outward from all of them at once.

```java
/**
 * Multi-source BFS: enqueue all sources at distance 0.
 * Classic pattern: "rotting oranges" — all initially rotten oranges start simultaneously.
 * 
 * Time:  O(V + E) — same as single-source BFS
 * Space: O(V)
 */
public int[][] multiSourceBFS(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    int[][] dist = new int[m][n];
    for (int[] row : dist) Arrays.fill(row, Integer.MAX_VALUE);
    
    Deque<int[]> queue = new ArrayDeque<>();
    
    // Enqueue ALL sources at distance 0
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == SOURCE) {
                dist[i][j] = 0;
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
                && dist[nr][nc] == Integer.MAX_VALUE) {
                dist[nr][nc] = dist[r][c] + 1;
                queue.offer(new int[]{nr, nc});
            }
        }
    }
    return dist;  // dist[i][j] = shortest distance to nearest source
}
```

**Real-world correlation:** The JVM garbage collector's mark phase is essentially multi-source BFS. GC roots (static fields, thread-local references, JNI references) are the sources. The collector starts from all roots simultaneously and marks every reachable object. Any object not reached is garbage.

### 10.2.4 0-1 BFS

When edge weights are only 0 or 1, standard Dijkstra with a PriorityQueue is overkill (O((V+E) log V)). 0-1 BFS achieves the same result in O(V+E) using a `Deque`:

```java
/**
 * 0-1 BFS: Dijkstra-equivalent for graphs with only 0 and 1 weight edges.
 * 
 * Key insight: when processing node u with distance d:
 *   - Weight-0 edge to v: dist[v] = d + 0 = d → same level, addFirst (front of deque)
 *   - Weight-1 edge to v: dist[v] = d + 1     → next level, addLast (back of deque)
 *
 * The deque maintains a sorted order: all distance-d nodes before distance-(d+1) nodes.
 * This is essentially BFS where 0-weight edges don't increment the level.
 *
 * Time:  O(V + E) — each node processed once
 * Space: O(V)
 */
public int[] zeroOneBFS(int V, List<List<int[]>> adj, int source) {
    int[] dist = new int[V];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[source] = 0;
    
    Deque<Integer> deque = new ArrayDeque<>();
    deque.offerFirst(source);
    
    while (!deque.isEmpty()) {
        int u = deque.pollFirst();
        
        for (int[] edge : adj.get(u)) {
            int v = edge[0], w = edge[1];  // w is 0 or 1
            if (dist[u] + w < dist[v]) {
                dist[v] = dist[u] + w;
                if (w == 0) {
                    deque.offerFirst(v);   // same distance level → front
                } else {
                    deque.offerLast(v);    // next distance level → back
                }
            }
        }
    }
    return dist;
}
```

**When to use:** Grid problems where some moves are "free" (cost 0) and others cost 1. Example: minimum flips to reach bottom-right in a binary grid where moving along the current direction is free.

### 10.2.5 Bidirectional BFS

Search from both source and target simultaneously. When the two frontiers meet, you have found the shortest path. This reduces the search space from O(b^d) to O(b^(d/2)), where b is the branching factor and d is the depth.

```java
/**
 * Bidirectional BFS: search from source and target simultaneously.
 *
 * Why it is faster: if branching factor is b and depth is d:
 *   Regular BFS explores: b + b² + ... + b^d ≈ b^d nodes
 *   Bidirectional explores: 2 × (b + b² + ... + b^(d/2)) ≈ 2 × b^(d/2) nodes
 *
 * For b=10, d=6: regular = 1,000,000 nodes. Bidirectional = 2,000 nodes. 500x less.
 *
 * Time:  O(b^(d/2)) where b = branching factor, d = shortest path length
 * Space: O(b^(d/2))
 */
public int bidirectionalBFS(List<List<Integer>> adj, int source, int target) {
    if (source == target) return 0;
    
    // Two frontier sets
    Set<Integer> frontA = new HashSet<>();
    Set<Integer> frontB = new HashSet<>();
    Set<Integer> visitedA = new HashSet<>();
    Set<Integer> visitedB = new HashSet<>();
    
    frontA.add(source);
    frontB.add(target);
    visitedA.add(source);
    visitedB.add(target);
    int level = 0;
    
    while (!frontA.isEmpty() && !frontB.isEmpty()) {
        // Always expand the SMALLER frontier — this balances the search
        if (frontA.size() > frontB.size()) {
            Set<Integer> temp = frontA; frontA = frontB; frontB = temp;
            temp = visitedA; visitedA = visitedB; visitedB = temp;
        }
        
        Set<Integer> nextFront = new HashSet<>();
        for (int u : frontA) {
            for (int v : adj.get(u)) {
                if (visitedB.contains(v)) {
                    return level + 1;  // frontiers meet
                }
                if (visitedA.add(v)) {
                    nextFront.add(v);
                }
            }
        }
        frontA = nextFront;
        level++;
    }
    return -1;  // no path
}
```

**Key optimization:** Always expand the smaller frontier. This prevents one side from growing massive while the other stays small.

**Real-world correlation:** Social network "degrees of separation" queries use bidirectional BFS. LinkedIn's "how you are connected" feature searches from both you and the target person, meeting in the middle.

### 10.2.6 BFS on Implicit Graphs

Many BFS problems do not give you an explicit adjacency list. Instead, the graph is implicit in the problem structure: grid cells are nodes, adjacent cells are edges; puzzle states are nodes, valid moves are edges.

```java
/**
 * BFS pattern for implicit grid graphs.
 * Nodes = grid cells (r, c)
 * Edges = 4-directional moves (up, down, left, right)
 * 
 * Common pattern for: shortest path in binary matrix, rotting oranges,
 * walls and gates, number of islands (BFS variant), etc.
 */
public int shortestPathInGrid(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    if (grid[0][0] == 1 || grid[m-1][n-1] == 1) return -1;
    
    boolean[][] visited = new boolean[m][n];
    Deque<int[]> queue = new ArrayDeque<>();
    queue.offer(new int[]{0, 0});
    visited[0][0] = true;
    int dist = 1;
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            int[] cell = queue.poll();
            int r = cell[0], c = cell[1];
            if (r == m - 1 && c == n - 1) return dist;
            
            for (int[] d : dirs) {
                int nr = r + d[0], nc = c + d[1];
                if (nr >= 0 && nr < m && nc >= 0 && nc < n
                    && !visited[nr][nc] && grid[nr][nc] == 0) {
                    visited[nr][nc] = true;
                    queue.offer(new int[]{nr, nc});
                }
            }
        }
        dist++;
    }
    return -1;
}
```

**JVM note:** Each `new int[]{r, c}` in the queue creates a small heap object (24 bytes: 16 header + 8 data). For an M x N grid, up to M*N of these are created. If you need to squeeze out performance, encode the coordinate as a single int: `r * n + c`, and decode as `r = code / n, c = code % n`. This eliminates all per-cell objects:

```java
// Encoding trick: store (r, c) as single int
queue.offer(r * n + c);

// Decode:
int code = queue.poll();
int r = code / n, c = code % n;

// For Integer autoboxing: codes up to 127 use Integer cache,
// larger codes create new Integer objects. But ArrayDeque's internal
// Object[] stores references regardless, so the boxing still happens.
// However, eliminating the int[2] saves 20 bytes per cell vs 16 for Integer.
```

---

## 10.3 DFS (Depth-First Search)

DFS plunges as deep as possible before backtracking. It is the backbone of cycle detection, topological sort, connected components, articulation points, bridges, and strongly connected components. If BFS is a wave expanding outward, DFS is a spelunker exploring every cave passage to its end before trying the next one.

### 10.3.1 Recursive DFS

```java
/**
 * Recursive DFS — simple, elegant, but dangerous at scale.
 * 
 * Time:  O(V + E)
 * Space: O(V) for visited array + O(V) for call stack = O(V)
 * 
 * WARNING: Each recursive call adds a stack frame (~32-64 bytes on HotSpot).
 * For V = 100,000 nodes on a linear graph (worst case: a path), that is
 * 100,000 frames × ~50 bytes = ~5 MB of stack. Default thread stack is
 * 512 KB to 1 MB. You WILL get StackOverflowError.
 * 
 * Solutions:
 *   1. Iterative DFS with explicit stack (preferred)
 *   2. Increase stack size: -Xss8m (hack, not robust)
 *   3. Spawn thread with large stack: new Thread(group, target, name, stackSize)
 */
public void dfs(List<List<Integer>> adj, int u, boolean[] visited, List<Integer> order) {
    visited[u] = true;
    order.add(u);
    
    for (int v : adj.get(u)) {
        if (!visited[v]) {
            dfs(adj, v, visited, order);
        }
    }
}
```

### 10.3.2 Iterative DFS with Explicit Stack

```java
/**
 * Iterative DFS using ArrayDeque as stack.
 * No stack overflow risk. Handles graphs of any size.
 * 
 * Subtle difference from recursive DFS: the order of neighbor processing
 * is reversed (LIFO), so the traversal order may differ. If exact order
 * matters, push neighbors in reverse order.
 */
public List<Integer> dfsIterative(List<List<Integer>> adj, int source) {
    int V = adj.size();
    boolean[] visited = new boolean[V];
    List<Integer> order = new ArrayList<>();
    
    Deque<Integer> stack = new ArrayDeque<>();
    stack.push(source);
    
    while (!stack.isEmpty()) {
        int u = stack.pop();
        if (visited[u]) continue;  // may be pushed multiple times
        visited[u] = true;
        order.add(u);
        
        // Push neighbors. For same order as recursive DFS, push in reverse.
        List<Integer> neighbors = adj.get(u);
        for (int i = neighbors.size() - 1; i >= 0; i--) {
            int v = neighbors.get(i);
            if (!visited[v]) {
                stack.push(v);
            }
        }
    }
    return order;
}
```

**Note the difference from BFS:** In BFS, we mark visited when enqueuing. In iterative DFS, we mark visited when popping (because the same node can be pushed by multiple parents, and we only want to process it once). This means nodes may exist in the stack multiple times, but that is fine -- the `visited` check at pop time handles it.

### 10.3.3 DFS Edge Classification and Timestamps

DFS classifies every edge in the graph into four types. These classifications are the foundation for cycle detection, topological sort, and SCC algorithms.

```java
/**
 * DFS with discovery and finish times (timestamps).
 * Classifies edges into tree, back, forward, and cross edges.
 *
 * During DFS, each node has a state:
 *   WHITE (undiscovered): disc[u] == 0 && fin[u] == 0
 *   GRAY  (discovered, not finished): disc[u] > 0 && fin[u] == 0
 *   BLACK (finished): fin[u] > 0
 *
 * Edge (u, v) classification:
 *   Tree edge:    v is WHITE — we discover v from u
 *   Back edge:    v is GRAY  — v is an ancestor of u in DFS tree → CYCLE!
 *   Forward edge: v is BLACK and disc[u] < disc[v] — v is a descendant (dir. graphs only)
 *   Cross edge:   v is BLACK and disc[u] > disc[v] — no ancestor relation (dir. graphs only)
 *
 * In undirected graphs: only tree edges and back edges exist.
 * Back edge in directed graph → cycle exists.
 */
public class DFSTimestamps {
    private int timer = 0;
    private int[] disc, fin;
    private int[] color;  // 0=WHITE, 1=GRAY, 2=BLACK
    private List<List<Integer>> adj;
    
    public void dfs(int V, List<List<Integer>> adj) {
        this.adj = adj;
        disc = new int[V];
        fin = new int[V];
        color = new int[V];
        
        for (int u = 0; u < V; u++) {
            if (color[u] == 0) {
                dfsVisit(u);
            }
        }
    }
    
    private void dfsVisit(int u) {
        color[u] = 1;  // GRAY
        disc[u] = ++timer;
        
        for (int v : adj.get(u)) {
            if (color[v] == 0) {
                // Tree edge: u → v
                dfsVisit(v);
            } else if (color[v] == 1) {
                // Back edge: v is ancestor (GRAY = still on recursion stack)
                // THIS MEANS A CYCLE EXISTS in directed graphs
            } else {
                // color[v] == 2 (BLACK)
                if (disc[u] < disc[v]) {
                    // Forward edge: v is descendant already finished
                } else {
                    // Cross edge: v is in different subtree already finished
                }
            }
        }
        
        color[u] = 2;  // BLACK
        fin[u] = ++timer;
    }
}
```

```
Edge classification visual:

    0 ──→ 1 ──→ 3
    │     ↑     │
    ↓     │     ↓
    2 ────┘     4
    │           ↑
    └───────────┘

DFS from 0:
  0 → 1 (tree)  disc[0]=1
  1 → 3 (tree)  disc[1]=2
  3 → 4 (tree)  disc[3]=3
  4 done         disc[4]=4, fin[4]=5
  3 done         fin[3]=6
  1 done         fin[1]=7
  0 → 2 (tree)  disc[2]=8
  2 → 1 (cross: 1 is BLACK, disc[2]=8 > disc[1]=2)
  2 → 4 (cross: 4 is BLACK, disc[2]=8 > disc[4]=4)
  2 done         fin[2]=9
  0 done         fin[0]=10
```

### 10.3.4 Cycle Detection

**Directed graph cycle detection:**

```java
/**
 * Detect cycle in a directed graph using DFS coloring.
 * A cycle exists iff we find a back edge (encounter a GRAY node).
 * 
 * Time: O(V + E)
 */
public boolean hasCycleDirected(int V, List<List<Integer>> adj) {
    int[] color = new int[V];  // 0=WHITE, 1=GRAY, 2=BLACK
    
    for (int u = 0; u < V; u++) {
        if (color[u] == 0 && dfsHasCycle(u, adj, color)) {
            return true;
        }
    }
    return false;
}

private boolean dfsHasCycle(int u, List<List<Integer>> adj, int[] color) {
    color[u] = 1;  // GRAY: on current recursion path
    
    for (int v : adj.get(u)) {
        if (color[v] == 1) return true;   // back edge → cycle
        if (color[v] == 0 && dfsHasCycle(v, adj, color)) return true;
    }
    
    color[u] = 2;  // BLACK: done
    return false;
}
```

**Undirected graph cycle detection:**

```java
/**
 * Detect cycle in an undirected graph.
 * In undirected graphs, every edge is traversed in both directions.
 * A cycle exists iff we visit an already-visited node that is NOT our parent.
 * 
 * Time: O(V + E)
 */
public boolean hasCycleUndirected(int V, List<List<Integer>> adj) {
    boolean[] visited = new boolean[V];
    
    for (int u = 0; u < V; u++) {
        if (!visited[u] && dfsCycleUndirected(u, -1, adj, visited)) {
            return true;
        }
    }
    return false;
}

private boolean dfsCycleUndirected(int u, int parent, 
                                     List<List<Integer>> adj, boolean[] visited) {
    visited[u] = true;
    
    for (int v : adj.get(u)) {
        if (!visited[v]) {
            if (dfsCycleUndirected(v, u, adj, visited)) return true;
        } else if (v != parent) {
            // Visited node that is NOT our parent → cycle
            return true;
        }
    }
    return false;
}
```

**Why `v != parent` matters:** In an undirected graph, if we came from node `parent` to node `u`, and `u` has an edge back to `parent`, that is just the same undirected edge traversed in reverse -- not a cycle. We must exclude the parent check.

### 10.3.5 Articulation Points (Cut Vertices) -- Tarjan's Algorithm

A vertex is an articulation point if removing it disconnects the graph. These are single points of failure.

```java
/**
 * Find all articulation points in an undirected graph.
 * Uses Tarjan's algorithm with low-link values.
 *
 * Key concepts:
 *   disc[u] = discovery time of node u
 *   low[u]  = earliest discovery time reachable from subtree rooted at u
 *             (via tree edges + at most one back edge)
 *
 * Node u is an articulation point if:
 *   1. u is the root of DFS tree AND has 2+ children, OR
 *   2. u is not root AND has a child v where low[v] >= disc[u]
 *      (meaning v's subtree cannot reach above u — removing u disconnects v)
 *
 * Time:  O(V + E)
 * Space: O(V)
 */
public List<Integer> findArticulationPoints(int V, List<List<Integer>> adj) {
    int[] disc = new int[V];
    int[] low = new int[V];
    boolean[] visited = new boolean[V];
    boolean[] isAP = new boolean[V];  // use boolean array to avoid duplicates
    int[] timer = {0};  // mutable counter (array trick for lambda/recursion)
    
    for (int i = 0; i < V; i++) {
        if (!visited[i]) {
            dfsAP(i, -1, adj, disc, low, visited, isAP, timer);
        }
    }
    
    List<Integer> result = new ArrayList<>();
    for (int i = 0; i < V; i++) {
        if (isAP[i]) result.add(i);
    }
    return result;
}

private void dfsAP(int u, int parent, List<List<Integer>> adj,
                    int[] disc, int[] low, boolean[] visited,
                    boolean[] isAP, int[] timer) {
    visited[u] = true;
    disc[u] = low[u] = ++timer[0];
    int childCount = 0;
    
    for (int v : adj.get(u)) {
        if (!visited[v]) {
            childCount++;
            dfsAP(v, u, adj, disc, low, visited, isAP, timer);
            
            // After DFS returns from v, update u's low value
            low[u] = Math.min(low[u], low[v]);
            
            // Articulation point conditions:
            if (parent == -1 && childCount > 1) {
                // Root with 2+ DFS children
                isAP[u] = true;
            }
            if (parent != -1 && low[v] >= disc[u]) {
                // Non-root where child's subtree can't reach above u
                isAP[u] = true;
            }
        } else if (v != parent) {
            // Back edge: update low value
            low[u] = Math.min(low[u], disc[v]);
        }
    }
}
```

### 10.3.6 Bridges (Cut Edges)

An edge is a bridge if removing it disconnects the graph. Similar to articulation points but with a stricter condition.

```java
/**
 * Find all bridges in an undirected graph.
 * Edge (u, v) is a bridge iff low[v] > disc[u].
 * (Strictly greater, not >=. If low[v] == disc[u], there is a back edge
 *  from v's subtree to u itself, so removing (u,v) doesn't disconnect.)
 *
 * Time: O(V + E)
 */
public List<int[]> findBridges(int V, List<List<Integer>> adj) {
    int[] disc = new int[V];
    int[] low = new int[V];
    boolean[] visited = new boolean[V];
    List<int[]> bridges = new ArrayList<>();
    int[] timer = {0};
    
    for (int i = 0; i < V; i++) {
        if (!visited[i]) {
            dfsBridge(i, -1, adj, disc, low, visited, bridges, timer);
        }
    }
    return bridges;
}

private void dfsBridge(int u, int parent, List<List<Integer>> adj,
                        int[] disc, int[] low, boolean[] visited,
                        List<int[]> bridges, int[] timer) {
    visited[u] = true;
    disc[u] = low[u] = ++timer[0];
    
    for (int v : adj.get(u)) {
        if (!visited[v]) {
            dfsBridge(v, u, adj, disc, low, visited, bridges, timer);
            low[u] = Math.min(low[u], low[v]);
            
            if (low[v] > disc[u]) {  // strictly greater → bridge
                bridges.add(new int[]{u, v});
            }
        } else if (v != parent) {
            low[u] = Math.min(low[u], disc[v]);
        }
    }
}
```

**Articulation point vs Bridge condition:**
- Articulation point: `low[v] >= disc[u]` (v cannot reach above u OR to u via another path)
- Bridge: `low[v] > disc[u]` (v cannot reach u at all except through this edge)

**Real-world correlation:** Network engineers identify bridges to find single-link failures. The Spanning Tree Protocol (STP) in Ethernet networks detects and breaks cycles, effectively finding bridges to create a spanning tree. In microservices, a bridge is a single service whose failure splits your system into disconnected components.

### 10.3.7 Connected Components

```java
/**
 * Find all connected components in an undirected graph.
 * Time:  O(V + E)
 * Space: O(V)
 */
public int countComponents(int V, List<List<Integer>> adj) {
    boolean[] visited = new boolean[V];
    int count = 0;
    
    for (int u = 0; u < V; u++) {
        if (!visited[u]) {
            dfs(adj, u, visited);
            count++;
        }
    }
    return count;
}

// Flood fill: label each cell with its component ID
public int[][] floodFill(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    int[][] componentId = new int[m][n];
    int id = 0;
    
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == 1 && componentId[i][j] == 0) {
                id++;
                dfsFill(grid, componentId, i, j, m, n, id);
            }
        }
    }
    return componentId;
}

private void dfsFill(int[][] grid, int[][] comp, int r, int c, int m, int n, int id) {
    if (r < 0 || r >= m || c < 0 || c >= n || grid[r][c] != 1 || comp[r][c] != 0) return;
    comp[r][c] = id;
    dfsFill(grid, comp, r+1, c, m, n, id);
    dfsFill(grid, comp, r-1, c, m, n, id);
    dfsFill(grid, comp, r, c+1, m, n, id);
    dfsFill(grid, comp, r, c-1, m, n, id);
}
```

---

## 10.4 Topological Sort

Topological sort is a linear ordering of vertices in a Directed Acyclic Graph (DAG) such that for every directed edge u -> v, u appears before v in the ordering. It only exists for DAGs -- if there is a cycle, no valid ordering exists.

### 10.4.1 Kahn's Algorithm (BFS-Based)

```java
/**
 * Kahn's Algorithm: BFS-based topological sort using in-degree.
 *
 * Algorithm:
 *   1. Compute in-degree for every node
 *   2. Enqueue all nodes with in-degree 0 (no prerequisites)
 *   3. Process each node: add to result, decrement in-degree of neighbors
 *   4. When a neighbor's in-degree reaches 0, enqueue it
 *   5. If result.size() < V → cycle exists (not all nodes processable)
 *
 * Time:  O(V + E)
 * Space: O(V + E) for adj list + O(V) for in-degree and queue
 */
public int[] kahnTopologicalSort(int V, List<List<Integer>> adj) {
    int[] inDegree = new int[V];
    for (int u = 0; u < V; u++) {
        for (int v : adj.get(u)) {
            inDegree[v]++;
        }
    }
    
    Deque<Integer> queue = new ArrayDeque<>();
    for (int u = 0; u < V; u++) {
        if (inDegree[u] == 0) {
            queue.offer(u);
        }
    }
    
    int[] topoOrder = new int[V];
    int idx = 0;
    
    while (!queue.isEmpty()) {
        int u = queue.poll();
        topoOrder[idx++] = u;
        
        for (int v : adj.get(u)) {
            inDegree[v]--;
            if (inDegree[v] == 0) {
                queue.offer(v);
            }
        }
    }
    
    if (idx != V) {
        // Not all nodes processed → cycle exists
        return new int[0];  // or throw exception
    }
    return topoOrder;
}
```

### 10.4.2 DFS-Based Topological Sort

```java
/**
 * DFS-based topological sort: post-order reversal.
 *
 * Insight: in a DAG, when DFS finishes a node u (all descendants processed),
 * u should come AFTER all its descendants. So the reverse of DFS post-order
 * is a valid topological order.
 *
 * Time:  O(V + E)
 * Space: O(V)
 */
public int[] dfsTopologicalSort(int V, List<List<Integer>> adj) {
    boolean[] visited = new boolean[V];
    int[] color = new int[V];  // for cycle detection: 0=WHITE, 1=GRAY, 2=BLACK
    Deque<Integer> stack = new ArrayDeque<>();  // post-order stack
    
    for (int u = 0; u < V; u++) {
        if (color[u] == 0) {
            if (dfsTopoVisit(u, adj, color, stack)) {
                return new int[0];  // cycle detected
            }
        }
    }
    
    int[] result = new int[V];
    for (int i = 0; i < V; i++) {
        result[i] = stack.pop();  // reverse post-order
    }
    return result;
}

private boolean dfsTopoVisit(int u, List<List<Integer>> adj, 
                              int[] color, Deque<Integer> stack) {
    color[u] = 1;  // GRAY
    
    for (int v : adj.get(u)) {
        if (color[v] == 1) return true;  // back edge → cycle
        if (color[v] == 0 && dfsTopoVisit(v, adj, color, stack)) return true;
    }
    
    color[u] = 2;  // BLACK
    stack.push(u);  // add to post-order when finished
    return false;
}
```

### 10.4.3 Kahn's vs DFS-Based: When to Use Which

```
Feature                 Kahn's (BFS)              DFS-Based
──────────────────────────────────────────────────────────────
Cycle detection         If count < V              Back edge detection
Parallelism hint        Yes (all in-degree-0      No
                        nodes can run in parallel)
Multiple valid orders   Can prioritize with PQ    Natural recursion order
Implementation          Iterative (no stack       Recursive (stack
                        overflow)                 overflow risk)
Longest path in DAG     Easy (track max dist      Reverse post-order
                        during processing)        + DP after
```

**Kahn's is generally preferred in production** because:
1. It naturally detects cycles (just check if all nodes were processed).
2. It reveals parallelism: all nodes in the queue at the same time have no dependencies on each other and can execute in parallel.
3. It is iterative -- no stack overflow risk.

### 10.4.4 Real-World Applications

**Build systems (Make, Gradle, Maven):**
- Tasks are nodes. Dependencies are edges. Topological sort determines build order.
- Multiple tasks at the same "level" (in-degree 0 simultaneously) can be built in parallel.
- Gradle uses Kahn's algorithm variant for its parallel task execution.

**Course prerequisites:**
- Course A requires Course B means edge B -> A. Topological sort gives a valid semester sequence.

**npm/yarn dependency resolution:**
- Package dependency graph. Topological sort determines installation order.
- If there is a cycle, `npm` reports a circular dependency error.

**Compiler instruction scheduling:**
- Instructions with data dependencies form a DAG. Topological sort finds a valid execution order that respects dependencies while maximizing instruction-level parallelism.

**Spreadsheet cell evaluation:**
- Cell A1 references B2 and C3 means edges B2 -> A1 and C3 -> A1. Cells must be evaluated in topological order. A cycle means a circular reference error.

---

## 10.5 Shortest Path Algorithms

### 10.5.1 Dijkstra's Algorithm

Dijkstra finds the shortest path from a single source to all other nodes in a graph with non-negative edge weights. It is the greedy workhorse of pathfinding.

```java
/**
 * Dijkstra's Algorithm with lazy deletion.
 *
 * Why lazy deletion? Java's PriorityQueue has no decrease-key operation.
 * When we find a shorter path to node v, we cannot update v's entry in the PQ.
 * Instead, we add a NEW entry with the shorter distance. The old entry remains
 * but will be ignored when popped (because dist[v] is already optimal by then).
 *
 * This is called "lazy deletion" and is the standard Java pattern.
 * It means the PQ can hold up to E entries (one per edge relaxation),
 * so the complexity is O((V+E) log E) = O((V+E) log V) since E ≤ V².
 *
 * Time:  O((V + E) log V) with binary heap PQ
 * Space: O(V + E)
 */
public int[] dijkstra(int V, List<List<int[]>> adj, int source) {
    int[] dist = new int[V];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[source] = 0;
    
    // PriorityQueue stores {distance, node}
    // MUST put distance first for comparator: compare by distance
    PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[0] - b[0]);
    pq.offer(new int[]{0, source});
    
    while (!pq.isEmpty()) {
        int[] curr = pq.poll();
        int d = curr[0], u = curr[1];
        
        // Lazy deletion: skip if we already found a better path
        if (d > dist[u]) continue;
        
        // Edge relaxation
        for (int[] edge : adj.get(u)) {
            int v = edge[0], weight = edge[1];
            if (dist[u] + weight < dist[v]) {
                dist[v] = dist[u] + weight;
                pq.offer(new int[]{dist[v], v});
            }
        }
    }
    return dist;
}
```

**Why lazy deletion is cheaper than decrease-key:**

```
Theoretical decrease-key PQ (Fibonacci heap):
  - decrease-key: O(1) amortized
  - extract-min: O(log V) amortized
  - Total: O(V log V + E) — optimal
  - But: Fibonacci heaps have huge constant factors, terrible cache behavior,
    and are nearly impossible to implement correctly in production.

Java PriorityQueue (binary heap) with lazy deletion:
  - offer: O(log N) where N = current PQ size (up to E)
  - poll: O(log N)
  - Lazy skip: O(1)
  - Total: O((V+E) log E) ≈ O((V+E) log V)
  - Practical: simple, cache-friendly (binary heap is an array), JDK built-in.

For all practical graph sizes (V < 10^6), the Java approach wins despite
worse theoretical complexity. The constant factors dominate at real scales.
```

**JVM memory analysis of Dijkstra's PQ:**

```
For V = 100,000 nodes, E = 500,000 edges:

PriorityQueue internal array:
  - Initial capacity: 11 (default)
  - Grows dynamically. Worst case: E entries = 500,000
  - Object[]: 16 + 500,000 × 4 = ~2 MB (references)

int[] entries (each {distance, node}):
  - Up to 500,000 entries
  - Each int[2]: 24 bytes (16 header + 8 data)
  - 500,000 × 24 = ~12 MB

Total PQ memory: ~14 MB
Object count: ~500,001 (PQ + entries)

Optimization: use a single long to encode distance and node:
  long entry = ((long) dist << 32) | node;
  // This eliminates all int[] objects. PQ stores Long (16 bytes each)
  // or use a PQ<Long> which autoboxes — still better than int[2] arrays.
```

**Path reconstruction:**

```java
/**
 * Dijkstra with path reconstruction.
 * Track parent of each node to reconstruct shortest path.
 */
public List<Integer> dijkstraPath(int V, List<List<int[]>> adj, int source, int target) {
    int[] dist = new int[V];
    int[] parent = new int[V];
    Arrays.fill(dist, Integer.MAX_VALUE);
    Arrays.fill(parent, -1);
    dist[source] = 0;
    
    PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[0] - b[0]);
    pq.offer(new int[]{0, source});
    
    while (!pq.isEmpty()) {
        int[] curr = pq.poll();
        int d = curr[0], u = curr[1];
        if (d > dist[u]) continue;
        if (u == target) break;  // early termination for single-target
        
        for (int[] edge : adj.get(u)) {
            int v = edge[0], w = edge[1];
            if (dist[u] + w < dist[v]) {
                dist[v] = dist[u] + w;
                parent[v] = u;
                pq.offer(new int[]{dist[v], v});
            }
        }
    }
    
    // Reconstruct path by following parent pointers backward
    if (dist[target] == Integer.MAX_VALUE) return Collections.emptyList();
    
    List<Integer> path = new ArrayList<>();
    for (int node = target; node != -1; node = parent[node]) {
        path.add(node);
    }
    Collections.reverse(path);
    return path;
}
```

**Real-world correlation:**
- **OSPF routing protocol:** Each router runs Dijkstra on the network topology. Link costs are edge weights. The shortest path tree determines the next hop for each destination. When a link goes down, routers re-run Dijkstra (incremental SPF optimization keeps this fast).
- **Google Maps navigation:** Road network is a graph. Dijkstra (with optimizations like A*, contraction hierarchies, and ALT) finds shortest/fastest routes.
- **Network latency optimization:** CDN request routing uses Dijkstra-like algorithms to find the lowest-latency path from user to content server.

### 10.5.2 Bellman-Ford Algorithm

Bellman-Ford handles negative edge weights and detects negative cycles. It is slower than Dijkstra (O(VE) vs O((V+E) log V)) but more general.

```java
/**
 * Bellman-Ford Algorithm.
 *
 * Algorithm:
 *   1. Initialize dist[source] = 0, all others = INF
 *   2. Relax ALL edges V-1 times
 *      (longest simple path has V-1 edges, so V-1 relaxations suffice)
 *   3. On the Vth pass, if any edge still relaxes → negative cycle exists
 *
 * Time:  O(V × E)
 * Space: O(V)
 * 
 * Handles negative weights. Dijkstra CANNOT handle negative weights because
 * its greedy assumption (once a node is finalized, its distance is optimal)
 * breaks when negative edges can reduce already-finalized distances.
 */
public int[] bellmanFord(int V, int[][] edges, int source) {
    int[] dist = new int[V];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[source] = 0;
    
    // Relax all edges V-1 times
    for (int i = 0; i < V - 1; i++) {
        boolean relaxed = false;
        for (int[] edge : edges) {
            int u = edge[0], v = edge[1], w = edge[2];
            if (dist[u] != Integer.MAX_VALUE && dist[u] + w < dist[v]) {
                dist[v] = dist[u] + w;
                relaxed = true;
            }
        }
        if (!relaxed) break;  // early termination — no changes this pass
    }
    
    // Vth pass: check for negative cycles
    for (int[] edge : edges) {
        int u = edge[0], v = edge[1], w = edge[2];
        if (dist[u] != Integer.MAX_VALUE && dist[u] + w < dist[v]) {
            throw new IllegalStateException("Negative cycle detected");
        }
    }
    
    return dist;
}
```

**SPFA (Shortest Path Faster Algorithm):**

SPFA is an optimization of Bellman-Ford that only relaxes edges from nodes whose distance recently changed, using a queue:

```java
/**
 * SPFA: BFS-style Bellman-Ford.
 * Instead of blindly relaxing all edges, only relax edges from nodes
 * whose distance changed. Use a queue (like BFS) to track these nodes.
 *
 * Average case: O(V + E) — much faster than Bellman-Ford
 * Worst case: still O(VE) — can degrade on adversarial graphs
 * Negative cycle detection: if any node is enqueued > V times, cycle exists
 */
public int[] spfa(int V, List<List<int[]>> adj, int source) {
    int[] dist = new int[V];
    boolean[] inQueue = new boolean[V];
    int[] enqueueCount = new int[V];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[source] = 0;
    
    Deque<Integer> queue = new ArrayDeque<>();
    queue.offer(source);
    inQueue[source] = true;
    enqueueCount[source] = 1;
    
    while (!queue.isEmpty()) {
        int u = queue.poll();
        inQueue[u] = false;
        
        for (int[] edge : adj.get(u)) {
            int v = edge[0], w = edge[1];
            if (dist[u] + w < dist[v]) {
                dist[v] = dist[u] + w;
                if (!inQueue[v]) {
                    queue.offer(v);
                    inQueue[v] = true;
                    enqueueCount[v]++;
                    if (enqueueCount[v] > V) {
                        throw new IllegalStateException("Negative cycle detected");
                    }
                }
            }
        }
    }
    return dist;
}
```

**Real-world correlation:**
- **BGP routing protocol:** BGP is a distance-vector protocol that uses a Bellman-Ford variant. Routers advertise distances to networks, and neighbors update their tables. Negative weights represent policy-based preferences (e.g., "prefer this path even though it is longer"). The protocol's convergence issues ("count to infinity") are directly related to Bellman-Ford's iterative nature.
- **Cheapest flights within K stops:** The classic interview problem maps directly to Bellman-Ford with K iterations instead of V-1.

### 10.5.3 Floyd-Warshall Algorithm

All-pairs shortest path. Finds the shortest path between EVERY pair of nodes.

```java
/**
 * Floyd-Warshall Algorithm.
 *
 * DP formulation:
 *   dp[i][j] = shortest path from i to j using only nodes {0, 1, ..., k} as intermediates
 *   dp[i][j] = min(dp[i][j], dp[i][k] + dp[k][j])  for each intermediate node k
 *
 * Iterate k from 0 to V-1 (outer loop), i and j inner loops.
 * The key insight: we consider one new intermediate node at each outer iteration.
 *
 * Time:  O(V³)
 * Space: O(V²) — can be done in-place on the distance matrix
 *
 * Negative cycle detection: if dp[i][i] < 0 for any i, there is a negative cycle
 * through node i.
 */
public int[][] floydWarshall(int V, int[][] edges) {
    final int INF = Integer.MAX_VALUE / 2;  // Use half to avoid overflow in addition
    
    // Initialize distance matrix
    int[][] dp = new int[V][V];
    for (int[] row : dp) Arrays.fill(row, INF);
    for (int i = 0; i < V; i++) dp[i][i] = 0;
    
    for (int[] edge : edges) {
        int u = edge[0], v = edge[1], w = edge[2];
        dp[u][v] = w;
    }
    
    // Floyd-Warshall: k MUST be the outermost loop
    for (int k = 0; k < V; k++) {
        for (int i = 0; i < V; i++) {
            for (int j = 0; j < V; j++) {
                if (dp[i][k] + dp[k][j] < dp[i][j]) {
                    dp[i][j] = dp[i][k] + dp[k][j];
                }
            }
        }
    }
    
    // Check for negative cycles
    for (int i = 0; i < V; i++) {
        if (dp[i][i] < 0) {
            throw new IllegalStateException("Negative cycle through node " + i);
        }
    }
    
    return dp;
}
```

**Why k must be outermost:** The DP relies on considering intermediate nodes in order. After the k-th iteration, dp[i][j] holds the shortest path using only nodes 0..k as intermediates. If you put i or j outermost, you break this invariant.

**JVM optimization:** For V = 1000, the dp matrix is `int[1000][1000]`. As discussed in Section 10.1.1, this is a jagged array. For Floyd-Warshall's triple nested loop (V^3 = 10^9 iterations), consider flattening:

```java
int[] dp = new int[V * V];
// Access dp[i][j] as dp[i * V + j]
// This eliminates V pointer chases per middle-loop iteration
```

### 10.5.4 Algorithm Comparison Table

```
Algorithm       Time            Space   Negative   Negative   All-Pairs
                                        Weights    Cycles
─────────────────────────────────────────────────────────────────────────
Dijkstra        O((V+E)logV)   O(V+E)  No         No         No
Bellman-Ford    O(VE)          O(V)    Yes        Detect     No
SPFA            O(V+E) avg     O(V)    Yes        Detect     No
                O(VE) worst
Floyd-Warshall  O(V³)          O(V²)   Yes        Detect     Yes
BFS             O(V+E)         O(V)    N/A        N/A        No
0-1 BFS         O(V+E)         O(V)    No         No         No

When to use:
  Unweighted graph          → BFS
  Binary weights (0/1)      → 0-1 BFS
  Non-negative weights      → Dijkstra
  Negative weights possible → Bellman-Ford or SPFA
  All-pairs needed          → Floyd-Warshall (or V runs of Dijkstra if non-negative)
  K-limited hops            → Bellman-Ford with K iterations
```

---

## 10.6 Minimum Spanning Tree (MST)

A minimum spanning tree connects all vertices with the minimum total edge weight, using exactly V-1 edges and no cycles.

### 10.6.1 Kruskal's Algorithm

```java
/**
 * Kruskal's Algorithm: sort edges by weight, add if no cycle (Union-Find).
 *
 * Algorithm:
 *   1. Sort all edges by weight: O(E log E)
 *   2. For each edge (u, v, w) in sorted order:
 *      - If u and v are in different components (Union-Find check): add edge to MST
 *      - Else: skip (would create cycle)
 *   3. Stop when MST has V-1 edges
 *
 * Time:  O(E log E) for sort + O(E α(V)) for union-find ≈ O(E log E)
 * Space: O(V) for Union-Find + O(E) for edge list
 */
public int kruskalMST(int V, int[][] edges) {
    // Sort edges by weight
    Arrays.sort(edges, (a, b) -> a[2] - b[2]);
    
    // Union-Find (Disjoint Set Union with path compression + union by rank)
    int[] parent = new int[V];
    int[] rank = new int[V];
    for (int i = 0; i < V; i++) parent[i] = i;
    
    int mstWeight = 0;
    int edgesUsed = 0;
    
    for (int[] edge : edges) {
        if (edgesUsed == V - 1) break;  // MST complete
        
        int u = edge[0], v = edge[1], w = edge[2];
        int rootU = find(parent, u);
        int rootV = find(parent, v);
        
        if (rootU != rootV) {
            union(parent, rank, rootU, rootV);
            mstWeight += w;
            edgesUsed++;
        }
    }
    
    return edgesUsed == V - 1 ? mstWeight : -1;  // -1 if graph disconnected
}

private int find(int[] parent, int x) {
    if (parent[x] != x) {
        parent[x] = find(parent, parent[x]);  // path compression
    }
    return parent[x];
}

private void union(int[] parent, int[] rank, int x, int y) {
    if (rank[x] < rank[y]) {
        parent[x] = y;
    } else if (rank[x] > rank[y]) {
        parent[y] = x;
    } else {
        parent[y] = x;
        rank[x]++;
    }
}
```

### 10.6.2 Prim's Algorithm

```java
/**
 * Prim's Algorithm: grow MST from a source, always adding cheapest crossing edge.
 *
 * Like Dijkstra but:
 *   - Dijkstra: PQ stores distance from SOURCE to each node
 *   - Prim's:   PQ stores weight of cheapest edge from MST to each node
 *
 * Time:  O((V + E) log V) with PriorityQueue
 * Space: O(V + E)
 */
public int primMST(int V, List<List<int[]>> adj) {
    boolean[] inMST = new boolean[V];
    // PQ stores {weight, node}
    PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[0] - b[0]);
    pq.offer(new int[]{0, 0});  // start from node 0 with weight 0
    
    int mstWeight = 0;
    int edgesUsed = 0;
    
    while (!pq.isEmpty() && edgesUsed < V) {
        int[] curr = pq.poll();
        int w = curr[0], u = curr[1];
        
        if (inMST[u]) continue;  // lazy deletion
        
        inMST[u] = true;
        mstWeight += w;
        edgesUsed++;
        
        for (int[] edge : adj.get(u)) {
            int v = edge[0], weight = edge[1];
            if (!inMST[v]) {
                pq.offer(new int[]{weight, v});
            }
        }
    }
    
    return edgesUsed == V ? mstWeight : -1;
}
```

### 10.6.3 Kruskal's vs Prim's

```
Feature             Kruskal's                     Prim's
───────────────────────────────────────────────────────────────
Approach            Global (sort all edges)       Local (grow from a vertex)
Data structure      Edge list + Union-Find        Adjacency list + PQ
Time                O(E log E)                    O((V+E) log V)
Best for            Sparse graphs (E ≈ V)         Dense graphs (E ≈ V²)
                    Edge list input               Adjacency list input
Graph requirement   Works with disconnected       Needs connected (or
                    (finds forest)                repeat for each component)
Implementation      Simple with edge array        Similar to Dijkstra
```

**Kruskal's edge:** When the graph is given as an edge list (common in problems), Kruskal's avoids building an adjacency list. The edge list sort + union-find is clean and fast.

**Prim's edge:** For dense graphs stored as adjacency matrix, Prim's with an O(V^2) matrix scan (instead of PQ) runs in O(V^2 + E) = O(V^2), which beats Kruskal's O(E log E) = O(V^2 log V) for dense graphs.

**Real-world correlations:**
- **Network cable layout:** Connecting N offices with minimum total cable length is literally MST. Each office is a node, possible cable routes are weighted edges.
- **Clustering:** Build MST, then remove the K-1 most expensive edges to get K clusters. The most expensive edges connect distant clusters.
- **Circuit design:** Minimizing wire length in chip design is an MST variant (Steiner tree for a subset of nodes).

---

## 10.7 Strongly Connected Components (Directed Graphs)

A strongly connected component (SCC) is a maximal set of vertices such that every vertex is reachable from every other vertex in the set. SCCs only apply to directed graphs. In an undirected graph, connected components serve the same purpose.

### 10.7.1 Tarjan's Algorithm

```java
/**
 * Tarjan's SCC Algorithm: single DFS with low-link values and a stack.
 *
 * Key ideas:
 *   disc[u]: discovery time of node u
 *   low[u]:  smallest discovery time reachable from u's subtree
 *   onStack[u]: whether u is currently on the DFS stack
 *
 * A node u is an SCC root when low[u] == disc[u].
 * When we find an SCC root, pop the stack to get all nodes in that SCC.
 *
 * Time:  O(V + E) — single DFS pass
 * Space: O(V) for stack, disc, low arrays
 */
public List<List<Integer>> tarjanSCC(int V, List<List<Integer>> adj) {
    int[] disc = new int[V];
    int[] low = new int[V];
    boolean[] onStack = new boolean[V];
    Arrays.fill(disc, -1);
    
    Deque<Integer> stack = new ArrayDeque<>();
    List<List<Integer>> sccs = new ArrayList<>();
    int[] timer = {0};
    
    for (int u = 0; u < V; u++) {
        if (disc[u] == -1) {
            tarjanDFS(u, adj, disc, low, onStack, stack, sccs, timer);
        }
    }
    return sccs;
}

private void tarjanDFS(int u, List<List<Integer>> adj,
                        int[] disc, int[] low, boolean[] onStack,
                        Deque<Integer> stack, List<List<Integer>> sccs, int[] timer) {
    disc[u] = low[u] = timer[0]++;
    stack.push(u);
    onStack[u] = true;
    
    for (int v : adj.get(u)) {
        if (disc[v] == -1) {
            // Tree edge: v not yet visited
            tarjanDFS(v, adj, disc, low, onStack, stack, sccs, timer);
            low[u] = Math.min(low[u], low[v]);
        } else if (onStack[v]) {
            // Back edge to node on current stack → same SCC
            low[u] = Math.min(low[u], disc[v]);
        }
        // Cross edge to node NOT on stack → different (already completed) SCC, ignore
    }
    
    // If u is an SCC root (low[u] == disc[u]), pop entire SCC
    if (low[u] == disc[u]) {
        List<Integer> scc = new ArrayList<>();
        while (true) {
            int node = stack.pop();
            onStack[node] = false;
            scc.add(node);
            if (node == u) break;
        }
        sccs.add(scc);
    }
}
```

### 10.7.2 Kosaraju's Algorithm

```java
/**
 * Kosaraju's SCC Algorithm: two DFS passes.
 *
 * Algorithm:
 *   1. First DFS on original graph: record finish order (push to stack when done)
 *   2. Reverse all edges (transpose the graph)
 *   3. Second DFS on reversed graph in reverse finish order:
 *      each DFS tree in this pass is one SCC
 *
 * Why it works:
 *   In the first pass, nodes that finish later are "closer to sources" in the
 *   SCC DAG. Processing them first on the reversed graph confines each DFS
 *   to exactly one SCC (because the reversed edges cannot escape the SCC
 *   when processed in this order).
 *
 * Time:  O(V + E) — two DFS passes + graph reversal
 * Space: O(V + E) for reversed graph
 */
public List<List<Integer>> kosarajuSCC(int V, List<List<Integer>> adj) {
    // Pass 1: DFS on original graph, record finish order
    boolean[] visited = new boolean[V];
    Deque<Integer> finishOrder = new ArrayDeque<>();
    for (int u = 0; u < V; u++) {
        if (!visited[u]) {
            dfsFinish(u, adj, visited, finishOrder);
        }
    }
    
    // Build reversed graph
    List<List<Integer>> rev = new ArrayList<>();
    for (int i = 0; i < V; i++) rev.add(new ArrayList<>());
    for (int u = 0; u < V; u++) {
        for (int v : adj.get(u)) {
            rev.get(v).add(u);  // reverse edge
        }
    }
    
    // Pass 2: DFS on reversed graph in reverse finish order
    Arrays.fill(visited, false);
    List<List<Integer>> sccs = new ArrayList<>();
    
    while (!finishOrder.isEmpty()) {
        int u = finishOrder.pop();
        if (!visited[u]) {
            List<Integer> scc = new ArrayList<>();
            dfsCollect(u, rev, visited, scc);
            sccs.add(scc);
        }
    }
    return sccs;
}

private void dfsFinish(int u, List<List<Integer>> adj, boolean[] visited, Deque<Integer> stack) {
    visited[u] = true;
    for (int v : adj.get(u)) {
        if (!visited[v]) dfsFinish(v, adj, visited, stack);
    }
    stack.push(u);  // push when finished
}

private void dfsCollect(int u, List<List<Integer>> adj, boolean[] visited, List<Integer> scc) {
    visited[u] = true;
    scc.add(u);
    for (int v : adj.get(u)) {
        if (!visited[v]) dfsCollect(v, adj, visited, scc);
    }
}
```

### 10.7.3 Tarjan's vs Kosaraju's

```
Feature             Tarjan's                     Kosaraju's
───────────────────────────────────────────────────────────────
DFS passes          1                            2 (+ graph reversal)
Extra space         O(V) for stack               O(V+E) for reversed graph
Implementation      Single complex DFS           Two simple DFS passes
Conceptual          Harder (low-link reasoning)  Easier (reverse, re-DFS)
Online capability   Can process nodes as they    Needs entire graph first
                    arrive (streaming)           (second pass needs reversed)
```

**Real-world correlations:**
- **Dependency analysis in microservices:** SCCs reveal circular dependencies. If services A -> B -> C -> A form a cycle, they must be deployed together. The condensation graph (replacing each SCC with a single node) shows the acyclic dependency structure.
- **Deadlock detection:** In a wait-for graph (threads are nodes, "waiting for lock held by" are edges), an SCC means deadlock -- a cycle of threads all waiting for each other.
- **Package manager cycle detection:** npm warns about circular dependencies, which are exactly SCCs of size > 1.
- **2-SAT:** The satisfiability of 2-SAT clauses can be determined by finding SCCs in the implication graph. If a variable and its negation are in the same SCC, the formula is unsatisfiable.

---

## 10.8 Union-Find (Disjoint Set Union)

Union-Find is not a graph traversal algorithm per se, but it is essential for graph problems involving connectivity and cycle detection. It answers "are these two nodes in the same component?" in nearly O(1) time.

```java
/**
 * Union-Find with path compression and union by rank.
 *
 * Operations:
 *   find(x):    return root of x's component. O(α(V)) amortized ≈ O(1)
 *   union(x,y): merge components of x and y. O(α(V)) amortized ≈ O(1)
 *
 * α(V) is the inverse Ackermann function — effectively ≤ 4 for any V < 10^(10^10).
 * For all practical purposes, this is O(1).
 *
 * Two critical optimizations:
 *   1. Path compression (in find): flatten tree by pointing directly to root
 *   2. Union by rank: attach shorter tree under taller tree
 *   Without both: O(V) per operation. With both: O(α(V)) amortized.
 */
public class UnionFind {
    private int[] parent;
    private int[] rank;
    private int components;
    
    public UnionFind(int V) {
        parent = new int[V];
        rank = new int[V];
        components = V;
        for (int i = 0; i < V; i++) parent[i] = i;
    }
    
    public int find(int x) {
        if (parent[x] != x) {
            parent[x] = find(parent[x]);  // path compression
        }
        return parent[x];
    }
    
    public boolean union(int x, int y) {
        int rx = find(x), ry = find(y);
        if (rx == ry) return false;  // already same component
        
        // Union by rank
        if (rank[rx] < rank[ry]) {
            parent[rx] = ry;
        } else if (rank[rx] > rank[ry]) {
            parent[ry] = rx;
        } else {
            parent[ry] = rx;
            rank[rx]++;
        }
        components--;
        return true;
    }
    
    public boolean connected(int x, int y) {
        return find(x) == find(y);
    }
    
    public int getComponents() {
        return components;
    }
}
```

**JVM memory:** Two `int[]` arrays of size V. Total: ~8V bytes + 2 headers. Compare with a `HashMap<Integer, Set<Integer>>` for the same purpose -- easily 50x more memory and objects.

**Key applications:**
- Kruskal's MST (cycle check)
- Number of connected components (count unions)
- Earliest moment when all nodes become connected
- Redundant connection detection (the edge that, when added, creates a cycle)
- Accounts merge (treating each email as a node)

---

## 10.9 Advanced Graph Concepts

### 10.9.1 Bipartite Checking

A graph is bipartite if its nodes can be 2-colored such that no adjacent nodes share a color. Equivalently, it contains no odd-length cycles.

```java
/**
 * Bipartite check using BFS 2-coloring.
 * Time: O(V + E)
 */
public boolean isBipartite(int V, List<List<Integer>> adj) {
    int[] color = new int[V];
    Arrays.fill(color, -1);  // uncolored
    
    for (int start = 0; start < V; start++) {
        if (color[start] != -1) continue;
        
        // BFS from this component
        Deque<Integer> queue = new ArrayDeque<>();
        queue.offer(start);
        color[start] = 0;
        
        while (!queue.isEmpty()) {
            int u = queue.poll();
            for (int v : adj.get(u)) {
                if (color[v] == -1) {
                    color[v] = 1 - color[u];  // opposite color
                    queue.offer(v);
                } else if (color[v] == color[u]) {
                    return false;  // same color as neighbor → not bipartite
                }
            }
        }
    }
    return true;
}
```

### 10.9.2 Euler Path and Circuit -- Hierholzer's Algorithm

An Euler path visits every EDGE exactly once. An Euler circuit is an Euler path that starts and ends at the same vertex.

```java
/**
 * Hierholzer's Algorithm for Euler path/circuit in a directed graph.
 *
 * Euler circuit exists iff: every vertex has in-degree == out-degree
 * Euler path exists iff:    exactly one vertex has out-degree - in-degree == 1 (start)
 *                            exactly one vertex has in-degree - out-degree == 1 (end)
 *                            all others have in-degree == out-degree
 *
 * Algorithm: start from valid start node, greedily follow edges (removing them),
 * when stuck, backtrack and insert the sub-circuit.
 *
 * Time:  O(V + E)
 * Space: O(V + E)
 */
public List<Integer> hierholzer(int V, List<List<Integer>> adj) {
    // Use edge indices to "remove" edges efficiently
    int[] edgeIdx = new int[V];  // next edge to use from each node
    
    Deque<Integer> stack = new ArrayDeque<>();
    List<Integer> result = new ArrayList<>();
    
    stack.push(0);  // or computed start node
    while (!stack.isEmpty()) {
        int u = stack.peek();
        if (edgeIdx[u] < adj.get(u).size()) {
            int v = adj.get(u).get(edgeIdx[u]++);
            stack.push(v);
        } else {
            result.add(stack.pop());
        }
    }
    
    Collections.reverse(result);
    return result;
}
```

### 10.9.3 Graph Coloring

```java
/**
 * Greedy graph coloring.
 * Assigns colors such that no two adjacent nodes share a color.
 * Greedy does not guarantee minimum colors (chromatic number is NP-hard),
 * but uses at most max_degree + 1 colors.
 *
 * Time: O(V + E)
 */
public int[] greedyColoring(int V, List<List<Integer>> adj) {
    int[] color = new int[V];
    Arrays.fill(color, -1);
    
    for (int u = 0; u < V; u++) {
        // Find colors used by neighbors
        Set<Integer> usedColors = new HashSet<>();
        for (int v : adj.get(u)) {
            if (color[v] != -1) {
                usedColors.add(color[v]);
            }
        }
        
        // Assign smallest unused color
        int c = 0;
        while (usedColors.contains(c)) c++;
        color[u] = c;
    }
    return color;
}
```

### 10.9.4 Network Flow (Brief)

Network flow answers: "What is the maximum amount of flow you can push from source to sink through a capacitated network?"

**Ford-Fulkerson method:** Repeatedly find augmenting paths from source to sink (via BFS = Edmonds-Karp variant, O(VE^2)). Each path increases flow. Stop when no augmenting path exists.

**Max-flow Min-cut Theorem:** The maximum flow equals the minimum cut (minimum total capacity of edges whose removal disconnects source from sink). This theorem connects optimization (max flow) with graph structure (min cut).

**Real-world:** Network bandwidth allocation, bipartite matching (assign workers to tasks), circulation with demands (supply chain).

```java
/**
 * Edmonds-Karp (BFS-based Ford-Fulkerson).
 * Time: O(V × E²)
 * 
 * Uses residual graph: for each edge (u,v) with capacity c and flow f,
 * residual capacity u→v is c-f, and v→u is f (back-edge for flow cancellation).
 */
public int maxFlow(int V, int[][] capacity, int source, int sink) {
    int[][] residual = new int[V][V];
    for (int i = 0; i < V; i++)
        System.arraycopy(capacity[i], 0, residual[i], 0, V);
    
    int maxFlow = 0;
    int[] parent = new int[V];
    
    while (bfsAugmentingPath(V, residual, source, sink, parent)) {
        // Find bottleneck along the path
        int pathFlow = Integer.MAX_VALUE;
        for (int v = sink; v != source; v = parent[v]) {
            int u = parent[v];
            pathFlow = Math.min(pathFlow, residual[u][v]);
        }
        
        // Update residual capacities
        for (int v = sink; v != source; v = parent[v]) {
            int u = parent[v];
            residual[u][v] -= pathFlow;
            residual[v][u] += pathFlow;  // back edge
        }
        
        maxFlow += pathFlow;
    }
    return maxFlow;
}

private boolean bfsAugmentingPath(int V, int[][] residual, int source, int sink, int[] parent) {
    boolean[] visited = new boolean[V];
    Arrays.fill(parent, -1);
    visited[source] = true;
    Deque<Integer> queue = new ArrayDeque<>();
    queue.offer(source);
    
    while (!queue.isEmpty()) {
        int u = queue.poll();
        for (int v = 0; v < V; v++) {
            if (!visited[v] && residual[u][v] > 0) {
                visited[v] = true;
                parent[v] = u;
                if (v == sink) return true;
                queue.offer(v);
            }
        }
    }
    return false;
}
```

---

## Problems

### BFS Problems

---

**P10.01** [E] — Number of Islands (LeetCode 200)

Given a 2D grid of `'1'` (land) and `'0'` (water), count the number of islands.

```
Pattern: BFS flood fill on implicit grid graph.
Core idea: each BFS from an unvisited land cell discovers one island.
```

```java
public int numIslands(char[][] grid) {
    if (grid == null || grid.length == 0) return 0;
    int m = grid.length, n = grid[0].length;
    int count = 0;
    
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == '1') {
                count++;
                bfsMark(grid, i, j, m, n);
            }
        }
    }
    return count;
}

private void bfsMark(char[][] grid, int r, int c, int m, int n) {
    Deque<int[]> queue = new ArrayDeque<>();
    queue.offer(new int[]{r, c});
    grid[r][c] = '0';  // mark visited by modifying grid (avoid extra boolean[][])
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    while (!queue.isEmpty()) {
        int[] cell = queue.poll();
        for (int[] d : dirs) {
            int nr = cell[0] + d[0], nc = cell[1] + d[1];
            if (nr >= 0 && nr < m && nc >= 0 && nc < n && grid[nr][nc] == '1') {
                grid[nr][nc] = '0';
                queue.offer(new int[]{nr, nc});
            }
        }
    }
}
```

```
Time:  O(M × N) — each cell visited once
Space: O(min(M, N)) — queue holds at most one "wavefront" diagonal
JVM note: modifying the input grid avoids allocating a boolean[M][N] visited array.
  For M=N=300, that saves 90,000 bytes. The trade-off: destructive modification.
  If you cannot modify input, use visited[][] or encode visited in higher bits.
```

---

**P10.02** [M] — Rotting Oranges (LeetCode 994)

Every minute, fresh oranges adjacent to rotten oranges become rotten. Return the minimum minutes until all oranges are rotten, or -1 if impossible.

```
Pattern: Multi-source BFS. All initially rotten oranges are sources at time 0.
```

```java
public int orangesRotting(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    Deque<int[]> queue = new ArrayDeque<>();
    int freshCount = 0;
    
    // Enqueue all rotten oranges as sources
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == 2) queue.offer(new int[]{i, j});
            else if (grid[i][j] == 1) freshCount++;
        }
    }
    
    if (freshCount == 0) return 0;
    
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
                    freshCount--;
                    queue.offer(new int[]{nr, nc});
                    rotted = true;
                }
            }
        }
        if (rotted) minutes++;
    }
    
    return freshCount == 0 ? minutes : -1;
}
```

```
Time:  O(M × N)
Space: O(M × N) worst case for queue
Key insight: multi-source BFS naturally computes the minimum time because
  all sources start at t=0 and the wavefront expands uniformly.
```

---

**P10.03** [M] — Walls and Gates (LeetCode 286)

Fill each empty room with the distance to its nearest gate. Gates = 0, walls = -1, empty = INF.

```
Pattern: Multi-source BFS from all gates simultaneously.
The BFS wavefront from all gates expands in lockstep, so the first time
a cell is reached, it is reached by the nearest gate.
```

```java
public void wallsAndGates(int[][] rooms) {
    int m = rooms.length, n = rooms[0].length;
    Deque<int[]> queue = new ArrayDeque<>();
    
    for (int i = 0; i < m; i++)
        for (int j = 0; j < n; j++)
            if (rooms[i][j] == 0) queue.offer(new int[]{i, j});
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    while (!queue.isEmpty()) {
        int[] cell = queue.poll();
        for (int[] d : dirs) {
            int nr = cell[0] + d[0], nc = cell[1] + d[1];
            if (nr >= 0 && nr < m && nc >= 0 && nc < n 
                && rooms[nr][nc] == Integer.MAX_VALUE) {
                rooms[nr][nc] = rooms[cell[0]][cell[1]] + 1;
                queue.offer(new int[]{nr, nc});
            }
        }
    }
}
```

```
Time:  O(M × N)
Space: O(M × N) for queue
This is identical in structure to rotting oranges — multi-source BFS
from gates, filling distances as the wavefront expands.
```

---

**P10.04** [H] — Word Ladder (LeetCode 127)

Transform `beginWord` to `endWord` by changing one letter at a time, using only words in `wordList`. Find shortest transformation length.

```
Pattern: BFS on implicit graph. Each word is a node. Two words are connected
if they differ by exactly one character. Shortest path = BFS levels.
Optimization: instead of checking all pairs (O(N²×L)), use wildcard patterns.
"hot" → "*ot", "h*t", "ho*" — group words by pattern.
```

```java
public int ladderLength(String beginWord, String endWord, List<String> wordList) {
    Set<String> wordSet = new HashSet<>(wordList);
    if (!wordSet.contains(endWord)) return 0;
    
    Deque<String> queue = new ArrayDeque<>();
    queue.offer(beginWord);
    Set<String> visited = new HashSet<>();
    visited.add(beginWord);
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
                    if (wordSet.contains(next) && visited.add(next)) {
                        queue.offer(next);
                    }
                }
                chars[j] = original;
            }
        }
        level++;
    }
    return 0;
}
```

```
Time:  O(N × L × 26) where N = word count, L = word length
Space: O(N × L) for visited set and queue

Optimization: bidirectional BFS halves the search depth.
For word ladders with deep solutions, this can reduce explored states from
millions to thousands.
```

---

**P10.05** [M] — Shortest Path in Binary Matrix (LeetCode 1091)

Find shortest path from top-left to bottom-right in binary grid. Can move in 8 directions (including diagonals).

```java
public int shortestPathBinaryMatrix(int[][] grid) {
    int n = grid.length;
    if (grid[0][0] != 0 || grid[n-1][n-1] != 0) return -1;
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0},{1,1},{1,-1},{-1,1},{-1,-1}};
    Deque<int[]> queue = new ArrayDeque<>();
    queue.offer(new int[]{0, 0});
    grid[0][0] = 1;  // mark visited (and distance)
    
    while (!queue.isEmpty()) {
        int[] cell = queue.poll();
        int r = cell[0], c = cell[1];
        if (r == n - 1 && c == n - 1) return grid[r][c];
        
        for (int[] d : dirs) {
            int nr = r + d[0], nc = c + d[1];
            if (nr >= 0 && nr < n && nc >= 0 && nc < n && grid[nr][nc] == 0) {
                grid[nr][nc] = grid[r][c] + 1;
                queue.offer(new int[]{nr, nc});
            }
        }
    }
    return -1;
}
```

```
Time:  O(N²)
Space: O(N²)
8-directional BFS. Store distance in grid itself to avoid separate visited array.
```

---

**P10.06** [M] — Minimum Knight Moves (LeetCode 1197)

Return minimum moves for a chess knight to reach (x, y) from (0, 0).

```java
public int minKnightMoves(int x, int y) {
    // Symmetry: can reduce to first quadrant
    x = Math.abs(x); y = Math.abs(y);
    
    int[][] dirs = {{1,2},{2,1},{-1,2},{-2,1},{1,-2},{2,-1},{-1,-2},{-2,-1}};
    Set<String> visited = new HashSet<>();
    Deque<int[]> queue = new ArrayDeque<>();
    queue.offer(new int[]{0, 0});
    visited.add("0,0");
    int moves = 0;
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            int[] pos = queue.poll();
            if (pos[0] == x && pos[1] == y) return moves;
            
            for (int[] d : dirs) {
                int nr = pos[0] + d[0], nc = pos[1] + d[1];
                String key = nr + "," + nc;
                // Bound search area to avoid infinite expansion
                if (nr >= -2 && nc >= -2 && nr <= x + 2 && nc <= y + 2 
                    && visited.add(key)) {
                    queue.offer(new int[]{nr, nc});
                }
            }
        }
        moves++;
    }
    return -1;
}
```

```
Time:  O(|x| × |y|) bounded by search area
Space: O(|x| × |y|)
Bidirectional BFS would significantly reduce exploration space here.
```

---

**P10.07** [M] — Open the Lock (LeetCode 752)

Four-digit lock. Each move turns one digit up or down. Avoid deadend combinations. Find minimum moves from "0000" to target.

```java
public int openLock(String[] deadends, String target) {
    Set<String> dead = new HashSet<>(Arrays.asList(deadends));
    if (dead.contains("0000")) return -1;
    if (target.equals("0000")) return 0;
    
    Set<String> visited = new HashSet<>();
    visited.add("0000");
    Deque<String> queue = new ArrayDeque<>();
    queue.offer("0000");
    int moves = 0;
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        moves++;
        for (int i = 0; i < size; i++) {
            String curr = queue.poll();
            
            for (int j = 0; j < 4; j++) {
                for (int delta : new int[]{1, -1}) {
                    char[] chars = curr.toCharArray();
                    chars[j] = (char) ('0' + (chars[j] - '0' + delta + 10) % 10);
                    String next = new String(chars);
                    
                    if (next.equals(target)) return moves;
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
Time:  O(10^4 × 4 × 2) = O(1) — bounded by state space (10,000 combinations)
Space: O(10^4)
State-space BFS: nodes are lock states, edges are single-digit turns.
```

---

**P10.08** [H] — Bus Routes (LeetCode 815)

Multiple bus routes. Find minimum buses to take from source to target stop.

```java
public int numBusesToDestination(int[][] routes, int source, int target) {
    if (source == target) return 0;
    
    // Build stop → routes mapping
    Map<Integer, List<Integer>> stopToRoutes = new HashMap<>();
    for (int i = 0; i < routes.length; i++) {
        for (int stop : routes[i]) {
            stopToRoutes.computeIfAbsent(stop, k -> new ArrayList<>()).add(i);
        }
    }
    
    // BFS on routes (not stops!) — each route is a "super node"
    Deque<Integer> queue = new ArrayDeque<>();
    boolean[] visitedRoute = new boolean[routes.length];
    Set<Integer> visitedStop = new HashSet<>();
    visitedStop.add(source);
    
    // Enqueue all routes passing through source
    for (int route : stopToRoutes.getOrDefault(source, Collections.emptyList())) {
        queue.offer(route);
        visitedRoute[route] = true;
    }
    
    int buses = 1;
    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            int route = queue.poll();
            for (int stop : routes[route]) {
                if (stop == target) return buses;
                if (visitedStop.add(stop)) {
                    for (int nextRoute : stopToRoutes.getOrDefault(stop, Collections.emptyList())) {
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
Time:  O(N × S) where N = number of routes, S = total stops across all routes
Space: O(N × S)
Key insight: BFS on routes, not individual stops. Each route transfer = one bus.
```

---

**P10.09** [H] — Sliding Puzzle (LeetCode 773)

2x3 board with tiles 0-5. Slide tiles to reach goal state [[1,2,3],[4,5,0]].

```java
public int slidingPuzzle(int[][] board) {
    String target = "123450";
    StringBuilder sb = new StringBuilder();
    for (int[] row : board) for (int v : row) sb.append(v);
    String start = sb.toString();
    if (start.equals(target)) return 0;
    
    // Neighbors of each position in flattened 2x3 grid
    int[][] neighbors = {{1,3},{0,2,4},{1,5},{0,4},{1,3,5},{2,4}};
    
    Set<String> visited = new HashSet<>();
    visited.add(start);
    Deque<String> queue = new ArrayDeque<>();
    queue.offer(start);
    int moves = 0;
    
    while (!queue.isEmpty()) {
        int size = queue.size();
        moves++;
        for (int i = 0; i < size; i++) {
            String curr = queue.poll();
            int zeroPos = curr.indexOf('0');
            
            for (int neighbor : neighbors[zeroPos]) {
                char[] chars = curr.toCharArray();
                chars[zeroPos] = chars[neighbor];
                chars[neighbor] = '0';
                String next = new String(chars);
                
                if (next.equals(target)) return moves;
                if (visited.add(next)) {
                    queue.offer(next);
                }
            }
        }
    }
    return -1;
}
```

```
Time:  O(6! × 6) = O(4320) — bounded by number of board states (720)
Space: O(6!)
State-space BFS. Board configuration = node, tile slides = edges.
```

---

**P10.10** [M] — Shortest Bridge (LeetCode 934)

Binary grid with exactly two islands. Find minimum 0s to flip to connect them.

```java
public int shortestBridge(int[][] grid) {
    int n = grid.length;
    Deque<int[]> queue = new ArrayDeque<>();
    boolean found = false;
    
    // Step 1: DFS to find and mark first island (change 1 → 2)
    for (int i = 0; i < n && !found; i++) {
        for (int j = 0; j < n && !found; j++) {
            if (grid[i][j] == 1) {
                dfsMark(grid, i, j, n, queue);
                found = true;
            }
        }
    }
    
    // Step 2: BFS from first island's border to reach second island
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    int level = 0;
    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            int[] cell = queue.poll();
            for (int[] d : dirs) {
                int nr = cell[0] + d[0], nc = cell[1] + d[1];
                if (nr >= 0 && nr < n && nc >= 0 && nc < n) {
                    if (grid[nr][nc] == 1) return level;
                    if (grid[nr][nc] == 0) {
                        grid[nr][nc] = 2;
                        queue.offer(new int[]{nr, nc});
                    }
                }
            }
        }
        level++;
    }
    return -1;
}

private void dfsMark(int[][] grid, int r, int c, int n, Deque<int[]> queue) {
    if (r < 0 || r >= n || c < 0 || c >= n || grid[r][c] != 1) return;
    grid[r][c] = 2;
    queue.offer(new int[]{r, c});  // add to BFS queue (border cells of island 1)
    dfsMark(grid, r + 1, c, n, queue);
    dfsMark(grid, r - 1, c, n, queue);
    dfsMark(grid, r, c + 1, n, queue);
    dfsMark(grid, r, c - 1, n, queue);
}
```

```
Time:  O(N²)
Space: O(N²)
Two-phase approach: DFS to find one island, then multi-source BFS to expand
until reaching the other island. BFS level = bridge length.
```

---

**P10.11** [M] — Snakes and Ladders (LeetCode 909)

N x N board with snakes and ladders. Find minimum dice rolls to reach the last square.

```java
public int snakesAndLadders(int[][] board) {
    int n = board.length;
    int target = n * n;
    
    boolean[] visited = new boolean[target + 1];
    Deque<Integer> queue = new ArrayDeque<>();
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
                if (next > target) break;
                
                // Convert square number to board coordinates (Boustrophedon order)
                int r = (next - 1) / n, c = (next - 1) % n;
                if (r % 2 == 1) c = n - 1 - c;  // reverse columns on odd rows
                r = n - 1 - r;  // bottom to top
                
                if (board[r][c] != -1) next = board[r][c];  // snake or ladder
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
```

```
Time:  O(N²) — each square visited once, 6 edges per square
Space: O(N²)
The tricky part is converting between square numbers and board coordinates.
BFS guarantees shortest path (minimum rolls).
```

---

### DFS Problems

---

**P10.12** [M] — Clone Graph (LeetCode 133)

Create a deep copy of an undirected graph.

```java
public Node cloneGraph(Node node) {
    if (node == null) return null;
    
    Map<Node, Node> cloned = new HashMap<>();
    return dfsClone(node, cloned);
}

private Node dfsClone(Node node, Map<Node, Node> cloned) {
    if (cloned.containsKey(node)) return cloned.get(node);
    
    Node copy = new Node(node.val);
    cloned.put(node, copy);  // map BEFORE recursing to handle cycles
    
    for (Node neighbor : node.neighbors) {
        copy.neighbors.add(dfsClone(neighbor, cloned));
    }
    return copy;
}
```

```
Time:  O(V + E)
Space: O(V) for HashMap
Critical: put clone in map BEFORE recursing into neighbors.
Otherwise, cycles cause infinite recursion.
```

---

**P10.13** [M] — Pacific Atlantic Water Flow (LeetCode 417)

Find cells that can flow to both Pacific (top/left edges) and Atlantic (bottom/right edges).

```java
public List<List<Integer>> pacificAtlantic(int[][] heights) {
    int m = heights.length, n = heights[0].length;
    boolean[][] pacific = new boolean[m][n];
    boolean[][] atlantic = new boolean[m][n];
    
    // DFS from edges (reverse flow: water flows "uphill" from ocean)
    for (int i = 0; i < m; i++) {
        dfsFlow(heights, pacific, i, 0, m, n);
        dfsFlow(heights, atlantic, i, n - 1, m, n);
    }
    for (int j = 0; j < n; j++) {
        dfsFlow(heights, pacific, 0, j, m, n);
        dfsFlow(heights, atlantic, m - 1, j, m, n);
    }
    
    List<List<Integer>> result = new ArrayList<>();
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (pacific[i][j] && atlantic[i][j]) {
                result.add(Arrays.asList(i, j));
            }
        }
    }
    return result;
}

private void dfsFlow(int[][] heights, boolean[][] reachable, int r, int c, int m, int n) {
    if (reachable[r][c]) return;
    reachable[r][c] = true;
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    for (int[] d : dirs) {
        int nr = r + d[0], nc = c + d[1];
        if (nr >= 0 && nr < m && nc >= 0 && nc < n 
            && heights[nr][nc] >= heights[r][c]) {  // can flow from nr,nc TO r,c
            dfsFlow(heights, reachable, nr, nc, m, n);
        }
    }
}
```

```
Time:  O(M × N)
Space: O(M × N)
Key insight: reverse the problem. Instead of checking each cell → ocean,
DFS from ocean edges and find what cells can reach us.
```

---

**P10.14** [M] — Course Schedule (LeetCode 207)

Determine if you can finish all courses given prerequisite pairs. (Cycle detection in directed graph.)

```java
public boolean canFinish(int numCourses, int[][] prerequisites) {
    List<List<Integer>> adj = new ArrayList<>();
    for (int i = 0; i < numCourses; i++) adj.add(new ArrayList<>());
    for (int[] pre : prerequisites) {
        adj.get(pre[1]).add(pre[0]);  // pre[1] → pre[0]
    }
    
    int[] color = new int[numCourses];  // 0=WHITE, 1=GRAY, 2=BLACK
    for (int i = 0; i < numCourses; i++) {
        if (color[i] == 0 && hasCycle(i, adj, color)) return false;
    }
    return true;
}

private boolean hasCycle(int u, List<List<Integer>> adj, int[] color) {
    color[u] = 1;
    for (int v : adj.get(u)) {
        if (color[v] == 1) return true;
        if (color[v] == 0 && hasCycle(v, adj, color)) return true;
    }
    color[u] = 2;
    return false;
}
```

```
Time:  O(V + E) where V = numCourses, E = prerequisites.length
Space: O(V + E)
Can finish all courses iff the prerequisite graph has no cycle.
```

---

**P10.15** [E] — All Paths From Source to Target (LeetCode 797)

Find all paths from node 0 to node n-1 in a DAG.

```java
public List<List<Integer>> allPathsSourceTarget(int[][] graph) {
    List<List<Integer>> result = new ArrayList<>();
    List<Integer> path = new ArrayList<>();
    path.add(0);
    dfsAllPaths(graph, 0, path, result);
    return result;
}

private void dfsAllPaths(int[][] graph, int node, List<Integer> path, List<List<Integer>> result) {
    if (node == graph.length - 1) {
        result.add(new ArrayList<>(path));  // deep copy of current path
        return;
    }
    for (int next : graph[node]) {
        path.add(next);
        dfsAllPaths(graph, next, path, result);
        path.remove(path.size() - 1);  // backtrack
    }
}
```

```
Time:  O(2^V × V) worst case — exponentially many paths
Space: O(V) for recursion stack (excluding output)
Since the graph is a DAG, no visited array needed — no cycles to guard against.
```

---

**P10.16** [E] — Number of Connected Components (LeetCode 323)

Find the number of connected components in an undirected graph.

```java
// Approach 1: DFS
public int countComponents(int n, int[][] edges) {
    List<List<Integer>> adj = new ArrayList<>();
    for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
    for (int[] e : edges) {
        adj.get(e[0]).add(e[1]);
        adj.get(e[1]).add(e[0]);
    }
    
    boolean[] visited = new boolean[n];
    int count = 0;
    for (int i = 0; i < n; i++) {
        if (!visited[i]) {
            dfs(adj, i, visited);
            count++;
        }
    }
    return count;
}

// Approach 2: Union-Find (often cleaner for this problem)
public int countComponentsUF(int n, int[][] edges) {
    int[] parent = new int[n];
    int[] rank = new int[n];
    for (int i = 0; i < n; i++) parent[i] = i;
    int components = n;
    
    for (int[] e : edges) {
        int rx = find(parent, e[0]), ry = find(parent, e[1]);
        if (rx != ry) {
            if (rank[rx] < rank[ry]) parent[rx] = ry;
            else if (rank[rx] > rank[ry]) parent[ry] = rx;
            else { parent[ry] = rx; rank[rx]++; }
            components--;
        }
    }
    return components;
}
```

```
Time:  DFS: O(V + E). Union-Find: O(E × α(V)) ≈ O(E)
Space: O(V)
Union-Find is ideal when edges arrive as a stream (online connectivity).
```

---

**P10.17** [M] — Graph Valid Tree (LeetCode 261)

Check if an undirected graph is a valid tree (connected and acyclic).

```java
public boolean validTree(int n, int[][] edges) {
    // A tree with n nodes has exactly n-1 edges
    if (edges.length != n - 1) return false;
    
    // Check connectivity with Union-Find
    int[] parent = new int[n];
    for (int i = 0; i < n; i++) parent[i] = i;
    
    for (int[] e : edges) {
        int rx = find(parent, e[0]), ry = find(parent, e[1]);
        if (rx == ry) return false;  // cycle: both already in same component
        parent[rx] = ry;
    }
    return true;  // n-1 edges, no cycle → connected tree
}

private int find(int[] parent, int x) {
    if (parent[x] != x) parent[x] = find(parent, parent[x]);
    return parent[x];
}
```

```
Time:  O(E × α(V)) ≈ O(E)
Space: O(V)
A graph is a tree iff it has exactly V-1 edges and is connected (no cycles).
With V-1 edges, just checking no cycle suffices — if acyclic with V-1 edges,
it must be connected (otherwise some component would need extra edges).
```

---

**P10.18** [M] — Surrounded Regions (LeetCode 130)

Capture all 'O' regions not connected to the border.

```java
public void solve(char[][] board) {
    int m = board.length, n = board[0].length;
    
    // DFS from border O's — mark them as safe ('S')
    for (int i = 0; i < m; i++) {
        if (board[i][0] == 'O') dfsMark(board, i, 0, m, n);
        if (board[i][n-1] == 'O') dfsMark(board, i, n-1, m, n);
    }
    for (int j = 0; j < n; j++) {
        if (board[0][j] == 'O') dfsMark(board, 0, j, m, n);
        if (board[m-1][j] == 'O') dfsMark(board, m-1, j, m, n);
    }
    
    // Flip: remaining O → X (captured), S → O (safe)
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (board[i][j] == 'O') board[i][j] = 'X';
            else if (board[i][j] == 'S') board[i][j] = 'O';
        }
    }
}

private void dfsMark(char[][] board, int r, int c, int m, int n) {
    if (r < 0 || r >= m || c < 0 || c >= n || board[r][c] != 'O') return;
    board[r][c] = 'S';
    dfsMark(board, r+1, c, m, n);
    dfsMark(board, r-1, c, m, n);
    dfsMark(board, r, c+1, m, n);
    dfsMark(board, r, c-1, m, n);
}
```

```
Time:  O(M × N)
Space: O(M × N) for recursion stack worst case
Reverse thinking: instead of finding captured regions, find UNCAPTURABLE regions
(connected to border) and capture everything else.
```

---

**P10.19** [H] — Critical Connections in a Network (LeetCode 1192)

Find all bridges (critical connections) whose removal disconnects the network.

```java
public List<List<Integer>> criticalConnections(int n, List<List<Integer>> connections) {
    List<List<Integer>> adj = new ArrayList<>();
    for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
    for (List<Integer> conn : connections) {
        adj.get(conn.get(0)).add(conn.get(1));
        adj.get(conn.get(1)).add(conn.get(0));
    }
    
    int[] disc = new int[n];
    int[] low = new int[n];
    Arrays.fill(disc, -1);
    List<List<Integer>> bridges = new ArrayList<>();
    int[] timer = {0};
    
    dfs(0, -1, adj, disc, low, bridges, timer);
    return bridges;
}

private void dfs(int u, int parent, List<List<Integer>> adj,
                  int[] disc, int[] low, List<List<Integer>> bridges, int[] timer) {
    disc[u] = low[u] = timer[0]++;
    for (int v : adj.get(u)) {
        if (disc[v] == -1) {
            dfs(v, u, adj, disc, low, bridges, timer);
            low[u] = Math.min(low[u], low[v]);
            if (low[v] > disc[u]) {
                bridges.add(Arrays.asList(u, v));
            }
        } else if (v != parent) {
            low[u] = Math.min(low[u], disc[v]);
        }
    }
}
```

```
Time:  O(V + E)
Space: O(V)
Direct application of Tarjan's bridge-finding algorithm.
low[v] > disc[u] means v's subtree has no back edge reaching u or above.
```

---

**P10.20** [H] — Making a Large Island (LeetCode 827)

In a binary grid, flip at most one 0 to 1 and find the largest possible island.

```java
public int largestIsland(int[][] grid) {
    int n = grid.length;
    int[] islandSize = new int[n * n + 2];  // islandSize[id] = area of island
    int id = 2;  // start from 2 (0 = water, 1 = unmarked land)
    
    // Step 1: label each island with unique id, record sizes
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == 1) {
                islandSize[id] = dfsLabel(grid, i, j, n, id);
                id++;
            }
        }
    }
    
    // Step 2: for each 0 cell, check what islands it would connect
    int max = 0;
    for (int sz : islandSize) max = Math.max(max, sz);  // case: no 0 to flip
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == 0) {
                Set<Integer> neighborIslands = new HashSet<>();
                for (int[] d : dirs) {
                    int ni = i + d[0], nj = j + d[1];
                    if (ni >= 0 && ni < n && nj >= 0 && nj < n && grid[ni][nj] > 1) {
                        neighborIslands.add(grid[ni][nj]);
                    }
                }
                int total = 1;  // the flipped cell itself
                for (int islandId : neighborIslands) {
                    total += islandSize[islandId];
                }
                max = Math.max(max, total);
            }
        }
    }
    return max;
}

private int dfsLabel(int[][] grid, int r, int c, int n, int id) {
    if (r < 0 || r >= n || c < 0 || c >= n || grid[r][c] != 1) return 0;
    grid[r][c] = id;
    return 1 + dfsLabel(grid, r+1, c, n, id) + dfsLabel(grid, r-1, c, n, id)
             + dfsLabel(grid, r, c+1, n, id) + dfsLabel(grid, r, c-1, n, id);
}
```

```
Time:  O(N²)
Space: O(N²)
Two-phase: label islands with DFS, then check each water cell's potential merge.
Use Set to avoid double-counting if same island touches water cell from multiple sides.
```

---

### Topological Sort Problems

---

**P10.21** [M] — Course Schedule II (LeetCode 210)

Return a valid course order (topological sort) or empty array if impossible.

```java
public int[] findOrder(int numCourses, int[][] prerequisites) {
    List<List<Integer>> adj = new ArrayList<>();
    int[] inDegree = new int[numCourses];
    for (int i = 0; i < numCourses; i++) adj.add(new ArrayList<>());
    
    for (int[] pre : prerequisites) {
        adj.get(pre[1]).add(pre[0]);
        inDegree[pre[0]]++;
    }
    
    Deque<Integer> queue = new ArrayDeque<>();
    for (int i = 0; i < numCourses; i++) {
        if (inDegree[i] == 0) queue.offer(i);
    }
    
    int[] order = new int[numCourses];
    int idx = 0;
    while (!queue.isEmpty()) {
        int u = queue.poll();
        order[idx++] = u;
        for (int v : adj.get(u)) {
            if (--inDegree[v] == 0) queue.offer(v);
        }
    }
    
    return idx == numCourses ? order : new int[0];
}
```

```
Time:  O(V + E)
Space: O(V + E)
Kahn's algorithm. If idx < numCourses, there is a cycle — no valid ordering.
```

---

**P10.22** [H] — Alien Dictionary (LeetCode 269)

Given sorted words in an alien language, determine the character ordering.

```java
public String alienOrder(String[] words) {
    // Build adjacency list and in-degree from consecutive word pairs
    Map<Character, Set<Character>> adj = new HashMap<>();
    Map<Character, Integer> inDegree = new HashMap<>();
    
    // Initialize all characters
    for (String word : words) {
        for (char c : word.toCharArray()) {
            adj.putIfAbsent(c, new HashSet<>());
            inDegree.putIfAbsent(c, 0);
        }
    }
    
    // Compare consecutive words to find ordering constraints
    for (int i = 0; i < words.length - 1; i++) {
        String w1 = words[i], w2 = words[i + 1];
        if (w1.length() > w2.length() && w1.startsWith(w2)) {
            return "";  // invalid: "abc" before "ab"
        }
        for (int j = 0; j < Math.min(w1.length(), w2.length()); j++) {
            char c1 = w1.charAt(j), c2 = w2.charAt(j);
            if (c1 != c2) {
                if (adj.get(c1).add(c2)) {
                    inDegree.merge(c2, 1, Integer::sum);
                }
                break;  // only first difference matters
            }
        }
    }
    
    // Kahn's topological sort
    Deque<Character> queue = new ArrayDeque<>();
    for (var entry : inDegree.entrySet()) {
        if (entry.getValue() == 0) queue.offer(entry.getKey());
    }
    
    StringBuilder sb = new StringBuilder();
    while (!queue.isEmpty()) {
        char c = queue.poll();
        sb.append(c);
        for (char next : adj.get(c)) {
            inDegree.merge(next, -1, Integer::sum);
            if (inDegree.get(next) == 0) queue.offer(next);
        }
    }
    
    return sb.length() == inDegree.size() ? sb.toString() : "";
}
```

```
Time:  O(C) where C = total characters across all words
Space: O(U + min(U², C)) where U = unique characters
Classic "extract ordering from sorted data" → topological sort.
```

---

**P10.23** [M] — Parallel Courses (LeetCode 1136)

Find minimum semesters to take all courses (longest path in DAG).

```java
public int minimumSemesters(int n, int[][] relations) {
    List<List<Integer>> adj = new ArrayList<>();
    int[] inDegree = new int[n + 1];
    for (int i = 0; i <= n; i++) adj.add(new ArrayList<>());
    
    for (int[] r : relations) {
        adj.get(r[0]).add(r[1]);
        inDegree[r[1]]++;
    }
    
    Deque<Integer> queue = new ArrayDeque<>();
    for (int i = 1; i <= n; i++) {
        if (inDegree[i] == 0) queue.offer(i);
    }
    
    int semesters = 0, count = 0;
    while (!queue.isEmpty()) {
        int size = queue.size();
        semesters++;
        for (int i = 0; i < size; i++) {
            int u = queue.poll();
            count++;
            for (int v : adj.get(u)) {
                if (--inDegree[v] == 0) queue.offer(v);
            }
        }
    }
    
    return count == n ? semesters : -1;
}
```

```
Time:  O(V + E)
Space: O(V + E)
Kahn's with level tracking. Each level = one semester.
The number of levels = longest path in the DAG = critical path = minimum semesters.
```

---

**P10.24** [M] — Sequence Reconstruction (LeetCode 444)

Check if a sequence is the unique shortest supersequence of given subsequences.

```java
public boolean sequenceReconstruction(int[] org, List<List<Integer>> seqs) {
    int n = org.length;
    int[] inDegree = new int[n + 1];
    Map<Integer, Set<Integer>> adj = new HashMap<>();
    Set<Integer> allNodes = new HashSet<>();
    
    for (List<Integer> seq : seqs) {
        for (int val : seq) {
            allNodes.add(val);
            if (val < 1 || val > n) return false;
        }
        for (int i = 0; i < seq.size() - 1; i++) {
            int u = seq.get(i), v = seq.get(i + 1);
            if (adj.computeIfAbsent(u, k -> new HashSet<>()).add(v)) {
                inDegree[v]++;
            }
        }
    }
    
    if (allNodes.size() != n) return false;
    
    Deque<Integer> queue = new ArrayDeque<>();
    for (int i = 1; i <= n; i++) {
        if (inDegree[i] == 0) queue.offer(i);
    }
    
    int idx = 0;
    while (!queue.isEmpty()) {
        if (queue.size() > 1) return false;  // multiple choices → not unique
        int u = queue.poll();
        if (idx >= n || org[idx] != u) return false;
        idx++;
        for (int v : adj.getOrDefault(u, Collections.emptySet())) {
            if (--inDegree[v] == 0) queue.offer(v);
        }
    }
    return idx == n;
}
```

```
Time:  O(V + E)
Space: O(V + E)
Key: unique topological order iff at every step there is exactly one node
with in-degree 0 in the queue. More than one → multiple valid orderings.
```

---

**P10.25** [M] — Minimum Height Trees (LeetCode 310)

Find all root nodes that minimize tree height.

```java
public List<Integer> findMinHeightTrees(int n, int[][] edges) {
    if (n <= 2) {
        List<Integer> result = new ArrayList<>();
        for (int i = 0; i < n; i++) result.add(i);
        return result;
    }
    
    List<Set<Integer>> adj = new ArrayList<>();
    for (int i = 0; i < n; i++) adj.add(new HashSet<>());
    for (int[] e : edges) {
        adj.get(e[0]).add(e[1]);
        adj.get(e[1]).add(e[0]);
    }
    
    // Start with all leaves (degree 1)
    Deque<Integer> leaves = new ArrayDeque<>();
    for (int i = 0; i < n; i++) {
        if (adj.get(i).size() == 1) leaves.offer(i);
    }
    
    // Peel leaves layer by layer (like topological sort from outside in)
    int remaining = n;
    while (remaining > 2) {
        int size = leaves.size();
        remaining -= size;
        Deque<Integer> newLeaves = new ArrayDeque<>();
        for (int i = 0; i < size; i++) {
            int leaf = leaves.poll();
            int neighbor = adj.get(leaf).iterator().next();
            adj.get(neighbor).remove(leaf);
            if (adj.get(neighbor).size() == 1) {
                newLeaves.offer(neighbor);
            }
        }
        leaves = newLeaves;
    }
    
    return new ArrayList<>(leaves);
}
```

```
Time:  O(V)
Space: O(V)
Topological pruning: repeatedly remove leaves. The last 1-2 remaining nodes
are the centroids — optimal roots for minimum height.
Think of it as "peeling the onion" from outside in.
```

---

### Shortest Path Problems

---

**P10.26** [M] — Network Delay Time (LeetCode 743)

Find how long it takes for a signal to reach all nodes from source node k.

```java
public int networkDelayTime(int[][] times, int n, int k) {
    // Build adjacency list
    List<List<int[]>> adj = new ArrayList<>();
    for (int i = 0; i <= n; i++) adj.add(new ArrayList<>());
    for (int[] t : times) adj.get(t[0]).add(new int[]{t[1], t[2]});
    
    // Dijkstra
    int[] dist = new int[n + 1];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[k] = 0;
    
    PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[0] - b[0]);
    pq.offer(new int[]{0, k});
    
    while (!pq.isEmpty()) {
        int[] curr = pq.poll();
        int d = curr[0], u = curr[1];
        if (d > dist[u]) continue;
        
        for (int[] edge : adj.get(u)) {
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
Time:  O((V + E) log V)
Space: O(V + E)
Classic Dijkstra application. The answer is the maximum shortest distance
to any node — the last node to receive the signal.
```

---

**P10.27** [M] — Cheapest Flights Within K Stops (LeetCode 787)

Find cheapest flight from src to dst with at most K stops.

```java
// Approach: Bellman-Ford with K+1 iterations (instead of V-1)
public int findCheapestPrice(int n, int[][] flights, int src, int dst, int k) {
    int[] dist = new int[n];
    Arrays.fill(dist, Integer.MAX_VALUE);
    dist[src] = 0;
    
    // K stops = K+1 edges maximum
    for (int i = 0; i <= k; i++) {
        int[] temp = dist.clone();  // use previous iteration's values
        for (int[] flight : flights) {
            int u = flight[0], v = flight[1], w = flight[2];
            if (dist[u] != Integer.MAX_VALUE && dist[u] + w < temp[v]) {
                temp[v] = dist[u] + w;
            }
        }
        dist = temp;
    }
    
    return dist[dst] == Integer.MAX_VALUE ? -1 : dist[dst];
}
```

```
Time:  O(K × E)
Space: O(V)
Key insight: Bellman-Ford's i-th iteration finds shortest paths with at most i edges.
We need at most K+1 edges (K stops). Must use temp array to avoid using updated
values from the same iteration (which would allow unlimited hops).
```

---

**P10.28** [M] — Path With Minimum Effort (LeetCode 1631)

Find path from top-left to bottom-right minimizing maximum absolute height difference along the path.

```java
public int minimumEffortPath(int[][] heights) {
    int m = heights.length, n = heights[0].length;
    int[][] effort = new int[m][n];
    for (int[] row : effort) Arrays.fill(row, Integer.MAX_VALUE);
    effort[0][0] = 0;
    
    // Modified Dijkstra: "distance" = max effort along path
    PriorityQueue<int[]> pq = new PriorityQueue<>((a, b) -> a[0] - b[0]);
    pq.offer(new int[]{0, 0, 0});  // {effort, row, col}
    
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
Time:  O(M × N × log(M × N))
Space: O(M × N)
Dijkstra variant where "distance" = max edge weight on path (minimax path).
Edge relaxation: newEffort = max(currentEffort, edgeWeight).
```

---

**P10.29** [M] — Path with Maximum Probability (LeetCode 1514)

Find the path with maximum success probability from start to end.

```java
public double maxProbability(int n, int[][] edges, double[] succProb, int start, int end) {
    List<List<double[]>> adj = new ArrayList<>();
    for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
    for (int i = 0; i < edges.length; i++) {
        adj.get(edges[i][0]).add(new double[]{edges[i][1], succProb[i]});
        adj.get(edges[i][1]).add(new double[]{edges[i][0], succProb[i]});
    }
    
    double[] prob = new double[n];
    prob[start] = 1.0;
    
    // Max-heap Dijkstra (maximize probability instead of minimize distance)
    PriorityQueue<double[]> pq = new PriorityQueue<>((a, b) -> Double.compare(b[0], a[0]));
    pq.offer(new double[]{1.0, start});
    
    while (!pq.isEmpty()) {
        double[] curr = pq.poll();
        double p = curr[0];
        int u = (int) curr[1];
        if (u == end) return p;
        if (p < prob[u]) continue;
        
        for (double[] edge : adj.get(u)) {
            int v = (int) edge[0];
            double newProb = p * edge[1];
            if (newProb > prob[v]) {
                prob[v] = newProb;
                pq.offer(new double[]{newProb, v});
            }
        }
    }
    return 0.0;
}
```

```
Time:  O((V + E) log V)
Space: O(V + E)
Dijkstra with max-heap. Probabilities multiply along the path.
Maximizing product of probabilities is equivalent to minimizing sum of -log(prob).
```

---

**P10.30** [M] — Shortest Path with Alternating Colors (LeetCode 1129)

Find shortest path to each node using alternating red and blue edges.

```java
public int[] shortestAlternatingPaths(int n, int[][] redEdges, int[][] blueEdges) {
    // adj[node][color] = list of neighbors. 0 = red, 1 = blue
    @SuppressWarnings("unchecked")
    List<Integer>[][] adj = new ArrayList[n][2];
    for (int i = 0; i < n; i++) {
        adj[i][0] = new ArrayList<>();
        adj[i][1] = new ArrayList<>();
    }
    for (int[] e : redEdges) adj[e[0]][0].add(e[1]);
    for (int[] e : blueEdges) adj[e[0]][1].add(e[1]);
    
    int[][] dist = new int[n][2];
    for (int[] row : dist) Arrays.fill(row, Integer.MAX_VALUE);
    dist[0][0] = dist[0][1] = 0;
    
    // BFS with state (node, lastColor)
    Deque<int[]> queue = new ArrayDeque<>();
    queue.offer(new int[]{0, 0});  // start with red
    queue.offer(new int[]{0, 1});  // start with blue
    
    while (!queue.isEmpty()) {
        int[] curr = queue.poll();
        int u = curr[0], lastColor = curr[1];
        int nextColor = 1 - lastColor;
        
        for (int v : adj[u][nextColor]) {
            if (dist[v][nextColor] == Integer.MAX_VALUE) {
                dist[v][nextColor] = dist[u][lastColor] + 1;
                queue.offer(new int[]{v, nextColor});
            }
        }
    }
    
    int[] result = new int[n];
    for (int i = 0; i < n; i++) {
        int minDist = Math.min(dist[i][0], dist[i][1]);
        result[i] = minDist == Integer.MAX_VALUE ? -1 : minDist;
    }
    return result;
}
```

```
Time:  O(V + E)
Space: O(V + E)
State-expanded BFS: state = (node, last_color_used). This doubles the state
space but handles the alternating constraint cleanly.
```

---

### MST Problems

---

**P10.31** [M] — Min Cost to Connect All Points (LeetCode 1584)

Given N points, find minimum cost to connect all points where cost = Manhattan distance.

```java
public int minCostConnectPoints(int[][] points) {
    int n = points.length;
    
    // Prim's algorithm (dense graph: all pairs connected → V² edges)
    boolean[] inMST = new boolean[n];
    int[] minDist = new int[n];
    Arrays.fill(minDist, Integer.MAX_VALUE);
    minDist[0] = 0;
    
    int totalCost = 0;
    for (int i = 0; i < n; i++) {
        // Find node with minimum distance not yet in MST (O(V) scan)
        int u = -1;
        for (int j = 0; j < n; j++) {
            if (!inMST[j] && (u == -1 || minDist[j] < minDist[u])) {
                u = j;
            }
        }
        
        inMST[u] = true;
        totalCost += minDist[u];
        
        // Update distances
        for (int v = 0; v < n; v++) {
            if (!inMST[v]) {
                int dist = Math.abs(points[u][0] - points[v][0]) 
                         + Math.abs(points[u][1] - points[v][1]);
                minDist[v] = Math.min(minDist[v], dist);
            }
        }
    }
    return totalCost;
}
```

```
Time:  O(V²) — dense graph, Prim's with linear scan is optimal
Space: O(V)
For dense graphs (E = V²), Prim's with O(V²) linear scan beats Prim's with
PQ (O(V² log V)) and Kruskal's (O(V² log V²) = O(V² log V)).
```

---

**P10.32** [H] — Optimize Water Distribution (LeetCode 1168)

Supply water to N houses by building wells or connecting pipes. Minimize total cost.

```java
public int minCostToSupplyWater(int n, int[] wells, int[][] pipes) {
    // Trick: add a virtual node 0 (water source).
    // Well cost for house i = edge (0, i) with weight wells[i-1].
    // Now it is a standard MST problem on n+1 nodes.
    
    List<int[]> edges = new ArrayList<>();
    for (int i = 0; i < n; i++) {
        edges.add(new int[]{0, i + 1, wells[i]});  // virtual source to house
    }
    for (int[] pipe : pipes) {
        edges.add(new int[]{pipe[0], pipe[1], pipe[2]});
    }
    
    // Kruskal's
    edges.sort((a, b) -> a[2] - b[2]);
    int[] parent = new int[n + 1];
    int[] rank = new int[n + 1];
    for (int i = 0; i <= n; i++) parent[i] = i;
    
    int totalCost = 0;
    for (int[] edge : edges) {
        int u = edge[0], v = edge[1], w = edge[2];
        int ru = find(parent, u), rv = find(parent, v);
        if (ru != rv) {
            if (rank[ru] < rank[rv]) parent[ru] = rv;
            else if (rank[ru] > rank[rv]) parent[rv] = ru;
            else { parent[rv] = ru; rank[ru]++; }
            totalCost += w;
        }
    }
    return totalCost;
}
```

```
Time:  O(E log E) where E = n + pipes.length
Space: O(V + E)
Elegant reduction: "building a well" = "connecting to a virtual water source."
This transforms a choice problem (build or connect?) into a pure MST problem.
```

---

### Union-Find Problems

---

**P10.33** [E] — Number of Provinces (LeetCode 547)

Given an adjacency matrix, find the number of connected components (provinces).

```java
public int findCircleNum(int[][] isConnected) {
    int n = isConnected.length;
    int[] parent = new int[n];
    for (int i = 0; i < n; i++) parent[i] = i;
    int components = n;
    
    for (int i = 0; i < n; i++) {
        for (int j = i + 1; j < n; j++) {
            if (isConnected[i][j] == 1) {
                int ri = find(parent, i), rj = find(parent, j);
                if (ri != rj) {
                    parent[ri] = rj;
                    components--;
                }
            }
        }
    }
    return components;
}

private int find(int[] parent, int x) {
    if (parent[x] != x) parent[x] = find(parent, parent[x]);
    return parent[x];
}
```

```
Time:  O(V² × α(V)) ≈ O(V²) — must check entire matrix
Space: O(V)
Input is adjacency matrix, so we must scan O(V²) entries regardless.
```

---

**P10.34** [M] — Redundant Connection (LeetCode 684)

Find the edge that, when removed, makes the graph a valid tree (last edge forming a cycle).

```java
public int[] findRedundantConnection(int[][] edges) {
    int n = edges.length;
    int[] parent = new int[n + 1];
    int[] rank = new int[n + 1];
    for (int i = 0; i <= n; i++) parent[i] = i;
    
    for (int[] edge : edges) {
        int ru = find(parent, edge[0]), rv = find(parent, edge[1]);
        if (ru == rv) return edge;  // this edge creates a cycle
        
        if (rank[ru] < rank[rv]) parent[ru] = rv;
        else if (rank[ru] > rank[rv]) parent[rv] = ru;
        else { parent[rv] = ru; rank[ru]++; }
    }
    return new int[0];  // should not reach here
}
```

```
Time:  O(E × α(V)) ≈ O(E)
Space: O(V)
Process edges in order. The first edge where both endpoints are already
in the same component creates a cycle — that is the redundant edge.
```

---

**P10.35** [H] — Accounts Merge (LeetCode 721)

Merge accounts by grouping emails that belong to the same person.

```java
public List<List<String>> accountsMerge(List<List<String>> accounts) {
    Map<String, Integer> emailToId = new HashMap<>();
    Map<String, String> emailToName = new HashMap<>();
    int id = 0;
    
    for (List<String> account : accounts) {
        String name = account.get(0);
        for (int i = 1; i < account.size(); i++) {
            String email = account.get(i);
            emailToName.put(email, name);
            if (!emailToId.containsKey(email)) {
                emailToId.put(email, id++);
            }
        }
    }
    
    // Union all emails within each account
    int[] parent = new int[id];
    int[] rank = new int[id];
    for (int i = 0; i < id; i++) parent[i] = i;
    
    for (List<String> account : accounts) {
        int firstId = emailToId.get(account.get(1));
        for (int i = 2; i < account.size(); i++) {
            union(parent, rank, firstId, emailToId.get(account.get(i)));
        }
    }
    
    // Group emails by root
    Map<Integer, TreeSet<String>> groups = new HashMap<>();
    for (String email : emailToId.keySet()) {
        int root = find(parent, emailToId.get(email));
        groups.computeIfAbsent(root, k -> new TreeSet<>()).add(email);
    }
    
    // Build result
    List<List<String>> result = new ArrayList<>();
    for (var entry : groups.entrySet()) {
        List<String> merged = new ArrayList<>();
        String anyEmail = entry.getValue().first();
        merged.add(emailToName.get(anyEmail));
        merged.addAll(entry.getValue());
        result.add(merged);
    }
    return result;
}

private int find(int[] parent, int x) {
    if (parent[x] != x) parent[x] = find(parent, parent[x]);
    return parent[x];
}

private void union(int[] parent, int[] rank, int x, int y) {
    int rx = find(parent, x), ry = find(parent, y);
    if (rx == ry) return;
    if (rank[rx] < rank[ry]) parent[rx] = ry;
    else if (rank[rx] > rank[ry]) parent[ry] = rx;
    else { parent[ry] = rx; rank[rx]++; }
}
```

```
Time:  O(N × α(N) + N log N) where N = total emails. Sort for TreeSet.
Space: O(N)
Each email is a node. Emails within the same account are unioned together.
TreeSet for sorted output per merged account.
```

---

**P10.36** [M] — Earliest Moment When Everyone Becomes Friends (LeetCode 1101)

Given timestamped friend events, find the earliest time all N people are in one group.

```java
public int earliestAcq(int[][] logs, int n) {
    Arrays.sort(logs, (a, b) -> a[0] - b[0]);  // sort by timestamp
    
    int[] parent = new int[n];
    int[] rank = new int[n];
    for (int i = 0; i < n; i++) parent[i] = i;
    int components = n;
    
    for (int[] log : logs) {
        int time = log[0], u = log[1], v = log[2];
        int ru = find(parent, u), rv = find(parent, v);
        if (ru != rv) {
            if (rank[ru] < rank[rv]) parent[ru] = rv;
            else if (rank[ru] > rank[rv]) parent[rv] = ru;
            else { parent[rv] = ru; rank[ru]++; }
            components--;
            if (components == 1) return time;
        }
    }
    return -1;
}
```

```
Time:  O(E log E + E × α(V)) — sort + union-find
Space: O(V)
Process events chronologically. The moment components drops to 1, everyone
is connected. Union-Find is perfect for this online connectivity query.
```

---

### Advanced Graph Problems

---

**P10.37** [M] — Evaluate Division (LeetCode 399)

Given equations like a/b = 2.0, b/c = 3.0, answer queries like a/c = ?.

```java
public double[] calcEquation(List<List<String>> equations, double[] values,
                              List<List<String>> queries) {
    // Build weighted directed graph: a/b = v → edge a→b weight v, edge b→a weight 1/v
    Map<String, Map<String, Double>> graph = new HashMap<>();
    for (int i = 0; i < equations.size(); i++) {
        String a = equations.get(i).get(0), b = equations.get(i).get(1);
        graph.computeIfAbsent(a, k -> new HashMap<>()).put(b, values[i]);
        graph.computeIfAbsent(b, k -> new HashMap<>()).put(a, 1.0 / values[i]);
    }
    
    double[] result = new double[queries.size()];
    for (int i = 0; i < queries.size(); i++) {
        String src = queries.get(i).get(0), dst = queries.get(i).get(1);
        if (!graph.containsKey(src) || !graph.containsKey(dst)) {
            result[i] = -1.0;
        } else {
            result[i] = bfsDivision(graph, src, dst);
        }
    }
    return result;
}

private double bfsDivision(Map<String, Map<String, Double>> graph, String src, String dst) {
    if (src.equals(dst)) return 1.0;
    
    Set<String> visited = new HashSet<>();
    Deque<Object[]> queue = new ArrayDeque<>();
    queue.offer(new Object[]{src, 1.0});
    visited.add(src);
    
    while (!queue.isEmpty()) {
        Object[] curr = queue.poll();
        String node = (String) curr[0];
        double product = (double) curr[1];
        
        for (var entry : graph.get(node).entrySet()) {
            String neighbor = entry.getKey();
            double weight = entry.getValue();
            if (neighbor.equals(dst)) return product * weight;
            if (visited.add(neighbor)) {
                queue.offer(new Object[]{neighbor, product * weight});
            }
        }
    }
    return -1.0;
}
```

```
Time:  O(Q × (V + E)) where Q = queries
Space: O(V + E)
Model as weighted graph. a/b = 2 means path a→b has product 2.
Query a/c = product of weights along path from a to c.
BFS (or DFS) finds the path and accumulates the product.
Alternative: Union-Find with weighted edges (maintains ratio to root).
```

---

**P10.38** [H] — Reconstruct Itinerary (LeetCode 332)

Find the lexicographically smallest Euler path starting from "JFK".

```java
public List<String> findItinerary(List<List<String>> tickets) {
    // Build adjacency list with sorted destinations (for lexicographic order)
    Map<String, PriorityQueue<String>> graph = new HashMap<>();
    for (List<String> ticket : tickets) {
        graph.computeIfAbsent(ticket.get(0), k -> new PriorityQueue<>())
             .offer(ticket.get(1));
    }
    
    // Hierholzer's algorithm
    LinkedList<String> result = new LinkedList<>();
    dfsEuler("JFK", graph, result);
    return result;
}

private void dfsEuler(String node, Map<String, PriorityQueue<String>> graph,
                       LinkedList<String> result) {
    PriorityQueue<String> neighbors = graph.get(node);
    while (neighbors != null && !neighbors.isEmpty()) {
        String next = neighbors.poll();  // remove edge (greedy: smallest first)
        dfsEuler(next, graph, result);
    }
    result.addFirst(node);  // add to front (reverse post-order)
}
```

```
Time:  O(E log E) — PriorityQueue operations for lexicographic order
Space: O(E)
Hierholzer's algorithm for Euler path. PriorityQueue ensures we always
choose the lexicographically smallest next destination.
addFirst builds the path in reverse (post-order reversal).
```

---

**P10.39** [M] — Is Graph Bipartite? (LeetCode 785)

```java
public boolean isBipartite(int[][] graph) {
    int n = graph.length;
    int[] color = new int[n];  // 0 = uncolored, 1 and -1 are the two colors
    
    for (int i = 0; i < n; i++) {
        if (color[i] != 0) continue;
        
        // BFS from this node
        Deque<Integer> queue = new ArrayDeque<>();
        queue.offer(i);
        color[i] = 1;
        
        while (!queue.isEmpty()) {
            int u = queue.poll();
            for (int v : graph[u]) {
                if (color[v] == 0) {
                    color[v] = -color[u];
                    queue.offer(v);
                } else if (color[v] == color[u]) {
                    return false;
                }
            }
        }
    }
    return true;
}
```

```
Time:  O(V + E)
Space: O(V)
2-coloring with BFS. If any neighbor has the same color, not bipartite.
```

---

**P10.40** [M] — Possible Bipartition (LeetCode 886)

Split N people into two groups such that no two people who dislike each other are in the same group.

```java
public boolean possibleBipartition(int n, int[][] dislikes) {
    List<List<Integer>> adj = new ArrayList<>();
    for (int i = 0; i <= n; i++) adj.add(new ArrayList<>());
    for (int[] d : dislikes) {
        adj.get(d[0]).add(d[1]);
        adj.get(d[1]).add(d[0]);
    }
    
    int[] color = new int[n + 1];
    for (int i = 1; i <= n; i++) {
        if (color[i] == 0) {
            color[i] = 1;
            Deque<Integer> queue = new ArrayDeque<>();
            queue.offer(i);
            while (!queue.isEmpty()) {
                int u = queue.poll();
                for (int v : adj.get(u)) {
                    if (color[v] == 0) {
                        color[v] = -color[u];
                        queue.offer(v);
                    } else if (color[v] == color[u]) {
                        return false;
                    }
                }
            }
        }
    }
    return true;
}
```

```
Time:  O(V + E)
Space: O(V + E)
Same as bipartite check. "People who dislike each other" = edges.
Can split into two groups iff the dislike graph is bipartite.
```

---

**P10.41** [M] — Detect Cycles in a 2D Grid (LeetCode 1559)

Detect if there is a cycle of same-valued cells in a grid (length >= 4).

```java
public boolean containsCycle(char[][] grid) {
    int m = grid.length, n = grid[0].length;
    int[] parent = new int[m * n];
    int[] rank = new int[m * n];
    for (int i = 0; i < m * n; i++) parent[i] = i;
    
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            int id = i * n + j;
            // Only check right and down to avoid double-counting
            if (j + 1 < n && grid[i][j] == grid[i][j + 1]) {
                if (!union(parent, rank, id, id + 1)) return true;  // cycle
            }
            if (i + 1 < m && grid[i][j] == grid[i + 1][j]) {
                if (!union(parent, rank, id, id + n)) return true;  // cycle
            }
        }
    }
    return false;
}

private int find(int[] parent, int x) {
    if (parent[x] != x) parent[x] = find(parent, parent[x]);
    return parent[x];
}

private boolean union(int[] parent, int[] rank, int x, int y) {
    int rx = find(parent, x), ry = find(parent, y);
    if (rx == ry) return false;  // already connected → cycle
    if (rank[rx] < rank[ry]) parent[rx] = ry;
    else if (rank[rx] > rank[ry]) parent[ry] = rx;
    else { parent[ry] = rx; rank[rx]++; }
    return true;
}
```

```
Time:  O(M × N × α(M × N))
Space: O(M × N)
Union-Find on grid cells with same value. If two adjacent same-value cells
are already in the same component when we try to union them, we found a cycle.
Only check right and down to avoid processing each edge twice.
```

---

### Additional Problems (Completing 60)

---

**P10.42** [E] — Flood Fill (LeetCode 733)

```java
public int[][] floodFill(int[][] image, int sr, int sc, int color) {
    if (image[sr][sc] == color) return image;
    dfs(image, sr, sc, image[sr][sc], color);
    return image;
}

private void dfs(int[][] image, int r, int c, int orig, int color) {
    if (r < 0 || r >= image.length || c < 0 || c >= image[0].length 
        || image[r][c] != orig) return;
    image[r][c] = color;
    dfs(image, r+1, c, orig, color);
    dfs(image, r-1, c, orig, color);
    dfs(image, r, c+1, orig, color);
    dfs(image, r, c-1, orig, color);
}
```

```
Time: O(M × N). Space: O(M × N) recursion stack.
Edge case: if original color == new color, skip (infinite recursion otherwise).
```

---

**P10.43** [E] — Find if Path Exists in Graph (LeetCode 1971)

```java
public boolean validPath(int n, int[][] edges, int source, int destination) {
    int[] parent = new int[n];
    for (int i = 0; i < n; i++) parent[i] = i;
    for (int[] e : edges) {
        int rx = find(parent, e[0]), ry = find(parent, e[1]);
        if (rx != ry) parent[rx] = ry;
    }
    return find(parent, source) == find(parent, destination);
}
```

```
Time: O(E × α(V)). Space: O(V). Union-Find is simplest for path existence.
```

---

**P10.44** [E] — Find Center of Star Graph (LeetCode 1791)

```java
public int findCenter(int[][] edges) {
    // The center appears in every edge. Compare first two edges.
    if (edges[0][0] == edges[1][0] || edges[0][0] == edges[1][1]) return edges[0][0];
    return edges[0][1];
}
```

```
Time: O(1). The center node must appear in both the first and second edges.
```

---

**P10.45** [E] — Find the Town Judge (LeetCode 997)

```java
public int findJudge(int n, int[][] trust) {
    int[] balance = new int[n + 1];  // in-degree minus out-degree
    for (int[] t : trust) {
        balance[t[0]]--;  // trusts someone → not the judge
        balance[t[1]]++;  // trusted by someone
    }
    for (int i = 1; i <= n; i++) {
        if (balance[i] == n - 1) return i;  // trusted by all others, trusts nobody
    }
    return -1;
}
```

```
Time: O(E + V). Space: O(V). The judge has in-degree V-1 and out-degree 0.
```

---

**P10.46** [E] — Find All Groups of Farmland (LeetCode 1992)

```java
public int[][] findFarmland(int[][] land) {
    int m = land.length, n = land[0].length;
    List<int[]> result = new ArrayList<>();
    
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (land[i][j] == 1) {
                int[] corner = {i, j, i, j};
                dfsFarm(land, i, j, m, n, corner);
                result.add(corner);
            }
        }
    }
    return result.toArray(new int[0][]);
}

private void dfsFarm(int[][] land, int r, int c, int m, int n, int[] corner) {
    if (r < 0 || r >= m || c < 0 || c >= n || land[r][c] != 1) return;
    land[r][c] = 0;
    corner[2] = Math.max(corner[2], r);
    corner[3] = Math.max(corner[3], c);
    dfsFarm(land, r+1, c, m, n, corner);
    dfsFarm(land, r, c+1, m, n, corner);
    dfsFarm(land, r-1, c, m, n, corner);
    dfsFarm(land, r, c-1, m, n, corner);
}
```

```
Time: O(M × N). Space: O(M × N). DFS flood fill tracking max row/col as bottom-right corner.
```

---

**P10.47** [E] — Keys and Rooms (LeetCode 841)

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
Time: O(V + E). Space: O(V). DFS/BFS from room 0, check if all rooms reachable.
```

---

**P10.48** [E] — Maximum Number of Fish in a Grid (LeetCode 2658)

```java
public int findMaxFish(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    int max = 0;
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] > 0) {
                max = Math.max(max, dfs(grid, i, j, m, n));
            }
        }
    }
    return max;
}

private int dfs(int[][] grid, int r, int c, int m, int n) {
    if (r < 0 || r >= m || c < 0 || c >= n || grid[r][c] <= 0) return 0;
    int fish = grid[r][c];
    grid[r][c] = 0;
    return fish + dfs(grid, r+1, c, m, n) + dfs(grid, r-1, c, m, n)
               + dfs(grid, r, c+1, m, n) + dfs(grid, r, c-1, m, n);
}
```

```
Time: O(M × N). Space: O(M × N). Sum fish in connected water region via DFS.
```

---

**P10.49** [E] — Island Perimeter (LeetCode 463)

```java
public int islandPerimeter(int[][] grid) {
    int perimeter = 0;
    int m = grid.length, n = grid[0].length;
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == 1) {
                perimeter += 4;
                if (i > 0 && grid[i-1][j] == 1) perimeter -= 2;
                if (j > 0 && grid[i][j-1] == 1) perimeter -= 2;
            }
        }
    }
    return perimeter;
}
```

```
Time: O(M × N). Space: O(1). Each land cell starts with 4 sides. Each shared
edge with a neighbor removes 2 (one from each cell).
```

---

**P10.50** [E] — Max Area of Island (LeetCode 695)

```java
public int maxAreaOfIsland(int[][] grid) {
    int m = grid.length, n = grid[0].length, max = 0;
    for (int i = 0; i < m; i++)
        for (int j = 0; j < n; j++)
            if (grid[i][j] == 1) max = Math.max(max, dfs(grid, i, j, m, n));
    return max;
}

private int dfs(int[][] grid, int r, int c, int m, int n) {
    if (r < 0 || r >= m || c < 0 || c >= n || grid[r][c] != 1) return 0;
    grid[r][c] = 0;
    return 1 + dfs(grid, r+1, c, m, n) + dfs(grid, r-1, c, m, n)
             + dfs(grid, r, c+1, m, n) + dfs(grid, r, c-1, m, n);
}
```

```
Time: O(M × N). Space: O(M × N). DFS flood fill counting cells per island.
```

---

**P10.51** [E] — Number of Enclaves (LeetCode 1020)

```java
public int numEnclaves(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    // DFS from border land cells to mark them
    for (int i = 0; i < m; i++) {
        if (grid[i][0] == 1) dfs(grid, i, 0, m, n);
        if (grid[i][n-1] == 1) dfs(grid, i, n-1, m, n);
    }
    for (int j = 0; j < n; j++) {
        if (grid[0][j] == 1) dfs(grid, 0, j, m, n);
        if (grid[m-1][j] == 1) dfs(grid, m-1, j, m, n);
    }
    
    int count = 0;
    for (int i = 0; i < m; i++)
        for (int j = 0; j < n; j++)
            if (grid[i][j] == 1) count++;
    return count;
}

private void dfs(int[][] grid, int r, int c, int m, int n) {
    if (r < 0 || r >= m || c < 0 || c >= n || grid[r][c] != 1) return;
    grid[r][c] = 0;
    dfs(grid, r+1, c, m, n); dfs(grid, r-1, c, m, n);
    dfs(grid, r, c+1, m, n); dfs(grid, r, c-1, m, n);
}
```

```
Time: O(M × N). Space: O(M × N). Same pattern as surrounded regions.
Eliminate border-connected land, count remaining land cells.
```

---

**P10.52** [E] — 01 Matrix (LeetCode 542)

Given a binary matrix, find distance of each cell to nearest 0.

```java
public int[][] updateMatrix(int[][] mat) {
    int m = mat.length, n = mat[0].length;
    int[][] dist = new int[m][n];
    Deque<int[]> queue = new ArrayDeque<>();
    
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (mat[i][j] == 0) {
                queue.offer(new int[]{i, j});
            } else {
                dist[i][j] = Integer.MAX_VALUE;
            }
        }
    }
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    while (!queue.isEmpty()) {
        int[] cell = queue.poll();
        for (int[] d : dirs) {
            int nr = cell[0] + d[0], nc = cell[1] + d[1];
            if (nr >= 0 && nr < m && nc >= 0 && nc < n 
                && dist[nr][nc] > dist[cell[0]][cell[1]] + 1) {
                dist[nr][nc] = dist[cell[0]][cell[1]] + 1;
                queue.offer(new int[]{nr, nc});
            }
        }
    }
    return dist;
}
```

```
Time: O(M × N). Space: O(M × N). Multi-source BFS from all 0 cells.
```

---

**P10.53** [M] — As Far from Land as Possible (LeetCode 1162)

```java
public int maxDistance(int[][] grid) {
    int n = grid.length;
    Deque<int[]> queue = new ArrayDeque<>();
    for (int i = 0; i < n; i++)
        for (int j = 0; j < n; j++)
            if (grid[i][j] == 1) queue.offer(new int[]{i, j});
    
    if (queue.size() == 0 || queue.size() == n * n) return -1;
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    int maxDist = 0;
    while (!queue.isEmpty()) {
        int[] cell = queue.poll();
        for (int[] d : dirs) {
            int nr = cell[0] + d[0], nc = cell[1] + d[1];
            if (nr >= 0 && nr < n && nc >= 0 && nc < n && grid[nr][nc] == 0) {
                grid[nr][nc] = grid[cell[0]][cell[1]] + 1;
                maxDist = Math.max(maxDist, grid[nr][nc] - 1);
                queue.offer(new int[]{nr, nc});
            }
        }
    }
    return maxDist;
}
```

```
Time: O(N²). Space: O(N²). Multi-source BFS from all land cells.
The last water cell reached has maximum distance.
```

---

**P10.54** [M] — Shortest Path in a Grid with Obstacles Elimination (LeetCode 1293)

```java
public int shortestPath(int[][] grid, int k) {
    int m = grid.length, n = grid[0].length;
    if (m == 1 && n == 1) return 0;
    
    // State: (row, col, remaining eliminations)
    boolean[][][] visited = new boolean[m][n][k + 1];
    Deque<int[]> queue = new ArrayDeque<>();
    queue.offer(new int[]{0, 0, k});
    visited[0][0][k] = true;
    int steps = 0;
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    while (!queue.isEmpty()) {
        int size = queue.size();
        steps++;
        for (int i = 0; i < size; i++) {
            int[] curr = queue.poll();
            for (int[] d : dirs) {
                int nr = curr[0] + d[0], nc = curr[1] + d[1];
                if (nr < 0 || nr >= m || nc < 0 || nc >= n) continue;
                int rem = curr[2] - grid[nr][nc];
                if (rem < 0) continue;
                if (nr == m - 1 && nc == n - 1) return steps;
                if (!visited[nr][nc][rem]) {
                    visited[nr][nc][rem] = true;
                    queue.offer(new int[]{nr, nc, rem});
                }
            }
        }
    }
    return -1;
}
```

```
Time:  O(M × N × K)
Space: O(M × N × K)
BFS with expanded state space. (row, col) is not enough — we also need to
track remaining obstacle eliminations. This is a classic state-space BFS pattern.
```

---

**P10.55** [H] — Swim in Rising Water (LeetCode 778)

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
                int newTime = Math.max(t, grid[nr][nc]);
                if (newTime < dist[nr][nc]) {
                    dist[nr][nc] = newTime;
                    pq.offer(new int[]{newTime, nr, nc});
                }
            }
        }
    }
    return -1;
}
```

```
Time:  O(N² log N)
Space: O(N²)
Dijkstra variant. "Distance" = maximum elevation along path (minimax).
Edge relaxation: newTime = max(currentTime, nextCellElevation).
```

---

**P10.56** [H] — Longest Increasing Path in a Matrix (LeetCode 329)

```java
public int longestIncreasingPath(int[][] matrix) {
    int m = matrix.length, n = matrix[0].length;
    int[][] memo = new int[m][n];
    int max = 0;
    
    for (int i = 0; i < m; i++)
        for (int j = 0; j < n; j++)
            max = Math.max(max, dfs(matrix, memo, i, j, m, n));
    return max;
}

private int dfs(int[][] matrix, int[][] memo, int r, int c, int m, int n) {
    if (memo[r][c] != 0) return memo[r][c];
    
    int[][] dirs = {{0,1},{0,-1},{1,0},{-1,0}};
    int maxLen = 1;
    for (int[] d : dirs) {
        int nr = r + d[0], nc = c + d[1];
        if (nr >= 0 && nr < m && nc >= 0 && nc < n && matrix[nr][nc] > matrix[r][c]) {
            maxLen = Math.max(maxLen, 1 + dfs(matrix, memo, nr, nc, m, n));
        }
    }
    
    memo[r][c] = maxLen;
    return maxLen;
}
```

```
Time:  O(M × N) — each cell computed once (memoization)
Space: O(M × N)
DFS with memoization. No visited array needed: the strictly increasing
constraint prevents cycles (you can never return to a smaller value).
Can also be solved with topological sort: process cells in increasing order.
```

---

**P10.57** [H] — Word Search II (LeetCode 212)

Find all words from a dictionary present in a grid.

```java
public List<String> findWords(char[][] board, String[] words) {
    // Build Trie from words
    int[][] trie = new int[250001][26];
    String[] wordAtNode = new String[250001];
    int trieSize = 1;
    
    for (String word : words) {
        int node = 0;
        for (char c : word.toCharArray()) {
            int idx = c - 'a';
            if (trie[node][idx] == 0) trie[node][idx] = trieSize++;
            node = trie[node][idx];
        }
        wordAtNode[node] = word;
    }
    
    List<String> result = new ArrayList<>();
    int m = board.length, n = board[0].length;
    
    for (int i = 0; i < m; i++)
        for (int j = 0; j < n; j++)
            dfsTrie(board, i, j, m, n, 0, trie, wordAtNode, result);
    
    return result;
}

private void dfsTrie(char[][] board, int r, int c, int m, int n,
                      int node, int[][] trie, String[] wordAtNode, List<String> result) {
    if (r < 0 || r >= m || c < 0 || c >= n || board[r][c] == '#') return;
    
    char ch = board[r][c];
    int next = trie[node][ch - 'a'];
    if (next == 0) return;  // no trie path
    
    if (wordAtNode[next] != null) {
        result.add(wordAtNode[next]);
        wordAtNode[next] = null;  // avoid duplicates
    }
    
    board[r][c] = '#';  // mark visited
    dfsTrie(board, r+1, c, m, n, next, trie, wordAtNode, result);
    dfsTrie(board, r-1, c, m, n, next, trie, wordAtNode, result);
    dfsTrie(board, r, c+1, m, n, next, trie, wordAtNode, result);
    dfsTrie(board, r, c-1, m, n, next, trie, wordAtNode, result);
    board[r][c] = ch;  // backtrack
}
```

```
Time:  O(M × N × 4^L) where L = max word length, but Trie prunes aggressively
Space: O(W × L) for Trie where W = number of words
DFS with Trie prefix pruning. The Trie allows us to search all words
simultaneously, pruning branches that match no word prefix.
```

---

**P10.58** [H] — Alien Dictionary with Multiple Valid Orders (variation)

Return ALL possible valid orderings of the alien alphabet.

```java
public List<String> allAlienOrders(String[] words) {
    // Build graph (same as P10.22)
    Map<Character, Set<Character>> adj = new HashMap<>();
    Map<Character, Integer> inDegree = new HashMap<>();
    for (String word : words)
        for (char c : word.toCharArray()) {
            adj.putIfAbsent(c, new HashSet<>());
            inDegree.putIfAbsent(c, 0);
        }
    
    for (int i = 0; i < words.length - 1; i++) {
        String w1 = words[i], w2 = words[i + 1];
        for (int j = 0; j < Math.min(w1.length(), w2.length()); j++) {
            if (w1.charAt(j) != w2.charAt(j)) {
                if (adj.get(w1.charAt(j)).add(w2.charAt(j)))
                    inDegree.merge(w2.charAt(j), 1, Integer::sum);
                break;
            }
        }
    }
    
    // Backtracking topological sort (all valid orders)
    List<String> result = new ArrayList<>();
    StringBuilder current = new StringBuilder();
    backtrackTopo(adj, inDegree, current, result, inDegree.size());
    return result;
}

private void backtrackTopo(Map<Character, Set<Character>> adj,
                            Map<Character, Integer> inDegree,
                            StringBuilder current, List<String> result, int total) {
    if (current.length() == total) {
        result.add(current.toString());
        return;
    }
    
    for (char c : inDegree.keySet()) {
        if (inDegree.get(c) == 0 && current.indexOf(String.valueOf(c)) == -1) {
            // Pick this character next
            current.append(c);
            for (char next : adj.get(c)) inDegree.merge(next, -1, Integer::sum);
            
            backtrackTopo(adj, inDegree, current, result, total);
            
            current.deleteCharAt(current.length() - 1);
            for (char next : adj.get(c)) inDegree.merge(next, 1, Integer::sum);
        }
    }
}
```

```
Time:  O(U! × U) worst case — exponentially many valid orderings
Space: O(U) where U = unique characters
Backtracking over all valid topological orderings. At each step, any
in-degree-0 node can be chosen, giving multiple valid orders.
```

---

**P10.59** [H] — Minimum Cost to Make at Least One Valid Path in a Grid (LeetCode 1368)

```java
public int minCost(int[][] grid) {
    int m = grid.length, n = grid[0].length;
    int[][] dist = new int[m][n];
    for (int[] row : dist) Arrays.fill(row, Integer.MAX_VALUE);
    dist[0][0] = 0;
    
    // 0-1 BFS: following the arrow = cost 0, changing direction = cost 1
    Deque<int[]> deque = new ArrayDeque<>();
    deque.offerFirst(new int[]{0, 0});
    
    // Directions: 1=right, 2=left, 3=down, 4=up
    int[][] dirs = {{0,0},{0,1},{0,-1},{1,0},{-1,0}};  // 1-indexed
    
    while (!deque.isEmpty()) {
        int[] curr = deque.pollFirst();
        int r = curr[0], c = curr[1];
        
        for (int d = 1; d <= 4; d++) {
            int nr = r + dirs[d][0], nc = c + dirs[d][1];
            if (nr < 0 || nr >= m || nc < 0 || nc >= n) continue;
            
            int cost = (grid[r][c] == d) ? 0 : 1;
            if (dist[r][c] + cost < dist[nr][nc]) {
                dist[nr][nc] = dist[r][c] + cost;
                if (cost == 0) deque.offerFirst(new int[]{nr, nc});
                else deque.offerLast(new int[]{nr, nc});
            }
        }
    }
    return dist[m-1][n-1];
}
```

```
Time:  O(M × N)
Space: O(M × N)
Classic 0-1 BFS. Following the existing arrow is free (weight 0, addFirst).
Changing direction costs 1 (weight 1, addLast).
```

---

**P10.60** [H] — Graph Connectivity with Threshold (LeetCode 1627)

Cities i and j are connected if they share a common divisor > threshold.

```java
public List<Boolean> areConnected(int n, int threshold, int[][] queries) {
    int[] parent = new int[n + 1];
    int[] rank = new int[n + 1];
    for (int i = 0; i <= n; i++) parent[i] = i;
    
    // For each divisor z > threshold, union all multiples of z
    for (int z = threshold + 1; z <= n; z++) {
        for (int multiple = 2 * z; multiple <= n; multiple += z) {
            union(parent, rank, z, multiple);
        }
    }
    
    List<Boolean> result = new ArrayList<>();
    for (int[] q : queries) {
        result.add(find(parent, q[0]) == find(parent, q[1]));
    }
    return result;
}

private int find(int[] parent, int x) {
    if (parent[x] != x) parent[x] = find(parent, parent[x]);
    return parent[x];
}

private void union(int[] parent, int[] rank, int x, int y) {
    int rx = find(parent, x), ry = find(parent, y);
    if (rx == ry) return;
    if (rank[rx] < rank[ry]) parent[rx] = ry;
    else if (rank[rx] > rank[ry]) parent[ry] = rx;
    else { parent[ry] = rx; rank[rx]++; }
}
```

```
Time:  O(N log N × α(N) + Q × α(N)) — sieve-like iteration over divisors
Space: O(N)
Instead of checking all O(N²) pairs for common divisors, iterate divisors
from threshold+1 to N and union their multiples. This is a sieve pattern.
Total unions: N/2 + N/3 + ... + N/N ≈ N × ln(N) = O(N log N).
```

---

## Key Takeaways

1. **Representation is strategy.** Adjacency list for sparse graphs (O(V+E) memory, fast neighbor iteration), adjacency matrix for dense graphs (O(1) edge lookup, V^2 memory), edge list for edge-centric algorithms (Kruskal, Bellman-Ford). On the JVM, flatten 2D matrices to 1D arrays when cache performance matters -- Java's jagged arrays chase pointers.

2. **BFS for shortest unweighted path, always.** BFS explores level by level, guaranteeing the first time a node is reached is via the shortest path. Mark nodes visited when enqueuing, not when dequeuing, or pay with redundant queue entries. Multi-source BFS handles "nearest from any source" naturally.

3. **DFS is for structure, not distance.** Cycle detection (back edges), topological ordering (reverse post-order), articulation points and bridges (low-link values), connected components, and SCC algorithms all rely on DFS tree structure. Recursive DFS risks StackOverflowError at V > 10,000; use iterative DFS with ArrayDeque in production.

4. **Dijkstra is the shortest-path workhorse for non-negative weights.** Java's PriorityQueue lacks decrease-key, so use lazy deletion: if `d > dist[u]` when polled, skip. This keeps the implementation simple and is faster in practice than Fibonacci heaps despite worse theoretical complexity.

5. **Bellman-Ford handles negative edges; Floyd-Warshall handles all pairs.** Bellman-Ford's K-iteration variant solves "shortest path with at most K edges" directly. Floyd-Warshall's O(V^3) cost is acceptable for small V (< 500). Both detect negative cycles.

6. **Topological sort encodes dependency order.** Kahn's (BFS, in-degree) reveals parallelism and detects cycles. DFS-based (reverse post-order) is more natural for recursive problems. If Kahn's processes fewer than V nodes, the graph has a cycle.

7. **Union-Find answers connectivity in nearly O(1).** Path compression + union by rank makes find and union O(alpha(V)) -- effectively constant. Use it for Kruskal's MST, online connectivity queries, and any problem where you repeatedly ask "are these two in the same group?"

8. **SCC collapses directed cycles into single nodes.** Tarjan's uses one DFS pass. Kosaraju's uses two passes plus a graph reversal. The condensation graph (each SCC collapsed to one node) is always a DAG, enabling topological sort on the macro structure.

9. **State-space BFS expands the node definition.** When BFS on (row, col) is insufficient (e.g., remaining obstacle eliminations, keys held, last edge color), expand the state to include the relevant dimension. The state space grows multiplicatively, but BFS still guarantees shortest path.

10. **Every graph algorithm maps to real infrastructure.** BFS is GC mark phase and web crawlers. DFS is file system traversal and build dependency resolution. Dijkstra is OSPF routing. Bellman-Ford is BGP routing. Topological sort is npm/Gradle build order. MST is network cable layout. SCC is microservice dependency analysis and deadlock detection. Know the algorithm, and you understand the system.

---

[Previous: Chapter 9 -- Tries and Advanced String Structures](09-tries-and-advanced-string-structures.md) | [Next: Chapter 11 -- Dynamic Programming Patterns](11-dynamic-programming-patterns.md)
