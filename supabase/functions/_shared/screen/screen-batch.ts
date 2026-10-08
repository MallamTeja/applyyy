// The screener glue — the module that finally gives `filter/cascade.ts` a caller.
//
// THE PROBLEM IT CLOSES. The deterministic cascade has been built and tested since
// 2026-09-10 and has never run once: `screenJob` is imported by exactly one file, its
// own test. Every posting the Scout discovered therefore became a queued application,
// which is why Teja keeps seeing jobs he would never apply to. The fix was already
// written; it just had no entrypoint.
//
// WHERE THIS SITS, and why here rather than inside either scout. There are two scouts —
// `worker/src/cli/scout.ts` on the GitHub Actions cron and
// `supabase/functions/scout-ats/index.ts` on Deno — with near-identical bodies. Screener
// glue written twice would drift, and the first drift would be silent: one entrypoint
// enforcing a rule the other does not. So the logic lives in the one function both
// paths cross. A comment telling each call site to be careful is not a control.
//
// EVERYTHING HERE IS PURE — no database, no clock, no network. The caller supplies the
// rules and the context, exactly as `screenJob` itself demands, which is what makes the
// whole seam testable without a Postgres.

// The cascade under wiring, plus the two interfaces it reads.
import { screenJob, type ScreenableJob, type ScreenContext } from "../filter/cascade.ts";
// Stage 0, which runs AHEAD of the cascade rather than as a tenth rule — Teja asked that
// the cascade not change, and a title comparison is cheaper than any rule in it.
import { screenTechRole, type TechGatePreferences } from "./tech-gate.ts";
// Row shapes from the schema owner. Never redefined — a redefined type drifts.
import type { FilterRuleRow, JobInsert, JobRow } from "../contracts/shared-types.ts";

// The ONLY statuses this module may create an `applications` row at.
//
// THIS CLOSED UNION IS A SAFETY CONTROL, NOT A CONVENIENCE. The status transition guard
// (20260909234900_status_transition_guard.sql:266) is declared `before update on
// public.applications` — it does not fire on INSERT. The guard's own header calls itself
// the safety case for the whole system, and its central claim is that constraint #15,
// never submit without human approval, is unreachable by construction because every edge
// into 'approved' is human-only and 'approved -> applying' is the only edge into
// 'applying'. That claim holds for UPDATEs. It does not hold for INSERTs.
//
// So an insert helper that accepted the full `application_status` would be a way to
// manufacture a row already sitting at 'approved' or 'applying', bypassing the approval
// gate entirely. Both members below are upstream of that gate, so this module cannot
// reach it — and widening this union would be the change that opens the hole. The type
// carries the restriction the trigger cannot, which is the point: a caller must not be
// able to write the wrong thing and have it compile.
//
// UPDATED 2026-10-08: "it does not fire on INSERT" is no longer the whole story. Migration
// 20260917130000 (applied; live trigger `guard_status_insert`, BEFORE INSERT) refuses any
// inserted status outside discovered/passed_filters/dropped_filter. That checks an
// allowlist, not edges, and this union is still the narrower control for THIS module,
// since it also excludes 'discovered'. Keep both.
export type ScreenedInsertStatus = "passed_filters" | "dropped_filter";

// One `applications` row, born already carrying its verdict.
export interface ScreenedApplicationInsert {
  // The job this queues. The row is created after the jobs upsert, so the id is real.
  readonly job_id: string;
  // Deliberately the narrow union above, never `ApplicationStatus`.
  readonly status: ScreenedInsertStatus;
  // NAMES THE RULE, not the prose explanation — the contract stated at cascade.ts:78
  // and status-flow.ts:81, so the dashboard can group drops by cause. Null on the
  // passing path, where there is no cause to name.
  readonly drop_reason: string | null;
}

// One job the Scout has already persisted, paired with the row it was built from.
// The row is what the cascade reads; the id is what the application links to.
export interface ScreenableEntry {
  readonly jobId: string;
  readonly row: JobInsert | JobRow;
}

// One dropped posting, kept for the run summary.
//
// SEPARATE FROM THE INSERT because the two carry different things: `drop_reason` on the
// row names the rule so it can be grouped, while this prose says WHY this particular
// job matched it. A surprising drop is diagnosable only from the prose, and it would be
// lost if the summary only had the rule name.
export interface DroppedJob {
  readonly jobId: string;
  readonly title: string;
  readonly ruleType: string;
  readonly reason: string;
}

// Everything one screened batch produced.
export interface ScreenedBatchPlan {
  // Every job gets a row — passed or dropped. A drop is RECORDED, never omitted, or the
  // dashboard could not explain why a posting visible in `jobs` never reached the queue.
  readonly inserts: readonly ScreenedApplicationInsert[];
  // The dropped ones with their prose, for the run summary.
  readonly dropped: readonly DroppedJob[];
  // Misconfigurations, accumulated rather than thrown: a broken rule must be visible
  // without stopping the other eight from protecting the quota.
  readonly warnings: readonly string[];
  // Counters, because a screener that drops nothing and a screener that was never called
  // look identical from outside. These are what make the difference observable.
  readonly passedCount: number;
  readonly droppedCount: number;
}

// Adapt a row the Scout or Screener runner reads into the narrow shape the cascade reads.
//
// A NARROW INTERFACE IS WHY THIS FUNCTION EXISTS AT ALL: `ScreenableJob` documents the
// Screener's real dependency surface, so the bridge has to be explicit. Getting a field
// name wrong here would not throw — it would hand a rule `undefined` and quietly make it
// pass everything, which is the failure mode this whole parcel is cleaning up.
export function toScreenableJob(row: JobInsert | JobRow): ScreenableJob {
  // Read min_experience_years if available (numeric or null), formatted as string for cascade.
  const minExp = row.min_experience_years !== undefined && row.min_experience_years !== null
    ? String(row.min_experience_years)
    : null;
  // Read requires_advanced_degree if available (boolean or null).
  const reqAdvDeg = row.requires_advanced_degree ?? null;

  return {
    // UNTRUSTED, straight from the board. What the title blocklist matches on.
    title: row.title,
    // The normalised join key for the blocklist and the weekly cap.
    companySlug: row.company_slug,
    // Always `[]` from `toJobInsert` today — splitting locations is the Normalizer's
    // job. `?? []` because the column is NOT NULL with a `'{}'` default.
    locations: row.locations ?? [],
    // THE FALLBACK THAT CARRIES THE LOCATION RULE TODAY. With `locations` empty, the
    // allowlist matches against this raw string instead.
    locationRaw: row.location_raw ?? null,
    // Internship / full_time / unknown.
    employmentType: row.employment_type ?? "unknown",
    // Experience years requirement parsed from job record, or null when absent/unknown.
    minExperienceYears: minExp,
    // Advanced degree requirement flag from job record, or null when absent/unknown.
    requiresAdvancedDegree: reqAdvDeg,
    // NOT NULL by schema, so no fallback is needed or wanted.
    postedAt: row.posted_at,
    // How much to believe that date.
    postedAtSource: row.posted_at_source ?? "unknown",
    // The dedupe key, checked against what has already been applied to.
    fingerprint: row.fingerprint,
  };
}

// Screen one batch and decide what each job's `applications` row should be born as.
//
// WHY THE ROW IS BORN AT ITS VERDICT rather than inserted at 'discovered' and then
// transitioned: the legal source state for both screener edges is 'deduped', and the only
// edge into it is discovered -> deduped, whose sole agent is 'normalizer'. The Normalizer
// exists as its own function (supabase/functions/normalizer/index.ts advances discovered
// -> deduped), but it runs separately. An insert-then-update design here would make the
// scout impersonate it, or wait for it, just to reach a verdict already in hand. It would
// also be manufacturing a 'discovered' moment that never meaningfully existed. INSERTs
// are allowlisted to discovered/passed_filters/dropped_filter (20260917130000), and
// ScreenedInsertStatus (:44) keeps this module to the last two. Corrected 2026-10-08:
// this previously said nothing writes 'deduped' and that the Normalizer does not exist.
// A posting the title blocklist rejected was never a candidate application; creating the
// row already carrying its verdict is the truer record. See docs/screener/.
export function planScreenedApplications(
  entries: readonly ScreenableEntry[],
  rules: readonly FilterRuleRow[],
  context: ScreenContext,
  // REQUIRED, NOT OPTIONAL, and that is deliberate. An optional parameter would let a
  // caller omit the gate and silently screen without stage 0 — the wrong answer has to
  // be unrepresentable, not merely discouraged. An open gate is expressed by passing
  // empty preferences, which is a decision a reader can see at the call site.
  preferences: TechGatePreferences,
): ScreenedBatchPlan {
  // Accumulators. Built as mutable locals and returned as readonly, so a caller cannot
  // reach back in and edit a plan after it was decided.
  const inserts: ScreenedApplicationInsert[] = [];
  const dropped: DroppedJob[] = [];
  // A Set, because nine rules over fifty jobs would otherwise repeat the same
  // "title_blocklist has no blocked_titles configured" fifty times and bury the signal.
  const warnings = new Set<string>();

  // One pass over the batch; the cascade short-circuits internally on the first drop.
  for (const entry of entries) {
    // STAGE 0, FIRST, because it is the cheapest test in the whole pipeline — a string
    // comparison against the title, with no date parsing, no numeric coercion and no
    // database lookup. Cheapest-first is the cascade's own organising principle applied
    // one level up.
    const techVerdict = screenTechRole(entry.row.title, entry.row.description_raw ?? null, preferences);
    // An unclassified title warns and passes. Collected regardless of the verdict, since
    // the warning is the only signal that the gate had no opinion about a posting.
    if ("warning" in techVerdict) warnings.add(techVerdict.warning);

    // A stage-0 rejection short-circuits the cascade entirely.
    if (techVerdict.drop) {
      // `drop_reason` NAMES THE STAGE rather than one of the nine rules. Stage 0 is
      // deliberately outside the cascade, so attributing its drop to a `FilterRuleType`
      // would be a lie the dashboard would then repeat back to Teja.
      inserts.push({ job_id: entry.jobId, status: "dropped_filter", drop_reason: "tech_gate" });
      dropped.push({ jobId: entry.jobId, title: entry.row.title, ruleType: "tech_gate", reason: techVerdict.reason });
      continue;
    }

    // Bridge to the narrow interface, then run every enabled rule in `sort_order`.
    const outcome = screenJob(toScreenableJob(entry.row), rules, context);

    // Collect misconfigurations regardless of the verdict — a rule can warn and still
    // pass the job, which is exactly what an unconfigured rule does.
    for (const warning of outcome.warnings) warnings.add(warning);

    // The passing path: on to the Matcher, and only now does anything cost a Gemini call.
    if (outcome.passed) {
      inserts.push({ job_id: entry.jobId, status: "passed_filters", drop_reason: null });
      continue;
    }

    // The dropping path. The row is still created, carrying the rule that rejected it.
    inserts.push({ job_id: entry.jobId, status: "dropped_filter", drop_reason: outcome.ruleType });
    // And the prose is kept separately, because it is the only thing that explains WHY
    // this particular posting matched that rule.
    dropped.push({
      jobId: entry.jobId,
      title: entry.row.title,
      ruleType: outcome.ruleType,
      reason: outcome.reason,
    });
  }

  return {
    inserts,
    dropped,
    warnings: [...warnings],
    // Derived rather than counted separately, so the two can never disagree with the
    // rows actually planned.
    passedCount: inserts.length - dropped.length,
    droppedCount: dropped.length,
  };
}
