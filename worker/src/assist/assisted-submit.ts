// The PURE core of the assisted-submit flow: decisions and ordering, no I/O of its own.
//
// WHY A SEPARATE MODULE FROM THE CLI: the CLI owns env vars, Chromium and stdin, none
// of which a unit test can have. Everything that decides what gets WRITTEN lives here
// behind injected ports, so a test drives the whole flow with fakes and asserts the
// exact sequence of status writes. (Pattern: functional core, imperative shell.)
//
// THE SAFETY MODEL, in one paragraph: this flow never submits. The page port below has
// NO `submit` member, so calling it is a compile error rather than a rule to remember.
// The human clicks Submit in a visible window, and only the human's typed answer can
// move the row to `applied` (as agent `human`). `applying -> applied` as `applier` means
// "the worker confirmed a submission", which this flow can never claim, so it is never
// written.
// Type-only: the assisted flow only needs the profile's shape to pass it along.
import type { AgentName, AnswerBankRow, MasterProfile, ResolvedResume } from '@applyy/shared-types';
import type { ApplicationPage } from '../apply-one.ts';
import { guardedAdvance, type StatusWriter } from '../guarded-advance.ts';
import { planFill } from '../plan-fill.ts';
import { planResumeAttachment, resumeFileName } from '../plan-resume-attachment.ts';
import type { RenderedResume } from '../render-resume-pdf.ts';

// The worker's identity for the automated half of the flow. Named once so no call site
// can drift to a different actor and slip through an edge it may not use.
// Typed as AgentName so a misspelt actor is a compile error, not a runtime refusal.
const WORKER_AGENT: AgentName = 'applier';
// The human's identity for the final write. Only a typed answer reaches it.
// Same typing reason as above; the graph itself enforces which edges `human` may use.
const HUMAN_AGENT: AgentName = 'human';

// Free text the dashboard shows. The DB column `block_reason` is an ENUM that has no
// "assisted" member, so this sentence travels in `block_detail` and the event note while
// the enum column gets `other` — all three set by advance_application_status from the
// park call's detail (migration 20261004220000).
// Exported so tests assert the exact sentence rather than a copy that could drift.
export const ASSISTED_BLOCK_NOTE = 'assisted: awaiting human submit';

/**
 * The only page operations this flow may use.
 *
 * `Pick` from the real port, minus `submit`, `screenshot` and `submissionImplemented`:
 * omitting `submit` from the type is what makes "never submit" a compile-time fact.
 */
// A type alias, not an interface: it is purely a narrowing of the existing port.
export type AssistPage = Pick<
  ApplicationPage,
  'goto' | 'extractFields' | 'fill' | 'attachFile' | 'detectBlocker'
>;

/** The row as the assist flow needs it. Fields are what the READ returned, unvalidated. */
// An interface so the gateway and the tests can both construct it by name.
export interface AssistRow {
  // The primary key, echoed back so every later write targets the row that was loaded.
  readonly id: string;
  // A plain string, not the union: the value comes from a database read, and the
  // refusal check below must be able to see a status it did not expect.
  readonly status: string;
  // Nullable because it is joined from `jobs`, which can be missing or empty.
  readonly applyUrl: string | null;
  // Whether the posting has dropped off its board (jobs.disappeared_at non-null). A
  // tri-state, not a boolean, so "the column was not in the read" ('unknown') cannot be
  // mistaken for "alive": only an explicit false lets the flow open a browser.
  // Required (no `?`) so a hand-built row that forgets it fails to compile instead of passing as alive.
  readonly postingDisappeared: boolean | 'unknown';
  // The frozen snapshot the human approved; the resume PDF is rendered from it only.
  readonly tailoredProfile: ResolvedResume | null;
  // For the printed summary only; never used in a decision.
  readonly company: string;
  // Shown beside the company so the human can tell at a glance which role this is.
  readonly title: string;
}

/** Database operations beyond plain status writes. */
// Extends StatusWriter so guardedAdvance accepts this object directly.
export interface AssistGateway extends StatusWriter {
  // Null when no such row is visible to this user (RLS hides other tenants' rows).
  // Read first so every refusal can happen before any write.
  loadApplication(id: string): Promise<AssistRow | null>;
  // True only when exactly one approved, unclaimed row was leased to us.
  // Boolean, not a row: the flow only needs to know whether it won the lease.
  claim(id: string): Promise<boolean>;
  // Drops the lease without moving the row.
  // The reason lands in the event log, answering 'why did this sit leased?' later.
  releaseClaim(id: string, reason: string): Promise<void>;
  // No separate block_reason setter: since migration 20261004220000 the status RPC
  // writes block_reason + block_detail from the park call's detail in the SAME update,
  // which is what the `applications_blocked_has_reason` CHECK needs. A second,
  // earlier write would only reopen the window where the two could disagree.
  // The answer bank, so planFill can copy human-written answers.
  // Read-only: this flow never writes to the answer bank.
  fetchAnswers(): Promise<readonly AnswerBankRow[]>;
  // Optional: absent means no profile fills (the safe direction); the real gateway delegates it.
  // Declared on the assisted gateway port so the planner call below type-checks.
  fetchLatestProfile?(): Promise<MasterProfile | null>;
}

/** Everything the flow needs, injected. */
// One bag of ports so a test builds the whole world in a single object literal.
export interface AssistDeps {
  // The one row this run may touch; there is no 'pick any' mode.
  readonly applicationId: string;
  // All database access goes through this port, so tests substitute a fake.
  readonly gateway: AssistGateway;
  // The browser, narrowed to operations that cannot submit.
  readonly page: AssistPage;
  // Injected because rendering needs a real Chromium page, which tests do not have.
  readonly renderResume: (resume: ResolvedResume) => Promise<RenderedResume>;
  // Resolves to the raw line the human typed, or null on EOF / Ctrl-C. Raw on purpose:
  // interpreting it is `interpretAnswer`'s job, in one tested place.
  // Takes the question text so the CLI prints it exactly where the human is looking.
  readonly askHuman: (question: string) => Promise<string | null>;
  // Output sink, injected so tests can read what the human would have seen.
  // A function, not console, so output is capturable and assertable in tests.
  readonly log: (line: string) => void;
}

/** What the human's answer means for the status graph. `null` means "unsure: write nothing". */
// A discriminated shape with a null arm, so 'unsure' cannot be mistaken for a decision.
export type AnswerTransition = { readonly to: 'applied' | 'failed' } | null;

/**
 * Map the typed answer to a transition, matching EXACTLY.
 *
 * An allow-list of two strings, not "starts with y": a lenient match turns "yes, but it
 * errored" or a stray keystroke into a recorded application, and a false `applied` is
 * the one error here that cannot be noticed later. Anything else is "unsure".
 */
// Exported on its own so the y/n mapping is unit-tested without running the flow.
export function interpretAnswer(raw: string | null): AnswerTransition {
  // EOF and Ctrl-C arrive as null; there is no answer to interpret.
  if (raw === null) return null;
  // Normalised so "Y " and "y" are the same answer, but nothing looser than that.
  const answer = raw.trim().toLowerCase();
  // Positive confirmation: the human saw a confirmation page.
  if (answer === 'y') return { to: 'applied' };
  // Negative: the human did not complete it.
  if (answer === 'n') return { to: 'failed' };
  // Everything else, including "yes", "" and garbage, means unsure.
  return null;
}

/** How the run ended; the CLI maps this to an exit code and a closing message. */
// A closed union so a caller must handle every ending rather than ignore one.
export type AssistOutcome =
  // Refused before any claim or write.
  | { readonly kind: 'refused'; readonly reason: string }
  // The page never loaded; the row is untouched at `approved`.
  | { readonly kind: 'navigation_failed'; readonly error: string }
  // The park write failed; the row may be stuck at `applying` for the sweeper.
  | { readonly kind: 'park_failed'; readonly error: string }
  // The human answered y or n and the matching write was attempted.
  | { readonly kind: 'recorded'; readonly to: 'applied' | 'failed' }
  // No usable answer; the row stays at blocked_needs_human with nothing more written.
  | { readonly kind: 'left_blocked' }
  // The answer was usable but the write threw; the row stays at blocked_needs_human.
  | { readonly kind: 'record_failed'; readonly error: string };

/** Stringify anything thrown, since `catch` values are `unknown`. */
// Module-private: nothing outside needs error formatting policy.
function messageOf(error: unknown): string {
  // Error instances carry a message; anything else is stringified rather than lost.
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one assisted application from claim to recorded outcome.
 *
 * THE ORDERING IS THE DESIGN, and each step's reason is beside it. The status writes
 * form a fixed sequence: approved -> applying -> blocked_needs_human -> (human) applied
 * or failed. Nothing else is ever written.
 */
// Async because every port is; the human's typing is just one more awaited call.
export async function runAssisted(deps: AssistDeps): Promise<AssistOutcome> {
  // Destructured once so every step below reads from the same injected ports.
  const { applicationId, gateway, page, renderResume, askHuman, log } = deps;

  // ---- Step 1: select and validate. Nothing is written until this passes. ----
  const row = await gateway.loadApplication(applicationId);
  // RLS makes "not yours" and "does not exist" the same answer; both are refusals.
  if (row === null) {
    // Refusal is a value, not a throw, so the CLI can print it plainly.
    return { kind: 'refused', reason: `no application ${applicationId} is visible to this user` };
  }
  // Exactly 'approved': the human's approval is the gate (constraint 15), and any other
  // status means this row is not ours to drive (already applying, applied, blocked...).
  if (row.status !== 'approved') {
    // Names the actual status so the human sees why immediately.
    return { kind: 'refused', reason: `status is "${row.status}", not "approved"` };
  }
  // The resume is rendered from the approved snapshot; without one there is nothing the
  // human approved to send, so refuse rather than fill a form with no document.
  if (row.tailoredProfile === null) {
    // Same shape as the other refusals.
    return { kind: 'refused', reason: 'tailored_profile is null: nothing approved to send' };
  }
  // A job without a URL has no form to open. Checked for emptiness, not just null.
  if (row.applyUrl === null || row.applyUrl.trim() === '') {
    // Nothing to open, so nothing to claim.
    return { kind: 'refused', reason: 'the job has no apply_url' };
  }
  // FAIL CLOSED: anything but an explicit `false` refuses, so a dead posting, or a read
  // that could not say, never reaches a browser. Before the claim, so the row is not
  // leased and its status is untouched.
  // Strict `!== false` is the fail-closed test: true and 'unknown' both land inside this branch.
  if (row.postingDisappeared !== false) {
    // Names the token the scheduled gateway also uses, so one grep finds both refusals.
    // Returned as a value, not thrown, so the CLI prints it like every other refusal and exits cleanly.
    return { kind: 'refused', reason: `posting_disappeared: job posting state is ${String(row.postingDisappeared)}` };
  }
  // Narrowed copies, so the compiler knows these are non-null below.
  // Trimmed so stray whitespace from the database cannot break navigation.
  const applyUrl = row.applyUrl.trim();
  // The snapshot, now typed non-null for the renderer.
  const resume = row.tailoredProfile;

  // Lease the row so the scheduled applier cannot pick it up while a human works on it.
  if (!(await gateway.claim(applicationId))) {
    // Losing the claim race is a refusal, not an error.
    return { kind: 'refused', reason: 'could not claim: already claimed, or not approved any more' };
  }

  // Tracks whether the row has left `approved`: once it has, the lease is gone (the RPC
  // clears it on every transition) and there is nothing left to release.
  let advanced = false;
  // try/finally so the lease is released on EVERY exit path, including thrown errors.
  try {
    // ---- Step 2: load the page FIRST. -------------------------------------------
    // The status write comes after navigation so a dead URL costs nothing: the row is
    // still approved and the lease is released in `finally`.
    try {
      // domcontentloaded is enough; the human is watching the real page load.
      await page.goto(applyUrl);
    } catch (error) {
      // Reported, not retried: the row is still approved and nothing was written.
      return { kind: 'navigation_failed', error: messageOf(error) };
    }

    // The ONLY entry to `applying`. From here until the park write, a crash would leave
    // the row at `applying`, which the sweeper routes to needs_verification; so the
    // window holds only the fill and nothing else.
    await guardedAdvance(gateway, {
      applicationId,
      from: 'approved',
      to: 'applying',
      agent: WORKER_AGENT,
    });
    // Set only after the write succeeded, so a failed write still releases the lease.
    advanced = true;

    // ---- Step 3: fill. Failures are COLLECTED, never allowed to skip the park. ---
    // Names of fields that were typed or attached, for the printed summary.
    // Mutable accumulator, because the fill loop appends as it goes.
    const filled: string[] = [];
    // Names of fields the human must still do by hand.
    const unfilled: string[] = [];
    // Anything that went wrong, shown to the human so they know what to finish by hand.
    // A list rather than a count, because the human needs the reasons, not a number.
    const problems: string[] = [];
    // One try around all fill work, so any throw still reaches the park below.
    try {
      // A captcha or login wall is reported, never worked around (constraint 5); the
      // human is sitting at the window and can deal with it.
      // Asked of the live page, since a wall only exists once the page has loaded.
    const detected = await page.detectBlocker();
      // Informational only: the human is present to handle it.
      if (detected !== null) problems.push(`page blocker detected: ${detected}`);

      // Read the form, then decide: the planner copies answers or reports blockers, and
      // has no third branch that invents a value (constraint 4).
      // The accessibility-tree read of the form; shared by both planners below.
      const fields = await page.extractFields();
      // Pure planner decision over those fields and the stored answers.
      // Warn (once per call) when the gateway cannot supply a profile, so a wiring slip is visible not silent.
      // Warn instead of throw: the flow still works, it just asks the human for more.
      if (gateway.fetchLatestProfile === undefined) console.warn('[assisted-submit] gateway has no fetchLatestProfile; profile fills disabled');
      // Profile read alongside the bank so factual fields (email, phone, links) can be copied.
      // Null default so an absent method means no profile fills, the safe direction.
      const plan = planFill(fields, await gateway.fetchAnswers(), (await gateway.fetchLatestProfile?.()) ?? null);
      // Blockers are listed as unfilled so the human knows which questions are theirs.
      // Each blocker is a question the bank cannot answer, so it is the human's to do.
      for (const blocker of plan.blockers) unfilled.push(blocker.label);

      // One field at a time with its own catch: a single stubborn widget must not stop
      // the rest of the form being filled for the human.
      for (const fill of plan.fills) {
        try {
          // Types the answer-bank value verbatim; nothing is composed or guessed.
          await page.fill(fill.id, fill.value);
          // Recorded only after the fill succeeded, so the summary never overstates.
          filled.push(fill.id);
        } catch (error) {
          // A failed fill is the human's job now, so it joins the unfilled list.
          unfilled.push(fill.id);
          // And the cause is shown, so they know why the field is empty.
          problems.push(`fill ${fill.id} failed: ${messageOf(error)}`);
        }
      }

      // Where the resume goes; the snapshot's presence is the only input it gets.
      // Decide which file input takes the resume, or why none can.
      const attachment = planResumeAttachment(fields, { hasResumeSnapshot: true });
      // The planner's blockers are coverage gaps; the human can attach by hand.
      // A document field we cannot place is listed so the human attaches by hand.
      for (const blocker of attachment.blockers) unfilled.push(blocker.label);
      // Null target means the form has no upload box, which is a legitimate shape.
      if (attachment.target !== null) {
        // Rendered from the approved snapshot, so the bytes are what the human reviewed.
        // Fallible by design (a stale schema throws), hence inside the guarded block.
        const rendered = await renderResume(resume);
        await page.attachFile(attachment.target.id, {
          // Deterministic file name, so the recruiter sees a sensible one.
          name: resumeFileName(resume),
          // Declared explicitly because upload widgets validate the type.
          mimeType: 'application/pdf',
          // The exact rendered bytes, not a second render.
          bytes: rendered.bytes,
        });
        // Same rule as fills: recorded only after the attach succeeded.
        filled.push(`resume -> ${attachment.target.label}`);
      }
    } catch (error) {
      // A throw partway is NOT a reason to skip the park: the human can finish by hand,
      // and a row left at `applying` would be misread as a possible real submission.
      // Shown to the human with the rest, so nothing about the failure is hidden.
      problems.push(`filling stopped early: ${messageOf(error)}`);
    }

    // ---- Step 4: park IMMEDIATELY, success or not. ------------------------------
    try {
      // Validated against the graph in TypeScript before the database is asked.
      await guardedAdvance(gateway, {
        // The row this run owns.
        applicationId,
        // The state we put it in a moment ago.
        from: 'applying',
        // The only edge out of `applying` that reaches a human queue.
        to: 'blocked_needs_human',
        // The worker parks the row; it does not claim anything was sent.
        agent: WORKER_AGENT,
        // block_reason is REQUIRED here: the RPC copies it into the enum column the CHECK
        // demands and raises 22023 if it is missing, so dropping it fails the park loudly.
        // `other` because the enum has no "assisted" member; the sentence explains which.
        detail: { block_reason: 'other', note: ASSISTED_BLOCK_NOTE, unfilled, problems },
      });
    } catch (error) {
      // Loud, and no prompt: with the row not parked, a typed answer could not be
      // recorded honestly. The sweeper will route a stuck `applying` row to a human.
      // Distinct outcome so the CLI exits non-zero and says where the row may be.
      return { kind: 'park_failed', error: messageOf(error) };
    }

    // ---- Step 5: summary, then the question. ------------------------------------
    // The summary is plain log lines so the human sees it beside the browser window.
    log(`Company: ${row.company}`);
    // The role title, so two openings at one company cannot be confused.
    log(`Title:   ${row.title}`);
    // The URL the browser is on, so the human can verify it is the real employer.
    log(`URL:     ${applyUrl}`);
    // Counts first, so a glance tells whether the form is nearly done.
    log(`Filled (${filled.length}): ${filled.join(', ') || 'none'}`);
    // The list the human acts on, so it is printed even when empty.
    log(`NOT filled (${unfilled.length}): ${unfilled.join(', ') || 'none'}`);
    // Every problem, because a hidden failure is how a half-filled form gets submitted.
    for (const problem of problems) log(`PROBLEM: ${problem}`);
    // The instruction the whole flow exists for: the human, not the worker, submits.
    log('Review the form in the browser window and click Submit yourself if it is right.');

    // Raw line in, decision out; interpretation lives in one tested function.
    // The question text is fixed here so the wording never varies between runs.
    const transition = interpretAnswer(
      await askHuman('Did you click Submit and see a confirmation? [y/n] '),
    );
    // Unsure writes nothing: a wrong `applied` is worse than a row waiting for a human.
    // Checked against null explicitly: an object is a decision, null is not.
    if (transition === null) {
      // Said out loud so the human knows the row was deliberately left alone.
      log('No clear y/n answer. Row left at blocked_needs_human; nothing more written.');
      // The caller exits cleanly: leaving it blocked is a valid outcome, not an error.
      return { kind: 'left_blocked' };
    }
    try {
      // The human is the actor: only a person can assert a submission happened.
      await guardedAdvance(gateway, {
        // Same row as everywhere above.
        applicationId,
        // Where the park left it.
        from: 'blocked_needs_human',
        // Either applied or failed, decided purely by what the human typed.
        to: transition.to,
        // Human-only edges: the graph refuses these for any automated actor.
        agent: HUMAN_AGENT,
      });
    } catch (error) {
      // The row simply stays blocked; the human can fix it in the dashboard.
      return { kind: 'record_failed', error: messageOf(error) };
    }
    // The CLI prints this and exits zero.
    return { kind: 'recorded', to: transition.to };
  } finally {
    // Step 6: release only a lease that still exists. After any status write the RPC has
    // already cleared it, so releasing then would only add a misleading event row.
    // Guarded so a normal run does not leave a spurious release event behind.
    if (!advanced) {
      // Without this the lease would block the scheduled applier until it expires.
      await gateway.releaseClaim(applicationId, 'assisted run ended before applying');
    }
  }
}

