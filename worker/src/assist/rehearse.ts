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
// Today's matcher gates, the very function recheckBeforeSubmit runs before a live submit (task 3).
import { auditorPreGateDrop, type AuditorJobEmbed } from '../../../supabase/functions/auditor/pregate.ts';
// The config loader the claim loop's gateway uses, and its read port, so the rehearsal maps config identically.
import type { ConfigReader, LoadedPreGatePreferences } from '../../../supabase/functions/_shared/pregate-config-loader.ts';
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
  // Task 3 (2026-11-09): what the live re-check judges, read by the caller: the row's job (null = the job
  // row could not be read) and today's gate config as loadPreGatePreferences returned it. REQUIRED, so a
  // caller cannot forget it and get a rehearsal that silently skips the gate the live submit runs.
  readonly preGate: { readonly job: AuditorJobEmbed | null; readonly config: LoadedPreGatePreferences };
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
  // TODAY'S GATES (task 3), as recheckBeforeSubmit runs them first in its re-check. Unreadable config is
  // the live run's refusal to start, so it is never a pass here either.
  if (input.preGate.config.kind === 'error') return block({ kind: 'would_block', check: 'recheck_unavailable', detail: `today's gate config is unreadable (${input.preGate.config.code}): ${input.preGate.config.message}` });
  // No job: recheckBeforeSubmit's own refusal, word for word.
  if (input.preGate.job === null) return block({ kind: 'would_block', check: 'pre_gate', detail: "the job row could not be read, so today's gates could not run" });
  // The auditor's verdict with today's config; recheckBeforeSubmit calls this same function on the same inputs.
  const drop = auditorPreGateDrop(input.preGate.job, input.preGate.config.preferences);
  // A drop names its gate (work-auth, experience ceiling, titles/keywords).
  if (drop !== null) return block({ kind: 'would_block', check: 'pre_gate', detail: drop.reason });
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

/**
 * The row's job as the re-check reads it (task 3): the same five fields and null-defaults the claim loop's
 * gateway builds (supabase-gateway.ts preGateJobOf). Shape-checked, not cast: a value of the wrong type
 * THROWS, because a malformed field read as "unknown" would open a gate (CLAUDE.md §6).
 */
export function preGateJobFromRow(row: Record<string, unknown>): AuditorJobEmbed {
  // A text column: a string, or SQL null (undefined if the key was not selected at all, which is also "unknown").
  const text = (key: string): string | null => {
    // The raw value.
    const value = row[key];
    // Absent or null.
    if (value === null || value === undefined) return null;
    // The expected shape.
    if (typeof value === 'string') return value;
    // Anything else is a wiring fault, never a guess.
    throw new Error(`pre-gate job: ${key} is ${typeof value}, expected text`);
  };
  // The numeric column: the gate reads a number or a numeric string itself.
  const years = row['min_experience_years'];
  // Wrong type: refuse.
  if (years !== null && years !== undefined && typeof years !== 'number' && typeof years !== 'string') throw new Error(`pre-gate job: min_experience_years is ${typeof years}`);
  // The five fields.
  return { title: text('title'), description_raw: text('description_raw'), location_raw: text('location_raw'), min_experience_years: years ?? null, discovered_via: row['discovered_via'] ?? null };
}

/**
 * A ConfigReader over plain SELECT text (task 3), so the rehearse CLI runs loadPreGatePreferences UNCHANGED.
 *
 * Why an adapter: the CLI reads through `supabase db query --linked`, which connects as the database owner
 * and so BYPASSES RLS, where the gateway's supabase-js reads are RLS-scoped. Two accounts hold config rows,
 * so every statement here is scoped to the row's owner explicitly; an unscoped read answered for the wrong
 * account once already (CLAUDE.md §6). READ-ONLY BY CONSTRUCTION: the only SQL it can build is one SELECT.
 */
export function sqlConfigReader(run: (sql: string) => Record<string, unknown>[], userId: string): ConfigReader {
  // The owner id is interpolated, so it must be a uuid and nothing else.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(userId)) throw new Error('sqlConfigReader: owner id is not a uuid');
  // Identifiers and column lists come from the loader's constants; refused unless plainly that shape.
  const ident = (name: string): string => {
    // Lower-case words, commas and spaces only: no quotes, no semicolons, no expressions.
    if (!/^[a-z_][a-z_, ]*$/.test(name)) throw new Error(`sqlConfigReader: unsafe identifier "${name}"`);
    // Safe as written.
    return name;
  };
  // A filter value as a SQL literal: the loader filters only by text and booleans.
  const literal = (value: unknown): string => {
    // Booleans as keywords.
    if (typeof value === 'boolean') return String(value);
    // Text quoted, with embedded quotes doubled.
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
    // Anything else is outside what the loader sends.
    throw new Error(`sqlConfigReader: unsupported filter value ${typeof value}`);
  };
  // The port: one table, one select, equality filters, one terminal read.
  return {
    from(table) {
      // Checked once per table.
      const from = ident(table);
      // The select step.
      return {
        select(columns) {
          // The owner scope first, then each eq().
          const filters = [`user_id = '${userId}'`];
          // The chainable query.
          const query = {
            eq(column: string, value: unknown) {
              // One more filter.
              filters.push(`${ident(column)} = ${literal(value)}`);
              // Chains.
              return query;
            },
            async maybeSingle() {
              // supabase-js returns { error } rather than throwing; this adapter keeps that contract.
              try {
                // The one statement this adapter can produce.
                const rows = run(`select ${ident(columns)} from ${from} where ${filters.join(' and ')}`);
                // More than one row is an error in supabase-js's maybeSingle too.
                if (rows.length > 1) return { data: null, error: { message: `${rows.length} rows from ${from}, expected at most one` } };
                // One row, or none.
                return { data: rows[0] ?? null, error: null };
              } catch (error) {
                // A failed read is an error result, which the loader turns into its "unreadable" code.
                return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
              }
            },
          };
          // Handed to the loader.
          return query;
        },
      };
    },
  };
}
