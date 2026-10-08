> **Historical record as of 2026-09-17.** Current state: [tech-gate.ts](../../supabase/functions/_shared/screen/tech-gate.ts).

# Tech-only discovery — design

**Date:** 2026-09-17
**Status:** design approved by Teja; not implemented
**Author:** design session (read-only; this session wrote no pipeline code)

---

## The question, and the short answer

Teja asked: *"agents should discover tech jobs only — why waste bandwidth and
resources discovering things that aren't useful?"*

The short answer is that **the architecture is already correct and must not
change**, but it is not connected, and the premise behind the question does not
hold yet:

1. **Bandwidth cannot be saved.** Greenhouse, Lever and Ashby each return their
   entire catalogue with full descriptions inline, in a single request. None
   accepts a filter parameter. You must download a board to learn what is on it.
2. **The system is supply-starved, not drowning.** The "400 jobs in a morning"
   figure describes a 200–400 board future. Today's ~50-board watchlist yields
   *single digits per day*.
3. **The real waste is downstream**, and it is caused by a filter that was
   built, tested, and never wired in.

So the work is **convergence and wiring**, not a new filter.

---

## Evidence base

Four read-only recon agents plus direct verification. Every claim is
file:line-checked.

### The discovery path

| Fact | Evidence |
|---|---|
| One HTTP request per board; no per-job detail fetch | `scout-ats/index.ts:208-216` |
| Descriptions arrive inline in the list response | `greenhouse.ts:73` (`?content=true`), `lever.ts:82`, `ashby.ts:60` |
| No adapter accepts a filter parameter | `ats/types.ts:94` — `buildRequestUrl(boardToken: string): string` |
| Every parsed posting becomes a row; nothing filtered | `scout-ats/index.ts:271-273` |
| Re-polls **rewrite** existing rows | `scout-ats/index.ts:281-287` — `ignoreDuplicates: false` |
| Lever returns `categories.department`, and the adapter discards it | `lever.ts:43-50` parsed, absent from `ParsedPosting` (`types.ts:33-63`) |

The last row is the one free signal available: a board-authored classification
that beats regex-on-title wherever it is present.

### Four divergent implementations of one concept

| # | Location | Runs? | Shape |
|---|---|---|---|
| 1 | `supabase/functions/_shared/filter/cascade.ts` | **No callers.** Only its own test | 9-rule denylist |
| 2 | `worker/src/cli/scout-remote.ts:236-260` | **Manual only** — not on cron | positive allowlist, pre-insert |
| 3 | `apps/web/src/features/settings/filtersStore.ts` | Browser only, display | 19 regexes |
| 4 | `worker/src/cli/scout.ts` | **This is the cron job** | **no filtering at all** |

`.github/workflows/scout.yml:61` runs `pnpm --filter '@applyy/worker' run scout`
→ `worker/package.json:13` → `scout.ts`. The three `continue` statements in
`scout.ts:144,167,182` are board-level error handling (no adapter / HTTP failure
/ parse failure), **not** job filtering.

**The path with the correct design is not scheduled. The path that is scheduled
has no design.**

### Two blockers that make the cascade unenforceable

Either one alone is sufficient to make the filter a no-op. Both are live.

**Blocker 1 — `bootstrap_user_defaults()` raises `42703`.**
`supabase/migrations/20260912001500_gemini_key_pool_cycle_randomization.sql:157`
inserts into a column named `evaluation_order`. The column is `sort_order`
(`20260909234800_supporting_tables.sql:229`). A repo-wide grep for
`evaluation_order` returns exactly one hit: that line.

Because `filter_rules` is inserted in the same transaction as `system_settings`
and `search_preferences`, all three roll back. **Any user bootstrapped after
migration 14 has no filter rules, no system settings, and no search
preferences.**

Consequence for anyone wiring the entrypoint: `screenJob` iterates `rules`. With
zero rows it iterates nothing and returns `{passed: true}` for every job. The
wiring can be perfect and the observable behaviour identical to today.

**Blocker 2 — the Filters page cannot write to the database.**
`apps/web/src/features/settings/filtersStore.ts:232` upserts a field
`is_enabled`; `:198` reads `row.is_enabled`. The column is `enabled`
(`20260909234800_supporting_tables.sql:220`). The upsert errors on the unknown
column, so nothing typed on the Filters page ever reaches Postgres.

This is why two independent recon agents contradicted each other on whether
`title_blocklist` is configured. Both were right:

- The **frontend** ships 9 default blocked terms (`filtersStore.ts:19-70`).
- The **database** seeds `config = '{}'` in all three seed generations.
  `grep -rn blocked_titles supabase/migrations/` hits only a comment at
  `supporting_tables.sql:221`.
- They never reconcile, because of the column-name mismatch.

Even with Blocker 1 fixed, every rule seeds with `{}`, and `cascade.ts:203-205`
then returns `{drop: false, warning: "title_blocklist has no blocked_titles
configured"}` — a no-op. The same holds for `location_allowlist`,
`experience_ceiling`, `employment_type`, `degree_mismatch` and
`per_company_weekly_cap`.

### Supply — the decisive finding

PROJECT_PLAN states in four places that the system is supply-bound:

> **Supply.** §13: a 3-day freshness window over ~50 watchlisted companies
> yields **single digits per day**, not 35. Sustaining ~35/day inside that
> window needs roughly **200–400 ATS boards** plus the aggregators. Freshness
> and volume trade directly against each other. — `PROJECT_PLAN.md:149-152`

> *"if more volume is ever wanted, the thing to buy is **supply** (more boards),
> not Actions minutes."* — `PROJECT_PLAN.md:158-160`

The locked-decisions table (`PROJECT_PLAN.md:66`) records the question *"3-day
window yields single digits/day — how to handle supply?"* answered **"Seed a
large ATS watchlist."**

`WatchlistPage.tsx:11-19` states the failure mode plainly: *"A small watchlist
plus a tight freshness window is how the pipeline runs dry while every agent
reports itself perfectly healthy."*

**Therefore the "400 jobs in a morning" in §8 and in `cascade.ts:3` is a
design-time projection, not observed throughput.** The places describing the
system as drowning and the places describing it as starving refer to different
watchlist sizes.

### What is actually on the watchlist

`companyCatalog.ts` — 60 curated companies, all tech-employing, four tiers:

| Tier | Count | Non-engineering volume on their boards |
|---|---|---|
| Mid-Scale MNC | 15 | low |
| Startup / Unicorn | 18 | low |
| GCC (Goldman, Wells Fargo, JPMorgan, Boeing, Target) | 12 | **high** |
| Service-Based (TCS, Infosys, Accenture, Wipro) | 14 | **high** |

So 33 of 60 boards are already mostly engineering. The non-tech volume from the
ATS lane is concentrated in the remaining 26.

A **second discovery lane** exists and is not watchlist-driven:
`apps/web/src/data/discoveryService.ts` runs browser-side against RemoteOK,
Jobicy and Arbeitnow — general aggregators, and the place genuine non-tech noise
actually enters. It already applies a title allowlist (`:279-280`) that drops
non-matching postings.

### The existing tech definition

`filtersStore.ts:85-109` — 10 negative regexes (sales, marketing, HR, finance,
legal, support, ops, medical, retail, real estate) and 9 positive
(software/engineer/developer, frontend/backend, data/ML/AI, devops/cloud/SRE,
QA, mobile/languages, security, embedded, intern variants).

`isTechRole()` is **deny-list first, then requires a positive match**. A title
matching no positive pattern is classified **non-tech**. `evaluateJobMatch()`
runs it as **step 1, before the title blocklist**, defaulting to `true`.

It is tested: `apps/web/test/filtersStore.test.ts:40-84` asserts 12 tech titles
pass and 14 non-tech titles fail — including *"Technical Recruiter"*, which
shows how fine the line is.

**This definition exists only in the browser.** `cascade.ts` has no equivalent,
and `filter_rule_type` has no enum value it could hang from.

---

## Decisions

Both taken by Teja on 2026-09-17.

### Decision 1 — drop non-tech jobs, but only pre-Matcher

Not at discovery. Jobs are stored and screened; the drop happens before any
Gemini call.

**Why not at discovery.** A job dropped before persist has no `jobs` row and no
`applications` row. `drop_reason` is a column on `applications`
(`core_tables.sql:377`), not on `jobs` — and `jobs` has no status column at all.
So a pre-insert drop leaves **no record anywhere** of what was rejected or why.

Combined with `isTechRole()` rejecting anything it does not positively
recognise, and with supply already thin, that is the exact failure the cascade's
own author warned about:

> A misconfigured rule must NOT drop the job: dropping on misconfiguration loses
> jobs invisibly … Passing instead costs at most a few Gemini calls and surfaces
> as a warning on the health page. **Fail toward the visible failure.**

**What dropping pre-Matcher still buys.** The entire LLM saving. The Matcher,
Tailor and Auditor are the three stages that cost quota; a job dropped before
the Matcher costs zero calls in all three. The only thing conceded relative to a
discovery-time drop is database rows — and rows are the cheap resource here
(500 MB free tier) while Gemini calls are the scarce one.

### Decision 2 — the tech definition lives in `search_preferences`

Reuse the columns that already exist (`supporting_tables.sql:178-183`):

```sql
titles            text[] not null default '{}'  -- role titles to hunt
keywords          text[] not null default '{}'  -- make a posting more interesting
excluded_keywords text[] not null default '{}'  -- "the cheapest test in the cascade"
```

**Why not a new `role_family_allowlist` filter rule.** A new `FilterRuleType`
costs all three of:

- a migration (`alter type public.filter_rule_type add value …`) — the enum is a
  real Postgres type at `enums.sql:225-241`;
- a `packages/shared-types/src/enums.ts` update — `SCHEMA_CONTRACT.md:842-860`
  requires enum parity in **values and declaration order**, enforced by
  `test/enum-parity.test.ts` in both directions;
- a `cascade.ts` implementation — `RULE_IMPLEMENTATIONS` is
  `Record<FilterRuleType, …>`, so a new member is a compile error until handled.

It buys nothing that `search_preferences.titles` does not already express, and
those columns **already drive the aggregator lane's allowlist**
(`discoveryService.ts:279-280`) and **already have a settings UI**
(`SearchPreferencesPage.tsx`). Using them converges three implementations onto
one config home instead of adding a fourth.

---

## The design

### Where the gate goes

**Stage 0 of the screener entrypoint — before the cascade, not inside it.**

```
scout (cron)  ->  jobs row + applications row @ 'discovered'
                          |
                  screener entrypoint
                          |
                  [ stage 0: tech gate ]     <- NEW; reads search_preferences
                          |
                  [ cascade: 9 rules ]       <- EXISTING; unchanged
                          |
                  Matcher (first Gemini call)
```

Putting it outside the cascade is what honours both decisions at once: no enum
change, no `filter_rule_type` member, no `cascade.ts` edit — and the cascade's
design, which Teja explicitly asked not to change, stays untouched.

It is also correct by the cascade's own philosophy. A title allowlist is the
cheapest test that exists — a string comparison with no I/O. Cheapest-first says
it runs before the rules that parse numbers and dates.

The shape to copy is `scout-remote.ts:236-260`, which already does exactly this
and already reads its config from `search_preferences` at `:193-202`. That code
is the prototype; it should be lifted and shared, not reinvented.

### The unknown-title default must invert

`isTechRole()` returns non-tech when no positive pattern matches. That default
is safe in a browser and unsafe in the pipeline.

Server-side the rule becomes:

- **matches an excluded keyword** → drop, with `drop_reason`;
- **matches a target title or keyword** → pass;
- **matches neither** → **pass, and record a warning**.

The third branch is the change. It mirrors the three-outcome `RuleVerdict`
already used throughout `cascade.ts`, where a rule that cannot be evaluated
warns rather than drops. An unrecognised title is exactly that: a case the
classifier has no opinion on, and a non-answer must not be treated as a
rejection.

Cost of the looser default: a handful of Gemini calls on titles the classifier
did not recognise. Cost of the tighter default: silent starvation that is
indistinguishable from "no jobs today."

### Recording the drop

A dropped job keeps its `jobs` row and transitions its `applications` row to a
`dropped_*` status with `drop_reason` set.

**Constraint to verify before implementing:** the status transition guard has no
`discovered -> passed_filters` edge; the legal source state is `deduped`
(`status_transition_guard.sql:106-107`). The screener must therefore route
through `deduped`, or a migration must add the edge. This was reported by a peer
session and is **not** independently verified here — check it before writing
code.

### Telemetry that will silently change meaning

`company_watchlist.last_poll_job_count` (`supporting_tables.sql:279`) currently
stores postings **fetched**, which today equals postings **kept**. The moment
any gate lands, those diverge and the column's meaning changes without its name
changing. Either rename it or add a second counter.

---

## Implementation sequence

Ordered by dependency. Steps 1–2 must land first or nothing downstream is
verifiable.

| # | Work | File(s) | Owner |
|---|---|---|---|
| 1 | `evaluation_order` → `sort_order` in `bootstrap_user_defaults()` | new migration | unassigned |
| 2 | `is_enabled` → `enabled` | `apps/web/.../filtersStore.ts` | unassigned |
| 3 | Wire the cascade entrypoint | `supabase/functions/` | **applyyy-c8** |
| 4 | Stage-0 tech gate reading `search_preferences` | screener entrypoint | unassigned |
| 5 | Invert the unknown-title default; port `isTechRole` server-side | shared module | unassigned |
| 6 | Retire the worker's hand-rolled copy in favour of `screenJob` | `worker/src/cli/scout-remote.ts` | **applyyy-c8** |
| 7 | Buy supply: freehire aggregator, more boards | per harvest plan P2 → P6 | unassigned |

Step 7 is the actual lever on throughput. The harvest plan names freehire the
*"biggest strategic lever"* and notes its API is **tech-roles-first faceted** —
so it narrows toward tech for free. Its own docs disclaim any SLA, so it is a
supply *supplement*, never a sole source, and `harvest-plan.md:169-170` requires
the robots gate (P2) to land first.

**Write-partition note.** `supabase/functions/scout-ats/index.ts` and
`worker/src/cli/scout.ts` are owned exclusively by `applyyy-c8`. This session
wrote none of them and holds no claim on them. Edits there route through the
orchestrator.

---

## What this design explicitly does not do

- **It does not filter at fetch time.** Boards offer no filter parameter; the
  payload is irreducible. Any claim of a bandwidth saving from "discovering
  less" is false for these three adapters.
- **It does not add a `FilterRuleType`.** See Decision 2.
- **It does not change the cascade.** Nine rules, cost-ordered,
  short-circuiting, table-driven — unchanged.
- **It does not restrict the watchlist.** 33 of 60 boards are already mostly
  engineering; the answer to non-tech volume is a gate, not a smaller watchlist,
  because a smaller watchlist worsens the supply problem that is the real
  constraint.

---

## Open items

1. **Verify the `deduped` transition constraint** before implementing the drop
   path. Reported by a peer session, not independently confirmed here.
2. **Cost ordering regressed.** The original seed used cost order
   (`title_blocklist` first, `sort_order` 10). The current seed generates order
   from `enum_range()`, i.e. enum declaration order, putting
   `experience_ceiling` first. Functionally identical, measurably worse: numeric
   parsing now runs before the free string check. Fix alongside Blocker 1.
3. **Lever's `categories.department` is discarded.** Adding it to
   `ParsedPosting` would give the gate a board-authored signal that beats regex
   on title. Not required for this design; worth doing.
4. **`ignoreDuplicates: false` rewrites every row on every poll.** At 200–400
   boards this is continuous write amplification nobody has costed.
5. **`per_company_weekly_cap` disagrees with the plan.** §18.5 says max 2 per
   company per week; `filtersStore.ts` defaults to `{ max_per_week: 3 }`.
