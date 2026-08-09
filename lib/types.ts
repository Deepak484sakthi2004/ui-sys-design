// ---------------------------------------------------------------------------
// Core content model. Every problem in the course is a single object of type
// `Problem`. The UI is fully data-driven: hand me a new system design and it
// becomes one more file in data/problems that renders across all six tabs.
// ---------------------------------------------------------------------------

export type Priority = "P0" | "P1" | "P2";
export type Level = "Foundational" | "Easy" | "Medium" | "Hard";

export interface CatalogProblem {
  num: string; // "1.1"
  slug: string; // "design-url-shortener"
  title: string; // "Design a URL Shortener"
  ready?: boolean; // fully authored vs. coming soon
}

export interface CatalogCategory {
  num: number;
  name: string;
  emoji: string;
  problems: CatalogProblem[];
}

// --- Requirements tab -------------------------------------------------------
export interface Requirement {
  id: string; // "FR-01"
  text: string;
  tag: string; // priority "P0" or NFR budget "p99 < 5ms"
}

// --- Learn tab (concept teardowns) -----------------------------------------
export interface PictureRow {
  label: string;
  value: string;
  tone?: "good" | "bad" | "neutral" | "used";
}
export interface RememberCard {
  problem: string;
  solution: string;
  why: string;
  tradeoff: string;
  failure: string;
  mitigation: string;
}
export interface Teardown {
  n: number;
  title: string;
  body: string[]; // paragraphs
  bullets?: { lead?: string; text: string }[];
  pictureTitle?: string;
  pictureCaption?: string; // the amber "used" line
  pictureRows?: PictureRow[];
  remember?: RememberCard;
}

// --- Cheat Sheet tab --------------------------------------------------------
export interface FlowPath {
  kind: "read" | "write" | "analytics";
  title: string;
  summary: string;
  steps: { label: string; note?: string }[];
}
export interface CheatColumn {
  heading: string;
  icon: string;
  items: string[];
}
export interface CheatSheet {
  oneBreath: string[];
  flows: FlowPath[];
  columns: CheatColumn[]; // Numbers / Decisions / Must mention
}

// --- Rehearse tab (playbook) -----------------------------------------------
export type SayKind = "ASK" | "SAY" | "WRITE" | "DRAW" | "RULE OUT";
export interface PlaybookStep {
  kind: SayKind;
  text: string; // may contain **bold** and "quoted script"
}
export interface PlaybookPhase {
  n: number;
  title: string;
  minutes: number;
  goal: string;
  why: string;
  steps: PlaybookStep[];
  grading: string;
}

// --- Get Scored tab ---------------------------------------------------------
export interface ScoreLevel {
  tag: string; // "L4 / SDE-II"
  title: string; // "Mid-Level Engineer"
  emoji: string;
  summary: string;
  signals: string[];
  gaps: string[];
  gapsLabel: string;
}
export interface FollowUp {
  q: string;
  a: string;
}

// --- Go Deeper tab ----------------------------------------------------------
export interface DeepDive {
  intro: string;
  sections: { heading: string; body: string[] }[];
}

// --- Diagram ----------------------------------------------------------------
export interface DiagramNode {
  id: string;
  label: string;
  sub?: string;
  mono?: string; // dashed inner mono chip e.g. "counter → Feistel → B62"
  col: number; // grid column 1..5
  row: number; // grid row 1..N
  tone: "green" | "purple" | "orange" | "blue" | "slate";
}
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  kind: "read" | "write" | "analytics";
}
export interface Diagram {
  caption: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  legend: { kind: "read" | "write" | "analytics"; text: string }[];
}

// --- The whole problem ------------------------------------------------------
export interface Problem {
  slug: string;
  num: string;
  title: string;
  level: Level;
  deepDiveAvailable?: boolean;
  intro: string[]; // description paragraphs
  hardParts?: string;
  keyTopics: string[];
  foundationsReferenced: { label: string; tone: string }[];
  diagram: Diagram;
  requirements: {
    functional: Requirement[];
    nonFunctional: Requirement[];
  };
  learn: Teardown[];
  cheatSheet: CheatSheet;
  rehearse: PlaybookPhase[];
  scoring: {
    levels: ScoreLevel[];
    redFlags: string[];
    followUps: FollowUp[];
  };
  deepDive?: DeepDive;
}
