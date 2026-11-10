// The manual apply kit: for ONE application, open its live form, plan every field from our
// own data, render a fresh resume, and record it all as one application_events note, so
// Teja can fill the form by hand in a minute.
//
// WHY IT EXISTS (2026-10-24): Greenhouse's reCAPTCHA Enterprise refuses a CI submit
// (GitLab ba1e5d1d, code captcha-failed), so some applications are sent by hand. Every
// answer must still come from the system: the tailored resume, the identity, the answer
// bank, the custom questions.
//
// WHAT IT MUST NEVER DO, and how each is made structural rather than promised:
// - Send anything. The page port is `KitPage`: goto, extractFields, detectBlocker,
//   postingClosed and readMenuOptions (opens a combobox menu, reads it, presses Escape) ONLY.
//   There is no fill, attachFile or submit on it to call, so no form input is ever
//   typed into a browser that could submit it.
// - Move a row. The gateway port is `KitGateway`: no status method, no claim, no release.
// - Invent an answer (CLAUDE.md §6). Values come from planFill, the SAME planner apply-one
//   uses, so the kit equals what the bot would have typed; anything it refuses stays
//   `value: null, source: 'unanswered'`.
// Contract with the web side (peer 2, apps/web): `ApplyKitDetail`, v1. Change it only together.

// Type-only: shapes from the schema owner.
import type { AnswerBankRow, ApplicationStatus, MasterIdentity, MasterProfile, ResolvedResume } from '@applyy/shared-types';
// The pre-submit port this kit narrows, the renderer port, and the robots port: reused, not forked.
import type { ApplicationPage, ResumeRenderer, RobotsCheck } from './apply-one.ts';
// The applier's own form-shape gate (2026-11-09): the kit and the applier must agree on what is "not a form".
import { formShapeBlockersFor } from './apply-one.ts';
// The applier's own form-URL resolver port, so the kit opens the same form the applier would.
import type { FormUrlResolver } from './form-url.ts';
// The control shape the extractor returns.
import type { FormField } from './extract-fields.ts';
// The one planner. Read-only reuse: a fork would let the kit and the bot disagree.
import { planFill, type FillBlocker, type PlannedFill } from './plan-fill.ts';
// Which file input takes the resume, and the file's name: the same rules apply-one uses.
import { planResumeAttachment, resumeFileName } from './plan-resume-attachment.ts';
// The production gateway, whose reads and two writes the kit gateway delegates to.
import { createSupabaseGateway, type GatewayConfig, type SupabaseLike } from './supabase-gateway.ts';

/** The statuses a kit may be built for: everything between approval and a final answer. */
export const KIT_STATUSES: readonly ApplicationStatus[] = ['approved', 'applying', 'needs_verification', 'blocked_needs_human'];

/**
 * A refusal that is the system working, not a fault (B2, 2026-11-05): the posting is closed. ('robots_refused'
 * is no longer thrown since K2, 2026-11-06, which gives that row a resume-only kit; the code stays because
 * old skip notes carry it and the web reads them.) The sweep records it once (an apply_kit_skipped note) and reports it, so the run stays
 * green and the row is not retried until its status changes. A closed set of codes, so a new cause is a
 * deliberate change here, never a guessed string.
 */
export class KitSkip extends Error {
  // Named for logs and for toMatchObject in tests.
  override readonly name = 'KitSkip';
  // The cause, written into the skip note.
  // no_apply_url (W29 residual, 2026-11-09): the job has no form URL, so no kit can open a form for it.
  readonly code: 'robots_refused' | 'posting_closed' | 'no_apply_url';
  // A plain constructor: parameter properties are not erasable syntax (tsconfig erasableSyntaxOnly).
  constructor(code: KitSkip['code'], message: string) {
    // The message is the refusal's own text.
    super(message);
    // Kept for the sweep's note.
    this.code = code;
  }
}

/** The control kind as the web renders it. A closed union, mapped once from FormField['kind']. */
export type KitInputType = 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'file' | 'other';

/** Where a kit value came from. `unanswered` is the only source allowed a null value. */
export type KitSource = 'identity' | 'tailored' | 'answer_bank' | 'derived' | 'unanswered';

/** One form field as the kit presents it. */
export interface ApplyKitField {
  // The question as the form shows it (the upload group's label for a file input).
  readonly label: string;
  // What to type or pick; null exactly when source is `unanswered`.
  readonly value: string | null;
  // Which of our data supplied it.
  readonly source: KitSource;
  // Whether the form refuses to submit without it.
  readonly required: boolean;
  // How to enter it.
  readonly input_type: KitInputType;
  // The form's own options: read without interaction (selects, radios), or from a combobox's opened menu.
  readonly options?: string[];
}

/** The note's `detail`: the v1 contract the web side reads. */
export interface ApplyKitDetail {
  // The note's discriminator among application_events notes.
  readonly kind: 'apply_kit';
  // Contract version; bumped only with the web side.
  readonly v: 1;
  // When the kit was built, ISO 8601.
  readonly generated_at: string;
  // The CI run that built it, or null for a local run.
  readonly run_id: string | null;
  // The form the kit was planned against.
  readonly form_url: string;
  // The freshly rendered resume, or null when the row has no tailored snapshot.
  readonly resume: { readonly storage_path: string; readonly file_name: string } | null;
  // Every field the form asks for, in form order.
  readonly fields: ApplyKitField[];
  // Everything Teja should know before filling: refusals, identity drift, page walls.
  readonly warnings: string[];
}

/** The application row, narrowed to what the kit needs. */
export interface KitApplication {
  readonly id: string;
  // Checked against KIT_STATUSES before anything else happens.
  readonly status: ApplicationStatus;
  // jobs.apply_url, the canonical form.
  readonly applyUrl: string;
  // applications.tailored_profile: the CONTENT source. Null means no resume can be made.
  readonly tailoredProfile: ResolvedResume | null;
  // jobs.company_name, for the planner's "previously worked at <company>?".
  readonly employerName: string | null;
}

/** The database operations the kit needs. Deliberately no status, claim or release method. */
export interface KitGateway {
  // One row by id, with its job's form URL and company; null when it does not exist.
  fetchApplication(applicationId: string): Promise<KitApplication | null>;
  // The latest master: the ONLY source of contact identity (one-email ruling, 2026-10-24).
  fetchLatestProfile(): Promise<MasterProfile | null>;
  // The answer bank, exactly as apply-one reads it.
  fetchAnswers(): Promise<readonly AnswerBankRow[]>;
  // Stores a resume under a NEW timestamped path; never overwrites an earlier one.
  uploadResume(applicationId: string, bytes: Uint8Array): Promise<string>;
  // The one row the kit writes: an append-only note.
  appendApplicationNote(applicationId: string, detail: Record<string, unknown>): Promise<void>;
  // H2: report the planner's refused required fields (unanswered_questions). Best-effort. Optional so test
  // doubles need not grow it; createKitGateway's return type makes it required in production.
  recordUnansweredQuestions?(applicationId: string, blockers: readonly FillBlocker[]): Promise<void>;
}

/** The page operations the kit may use: reading only. No fill, attachFile or submit exists here. */
// postingClosed and readMenuOptions only READ (opening a menu and closing it types nothing); both are
// optional on ApplicationPage, so a test page without them still type-checks.
export type KitPage = Pick<ApplicationPage, 'goto' | 'extractFields' | 'detectBlocker' | 'postingClosed' | 'readMenuOptions'>;

/** Everything one kit needs, injected. */
export interface BuildApplyKitInput {
  readonly applicationId: string;
  readonly gateway: KitGateway;
  readonly page: KitPage;
  // apply-one's renderer port, so the PDF is made exactly as a bot run makes it.
  readonly renderResume: ResumeRenderer;
  // Required: the robots gate governs the page load, as in apply-one.
  readonly checkRobots: RobotsCheck;
  // Optional for the reason apply-one gives: absent means the stored URL, today's behaviour.
  readonly resolveFormUrl?: FormUrlResolver;
  // The CI run id, or null locally.
  readonly runId: string | null;
  // The clock, injected so generated_at is testable.
  readonly now: () => Date;
}

/** FormField['kind'] in the web's vocabulary. */
function inputTypeOf(kind: FormField['kind']): KitInputType {
  // Single-line text in every flavour.
  if (kind === 'text' || kind === 'email' || kind === 'tel') return 'text';
  // React-select and native selects are both "pick one" to a human.
  if (kind === 'combobox' || kind === 'native_select') return 'select';
  // One field per radio group.
  if (kind === 'radio_group') return 'radio';
  // The rest map one to one.
  if (kind === 'textarea' || kind === 'checkbox' || kind === 'file') return kind;
  // Unreachable today; a new extractor kind degrades to `other` instead of failing the kit.
  return 'other';
}

/** The identity facts a profile-sourced value can equal, lower-cased: whole values plus location parts. */
function identityFacts(identity: MasterIdentity): Set<string> {
  // The scalar facts, and every comma-separated part of the location (the planner reads city and country from it).
  const parts = [identity.full_name, identity.email, identity.phone, identity.location, ...(identity.location ?? '').split(',')];
  // Every link URL, in master order.
  const links = Array.from(identity.links ?? [], (link) => link.url);
  // Trimmed and lower-cased; blanks dropped so "" never matches.
  return new Set([...parts, ...links].filter((fact): fact is string => typeof fact === 'string' && fact.trim() !== '').map((fact) => fact.trim().toLowerCase()));
}

/**
 * The planner's source in the kit's vocabulary. The planner says only `profile`, which
 * covers two different things: a contact fact copied verbatim (identity) and an answer
 * worked out from the profile ("previously worked at GitLab?" from the experience list,
 * the current company). A value equal to an identity fact is `identity`; anything else
 * the profile produced is `derived`. Equality, never substring: "No" must not match "Noida".
 */
function sourceOf(fill: PlannedFill, facts: ReadonlySet<string>): KitSource {
  // A human-saved answer keeps its name.
  if (fill.source === 'answer_bank') return 'answer_bank';
  // A verbatim identity fact.
  return facts.has(fill.value.trim().toLowerCase()) ? 'identity' : 'derived';
}

/** One warning per identity fact the frozen snapshot holds differently from the latest master. */
// Exported (G2, 2026-11-06) so the assisted path says the same drift out loud; wording names "the resume",
// which is true for both callers.
export function identityDriftWarnings(snapshot: MasterIdentity, latest: MasterIdentity): string[] {
  // The facts a form or the resume header prints.
  const keys = ['full_name', 'email', 'phone', 'location'] as const;
  // Compared as written; a difference is reported with both values so Teja can see it.
  const drift = keys
    .filter((key) => (snapshot[key] ?? null) !== (latest[key] ?? null))
    .map((key) => `identity.${key}: the row's tailored_profile has "${snapshot[key] ?? ''}", the latest master has "${latest[key] ?? ''}"; the resume uses the latest master (one-email ruling, 2026-10-24)`);
  // Links compared as their ordered URL lists.
  const urls = (identity: MasterIdentity) => Array.from(identity.links ?? [], (link) => link.url).join(' ');
  // One line for the whole list.
  if (urls(snapshot) !== urls(latest)) drift.push('identity.links: the row\'s tailored_profile differs from the latest master; the resume uses the latest master');
  return drift;
}

/** A planner refusal, phrased for the human who will answer it. */
function refusalWarning(blocker: FillBlocker | { readonly label: string; readonly reason: string }): string {
  // The planner's own reason code is kept verbatim, so it can be matched against plan-fill.ts.
  return `"${blocker.label}" needs your answer (${blocker.reason})`;
}

/**
 * The kit's resume: the row's snapshot CONTENT under the latest master's IDENTITY, rendered and uploaded,
 * or null (with a warning) when the row has no snapshot. Identity drift is pushed onto `warnings`.
 */
async function renderKitResume(input: BuildApplyKitInput, row: KitApplication, master: MasterProfile, warnings: string[]): Promise<ApplyKitDetail['resume']> {
  // No snapshot: there is no resume to hand over, and the warning says so.
  if (row.tailoredProfile === null) {
    // Said, so an empty resume slot is explained.
    warnings.push('the row has no tailored_profile, so no resume was rendered');
    return null;
  }
  // Every identity drift between the snapshot and the master, said out loud.
  warnings.push(...identityDriftWarnings(row.tailoredProfile.identity, master.identity));
  // The one merge the ruling makes: identity swapped, every content section kept.
  const merged: ResolvedResume = { ...row.tailoredProfile, identity: master.identity };
  // apply-one's renderer, so this PDF is the one a bot run would attach.
  const rendered = await input.renderResume(merged);
  // A NEW timestamped path under the row's prefix; resume_storage_path is not touched.
  return { storage_path: await input.gateway.uploadResume(row.id, rendered.bytes), file_name: resumeFileName(merged) };
}

/**
 * K2 (2026-11-06): the kit for a form the system cannot read (robots refused, or no fields and no
 * closed evidence). No form answers, the resume, and the reason as the first warning, recorded as an
 * ordinary v1 apply_kit note: the web shows it as a kit, and the sweep counts it as current, so the
 * row is not retried every run. A posting the page itself calls closed is still a KitSkip.
 */
async function writeResumeOnlyKit(input: BuildApplyKitInput, row: KitApplication, master: MasterProfile, formUrl: string, reasons: string[]): Promise<ApplyKitDetail> {
  // The reasons first, so the top warning says why there are no answers.
  const warnings = [...reasons];
  // The same resume a full kit carries.
  const resume = await renderKitResume(input, row, master, warnings);
  // THE NOTE, in the v1 contract, with no fields.
  const detail: ApplyKitDetail = { kind: 'apply_kit', v: 1, generated_at: input.now().toISOString(), run_id: input.runId, form_url: formUrl, resume, fields: [], warnings };
  // The kit's one row write: append-only, and no status moves.
  await input.gateway.appendApplicationNote(row.id, detail as unknown as Record<string, unknown>);
  // Returned too, so the CLI can print it.
  return detail;
}

/**
 * Build one apply kit, record it as a note, and return it.
 *
 * Order: read the row (refuse a wrong status before touching anything), read the master
 * and the bank, ask robots.txt, load the form, plan, render and upload the resume, append
 * the note. Every step before the upload is a read, so a refusal anywhere writes nothing.
 */
export async function buildApplyKit(input: BuildApplyKitInput): Promise<ApplyKitDetail> {
  // Unpacked once.
  const { applicationId, gateway, page } = input;

  // THE ROW FIRST: a wrong id or status must stop the kit before a page or a write.
  const row = await gateway.fetchApplication(applicationId);
  // Not found (or not this user's, under RLS): nothing to build.
  if (row === null) throw new Error(`apply kit: application ${applicationId} not found`);
  // Only between approval and a final answer; a sent or dropped row needs no kit.
  if (!KIT_STATUSES.includes(row.status)) {
    throw new Error(`apply kit: application ${applicationId} is ${row.status}; a kit is built only for ${KIT_STATUSES.join(' | ')}`);
  }

  // THE LATEST MASTER, the one identity source. Without it there is no contact data that
  // follows the ruling, so the kit refuses rather than fall back to a stale snapshot.
  const master = await gateway.fetchLatestProfile();
  // Fail closed: a kit built on the old identity would repeat the very mistake it fixes.
  if (master === null) throw new Error('apply kit: no master profile; contact identity must come from the latest master');
  // The bank, as apply-one reads it.
  const answers = await gateway.fetchAnswers();

  // THE ROBOTS GATE, before the page load it governs. Only an explicit allow passes.
  // The form's real URL first (an iframed Greenhouse form resolves to Greenhouse), so the gate asks about it.
  const formUrl = input.resolveFormUrl === undefined ? row.applyUrl : await input.resolveFormUrl(row);
  // The gate, on the URL that will be loaded.
  const robots = await input.checkRobots(formUrl);
  // Refused, waiting or unreadable: the form is never opened. A 'wait' (transient) stays a plain error that
  // writes nothing, because tomorrow may differ and a red run is how that is seen. (B2 made a definite
  // refusal a typed skip; K2 below replaced that with a resume-only kit.)
  // K2 (2026-11-06): a definite refusal now gets a RESUME-ONLY kit. The resume needs no page fetch, so the
  // page stays unopened and the robots ruling holds; Teja gets the resume and the link instead of
  // "Kit pending" (Tether 04d5c6e4, arbeitnow's 403). Written once, so the sweep does not retry it.
  if (robots.kind === 'refuse') return writeResumeOnlyKit(input, row, master, formUrl, [`robots.txt refuses ${formUrl} (${robots.reason}), so the form was not opened or read; open it and fill it by hand with this resume`]);
  // Waiting or unreadable: a real failure.
  if (robots.kind !== 'allow') throw new Error(`apply kit: robots.txt did not allow ${formUrl} (${robots.kind}: ${robots.reason})`);

  // Loading a form is fine from CI; only a submit trips the captcha.
  await page.goto(formUrl);
  // A wall on the page is worth knowing before Teja opens it.
  const wall = await page.detectBlocker();
  // The form's controls, read from the accessibility tree.
  const fields = await page.extractFields();
  // ZERO FIELDS IS NOT EVIDENCE OF A CLOSED POSTING (T1, 2026-11-05). An Ashby form read before it
  // rendered had 0 fields, and the backstop below called 11 open postings closed. goto now waits for
  // the form, so 0 fields means the page never rendered one we can read (an iframe-only company page, a
  // client app slower than the wait). Closed only when the page itself says so; otherwise (K2) a
  // resume-only kit that says the form could not be read, never a skip that would call it closed.
  // NOT A FORM IS NOT CLOSED (2026-11-09). The applier's form-shape gate decides "is this a form", and the
  // page's own evidence alone decides "is it closed". Leak 3 (2026-11-05) once named every page without an
  // email box posting_closed; on 2026-11-09 all 4 live posting_closed notes came from that guess and none from
  // evidence: jobicy's open Supabase listing (validThrough 2026-12-06) and two rows Teja then applied to by hand.
  const [notAForm] = formShapeBlockersFor(row.id, fields);
  // An empty page (no_form_fields) or a page with controls but no email box (no_email_field).
  if (notAForm !== undefined) {
    // The page's own evidence: an HTTP error status or a closed-posting sentence. Absent method = none.
    const closed = page.postingClosed === undefined ? null : await page.postingClosed();
    // The page said it: a closed posting, quoted. The only way to posting_closed.
    if (closed !== null) throw new KitSkip('posting_closed', `apply kit: posting_closed: ${formUrl}: ${closed}`);
    // No evidence: open as far as we can tell, but no form the bot can read. K2: a resume-only kit, written
    // once, instead of a failure retried every run (L&T 7890ff1b's peoplestrong form sat at "Kit pending").
    // The two shapes get their own sentence, because Teja acts differently on each.
    const reason = notAForm.reason === 'no_form_fields'
      // Nothing rendered: a slow client app or an iframe-only page.
      ? `could not read the form at ${formUrl} (no form fields appeared within the wait, and the page does not say the posting is closed); open it and fill it by hand with this resume`
      // Controls but no email box: an aggregator's job page or a careers index (a closed posting can redirect there too).
      : `no bot-usable application form at ${formUrl}: ${notAForm.label}. The page does not say the posting is closed; it is likely a job board or careers page, so open it, follow its apply link and fill the form by hand with this resume`;
    // The note, with the wall if one was seen.
    return writeResumeOnlyKit(input, row, master, formUrl, wall === null ? [reason] : [reason, `the form page shows a ${wall} wall; expect to clear it by hand`]);
  }

  // THE SAME PLAN the bot would have typed: latest master for identity facts, the bank for
  // saved answers, the job's company for "previously worked at".
  const plan = planFill(fields, answers, master, row.employerName);
  // The same resume-box decision apply-one makes.
  const attachment = planResumeAttachment(fields, { hasResumeSnapshot: row.tailoredProfile !== null });

  // Collected as they are found, shown together.
  const warnings: string[] = [];
  // A captcha or login wall named up front.
  if (wall !== null) warnings.push(`the form page shows a ${wall} wall; expect to clear it by hand`);

  // THE RESUME: the snapshot's CONTENT under the latest master's IDENTITY (shared with the resume-only kit).
  const resume = await renderKitResume(input, row, master, warnings);

  // Lookups for the field walk.
  const fillById = new Map(plan.fills.map((fill) => [fill.id, fill]));
  // The facts that make a profile value `identity` rather than `derived`.
  const facts = identityFacts(master.identity);

  // T3 (2026-11-05): every combobox's options, read by opening its menu, so Teja answers with an
  // option's exact text (a free-typed answer never matched one). One at a time, in form order: two
  // menus open at once would be read into each other. Kept beside the fields, never written into
  // FormField.options, so the plan above (already made) keeps its fill-time checking for comboboxes.
  const menuOptions = new Map<string, string[]>();
  // Only when the page can read menus.
  if (page.readMenuOptions !== undefined) {
    for (const field of fields) {
      // Comboboxes only: native selects and radios already carry their options.
      if (field.kind !== 'combobox') continue;
      // A widget that will not open costs this field its list, never the kit.
      const texts = await page.readMenuOptions(field.id).catch(() => null);
      // Only a real list is kept; null (a search box) leaves the field without one.
      if (texts !== null) menuOptions.set(field.id, texts);
    }
  }

  // EVERY FIELD, in form order.
  const kitFields: ApplyKitField[] = fields.map((field) => {
    // An upload's own label is "Attach"; the group's ("Resume/CV") is the question.
    const label = field.kind === 'file' ? field.groupLabel ?? field.label : field.label;
    // Required on the control, or (for uploads) on its group.
    const required = field.required || field.groupRequired === true;
    // Shared shape for every branch below.
    // The form's options: read without interaction, or (comboboxes) from the opened menu above.
    const options = field.options ?? menuOptions.get(field.id);
    // Shared shape for every branch below; the key is absent when no list is known.
    const base = { label, required, input_type: inputTypeOf(field.kind), ...(options === undefined ? {} : { options: [...options] }) };
    // The resume box gets the freshly rendered file.
    if (field.kind === 'file') {
      // Only the planner's chosen box, and only when a resume exists.
      const isResume = attachment.target?.id === field.id && resume !== null;
      return isResume ? { ...base, value: resume!.file_name, source: 'tailored' as const } : { ...base, value: null, source: 'unanswered' as const };
    }
    // A planned value, with its source.
    const fill = fillById.get(field.id);
    // Planned: copied verbatim from the bank or the master.
    if (fill !== undefined) return { ...base, value: fill.value, source: sourceOf(fill, facts) };
    // Refused or unknown: never guessed.
    return { ...base, value: null, source: 'unanswered' as const };
  });

  // Every required refusal, with the planner's reason, and every resume-box problem.
  warnings.push(...plan.blockers.map(refusalWarning), ...attachment.blockers.map(refusalWarning));
  // H2: report every refused required field, so the Answer bank page asks Teja once. Best-effort: caught,
  // so a failed report never costs the kit. plan.blockers only: attachment blockers name no question.
  await gateway.recordUnansweredQuestions?.(row.id, plan.blockers).catch((error: unknown) => console.warn('[unanswered]', error));

  // THE NOTE, in the v1 contract.
  const detail: ApplyKitDetail = {
    kind: 'apply_kit',
    v: 1,
    generated_at: input.now().toISOString(),
    run_id: input.runId,
    // The page the fields were read from, so "Open the form" lands on the same form, not its wrapper.
    form_url: formUrl,
    resume,
    fields: kitFields,
    warnings,
  };
  // The kit's one row write: append-only, and no status moves.
  await gateway.appendApplicationNote(row.id, detail as unknown as Record<string, unknown>);
  // Returned too, so the CLI can print it.
  return detail;
}

/**
 * The kit gateway over a supabase-js client. Reads and the two writes delegate to the
 * production gateway, so storage paths and the note insert match a bot run exactly; the
 * one new read is the row by id, which the production gateway only offers through a claim.
 */
// The kill-switch read rides BESIDE KitGateway, not in it, as supabase-assist-gateway does:
// buildApplyKit never reads it, so its test doubles need not grow a method it does not call.
// H2: recordUnansweredQuestions is REQUIRED on this return type, so the production kit cannot ship without it.
export function createKitGateway(client: SupabaseLike, config: GatewayConfig): KitGateway & { isSystemEnabled(): Promise<boolean>; recordUnansweredQuestions(applicationId: string, blockers: readonly FillBlocker[]): Promise<void> } {
  // The production gateway; only the methods below are exposed, never its status writes.
  const production = createSupabaseGateway(client, config);
  return {
    // W28: the applier's own kill-switch read, reused: missing row reads false, a refused read throws.
    isSystemEnabled: () => production.isSystemEnabled(),
    async fetchApplication(applicationId) {
      // The row. Errors surface as {error}, so they are checked, not assumed away.
      const app = await client.from('applications').select('id, status, tailored_profile, job_id').eq('id', applicationId).maybeSingle();
      // supabase-js does not throw: a refused read must not read as "not found".
      if (app.error) throw new Error(`apply kit: read application failed: ${app.error.message}`);
      // No row: not found (or not this user's).
      if (app.data === null) return null;
      // The job carries the form URL and the company, as in the claim's second read.
      const job = await client.from('jobs').select('apply_url, company_name').eq('id', app.data.job_id).maybeSingle();
      // Same rule for the job read.
      if (job.error) throw new Error(`apply kit: read job failed: ${job.error.message}`);
      // No job row at all is a broken reference, not a skip: it stays a failure the run reports.
      if (job.data === null) throw new Error(`apply kit: application ${applicationId} has no jobs row`);
      // W29 residual: a job with no form URL ('' or whitespace; the column is NOT NULL) cannot be kitted. A plain
      // Error here failed the sweep every day for an approved row; a KitSkip is noted once and the run stays green,
      // and the Manual apply card says why. A non-string is malformed data, so it stays a failure.
      if (typeof job.data.apply_url !== 'string') throw new Error(`apply kit: application ${applicationId} has a malformed jobs.apply_url`);
      // Blank after trimming: no form to open.
      if (job.data.apply_url.trim() === '') throw new KitSkip('no_apply_url', `apply kit: no_apply_url: application ${applicationId}'s job has no form URL`);
      // Narrowed to the kit's shape.
      return {
        id: app.data.id,
        status: app.data.status,
        applyUrl: job.data.apply_url,
        tailoredProfile: app.data.tailored_profile ?? null,
        employerName: job.data.company_name ?? null,
      };
    },
    // Delegated: the same reads a bot run makes.
    // Optional on RunGateway, always present on the supabase gateway; absent reads as "no master" (the kit then refuses).
    fetchLatestProfile: async () => (production.fetchLatestProfile === undefined ? null : production.fetchLatestProfile()),
    fetchAnswers: () => production.fetchAnswers(),
    // Delegated: the same timestamped path a bot run uploads to, so nothing is overwritten.
    uploadResume: (applicationId, bytes) => production.uploadResume(applicationId, bytes),
    // Delegated: the same append-only insert the unknown-outcome note uses.
    appendApplicationNote: (applicationId, detail) => production.appendApplicationNote(applicationId, detail),
    // H2: the production report, so the kit and the applier send the same items.
    recordUnansweredQuestions: (applicationId, blockers) => production.recordUnansweredQuestions(applicationId, blockers),
  };
}
