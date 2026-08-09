import type { CatalogCategory } from "@/lib/types";
import { readySlugs } from "./ready-slugs";

// The full curriculum. `ready: true` means the problem is fully authored and
// links to its course page; everything else renders a "coming soon" stub that
// is ready to be filled in as designs arrive.
export const catalog: CatalogCategory[] = [
  {
    num: 1,
    name: "Foundations",
    emoji: "🧱",
    problems: [
      { num: "1.1", slug: "design-url-shortener", title: "Design a URL Shortener", ready: true },
    ],
  },
  {
    num: 2,
    name: "Data & Storage",
    emoji: "🗄️",
    problems: [
      { num: "2.1", slug: "ad-click-aggregator", title: "Design an Ad Click Aggregator" },
      { num: "2.2", slug: "news-aggregator", title: "Design a News Aggregator" },
      { num: "2.3", slug: "price-tracking-service", title: "Design a Price Tracking Service" },
      { num: "2.4", slug: "web-crawler", title: "Design a Web Crawler" },
      { num: "2.5", slug: "ad-exchange-rtb", title: "Design an Ad Exchange / RTB Platform" },
      { num: "2.6", slug: "dropbox", title: "Design Dropbox" },
      { num: "2.7", slug: "object-storage", title: "Design Object Storage" },
      { num: "2.8", slug: "youtube-top-k", title: "Design YouTube Top K" },
    ],
  },
  {
    num: 3,
    name: "Infrastructure",
    emoji: "🧰",
    problems: [
      { num: "3.1", slug: "rate-limiter", title: "Design a Rate Limiter" },
      { num: "3.2", slug: "distributed-cache", title: "Design a Distributed Cache" },
      { num: "3.3", slug: "metrics-monitoring", title: "Design a Metrics Monitoring System" },
      { num: "3.4", slug: "job-scheduler", title: "Design a Job Scheduler" },
      { num: "3.5", slug: "notification-system", title: "Design a Notification System" },
    ],
  },
  {
    num: 4,
    name: "Platform Engineering",
    emoji: "🛠️",
    problems: [
      { num: "4.1", slug: "tagging-system", title: "Design a Tagging System" },
      { num: "4.2", slug: "github", title: "Design GitHub" },
      { num: "4.3", slug: "leetcode", title: "Design LeetCode" },
      { num: "4.4", slug: "multi-tenant-saas", title: "Design a Multi-Tenant SaaS Platform" },
    ],
  },
  {
    num: 5,
    name: "Real-Time & Streaming",
    emoji: "📡",
    problems: [
      { num: "5.1", slug: "fb-live-comments", title: "Design FB Live Comments" },
      { num: "5.2", slug: "strava", title: "Design Strava" },
      { num: "5.3", slug: "google-maps", title: "Design Google Maps" },
      { num: "5.4", slug: "local-delivery", title: "Design a Local Delivery Service" },
      { num: "5.5", slug: "uber", title: "Design Uber" },
    ],
  },
  {
    num: 6,
    name: "Social & Marketplace",
    emoji: "🛍️",
    problems: [
      { num: "6.1", slug: "fb-post-search", title: "Design FB Post Search" },
      { num: "6.2", slug: "news-feed", title: "Design a News Feed / Timeline" },
      { num: "6.3", slug: "search-autocomplete", title: "Design a Search Autocomplete" },
      { num: "6.4", slug: "tinder", title: "Design Tinder" },
      { num: "6.5", slug: "yelp", title: "Design Yelp" },
      { num: "6.6", slug: "ecommerce-flash-sales", title: "Design E-Commerce Flash Sales" },
      { num: "6.7", slug: "instagram", title: "Design Instagram" },
      { num: "6.8", slug: "online-auction", title: "Design an Online Auction" },
      { num: "6.9", slug: "payment-system", title: "Design a Payment System" },
      { num: "6.10", slug: "robinhood", title: "Design Robinhood" },
      { num: "6.11", slug: "shazam", title: "Design Shazam" },
      { num: "6.12", slug: "ticketmaster", title: "Design Ticketmaster" },
      { num: "6.13", slug: "youtube", title: "Design YouTube" },
    ],
  },
  {
    num: 7,
    name: "AI & Collaboration",
    emoji: "🤖",
    problems: [
      { num: "7.1", slug: "chat-e2ee", title: "Design a Chat System with E2EE" },
      { num: "7.2", slug: "ai-agent-restaurant", title: "Design AI Agent Platform for Restaurant Ops" },
      { num: "7.3", slug: "ai-software-engineer", title: "Design an AI Software Engineer" },
      { num: "7.4", slug: "chatgpt", title: "Design ChatGPT" },
      { num: "7.5", slug: "google-docs", title: "Design Google Docs" },
      { num: "7.6", slug: "rag-platform", title: "Design a RAG Platform" },
      { num: "7.7", slug: "vector-database", title: "Design a Vector Database" },
      { num: "7.8", slug: "llm-inference-serving", title: "Design an LLM Inference Serving Stack" },
      { num: "7.9", slug: "distributed-training-70b", title: "Design Distributed Training for a 70B Model" },
      { num: "7.10", slug: "llm-evaluation", title: "Design an LLM Evaluation Platform" },
      { num: "7.11", slug: "llm-safety-moderation", title: "Design an LLM Safety & Content Moderation Pipeline" },
      { num: "7.12", slug: "ai-model-rollout", title: "Design AI Model Rollout & Monitoring" },
    ],
  },
];

// Mark a problem "ready" iff its content file was authored (see ready-slugs.ts).
for (const cat of catalog) {
  for (const p of cat.problems) {
    p.ready = readySlugs.has(p.slug);
  }
}

export const totalProblems = catalog.reduce((n, c) => n + c.problems.length, 0);
export const readyCount = catalog.reduce(
  (n, c) => n + c.problems.filter((p) => p.ready).length,
  0,
);

export function findProblemMeta(slug: string) {
  for (const cat of catalog) {
    const p = cat.problems.find((x) => x.slug === slug);
    if (p) return { ...p, category: cat.name };
  }
  return null;
}
