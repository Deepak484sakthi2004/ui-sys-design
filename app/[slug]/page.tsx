import { notFound } from "next/navigation";
import Link from "next/link";
import { problems, getProblem } from "@/data/problems";
import { DiagramSection } from "@/components/DiagramSection";
import { CourseTabs } from "@/components/CourseTabs";

export function generateStaticParams() {
  return Object.keys(problems).map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const p = getProblem(slug);
  if (!p) return { title: "Not found" };
  return { title: `${p.title} — System Design Prep`, description: p.intro[0] };
}

const levelTone: Record<string, string> = {
  Foundational: "border-emerald-200 bg-emerald-50 text-emerald-700",
  Easy: "border-emerald-200 bg-emerald-50 text-emerald-700",
  Medium: "border-amber-200 bg-amber-50 text-amber-700",
  Hard: "border-rose-200 bg-rose-50 text-rose-700",
};

export default async function ProblemPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const problem = getProblem(slug);
  if (!problem) notFound();

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      {/* Breadcrumb */}
      <div className="mb-4 flex items-center gap-2 text-[12px] text-slate-400">
        <Link href="/" className="hover:text-slate-600">
          All problems
        </Link>
        <span>›</span>
        <span className="text-slate-500">Foundations</span>
        <span>›</span>
        <span className="text-slate-600">Problem {problem.num}</span>
      </div>

      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="brand-gradient grid h-10 w-10 place-items-center rounded-xl text-white shadow-[var(--shadow-card)]">
          🔗
        </span>
        <span className="rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-[11px] font-medium text-slate-600">
          Foundational
        </span>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
            levelTone[problem.level] ?? levelTone.Easy
          }`}
        >
          {problem.level}
        </span>
        {problem.deepDiveAvailable && (
          <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-[11px] font-medium text-sky-700">
            📖 Deep Dive available
          </span>
        )}
      </div>

      <h1 className="text-[30px] font-extrabold tracking-tight text-ink sm:text-[36px]">
        {problem.title}
      </h1>

      <div className="mt-4 space-y-3 rounded-r-lg border-l-[3px] border-transparent [border-image:linear-gradient(180deg,#4f46e5,#7c3aed)_1] pl-4">
        {problem.intro.map((p, i) => (
          <p key={i} className="text-[15.5px] leading-relaxed text-slate-700">
            {p}
          </p>
        ))}
        {problem.hardParts && (
          <p className="text-[15.5px] leading-relaxed text-slate-700">
            <span className="font-semibold text-ink">The hard parts: </span>
            {problem.hardParts.replace(/^The hard parts:\s*/, "")}
          </p>
        )}
      </div>

      {/* Key topics */}
      <div className="mt-5">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Key topics
        </div>
        <div className="flex flex-wrap gap-2">
          {problem.keyTopics.map((t) => (
            <span
              key={t}
              className="rounded-full border border-violet-200/70 bg-violet-50 px-3 py-1 text-[12px] font-medium text-violet-700 shadow-[var(--shadow-card)]"
            >
              {t}
            </span>
          ))}
        </div>
      </div>

      {/* Diagram — breaks out wider than the prose column so it renders large.
          On lg+ the sidebar (290px) eats viewport width, so the breakout is
          sized against (viewport − sidebar); capped so it never overflows. */}
      <div className="relative left-1/2 mt-6 w-[92vw] -translate-x-1/2 lg:w-[calc(95vw-300px)] lg:max-w-[1120px]">
        <DiagramSection diagram={problem.diagram} steps={problem.diagramSteps} />
      </div>

      {/* Tabs */}
      <div className="mt-8">
        <CourseTabs problem={problem} />
      </div>
    </div>
  );
}
