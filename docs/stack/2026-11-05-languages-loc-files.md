# Languages, lines of code and file counts — snapshot 2026-11-05

**Dated record — never edited.** Measured at commit `00ecabb01ff8f5e7ca2e25b799cecd5d93f18791`
(`main`, 2026-11-05 00:07 IST). Uncommitted peer work (for example `apps/web/src/features/applied/`)
is excluded by design.

**Regenerate exactly:** `node scripts/repo-stats.mjs 00ecabb` gives this output byte for byte.
**Regenerate for today:** `node scripts/repo-stats.mjs` (defaults to `HEAD`).
The script reads git blobs, not the working copy. Several sessions edit this tree at once, and two
working-copy runs a few minutes apart gave different numbers.

## Headline

| Measure | Value |
|---|---|
| Tracked files | **733** |
| Hand-written code lines (non-blank, non-comment; excludes Markdown, JSON, lockfiles) | **92,449** |
| Comment lines in those languages | **71,309** |
| Non-blank lines: source vs tests | **105,412** source · **59,383** tests (tests = **36 %**) |
| Logic files (`.ts .tsx .js .mjs .sql .css`) | **609** |
| Lines per logic file ("LOF") | mean **283**, median **188**; **85** files > 500 lines, **21** > 1,000 |
| Markdown (docs, READMEs) | **67** files, **23,822** lines |
| Generated (not counted as code) | `pnpm-lock.yaml` 2,046 lines, `supabase/functions/deno.lock` 101 lines |
| Commits on `main` | **478**; first commit 2025-12-29 |

"LOF" is read here as **lines per file**. The request did not define it.

## Language share (code lines only)

| Language | Files | Code | Comment | Blank | Share of code |
|---|---:|---:|---:|---:|---:|
| TypeScript (`.ts`) | 477 | 65,523 | 55,786 | 10,139 | **70.9 %** |
| TypeScript (`.tsx`, React UI) | 42 | 12,648 | 5,943 | 1,228 | **13.7 %** |
| CSS | 27 | 6,574 | 2,437 | 1,165 | **7.1 %** |
| SQL (migrations, snippets, tests) | 61 | 4,484 | 5,420 | 766 | **4.9 %** |
| YAML (GitHub Actions) | 14 | 1,870 | 999 | 169 | **2.0 %** |
| HTML (`index.html` + test fixtures) | 6 | 629 | 64 | 43 | 0.7 % |
| JavaScript (`.mjs` scripts) | 2 | 344 | 120 | 58 | 0.4 % |
| Google Apps Script (`email-tracker.gs`) | 1 | 310 | 372 | 30 | 0.3 % |
| TOML (`supabase/config.toml`) | 1 | 67 | 168 | 29 | 0.1 % |
| **Total** | | **92,449** | | | 100 % |

**TypeScript is 84.6 % of all code.** Three runtimes run it: the browser (Vite), Node (worker,
packages, Vercel function) and Deno (edge functions). Not code, so not in the share: Markdown
(67 files), JSON (27), dotfiles (`.gitattributes` ×3, `.gitignore`, `.npmrc`,
`apps/web/.env.example`, `apps/web/.env.e2e`).

## By area

| Area | Files | Src files | Test files | Code | Comment | Comment ÷ code | Markdown lines |
|---|---:|---:|---:|---:|---:|---:|---:|
| `apps/web` (React console) | 209 | 124 | 84 | 38,996 | 22,964 | 0.59 | 362 |
| `supabase/functions` (Deno agents) | 219 | 129 | 88 | 26,747 | 24,314 | 0.91 | 270 |
| `worker` (Node + Playwright) | 86 | 43 | 42 | 11,546 | 9,596 | 0.83 | 242 |
| `packages/master-ingest` | 20 | 12 | 7 | 3,385 | 2,218 | 0.66 | 375 |
| `supabase/migrations` | 50 | 50 | 0 | 2,818 | 4,591 | 1.63 | 0 |
| `.github` (workflows) | 12 | 12 | 0 | 1,855 | 938 | 0.51 | 0 |
| `packages/shared-types` | 9 | 7 | 1 | 1,409 | 2,127 | 1.51 | 941 |
| `packages/resume-template` | 15 | 8 | 6 | 1,401 | 1,141 | 0.81 | 185 |
| `packages/master-pdf` | 14 | 10 | 4 | 1,246 | 618 | 0.50 | 0 |
| `packages/master-robots` | 13 | 9 | 4 | 973 | 869 | 0.89 | 0 |
| `api` (Vercel function) | 3 | 2 | 1 | 845 | 709 | 0.84 | 0 |
| `supabase/snippets` | 10 | 10 | 0 | 775 | 644 | 0.83 | 0 |
| `docs` | 59 | 1 | 0 | 766 | 78 | 0.10 | 20,141 |
| root files | 11 | 7 | 0 | 379 | 61 | 0.16 | 1,306 |
| `supabase/tests` | 1 | 0 | 1 | 187 | 167 | 0.89 | 0 |
| `scripts` | 1 | 1 | 0 | 91 | 106 | 1.16 | 0 |
| `supabase/config.toml` | 1 | 1 | 0 | 67 | 168 | 2.51 | 0 |

Share of all code: `apps/web` 42 %, `supabase/functions` 29 %, `worker` 12 %, the five
`packages/*` together 9 %, the rest 8 %.

### Comment density is a floor, not a verdict

The repo's comment rule asks for ≥ 1.00 comment lines per code line in source (`CLAUDE.md` §8). The
`Comment ÷ code` column **undercounts**. The script counts a line as a comment only when the line
*starts* with one, so `doThing(); // why` counts as code. Read `apps/web` at 0.59 as "at least
0.59". It is not proof the rule is broken. To find real gaps, run `/code-review` on a diff; it
checks density per change.

## Largest files (refactor and review hot spots)

| Lines | File |
|---:|---|
| 2,528 | `apps/web/src/features/settings/settings.css` |
| 2,247 | `apps/web/src/features/approval/ApprovalQueuePage.tsx` |
| 2,082 | `apps/web/src/features/approval/DiffView.tsx` |
| 1,483 | `packages/shared-types/src/tables.ts` |
| 1,456 | `packages/master-ingest/src/reconcile.ts` |
| 1,455 | `packages/master-ingest/test/reconcile.test.ts` |
| 1,415 | `supabase/functions/_shared/tailor/validator.test.ts` |
| 1,372 | `worker/test/apply-one.test.ts` |
| 1,361 | `supabase/functions/_shared/gemini/client.test.ts` |
| 1,341 | `apps/web/src/features/approval/DiffView.css` |
| 1,324 | `apps/web/src/features/settings/companyCatalog.ts` |
| 1,246 | `worker/test/claim-loop.test.ts` |
| 1,241 | `apps/web/test/e2eSuite.test.ts` |
| 1,236 | `apps/web/src/features/approval/aiEdit.ts` |
| 1,200 | `apps/web/src/features/discovery/DiscoveredJobsPage.tsx` |

The `approval` feature holds three of the four largest web files. It is the strongest candidate
for a split if review cost grows.

## Web feature folders (file counts at `00ecabb`)

`settings` 20 · `approval` 16 · `discovery` 11 · `pipeline` 11 · `health` 4 · `manual-apply` 4 ·
`emails` 3 · `resume-preview` 3 · `analytics` 2 · `auth` 2 · `followup` 2 · `referral` 2 ·
`profile` 1. Regenerate: `git ls-files apps/web/src/features | awk -F/ '{print $5}' | sort | uniq -c`.
