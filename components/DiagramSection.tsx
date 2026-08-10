"use client";

import { useState } from "react";
import type { Diagram, DiagramStep } from "@/lib/types";
import { SystemDiagram } from "./SystemDiagram";

export function DiagramSection({
  diagram,
  steps,
}: {
  diagram: Diagram;
  steps?: DiagramStep[];
}) {
  const [mode, setMode] = useState<"full" | "steps">("full");
  const [i, setI] = useState(0);

  const hasSteps = !!steps && steps.length > 0;

  if (mode === "full" || !hasSteps) {
    return (
      <SystemDiagram
        diagram={diagram}
        headerRight={
          hasSteps ? (
            <button
              onClick={() => {
                setI(0);
                setMode("steps");
              }}
              className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-white px-3 py-1.5 text-[12.5px] font-medium text-slate-600 hover:bg-slate-50"
            >
              <span>↻</span> Rebuild it step by step
            </button>
          ) : null
        }
      />
    );
  }

  // Stepper mode
  const n = steps!.length;
  const visible = new Set<string>();
  for (let s = 0; s <= i; s++) for (const id of steps![s].reveal) visible.add(id);

  return (
    <section className="rounded-xl border border-[var(--border)] bg-white p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-slate-500">
          <span>⬚</span> DRAW IT LIKE YOU WOULD IN THE ROOM
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-slate-500">
            Step {i + 1} of {n}
          </span>
          <div className="flex items-center gap-1">
            {steps!.map((_, k) => (
              <span
                key={k}
                className={`h-1.5 w-1.5 rounded-full ${
                  k <= i ? "bg-brand" : "bg-slate-200"
                }`}
              />
            ))}
          </div>
          <button
            onClick={() => (i === 0 ? setMode("full") : setI(i - 1))}
            className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[12.5px] font-medium text-slate-600 hover:bg-slate-50"
          >
            ‹ Back
          </button>
          <button
            onClick={() => (i === n - 1 ? setMode("full") : setI(i + 1))}
            className="rounded-md border border-brand bg-brand-soft px-2.5 py-1 text-[12.5px] font-medium text-brand hover:bg-indigo-100"
          >
            {i === n - 1 ? "Finish ›" : "Next ›"}
          </button>
        </div>
      </div>

      <SystemDiagram diagram={diagram} visible={visible} bare />

      <div className="mt-4 flex gap-3 rounded-lg border border-sky-200 bg-sky-50/60 p-3">
        <span className="mt-0.5 h-fit shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-sky-700">
          🎙 SAY
        </span>
        <p className="text-[14px] leading-relaxed text-slate-700">
          {steps![i].say}
        </p>
      </div>
    </section>
  );
}
