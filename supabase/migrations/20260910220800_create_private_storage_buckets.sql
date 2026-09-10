-- =============================================================================
-- The two storage buckets, both PRIVATE, with owner-scoped access.
--
-- WHY THIS EXISTS: nothing in the first ten migrations ever declared a bucket.
-- Verified against the live database before writing this — `select count(*) from
-- storage.buckets` returned **0**. The worker's `uploadScreenshot()` calls
-- `storage.from('screenshots').upload(...)`, which fails at runtime with
-- `Bucket not found`.
--
-- WHAT THAT ACTUALLY COST, which is more than a missing bucket: §18.6's
-- trust-building dry-run period is "run three days with DRY_RUN=true, review the
-- screenshots of what WOULD have been sent, then flip the flag". The screenshots
-- had nowhere to land. **That evidence trail has never worked and could not have
-- worked** — so the one mechanism designed to earn trust before granting
-- authority was inoperable, and the failure would have appeared only on a real
-- run against real Supabase. It typechecks. It tests green against the fake
-- gateway. Nothing in the repo could have caught it.
--
-- WHY PRIVATE IS NOT A DETAIL: `resumes` holds Teja's actual resume PDFs and
-- `screenshots` holds images of half-completed application forms carrying his
-- phone number, home address, current CTC and notice period. A public bucket
-- here is the same exposure class as a service_role key in a JS bundle, and it
-- would be discovered the same way — by someone else, later. `public = false` is
-- the default for a reason and it is stated explicitly here rather than omitted,
-- because a reader must be able to see the decision was made.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- The buckets.
--
-- Names match the worker's defaults exactly (`supabase-gateway.ts`:
-- `config.screenshotBucket ?? 'screenshots'`, `config.resumeBucket ?? 'resumes'`).
-- A mismatch here would reproduce the identical `Bucket not found` this migration
-- exists to fix, so the names are copied from the caller rather than chosen.
--
-- TWO buckets rather than two folders in one, following the gateway's own
-- reasoning: the artifacts have different lifetimes and different sensitivities.
-- A screenshot is disposable review evidence; a resume is the record of what was
-- actually sent to an employer. Separate buckets mean a future retention rule can
-- expire one without touching the other.
--
-- `on conflict do nothing` so re-running is safe — the same property every seed
-- in `bootstrap_user_defaults` has, and for the same reason: a migration that
-- cannot be re-run is a migration nobody dares re-run.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  -- Screenshots: PNG only. The worker uploads with `contentType: 'image/png'` and
  -- nothing else should ever land here. 10 MB is generous for a full-page
  -- screenshot of a form and small enough that a runaway loop is capped.
  ('screenshots', 'screenshots', false, 10485760, array['image/png']),
  -- Resumes: PDF only. Produced by Playwright's `page.pdf()`; the measured
  -- reference render is ~11 KB, so 5 MB is far above any legitimate output and
  -- well under Supabase's 50 MB per-file ceiling.
  ('resumes', 'resumes', false, 5242880, array['application/pdf'])
on conflict (id) do nothing;


-- -----------------------------------------------------------------------------
-- Owner scoping.
--
-- THE PATH SHAPE IS THE SECURITY BOUNDARY, so it is worth stating: the gateway
-- writes `${userId}/${applicationId}/${timestamp}.ext`, so the FIRST path segment
-- is the owning user's id. `storage.foldername(name)` splits the object name into
-- an array of segments, and `[1]` is that first one — PostgreSQL arrays are
-- 1-indexed, which is the single most likely thing to get wrong here and would
-- fail open by comparing NULL rather than erroring.
--
-- These policies are written against `storage.objects`, whose RLS Supabase
-- already enables. Deliberately NOT re-enabling it: this migration does not own
-- that table, and an `alter table ... enable row level security` on someone
-- else's table is the kind of statement that works today and breaks on a platform
-- upgrade.
--
-- Four separate policies rather than one `for all`. More verbose, and correct:
-- `for all` writes the same predicate into both `using` and `with check`, which
-- silently conflates "which rows you may see" with "which rows you may create".
-- Those are genuinely different mechanisms — the RLS proof exists precisely
-- because a `using` clause that looks right says nothing about `with check` — so
-- they are spelled out separately and can be reasoned about one at a time.
-- -----------------------------------------------------------------------------

-- READ. Scoped to the owner's own prefix, so one user's signed URL cannot be
-- pointed at another user's screenshot by editing the path.
create policy "applyy owner reads own artifacts"
  on storage.objects for select
  to authenticated
  using (
    bucket_id in ('screenshots', 'resumes')
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- WRITE. `with check` rather than `using`, because an INSERT has no existing row
-- to test — this constrains what may be CREATED. Without it, an authenticated
-- user could upload into any other user's prefix while being unable to read it
-- back: a write-only cross-tenant hole, which is exactly the asymmetry the
-- cross-tenant WRITE step of the RLS proof is designed to catch.
create policy "applyy owner writes own artifacts"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id in ('screenshots', 'resumes')
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- UPDATE. Both clauses, and they are not redundant: `using` decides which objects
-- may be targeted, `with check` decides what they may become. Omitting the second
-- would let an owner MOVE an object into someone else's prefix.
create policy "applyy owner updates own artifacts"
  on storage.objects for update
  to authenticated
  using (
    bucket_id in ('screenshots', 'resumes')
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  )
  with check (
    bucket_id in ('screenshots', 'resumes')
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- DELETE. Included so retention and re-run cleanup are possible without a
-- service-role key. Note the worker deliberately timestamps every upload rather
-- than overwriting, so that a re-run during the dry-run period cannot destroy
-- evidence Teja has not reviewed yet — deletion is an explicit act, never a
-- side effect of running again.
create policy "applyy owner deletes own artifacts"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id in ('screenshots', 'resumes')
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );


-- -----------------------------------------------------------------------------
-- What this migration deliberately does NOT do.
--
-- It does not prove the policies SCOPE. Creating a policy and having it restrict
-- the right rows are different claims, and every verifying query available here
-- runs as `postgres`, which holds BYPASSRLS — so an inverted predicate would look
-- identical in `pg_policies`. That is the project's standing top risk and these
-- four policies join the fifteen tables already waiting on it.
--
-- `supabase/functions/rls-proof/index.ts` is the mechanism; it needs two Auth
-- users that do not yet exist. **Until it runs, treat these policies as declared,
-- not as enforced** — and note the buckets are private regardless, so the failure
-- mode of a wrong predicate is a broken feature rather than an open door.
-- -----------------------------------------------------------------------------
