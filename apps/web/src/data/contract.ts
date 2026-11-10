/* THE SCHEMA SEAM - read this before importing a domain type anywhere in apps/web.
 *
 * `@applyy/shared-types` is owned by the schema stream and is the single source
 * of truth for every domain name in this system: 12 enums, the status graph,
 * and Row/Insert/Update shapes for all 14 tables. Types live with the schema
 * owner because types DERIVE from schema, and splitting them guarantees drift.
 *
 * This file used to hold placeholder unions written while that package was
 * still empty. Those are now deleted - it is a pure re-export surface, which is
 * the whole point of having routed every domain name through one file: the
 * migration off the placeholders touched this file and nothing else.
 *
 * WHY RE-EXPORT AT ALL rather than importing the package directly everywhere:
 * it keeps one place to look for what the UI actually depends on, and one place
 * to add an adapter if the contract ever needs reshaping for display. That is
 * an ANTI-CORRUPTION LAYER, and it costs one file.
 *
 * RULES:
 *   - No file under apps/web may declare a domain type or enum. If you need
 *     one, add a re-export here; if it does not exist upstream, message the
 *     orchestrator rather than inventing it locally.
 *   - PRESENTATION types are different and do NOT belong here. The shape a
 *     component needs in order to draw is owned by that component.
 *   - Never write into `packages/shared-types`. It is another stream's file.
 *   - Never deep-import (`@applyy/shared-types/src/enums.ts`); the package's
 *     export map is the supported surface.
 */

/* --- Enums ------------------------------------------------------------- */

/* The status column IS the workflow: each agent claims rows in one status and
 * writes the next. The dashboard renders this; it never drives it.
 *
 * Exported as both a const tuple and a union, so the same declaration order
 * drives the kanban's column order at runtime and exhaustiveness checking at
 * compile time. Note `passed_filters` (WE filtered it, pre-apply) and
 * `employer_screening` (THEY are reviewing us, post-apply) - renamed from the
 * plan's `screened` / `screening`, which were one letter apart with opposite
 * meanings in the same enum. */
export { APPLICATION_STATUSES } from '@applyy/shared-types';
export type { ApplicationStatus } from '@applyy/shared-types';

/* Agent identities. Includes `human`, which is not in the plan's roster but
 * must exist: an approval is an event with an author, and several status edges
 * are human-only. Also includes `sweeper`, the lease reclaimer. */
export { AGENT_NAMES } from '@applyy/shared-types';
export type { AgentName } from '@applyy/shared-types';

/* Confidence in `jobs.posted_at`. The job-age (staleness/freshness) filter that
 * once read this per level was retired on 2026-11-10 - Teja: "dont ever skip even
 * though they are 1 mon 2 mont old" - so no job is dropped for its age any more.
 * The UI still shows the level so the operator can tell how far to trust a
 * displayed posting date (an `unknown` date is a guess, not a board fact). */
export { POSTED_AT_SOURCES } from '@applyy/shared-types';
export type { PostedAtSource } from '@applyy/shared-types';

/* Every row of the filter cascade is one of these, and the Filters page renders
 * one control per rule type. Nothing about the cascade is hardcoded in this
 * system - the settings pages ARE the configuration surface. */
export { FILTER_RULE_TYPES } from '@applyy/shared-types';
export type { FilterRuleType } from '@applyy/shared-types';

/* Why a company is blocked. Drives the Blocklist page's reason selector. */
export { BLOCKLIST_REASONS } from '@applyy/shared-types';
export type { BlocklistReason } from '@applyy/shared-types';

/* Answer bank value shapes. The bank grows itself as new ATS questions appear,
 * so the page must render a control per type rather than a fixed form. */
export { ANSWER_TYPES } from '@applyy/shared-types';
export type { AnswerType } from '@applyy/shared-types';

/* Agent run outcomes, for the health page. */
export { AGENT_RUN_STATUSES } from '@applyy/shared-types';
export type { AgentRunStatus } from '@applyy/shared-types';

/* Job metadata enums used by the pipeline cards and the watchlist page. */
export { ATS_PROVIDERS, EMPLOYMENT_TYPES, WORK_ARRANGEMENTS } from '@applyy/shared-types';
export type { AtsProvider, EmploymentType, WorkArrangement } from '@applyy/shared-types';

/* Where a job was discovered. Drives the SourceBadge pill theme (Tier 1 = career page,
 * Tier 2 = linkedin post, Tier 3 = portal/aggregator). */
export { DISCOVERY_SOURCES } from '@applyy/shared-types';
export type { DiscoverySource } from '@applyy/shared-types';

/* --- The status graph -------------------------------------------------- */

/* THE SINGLE DEFINITION OF THE WORKFLOW. The database trigger, the agents and
 * this UI are all readers of it.
 *
 * Every "what can this row do next" affordance in the console must come from
 * `nextStatuses` / `isTerminal` rather than a hardcoded list, so that when the
 * schema stream adds or removes an edge the UI follows instead of drifting into
 * offering a button the database will refuse.
 *
 * Two facts worth knowing while building the approval gate:
 *   - `awaiting_approval -> approved` is the ONLY edge into `approved`, and
 *     `approved -> applying` is the ONLY edge into `applying`. Constraint #15
 *     is therefore unreachable-by-construction: this UI is the gate, and there
 *     is no path around it to route through.
 *   - Eleven edges are human-only, so the UI must expose them or they cannot
 *     happen at all - a row would enter a status nothing can leave. See
 *     `humanLanes.ts`, which derives that list from the graph rather than
 *     restating it. */
export {
  STATUS_TRANSITIONS,
  TERMINAL_STATUSES,
  NON_RETRYABLE_STATUSES,
  canTransition,
  nextStatuses,
  isTerminal,
} from '@applyy/shared-types';
export type { StatusTransition } from '@applyy/shared-types';

/* --- Table shapes ------------------------------------------------------ */

/* `Untrusted` marks a string that came from a job description, an ATS page or
 * an incoming email (constraint #17). Rendering one is always plain React text
 * children; it is never handed to a raw-HTML escape hatch, interpolated into an
 * href or selector, or evaluated. Importing the alias keeps that obligation
 * visible at every use site instead of relying on memory. */
export type { Json, Untrusted } from '@applyy/shared-types';

/* The queue row the whole console reads. `audit_findings` being empty is what
 * makes a row Bucket A. */
export type {
  ApplicationRow,
  ApplicationUpdate,
  AuditFinding,
} from '@applyy/shared-types';

/* Jobs, and the per-source provenance the pipeline cards show. */
export type { JobRow, JobSourceRef } from '@applyy/shared-types';

/* The resume as structured JSON. The Tailor manipulates identified nodes rather
 * than free text, which is what makes the honesty guarantee structural rather
 * than bolted on - see the note in diffAdapter.ts about what that means for
 * which fabrications the diff view can actually encounter. */
export type {
  MasterProfileRow,
  MasterProfile,
  MasterBullet,
  MasterSkill,
  NodeId,
  TailoredProfile,
  TailoredBullet,
  TailoredSkill,
  TailoredSummary,
  ResolvedResume,
} from '@applyy/shared-types';

/* Settings-page rows. One page per row type; every field on these pages is a
 * live control, because nothing in this system is hardcoded. */
export type {
  SearchPreferencesRow,
  SearchPreferencesUpdate,
  FilterRuleRow,
  FilterRuleUpdate,
  CompanyWatchlistRow,
  CompanyWatchlistUpdate,
  CompanyBlocklistRow,
  CompanyBlocklistUpdate,
  AnswerBankRow,
  AnswerBankUpdate,
  SystemSettingsRow,
  SystemSettingsUpdate,
} from '@applyy/shared-types';

/* Health-page rows: run history per agent, the Gemini pool, and the audit log. */
export type {
  AgentRunRow,
  GeminiKeyStateRow,
  ApplicationEventRow,
} from '@applyy/shared-types';

/* Email Monitoring rows. Re-exported 2026-11-02 (W21): emailSync.ts kept its own copy
 * with `classification: string`, so a comparison against a value the enum never holds
 * (`'interview'`) compiled and was dead code. The closed union makes that a tsc error. */
export type { EmailEventRow, EmailClassification } from '@applyy/shared-types';
