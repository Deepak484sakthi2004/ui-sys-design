# Chapter 1: Levels, Loops & Rubrics

> **Relearning log.** The thing I'd completely lost track of: *the interview doesn't score whether
> you're a good engineer — it scores a specific list of signals, and the level you get is decided
> by a committee reading written feedback, not by the people who met you.* Once I internalized
> that the interviewer is **a note-taker for a committee**, everything changed. My job in the room
> is not to impress one person; it's to *generate quotable evidence* that the committee can use to
> justify a level. "Candidate independently identified the bottleneck and proposed sharding by
> tenant" is a hire-signal sentence. "Seemed smart" is not. I now optimize every answer for the
> sentence the interviewer will type.

This chapter is my map of the terrain: what the levels mean, what the loop looks like at each
company, and — the part that actually matters — **what each round is scoring**.

---

## 1.1 The level ladder (and why it's the whole game)

The same coding round can produce a "no hire," an "L4 hire," or an "L5 hire" depending on **scope of
demonstrated autonomy and judgment**, not depth of trivia. The rough equivalence across companies:

| Band | Google | Meta | Microsoft | Amazon (ref) | What it means |
|------|--------|------|-----------|--------------|---------------|
| Entry | L3 | E3 | 59–60 | SDE I | New grad, executes well-scoped tasks |
| **Mid (career)** | **L4** | **E4** | **61–62** | SDE II | Owns a feature/component end-to-end with light guidance |
| **Senior** | **L5** | **E5** | **63–64** | SDE III | Owns ambiguous problems, drives across a team, mentors |
| Staff | L6 | E6 | 65–66 | Principal | Owns org-level technical direction |

> **The L4 → L5 line is the single most important thing to understand.** L4 is *"give me a
> well-defined problem and I'll solve it cleanly."* L5 is *"give me an ambiguous problem and I'll
> define it, choose the tradeoffs, and own the outcome."* Every round is secretly probing which
> side of that line you sit on.

**Concretely, the difference shows up as:**

| Dimension | L4 behavior | L5 behavior |
|-----------|-------------|-------------|
| Requirements | Accepts the problem as stated | *Surfaces* the unstated requirements, scopes them |
| Tradeoffs | Picks a reasonable option | Names 2–3 options, picks one *and says what it costs* |
| Coding | Correct, clean | Correct, clean, **plus** anticipates edge cases and discusses where it'd break at scale |
| Design | Produces a working architecture | Drives the conversation, owns the bottleneck analysis |
| Behavioral | "I did X" | "I saw the team was about to do the wrong thing, I drove the decision, here's the measurable impact" |

I keep this table open while I practice. After every mock answer I ask: *did that sound L4 or L5?*

---

## 1.2 The loops, company by company

### Google

```
Recruiter screen → Phone screen (1 coding, 45 min) → Onsite (4–5 rounds)
                                                       ├─ 2× Coding (DSA, 45 min each)
                                                       ├─ 1× System Design (L5+; L4 sometimes)
                                                       ├─ 1× "Googleyness & Leadership" (behavioral)
                                                       └─ sometimes a 2nd design or a domain round
→ Feedback written → Hiring Committee (HC) decides hire + level
→ Team Match (you find a team that wants you) → Comp committee
```

Google specifics that bit me when I forgot them:
- **Hiring is decoupled from team.** You can be a "hire" with no team, then team-match. This means
  the loop is generic; you can't lean on domain expertise to carry you.
- **The committee never met you.** Interviewers write detailed feedback with *quotes and a
  recommendation* (Strong Hire / Hire / Lean Hire / No Hire) per round. The HC reads only the
  writeups. → Generate quotable evidence.
- **Coding bar is high and "clean code" matters** — they read your code as an artifact. Compilable,
  named-well, edge-cases handled.
- **"Googleyness"** ≈ comfort with ambiguity, intellectual humility, collaboration, bias to action,
  doing the right thing. Covered in detail in [Chapter 20](20-company-signals-and-leadership-principles.md).

### Meta

```
Recruiter → Phone screen (1–2 coding, 45 min) → Onsite "the loop" (4–5 rounds)
                                                  ├─ 2× Coding ("Ninja", 2 problems in 35–40 min)
                                                  ├─ 1–2× System Design (or "Product Architecture")
                                                  └─ 1× Behavioral ("Jedi" — signals below)
→ Debrief → Level decided in debrief/committee → Team match (often pre-decided)
```

Meta specifics:
- **Two problems per coding round, ~18 min each.** Speed matters more than at Google. You must
  recognize the pattern fast and implement without floundering.
- **The behavioral round ("Jedi") is real and weighted.** Meta scores: *Motivation/Drive,
  Conflict/Collaboration, Growth, and "what would your peers say."* They want concrete impact.
- **Design round bifurcates:** infra system design vs. "product architecture" (e.g., design
  Instagram Stories' data model + API). For L5 you should be able to do both.
- Meta moves fast and is direct. Mirror that: be concise, decisive.

### Microsoft

```
Recruiter → 1 phone/online screen → Onsite ("loop", 4–5 rounds)
                                     ├─ 2–3× Coding (DSA, sometimes practical/debugging)
                                     ├─ 1× System Design (for 62+) and/or LLD
                                     ├─ 1× behavioral woven into technical rounds
                                     └─ "As Appropriate" (AA) round — a senior/hiring-manager
                                        round with go/no-go weight
→ Debrief → level decided
```

Microsoft specifics:
- **Levels are numeric (59–63 for IC SDE track up to Senior).** 61/62 ≈ L4-ish, 63 ≈ Senior/L5.
- **The "As Appropriate" round** is the swing vote — a senior person who synthesizes the loop and
  has strong influence. Treat it as the most important round.
- More variety: you may get a **debugging/practical** round or an LLD round. Microsoft cares about
  pragmatism and shipping, and increasingly about **growth mindset** (Satya-era culture).
- Behavioral is less formalized than Meta but present in every round ("tell me about a project").

> **Cross-company truth I keep forgetting:** the *coding* bar is roughly the same everywhere
> (medium-hard LeetCode, clean code, 35–45 min). The companies differ mostly in **speed (Meta),
> code-as-artifact rigor (Google), and pragmatism/AA-round weight (Microsoft).** Behavioral framing
> differs but the underlying signals (impact, collaboration, ambiguity) are nearly identical.

---

## 1.3 What each round is *actually* scoring

This is the rubric I rebuild from memory before every loop. Interviewers map your behavior to a
small number of axes. If I hit the axes explicitly, I make their note-taking — and my level — easy.

### Coding round rubric (all three companies)

| Axis | What earns the signal | What kills it |
|------|----------------------|---------------|
| **Problem solving** | Clarify → examples → brute force stated → optimize with reasoning | Jumping to code; silence; guessing |
| **Coding** | Correct, clean, idiomatic, compiles | Pseudocode that hides bugs; sloppy naming |
| **Communication** | Narrate the plan *before* coding; think out loud | Long silences; interviewer has to pull it out |
| **Verification** | Walk through an example, find your own bugs, state complexity | "I think it works"; interviewer finds the bug |
| **(L5) Judgment** | Anticipate edge cases & scale limits unprompted | Only handles the happy path |

> The verification axis is the cheapest signal to win and the one I most often skip under pressure.
> *Always trace one concrete example through the finished code, out loud.* It catches bugs and it's
> an explicit scored axis.

### System design round rubric

| Axis | L4 bar | L5 bar |
|------|--------|--------|
| **Requirements** | Asks clarifying Qs | Drives scoping; states functional + non-functional + scale |
| **Estimation** | Can do basic math if prompted | Volunteers QPS/storage math, sizes the system |
| **High-level design** | Reasonable boxes & arrows | Clean decomposition with clear data flow |
| **Deep dive** | Goes deep where asked | *Chooses* the interesting bottleneck and goes deep unprompted |
| **Tradeoffs** | Mentions some | Frames every choice as a tradeoff with cost |
| **Driving** | Answers questions | Owns the whiteboard, manages time, "let me cover X next" |

### Behavioral round rubric

| Signal | The question behind the question |
|--------|----------------------------------|
| **Impact / scope** | How big a thing can you own? (the level decider) |
| **Drive / ownership** | Do you push through ambiguity and obstacles? |
| **Collaboration / conflict** | Can you disagree well and bring people along? |
| **Growth / self-awareness** | Do you learn from failure? (Microsoft loves this) |
| **Values fit** | Googleyness / Meta values / MSFT model-coach-care |

Detailed treatment in [Chapter 19](19-behavioral-star-and-story-bank.md) and
[Chapter 20](20-company-signals-and-leadership-principles.md).

---

## 1.4 Comp context (90+ LPA, India)

I'm targeting **90+ LPA total comp**. Rough India bands as of my prep (varies by city, team, and
market — verify at offer time, don't anchor on this):

| Level | Approx total comp (India, ₹/yr) | Structure |
|-------|--------------------------------|-----------|
| L4 / E4 / MSFT 61–62 | ~₹45–90 L | Base + sizable RSU + joining bonus |
| L5 / E5 / MSFT 63 | ~₹90 L–1.8 Cr+ | Base + large RSU (4-yr vest) + bonus |

> **90+ LPA in India lands squarely at the senior band (L5/E5/63) for most teams, or a strong L4
> offer at the higher-paying orgs.** Practically: I should prepare to the **L5 bar** even if I'm
> open to an L4 offer — preparing to the higher bar de-risks both, and the comp target demands it.

Key comp components to understand before [Chapter 21 (Negotiation)](21-negotiation-and-offer.md):
- **Base** — cash, modest range, hard to move much.
- **RSU / stock** — the big lever at senior levels; vests over 4 years (often front-loaded or
  even now at some companies). This is where 90+ LPA actually comes from.
- **Joining/sign-on bonus** — one-time, negotiable, used to bridge gaps.
- **Level** — moving up one level is worth more than any single negotiation on a fixed level.
  *Negotiating the level is the highest-leverage move.*

---

## Interview Drills

- **D1.1 [E]** For each company (Google/Meta/Microsoft), name the round that carries
  disproportionate weight and why. *(Google: HC reads writeups → quotable evidence; Meta: behavioral
  "Jedi" + speed in coding; MSFT: the "As Appropriate" round.)*
- **D1.2 [M]** Rewrite this L4 sentence as an L5 one: "I implemented the caching layer the tech lead
  designed." *(e.g., "I noticed our p99 was cache-miss-bound, proposed and designed a two-tier cache,
  and drove the rollout that cut p99 by 40%.")*
- **D1.3 [M]** You finish a coding problem with 8 minutes left. List the three things you do with
  that time to maximize signal. *(Trace an example out loud; state time/space complexity; discuss
  edge cases & how it scales / what you'd change in prod.)*
- **D1.4 [H]** Your target is 90 LPA. The offer comes in at L4 with 75 LPA. What are your two
  highest-leverage levers and which matters more? *(Level bump to L5 > comp negotiation on RSU;
  level compounds.)*

## Key Takeaways

1. **The interviewer is a note-taker for a committee that never met you.** Generate quotable,
   level-justifying evidence.
2. **L4 = solve a defined problem cleanly; L5 = define and own an ambiguous one.** Every round
   probes this line. Prepare to the L5 bar.
3. **The coding bar is similar everywhere;** companies differ in speed (Meta), code rigor (Google),
   and the swing-vote round (MSFT's "As Appropriate").
4. **Each round scores a small fixed set of axes.** Hit them explicitly — especially the cheap ones
   (verification in coding, tradeoff-naming in design).
5. **For 90+ LPA in India, prepare to senior (L5/E5/63);** negotiating *level* beats negotiating
   comp on a fixed level.
