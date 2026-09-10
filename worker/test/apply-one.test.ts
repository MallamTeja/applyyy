// The per-application state machine: the only place in this repo that can
// submit anything to a real employer.
//
// THE CENTRAL WIRING PROPERTY, and the reason this file exists at all: a
// pre-deploy audit found that `resolveSubmissionMode` — ten tests, correct,
// fail-closed — HAD NO CALLERS. It was a guarantee about code that did not run,
// and the suite was green and the audit read clean the whole time. A guard
// nothing calls is the most dangerous kind.
//
// So these tests do not merely assert "we did not submit". They assert that the
// SAME code path DOES submit when the flag is explicitly opted in — because
// "no submit path exists" and "every submit path is guarded" are otherwise
// indistinguishable, and a test that cannot tell them apart is exactly the
// composite test that the aria-hidden regression turned out to be.
import { describe, expect, it, vi } from 'vitest';
import { applyToOne, type ApplicationPage, type ApplierGateway } from '../src/apply-one.js';
import type { FormField } from '../src/extract-fields.js';
import type { AnswerBankRow } from '@applyy/shared-types';

/** A form the answer bank can fully satisfy, so nothing blocks by accident. */
const answerableForm: FormField[] = [
  { id: 'first_name', label: 'First Name', kind: 'text', required: true },
];

/** The matching bank. Real rows carry more columns; the planner reads four. */
const answers = [
  { question_key: 'first_name', answer_value: 'Teja', needs_human: false, answer_type: 'text' },
] as unknown as AnswerBankRow[];

/**
 * A fake browser page that records what was done to it.
 *
 * A fake rather than a mock: the assertions below are about whether SUBMIT was
 * reached, which is real behaviour of the code under test rather than the
 * behaviour of a mocking framework.
 */
function fakePage(overrides: Partial<ApplicationPage> = {}) {
  // The single most important spy in the repo: whether a real submission was
  // attempted. Every test below asserts on this.
  const submit = vi.fn(async () => {});
  const page: ApplicationPage = {
    goto: async () => {},
    extractFields: async () => answerableForm,
    fill: async () => {},
    screenshot: async () => new Uint8Array([1, 2, 3]),
    // No captcha by default; the blocking tests override this.
    detectBlocker: async () => null,
    submit,
    ...overrides,
  };
  return { page, submit };
}

/** Records every status transition attempted, so ORDER can be asserted. */
function fakeGateway() {
  const transitions: string[] = [];
  const released: string[] = [];
  const gateway: ApplierGateway = {
    advanceStatus: async (_id, to) => {
      transitions.push(to);
    },
    releaseClaim: async (id) => {
      released.push(id);
    },
    uploadScreenshot: async () => 'screens/app-1.png',
  };
  return { transitions, released, gateway };
}

/** The claimed row under test. */
const row = { id: 'app-1', status: 'approved', applyUrl: 'http://127.0.0.1:1/form.html' } as const;

describe('applyToOne', () => {
  it('never submits and never touches the status graph when DRY_RUN is unset', async () => {
    const { page, submit } = fakePage();
    const { gateway, transitions, released } = fakeGateway();

    const outcome = await applyToOne({
      row,
      page,
      gateway,
      answers,
      // Unset is the realistic misconfiguration: a fresh runner, or a workflow
      // referencing a secret that does not exist — `secrets.MISSING` expands to
      // empty, which is why the gate treats absence as dry-run.
      env: {},
    });

    // THE constraint #15 / #16 assertion.
    expect(submit).not.toHaveBeenCalled();
    // And the structural half: a dry run cannot enter `applying`, because
    // `approved -> applying` is the ONLY edge out of `approved`. So it leaves
    // the row exactly where the human approved it — still there when the flag
    // is finally flipped, rather than consuming the queue to prove it could.
    expect(transitions).toHaveLength(0);
    // The claim is given back so the next run can pick the row up again.
    expect(released).toEqual(['app-1']);
    expect(outcome.kind).toBe('dry_run_complete');
  });

  it('DOES submit when DRY_RUN is exactly "false"', async () => {
    // NON-VACUITY GUARD for the test above, and the whole reason this file can
    // claim to test wiring at all. Without it, every "we did not submit"
    // assertion would pass just as well against code with no submit path —
    // which is precisely the state the repo was in when the audit read clean.
    const { page, submit } = fakePage();
    const { gateway, transitions } = fakeGateway();

    await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' } });

    expect(submit).toHaveBeenCalledTimes(1);
    // The full legal path: into `applying`, then to `applied`.
    expect(transitions).toEqual(['applying', 'applied']);
  });

  it('enters `applying` before submitting and marks `applied` only after', async () => {
    // The ORDER is the anti-double-submit guarantee. If `applied` could be
    // written before the submit, a crash between them would leave a row
    // claiming success that never went out. If `applying` were written after,
    // a crash mid-submit would leave a row the sweeper cannot recognise as
    // dangerous, and it would be retried blind — constraint #7.
    const observed: string[] = [];
    const { page } = fakePage({
      submit: async () => {
        observed.push('submit');
      },
    });
    const gateway: ApplierGateway = {
      advanceStatus: async (_id, to) => {
        observed.push(to);
      },
      releaseClaim: async () => {},
      uploadScreenshot: async () => 'screens/app-1.png',
    };

    await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' } });

    expect(observed).toEqual(['applying', 'submit', 'applied']);
  });

  it('writes NO status at all when the submit itself throws', async () => {
    // THE MOST SAFETY-CRITICAL CASE IN THE FILE. A submit that throws has an
    // UNKNOWN real-world outcome — the click may have landed and the response
    // may have been lost. We must not write `failed` (that asserts it did not
    // send) and must not write `applied` (that asserts it did). Leaving the row
    // in `applying` with an expiring lease is the correct answer: the sweeper
    // routes it to `needs_verification`, which is human-only, so a person
    // decides. That is the whole reason `applying` never auto-retries.
    const { page } = fakePage({
      submit: async () => {
        throw new Error('navigation interrupted');
      },
    });
    const { gateway, transitions } = fakeGateway();

    const outcome = await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' } });

    // `applying` was entered, and nothing whatsoever was written after it.
    expect(transitions).toEqual(['applying']);
    expect(outcome.kind).toBe('submit_outcome_unknown');
  });

  it('parks a captcha at blocked_needs_human without submitting', async () => {
    // Constraint #5: never bypass a captcha, MFA or anti-bot control. Detection
    // routes here, and since Actions has no human present this is a normal
    // daily queue item rather than a failure.
    const { page, submit } = fakePage({ detectBlocker: async () => 'captcha' });
    const { gateway, transitions } = fakeGateway();

    const outcome = await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' } });

    expect(submit).not.toHaveBeenCalled();
    expect(transitions).toEqual(['applying', 'blocked_needs_human']);
    expect(outcome.kind).toBe('blocked');
  });

  it('parks an unanswerable required question rather than guessing', async () => {
    // Constraint #4, end to end. The planner has no branch that invents a
    // value, so an unanswered required field can only become a blocker.
    const { page, submit } = fakePage({
      extractFields: async () => [
        { id: 'ctc', label: 'Expected CTC', kind: 'text', required: true },
      ],
    });
    const { gateway, transitions } = fakeGateway();

    const outcome = await applyToOne({
      row,
      page,
      gateway,
      // Empty bank: nothing can answer "Expected CTC".
      answers: [],
      env: { DRY_RUN: 'false' },
    });

    expect(submit).not.toHaveBeenCalled();
    expect(transitions).toEqual(['applying', 'blocked_needs_human']);
    expect(outcome.kind).toBe('blocked');
  });

  it('reports blockers in dry-run without moving the row', async () => {
    // During the §18.6 trust period Teja needs to SEE which questions would
    // have blocked, so the answer bank can grow before the flag flips — but
    // surfacing them must not consume the queue, since `blocked_needs_human` is
    // reachable only through `applying` and a dry run must never enter it.
    const { page, submit } = fakePage({
      extractFields: async () => [
        { id: 'ctc', label: 'Expected CTC', kind: 'text', required: true },
      ],
    });
    const { gateway, transitions } = fakeGateway();

    const outcome = await applyToOne({ row, page, gateway, answers: [], env: {} });

    expect(submit).not.toHaveBeenCalled();
    expect(transitions).toHaveLength(0);
    // The blockers ride out on the outcome so the run summary can log them.
    expect(outcome.kind).toBe('dry_run_complete');
    if (outcome.kind === 'dry_run_complete') {
      expect(outcome.blockers.map((blocker) => blocker.label)).toEqual(['Expected CTC']);
    }
  });
});
