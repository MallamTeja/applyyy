/**
 * applyy — shared type contract. The single import surface for every other package.
 *
 * Import from '@applyy/shared-types', never from a deep path like
 * '@applyy/shared-types/src/enums.ts'. Deep imports would pin consumers to this
 * package's internal file layout and make it unsafe to reorganise.
 *
 * Owned by the schema stream, because types DERIVE from the schema — keeping them
 * anywhere else guarantees they drift out of step with the migrations.
 */

// Enum mirrors: the const tuples for runtime validation and dropdowns, plus the
// unions for compile-time exhaustiveness. Star-exported because every consumer
// needs a different subset and an explicit list here would need editing constantly.
export * from './enums.ts';

// The legal status graph plus canTransition/nextStatuses/isTerminal. A MIRROR of the
// database rule, not the rule itself — Postgres refuses illegal moves regardless.
export * from './status-flow.ts';

// The inner document shapes: MasterProfile (the human-maintained truth), TailoredProfile
// (refs + rewordings — all Gemini may return) and ResolvedResume (the render input).
// The anti-fabrication defence lives here: it is a type, not a checker.
export * from './profile-nodes.ts';

// Row / Insert / Update shapes for all fifteen tables, and the RPC signatures.
export * from './tables.ts';
