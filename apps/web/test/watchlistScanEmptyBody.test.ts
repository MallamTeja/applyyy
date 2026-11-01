/* Code-review finding #9 (2026-11-01): an empty 2xx scout-ats response threw instead of
 * returning a message.
 *
 * WHY: `runWatchlistScan` described an unrecognised body with `JSON.stringify(data).slice(...)`.
 * `JSON.stringify(undefined)` is `undefined`, so `.slice` threw inside a function DiscoveryModal
 * trusts never to throw: it expects `{ ok: false, message }` to show. A missing body must become
 * a stated failure, never a crash (CLAUDE.md section 6).
 *
 * HOW: the optional `client` parameter takes a fake whose `functions.invoke` answers
 * `{ data, error }` the way functions-js does - it never throws. */

// The loader first: discoveryService imports './supabase' without an extension, as Vite allows.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose match cannot pass a wrong result.
import assert from 'node:assert/strict';
// One describe, a before() for the import, one it() per body.
import { describe, it, before } from 'node:test';

// The service under test, loaded after the hooks are registered.
let service: typeof import('../src/data/discoveryService.ts');

// A fake client whose scout-ats call answers a 2xx with this body and no error.
function clientAnswering(data: unknown) {
  // Only `functions.invoke` is reached on this path.
  const fake = { functions: { invoke: async () => ({ data, error: null }) } };
  // Cast once: the service reaches nothing else.
  return fake as unknown as Parameters<typeof service.runWatchlistScan>[1];
}

describe('an unrecognised 2xx scout-ats body is reported, never thrown (finding #9)', () => {
  before(async () => {
    // Loaded after the hooks so './supabase' resolves.
    service = await import('../src/data/discoveryService.ts');
  });

  // Each empty shape functions-js can hand back for a 2xx with no usable body.
  for (const [label, data] of [['undefined', undefined], ['null', null], ['an empty string', '']] as const) {
    it(`an empty 2xx body (${label}) returns ok:false with a readable message`, async () => {
      // Must resolve; a throw here is the bug.
      const result = await service.runWatchlistScan(undefined, clientAnswering(data));
      // Not a success: nothing says what ran.
      assert.equal(result.ok, false);
      // The machine-readable reason is the unrecognised-body one.
      assert.equal(result.error, 'unrecognised_response');
      // The sentence names the empty body instead of printing "undefined".
      assert.match(result.message, /empty body/);
      // Zeros alongside ok:false, so nothing reads it as a scan that found nothing.
      assert.equal(result.appsCreated, 0);
    });
  }

  it('a non-empty unrecognised body is still quoted so the mismatch is diagnosable', async () => {
    // A shape scout-ats never sends.
    const result = await service.runWatchlistScan(undefined, clientAnswering({ surprise: 1 }));
    // Reported, not accepted.
    assert.equal(result.ok, false);
    // The body itself appears, as before the fix.
    assert.match(result.message, /\{"surprise":1\}/);
  });

  it('a recognised body still succeeds (accept twin)', async () => {
    // The full-run shape parseScoutAtsResponse accepts.
    const result = await service.runWatchlistScan(undefined, clientAnswering({ success: true, boards_polled: 2, jobs_discovered: 5, applications_created: 1, results: [] }));
    // Non-vacuity: the failure path above is not where every body lands.
    assert.equal(result.ok, true);
  });
});
