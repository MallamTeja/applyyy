// THE REHEARSAL of an assisted submit: every step runAssisted takes up to the click, with no write.
//
// WHY (2026-11-07). The first bot submit (Enterpret cfe8b0f5) had to be proven before Teja watched it,
// and assist.ts has no dry mode: it signs in and CLAIMS the row before it opens the form. A one-off
// scratch script proved it instead; this is that script made permanent, so every future first submit
// can be proven the same way, with no claim, no sign-in and no status write.
//
// READ-ONLY BY CONSTRUCTION, not by a flag: rehearseAssisted is handed no gateway at all (the caller
// does the reads and passes plain data), and its page port is RehearsalPage, which HAS no fill, attach
// or submit. readOnlyPage() builds that port from a real ApplicationPage by copying the three read
// methods only, so even at runtime the write methods are not on the object it hands over.
//
// SAME STEPS, SAME ORDER as assisted-submit.ts runAssisted: identity swap and drift, resolve the form
// URL, robots on THAT URL, goto, detectBlocker, extractFields, planFill, planResumeAttachment, render.
//
// THE VERDICT (task 2, 2026-11-09). The CLI used to call a row "ready" from its own PASS/WAIT rows, which
// skipped what the live path checks after them: a wall counted as WAIT, attachment.canProceed was never
// read, and submit()'s pre-click guard (one submit control, no blank REQUIRED control, Lever's ✱ cards
// included) never ran. A rehearsal saying "ready" for a row the live submit would park is the §6 fail-open
// on the one gate Teja trusts before a first submit. Now the report carries the same closed-union
// SubmitVerdict the applier's dry run reports, judged by the same verdictFromFacts.
// Type-only: data shapes the rehearsal reads.
import type { AnswerBankRow, MasterProfile, ResolvedResume } from '@applyy/shared-types';
// Type-only: the full page port (only so readOnlyPage can narrow it) and the robots port.
import type { ApplicationPage, RobotsCheck } from '../apply-one.ts';
// The applier's empty-page gate, so a page apply-one would park cannot rehearse as ready.
import { formShapeBlockersFor } from '../apply-one.ts';
// The verdict's shape and its one judge, shared with submit() and the dry run.
import { verdictFromFacts, type SubmitVerdict } from '../apply-one.ts';
// Type-only: the resolver port, the same one assist takes.
import type { FormUrlResolver } from '../form-url.ts';
// Type-only: the robots answer, reported as is.
import type { RobotsVerdict } from '../../../packages/master-robots/src/index.ts';
// Type-only: what extractFields returns.
import type { FormField } from '../extract-fields.ts';
// Type-only: the rendered PDF.
import type { RenderedResume } from '../render-resume-pdf.ts';
// The same planner assist uses, so the rehearsal's fills are the ones assist would type.
import { planFill, type FillPlan } from '../plan-fill.ts';
// The same attachment planner and file name.
import { planResumeAttachment, resumeFileName } from '../plan-resume-attachment.ts';
// The same identity-drift check assist prints before the human clicks.
import { identityDriftWarnings } from '../apply-kit.ts';

/**
 * The only page methods a rehearsal may use: it loads and reads, nothing else.
 * postingClosed and presubmitFacts are reads too (task 2): the live path asks both before its click.
 */
export type RehearsalPage = Pick<ApplicationPage, 'goto' | 'detectBlocker' | 'extractFields' | 'postingClosed' | 'presubmitFacts'>;

/**
 * The read-only port over a real page: a NEW object carrying the three read methods only.
 *
 * A cast would keep fill/attachFile/submit on the object at runtime; copying does not.
 */
export function readOnlyPage(page: ApplicationPage): RehearsalPage {
  // Bound, so `this` inside the adapter still points at the real page. The two optional reads are copied
  // only when present, so a page without them stays without them and the rehearsal refuses by name.
  return {
    // Loads the form.
    goto: page.goto.bind(page),
    // The wall check.
    detectBlocker: page.detectBlocker.bind(page),
    // The form read.
    extractFields: page.extractFields.bind(page),
    // The closed-posting read, when the page has one.
    ...(page.postingClosed === undefined ? {} : { postingClosed: page.postingClosed.bind(page) }),
    // The pre-click facts, when the page has them.
    ...(page.presubmitFacts === undefined ? {} : { presubmitFacts: page.presubmitFacts.bind(page) }),
  };
}

/** Everything a rehearsal needs. Data, not gateways: the caller has already done the reads. */
export interface RehearsalInput {
  // The application under rehearsal.
  readonly applicationId: string;
  // The job's stored apply URL, before resolution.
  readonly applyUrl: string;
  // The employer, for planFill's "previously worked at <company>" question, as assist passes it.
  readonly company: string;
  // The frozen, approved resume content.
  readonly tailoredProfile: ResolvedResume;
  // The latest master; null refuses, exactly as assist does.
  readonly master: MasterProfile | null;
  // The owner's answer bank.
  readonly answers: readonly AnswerBankRow[];
  // The read-only page.
  readonly page: RehearsalPage;
  // The applier's robots gate.
  readonly checkRobots: RobotsCheck;
  // The applier's form-URL resolver.
  readonly resolveFormUrl: FormUrlResolver;
  // The resume renderer; rendering is local and writes nothing remote.
  readonly renderResume: (resume: ResolvedResume) => Promise<RenderedResume>;
}

/** What the rehearsal found, step by step. `stoppedAt` names the step that ended it early, if any. */
export interface RehearsalReport {
  // Null when it ran to the end; otherwise why it stopped, in the same words assist would refuse with.
  readonly stoppedAt: string | null;
  // Identity facts the human did not see at approval (assist prints these as PROBLEM lines).
  readonly identityDrift: readonly string[];
  // The URL robots was asked about and the page loaded.
  readonly formUrl: string | null;
  // The robots answer for formUrl.
  readonly robots: RobotsVerdict | null;
  // A captcha or login wall on the loaded page.
  readonly blocker: string | null;
  // The form as read.
  readonly fields: readonly FormField[];
  // What assist would type, and what it would leave to the human.
  readonly plan: FillPlan | null;
  // The file input the resume would go into, or null.
  readonly resumeTarget: string | null;
  // Fields the attachment planner could not place.
  readonly attachBlockers: readonly string[];
  // The rendered resume, when there is a target.
  readonly resume: { readonly fileName: string; readonly bytes: number; readonly isPdf: boolean } | null;
  // Whether the live submit would go ahead, or the FIRST check that would stop it (task 2). The CLI's
  // "ready" reads this, so a row is ready only when every check the live path runs has passed.
  readonly verdict: SubmitVerdict;
}

/** Run every step assist runs up to the click, writing nothing. */
export async function rehearseAssisted(input: RehearsalInput): Promise<RehearsalReport> {
  // The empty report, filled in as steps succeed, so an early stop still says how far it got.
  // Its verdict starts as a block: "would submit" is produced in exactly one place, after every check ran.
  let report: RehearsalReport = { stoppedAt: null, identityDrift: [], formUrl: null, robots: null, blocker: null, fields: [], plan: null, resumeTarget: null, attachBlockers: [], resume: null, verdict: { kind: 'would_block', check: 'rehearsal_stopped', detail: 'not reached' } };
  // An early stop: its reason is both `stoppedAt` and the verdict's detail, so the two can never disagree.
  const stop = (why: string, check: 'rehearsal_stopped' | 'form_shape' = 'rehearsal_stopped'): RehearsalReport => ({ ...report, stoppedAt: why, verdict: { kind: 'would_block', check, detail: why } });
  // A block found after the form was read: not a stop (every row still prints), only the verdict changes.
  const block = (verdict: SubmitVerdict): RehearsalReport => ({ ...report, verdict });
  // No master: assist refuses here (no identity to put on the resume), so the rehearsal stops too.
  if (input.master === null) return stop('no master profile: the resume identity must come from the latest master');
  // The resume assist would render: approved content under the latest master's identity (G2).
  const resume: ResolvedResume = { ...input.tailoredProfile, identity: input.master.identity };
  // The drift assist would print.
  report = { ...report, identityDrift: identityDriftWarnings(input.tailoredProfile.identity, input.master.identity) };
  // Resolved first, then robots on that same URL (assist's ruling a).
  const formUrl = await input.resolveFormUrl({ id: input.applicationId, applyUrl: input.applyUrl });
  // The gate, under the applier's own token.
  const robots = await input.checkRobots(formUrl);
  // Recorded before the verdict is acted on.
  report = { ...report, formUrl, robots };
  // Only an explicit allow opens the page, as in assist.
  if (robots.kind !== 'allow') return stop(`robots ${robots.kind}: ${robots.reason}`);
  // The real form.
  await input.page.goto(formUrl);
  // A wall is informational in assist (the human handles it); recorded here the same way.
  const blocker = await input.page.detectBlocker();
  // The form as assist would read it.
  const fields = await input.page.extractFields();
  // The planner decision assist would act on.
  const plan = planFill(fields, input.answers, input.master, input.company);
  // Where the resume would go.
  const attachment = planResumeAttachment(fields, { hasResumeSnapshot: true });
  // Everything except the render.
  report = { ...report, blocker, fields, plan, resumeTarget: attachment.target?.label ?? null, attachBlockers: attachment.blockers.map((b) => b.label) };
  // The applier's form-shape gate, the same predicate (2026-11-08). Without it 0 fields gave an empty plan
  // and no upload box, every check PASSed, and the CLI said "ready" for a page with no form at all.
  // Since 2026-11-09 it also stops a page with controls but no email box (an aggregator, a careers index).
  const [notAForm] = formShapeBlockersFor(input.applicationId, fields);
  // A stop, which the CLI prints as a FAIL row: absence of a form is never a form that is done.
  if (notAForm !== undefined) return stop(notAForm.label, 'form_shape');
  // The upload box gets the exact bytes assist would attach; no box is a legitimate shape, nothing to render.
  if (attachment.target !== null) {
    // The exact bytes assist would attach.
    const rendered = await input.renderResume(resume);
    // "%PDF" magic, so a renderer that returned HTML or nothing is caught here, not on the employer's form.
    const isPdf = rendered.bytes.length >= 4 && String.fromCharCode(...rendered.bytes.slice(0, 4)) === '%PDF';
    // Recorded before the verdict, so the CLI's resume row prints either way.
    report = { ...report, resume: { fileName: resumeFileName(resume), bytes: rendered.bytes.length, isPdf } };
  }
  // THE VERDICT, in the live path's order. A wall hides the real form: the live applier parks on it.
  if (blocker !== null) return block({ kind: 'would_block', check: 'page_blocker', detail: blocker });
  // A question left for the human (human_only, unanswered, no option match): the live applier parks.
  if (plan.blockers.length > 0) return block({ kind: 'would_block', check: 'fill_plan', detail: plan.blockers.map((b) => b.label).join('; ') });
  // The resume has nowhere to go: canProceed is the attachment planner's own answer, read, not inferred.
  if (!attachment.canProceed) return block({ kind: 'would_block', check: 'attachment', detail: attachment.blockers.map((b) => b.label).join('; ') || 'the resume cannot be attached' });
  // A render that is not a PDF would put the wrong bytes on the form.
  if (report.resume !== null && !report.resume.isPdf) return block({ kind: 'would_block', check: 'resume_not_pdf', detail: `${report.resume.fileName} does not start with %PDF` });
  // The opened posting's own word, as recheckBeforeSubmit asks it; a page that cannot say is treated as open there too.
  const closed = input.page.postingClosed === undefined ? null : await input.page.postingClosed();
  // A closed posting would be parked before the click.
  if (closed !== null) return block({ kind: 'would_block', check: 'posting_closed', detail: closed });
  // A page that cannot report its pre-click facts cannot be judged: refused by name, never passed.
  if (input.page.presubmitFacts === undefined) return block({ kind: 'would_block', check: 'presubmit_unavailable', detail: 'the page cannot report its pre-click facts' });
  // Nothing is typed in a rehearsal, so every control a planned fill or the resume will answer counts as
  // covered; what is left blank AND required is a question the live submit would refuse on (Lever's ✱ card).
  const covered = [...plan.fills.map((fill) => fill.id), ...(attachment.target === null ? [] : [attachment.target.id])];
  // The page's facts, minus the covered controls.
  const facts = await input.page.presubmitFacts(covered);
  // `invalid` is dropped: on an untyped page the browser marks every blank required box :invalid, including
  // the covered ones, so it measures "not typed yet", not "would be refused"; requiredEmpty answers that.
  return block(verdictFromFacts({ ...facts, invalid: [] }));
}
