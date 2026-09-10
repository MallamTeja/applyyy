/* Tests for the Supabase env decision.
 *
 * WHAT THESE PROTECT. `supabaseConfig.ts` draws a line between "not set up
 * yet" (survivable, the console still opens) and "wrong key" (fatal). That line
 * is a deliberate softening of an earlier all-or-nothing guard, so the tests
 * that matter most are the ones proving the softening did NOT reach the
 * security case. If a future change makes a non-anon key merely
 * "unconfigured", these fail.
 *
 * NO REAL KEY MATERIAL. Every token is assembled inline from a fabricated
 * payload with the literal signature `not-a-real-signature`.
 *
 * RUN: `pnpm --filter @applyy/web test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeRefusal,
  resolveSupabaseConfig,
} from '../src/data/supabaseConfig.ts';

/* --- Fake tokens ------------------------------------------------------ */

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/* Same helper as the keyRole tests, duplicated deliberately rather than shared:
 * a test helper imported across test files couples two suites, and if one
 * changes the fake token shape the other fails for a reason unrelated to what
 * it tests. Three lines of duplication is cheaper than that coupling. */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  return header + '.' + base64url(JSON.stringify(payload)) + '.not-a-real-signature';
}

const ANON_KEY = fakeJwt({ iss: 'supabase', role: 'anon' });
const SERVICE_KEY = fakeJwt({ iss: 'supabase', role: 'service_role' });
const URL = 'https://example.supabase.invalid';

/* --- The ready path --------------------------------------------------- */

test('a URL plus an anon key is ready', () => {
  const config = resolveSupabaseConfig(URL, ANON_KEY);

  assert.equal(config.kind, 'ready');
  if (config.kind !== 'ready') return;
  /* The values pass through unchanged - this module decides, it does not
     rewrite. A trimmed or normalised URL here would be a surprise for whoever
     debugs a network request later. */
  assert.equal(config.url, URL);
  assert.equal(config.anonKey, ANON_KEY);
});

/* --- THE SECURITY BRANCH, which must never be softened --------------- */

/* This is the test that guards the design decision. The whole point of this
 * module is that a MISSING key is survivable; if that leniency ever leaks into
 * the WRONG-key case, the console would boot happily with a service-role key in
 * its bundle. */
test('a service_role key is REFUSED, never treated as unconfigured', () => {
  const config = resolveSupabaseConfig(URL, SERVICE_KEY);

  /* Asserting the exact kind rather than "not ready": `unconfigured` is also
     not ready, and it is the specific wrong answer this test exists to catch. */
  assert.equal(config.kind, 'refused');
  if (config.kind !== 'refused') return;
  assert.equal(config.role, 'service_role');
});

test('an unreadable key is REFUSED, not unconfigured - it fails closed', () => {
  /* Present and non-blank, so it is not a configuration gap; undecodable, so
     its role cannot be established. "I cannot tell what this key is" must never
     be treated as permission, and must not be quietly downgraded to "not set
     up" either - that would boot the console with an unknown key. */
  for (const bad of ['not-a-jwt', 'a.b', 'a.b.c.d', 'header.!!!.sig']) {
    const config = resolveSupabaseConfig(URL, bad);
    assert.equal(config.kind, 'refused', 'key ' + JSON.stringify(bad) + ' must refuse');
    if (config.kind !== 'refused') continue;
    assert.equal(config.role, null);
  }
});

test('any role other than anon is refused', () => {
  /* An allowlist of one, not a blocklist of service_role - so a role invented
     after this file was written is refused without an edit. This is the exact
     mutation that killed 12 of 14 tests in the keyRole suite. */
  for (const role of ['service_role', 'authenticated', 'postgres', 'anon_key', '']) {
    const config = resolveSupabaseConfig(URL, fakeJwt({ role }));
    assert.equal(config.kind, 'refused', 'role ' + JSON.stringify(role) + ' must refuse');
  }
});

/* --- The survivable branch ------------------------------------------- */

test('nothing set is unconfigured, and names both variables', () => {
  const config = resolveSupabaseConfig(undefined, undefined);

  assert.equal(config.kind, 'unconfigured');
  if (config.kind !== 'unconfigured') return;
  /* Both reported from one call. Fixing a half-filled env file should not take
     two round trips through the app. */
  assert.deepEqual(config.missing, ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']);
});

test('a blank value counts as missing, not as set', () => {
  /* The commonest way a .env.local ends up half-filled: the URL gets pasted,
     the key is left for later. An empty string handed to createClient would
     produce a confusing network error instead of a clear notice. */
  for (const blank of ['', '   ', '\t']) {
    const config = resolveSupabaseConfig(URL, blank);
    assert.equal(config.kind, 'unconfigured', JSON.stringify(blank) + ' should be missing');
    if (config.kind !== 'unconfigured') continue;
    assert.deepEqual(config.missing, ['VITE_SUPABASE_ANON_KEY']);
  }
});

test('a missing URL alone is reported alone', () => {
  const config = resolveSupabaseConfig(undefined, ANON_KEY);

  assert.equal(config.kind, 'unconfigured');
  if (config.kind !== 'unconfigured') return;
  /* Only the one that is actually absent - reporting both would send the
     operator looking for a problem that is not there. */
  assert.deepEqual(config.missing, ['VITE_SUPABASE_URL']);
});

/* A missing key is checked BEFORE the role, so an absent key never reaches the
 * role check and never reports as refused. Worth asserting explicitly because
 * the ordering is what makes "absent is survivable" true. */
test('an absent key is unconfigured even though it also has no readable role', () => {
  const config = resolveSupabaseConfig(URL, undefined);
  assert.equal(config.kind, 'unconfigured');
});

/* --- The refusal message --------------------------------------------- */

/* The message is the only part of this the operator sees, and a guard that
 * fires with an unhelpful message gets worked around rather than understood. */
test('the refusal message names the role it actually found', () => {
  const message = describeRefusal('service_role');

  assert.match(message, /service_role/);
  /* Points at the plan section, so the reasoning is one lookup away rather than
     folklore. */
  assert.match(message, /section 10/i);
  /* And says what to do instead - the Edge Function route - because the
     operator hitting this genuinely may need service-role access somewhere. */
  assert.match(message, /Edge Function/);
  /* Explicitly tells the reader not to weaken the check. This is the sentence
     most likely to matter, since the person reading it is mid-deploy and
     looking for the fastest way past. */
  assert.match(message, /do not weaken/i);
});

test('an unreadable role is described as unreadable, not as null', () => {
  /* Printing "null" would suggest the token claimed the word null. "unreadable"
     tells the operator the token shape is wrong. */
  const message = describeRefusal(null);
  assert.match(message, /unreadable/);
  assert.doesNotMatch(message, /"null"/);
});
