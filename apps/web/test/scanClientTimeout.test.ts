/* Pending item S (2026-11-21): the Scan Watchlist button spun forever on a hung request.
 *
 * WHY: runWatchlistScan awaited scout-ats with no client timeout. Measured 2026-11-20, a scan takes about
 * 100 s, so a slow scan and a dead connection looked the same: a spinner with no end. The fix is an opt-in
 * client timeout in invokeEdge, set ABOVE the platform's own limit (so it can never cut off an answer the
 * server could still send), mapped to the scan's existing `server_timeout` result. The modal also shows
 * the elapsed time, so a 100 s scan reads as "working", not "stuck".
 *
 * HOW: the doubles behave like supabase-js 2.4.4's functions.invoke: they RETURN { data, error } and never
 * throw. A "hung" call is one that answers only after the test's tiny timeout has passed, so a reverted
 * timeout shows up as a wrong answer (a named assertion), never as a test that hangs. */

// The loader first: discoveryService imports './supabase' without an extension, as Vite allows.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose match cannot pass a wrong result.
import assert from 'node:assert/strict';
// The runner every web test uses; before() loads the app modules after the hook.
import { before, describe, it } from 'node:test';

// The shared edge helper under test.
let edge: typeof import('../src/data/edgeCall.ts');
// The scan under test.
let service: typeof import('../src/data/discoveryService.ts');
// The modal, for its pure elapsed-time formatter.
let modal: typeof import('../src/features/pipeline/DiscoveryModal.tsx');

// A fake client whose invoke answers after `delayMs` with `answer`, recording each call's options.
function slowClient(delayMs: number, answer: { data: unknown; error: unknown }) {
  // Every invoke's options, so the test can prove the timeout never leaks into what invoke is sent.
  const sent: unknown[] = [];
  // Only functions.invoke and auth are reachable from invokeEdge.
  const client = {
    functions: {
      // Resolves late, like a scan that runs long; never throws, like the real invoke.
      invoke: (_name: string, options?: unknown) => {
        // Recorded verbatim.
        sent.push(options);
        // The late answer.
        return new Promise<{ data: unknown; error: unknown }>((resolve) => setTimeout(() => resolve(answer), delayMs));
      },
    },
    // Never reached on these paths (no 401); present so the type is a full EdgeClient.
    auth: { refreshSession: async () => ({ error: null }), signOut: async () => ({ error: null }) },
  };
  // Cast once: the scan's parameter is the app's supabase client type, which this double stands in for.
  return { client: client as unknown as Parameters<typeof service.runWatchlistScan>[1] & import('../src/data/edgeCall.ts').EdgeClient, sent };
}

// A scout-ats success body, so "the late answer won" is visible as ok:true.
const SUCCESS = { data: { ok: true, boards_polled: 1, jobs_discovered: 2, applications_created: 2 }, error: null };

describe('Scan Watchlist client timeout (pending S)', () => {
  before(async () => {
    // Loaded after the hooks so extensionless imports resolve.
    edge = await import('../src/data/edgeCall.ts');
    // Same.
    service = await import('../src/data/discoveryService.ts');
    // Same; the .tsx loader is registered above.
    modal = await import('../src/features/pipeline/DiscoveryModal.tsx');
  });

  it('the client timeout sits above the edge platform limit, so it never cuts off a real answer', () => {
    // 150 s: the request idle timeout on every plan and the Free plan wall clock (supabase.com/docs/guides/functions/limits).
    assert.equal(edge.EDGE_REQUEST_LIMIT_MS, 150_000);
    // Strictly above it, with margin for the 504 itself to travel back.
    assert.ok(edge.EDGE_CLIENT_TIMEOUT_MS > edge.EDGE_REQUEST_LIMIT_MS, 'client timeout must exceed the platform limit');
  });

  it('invokeEdge with timeoutMs gives up on a hung call with an EdgeTimeoutError', async () => {
    // Answers after 300 ms; the timeout is 20 ms.
    const { client } = slowClient(300, SUCCESS);
    // The opt-in timeout.
    const answer = await edge.invokeEdge(client, 'scout-ats', { body: {} }, 20);
    // Still the 'answered' shape every caller already reads.
    assert.equal(answer.kind, 'answered');
    // Narrowed for the error read.
    if (answer.kind !== 'answered') return;
    // The distinct class, so a caller can tell "we stopped waiting" from a network drop.
    assert.ok(answer.error instanceof edge.EdgeTimeoutError, 'expected an EdgeTimeoutError');
    // No data: nothing was answered.
    assert.equal(answer.data, null);
  });

  it('invokeEdge without timeoutMs waits, and the options invoke receives are unchanged', async () => {
    // Slower than the other test's timeout, to prove no default timeout exists.
    const { client, sent } = slowClient(60, SUCCESS);
    // No fourth argument: the behaviour every other call site keeps.
    const answer = await edge.invokeEdge(client, 'dispatch-apply');
    // The late answer arrives.
    assert.equal(answer.kind, 'answered');
    // Narrowed for the reads.
    if (answer.kind !== 'answered') return;
    // No error: nothing timed out.
    assert.equal(answer.error, null);
    // invoke got exactly what the caller passed (undefined), so edgeCallSites' pin holds.
    assert.deepEqual(sent, [undefined]);
  });

  it('a hung scan becomes the existing server_timeout result, never an endless spinner', async () => {
    // A scan that answers only after the 20 ms client timeout.
    const { client, sent } = slowClient(300, SUCCESS);
    // The third argument is the test's tiny timeout; the app passes none and gets EDGE_CLIENT_TIMEOUT_MS.
    const result = await service.runWatchlistScan(undefined, client, 20);
    // The same machine-readable reason as the server's own 504/546.
    assert.equal(result.error, 'server_timeout');
    // Not a success.
    assert.equal(result.ok, false);
    // The same sentence family: may still be running, check the Discovered page.
    assert.match(result.message, /did not answer in time .*Discovered page/);
    // invoke still got only the body: the timeout lives in invokeEdge, not in invoke's options.
    assert.deepEqual(sent, [{ body: {} }]);
  });

  it('a 504 keeps its own wording (HTTP 504), shared with the client timeout', async () => {
    // A FunctionsHttpError-like error: the raw Response rides behind `context`.
    const { client } = slowClient(0, { data: null, error: { context: new Response('{}', { status: 504 }) } });
    // A long timeout: the 504 arrives first.
    const result = await service.runWatchlistScan(undefined, client, 5_000);
    // Same reason as before this change.
    assert.equal(result.error, 'server_timeout');
    // The e2e suite matches /HTTP 504.*Discovered page/; the wording must keep that.
    assert.match(result.message, /HTTP 504.*Discovered page/);
  });

  it('formatElapsed shows minutes and zero-padded seconds', () => {
    // Under a minute.
    assert.equal(modal.formatElapsed(7_400), '0:07');
    // The measured ~100 s scan.
    assert.equal(modal.formatElapsed(102_000), '1:42');
    // A negative span (clock skew) never prints a minus sign.
    assert.equal(modal.formatElapsed(-5), '0:00');
    // A non-finite input is not an answer: it shows zero, never "NaN:NaN".
    assert.equal(modal.formatElapsed(Number.NaN), '0:00');
  });
});
