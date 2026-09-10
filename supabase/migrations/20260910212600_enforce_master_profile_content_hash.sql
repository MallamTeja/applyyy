-- =============================================================================
-- ⚠️  UNVALIDATED — THIS SQL HAS NEVER BEEN PARSED BY POSTGRES.
--
-- Written 2026-09-10 21:26 with Docker down, so no `supabase db reset` could run
-- against it. Committed anyway, deliberately: a migration FILE in git and an
-- APPLIED migration are different things, nothing in this repo auto-applies
-- migrations, and Vercel's git connection touches only the frontend. Leaving it
-- uncommitted in a working tree that four other sessions are staging around was
-- judged the larger risk.
--
-- DO NOT let this reach the database until `supabase db reset` has executed it
-- locally. It is the third migration queued in that state — the two before it also
-- carry empty `remote` entries — and the accumulating hazard is that the FIRST
-- execution of all three would be against the live database, which is the exact
-- condition a full day of work was spent escaping.
--
-- Most likely places for it to be wrong, so a reviewer knows where to look: the
-- `disable trigger` / `enable trigger` pair around the backfill, and whether
-- `pg_catalog.sha256(bytea)` resolves under `search_path = ''` as expected.
-- =============================================================================

-- =============================================================================
-- Make `master_profiles.content_hash` real.
--
-- WHY THIS EXISTS: `20260909234700_core_tables.sql:119` says of the column
-- "Digest of `profile`, so an edit that changed nothing does not mint a version."
-- That described an intent with no mechanism. A whole-repository search found
-- `content_hash` in exactly three places: the column declaration, and two fields
-- in `packages/shared-types/src/tables.ts`. No trigger computed it, no constraint
-- deduped on it, no index covered it, and no code ever wrote it.
--
-- It was worse than merely unenforced. The column is `not null` with no default
-- and nothing computing it, so every caller had to supply something and nothing
-- checked that the something was a digest of anything. A caller passing 'x'
-- satisfied the schema. So the field could not dedupe, and could not even be
-- trusted as a description of its own row — a later reader who DID dedupe on it
-- would inherit whatever the first caller happened to invent.
--
-- This is the same failure family the migrations have already been corrected for
-- twice: a comment asserting an invariant that no mechanism enforces. A comment
-- is not a constraint. The fix is to make the database compute the value and
-- refuse the duplicate, so the guarantee no longer depends on a caller reading
-- prose.
--
-- WHY A NEW FILE rather than editing the original: applied migrations are
-- immutable. Supabase records them and never re-reads them, so a logic change
-- has to arrive as a new migration.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Compute the digest from the row itself, so the caller cannot get it wrong.
--
-- BEFORE INSERT, and it OVERWRITES whatever the caller supplied rather than
-- filling in only when absent. Trusting a supplied value would preserve the exact
-- defect being fixed: the point is not that callers forget the hash, it is that a
-- caller-supplied hash is unverifiable. Computing it unconditionally makes a wrong
-- one unrepresentable instead of merely discouraged.
--
-- Division of labour, copied deliberately from `assign_master_profile_version`
-- directly above this table: the TRIGGER provides convenience, the UNIQUE
-- CONSTRAINT provides the guarantee. Two concurrent inserts of the same profile
-- can both compute the same digest and both pass the trigger; only the constraint
-- can actually stop the second one landing.
-- -----------------------------------------------------------------------------
create or replace function applyy_internal.assign_master_profile_content_hash()
returns trigger
language plpgsql
-- Empty search_path so a schema planted on the caller's path cannot shadow a
-- function this trigger resolves. Same hardening every other function here uses.
set search_path = ''
as $$
begin
  -- `new.profile` is `jsonb`, NOT `json`, and that distinction is what makes this
  -- digest stable. `jsonb` does not store the document as typed: it sorts object
  -- keys, drops duplicate keys, and discards insignificant whitespace on the way
  -- in. So two semantically identical profiles that arrived with different key
  -- order or formatting are already the SAME jsonb value, and `::text` renders
  -- them identically. Hashing `json` or a raw request body instead would make the
  -- digest depend on how the client happened to serialise, which is exactly the
  -- silent non-determinism that would make this constraint fire at random.
  --
  -- Known residual edge, recorded rather than hidden: jsonb preserves numeric
  -- SCALE, so 1.0 and 1.00 are distinct jsonb values and hash differently. That
  -- is correct-but-surprising. It cannot affect this table today because
  -- MasterProfile carries no numeric fields, and if it ever gains one the fix
  -- belongs in the ingest normaliser, not here — the digest should reflect what
  -- was stored, not quietly disagree with it.
  --
  -- sha256() is a PostgreSQL built-in from version 11 onward, so this needs no
  -- pgcrypto and adds no extension dependency. convert_to() pins the encoding
  -- explicitly so the digest cannot shift with a database or client encoding
  -- setting.
  new.content_hash := encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(new.profile::text, 'UTF8')
    ),
    'hex'
  );

  -- Hand the completed row back to the insert.
  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- Backfill any rows that already exist, before the constraint is added.
--
-- Written defensively rather than skipped. The table is expected to be empty —
-- no Auth users exist yet, and `user_id` defaults to `auth.uid()` — but "expected
-- to be empty" is an assumption, and a migration that is only correct when an
-- assumption holds is the kind that fails at 2am against the one database nobody
-- checked. If there are zero rows this is a no-op that costs nothing.
--
-- The trigger disable is REQUIRED, not defensive: `forbid_update` on this table
-- rejects every UPDATE by design (immutability, half one of two), so a plain
-- backfill would be refused by the table's own guarantee. Disabling it for the
-- length of this statement is the narrowest possible exception, and it is
-- re-enabled immediately below. Migrations run in a single transaction, so a
-- failure anywhere in this file rolls the disable back with everything else —
-- the trigger cannot be left off.
-- -----------------------------------------------------------------------------
alter table public.master_profiles disable trigger forbid_update;

update public.master_profiles
   set content_hash = encode(
         pg_catalog.sha256(
           pg_catalog.convert_to(profile::text, 'UTF8')
         ),
         'hex'
       )
 -- Unconditional: a pre-existing value cannot be verified, so it is replaced
 -- rather than kept. There is no "already correct" case worth detecting, because
 -- detecting it would mean recomputing the digest anyway.
 where true;

alter table public.master_profiles enable trigger forbid_update;


-- -----------------------------------------------------------------------------
-- The guarantee itself.
--
-- Scoped to (user_id, content_hash) rather than content_hash alone: two different
-- people may legitimately hold identical profiles, and a global uniqueness rule
-- would make one user's upload fail because of a row they cannot see — a failure
-- that is both wrong and undiagnosable from inside RLS.
--
-- BEHAVIOUR THIS CHANGES, stated plainly because callers must handle it: a
-- re-upload of an unchanged profile now RAISES 23505 (unique_violation) instead of
-- silently minting version N+1. That is deliberate. The column comment promised
-- that a no-op edit does not mint a version, and failing loudly is the only
-- version of that promise a caller can actually act on. Ingest should catch 23505
-- (or use `on conflict do nothing`) and report "identical to the current version,
-- nothing to do" — which is information the user wants, not an error.
--
-- KNOWN CONSEQUENCE, flagged rather than discovered later: this also forbids
-- REVERTING to an earlier profile, because the earlier version's digest is still
-- present. Reverting is not part of the stated workflow — profiles are re-uploaded
-- from Overleaf as material is ADDED — so the trade is worth taking today. If
-- revert is ever wanted, the fix is a partial unique index over only the latest
-- version per user, not dropping this constraint.
--
-- If this statement FAILS on deploy, it is telling the truth: it means two rows
-- for one user already hold byte-identical profiles, i.e. a no-op upload already
-- minted a version. Fix the data, do not weaken the constraint.
-- -----------------------------------------------------------------------------
alter table public.master_profiles
  add constraint master_profiles_user_content_hash_key unique (user_id, content_hash);


-- -----------------------------------------------------------------------------
-- Fire the trigger before the row lands.
--
-- Named `assign_content_hash` to match `assign_version` beside it. Both are
-- BEFORE INSERT and PostgreSQL fires same-timing triggers in name order, so
-- `assign_content_hash` runs first — which is harmless either way, because the two
-- write different columns and neither reads the other's output. Recorded so that
-- nobody later "fixes" an ordering dependency that does not exist.
-- -----------------------------------------------------------------------------
create trigger assign_content_hash
  before insert on public.master_profiles
  for each row execute function applyy_internal.assign_master_profile_content_hash();


-- -----------------------------------------------------------------------------
-- Correct the original column comment, which is now true.
--
-- The old comment described behaviour that did not exist. Leaving it in place
-- while adding the mechanism elsewhere would be the same defect in a new form: a
-- reader would find a prose claim and no way to tell whether this migration or
-- that sentence was the current truth. COMMENT ON lives in the catalog, so it
-- travels with the database rather than with whichever file someone opens.
-- -----------------------------------------------------------------------------
comment on column public.master_profiles.content_hash is
  'sha256 of profile::text, computed by the assign_content_hash BEFORE INSERT '
  'trigger and never accepted from the caller. UNIQUE per (user_id, content_hash), '
  'so re-inserting an unchanged profile raises 23505 rather than minting a version. '
  'Stable because profile is jsonb, which normalises key order and whitespace on '
  'the way in. Added by migration 20260910212600 after the original column comment '
  'was found to assert this behaviour with nothing implementing it.';
