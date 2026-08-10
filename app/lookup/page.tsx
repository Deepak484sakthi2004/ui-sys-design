import { getSuites } from "@/lib/notes";
import { catalog } from "@/data/catalog";
import { problems } from "@/data/problems";
import { Lookup, type LookupItem } from "@/components/Lookup";

export const metadata = { title: "Last-Minute Lookup — System Design Prep" };

export default function LookupPage() {
  const suites = getSuites();

  const noteItems: LookupItem[] = suites.flatMap((s) =>
    s.groups.flatMap((g) =>
      g.docs.map((d) => ({
        title: d.title,
        href: `/notes/${d.slug}`,
        kind: s.name,
        emoji: s.emoji,
        sub: g.name || undefined,
      })),
    ),
  );

  const ready = new Set(Object.keys(problems));
  const sdItems: LookupItem[] = catalog.flatMap((c) =>
    c.problems
      .filter((p) => ready.has(p.slug))
      .map((p) => ({
        title: p.title,
        href: `/${p.slug}`,
        kind: "System Design",
        emoji: "🔗",
        sub: c.name,
      })),
  );

  const items = [...sdItems, ...noteItems];

  const pinned = noteItems.filter((it) =>
    /cheat|glossary|index|final week|back.?of.?envelope|framework|rubric/i.test(
      it.title,
    ),
  );

  return <Lookup items={items} pinned={pinned} />;
}
