-- A failed application must say why: the table refuses status 'failed' with a null or blank failure_reason
-- (2026-11-09).
--
-- WHY THIS EXISTS: on 2026-11-09, 29 of the 91 failed rows had failure_reason null; the cause sat only in a 'note'
-- event, so a reader of the row saw "no reason". Migration 20261109180000 made advance_application_status refuse a
-- move to failed without p_detail.reason and write it to the row. That closes ONE door. This CHECK closes every
-- door: a direct UPDATE, a future SQL function, an orchestrator data-fix, a re-created function that loses the
-- guard. CLAUDE.md §6: make the wrong answer unrepresentable, not merely discouraged. Mirrors
-- applications_blocked_has_reason (status 'blocked_needs_human' requires block_reason).
--
-- WHY BLANK TOO, NOT ONLY NULL: a null-check passes '' (CLAUDE.md §6), and advance_application_status already
-- refuses a whitespace-only reason, so the table should agree with it.
-- WHY THE COALESCE: a CHECK passes when its predicate is NULL, not only when it is TRUE. For a failed row with a null
-- reason, `pg_catalog.btrim(failure_reason) <> ''` is null, and `false or null` is null: PASS. coalesce turns the
-- null into '' so the comparison is FALSE and the row is refused.
--
-- DEPLOY ORDER: this migration ships AFTER the failure_reason back-fill (27 rows from their same-call note event,
-- plus the 2 rows that have no note: 3c476629, 0fcd296f). The orchestrator runs both, then a pre-flight
-- `select count(*) from public.applications where status = 'failed' and coalesce(pg_catalog.btrim(failure_reason),
-- '') = ''` must return 0, then `db push`. Applied too early, VALIDATE fails and the whole file rolls back: safe,
-- nothing half-applied.
--
-- WHY NOT VALID THEN VALIDATE: ADD ... NOT VALID enforces every new write at once without scanning the table;
-- VALIDATE then checks the rows already there. In one file both run in one transaction, so the lock saving is nil
-- here; the split is kept because the VALIDATE line is the explicit, separately-failing proof that the back-fill
-- left zero violators.
--
-- RE-RUN: `add constraint` has no `if not exists`. Re-running this file fails on the existing name, which is the
-- correct answer for an applied migration.

-- New writes are checked from this statement on. coalesce turns a null reason into '' so a null fails exactly like
-- a blank one; without it, `false or null` is null and a CHECK lets null through.
alter table public.applications
  add constraint applications_failed_has_reason
  check (status <> 'failed' or pg_catalog.btrim(coalesce(failure_reason, '')) <> '')
  not valid;

-- The rows already in the table are checked here. Any failed row still missing a reason aborts the migration.
alter table public.applications
  validate constraint applications_failed_has_reason;

-- The schema explains the rule to whoever reads it without this file.
comment on constraint applications_failed_has_reason on public.applications is
  'A failed row must carry a non-blank failure_reason. advance_application_status writes it from p_detail.reason (20261109180000); this CHECK covers every other writer. See migration 20261109211000.';
