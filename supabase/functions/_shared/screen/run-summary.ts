// Persisting the cascade's "rule skipped" warnings into agent_runs.error_detail.
//
// WHY THIS EXISTS. cascade.ts returns a warning when a rule cannot run (unconfigured, or
// the JD side is null; cascade.ts:155,157,315). Every screening caller collected those and
// then only returned or printed them, so experience_ceiling and degree_mismatch read as
// working while filtering nothing (B1, ruled 2026-10-08: make them loud). agent_runs has no
// jsonb column, so error_detail is the one place a run can say this without a migration.
//
// It is a WARNING, not an error: callers keep error_count and status exactly as before, and
// the segment is labelled `rule_warnings:` so it cannot be read as one of the counted
// failures. scout-ats already labels its non-error `liveness_refused:` segment the same way.

// Bounds what one run can write; long enough for every distinct rule warning that exists.
const MAX_DETAIL_LENGTH = 1000;
// Slice the failure summary may never eat when warnings exist. Without it, a 2000-char
// summary (the worker joins up to 20 db errors) pushed every warning past the cap and the
// warnings vanished silently — the exact invisibility this module exists to remove.
const WARNINGS_RESERVED_LENGTH = 400;

// Cut to `max` chars, ending in "…" when anything was dropped, so a reader of the health
// page can tell a truncated line from a complete one.
function capWithEllipsis(text: string, max: number): string {
  // Fits: return it untouched, so short text never gains a misleading marker.
  if (text.length <= max) return text;
  // One char of the budget goes to the marker, keeping the result within `max`.
  return `${text.slice(0, max - 1)}…`;
}

/** Append a labelled, deduped `rule_warnings:` segment to a run's existing error_detail. */
export function withRuleWarnings(detail: string | null, warnings: Iterable<string>): string | null {
  // Set: one rule skipped on 300 rows is one fact. Sorted, so the text is stable run to run.
  const distinct = [...new Set(warnings)].sort();
  // Nothing to add: return the detail untouched, so a clean run keeps a null column.
  if (distinct.length === 0) return detail;
  // Labelled segment; " | " inside it, "; " between segments, matching scout-ats.
  const segment = `rule_warnings: ${distinct.join(" | ")}`;
  // No failure summary: the segment alone gets the whole budget.
  if (!detail) return capWithEllipsis(segment, MAX_DETAIL_LENGTH);
  // The summary is capped FIRST, leaving the reserve free, so it can never crowd warnings out.
  const head = capWithEllipsis(detail, MAX_DETAIL_LENGTH - WARNINGS_RESERVED_LENGTH);
  // The segment gets whatever is left after the summary and the "; " separator — at least
  // the reserve minus 2, more when the summary is short — so the total stays ≤ the cap.
  const tail = capWithEllipsis(segment, MAX_DETAIL_LENGTH - head.length - 2);
  // The failure summary first, because it is the more urgent fact.
  return `${head}; ${tail}`;
}
