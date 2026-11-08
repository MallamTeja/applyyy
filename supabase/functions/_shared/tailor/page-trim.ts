// The one-page rule, content side: remove the least-relevant content until the resume fits.
//
// THE RULE (Teja, 2026-11-07 22:43 IST): "the tailored resume and the resumes after applying
// edits need to be in 1 page only, this is rule." HOW (his 23:00 ruling, order revised 23:55):
// first shrink the typography, then remove certifications, then the weakest bullets, never below the floors;
// never remove skills; fail closed when the floors themselves do not fit. And (23:18): it runs
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
// may not be. So the trimmer drops whole bullets and whole certification entries.

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
  minBullets: { experience: 1, projects: 4, achievements: 1, certifications: 0 },
  // Per-entry overrides. exp_aczen = "the Aczen internship keeps >= 4 bullets"; Student Tribe
  // ("Technical Coordinator", Teja's "1-2 bullets") is the experience default of 1.
  minBulletsByRef: { exp_aczen: 4 } as Readonly<Record<string, number>>,
  // Bullets above 4 on a project are trimmed FIRST, before any other bullet (with the floor at 4, a project ends at exactly 4 when space is short).
  projectSoftCap: 4,
  // Certification entries kept at least: 3 since 2026-11-08 15:46 IST ("certifications at least 3"; was 2).
  minCertifications: 3,
  // ENTRY COUNTS for the content rules (Teja, 2026-11-08 15:36 + 15:46 IST), enforced at selection by content-rules.ts.
  // Never page-trimmed (the trimmer removes bullets and certifications only), so here only so every floor has one home.
  // A tailored resume holds AT MOST this many projects ("never and ever 3 projects, only 2"), and exactly this many
  // when the master has them.
  maxProjects: 2,
  // Achievement entries kept at least ("achievements at least 2").
  minAchievements: 2,
  // Education entries kept at least ("both educations; the diploma counts").
  minEducation: 2,
} as const;

/** One unit of trimming. */
export type TrimStep = "project_bullet_over_cap" | "weakest_bullet" | "certification";

/**
 * THE ORDER, as one list: the first step with a candidate is taken, one removal at a time,
 * and the fit is re-measured after each. Reordering is a one-line change here.
 * Ruling history:
 * - 2026-11-07 23:00 IST (Teja): bullets, then certifications (shipped in 41d7430).
 * - 2026-11-07 23:55 IST (Teja): certifications go BEFORE bullets ("lowest priority, trimmed
 *   first"), still never below PAGE_FIT_FLOORS.minCertifications. Rows tailored between the two
 *   rulings were trimmed in the old order.
 */
export const TRIM_ORDER: readonly TrimStep[] = ["certification", "project_bullet_over_cap", "weakest_bullet"];

/** What was removed, in removal order: enough to show it ("Trimmed to fit one page: ...") and to record it. */
export interface TrimItem {
  // Which step removed it.
  readonly step: TrimStep;
  // The bullet ref, or the certification entry ref.
  readonly ref: string;
  // What printed: the bullet text, or the certification label.
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

/** The printed text of a certification entry (what it is scored on and shown as). */
function certificationText(entry: ResolvedResume["certifications"][number]): string {
  // Label plus description, when there is one.
  return entry.description ? `${entry.label} ${entry.description}` : entry.label;
}

/** The next removal for one step, or null when that step has nothing above its floor. */
function candidateFor(step: TrimStep, resume: ResolvedResume, jdKeywords: readonly string[]): Candidate | null {
  // Certifications: whole entries, while above the floor.
  if (step === "certification") {
    // At or below the floor: nothing to take.
    if (resume.certifications.length <= PAGE_FIT_FLOORS.minCertifications) return null;
    // Each entry scored on its printed text.
    return weakest(resume.certifications.map((entry, order) => {
      // Its text, once.
      const text = certificationText(entry);
      // Scored like a bullet.
      return { ref: entry.ref, text, score: keywordScore(text, jdKeywords), order };
    }));
  }
  // Bullets: every bullet in an entry still above its level for this step.
  const candidates: Candidate[] = [];
  // Running document position across sections.
  let order = 0;
  // Each bullet section, in a fixed order.
  for (const section of BULLET_SECTIONS) {
    // Each entry (typed loosely: only ref and bullets are read).
    for (const entry of resume[section] as readonly { readonly ref: string; readonly bullets: readonly { readonly ref: string; readonly text: string }[] }[]) {
      // The cap step offers only project bullets above the cap; the weakest step, any bullet above its floor.
      const keep = step === "project_bullet_over_cap" ? (section === "projects" ? PAGE_FIT_FLOORS.projectSoftCap : Infinity) : bulletFloor(section, entry.ref);
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

/** A resume (resolved, or the ref profile the tailor stores) without one bullet or one certification entry. */
export function withoutTrimmed<R extends {
  readonly experience: readonly { readonly bullets: readonly { readonly ref: string }[] }[];
  readonly projects: readonly { readonly bullets: readonly { readonly ref: string }[] }[];
  readonly achievements: readonly { readonly bullets: readonly { readonly ref: string }[] }[];
  readonly certifications: readonly { readonly ref: string; readonly bullets: readonly { readonly ref: string }[] }[];
}>(resume: R, item: Pick<TrimItem, "step" | "ref">): R {
  // A certification: drop the entry.
  if (item.step === "certification") return { ...resume, certifications: resume.certifications.filter((entry) => entry.ref !== item.ref) };
  // A bullet: drop it from whichever entry holds it; every other entry is the same object.
  const drop = <T extends { readonly bullets: readonly { readonly ref: string }[] }>(entries: readonly T[]): T[] =>
    // Only the entry that contains it changes.
    entries.map((entry) => (entry.bullets.some((b) => b.ref === item.ref) ? { ...entry, bullets: entry.bullets.filter((b) => b.ref !== item.ref) } : entry));
  // Every bullet section, so the ref is found wherever it lives.
  return { ...resume, experience: drop(resume.experience), projects: drop(resume.projects), achievements: drop(resume.achievements), certifications: drop(resume.certifications) };
}

/** The floors at their limit, named for the refusal ("which floor blocked it"). */
function bindingFloors(resume: ResolvedResume): string[] {
  // Always binding: what is never trimmed at all.
  const named = ["skills: never removed", "summary: never removed", "education: never removed"];
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
  // Certifications at their floor.
  if (resume.certifications.length <= PAGE_FIT_FLOORS.minCertifications) named.push(`certifications: keeps >= ${PAGE_FIT_FLOORS.minCertifications}`);
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
