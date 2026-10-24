-- -----------------------------------------------------------------------------
-- search_preferences.us_work_authorized: may the user work in the US?
--
-- WHY THIS EXISTS (2026-10-24, Teja's ruling, 18:44 IST): "drop everything which
-- need this us auth and set this option in system like yes or no". Teja is in
-- India with no US work authorisation, and Greenhouse postings for US-only roles
-- (Sigma, Perpay) were reaching the approval queue only to park on "are you
-- legally authorized to work in the US?". The screener's stage-0 work-auth gate
-- (supabase/functions/_shared/screen/work-auth-gate.ts) reads this column.
--
-- WHY A search_preferences COLUMN, NOT A NEW filter_rule_type. Same reasoning as
-- the tech gate's 2026-09-17 decision: a new enum value needs ALTER TYPE ... ADD
-- VALUE (unusable in the transaction that adds it), an enum-parity edit in
-- packages/shared-types, and a cascade.ts implementation. A column on the table
-- the screener already loads costs none of that.
--
-- WHY NULLABLE WITH NO DEFAULT. Three states, and they mean different things:
--   true  = authorised: the gate never drops anything.
--   false = not authorised: postings that NEED US authorisation are dropped.
--   null  = never answered: the gate passes everything and warns. A missing
--           answer must not become "no" (CLAUDE.md section 6) - that would
--           silently drop every US job for a user in the US who never saw the
--           setting. A `default false` would do exactly that.
-- -----------------------------------------------------------------------------

-- Re-runnable: a second apply is a no-op rather than an error.
alter table public.search_preferences
  add column if not exists us_work_authorized boolean;

-- What the column means, kept on the column so a reader of the schema sees it.
comment on column public.search_preferences.us_work_authorized is
  'true = authorised to work in the US (citizen, green card or work visa); false = not, and the screener drops postings that need it; null = unanswered, gate open.';

-- TEJA'S ANSWER, recorded once. Both rows belong to Teja (checked live
-- 2026-10-24: the only two auth.users are tejamallam00@ and tejamallam1233@,
-- profile country India), so every EXISTING row gets his "no". Only null rows are
-- touched, so a re-run never overwrites an answer saved from the Settings page
-- since. auth.uid() is NULL inside a migration, so no per-user filter is possible
-- or needed; users created after this keep null (unanswered).
update public.search_preferences
  set us_work_authorized = false
  where us_work_authorized is null;
