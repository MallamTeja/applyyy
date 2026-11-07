/* "Send through pipeline" must say WHY a step stopped (2026-11-07).
 *
 * Teja sent Netomi and Rubrik at ~09:55 IST and both cards read a bare "Matcher: stopped". Netomi:
 * the matcher answered HTTP 200 with the row's failure ("gemini_call_failed:
 * rate_limited_all_retries_exhausted") in its body, and the card dropped those words because it kept
 * error text only for non-2xx calls. Rubrik: the job's posting had gone (jobs.disappeared_at set), so
 * the matcher selected 0 rows and the run ended no_progress. What this file pins:
 *   - the engine's own words reach the outcome sentence AND the step line, for every stop reason;
 *   - an absent reason is said as "no reason given", never invented;
 *   - a rate-limit says so in plain words;
 *   - sends run one row at a time, with a gap between rows;
 *   - a posting that is gone shows its date and offers no Send button.
 * Pure functions plus a static render; no network, fakes only. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose == can never pass a wrong value.
import assert from 'node:assert/strict';
// The runner's own describe/it/before.
import { describe, it, before } from 'node:test';

// The card module, loaded after the hooks are in place.
let card: typeof import('../src/features/pipeline/DrawerAppCard.tsx');
// Static markup, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;

// Loads the modules once the hooks exist.
before(async () => {
  // Transpiled by the hook.
  card = await import('../src/features/pipeline/DrawerAppCard.tsx');
  // From the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
});

// Netomi's matcher answer, as the matcher shapes a per-row failure (matcher/index.ts failures.push).
const NETOMI_BODY = { success: true, failures: [{ applicationId: 'e5107026', error: 'gemini_call_failed: rate_limited_all_retries_exhausted' }] };

describe('the engine response is read into words (engineReasonText)', () => {
  it('a 200 body with success:false carries its error', () => {
    // The shape the coordinator named: HTTP 200, success:false, error "x".
    assert.equal(card.engineReasonText({ success: false, error: 'x' }), 'x');
  });

  it("a 200 body's per-row failure carries that row's error", () => {
    // Netomi's exact body.
    assert.equal(card.engineReasonText(NETOMI_BODY), 'gemini_call_failed: rate_limited_all_retries_exhausted');
  });

  it('error, reason and detail are all kept, each once', () => {
    // A function that says both what and why.
    assert.equal(card.engineReasonText({ error: 'invalid_mode', detail: 'mode must be one of' }), 'invalid_mode; mode must be one of');
  });

  it('a body with no words is null, never an invented reason', () => {
    // The matcher's 0-row answer (Rubrik): nothing to quote.
    assert.equal(card.engineReasonText({ success: true, processed: 0 }), null);
    // Non-objects and wrong-typed fields carry nothing either.
    assert.equal(card.engineReasonText('oops'), null);
    // A number is not words; it must not be stringified into a reason.
    assert.equal(card.engineReasonText({ error: 503, failures: [{ error: null }] }), null);
  });

  it('untrusted text is capped', () => {
    // A body that dumps a whole HTML page into error.
    const text = card.engineReasonText({ error: 'a'.repeat(5000) });
    // Capped, with an ellipsis so the cut is visible.
    assert.ok(text !== null && text.length <= 301 && text.endsWith('…'));
  });
});

// 2026-11-07: the matcher's top-level `reason` became an object (e88b7d8, run-reason.ts):
// { code, message, status? }. The string-only reader dropped it, so a targeted run that found
// nothing said "no reason given". Each closed code reads as plain words.
describe("the matcher's reason object is read into plain words", () => {
  it('target_posting_gone says "Posting gone"', () => {
    // The matcher's exact object for a tombstoned posting.
    assert.equal(card.engineReasonText({ success: true, processed: 0, reason: { code: 'target_posting_gone', message: 'The posting is gone from its board, so the matcher skipped it.' } }), 'Posting gone');
  });

  it('target_not_found says the job is no longer in the list', () => {
    // The matcher's exact object for a missing row.
    assert.equal(card.engineReasonText({ reason: { code: 'target_not_found', message: 'No application with that id exists.' } }), 'This job is no longer in your list');
  });

  it('target_not_at_input_status names the status the row is at', () => {
    // The object carries the row's real status.
    assert.equal(card.engineReasonText({ reason: { code: 'target_not_at_input_status', message: 'The application is at scored, not passed_filters, so the matcher has nothing to score.', status: 'scored' } }), 'Already at scored');
  });

  it('target_not_at_input_status with no readable status keeps the message verbatim', () => {
    // A status that is not a non-empty string is not invented into the sentence.
    assert.equal(card.engineReasonText({ reason: { code: 'target_not_at_input_status', message: 'The application is at x.', status: 7 } }), 'The application is at x.');
  });

  it('rate_limited keeps the code in its words, so the stop says Gemini is rate-limited', () => {
    // A 429 line that never spells rate_limited itself (run-reason.ts matches status=429 too).
    const text = card.engineReasonText({ reason: { code: 'rate_limited', message: 'gemini_call_failed: status=429 Resource has been exhausted' } });
    // The code is prefixed so stopDetail's rate-limit sentence fires; the raw words stay for diagnosis.
    assert.equal(text, 'rate_limited: gemini_call_failed: status=429 Resource has been exhausted');
    // A message that already names it is not prefixed twice.
    assert.equal(card.engineReasonText({ reason: { code: 'rate_limited', message: 'gemini_call_failed: rate_limited_all_retries_exhausted' } }), 'gemini_call_failed: rate_limited_all_retries_exhausted');
  });

  it('an unknown code reads as its message verbatim, capped; a malformed object adds nothing', () => {
    // A code this reader does not know: the server's own sentence.
    assert.equal(card.engineReasonText({ reason: { code: 'something_new', message: 'A new case.' } }), 'A new case.');
    // A long message is capped like every other untrusted text.
    const long = card.engineReasonText({ reason: { code: 'something_new', message: 'b'.repeat(5000) } });
    // Same cap as the other fields.
    assert.ok(long !== null && long.length <= 301 && long.endsWith('…'));
    // No code and no message: nothing, never "[object Object]".
    assert.equal(card.engineReasonText({ reason: { foo: 1 } }), null);
    // An array is not the object shape.
    assert.equal(card.engineReasonText({ reason: ['target_posting_gone'] }), null);
  });

  it('a string reason still reads as before', () => {
    // Other agents send reason as a plain string.
    assert.equal(card.engineReasonText({ reason: 'kill switch on' }), 'kill switch on');
  });
});

describe('every stop says the reason (outcome sentence)', () => {
  it('body_failure quotes the agent words', () => {
    // A 200 whose body reported the row failed.
    const text = card.describeOutcome({ kind: 'stopped', atStep: 'tailor', reason: 'body_failure', finalStatus: 'scored' }, null, 'x');
    // The words are on the card.
    assert.match(text, /x/);
    // The old where-is-it-now fact survives.
    assert.match(text, /now at scored/);
  });

  it('a rate-limit says Gemini is rate-limited, in plain words', () => {
    // Netomi: body_failure at the matcher with the rate-limit words.
    const text = card.describeOutcome({ kind: 'stopped', atStep: 'matcher', reason: 'body_failure', finalStatus: 'passed_filters' }, null, 'gemini_call_failed: rate_limited_all_retries_exhausted');
    // The plain sentence the operator acts on.
    assert.match(text, /Gemini is rate-limited; try again in a minute/);
  });

  it('a 503 says its code and words', () => {
    // A failed call, as rowPipelineDeps reports it.
    const text = card.describeOutcome({ kind: 'stopped', atStep: 'matcher', reason: 'invoke_error', finalStatus: 'passed_filters' }, 503, 'database_unavailable');
    // Both, once.
    assert.match(text, /HTTP 503: database_unavailable/);
  });

  it('no_progress with no words says "no reason given"', () => {
    // Rubrik: the matcher answered 0 rows, with nothing to quote.
    const text = card.describeOutcome({ kind: 'stopped', atStep: 'matcher', reason: 'no_progress', finalStatus: 'passed_filters' }, null, null);
    // Said, not invented.
    assert.match(text, /no reason given/);
  });
});

describe('the step line says the reason too (stepLine)', () => {
  it('"Matcher: stopped" carries the engine words, never bare', () => {
    // The result the card holds after Netomi's run.
    const result = { outcome: { kind: 'stopped', atStep: 'matcher', reason: 'body_failure', finalStatus: 'passed_filters' } as const, httpStatus: null, errorText: 'x' };
    // The line for the step that stopped.
    assert.equal(card.stepLine('matcher', 'stopped', result), 'Matcher: stopped (x)');
  });

  it('a stopped line with no result yet stays plain', () => {
    // Mid-run, before the outcome: nothing to quote yet.
    assert.equal(card.stepLine('matcher', 'stopped', null), 'Matcher: stopped');
  });

  it('other states are unchanged', () => {
    // A done step quotes nothing.
    assert.equal(card.stepLine('tailor', 'done', null), 'Tailor: done');
  });

  it('a 503 with no words names the code on the line', () => {
    // A failed call with an empty body.
    const result = { outcome: { kind: 'stopped', atStep: 'matcher', reason: 'invoke_error', finalStatus: 'passed_filters' } as const, httpStatus: 503, errorText: null };
    // The code is the only fact, and it is shown.
    assert.equal(card.stepLine('matcher', 'stopped', result), 'Matcher: stopped (HTTP 503)');
  });
});

describe('sends are paced: one row at a time, then a gap (paceSend)', () => {
  it('a second send starts only after the first ends and the gap has run', async () => {
    // The order things happened in.
    const log: string[] = [];
    // A sleep that logs instead of waiting, so the test is instant and the gap is observable.
    const sleep = async (ms: number): Promise<void> => { log.push(`gap ${ms}`); };
    // Released by the test, so the first run is provably still in flight.
    let release!: () => void;
    // The first run: held until released.
    const first = card.paceSend(async () => { log.push('a start'); await new Promise<void>((r) => { release = r; }); log.push('a end'); }, 7, sleep);
    // The second run, queued while the first holds.
    const second = card.paceSend(async () => { log.push('b start'); }, 7, sleep);
    // Let microtasks settle: b must still be waiting.
    await new Promise((r) => setTimeout(r, 0));
    // Only a has started.
    assert.deepEqual(log, ['a start']);
    // Let a finish.
    release();
    // Both resolve.
    await Promise.all([first, second]);
    // a ran, the gap ran, then b.
    assert.deepEqual(log.slice(0, 4), ['a start', 'a end', 'gap 7', 'b start']);
  });

  it('a throwing send does not jam the queue', async () => {
    // A sleep that does not wait.
    const sleep = async (): Promise<void> => {};
    // A failed run rejects to its own caller.
    await assert.rejects(card.paceSend(async () => { throw new Error('boom'); }, 0, sleep), /boom/);
    // And the next run still happens.
    assert.equal(await card.paceSend(async () => 'next', 0, sleep), 'next');
  });
});

describe('a posting that is gone (postingGoneNote)', () => {
  it('a PostgREST timestamptz becomes "Posting gone (since <date>)"', () => {
    // Rubrik's disappeared_at, as PostgREST returns it.
    assert.equal(card.postingGoneNote('2026-11-05T15:38:12.123456+00:00'), 'Posting gone (since 2026-11-05)');
  });

  it('null, absent or a malformed value claims nothing', () => {
    // A live posting.
    assert.equal(card.postingGoneNote(null), null);
    // A select that did not carry the column.
    assert.equal(card.postingGoneNote(undefined), null);
    // A lenient parser would read this as a date; the shape check refuses it.
    assert.equal(card.postingGoneNote('-5'), null);
    // A date-shaped string that is not a real date.
    assert.equal(card.postingGoneNote('2026-13-45T00:00:00Z'), null);
  });

  it('the drawer card shows the note and no Send button for a gone posting', () => {
    // Rubrik's row, in the Send lane.
    const app = { id: 'ff32070c-0000-4000-8000-000000000000', role: 'Software Engineer - Cloud: Azure', company: 'Rubrik', createdAt: '2026-11-01T00:00:00Z', resume: null, disappearedAt: '2026-11-05T15:38:00+00:00' };
    // Deps that must never be called by a render.
    const deps = { invoke: () => { throw new Error('no'); }, readStatus: () => { throw new Error('no'); } };
    // The drawer's own wiring for the passed_filters lane.
    const html = render(h(card.DrawerAppCard, { app, onViewResume: () => {}, sendThroughPipeline: { status: 'passed_filters', deps } }));
    // The date is on the card.
    assert.match(html, /Posting gone \(since 2026-11-05\)/);
    // No button that would only end in "Matcher: stopped".
    assert.doesNotMatch(html, /Send through pipeline/);
  });
});
