/* "✨ Run pipeline (all eligible rows)…" fires only after a typed confirmation (Teja's ruling,
 * 2026-10-09, via the orchestrator).
 *
 * The gate is a pure function (pipelineRunConfirm.ts) so it can be called here with a spy standing in
 * for the run: apps/web has no DOM renderer to click a button with. The modal-source tests below then
 * pin that EVERY place the modal can start a run goes through that gate, so the spy result is the
 * click result. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// The gate and the confirm text, imported directly: the module has no supabase or React import.
import { CONFIRM_PHRASE, GEMINI_WARNING, RUN_BATCH_LIMIT, canStartRun, confirmSummary, readWaitingCounts, startIfConfirmed } from '../src/features/discovery/pipelineRunConfirm.ts';

// The modal source, for the wiring checks; relative to apps/web, where node --test runs.
const modal = readFileSync('src/features/discovery/PipelineRunModal.tsx', 'utf8');
// The runner source, for the batch-limit parity check.
const runner = readFileSync('src/data/pipelineRunner.ts', 'utf8');

// A counting stand-in for the bulk run: how many times the gate let a run start.
const spy = () => {
  // Calls so far.
  let calls = 0;
  // The function the gate calls, and a reader for the count.
  return { start: () => { calls += 1; }, calls: () => calls };
};

describe('typed confirmation gate', () => {
  it('click with wrong text makes zero pipeline calls', () => {
    // Near misses included: case, a trailing space, a partial phrase, a different phrase.
    for (const typed of ['run al', 'Run all', 'run all ', ' run all', 'RUN ALL', 'yes', 'run']) {
      // A fresh spy per attempt, so one leak cannot hide behind another.
      const s = spy();
      // The click path.
      const started = startIfConfirmed(typed, true, s.start);
      // The gate reports it did not start...
      assert.equal(started, false, `"${typed}" must not start a run`);
      // ...and the run was never invoked.
      assert.equal(s.calls(), 0, `"${typed}" invoked the pipeline`);
    }
  });

  it('click with empty text makes zero pipeline calls', () => {
    // An untouched input is the most likely mis-click.
    const s = spy();
    // The click path with nothing typed.
    assert.equal(startIfConfirmed('', true, s.start), false);
    // Nothing ran.
    assert.equal(s.calls(), 0);
  });

  it('the matching text starts exactly one run', () => {
    // The phrase the modal asks for.
    const s = spy();
    // The click path with the exact phrase.
    assert.equal(startIfConfirmed(CONFIRM_PHRASE, true, s.start), true);
    // One run, not zero and not two.
    assert.equal(s.calls(), 1);
    // The phrase is the one Teja's ruling names.
    assert.equal(CONFIRM_PHRASE, 'run all');
    // The button's enabled state agrees with the gate.
    assert.equal(canStartRun(CONFIRM_PHRASE, true), true);
  });

  it('click before the counts load makes zero pipeline calls', () => {
    // The phrase is right, but the dialog has not yet said how many rows the run takes.
    const s = spy();
    // countsReady false: the confirm step is incomplete, so the run stays locked.
    assert.equal(startIfConfirmed(CONFIRM_PHRASE, false, s.start), false);
    // Nothing ran.
    assert.equal(s.calls(), 0);
    // The button agrees.
    assert.equal(canStartRun(CONFIRM_PHRASE, false), false);
  });
});

describe('what the confirm step states', () => {
  it('the per-agent cap mirrors the runner\'s BATCH_LIMIT', () => {
    // The runner does not export it, so its source is the authority; a drift here would misstate the run.
    const m = runner.match(/const BATCH_LIMIT = (\d+);/);
    // Fail loudly if the runner renamed it, rather than comparing against nothing.
    assert.ok(m, 'pipelineRunner.ts must still declare BATCH_LIMIT');
    // Same number.
    assert.equal(RUN_BATCH_LIMIT, Number(m[1]));
  });

  it('states the row cap and the waiting counts', () => {
    // Waiting counts per agent, one unreadable, as the modal passes them.
    const text = confirmSummary({ normalizer: 4, screener: 0, matcher: 1234, tailor: 2, auditor: null });
    // The cap the run actually applies, per agent and in total.
    assert.match(text, /at most 10 rows to each of the 5 agents \(50 row-steps in total\)/);
    // A waiting count is shown as a count, and the run's take as min(cap, waiting).
    assert.match(text, /Matcher: 1234 waiting at passed_filters, takes up to 10/);
    // A failed count is said, never guessed.
    assert.match(text, /Auditor: count unknown/);
  });

  it('the Gemini warning is truthful about the matcher pre-gate and is shown outside the counts', () => {
    // The matcher pre-gates without Gemini, so "every row" would overstate the spend.
    assert.match(GEMINI_WARNING, /may call Gemini/);
    // The pre-gate is named.
    assert.match(GEMINI_WARNING, /pre-gate/);
    // The combined ceiling.
    assert.match(GEMINI_WARNING, /up to 20 rows of Gemini calls/);
    // Rendered on its own, so it shows while the counts load or after they fail.
    assert.ok(modal.includes('{GEMINI_WARNING}'), 'the modal must render GEMINI_WARNING outside confirmSummary');
  });

  it('a failed or rejected count becomes null for that agent, never a hang or a rejection', async () => {
    // Matcher's count rejects (a network throw), auditor's returns null (a returned error).
    const counts = await readWaitingCounts(async (statuses) => {
      // Throw for the matcher's queue.
      if (statuses.includes('passed_filters')) throw new Error('network down');
      // Error-as-null for the auditor's queue.
      if (statuses.includes('tailored')) return null;
      // Every other queue has 3 rows.
      return 3;
    });
    // The rejection is contained to its agent.
    assert.equal(counts.matcher, null);
    // The returned error stays null.
    assert.equal(counts.auditor, null);
    // The others are real counts.
    assert.equal(counts.normalizer, 3);
  });
});

describe('PipelineRunModal wiring', () => {
  it('every run start goes through startIfConfirmed', () => {
    // Every call of the run function, as code.
    const calls = modal.match(/handleStart\(\)/g) ?? [];
    // Every gated call.
    const gated = modal.match(/startIfConfirmed\(typed, counts !== null, \(\) => void handleStart\(\)\)/g) ?? [];
    // There must be something to check (Run and Retry), or this passes vacuously.
    assert.ok(calls.length >= 2, 'the modal must still start runs from Run and Retry');
    // An ungated call is a bulk run that skips the confirmation.
    assert.equal(gated.length, calls.length, 'a handleStart() call bypasses the typed confirmation');
  });

  it('the run buttons stay disabled until the text matches and the counts have loaded', () => {
    // Both start buttons carry the same disabled rule.
    const disabled = modal.match(/disabled=\{running \|\| !canStartRun\(typed, counts !== null\)\}/g) ?? [];
    // Run and Retry.
    assert.equal(disabled.length, 2, 'Run and Retry must be disabled until the phrase matches');
  });

  it('a run start clears the typed phrase, so Retry needs it retyped, and re-reads the counts', () => {
    // handleStart's declaration.
    const start = modal.indexOf('const handleStart = async');
    // Fail loudly if renamed rather than slicing from -1.
    assert.ok(start !== -1, 'handleStart must still exist');
    // The part that runs before the bulk run is invoked.
    const head = modal.slice(start, modal.indexOf('await', start));
    // Cleared before the run: Retry is a second Gemini spend and must be confirmed again.
    assert.ok(head.includes("setTyped('');"), 'starting a run must clear the typed phrase');
    // After the run the queues have moved, so the shown counts are re-read.
    assert.match(modal.slice(start), /finally \{[\s\S]*?void loadCounts\(\);/, 'the counts must be re-read after a run');
  });

  it('Escape closes without running, and nothing uses window.prompt', () => {
    // Escape is wired to close (never to start).
    assert.match(modal, /e\.key === 'Escape' && !running\) onClose\(\)/, 'Escape must close the modal');
    // The in-modal input replaces any prompt().
    assert.equal(/\bprompt\(/.test(modal), false, 'use the in-modal input, not window.prompt');
  });

  it('never hard-codes a row count', () => {
    // Code only: block and line comments dropped, so a ruling's date in prose cannot trip the check.
    const code = modal.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // A four-digit number in the modal's code would be a count frozen at write time.
    assert.equal(/\b\d{4,}\b/.test(code), false, 'row counts come from HEAD queries, never literals');
  });
});
