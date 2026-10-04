/* Pipeline runner classification.
 *
 * WHY: the runner used to mark every HTTP 200 "succeeded" and return `ok: true`
 * unconditionally, so a run where every agent failed — or the kill switch halted the
 * Screener — told the operator to go check the Approval Queue. These cases pin the
 * honest reading of each response, and that a halt stops the steps after it.
 *
 * The client is a stub implementing only `functions.invoke`, so no env or network is needed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyResponse, runPipeline } from '../src/data/pipelineRunner.ts';
import type { FunctionsInvoker } from '../src/data/pipelineRunner.ts';

// Builds a stub client that answers per agent and records every name it was invoked with.
function stubClient(answer: (agent: string) => { data: unknown; error: unknown }): { client: FunctionsInvoker; calls: string[] } {
  // Collected so tests can assert which agents ran, and with which query string.
  const calls: string[] = [];
  // Only the slice the runner touches.
  const client: FunctionsInvoker = {
    functions: {
      // Strip the query so `answer` keys on the bare agent name.
      invoke: async (name: string) => {
        calls.push(name);
        return answer(name.split('?')[0] ?? name);
      },
    },
  };
  return { client, calls };
}

describe('runPipeline', () => {
  it('returns ok:false and "0 row(s) advanced" when every step fails', async () => {
    // Every agent answers with a transport-level error, as functions-js does for non-2xx.
    const { client } = stubClient(() => ({ data: null, error: new Error('Edge Function returned a non-2xx status code') }));
    const result = await runPipeline(client);
    // The bug: this was hard-coded true.
    assert.equal(result.ok, false);
    // All five recorded as failed, none silently dropped.
    assert.deepEqual(result.steps.map((s) => s.status), ['failed', 'failed', 'failed', 'failed', 'failed']);
    // Summary leads with what actually moved.
    assert.match(result.summary, /^Pipeline run did not complete\. 0 row\(s\) advanced/);
  });

  it('stops after a kill-switch halt and never invokes later agents', async () => {
    // Normalizer fine, Screener halted with the exact 200 body screener/index.ts returns.
    const { client, calls } = stubClient((agent) =>
      agent === 'screener'
        ? { data: { status: 'halted_by_kill_switch', processed: 0 }, error: null }
        : { data: { success: true, processed: 2, deduped: 2, dropped_duplicate: 0, errors: 0 }, error: null },
    );
    const result = await runPipeline(client);
    // Matcher, Tailor and Auditor must not run once the operator switched the system off.
    assert.deepEqual(calls, ['normalizer?limit=10', 'screener?limit=10']);
    // Halt is not ok.
    assert.equal(result.ok, false);
    // Later steps are recorded as not run, not omitted.
    assert.deepEqual(result.steps.map((s) => s.status), ['succeeded', 'halted', 'not_run', 'not_run', 'not_run']);
  });

  it('stops after a 401 and surfaces the function body instead of "non-2xx"', async () => {
    // Shape of FunctionsHttpError: the raw Response sits in `context`.
    const authError = Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      context: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    });
    const { client, calls } = stubClient(() => ({ data: null, error: authError }));
    const result = await runPipeline(client);
    // Same token for every agent, so one refusal is enough.
    assert.deepEqual(calls, ['normalizer?limit=10']);
    // The function's own error code reaches the operator.
    assert.match(result.steps[0]?.message ?? '', /\(401\).*unauthorized/);
  });

  it('is ok when every agent answers its real success shape', async () => {
    // Each body mirrors the final jsonResponse(200, …) of that agent's index.ts.
    const bodies: Record<string, unknown> = {
      normalizer: { success: true, processed: 1, deduped: 1, dropped_duplicate: 0, errors: 0 },
      screener: { success: true, processed: 1, passed: 1, dropped: 0, failed: 0 },
      matcher: { success: true, rows_in: 1, scored: 1, failures: [] },
      tailor: { success: true, tailored: 1, refused: 0, skipped: [], failures: [] },
      auditor: { success: true, audited: 1, clean: 1, flagged: 0, failures: [] },
    };
    const { client } = stubClient((agent) => ({ data: bodies[agent], error: null }));
    const result = await runPipeline(client);
    // Clean run is ok.
    assert.equal(result.ok, true);
    // Five transitions in total, one of which reached the queue.
    assert.match(result.summary, /5 row\(s\) advanced; 1 reached the Approval Queue/);
  });
});

describe('classifyResponse', () => {
  it('fails a 200 whose failures[] covers every row', () => {
    // Nothing scored, one failure: the step did no useful work.
    assert.equal(classifyResponse('matcher', { success: true, scored: 0, failures: [{ applicationId: 'a', error: 'x' }] }).status, 'failed');
  });

  it('is partial when some rows moved and some failed', () => {
    // Real progress plus real errors.
    assert.equal(classifyResponse('tailor', { success: true, tailored: 2, failures: [{ applicationId: 'a', error: 'x' }] }).status, 'partial');
  });

  it('treats the normalizer skipped_disabled body as a halt', () => {
    // normalizer/index.ts returns this 200 when the kill switch is off.
    assert.equal(classifyResponse('normalizer', { success: true, status: 'skipped_disabled' }).status, 'halted');
  });

  it('fails an unrecognised 200 shape instead of calling it success', () => {
    // A renamed field must not read as "0 moved, all good".
    assert.equal(classifyResponse('auditor', { success: true }).status, 'failed');
  });
});
