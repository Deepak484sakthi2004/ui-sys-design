"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { catalog, totalProblems } from "@/data/catalog";

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Categories start expanded so the whole curriculum is visible.
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  const toggle = (n: number) =>
    setCollapsed((c) => ({ ...c, [n]: !c[n] }));

  return (
    <>
      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-[var(--border)] bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-brand text-white">
            🔗
          </span>
          System Design Prep
        </Link>
        <button
          onClick={() => setOpen((o) => !o)}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm font-medium"
          aria-label="Toggle menu"
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>

      <aside
        className={`${
          open ? "block" : "hidden"
        } lg:sticky lg:top-0 lg:block lg:h-screen lg:w-[290px] lg:shrink-0`}
      >
        <div className="thin-scroll flex h-full flex-col overflow-y-auto border-r border-[var(--border)] bg-white">
          {/* Brand */}
          <div className="hidden items-center gap-2.5 border-b border-[var(--border)] px-5 py-4 lg:flex">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-white shadow-sm">
                🔗
              </span>
              <div className="leading-tight">
                <div className="text-[15px] font-semibold text-ink">
                  System Design Prep
                </div>
                <div className="text-[11px] text-muted">
                  {totalProblems} problems · {catalog.length} tracks
                </div>
              </div>
            </Link>
          </div>

          {/* All topics header */}
          <div className="flex items-center justify-between px-5 py-3 text-[13px] font-medium text-muted">
            <span>All topics ({totalProblems})</span>
          </div>

          <nav className="flex-1 px-2 pb-8">
            {catalog.map((cat) => {
              const isCollapsed = collapsed[cat.num];
              return (
                <div key={cat.num} className="mb-1">
                  <button
                    onClick={() => toggle(cat.num)}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13.5px] font-semibold text-ink hover:bg-slate-50"
                  >
                    <span className="text-[15px]">{cat.emoji}</span>
                    <span className="tabular-nums text-muted">{cat.num}</span>
                    <span className="flex-1">{cat.name}</span>
                    <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-muted">
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
                    <ul className="mb-1 ml-3 border-l border-[var(--border)] pl-1.5">
                      {cat.problems.map((p) => {
                        const href = p.ready ? `/${p.slug}` : "#";
                        const active = pathname === `/${p.slug}`;
                        return (
                          <li key={p.num}>
                            {p.ready ? (
                              <Link
                                href={href}
                                onClick={() => setOpen(false)}
                                className={`flex items-start gap-2 rounded-md px-3 py-1.5 text-[13px] ${
                                  active
                                    ? "bg-brand-soft font-medium text-brand"
                                    : "text-slate-600 hover:bg-slate-50"
                                }`}
                              >
                                <span className="tabular-nums text-[11px] text-slate-400 pt-0.5">
                                  {p.num}
                                </span>
                                <span className="flex-1">{p.title}</span>
                              </Link>
                            ) : (
                              <div className="flex items-start gap-2 rounded-md px-3 py-1.5 text-[13px] text-slate-400">
                                <span className="tabular-nums text-[11px] text-slate-300 pt-0.5">
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
