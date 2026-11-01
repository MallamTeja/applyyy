# `applyy` — live progress

**This file holds ONLY the live "Current state" and the re-verified open items.**
The dated September 2026 log that used to follow (with its in-place correction notes
through 2026-10-23) was moved verbatim to
[`status/2026-09-progress-log-archive.md`](status/2026-09-progress-log-archive.md)
on 2026-10-24. Nothing in the archive is live.

Evidence rule: a claim stays here only with a measurement behind it or the command
that regenerates it. **Counts date-stamp themselves — re-measure, never quote.**

---

## Current state (re-verified 2026-10-24 against origin/main `5c28b03` + live DB)

Architecture, agents and data flow: [`SYSTEM_ARCHITECTURE.md`](SYSTEM_ARCHITECTURE.md). This
section holds only **live facts, each with the command that regenerates it** — numbers are
never written here, because they date-stamp themselves. Run the command.

**Pipeline:** scout → normalizer (`deduped`) → screener → matcher (`scored`) → tailor →
auditor → `awaiting_approval` → human approves → **the worker submits automatically**
(`worker/src/cli/apply.ts` via `apply.yml`). `SUBMISSION_IMPLEMENTED = true` since
2026-10-09 (`worker/src/playwright-page.ts:21`, commit `c557533`): per run the cap is
`APPLY_MAX_SUBMITS` (default 3, `worker/src/claim-loop.ts:142`) behind a circuit breaker
(`0c437e4`), a robots.txt gate runs before the apply page opens (`a3b4115`,
`worker/src/apply-one.ts:347`), and `DRY_RUN` still defaults true at every layer — a
*scheduled* run submits only while the repo variable `APPLYY_CRON_LIVE` is `true`
(`.github/workflows/apply.yml:168`); a real single submit is `gh workflow run apply.yml`
with `dry_run=false` + `apply_only_id`. `worker/src/cli/assist.ts` remains the headed
single-row route where the human clicks Submit. The scouts screen at insert
(`supabase/functions/scout-ats/index.ts:481-518`, `worker/src/cli/scout.ts`), so most rows
are born at `passed_filters` / `dropped_filter`; `discovered` is the screener-unavailable
fallback.

| Fact | Regenerate with |
|---|---|
| Migrations applied vs local | `supabase migration list --linked`, or `select version from supabase_migrations.schema_migrations order by version;` |
| Application status distribution | `select status, count(*) from public.applications group by status order by 2 desc;` |
| Watchlist coverage per provider (expanded 2026-10-23; sources `docs/harvest/2026-10-23-watchlist-expansion.md`, `apps/web/src/features/settings/companyCatalog.ts`) | `select ats_provider, count(*) from company_watchlist group by 1;` |
| Agent-key enforcement (seeded 2026-10-09, expect 1 = enforcing; 0 would be off/warn-only) | `select count(*) from applyy_internal.agent_key;` |
| Which agents have actually run, and when | `select agent, count(*), max(started_at) from public.agent_runs group by 1 order by 1;` |
| Edge functions present | `ls -d supabase/functions/*/ \| grep -v _shared` |
| Which edge functions have a caller | `grep -rn "functions\.invoke(" apps/web/src worker/src` plus `.github/workflows/*.yml`. A template-literal call (`pipelineRunner.ts:217`, `rowPipelineDeps.ts:47`) takes its name from an agent list / closed union, so read that list too |
| Scheduled workflows and their crons | `grep -A2 "schedule:" .github/workflows/*.yml` |

**Agent-key guards:** `advance_application_status`, `claim_applications`,
`release_application_claim` and `sweep_stale_claims` check a machine agent's
`x-applyy-agent-key` header (migrations `20261008160000`, `20261008170000`). **The key IS
seeded (since 2026-10-09 ~13:40 IST), so they enforce:** a request without the right key is
refused (42501). An empty `applyy_internal.agent_key` table would only `raise warning` —
emptying it is the deliberate kill switch.

**What runs on a schedule, what doesn't** *(corrected 2026-10-24 — the old claim
"normalizer, screener, matcher, tailor and auditor have no cron" was stale)*:
- Scheduled workflows: `apply.yml` (`30 2 * * *`), `scout.yml` (`17 0,12 * * *`, twice a
  day since 2026-11-01), `scout-remote.yml` (`30 1 * * *`), `apply-kit.yml` (`0 12 * * *`),
  `keepalive.yml` (`15 6 */3 * *`). No `pg_cron` (ruled out, `20261009220000`).
- **Screening DOES run on cron:** `scout.yml` runs `worker/src/cli/scout.ts`, which
  screens at insert via `_shared/screen/screen-batch.ts` (its own line-11 comment:
  "THIS FILE IS THE ONE ON CRON").
- Normalizer, tailor and auditor have no schedule; matcher → tailor → auditor runs one
  row at a time via the manual `run-one.yml` dispatch. Two more manual routes exist:
  `pregate-sweep.yml` (POSTs `/functions/v1/matcher?mode=pregate_only`) and the web
  app's batch runner (`pipelineRunner.ts:75-86`, normalizer→auditor with `?limit=`).
- `experience_ceiling` and `degree_mismatch` can never fire: nothing populates
  `jobs.min_experience_years` / `requires_advanced_degree`. Their skips are recorded in
  `agent_runs.error_detail` (`_shared/screen/run-summary.ts`) and shown on the Health page.
- Every status transition writes a `status_change` witness row from the `log_status_change`
  trigger (from/to status; an agent cannot forget to log). A SECOND `note` row — the caller's
  `p_detail`: scores, `resume_sha256`, block history — is written by the RPC only when
  `p_detail` is non-empty. The split is DELIBERATE (the migrations' own comments say so:
  "separable when reading back"); it is a design, not a duplication bug.

**Gates** *(scope corrected 2026-10-24)*: `.github/workflows/ci.yml` runs on each push to
`main` and on PRs, four jobs: deno-check, edge-tests (`node --test
"supabase/functions/**/*.test.ts"`), web (tsc + vite build + tests), worker (tsc + vitest).
**It does NOT run the five `packages/*` trees' own `typecheck`/`test` scripts** — those are
covered only indirectly where web, worker or functions import them.
Traps: [`verification-traps.md`](verification-traps.md).

---

## Open items — each re-verified 2026-10-24 (evidence inline)

The September log's "Open questions / Runtime defects / Waiting on Teja / Not done /
Unknowns" sections live verbatim in the archive. Verdicts as of today:

**Still open (carried):**

1. **`application_status_transitions` has `relforcerowsecurity = f`** while the other
   tables force RLS — re-measured live 2026-10-24 (`select relforcerowsecurity from
   pg_class where relname='application_status_transitions'` → `false`). Defensible
   (read-only reference seed) but still *undecided*. Decide and record, or add force RLS.
2. **Stale comments contradict the bootstrap fix:** `applyy_internal.seed_user_defaults`
   DOES seed `gemini_key_state` (`20261009150000:77`; live rows exist, re-measured
   2026-10-24) and the on-signup trigger (`20261008180000:240`) calls it — but
   `_shared/gemini/pool.test.ts:91`, `_shared/agent/loop.test.ts:77`,
   `_shared/agent/kill-switch.test.ts:54` and `supabase/functions/STREAM_NOTES.md:177`
   still say it never seeds / is never called. Comment debt only; behaviour is fixed.
   (The `public.bootstrap_user_defaults()` wrapper itself has no caller — seeding arrives
   via the trigger, so that is by design, not a gap.)
3. **Actions secrets for the `APPLYY_APP_USER_*` rename are not verifiable from the repo**
   (code and workflows renamed by `21f0701`; `packages/shared-types/SCHEMA_CONTRACT.md`
   §8.3 updated). Only `gh secret list` can confirm the GitHub side.

**Resolved since the log was written (dated strikes):**

- ~~`email_events` cannot store `thread_id`, `to`, or `label_ids`~~ — resolved by
  2026-10-23 (`thread_id` `4f55733`; `recipient_to` + `label_ids` `6c70c93`); all three
  columns re-measured live 2026-10-24 via `information_schema.columns`.
- ~~`supabase/tests/invariants.sql` should exist~~ — created 2026-10-23 (`37c6edb`),
  12 read-only invariants, verified green against live.
- ~~`sweep_stale_claims` double-counts~~ — fixed (`20260910190000` FIX 1, then
  `20260918213000` Gap Fix G5 recreates the function).
- ~~Wrong/backwards migration comments (FORCE RLS reason, sweep predicate, false
  invariants)~~ — corrected in place 2026-10-23 (`cc333e7`, inline `CORRECTED 2026-10-23`
  markers at `20260909235000:94`, `20261004200000:20`, `20260909235100:253`,
  `20261009131000:25`).
- ~~Waiting on Teja: gh auth, remote DB authorisation, Docker~~ — all resolved by
  2026-10-08 (push works, migrations applied, `db push` needs no Docker).
- ~~"Nothing is deployed", "RLS never exercised as `authenticated`", "the RPCs have never
  been called", "typecheck is red"~~ — all false since the 2026-09/10 deploys: the web
  app, worker and edge functions run daily as `authenticated`, and `ci.yml` gates each
  push (scope above).

---

*History: the full dated log (2026-09-09 → 2026-09-10, corrections through 2026-10-23) is
in [`status/2026-09-progress-log-archive.md`](status/2026-09-progress-log-archive.md).*
