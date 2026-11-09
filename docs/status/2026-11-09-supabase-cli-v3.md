# Supabase CLI v2.119.0 → v3.0.0: what it breaks here (2026-11-09)

Peer 2, read-only. Nothing was installed or upgraded, and no command that writes was run.
Local CLI: `supabase@2.119.0` from a global npm install (`%APPDATA%\npm`). It never upgrades itself, so v2 stays until someone runs `npm i -g supabase@latest`.

## Verdict

**Pin v2 for now: do not upgrade yet.** Three v2-compatible edits can land today. After those, the upgrade needs two v3-only edits, made in the same change.
Upgrading today, unchanged, would fail every `db` command, every deploy and every agent `db query`. One step would also pass vacuously: the pre-push `db push --dry-run` would read the **local** stack, not production.

## Sources

- **R** = v3.0.0 release notes, `gh release view v3.0.0 -R supabase/cli` (published 2026-11-02T12:18:34Z), https://github.com/supabase/cli/releases/tag/v3.0.0
- **M** = migration guide, https://supabase.com/docs/guides/local-development/cli/migrating-to-v3
- **S** = v3.0.0 source, read with `gh api repos/supabase/cli/contents/<path>?ref=v3.0.0`. v3 is a TypeScript rewrite under `apps/cli/`.
- The docs reference pages (`/docs/reference/cli/...`) still describe v2 (there is no `--remote` on them), so they are not cited for v3.

## 0. A blocker before any command: `[inbucket]` in our config.toml

`supabase/config.toml:54` has an `[inbucket]` section.
> R: "v3 can't load a `supabase/config.toml` that still has an `[inbucket]` section … so `start`, `stop`, `status` and the `db` commands fail with `[inbucket] in supabase/config.toml is no longer supported`. Rename the section … v2.108.0 and later already read `[local_smtp]`, so you can rename it before you upgrade."

S (`functions/deploy/SIDE_EFFECTS.md`): deploy "also runs the full `Config.Validate` pipeline …, so an invalid config fails up front even for fields this command never otherwise reads". **Deploys fail on it too.**
Fix: rename `[inbucket]` to `[local_smtp]`, keys unchanged. This is safe on our v2.119.

## 1. Per command

| Our use (where) | v3 verdict | Citation (verbatim) | Edit |
|---|---|---|---|
| `supabase functions deploy <fn> --project-ref xynqxekcqizwhtskzqrq --use-api --import-map supabase/functions/deno.json` (CLAUDE.md:79) | **Behaviour changed: needs `--yes`.** `--project-ref` is deprecated (it still works and warns on stderr). `--use-api` and `--import-map` are unchanged. | R: "Every command that changes a hosted project asks first, and fails unattended unless you pass `--yes`. … This includes … `functions deploy`/`delete`". S `deploy.command.ts`: `useApi: Flag.Boolean("use-api")`, `importMap: Flag.String("import-map")`. S `SIDE_EFFECTS.md`: the per-function `deno.json` is read "unless `--import-map` or `functions.<slug>.import_map` is set". R: "`--linked`, `--project-ref`, `--db-url` … are deprecated. They still work, print a warning naming the `--remote` form". | Add `--yes` now (v2 already accepts it as a global flag). Later, optionally `--project-ref X` → `--remote=X`. |
| `db push --dry-run`, then `db push` (CLAUDE.md:73), from a pinned worktree with `.temp/` copied in | **Behaviour changed: the default target flips to LOCAL.** The real push needs `--yes`; the dry-run does not. | R: "`db push`, `db pull`, … `migration fetch`/`list`/`repair` … **target the local stack when you pass no target.** Add `--remote` for the linked project". S `db/push/SIDE_EFFECTS.md`: "`--dry-run` ask nothing" and "`--dry-run` prints the plan … and applies nothing". | **Name the target now:** `db push --linked --dry-run` / `db push --linked`. On v2 `--linked` is explicit; on v3 it still works with a warning. Add `--yes` to the real push after the upgrade. Without this, a v3 dry-run reads the local DB, so the "lists exactly the expected migrations" gate checks the wrong database. |
| `env -u SUPABASE_ACCESS_TOKEN supabase db query --linked "<select>"` and `-f <file>` (CLAUDE.md:108-109, 29 docs mentions, memories) | **Behaviour changed: a hosted query needs `--yes` or `--read-only`.** `--linked` is deprecated but works. The JSON shape is unchanged in agent mode (see §2). New: SQL as an argument AND `-f` together is rejected. | M: "`db query`, or pass `--read-only` for reads". S `apps/cli/docs/supabase/db/query.md`: "a script, a JSON run or an agent must pass `--yes` or set `SUPABASE_YES` in the shell". Also: "Pass `--read-only` to run a statement that must not change anything. It skips the confirmation on a hosted database. … every statement must start with `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`, `EXPLAIN` or a parenthesised query (after whitespace and comments)." And: "A linked project runs it through the Management API's `read_only` mode, and the API enforces it." | **v3-only:** add `--read-only` to every SELECT recipe (v2.119 has no such flag, so it can't land early). Never `--yes` for reads. A comment-led `-f` file still passes ("after whitespace and comments"). |
| `supabase migration list` (memory, the old migration `20261004210000` comment) | **Behaviour changed: the default target flips to LOCAL.** No consent needed. | R: as above, "`migration fetch`/`list`/`repair` … target the local stack". S `migration/list/SIDE_EFFECTS.md`: "Target: selectable, no consent". | Always `migration list --linked` (v2- and v3-safe). CLAUDE.md:115 already prefers the MCP `list_migrations`. |
| `supabase secrets list` (Gemini-model digest compare, memory) | **Unchanged** for text and `-o json`. `--project-ref` warns. | S `secrets/list/SIDE_EFFECTS.md`: "Target: hosted, no consent". "`--output json`: Indented JSON of the sorted `[{name, value, updated_at?}]` array". | None. Re-check that the `value` digest column looks the same on the first v3 run. |
| `supabase functions list --project-ref … -o json` (`scripts/deploy-drift.mjs:41`, which asserts `Array.isArray`) | **Unchanged** with `-o json`. | S `functions/list/SIDE_EFFECTS.md`: "`json` emits the raw array, without `target`." (Only `--output-format json` wraps it as `{functions, target}`.) M: "Arrays and generated artifacts … are unchanged." | None. Keep `-o json`; never switch the script to `--output-format json`. |
| CI (`.github/workflows/*`) | **Not affected: CI never installs the CLI.** | `git grep -n -i "setup-cli\|run: supabase\|npx supabase" -- .github` finds nothing. Workflows pin pnpm `11.25.0`, Node `24` and Deno `v2.9.6` only. | None. Local = 2.119.0; CI = none. |

**Deprecation warnings and `Target:` lines go to stderr** (M: "print a warning on stderr that names the replacement, and are removed in v4"; "Commands that resolve a target print `Target: …` once on stderr"). Our parsers read stdout. A script that pipes `2>&1` into `JSON.parse(s.slice(s.indexOf('{'), …))` gets extra text before the `{`, which the slice still skips. Keep stdout and stderr separate anyway.

## 2. The `db query` JSON shape (the silent-break question)

Today (v2.119, run from this agent session) the output is `{"boundary","rows","warning"}` (keys measured live with `select 1`).
In v3 the shape **depends on agent mode, as it does in v2**. S `db/query/query.format.ts` `renderJson`: "The established JSON output: a plain rows array in human mode, or an untrusted-data envelope `{warning, boundary, rows, advisory?}` in agent mode". S `query.md`: "When used by an AI coding agent (auto-detected or via --agent=yes), the default output format is JSON with an untrusted data warning envelope. When used by a human … table without the envelope."
- No `target` key is added to `db query`'s JSON: `renderJson` writes only `advisory?`, `boundary`, `rows` and `warning`. The release note's "JSON object results … gain a `target` object" applies to the `--output-format json` result objects, not this envelope.
- **New possible key: `advisory`.** Parsers that read `.rows` are unaffected.
- **The real hazard is the same in v2 and v3.** A script run from a plain terminal or a CI shell (not detected as an agent) gets a bare **array**. Then `s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)` cuts a single row object, `.rows` is undefined, and the script crashes or silently reads nothing. **Pass `--agent=yes` in every scripted `db query -o json`** (the flag exists in v2.119 as a global, so this can land now). Also make parsers accept both shapes: `Array.isArray(o) ? o : o.rows`.

## 3. Project env files are now config inputs

R: "Every value now resolves as flag > shell environment > project env files > `config.json`/`config.toml` > default". Project env files are `.env.<SUPABASE_ENV>.local`, `.env.local`, `.env.<SUPABASE_ENV>` and `.env`, in `supabase/` and then the root. Also R: "An invalid config value or `SUPABASE_*` variable … now fails every command that loads config with `CliConfigValueError`."
The repo's root `.env` defines `SUPABASE_URL` and `SUPABASE_ANON_KEY` (names only were read). Neither is a documented CLI config variable. **Low risk, unverified.** The first v3 run will show a `CliConfigValueError` if not.
`SUPABASE_ACCESS_TOKEN` appears in no project env file, so the `env -u SUPABASE_ACCESS_TOKEN` recipe keeps working. With the shell variable unset, v3 reads `~/.supabase/access-token` (S `migration/list/SIDE_EFFECTS.md`: "when `SUPABASE_ACCESS_TOKEN` unset and the target is a remote project").

## 4. Edit list

**Now, v2-compatible (safe before the upgrade):**
1. `supabase/config.toml:54`: `[inbucket]` → `[local_smtp]` (keys unchanged). The owner of config.toml decides; peer 2 did not edit it.
2. CLAUDE.md:73: "`db push --dry-run` first" → "`db push --linked --dry-run` first (name the target: v3 defaults to the LOCAL stack)".
3. CLAUDE.md:79: append `--yes` to the deploy line. The flag is global in v2.119; v3 requires it unattended.
4. CLAUDE.md:108-109: add `--agent=yes` to the `db query` recipe: `env -u SUPABASE_ACCESS_TOKEN supabase db query --linked --agent=yes -o json "<select>"`. Add one line: "parse `Array.isArray(o) ? o : o.rows`".
5. Memories that quote `migration list` or `db query` recipes (e.g. `applyyy-supabase-cli-authenticated.md`): same changes. That is the orchestrator's call.

**With the upgrade (v3-only flags, same change):**
6. CLAUDE.md:108-109 and the SELECT recipes: add `--read-only`. Optionally `--linked` → `--remote`, which v4 will require.
7. CLAUDE.md §3: the real `db push --linked` gets `--yes`, and only after the dry-run was read (the §5a gate).
8. First v3 deploy: `rls-proof` first, as CLAUDE.md §3 already requires whenever import-map handling changes. That verifies `--use-api` + `--import-map` end to end.

**No change:** CI workflows, `scripts/deploy-drift.mjs`, `secrets list` usage.
