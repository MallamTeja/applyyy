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
// The one builder of a posting's ATS identity key (2026-11-18, pending #5), so already_applied compares keys made the same way.
import { atsJobKeyOf } from "../filter/cascade.ts";
// Stage 0, which runs AHEAD of the cascade rather than as a tenth rule — Teja asked that
// the cascade not change, and a title comparison is cheaper than any rule in it.
import { screenTechRole, type TechGatePreferences } from "./tech-gate.ts";
// Stage 0b, the work-authorisation gate: same outside-the-cascade placement, same reason.
import { ashbyLocationFields, boardLocationHints, screenWorkAuth, type RemoteLocationPolicy } from "./work-auth-gate.ts";
// The JD's required years, the producer the cascade's experience_ceiling rule never had (11-04).
import { requiredExperienceYears } from "./required-experience.ts";
// Stage 0c, the required-language gate (2026-11-23).
import { screenLanguage } from "./language-gate.ts";
// The one "is this JD thin?" rule (round 4, 2026-11-21), shared with the web's "No description" pill.
import { isThinDescription } from "./jd-substance.ts";
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
// UPDATED 2026-11-12: 'discovered' joins, for HELD rows only (a blank description the gate could not reject, Teja
// via the orchestrator, plan B). It is still upstream of the approval gate and inside the insert guard's allowlist, so
// the hole described above stays closed. Every reader of this union must now say what it does with a held row:
// the scouts insert it as is; the screener (screener/queue.ts) leaves the row where it is.
// UPDATED 2026-11-21 (round 7; corrects a W1 comment that said nothing produces 'discovered'): the PLANNER never
// emits it (no hold since 2026-11-18), and its own type below now cannot hold it. The scouts' UNSCREENED FALLBACK
// still inserts it when the screen context fails to load (scout-ats/index.ts, worker cli/scout.ts, scout/remote-run.ts),
// so this wider union stays for that insert path, and only there.
export type ScreenedInsertStatus = PlannedInsertStatus | "discovered";

// What the PLANNER may decide (round 7, 2026-11-21): a pass or a drop, nothing else. A closed union, so a planner row
// at 'discovered' is a compile error, not a comment (CLAUDE.md section 6); the screener maps it to a verdict with no
// "hold" branch to fall into.
export type PlannedInsertStatus = "passed_filters" | "dropped_filter";

// One planned `applications` row, born already carrying its verdict: what planScreenedApplications returns.
export interface PlannedApplicationInsert {
  // The job this queues. The row is created after the jobs upsert, so the id is real.
  readonly job_id: string;
  // The planner's two verdicts only.
  readonly status: PlannedInsertStatus;
  // NAMES THE RULE (see ScreenedApplicationInsert.drop_reason); null on a pass.
  readonly drop_reason: string | null;
}

// COMPILE-TIME PROOF that the planner type cannot hold 'discovered'. Type-only (no runtime code); deno check covers this
// file (test files are excluded from it), so if 'discovered' is ever added to PlannedInsertStatus the directive below
// goes unused and the check FAILS. Extends<A, B> compiles only when A is assignable to B.
type Extends<A extends B, B> = A;
// @ts-expect-error 'discovered' is not a PlannedInsertStatus: the planner cannot produce a held row.
type _PlannerCannotHoldDiscovered = Extends<"discovered", PlannedInsertStatus>;

// One `applications` row as a SCOUT inserts it: a planned row, or the unscreened fallback at 'discovered'.
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

// Both stage-0 gates' config, loaded together from one `search_preferences` row.
//
// AN EXTENSION, NOT AN EDIT, OF TechGatePreferences: the matcher's tech pre-gate reads only
// the three tech lists, and widening that type would force a work-auth list on a caller
// that has no use for it. `workAuthorizedCountries` is REQUIRED (not optional) so every
// screening caller must state it; null is the explicit "never set", which keeps the gate open.
export interface ScreenPreferences extends TechGatePreferences {
  // Countries the user may work in without a visa; null = never set (gate open).
  readonly workAuthorizedCountries: readonly string[] | null;
  // What a remote part means (Teja, 2026-11-04). REQUIRED like the list above, so no caller can
  // screen without stating it; 'any' is the explicit 10-24 reading.
  readonly remoteLocationPolicy: RemoteLocationPolicy;
  // The languages the user can work in (2026-11-23). REQUIRED like the two above, so no caller screens without
  // stating it; null = never set, which opens the language gate.
  readonly spokenLanguages: readonly string[] | null;
}

// Everything one screened batch produced.
export interface ScreenedBatchPlan {
  // Every job gets a row — passed or dropped. A drop is RECORDED, never omitted, or the
  // dashboard could not explain why a posting visible in `jobs` never reached the queue.
  // The planner's type (round 7): a pass or a drop, never 'discovered'.
  readonly inserts: readonly PlannedApplicationInsert[];
  // The dropped ones with their prose, for the run summary.
  readonly dropped: readonly DroppedJob[];
  // Misconfigurations, accumulated rather than thrown: a broken rule must be visible
  // without stopping the other eight from protecting the quota.
  readonly warnings: readonly string[];
  // Counters, because a screener that drops nothing and a screener that was never called
  // look identical from outside. These are what make the difference observable.
  readonly passedCount: number;
  readonly droppedCount: number;
  // NO held/heldCount (deleted 2026-11-21, W1): they counted blank-description rows parked at 'discovered' (the
  // 2026-11-12 hold). Since 2026-11-18 such a row is born passed_filters, so passedCount + droppedCount cover the batch.
}

// Adapt a row the Scout or Screener runner reads into the narrow shape the cascade reads.
//
// A NARROW INTERFACE IS WHY THIS FUNCTION EXISTS AT ALL: `ScreenableJob` documents the
// Screener's real dependency surface, so the bridge has to be explicit. Getting a field
// name wrong here would not throw — it would hand a rule `undefined` and quietly make it
// pass everything, which is the failure mode this whole parcel is cleaning up.
export function toScreenableJob(row: JobInsert | JobRow): ScreenableJob {
  // Read min_experience_years if available (numeric or null), formatted as string for cascade.
  const storedMinExp = row.min_experience_years !== undefined && row.min_experience_years !== null
    ? String(row.min_experience_years)
    : null;
  // NOTHING writes jobs.min_experience_years (measured 2026-11-04), so experience_ceiling skipped
  // every job and Axiad's "6-8 years" reached manual apply. The JD's own text fills the gap; a
  // stored value still wins. Null (no hard requirement, or an intern/junior title) keeps the job.
  const parsedMinExp = storedMinExp === null ? requiredExperienceYears(row.title, row.description_raw ?? null) : null;
  // The string the cascade expects, or null when neither source states a requirement.
  const minExp = storedMinExp ?? (parsedMinExp === null ? null : String(parsedMinExp));
  // Read requires_advanced_degree if available (boolean or null).
  const reqAdvDeg = row.requires_advanced_degree ?? null;

  return {
    // UNTRUSTED, straight from the board. What the title blocklist matches on.
    title: row.title,
    // The company as the source spelled it (T12, 2026-11-10): already_applied folds it with the title into the
    // cross-source set, so an aggregator copy of an applied ATS job is caught. Never the slug: slugs differ by source.
    companyName: row.company_name,
    // The posting's id on its ATS (pending #5, 2026-11-18): already_applied blocks a RETITLED copy of an applied job,
    // which the title-keyed checks miss (Canonical 5150422 reached the queue twice). Null when the board gives no id.
    atsJobKey: atsJobKeyOf(row.ats_provider, row.ats_job_id),
    // 'other' is the aggregator lane (remote feeds). The twin check needs one aggregator side, so ATS-vs-ATS
    // same-title postings stay distinct (fix round 1). `ats_provider` is optional on JobInsert: absent = not a copy.
    isAggregatorCopy: row.ats_provider === "other",
    // The normalised join key for the company blocklist. (It also keyed the per-company
    // weekly cap until that rule was retired on 2026-11-10 — Teja: "remove it".)
    companySlug: row.company_slug,
    // Always `[]` today: `toJobInsert` (registry.ts:162) and both tier lanes (tiers.ts:296,
    // :370) hard-code it, and NOTHING splits locations later. The Normalizer only reads
    // the array; it never writes it. Corrected 2026-10-08, since this used to say splitting
    // is the Normalizer's job. `?? []` because the column is NOT NULL with a `'{}'` default.
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
// PlannedInsertStatus keeps the planner to the last two. Corrected 2026-10-08:
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
  preferences: ScreenPreferences,
): ScreenedBatchPlan {
  // Accumulators. Built as mutable locals and returned as readonly, so a caller cannot
  // reach back in and edit a plan after it was decided.
  const inserts: PlannedApplicationInsert[] = [];
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
    // An unclassified title warns and passes ONLY when no titles or keywords are configured
    // (Teja, 2026-10-09); with a config it is a drop instead. Collected regardless of the
    // verdict, since the warning is the only signal that the gate had no config to judge by.
    if ("warning" in techVerdict) warnings.add(techVerdict.warning);

    // NO DESCRIPTION (2026-11-18, Teja 21:46 IST: "no jd jobs also need to be in ready to tailor"). Replaces the
    // 2026-11-12 hold, which parked these rows at 'discovered' where no lane showed them. A blank row now goes through
    // every screen that can judge it WITHOUT a JD (the title rules below, the work-auth gate on title + location, the
    // cascade) and, if none rejects it, is born at passed_filters like any pass. Safe now and not on 11-05 because
    // nothing auto-tailors a scouted row any more (Teja 21:45 IST): a blank row waits in the lane for Teja's click, and
    // the card says "No description" (discoveredList.ts hasNoDescription).
    // THIN COUNTS AS BLANK (round 4, 2026-11-21): Fractal 002b1d10 passed on a 513-char tenant wrapper with no role
    // text. jd-substance.ts isThinDescription strips a closed list of boilerplate lines and needs 100 chars of role
    // text; the web pill calls the same function, so this verdict and the card's "No description" always agree.
    const blank = isThinDescription(entry.row.description_raw);
    // "Matched nothing configured" on a title alone is missing data, not a verdict (CLAUDE.md section 6; live: 668
    // Workday rows dropped tech_gate_unclassified in 3 days with an empty body), so for a blank JD it is no drop. A
    // title the gate REJECTS (an exclusion, a title rule) still drops below by its own code: the title is there to judge.
    const techDrop = techVerdict.drop && !(blank && techVerdict.code === "tech_gate_unclassified");

    // A stage-0 rejection short-circuits the cascade entirely.
    // techVerdict.drop repeated only so TypeScript narrows the verdict to its drop shape (code, reason) inside.
    if (techDrop && techVerdict.drop) {
      // `drop_reason` NAMES THE STAGE rather than one of the nine rules. Stage 0 is
      // deliberately outside the cascade, so attributing its drop to a `FilterRuleType`
      // would be a lie the dashboard would then repeat back to Teja. The gate supplies the
      // code itself (`tech_gate` for an excluded term, `tech_gate_unclassified` for a title
      // matching nothing configured), so the two are never spelled here.
      inserts.push({ job_id: entry.jobId, status: "dropped_filter", drop_reason: techVerdict.code });
      dropped.push({ jobId: entry.jobId, title: entry.row.title, ruleType: techVerdict.code, reason: techVerdict.reason });
      continue;
    }

    // STAGE 0b: an on-site/hybrid job outside the user's work-authorised countries, or a JD that
    // legally requires US status the user does not have.
    // After the tech gate because it reads the whole description (dearer than a title
    // match); before the cascade because it is still I/O-free and ends a hopeless posting
    // before any rule or Gemini call is spent on it.
    const authVerdict = screenWorkAuth(
      // The three texts the gate judges by; nothing else about the job matters to it.
      // board: Ashby's structured locations out of the stored payload (pending R, 2026-11-20); NO_BOARD_HINTS elsewhere.
      { title: entry.row.title, locationRaw: entry.row.location_raw ?? null, description: entry.row.description_raw ?? null, board: boardLocationHints(entry.row.ats_provider, ashbyLocationFields(entry.row.raw_payload)) },
      // The user's list; null (never set) opens the gate and warns.
      preferences.workAuthorizedCountries,
      // Teja's remote reading: country-locked remote drops under 'unlocked_or_authorized'.
      preferences.remoteLocationPolicy,
    );
    // The open-gate warning is the only sign the setting was never set (or holds a typo).
    if ("warning" in authVerdict) warnings.add(authVerdict.warning);
    // A drop is recorded under the gate's own code, exactly like the tech gate's.
    if (authVerdict.drop) {
      // drop_reason names the stage, never one of the nine cascade rules.
      inserts.push({ job_id: entry.jobId, status: "dropped_filter", drop_reason: authVerdict.code });
      // The prose names the signal that matched, so a wrong drop is diagnosable.
      dropped.push({ jobId: entry.jobId, title: entry.row.title, ruleType: authVerdict.code, reason: authVerdict.reason });
      // Nothing after a drop runs.
      continue;
    }

    // STAGE 0c: a JD that requires a language the user does not speak (Teja 2026-11-23, BBHT 5e108a32: a German-only
    // Java job that no location rule could catch). A separate gate, not a stretch of work-auth (orch ruling ~20:05).
    const langVerdict = screenLanguage(entry.row.description_raw ?? null, preferences.spokenLanguages);
    // The open-gate warning is the only sign the list was never set.
    if ("warning" in langVerdict) warnings.add(langVerdict.warning);
    // A drop is recorded under the gate's own code.
    if (langVerdict.drop) {
      // drop_reason names the gate, never a cascade rule.
      inserts.push({ job_id: entry.jobId, status: "dropped_filter", drop_reason: langVerdict.code });
      // The prose quotes the sentence or the body counts, so a wrong drop is diagnosable.
      dropped.push({ jobId: entry.jobId, title: entry.row.title, ruleType: langVerdict.code, reason: langVerdict.reason });
      // Nothing after a drop runs.
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
    // Derived rather than counted separately, so the counts can never disagree with the
    // rows actually planned. Every row is a pass or a drop (the 2026-11-12 hold is gone).
    passedCount: inserts.length - dropped.length,
    droppedCount: dropped.length,
  };
}
