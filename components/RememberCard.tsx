"use client";

import { useState } from "react";
import type { RememberCard as RememberCardType } from "@/lib/types";

const rows: { key: keyof RememberCardType; label: string }[] = [
  { key: "solution", label: "Solution" },
  { key: "why", label: "Why" },
  { key: "tradeoff", label: "Tradeoff" },
  { key: "failure", label: "Failure" },
  { key: "mitigation", label: "Mitigation" },
];

export function RememberCard({ card }: { card: RememberCardType }) {
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const allShown = rows.every((r) => shown[r.key]);

  const revealAll = () =>
    setShown(Object.fromEntries(rows.map((r) => [r.key, true])));

  return (
    <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50/50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-violet-700">
          <span>🧠</span> REMEMBER THIS
        </div>
        <button
          onClick={revealAll}
          className="text-[11px] font-medium text-violet-600 hover:underline"
        >
          {allShown ? "answer out loud, then check" : "Reveal all"}
        </button>
      </div>

      <div className="mb-2 flex gap-3 text-[13.5px]">
        <span className="w-20 shrink-0 font-medium text-slate-500">Problem</span>
        <span className="text-ink">{card.problem}</span>
      </div>

      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-start gap-3 text-[13.5px]">
            <span className="w-20 shrink-0 pt-px font-medium text-slate-500">
              {r.label}
            </span>
            {shown[r.key] ? (
              <span className="reveal-in text-slate-700">{card[r.key]}</span>
            ) : (
              <button
                onClick={() => setShown((s) => ({ ...s, [r.key]: true }))}
                className="flex items-center gap-1 text-[12px] text-violet-500 hover:text-violet-700"
              >
                <span>👁</span> reveal
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
