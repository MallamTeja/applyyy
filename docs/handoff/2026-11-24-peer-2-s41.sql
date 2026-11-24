-- S41 / S41b live statements (peer 2, 2026-11-24 ~12:50 IST). PREPARED, NOT RUN. The orchestrator runs them,
-- one at a time, reading each result before the next, and only after Teja's own "S41 ok" in the orch window
-- (relay rule, CLAUDE.md §2). Tell Teja to stay off /approvals and the Discovered page until S41-5 is read.
--
-- Live state read 2026-11-24 12:45 IST (SELECT only): gone rows = jobs.disappeared_at is not null
--   passed_filters 91 total, 20 gone (the pending list's "22" is stale: re-count, never write a number)
--   awaiting_approval 23 total, 1 gone  -> FactSet SRE 66f87b75 (gone 2026-11-20)
--   approved 6 total, 1 gone            -> Commvault 5daf4908 (gone 2026-11-17)
-- Edges (application_status_transitions, read live): passed_filters->dropped_filter {matcher,human};
--   awaiting_approval->dropped_filter {human,auditor}; approved->failed {human}. Way back for every move:
--   dropped_filter->passed_filters {human}, failed->passed_filters {human}. So every write here is reversible.
--
-- CAVEAT for the orch: 19 of the 20 ready rows are Workday, gone since 11-05..11-14, yet were moved INTO
--   passed_filters by the human bulk move 11-23 16:05Z. If Workday disappearance detection false-positives
--   (a capped listing page), some are still live. They stay recoverable via the human edge back.
--
-- Every move uses p_expected_updated_at = the row's own updated_at read IN THE SAME STATEMENT, so a row that
-- moved since the precheck is refused (PT409) instead of being written blind. A PT409 aborts that statement:
-- re-run its precheck, then the statement.
-- Detail: reason + drop_reason = 'posting_closed' (the value the approval page's PostingGoneNotice Reject
-- sends), source names this run so S41-4 and any undo can find exactly these rows by event.

-- S41-0  PRECHECK. EXPECT now: passed_filters 20, awaiting_approval 1, approved 1. Write the numbers down:
--        they are the "matched" counts for the report.
select a.status, count(*) as gone_rows
  from public.applications a
  join public.jobs j on j.id = a.job_id
 where j.disappeared_at is not null
   and a.status in ('passed_filters', 'awaiting_approval', 'approved')
 group by a.status
 order by a.status;

-- S41-1  (a) every gone passed_filters row -> dropped_filter, as human. Re-counted at run time by the WHERE.
--        EXPECT: one row per moved application, count = S41-0's passed_filters number.
select r.id, (public.advance_application_status(
         r.id, 'dropped_filter', 'human',
         jsonb_build_object('reason', 'posting_closed', 'drop_reason', 'posting_closed',
                            'source', 'orch_sql_S41', 'ruling', 'Teja 2026-11-24 11:08: rm all that 22'),
         r.updated_at)).status as new_status
  from (select a.id, a.updated_at
          from public.applications a
          join public.jobs j on j.id = a.job_id
         where a.status = 'passed_filters'
           and j.disappeared_at is not null) r;

-- S41-2  (b) FactSet SRE out of the approval queue -> dropped_filter. Guarded by status + gone + its stamp
--        (2026-11-11 13:32:11.272647+00 at prep). Peer 3's re-tailor may have rewritten it since: if this
--        returns 0 rows, re-read its updated_at and ask peer 3 before re-running. EXPECT: 1 row.
select r.id, (public.advance_application_status(
         r.id, 'dropped_filter', 'human',
         jsonb_build_object('reason', 'posting_closed', 'drop_reason', 'posting_closed',
                            'source', 'orch_sql_S41', 'ruling', 'Teja 2026-11-24 11:08: rm it from approval queue'),
         r.updated_at)).status as new_status
  from (select a.id, a.updated_at
          from public.applications a
          join public.jobs j on j.id = a.job_id
         where a.id = '66f87b75-89b1-4f99-88c1-8f91db43cfd8'::uuid
           and a.status = 'awaiting_approval'
           and j.disappeared_at is not null) r;

-- S41-3  (c) Commvault approved -> failed (the only human edge out of approved). failed REQUIRES p_detail.reason
--        (migration 20261109180000), which becomes applications.failure_reason. Stamp at prep:
--        2026-11-23 10:59:43.545553+00. Run BEFORE the next apply.yml run, or the worker may try to submit it.
--        EXPECT: 1 row, failed.
select r.id, (public.advance_application_status(
         r.id, 'failed', 'human',
         jsonb_build_object('reason', 'posting_closed', 'source', 'orch_sql_S41',
                            'ruling', 'Teja 2026-11-24 11:08: rm gone jobs'),
         r.updated_at)).status as new_status
  from (select a.id, a.updated_at
          from public.applications a
          join public.jobs j on j.id = a.job_id
         where a.id = '5daf4908-4a17-422f-89b1-097b73430ec3'::uuid
           and a.status = 'approved'
           and j.disappeared_at is not null) r;

-- S41-4  OPTIONAL: also set the drop_reason COLUMN on the rows S41-1/S41-2 dropped, so the Discovered page's
--        dropped view groups them as posting_closed (human rejects otherwise leave it null: 503 such rows live).
--        Status is unchanged, so the transition guard does not fire. Keyed on THIS run's events only.
--        EXPECT: written = S41-1 rows + S41-2 rows.
update public.applications a
   set drop_reason = 'posting_closed'
 where a.status = 'dropped_filter'
   and a.drop_reason is null
   -- advance_application_status writes p_detail into a separate 'note' event (to_status is null there), so key on
   -- the note's source, and require the row to be dropped_filter NOW (S41-3's failed row is excluded by status).
   and exists (select 1 from public.application_events e
                where e.application_id = a.id
                  and e.event_type = 'note'
                  and e.detail->>'source' = 'orch_sql_S41')
returning a.id;

-- S41-5  POSTCHECK. EXPECT: no row for passed_filters / awaiting_approval / approved (gone = 0 in each),
--        unless a scout marked a NEW posting gone between S41-1 and now (then it is S40's read filter's job).
select a.status, count(*) as gone_rows
  from public.applications a
  join public.jobs j on j.id = a.job_id
 where j.disappeared_at is not null
   and a.status in ('passed_filters', 'awaiting_approval', 'approved')
 group by a.status;
-- And the written count: rows carrying this run's note event, grouped by where they sit now.
-- EXPECT dropped_filter = S41-1 + S41-2 rows, failed = 1.
select a.status, count(distinct a.id)
  from public.application_events e
  join public.applications a on a.id = e.application_id
 where e.event_type = 'note' and e.detail->>'source' = 'orch_sql_S41'
 group by 1;

-- UNDO (only if Teja asks): per row, the human edge back, e.g.
-- select public.advance_application_status('<id>'::uuid, 'passed_filters', 'human', '{"source":"orch_sql_S41_undo"}'::jsonb);
