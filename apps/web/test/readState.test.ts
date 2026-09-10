/* Tests for read-state classification.
 *
 * WHAT THESE PROTECT. That the four causes of "no rows on screen" stay four
 * distinct states. The failure mode is not a crash - it is a confident `0` that
 * means "nobody is signed in", read by an operator as "the automation found
 * nothing today". Those two look identical on screen and demand opposite
 * responses.
 *
 * So the tests worth writing here are the ones that would fail if any two
 * states were ever collapsed, plus the ordering tests - because the ordering is
 * what stops a failed query being reported as an empty result.
 *
 * RUN: `pnpm --filter @applyy/web test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRead,
  describeEmptyState,
  isConclusive,
} from '../src/data/readState.ts';
import type { ReadFacts } from '../src/data/readState.ts';

/* A fully healthy read, as a base for overriding one fact at a time.
 *
 * Built as a function returning a fresh object so no test can mutate the
 * fixture another test depends on. Overriding ONE field per test is what makes
 * each test name true - "a failed read" should differ from the happy path in
 * exactly the failure. */
function facts(overrides: Partial<ReadFacts<string>> = {}): ReadFacts<string> {
  return {
    clientPresent: true,
    missingEnv: [],
    signedIn: true,
    loading: false,
    error: null,
    rows: ['a', 'b'],
    ...overrides,
  };
}

/* --- The happy path -------------------------------------------------- */

test('a successful read with rows reports rows', () => {
  const state = classifyRead(facts());

  assert.equal(state.kind, 'rows');
  if (state.kind !== 'rows') return;
  assert.deepEqual(state.rows, ['a', 'b']);
});

/* --- THE FOUR CAUSES OF EMPTY, which must stay four --------------- */

/* This is the heart of the module. Each of these produces "nothing to show" and
 * each must produce a DIFFERENT state, because the operator's response differs:
 * set env vars / wait / sign in / investigate an error / accept there is no
 * work. */
test('no client is unconfigured, not empty', () => {
  const state = classifyRead(
    facts({ clientPresent: false, missingEnv: ['VITE_SUPABASE_URL'], rows: null }),
  );

  /* Asserting the exact kind, not merely "not rows": `empty` is also not rows,
     and it is the specific wrong answer this test exists to catch. */
  assert.equal(state.kind, 'unconfigured');
  if (state.kind !== 'unconfigured') return;
  assert.deepEqual(state.missingEnv, ['VITE_SUPABASE_URL']);
});

test('no session is its own state, NOT empty', () => {
  /* The state this project is actually in today: schema live, no Auth user. If
     this ever classified as `empty`, the pipeline would show "none" and Teja
     would read it as "the automation found nothing", when the truth is that
     nobody is signed in. That is the exact confusion the module exists to
     prevent, so this is the most important assertion in the file. */
  const state = classifyRead(facts({ signedIn: false, rows: [] }));

  assert.equal(state.kind, 'no_session');
});

test('a failed read is failed, and carries its message', () => {
  const state = classifyRead(facts({ error: 'permission denied for table applications', rows: null }));

  assert.equal(state.kind, 'failed');
  if (state.kind !== 'failed') return;
  /* The message passes through intact. "Something went wrong" sends nobody
     anywhere useful, and this string is usually the whole diagnosis. */
  assert.match(state.message, /permission denied/);
});

test('a genuine empty result is the ONLY state that reports empty', () => {
  const state = classifyRead(facts({ rows: [] }));

  /* Configured, signed in, no error, and the database answered with nothing.
     This is the one case where "you have none" is a true statement. */
  assert.equal(state.kind, 'empty');
});

/* --- Ordering, which is what keeps the states honest ----------------- */

/* Each of these has two problems at once. The state reported must be the one
 * that would be dishonest to skip - and getting the order wrong is how someone
 * gets told to sign in when their query actually errored. */
test('an error outranks a missing session', () => {
  /* Both true. Reporting `no_session` would send the operator to sign in when
     the real problem is the query - they would fix the wrong thing and see the
     same screen again. */
  const state = classifyRead(facts({ signedIn: false, error: 'network unreachable', rows: null }));

  assert.equal(state.kind, 'failed');
});

test('loading outranks both error and session', () => {
  /* A read in flight has no answer yet. Guessing one would flicker a wrong
     answer onto the screen, and a brief wrong answer on this console is still
     something an operator might act on. */
  const state = classifyRead(
    facts({ loading: true, signedIn: false, error: 'stale error from a previous attempt', rows: null }),
  );

  assert.equal(state.kind, 'loading');
});

test('unconfigured outranks everything', () => {
  /* With no client there was no query, so neither an error nor a session state
     is meaningful - there is nothing they could be describing. */
  const state = classifyRead(
    facts({
      clientPresent: false,
      missingEnv: ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'],
      signedIn: false,
      loading: true,
      error: 'whatever',
      rows: null,
    }),
  );

  assert.equal(state.kind, 'unconfigured');
});

/* --- null rows versus empty rows ------------------------------------- */

/* The distinction almost every data hook destroys with `rows ?? []`. */
test('null rows is not an empty result - it means no read has completed', () => {
  /* Everything healthy, but no successful read yet. Reporting `empty` here
     would be a positive claim that the database was asked and answered
     nothing, which has not happened. */
  const state = classifyRead(facts({ rows: null }));

  assert.equal(state.kind, 'loading');
  /* And explicitly NOT empty - spelled out because this is the assertion that
     catches a future `rows ?? []` creeping in. */
  assert.notEqual(state.kind, 'empty');
});

/* --- The phrases the operator actually reads ------------------------- */

/* The wording is the entire product of this module - a correctly classified
 * state rendered as "0" would defeat the whole exercise. */
test('no empty-state phrase is ever the digit zero', () => {
  const states = [
    classifyRead(facts({ clientPresent: false, missingEnv: ['VITE_SUPABASE_URL'], rows: null })),
    classifyRead(facts({ loading: true, rows: null })),
    classifyRead(facts({ signedIn: false, rows: [] })),
    classifyRead(facts({ error: 'boom', rows: null })),
    classifyRead(facts({ rows: [] })),
  ];

  for (const state of states) {
    const phrase = describeEmptyState(state);
    assert.ok(phrase !== null, state.kind + ' should have a phrase');
    /* A bare 0, or a phrase that is just "0 rows", would be indistinguishable
       at a glance from the honest empty case - which is the whole confusion. */
    assert.notEqual(phrase.trim(), '0');
    assert.doesNotMatch(phrase, /^0\b/);
  }
});

test('the phrases for the four empty causes are all different', () => {
  /* If two of these ever match, the states have been collapsed in the UI even
     though the classifier still distinguishes them - which is the same bug one
     layer later, and much harder to spot. */
  const phrases = [
    describeEmptyState(classifyRead(facts({ clientPresent: false, missingEnv: ['X'], rows: null }))),
    describeEmptyState(classifyRead(facts({ loading: true, rows: null }))),
    describeEmptyState(classifyRead(facts({ signedIn: false, rows: [] }))),
    describeEmptyState(classifyRead(facts({ error: 'boom', rows: null }))),
    describeEmptyState(classifyRead(facts({ rows: [] }))),
  ];

  assert.equal(new Set(phrases).size, phrases.length, 'phrases must be distinct: ' + JSON.stringify(phrases));
});

test('the no-session phrase says the emptiness is expected', () => {
  /* Right now there is no Auth user in this system at all, so zero rows is
     correct behaviour. Without that reassurance the operator would reasonably
     conclude something is broken and go looking for a bug that is not there. */
  const phrase = describeEmptyState(classifyRead(facts({ signedIn: false, rows: [] })));

  assert.ok(phrase !== null);
  assert.match(phrase, /signed in/i);
});

test('a state with rows has no empty-state phrase', () => {
  /* Returning a phrase here would invite a caller to render it instead of the
     rows it actually has. */
  assert.equal(describeEmptyState(classifyRead(facts())), null);
});

/* --- What may be concluded from --------------------------------------- */

test('only a completed read is conclusive', () => {
  /* `empty` is conclusive - the database answered, and the answer was nothing.
     The other three are not answers at all. */
  assert.equal(isConclusive(classifyRead(facts())), true);
  assert.equal(isConclusive(classifyRead(facts({ rows: [] }))), true);

  assert.equal(isConclusive(classifyRead(facts({ signedIn: false, rows: [] }))), false);
  assert.equal(isConclusive(classifyRead(facts({ error: 'boom', rows: null }))), false);
  assert.equal(isConclusive(classifyRead(facts({ loading: true, rows: null }))), false);
  assert.equal(
    isConclusive(classifyRead(facts({ clientPresent: false, missingEnv: ['X'], rows: null }))),
    false,
  );
});

/* --- Mutation check: MEASURED, three mutations ----------------------- */

/* Three plausible wrong implementations, applied one at a time, reverted after
 * each. All 60 tests were green before and after.
 *
 * MUTATION A - `no_session` returns `{kind:'empty'}`. This is the `rows ?? []`
 * bug in its most dangerous form: it is what almost every data hook does by
 * default.
 *   RESULT: 60 tests, 56 passed, 4 FAILED.
 *   Killed: "no session is its own state, NOT empty", "the phrases for the four
 *   empty causes are all different", "the no-session phrase says the emptiness
 *   is expected", "only a completed read is conclusive".
 *   Note the second one: it caught the collapse at the RENDERING layer, not the
 *   classification layer. Even if the classifier had somehow still been right,
 *   two identical phrases on screen is the same bug one step later and much
 *   harder to see.
 *
 * MUTATION B - null rows classified as `empty`.
 *   RESULT: 60 tests, 59 passed, 1 FAILED - only "null rows is not an empty
 *   result". That single test is the entire defence against a future
 *   `rows ?? []` creeping back in.
 *
 * MUTATION C - the error check moved AFTER the session check.
 *   RESULT: 60 tests, 59 passed, 1 FAILED - only "an error outranks a missing
 *   session". Under that mutation, an operator whose query failed with a
 *   network error would be told to sign in: they fix the wrong thing, see the
 *   identical screen, and have no way to tell they were misled.
 *
 * THE PATTERN, now the third time in this package: TWO OF THE THREE MUTATIONS
 * WERE CAUGHT BY EXACTLY ONE TEST EACH. 59 of 60 tests were indifferent to a
 * real, shippable, plausible-looking bug. Test count says almost nothing about
 * protection; which specific inputs you chose says everything.
 */
