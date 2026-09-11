-- =============================================================================
-- applyy — add `applications.resume_sha256`.
--
-- WHY THIS COLUMN EXISTS AT ALL. `resume_storage_path` records WHERE the
-- artifact went. It cannot answer the question actually asked six months later,
-- when a recruiter quotes a line back at Teja: "is the file in that bucket the
-- file that was approved?" A path proves only that something was uploaded. The
-- digest is what makes the stored artifact checkable against the render.
--
-- WHY IT IS A SEPARATE COLUMN RATHER THAN A JSONB KEY. `apply-one.ts` already
-- passes `resume_sha256` inside the `advance_application_status` p_detail JSONB,
-- and jsonb accepts any key — so that write has always "worked" while no column
-- existed. THAT IS A TRAP, not evidence: the detail blob is an event payload
-- attached to one status transition, queryable only by digging through
-- `application_events`. It is not a property of the row, it cannot be indexed,
-- and it is absent entirely in dry run, which is the only mode this system runs
-- in today. The column is the durable fact; the jsonb key is a log line about a
-- moment. Do not delete one believing the other covers it.
-- =============================================================================

-- NULLABLE, NO DEFAULT — deliberate, and the reasoning matters more than the DDL.
--
-- NOT NULL would reject two legitimate populations at once. First, every
-- historical row: the column is new, so nothing before this migration can have a
-- value. Second, and permanently, every application that attaches no resume at
-- all — `plan-resume-attachment` returns a null target when the form asks for no
-- document, which is a normal outcome and not a defect. A constraint that
-- rejects valid states is worse than no constraint, because the workaround is
-- always to write a fake value, and a fake digest is worse than an absent one.
--
-- No default for the same reason: there is no value that truthfully stands in
-- for "we did not send a resume", and '' would silently satisfy any later
-- NOT NULL someone adds without thinking.
alter table public.applications
  add column resume_sha256 text;

-- SHAPE ONLY. Lowercase hex, exactly 64 characters — the only thing a sha256 can
-- look like. Written as `is null or ...` so the nullable case above stays legal;
-- a bare regex check would reject every resume-less application and undo the
-- whole argument for nullability.
--
-- WHAT THIS CANNOT DO, stated so nobody trusts it further than it goes: it
-- catches truncation, uppercase drift, an empty string and an accidental path,
-- but it CANNOT catch a well-formed digest of the WRONG BYTES. That failure has
-- already happened once on this project — a recorded sha256 turned out to be the
-- hash of the resume HTML STRING rather than of the rendered PDF, and it passed
-- every shape test available because it was a perfectly valid sha256. Only
-- re-hashing the stored object and comparing can establish that, and no
-- constraint can do it. This check buys legibility, not integrity.
alter table public.applications
  add constraint applications_resume_sha256_is_hex
  check (resume_sha256 is null or resume_sha256 ~ '^[0-9a-f]{64}$');

-- The column's own documentation lives in the database rather than only in this
-- file, because the next person to meet it will be reading the schema in the
-- dashboard, not reading migrations in git.
comment on column public.applications.resume_sha256 is
  'sha256 of the rendered resume PDF bytes that were uploaded to resume_storage_path. '
  'Written by the worker in the SAME update as the path, outside any status transition, '
  'so it is recorded in dry run when no transition happens. Null when no resume was '
  'attached, which is legal. Distinct from the resume_sha256 key inside '
  'application_events.detail, which is an event payload, not a property of this row.';
