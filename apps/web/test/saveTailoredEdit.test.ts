/* Saving a tailored-resume edit from the approval page (task 8 contract v2, 2026-10-06).
 *
 * The rules that matter most:
 *   - An edit never lands after approval, and never over someone else's newer write: the UPDATE is
 *     filtered on status AND on the updated_at the page loaded (optimistic concurrency), and only
 *     "exactly one row came back" counts as saved. Never a read-then-write: a read can be stale by
 *     the time the write lands.
 *   - R0 at the write boundary: a resume whose change is not text-only (e.g. master_text moved) is
 *     refused before any network call.
 *   - A thrown UPDATE means the outcome is UNKNOWN, so the code re-reads instead of guessing.
 *
 * The client is a hand-built fake recording every call in order; no network. Every builder step is
 * thenable, so the test does not depend on where in the chain the implementation awaits, and each
 * chain can be told to REJECT, which is how a dropped connection surfaces through supabase-js. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

// The module under test.
let save: typeof import('../src/features/approval/saveTailoredEdit.ts');

before(async () => {
  // Loaded after the hooks so its own extensionless imports resolve.
  save = await import('../src/features/approval/saveTailoredEdit.ts');
});

// A small resume with one bullet, so a text edit and a master_text edit are both expressible.
const resume = (text: string, masterText = 'Old text') => ({
  // The only schema this code knows.
  schema_version: 1,
  // A positive integer, as isResumeShape requires.
  master_version: 3,
  // An identity object; R0 says it never changes.
  identity: { full_name: 'Test Person', headline: null, email: 'test@example.com', phone: null, location: null, links: [] },
  // Document order.
  section_order: ['experience'],
  // No summary.
  summary: null,
  // No skills selected.
  skills: [],
  // One employer, one bullet: the target of every edit here.
  experience: [{
    ref: 'exp-acme', company: 'Acme', role: 'Backend Intern', location: 'Remote', start_display: 'Jun 2025', end_display: 'Aug 2025',
    // `text` is free; `master_text` is the Auditor's ground truth and must equal the original's.
    bullets: [{ ref: 'b-tests', text, master_text: masterText }],
  }],
  // The remaining required arrays.
  projects: [], education: [], achievements: [], certifications: [],
});

// The tailor's version, rebuilt from tailor_refs: the reference for master_text.
const ORIGINAL = resume('Old text');
// What tailored_profile held when the page loaded.
const PREVIOUS = resume('Old text');
// A legal edit: only the bullet's text changed.
const NEXT = resume('New text');
// The stamp the page loaded with; the UPDATE is conditional on it.
const LOADED_STAMP = '2026-10-06T10:00:00.000Z';
// The stamp the database assigns on a successful write.
const NEW_STAMP = '2026-10-06T10:05:00.000Z';
// What a re-read finds after someone else moved the row on.
const STORED = { resume: resume('Someone else wrote this'), updatedAt: '2026-10-06T10:03:00.000Z', status: 'approved' };

// The event the page would send for an ordinary bullet edit.
const EVENT = { kind: 'resume_edit', ref: 'b-tests', before: 'Old text', after: 'New text' } as const;

// One recorded call: which method, with which arguments, on which table.
type Call = { table: string; method: string; args: unknown[] };
// A canned answer, or 'throw' to make that chain reject like a dropped connection.
type Answer = { data?: unknown; error?: unknown } | 'throw';

// A fake Supabase client. Three chains are distinguishable: the UPDATE (update() was called),
// the re-select on applications (no update()), and the INSERT on application_events.
function fakeClient(answers: { update?: Answer; reselect?: Answer; insert?: Answer }) {
  // Every call in order, so ordering and absence are both assertable.
  const calls: Call[] = [];
  // Happy path unless a test says otherwise: one row written, carrying the new stamp.
  const update = answers.update ?? { data: [{ id: 'app-1', updated_at: NEW_STAMP }], error: null };
  // The re-read answers with the row as STORED describes it, in the DB's column names.
  const reselect = answers.reselect ?? {
    data: { tailored_profile: STORED.resume, updated_at: STORED.updatedAt, status: STORED.status }, error: null,
  };
  // Default insert success.
  const insert = answers.insert ?? { error: null };
  // The client surface the contract names: from(table) only.
  const client = {
    from(table: string) {
      // Recorded as its own call so "zero calls" really means zero.
      calls.push({ table, method: 'from', args: [table] });
      // Which chain this is, decided by the methods called on it.
      let kind: 'reselect' | 'update' | 'insert' = 'reselect';
      // .single()/.maybeSingle() return one object; a plain select returns an array.
      let single = false;
      // A chainable, thenable builder.
      const builder: Record<string, unknown> = {
        // Thenable at every step, so awaiting after .select or after .eq both work.
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          // The canned answer for this chain.
          const answer = kind === 'update' ? update : kind === 'insert' ? insert : reselect;
          // A rejection is the "outcome unknown" case the code must survive.
          if (answer === 'throw') return Promise.reject(new Error(`network dropped during ${kind}`)).then(resolve, reject);
          // A re-select without .single() gets the row wrapped in an array, as PostgREST returns it.
          const shaped = kind === 'reselect' && !single && answer.data && !Array.isArray(answer.data)
            ? { ...answer, data: [answer.data] } : answer;
          // Resolve with whichever response the chain earned.
          return Promise.resolve(shaped).then(resolve, reject);
        },
      };
      // The PostgREST methods either chain might use.
      for (const method of ['update', 'eq', 'select', 'insert', 'single', 'maybeSingle', 'limit']) {
        // Each records itself and continues the chain.
        builder[method] = (...args: unknown[]) => {
          // Recorded with the table it ran against.
          calls.push({ table, method, args });
          // update() and insert() decide which canned answer the chain gets.
          if (method === 'update') kind = 'update';
          // An insert is always the event write.
          if (method === 'insert') kind = 'insert';
          // Single-row reads unwrap the array.
          if (method === 'single' || method === 'maybeSingle') single = true;
          // Chain continues.
          return builder;
        };
      }
      // The start of the chain.
      return builder;
    },
  };
  // Both handed back: the client to the code, the log to the test.
  return { client, calls };
}

// Shorthand: run one save with these answers, defaulting to a legal edit.
const run = (answers: Parameters<typeof fakeClient>[0], next: unknown = NEXT) => {
  // A fresh fake per run, so call logs never leak between tests.
  const fake = fakeClient(answers);
  // The call under test, with the v2 arguments.
  const done = save.saveTailoredEdit(fake.client, {
    // Which row.
    applicationId: 'app-1',
    // What to write.
    resume: next as never,
    // What the page believed was stored, for the text-only check.
    previous: PREVIOUS as never,
    // The tailor's version, for master_text and ref integrity.
    original: ORIGINAL as never,
    // The optimistic-concurrency token.
    expectedUpdatedAt: LOADED_STAMP,
    // The audit note.
    event: EVENT,
  });
  // Both returned so the test can await the result and inspect the log.
  return { done, calls: fake.calls };
};

// The insert calls only, which is where "an event was recorded" lives.
const inserts = (calls: Call[]) => calls.filter((c) => c.method === 'insert');
// The update calls only.
const updates = (calls: Call[]) => calls.filter((c) => c.method === 'update');
// Chains on applications that never called update(): the re-reads.
const reselects = (calls: Call[]) => {
  // Split the log into chains at each from().
  const chains: Call[][] = [];
  // Walk in order.
  for (const c of calls) {
    // A from() starts a chain.
    if (c.method === 'from') chains.push([c]);
    // Anything else belongs to the latest chain.
    else chains[chains.length - 1]!.push(c);
  }
  // Applications chains with a select and no update.
  return chains.filter((ch) => ch[0]!.table === 'applications' && !ch.some((c) => c.method === 'update') && ch.some((c) => c.method === 'select'));
};
// Did the chain filter on this column = value?
const hasEq = (calls: Call[], column: string, value: unknown) =>
  // Only applications-table filters count.
  calls.some((c) => c.table === 'applications' && c.method === 'eq' && c.args[0] === column && c.args[1] === value);

describe('saveTailoredEdit: the write boundary', () => {
  it('a save that would change master_text is refused at the boundary', async () => {
    // The text changed AND master_text was rewritten to match it: the edit would read as traced.
    const { done, calls } = run({}, resume('New text', 'New text'));
    // Awaited result.
    const result = await done;
    // Refused with the contract's reason.
    assert.equal(result.ok, false);
    // Named so the page can say why.
    if (!result.ok) assert.equal(result.reason, 'not_text_only');
    // Before touching the network at all.
    assert.equal(calls.length, 0);
    // Positive control: the same save with master_text untouched reaches the client and succeeds.
    const control = run({});
    // Saved.
    assert.equal((await control.done).ok, true);
    // And it did call out.
    assert.ok(control.calls.length > 0);
  });

  it('an invalid resume shape is refused with zero client calls', async () => {
    // Not a resume: schema 2 is not this code's to write.
    const { done, calls } = run({}, { ...NEXT, schema_version: 2 });
    // Awaited result.
    const result = await done;
    // Refused.
    assert.equal(result.ok, false);
    // With the shape reason, not the text-only one.
    if (!result.ok) assert.equal(result.reason, 'invalid_resume_shape');
    // No network.
    assert.equal(calls.length, 0);
  });
});

describe('saveTailoredEdit: the conditional UPDATE', () => {
  it('an edit never lands after approval', async () => {
    // The row moved on: the status- and stamp-filtered update matched nothing.
    const { done, calls } = run({ update: { data: [], error: null } });
    // Awaited result.
    const result = await done;
    // The status filter is in the update chain itself, not a separate read.
    assert.ok(hasEq(calls, 'status', 'awaiting_approval'));
    // Not saved.
    assert.equal(result.ok, false);
    // And no event claims an edit that never landed.
    assert.equal(inserts(calls).length, 0);
    // Positive control: one row matched does record an event.
    const control = run({});
    // Saved.
    assert.equal((await control.done).ok, true);
    // Exactly one event.
    assert.equal(inserts(control.calls).length, 1);
  });

  it('the UPDATE is conditional on the loaded updated_at, never on the JSON', async () => {
    // Happy path.
    const { done, calls } = run({});
    // Awaited.
    await done;
    // The optimistic-concurrency filter carries exactly the stamp the page loaded.
    assert.ok(hasEq(calls, 'updated_at', LOADED_STAMP));
    // Scoped to this application.
    assert.ok(hasEq(calls, 'id', 'app-1'));
    // No filter compares the stored resume: JSON equality is not a concurrency token.
    assert.equal(calls.some((c) => c.method === 'eq' && c.args[0] === 'tailored_profile'), false);
  });

  it('0 rows -> changed_elsewhere, with what a re-select found', async () => {
    // Someone else wrote first, so the stamp no longer matches.
    const { done, calls } = run({ update: { data: [], error: null } });
    // Awaited.
    const result = await done;
    // Not saved.
    assert.equal(result.ok, false);
    // Narrow.
    if (result.ok) return;
    // Named distinctly from "unconfirmed": here we KNOW it did not land.
    assert.equal(result.reason, 'changed_elsewhere');
    // The page adopts what the database holds now.
    assert.deepEqual(result.stored, STORED);
    // That came from a real re-read of the row.
    assert.equal(reselects(calls).length, 1);
    // No event.
    assert.equal(inserts(calls).length, 0);
  });

  it('the UPDATE throws -> unconfirmed, with what a re-select found, and no event', async () => {
    // The connection dropped mid-write: the edit may or may not have landed.
    const { done, calls } = run({ update: 'throw' });
    // Never throws out to the page.
    const result = await done;
    // Not claimed as saved.
    assert.equal(result.ok, false);
    // Narrow.
    if (result.ok) return;
    // Unknown, said as unknown.
    assert.equal(result.reason, 'unconfirmed');
    // The truth comes from the database, not from a guess.
    assert.deepEqual(result.stored, STORED);
    // Via a re-read.
    assert.equal(reselects(calls).length, 1);
    // No event for an edit we cannot confirm.
    assert.equal(inserts(calls).length, 0);
    // Positive control: the update was actually attempted before the re-read.
    assert.equal(updates(calls).length, 1);
  });

  it('2 rows returned is not ok', async () => {
    // A filter that matched two rows is a filter that did not identify the row.
    const { done, calls } = run({ update: { data: [{ id: 'app-1', updated_at: NEW_STAMP }, { id: 'app-2', updated_at: NEW_STAMP }], error: null } });
    // Refused.
    assert.equal((await done).ok, false);
    // No event.
    assert.equal(inserts(calls).length, 0);
  });

  it('data null with no error is not ok', async () => {
    // The permissive reader's fail-open: no error is not the same as one row written.
    const { done, calls } = run({ update: { data: null, error: null } });
    // Refused.
    assert.equal((await done).ok, false);
    // No event.
    assert.equal(inserts(calls).length, 0);
  });

  it('an update error is a failure and records no event', async () => {
    // The database refused the write (e.g. RLS 42501).
    const { done, calls } = run({ update: { data: null, error: { message: 'boom', code: '42501' } } });
    // Not saved.
    assert.equal((await done).ok, false);
    // No event.
    assert.equal(inserts(calls).length, 0);
  });
});

describe('saveTailoredEdit: the event INSERT', () => {
  it('writes tailored_profile, then exactly one note event, and returns the new stamp', async () => {
    // Happy path.
    const { done, calls } = run({});
    // Saved, recorded, and the page learns the NEW stamp for its next save.
    assert.deepEqual(await done, { ok: true, eventRecorded: true, updatedAt: NEW_STAMP });
    // The single update.
    const update = updates(calls)[0];
    // On the applications table.
    assert.equal(update?.table, 'applications');
    // Its payload is exactly the column the contract names.
    assert.deepEqual(update?.args[0], { tailored_profile: NEXT });
    // Exactly one insert.
    const events = inserts(calls);
    // One event per save.
    assert.equal(events.length, 1);
    // Into the audit log.
    assert.equal(events[0]!.table, 'application_events');
    // The row as the contract states it.
    const row = events[0]!.args[0] as Record<string, unknown>;
    // A human note describing the edit.
    assert.deepEqual(row, {
      // Which application.
      application_id: 'app-1',
      // An existing event type, no migration.
      event_type: 'note',
      // The operator, not an agent.
      agent: 'human',
      // What changed.
      detail: { kind: 'resume_edit', ref: 'b-tests', before: 'Old text', after: 'New text' },
    });
    // user_id is left to the column default (auth.uid()), never set by the browser.
    assert.equal('user_id' in row, false);
    // The update happens before the insert: an event must never precede the edit it records.
    assert.ok(calls.indexOf(update!) < calls.indexOf(events[0]!));
  });

  it('an insert error still reports the edit as saved, with eventRecorded false', async () => {
    // The edit landed; only the log row failed.
    const { done } = run({ insert: { error: { message: 'insert failed' } } });
    // Saved, honestly reporting the missing event.
    assert.deepEqual(await done, { ok: true, eventRecorded: false, updatedAt: NEW_STAMP });
  });

  it('an insert THROW still reports the edit as saved, with eventRecorded false', async () => {
    // The connection dropped after the edit landed.
    const { done } = run({ insert: 'throw' });
    // Never throws out; the edit IS saved and says so.
    assert.deepEqual(await done, { ok: true, eventRecorded: false, updatedAt: NEW_STAMP });
  });
});

/* What postgrest-js 1.17/1.19 RETURNS (never throws) when fetch itself fails: PostgrestBuilder
   catches the TypeError and resolves with status 0 and an empty code. Copied field for field, so
   the test certifies the path the real client takes, not the throwing one it never takes. */
const NETWORK_DROP = {
  // No body ever arrived, so nothing was decoded.
  data: null,
  // The builder's own synthetic error: a message, but no SQLSTATE.
  error: { message: 'TypeError: Failed to fetch', details: 'TypeError: Failed to fetch', hint: '', code: '' },
  // No count without a response.
  count: null,
  // 0 is "no HTTP response at all", the signal that the outcome is unknown.
  status: 0,
  // Matches the real builder's empty statusText.
  statusText: '',
};
// The re-read finding OUR edit stored: the write landed even though its answer was lost.
const LANDED = { data: { tailored_profile: NEXT, updated_at: NEW_STAMP, status: 'awaiting_approval' }, error: null };

describe('saveTailoredEdit: an unknown outcome (D1, D4, D7a)', () => {
  it('a RETURNED network error (status 0, code empty) -> unconfirmed, with a re-select', async () => {
    // The exact object supabase-js hands back on a dropped connection.
    const { done, calls } = run({ update: NETWORK_DROP });
    // Never throws out to the page.
    const result = await done;
    // Not claimed as saved.
    assert.equal(result.ok, false);
    // Narrow.
    if (result.ok) return;
    // Unknown, said as unknown, not as a refusal in the database's words.
    assert.equal(result.reason, 'unconfirmed');
    // The truth came from a real re-read of the row.
    assert.equal(reselects(calls).length, 1);
    // And it is what the page adopts.
    assert.deepEqual(result.stored, STORED);
    // No event for an edit we cannot confirm.
    assert.equal(inserts(calls).length, 0);
  });

  it('a SQLSTATE error stays on the error path, with no re-select', async () => {
    // The database answered and refused: the outcome is KNOWN, so re-reading would add nothing.
    const { done, calls } = run({ update: { data: null, error: { message: 'boom', code: '42501' }, status: 403 } });
    // Awaited.
    const result = await done;
    // Narrow.
    if (result.ok) return assert.fail('a refused write reported as saved');
    // A refusal, not an unknown.
    assert.equal(result.reason, 'error');
    // No re-read for a known answer.
    assert.equal(reselects(calls).length, 0);
  });

  it('unconfirmed but the re-read shows OUR edit stored -> ok, with the event and the stored stamp', async () => {
    // The answer was lost, but the row holds exactly what was sent, still in review.
    const { done, calls } = run({ update: NETWORK_DROP, reselect: LANDED });
    // Saved, recorded, and the next edit presents the stored stamp.
    assert.deepEqual(await done, { ok: true, eventRecorded: true, updatedAt: NEW_STAMP });
    // The same single note the success path writes.
    assert.equal(inserts(calls).length, 1);
    // Into the audit log.
    assert.equal(inserts(calls)[0]!.table, 'application_events');
  });

  it('a THROWN update whose edit landed is ok too, with eventRecorded false when the note fails', async () => {
    // Both unknown-outcome routes share one rule; the note's failure is reported, not hidden.
    const { done } = run({ update: 'throw', reselect: LANDED, insert: { error: { message: 'insert failed' } } });
    // The resume is stored; only the log row is missing.
    assert.deepEqual(await done, { ok: true, eventRecorded: false, updatedAt: NEW_STAMP });
  });

  it('unconfirmed and the stored resume differs -> unconfirmed, no event', async () => {
    // Still in review, but holding someone else's words: our edit did not land.
    const other = { data: { tailored_profile: PREVIOUS, updated_at: NEW_STAMP, status: 'awaiting_approval' }, error: null };
    // Lost answer, then a re-read that does not match.
    const { done, calls } = run({ update: NETWORK_DROP, reselect: other });
    // Awaited.
    const result = await done;
    // Narrow.
    if (result.ok) return assert.fail('a different stored resume reported as saved');
    // Still unknown from the operator's side.
    assert.equal(result.reason, 'unconfirmed');
    // No note for an edit that is not there.
    assert.equal(inserts(calls).length, 0);
  });

  it('unconfirmed and the stored resume matches but is no longer in review -> unconfirmed, no event', async () => {
    // Our words, but approved since: not an edit to the row the operator is reviewing.
    const approved = { data: { tailored_profile: NEXT, updated_at: NEW_STAMP, status: 'approved' }, error: null };
    // Lost answer, then a re-read past review.
    const { done, calls } = run({ update: NETWORK_DROP, reselect: approved });
    // Awaited.
    const result = await done;
    // Narrow.
    if (result.ok) return assert.fail('a row past review reported as saved');
    // Not adopted as a save.
    assert.equal(result.reason, 'unconfirmed');
    // No note.
    assert.equal(inserts(calls).length, 0);
  });

  it('unconfirmed and the re-read fails -> unconfirmed, no event, and the message adopts nothing', async () => {
    // Both the write's answer and the re-read were lost.
    const { done, calls } = run({ update: NETWORK_DROP, reselect: 'throw' });
    // Awaited.
    const result = await done;
    // Narrow.
    if (result.ok) return assert.fail('an unreadable outcome reported as saved');
    // Unknown.
    assert.equal(result.reason, 'unconfirmed');
    // Nothing to adopt.
    assert.equal(result.stored, undefined);
    // No note.
    assert.equal(inserts(calls).length, 0);
    // The whole message, so it cannot claim the page is "showing the stored version".
    assert.equal(result.message, save.SAVE_MESSAGES.unconfirmedUnread);
  });

  it('unconfirmed with a stored row says the page is showing it', async () => {
    // Lost answer, readable row (someone else's).
    const result = await run({ update: NETWORK_DROP }).done;
    // Narrow.
    if (result.ok) return assert.fail('reported as saved');
    // The adopting message only when there IS something adopted.
    assert.equal(result.message, save.SAVE_MESSAGES.unconfirmedShown);
    // Positive control: the two messages really differ.
    assert.notEqual(save.SAVE_MESSAGES.unconfirmedShown, save.SAVE_MESSAGES.unconfirmedUnread);
  });

  it('changed_elsewhere with no readable row does not claim it reloaded', async () => {
    // Zero rows matched, then the re-read failed.
    const result = await run({ update: { data: [], error: null }, reselect: 'throw' }).done;
    // Narrow.
    if (result.ok) return assert.fail('reported as saved');
    // Known not to have landed.
    assert.equal(result.reason, 'changed_elsewhere');
    // The non-adopting message.
    assert.equal(result.message, save.SAVE_MESSAGES.changedUnread);
    // Positive control: a readable in-review row gets the "reloaded" message.
    const shown = await run({ update: { data: [], error: null }, reselect: LANDED }).done;
    // Narrow.
    if (shown.ok) return assert.fail('reported as saved');
    // The adopting message.
    assert.equal(shown.message, save.SAVE_MESSAGES.changedShown);
  });
});

// Shorthand: one freshness check against a fake whose re-select answers as told.
const fresh = (reselect: Answer) => save.confirmFresh(fakeClient({ reselect }).client, 'app-1', LOADED_STAMP);

describe('confirmFresh', () => {
  it('same stamp, still in review -> fresh', async () => {
    // Nothing moved since the page loaded.
    const r = await fresh({ data: { tailored_profile: NEXT, updated_at: LOADED_STAMP, status: 'awaiting_approval' }, error: null });
    // Safe to approve on the strength of the shown diff.
    assert.deepEqual(r, { kind: 'fresh' });
  });

  it('a moved stamp -> changed, with what is stored', async () => {
    // Edited in another tab.
    const r = await fresh({ data: { tailored_profile: NEXT, updated_at: NEW_STAMP, status: 'awaiting_approval' }, error: null });
    // The page can adopt the newer row instead of approving the old diff.
    assert.deepEqual(r, { kind: 'changed', stored: { resume: NEXT, updatedAt: NEW_STAMP, status: 'awaiting_approval' } });
  });

  it('same stamp but no longer in review -> changed', async () => {
    // A status move with the stamp somehow unchanged is still not approvable here.
    const r = await fresh({ data: { tailored_profile: NEXT, updated_at: LOADED_STAMP, status: 'approved' }, error: null });
    // Changed, carrying the status that says why.
    assert.equal(r.kind, 'changed');
  });

  it('no row -> changed, with nothing stored', async () => {
    // Gone, or no longer visible to this user.
    const r = await fresh({ data: null, error: null });
    // Changed, and nothing to adopt.
    assert.deepEqual(r, { kind: 'changed' });
  });

  it('any error, including a status-0 drop -> unverifiable', async () => {
    // The network-drop object: no answer is not a "fresh" answer.
    assert.deepEqual(await fresh(NETWORK_DROP), { kind: 'unverifiable' });
    // A SQLSTATE refusal is equally unable to vouch for the row.
    assert.deepEqual(await fresh({ data: null, error: { message: 'boom', code: '42501' } }), { kind: 'unverifiable' });
  });

  it('a row whose updated_at is not a string -> unverifiable', async () => {
    // A malformed answer must not compare unequal and read as "changed", nor equal and read as "fresh".
    const r = await fresh({ data: { tailored_profile: NEXT, updated_at: null, status: 'awaiting_approval' }, error: null });
    // Unknown.
    assert.deepEqual(r, { kind: 'unverifiable' });
  });

  it('a thrown client is unverifiable, never a throw', async () => {
    // from() itself blows up, before any chain exists.
    const r = await save.confirmFresh({ from() { throw new Error('client gone'); } }, 'app-1', LOADED_STAMP);
    // Contained.
    assert.deepEqual(r, { kind: 'unverifiable' });
    // A rejected chain is contained the same way.
    assert.deepEqual(await fresh('throw'), { kind: 'unverifiable' });
  });
});

/* Item 6 (2026-10-08): an approve/reject RPC whose response is lost. postgrest-js RETURNS a network
 * drop as {status:0, error.code:''} instead of throwing, so a landed approval used to read as
 * "failed": the operator retried, and the retry hit a transition error on a row already approved.
 * The page now re-reads such a row, and these hold the two pieces it calls. */
describe('isNoAnswer: the one definition of "the request got no answer"', () => {
  it('status 0, or an error with no SQLSTATE, is no answer', () => {
    // The exact shape postgrest-js returns on a dropped fetch.
    assert.equal(save.isNoAnswer(0, { code: '' }), true);
    // A code-less error on any status is still not a database verdict.
    assert.equal(save.isNoAnswer(500, { code: '' }), true);
    // Missing code entirely.
    assert.equal(save.isNoAnswer(undefined, {}), true);
    // Status 0 on its OWN means no answer, even with no error object: red-on-revert showed every
    // other case here also carried code '', so the status rule was unguarded.
    assert.equal(save.isNoAnswer(0, null), true);
  });

  it('a real SQLSTATE, or success, is an answer', () => {
    // The guard refusing: the database spoke.
    assert.equal(save.isNoAnswer(403, { code: '42501' }), false);
    // No error at all.
    assert.equal(save.isNoAnswer(200, null), false);
  });
});

// One settle re-read through the same fake client the save tests use.
const settled = (reselect: Answer, to: 'approved' | 'dropped_filter' = 'approved') =>
  save.confirmSettle(fakeClient({ reselect }).client, 'app-1', to);

describe('confirmSettle: did a no-answer transition land?', () => {
  it('stored at the target status -> landed', async () => {
    // The approval went through; only the response was lost.
    assert.equal((await settled({ data: { tailored_profile: NEXT, updated_at: NEW_STAMP, status: 'approved' }, error: null })).kind, 'landed');
  });

  it('still awaiting approval -> not_landed', async () => {
    // Nothing happened; a retry is safe.
    assert.equal((await settled({ data: { tailored_profile: NEXT, updated_at: LOADED_STAMP, status: 'awaiting_approval' }, error: null })).kind, 'not_landed');
  });

  it('some other status -> moved_elsewhere, carrying what is stored', async () => {
    // Rejected in another tab while this approval was in flight.
    const r = await settled({ data: { tailored_profile: NEXT, updated_at: NEW_STAMP, status: 'dropped_filter' }, error: null });
    // Not ours, and not retryable; the page adopts the stored row.
    assert.deepEqual(r, { kind: 'moved_elsewhere', stored: { resume: NEXT, updatedAt: NEW_STAMP, status: 'dropped_filter' } });
  });

  it('an unreadable row -> unknown, never guessed', async () => {
    // The re-read dropped too.
    assert.equal((await settled({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' } })).kind, 'unknown');
  });
});

/* Item 4 (2026-10-08): advance_application_status takes p_expected_updated_at
 * (migration 20261008130000) and refuses a stale stamp with PT409. The stamp is compared as
 * timestamptz in Postgres, which keeps MICROSECONDS; a JS Date keeps milliseconds. So the string
 * PostgREST handed us must reach the RPC byte-for-byte - one trip through Date and EVERY gated
 * approval would be refused as stale. */
describe('buildSettleArgs: the RPC arguments, with the stamp passed through untouched', () => {
  // A real-shaped PostgREST timestamptz with six fractional digits.
  const MICRO = '2026-10-08T09:57:12.123456+00:00';

  it('an approval carries the stamp string exactly as loaded', () => {
    // Built for an approval.
    const args = save.buildSettleArgs('app-1', 'approved', { review_path: 'bucket_b_review' }, MICRO);
    // Same string, same bytes: not re-serialised, not truncated to milliseconds.
    assert.equal(args.p_expected_updated_at, MICRO);
    // Proves the trap this guards against: a Date round-trip would NOT be equal.
    assert.notEqual(new Date(MICRO).toISOString(), MICRO);
  });

  it('every other argument is what the guard requires', () => {
    // The fixed fields of the human approval edge.
    const args = save.buildSettleArgs('app-1', 'approved', { a: 1 }, MICRO);
    // Row, target and the human agent the guard checks.
    assert.deepEqual({ ...args, p_expected_updated_at: undefined }, { p_application_id: 'app-1', p_to_status: 'approved', p_agent: 'human', p_detail: { a: 1 }, p_expected_updated_at: undefined });
  });

  it('a reject sends no stamp: dropping a row that changed is still a legitimate decision', () => {
    // Built for a rejection.
    const args = save.buildSettleArgs('app-1', 'dropped_filter', {}, MICRO);
    // Absent, so the RPC's DEFAULT NULL skips the stamp check.
    assert.equal('p_expected_updated_at' in args, false);
  });
});

describe('confirmSettle carries the stored row when nothing landed', () => {
  it('not_landed includes what is stored, so a PT409 can redraw the newer row', async () => {
    // Still awaiting, with a newer stamp: someone edited it.
    const r = await settled({ data: { tailored_profile: NEXT, updated_at: NEW_STAMP, status: 'awaiting_approval' }, error: null });
    // The page adopts this instead of approving the old diff.
    assert.deepEqual(r, { kind: 'not_landed', stored: { resume: NEXT, updatedAt: NEW_STAMP, status: 'awaiting_approval' } });
  });
});
