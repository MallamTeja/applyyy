// A DRY RUN AND A REHEARSAL MUST SAY WHAT THE REAL SUBMIT WOULD DO (peer 2, task 2, 2026-11-09).
//
// WHY THIS FILE EXISTS. The dry run returned before recheckBeforeSubmit and before submit()'s own pre-click
// guard, so it reported wouldSubmit=true for a row the live path would park (a Lever required radio card the
// extractor cannot see, P2-17). The rehearsal (assist/rehearse.ts) built its own "ready" from fewer checks
// still. The first live bot submit is gated on that rehearsal, so a false "ready" is CLAUDE.md §6's fail-open
// on the one gate Teja trusts. Both now report the closed-union SubmitVerdict, judged by verdictFromFacts.
//
// Real Chromium over hand-built Lever shapes (Lever's robots.txt bars ClaudeBot, so nothing is captured):
// required-radio-card-shape.html (the gap) and clean-shape.html (its twin without the required card).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Real Chromium: the verdict reads live DOM state, which a fake cannot.
import { chromium, type Browser, type Page } from 'playwright';
// Serves worker/fixtures on 127.0.0.1, so the forms have a real origin.
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
// The production page port.
import { createPlaywrightPage } from '../src/playwright-page.ts';
// The applier, its port types, and the one judge.
import { applyToOne, verdictFromFacts, type ApplicationPage, type ApplierGateway } from '../src/apply-one.ts';
// The rehearsal and its read-only port.
import { readOnlyPage, rehearseAssisted } from '../src/assist/rehearse.ts';
// Open gates, so the re-check passes and only the page decides.
import { OPEN_RECHECK } from './open-pregate.ts';
// A real-shaped approved resume.
import { syntheticResume } from './resolved-resume-fixture.ts';
// Shapes for the profile and the bank.
import type { AnswerBankRow, MasterProfile } from '@applyy/shared-types';

// One browser and one server for the file: a launch costs ~0.5 s.
let browser: Browser;
// The fixture origin.
let server: FixtureServer;

beforeAll(async () => {
  // Headless, as on the Actions runner.
  browser = await chromium.launch();
  // Same root every fixture test uses.
  server = await startFixtureServer('fixtures');
}, 60_000);

afterAll(async () => {
  // A leaked Chromium keeps a CI job alive until its timeout.
  await browser?.close();
  // And the port.
  await server?.close();
});

// The required question the extractor cannot see (in the gap fixture only).
const REQUIRED_QUESTION = 'Are you available to join within 30 days?';
// The latest master: identity only, which is where the planner takes name and email from.
const profile = { identity: syntheticResume.identity } as unknown as MasterProfile;
// "Full name" is not an identity key the planner derives, so the bank answers it, as Teja's bank does.
const answers = [{ question_key: 'full_name', answer_value: 'Asha Rao', needs_human: false, answer_type: 'text', attested_by_human: true }] as unknown as AnswerBankRow[];
// "%PDF" bytes, as the real renderer returns.
const renderResume = async () => ({ bytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]), sha256: 'a'.repeat(64) });

/** A fresh page behind a network fence: only the fixture origin may answer, so nothing reaches a real board. */
async function fencedPage(): Promise<Page> {
  // A fresh page per test, so routes never leak between cases.
  const raw = await browser.newPage();
  // The fixture origin.
  const origin = new URL(server.url).origin;
  // THE FENCE.
  await raw.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
  // Ready.
  return raw;
}

/** A gateway that records every write, so "a dry run writes no status" is measured, not assumed. */
function recordingGateway() {
  // Status transitions: a dry run must leave this empty.
  const transitions: string[] = [];
  // Every other gateway call, in order.
  const calls: string[] = [];
  // The applier's gateway port, every method recorded.
  const gateway: ApplierGateway = {
    // A status write.
    advanceStatus: async (_id, to) => { transitions.push(to); },
    // The dry run's hand-back.
    releaseClaim: async () => { calls.push('release'); },
    // Evidence, as every branch writes it.
    uploadScreenshot: async () => { calls.push('screenshot'); return 'screens/x.png'; },
    // The rendered resume.
    uploadResume: async () => { calls.push('resume'); return 'resumes/x.pdf'; },
    // The evidence paths.
    setArtifactPaths: async () => { calls.push('set_paths'); },
  };
  // All three.
  return { gateway, transitions, calls };
}

/** A fake page whose own pre-click facts are clean, so only the case under test can refuse. */
function fakePage(overrides: Partial<ApplicationPage> = {}): ApplicationPage {
  return {
    // Loads nothing.
    goto: async () => {},
    // A form the planner fully answers (email from the profile).
    extractFields: async () => [{ id: 'email', label: 'Email', kind: 'email', required: true }],
    // Typed into nothing.
    fill: async () => {},
    // No resume input.
    attachFile: async () => {},
    // Evidence bytes.
    screenshot: async () => new Uint8Array([1]),
    // No wall.
    detectBlocker: async () => null,
    // Must never be reached in a dry run.
    submit: async () => { throw new Error('submit reached in a dry run'); },
    // A page that could send, so only the dry-run flag keeps it dry.
    submissionImplemented: true,
    // Clean facts.
    presubmitFacts: async () => ({ submitControls: 1, invalid: [], requiredEmpty: [] }),
    // The case's own difference.
    ...overrides,
  };
}

/** A dry run of the real applier over the real page on one fixture. */
async function dryRun(fixture: string) {
  // Fenced Chromium.
  const raw = await fencedPage();
  // The writes, recorded.
  const recorded = recordingGateway();
  try {
    // The row, pointed at the fixture; tailoredProfile so the resume can be attached.
    const row = { id: 'app-1', status: 'approved', applyUrl: `${server.url}/lever/${fixture}`, tailoredProfile: syntheticResume, employerName: 'Example Co', atsProvider: null } as const;
    // env {} is the dry-run default.
    const outcome = await applyToOne({ row, page: createPlaywrightPage(raw), gateway: recorded.gateway, answers, profile, env: {}, renderResume, checkRobots: async () => ({ kind: 'allow', reason: 'test', crawlDelayMs: null }), recheck: OPEN_RECHECK });
    // The outcome and what was written.
    return { outcome, ...recorded };
  } finally {
    // Always closed.
    await raw.close();
  }
}

/** A rehearsal over the real page on one fixture, through the read-only port the CLI hands over. */
async function rehearse(fixture: string) {
  // Fenced Chromium.
  const raw = await fencedPage();
  try {
    // Exactly what rehearse-assist.ts does: the production port, narrowed to reads.
    return await rehearseAssisted({
      applicationId: 'app-1',
      applyUrl: `${server.url}/lever/${fixture}`,
      company: 'Example Co',
      tailoredProfile: syntheticResume,
      master: profile,
      answers,
      page: readOnlyPage(createPlaywrightPage(raw)),
      checkRobots: async () => ({ kind: 'allow', reason: 'test', crawlDelayMs: null }),
      resolveFormUrl: async (row) => row.applyUrl,
      renderResume,
    });
  } finally {
    // Always closed.
    await raw.close();
  }
}

describe('dry run (applyToOne, DRY_RUN unset)', () => {
  it('(1) Lever required radio card the extractor cannot see: would NOT submit, required_empty, named; no status write', async () => {
    // The gap fixture.
    const { outcome, transitions } = await dryRun('required-radio-card-shape.html');
    // A dry run, as asked.
    expect(outcome.kind).toBe('dry_run_complete');
    // THE POINT: the planner saw nothing to refuse, but the live pre-click guard would park it.
    if (outcome.kind === 'dry_run_complete') expect(outcome.verdict).toMatchObject({ kind: 'would_block', check: 'required_empty', detail: expect.stringContaining(REQUIRED_QUESTION) });
    // The planner really had nothing to refuse (non-vacuity: this is the case the old boolean got wrong).
    if (outcome.kind === 'dry_run_complete') expect(outcome.blockers).toEqual([]);
    // A dry run never moves the row.
    expect(transitions).toEqual([]);
  }, 30_000);

  it('(2) the clean twin: would submit (the guard does not over-block), still no status write', async () => {
    // The same form without the required card.
    const { outcome, transitions } = await dryRun('clean-shape.html');
    // Every live check passed, so the one representable "yes".
    expect(outcome).toMatchObject({ kind: 'dry_run_complete', verdict: { kind: 'would_submit' } });
    // Still a dry run.
    expect(transitions).toEqual([]);
  }, 30_000);

  it('(3) a required human_only question (a declaration checkbox): would NOT submit, fill_plan, named', async () => {
    // A fake page: the planner, not the DOM, is under test here, so the page's own facts are clean.
    const page = fakePage({
      // An email box (the form-shape gate) and a REQUIRED declaration the bot never ticks (Teja's ruling).
      extractFields: async () => [
        { id: 'email', label: 'Email', kind: 'email', required: false },
        { id: 'decl', label: 'I confirm the information above is accurate', kind: 'checkbox', required: true },
      ],
    });
    // The recorded writes.
    const { gateway, transitions } = recordingGateway();
    // The dry run.
    const outcome = await applyToOne({ row: { id: 'app-1', status: 'approved', applyUrl: 'http://127.0.0.1:1/f.html', tailoredProfile: syntheticResume, employerName: 'Example Co', atsProvider: null }, page, gateway, answers, profile, env: {}, renderResume, checkRobots: async () => ({ kind: 'allow', reason: 'test', crawlDelayMs: null }), recheck: OPEN_RECHECK });
    // Refused at the planner, with the declaration's own text.
    expect(outcome).toMatchObject({ kind: 'dry_run_complete', verdict: { kind: 'would_block', check: 'fill_plan', detail: expect.stringContaining('I confirm the information above is accurate') } });
    // And the planner's reason is human_only, the one a declaration must carry.
    if (outcome.kind === 'dry_run_complete') expect(outcome.blockers.map((blocker) => blocker.reason)).toEqual(['human_only']);
    // No status write.
    expect(transitions).toEqual([]);
  });

  it('a page that cannot report its pre-click facts is presubmit_unavailable, never would_submit', async () => {
    // A fake with no presubmitFacts at all: the key is removed, as on a page that never had the method.
    const { presubmitFacts: _absent, ...page } = fakePage();
    // The dry run.
    const outcome = await applyToOne({ row: { id: 'app-1', status: 'approved', applyUrl: 'http://127.0.0.1:1/f.html', tailoredProfile: syntheticResume, employerName: 'Example Co', atsProvider: null }, page, gateway: recordingGateway().gateway, answers, profile, env: {}, renderResume, checkRobots: async () => ({ kind: 'allow', reason: 'test', crawlDelayMs: null }), recheck: OPEN_RECHECK });
    // An unrun check is a refusal by name.
    expect(outcome).toMatchObject({ kind: 'dry_run_complete', verdict: { kind: 'would_block', check: 'presubmit_unavailable' } });
  });

  it('no gate config (a dry run whose config could not load) is recheck_unavailable, never would_submit', async () => {
    // Same clean page, but no recheck config handed in.
    const page = fakePage();
    // recheck: undefined, as claim-loop passes it when the config read failed.
    const outcome = await applyToOne({ row: { id: 'app-1', status: 'approved', applyUrl: 'http://127.0.0.1:1/f.html', tailoredProfile: syntheticResume, employerName: 'Example Co', atsProvider: null }, page, gateway: recordingGateway().gateway, answers, profile, env: {}, renderResume, checkRobots: async () => ({ kind: 'allow', reason: 'test', crawlDelayMs: null }), recheck: undefined });
    // The live path would throw rather than submit unjudged; the dry run says so by name.
    expect(outcome).toMatchObject({ kind: 'dry_run_complete', verdict: { kind: 'would_block', check: 'recheck_unavailable' } });
  });
});

describe('rehearsal (assist/rehearse.ts, what rehearse-assist prints as "ready")', () => {
  it('(1) Lever required radio card: would NOT submit, required_empty, named', async () => {
    // The gap fixture, through the CLI's own read-only port.
    const report = await rehearse('required-radio-card-shape.html');
    // Ran to the end: no early stop explains the verdict.
    expect(report.stoppedAt).toBeNull();
    // The required card nobody planned for, by its Lever label.
    expect(report.verdict).toMatchObject({ kind: 'would_block', check: 'required_empty', detail: expect.stringContaining(REQUIRED_QUESTION) });
    // Only the card: the planned fills and the resume input count as covered on the untyped page.
    if (report.verdict.kind === 'would_block') expect(report.verdict.detail).toBe(`required but empty before submit: ${REQUIRED_QUESTION}`);
  }, 30_000);

  it('(2) the clean twin: would submit (planned fills and the resume input are covered)', async () => {
    // The same form without the required card.
    const report = await rehearse('clean-shape.html');
    // Every check passed.
    expect(report.verdict).toEqual({ kind: 'would_submit' });
  }, 30_000);
});

describe('the port', () => {
  it('the real page has presubmitFacts, and the rehearsal port carries it (the optional member is never absent in production)', async () => {
    // A real page; nothing is loaded.
    const raw = await browser.newPage();
    try {
      // The production port.
      const port = createPlaywrightPage(raw);
      // Present on the real page.
      expect(typeof port.presubmitFacts).toBe('function');
      // And copied onto the rehearsal's read-only port, with no write method alongside it.
      expect(Object.keys(readOnlyPage(port)).sort()).toEqual(['detectBlocker', 'extractFields', 'goto', 'postingClosed', 'presubmitFacts']);
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  it('verdictFromFacts judges in submit() order: submit control, then invalid, then required-empty', () => {
    // Two controls win over everything.
    expect(verdictFromFacts({ submitControls: 2, invalid: ['A'], requiredEmpty: ['B'] })).toMatchObject({ check: 'submit_control' });
    // Then invalid.
    expect(verdictFromFacts({ submitControls: 1, invalid: ['A'], requiredEmpty: ['B'] })).toMatchObject({ check: 'invalid_fields' });
    // Then blank required.
    expect(verdictFromFacts({ submitControls: 1, invalid: [], requiredEmpty: ['B'] })).toMatchObject({ check: 'required_empty' });
    // Clean.
    expect(verdictFromFacts({ submitControls: 1, invalid: [], requiredEmpty: [] })).toEqual({ kind: 'would_submit' });
  });
});
