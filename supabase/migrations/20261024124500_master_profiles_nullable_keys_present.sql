-- -----------------------------------------------------------------------------
-- master_profiles: every nullable display key must be PRESENT (null or text).
--
-- WHY THIS EXISTS (2026-10-24). The contract (shared-types MasterProfile) types
-- nine display fields as `string | null` - a REQUIRED key holding a nullable
-- value. master_profiles v2 was stored with two achievements carrying NO
-- `description` key at all. Every reader casts this jsonb to MasterProfile and
-- trusts the type, so the hole travelled: the Tailor copied it into a
-- tailored_profile, and the approval queue's resume renderer crashed on it
-- ("Cannot read properties of undefined (reading 'replace')"). The same hole in
-- experience.location or education.field crashes nothing - it PRINTS
-- "B.Tech, undefined" onto the PDF that gets submitted (CLAUDE.md section 6).
--
-- The app now fills absent keys with null before insert (commit a9e803a,
-- masterIngest.withExplicitNulls; the PDF extractor already wrote null), and
-- every reader treats absent as null. This constraint is the backstop that makes
-- the hole UNREPRESENTABLE at the one table every master passes through, so a
-- future writer that forgets cannot reintroduce it. Do not "simplify" it away
-- because the app already normalises: the app is the thing it guards against.
--
-- WHY NOT VALID. Master versions are immutable and pinned by applications, so
-- v2 cannot be repaired in place - and must not be. NOT VALID skips the existing
-- rows and enforces every NEW row. Never run VALIDATE CONSTRAINT while v2 exists:
-- it would fail, and that failure is correct.
--
-- TRAP FOR A FUTURE MIGRATION. A NOT VALID check is still evaluated on any
-- UPDATE of an existing row, whichever column changes. Updates are forbidden by
-- the forbid_update trigger and by RLS (no update policy), but migration
-- 20260910212600 once disabled that trigger to backfill content_hash on every
-- row. A backfill like that would now FAIL on v2. Such a migration must exclude
-- rows that violate this check, or drop and re-add the constraint around it.
--
-- WRITERS AUDITED 2026-10-24: the only writer is an INSERT
-- (apps/web/src/features/settings/masterStore.ts storeMasterProfile). No code
-- path UPDATEs master_profiles.profile.
--
-- PRE-CHECKED LIVE 2026-10-24 ~12:40 IST (read-only): the achievements path
-- returns false for v1 and TRUE for v2, so the jsonpath matches the real hole
-- and is not vacuous.
--
-- `!(exists(@.key))` in a jsonpath filter is true when the key is ABSENT; a
-- present key holding JSON null counts as existing, which is exactly the
-- distinction the contract draws. Lax mode makes a missing section array match
-- nothing - a missing section is checkMasterProfile's job, not this check's.
--
-- ROLLBACK (no data to restore; the constraint only refuses future inserts):
--   alter table public.master_profiles
--     drop constraint if exists master_profiles_nullable_keys_present;
-- -----------------------------------------------------------------------------

-- Re-runnable: a bare `add constraint` errors if it already exists, and dropping
-- first re-adds the identical definition (CLAUDE.md section 7, re-runnability).
alter table public.master_profiles
  drop constraint if exists master_profiles_nullable_keys_present;

-- One clause per place a nullable key lives; each is "no node lacks the key".
alter table public.master_profiles
  add constraint master_profiles_nullable_keys_present check (
    -- The three optional identity lines.
    not jsonb_path_exists(profile, '$.identity ? (!(exists(@.headline)) || !(exists(@.phone)) || !(exists(@.location)))')
    -- A role's location: the "Acme, undefined" silent-print field.
    and not jsonb_path_exists(profile, '$.experience[*] ? (!(exists(@.location)))')
    -- A degree's field of study and grade.
    and not jsonb_path_exists(profile, '$.education[*] ? (!(exists(@.field)) || !(exists(@.grade_display)))')
    -- The undated entries' detail line: the live v2 hole.
    and not jsonb_path_exists(profile, '$.achievements[*] ? (!(exists(@.description)))')
    -- Same field, the second undated section.
    and not jsonb_path_exists(profile, '$.certifications[*] ? (!(exists(@.description)))')
  ) not valid;

-- The constraint explains itself to anyone reading the schema rather than this file.
comment on constraint master_profiles_nullable_keys_present on public.master_profiles is
  'Every nullable display key (identity headline/phone/location, experience.location, education field/grade_display, achievement/certification description) must be present, as null or text. NOT VALID: v2 (2026-10-24) predates it and is immutable; never VALIDATE while it exists. See migration 20261024124500.';
