# CI and GitHub Actions workflows

_Last verified against code: 2026-11-08 (2a9ac31)._

This page describes every file in `.github/workflows/`: what starts it, what it runs, which
secrets and variables it reads, and what stops it from doing harm. The workflow files are the
source of truth. Each one has long comments that explain the "why". Read them before you change
a trigger, a cap or a guard.

Regenerate the list of workflows:

```bash
git ls-files .github/workflows
```

## Contents

- [Quick table](#quick-table)
- [Rules that apply to every workflow](#rules-that-apply-to-every-workflow)
- [How to read "CI is green" correctly](#how-to-read-ci-is-green-correctly)
- One section per workflow: [ci.yml](#ciyml), [apply.yml](#applyyml), [apply-kit.yml](#apply-kityml),
  [scout.yml](#scoutyml), [scout-remote.yml](#scout-remoteyml), [satellites.yml](#satellitesyml),
  [keepalive.yml](#keepaliveyml), [jobs-tombstone.yml](#jobs-tombstoneyml), [run-one.yml](#run-oneyml),
  [prescreen-drain.yml](#prescreen-drainyml), [pregate-sweep.yml](#pregate-sweepyml),
  [postscreen-drain.yml](#postscreen-drainyml), [ingest-links.yml](#ingest-linksyml)
- [Tests that guard the workflow files](#tests-that-guard-the-workflow-files)

## Quick table

Times are UTC in the cron line. IST is UTC + 5:30.

| File | Triggers | Cron (UTC) | Writes live data? | Safe default |
|---|---|---|---|---|
| `ci.yml` | push to `main`, PR to `main` | none | No | Needs no secrets |
| `apply.yml` | schedule, manual | `30 2 * * *` | Yes (submits) | Dry unless `APPLYY_CRON_LIVE` is `true` (cron) or `dry_run=false` (manual) |
| `apply-kit.yml` | after `apply.yml`, schedule, manual | `0 12 * * *` | Yes (kit notes only, no status) | Never submits |
| `scout.yml` | schedule, manual | `17 0,12 * * *` and `17 4 * * *` | Yes (jobs, applications) | Respects the system kill switch unless `force` |
| `scout-remote.yml` | schedule, manual | `30 1 * * *` | Yes (jobs, applications) | `dry_run` input (manual only) |
| `satellites.yml` | schedule, manual | `23 13 * * *` | Yes (drafts only, no status) | Cron skipped unless `APPLYY_SATELLITES_LIVE` is `true` |
| `keepalive.yml` | schedule, manual | `15 6 */3 * *` | Yes (ping row, branch push) | Never touches `main` |
| `jobs-tombstone.yml` | schedule, manual | `45 6 * * 0` | Yes (purges dropped-job text) | Grace window `min_age_days` = 7 |
| `run-one.yml` | manual only | none | Yes (one row) | Never submits |
| `prescreen-drain.yml` | manual only | none | Yes (drops rows) | `dry_count_only` checkbox |
| `pregate-sweep.yml` | manual only | none | Yes (drops rows) | `dry_count_only` checkbox |
| `postscreen-drain.yml` | after either scout completes, daily 04:30 UTC, manual (Teja ruling 2026-11-09) | none | Yes (drops and tailors rows) | `dry_count_only` checkbox |
| `ingest-links.yml` | manual only | none | Yes (new rows) | `dry_run` defaults to ON |

All jobs run on `runs-on: ubuntu-latest`. No workflow uses a self-hosted runner at this commit
(the design is still pending: `docs/ops/2026-11-05-self-hosted-runner.md`).

## Rules that apply to every workflow

### GitHub cron is best-effort

GitHub delays scheduled runs, and under load it can drop them. Delays are worst at the top of
the hour, which is why several crons use an odd minute (`17`, `23`). Measured in this repo:
`apply.yml` is set for 02:30 UTC (08:00 IST) but really starts around 13:30-15:30 IST, and
scout runs started 3-6 hours late in late October (`.github/workflows/scout.yml` comments,
repo `CLAUDE.md` §4).

Never trust the cron line for "when did it run". Read the real start times:

```bash
gh run list --workflow=apply.yml --limit 10
```

### Secrets and variables

Names only. Never write a value into a doc. Regenerate the current lists:

```bash
gh secret list      # repository Actions secrets
gh variable list    # repository Actions variables
```

| Name | Kind | Read by | Purpose |
|---|---|---|---|
| `SUPABASE_URL` | secret | every workflow except `ci.yml` | Supabase project URL |
| `SUPABASE_ANON_KEY` | secret | every workflow except `ci.yml` | Public anon key, used to sign in |
| `APPLYY_APP_USER_EMAIL` | secret | every workflow except `ci.yml` | The app user the jobs sign in as |
| `APPLYY_APP_USER_PASSWORD` | secret | every workflow except `ci.yml` | That user's password |
| `APPLYY_AGENT_KEY` | secret | `apply.yml`, `apply-kit.yml` | Sent as `x-applyy-agent-key`; marks the caller as a machine agent (repo `CLAUDE.md` §7) |
| `STORAGE_STATE_ENC_KEY` | secret | `apply.yml` | Decrypts saved browser sessions |
| `APPLYY_CRON_LIVE` | variable | `apply.yml` | Makes the scheduled applier run live |
| `APPLYY_SATELLITES_LIVE` | variable | `satellites.yml` | Lets the scheduled satellites run proceed |
| `github.token` | built-in | `apply.yml`, `apply-kit.yml` (redispatch jobs only) | Starts the next run |

As of 2026-11-08, `gh variable list` shows `APPLYY_SATELLITES_LIVE` and does NOT show
`APPLYY_CRON_LIVE`. So scheduled applier runs are dry today. Re-run the command before you
rely on this.

Why the app-user password lives in GitHub: the credentials were set as Actions secrets on
2026-09-11 for `apply.yml`, and they are not on the operator's PC. That is why `run-one`,
the drains, the sweep and `ingest-links` exist as workflows at all (header comment of each file).

### Least privilege

- Most workflows set `permissions: contents: read`. `satellites.yml` sets `permissions: {}`.
- `keepalive.yml` is the only one with `contents: write`, and it pushes only to the
  `automation-keepalive` branch.
- `actions: write` is granted only to the small `redispatch` jobs in `apply.yml` and
  `apply-kit.yml`. The main job runs third-party code (install scripts, Playwright, live job
  pages), so it must never hold a token that can start workflows.
- Secrets are set as step-level `env`, not job-level, so they do not reach install scripts or
  other steps (`.github/workflows/scout.yml`, comment above `steps:`).
- Third-party actions are pinned to a full commit SHA.

### One run at a time

Every workflow that writes, except `keepalive.yml` and `jobs-tombstone.yml`, has a
`concurrency` group with `cancel-in-progress: false`. A second run waits instead of racing
the first over the same rows. `run-one.yml` keys its group on the application id, so two
different rows can run in parallel.

### Budget

The repo is private, on the Free plan's 2,000 Actions minutes a month. GitHub bills each JOB
rounded up to a whole minute. This is why `apply.yml` batches the whole day into one run and
why `ci.yml` is one job, not six (header comments of both files). Check usage before you add a
schedule or a job.

## How to read "CI is green" correctly

Use the FULL 40-character SHA and name the workflow:

```bash
gh run list --commit <full-40-char-sha> --workflow=ci.yml
```

- **Full SHA.** A short-SHA lookup can race with newer pushes and match the wrong run.
- **`--workflow=ci.yml`.** Without it, the list shows every workflow that ran at that SHA
  (keepalive, a pre-gate sweep, any manual dispatch on `main`). The first row is often not CI.
  On 2026-11-04 a pre-gate sweep run was quoted as "CI green" this way (repo `CLAUDE.md` §4).
- **Docs-only pushes run no CI.** `ci.yml` has `paths-ignore: ['docs/**', '**/*.md']`. If every
  changed path matches, GitHub starts no run, so the lookup is empty. Empty means "not
  triggered", not "pending" and not "failed". Read the verdict of the newest code commit at or
  before it.
- **Read the conclusion, not the status.** `completed` with conclusion `success` is green.

To read a job log, `gh run view --log` returns 0 bytes in this environment. Use the API instead:

```bash
gh api repos/MallamTeja/applyyy/actions/jobs/<job-id>/logs
```

---

## ci.yml

**Name:** `ci`. **Purpose:** typecheck and test every part of the repo.

**Triggers:**
- `push` to `main` and `pull_request` to `main`.
- `paths-ignore`: `docs/**` and `**/*.md`. A push that mixes a doc with code still runs
  (proved by `worker/test/ci-workflow.test.ts`).

**Secrets:** none, on purpose. Every step is static analysis or a hermetic test. A PR from a
fork gets no secrets, and a check that needs credentials would skip silently.

**Concurrency:** group `ci-<sha>` for pushes and `ci-<ref>` for PRs. Only PR runs cancel an
older run in progress.

**Shape:** one job, `ci (deno, edge, packages, web, worker)`, timeout 30 min. Setup (checkout,
Deno, pnpm, Node, `pnpm install --frozen-lockfile`, cached Chromium) runs once. Every check
step has `if: !cancelled() && steps.setup-done.outcome == 'success'`, so one failing check
does not hide the others.

**Checks, in order:**

| Step | What it runs | Anti-vacuous gate |
|---|---|---|
| Deno check | `deno check --reload` over `supabase/functions/*/index.ts` and `_shared/**/*.ts` (no `*.test.ts`) | Fails if no files matched, or if the `Check` line count is not equal to the file count |
| Edge tests | `node --test "supabase/functions/**/*.test.ts"` | Fails if `tests` = 0, `cancelled` > 0, or any `✖` line |
| shared-types tests | `node --test "packages/shared-types/test/**/*.test.ts"` | Same three gates |
| Package tests | `node --test` for each `packages/*/test` (except shared-types) | Same gates per package, and fails if no package ran |
| Web typecheck | `apps/web`: `tsc --noEmit` | exit code |
| Web build | `apps/web`: `vite build`, then `vite build --mode e2e` | exit code |
| Web tests | `pnpm --filter @applyy/web test` | Same three gates |
| Render function | `tsc -p api/tsconfig.json`, then `node --test "api/_render/*.test.ts"` | Same three gates |
| Worker typecheck | `worker`: `tsc --noEmit` | exit code |
| Worker tests | `worker`: `vitest run` | exit code |
| Secret scan | gitleaks 8.30.1 (download checked by sha256) over the commits this push or PR adds | `--exit-code 1` |

Why the gates count work: on 2026-10-04 several laptop runs nearly passed with zero files
checked or `tests 0`. A green result must prove the checks ran (repo `CLAUDE.md` §5).

Why gitleaks: GitHub secret scanning is off on this private repo
(`docs/security/2026-11-05-vulnerability-remeasure.md`, finding #2).

## apply.yml

**Name:** `applyy applier (daily batch)`. **Runs:** `pnpm --filter '@applyy/worker' run apply`
(`worker/src/cli/apply.ts`). This is the step that submits applications.

**Triggers:**
- `schedule`: `30 2 * * *` (08:00 IST on paper; see best-effort note above).
- `workflow_dispatch` with inputs:
  - `dry_run` (default `'true'`). Only the exact string `false` makes a manual run live.
  - `apply_only_id` (default blank). One application UUID.
  - `drain_approved` (default `'false'`). `true` with `dry_run=false` submits approved rows,
    up to 25 per run. Sent by the `dispatch-apply` edge function.

**Secrets:** the four app-user/Supabase secrets, `APPLYY_AGENT_KEY`, `STORAGE_STATE_ENC_KEY`.
**Variable:** `APPLYY_CRON_LIVE`.

**Gates (all in shell, before the worker starts):**
1. **Mode.** `DRY_RUN=true` by default. It becomes `false` only for a manual run with
   `dry_run` exactly `false`, or a scheduled run with `APPLYY_CRON_LIVE` exactly `true`. The
   test is shell `[ = ]`, not a `${{ }}` expression, because GitHub's expression `==` ignores
   case (`FALSE` would have run live; audit W30, 2026-11-01).
2. `drain_approved` and `apply_only_id` cannot both be set.
3. A live manual run must name one `apply_only_id`, or set `drain_approved=true`. This stops
   `dry_run=false` alone from submitting every approved row.
4. Submit cap: `APPLY_MAX_SUBMITS` is `3`, or `25` for a drain. The worker's circuit breaker
   (`worker/src/claim-loop.ts`) also stops a run.
5. Inputs reach the script through `env`, never pasted into the script text, so no input can
   run as shell code.

**Redispatch job:** after a manual live drain, if the worker says rows are left
(`shouldRedispatchDrain` in `worker/src/claim-loop.ts`), a second job runs
`gh workflow run apply.yml -f dry_run=false -f drain_approved=true`. It never fires for a dry
run or a cron run.

**Timeout:** 60 min. **Concurrency:** `applyy-applier`.

**No artifacts.** Screenshots go to the Supabase Storage bucket `screenshots`. The cause of an
unknown submit is in `agent_runs.error_detail`.

**One real submit by hand** (repo `CLAUDE.md` §1):

```bash
gh workflow run apply.yml --ref main -f dry_run=false -f apply_only_id=<uuid>
```

CI runs on a datacenter IP, and Greenhouse reCAPTCHA refuses CI submits. A local headed run
(`assist.ts`) is preferred for reCAPTCHA forms.

## apply-kit.yml

**Name:** `applyy apply kit (automatic sweep, or one application)`. **Runs:**
`pnpm --filter '@applyy/worker' exec node src/cli/apply-kit.ts` (`worker/src/apply-kit.ts`,
sweep in `worker/src/apply-kit-sweep.ts`).

**What it does:** builds a Manual apply kit per row. It opens the live form, plans each field,
renders a fresh resume and appends one `application_events` note. It never claims, moves,
fills or submits a row. The robots gate still applies.

**Triggers:**
- `workflow_run` on `applyy applier (daily batch)`, `types: [completed]` (any conclusion). The
  name must match `apply.yml`'s `name:` exactly.
- `schedule`: `0 12 * * *` (17:30 IST), the daily backstop.
- `workflow_dispatch` with `application_id` (default blank = sweep). `dispatch-apply` starts a
  sweep on every approve, whatever its switch says, and on every saved answer
  (`{"kit_only": true}`, `supabase/functions/dispatch-apply/handler.ts`).

**Secrets:** the four app-user/Supabase secrets and `APPLYY_AGENT_KEY`.

**Caps:** `APPLY_KIT_SWEEP_CAP` = `25` kits per run. The worker stops starting new rows after
3000 s (`worker/src/run-window.ts`), so the 60-min timeout never lands mid-row. If due rows are
left, the `redispatch` job runs `gh workflow run apply-kit.yml`.

**Concurrency:** `applyy-apply-kit`. Rapid approves collapse into one running and one pending run.

## scout.yml

**Name:** `applyy scout (ats discovery)`. **Runs:** `pnpm --filter '@applyy/worker' run scout`
(`worker/src/cli/scout.ts`).

**What it does:** polls company boards in `company_watchlist` (Greenhouse, Lever, Ashby,
Workday; SmartRecruiters is off since the 2026-11-01 robots ruling). New postings are
deduplicated into `jobs` and screened on insert, so each `applications` row starts at
`passed_filters` or `dropped_filter` (`discovered` only if the screener cannot load).

**Triggers:**
- `schedule`: `17 0,12 * * *` (05:47 and 17:47 IST) and `17 4 * * *` (09:47 IST, added
  2026-11-05).
- `workflow_dispatch` with `force` (default `'false'`). `force=true` runs even when
  `system_settings.system_enabled` is false. Cron runs never force.

**Secrets:** the four app-user/Supabase secrets.

**Time budget:** the scout stops starting boards after 12 minutes (`SCOUT_BUDGET_MS` in
`worker/src/scout/run-outcome.ts`). Unstarted boards go first next run. The job timeout is
25 min, as a backstop. Change the two together.

**If you change the cron:** also check the Health threshold in
`apps/web/src/data/agentFreshness.ts` (guarded by `apps/web/test/scoutScheduleFreshness.test.ts`)
and the "three times a day" text in `apps/web/src/features/pipeline/DiscoveryModal.tsx`.

## scout-remote.yml

**Name:** `applyy scout (remote feeds)`. **Runs:**
`pnpm --filter '@applyy/worker' run scout:remote` (`worker/src/cli/scout-remote.ts`).

**What it does:** reads the remote job feeds through the same safety and screening path as the
ATS scout. This replaced the old browser button that inserted feed rows unscreened
(`apps/web/test/remoteDiscoveryRetired.test.ts`).

**Triggers:**
- `schedule`: `30 1 * * *` (07:00 IST).
- `workflow_dispatch` with `dry_run` (boolean, default false: fetch and screen in memory, write
  nothing) and `force` (default `'false'`).

**Secrets:** the four app-user/Supabase secrets. **Timeout:** 10 min.
**Concurrency:** `applyy-scout-remote`.

## satellites.yml

**Name:** `applyy satellites (daily)`. **Runs:** an inline Node script (no checkout, no install)
that calls five edge functions in turn: `skill-gap`, `follow-up`, `cover-letter`,
`interview-prep`, `referral`.

**What it does:** each function picks its own eligible rows, uses its own kill switch and batch
cap, and writes only side artifacts (reports, drafts, letters). None of them changes an
application's status.

**Triggers:**
- `schedule`: `23 13 * * *` (18:53 IST), after the applier and the 12:00 UTC kit backstop.
- `workflow_dispatch` (no inputs).

**Gate:** the job has
`if: github.event_name == 'workflow_dispatch' || vars.APPLYY_SATELLITES_LIVE == 'true'`.
A scheduled run is skipped (grey, not red) unless the variable is set. A manual run ignores it.
Note: this is a `${{ }}` expression, and GitHub's `==` ignores case, so `TRUE` also passes.
`apply.yml` avoids this with a shell test.

**Secrets:** the four app-user/Supabase secrets. **Timeout:** 20 min.
**Permissions:** `{}`. **Concurrency:** `applyy-satellites`.

## keepalive.yml

**Name:** `applyy keepalive`. **Runs:** `pnpm --filter '@applyy/worker' run keepalive`
(`worker/src/cli/keepalive.ts`), then a git push.

**Why it exists:** two failures that make no error.
1. Supabase pauses a free project after 1 week with no database activity.
2. GitHub disables scheduled workflows after 60 days with no repo activity. That would switch
   off `apply.yml` and this keepalive at the same time.

**Triggers:**
- `schedule`: `15 6 */3 * *` (every third day, 11:45 IST). Three days leaves two misses of
  margin inside Supabase's 7-day window.
- `workflow_dispatch` (no inputs).

**Steps:** the ping also writes a `keepalive` row to `agent_runs`, so the Health page shows the
last run. Then `github-actions[bot]` commits a timestamp to `.keepalive` on the dedicated
branch `automation-keepalive` and force-pushes that branch. It never targets `main`. Teja
approved this push on 2026-11-01.

**Secrets:** the four app-user/Supabase secrets. **Permissions:** `contents: write`.
**Timeout:** 5 min.

## jobs-tombstone.yml

**Name:** `applyy jobs tombstone`. **Runs:** `node scripts/jobs-tombstone.mjs`.

**What it does:** clears the heavy text (`description_raw`, `raw_payload`) of `dropped_filter`
jobs older than `MIN_AGE_DAYS`, in batches, through the `tombstone_dropped_jobs` RPC. The rows
stay, so their fingerprints still dedupe the next scan. The run is logged to `agent_runs` as
`jobs_tombstone`. Why: the Free Plan database quota is 500 MB and it hit 514 MB on 2026-11-05
(`docs/db/2026-11-05-jobs-tombstone-policy.md`).

**Triggers:**
- `schedule`: `45 6 * * 0` (Sundays, 12:15 IST).
- `workflow_dispatch` with `min_age_days` (default 7), `batch_size` (default 1000, range
  1-5000) and `max_batches` (default 50).

**Secrets:** the four app-user/Supabase secrets. **Timeout:** 10 min. No concurrency group.

## run-one.yml

**Name:** `applyy run one application`. **Runs:**
`node worker/src/cli/run-one.ts --id "$APPLICATION_ID"`.

**What it does:** pushes one application through matcher, then tailor, then auditor. It stops
at `awaiting_approval` at the latest. It never submits.

**Trigger:** `workflow_dispatch` only, with required `application_id`.

**Gate:** the first step refuses any `application_id` that is not a UUID. Install uses
`--ignore-scripts` and skips the browser download.

**Secrets:** the four app-user/Supabase secrets. **Timeout:** 15 min.
**Concurrency:** `run-one-<application_id>`.

## prescreen-drain.yml

**Name:** `applyy pre-screen drain`. **Runs:** an inline Node script that pages the whole
`discovered` queue through `normalizer` (`?limit=200`), then the `deduped` queue through
`screener` (`?limit=100`).

**Why:** scouts screen on insert, so only old rows inserted before that sit at
`discovered`/`deduped`, and nothing else calls these two functions at scale.

**Trigger:** `workflow_dispatch` only (Teja ruling 2026-10-09: a run that drops rows must run
while someone watches the log). Input `dry_count_only` (default false) prints the plan and
exits before sign-in.

**Fail-closed:** the screener drops rows, and drops are one-way. Any response the script
cannot read exactly stops the run.

**Secrets:** the four app-user/Supabase secrets. **Timeout:** 60 min.
**Concurrency:** `prescreen-drain`.

## pregate-sweep.yml

**Name:** `applyy pre-gate sweep`. **Runs:** an inline Node script that pages the
`passed_filters` backlog through `matcher` with `?mode=pregate_only` (no Gemini calls).

**Effects:** rows can be dropped (`pre_gate_dropped`) or moved to `failed` (an unusable job,
for example no description). Each page prints its `failed=` count.

**Trigger:** `workflow_dispatch` only (ruling 2026-10-09). Input `dry_count_only`
(default false).

**Fail-closed:** same rule as the pre-screen drain.

**Secrets:** the four app-user/Supabase secrets. **Timeout:** 30 min.
**Concurrency:** `pregate-sweep`.

## postscreen-drain.yml

**Name:** `applyy post-screen drain`. **Runs:** an inline Node script that pages
`passed_filters` through `matcher` (`?limit=10`), then `scored` through `tailor` (`?limit=3`),
then `tailored` through `auditor` (`?limit=5`), pausing between pages for Gemini's rate limit.

**Why:** nothing calls these three agents on a schedule. Their other callers handle one row
(`run-one.yml`, `job-link-intake`) or 10 rows per click (the web runner).

**Trigger:** `workflow_dispatch` only. Inputs:
- `dry_count_only` (default false): print the plan, no sign-in.
- `from_stage` (choice `matcher` / `tailor` / `auditor`, default `matcher`): later stages
  always follow.

**Automatic, by ruling (2026-11-09 ~17:20 IST).** This reverses the 2026-11-05 manual-only ruling, made
after 55 rows stalled 11-02 to 11-09 (`docs/status/2026-11-09-pipeline-stall.md`). The drain runs:
- on `workflow_run` when either scout (`applyy scout (ats discovery)`, `applyy scout (remote feeds)`) completes;
- on one daily `schedule` (04:30 UTC);
- on manual dispatch.

The `postscreen-drain` concurrency group queues overlapping runs instead of racing them.

A page-cap or stall stop now ends only that stage. Later stages still drain, and the run ends red with
`INCOMPLETE`. `apps/web/test/postscreenDrainTriggers.test.ts` pins three things: the exact trigger set,
the scout names, and the concurrency guard.

**Fail-closed:** the matcher drops rows below the score threshold, and drops are one-way.

**Secrets:** the four app-user/Supabase secrets. **Timeout:** 180 min.
**Concurrency:** `postscreen-drain`.

## ingest-links.yml

**Name:** `applyy ingest job links`. **Runs:** an inline Node script (built-ins only, no install)
that sends each link in a checked-in list to the `job-link-intake` edge function, one at a time.
This does from CI what the dashboard's "Add a job by link" panel does by hand.

**Trigger:** `workflow_dispatch` only. Inputs:
- `list` (default `worker/ingest/2026-11-01-career-page-internships.links.json`): an array of
  `{url, company, role}`.
- `dry_run` (boolean, default **true**): print the plan only, no sign-in, no intake call.

**Pacing:** each accepted link starts matcher, tailor and auditor in the background, which
spends Gemini calls. The script waits 45 s between links and retries a 429 once after 90 s.
A list must have 1 to 40 entries (`MAX_LINKS`), or the run aborts; 40 paced links fit the 55-min timeout.

**Secrets:** the four app-user/Supabase secrets. **Concurrency:** `ingest-links`.

## Tests that guard the workflow files

These tests read the YAML, so a change that breaks a rule fails CI by name. Regenerate the list:

```bash
git grep -l "\.github/workflows" -- '*.test.ts'
```

| Test | Guards |
|---|---|
| `worker/test/ci-workflow.test.ts` | `ci.yml` shape, including `paths-ignore` behaviour |
| `worker/test/apply-workflow-dry-run.test.ts` | `apply.yml` dry-by-default mode logic |
| `worker/test/apply-kit-sweep.test.ts` | `apply-kit.yml` sweep wiring |
| `worker/test/run-window.test.ts` | The worker run window fits inside `apply.yml` timeout-minutes |
| `worker/test/postscreen-drain-workflow.test.ts` | `postscreen-drain.yml` script behaviour |
| `worker/test/pregate-sweep-log.test.ts` | `pregate-sweep.yml` log output |
| `apps/web/test/postscreenDrainTriggers.test.ts` | `postscreen-drain.yml` triggers exactly on scout completion, one daily cron and manual dispatch, with the concurrency guard |
| `apps/web/test/scoutScheduleFreshness.test.ts` | Health threshold matches `scout.yml` cron |
| `apps/web/test/remoteDiscoveryRetired.test.ts` | Remote feeds run only via `scout-remote.yml` |
| `supabase/functions/job-link-intake/handler.test.ts` | `job-link-intake` contract used by `ingest-links.yml` |
