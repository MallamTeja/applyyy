# Deploy drift: which edge functions run code older than `origin/main`

> **Status 2026-11-08:** Current. `scripts/deploy-drift.mjs` is unchanged since it was added (`git log -- scripts/deploy-drift.mjs`) and still removes `SUPABASE_ACCESS_TOKEN` itself (`scripts/deploy-drift.mjs:38`). The per-function deploy ledger (the second half of W37) is still not built, and no workflow runs the script, so run it by hand before each deploy session. The "17 functions" and first-run figures are from 2026-11-02; count today with `ls supabase/functions/*/index.ts` and re-run the script for the current table. The body below is the original record, unedited.

`scripts/deploy-drift.mjs` closes audit item **W37** (`docs/audit/2026-11-01-wiring-audit.md`).
Nothing records the commit each edge function was deployed from. A function's code is also
more than its own folder: it is every file its `index.ts` reaches through relative imports.
That includes `_shared/`, `packages/*/src` and sometimes `apps/web/src`.
`packages/shared-types/src/status-flow.ts` is runtime code, because `_shared/agent/status.ts`
calls `canTransition` from it. So an edit that looks like a "types" change can leave prod
running a different status graph from main.

The script is **read-only**. It runs `git` and `supabase functions list` and writes nothing.

## Run it

Run it from the repo root, in Bash or PowerShell:

```bash
git fetch origin main          # the script compares with origin/main; a stale copy hides drift
node scripts/deploy-drift.mjs  # no install: node builtins only
```

The script removes `SUPABASE_ACCESS_TOKEN` from the CLI's environment itself. That user env
var belongs to the wrong account and causes a 403 (CLAUDE.md §4), so you do not need to unset it.
It needs the Supabase CLI to be logged in to the right account. Check with
`env -u SUPABASE_ACCESS_TOKEN supabase functions list --project-ref xynqxekcqizwhtskzqrq`.

Run it **before every deploy session** (CLAUDE.md §3). A function with `commits_since > 0`
is missing that many commits. Redeploy it from a clean worktree pinned to the SHA you reviewed.

## Reading the output

The script prints three header lines and then a table:

- `origin/main = <sha> (<date>)`: the commit the script compared against. If that date is
  old, run `git fetch` and try again.
- `on main, never deployed`: function folders that have no live deployment.
- `live, not on main`: live functions whose source folder is gone from main.

Table columns:

| Column | Meaning |
|---|---|
| `v` | The live version number. It counts that function's deploys and says nothing about age (CLAUDE.md §3). |
| `deployed_ist` | `updated_at` from the CLI, shown in IST. |
| `closure` | How many files the function's import closure has, and how many of them are outside `supabase/functions/` (for example `packages/*`). |
| `commits_since` | The number of commits on `origin/main` that touch the closure and were committed after the deploy. This is the headline number. |
| `verify_jwt` | The live value compared with `supabase/config.toml` on main (the default is `true`). A mismatch is drift even when no commits are listed. |
| `unresolved` | The number of imports the walker could not resolve. If it is not zero, the closure is incomplete, so `commits_since` is only a lower bound. |

After the table, the script lists every commit for each drifted function. Each commit shows
the closure files it changed, so you can judge whether it matters (a comment-only change
still counts).

## Limits of the method

The script does not prove drift. It infers drift from commit times. Know the gaps before
you rely on a zero:

1. **It compares commit time with deploy time, because no SHA is recorded.** Suppose a
   commit was made before a deploy, and the deploy was pinned to an *older* SHA. That commit
   is invisible. The fix is a per-function deploy ledger that records the SHA at deploy
   time. That is the second half of W37 and it is not built.
2. **A deploy from a dirty working tree reads as clean.** The CLI ships the working tree,
   including peers' uncommitted edits (CLAUDE.md §3). The script cannot see that.
3. **It reads `origin/main` only.** It never reads the working tree, so peers' in-flight
   edits on this shared checkout do not appear.
4. **It finds imports with a regex.** A `from './x'` inside a comment also counts, which
   only makes the result over-report drift. It skips `npm:`, `jsr:` and `https:` imports,
   so a version bump of an external dependency does not show up.
5. **It checks only one `config.toml` key: `verify_jwt`.** Other per-function keys
   (`static_files`, `import_map`, `entrypoint`) are not compared. Commits that change
   `config.toml` are also left out of `commits_since`. One commit there would otherwise
   count against all 17 functions.

## First run: 2026-11-02 20:55 IST, `origin/main = 3a630f6`

All 17 live functions are on main, and none is missing. `verify_jwt` matches everywhere, and
no import was unresolved. Three functions had zero drift: `tailor` (deployed 2026-11-02 20:39),
`follow-up` and `gmail-sync`. `rls-proof` also had zero, because its closure is just its own
`index.ts`. The largest gaps were `auditor` (14 commits since 2026-10-09), `screener`
(7 commits since 2026-10-25) and `normalizer` (3 commits since 2026-10-08).
`3a630f6` changed `status-flow.ts`, and that file is in the closure of 12 live functions.
Only `tailor` was redeployed after that commit. Run the script again to get the current table.
