import type { Problem, FlowPath } from "@/lib/types";

const flowAccent: Record<string, { bar: string; text: string; dot: string }> = {
  read: { bar: "bg-emerald-500", text: "text-emerald-700", dot: "bg-emerald-400" },
  write: { bar: "bg-violet-500", text: "text-violet-700", dot: "bg-violet-400" },
  analytics: { bar: "bg-amber-500", text: "text-amber-700", dot: "bg-amber-400" },
};

function Flow({ flow }: { flow: FlowPath }) {
  const a = flowAccent[flow.kind];
  return (
    <div className="rounded-lg border border-[var(--border)] bg-white p-4">
      <div className={`mb-1 text-[12px] font-semibold ${a.text}`}>
        {flow.title}
      </div>
      <p className="mb-3 text-[13px] leading-relaxed text-slate-600">
        {flow.summary}
      </p>
      <div className="flex flex-wrap items-stretch gap-1.5">
        {flow.steps.map((s, i) => (
          <div key={i} className="flex items-stretch gap-1.5">
            <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5">
              <div className="text-[12px] font-semibold text-ink">{s.label}</div>
              {s.note && (
                <div className="mt-0.5 max-w-[190px] text-[10.5px] leading-tight text-slate-500">
                  {s.note}
                </div>
              )}
            </div>
            {i < flow.steps.length - 1 && (
              <span className="self-center text-slate-300">→</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CheatSheetTab({ problem }: { problem: Problem }) {
  const cs = problem.cheatSheet;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[17px] font-semibold text-ink">
          ⚡ Interview Cheat Sheet
        </h2>
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
          90s skim · 5 min read
        </span>
      </div>

      {/* One breath */}
      <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-4">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-sky-700">
          The whole design in one breath
        </div>
        <ul className="space-y-2">
          {cs.oneBreath.map((b, i) => (
            <li key={i} className="flex gap-2 text-[13.5px] leading-relaxed text-slate-700">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-sky-400" />
              {b}
            </li>
          ))}
        </ul>
      </div>

      {/* Flows */}
      <div>
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-slate-500">
          Flow — walk these paths on the board
        </div>
        <div className="space-y-3">
          {cs.flows.map((f) => (
            <Flow key={f.kind} flow={f} />
          ))}
        </div>
      </div>

      {/* Three columns */}
      <div className="grid gap-3 lg:grid-cols-3">
        {cs.columns.map((col) => (
          <div key={col.heading} className="rounded-xl border border-[var(--border)] bg-white p-4">
            <div className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-slate-500">
              <span>{col.icon}</span> {col.heading}
            </div>
            <ul className="space-y-2">
              {col.items.map((it, i) => (
                <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-slate-700">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
                  {it}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
