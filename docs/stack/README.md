# `stack/` — tech-stack reference

_Last verified against code: 2026-11-08 (2a9ac31)._

What the system is built from: languages, lines of code, files, frameworks, dependencies,
services, agents, modules, integrations, APIs, CI/CD and the database.

## How to read these files

The files carry a `2026-11-05-` prefix because they started as a dated snapshot. Since
2026-11-08 they are **living reference docs**: they are corrected in place when the code
changes. The filenames stay the same so that links from other docs keep working.

Each file has a "Last verified" line under its title. Any number in these files is written
"as of <date>" with the command that regenerates it. If a number matters to you, run the
command. Do not trust the number.

For how the parts connect at runtime, read [../SYSTEM_ARCHITECTURE.md](../SYSTEM_ARCHITECTURE.md).
For open security findings, read
[../security/2026-11-05-vulnerability-remeasure.md](../security/2026-11-05-vulnerability-remeasure.md).

## Files

| File | Covers |
|---|---|
| [2026-11-05-overview.md](2026-11-05-overview.md) | one-page summary; start here |
| [2026-11-05-languages-loc-files.md](2026-11-05-languages-loc-files.md) | language share, lines of code, files, largest files |
| [2026-11-05-frameworks-dependencies.md](2026-11-05-frameworks-dependencies.md) | runtimes, frameworks, every dependency and its version |
| [2026-11-05-services-agents-modules.md](2026-11-05-services-agents-modules.md) | runtime units, agents, modules, tests |
| [2026-11-05-integrations-apis-ci.md](2026-11-05-integrations-apis-ci.md) | external services, APIs in and out, workflows, hosting config |
| [2026-11-05-database.md](2026-11-05-database.md) | tables, RLS, functions, triggers, enums, live state |

## Regenerate

| Fact | Command |
|---|---|
| Files, LOC, language %, lines per file, largest files, src/test split, dependency counts | `node scripts/repo-stats.mjs [rev]`. It reads git blobs, so the same rev always gives the same output, whatever peers have uncommitted |
| Dependency versions | read each `package.json`, `supabase/functions/deno.json` (`imports`), `pnpm-workspace.yaml` (`overrides`) |
| Vulnerabilities | `pnpm audit --json` and `--prod`; `gh api "repos/MallamTeja/applyyy/dependabot/alerts?state=open&per_page=100"`; Supabase MCP `get_advisors` (security + performance) |
| Edge functions (local / live) | `ls supabase/functions/*/index.ts`; MCP `list_edge_functions`; JWT posture: `awk '/^\[functions\./{f=$0} /^verify_jwt/{print f, $0}' supabase/config.toml` |
| Worker entry points | `ls worker/src/cli` |
| Workflows and schedules | `ls .github/workflows`; `grep -n "cron:" .github/workflows/*.yml`; `gh run list --limit 40` |
| Secrets and variables (names) | `gh secret list`; `gh variable list`; names used by workflows: `git grep -ohE "(secrets\|vars)\.[A-Z_]+" -- .github/workflows \| sort -u` |
| Tables, RLS, policies | `select schemaname, tablename, rowsecurity from pg_tables where schemaname in ('public','applyy_internal')`; `select * from pg_policies` |
| Migrations local vs applied | MCP `list_migrations` (or `select count(*) from supabase_migrations.schema_migrations`) vs `ls supabase/migrations` |
| Status graph | `select from_status, to_status, allowed_agents from application_status_transitions order by 1,2` |
| Pipeline state | `select status, count(*) from applications group by 1` |
| Web features and routes | `git ls-files apps/web/src/features \| awk -F/ '{print $5}' \| sort \| uniq -c`; `apps/web/src/app/routes.ts` |
| External hosts called | `git grep -hoE "https://[a-z0-9.-]+" -- supabase/functions worker/src apps/web/src api packages \| sort \| uniq -c` |

Run live-DB SELECTs with `env -u SUPABASE_ACCESS_TOKEN supabase db query --linked "<select>"`
in Bash (see `CLAUDE.md` §4 for why the variable must be unset).

## Method notes

- Count **tracked** files at a pinned commit. Never count the working copy. Several sessions
  edit this tree at once, and two working-copy runs minutes apart disagreed on 2026-11-05.
- `repo-stats.mjs` treats a line as a comment only when the line *starts* with one, so its
  comment ÷ code ratio is a floor. Read it against the comment rule (`CLAUDE.md` §8) with that
  in mind.
- Live-DB facts come from SELECTs only. Re-check any number a recon agent reports before you
  copy it into a doc. On 2026-11-05 a recon report said `supabase/snippets` held 11 files;
  the pinned count was 10.
- Describe only committed code. A peer's uncommitted edit is not shipped behaviour.
