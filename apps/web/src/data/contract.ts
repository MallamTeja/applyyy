/* THE SCHEMA SEAM - read this before adding a type anywhere else in apps/web.
 *
 * `packages/shared-types` is owned by the schema stream (applyyy-aa) and is the
 * contract this app must build against. At the time this file was written that
 * package was still empty, and PROJECT_PLAN.md section 21 is explicit that
 * types live with the schema owner because types *derive* from schema and
 * splitting them guarantees drift.
 *
 * So this file is a deliberately-quarantined placeholder, not a second source
 * of truth. The pattern is an ANTI-CORRUPTION LAYER: every domain name the UI
 * needs is declared in exactly one file, so when the real package lands the
 * migration is to replace these declarations with re-exports from
 * `@applyy/shared-types` and delete nothing else. One merge point, not forty.
 *
 * RULES:
 *   - No other file under apps/web may declare a domain type or enum.
 *   - Nothing here is authoritative. If it disagrees with the migrations, the
 *     migrations win and this file is wrong.
 *   - Anything the UI needs that the real contract lacks is a message to the
 *     orchestrator, not a local addition.
 *
 * Values are transcribed from PROJECT_PLAN.md section 9 (status flow) and
 * section 7 (agent roster), the closest thing to the contract that exists yet,
 * PLUS the schema stream's later renames. Where the two disagree the schema
 * stream wins: PROJECT_PLAN.md section 9 is mid-reconciliation and still lists
 * the pre-rename `screened` / `screening` pair.
 */

/* The status column IS the workflow (section 5): each agent claims rows in one
 * status and writes the next. The dashboard renders this; it never drives it. */
export const APPLICATION_STATUSES = [
  'discovered',
  'deduped',
  /* Renamed from `screened` by the schema stream: `screened` and `screening`
   * sat one word apart in the same enum with opposite meanings - one means
   * "survived our filters", the other "the employer is screening us". A name
   * that means two things is the collision this account keeps hitting. */
  'passed_filters',
  'scored',
  'tailored',
  'audit_clean',
  'audit_flagged',
  'awaiting_approval',
  'approved',
  'applying',
  'applied',
  /* The employer's own screening stage, advanced by the email Tracker rather
   * than by anything the operator does. Renamed from `screening` alongside
   * `passed_filters` above. */
  'employer_screening',
  'oa_pending',
  'interview',
  'offer',
  'rejected',
  /* Off-ramps. Terminal or human-owned; never auto-advanced. */
  'dropped_filter',
  'dropped_duplicate',
  'blocked_needs_human',
  'needs_verification',
  'failed',
] as const;

/* Derived from the array rather than declared twice, so the runtime list the
 * kanban iterates and the compile-time union can never disagree. */
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/* The Auditor's per-line finding. `traced` means the line resolves to a real
 * node in the master profile; `fabricated` means it resolves to nothing, which
 * is the section 11 case the whole approval gate exists for. */
export type TraceVerdict = 'traced' | 'fabricated';

/* Which review bucket a row falls into (section 11). This is DERIVED, not
 * stored: a row is Bucket B if any single line is fabricated. Deriving it in
 * one place stops a UI that shows "Bucket A" next to a visible oxblood stamp. */
export type ReviewBucket = 'A' | 'B';

/* The nine agents of section 7, in pipeline order. The health page needs the
 * ordered list to show last-successful-run per agent, so this is an array too. */
export const AGENT_NAMES = [
  'scout-ats',
  'scout-aggregator',
  'normalizer',
  'screener',
  'matcher',
  'tailor',
  'auditor',
  'applier',
  'tracker',
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

/* Confidence in `posted_at` (section 13). The 3-day freshness filter behaves
 * differently per level, and `unknown` rows are excluded from it entirely by
 * the cold-start guard - so the UI must be able to show which is which, or the
 * operator cannot tell why a stale-looking job survived filtering. */
export type PostedAtSource = 'exact' | 'derived' | 'unknown';
