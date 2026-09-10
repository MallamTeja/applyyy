// The ONE place `supabase/functions/**` reaches into `@applyy/shared-types`.
//
// WHY A RE-EXPORT MODULE AND NOT A DIRECT IMPORT EVERYWHERE: the specifier used to
// reach aa's package is still in flux. applyyy-04's spike resolved the bare
// specifier `@applyy/shared-types` through a `deno.json` import map, but Deno reads
// that map and Node's test runner does not — and `pnpm install` is currently failing
// workspace-wide (ERR_PNPM_IGNORED_BUILDS on esbuild), so there is no node_modules
// link to resolve a bare specifier through either.
//
// A relative path works in BOTH runners today with zero configuration and zero
// install. Confining it to this single file means switching to the bare specifier
// later is a one-line edit here rather than a sweep through every module — the same
// quarantine technique that made replacing the placeholder types a single deletion.
//
// The types are the schema owner's. Nothing in `supabase/functions/**` may redefine
// one: a redefined type does not fail, it DRIFTS, and drift between the row shape
// and the code writing that row is invisible until production.

// Re-exported wholesale so consumers import from here exactly as they would from the
// package itself. `export type` only — these are types and const tuples, and pulling
// the values in unnecessarily would create a runtime dependency where none is needed.
export type {
  // The human-maintained truth the Tailor may select from, and its inner nodes.
  MasterProfile,
  MasterBullet,
  MasterSkill,
  MasterIdentity,
  MasterExperience,
  MasterEducation,
  MasterProject,
  // What Gemini is allowed to return: refs plus rewordings, incapable of expressing
  // a new fact. This is §10 defense 1 encoded as a type rather than as a checker.
  TailoredProfile,
  TailoredBullet,
  TailoredSkill,
  TailoredExperience,
  TailoredEducation,
  TailoredProject,
  TailoredSummary,
  TailoredSectionKind,
  // The render input, constructible only by the validator.
  ResolvedResume,
  ResolvedBullet,
  ResolvedSkill,
  ResolvedExperience,
  ResolvedEducation,
  ResolvedProject,
  // Shared node vocabulary.
  NodeId,
  DisplayDate,
  DocumentOrdered,
  // Enum unions this stream writes into columns.
  PostedAtSource,
  FilterRuleType,
  ApplicationStatus,
  AtsProvider,
  DiscoverySource,
  EmploymentType,
  WorkArrangement,
  // The untrusted-string marker. It is `string` to the compiler and buys no
  // enforcement — it exists so the danger is visible at every use site instead of
  // living in a document nobody rereads.
  Untrusted,
  // The JSON column type, used by `filter_rules.config` and `jobs.raw_payload`.
  Json,
  // Row and insert shapes this stream reads or writes. Imported, NEVER redefined: a
  // redefined row type does not fail, it DRIFTS, and drift between the row shape and
  // the code writing that row is invisible until production.
  SystemSettingsRow,
  JobRow,
  JobInsert,
  JobUpdate,
  JobSourceRef,
  ApplicationRow,
  AuditFinding,
  FilterRuleRow,
  CompanyWatchlistRow,
  EmailEventRow,
  EmailEventInsert,
  GeminiKeyStateRow,
  AgentRunRow,
  AgentRunInsert,
  // Enum unions for the agent runtime and the email Tracker.
  AgentName,
  AgentRunStatus,
  EmailClassification,
  BlockReason,
} from "../../../../packages/shared-types/src/index.ts";

// VALUES, not types — and the reason this block exists is worth stating, because the
// header above originally said this module would be `export type` only.
//
// That was correct while this stream had only pure text functions. It stopped being
// correct the moment an agent needed to WRITE a status: SCHEMA_CONTRACT.md §6 requires
// `canTransition` to be called before every status write, so that an illegal edge
// fails fast in TypeScript rather than surfacing as an opaque trigger error from
// Postgres. That check cannot be performed by a type — it needs the runtime graph.
//
// So the runtime dependency is now deliberate and paid for, rather than accidental.
// It stays confined to this one module for the same reason the type re-exports do:
// switching to the bare `@applyy/shared-types` specifier later remains a one-line
// edit here instead of a sweep through every agent.
export {
  // The ~45-edge status graph's guard. Called before every status write.
  canTransition,
  // What an agent may legally move a row to from here, for building the next step.
  nextStatuses,
  // Whether a row has reached a state nothing further will move it out of.
  isTerminal,
  // The status vocabulary, for validating a value that arrived as a plain string.
  APPLICATION_STATUSES,
  // The agent identities the transition guard accepts as actors.
  AGENT_NAMES,
  // The filter cascade's rule vocabulary — the Screener iterates this.
  FILTER_RULE_TYPES,
  // The classifier's output vocabulary, used to build Gemini's response schema.
  EMAIL_CLASSIFICATIONS,
} from "../../../../packages/shared-types/src/index.ts";
