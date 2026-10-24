-- -----------------------------------------------------------------------------
-- search_preferences.work_authorized_countries: where may the user work without a visa?
--
-- WHY THIS EXISTS (2026-10-24, Teja's rulings). 18:44 IST: "drop everything which
-- need this us auth and set this option in system". 19:13 IST, refining it: "i am
-- ok with us jobs where i can work remotly, the jobs which needs visa and all, like
-- i need to do on side or hybrid with us based in us office is not ok", and allowed
-- = "indian + remote + india visa free countrys". Greenhouse postings for US
-- offices (Sigma, Perpay) were reaching the approval queue only to park on "are you
-- legally authorized to work in the US?". The screener's stage-0b work-auth gate
-- (supabase/functions/_shared/screen/work-auth-gate.ts) reads this column: on-site
-- or hybrid jobs located only outside these countries are dropped; remote jobs are
-- kept wherever they are.
--
-- WHY A search_preferences COLUMN, NOT A NEW filter_rule_type. Same reasoning as
-- the tech gate's 2026-09-17 decision: a new enum value needs ALTER TYPE ... ADD
-- VALUE (unusable in the transaction that adds it), an enum-parity edit in
-- packages/shared-types, and a cascade.ts implementation. A column on the table
-- the screener already loads costs none of that.
--
-- WHY A COUNTRY LIST, NOT A US YES/NO. An earlier draft of this same migration
-- (commit 5500d42, never applied) stored a boolean us_work_authorized. Teja's
-- second ruling made the question "which countries", not "the US or not", so the
-- boolean was replaced before it reached the database.
--
-- WHY NULLABLE WITH NO DEFAULT. null = never set: the gate passes everything and
-- warns. A missing answer must not become "authorised nowhere" (CLAUDE.md section
-- 6) - that would drop every on-site job for a user who never saw the setting.
-- The screener also reads an EMPTY array as never set, for the same reason.
-- -----------------------------------------------------------------------------

-- Re-runnable: a second apply is a no-op rather than an error.
alter table public.search_preferences
  add column if not exists work_authorized_countries text[];

-- What the column means, kept on the column so a reader of the schema sees it.
comment on column public.search_preferences.work_authorized_countries is
  'Countries the user may work in without a visa (English names). On-site/hybrid jobs located only elsewhere are dropped by the screener; remote jobs are kept. null or empty = never set, gate open.';

-- TEJA'S ANSWER, recorded once. Both rows belong to Teja (checked live
-- 2026-10-24: the only two auth.users are tejamallam00@ and tejamallam1233@,
-- profile country India). "Visa-free" means visa-free WORK: an Indian citizen
-- may work without a visa only in India, Nepal and Bhutan (treaty). Only null
-- rows are touched, so a re-run never overwrites a list saved from Settings
-- since. auth.uid() is NULL inside a migration, so no per-user filter is
-- possible or needed; users created after this keep null (never set).
update public.search_preferences
  set work_authorized_countries = array['India', 'Nepal', 'Bhutan']
  where work_authorized_countries is null;
