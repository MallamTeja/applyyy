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
import type { AgentName, AnswerBankRow, BlockReason } from '@applyy/shared-types';
import { guardedAdvance, type StatusWriter } from './guarded-advance.ts';
import { planFill, type FillBlocker } from './plan-fill.ts';
import { resolveSubmissionMode, type SubmissionEnv } from './submission-mode.ts';
import type { FormField } from './extract-fields.ts';

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
}

/** The database operations this module needs, narrowed to four. */
export interface ApplierGateway extends StatusWriter {
  // Give the row back untouched, still `approved`. The dry-run path and only
  // the dry-run path uses this.
  releaseClaim(applicationId: string, reason: string): Promise<void>;
  // Returns the storage path, which the dashboard renders beside the row.
  uploadScreenshot(applicationId: string, bytes: Uint8Array): Promise<string>;
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
}

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
      readonly blockers: readonly FillBlocker[];
      readonly screenshotPath: string;
      readonly reason: string;
    }
  | { readonly kind: 'submitted' }
  | { readonly kind: 'blocked'; readonly reason: BlockReason; readonly blockers: readonly FillBlocker[] }
  // The submit threw. We do NOT know whether it landed, so no status is
  // written and the sweeper is left to route the row to a human.
  | { readonly kind: 'submit_outcome_unknown'; readonly error: string };

export async function applyToOne(input: ApplyToOneInput): Promise<ApplyOutcome> {
  const { row, page, gateway, answers, env } = input;

  // THE GATE, consulted before anything else so its verdict is available at
  // every branch below. A pre-deploy audit found this function had no callers
  // at all; this line is the wiring that finally gives it authority.
  const mode = resolveSubmissionMode(env);

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

  // Whether a real run would go through with this one.
  const wouldSubmit = detected === null && plan.canProceed;

  // Type the values ONLY when the application is actually viable. Filling a
  // form we are about to park would leave Teja a screenshot of a
  // half-completed application and no way to tell it from a real attempt.
  if (wouldSubmit) {
    for (const fill of plan.fills) {
      await page.fill(fill.id, fill.value);
    }
  }

  // After filling, so the image shows what would actually have been sent.
  const screenshotPath = await gateway.uploadScreenshot(row.id, await page.screenshot());

  // ---- The dry-run exit. No status write of any kind beyond this point -----

  if (!mode.submits) {
    // Hand the row back still `approved`, so the next run — or the first run
    // after the flag is flipped — picks up exactly the same queue.
    await gateway.releaseClaim(row.id, `dry_run: ${mode.reason}`);
    return {
      kind: 'dry_run_complete',
      wouldSubmit,
      blockers: plan.blockers,
      screenshotPath,
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
        unanswered: plan.blockers.map((blocker) => blocker.label),
      },
    });

    return { kind: 'blocked', reason, blockers: plan.blockers };
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
    detail: { screenshot_storage_path: screenshotPath },
  });

  return { kind: 'submitted' };
}
