-- =============================================================================
-- Reap agent_runs rows stuck at status 'running' after the agent died.
--
-- WHY. An agent opens an agent_runs row at status 'running' when it starts and closes it
-- when it finishes. A crash, a killed job or an edge-function timeout skips the close,
-- and the row stays 'running' forever: five rows from 2026-09-19 had to be closed by hand.
-- A forever-running row makes the Health page report a run that isn't happening, and it
-- hides the failure it really was.
--
-- THE CUTOFF IS 6 HOURS (live agent_runs, 2026-10-09): the longest real run is scout_ats
-- at 410 s, every other agent at most 38 s. The longest any job is ALLOWED to run is
-- apply.yml's 60-minute timeout. Six hours is 6x that ceiling, so a run that is still
-- genuinely working is never reaped. (The normalizer's recorded max of ~20 days is the
-- hand-closed bad row, not a run length.)
--
-- WHO CALLS IT. There is no scheduler (Teja ruled no cron; pg_cron is available but NOT
-- installed, and this migration does not install it). So the reaper rides on work that
-- already happens: an AFTER INSERT trigger on agent_runs reaps the SAME user's stale
-- 'running' rows of the SAME agent whenever that agent starts a new run. Self-healing on
-- the next run, no cron. The function also stands alone for a manual sweep by the owner.
--
-- WHAT A REAPED ROW SAYS: status 'failed', error_count + 1, and a note appended to
-- error_detail that carries the reap time. finished_at is deliberately LEFT NULL:
-- duration_ms is a GENERATED column (finished_at - started_at, live pg_attribute
-- attgenerated='s'), so setting finished_at = now() would stamp a fake run length of 6 h
-- or more on every reaped crash and skew every duration statistic. That is the same
-- distortion that made the normalizer's recorded max read ~20 days (CLAUDE.md §6). The
-- readers cope (2026-10-09): agentFreshness flags "stuck" only for status 'running', and
-- falls back to started_at for the run's instant; ruleWarnings skips rows with no
-- finished_at.
--
-- Re-runnable: CREATE OR REPLACE, and DROP TRIGGER IF EXISTS (public.agent_runs is owned
-- by postgres). Writes no rows itself (there are 0 'running' rows live on 2026-10-09).
-- WRITTEN, NOT APPLIED.
-- =============================================================================

-- The reaper. Returns how many rows it closed, so a caller can tell "nothing stale" (0)
-- from "closed some". INVOKER: its callers are the owner (a manual sweep) and the
-- postgres-owned definer trigger below; nobody else is granted EXECUTE.
create or replace function applyy_internal.reap_stale_agent_runs(
  -- How old a 'running' row must be to count as dead.
  p_older_than interval default interval '6 hours',
  -- Limit to one user; NULL sweeps every user (manual use only).
  p_user_id uuid default null,
  -- Limit to one agent; NULL sweeps every agent (manual use only).
  p_agent public.agent_name default null,
  -- Never touch this row: the trigger passes the run that just started.
  p_exclude_id uuid default null
)
returns integer
language plpgsql
-- Empty search_path; every name below is schema-qualified.
set search_path = ''
as $$
declare
  -- Rows closed by this call.
  v_reaped integer;
begin
  -- A short cutoff would fail runs that are still working. Refuse rather than reap them:
  -- an hour is already longer than any edge function can live.
  if p_older_than is null or p_older_than < interval '1 hour' then
    raise exception 'reap_stale_agent_runs: cutoff % is under 1 hour; refusing so live runs are not failed', p_older_than;
  end if;

  -- Close every matching run that is still 'running' past the cutoff. Idempotent: a
  -- closed row is no longer 'running', so a second call finds nothing.
  update public.agent_runs r
     -- The run did not succeed; it stopped reporting.
     -- finished_at is NOT set: see the header (duration_ms is generated from it).
     set status = 'failed',
         -- One error: "never closed". A failed row with zero errors would read as clean.
         error_count = r.error_count + 1,
         -- Appended, so any detail the agent did write survives.
         error_detail = pg_catalog.concat_ws(
           E'\n',
           r.error_detail,
           pg_catalog.format(
             'reaped: still running %s after it started; the agent never closed this run (crash, kill or timeout). Marked failed by applyy_internal.reap_stale_agent_runs at %s.',
             p_older_than, pg_catalog.now()
           )
         )
   -- Only open runs.
   where r.status = 'running'
     -- Only runs older than the cutoff.
     and r.started_at < pg_catalog.now() - p_older_than
     -- Scoped to one user when asked.
     and (p_user_id is null or r.user_id = p_user_id)
     -- Scoped to one agent when asked.
     and (p_agent is null or r.agent = p_agent)
     -- Never the run that just started.
     and (p_exclude_id is null or r.id <> p_exclude_id);

  -- How many were closed.
  get diagnostics v_reaped = row_count;
  -- Returned for the caller and the probe.
  return v_reaped;
end;
$$;

-- Owner only. applyy_internal's default privileges don't revoke PUBLIC, so revoke
-- explicitly from every role the platform grants by default.
revoke all on function applyy_internal.reap_stale_agent_runs(interval, uuid, public.agent_name, uuid)
  from public, anon, authenticated, service_role;

-- Says why it exists where a reader of the function will look.
comment on function applyy_internal.reap_stale_agent_runs(interval, uuid, public.agent_name, uuid) is
  'Marks agent_runs rows still running after p_older_than (default 6 h, minimum 1 h) as failed, with error_count+1 and an error_detail note carrying the reap time; finished_at stays NULL so the generated duration_ms is not faked. Called by trigger agent_runs_reap_stale_on_start for the same user+agent; callable by the owner for a manual sweep. See 20261009220000.';

-- The trigger function: when a run starts, reap that user's dead runs of that agent.
create or replace function applyy_internal.reap_on_agent_run_start()
returns trigger
language plpgsql
-- DEFINER: the inserting role (the app user) may not be able to UPDATE other runs under
-- RLS, and it holds no EXECUTE on the reaper. Safe: the scope is fixed to NEW's own user
-- and agent, which the inserter was already allowed to write.
security definer
-- Empty search_path; every name below is schema-qualified.
set search_path = ''
as $$
begin
  -- A nested block so a reaper failure can never stop an agent from starting its run.
  begin
    -- Same user, same agent, 6 h cutoff, never the row just inserted.
    perform applyy_internal.reap_stale_agent_runs(interval '6 hours', new.user_id, new.agent, new.id);
  exception when others then
    -- Visible in the Postgres logs; the new run still starts.
    raise warning 'reap_on_agent_run_start: stale runs not reaped for % / % (% %)', new.user_id, new.agent, sqlstate, sqlerrm;
  end;
  -- AFTER trigger: the return value is ignored.
  return null;
end;
$$;

-- A trigger function needs no client EXECUTE (checked at CREATE TRIGGER, not at fire time).
revoke all on function applyy_internal.reap_on_agent_run_start()
  from public, anon, authenticated, service_role;

-- Re-runnable: drop an earlier copy of this trigger before creating it.
drop trigger if exists agent_runs_reap_stale_on_start on public.agent_runs;

-- AFTER INSERT, FOR EACH ROW: runs once per new run, after it exists, so excluding it by id
-- is exact.
create trigger agent_runs_reap_stale_on_start
  after insert on public.agent_runs
  for each row execute function applyy_internal.reap_on_agent_run_start();
