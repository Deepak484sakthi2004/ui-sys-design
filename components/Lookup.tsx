"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useEffect } from "react";

export interface LookupItem {
  title: string;
  href: string;
  kind: string;
  emoji: string;
  sub?: string;
}

export function Lookup({
  items,
  pinned,
}: {
  items: LookupItem[];
  pinned: LookupItem[];
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const terms = query.split(/\s+/);
    return items
      .map((it) => {
        const hay = `${it.title} ${it.kind} ${it.sub ?? ""}`.toLowerCase();
        let score = 0;
        for (const t of terms) {
          const i = hay.indexOf(t);
          if (i < 0) return null;
          score += i === 0 ? 3 : it.title.toLowerCase().includes(t) ? 2 : 1;
        }
        return { it, score };
      })
      .filter((x): x is { it: LookupItem; score: number } => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60)
      .map((x) => x.it);
  }, [q, items]);

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <div className="fade-up">
        <h1 className="text-[30px] font-extrabold tracking-tight text-ink sm:text-[36px]">
          Last-Minute <span className="gradient-text">Lookup</span>
        </h1>
        <p className="mt-2 text-[15px] text-slate-600">
          Search every design and note — {items.length} entries. The night
          before, jump straight to the cheat sheet you need.
        </p>

        <div className="mt-6 flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-white px-4 py-3 shadow-[var(--shadow-card)] focus-within:shadow-[var(--shadow-lift)]">
          <span className="text-slate-400">🔎</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search designs, patterns, Kafka, hashing, TCP, DP…"
            className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-slate-400"
          />
          {q && (
            <button
              onClick={() => setQ("")}
              className="rounded-md px-2 py-0.5 text-[12px] text-slate-400 hover:bg-slate-100"
            >
              clear
            </button>
          )}
        </div>
      </div>

      {q ? (
        <div className="mt-6">
          <div className="mb-2 text-[12px] text-slate-400">
            {results.length} result{results.length === 1 ? "" : "s"}
          </div>
          <div className="space-y-1.5">
            {results.map((it) => (
              <ResultRow key={it.href} it={it} />
            ))}
            {results.length === 0 && (
              <div className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-[14px] text-slate-400">
                No matches for “{q}”.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-8">
          <div className="mb-2.5 text-[12px] font-semibold uppercase tracking-wider text-slate-400">
            ⭐ Night-before cheat sheets
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {pinned.map((it) => (
              <ResultRow key={it.href} it={it} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ResultRow({ it }: { it: LookupItem }) {
  return (
    <Link
      href={it.href}
      className="card card-hover flex min-w-0 items-center gap-3 px-4 py-2.5"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-[15px]">
        {it.emoji}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">
          {it.title}
        </span>
        <span className="text-[11.5px] text-slate-400">
          {it.kind}
          {it.sub ? ` · ${it.sub}` : ""}
        </span>
      </span>
      <span className="shrink-0 text-slate-300">→</span>
    </Link>
  );
}
