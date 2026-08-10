"use client";

import { useState } from "react";
import type { Problem } from "@/lib/types";
import { RequirementsTab } from "./tabs/RequirementsTab";
import { LearnTab } from "./tabs/LearnTab";
import { CheatSheetTab } from "./tabs/CheatSheetTab";
import { RehearseTab } from "./tabs/RehearseTab";
import { GetScoredTab } from "./tabs/GetScoredTab";
import { GoDeeperTab } from "./tabs/GoDeeperTab";

const TABS = [
  { id: "requirements", label: "Requirements", icon: "▤" },
  { id: "learn", label: "Learn", icon: "📖" },
  { id: "cheat", label: "Cheat Sheet", icon: "⚡" },
  { id: "rehearse", label: "Rehearse", icon: "🎯" },
  { id: "scored", label: "Get Scored", icon: "🏅" },
  { id: "deeper", label: "Go Deeper", icon: "🚀" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function CourseTabs({ problem }: { problem: Problem }) {
  const [active, setActive] = useState<TabId>("requirements");

  return (
    <div>
      {/* Tab bar */}
      <div className="sticky top-0 z-20 -mx-4 mb-6 px-4 py-2.5 sm:-mx-6 sm:px-6 lg:top-0">
        <div className="thin-scroll flex gap-1 overflow-x-auto rounded-2xl border border-[var(--border)] bg-white/90 p-1.5 shadow-[var(--shadow-card)] backdrop-blur">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-2 text-[13.5px] font-medium transition-all ${
                active === t.id
                  ? "bg-brand-soft text-brand shadow-[inset_0_0_0_1px_rgba(79,70,229,0.18)]"
                  : "text-slate-500 hover:bg-slate-100/70 hover:text-slate-800"
              }`}
            >
              <span>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="pb-16">
        {active === "requirements" && <RequirementsTab problem={problem} />}
        {active === "learn" && <LearnTab problem={problem} />}
        {active === "cheat" && <CheatSheetTab problem={problem} />}
        {active === "rehearse" && <RehearseTab problem={problem} />}
        {active === "scored" && <GetScoredTab problem={problem} />}
        {active === "deeper" && <GoDeeperTab problem={problem} />}
      </div>
    </div>
  );
}
