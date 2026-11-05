/* Tests for the System health recovery write path (features/health/advanceRecovery.ts, 2026-10-09).
 *
 * WHAT THESE PROTECT. The one function that moves a stuck row off the submit boundary. Two lies it
 * must never tell: "done" or "failed" when the database gave NO answer (the call may still commit),
 * and "moved elsewhere" for a row that simply has not moved yet. The second one hinges on the
 * read-back measuring against the move's REAL source, which is why confirmSettle grew a `from`.
 *
 * THE DOUBLE MIMICS supabase-js, not a convenient fiction: rpc() RESOLVES {data, error, status} on a
 * 4xx/5xx and on a dropped network (status 0, code ''); it does not throw. The read-back chain
 * from().select().eq().maybeSingle() RESOLVES {data, error}. A double that threw where the real
 * client returns would certify a path production never takes. One test does make rpc throw, on
 * purpose, because the source handles that case explicitly and it must stay handled. */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, it, before } from 'node:test';

// Copied from saveTailoredEdit.test.ts: saveTailoredEdit.ts imports './tailoredEdits' with no extension.
registerHooks({
  // Extensionless RELATIVE imports only: try the original, then .tsx, then .ts.
  resolve(specifier, context, nextResolve) {
    // Packages and already-extended paths resolve normally.
    if (!specifier.startsWith('.') || /\.[cm]?[jt]sx?$|\.css$/.test(specifier)) return nextResolve(specifier, context);
    // First the way Vite would write it, so a real .js sibling still wins.
    try { return nextResolve(specifier, context); } catch { /* fall through to TS extensions */ }
    // A component is the usual case for an extensionless import here.
    try { return nextResolve(`${specifier}.tsx`, context); } catch { /* then a plain module */ }
    // Last resort; a genuine miss throws from here with the .ts path named.
    return nextResolve(`${specifier}.ts`, context);
  },
});

// Loaded after the hook is registered; a static import would resolve before registerHooks runs.
let mod: typeof import('../src/features/health/advanceRecovery.ts');
// Dynamic import inside before(), so a resolve failure CANCELS the suite visibly rather than hiding.
before(async () => {
  // The module under test, through the hook above.
  mod = await import('../src/features/health/advanceRecovery.ts');
});

// A microsecond stamp: a Date round-trip would drop the last three digits and fail the equality.
const STAMP = '2026-10-09T07:37:55.803788+00:00';
// The row every test moves; its value is irrelevant, its presence in the args is not.
const ID = '11111111-2222-3333-4444-555555555555';

// supabase-js's shapes, typed loosely so each test states exactly what the wire returned.
type RpcResult = { data?: unknown; error: { code: string; message: string } | null; status: number };
// What maybeSingle() resolves to.
type ReadResult = { data: Record<string, unknown> | null; error: { code: string; message: string } | null };

/* A recording double. `rpc` is either a resolved result or 'throw'; `read` is what the re-read sees.
   Every call is logged so a test can prove a read did or did NOT happen. */
function makeClient(rpc: RpcResult | 'throw', read?: ReadResult) {
  // Ordered log of what the code under test touched.
  const calls: string[] = [];
  // The args each rpc call carried, so the stamp can be checked on the wire too.
  const rpcArgs: Record<string, unknown>[] = [];
  const client = {
    // Resolves like supabase-js; throws only when a test asks for it.
    rpc(fn: string, args: Record<string, unknown>) {
      // Logged first, so a throwing rpc is still visible in the trace.
      calls.push('rpc:' + fn);
      // Kept for wire-level assertions.
      rpcArgs.push(args);
      // The explicit throw case: the source must treat it as no answer.
      if (rpc === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
      // The normal case: a resolved {data, error, status}, never a throw.
      return Promise.resolve({ data: null, ...rpc });
    },
    // The read-back chain; each step records itself so the exact query is provable.
    from(table: string) {
      // Which table the re-read hit.
      calls.push('from:' + table);
      // The builder, chained exactly as readBack walks it.
      const builder = {
        // Columns requested, logged so a narrowed select would show up.
        select(cols: string) { calls.push('select:' + cols); return builder; },
        // The id filter.
        eq(col: string, val: unknown) { calls.push(`eq:${col}=${String(val)}`); return builder; },
        // Resolves {data, error}; a test that never configured a read gets a loud failure instead.
        maybeSingle() {
          // The terminal call of the chain.
          calls.push('maybeSingle');
          // A read the test did not expect must not silently succeed.
          if (read === undefined) return Promise.reject(new Error('unexpected read-back'));
          // The configured row (or error), as PostgREST would hand it back.
          return Promise.resolve(read);
        },
      };
      // Chain starts here.
      return builder;
    },
  };
  // Test reads `calls` and `rpcArgs` after the run.
  return { client, calls, rpcArgs };
}

// A read-back that found the row at `status`.
function rowAt(status: string): ReadResult {
  // updated_at must be a string, or readBack treats the row as unreadable.
  return { data: { tailored_profile: null, updated_at: STAMP, status }, error: null };
}

// A read-back that itself got no answer, in supabase-js's own shape.
const READ_FAILED: ReadResult = { data: null, error: { code: '', message: 'TypeError: Failed to fetch' } };
// The network-drop shape rpc() resolves to.
const DROPPED: RpcResult = { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };

// The default move under test: the stuck-submission queue's one human edge.
const MOVE = { source: 'health_recovery', applicationId: ID, from: 'applying', to: 'needs_verification', stamp: STAMP } as const;

describe('buildRecoveryArgs', () => {
  it('sends p_agent human, the stamp string byte-for-byte, the source in p_detail and the target', () => {
    // Built once and inspected field by field.
    const args = mod.buildRecoveryArgs(MOVE);
    // The only agent a browser may honestly claim.
    assert.equal(args.p_agent, 'human');
    // Strict string equality: a Date-parsed stamp would lose the microseconds and be refused as stale.
    assert.equal(args.p_expected_updated_at, STAMP);
    // And it must be the string itself, not something that stringifies to it.
    assert.equal(typeof args.p_expected_updated_at, 'string');
    // The target the graph checks.
    assert.equal(args.p_to_status, 'needs_verification');
    // The row.
    assert.equal(args.p_application_id, ID);
    // The event log records where the move started.
    assert.equal((args.p_detail as { from: string }).from, 'applying');
    // And which screen made it, as given.
    assert.equal((args.p_detail as { source: string }).source, 'health_recovery');
  });

  it('records the Manual apply card as its own source, never as System health (append-only log)', () => {
    // The same move made from the kit card.
    const args = mod.buildRecoveryArgs({ ...MOVE, source: 'manual_apply' });
    // The log names the screen the operator actually used.
    assert.deepEqual(args.p_detail, { source: 'manual_apply', from: 'applying' });
  });
});

describe('advanceRecovery outcomes', () => {
  it('200 with no error is moved, without a read-back', async () => {
    // A clean success needs no confirmation.
    const { client, calls, rpcArgs } = makeClient({ error: null, status: 200 });
    // The move under test.
    assert.deepEqual(await mod.advanceRecovery(client, MOVE), { kind: 'moved' });
    // No re-read on a real answer.
    assert.deepEqual(calls, ['rpc:advance_application_status']);
    // The wire carried the same stamp the pure builder promised.
    assert.equal(rpcArgs[0].p_expected_updated_at, STAMP);
  });

  it('status 0 and a read-back at the target is moved', async () => {
    // The answer was lost but the row says it landed.
    const { client } = makeClient(DROPPED, rowAt('needs_verification'));
    // Confirmed by the re-read, so it counts as done.
    assert.deepEqual(await mod.advanceRecovery(client, MOVE), { kind: 'moved' });
  });

  it('status 0 and a read-back still at the source is unconfirmed, not failed', async () => {
    // Lost answer, row untouched: the call may still commit after this read.
    const { client } = makeClient(DROPPED, rowAt('applying'));
    // Never "failed" and never a safe retry.
    assert.deepEqual(await mod.advanceRecovery(client, MOVE), { kind: 'unconfirmed' });
  });

  it('status 0 and a read-back at a third status is moved_elsewhere carrying that status', async () => {
    // The sweeper (or another tab) moved it somewhere neither side asked for.
    const { client } = makeClient(DROPPED, rowAt('failed'));
    // The outcome must name where it is.
    const out = await mod.advanceRecovery(client, MOVE);
    // Narrowed by kind before reading the payload.
    assert.equal(out.kind, 'moved_elsewhere');
    // The stored status rides along for the message.
    assert.equal(out.kind === 'moved_elsewhere' && out.stored.status, 'failed');
  });

  it('status 0 and a failed read-back is unknown', async () => {
    // Neither the write nor the re-read answered.
    const { client } = makeClient(DROPPED, READ_FAILED);
    // Said as unknown, never guessed.
    assert.deepEqual(await mod.advanceRecovery(client, MOVE), { kind: 'unknown' });
  });

  it('PT409 with the row still at the source is stale', async () => {
    // A stale stamp: the row was edited since load, not moved.
    const { client } = makeClient({ error: { code: 'PT409', message: 'stale' }, status: 409 }, rowAt('applying'));
    // The operator must look again.
    assert.deepEqual(await mod.advanceRecovery(client, MOVE), { kind: 'stale' });
  });

  it('PT409 with the row already at the target is already_there', async () => {
    // Refused because someone else made the same move first.
    const { client } = makeClient({ error: { code: 'PT409', message: 'stale' }, status: 409 }, rowAt('needs_verification'));
    // Not "moved" (this click did nothing) and not "refused" (the row IS where asked).
    assert.deepEqual(await mod.advanceRecovery(client, MOVE), { kind: 'already_there' });
  });

  it('42501 with the row at a third status is moved_elsewhere', async () => {
    // The transition guard refused because the row has left the source.
    const { client } = makeClient({ error: { code: '42501', message: 'not allowed' }, status: 403 }, rowAt('failed'));
    // Told where it is, never just "failed".
    const out = await mod.advanceRecovery(client, MOVE);
    // Kind first.
    assert.equal(out.kind, 'moved_elsewhere');
    // Then the named status.
    assert.equal(out.kind === 'moved_elsewhere' && out.stored.status, 'failed');
  });

  it('23514 with the row still at the source is refused, keeping the code and message', async () => {
    // A guard refusal on an untouched row: the database's own reason stands.
    const { client } = makeClient({ error: { code: '23514', message: 'check violated' }, status: 400 }, rowAt('applying'));
    // The code and words survive to the message table.
    assert.deepEqual(await mod.advanceRecovery(client, MOVE), { kind: 'refused', code: '23514', message: 'check violated' });
  });

  it('P0002 is refused with no read-back at all', async () => {
    // Not found or not yours: no re-read can change that. No read configured, so one would reject.
    const { client, calls } = makeClient({ error: { code: 'P0002', message: 'not found' }, status: 404 });
    // The refusal is reported directly.
    assert.deepEqual(await mod.advanceRecovery(client, MOVE), { kind: 'refused', code: 'P0002', message: 'not found' });
    // Proof by trace: only the rpc ran, the applications table was never touched.
    assert.deepEqual(calls, ['rpc:advance_application_status']);
  });

  it('a throwing rpc is treated as no answer and the row is re-read', async () => {
    // A client that throws instead of resolving; the source promises never to throw back.
    const { client, calls } = makeClient('throw', rowAt('applying'));
    // Same verdict as status 0 with the row untouched.
    assert.deepEqual(await mod.advanceRecovery(client, MOVE), { kind: 'unconfirmed' });
    // The re-read really happened, against the right table and row.
    assert.deepEqual(calls, [
      'rpc:advance_application_status',
      'from:applications',
      'select:tailored_profile, updated_at, status',
      `eq:id=${ID}`,
      'maybeSingle',
    ]);
  });
});

describe('the read-back measures against the move\'s real source', () => {
  it('a needs_verification move still at needs_verification after no answer is unconfirmed, not moved_elsewhere', async () => {
    /* THE GUARD ON THE confirmSettle `from` WIDENING. Without the 4th argument, confirmSettle assumes
       the source is awaiting_approval, so a row sitting untouched at needs_verification reads as
       "moved elsewhere" - telling the operator someone else acted when nothing happened at all. */
    const move = { applicationId: ID, from: 'needs_verification', to: 'applied', stamp: STAMP } as const;
    // No answer, row untouched at its real source.
    const { client } = makeClient(DROPPED, rowAt('needs_verification'));
    // Must be the honest "may still land" answer.
    assert.deepEqual(await mod.advanceRecovery(client, move), { kind: 'unconfirmed' });
  });
});

describe('describeRecovery and confirmText', () => {
  it('every outcome kind has a non-empty sentence, and moved_elsewhere names the stored status', () => {
    // A stored row at a status no other message would mention.
    const stored = { resume: null, updatedAt: STAMP, status: 'blocked_needs_human' };
    // One of each kind in the closed union.
    const outcomes = [
      { kind: 'moved' },
      { kind: 'already_there' },
      { kind: 'moved_elsewhere', stored },
      { kind: 'stale' },
      { kind: 'unconfirmed' },
      { kind: 'unknown' },
      { kind: 'refused', code: 'P0001', message: 'illegal edge' },
    ] as const;
    // A blank message would leave the operator with a silent card.
    for (const outcome of outcomes) {
      // Trimmed, so whitespace cannot pass for a message.
      assert.ok(mod.describeRecovery(outcome, MOVE).trim().length > 0, outcome.kind);
    }
    // The operator is told where the row actually is.
    assert.match(mod.describeRecovery(outcomes[2], MOVE), /blocked_needs_human/);
  });

  it('confirmText names the label, from and to, and warns about real submission only for applied', () => {
    // A move into applied: the irreversible claim.
    const toApplied = mod.confirmText('Acme SWE', { from: 'needs_verification', to: 'applied' });
    // The row and both ends of the move are named.
    for (const part of ['Acme SWE', 'needs_verification', 'applied']) assert.ok(toApplied.includes(part), part);
    // The extra warning appears.
    assert.match(toApplied, /actually submitted/);
    // A move into failed carries no such warning: it claims nothing went out.
    const toFailed = mod.confirmText('Acme SWE', { from: 'needs_verification', to: 'failed' });
    // Absence checked on a real, non-empty message that names the move.
    assert.ok(toFailed.includes('failed') && !/actually submitted/.test(toFailed));
  });
});

// Review fix (2026-10-09): the held edge is refused by the ENGINE, not only by a disabled button.
describe('advanceRecovery: a held edge never reaches the database', () => {
  it('needs_verification -> approved is refused as HELD with no rpc and no read-back', async () => {
    // A double that would happily accept the move, so only the engine's own check can stop it.
    const { client, calls } = makeClient({ error: null, status: 204 });
    // The one edge HELD_HUMAN_EDGES keeps off: under automatic submission it re-arms a real send.
    const outcome = await mod.advanceRecovery(client, { applicationId: ID, from: 'needs_verification', to: 'approved', stamp: STAMP });
    // Refused locally, with the hold's own code, so the message cannot be mistaken for a database verdict.
    assert.equal(outcome.kind, 'refused');
    // Narrowed for the code check.
    assert.equal(outcome.kind === 'refused' ? outcome.code : '', 'HELD');
    // Nothing went over the wire at all: no write, no re-read.
    assert.deepEqual(calls, []);
  });
});
