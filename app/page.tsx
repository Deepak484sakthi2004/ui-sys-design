import Link from "next/link";
import { catalog, totalProblems } from "@/data/catalog";
import { problems } from "@/data/problems";
import { getSuites, getSuiteMeta } from "@/lib/notes";

const readyCount = Object.keys(problems).length;

const TAB_CARDS: [string, string, string][] = [
  ["▤", "Requirements", "Functional + non-functional, with priorities and budgets."],
  ["📖", "Learn", "Concept teardowns: why it exists, options it beat, a memory anchor."],
  ["⚡", "Cheat Sheet", "The whole design in one breath, plus the three flow paths."],
  ["🎯", "Rehearse", "A timed, phase-by-phase playbook of what to do and say."],
  ["🏅", "Get Scored", "L4/L5/L6 signals, red flags, and follow-up questions."],
  ["🚀", "Go Deeper", "A full written walkthrough and the foundations referenced."],
];

export default function Home() {
  const suites = getSuites();
  const totalNotes = suites.reduce((n, s) => n + s.count, 0);
  const firstDoc = (key: string) => {
    const s = suites.find((x) => x.key === key);
    const d = s?.groups.find((g) => g.docs.length)?.docs[0];
    return d ? `/notes/${d.slug}` : "/lookup";
  };

  return (
    <div className="mx-auto max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
      {/* Hero */}
      <section className="fade-up max-w-2xl">
        <span className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-white/70 px-3.5 py-1.5 text-[12.5px] font-medium text-slate-600 shadow-[var(--shadow-card)] backdrop-blur">
          <span className="brand-gradient h-1.5 w-1.5 rounded-full" />
          {totalProblems} problems · {catalog.length} tracks
        </span>
        <h1 className="mt-5 text-[38px] font-extrabold leading-[1.05] tracking-tight text-ink sm:text-[52px]">
          System Design
          <br />
          <span className="gradient-text">Interview Prep</span>
        </h1>
        <p className="mt-5 text-[16.5px] leading-relaxed text-slate-600">
          Every problem is built the same way: pin the requirements, tear down
          the concepts once, skim the cheat sheet, rehearse a timed playbook, and
          score yourself against L4 / L5 / L6 bars.{" "}
          <span className="font-medium text-slate-800">
            Read once, never re-cram.
          </span>
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link
            href="/design-url-shortener"
            className="brand-gradient inline-flex items-center gap-2 rounded-xl px-5 py-3 text-[14.5px] font-semibold text-white shadow-[var(--shadow-lift)] transition hover:brightness-110"
          >
            Start with URL Shortener
            <span aria-hidden>→</span>
          </Link>
          <span className="rounded-xl border border-[var(--border)] bg-white px-4 py-3 text-[13.5px] font-medium text-slate-500">
            {readyCount} of {totalProblems} authored · more shipping
          </span>
        </div>
      </section>

      {/* Six-tab explainer */}
      <section className="mt-14">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-slate-400">
          Every problem, six ways
        </h2>
        <div className="mt-4 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {TAB_CARDS.map(([icon, t, d]) => (
            <div key={t} className="card card-hover p-5">
              <div className="flex items-center gap-2.5">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-soft text-[16px]">
                  {icon}
                </span>
                <div className="text-[15px] font-semibold text-ink">{t}</div>
              </div>
              <p className="mt-2.5 text-[13.5px] leading-relaxed text-slate-600">
                {d}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Library suites */}
      <section className="mt-16">
        <div className="flex items-end justify-between">
          <h2 className="text-[22px] font-bold tracking-tight text-ink">
            The full interview library
          </h2>
          <Link
            href="/lookup"
            className="rounded-lg border border-[var(--border)] bg-white px-3 py-1.5 text-[13px] font-medium text-slate-600 hover:text-brand"
          >
            🔎 Last-minute lookup
          </Link>
        </div>
        <p className="mt-1.5 text-[14.5px] text-slate-600">
          {totalNotes} deep-dive notes across DSA internals, platform
          engineering, networking, and full mock interview rounds.
        </p>
        <div className="mt-5 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {suites.map((s) => (
            <Link
              key={s.key}
              href={firstDoc(s.key)}
              className="card card-hover group p-5"
            >
              <div className="flex items-center gap-2.5">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-soft text-[18px]">
                  {s.emoji}
                </span>
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold text-ink group-hover:text-brand">
                    {s.name}
                  </div>
                  <div className="text-[11.5px] text-slate-400">
                    {s.count} notes
                  </div>
                </div>
              </div>
              <p className="mt-2.5 text-[13px] leading-relaxed text-slate-600">
                {getSuiteMeta(s.key)?.blurb}
              </p>
            </Link>
          ))}
        </div>
      </section>

      {/* Curriculum */}
      <section className="mt-16">
        <div className="flex items-end justify-between">
          <h2 className="text-[22px] font-bold tracking-tight text-ink">
            The curriculum
          </h2>
          <span className="text-[13px] text-slate-400">
            {catalog.length} tracks · {totalProblems} problems
          </span>
        </div>

        <div className="mt-6 space-y-9">
          {catalog.map((cat) => (
            <div key={cat.num}>
              <div className="mb-3.5 flex items-center gap-2.5">
                <span className="grid h-8 w-8 place-items-center rounded-xl border border-[var(--border)] bg-white text-[16px] shadow-[var(--shadow-card)]">
                  {cat.emoji}
                </span>
                <h3 className="text-[15px] font-semibold text-ink">
                  <span className="tabular-nums text-slate-400">{cat.num}</span>{" "}
                  {cat.name}
                </h3>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                  {cat.problems.length}
                </span>
                <span className="ml-1 h-px flex-1 bg-[var(--border)]" />
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {cat.problems.map((p) =>
                  p.ready ? (
                    <Link
                      key={p.num}
                      href={`/${p.slug}`}
                      className="card card-hover group flex items-center gap-2.5 px-4 py-3"
                    >
                      <span className="tabular-nums text-[11px] font-medium text-slate-400">
                        {p.num}
                      </span>
                      <span className="flex-1 text-[13.5px] font-medium text-ink transition-colors group-hover:text-brand">
                        {p.title}
                      </span>
                      <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600">
                        Ready
                      </span>
                    </Link>
                  ) : (
                    <div
                      key={p.num}
                      className="flex items-center gap-2.5 rounded-2xl border border-dashed border-[var(--border)] bg-white/40 px-4 py-3"
                    >
                      <span className="tabular-nums text-[11px] text-slate-300">
                        {p.num}
                      </span>
                      <span className="flex-1 text-[13.5px] text-slate-400">
                        {p.title}
                      </span>
                      <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        Soon
                      </span>
                    </div>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="mt-20 border-t border-[var(--border)] pt-6 text-[12.5px] text-slate-400">
        Built as a personal interview-prep course. Structure inspired by the
        Cracking Walnuts problem layout; all content authored for study.
      </footer>
    </div>
  );
}
