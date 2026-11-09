// The Workday guard in front of the applier (2026-11-01): an approved Workday row is
// parked for a human and its page is NEVER opened.
//
// WHY THE GUARD EXISTS. The scout's Workday adapter is discovery only. Applying on
// Workday means creating a candidate account first, and nothing in the worker branches
// on the ATS provider: without this guard an approved Workday row would reach goto,
// a generic form fill and possibly submit. Either signal parks the row:
//   - the apply URL's HOST is a Workday host (exact, or a dot-anchored suffix), or
//   - the job's ats_provider is 'workday' (tenants front Workday on careers.company.com,
//     and a link pasted through job-link-intake can arrive as provider unknown).
//
// WHAT "PARKED" MUST MEAN, asserted in full every time: ONE status write to
// blocked_needs_human carrying block_reason=login_required, no robots check (nothing is
// fetched), goto never called, submit never called, no release.
import { describe, expect, it, vi } from 'vitest';
import {
  // The function under test, and the pure host predicate the guard uses.
  applyToOne as applyToOneRaw,
  isWorkdayApplyUrl,
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
// The loop, for the counting test.
import { runApplierBatch, type RunGateway } from '../src/claim-loop.ts';
// The planner reads the answer bank; only the row type is needed here.
import type { AnswerBankRow } from '@applyy/shared-types';
// The form field type, so the stub form is checked against the real shape.
import type { FormField } from '../src/extract-fields.ts';

// A real Workday posting URL shape (Mastercard's verified tenant, 2026-11-01).
const WORKDAY_URL = 'https://mastercard.wd1.myworkdayjobs.com/CorporateCareers/job/Pune-India/Senior-Software-Engineer_R-123';
// A real Greenhouse job URL shape, the control that must be unaffected.
const GREENHOUSE_URL = 'https://job-boards.greenhouse.io/gitlab/jobs/8775507002';
// The live opt-in: resolveSubmissionMode submits only on this exact string.
const LIVE_ENV = { DRY_RUN: 'false' } as const;
// Unset DRY_RUN is the realistic dry run.
const DRY_ENV = {} as const;

// One field the bank answers, so the control row runs all the way to submit.
// The optional Email field: every real form asks for one, and the form-shape gate (no_email_field, 2026-11-09)
// refuses a page without it. Optional, so the planner never blocks on it.
const answerableForm: FormField[] = [{ id: 'first_name', label: 'First Name', kind: 'text', required: true }, { id: 'email', label: 'Email', kind: 'email', required: false }];
// The matching bank row; the planner reads these four columns.
const answers = [
  { question_key: 'first_name', answer_value: 'Teja', needs_human: false, answer_type: 'text' },
] as unknown as AnswerBankRow[];

// A claimed row; each test overrides the URL and provider it is about.
function claimed(applyUrl: string, atsProvider: ClaimedApplication['atsProvider']): ClaimedApplication {
  // No tailored profile: the stub form asks for no document.
  return { id: 'app-1', status: 'approved', applyUrl, tailoredProfile: null, employerName: 'Acme', atsProvider };
}

// A fake page whose goto and submit are spies: the guard's promise is that neither runs.
function fakePage() {
  // Must stay uncalled for a Workday row.
  const goto = vi.fn(async (_url: string) => {});
  // Confirmed by default, so the control row really submits.
  const submit = vi.fn(async (): Promise<SubmitResult> => ({ kind: 'confirmed', evidence: 'test' }));
  // The port, with harmless defaults.
  const page: ApplicationPage & { close(): Promise<void> } = {
    // The spied open.
    goto,
    // The answerable form.
    extractFields: async () => answerableForm,
    // Filling does nothing in a test.
    fill: async () => {},
    // No document is asked for.
    attachFile: async () => {},
    // Any bytes; uploads are faked.
    screenshot: async () => new Uint8Array([1, 2, 3]),
    // No captcha, so an allowed row runs to submit.
    detectBlocker: async () => null,
    // The spied send.
    submit,
    // True, so LIVE_ENV really is live.
    submissionImplemented: true,
    // The claim loop closes every page it opens.
    close: async () => {},
  };
  // All three, for the assertions.
  return { page, goto, submit };
}

// A gateway whose two row-moving operations are spies.
function fakeGateway() {
  // (id, to, agent, detail): the StatusWriter signature guardedAdvance calls.
  const advanceStatus = vi.fn(async (_id: string, _to: string, _agent: string, _detail?: Record<string, unknown>) => {});
  // (id, reason): hands the row back untouched at `approved`.
  const releaseClaim = vi.fn(async (_id: string, _reason: string) => {});
  // The full port; uploads only happen on the control row.
  const gateway: ApplierGateway = {
    // Spied.
    advanceStatus,
    // Spied.
    releaseClaim,
    // Faked storage paths.
    uploadScreenshot: async () => 'screens/app-1.png',
    // Faked storage paths.
    uploadResume: async () => 'resumes/app-1.pdf',
    // No-op evidence write.
    setArtifactPaths: async () => {},
  };
  // All three, for the assertions.
  return { gateway, advanceStatus, releaseClaim };
}

// A renderer that throws: no form here asks for a document.
const renderResume: ResumeRenderer = async () => {
  // Loud, so an unexpected render fails the test that caused it.
  throw new Error('renderResume must not be called in workday guard tests');
};

// A spied robots check that allows: for a Workday row it must never even be asked.
function allowingRobots() {
  // Records the URLs it was asked about.
  return vi.fn<RobotsCheck>(async () => ({ kind: 'allow', reason: 'ok', crawlDelayMs: null }));
}

// Run one LIVE application and assert the full meaning of "parked".
async function expectParked(row: ClaimedApplication) {
  // A page that WOULD submit, so a missing guard shows up as a goto or submit call.
  const { page, goto, submit } = fakePage();
  // Spies on both row-moving operations.
  const { gateway, advanceStatus, releaseClaim } = fakeGateway();
  // A robots check that must stay unasked.
  const checkRobots = allowingRobots();
  // Live: only a live run parks.
  const outcome = await applyToOne({ row, page, gateway, answers, env: LIVE_ENV, renderResume, checkRobots });
  // Its own outcome, parked.
  expect(outcome).toMatchObject({ kind: 'ats_unsupported', action: 'parked' });
  // Exactly ONE status write.
  expect(advanceStatus).toHaveBeenCalledTimes(1);
  // Destructured so each part can be checked.
  const [id, to, agent, detail] = advanceStatus.mock.calls[0]!;
  // The claimed row.
  expect(id).toBe('app-1');
  // The human lane: a person applies by hand.
  expect(to).toBe('blocked_needs_human');
  // The applier names itself, so the transition graph checks the edge.
  expect(agent).toBe('applier');
  // The existing reason code for "the board demands an account", and no screenshot.
  expect(detail).toMatchObject({ block_reason: 'login_required', unsupported_ats: 'workday', screenshot_storage_path: null });
  // Moved, not handed back.
  expect(releaseClaim).not.toHaveBeenCalled();
  // Nothing was fetched: not even robots.txt.
  expect(checkRobots).not.toHaveBeenCalled();
  // THE point: the page was never opened.
  expect(goto).not.toHaveBeenCalled();
  // And nothing was sent.
  expect(submit).not.toHaveBeenCalled();
}

describe('isWorkdayApplyUrl', () => {
  it('matches a Workday host exactly or by a dot-anchored suffix, and nothing else', () => {
    // A tenant host on the main Workday jobs domain.
    expect(isWorkdayApplyUrl(WORKDAY_URL)).toBe(true);
    // The myworkdaysite variant (Wells Fargo and Fidelity use it).
    expect(isWorkdayApplyUrl('https://wd1.myworkdaysite.com/recruiting/wf/WellsFargoJobs/job/1')).toBe(true);
    // The bare apex, an exact match.
    expect(isWorkdayApplyUrl('https://myworkdayjobs.com/x')).toBe(true);
    // Host case is normalised by the URL parser, so upper case still matches.
    expect(isWorkdayApplyUrl('https://ACME.WD5.MYWORKDAYJOBS.COM/Careers/job/1')).toBe(true);
    // NOT a suffix on a label boundary: a lookalike domain.
    expect(isWorkdayApplyUrl('https://evilmyworkdayjobs.com/job/1')).toBe(false);
    // The Workday name as a subdomain of someone else's domain.
    expect(isWorkdayApplyUrl('https://myworkdayjobs.com.evil.example/job/1')).toBe(false);
    // The name in the path or query only.
    expect(isWorkdayApplyUrl('https://evil.example/?next=myworkdayjobs.com')).toBe(false);
    // An unrelated ATS.
    expect(isWorkdayApplyUrl(GREENHOUSE_URL)).toBe(false);
    // Not a URL at all: no host, so no match (the robots gate refuses it downstream).
    expect(isWorkdayApplyUrl('not a url')).toBe(false);
  });
});

describe('applyToOne workday guard', () => {
  it('a live Workday-host row parks blocked_needs_human without opening the page', async () => {
    // Host signal, provider unknown: a pasted link that job-link-intake could not classify.
    await expectParked(claimed(WORKDAY_URL, 'unknown'));
  });

  it('a live row whose provider is workday parks even on a non-Workday host', async () => {
    // Provider signal only: a tenant fronting Workday on its own careers domain.
    await expectParked(claimed('https://careers.acme.example/job/R-123', 'workday'));
  });

  it('a dry-run Workday row releases the claim and writes no status', async () => {
    // A page that would submit.
    const { page, goto, submit } = fakePage();
    // Spies on both row-moving operations.
    const { gateway, advanceStatus, releaseClaim } = fakeGateway();
    // A robots check that must stay unasked.
    const checkRobots = allowingRobots();
    // Dry: nothing may be written.
    const outcome = await applyToOne({ row: claimed(WORKDAY_URL, 'workday'), page, gateway, answers, env: DRY_ENV, renderResume, checkRobots });
    // Released, not parked.
    expect(outcome).toMatchObject({ kind: 'ats_unsupported', action: 'released' });
    // No status write in a dry run.
    expect(advanceStatus).not.toHaveBeenCalled();
    // Handed back once, with a reason that says it was a dry run.
    expect(releaseClaim).toHaveBeenCalledTimes(1);
    // The reason names the dry run and Workday.
    expect(releaseClaim.mock.calls[0]![1]).toMatch(/^dry_run: .*Workday/);
    // Still never opened or asked about.
    expect(checkRobots).not.toHaveBeenCalled();
    // Never opened.
    expect(goto).not.toHaveBeenCalled();
    // Never sent.
    expect(submit).not.toHaveBeenCalled();
  });

  it('a Greenhouse row is unaffected: robots is asked, the page opens, the application submits', async () => {
    // The control: the guard must not catch other providers.
    const { page, goto, submit } = fakePage();
    // Spies on both row-moving operations.
    const { gateway } = fakeGateway();
    // The robots check, which must be asked this time.
    const checkRobots = allowingRobots();
    // Live, so the row runs all the way.
    const outcome = await applyToOne({ row: claimed(GREENHOUSE_URL, 'greenhouse'), page, gateway, answers, env: LIVE_ENV, renderResume, checkRobots });
    // Submitted as before.
    expect(outcome).toEqual({ kind: 'submitted' });
    // Asked about the apply URL.
    expect(checkRobots).toHaveBeenCalledWith(GREENHOUSE_URL);
    // Opened.
    expect(goto).toHaveBeenCalledWith(GREENHOUSE_URL);
    // Sent.
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('runApplierBatch and the workday guard', () => {
  it('claim-loop counts ats_unsupported apart from blocked and robotsRefused, and keeps going', async () => {
    // One Workday row then one Greenhouse row in a single claim page, then an empty page.
    const batches: ClaimedApplication[][] = [[{ ...claimed(WORKDAY_URL, 'workday'), id: 'app-wd' }, { ...claimed(GREENHOUSE_URL, 'greenhouse'), id: 'app-gh' }], []];
    // Every status write, for the park assertion.
    const advances: Array<{ id: string; to: string }> = [];
    // A recording loop gateway; everything not under test is a harmless default.
    const gateway: RunGateway = {
      // One run row.
      openRun: async () => ({ id: 'run-1' }),
      // Closing is not under test.
      closeRun: async () => {},
      // No unknown outcomes here.
      appendApplicationNote: async () => {},
      // Required since W10 (the Settings daily cap); no cap, so the Workday park is all that is tested.
      fetchDailyCap: async () => ({ maxPerDay: null, sentSince: 0 }),
      // B2: a live run needs the re-check config; open gates here.
      loadPreGatePreferences: loadOpenPreGatePreferences,
      // The kill switch is not under test.
      isSystemEnabled: async () => true,
      // Not under test.
      sweepStaleClaims: async () => {},
      // The fixed queue; an empty page ends the loop.
      claimApplications: async () => batches.shift() ?? [],
      // The bank.
      fetchAnswers: async () => answers,
      // Far in the future: the token gate is not under test.
      sessionExpiresAtEpochSeconds: () => 2_000_000,
      // Not under test.
      refreshSession: async () => {},
      // Recorded.
      advanceStatus: async (id, to) => { advances.push({ id, to }); },
      // Not expected in a live run of these rows.
      releaseClaim: async () => {},
      // Faked storage.
      uploadScreenshot: async () => 'screens/a.png',
      // Faked storage.
      uploadResume: async () => 'resumes/a.pdf',
      // No-op evidence write.
      setArtifactPaths: async () => {},
    };
    // A live run with an allowing robots check.
    const summary = await runApplierBatch({
      // The recording gateway.
      gateway,
      // A fresh page per application.
      openPage: async () => fakePage().page,
      // Never called here.
      renderResume,
      // Allows everything; the Workday row never reaches it.
      checkRobots: allowingRobots(),
      // Live.
      env: LIVE_ENV,
      // Inside the run window.
      clock: () => 1_000_000,
    });
    // Its own tally.
    expect(summary.atsUnsupported).toBe(1);
    // Not miscounted as a form block or a robots refusal.
    expect(summary.blocked).toBe(0);
    // Not a robots refusal either.
    expect(summary.robotsRefused).toBe(0);
    // The Greenhouse row still submitted: the guard trips no breaker.
    expect(summary.submitted).toBe(1);
    // The Workday row was parked, nothing else happened to it.
    expect(advances.filter((a) => a.id === 'app-wd')).toEqual([{ id: 'app-wd', to: 'blocked_needs_human' }]);
  });
});
