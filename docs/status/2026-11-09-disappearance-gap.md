# Why `jobs.disappeared_at` stayed null on vanished postings (2026-11-09)

**Status: cause found. It is historical; today's code is correct. No code change. An optional one-time back-fill
is prepared, NOT run.** Read-only measurement against the live DB, 17:30–18:05 IST.

## The count by ATS

"Stale" = a live row (`disappeared_at` null) whose `last_seen_at` is more than 2 days behind its board's
`last_polled_at`. These are rows on scout-ats boards (`company_watchlist`), matched on owner, provider, slug and the
adapter's `discovered_via`.

| ATS | Live rows | Stale, < 14 days | Stale, ≥ 14 days | Stale rows last seen on/after 2026-11-05 |
| --- | --- | --- | --- | --- |
| greenhouse | 14,472 | 2,071 | 420 | 33 (27 on 11-05, 6 on 11-06) |
| ashby | 7,165 | 936 | 40 | 9 |
| workday | 5,764 | 524 | 0 | **0** |
| lever | 1,116 | 52 | 4 | 3 |
| smartrecruiters | 124 | 5 | 0 | 0 |

**Workday: all 524 stale rows were last seen 11-01 to 11-04** (93 / 163 / 154 / 114). None was last seen later.

## Hypotheses tested

- **(a) The planner refuses on Workday's paged list. No.**
  - Workday reads are complete-or-fail by construction: `nextPageUrl` pages to page one's `total`, and the
    20-page cap fails the board instead of truncating it (`_shared/scout/adapters/workday.ts:21-25`).
  - Workday boards do mark rows. On PayPal and HPE, every row last seen on or after 11-05 was marked at the next poll
    (marks on 11-05 20:02, 11-06 06:56, 11-06 12:05, 11-06 19:29, 11-07 06:07, 11-07 11:02).
  - Of the 43 Workday boards with stale rows, only 3 have marked nothing in 7 days.
- **(b) Failed or dropped rows sit outside the snapshot. No.** The snapshot (`scout-ats/index.ts:476-487`) selects
  by owner, provider, slug and `discovered_via`, with no status filter.
- **(c) A threshold never trips. Yes, by design, for rows that missed their first absent poll.** The cause:
  1. **Before 2026-11-05**, `planDisappearances` judged every poll against the WHOLE stored set. A board carrying an
     old backlog overlapped below 0.5 and was refused as `identity_drift` on every poll (the GitLab case in
     `_shared/scout/liveness.ts:80-86`). So postings that closed then were never marked.
  2. **Since 2026-11-05** (leak 3, then `d4dbd88`), the guards judge only the rows the previous poll saw. A row
     OUTSIDE that set is marked only when its last sighting is ≥ 14 days older than the previous poll
     (`STALE_BACKLOG_MIN_AGE_MS`, `liveness.ts:98-105`). That bar is a deliberate safety control from the
     2026-11-05 security review: `last_polled_at` is written even on a refused poll, so a board that persistently
     truncates would otherwise mark its unlisted rows dead on its next poll. **It must stay.**
  3. So the rows that vanished from 10-26 to 11-04 are outside every basis since 11-05. They **mark themselves
     14 days after their last sighting**, i.e. between about 11-09 and 11-18. The 23 D4 Workday rows (last seen
     11-01 to 11-04) clear by 11-15 to 11-18.

The negative tests the brief asked for already exist and pass: `_shared/scout/liveness.test.ts:24-35` (a poll that
is not ok, a poll with write errors, and an empty poll each refuse, marking nothing).

## A real live gap found on the way: 2 boards refuse every poll

The latest poll of `xai` (Greenhouse) listed 298 postings but re-stamped **0** stored rows. The same is true of
`aiven` (0 of 44). Every poll there is refused as identity drift, so their ≥ 14-day backlog (`xai` 291 rows) can
never be marked. The fingerprints no longer match the stored rows. Separate parcel; not investigated.

## Optional one-time back-fill (prepared, NOT run)

This marks now what the 14-day bar would mark by ~11-18. Positive evidence for each row (CLAUDE.md §6): its board's
latest poll is recent (≤ 3 days) and **trusted by the planner's own rule** (that poll re-stamped ≥ 0.5 × the
postings it reported, `MIN_RECENT_SHARE_OF_PREVIOUS_POLL`), and the row has been absent from it for > 2 days since a
sighting before the 11-05 fix.

Excluded:
- `xai` and `aiven`, which fail the trust rule;
- rows with an application in the approval queue (`awaiting_approval`, `approved`, `applying`,
  `blocked_needs_human`). Queue liveness confirms those through the posting endpoint and writes a reason event.

Preview (17:58 IST): **3,581 rows**: greenhouse 2,053, ashby 951, workday 524, lever 53. 248 boards trusted, 2
refused. All 23 vanished D4 rows are included; `f3a0c6bf` (seen on 11-08) is not.

```sql
-- One-time back-fill (2026-11-09): mark postings that vanished before the 2026-11-05 liveness fix, which the
-- 14-day backlog bar would otherwise hold live until ~11-18. Evidence per row: absent > 2 days from its board's
-- latest poll, and that poll is trusted by the planner's own rule (re-stamped >= half of what it reported).
with b as (
  -- Boards polled in the last 3 days that reported postings.
  select w.user_id, w.ats_provider, w.company_slug, w.last_polled_at, w.last_poll_job_count,
    -- The discovered_via value each adapter writes (Workday's adapter reports company_career_page).
    case w.ats_provider when 'workday' then 'company_career_page' else w.ats_provider::text end src
  from company_watchlist w
  where w.last_polled_at >= now() - interval '3 days' and w.last_poll_job_count > 0
), seen as (
  -- How many stored rows the latest poll re-stamped (within the planner's 15-minute tolerance).
  select b.*, (select count(*) from jobs j where j.user_id = b.user_id and j.ats_provider = b.ats_provider
      and j.company_slug = b.company_slug and j.discovered_via @> array[b.src]::discovery_source[]
      and j.disappeared_at is null and j.last_seen_at >= b.last_polled_at - interval '15 minutes') seen_last
  from b
), cand as (
  -- Live rows on trusted boards, last seen before the fix and absent > 2 days, outside the approval queue.
  select j.id
  from seen s join jobs j on j.user_id = s.user_id and j.ats_provider = s.ats_provider
    and j.company_slug = s.company_slug and j.discovered_via @> array[s.src]::discovery_source[]
  where s.seen_last >= 0.5 * s.last_poll_job_count
    and j.disappeared_at is null
    and j.last_seen_at < '2026-11-05T00:00:00Z'
    and j.last_seen_at < s.last_polled_at - interval '2 days'
    and not exists (select 1 from applications a where a.job_id = j.id
                    and a.status in ('awaiting_approval', 'approved', 'applying', 'blocked_needs_human'))
)
-- `disappeared_at is null` again, so a scout run that marked a row meanwhile keeps its own timestamp.
update jobs set disappeared_at = now()
where id in (select id from cand) and disappeared_at is null;
-- Expect about 3,581 rows (the preview count); a very different number means stop and re-measure.
```

**Recommendation:** run the back-fill only if dead rows must stop looking live before ~11-18 (the tailor skip, the
tombstone, audits). Otherwise do nothing: the system clears them on its own, and the queue rows are already covered
by queue liveness. Separately, open a parcel for the `xai` and `aiven` identity drift.
