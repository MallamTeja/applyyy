/* S9g + S9d (Teja's live chat, 2026-11-21).
 * S9g, his ruling at 15:11: "if i say once add it need to add without need of my click or confirmation even though it is
 * not there in my resume". A skill new to the master that HIS message names auto-applies (master + resume in one go);
 * one the AI invented still waits, because only dictated or master-backed content may land unasked.
 * S9d: "rm vector search" got the right op but never saved: the attest run stopped at its first failure, a stale-row
 * refusal ("Changed elsewhere; reloaded."), though the page had already adopted the newer row. One retry now.
 * Harness: support/registerTsxHooks.ts, like the other approval suites. */
// The .tsx loader; must be the first import.
import './support/registerTsxHooks.ts';
// Strict comparisons.
import assert from 'node:assert/strict';
// The runner.
import { before, describe, it } from 'node:test';

// The module under test, loaded after the hooks.
let ai: typeof import('../src/features/approval/aiEdit.ts');
// Loaded once.
before(async () => {
  // Through the hooks, so its extensionless imports resolve like Vite's.
  ai = await import('../src/features/approval/aiEdit.ts');
});

// An add_skill card for a skill the master lacks.
const fresh = (name: string) => ({ op: 'add_skill', name, category: 'Tools', inMaster: false }) as const;

describe('S9g: a new-to-master skill Teja names applies with no click', () => {
  it('"add schema design too" applies Schema design; a skill his message does not name still waits', () => {
    // His live message (15:22): named, so it lands.
    assert.equal(ai.shouldAutoApply(fresh('Schema design'), 'add schema design too'), true);
    // Named with a typo on a long name, as the shared matcher forgives.
    assert.equal(ai.shouldAutoApply(fresh('Kubernetes'), 'add kubernets'), true);
    // Not in his message: an AI pick, so his click.
    assert.equal(ai.shouldAutoApply(fresh('Terraform'), 'add more tools'), false);
  });
});

describe('S9d: a stale-row refusal is retried once', () => {
  it('an attest refused as "Changed elsewhere; reloaded." is saved on the retry', async () => {
    // Calls to the attest save.
    let calls = 0;
    // First call stale, second fine (the page adopted the newer row in between).
    const run = await ai.runApplyBatch(['attest'], () => true, (item) => item, async () => ({ ok: true }) as never, async () => (++calls === 1 ? { ok: false, reason: 'Changed elsewhere; reloaded.' } : { ok: true }) as never);
    // Saved, after exactly one retry.
    assert.deepEqual([run.kind, calls], ['all_saved', 2]);
  });

  it('any other refusal is not retried, and a second stale refusal stops the run', async () => {
    // Calls to the attest save.
    let calls = 0;
    // Always refused for a real reason.
    const real = await ai.runApplyBatch(['attest'], () => true, (item) => item, async () => ({ ok: true }) as never, async () => { calls += 1; return { ok: false, reason: 'one page' } as never; });
    // One call, no retry.
    assert.deepEqual([real.kind, calls], ['none_saved', 1]);
    // Stale twice: one retry, then the run stops.
    let stale = 0;
    // The save that never sees a fresh row.
    const twice = await ai.runApplyBatch(['attest'], () => true, (item) => item, async () => ({ ok: true }) as never, async () => { stale += 1; return { ok: false, reason: 'Changed elsewhere; reloaded.' } as never; });
    // Two calls, then reported.
    assert.deepEqual([twice.kind, stale], ['none_saved', 2]);
  });

  it('the batch save of resume-only edits is retried once on a stale row too', async () => {
    // Calls to the batch save.
    let calls = 0;
    // First stale, then saved.
    const run = await ai.runApplyBatch(['pure'], () => false, (item) => item, async () => (++calls === 1 ? { ok: false, reason: 'Changed elsewhere; reloaded.' } : { ok: true }) as never, async () => ({ ok: true }) as never);
    // Saved on the retry.
    assert.deepEqual([run.kind, calls], ['all_saved', 2]);
  });
});
