// S29 (Teja 2026-11-21 22:58, reported on Canonical 11f9a906): a stale apply claim was never reclaimed. The only
// sweep_stale_claims caller was the scheduled claim loop, and Teja ruled out cron, so a row a local assist left at
// `applying` stayed there, and `applying -> applied|failed` is applier/tracker only: the human could not record it.
// The fix sweeps at the top of the assist CLI too. Live graph (SELECT 2026-11-24): `applying -> needs_verification`
// allows {sweeper,human}; `needs_verification -> applied|failed` allows {human}. So once swept, a human records it.
//
// A SOURCE test, like assist-cli.test.ts and for its reason: assist.ts runs main() on import, so importing it would
// run the real CLI. The order below is the contract: an unswept row must never reach the browser flow first.
import { readFileSync } from 'node:fs';
// Resolves the CLI file from this test's own location, so any cwd works.
import { fileURLToPath } from 'node:url';
// The worker's test runner.
import { describe, expect, it } from 'vitest';

// The assist CLI's source, read once.
const source = readFileSync(fileURLToPath(new URL('../src/cli/assist.ts', import.meta.url)), 'utf8');

// The first offset of a code marker; -1 would make every ordering assertion below meaningless, so it is refused here.
function at(marker: string): number {
  // First occurrence.
  const offset = source.indexOf(marker);
  // A renamed call must fail by name, not pass vacuously on -1 < n.
  expect(offset, `marker not found in assist.ts: ${marker}`).toBeGreaterThan(-1);
  // Found.
  return offset;
}

describe('S29: the assist CLI sweeps stale claims before it touches a row', () => {
  it('calls the shared sweepStaleClaims (one RPC + its agent_runs row), not a hand-rolled rpc', () => {
    // The worker gateway's own sweep, the same one the claim loop calls.
    expect(source).toMatch(/createSupabaseGateway\([^)]*\)\.sweepStaleClaims\(\)/);
  });

  it('sweeps after sign-in (needs the JWT + agent key) and before the kill switch, the browser and the flow', () => {
    // Where the sweep call sits.
    const sweep = at('.sweepStaleClaims()');
    // After sign-in: unauthenticated it would be refused.
    expect(at('signInWithPassword(')).toBeLessThan(sweep);
    // Before the kill switch (W31: cleanup is not new work).
    expect(sweep).toBeLessThan(at('isSystemEnabled()'));
    // Before a browser opens.
    expect(sweep).toBeLessThan(at('chromium.launch('));
    // Before the assisted flow loads, claims or parks any row.
    expect(sweep).toBeLessThan(at('runAssisted({'));
  });

  it('a failed sweep is logged and the human flow continues (the failure is already a failed sweeper run)', () => {
    // The sweep sits inside a try whose catch warns instead of rethrowing.
    expect(source).toMatch(/try \{\s*\/\/[^\n]*\n\s*await createSupabaseGateway\([^)]*\)\.sweepStaleClaims\(\);\s*\} catch \(error\) \{[\s\S]{0,400}?console\.warn\(/);
  });
});
