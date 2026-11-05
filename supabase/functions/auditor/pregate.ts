// The auditor's re-run of the matcher's pre-gate (leak 1, 2026-11-05).
//
// WHY IT EXISTS: the gates only ran at the screener and the matcher, so a row that passed the
// matcher under an OLDER gate was never judged again. Cohere 4d0680ee ("Middle East") passed
// before the work-auth gate had a region table, and reached Teja's approved list on 11-05. The
// auditor is the last agent before a human, so it asks the same question once more for every
// `tailored` row, using the matcher's own pure verdict (firstPreGateDrop) and today's config.
//
// WHY `failed`, NOT `dropped_filter`: the live transition graph gives the auditor exactly one
// way off `tailored` besides the two audit verdicts: `tailored -> failed` (auditor, human).
// There is no auditor edge into dropped_filter, and adding one needs a migration; `failed`
// carries the gate's code in the event detail and a human can still send the row back
// (failed -> passed_filters, human).
//
// The config these gates read is loaded by _shared/pregate-config-loader.ts, the same loader
// the matcher calls, so the two stages cannot read it differently.

// The matcher's pure verdict and its input shapes, reused rather than re-implemented.
import { firstPreGateDrop, type PreGateDropCode, type PreGatePreferences } from "../matcher/tech-pregate.ts";
// "Teja pasted this himself": such rows skip every automatic gate (the matcher's rule).
import { isHumanPicked } from "../_shared/match/score-threshold.ts";

// The embedded `jobs(...)` the auditor's queue read selects for each row.
export interface AuditorJobEmbed {
  // The posting title.
  readonly title: string | null;
  // The raw JD.
  readonly description_raw: string | null;
  // The board's location string.
  readonly location_raw: string | null;
  // PostgREST sends numerics as strings; null on every live row today.
  readonly min_experience_years: number | string | null;
  // How the job was found; "manual" means pasted by Teja.
  readonly discovered_via: unknown;
}

// The verdict for one row: the gate's objection, or null when there is none.
export type AuditorPreGateDrop = { readonly code: PreGateDropCode; readonly reason: string } | null;

// Re-judge one tailored row's job with today's gates.
export function auditorPreGateDrop(job: AuditorJobEmbed | null, preferences: PreGatePreferences): AuditorPreGateDrop {
  // No job means the gate cannot judge. Throwing makes the row a per-row failure (left in
  // place, reported) instead of a silent pass into the human queue (CLAUDE.md §6).
  if (job === null) throw new Error("auditor pre-gate: no job embed for this row");
  // Teja chose it himself; the matcher skips these rows for the same reason.
  if (isHumanPicked(job.discovered_via)) return null;
  // The matcher's verdict, fed the same four fields the matcher maps (matcher/index.ts:529-553).
  return firstPreGateDrop({
    // An absent title is "", as in the matcher.
    title: job.title ?? "",
    // Absent body: the gates read nothing, which keeps the row.
    descriptionRaw: job.description_raw,
    // Absent location: the work-auth gate keeps the row.
    locationRaw: job.location_raw,
    // Absent years: the experience gate falls back to the JD parser.
    minExperienceYears: job.min_experience_years,
  }, preferences);
}
