-- Run 2026-11-06 00:41 IST by orchestrator: 19 moved, 19 notes, xAI scored.
-- -----------------------------------------------------------------------------
-- Scored-leak retro drop, 2026-11-06 (P1 #7). LIVE WRITES: the orchestrator runs them, one block
-- per call, in order, reading each result before the next. STMT 1+2 is ONE call (one transaction).
--
-- WHY THIS EXISTS. 19 rows reached `scored` although the gates reject them on experience. They
-- were revived by the 11-05 Workday back-fill with no re-screen, and two gate holes hid their
-- years ("7&#43; years" not decoded; bare title ranges like "4 to 8yrs" unread), fixed in 1bf142a.
-- The pre-gate sweep (pregate-sweep.yml, run 42090382461) reads `passed_filters` only, so it could
-- not reach them. Teja ruled at 2026-11-06 00:34 IST: drop the 19 scored leaks, KEEP xAI 0c9fdc58.
--
-- HOW THE SET WAS MADE. A SELECT snapshot of all 87 `scored` rows, run through the deployed code
-- (acfe111): the real loadPreGatePreferences fed Teja's live config, then firstPreGateDrop. 19 drop
-- on experience_ceiling, 1 on work_auth (xAI 0c9fdc58, discovered_via {greenhouse,manual}). xAI is
-- NOT in this file: it is human-picked, and the auditor's re-gate already skips human-picked rows
-- (auditor/pregate.ts, isHumanPicked), so Teja's keep is honoured with no code change.
--
-- WHY `human`. The live graph allows scored -> dropped_filter for `human` only. Teja made the call.
--
-- PINNED BY ID. Every statement is limited to these 19 ids AND to status `scored`, so a row that
-- moved since the snapshot (tailored by a run in between) is skipped, never dragged back.
-- RE-RUNNABLE: a second pass finds nothing at `scored` and changes nothing.
-- -----------------------------------------------------------------------------

-- STMT 0 (read-only): the pre-count. Expect at_scored = 19, human_picked = 0, elsewhere = 0.
-- If at_scored < 19, the difference has moved on (read where with the second query); stop and
-- report rather than widen the set.
with ids(id) as (values
  ('df3e57be-3637-4eda-9188-747cbe58e213'::uuid), -- CrowdStrike | Software Developer - Network Automation
  ('045e5be9-018d-4a7a-be0f-6dc0b2f1d1a9'::uuid), -- HPE | Data Scientist
  ('0e393356-3122-456e-ab52-54f38507b6d3'::uuid), -- HPE | AI/ML Data Engineer
  ('cf93b522-b627-4d11-9771-fc8fd99ce941'::uuid), -- HPE | Systems/Software Engineer- Software Update QA
  ('110d0599-877b-44ec-92d5-5564a856cd71'::uuid), -- HPE | Cloud Software Engineer
  ('95892e07-45e9-42ec-a3dc-cf5a31ea82dd'::uuid), -- HPE | Full Stack Developer - Digital Experience & Automation (DEA)
  ('2d5e6a57-cf1a-4f72-b4d2-a5aae6a21fa4'::uuid), -- Boeing | Associate Software Developer - Java Full Stack
  ('c68f2e96-bd85-4558-94d9-2cc23a522961'::uuid), -- 3M | Data Engineer
  ('87fc8bfc-a279-4567-8ca6-37cda24a1134'::uuid), -- Barclays | Forward Deployed Software Engineer
  ('b954479e-c438-491e-b3b8-b6f539207d04'::uuid), -- Cisco | Technical Systems Engineer (Full-Stack) - Splunk
  ('b76404c8-47c3-46f7-b7fb-566645260db6'::uuid), -- Cisco | Data Engineer
  ('5c0ef767-8372-45bf-ba65-b5079b66bfa1'::uuid), -- Cisco | Software Engineer - Go, Java Dockers, Kubernetes, AWS
  ('2c306b0c-28a8-4acf-85b2-9e1c61043f80'::uuid), -- Cisco | Forward Deployed Engineer
  ('97376a4d-262e-4006-9190-e1c2e104addd'::uuid), -- Cisco | Cloud Engineer - 4 to 8yrs - Java, Python, ...
  ('80cd941b-1286-46e3-a009-de5a6d801cec'::uuid), -- Cisco | Software Engineer - Backend, ... Cloud- 4+ Years
  ('d9cf8f84-d466-4643-bd66-f122a63ab8f8'::uuid), -- Cisco | AI CX Solutions Consultant - 5+yrs - ...
  ('2bdd8373-d6f6-45b5-a09a-0ad418a01405'::uuid), -- Cisco | Software Security Engineer
  ('c2c84361-6b8a-442c-82f9-6b859d8a5d0f'::uuid), -- Cisco | Software Engineer - Cloud Native BNG Solution Testing, ...
  ('88f7f6b6-678d-46e9-afcb-c73841f410a8'::uuid)  -- Visa | Data Scientist - Visa Consulting & Analytics
)
select count(*) filter (where a.status = 'scored') as at_scored,
       count(*) filter (where 'manual' = any(j.discovered_via)) as human_picked,
       count(*) filter (where a.status <> 'scored') as elsewhere,
       count(*) as found
  from ids join public.applications a on a.id = ids.id join public.jobs j on j.id = a.job_id;

-- STMT 1+2 (write, ONE call): stamp the reason, then move the stamped rows, in one transaction,
-- so a tailor run cannot take a stamped row between the two (the stamp holds the row locks), and
-- a PT409 rolls both back. Two statements, not one CTE: the function's own update would not see
-- a stamp written by the same command (2026-10-25 retro, same reasoning).
begin;

-- STMT 1 (write): stamp drop_reason first, so log_status_change copies it into the move's event.
-- A same-status UPDATE passes guard_status_transition; drop_reason is not a frozen column.
update public.applications a
   set drop_reason = 'experience_ceiling'
 where a.id in (
   'df3e57be-3637-4eda-9188-747cbe58e213', '045e5be9-018d-4a7a-be0f-6dc0b2f1d1a9',
   '0e393356-3122-456e-ab52-54f38507b6d3', 'cf93b522-b627-4d11-9771-fc8fd99ce941',
   '110d0599-877b-44ec-92d5-5564a856cd71', '95892e07-45e9-42ec-a3dc-cf5a31ea82dd',
   '2d5e6a57-cf1a-4f72-b4d2-a5aae6a21fa4', 'c68f2e96-bd85-4558-94d9-2cc23a522961',
   '87fc8bfc-a279-4567-8ca6-37cda24a1134', 'b954479e-c438-491e-b3b8-b6f539207d04',
   'b76404c8-47c3-46f7-b7fb-566645260db6', '5c0ef767-8372-45bf-ba65-b5079b66bfa1',
   '2c306b0c-28a8-4acf-85b2-9e1c61043f80', '97376a4d-262e-4006-9190-e1c2e104addd',
   '80cd941b-1286-46e3-a009-de5a6d801cec', 'd9cf8f84-d466-4643-bd66-f122a63ab8f8',
   '2bdd8373-d6f6-45b5-a09a-0ad418a01405', 'c2c84361-6b8a-442c-82f9-6b859d8a5d0f',
   '88f7f6b6-678d-46e9-afcb-c73841f410a8'
 )
   -- Only rows still at scored; one tailored since the snapshot is left alone.
   and a.status = 'scored'
   -- Not stamped yet: the re-run condition.
   and a.drop_reason is distinct from 'experience_ceiling';

-- STMT 2 (write): move every stamped row through the sanctioned path, with the stale-read gate on.
with moved as materialized (
  select public.advance_application_status(
           a.id,
           'dropped_filter',
           'human',
           jsonb_build_object(
             'reason', 'experience_ceiling',
             'decided_by', 'Teja 2026-11-06 00:34 IST',
             'source', 'docs/screener/2026-11-06-scored-leak-retro.sql'
           ),
           -- Read after stmt 1's stamp moved updated_at; a row changed since raises PT409.
           a.updated_at
         ) as r
    from public.applications a
   -- The same 19 ids, stamped and still at scored.
   where a.id in (
     'df3e57be-3637-4eda-9188-747cbe58e213', '045e5be9-018d-4a7a-be0f-6dc0b2f1d1a9',
     '0e393356-3122-456e-ab52-54f38507b6d3', 'cf93b522-b627-4d11-9771-fc8fd99ce941',
     '110d0599-877b-44ec-92d5-5564a856cd71', '95892e07-45e9-42ec-a3dc-cf5a31ea82dd',
     '2d5e6a57-cf1a-4f72-b4d2-a5aae6a21fa4', 'c68f2e96-bd85-4558-94d9-2cc23a522961',
     '87fc8bfc-a279-4567-8ca6-37cda24a1134', 'b954479e-c438-491e-b3b8-b6f539207d04',
     'b76404c8-47c3-46f7-b7fb-566645260db6', '5c0ef767-8372-45bf-ba65-b5079b66bfa1',
     '2c306b0c-28a8-4acf-85b2-9e1c61043f80', '97376a4d-262e-4006-9190-e1c2e104addd',
     '80cd941b-1286-46e3-a009-de5a6d801cec', 'd9cf8f84-d466-4643-bd66-f122a63ab8f8',
     '2bdd8373-d6f6-45b5-a09a-0ad418a01405', 'c2c84361-6b8a-442c-82f9-6b859d8a5d0f',
     '88f7f6b6-678d-46e9-afcb-c73841f410a8'
   )
     and a.status = 'scored'
     and a.drop_reason = 'experience_ceiling'
)
-- Reading (r).id forces every call; the count is the number moved.
select count((r).id) as moved from moved;

commit;

-- STMT 3 (read-only, the proof): expect dropped = 19 (or STMT 0's at_scored), notes = the same
-- number, and xAI 0c9fdc58 still at scored.
-- TWO EVENTS PER MOVE: advance_application_status writes a `status_change` event (from/to set,
-- detail = the column snapshot, NO `source`) and a separate `note` event (from/to NULL, detail =
-- p_detail, which carries `source`). So count the notes by `source` alone, per application. The
-- first version also required to_status = 'dropped_filter', which no note has: it returned 0 on
-- the real run (orchestrator, 00:41 IST).
select
  (select count(distinct e.application_id) from public.application_events e
    where e.detail->>'source' = 'docs/screener/2026-11-06-scored-leak-retro.sql') as notes,
  (select count(*) from public.applications a
    where a.drop_reason = 'experience_ceiling' and a.status = 'dropped_filter'
      and a.id in ('df3e57be-3637-4eda-9188-747cbe58e213', '045e5be9-018d-4a7a-be0f-6dc0b2f1d1a9',
        '0e393356-3122-456e-ab52-54f38507b6d3', 'cf93b522-b627-4d11-9771-fc8fd99ce941',
        '110d0599-877b-44ec-92d5-5564a856cd71', '95892e07-45e9-42ec-a3dc-cf5a31ea82dd',
        '2d5e6a57-cf1a-4f72-b4d2-a5aae6a21fa4', 'c68f2e96-bd85-4558-94d9-2cc23a522961',
        '87fc8bfc-a279-4567-8ca6-37cda24a1134', 'b954479e-c438-491e-b3b8-b6f539207d04',
        'b76404c8-47c3-46f7-b7fb-566645260db6', '5c0ef767-8372-45bf-ba65-b5079b66bfa1',
        '2c306b0c-28a8-4acf-85b2-9e1c61043f80', '97376a4d-262e-4006-9190-e1c2e104addd',
        '80cd941b-1286-46e3-a009-de5a6d801cec', 'd9cf8f84-d466-4643-bd66-f122a63ab8f8',
        '2bdd8373-d6f6-45b5-a09a-0ad418a01405', 'c2c84361-6b8a-442c-82f9-6b859d8a5d0f',
        '88f7f6b6-678d-46e9-afcb-c73841f410a8')) as dropped,
  (select status::text from public.applications where id = '0c9fdc58-92c4-485a-b8dd-12965870a7c3') as xai_status;
