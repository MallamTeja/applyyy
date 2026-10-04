// Tests for the assisted-submit core. Fakes only: no Chromium, no network, no database.
// The thing worth proving is the exact SEQUENCE of status writes and who wrote each one,
// because a wrong `applied` is the one error here nobody would notice later.
// Vitest primitives; `vi.fn` gives call recording without a mocking framework.
import { describe, expect, it, vi } from 'vitest';
// The unit under test, imported by its public names only.
import {
  ASSISTED_BLOCK_NOTE,
  interpretAnswer,
  runAssisted,
  type AssistGateway,
  type AssistRow,
} from '../src/assist/assisted-submit.ts';
// Type only: describes the form the fake page returns.
import type { FormField } from '../src/extract-fields.ts';
// A valid snapshot that satisfies the real type (see the fixture's own header).
import { syntheticResume } from './resolved-resume-fixture.ts';

// A text field the empty answer bank cannot answer, plus a file input for the resume.
const FIELDS: FormField[] = [
  // Unanswerable by design: the bank below is empty, so this must land in "unfilled".
  { id: 'q1', label: 'Favourite colour', kind: 'text', required: true },
  // The upload box, so the attach step actually runs.
  { id: 'resume', label: 'Resume', kind: 'file', required: true },
];

// An approved, fully usable row; each test overrides only the field it is about.
const goodRow: AssistRow = {
  // Arbitrary id; the fake gateway ignores it.
  id: 'app-1',
  // The one status the flow accepts.
  status: 'approved',
  // A reserved .test domain, so nothing real can ever be reached by accident.
  applyUrl: 'https://example.test/apply',
  // Present, because a null here is a refusal case tested separately.
  tailoredProfile: syntheticResume,
  // Display-only values.
  company: 'Acme',
  title: 'Engineer',
};

/** Build fakes plus a shared event log so ORDER across ports can be asserted. */
function setup(opts: { row?: AssistRow | null; answer?: string | null; gotoFails?: boolean } = {}) {
  // One log for every port: ordering between goto and the writes is the point.
  const events: string[] = [];
  // Records each status write as `advance:<to>:<agent>` in the shared log.
  const advance = vi.fn(async (_id: string, to: string, agent: string) => {
    // Pushed at call time, so the log reflects real execution order.
    events.push(`advance:${to}:${agent}`);
  });
  // The fake database port.
  const gateway: AssistGateway = {
    // The recording writer above.
    advanceStatus: advance,
    // `'row' in opts` distinguishes "not passed" (use goodRow) from "passed null".
    loadApplication: async () => ('row' in opts ? (opts.row ?? null) : goodRow),
    // A spy so refusal tests can assert it was never reached.
    claim: vi.fn(async () => true),
    // Logged, so the goto-failure test can assert the lease was given back.
    releaseClaim: vi.fn(async () => {
      events.push('release');
    }),
    // Logged, to prove it happens before the park write.
    markBlockedReason: vi.fn(async () => {
      events.push('markBlockedReason');
    }),
    // Empty bank: every text field is therefore unanswerable.
    fetchAnswers: async () => [],
  };
  // The submit spy lives on the fake page even though the AssistPage type cannot reach it.
  const submit = vi.fn(async () => {});
  // A fake page offering the full real port, so the test can prove submit stays unused.
  const page = {
    // Logs first, then optionally fails, to model a dead URL.
    goto: vi.fn(async () => {
      // Logged before the throw so the failure test still sees the attempt.
      events.push('goto');
      // Simulates a DNS failure, the commonest real navigation error.
      if (opts.gotoFails) throw new Error('net::ERR_NAME_NOT_RESOLVED');
    }),
    // Returns the fixed two-field form.
    extractFields: async () => FIELDS,
    // No wall, so the happy path has no page-blocker problem line.
    detectBlocker: async () => null,
    // Never invoked here: the bank is empty, so the planner produces no fills.
    fill: vi.fn(async () => {}),
    // Logged so the ordering test sees the attachment between applying and park.
    attachFile: vi.fn(async () => {
      events.push('attach');
    }),
    // THE SPY: the flow must never call this.
    submit,
    // Unused by the flow; present only to satisfy the full page port.
    screenshot: async () => new Uint8Array(),
    // False, matching the real page while SUBMISSION_IMPLEMENTED is false.
    submissionImplemented: false,
  };
  // Captures what the human would have seen.
  const lines: string[] = [];
  // The full dependency bag handed to the flow.
  const deps = {
    // Matches goodRow.id.
    applicationId: 'app-1',
    // The fake database.
    gateway,
    // The fake browser.
    page,
    // A spy returning tiny bytes; one test makes it reject.
    renderResume: vi.fn(async () => ({ bytes: new Uint8Array([1]), sha256: 'x' })),
    // `answer` omitted means the human typed "y"; an explicit null models EOF.
    askHuman: vi.fn(async () => ('answer' in opts ? (opts.answer ?? null) : 'y')),
    // Collects output instead of printing it.
    log: (line: string) => lines.push(line),
  };
  // Everything a test might want to inspect.
  return { deps, events, advance, gateway, page, submit, lines };
}

// Pure mapping first: it is the part where a bug records a false application.
describe('interpretAnswer', () => {
  it('maps exactly y and n, tolerating case and whitespace only', () => {
    // Trim + lowercase is the whole leniency budget.
    expect(interpretAnswer(' Y ')).toEqual({ to: 'applied' });
    // The negative answer maps to failed, never to applied.
    expect(interpretAnswer('n')).toEqual({ to: 'failed' });
  });

  it('treats everything else as unsure', () => {
    // "yes" is deliberately NOT accepted: a lenient match is how a false `applied` happens.
    for (const raw of ['yes', '', 'ny', 'maybe', null]) {
      // Each must be null, i.e. "write nothing".
      expect(interpretAnswer(raw)).toBeNull();
    }
  });
});

// Refusals must be free: no claim, no browser, no write.
describe('runAssisted refusals', () => {
  it('refuses a row that is not approved, writing and claiming nothing', async () => {
    // awaiting_approval is the realistic wrong status: a human has not approved it yet.
    const t = setup({ row: { ...goodRow, status: 'awaiting_approval' } });
    // Run the flow end to end.
    const outcome = await runAssisted(t.deps);
    // The outcome names a refusal rather than throwing.
    expect(outcome.kind).toBe('refused');
    // No claim: a refused row must not be leased.
    expect(t.gateway.claim).not.toHaveBeenCalled();
    // No navigation, no status write, no release: the log is empty.
    expect(t.events).toEqual([]);
  });

  it('refuses a null tailored_profile', async () => {
    // Null means nothing was approved to send.
    const t = setup({ row: { ...goodRow, tailoredProfile: null } });
    // The refusal is the outcome.
    expect((await runAssisted(t.deps)).kind).toBe('refused');
    // And it was silent: nothing happened on any port.
    expect(t.events).toEqual([]);
  });

  it('refuses a row it cannot see', async () => {
    // RLS-hidden and non-existent rows both load as null.
    const t = setup({ row: null });
    // Refused, not crashed.
    expect((await runAssisted(t.deps)).kind).toBe('refused');
  });
});

// The sequencing guarantees: where each write sits relative to the page work.
describe('runAssisted flow', () => {
  it('advances to applying only AFTER goto succeeds, and parks right after the fill', async () => {
    // The human says y, so the whole sequence runs.
    const t = setup({ answer: 'y' });
    // Execute.
    await runAssisted(t.deps);
    // The full ordered sequence, one assertion: goto, applying, fill work, park, human write.
    expect(t.events).toEqual([
      'goto',
      'advance:applying:applier',
      'attach',
      'markBlockedReason',
      'advance:blocked_needs_human:applier',
      'advance:applied:human',
    ]);
  });

  it('writes nothing and releases the claim when goto fails', async () => {
    // A dead URL.
    const t = setup({ gotoFails: true });
    // Execute.
    const outcome = await runAssisted(t.deps);
    // A distinct outcome so the CLI can say what went wrong.
    expect(outcome.kind).toBe('navigation_failed');
    // Still approved, so no status moved.
    expect(t.advance).not.toHaveBeenCalled();
    // The lease went back, in the right order: after the attempted navigation.
    expect(t.events).toEqual(['goto', 'release']);
  });

  it('still parks at blocked_needs_human when filling throws', async () => {
    // Null answer, so the run ends right after the park and nothing else interferes.
    const t = setup({ answer: null });
    // The renderer runs inside the guarded fill block, so making it throw simulates a mid-fill crash.
    t.deps.renderResume.mockRejectedValueOnce(new Error('render exploded'));
    // Execute.
    const outcome = await runAssisted(t.deps);
    // Left blocked, which is only reachable if the park happened.
    expect(outcome.kind).toBe('left_blocked');
    // The park write is in the log despite the error.
    expect(t.events).toContain('advance:blocked_needs_human:applier');
    // And the human was told what failed, so they can finish by hand.
    expect(t.lines.some((l) => l.includes('render exploded'))).toBe(true);
  });

  it('records the park note in the event detail', async () => {
    // No answer needed; only the park matters.
    const t = setup({ answer: null });
    // Execute.
    await runAssisted(t.deps);
    // Find the park call among all status writes.
    const parkCall = t.advance.mock.calls.find((c) => c[1] === 'blocked_needs_human');
    // The sentence the dashboard shows must be in the detail argument.
    expect(JSON.stringify(parkCall)).toContain(ASSISTED_BLOCK_NOTE);
  });

  it('y -> applied by human', async () => {
    // The human confirms.
    const t = setup({ answer: 'y' });
    // Both the outcome and the final write are checked.
    expect(await runAssisted(t.deps)).toEqual({ kind: 'recorded', to: 'applied' });
    // Written as `human`, never as `applier`.
    expect(t.events.at(-1)).toBe('advance:applied:human');
  });

  it('n -> failed by human', async () => {
    // The human reports it did not go through.
    const t = setup({ answer: 'n' });
    // Outcome says failed.
    expect(await runAssisted(t.deps)).toEqual({ kind: 'recorded', to: 'failed' });
    // And so does the write, again as `human`.
    expect(t.events.at(-1)).toBe('advance:failed:human');
  });

  // Garbage, a near-miss and EOF all share one expectation: write nothing more.
  it.each([['garbage'], ['yes'], [null]])('unsure answer %s writes nothing after the park', async (answer) => {
    // The parametrised answer.
    const t = setup({ answer });
    // The outcome is the deliberate "left blocked".
    expect((await runAssisted(t.deps)).kind).toBe('left_blocked');
    // The last write is the park; no applied/failed followed it.
    expect(t.events.at(-1)).toBe('advance:blocked_needs_human:applier');
  });

  it('never writes applied as the applier, and never calls submit', async () => {
    // Every answer path, because the guarantee must hold for all of them.
    for (const answer of ['y', 'n', 'x', null]) {
      // A fresh world per path, so logs do not bleed together.
      const t = setup({ answer });
      // Execute.
      await runAssisted(t.deps);
      // `applying -> applied` by the worker would claim a confirmed submission.
      expect(t.events).not.toContain('advance:applied:applier');
      // The submit spy on the fake page stays untouched.
      expect(t.submit).not.toHaveBeenCalled();
    }
  });
});
