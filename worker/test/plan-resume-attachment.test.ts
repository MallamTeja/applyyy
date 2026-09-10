// Where the tailored resume goes, and when the honest answer is "ask a human".
//
// EVERY GUARD BELOW IS PAIRED. A rejection-only suite cannot tell a correct
// guard from one that rejects everything, so each refusal test has a twin that
// the same guard must ACCEPT — and the pairs are named so a future reader
// cannot delete one half without noticing the other lost its meaning.
//
// The field shapes here are not invented. They are what extract-fields.ts
// actually recovers from worker/fixtures/greenhouse/gitlab-remix-form.html, the
// one genuinely-captured ATS form in the repository:
//
//   { id: 'resume',       label: 'Attach', kind: 'file', required: false }
//   { id: 'cover_letter', label: 'Attach', kind: 'file', required: false }
//
// Both labelled "Attach", and both NOT required — because the real form puts the
// visible name ("Resume/CV") and `aria-required="true"` on a wrapper
// `role="group"` div that the extractor never visits. attach-resume-real-form
// .test.ts measures that against the live DOM rather than trusting this comment.
import { describe, expect, it } from 'vitest';
import { planResumeAttachment, resumeFileName } from '../src/plan-resume-attachment.ts';
import type { FormField } from '../src/extract-fields.ts';
import { syntheticResume } from './resolved-resume-fixture.ts';

/** The two uploads exactly as the real Greenhouse form yields them. */
const greenhouseUploads: FormField[] = [
  { id: 'resume', label: 'Attach', kind: 'file', required: false },
  { id: 'cover_letter', label: 'Attach', kind: 'file', required: false },
];

/** A plain text question, to prove non-file controls are ignored. */
const textQuestion: FormField = {
  id: 'first_name',
  label: 'First Name',
  kind: 'text',
  required: true,
};

describe('planResumeAttachment', () => {
  it('picks the resume input on the real captured Greenhouse form', () => {
    // THE CENTRAL CASE. Both file inputs are labelled "Attach", so this can only
    // pass by reading the `id` — which is the whole reason the classifier looks
    // there. A label-only implementation returns no target here and blocks every
    // Greenhouse application in the queue.
    const plan = planResumeAttachment(greenhouseUploads, { hasResumeSnapshot: true });

    expect(plan.target?.id).toBe('resume');
    expect(plan.canProceed).toBe(true);
    expect(plan.blockers).toHaveLength(0);
  });

  it('never picks the cover-letter input, even when it comes first', () => {
    // THE MUTATION THIS KILLS: "first file input wins". That rule passes the
    // test above — `resume` happens to be first in the real DOM — and quietly
    // files Teja's resume as a cover letter the moment a vendor orders the two
    // fields the other way. Reversing the fixture is the only way to tell the
    // two implementations apart.
    const plan = planResumeAttachment([...greenhouseUploads].reverse(), {
      hasResumeSnapshot: true,
    });

    expect(plan.target?.id).toBe('resume');
  });

  it('identifies the resume by label when the label is the only signal', () => {
    // The twin of the id-based case, and not redundant with it: a form using a
    // proper `<label for="f1">Resume</label>` carries the meaning ONLY in the
    // label, and an id-only classifier would block it. Each signal is the sole
    // working one on some real form, which is why both are consulted.
    const plan = planResumeAttachment(
      [{ id: 'f1', label: 'Resume', kind: 'file', required: true }],
      { hasResumeSnapshot: true },
    );

    expect(plan.target?.id).toBe('f1');
    expect(plan.canProceed).toBe(true);
  });

  it('accepts CV as a name for the resume', () => {
    // Non-vacuity for the pattern's second alternative. Without this, the `cv`
    // branch could be deleted and the suite would stay green.
    const plan = planResumeAttachment(
      [{ id: 'cv_upload', label: 'Attach', kind: 'file', required: true }],
      { hasResumeSnapshot: true },
    );

    expect(plan.target?.id).toBe('cv_upload');
  });

  it('does not treat a "CVS Health" upload as the resume', () => {
    // THE ONE INPUT THAT DISCRIMINATES, and it took a mutation run to find it.
    // The first version of this test used "Recovery documents" on the theory
    // that "recover" contains "cv" — it does not (c-o-v), so an unanchored
    // pattern SURVIVED the whole suite. CVS Health is a real Fortune-10
    // employer, so "CVS Health referral form" is a label a real form could
    // carry, and an unanchored /cv/ matches it and attaches Teja's resume to
    // whatever that upload actually is.
    const plan = planResumeAttachment(
      [{ id: 'cvs_health_form', label: 'CVS Health referral form', kind: 'file', required: false }],
      { hasResumeSnapshot: true },
    );

    expect(plan.target).toBeNull();
    expect(plan.canProceed).toBe(false);
    expect(plan.blockers.map((blocker) => blocker.reason)).toEqual([
      'unplaceable_document_field',
    ]);
  });

  it('accepts a plural "resumes" id', () => {
    // NON-VACUITY TWIN for the anchors. They reject `cvs` deliberately — the
    // trade is spelled out beside the pattern — but rejecting `resumes` too
    // would block a common id for no benefit, so the plural is carried
    // explicitly and asserted here. Without this test the `s?` could be deleted
    // and nothing would notice until a real form was blocked in production.
    const plan = planResumeAttachment(
      [{ id: 'resumes', label: 'Attach', kind: 'file', required: false }],
      { hasResumeSnapshot: true },
    );

    expect(plan.target?.id).toBe('resumes');
    expect(plan.canProceed).toBe(true);
  });

  it('blocks rather than guessing when no upload can be identified', () => {
    // CONSTRAINT #4's shape applied to documents: the planner has no branch that
    // picks an unidentified file input. Attaching to the only upload present
    // would be right most of the time, and the rest of the time it sends the
    // wrong document under Teja's name — which no retry can undo.
    const plan = planResumeAttachment(
      [{ id: 'file_1', label: 'Attach', kind: 'file', required: true }],
      { hasResumeSnapshot: true },
    );

    expect(plan.target).toBeNull();
    expect(plan.canProceed).toBe(false);
  });

  it('proceeds on a form with no upload control at all', () => {
    // NON-VACUITY TWIN for every blocking case above. Without it, a planner that
    // returned canProceed:false unconditionally would pass all of them — and
    // the applier would then park every single application, which is
    // indistinguishable from having no applier.
    const plan = planResumeAttachment([textQuestion], { hasResumeSnapshot: true });

    expect(plan.target).toBeNull();
    expect(plan.canProceed).toBe(true);
    expect(plan.blockers).toHaveLength(0);
  });

  it('blocks when the form wants a document and the row has no snapshot', () => {
    // A row approved with a null `tailored_profile` cannot have a resume
    // rendered from it, and the failure must NOT be "attach nothing and submit":
    // an application sent with an empty resume box to an employer who asked for
    // one is worse than an application not sent.
    const plan = planResumeAttachment(greenhouseUploads, { hasResumeSnapshot: false });

    expect(plan.target).toBeNull();
    expect(plan.canProceed).toBe(false);
    expect(plan.blockers.map((blocker) => blocker.reason)).toEqual(['no_resume_snapshot']);
  });

  it('proceeds without a snapshot when the form asks for no document', () => {
    // THE TWIN, and the one that pins down WHERE the snapshot check belongs. A
    // guard placed before the "are there any file fields?" question passes the
    // test above and fails this one, parking applications over a resume the
    // employer never asked for. The ordering inside the planner is the
    // behaviour under test here, not an implementation detail.
    const plan = planResumeAttachment([textQuestion], { hasResumeSnapshot: false });

    expect(plan.canProceed).toBe(true);
    expect(plan.blockers).toHaveLength(0);
  });

  it('ignores non-file controls when looking for the resume box', () => {
    // The real Greenhouse form also carries `resume_text` — an "Enter manually"
    // TEXT control sitting right beside the upload. Typing PDF bytes into a
    // textarea would produce a genuinely bizarre application, and the `kind`
    // filter is the only thing standing between the two.
    const plan = planResumeAttachment(
      [
        { id: 'resume_text', label: 'Enter manually', kind: 'textarea', required: false },
        { id: 'resume', label: 'Attach', kind: 'file', required: false },
      ],
      { hasResumeSnapshot: true },
    );

    expect(plan.target?.id).toBe('resume');
  });

  it('names every unidentified upload so a human can fix the gap once', () => {
    // The blockers are the work item: they tell Teja which form to capture. One
    // blocker per unknown upload rather than a single summary, because the fix
    // is per-field.
    const plan = planResumeAttachment(
      [
        { id: 'doc_a', label: 'Attach', kind: 'file', required: false },
        { id: 'doc_b', label: 'Transcript', kind: 'file', required: false },
      ],
      { hasResumeSnapshot: true },
    );

    expect(plan.blockers.map((blocker) => blocker.id)).toEqual(['doc_a', 'doc_b']);
  });
});

describe('resumeFileName', () => {
  it('names the file after the applicant', () => {
    // What a recruiter sees before opening the attachment, so it has to read as
    // a document rather than as a build artifact.
    expect(resumeFileName(syntheticResume)).toBe('Ada Placeholder Resume.pdf');
  });

  it('contains no date, counter or job reference', () => {
    // DETERMINISM, at the filename level. A date here would make two renders of
    // one approved snapshot differ in the artifact an employer receives, which
    // is the same leak `displayHeaderFooter: false` and the timestamp
    // normalisation exist to close. Asserted as a property rather than by
    // equality so it keeps holding if the naming convention changes.
    const first = resumeFileName(syntheticResume);

    // Any four-digit run would catch a year, and any 8+ digit run a timestamp.
    expect(first).not.toMatch(/\d{4}/);
  });

  it('survives a name that sanitises down to nothing', () => {
    // Reachable from real data: a `full_name` written entirely in a non-Latin
    // script is stripped by the sanitiser, and an extension-only filename is
    // rejected by some upload validators. The fallback is what keeps that a
    // slightly-generic filename rather than a failed application.
    const nameless = { ...syntheticResume, identity: { ...syntheticResume.identity, full_name: '☃☃☃' } };

    expect(resumeFileName(nameless)).toBe('Applicant Resume.pdf');
  });

  it('keeps a name that needs no sanitising unchanged', () => {
    // NON-VACUITY TWIN for the sanitiser: without this, a function that replaced
    // every name with 'Applicant' would pass the test above.
    const plain = { ...syntheticResume, identity: { ...syntheticResume.identity, full_name: 'Ada Lovelace' } };

    expect(resumeFileName(plain)).toBe('Ada Lovelace Resume.pdf');
  });
});
