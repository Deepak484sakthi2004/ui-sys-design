"use client";

import { useEffect, useState } from "react";
import type { Heading } from "@/lib/notes";

export function Toc({ headings }: { headings: Heading[] }) {
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    if (!headings.length) return;
    const els = headings
      .map((h) => document.getElementById(h.id))
      .filter((e): e is HTMLElement => !!e);
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 },
    );
    els.forEach((e) => obs.observe(e));
    return () => obs.disconnect();
  }, [headings]);

  if (headings.length < 3) return null;

  return (
    <nav className="sticky top-8 max-h-[calc(100vh-4rem)] overflow-y-auto thin-scroll">
      <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        On this page
      </div>
      <ul className="space-y-0.5 border-l border-[var(--border)]">
        {headings.map((h) => {
          const on = active === h.id;
          return (
            <li key={h.id}>
              <a
                href={`#${h.id}`}
                className={`-ml-px block border-l-2 py-1 text-[12.5px] leading-snug transition-colors ${
                  h.depth === 3 ? "pl-6" : "pl-3"
                } ${
                  on
                    ? "border-brand font-medium text-brand"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                {h.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
