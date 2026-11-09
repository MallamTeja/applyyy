# Workday description backfill: measured, NOT built (2026-11-09)

**Status: recommendation awaiting the orchestrator. No code written, nothing moved, no live write.**
Brief: build a system job (script + workflow) that fills `jobs.description_raw` for Workday rows, starting with the
24 "D4" failed rows in `docs/status/2026-11-09-failed-rows.md`. The measurements below say the job would recover
**1 row today and ~0 rows a day going forward**. So I stopped before building it.

## What already exists (nothing new is needed for the read itself)

- `supabase/functions/_shared/scout/workday-detail.ts` (54ee8be, 2026-11-05) does the per-row work.
  `fillWorkdayDescriptions` reads `/wday/cxs/{tenant}/{site}/job/...` through the robots-gated GET (policy
  `scouting`), with a cap of 40 reads per run and a 500 ms pause between reads.
  - Shape check: `parseWorkdayDescription` (`adapters/workday.ts:138`) accepts only a JSON object with
    `jobPostingInfo.jobDescription` that still has text after `stripHtml`.
  - A soft-200 HTML page, a non-2xx response or a robots refusal all come back as "no description", never as text.
- Both scouts call it on insert: scout-ats (`scout-ats/index.ts:54`) and the worker scout (`worker/src/scout/persist-jobs.ts:24`).
- The 11-05 hand backfill was `worker/scripts/workday-backfill-preview.ts`. It wraps the same function: reads go
  through `fetchBoard`, it has no DB access, and the orchestrator ran the writes. 348 events carry
  `source = workday_backfill_2026_11_05`. **None of the 24 D4 rows has one.**
- `jobs.description_hash` is written by no scout. 0 of 387 described Workday rows have it. The only writer is the
  tombstone migration (`20261105200000_jobs_tombstone.sql:163`), which keeps a hash when it empties a dropped job. A
  backfill matching the scouts would leave it null.
- The app user may UPDATE `jobs`: policy "own jobs" (ALL, `auth.uid() = user_id`), and the column grant on
  `description_raw` is true.

## The probe (read-only GETs, 4 requests, through the repo's own `fetchBoard`)

| Row | robots.txt | Detail endpoint |
| --- | --- | --- |
| PayPal `R0138392` (paypal.wd1, site `jobs`) | 200, path allowed | **403** `application/json` |
| Barclays `JR-0000136329-1` (barclays.wd3) | 200, path allowed | **403** `application/json` |

These tenants do serve descriptions to the scout for live postings: PayPal 7 filled (last 2026-11-08 18:07 UTC),
Barclays 43 filled (last 2026-11-08 18:09 UTC). So a 403 on a specific posting matches Teja's 11-07 evidence for
FIS (`3424b639`): "workday detail 403 while 2 live FIS postings answer 200" means the posting is closed.

## Why the 24 have no description: 23 are gone from their boards

`jobs.last_seen_at` against the newest `last_seen_at` on the same host:

- **23 of 24 were last seen 4.5–7.5 days before their board's latest poll** (2026-11-08 17:57 / 2026-11-09 06:45 UTC).
  All 23 were last seen between 11-01 and 11-04, with `seen_count` 1–4.
- Only **`f3a0c6bf`** (Barclays) is still listed: last seen 2026-11-08 17:57, the same time as its board. It is
  the one row a read could recover.

## Is a recurring job needed for FUTURE rows? No, measured

Workday rows by `jobs.created_at`, with no description and dropped as `missing_description`:
11-05: 16 · 11-06: 2 · 11-07: 0 · 11-08: 0. No open row is missing one (`null_open` = 0 since 11-05).
The detail read on insert already covers new postings. The cap of 40 has not left a row behind in the last 3 days.

## Recommendation

1. **Do not build the system job now (YAGNI).** It would recover 1 row today and ~0 a day after.
   Build it when the `missing_description` drop count for new Workday rows goes above zero again.
   The query to watch is in the bridge file. The script + workflow design is ready: `fillWorkdayDescriptions` +
   `fetchBoard` + the jobs-tombstone shape (app-user sign-in, agent_runs row, batch cap).
2. **The 23 vanished postings:** leave them failed, as `posting_closed` with this evidence (last seen 4.5–7.5 days
   behind the board, detail 403). That is Teja's call, through the orchestrator.
3. **`f3a0c6bf`:** one read with the existing `worker/scripts/workday-backfill-preview.ts` (1 row in, the
   orchestrator writes `description_raw`), then the human edge `failed -> passed_filters`.
4. **Real gap found: `disappeared_at` is never set on these 23.** scout-ats does mark absences
   (`scout-ats/index.ts:715-726`, `planDisappearances`), but these rows are still `disappeared_at` null after 5–7
   days of polls without them. Either the planner refuses on Workday boards (paged list, so absence cannot be
   proven), or failed rows sit outside its snapshot. That is a separate investigation, and it is why D4 looked live
   in the failed-rows audit.
