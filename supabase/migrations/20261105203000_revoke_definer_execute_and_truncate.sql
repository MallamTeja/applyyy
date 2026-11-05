-- 20261105203000_revoke_definer_execute_and_truncate.sql — least privilege for two advisor findings.
--
-- WHY THIS EXISTS (P2 #5 + #8, docs/security/2026-11-05-vulnerability-remeasure.md).
--
-- #5. Two SECURITY DEFINER functions were callable by every signed-in user over /rest/v1/rpc
-- (Supabase advisor 0029). Live ACL on 2026-11-05: `authenticated=X/postgres` on both, PUBLIC
-- already revoked, so revoking from `authenticated` closes it.
--   * public.bootstrap_user_defaults(): NOTHING calls it. Grepped apps/web/src, worker/src and
--     supabase/functions on 2026-11-05: only two comments name it. New users are seeded by the
--     signup trigger, which calls the private applyy_internal.seed_user_defaults(NEW.id), not
--     this wrapper (20261008180000). The wrapper was a self-repair path for a signed-in user
--     with missing defaults; that repair now runs as postgres instead:
--       select applyy_internal.seed_user_defaults('<user uuid>');   -- idempotent
--   * public.rls_auto_enable(): an EVENT TRIGGER function (returns event_trigger), so Postgres
--     already refuses a direct call; the grant was pure surface. Event triggers fire regardless
--     of EXECUTE grants, so this cannot stop it from enabling RLS on new tables.
--
-- #8. `anon` and `authenticated` held TRUNCATE on 17 of the 20 public tables (Supabase's
-- default grants). RLS does not apply to TRUNCATE. PostgREST does not expose it today, but a
-- grant nobody uses is a grant someone can misuse, so it goes. The DEFAULT privileges are
-- revoked too: live pg_default_acl for role postgres grants TRUNCATE ('D') to both roles on
-- every new table, so without that line the next migration's table would get it back.
-- (supabase_admin's default ACL grants it as well; postgres cannot alter another role's
-- defaults. Tables here are created by migrations running as postgres, so postgres's defaults
-- are the ones that apply.)
--
-- Idempotent: REVOKE of a privilege not held is a no-op, so a re-run changes nothing.

-- #5: no signed-in user may run the definer wrapper over RPC.
revoke execute on function public.bootstrap_user_defaults() from authenticated;
-- #5: nor the event-trigger function (uncallable anyway; the grant was surface only).
revoke execute on function public.rls_auto_enable() from authenticated;

-- #8: TRUNCATE off every existing public table for the two API roles.
revoke truncate on all tables in schema public from anon, authenticated;
-- #8: and off every table postgres creates in public from now on.
alter default privileges for role postgres in schema public revoke truncate on tables from anon, authenticated;
