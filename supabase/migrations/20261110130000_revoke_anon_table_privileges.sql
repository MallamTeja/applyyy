-- =============================================================================
-- Revoke every table and sequence privilege `anon` holds in schema public: defence in depth under RLS.
--
-- WHY. Supabase's default privileges grant `anon` broad table rights on every object created in public. Live
-- 2026-11-10 (SELECT-only audit, T14):
--   - 18 public tables granted to anon: SELECT/INSERT/UPDATE/DELETE/REFERENCES/TRIGGER (application_events:
--     INSERT/REFERENCES/SELECT/TRIGGER only). No TRUNCATE.
--   - 3 sequences (application_events_id_seq, gemini_usage_id_seq, resume_chat_messages_id_seq): USAGE/SELECT/UPDATE,
--     so anon could nextval/setval them: burning ids, or a setval that collides application_events primary keys.
--   - RLS is ON for every public table, and NO policy in any schema names `anon` or `public` (every policy is
--     `authenticated`). So anon reaches no row today. The grants are the only thing standing between "RLS disabled
--     by mistake on one table" and that table being world-writable. This removes them.
--
-- NOTHING USES ANON (recon 2026-11-10):
--   - Web: every route renders inside AppShell, which shows LoginPage until a user exists (AppShell.tsx:223,235).
--     Before sign-in the browser calls only the Auth API (getSession, onAuthStateChange, signInWithPassword,
--     signUp). The pre-session prefetch and the count RPC both return early without a session
--     (queuePrefetch.ts:96, useApplicationCounts.ts:159-184). No realtime channel exists. The Vercel function
--     api/render-job-page.ts calls only /auth/v1/user with the user's JWT. An expired stored session sends a
--     rejected JWT (401), never an anon request.
--   - Edge functions, worker CLIs, GitHub workflows, scripts/jobs-tombstone.mjs: each builds its client with the anon
--     KEY but signs in (signInWithPassword / password grant) before any query, so PostgREST sees `authenticated`.
--     _shared/db/client.ts:117,134. The anon-key verifier client only calls auth.getUser (the auth server, not PostgREST).
--   - email-tracker.gs posts to the email-tracker-intake edge function only (shared secret, then app-user sign-in).
--   - The ONE deliberate anon read in code is rls-proof's negative control (rls-proof/index.ts:357-376:
--     company_watchlist with no session). It passes on 0 rows OR on 42501, so after this revoke it still passes. It
--     refuses to run against this production project anyway (rls-proof/guard.ts:56-62), so it is not the proof of this
--     file. The proof is the assert block at the end, plus the post-apply checks in the T14 bridge.
--
-- SCOPE. Schema public, tables (incl. partitioned; views/matviews/foreign tables would be covered too, public has
-- none) and sequences, role anon only. NOT touched:
--   - `authenticated` and `service_role` grants;
--   - function EXECUTE: anon can execute exactly one public function, jobs_keep_tombstone_slim() (a trigger function,
--     not SECURITY DEFINER; a trigger function cannot be called directly). Function defaults were already closed by
--     20261009120000_global_default_no_public_execute_on_functions.sql. The four agent-key-gated RPCs
--     (advance_application_status, claim_applications, release_application_claim, sweep_stale_claims) already have
--     no anon EXECUTE (CLAUDE.md §7), and this file keeps it that way;
--   - Supabase-managed schemas (storage, realtime, graphql_public, auth, extensions): their anon grants are platform
--     defaults that Supabase's own services rely on, and every one of their tables has RLS on (except
--     realtime.subscription, a platform default). The app uses no storage bucket and no realtime channel as anon;
--   - DEFAULT PRIVILEGES: new tables created in public by postgres/supabase_admin STILL auto-grant to anon
--     (pg_default_acl: postgres tables anon=arwdxtm, sequences rwU; supabase_admin tables anon=arwdDxtm). This file
--     cleans what exists; it does not stop the next `create table` from re-granting. Changing the defaults is a
--     separate decision (orchestrator). Until then, every new table's migration must `enable row level security`.
--
-- RE-RUNNABLE: REVOKE of a privilege not held is a no-op. WRITTEN, NOT APPLIED: the orchestrator applies it.
-- =============================================================================

-- Every table in public (partitioned, views, matviews and foreign tables too: public has none of the last three
-- today). ALL covers SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER. Every public relation is owned by
-- postgres, the migration role (live 2026-11-10: 24 of 24), so no revoke is skipped with a mere warning.
revoke all on all tables in schema public from anon;

-- Every sequence in public: USAGE (nextval), SELECT (currval) and UPDATE (setval).
revoke all on all sequences in schema public from anon;

-- Prove it in the same transaction: anything anon still holds on a public table or sequence aborts the migration,
-- so a half-done revoke can never be recorded as applied.
do $$
declare
  -- Table-level grants anon still holds in public.
  left_tables bigint;
  -- Sequences anon can still use, read or set in public.
  left_sequences bigint;
begin
  -- Asked of the privilege functions, NOT information_schema.role_table_grants: that view lists only grants whose
  -- grantor or grantee is a role the current user is a member of, which anon is not, so it could report 0 while a
  -- grant survived (independent review, 2026-11-10). has_*_privilege answers for anon directly, column grants included.
  select count(*) into left_tables from pg_catalog.pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and (pg_catalog.has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
        or pg_catalog.has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'));
  -- Sequences are not in role_table_grants; ask the privilege functions directly, one per right.
  select count(*) into left_sequences from pg_catalog.pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
      and (pg_catalog.has_sequence_privilege('anon', c.oid, 'USAGE')
        or pg_catalog.has_sequence_privilege('anon', c.oid, 'SELECT')
        or pg_catalog.has_sequence_privilege('anon', c.oid, 'UPDATE'));
  -- Any leftover means the revoke did not do what this file claims: fail the whole migration.
  if left_tables > 0 or left_sequences > 0 then
    -- Rolls back the revokes too, so nothing is half-applied.
    raise exception 'revoke_anon_table_privileges: anon still holds % table grants and % sequences in public', left_tables, left_sequences;
  end if;
  -- The positive record for the push output.
  raise notice 'revoke_anon_table_privileges: anon holds 0 table grants and 0 sequence privileges in public';
end
$$;
