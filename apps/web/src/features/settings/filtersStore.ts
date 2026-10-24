/* Filter cascade store & rule evaluation service.
 *
 * Implements the Filter Cascade (PROJECT_PLAN.md section 8):
 * - Evaluates rules cheapest-first (short-circuit)
 * - Restricts jobs to Tech & Software Engineering roles
 * - Enforces title blocklist, location allowlist, experience ceiling, and staleness
 * - Persists configuration to Supabase `public.filter_rules` + localStorage cache
 */

import type { FilterRuleType, JobRow } from '../../data/contract.ts';
import { supabase } from '../../data/supabase.ts';
// Type-only: lets tests inject a client whose read fails, without a network.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface FilterRuleConfig {
  readonly ruleType: FilterRuleType;
  readonly isEnabled: boolean;
  readonly config: Record<string, unknown>;
}

export const DEFAULT_FILTER_RULES: readonly FilterRuleConfig[] = [
  {
    ruleType: 'experience_ceiling',
    isEnabled: true,
    config: { max_years: 2 },
  },
  {
    ruleType: 'title_blocklist',
    isEnabled: true,
    config: {
      blocked_titles: [
        'Senior',
        'Staff',
        'Principal',
        'Lead',
        'Manager',
        'Director',
        'Architect',
        'VP',
        'Head of',
      ],
    },
  },
  {
    ruleType: 'location_allowlist',
    isEnabled: true,
    config: {
      allowed_locations: ['hyderabad', 'bangalore', 'bengaluru', 'pune', 'remote', 'india'],
    },
  },
  {
    ruleType: 'employment_type',
    isEnabled: true,
    config: {
      allowed_types: ['full_time', 'internship', 'apprenticeship', 'unknown'],
    },
  },
  {
    ruleType: 'already_applied',
    isEnabled: true,
    config: {},
  },
  {
    ruleType: 'company_blocklist',
    isEnabled: true,
    config: {},
  },
  {
    ruleType: 'staleness',
    isEnabled: true,
    config: { window_days: 7 },
  },
  {
    ruleType: 'degree_mismatch',
    isEnabled: true,
    config: {},
  },
  {
    ruleType: 'per_company_weekly_cap',
    isEnabled: true,
    config: { max_per_week: 3 },
  },
];

const LOCAL_STORAGE_KEY = 'applyy_filter_rules_cache_v1';
const TECH_ONLY_STORAGE_KEY = 'applyy_tech_roles_only_v1';

/** Non-tech role titles that must be excluded when tech constraint is active */
const NON_TECH_TITLE_PATTERNS: readonly RegExp[] = [
  /\b(sales|account exec(utive)?|business development|bdr|sdr|account manager)\b/i,
  /\b(marketing|growth marketer|seo|sem|content writer|copywriter|social media)\b/i,
  /\b(human resources|hr|recruiter|talent acquisition|people partner|talent sourcer)\b/i,
  /\b(finance|financial analyst|accountant|auditor|payroll|tax|treasury|controller)\b/i,
  /\b(legal counsel|attorney|lawyer|paralegal|compliance officer)\b/i,
  /\b(customer support|customer success|customer service|call center|helpdesk agent)\b/i,
  /\b(operations associate|administrative assistant|executive assistant|office manager|receptionist)\b/i,
  /\b(physician|nurse|clinical|pharma|biotech lab|pharmacist)\b/i,
  /\b(store manager|cashier|warehouse associate|logistics coordinator|retail associate)\b/i,
  /\b(real estate agent|property manager|underwriter)\b/i,
];

/** Positive Tech Keywords that verify technical role eligibility */
const TECH_TITLE_PATTERNS: readonly RegExp[] = [
  /\b(software|engineer|developer|dev|sde|sdet)\b/i,
  /\b(frontend|front-end|backend|back-end|fullstack|full-stack|web)\b/i,
  /\b(data engineer|data scientist|machine learning|ai|ml|nlp|computer vision)\b/i,
  /\b(devops|cloud|sre|site reliability|infrastructure|platform engineer)\b/i,
  /\b(qa|quality assurance|automation engineer|test engineer)\b/i,
  /\b(mobile developer|android|ios|react|node|python|java|golang|c\+\+|rust)\b/i,
  /\b(security engineer|cybersecurity|infosec|network engineer)\b/i,
  /\b(embedded|firmware|systems engineer|iot)\b/i,
  /\b(technical intern|engineering intern|software intern|grad(uate)? engineer)\b/i,
];

/** Check if a job is definitely a tech/engineering role */
export function isTechRole(jobTitle: string): { isTech: boolean; reason?: string } {
  const cleanTitle = (jobTitle || '').trim().toLowerCase();
  if (!cleanTitle) return { isTech: false, reason: 'Empty job title' };

  // 1. Check for disqualifying non-tech roles
  for (const pattern of NON_TECH_TITLE_PATTERNS) {
    if (pattern.test(cleanTitle)) {
      // Special exclusion: If title says "Software Engineer in Sales" or "Recruiting Software Engineer"
      // it's usually sales/recruiting, but if it starts with Software Engineer it could be ambiguous.
      // However, 99% of "Account Executive", "Sales Manager", "Marketing Intern" are purely non-tech.
      return { isTech: false, reason: `Non-tech role title matching "${pattern.source}"` };
    }
  }

  // 2. Check for positive tech match
  for (const pattern of TECH_TITLE_PATTERNS) {
    if (pattern.test(cleanTitle)) {
      return { isTech: true };
    }
  }

  // If no explicit tech keywords, classify as ambiguous/non-tech
  return { isTech: false, reason: 'Does not contain recognizable software or engineering keywords' };
}

/** Get or set Tech-only filter preference */
export function getTechOnlyPreference(): boolean {
  try {
    const val = localStorage.getItem(TECH_ONLY_STORAGE_KEY);
    return val === null ? true : val === 'true';
  } catch {
    return true;
  }
}

export function setTechOnlyPreference(enabled: boolean): void {
  try {
    localStorage.setItem(TECH_ONLY_STORAGE_KEY, String(enabled));
  } catch {
    // Local storage unavailable
  }
}

/** Read filter rules from localStorage */
export function readCachedFilterRules(): FilterRuleConfig[] {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [...DEFAULT_FILTER_RULES];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [...DEFAULT_FILTER_RULES];
  } catch {
    return [...DEFAULT_FILTER_RULES];
  }
}

/** Save filter rules to localStorage */
export function writeCachedFilterRules(rules: readonly FilterRuleConfig[]): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(rules));
  } catch {
    // Storage quota or privacy protection
  }
}

/* The last remote read's failure, or null after a successful (or no-backend) read.
 * Module state rather than a return field so `saveFilterRules` can refuse on its own:
 * the guard lives in the one function every save path crosses, not in each page. */
let lastReadError: string | null = null;

/** Why the last remote read failed, or null. Pages show it; the save path enforces it. */
export function getFilterRulesReadError(): string | null {
  // A getter, so callers cannot clear the guard by assignment.
  return lastReadError;
}

/** Load filter rules from Supabase. Defaults fill in ONLY after a successful read.
 *
 * Until 2026-10-04 a read error fell through to local cache + seed defaults, so after
 * an outage the page showed seed values as if they were the user's, and Save wrote
 * them over the real remote rows. Now a failed read returns NO rules and records the
 * error, and `saveFilterRules` refuses while it stands. */
export async function loadFilterRules(
  // Injectable for tests; production callers pass nothing and get the app client.
  client: SupabaseClient | null = supabase,
): Promise<FilterRuleConfig[]> {
  // Local cache seeds the map; remote rows (when the read succeeds) override it.
  const localRules = readCachedFilterRules();
  // Keyed by rule type so remote and default rows replace rather than duplicate.
  const ruleMap = new Map<FilterRuleType, FilterRuleConfig>();

  // Cache first; it is this browser's last save.
  for (const r of localRules) {
    // One entry per rule type.
    ruleMap.set(r.ruleType, r);
  }

  // No backend configured: local-only mode is a real mode, not a failed read.
  if (client === null) {
    // Nothing failed, so saving locally is allowed.
    lastReadError = null;
  } else {
    // Captures either a returned error or a thrown one, so both take the same path.
    let failure: string | null = null;
    // The read itself; a thrown network error is caught below.
    try {
      const { data, error } = await client
        .from('filter_rules')
        .select('*')
        .order('sort_order', { ascending: true });

      // Check the error FIRST and on its own: "errored" and "no rows" are opposite claims.
      if (error) {
        // Keep Postgres's words for the banner.
        failure = error.message;
      } else if (!Array.isArray(data)) {
        // A success with no array is not a shape we can trust as "no rows".
        failure = 'filter_rules read returned no data';
      } else {
        // Overlay each stored rule on the cache/defaults.
        for (const row of data) {
          // The stored enum value.
          const rType = row.rule_type as FilterRuleType;
          ruleMap.set(rType, {
            ruleType: rType,
            // `enabled`, NOT `is_enabled`. The column is declared `enabled` at
            // supabase/migrations/20260909234800_supporting_tables.sql:220. Reading
            // the wrong name yields undefined, the `?? true` fallback swallows it,
            // and EVERY rule renders as on regardless of what the user saved — a
            // disabled filter silently displaying as enabled.
            isEnabled: row.enabled ?? true,
            // An absent config is an empty one.
            config: (row.config as Record<string, unknown>) || {},
          });
        }
      }
    } catch (err) {
      // Thrown failures (network, CORS) are read failures too.
      failure = err instanceof Error ? err.message : String(err);
    }
    // Record the outcome either way, so a recovered read clears an old failure.
    lastReadError = failure;
    // Failed read: return nothing rather than seed values dressed as the user's.
    if (failure !== null) return [];
  }

  // Read succeeded (or no backend): any rule never stored gets its default.
  for (const def of DEFAULT_FILTER_RULES) {
    // Only fill gaps; never overwrite a stored rule.
    if (!ruleMap.has(def.ruleType)) {
      ruleMap.set(def.ruleType, def);
    }
  }

  // Map order is insertion order: cache, then remote, then defaults.
  return Array.from(ruleMap.values());
}

/** Save filter rules to Supabase and update local cache */
export async function saveFilterRules(
  rules: readonly FilterRuleConfig[],
  // Injectable for tests, same as loadFilterRules.
  client: SupabaseClient | null = supabase,
): Promise<{ ok: boolean; error?: string }> {
  // THE BLOCK. Whatever is on screen after a failed read is not the user's stored
  // configuration, so writing it would overwrite real rows with placeholders.
  // Refused before the local cache write too, so nothing at all changes.
  if (lastReadError !== null) {
    // Say why, and what fixes it.
    return {
      ok: false,
      // Includes the original read error so the cause is diagnosable from the toast.
      error: `Not saved: your filter rules failed to load (${lastReadError}), so saving would overwrite them. Reload and try again.`,
    };
  }

  // Cache first so the Discovered page sees the change even if the remote write fails.
  writeCachedFilterRules(rules);

  // Remote sync only when a backend exists.
  if (client !== null) {
    try {
      const { data: userData } = await client.auth.getUser();
      const userId = userData?.user?.id;

      let sortOrder = 0;
      for (const rule of rules) {
        sortOrder += 10;
        const payload = {
          rule_type: rule.ruleType,
          // `enabled`, NOT `is_enabled`. PostgREST rejects an unknown column, so
          // this upsert errored on every call and NOTHING a user configured on the
          // Filters page ever reached Postgres. Renamed the CLIENT to match the
          // database rather than the reverse: when two names disagree, converge on
          // the one that actually exists and never introduce a third.
          enabled: rule.isEnabled,
          config: rule.config,
          sort_order: sortOrder,
          updated_at: new Date().toISOString(),
          ...(userId ? { user_id: userId } : {}),
        };

        const { error } = await client
          .from('filter_rules')
          .upsert(payload, { onConflict: 'user_id,rule_type' });

        if (error) {
          return { ok: false, error: `Saved locally; remote warning: ${error.message}` };
        }
      }
    } catch (err) {
      return { ok: false, error: `Saved locally; remote error: ${String(err)}` };
    }
  }

  return { ok: true };
}

/**
 * Evaluates whether a discovered job satisfies:
 * 1. Tech & Engineering constraint (if techOnly is active)
 * 2. Active Filter Cascade rules (experience, title blocklist, location allowlist, etc.)
 */
/* The job fields the cascade reads, and only those (2026-10-24). A full JobRow still fits, so every
 * existing caller compiles; a narrowed row (the /discovered select, DiscoveredJob) fits too without a
 * cast, and if a rule ever reads a new field, tsc points at every caller whose select lacks it. */
export type CascadeJobFields = Pick<
  JobRow,
  // Each field below is read by one of the rules in evaluateJobMatch; add here when a rule reads more.
  'title' | 'locations' | 'location_raw' | 'work_arrangement' | 'employment_type' | 'min_experience_years' | 'requires_advanced_degree' | 'description_raw'
>;

export function evaluateJobMatch(
  job: CascadeJobFields,
  rules: readonly FilterRuleConfig[],
  techOnly: boolean = true,
): { passed: boolean; dropReason?: string } {
  // 1. Tech constraint
  if (techOnly) {
    const techCheck = isTechRole(job.title);
    if (!techCheck.isTech) {
      return { passed: false, dropReason: `Non-tech role (${techCheck.reason})` };
    }
  }

  const ruleMap = new Map(rules.map((r) => [r.ruleType, r]));

  // 2. Title Blocklist
  const titleRule = ruleMap.get('title_blocklist');
  if (titleRule?.isEnabled) {
    const blockedTerms = (titleRule.config.blocked_titles as string[]) || [];
    const jobTitleLower = (job.title || '').toLowerCase();
    for (const term of blockedTerms) {
      const trimmed = term.trim().toLowerCase();
      if (!trimmed) continue;
      // Word boundary regex for accurate matching without false positives
      const pattern = new RegExp(`\\b${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (pattern.test(jobTitleLower)) {
        return { passed: false, dropReason: `Title contains blocked term "${term}"` };
      }
    }
  }

  // 3. Location Allowlist
  const locationRule = ruleMap.get('location_allowlist');
  if (locationRule?.isEnabled) {
    const allowedLocations = (locationRule.config.allowed_locations as string[]) || [];
    if (allowedLocations.length > 0) {
      const jobLocs = [
        ...(job.locations || []),
        job.location_raw || '',
        job.work_arrangement === 'remote' ? 'remote' : '',
      ]
        .join(' ')
        .toLowerCase();

      const matchedLoc = allowedLocations.some((loc) => {
        const clean = loc.trim().toLowerCase();
        return clean.length > 0 && jobLocs.includes(clean);
      });

      if (!matchedLoc) {
        return {
          passed: false,
          dropReason: `Location "${job.location_raw || (job.locations || []).join(', ') || 'Unspecified'}" not in allowlist`,
        };
      }
    }
  }

  // 4. Experience Ceiling
  const expRule = ruleMap.get('experience_ceiling');
  if (expRule?.isEnabled) {
    const maxYears = Number(expRule.config.max_years);
    if (!isNaN(maxYears) && job.min_experience_years !== null && job.min_experience_years !== undefined) {
      const required = Number(job.min_experience_years);
      if (Number.isFinite(required) && required > maxYears) {
        return {
          passed: false,
          dropReason: `Requires ${required} yrs exp (ceiling is ${maxYears} yrs)`,
        };
      }
    }
  }

  // 5. Employment Type
  const empRule = ruleMap.get('employment_type');
  if (empRule?.isEnabled) {
    const allowedTypes = (empRule.config.allowed_types as string[]) || [];
    if (allowedTypes.length > 0 && job.employment_type && job.employment_type !== 'unknown') {
      if (!allowedTypes.includes(job.employment_type.toLowerCase())) {
        return {
          passed: false,
          dropReason: `Employment type "${job.employment_type}" not allowed`,
        };
      }
    }
  }

  // 6. Degree Mismatch
  const degreeRule = ruleMap.get('degree_mismatch');
  if (degreeRule?.isEnabled) {
    if (job.requires_advanced_degree === true) {
      return {
        passed: false,
        dropReason: "Requires an advanced degree (Master's or PhD)",
      };
    }
    const rawDesc = (job.description_raw || '').toLowerCase();
    if (
      /\b(must have a master'?s|ph\.?d\.? required|master'?s degree required|ph\.?d required)\b/i.test(
        rawDesc,
      )
    ) {
      return {
        passed: false,
        dropReason: "Job description requires Master's or PhD degree",
      };
    }
  }

  return { passed: true };
}
