# `stack/` — tech-stack inventories

What the system is built from: languages, lines of code, files, frameworks, dependencies,
services, agents, modules, integrations, APIs, CI/CD, database and vulnerabilities.

**This index holds no counts.** The numbers live in **dated snapshots**. Each snapshot names
the commit it measured and is never edited. To get today's numbers, run the commands below
and write a new dated snapshot. Do not patch an old one.

## Snapshots

| Date | Start here | Measured at |
|---|---|---|
| 2026-11-05 | [2026-11-05-overview.md](2026-11-05-overview.md) | `00ecabb` + live Supabase/GitHub that night |

## Regenerate

| Fact | Command |
|---|---|
| Files, LOC, language %, lines per file, largest files, src/test split, dependency counts | `node scripts/repo-stats.mjs [rev]`. It reads git blobs, so the same rev always gives the same output, whatever peers have uncommitted |
| Dependency versions | read each `package.json`, `supabase/functions/deno.json`, `pnpm-workspace.yaml` (`overrides`) |
| Vulnerabilities | `pnpm audit --json` and `--prod`; `gh api "repos/MallamTeja/applyyy/dependabot/alerts?state=open&per_page=100"`; Supabase MCP `get_advisors` (security + performance) |
| Edge functions (local / live) | `ls supabase/functions/*/index.ts`; MCP `list_edge_functions`; JWT posture: `awk '/^\[functions\./{f=$0} /^verify_jwt/{print f, $0}' supabase/config.toml` |
| Worker entry points | `ls worker/src/cli` |
| Workflows and schedules | `ls .github/workflows`; `grep -n "cron:" .github/workflows/*.yml`; `gh run list --limit 40` |
| Secrets and variables (names) | `gh secret list`; `gh variable list` |
| Tables, RLS, policies | `select schemaname, tablename, rowsecurity from pg_tables where schemaname in ('public','applyy_internal')`; `select * from pg_policies` |
| Migrations local vs applied | MCP `list_migrations` vs `ls supabase/migrations` |
| Status graph | `select from_status, to_status, allowed_agents from application_status_transitions order by 1,2` |
| Pipeline state | `select status, count(*) from applications group by 1` |
| Web features and routes | `git ls-files apps/web/src/features \| awk -F/ '{print $5}' \| sort \| uniq -c`; `apps/web/src/app/routes.ts` |
| External hosts called | `git grep -hoE "https://[a-z0-9.-]+" -- supabase/functions worker/src apps/web/src api packages \| sort \| uniq -c` |

## Method notes

- Count **tracked** files at a pinned commit. Never count the working copy. Several sessions
  edit this tree at once, and two working-copy runs minutes apart disagreed on 2026-11-05.
- `repo-stats.mjs` treats a line as a comment only when the line *starts* with one, so its
  comment ÷ code ratio is a floor. Read it against the comment rule (`CLAUDE.md` §8) with that
  in mind.
- Live-DB facts come from SELECTs only. Re-check any number a recon agent reports before you
  copy it into a snapshot. On 2026-11-05 a recon report said `supabase/snippets` held 11
  files; the pinned count is 10.
