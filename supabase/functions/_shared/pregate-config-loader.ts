// The ONE loader of the pre-gate's config: the user's search_preferences row plus the enabled
// experience_ceiling rule, mapped through the screener's own shape checks.
//
// WHY IT EXISTS: the matcher (stage 0 before scoring) and the auditor (the re-gate before a
// human, leak 1, 2026-11-05) must judge a row against the SAME config read the SAME way. They
// held two copies of these reads; a column added to one copy and not the other would let the two
// stages disagree about the same row. Both now call this function.
//
// WHY A CLOSED RESULT, NOT A THROW: supabase-js returns `{ error }`, it does not throw, and a
// failed read must never pass as "no config" (an empty config passes everything, CLAUDE.md §6).
// Each caller maps `kind: "error"` to its own 503 with the code named here.

// The gate's input shape for the three tech lists, the work-auth list and the remote policy.
import type { ScreenPreferences } from "./screen/screen-batch.ts";
// The screener's own shape checks for the three tech lists.
import { toTechGatePreferences } from "./screen/tech-gate.ts";
// The screener's shape checks for the work-auth list and the remote policy.
import { countryList, remoteLocationPolicy } from "./screen/context.ts";
// The cascade's reading of the experience_ceiling rule's config.
import { experienceCeilingMaxYears } from "./screen/required-experience.ts";

// Everything the pre-gate reads. Structurally the matcher's PreGatePreferences; spelled out here
// so _shared does not import from a function's folder.
export type LoadedPreGateConfig = ScreenPreferences & {
  // filter_rules experience_ceiling config.max_years; null = not configured (the rule keeps).
  readonly experienceMaxYears: number | null;
};

// The two config reads, or why they failed. Closed, so a failed read cannot pass as "no config".
export type LoadedPreGatePreferences =
  // Both reads succeeded.
  | { readonly kind: "ok"; readonly preferences: LoadedPreGateConfig }
  // A read failed; the code is the run's failure code, the same in both callers.
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

// Read today's gate config. Called by matcher/index.ts and auditor/index.ts.
export async function loadPreGatePreferences(db: ConfigReader): Promise<LoadedPreGatePreferences> {
  // The user's title/keyword lists, work-auth countries and remote policy. RLS scopes it.
  const prefs = await db
    // Where the screener's config lives.
    .from("search_preferences")
    // The five columns the three gates read. The policy column needs migration 20261104193000.
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
    // Unique on (user_id, rule_type), so RLS returns at most one row.
    .maybeSingle();
  // Same rule as above.
  if (ceiling.error) return { kind: "error", code: "filter_rules_unreadable", message: ceiling.error.message };
  // The row as stored, or null; the shape checks below decide what each column means.
  const row = prefs.data as Parameters<typeof toTechGatePreferences>[0];
  // Mapped through the screener's own checks, so the screener and the gates read config alike.
  return {
    // Loaded.
    kind: "ok",
    // Every field the gates read.
    preferences: {
      // The three tech lists.
      ...toTechGatePreferences(row),
      // null = never set, which keeps the work-auth gate open.
      workAuthorizedCountries: countryList((prefs.data as { work_authorized_countries?: unknown } | null)?.work_authorized_countries),
      // One of the two literals, or 'any' (fail-open).
      remoteLocationPolicy: remoteLocationPolicy((prefs.data as { remote_location_policy?: unknown } | null)?.remote_location_policy),
      // null when no enabled ceiling: no row, or config {} without max_years, keeps every job.
      experienceMaxYears: experienceCeilingMaxYears((ceiling.data as { config?: unknown } | null)?.config),
    },
  };
}
