"use client";

import { useState } from "react";
import type { Problem, ScoreLevel, FollowUp } from "@/lib/types";

const levelBorder = ["border-amber-300", "border-slate-300", "border-violet-300"];
const levelBg = ["bg-amber-50/40", "bg-slate-50/60", "bg-violet-50/40"];

function LevelCard({ lvl, i }: { lvl: ScoreLevel; i: number }) {
  return (
    <div
      className={`rounded-xl border-t-4 ${levelBorder[i]} border-x border-b border-[var(--border)] ${levelBg[i]} p-4`}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg">{lvl.emoji}</span>
        <div>
          <div className="text-[14px] font-semibold text-ink">{lvl.title}</div>
          <div className="text-[11px] font-medium text-slate-500">{lvl.tag}</div>
        </div>
      </div>
      <p className="mt-2 text-[12.5px] italic leading-relaxed text-slate-600">
        {lvl.summary}
      </p>

      <div className="mt-3 text-[10.5px] font-semibold uppercase tracking-wide text-emerald-600">
        ◔ Signals
      </div>
      <ul className="mt-1.5 space-y-1.5">
        {lvl.signals.map((s, j) => (
          <li key={j} className="flex gap-1.5 text-[12px] leading-snug text-slate-700">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-emerald-400" />
            {s}
          </li>
        ))}
      </ul>

      {lvl.gaps.length > 0 && (
        <>
          <div className="mt-3 text-[10.5px] font-semibold uppercase tracking-wide text-rose-500">
            ⚠ {lvl.gapsLabel}
          </div>
          <ul className="mt-1.5 space-y-1.5">
            {lvl.gaps.map((g, j) => (
              <li key={j} className="flex gap-1.5 text-[12px] leading-snug text-slate-500">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-rose-300" />
                {g}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function FollowUpItem({ f }: { f: FollowUp }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-white">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-[13.5px] font-medium text-ink hover:bg-slate-50"
      >
        <span className="flex items-center gap-2">
          <span className="text-slate-400">{open ? "▾" : "▸"}</span>
          {f.q}
        </span>
      </button>
      {open && (
        <div className="reveal-in border-t border-[var(--border)] bg-slate-50/60 px-4 py-3 text-[13px] leading-relaxed text-slate-700">
          {f.a}
        </div>
      )}
    </div>
  );
}

export function GetScoredTab({ problem }: { problem: Problem }) {
  const { levels, redFlags, followUps } = problem.scoring;
  return (
    <div className="space-y-7">
      <div>
        <h2 className="flex items-center gap-2 text-[17px] font-semibold text-ink">
          🏅 Interview Grading by Level
        </h2>
        <p className="mt-1 text-[14px] text-slate-600">
          What an interviewer at each level expects to see in your answer. Use
          this to calibrate, not to perform.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {levels.map((lvl, i) => (
          <LevelCard key={lvl.tag} lvl={lvl} i={i} />
        ))}
      </div>

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-ink">
          🚩 Red Flags That Tank Your Score
        </h3>
        <p className="mb-3 text-[13px] text-slate-600">
          Any one of these, said without justification, drops the interviewer&apos;s
          read of your level on the spot.
        </p>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {redFlags.map((r, i) => (
            <div
              key={i}
              className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50/50 px-3 py-2.5 text-[13px] leading-relaxed text-slate-700"
            >
              <span className="shrink-0 text-rose-500">✕</span>
              {r}
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-ink">
          ❓ Common Follow-up Questions
        </h3>
        <p className="mb-3 text-[13px] text-slate-600">
          Questions an interviewer is likely to ask after your walkthrough.
          Rehearse the short answer.
        </p>
        <div className="space-y-2">
          {followUps.map((f, i) => (
            <FollowUpItem key={i} f={f} />
          ))}
        </div>
      </div>
    </div>
  );
}
