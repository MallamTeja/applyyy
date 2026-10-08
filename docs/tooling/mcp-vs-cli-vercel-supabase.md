# MCP server vs CLI — Vercel and Supabase

Written 2026-09-09.

> **Update 2026-10-08:** the Supabase MCP is authorized (`execute_sql` works) and both
> servers' tool lists are visible; rows corrected below. Re-check with `/mcp` before relying
> on any cell.

## Honesty about the evidence

The `vercel` and `supabase` MCP servers are **configured but unauthorized** in this session,
so I could not enumerate their live tool lists. The CLI side of every claim below was
verified by running `--help` locally; the MCP side is from knowledge of the published tool
surfaces and may drift as those servers ship new tools. Re-check with `/mcp` once authorized.

## Short answer

**The CLI is the capability superset for both products.** MCP is not a bigger toolbox — it
is a *differently shaped* one. It trades breadth for structure.

The reason is architectural, and it is worth internalising because it generalises to every
MCP server you will ever evaluate:

> An MCP server exposes a **curated, remotely-hosted API surface**. A CLI is a **local
> process with filesystem, Docker and network access**. Anything that needs to touch your
> disk, run containers, or bundle your code cannot be an MCP tool.

That single rule predicts almost every gap below.

## Vercel

| Capability | CLI | MCP |
|---|---|---|
| Deploy / promote / rollback | Yes | Yes (`create_deployment`, `request_promote`, `request_rollback`) |
| `vercel dev` local runtime | Yes | **No** (needs local process) |
| `vercel build --prebuilt` | Yes | **No** (needs filesystem) |
| Env var pull to `.env` | Yes | **No** (writes local files) |
| Env var read/manage remotely | Yes | Yes (`create_project_env`, `edit_project_env`) |
| Domains, DNS, certs | Yes | Yes (`add_project_domain`, `get_records`, `issue_cert`) |
| Firewall / WAF rules | Yes | Yes (`get_firewall_config`, `put_firewall_config`) |
| List projects & deployments | Yes | Yes |
| Read deployment build logs | Yes | Yes, **structured** |
| Search Vercel documentation | No | **Yes** |

**Verdict: CLI wins decisively.** The MCP server's real edge is documentation search and
returning deployment/build data as JSON an agent can reason over without parsing terminal
output. Local-process work (`vercel dev`, `build --prebuilt`, `env pull`) is still CLI-only.

## Supabase

| Capability | CLI | MCP |
|---|---|---|
| Local dev stack (`supabase start`, Docker Postgres/Studio/Auth) | Yes | **No** |
| Deploy Edge Functions | Yes | Yes (`deploy_edge_function`) |
| Local migration diffing (`db diff`, `db pull`, `db reset`) | Yes | **No** |
| Seed data, local testing | Yes | **No** |
| Set function secrets | Yes | **No** |
| Apply a migration to the remote project | Yes | Yes |
| Run arbitrary SQL against the project | Yes (via `db` cmds) | **Yes, directly** |
| List tables / extensions / migrations | Partial | Yes, **structured** |
| Generate TypeScript types | Yes | Yes |
| Fetch project URL + anon key | Yes | Yes |
| Read project logs | Yes | Yes |
| **Security & performance advisors (lints)** | **No** | **Yes** |
| Search Supabase documentation | No | **Yes** |
| Create / pause / restore projects | Yes | Yes (write mode) |
| Branching (create/merge/rebase) | Yes | Yes (paid plans) |

**Verdict: CLI still wins on breadth, but Supabase's MCP has genuine non-overlap.**
`get_advisors` (security and performance lints on your schema — e.g. tables without RLS)
has no CLI equivalent, and doc search doesn't either. This is the one place where "use both"
is the correct answer rather than a cop-out.

## How to actually choose

- **Changing state, touching disk, running Docker → CLI.** Deploys, local stacks, migrations
  you author, Edge Functions.
- **Asking questions, and you want the answer as data → MCP.** "Which tables have no RLS
  policy?", "why did deployment X fail?", "what's the syntax for Y?"
- Both at once is normal. They are not competing installs.

## The security point nobody asks about

Giving an agent a Supabase MCP server in **write mode against production** means any
prompt-injected content the agent reads — an issue body, a webhook payload, a row of
user-submitted data — can reach `execute_sql`. Supabase's own guidance is read-only mode
plus a development project, not production. The CLI has the same exposure in principle but a
much higher friction floor, since destructive operations need explicit commands and often a
confirmation.

Configure the Supabase MCP server read-only unless you have a specific reason not to.
