// One application, start to finish. This is the only module in the repository
// that can cause anything to be sent to a real employer.
//
// THE ORDERING IS THE DESIGN. Everything that can be learned about a form is
// learned while the row is still `approved`: navigate, detect anti-bot walls,
// extract fields, plan the fill, type the values, screenshot. Only then does
// the row enter `applying`, and it leaves again immediately after. The window
// in which a crash produces an UNKNOWN real-world outcome therefore contains
// exactly one operation — the submit — and nothing else.
//
// That matters because `applying` is the single non-idempotent state in the
// system. A row stuck there is swept to `needs_verification`, which is
// human-only, and Teja must then open the employer's site and check by hand
// whether the application actually went out. Every operation moved out of that
// window is one fewer way to manufacture that question.
//
// DRY_RUN CANNOT TOUCH THE STATUS GRAPH AT ALL. `approved -> applying` is the
// only edge leaving `approved`, so a dry run that advanced anything would
// consume the queue to prove it could have applied. Instead it releases the
// claim and leaves the row exactly where the human approved it — which is also
// what makes §18.6's trust period work: after three days of screenshots, the
// same rows are still sitting there when the flag is flipped.
// MasterProfile is type-only: the planner needs the shape of identity facts, not a runtime dependency.
import type { AgentName, AnswerBankRow, BlockReason, MasterProfile, ResolvedResume } from '@applyy/shared-types';
import { guardedAdvance, type StatusWriter } from './guarded-advance.ts';
// isEeoQuestion: the planner's own EEO test, reused by the fill loop's optional-EEO degrade.
import { isEeoQuestion, planFill, type FillBlocker } from './plan-fill.ts';
import { resolveSubmissionMode, type SubmissionEnv } from './submission-mode.ts';
import type { FormField } from './extract-fields.ts';
// Which file input receives the resume, or why none can. Pure and browser-free,
// so the decision is unit-testable away from a live DOM.
import {
  planResumeAttachment,
  resumeFileName,
  type ResumeAttachmentBlocker,
} from './plan-resume-attachment.ts';
// Type-only: the render's result shape has ONE declaration, in the module that
// produces it, so the digest this file records cannot drift from the digest that
// was computed over the bytes.
import type { RenderedResume } from './render-resume-pdf.ts';

// This worker's identity in the status graph. Named once so no call site can
// quietly claim to be a different agent and slip through an edge it may not use.
const ACTING_AGENT: AgentName = 'applier';

/**
 * A choice control offered none of the wanted option, AND the filler selected nothing.
 *
 * Declared here, beside the ApplicationPage port it belongs to, so the live filler and the
 * test fakes throw one class. The message keeps the `no_matching_option:` prefix, so every
 * caller that matches on the message still treats it as a form gap.
 * The CLASS is the stronger claim: the control provably holds NO value. Two things, both
 * required: this fill selected nothing, AND the control was already empty (no pre-selected
 * default, no earlier react-select value, no checked radio), because a blank-skip submits
 * whatever the control holds. A plain Error with the same message means either may be false
 * (e.g. the readback found a different value shown), so the field may hold an answer nobody
 * chose. Only this class may degrade to "left blank"; the filler must check emptiness first.
 */
export class OptionNotFoundError extends Error {
  // A named error, so stack traces and logs say which kind of failure this was.
  override name = 'OptionNotFoundError';
}

/**
 * The browser operations this module needs.
 *
 * A port rather than a Playwright `Page`, for one reason that matters more than
 * testability: `submit` is the ONLY submission capability in the codebase, so
 * it appears exactly once, in one interface, and is greppable by anyone
 * auditing how an application can possibly be sent. A raw `Page` would offer a
 * hundred ways to click something.
 */
export interface ApplicationPage {
  goto(url: string): Promise<void>;
  extractFields(): Promise<FormField[]>;
  fill(id: string, value: string): Promise<void>;
  // Put the rendered resume into a file input. Separate from `fill` because the
  // two cannot be driven the same way — a file input's value is unwritable from
  // script by browser security design — and because keeping the ONE operation
  // that puts a document on an employer's form under its own name makes it
  // greppable, exactly as `submit` is.
  attachFile(id: string, file: AttachedFile): Promise<void>;
  // Taken AFTER filling, because §18.6's whole purpose is showing Teja exactly
  // what would have been sent — a screenshot of an empty form proves nothing.
  screenshot(): Promise<Uint8Array>;
  // Captcha, MFA, login wall, anti-bot interstitial. Constraint #5 forbids
  // circumventing any of them, so detection routes to a human and never to a
  // workaround. Returns null when the page is a plain form.
  detectBlocker(): Promise<BlockReason | null>;
  // THE IRREVERSIBLE OPERATION. Called from exactly one place, behind
  // resolveSubmissionMode, and never in dry-run.
  // Returns what the PAGE showed afterwards, never a bare "it resolved": a click
  // that returns proves only that a click happened. See SubmitResult for why
  // every case other than a positively-shaped confirmation means "not known".
  submit(): Promise<SubmitResult>;
  // Whether `submit` can send anything at all. Asked BEFORE `approved ->
  // applying`, because a submit that throws "not implemented" after that edge
  // is indistinguishable from one that died mid-request: the row is parked at
  // `applying` as an unknown outcome although it provably never went out.
  // Required, not optional, so a page that forgets it does not compile.
  readonly submissionImplemented: boolean;
}

/**
 * What the page showed after `submit`, as the ONLY input to the status write.
 *
 * A CLOSED UNION, so "submitted" cannot be represented by anything except a
 * confirmation the page positively showed. The failure the old `Promise<void>`
 * invited is §6's: a resolved promise read as "sent". Here the absence of proof
 * is its own case (`unconfirmed`) and it writes nothing, so a page that merely
 * stopped changing can never become an `applied` row.
 */
export type SubmitResult =
  // The page showed the board's confirmation. `evidence` says exactly what was
  // matched, so the `applied` event records why the system believed it.
  | { readonly kind: 'confirmed'; readonly evidence: string }
  // The form refused the submit in the browser (fields marked invalid, no
  // navigation). Nothing left the page, so this is safely a human's question.
  | { readonly kind: 'rejected_by_form'; readonly labels: readonly string[] }
  // A visible anti-bot challenge appeared. Constraint #5: never solved, so the
  // row goes to a human. Like the rejection, the form was not sent.
  | { readonly kind: 'challenge'; readonly reason: BlockReason }
  // The page was not in a state where a click could be safe (no single submit
  // control, or fields already invalid), so NOTHING was clicked at all.
  | { readonly kind: 'not_attempted'; readonly reason: BlockReason; readonly detail: string }
  // Anything else: a timeout, an unfamiliar page, a navigation that does not
  // look like a confirmation. The click happened and its result is unknown.
  | { readonly kind: 'unconfirmed'; readonly detail: string };

/** One document handed to a file input, as the employer's page will receive it. */
export interface AttachedFile {
  // What the recruiter sees in the ATS. Deterministic — see resumeFileName.
  readonly name: string;
  // Declared explicitly because upload widgets validate it, and a file input
  // fed bytes with no type is treated as application/octet-stream by some
  // boards and silently rejected.
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/**
 * Produce the resume PDF for one application.
 *
 * A PORT, NOT AN IMPORT, and that is what keeps the whole promise honest. The
 * only argument is the pinned `ResolvedResume` snapshot, so there is no
 * parameter through which a storage path, a job id or a template choice could
 * reach the render — the artifact is a function of exactly the data the human
 * approved. It is also why this module needs no Playwright type: the
 * implementation owns a browser page, and apply-one.ts never learns that.
 */
export type ResumeRenderer = (resume: ResolvedResume) => Promise<RenderedResume>;

/**
 * Where this application's artifacts ended up, as a record to be written.
 *
 * A SEPARATE TYPE FROM THE OUTCOME, even though the dry-run outcome carries the
 * same three values. The outcome is what the run summary REPORTS; this is what
 * the row RECORDS, and giving one type both jobs is how a field added for a log
 * line quietly becomes a database column nobody meant to write.
 *
 * Every field is nullable because every field genuinely can be absent: a form
 * that asks for no document produces no resume and no digest. Null means "this
 * run learned nothing about that artifact" and must therefore ERASE NOTHING —
 * see the gateway, where that rule is enforced once for all callers.
 */
export interface ArtifactPaths {
  // `applications.resume_storage_path`. Null when planResumeAttachment found no
  // target, which is a normal form shape and not a failure.
  readonly resumePath: string | null;
  // `applications.screenshot_storage_path`. Always present in practice, since
  // the screenshot is taken unconditionally, but typed nullable so the gateway's
  // one skip-nulls rule covers both fields rather than special-casing one.
  readonly screenshotPath: string | null;
  // `applications.resume_sha256` (migration 20260911114300). The digest of the
  // bytes that were attached: the path says where a file is, only this says
  // whether it is the file that was approved.
  readonly resumeSha256: string | null;
}

/** The database operations this module needs: advance, release, two uploads, one record. */
export interface ApplierGateway extends StatusWriter {
  // Give the row back untouched, still `approved`. The dry-run path and only
  // the dry-run path uses this.
  releaseClaim(applicationId: string, reason: string): Promise<void>;
  // Returns the storage path, which the dashboard renders beside the row.
  uploadScreenshot(applicationId: string, bytes: Uint8Array): Promise<string>;
  // Stores the exact bytes that were attached, and returns their path. Uploaded
  // AFTER the render and from the same buffer, so what is kept is the artifact
  // that went out rather than a second render that might not match it.
  uploadResume(applicationId: string, bytes: Uint8Array): Promise<string>;
  // Record where those uploads landed, WITHOUT moving the row. Its own operation
  // rather than an argument to advanceStatus, because the two answer different
  // questions and a dry run may only ever ask the first: "where is the file" is
  // a fact about storage, while "what state is this row in" is a fact about the
  // workflow, and tying the first to the second is precisely the defect this
  // method exists to fix.
  setArtifactPaths(applicationId: string, paths: ArtifactPaths): Promise<void>;
}

/** The claimed row, narrowed to what applying to it actually requires. */
export interface ClaimedApplication {
  readonly id: string;
  // Always `approved` in practice; carried explicitly because guardedAdvance
  // validates the edge from a stated origin rather than assuming one.
  readonly status: 'approved';
  // `jobs.apply_url` — the canonical submit target decided at normalize time.
  // Taking it from there is what makes "a LinkedIn sighting never becomes a
  // submit path" structurally true rather than a convention to be remembered.
  readonly applyUrl: string;
  // `applications.tailored_profile`: the frozen ResolvedResume as the human
  // approved it. THE SOURCE THE RESUME IS RENDERED FROM, and deliberately not
  // `resume_storage_path` — that column records what was sent, and a stored
  // artifact can drift from what was approved while a derivation cannot.
  //
  // Nullable because the column is, and a null is not assumed away here: the
  // attachment planner decides whether the absence actually stops this
  // application, which depends on whether the form asks for a document at all.
  readonly tailoredProfile: ResolvedResume | null;
  // `jobs.company_name`, for exactly one planner question: "have you previously worked
  // at <company>?". REQUIRED (nullable, not optional) so no construction site can forget
  // it; null means "unknown employer", on which the planner refuses that question.
  readonly employerName: string | null;
}

/** Everything one application needs, injected. */
export interface ApplyToOneInput {
  readonly row: ClaimedApplication;
  readonly page: ApplicationPage;
  readonly gateway: ApplierGateway;
  readonly answers: readonly AnswerBankRow[];
  // Master profile for factual fields (email, phone, links); optional so a caller without one only loses profile fills.
  // Null and absent both mean "no profile", so every existing caller compiles unchanged.
  readonly profile?: MasterProfile | null;
  // The environment slice the DRY_RUN gate reads. Passed rather than read from
  // process.env so the gate is testable without mutating global state.
  readonly env: SubmissionEnv;
  // REQUIRED, never optional, and that is the lesson this file already learned
  // the hard way: `resolveSubmissionMode` was a correct, ten-test, fail-closed
  // guard with NO CALLERS, and the suite stayed green throughout. An optional
  // renderer would let the same thing happen again — a resume pipeline that is
  // right in every detail and never runs. Required means the compiler refuses
  // any call site that forgets it.
  readonly renderResume: ResumeRenderer;
}

/**
 * Anything that stops an application, whatever layer noticed.
 *
 * A union rather than one widened type: an unanswerable question and an
 * unplaceable document need different fixes from Teja (answer it once, versus
 * teach the attachment planner a form shape), so their reason vocabularies stay
 * separate. What they share is the shape the dashboard reads — id and label —
 * which is all any consumer below actually touches.
 */
export type ApplicationBlocker = FillBlocker | ResumeAttachmentBlocker;

/** What happened. A discriminated union so no caller can ignore a case. */
export type ApplyOutcome =
  // Filled and screenshotted, nothing submitted, row untouched at `approved`.
  | {
      readonly kind: 'dry_run_complete';
      // Whether a real run would have submitted this one, or blocked instead.
      readonly wouldSubmit: boolean;
      // Surfaced so the run summary can name the questions that would have
      // blocked, letting the answer bank grow during the trust period without
      // moving any rows.
      readonly blockers: readonly ApplicationBlocker[];
      readonly screenshotPath: string;
      // The resume that WOULD have gone out, and its identity. Surfaced on the
      // outcome because a dry run writes nothing to the row — so without this,
      // the one artifact the §18.6 review exists to check would be produced,
      // attached, screenshotted and then unreferenced anywhere. Null when the
      // form asked for no document, which is a real and blameless case.
      readonly resumePath: string | null;
      readonly resumeSha256: string | null;
      readonly reason: string;
    }
  | { readonly kind: 'submitted' }
  | { readonly kind: 'blocked'; readonly reason: BlockReason; readonly blockers: readonly ApplicationBlocker[] }
  // The submit threw. We do NOT know whether it landed, so no status is
  // written and the sweeper is left to route the row to a human.
  | { readonly kind: 'submit_outcome_unknown'; readonly error: string };

export async function applyToOne(input: ApplyToOneInput): Promise<ApplyOutcome> {
  // Defaulted to null here so planFill below always receives a definite value.
  const { row, page, gateway, answers, env, renderResume, profile = null } = input;

  // THE GATE, consulted before anything else so its verdict is available at
  // every branch below. A pre-deploy audit found this function had no callers
  // at all; this line is the wiring that finally gives it authority.
  const requested = resolveSubmissionMode(env);
  // The effective verdict. Can only NARROW the gate's answer, never widen it:
  // `submits` is true only when the operator opted in AND the page can actually
  // send. A page without a working submit therefore takes the dry-run exit —
  // lease released, row untouched at `approved` — instead of walking into the
  // non-idempotent window and being stranded there as "outcome unknown".
  const mode =
    requested.submits && !page.submissionImplemented
      ? {
          submits: false,
          // Names both facts, so the release event says the opt-in was SEEN
          // and overridden rather than reading like an ordinary dry run.
          reason: `${requested.reason} Overridden: this page has no submit implementation, so nothing can be sent.`,
        }
      : requested;

  // ---- Everything below happens while the row is still `approved` ----------

  await page.goto(row.applyUrl);

  // Constraint #5. Checked before reading the form, because a captcha wall
  // means the fields we would extract are not the real application anyway.
  const detected = await page.detectBlocker();

  // Accessibility-tree-driven extraction; see extract-fields.ts for why.
  const fields = await page.extractFields();

  // Constraint #4 lives here: the planner can copy a human's answer or report a
  // blocker, and has no third branch that invents a value.
  // The profile rides into the planner, the one place that decides what may be typed.
  // The employer rides in as the 4th argument, the only way "previously worked at
  // <company>?" can be answered; without it that required question always refuses.
  const plan = planFill(fields, answers, profile, row.employerName);

  // WHERE THE RESUME GOES, decided before anything is typed and while the row is
  // still `approved`. Pure and browser-free: the form has already been read, so
  // this needs no second look at the page and cannot fail in a way that leaves
  // the DOM half-touched.
  const attachment = planResumeAttachment(fields, {
    // The snapshot's PRESENCE is the question, not its contents. Handing the
    // planner the resume itself would let a form-shape decision start depending
    // on resume data, which is how "which box" quietly becomes "what to send".
    hasResumeSnapshot: row.tailoredProfile !== null,
  });

  // Whether a real run would go through with this one. The attachment gate joins
  // the other two here rather than later, because an application that cannot
  // carry its resume must not be typed into, screenshotted as viable, or
  // submitted — and all three of those decisions read this one boolean.
  // `let` (not const) because a fill that the live page rejects can still turn a viable
  // application into a blocked one after this point; see the catch below.
  let wouldSubmit = detected === null && plan.canProceed && attachment.canProceed;

  // Every blocker from every layer, in one list. Merged at the point of decision
  // so no downstream consumer has to remember that there are two sources; a
  // second array would eventually be reported by one caller and not the other.
  // Mutable for the same reason as wouldSubmit: the fill loop may append a late blocker.
  const blockers: ApplicationBlocker[] = [...plan.blockers, ...attachment.blockers];

  // The rendered artifact, kept out here so both the dry-run exit and the real
  // status write can name it. Null until a viable application actually needs one.
  let resume: RenderedResume | null = null;
  let resumePath: string | null = null;

  // Type the values ONLY when the application is actually viable. Filling a
  // form we are about to park would leave Teja a screenshot of a
  // half-completed application and no way to tell it from a real attempt.
  if (wouldSubmit) {
    for (const fill of plan.fills) {
      // Guarded per fill so one rejected value is caught at the field that caused it.
      try {
        // The live filler validates against real options, which the pure planner cannot see.
        await page.fill(fill.id, fill.value);
      // Only reached when the page refused a value; the checks below decide whether that is a form gap.
      } catch (error) {
        // Only the filler's two KNOWN "the form cannot take this value" errors are form gaps.
        // Anything else is an unknown failure and must surface unchanged, never be relabelled.
        // Non-Error throws get an empty message so they fail the prefix test and are rethrown.
        const message = error instanceof Error ? error.message : '';
        // Rethrow keeps unknown failures loud instead of disguising them as questions for the human.
        if (!message.startsWith('no_matching_option:') && !message.startsWith('checkbox_not_autofilled:')) throw error;
        // The extracted field this fill was planned for; undefined if it vanished from the list.
        const field = fields.find((candidate) => candidate.id === fill.id);
        // OPTIONAL EEO, PROVABLY UNTOUCHED: leave it blank and keep going (2026-10-09). An EEO
        // question is voluntary, so a blank one costs nothing, whereas parking would hold the
        // whole application over a question the employer does not require. All three tests must
        // hold. The class proves nothing was selected (a plain Error may mean a wrong option is
        // showing). `required === false`, strictly, so a vanished field is treated as required.
        // The EEO test is the planner's own, so only attested EEO answers ever reach here.
        if (
          error instanceof OptionNotFoundError &&
          field?.required === false &&
          isEeoQuestion(field.label)
        ) {
          // Logged, so the run's record shows which voluntary question went unanswered and why.
          console.warn(`[applyy] ${row.id}: optional EEO field "${field.label}" left blank; ${message}`);
          // Next fill: no blocker, no park, and nothing guessed in this field's place.
          continue;
        }
        // Without this the error reached the claim loop, which counted it and left the row
        // `approved`, so it failed identically every run and never reached the human.
        // The label (not the opaque DOM id) is what the human needs to see.
        // Falls back to the id so the blocker is never blank even if the field vanished from the list.
        const label = field?.label ?? fill.id;
        // Pushed into the shared list so the park path and the dry-run report both see it.
        blockers.push({ id: fill.id, label, reason: 'no_matching_option' });
        // Not viable any more: this gates the resume attach, the dry-run report and the park path.
        // Flipped last so the blocker is recorded before the viability gate changes.
        wouldSubmit = false;
        // Stop typing; a half-filled form is not worth completing.
        // Leaving the loop is the stop: later fills would type into a form we are about to park.
        break;
      }
    }

    // ---- THE RESUME, RENDERED HERE AND FOR THREE DELIBERATE REASONS --------
    //
    // 1. BEFORE the `approved -> applying` transition. Rendering is fallible —
    //    a stale `schema_version` throws ResumeRenderError by design — and every
    //    fallible operation moved inside that window is a new way to strand a
    //    row at `applying`, which is human-only recovery: Teja must open the
    //    employer's site and check by hand whether an application went out. A
    //    render that throws HERE costs nothing: no status has been written, the
    //    lease simply expires and the row is still exactly where it was.
    // 2. AFTER the viability decision, so a form we are about to park never
    //    pays for a PDF it cannot use.
    // 3. BEFORE the screenshot below, so §18.6's evidence SHOWS the attachment.
    //    A screenshot taken before attaching would picture an application whose
    //    resume box is empty — the one thing the trust period exists to verify,
    //    absent from the artifact that is supposed to verify it.
    // Skipped when a fill just failed: an application about to be parked must not pay for a PDF.
    // wouldSubmit is checked first because it is cheap and may have just been cleared.
    if (wouldSubmit && attachment.target !== null) {
      // Restates at the type level what the planner already guarantees: a target
      // is only ever returned when a snapshot exists. Thrown rather than skipped
      // because the safe failure is "no application", and skipping would send a
      // resume-less application to an employer who explicitly asked for one.
      if (row.tailoredProfile === null) {
        throw new Error(
          `unreachable: attachment target ${attachment.target.id} on ${row.id} without a ` +
            'tailored_profile. planResumeAttachment must not return a target without one.',
        );
      }

      // From the PINNED SNAPSHOT, never from a stored file. This is the whole
      // guarantee: the worker and the React approval preview call the same
      // renderResumeHtml, so the bytes below are provably downstream of exactly
      // the data the human reviewed.
      resume = await renderResume(row.tailoredProfile);

      // Stored before it is attached, so the record exists even if the page
      // rejects the upload — an artifact that cannot be produced again from a
      // row whose snapshot later changes is worth keeping either way.
      resumePath = await gateway.uploadResume(row.id, resume.bytes);

      // THE SAME BUFFER that was hashed and uploaded. Not a re-render: a second
      // render would be a second artifact, and "byte-for-byte what was approved"
      // would then be a claim about a file nobody kept.
      await page.attachFile(attachment.target.id, {
        name: resumeFileName(row.tailoredProfile),
        // Fixed, because renderResumePdf only ever produces a PDF.
        mimeType: 'application/pdf',
        bytes: resume.bytes,
      });
    }
  }

  // After filling AND attaching, so the image shows what would actually have
  // been sent — including the attached filename the ATS echoes back.
  const screenshotPath = await gateway.uploadScreenshot(row.id, await page.screenshot());

  // THE EVIDENCE WRITE, for EVERY branch below: dry run, park and real submit.
  //
  // Uploading an artifact returns a path and does nothing else. This call is
  // what makes the row point at it. It used to live inside the dry-run exit
  // only, so a REAL submission left `resume_storage_path` and
  // `screenshot_storage_path` NULL: `advance_application_status` writes
  // `p_detail` into an event, not into those columns. Hoisted here, before the
  // branch, so the one run that actually sends something records what it sent.
  //
  // A BARE UPDATE BEHIND THIS CALL, deliberately NOT guardedAdvance. Coupling
  // "record where the file went" to "move the row" was the original defect; a
  // dry run may not move anything. The database agrees:
  // `guard_status_transition()` returns early on
  // `new.status is not distinct from old.status`, and its own comment names
  // "an agent writing a score or a storage path" as the case it is exempting.
  //
  // WHILE THE ROW IS STILL `approved` AND LEASED, and both halves matter. Before
  // releaseClaim, because the lease is what makes the row ours to write: a
  // release first would let the next run write its paths underneath ours. And
  // before `approved -> applying`, because a network write inside the
  // non-idempotent window is one more way to strand a row there.
  await gateway.setArtifactPaths(row.id, {
    resumePath,
    screenshotPath,
    // Persisted to `applications.resume_sha256` (added in
    // 20260911114300_add_resume_sha256_to_applications.sql; the gateway's
    // setArtifactPaths writes it). The digest is what proves WHICH bytes the
    // stored path holds, so a review can check it against approval.
    resumeSha256: resume?.sha256 ?? null,
  });

  // ---- The dry-run exit. No status write of any kind beyond this point -----

  if (!mode.submits) {
    // Hand the row back still `approved`, so the next run — or the first run
    // after the flag is flipped — picks up exactly the same queue.
    await gateway.releaseClaim(row.id, `dry_run: ${mode.reason}`);
    return {
      kind: 'dry_run_complete',
      wouldSubmit,
      // Both layers' blockers, so the trust-period log names every reason this
      // application would not have gone out — not just the answer-bank ones.
      blockers,
      screenshotPath,
      resumePath,
      // Null when nothing was rendered. Reported rather than recomputed so the
      // digest describes the bytes that were actually attached.
      resumeSha256: resume?.sha256 ?? null,
      reason: mode.reason,
    };
  }

  // ---- Past here the run is authorised to submit ---------------------------

  // A blocker found BEFORE any click goes straight to the human queue, in ONE
  // write: `approved -> blocked_needs_human` (status-flow.ts; migration
  // 20260910190000). It used to travel through `applying`, and a crash between
  // those two writes stranded a never-sent row there, where the sweeper routes it
  // to needs_verification and a human hand-checks an application that never left.
  if (!wouldSubmit) {
    // §8.6: a reason code, not a new status. A captcha and an unanswerable
    // question need the identical operator action, so they share a handler and
    // differ only in the explanation.
    const reason: BlockReason = detected ?? 'unanswerable_question';

    await guardedAdvance(gateway, {
      applicationId: row.id,
      from: 'approved',
      to: 'blocked_needs_human',
      agent: ACTING_AGENT,
      detail: {
        block_reason: reason,
        screenshot_storage_path: screenshotPath,
        // Names the exact questions a human must answer, so the dashboard can
        // show the work rather than just the fact of being stuck.
        unanswered: blockers.map((blocker) => blocker.label),
      },
    });

    return { kind: 'blocked', reason, blockers };
  }

  // ---- THE NON-IDEMPOTENT WINDOW. Opens here; closes at the first status ---
  // ---- write below. Nothing between the two may touch the network except --
  // ---- the click itself, and the bounded confirmation capture. ------------

  await guardedAdvance(gateway, {
    applicationId: row.id,
    from: 'approved',
    to: 'applying',
    agent: ACTING_AGENT,
  });

  // What the page showed after the click. Declared outside the try so the
  // branches below read one definite value.
  let result: SubmitResult;
  try {
    result = await page.submit();
  } catch (error) {
    // DELIBERATELY NO STATUS WRITE. A submit that threw has an unknown outcome:
    // the request may have reached the employer and only the response been
    // lost. Writing `failed` would assert it did not send; writing `applied`
    // would assert it did; retrying would risk sending twice and violating
    // constraint #7. Leaving the row in `applying` with an expiring lease lets
    // the sweeper route it to `needs_verification`, which is human-only — so a
    // person decides, which is the only correct authority for this question.
    return {
      kind: 'submit_outcome_unknown',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // NO PROOF, NO WRITE. Exactly the same answer as a throw, for exactly the same
  // reason: the click happened and nothing positive came back. This is the
  // branch every unfamiliar page lands in, which is the direction to fail.
  if (result.kind === 'unconfirmed') {
    // The detail is the page's own description of what it saw, kept for the log.
    return { kind: 'submit_outcome_unknown', error: `unconfirmed: ${result.detail}` };
  }

  // NOTHING LEFT THE PAGE: the form refused in the browser, a challenge appeared,
  // or no click was made at all. Each is a human's job, and each is safe to say
  // so about, because the application provably was not sent. Same park as a
  // pre-fill blocker, through the one edge into the human queue.
  if (result.kind !== 'confirmed') {
    // Each kind maps to its own row-level reason; a form rejection is a question
    // the form wanted answered differently, so it shares the answer reason.
    const reason: BlockReason = result.kind === 'rejected_by_form' ? 'unanswerable_question' : result.reason;
    // The labels the form flagged, or the page's explanation when no field did.
    const unanswered = result.kind === 'rejected_by_form' ? [...result.labels] : [result.kind === 'not_attempted' ? result.detail : result.kind];
    await guardedAdvance(gateway, {
      applicationId: row.id,
      from: 'applying',
      to: 'blocked_needs_human',
      agent: ACTING_AGENT,
      detail: {
        block_reason: reason,
        screenshot_storage_path: screenshotPath,
        // Names what stopped it, so the dashboard shows the work, not just the fact.
        unanswered,
        // Which post-click case it was, so a reviewer can tell "the form said no"
        // from "Google asked a question" without opening the screenshot.
        submit_result: result.kind,
      },
    });
    // The page-level blockers are not field-level FillBlockers, so none are listed.
    return { kind: 'blocked', reason, blockers: [] };
  }

  // A CONFIRMED SUBMIT. The confirmation page itself is the last piece of proof,
  // so it is captured — but BEST-EFFORT and BOUNDED: the application has gone,
  // and no failure to photograph that fact may stop the row saying so. A hang or
  // throw here would otherwise leave a sent application sitting at `applying`.
  // LOGGED BEFORE ANY WRITE. If the `applied` write below fails (network, token,
  // agent key), the row is swept to needs_verification and this line in the run
  // log is the only record that the worker SAW a confirmation, which turns
  // Teja's hand-check from "did it go out?" into "the log says it did".
  console.log(`[applyy] ${row.id}: submission CONFIRMED — ${result.evidence}`);

  const confirmationScreenshotPath = await captureBounded(async () =>
    // Uploaded under a fresh timestamped path, so it never replaces the filled form.
    gateway.uploadScreenshot(row.id, await page.screenshot()),
  );

  await guardedAdvance(gateway, {
    applicationId: row.id,
    from: 'applying',
    to: 'applied',
    agent: ACTING_AGENT,
    // This detail becomes an `application_events` note, NOT the columns of the
    // same names (`advance_application_status` inserts `p_detail` verbatim). The
    // columns were already written by setArtifactPaths above, while the row was
    // still `approved`; these keys repeat them in the event so the record that
    // says "sent" also says what was sent.
    detail: {
      screenshot_storage_path: screenshotPath,
      // WHAT WAS SENT, recorded in the same write that asserts it was sent, so
      // the two can never disagree. The path alone answers "where is the file";
      // the digest answers "is this the artifact that was approved?", which is
      // the question actually asked six months later when a recruiter mentions
      // something on the resume.
      resume_storage_path: resumePath,
      resume_sha256: resume?.sha256 ?? null,
      // WHY the system believes it was sent: the exact page features matched.
      confirmation_evidence: result.evidence,
      // The confirmation page as it looked, or null if capturing it failed.
      confirmation_screenshot_path: confirmationScreenshotPath,
    },
  });

  return { kind: 'submitted' };
}

// How long the post-confirmation capture may take before it is abandoned. Long
// enough for a full-page screenshot and one storage upload on a slow runner.
const CONFIRMATION_CAPTURE_TIMEOUT_MS = 15_000;

/**
 * Run an evidence capture that must never decide an outcome.
 *
 * Resolves to its value, or to null on a throw or after the timeout. Used only
 * AFTER a confirmed submit, where the one thing that matters is writing
 * `applied`; a capture that could throw or hang would turn a sent application
 * into a stranded one.
 */
async function captureBounded(capture: () => Promise<string>): Promise<string | null> {
  // The timer handle, so it can be cleared and not keep the process alive.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Whichever settles first: the capture, or the timeout's null.
    return await Promise.race([
      // A rejection is caught below and becomes null.
      capture(),
      // Resolves (never rejects) to null, so a timeout reads as "no evidence".
      new Promise<null>((resolve) => {
        // Started inside the executor so the handle is set before the race runs.
        timer = setTimeout(() => resolve(null), CONFIRMATION_CAPTURE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Missing evidence is reported as null, never as a failure of the submit.
    return null;
  } finally {
    // Always cleared, or a finished run would wait out the timer before exiting.
    clearTimeout(timer);
  }
}
