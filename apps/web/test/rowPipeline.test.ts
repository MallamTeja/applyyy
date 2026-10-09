/* The per-row pipeline engine behind "Send through pipeline" (contract written 2026-10-08).
 *
 * The rules that matter most:
 *   - The browser only INVOKES deployed agents; each agent advances the row's status itself. The
 *     engine re-reads the status after every step and classifies the run by the FINAL STATUS.
 *   - It never claims success because "all steps ran". Prior art (run-one.ts) reported
 *     completed:true when the matcher DROPPED the row; the drop case below exists to stop that.
 *   - A terminal status read back after a step (dropped_*, failed, awaiting_approval) wins over a
 *     stop the body would otherwise cause: the row's real state is the truth, not the reply.
 *
 * Written from the CONTRACT, before and independently of the implementation. The deps are a
 * hand-built in-memory fake that moves a status per a per-step script and records every call in
 * order; no network. Assertions are on values and call logs, never on prose. */

import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

// The module under test; typed from its own exports so a contract drift is a type error too.
let rp: typeof import('../src/features/pipeline/rowPipeline.ts');

before(async () => {
  // Loaded lazily so a missing module fails as one clear load error, not a parse error here.
  rp = await import('../src/features/pipeline/rowPipeline.ts');
});

// Local aliases of the contract's types, so the fake below is checked against them.
type PipelineStep = import('../src/features/pipeline/rowPipeline.ts').PipelineStep;
// What the engine passes to onEvent.
type StepEvent = import('../src/features/pipeline/rowPipeline.ts').StepEvent;
// What one invoke resolves to.
type InvokeResult = import('../src/features/pipeline/rowPipeline.ts').InvokeResult;

// A real-shaped application id; every test uses it so "the SAME id" is checkable by equality.
const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

// What one scripted step does when invoked: where the status goes, and what the reply says.
interface StepScript {
  // The status the agent writes; absent means the agent leaves the row where it was.
  readonly to?: string;
  // false simulates an HTTP error / thrown invoke surfaced as a non-ok result.
  readonly ok?: boolean;
  // The reply body; defaults to a plain success so each test names only what it varies.
  readonly body?: unknown;
}

// Knobs for failures that are not about one step's reply.
interface FakeOptions {
  // The very first status read returns null (the row could not be read at all).
  readonly nullFromStart?: boolean;
  // Every read after this step has been invoked returns null (connection lost mid-run).
  readonly nullAfter?: PipelineStep;
}

// The in-memory deps: a single status cell, a per-step script, and logs of everything touched.
function makeFake(start: string, script: Partial<Record<PipelineStep, StepScript>>, opts: FakeOptions = {}) {
  // The row's status; only the fake's invoke changes it, which is the whole point of the contract.
  let status = start;
  // Every invoke, in order, with the id it was given, so order AND identity are assertable.
  const invokes: { step: PipelineStep; id: string }[] = [];
  // Every read's id, so the engine is shown to read the same row it invokes.
  const reads: string[] = [];
  // Every event the engine emits, in order.
  const events: StepEvent[] = [];
  // The last step invoked, which nullAfter keys on (robust to how many reads the engine makes).
  let lastInvoked: PipelineStep | null = null;
  // The deps object exactly as the contract shapes it.
  const deps = {
    // Moves the status per the script, then replies.
    async invoke(step: PipelineStep, applicationId: string): Promise<InvokeResult> {
      // Logged before anything else so even a crashing step shows up in the call log.
      invokes.push({ step, id: applicationId });
      // Remembered for nullAfter.
      lastInvoked = step;
      // An unscripted step is a legitimate "agent did nothing"; the log is what tests assert on.
      const s = script[step] ?? {};
      // The agent's own status write, the only status write in the whole system under test.
      if (s.to !== undefined) status = s.to;
      // ok defaults to true and the body to a plain success, so a test varies one thing at a time.
      const ok = s.ok ?? true;
      // A non-ok reply carries an HTTP error code, as a real failed invoke would.
      return { ok, httpStatus: ok ? 200 : 500, body: s.body ?? { success: true } };
    },
    // Reads the status cell, or null when a test injects an unreadable row.
    async readStatus(applicationId: string): Promise<string | null> {
      // Logged so the "zero calls" cases can prove the engine never touched the row.
      reads.push(applicationId);
      // Injected: the row cannot be read from the start.
      if (opts.nullFromStart) return null;
      // Injected: the row becomes unreadable once a given step has run.
      if (opts.nullAfter !== undefined && lastInvoked === opts.nullAfter) return null;
      // Normal case: the current status.
      return status;
    },
  };
  // onEvent pushes into the shared log; returned separately so tests can pass it explicitly.
  const onEvent = (e: StepEvent) => { events.push(e); };
  // Everything a test needs, in one bag.
  return { deps, onEvent, invokes, reads, events, steps: () => invokes.map((c) => c.step) };
}

// The script for an uneventful passed_filters run, reused by tests that change one step only.
const HAPPY: Partial<Record<PipelineStep, StepScript>> = {
  // The matcher scores the row.
  matcher: { to: 'scored' },
  // The tailor writes a tailored resume.
  tailor: { to: 'tailored' },
  // The auditor clears it for a human.
  auditor: { to: 'awaiting_approval' },
};

describe('step-list constants', () => {
  // The step lists ARE the pipeline's shape; a reorder here would silently reorder real agents.
  it('PASSED_FILTERS_STEPS and DISCOVERED_STEPS are the documented sequences', () => {
    // The button on a passed_filters row runs exactly these three agents in this order.
    assert.deepEqual([...rp.PASSED_FILTERS_STEPS], ['matcher', 'tailor', 'auditor']);
    // A discovered row needs the normalizer and screener first.
    assert.deepEqual([...rp.DISCOVERED_STEPS], ['normalizer', 'screener', 'matcher', 'tailor', 'auditor']);
  });

  // The input map decides skip-vs-run; it mirrors the status transition graph's agent edges.
  it('STEP_INPUT_STATUS names each step\'s legal input statuses', () => {
    // Compared as plain arrays so a readonly/frozen implementation still matches.
    const plain = Object.fromEntries(Object.entries(rp.STEP_INPUT_STATUS).map(([k, v]) => [k, [...v]]));
    // The exact map from the contract; the auditor accepts its own outputs so it can be re-run.
    assert.deepEqual(plain, {
      // Normalizer only takes freshly discovered rows.
      normalizer: ['discovered'],
      // Screener only takes deduped rows.
      screener: ['deduped'],
      // Matcher only takes screened rows.
      matcher: ['passed_filters'],
      // Tailor only takes scored rows.
      tailor: ['scored'],
      // Auditor takes tailored rows and re-audits its own verdicts.
      auditor: ['tailored', 'audit_clean', 'audit_flagged'],
    });
  });
});

describe('isApplicationId', () => {
  // Valid inputs: canonical 8-4-4-4-12 hex, any case.
  const valid = [
    // Lowercase, the form Postgres returns.
    ID,
    // Uppercase must pass: the contract says case-insensitive.
    ID.toUpperCase(),
    // Mixed case, same reason.
    '12345678-ABcd-1234-abCD-123456789abc',
  ];
  // Invalid inputs: anything that is not exactly that shape, including non-strings.
  const invalid: unknown[] = [
    // Empty string must not reach a query.
    '',
    // Arbitrary text.
    'abc',
    // A valid uuid with a trailing extra char: proves the match is anchored at the end.
    `${ID}x`,
    // A leading space: proves the match is anchored at the start.
    ` ${ID}`,
    // Braced form is a uuid to some parsers but not canonical.
    `{${ID}}`,
    // Hyphenless 32-hex form is not canonical either.
    ID.replaceAll('-', ''),
    // Right length, non-hex char.
    '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6g',
    // Wrong grouping (last group 11 chars).
    '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6',
    // A number must not be coerced.
    123,
    // null must not be coerced to "null".
    null,
    // undefined, the shape of a missing route param.
    undefined,
    // An object, the shape of a mistaken whole-row pass.
    { id: ID },
  ];
  // Each valid id gets its own assertion message so a failure names the input.
  it('accepts canonical uuids in any case', () => {
    // One loop, one message per input.
    for (const v of valid) assert.equal(rp.isApplicationId(v), true, `expected valid: ${v}`);
  });
  // Each invalid input likewise.
  it('rejects everything that is not a canonical uuid string', () => {
    // String(v) keeps the message readable for non-strings.
    for (const v of invalid) assert.equal(rp.isApplicationId(v), false, `expected invalid: ${String(v)}`);
  });
});

describe('bodyReportsFailure', () => {
  // [body, expected]: success===false OR a non-empty failures array, nothing else.
  const table: [unknown, boolean][] = [
    // Explicit failure flag.
    [{ success: false }, true],
    // A non-empty failures array, even without a flag.
    [{ failures: [{ id: ID, reason: 'x' }] }, true],
    // failures wins even when success claims true: the per-row report is the more specific one.
    [{ success: true, failures: ['x'] }, true],
    // An empty failures array is a clean batch.
    [{ failures: [] }, false],
    // Plain success.
    [{ success: true }, false],
    // An empty object reports nothing.
    [{}, false],
    // A string 'false' is not the boolean: the contract says ===false.
    [{ success: 'false' }, false],
    // 0 is falsy but not false.
    [{ success: 0 }, false],
    // failures that is not an array is not a failure list.
    [{ failures: 'boom' }, false],
    // Non-object bodies report nothing and must not throw.
    [null, false],
    // Same for undefined (an empty reply).
    [undefined, false],
    // Same for a text body.
    ['error', false],
    // A bare array body is not {failures: [...]}.
    [['x'], false],
  ];
  // The whole table in one test, each row named on failure.
  it('is true only for success===false or a non-empty failures array', () => {
    // JSON.stringify names the row; undefined prints as undefined via String fallback.
    for (const [body, want] of table) assert.equal(rp.bodyReportsFailure(body), want, `body: ${JSON.stringify(body) ?? String(body)}`);
  });
});

describe('runRowPipeline: classification by final status', () => {
  // The headline case: three real agents, the row lands where a human can approve it.
  it('passed_filters through matcher, tailor, auditor is ready_for_approval', async () => {
    // Default happy script.
    const f = makeFake('passed_filters', HAPPY);
    // Run the passed_filters step list.
    const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
    // Classified from the final status, not from "steps ran".
    assert.deepEqual(out, { kind: 'ready_for_approval', finalStatus: 'awaiting_approval' });
    // Exact order, and every invoke names the same row.
    assert.deepEqual(f.invokes, [{ step: 'matcher', id: ID }, { step: 'tailor', id: ID }, { step: 'auditor', id: ID }]);
    // Every read is for the same row too.
    assert.ok(f.reads.length > 0 && f.reads.every((r) => r === ID));
    // The event stream a progress UI renders: running then done(statusAfter), per step.
    assert.deepEqual(f.events, [
      // Matcher starts.
      { step: 'matcher', phase: 'running' },
      // Matcher result read back from the row.
      { step: 'matcher', phase: 'done', statusAfter: 'scored' },
      // Tailor starts.
      { step: 'tailor', phase: 'running' },
      // Tailor result.
      { step: 'tailor', phase: 'done', statusAfter: 'tailored' },
      // Auditor starts.
      { step: 'auditor', phase: 'running' },
      // Auditor result.
      { step: 'auditor', phase: 'done', statusAfter: 'awaiting_approval' },
    ]);
  });

  // The run-one.ts quirk: a drop is NOT completion. Later agents must never see a dropped row.
  it('a matcher drop is dropped at matcher, never ready, and tailor/auditor are never invoked', async () => {
    // The matcher drops the row on its score.
    const f = makeFake('passed_filters', { ...HAPPY, matcher: { to: 'dropped_filter' } });
    // Run.
    const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
    // Dropped, attributed to the step that produced it.
    assert.deepEqual(out, { kind: 'dropped', finalStatus: 'dropped_filter', atStep: 'matcher' });
    // Only the matcher ran.
    assert.deepEqual(f.steps(), ['matcher']);
    // No later step ever entered running (skipped events, or none, are both fine by the contract).
    assert.ok(!f.events.some((e) => e.phase === 'running' && e.step !== 'matcher'));
  });

  // A refusing tailor writes failed; the auditor has nothing to audit.
  it('a tailor refusal is failed at tailor, and the auditor is not invoked', async () => {
    // Tailor moves the row to failed.
    const f = makeFake('passed_filters', { ...HAPPY, tailor: { to: 'failed' } });
    // Run.
    const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
    // failed, attributed to the tailor.
    assert.deepEqual(out, { kind: 'failed', finalStatus: 'failed', atStep: 'tailor' });
    // Auditor absent from the call log.
    assert.deepEqual(f.steps(), ['matcher', 'tailor']);
  });

  // liveness_unknown: tailor answers fine but leaves the row at scored. That is no progress, not success.
  it('a tailor that leaves the row at scored is stopped/no_progress at tailor', async () => {
    // Success-shaped body, no status move.
    const f = makeFake('passed_filters', { ...HAPPY, tailor: { body: { success: true, outcome: 'liveness_unknown' } } });
    // Run.
    const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
    // Stopped where it stalled, with the status it stalled at.
    assert.deepEqual(out, { kind: 'stopped', atStep: 'tailor', reason: 'no_progress', finalStatus: 'scored' });
    // The auditor must not run on a row that is still scored.
    assert.deepEqual(f.steps(), ['matcher', 'tailor']);
    // And the tailor is never reported done.
    assert.ok(!f.events.some((e) => e.step === 'tailor' && e.phase === 'done'));
  });

  // Steps all ran and moved the row, but it did not reach a classified status: still not success.
  it('a run that ends on a non-terminal status is stopped/no_progress at the last invoked step', async () => {
    // Auditor yields audit_clean, which is not awaiting_approval.
    const f = makeFake('tailored', { auditor: { to: 'audit_clean' } });
    // Run the standard list from tailored.
    const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
    // "Anything else after invoking" clause.
    assert.deepEqual(out, { kind: 'stopped', atStep: 'auditor', reason: 'no_progress', finalStatus: 'audit_clean' });
  });
});

describe('runRowPipeline: resume and not-startable', () => {
  // Resume support: a row already scored skips the matcher instead of re-scoring it.
  it('resumes from scored: matcher skipped, tailor and auditor run', async () => {
    // Matcher scripted to a status it must never reach, so a wrongful run would show.
    const f = makeFake('scored', { ...HAPPY, matcher: { to: 'dropped_filter' } });
    // Run.
    const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
    // Ends ready.
    assert.deepEqual(out, { kind: 'ready_for_approval', finalStatus: 'awaiting_approval' });
    // Matcher never invoked.
    assert.deepEqual(f.steps(), ['tailor', 'auditor']);
    // Full event stream, including the skip.
    assert.deepEqual(f.events, [
      // The skip is surfaced so the UI can grey the step.
      { step: 'matcher', phase: 'skipped' },
      // Tailor starts.
      { step: 'tailor', phase: 'running' },
      // Tailor result.
      { step: 'tailor', phase: 'done', statusAfter: 'tailored' },
      // Auditor starts.
      { step: 'auditor', phase: 'running' },
      // Auditor result.
      { step: 'auditor', phase: 'done', statusAfter: 'awaiting_approval' },
    ]);
  });

  // A flagged row is re-auditable; only the auditor applies.
  it('resumes from audit_flagged: only the auditor runs and the row is ready', async () => {
    // Auditor clears the flagged row.
    const f = makeFake('audit_flagged', { auditor: { to: 'awaiting_approval' } });
    // Run.
    const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
    // Ready.
    assert.deepEqual(out, { kind: 'ready_for_approval', finalStatus: 'awaiting_approval' });
    // Auditor only.
    assert.deepEqual(f.steps(), ['auditor']);
    // Two skips, then the auditor.
    assert.deepEqual(f.events, [
      // Matcher does not apply.
      { step: 'matcher', phase: 'skipped' },
      // Tailor does not apply.
      { step: 'tailor', phase: 'skipped' },
      // Auditor starts.
      { step: 'auditor', phase: 'running' },
      // Auditor result.
      { step: 'auditor', phase: 'done', statusAfter: 'awaiting_approval' },
    ]);
  });

  // A status no step accepts: nothing to do, and the engine must say so rather than "success".
  /* discovered: the passed_filters list must not touch a discovered row. awaiting_approval,
     dropped_filter, failed (peer 1's ruling, 2026-10-08): a row ALREADY final when the click
     happens is not_startable, never "ready"/"dropped at matcher"/"failed at tailor" - those would
     credit this click with what an earlier run did, and dropped/failed have no honest atStep. */
  for (const start of ['approved', 'discovered', 'awaiting_approval', 'dropped_filter', 'failed']) {
    it(`a row at ${start} with PASSED_FILTERS_STEPS is not_startable with zero invokes`, async () => {
      // Scripts that would move the row, so any wrongful invoke shows in the outcome too.
      const f = makeFake(start, HAPPY);
      // Run.
      const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
      // Reported with the status that blocked it.
      assert.deepEqual(out, { kind: 'not_startable', finalStatus: start });
      // No agent ran.
      assert.deepEqual(f.invokes, []);
    });
  }
});

describe('runRowPipeline: guards before any work', () => {
  // A bad id must never reach an agent or a query.
  for (const bad of ['', 'abc', `${ID}x`, 123, null] as unknown[]) {
    // One test per input so a failure names it.
    it(`invalid id ${JSON.stringify(bad)} is invalid_id with zero deps calls`, async () => {
      // A fake whose every call is logged.
      const f = makeFake('passed_filters', HAPPY);
      // Cast: the point is a caller passing garbage past the type system.
      const out = await rp.runRowPipeline(f.deps, bad as string, rp.PASSED_FILTERS_STEPS, f.onEvent);
      // Refused up front.
      assert.deepEqual(out, { kind: 'invalid_id' });
      // No invoke.
      assert.deepEqual(f.invokes, []);
      // No read either: "ZERO deps calls".
      assert.deepEqual(f.reads, []);
    });
  }

  // Not knowing where the row is means not knowing which agent applies: do nothing.
  it('an unreadable first status is status_unreadable with zero invokes', async () => {
    // First read null.
    const f = makeFake('passed_filters', HAPPY, { nullFromStart: true });
    // Run.
    const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
    // Reported as such.
    assert.deepEqual(out, { kind: 'status_unreadable' });
    // Nothing invoked.
    assert.deepEqual(f.invokes, []);
  });
});

describe('runRowPipeline: stops', () => {
  // A transport/HTTP failure stops the run; continuing would run the next agent on a stale status.
  it('a non-ok invoke is stopped/invoke_error and no later step runs', async () => {
    // Matcher call fails without moving the row.
    const f = makeFake('passed_filters', { ...HAPPY, matcher: { ok: false, body: { error: 'x' } } });
    // Run.
    const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
    // Stopped at the matcher with the re-read status.
    assert.deepEqual(out, { kind: 'stopped', atStep: 'matcher', reason: 'invoke_error', finalStatus: 'passed_filters' });
    // Only the matcher was invoked.
    assert.deepEqual(f.steps(), ['matcher']);
    // The stopped event carries the best-effort re-read.
    assert.deepEqual(f.events.at(-1), { step: 'matcher', phase: 'stopped', statusAfter: 'passed_filters' });
  });

  // The agent's kill switch is off: halt, do not treat it as a failure or as progress.
  it('a skipped_disabled body is stopped/halted', async () => {
    // Agent disabled, row untouched.
    const f = makeFake('passed_filters', { ...HAPPY, matcher: { body: { status: 'skipped_disabled' } } });
    // Run.
    const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
    // Halted at the matcher.
    assert.deepEqual(out, { kind: 'stopped', atStep: 'matcher', reason: 'halted', finalStatus: 'passed_filters' });
    // Nothing after it.
    assert.deepEqual(f.steps(), ['matcher']);
    // The stopped event was emitted with the re-read.
    assert.deepEqual(f.events.at(-1), { step: 'matcher', phase: 'stopped', statusAfter: 'passed_filters' });
  });

  // The screener spells its kill switch differently (screener/index.ts:131); without this it read
  // as no_progress ("did not move"), which hides that the whole pipeline is switched off.
  it('a screener halted_by_kill_switch body is stopped/halted', async () => {
    // Discovered lane: the normalizer dedupes, then the screener answers with its own spelling.
    const f = makeFake('discovered', { normalizer: { to: 'deduped' }, screener: { body: { status: 'halted_by_kill_switch', message: 'off', processed: 0 } } });
    // Run the full discovered chain.
    const out = await rp.runRowPipeline(f.deps, ID, rp.DISCOVERED_STEPS, f.onEvent);
    // Halted at the screener, with the row where the normalizer left it.
    assert.deepEqual(out, { kind: 'stopped', atStep: 'screener', reason: 'halted', finalStatus: 'deduped' });
    // Nothing after the screener ran.
    assert.deepEqual(f.steps(), ['normalizer', 'screener']);
  });

  // A batch reply naming this row as failed, with the row not terminal: stop on the body.
  for (const body of [{ failures: [{ id: ID, reason: 'gemini 503' }] }, { success: false }]) {
    // Both triggers of bodyReportsFailure.
    it(`a failure body ${JSON.stringify(body)} with no terminal status is stopped/body_failure`, async () => {
      // Tailor reports failure, row stays scored.
      const f = makeFake('passed_filters', { ...HAPPY, tailor: { body } });
      // Run.
      const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
      // Stopped on the body at the tailor.
      assert.deepEqual(out, { kind: 'stopped', atStep: 'tailor', reason: 'body_failure', finalStatus: 'scored' });
      // Auditor never ran.
      assert.deepEqual(f.steps(), ['matcher', 'tailor']);
      // Stopped event with the re-read.
      assert.deepEqual(f.events.at(-1), { step: 'tailor', phase: 'stopped', statusAfter: 'scored' });
    });
  }

  // TERMINAL OVERRIDES STOP: the row's real state beats the reply's complaint.
  it('a failure body whose re-read shows dropped_filter is dropped, not stopped', async () => {
    // Matcher reports a failure AND drops the row.
    const f = makeFake('passed_filters', { ...HAPPY, matcher: { to: 'dropped_filter', body: { failures: ['x'] } } });
    // Run.
    const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
    // Classified by status.
    assert.deepEqual(out, { kind: 'dropped', finalStatus: 'dropped_filter', atStep: 'matcher' });
    // Nothing ran after the drop.
    assert.deepEqual(f.steps(), ['matcher']);
  });

  // Same override for a non-ok reply: a function that wrote failed then errored is still failed.
  it('a non-ok invoke whose re-read shows failed is failed, not stopped', async () => {
    // Tailor errors after writing failed.
    const f = makeFake('passed_filters', { ...HAPPY, tailor: { ok: false, to: 'failed' } });
    // Run.
    const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
    // Terminal wins.
    assert.deepEqual(out, { kind: 'failed', finalStatus: 'failed', atStep: 'tailor' });
  });

  // Losing the row mid-run: the engine cannot know what the next agent should be, so it stops.
  it('a null re-read mid-run is stopped/status_unreadable at that step', async () => {
    // Reads after the matcher return null.
    const f = makeFake('passed_filters', HAPPY, { nullAfter: 'matcher' });
    // Run.
    const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
    // Stopped at the matcher, final status unknown (null is what the read gave).
    assert.deepEqual(out, { kind: 'stopped', atStep: 'matcher', reason: 'status_unreadable', finalStatus: null });
    // Tailor never ran on an unknown status.
    assert.deepEqual(f.steps(), ['matcher']);
  });
});

describe('runRowPipeline: discovered rows (the step list is data)', () => {
  // The same engine, a longer list: proves no step is hard-coded.
  it('DISCOVERED_STEPS from discovered walks all five agents to ready_for_approval', async () => {
    // Each agent advances one hop.
    const f = makeFake('discovered', {
      // Dedupe.
      normalizer: { to: 'deduped' },
      // Screen.
      screener: { to: 'passed_filters' },
      // Then the usual three.
      ...HAPPY,
    });
    // Run the discovered list.
    const out = await rp.runRowPipeline(f.deps, ID, rp.DISCOVERED_STEPS, f.onEvent);
    // Ready.
    assert.deepEqual(out, { kind: 'ready_for_approval', finalStatus: 'awaiting_approval' });
    // All five in order.
    assert.deepEqual(f.steps(), ['normalizer', 'screener', 'matcher', 'tailor', 'auditor']);
    // Each step done with the status it produced, in order.
    assert.deepEqual(
      // Only the done events, mapped to [step, statusAfter].
      f.events.filter((e) => e.phase === 'done').map((e) => [e.step, (e as { statusAfter: string }).statusAfter]),
      // The expected chain.
      [['normalizer', 'deduped'], ['screener', 'passed_filters'], ['matcher', 'scored'], ['tailor', 'tailored'], ['auditor', 'awaiting_approval']],
    );
  });

  // The other drop status, attributed to the first agent.
  it('a normalizer duplicate is dropped/dropped_duplicate at normalizer', async () => {
    // Normalizer finds a duplicate.
    const f = makeFake('discovered', { normalizer: { to: 'dropped_duplicate' }, screener: { to: 'passed_filters' }, ...HAPPY });
    // Run.
    const out = await rp.runRowPipeline(f.deps, ID, rp.DISCOVERED_STEPS, f.onEvent);
    // Dropped there.
    assert.deepEqual(out, { kind: 'dropped', finalStatus: 'dropped_duplicate', atStep: 'normalizer' });
    // Nothing after it.
    assert.deepEqual(f.steps(), ['normalizer']);
  });

  // The screener is the real filter for this lane; its drop must end the run before any Gemini spend.
  it('a screener drop is dropped/dropped_filter at screener, and matcher/tailor/auditor never run', async () => {
    // Normalizer passes, screener drops; HAPPY scripts the rest so a wrongful invoke would show.
    const f = makeFake('discovered', { normalizer: { to: 'deduped' }, screener: { to: 'dropped_filter' }, ...HAPPY });
    // Run.
    const out = await rp.runRowPipeline(f.deps, ID, rp.DISCOVERED_STEPS, f.onEvent);
    // Attributed to the screener, not to a matcher that never ran.
    assert.deepEqual(out, { kind: 'dropped', finalStatus: 'dropped_filter', atStep: 'screener' });
    // Only the first two agents were called.
    assert.deepEqual(f.steps(), ['normalizer', 'screener']);
  });
});

describe('runRowPipeline: no I/O beyond deps', () => {
  // The engine is pure orchestration; any other access means a hidden dependency.
  it('touches only deps.invoke and deps.readStatus, and never fetch', async () => {
    // A normal happy run underneath.
    const f = makeFake('passed_filters', HAPPY);
    // Every property name the engine reads off deps.
    const touched: (string | symbol)[] = [];
    // Frozen so a write throws; proxied so an unknown read throws.
    const guarded = new Proxy(Object.freeze({ ...f.deps }), {
      // Allow the two contract methods only.
      get(target, prop, receiver) {
        // Logged before deciding, so the error case still shows what was asked for.
        touched.push(prop);
        // The contract's two methods.
        if (prop === 'invoke' || prop === 'readStatus') return Reflect.get(target, prop, receiver);
        // Anything else is a contract violation.
        throw new Error(`engine read unknown deps property: ${String(prop)}`);
      },
    });
    // Saved so the stub below is always undone.
    const realFetch = globalThis.fetch;
    // Any direct network call fails the run loudly.
    globalThis.fetch = (() => { throw new Error('engine called fetch'); }) as typeof fetch;
    // try/finally: a failing engine must not leave fetch stubbed for other test files.
    try {
      // Run through the guarded deps.
      const out = await rp.runRowPipeline(guarded, ID, rp.PASSED_FILTERS_STEPS, f.onEvent);
      // The run still worked through the proxy.
      assert.deepEqual(out, { kind: 'ready_for_approval', finalStatus: 'awaiting_approval' });
    } finally {
      // Restore.
      globalThis.fetch = realFetch;
    }
    // Only the two names were ever read.
    assert.ok(touched.every((p) => p === 'invoke' || p === 'readStatus'), `touched: ${touched.map(String).join(',')}`);
    // And the work actually went through them.
    assert.deepEqual(f.steps(), ['matcher', 'tailor', 'auditor']);
  });

  // onEvent is optional per the signature; omitting it must not change the outcome.
  it('runs without an onEvent callback', async () => {
    // Happy fake.
    const f = makeFake('passed_filters', HAPPY);
    // No fourth argument.
    const out = await rp.runRowPipeline(f.deps, ID, rp.PASSED_FILTERS_STEPS);
    // Same outcome as with events.
    assert.deepEqual(out, { kind: 'ready_for_approval', finalStatus: 'awaiting_approval' });
  });
});
