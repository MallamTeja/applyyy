-- WHY THIS MIGRATION EXISTS
-- Four Gemini-pool functions were created before any grant discipline and still carried the
-- built-in PUBLIC EXECUTE plus an explicit anon grant (measured live 2026-10-09, proacl
-- `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`).
-- Nothing anonymous ever calls them, so those grants were surface area with no purpose.
-- Hygiene, not an exploitable hole: all four are SECURITY INVOKER, and gemini_key_state's only
-- RLS policy ("own key state") is scoped to `authenticated` with auth.uid() = user_id, so an
-- anon call touched zero rows. Removing the grant makes that a refusal instead of a no-op.
--
-- WHO KEEPS WHAT, AND THE EVIDENCE
-- Every app caller signs in with the anon key + a password, so it runs as `authenticated`;
-- no service-role key is used anywhere (recon of all 22 `.rpc(` sites, 2026-10-09).
-- * claim_gemini_key(), report_gemini_result(...): called by the edge functions' key pool
--   (_shared/gemini/pool.ts:138, :189) as `authenticated`. Keep authenticated + service_role.
-- * pacific_today(): never called through .rpc, but executed as the CALLER in two ways, so
--   `authenticated` must keep it:
--   - nested inside claim_gemini_key(), which is SECURITY INVOKER;
--   - as the column DEFAULT of public.gemini_key_state.quota_date and
--     public.system_settings.gemini_budget_date. A default expression is evaluated with the
--     privileges of the role doing the INSERT, so an `authenticated` insert that omits the
--     column needs EXECUTE on pacific_today(). That path is LIVE: the Search Preferences page
--     (apps/web/src/features/settings/SearchPreferencesPage.tsx:380-386) upserts into
--     system_settings as `authenticated` and omits gemini_budget_date, and INSERT ... ON
--     CONFLICT DO UPDATE evaluates the defaults of the proposed row even when it ends up
--     updating. Revoking authenticated here would break saving preferences.
--     (The signup seed, applyy_internal.seed_user_defaults, also omits both columns but is
--     reached only through SECURITY DEFINER callers, so its defaults run as postgres.)
-- * set_gemini_key_pool_size(smallint): no app caller, and no SQL caller among the functions
--   live today. It resizes a user's key pool, which is an operator action, so it is revoked
--   from authenticated too. service_role and the owner (postgres) keep it.
-- No pg_cron, view, policy or check constraint references any of the four (live, 2026-10-09).
--
-- The explicit GRANTs below restate what authenticated/service_role already hold, so this file
-- is the single place that says who may run these, and stays correct if replayed on a database
-- where the earlier defaults differed. Re-runnable: REVOKE of an absent privilege and GRANT of
-- a held one are both no-ops.

-- The pool's "which key next" claim: edge functions only.
revoke execute on function public.claim_gemini_key() from public, anon;
-- Restated so the intended callers are explicit here.
grant execute on function public.claim_gemini_key() to authenticated, service_role;

-- The pool's success/failure report after each call: edge functions only.
revoke execute on function public.report_gemini_result(smallint, boolean, integer, text) from public, anon;
-- Restated so the intended callers are explicit here.
grant execute on function public.report_gemini_result(smallint, boolean, integer, text) to authenticated, service_role;

-- The Pacific-time day boundary: nested in claim_gemini_key and used as two column defaults,
-- both evaluated as the calling role, so authenticated keeps it.
revoke execute on function public.pacific_today() from public, anon;
-- Restated so the intended callers are explicit here.
grant execute on function public.pacific_today() to authenticated, service_role;

-- Resizing a user's key pool is an operator action with no client caller: client roles lose it.
revoke execute on function public.set_gemini_key_pool_size(smallint) from public, anon, authenticated;
-- The operator path stays open.
grant execute on function public.set_gemini_key_pool_size(smallint) to service_role;
