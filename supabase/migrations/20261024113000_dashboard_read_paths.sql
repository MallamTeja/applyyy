-- =============================================================================
-- Dashboard read paths at ~21.5k applications: one index, one count function.
--
-- WHY THIS EXISTS. The 2026-10-23 watchlist expansion grew `applications` ~10x in a
-- week (live 2026-10-24 10:53 IST: dropped_filter 17733, passed_filters 2402,
-- discovered 1114, deduped 310). Two dashboard reads broke at that size:
--
-- 1. THE INDEX. /discovered and the pipeline drawer read one status lane, newest
--    first, with a small LIMIT (300 / 25). The only index with created_at in it,
--    applications_claimable_idx, is PARTIAL (`where claimed_by is null`), so a query
--    without that predicate cannot use it. Measured 2026-10-24 (EXPLAIN ANALYZE, RLS
--    on, as authenticated): the passed_filters page seq-scanned all 21,560 jobs,
--    hash-joined them, and sorted with a 46 MB disk spill before applying LIMIT 300
--    (46.6 s, cold cache); the drawer's dropped_filter page took 2.6 s for 25 rows.
--    A full (user_id, status, created_at desc, id) index returns the lane already
--    in the page's exact sort order (created_at desc, then id asc as the keyset
--    tie-break), so LIMIT stops the scan early and each job joins by primary key.
--    RLS supplies the leading `user_id = auth.uid()` equality on every read.
--
-- 2. THE COUNT FUNCTION. The pipeline page counted statuses by fetching
--    `select=status` for EVERY row and tallying in the browser. Hosted PostgREST caps
--    every response at max_rows = 1000 WITHOUT an error (confirmed live 2026-10-24:
--    content-range 0-999/*), so the page showed counts for 1,000 of 21,560 rows:
--    silently wrong, not merely slow. A server-side GROUP BY returns one row per
--    status (at most ~20), which no row cap can truncate.
--
-- SECURITY: the function is SECURITY INVOKER, so the caller's RLS policy
-- ("own applications") still scopes it; the explicit user_id predicate only lets the
-- planner use the index. anon gets no EXECUTE: a signed-out caller has nothing to count.
--
-- RE-RUNNABLE, NO DATA CHANGE: `if not exists`, `create or replace`, and grant/revoke
-- are all idempotent. Plain CREATE INDEX (not CONCURRENTLY) because a migration runs
-- inside a transaction, where CONCURRENTLY is refused; at ~21.5k rows the build lock
-- lasts well under a second.
--
-- DEPLOY ORDER (CLAUDE.md §3): the web change that CALLS application_status_counts
-- ships AFTER this migration is applied. Vercel deploys on push, so apply first, push second.
--
-- ROLLBACK
--   drop function if exists public.application_status_counts();
--   drop index if exists public.applications_user_status_created_id_idx;
-- =============================================================================

-- The lane-page index: equality on (user_id, status), then the exact ORDER BY of the
-- /discovered page (created_at desc, id asc), so LIMIT reads only the rows it returns.
create index if not exists applications_user_status_created_id_idx
  -- Column order matters: the two equality columns first, then the two sort keys.
  on public.applications (user_id, status, created_at desc, id);

-- One row per status for the signed-in user. Replaces the browser-side tally of a
-- row list that max_rows silently truncated at 1,000.
create or replace function public.application_status_counts()
  -- row_count rather than count, so the output column never reads as the aggregate keyword.
  returns table (status public.application_status, row_count bigint)
  -- Plain SQL: a single statement, nothing procedural to need plpgsql for.
  language sql
  -- Reads only, so the planner may treat it as stable within one statement.
  stable
  -- The caller's privileges and RLS apply; this function grants no extra visibility.
  security invoker
  -- Empty search_path: every name below is schema-qualified, so no shadowing object can hijack it.
  set search_path = ''
as $$
  -- Qualified a.status, because an OUT column named status would otherwise be ambiguous.
  select a.status, count(*)::bigint
  -- The table the dashboard counts.
  from public.applications a
  -- Redundant with RLS on purpose: an explicit equality the planner can match to the index prefix.
  where a.user_id = (select auth.uid())
  -- One row per status: at most ~20 rows, far under any max_rows cap.
  group by a.status;
$$;

-- Supabase's per-schema defaults grant new public functions to anon; a signed-out caller has nothing to count.
revoke execute on function public.application_status_counts() from anon, public;
-- The dashboard calls as the signed-in app user.
grant execute on function public.application_status_counts() to authenticated;
