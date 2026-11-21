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
// The Ashby location hints the work-auth gate reads (pending R, 2026-11-20), and the gate itself for the queue re-gate.
import { boardHintsFromSelect, screenWorkAuth, type BoardHintColumns, type WorkAuthDropCode } from "../_shared/screen/work-auth-gate.ts";
// The experience gate, asked directly by the queue re-gate (r4, 2026-11-21).
import { screenRequiredExperience, type ExperienceDropCode } from "../_shared/screen/required-experience.ts";
// The screener's same-ATS-posting key, so the auditor and the screener build it identically (W2, 2026-11-20).
import { atsJobKeyOf } from "../_shared/filter/cascade.ts";
// "Teja pasted this himself": such rows skip every automatic gate (the matcher's rule).
import { isHumanPicked } from "../_shared/match/score-threshold.ts";
// Teja's content rules (2026-11-08): the tailor's own gate, reused so the auditor and the tailor cannot disagree.
import { checkContentRules } from "../_shared/tailor/content-rules.ts";
// The two shapes that gate reads, checked against the real contract.
import type { MasterProfile, ResolvedResume } from "../_shared/contracts/shared-types.ts";

// The embedded `jobs(...)` the auditor's queue read selects for each row.
export interface AuditorJobEmbed extends BoardHintColumns {
  // The posting's id on its board; with ats_provider (from BoardHintColumns), the already-applied key (W2).
  readonly ats_job_id?: string | null;
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
    // Ashby's structured locations; NO_BOARD_HINTS when the embed carries none.
    board: boardHintsFromSelect(job),
  }, preferences);
}

/* THE QUEUE RE-GATE'S OWN GATES (r4, 2026-11-21). firstPreGateDrop returns only the FIRST code (tech, then work-auth,
   then experience). That is right for the `tailored` check, where every code means the same exit. The queue re-gate is
   different: it may drop for work_auth ONLY (Teja, 2026-11-11) and report experience. So a row failing tech first had
   its work-auth failure hidden, and the sweep kept it in Teja's queue. Here the two gates the sweep acts on are asked
   directly, each with the same inputs firstPreGateDrop feeds them; tech is not asked, because the sweep never acts on
   it. */
export interface AuditorRegateGates {
  // The work-auth objection, or null; independent of the tech gate.
  readonly workAuth: { readonly code: WorkAuthDropCode; readonly reason: string } | null;
  // The experience-ceiling objection, or null; independent of both other gates.
  readonly experience: { readonly code: ExperienceDropCode; readonly reason: string } | null;
}

// Both verdicts for one queue row's job. Same refusals as auditorPreGateDrop: a missing job throws, a pasted job passes.
export function auditorRegateGates(job: AuditorJobEmbed | null, preferences: PreGatePreferences): AuditorRegateGates {
  // No job: the gates cannot judge, and a pass would be the fail-open (CLAUDE.md section 6).
  if (job === null) throw new Error("auditor re-gate: no job embed for this row");
  // Teja pasted it himself: no automatic gate applies.
  if (isHumanPicked(job.discovered_via)) return { workAuth: null, experience: null };
  // The work-auth gate, fed exactly what firstPreGateDrop feeds it (matcher/tech-pregate.ts:83-90).
  const auth = screenWorkAuth(
    // Title, place, body and the Ashby hints.
    { title: job.title ?? "", locationRaw: job.location_raw, description: job.description_raw, board: boardHintsFromSelect(job) },
    // The user's list; null keeps the gate open.
    preferences.workAuthorizedCountries,
    // The remote reading.
    preferences.remoteLocationPolicy,
  );
  // The experience gate, fed exactly what firstPreGateDrop feeds it (matcher/tech-pregate.ts:94-99).
  const experience = screenRequiredExperience(
    // Title, body and the stored column (the parser fills in when it is null).
    { title: job.title ?? "", description: job.description_raw, minExperienceYears: job.min_experience_years },
    // The configured ceiling; null keeps.
    preferences.experienceMaxYears,
  );
  // Each verdict on its own.
  return {
    // Dropped by work-auth, or not.
    workAuth: auth.drop ? { code: auth.code, reason: auth.reason } : null,
    // Over the ceiling, or not.
    experience: experience.drop ? { code: experience.code, reason: experience.reason } : null,
  };
}

// The job's same-posting key (provider + ATS id), or null when either part is missing. One builder for the
// already-applied check and the queued-twin owner map, so the two can never key a posting differently.
export function auditorAtsKey(job: AuditorJobEmbed): string | null {
  // The screener's own key builder (null on a blank part or the 'other' provider).
  return atsJobKeyOf(typeof job.ats_provider === "string" ? job.ats_provider : null, job.ats_job_id);
}

/* ALREADY APPLIED, RE-CHECKED (W2, 2026-11-20). The screener's same-ATS-posting check (fa315449) runs only when a row
   is inserted, so a retitled copy of an applied job inserted BEFORE the original was applied (Canonical 111d1ff4 vs
   8e9d58ce) reached the queue. The auditor is the last agent before a human, so it asks again against today's
   history. `appliedKeys` is built by the caller from the screener's own applicationHistory() read (committed and
   awaiting_approval rows); a `tailored` row is never in it, so a row cannot match itself. The queue re-gate
   (regate-queue.ts, 2026-11-21) passes committed rows only, for the same reason. */
export type AuditorAlreadyAppliedDrop = { readonly code: "already_applied"; readonly reason: string } | null;

// The verdict for one row's job against the history keys.
export function auditorAlreadyAppliedDrop(job: AuditorJobEmbed | null, appliedKeys: ReadonlySet<string>): AuditorAlreadyAppliedDrop {
  // No job: the pre-gate above has already thrown for this row; stated again so this function is safe alone.
  if (job === null) throw new Error("auditor already-applied: no job embed for this row");
  // Teja pasted it himself: re-applying is then his choice, exactly as every other automatic gate skips it.
  if (isHumanPicked(job.discovered_via)) return null;
  // The key, or null when either part is missing (null never matches: a degenerate key would drop real jobs).
  const key = auditorAtsKey(job);
  // Matched: already applied or awaiting approval under another title or location.
  return key !== null && appliedKeys.has(key)
    ? { code: "already_applied", reason: `already applied or awaiting approval for this ATS posting under another title or location (${key})` }
    : null;
}

// The two history fields the key needs, as the screener's ApplicationHistoryRow carries them (a structural subset, so
// the screener's rows fit without a cast and a test can pass just these two).
export interface AppliedHistoryKeyRow {
  // jobs.ats_provider of the history row's job.
  readonly ats_provider: string | null;
  // jobs.ats_job_id of the history row's job.
  readonly ats_job_id: string | null;
  // True for approved and later (ApplicationHistoryRow.committed); false for an awaiting_approval row.
  readonly committed: boolean;
}

/* Which history rows become keys; required, so no caller gets a scope by default (CLAUDE.md section 6).
   - committed_and_queued: the main run. Its rows are `tailored`, never in the history, so a queued copy counts too.
   - committed_only: the approval-queue re-gate (2026-11-21). Its rows ARE the queued history rows, so a queued key
     would match the row itself and drop every keyed row in the queue. */
export type AppliedKeyScope = "committed_and_queued" | "committed_only";

// The history read's result: the screener's ScreenQueryResult shape, restated as the two fields used here.
export interface AppliedHistoryResult {
  // The query's error message, or null.
  readonly error: string | null;
  // The rows, or null when nothing came back.
  readonly rows: readonly AppliedHistoryKeyRow[] | null;
}

// The keys `auditorAlreadyAppliedDrop` checks against, or a refusal. A failed or rowless read must stop the run: an
// empty set would pass every row, which is the fail-open CLAUDE.md section 6 names (W2, 2026-11-21).
export function auditorAppliedKeys(result: AppliedHistoryResult, scope: AppliedKeyScope): { readonly ok: true; readonly keys: ReadonlySet<string> } | { readonly ok: false; readonly reason: string } {
  // An error, or no rows array at all (supabase-js returns [] for "none", never null on success).
  if (result.error !== null || !Array.isArray(result.rows)) return { ok: false, reason: `applications history query failed: ${result.error ?? "no rows returned"}` };
  // Every keyed row in scope; committed_and_queued matches the screener's context.ts appliedAtsJobKeys.
  const keys = new Set<string>();
  // One pass over the history.
  for (const row of result.rows) {
    // The re-gate's own rows are queued: skip queued rows there (strict `!== true`, so a missing flag adds nothing).
    if (scope === "committed_only" && row.committed !== true) continue;
    // Null for an id-less or aggregator row, which can never match.
    const key = atsJobKeyOf(row.ats_provider, row.ats_job_id);
    // Kept only when there is an identity to match on.
    if (key !== null) keys.add(key);
  }
  // The set, read.
  return { ok: true, keys };
}

// The content-rules verdict: its own code, because it judges the RESUME, not the job, so it is not a PreGateDropCode.
export type AuditorContentRulesDrop = { readonly code: "content_rules"; readonly reason: string } | null;

// Content rules (Teja, 2026-11-08; numbers live in PAGE_FIT_FLOORS, page-trim.ts): at most 2 projects (exactly
// min(2, master)), each >= min(3, master bullets) (selected at 4; the trim may cut to 3, T7 2026-11-10), exp_aczen >= 4,
// certifications >= 5, every achievement, education >= 2. The tailor enforces them, but live rows
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
  // "skills" since 2026-11-10 (T13): checkContentRules counts the AI skills group on both sides, so a master with no
  // skills array would otherwise fail as a bare TypeError, and the named error tells the reader which shape broke.
  for (const section of ["projects", "experience", "certifications", "achievements", "education", "skills"] as const) {
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
