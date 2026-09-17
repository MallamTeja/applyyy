-- =============================================================================
-- Appends a RETRACTION to every application whose history was forged by the
-- deleted "Tailor & Queue" fast-path button.
--
-- WHY THIS FILE EXISTS, because in a year it will look like noise otherwise.
--
-- `apps/web/src/features/discovery/DiscoveredJobsPage.tsx` carried a button that
-- walked one application through SIX status transitions in a loop, each one an
-- `advance_application_status()` call naming a different agent:
--
--     discovered      -> deduped            claiming agent 'normalizer'
--     deduped         -> passed_filters     claiming agent 'screener'
--     passed_filters  -> scored             claiming agent 'matcher'
--     scored          -> tailored           claiming agent 'tailor'
--     tailored        -> audit_clean        claiming agent 'auditor'
--     audit_clean     -> awaiting_approval  claiming agent 'auditor'
--
-- NONE OF THOSE AGENTS RAN. The button deleted in 75a75a0 did no screening, no
-- scoring, no tailoring and no audit — it moved a row's status six times and let
-- the audit log record six agent executions that never happened.
--
-- TWO OF THOSE AGENTS DO NOT EXIST AS RUNNABLE CODE AT ALL. There is no
-- `supabase/functions/_shared/audit*` directory: the Auditor, whose 'audit_clean'
-- verdict this button forged, has never been written. `audit_clean` is the status
-- that asserts every tailored line was traced back to the master profile and
-- nothing was invented — so the forged claim is precisely the one the human
-- approval gate is meant to rely on. (The Normalizer is a subtler case and is NOT
-- claimed here to be absent: `_shared/normalize/` exists and is reachable, but no
-- runner writes the `deduped` status, so that transition was equally unearned.)
--
-- EACH CLICK WROTE TWELVE ROWS, not six:
--   * `advance_application_status()` inserts a 'note' event whenever `p_detail` is
--     non-empty (20260909235100_queue_and_pool_functions.sql:147-150), and the
--     button passed a detail on every call, so it fired every time — six rows;
--   * the `log_status_change` AFTER UPDATE trigger
--     (20260909234900_status_transition_guard.sql:273-314) inserts a 'status_change'
--     row per transition, stamped with the same forged agent — six more.
--
-- WHY A RETRACTION AND NOT A CLEANUP. `application_events` carries `forbid_update`
-- and `forbid_delete` triggers (20260909234800_supporting_tables.sql:53-59). The
-- rows are append-only and undeletable BY CONSTRUCTION, and that is the table
-- doing its job rather than an obstacle to route around: an audit log that can be
-- rewritten is not an audit log. Appending the correction is the only honest move
-- available and also the only possible one. The forged rows STAY. This file adds
-- the row that says they are false.
--
-- WHO WILL READ THIS. Nobody, for now: no UI reads `application_events` — there is
-- no `from('application_events')` anywhere in `apps/web/src`, and the Health page
-- reads `agent_runs`, which this RPC never touches. So the forged history is
-- permanent, complete and invisible, and this retraction is invisible alongside
-- it. It is written for whoever builds that reader, or for an auditor asking in
-- six months why an application claims an audit that never ran.
-- =============================================================================

-- =============================================================================
-- HOW THE AFFECTED ROWS ARE IDENTIFIED, and why no manual id list is needed.
--
-- The button passed a fixed literal on every call:
--     p_detail: { note: 'Fast-tailored and queued from Discovered Jobs Explorer' }
-- and `advance_application_status` writes `p_detail` verbatim into
-- `application_events.detail`, a `jsonb not null` column. So the marker is IN the
-- event row — no join, no inference, no id list to paste in.
--
-- THE STRING IS UNIQUE TO THAT BUTTON. `git log -S` over `apps/web/src` returns
-- exactly two commits: ab05ba4, which introduced it, and 75a75a0, which deleted
-- it. Nothing else in the repo has ever written it, and no UI lets a human type a
-- note, so a false positive would have to be typed by hand into the SQL editor.
--
-- WHAT THE DISCRIMINATOR DOES NOT FIND, stated so nobody trusts it too far: it
-- matches the six 'note' rows, NOT the six 'status_change' rows, because the
-- trigger builds its own detail payload and never sees `p_detail`. That is fine
-- and deliberate — the note rows identify the affected APPLICATIONS, and the
-- retraction is written per application. The status_change rows are retracted by
-- the same statement because they belong to the same application_id.
-- =============================================================================

-- =============================================================================
-- THE DESIGN DECISION THAT MATTERS MOST: THIS DESCRIBES, IT DOES NOT ASSERT.
--
-- The button's loop threw on the first failing step
-- (`throw new Error(\`Step ${step.to} failed\`)`), so a click that failed partway
-- left FEWER than six forged transitions. A retraction hardcoding "six agents were
-- forged" would therefore be false for exactly the rows where something already
-- went wrong — a correction that introduces its own inaccuracy.
--
-- So every fact in the retraction is AGGREGATED FROM THE ROWS THEMSELVES. The note
-- rows carry the claimed agent (the RPC writes `p_agent` onto the note), so the
-- data can say which agents were actually claimed for THIS application, how many
-- events were forged, and when. Nothing is templated.
-- =============================================================================

do $$
declare
  -- The stable identity of this correction. It is what makes the migration
  -- idempotent, so it must never change: a second run looks for this exact value
  -- and skips any application already carrying it. A duplicated retraction would
  -- be its own small falsification of the log.
  v_marker constant text := 'fast_path_forged_agent_history_2026_09_17';

  -- The discriminator literal, quoted exactly as the deleted button wrote it.
  -- Held in a variable rather than inlined twice so the count and the insert can
  -- never drift apart and start answering different questions.
  v_note constant text := 'Fast-tailored and queued from Discovered Jobs Explorer';

  -- How many applications the discriminator matched, counted BEFORE the insert.
  -- Separate from the write count because the difference between them is the
  -- number already retracted by an earlier run — which is the signal that tells a
  -- second run apart from a first one that found nothing.
  v_matched integer;

  -- How many retraction rows this run actually appended.
  v_written integer;
begin
  -- Count first. This is the number that makes a silent no-op impossible to
  -- mistake for success: a migration that matches nothing and a migration that
  -- repairs everything both print "Finished supabase db push" otherwise.
  select count(*)
    into v_matched
    from (
      select distinct e.application_id
        from public.application_events e
       where e.event_type = 'note'
         and e.detail ->> 'note' = v_note
    ) s;

  -- One retraction per affected application, built from that application's own
  -- forged rows rather than from a template.
  insert into public.application_events
    (user_id, application_id, event_type, from_status, to_status, agent, detail)
  select
    -- MUST come from the source row. `application_events.user_id` defaults to
    -- `auth.uid()`, which is NULL during a migration — there is no authenticated
    -- session in a deploy — and the column is NOT NULL, so relying on the default
    -- would abort the whole file. Carrying the owner across also keeps the
    -- retraction inside the same RLS tenant as the rows it corrects.
    f.user_id,
    f.application_id,
    -- 'note' is the only honest event_type available. 'status_change' would be a
    -- lie of a different kind — no status changes here — and the enum
    -- (20260909234500_enums.sql:279-288) has no 'correction' value. Adding one
    -- would need its own `alter type` migration in its own file, which is a larger
    -- change than a historical correction should drag in.
    'note',
    -- Both NULL, because this event describes no transition. The schema documents
    -- exactly this case: "NULL for non-status events such as a note or an llm_call."
    null,
    null,
    -- 'human' — "A human acting through the dashboard" per the enum's own comment.
    -- Attributing the retraction to any pipeline agent would repeat the original
    -- offence: naming an agent that did not run.
    'human',
    jsonb_build_object(
      -- The idempotence key. Also what a future reader greps for to find every
      -- correction of this class in one query.
      'correction', v_marker,
      -- Plain language first, because the person who eventually reads this may be
      -- an auditor rather than an engineer and should not have to infer the point
      -- from the structured fields below it.
      'summary',
        'RETRACTION. The agent executions recorded against this application by the '
        || '"Tailor & Queue" fast-path button did not occur. The button changed status '
        || 'only; no normalization, screening, scoring, tailoring or audit was performed. '
        || 'The audit_clean verdict in this history is void: no Auditor exists in the '
        || 'codebase. The original events are retained because application_events is '
        || 'append-only by design; this row retracts them, it does not remove them.',
      -- Derived, never assumed: the agents this application actually had claimed on
      -- its behalf. A click that failed partway forged fewer than six.
      'retracted_claimed_agents', to_jsonb(f.claimed_agents),
      -- The 'note' rows only. The matching 'status_change' rows written by
      -- log_status_change() are retracted too but are not counted here, because
      -- they carry no discriminator and counting them would mean asserting a
      -- number this statement cannot verify.
      'retracted_note_events', f.forged_events,
      -- The window the forgery happened in, so a reader can line it up against
      -- anything else in the log without trusting this row's own timestamp.
      'forged_between', jsonb_build_object('first', f.first_seen, 'last', f.last_seen),
      -- Provenance of the correction itself, so the claim can be checked rather
      -- than believed.
      'source', jsonb_build_object(
        'button_removed_in', '75a75a0',
        'button_added_in', 'ab05ba4',
        'ruled_by', 'Teja, 2026-09-17',
        'migration', '20260917174600_retract_forged_fast_path_agent_events'
      )
    )
  from (
    select
      e.user_id,
      e.application_id,
      count(*) as forged_events,
      -- DISTINCT because the button claimed 'auditor' twice; ordered so two runs
      -- against the same data produce byte-identical detail payloads.
      array_agg(distinct e.agent::text order by e.agent::text) as claimed_agents,
      min(e.created_at) as first_seen,
      max(e.created_at) as last_seen
      from public.application_events e
     where e.event_type = 'note'
       and e.detail ->> 'note' = v_note
     group by e.user_id, e.application_id
  ) f
  -- IDEMPOTENCE. Supabase retries, and this file may also be re-run deliberately
  -- once someone builds a reader and wants to confirm it still matches. Keyed on
  -- the marker rather than on a row count, so it stays correct even if a click
  -- somehow forged more rows after a partial retraction.
  where not exists (
    select 1
      from public.application_events r
     where r.application_id = f.application_id
       and r.detail ->> 'correction' = v_marker
  );

  get diagnostics v_written = row_count;

  -- HONEST WHEN IT MATCHES NOTHING. This repo's signature failure is a migration
  -- that runs clean and changes nothing while reporting success, so zero matches
  -- gets a WARNING rather than silence. It is deliberately NOT an exception: this
  -- is a historical correction, and aborting a seven-file push over "there was
  -- nothing to correct" would turn good news into an outage.
  if v_matched = 0 then
    raise warning
      'RETRACTION MATCHED NOTHING. No application_events row carries the fast-path note (%). Either the button was never clicked against this database, or the discriminator is wrong, or this role cannot read application_events under RLS. Verify with the query in this migration''s footer before concluding the history is clean.',
      v_note;
  else
    -- Both numbers, because their difference is the information. written = matched
    -- is a first run; written = 0 with matched > 0 is a correct re-run; anything
    -- between means some applications were retracted earlier and some were not.
    raise notice
      'RETRACTION APPLIED. % application(s) carry forged fast-path history; % retraction row(s) appended this run (0 means already retracted).',
      v_matched, v_written;
  end if;
end;
$$;

-- =============================================================================
-- VERIFY IT MATCHED SOMETHING — because "applied without error" is not evidence.
-- Run this after the push. The two counts should be equal and non-zero; if the
-- first is zero the WARNING above already fired and the history needs a second
-- look, not a shrug.
--
--   select
--     (select count(distinct application_id) from public.application_events
--       where event_type = 'note'
--         and detail ->> 'note' = 'Fast-tailored and queued from Discovered Jobs Explorer'
--     ) as applications_with_forged_history,
--     (select count(*) from public.application_events
--       where detail ->> 'correction' = 'fast_path_forged_agent_history_2026_09_17'
--     ) as retractions_written;
--
-- To read one application's corrected history end to end:
--
--   select created_at, event_type, agent, from_status, to_status, detail
--     from public.application_events
--    where application_id = '<id>'
--    order by created_at;
-- =============================================================================
