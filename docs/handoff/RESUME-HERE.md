# RESUME HERE — `applyyy`

**Last updated:** 2026-09-17, 18:05 IST, by `applyyy-94` (orchestrator).
**State at writing:** HEAD `9d8e802`, pushed. One file in flight — see §0.

This is the single entry point. Everything else is linked from here.

**Read order for a cold session:** this file → [`CLAUDE.md`](../../CLAUDE.md) → the doc for the
task you picked up. Do **not** read the two handoff files first; they are history.

> **Every task below carries what it needs to start.** If a task's line does not tell you where
> the evidence is, that is a bug in this file — fix it.

---

## 0. Before you touch anything

1. **`git status` and `ListAgents` first.** This repo runs concurrent sessions on **one working
   tree, one index, one `.git`**. At 18:05 there was a modified
   `apps/web/src/features/settings/companyCatalog.ts` that is **NOT mine and NOT abandoned** — a
   session was mid-edit on the watchlist work (`9d8e802`). **Do not commit it for them.**
   *"Uncommitted" and "abandoned" are not the same state, and `git status` cannot tell them apart.*
2. **The partition map is a LEASE, NOT A RECORD.** It turned over three times in fifteen minutes
   today. Re-derive it; never inherit it.
3. **Nobody can see the live database or the live deployment.** The `supabase` MCP connector is
   unauthenticated and sessions are non-interactive; the Vercel CLI is not installed. **Every
   claim about applied migrations or deployed code is inferred from filenames.** Say so out loud.

---

## 1. BLOCKED ON TEJA — nothing else moves until these do

| # | Task | Why it is blocking |
|---|---|---|
| **T1** | **Authenticate the Supabase connector**, then run `supabase migration list` | The single largest blind spot. Settles which of the 8 migrations are actually pending. Needs an interactive session — `/mcp` or claude.ai connector settings. **No Claude session can do this.** |
| **T2** | **Apply the migrations** (see §2 — there is a runbook, do not freestyle) | The filter-rule repair and the approval-gate INSERT guard have changed nothing so far |
| **T3** | **The 60-second deploy test** | Open `https://applyyy.vercel.app` → View Source → open `/assets/index-*.js` → search `Nothing compared these against your master profile`. **Absent → stale deploy. Present → current.** Never answered all afternoon |
| **T4** | *Optional:* dispatch `apply.yml` with `dry_run` (defaults `true`) | Exercises playwright 1.55.1 safely. Otherwise `scout.yml` at 23:30 IST is first contact, and `apply.yml` at 08:00 IST is first contact that **submits real applications** |

**Rulings still owed by Teja:** agent identity Gap 1 (needs a coordinated landing, **frontend
first**); `salary_period` (the gate is built and **inert** — no period column exists on `jobs` or
`search_preferences`); whether the **DB or the UI** seeds the nine default blocked titles
(`filtersStore.ts:19-70` has them, the DB has none).

---

## 2. THE MIGRATION PUSH — read this before running one command

**The apply set is EIGHT files**, not the "two" that circulated all afternoon. `supabase db push`
applies **all of them in one command**. It is a **network operation and needs no Docker** — only
`start`/`reset`/`diff` need containers, so the no-Docker rule was never the obstacle.

Full review, with the runbook: [`../audit/2026-09-17-unapplied-migrations-review.md`](../audit/2026-09-17-unapplied-migrations-review.md)

| order | file | verdict |
|---|---|---|
| 1 | `20260910220800_create_private_storage_buckets.sql` | **APPLY, WATCH THIS ONE.** High on correctness, **MEDIUM** on whether it applies cleanly |
| 2 | `20260911114300_add_resume_sha256_to_applications.sql` | SAFE |
| 3 | `20260911235500_add_linkedin_post_discovery_source.sql` | SAFE |
| 4 | `20260912001500_gemini_key_pool_cycle_randomization.sql` | Apply only as part of the full set |
| 5 | `20260912120000_update_search_preferences_and_employment_types.sql` | SAFE |
| 6 | `20260917124500_fix_bootstrap_filter_rule_seed_columns.sql` | **APPLY WITH CAVEAT.** High on SQL, **LOW on effect** |
| 7 | `20260917130000_guard_application_status_on_insert.sql` | SAFE |
| 8 | `20260917174600_retract_forged_fast_path_agent_events.sql` | **SELF-REVIEWED ONLY** — see T5 |

**The runbook, in order:** `supabase migration list` → **the pre-flight** → **the baseline query**
→ push → verify.

- **The pre-flight takes one second and prevents the likeliest failure.** File 1 writes four
  `create policy` statements against `storage.objects`. Its own comment at `:43-45` says re-running
  is safe — **true of the bucket insert, false of the file.** Postgres has no
  `create policy if not exists`, so a second run raises **42710**, and file 1 **gates the other
  seven**. The pre-flight asks whether those four policy names already exist.
  **Do NOT pre-emptively patch it** — bare `create policy` is house style (`rls_policies.sql`: 17
  creates, 0 drops), and editing a migration to fix an *unconfirmed* problem is exactly how the
  `evaluation_order` bug got in. Corrected SQL is in §3.1 of the review, for use only if the
  pre-flight returns rows.
- **Take the baseline BEFORE pushing.** A count taken only afterwards cannot distinguish
  *"seeded 18"* from *"was already 18"*. The bug in file 6 is the proof.
- **If it dies partway, the bad resting places are between files 5 and 6**, not 4. File 4 installs
  the `evaluation_order` break and file 6 repairs it, so stopping between leaves the fix
  half-landed. Recoverable — nothing calls that function — but not a state to walk away from
  believing it was clean.
- **Do not repeat the "LIVE BREAK" framing.** If file 4 is also unapplied, the break never fires:
  both land seconds apart and the broken function is never called in between. The honest claim is
  *"we cannot see the database"*, not *"your database is broken"*.

---

## 3. PENDING WORK — ranked, with the evidence each one needs

### Tier 1 — correctness and safety

| # | Task | Where to start |
|---|---|---|
| **T5** | **Second reader for `20260917174600`** (`bb6a988`). Its author self-reviewed and said it should not clear its own file. Low-risk by position (sorts last of 8) but unread by anyone else | Discriminator is `detail->>'note' = 'Fast-tailored and queued from Discovered Jobs Explorer'` on `event_type='note'`, verified unique via `git log -S`. Idempotent via a `detail->>'correction'` marker. Reports **both** matched and written counts; `raise warning` (not `exception`) on zero |
| **T6** | **`ApprovalQueuePage.tsx:214`: null-check → shape check**, and delete the now-unreachable fallback at `:223-245` in the same pass | A row with `tailored_profile = '{}'::jsonb` **passes** the gate. Past the `continue` the value is non-null by construction, so `rawResolved ?? {…}` always takes the left side — the fallback is **dead code**, and dead code that looks like a safety net is worse than none. [`../status/2026-09-17-pending-work-audit.md`](../status/2026-09-17-pending-work-audit.md) §5.2 |
| **T7** | **Nothing builds `apps/web` in CI.** ~15 lines of YAML | `.github/workflows/` has only `apply.yml`, `keepalive.yml`, `scout.yml`; `grep -i vercel` returns nothing. This is the 2026-09-16 post-mortem's **own action item, never implemented** — and it is why "is production stale?" cost two agents today. Root `vercel.json` runs `tsc --noEmit && vite build`; a red typecheck silently stopped all deploys for four days on 09-12 |
| **T8** | **4 Deno type errors, not 1** | `scout/tiers.ts:384` (TS2322, fix `?? null`) + **three in `_shared/gemini/client.ts`** (`:156`, `:213`, `:280`, `exactOptionalPropertyTypes`), unseen since 09-12 because no workspace command reaches that tree. `cd supabase/functions && deno check --reload <paths>` |

### Tier 2 — the pipeline is severed; these are the severances

| # | Task | The fact that defines it |
|---|---|---|
| **T9** | **The Auditor does not exist.** No `_shared/audit*` directory at all | The agent whose verdict the deleted button forged was never written |
| **T10** | **No runner writes `deduped`.** `_shared/normalize/` **does** exist and is production-reachable (`fingerprint.ts`, `posted-at.ts`) — what is missing is the runner | *"Write an agent"* and *"wire a runner around tested helpers"* are very different sizes. Do not conflate them |
| **T11** | **Matcher and Tailor exist with zero non-test importers** (`_shared/match/`, `_shared/tailor/`) | Also `_shared/gemini/`, `_shared/agent/`, `_shared/eval/` |
| **T12** | **The graph has no `discovered → passed_filters` edge, so existing rows are stranded permanently** | `status_transition_guard.sql:101-103` seeds only `deduped`, `dropped_duplicate`, `failed` out of `discovered`; the Screener's only legal source is `deduped`, which nothing writes. `ignoreDuplicates:true` never touches an existing row. **Any plan to wire the Matcher needs an answer for the stranded inventory first** |
| **T13** | **Nothing writes `tailored_profile`.** Not one writer, anywhere | Every consumer reads a column no producer fills |
| **T14** | **Nothing calls `bootstrap_user_defaults()`** — no caller, no trigger on `auth.users`, `SCHEMA_CONTRACT.md:571` says manual | So even after migration 6 lands, **a new signup still gets no rows** |

### Tier 3 — known-broken, lower blast radius

| # | Task | Detail |
|---|---|---|
| **T15** | **The PDF path is broken THREE ways, unconditionally** | `pdfExtractor.ts:14` probes for `mod.extractPdf`, a symbol that **exists nowhere** in `master-pdf`; `@applyy/master-pdf` is **not a dependency of `apps/web`**; a bare `catch {}` at `:23` swallows both while calling it a transient race. **Writing the missing `extract.ts` would change nothing — it is three fixes.** Every upload returns the hardcoded `Extracted Candidate` profile. If `master_profiles` was ever written against live, **it holds junk** |
| **T16** | **`packages/master-robots` has no Deno caller** | The Node side is wired (`65b7726`). The Deno target is `_shared/http/transport.ts:301` — the one function every Deno fetch crosses. **Do not route master-robots' own fetcher through a gated transport** or the gate recurses fetching its own `robots.txt` |
| **T17** | **W2 (vite 6.0.3→6.4.3) and W4 (vitest, alone, last)** | W2 **will not zero the vite count** — a second vite major (5.4.21) arrives via `@vitest/mocker` and leaves with W4. Plan: [`../security/2026-09-17-dependency-remediation-plan.md`](../security/2026-09-17-dependency-remediation-plan.md) |
| **T18** | **Re-derive the tier scheme — bundled with W2, ruled, not standalone churn** | Tier 2 is now **empty**. The scheme runs two tests under three headings: the headings sort supply-chain vs runtime, the prose sorts reaches-a-user vs not. One test — *"does a failure here reach something outside this laptop"* — and two tiers. **The old numbering must stay findable**, since W2/W4 commits cite it |
| **T19** | **Actions-budget flag — UNVERIFIED, worth an hour** | `scout.yml`/`keepalive.yml` install with no browser cache and no skip-download env, while `pnpm-workspace.yaml` permits playwright's postinstall. If it downloads, **scout has been pulling ~130MB four times a day** against the 2,000-minute budget `PROJECT_PLAN.md` §2 calls the binding constraint. Pre-existing if real. Counter-evidence: `apply.yml:127`'s explicit install step would be redundant |
| **T20** | **`worker/scripts/` is entirely untypechecked** | `worker/tsconfig.json` includes `src/**`, `test/**`, `*.config.ts` — **not `scripts/**`**. One file pulled into the program surfaced a live TS2345 immediately. Assume nothing there compiles |
| **T21** | **No component render harness in `apps/web`** | Branch-order fixes are correct by construction and typecheck, **never by execution**. Adding one drags in a dependency → needs a lockfile window |
| **T22** | **`PROJECT_PLAN.md` / `docs/PROGRESS.md` stale claims — assigned twice, never done** | §3 still says peers never commit (**superseded 2026-09-11**); the `~:497` diagram still shows `screened`/`screening` (renamed to `passed_filters`/`employer_screening`); §8's worked example is built on `experience_ceiling`, **the one rule that structurally cannot fire**; `PROGRESS.md:566` claims every status write goes through `advance_application_status` |
| **T23** | **`supabase-js` modernisation window** | 2.50.0 was the patched minimum; 2.116.0 carries a **postgrest-js major**. Verification is a re-read of `PostgrestQueryBuilder` source, because `planJobUpsertGroups` depends on union-of-keys behaviour **no test would catch breaking** |
| **T24** | **`ApprovalQueuePage` hand-rolls read-state** instead of `src/data/readState.ts` (`classifyRead`/`describeEmptyState`/`isConclusive`), which six other files use | Correct as written, but the odd one out |

---

## 4. Shipped today — do not redo

`75a75a0` fast-path button deleted (your ruling) · `bb6a988` compensating-event migration ·
`b62be33` playwright 1.49.1→1.55.1 both manifests · `65b7726` robots gate wired ·
`af4207f` all 8 migrations reviewed · `2d41e43` 8 false statements closed in the remediation plan ·
`da87a97` pending-work audit · **11 `CLAUDE.md` commits**

---

## 5. Two things that will save you an afternoon

**The defect family.** *Missing data becoming an answer — the permissiveness of the reader is the
fail-open.* And its twin, *a confident assertion standing in for work that never happened.*
`CLAUDE.md` §5 has both with worked examples. **Every branch that concludes GOOD from an absence
must prove the absence means what it says.**

**Verification traps that report success while doing nothing** — `CLAUDE.md` §4 lists all of them.
The three found *today*: `deno check` over zero files exits 0; `$?` after a pipeline is the last
command's status, not the checker's; and `pnpm install --lockfile-only` leaves the **old** version
installed, so a suite run afterwards goes green for a reason unrelated to the change.
**A guard that can pass vacuously is not a guard.**
