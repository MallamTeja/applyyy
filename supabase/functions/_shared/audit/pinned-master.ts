// ============================================================================
// PINNED MASTER RESOLUTION FOR THE AUDITOR
// ============================================================================
//
// The Auditor judges fabrication by comparing a tailored resume to the master
// profile. The ground truth must be the master version the Tailor was PINNED to
// (`applications.master_version`), not the newest upload: a master uploaded after
// tailoring would flag true claims or pass ones that are no longer backed.
//
// A missing or malformed pin FAILS CLOSED. Falling back to the latest master is the
// exact bug this module replaces (CLAUDE.md §5: a lenient reader is the fail-open),
// so the verdict is a closed union and there is no "latest" branch to reach for.
// ============================================================================

// Type-only: the resolver hands back the caller's own master objects, never copies.
import type { MasterProfile } from "../contracts/shared-types.ts";

/** Which master a row must be audited against, or why it cannot be audited. */
// A discriminated union, not `MasterProfile | null`: null would erase WHY, and the caller
// reports a different reason for each failure.
export type PinnedMaster =
  // The happy path: the exact master the tailoring cited.
  | { kind: "pinned"; version: number; master: MasterProfile }
  // No pin recorded at all; there is no honest ground truth to audit against.
  | { kind: "unpinned" }
  // A pin of the wrong shape; kept verbatim so the failure report shows what was there.
  | { kind: "invalid_pin"; pin: unknown }
  // A well-formed pin whose master was not loaded; never substitute another version.
  | { kind: "pinned_version_missing"; version: number };

/** Shape check for a pin: a positive safe integer, with no coercion of strings. */
// One predicate shared by both exports, so the batch loader and the per-row resolver can
// never disagree about which pins are real.
function isValidPin(pin: unknown): pin is number {
  // typeof first: Number("2") would quietly accept a string, the lenient-parser trap.
  // Number.isSafeInteger rejects NaN, fractions and Infinity; > 0 because versions start at 1.
  return typeof pin === "number" && Number.isSafeInteger(pin) && pin > 0;
}

/** Resolve a row's pin to its master. Never returns any version other than the pin. */
export function resolvePinnedMaster(
  // `unknown`: the value comes straight off a database row and is validated here, once.
  pin: unknown,
  // Loaded by the caller for exactly this batch's pins (see collectPins).
  mastersByVersion: ReadonlyMap<number, MasterProfile>,
): PinnedMaster {
  // Absent pin is its own reason, distinct from a malformed one, for the dashboard.
  if (pin === null || pin === undefined) return { kind: "unpinned" };
  // Malformed pin: refuse rather than guess what was meant.
  if (!isValidPin(pin)) return { kind: "invalid_pin", pin };
  // Exact-version lookup; there is deliberately no "nearest" or "latest" fallback.
  const master = mastersByVersion.get(pin);
  // A valid pin with no loaded master is damaged data or a failed load, not permission to substitute.
  if (master === undefined) return { kind: "pinned_version_missing", version: pin };
  // The one master this row may be judged against.
  return { kind: "pinned", version: pin, master };
}

/** The distinct valid pins in a batch, ascending, so the caller loads exactly those masters. */
export function collectPins(rows: ReadonlyArray<{ master_version: unknown }>): number[] {
  // A Set dedupes rows tailored against the same master; invalid pins are skipped here and
  // reported per row by resolvePinnedMaster, which sees the same predicate.
  const pins = new Set(rows.map((row) => row.master_version).filter(isValidPin));
  // Sorted so the query and any log line built from it are deterministic.
  return [...pins].sort((a, b) => a - b);
}
