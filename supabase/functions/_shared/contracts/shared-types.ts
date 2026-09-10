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
} from "../../../../packages/shared-types/src/index.ts";
