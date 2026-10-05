// run-one: the pure id parser and the stop-on-failure pipeline, with every effect faked.
import { describe, expect, it } from 'vitest';
import { parseId, runPipeline, type StepResponse } from '../src/cli/run-one.ts';

// A valid v4-shaped id.
const ID = '123e4567-e89b-42d3-a456-426614174000';

// Builds deps from scripted responses and a status sequence; records calls.
function fake(responses: StepResponse[], statuses: (string | null)[]) {
  // Which steps were actually invoked: the stop assertions read this.
  const called: string[] = [];
  // Everything printed.
  const logs: string[] = [];
  // Index into the scripted status sequence.
  let s = 0;
  return {
    called,
    logs,
    deps: {
      callFunction: async (step: string) => {
        called.push(step);
        return responses[called.length - 1]!;
      },
      readStatus: async () => statuses[s++] ?? null,
      log: (l: string) => {
        logs.push(l);
      },
    },
  };
}
// A clean response.
const ok: StepResponse = { ok: true, body: { success: true, failures: [] } };

describe('parseId', () => {
  it('accepts a UUID', () => expect(parseId(['--id', ID])).toBe(ID));
  it('rejects a malformed id', () => expect(() => parseId(['--id', 'abc'])).toThrow(/usage/));
  it('rejects a missing flag', () => expect(() => parseId([])).toThrow(/usage/));
});

describe('runPipeline', () => {
  it('runs all three steps and points at /approvals', async () => {
    const f = fake([ok, ok, ok], ['passed_filters', 'scored', 'tailored', 'awaiting_approval']);
    const r = await runPipeline(f.deps);
    expect(f.called).toEqual(['matcher', 'tailor', 'auditor']);
    expect(r).toEqual({ completed: true, finalStatus: 'awaiting_approval' });
    expect(f.logs).toContain('open /approvals to review');
  });

  it('stops at the first step reporting failures and prints the body', async () => {
    const bad: StepResponse = { ok: true, body: { success: true, failures: [{ applicationId: ID, error: 'x' }] } };
    const f = fake([ok, bad, ok], ['passed_filters', 'scored', 'scored']);
    const r = await runPipeline(f.deps);
    expect(f.called).toEqual(['matcher', 'tailor']);
    expect(r.completed).toBe(false);
    expect(f.logs.join('\n')).toContain('"error": "x"');
  });

  it('stops when the status did not move (targeted found:0)', async () => {
    const none: StepResponse = { ok: true, body: { success: true, targeted: true, found: 0 } };
    // Starts at the matcher's own input status, so the matcher IS called and finds nothing.
    const f = fake([none, ok], ['passed_filters', 'passed_filters']);
    const r = await runPipeline(f.deps);
    expect(f.called).toEqual(['matcher']);
    expect(r).toEqual({ completed: false, finalStatus: 'passed_filters' });
    expect(f.logs.join('\n')).toContain('"found": 0');
  });

  // The live case on 2026-10-05: matcher succeeded, tailor failed, row left at 'scored'.
  // A re-run must resume at the tailor, never stop at the matcher.
  it('resumes a row at scored: skips matcher, runs tailor then auditor', async () => {
    const f = fake([ok, ok], ['scored', 'tailored', 'awaiting_approval']);
    const r = await runPipeline(f.deps);
    // The matcher was never invoked: its queue is passed_filters only.
    expect(f.called).toEqual(['tailor', 'auditor']);
    expect(r).toEqual({ completed: true, finalStatus: 'awaiting_approval' });
    // The skip is logged, not silent.
    expect(f.logs.join('\n')).toContain('matcher: skipped (row at scored');
  });

  // A row the auditor left mid-way (audit_clean) resumes at the auditor alone.
  it('resumes a row at audit_clean: only the auditor runs', async () => {
    const f = fake([ok], ['audit_clean', 'awaiting_approval']);
    const r = await runPipeline(f.deps);
    expect(f.called).toEqual(['auditor']);
    expect(r).toEqual({ completed: true, finalStatus: 'awaiting_approval' });
  });

  // A row past every step (e.g. already awaiting_approval) calls nothing and spends no Gemini.
  it('calls nothing for a row past every step', async () => {
    const f = fake([], ['awaiting_approval']);
    const r = await runPipeline(f.deps);
    expect(f.called).toEqual([]);
    expect(r.finalStatus).toBe('awaiting_approval');
  });

  it('stops on an HTTP error', async () => {
    const f = fake([{ ok: false, body: { error: 'invalid_application_id' } }], ['passed_filters', 'scored']);
    const r = await runPipeline(f.deps);
    expect(r.completed).toBe(false);
    expect(f.called).toEqual(['matcher']);
  });
});
