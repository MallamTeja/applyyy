# Harvest plan — `MadsLorentzen/ai-job-search` → `applyyy`

**Date:** 2026-09-16 · **Status:** proposed, nothing executed yet
**Evidence:** [`2026-09-16-ai-job-search-inventory.md`](2026-09-16-ai-job-search-inventory.md)

Nothing in this plan has been built. The only change made to the repo during recon was
one `.gitignore` rule (see §0). Everything below is a parcel waiting on a go/no-go.

---

## 0. What was actually done during recon

| Change | File | Why |
|---|---|---|
| Cloned upstream at `968fb1bd` | `reference/ai-job-search-upstream/` | Read-only harvest source |
| Added `reference/` ignore rule | `.gitignore:117` | See below |

The clone is 236 files carrying **its own `.git`**. Left untracked in a tree where five
sessions share one index, it is precisely the shape that `git add -A` sweeps into an
unrelated commit — the mechanism that has already fired three times in this repo. It is
also someone else's MIT code, which should not land inside a private repo holding a
real resume and CTC. Ignoring it removes the write-into-tree half of that combination.

`git check-ignore -v` confirms the rule is live.

---

## 1. The decision this plan exists to make

"Copy the features and code across" cannot be executed literally, because **most of
upstream's code is blocked by our own locked decisions**, not by effort:

- Python tools → violate *Node + TypeScript everywhere*
- LaTeX CV pipeline → violates *structured JSON master → HTML template → PDF*
- 4 of 6 portal adapters → Denmark-locked, useless for an India/remote search
- Slash commands → upstream is human-driven; we are unattended

Copying those in would import exactly the kind of stack coupling that `1on1_sb`'s Java
backend is forbidden from carrying into `1on1`. The same discipline applies here.

**So the harvest is: port three tools, adopt one rubric, steal one transport layer, and
build five features whose *designs* upstream has already specified.**

---

## 2. Parcels, ordered by value ÷ cost

Each parcel is a **write partition** — no two touch the same file, so they can run
concurrently across peer sessions.

### P1 — Shared HTTP transport ⭐ highest value ÷ cost

**Writes:** `supabase/functions/_shared/http/**` (currently an **empty directory**)

We have no shared retry/backoff/timeout anywhere. Upstream has it battle-tested in six
`helpers.ts` files with dedicated tests, and it is **pure WHATWG** — the same source
runs on Node 24 *and* in our Deno Edge Functions.

Port the contract as documented in the inventory (7 attempts, 429/5xx only, 500ms→8s
with additive jitter, 15s per-attempt timeout, exported UA constant, caller-chosen 404
behaviour). **Add what upstream lacks:** `Retry-After` support, a concurrency cap, a
configurable timeout.

Then collapse the duplicated fetch logic in `scout-ats/index.ts` onto it.

Test template: their `retry-backoff.test.ts` monkeypatches `globalThis.fetch` with a
scripted response array *and* replaces `setTimeout` with a 0ms version, so the
exhaustion case asserts `calls === 7` without sleeping through the real schedule.

### P2 — Robots gate (constraint #5)

**Writes:** new `packages/master-robots/**`

Today robots compliance is a **hand-maintained allowlist** with "checked by a human
2026-09-09" comments in `worker/scripts/capture-fixture.ts:26-34`. Honest, but
PROJECT_PLAN §13 needs **200–400 boards** for volume — a human-checked list does not
reach that.

Port `robots_check.py` fail-closed, keeping the soft-200 defence, the percent-decode,
and ties-to-`Disallow`. **Add** a per-host TTL cache and `Crawl-delay` enforcement,
both of which upstream lacks.

**Do not port the browser-UA fallback** without a ruling — see §4.

### P3 — Fit scoring rubric → Scorer agent

**Writes:** `supabase/functions/_shared/screen/**` + one migration for gate columns

Adopt gates → 5 dimensions → weights 30/25/15/30 → bands 75/60/45/30 verbatim as the
starting point. These are tested numbers from a search that produced 69 applications,
20 first interviews and a signed contract; inventing our own from nothing is strictly
worse.

Three adaptations: the Eligibility Gate is written for a visa-holder abroad and becomes
a generic hard-requirement gate for a domestic run; drop the salary dimension (no data
source exists); the company-research checklist becomes a tool-call plan, not a human
checklist.

**Persist gate verdicts as `PASS|FAIL|FLAG` plus the verbatim triggering line.** FAIL is
a veto independent of score; FLAG routes to the human bucket. This is our two-bucket
approval design arriving pre-specified.

### P4 — Job-key dedupe hardening (constraint #7)

**Writes:** `supabase/functions/_shared/normalize/fingerprint.ts` *(⚠ check ownership)*

Port hash-suffixed truncation. **Add** the URL canonicalisation upstream lacks (strip
`utm_*`/`gh_src`/`ref`, sort query params, drop fragment, lowercase host).

⚠ `fingerprint.ts` is existing, load-bearing code. Confirm its owner before writing.

### P5 — PDF layout regression checks

**Writes:** `packages/master-pdf/src/layout-checks.ts` + tests

Six geometric heuristics: empty page, internal hole, page-ends-early, footer collision,
thin final page, orphaned entry.

**Cheaper than the recon agent estimated.** It advised adding `pdfjs-dist` for word
bounding boxes. We already have that layer — `packages/master-pdf/src/layout.ts` builds
y-banded `LineBand`s with a measured `LINE_BAND_TOLERANCE_PT = 3`. And adding the dep
would violate a documented decision in `load-pdf.ts:4-23`: the package takes pdfjs
through a **structural type seam** precisely because `pnpm-lock.yaml` is single-owner
across five sessions.

So: port the heuristics onto `measurePage()`, and **retune the thresholds** — theirs are
calibrated for moderncv/LaTeX, ours run against HTML → `page.pdf()`.

### P6 — Supply: the `freehire` aggregator ⭐ biggest strategic lever

**Writes:** new `supabase/functions/_shared/ats/freehire.ts` + 1 enum migration + registry entry

PROJECT_PLAN §2 states the ~35/day ceiling is **supply-bound, not budget-bound**, and
that the thing to buy is *more boards*. We have three adapters. `freehire` aggregates
**~50 ATS platforms across many countries** through one JSON API, hydrates full
descriptions server-side (no per-hit detail call), and has zero runtime dependencies.

**Our schema already accommodates this.** `enums.sql:100-104` separates `discovery_source`
from `ats_provider` on purpose — *"a Greenhouse job is routinely discovered through
Adzuna"* — and `adzuna`/`jooble` are already values. Adding freehire is one
`alter type … add value`, with precedent in
`20260911235500_add_linkedin_post_discovery_source.sql`.

**Caveat, from their own docs:** tech-roles-first faceting, and a personal project with
**no SLA**. A supply *supplement*, never a sole source.

### P7 — Tailor node-selection scoring

**Writes:** `supabase/functions/_shared/tailor/**`

Implement Relevance × Uniqueness × NarrativeLoad as the node-selection ordering, plus
the four anti-fabrication rules (past-drafts-are-not-fact-sources, closed-year-range,
tenure-vs-output, keyword guard).

### P8 — Feature gaps (each a separate parcel)

`/interview` prep · `/html-report` export · `/expand` GitHub→competency enrichment ·
`/outcome` follow-up branch (10-day, max 2, draft-only) and 60-day stale sweep ·
`/gmail-sync` classification heuristics grafted onto `email-tracker-intake`.

---

## 3. Recommended first move

**P1 + P2 together, one session.** P1 is the cleanest port in the repo and fills an
empty directory nobody owns. P2 depends on P1's fetch wrapper and unblocks the
watchlist expansion that P6 needs. Neither touches a file another session is writing.

P6 is the highest strategic value but should follow P2 — polling 50 aggregated boards
without a programmatic robots gate is the wrong order.

---

## 4. Open questions — these need your ruling, not my assumption

### Q1 — LinkedIn, automated access

Upstream's `linkedin-search/SKILL.md:29-33` states plainly that automated LinkedIn
access **violates their ToS**: *"personal use only, keep volume low, not commercial,
not bulk."*

Our `enums.sql` comment reasons only about **applying**: *"LinkedIn auto-apply gets
accounts restricted under their User Agreement, so this value must never become a
submit path."* PROJECT_PLAN §2 locks *"Discovery only, human applies."*

The gap: our locked decision treats **discovery** as the safe side; upstream says
automated access **at all** is the violation. A human running it occasionally on a
laptop is the usage their doc permits — an unattended GitHub Actions cron is not.
Constraint #5 sits adjacent.

**I am not porting a LinkedIn adapter under a locked decision that may have been made
without this fact.** Options: (a) drop LinkedIn discovery entirely, (b) keep it
human-triggered from the dashboard only, (c) proceed as locked, having now seen this.

### Q2 — Robots browser-UA fallback

Port it or not? It only ever reads the *policy file* with a Chrome UA, then obeys it
strictly — defensible, but it is still presenting a browser UA to get past a bot
filter, which is arguably what constraint #5 prohibits. My recommendation: **omit it**;
treat a WAF-blocked robots.txt as `UNCONFIRMED` and refuse.

### Q3 — Salary — RULED 2026-09-16 by Teja. Not an open question.

**My recommendation to drop this was wrong, and it was wrong because I let upstream's
framing define the feature.** Recorded rather than edited away, because the mistake is
the instructive part: two features shared a name, and I inherited the wrong one.

- **Upstream's salary feature** answers *"what does this company typically pay?"* It
  needs an external dataset the user hand-writes. It ships empty, so upstream's feature
  is effectively dead. That is the one I costed, and the one I proposed dropping.
- **Teja's salary feature** answers *"is THIS POSTING'S stated range acceptable?"* It
  needs **no external dataset at all** — the number comes from the posting. Nothing
  about upstream's missing data source applies to it.

**The ruled behaviour:**

| Posting states | Verdict |
|---|---|
| No salary at all | **PASS — apply.** Absence of data is not a reason to skip, and must not score as a negative. |
| A range within the configured range | **PASS — apply.** |
| A range **below** the configured range | **FAIL — do not apply.** |
| A range **above** the configured range | **FAIL — do not apply.** A range far above target signals a seniority mismatch. |

**Design consequence:** this is a **gate**, not a weighted dimension — it behaves
exactly like upstream's Location gate (pass/fail, unweighted). It replaces upstream's
optional Salary Benchmark dimension entirely.

**Two implementation hazards**, both carried into `brief-3`:

1. Currency and period must be normalised (per-annum vs per-month vs per-hour) before
   any comparison. A range that cannot be parsed confidently is treated as **no salary
   → PASS**, never guessed — guessing a band is a constraint #2 fabrication.
2. The no-salary case is the one most likely to be implemented backwards, because every
   other row in the table is a filter. It has a dedicated test.

**One question left inside the ruling:** should *above range* be a hard FAIL or a FLAG
to the human bucket? It is the only rule where a false negative discards a genuinely
good opportunity. Raised in the brief; defaulting to FAIL as ruled.

Separately, upstream's tiered 0–100 **fuzzy company-name matcher** is still worth
porting — not for salary, but for company dedupe and watchlist joins, where it earns
its keep regardless. Its strip-patterns need retargeting from Danish legal suffixes
(`A/S`, `ApS`, `AMBA`) to `Pvt Ltd`, `Private Limited`, `Inc`, `LLC`.

---

## 5. Two audit findings, unrelated to the harvest

1. **`applyyy` has no `CLAUDE.md` and no `AGENTS.md`** — only `GEMINI.md`. The global
   CLAUDE.md says *"each repo's CLAUDE.md records what the rule looks like in that
   codebase"*, so that sentence points at a file that does not exist here. Every
   session is running the comment-density rule from memory rather than from a
   calibrated in-repo example. Upstream ships both, the second specifically so
   non-Claude agents work too.

2. **`supabase/functions/_shared/http/` is an empty directory** — a placeholder created
   and never filled. P1 fills it.
