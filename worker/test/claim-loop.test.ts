// The batched run: one GitHub Actions job that processes the whole day's queue.
//
// Batching is not an optimisation, and the tests below exist because the change
// that breaks it will look like an improvement. 35 separate runs cost ~88
// min/day against a 66 min/day Free budget, because GitHub bills every job
// ROUNDED UP TO A WHOLE MINUTE and each run pays ~40-70s of checkout, install
// and browser-restore before doing any work. One batched run costs ~54 min/day
// and fits. Splitting this loop into a matrix of parallel jobs is the obvious
// speed-up and it multiplies the billed minutes by 35.
import { describe, expect, it, vi } from 'vitest';
import { runApplierBatch, type RunGateway } from '../src/claim-loop.ts';
import type { ApplicationPage } from '../src/apply-one.ts';
import type { AnswerBankRow } from '@applyy/shared-types';

/** A page that always presents one answerable field and never blocks. */
function stubPage(): ApplicationPage & { close(): Promise<void> } {
  return {
    goto: async () => {},
    extractFields: async () => [
      { id: 'first_name', label: 'First Name', kind: 'text', required: true },
    ],
    fill: async () => {},
    // Present because the port requires it; these tests never reach it, since
    // the stub form below carries no file input.
    attachFile: async () => {},
    screenshot: async () => new Uint8Array([1]),
    detectBlocker: async () => null,
    submit: async () => {},
    close: async () => {},
  };
}

const answers = [
  { question_key: 'first_name', answer_value: 'Teja', needs_human: false, answer_type: 'text' },
] as unknown as AnswerBankRow[];

/**
 * A recording gateway. `calls` preserves ORDER across different operations,
 * which is what lets the sweep-before-claim test assert a sequence rather than
 * merely that both happened.
 */
function fakeGateway(overrides: Partial<RunGateway> = {}) {
  const calls: string[] = [];
  // Rows handed out on successive claim calls; the loop claims repeatedly until
  // it gets an empty page, so a single-element queue needs a terminating [].
  const batches: Array<
    Array<{
      id: string;
      status: 'approved';
      applyUrl: string;
      // Carried on the claim because `claim_applications` returns `a.*`. Null
      // here is honest and harmless: the stub form asks for no document, so the
      // attachment planner proceeds without one — which is also the case these
      // tests want, since they are about pacing and not about resumes.
      tailoredProfile: null;
    }>
  > = [
    [{ id: 'app-1', status: 'approved', applyUrl: 'http://127.0.0.1:1/a.html', tailoredProfile: null }],
    [],
  ];
  const closed: Array<Record<string, unknown>> = [];
  const gateway: RunGateway = {
    openRun: async () => {
      calls.push('openRun');
      return { id: 'run-1' };
    },
    closeRun: async (_id, update) => {
      calls.push('closeRun');
      closed.push(update as Record<string, unknown>);
    },
    isSystemEnabled: async () => {
      calls.push('isSystemEnabled');
      return true;
    },
    sweepStaleClaims: async () => {
      calls.push('sweep');
    },
    claimApplications: async () => {
      calls.push('claim');
      return batches.shift() ?? [];
    },
    fetchAnswers: async () => answers,
    sessionExpiresAtEpochSeconds: () => 2_000_000,
    refreshSession: async () => {
      calls.push('refresh');
    },
    advanceStatus: async (_id, to) => {
      calls.push(`advance:${to}`);
    },
    releaseClaim: async () => {
      calls.push('release');
    },
    uploadScreenshot: async () => 'screens/a.png',
    uploadResume: async () => 'resumes/a.pdf',
    // `runApplierBatch` ITSELF NEVER CALLS THIS — it is required here only
    // because `RunGateway` extends `ApplierGateway`, and the evidence write is
    // issued one layer down by applyToOne on its dry-run path. (The dry-run
    // tests in this file therefore DO record it, through that delegation.) It
    // exists at all because a dry run writes no status, and the only code that
    // persisted the storage paths used to live inside a status transition.
    //
    // Recorded into `calls` rather than stubbed as an empty function, for the
    // same reason every other operation here is: `calls` is the ordering record
    // this file asserts against, so a future change that moves path-recording
    // up into the loop shows up as a new step rather than being absorbed
    // silently — and a future test can assert on it without rewriting the fake.
    setArtifactPaths: async () => {
      calls.push('setArtifactPaths');
    },
    ...overrides,
  };
  return { gateway, calls, closed };
}

/**
 * A renderer that throws if anything calls it.
 *
 * Deliberately hostile rather than a no-op. None of these tests presents a form
 * with an upload, so a render here would mean the applier had started producing
 * PDFs for forms that never asked for one — and a stub returning fake bytes
 * would absorb that regression silently.
 */
const renderResume = async (): Promise<never> => {
  throw new Error('claim-loop tests must not reach the resume renderer');
};

/** A clock that never moves, so wall-clock budget never triggers by accident. */
const frozenClock = () => 1_000_000;

describe('runApplierBatch', () => {
  it('sweeps stale claims before claiming any work', async () => {
    // Order matters: sweeping first is what makes a crashed previous run
    // self-heal. Sweeping after claiming would leave last night's stranded rows
    // invisible for a whole extra day.
    const { gateway, calls } = fakeGateway();

    await runApplierBatch({ gateway, openPage: async () => stubPage(), env: {}, clock: frozenClock, renderResume });

    expect(calls.indexOf('sweep')).toBeLessThan(calls.indexOf('claim'));
  });

  it('records a disabled kill switch as skipped rather than as a quiet success', async () => {
    // §18.1 plus §14. `claim_applications` already returns nothing when
    // `system_enabled` is false, so reading the flag here is NOT the safety
    // mechanism — it is the OBSERVABILITY one. Without it, "0 applications
    // today" is indistinguishable between "the kill switch is off" and "the
    // queue was empty", and the health page cannot tell Teja which.
    const { gateway, calls, closed } = fakeGateway({ isSystemEnabled: async () => false });

    const summary = await runApplierBatch({
      gateway,
      openPage: async () => stubPage(),
      renderResume,
      env: {},
      clock: frozenClock,
    });

    // No work claimed at all.
    expect(calls).not.toContain('claim');
    // And the run says why, in a form the health page can render.
    expect(closed[0]?.status).toBe('skipped_disabled');
    expect(summary.stoppedReason).toMatch(/kill switch/i);
  });

  it('re-authenticates before an application when the token is near expiry', async () => {
    // The refresh must land BEFORE `approved -> applying`, never inside the
    // applying window: that is the one non-idempotent leg, and a token dying
    // there leaves a row whose real-world outcome is unknown.
    const { gateway, calls } = fakeGateway({
      // 30s of life left, well inside the 300s margin.
      sessionExpiresAtEpochSeconds: () => 1_000_030,
    });

    await runApplierBatch({
      gateway,
      openPage: async () => stubPage(),
      renderResume,
      env: { DRY_RUN: 'false' },
      clock: frozenClock,
    });

    // Refreshed, and refreshed before the row entered `applying`.
    expect(calls).toContain('refresh');
    expect(calls.indexOf('refresh')).toBeLessThan(calls.indexOf('advance:applying'));
  });

  it('stops cleanly when the wall-clock budget is spent, leaving rows claimable', async () => {
    // Bounded-batch-and-re-fire, applied to wall clock. Overflow is not lost:
    // unclaimed rows stay `approved` for the next cron tick.
    const { gateway, calls } = fakeGateway();

    const summary = await runApplierBatch({
      gateway,
      openPage: async () => stubPage(),
      renderResume,
      env: {},
      // Started far enough in the past that the budget is already gone.
      clock: () => 1_000_000,
      runStartedAtEpochSeconds: 1_000_000 - 100_000,
    });

    expect(calls).not.toContain('claim');
    expect(summary.stoppedReason).toMatch(/budget/i);
  });

  it('closes the run even when an application throws', async () => {
    // A run row opened and never closed shows as permanently "running" on the
    // health page, which reads as a hung worker rather than as a failed
    // application — the wrong diagnosis for the wrong person.
    const { gateway, calls, closed } = fakeGateway();

    await runApplierBatch({
      gateway,
      openPage: async () => ({
        ...stubPage(),
        goto: async () => {
          throw new Error('net::ERR_CONNECTION_REFUSED');
        },
      }),
      renderResume,
      env: {},
      clock: frozenClock,
    });

    expect(calls).toContain('closeRun');
    // One error counted, and the run is not reported as a clean success.
    expect(closed[0]?.error_count).toBe(1);
  });

  it('closes the browser page even when the application throws', async () => {
    // A leaked page keeps Chromium alive and the Actions job billing until its
    // timeout — a real cost against a budget measured in whole minutes.
    const close = vi.fn(async () => {});
    const { gateway } = fakeGateway();

    await runApplierBatch({
      gateway,
      openPage: async () => ({
        ...stubPage(),
        goto: async () => {
          throw new Error('boom');
        },
        close,
      }),
      renderResume,
      env: {},
      clock: frozenClock,
    });

    expect(close).toHaveBeenCalled();
  });

  it('counts dry-run applications without reporting them as submitted', async () => {
    // The §18.6 trust period must not inflate the "applied" number, or the
    // health page tells Teja the system is working when nothing has been sent.
    const { gateway, closed } = fakeGateway();

    const summary = await runApplierBatch({
      gateway,
      openPage: async () => stubPage(),
      renderResume,
      env: {},
      clock: frozenClock,
    });

    expect(summary.submitted).toBe(0);
    expect(summary.dryRun).toBe(1);
    // rows_out counts work genuinely completed, which in dry-run is nothing.
    expect(closed[0]?.rows_out).toBe(0);
  });
});
