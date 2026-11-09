# `applications.ats_keyword_coverage`: where it came from, and a drop draft (2026-11-09)

**Status: awaiting Teja's ruling. Nothing applied, nothing dropped.**
Asked in `docs/handoff/2026-11-08-1745-pending-tasks.md` item 11: "0 of 35,945 rows filled, no
reader or writer. Teja asked why it exists."

## Verdict

The column is an **unused storage slot for a feature that shipped another way.** It was
created on day one as the stored home for plan item 7, "ATS keyword coverage %". No agent ever
wrote it. The web computes the same figure live from the tailored resume and the JD keywords
(the "ATS score" chip), so the column never got a writer.

**Recommendation: drop it**, together with the four code references below in one commit. It
holds no data, nothing reads it, and its only effect today is a misleading entry in
`ApplicationRow` and `ApplicationPatch` that invites someone to start writing a second,
diverging copy of a number the web already derives.

## Evidence

### 1. It was added on purpose, by the first schema migration

The handoff said "no migration in git history adds it". **That is wrong.**
`supabase/migrations/20260909234700_core_tables.sql:368-370`, commit `10b0336` (Teja Mallam,
2026-09-10 15:19 IST, "add schema migrations with RLS and transition guard…"):

```sql
  -- Shown on the diff view so you can see whether the tailoring did anything at all.
  ats_keyword_coverage numeric(5, 2)
    check (ats_keyword_coverage is null or (ats_keyword_coverage >= 0 and ats_keyword_coverage <= 100)),
```

The plan item it serves, `PROJECT_PLAN.md:1003`: "7. **ATS keyword coverage %** displayed on the
diff view, so you can see whether the tailoring actually did anything." `PROJECT_PLAN.md:1016`
marks it done as an "ATS chip and keyword panel in `apps/web/src/features/approval/`", which is
the client-side computation, not this column.

`git log --all -S ats_keyword_coverage` lists only these commits that touch code:

| Commit | What it did with the name |
| --- | --- |
| `0cd33a8` (monorepo setup) | Declared it in `packages/shared-types/src/tables.ts` |
| `10b0336` | Created the column (above) |
| `e6dc314` ("partial agent loop scaffolding, incomplete and untested") | Added it to `ApplicationPatch` in `_shared/agent/port.ts:143` and a `null` in `fixtures.ts:51` |

No commit ever added a writer and later removed it. The rest of the hits are docs.

### 2. The live catalog (read 2026-11-09 ~16:50 IST, read-only)

One `select` over `pg_attribute`, `pg_constraint`, `pg_proc`, `pg_views`, `pg_indexes`,
`pg_trigger` and `supabase_migrations.schema_migrations`. The row it returned:

| Field | Value |
| --- | --- |
| `attnum` / type | 15 of 32, `numeric(5,2)`, between `audit_findings` (14) and `resume_storage_path` (16), the same order as the migration |
| column comment | `null` |
| non-null rows | **0 of 36,045** |
| constraints naming it | `applications_ats_keyword_coverage_check` only |
| migrations whose statements name it | `20260909234700 core_tables` only |
| functions / views / indexes naming it | none / none / none |
| triggers on `applications` | `guard_failed_rerun`, `guard_status_insert`, `guard_status_transition`, `guard_tailored_profile_freeze`, `log_status_change`, `set_updated_at` (none reads the column) |

`attnum` 15 sitting in its migration position means it was created with the table, not added
later by hand in Studio.

### 3. Code that still names it (all inert)

- `packages/shared-types/src/tables.ts:581` (`ApplicationRow`) and `:668` (the union of
  agent-writable columns)
- `supabase/functions/_shared/agent/port.ts:143` (`ApplicationPatch`; no agent sets it)
- `supabase/functions/_shared/agent/fixtures.ts:51` (a `null` in a test fixture)

No reference in `worker/`, `apps/web/src/` or any function's `index.ts`.

## The drop, as a draft (not in `supabase/migrations/`)

The brief asked for the draft at `supabase/migrations/20261109170000_drop_ats_keyword_coverage.sql`.
**It is kept here instead, on purpose.** With the file in `supabase/migrations/`, the shared-types
test "column parity — every Row type has exactly the columns its table has in the migrations"
fails (29 tests, 1 fail), because `tables.ts` still declares the column. Removing the file
makes it pass again (29/29). Committed there, the draft would turn CI red. It would also be
listed by the next `db push`. So the draft, the `tables.ts` edit and the `port.ts`/`fixtures.ts`
edits must land **in one commit**, after Teja approves.

To apply after approval: save the SQL below as that file, delete the guard block, remove the four
code references above in the same commit, then run the shared-types tests and `db push --dry-run`.

```sql
-- Why this migration exists: applications.ats_keyword_coverage was created on 2026-09-10
-- (10b0336, migration 20260909234700_core_tables.sql:369) as the stored home for plan item 7,
-- "ATS keyword coverage % displayed on the diff view" (PROJECT_PLAN.md:1003). No agent ever
-- wrote it: the web computes the figure live instead (coveragePercent in
-- apps/web/src/features/approval/diffModel.ts, the "ATS score" chip). Live on 2026-11-09:
-- 0 of 36,045 rows non-null, no function, view, index or trigger names it; only its CHECK
-- constraint does. Evidence: docs/status/2026-11-09-ats-keyword-coverage.md.

-- The draft guard. Teja's approval = delete this block, nothing else.
do $$
begin
  -- Refuse to run: a migration pushed by mistake must change nothing.
  raise exception 'DRAFT migration 20261109170000 is awaiting Teja; remove the guard to apply';
end
$$;

-- Fail fast instead of queueing behind a long transaction holding a lock on applications.
set lock_timeout = '5s';

-- Drop only when still empty: if anything has started writing it, data loss is not this file's call.
do $$
declare
  -- Rows holding a value at the moment of the drop.
  filled bigint;
begin
  -- Count non-null values; 0 is the measured state on 2026-11-09.
  select count(*) into filled from public.applications where ats_keyword_coverage is not null;
  -- Any value means a writer appeared since the evidence was taken: stop, do not drop data.
  if filled > 0 then
    -- Rolls back the whole migration.
    raise exception 'applications.ats_keyword_coverage has % non-null rows; refusing to drop', filled;
  end if;
end
$$;

-- The drop. `if exists` keeps a re-run harmless; the CHECK constraint goes with the column.
alter table public.applications drop column if exists ats_keyword_coverage;

-- Back to the role default, so nothing later in this session inherits the short timeout.
reset lock_timeout;
```

**Keeping it instead** costs nothing at runtime (a null `numeric` per row). The real cost is the
type surface: `ApplicationPatch` advertises a field that nothing fills.

## Applied

Applied by the orchestrator 2026-11-09 ~17:08 IST from pinned worktree a3ef168 (dry-run listed exactly 20261109120000). Post-check: information_schema shows 0 rows for applications.ats_keyword_coverage. Teja approved the drop at 17:02 IST.
