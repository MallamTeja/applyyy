# Wiring audit re-check at 2396b27 (2026-11-09, ~23:45 IST)

Re-measures every finding of `docs/audit/2026-11-01-wiring-audit.md` against **origin/main = `2396b27`**. Read-only.
Code was read only from the pushed commit (`git show 2396b27:<path>`, `git grep … 2396b27`), never the shared working
tree, where peers have uncommitted worker edits. Live state was read with SELECTs only. Four recon agents (one per
area) plus the orchestrator's own W5 trace. Their file:line citations were spot-checked (apply.yml:171,
claim-loop.ts:478, apply-kit.ts:446: all match). The audit's own claims were treated as data.

## Lead: one submit-path gap is still open (W5, residual)

**W5's original trigger is FIXED, but a narrower version of the same bug is STILL OPEN: an email-only form.**

- Fixed: `formShapeBlockersFor` (`worker/src/apply-one.ts:557-571`) refuses a page with **0 fields**
  (`no_form_fields`, `50ac7e3`) and, since `cb58582`, a page with **no email field** (`no_email_field`, the jobicy
  search box + dark-mode toggle case). It is wired into the live decision at `apply-one.ts:772`
  (`wouldSubmit = detected === null && formShapeBlockers.length === 0 && plan.canProceed && attachment.canProceed`).
  2396b27's `verdictFromFacts` (`:219-228`) only changed how the dry run *reports*; the live `submit()` already used
  the same three pre-click checks (`playwright-page.ts:1009-1013`).
- **Open:** a page whose only `<form>` is a job-alert or newsletter box (one email input, one submit button) passes
  every gate:
  1. `formShapeBlockersFor`: an email field exists → `[]`.
  2. `planFill`: the email is the profile email → `canProceed`.
  3. `planResumeAttachment`: **no file input → `canProceed: true`** (`plan-resume-attachment.ts:119-121`, "the form asks
     for no documents at all … this proceeds").
  4. `verdictFromFacts`: exactly 1 visible submit control in a form, nothing invalid, nothing required left empty →
     `would_submit`.
  5. `submit()` clicks it: an **unintended POST** (a newsletter or job-alert signup in Teja's name), then `unconfirmed`.
  It is reachable through aggregator or pasted `apply_url`s, the same source class as the jobicy incident. A page with
  a real form *and* a footer newsletter form is safe: 2 submit controls → `submit_control` refusal.
- **Smallest fix** (file: `worker/src/apply-one.ts`, `formShapeBlockersFor`; owned by peers tonight): add a third
  stop. No file input → `no_resume_field` (`unsupported_form`, so the row goes to the Manual lane). It fails closed:
  every board the bot targets (Greenhouse, Lever, Ashby) asks for a resume upload, so a page without one is not one
  the bot should click. A test in the same shape as the `no_email_field` one: an `[email]`-only field list must yield a
  blocker, red on revert.
- Not in this audit, but on the same path: the P0 declarations bug (handoff, peer 1) still gates the first live submit.

## Verdict table

| ID | Verdict | Evidence @2396b27 (abridged) | Commit |
|---|---|---|---|
| **W5** | **FIXED (0-field / no-email) · residual OPEN (email-only form)** | see Lead | 50ac7e3, cb58582 |
| W4 | FIXED | `supabase-gateway.ts:323,347-355` returns unusable rows *with a marker*; `claim-loop.ts:619-626` sets them aside and continues; `:564` breaks only on a truly empty page | 50ac7e3, cc0a848 |
| W2 | FIX HOLDS | `matcher/index.ts:361` `.is("jobs.disappeared_at", null)`; `:499` `withUsableJob(`; `fail-exit.ts:128-175` `judgeUsableJob` | 4d57ce0 |
| W3 | FIX HOLDS | `job-link-intake/index.ts:145` fills `description_raw`; `handler.ts:58` `REVIVE_FROM` includes `failed`; `:472` `richerDescription` | 4d57ce0 |
| W6 | FIX HOLDS | `email-tracker-intake/index.ts:574,268` `replayStoredMoves`; `replay.ts:205-207` leaves moves owed under the kill switch | 2dbe677 |
| W7 | FIX HOLDS | `decide.ts:359-366` `titleNamedIn` tiebreak when `pool.length > 1` | 2dbe677 |
| W9 | FIX HOLDS | `useAgentRuns.ts:113-115,278` per-agent `.limit(1)`; `:454-455` a failed lookup reads "unknown" | af3c7f0 |
| W12 | FIX HOLDS (both scouts) | edge `scout-ats/gate.ts:73,78` (error count + HTTP 500 `screener_not_run`); worker `scout/run-outcome.ts:115,129,141` closes `failed`, exits 1 | — |
| W14 | FIX HOLDS | `skill-gap/handler.ts:89-91` `authorizeCaller` before the first write (`:98`) | 2aac3c0 |
| W15 | FIXED | `_shared/db/client.ts:149-171` `createAuthorizedAppUserClient` ("Verify, then sign in"); used by normalizer:82, scout-ats:169, screener:63, auditor:116, gmail-sync:40; the only bare `createAppUserClient()` (email-tracker-intake:195) runs after its secret check | 5bfab2e |
| W16 | FIXED | three secrets: `EMAIL_INTAKE_SHARED_SECRET` (header), `APPLYY_RLS_PROOF_SECRET`, `APPLYY_GMAIL_SYNC_SECRET` (POST body; `respond.ts:38` says the `?secret=` route is gone); Apps Script reads `APPLYY_SYNC_SECRET` from the body | 7aa3c07 |
| W17 | FIX HOLDS (per 11-08 note) | `job-link-intake/pinned-get.ts` | — |
| W18 | FIXED, **applied live** | migration `20261102210000` in `schema_migrations`; live: 1 key, `allow_unkeyed_agents=false`; a header-less call reads `missing` (refused), not `unconfigured` | 20261102210000 |
| W19 | **STILL OPEN (Teja's decision)** | live `auth.users`: 2 rows, 1 never signed in, 0 banned. Signup setting not readable via SQL | — |
| TRUNCATE on append-only tables | FIXED | live `role_table_grants`: no TRUNCATE for anon/authenticated on application_events, agent_runs, email_events, applications | — |
| W20 | MOSTLY FIXED · 1 leftover | all 4 columns now in `tables.ts` (:626, :1101, :944, :868); stale header counts removed. Left: `email-tracker-intake/decide.ts:529` `EmailEventInsert & Record<string, unknown>` | 23cf028 |
| W21 | FIXED | `features/emails/emailSync.ts:32` imports `EmailEventRow` from `data/contract`; `:159` `'interview_invite'` | 23cf028 |
| W22 | FIXED | `.github/workflows/satellites.yml` (cron `23 13 * * *`) calls all five; live `agent_runs`: referral 10/10 and cover_letter 10/10 succeeded (others likewise listed); newest 2026-11-08 18:24 UTC | 2aac3c0, 72be0e3 |
| W23 | **STILL OPEN** | `matcher/freshness-queue.ts` exists, imported by nothing (not even a test); `matcher_eval_cases` has no writer (only types, the migration, and rls-proof's seed/delete sweep) | — |
| W24, W25, W26 | FIX HOLDS (per 11-08 note) | WatchlistPage.tsx:65; migration `20261102211000` applied live; import-graph test | — |
| W27 | **STILL OPEN (partly converged)** | no shared `runScout`. Shared screen and identity helpers exist, but the upsert (`scout-ats/index.ts:557-599` vs `worker/src/scout/persist-jobs.ts`) and the run close (`gate.ts` vs `run-outcome.ts`) are separate | — |
| pipelineRunner "0 advanced" | **STILL OPEN** | `apps/web/src/data/pipelineRunner.ts:66` `matcher: { moved: ['scored'] … }`; the matcher returns `dropped` (`matcher/index.ts:843`) | — |
| W28 | FIX HOLDS (per 11-08 note) | `apply-kit-sweep.ts:98` | — |
| W29 | MOSTLY FIXED · residual OPEN | robots → resume-only kit (`apply-kit.ts:296`); closed → stamped `apply_kit_skipped`. Left: an **`approved`** row with no `apply_url` that the applier has not parked (a dry run only holds it) throws a plain `Error` at `apply-kit.ts:446`, gets no stamp, is retried daily, and sets exit 1 | 9889021 |
| W30 | FIXED | `apply.yml:169-174` default `DRY_RUN=true`, exact shell `=` on raw `inputs.dry_run` / `vars.APPLYY_CRON_LIVE` | 9889021 |
| W31 | FIXED | `run-window.ts:84` budget 3000 (sum 3510 ≤ 3600); `claim-loop.ts:478` sweep **before** the kill-switch return (`:487-493`). Note: no independent scheduled sweep (sweeps at applier start only) | 9889021 |
| W10 | **STILL OPEN (2 of 3 caps)** | `max_applications_per_company_per_week` and `freshness_window_days` have zero readers; daily cap wired (`claim-loop.ts:500`); per-run cap 3 (`:238`, `apply.yml:227`). Ruling still open | 50ac7e3, 3c77d53 (daily) |
| W32 | FIX HOLDS (per 11-08 note) | `email-tracker-intake/decide.ts:134` | — |
| W33 | FIXED | `email-tracker.gs:137-167` ANDs the 2-day window with ATS senders and job phrases; live: `application_received` 6 (4 matched); unclassified 116 rows, newest 2026-11-07 (none stored since) | 7aa3c07 |
| W34 | FIXED | `rls-proof/guard.ts:22,63-66` refuses the production project ref (409) before sign-in; the RLS-scoped count is only a second layer | 7aa3c07 |
| W35 | FIXED | `ci.yml:232-240` (and in 4 more steps) fails on any `✖` line | c8e2fea |
| W36 | **STILL OPEN** | `supabase/functions/deno.json` excludes `**/*.test.ts`; `apps/web/tsconfig.json` `include: ["src"]` while the web tests live in `test/`; worker tests ARE type-checked (`ci.yml:399`) | — |
| W37 | PARTLY FIXED | `scripts/deploy-drift.mjs` (manual, read-only drift check) + `docs/tooling/2026-11-02-deploy-drift.md`; no ledger of deployed SHAs, and nothing runs the script automatically | — |
| W38 | NOT VERIFIABLE FROM REPO (likely open) | `vercel.json` has only `ignoreCommand` + `deploymentEnabled`; "wait for CI" is a Vercel or GitHub setting | — |
| worker `test:e2e` in CI | **STILL OPEN** | `worker/package.json:19` defines it; no `.github` reference | — |
| W1, W8, W11, W13, W39 | closed earlier (dropped by ruling / deleted / fixed, per the audit's own table and note) | not re-opened | — |

## Still open, smallest fix each (none on the submit path except W5-residual)

| ID | Smallest fix | File |
|---|---|---|
| **W5 residual** | third form-shape stop: no file input → `no_resume_field` (Manual lane), plus a red-on-revert test | `worker/src/apply-one.ts` (`formShapeBlockersFor`) |
| W29 residual | skip any kit row whose job has no `apply_url` (not only parked ones), or stamp it as a `KitSkip` | `worker/src/apply-kit-sweep.ts:177-178` (or `apply-kit.ts:446`) |
| W10 | Teja rules: wire the 2 caps into `claim_applications`, or drop and document them as unused | new migration, or `SCHEMA_CONTRACT.md` |
| W19 | Teja: delete or ban the never-signed-in user; confirm signup is off (dashboard) | live Auth, by the orch |
| W20 leftover | drop `& Record<string, unknown>` once `EmailEventInsert` carries the fields `decide.ts` writes | `supabase/functions/email-tracker-intake/decide.ts:529` |
| W23 | delete `freshness-queue.ts`; decide `matcher_eval_cases` (drop it, or build its writer) | `supabase/functions/matcher/` |
| W27 | one shared persist-and-close path for both scouts | `_shared/scout/` |
| pipelineRunner | count `dropped` (and `pre_gate_dropped`) as matcher moves | `apps/web/src/data/pipelineRunner.ts:66` |
| W36 | `apps/web/tsconfig.test.json` (`include: ["src","test"]`) + a CI tsc step | `apps/web/`, `.github/workflows/ci.yml` |
| W37 | append `fn, sha, date` to a committed ledger at each deploy, or run `deploy-drift.mjs` as a required pre-deploy step | `docs/tooling/`, the deploy runbook |
| W38 | enable Vercel "wait for checks" / branch protection on `ci` | Vercel / GitHub settings |
| worker e2e | add a `pnpm test:e2e` step to the worker job | `.github/workflows/ci.yml:~415` |

## Caveats
- W17, W24-W26, W28 and W32 rest on the 2026-11-08 status note plus the four agents' passing reads; they were not
  re-traced line by line here.
- The W5 residual is a code-path argument; it has not been reproduced on a live page. A fixture test (an email-only
  form) would prove it in the same way the jobicy case was pinned.
- Live counts were taken at ~23:40 IST.
