# applyy

A job-application pipeline with a human at the gate. It finds jobs on public ATS boards, scores them against a structured master resume, tailors a resume per job, audits the tailoring for fabrication, and waits for you to approve — then the worker submits the application for you.

## Pipeline

Scouts (`supabase/functions/scout-ats`, `scout-web`; scheduled via `worker/src/cli/scout.ts`) write jobs and screen them at insert. The **normalizer** writes `deduped`, the **screener** (deterministic, no LLM) `passed_filters` / `dropped_filter`, the **matcher** `scored`, the **tailor** `tailored`, and the **auditor** `audit_clean` / `audit_flagged` → `awaiting_approval`. You approve, and can edit the resume, in the dashboard's approval queue. After approval **the worker submits automatically** (`worker/src/cli/apply.ts` via `apply.yml`): capped per run (`APPLY_MAX_SUBMITS`, default 3) behind a circuit breaker, robots.txt-gated, `DRY_RUN` defaulting true — a scheduled run submits only while the repo variable `APPLYY_CRON_LIVE` is `true`. `worker/src/cli/assist.ts` is the headed single-row alternative where you click Submit yourself. Replies come back through `email-tracker-intake`. Extra agents (`cover-letter`, `follow-up`, `interview-prep`, `referral`, `skill-gap`) run daily via `satellites.yml`. A pasted job link (`job-link-intake`) runs matcher → tailor → auditor in the background. The middle agents have no cron: the dashboard's Run pipeline button, `run-one.yml` and the dispatch drains (`prescreen-drain`, `postscreen-drain`, `pregate-sweep`) drive them.

## Layout

| Path | What |
|---|---|
| `apps/web/` | React + Vite dashboard, deployed to Vercel |
| `supabase/functions/` | Deno edge functions, one per agent, plus `_shared/` |
| `supabase/migrations/` | Postgres schema, RLS, status-transition guard |
| `worker/` | Node + Playwright: scout, scout-remote, batch apply, assisted apply, apply kits, keepalive, run-one |
| `api/` | Vercel Node function `render-job-page.ts` (headless page read for `job-link-intake`) |
| `packages/` | Shared TS: `shared-types`, `resume-template`, `master-*` |
| `scripts/` | `deploy-drift.mjs` (deployed vs `main`), `repo-stats.mjs` (LOC / language / dependency counts) |
| `.github/workflows/` | `ls .github/workflows`: `ci`; scheduled `scout`, `scout-remote`, `apply`, `apply-kit`, `satellites`, `keepalive`; dispatch-only `run-one`, `ingest-links`, `prescreen-drain`, `postscreen-drain`, `pregate-sweep` |
| `docs/` | Architecture, status, and dated records |
| `reference/` | Gitignored upstream reference; never vendored |

Stack: Supabase Postgres + Deno edge functions, React + Vite on Vercel, Playwright on GitHub Actions, Gemini. **pnpm only.**

## Verify

    # edge functions: --reload defeats the cache; assert the Check count equals the files passed
    cd supabase/functions && deno check --reload <paths> 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -c "^Check"
    # edge-function tests, from the repo root; "tests" must be non-zero
    node --test "supabase/functions/**/*.test.ts"
    # dashboard
    cd apps/web && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build
    # worker
    cd worker && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run

`pnpm run typecheck` does not cover `supabase/functions` and can rewrite `pnpm-lock.yaml`. See `CLAUDE.md` §4 for the traps.

## Safety properties

- **The human approves; nothing is submitted without that.** The auditor's verdict is required to reach `awaiting_approval`; a human approves each application. Post-approval submission is automatic (since 2026-10-09) and bounded: per-run cap, circuit breaker, robots.txt gate, and `DRY_RUN` defaults true everywhere.
- **The status graph is enforced in Postgres.** A trigger checks every UPDATE against `application_status_transitions`; INSERT is limited to an allowlist of pre-gate statuses; `UNIQUE(user_id, job_id)` prevents applying twice.
- **No service role.** Every agent signs in as the one app user (`createAppUserClient`), so RLS confines it; machine RPCs also check an `x-applyy-agent-key` hash, and an empty key table locks every agent out (fail-closed since 2026-11-04).
- **Approved means frozen.** `tailored_profile` can change only at `scored`, `audit_flagged` or `awaiting_approval`; a stale edit is refused with `PT409`.
- **The tailor can't invent.** It returns references into the versioned master profile; the validator rejects anything that is not one.
- **Kill switch.** `system_settings.system_enabled = false` stops the pipeline agents.

## Start here

[`docs/README.md`](docs/README.md) (index) and [`docs/SYSTEM_ARCHITECTURE.md`](docs/SYSTEM_ARCHITECTURE.md). Tech-stack inventory (languages, LOC, dependencies, integrations, vulnerabilities): [`docs/stack/`](docs/stack/README.md). Intent and constraints: [`PROJECT_PLAN.md`](PROJECT_PLAN.md).
