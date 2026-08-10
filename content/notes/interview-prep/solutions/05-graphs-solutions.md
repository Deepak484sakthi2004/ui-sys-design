# Worked Solutions 05 — Graphs: BFS, DFS, Topo Sort & Union-Find

> Home chapter: [Ch 9](../09-pattern-graphs-bfs-dfs-topo-union-find.md). Format: [solutions index](00-solutions-index.md).
> Graph bugs cluster around *when you mark visited* and *which "visited" semantics you need* (a plain
> set vs. the 3-color on-the-path distinction). Getting these right — and explaining why — is pure
> systems-thinking signal.

---

## P1 — Number of Islands `[M]`

**PROBLEM.** Count connected groups of `'1'` (land) in a grid (4-directional).

**RECOGNITION.** Grid = implicit graph; each unvisited land cell starts a flood-fill (DFS/BFS) that
sinks its whole island.

**THOUGHT.** "Scan cells; on each `'1'`, increment the count and sink the connected component so it's
not recounted. The flood-fill must mark a cell visited **before** recursing into neighbors, or the
recursion bounces back into it forever."

**BUGGY ATTEMPT.**
```java
int numIslands(char[][] grid) {
    int count = 0;
    for (int i = 0; i < grid.length; i++)
        for (int j = 0; j < grid[0].length; j++)
            if (grid[i][j] == '1') { count++; sink(grid, i, j); }
    return count;
}
void sink(char[][] g, int i, int j) {
    if (i < 0 || j < 0 || i >= g.length || j >= g[0].length || g[i][j] != '1') return;
    sink(g, i + 1, j); sink(g, i - 1, j); sink(g, i, j + 1); sink(g, i, j - 1);
    g[i][j] = '0';                                  // <-- the bug: marked AFTER recursing
}
```

**SPOT THE BUG.** The cell is set to `'0'` **after** the four recursive calls, so neighbor A recurses
into B while B is still `'1'`, and B immediately recurses back into A (still `'1'`) → **infinite
recursion → StackOverflowError**. Failing input: any two adjacent land cells, e.g. `[['1','1']]`.
**Fix: mark `g[i][j] = '0'` *before* the recursive calls.**

**CLEAN.**
```java
int numIslands(char[][] grid) {                    // O(m*n) time, O(m*n) worst-case stack
    int count = 0;
    for (int i = 0; i < grid.length; i++)
        for (int j = 0; j < grid[0].length; j++)
            if (grid[i][j] == '1') { count++; sink(grid, i, j); }
    return count;
}
void sink(char[][] g, int i, int j) {
    if (i < 0 || j < 0 || i >= g.length || j >= g[0].length || g[i][j] != '1') return;
    g[i][j] = '0';                                  // mark visited FIRST — the fix
    sink(g, i + 1, j); sink(g, i - 1, j);
    sink(g, i, j + 1); sink(g, i, j - 1);
}
```

**EDGE CASES.** Empty grid; all water (0 islands); all land (1 island); single cell; a diagonal "island"
(diagonal cells are *not* connected with 4-directional → counted separately).

**COMPLEXITY.** O(m·n) — each cell visited once. Stack depth up to O(m·n) for one giant island → on
huge grids switch to **iterative BFS/DFS** to avoid stack overflow (mention this).

**DRY RUN.** `[['1','1','0'],['0','1','0'],['0','0','1']]` → first `'1'` sinks the connected L-shape (3
cells), then the lone `'1'` at bottom-right → **2**. ✓

**FOLLOW-UPS.** *Max island area?* → flood-fill returns its size. *Number of distinct island shapes?* →
canonicalize each shape (relative coordinates) into a set. *Don't mutate input?* → separate `visited`
boolean grid.

---

## P2 — Course Schedule (can all courses finish?) `[M]`

**PROBLEM.** `numCourses` and prerequisite pairs; return whether you can complete all (i.e., the
directed graph is acyclic).

**RECOGNITION.** "Ordering with prerequisites / detect a cycle in a directed graph" → **3-color DFS**
or **Kahn's topological sort**.

**THOUGHT.** "A directed cycle means impossible. The subtlety: a plain visited set can't distinguish
'currently on my recursion path' (a back-edge → real cycle) from 'finished long ago via another path'
(a cross-edge → fine). That distinction needs three states."

**BUGGY ATTEMPT.**
```java
boolean canFinish(int n, int[][] prereqs) {
    List<List<Integer>> g = build(n, prereqs);
    boolean[] visited = new boolean[n];             // <-- the bug: only TWO states
    for (int i = 0; i < n; i++)
        if (!visited[i] && hasCycle(g, i, visited)) return false;
    return true;
}
boolean hasCycle(List<List<Integer>> g, int u, boolean[] visited) {
    if (visited[u]) return true;                     // treats ANY revisit as a cycle
    visited[u] = true;
    for (int v : g.get(u)) if (hasCycle(g, v, visited)) return true;
    return false;
}
```

**SPOT THE BUG.** A single boolean `visited` flags *any* revisit as a cycle, but revisiting a node
already **fully processed via a different path** is not a cycle. Failing input (a diamond DAG, no
cycle): `n=4`, edges `0→1, 0→2, 1→3, 2→3`.
- DFS from 0: visit 0, 1, 3 (mark all). Back up, visit 2, then 2→3: `visited[3]` is true → returns
  "cycle" → `canFinish` returns **false**, but this graph is acyclic (3 just has two parents). **Fix:
  three colors** — 0=unvisited, 1=in-progress (on the current path), 2=done. Only a `1` (in-progress)
  revisit is a back-edge → real cycle.

**CLEAN.**
```java
boolean canFinish(int n, int[][] prereqs) {        // O(V + E) time, O(V + E) space
    List<List<Integer>> g = build(n, prereqs);
    int[] color = new int[n];                       // 0=unvisited, 1=in-progress, 2=done
    for (int i = 0; i < n; i++)
        if (color[i] == 0 && hasCycle(g, i, color)) return false;
    return true;
}
boolean hasCycle(List<List<Integer>> g, int u, int[] color) {
    color[u] = 1;                                   // entering the path
    for (int v : g.get(u)) {
        if (color[v] == 1) return true;             // back-edge to a node ON the path → cycle
        if (color[v] == 0 && hasCycle(g, v, color)) return true;  // only recurse into unvisited
    }
    color[u] = 2;                                   // leaving: fully processed (NOT a cycle source)
    return false;
}
List<List<Integer>> build(int n, int[][] prereqs) {
    List<List<Integer>> g = new ArrayList<>();
    for (int i = 0; i < n; i++) g.add(new ArrayList<>());
    for (int[] p : prereqs) g.get(p[1]).add(p[0]);  // p = [course, prereq] → edge prereq→course
    return g;
}
```

**EDGE CASES.** No prerequisites (trivially finishable); a self-loop `0→0` (immediate cycle); the
diamond DAG (the case the 2-color bug breaks); disconnected components (loop over all start nodes);
a long cycle `0→1→2→0`.

**COMPLEXITY.** O(V + E) time and space.

**DRY RUN.** Diamond DAG with 3-color: from 0 → 1 → 3 (color 3 = 2/done); back to 0 → 2 → 3: `color[3]`
is **2** (done), not 1 → not a cycle → `canFinish` true. ✓

**FOLLOW-UPS.** *Return an actual order (Course Schedule II)?* → Kahn's algorithm (BFS on in-degrees);
if you can't emit all `n` nodes, there's a cycle. *Alien dictionary?* → build edges from adjacent
words, then topo sort.

---

## P3 — Clone Graph `[M]`

**PROBLEM.** Deep-copy a connected undirected graph (each node has a value and a neighbor list).

**RECOGNITION.** Traversal (DFS/BFS) + a **map from original node → its clone** to handle cycles and
shared neighbors.

**THOUGHT.** "Without memoization, cloning a node re-clones its neighbors, which re-clone *it* — the
cycle never terminates. The visited map both prevents infinite recursion and ensures each node is
cloned exactly once (preserving shared references)."

**BUGGY ATTEMPT.**
```java
Node cloneGraph(Node node) {
    if (node == null) return null;
    Node copy = new Node(node.val);
    for (Node nb : node.neighbors)
        copy.neighbors.add(cloneGraph(nb));         // <-- the bug: no memo → infinite recursion
    return copy;
}
```

**SPOT THE BUG.** No map of already-cloned nodes, so on any cycle (and undirected edges are inherently
2-cycles: A↔B), cloning A clones B, which clones A, which clones B… → **infinite recursion**. Failing
input: two connected nodes `1 — 2` (each lists the other) → stack overflow. **Fix: memoize with a
`Map<Node, Node>`; return the existing clone on revisit.**

**CLEAN.**
```java
Node cloneGraph(Node node) {                        // O(V + E) time, O(V) space
    return dfs(node, new HashMap<>());
}
Node dfs(Node node, Map<Node, Node> clones) {
    if (node == null) return null;
    if (clones.containsKey(node)) return clones.get(node);   // already cloned — the fix (and cycle guard)
    Node copy = new Node(node.val);
    clones.put(node, copy);                          // register BEFORE recursing into neighbors
    for (Node nb : node.neighbors)
        copy.neighbors.add(dfs(nb, clones));
    return copy;
}
```

**The ordering subtlety.** `clones.put(node, copy)` must happen **before** recursing into neighbors;
otherwise a neighbor that points back to `node` won't find the registered clone and the cycle guard
fails. (Same "register before you recurse" lesson as marking-visited-first in P1.)

**EDGE CASES.** `null` input; single node with no neighbors; a self-loop; a node with a duplicate
neighbor; a fully connected triangle (shared clones must be reused, not re-created).

**COMPLEXITY.** O(V + E) — each node and edge processed once. O(V) for the map.

**DRY RUN.** `1 — 2`: dfs(1): put{1:1'}, neighbor 2 → dfs(2): put{1:1',2:2'}, neighbor 1 → in map →
return 1'. So 2'.neighbors=[1'], back to 1': neighbors=[2']. Cycle handled, two clones. ✓

**FOLLOW-UPS.** *Iterative version?* → BFS with the same map. *Deep-copy a linked list with random
pointers?* → same node→clone map idea.

---

## P4 — Rotting Oranges (multi-source BFS) `[M]`

**PROBLEM.** Grid of 0 (empty), 1 (fresh), 2 (rotten). Each minute, rotten oranges rot
4-directionally-adjacent fresh ones. Return minutes until none are fresh, or −1 if impossible.

**RECOGNITION.** "Spread simultaneously from many sources, minimal time" → **multi-source BFS**: seed
the queue with *all* rotten oranges at time 0, expand level by level.

**THOUGHT.** "Enqueue every initial rotten orange. BFS one *level* (minute) at a time using the
`q.size()` snapshot. Count fresh oranges; decrement as they rot; if any remain at the end, return −1.
The off-by-one: minutes = number of *levels after the first*, so don't count the initial level."

**BUGGY ATTEMPT.**
```java
int orangesRotting(int[][] g) {
    Queue<int[]> q = new ArrayDeque<>();
    int fresh = 0, minutes = 0;
    for (int i = 0; i < g.length; i++)
        for (int j = 0; j < g[0].length; j++) {
            if (g[i][j] == 2) q.offer(new int[]{i, j});
            else if (g[i][j] == 1) fresh++;
        }
    int[][] dirs = {{1,0},{-1,0},{0,1},{0,-1}};
    while (!q.isEmpty()) {
        int[] cell = q.poll();
        minutes++;                                   // <-- the bug: increment per ORANGE, per level?
        for (int[] d : dirs) {
            int x = cell[0] + d[0], y = cell[1] + d[1];
            if (x >= 0 && y >= 0 && x < g.length && y < g[0].length && g[x][y] == 1) {
                g[x][y] = 2; fresh--; q.offer(new int[]{x, y});
            }
        }
    }
    return fresh == 0 ? minutes : -1;
}
```

**SPOT THE BUG.** `minutes++` runs **once per orange dequeued**, not once per BFS *level*, so it counts
total oranges processed, not elapsed minutes. Failing input: `[[2,1,1],[1,1,1],[0,1,1]]` — true answer
is **4** minutes, but the bug increments for every one of the ~8 oranges → returns 8. **Fix: process
one full level per minute using `int sz = q.size()`, and increment `minutes` once per level (after the
initial level).**

**CLEAN.**
```java
int orangesRotting(int[][] g) {                    // O(m*n) time, O(m*n) space
    Queue<int[]> q = new ArrayDeque<>();
    int fresh = 0, minutes = 0;
    for (int i = 0; i < g.length; i++)
        for (int j = 0; j < g[0].length; j++) {
            if (g[i][j] == 2) q.offer(new int[]{i, j});
            else if (g[i][j] == 1) fresh++;
        }
    if (fresh == 0) return 0;                        // nothing to rot → 0 minutes
    int[][] dirs = {{1,0},{-1,0},{0,1},{0,-1}};
    while (!q.isEmpty() && fresh > 0) {
        int sz = q.size();                           // one minute = one full level — the fix
        for (int k = 0; k < sz; k++) {
            int[] cell = q.poll();
            for (int[] d : dirs) {
                int x = cell[0] + d[0], y = cell[1] + d[1];
                if (x >= 0 && y >= 0 && x < g.length && y < g[0].length && g[x][y] == 1) {
                    g[x][y] = 2; fresh--; q.offer(new int[]{x, y});
                }
            }
        }
        minutes++;                                   // one increment per level
    }
    return fresh == 0 ? minutes : -1;                // leftover fresh = unreachable → -1
}
```

**EDGE CASES.** No fresh oranges → 0 (the early return); a fresh orange with no adjacent rotten ever →
−1; all rotten already; isolated fresh behind walls of 0s → −1; single cell.

**COMPLEXITY.** O(m·n) time and space.

**DRY RUN.** `[[2,1,1],[1,1,1],[0,1,1]]`: level by level the rot spreads; the farthest fresh orange
(bottom-right) rots at minute 4 → returns 4. ✓

**FOLLOW-UPS.** *Walls and gates / 01-matrix?* → same multi-source BFS (seed all gates / all 0s).
*Why multi-source instead of BFS from each source?* → simultaneous spread; one BFS gives the min time
across all sources in O(m·n) instead of O(sources × m·n).

---

## P5 — Redundant Connection (union-find) `[M]`

**PROBLEM.** A tree had one extra edge added (n nodes, n edges). Return the edge that, if removed,
restores a tree (the one closing a cycle; if multiple, the last in input).

**RECOGNITION.** "Adding edges; which one first creates a cycle in an undirected graph?" → **union-find**;
the edge whose two endpoints are *already connected* is the redundant one.

**THOUGHT.** "Process edges; for each `(a,b)`, if `find(a) == find(b)` they're already in the same
component → this edge closes a cycle → return it. Otherwise union them. The critical part: compare
**roots** via `find`, not raw parent pointers."

**BUGGY ATTEMPT.**
```java
int[] findRedundantConnection(int[][] edges) {
    int n = edges.length;
    int[] parent = new int[n + 1];
    for (int i = 1; i <= n; i++) parent[i] = i;
    for (int[] e : edges) {
        if (parent[e[0]] == parent[e[1]]) return e;   // <-- the bug: compares parents, not roots
        parent[e[0]] = e[1];                           // and a naive union
    }
    return new int[0];
}
```

**SPOT THE BUG.** Comparing `parent[a] == parent[b]` only checks *immediate* parents, missing
**transitive** connectivity, so it fails to detect a cycle that closes across several unions. Failing
input: `edges = [[1,2],[2,3],[3,1]]`.
- `[1,2]`: parent[1]==parent[2]? 1==2 no → parent[1]=2.
- `[2,3]`: parent[2]==parent[3]? 2==3 no → parent[2]=3.
- `[3,1]`: parent[3]==parent[1]? 3==2 no → misses the cycle, returns `[]`. But 1-2-3-1 is a cycle and
  `[3,1]` is the redundant edge. **Fix: use `find` (with path compression) to compare component
  roots, and union by root.**

**CLEAN.**
```java
int[] findRedundantConnection(int[][] edges) {     // O(n α(n)) ≈ O(n)
    int n = edges.length;
    int[] parent = new int[n + 1];
    for (int i = 1; i <= n; i++) parent[i] = i;
    for (int[] e : edges) {
        if (find(parent, e[0]) == find(parent, e[1])) return e;  // same root → cycle — the fix
        parent[find(parent, e[0])] = find(parent, e[1]);          // union by root
    }
    return new int[0];
}
int find(int[] parent, int x) {
    while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; }  // path compression
    return x;
}
```

**EDGE CASES.** The cycle closes on the first vs. last edge; a self-loop edge `[1,1]`; the "multiple
candidates, return the last" rule (handled naturally by processing in order); large n (path compression
keeps it near-linear).

**COMPLEXITY.** O(n·α(n)) ≈ O(n) with path compression. O(n) space.

**DRY RUN.** `[[1,2],[2,3],[3,1]]`: union(1,2) roots 1,2 differ → parent[1]=2; union(2,3) roots 2,3 →
parent[2]=3; check(3,1): find(3)=3, find(1)= parent[1]=2→find(2)=3 → both root 3 → equal → return
`[3,1]`. ✓

**FOLLOW-UPS.** *Number of connected components?* → init `components = n`, decrement on each successful
union. *Accounts merge / friend circles?* → same union-find. *Detect cycle in a **directed** graph?* →
NOT union-find — use 3-color DFS (P2).

---

## P6 — Word Ladder (BFS shortest transformation) `[H]`

**PROBLEM.** Shortest transformation sequence length from `beginWord` to `endWord`, changing one letter
at a time, each intermediate in `wordList` (0 if impossible). Length counts both endpoints.

**RECOGNITION.** "Shortest path on an unweighted graph" (words = nodes, edge = differ by one letter) →
**BFS**, with the crucial discipline of **marking visited at enqueue**.

**THOUGHT.** "BFS level by level; the level number is the sequence length. Generate neighbors by
changing each position to every letter. Mark a word visited the moment I enqueue it — not when I
dequeue it."

**BUGGY ATTEMPT.**
```java
int ladderLength(String begin, String end, List<String> wordList) {
    Set<String> dict = new HashSet<>(wordList);
    if (!dict.contains(end)) return 0;
    Set<String> visited = new HashSet<>();
    Queue<String> q = new ArrayDeque<>();
    q.offer(begin);
    int level = 1;
    while (!q.isEmpty()) {
        int sz = q.size();
        for (int i = 0; i < sz; i++) {
            String w = q.poll();
            visited.add(w);                          // <-- the bug: mark on DEQUEUE
            if (w.equals(end)) return level;
            for (String nb : neighbors(w, dict))
                if (!visited.contains(nb)) q.offer(nb);   // same word enqueued many times
        }
        level++;
    }
    return 0;
}
```

**SPOT THE BUG.** Marking visited at **dequeue** lets the *same* word be enqueued many times before it's
ever dequeued (every neighbor that reaches it in the same level re-adds it). The shortest *distance*
still comes out right, but the queue can grow **exponentially** → TLE / memory blow-up on a large
dictionary. (On constrained inputs it "works"; on the real test set it times out — the exact trap
interviewers watch for.) **Fix: add to `visited` at the moment you *enqueue*, so each word enters the
queue exactly once.**

**CLEAN.**
```java
int ladderLength(String begin, String end, List<String> wordList) {   // O(N * L^2 * 26) worst
    Set<String> dict = new HashSet<>(wordList);
    if (!dict.contains(end)) return 0;
    Set<String> visited = new HashSet<>();
    Queue<String> q = new ArrayDeque<>();
    q.offer(begin); visited.add(begin);              // mark begin immediately
    int level = 1;
    while (!q.isEmpty()) {
        int sz = q.size();
        for (int i = 0; i < sz; i++) {
            String w = q.poll();
            if (w.equals(end)) return level;
            char[] arr = w.toCharArray();
            for (int j = 0; j < arr.length; j++) {
                char old = arr[j];
                for (char c = 'a'; c <= 'z'; c++) {
                    arr[j] = c;
                    String nb = new String(arr);
                    if (dict.contains(nb) && visited.add(nb))  // add returns false if already present
                        q.offer(nb);                  // enqueue exactly once — the fix
                }
                arr[j] = old;
            }
        }
        level++;
    }
    return 0;
}
```

**The `visited.add(nb)` idiom.** `Set.add` returns `false` if the element was already present, so
`if (visited.add(nb)) q.offer(nb)` atomically "marks and enqueues only if new" — the clean way to
enforce enqueue-once.

**EDGE CASES.** `endWord` not in dictionary → 0; `beginWord == endWord` (clarify — usually begin isn't
required to be in dict); no path → 0; single-letter words; large dictionaries (where the bug's blow-up
shows).

**COMPLEXITY.** O(N · L² · 26) in the worst case (N words, length L) — for each word, L positions × 26
letters, each new-string build O(L). O(N·L) space.

**DRY RUN.** `begin="hit", end="cog", dict=[hot,dot,dog,lot,log,cog]`: hit→hot(2)→dot/lot(3)→dog/log(4)
→cog(5) → returns **5**. ✓

**FOLLOW-UPS.** *Speed up?* → **bidirectional BFS** from both ends meets in the middle (~halves the
explored frontier). *Wildcard preprocessing* (`h*t → [hot,hit]`) avoids the 26-scan. *Return the actual
path (Word Ladder II)?* → BFS to build a parent DAG, then DFS the paths.

---

## Debugging Dojo

One planted bug each. Find the failing input, explain, fix.

**Dojo-1 — BFS shortest distance in an unweighted adjacency-list graph**
```java
int[] bfs(List<List<Integer>> g, int src) {
    int n = g.size();
    int[] dist = new int[n];
    Arrays.fill(dist, -1);
    Queue<Integer> q = new ArrayDeque<>();
    q.offer(src); dist[src] = 0;
    while (!q.isEmpty()) {
        int u = q.poll();
        for (int v : g.get(u)) {
            dist[v] = dist[u] + 1;           // think: do we check if v was seen?
            q.offer(v);
        }
    }
    return dist;
}
```

**Dojo-2 — count connected components with union-find**
```java
int countComponents(int n, int[][] edges) {
    int[] parent = new int[n];
    for (int i = 0; i < n; i++) parent[i] = i;
    int components = n;
    for (int[] e : edges) {
        int ra = find(parent, e[0]), rb = find(parent, e[1]);
        parent[ra] = rb;
        components--;                        // think: always decrement?
    }
    return components;
}
```

**Dojo-3 — flood fill (change all connected cells of the start color to newColor)**
```java
void floodFill(int[][] image, int sr, int sc, int newColor) {
    fill(image, sr, sc, image[sr][sc], newColor);
}
void fill(int[][] im, int r, int c, int oldColor, int newColor) {
    if (r < 0 || c < 0 || r >= im.length || c >= im[0].length || im[r][c] != oldColor) return;
    im[r][c] = newColor;
    fill(im, r+1, c, oldColor, newColor); fill(im, r-1, c, oldColor, newColor);
    fill(im, r, c+1, oldColor, newColor); fill(im, r, c-1, oldColor, newColor);
}
```

---

### Dojo answers

**Dojo-1.** No "already visited" check — `dist[v]` is overwritten every time `v` is reached, and `v` is
re-enqueued endlessly → **infinite loop** (and wrong distances). Failing input: any graph with a cycle
or a node with two parents. **Fix: only process unseen nodes — `if (dist[v] == -1) { dist[v] =
dist[u] + 1; q.offer(v); }`** (mark/queue at discovery). (Bug-class 4: visited-check missing.)

**Dojo-2.** It decrements `components` for **every** edge, even one connecting two already-joined nodes
(which doesn't reduce the component count). Failing input: `n=3, edges=[[0,1],[1,2],[0,2]]` → true
components = 1, but it decrements 3 times from 3 → **0** (nonsense). **Fix: only `components--` when
`ra != rb` (a real merge): `if (ra != rb) { parent[ra] = rb; components--; }`.** (Bug-class 4: state
updated unconditionally.)

**Dojo-3.** If the start cell's color **already equals** `newColor`, then `oldColor == newColor` and the
first `im[r][c] = newColor` doesn't change anything, so the `im[r][c] != oldColor` guard never stops the
recursion → **infinite recursion**. Failing input: `image=[[0,0],[0,0]], sr=0, sc=0, newColor=0`.
**Fix: early-return if `oldColor == newColor` (nothing to do), i.e. `if (image[sr][sc] == newColor)
return;` at the top.** (Bug-class 1/5: missing the no-op guard.)

---

## Key Takeaways

1. **Mark visited *before* you recurse / at *enqueue*, not after / at dequeue** — the difference between
   correct-and-fast and stack-overflow / exponential blow-up (Islands, BFS, Word Ladder).
2. **Directed cycle detection needs 3 colors** (in-progress vs done); a 2-color set raises false cycles
   on DAGs with shared descendants (Course Schedule).
3. **Cloning / BFS with cycles requires a visited map, registered before recursing** (Clone Graph).
4. **Multi-source BFS: seed all sources, advance one *level* per step** with `q.size()`; increment time
   per level, not per node (Rotting Oranges).
5. **Union-find compares *roots* via `find`, not raw parents,** and only counts a merge / cycle when
   roots differ (Redundant Connection, components).
6. **Run the bug-class checklist**: visited-timing, the no-op/self guard, and "is this O(V+E) or did I
   accidentally make it exponential?"
