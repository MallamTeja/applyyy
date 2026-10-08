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

/** Append a labelled, deduped `rule_warnings:` segment to a run's existing error_detail. */
export function withRuleWarnings(detail: string | null, warnings: Iterable<string>): string | null {
  // Set: one rule skipped on 300 rows is one fact. Sorted, so the text is stable run to run.
  const distinct = [...new Set(warnings)].sort();
  // Nothing to add: return the detail untouched, so a clean run keeps a null column.
  if (distinct.length === 0) return detail;
  // Labelled segment; " | " inside it, "; " between segments, matching scout-ats.
  const segment = `rule_warnings: ${distinct.join(" | ")}`;
  // The failure summary first, because it is the more urgent fact and must survive the cap.
  const combined = detail ? `${detail}; ${segment}` : segment;
  // Capped like the other agents' summaries, so a pathological run stays a health-page line.
  return combined.slice(0, MAX_DETAIL_LENGTH);
}
