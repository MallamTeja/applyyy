/* Tests for the Discovered page's one-click Reject and its Undo (features/discovery/rejectJob.ts, 2026-11-01).
 *
 * WHAT THESE PROTECT. Three promises the page makes without a confirm dialog:
 *  - the button appears only where the move is reversible (both human edges exist), so the Discovered
 *    lane never gets one and no lane gets a one-click move it cannot take back;
 *  - the write is the RPC as 'human', to dropped_filter (or back), and nothing else;
 *  - a card leaves the list only on a CONFIRMED move. supabase-js RESOLVES {error, status} on a 4xx and
 *    on a dropped network (status 0); it does not throw, so the double below resolves the same way.
 */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, it, before } from 'node:test';

// Same hook as advanceRecovery.test.ts: rejectJob.ts imports saveTailoredEdit.ts, which imports extensionless paths.
registerHooks({
  // Extensionless RELATIVE imports only: try the original, then .tsx, then .ts.
  resolve(specifier, context, nextResolve) {
    // Packages and already-extended paths resolve normally.
    if (!specifier.startsWith('.') || /\.[cm]?[jt]sx?$|\.css$/.test(specifier)) return nextResolve(specifier, context);
    // First the way Vite would write it.
    try { return nextResolve(specifier, context); } catch { /* fall through to TS extensions */ }
    // A component next.
    try { return nextResolve(`${specifier}.tsx`, context); } catch { /* then a plain module */ }
    // Last resort; a genuine miss throws with the .ts path named.
    return nextResolve(`${specifier}.ts`, context);
  },
});

// Loaded after the hook; a static import would resolve before registerHooks runs.
let mod: typeof import('../src/features/discovery/rejectJob.ts');
// The page's lane mapping, so the "which lane gets Reject" test reads the real lane statuses.
let lanes: typeof import('../src/features/discovery/discoveredList.ts');
// Dynamic imports inside before(), so a resolve failure CANCELS the suite visibly.
before(async () => {
  // The module under test.
  mod = await import('../src/features/discovery/rejectJob.ts');
  // The lane mapping the page renders from.
  lanes = await import('../src/features/discovery/discoveredList.ts');
});

// A real-shaped id; its value is irrelevant, its presence in the args is not.
const ID = '11111111-2222-3333-4444-555555555555';

/* A recording double that resolves like supabase-js (or rejects, when a test asks for the throw case). */
function makeClient(result: { error: { code: string; message: string } | null; status?: number } | 'throw') {
  // Every call, so a test can prove an rpc did or did NOT happen and what it carried.
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    // The only method the helper uses.
    rpc(fn: string, args: Record<string, unknown>) {
      // Logged first, so a throwing call is still visible.
      calls.push({ fn, args });
      // The explicit throw case.
      if (result === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
      // The normal case: resolved, never thrown.
      return Promise.resolve({ data: null, ...result });
    },
  };
  return { client, calls };
}

describe('canReject: which lanes get the button', () => {
  it('the Ready to tailor lane gets Reject and the Discovered lane does not', () => {
    // passed_filters -> dropped_filter and back are both human edges.
    assert.equal(mod.canReject(lanes.LANES.ready.status), true);
    // discovered has no human edge to dropped_filter at all; adding one is a migration, not this button.
    assert.equal(mod.canReject(lanes.LANES.discovered.status), false);
  });

  it('a status with a human reject edge but no human way back gets no one-click Reject', () => {
    // Each has a human edge INTO dropped_filter, none has one back, so Undo could not exist.
    for (const status of ['deduped', 'scored', 'awaiting_approval', 'blocked_needs_human'] as const) {
      // A one-click move with no way back would need a confirm dialog this button does not have.
      assert.equal(mod.canReject(status), false, status);
    }
    // And a rejected row cannot be rejected again.
    assert.equal(mod.canReject('dropped_filter'), false);
  });
});

describe('buildRejectArgs: the one write', () => {
  it('reject sends passed_filters to dropped_filter as human, with a detail naming the screen', () => {
    // The whole argument object, so an extra or missing key fails too.
    assert.deepEqual(mod.buildRejectArgs({ kind: 'reject', applicationId: ID, from: 'passed_filters' }), {
      // The row.
      p_application_id: ID,
      // The graph's existing human-discard status.
      p_to_status: 'dropped_filter',
      // The only agent a browser may claim.
      p_agent: 'human',
      // Lands on a 'note' event, so the log says why and from where.
      p_detail: { reason: 'human_rejected', screen: 'discovered' },
    });
  });

  it('undo sends the row back to the lane it was rejected from', () => {
    // Back to `from`, with its own reason, so the log tells a reject from its undo.
    assert.deepEqual(mod.buildRejectArgs({ kind: 'undo', applicationId: ID, from: 'passed_filters' }), {
      // The same row.
      p_application_id: ID,
      // The lane it left.
      p_to_status: 'passed_filters',
      // Still the human.
      p_agent: 'human',
      // Distinct from the reject's reason.
      p_detail: { reason: 'human_undo_reject', screen: 'discovered' },
    });
  });
});

describe('rejectOutcome: only a confirmed move removes the card', () => {
  it('no error and a 2xx is moved', () => {
    // The RPC returns the row: 200.
    assert.deepEqual(mod.rejectOutcome({ error: null, status: 200 }), { kind: 'moved' });
    // A 204 is a 2xx as well.
    assert.deepEqual(mod.rejectOutcome({ error: null, status: 204 }), { kind: 'moved' });
  });

  it('status 0 is no answer, not a failure and not a success', () => {
    // The dropped-network shape supabase-js resolves with.
    assert.deepEqual(mod.rejectOutcome({ error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 }), { kind: 'no_answer' });
  });

  it('a database refusal keeps its code and words', () => {
    // RLS hides another user's row as "not found".
    assert.deepEqual(mod.rejectOutcome({ error: { code: 'P0002', message: 'application x not found (or not yours)' }, status: 404 }), {
      kind: 'refused',
      code: 'P0002',
      message: 'application x not found (or not yours)',
    });
  });

  it('no error but no 2xx status is NOT moved (positive shape, never absence of an error)', () => {
    // A missing status is not proof of a write.
    assert.equal(mod.rejectOutcome({ error: null }).kind, 'refused');
    // Nor is a non-2xx with no error object.
    assert.equal(mod.rejectOutcome({ error: null, status: 500 }).kind, 'refused');
  });
});

describe('moveRejectedJob: the call itself', () => {
  it('calls advance_application_status once with the built args and reports moved', async () => {
    // A double that accepts.
    const { client, calls } = makeClient({ error: null, status: 200 });
    // The page's reject.
    const outcome = await mod.moveRejectedJob(client, { kind: 'reject', applicationId: ID, from: 'passed_filters' });
    // Confirmed.
    assert.deepEqual(outcome, { kind: 'moved' });
    // Exactly one call, to the RPC, carrying exactly the pure builder's args.
    assert.deepEqual(calls, [{ fn: 'advance_application_status', args: mod.buildRejectArgs({ kind: 'reject', applicationId: ID, from: 'passed_filters' }) }]);
  });

  it('a throwing client is no answer, never a throw out of the helper', async () => {
    // The case the source handles explicitly.
    const { client } = makeClient('throw');
    // Resolves rather than rejects, so the card's lock is always released with a message.
    assert.deepEqual(await mod.moveRejectedJob(client, { kind: 'reject', applicationId: ID, from: 'passed_filters' }), { kind: 'no_answer' });
  });

  it('a lane without both human edges is refused locally with no rpc', async () => {
    // A double that would accept anything, so only the local check can stop it.
    const { client, calls } = makeClient({ error: null, status: 200 });
    // A forced reject from the Discovered lane.
    const outcome = await mod.moveRejectedJob(client, { kind: 'reject', applicationId: ID, from: 'discovered' });
    // Refused with a code no SQLSTATE uses.
    assert.equal(outcome.kind === 'refused' ? outcome.code : outcome.kind, 'NOT_OFFERED');
    // Nothing went over the wire.
    assert.deepEqual(calls, []);
  });
});

describe('describeReject: the sentences', () => {
  it('a confirmed reject reads "Rejected <Company> — <Title>."', () => {
    // The exact status-line sentence the owner asked for.
    assert.equal(mod.describeReject({ kind: 'moved' }, 'reject', 'Acme — Engineer', 'Ready to tailor'), 'Rejected Acme — Engineer.');
    // The undo names the lane the card returns to.
    assert.equal(mod.describeReject({ kind: 'moved' }, 'undo', 'Acme — Engineer', 'Ready to tailor'), 'Undone: Acme — Engineer is back in Ready to tailor.');
  });

  it('a failure never says Rejected, and carries the database code', () => {
    // The refusal sentence.
    const text = mod.describeReject({ kind: 'refused', code: 'P0002', message: 'not found' }, 'reject', 'Acme — Engineer', 'Ready to tailor');
    // Never reads as done.
    assert.ok(!text.startsWith('Rejected'), text);
    // Names the code for diagnosis.
    assert.ok(text.includes('(P0002)'), text);
  });
});
