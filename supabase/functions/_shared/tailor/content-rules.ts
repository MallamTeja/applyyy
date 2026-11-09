// The content rules for every tailored resume (Teja, 2026-11-08 15:36 + 15:46 IST):
//   - projects: EXACTLY 2 (at most 2 always; fewer only when the master holds fewer), each >= 4 bullets;
//   - the Aczen experience >= 4 bullets (PAGE_FIT_FLOORS.minBulletsByRef);
//   - certifications >= 3, achievements >= 2, education >= 2.
//
// WHY TWO FUNCTIONS. The page trimmer's floors only stop it REMOVING content; they never stopped the
// model SELECTING too little (live 8794f52f: 1 Aczen bullet, 0 certifications) or too much (10 rows with 3
// projects). So:
//   - enforceContentRules runs in the tailor on the REF profile, after the model answers and BEFORE the
//     validator: it caps and tops up deterministically from the master, so the stored tailor_refs still
//     re-validate to exactly the stored resume (rebuildOriginal depends on it);
//   - checkContentRules is the gate on the RESOLVED resume: the tailor runs it after the page fit, the web
//     runs it on every edit (pageFitEdit.ts), and the auditor pre-gate runs it before any human sees a row.
// A prompt line asks the model for the same thing, but a prompt is not a control (CLAUDE.md section 6).
//
// NEVER INVENTED. Every floor is min(rule, what the master holds): a top-up copies master text verbatim
// (the validator's own trace test accepts it unchanged), and a master that holds too little is reported
// (the floor binds lower) rather than padded. The live master gap is named in the 2026-11-08 report.
//
// NOT IN THE VALIDATOR, ON PURPOSE. validateTailoredProfile also rebuilds every stored row for the web
// editor (rebuildOriginal); a floor there would refuse every row tailored before these rules existed.
//
// PURE: no Deno or DOM API, so the tailor (Deno), the auditor (Deno), the web (by relative path) and
// node --test all run the same code.

import type { MasterProfile, NodeId, ResolvedResume, TailoredBullet, TailoredProfile, TailoredSectionKind } from "../contracts/shared-types.ts";
// The same keyword test the trimmer and the skills shape use, so "relevant" means one thing.
import { keywordAppearsIn } from "./jd-keywords.ts";
// The floors' one home: change a number there, nowhere else.
import { PAGE_FIT_FLOORS } from "./page-trim.ts";
// The header title shape the validator accepts, so cleanRoleTitle can only emit a printable title.
import { ROLE_TITLE_SHAPE } from "./validator.ts";

/** One thing enforceContentRules changed, for the tailor's event (never silent). */
export interface ContentRuleChange {
  // Removed (a project over the cap) or added (an entry or bullet below a floor).
  readonly change: "dropped" | "added";
  // The section it happened in.
  readonly section: "projects" | "experience" | "certifications" | "achievements" | "education" | "summary";
  // The master node id dropped or added (an entry or a bullet).
  readonly ref: NodeId;
}

// The master shape every section shares, as far as these rules read it.
type MasterEntry = { readonly id: NodeId; readonly bullets: readonly { readonly id: NodeId; readonly text: string }[] };
// The ref shape every section shares, as far as these rules write it.
type RefEntry = { readonly ref: NodeId; readonly bullets: readonly TailoredBullet[] };

/** How many of the posting's keywords a text contains (each at most once). */
function keywordScore(text: string, jdKeywords: readonly string[]): number {
  // The same count page-trim ranks bullets by.
  return jdKeywords.filter((keyword) => keywordAppearsIn(keyword, text)).length;
}

/** A master entry's text for ranking: its name/label plus every bullet. */
function entryText(entry: MasterEntry & { readonly name?: string; readonly label?: string; readonly degree?: string }): string {
  // Whatever names the entry, then its bullets; missing parts are just absent.
  return [entry.name ?? entry.label ?? entry.degree ?? "", ...entry.bullets.map((b) => b.text)].join(" ");
}

/** The floor for a project's bullets: the rule, or every bullet the master holds when it holds fewer. */
function projectBulletFloor(master: MasterEntry): number {
  // Never more than the master can supply.
  return Math.min(PAGE_FIT_FLOORS.minBullets.projects, master.bullets.length);
}

/** Up to `floor` bullets for an entry: the model's own (reworded) ones first, then master text by JD relevance. */
function toppedUp(entry: RefEntry, master: MasterEntry, floor: number, jdKeywords: readonly string[], changes: ContentRuleChange[], section: ContentRuleChange["section"]): RefEntry {
  // Already enough: the model's answer stands untouched (same object, so nothing else changes).
  if (entry.bullets.length >= floor) return entry;
  // The bullets already printed, so a top-up never repeats one.
  const have = new Set(entry.bullets.map((b) => b.ref));
  // The master's other bullets, most JD-relevant first, master order on a tie (Array sort is stable).
  const extra = master.bullets
    // Not already printed.
    .filter((b) => !have.has(b.id))
    // Scored once each.
    .map((b) => ({ b, score: keywordScore(b.text, jdKeywords) }))
    // Highest score first.
    .sort((x, y) => y.score - x.score)
    // Only as many as the floor needs.
    .slice(0, floor - entry.bullets.length)
    // Master text verbatim: the validator traces it to itself, so nothing is invented.
    .map(({ b }) => ({ ref: b.id, text: b.text }));
  // Each added bullet recorded for the event.
  for (const bullet of extra) changes.push({ change: "added", section, ref: bullet.ref });
  // The entry with its top-up appended after the model's own bullets.
  return { ...entry, bullets: [...entry.bullets, ...extra] };
}

/** The section kind made printable: an added entry under a kind missing from section_order would never print. */
function withSection(order: readonly TailoredSectionKind[], kind: TailoredSectionKind): TailoredSectionKind[] {
  // Present: unchanged. Absent: appended last, the least disruptive place.
  return order.includes(kind) ? [...order] : [...order, kind];
}

/**
 * Cap and top up a REF profile to the content rules, deterministically, from the master only.
 * Run after the model answers and before validateTailoredProfile. Returns the same profile object
 * when nothing needed changing, so a compliant answer is stored byte for byte as the model gave it.
 */
export function enforceContentRules(
  tailored: TailoredProfile,
  master: MasterProfile,
  jdKeywords: readonly string[],
): { readonly profile: TailoredProfile; readonly changes: readonly ContentRuleChange[] } {
  // Every change, in the order made.
  const changes: ContentRuleChange[] = [];
  // The section order, grown only when an added entry needs its section printed.
  let sectionOrder = [...tailored.section_order];

  // --- Projects: exactly min(2, master), each topped up to its bullet floor ---------------------
  // The master's projects by id, for lookups.
  const masterProjects = new Map(master.projects.map((p) => [p.id, p] as const));
  // The model's picks that resolve, in the model's order (an unresolved ref is left for the validator).
  const picked = tailored.projects.filter((p) => masterProjects.has(p.ref));
  // The model's picks by ref, so a kept pick keeps its reworded bullets.
  const pickedByRef = new Map(picked.map((p) => [p.ref, p] as const));
  // Every master project ranked: an always-shown project first (proj_applyy, ruling G(a) 2026-11-08), then a project
  // able to meet the 4-bullet rule, then the model's judgement (its picks), then JD keyword overlap, then master order.
  const ranked = master.projects
    // Each with what ranks it.
    .map((p, index) => ({ p, always: PAGE_FIT_FLOORS.alwaysProjects.includes(p.id), eligible: p.bullets.length >= PAGE_FIT_FLOORS.minBullets.projects, chosen: pickedByRef.has(p.id), score: keywordScore(entryText(p), jdKeywords), index }))
    // Always, eligible, chosen, score: each descending; index ascending (Array sort is stable).
    .sort((a, b) => Number(b.always) - Number(a.always) || Number(b.eligible) - Number(a.eligible) || Number(b.chosen) - Number(a.chosen) || b.score - a.score || a.index - b.index);
  // The kept ids: exactly min(cap, master) of them.
  const keep = new Set(ranked.slice(0, PAGE_FIT_FLOORS.maxProjects).map((r) => r.p.id));
  // The model's picks that lost their place, recorded (never silent).
  for (const p of picked) if (!keep.has(p.ref)) changes.push({ change: "dropped", section: "projects", ref: p.ref });
  // The kept picks in the model's order, then any added project in rank order.
  const projectRefs = [...picked.filter((p) => keep.has(p.ref)).map((p) => p.ref), ...ranked.map((r) => r.p.id).filter((id) => keep.has(id) && !pickedByRef.has(id))];
  // Each kept project: the model's entry, or a new one from the master; then topped up.
  const projects = projectRefs.map((ref) => {
    // The master node (present: every ref here came from the master list).
    const masterProject = masterProjects.get(ref)!;
    // The model's own entry, or an empty one for an added project.
    const entry: RefEntry = pickedByRef.get(ref) ?? { ref, bullets: [] };
    // An added project is recorded.
    if (!pickedByRef.has(ref)) changes.push({ change: "added", section: "projects", ref });
    // Its bullets brought up to the floor the master can supply.
    return toppedUp(entry, masterProject, projectBulletFloor(masterProject), jdKeywords, changes, "projects");
  });
  // The section prints when it holds anything.
  if (projects.length > 0) sectionOrder = withSection(sectionOrder, "projects");

  // --- Experience: each per-ref floor (exp_aczen >= 4), the entry added when the model left it out ----
  let experience = [...tailored.experience];
  // Each experience the floors name.
  for (const [ref, rule] of Object.entries(PAGE_FIT_FLOORS.minBulletsByRef)) {
    // Only experience ids the master actually holds (a floor for an absent node binds nothing).
    const masterEntry = master.experience.find((e) => e.id === ref);
    // Not in this master: nothing to enforce.
    if (masterEntry === undefined) continue;
    // The floor the master can supply.
    const floor = Math.min(rule, masterEntry.bullets.length);
    // Where the model put it, if it did.
    const at = experience.findIndex((e) => e.ref === ref);
    // Left out entirely: added (first, as the strongest experience) and recorded.
    if (at === -1) {
      // Recorded before the bullets that follow it.
      changes.push({ change: "added", section: "experience", ref });
      // Put first: a floor-named experience is the one the owner wants seen.
      experience = [toppedUp({ ref, bullets: [] }, masterEntry, floor, jdKeywords, changes, "experience"), ...experience];
      // The section must print.
      sectionOrder = withSection(sectionOrder, "experience");
    } else {
      // Present: topped up in place.
      experience[at] = toppedUp(experience[at]!, masterEntry, floor, jdKeywords, changes, "experience");
    }
  }

  // --- Entry counts: certifications, achievements, education, each topped up to min(rule, master) ----
  // One rule for the three count sections: add the most JD-relevant missing master entries.
  const countUp = <K extends "certifications" | "achievements" | "education">(section: K, rule: number, bulletsEach: number): TailoredProfile[K] => {
    // What the model chose.
    const chosen = tailored[section] as readonly RefEntry[];
    // The master list for that section.
    const pool = master[section] as readonly MasterEntry[];
    // The floor the master can supply.
    const floor = Math.min(rule, pool.length);
    // Enough already: unchanged.
    if (chosen.length >= floor) return tailored[section];
    // Already chosen, so never added twice.
    const have = new Set(chosen.map((e) => e.ref));
    // Missing entries, most JD-relevant first, master order on a tie.
    const added = pool
      // Not chosen yet.
      .filter((e) => !have.has(e.id))
      // Scored on everything the entry prints.
      .map((e) => ({ e, score: keywordScore(entryText(e), jdKeywords) }))
      // Highest first (stable on ties).
      .sort((a, b) => b.score - a.score)
      // Only what the floor needs.
      .slice(0, floor - chosen.length)
      // Each with up to `bulletsEach` of its own most relevant bullets, master text verbatim.
      .map(({ e }) => {
        // Recorded.
        changes.push({ change: "added", section, ref: e.id });
        // Its bullets, by the same top-up rule.
        return toppedUp({ ref: e.id, bullets: [] }, e, Math.min(bulletsEach, e.bullets.length), jdKeywords, changes, section);
      });
    // The section must print.
    sectionOrder = withSection(sectionOrder, section);
    // Chosen first (the model's order), then the additions.
    return [...chosen, ...added] as unknown as TailoredProfile[K];
  };
  // Certifications: each added entry prints its label (the trimmer's certification bullet floor is 0).
  const certifications = countUp("certifications", PAGE_FIT_FLOORS.minCertifications, PAGE_FIT_FLOORS.minBullets.certifications);
  // Achievements: each added entry carries the section's bullet floor (1).
  const achievements = countUp("achievements", PAGE_FIT_FLOORS.minAchievements, PAGE_FIT_FLOORS.minBullets.achievements);
  // Education: an added entry prints its degree line; its bullets are optional detail.
  const education = countUp("education", PAGE_FIT_FLOORS.minEducation, 0);

  // --- Summary (Teja, 2026-11-08 16:06 IST: "every tailored resume prints a summary matched to the role") --------
  // The model's own summary stands; a missing one is the owner's own paragraph, never invented text.
  let summary = tailored.summary;
  // The variant pick, changed only when the summary comes from a variant.
  let summaryVariant = tailored.summary_variant ?? null;
  // Only when the model wrote none.
  if (summary === null) {
    // The master's variants (an absent list = none).
    const variants = master.summary_variants ?? [];
    // The picked variant first (its headline framing was the model's choice), else the most JD-matched one,
    // master order on a tie (stable sort), scored on its headline plus its paragraph.
    const source = variants.find((v) => v.id === summaryVariant)
      ?? [...variants].sort((a, b) => keywordScore(`${b.headline} ${b.summary.text}`, jdKeywords) - keywordScore(`${a.headline} ${a.summary.text}`, jdKeywords))[0];
    // A variant: its paragraph verbatim, cited by its own id, and picked so the validator accepts the citation.
    if (source !== undefined) {
      // The owner's text, cited.
      summary = { text: source.summary.text, refs: [source.summary.id] };
      // Picked, so validator.ts accepts the citation (only the picked variant's summary is citable).
      summaryVariant = source.id;
    } else if ((master.summary ?? null) !== null) {
      // No variants: the master's own paragraph, cited by its id (`?? null`: an absent key is no summary).
      summary = { text: master.summary!.text, refs: [master.summary!.id] };
    }
    // Recorded when anything was filled in.
    if (summary !== null) changes.push({ change: "added", section: "summary", ref: summary.refs[0]! });
  }
  // A summary prints only when its kind is in section_order (the model's own summary too): first, where it belongs.
  if (summary !== null && !sectionOrder.includes("summary")) sectionOrder = ["summary", ...sectionOrder];

  // Nothing changed (no repair, and section_order only ever grows): the model's own object, stored exactly as given.
  if (changes.length === 0 && sectionOrder.length === tailored.section_order.length) return { profile: tailored, changes };
  // The enforced profile; summary_variant written only when it is set, so an absent key stays absent (AS HELD).
  return { profile: { ...tailored, ...(summaryVariant !== null ? { summary_variant: summaryVariant } : {}), section_order: sectionOrder, summary, projects, experience, certifications, achievements, education }, changes };
}

// Seniority words a posting's title can carry that the candidate does not hold (an early-career engineer applying
// to "Senior Software Engineer II" is applying for the role, not the seniority). Exactly the list the orchestrator
// approved on 2026-11-08 (Senior/Sr/Lead/Staff/Principal/II/III); "Intern" and "Junior" are roles he holds, so they stay.
const SENIORITY_WORDS = /\b(senior|sr|lead|staff|principal|ii|iii)\b\.?/gi;

// The nouns that make a phrase a ROLE (2026-11-09). A closed list on purpose: it decides which title segment is the
// role, and it is the only thing ever singularised, so "Sales", "Analytics", "Business", "DevOps" and "Kubernetes"
// keep their s. Trailing (s)? = the plural a posting uses for "we hire several"; the candidate applies for one.
const ROLE_NOUN = /\b(engineer|developer|intern|internship|analyst|scientist|architect|designer|programmer|consultant|researcher|tester|administrator|sde|swe|sre)(s)?\b/gi;

// Words that date or frame an internship but never name the role (2026-11-09): a season, a year, "Co-op".
// Removed from the headline, and ignored when deciding whether a later segment is ONLY an intern marker.
const INTERN_FILLER = /\b(summer|winter|spring|fall|autumn|(?:19|20)\d{2}|co-?op)\b/gi;

// A segment that, once filler and punctuation are gone, is nothing but the intern word.
const INTERN_ONLY = /^(interns?|internship)$/i;

// Any intern word, to know whether the chosen role already says it (no "Intern Intern").
const HAS_INTERN = /\bintern(s|ship)?\b/i;

/**
 * Rule 5 (Teja, 2026-11-08 15:46 IST): the header's role title is the role applied for, from the job title,
 * cleaned: the title is split at " - ", "|", ",", "(", "[", ":" and at " with " / " for " (team, location, req id,
 * stack tail), and the FIRST segment holding a role noun is the role (2026-11-09: "GTSM - Site Reliability
 * Engineer" printed "GTSM"). Seniority and level words go (never a seniority he lacks), a plural role noun becomes
 * singular, anything outside the validator's ROLE_TITLE_SHAPE goes. "Intern" stays: it is the role, not a seniority.
 * Null when no segment names a role, so the headline falls back as before (never a fragment).
 */
export function cleanRoleTitle(jobTitle: string): string | null {
  // Every qualifier-separated segment, in title order; " with " / " for " start a stack or team tail.
  const segments = jobTitle.split(/\s[-–—|:]\s|[,(\[|:]|\s(?:with|for)\s/i);
  // The first segment that names a role; a team, org, year or stack segment never becomes the headline.
  // `.search`, not `.test`: ROLE_NOUN is global, and `.test` would carry lastIndex between segments; search ignores it.
  const roleIndex = segments.findIndex((segment) => segment.search(ROLE_NOUN) !== -1);
  // No role anywhere in the title: the variant's or the master's headline stands.
  if (roleIndex === -1) return null;
  // The role segment itself (findIndex proved it exists).
  const role = segments[roleIndex]!;
  // Teja, 2026-11-09 17:02 IST, "Keep 'Intern'": "Software Engineer, Intern" is an internship, so a LATER segment
  // that is only an intern word (season/year/co-op aside) is carried onto a role that does not already say it.
  const internAfter = !HAS_INTERN.test(role) && segments.slice(roleIndex + 1)
    // Filler and punctuation stripped, so "Winter Intern" and "CPD) - Intern" reduce to the bare word.
    .some((segment) => INTERN_ONLY.test(segment.replace(INTERN_FILLER, " ").replace(/[^A-Za-z]+/g, " ").trim()));
  // Seniority words removed, plural role nouns made singular, characters outside the shape removed, spaces collapsed.
  const cleaned = (internAfter ? `${role} Intern` : role)
    // Never a seniority he lacks.
    .replace(SENIORITY_WORDS, " ")
    // A season, year or "Co-op" dates the posting; it is not the role.
    .replace(INTERN_FILLER, " ")
    // "Interns" -> "Intern": only a listed role noun loses its s, and only when the s is the plural.
    .replace(ROLE_NOUN, (_match, noun: string) => noun)
    // Markup, emoji, brackets: anything the validator would refuse.
    .replace(/[^A-Za-z0-9 &+#./-]/g, " ")
    // Collapsed so removed words leave no double spaces.
    .replace(/\s+/g, " ")
    // No edge whitespace, and no "/" or "-" a removed word left dangling ("Internship/Co-op" -> "Internship").
    .replace(/^[\s/-]+|[\s/-]+$/g, "");
  // Only a title the validator will print; otherwise the old headline stands.
  return ROLE_TITLE_SHAPE.test(cleaned) ? cleaned : null;
}

/**
 * Exactly one summary variant cited and none picked: pick it (LSEG 2b7db9a2, 2026-11-08: the model cited
 * summary-ai-llm without picking variant-ai-llm, and validator.ts accepts only the PICKED variant's
 * summary). Stored explicitly in the refs, so the rebuild re-validates to the same resume. Several cited,
 * or a cited variant that disagrees with the picked one, is left as it is: the validator refuses it
 * (unresolved_ref on "summary refs"), which is the fail-closed answer for an ambiguous framing.
 */
export function pickCitedVariant(tailored: TailoredProfile, master: MasterProfile): TailoredProfile {
  // Already picked, or nothing cited: nothing to infer.
  if ((tailored.summary_variant ?? null) !== null || tailored.summary === null) return tailored;
  // The cited refs, once.
  const cited = new Set(tailored.summary.refs);
  // The variants whose own summary is cited.
  const matches = (master.summary_variants ?? []).filter((variant) => cited.has(variant.summary.id));
  // Exactly one: that variant is the framing the model chose.
  return matches.length === 1 ? { ...tailored, summary_variant: matches[0]!.id } : tailored;
}

/**
 * The gate: every content rule the RESOLVED resume breaks, named for a refusal (empty = compliant).
 * Floors are min(rule, master), so a short master never fails a resume for content it cannot supply.
 */
export function checkContentRules(resume: ResolvedResume, master: MasterProfile): string[] {
  // Every broken rule.
  const broken: string[] = [];
  // A summary paragraph that prints, whenever the master holds one to print (2026-11-08 16:06 IST).
  // `?? null`: an absent key is "no summary", never read as one (an undefined !== null would say "has one").
  const masterHasSummary = (master.summary ?? null) !== null || (master.summary_variants ?? []).length > 0;
  // Printed means non-blank text AND its section in section_order.
  if (masterHasSummary && ((resume.summary ?? "").trim() === "" || !resume.section_order.includes("summary"))) broken.push("summary: missing");
  // Projects over the cap: the ruling that started this file.
  if (resume.projects.length > PAGE_FIT_FLOORS.maxProjects) broken.push(`projects: ${resume.projects.length}, at most ${PAGE_FIT_FLOORS.maxProjects}`);
  // Projects under the count the master can supply.
  const projectFloor = Math.min(PAGE_FIT_FLOORS.maxProjects, master.projects.length);
  // Too few.
  if (resume.projects.length < projectFloor) broken.push(`projects: ${resume.projects.length}, needs ${projectFloor}`);
  // Each project's bullets against what its master node can supply.
  for (const project of resume.projects) {
    // The master node (an unknown ref is the validator's to refuse, so it binds nothing here).
    const masterProject = master.projects.find((p) => p.id === project.ref);
    // Its floor.
    const floor = masterProject === undefined ? 0 : projectBulletFloor(masterProject);
    // Under it.
    if (project.bullets.length < floor) broken.push(`${project.ref}: ${project.bullets.length} bullets, needs ${floor}`);
  }
  // Each per-ref experience floor (exp_aczen).
  for (const [ref, rule] of Object.entries(PAGE_FIT_FLOORS.minBulletsByRef)) {
    // Only for a node this master holds.
    const masterEntry = master.experience.find((e) => e.id === ref);
    // Absent from the master: nothing to require.
    if (masterEntry === undefined) continue;
    // The floor the master can supply.
    const floor = Math.min(rule, masterEntry.bullets.length);
    // Its printed bullets, 0 when it is missing altogether.
    const printed = resume.experience.find((e) => e.ref === ref)?.bullets.length ?? 0;
    // Under it.
    if (printed < floor) broken.push(`${ref}: ${printed} bullets, needs ${floor}`);
  }
  // The three entry counts, each against min(rule, master).
  const counts: readonly [keyof Pick<ResolvedResume, "certifications" | "achievements" | "education">, number][] = [
    // Certifications >= 3.
    ["certifications", PAGE_FIT_FLOORS.minCertifications],
    // Achievements >= 2.
    ["achievements", PAGE_FIT_FLOORS.minAchievements],
    // Education >= 2.
    ["education", PAGE_FIT_FLOORS.minEducation],
  ];
  // Each count.
  for (const [section, rule] of counts) {
    // The floor the master can supply.
    const floor = Math.min(rule, master[section].length);
    // Under it.
    if (resume[section].length < floor) broken.push(`${section}: ${resume[section].length}, needs ${floor}`);
  }
  // Empty when compliant.
  return broken;
}
