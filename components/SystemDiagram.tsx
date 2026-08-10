import type { Diagram, DiagramNode } from "@/lib/types";
import {
  routeAll,
  canvasSize,
  nodeBox,
  NODE_W,
  NODE_H,
} from "@/lib/diagramRouter";
import { ScaledCanvas } from "./ScaledCanvas";

const toneStyles: Record<string, string> = {
  green: "border-emerald-300 bg-emerald-50 text-emerald-900",
  purple: "border-violet-300 bg-violet-50 text-violet-900",
  orange: "border-amber-300 bg-amber-50 text-amber-900",
  blue: "border-sky-300 bg-sky-50 text-sky-900",
  slate: "border-slate-300 bg-slate-50 text-slate-800",
};

const strokeColor: Record<string, string> = {
  read: "#059669",
  write: "#7c3aed",
  analytics: "#d97706",
};

const legendBar: Record<string, string> = {
  read: "bg-emerald-500",
  write: "bg-violet-500",
  analytics: "bg-amber-500",
};

interface Props {
  diagram: Diagram;
  /** When set, only these node ids (and edges fully within them) are drawn.
   *  Canvas size + positions still come from the full node set. */
  visible?: Set<string>;
  /** Hide the caption + legend chrome (used inside the stepper). */
  bare?: boolean;
  /** Rendered on the right of the caption row (e.g. the stepper toggle). */
  headerRight?: React.ReactNode;
}

export function SystemDiagram({ diagram, visible, bare, headerRight }: Props) {
  const { width, height } = canvasSize(diagram.nodes);
  const routed = routeAll(diagram.edges, diagram.nodes, visible);
  const drawnNodes = visible
    ? diagram.nodes.filter((n) => visible.has(n.id))
    : diagram.nodes;
  const kindsUsed = Array.from(new Set(diagram.edges.map((e) => e.kind)));

  const canvas = (
    <ScaledCanvas width={width} height={height}>
      <div className="relative" style={{ width, height }}>
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
            const r = routed[i];
            if (!r) return null;
            return (
              <path
                key={i}
                d={r.svgPath}
                fill="none"
                stroke={strokeColor[e.kind]}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeDasharray={e.kind === "analytics" ? "6 5" : undefined}
                markerEnd={`url(#arw-${e.kind})`}
              />
            );
          })}
        </svg>

        {drawnNodes.map((n: DiagramNode) => {
          const b = nodeBox(n);
          return (
            <div
              key={n.id}
              className={`absolute flex flex-col items-center justify-center rounded-lg border px-2 text-center shadow-sm ${toneStyles[n.tone] ?? toneStyles.slate}`}
              style={{ left: b.left, top: b.top, width: NODE_W, height: NODE_H }}
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

        {/* Edge labels last → always on top, never hidden behind a box. */}
        {diagram.edges.map((e, i) => {
          const r = routed[i];
          if (!r || !e.label) return null;
          return (
            <div
              key={i}
              className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10.5px] font-medium shadow-sm"
              style={{ left: r.labelAt.x, top: r.labelAt.y, color: strokeColor[e.kind] }}
            >
              {e.label}
            </div>
          );
        })}
      </div>
    </ScaledCanvas>
  );

  if (bare) return canvas;

  return (
    <section className="rounded-xl border border-[var(--border)] bg-white p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-slate-500">
          <span>⬚</span> {diagram.caption}
        </div>
        {headerRight}
      </div>
      {canvas}
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
