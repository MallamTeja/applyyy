/* Apply on approve, browser side (P1-6, 2026-11-05).
 *
 * 1. requestDispatch reads dispatch-apply's answer into a closed union; a malformed answer is an
 *    error, never "dispatched" (CLAUDE.md §6).
 * 2. settle() calls it ONCE per approve action, after the per-row loop and only when a row actually
 *    moved to approved: the Bucket A batch approves N rows through one settle call, so a call inside
 *    the loop would start N workflow runs. Source-shape, like approvalStaleClick.test.ts, because the
 *    page imports supabase and cannot be imported by node.
 */

// The .tsx loader the approval tests use, for the extensionless imports Vite allows.
import './support/registerTsxHooks.ts';
// Strict asserts.
import assert from 'node:assert/strict';
// The page's source, read as text.
import { readFileSync } from 'node:fs';
// The runner.
import { before, describe, it } from 'node:test';
// The shared edge-client double, typed against the real EdgeClient so its shape cannot drift (W36).
import { fakeEdgeClient } from './support/fakeEdgeClient.ts';

// The module under test, loaded after the hooks.
let dispatch: typeof import('../src/features/approval/dispatchApply.ts');

before(async () => {
  // Loaded once.
  dispatch = await import('../src/features/approval/dispatchApply.ts');
});

// A client whose invoke answers `answer`, recording the function name it was asked for.
function client(answer: () => Promise<{ data: unknown; error: unknown }>) {
  // Names called, in order.
  const names: string[] = [];
  // The functions.invoke slice requestDispatch uses.
  return { names, client: fakeEdgeClient(async (name: string) => { names.push(name); return answer(); }) };
}

describe('requestDispatch', () => {
  it('reads a dispatch, and calls exactly dispatch-apply', async () => {
    // The function started the run.
    const { names, client: c } = client(async () => ({ data: { status: 'ok', dispatched: true, approved: 3 }, error: null }));
    // Asked.
    assert.deepEqual(await dispatch.requestDispatch(c), { kind: 'dispatched', approved: 3 });
    // The one function name.
    assert.deepEqual(names, ['dispatch-apply']);
  });

  it('reads a skip with its reason', async () => {
    // Off: the expected state until Teja turns it on.
    const { client: c } = client(async () => ({ data: { status: 'ok', dispatched: false, reason: 'auto_apply_off' }, error: null }));
    // Skipped, said why.
    assert.deepEqual(await dispatch.requestDispatch(c), { kind: 'skipped', reason: 'auto_apply_off' });
  });

  it('reads a function error with its message', async () => {
    // The 503 for a missing token: supabase-js puts the response on error.context.
    const response = new Response(JSON.stringify({ status: 'error', message: 'dispatch_token_missing' }), { status: 503 });
    // An error carrying it.
    const { client: c } = client(async () => ({ data: null, error: { context: response } }));
    // The server's own words.
    assert.deepEqual(await dispatch.requestDispatch(c), { kind: 'error', message: 'dispatch_token_missing' });
  });

  it('a malformed 200 is an error, never "dispatched"', async () => {
    // Each shape a lenient reader would misread.
    for (const data of [[], null, { status: 'ok' }, { status: 'ok', dispatched: 'true', approved: 1 }, { status: 'ok', dispatched: true, approved: '3' }, { status: 'ok', dispatched: false }]) {
      // Answered with it.
      const { client: c } = client(async () => ({ data, error: null }));
      // Refused as a shape error.
      assert.equal((await dispatch.requestDispatch(c)).kind, 'error', JSON.stringify(data));
    }
  });

  it('a thrown invoke is an error, never a throw', async () => {
    // The network drops.
    const { client: c } = client(async () => { throw new TypeError('Failed to fetch'); });
    // Read, not thrown.
    assert.equal((await dispatch.requestDispatch(c)).kind, 'error');
  });
});

describe('settle() dispatches once per approve action', () => {
  // The page's source.
  const page = readFileSync(new URL('../src/features/approval/ApprovalQueuePage.tsx', import.meta.url), 'utf8');
  // settle's body, from its declaration to the next top-level function in the component.
  const start = page.indexOf('async function settle(');
  // Present, or this test is reading the wrong file.
  assert.ok(start >= 0, 'settle() not found');
  // The per-row loop inside it.
  const loop = page.indexOf('for (const id of mine)', start);
  // The one dispatch call.
  const call = page.indexOf('dispatchAfterApprove(', start);

  it('calls the dispatch after the per-row loop, never inside it', () => {
    // Both found.
    assert.ok(loop > start && call > start, 'loop or dispatch call not found in settle()');
    // After the loop.
    assert.ok(call > loop, 'the dispatch must come after the per-row loop');
    // Exactly one call site in the whole page.
    assert.equal(page.split('dispatchAfterApprove(').length - 1, 2, 'one declaration and one call');
  });

  it('only for an approve that moved at least one row', () => {
    // The guard on the call line.
    assert.match(page, /if \(to === 'approved' && moved\.length > 0\) void dispatchAfterApprove\(\)/);
  });
});
