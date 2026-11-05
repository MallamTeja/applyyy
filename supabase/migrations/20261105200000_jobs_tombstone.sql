-- 20261105200000_jobs_tombstone.sql — the jobs TOMBSTONE space policy (P0, 2026-11-05).
--
-- WHY THIS EXISTS. On 2026-11-05 the database measured 514 MB against the 500 MB Free
-- Plan quota; past it, Supabase flips the project READ-ONLY and every scout insert,
-- status change and email intake fails. `jobs` was 473 MB of that, almost all TOAST:
-- the description text and raw board JSON of ~34,000 postings, 99% of which the
-- screener had already REJECTED (`applications.status = 'dropped_filter'`).
--
-- WHY A TOMBSTONE AND NEVER A ROW DELETE (Teja, 2026-11-05 15:27). The slim row is what
-- stops tomorrow's scan re-inserting a rejected job as brand new: scouts dedupe on
-- (user_id, fingerprint), so deleting the row deletes the memory of the rejection, and
-- the next poll would screen, store and pay for it all over again. So the row stays —
-- id, fingerprint, ats_job_id, apply_url, company, title, location, first/last_seen,
-- disappeared_at, description_hash — and only the heavy payload goes. The verdict
-- stays where it already lives, in applications.drop_reason.
--
-- WHAT THIS MIGRATION DOES (schema + one function; it moves NO data by itself):
--   1. jobs.tombstoned_at — the explicit "payload purged, re-fetch before reading the
--      text" state. Non-null IS needs_refetch. Never an empty string standing in for it
--      (CLAUDE.md §6: a blank that looks like data becomes an answer).
--   2. CHECK jobs_tombstone_is_slim — a tombstone holding a payload is unrepresentable.
--   3. BEFORE UPDATE trigger jobs_keep_tombstone_slim — EDGE CASE 1, re-discovery. Both
--      scouts (scout-ats and the worker's persist-jobs) re-upsert every re-sighted posting
--      with ON CONFLICT DO UPDATE and the full rebuilt row, and job-link-intake writes a
--      pasted job's text. Without this trigger, every scan that sees a tombstoned
--      posting again would write its payload straight back and the space would return
--      on each run. The trigger lives in the DATABASE, not in _shared/screen/upsert-plan.ts,
--      because (a) the planner is pure and cannot see stored state, and (b) one guard
--      here covers every writer — three today, in three different files — including
--      ones written later. A writer that genuinely wants the text back (a revive)
--      says so by clearing tombstoned_at in the same UPDATE.
--   4. public.tombstone_dropped_jobs(min_age_days, batch_size) — the one function both
--      the one-time back-fill and the weekly schedule call, in small batches.
--
-- WHY THE TRIGGER SILENTLY KEEPS NULL INSTEAD OF RAISING. A raise would fail the WHOLE
-- scout upsert batch (one request per key-set group, often hundreds of rows) because a
-- single row in it was a tombstone — trading a space leak for a discovery outage. The
-- CHECK below still raises for any path that bypasses the trigger (e.g. an INSERT
-- carrying both a tombstone and a payload), so the invariant is enforced either way.
--
-- RE-RUNNABLE: every statement is guarded (if not exists / or replace / drop if exists),
-- because a half-applied run of this file must be safe to repeat.

-- 1. The tombstone marker. Nullable with no default: every existing row is live, and a
--    default would back-date a tombstone onto rows that still hold their payload.
alter table public.jobs add column if not exists tombstoned_at timestamptz;

-- Documented in the catalog, where the next reader of the table will look first.
comment on column public.jobs.tombstoned_at is
  'Non-null = TOMBSTONE: description_raw and raw_payload were purged by tombstone_dropped_jobs() '
  'and this row is in the needs_refetch state. Readers must treat the text as ABSENT, never as '
  'an empty JD. A writer restoring the text must clear this column in the same UPDATE, or the '
  'jobs_keep_tombstone_slim trigger discards the text. 20261105200000.';

-- 2. The invariant, as a constraint rather than a comment (CLAUDE.md §6). Guarded by a
--    catalog check because Postgres has no `add constraint if not exists`.
do $$
begin
  -- Only add it when absent, so a re-run of this file is a no-op instead of an error.
  if not exists (
    -- Scoped to this table: a same-named constraint elsewhere must not satisfy the check.
    select 1 from pg_constraint
    where conname = 'jobs_tombstone_is_slim' and conrelid = 'public.jobs'::regclass
  ) then
    -- A tombstone is exactly "marker set AND both heavy columns empty". Validates the
    -- existing rows too, which pass trivially: none has tombstoned_at set yet.
    alter table public.jobs
      add constraint jobs_tombstone_is_slim
      check (tombstoned_at is null or (raw_payload is null and description_raw is null));
  end if;
end $$;

-- 3. EDGE CASE 1. Keeps a tombstone slim against every writer that re-sends the payload.
create or replace function public.jobs_keep_tombstone_slim()
returns trigger
language plpgsql
-- Empty search_path: a trigger function must not resolve names through a schema a
-- caller could have shadowed. It names nothing outside NEW anyway.
set search_path = ''
as $$
begin
  -- Still a tombstone after this UPDATE (either it was one and the writer did not clear
  -- the marker — a scout re-sighting — or this UPDATE is the tombstoning itself):
  -- whatever payload the writer sent is discarded, so the space cannot come back.
  if new.tombstoned_at is not null then
    -- The raw board JSON, the larger of the two (~5.3 KB/row sampled 2026-11-05).
    new.raw_payload := null;
    -- The JD text (~3.8 KB/row sampled). NULL, never '': a blank must not read as a JD.
    new.description_raw := null;
  end if;
  -- Hand the (possibly slimmed) row on to the rest of the UPDATE.
  return new;
end;
$$;

-- Drop-then-create so a re-run replaces the trigger rather than erroring on the name.
drop trigger if exists jobs_keep_tombstone_slim on public.jobs;
-- BEFORE, so the slimmed row is what gets written and what the CHECK sees; FOR EACH ROW,
-- because the decision is per row. No column list on purpose: a writer that sends
-- description_raw without naming tombstoned_at is exactly the case to catch.
create trigger jobs_keep_tombstone_slim
  before update on public.jobs
  for each row execute function public.jobs_keep_tombstone_slim();

-- 4. The tombstoning itself. One function for the one-time back-fill (run by the
--    orchestrator as `postgres`) and the weekly schedule (run as the app user).
create or replace function public.tombstone_dropped_jobs(p_min_age_days integer, p_batch_size integer)
returns integer
language plpgsql
-- INVOKER, not definer: as the app user, RLS ("own jobs") scopes it to that user's rows
-- and it grants nothing the user could not already do with a plain UPDATE; as postgres
-- (the back-fill) it covers every row, which is what a one-time back-fill wants.
security invoker
-- Same shadowing defence as the trigger; every name below is schema-qualified.
set search_path = ''
as $$
declare
  -- How many rows this call tombstoned; the caller loops until it gets fewer than asked.
  v_count integer;
begin
  -- Fail closed on a nonsense age: 0 or negative would tombstone rows dropped seconds
  -- ago, and NULL would make the interval NULL and the WHERE silently match nothing.
  if p_min_age_days is null or p_min_age_days < 1 then
    -- Loud, so a bad workflow input is a red run rather than a quiet no-op.
    raise exception 'tombstone_dropped_jobs: p_min_age_days must be >= 1, got %', p_min_age_days;
  end if;
  -- Batch bounds: the app user's API statement_timeout is short (seconds) and postgres's
  -- is 2 min, so an unbounded batch is a timeout waiting to happen. 5000 is the ceiling.
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 5000 then
    -- Same reasoning: a refused call beats an accidental whole-table rewrite.
    raise exception 'tombstone_dropped_jobs: p_batch_size must be 1..5000, got %', p_batch_size;
  end if;

  -- Pick one batch, oldest drop first, then slim exactly those rows.
  with picked as (
    -- Only the job id is needed; the payload is never read except to hash it below.
    select j.id
    from public.jobs j
    -- The verdict lives on the application, so the join is how "dropped" is known.
    join public.applications a on a.job_id = j.id
    -- Teja 15:31: NEVER touch non-dropped rows. Only a screener/matcher/human rejection.
    -- This one filter is the whole rule: applications is unique on (user_id, job_id) and
    -- jobs are per user, so a job has exactly one application and no live sibling exists.
    where a.status = 'dropped_filter'
      -- Age of the VERDICT, not of the posting: a job dropped yesterday keeps its text for
      -- the grace window even if it was first seen months ago.
      and a.status_changed_at < now() - make_interval(days => p_min_age_days)
      -- Not already a tombstone, so every call makes progress and a re-run is a no-op.
      and j.tombstoned_at is null
    -- Oldest verdicts first: they are the least likely to be revived.
    order by a.status_changed_at
    -- One bounded batch per call.
    limit p_batch_size
    -- Lock both rows so a concurrent revive (a paste moving the application out of
    -- dropped_filter) cannot interleave; SKIP LOCKED so a busy row is just left for the
    -- next call instead of blocking this one.
    for update of j, a skip locked
  )
  update public.jobs j
  set
    -- Keep a digest of the text being purged, so a later re-fetch can tell "same JD" from
    -- "changed JD". Only filled when empty; an existing digest is never overwritten.
    description_hash = coalesce(
      j.description_hash,
      -- NULL text hashes to NULL (sha256 is strict), so a row with no JD stays digest-less.
      encode(sha256(convert_to(j.description_raw, 'UTF8')), 'hex')
    ),
    -- NULL, never '' (edge case 3): an empty string would read as a real-but-blank JD.
    description_raw = null,
    -- The raw board JSON; recoverable by re-polling the board if a parser ever needs it.
    raw_payload = null,
    -- The needs_refetch marker. Set last so the trigger sees the row as a tombstone.
    tombstoned_at = now()
  -- Restrict the update to the picked batch.
  from picked
  -- Join on the primary key.
  where j.id = picked.id;

  -- Rows actually changed; under SKIP LOCKED this can be below the batch size even
  -- when more remain, so callers stop only on 0.
  get diagnostics v_count = row_count;
  -- Reported to the caller, which logs it.
  return v_count;
end;
$$;

-- Callable by the signed-in app user (the weekly workflow) and nobody anonymous.
revoke all on function public.tombstone_dropped_jobs(integer, integer) from public, anon;
-- The workflow signs in as the app user, exactly like keepalive.yml; no service role.
grant execute on function public.tombstone_dropped_jobs(integer, integer) to authenticated;
-- No grant/revoke on jobs_keep_tombstone_slim(): Postgres refuses to call a trigger
-- function outside a trigger, so there is nothing to lock down, and touching its
-- privileges would only risk breaking every UPDATE on jobs.
