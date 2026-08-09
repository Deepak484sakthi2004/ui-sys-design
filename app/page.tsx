import Link from "next/link";
import { catalog, totalProblems } from "@/data/catalog";
import { problems } from "@/data/problems";

const readyCount = Object.keys(problems).length;

export default function Home() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      {/* Hero */}
      <div className="max-w-2xl">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-white px-3 py-1 text-[12px] font-medium text-slate-500">
          🎯 {totalProblems} problems · {catalog.length} tracks
        </span>
        <h1 className="mt-4 text-[34px] font-bold leading-tight tracking-tight text-ink sm:text-[42px]">
          System Design Interview Prep
        </h1>
        <p className="mt-3 text-[16px] leading-relaxed text-slate-600">
          Every problem is built the same way: pin the requirements, tear down
          the concepts once, skim the cheat sheet, rehearse a timed playbook, and
          score yourself against L4 / L5 / L6 bars. Read once, never re-cram.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href="/design-url-shortener"
            className="rounded-lg bg-brand px-4 py-2.5 text-[14px] font-semibold text-white shadow-sm hover:bg-indigo-700"
          >
            Start with URL Shortener →
          </Link>
          <span className="rounded-lg border border-[var(--border)] bg-white px-4 py-2.5 text-[14px] font-medium text-slate-500">
            {readyCount} of {totalProblems} authored · more shipping
          </span>
        </div>
      </div>

      {/* Six-tab explainer */}
      <div className="mt-10 grid gap-3 sm:grid-cols-3">
        {[
          ["▤ Requirements", "Functional + non-functional, with priorities and budgets."],
          ["📖 Learn", "Concept teardowns: why it exists, options it beat, a memory anchor."],
          ["⚡ Cheat Sheet", "The whole design in one breath, plus the three flow paths."],
          ["🎯 Rehearse", "A timed, phase-by-phase playbook of what to do and say."],
          ["🏅 Get Scored", "L4/L5/L6 signals, red flags, and follow-up questions."],
          ["🚀 Go Deeper", "A full written walkthrough and the foundations referenced."],
        ].map(([t, d]) => (
          <div key={t} className="rounded-xl border border-[var(--border)] bg-white p-4">
            <div className="text-[14px] font-semibold text-ink">{t}</div>
            <div className="mt-1 text-[13px] leading-relaxed text-slate-600">{d}</div>
          </div>
        ))}
      </div>

      {/* Catalog */}
      <div className="mt-12">
        <h2 className="text-[20px] font-semibold text-ink">The curriculum</h2>
        <div className="mt-5 space-y-8">
          {catalog.map((cat) => (
            <div key={cat.num}>
              <div className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-ink">
                <span className="text-[16px]">{cat.emoji}</span>
                <span className="tabular-nums text-slate-400">{cat.num}</span>
                {cat.name}
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">
                  {cat.problems.length}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {cat.problems.map((p) =>
                  p.ready ? (
                    <Link
                      key={p.num}
                      href={`/${p.slug}`}
                      className="group flex items-center gap-2 rounded-lg border border-[var(--border)] bg-white px-3 py-2.5 hover:border-brand hover:shadow-sm"
                    >
                      <span className="tabular-nums text-[11px] text-slate-400">
                        {p.num}
                      </span>
                      <span className="flex-1 text-[13.5px] font-medium text-ink group-hover:text-brand">
                        {p.title}
                      </span>
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-600">
                        Ready
                      </span>
                    </Link>
                  ) : (
                    <div
                      key={p.num}
                      className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--border)] bg-slate-50/50 px-3 py-2.5"
                    >
                      <span className="tabular-nums text-[11px] text-slate-300">
                        {p.num}
                      </span>
                      <span className="flex-1 text-[13.5px] text-slate-400">
                        {p.title}
                      </span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-400">
                        Soon
                      </span>
                    </div>
                  )
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <footer className="mt-16 border-t border-[var(--border)] pt-6 text-[12px] text-slate-400">
        Built as a personal interview-prep course. Structure inspired by the
        Cracking Walnuts problem layout; all content authored for study.
      </footer>
    </div>
  );
}
