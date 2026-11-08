# CLI auth on this machine: Vercel and Supabase (Windows 11)

_Last verified against code: 2026-11-08 (2a9ac31)._

First audited 2026-09-09. Re-measured on 2026-11-08 from live checks on this PC. Every
version below is a measurement with a date. Re-run the command next to it before you
trust it.

## Current state

| Tool | Where it is installed | Version (as of 2026-11-08) | Re-check with |
|------|----------------------|----------------------------|---------------|
| Vercel CLI | global npm, `%APPDATA%\npm\vercel.cmd` | 63.1.0 | `vercel --version` |
| Supabase CLI (the one that runs) | global npm, `%APPDATA%\npm\supabase.cmd` | 2.119.0 (v3.0.0 is offered) | `supabase --version` |
| Supabase CLI (old, shadowed) | `C:\Users\tejam\tools\supabase\supabase.exe` | 2.117.0 | `C:\Users\tejam\tools\supabase\supabase.exe --version` |
| Node / pnpm | system install | v24.14.0 / 11.25.0 | `node -v`, `pnpm -v` |

### Two Supabase CLIs are on PATH

There are two copies of the Supabase CLI. The npm copy comes first on PATH in both
PowerShell and Git Bash, so it is the one that runs. Check the order with:

```powershell
(Get-Command supabase -All).Source
```

On 2026-11-08 this listed the npm shims first and `C:\Users\tejam\tools\supabase\supabase.exe`
last. The old copy was installed on 2026-09-09 by hand: the release zip was extracted to
`C:\Users\tejam\tools\supabase\` and that folder was added to the **user** PATH. Nobody
uses it now. You can remove that folder and its PATH entry when you are ready. Ask Teja
first, because it deletes files.

Upgrading v2 to v3 is an open task (`docs/handoff/2026-11-08-1745-pending-tasks.md`,
item 13). Do not upgrade in the middle of a deploy session.

**Why the PATH check uses PowerShell, not Git Bash.** Git Bash adds `$HOME/bin` to its own
PATH even when that folder does not exist. A tool installed there works in Git Bash and
fails in PowerShell. Read the real user PATH with
`[Environment]::GetEnvironmentVariable('Path','User')`, never with `echo $PATH` in Git Bash.

## The concept: two kinds of "logged in"

1. **Interactive session credential.** `vercel login` and `supabase login` open a browser.
   Then they save a token: Vercel on disk, Supabase in the Windows Credential Manager. It
   survives reboots. It fails in any shell that cannot open a browser: CI, an agent, a
   non-interactive Claude Code session.
2. **Ambient credential (environment variable).** A Personal Access Token in an env var.
   Every CLI call picks it up. No browser, no prompt, no per-session state.

The pattern is called **ambient credential injection**. You move the secret out of
per-process login state and into the environment that every child process inherits.

The trap is the other side of the same pattern: an ambient credential **overrides** the
login. If the env var holds the wrong account's token, every command uses the wrong
account, and the error does not say so.

## Supabase: the wrong-account token (read this first)

The Windows **user** env var `SUPABASE_ACCESS_TOKEN` holds a token for the **wrong**
Supabase account. With it set, `supabase db query --linked` returns 403. With it unset, the
CLI falls back to the `supabase login` credential, which is the right account. This is the
"403 since ~2026-10-04" (CLAUDE.md §4, re-verified 2026-11-01).

How to run a command without it:

```bash
# Bash: env -u removes the variable for this one command only
env -u SUPABASE_ACCESS_TOKEN supabase db query --linked "select 1"
```

```powershell
# PowerShell: clears it for this shell only; the user env var is unchanged
$env:SUPABASE_ACCESS_TOKEN = $null
supabase functions list --project-ref xynqxekcqizwhtskzqrq
```

Tools in this repo already do this for you:

- `scripts/deploy-drift.mjs:38` deletes `SUPABASE_ACCESS_TOKEN` from the CLI's environment.
- The deploy runbook in CLAUDE.md §3 sets it to `$null` before `supabase functions deploy`.

Do not "fix" this by running `setx SUPABASE_ACCESS_TOKEN` with a new token unless Teja asks.
The token is a secret, and changing it changes every shell on the machine.

### SQL that starts with a comment

`supabase db query --linked "-- note ..."` fails: the CLI reads the leading `--` as a flag.
Put such SQL in a file and pass `-f <file>` (CLAUDE.md §4).

### Login (one time, real terminal only)

```powershell
supabase login   # interactive; stores the token in Windows Credential Manager
```

`supabase login` refuses to run without a TTY (an agent shell, a pipe, CI):

```
LegacyLoginMissingTokenError: Cannot use automatic login flow inside non-TTY environments.
Please provide --token flag or set the SUPABASE_ACCESS_TOKEN environment variable.
```

`--no-browser` does not get around this (verified 2026-09-09). Teja must run it in his own
terminal.

## Vercel

The CLI is logged in as `mallamteja` (checked 2026-09-09; re-check with `vercel whoami`).
Interactive use needs nothing more.

For scripts, the CLI reads `VERCEL_TOKEN` automatically. `vercel --token <token>` is the
explicit form. A token never has to be re-consented after a session expires. Create one at
https://vercel.com/account/tokens, scoped to the team, with an expiry.

The web app deploys itself: Vercel builds on every push to `main` (CLAUDE.md §1). You rarely
need the Vercel CLI for this repo.

## Making the IDE see a changed env var

`setx` changes only **processes started after it runs**. A terminal inside VS Code or Cursor
inherits the editor's environment, not the current Windows one.

1. Run `setx`.
2. **Quit and reopen the IDE.** Closing the terminal panel is not enough.
3. Restart the Claude Code session.
4. Check without printing the secret:
   ```powershell
   if ($env:SUPABASE_ACCESS_TOKEN) { "SUPABASE_ACCESS_TOKEN set" } else { "missing" }
   ```

## Things that will bite later

- **CLI login is not MCP login.** The Supabase and Vercel MCP servers authorize separately
  (OAuth through `/mcp` in an interactive session). A running window keeps the auth state it
  had at startup. Setting `SUPABASE_ACCESS_TOKEN` does not authorize the MCP server. See
  `docs/tooling/mcp-vs-cli-vercel-supabase.md`.
- **Routes change.** Before you say "the DB is unreachable", try each route: the MCP
  `execute_sql`, then `env -u SUPABASE_ACCESS_TOKEN supabase db query --linked` (CLAUDE.md §4).
- **Never echo a token.** `echo $env:VERCEL_TOKEN` puts the secret in scrollback, shell
  history and any transcript.
- **`.gitignore` covers local secrets.** It lists `.env`, `.env.*`, `.vercel/`,
  `supabase/.temp/`, `supabase/.branches/` and `bash.exe.stackdump` (`.gitignore`). Check a
  path with `git check-ignore -v <path>`.
- **Never `npm install` inside the repo.** It is pnpm only. The global npm installs above
  were made outside the repo.
