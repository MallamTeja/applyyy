// ============================================================================
// TEMPORARY. DELETE THIS FILE WHEN `packages/shared-types` LANDS.
// ============================================================================
// applyyy-aa owns the schema and the shared types that derive from it. That
// package does not exist yet, and stream 2 was told to start on the pure
// functions rather than idle. Every type below is a PLACEHOLDER standing in for
// something aa will own.
//
// The rule this file exists to obey: a redefined type that lives next to its
// consumers gets forgotten and drifts. Quarantining all of them in ONE file with
// this banner means the migration is a single deletion plus a re-point of the
// imports, and `noUnusedLocals` will point at anything left behind.
//
// NOTHING here may be treated as settled. If aa's version disagrees, aa wins.
// ============================================================================

// A single achievement line on the master resume. `id` is the load-bearing part:
// §10 defense 1 only works because the Tailor can REFERENCE a bullet instead of
// re-typing it, which is what lets typed code check the reference against reality.
export interface MasterBullet {
  // Stable identifier. Must survive master-profile version bumps, because an
  // application stores the version it derived from (§9) and has to resolve back.
  readonly id: string;
  // The verbatim text as Teja wrote it. This is the ONLY factual source a
  // tailored bullet may draw from.
  readonly text: string;
}

// One skill on the master resume. Deliberately a name plus an id and nothing
// else: the Tailor selects skills, it never writes them (see validator.ts).
export interface MasterSkill {
  // Stable identifier, referenced by the Tailor.
  readonly id: string;
  // The canonical spelling, rendered onto the PDF verbatim.
  readonly name: string;
}

// The versioned, immutable snapshot described in §9. Immutable is what keeps the
// Auditor's verdict meaningful six months later: it audited a specific version,
// and that version still exists to be re-checked.
export interface MasterProfile {
  // Monotonic version. Editing the profile creates N+1; N never changes.
  readonly version: number;
  // Every achievement line available for selection.
  readonly bullets: readonly MasterBullet[];
  // Every skill available for selection.
  readonly skills: readonly MasterSkill[];
}
