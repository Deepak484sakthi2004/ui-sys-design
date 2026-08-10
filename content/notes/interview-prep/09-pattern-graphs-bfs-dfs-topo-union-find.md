# Chapter 9: Graphs — BFS, DFS, Topological Sort & Union-Find

> **Relearning log.** The recovery that unlocked graphs for me: **a 2D grid IS a graph** — each cell
> is a node with up-to-four edges. So many "matrix" problems (number of islands, rotting oranges,
> flood fill, shortest path in a maze) are just BFS/DFS in disguise, and I'd been treating them as a
> separate thing. Second recovery: the **BFS-gives-shortest-path-on-unweighted-graphs** guarantee —
> I kept reaching for Dijkstra when the edges were all weight 1 and BFS was the right, simpler tool.
> Third: **topological sort = "can I order these with dependencies / is there a cycle in a DAG"**,
> and **union-find = "are these two things in the same group / count connected components
> incrementally."** Naming those two triggers brought back a whole category.

---

## 9.1 Representations

```java
// Adjacency list (default for interviews). V nodes, E edges.
List<List<Integer>> g = new ArrayList<>();
for (int i = 0; i < n; i++) g.add(new ArrayList<>());
for (int[] e : edges) { g.get(e[0]).add(e[1]); g.get(e[1]).add(e[0]); }  // undirected

// Grid as implicit graph: neighbors via direction deltas.
int[][] DIRS = {{1,0},{-1,0},{0,1},{0,-1}};
```

Adjacency list is O(V+E) space and the right default. Adjacency matrix (O(V²)) only for dense graphs
or O(1) edge-existence checks.

---

## 9.2 BFS — shortest path on unweighted graphs

```java
// Shortest number of edges from src to every node. O(V+E).
int[] bfs(List<List<Integer>> g, int src) {
    int[] dist = new int[g.size()];
    Arrays.fill(dist, -1);
    Queue<Integer> q = new ArrayDeque<>();
    dist[src] = 0; q.offer(src);
    while (!q.isEmpty()) {
        int u = q.poll();
        for (int v : g.get(u)) if (dist[v] == -1) {   // first time seen = shortest
            dist[v] = dist[u] + 1;
            q.offer(v);
        }
    }
    return dist;
}
```

**Worked example — number of islands (grid BFS/DFS).** Scan cells; each unvisited land cell starts a
flood-fill that sinks its whole island.

```java
int numIslands(char[][] grid) {                  // O(m*n)
    int m = grid.length, n = grid[0].length, count = 0;
    for (int i = 0; i < m; i++)
        for (int j = 0; j < n; j++)
            if (grid[i][j] == '1') { count++; sink(grid, i, j); }
    return count;
}
void sink(char[][] g, int i, int j) {
    if (i < 0 || j < 0 || i >= g.length || j >= g[0].length || g[i][j] != '1') return;
    g[i][j] = '0';                                // mark visited in place
    sink(g, i+1, j); sink(g, i-1, j); sink(g, i, j+1); sink(g, i, j-1);
}
```

> **Multi-source BFS** (seed the queue with *all* sources at distance 0) solves "rotting oranges,"
> "walls and gates," "01 matrix" in one pass. Recognizing "spread from many starts simultaneously"
> → multi-source BFS is a high-value trigger.

---

## 9.3 DFS — connectivity, cycles, paths

DFS (recursive or explicit stack) for: connected components, cycle detection, path existence,
backtracking-style enumeration on graphs.

```java
// Cycle detection in a DIRECTED graph via 3-color DFS. O(V+E).
// 0=unvisited, 1=in-progress (on stack), 2=done.
boolean hasCycle(List<List<Integer>> g) {
    int[] color = new int[g.size()];
    for (int i = 0; i < g.size(); i++)
        if (color[i] == 0 && dfs(g, i, color)) return true;
    return false;
}
boolean dfs(List<List<Integer>> g, int u, int[] color) {
    color[u] = 1;                                 // entering
    for (int v : g.get(u)) {
        if (color[v] == 1) return true;           // back-edge to in-progress node → cycle
        if (color[v] == 0 && dfs(g, v, color)) return true;
    }
    color[u] = 2;                                 // leaving
    return false;
}
```

> Directed-cycle detection needs **three colors** (the "in-progress" state) — a plain visited set
> finds the wrong thing. For **undirected** cycle detection, track the parent (or use union-find).

---

## 9.4 Topological sort — ordering with dependencies

For DAGs: "course schedule," "build order," "alien dictionary." Kahn's algorithm (BFS on
in-degrees) doubles as cycle detection — if you can't output all V nodes, there's a cycle.

```java
// Returns a valid order, or empty list if there's a cycle. O(V+E).
int[] topoSort(int n, List<List<Integer>> g) {
    int[] indeg = new int[n];
    for (List<Integer> adj : g) for (int v : adj) indeg[v]++;
    Queue<Integer> q = new ArrayDeque<>();
    for (int i = 0; i < n; i++) if (indeg[i] == 0) q.offer(i);
    int[] order = new int[n]; int idx = 0;
    while (!q.isEmpty()) {
        int u = q.poll();
        order[idx++] = u;
        for (int v : g.get(u)) if (--indeg[v] == 0) q.offer(v);
    }
    return idx == n ? order : new int[0];         // idx<n ⇒ cycle
}
```

---

## 9.5 Union-Find (Disjoint Set Union)

For "are these connected?", "count components as edges arrive," "detect cycle in undirected graph,"
"Kruskal's MST," "accounts merge." With path compression + union by rank, operations are ~O(α(n)) —
effectively constant.

```java
class DSU {
    int[] parent, rank; int components;
    DSU(int n) {
        parent = new int[n]; rank = new int[n]; components = n;
        for (int i = 0; i < n; i++) parent[i] = i;
    }
    int find(int x) {                              // path compression
        while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    }
    boolean union(int a, int b) {                  // returns false if already joined
        int ra = find(a), rb = find(b);
        if (ra == rb) return false;
        if (rank[ra] < rank[rb]) { int t = ra; ra = rb; rb = t; }
        parent[rb] = ra;
        if (rank[ra] == rank[rb]) rank[ra]++;
        components--;
        return true;
    }
}
```

> **Trigger pairs to memorize:** "is there a cycle in an *undirected* graph / will adding this edge
> create one?" → union returns false → cycle. "Number of connected components after these edges" →
> DSU `components`. "Group accounts/emails/friends" → union-find.

---

## 9.6 Weighted shortest path (know it exists, sketch it)

- **Dijkstra** (non-negative weights): BFS with a **min-heap** keyed by distance — O((V+E) log V).
  Reach for it only when edges have *different* positive weights; unweighted → plain BFS.
- **Bellman-Ford** handles negative edges (and detects negative cycles) in O(VE).
- **0-1 BFS** (edges weight 0 or 1): a deque — push 0-edges front, 1-edges back. O(V+E).

```java
// Dijkstra skeleton. dist[] init to INF, dist[src]=0; pq holds (dist, node).
PriorityQueue<long[]> pq = new PriorityQueue<>((a, b) -> Long.compare(a[0], b[0]));
pq.offer(new long[]{0, src});
while (!pq.isEmpty()) {
    long[] top = pq.poll(); long d = top[0]; int u = (int) top[1];
    if (d > dist[u]) continue;                     // stale entry
    for (int[] e : adj.get(u)) {                   // e = {to, weight}
        long nd = d + e[1];
        if (nd < dist[e[0]]) { dist[e[0]] = nd; pq.offer(new long[]{nd, e[0]}); }
    }
}
```

---

## 9.7 Common pitfalls

- **Using Dijkstra when BFS suffices** (all edges weight 1) — slower and more bug-prone.
- **Marking visited at dequeue instead of enqueue in BFS** → a node enters the queue many times.
  Mark when you first *discover* it.
- **2-color visited for directed cycle detection** — need the third "in-progress" color.
- **Forgetting grids are graphs** — and forgetting to bound-check the four neighbors.
- **Stack overflow** on huge grids with recursive DFS — switch to an explicit stack or BFS.

## Interview Drills

- **D9.1 [E]** Number of islands; flood fill. *(Grid DFS/BFS.)*
- **D9.2 [E]** Clone a graph. *(BFS/DFS + hash map old→new.)*
- **D9.3 [M]** Course schedule I & II. *(Topological sort / cycle detection.)*
- **D9.4 [M]** Rotting oranges; walls and gates. *(Multi-source BFS.)*
- **D9.5 [M]** Number of connected components / redundant connection. *(Union-Find.)*
- **D9.6 [H]** Word ladder. *(BFS on word-graph; bidirectional BFS to optimize.)*
- **D9.7 [H]** Network delay time / cheapest flights within K stops. *(Dijkstra / Bellman-Ford.)*
- **D9.8 [H]** Alien dictionary. *(Build edges from adjacent words, then topo sort.)*

## Key Takeaways

1. **A grid is a graph;** most matrix problems are BFS/DFS with 4-directional neighbors.
2. **BFS = shortest path on unweighted graphs;** mark visited at discovery (enqueue), not dequeue.
3. **Multi-source BFS** (seed all sources at distance 0) solves spread/nearest problems in one pass.
4. **Directed cycle detection = 3-color DFS;** **topological order = Kahn's** (and it detects
   cycles).
5. **Union-Find** answers connectivity, component counts, and undirected-cycle detection in ~O(α).
6. **Dijkstra (min-heap) only for non-negative *weighted* edges;** know Bellman-Ford and 0-1 BFS
   exist.
