# Services, agents and modules — snapshot 2026-11-05

**Dated record — never edited.** Code at `00ecabb`; live state (Supabase, GitHub) read the
same night. The living view of how these connect is
[../SYSTEM_ARCHITECTURE.md](../SYSTEM_ARCHITECTURE.md). This file is the counted inventory.

## Services (deployable runtime units)

**28 runtime units on 4 hosting platforms.** None of it runs on a server you manage.

| # | Service | Platform | Runtime | Deploys by | Regenerate |
|---|---|---|---|---|---|
| 1 | Web console (static SPA) | Vercel | browser | push to `main` (Vercel Git integration) | — |
| 2 | `api/render-job-page.ts` | Vercel Function (Fluid), 60 s max | Node + `@sparticuz/chromium` | same push | `ls api` |
| 3 | Postgres 17 + Auth + Storage (2 private buckets) | Supabase | Postgres | `supabase db push` from a pinned worktree (orchestrator) | MCP `list_migrations` |
| 4–20 | **17 edge functions**, all ACTIVE | Supabase Edge | Deno | `supabase functions deploy` from a pinned worktree (orchestrator) | MCP `list_edge_functions`; `ls supabase/functions/*/index.ts` |
| 21–27 | **7 worker CLIs** (`apply`, `apply-kit`, `assist`, `keepalive`, `run-one`, `scout`, `scout-remote`) | GitHub Actions runners (+ local for `assist`) | Node 24 + Playwright | run from the checked-out commit | `ls worker/src/cli` |
| 28 | Gmail email tracker (`email-tracker.gs`) | Google Apps Script, hourly trigger + `doPost` web app | Apps Script (V8) | pasted into the script editor by hand | `git ls-files '*.gs'` |

**Scheduler:** GitHub Actions is the only clock. Postgres has no pg_cron or pg_net. There are
**12 workflows**: 1 CI, 6 scheduled, 5 dispatch-only. See
[2026-11-05-integrations-apis-ci.md](2026-11-05-integrations-apis-ci.md).

## Agents

"Agent" here means a named actor in the status graph. The `agent_name` enum has **17 values**,
and `applications.status` moves only through `advance_application_status()` with one of them.
The DB tells a machine agent from a human by the `x-applyy-agent-key` header, not by the JWT.
Every caller signs in as the same app user.

### Pipeline agents (move `applications.status`)

| Agent | Runs as | Uses Gemini | Moves | Triggered by |
|---|---|---|---|---|
| scout (ATS) | edge `scout-ats` + worker `scout.ts` | no | inserts at `passed_filters` / `dropped_filter` (screened on insert) or `discovered` | Discovery page · `scout.yml` (2×/day) |
| scout (remote feeds) | worker `scout-remote.ts` | no | inserts, same screener path | `scout-remote.yml` (daily) |
| scout (web search) | edge `scout-web` | **yes** (Google Search grounding) | inserts at `discovered` | Web Scout panel |
| pasted-link intake | edge `job-link-intake` (acts as `human`) | **yes** (extraction) | inserts or revives to `passed_filters`, then runs matcher → tailor → auditor in the background | Add-a-job-by-link · `ingest-links.yml` |
| normalizer | edge | no | `discovered → deduped / dropped_duplicate` | Run pipeline · `prescreen-drain.yml` |
| screener | edge | no (deterministic cascade) | `deduped → passed_filters / dropped_filter` | Run pipeline · `prescreen-drain.yml` |
| matcher | edge | **yes** | `passed_filters → scored / dropped_filter / failed` | Run pipeline · `run-one` · `postscreen-drain` · `pregate-sweep` |
| tailor | edge | **yes** (refs to master nodes only, so it cannot invent) | `scored → tailored` | same |
| auditor | edge | no (anti-fabrication detector) | `tailored → audit_clean / audit_flagged → awaiting_approval` | same |
| **human** | the web console | — | `awaiting_approval → approved`, plus every re-entry edge | Teja |
| applier | worker `apply.ts` | no | `approved → applying → applied / blocked_needs_human / failed` | `apply.yml` (dry unless dispatched live, or `APPLYY_CRON_LIVE=true`, which is **unset** today) |
| sweeper | `sweep_stale_claims()` | no | `applying → needs_verification` | the applier's claim loop |
| tracker | edge `email-tracker-intake` | no (deterministic classifier) | receipt `applying → applied`; `applied → employer_screening / oa_pending / interview / rejected / offer` | Apps Script push, hourly |

### Satellite agents (write side tables, never move status)

| Agent | Edge function | Uses Gemini | Writes | Triggered by |
|---|---|---|---|---|
| cover letter | `cover-letter` | yes | `applications.cover_letter` | `satellites.yml` daily (`APPLYY_SATELLITES_LIVE=true`) |
| follow-up | `follow-up` | yes | `follow_up_nudges` | same |
| interview prep | `interview-prep` | yes | `interview_prep_packs` | same |
| referral | `referral` | yes | drafts in `application_events` | same |
| skill gap | `skill-gap` | no | `skill_gap_reports` | same |
| résumé assist | `resume-assist` | yes | nothing (proposes edit ops; the human saves) | approval page AI box |
| apply kit | worker `apply-kit.ts` | no | one `application_events` note + rendered résumé | `apply-kit.yml` |

### Support functions

`gmail-sync` proxies "sync now" to the Apps Script web app. `rls-proof` is a one-shot RLS
diagnostic that refuses the prod project.

**Gemini callers: 9 of 17 functions.** They are matcher, tailor, scout-web, job-link-intake,
cover-letter, follow-up, interview-prep, referral and resume-assist. All go through
`_shared/gemini/client.ts`, which does multi-key failover (keys `GEMINI_API_KEY_01..99`,
LRU in Postgres via `claim_gemini_key`). It retries 429/5xx up to 3 times with backoff and a
25 s timeout per attempt. A 500 ms pacer sets the minimum gap between calls, and an optional
fallback model takes over after a 503. The live model is the `GEMINI_MODEL` secret. The code
default (`gemini-3.8-flash`) applies only when the secret is unset.

## Modules

### `apps/web/src` (React console)

| Module | Files | What it is |
|---|---:|---|
| `app/` | 18 | shell: nav rail, router map (`routes.ts`), theme, toasts, command palette, error boundary |
| `data/` | 14 | the one supabase-js client, key-role guard, `contract.ts` (schema seam), read hooks, pipeline runner |
| `styles/` | 2 | design tokens (`light-dark()`), base CSS |
| `features/settings` | 20 | the 6 configuration pages: search prefs, master profile, answer bank, filters, watchlist, blocklist |
| `features/approval` | 16 | two-bucket approval queue, diff view, AI edit, attest, résumé chat |
| `features/discovery` | 11 | discovered-jobs explorer, web scout, add-job-by-link, pipeline-run modal |
| `features/pipeline` | 11 | the pipeline board and row drawer (reports, does not drive) |
| `features/health` | 4 | system health + recovery queue |
| `features/manual-apply` | 4 | jobs applied by hand with the form pre-answered |
| `features/emails` | 3 | email intake and interview tracker monitor |
| `features/resume-preview` | 3 | tailored résumé beside its master (iframes) |
| `features/analytics` | 2 | skill-gap ranking |
| `features/auth` | 2 | login screen (rendered by the shell, not a route) |
| `features/followup` | 2 | follow-up nudge queue |
| `features/referral` | 2 | referral outreach queue |
| `features/profile` | 1 | browser-side résumé PDF extraction |
| `features/applied` | — | **WIP, uncommitted** at snapshot time (Applied jobs page) |

**Routes: 15 pages** (9 operations + 6 configuration) plus `*` → NotFound. `/` redirects to
`/approvals`. The browser reads 15 tables and calls 2 RPCs (`advance_application_status`,
`application_status_counts`), 1 storage bucket (`resumes`) and 10 edge functions. Realtime is
configured in the client but nothing subscribes, even though `PipelinePage.tsx`'s header says
otherwise.

### `supabase/functions/_shared` (the agents' shared core)

Grouped by domain. **[n]** = imported directly by n function directories.

| Domain | Modules |
|---|---|
| db | `client.ts` [16]: app-user sign-in under RLS · `gates.ts` [14]: caller auth + fail-closed kill switch · `agent-key.ts` |
| http | `cors.ts` [11] · `http/index.ts` [3]: robots-gated transport with retry (ported idea from MadsLorentzen/ai-job-search, MIT) · `application-id.ts` [5] · errors · retry-after · concurrency |
| contracts | `contracts/shared-types.ts` [11]: the one bridge to `@applyy/shared-types` |
| gemini | `client.ts` [8] · `failure-message.ts` [7] · `pool.ts` |
| ats / scout | `ats/registry.ts` [3] + greenhouse · lever · ashby · identity · types; `scout/adapters/` smartrecruiters · workday (registered), workable · adzuna · jooble (not wired) |
| screen / filter | `screen-batch.ts` [3] · `context.ts` [3] · tech-gate · work-auth-gate · required-experience · persist-verdict · `filter/cascade.ts` |
| normalize | fingerprint · normalize-batch · existing-job-lookup · posted-at |
| match | prompt · rubric · salary-gate · score-threshold · scorer |
| tailor | prompt · validator · validator-ats · ats-simulator (unwired) · jd-keywords · persist · tailor-batch · tailorer |
| audit | audit · detector · pinned-master |
| email / intake | classifier · parser · intake auth · email-contract · `apps-script/email-tracker.gs` |
| satellites | follow-up · interview-prep · analytics (skill gap) |
| agent | batch · deadline · kill-switch · loop · port · status |
| pipeline · eval | `row-pipeline.ts` (also imported by the web) · matcher eval gate |

### `worker/src`

Claim loop (`claim-loop.ts`: cap 3 submits, circuit breaker, kill switch between rows),
`apply-one.ts` (Workday guard → robots gate → page), `playwright-page.ts`
(`SUBMISSION_IMPLEMENTED = true`), `submission-mode.ts` (dry unless exactly `'false'`),
`form-url.ts`, `scout/` (board pages, remote feeds), and the 7 `cli/` entry points.

### `packages/`

5 shared libraries. They are listed in
[2026-11-05-frameworks-dependencies.md](2026-11-05-frameworks-dependencies.md). The web imports
`resume-template` and `_shared/{tailor,audit,pipeline}` by **deep relative path**, not as
declared deps. That works without an install, but a dependency graph tool cannot see it.

## Tests

| Area | Test files | Runner |
|---|---:|---|
| `supabase/functions` | 88 (`_shared` 64, functions 24) | `node --test` (Deno only type-checks) |
| `apps/web` | 82 | `node --test` + Playwright e2e in the same glob |
| `worker` | 40 | Vitest 4.1.12 |
| `packages/*` | 15 (master-ingest 6, master-pdf 3, master-robots 3, resume-template 2, shared-types 1) | `node --test` |
| `api` | 1 | `node --test` |
| `supabase/tests` | 1 (`invariants.sql`, by hand) | psql / MCP |

Tests are **36 %** of non-blank code lines (59,383 of 164,795). No edge function `index.ts`
has a test. Logic lives in tested modules, and `index.ts` stays thin wiring. Five function
directories have zero tests of their own: auditor, follow-up, normalizer, screener and tailor.
Their logic is tested in `_shared`.
