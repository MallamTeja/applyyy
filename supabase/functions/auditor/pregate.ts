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
// ponytail: loadPreGatePreferences repeats matcher/index.ts:316-361 (the same two reads and
// the same mapping). Point the matcher at this loader when that file is next touched.

// The matcher's pure verdict and its input shapes, reused rather than re-implemented.
import { firstPreGateDrop, type PreGateDropCode, type PreGatePreferences } from "../matcher/tech-pregate.ts";
// "Teja pasted this himself": such rows skip every automatic gate (the matcher's rule).
import { isHumanPicked } from "../_shared/match/score-threshold.ts";
// The screener's own shape checks for the three tech lists.
import { toTechGatePreferences } from "../_shared/screen/tech-gate.ts";
// The screener's shape checks for the work-auth list and the remote policy.
import { countryList, remoteLocationPolicy } from "../_shared/screen/context.ts";
// The cascade's reading of the experience_ceiling rule's config.
import { experienceCeilingMaxYears } from "../_shared/screen/required-experience.ts";

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

// The two config reads, or why they failed. Closed, so a failed read cannot pass as "no config".
export type LoadedPreGatePreferences =
  // Both reads succeeded.
  | { readonly kind: "ok"; readonly preferences: PreGatePreferences }
  // A read failed; the code is the run's failure code, as in the matcher.
  | { readonly kind: "error"; readonly code: "preferences_unreadable" | "filter_rules_unreadable"; readonly message: string };

// The slice of supabase-js the two reads use, so a test can stand in for it.
interface ConfigQuery {
  // Equality filter; chains.
  eq(column: string, value: unknown): ConfigQuery;
  // The terminal read: one row or none. supabase-js returns `{ error }`, it does not throw.
  maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

// The client shape: just `from(...).select(...)`.
export interface ConfigReader {
  // One table, one select.
  from(table: string): { select(columns: string): ConfigQuery };
}

// Read today's gate config exactly as the matcher reads it (matcher/index.ts:316-361).
export async function loadPreGatePreferences(db: ConfigReader): Promise<LoadedPreGatePreferences> {
  // The user's title/keyword lists, work-auth countries and remote policy. RLS scopes it.
  const prefs = await db
    // Where the screener's config lives.
    .from("search_preferences")
    // The five columns the three gates read.
    .select("titles, keywords, excluded_keywords, work_authorized_countries, remote_location_policy")
    // One row per user; none is a normal (empty) config.
    .maybeSingle();
  // A failed read stops the run: read as "no config" it would pass everything.
  if (prefs.error) return { kind: "error", code: "preferences_unreadable", message: prefs.error.message };
  // The experience ceiling, the cascade's rule. RLS scopes it.
  const ceiling = await db
    // Where the cascade's rules live.
    .from("filter_rules")
    // Only the config carries the threshold.
    .select("config")
    // The one rule this gate mirrors.
    .eq("rule_type", "experience_ceiling")
    // A disabled rule does not run in the screener, so not here either.
    .eq("enabled", true)
    // Unique on (user_id, rule_type).
    .maybeSingle();
  // Same rule as above.
  if (ceiling.error) return { kind: "error", code: "filter_rules_unreadable", message: ceiling.error.message };
  // The row as stored, or null; the shape checks below decide what each column means.
  const row = prefs.data as Parameters<typeof toTechGatePreferences>[0];
  // Mapped through the screener's own checks, as the matcher maps it.
  return {
    // Loaded.
    kind: "ok",
    // Every field the gates read.
    preferences: {
      // The three tech lists.
      ...toTechGatePreferences(row),
      // null = never set, which keeps the work-auth gate open.
      workAuthorizedCountries: countryList((prefs.data as { work_authorized_countries?: unknown } | null)?.work_authorized_countries),
      // One of the two literals, or 'any'.
      remoteLocationPolicy: remoteLocationPolicy((prefs.data as { remote_location_policy?: unknown } | null)?.remote_location_policy),
      // null when no enabled ceiling.
      experienceMaxYears: experienceCeilingMaxYears((ceiling.data as { config?: unknown } | null)?.config),
    },
  };
}
