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
import { parseOnlyApplicationId, runApplierBatch, type RunGateway } from '../src/claim-loop.ts';
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
    // A confirmed page: the only SubmitResult that may become `applied`.
    submit: async () => ({ kind: 'confirmed', evidence: 'test' }) as const,
    // True so the loop's submit-mode tests model a page that can send.
    submissionImplemented: true,
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
      // Unknown employer: the stub form never asks "previously worked at", so null is harmless.
      employerName: null;
    }>
  > = [
    [{ id: 'app-1', status: 'approved', applyUrl: 'http://127.0.0.1:1/a.html', tailoredProfile: null, employerName: null }],
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

  it('processes each row once per run even though a dry run releases it', async () => {
    // The live loop: a dry run releases every row it finishes, the claim takes
    // the oldest UNCLAIMED rows, so the same rows came straight back and the run
    // refilled the same employer forms until the budget ran out. This fake
    // models the real RPC — oldest first, leased rows skipped — so the bug is
    // reproducible here rather than hidden by a scripted list of batches.
    const queue = ['app-1', 'app-2', 'app-3'];
    // Rows currently leased; release removes from it, exactly as the RPC does.
    const leased = new Set<string>();
    // Every id released, to assert nothing stays leased.
    const releases: string[] = [];
    // How many claims ran, so an endless loop fails on a bound, not a timeout.
    let claims = 0;
    const { gateway } = fakeGateway({
      claimApplications: async (_by, limit) => {
        claims += 1;
        // A hard ceiling: the bug this test guards is an unbounded loop.
        if (claims > 20) throw new Error('claim loop did not terminate');
        // FIFO over unleased rows, like `claimed_by is null order by created_at`.
        const picked = queue.filter((id) => !leased.has(id)).slice(0, limit);
        for (const id of picked) leased.add(id);
        return picked.map((id) => ({
          id,
          status: 'approved' as const,
          applyUrl: 'http://127.0.0.1:1/a.html',
          tailoredProfile: null,
          // No employer: these tests are about pacing, never about eligibility questions.
          employerName: null,
        }));
      },
      releaseClaim: async (id) => {
        leased.delete(id);
        releases.push(id);
      },
    });

    const summary = await runApplierBatch({
      gateway,
      openPage: async () => stubPage(),
      renderResume,
      env: {},
      clock: frozenClock,
      batchSize: 2,
    });

    // Three rows, three applications — not three per claim until the budget ends.
    expect(summary.dryRun).toBe(3);
    expect(summary.claimed).toBe(3);
    // And nothing is left leased when the run ends, so tomorrow can claim it.
    expect(leased.size).toBe(0);
    // Every row was released, the re-claimed ones included.
    expect(new Set(releases)).toEqual(new Set(queue));
  });

  it('stops between applications when the kill switch is turned off mid-batch', async () => {
    // The gate used to run once per BATCH, so flipping the switch still let up
    // to four more employers' forms be filled. Read per application now.
    let reads = 0;
    // Records release reasons so the untouched row is shown to be handed back.
    const releases: Array<{ id: string; reason: string }> = [];
    const { gateway } = fakeGateway({
      // On at run start and for the first row; off before the second.
      isSystemEnabled: async () => {
        reads += 1;
        return reads <= 2;
      },
      claimApplications: async () => [
        { id: 'app-1', status: 'approved', applyUrl: 'http://127.0.0.1:1/a.html', tailoredProfile: null, employerName: null },
        { id: 'app-2', status: 'approved', applyUrl: 'http://127.0.0.1:1/a.html', tailoredProfile: null, employerName: null },
      ],
      releaseClaim: async (id, reason) => {
        releases.push({ id, reason });
      },
    });

    const summary = await runApplierBatch({
      gateway,
      openPage: async () => stubPage(),
      renderResume,
      env: {},
      clock: frozenClock,
    });

    // Only the first application ran.
    expect(summary.claimed).toBe(1);
    expect(summary.stoppedReason).toMatch(/kill switch/i);
    // The second was released untouched, with the reason it never started.
    expect(releases).toContainEqual({ id: 'app-2', reason: expect.stringMatching(/^not started: kill switch/) });
  });
});

/**
 * APPLY_ONLY_ID: a run scoped to ONE application.
 *
 * Exists for the first real submissions, where "exactly this employer" is the
 * whole point. The failure it guards is a newly approved row riding along on a
 * run that was meant to send one application: an irreversible send nobody chose.
 */
describe('APPLY_ONLY_ID', () => {
  // The one application the run is scoped to. Lower-case, as parseOnlyApplicationId returns it.
  const target = '11111111-1111-4111-8111-111111111111';
  // Rows that must never be touched.
  const otherA = '22222222-2222-4222-8222-222222222222';
  const otherB = '33333333-3333-4333-8333-333333333333';

  /**
   * A queue that behaves like the real claim RPC: oldest unleased rows first,
   * release returns a row to the pool. Scripted batches would hide exactly the
   * "released row comes straight back" behaviour the filter has to survive.
   */
  function queueGateway(queue: string[]) {
    // Rows currently leased to this run.
    const leased = new Set<string>();
    // Every release, with its reason, to show non-targets were handed back untouched.
    const releases: Array<{ id: string; reason: string }> = [];
    // Every status write, BY ROW, so a non-target advance is visible.
    const advances: Array<{ id: string; to: string }> = [];
    // Claim calls, bounded so a loop that never ends fails fast.
    let claims = 0;
    const { gateway, calls } = fakeGateway({
      claimApplications: async (_by, limit) => {
        // Counted for the "run ends here" assertion.
        claims += 1;
        // A hard ceiling: an unbounded claim loop is a failure mode here too.
        if (claims > 20) throw new Error('claim loop did not terminate');
        // FIFO over unleased rows, like `claimed_by is null order by created_at`.
        const picked = queue.filter((id) => !leased.has(id)).slice(0, limit);
        // Leased on hand-out, exactly as the RPC does.
        for (const id of picked) leased.add(id);
        // Each row's applyUrl names it, so page navigations identify the row.
        return picked.map((id) => ({ id, status: 'approved' as const, applyUrl: `http://127.0.0.1:1/${id}`, tailoredProfile: null, employerName: null }));
      },
      // Recorded per row so the assertions can say WHICH row moved.
      advanceStatus: async (id, to) => {
        // Only the target may ever appear here.
        advances.push({ id, to });
      },
      // Release unleases, so a released row is claimable again (the real behaviour).
      releaseClaim: async (id, reason) => {
        // Back in the pool.
        leased.delete(id);
        // With the reason, for the "not the targeted application" assertion.
        releases.push({ id, reason });
      },
    });
    // The gateway, its logs, and a live view of the claim count.
    return { gateway, calls, releases, advances, leased, claimCount: () => claims };
  }

  /** A page opener that records every URL any page was sent to. */
  function recordingPages() {
    // Every navigation across every page: the proof a row was (or was not) worked on.
    const visited: string[] = [];
    // Opens a stub page whose goto is recorded.
    const openPage = async () => ({
      // Everything else from the shared stub.
      ...stubPage(),
      // The only override: remember where the page went.
      goto: async (url: string) => {
        // Recorded before anything else could fail.
        visited.push(url);
      },
    });
    // The opener and its log.
    return { openPage, visited };
  }

  it('APPLY_ONLY_ID: a non-target claimed row is released, never applied', async () => {
    // The non-target is OLDER, so the claim hands it out first. It must be held,
    // not navigated to, not filled, not advanced, and given back at the end.
    const { gateway, releases, advances, leased } = queueGateway([otherA, target]);
    // Records every navigation.
    const { openPage, visited } = recordingPages();

    // Live mode, the case the filter exists for; batch of one forces two claims.
    await runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false' }, clock: frozenClock, batchSize: 1, onlyApplicationId: target });

    // Only the target's page was ever opened.
    expect(visited).toEqual([`http://127.0.0.1:1/${target}`]);
    // Only the target moved through the status graph.
    expect(advances.map((a) => a.id)).toEqual([target, target]);
    // The non-target was released with the filter's reason, still untouched.
    expect(releases).toContainEqual({ id: otherA, reason: expect.stringMatching(/^APPLY_ONLY_ID: not the targeted application/) });
    // And nothing is left leased: tomorrow's run can still claim it.
    expect(leased.has(otherA)).toBe(false);
  });

  it('APPLY_ONLY_ID: run ends after the target is processed', async () => {
    // Without the stop, the loop would keep claiming (and holding) every other
    // approved row until the queue or the budget ran out.
    const { gateway, claimCount, releases } = queueGateway([target, otherA, otherB]);
    // Records every navigation.
    const { openPage, visited } = recordingPages();

    // Batch of one, so "ends here" is distinguishable from "the batch ended".
    const summary = await runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false' }, clock: frozenClock, batchSize: 1, onlyApplicationId: target });

    // One claim, one application: the rows behind it were never even claimed.
    expect(claimCount()).toBe(1);
    // Only the target was worked on.
    expect(visited).toEqual([`http://127.0.0.1:1/${target}`]);
    // Nothing else was ever leased, so nothing else needed releasing.
    expect(releases).toEqual([]);
    // The run says why it stopped.
    expect(summary.stoppedReason).toMatch(/processed; run ends here/);
    // And the target was actually sent (non-vacuity for "ended early").
    expect(summary.submitted).toBe(1);
  });

  it('APPLY_ONLY_ID: target never claimed → stoppedReason says so', async () => {
    // The target is not in the queue (not approved, or leased elsewhere). The
    // run must say so explicitly, or "nothing happened" reads as "queue empty".
    const { gateway, releases } = queueGateway([otherA]);
    // Records every navigation.
    const { openPage, visited } = recordingPages();

    // Live mode; the only claimable row is not the target.
    const summary = await runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false' }, clock: frozenClock, onlyApplicationId: target });

    // Nothing worked on at all.
    expect(visited).toEqual([]);
    expect(summary.claimed).toBe(0);
    // The reason names the miss.
    expect(summary.stoppedReason).toMatch(/was never claimed/);
    // The row it did claim was handed back.
    expect(releases.map((r) => r.id)).toEqual([otherA]);
  });

  it('parseOnlyApplicationId: rejects a non-UUID, accepts and lower-cases a UUID, undefined is unset', () => {
    // A typo read as "no filter" would turn a one-application run into a
    // whole-queue submit (§6's fail-open), so anything not UUID-shaped throws.
    expect(() => parseOnlyApplicationId('app-1')).toThrow(/must be an application UUID/);
    // A UUID with a trailing character is not a UUID.
    expect(() => parseOnlyApplicationId(`${target}x`)).toThrow();
    // Accepted, trimmed and lower-cased (Postgres prints uuids lower-case).
    expect(parseOnlyApplicationId(`  ${target.toUpperCase()} `)).toBe(target);
    // Only a truly absent variable means the whole queue.
    expect(parseOnlyApplicationId(undefined)).toBeUndefined();
  });

  it('parseOnlyApplicationId: blank is refused, not read as no filter', () => {
    // An Actions input that expanded to nothing was MEANT to name one
    // application. Reading it as "no filter" would turn a one-row run into a
    // whole-queue submit, so blank is an error, not an absence.
    expect(() => parseOnlyApplicationId('')).toThrow();
    // Whitespace-only is the same mistake with a stray space.
    expect(() => parseOnlyApplicationId('   ')).toThrow();
  });
});

describe('agent key enforcement', () => {
  it('agent key refused: claim error stops the run before any application is touched', async () => {
    // The agent key is enforced live: without a valid x-applyy-agent-key the
    // claim RPC raises 42501. That must end the run BEFORE any employer page is
    // opened or any row moves, since nothing was leased to us to move.
    const refusal = Object.assign(
      // The exact message shape the RPC raises.
      new Error('claim_applications requires a valid x-applyy-agent-key header (missing); refusing'),
      // The Postgres code, as supabase-js carries it.
      { code: '42501' },
    );
    // Every page open, which must stay at zero.
    const openPage = vi.fn(async () => stubPage());
    const { gateway, calls, closed } = fakeGateway({
      // Rejects like the live gateway does when the RPC refuses.
      claimApplications: async () => {
        // Recorded so the test can show the claim was reached at all.
        calls.push('claim');
        throw refusal;
      },
    });

    // Live mode, the case where a silent continue would matter most.
    await expect(
      runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false' }, clock: frozenClock }),
    ).rejects.toThrow(/x-applyy-agent-key/);

    // The claim was attempted (non-vacuity), and nothing came after it.
    expect(calls).toContain('claim');
    // No employer page was opened.
    expect(openPage).not.toHaveBeenCalled();
    // No row moved and no lease was touched.
    expect(calls.filter((c) => c.startsWith('advance:') || c === 'release')).toEqual([]);
    // The run row is still closed by the finally block.
    expect(calls).toContain('closeRun');
    // Recorded as a FAILED run naming the refusal. A throw outside the per-row
    // catch used to close as 'succeeded' with error_count 0, so the health page
    // showed a refused run as a clean success.
    expect(closed[0]).toMatchObject({
      status: 'failed',
      error_count: 1,
      rows_in: 0,
      error_detail: expect.stringMatching(/^run failed: .*x-applyy-agent-key/),
    });
  });
});
