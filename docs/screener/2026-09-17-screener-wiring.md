# Wiring the screener into the scout pipeline

> **Status 2026-11-08:** Partly superseded. The born-at-verdict design still holds: `supabase/functions/_shared/screen/screen-batch.ts` runs the tech gate (:204), the work-auth gate (:244), then `screenJob` (:265). The "What this does not yet do" list is mostly closed: seed columns fixed (`supabase/migrations/20260917124500_fix_bootstrap_filter_rule_seed_columns.sql`), the Filters page writes `enabled` (`apps/web/src/features/settings/filtersStore.ts:247`), the experience ceiling reads years from the job text (`_shared/screen/required-experience.ts`, migration `20261104193000`), and unscreened revived rows meet the pre-gate sweep ([`2026-11-06-bulk-revive-needs-pregate-sweep.md`](./2026-11-06-bulk-revive-needs-pregate-sweep.md)); `degree_mismatch` is still inert because nothing writes `requires_advanced_degree`. Stage 0's "matches neither = pass" row changed: with titles or keywords configured it now drops as `tech_gate_unclassified` (`_shared/screen/tech-gate.ts:27-33`).
> The body below is the original record, unedited.

**Date:** 2026-09-17
**Author:** applyyy-c8
**Status:** implemented; end-to-end behaviour still gated — see [What this does not yet do](#what-this-does-not-yet-do)

---

## The problem

The deterministic filter cascade at `supabase/functions/_shared/filter/cascade.ts`
was built and tested on 2026-09-10 and **had never run**. Verified repo-wide:

- `screenJob` is defined at `cascade.ts:357` and imported by exactly one file —
  its own test, `cascade.test.ts:13`. Every other occurrence is prose in `docs/`.
- No import of `_shared/filter` or `_shared/match` exists anywhere outside those
  two directories.
- `supabase/functions/_shared/screen/` existed as an **empty, untracked**
  directory — the intended home of the entrypoint, never filled.
- Both scouts went `adapter.parse` → `toJobInsert` → `jobs` upsert with nothing
  in between.

Consequence: every posting the Scout discovered became a queued application.
Teja's "I keep getting non-IT jobs" was not a missing feature. The fix was
written, tested, and unreachable.

---

## Architecture decision: the application row is born carrying its verdict

**This is the decision most likely to look like a bug to someone reading the
database in three months. It is deliberate. Please read this section before
"fixing" it.**

A row created by the scout now goes straight to `passed_filters` or
`dropped_filter`. It never passes through `discovered` or `deduped`, so
`application_events` shows no early history for it.

### Why not insert at `discovered` and then transition

Three facts, each verified directly rather than taken from a brief:

1. **The status guard is `before update`**, not `before insert` —
   `20260909234900_status_transition_guard.sql:266-268`. Inserts are ungoverned.
2. **The only legal source state for the screener edges is `deduped`** —
   `:106-108`. There is no `discovered → passed_filters` edge.
3. **Nothing in this repo ever writes `deduped`.** A repo-wide grep returns
   eight hits: the enum, the seeded edges, the TS mirror, a display label, a test
   fixture, and one manual dashboard button at `DiscoveredJobsPage.tsx:243`.
   **The Normalizer does not exist.** `supabase/functions/` contains only
   `_shared`, `email-tracker-intake`, `rls-proof` and `scout-ats`.

So an insert-then-transition design would have needed a migration to invent an
edge, and would still have been manufacturing a `discovered` moment that never
meaningfully existed — the row would have been created and re-statused in the
same loop iteration, microseconds apart.

### Why born-at-verdict is the truer record

`jobs` has **no status column at all**; `drop_reason` is a column on
`applications` (`core_tables.sql:377`). The schema's own division of labour is
that `jobs` holds the discovery record and `applications` holds the judgement. A
posting the title blocklist rejected was never a candidate application. Creating
its row already carrying `dropped_filter` and the rule that rejected it states
exactly what happened; inserting it as `discovered` first would state something
that did not.

Cost: one write instead of two, no migration, no guard interaction, no
`applyy.acting_agent` GUC to set.

### The safety constraint this created

Inserts bypassing the guard is a real hole, and it is wider than this parcel.
The guard's header calls itself the safety case for the whole system, and its
central claim is that constraint #15 — never submit without human approval — is
unreachable by construction, because every edge into `approved` is human-only and
`approved → applying` is the only edge into `applying`. **That claim is true of
UPDATEs and false of INSERTs.**

This module's use is safe because both statuses it writes are upstream of the
approval gate. To stop the *function* being reusable into the hole, the insert
status is a closed union rather than `ApplicationStatus`:

```ts
export type ScreenedInsertStatus = "passed_filters" | "dropped_filter";
```

A caller cannot hand it `approved` and have it compile. Widening that union is
the change that would open the path — it is a control, not a convenience.

*The general unguarded-INSERT finding was routed separately as a security
question. It is not addressed here.*

---

## The jobs-upsert blanking guard

### The bug

Both scouts upserted `jobs` with `ignoreDuplicates: false` — ON CONFLICT DO
UPDATE, a full-row overwrite. `toJobInsert` always emits every key, so a board
whose listing endpoint omits the job body produces `description_raw: null`, and
that null overwrote a complete description captured by an earlier, richer poll.

**The rule:** absence is not a correction. An omitted field must not overwrite a
stored value; a changed field should.

**The defect was at two sites, not one:** `scout-ats/index.ts:281-287` and
`worker/src/cli/scout.ts:207-213`, each sitting directly above a *correctly*
guarded `ignoreDuplicates: true` applications upsert.

### The obvious fix does not work

Deleting the null key from the offending row achieves nothing. Read from the
**installed** `postgrest-js@1.17.7` source, `PostgrestQueryBuilder.js`:

```js
const columns = values.reduce((acc, x) => acc.concat(Object.keys(x)), []);
this.url.searchParams.set('columns', [...new Set(columns)].join(','));
```

The column list is the **union of keys across the whole batch**. One sibling row
carrying `description_raw` puts that column in `columns=` for the entire request,
so it lands in the DO UPDATE SET list and the row that omitted it is sent as
NULL anyway.

**A key is genuinely absent only when it is absent from every row in the
request.** Hence `planJobUpsertGroups`: group the batch by identical key-set and
issue one upsert per group.

### The other plausible wrong answer

`defaultToNull: false` (which sends `Prefer: missing=default`) is **not** the
fix. It governs what a missing key means on INSERT — the column's DEFAULT instead
of NULL — and says nothing about the ON CONFLICT DO UPDATE SET list. On the
update path the stored value is still replaced. Written down because it looks
right and someone will try it.

### The quiet one

`locations` blanks on **every** poll, not only thin ones: `toJobInsert`
hard-codes `locations: []` because splitting locations is the Normalizer's job.
Once anything fills that column, the next scout run wipes it — and
`location_allowlist` reads it. The guard covers it.

**Not fixed, and deliberately so:** `discovered_via` and `source_refs` should
*merge* across sources rather than be overwritten. A merge needs SQL, not a
payload transform. Half-fixing it by stripping when empty would have hidden the
real problem — flagged instead.

---

## Stage 0: the tech gate

Per Teja's decision of 2026-09-17
(`docs/design/2026-09-17-tech-only-discovery.md`), a tech-role gate runs **ahead
of the cascade, outside it** — no new `FilterRuleType`, no migration, and
`cascade.ts` untouched. Config comes from the existing `search_preferences`
columns.

### The inverted default

The browser's `isTechRole()` classifies a title as non-tech when no positive
pattern matches. Ported unchanged, that would silently starve a pipeline
`PROJECT_PLAN.md:149-152` already describes as yielding single digits per day —
and starvation produces no error, so it is indistinguishable from a dead cron.
Server-side:

| input | verdict |
|---|---|
| matches an excluded keyword | **drop**, `drop_reason = tech_gate` |
| matches a target title or keyword | **pass** |
| matches neither | **pass, and warn** |

The third branch is the change. An unrecognised title is *missing information*,
not a negative answer.

### The false positive the prototype would have shipped

`scout-remote.ts:243` tests exclusions with `combinedText.includes(ex)`. With
`ops` on the excluded list — an entirely reasonable entry — a bare substring test
drops **DevOps Engineer** and **MLOps Engineer**, the most in-demand roles on the
list. Stage 0 matches on word boundaries instead, applied *conditionally per end*
so that a term like `c++` still matches (an unconditional `\b` can never match
`c++`, because two non-word characters in a row are not a boundary).

That boundary algorithm is currently **duplicated** from the private
`blockedTitlePattern` at `cascade.ts:188-198`. `cascade.ts` was explicitly out of
scope, so the duplication is flagged rather than resolved: the follow-up is for
`cascade.ts` to import the shared one.

---

## What this does not yet do

**Do not report that non-IT jobs are now filtered end-to-end. They are not.**
The wiring is complete and correct; three independent things still gate the
observable behaviour, and **fixing any one alone changes nothing**:

1. **`bootstrap_user_defaults()` raises `42703`** — it inserts into
   `evaluation_order`; the column is `sort_order`. Because `filter_rules` is
   seeded in the same transaction as `system_settings` and `search_preferences`,
   all three roll back. Any user bootstrapped after migration 14 has **no filter
   rules at all**.
2. **The Filters page cannot write** — `filtersStore.ts:232` upserts
   `is_enabled`; the column is `enabled`.
3. **Every rule seeds with `config = '{}'`** even when seeding succeeds.

With zero rules, `screenJob` iterates nothing and returns `{passed: true}` for
every job. **The wiring can be perfect and the observable behaviour identical to
today.** That is why the run summary reports `screened_passed` /
`screened_dropped` separately from the discovery counters, and why every test in
this parcel injects its own `FilterRuleRow[]` rather than reading the table — a
test that read the real table would pass by dropping nothing.

### Two rules are inert for a third, independent reason

Even with all three fixed, two of the nine rules still cannot fire, because **no
producer populates their input columns**: `toJobInsert` never sets
`min_experience_years` or `requires_advanced_degree`, and nothing in this repo
parses either out of a job description.

Worse than the empty-config case: `cascade.ts:157` and `:315` return
`drop: false` on null **without a warning**, so they read as working rules.

> **Status note, 2026-10-23 (appended; the text above is left as written):** the
> silent-null half is fixed — the cascade now returns a "skipped" warning on a null
> JD field, and `_shared/screen/run-summary.ts` persists those into
> `agent_runs.error_detail` for the Health page (B1, ruled 2026-10-08). The
> structural half was re-verified today and still stands: `ParsedPosting`
> (`_shared/ats/types.ts`) has no field for experience or degree, no row builder
> writes `jobs.min_experience_years` / `requires_advanced_degree`, and no JD parser
> exists in the repo (the web UI's degree regex in
> `apps/web/src/features/settings/filtersStore.ts` is display-only). The two rules
> stay inert until someone builds extraction — a new feature, not a wiring fix.

The irony worth recording: **`experience_ceiling` is `PROJECT_PLAN` §8's headline
worked example.** The plan illustrates the cascade with the one rule that cannot
run.

### What the parcel actually delivers

| | rules | status |
|---|---|---|
| **Work at scout time** | `title_blocklist`, `location_allowlist`, `employment_type`, `staleness` | ✅ once configured |
| **Work with DB context** | `already_applied`, `company_blocklist`, `per_company_weekly_cap` | ✅ once configured |
| **Structurally inert** | `experience_ceiling`, `degree_mismatch` | ❌ no producer sets their columns |

Teja's "non-IT jobs" symptom is squarely `title_blocklist` plus stage 0 — both in
the working set.

### Also not addressed

`ignoreDuplicates: true` on the applications upsert means **existing rows are
never touched**. Every application row already sitting at `discovered` from
previous runs stays there — this wiring judges only *new* rows. A backfill is a
separate parcel. Nobody should report "the queue is now screened" until it lands.

---

## Failure behaviour

If the context load fails, the scout **does not screen**. Rows are created at
`discovered`, exactly as before this change, and the failure is logged and
reported in the run summary (`screening_applied: false`).

This is the honest direction. Screening with an empty context would silently
disable the three context-dependent rules while reporting a clean screen; marking
rows `passed_filters` would be a lie the Matcher would then act on. `discovered`
is a true statement about a row that was not screened, and leaves it findable.

The loader distinguishes **an error from an empty table** at every read. An empty
table is a legitimate, common state — a new user has applied to nothing — and
succeeds. Only an error fails.

---

## Files

| file | role |
|---|---|
| `_shared/screen/upsert-plan.ts` | the blanking guard — batch grouping |
| `_shared/screen/tech-gate.ts` | stage 0, ahead of the cascade |
| `_shared/screen/screen-batch.ts` | the glue: gate → cascade → verdict row |
| `_shared/screen/context.ts` | context loading; error-vs-empty policy |
| `_shared/screen/supabase-queries.ts` | the client adapter; `blocked_until` expiry |
| `scout-ats/index.ts` | Edge Function entrypoint — wired |
| `worker/src/cli/scout.ts` | **the cron entrypoint** — wired |

The shared module exists because there are two near-identical scouts. Screener
glue written twice would drift, and the first drift would be silent — one
entrypoint enforcing a rule the other does not. It is also shaped so
`scout-remote.ts` can later call it and delete its bespoke block.

---

## A verification trap found while doing this

The standing instruction for asserting `deno check` actually ran is:

```bash
deno check <paths> 2>&1 | grep -c "^Check"     # must be > 0
```

**This reports 0 on a healthy run, for two independent reasons:**

1. Deno emits ANSI colour codes, so the line does not start with `Check`.
2. `deno check` is **incremental** — a second run over unchanged files prints
   nothing at all.

The anti-vacuous-pass assertion was itself vacuous. The working form:

```bash
deno check --reload <paths> 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -c "^Check"
```

which must equal the number of files checked.
