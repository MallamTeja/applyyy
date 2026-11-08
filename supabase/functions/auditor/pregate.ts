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
// Teja's content rules (2026-11-08): the tailor's own gate, reused so the auditor and the tailor cannot disagree.
import { checkContentRules } from "../_shared/tailor/content-rules.ts";
// The two shapes that gate reads, checked against the real contract.
import type { MasterProfile, ResolvedResume } from "../_shared/contracts/shared-types.ts";

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

// The content-rules verdict: its own code, because it judges the RESUME, not the job, so it is not a PreGateDropCode.
export type AuditorContentRulesDrop = { readonly code: "content_rules"; readonly reason: string } | null;

// Content rules (Teja, 2026-11-08): at most 2 projects (exactly min(2, master)), each >= min(4, master bullets),
// exp_aczen >= 4, certifications >= 3, achievements >= 2, education >= 2. The tailor enforces them, but live rows
// already held 3 projects, and the web editor can save any resume, so the auditor (the last agent before a human)
// asks once more. Needs the PINNED master, because every floor is min(rule, what that master holds).
export function auditorContentRulesDrop(resume: ResolvedResume | null, master: MasterProfile | null): AuditorContentRulesDrop {
  // No resume: there is nothing to judge, which is not "compliant" (CLAUDE.md section 6). Throwing makes it a per-row
  // failure (reported, left in place); index.ts fails a missing profile with its own reason before this runs.
  if (resume === null || resume === undefined) throw new Error("auditor content rules: no resolved resume for this row");
  // No master: every floor would read as 0 and pass. Same fail-closed answer.
  if (master === null || master === undefined) throw new Error("auditor content rules: no pinned master for this row");
  // Every section the gate counts must be an array on both sides; a missing one would throw a bare TypeError or, worse,
  // read `.length` off a non-array object as undefined and compare false (a silent pass). Name the broken shape instead.
  for (const section of ["projects", "experience", "certifications", "achievements", "education"] as const) {
    // The resume side: a stored profile missing a section is damaged data, never "0 of them, fine".
    if (!Array.isArray(resume[section])) throw new Error(`auditor content rules: resume.${section} is not an array`);
    // The master side: an empty floor here would wave every resume through.
    if (!Array.isArray(master[section])) throw new Error(`auditor content rules: master.${section} is not an array`);
  }
  // The tailor's own gate; each string names one broken rule.
  const broken = checkContentRules(resume, master);
  // Compliant: no objection.
  if (broken.length === 0) return null;
  // Broken: the code the dashboard filters on, and every rule named for the human who reads the event.
  return { code: "content_rules", reason: broken.join("; ") };
}
