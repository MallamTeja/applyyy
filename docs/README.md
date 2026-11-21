# `applyy` docs index

_Last verified against the tree: 2026-11-21 (3a86eada, plus the 2026-11-21 docs cleanup)._

This page lists the docs under `docs/` and says whether each one is **living** or a **record**.

- **Living** docs describe the system as it is now. They carry a "Last verified against code" line under the title. If one disagrees with the code, the code wins. Fix the doc.
- **Records** have a date in the name, or describe one moment (an audit, a brief, a status, a handoff). Their body is never rewritten. A `Status <date>` banner under the title says if the record still holds and names the doc that holds the current truth.
- No row here carries a count. Each living doc names the command that regenerates its numbers.
- **Stale records are deleted, not kept** (Teja, 2026-11-21). Git history keeps them: `git log --diff-filter=D --name-only -- docs`, then `git show <sha>^:<path>`. A record survives only while code, `CLAUDE.md`, a kept doc or the pending list still cites it, or while it holds tasks Teja has not yet ruled on.

Regenerate the list of docs this page must cover:

    git ls-files docs | grep -v '^docs/handoff/' | sort

## Start here

| Doc | Why read it first |
|---|---|
| [../README.md](../README.md) | What the project is, quick start, repo layout |
| [architecture/pipeline-end-to-end.md](architecture/pipeline-end-to-end.md) | One job through every status, with the agent, trigger and gates at each step |
| [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) | The current architecture: components, agents, status graph, security, deploys, known gaps |
| [product/README.md](product/README.md) | The product: vision, user journey, features, rulings, glossary |
| [technical/README.md](technical/README.md) | Technical sub-index: AI/LLM, deploys, local dev and testing, security model |
| [handoff/2026-11-12-1305-pending-tasks.md](handoff/2026-11-12-1305-pending-tasks.md) | The live pending list (sequenced plan at the top). The newest orchestrator handoff is the newest `docs/handoff/*orchestrator-handoff.md` (`ls docs/handoff \| sort \| tail`) |

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

### Product

| Doc | What it covers |
|---|---|
| [product/README.md](product/README.md) | Product sub-index and the open questions list |
| [product/vision-and-why.md](product/vision-and-why.md) | The goal and why each design choice was made |
| [product/user-journey.md](product/user-journey.md) | What Teja does and sees, day to day, with the schedule |
| [product/decisions-and-rulings.md](product/decisions-and-rulings.md) | Teja's rulings, dated, with where each one is enforced |
| [product/glossary.md](product/glossary.md) | Every term the code, docs and UI use |
| [product/history-timeline.md](product/history-timeline.md) | How the product got here, phase by phase |
| [product/roadmap-and-open-gaps.md](product/roadmap-and-open-gaps.md) | Stage table with its proof query; open gaps. Live work is the pending list |
| [product/features/](product/features/) | One doc per feature: job-discovery, screening, matching-and-scoring, resume-tailoring, approval-queue, auto-apply, manual-apply-lane, answer-bank-and-settings, tracking-and-email |

### Technical

| Doc | What it covers |
|---|---|
| [technical/README.md](technical/README.md) | Technical sub-index |
| [technical/ai-and-llm.md](technical/ai-and-llm.md) | The Gemini client: key pool, pacing, failover, streaming, cost levers |
| [technical/deploy-and-release.md](technical/deploy-and-release.md) | Deploy and release: the `git archive` export recipe, deploy order, verification |
| [technical/local-dev-and-testing.md](technical/local-dev-and-testing.md) | Local setup, the test suites, and CI parity |
| [technical/security-model.md](technical/security-model.md) | Identity, RLS, the agent key, grants, robots gate, secrets |

### Tailoring (rework in progress)

| Doc | What it covers |
|---|---|
| [tailor/README.md](tailor/README.md) | Tailor sub-index |
| [tailor/2026-11-18-tailoring-findings-and-plan.md](tailor/2026-11-18-tailoring-findings-and-plan.md) | Findings from 33 ideal resumes and the ordered plan (living plan despite the date) |
| [tailor/2026-11-18-architecture-changes.md](tailor/2026-11-18-architecture-changes.md) | Resume chat streaming, provenance validator, end-state rules: what changed and why |

### Status and plan

| Doc | What it covers |
|---|---|
| [PROGRESS.md](PROGRESS.md) | How to re-derive progress toward the goal (never a stored %), open items |
| [../PROJECT_PLAN.md](../PROJECT_PLAN.md) | Locked decisions and constraints. Goes stale: verify claims against code before you obey them |

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
| [ui/README.md](ui/README.md) | Sub-index for the console's interface docs, with the status of the audit findings |
| [ui/theming-convention.md](ui/theming-convention.md) | `[data-theme='dark']` rules are dead; use `light-dark()`; the check command |
| [harvest/README.md](harvest/README.md) | Sub-index for upstream reuse: current adapter state and what each brief shipped |

### Setup and tooling

| Doc | What it covers |
|---|---|
| [setup/gmail-tracker-apps-script.md](setup/gmail-tracker-apps-script.md) | Email tracker through Apps Script, and why not the Gmail API |
| [tooling/cli-auth-windows.md](tooling/cli-auth-windows.md) | Vercel and Supabase CLI on this Windows machine; the wrong-account token trap |
| [tooling/mcp-vs-cli-vercel-supabase.md](tooling/mcp-vs-cli-vercel-supabase.md) | Which route (MCP or CLI) this repo uses for each job |
| [tooling/2026-11-02-deploy-drift.md](tooling/2026-11-02-deploy-drift.md) | Which edge functions run code older than `origin/main` (`scripts/deploy-drift.mjs`) |
| [tooling/2026-11-02-gemini-usage.md](tooling/2026-11-02-gemini-usage.md) | The `gemini_usage` log table |
| [status/2026-11-09-supabase-cli-v3.md](status/2026-11-09-supabase-cli-v3.md) | Why the Supabase CLI stays on v2, and the edit list for v3 (linked from `CLAUDE.md` §3) |

### Runbooks and designs still in force

| Doc | What it covers |
|---|---|
| [screener/2026-11-06-bulk-revive-needs-pregate-sweep.md](screener/2026-11-06-bulk-revive-needs-pregate-sweep.md) | After a bulk revive into `passed_filters`, run the pre-gate sweep |
| [db/2026-11-05-jobs-tombstone-policy.md](db/2026-11-05-jobs-tombstone-policy.md) | Jobs tombstone space policy; live as the weekly `jobs-tombstone.yml` |
| [audit/2026-11-18-discovery-channels.md](audit/2026-11-18-discovery-channels.md) | Discovery-channel register (D1-D16) the pending list cites |
| [robots/2026-09-17-robots-gate-design.md](robots/2026-09-17-robots-gate-design.md) | robots.txt gate design, deviations and evidence (cited by `packages/master-robots`) |
| [harvest/2026-11-01-workday-coverage.md](harvest/2026-11-01-workday-coverage.md) | Workday quirks reference (cited by `_shared/ats/registry.ts`) |
| [decisions/2026-09-10-gmail-continuous-read-write-vs-zoho.md](decisions/2026-09-10-gmail-continuous-read-write-vs-zoho.md) | Gmail through Apps Script, read and label only, over Zoho |
| [design/2026-11-02-referral-outreach-research.md](design/2026-11-02-referral-outreach-research.md) | Referral outreach research; drafting is built, sending is not |
| [ui/2026-11-01-review-structure-edits-contract.md](ui/2026-11-01-review-structure-edits-contract.md) | Review-page edit contract; the data layer still runs (cited by web code) |
| [architecture/2026-11-18-pipeline-flow-changes.md](architecture/2026-11-18-pipeline-flow-changes.md) | Decision record of the 2026-11-18 pipeline-flow changes: old design, new design, reason, evidence |

## Records

Kept only while something still cites them, or while they hold tasks awaiting Teja's ruling ("Holds open tasks").

### Kept because code, a migration or a kept doc cites them

| Doc | Cited by |
|---|---|
| [audit/2026-09-10-schema-invariants-verified.md](audit/2026-09-10-schema-invariants-verified.md) | `masterStore.ts`, `supabase/tests/invariants.sql`, a migration |
| [audit/2026-11-01-wiring-audit.md](audit/2026-11-01-wiring-audit.md) | a migration and worker tests |
| [status/2026-09-progress-log-archive.md](status/2026-09-progress-log-archive.md) | `PROGRESS.md` (the September progress log) |
| [status/2026-11-08-web-latency.md](status/2026-11-08-web-latency.md), [status/2026-11-08-web-latency-db.md](status/2026-11-08-web-latency-db.md) | `email-tracker-intake/replay.ts`, migration `20261108170000` |
| [status/2026-11-09-ats-keyword-coverage.md](status/2026-11-09-ats-keyword-coverage.md) | migration `20261109120000` |
| [status/2026-11-09-identity-drift.md](status/2026-11-09-identity-drift.md) | `_shared/normalize/fingerprint.ts` |
| [status/2026-11-09-matcher-stall.md](status/2026-11-09-matcher-stall.md) | `matcher/pacer.ts`, `tailor/call-counter.ts`, a migration |
| [status/2026-11-09-pipeline-stall.md](status/2026-11-09-pipeline-stall.md) | `postscreen-drain.yml`, its workflow test |
| [design/2026-09-17-tech-only-discovery.md](design/2026-09-17-tech-only-discovery.md) | `_shared/screen/tech-gate.ts` |
| [robots/2026-09-17-robots-gate-first-caller.md](robots/2026-09-17-robots-gate-first-caller.md) | `_shared/http/transport.ts` |
| [harvest/2026-10-23-watchlist-expansion.md](harvest/2026-10-23-watchlist-expansion.md) | `supabase/snippets` seeds |
| [harvest/2026-10-24-board-reprobes.md](harvest/2026-10-24-board-reprobes.md) | `settings/companyCatalog.ts` |
| [harvest/2026-09-16-ai-job-search-inventory.md](harvest/2026-09-16-ai-job-search-inventory.md) | the harvest plan |
| [harvest/briefs/brief-4-robots-gate.md](harvest/briefs/brief-4-robots-gate.md) | the robots gate design (its §6 "Defects in brief-4") |
| [watchlist/2026-09-17-board-token-verification.md](watchlist/2026-09-17-board-token-verification.md) | `supabase/snippets` seed |
| [security/2026-10-05-audit-remeasure.md](security/2026-10-05-audit-remeasure.md) | the 2026-11-05 vulnerability re-measure (a never-edited record) |
| [architecture/graph-engineering.md](architecture/graph-engineering.md) | `apps/web/src/features/health/HealthPage.tsx`, `SYSTEM_ARCHITECTURE.md` (teaching record; agent facts are in `agents.md`) |

### Holds open tasks (awaiting Teja's ruling, 2026-11-21 cleanup)

Each task is listed in `docs/handoff/2026-11-21-peer-2-docs.md` under "For Teja's approval". Once Teja rules, the task moves to the pending list (or is dropped) and the record is deleted.

| Doc | Open task(s) |
|---|---|
| [status/2026-11-09-mumbai-move-plan.md](status/2026-11-09-mumbai-move-plan.md) | Supabase region move Sydney to Mumbai (deferred by Teja) |
| [status/2026-11-09-wiring-audit-recheck.md](status/2026-11-09-wiring-audit-recheck.md) | W37 deploy ledger; W23 housekeeping |
| [status/2026-11-09-failed-rows.md](status/2026-11-09-failed-rows.md) | cited by the 2026-11-09 pending list below |
| [security/2026-11-05-vulnerability-remeasure.md](security/2026-11-05-vulnerability-remeasure.md) | #4 leaked-password protection, #6 Deno dependency audit (also cited by `ci.yml`, so it stays) |
| [ops/2026-11-05-self-hosted-runner.md](ops/2026-11-05-self-hosted-runner.md) | Self-hosted runner for live submits: carry or retire |
| [harvest/2026-09-16-ai-job-search-harvest-plan.md](harvest/2026-09-16-ai-job-search-harvest-plan.md), [harvest/briefs/brief-3-job-scoring-and-salary-gate.md](harvest/briefs/brief-3-job-scoring-and-salary-gate.md), [harvest/briefs/brief-5-resume-node-selection.md](harvest/briefs/brief-5-resume-node-selection.md) | Salary gate has no caller; brief-5's four auditor rules unbuilt |
| [screener/2026-09-17-screener-wiring.md](screener/2026-09-17-screener-wiring.md) | Nothing writes `requires_advanced_degree`, so `degree_mismatch` never fires |
| [ui/audit-accessibility.md](ui/audit-accessibility.md), [ui/audit-color-and-theming.md](ui/audit-color-and-theming.md), [ui/audit-copy-and-ux.md](ui/audit-copy-and-ux.md), [ui/audit-layout-and-typography.md](ui/audit-layout-and-typography.md) | Open findings listed in [ui/README.md](ui/README.md) |
| `docs/handoff/` 2026-11-09 to 2026-11-18 files still tracked | Watchlist boards, the 668 Workday revival, the email quoted-text parser, "ideally N+ years", Workday applier login, `loop.ts` deletion, the Ashby robots ruling, queue re-tailor, and more; some are kept only because the pending list or a 2026-11-21 file links them |
