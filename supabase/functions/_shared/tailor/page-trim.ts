// The one-page rule, content side: remove the least-relevant content until the resume fits.
//
// THE RULE (Teja, 2026-11-07 22:43 IST): "the tailored resume and the resumes after applying
// edits need to be in 1 page only, this is rule." HOW (his 23:00 ruling, order revised 23:55):
// first shrink the typography, then remove certifications, then the weakest bullets, never below the floors;
// never remove skills; fail closed when the floors themselves do not fit. REVISED 2026-11-09 20:41 IST (Teja, via the
// orchestrator): every resume keeps >= 5 certifications and EVERY achievement, so neither entry is ever removed here
// any more; only bullets go, and a page the bullet floors cannot fit is refused. And (23:18): it runs
// LIVE in the approval preview as he edits, deterministically, not by AI.
//
// PURE, on the RESOLVED resume, with no Deno or DOM API, so the SAME function runs in three
// places: the tailor (Deno), the web approval page after every edit (imported by relative path,
// like _shared/pipeline/row-pipeline.ts), and these tests (node --test). One function means
// the tailor and a live edit can never trim by different rules.
//
// Typography is NOT done here: renderResumeHtml picks the widest step that fits by itself
// (packages/resume-template/src/page-fit.ts), so fitsOnePage already means "fits at the
// readable minimum". This file removes content only when even the minimum overflows.
//
// REMOVAL ONLY, NEVER SHORTENING. Shortening a bullet deterministically means cutting words,
// and no rule can promise a cut keeps the claim's meaning ("reduced latency by 40% for 2M
// users" minus a clause is a different claim). A removed bullet is still true; a shortened one
// may not be. So the trimmer drops whole bullets, nothing else.

import type { ResolvedResume } from "../contracts/shared-types.ts";
// The same keyword test the skills shape and the ATS panel use, so "relevant" means one thing.
import { keywordAppearsIn } from "./jd-keywords.ts";
// The renderer's own one-page question: the model the real Chromium render is calibrated against.
import { fitsOnePage } from "../../../../packages/resume-template/src/index.ts";

/**
 * THE FLOORS, as data (Teja: "the whole system needs to be dynamic on this"). A section default
 * applies to every entry; a per-ref override wins for that entry. Refs are master node ids,
 * stable across master versions. Change a floor here, nowhere else.
 */
export const PAGE_FIT_FLOORS = {
  // Bullets each entry keeps at least, by section. Education is never trimmed at all.
  // Projects 4 since Teja's content rules (2026-11-08 15:46 IST: "each project at least 4 bullets"; was 3).
  // Projects 3 AGAIN since 2026-11-10 (T7, the orchestrator under Teja's "3-4 bullets per project"): this is the HARD
  // floor (the last trim step and checkContentRules). Selection still targets 4 (projectSoftCap), so a project shows 3
  // only when the 4-bullet page overflows. 5 inline certs left the v30 shape at 767.7 of 778.1pt: this buys headroom.
  // Never below 3: that breaks the rule.
  minBullets: { experience: 1, projects: 3, achievements: 1, certifications: 0 },
  // Per-entry overrides. exp_aczen = "the Aczen internship keeps >= 4 bullets"; Student Tribe
  // ("Technical Coordinator", Teja's "1-2 bullets") is the experience default of 1.
  minBulletsByRef: { exp_aczen: 4 } as Readonly<Record<string, number>>,
  // Bullets above 4 on a project are trimmed FIRST, before any other bullet (a project ends at 4 when space is short,
  // or at 3 when even that overflows: the last step, T7).
  // Since T7 (2026-11-10) also the project TARGET: content-rules selects up to it, and weakest_bullet keeps projects at
  // it; only the last step (project_bullet_to_floor) goes below it, down to minBullets.projects.
  projectSoftCap: 4,
  // Certification entries every resume carries: 5 since 2026-11-09 20:41 IST (Teja: "at least 5 certifications"; was 3,
  // was 2). Topped up by content-rules.ts to min(5, what the master holds), so a 3-cert master still tailors. Never
  // page-trimmed since the same ruling.
  minCertifications: 5,
  // ENTRY COUNTS for the content rules (Teja, 2026-11-08 15:36 + 15:46 IST), enforced at selection by content-rules.ts.
  // Never page-trimmed (the trimmer removes bullets only), so here only so every floor has one home.
  // A tailored resume holds AT MOST this many projects ("never and ever 3 projects, only 2"), and exactly this many
  // when the master has them.
  maxProjects: 2,
  // Projects that ALWAYS take one of those slots when the master holds them (Teja, 2026-11-08 ruling G(a):
  // "proj_applyy is always one of the 2 projects"). The other slot goes by relevance. Ids, so a rename is one edit here.
  alwaysProjects: ["proj_applyy"] as readonly string[],
  // Achievement entries: ALL of them since 2026-11-09 20:41 IST (Teja: "every achievement in the master"; was 2).
  // Infinity, not a count, because every reader takes min(rule, master count): that min IS "all", with no second code
  // path for "all" and no number to bump when Teja adds an achievement.
  minAchievements: Number.POSITIVE_INFINITY,
  // Education entries kept at least ("both educations; the diploma counts").
  minEducation: 2,
} as const;

/** One unit of trimming. */
// Bullets only: the "certification" and "achievement" entry steps were removed on 2026-11-09 (see TRIM_ORDER).
// project_bullet_to_floor (T7, 2026-11-10): a project bullet below the 4-bullet target, down to the hard floor of 3.
export type TrimStep = "project_bullet_over_cap" | "weakest_bullet" | "project_bullet_to_floor";

/**
 * THE ORDER, as one list: the first step with a candidate is taken, one removal at a time,
 * and the fit is re-measured after each. Reordering is a one-line change here.
 * Ruling history:
 * - 2026-11-07 23:00 IST (Teja): bullets, then certifications (shipped in 41d7430).
 * - 2026-11-07 23:55 IST (Teja): certifications go BEFORE bullets ("lowest priority, trimmed
 *   first"), still never below PAGE_FIT_FLOORS.minCertifications. Rows tailored between the two
 *   rulings were trimmed in the old order.
 * - 2026-11-08 (orchestrator, for Teja's achievements >= 2 floor): whole ACHIEVEMENT entries may go, down to
 *   PAGE_FIT_FLOORS.minAchievements, least JD-relevant first, LAST: only when every bullet above its floor is
 *   already gone. Last on purpose, so every resume that fit before this step existed trims exactly as before
 *   (Cursor ce965450 overflowed with all three achievements locked at one bullet each).
 * - 2026-11-09 20:41 IST (Teja, heard by the orchestrator): >= 5 certifications and every achievement on every
 *   resume. Both entry steps are GONE, not merely floored: only bullets are trimmed, and a page the bullet floors
 *   cannot fit is refused (blockedBy names "certifications: never removed" / "achievements: never removed").
 * - 2026-11-10 (T7, orchestrator, inside Teja's "3-4 bullets per project"): project_bullet_to_floor takes a project
 *   from 4 bullets to 3, LAST: only when every other bullet is at its floor and the page still overflows. Last on
 *   purpose (same reason as the 11-08 achievements step): every resume the first two steps could fit trims exactly as
 *   before; the step only turns what used to be a refusal into a fit.
 */
export const TRIM_ORDER: readonly TrimStep[] = ["project_bullet_over_cap", "weakest_bullet", "project_bullet_to_floor"];

/** What was removed, in removal order: enough to show it ("Trimmed to fit one page: ...") and to record it. */
export interface TrimItem {
  // Which step removed it.
  readonly step: TrimStep;
  // The bullet ref.
  readonly ref: string;
  // What printed: the bullet text.
  readonly text: string;
}

/** The result. `fits` false means the floors themselves overflow: refuse, never save page two. */
export interface PageFitResult {
  // The resume after trimming (the input object itself when nothing was removed).
  readonly resume: ResolvedResume;
  // What went, in order.
  readonly trimmed: readonly TrimItem[];
  // One page at the readable minimum.
  readonly fits: boolean;
  // When it does not fit: the floors at their limit, named, for the message and the event.
  readonly blockedBy: readonly string[];
}

/** The sections the trimmer may take bullets from. Education is never touched. */
const BULLET_SECTIONS = ["experience", "projects", "achievements", "certifications"] as const;

/** One removable thing, with what ranks it. */
interface Candidate {
  // The ref to remove.
  readonly ref: string;
  // What it printed.
  readonly text: string;
  // JD keywords it contains: fewer is weaker.
  readonly score: number;
  // Document position: on a tie, the LATER one goes (earlier content is the stronger placement).
  readonly order: number;
}

/** How many of the posting's keywords a text contains. */
function keywordScore(text: string, jdKeywords: readonly string[]): number {
  // Each keyword at most once.
  return jdKeywords.filter((keyword) => keywordAppearsIn(keyword, text)).length;
}

/** The weakest candidate: lowest score, then latest position. Null when there is none. */
function weakest(candidates: readonly Candidate[]): Candidate | null {
  // Sorted copy; the input is not reordered.
  const ranked = [...candidates].sort((a, b) => a.score - b.score || b.order - a.order);
  // First is the one to remove.
  return ranked[0] ?? null;
}

/** The bullet floor for one entry. */
function bulletFloor(section: (typeof BULLET_SECTIONS)[number], ref: string): number {
  // The per-ref override, else the section default.
  return PAGE_FIT_FLOORS.minBulletsByRef[ref] ?? PAGE_FIT_FLOORS.minBullets[section];
}

/** How many bullets an entry keeps for one step: entries at or under this offer nothing to that step. */
function keepFor(step: TrimStep, section: (typeof BULLET_SECTIONS)[number], ref: string): number {
  // Every section but projects keeps its floor for weakest_bullet (as before T7) and sits out the two project-only steps.
  if (section !== "projects") return step === "weakest_bullet" ? bulletFloor(section, ref) : Infinity;
  // A project's hard floor, never under minBullets.projects even if a per-ref override says less: checkContentRules
  // gates projects on minBullets.projects alone, so a lower override would print a project the gate then refuses.
  const floor = Math.max(PAGE_FIT_FLOORS.minBullets.projects, bulletFloor(section, ref));
  // The cap step: only bullets above the 4-bullet cap (unchanged since 41d7430).
  if (step === "project_bullet_over_cap") return PAGE_FIT_FLOORS.projectSoftCap;
  // weakest_bullet holds projects at the 4-bullet target, so it removes exactly what it did before T7 and the
  // 4 -> 3 cut waits for the last step.
  if (step === "weakest_bullet") return Math.max(PAGE_FIT_FLOORS.projectSoftCap, floor);
  // project_bullet_to_floor, the last step: down to the hard floor (3), never below.
  return floor;
}

/** The next removal for one step, or null when that step has nothing above its floor. */
function candidateFor(step: TrimStep, resume: ResolvedResume, jdKeywords: readonly string[]): Candidate | null {
  // Bullets: every bullet in an entry still above its level for this step.
  const candidates: Candidate[] = [];
  // Running document position across sections.
  let order = 0;
  // Each bullet section, in a fixed order.
  for (const section of BULLET_SECTIONS) {
    // Each entry (typed loosely: only ref and bullets are read).
    for (const entry of resume[section] as readonly { readonly ref: string; readonly bullets: readonly { readonly ref: string; readonly text: string }[] }[]) {
      // The cap step offers only project bullets above the cap; the weakest step, any bullet above its floor.
      const keep = keepFor(step, section, entry.ref);
      // Each bullet, positioned.
      for (const bullet of entry.bullets) {
        // Positions advance for every bullet, eligible or not, so ties break by real document order.
        order += 1;
        // Only entries above their level offer bullets.
        if (entry.bullets.length > keep) candidates.push({ ref: bullet.ref, text: bullet.text, score: keywordScore(bullet.text, jdKeywords), order });
      }
    }
  }
  // The weakest of them.
  return weakest(candidates);
}

/** A resume (resolved, or the ref profile the tailor stores) without one bullet. */
export function withoutTrimmed<R extends {
  readonly experience: readonly { readonly bullets: readonly { readonly ref: string }[] }[];
  readonly projects: readonly { readonly bullets: readonly { readonly ref: string }[] }[];
  readonly achievements: readonly { readonly ref: string; readonly bullets: readonly { readonly ref: string }[] }[];
  readonly certifications: readonly { readonly ref: string; readonly bullets: readonly { readonly ref: string }[] }[];
}>(resume: R, item: Pick<TrimItem, "step" | "ref">): R {
  // A bullet (the only thing ever trimmed): drop it from whichever entry holds it; every other entry is the same object.
  const drop = <T extends { readonly bullets: readonly { readonly ref: string }[] }>(entries: readonly T[]): T[] =>
    // Only the entry that contains it changes.
    entries.map((entry) => (entry.bullets.some((b) => b.ref === item.ref) ? { ...entry, bullets: entry.bullets.filter((b) => b.ref !== item.ref) } : entry));
  // Every bullet section, so the ref is found wherever it lives.
  return { ...resume, experience: drop(resume.experience), projects: drop(resume.projects), achievements: drop(resume.achievements), certifications: drop(resume.certifications) };
}

/** The floors at their limit, named for the refusal ("which floor blocked it"). */
function bindingFloors(resume: ResolvedResume): string[] {
  // Always binding: what is never trimmed at all. Certifications and achievements joined on 2026-11-09 (Teja's ruling).
  const named = ["skills: never removed", "summary: never removed", "education: never removed", "certifications: never removed", "achievements: never removed"];
  // Each bullet entry sitting at its floor with something on it.
  for (const section of BULLET_SECTIONS) {
    // Each entry.
    for (const entry of resume[section] as readonly { readonly ref: string; readonly bullets: readonly unknown[] }[]) {
      // Its floor.
      const floor = bulletFloor(section, entry.ref);
      // At the floor and non-empty: this floor is holding content on the page.
      if (floor > 0 && entry.bullets.length <= floor) named.push(`${entry.ref}: keeps >= ${floor} bullets`);
    }
  }
  // The list.
  return named;
}

/**
 * Fit a resume on one page: remove content in TRIM_ORDER, within PAGE_FIT_FLOORS, until it
 * fits at the readable-minimum typography. Deterministic: the same resume and keywords always
 * trim the same items. `fits` defaults to the renderer's fitsOnePage; tests pass a stand-in.
 */
export function fitToOnePage(resume: ResolvedResume, jdKeywords: readonly string[], fits: (r: ResolvedResume) => boolean = fitsOnePage): PageFitResult {
  // The resume being trimmed.
  let current = resume;
  // What has gone so far.
  const trimmed: TrimItem[] = [];
  // Bounded by the content: every pass removes one thing or returns.
  for (;;) {
    // Done.
    if (fits(current)) return { resume: current, trimmed, fits: true, blockedBy: [] };
    // The first step in the order that has a candidate.
    let next: TrimItem | null = null;
    // In TRIM_ORDER.
    for (const step of TRIM_ORDER) {
      // That step's weakest candidate.
      const candidate = candidateFor(step, current, jdKeywords);
      // Taken.
      if (candidate !== null) { next = { step, ref: candidate.ref, text: candidate.text }; break; }
    }
    // Every floor reached and still over: fail closed, naming the floors.
    if (next === null) return { resume: current, trimmed, fits: false, blockedBy: bindingFloors(current) };
    // Remove it and measure again.
    current = withoutTrimmed(current, next);
    // Recorded.
    trimmed.push(next);
  }
}
