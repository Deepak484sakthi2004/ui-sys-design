"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { catalog, totalProblems } from "@/data/catalog";

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

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  const toggle = (n: number) => setCollapsed((c) => ({ ...c, [n]: !c[n] }));

  return (
    <>
      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-[var(--border)] bg-white/85 px-4 py-3 backdrop-blur lg:hidden">
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
        className={`${
          open ? "block" : "hidden"
        } lg:sticky lg:top-0 lg:block lg:h-screen lg:w-[292px] lg:shrink-0`}
      >
        <div className="thin-scroll flex h-full flex-col overflow-y-auto border-r border-[var(--border)] bg-white/70 backdrop-blur">
          {/* Brand */}
          <div className="hidden items-center border-b border-[var(--border)] px-5 py-4 lg:flex">
            <Brand />
          </div>

          <div className="px-5 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            All topics · {totalProblems}
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
          </nav>
        </div>
      </aside>
    </>
  );
}
