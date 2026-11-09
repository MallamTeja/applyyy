// Tests for the assisted-submit rehearsal (src/assist/rehearse.ts): it must run assist's steps up to the
// click and be UNABLE to fill, attach, submit, claim or advance (2026-11-07, first bot submit readiness).
import { describe, expect, it, vi } from 'vitest';
// The rehearsal and its read-only page adapter.
import { preGateJobFromRow, readOnlyPage, sqlConfigReader, rehearseAssisted, type RehearsalInput } from '../src/assist/rehearse.ts';
// The live re-check, for the parity test (task 3).
import { recheckBeforeSubmit } from '../src/apply-one.ts';
// The gateway's own config loader, run over the CLI's adapter.
import { loadPreGatePreferences } from '../../supabase/functions/_shared/pregate-config-loader.ts';
// The full page port, so the fake has every method a real page has, writes included.
import type { ApplicationPage } from '../src/apply-one.ts';
// A real-shaped resume.
import { syntheticResume } from './resolved-resume-fixture.ts';
// The master shape.
import type { MasterProfile } from '@applyy/shared-types';
// Open gates, so only the case under test can refuse at pre_gate (task 3).
import { OPEN_PREGATE_PREFERENCES } from './open-pregate.ts';
// The job shape the pre-gate reads.
import type { AuditorJobEmbed } from '../../supabase/functions/auditor/pregate.ts';

// A job today's open gates keep: a junior title, no stated experience, remote.
const OPEN_JOB: AuditorJobEmbed = { title: 'Software Engineer', description_raw: 'Build web services.', location_raw: 'Remote', min_experience_years: null, discovered_via: null };

/** A full page whose write methods THROW, so any reach into them fails the test loudly. */
function fullPage() {
  // Each write is a spy that throws: called at all = test failure, and the spy records it.
  const writes = {
    fill: vi.fn(async () => { throw new Error('fill reached'); }),
    attachFile: vi.fn(async () => { throw new Error('attachFile reached'); }),
    submit: vi.fn(async () => { throw new Error('submit reached'); }),
  };
  // The reads answer like a small Greenhouse form: a name, an email, a file input.
  const page = {
    goto: vi.fn(async () => {}),
    detectBlocker: vi.fn(async () => null),
    extractFields: vi.fn(async () => [
      { id: 'first_name', label: 'First Name', kind: 'text', required: true },
      { id: 'email', label: 'Email', kind: 'text', required: true },
      { id: 'resume', label: 'Attach', kind: 'file', required: true },
    ]),
    ...writes,
    screenshot: vi.fn(async () => new Uint8Array()),
    submissionImplemented: true,
    postingClosed: vi.fn(async () => null),
  } as unknown as ApplicationPage;
  // Both, so a test can inspect the write spies.
  return { page, writes };
}

/** Input for one rehearsal over the given page, robots allowing unless told otherwise. */
function input(page: ApplicationPage, robots: 'allow' | 'refuse' = 'allow'): RehearsalInput {
  // The latest master: the identity the resume and the profile fills come from.
  const master = { identity: syntheticResume.identity } as unknown as MasterProfile;
  return {
    applicationId: 'app-1',
    applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/1',
    company: 'Acme',
    tailoredProfile: syntheticResume,
    master,
    answers: [],
    // THE PORT UNDER TEST: what the CLI hands over.
    page: readOnlyPage(page),
    checkRobots: async () => (robots === 'allow' ? { kind: 'allow' as const, reason: 'test', crawlDelayMs: null } : { kind: 'refuse' as const, reason: 'Disallow: /', source: 'policy' as const }),
    resolveFormUrl: async (row) => row.applyUrl,
    // "%PDF" bytes, as the real renderer returns.
    renderResume: async () => ({ bytes: new Uint8Array([37, 80, 68, 70, 45]), sha256: 'a'.repeat(64) }),
    // Task 3: today's gates, open, so no older test changes meaning.
    preGate: { job: OPEN_JOB, config: { kind: 'ok', preferences: OPEN_PREGATE_PREFERENCES } },
  };
}

describe('rehearseAssisted', () => {
  it('the port it is handed carries NO write method at runtime (structural, not a flag)', () => {
    // Built from a full page that does have them.
    const { page } = fullPage();
    // Exactly the reads, nothing else on the object: the three form reads, plus postingClosed since task 2
    // (2026-11-09; the live path asks it before the click, and this fake page has it). This fake has no
    // presubmitFacts, so it is absent here too: copied only when present (dry-run-would-submit.test.ts pins the real page).
    const keys = Object.keys(readOnlyPage(page)).sort();
    // The reads, by name.
    expect(keys).toEqual(['detectBlocker', 'extractFields', 'goto', 'postingClosed']);
    // And, stated directly, no write method: the property this test exists for.
    expect(keys.filter((key) => ['fill', 'attachFile', 'submit', 'screenshot'].includes(key))).toEqual([]);
  });

  it('runs to the end on a fillable form and never touches fill, attachFile or submit', async () => {
    // A page whose writes throw if reached.
    const { page, writes } = fullPage();
    const report = await rehearseAssisted(input(page));
    // Ran to the end.
    expect(report.stoppedAt).toBeNull();
    // The planner was reached and would fill the email from the master.
    expect(report.plan?.fills.map((f) => f.id)).toContain('email');
    // The resume would go into the file input, as a real PDF.
    expect([report.resumeTarget, report.resume?.isPdf]).toEqual(['Attach', true]);
    // THE POINT: no write method was called, not even once.
    expect([writes.fill.mock.calls.length, writes.attachFile.mock.calls.length, writes.submit.mock.calls.length]).toEqual([0, 0, 0]);
  });

  it('a robots refusal stops BEFORE the page is opened, as assist does', async () => {
    // The page, to prove goto never ran.
    const { page } = fullPage();
    const report = await rehearseAssisted(input(page, 'refuse'));
    // Says why it stopped.
    expect(report.stoppedAt).toMatch(/^robots refuse/);
    // And never loaded the form.
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('no master stops before robots and the page, as assist refuses', async () => {
    // The page, to prove nothing ran.
    const { page } = fullPage();
    const report = await rehearseAssisted({ ...input(page), master: null });
    // The same refusal reason assist gives.
    expect(report.stoppedAt).toMatch(/no master profile/);
    // Nothing loaded.
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('rehearse-assist fails closed when the page or kit has 0 fields', async () => {
    // A page that opens fine but extracts NOTHING: a job description, an iframe shell, a form that never rendered.
    const { page, writes } = fullPage();
    // Zero fields, the exact shape that made the CLI print exit 0 before the guard (2026-11-08).
    (page.extractFields as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const report = await rehearseAssisted(input(page));
    // THE POINT: a stop, which the CLI turns into a FAIL row and exit 1, never "ready".
    expect(report.stoppedAt).toMatch(/no application form fields/i);
    // Stopped before the resume render: there is no form to attach it to.
    expect(report.resume).toBeNull();
    // Still read-only on the way out.
    expect([writes.fill.mock.calls.length, writes.attachFile.mock.calls.length, writes.submit.mock.calls.length]).toEqual([0, 0, 0]);
  });

  it('a renderer that does not return a PDF is reported, not passed', async () => {
    // HTML bytes where a PDF should be.
    const { page } = fullPage();
    const report = await rehearseAssisted({ ...input(page), renderResume: async () => ({ bytes: new TextEncoder().encode('<html>'), sha256: 'b'.repeat(64) }) });
    // Flagged: the magic is wrong.
    expect(report.resume?.isPdf).toBe(false);
  });
});

// TASK 3 (2026-11-09): the rehearsal runs today's matcher gates (pre_gate) exactly as the live re-check does,
// so its "ready" is a full proxy for the live gate, and loading what that needs is read-only.
describe('rehearsal pre_gate (task 3)', () => {
  // Today's config with one closed gate: an experience ceiling of 2 years, everything else open.
  const CEILING_2 = { ...OPEN_PREGATE_PREFERENCES, experienceMaxYears: 2 };
  // A job that ceiling drops: it states 8+ years.
  const SENIOR_JOB: AuditorJobEmbed = { ...OPEN_JOB, description_raw: 'Requires 8+ years.', min_experience_years: 8 };
  // The fake form's one question the planner cannot derive, answered from the bank, so the plan is clean.
  const FIRST_NAME = [{ question_key: 'first_name', answer_value: 'Asha', needs_human: false, answer_type: 'text', attested_by_human: true }] as unknown as RehearsalInput['answers'];
  // The full fake page with clean pre-click facts, so only the gate under test can refuse.
  const cleanPage = () => {
    // The page with its write spies.
    const { page, writes } = fullPage();
    // Every pre-click check passes.
    return { page: { ...page, presubmitFacts: async () => ({ submitControls: 1, invalid: [], requiredEmpty: [] }) } as ApplicationPage, writes };
  };

  it("a row today's gates drop: would_block pre_gate, with the gate's reason; the open control would submit", async () => {
    // The dropping config.
    const { page, writes } = cleanPage();
    // The rehearsal with the ceiling closed.
    const dropped = await rehearseAssisted({ ...input(page), answers: FIRST_NAME, preGate: { job: SENIOR_JOB, config: { kind: 'ok', preferences: CEILING_2 } } });
    // Refused at pre_gate, naming the ceiling.
    expect(dropped.verdict).toMatchObject({ kind: 'would_block', check: 'pre_gate', detail: expect.stringMatching(/8/) });
    // Control (non-vacuity): the same page and job with open gates would submit, so the gate alone refused.
    const open = await rehearseAssisted({ ...input(cleanPage().page), answers: FIRST_NAME, preGate: { job: SENIOR_JOB, config: { kind: 'ok', preferences: OPEN_PREGATE_PREFERENCES } } });
    // The one representable "yes".
    expect(open.verdict).toEqual({ kind: 'would_submit' });
    // And the gate's read wrote nothing to the page.
    expect([writes.fill.mock.calls.length, writes.attachFile.mock.calls.length, writes.submit.mock.calls.length]).toEqual([0, 0, 0]);
  });

  it("parity: the rehearsal's pre_gate reason is word for word what the live recheckBeforeSubmit returns", async () => {
    // The live re-check on the same job and config (a bare page whose posting reads as open).
    const live = await recheckBeforeSubmit({ id: 'app-1', status: 'approved', applyUrl: 'x', tailoredProfile: null, employerName: null, atsProvider: null, preGateJob: SENIOR_JOB }, { postingClosed: async () => null } as unknown as ApplicationPage, { preferences: CEILING_2 });
    // Non-vacuity: the live re-check refused.
    expect(live).not.toBeNull();
    // The rehearsal on the same inputs.
    const rehearsed = await rehearseAssisted({ ...input(cleanPage().page), answers: FIRST_NAME, preGate: { job: SENIOR_JOB, config: { kind: 'ok', preferences: CEILING_2 } } });
    // Same gate, same words: the two cannot drift apart unnoticed.
    expect(rehearsed.verdict).toEqual({ kind: 'would_block', check: live?.recheck, detail: live?.reason });
  });

  it('unreadable config is recheck_unavailable and a missing job is pre_gate: never would_submit', async () => {
    // The loader's error result.
    const unreadable = await rehearseAssisted({ ...input(cleanPage().page), answers: FIRST_NAME, preGate: { job: OPEN_JOB, config: { kind: 'error', code: 'preferences_unreadable', message: 'boom' } } });
    // Named, with the loader's code.
    expect(unreadable.verdict).toMatchObject({ kind: 'would_block', check: 'recheck_unavailable', detail: expect.stringContaining('preferences_unreadable') });
    // No job row.
    const noJob = await rehearseAssisted({ ...input(cleanPage().page), answers: FIRST_NAME, preGate: { job: null, config: { kind: 'ok', preferences: OPEN_PREGATE_PREFERENCES } } });
    // recheckBeforeSubmit's own words.
    expect(noJob.verdict).toEqual({ kind: 'would_block', check: 'pre_gate', detail: "the job row could not be read, so today's gates could not run" });
  });
});

describe("sqlConfigReader + preGateJobFromRow (the rehearse CLI's read-only loading, task 3)", () => {
  // One of the two accounts in the live table (2026-11-09); the rehearsal must read only the row's owner.
  const OWNER = '0f4b24da-e85b-40bb-8606-c81824493b45';

  it("loads today's config through the gateway's own loader with ONLY owner-scoped SELECTs (zero writes), shaped like the live rows", async () => {
    // Every statement the adapter issues, recorded.
    const statements: string[] = [];
    // Answers like `supabase db query -o json` did on 2026-11-09: text[] as arrays, jsonb as an object.
    const run = (sql: string) => {
      // Recorded first.
      statements.push(sql);
      // The preferences row, or the ceiling rule.
      return sql.includes('from search_preferences')
        ? [{ titles: ['Software Engineer Intern'], keywords: ['TypeScript'], excluded_keywords: ['Senior'], work_authorized_countries: ['India', 'Nepal', 'Bhutan'], remote_location_policy: 'unlocked_or_authorized' }]
        : [{ config: { max_years: 1 } }];
    };
    // The real loader over the adapter.
    const loaded = await loadPreGatePreferences(sqlConfigReader(run, OWNER));
    // Mapped as the gateway maps it.
    expect(loaded).toMatchObject({ kind: 'ok', preferences: { workAuthorizedCountries: ['India', 'Nepal', 'Bhutan'], experienceMaxYears: 1 } });
    // THE READ-ONLY PROOF: exactly the loader's two reads.
    expect(statements).toHaveLength(2);
    // Each one a single SELECT, scoped to the owner, with no separator and no write keyword.
    for (const sql of statements) expect([/^select\s/i.test(sql), sql.includes(`user_id = '${OWNER}'`), sql.includes(';'), /\b(insert|update|delete|alter|drop|create|grant|truncate)\b/i.test(sql)]).toEqual([true, true, false, false]);
    // The ceiling read carries both of the loader's filters.
    expect(statements[1]).toContain("rule_type = 'experience_ceiling' and enabled = true");
  });

  it("fails closed: a failed read or two rows become the loader's error, and a non-uuid owner is refused", async () => {
    // A runner that throws, as the CLI's select does on a failed query.
    const failed = await loadPreGatePreferences(sqlConfigReader(() => { throw new Error('db down'); }, OWNER));
    // The loader's unreadable code, never "no config".
    expect(failed).toMatchObject({ kind: 'error', code: 'preferences_unreadable' });
    // Two rows: the unscoped-read symptom.
    const two = await loadPreGatePreferences(sqlConfigReader(() => [{}, {}], OWNER));
    // Also an error.
    expect(two).toMatchObject({ kind: 'error' });
    // An injected owner never reaches SQL.
    expect(() => sqlConfigReader(() => [], "x' or '1'='1")).toThrow(/not a uuid/);
  });

  it("preGateJobFromRow keeps the gate's fields as read and refuses a wrongly typed one", () => {
    // A live-shaped row.
    expect(preGateJobFromRow({ title: 'SDE', description_raw: 'JD', location_raw: null, min_experience_years: '8', discovered_via: 'manual' })).toEqual({ title: 'SDE', description_raw: 'JD', location_raw: null, min_experience_years: '8', discovered_via: 'manual' });
    // A number where text belongs is a wiring fault, not "unknown".
    expect(() => preGateJobFromRow({ title: 7 })).toThrow(/title is number/);
  });
});
