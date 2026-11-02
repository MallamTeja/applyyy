-- =============================================================================
-- Capture public.rls_auto_enable() and its event trigger `ensure_rls` in a migration.
--
-- WHY THIS EXISTS (W25, docs/audit/2026-11-01-wiring-audit.md). Both objects exist on
-- the live project (xynqxekcqizwhtskzqrq) but in NO migration: they were created outside
-- the migration history. A `supabase db reset`, a preview branch or a fresh project
-- therefore comes up WITHOUT the backstop that turns RLS on for every new public table.
--
-- WHAT IT DOES. After any CREATE TABLE / CREATE TABLE AS / SELECT INTO, the function
-- runs `alter table ... enable row level security` on each new table in schema public,
-- logs the outcome, and skips every other schema. A failure is logged, never raised, so
-- it cannot abort the DDL that fired it. Every migration here still enables (and
-- forces) RLS itself; this only catches a table someone forgot. On a `db reset` it runs
-- after the earlier migrations, so it guards tables created from here on.
--
-- CAPTURED EXACTLY AS LIVE on 2026-11-02, from pg_get_functiondef() and pg_event_trigger
-- (SELECT only). The function body is byte-identical to live prosrc: md5
-- 99be20677b456ea8d3be47bdd44fb369, length 953. That is why the body carries NO inline
-- comments: a comment inside the $function$ body changes prosrc, and verification
-- query 1 below could no longer prove the capture is exact. It is explained above.
--
-- ONE DELIBERATE CHANGE FROM LIVE: EXECUTE is revoked from PUBLIC and anon. Live has
-- anon=true, through the PUBLIC default grant AND an explicit anon grant, on a SECURITY
-- DEFINER function owned by postgres. Both must go: revoking anon alone leaves its
-- EXECUTE in place through PUBLIC. No behaviour should change. A function returning
-- event_trigger cannot be called from SQL at all ("trigger functions can only be called
-- as triggers"), and the server invokes an event trigger without an EXECUTE check.
-- Optional check 4 below proves the trigger still fires after the revoke.
-- `authenticated` and `service_role` keep their explicit grants (out of scope here).
--
-- RE-RUNNABLE: create or replace; drop event trigger if exists, then create (CREATE
-- EVENT TRIGGER has no IF NOT EXISTS / OR REPLACE); a revoke of an absent grant is a
-- no-op. On live, the first apply changes only the two grants.
-- WRITTEN, NOT APPLIED. The orchestrator runs `db push --dry-run`, then `db push`.
-- =============================================================================

-- The function, verbatim from live. SECURITY DEFINER so the ALTER runs with the owner's
-- rights whoever issued the CREATE TABLE; search_path pinned to pg_catalog so no
-- caller-controlled schema can shadow format() or the catalog functions it calls.
create or replace function public.rls_auto_enable()
 returns event_trigger
 language plpgsql
 security definer
 set search_path to 'pg_catalog'
as $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

-- Drop first, because CREATE EVENT TRIGGER cannot replace an existing one.
drop event trigger if exists ensure_rls;

-- Same event and tag filter as live: fires after each statement that creates a table.
create event trigger ensure_rls
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();

-- PUBLIC first: every role, anon included, inherits EXECUTE through this default grant.
revoke execute on function public.rls_auto_enable() from public;

-- Then the explicit anon grant that live carries on top of PUBLIC.
revoke execute on function public.rls_auto_enable() from anon;

-- =============================================================================
-- VERIFICATION (run after apply; queries 1-3 are SELECT only):
--
-- 1. The body is the captured one. Expect 99be20677b456ea8d3be47bdd44fb369 | 953 | t |
--    {search_path=pg_catalog}:
--      select md5(prosrc), length(prosrc), prosecdef, proconfig::text
--      from pg_proc where oid = 'public.rls_auto_enable'::regproc;
--
-- 2. The trigger exists and points at it. Expect exactly one row:
--    ensure_rls | ddl_command_end | O | {"CREATE TABLE","CREATE TABLE AS","SELECT INTO"} |
--    rls_auto_enable():
--      select evtname, evtevent, evtenabled, evttags, evtfoid::regprocedure
--      from pg_event_trigger where evtname = 'ensure_rls';
--
-- 3. anon can no longer execute it. Expect f | f:
--      select has_function_privilege('anon', 'public.rls_auto_enable()', 'execute') as anon,
--             has_function_privilege('public', 'public.rls_auto_enable()', 'execute') as public;
--
-- 4. OPTIONAL, AND A WRITE (DDL, rolled back), so the orchestrator runs it, never a
--    peer: the trigger still fires after the revoke. Expect relrowsecurity = t:
--      begin;
--      create table public.rls_auto_enable_probe (id int);
--      select relrowsecurity from pg_class where oid = 'public.rls_auto_enable_probe'::regclass;
--      rollback;
-- =============================================================================
