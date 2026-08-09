import type { Diagram } from "@/lib/types";

const toneStyles: Record<string, string> = {
  green: "border-emerald-300 bg-emerald-50 text-emerald-900",
  purple: "border-violet-300 bg-violet-50 text-violet-900",
  orange: "border-amber-300 bg-amber-50 text-amber-900",
  blue: "border-sky-300 bg-sky-50 text-sky-900",
  slate: "border-slate-300 bg-slate-50 text-slate-800",
};

const legendColor: Record<string, string> = {
  read: "bg-emerald-500",
  write: "bg-violet-500",
  analytics: "bg-amber-500",
};

export function SystemDiagram({ diagram }: { diagram: Diagram }) {
  const maxRow = Math.max(...diagram.nodes.map((n) => n.row));

  return (
    <section className="rounded-xl border border-[var(--border)] bg-white p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-slate-500">
          <span>⬚</span> {diagram.caption}
        </div>
      </div>

      {/* Grid of nodes. On small screens it scrolls horizontally. */}
      <div className="overflow-x-auto">
        <div
          className="grid min-w-[720px] gap-x-4 gap-y-5"
          style={{
            gridTemplateColumns: "repeat(5, minmax(120px, 1fr))",
            gridTemplateRows: `repeat(${maxRow}, auto)`,
          }}
        >
          {diagram.nodes.map((n) => (
            <div
              key={n.id}
              style={{ gridColumn: n.col, gridRow: n.row }}
              className={`rounded-lg border px-3 py-2.5 text-center shadow-sm ${toneStyles[n.tone]}`}
            >
              <div className="text-[13.5px] font-semibold leading-tight">
                {n.label}
              </div>
              {n.sub && (
                <div className="mt-0.5 text-[11px] opacity-80">{n.sub}</div>
              )}
              {n.mono && (
                <div className="mt-1.5 rounded border border-dashed border-current/40 bg-white/50 px-1.5 py-0.5 font-mono text-[10.5px]">
                  {n.mono}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Edge labels summarised as a flow list (arrows drawn textually). */}
      <div className="mt-5 grid gap-1.5 border-t border-[var(--border)] pt-4 text-[12px] text-slate-600 sm:grid-cols-2 lg:grid-cols-3">
        {diagram.edges.map((e, i) => {
          const from = diagram.nodes.find((n) => n.id === e.from)?.label;
          const to = diagram.nodes.find((n) => n.id === e.to)?.label;
          return (
            <div key={i} className="flex items-center gap-1.5">
              <span className={`h-2 w-2 shrink-0 rounded-full ${legendColor[e.kind]}`} />
              <span className="font-medium text-slate-700">{from}</span>
              <span className="text-slate-400">→</span>
              <span className="font-medium text-slate-700">{to}</span>
              {e.label && (
                <span className="ml-1 rounded bg-slate-100 px-1 font-mono text-[10.5px] text-slate-500">
                  {e.label}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-[var(--border)] pt-4 text-[12px]">
        {diagram.legend.map((l) => (
          <div key={l.kind} className="flex items-center gap-2">
            <span className={`h-0.5 w-6 rounded ${legendColor[l.kind]}`} />
            <span className="text-slate-600">{l.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
