/* Storing an accepted master profile, and reading what the database said back.
 *
 * WHY THE UI OWNS THIS CALL AND `@applyy/master-ingest` DOES NOT. That package
 * is pure by charter - "no network, no database, no clock, no randomness" - and
 * that purity is what lets Deno, Node and the browser all import it and what
 * makes a wrong reconciliation reproducible from three inputs. Pushing the
 * insert down into it would buy nothing and cost that property. So the
 * reconciler decides what the next version IS, and this file is the only place
 * that makes it real.
 *
 * WHY THE CLASSIFIER IS SPLIT FROM THE CALL. Everything below the fold is a
 * pure function from an unknown error to a named outcome, and it is the part
 * that can be subtly wrong. The impure half is four lines that cannot be tested
 * without a database and does not need to be. Same split as `keyRole.ts` and
 * `masterIngest.ts`: separate the decision from the side effect, because the
 * decision is the part with the bugs in it.
 *
 * THE THING THIS FILE EXISTS TO GET RIGHT. Postgres reports a re-upload of an
 * unchanged profile as an ERROR - 23505, unique_violation. It is not one. Teja
 * re-exports from Overleaf and re-uploads whenever he adds a project; landing on
 * a profile he has already stored is the ordinary case, not a mistake, and a red
 * failure banner for it teaches him that this screen cries wolf. The whole
 * review surface depends on him still reading it by the third re-upload
 * (`masterReview.ts` header), so a false alarm here is not a cosmetic problem -
 * it spends the credibility the safety property runs on.
 *
 * ---------------------------------------------------------------------------
 * THE STATE OF THE DATABASE THIS RUNS AGAINST, verified 2026-09-11 11:50.
 *
 * `20260910212600_enforce_master_profile_content_hash.sql` IS APPLIED. So the
 * `assign_content_hash` BEFORE INSERT trigger computes the digest, and
 * `UNIQUE (user_id, content_hash)` is live - which means `identical` below is a
 * REACHABLE outcome on the ordinary path, not a hypothetical.
 *
 * HOW THAT WAS ESTABLISHED, because the obvious sources all say otherwise and
 * the next reader will hit them too. This file's first draft carried a
 * `schema_behind` branch for a `23502 not_null_violation`, on the reasoning that
 * the migration was unapplied. Two documents supported that and both were
 * misread:
 *
 *   - The migration's own banner says "THIS SQL HAS NEVER BEEN PARSED BY
 *     POSTGRES". True when written at 21:26 on 2026-09-10, false by the time it
 *     was read - a file describing its own deployment state goes stale the
 *     moment it is deployed, and nothing updates it.
 *   - `docs/audit/2026-09-10-schema-invariants-verified.md:265` verifies seven
 *     applied migrations and does not mention this one. But that audit is
 *     timestamped 19:00 and this migration was written at 21:26, so its silence
 *     was evidence the DOC PREDATED THE FILE, not evidence the file was
 *     unapplied. An absence only means something if the source could have
 *     observed the thing.
 *
 * The artifact that actually settles it is the remote migration history table -
 * `supabase db push` offers only migrations absent from it, and on 2026-09-11 it
 * offered `220800` and `114300` and NOT `212600`. `verification-traps.md`
 * instance 11 is "the migration files and the live database disagree"; the
 * correction is that A DOCUMENT ABOUT LIVE STATE IS ALSO JUST A FILE.
 *
 * Consequence for this file: there is deliberately NO `23502` branch. The
 * trigger is live, so that condition is unreachable, and a named error branch
 * for an impossible state is a false claim about the system that whoever reads
 * it next will believe.
 * ---------------------------------------------------------------------------
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { MasterProfile } from '../../data/contract';

/* --- The constraint names, which are the actual discriminators ---------- */

/* THE CONSTRAINT THAT MEANS "YOU HAVE ALREADY STORED THIS".
 *
 * Named as a constant and matched on, rather than treating every 23505 as
 * "identical", because `master_profiles` carries TWO unique constraints and
 * they mean opposite things. Collapsing them would report a concurrent-version
 * collision - a retryable race - as "nothing changed, you are done", which
 * silently discards a real edit. The code alone cannot tell them apart; only
 * the constraint name can. */
const CONTENT_HASH_CONSTRAINT = 'master_profiles_user_content_hash_key';

/* THE CONSTRAINT THAT MEANS "SOMEONE ELSE INSERTED WHILE YOU WERE DECIDING".
 *
 * `assign_version` computes max(version)+1 in a BEFORE INSERT trigger, and
 * `20260910212600...sql:60-64` spells out the division of labour: the trigger is
 * convenience, the constraint is the guarantee. Two inserts racing can both
 * compute the same next version and only this constraint stops the second. It
 * is a retry, not a duplicate. */
const VERSION_CONSTRAINT = 'master_profiles_user_version_key';

/* --- Postgres codes, named so a branch reads as its meaning ------------- */

/* A unique constraint was violated. Which one is decided above. */
const UNIQUE_VIOLATION = '23505';
/* RLS refused the row. `insert own profile version` requires the `authenticated`
   role and `auth.uid() = user_id`, and PROGRESS.md records that no Auth user
   exists in this system yet - so this is the expected outcome of pressing Accept
   on a console nobody has signed into. */
const INSUFFICIENT_PRIVILEGE = '42501';

/* --- What happened ------------------------------------------------------ */

/* The outcome of trying to store, as a closed set of MEANINGS rather than as an
 * error string.
 *
 * A DISCRIMINATED UNION rather than `{ ok, error }` for the same reason
 * `IngestResult` is one: the caller renders a different sentence, in a different
 * tone, for every branch, and a boolean plus a message would let it render the
 * confirmation copy over a genuine failure. Adding a branch later is a compile
 * error at every call site, which is the behaviour wanted from something that
 * decides whether Teja is told "saved" or "nothing to do". */
export type StoreOutcome =
  /* The row landed. `version` is what the database assigned, read back rather
     than predicted - the trigger owns that number and a client guess would be
     wrong exactly during the race `version_race` describes. */
  | { readonly kind: 'stored'; readonly version: number }
  /* THE CONFIRMATION CASE, AND THE REASON THIS FILE IS SHAPED THIS WAY. The
     profile is byte-identical to one already stored. Postgres calls this an
     error; the interface must not. */
  | { readonly kind: 'identical' }
  /* Another insert took this version number first. Retryable, and distinct from
     `identical` because the content DID change and dropping it would lose an
     edit. */
  | { readonly kind: 'version_race' }
  /* Nobody is signed in, so RLS refused the row. Separated from a generic
     failure because it is not a bug and not data loss - the accepted profile is
     still in the page and can be stored once there is a session. */
  | { readonly kind: 'not_authenticated' }
  /* Everything else, with whatever the database said. Deliberately keeps the
     raw message: an unclassified failure is exactly when a reader needs the
     original text rather than this file's interpretation of it. */
  | { readonly kind: 'failed'; readonly message: string };

/* --- The pure half ------------------------------------------------------ */

/* Why an insert was refused, in words for a person. A literal per named outcome, so a new
   outcome in the union fails to compile here instead of reading as a generic failure.
   Moved here from attestSkill.ts (2026-11-01) when the Master Profile page's add forms
   needed the same sentences: this file owns StoreOutcome, so it owns their wording. */
export function storeRefusalMessage(stored: Exclude<StoreOutcome, { kind: 'stored' }>): string {
  // The database's own words for an unclassified failure.
  if (stored.kind === 'failed') return stored.message;
  // This exact master content already exists as an older version (unique content hash).
  if (stored.kind === 'identical') return 'an identical master profile version already exists';
  // Two saves raced for the next version number; a retry resolves it.
  if (stored.kind === 'version_race') return 'another master profile save happened at the same moment; try again';
  // The only outcome left: RLS refused the insert.
  return 'you are not signed in';
}

/* The shape of a PostgREST error, narrowed structurally rather than imported.
 *
 * Structural because this must survive being handed a thrown `Error`, a null, a
 * network failure, or a PostgrestError - the classifier's whole job is that it
 * is never the thing that throws. Importing the nominal type would let the
 * compiler believe `code` is present on a value that came off the wire. */
function readErrorFields(error: unknown): {
  readonly code: string | null;
  readonly message: string;
} {
  /* Not an object at all - a thrown string, a null rejection. Nothing to read,
     so it classifies as an unknown failure with a stringified body rather than
     crashing on a property access. */
  if (typeof error !== 'object' || error === null) {
    return { code: null, message: String(error) };
  }

  /* Index into it as a record. The fields may be absent, of the wrong type, or
     inherited - so every read below is guarded rather than asserted. */
  const record = error as Record<string, unknown>;

  /* `code` is a string on PostgrestError and absent on a plain Error. Anything
     non-string is treated as absent, because a numeric or object code would
     compare unequal to every constant above and silently fall through to
     `failed` - which is the right outcome, reached deliberately. */
  const rawCode = record['code'];
  const code = typeof rawCode === 'string' ? rawCode : null;

  /* The message, with `details` appended when present. THE CONSTRAINT NAME IS
     NOT ALWAYS IN `message`: PostgREST puts the human sentence in `message` and
     the constraint text in `details` depending on the failure, so searching only
     one of them makes the 23505 discrimination depend on which field the server
     happened to fill. Concatenating searches both without branching on either. */
  const rawMessage = record['message'];
  const rawDetails = record['details'];
  const message = typeof rawMessage === 'string' ? rawMessage : '';
  const details = typeof rawDetails === 'string' ? rawDetails : '';

  return { code, message: message + ' ' + details };
}

/* Turn whatever the insert rejected with into a named outcome.
 *
 * Pure and total: every input returns a `StoreOutcome`, and it never throws.
 * That totality is deliberate - this function runs inside a catch block, and a
 * classifier that can itself throw turns a handled database error into an
 * unhandled rejection that loses the profile the operator just accepted. */
export function classifyStoreFailure(error: unknown): StoreOutcome {
  const { code, message } = readErrorFields(error);

  /* The two 23505s, separated by constraint name. Checked before anything else
     because this is the branch the whole file exists for. */
  if (code === UNIQUE_VIOLATION) {
    /* Content hash first: it is the ordinary case and the version race is the
       rare one. */
    if (message.includes(CONTENT_HASH_CONSTRAINT)) {
      return { kind: 'identical' };
    }
    if (message.includes(VERSION_CONSTRAINT)) {
      return { kind: 'version_race' };
    }
    /* A 23505 naming NEITHER constraint. Deliberately NOT folded into
       `identical`: a future unique constraint on this table would otherwise
       start reporting itself as "nothing changed", which is the silent
       edit-discarding failure this whole discrimination exists to prevent.
       Falling through to `failed` shows the operator the real message. */
    return { kind: 'failed', message: message.trim() };
  }

  /* RLS. Also matches the PostgREST-level string for a missing JWT, because a
     console with no session and a console whose session lacks the row both mean
     the same thing to the person reading the screen: sign in first. */
  if (code === INSUFFICIENT_PRIVILEGE) {
    return { kind: 'not_authenticated' };
  }

  /* Unclassified. The raw text survives, trimmed of the join above. */
  return { kind: 'failed', message: message.trim() };
}

/* --- The impure half ---------------------------------------------------- */

/* What reading the current profile produced.
 *
 * `none` IS NOT AN ERROR AND MUST NOT BE RENDERED AS ONE. A user with no stored
 * profile is the first-upload case, and `reconcileMasterProfile` takes exactly
 * that as `previous: null` so it can report `no_previous_profile` for every node
 * instead of hundreds of misleading `no_candidate` entries. Collapsing `none`
 * into `failed` would make a first upload look broken; collapsing it into a
 * default empty profile would make it look like a resume that lost every
 * section. */
export type LoadOutcome =
  | { readonly kind: 'loaded'; readonly profile: MasterProfile; readonly version: number }
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly message: string };

/* Read the highest-numbered stored profile, which is the one a re-upload is
 * reconciled against.
 *
 * ORDERED BY VERSION DESCENDING, NOT BY `created_at`. The two agree today and
 * the reason to prefer version is that it is the column with the uniqueness
 * guarantee and the gapless-per-user trigger behind it - `created_at` is a
 * default that two inserts in the same millisecond can tie on. There is an index
 * on `(user_id, version desc)` precisely for this read.
 *
 * `.maybeSingle()` rather than `.single()`: zero rows is the ordinary
 * first-upload case, and `.single()` treats it as an error. */
export async function loadCurrentMasterProfile(client: SupabaseClient): Promise<LoadOutcome> {
  try {
    const { data, error } = await client
      .from('master_profiles')
      .select('profile, version')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error !== null) {
      /* Reads are not classified into named outcomes the way writes are: there
         is no read failure that means something the operator can act on
         differently, so the message survives verbatim rather than being sorted
         into branches that would all render the same sentence. */
      return { kind: 'failed', message: error.message };
    }

    /* No row. RLS scopes the select to `auth.uid() = user_id`, so this is also
       what an unauthenticated console sees - and that ambiguity is why the page
       checks for a session before deciding what this means. */
    if (data === null) {
      return { kind: 'none' };
    }

    /* The cast is the read-side twin of the one in `masterIngest`. `profile` is
       `jsonb`, so it arrives as `unknown` shaped by whatever was stored - and
       what was stored passed the ingest check before it was allowed in, which
       is the guarantee being leaned on here. */
    return {
      kind: 'loaded',
      profile: data.profile as MasterProfile,
      version: data.version as number,
    };
  } catch (thrown) {
    return {
      kind: 'failed',
      message: thrown instanceof Error ? thrown.message : 'unknown read error',
    };
  }
}

/* Insert the accepted profile as version N+1.
 *
 * WHAT IS DELIBERATELY NOT IN THE PAYLOAD, because each omission is a decision:
 *
 *   - `version`: assigned by the `assign_version` trigger as max(version)+1 per
 *     user. Supplying one would race with every other insert and would defeat
 *     the gapless-per-user guarantee the composite foreign key depends on.
 *   - `content_hash`: assigned by the `assign_content_hash` trigger, which
 *     OVERWRITES whatever a caller supplies. Computing one here would be worse
 *     than useless - it would have to reproduce jsonb's own normalisation (key
 *     sorting, duplicate-key dropping, whitespace folding) exactly, and a
 *     JSON.stringify digest does not, so it would be a wrong value that the
 *     database silently replaces. A value that is both unused and wrong is a
 *     landmine for whoever reads it next.
 *   - `user_id`: defaults to `auth.uid()`. Sending one would let a client
 *     nominate whose profile this is, which the RLS `with check` would refuse
 *     anyway - so sending it converts a clean default into a way to fail.
 *
 * So the payload is one column. That is the design working, not an oversight.
 */
export async function storeMasterProfile(
  client: SupabaseClient,
  profile: MasterProfile,
): Promise<StoreOutcome> {
  try {
    /* `select('version').single()` reads the assigned version back in the same
       round trip. Worth the extra clause: the confirmation says "stored as
       version 4", and a number the database actually assigned is the only one
       that is true during a concurrent insert. */
    const { data, error } = await client
      .from('master_profiles')
      .insert({ profile })
      .select('version')
      .single();

    /* PostgREST reports failure in the `error` FIELD rather than by throwing,
       so this branch - not the catch - is the one that fires for 23505. A
       caller that only wrapped this in try/catch would never see it. */
    if (error !== null) {
      return classifyStoreFailure(error);
    }

    /* Defensive: `.single()` with no error should always yield a row, but the
       type is nullable and a null here would otherwise read as version
       `undefined` in the confirmation copy. */
    if (data === null) {
      return { kind: 'failed', message: 'The insert reported no error and returned no row.' };
    }

    return { kind: 'stored', version: data.version };
  } catch (thrown) {
    /* The transport half: a dropped connection or a CORS rejection throws
       rather than returning an error field. Routed through the same classifier
       so there is ONE place that decides what an outcome means. */
    return classifyStoreFailure(thrown);
  }
}
