import fs from "node:fs";
import path from "node:path";
import GithubSlugger from "github-slugger";

// ---------------------------------------------------------------------------
// Filesystem-backed manifest for the notes library (content/notes/**/*.md).
// Read at build time by the sidebar, the /notes route, and the lookup index.
// ---------------------------------------------------------------------------

const ROOT = path.join(process.cwd(), "content/notes");

export interface Doc {
  slug: string; // e.g. "dsa-mastery/04-hashing-internals"
  title: string;
  order: number;
  suite: string;
  group: string; // "" for top-level docs of a suite
}
export interface Group {
  name: string;
  docs: Doc[];
}
export interface Suite {
  key: string;
  name: string;
  emoji: string;
  count: number;
  groups: Group[];
}

const SUITE_META: Record<string, { name: string; emoji: string; blurb: string }> = {
  "dsa-mastery": {
    name: "DSA Mastery",
    emoji: "🧮",
    blurb: "JVM-level data structures & algorithms, from source to interview.",
  },
  "interview-prep": {
    name: "Interview Prep",
    emoji: "🎓",
    blurb: "Patterns, frameworks, study plan, behavioral, negotiation.",
  },
  "platform-notes": {
    name: "Platform Notes",
    emoji: "🏗️",
    blurb: "Kafka, databases, Redis, LLDs, deployments — deep internals.",
  },
  networkings: {
    name: "Networking",
    emoji: "🌐",
    blurb: "How networks actually work, from the wire up to DNS & TLS.",
  },
  "interview-discussions": {
    name: "Interview Discussions",
    emoji: "💬",
    blurb: "Full mock rounds: screening, internals, distributed, bar-raiser.",
  },
};

const GROUP_NAMES: Record<string, string> = {
  dbs: "Databases",
  "kafka-s": "Kafka",
  "kakfa-pulsar-other-pub-sub-workings": "Pub/Sub Internals",
  llds: "Low-Level Design",
  "system-designs": "System Designs",
  deployments: "Deployments",
  "v2/redis-valkey": "Redis / Valkey",
  "v2/mysql": "MySQL",
  solutions: "Solutions",
  interviews: "Interviews",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function titleOf(file: string, fallback: string): string {
  try {
    const text = fs.readFileSync(file, "utf8");
    const m = text.match(/^\s*#\s+(.+?)\s*$/m);
    if (m) return m[1].replace(/[*_`]/g, "").trim();
  } catch {}
  return fallback;
}

function orderOf(name: string): number {
  const m = name.match(/^([0-9]+)/);
  if (m) return parseInt(m[1], 10);
  if (/^A[-.]/i.test(name) || /^index/i.test(name)) return -1; // index/appendix first
  return 999;
}

function prettyName(seg: string): string {
  return seg
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

let cached: Suite[] | null = null;

export function getSuites(): Suite[] {
  if (cached) return cached;
  const files = fs.existsSync(ROOT) ? walk(ROOT) : [];
  const docs: Doc[] = files.map((f) => {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const slug = rel.replace(/\.md$/, "");
    const parts = rel.split("/");
    const suite = parts[0];
    const group = parts.slice(1, -1).join("/");
    const base = parts[parts.length - 1];
    return {
      slug,
      title: titleOf(f, prettyName(base.replace(/\.md$/, ""))),
      order: orderOf(base),
      suite,
      group,
    };
  });

  const suiteKeys = Object.keys(SUITE_META).filter((k) =>
    docs.some((d) => d.suite === k),
  );

  cached = suiteKeys.map((key) => {
    const meta = SUITE_META[key];
    const suiteDocs = docs.filter((d) => d.suite === key);
    const groupKeys = Array.from(new Set(suiteDocs.map((d) => d.group)));
    // top-level group ("") first, then the rest alphabetically
    groupKeys.sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
    const groups: Group[] = groupKeys.map((g) => ({
      name: g === "" ? "" : GROUP_NAMES[g] ?? prettyName(g.split("/").pop()!),
      docs: suiteDocs
        .filter((d) => d.group === g)
        .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
    }));
    return { key, name: meta.name, emoji: meta.emoji, count: suiteDocs.length, groups };
  });
  return cached;
}

export function getSuiteMeta(key: string) {
  return SUITE_META[key];
}

export function allDocs(): Doc[] {
  return getSuites().flatMap((s) => s.groups.flatMap((g) => g.docs));
}

export function getAllSlugs(): string[][] {
  return allDocs().map((d) => d.slug.split("/"));
}

export interface Heading {
  depth: number;
  text: string;
  id: string;
}

// Extract h2/h3 headings with ids matching rehype-slug (github-slugger), so the
// TOC anchors line up with the rendered heading ids.
export function extractHeadings(content: string): Heading[] {
  const slugger = new GithubSlugger();
  const out: Heading[] = [];
  let inFence = false;
  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (!m) continue;
    const depth = m[1].length;
    const text = m[2]
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*?([^*]+)\*\*?/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .trim();
    const id = slugger.slug(text); // advance counters for every heading
    if (depth === 2 || depth === 3) out.push({ depth, text, id });
  }
  return out;
}

export function getDoc(slugParts: string[]): { title: string; content: string; suite: string; dir: string } | null {
  const rel = slugParts.join("/");
  const file = path.join(ROOT, `${rel}.md`);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, "utf8");
  const title = titleOf(file, prettyName(slugParts[slugParts.length - 1]));
  return {
    title,
    content,
    suite: slugParts[0],
    dir: slugParts.slice(0, -1).join("/"),
  };
}
