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
    const f = fake([none, ok], ['tailored', 'tailored']);
    const r = await runPipeline(f.deps);
    expect(f.called).toEqual(['matcher']);
    expect(r).toEqual({ completed: false, finalStatus: 'tailored' });
    expect(f.logs.join('\n')).toContain('"found": 0');
  });

  it('stops on an HTTP error', async () => {
    const f = fake([{ ok: false, body: { error: 'invalid_application_id' } }], ['passed_filters', 'scored']);
    const r = await runPipeline(f.deps);
    expect(r.completed).toBe(false);
    expect(f.called).toEqual(['matcher']);
  });
});
