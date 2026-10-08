-- WHY THIS MIGRATION EXISTS
-- 20261008160000:118-120 runs `alter default privileges in schema applyy_internal revoke
-- execute on functions from public` and its comment says new functions there are no longer
-- PUBLIC-executable. That statement is a no-op: a per-schema default ACL can only ADD to the
-- global defaults, never remove a global grant, so no pg_default_acl row was written (measured
-- live 2026-10-08: 0 rows for the schema). It never touched existing functions either.
-- Measured before-state, 2026-10-08: all 8 trigger functions below had proacl NULL, which
-- means the built-in default "PUBLIC may EXECUTE", and `authenticated` has USAGE on the
-- schema (granted at 160000:116). Severity is LOW: Postgres refuses to call a function that
-- returns `trigger` outside a trigger ("trigger functions can only be called as triggers"),
-- so no client could run them. The fix is still worth making: it makes the 160000 comment
-- true, removes the advisor warning, and means a future non-trigger overload of one of
-- these names (two are SECURITY DEFINER) does not land already client-executable.
--
-- WHAT IT DOES
-- Revokes EXECUTE on the 8 trigger functions from PUBLIC, anon and authenticated.
-- Safe because Postgres checks EXECUTE on a trigger function only at CREATE TRIGGER time,
-- never when the trigger fires, so every existing trigger keeps working. Recon 2026-10-08
-- found no RLS policy, cron job, function body, client or edge function that calls any of
-- them except as a trigger.
--
-- WHAT IT DELIBERATELY LEAVES ALONE
-- applyy_internal.agent_key_state(): public.advance_application_status, claim_applications
-- and release_application_claim are SECURITY INVOKER and call it as the client role, so the
-- worker and every edge agent need EXECUTE for authenticated and service_role
-- (160000:109-111). Revoking it would break every machine-agent status move.
-- applyy_internal.seed_user_defaults / seed_defaults_on_signup: 20261008180000 creates them
-- and already revokes them from everyone itself.
-- The schema USAGE grant: agent_key_state() needs it to be reachable.
--
-- STILL OPEN after this migration: NEW functions in this schema still default to
-- PUBLIC-executable, because only a global `alter default privileges for role postgres`
-- could change that, and that would also reach the public schema's RPCs. Until then,
-- every function added here needs its own revoke, as 20261008180000:142,219 does.
--
-- Re-runnable: REVOKE on a privilege that is already gone is a no-op, not an error.
-- Nothing here changes data, so it has no matched/written counts to report.

-- Maintains updated_at on 8 tables; trigger-only (helpers.sql:60).
revoke execute on function applyy_internal.set_updated_at() from public, anon, authenticated;
-- Makes master_profiles and application_events append-only; a direct call has no purpose.
revoke execute on function applyy_internal.forbid_mutation() from public, anon, authenticated;
-- Numbers master_profiles versions on insert; trigger-only.
revoke execute on function applyy_internal.assign_master_profile_version() from public, anon, authenticated;
-- Stamps master_profiles.content_hash on insert; trigger-only.
revoke execute on function applyy_internal.assign_master_profile_content_hash() from public, anon, authenticated;
-- The status-graph guard; SECURITY DEFINER, so it gets defense in depth if its shape ever changes.
revoke execute on function applyy_internal.guard_status_transition() from public, anon, authenticated;
-- Writes application_events on every status change; also SECURITY DEFINER, also defense in depth.
revoke execute on function applyy_internal.log_status_change() from public, anon, authenticated;
-- Refuses inserts past the approval gate; trigger-only.
revoke execute on function applyy_internal.guard_status_insert() from public, anon, authenticated;
-- Freezes tailored_profile outside review statuses; trigger-only.
revoke execute on function applyy_internal.guard_tailored_profile_freeze() from public, anon, authenticated;
