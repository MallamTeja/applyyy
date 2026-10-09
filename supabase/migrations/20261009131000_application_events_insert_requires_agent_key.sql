-- =============================================================================
-- 20261009131000 — a direct INSERT into application_events may name a machine
-- agent only if the request proves it is one (the agent key).
--
-- WHY THIS EXISTS — AUDIT-LOG FORGERY. application_events is the append-only record
-- of who did what. Its insert policy "append own events" (20260909235000_rls_policies.sql:95)
-- checked only `auth.uid() = user_id`, and the `agent` column is caller-supplied. Every
-- client signs in as the SAME app user, so a browser session could insert a row such
-- as {event_type: 'status_change', agent: 'auditor'} and the log would show the auditor
-- doing something it never did. The status RPC and the claim/release/sweep functions
-- already refuse an unproven machine identity (20261008160000, 20261008170000,
-- 20261009130000); this closes the last direct path. Found by live recon on 2026-10-09.
--
-- THE RULE: a row with agent = 'human' needs no proof (the one identity the browser
-- legitimately holds). Any other value, NULL included, passes only when
-- applyy_internal.agent_key_state() says 'valid' (the x-applyy-agent-key header matched)
-- or 'unconfigured' (no key seeded yet).
--
-- WHY IT IS A NO-OP WHILE THE KEY IS EMPTY: agent_key_state() returns 'unconfigured',
-- so the second branch is true for every row and the check reduces to the old one.
--
-- WHO INSERTS DIRECTLY (repo recon 2026-10-09; every other event comes from inside
-- advance_application_status or the definer trigger log_status_change, which RLS does
-- not apply to):
--   * apps/web saveTailoredEdit.ts:226 and ReferralOutreachPage.tsx:197: agent 'human',
--     no key header. Pass in both key states.
--   * release_application_claim (security INVOKER, so RLS applies): agent 'applier',
--     called only by the worker, which sends the key. That function already refuses
--     an unproven caller itself, so this adds no new failure.
--   * supabase/functions/referral/index.ts:487: agent NULL, ON PURPOSE (see the comment
--     at referral/index.ts:496-500). NULL = 'human' is NULL, not true, so this row rides
--     the key branch; the referral function uses createAppUserClient, which sends the
--     key. Do NOT "fix" referral to write agent = 'human': that would make a machine
--     row claim to be a person, which is the forgery this file exists to stop.
-- The 2026-09-09 comment above the old policy ("agents insert notes, errors and llm_call
-- rows directly") is stale: live data for the last 21 days holds only status_change and
-- note rows, all written by the RPC.
--
-- DEPENDENCY: `authenticated` must keep EXECUTE on applyy_internal.agent_key_state()
-- and USAGE on schema applyy_internal (both true live on 2026-10-09). Revoking either
-- makes this policy raise on EVERY insert, the browser's 'human' notes included
-- (the OR does not help: schema USAGE is checked when the query is parsed and function
-- EXECUTE when the expression is initialised, before any branch is evaluated).
--
-- PRE-CHECK (read-only; expect exactly one row, the old with_check):
--   select polname, polcmd, polroles::regrole[], pg_get_expr(polwithcheck, polrelid)
--     from pg_policy
--    where polrelid = 'public.application_events'::regclass and polname = 'append own events';
--   -- expect: append own events | a | {authenticated} | (( SELECT auth.uid() AS uid) = user_id)
-- POST-CHECK (read-only): the same query. Expect polcmd 'a', roles {authenticated}, and a
--   with_check containing both 'agent_key_state' and 'human'. Also confirm the other policy
--   is untouched:
--   select polname from pg_policy where polrelid = 'public.application_events'::regclass order by 1;
--   -- expect: append own events, read own events
--
-- BEHAVIOURAL PROBE (writes, then ROLLS BACK by raising at the end; run only with the
-- orchestrator's say-so). Expected today, with the key EMPTY: both inserts OK.
--   do $probe$
--   declare
--     -- The single live user (select user_id from applications group by 1).
--     v_uid uuid := '0f4b24da-e85b-40bb-8606-c81824493b45';
--     -- Any one of that user's applications, for the NOT NULL foreign key.
--     v_app uuid;
--     -- Collected outcomes, reported in the final raise.
--     v_out text := '';
--   begin
--     -- Act as the browser: the authenticated role with that user's JWT subject.
--     perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
--     -- Transaction-local, so the role cannot outlive the probe.
--     set local role authenticated;
--     -- Visible to this user under RLS.
--     select id into v_app from public.applications limit 1;
--     -- Case 1: the browser's own identity.
--     begin
--       insert into public.application_events (user_id, application_id, event_type, agent, detail)
--       values (v_uid, v_app, 'note', 'human', '{"probe": "20261009131000"}');
--       v_out := v_out || 'human=OK ';
--     exception when others then v_out := v_out || 'human=' || sqlstate || ' ';
--     end;
--     -- Case 2: a machine identity with no key header. OK while unconfigured;
--     -- after seeding, expect 42501 (new row violates row-level security policy).
--     begin
--       insert into public.application_events (user_id, application_id, event_type, agent, detail)
--       values (v_uid, v_app, 'note', 'auditor', '{"probe": "20261009131000"}');
--       v_out := v_out || 'auditor=OK ';
--     exception when others then v_out := v_out || 'auditor=' || sqlstate || ' ';
--     end;
--     -- Always roll back: application_events is append-only, a probe row could never be removed.
--     raise exception 'PROBE RESULT (rolled back): %', v_out;
--   end
--   $probe$;
--   -- Expect today:     PROBE RESULT (rolled back): human=OK auditor=OK
--   -- Expect post-seed: PROBE RESULT (rolled back): human=OK auditor=42501
--
-- WRITTEN, NOT APPLIED. Must run after 20261008160000 (creates agent_key_state()).
-- =============================================================================

-- Re-runnable: create policy has no `if not exists`, so drop first. Only this policy;
-- "read own events" is untouched.
drop policy if exists "append own events" on public.application_events;

-- Same name, command and role as 20260909235000:95-97, so nothing reading pg_policy by name breaks.
create policy "append own events" on public.application_events
  -- Inserts only, exactly as before.
  for insert to authenticated
  -- Unchanged first half: a user can only append to their own log.
  with check (
    (select auth.uid()) = user_id
    -- New second half: a person, or a proven (or not-yet-enforced) machine. Wrapped in
    -- (select ...) so it runs once per statement as an InitPlan, not once per row.
    and (
      agent = 'human'
      or (select applyy_internal.agent_key_state()) in ('valid', 'unconfigured')
    )
  );
