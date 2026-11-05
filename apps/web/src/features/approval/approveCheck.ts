/* The auditor's check, run again when the operator approves an EDITED row (Teja, 2026-11-05:
 * "Check on Approve, hold for a 2nd click").
 *
 * WHY IT EXISTS. The auditor runs once, at tailored -> audit_clean|audit_flagged. Edits made later at
 * awaiting_approval (typed by hand, or an AI-chat card the operator clicked) were never re-checked,
 * and since 2026-10-09 the worker submits an approved row by itself. So the only moment left to show
 * "this resume now says something your master does not" is the Approve click.
 *
 * WHY THE AUDITOR'S OWN FUNCTION. auditApplication is imported by relative path, as aiEdit.ts already
 * imports the detector, so this check and the auditor can never disagree about what is grounded. It
 * gets the auditor's inputs too: the stored resume, its tailor refs, and the master the row is pinned
 * to NOW (an attest re-pins the row to a new master version that has the skill).
 *
 * WHY IT FAILS CLOSED. Missing or malformed data becoming an answer is this repo's recurring bug
 * (CLAUDE.md §6). Every way the check cannot run, and every answer of the wrong shape, is
 * 'unverified', which holds the approval exactly like a finding. Nothing here returns 'clean'
 * except a well-formed clean verdict with zero findings. */

// The auditor's verdict function: the same code that set this row's audit status at tailoring.
import { auditApplication } from '../../../../../supabase/functions/_shared/audit/audit.ts';
// The contract types the auditor reads; the web and the edge share them.
import type { MasterProfile, ResolvedResume, TailoredProfile } from '../../data/contract';

/* One finding as the card shows it: where, the words, and why. The auditor's confidence and kind are
   dropped because the card shows every finding the same way: a flag is a flag. */
export interface HeldFinding {
  // Where in the resume, e.g. experience[0].bullets[0].
  readonly path: string;
  // The words that were flagged, quoted on the card.
  readonly claim: string;
  // The auditor's reason, in its own words.
  readonly reason: string;
}

/* The answer, as a CLOSED UNION: 'clean' carries nothing, so no caller can read findings off a pass,
   and 'unverified' is its own arm, so "could not check" can never be mistaken for "nothing found". */
export type ApproveCheck =
  // Well-formed, zero findings: approve on this click.
  | { readonly kind: 'clean' }
  // The auditor flagged at least one claim: listed on the card, approve only on a second click.
  | { readonly kind: 'flagged'; readonly findings: readonly HeldFinding[] }
  // The check could not run or answered in a shape it never gives: held the same way, with the reason.
  | { readonly kind: 'unverified'; readonly why: string };

/* What the card holds: any answer but a pass. */
export type ApproveHold = Exclude<ApproveCheck, { readonly kind: 'clean' }>;

// The auditor's signature, so a test can hand in a wrong-shaped answer through the same seam.
type Audit = (master: MasterProfile, resume: ResolvedResume, tailorRefs?: TailoredProfile | null) => unknown;

/* A plain object (not null, not an array): the only shape a finding or an outcome can have. */
function isRecord(value: unknown): value is Record<string, unknown> {
  // typeof null is 'object' and an array is an object too; neither is a record.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* One finding, checked field by field: a finding without its words cannot be shown, so it is malformed. */
function isFinding(value: unknown): value is HeldFinding {
  // The three fields the card prints, each a string.
  return isRecord(value) && typeof value.path === 'string' && typeof value.claim === 'string' && typeof value.reason === 'string';
}

/* The 'unverified' answer with its reason, in one place so every refusal reads the same way. */
function unverified(why: string): ApproveCheck {
  // Held like a finding.
  return { kind: 'unverified', why };
}

/* Re-run the auditor over the row as stored now. `master` is the row's CURRENT pinned master (the
   page's RowSource.master, which an attest replaces), `resume` the stored tailored_profile, and
   `tailorRefs` the stored tailor_refs as loaded (untyped JSON). `audit` defaults to the auditor. */
export function checkBeforeApprove(
  master: MasterProfile | undefined,
  resume: ResolvedResume | undefined,
  tailorRefs: unknown,
  audit: Audit = auditApplication,
): ApproveCheck {
  // No master: nothing to check the words against.
  if (master === undefined || master === null) return unverified('this page has no master profile for this resume.');
  // No resume: nothing to check.
  if (resume === undefined || resume === null) return unverified('this page has no stored resume for this row.');
  // Tailor refs are absent (null) or a record; anything else is a row the auditor would not read either.
  if (tailorRefs !== null && tailorRefs !== undefined && !isRecord(tailorRefs)) return unverified('the row\'s tailoring record is malformed.');
  // The auditor's answer, or the reason it could not give one.
  let outcome: unknown;
  try {
    // The same call the auditor makes, on the same three inputs.
    outcome = audit(master, resume, (tailorRefs ?? null) as TailoredProfile | null);
  } catch (error) {
    // A throw is "could not check", never "nothing found".
    return unverified(`the check stopped with an error: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The outcome's own shape: a record with a findings array.
  if (!isRecord(outcome) || !Array.isArray(outcome.findings)) return unverified('the check gave an answer of an unexpected shape.');
  // The findings, as the auditor returned them.
  const findings: readonly unknown[] = outcome.findings;
  // Every finding must be showable; one without its words would hide what it flagged.
  if (!findings.every(isFinding)) return unverified('the check returned a finding without its words.');
  // A pass is a clean verdict AND no findings, both: either alone is a contradiction, not a pass.
  if (outcome.status === 'audit_clean' && findings.length === 0) return { kind: 'clean' };
  // Flagged with at least one finding: the card lists them. Copied, so the card holds only its three fields.
  if (outcome.status === 'audit_flagged' && findings.length > 0) {
    // The narrowed findings, each cut to what the card prints.
    return { kind: 'flagged', findings: findings.filter(isFinding).map(({ path, claim, reason }) => ({ path, claim, reason })) };
  }
  // Clean with findings, flagged with none, or a status the auditor never returns.
  return unverified('the check\'s verdict and its findings disagree.');
}
