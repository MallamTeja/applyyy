// Tests for the assisted-submit rehearsal (src/assist/rehearse.ts): it must run assist's steps up to the
// click and be UNABLE to fill, attach, submit, claim or advance (2026-11-07, first bot submit readiness).
import { describe, expect, it, vi } from 'vitest';
// The rehearsal and its read-only page adapter.
import { readOnlyPage, rehearseAssisted, type RehearsalInput } from '../src/assist/rehearse.ts';
// The full page port, so the fake has every method a real page has, writes included.
import type { ApplicationPage } from '../src/apply-one.ts';
// A real-shaped resume.
import { syntheticResume } from './resolved-resume-fixture.ts';
// The master shape.
import type { MasterProfile } from '@applyy/shared-types';

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
  };
}

describe('rehearseAssisted', () => {
  it('the port it is handed carries NO write method at runtime (structural, not a flag)', () => {
    // Built from a full page that does have them.
    const { page } = fullPage();
    // Exactly the three reads, nothing else on the object.
    expect(Object.keys(readOnlyPage(page)).sort()).toEqual(['detectBlocker', 'extractFields', 'goto']);
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
