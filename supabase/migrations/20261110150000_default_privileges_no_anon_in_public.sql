-- =============================================================================
-- New tables and sequences in public stop auto-granting `anon`: postgres's default privileges.
--
-- WHY. 20261110130000 revoked every anon privilege on the tables and sequences that exist. But pg_default_acl still
-- stamps anon onto every NEW object: live 2026-11-10 (T14b recon, SELECT-only), postgres's default ACL in public grants
-- anon SELECT/INSERT/UPDATE/DELETE/REFERENCES/TRIGGER/MAINTAIN on tables and SELECT/UPDATE/USAGE on sequences. So the
-- next `create table` in a migration re-opens the grant layer, and RLS is once again the only barrier. The
-- orchestrator decided (T14b, 2026-11-10) to close it at the source.
--
-- WHOSE DEFAULTS. Default privileges belong to the role that CREATES the object. Every public object is created by
-- migrations, which `supabase db push` runs as postgres (live: current_user = postgres; all 21 tables, 3 sequences and
-- 15 functions in public are owned by postgres). So postgres's entry is the one that decides, and this file changes it.
--
-- NOT supabase_admin. Its default ACL in public also grants anon (all 8 table rights incl. TRUNCATE; sequences
-- SELECT/UPDATE/USAGE). It is left alone because this file cannot change it: ALTER DEFAULT PRIVILEGES FOR ROLE x
-- requires membership in x, and postgres is neither a superuser nor a member of supabase_admin (live:
-- pg_has_role(postgres, supabase_admin, MEMBER) = false). supabase_admin owns NOTHING in public today, so its entry
-- only matters if the platform itself creates an object there (an extension installed into public). Residual risk,
-- not exposure; invariants.sql block 13 checks the objects that actually exist.
--
-- SCOPE. Role postgres, schema public, TABLES and SEQUENCES, grantee anon. NOT touched: authenticated and
-- service_role defaults (the app runs as authenticated and needs its grants on new tables); function defaults
-- (global PUBLIC EXECUTE already off since 20261009120000; per-schema anon EXECUTE is a separate decision); other
-- schemas (storage defaults are platform-managed). Precedent: 20261105203000 did the same for TRUNCATE only.
--
-- WHAT A NEW TABLE'S MIGRATION MUST NOW DO: nothing extra for anon. It still needs `enable row level security` and
-- explicit policies, and it still gets authenticated/service_role grants from the defaults.
--
-- RE-RUNNABLE: revoking a default privilege that is not granted is a no-op. WRITTEN, NOT APPLIED: the orchestrator
-- applies it after 20261110130000.
-- =============================================================================

-- Future tables (and views/matviews/foreign tables, which share the 'r' default) created by postgres in public: no anon rights.
alter default privileges for role postgres in schema public revoke all on tables from anon;

-- Future sequences created by postgres in public: no nextval/currval/setval for anon.
alter default privileges for role postgres in schema public revoke all on sequences from anon;

-- Prove it in the same transaction: an anon entry left in the defaults this file owns aborts (and rolls back) the file.
do $$
declare
  -- What anon would still get on a new public table ('r') or sequence ('S') created by postgres.
  v_left text;
begin
  -- Read the stored ACL itself: aclexplode lists one row per grantee and privilege.
  select string_agg(d.defaclobjtype::text || ':' || a.privilege_type, ', ') into v_left
    from pg_catalog.pg_default_acl d
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
   where d.defaclrole = 'postgres'::regrole
     and d.defaclnamespace in (0, 'public'::regnamespace)  -- 0 = a global entry, which a per-schema revoke cannot clear
     and d.defaclobjtype in ('r', 'S')
     and a.grantee = 'anon'::regrole;
  -- Anything left means the revoke did not do what this file claims.
  if v_left is not null then
    -- Rolls back both ALTERs above, so nothing is half-applied.
    raise exception 'default_privileges_no_anon_in_public: postgres defaults in public still grant anon: %', v_left;
  end if;
  -- The positive record for the push output.
  raise notice 'default_privileges_no_anon_in_public: postgres default ACL in public grants anon nothing on tables or sequences';
end
$$;
