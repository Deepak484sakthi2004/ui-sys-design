import type { Problem } from "@/lib/types";

const foundationTone: Record<string, string> = {
  green: "border-emerald-200 bg-emerald-50 text-emerald-700",
  purple: "border-violet-200 bg-violet-50 text-violet-700",
  blue: "border-sky-200 bg-sky-50 text-sky-700",
  orange: "border-amber-200 bg-amber-50 text-amber-700",
};

export function GoDeeperTab({ problem }: { problem: Problem }) {
  const dd = problem.deepDive;
  return (
    <div className="space-y-6">
      <div>
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-slate-500">
          Foundations referenced
        </div>
        <div className="flex flex-wrap gap-2">
          {problem.foundationsReferenced.map((f) => (
            <span
              key={f.label}
              className={`rounded-full border px-2.5 py-1 text-[12px] font-medium ${
                foundationTone[f.tone] ?? foundationTone.blue
              }`}
            >
              {f.label}
            </span>
          ))}
        </div>
      </div>

      {dd && (
        <>
          <div className="rounded-xl border border-brand/30 bg-brand-soft p-4">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-brand">
              📖 Read the deep-dive article
            </div>
            <p className="mt-1 text-[13.5px] leading-relaxed text-slate-700">
              {dd.intro}
            </p>
          </div>

          <div className="space-y-5">
            {dd.sections.map((s, i) => (
              <section key={i} className="rounded-xl border border-[var(--border)] bg-white p-5">
                <h3 className="mb-2 text-[15.5px] font-semibold text-ink">
                  {s.heading}
                </h3>
                {s.body.map((p, j) => (
                  <p
                    key={j}
                    className="mb-2.5 text-[14px] leading-relaxed text-slate-700 last:mb-0"
                  >
                    {p}
                  </p>
                ))}
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
