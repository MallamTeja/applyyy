# `applyy` docs index

_Last verified against code: 2026-11-08 (2a9ac31)._

This page lists every doc under `docs/`. It says for each one whether it is **living** or a **record**.

- **Living** docs describe the system as it is now. They carry a "Last verified against code" line under the title. If one disagrees with the code, the code wins. Fix the doc.
- **Records** have a date in the name, or describe one moment (an audit, a brief, a status, a handoff). Their body is never rewritten. A `Status 2026-11-08` banner under the title says if the record still holds: **Current**, **Partly superseded**, **Superseded** or **Historical**. The banner names the doc that holds the current truth.
- No row here carries a count. Each living doc names the command that regenerates its numbers.

Regenerate the list of docs this page must cover:

    git ls-files docs | sort

## Start here

| Doc | Why read it first |
|---|---|
| [../README.md](../README.md) | What the project is, quick start, repo layout |
| [architecture/pipeline-end-to-end.md](architecture/pipeline-end-to-end.md) | One job through every status, with the agent, trigger and gates at each step |
| [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) | The current architecture: components, agents, status graph, security, deploys, known gaps |
| [PROGRESS.md](PROGRESS.md) | Live progress toward the product goal, with the commands that re-derive it |
| [handoff/2026-11-08-1745-orchestrator-handoff.md](handoff/2026-11-08-1745-orchestrator-handoff.md) | Newest orchestrator handoff. Open work is in [handoff/2026-11-08-1745-pending-tasks.md](handoff/2026-11-08-1745-pending-tasks.md) |

## Living reference docs

### Architecture and data

| Doc | What it covers |
|---|---|
| [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) | Components, agents, status graph, security model, deploy rules, known gaps |
| [architecture/pipeline-end-to-end.md](architecture/pipeline-end-to-end.md) | Each status in graph order: who moves it, source file, trigger, gates; mermaid flowchart |
| [architecture/agents.md](architecture/agents.md) | One section per agent: input and output status, code path, model, trigger, design reasons |
| [db/schema-and-status-graph.md](db/schema-and-status-graph.md) | Schemas, tables, RLS, the status graph with allowed actors, guards, the agent key, RPC privileges |
| [functions/README.md](functions/README.md) | One section per edge function in `supabase/functions/`: caller, statuses, secrets by name, deploy form |
| [features/web-app.md](features/web-app.md) | The web app screen by screen: route, tables, RPCs, edge functions, key files, tests |
| [ops/ci-and-workflows.md](ops/ci-and-workflows.md) | Every workflow in `.github/workflows/`: triggers, cron times, gates, caps, secret names; how to read CI green |
| [../packages/shared-types/SCHEMA_CONTRACT.md](../packages/shared-types/SCHEMA_CONTRACT.md) | Column-level DB contract and the Row-type parity test |

### Status and plan

| Doc | What it covers |
|---|---|
| [PROGRESS.md](PROGRESS.md) | Percent toward the goal, milestone table with evidence, open and resolved items |
| [../PROJECT_PLAN.md](../PROJECT_PLAN.md) | Locked decisions and constraints, with a "State at 2026-11-08" table. Verify claims against code before you obey them |

### Package and app READMEs

| Doc | What it covers |
|---|---|
| [../apps/web/README.md](../apps/web/README.md) | `@applyy/web`: scripts, env vars, layout, routes, theming and no-native-dialog rules |
| [../worker/README.md](../worker/README.md) | The Playwright worker: gate table, apply flow, CLI entry points, ATS coverage |
| [../packages/resume-template/README.md](../packages/resume-template/README.md) | Resume renderer, the one-page typography ladder, trim order |
| [../packages/master-ingest/README.md](../packages/master-ingest/README.md) | Master-resume ingest: exports and consumers |

### Tech stack

| Doc | What it covers |
|---|---|
| [stack/README.md](stack/README.md) | Index of the stack set and the commands that regenerate its numbers |
| [stack/2026-11-05-overview.md](stack/2026-11-05-overview.md) | Stack overview (living despite the date in its name) |
| [stack/2026-11-05-languages-loc-files.md](stack/2026-11-05-languages-loc-files.md) | Languages, lines of code, file counts (`node scripts/repo-stats.mjs`) |
| [stack/2026-11-05-frameworks-dependencies.md](stack/2026-11-05-frameworks-dependencies.md) | Frameworks, runtimes and dependencies |
| [stack/2026-11-05-services-agents-modules.md](stack/2026-11-05-services-agents-modules.md) | Services, agents and modules |
| [stack/2026-11-05-integrations-apis-ci.md](stack/2026-11-05-integrations-apis-ci.md) | Third-party integrations, APIs, CI/CD |
| [stack/2026-11-05-database.md](stack/2026-11-05-database.md) | Database layer |

### Verification and conventions

| Doc | What it covers |
|---|---|
| [verification-traps.md](verification-traps.md) | Checks that report success for the wrong reason. Read before you trust a green result |
| [line-endings-determinism.md](line-endings-determinism.md) | Why CRLF breaks byte-identical approval; the `.gitattributes` layers |
| [ui/README.md](ui/README.md) | Sub-index for the console's interface docs, with the status of the top audit findings |
| [ui/theming-convention.md](ui/theming-convention.md) | `[data-theme='dark']` rules are dead; use `light-dark()`; the check command |
| [harvest/README.md](harvest/README.md) | Sub-index for upstream reuse: current adapter state and what each brief shipped |

### Setup and tooling

| Doc | What it covers |
|---|---|
| [setup/gmail-tracker-apps-script.md](setup/gmail-tracker-apps-script.md) | Email tracker through Apps Script, and why not the Gmail API |
| [tooling/cli-auth-windows.md](tooling/cli-auth-windows.md) | Vercel and Supabase CLI on this Windows machine; the wrong-account token trap |
| [tooling/mcp-vs-cli-vercel-supabase.md](tooling/mcp-vs-cli-vercel-supabase.md) | Which route (MCP or CLI) this repo uses for each job |

## Records

Status is copied from each record's `Status 2026-11-08` banner. "No banner" means the record is from 2026-11-08 itself.

### handoff/

| Doc | Status | What it is |
|---|---|---|
| [handoff/2026-11-08-1745-orchestrator-handoff.md](handoff/2026-11-08-1745-orchestrator-handoff.md) | Newest pair | Orchestrator handoff, 2026-11-08 00:45 IST. Resume from here |
| [handoff/2026-11-08-1745-pending-tasks.md](handoff/2026-11-08-1745-pending-tasks.md) | Newest pair | Pending tasks at the same moment |

Older handoffs are in git history only (`git log --diff-filter=D --name-only -- docs/handoff`).

### status/

| Doc | Status | What it is |
|---|---|---|
| [status/2026-11-08-live-events-watch.md](status/2026-11-08-live-events-watch.md) | No banner | Read-only watch of tailor and auditor events: one-page trim, summary variants, new auditor findings |
| [status/2026-11-08-low-score-rows.md](status/2026-11-08-low-score-rows.md) | No banner | Low-score and failed rows Teja wants to apply to; prepared writes for the orchestrator |
| [status/2026-09-11-peer-assignments.md](status/2026-09-11-peer-assignments.md) | Superseded | Peer session assignments and pending list, 2026-09-11 |
| [status/2026-09-11-session-accounting.md](status/2026-09-11-session-accounting.md) | Historical | Sessions, commits and git rules on the morning of 2026-09-11 |
| [status/2026-09-progress-log-archive.md](status/2026-09-progress-log-archive.md) | Historical | The September progress log, moved out of `PROGRESS.md` |

### audit/

| Doc | Status | What it is |
|---|---|---|
| [audit/2026-11-01-wiring-audit.md](audit/2026-11-01-wiring-audit.md) | Partly superseded | Wiring audit of agents, modules and tiers; many P2 items fixed since |
| [audit/2026-09-18-migration-push-result.md](audit/2026-09-18-migration-push-result.md) | Historical | The first migration push, measured before and after |
| [audit/2026-09-17-unapplied-migrations-review.md](audit/2026-09-17-unapplied-migrations-review.md) | Superseded | Pre-apply review of the migration backlog |
| [audit/2026-09-16-pending-task-claims-verified.md](audit/2026-09-16-pending-task-claims-verified.md) | Superseded | Four "pending" claims checked against the tree |
| [audit/2026-09-10-schema-invariants-verified.md](audit/2026-09-10-schema-invariants-verified.md) | Partly superseded | First execution of the schema SQL; three invariants still hold |
| [audit/2026-09-10-handoff-verification.md](audit/2026-09-10-handoff-verification.md) | Historical | Handoff claims checked on 2026-09-10 |
| [audit/2026-09-09-locked-logic-coverage.md](audit/2026-09-09-locked-logic-coverage.md) | Superseded | Coverage of the plan's locked logic; every item now has a schema home |

### security/

| Doc | Status | What it is |
|---|---|---|
| [security/2026-11-05-vulnerability-remeasure.md](security/2026-11-05-vulnerability-remeasure.md) | Partly superseded | Latest vulnerability re-measure; most items fixed, #4 and #6 open or not re-checked |
| [security/2026-10-05-audit-remeasure.md](security/2026-10-05-audit-remeasure.md) | Superseded | Dependency audit re-measure; all its advisories fixed |
| [security/2026-09-17-dependency-remediation-plan.md](security/2026-09-17-dependency-remediation-plan.md) | Superseded | Dependency remediation plan |
| [security/2026-09-17-pipeline-identity-gaps.md](security/2026-09-17-pipeline-identity-gaps.md) | Superseded | Two identity gaps; closed by `guard_status_insert` and the agent-key header |
| [security/2026-09-17-playwright-window-blocked.md](security/2026-09-17-playwright-window-blocked.md) | Historical | The Playwright bump that landed without local execution |

### db/, ops/, tooling/

| Doc | Status | What it is |
|---|---|---|
| [db/2026-11-05-jobs-tombstone-policy.md](db/2026-11-05-jobs-tombstone-policy.md) | Current | Jobs tombstone space policy; live as the weekly `jobs-tombstone.yml` |
| [ops/2026-11-05-self-hosted-runner.md](ops/2026-11-05-self-hosted-runner.md) | Current (design only, not built) | Self-hosted runner for live submits |
| [tooling/2026-11-02-deploy-drift.md](tooling/2026-11-02-deploy-drift.md) | Current | Which edge functions run code older than `origin/main` (`scripts/deploy-drift.mjs`) |
| [tooling/2026-11-02-gemini-usage.md](tooling/2026-11-02-gemini-usage.md) | Current | The `gemini_usage` log table |

### architecture/ (record)

| Doc | Status | What it is |
|---|---|---|
| [architecture/graph-engineering.md](architecture/graph-engineering.md) | Partly superseded | The repo's graphs (status, provenance, pipeline, hash chain) taught against its code; agent facts now in `agents.md` |

### design/ and decisions/

| Doc | Status | What it is |
|---|---|---|
| [design/2026-11-02-referral-outreach-research.md](design/2026-11-02-referral-outreach-research.md) | Current | Referral outreach research; drafting is built |
| [design/2026-09-17-tech-only-discovery.md](design/2026-09-17-tech-only-discovery.md) | Superseded | Tech-only discovery design; now `screenTechRole` in the screener |
| [design/2026-09-10-cursor-palette.md](design/2026-09-10-cursor-palette.md) | Partly superseded | The Cursor-style palette and two catches |
| [decisions/2026-09-10-gmail-continuous-read-write-vs-zoho.md](decisions/2026-09-10-gmail-continuous-read-write-vs-zoho.md) | Current | Gmail through Apps Script, read and label only, over Zoho |

### robots/ and screener/

| Doc | Status | What it is |
|---|---|---|
| [robots/2026-09-17-robots-gate-design.md](robots/2026-09-17-robots-gate-design.md) | Partly superseded | robots.txt gate design, deviations and evidence |
| [robots/2026-09-17-robots-gate-first-caller.md](robots/2026-09-17-robots-gate-first-caller.md) | Historical | The gate's first caller and three wrong premises |
| [screener/2026-11-06-bulk-revive-needs-pregate-sweep.md](screener/2026-11-06-bulk-revive-needs-pregate-sweep.md) | Current | Runbook: after a bulk revive into `passed_filters`, run the pre-gate sweep |
| [screener/2026-09-17-screener-wiring.md](screener/2026-09-17-screener-wiring.md) | Partly superseded | Wiring the screener into scouting (born-at-verdict) |
| [screener/2026-11-06-scored-leak-retro.sql](screener/2026-11-06-scored-leak-retro.sql) | Executed 2026-11-06 | Live-write SQL for the scored-leak retro drop, kept as a record |
| [screener/2026-10-25-work-auth-retro.sql](screener/2026-10-25-work-auth-retro.sql) | Executed 2026-10-25 | Live-write SQL for the work-authorisation retro drop, kept as a record |

### harvest/ and watchlist/

The [harvest/README.md](harvest/README.md) sub-index gives what each brief shipped.

| Doc | Status | What it is |
|---|---|---|
| [harvest/2026-11-01-workday-coverage.md](harvest/2026-11-01-workday-coverage.md) | Partly superseded | Workday coverage; adapter shipped and registered |
| [harvest/2026-10-24-board-reprobes.md](harvest/2026-10-24-board-reprobes.md) | Partly superseded | Board re-probes; SmartRecruiters now off |
| [harvest/2026-10-23-watchlist-expansion.md](harvest/2026-10-23-watchlist-expansion.md) | Historical | Watchlist expansion, half B |
| [harvest/2026-09-16-ai-job-search-harvest-plan.md](harvest/2026-09-16-ai-job-search-harvest-plan.md) | Partly superseded | Harvest plan from the upstream `ai-job-search` |
| [harvest/2026-09-16-ai-job-search-inventory.md](harvest/2026-09-16-ai-job-search-inventory.md) | Historical | Per-file inventory of the upstream repo |
| [harvest/2026-09-16-approach-comparison.md](harvest/2026-09-16-approach-comparison.md) | Partly superseded | `applyyy` vs upstream approach |
| [harvest/briefs/brief-1-http-retry.md](harvest/briefs/brief-1-http-retry.md) | Current (shipped) | Shared HTTP transport |
| [harvest/briefs/brief-2-freehire-job-source.md](harvest/briefs/brief-2-freehire-job-source.md) | Historical (never built) | `freehire` adapter |
| [harvest/briefs/brief-3-job-scoring-and-salary-gate.md](harvest/briefs/brief-3-job-scoring-and-salary-gate.md) | Partly superseded | Scoring rubric shipped; salary gate has no caller |
| [harvest/briefs/brief-4-robots-gate.md](harvest/briefs/brief-4-robots-gate.md) | Current (shipped) | `@applyy/master-robots` gate |
| [harvest/briefs/brief-5-resume-node-selection.md](harvest/briefs/brief-5-resume-node-selection.md) | Partly superseded | Node selection and auditor rules; shipped only in part |
| [watchlist/2026-09-17-board-token-verification.md](watchlist/2026-09-17-board-token-verification.md) | Superseded | Board-token verification for the three-adapter era |

### ui/ (records)

| Doc | Status | What it is |
|---|---|---|
| [ui/2026-11-01-review-structure-edits-contract.md](ui/2026-11-01-review-structure-edits-contract.md) | Partly superseded | Review-page structural edit contract; manual controls removed, data layer still runs |
| [ui/audit-accessibility.md](ui/audit-accessibility.md) | Partly superseded | Accessibility audit (`A*` finding IDs) |
| [ui/audit-color-and-theming.md](ui/audit-color-and-theming.md) | Partly superseded | Colour and theming audit (`K*`) |
| [ui/audit-copy-and-ux.md](ui/audit-copy-and-ux.md) | Partly superseded | Copy and UX audit (`C*`) |
| [ui/audit-layout-and-typography.md](ui/audit-layout-and-typography.md) | Partly superseded | Layout and typography audit (`L*`) |

## Not yet committed

These folders are on disk but not in git as of 2026-11-08. They are being written in the same docs pass. Check `git ls-files docs/product docs/technical` before you rely on them.

| Doc | What it is |
|---|---|
| [product/README.md](product/README.md) | Product docs sub-index |
| [technical/README.md](technical/README.md) | Technical docs sub-index |
