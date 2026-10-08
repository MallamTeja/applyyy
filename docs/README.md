# `applyy` docs index

[`SYSTEM_ARCHITECTURE.md`](SYSTEM_ARCHITECTURE.md) is **the** current architecture doc.
Live status is the **"Current state"** section at the top of [`PROGRESS.md`](PROGRESS.md).
Everything in a dated folder is a historical record — never edited, never read as current.
No row here carries a count: each living doc names the command that regenerates its numbers.

## Living docs

| Doc | What it is |
|---|---|
| [../README.md](../README.md) | Repo overview and how to verify |
| [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) | Current architecture: components, agents, status graph, security, deploys, known gaps |
| [architecture/agents.md](architecture/agents.md) | Agent roster in depth — why each is shaped the way it is, transitions, Gemini cost, kill switch |
| [architecture/graph-engineering.md](architecture/graph-engineering.md) | The repo's graphs (status, provenance, pipeline, hash chain) and their invariants |
| [PROGRESS.md](PROGRESS.md) | "Current state" with regenerating commands, then the dated log |
| [verification-traps.md](verification-traps.md) | Checks that report success for the wrong reason — read before trusting a green |
| [line-endings-determinism.md](line-endings-determinism.md) | Why CRLF breaks byte-identical approval; the `.gitattributes` rule |
| [setup/gmail-tracker-apps-script.md](setup/gmail-tracker-apps-script.md) | Email-tracker setup via Apps Script |
| [tooling/cli-auth-windows.md](tooling/cli-auth-windows.md) | Vercel + Supabase CLI install and login on this Windows machine |
| [tooling/mcp-vs-cli-vercel-supabase.md](tooling/mcp-vs-cli-vercel-supabase.md) | MCP vs CLI routes; enumerate every route before recording a blocker |
| [ui/README.md](ui/README.md) | Sub-index for the console's interface docs |
| [ui/theming-convention.md](ui/theming-convention.md) | `[data-theme='dark']` rules are dead here; what to write instead |
| [harvest/README.md](harvest/README.md) | Sub-index for upstream codebases examined for reuse (ideas ported, never vendored) |
| [../packages/shared-types/SCHEMA_CONTRACT.md](../packages/shared-types/SCHEMA_CONTRACT.md) | Column-level database contract |
| [../PROJECT_PLAN.md](../PROJECT_PLAN.md) | Locked decisions (§2) and constraints (§3); stale parts are listed in `CLAUDE.md` §7 |

## Dated records (historical, never edited)

| Folder | What lives there |
|---|---|
| [handoff/](handoff/) | Orchestrator transfer notes, including `RESUME-HERE.md`; each is true as of its date |
| [status/](status/) | Point-in-time status snapshots, peer assignments, post-mortems |
| [audit/](audit/) | Verification passes — claims checked against code and the live DB at a given HEAD |
| [security/](security/) | Dependency-advisory plans and re-measures, identity-gap proposals |
| [design/](design/) | Single-feature design write-ups (palette, discovery filtering) |
| [decisions/](decisions/) | Recorded decisions and recommendations with their reasoning |
| [harvest/briefs/](harvest/briefs/) | Self-contained work packets from 2026-09-16 — your recon overrides them |
| [robots/](robots/) | Design and first-caller record of the robots.txt gate |
| [screener/](screener/) | How the filter cascade got wired into scouting |
| [watchlist/](watchlist/) | Company board-token verification by live probes |
| `ui/audit-*.md` | Dated UI audits carrying stable finding IDs (`K*`, `A*`, `L*`, `C*`) |
