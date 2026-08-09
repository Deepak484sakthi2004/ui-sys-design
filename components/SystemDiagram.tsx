import type { Diagram, DiagramNode } from "@/lib/types";

const toneStyles: Record<string, string> = {
  green: "border-emerald-300 bg-emerald-50 text-emerald-900",
  purple: "border-violet-300 bg-violet-50 text-violet-900",
  orange: "border-amber-300 bg-amber-50 text-amber-900",
  blue: "border-sky-300 bg-sky-50 text-sky-900",
  slate: "border-slate-300 bg-slate-50 text-slate-800",
};

const strokeColor: Record<string, string> = {
  read: "#059669", // emerald-600
  write: "#7c3aed", // violet-600
  analytics: "#d97706", // amber-600
};

const legendBar: Record<string, string> = {
  read: "bg-emerald-500",
  write: "bg-violet-500",
  analytics: "bg-amber-500",
};

// Grid geometry (px). Nodes sit at (col,row); arrows route orthogonally.
const NODE_W = 178;
const NODE_H = 96;
const COL_W = 236; // horizontal pitch (node + gap)
const ROW_H = 158; // vertical pitch
const PAD = 8;

interface Pos {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

function nodePos(n: DiagramNode): Pos {
  const cellX = (n.col - 1) * COL_W;
  const cellY = (n.row - 1) * ROW_H;
  const x = cellX + (COL_W - NODE_W) / 2 + PAD;
  const y = cellY + (ROW_H - NODE_H) / 2 + PAD;
  return { x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2 };
}

// Pick exit/enter anchors on the box edges facing each other, then build an
// orthogonal (elbow) path so lines read like a flowchart on any layout.
function route(a: Pos, b: Pos) {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  let start: { x: number; y: number };
  let end: { x: number; y: number };
  let d: string;
  let mid: { x: number; y: number };

  if (Math.abs(dx) >= Math.abs(dy)) {
    // horizontal-dominant: exit left/right
    start = dx >= 0 ? { x: a.x + NODE_W, y: a.cy } : { x: a.x, y: a.cy };
    end = dx >= 0 ? { x: b.x, y: b.cy } : { x: b.x + NODE_W, y: b.cy };
    const mx = (start.x + end.x) / 2;
    d = `M ${start.x} ${start.y} L ${mx} ${start.y} L ${mx} ${end.y} L ${end.x} ${end.y}`;
    mid = { x: mx, y: (start.y + end.y) / 2 };
  } else {
    // vertical-dominant: exit top/bottom
    start = dy >= 0 ? { x: a.cx, y: a.y + NODE_H } : { x: a.cx, y: a.y };
    end = dy >= 0 ? { x: b.cx, y: b.y } : { x: b.cx, y: b.y + NODE_H };
    const my = (start.y + end.y) / 2;
    d = `M ${start.x} ${start.y} L ${start.x} ${my} L ${end.x} ${my} L ${end.x} ${end.y}`;
    mid = { x: (start.x + end.x) / 2, y: my };
  }
  return { d, mid };
}

export function SystemDiagram({ diagram }: { diagram: Diagram }) {
  const maxCol = Math.max(...diagram.nodes.map((n) => n.col));
  const maxRow = Math.max(...diagram.nodes.map((n) => n.row));
  const width = maxCol * COL_W + PAD * 2;
  const height = maxRow * ROW_H + PAD * 2;

  const posById = new Map<string, Pos>();
  for (const n of diagram.nodes) posById.set(n.id, nodePos(n));

  const kindsUsed = Array.from(new Set(diagram.edges.map((e) => e.kind)));

  return (
    <section className="rounded-xl border border-[var(--border)] bg-white p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-slate-500">
        <span>⬚</span> {diagram.caption}
      </div>

      {/* Flowchart canvas — scrolls horizontally on narrow screens. */}
      <div className="overflow-x-auto">
        <div className="relative" style={{ width, height, minWidth: width }}>
          {/* Arrows layer */}
          <svg
            className="absolute inset-0"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
          >
            <defs>
              {kindsUsed.map((k) => (
                <marker
                  key={k}
                  id={`arw-${k}`}
                  markerWidth="9"
                  markerHeight="9"
                  refX="7"
                  refY="3"
                  orient="auto"
                  markerUnits="userSpaceOnUse"
                >
                  <path d="M0,0 L7,3 L0,6 Z" fill={strokeColor[k]} />
                </marker>
              ))}
            </defs>
            {diagram.edges.map((e, i) => {
              const a = posById.get(e.from);
              const b = posById.get(e.to);
              if (!a || !b) return null;
              const { d } = route(a, b);
              return (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke={strokeColor[e.kind]}
                  strokeWidth={2}
                  strokeDasharray={e.kind === "analytics" ? "6 5" : undefined}
                  markerEnd={`url(#arw-${e.kind})`}
                />
              );
            })}
          </svg>

          {/* Edge labels layer */}
          {diagram.edges.map((e, i) => {
            const a = posById.get(e.from);
            const b = posById.get(e.to);
            if (!a || !b || !e.label) return null;
            const { mid } = route(a, b);
            return (
              <div
                key={i}
                className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-white px-1 font-mono text-[10.5px] font-medium"
                style={{ left: mid.x, top: mid.y, color: strokeColor[e.kind] }}
              >
                {e.label}
              </div>
            );
          })}

          {/* Nodes layer */}
          {diagram.nodes.map((n) => {
            const p = posById.get(n.id)!;
            return (
              <div
                key={n.id}
                className={`absolute flex flex-col items-center justify-center rounded-lg border px-2 text-center shadow-sm ${toneStyles[n.tone] ?? toneStyles.slate}`}
                style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
              >
                <div className="text-[13.5px] font-semibold leading-tight">
                  {n.label}
                </div>
                {n.sub && (
                  <div className="mt-0.5 text-[10.5px] leading-tight opacity-80">
                    {n.sub}
                  </div>
                )}
                {n.mono && (
                  <div className="mt-1 max-w-full truncate rounded border border-dashed border-current/40 bg-white/50 px-1.5 py-0.5 font-mono text-[10px]">
                    {n.mono}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-[var(--border)] pt-4 text-[12px]">
        {diagram.legend.map((l) => (
          <div key={l.kind} className="flex items-center gap-2">
            <span
              className={`h-0.5 w-7 rounded ${legendBar[l.kind]}`}
              style={
                l.kind === "analytics"
                  ? {
                      backgroundImage: `repeating-linear-gradient(90deg, ${strokeColor.analytics} 0 6px, transparent 6px 11px)`,
                      backgroundColor: "transparent",
                    }
                  : undefined
              }
            />
            <span className="text-slate-600">{l.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
