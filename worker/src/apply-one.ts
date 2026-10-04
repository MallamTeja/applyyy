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
import type { AgentName, AnswerBankRow, BlockReason, ResolvedResume } from '@applyy/shared-types';
import { guardedAdvance, type StatusWriter } from './guarded-advance.ts';
import { planFill, type FillBlocker } from './plan-fill.ts';
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
  submit(): Promise<void>;
  // Whether `submit` can send anything at all. Asked BEFORE `approved ->
  // applying`, because a submit that throws "not implemented" after that edge
  // is indistinguishable from one that died mid-request: the row is parked at
  // `applying` as an unknown outcome although it provably never went out.
  // Required, not optional, so a page that forgets it does not compile.
  readonly submissionImplemented: boolean;
}

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
}

/** Everything one application needs, injected. */
export interface ApplyToOneInput {
  readonly row: ClaimedApplication;
  readonly page: ApplicationPage;
  readonly gateway: ApplierGateway;
  readonly answers: readonly AnswerBankRow[];
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
  const { row, page, gateway, answers, env, renderResume } = input;

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
  const plan = planFill(fields, answers);

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
  const wouldSubmit = detected === null && plan.canProceed && attachment.canProceed;

  // Every blocker from every layer, in one list. Merged at the point of decision
  // so no downstream consumer has to remember that there are two sources; a
  // second array would eventually be reported by one caller and not the other.
  const blockers: readonly ApplicationBlocker[] = [...plan.blockers, ...attachment.blockers];

  // The rendered artifact, kept out here so both the dry-run exit and the real
  // status write can name it. Null until a viable application actually needs one.
  let resume: RenderedResume | null = null;
  let resumePath: string | null = null;

  // Type the values ONLY when the application is actually viable. Filling a
  // form we are about to park would leave Teja a screenshot of a
  // half-completed application and no way to tell it from a real attempt.
  if (wouldSubmit) {
    for (const fill of plan.fills) {
      await page.fill(fill.id, fill.value);
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
    if (attachment.target !== null) {
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

  // ---- The dry-run exit. No status write of any kind beyond this point -----

  if (!mode.submits) {
    // THE EVIDENCE WRITE, and the single most important line on this path.
    //
    // Uploading an artifact returns a path and does nothing else. Until this
    // call existed, the ONLY place either path reached the row was the
    // `applying -> applied` detail eighty lines below — inside a status
    // transition a dry run returns before ever reaching. DRY_RUN is absolute
    // (constraint #16), so execution ALWAYS stops here, which made
    // `resume_storage_path` and `screenshot_storage_path` permanently empty in
    // the only mode this system can run in: real bytes sitting in storage,
    // unreferenced by the row they belong to, and a §18.6 review with no way to
    // get from an application to the screenshot that is supposed to justify it.
    //
    // A BARE UPDATE BEHIND THIS CALL, deliberately NOT guardedAdvance. Coupling
    // "record where the file went" to "move the row" IS the defect; a dry run
    // may not move anything, and an evidence write that requires a transition
    // can therefore never happen during the trust period. The database agrees:
    // `guard_status_transition()` returns early on
    // `new.status is not distinct from old.status`, and its own comment names
    // "an agent writing a score or a storage path" as the case it is exempting.
    //
    // BEFORE releaseClaim, not after, and that ordering is load-bearing: the
    // lease is what makes this row ours to write. Releasing first would open a
    // window in which the next run claims the row and writes its own paths
    // underneath ours — a lost update whose only symptom is evidence pointing
    // at the wrong file.
    await gateway.setArtifactPaths(row.id, {
      resumePath,
      screenshotPath,
      // Persisted to `applications.resume_sha256` (added in
      // 20260911114300_add_resume_sha256_to_applications.sql; the gateway's
      // setArtifactPaths writes it). The digest is what proves WHICH bytes the
      // stored path holds, so the dry-run review can check it against approval.
      resumeSha256: resume?.sha256 ?? null,
    });

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

  // A blocked application still enters `applying` first, because
  // `applying -> blocked_needs_human` is the only edge that reaches the human
  // queue. The two writes are adjacent with nothing between them, so the
  // dangerous window stays as small as the graph permits.
  if (!wouldSubmit) {
    // §8.6: a reason code, not a new status. A captcha and an unanswerable
    // question need the identical operator action, so they share a handler and
    // differ only in the explanation.
    const reason: BlockReason = detected ?? 'unanswerable_question';

    await guardedAdvance(gateway, {
      applicationId: row.id,
      from: 'approved',
      to: 'applying',
      agent: ACTING_AGENT,
    });
    await guardedAdvance(gateway, {
      applicationId: row.id,
      from: 'applying',
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

  // ---- THE NON-IDEMPOTENT WINDOW. Opens here, closes four lines down -------

  await guardedAdvance(gateway, {
    applicationId: row.id,
    from: 'approved',
    to: 'applying',
    agent: ACTING_AGENT,
  });

  try {
    await page.submit();
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

  await guardedAdvance(gateway, {
    applicationId: row.id,
    from: 'applying',
    to: 'applied',
    agent: ACTING_AGENT,
    // !! THIS DETAIL DOES NOT POPULATE THE COLUMNS OF THE SAME NAME. !!
    //
    // Verified in supabase/migrations/20260909235100_queue_and_pool_functions
    // .sql: `advance_application_status` updates only `status` and the three
    // lease fields, then inserts `p_detail` VERBATIM as a `note` row in
    // `application_events`. So these keys land in an event's jsonb blob and
    // `applications.resume_storage_path` / `.screenshot_storage_path` stay NULL
    // even on a successful real submission — not only in dry run. The names
    // matching the columns is what makes that easy to miss.
    //
    // NOT FIXED HERE, deliberately: this path is unreachable while DRY_RUN is
    // absolute (constraint #16), so changing it would be an untested edit to
    // the one code path that can reach a real employer. The dry-run path calls
    // `gateway.setArtifactPaths` for exactly this reason; extending that call
    // to cover this branch is a decision for whoever lifts the flag, and it is
    // recorded here so they are not the first to discover it.
    detail: {
      screenshot_storage_path: screenshotPath,
      // WHAT WAS SENT, recorded in the same write that asserts it was sent, so
      // the two can never disagree. The path alone answers "where is the file";
      // the digest answers "is this the artifact that was approved?", which is
      // the question actually asked six months later when a recruiter mentions
      // something on the resume.
      resume_storage_path: resumePath,
      resume_sha256: resume?.sha256 ?? null,
    },
  });

  return { kind: 'submitted' };
}
