import type { Problem, Requirement } from "@/lib/types";

const priTone: Record<string, string> = {
  P0: "border-rose-200 bg-rose-50 text-rose-600",
  P1: "border-amber-200 bg-amber-50 text-amber-600",
  P2: "border-slate-200 bg-slate-50 text-slate-500",
};

function Row({ r, nfr }: { r: Requirement; nfr?: boolean }) {
  const tone = nfr
    ? "border-sky-200 bg-sky-50 text-sky-700"
    : priTone[r.tag] ?? "border-slate-200 bg-slate-50 text-slate-500";
  return (
    <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3 last:border-0">
      <span className="w-14 shrink-0 font-mono text-[11px] font-medium text-slate-400">
        {r.id}
      </span>
      <span className="flex-1 text-[14px] text-ink">{r.text}</span>
      <span
        className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${tone}`}
      >
        {r.tag}
      </span>
    </div>
  );
}

export function RequirementsTab({ problem }: { problem: Problem }) {
  return (
    <div className="space-y-6">
      <p className="text-[14px] text-slate-600">
        Pin these before drawing anything. Functional is what it must do;
        non-functional is how well it must do it.
      </p>

      <div>
        <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-emerald-600">
          ▤ Functional · what it must do
        </div>
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-white">
          {problem.requirements.functional.map((r) => (
            <Row key={r.id} r={r} />
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-sky-600">
          ◎ Non-functional · how well
        </div>
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-white">
          {problem.requirements.nonFunctional.map((r) => (
            <Row key={r.id} r={r} nfr />
          ))}
        </div>
      </div>
    </div>
  );
}
