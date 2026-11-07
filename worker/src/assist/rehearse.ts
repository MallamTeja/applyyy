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
// Type-only: data shapes the rehearsal reads.
import type { AnswerBankRow, MasterProfile, ResolvedResume } from '@applyy/shared-types';
// Type-only: the full page port (only so readOnlyPage can narrow it) and the robots port.
import type { ApplicationPage, RobotsCheck } from '../apply-one.ts';
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

/** The only page methods a rehearsal may use: it loads and reads, nothing else. */
export type RehearsalPage = Pick<ApplicationPage, 'goto' | 'detectBlocker' | 'extractFields'>;

/**
 * The read-only port over a real page: a NEW object carrying the three read methods only.
 *
 * A cast would keep fill/attachFile/submit on the object at runtime; copying does not.
 */
export function readOnlyPage(page: ApplicationPage): RehearsalPage {
  // Bound, so `this` inside the adapter still points at the real page.
  return { goto: page.goto.bind(page), detectBlocker: page.detectBlocker.bind(page), extractFields: page.extractFields.bind(page) };
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
}

/** Run every step assist runs up to the click, writing nothing. */
export async function rehearseAssisted(input: RehearsalInput): Promise<RehearsalReport> {
  // The empty report, filled in as steps succeed, so an early stop still says how far it got.
  let report: RehearsalReport = { stoppedAt: null, identityDrift: [], formUrl: null, robots: null, blocker: null, fields: [], plan: null, resumeTarget: null, attachBlockers: [], resume: null };
  // No master: assist refuses here (no identity to put on the resume), so the rehearsal stops too.
  if (input.master === null) return { ...report, stoppedAt: 'no master profile: the resume identity must come from the latest master' };
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
  if (robots.kind !== 'allow') return { ...report, stoppedAt: `robots ${robots.kind}: ${robots.reason}` };
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
  // No upload box: a legitimate shape, nothing to render.
  if (attachment.target === null) return report;
  // The exact bytes assist would attach.
  const rendered = await input.renderResume(resume);
  // "%PDF" magic, so a renderer that returned HTML or nothing is caught here, not on the employer's form.
  const isPdf = rendered.bytes.length >= 4 && String.fromCharCode(...rendered.bytes.slice(0, 4)) === '%PDF';
  // Done: every step short of fill, attach and submit.
  return { ...report, resume: { fileName: resumeFileName(resume), bytes: rendered.bytes.length, isPdf } };
}
