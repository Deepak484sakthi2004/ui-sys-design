import type { Problem, PlaybookPhase, SayKind } from "@/lib/types";
import { Rich } from "@/components/Rich";

const kindTone: Record<SayKind, string> = {
  ASK: "bg-sky-100 text-sky-700",
  SAY: "bg-emerald-100 text-emerald-700",
  WRITE: "bg-violet-100 text-violet-700",
  DRAW: "bg-amber-100 text-amber-700",
  "RULE OUT": "bg-rose-100 text-rose-700",
};

function Phase({ p }: { p: PlaybookPhase }) {
  return (
    <article className="rounded-xl border border-[var(--border)] bg-white p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand text-[13px] font-semibold text-white">
            {p.n}
          </span>
          <h3 className="text-[16px] font-semibold text-ink">{p.title}</h3>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
          ⏱ {p.minutes} min
        </span>
      </div>

      <p className="mb-3 text-[13.5px] leading-relaxed text-slate-700">
        <span className="font-semibold text-ink">Goal. </span>
        {p.goal}
      </p>

      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-[13px] leading-relaxed text-amber-900">
        <span className="font-semibold">💡 Why the interviewer asks this: </span>
        {p.why}
      </div>

      <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Do &amp; say
      </div>
      <ol className="space-y-2.5">
        {p.steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span
              className={`mt-0.5 h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${kindTone[s.kind]}`}
            >
              {s.kind}
            </span>
            <span className="text-[13.5px] leading-relaxed text-slate-700">
              <Rich text={s.text} />
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-4 rounded-lg border border-[var(--border)] bg-slate-50 p-3 text-[13px] leading-relaxed text-slate-600">
        <span className="font-semibold text-slate-700">👁 Interviewer is grading: </span>
        {p.grading}
      </div>
    </article>
  );
}

export function RehearseTab({ problem }: { problem: Problem }) {
  const total = problem.rehearse.reduce((n, p) => n + p.minutes, 0);
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[17px] font-semibold text-ink">
          🎯 {total}-Minute Interview Playbook
        </h2>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-500">
          Rehearse under the clock
        </span>
      </div>
      <p className="text-[14px] text-slate-600">
        Each phase is what the interviewer expects you to do and say. Concrete
        steps, not topic hints.
      </p>
      {problem.rehearse.map((p) => (
        <Phase key={p.n} p={p} />
      ))}
    </div>
  );
}
