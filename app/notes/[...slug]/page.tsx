import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getDoc,
  getAllSlugs,
  allDocs,
  getSuiteMeta,
  extractHeadings,
} from "@/lib/notes";
import { MarkdownView } from "@/components/MarkdownView";
import { Toc } from "@/components/Toc";
import { ReadingProgress } from "@/components/ReadingProgress";

export const dynamicParams = false;

export function generateStaticParams() {
  return getAllSlugs().map((parts) => ({ slug: parts }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const doc = getDoc(slug);
  return { title: doc ? `${doc.title} — Notes` : "Notes" };
}

export default async function NotePage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) notFound();

  const meta = getSuiteMeta(doc.suite);
  const suiteDocs = allDocs().filter((d) => d.suite === doc.suite);
  const idx = suiteDocs.findIndex((d) => d.slug === slug.join("/"));
  const prev = idx > 0 ? suiteDocs[idx - 1] : null;
  const next = idx >= 0 && idx < suiteDocs.length - 1 ? suiteDocs[idx + 1] : null;
  const headings = extractHeadings(doc.content);

  return (
    <div className="mx-auto max-w-[1200px] px-5 py-8 sm:px-8 sm:py-10 xl:grid xl:grid-cols-[minmax(0,1fr)_232px] xl:gap-12">
      <ReadingProgress />
      <div className="mx-auto w-full min-w-0 max-w-3xl xl:mx-0">
        <div className="mb-5 flex items-center gap-2 text-[12.5px] text-slate-400">
          <Link href="/" className="hover:text-slate-600">
            Home
          </Link>
          <span>›</span>
          <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11.5px] font-medium text-brand">
            {meta?.emoji} {meta?.name ?? doc.suite}
          </span>
        </div>

        <article>
          <MarkdownView content={doc.content} dir={doc.dir} />
        </article>

        {/* Prev / next */}
        <nav className="mt-12 grid gap-3 border-t border-[var(--border)] pt-6 sm:grid-cols-2">
        {prev ? (
          <Link
            href={`/notes/${prev.slug}`}
            className="card card-hover px-4 py-3 text-left"
          >
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
              ← Previous
            </div>
            <div className="mt-0.5 text-[13.5px] font-medium text-ink">
              {prev.title}
            </div>
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link
            href={`/notes/${next.slug}`}
            className="card card-hover px-4 py-3 text-right sm:text-right"
          >
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Next →
            </div>
            <div className="mt-0.5 text-[13.5px] font-medium text-ink">
              {next.title}
            </div>
          </Link>
        ) : (
          <span />
        )}
        </nav>
      </div>

      {/* Table of contents rail */}
      <aside className="hidden xl:block">
        <Toc headings={headings} />
      </aside>
    </div>
  );
}
