# Harvest docs

_Last verified against code: 2026-11-08 (2a9ac31)._

This folder holds two kinds of record:

- **Harvest of an external codebase.** What we examined in `MadsLorentzen/ai-job-search`,
  what we decided to port, and the briefs peers built from.
- **Job-board coverage.** Which ATS boards we probed, how, and what we found.

Every file except this one is a **dated record**. Its body is not rewritten. A
`Status 2026-11-08` banner under each H1 says what changed since and where the current
truth lives. This README is the living index.

## Current state in one table

| Topic | Where the truth is now |
|---|---|
| ATS adapters that are polled | `supabase/functions/_shared/ats/registry.ts` (the `ADAPTERS` map): `greenhouse`, `lever`, `ashby`, `workday` |
| SmartRecruiters | **OFF** by the 2026-11-01 robots ruling: its robots.txt is `Disallow: /`. Unregistered in fc5097f, adapter deleted in 2fe0264. Pinned by the test `smartrecruiters is not registered` in `supabase/functions/_shared/ats/adapters.test.ts`, and on the web by `apps/web/test/smartRecruitersNotAddable.test.ts` |
| Workable | Adapter written (`supabase/functions/_shared/scout/adapters/workable.ts`), **not** registered (`registry.ts` comment) |
| Workday | Adapter `supabase/functions/_shared/scout/adapters/workday.ts`; descriptions read by `supabase/functions/_shared/scout/workday-detail.ts`; the bot does not apply to Workday jobs (`worker/src/workday.ts` parks them for Manual apply) |
| Robots gate | `packages/master-robots/` (`checkRobots`). Design records: `docs/robots/` |
| Shared HTTP transport | `supabase/functions/_shared/http/` (`createHttpClient` in `index.ts`) |
| Fit scoring | `supabase/functions/_shared/match/rubric.ts`, `scorer.ts`; pass floor in `score-threshold.ts` |
| Salary gate | `supabase/functions/_shared/match/salary-gate.ts` is written and tested, but no runtime code calls it |

### Live coverage: regenerate, never copy

Board counts change with every seed. Read them live instead of trusting a number here
(read-only; run in Git Bash):

```bash
env -u SUPABASE_ACCESS_TOKEN supabase db query --linked \
  "select ats_provider, enabled, count(*) from company_watchlist group by 1,2 order by 1,2"
```

As of 2026-11-08 every `smartrecruiters` row is `enabled = false`, and some dead
`greenhouse` rows are disabled too (2026-11-01). Seed scripts live in
`supabase/snippets/*seed-watchlist*.sql`; they are run by hand, never by CI.

## Records in this folder

### Harvest of `ai-job-search` (2026-09-16)

| Doc | What it is | Status |
|---|---|---|
| [2026-09-16-ai-job-search-inventory.md](2026-09-16-ai-job-search-inventory.md) | Per-file verdicts on upstream: portal adapters, Python tools, prompt skills, command specs. Also what upstream lacks that we have, so nobody "harvests" a downgrade | Historical |
| [2026-09-16-ai-job-search-harvest-plan.md](2026-09-16-ai-job-search-harvest-plan.md) | Eight write-partitioned parcels (P1-P8), ordered by value / cost, plus the open questions | Partly superseded |
| [2026-09-16-approach-comparison.md](2026-09-16-approach-comparison.md) | Area-by-area: which design is better, ours or upstream's | Partly superseded |

### Briefs built from the harvest plan (`briefs/`)

| Brief | Plan parcel | Shipped? | Where in code |
|---|---|---|---|
| [brief-1-http-retry.md](briefs/brief-1-http-retry.md) | P1 | Yes (23d9abf) | `supabase/functions/_shared/http/` |
| [brief-2-freehire-job-source.md](briefs/brief-2-freehire-job-source.md) | P6 | No, never built | none |
| [brief-3-job-scoring-and-salary-gate.md](briefs/brief-3-job-scoring-and-salary-gate.md) | P3 | Rubric yes (b15d8e7); salary gate written, not wired (5751184) | `supabase/functions/_shared/match/` |
| [brief-4-robots-gate.md](briefs/brief-4-robots-gate.md) | P2 | Yes (4ca08ef); apply-time gate a3b4115 | `packages/master-robots/` |
| [brief-5-resume-node-selection.md](briefs/brief-5-resume-node-selection.md) | P7 | In part: keyword relevance only; the four auditor rules were not built | `supabase/functions/_shared/tailor/jd-keywords.ts`, `tailorer.ts`, `page-trim.ts` |

The brief number is a file index, not the plan's parcel number.

### Board coverage

| Doc | What it is | Status |
|---|---|---|
| [../watchlist/2026-09-17-board-token-verification.md](../watchlist/2026-09-17-board-token-verification.md) | First token check of 65 companies, with three adapters | Superseded |
| [2026-10-23-watchlist-expansion.md](2026-10-23-watchlist-expansion.md) | New greenhouse/lever/ashby boards, each verified by one live GET | Historical |
| [2026-10-24-board-reprobes.md](2026-10-24-board-reprobes.md) | Re-probe of four dead or empty boards | Partly superseded (its SmartRecruiters verdict is moot) |
| [2026-11-01-workday-coverage.md](2026-11-01-workday-coverage.md) | Workday boards verified live, and the quirks the adapter is built around | Partly superseded |

## Rules for this folder

- **Verify a token from the company's own careers page.** A name-guessed token is not
  evidence. A 200 can be the wrong company (greenhouse `tcs` is Thornbury), so check
  identity too.
- **A probe must be able to fail.** Run a garbage token first and see it fail, as each
  coverage record does.
- **Robots first.** Do not seed boards on a provider whose robots.txt disallows the read.
  SmartRecruiters is off for that reason.
- **One file per pass, date-prefixed.** Do not edit an old record's body; add a new
  record and update this index.

## Sources

| Source | Pinned at | Licence | Local path |
|---|---|---|---|
| [`MadsLorentzen/ai-job-search`](https://github.com/MadsLorentzen/ai-job-search) | `968fb1bd` (2026-09-16) | MIT, © 2026 Mads Lorentzen | `reference/ai-job-search-upstream/` (gitignored) |

**Attribution rule:** anything ported carries a header naming the upstream file and
commit (example: `supabase/functions/_shared/http/transport.ts:1`). MIT requires the
copyright and permission notices to stay. The header also tells the next reader where to
look when upstream fixes a bug we inherited. Port ideas; never copy code wholesale.
