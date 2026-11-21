-- One application per ATS posting: the database refuses to start a second apply for a posting already applied to.
--
-- WHY THIS EXISTS: Canonical's greenhouse posting 5150422 was APPLIED TWICE. 8e9d58ce ("Web Frontend Engineer - JS,
-- CSS, React, Flutter") was applied on 2026-11-11; a scout inserted the same posting retitled ("Web Engineer - JS, TS,
-- Flutter", 111d1ff4) on 11-16, it was approved on 11-18 and applied again the same day. Every code guard missed it:
-- the screener's twin check then keyed on company + title (the title had changed), the ATS-key check (fa315449)
-- landed two days after the insert and runs at insert only, the auditor's W2 checks came on 11-21, and the apply path
-- (approved -> applying, the applier) checked nothing. A code check can always be skipped by the next path someone
-- adds; this makes the double apply unrepresentable at the one place every apply passes through.
--
-- WHY A TRIGGER, NOT A UNIQUE INDEX: the key (provider + ATS job id) lives on jobs, the status on applications. An
-- index cannot span two tables, and the key is not a column of applications.
--
-- THE RULE: when a row moves INTO 'applying' (a real transition: old.status is distinct from 'applying', so a re-save
-- never blocks itself), it is refused with errcode 23505 if another application of the same user, whose job has the
-- same lower(btrim(ats_provider)) + btrim(ats_job_id), is in a SUBMITTED-OR-SUBMITTING status:
--   applying, blocked_needs_human, needs_verification, applied, employer_screening, oa_pending, interview, offer, rejected.
-- The list is explicit on purpose: application_status_transitions makes EVERY status reachable from 'applying'
-- (re-open edges, e.g. interview -> applied and the human re-tailor edges), so "later in the graph" cannot be derived.
-- It is the set of statuses that mean a submission happened or is in flight. The orchestrator's draft named
-- applying/blocked_needs_human/applied; the post-apply statuses are added because the original here sat at 'interview'
-- on 11-11..11-12, and a twin reaching 'applying' then would have passed a three-status list. NOT in the list:
-- 'failed' (a failed attempt may be retried), 'approved' (two approved copies may both wait; the FIRST to start
-- applying wins, and the second is refused when it tries).
--
-- EXEMPT: a job Teja pasted himself (discovered_via contains 'manual'), exactly as every automatic gate skips it;
-- a job without a usable key (no ATS id, a blank provider, or the 'other' aggregator provider), which has no posting
-- identity to compare. Human edges straight INTO 'applied' (approved/blocked_needs_human/needs_verification/
-- interview/discovered -> applied) are not touched: they are Teja's own act and never pass through 'applying'.
--
-- CONCURRENCY: a BEFORE UPDATE check cannot see another transaction's UNCOMMITTED 'applying' row, so two parallel
-- claims of twin rows would both pass. The trigger therefore takes pg_advisory_xact_lock on (user | provider | ATS id)
-- BEFORE its lookup: a second same-posting move waits until the first transaction ends. The lookup is its own SQL
-- statement in a volatile plpgsql function, so under READ COMMITTED it takes a fresh snapshot after the wait and sees
-- the first row's committed 'applying'. Moves for different postings never wait on each other.
--
-- ERRCODE 23505 (unique_violation): this IS a uniqueness rule, so a caller reads it as "duplicate", never as a
-- permission problem (42501) or a crash. Worker handling (row stays approved and is reported) is a separate change.
--
-- DEPLOY: DB-only, no code depends on it. Re-runnable: create or replace, drop trigger if exists.
-- Undo: drop trigger guard_one_application_per_posting on public.applications; drop function
-- public.guard_one_application_per_posting();

-- The check, run per row before the status write.
create or replace function public.guard_one_application_per_posting()
  -- A trigger function.
  returns trigger
  -- Procedural: a lock, a lookup, a conditional raise.
  language plpgsql
  -- Fixed search_path, so no caller can shadow a name; every reference below is schema-qualified.
  set search_path = ''
as $$
declare
  -- The posting key of the row being moved.
  v_provider text;
  -- Its ATS job id.
  v_ats_id text;
  -- Pasted by Teja himself.
  v_manual boolean;
  -- The application already submitted for the same posting, if any.
  v_twin uuid;
begin
  -- Only a real move into 'applying'; every other update (including a re-save at 'applying') passes untouched.
  if new.status::text <> 'applying' or old.status is not distinct from new.status then
    -- Nothing to check.
    return new;
  end if;
  -- The posting identity, normalised exactly as the screener's atsJobKeyOf (lower + trim provider, trim id).
  select lower(btrim(j.ats_provider::text)), btrim(j.ats_job_id), 'manual' = any(j.discovered_via::text[])
    into v_provider, v_ats_id, v_manual
    from public.jobs j
   where j.id = new.job_id;
  -- No usable key, or Teja's own pasted job: nothing to compare, or his call to make.
  if v_ats_id is null or v_ats_id = '' or v_provider is null or v_provider in ('', 'other') or coalesce(v_manual, false) then
    -- Allowed.
    return new;
  end if;
  -- Serialise same-posting moves across transactions (see CONCURRENCY above), held to the end of this transaction.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text || '|' || v_provider || '|' || v_ats_id, 0));
  -- Another application of this user, for the same posting, already submitted or submitting.
  select a.id
    into v_twin
    from public.applications a
    join public.jobs j on j.id = a.job_id
   where a.user_id = new.user_id
     and a.id <> new.id
     and lower(btrim(j.ats_provider::text)) = v_provider
     and btrim(j.ats_job_id) = v_ats_id
     -- Submitted or in flight (the explicit list in the header; 'failed' and 'approved' are deliberately absent).
     and a.status::text in ('applying', 'blocked_needs_human', 'needs_verification', 'applied', 'employer_screening', 'oa_pending', 'interview', 'offer', 'rejected')
   limit 1;
  -- A twin: refused as a duplicate, naming both rows and the posting.
  if v_twin is not null then
    -- 23505, so callers treat it as "already applied", never as a crash or a permission problem.
    raise exception 'application % is a second apply for posting %:% (already submitted as application %)', new.id, v_provider, v_ats_id, v_twin
      using errcode = '23505';
  end if;
  -- Allowed.
  return new;
end;
$$;

-- Re-runnable: drop then create (bare create trigger has no if-not-exists).
drop trigger if exists guard_one_application_per_posting on public.applications;
-- BEFORE UPDATE OF status, per row: the check sees old and new and can refuse the write.
create trigger guard_one_application_per_posting
  before update of status on public.applications
  -- One check per moved row (claims move rows one advance_application_status call at a time).
  for each row execute function public.guard_one_application_per_posting();
