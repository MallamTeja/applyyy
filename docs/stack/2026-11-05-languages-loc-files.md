# Languages, lines of code and file counts

_Last verified against code: 2026-11-08 (2a9ac31)._

All numbers here are **as of 2026-11-08 at `2a9ac31`**. They go stale with every commit.

**Regenerate for today:** `node scripts/repo-stats.mjs` (defaults to `HEAD`).
**Regenerate exactly this page:** `node scripts/repo-stats.mjs 2a9ac31`.
The script reads git blobs, not the working copy. Several sessions edit this tree at once, and
two working-copy runs a few minutes apart gave different numbers. Uncommitted peer work is
excluded by design.

## Headline

| Measure | Value (as of 2026-11-08) |
|---|---|
| Tracked files | 883 |
| Hand-written code lines (non-blank, non-comment; excludes Markdown, JSON, lockfiles) | 106,187 |
| Non-blank lines: source vs tests | 117,044 source · 74,803 tests (tests = 39 %) |
| Logic files (`.ts .tsx .js .mjs .sql .css`) | 739 |
| Lines per logic file | mean 272, median 180; 96 files over 500 lines, 24 over 1,000 |
| Markdown (docs, READMEs) | 76 files |
| Generated (not counted as code) | `pnpm-lock.yaml`, `supabase/functions/deno.lock` |

## Language share (code lines only)

| Language | Files | Code | Comment | Share of code |
|---|---:|---:|---:|---:|
| TypeScript (`.ts`) | 589 | 77,550 | 66,701 | 73.0 % |
| TypeScript (`.tsx`, React UI) | 46 | 13,447 | 7,020 | 12.7 % |
| CSS | 28 | 6,517 | 2,632 | 6.1 % |
| SQL (migrations, snippets, tests) | 72 | 4,918 | 5,962 | 4.6 % |
| YAML (GitHub Actions + workspace) | 15 | 2,022 | 1,097 | 1.9 % |
| HTML (`index.html` + test fixtures) | 12 | 789 | 131 | 0.7 % |
| JavaScript (`.mjs` scripts) | 4 | 536 | 323 | 0.5 % |
| Google Apps Script (`email-tracker.gs`) | 1 | 337 | 406 | 0.3 % |
| TOML (`supabase/config.toml`) | 1 | 71 | 184 | 0.1 % |

**TypeScript is about 86 % of all code.** Three runtimes run it: the browser (Vite), Node
(worker, packages, Vercel function, tests) and Deno (edge functions). Markdown, JSON and
dotfiles are not code, so they are not in the share.

## By area (as of 2026-11-08)

| Area | Files | Src files | Test files | Code | Comment ÷ code |
|---|---:|---:|---:|---:|---:|
| `apps/web` (React console) | 270 | 142 | 127 | 45,192 | 0.64 |
| `supabase/functions` (Deno agents) | 252 | 143 | 107 | 30,430 | 0.92 |
| `worker` (Node + Playwright) | 116 | 58 | 57 | 14,356 | 0.83 |
| `packages/master-ingest` | 20 | 12 | 7 | 3,385 | 0.66 |
| `supabase/migrations` | 60 | 60 | 0 | 3,163 | 1.61 |
| `.github` (workflows) | 13 | 13 | 0 | 2,007 | 0.52 |
| `packages/resume-template` | 17 | 9 | 7 | 1,662 | 0.86 |
| `packages/shared-types` | 9 | 7 | 1 | 1,451 | 1.53 |
| `packages/master-pdf` | 14 | 10 | 4 | 1,246 | 0.50 |
| `packages/master-robots` | 13 | 9 | 4 | 973 | 0.89 |
| `api` (Vercel function) | 3 | 2 | 1 | 845 | 0.84 |
| `supabase/snippets` | 10 | 10 | 0 | 775 | 0.83 |
| `scripts` | 4 | 4 | 0 | 404 | 0.76 |
| `supabase/tests` | 1 | 0 | 1 | 187 | 0.89 |

`apps/web` is the largest area (about 43 % of code), then `supabase/functions` (about 29 %)
and `worker` (about 14 %).

### Comment density is a floor, not a verdict

The repo's comment rule asks for at least 1.00 comment lines per code line in source
(`CLAUDE.md` §8). The `Comment ÷ code` column **undercounts**. The script counts a line as a
comment only when the line *starts* with one, so `doThing(); // why` counts as code. Read
`apps/web` at 0.64 as "at least 0.64". It is not proof the rule is broken. To find real gaps,
run `/code-review` on a diff; it checks density per change.

## Largest files

The top of the list as of 2026-11-08. These are the review and refactor hot spots.

| Lines | File |
|---:|---|
| 2,538 | `apps/web/src/features/approval/ApprovalQueuePage.tsx` |
| 2,512 | `apps/web/src/features/settings/settings.css` |
| 1,558 | `packages/shared-types/src/tables.ts` |
| 1,478 | `supabase/functions/_shared/tailor/validator.test.ts` |
| 1,456 | `packages/master-ingest/src/reconcile.ts` |
| 1,406 | `worker/test/apply-one.test.ts` |
| 1,378 | `worker/test/claim-loop.test.ts` |
| 1,361 | `supabase/functions/resume-assist/assist.ts` |
| 1,287 | `apps/web/src/features/approval/aiEdit.ts` |
| 1,259 | `apps/web/src/features/settings/companyCatalog.ts` |
| 1,231 | `worker/src/playwright-page.ts` |
| 1,212 | `apps/web/src/features/discovery/DiscoveredJobsPage.tsx` |

`ApprovalQueuePage.tsx` is the largest file in the repo. The `approval` feature
(`ApprovalQueuePage.tsx`, `aiEdit.ts`, `DiffView.tsx`) is the strongest candidate for a split
if review cost grows. `DiffView.tsx` is 1,158 lines as of 2026-11-08 (it was 2,082 on
2026-11-05, before the queue redesign in commit `7211fd7`).

## Web feature folders

Regenerate: `git ls-files apps/web/src/features | awk -F/ '{print $5}' | sort | uniq -c`.
As of 2026-11-08 the folders are `settings`, `approval`, `discovery`, `pipeline`,
`manual-apply`, `applied`, `emails`, `health`, `resume-preview`, `analytics`, `auth`,
`followup`, `referral` and `profile`. What each one does is in
[2026-11-05-services-agents-modules.md](2026-11-05-services-agents-modules.md#appswebsrc-react-console).
