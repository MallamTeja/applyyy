-- Drop the dead column applications.ats_keyword_coverage (2026-11-09; Teja approved it to the orchestrator at 17:02 IST).
--
-- Why this migration exists: applications.ats_keyword_coverage was created on 2026-09-10
-- (10b0336, migration 20260909234700_core_tables.sql:369) as the stored home for plan item 7,
-- "ATS keyword coverage % displayed on the diff view" (PROJECT_PLAN.md:1003). No agent ever
-- wrote it: the web computes the figure live instead (coveragePercent in
-- apps/web/src/features/approval/diffModel.ts, the "ATS score" chip). Live on 2026-11-09:
-- 0 of 36,045 rows non-null. pg_depend shows its CHECK constraint
-- (applications_ats_keyword_coverage_check) as its only dependent: no function, view, policy,
-- index or trigger names it. A column nobody writes reads as "coverage unknown" to the next
-- person who finds it, which invites a second, competing source for the same number.
-- Evidence: docs/status/2026-11-09-ats-keyword-coverage.md.
--
-- Shipped together with the removal of the column from packages/shared-types/src/tables.ts and
-- supabase/functions/_shared/agent/{port,fixtures}.ts, so the column-parity test stays green.
-- Do not "restore" the column without a writer for it; re-adding it brings back the dead field.

-- Fail fast instead of queueing behind a long transaction that holds a lock on applications.
-- The drop needs an ACCESS EXCLUSIVE lock, and a queued one blocks every reader behind it.
set lock_timeout = '5s';

-- Drop only while the column is still empty: if something has started writing it, losing that data is not this file's call.
do $$
declare
  -- Rows holding a value at the moment of the drop.
  filled bigint;
begin
  -- Count the non-null values; 0 is the state measured on 2026-11-09.
  select count(*) into filled from public.applications where ats_keyword_coverage is not null;
  -- Any value means a writer appeared after the evidence was taken: stop, and drop no data.
  if filled > 0 then
    -- Raising rolls back the whole migration, so nothing is half-done.
    raise exception 'applications.ats_keyword_coverage has % non-null rows; refusing to drop', filled;
  end if;
end
$$;

-- The drop. `if exists` makes a re-run harmless. The single-column CHECK constraint
-- applications_ats_keyword_coverage_check is dropped with the column.
alter table public.applications drop column if exists ats_keyword_coverage;

-- Back to the role default, so nothing later in this session inherits the short lock timeout.
reset lock_timeout;
