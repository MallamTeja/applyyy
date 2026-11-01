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
import {
  // The cap parser, tested directly below.
  parseMaxSubmits,
  // The APPLY_ONLY_ID parser, tested directly below.
  parseOnlyApplicationId,
  // Renamed: the local runApplierBatch below wraps it with a default robots check.
  runApplierBatch as runApplierBatchRequired,
  // Its shape types the wrapper, so the wrapper cannot drift from the real input.
  type ClaimLoopInput,
  // The fake gateway's contract.
  type RunGateway,
} from '../src/claim-loop.ts';

// checkRobots is REQUIRED on the real loop. These tests are about claiming and pacing, so
// they default to "allow"; a robots test passes its own (the spread lets it win).
const runApplierBatch = (input: Omit<ClaimLoopInput, 'checkRobots'> & Partial<Pick<ClaimLoopInput, 'checkRobots'>>) =>
  // The default never touches the network: it answers allow without fetching.
  runApplierBatchRequired({ checkRobots: async () => ({ kind: 'allow', reason: 'test default', crawlDelayMs: null }), ...input });
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
      atsProvider: null; // Not a Workday row: the Workday guard stays out of the way.
    }>
  > = [
    [{ id: 'app-1', status: 'approved', applyUrl: 'http://127.0.0.1:1/a.html', tailoredProfile: null, employerName: null, atsProvider: null }],
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
    // W10's port. Default: no Settings cap and nothing sent, so only the per-run cap
    // applies and every older test keeps its meaning. Recorded so a dry run's skip shows.
    fetchDailyCap: async () => {
      // Ordering record, like every other call.
      calls.push('dailyCap');
      // No daily cap: the documented meaning of a null setting.
      return { maxPerDay: null, sentSince: 0 };
    },
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
    // Recorded like every other write, so a note appearing in an unexpected test shows in `calls`.
    appendApplicationNote: async () => {
      calls.push('note');
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
          atsProvider: null, // Not a Workday row: the Workday guard stays out of the way.
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
        { id: 'app-1', status: 'approved', applyUrl: 'http://127.0.0.1:1/a.html', tailoredProfile: null, employerName: null, atsProvider: null },
        { id: 'app-2', status: 'approved', applyUrl: 'http://127.0.0.1:1/a.html', tailoredProfile: null, employerName: null, atsProvider: null },
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
        return picked.map((id) => ({ id, status: 'approved' as const, applyUrl: `http://127.0.0.1:1/${id}`, tailoredProfile: null, employerName: null, atsProvider: null }));
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

/**
 * The per-run submit cap (APPLY_MAX_SUBMITS) and the live-run circuit breaker.
 *
 * Both bound the damage ONE unattended live run can do. The cap limits how many
 * real applications go out; the breaker stops the run at the first outcome that
 * would repeat for every row (an unconfirmed submit, a captcha), so one bad IP
 * cannot park the whole queue at needs_verification for Teja to hand-check.
 */
describe('submit cap and circuit breaker', () => {
  /** Ids app-1..app-n, oldest first, so the claim order is predictable. */
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `app-${i + 1}`);

  /**
   * A queue that behaves like the real claim RPC (oldest unleased first, release
   * unleases), recording releases and status writes BY ROW. Scripted batches would
   * hide the dry-run "released row comes straight back" behaviour test 4 relies on.
   */
  function capQueueGateway(queue: string[]) {
    // Rows currently leased to this run.
    const leased = new Set<string>();
    // Every release with its reason, to show unstarted rows were handed back.
    const releases: Array<{ id: string; reason: string }> = [];
    // Every status write by row, so an unprocessed row moving would be visible.
    const advances: Array<{ id: string; to: string }> = [];
    // Claim calls, bounded so a loop that never ends fails fast.
    let claims = 0;
    const { gateway, calls } = fakeGateway({
      claimApplications: async (_by, limit) => {
        // Recorded in `calls` too, so the startup test can assert it never ran.
        calls.push('claim');
        // Counted for the termination ceiling.
        claims += 1;
        // An unbounded claim loop is a failure mode, not a timeout.
        if (claims > 20) throw new Error('claim loop did not terminate');
        // FIFO over unleased rows, like `claimed_by is null order by created_at`.
        const picked = queue.filter((id) => !leased.has(id)).slice(0, limit);
        // Leased on hand-out, exactly as the RPC does.
        for (const id of picked) leased.add(id);
        // applyUrl names the row, so page navigations identify which row was worked on.
        return picked.map((id) => ({ id, status: 'approved' as const, applyUrl: `http://127.0.0.1:1/${id}`, tailoredProfile: null, employerName: null, atsProvider: null }));
      },
      // Per row, so the assertions can say WHICH rows moved.
      advanceStatus: async (id, to) => {
        // Only processed rows may appear here.
        advances.push({ id, to });
      },
      // Release unleases, so a released row is claimable again (the real behaviour).
      releaseClaim: async (id, reason) => {
        // Back in the pool.
        leased.delete(id);
        // With the reason, for the "not started" assertions.
        releases.push({ id, reason });
      },
    });
    // The gateway and its logs.
    return { gateway, calls, releases, advances, leased };
  }

  /**
   * A page opener whose submit result and blocker are scripted per opened page
   * (1-based), recording every URL navigated to.
   */
  function scriptedPages(script: {
    submit?: (n: number) => { kind: 'confirmed'; evidence: string } | { kind: 'unconfirmed'; detail: string };
    blocker?: (n: number) => 'captcha' | null;
    // True for a page whose navigation throws AFTER being recorded, modelling a crash mid-row.
    gotoThrows?: (n: number) => boolean;
  } = {}) {
    // Every navigation: the proof a row was (or was not) worked on.
    const visited: string[] = [];
    // How many pages have been opened, which is the page's script index.
    let opened = 0;
    const openPage = async () => {
      // This page's 1-based number, captured so its methods use their own slot.
      const n = ++opened;
      return {
        // Everything not scripted comes from the shared stub.
        ...stubPage(),
        // Recorded before anything else could fail.
        goto: async (url: string) => {
          visited.push(url);
          // Thrown after the push, so the visit is still on record for the assertions.
          if (script.gotoThrows?.(n)) throw new Error('boom');
        },
        // Scripted blocker; null (no blocker) unless the test says otherwise.
        detectBlocker: async () => script.blocker?.(n) ?? null,
        // Scripted result; confirmed unless the test says otherwise.
        submit: async () => script.submit?.(n) ?? ({ kind: 'confirmed', evidence: 'test' } as const),
      };
    };
    // The opener and its navigation log.
    return { openPage, visited };
  }

  /** The URL the queue gateway gives a row, for asserting navigations. */
  const url = (id: string) => `http://127.0.0.1:1/${id}`;

  it('submissions stop at APPLY_MAX_SUBMITS', async () => {
    // Five approved rows, a cap of two: the run must send two and stop claiming.
    const { gateway, releases, advances } = capQueueGateway(ids(5));
    // Every page confirms, so nothing but the cap can stop the run.
    const { openPage, visited } = scriptedPages();

    // Live, with an explicit cap below the queue length.
    const summary = await runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false', APPLY_MAX_SUBMITS: '2' }, clock: frozenClock });

    // Exactly the cap went out.
    expect(summary.submitted).toBe(2);
    // Only the first two employers' pages were ever opened.
    expect(visited).toEqual([url('app-1'), url('app-2')]);
    // The three rows behind them never moved through the status graph.
    expect(advances.filter((a) => !['app-1', 'app-2'].includes(a.id))).toEqual([]);
    // They were claimed in the same batch, so they are handed back untouched with the cap's reason.
    expect(releases).toEqual(
      ['app-3', 'app-4', 'app-5'].map((id) => ({ id, reason: expect.stringMatching(/^not started: APPLY_MAX_SUBMITS reached/) })),
    );
    // And the run says why it ended.
    expect(summary.stoppedReason).toMatch(/APPLY_MAX_SUBMITS reached/);
  });

  it('submissions stop at the default cap of 3 when APPLY_MAX_SUBMITS is absent', async () => {
    // Absent means the deliberate small default, never "unlimited".
    const { gateway } = capQueueGateway(ids(5));
    // Every page confirms.
    const { openPage, visited } = scriptedPages();

    // Live, no cap variable at all.
    const summary = await runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false' }, clock: frozenClock });

    // DEFAULT_MAX_SUBMITS, not the queue length.
    expect(summary.submitted).toBe(3);
    // Only three employers were visited.
    expect(visited).toHaveLength(3);
    // Stopped by the cap, not by draining the queue.
    expect(summary.stoppedReason).toMatch(/APPLY_MAX_SUBMITS reached/);
  });

  it('a blank or non-integer APPLY_MAX_SUBMITS throws at startup', async () => {
    // Every lenient reading of these is a cap nobody chose: Number('') is 0,
    // parseInt('3abc') is 3, Number('1e3') is a thousand (CLAUDE.md §6).
    for (const raw of ['', '  ', '0', '-1', '1.5', '1e3', 'abc', '3abc']) {
      // A fresh gateway per value, so each assertion sees only its own calls.
      const { gateway, calls } = capQueueGateway(ids(2));
      // Any page open would mean the run started; it must not.
      const openPage = vi.fn(async () => stubPage());

      // Rejects with the shape error, naming the variable.
      await expect(
        runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false', APPLY_MAX_SUBMITS: raw }, clock: frozenClock }),
      ).rejects.toThrow(/APPLY_MAX_SUBMITS must be a positive integer/);
      // Nothing opened: no run row, so no "failed" run for a config typo.
      expect(calls, `openRun for ${JSON.stringify(raw)}`).not.toContain('openRun');
      // Nothing claimed: no lease taken that would need releasing.
      expect(calls, `claim for ${JSON.stringify(raw)}`).not.toContain('claim');
      // And no employer page touched.
      expect(openPage).not.toHaveBeenCalled();
    }

    // Absent is the default.
    expect(parseMaxSubmits(undefined)).toBe(3);
    // A valid value with shell whitespace is accepted, trimmed.
    expect(parseMaxSubmits(' 4 ')).toBe(4);
  });

  it('the first unknown outcome stops further claims', async () => {
    // An unconfirmed submit is the outcome a low reCAPTCHA score produces on EVERY
    // row; continuing would park the whole queue at needs_verification.
    const { gateway, releases, advances } = capQueueGateway(ids(3));
    // The first page's submit comes back without proof.
    const { openPage, visited } = scriptedPages({
      submit: (n) => (n === 1 ? { kind: 'unconfirmed', detail: 'no confirmation text' } : { kind: 'confirmed', evidence: 'test' }),
    });

    // Live, with a cap high enough that only the breaker can stop it.
    const summary = await runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false', APPLY_MAX_SUBMITS: '10' }, clock: frozenClock });

    // The one unknown outcome is counted, and nothing was confirmed sent.
    expect(summary.outcomeUnknown).toBe(1);
    expect(summary.submitted).toBe(0);
    // Only the first employer was visited.
    expect(visited).toEqual([url('app-1')]);
    // The other two never moved.
    expect(advances.filter((a) => a.id !== 'app-1')).toEqual([]);
    // They were released untouched, with the breaker's reason.
    expect(releases).toEqual(
      ['app-2', 'app-3'].map((id) => ({ id, reason: expect.stringMatching(/^not started: circuit breaker/) })),
    );
    // And the run says the breaker ended it.
    expect(summary.stoppedReason).toMatch(/circuit breaker/);
  });

  it('an unknown outcome names its cause in the run row error_detail', async () => {
    // THE GITLAB CASE. An unknown outcome counts no error, so error_detail used to stay
    // null and the cause (the POST's response code) reached only the CI log. The run row
    // is the one DB field the health page already reads, so the breaker reason lands there.
    const { gateway } = capQueueGateway(ids(1));
    // Every closeRun update, to read what the run row records.
    const closed: Array<Record<string, unknown>> = [];
    gateway.closeRun = async (_id, update) => {
      closed.push(update);
    };
    // A refused POST, described as submit() now describes it.
    const { openPage } = scriptedPages({
      submit: () => ({ kind: 'unconfirmed', detail: 'no confirmation within 45000ms; responses: 422 https://boards.greenhouse.io/gitlab/jobs/1 code=captcha-failed' }),
    });

    await runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false', APPLY_MAX_SUBMITS: '10' }, clock: frozenClock });

    // Still not an error, so the run's status is unchanged.
    expect(closed[0]).toMatchObject({ status: 'succeeded', error_count: 0 });
    // But the cause is on the row, with the board's own code.
    expect(closed[0]?.['error_detail']).toEqual(expect.stringMatching(/circuit breaker: submit outcome unknown.*code=captcha-failed/));
  });

  it('an unknown outcome appends exactly one note to THAT application, carrying the cause and the run id', async () => {
    // THE ROW-SCOPED CAUSE (2026-10-24). The run row's error_detail names the cause, but a human checking
    // a needs_verification row reads the ROW; a free-text join from run to row is a guess. So the loop
    // appends one application_events note for the row itself, which the queue reads by application_id.
    const { gateway } = capQueueGateway(ids(1));
    // Every note appended, with the row it was appended to.
    const notes: Array<{ id: string; detail: Record<string, unknown> }> = [];
    // Recorded, not stubbed, so "exactly one" is an assertion.
    gateway.appendApplicationNote = async (id, detail) => {
      // One entry per append.
      notes.push({ id, detail });
    };
    // The GitLab-shaped refusal, as submit() describes it.
    const { openPage } = scriptedPages({
      submit: () => ({ kind: 'unconfirmed', detail: 'no confirmation within 45000ms; responses: 422 https://boards.greenhouse.io/gitlab/jobs/1 code=captcha-failed' }),
    });

    // Live, so the submit actually happens.
    await runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false', APPLY_MAX_SUBMITS: '10' }, clock: frozenClock });

    // Exactly one note, on app-1, with the closed shape the queue validates and the run that wrote it.
    expect(notes).toEqual([
      { id: 'app-1', detail: { kind: 'submit_outcome_unknown', detail: expect.stringMatching(/code=captcha-failed/), run_id: 'run-1' } },
    ]);
  });

  it('a failed note insert leaves the outcome unknown and the run going', async () => {
    // The note is diagnosis, not state: if it cannot be written, the row must stay exactly the unknown
    // it is (swept to needs_verification later), and the run must close as it would have.
    const { gateway } = capQueueGateway(ids(1));
    // Every closeRun update, to read the run row's final state.
    const closed: Array<Record<string, unknown>> = [];
    // Captured the same way as the error_detail test above.
    gateway.closeRun = async (_id, update) => {
      // The run row's update.
      closed.push(update);
    };
    // The real gateway throws on a supabase {error}; this is that throw.
    gateway.appendApplicationNote = async () => {
      // An RLS refusal, the realistic failure.
      throw new Error('appendApplicationNote failed: new row violates row-level security policy');
    };
    // Same refused submit.
    const { openPage } = scriptedPages({
      submit: () => ({ kind: 'unconfirmed', detail: 'responses: 422 https://boards.greenhouse.io/gitlab/jobs/1 code=captcha-failed' }),
    });

    // Must not throw.
    const summary = await runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false', APPLY_MAX_SUBMITS: '10' }, clock: frozenClock });

    // Still one unknown, never an error and never a submit.
    expect(summary).toMatchObject({ outcomeUnknown: 1, errors: 0, submitted: 0 });
    // The run row closes as a succeeded run with the breaker's cause, exactly as without the note.
    expect(closed[0]).toMatchObject({ status: 'succeeded', error_count: 0 });
    // The cause still reaches the run row.
    expect(closed[0]?.['error_detail']).toEqual(expect.stringMatching(/submit outcome unknown.*code=captcha-failed/));
  });

  it('a confirmed submit appends no note', async () => {
    // Non-vacuity: the note is for unknown outcomes only, not every submit.
    const { gateway } = capQueueGateway(ids(1));
    // Any note at all would fail this test.
    const notes: string[] = [];
    // Recorded.
    gateway.appendApplicationNote = async (id) => {
      // Should never run.
      notes.push(id);
    };
    // A proven send.
    const { openPage } = scriptedPages({ submit: () => ({ kind: 'confirmed', evidence: 'test' }) });

    // Live.
    await runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false', APPLY_MAX_SUBMITS: '10' }, clock: frozenClock });

    // Nothing appended.
    expect(notes).toEqual([]);
  });

  it('a clean live run leaves error_detail null', async () => {
    // Non-vacuity for the test above: the field is not filled on every run.
    const { gateway } = capQueueGateway(ids(1));
    const closed: Array<Record<string, unknown>> = [];
    gateway.closeRun = async (_id, update) => {
      closed.push(update);
    };
    const { openPage } = scriptedPages({ submit: () => ({ kind: 'confirmed', evidence: 'test' }) });

    await runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false', APPLY_MAX_SUBMITS: '10' }, clock: frozenClock });

    expect(closed[0]).toMatchObject({ status: 'succeeded', error_detail: null });
  });

  it('a captcha stops further claims in a live run', async () => {
    // A captcha on one form means the next form on this IP will very likely challenge too.
    const { gateway, releases } = capQueueGateway(ids(3));
    // A captcha wall on the first page only.
    const { openPage, visited } = scriptedPages({ blocker: (n) => (n === 1 ? 'captcha' : null) });

    // Live, cap well above the queue.
    const summary = await runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false', APPLY_MAX_SUBMITS: '10' }, clock: frozenClock });

    // The captcha row was blocked, and nothing else was attempted.
    expect(summary.blocked).toBe(1);
    expect(summary.submitted).toBe(0);
    // Only the first employer was visited.
    expect(visited).toEqual([url('app-1')]);
    // The rest were handed back untouched.
    expect(releases.map((r) => r.id)).toEqual(['app-2', 'app-3']);
    // The breaker is named as the reason.
    expect(summary.stoppedReason).toMatch(/circuit breaker/);
  });

  it('a dry run ignores the breaker', async () => {
    // A dry run sends nothing, so neither the cap nor the breaker has anything to protect.
    const { gateway, leased } = capQueueGateway(ids(3));
    // Captcha on every page: in a live run this would trip the breaker on row one.
    const { openPage, visited } = scriptedPages({ blocker: () => 'captcha' });

    // Dry (no DRY_RUN=false), and a cap of 1 to prove a dry run is not capped either.
    const summary = await runApplierBatch({ gateway, openPage, renderResume, env: { APPLY_MAX_SUBMITS: '1' }, clock: frozenClock });

    // All three rows were worked through.
    expect(summary.dryRun).toBe(3);
    // Each employer's page was visited exactly once.
    expect(visited).toEqual(ids(3).map(url));
    // Neither stop mechanism fired.
    expect(summary.stoppedReason).not.toMatch(/circuit breaker/);
    expect(summary.stoppedReason).not.toMatch(/APPLY_MAX_SUBMITS/);
    // And every row was handed back, still approved.
    expect(leased.size).toBe(0);
  });

  it('a thrown error stops further claims in a live run', async () => {
    // A throw in a live run may have happened anywhere, the click included; the next
    // row would most likely hit the same fault, so the run must stop, not press on.
    const { gateway, releases, advances } = capQueueGateway(ids(3));
    // The first page crashes on navigation.
    const { openPage, visited } = scriptedPages({ gotoThrows: (n) => n === 1 });

    // Live, cap well above the queue, so only the breaker can stop it.
    const summary = await runApplierBatch({ gateway, openPage, renderResume, env: { DRY_RUN: 'false', APPLY_MAX_SUBMITS: '10' }, clock: frozenClock });

    // The one error is counted.
    expect(summary.errors).toBe(1);
    // Only the first employer was visited.
    expect(visited).toEqual([url('app-1')]);
    // The other two never moved through the status graph.
    expect(advances.filter((a) => a.id !== 'app-1')).toEqual([]);
    // They were released untouched, with the breaker's reason.
    expect(releases).toEqual(
      ['app-2', 'app-3'].map((id) => ({ id, reason: expect.stringMatching(/^not started: circuit breaker/) })),
    );
    // The run names the error as the reason it ended.
    expect(summary.stoppedReason).toMatch(/circuit breaker: error on/);
  });

  it('a thrown error in a dry run does not stop the run', async () => {
    // A dry run sends nothing, so one broken page must not cost the rest of the trust-period log.
    const { gateway } = capQueueGateway(ids(3));
    // The same crash on the first page.
    const { openPage, visited } = scriptedPages({ gotoThrows: (n) => n === 1 });

    // Dry: no DRY_RUN=false.
    const summary = await runApplierBatch({ gateway, openPage, renderResume, env: {}, clock: frozenClock });

    // Every employer was still visited.
    expect(visited).toEqual(ids(3).map(url));
    // One error, and the other two completed as dry runs.
    expect(summary.errors).toBe(1);
    expect(summary.dryRun).toBe(2);
    // The breaker did not fire.
    expect(summary.stoppedReason).not.toMatch(/circuit breaker/);
  });
});

// W4 (docs/audit/2026-11-01-wiring-audit.md): the gateway used to RELEASE a claimed row with
// no apply_url or a disappeared posting and drop it from the batch. claim_applications orders
// by created_at, so five such rows at the head of the queue came back on every claim, every
// claim then looked empty, and the run reported "queue drained" while newer rows waited.
describe('runApplierBatch — unusable rows at the head of the queue (W4)', () => {
  /**
   * A gateway whose claim behaves like the real RPC: the oldest `approved` rows that nobody
   * currently leases, up to `limit`. Stateful on purpose, because the bug is about which
   * rows come back on the NEXT claim, which a scripted list of batches cannot show.
   */
  function queueGateway(unusableIds: readonly string[], usableIds: readonly string[]) {
    // Oldest first, unusable rows at the head: exactly the audit's scenario.
    const queue = [
      // Each unusable row stands for a job with no apply_url.
      ...unusableIds.map((id) => ({ id, unusable: true })),
      // The newer rows that must still be reached.
      ...usableIds.map((id) => ({ id, unusable: false })),
    ];
    // Ids whose lease this run holds; a leased row is skipped by the claim.
    const leased = new Set<string>();
    // Current status per row; only `approved` rows are claimable.
    const status = new Map<string, string>(queue.map((row) => [row.id, 'approved']));
    // Every status write, with its detail, so the park reason can be asserted.
    const advances: Array<{ id: string; to: string; detail: Record<string, unknown> | undefined }> = [];
    // Every release, with its reason.
    const releases: Array<{ id: string; reason: string }> = [];
    // The shared fake for every other port.
    const { gateway, closed } = fakeGateway({
      // The RPC's ordering and lease rules, over the queue above.
      claimApplications: async (_claimedBy, limit) => {
        // Oldest approved, unleased rows first, at most `limit` of them.
        const picked = queue.filter((row) => status.get(row.id) === 'approved' && !leased.has(row.id)).slice(0, limit);
        // Claiming leases them.
        for (const row of picked) leased.add(row.id);
        // Unusable rows come back NAMED, which is the gateway half of the fix.
        return picked.map((row) =>
          row.unusable
            ? { id: row.id, unusable: 'no_apply_url' as const, reason: `no apply_url on job job-${row.id}; not attempted` }
            : { id: row.id, status: 'approved' as const, applyUrl: 'http://127.0.0.1:1/a.html', tailoredProfile: null, employerName: null, atsProvider: null },
        );
      },
      // A status write moves the row out of `approved` and ends the lease, as the RPC does.
      advanceStatus: async (id, to, _agent, detail) => {
        // Recorded for the assertions.
        advances.push({ id, to, detail });
        // The row is no longer claimable unless it is still approved.
        status.set(id, to);
        // The RPC clears the claim on a transition.
        leased.delete(id);
      },
      // A release hands the row back at `approved`, claimable again.
      releaseClaim: async (id, reason) => {
        // Recorded for the assertions.
        releases.push({ id, reason });
        // Claimable again by the next claim.
        leased.delete(id);
      },
    });
    // Everything a test asserts on.
    return { gateway, closed, advances, releases };
  }

  // The five unusable rows: one full batch (batch size 5).
  const unusable = ['app-u1', 'app-u2', 'app-u3', 'app-u4', 'app-u5'];

  it('W4 live: five unusable rows at the head are parked and the newer usable row is still submitted', async () => {
    // Five dead rows ahead of one good one.
    const { gateway, advances } = queueGateway(unusable, ['app-6']);

    // A live run with the default batch of 5.
    const summary = await runApplierBatch({ gateway, openPage: async () => stubPage(), env: { DRY_RUN: 'false' }, clock: frozenClock, renderResume, batchSize: 5 });

    // THE starvation assertion: the newer row was reached and submitted.
    expect(advances.filter((advance) => advance.id === 'app-6').map((advance) => advance.to)).toEqual(['applying', 'applied']);
    // Each unusable row is parked for a human, in one write, straight from approved.
    expect(advances.filter((advance) => advance.id !== 'app-6').map((advance) => [advance.id, advance.to])).toEqual(
      // In claim order.
      unusable.map((id) => [id, 'blocked_needs_human']),
    );
    // With a legal row-level reason and the machine-readable cause beside it.
    expect(advances[0]?.detail).toMatchObject({ block_reason: 'other', unusable: 'no_apply_url' });
    // Counted: one sent, five parked.
    expect(summary).toMatchObject({ submitted: 1, blocked: 5 });
  });

  it('W4 dry: unusable rows are held (never advanced), released once at run end, and the newer row is still reached', async () => {
    // The same queue.
    const { gateway, advances, releases } = queueGateway(unusable, ['app-6']);

    // A dry run.
    const summary = await runApplierBatch({ gateway, openPage: async () => stubPage(), env: {}, clock: frozenClock, renderResume, batchSize: 5 });

    // A dry run writes no status, unusable rows included.
    expect(advances).toEqual([]);
    // The newer row was reached and dry-run filled.
    expect(summary.dryRun).toBe(1);
    // Each unusable row released exactly once, named as a dry run, with the cause.
    for (const id of unusable) {
      // Exactly one release per unusable row: held, not released on sight.
      expect(releases.filter((release) => release.id === id).map((release) => release.reason)).toEqual([
        // The gateway's reason, under the dry-run prefix every dry release carries.
        `dry_run: no apply_url on job job-${id}; not attempted`,
      ]);
    }
    // The loop ended on an empty claim, not on a gate.
    expect(summary.stoppedReason).toBe('queue drained');
  });
});

// W10 (docs/audit/2026-11-01-wiring-audit.md): Settings writes
// system_settings.max_applications_per_day and nothing read it, so "Daily Application Cap = 1"
// still let a run submit up to APPLY_MAX_SUBMITS (3). The loop now reads it before claiming.
describe('runApplierBatch — the Settings daily cap (W10)', () => {
  /** Three workable rows, then an empty claim; enough to exceed any cap below 3. */
  function threeRowGateway(fetchDailyCap: RunGateway['fetchDailyCap']) {
    // One claimable row per id.
    const row = (id: string) => ({ id, status: 'approved' as const, applyUrl: 'http://127.0.0.1:1/a.html', tailoredProfile: null, employerName: null, atsProvider: null });
    // Batches served in order; the trailing [] ends the run.
    const batches = [[row('app-1'), row('app-2'), row('app-3')], []];
    // The shared fake, with the claim and the cap under test overridden.
    return fakeGateway({
      // Serves the batches above, recording the call so "claimed nothing" is assertable.
      claimApplications: async () => batches.shift() ?? [],
      // The cap under test.
      fetchDailyCap,
    });
  }

  it('W10: a daily cap of 1 with nothing sent in 24 h stops a live run after ONE submit, below APPLY_MAX_SUBMITS', async () => {
    // Settings says 1 a day; nothing has gone out in the window.
    const { gateway, calls } = threeRowGateway(async () => ({ maxPerDay: 1, sentSince: 0 }));

    // Live, with the default per-run cap of 3.
    const summary = await runApplierBatch({ gateway, openPage: async () => stubPage(), env: { DRY_RUN: 'false' }, clock: frozenClock, renderResume });

    // THE assertion: the Settings cap, not the per-run cap, decided.
    expect(summary.submitted).toBe(1);
    // Exactly one row entered `applying`.
    expect(calls.filter((call) => call === 'advance:applying')).toHaveLength(1);
    // The stop names the Settings cap, so the run log says which limit ended it.
    expect(summary.stoppedReason).toMatch(/max_applications_per_day/);
  });

  it('W10: a submit the form refuses in THIS run costs no daily-cap slot, the rule sentSince follows', async () => {
    // Code-review finding #10, run side: cap 1, nothing sent in the window.
    const { gateway } = threeRowGateway(async () => ({ maxPerDay: 1, sentSince: 0 }));
    // Pages handed out so far, so only the FIRST row's form refuses.
    let opened = 0;

    // Live run: the first form rejects the click (applying -> blocked_needs_human, nothing
    // sent, no breaker); the second confirms.
    const summary = await runApplierBatch({
      gateway,
      // Counts each page, so the refusal lands on the first row only.
      openPage: async () => (++opened === 1 ? { ...stubPage(), submit: async () => ({ kind: 'rejected_by_form', labels: ['Email'] }) as const } : stubPage()),
      // Live, so the cap applies.
      env: { DRY_RUN: 'false' },
      // Fixed time, as every W10 test.
      clock: frozenClock,
      // The shared renderer stub.
      renderResume,
    });

    // The refused row parked for a human.
    expect(summary.blocked).toBe(1);
    // THE assertion: the one cap slot went to a real send, not to the refusal.
    expect(summary.submitted).toBe(1);
    // And the cap, not the queue, ended the run.
    expect(summary.stoppedReason).toMatch(/max_applications_per_day/);
  });

  it('W10: a cap already used up in the last 24 h claims nothing at all', async () => {
    // Settings says 2 a day and 2 went out in the window.
    const { gateway, calls } = threeRowGateway(async () => ({ maxPerDay: 2, sentSince: 2 }));

    // Live run.
    const summary = await runApplierBatch({ gateway, openPage: async () => stubPage(), env: { DRY_RUN: 'false' }, clock: frozenClock, renderResume });

    // Nothing sent.
    expect(summary.submitted).toBe(0);
    // Nothing claimed, so nothing has to be handed back.
    expect(calls).not.toContain('claim');
    // Said out loud.
    expect(summary.stoppedReason).toMatch(/max_applications_per_day/);
  });

  it('W10: an unreadable cap fails CLOSED: nothing claimed, run closed failed naming the cause', async () => {
    // The gateway could not read or validate the setting.
    const { gateway, calls, closed } = threeRowGateway(async () => {
      // What the gateway throws on an {error} or a malformed value.
      throw new Error('fetchDailyCap: max_applications_per_day unreadable');
    });

    // A live run must not fall back to "no daily cap".
    await expect(
      // The run itself.
      runApplierBatch({ gateway, openPage: async () => stubPage(), env: { DRY_RUN: 'false' }, clock: frozenClock, renderResume }),
    ).rejects.toThrow(/max_applications_per_day/);
    // Nothing claimed.
    expect(calls).not.toContain('claim');
    // The run row says failed, with the cause, so the health page shows it.
    expect(closed[0]).toMatchObject({ status: 'failed', error_detail: expect.stringMatching(/max_applications_per_day/) });
  });

  it('W10: the window is the trailing 24 h from the injected clock (timezone-free)', async () => {
    // Every window start the loop asks about.
    const asked: string[] = [];
    // Records the argument and imposes no cap.
    const { gateway } = threeRowGateway(async (sinceIso) => {
      // Recorded for the assertion.
      asked.push(sinceIso);
      // No cap, so the run proceeds normally.
      return { maxPerDay: null, sentSince: 0 };
    });

    // Live run.
    await runApplierBatch({ gateway, openPage: async () => stubPage(), env: { DRY_RUN: 'false' }, clock: frozenClock, renderResume });

    // Exactly 86 400 s before the frozen clock, read once per run.
    expect(asked).toEqual([new Date((1_000_000 - 86_400) * 1000).toISOString()]);
  });

  it('W10: a dry run never reads the cap, so a settings outage cannot stop a trust-period run', async () => {
    // A cap read that would fail if it were called.
    const { gateway, calls } = threeRowGateway(async () => {
      // Never reached in a dry run.
      throw new Error('should not be read in a dry run');
    });

    // Dry run.
    const summary = await runApplierBatch({ gateway, openPage: async () => stubPage(), env: {}, clock: frozenClock, renderResume });

    // All three rows were dry-run filled.
    expect(summary.dryRun).toBe(3);
    // And the cap was not read.
    expect(calls).not.toContain('dailyCap');
  });
});
