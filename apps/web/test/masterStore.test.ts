/* Tests for the master-profile store seam.
 *
 * WHAT THESE PROTECT. `classifyStoreFailure` decides whether Teja is told
 * "saved", "already stored, nothing to do", or "that failed". Postgres reports
 * a re-upload of an unchanged profile as an ERROR - 23505 - and it is not one;
 * it is the ordinary case, because he re-exports from Overleaf whenever he adds
 * a project. Getting that branch wrong in either direction is expensive:
 *
 *   - Calling a real failure "identical" silently discards an edit.
 *   - Calling "identical" a failure teaches him this screen cries wolf, and the
 *     review list it sits under is the only actual defence in the design.
 *
 * THE ONE THAT NEEDS THE MOST CARE, and the reason half this file exists:
 * `master_profiles` carries TWO unique constraints. `..._user_content_hash_key`
 * means "you already stored this"; `..._user_version_key` means "someone
 * inserted while you were deciding", which is a RETRY with real changed content
 * behind it. Both raise 23505. The code alone cannot tell them apart - only the
 * constraint name can - so a classifier that keys on the code is wrong in a way
 * that passes every rejection-only test.
 *
 * NON-VACUITY IS THE ORGANISING PRINCIPLE HERE. A classifier that returned
 * `identical` for every 23505 would satisfy any test that only ever asserts the
 * content-hash case. `docs/verification-traps.md` instance 13 names this shape
 * exactly - "the vacuous expectation, and the twin that fixes it" - and instance
 * 22's lesson is the same one a layer up. So every "this is identical" test
 * below is paired with an input that must NOT classify as identical, and the
 * pair is what carries the information.
 *
 * WHAT THESE TESTS DO NOT PROVE, stated plainly because the distinction is the
 * whole point of `verification-traps.md`. They exercise the MAPPING from an
 * error object to an outcome. They do not prove Postgres raises 23505, that the
 * constraint exists, or that the trigger computes the digest - those are
 * properties of the database, and no unit test can reach them. The constraint is
 * live (migration 20260910212600 is applied), so an end-to-end test is now
 * possible; it is deliberately not written here. See the note at the foot of
 * this file for why.
 *
 * RUN: `pnpm --filter @applyy/web test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyStoreFailure } from '../src/features/settings/masterStore.ts';

/* --- Builders --------------------------------------------------------- */

/* The two real constraint names, spelled out once. Written as literals rather
   than imported from the source: a test that imports the constant it is
   checking passes when the constant is wrong, which is the same shape as a test
   asserting a count against the walk that produced it. These strings are copied
   from the migration, not from the module under test. */
const CONTENT_HASH_KEY = 'master_profiles_user_content_hash_key';
const VERSION_KEY = 'master_profiles_user_version_key';

/* A PostgREST-shaped error. Partial-with-defaults so each test states only the
   field it is about. */
function pgError(over: Partial<{ code: string; message: string; details: string }> = {}) {
  return {
    code: '23505',
    message: 'duplicate key value violates unique constraint',
    details: '',
    hint: null,
    ...over,
  };
}

/* --- The 23505 discrimination, which is the point of the module ------- */

test('a duplicate content hash is a confirmation, not a failure', () => {
  const outcome = classifyStoreFailure(
    pgError({
      message: 'duplicate key value violates unique constraint "' + CONTENT_HASH_KEY + '"',
    }),
  );

  assert.equal(outcome.kind, 'identical');
});

/* THE TWIN THAT MAKES THE TEST ABOVE MEAN SOMETHING. Same code, same message
 * shape, different constraint - and it must NOT be "identical". A classifier
 * that keyed on 23505 alone would pass the test above and fail this one, which
 * is precisely the discrimination being asserted.
 *
 * The consequence of getting it wrong is not cosmetic: a version race means the
 * content DID change, so reporting "nothing to do" discards a real edit and
 * tells the operator it was intentional. */
test('a version collision is a retry, NOT "already stored"', () => {
  const outcome = classifyStoreFailure(
    pgError({
      message: 'duplicate key value violates unique constraint "' + VERSION_KEY + '"',
    }),
  );

  assert.equal(outcome.kind, 'version_race');
});

/* THE THIRD LEG, and the one a two-way test would miss. A 23505 naming NEITHER
 * known constraint must fall through to `failed` rather than being assumed to
 * be the content hash. A future unique constraint on this table would otherwise
 * start reporting itself as "nothing changed" - the silent edit-discarding
 * failure, arriving through a door nobody opened deliberately. */
test('an unrecognised unique violation is reported, never assumed to be a duplicate', () => {
  const outcome = classifyStoreFailure(
    pgError({
      message: 'duplicate key value violates unique constraint "some_future_key"',
    }),
  );

  assert.equal(outcome.kind, 'failed');
  /* And the operator gets the database's own words, because an unclassified
     failure is exactly when this module's interpretation is worth least. */
  assert.match(outcome.kind === 'failed' ? outcome.message : '', /some_future_key/);
});

/* PostgREST does not always put the constraint name in `message` - it lands in
 * `details` depending on the failure. Searching only one field would make the
 * whole discrimination above depend on which field the server happened to fill,
 * which is a coin flip nobody would notice losing. */
test('the constraint name is found in details, not only in message', () => {
  const outcome = classifyStoreFailure(
    pgError({
      message: 'duplicate key value violates a unique constraint',
      details: 'Key (user_id, content_hash)=(...) already exists in ' + CONTENT_HASH_KEY + '.',
    }),
  );

  assert.equal(outcome.kind, 'identical');
});

/* --- The other named outcome ------------------------------------------ */

test('an RLS refusal is reported as not signed in, not as a failure', () => {
  const outcome = classifyStoreFailure(
    pgError({ code: '42501', message: 'new row violates row-level security policy' }),
  );

  assert.equal(outcome.kind, 'not_authenticated');
});

/* NON-VACUITY TWIN for the branch above: a code that is NOT 42501 must not be
 * reported as an auth problem, or "sign in and try again" becomes the advice
 * for every database error there is. */
test('a non-privilege error is not reported as a sign-in problem', () => {
  const outcome = classifyStoreFailure(
    pgError({ code: '23514', message: 'new row violates check constraint' }),
  );

  assert.equal(outcome.kind, 'failed');
});

/* --- Totality: the classifier runs inside a catch and may never throw -- */

/* A classifier that can itself throw turns a handled database error into an
 * unhandled rejection, which loses the profile the operator just accepted and
 * reviewed. `assert.doesNotThrow` is the assertion that matters here; the
 * returned kind is secondary. */
const HOSTILE_INPUTS: readonly { readonly what: string; readonly value: unknown }[] = [
  { what: 'null', value: null },
  { what: 'undefined', value: undefined },
  { what: 'a string', value: 'boom' },
  { what: 'a number', value: 500 },
  { what: 'an array', value: [] },
  { what: 'an empty object', value: {} },
  { what: 'a plain Error with no code', value: new Error('network down') },
  /* A `code` of the wrong TYPE. Treated as absent rather than coerced: a
     numeric code would compare unequal to every constant and fall through to
     `failed`, which is the right answer reached deliberately rather than by
     accident. */
  { what: 'a numeric code', value: { code: 23505, message: CONTENT_HASH_KEY } },
  { what: 'an object whose message is not a string', value: { code: '23505', message: 42 } },
];

for (const { what, value } of HOSTILE_INPUTS) {
  test('does not throw on ' + what, () => {
    assert.doesNotThrow(() => classifyStoreFailure(value));
    /* And it always returns a usable outcome rather than undefined, since the
       caller renders one of these unconditionally. */
    const outcome = classifyStoreFailure(value);
    assert.ok(typeof outcome.kind === 'string' && outcome.kind.length > 0);
  });
}

/* The numeric-code case deserves its own assertion rather than only the
 * no-throw one: coercing it would make `{ code: 23505 }` classify as
 * `identical` purely because the message mentions the constraint, which is a
 * type confusion that reads as correct. */
test('a numeric code is treated as absent, not coerced to the string form', () => {
  const outcome = classifyStoreFailure({ code: 23505, message: CONTENT_HASH_KEY });

  assert.equal(outcome.kind, 'failed');
});

/* A plain Error whose MESSAGE happens to contain the constraint name must not
 * be read as a duplicate. The code is the gate; the name only disambiguates
 * within 23505. Without this, a transport error quoting a failed query string
 * could be reported as "already stored, nothing to do". */
test('the constraint name alone does not make something a duplicate', () => {
  const outcome = classifyStoreFailure(
    new Error('request failed while inserting into ' + CONTENT_HASH_KEY),
  );

  assert.equal(outcome.kind, 'failed');
});

/* --- Why there is no end-to-end test here ------------------------------
 *
 * The constraint is live, so an end-to-end 23505 test is now technically
 * possible: insert a profile twice and assert the second attempt comes back as
 * `identical`. It is deliberately not written, and the reason is not cost.
 *
 * `master_profiles` carries a `forbid_delete` trigger. Rows are immutable and
 * undeletable by design - that is half of what makes resume pinning still true
 * six months later. So a test that inserts a profile CANNOT CLEAN UP AFTER
 * ITSELF. Every run would leave a permanent, unremovable row in the live
 * database, and `docs/audit/2026-09-10-schema-invariants-verified.md:277` already
 * records the standing rule for live-database tests: they must clean up their
 * own rows, must fail loudly if cleanup does not complete, and must never run
 * against a populated database. An insert into this table can satisfy none of
 * those.
 *
 * The honest summary is that the mapping is unit-tested here and the database
 * behaviour is guaranteed by the constraint rather than by a test. That is a
 * real gap, named rather than papered over - which is the distinction
 * `verification-traps.md` exists to keep visible.
 */
