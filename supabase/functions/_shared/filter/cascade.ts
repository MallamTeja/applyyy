// The filter cascade — PROJECT_PLAN.md §8.
//
// WHAT THIS BUYS, in one line: 400 jobs discovered in a morning become ~40, so the
// Matcher makes 40 Gemini calls instead of 400. And it COMPOUNDS — the Tailor and the
// Auditor also only ever see the 40, so it is a 10× saving on three agents, not one.
// This is the single reason six free Gemini keys are sufficient rather than merely
// hopeful, and it is why the Screener deliberately has NO LLM: deterministic filters
// must run before anything costs a call.
//
// THE PATTERN IS A CASCADE (short-circuit, cheap-test-first): order the tests by cost,
// run the cheapest first, and let each stage shrink the input for the next. Search
// engines rank this way — a cheap scorer over a million documents, an expensive one
// over the surviving hundred. A title check that costs a millisecond and rejects
// "Senior Backend Engineer" without ever parsing the description is worth more than
// any amount of cleverness applied later.
//
// EVERY THRESHOLD COMES FROM `filter_rules`. NOTHING IS HARDCODED. That is not
// tidiness — §8 says "every row is a settings field you control", and a constant
// buried here is a setting Teja cannot reach from the dashboard. The evaluation ORDER
// also comes from the database (`sort_order`), so re-ordering the cascade is a
// settings change rather than a deploy.

// Row and enum shapes from the schema owner. Never redefined — a redefined type does
// not fail, it drifts.
import type { FilterRuleRow, FilterRuleType, Json, PostedAtSource } from "../contracts/shared-types.ts";

// Exactly the job columns the Screener reads.
//
// A NARROW INTERFACE RATHER THAN `JobRow` ON PURPOSE: it documents the Screener's real
// dependency surface, and it makes every test in this module a small object literal
// instead of a forty-field fixture. If a future filter needs a new column, adding it
// here is a visible change to what the Screener depends on.
export interface ScreenableJob {
  // Matched against the title blocklist.
  readonly title: string;
  // Joined against the company blocklist (the weekly cap that also read it was retired 2026-11-10).
  readonly companySlug: string;
  // Parsed locations, matched against the allowlist.
  readonly locations: readonly string[];
  // Kept because a board that gave no parsed locations may still have prose worth
  // matching — dropping a remote job because the parser missed "Remote" would be a
  // filter bug presenting as a supply problem.
  readonly locationRaw: string | null;
  // Internship / full_time / … matched against the allowed set.
  readonly employmentType: string;
  // Years the JD demands. Numeric columns arrive from PostgREST as strings.
  readonly minExperienceYears: string | null;
  // True when the JD requires a Master's or PhD. NULL means the parser could not tell.
  readonly requiresAdvancedDegree: boolean | null;
  // When it went up, and how much to believe that.
  readonly postedAt: string;
  readonly postedAtSource: PostedAtSource;
  // The dedupe key, checked against what has already been applied to.
  readonly fingerprint: string;
}

// Everything a rule needs that is not a property of the job itself. Passed in rather
// than queried here, because this module is pure — no database, no clock, no network —
// which is what makes the whole cascade table-driven testable (§19).
export interface ScreenContext {
  // The run's clock, injected so "posted more than 3 days ago" is assertable rather
  // than flaky at midnight.
  readonly now: Date;
  // Fingerprints already in the application history. A cheap pre-check ahead of the
  // `UNIQUE(user_id, job_id)` constraint — the constraint is the real guarantee, this
  // just avoids spending a Gemini call to discover it.
  readonly appliedFingerprints: ReadonlySet<string>;
  // Company slugs currently blocked.
  readonly blockedCompanySlugs: ReadonlySet<string>;
  // (applicationsThisWeekByCompany was here, for the per-company weekly cap: removed 2026-11-10 with that rule, so no
  // code path can count applications per company again. See retiredRule.)
}

// The verdict on one job.
export type ScreenOutcome =
  // Survived every enabled rule. On to the Matcher, and only now does anything cost.
  | { readonly passed: true; readonly warnings: readonly string[] }
  // Dropped. `ruleType` is what the row's `drop_reason` records, so the dashboard can
  // say WHICH rule rejected it rather than just that something did.
  | { readonly passed: false; readonly ruleType: FilterRuleType; readonly reason: string; readonly warnings: readonly string[] };

// What one rule decides. Kept separate from `ScreenOutcome` so a rule cannot
// accidentally report on the whole cascade.
type RuleVerdict =
  // This rule has no objection.
  | { readonly drop: false }
  // This rule rejects the job, with a human-readable reason.
  | { readonly drop: true; readonly reason: string }
  // This rule could not be evaluated — its config is missing or malformed.
  //
  // A THIRD OUTCOME IS DELIBERATE, AND THE DIRECTION IT FAILS IN IS THE DECISION.
  // A misconfigured rule must NOT drop the job: dropping on misconfiguration loses
  // jobs invisibly, and Teja would experience it as "the system found nothing today"
  // with no error anywhere. Passing instead costs at most a few Gemini calls and
  // surfaces as a warning on the health page. **Fail toward the visible failure.**
  | { readonly drop: false; readonly warning: string };

// Read a number out of a rule's JSON config. Returns null when absent or unusable, so
// the caller can report a misconfiguration rather than invent a threshold.
function configNumber(config: Json, key: string): number | null {
  // A non-object config cannot carry named settings.
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  // The value under the key.
  const raw = (config as Record<string, Json>)[key];
  // A genuine finite number is the expected case.
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  // Accept a numeric string too: a settings form that posts strings should not
  // silently disable a filter.
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  // Absent or unusable.
  return null;
}

// Read a boolean out of a rule's config, with an explicit default supplied by the
// caller. The default is passed in rather than assumed here so it is visible at the
// call site — a policy default buried in a helper is a policy nobody can find.
function configBoolean(config: Json, key: string, fallback: boolean): boolean {
  // Non-object config.
  if (typeof config !== "object" || config === null || Array.isArray(config)) return fallback;
  // The value.
  const raw = (config as Record<string, Json>)[key];
  // Only a genuine boolean overrides the default.
  return typeof raw === "boolean" ? raw : fallback;
}

// Read a list of strings out of a rule's config, lower-cased for matching. Returns
// null when absent so an unset list is distinguishable from a deliberately empty one —
// they mean opposite things for an allowlist.
function configStringList(config: Json, key: string): readonly string[] | null {
  // Non-object config.
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  // The value.
  const raw = (config as Record<string, Json>)[key];
  // Must be an array to be a list.
  if (!Array.isArray(raw)) return null;
  // Keep genuine non-empty strings, folded for case-insensitive matching.
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim().toLowerCase());
}

// --- the rules ------------------------------------------------------------------
//
// Each is a pure function of (job, config, context). They are deliberately small and
// independent: a rule cannot see another rule's verdict, so no rule can be quietly
// load-bearing for another — the mutation-testing failure mode that bit two other
// streams today.

// The JD demands more years than Teja has. §8's headline example.
function experienceCeiling(job: ScreenableJob, config: Json): RuleVerdict {
  // The threshold is a setting, never a constant.
  const maxYears = configNumber(config, "max_years");
  // No threshold configured: report rather than invent one.
  if (maxYears === null) return { drop: false, warning: "experience_ceiling has no max_years configured" };
  // The JD's demand. Absent means the parser could not find one — warn transparently.
  if (job.minExperienceYears === null) return { drop: false, warning: "experience_ceiling skipped: min_experience_years is missing/null in JD" };
  // Numeric columns arrive as strings from PostgREST.
  const required = Number(job.minExperienceYears);
  // AN UNPARSEABLE VALUE MUST NOT DROP THE JOB. `Number("")` is 0 and `Number("abc")`
  // is NaN, and a NaN comparison is always false — which would pass silently anyway.
  // Making it explicit means the intent is readable rather than accidental.
  if (!Number.isFinite(required)) return { drop: false, warning: "experience_ceiling skipped: min_experience_years is unparseable" };
  // Drop only when the JD genuinely demands more than the ceiling.
  return required > maxYears ? { drop: true, reason: `JD requires ${required} years, ceiling is ${maxYears}` } : { drop: false };
}

// Build the matcher for one blocked title term.
//
// TWO THINGS GO WRONG HERE AND THEY PULL IN OPPOSITE DIRECTIONS, which is why this is
// its own function rather than an inline regex.
//
// 1. A BARE SUBSTRING MATCH OVER-DROPS. `includes("lead")` correctly rejects "Team
//    Lead" and wrongly rejects "Leadership Development Intern" and "Lead Generation
//    Intern" — silently, presenting as thin supply rather than as a filter bug.
//
// 2. AN UNCONDITIONAL `\b` UNDER-DROPS, and this one is genuinely subtle. `\b` marks a
//    transition between a word and a non-word character, so `\bc\+\+\b` can NEVER
//    match "C++ Developer": after the "++" comes a space, and two non-word characters
//    in a row are not a boundary. A blocklist entry of "c++", ".net", "c#" or "node.js"
//    would therefore never fire — the rule would look configured and do nothing, which
//    is the worse failure of the two because it is invisible from the settings page.
//
// So the boundary is applied CONDITIONALLY, on each end independently, according to
// whether the term's own edge character is a word character. "senior" gets both
// boundaries and stops matching "seniority"; "c++" gets a leading boundary only and
// still matches "C++ Developer" without matching "ABC++".
function blockedTitlePattern(word: string): RegExp {
  // Escape every regex metacharacter so a term from the settings page is matched as
  // literal text and cannot compile into a pattern — or throw.
  const literal = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A leading boundary is only meaningful when the term STARTS with a word character.
  const leading = /^\w/.test(word) ? "\\b" : "";
  // Likewise a trailing boundary, tested against the term's LAST character.
  const trailing = /\w$/.test(word) ? "\\b" : "";
  // Case-insensitive because recruiters do not agree on casing.
  return new RegExp(`${leading}${literal}${trailing}`, "i");
}

// Senior, Staff, Principal, Lead, Manager, Architect — the §8 list, but from config.
function titleBlocklist(job: ScreenableJob, config: Json): RuleVerdict {
  // The blocked words are a setting.
  const blocked = configStringList(config, "blocked_titles");
  // Unset list: nothing to match against.
  if (blocked === null) return { drop: false, warning: "title_blocklist has no blocked_titles configured" };
  // Fold the title once.
  const title = job.title.toLowerCase();
  // WORD-BOUNDARY MATCHING, NOT SUBSTRING. A bare `includes("lead")` drops "Team Lead"
  // correctly and "Lead Generation Intern" and "Leadership Program" wrongly — and it
  // would do it silently, presenting as thin supply rather than as a filter bug.
  const hit = blocked.find((word) => blockedTitlePattern(word).test(title));
  // Report which word matched, so a surprising drop is diagnosable.
  return hit === undefined ? { drop: false } : { drop: true, reason: `title contains blocked term "${hit}"` };
}

// Hyderabad, Bangalore, Remote — nothing else.
function locationAllowlist(job: ScreenableJob, config: Json): RuleVerdict {
  // The allowed locations are a setting.
  const allowed = configStringList(config, "allowed_locations");
  // AN UNSET ALLOWLIST AND AN EMPTY ONE MEAN OPPOSITE THINGS. Unset is "not
  // configured" and must not drop anything; empty is "nothing is allowed" and would
  // drop everything. Collapsing them would turn a missing setting into a total
  // blackout that looks like the pipeline stalling.
  if (allowed === null) return { drop: false, warning: "location_allowlist has no allowed_locations configured" };
  // An explicitly empty list is honoured as configured.
  if (allowed.length === 0) return { drop: true, reason: "allowlist is empty, so no location is permitted" };
  // Match against the parsed locations AND the raw string. The raw fallback matters:
  // dropping a genuinely remote job because the location parser missed "Remote" would
  // be a parser bug presenting as a supply problem.
  const haystack = [...job.locations, job.locationRaw ?? ""].join(" ").toLowerCase();
  // Any allowed location appearing anywhere in that text is enough.
  const hit = allowed.some((location) => haystack.includes(location));
  // Report the location we actually saw, so a wrong drop is diagnosable.
  return hit ? { drop: false } : { drop: true, reason: `location "${job.locationRaw ?? job.locations.join(", ")}" is not on the allowlist` };
}

// Internship / full-time / both, as configured.
function employmentType(job: ScreenableJob, config: Json): RuleVerdict {
  // The permitted types are a setting.
  const allowed = configStringList(config, "allowed_types");
  // Unset means unconfigured, not "none permitted".
  if (allowed === null) return { drop: false, warning: "employment_type has no allowed_types configured" };
  // An explicitly empty list is honoured.
  if (allowed.length === 0) return { drop: true, reason: "no employment type is permitted" };
  // `unknown` MUST NOT BE DROPPED. The adapters deliberately decline to guess when a
  // board says nothing (constraint #4's instinct applied to parsing), and dropping on
  // that non-answer would punish honest parsing — the boards that report nothing are
  // not the boards with worse jobs.
  if (job.employmentType === "unknown") return { drop: false };
  // Otherwise the type must be on the list.
  return allowed.includes(job.employmentType.toLowerCase())
    ? { drop: false }
    : { drop: true, reason: `employment type "${job.employmentType}" is not permitted` };
}

// Already applied. A cheap pre-check ahead of the database constraint.
function alreadyApplied(job: ScreenableJob, _config: Json, context: ScreenContext): RuleVerdict {
  // THE DATABASE IS THE REAL GUARANTEE — `UNIQUE(user_id, job_id)` is constraint #7 as
  // a constraint, and it is what survives a race between two runs. This check exists
  // only to avoid spending a Gemini call to discover something we already know.
  return context.appliedFingerprints.has(job.fingerprint)
    ? { drop: true, reason: "already applied to this posting" }
    : { drop: false };
}

// Consultancies, staffing firms, companies that ghosted.
function companyBlocklist(job: ScreenableJob, _config: Json, context: ScreenContext): RuleVerdict {
  // Joined on the slug, which is why the slug is normalised at insert time rather
  // than matched fuzzily here.
  return context.blockedCompanySlugs.has(job.companySlug)
    ? { drop: true, reason: `company "${job.companySlug}" is blocklisted` }
    : { drop: false };
}

// RETIRED RULES: staleness (job age) and per_company_weekly_cap. Teja, 2026-11-10 11:31 IST: the cap "remove it"; age
// "dont ever skip even though they are 1 mon 2 mont old". Both used to drop: staleness by posted_at against window_days,
// and EVERY posted_at_source = 'unknown' job by default; the cap by a trailing-week count per company. Now neither can
// drop or warn, whatever a live row's config says.
// Why a no-drop function and not a deleted key: Postgres cannot drop an enum value, so 'staleness' and
// 'per_company_weekly_cap' stay in filter_rule_type, and RULE_IMPLEMENTATIONS below is keyed by that enum (a missing
// key is a compile error, by design). The rows are deleted and the seed no longer creates them (migration
// 20261110120000); this function is the code-side guarantee for any row that survives or comes back.
// No warning either: an unconfigured live row would otherwise put one warning per job into agent_runs.error_detail.
function retiredRule(): RuleVerdict {
  // Never a drop, never a warning.
  return { drop: false };
}

// The JD requires a Master's or PhD.
function degreeMismatch(job: ScreenableJob, config: Json): RuleVerdict {
  // Whether Teja holds an advanced degree is a setting, not an assumption baked in
  // here — the same code must be correct for him after a Master's.
  const hasAdvancedDegree = configBoolean(config, "candidate_has_advanced_degree", false);
  // Nothing to enforce if he does.
  if (hasAdvancedDegree) return { drop: false };
  // NULL means the parser could not tell, and declining to guess beats dropping on a
  // non-answer — report a warning so configured rules are transparently evaluated.
  if (job.requiresAdvancedDegree === null) return { drop: false, warning: "degree_mismatch skipped: requires_advanced_degree is missing/null in JD" };
  // When explicitly false or not true, no advanced degree is required.
  if (job.requiresAdvancedDegree !== true) return { drop: false };
  // A genuine requirement he does not meet.
  return { drop: true, reason: "JD requires an advanced degree" };
}

// The rule table. Keyed by the enum so a new `FilterRuleType` is a compile error here
// until it has an implementation — which is what stops a rule existing in the database
// and silently doing nothing.
const RULE_IMPLEMENTATIONS: Readonly<Record<FilterRuleType, (job: ScreenableJob, config: Json, context: ScreenContext) => RuleVerdict>> = {
  experience_ceiling: experienceCeiling,
  title_blocklist: titleBlocklist,
  location_allowlist: locationAllowlist,
  employment_type: employmentType,
  already_applied: alreadyApplied,
  company_blocklist: companyBlocklist,
  // Retired 2026-11-10 (Teja): age never skips a job. Kept as a key because the enum value cannot be dropped.
  staleness: retiredRule,
  degree_mismatch: degreeMismatch,
  // Retired 2026-11-10 (Teja): no per-company cap. Kept as a key because the enum value cannot be dropped.
  per_company_weekly_cap: retiredRule,
};

// Run the cascade over one job.
//
// SHORT-CIRCUITS ON THE FIRST DROP, which is the entire economic point: a job rejected
// by the title check never has its description examined, never has its date parsed,
// and never reaches the Matcher. The saving is not the CPU — it is the Gemini call
// that consequently never happens, three times over.
export function screenJob(job: ScreenableJob, rules: readonly FilterRuleRow[], context: ScreenContext): ScreenOutcome {
  // Misconfigurations accumulate rather than aborting: a broken rule must be visible
  // without stopping the other live rules (seven since the two retirements of 2026-11-10) from protecting the quota.
  const warnings: string[] = [];
  // ORDER COMES FROM THE DATABASE. `sort_order` is the cascade's shape, so re-ordering
  // the cheap tests ahead of the expensive ones is a settings change, not a deploy.
  // Copied before sorting because the caller's array must not be mutated — an
  // in-place sort of a shared array is the kind of side effect that shows up three
  // modules away.
  const ordered = [...rules].sort((left, right) => left.sort_order - right.sort_order);
  // Evaluate in order.
  for (const rule of ordered) {
    // A disabled rule is skipped entirely. That is how the settings page turns a
    // filter off, so it must be honoured before anything else about the rule is read.
    if (!rule.enabled) continue;
    // Look up the implementation.
    const implementation = RULE_IMPLEMENTATIONS[rule.rule_type];
    // A rule type with no implementation would silently do nothing, so it is reported.
    // Reachable only if the database gains an enum value the code has not caught up
    // with — exactly the drift SCHEMA_CONTRACT §9's checklist exists to prevent.
    if (implementation === undefined) {
      warnings.push(`no implementation for rule "${rule.rule_type}"`);
      continue;
    }
    // Run it.
    const verdict = implementation(job, rule.config, context);
    // Collect a misconfiguration without letting it drop the job.
    if ("warning" in verdict) warnings.push(verdict.warning);
    // THE SHORT-CIRCUIT. First drop wins, and nothing after it runs.
    if (verdict.drop) return { passed: false, ruleType: rule.rule_type, reason: verdict.reason, warnings };
  }
  // Survived everything enabled. Only now is this job worth a Gemini call.
  return { passed: true, warnings };
}
