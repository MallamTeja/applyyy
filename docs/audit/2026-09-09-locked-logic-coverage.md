# Audit — coverage of §18 locked logic in PROJECT_PLAN.md

**Date:** 2026-09-09 23:40 IST
**Auditor:** session `applyyy-b3` (root-config + docs stream)
**Target:** `PROJECT_PLAN.md` (525 lines)
**Trigger:** Teja asked to re-verify that four specific items were actually
captured in the plan, rather than assumed captured.

---

## Verdict

| Item | Described in §18? | Specified in §9 (data model)? | Buildable today? |
|---|---|---|---|
| Daily Gemini budget + circuit breaker | ✅ line 417 | ❌ no table, no column | **No** |
| Golden eval set for the Matcher | ✅ line 418 | ❌ no table, no file path | **No** |
| ATS keyword coverage % on diff view | ✅ line 422 | ❌ no column | **No** |
| Trust-building DRY_RUN period | ✅ line 421 | ❌ no home (env var? column?) | **Partly** |
| Kill switch (`system_enabled`) | ✅ line 416 | ❌ no config table | **No** |
| Reposted-job signal | ✅ line 419 | ❌ no `disappeared_at` / `repost_count` | **No** |
| Per-company cap 2/week | ✅ line 420 | ⚠️ derivable by query | Yes |

**So the four items Teja asked about are present as prose and absent as
schema.** They were not lost — they were never made implementable.

---

## Root cause — one gap, not seven

§9 "Data model" opens with *"Twelve tables:"* and then lists twelve **table
names inside a code fence with no columns at all.** It goes on to specify
exactly three things: the `jobs`/`applications` split, `UNIQUE(user_id,
job_id)`, and `master_profiles` immutability. Everything else — every column,
type, default, index, and check constraint — is unspecified.

This is why the seven rows above fail together. It is not seven oversights;
it is one missing artifact. Any peer building the schema from §9 must invent
column names, and any peer building a UI or an agent against those columns
must guess the same names independently. Two peers guessing separately is how
a monorepo grows two spellings of the same field.

**The named failure mode:** a plan that reads as complete because every
feature appears somewhere in prose, while nothing downstream can be built
from it. Prose coverage is not specification coverage, and grepping for a
feature name proves only the former.

---

## Consequences already visible on disk

- `llm_calls_today` — 0 occurrences in the repo.
- `ats_keyword_coverage` — 0 occurrences.
- `system_settings` — 0 occurrences, though §18.1 makes the kill switch
  **safety-critical** and every agent is required to check it first. A
  safety-critical control with no storage is not a control.
- `supabase/migrations/` — exists, empty. The schema stream has produced no
  migration yet, so nothing has hardened around a wrong guess. **This is the
  cheapest possible moment to fix it.**

---

## Secondary findings in the same pass

1. **§21 peer table lists session names that never existed** —
   `applyy-11`, `applyy-58`, `applyy-af`. These were placeholders invented
   during design, not real sessions. The live map is `applyyy-aa` (schema),
   `applyyy-d0` (Edge Functions), `applyyy-76` (web), `applyyy-21` (worker +
   Actions), `applyyy-04` (resume-template + Deno↔Node spike), `applyyy-b3`
   (root config + docs), orchestrated by `applyyy-d8`.

2. **§22 says "Code written: **none**"** — false since ~23:31. Root config,
   `.npmrc`, workspace manifest and `packages/shared-types/` scaffolding all
   exist. This is the "past tense for future work" failure running in
   reverse: a status table asserting less than reality.

3. **§9 status flow contains two names one letter apart with opposite
   meanings** — `screened` (passed *our* pre-apply filter) and `screening`
   (the *employer* is reviewing you, post-apply). One name meaning two
   things. Renamed in the shipped enum to `passed_filters` and
   `employer_screening`; §9 still shows the old pair.

4. **§7 and §9 disagree on the Auditor's output** — §7 says `audit_failed`,
   §9 says `audit_clean | audit_flagged`. §9 is authoritative.

---

## Recommended fix — assign to the schema owner

This belongs to whoever owns `supabase/migrations/**` and
`packages/shared-types/**` (currently `applyyy-aa`), because the fix is a
column list and the column list must be born in the same place as the
migration that creates it. Writing it into §9 from the docs stream would
create a second home for the same fact, and duplicated facts drift.

**Proposed division:**

- **Schema owner** authors the authoritative column-level contract in its own
  tree (`packages/shared-types/SCHEMA_CONTRACT.md`), including storage for
  all seven rows above.
- **Docs stream (`applyyy-b3`)** rewrites §9 to *link* that contract rather
  than restate it, and corrects findings 1–4.

Minimum storage the contract must cover for the seven rows:

| Need | Suggested home |
|---|---|
| Kill switch, DRY_RUN, daily budget, freshness window, per-day cap, per-company cap | one singleton `system_settings` row |
| Budget counter + its reset date | `llm_calls_today`, `budget_date` — date in **US/Pacific**, because Gemini RPD resets at Pacific midnight, not IST |
| ATS keyword coverage | `applications.ats_keyword_coverage` |
| Golden eval set | `matcher_eval_set` table, so it is queryable by CI rather than a file someone forgets |
| Reposted-job signal | `jobs.disappeared_at`, `jobs.repost_count` |

The Pacific-date detail matters and is easy to get wrong: a budget counter
that resets at IST midnight will reset five and a half hours *after* the
quota it is tracking, so the circuit breaker would open during the window it
exists to protect.

---

## Status

- Verification: **complete**.
- Fix: **not started** — needs assignment by orchestrator `applyyy-d8`.
- Reported to `applyyy-d8` at 23:40 IST.
