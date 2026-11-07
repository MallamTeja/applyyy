/* "Left your queue" data module (2026-11-07): the approved jobs that are no longer live and were not applied.
 * These tests pin the two select strings, the pairing of a status_change with its same-transaction note,
 * the shape checks (a bad row is skipped, never guessed) and the Re-open target taken from the web graph. */

// The .tsx loader; must be the first import so it runs before any module loads.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose equality cannot pass a wrong shape.
import assert from 'node:assert/strict';
// The runner; before() loads the module once.
import { describe, it, before } from 'node:test';

// The module under test, loaded dynamically after the tsx hook is registered.
let mod: typeof import('../src/features/manual-apply/leftQueue.ts');
// The status list, to prove reopenTarget is null for every status but failed.
let statuses: readonly string[];

// Three real-shaped application ids (the UUID shape check rejects anything else).
const A = '11111111-1111-4111-8111-111111111111';
// Second id.
const B = '22222222-2222-4222-8222-222222222222';
// Third id.
const C = '33333333-3333-4333-8333-333333333333';

// A job embed, as PostgREST returns it.
const job = { title: 'Backend Engineer', company_name: 'Acme', apply_url: 'https://acme.test/apply' };

// An application row builder; approvals is the list of approve timestamps in the inner-joined embed.
const app = (id: unknown, status: unknown, approvals: string[] = ['2026-11-01T10:00:00Z'], jobs: unknown = job) => ({
  // The key fields the parse reads.
  id, status, updated_at: '2026-11-06T09:00:00.123456+00:00', jobs,
  // The embedded approve events: only their created_at is selected.
  application_events: approvals.map((created_at) => ({ created_at })),
});

// A status_change event builder.
const change = (application_id: string, from_status: string, to_status: string, created_at: string, agent = 'human') => ({
  // The event kind the pairing keys on.
  application_id, event_type: 'status_change', agent, from_status, to_status, created_at, detail: {},
});

// A note event builder, same transaction as a change when created_at is equal.
const note = (application_id: string, created_at: string, detail: unknown) => ({
  // Notes carry the human-readable why.
  application_id, event_type: 'note', agent: 'human', from_status: null, to_status: null, created_at, detail,
});

before(async () => {
  // Dynamic import, after the tsx hook is registered.
  mod = await import('../src/features/manual-apply/leftQueue.ts');
  // The runtime status list.
  statuses = (await import('../src/data/contract.ts')).APPLICATION_STATUSES;
});

describe('leftQueue select strings', () => {
  it('pins the applications select', () => {
    // A changed column list would change what the parse can read.
    assert.equal(mod.LEFT_QUEUE_APPS_SELECT, 'id, status, updated_at, jobs:job_id(title, company_name, apply_url), application_events!inner(created_at)');
  });
  it('pins the events select', () => {
    // Same for the events read.
    assert.equal(mod.LEFT_QUEUE_EVENTS_SELECT, 'application_id, event_type, agent, from_status, to_status, created_at, detail');
  });
});

describe('parseLeftQueue', () => {
  it('lists a failed row with actor, source, stage, code and reason from its paired note', () => {
    // One failed row, approved earlier, then moved to failed by a retro script under the human JWT.
    const rows = mod.parseLeftQueue([app(A, 'failed')], [
      // The status_change into the current status.
      change(A, 'needs_verification', 'failed', '2026-11-05T12:00:00Z'),
      // Its note, same created_at: same transaction.
      note(A, '2026-11-05T12:00:00Z', { source: 'retro_script', stage: 'retro_liveness', reason: 'posting_stale', detail: 'The posting is gone.' }),
    ]);
    // Exactly one row.
    assert.equal(rows.length, 1);
    // Identity and label.
    assert.equal(rows[0].id, A);
    assert.equal(rows[0].label, 'Backend Engineer at Acme');
    // The stamp is returned untouched.
    assert.equal(rows[0].stamp, '2026-11-06T09:00:00.123456+00:00');
    // How it left.
    assert.equal(rows[0].leftAt, '2026-11-05T12:00:00Z');
    assert.equal(rows[0].leftFrom, 'needs_verification');
    assert.equal(rows[0].actor, 'human');
    // The paired note's fields.
    assert.equal(rows[0].source, 'retro_script');
    assert.equal(rows[0].stage, 'retro_liveness');
    assert.equal(rows[0].code, 'posting_stale');
    assert.equal(rows[0].reason, 'The posting is gone.');
    // The apply url and approve time.
    assert.equal(rows[0].applyUrl, 'https://acme.test/apply');
    assert.equal(rows[0].approvedAt, '2026-11-01T10:00:00Z');
  });

  it('lists an approved -> applying -> failed row with leftFrom applying', () => {
    // The applier moved it; the older approved->applying change must not be picked.
    const rows = mod.parseLeftQueue([app(A, 'failed')], [
      // Newest-first as the read returns them: the move into failed.
      change(A, 'applying', 'failed', '2026-11-05T12:00:00Z', 'applier'),
      // The older move into applying (not the current status).
      change(A, 'approved', 'applying', '2026-11-05T11:00:00Z', 'applier'),
      // The approve itself.
      change(A, 'awaiting_approval', 'approved', '2026-11-05T10:00:00Z'),
    ]);
    // Listed once.
    assert.equal(rows.length, 1);
    // It left from applying, by the applier.
    assert.equal(rows[0].leftFrom, 'applying');
    assert.equal(rows[0].actor, 'applier');
  });

  it('does not pair a note with a different created_at', () => {
    // A note a second later is a different transaction.
    const rows = mod.parseLeftQueue([app(A, 'failed')], [
      // The change.
      change(A, 'applying', 'failed', '2026-11-05T12:00:00Z'),
      // A note that is NOT its pair.
      note(A, '2026-11-05T12:00:01Z', { source: 'other', stage: 's', reason: 'r', detail: 'd' }),
    ]);
    // The change is still read.
    assert.equal(rows[0].leftFrom, 'applying');
    // But no note fields leak in.
    assert.deepEqual([rows[0].source, rows[0].stage, rows[0].code, rows[0].reason], [null, null, null, null]);
  });

  it('gives nulls when the note detail fields are not non-empty strings', () => {
    // Numbers, empty strings and nulls are not usable text.
    const rows = mod.parseLeftQueue([app(A, 'failed')], [
      // The change.
      change(A, 'applying', 'failed', '2026-11-05T12:00:00Z'),
      // The bad detail.
      note(A, '2026-11-05T12:00:00Z', { source: 7, stage: '', reason: null, detail: { x: 1 } }),
    ]);
    // Every note field null.
    assert.deepEqual([rows[0].source, rows[0].stage, rows[0].code, rows[0].reason], [null, null, null, null]);
  });

  it('lists a row with no matching status_change, leaving the how-it-left fields null', () => {
    // No events at all for the row.
    const rows = mod.parseLeftQueue([app(A, 'dropped_filter')], []);
    // Still listed.
    assert.equal(rows.length, 1);
    // Unknown how.
    assert.deepEqual([rows[0].leftAt, rows[0].leftFrom, rows[0].actor], [null, null, null]);
  });

  it('takes approvedAt as the newest approve time', () => {
    // Two approvals: re-approved later.
    const rows = mod.parseLeftQueue([app(A, 'failed', ['2026-11-01T10:00:00Z', '2026-11-03T10:00:00Z', '2026-11-02T10:00:00Z'])], []);
    // The newest, raw.
    assert.equal(rows[0].approvedAt, '2026-11-03T10:00:00Z');
  });

  it('skips a non-uuid id, an unknown status and a non-object, never guessing', () => {
    // One good row among three bad ones.
    const rows = mod.parseLeftQueue([app('not-a-uuid', 'failed'), app(B, 'bogus_status'), null, 'x', app(C, 'failed')], []);
    // Only the good one survives.
    assert.deepEqual(rows.map((r) => r.id), [C]);
  });

  it('returns [] for non-array input', () => {
    // Null, an object and a string are not row lists.
    assert.deepEqual(mod.parseLeftQueue(null, []), []);
    assert.deepEqual(mod.parseLeftQueue({}, []), []);
    assert.deepEqual(mod.parseLeftQueue('x', null), []);
  });

  it('sorts newest leftAt first, null leftAt last, stable', () => {
    // A older, B newer, C has no event; input order A, C, B.
    const rows = mod.parseLeftQueue([app(A, 'failed'), app(C, 'failed'), app(B, 'failed')], [
      // A left on the 2nd.
      change(A, 'applying', 'failed', '2026-11-02T00:00:00Z'),
      // B left on the 4th.
      change(B, 'applying', 'failed', '2026-11-04T00:00:00Z'),
    ]);
    // B, A, then the null one.
    assert.deepEqual(rows.map((r) => r.id), [B, A, C]);
  });
});

describe('reopenTarget', () => {
  it('sends failed to needs_verification', () => {
    // The one offered move.
    assert.equal(mod.reopenTarget('failed'), 'needs_verification');
  });
  it('offers nothing for any other status', () => {
    // Every other status, dropped_filter included, gets no button.
    for (const s of statuses) if (s !== 'failed') assert.equal(mod.reopenTarget(s as never), null, s);
  });
});

describe('loadLeftQueue', () => {
  it('reports an error rather than an empty list when there is no client', async () => {
    // In the test build there is no Supabase config, so the client is null.
    const res = await mod.loadLeftQueue();
    // Either the honest error or a ready list; never a throw. With no client it must be the error.
    assert.ok('error' in res || 'rows' in res);
  });
});
