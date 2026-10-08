# CLI auth on this machine — Vercel + Supabase (Windows 11)

Audited 2026-09-09 in repo `applyy`. Facts below came from live checks, not memory.

## Current state

| Tool | Installed? | Version | Logged in? | Credential location |
|------|-----------|---------|-----------|---------------------|
| Vercel CLI | Yes — global npm (`%APPDATA%\npm\vercel.cmd`) | 59.5.0 | **Yes**, as `mallamteja` | `%APPDATA%\xdg.data\com.vercel.cli\auth.json` |
| Supabase CLI | **Yes** — `C:\Users\tejam\tools\supabase\supabase.exe` (official release binary) | 2.117.0 as of 2026-10-08 (re-check: `supabase --version`) | Authenticated as of 2026-10-08 (re-check: `supabase migration list --linked`) | `SUPABASE_ACCESS_TOKEN` env var (set), which overrides Credential Manager |
| Node / pnpm | Yes | v24.14.0 / 11.25.0 | — | — |

Installed 2026-09-09 by downloading `supabase_2.117.0_windows_amd64.zip` from GitHub
releases and extracting to `C:\Users\tejam\tools\supabase\`, then appending that directory
to the **user** PATH.

Why not scoop, which the Supabase docs recommend: scoop requires
`Set-ExecutionPolicy RemoteSigned` plus a whole package manager for one binary. Why not
`C:\Users\tejam\bin`, which Git Bash showed on PATH: **that directory does not exist and is
not on the Windows PATH**. Git Bash synthesises `$HOME/bin` into its own PATH whether or not
it exists, so installing there would have worked in Git Bash and silently failed in
PowerShell. Confirm PATH entries against
`[Environment]::GetEnvironmentVariable('Path','User')`, never against `echo $PATH` in Git Bash.

Upgrading is manual: re-download the newer zip over the same directory. There is no
`supabase upgrade` subcommand.

## The concept: two different kinds of "logged in"

1. **Interactive session credential** — `vercel login` / `supabase login` open a browser,
   then persist a token to disk (Vercel) or the Windows Credential Manager (Supabase).
   Survives reboots. Fails in any shell that can't open a browser — CI, an agent, a
   non-interactive Claude Code session.
2. **Ambient credential (environment variable)** — a Personal Access Token exported as an
   env var. Every invocation of the CLI picks it up with no browser, no expiry prompt,
   no per-session state. This is the one that is actually "permanent for the IDE".

The pattern is **ambient credential injection**: move the secret out of per-process login
state and into the environment the IDE hands to every child process. Set it once at the
Windows *user* level and every terminal, task runner and agent inherits it.

## Vercel — permanent

Already logged in, so nothing is required for interactive use. For agent/CI-safe access:

```powershell
# 1. Create a token: https://vercel.com/account/tokens  (scope it to your team, set an expiry you accept)
# 2. Persist it at user level. setx writes the registry; it does NOT affect the current shell.
setx VERCEL_TOKEN "vercel_xxxxxxxxxxxxxxxx"
```

The CLI reads `VERCEL_TOKEN` automatically; `vercel --token $env:VERCEL_TOKEN` is the
explicit form. A token beats `vercel login` for anything scripted because it never has to
be re-consented after a session expires.

## Supabase — install, then permanent

There is no supported global npm install for the Supabase CLI, and it is not in the
Chocolatey community repo (checked — no results). Two workable routes:

### Route A — project dev dependency (not taken: the standalone binary above was installed instead)

```powershell
pnpm init                 # this repo has no package.json yet
pnpm add -D supabase      # pnpm only; npm is banned in these repos
pnpm supabase --version   # invoke through pnpm, version pinned in the lockfile
```

Trade-off: pinned and reproducible per repo, but no bare `supabase` command globally.

### Route B — scoop (real binary on PATH, machine-wide)

```powershell
# scoop is not installed on this machine yet
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```

Trade-off: one `supabase` everywhere, but the version is global — a second project wanting
a different CLI version has nowhere to go. Route A is the safer default; add Route B only
if you want the bare command in every shell.

### Login

```powershell
supabase login            # interactive, one time, stores in Windows Credential Manager
```

**This must be run in a real terminal.** `supabase login` refuses to run in a non-TTY
environment (an agent shell, a piped command, CI):

```
LegacyLoginMissingTokenError: Cannot use automatic login flow inside non-TTY environments.
Please provide --token flag or set the SUPABASE_ACCESS_TOKEN environment variable.
```

`--no-browser` does not work around it — verified 2026-09-09. That error is the CLI telling
you the ambient-credential route below is the correct one for agent-driven use.

Permanent / headless equivalent:

```powershell
# Token from https://supabase.com/dashboard/account/tokens
setx SUPABASE_ACCESS_TOKEN "sbp_xxxxxxxxxxxxxxxx"
# Optional, makes `supabase db push` non-interactive:
setx SUPABASE_DB_PASSWORD "..."
```

`SUPABASE_ACCESS_TOKEN` overrides whatever `supabase login` stored, so it is the one that
makes agent-run commands work — and the one that breaks them. As of 2026-10-08,
`migration list --linked` succeeds while `db query --linked` returns 403 (insufficient
privileges); check which account the token belongs to before trusting it.

## Making the IDE actually see the variables

`setx` only affects **processes started after it runs**. A terminal panel inside
Cursor/VS Code inherits the environment of the *editor process*, not of Windows-now.

1. Run the `setx` commands.
2. **Fully quit and reopen the IDE** — closing the terminal panel is not enough.
3. Restart the Claude Code session so it inherits the new environment.
4. Verify without printing the secret:
   ```powershell
   if ($env:SUPABASE_ACCESS_TOKEN) { "SUPABASE_ACCESS_TOKEN set" } else { "missing" }
   ```

## Things that will bite later

- **CLI login is not MCP login.** The `supabase` and `vercel` MCP servers authorize separately
  (OAuth via `/mcp` in an interactive session). As of 2026-10-08 the Supabase MCP's
  `execute_sql` works while CLI `db query` gets 403 — the working route changes, so
  re-enumerate routes each time. Setting
  `SUPABASE_ACCESS_TOKEN` does not authorize the MCP server.
- ~~This repo has no `.gitignore`~~ — fixed 2026-09-09. `.gitignore` now covers `.env`,
  `.env.*`, `.vercel/`, `supabase/.temp/`, `supabase/.branches/` and `bash.exe.stackdump`. Verified with `git check-ignore -v .env`.
- **Never echo the tokens.** `echo $env:VERCEL_TOKEN` puts the secret in scrollback, shell
  history and any transcript capture.
- `bash.exe.stackdump` in the repo root is crash debris — safe to delete, unrelated to auth.
