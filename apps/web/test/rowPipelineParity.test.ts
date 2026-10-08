/* Parity: the browser engine (rowPipeline.ts) against the worker CLI it mirrors (run-one.ts).
 *
 * WHY: rowPipeline.ts is a hand-copy of worker/src/cli/run-one.ts, because run-one cannot be
 * bundled for the browser (node:url import, process.argv). A copy drifts the moment one side
 * changes, so this file imports the REAL run-one and pins the shared parts together: the step
 * list, each step's input status, the failure rule, the id shape, and — on scripted rows —
 * which functions get called and where the row ends up.
 *
 * Importing run-one is side-effect free: main() runs only when process.argv[1] IS run-one.ts
 * (run-one.ts:195), and under node --test argv[1] is this file. Its env reads live in main().
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The real worker module, by relative path, so this test breaks if it moves or changes.
import { STEPS, STEP_INPUT_STATUS as WORKER_INPUT, parseId, runPipeline } from '../../../worker/src/cli/run-one.ts';
import {
  PASSED_FILTERS_STEPS,
  STEP_INPUT_STATUS,
  bodyReportsFailure,
  isApplicationId,
  runRowPipeline,
} from '../src/features/pipeline/rowPipeline.ts';
import type { PipelineStep, StepEvent } from '../src/features/pipeline/rowPipeline.ts';

// A well-formed id; every scenario targets it.
const ID = '11111111-2222-4333-8444-555555555555';

// What one function does to the fake row: the HTTP answer plus the status it leaves behind.
type Effect = { ok: boolean; body: unknown; to?: string };
// A scripted world: per step, how the function reacts to the row's current status.
type Script = Partial<Record<PipelineStep, (status: string) => Effect>>;

// A clean 200 that moves the row, the common case.
const move = (to: string): Effect => ({ ok: true, body: { success: true, targeted: true, found: 1 }, to });
// The function's answer when the row is not at its input status: found:0, nothing moves.
const notFound: Effect = { ok: true, body: { success: true, targeted: true, found: 0 } };

// Runs BOTH engines on a fresh copy of the same scripted row and returns what each did.
async function runBoth(start: string, script: Script) {
  // One fake row per engine, so the second run does not inherit the first one's writes.
  const makeWorld = () => {
    // The row's status; only the scripted functions change it, as on the real database.
    let status = start;
    // Every function invoked, in order, so call sequences can be compared.
    const calls: string[] = [];
    // Applies a step's effect and returns its HTTP answer.
    const call = (step: string): Effect => {
      // Recorded before the effect so a throw would still show the attempt.
      calls.push(step);
      // An unscripted step behaves like the real function on a non-matching row.
      const effect = script[step as PipelineStep]?.(status) ?? notFound;
      // Only a scripted `to` writes the row, mirroring "functions advance status themselves".
      if (effect.to !== undefined) status = effect.to;
      // The engines see only the HTTP answer.
      return effect;
    };
    // Exposed as getters so each engine's adapter can close over the same row.
    return { calls, call, read: () => status };
  };
  // The worker's engine, with its own fake row.
  const w = makeWorld();
  // log is discarded: its text is not part of the contract.
  const worker = await runPipeline({
    // Same fake row for both deps, as the real CLI shares one client.
    callFunction: async (step) => w.call(step),
    // Reads the fake row, the stand-in for the applications table.
    readStatus: async () => w.read(),
    // Log text is not part of the contract.
    log: () => {},
  });
  // The browser engine, with an identical fresh row.
  const b = makeWorld();
  // Events collected so a test can assert per-step phases.
  const events: StepEvent[] = [];
  // Same scripted functions, adapted to the browser deps shape.
  const outcome = await runRowPipeline(
    {
      invoke: async (step) => {
        // httpStatus is not modelled by run-one; 200/500 is enough to be realistic.
        const e = b.call(step);
        return { ok: e.ok, httpStatus: e.ok ? 200 : 500, body: e.body };
      },
      // The browser engine reads the same kind of fake row.
      readStatus: async () => b.read(),
    },
    // The scripted row.
    ID,
    // The chain run-one has, so the comparison is like for like.
    PASSED_FILTERS_STEPS,
    (e) => events.push(e),
  );
  // Both sides, for comparison and for engine-specific assertions.
  return { worker, workerCalls: w.calls, outcome, calls: b.calls, events };
}

// finalStatus is absent on two outcome kinds; normalised so it compares with run-one's.
function finalOf(outcome: Awaited<ReturnType<typeof runRowPipeline>>): string | null | undefined {
  // invalid_id / status_unreadable carry no status at all.
  return 'finalStatus' in outcome ? outcome.finalStatus : undefined;
}

describe('rowPipeline parity with worker/src/cli/run-one.ts', () => {
  it('PASSED_FILTERS_STEPS equals run-one STEPS, in order', () => {
    // Order is the status graph; a reordering is a behaviour change, not a style one.
    assert.deepEqual([...PASSED_FILTERS_STEPS], [...STEPS]);
  });

  it('STEP_INPUT_STATUS agrees with run-one for every step run-one has', () => {
    // Iterating THEIR list means a step they add becomes a failure here, not a silent gap.
    for (const step of STEPS) {
      // Arrays compared whole: an extra or missing input status changes what gets skipped.
      assert.deepEqual([...STEP_INPUT_STATUS[step]], [...WORKER_INPUT[step]], step);
    }
  });

  it('bodyReportsFailure agrees with run-one on a table of bodies', async () => {
    // run-one does not export its bodyReportsFailure, so it is observed through runPipeline:
    // a body it judges a failure stops the matcher even though the row moved.
    const bodies: unknown[] = [
      { success: true }, // the plain success body
      { success: false }, // explicit failure flag
      { success: true, failures: [] }, // empty list is not a failure
      { success: true, failures: [{ applicationId: ID }] }, // per-row failure on a 200
      { failures: 'not-an-array' }, // wrong type must not count
      { success: 'false' }, // string, not boolean: strict equality
      null, // typeof null is object; must not crash
      'plain text error page', // non-JSON body
      42, // primitive body
      [], // array is an object with no fields
    ];
    // Each body run through both engines on a row the matcher moves to dropped_filter.
    for (const body of bodies) {
      // The row moves to dropped_filter, which no later step reads, so tailor/auditor are skipped
      // by both, so a stop can only come from the matcher's body.
      const theirs = await runPipeline({
        callFunction: async () => ({ ok: true, body }),
        readStatus: (() => {
          // Before the call the row is at passed_filters, after it at dropped_filter (no later input).
          let reads = 0;
          return async () => (reads++ === 0 ? 'passed_filters' : 'dropped_filter');
        })(),
        log: () => {},
      });
      // completed:false here can only mean their body check fired.
      assert.equal(bodyReportsFailure(body), !theirs.completed, JSON.stringify(body));
    }
  });

  it('isApplicationId agrees with run-one parseId on a table of ids', () => {
    // UUID_RE is private in run-one; parseId is its exported use of it.
    const ids: string[] = [
      ID, // canonical lower case
      ID.toUpperCase(), // the regex is case-insensitive
      '', // empty
      'not-a-uuid', // obvious garbage
      `${ID} `, // trailing space: anchored, so rejected
      ` ${ID}`, // leading space
      ID.slice(1), // one char short
      `${ID}0`, // one char long
      '11111111222243338444555555555555', // right hex, no hyphens
      'g1111111-2222-4333-8444-555555555555', // non-hex character
      `${ID}\n`, // trailing newline: $ without the m flag must still reject
    ];
    // Theirs throws on a bad id, so "accepted" is "did not throw".
    for (const id of ids) {
      // Wrapped in the argv shape parseId expects.
      let accepted = true;
      try {
        parseId(['--id', id]);
      } catch {
        // A throw is run-one's rejection.
        accepted = false;
      }
      // Same verdict for every id, including whitespace and case variants.
      assert.equal(isApplicationId(id), accepted, JSON.stringify(id));
    }
  });

  it('happy path: same calls, ends at awaiting_approval, classified ready_for_approval', async () => {
    // Each agent moves the row one hop; the auditor lands it at the human gate.
    const r = await runBoth('passed_filters', {
      matcher: (s) => (s === 'passed_filters' ? move('scored') : notFound),
      tailor: (s) => (s === 'scored' ? move('tailored') : notFound),
      auditor: (s) => (s === 'tailored' ? move('awaiting_approval') : notFound),
    });
    // Identical invocation order is the core parity claim.
    assert.deepEqual(r.calls, r.workerCalls);
    // Same database end state.
    assert.equal(finalOf(r.outcome), r.worker.finalStatus);
    // The only outcome that sends the operator to /approvals.
    assert.equal(r.outcome.kind, 'ready_for_approval');
  });

  it('a matcher drop is classified dropped at matcher, not success (run-one quirk not inherited)', async () => {
    // The matcher drops the row cleanly; run-one reports completed:true for this.
    const r = await runBoth('passed_filters', { matcher: () => move('dropped_filter') });
    // Neither engine invokes tailor/auditor on a dropped row.
    assert.deepEqual(r.calls, r.workerCalls);
    // Same end state as the worker.
    assert.equal(finalOf(r.outcome), r.worker.finalStatus);
    // The quirk: run-one calls this complete.
    assert.equal(r.worker.completed, true);
    // We classify by final status instead.
    assert.deepEqual(r.outcome, { kind: 'dropped', finalStatus: 'dropped_filter', atStep: 'matcher' });
  });

  it('resume from scored skips the matcher, as run-one does', async () => {
    // A row a previous run left at scored; the matcher would answer found:0 if called.
    const r = await runBoth('scored', {
      tailor: (s) => (s === 'scored' ? move('tailored') : notFound),
      auditor: (s) => (s === 'tailored' ? move('awaiting_approval') : notFound),
    });
    // Neither engine calls the matcher.
    assert.deepEqual(r.calls, ['tailor', 'auditor']);
    // Same as the worker.
    assert.deepEqual(r.calls, r.workerCalls);
    // The skip is reported as an event, not silent.
    assert.deepEqual(r.events[0], { step: 'matcher', phase: 'skipped' });
    // Resumed run still reaches the gate.
    assert.equal(r.outcome.kind, 'ready_for_approval');
  });

  it('tailor leaving the row at scored stops at tailor with no_progress, auditor not called', async () => {
    // liveness_unknown: a clean 200 that leaves the row where it was.
    const r = await runBoth('passed_filters', {
      matcher: (s) => (s === 'passed_filters' ? move('scored') : notFound),
      tailor: () => ({ ok: true, body: { success: true, skipped: [{ applicationId: ID, reason: 'liveness_unknown' }] } }),
    });
    // Both engines stop before the auditor.
    assert.deepEqual(r.calls, r.workerCalls);
    // Same end state.
    assert.equal(finalOf(r.outcome), r.worker.finalStatus);
    // The tailor step is reported stopped, not done, so the UI does not show a false tick.
    assert.deepEqual(r.events.at(-1), { step: 'tailor', phase: 'stopped', statusAfter: 'scored' });
    // Named reason and step.
    assert.deepEqual(r.outcome, { kind: 'stopped', atStep: 'tailor', reason: 'no_progress', finalStatus: 'scored' });
  });

  it('tailor failing the row with failures listed is classified failed (terminal overrides stop)', async () => {
    // tailor_validation_failed: the body lists the failure AND the row moves to failed.
    const r = await runBoth('scored', {
      tailor: () => ({ ok: true, body: { success: true, failures: [{ applicationId: ID }] }, to: 'failed' }),
    });
    // Both stop at tailor.
    assert.deepEqual(r.calls, r.workerCalls);
    // Both see failed.
    assert.equal(finalOf(r.outcome), r.worker.finalStatus);
    // The status is the truth, not the stop reason.
    assert.deepEqual(r.outcome, { kind: 'failed', finalStatus: 'failed', atStep: 'tailor' });
  });

  it('HTTP error stops with invoke_error and the re-read status', async () => {
    // A 409 no_master_profile: non-2xx, row untouched.
    const r = await runBoth('passed_filters', { matcher: () => ({ ok: false, body: { error: 'no_master_profile' } }) });
    // Both stop at the matcher.
    assert.deepEqual(r.calls, r.workerCalls);
    // Same end state.
    assert.equal(finalOf(r.outcome), r.worker.finalStatus);
    // Reason names the HTTP failure, not "no progress".
    assert.deepEqual(r.outcome, { kind: 'stopped', atStep: 'matcher', reason: 'invoke_error', finalStatus: 'passed_filters' });
  });
});
