import { Fragment } from "react";

// Renders inline **bold** and "quoted script" segments. Used by the playbook
// steps where scripts and emphasis are inlined in the source text.
export function Rich({ text }: { text: string }) {
  // Split on **bold** first, then style "quotes" inside plain runs.
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="font-semibold text-ink">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <Fragment key={i}>{styleQuotes(part, i)}</Fragment>;
      })}
    </>
  );
}

function styleQuotes(text: string, key: number) {
  const segs = text.split(/("[^"]+")/g);
  return segs.map((s, j) => {
    if (s.startsWith('"') && s.endsWith('"')) {
      return (
        <span
          key={`${key}-${j}`}
          className="rounded bg-slate-100 px-1 font-mono text-[0.85em] text-slate-700"
        >
          {s.slice(1, -1)}
        </span>
      );
    }
    return <Fragment key={`${key}-${j}`}>{s}</Fragment>;
  });
}
