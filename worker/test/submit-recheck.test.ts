// B2, the worker's re-check right before a LIVE submit (P1-6, 2026-11-05).
//
// WHY: on 2026-11-05, 7 approved rows failed that day's work-auth gate and 17 may have been closed
// postings. Apply-on-approve drains the approved queue, so the applier must never be what ships them.
// Right before the first status write of a live submit, it re-runs the auditor's pre-gate (the
// matcher's three gates, today's config) and checks the opened page for a closed posting. Either
// failure parks the row at blocked_needs_human with the reason, and nothing is sent.
import { describe, expect, it, vi } from 'vitest';
// The re-check itself, and the function that calls it at the one place it belongs.
import { applyToOne, recheckBeforeSubmit, type ApplicationPage, type ApplierGateway, type ClaimedApplication, type SubmitResult } from '../src/apply-one.ts';
// A real-shaped tailored resume.
import { syntheticResume } from './resolved-resume-fixture.ts';
// The page and gateway sources, for the shape pins below.
import { readFileSync } from 'node:fs';
// The closed-posting phrases the real page matches.
import { CLOSED_POSTING } from '../src/playwright-page.ts';

// Every gate open: no title list, no countries, any remote, no experience ceiling.
const OPEN = { titles: [], keywords: [], excludedKeywords: [], workAuthorizedCountries: null, remoteLocationPolicy: 'any', experienceMaxYears: null } as const;
// The same, with a two-year experience ceiling.
const CEILING_2 = { ...OPEN, experienceMaxYears: 2 };
// A job today's gates keep.
const KEPT_JOB = { title: 'Software Engineer', description_raw: 'Build backend services in Go.', location_raw: 'Remote', min_experience_years: null, discovered_via: null };
// A job the experience ceiling drops (8 years against a 2-year ceiling).
const SENIOR_JOB = { ...KEPT_JOB, description_raw: 'Requires 8+ years of experience.', min_experience_years: 8 };

/* A claimed row carrying its job. */
function row(preGateJob: Exclude<ClaimedApplication['preGateJob'], undefined>): ClaimedApplication {
  // Only what applyToOne and the re-check read.
  return { id: 'app-1', status: 'approved', applyUrl: 'http://127.0.0.1:1/form.html', tailoredProfile: syntheticResume, employerName: 'Acme', atsProvider: null, preGateJob };
}

/* A plain, answerable form page; `closed` scripts the liveness answer. */
function page(closed: string | null | 'absent' = null) {
  // Spied: the one thing that must never happen when the re-check fails.
  const submit = vi.fn(async (): Promise<SubmitResult> => ({ kind: 'confirmed', evidence: 'test' }));
  // The page.
  const p: ApplicationPage = {
    goto: async () => {},
    // One answerable field, so the row would otherwise submit.
    // An optional Email field too: the form-shape gate (no_email_field, 2026-11-09) refuses a page without one.
    // And a Resume file input: the no_resume_field gate (2026-11-10) refuses a form with nowhere to attach the resume;
    // the row carries tailoredProfile and the deps fake renderResume/uploadResume/attachFile, so the attach resolves.
    extractFields: async () => [{ id: 'first_name', label: 'First Name', kind: 'text', required: true }, { id: 'email', label: 'Email', kind: 'email', required: false }, { id: 'resume', label: 'Resume', kind: 'file', required: true }] as never,
    fill: async () => {},
    attachFile: async () => {},
    screenshot: async () => new Uint8Array([1, 2, 3]),
    detectBlocker: async () => null,
    submit,
    submissionImplemented: true,
    // The liveness seam, unless a test drops it.
    ...(closed === 'absent' ? {} : { postingClosed: async () => closed }),
  };
  // Both.
  return { page: p, submit };
}

/* A gateway that records every status write with its detail. */
function gateway() {
  // to + detail, in order.
  const writes: { to: string; detail: Record<string, unknown> | undefined }[] = [];
  // The gateway.
  const g: ApplierGateway = {
    advanceStatus: async (_id, to, _agent, detail) => { writes.push({ to, detail }); },
    releaseClaim: async () => {},
    uploadScreenshot: async () => 'screens/app-1.png',
    uploadResume: async () => 'resumes/app-1.pdf',
    setArtifactPaths: async () => {},
  };
  // Both.
  return { gateway: g, writes };
}

// The answer bank entry that answers the one field.
// T8 (2026-11-10): the planner fills only from human-attested rows, so this fixture row is attested.
const ANSWERS = [{ question_key: 'first_name', answer_value: 'Teja', needs_human: false, answer_type: 'text', attested_by_human: true }] as never;
// The common input for a run.
const base = (r: ClaimedApplication, p: ApplicationPage, g: ApplierGateway, live: boolean) => ({
  row: r, page: p, gateway: g, answers: ANSWERS, env: { DRY_RUN: live ? 'false' : 'true' },
  renderResume: async () => ({ bytes: new Uint8Array([37, 80, 68, 70]), sha256: 'a'.repeat(64) }),
  checkRobots: async () => ({ kind: 'allow' as const, reason: 'test', crawlDelayMs: null }),
});

describe('recheckBeforeSubmit', () => {

  it("a job today's gates drop: pre_gate, with the gate's own code and reason", async () => {
    // The experience ceiling.
    expect(await recheckBeforeSubmit(row(SENIOR_JOB), page().page, { preferences: CEILING_2 })).toEqual({ recheck: 'pre_gate', code: 'experience_ceiling', reason: 'JD requires 8 years, ceiling is 2' });
  });

  it('a row whose job could not be read: refused, never passed (CLAUDE.md §6)', async () => {
    // The gateway set the key, but no job came back.
    expect((await recheckBeforeSubmit(row(null), page().page, { preferences: OPEN }))?.code).toBe('job_unreadable');
  });

  it('a kept job on a closed posting page: posting_closed, with what the page said', async () => {
    // The page says it is closed.
    expect(await recheckBeforeSubmit(row(KEPT_JOB), page('page says: no longer accepting applications').page, { preferences: OPEN })).toEqual({ recheck: 'posting_closed', code: 'posting_closed', reason: 'page says: no longer accepting applications' });
  });

  it('a kept job on a live page: nothing to say', async () => {
    // Open page, open gates.
    expect(await recheckBeforeSubmit(row(KEPT_JOB), page(null).page, { preferences: OPEN })).toBeNull();
  });
});

describe('applyToOne runs the re-check before a LIVE submit', () => {
  it("a job today's gates drop is parked at blocked_needs_human, never submitted", async () => {
    // A live run over a dropping job.
    const { page: p, submit } = page(null);
    // Recorded writes.
    const { gateway: g, writes } = gateway();
    // Run.
    const outcome = await applyToOne({ ...base(row(SENIOR_JOB), p, g, true), recheck: { preferences: CEILING_2 } });
    // Parked, as "other" with the machine key in the detail.
    expect(outcome.kind).toBe('blocked');
    // One write, straight to the human queue.
    expect(writes.map((w) => w.to)).toEqual(['blocked_needs_human']);
    // The reason travels to the event, so the human sees why.
    expect(writes[0]!.detail).toMatchObject({ block_reason: 'other', recheck: 'pre_gate', code: 'experience_ceiling' });
    // Nothing went out.
    expect(submit).not.toHaveBeenCalled();
  });

  it('a closed posting is parked, never submitted', async () => {
    // A live run over a closed page.
    const { page: p, submit } = page('HTTP 404 on the form page');
    // Recorded writes.
    const { gateway: g, writes } = gateway();
    // Run.
    await applyToOne({ ...base(row(KEPT_JOB), p, g, true), recheck: { preferences: OPEN } });
    // Parked with the page's reason.
    expect(writes[0]).toMatchObject({ to: 'blocked_needs_human', detail: { recheck: 'posting_closed', reason: 'HTTP 404 on the form page' } });
    // Nothing went out.
    expect(submit).not.toHaveBeenCalled();
  });

  it('a kept job on a live page still submits (the positive shape: "park everything" fails here)', async () => {
    // A live run, everything fine.
    const { page: p, submit } = page(null);
    // Recorded writes.
    const { gateway: g } = gateway();
    // Run.
    await applyToOne({ ...base(row(KEPT_JOB), p, g, true), recheck: { preferences: OPEN } });
    // Sent.
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('a LIVE applyToOne without the re-check config throws before any status write (fail closed)', async () => {
    // A live run, no config handed in.
    const { page: p, submit } = page(null);
    // Recorded writes.
    const { gateway: g, writes } = gateway();
    // Refused.
    await expect(applyToOne(base(row(KEPT_JOB), p, g, true))).rejects.toThrow(/pre-submit re-check missing/);
    // No status written, nothing sent.
    expect(writes).toEqual([]);
    // Nothing sent.
    expect(submit).not.toHaveBeenCalled();
  });

  it('a DRY run never parks for the re-check (a dry run writes no status)', async () => {
    // A dry run over a dropping job.
    const { page: p, submit } = page(null);
    // Recorded writes.
    const { gateway: g, writes } = gateway();
    // Run.
    const outcome = await applyToOne({ ...base(row(SENIOR_JOB), p, g, false), recheck: { preferences: CEILING_2 } });
    // The dry-run outcome, untouched.
    expect(outcome.kind).toBe('dry_run_complete');
    // No status write, no submit.
    expect(writes).toEqual([]);
    // Nothing sent.
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('the production seams always supply the re-check (the optional fields are only absent in fakes)', () => {
  it('the real page implements postingClosed', () => {
    // The Playwright page factory's source.
    const source = readFileSync(new URL('../src/playwright-page.ts', import.meta.url), 'utf8');
    // The method on the returned object.
    expect(source).toMatch(/async postingClosed\(\)/);
  });

  it('the real gateway reads the pre-gate fields and sets preGateJob on every claimed row', () => {
    // The Supabase gateway's source.
    const source = readFileSync(new URL('../src/supabase-gateway.ts', import.meta.url), 'utf8');
    // The four gate fields and the human-picked marker ride the jobs read.
    expect(source).toMatch(/select\('id, apply_url, disappeared_at, company_name, ats_provider, title, description_raw, location_raw, min_experience_years, discovered_via'\)/);
    // The key is always set (null when the job is missing), so "absent" can only be a fake.
    expect(source).toMatch(/preGateJob: preGateJobOf\(/);
    // And it loads the preferences.
    expect(source).toMatch(/async loadPreGatePreferences\(\)/);
  });

  it('the claim loop hands the re-check to every live applyToOne', () => {
    // The loop's source.
    const source = readFileSync(new URL('../src/claim-loop.ts', import.meta.url), 'utf8');
    // The one production call site passes it.
    expect(source).toMatch(/applyToOne\(\{ row, page, gateway, answers, profile, env, renderResume, checkRobots, resolveFormUrl, recheck \}\)/);
  });
});

describe('CLOSED_POSTING: the sentences a closed posting shows, and only those', () => {
  it('matches the closed notices the ATS boards print', () => {
    // Greenhouse, Lever, Ashby and generic job-page phrasings.
    for (const text of ['This job is no longer accepting applications.', 'Sorry, this position has been filled.', 'The job posting is no longer available', 'This job has expired', 'Job not found', "The page you're looking for can't be found"]) {
      // Each one matches.
      expect(CLOSED_POSTING.test(text), text).toBe(true);
    }
  });

  it('does not match a live description that merely uses the words', () => {
    // Words a real JD uses.
    for (const text of ['You will fill roles across teams.', 'Expired tokens are rotated automatically.', 'We are no longer a startup: 500 people, still growing.', 'Apply now: positions open in Pune.']) {
      // None matches.
      expect(CLOSED_POSTING.test(text), text).toBe(false);
    }
  });
});
