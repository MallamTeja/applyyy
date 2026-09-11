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
  // The human's own summary paragraph AS A NODE WITH A `NodeId`, not a bare string.
  // Re-exported because `TailoredSummary.refs` can now cite it, so the validator has
  // to be able to name the type it is resolving that citation against.
  MasterSummary,
  // Undated award and credential nodes. Added 2026-09-11 because ingest was silently
  // dropping both sections off the real resume — a fact present in the document and
  // absent from the contract. They are bullet-bearing parents like experience, which
  // is what makes them tailorable through `TailoredBullet` rather than free text.
  MasterAchievement,
  MasterCertification,
  // A labelled external address carrying its OWN `NodeId`, so a link reconciles
  // across re-uploads instead of looking like a new link every time.
  //
  // THIS NAME WAS MISSING BEFORE THE 2026-09-11 CONTRACT CHANGE — a PRE-EXISTING GAP,
  // not fallout from it. `MasterIdentity.links` and `MasterProfile.links` have both
  // been `DocumentOrdered<MasterLink>` since the contract was written, so any module
  // in this tree that wanted to annotate a link variable could not, and the omission
  // showed up as "that type does not exist" rather than as anything pointing here.
  // That is the exact failure mode this hand-maintained allowlist has: a missing name
  // HIDES a type, it does not break a build.
  MasterLink,
  // What Gemini is allowed to return: refs plus rewordings, incapable of expressing
  // a new fact. This is §10 defense 1 encoded as a type rather than as a checker.
  TailoredProfile,
  TailoredBullet,
  TailoredSkill,
  TailoredExperience,
  TailoredEducation,
  TailoredProject,
  // Selected award and credential. Carry a `ref` and bullets and NOTHING ELSE — no
  // `label`, no `description` — so "Winner" cannot be tailored into "International
  // Winner". Re-exported so the validator can type its two new resolution loops
  // against the contract rather than against an inferred shape.
  TailoredAchievement,
  TailoredCertification,
  TailoredSummary,
  TailoredSectionKind,
  // The render input, constructible only by the validator.
  ResolvedResume,
  ResolvedBullet,
  ResolvedSkill,
  ResolvedExperience,
  ResolvedEducation,
  ResolvedProject,
  // Award and credential AFTER resolution: `label` and `description` materialised
  // out of the pinned master by typed code, which is the whole reason the tailored
  // forms above are allowed to omit them. Only the validator may construct these.
  ResolvedAchievement,
  ResolvedCertification,
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
