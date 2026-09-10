/* Tests for the anon-key guard - the single check standing between a pasted
 * service-role key and a bundle Vercel serves (PROJECT_PLAN.md section 10,
 * defense 4).
 *
 * WHY THIS FILE EXISTS AT ALL, stated plainly: before it, nothing proved that
 * check fires. It looked correct, and correct-but-unproven is the same state as
 * a guard that has quietly stopped working. Worse, in this case: nothing in the
 * app imports `supabase.ts` yet, so the check is currently unreachable rather
 * than merely untested - module-level code does not run until something imports
 * the module.
 *
 * WHAT MAKES THESE TESTS ACTUALLY TEST THE GUARD, rather than testing a
 * composite of it and something else. The rule, learned from a sibling stream:
 * a test that still passes when you delete the guard it is named after was
 * never testing that guard. Redundant defences make each other untestable, so
 * isolating one needs an input only it catches. Here that is satisfied
 * structurally - `readRoleClaim` is a total pure function with no environment
 * and no second line of defence behind it, and the mutation check is recorded
 * at the bottom of this file.
 *
 * NO REAL KEY MATERIAL, EVER. Every token below is assembled inline from a
 * fabricated payload and an obviously fake signature. A random-looking secret
 * committed to a repo gets re-flagged by every future secret scan, and among
 * enough false positives nobody would notice a real one. So the signatures here
 * say what they are in words.
 *
 * RUN: `pnpm --filter @applyy/web test`, which is `node --test`. No test
 * framework and no new dependency - Node strips the types itself, which works
 * only because `erasableSyntaxOnly` in tsconfig.base.json guarantees every file
 * in this repo is type-strippable. A nice payoff from a flag that was added for
 * a different reason.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBrowserSafeKey, readRoleClaim } from '../src/data/keyRole.ts';

/* --- Building fake tokens -------------------------------------------- */

/* base64url, which is what a JWT uses: base64 with two characters swapped and
 * the padding removed. Node can do this directly, so there is no need to
 * hand-roll the translation the implementation has to do in reverse. */
function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/* Assemble a three-segment token around a given payload object.
 *
 * The signature segment is the literal words "not-a-real-signature". A real
 * signature is never needed because nothing here verifies one - and could not,
 * since verification needs the issuer's secret, which the browser must never
 * hold. */
function fakeJwt(payload: Record<string, unknown>): string {
  /* A plausible header, so the token is shaped like the real thing rather than
     passing for an unrelated reason. */
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  return header + '.' + body + '.not-a-real-signature';
}

/* --- The three inputs the guard must get right ----------------------- */

/* INPUT 1: a correctly-shaped anon key. Must pass, or the console cannot boot
 * at all and the guard is useless in the opposite direction. */
test('an anon-claimed key is accepted', () => {
  /* Extra claims present on purpose: a real Supabase key carries iss, ref, iat
     and exp alongside the role, and the reader must not care about any of
     them. A test with a one-key payload would pass even if the implementation
     required the payload to contain nothing else. */
  const token = fakeJwt({
    iss: 'supabase',
    ref: 'examplerefexampleref',
    role: 'anon',
    iat: 1_757_000_000,
    exp: 2_072_000_000,
  });

  assert.equal(readRoleClaim(token), 'anon');
  assert.equal(isBrowserSafeKey(token), true);
});

/* INPUT 2: the mistake this whole guard exists to catch. A service-role key
 * bypasses RLS entirely, so a bundle carrying one hands every visitor of the
 * deployed URL full read and write access to a database holding a resume, CTC
 * figures and personal answers. */
test('a service_role-claimed key is rejected', () => {
  const token = fakeJwt({
    iss: 'supabase',
    ref: 'examplerefexampleref',
    role: 'service_role',
    iat: 1_757_000_000,
    exp: 2_072_000_000,
  });

  /* The role is read correctly - the reader's job is to report, not to
     sanitise. */
  assert.equal(readRoleClaim(token), 'service_role');
  /* And the named predicate refuses it. Asserting both separates "read the
     claim wrong" from "read it right and allowed it anyway", which are
     different bugs with the same symptom. */
  assert.equal(isBrowserSafeKey(token), false);
});

/* INPUT 3: THE CASE THAT USUALLY GETS MISSED. An unreadable key must fail
 * CLOSED. The tempting implementation shrugs at a token it cannot parse and
 * carries on, which would admit a key precisely when we understand it least.
 *
 * Table-driven because "malformed" is not one input - it is a family, and the
 * family members fail at different points in the function. Testing one of them
 * would leave the others unproven. */
const UNREADABLE_KEYS: ReadonlyArray<{ what: string; token: string }> = [
  /* Wrong segment count - fails the shape check before any decoding. */
  { what: 'empty string', token: '' },
  { what: 'no dots at all', token: 'notajwt' },
  { what: 'two segments', token: 'header.body' },
  { what: 'four segments', token: 'a.b.c.d' },
  /* Right shape, payload is not decodable base64url. */
  { what: 'payload is not valid base64', token: 'header.!!!not-base64!!!.sig' },
  /* Right shape, decodes cleanly, but the result is not JSON. */
  { what: 'payload decodes to plain text', token: 'header.' + base64url('hello') + '.sig' },
  /* Valid JSON, but not an object - the narrowing check has to catch this or
     the property read below would throw instead of returning null. */
  {
    what: 'payload is a JSON string, not an object',
    /* Assembled by hand rather than through fakeJwt, because the payload is
       deliberately not an object and fakeJwt takes one. This is the case that
       would make an unnarrowed property read throw. */
    token: 'header.' + base64url('"anon"') + '.not-a-real-signature',
  },
  /* Valid JSON object with no role at all. */
  { what: 'payload has no role claim', token: fakeJwt({ iss: 'supabase', ref: 'exampleref' }) },
  /* A role that is not a string. The dangerous variant: if the implementation
     returned it unnarrowed, a comparison against 'anon' would be false here by
     luck rather than by design - and a different comparison might not be. */
  { what: 'role is a number', token: fakeJwt({ role: 42 }) },
  { what: 'role is null', token: fakeJwt({ role: null }) },
  { what: 'role is an object', token: fakeJwt({ role: { name: 'anon' } }) },
];

for (const { what, token } of UNREADABLE_KEYS) {
  test('fails closed when the role cannot be read: ' + what, () => {
    /* null, not a string. The caller turns this into a refusal to boot, and it
       reports it as role "unreadable" rather than pretending it saw a role. */
    assert.equal(readRoleClaim(token), null);
    /* The load-bearing assertion of this whole file: unreadable is NOT safe.
       An implementation that treated "cannot tell" as "probably fine" would
       pass every other test in this file. */
    assert.equal(isBrowserSafeKey(token), false);
  });
}

/* --- A role that is neither anon nor service_role -------------------- */

/* Supabase issues other roles, and future ones are not knowable from here. The
 * predicate is an ALLOWLIST of one, so anything unrecognised is refused without
 * this file needing to enumerate what exists. A blocklist of 'service_role'
 * would have admitted every role invented after it was written. */
test('any role other than anon is refused, not just service_role', () => {
  const token = fakeJwt({ role: 'authenticated' });

  assert.equal(readRoleClaim(token), 'authenticated');
  assert.equal(isBrowserSafeKey(token), false);
});

/* MUTATION CHECK: see the note appended at the end of this file. */

/* --- Mutation check: MEASURED, not predicted ------------------------- */

/* A test file cannot prove its own tests are load-bearing, so the check was run
 * by hand and this is the recorded output rather than an expectation.
 *
 * MUTATION APPLIED: `isBrowserSafeKey` changed from `=== 'anon'` (an allowlist
 * of one) to `!== 'service_role'` (a blocklist) - the plausible wrong
 * implementation, and the one a reviewer would most likely wave through.
 *
 * MEASURED RESULT: 14 tests, 2 passed, 12 failed.
 *   SURVIVED: "an anon-claimed key is accepted" and "a service_role-claimed key
 *             is rejected".
 *   KILLED:   all eleven fail-closed cases, plus the 'authenticated' case.
 *
 * THE POINT, and the reason this note is here instead of a silent green tick:
 * THE TWO TESTS THAT SURVIVED ARE THE TWO ANYONE WOULD HAVE WRITTEN. Right key
 * passes, wrong key fails - both satisfied by a guard with a hole in it wide
 * enough to admit an unreadable key and every role Supabase invents from now
 * on. The tests that caught it are the ones for inputs nobody thinks to write.
 *
 * Restated as a rule worth reusing: a test that still passes when you break the
 * thing it is named after was never testing that thing. The only way to know
 * which of your tests are load-bearing is to break the code on purpose and see
 * which ones notice.
 */
