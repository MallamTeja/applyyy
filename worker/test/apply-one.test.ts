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
import {
  // Renamed: the local applyToOne below wraps it with a default robots check.
  applyToOne as applyToOneRequired,
  type ApplyToOneInput,
  // The typed "provably selected nothing" error, the only one that may leave an optional EEO field blank.
  OptionNotFoundError,
  type ApplicationPage,
  type ApplierGateway,
  type ArtifactPaths,
  type ResumeRenderer,
  type SubmitResult,
} from '../src/apply-one.ts';

// The robots gate is REQUIRED on the real function. These tests are about the form, not
// robots, so they get an "allow" by default; a test can still pass its own checkRobots.
// Robots behaviour itself is tested in apply-one-robots.test.ts.
const applyToOne = (input: Omit<ApplyToOneInput, 'checkRobots'> & Partial<Pick<ApplyToOneInput, 'checkRobots'>>) =>
  // Spread last, so an explicit checkRobots in a test wins over the default.
  // recheck: an open config, so live tests are not refused by B2's fail-closed rule (their subject is elsewhere).
  applyToOneRequired({ checkRobots: async () => ({ kind: 'allow', reason: 'test default', crawlDelayMs: null }), recheck: OPEN_RECHECK, ...input });
import type { FormField } from '../src/extract-fields.ts';
// MasterProfile for the employer-wiring tests, which hand the planner a work history.
import type { AnswerBankRow, MasterProfile, ResolvedResume } from '@applyy/shared-types';
// The pinned snapshot the resume is rendered FROM. A real ResolvedResume rather
// than a stub, so a renderer that actually reads it behaves as it will in
// production.
import { syntheticResume } from './resolved-resume-fixture.ts';
// Every live test hands in an open re-check config (B2 fails closed without one).
import { OPEN_RECHECK } from './open-pregate.ts';


/** A form the answer bank can fully satisfy, so nothing blocks by accident. */
/**
 * Every real application form asks for an email; without one the form-shape gate (no_email_field, 2026-11-09)
 * refuses the page before any planner runs. Each fake form below carries this one, OPTIONAL so the planner
 * never blocks on it and no test's blocker list changes. Explicit per form, never appended by fakePage, so
 * the gate stays visible to every test that drops it on purpose.
 */
const EMAIL_FIELD: FormField = { id: 'email', label: 'Email', kind: 'email', required: false };

/**
 * Every real application form also shows a resume upload; without one the form-shape gate (no_resume_field,
 * 2026-11-10) reads the page as a job-alerts or newsletter signup and refuses it before any planner runs.
 * Same contract as EMAIL_FIELD: listed explicitly in each fake form meant to be a real application, never
 * appended by fakePage, so the tests that drop it on purpose still read as dropping it.
 */
// id 'resume' matches the attachment planner's resume pattern, so the box is placeable rather than an
// unplaceable_document_field blocker; OPTIONAL, as the real Greenhouse wrapper reads (aria-required="false").
const RESUME_FIELD: FormField = { id: 'resume', label: 'Resume', kind: 'file', required: false };

const answerableForm: FormField[] = [
  { id: 'first_name', label: 'First Name', kind: 'text', required: true },
  // The form-shape gate's email box (see EMAIL_FIELD).
  EMAIL_FIELD,
  // The form-shape gate's resume upload (see RESUME_FIELD); planFill skips files, so the fills are unchanged.
  RESUME_FIELD,
];

/** The matching bank. Real rows carry more columns; the planner reads four. */
const answers = [
  // T8 (2026-11-10): the planner fills only from human-attested rows, so this fixture row is attested.
  { question_key: 'first_name', answer_value: 'Teja', needs_human: false, answer_type: 'text', attested_by_human: true },
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
  // Defaults to a CONFIRMED page, the only result that may become `applied`;
  // the tests for every other SubmitResult override it explicitly.
  const submit = vi.fn(async (): Promise<SubmitResult> => ({ kind: 'confirmed', evidence: 'test' }));
  const page: ApplicationPage = {
    goto: async () => {},
    extractFields: async () => answerableForm,
    fill: async () => {},
    // The other operation that reaches a real employer. Spied for the same
    // reason as submit: "did a document go out, and which one".
    attachFile: async () => {},
    screenshot: async () => new Uint8Array([1, 2, 3]),
    // No captcha by default; the blocking tests override this.
    detectBlocker: async () => null,
    submit,
    // True so the submit-path tests below exercise a page that CAN send; the
    // unimplemented case overrides it and asserts nothing moves.
    submissionImplemented: true,
    ...overrides,
  };
  return { page, submit };
}

/**
 * A fake renderer that records every snapshot it was asked to render.
 *
 * Records the ARGUMENT, not just the call count, because the property under test
 * is which SOURCE the resume came from — the pinned `tailored_profile` and never
 * a stored file. A call-counting spy cannot tell those apart.
 */
function fakeRenderer(bytes = new Uint8Array([37, 80, 68, 70, 45])) {
  const rendered: ResolvedResume[] = [];
  const render: ResumeRenderer = async (resume) => {
    rendered.push(resume);
    // A fixed digest: this fake is not testing hashing (render-resume-pdf.test
    // .ts does that against real bytes), it is testing what gets recorded.
    return { bytes, sha256: 'a'.repeat(64) };
  };
  return { render, rendered, bytes };
}

/** Records every status transition attempted, so ORDER can be asserted. */
function fakeGateway() {
  const transitions: string[] = [];
  const released: string[] = [];
  // The evidence writes, and the ORDER they interleave with the release. Both
  // matter: the paths must be recorded at all (they were not, for the whole of
  // the dry-run period), and they must be recorded while the lease is still
  // ours to write under.
  const artifactWrites: Array<{ id: string; paths: ArtifactPaths }> = [];
  const ordered: string[] = [];
  const gateway: ApplierGateway = {
    advanceStatus: async (_id, to) => {
      transitions.push(to);
    },
    releaseClaim: async (id) => {
      released.push(id);
      ordered.push('release');
    },
    uploadScreenshot: async () => 'screens/app-1.png',
    uploadResume: async () => 'resumes/app-1.pdf',
    setArtifactPaths: async (id, paths) => {
      artifactWrites.push({ id, paths });
      ordered.push('set_paths');
    },
  };
  return { transitions, released, artifactWrites, ordered, gateway };
}

/** The claimed row under test, carrying the snapshot the human approved. */
const row = {
  id: 'app-1',
  status: 'approved',
  applyUrl: 'http://127.0.0.1:1/form.html',
  tailoredProfile: syntheticResume,
  // The employer the planner checks "previously worked at" against; any real name works here.
  employerName: 'GitLab',
  atsProvider: null, // Not a Workday row: the Workday guard stays out of the way.
} as const;

/** A form that asks for a resume, exactly as the real Greenhouse DOM presents it. */
const formWithResumeUpload: FormField[] = [
  { id: 'first_name', label: 'First Name', kind: 'text', required: true },
  // Labelled 'Attach', because that is genuinely all the extractor recovers —
  // see attach-resume-real-form.test.ts, which measures it against the live DOM.
  { id: 'resume', label: 'Attach', kind: 'file', required: false },
  { id: 'cover_letter', label: 'Attach', kind: 'file', required: false },
  // The form-shape gate's email box (see EMAIL_FIELD).
  EMAIL_FIELD,
];

describe('applyToOne', () => {
  it('never submits and never touches the status graph when DRY_RUN is unset', async () => {
    const { page, submit } = fakePage();
    const { gateway, transitions, released } = fakeGateway();

    const outcome = await applyToOne({
      row,
      page,
      gateway,
      answers,
      renderResume: fakeRenderer().render,
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

    await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    expect(submit).toHaveBeenCalledTimes(1);
    // The full legal path: into `applying`, then to `applied`.
    expect(transitions).toEqual(['applying', 'applied']);
  });

  it('takes the dry-run exit when DRY_RUN=false but the page cannot submit', async () => {
    // The live bug: the real page's submit always throws, but the row was moved
    // to `applying` first and then reported as an UNKNOWN outcome — parked for
    // a human to verify something that provably never went out.
    const { page, submit } = fakePage({ submissionImplemented: false });
    const { gateway, transitions, released } = fakeGateway();

    const outcome = await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // Never reached, so it can never throw inside the non-idempotent window.
    expect(submit).not.toHaveBeenCalled();
    // The structural half: no `approved -> applying`, so nothing to strand.
    expect(transitions).toEqual([]);
    // Lease handed back, row still `approved` for the run that can send.
    expect(released).toEqual(['app-1']);
    // Reported as a dry run, and the reason says the opt-in was overridden.
    expect(outcome).toMatchObject({ kind: 'dry_run_complete', reason: expect.stringMatching(/no submit implementation/) });
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
        // A confirmed page, so the run proceeds to the `applied` write under test.
        return { kind: 'confirmed', evidence: 'test' } as const;
      },
    });
    const gateway: ApplierGateway = {
      advanceStatus: async (_id, to) => {
        observed.push(to);
      },
      releaseClaim: async () => {},
      uploadScreenshot: async () => 'screens/app-1.png',
      uploadResume: async () => 'resumes/app-1.pdf',
      // Present so the literal satisfies the port. These tests are about the
      // submit path, where the evidence write is not the property under test.
      setArtifactPaths: async () => {},
    };

    await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

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

    const outcome = await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

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

    const outcome = await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    expect(submit).not.toHaveBeenCalled();
    // ONE write, straight from `approved` (M3): a pre-fill park never enters
    // the non-idempotent `applying` state. The guard refuses an illegal edge, so
    // reaching this write at all proves `approved -> blocked_needs_human` was it.
    expect(transitions).toEqual(['blocked_needs_human']);
    expect(outcome.kind).toBe('blocked');
  });

  it('parks an unanswerable required question rather than guessing', async () => {
    // Constraint #4, end to end. The planner has no branch that invents a
    // value, so an unanswered required field can only become a blocker.
    const { page, submit } = fakePage({
      extractFields: async () => [
        { id: 'ctc', label: 'Expected CTC', kind: 'text', required: true },
        // The form-shape gate's email box (see EMAIL_FIELD).
        EMAIL_FIELD,
        // The form-shape gate's resume upload (see RESUME_FIELD), so the park is for the CTC question alone.
        RESUME_FIELD,
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
      renderResume: fakeRenderer().render,
    });

    expect(submit).not.toHaveBeenCalled();
    // ONE write, straight from `approved` (M3): a pre-fill park never enters
    // the non-idempotent `applying` state. The guard refuses an illegal edge, so
    // reaching this write at all proves `approved -> blocked_needs_human` was it.
    expect(transitions).toEqual(['blocked_needs_human']);
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
        // The form-shape gate's email box (see EMAIL_FIELD).
        EMAIL_FIELD,
        // The form-shape gate's resume upload (see RESUME_FIELD), so 'Expected CTC' stays the only blocker.
        RESUME_FIELD,
      ],
    });
    const { gateway, transitions } = fakeGateway();

    const outcome = await applyToOne({ row, page, gateway, answers: [], env: {}, renderResume: fakeRenderer().render });

    expect(submit).not.toHaveBeenCalled();
    expect(transitions).toHaveLength(0);
    // The blockers ride out on the outcome so the run summary can log them.
    expect(outcome.kind).toBe('dry_run_complete');
    if (outcome.kind === 'dry_run_complete') {
      expect(outcome.blockers.map((blocker) => blocker.label)).toEqual(['Expected CTC']);
    }
  });
});

/**
 * The resume wiring.
 *
 * THE DEFECT THIS SUITE EXISTS TO PREVENT is the one this file's header already
 * describes, repeated with a different guard: `render-resume-pdf.ts` was
 * complete, correct and tested, and `apply-one.ts` never called it. The suite
 * was green throughout. Every test below is about the CALL, not the renderer.
 */
describe('applyToOne — the resume', () => {
  it('renders and attaches the resume BEFORE the row enters `applying`', async () => {
    // THE ORDERING CONSTRAINT, and the most important assertion in this file.
    // `applying` is the only non-idempotent state: a row stranded there is swept
    // to `needs_verification`, which is human-only, and Teja must then open the
    // employer's site and check by hand whether an application went out. Every
    // fallible operation inside that window is a new way to manufacture that
    // question — and rendering IS fallible, since a stale `schema_version`
    // throws ResumeRenderError by design.
    //
    // A test that only asserted "the resume was attached" would pass just as
    // well with the render moved inside the window. The interleaving is the
    // property under test, so the whole sequence is asserted.
    const observed: string[] = [];
    const renderer = fakeRenderer();
    const { page } = fakePage({
      extractFields: async () => formWithResumeUpload,
      fill: async () => {
        observed.push('fill');
      },
      attachFile: async () => {
        observed.push('attach');
      },
      screenshot: async () => {
        observed.push('screenshot');
        return new Uint8Array([1, 2, 3]);
      },
      submit: async () => {
        observed.push('submit');
        // A confirmed page, so the sequence runs all the way to `applied`.
        return { kind: 'confirmed', evidence: 'test' } as const;
      },
    });
    const gateway: ApplierGateway = {
      advanceStatus: async (_id, to) => {
        observed.push(to);
      },
      releaseClaim: async () => {},
      uploadScreenshot: async () => 'screens/app-1.png',
      uploadResume: async () => {
        observed.push('upload_resume');
        return 'resumes/app-1.pdf';
      },
      // Recorded in the same sequence as everything else, so if the evidence
      // write ever moves onto the submit path the ordering assertion below
      // catches it rather than silently absorbing a new step.
      setArtifactPaths: async () => {
        observed.push('set_paths');
      },
    };

    await applyToOne({
      row,
      page,
      gateway,
      answers,
      env: { DRY_RUN: 'false' },
      renderResume: async (resume) => {
        observed.push('render');
        return renderer.render(resume);
      },
    });

    // Everything learnable happens while the row is still `approved`, the
    // evidence write included; the window between `applying` and `applied`
    // holds the submit and the bounded confirmation screenshot, nothing else.
    expect(observed).toEqual([
      'fill',
      'render',
      'upload_resume',
      'attach',
      'screenshot',
      'set_paths',
      'applying',
      'submit',
      // The confirmation page, captured best-effort after a confirmed submit.
      'screenshot',
      'applied',
    ]);
  });

  it('an upload that never finishes stops the run BEFORE `applying`: no status write, no click', async () => {
    // THE GITLAB SAFETY PROPERTY. attachFile throws when Greenhouse's resume upload never
    // finishes (playwright-page.ts). Because the attach sits before `approved -> applying`,
    // that throw must leave the row untouched and unsent: no status write at all, and
    // submit() never called. The lease expires and the row stays `approved`.
    const submitted: string[] = [];
    const { page } = fakePage({
      extractFields: async () => formWithResumeUpload,
      attachFile: async () => {
        throw new Error('file upload "Resume/CV" (#resume) did not finish within 30000ms');
      },
      submit: async () => {
        submitted.push('submit');
        return { kind: 'confirmed', evidence: 'test' } as const;
      },
    });
    const { transitions, gateway } = fakeGateway();

    // The throw propagates to the claim loop, which counts it as an error.
    await expect(
      applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render }),
    ).rejects.toThrow(/did not finish/);

    // No transition of any kind, and above all not `applying`.
    expect(transitions).toEqual([]);
    // And the one code path that sends an application never ran.
    expect(submitted).toEqual([]);
  });

  it('renders from the pinned tailored_profile, not from any stored artifact', async () => {
    // THE CENTRAL GUARANTEE: "what you approved is byte-for-byte what gets
    // sent." It holds because the artifact is DERIVED from the immutable
    // snapshot the human reviewed. `resume_storage_path` is the record of what
    // was sent, never a source to read back from — a stored file can drift from
    // what was approved, and the drift would be invisible.
    //
    // Asserting on the renderer's ARGUMENT is what pins this down. A call count
    // would pass equally against an implementation that fetched a PDF from
    // storage and rendered something else entirely.
    const renderer = fakeRenderer();
    const { page } = fakePage({ extractFields: async () => formWithResumeUpload });
    const { gateway } = fakeGateway();

    await applyToOne({
      row,
      page,
      gateway,
      answers,
      env: { DRY_RUN: 'false' },
      renderResume: renderer.render,
    });

    // Exactly one render, from exactly the row's snapshot — identity rather than
    // a structural match, so nothing could have re-derived or re-fetched it.
    expect(renderer.rendered).toHaveLength(1);
    expect(renderer.rendered[0]).toBe(row.tailoredProfile);
  });

  it('attaches the same bytes it rendered, to the resume input only', async () => {
    // The buffer that was hashed and uploaded is the buffer that reaches the
    // form. A re-render between those steps would produce a second artifact, and
    // the recorded digest would then describe a file nobody kept.
    const renderer = fakeRenderer();
    const attached: Array<{ id: string; name: string; bytes: Uint8Array }> = [];
    const { page } = fakePage({
      extractFields: async () => formWithResumeUpload,
      attachFile: async (id, file) => {
        attached.push({ id, name: file.name, bytes: file.bytes });
      },
    });
    const { gateway } = fakeGateway();

    await applyToOne({
      row,
      page,
      gateway,
      answers,
      env: { DRY_RUN: 'false' },
      renderResume: renderer.render,
    });

    // ONE attachment, on the resume input. The cover-letter field is present in
    // the form above and must be left alone: we have no cover letter to send,
    // and putting the resume there would file it as the wrong document.
    expect(attached).toHaveLength(1);
    expect(attached[0]?.id).toBe('resume');
    // Identity, not equality: the very same buffer that was hashed.
    expect(attached[0]?.bytes).toBe(renderer.bytes);
    // The deterministic filename derived from the approved snapshot alone.
    expect(attached[0]?.name).toBe('Ada Placeholder Resume.pdf');
  });

  it('records the resume path and digest in the same write that says `applied`', async () => {
    // The path answers "where is the file"; the digest answers "is this the
    // artifact that was approved?" — the question actually asked months later
    // when a recruiter mentions something on the resume. Written in the SAME
    // status write that asserts the application was sent, so the two cannot
    // disagree about what went out.
    const details: Array<Record<string, unknown> | undefined> = [];
    const { page } = fakePage({ extractFields: async () => formWithResumeUpload });
    const gateway: ApplierGateway = {
      advanceStatus: async (_id, to, _agent, detail) => {
        if (to === 'applied') details.push(detail);
      },
      releaseClaim: async () => {},
      uploadScreenshot: async () => 'screens/app-1.png',
      uploadResume: async () => 'resumes/app-1.pdf',
      // Present so the literal satisfies the port. These tests are about the
      // submit path, where the evidence write is not the property under test.
      setArtifactPaths: async () => {},
    };

    await applyToOne({
      row,
      page,
      gateway,
      answers,
      env: { DRY_RUN: 'false' },
      renderResume: fakeRenderer().render,
    });

    expect(details[0]?.resume_storage_path).toBe('resumes/app-1.pdf');
    expect(details[0]?.resume_sha256).toBe('a'.repeat(64));
  });

  it('renders and attaches in dry-run too, and still writes no status', async () => {
    // §18.6's whole purpose is showing Teja exactly what WOULD have been sent,
    // so a dry run that skipped the resume would leave the review unable to
    // check the one artifact that matters most. Attaching sends nothing: the
    // submit path is never reached.
    const renderer = fakeRenderer();
    const attached: string[] = [];
    const { page, submit } = fakePage({
      extractFields: async () => formWithResumeUpload,
      attachFile: async (id) => {
        attached.push(id);
      },
    });
    const { gateway, transitions, released } = fakeGateway();

    const outcome = await applyToOne({
      row,
      page,
      gateway,
      answers,
      env: {},
      renderResume: renderer.render,
    });

    // Rendered and attached...
    expect(renderer.rendered).toHaveLength(1);
    expect(attached).toEqual(['resume']);
    // ...and nothing was sent, and the row did not move.
    expect(submit).not.toHaveBeenCalled();
    expect(transitions).toHaveLength(0);
    expect(released).toEqual(['app-1']);

    // The artifact rides out on the outcome, because a dry run writes nothing to
    // the row — without this the PDF would be produced and then unreferenced by
    // anything Teja can see.
    expect(outcome.kind).toBe('dry_run_complete');
    if (outcome.kind === 'dry_run_complete') {
      expect(outcome.resumePath).toBe('resumes/app-1.pdf');
      expect(outcome.resumeSha256).toBe('a'.repeat(64));
    }
  });

  it('does not render for an application it is about to park', async () => {
    // A captcha means this application is not going out, so paying for a PDF
    // would be waste — and worse, it would upload an artifact that was never
    // attached to anything, which reads in storage exactly like one that was.
    const renderer = fakeRenderer();
    const { page } = fakePage({
      extractFields: async () => formWithResumeUpload,
      detectBlocker: async () => 'captcha',
    });
    const { gateway, transitions } = fakeGateway();

    const outcome = await applyToOne({
      row,
      page,
      gateway,
      answers,
      env: { DRY_RUN: 'false' },
      renderResume: renderer.render,
    });

    expect(renderer.rendered).toHaveLength(0);
    // ONE write, straight from `approved` (M3): a pre-fill park never enters
    // the non-idempotent `applying` state. The guard refuses an illegal edge, so
    // reaching this write at all proves `approved -> blocked_needs_human` was it.
    expect(transitions).toEqual(['blocked_needs_human']);
    expect(outcome.kind).toBe('blocked');
  });

  it('parks the row when the form wants a resume and the snapshot is missing', async () => {
    // A row approved with a null `tailored_profile` cannot produce a resume. The
    // failure must not be "attach nothing and submit anyway": an application
    // sent with an empty resume box, to an employer who explicitly asked for
    // one, is worse than an application not sent — and no retry undoes it.
    const renderer = fakeRenderer();
    const { page, submit } = fakePage({ extractFields: async () => formWithResumeUpload });
    const { gateway, transitions } = fakeGateway();

    const outcome = await applyToOne({
      // The one field that differs from the happy path above.
      row: { ...row, tailoredProfile: null },
      page,
      gateway,
      answers,
      env: { DRY_RUN: 'false' },
      renderResume: renderer.render,
    });

    // Nothing rendered, nothing sent, and the row is with a human.
    expect(renderer.rendered).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
    // ONE write, straight from `approved` (M3): a pre-fill park never enters
    // the non-idempotent `applying` state. The guard refuses an illegal edge, so
    // reaching this write at all proves `approved -> blocked_needs_human` was it.
    expect(transitions).toEqual(['blocked_needs_human']);
    expect(outcome.kind).toBe('blocked');
    // The blocker names the reason, so the queue shows WHY rather than just that.
    if (outcome.kind === 'blocked') {
      expect(outcome.blockers.map((blocker) => blocker.reason)).toContain('no_resume_snapshot');
    }
  });
});

/**
 * The evidence write on the dry-run path.
 *
 * THE DEFECT THIS BLOCK EXISTS TO PREVENT, stated exactly: the screenshot and
 * the resume were uploaded, their paths were returned, and NOTHING PERSISTED
 * THEM. The only code that put either path near the database was the
 * `applying -> applied` transition detail — and `if (!mode.submits)` returns
 * roughly eighty lines earlier, so with DRY_RUN absolute (constraint #16) that
 * line has never once executed. Real bytes in storage, two empty columns, and
 * a fully green suite the whole time, because every existing test asserted on
 * the UPLOAD and none on the RECORD.
 *
 * That is the same shape as this file's header story and as instance 1 of
 * docs/verification-traps.md: the thing everyone believed was protecting the
 * §18.6 review was never the thing doing it.
 */
describe('applyToOne — recording where the artifacts went', () => {
  it('records both storage paths on the dry-run path', async () => {
    // THE REGRESSION TEST. Without this call the trust period produces
    // screenshots Teja cannot navigate to from the application they document.
    const { page } = fakePage({ extractFields: async () => formWithResumeUpload });
    const { gateway, artifactWrites, transitions } = fakeGateway();

    await applyToOne({ row, page, gateway, answers, env: {}, renderResume: fakeRenderer().render });

    expect(artifactWrites).toHaveLength(1);
    expect(artifactWrites[0]?.id).toBe('app-1');
    expect(artifactWrites[0]?.paths.screenshotPath).toBe('screens/app-1.png');
    expect(artifactWrites[0]?.paths.resumePath).toBe('resumes/app-1.pdf');
    // And it did it WITHOUT moving the row, which is the half that makes the
    // fix legal at all: `approved -> applying` is the only edge out of
    // `approved`, so an evidence write that needed a transition could never run
    // in dry run. A bare UPDATE is exempted by the guard trigger, which returns
    // early on `new.status is not distinct from old.status`.
    expect(transitions).toHaveLength(0);
  });

  it('records the paths BEFORE releasing the claim', async () => {
    // The lease is what makes this row ours to write. Releasing first would
    // open a window in which the next run claims the row and writes its own
    // paths underneath ours — a lost update whose only symptom is evidence
    // pointing at the wrong file, which is worse than no evidence because it
    // reads as verified.
    //
    // The ORDER is the property, so the sequence is asserted rather than the
    // two facts separately; a test that only checked both happened would pass
    // with them the wrong way round.
    const { page } = fakePage({ extractFields: async () => formWithResumeUpload });
    const { gateway, ordered } = fakeGateway();

    await applyToOne({ row, page, gateway, answers, env: {}, renderResume: fakeRenderer().render });

    expect(ordered).toEqual(['set_paths', 'release']);
  });

  it('records the digest of the bytes it rendered, in dry run', async () => {
    // The digest is the field the §18.6 review cannot do without: the path
    // proves something was uploaded, the digest proves WHAT. Recorded on the
    // row by the same bare UPDATE as the paths, deliberately NOT only inside
    // the `applied` transition detail — which a dry run never reaches, and
    // which lands in `application_events` rather than on the application.
    //
    // Reported from the render's own result, not recomputed, so it describes
    // the buffer that was actually attached.
    const { page } = fakePage({ extractFields: async () => formWithResumeUpload });
    const { gateway, artifactWrites } = fakeGateway();

    await applyToOne({ row, page, gateway, answers, env: {}, renderResume: fakeRenderer().render });

    expect(artifactWrites[0]?.paths.resumeSha256).toBe('a'.repeat(64));
    // SHAPE, because the live column carries
    // `applications_resume_sha256_is_hex` (`^[0-9a-f]{64}$` or null). A
    // placeholder digest would satisfy the assertion above and be rejected by
    // the database with 23514, which no fake-client test can otherwise see.
    expect(artifactWrites[0]?.paths.resumeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a null resumePath when the form asked for no document', async () => {
    // THE NULL THAT MUST NOT ERASE ANYTHING. A form with no upload control
    // legitimately produces no resume, so this call carries `resumePath: null`
    // — and the gateway's job is to OMIT that key rather than write it, since
    // an earlier run of the same application may have recorded a real path.
    // Pinned here as well as in the gateway because this is where the null is
    // MANUFACTURED; the gateway test proves what is done with it.
    // Pinned to an explicit no-upload form, because the default answerableForm now carries RESUME_FIELD
    // (2026-11-10). Since the no_resume_field gate, this shape is refused in dry run before any render, so the
    // null here comes from a blocked dry run, still the path that manufactures it.
    const { page } = fakePage({ extractFields: async () => [answerableForm[0]!, EMAIL_FIELD] });
    const { gateway, artifactWrites } = fakeGateway();

    await applyToOne({ row, page, gateway, answers, env: {}, renderResume: fakeRenderer().render });

    expect(artifactWrites).toHaveLength(1);
    expect(artifactWrites[0]?.paths.resumePath).toBeNull();
    // NON-VACUITY HALF, in the same assertion pair: the screenshot path is
    // still real. Without it, an implementation that passed nulls for
    // everything would satisfy the line above perfectly.
    expect(artifactWrites[0]?.paths.screenshotPath).toBe('screens/app-1.png');
  });

  it('still records the screenshot for an application that would have blocked', async () => {
    // The §18.6 signal Teja most needs is the one for applications that did NOT
    // go out: the screenshot is the evidence of WHY. A blocked dry run renders
    // nothing, so `resumePath` is null here, and the screenshot path must
    // survive on its own — an implementation that only wrote paths when both
    // were present would lose exactly the interesting half of the trust period.
    const { page } = fakePage({ detectBlocker: async () => 'captcha' });
    const { gateway, artifactWrites, transitions } = fakeGateway();

    const outcome = await applyToOne({
      row,
      page,
      gateway,
      answers,
      env: {},
      renderResume: fakeRenderer().render,
    });

    expect(artifactWrites[0]?.paths.screenshotPath).toBe('screens/app-1.png');
    expect(artifactWrites[0]?.paths.resumePath).toBeNull();
    expect(transitions).toHaveLength(0);
    expect(outcome.kind).toBe('dry_run_complete');
  });
});

// FINDING D: the live filler throws when a planned value matches no option. That must park
// the row for the human, not escape to the claim loop and fail identically on every run.
describe('applyToOne — a fill the page rejects', () => {
  // A form whose one field has a bank answer, so the planner plans a fill that the page then rejects.
  // EMAIL_FIELD and RESUME_FIELD make it a real form shape, so the fill rejection is what stops it, not the gate.
  const countryForm: FormField[] = [{ id: 'q1', label: 'Country', kind: 'combobox', required: true }, EMAIL_FIELD, RESUME_FIELD];
  // The bank answer the page will refuse to select.
  const countryAnswers = [
    // A plausible-looking value the page rejects, as a near-miss option would be.
    // T8 (2026-11-10): the planner fills only from human-attested rows, so this fixture row is attested.
    { question_key: 'country', answer_value: 'Indo', needs_human: false, answer_type: 'text', attested_by_human: true },
  ] as unknown as AnswerBankRow[];

  /** A gateway that also records each transition's `detail`, which fakeGateway drops. */
  function detailGateway() {
    // Every advance with its detail, so the block_reason and unanswered list can be asserted.
    const advances: Array<{ to: string; detail: Record<string, unknown> | undefined }> = [];
    // Reuses the shared fake for every other port rather than re-implementing them.
    const { gateway } = fakeGateway();
    // Spread-and-override keeps this fake identical to fakeGateway except for the one method under test.
    const recording: ApplierGateway = {
      // Inherits release, uploads and artifact writes unchanged.
      ...gateway,
      // Captures detail, which fakeGateway discards but the block_reason assertion needs.
      advanceStatus: async (_id, to, _agent, detail) => {
        // Recorded rather than asserted inline so the test reads top-down.
        advances.push({ to, detail });
      },
    };
    // Both returned so the test can pass the gateway and inspect the log.
    return { gateway: recording, advances };
  }

  it('parks the row as unanswerable_question naming the field LABEL, outcome blocked', async () => {
    // The exact message shape the filler throws for an option mismatch.
    const { page, submit } = fakePage({
      // Gives the page the one field the planner will plan a fill for.
      extractFields: async () => countryForm,
      // Throws like the real filler does, instead of silently succeeding.
      fill: async () => {
        throw new Error('no_matching_option: q1: "Indo"');
      },
    });
    // Fresh recording gateway per test so transitions never leak between cases.
    const { gateway, advances } = detailGateway();

    // DRY_RUN false so the real park path runs, not the dry-run exit.
    const outcome = await applyToOne({ row, page, gateway, answers: countryAnswers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // Nothing may be submitted for a form that could not be filled.
    expect(submit).not.toHaveBeenCalled();
    // ONE write, straight from `approved` (M3): a fill that never completed
    // must not pass through `applying`, where a crash reads as a possible send.
    expect(advances.map((a) => a.to)).toEqual(['blocked_needs_human']);
    // The outcome kind is what the claim loop counts as parked rather than errored.
    expect(outcome.kind).toBe('blocked');
    // The RPC rejects a park without a block_reason, and the label (not "q1") is what the human reads.
    expect(advances[0]?.detail).toMatchObject({ block_reason: 'unanswerable_question', unanswered: ['Country'] });
  });

  // H2 (2026-11-06): the refused fields are reported to unanswered_questions before the park, and the
  // report is best-effort: a failed report must never skip the status write.
  it('reports the refused fields, and a rejected report still parks the row at blocked_needs_human', async () => {
    // One required question nothing can answer, plus the gate's email box and resume upload (a real form shape).
    const { page, submit } = fakePage({ extractFields: async () => [{ id: 'q9', label: 'Notice period?', kind: 'text', required: true }, EMAIL_FIELD, RESUME_FIELD] });
    // The recording gateway for the park.
    const { gateway, advances } = detailGateway();
    // What was reported, before the report fails.
    const reported: Array<{ id: string; keys: string[] }> = [];
    // The report rejects, as an unreachable RPC would.
    const failing: ApplierGateway = {
      ...gateway,
      recordUnansweredQuestions: async (id, blockers) => {
        // Recorded first, so the test sees what would have been sent.
        reported.push({ id, keys: blockers.map((blocker) => blocker.key) });
        // Then rejected.
        throw new Error('rpc down');
      },
    };
    // A live run, so the park path runs.
    const outcome = await applyToOne({ row, page, gateway: failing, answers: [], env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });
    // Nothing sent.
    expect(submit).not.toHaveBeenCalled();
    // The report named the question by the planner's key.
    expect(reported).toEqual([{ id: 'app-1', keys: ['notice_period'] }]);
    // And the park still happened, in one write.
    expect(advances.map((a) => a.to)).toEqual(['blocked_needs_human']);
    expect(outcome.kind).toBe('blocked');
  });

  it('rethrows any other error unchanged', async () => {
    // An unknown failure must not be relabelled as a form gap.
    const { page } = fakePage({
      // Gives the page the one field the planner will plan a fill for.
      extractFields: async () => countryForm,
      // Throws like the real filler does, instead of silently succeeding.
      fill: async () => {
        throw new Error('boom');
      },
    });
    // Fresh gateway per test; this case only needs it to exist.
    const { gateway } = detailGateway();

    // Asserted as a rejection because swallowing the error is the bug being guarded.
    await expect(
      applyToOne({ row, page, gateway, answers: countryAnswers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render }),
    ).rejects.toThrow('boom');
  });

  it('dry-run reports the blocker and a fill_rejected verdict, not a silent gap', async () => {
    // Same rejection, but with the dry-run default (env empty).
    const { page } = fakePage({
      // Gives the page the one field the planner will plan a fill for.
      extractFields: async () => countryForm,
      // Throws like the real filler does, instead of silently succeeding.
      fill: async () => {
        throw new Error('checkbox_not_autofilled: q1');
      },
    });
    // The plain fake suffices: a dry run must record no transitions at all.
    const { gateway, transitions } = fakeGateway();

    // Empty env is the dry-run default, the mode this system actually runs in.
    const outcome = await applyToOne({ row, page, gateway, answers: countryAnswers, env: {}, renderResume: fakeRenderer().render });

    // A dry run never moves the row, whatever happened to the fill.
    expect(transitions).toHaveLength(0);
    // The dry-run exit is still taken; only its verdict and blockers change.
    expect(outcome.kind).toBe('dry_run_complete');
    if (outcome.kind === 'dry_run_complete') {
      // The trust-period log must show this application would NOT have gone out, and why.
      // Named by the check that stopped it and the field it stopped on (task 2: a closed union, not a boolean).
      expect(outcome.verdict).toEqual({ kind: 'would_block', check: 'fill_rejected', detail: 'Country' });
      expect(outcome.blockers.map((b) => b.label)).toEqual(['Country']);
    }
  });
});

/**
 * What the page SHOWED after the click, mapped to the status write.
 *
 * submit() used to return void, so "the promise resolved" was read as "sent".
 * These tests pin the mapping from each SubmitResult to exactly one write (or
 * none), because the wrong mapping is either a false `applied` that cannot be
 * walked back, or a sent application parked as if it never went out.
 */
describe('applyToOne — the submit result', () => {
  /** A gateway that records every advance WITH its detail, plus the call order. */
  function resultGateway(uploadScreenshot?: ApplierGateway['uploadScreenshot']) {
    // Each advance with its detail, so block_reason and the evidence keys can be asserted.
    const advances: Array<{ to: string; detail: Record<string, unknown> | undefined }> = [];
    // Every gateway call in order, so "paths before applying" is a sequence, not two facts.
    const ordered: string[] = [];
    // Counts uploads so each gets a distinct path and the confirmation one is identifiable.
    let uploads = 0;
    const gateway: ApplierGateway = {
      // Records both the order and the detail of every status write.
      advanceStatus: async (_id, to, _agent, detail) => {
        // The sequence entry names the target status.
        ordered.push(`advance:${to}`);
        // The detail is kept for the field-level assertions.
        advances.push({ to, detail });
      },
      // Recorded, though no live-submit branch should release.
      releaseClaim: async () => {
        // A release here would be a bug the order assertion would show.
        ordered.push('release');
      },
      // Distinct path per call: the 1st is the filled form, the 2nd the confirmation page.
      uploadScreenshot:
        uploadScreenshot ??
        (async () => {
          // Counted so the two screenshots cannot be confused in an assertion.
          uploads += 1;
          // Numbered path, so the test can tell WHICH upload a detail points at.
          return `screens/app-1-${uploads}.png`;
        }),
      // The resume upload is not under test here. Since 2026-11-10 the default form carries RESUME_FIELD, so this
      // IS called on the live path; it records nothing into `ordered`, so the sequence assertions are unchanged.
      uploadResume: async () => 'resumes/app-1.pdf',
      // Recorded into the same sequence as the advances.
      setArtifactPaths: async () => {
        // Its position relative to `advance:applying` is the property under test.
        ordered.push('set_paths');
      },
    };
    // The gateway plus both logs.
    return { gateway, advances, ordered };
  }

  it('applyToOne: unconfirmed submit writes no status after applying', async () => {
    // The page gave no positive proof either way, so this is the same unknown
    // as a throw: `applied` would be a lie and `blocked`/`failed` would claim it
    // did not send. Only the sweeper -> needs_verification -> human may decide.
    const { page } = fakePage({ submit: async () => ({ kind: 'unconfirmed', detail: 'timed out' }) });
    // Fresh recording gateway for this case.
    const { gateway, advances } = resultGateway();

    // DRY_RUN false so the real submit path runs.
    const outcome = await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // Entered `applying` and wrote NOTHING after it.
    expect(advances.map((a) => a.to)).toEqual(['applying']);
    // Reported as unknown, carrying the page's own description for the log.
    expect(outcome).toEqual({ kind: 'submit_outcome_unknown', error: 'unconfirmed: timed out' });
  });

  it('applyToOne: rejected_by_form parks at blocked_needs_human with the labels', async () => {
    // The form refused in the browser, so nothing left the page and a human can
    // safely fix the named fields. Parking is correct; "unknown" would strand a
    // provably-unsent application in `applying` for a manual employer check.
    const { page } = fakePage({ submit: async () => ({ kind: 'rejected_by_form', labels: ['Email', 'Phone'] }) });
    // Fresh recording gateway for this case.
    const { gateway, advances } = resultGateway();

    // DRY_RUN false so the real submit path runs.
    const outcome = await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // Through `applying`, the only edge into the human queue.
    expect(advances.map((a) => a.to)).toEqual(['applying', 'blocked_needs_human']);
    // The labels the form flagged are what the human reads on the dashboard.
    expect(advances[1]?.detail).toMatchObject({
      block_reason: 'unanswerable_question',
      unanswered: ['Email', 'Phone'],
      submit_result: 'rejected_by_form',
    });
    // Counted as parked by the claim loop, not as an error or an unknown.
    expect(outcome.kind).toBe('blocked');
  });

  it('applyToOne: challenge parks as captcha', async () => {
    // Invisible reCAPTCHA escalated after the click. Constraint #5: never
    // solved, always a human's job; the form was not sent, so park it.
    const { page } = fakePage({ submit: async () => ({ kind: 'challenge', reason: 'captcha' }) });
    // Fresh recording gateway for this case.
    const { gateway, advances } = resultGateway();

    // DRY_RUN false so the real submit path runs.
    const outcome = await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // Parked through the one legal edge.
    expect(advances.map((a) => a.to)).toEqual(['applying', 'blocked_needs_human']);
    // The reason the page reported, and which post-click case it was.
    expect(advances[1]?.detail).toMatchObject({ block_reason: 'captcha', submit_result: 'challenge' });
    // The outcome's reason matches the row's, so the run summary agrees with the DB.
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'captcha' });
  });

  it('applyToOne: confirmed writes applied with confirmation_evidence', async () => {
    // The ONLY path to `applied`. The event must say WHY the system believed it
    // was sent (the matched page features) and point at the confirmation page.
    const evidence = 'url=https://x/jobs/1/confirmation heading="Thank you for applying"';
    // A page that positively confirmed.
    const { page } = fakePage({ submit: async () => ({ kind: 'confirmed', evidence }) });
    // Fresh recording gateway; its uploads are numbered.
    const { gateway, advances } = resultGateway();

    // DRY_RUN false so the real submit path runs.
    const outcome = await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // Into `applying`, then `applied`, nothing else.
    expect(advances.map((a) => a.to)).toEqual(['applying', 'applied']);
    // The evidence verbatim, the filled-form screenshot (upload 1) and the
    // confirmation screenshot (upload 2), each under its own key.
    expect(advances[1]?.detail).toMatchObject({
      confirmation_evidence: evidence,
      screenshot_storage_path: 'screens/app-1-1.png',
      confirmation_screenshot_path: 'screens/app-1-2.png',
    });
    // Counted as submitted by the claim loop.
    expect(outcome.kind).toBe('submitted');
  });

  it('applyToOne: confirmation screenshot failure still writes applied', async () => {
    // The application has GONE. A failed photo of that fact must not stop the
    // row saying so, or a sent application sits at `applying` and a human is
    // sent to check an employer site for something we already know.
    let calls = 0;
    // First upload (the filled form) succeeds; the second (confirmation) throws.
    const { gateway, advances } = resultGateway(async () => {
      // Counted so only the post-confirmation capture fails.
      calls += 1;
      // The second call is the confirmation capture.
      if (calls === 2) throw new Error('storage 503');
      // The pre-submit screenshot works normally.
      return 'screens/app-1-1.png';
    });
    // A confirmed page (the fake's default), the only path to the capture.
    const { page } = fakePage();

    // DRY_RUN false so the real submit path runs.
    const outcome = await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // The capture really was attempted twice (non-vacuity for the throw).
    expect(calls).toBe(2);
    // Still `applied`, with the missing evidence recorded as null.
    expect(advances.map((a) => a.to)).toEqual(['applying', 'applied']);
    // Null, never a stale or fabricated path.
    expect(advances[1]?.detail).toMatchObject({ confirmation_screenshot_path: null });
    // And the run counts it as sent.
    expect(outcome.kind).toBe('submitted');
  });

  it('applyToOne: setArtifactPaths runs before approved→applying on a live submit', async () => {
    // The evidence write used to live on the dry-run exit only, so a REAL
    // submission left the storage-path columns NULL. It must also land while
    // the row is still `approved`: a network write inside the applying window
    // is one more way to strand a row there.
    const { page } = fakePage();
    // Fresh recording gateway with the ordered log.
    const { gateway, ordered } = resultGateway();

    // DRY_RUN false so the live branch is the one asserted.
    await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // Exactly once, before `applying`, and no release on a live submit.
    expect(ordered).toEqual(['set_paths', 'advance:applying', 'advance:applied']);
  });
});

// ---- The employer name reaches the planner -------------------------------------
//
// planFill answers "previously worked at <company>?" only when it is told WHICH
// company the application is for. applyToOne is the one place that knows (the
// claimed row's employerName, read from jobs.company_name), so a wiring slip here
// would silently turn GitLab's required question back into a refusal. These two
// tests pin the wiring itself; plan-fill's own tests own the matching rules.
describe('applyToOne — the employer name reaches the planner', () => {
  // The exact required question on GitLab's form, as a yes/no group.
  const workedQ: FormField = {
    id: 'q-worked',
    label: 'Have you previously worked at or consulted for GitLab?',
    kind: 'radio_group',
    required: true,
    options: ['Yes', 'No'],
  };
  // A work history without GitLab in it, so the rule's answer is "No" from the profile.
  // Cast because only `experience[].company` is read by that rule.
  const profile = { experience: [{ id: 'e0', company: 'Aczen Technologies' }] } as unknown as MasterProfile;

  it('applyToOne: employerName "GitLab" lets the previously-worked question be answered', async () => {
    // The only field on the form, so any blocker below can only be this one.
    // presubmitFacts: the page's pre-click read comes back clean, so every live check passes (task 2).
    // RESUME_FIELD beside EMAIL_FIELD: the form-shape gate passes, so the verdict is the planner's alone.
    const { page } = fakePage({ extractFields: async () => [workedQ, EMAIL_FIELD, RESUME_FIELD], presubmitFacts: async () => ({ submitControls: 1, invalid: [], requiredEmpty: [] }) });
    // Dry run (env unset): the outcome reports viability without moving the row.
    const outcome = await applyToOne({
      row: { ...row, employerName: 'GitLab' },
      page,
      gateway: fakeGateway().gateway,
      answers: [],
      profile,
      env: {},
      renderResume: fakeRenderer().render,
    });
    // Viable, with nothing blocking: the employer reached the planner.
    expect(outcome).toMatchObject({ kind: 'dry_run_complete', verdict: { kind: 'would_submit' }, blockers: [] });
  });

  it('applyToOne: a null employerName refuses the previously-worked question', async () => {
    // Same form and profile; only the employer is unknown.
    // The same form shape as above, resume upload included, so only the employer differs.
    const { page } = fakePage({ extractFields: async () => [workedQ, EMAIL_FIELD, RESUME_FIELD] });
    // Dry run again, so the comparison with the test above is like for like.
    const outcome = await applyToOne({
      row: { ...row, employerName: null },
      page,
      gateway: fakeGateway().gateway,
      answers: [],
      profile,
      env: {},
      renderResume: fakeRenderer().render,
    });
    // Not viable: the question went to a human because the employer was unknown.
    expect(outcome).toMatchObject({ kind: 'dry_run_complete', verdict: { kind: 'would_block', check: 'fill_plan' } });
  });
});

// An optional EEO question whose attested answer matches none of the page's options. Parking
// the whole application for a question the employer itself marks optional costs a real
// application; leaving it blank answers it exactly as "decline to answer" would. Only a filler
// that PROVES it selected nothing (OptionNotFoundError) earns the skip: a plain Error with the
// same message means a click may have landed on the wrong option, which a human must see.
describe('applyToOne — optional EEO option mismatch', () => {
  /** The gender field (optional unless a test says otherwise) followed by a required text field. */
  function eeoForm(genderRequired: boolean): FormField[] {
    // No `options`, so the planner defers option checking to fill time and plans the fill.
    return [
      // 'Gender' matches the EEO template /^gender$/, so it is read from the eeo_gender key.
      { id: 'gender', label: 'Gender', kind: 'combobox', required: genderRequired },
      // Placed AFTER gender so a recorded fill proves the loop continued past the skip.
      { id: 'first_name', label: 'First Name', kind: 'text', required: true },
      // The form-shape gate's email box (see EMAIL_FIELD); optional and unanswered, so it is never filled.
      EMAIL_FIELD,
      // The form-shape gate's resume upload (see RESUME_FIELD); planFill skips files, so `filled` is unchanged.
      RESUME_FIELD,
    ];
  }

  // EEO answers must be attested by the human, or the planner refuses to use them at all.
  const eeoAnswers = [
    // The attested gender answer the page will fail to find among its options.
    { question_key: 'eeo_gender', answer_value: 'Male', needs_human: false, answer_type: 'text', attested_by_human: true },
    // The plain answer for the required field that must still be filled after the skip.
    // T8 (2026-11-10): the planner fills only from human-attested rows, so this fixture row is attested.
    { question_key: 'first_name', answer_value: 'Teja', needs_human: false, answer_type: 'text', attested_by_human: true },
  ] as unknown as AnswerBankRow[];

  /** A page whose fill throws `error` for the gender field only and records every fill id in order. */
  function mismatchPage(form: FormField[], error: Error) {
    // Every id the loop tried to fill, in order, so "continued past gender" is observable.
    const filled: string[] = [];
    // The shared fake, so submit and every other port behave as in the rest of this file.
    const { page, submit } = fakePage({
      // The form under test instead of the default one-field form.
      extractFields: async () => form,
      // Records first, then throws, so a rejected fill still appears in the order log.
      fill: async (id) => {
        // Recorded before the throw: the attempt itself is part of the sequence.
        filled.push(id);
        // Only the gender field is rejected; every other fill succeeds.
        if (id === 'gender') throw error;
      },
    });
    // The page plus both logs the assertions read.
    return { page, submit, filled };
  }

  it('an optional EEO option mismatch leaves the field blank and does not park', async () => {
    // The typed error: the filler proved nothing was selected, so blank is the honest state.
    const { page, submit, filled } = mismatchPage(
      // Optional gender, the only case allowed to skip.
      eeoForm(false),
      // The exact message the live filler throws, as the typed class.
      new OptionNotFoundError('no_matching_option: gender: "Male"'),
    );
    // The plain fake records the status writes in order.
    const { gateway, transitions } = fakeGateway();

    // DRY_RUN false so a park, if one happened, would be a real status write the test can see.
    await applyToOne({ row, page, gateway, answers: eeoAnswers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // No blocked_needs_human: the skip kept the application viable all the way to applied.
    expect(transitions).toEqual(['applying', 'applied']);
    // The application actually went out, exactly once.
    expect(submit).toHaveBeenCalledTimes(1);
    // The loop did not break at gender: the required field after it was still typed.
    expect(filled).toEqual(['gender', 'first_name']);
  });

  it('a required field mismatch still parks', async () => {
    // A required question cannot be left blank: the form would refuse it, so a human decides.
    const { page, submit } = mismatchPage(
      // Required gender, so the skip must NOT apply even though the label is EEO.
      eeoForm(true),
      // The same typed error as the skip case, so only `required` differs.
      new OptionNotFoundError('no_matching_option: gender: "Male"'),
    );
    // The plain fake records the status writes in order.
    const { gateway, transitions } = fakeGateway();

    // DRY_RUN false so the real park path runs.
    const outcome = await applyToOne({ row, page, gateway, answers: eeoAnswers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // One write, straight to the human queue.
    expect(transitions).toEqual(['blocked_needs_human']);
    // Nothing goes out for a form with an unanswered required question.
    expect(submit).not.toHaveBeenCalled();
    // The claim loop counts this as parked, not errored.
    expect(outcome.kind).toBe('blocked');
  });

  it('an optional EEO mismatch thrown as a plain Error still parks', async () => {
    // A plain Error is the readback path: a click may have landed and a WRONG option may show,
    // which is worse than blank and must not be submitted unseen.
    const { page, submit } = mismatchPage(
      // Optional gender, so only the error TYPE separates this from the skip case.
      eeoForm(false),
      // Same message, untyped: the message alone must never earn the skip.
      new Error('no_matching_option: gender: "Male"'),
    );
    // The plain fake records the status writes in order.
    const { gateway, transitions } = fakeGateway();

    // DRY_RUN false so the real park path runs.
    const outcome = await applyToOne({ row, page, gateway, answers: eeoAnswers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // Parked for the human, as before this change.
    expect(transitions).toEqual(['blocked_needs_human']);
    // A possibly-wrong EEO answer never goes out.
    expect(submit).not.toHaveBeenCalled();
    // Counted as parked by the claim loop.
    expect(outcome.kind).toBe('blocked');
  });

  it('an optional NON-EEO option mismatch still parks', async () => {
    // Optional but not EEO: an employer question left blank may still cost the application,
    // so the skip is scoped to the declinable demographic questions only.
    const countryForm: FormField[] = [
      // Optional combobox with no options, so the fill is planned and rejected at fill time.
      { id: 'country', label: 'Country', kind: 'combobox', required: false },
      // The form-shape gate's email box (see EMAIL_FIELD).
      EMAIL_FIELD,
      // The form-shape gate's resume upload (see RESUME_FIELD), so the fill rejection is what parks it.
      RESUME_FIELD,
    ];
    // A plain bank row is enough here: since T8 (2026-11-10) it must be attested, but no EEO rule applies.
    const countryAnswers = [
      // The value the page will fail to find among its options.
      // T8 (2026-11-10): the planner fills only from human-attested rows, so this fixture row is attested.
      { question_key: 'country', answer_value: 'India', needs_human: false, answer_type: 'text', attested_by_human: true },
    ] as unknown as AnswerBankRow[];
    // The typed error, so only the label separates this from the skip case.
    const { page, submit } = fakePage({
      // The one-field non-EEO form.
      extractFields: async () => countryForm,
      // Rejects the country value exactly as the filler would after proving no selection.
      fill: async () => {
        // Typed, so a skip that ignored the EEO check would wrongly pass here.
        throw new OptionNotFoundError('no_matching_option: country: "India"');
      },
    });
    // The plain fake records the status writes in order.
    const { gateway, transitions } = fakeGateway();

    // DRY_RUN false so the real park path runs.
    const outcome = await applyToOne({ row, page, gateway, answers: countryAnswers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // Parked for the human.
    expect(transitions).toEqual(['blocked_needs_human']);
    // Nothing goes out.
    expect(submit).not.toHaveBeenCalled();
    // Counted as parked by the claim loop.
    expect(outcome.kind).toBe('blocked');
  });
});

// W5 (docs/audit/2026-11-01-wiring-audit.md): an apply_url that lands on a job description,
// an iframe shell or an unrendered JS form extracts ZERO fields. Both planners then had
// nothing to refuse, so wouldSubmit came out true and a live run clicked whatever
// `form button[type="submit"]` the page had, a search box or a newsletter form included.
describe('applyToOne — a page with no form fields (W5)', () => {
  /** fakeGateway plus each advance's detail, which fakeGateway drops and block_reason needs. */
  function recordingGateway() {
    // Every advance with its detail, in order.
    const advances: Array<{ to: string; detail: Record<string, unknown> | undefined }> = [];
    // The shared fake for every other port, so only the one method under test differs.
    const base = fakeGateway();
    // Spread-and-override, as the fill-rejection suite above does.
    const gateway: ApplierGateway = {
      // Release, uploads and artifact writes behave exactly as in every other test.
      ...base.gateway,
      // Records the detail instead of discarding it.
      advanceStatus: async (_id, to, _agent, detail) => {
        // Asserted after the run, so the test reads top-down.
        advances.push({ to, detail });
      },
    };
    // The released list rides along so the dry-run test can assert the hand-back.
    return { gateway, advances, released: base.released };
  }

  it('W5 live: zero extracted fields parks approved -> blocked_needs_human as unsupported_form and never submits', async () => {
    // The page opened, showed no captcha, and the extractor found nothing to fill.
    const { page, submit } = fakePage({ extractFields: async () => [] });
    // Fresh recorder, so nothing leaks from other tests.
    const { gateway, advances } = recordingGateway();

    // DRY_RUN false: the run is authorised to submit, which is exactly when this matters.
    const outcome = await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // THE assertion: no click on a page that is not an application form.
    expect(submit).not.toHaveBeenCalled();
    // One write, straight to the human lane; never through `applying`.
    expect(advances.map((advance) => advance.to)).toEqual(['blocked_needs_human']);
    // Row-level reason: a coverage gap in form shapes, not a question Teja can answer.
    expect(advances[0]?.detail).toMatchObject({ block_reason: 'unsupported_form' });
    // The outcome names the same reason, so the claim loop logs it as a park.
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'unsupported_form' });
  });

  it('W5 dry run: zero extracted fields reports a form_shape verdict with a no_form_fields blocker', async () => {
    // Same empty page as the live test.
    const { page, submit } = fakePage({ extractFields: async () => [] });
    // Dry runs write no status, so only the release is asserted.
    const { gateway, advances, released } = recordingGateway();

    // Unset DRY_RUN is the dry run the trust period reads.
    const outcome = await applyToOne({ row, page, gateway, answers, env: {}, renderResume: fakeRenderer().render });

    // Nothing sent and nothing moved.
    expect(submit).not.toHaveBeenCalled();
    // A dry run never writes status.
    expect(advances).toEqual([]);
    // Handed back untouched.
    expect(released).toEqual(['app-1']);
    // The log line reads "would NOT submit" and names why, instead of "would submit".
    expect(outcome).toMatchObject({ kind: 'dry_run_complete', verdict: { kind: 'would_block', check: 'form_shape' } });
    // The blocker is named, so the dry-run log says what is wrong with the page.
    expect(outcome.kind === 'dry_run_complete' ? outcome.blockers.map((blocker) => blocker.reason) : []).toEqual(['no_form_fields']);
  });

  it('W5 non-vacuity: one answerable field still submits, so the guard keys on emptiness alone', async () => {
    // The default page has one answerable field.
    const { page, submit } = fakePage();
    // Fresh recorder.
    const { gateway, advances } = recordingGateway();

    // Live run.
    await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // A guard that parked every form would pass both tests above; this one would catch it.
    expect(submit).toHaveBeenCalledTimes(1);
    // The full legal path.
    expect(advances.map((advance) => advance.to)).toEqual(['applying', 'applied']);
  });

  // 2026-11-09, Supabase 8f20a220: jobicy.com's job page (an aggregator) had two controls, a site search box and
  // a dark-mode toggle. Neither is required, so both planners answered "nothing to refuse", and the dry run
  // logged wouldSubmit=true with zero blockers. A LIVE run would have clicked a submit on a page with no form.
  const aggregatorPage: FormField[] = [
    // The site's search box, as the extractor reads it.
    { id: 'q', label: 'Job title, company or skill', kind: 'text', required: false },
    // The theme switch.
    { id: 'theme', label: 'Dark mode', kind: 'checkbox', required: false },
  ];

  it('no_email_field live: an aggregator page with controls but no email box parks unsupported_form, never submits', async () => {
    // The jobicy shape.
    const { page, submit } = fakePage({ extractFields: async () => aggregatorPage });
    // Records every status write.
    const { gateway, advances } = recordingGateway();

    // A LIVE run, the case that would have clicked.
    const outcome = await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // THE assertion: no click on a page that is not an application form.
    expect(submit).not.toHaveBeenCalled();
    // Straight to the human lane, never through `applying`.
    expect(advances.map((advance) => advance.to)).toEqual(['blocked_needs_human']);
    // A form-shape gap, not a question Teja can answer, so the Manual apply lane picks it up.
    expect(advances[0]?.detail).toMatchObject({ block_reason: 'unsupported_form' });
    // The outcome says the same.
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'unsupported_form' });
  });

  it('no_email_field dry run: the same page reports a form_shape verdict with a no_email_field blocker naming the controls', async () => {
    // The jobicy shape again.
    const { page } = fakePage({ extractFields: async () => aggregatorPage });
    // Dry runs write no status.
    const { gateway, advances } = recordingGateway();

    // Unset DRY_RUN: the trust-period dry run that reported wouldSubmit=true on 2026-11-09.
    const outcome = await applyToOne({ row, page, gateway, answers, env: {}, renderResume: fakeRenderer().render });

    // Nothing moved.
    expect(advances).toEqual([]);
    // Would NOT submit.
    expect(outcome).toMatchObject({ kind: 'dry_run_complete', verdict: { kind: 'would_block', check: 'form_shape' } });
    // The one blocker, named, with the labels the page showed instead of a form.
    expect(outcome.kind === 'dry_run_complete' ? outcome.blockers.map((blocker) => [blocker.reason, blocker.label]) : []).toEqual([
      ['no_email_field', expect.stringMatching(/2 field\(s\): Job title, company or skill, Dark mode/)],
    ]);
  });

  it('refuses a form with no upload control (no_resume_field) without rendering anything', async () => {
    // REWRITTEN 2026-11-10 (T5, the no_resume_field gate). This test used to pin "a form asking for no document:
    // proceed". That shape (an email box, no file input) is exactly the job-alerts / newsletter form the gate now
    // refuses, so a live run there would POST Teja's email to a signup. The old non-vacuity role ("rendering does
    // happen somewhere") is carried by the formWithResumeUpload live-submit tests above, which assert the render.
    // What stays from the old test: nothing is rendered, and a missing snapshot is NOT what stops this row.
    const renderer = fakeRenderer();
    // Pinned to an explicit no-upload form: the default answerableForm carries RESUME_FIELD (2026-11-10).
    const { page, submit } = fakePage({ extractFields: async () => [answerableForm[0]!, EMAIL_FIELD] });
    // Records every status write with its detail, as the no_email_field live test does.
    const { gateway, advances } = recordingGateway();

    const outcome = await applyToOne({
      // No snapshot AND no upload control: the form-shape gate must answer first, not the snapshot check.
      row: { ...row, tailoredProfile: null },
      page,
      gateway,
      answers,
      // A LIVE run: the case that would have clicked submit on a signup form.
      env: { DRY_RUN: 'false' },
      renderResume: renderer.render,
    });

    // A refused page renders no PDF: no bytes made for an application that will not happen.
    expect(renderer.rendered).toHaveLength(0);
    // THE assertion: no click on a page without a resume upload.
    expect(submit).not.toHaveBeenCalled();
    // Straight to the human lane, never through `applying`.
    expect(advances.map((advance) => advance.to)).toEqual(['blocked_needs_human']);
    // A form-shape gap, so the Manual apply lane picks it up (the same reason the no_email_field page gets).
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'unsupported_form' });
  });

  it('no_resume_field dry run: an email-only form reports exactly the no_resume_field blocker', async () => {
    // The dry-run twin: the verdict names WHY, so the reason cannot drift to no_resume_snapshot or vanish.
    const { page } = fakePage({ extractFields: async () => [answerableForm[0]!, EMAIL_FIELD] });
    // A plain gateway: the dry run's subject is the blocker list, not the writes.
    const { gateway } = fakeGateway();

    // Default env is a dry run; snapshot present, so only the form shape can block.
    const outcome = await applyToOne({ row, page, gateway, answers, env: {}, renderResume: fakeRenderer().render });

    // Exactly one blocker, the new one: a snapshot is present, the field is answerable, the email box exists.
    expect(outcome.kind === 'dry_run_complete' ? outcome.blockers.map((blocker) => blocker.reason) : outcome.kind).toEqual(['no_resume_field']);
  });

  it('no_email_field non-vacuity: a Greenhouse email box typed "text" but labelled "Email" is a form, and submits', async () => {
    // Greenhouse renders its email input as type="text" (fixtures/greenhouse/*): the label must carry it.
    // RESUME_FIELD too, so the no_resume_field stop is satisfied and only the email-by-label question is tested.
    const { page, submit } = fakePage({ extractFields: async () => [answerableForm[0]!, { id: 'email', label: 'Email', kind: 'text', required: false }, RESUME_FIELD] });
    // Fresh recorder.
    const { gateway, advances } = recordingGateway();

    // Live run.
    await applyToOne({ row, page, gateway, answers, env: { DRY_RUN: 'false' }, renderResume: fakeRenderer().render });

    // A kind-only check would park every real Greenhouse form; this catches it.
    expect(submit).toHaveBeenCalledTimes(1);
    // The full legal path.
    expect(advances.map((advance) => advance.to)).toEqual(['applying', 'applied']);
  });
});
