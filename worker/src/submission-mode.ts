// The DRY_RUN gate: the one decision that separates "filled a form" from "sent
// an application to a real employer".
//
// PROJECT_PLAN.md §18.6 runs the first three days with nothing submitted, so
// Teja can review screenshots of exactly what would have gone out before
// granting the system authority to send. Constraint #15 forbids automating
// final submission by default. Submission is also the one non-idempotent action
// in the entire system (§14), so a wrong answer here is not recoverable by
// retrying — it is a duplicate application, which is constraint #7.
//
// The design rule this file follows: PREFER A DESIGN WHERE THE WRONG ANSWER
// CANNOT BE EXPRESSED. There is exactly one string that enables submission.
// Everything else — unset, empty, mis-cased, whitespace-padded, "0", "no" —
// resolves to dry-run without interpretation. The function never infers intent.

/**
 * The environment slice this gate reads. Taking a plain record rather than
 * touching process.env directly is what makes the gate unit-testable without
 * mutating global state, and lets a caller pass a deliberately narrowed view.
 */
export type SubmissionEnv = Readonly<Record<string, string | undefined>>;

/** The gate's verdict, plus the human-readable reason behind it. */
export interface SubmissionMode {
  // The only field the applier is allowed to branch on before submitting.
  readonly submits: boolean;
  // Why this verdict was reached, quoting the offending value where relevant.
  // §14's whole subject is failures that do not announce themselves; a run log
  // that cannot distinguish "deliberately dry" from "misconfigured and
  // silently dry" reproduces exactly that class of silent death.
  readonly reason: string;
}

// The sole value that enables real submission. Exact, lowercase, no trimming.
// Kept as a named constant so the opt-in appears once in the codebase and is
// greppable by anyone auditing how submission can possibly be turned on.
//
// NAMED FOR ITS VALUE, NOT ITS EFFECT, AND DELIBERATELY SO. This constant was
// once called SUBMISSION_OPT_IN, which read as `SUBMISSION_OPT_IN = 'false'` —
// a line whose name inverts the polarity of its value, so it scans as a bug and
// greps as one. The danger was never confusion: it is that a future reader
// "corrects" it to 'true' to make the name agree, and that edit silently
// enables real submissions on every run. The polarity is confusing because the
// VARIABLE is negative (DRY_RUN) while the ACTION is positive (submit), so
// disabling the dry run is what permits sending. Naming the constant after the
// literal it must equal removes the invitation to fix it.
const DRY_RUN_DISABLED_VALUE = 'false';

/**
 * Decide whether this run may submit applications.
 *
 * Fails closed on every input except the exact opt-in string.
 */
export function resolveSubmissionMode(env: SubmissionEnv): SubmissionMode {
  // Read once; the variable is named for the safety property, not the mechanism.
  const raw = env['DRY_RUN'];

  // Unset is the most likely real-world case — a fresh runner, a workflow that
  // forgot the variable, a secret that does not exist yet. It must be safe.
  if (raw === undefined) {
    return {
      submits: false,
      reason: 'DRY_RUN is unset; defaulting to dry-run (PROJECT_PLAN.md §18.6).',
    };
  }

  // The single deliberate opt-in. Compared with === against an exact string, so
  // no casing, padding or truthiness rule can widen this branch by accident.
  if (raw === DRY_RUN_DISABLED_VALUE) {
    return {
      submits: true,
      reason: 'DRY_RUN="false"; submission explicitly enabled.',
    };
  }

  // Everything else. Deliberately NOT normalised: trimming or lowercasing here
  // would mean " False " enables submission, and a value that ambiguous is
  // evidence of a configuration mistake, not of intent to send applications.
  // The offending value is quoted so the log names the actual misconfiguration.
  return {
    submits: false,
    reason:
      `DRY_RUN=${JSON.stringify(raw)} is not the exact string "false"; ` +
      'refusing to submit. Set DRY_RUN=false exactly to enable submission.',
  };
}
