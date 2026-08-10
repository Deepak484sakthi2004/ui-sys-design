"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { catalog, totalProblems } from "@/data/catalog";
import type { Suite } from "@/lib/notes";

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <span className="brand-gradient grid h-8 w-8 place-items-center rounded-xl text-white shadow-[var(--shadow-card)]">
        🔗
      </span>
      <div className="leading-tight">
        <div className="text-[14.5px] font-semibold text-ink">
          System Design Prep
        </div>
        <div className="text-[11px] text-muted">
          {totalProblems} problems · {catalog.length} tracks
        </div>
      </div>
    </Link>
  );
}

export function Sidebar({
  suites = [],
  hidden = false,
  readMode = false,
  onCollapse,
}: {
  suites?: Suite[];
  hidden?: boolean;
  readMode?: boolean;
  onCollapse?: () => void;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [openSuite, setOpenSuite] = useState<Record<string, boolean>>({});

  const toggle = (n: number) => setCollapsed((c) => ({ ...c, [n]: !c[n] }));
  const toggleSuite = (k: string) =>
    setOpenSuite((c) => ({ ...c, [k]: !c[k] }));

  return (
    <>
      {/* Mobile top bar */}
      <div
        className={`sticky top-0 z-30 flex items-center justify-between border-b border-[var(--border)] bg-white/85 px-4 py-3 backdrop-blur lg:hidden ${
          readMode ? "hidden" : ""
        }`}
      >
        <Brand />
        <button
          onClick={() => setOpen((o) => !o)}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-slate-600"
          aria-label="Toggle menu"
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>

      <aside
        className={`${open ? "block" : "hidden"} lg:sticky lg:top-0 lg:h-screen lg:w-[292px] lg:shrink-0 ${
          hidden ? "lg:hidden" : "lg:block"
        }`}
      >
        <div className="thin-scroll flex h-full flex-col overflow-y-auto border-r border-[var(--border)] bg-white/70 backdrop-blur">
          {/* Brand */}
          <div className="hidden items-center justify-between border-b border-[var(--border)] px-5 py-4 lg:flex">
            <Brand />
            {onCollapse && (
              <button
                onClick={onCollapse}
                title="Collapse sidebar"
                className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M10 3.5L5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M3 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>

          <div className="px-2.5 pb-1 pt-3">
            <Link
              href="/lookup"
              onClick={() => setOpen(false)}
              className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] font-semibold transition-colors ${
                pathname === "/lookup"
                  ? "bg-brand-soft text-brand"
                  : "text-ink hover:bg-slate-100/70"
              }`}
            >
              <span className="text-[15px]">🔎</span>
              <span className="flex-1">Last-Minute Lookup</span>
              <kbd className="rounded border border-[var(--border)] bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
                /
              </kbd>
            </Link>
          </div>

          <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            System Design · {totalProblems}
          </div>

          <nav className="flex-1 px-2.5 pb-10">
            {catalog.map((cat) => {
              const isCollapsed = collapsed[cat.num];
              return (
                <div key={cat.num} className="mb-0.5">
                  <button
                    onClick={() => toggle(cat.num)}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] font-semibold text-ink transition-colors hover:bg-slate-100/70"
                  >
                    <span className="text-[15px]">{cat.emoji}</span>
                    <span className="tabular-nums text-[12px] text-slate-400">
                      {cat.num}
                    </span>
                    <span className="flex-1">{cat.name}</span>
                    <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-500">
                      {cat.problems.length}
                    </span>
                    <svg
                      className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
                        isCollapsed ? "-rotate-90" : ""
                      }`}
                      viewBox="0 0 12 12"
                      fill="none"
                    >
                      <path
                        d="M3 4.5L6 7.5L9 4.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>

                  {!isCollapsed && (
                    <ul className="mb-1 ml-[18px] mt-0.5 space-y-0.5 border-l border-[var(--border)] pl-2">
                      {cat.problems.map((p) => {
                        const active = pathname === `/${p.slug}`;
                        return (
                          <li key={p.num} className="relative">
                            {p.ready ? (
                              <Link
                                href={`/${p.slug}`}
                                onClick={() => setOpen(false)}
                                className={`flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors ${
                                  active
                                    ? "bg-brand-soft font-semibold text-brand"
                                    : "text-slate-600 hover:bg-slate-100/70 hover:text-slate-900"
                                }`}
                              >
                                {active && (
                                  <span className="brand-gradient absolute -left-[10px] top-1.5 h-[calc(100%-12px)] w-[3px] rounded-full" />
                                )}
                                <span className="tabular-nums pt-px text-[11px] text-slate-400">
                                  {p.num}
                                </span>
                                <span className="flex-1">{p.title}</span>
                              </Link>
                            ) : (
                              <div className="flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-slate-400">
                                <span className="tabular-nums pt-px text-[11px] text-slate-300">
                                  {p.num}
                                </span>
                                <span className="flex-1">{p.title}</span>
                                <span
                                  title="Coming soon"
                                  className="mt-0.5 shrink-0 rounded bg-slate-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400"
                                >
                                  soon
                                </span>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}

            {/* Library — the notes suites */}
            {suites.length > 0 && (
              <div className="mt-4 border-t border-[var(--border)] pt-3">
                <div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Library
                </div>
                {suites.map((s) => {
                  const isOpen = openSuite[s.key];
                  return (
                    <div key={s.key} className="mb-0.5">
                      <button
                        onClick={() => toggleSuite(s.key)}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] font-semibold text-ink transition-colors hover:bg-slate-100/70"
                      >
                        <span className="text-[15px]">{s.emoji}</span>
                        <span className="flex-1">{s.name}</span>
                        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-500">
                          {s.count}
                        </span>
                        <svg
                          className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
                            isOpen ? "" : "-rotate-90"
                          }`}
                          viewBox="0 0 12 12"
                          fill="none"
                        >
                          <path
                            d="M3 4.5L6 7.5L9 4.5"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>

                      {isOpen && (
                        <div className="mb-1 ml-[18px] mt-0.5 border-l border-[var(--border)] pl-2">
                          {s.groups.map((g, gi) => (
                            <div key={gi} className="mb-1">
                              {g.name && (
                                <div className="px-2.5 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">
                                  {g.name}
                                </div>
                              )}
                              <ul className="space-y-0.5">
                                {g.docs.map((d) => {
                                  const active = pathname === `/notes/${d.slug}`;
                                  return (
                                    <li key={d.slug} className="relative">
                                      <Link
                                        href={`/notes/${d.slug}`}
                                        onClick={() => setOpen(false)}
                                        className={`block rounded-lg px-2.5 py-1.5 text-[12.5px] leading-snug transition-colors ${
                                          active
                                            ? "bg-brand-soft font-semibold text-brand"
                                            : "text-slate-600 hover:bg-slate-100/70 hover:text-slate-900"
                                        }`}
                                      >
                                        {active && (
                                          <span className="brand-gradient absolute -left-[10px] top-1.5 h-[calc(100%-12px)] w-[3px] rounded-full" />
                                        )}
                                        {d.title}
                                      </Link>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </nav>
        </div>
      </aside>
    </>
  );
}
