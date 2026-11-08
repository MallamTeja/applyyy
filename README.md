# applyy

_Last verified against code: 2026-11-08 (2a9ac31)._

A job-application pipeline with a human at the gate. It finds jobs on public ATS boards and screens them. It scores each job against a structured master resume, tailors a resume per job, and audits the tailoring for invented content. Then it waits for you to approve. After you approve, the worker submits the application.

Full walk-through: [docs/architecture/pipeline-end-to-end.md](docs/architecture/pipeline-end-to-end.md).

## The pipeline in one table

| Step | Status written | Who | Code |
|---|---|---|---|
| Discover and screen on insert | `passed_filters` / `dropped_filter` (fallback path: `discovered`) | scouts | `supabase/functions/scout-ats/`, `supabase/functions/scout-web/`, run by `worker/src/cli/scout.ts` and `scout-remote.ts` |
| Dedupe | `deduped` | normalizer | `supabase/functions/normalizer/` |
| Screen (no LLM) | `passed_filters` / `dropped_filter` | screener | `supabase/functions/screener/` |
| Score | `scored` | matcher | `supabase/functions/matcher/` |
| Tailor | `tailored` | tailor | `supabase/functions/tailor/` |
| Audit | `audit_clean` / `audit_flagged`, then `awaiting_approval` | auditor | `supabase/functions/auditor/` |
| Approve | `approved` | you, in the web app | `apps/web/src/features/approval/` |
| Submit | `applying`, then `applied`, `failed` or `blocked_needs_human` (a human finishes blocked rows) | applier | `worker/src/cli/apply.ts` (batch), `worker/src/cli/assist.ts` (headed, you click Submit) |
| Track replies | later statuses | tracker | `supabase/functions/email-tracker-intake/` (fed by the Gmail Apps Script); `supabase/functions/gmail-sync/` is the web app's "sync now" proxy |

Read the real edges from the database, never from this table:

    select * from application_status_transitions where from_status = '<status>';

How the steps are started:

- **Scouts** run on a cron (`.github/workflows/scout.yml`, `scout-remote.yml`).
- **Matcher, tailor and auditor have no cron.** The web app's Run pipeline button, `run-one.yml`, and the dispatch drains (`prescreen-drain.yml`, `postscreen-drain.yml`, `pregate-sweep.yml`) drive them.
- **A pasted job link** goes to `supabase/functions/job-link-intake/`, which runs matcher, tailor and auditor in the background.
- **On approve**, `supabase/functions/dispatch-apply/` always starts an apply-kit run (`apply-kit.yml`). It starts a live submit drain of `apply.yml` (`drain_approved`) only when `system_settings.auto_apply_on_approve` is true.
- **Satellite agents** (`skill-gap`, `follow-up`, `cover-letter`, `interview-prep`, `referral`) run daily from `satellites.yml`, only while the repo variable `APPLYY_SATELLITES_LIVE` is `true` or on a manual dispatch.

## Safety properties

- **A human approves every application.** The auditor's verdict is required to reach `awaiting_approval`. Only a human moves a row to `approved`.
- **Submission is bounded.** `apply.yml` has a per-run cap (`APPLY_MAX_SUBMITS`), a circuit breaker and a robots.txt gate, and `DRY_RUN` defaults to true. A scheduled run submits only while the repo variable `APPLYY_CRON_LIVE` is `true`. Details: [worker/README.md](worker/README.md).
- **The status graph is enforced in Postgres.** A trigger checks every UPDATE against `application_status_transitions`. INSERT is limited to `discovered`, `passed_filters` and `dropped_filter`. `UNIQUE(user_id, job_id)` stops a double apply. Details: [docs/db/schema-and-status-graph.md](docs/db/schema-and-status-graph.md).
- **No service role.** Every agent signs in as the one app user (`createAppUserClient`), so RLS confines it. Machine RPCs also check the `x-applyy-agent-key` header. An empty key table locks every agent out (fail-closed since migration `20261102210000`).
- **Approved means frozen.** `tailored_profile` can change only at `scored`, `audit_flagged` or `awaiting_approval`. A stale edit is refused with `PT409`.
- **The tailor cannot invent.** It returns references into the versioned master profile. The validator rejects anything that is not one.
- **Kill switch.** `system_settings.system_enabled = false` stops the pipeline agents.

## Quick start

Requirements: Node 24 and **pnpm only** (`preinstall` runs `only-allow pnpm`; `npm install` fails here). Deno for the edge functions.

    pnpm install
    # web app: copy apps/web/.env.example to apps/web/.env.local, set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
    cd apps/web && pnpm dev

The web app is deployed to Vercel on every push to `main`. Edge functions and migrations are deployed by the orchestrator only, from a clean worktree pinned to a SHA. See `CLAUDE.md` section 3 and [docs/functions/README.md](docs/functions/README.md).

## Verify

    # edge functions: --reload defeats the cache; the Check count must equal the number of files
    cd supabase/functions && deno check --reload <paths> 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -c "^Check"
    # edge-function tests, from the repo root; "tests" must be non-zero and "cancelled" zero
    node --test "supabase/functions/**/*.test.ts"
    # web app
    cd apps/web && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build
    # worker
    cd worker && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run

`pnpm run typecheck` does not cover `supabase/functions` and can rewrite `pnpm-lock.yaml`. Read [docs/verification-traps.md](docs/verification-traps.md) before you trust a green result. CI is described in [docs/ops/ci-and-workflows.md](docs/ops/ci-and-workflows.md).

## Repo layout

| Path | What |
|---|---|
| `apps/web/` | React + Vite web app (`@applyy/web`), deployed to Vercel. See [apps/web/README.md](apps/web/README.md) and [docs/features/web-app.md](docs/features/web-app.md) |
| `supabase/functions/` | Deno edge functions, one directory per agent or service, plus `_shared/`. See [docs/functions/README.md](docs/functions/README.md) |
| `supabase/migrations/` | Postgres schema, RLS, the status-transition guard |
| `worker/` | Node + Playwright CLIs in `worker/src/cli/`: scout, scout-remote, apply, assist, apply-kit, rehearse-assist, resume-pages, keepalive, run-one. See [worker/README.md](worker/README.md) |
| `api/` | Vercel Node function `render-job-page.ts` (headless page read for `job-link-intake`) |
| `packages/` | Shared TypeScript: `shared-types`, `resume-template`, `master-ingest`, `master-pdf`, `master-robots` |
| `scripts/` | `deploy-drift.mjs` (deployed vs `main`), `repo-stats.mjs` (code counts), `jobs-tombstone.mjs` (weekly tombstone run), `push-apps-script.sh` (pushes the Gmail tracker script) |
| `.github/workflows/` | CI and every scheduled or dispatched job. List them with `ls .github/workflows` |
| `docs/` | Living reference docs and dated records. Index: [docs/README.md](docs/README.md) |
| `reference/` | Gitignored upstream code for ideas; never copied |

Stack: Supabase Postgres + Deno edge functions, React + Vite on Vercel, Playwright on GitHub Actions, Gemini as the LLM.

## Where to read next

| Doc | For |
|---|---|
| [docs/README.md](docs/README.md) | Index of every doc, living or record |
| [docs/product/README.md](docs/product/README.md) | Product docs: what applyyy is, why, each feature, rulings, roadmap |
| [docs/technical/README.md](docs/technical/README.md) | Technical guides: AI/LLM, security model, local dev, deploy |
| [docs/architecture/pipeline-end-to-end.md](docs/architecture/pipeline-end-to-end.md) | One job through every status |
| [docs/SYSTEM_ARCHITECTURE.md](docs/SYSTEM_ARCHITECTURE.md) | Architecture overview |
| [docs/db/schema-and-status-graph.md](docs/db/schema-and-status-graph.md) | Tables, RLS, status graph, guards |
| [docs/functions/README.md](docs/functions/README.md) | Each edge function |
| [docs/features/web-app.md](docs/features/web-app.md) | Each web app screen |
| [docs/ops/ci-and-workflows.md](docs/ops/ci-and-workflows.md) | Each GitHub Actions workflow |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Progress toward the goal |
| [PROJECT_PLAN.md](PROJECT_PLAN.md) | Intent, locked decisions, constraints |
| `CLAUDE.md` | Rules for agents working in this repo |
