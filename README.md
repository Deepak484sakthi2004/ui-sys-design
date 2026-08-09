# System Design Interview Prep

A hands-on, data-driven **system design interview course**. Every problem is taught
the same way, across six tabs:

| Tab | What it gives you |
|-----|-------------------|
| ▤ **Requirements** | Functional + non-functional requirements, with P0/P1/P2 priorities and latency/throughput budgets |
| 📖 **Learn** | Concept teardowns — why each idea exists, the options it beat, a "picture it" panel, and a spaced-repetition *Remember this* card |
| ⚡ **Cheat Sheet** | The whole design in one breath, the read/write/async flow paths, and Numbers / Decisions / Must-mention columns |
| 🎯 **Rehearse** | A timed ~40-minute interview playbook — exactly what to *do and say*, phase by phase |
| 🏅 **Get Scored** | L4 / L5 / L6 signal bars, red flags that tank your score, and common follow-up Q&A |
| 🚀 **Go Deeper** | A full written walkthrough plus the foundations referenced |

Each problem also opens with a colour-coded **system diagram** (read / write / analytics lanes).

## Curriculum

**48 problems across 7 tracks** — Foundations, Data & Storage, Infrastructure,
Platform Engineering, Real-Time & Streaming, Social & Marketplace, and
AI & Collaboration.

## Tech stack

- **Next.js 15** (App Router, static generation)
- **React 19**
- **Tailwind CSS v4**
- TypeScript throughout

The whole app is data-driven: one problem = one file in [`data/problems/`](./data/problems)
exporting a `Problem` object (see the schema in [`lib/types.ts`](./lib/types.ts)).
Register it in [`data/problems/index.ts`](./data/problems/index.ts) and it renders
across all six tabs automatically.

## Local development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
```

## Adding a new problem

1. Create `data/problems/<slug>.ts` exporting a `Problem` (copy `url-shortener.ts`).
2. Add it to the map in `data/problems/index.ts`.
3. Set `ready: true` for its entry in `data/catalog.ts`.

---

Course structure inspired by the Cracking Walnuts problem layout; all content is
authored for study.
