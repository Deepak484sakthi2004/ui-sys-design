import type { DiagramNode, DiagramEdge, NodeSide } from "@/lib/types";

// ---------------------------------------------------------------------------
// Obstacle-avoiding orthogonal edge router for the system diagram.
//
// Nodes live on a (col,row) grid. Every routed segment rides a "lane line" that
// sits dead-center in the gutter between columns/rows (or in the outer margin),
// which is provably clear of every node box — so no arrow can ever cross a box
// it does not belong to. Pure, deterministic, SSR-safe (no DOM measurement).
// Shared by SystemDiagram.tsx and the geometry checker script.
// ---------------------------------------------------------------------------

export const NODE_W = 178;
export const NODE_H = 96;
export const COL_W = 284; // wider gutters so edge labels fit between adjacent boxes
export const ROW_H = 158;
export const PAD = 8;
// Breathing room around the whole grid so perimeter lanes AND the edge labels
// centered on them are never clipped (labels on the left/right margins are the
// worst offenders). Everything shifts by (MARGIN_X, MARGIN_Y).
const MARGIN_X = 132;
const MARGIN_Y = 32;
const MARGIN_R = 132;
const MARGIN_B = 32;

const TURN_PENALTY = 40;
const LANE_STEP = 8;
const ANCHOR_STEP = 14;

export interface Pt {
  x: number;
  y: number;
}
export interface RoutedEdge {
  points: Pt[];
  svgPath: string;
  labelAt: Pt;
}

// --- geometry ---------------------------------------------------------------
export function nodeBox(n: DiagramNode) {
  const left = MARGIN_X + (n.col - 1) * COL_W + (COL_W - NODE_W) / 2 + PAD;
  const top = MARGIN_Y + (n.row - 1) * ROW_H + (ROW_H - NODE_H) / 2 + PAD;
  return {
    left,
    top,
    right: left + NODE_W,
    bottom: top + NODE_H,
    cx: left + NODE_W / 2,
    cy: top + NODE_H / 2,
  };
}

const laneX = (g: number) => MARGIN_X + COL_W * g + PAD;
const laneY = (g: number) => MARGIN_Y + ROW_H * g + PAD;

export function canvasSize(nodes: DiagramNode[]) {
  const maxCol = Math.max(...nodes.map((n) => n.col));
  const maxRow = Math.max(...nodes.map((n) => n.row));
  return {
    maxCol,
    maxRow,
    width: MARGIN_X + maxCol * COL_W + PAD + MARGIN_R,
    height: MARGIN_Y + maxRow * ROW_H + PAD + MARGIN_B,
  };
}

// --- small helpers ----------------------------------------------------------
const dist = (a: Pt, b: Pt) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const dirOf = (a: Pt, b: Pt): "H" | "V" =>
  Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? "H" : "V";

type Cell = { c: number; r: number };
function cellKey(c: number, r: number) {
  return `${c},${r}`;
}

function facingSides(dc: number, dr: number): NodeSide[] {
  const h: NodeSide[] = dc > 0 ? ["E"] : dc < 0 ? ["W"] : [];
  const v: NodeSide[] = dr > 0 ? ["S"] : dr < 0 ? ["N"] : [];
  return Math.abs(dc) >= Math.abs(dr) ? [...h, ...v] : [...v, ...h];
}

function neighborCell(n: DiagramNode, side: NodeSide): Cell {
  if (side === "N") return { c: n.col, r: n.row - 1 };
  if (side === "S") return { c: n.col, r: n.row + 1 };
  if (side === "E") return { c: n.col + 1, r: n.row };
  return { c: n.col - 1, r: n.row };
}

function clearSide(
  n: DiagramNode,
  side: NodeSide,
  occ: Set<string>,
  maxCol: number,
  maxRow: number,
): boolean {
  const { c, r } = neighborCell(n, side);
  if (c < 1 || c > maxCol || r < 1 || r > maxRow) return true; // off-grid = open margin
  return !occ.has(cellKey(c, r));
}

function chooseExit(
  F: DiagramNode,
  T: DiagramNode,
  occ: Set<string>,
  maxCol: number,
  maxRow: number,
): NodeSide {
  for (const s of facingSides(T.col - F.col, T.row - F.row))
    if (clearSide(F, s, occ, maxCol, maxRow)) return s;
  for (const s of ["E", "S", "W", "N"] as NodeSide[])
    if (clearSide(F, s, occ, maxCol, maxRow)) return s;
  return "E";
}

function chooseEntry(
  F: DiagramNode,
  T: DiagramNode,
  occ: Set<string>,
  maxCol: number,
  maxRow: number,
): NodeSide {
  const cands = facingSides(F.col - T.col, F.row - T.row);
  const primary = cands[0] ?? "W";
  if (clearSide(T, primary, occ, maxCol, maxRow)) return primary;
  // primary shadowed by a stacked neighbour → escape to an open perimeter side
  if (T.col === maxCol && clearSide(T, "E", occ, maxCol, maxRow)) return "E";
  if (T.col === 1 && clearSide(T, "W", occ, maxCol, maxRow)) return "W";
  if (T.row === maxRow && clearSide(T, "S", occ, maxCol, maxRow)) return "S";
  if (T.row === 1 && clearSide(T, "N", occ, maxCol, maxRow)) return "N";
  for (const s of [...cands.slice(1), "E", "S", "W", "N"] as NodeSide[])
    if (clearSide(T, s, occ, maxCol, maxRow)) return s;
  return primary;
}

interface Port {
  anchor: Pt;
  landing: Pt;
  brackets: Cell[];
}
function port(n: DiagramNode, side: NodeSide): Port {
  const b = nodeBox(n);
  const c = n.col;
  const r = n.row;
  if (side === "E")
    return {
      anchor: { x: b.right, y: b.cy },
      landing: { x: laneX(c), y: b.cy },
      brackets: [{ c, r: r - 1 }, { c, r }],
    };
  if (side === "W")
    return {
      anchor: { x: b.left, y: b.cy },
      landing: { x: laneX(c - 1), y: b.cy },
      brackets: [{ c: c - 1, r: r - 1 }, { c: c - 1, r }],
    };
  if (side === "S")
    return {
      anchor: { x: b.cx, y: b.bottom },
      landing: { x: b.cx, y: laneY(r) },
      brackets: [{ c: c - 1, r }, { c, r }],
    };
  return {
    anchor: { x: b.cx, y: b.top },
    landing: { x: b.cx, y: laneY(r - 1) },
    brackets: [{ c: c - 1, r: r - 1 }, { c, r: r - 1 }],
  };
}

// --- A* over the lane-intersection grid (all lanes are obstacle-free) --------
interface AState {
  vk: string;
  dir: "H" | "V" | null;
  g: number;
  pt: Pt;
  parent: AState | null;
}

function astar(
  startPt: Pt,
  startBr: Cell[],
  goalPt: Pt,
  goalBr: Cell[],
  maxCol: number,
  maxRow: number,
): Pt[] {
  const ipt = (i: number, j: number): Pt => ({ x: laneX(i), y: laneY(j) });
  const inBounds = (i: number, j: number) =>
    i >= 0 && i <= maxCol && j >= 0 && j <= maxRow;
  const goalSet = new Set(goalBr.map((b) => cellKey(b.c, b.r)));

  const start: AState = { vk: "S", dir: null, g: 0, pt: startPt, parent: null };
  const open: AState[] = [start];
  const best = new Map<string, number>();
  const h = (p: Pt) => dist(p, goalPt);
  const stateKey = (vk: string, dir: string | null) => `${vk}|${dir}`;

  while (open.length) {
    // pop min by (f, g, vk) — total order → deterministic
    let bi = 0;
    for (let k = 1; k < open.length; k++) {
      const a = open[k];
      const b = open[bi];
      const fa = a.g + h(a.pt);
      const fb = b.g + h(b.pt);
      if (fa < fb || (fa === fb && a.g < b.g) || (fa === fb && a.g === b.g && a.vk < b.vk))
        bi = k;
    }
    const cur = open.splice(bi, 1)[0];
    if (cur.vk === "G") {
      const pts: Pt[] = [];
      let s: AState | null = cur;
      while (s) {
        pts.push(s.pt);
        s = s.parent;
      }
      return pts.reverse();
    }
    const sk = stateKey(cur.vk, cur.dir);
    if (best.has(sk) && (best.get(sk) as number) <= cur.g) continue;
    best.set(sk, cur.g);

    const neigh: { vk: string; pt: Pt }[] = [];
    if (cur.vk === "S") {
      for (const b of startBr)
        if (inBounds(b.c, b.r))
          neigh.push({ vk: cellKey(b.c, b.r), pt: ipt(b.c, b.r) });
    } else {
      const [i, j] = cur.vk.split(",").map(Number);
      const cand = [
        [i + 1, j],
        [i, j + 1],
        [i - 1, j],
        [i, j - 1],
      ];
      for (const [ni, nj] of cand)
        if (inBounds(ni, nj)) neigh.push({ vk: cellKey(ni, nj), pt: ipt(ni, nj) });
      if (goalSet.has(cur.vk)) neigh.push({ vk: "G", pt: goalPt });
    }
    for (const nb of neigh) {
      const dir = dirOf(cur.pt, nb.pt);
      const turn = cur.dir && dir !== cur.dir ? TURN_PENALTY : 0;
      open.push({
        vk: nb.vk,
        dir,
        g: cur.g + dist(cur.pt, nb.pt) + turn,
        pt: nb.pt,
        parent: cur,
      });
    }
  }
  return [startPt, goalPt]; // fallback (should not happen on a connected grid)
}

// --- polyline utilities -----------------------------------------------------
function mergeColinear(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const colinear =
        (a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y);
      const dup = b.x === p.x && b.y === p.y;
      if (colinear || dup) {
        out[out.length - 1] = p;
        continue;
      }
    } else if (out.length === 1 && out[0].x === p.x && out[0].y === p.y) {
      continue;
    }
    out.push(p);
  }
  return out;
}

function toPath(pts: Pt[]): string {
  return pts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${round(p.x)} ${round(p.y)}`)
    .join(" ");
}
const round = (n: number) => Math.round(n * 10) / 10;

function labelAnchor(pts: Pt[]): Pt {
  const segs: [Pt, Pt][] = [];
  for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
  const interior = segs.length > 2 ? segs.slice(1, -1) : segs;
  let best = interior[0];
  let bestLen = -1;
  for (const s of interior) {
    const len = dist(s[0], s[1]);
    if (len > bestLen) {
      bestLen = len;
      best = s;
    }
  }
  return { x: (best[0].x + best[1].x) / 2, y: (best[0].y + best[1].y) / 2 };
}

// --- straight-shot fast path (adjacent / clear colinear) --------------------
function straightShot(
  F: DiagramNode,
  T: DiagramNode,
  occ: Set<string>,
): Pt[] | null {
  const bf = nodeBox(F);
  const bt = nodeBox(T);
  if (F.row === T.row) {
    const [lo, hi] = [Math.min(F.col, T.col), Math.max(F.col, T.col)];
    for (let c = lo + 1; c < hi; c++) if (occ.has(cellKey(c, F.row))) return null;
    const y = bf.cy;
    return F.col < T.col
      ? [{ x: bf.right, y }, { x: bt.left, y }]
      : [{ x: bf.left, y }, { x: bt.right, y }];
  }
  if (F.col === T.col) {
    const [lo, hi] = [Math.min(F.row, T.row), Math.max(F.row, T.row)];
    for (let r = lo + 1; r < hi; r++) if (occ.has(cellKey(F.col, r))) return null;
    const x = bf.cx;
    return F.row < T.row
      ? [{ x, y: bf.bottom }, { x, y: bt.top }]
      : [{ x, y: bf.top }, { x, y: bt.bottom }];
  }
  return null;
}

function fromWaypoints(F: DiagramNode, T: DiagramNode, wps: { col: number; row: number }[]): Pt[] {
  const centers = wps.map((w) => {
    const b = nodeBox({ ...F, col: w.col, row: w.row });
    return { x: b.cx, y: b.cy };
  });
  const bf = nodeBox(F);
  const bt = nodeBox(T);
  const raw: Pt[] = [{ x: bf.cx, y: bf.cy }, ...centers, { x: bt.cx, y: bt.cy }];
  // orthogonalize consecutive points with an elbow (H then V)
  const ortho: Pt[] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const a = ortho[ortho.length - 1];
    const b = raw[i];
    if (a.x !== b.x && a.y !== b.y) ortho.push({ x: b.x, y: a.y });
    ortho.push(b);
  }
  return ortho;
}

// --- single-edge route -------------------------------------------------------
function routeOne(
  edge: DiagramEdge,
  byId: Map<string, DiagramNode>,
  occ: Set<string>,
  maxCol: number,
  maxRow: number,
): RoutedEdge {
  const F = byId.get(edge.from)!;
  const T = byId.get(edge.to)!;

  if (edge.waypoints && edge.waypoints.length) {
    const pts = mergeColinear(fromWaypoints(F, T, edge.waypoints));
    return { points: pts, svgPath: toPath(pts), labelAt: labelAnchor(pts) };
  }

  const shot = !edge.exitSide && !edge.entrySide ? straightShot(F, T, occ) : null;
  if (shot) return { points: shot, svgPath: toPath(shot), labelAt: labelAnchor(shot) };

  const exitSide = edge.exitSide ?? chooseExit(F, T, occ, maxCol, maxRow);
  const entrySide = edge.entrySide ?? chooseEntry(F, T, occ, maxCol, maxRow);
  const ep = port(F, exitSide);
  const gp = port(T, entrySide);
  const inner = astar(ep.landing, ep.brackets, gp.landing, gp.brackets, maxCol, maxRow);
  const pts = mergeColinear([ep.anchor, ...inner, gp.anchor]);
  return { points: pts, svgPath: toPath(pts), labelAt: labelAnchor(pts) };
}

// --- de-confliction ---------------------------------------------------------
function segChannelKey(a: Pt, b: Pt): string | null {
  if (a.x === b.x) return `V:${Math.round(a.x)}`;
  if (a.y === b.y) return `H:${Math.round(a.y)}`;
  return null;
}

function deconflict(routes: (RoutedEdge | null)[]) {
  // Bucket interior straight sub-segments by channel (same lane line). Only
  // segments that actually OVERLAP along the lane are parallel runs that need
  // separating — sequential hops of a left-to-right flow share a lane but do
  // not overlap, so they must stay put.
  interface Seg {
    ei: number;
    si: number;
    lo: number;
    hi: number;
  }
  const buckets = new Map<string, Seg[]>();
  routes.forEach((r, ei) => {
    if (!r) return;
    for (let si = 0; si < r.points.length - 1; si++) {
      const a = r.points[si];
      const b = r.points[si + 1];
      const key = segChannelKey(a, b);
      if (!key) continue;
      const [lo, hi] =
        key[0] === "V"
          ? [Math.min(a.y, b.y), Math.max(a.y, b.y)]
          : [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push({ ei, si, lo, hi });
    }
  });

  for (const [key, segs] of buckets) {
    if (segs.length < 2) continue;
    const axis = key[0]; // 'V' or 'H'
    // Cluster into maximal overlapping groups (sweep by lo).
    segs.sort((p, q) => p.lo - q.lo || p.ei - q.ei);
    let cluster: Seg[] = [];
    let clusterMax = -Infinity;
    const flush = () => {
      if (cluster.length >= 2) {
        cluster.forEach((m, k) => {
          const off = (k - (cluster.length - 1) / 2) * LANE_STEP;
          if (off === 0) return;
          const r = routes[m.ei]!;
          const p0 = r.points[m.si];
          const p1 = r.points[m.si + 1];
          if (axis === "V") {
            p0.x += off;
            p1.x += off;
          } else {
            p0.y += off;
            p1.y += off;
          }
        });
      }
      cluster = [];
    };
    for (const s of segs) {
      if (cluster.length && s.lo >= clusterMax) flush();
      cluster.push(s);
      clusterMax = Math.max(clusterMax, s.hi);
    }
    flush();
  }

  // Re-derive svg + label from possibly-shifted points.
  routes.forEach((r) => {
    if (!r) return;
    r.points = mergeColinear(r.points);
    r.svgPath = toPath(r.points);
    r.labelAt = labelAnchor(r.points);
  });
}

// --- public API -------------------------------------------------------------
export function routeAll(
  edges: DiagramEdge[],
  allNodes: DiagramNode[],
  visible?: Set<string>,
): (RoutedEdge | null)[] {
  const maxCol = Math.max(...allNodes.map((n) => n.col));
  const maxRow = Math.max(...allNodes.map((n) => n.row));
  const drawn = visible
    ? allNodes.filter((n) => visible.has(n.id))
    : allNodes;
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const occ = new Set(drawn.map((n) => cellKey(n.col, n.row)));

  const routes: (RoutedEdge | null)[] = edges.map((e) => {
    if (visible && (!visible.has(e.from) || !visible.has(e.to))) return null;
    if (!byId.has(e.from) || !byId.has(e.to)) return null;
    return routeOne(e, byId, occ, maxCol, maxRow);
  });
  deconflict(routes);
  return routes;
}
