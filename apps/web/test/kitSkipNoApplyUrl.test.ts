/* W29 residual (peer 4's audit recheck, 2026-11-09): the kit worker now writes an apply_kit_skipped note with code
 * `no_apply_url` when a job has no form URL, instead of failing the daily sweep. The web reads skip codes from a
 * CLOSED list, so a code it does not know shows the card as "unreadable". This pins that the web knows the new
 * code (it must deploy BEFORE the worker writes it) and that the Manual lane names it as a reason. */
// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

// The skip-note parser under test.
let kit: typeof import('../src/features/manual-apply/applyKit.ts');
// The "why the bot can't apply" reasons under test.
let cant: typeof import('../src/features/manual-apply/botCantApply.ts');

before(async () => {
  // Loaded after the hooks register, like the sibling manual-apply tests.
  kit = await import('../src/features/manual-apply/applyKit.ts');
  // Same.
  cant = await import('../src/features/manual-apply/botCantApply.ts');
});

describe('no_apply_url kit skip', () => {
  it('parses as a known skip, not "unreadable"', () => {
    // The exact note worker/src/cli/apply-kit.ts writes: { kind, code, reason }.
    const parsed = kit.parseKitSkip({ kind: 'apply_kit_skipped', code: 'no_apply_url', reason: 'apply kit: no_apply_url: x' });
    // Known, with its code.
    assert.deepEqual(parsed, { ok: true, code: 'no_apply_url', reason: 'apply kit: no_apply_url: x' });
  });

  it('is a reason the bot cannot apply, shown in the Manual lane', () => {
    // An approved row (not parked) whose kit was skipped for a missing form link.
    const reasons = cant.botCantApplyReasons({ status: 'approved', blockReason: null, applyUrl: '', atsProvider: 'greenhouse' } as never, { kind: 'skipped', code: 'no_apply_url', reason: '' } as never);
    // Named once.
    assert.deepEqual(reasons, ['the job has no form link']);
  });
});
