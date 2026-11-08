# Technical docs — applyyy

_Written 2026-11-08 against 2a9ac31._

This folder explains how applyyy is built, tested, deployed and secured.
For what the product does and why, start at [../product/README.md](../product/README.md).
Code wins over docs. If a doc and the code disagree, trust the code and fix the doc.

## Docs in this folder

| Doc | What it covers |
|-----|----------------|
| [ai-and-llm.md](ai-and-llm.md) | Every Gemini caller, how the model is picked, the key pool, retries, pacing, answer checks and cost. |
| [security-model.md](security-model.md) | Auth, RLS, the fail-closed agent key, status guards, SSRF and robots guards, CORS and CSP, secrets by name, gitleaks. |
| [local-dev-and-testing.md](local-dev-and-testing.md) | Setup on Windows, the checker for each package, e2e suites, CI-to-local command map, and checks that pass while doing nothing. |
| [deploy-and-release.md](deploy-and-release.md) | Vercel auto-deploy, edge function deploys from a pinned clean worktree, `db push --dry-run`, deploy order. |

## Other technical references

| Doc | What it covers |
|-----|----------------|
| [../SYSTEM_ARCHITECTURE.md](../SYSTEM_ARCHITECTURE.md) | The whole system on one page: components and how they connect. |
| [../architecture/pipeline-end-to-end.md](../architecture/pipeline-end-to-end.md) | One job's path through every stage, with the agent that moves it. |
| [../db/schema-and-status-graph.md](../db/schema-and-status-graph.md) | Tables, the status graph, the transition guards and RLS. |
| [../functions/README.md](../functions/README.md) (pending) | One line per Supabase edge function in `supabase/functions/`. |
| [../features/web-app.md](../features/web-app.md) | The React dashboard in `apps/web/`: routes, pages and data access. |
| [../ops/ci-and-workflows.md](../ops/ci-and-workflows.md) | `ci.yml` and every GitHub Actions workflow: triggers, schedules, gates. |

## Facts to regenerate, not copy

These change often. Run the command instead of trusting a number in a doc.

| Fact | Command |
|------|---------|
| Status counts | `select status, count(*) from applications group by 1` |
| Allowed status moves | `select * from application_status_transitions where from_status = '<s>'` |
| Edge functions in the repo | `ls supabase/functions/*/index.ts` |
| Migrations applied live | Supabase MCP `list_migrations` vs `ls supabase/migrations` |
| CI result for a commit | `gh run list --commit <full-sha> --workflow=ci.yml` |
