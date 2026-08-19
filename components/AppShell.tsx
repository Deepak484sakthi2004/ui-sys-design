"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import type { Suite } from "@/lib/notes";

// Owns two view states shared across the app:
//  - sidebar collapsed (desktop): hide the nav, main goes full width
//  - read mode: distraction-free — nav + all chrome gone, only content + a
//    subtle exit control. Both persist to localStorage.
export function AppShell({
  children,
  suites,
}: {
  children: React.ReactNode;
  suites: Suite[];
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [readMode, setReadMode] = useState(false);
  const [ready, setReady] = useState(false);
  const router = useRouter();

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("sd-collapsed") === "1");
      setReadMode(localStorage.getItem("sd-read") === "1");
    } catch {}
    setReady(true);
  }, []);
  useEffect(() => {
    if (ready) try { localStorage.setItem("sd-collapsed", collapsed ? "1" : "0"); } catch {}
  }, [collapsed, ready]);
  useEffect(() => {
    if (ready) try { localStorage.setItem("sd-read", readMode ? "1" : "0"); } catch {}
  }, [readMode, ready]);

  // ESC exits read mode.
  useEffect(() => {
    if (!readMode) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setReadMode(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readMode]);

  // "/" jumps to Last-Minute Lookup (unless typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement)?.isContentEditable)
        return;
      e.preventDefault();
      router.push("/lookup");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const hideSidebar = collapsed || readMode;

  return (
    <div
      className="flex min-h-screen flex-col lg:flex-row"
      style={{ "--sd-sidebar": hideSidebar ? "0px" : "292px" } as React.CSSProperties}
    >
      <Sidebar
        suites={suites}
        hidden={hideSidebar}
        readMode={readMode}
        onCollapse={() => setCollapsed(true)}
      />

      <main className="min-w-0 flex-1">{children}</main>

      {/* Floating controls */}
      {!readMode && (
        <div className="fixed bottom-5 right-5 z-40 flex items-center gap-2">
          {hideSidebar && (
            <button
              onClick={() => setCollapsed(false)}
              className="flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-white/90 px-3.5 py-2 text-[13px] font-medium text-slate-600 shadow-[var(--shadow-lift)] backdrop-blur hover:text-slate-900"
              title="Show sidebar"
            >
              <MenuIcon /> Menu
            </button>
          )}
          <button
            onClick={() => setReadMode(true)}
            className="flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-white/90 px-3.5 py-2 text-[13px] font-medium text-slate-600 shadow-[var(--shadow-lift)] backdrop-blur hover:text-slate-900"
            title="Distraction-free reading (Esc to exit)"
          >
            <BookIcon /> Read mode
          </button>
        </div>
      )}

      {readMode && (
        <button
          onClick={() => setReadMode(false)}
          className="fixed bottom-5 right-5 z-50 flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-white/90 px-3.5 py-2 text-[13px] font-medium text-slate-600 shadow-[var(--shadow-lift)] backdrop-blur hover:text-slate-900"
          title="Exit read mode (Esc)"
        >
          <CloseIcon /> Exit read mode
        </button>
      )}
    </div>
  );
}

function MenuIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function BookIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M8 3.5C6.8 2.7 5 2.5 3 2.8v9.4c2-.3 3.8 0 5 .8 1.2-.8 3-1.1 5-.8V2.8c-2-.3-3.8-.1-5 .7Zm0 0v9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
