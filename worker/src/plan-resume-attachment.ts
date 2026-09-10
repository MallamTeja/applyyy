// Decides WHICH file input on an application form receives the tailored resume
// — and when the honest answer is "we cannot tell, ask a human".
//
// WHY THIS IS NOT A LABEL LOOKUP, which is what it obviously should be. The one
// genuinely-captured Greenhouse form in worker/fixtures/ disproves that design
// outright. Its two uploads are marked up like this:
//
//   <div role="group" aria-labelledby="upload-label-resume" aria-required="true">
//     <div id="upload-label-resume">Resume/CV<span class="required">*</span></div>
//     <label class="visually-hidden" for="resume">Attach</label>
//     <input id="resume" class="visually-hidden" type="file" ...>
//
//   ...and the same shape again with cover_letter / "Cover Letter" /
//   aria-required="false".
//
// So the human-visible name ("Resume/CV") lives on a DIV, reachable only through
// the WRAPPER's aria-labelledby, and extract-fields.ts walks
// `input, textarea, select` — it never visits the wrapper. What it recovers from
// `<label for>` is the word "Attach", for BOTH uploads. A /resume|cv/ test
// against the label therefore matches NEITHER field on the only real form we
// have, while a "first file input wins" rule would attach Teja's resume to a
// cover-letter box the day a vendor orders them the other way.
//
// The `id` is what carries the meaning here (`resume`, `cover_letter`), so the
// pattern is tested against the id AND the label. That is not belt-and-braces:
// they are independent signals, and each is the only one that works on some real
// form. Greenhouse's ids are meaningful for the standard uploads; a form using a
// proper <label for="f1">Resume</label> has the meaning only in the label.
//
// The SAME aria-required="true" lives on the wrapper too, so `required` reads
// FALSE for every file input on the real form. Nothing below branches on
// `required` for that reason — a guard keyed to it would be dead code on the one
// DOM we can actually check, which is worse than no guard, because the tests
// covering it would have to be written against invented markup.
import type { ResolvedResume } from '@applyy/shared-types';
import type { FormField } from './extract-fields.ts';

/** The single file input that gets the resume. */
export interface ResumeAttachmentTarget {
  // DOM id, handed to the page port to build the selector.
  readonly id: string;
  // Carried for the log and the dashboard, so a wrong attachment is diagnosable
  // from the run record rather than by re-opening the employer's form.
  readonly label: string;
}

/** One reason the resume could not be placed, in the shape the row-level blocker report wants. */
export interface ResumeAttachmentBlocker {
  // DOM id of the offending control, or the row id when no control is at fault.
  readonly id: string;
  // Human-readable, because this string reaches Teja's queue as the explanation.
  readonly label: string;
  // WHY it blocked. Two genuinely different operator actions: one is a data
  // problem on the row (re-approve it), the other is a coverage gap in this
  // module (add the form's shape, having actually seen it).
  readonly reason: 'no_resume_snapshot' | 'unplaceable_document_field';
}

/** The complete attachment decision for one form. */
export interface ResumeAttachmentPlan {
  // Null means "nothing to attach here", which is a legitimate outcome: a form
  // with no upload control at all is not a broken form.
  readonly target: ResumeAttachmentTarget | null;
  readonly blockers: readonly ResumeAttachmentBlocker[];
  // False parks the row rather than submitting it.
  readonly canProceed: boolean;
}

/** What the caller knows about the row, narrowed to the one fact that matters. */
export interface ResumeAvailability {
  // Whether `applications.tailored_profile` actually holds a snapshot. A boolean
  // rather than the resume itself, so this module stays a pure function of the
  // form and cannot be tempted into rendering anything.
  readonly hasResumeSnapshot: boolean;
}

// Matches the resume upload and nothing else.
//
// THE ANCHORS EARN THEIR KEEP ON A REAL EMPLOYER'S NAME. An unanchored /cv/
// matches "CVS Health referral form" — CVS Health is a Fortune-10 company that
// posts jobs — and would attach Teja's resume to whatever that upload is. The
// `[^a-z]` boundaries reject it, and a mutation run confirmed this is the one
// plausible input on which anchored and unanchored disagree; an earlier version
// of this comment claimed "recover" contained "cv", which is simply false, and
// the test written from that claim proved nothing.
//
// THE TRADE, stated because it is asymmetric and deliberate: `cvs` and
// `cvs_health_form` are also rejected, so a form that really did name its upload
// "cvs" gets BLOCKED rather than mis-attached. That is the right way round —
// a false negative costs one application and a human glance, while a false
// positive sends the wrong document under Teja's name and no retry undoes it.
// `resumes?` carries the plural because "resumes" is a common id and, unlike
// "cvs", no real word or company name contains it.
//
// Deliberately short: every alternative here is either present in the captured
// Greenhouse DOM or is a standard English spelling of the same word. Guessing at
// vendor-specific ids we have never seen would convert a KNOWN gap — which
// blocks and asks a human — into an unknown one that silently mis-attaches.
const RESUME_PATTERN = /(^|[^a-z])(resumes?|résumés?|cv|curriculum)([^a-z]|$)/i;

/**
 * Decide where the resume goes.
 *
 * Refusing is a first-class outcome. This module has no branch that picks a file
 * input it could not identify, for the same reason plan-fill.ts has no branch
 * that invents an answer: the wrong document sent under Teja's name is not
 * recoverable by retrying, and "probably the resume box" is a guess.
 */
export function planResumeAttachment(
  fields: readonly FormField[],
  availability: ResumeAvailability,
): ResumeAttachmentPlan {
  // Only file inputs can receive a document; every other control is the
  // answer-bank planner's business and is deliberately not re-examined here.
  const fileFields = fields.filter((field) => field.kind === 'file');

  // CASE 1 — the form asks for no documents at all. There is nothing to attach
  // and nothing wrong, so this proceeds. Treating it as a blocker would park
  // every text-only application on a missing upload that was never requested.
  if (fileFields.length === 0) {
    return { target: null, blockers: [], canProceed: true };
  }

  // CASE 2 — the form wants a document and the row has no approved snapshot to
  // render one from. Checked only now, and that ordering is the design: a row
  // with no `tailored_profile` is a data-integrity problem, but it is only an
  // APPLICATION-stopping one when the employer actually asked for a file.
  //
  // The alternative — render from `resume_storage_path` — is the trap this whole
  // pipeline is built to avoid. That column is the RECORD of what was sent, and
  // a stored artifact can drift from what the human approved; a derivation from
  // the pinned snapshot cannot.
  if (!availability.hasResumeSnapshot) {
    return {
      target: null,
      blockers: [
        {
          // The form's own field is named, so the queue shows what was wanted.
          id: fileFields[0]!.id,
          label: fileFields[0]!.label,
          reason: 'no_resume_snapshot',
        },
      ],
      canProceed: false,
    };
  }

  // CASE 3 — find the resume box. `find` rather than a filter-and-assert: two
  // controls both naming themselves the resume is a form shape we have never
  // seen, and inventing a tie-break for it would be exactly the confident
  // nonsense this module's header argues against. First match in DOM order is
  // the same choice a person filling the form top-to-bottom would make.
  const target = fileFields.find(
    (field) => RESUME_PATTERN.test(field.id) || RESUME_PATTERN.test(field.label),
  );

  // CASE 4 — documents are wanted, we have a resume, and we cannot tell which
  // box it goes in. This is the coverage gap, and it BLOCKS. Attaching to the
  // only file input present would be right most of the time and catastrophic the
  // rest: the resume silently filed as a transcript, or worse, as the cover
  // letter of an application that then goes out with no resume at all.
  if (target === undefined) {
    return {
      target: null,
      // Every unidentified upload is named, because the fix is for a human to
      // look at the real form once and teach this module its shape.
      blockers: fileFields.map((field) => ({
        id: field.id,
        label: field.label,
        reason: 'unplaceable_document_field' as const,
      })),
      canProceed: false,
    };
  }

  // CASE 5 — the resume has a home. Other uploads alongside it are left EMPTY
  // and deliberately do not block, which is the one judgement call in this file
  // and is grounded in the captured form: its cover-letter wrapper carries
  // aria-required="false", so the honest reading of the only real evidence we
  // have is that a second upload is optional. Blocking on it would park every
  // Greenhouse application in the human queue on day one, which is the same
  // outcome as having no applier. When a required second document does turn up,
  // it will turn up as a real form we can capture and measure.
  return {
    target: { id: target.id, label: target.label },
    blockers: [],
    canProceed: true,
  };
}

// ---------------------------------------------------------------------------
// The attachment's NAME. Here rather than beside the renderer for one reason:
// this module is the pure, browser-free half of "what gets attached and where",
// and apply-one.ts imports it. A filename helper living next to the Playwright
// page would drag a browser module into the applier's import graph to compute a
// string.
// ---------------------------------------------------------------------------

// The extension the attachment carries. A constant because ATS upload widgets
// validate on it (`accept=".pdf,.doc,.docx,.txt,.rtf"` on the captured
// Greenhouse form), so it is part of the contract with the employer's page and
// not a cosmetic detail.
const PDF_EXTENSION = '.pdf';

// What the file is called after the name. Fixed rather than derived from the job
// or the company, because the filename is the one part of the artifact a
// recruiter reads before opening it, and "Resume" is what makes it obvious.
const FILENAME_SUFFIX = ' Resume';

/**
 * The filename an employer sees on the attachment.
 *
 * DERIVED FROM THE PINNED SNAPSHOT AND NOTHING ELSE — no date, no job id, no
 * counter. A filename containing today's date would make the attached bytes
 * differ from the approved preview's identity every day, which is the same class
 * of leak the PDF's suppressed header/footer exists to prevent. Determinism here
 * is not tidiness: it is what lets `sha256` answer "is this what was approved?".
 */
export function resumeFileName(resume: ResolvedResume): string {
  // Anything a filesystem, an HTTP header or a Windows recruiter's download
  // folder would choke on becomes a space. `full_name` is copied verbatim from
  // the master profile, so it can legitimately carry punctuation.
  const safeName = resume.identity.full_name.replace(/[^A-Za-z0-9 ._-]+/g, ' ');

  // Collapse the runs those substitutions leave, then trim, so a name of pure
  // punctuation cannot produce a filename that is all spaces.
  const collapsed = safeName.replace(/\s+/g, ' ').trim();

  // Fall back to a generic stem rather than emitting `.pdf` with no name. An
  // extension-only filename is rejected by some upload validators, and this is
  // reachable from real data: a `full_name` written entirely in a non-Latin
  // script would be stripped to nothing by the rule above.
  const stem = collapsed === '' ? 'Applicant' : collapsed;

  return `${stem}${FILENAME_SUFFIX}${PDF_EXTENSION}`;
}

