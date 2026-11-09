// The robots.txt gate in front of the applier: applyToOne asks before page.goto, and
// the claim loop counts the answer.
//
// WHY THESE TESTS GO THROUGH THE REAL GATE. A fake verdict proves only that applyToOne
// reads `kind`; it says nothing about whether a soft-200 HTML page, a 403 or a thrown
// fetch actually BECOMES a refusal. So most cases below build master-robots' real
// checkRobots over a fake FETCHER, the one seam that touches the network. The fetcher
// behaves like real fetch: it resolves with a status, headers and a body for every HTTP
// answer, and it THROWS (rejects) on a transport failure, exactly as fetch does on DNS
// failure or a reset. A fetcher that returned `{ status: 0 }` instead would exercise a
// code path production never takes.
//
// WHAT "PARKED" MUST MEAN, asserted in full every time: ONE status write to
// blocked_needs_human carrying block_reason=robots_refused and the gate's source, goto
// never called, submit never called. Checking only the status would pass on code that
// opened the page first, which is the exact request robots.txt governs.
import { describe, expect, it, vi } from 'vitest';
import {
  // The function under test, with its REQUIRED checkRobots port.
  applyToOne as applyToOneRaw,
  // The applier's product token; asserted below so a rename cannot silently change identity.
  APPLIER_ROBOTS_TOKEN,
  type ApplicationPage,
  type ApplierGateway,
  type ClaimedApplication,
  type ResumeRenderer,
  type RobotsCheck,
  type SubmitResult,
} from '../src/apply-one.ts';
// Every live test hands in an open re-check config (B2 fails closed without one).
import { OPEN_RECHECK, loadOpenPreGatePreferences } from './open-pregate.ts';
// applyToOne with an open re-check config by default; a test can still pass its own.
const applyToOne = (input: Parameters<typeof applyToOneRaw>[0]) => applyToOneRaw({ recheck: OPEN_RECHECK, ...input });
// The loop, for the counting and breaker tests, plus the pure dry-run line formatter.
import { formatDryRunLine, runApplierBatch, type RunGateway } from '../src/claim-loop.ts';
// The REAL gate, by relative path exactly as apply-one.ts imports it, so no install is needed.
import { checkRobots, type RobotsFetcher, type RobotsResponse } from '../../packages/master-robots/src/index.ts';
// The planner reads the answer bank; only the row type is needed here.
import type { AnswerBankRow } from '@applyy/shared-types';
// The form field type, so the stub forms below are checked against the real shape.
import type { FormField } from '../src/extract-fields.ts';

// A real Greenhouse job URL shape, so the gate derives a realistic origin and path.
const APPLY_URL = 'https://job-boards.greenhouse.io/gitlab/jobs/8775507002';
// What the gate must fetch for that URL: the ORIGIN's robots.txt, never the path's.
const ROBOTS_URL = 'https://job-boards.greenhouse.io/robots.txt';

// The live opt-in: resolveSubmissionMode submits only on this exact string.
const LIVE_ENV = { DRY_RUN: 'false' } as const;
// Unset DRY_RUN is the realistic dry run (a fresh runner, a missing secret).
const DRY_ENV = {} as const;

/** One field the bank answers, so a test only blocks when it means to. */
// The optional Email field: every real form asks for one, and the form-shape gate (no_email_field, 2026-11-09)
// refuses a page without it. Optional, so the planner never blocks on it.
const answerableForm: FormField[] = [{ id: 'first_name', label: 'First Name', kind: 'text', required: true }, { id: 'email', label: 'Email', kind: 'email', required: false }];

/** The matching bank row. Real rows carry more columns; the planner reads these four. */
const answers = [
  { question_key: 'first_name', answer_value: 'Teja', needs_human: false, answer_type: 'text' },
] as unknown as AnswerBankRow[];

/** The claimed row. No tailored profile: the stub form asks for no document. */
const row: ClaimedApplication = {
  id: 'app-1',
  status: 'approved',
  applyUrl: APPLY_URL,
  tailoredProfile: null,
  employerName: 'GitLab',
  atsProvider: null, // Not a Workday row: the Workday guard stays out of the way.
};

/**
 * A fake page with goto and submit as spies.
 *
 * goto is spied, not just submit, because the gate's whole promise is that the page is
 * never OPENED on a refusal; a test that watched only submit would pass on code that
 * fetched the apply page and then stopped.
 */
function fakePage(overrides: Partial<ApplicationPage> = {}) {
  // The request robots.txt governs. Must stay uncalled on every non-allow verdict.
  const goto = vi.fn(async (_url: string) => {});
  // The irreversible operation. Confirmed by default, the only result that may become `applied`.
  const submit = vi.fn(async (): Promise<SubmitResult> => ({ kind: 'confirmed', evidence: 'test' }));
  // The port, with harmless defaults for everything the gate tests do not care about.
  const page: ApplicationPage & { close(): Promise<void> } = {
    goto,
    extractFields: async () => answerableForm,
    fill: async () => {},
    attachFile: async () => {},
    screenshot: async () => new Uint8Array([1, 2, 3]),
    // No captcha, so an allow verdict runs all the way to submit.
    detectBlocker: async () => null,
    submit,
    // True, so LIVE_ENV really is live (the effective mode narrows on a page that cannot send).
    submissionImplemented: true,
    // Present for the claim loop, which closes every page it opens.
    close: async () => {},
    ...overrides,
  };
  return { page, goto, submit };
}

/**
 * A gateway whose two row-moving operations are spies.
 *
 * advanceStatus is a vi.fn so a test can read the DETAIL passed with the park, not just
 * the target status: block_reason and robots_source are what the dashboard filters on.
 */
function fakeGateway() {
  // (id, to, agent, detail): the StatusWriter signature guardedAdvance calls.
  const advanceStatus = vi.fn(async (_id: string, _to: string, _agent: string, _detail?: Record<string, unknown>) => {});
  // (id, reason): hands the row back untouched at `approved`.
  const releaseClaim = vi.fn(async (_id: string, _reason: string) => {});
  // The full port; uploads and the evidence write are only reached on an allow.
  const gateway: ApplierGateway = {
    advanceStatus,
    releaseClaim,
    uploadScreenshot: async () => 'screens/app-1.png',
    uploadResume: async () => 'resumes/app-1.pdf',
    setArtifactPaths: async () => {},
  };
  return { gateway, advanceStatus, releaseClaim };
}

/**
 * A renderer that throws if anything calls it.
 *
 * Hostile rather than a no-op: no form here has a file input, so a render would mean the
 * applier started producing PDFs it cannot use, and fake bytes would hide that.
 */
const renderResume: ResumeRenderer = async () => {
  // Loud, so an unexpected render fails the test that caused it.
  throw new Error('renderResume must not be called in robots tests');
};

/**
 * A fetcher that answers every request the same way, mirroring gate.test.ts.
 *
 * Records every call so a test can assert WHICH URL was asked and under WHICH token.
 */
function respondWith(status: number, body = '', headers: Record<string, string> = { 'content-type': 'text/plain' }) {
  // Every (url, user-agent) the gate fetched with, in order.
  const calls: Array<{ url: string; userAgent: string | undefined }> = [];
  // The RobotsFetcher shape: (url, { signal, headers }) => RobotsResponse.
  const fetcher: RobotsFetcher = async (url, init) => {
    // Recorded before answering, so even a later throw would leave the evidence.
    calls.push({ url, userAgent: init.headers['user-agent'] });
    // A real-fetch-shaped response: status, case-insensitive headers, a one-shot body.
    const response: RobotsResponse = {
      status,
      // Lower-cased lookup, because header names are case-insensitive in real fetch too.
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      // Fresh each call, like a real body stream.
      text: async () => body,
    };
    return response;
  };
  return { fetcher, calls };
}

/** The production wiring, minus the network: the real gate under the applier's token. */
function realGate(fetcher: RobotsFetcher): RobotsCheck {
  // No cache: each test is one fetch, and a shared cache would leak verdicts across tests.
  return (url) => checkRobots(url, APPLIER_ROBOTS_TOKEN, { fetcher });
}

/**
 * Run one live application through the real gate and assert it PARKED.
 *
 * One helper for every park case, so "parked" cannot quietly mean less in one test than
 * in another: all four conditions are checked every time.
 */
async function expectParked(fetcher: RobotsFetcher, expectedSource: string) {
  // A page that WOULD submit, so a missing gate would show up as a submit call.
  const { page, goto, submit } = fakePage();
  // Spies on both row-moving operations.
  const { gateway, advanceStatus, releaseClaim } = fakeGateway();

  // Live: only a live refusal parks; a dry one releases (tested separately).
  const outcome = await applyToOne({ row, page, gateway, answers, env: LIVE_ENV, renderResume, checkRobots: realGate(fetcher) });

  // The outcome says parked, not released and not submitted.
  expect(outcome).toMatchObject({ kind: 'robots_refused', action: 'parked' });
  // Exactly ONE status write: approved -> blocked_needs_human, no `applying` first.
  expect(advanceStatus).toHaveBeenCalledTimes(1);
  // Destructured so the detail can be checked field by field.
  const [id, to, agent, detail] = advanceStatus.mock.calls[0]!;
  // The claimed row, not some other id.
  expect(id).toBe('app-1');
  // The human lane: a person can apply by hand.
  expect(to).toBe('blocked_needs_human');
  // The applier names itself, so the transition graph can check the edge.
  expect(agent).toBe('applier');
  // The dashboard's reason code (migration 20261009233000) and the gate's machine fact.
  expect(detail).toMatchObject({ block_reason: 'robots_refused', robots_source: expectedSource, screenshot_storage_path: null });
  // A park is not also a release: the row is moved, not handed back.
  expect(releaseClaim).not.toHaveBeenCalled();
  // THE point of the gate: the apply page was never requested.
  expect(goto).not.toHaveBeenCalled();
  // And nothing was sent.
  expect(submit).not.toHaveBeenCalled();
}

/**
 * Run one LIVE application through the real gate and assert it was RELEASED, not parked.
 *
 * For outages (indeterminate): live, a page that would submit, yet no goto, no submit and
 * no status write, only one releaseClaim whose reason names the gate's source.
 */
async function expectReleasedLive(fetcher: RobotsFetcher, expectedSource: string) {
  // A page that WOULD submit, so a missing gate would show up as a submit call.
  const { page, goto, submit } = fakePage();
  // Spies on both row-moving operations.
  const { gateway, advanceStatus, releaseClaim } = fakeGateway();

  // Live, so the park branch is reachable; the release must be by choice, not by dry run.
  const outcome = await applyToOne({ row, page, gateway, answers, env: LIVE_ENV, renderResume, checkRobots: realGate(fetcher) });

  // The outcome says released.
  expect(outcome).toMatchObject({ kind: 'robots_refused', action: 'released' });
  // No park: an outage must not become a manual task.
  expect(advanceStatus).not.toHaveBeenCalled();
  // Handed back exactly once, for this row.
  expect(releaseClaim).toHaveBeenCalledTimes(1);
  // Destructured so the id and reason can be checked separately.
  const [id, reason] = releaseClaim.mock.calls[0]!;
  // The claimed row.
  expect(id).toBe('app-1');
  // The reason names the gate's source, so the event log says WHY it was handed back.
  expect(reason).toContain(`(${expectedSource})`);
  // Never opened.
  expect(goto).not.toHaveBeenCalled();
  // Never sent.
  expect(submit).not.toHaveBeenCalled();
}

describe('applyToOne robots gate', () => {
  it('the robots check is asked about the exact apply URL with the applier token', async () => {
    // The token is the RFC 9309 identity sites write groups for. A rename here changes
    // which group every host's robots.txt applies to us, so it is pinned.
    expect(APPLIER_ROBOTS_TOKEN).toBe('applyy-applier');
    // A recording check: the url applyToOne passed, verbatim.
    const asked: string[] = [];
    // Allows, so the run proceeds normally and the recording is the only assertion.
    const check: RobotsCheck = async (url) => {
      // Recorded before answering.
      asked.push(url);
      return { kind: 'allow', reason: 'test', crawlDelayMs: null };
    };
    // Default page and gateway; only the question asked matters here.
    const { page } = fakePage();
    const { gateway } = fakeGateway();

    await applyToOne({ row, page, gateway, answers, env: DRY_ENV, renderResume, checkRobots: check });

    // The full apply URL, path included, since the gate matches rules against the path.
    expect(asked).toEqual([APPLY_URL]);

    // And end to end: the real gate fetches the ORIGIN's robots.txt with the applier token
    // as its user-agent, so the host sees the same identity its groups are written for.
    const { fetcher, calls } = respondWith(404);
    await realGate(fetcher)(APPLY_URL);
    // One fetch, of origin + /robots.txt, under applyy-applier.
    expect(calls).toEqual([{ url: ROBOTS_URL, userAgent: 'applyy-applier' }]);
  });

  it('robots allow lets goto run and submit proceeds', async () => {
    // NON-VACUITY GUARD for every refusal test below: the same wiring DOES open and submit
    // when robots.txt permits, so "goto not called" elsewhere is the gate, not a dead path.
    const { fetcher, calls } = respondWith(200, 'User-agent: *\nAllow: /\n');
    const { page, goto, submit } = fakePage();
    const { gateway, advanceStatus } = fakeGateway();

    const outcome = await applyToOne({ row, page, gateway, answers, env: LIVE_ENV, renderResume, checkRobots: realGate(fetcher) });

    // The real gate was actually consulted (a fetch happened).
    expect(calls).toHaveLength(1);
    // The page was opened at the apply URL.
    expect(goto).toHaveBeenCalledWith(APPLY_URL);
    // And the submit ran, through the normal applying -> applied path.
    expect(submit).toHaveBeenCalledTimes(1);
    // Status path proves it was the real submit branch, not a robots park.
    expect(advanceStatus.mock.calls.map((call) => call[1])).toEqual(['applying', 'applied']);
    // The outcome is the submit, not a robots verdict.
    expect(outcome.kind).toBe('submitted');
  });

  it('a Disallow for the apply path parks blocked_needs_human with robots_source=policy, never calls goto', async () => {
    // A blanket disallow for every agent: the clearest "no" robots.txt can say.
    const { fetcher } = respondWith(200, 'User-agent: *\nDisallow: /');
    // policy = the host published rules and they forbid this path.
    await expectParked(fetcher, 'policy');
  });

  it('a soft-200 HTML robots body parks, never submits', async () => {
    // A 200 serving an HTML error page. A lenient parser reads zero rules = allow all;
    // the gate must call it not-robots-txt and refuse instead (the §6 fail-open).
    const { fetcher } = respondWith(200, '<html><head><title>Not Found</title></head><body>Oops</body></html>', {
      'content-type': 'text/html',
    });
    // not-robots-txt = fetched, but not a robots.txt.
    await expectParked(fetcher, 'not-robots-txt');
  });

  it('a fetch error releases', async () => {
    // Real fetch REJECTS on DNS failure or a reset, so the double throws rather than
    // resolving with a fake status; a resolved error would test a path fetch never takes.
    const fetcher: RobotsFetcher = async () => {
      throw new TypeError('fetch failed: ECONNRESET');
    };
    // indeterminate = we could not tell: never permission, but not a "no" worth a human.
    await expectReleasedLive(fetcher, 'indeterminate');
  });

  it('a 5xx robots releases', async () => {
    // A server error says nothing about policy, so it cannot be read as permission.
    const { fetcher } = respondWith(503);
    // A non-200, non-4xx status is indeterminate: released, asked again next run.
    await expectReleasedLive(fetcher, 'indeterminate');
  });

  it('an indeterminate robots never opens the page', async () => {
    // The release path must still be FAIL-CLOSED: a page that would submit, a live env,
    // and an outage verdict. Releasing must not mean "fall through to goto".
    const { page, goto, submit } = fakePage();
    // Spies on both row-moving operations.
    const { gateway, advanceStatus, releaseClaim } = fakeGateway();
    // A direct verdict, so this pins applyToOne's branch independent of the gate's mapping.
    const check: RobotsCheck = async () => ({ kind: 'refuse', reason: 'timed out', source: 'indeterminate' });

    const outcome = await applyToOne({ row, page, gateway, answers, env: LIVE_ENV, renderResume, checkRobots: check });

    // Released, not parked and not submitted.
    expect(outcome).toMatchObject({ kind: 'robots_refused', action: 'released' });
    // The page was never requested: the whole point of the gate.
    expect(goto).not.toHaveBeenCalled();
    // Nothing was sent.
    expect(submit).not.toHaveBeenCalled();
    // No status write at all: an outage must not create a manual task.
    expect(advanceStatus).not.toHaveBeenCalled();
    // The row was handed back, once, so the next run asks again.
    expect(releaseClaim).toHaveBeenCalledTimes(1);
  });

  it('a 403 robots parks with source refused-by-host', async () => {
    // RFC 9309 says 4xx = allow all; a 403 is the host refusing US, so that rule would
    // grant access at the exact moment we are blocked. The gate refuses.
    const { fetcher } = respondWith(403);
    // Its own source, so the dashboard can tell a refusal from an outage.
    await expectParked(fetcher, 'refused-by-host');
  });

  it('a 404 robots allows', async () => {
    // 404 = the host publishes no policy, which IS permission. Paired with the 403 test:
    // same status class, opposite verdict, and both must hold.
    const { fetcher } = respondWith(404);
    const { page, goto, submit } = fakePage();
    const { gateway, advanceStatus } = fakeGateway();

    const outcome = await applyToOne({ row, page, gateway, answers, env: LIVE_ENV, renderResume, checkRobots: realGate(fetcher) });

    // The page opened and the application went through.
    expect(goto).toHaveBeenCalledWith(APPLY_URL);
    expect(submit).toHaveBeenCalledTimes(1);
    // No park: the status path is the normal submit path.
    expect(advanceStatus.mock.calls.map((call) => call[1])).toEqual(['applying', 'applied']);
    expect(outcome.kind).toBe('submitted');
  });

  it('a 429 within maxWait releases the claim with no status write', async () => {
    // A REAL 429 through the real gate: Retry-After 2s is under the 5s default ceiling,
    // so the gate says `wait`. A wait is "not yet", not "no", so even a LIVE run must
    // hand the row back rather than park it for a human.
    const { fetcher } = respondWith(429, '', { 'content-type': 'text/plain', 'retry-after': '2' });
    const { page, goto, submit } = fakePage();
    const { gateway, advanceStatus, releaseClaim } = fakeGateway();

    const outcome = await applyToOne({ row, page, gateway, answers, env: LIVE_ENV, renderResume, checkRobots: realGate(fetcher) });

    // Released, and the reason says it was a wait of the host's stated length.
    expect(outcome).toMatchObject({ kind: 'robots_refused', action: 'released', reason: expect.stringContaining('wait 2000ms') });
    // Handed back exactly once, for this row.
    expect(releaseClaim).toHaveBeenCalledTimes(1);
    expect(releaseClaim.mock.calls[0]![0]).toBe('app-1');
    // No status write: the row stays `approved` for a later run.
    expect(advanceStatus).not.toHaveBeenCalled();
    // Never opened, never sent.
    expect(goto).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('dry run + refuse releases the claim, writes no status', async () => {
    // The SAME refusal as the policy park, but in a dry run: a dry run never writes
    // status, so the row goes back untouched instead of to blocked_needs_human.
    const { fetcher } = respondWith(200, 'User-agent: *\nDisallow: /');
    const { page, goto, submit } = fakePage();
    const { gateway, advanceStatus, releaseClaim } = fakeGateway();

    const outcome = await applyToOne({ row, page, gateway, answers, env: DRY_ENV, renderResume, checkRobots: realGate(fetcher) });

    // Released, not parked.
    expect(outcome).toMatchObject({ kind: 'robots_refused', action: 'released' });
    // One release, and its reason is marked as a dry run so the event log says so.
    expect(releaseClaim).toHaveBeenCalledTimes(1);
    expect(releaseClaim.mock.calls[0]![1]).toMatch(/^dry_run: robots\.txt refused \(policy\)/);
    // No status write of any kind.
    expect(advanceStatus).not.toHaveBeenCalled();
    // The page was never opened, even though a dry run would never submit anyway.
    expect(goto).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('a comment-only robots (Greenhouse fixture) allows', async () => {
    // The real job-boards.greenhouse.io body: every line a comment. It parses to zero
    // groups, which is permission. A shape check that called it "not robots.txt" would
    // block every Greenhouse application, so this must stay an allow.
    const body =
      '# See http://www.robotstxt.org/robotstxt.html for documentation on how to use the robots.txt file\n' +
      '#\n' +
      '# To ban all spiders from the entire site uncomment the next two lines:\n' +
      '# User-agent: *\n' +
      '# Disallow: /\n';
    // The header exactly as Greenhouse serves it, charset included.
    const { fetcher } = respondWith(200, body, { 'content-type': 'text/plain; charset=UTF-8' });
    const { page, goto, submit } = fakePage();
    const { gateway } = fakeGateway();

    const outcome = await applyToOne({ row, page, gateway, answers, env: LIVE_ENV, renderResume, checkRobots: realGate(fetcher) });

    // Opened at the real Greenhouse URL and submitted.
    expect(goto).toHaveBeenCalledWith('https://job-boards.greenhouse.io/gitlab/jobs/8775507002');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('submitted');
  });
});

/**
 * A recording RunGateway over a fixed queue of claim pages.
 *
 * `calls` keeps ORDER across operations, so a test can see that the second row was
 * claimed and advanced after the first was refused.
 */
function fakeRunGateway(batches: ClaimedApplication[][]) {
  // Every operation, in order, as a short label.
  const calls: string[] = [];
  // Full detail of every status write, for the park assertions.
  const advances: Array<{ id: string; to: string; detail: Record<string, unknown> | undefined }> = [];
  const gateway: RunGateway = {
    openRun: async () => ({ id: 'run-1' }),
    closeRun: async () => {},
    // Required on RunGateway since the unknown-outcome note (claim-loop.ts); this file never produces one.
    appendApplicationNote: async () => {},
    // Required since W10 (the Settings daily cap); no cap here, so only the per-run cap applies.
    fetchDailyCap: async () => ({ maxPerDay: null, sentSince: 0 }),
      // B2: a live run needs the re-check config; open gates here.
      loadPreGatePreferences: loadOpenPreGatePreferences,
    // Enabled: the kill switch is not under test.
    isSystemEnabled: async () => true,
    sweepStaleClaims: async () => {},
    claimApplications: async () => {
      // Recorded so a missing second claim (a tripped breaker) is visible.
      calls.push('claim');
      // An empty page ends the loop once the queue is exhausted.
      return batches.shift() ?? [];
    },
    fetchAnswers: async () => answers,
    // Far in the future: the token gate is not under test.
    sessionExpiresAtEpochSeconds: () => 2_000_000,
    refreshSession: async () => {},
    advanceStatus: async (id, to, _agent, detail) => {
      // Labelled with the row id, so which row moved where is unambiguous.
      calls.push(`advance:${id}:${to}`);
      advances.push({ id, to, detail });
    },
    releaseClaim: async (id) => {
      calls.push(`release:${id}`);
    },
    uploadScreenshot: async () => 'screens/a.png',
    uploadResume: async () => 'resumes/a.pdf',
    setArtifactPaths: async () => {},
  };
  return { gateway, calls, advances };
}

// Inside the run-window budget: the time gate is not under test.
const frozenClock = () => 1_000_000;

describe('runApplierBatch and robots', () => {
  it('claim-loop counts robots_refused separately from outcomeUnknown', async () => {
    // Two rows in ONE claim page: the first refused by robots, the second allowed.
    const refusedRow: ClaimedApplication = { ...row, id: 'app-refused', applyUrl: 'https://blocked.example/jobs/1' };
    const allowedRow: ClaimedApplication = { ...row, id: 'app-allowed', applyUrl: 'https://open.example/jobs/2' };
    // Then a second claim page with a third row: proof the loop kept CLAIMING after the
    // refusal, which a tripped breaker would stop (submitBudgetStop runs before each claim).
    const laterRow: ClaimedApplication = { ...row, id: 'app-later', applyUrl: 'https://open.example/jobs/3' };
    const { gateway, calls, advances } = fakeRunGateway([[refusedRow, allowedRow], [laterRow], []]);
    // Refuse one host, allow the rest; a fake verdict is enough, the gate itself is
    // covered end to end above. This test is about the loop's arithmetic.
    const check: RobotsCheck = async (url) =>
      url.startsWith('https://blocked.example/')
        ? { kind: 'refuse', reason: 'disallowed', source: 'policy' }
        : { kind: 'allow', reason: 'ok', crawlDelayMs: null };

    const summary = await runApplierBatch({
      gateway,
      // A fresh page per application, as the real loop opens one each.
      openPage: async () => fakePage().page,
      renderResume,
      checkRobots: check,
      env: LIVE_ENV,
      clock: frozenClock,
    });

    // Its own tally, NOT an unknown: the page was never opened, so nothing may have gone out.
    expect(summary.robotsRefused).toBe(1);
    expect(summary.outcomeUnknown).toBe(0);
    // Both later rows were processed and submitted: the breaker did not trip.
    expect(summary.submitted).toBe(2);
    expect(summary.claimed).toBe(3);
    // No breaker text in the stop reason; the run ended because the queue drained.
    expect(summary.stoppedReason).toBe('queue drained');
    // The refused row was parked; the others went applying -> applied in order.
    expect(advances.filter((a) => a.id === 'app-refused')).toEqual([
      { id: 'app-refused', to: 'blocked_needs_human', detail: expect.objectContaining({ block_reason: 'robots_refused', robots_source: 'policy' }) },
    ]);
    // The second claim happened after the refusal: three claims (two pages + the empty one).
    expect(calls.filter((c) => c === 'claim')).toHaveLength(3);
    expect(calls).toContain('advance:app-later:applied');
  });

  it('a dry run logs wouldSubmit and each blocker label', async () => {
    // The line itself, from the pure formatter: verdict, count, then "label: reason" pairs.
    expect(
      formatDryRunLine('app-x', {
        kind: 'dry_run_complete',
        wouldSubmit: false,
        blockers: [
          // H2: blockers carry key and kind; the formatter reads neither.
          { id: 'q1', label: 'Visa status', reason: 'no_matching_option', key: 'visa_status', kind: 'text' },
          { id: 'q2', label: 'Start date', reason: 'no_matching_option', key: 'start_date', kind: 'text' },
        ],
        screenshotPath: 's.png',
        resumePath: null,
        resumeSha256: null,
        reason: 'dry',
      }),
    ).toBe('[applyy] dry run app-x: wouldSubmit=false blockers=2 [Visa status: no_matching_option, Start date: no_matching_option]');
    // Zero blockers still prints the count and empty brackets, so "none" is stated.
    expect(
      formatDryRunLine('app-y', {
        kind: 'dry_run_complete',
        wouldSubmit: true,
        blockers: [],
        screenshotPath: 's.png',
        resumePath: null,
        resumeSha256: null,
        reason: 'dry',
      }),
    ).toBe('[applyy] dry run app-y: wouldSubmit=true blockers=0 []');

    // And through the loop: a page whose fill refuses the planned value yields a real
    // blocker (labelled by the field's question text), which the loop must log.
    const { gateway } = fakeRunGateway([[row], []]);
    // Captured, not printed, and restored in finally so other tests keep their console.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runApplierBatch({
        gateway,
        // The fill throws the filler's known form-gap error, so apply-one records a blocker.
        openPage: async () =>
          fakePage({
            fill: async () => {
              throw new Error('no_matching_option: Teja not offered');
            },
          }).page,
        renderResume,
        // Allow, so the run reaches the form at all.
        checkRobots: async () => ({ kind: 'allow', reason: 'ok', crawlDelayMs: null }),
        env: DRY_ENV,
        clock: frozenClock,
      });
      // Exactly the format above, with the field's LABEL (not its id) and the reason.
      expect(log).toHaveBeenCalledWith('[applyy] dry run app-1: wouldSubmit=false blockers=1 [First Name: no_matching_option]');
    } finally {
      // Always restored, even when the assertion fails.
      log.mockRestore();
    }
  });
});
