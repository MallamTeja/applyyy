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
  applyToOne,
  type ApplicationPage,
  type ApplierGateway,
  type ResumeRenderer,
} from '../src/apply-one.ts';
import type { FormField } from '../src/extract-fields.ts';
import type { AnswerBankRow, ResolvedResume } from '@applyy/shared-types';
// The pinned snapshot the resume is rendered FROM. A real ResolvedResume rather
// than a stub, so a renderer that actually reads it behaves as it will in
// production.
import { syntheticResume } from './resolved-resume-fixture.ts';

/** A form the answer bank can fully satisfy, so nothing blocks by accident. */
const answerableForm: FormField[] = [
  { id: 'first_name', label: 'First Name', kind: 'text', required: true },
];

/** The matching bank. Real rows carry more columns; the planner reads four. */
const answers = [
  { question_key: 'first_name', answer_value: 'Teja', needs_human: false, answer_type: 'text' },
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
  const submit = vi.fn(async () => {});
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
  const gateway: ApplierGateway = {
    advanceStatus: async (_id, to) => {
      transitions.push(to);
    },
    releaseClaim: async (id) => {
      released.push(id);
    },
    uploadScreenshot: async () => 'screens/app-1.png',
    uploadResume: async () => 'resumes/app-1.pdf',
  };
  return { transitions, released, gateway };
}

/** The claimed row under test, carrying the snapshot the human approved. */
const row = {
  id: 'app-1',
  status: 'approved',
  applyUrl: 'http://127.0.0.1:1/form.html',
  tailoredProfile: syntheticResume,
} as const;

/** A form that asks for a resume, exactly as the real Greenhouse DOM presents it. */
const formWithResumeUpload: FormField[] = [
  { id: 'first_name', label: 'First Name', kind: 'text', required: true },
  // Labelled 'Attach', because that is genuinely all the extractor recovers —
  // see attach-resume-real-form.test.ts, which measures it against the live DOM.
  { id: 'resume', label: 'Attach', kind: 'file', required: false },
  { id: 'cover_letter', label: 'Attach', kind: 'file', required: false },
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
      },
    });
    const gateway: ApplierGateway = {
      advanceStatus: async (_id, to) => {
        observed.push(to);
      },
      releaseClaim: async () => {},
      uploadScreenshot: async () => 'screens/app-1.png',
      uploadResume: async () => 'resumes/app-1.pdf',
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
    expect(transitions).toEqual(['applying', 'blocked_needs_human']);
    expect(outcome.kind).toBe('blocked');
  });

  it('parks an unanswerable required question rather than guessing', async () => {
    // Constraint #4, end to end. The planner has no branch that invents a
    // value, so an unanswered required field can only become a blocker.
    const { page, submit } = fakePage({
      extractFields: async () => [
        { id: 'ctc', label: 'Expected CTC', kind: 'text', required: true },
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
    expect(transitions).toEqual(['applying', 'blocked_needs_human']);
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

    // Everything learnable happens while the row is still `approved`; the window
    // between `applying` and `applied` contains the submit and nothing else.
    expect(observed).toEqual([
      'fill',
      'render',
      'upload_resume',
      'attach',
      'screenshot',
      'applying',
      'submit',
      'applied',
    ]);
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
    expect(transitions).toEqual(['applying', 'blocked_needs_human']);
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
    expect(transitions).toEqual(['applying', 'blocked_needs_human']);
    expect(outcome.kind).toBe('blocked');
    // The blocker names the reason, so the queue shows WHY rather than just that.
    if (outcome.kind === 'blocked') {
      expect(outcome.blockers.map((blocker) => blocker.reason)).toContain('no_resume_snapshot');
    }
  });

  it('submits a form with no upload control without rendering anything', async () => {
    // NON-VACUITY TWIN for every "did not render" assertion above, and for the
    // missing-snapshot guard. Without it, an implementation that never rendered
    // at all — the exact bug this whole change fixes — would pass all of them.
    // It also pins the behaviour on a form asking for no document: proceed,
    // rather than park on a resume the employer never wanted.
    const renderer = fakeRenderer();
    const { page, submit } = fakePage();
    const { gateway, transitions } = fakeGateway();

    const outcome = await applyToOne({
      // No snapshot AND no upload control: this must still go out.
      row: { ...row, tailoredProfile: null },
      page,
      gateway,
      answers,
      env: { DRY_RUN: 'false' },
      renderResume: renderer.render,
    });

    expect(renderer.rendered).toHaveLength(0);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(transitions).toEqual(['applying', 'applied']);
    expect(outcome.kind).toBe('submitted');
  });
});
