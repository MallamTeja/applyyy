# Services, agents and modules

_Last verified against code: 2026-11-08 (2a9ac31)._

The living view of how these parts connect is
[../SYSTEM_ARCHITECTURE.md](../SYSTEM_ARCHITECTURE.md). This file is the inventory: what
runs, who moves a row, and where the code lives. Counts are "as of 2026-11-08" with the
command that regenerates them.

## Services (deployable runtime units)

None of it runs on a server you manage. Four hosting platforms: Vercel, Supabase, GitHub
Actions and Google Apps Script.

| Service | Platform | Runtime | Deploys by | Regenerate |
|---|---|---|---|---|
| Web console (static SPA) | Vercel | browser | push to `main` (Vercel Git integration) | — |
| `api/render-job-page.ts` | Vercel Function, 60 s max (`vercel.json`) | Node + `@sparticuz/chromium` | same push | `ls api` |
| Postgres 17 + Auth + Storage | Supabase | Postgres | `supabase db push` from a pinned worktree (orchestrator, `CLAUDE.md` §3) | MCP `list_migrations` |
| Edge functions (18 as of 2026-11-08) | Supabase Edge | Deno | `supabase functions deploy … --import-map supabase/functions/deno.json` from a pinned worktree (orchestrator) | `ls supabase/functions/*/index.ts`; MCP `list_edge_functions` |
| Worker CLIs (9 as of 2026-11-08) | GitHub Actions runners, or local | Node 24 + Playwright | run from the checked-out commit | `ls worker/src/cli` |
| Gmail email tracker (`email-tracker.gs`) | Google Apps Script, hourly trigger + `doPost` web app | Apps Script (V8) | pasted into the script editor by hand | `git ls-files '*.gs'` |

The worker CLIs (`worker/src/cli/`, scripts in `worker/package.json`):

| CLI | Runs where | What it does |
|---|---|---|
| `scout.ts` | `scout.yml` | polls the ATS boards on the watchlist |
| `scout-remote.ts` | `scout-remote.yml` | reads the remote job feeds |
| `apply.ts` | `apply.yml` | the claim loop: submits `approved` rows |
| `apply-kit.ts` | `apply-kit.yml` | builds the apply kit (pre-answered form + résumé) for approved rows |
| `run-one.ts` | `run-one.yml` | matcher → tailor → auditor for one row |
| `keepalive.ts` | `keepalive.yml` | keeps the Supabase project and the repo active |
| `assist.ts` | local, headed | assisted submit with a human at the browser (reCAPTCHA) |
| `rehearse-assist.ts` | local | read-only rehearsal of an assisted submit: no claim, no write |
| `resume-pages.ts` | local | prints the real PDF page count of each résumé (the one-page rule) |

**Scheduler:** GitHub Actions is the only clock. Postgres has no pg_cron or pg_net. See
[2026-11-05-integrations-apis-ci.md](2026-11-05-integrations-apis-ci.md#cicd-workflows).

## Agents

"Agent" here means a named actor in the status graph. Its identity is a value of the
`agent_name` enum (18 values as of 2026-11-08: `packages/shared-types/src/enums.ts`
`AGENT_NAMES`). `applications.status` moves only through `advance_application_status()`. The
DB tells a machine agent from a human by the `x-applyy-agent-key` header, not by the JWT.
Every caller signs in as the same app user (`CLAUDE.md` §7).

### Pipeline agents (move `applications.status`)

| Agent | Runs as | Uses Gemini | Moves | Triggered by |
|---|---|---|---|---|
| scout (ATS) | edge `scout-ats` + worker `scout.ts` | no | inserts at `passed_filters` / `dropped_filter` (screened on insert); retires rows whose posting closed (`_shared/scout/queue-liveness.ts`, `feed-liveness.ts`) | Discovery page · `scout.yml` (3× a day) |
| scout (remote feeds) | worker `scout-remote.ts` | no | inserts, same screener path | `scout-remote.yml` (daily) |
| scout (web search) | edge `scout-web` | **yes** (Google Search grounding) | inserts at `discovered` | Web Scout panel |
| pasted-link intake | edge `job-link-intake` (acts as `human`) | **yes** (extraction) | inserts or revives to `passed_filters`, then runs matcher → tailor → auditor in the background | Add-a-job-by-link · `ingest-links.yml` |
| normalizer | edge | no | `discovered → deduped / dropped_duplicate` | Run pipeline · `prescreen-drain.yml` |
| screener | edge | no (deterministic cascade) | `deduped → passed_filters / dropped_filter` | Run pipeline · `prescreen-drain.yml` |
| matcher | edge | **yes** | `passed_filters → scored / dropped_filter / failed`; advance floor 30 (`_shared/match/score-threshold.ts`) | Run pipeline · `run-one` · `postscreen-drain` · `pregate-sweep` |
| tailor | edge | **yes** (refs to master nodes only, so it cannot invent) | `scored → tailored` | same |
| auditor | edge | no (anti-fabrication detector) | `tailored → audit_clean / audit_flagged → awaiting_approval` | same |
| **human** | the web console | — | `awaiting_approval → approved`, `approved → applied / failed` (Manual apply), plus every re-entry edge | Teja |
| applier | worker `apply.ts` | no | `approved → applying → applied / blocked_needs_human / failed` | `apply.yml`, or `dispatch-apply` on approve (see below) |
| sweeper | `sweep_stale_claims()` | no | `applying → needs_verification` | the applier's claim loop |
| tracker | edge `email-tracker-intake` | no (deterministic classifier) | receipt `applying → applied`; `applied → employer_screening / oa_pending / interview / rejected / offer` | Apps Script push, hourly |

To read the real edges, never this table: `select * from application_status_transitions`.

**Apply on approve.** After a successful approve, the browser calls the edge function
`dispatch-apply` (`apps/web/src/features/approval/dispatchApply.ts`). It always dispatches
`apply-kit.yml`. It dispatches a live `apply.yml` drain **only** when
`system_settings.auto_apply_on_approve` is exactly true
(`supabase/functions/dispatch-apply/handler.ts`). The switch was off live on 2026-11-08.
Scheduled `apply.yml` runs stay dry unless the repo variable `APPLYY_CRON_LIVE` is `true`.

### Satellite and housekeeping agents (never move status)

| Agent | Runs as | Uses Gemini | Writes | Triggered by |
|---|---|---|---|---|
| cover letter | edge `cover-letter` | yes | `applications.cover_letter` | `satellites.yml` daily (`APPLYY_SATELLITES_LIVE=true`) |
| follow-up | edge `follow-up` | yes | `follow_up_nudges` | same |
| interview prep | edge `interview-prep` | yes | `interview_prep_packs` | same |
| referral | edge `referral` | yes | drafts in `application_events` | same |
| skill gap | edge `skill-gap` | no | `skill_gap_reports` | same |
| résumé assist | edge `resume-assist` | yes | nothing (proposes edit ops; the human saves) | approval page AI chat |
| apply kit | worker `apply-kit.ts` | no | one `application_events` note + rendered résumé; `unanswered_questions` | `apply-kit.yml` |
| jobs tombstone | `tombstone_dropped_jobs()` RPC | no | slims old `dropped_filter` rows in `jobs`; logs to `agent_runs` | `jobs-tombstone.yml` (weekly) |
| keepalive | worker `keepalive.ts` | no | `agent_runs` | `keepalive.yml` |

### Support functions

`gmail-sync` proxies "sync now" to the Apps Script web app. `dispatch-apply` starts GitHub
workflows (above). `rls-proof` is a one-shot RLS diagnostic that refuses the prod project.

**Gemini callers: 9 functions** as of 2026-11-08: matcher, tailor, scout-web,
job-link-intake, cover-letter, follow-up, interview-prep, referral and resume-assist.
Regenerate: `git grep -l "gemini/client" -- 'supabase/functions/*/*.ts' 'supabase/functions/_shared/*/*.ts'`.
All go through `supabase/functions/_shared/gemini/client.ts`. It does multi-key failover
(secrets `GEMINI_API_KEY_01..99`, `_shared/gemini/pool.ts`; least-recently-used key chosen
in Postgres by `claim_gemini_key`). It retries 429 and 5xx with backoff, with a 25 s timeout
per attempt. A pacer sets the minimum gap between calls. An optional fallback model
(`GEMINI_FALLBACK_MODEL`) takes over after a 503. The live model is the `GEMINI_MODEL`
secret. The code default `GEMINI_DEFAULT_MODEL` applies only when the secret is unset.

## Modules

### `apps/web/src` (React console)

| Module | What it is |
|---|---|
| `app/` | shell: nav rail, router map (`routes.ts`), theme, toasts, command palette, error boundary, `InlineConfirm.tsx` |
| `data/` | the one supabase-js client (`supabase.ts`), key-role guard (`keyRole.ts`), `contract.ts` (schema seam), `edgeCall.ts` (every edge call), read hooks, `pipelineRunner.ts`, `agentFreshness.ts` |
| `styles/` | design tokens (`light-dark()`), base CSS |
| `features/settings` | configuration pages: search prefs, master profile, answer bank (with Unanswered questions), filters, watchlist, blocklist |
| `features/approval` | approval queue, diff view, AI chat edit (`resumeChat.ts`, `aiEdit.ts`), attest, one-page fit (`pageFitEdit.ts`), apply-on-approve call (`dispatchApply.ts`) |
| `features/discovery` | discovered-jobs explorer, web scout, add-job-by-link, pipeline-run modal |
| `features/pipeline` | the pipeline board and row drawer |
| `features/manual-apply` | approved jobs to apply by hand with the kit; "Bot can't apply" reason; Mark applied / failed; "Left your queue" |
| `features/applied` | applied jobs with the form answers prepared for each |
| `features/health` | system health + recovery queue |
| `features/emails` | email intake and interview tracker monitor |
| `features/resume-preview` | tailored résumé beside its master |
| `features/analytics` | skill-gap ranking |
| `features/auth` | login screen (rendered by the shell, not a route) |
| `features/followup` | follow-up nudge queue |
| `features/referral` | referral outreach queue |
| `features/profile` | browser-side résumé PDF extraction |

**Routes:** 16 paths as of 2026-11-08 (operations pages plus 6 configuration pages). Read
them in `apps/web/src/app/routes.ts`. Realtime is not used: there is no `.channel(` call in
`apps/web/src` (check with `git grep -n "\.channel(" -- apps/web/src`).

### `supabase/functions/_shared` (the agents' shared core)

| Domain | Modules |
|---|---|
| db | `db/client.ts` (app-user sign-in under RLS) · `db/gates.ts` (caller auth + fail-closed kill switch) · `db/agent-key.ts` |
| http | `cors.ts` (origin allow-list + error boundary) · `http/` (robots-gated transport with retry, `retry-after.ts`) |
| contracts | `contracts/shared-types.ts`: the one bridge to `@applyy/shared-types` |
| gemini | `client.ts` · `pool.ts` · failure messages |
| ats / scout | `ats/registry.ts` + greenhouse · lever · ashby · identity; `scout/adapters/workday.ts` (registered); `scout/adapters/` workable · adzuna · jooble (written, not wired); liveness, freshness, tiers |
| screen / filter | `screen/` (tech gate, work-auth gate, required experience, batch, persist) · `filter/cascade.ts` · `pregate-config-loader.ts` |
| normalize | fingerprint · normalize batch · existing-job lookup · posted-at |
| match | prompt · rubric · salary gate · `score-threshold.ts` · scorer |
| tailor | prompt · validator · jd-keywords · persist · batch · tailorer |
| audit | audit · detector · pinned master |
| email / intake | `email/` classifier and parser · `intake/` · `apps-script/email-tracker.gs` · `track-email-link-existing.test.ts` |
| satellites | `follow-up/` · `interview-prep/` · `analytics/` (skill gap) |
| agent | batch · deadline · kill switch · loop · status |
| pipeline · eval | `pipeline/` (row pipeline, also imported by the web) · `eval/` (matcher eval gate) |

Regenerate the domain list: `ls supabase/functions/_shared`.

### `worker/src`

| File | Role |
|---|---|
| `claim-loop.ts` | claims `approved` rows; submit cap, circuit breaker, kill switch between rows |
| `apply-one.ts` | one row: Workday guard → robots gate → page → submit; records refused required fields |
| `playwright-page.ts` | the browser driver (`SUBMISSION_IMPLEMENTED = true`, line 21) |
| `submission-mode.ts` | dry unless the input is exactly `'false'` |
| `extract-fields.ts`, `plan-fill.ts`, `profile-answers.ts` | read a form, plan answers from the answer bank and profile |
| `apply-kit.ts`, `apply-kit-sweep.ts` | the apply kit for Manual apply |
| `render-resume-pdf.ts`, `resume-renderer.ts`, `plan-resume-attachment.ts` | the résumé PDF (one page, or refused) |
| `assist/` | assisted submit, rehearsal, sign-in check |
| `scout/` | board pages, remote feeds, liveness marking, persistence |
| `cli/` | the 9 entry points listed above |

### `packages/`

Five shared libraries, listed in
[2026-11-05-frameworks-dependencies.md](2026-11-05-frameworks-dependencies.md#packages-all-private-esm-source-only-exports-no-build-step).
The web imports `resume-template` and parts of `supabase/functions/_shared/` by **deep
relative path**, not as declared deps. That works without an install, but a dependency graph
tool cannot see it. Moving an exported name therefore needs a whole-repo `git grep`
(`CLAUDE.md` §3).

## Tests

| Area | Test files (as of 2026-11-08) | Runner |
|---|---:|---|
| `supabase/functions` | 107 | `node --test` (Deno only type-checks) |
| `apps/web` | 124 | `node --test` + Playwright e2e in the same glob |
| `worker` | 54 | Vitest 4.1.12 |
| `packages/*` | 16 | `node --test` |
| `api` | 1 | `node --test` (`pnpm run test:api`) |
| `supabase/tests` | 1 (`invariants.sql`, run by hand) | psql / MCP |

Regenerate: `git ls-files '*.test.ts' | cut -d/ -f1-2 | sort | uniq -c`.

Tests are about 39 % of non-blank lines (`node scripts/repo-stats.mjs`). No edge function
`index.ts` has a test: logic lives in tested modules, and `index.ts` stays thin wiring (see
`supabase/functions/dispatch-apply/index.ts` for the pattern). The function directories
`follow-up`, `normalizer` and `screener` have no tests of their own; their logic is tested
in `_shared`.
