import type { Problem, Teardown, PictureRow } from "@/lib/types";
import { RememberCard } from "@/components/RememberCard";

const rowTone: Record<string, string> = {
  good: "border-emerald-200 bg-emerald-50",
  bad: "border-rose-200 bg-rose-50",
  neutral: "border-slate-200 bg-slate-50",
  used: "border-amber-200 bg-amber-50",
};

function PictureRowItem({ row }: { row: PictureRow }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-[13px] ${rowTone[row.tone ?? "neutral"]}`}
    >
      <div className="font-mono font-semibold text-ink">{row.label}</div>
      <div className="mt-0.5 text-slate-600">{row.value}</div>
    </div>
  );
}

function TeardownCard({ t }: { t: Teardown }) {
  return (
    <article className="rounded-xl border border-[var(--border)] bg-white p-5">
      <div className="mb-3 flex items-center gap-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand text-[13px] font-semibold text-white">
          {t.n}
        </span>
        <h3 className="text-[16px] font-semibold text-ink">{t.title}</h3>
      </div>

      {t.body.map((p, i) => (
        <p key={i} className="mb-3 text-[14px] leading-relaxed text-slate-700">
          {p}
        </p>
      ))}

      {t.bullets && (
        <ul className="mb-4 space-y-2">
          {t.bullets.map((b, i) => (
            <li key={i} className="flex gap-2 text-[14px] leading-relaxed text-slate-700">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
              <span>
                {b.lead && (
                  <strong className="font-semibold text-ink">{b.lead} </strong>
                )}
                {b.text}
              </span>
            </li>
          ))}
        </ul>
      )}

      {t.pictureTitle && (
        <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            ✎ Picture it
          </div>
          <div className="text-[14px] font-semibold text-ink">
            {t.pictureTitle}
          </div>
          {t.pictureCaption && (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 font-mono text-[11.5px] text-amber-800">
              {t.pictureCaption}
            </div>
          )}
          {t.pictureRows && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {t.pictureRows.map((r, i) => (
                <PictureRowItem key={i} row={r} />
              ))}
            </div>
          )}
        </div>
      )}

      {t.remember && <RememberCard card={t.remember} />}
    </article>
  );
}

export function LearnTab({ problem }: { problem: Problem }) {
  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-[17px] font-semibold text-ink">
            🧩 Concept Teardowns
          </h2>
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
            Read once, never re-cram
          </span>
        </div>
        <p className="mt-1 text-[14px] text-slate-600">
          Each idea built from the ground up: why it exists, the options it beat,
          a picture, and a memory anchor. This is the part you pay for, so slow
          down here.
        </p>
      </div>

      {problem.learn.map((t) => (
        <TeardownCard key={t.n} t={t} />
      ))}
    </div>
  );
}
