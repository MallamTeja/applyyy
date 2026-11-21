# `applyy` — live progress

_Last verified against code: 2026-11-21 (3a86eada)._

This file holds how to derive the progress figure, the live facts (each with the command that
regenerates it) and the re-verified open items. The day-to-day work list lives in the
newest pair under [`handoff/`](handoff/) (`ls docs/handoff | tail -2`). The September
2026 log is archived verbatim in
[`status/2026-09-progress-log-archive.md`](status/2026-09-progress-log-archive.md).
Nothing in the archive is live.

Evidence rule: a claim stays here only with a measurement behind it or the command that
regenerates it. **Counts date-stamp themselves. Re-measure, never quote.**

---

## Progress: re-derive it, never store it

Repo `CLAUDE.md` §1 ("Progress reporting") is the rule: when Teja asks for a percentage,
re-derive it at ask time from the repo and live state, and state the basis ("X of Y
milestones; the gap is …"). This file stores no figure, because a stored % goes stale the day
it is written.

The milestones toward the product goal (one human-approved pipeline running end-to-end for
real): discovered → screened → tailored (and audited) → approved by the human → **submitted
by the bot** → confirmed applied (receipt) → tracked. A milestone counts only when it has run
on live rows. The milestone that has stayed open longest is the bot submit. Check who moved
rows to `applied`:

```sql
select from_status, agent, count(*), max(created_at)::date
from public.application_events where to_status = 'applied' group by 1, 2;
```

Rows with `agent = 'human'` came from the Manual apply lane, not the worker. The first bot
submit's steps (approve, wait for the kit, `worker/src/cli/rehearse-assist.ts --id <uuid>`,
then a single `apply.yml` dispatch) are in the newest `handoff/*-pending-tasks.md`.

---

## Current state

Architecture, agents and data flow: [`SYSTEM_ARCHITECTURE.md`](SYSTEM_ARCHITECTURE.md).

**Pipeline:** scout → normalizer (`deduped`) → screener → matcher (`scored`) → tailor →
auditor → `awaiting_approval` → human approves → the worker submits (`worker/src/cli/apply.ts`
via `.github/workflows/apply.yml`). Read the status graph from the database, never from a doc:
`select * from application_status_transitions where from_status = '<s>';`.

**Submission controls:**
- `SUBMISSION_IMPLEMENTED = true` since 2026-10-09 (constant `SUBMISSION_IMPLEMENTED` in `worker/src/playwright-page.ts`, commit `c557533`).
- The per-run cap is `APPLY_MAX_SUBMITS` (default 3, `worker/src/claim-loop.ts`), behind a
  circuit breaker (`0c437e4`).
- A robots.txt gate runs before the apply page opens (`a3b4115`; `checkRobots` in
  `worker/src/apply-one.ts`).
- Workday is not bot-supported. The worker refuses it (`isWorkdayJob` in `worker/src/workday.ts`,
  called from `worker/src/apply-one.ts`).
- Zero extracted fields stops a submit (the "empty-page gate", `worker/src/apply-one.ts`).
- `DRY_RUN` defaults true. A *scheduled* `apply.yml` run submits only while the repo variable
  `APPLYY_CRON_LIVE` is `true`. One real submit:
  `gh workflow run apply.yml --ref main -f dry_run=false -f apply_only_id=<uuid>`.
- `worker/src/cli/assist.ts` is the headed single-row route where the human clicks Submit.

**Score floor:** `MATCH_ADVANCE_FLOOR = 30`
(`supabase/functions/_shared/match/score-threshold.ts`). Teja lowered it from 45 on
2026-11-07 (`95df3f3`). Rows below it stop at `scored`.

**Where rows are born:** the scouts screen at insert, so most rows start at `passed_filters` or
`dropped_filter`. `discovered` is the fallback when screening is unavailable. A pasted link
re-enters at `passed_filters` through a `human`-only edge (migration `20261031200000`).

| Fact | Regenerate with |
|---|---|
| Migrations applied vs local | `supabase migration list --linked`, or `select version from supabase_migrations.schema_migrations order by version;` vs `ls supabase/migrations` |
| Application status distribution | `select status, count(*) from public.applications group by status order by 2 desc;` |
| Who moved rows to `applied` (bot vs human) | the `application_events` query in the Progress section |
| Watchlist coverage per provider | `select ats_provider, count(*) from company_watchlist group by 1;` |
| Agent-key enforcement (expect 1) | `select count(*) from applyy_internal.agent_key;` |
| Which agents have run, and when | `select agent, count(*), max(started_at) from public.agent_runs group by 1 order by 1;` |
| Edge functions present | `ls -d supabase/functions/*/ \| grep -v _shared` |
| Which edge functions have a caller | `grep -rn "functions\.invoke(" apps/web/src worker/src` plus `.github/workflows/*.yml` |
| Scheduled workflows and their crons | `grep -A3 "schedule:" .github/workflows/*.yml` |
| Deployed function versions | `supabase functions list` (order by `updated_at`, never by version number) |

**Agent-key guards:** `advance_application_status`, `claim_applications`,
`release_application_claim` and `sweep_stale_claims` check the machine agent's
`x-applyy-agent-key` header. The key is seeded, so a request without the right key is refused
(42501). **Since migration `20261102210000_agent_key_fail_closed.sql` an EMPTY key table locks
every machine agent out.** Running agents without the key needs two deliberate statements; the
exact SQL is in that migration's header. Never "fix" a lockout by deleting the key.

**What runs on a schedule** (re-check with the grep above; this table drifts):

| Workflow | Cron (UTC) | What it does |
|---|---|---|
| `scout.yml` | `17 0,2,5,7,10,12,14,17,19,22 * * *` | ATS scout, screens at insert (ten a day since `06ab7913`, oldest-polled boards first); passes wait at `passed_filters` |
| `scout-ats-daily.yml` | `41 1 * * *` | Liveness only: retires queued rows whose posting closed |
| `postscreen-drain.yml` | `30 4 * * *` | Approval-queue re-gate only (`auditor?mode=regate_queue`); the full drain is manual |
| `scout-remote.yml` | `30 1 * * *` | Remote-feed scout |
| `apply.yml` | `30 2 * * *` | Worker submit run; DRY unless `APPLYY_CRON_LIVE` is `true` |
| `apply-kit.yml` | `0 12 * * *` | Builds apply kits; also dispatched on every approve |
| `satellites.yml` | `23 13 * * *` | Skill-gap, follow-up, cover-letter, interview-prep, referral; the cron runs only while `APPLYY_SATELLITES_LIVE` is `true` |
| `jobs-tombstone.yml` | `45 6 * * 0` | Weekly purge of old `dropped_filter` job payloads (DB quota) |
| `keepalive.yml` | `15 6 */3 * *` | Keeps the project awake |

GitHub cron is best-effort; real start times are in `gh run list`. There is no `pg_cron`
(ruled out, migration `20261009220000`).

**Manual routes:** `run-one.yml` (matcher → tailor → auditor for one row,
`worker/src/cli/run-one.ts`), `pregate-sweep.yml`, `prescreen-drain.yml`,
`workday-egress-probe.yml`, the full `postscreen-drain.yml` drain (manual dispatch only since the
2026-11-18 ruling; its cron runs the re-gate alone), and the web app's batch runner (`ingest-links.yml` was deleted 2026-11-18). Normalizer, tailor
and auditor have no schedule of their own.

**Screening rules:**
- `experience_ceiling` is live since 2026-11-04. `supabase/functions/_shared/screen/required-experience.ts`
  reads the JD's hard minimum years. The threshold lives in `filter_rules.config.max_years`
  (migration `20261104193000`).
- `degree_mismatch` still never fires: nothing writes `jobs.requires_advanced_degree`, so the
  rule skips with a warning (`supabase/functions/_shared/filter/cascade.ts`). The skip is
  recorded in `agent_runs.error_detail` (`_shared/screen/run-summary.ts`).

**Status events:** every transition writes a `status_change` row from the `log_status_change`
trigger, so an agent cannot forget to log it. A second `note` row (the caller's `p_detail`:
scores, `resume_sha256`, block history) is written only when `p_detail` is non-empty. The split
is deliberate ("separable when reading back"), not a duplication bug.

**Gates:** `.github/workflows/ci.yml` runs one `ci` job on each push to `main` and on PRs. It
runs: deno check (with a file-count assertion), edge-function tests, `packages/shared-types`
tests, per-package `node --test` over `packages/*/test`, web tsc + vite build + tests, the
render function's tsc + tests, worker tsc + vitest, and a gitleaks scan. A docs-only push runs
no CI (`paths-ignore`). Traps: [`verification-traps.md`](verification-traps.md).

---

## Open items (live checks last re-measured 2026-11-08; code checks 2026-11-21)

**Still open:**

1. **`application_status_transitions` has `relforcerowsecurity = false`** while the other
   tables force RLS. Re-measured live 2026-11-08:
   `select relforcerowsecurity from pg_class where relname='application_status_transitions';`.
   Defensible (read-only reference seed) but still undecided. Decide and record, or add
   force RLS.
2. **Actions secrets for the `APPLYY_APP_USER_*` rename** cannot be verified from the repo.
   The workflows use the new names (`.github/workflows/apply.yml`, `apply-kit.yml`). Only
   `gh secret list` confirms the GitHub side.
3. **`degree_mismatch` has no producer** (see Screening rules).
4. **Bot submit is unproven** until the `applied` query above shows a non-human agent. Steps are in the newest pending-tasks file.

Resolved items are not kept here; `git log -p docs/PROGRESS.md` holds them.

---

*History: the full dated log (2026-09-09 → 2026-09-10, corrections through 2026-10-23) is in
[`status/2026-09-progress-log-archive.md`](status/2026-09-progress-log-archive.md).*
