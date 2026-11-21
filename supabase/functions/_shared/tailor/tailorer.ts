// THE TAILOR RUNNER — one job in, one verdict out.
//
// This is the piece `_shared/tailor/` was missing. `prompt.ts` builds the call and
// `validator.ts` judges the answer, but nothing joined them, which is why this tree had
// zero non-test importers while looking complete. Deliberately the same shape as
// `../match/scorer.ts`: a factory taking a model seam plus the trusted half of the
// inputs, returning a function over one posting.
//
// PURE OF EVERYTHING EXCEPT THE MODEL. No database, no clock, no Gemini import. The
// `callLlm` seam is what keeps this unit testable with no key pool and no network, and
// it is also what lets this module run under `node --test` at all: `../gemini/` is
// Deno-only (`jsr:` imports, `Deno.env`), so importing it here would make these tests
// unrunnable outside Deno. Persisting the verdict is `persist.ts`'s job; deciding it is
// this file's.
//
// An earlier version of this comment also cited three open `exactOptionalPropertyTypes`
// errors in `../gemini/client.ts` as a reason to stay clear. Those were closed by
// `db98d6e` on 2026-09-18, mid-build. The seam is not why they mattered and the reason
// above stands on its own — recorded rather than silently deleted, because a rationale
// that quietly loses one of its two legs is worth knowing about.
//
// THE DISTINCTION THIS MODULE EXISTS TO HOLD: a model that DID NOT ANSWER and a model
// that answered DISHONESTLY are different events.
//   - did not answer (prose instead of JSON, or JSON of the wrong shape) -> THROW.
//     Nothing was judged, so there is no verdict; reporting one would invent it.
//   - answered dishonestly (a ref that resolves to nothing, a stale pin) -> RETURN a
//     refusal carrying its violations, because that IS a verdict and `validator.ts:70`
//     requires it reach the dashboard "rather than lose them in a stack trace".
// Collapsing either into the other is §5's pattern: malformed data becoming an answer.

// The prompt assembly that fences untrusted posting text out of the instruction region.
import { buildBulletRewritePrompt, buildTailorPrompt, type TailorPrompt } from "./prompt.ts";
// The honesty gate. The ONLY constructor of a `ResolvedResume`, per its own header.
import { validateTailoredProfile, type TailorViolation } from "./validator.ts";
// The posting's skill terms, deterministic and vocabulary-gated, for selected_jd_keywords.
import { AI_VOCABULARY_TERMS, canonicalSkillTerm, classifyJd, extractJdKeywords, JD_TIER_WEIGHT, jdTierOf, keywordAppearsIn, type JdTier } from "./jd-keywords.ts";
// The two-line group fill (2026-11-21, compact skills block): the same width model the page fit counts height with.
import { fillSkillLines } from "../../../../packages/resume-template/src/page-fit.ts";
// The skill preference profile (core, never-list, twins, aliases) as data.
import { SKILL_PROFILE, type SkillProfile } from "./skill-profile.ts";
// Stored postings may be raw HTML; every reader here sees the text (N1, 2026-11-07).
import { postingText } from "./posting-text.ts";
// The one-page rule: the same pure trimmer the web runs live after every edit.
// The content rules: cap/top-up before the gate, the check after the fit, the cited-variant pick (2026-11-08).
import { checkContentRules, cleanRoleTitle, enforceContentRules, pickCitedVariant, type ContentRuleChange } from "./content-rules.ts";
import { fitToOnePage, PAGE_FIT_FLOORS, withoutTrimmed, type TrimItem } from "./page-trim.ts";
// The contract, reached through this stream's single re-export module. Nothing here
// redefines one of these — a redefined type does not fail, it drifts.
import type { MasterProfile, ResolvedResume, TailoredProfile } from "../contracts/shared-types.ts";

// What a model call looks like from here: a prompt in, raw response text out.
//
// RETURNS A STRING, NOT A PARSED OBJECT, for the same reason `scorer.ts` does — the
// real transport hands back text, and parsing it is a failure surface that belongs
// under test. A seam typed as returning a clean object would quietly move the riskiest
// step outside the boundary being tested.
export type TailorLlmCaller = (prompt: TailorPrompt) => Promise<string>;

// The trusted half of the inputs, supplied once when the tailorer is built rather than
// per call: they do not vary between postings in a run, and threading them through
// every call site would invite a caller to vary them by accident.
export interface TailorDeps {
  // How to reach the model. Injected; see the header.
  readonly callLlm: TailorLlmCaller;
  // Teja's own versioned profile. TRUSTED — the only candidate text allowed to reach
  // the instruction region.
  readonly master: MasterProfile;
  // The pinned version the model must echo back, so a tailoring computed against a
  // different snapshot is detectable rather than silently rendered.
  readonly masterVersion: number;
}

// The untrusted half: everything scraped from the posting, named so the trust boundary
// is visible in the type rather than remembered by the caller.
export interface TailorJobInput {
  // UNTRUSTED. Scraped.
  readonly jobTitle: string;
  // UNTRUSTED. Scraped.
  readonly company: string;
  // UNTRUSTED. Scraped.
  readonly jobDescription: string;
}

// The verdict. A discriminated union rather than a nullable resume, so a caller cannot
// reach for `.resume` without first deciding what to do about a refusal — and so the
// violations have somewhere to live other than a thrown stack.
export type TailorOutcome =
  // Safe to persist and hand onward to the Auditor.
  // `refs` is the raw ref-based output the resume was resolved from. Carried so it can
  // be persisted to `tailor_refs`: the Auditor's summary-ref check (audit/detector.ts:503)
  // reads that column, and nothing wrote it, so the check could never fire.
  // `jdKeywords` is the posting's skill terms (jd-keywords.ts), carried ON the verdict so
  // persist.ts writes them in the same statement as the resume they were measured against.
  // `dedupedRefs` (2026-11-05) lists every repeated ref dedupeRepeatedRefs dropped before validation: empty
  // for a clean answer, and persisted in the event so a prompt that repeats itself stays visible.
  // `retry` (2026-11-05): null when the first answer passed; else what failed first and which bullets the
  // one-shot rewrite replaced, persisted in the event so the retry's yield can be measured.
  // `skillsAdded` / `skillsDropped` (2026-11-06) list every skill ref shapeSkillGroups appended (floor
  // top-ups) or removed (a model pick in a group the posting never touches); both persisted in the event
  // so the reshaping is never silent.
  // `skillsInvented` (D1, 2026-11-07) lists every skill ref the model invented, dropped before the gate.
  | { readonly kind: "tailored"; readonly resume: ResolvedResume; readonly refs: TailoredProfile; readonly jdKeywords: readonly string[]; readonly dedupedRefs: readonly DedupedRef[]; readonly skillsAdded: readonly string[]; readonly skillsDropped: readonly string[]; readonly skillsInvented: readonly string[]; readonly retry: null | { readonly firstViolations: readonly TailorViolation[]; readonly rewrittenRefs: readonly string[] }; readonly pageFitTrimmed: readonly TrimItem[]; readonly contentRuleChanges: readonly ContentRuleChange[] }
  // Never persisted as a profile; the reasons go to the dashboard and the row fails.
  // `retry` (2026-11-05): null when no retry ran; else the first attempt's violations and how the retry ended.
  | { readonly kind: "refused"; readonly violations: readonly TailorViolation[]; readonly retry: null | { readonly firstViolations: readonly TailorViolation[]; readonly result: "still_invalid" | "reply_unusable" } };

// One copy of a ref the model repeated inside one section, which dedupeRepeatedRefs dropped.
export interface DedupedRef {
  // The repeated node id.
  readonly ref: string;
  // The section it repeated in, in the validator's own words ("skills", "summary refs", ...).
  readonly where: string;
}

/* NORMALISATION, NOT LENIENCY (2026-11-05). The model sometimes lists one master node twice in the same
 * section (live: EA "Data Science Intern", match 84, failed on duplicate_ref skill_python in skills).
 * A repeat adds no claim: the second copy points at the very node the first one does. So, BEFORE the
 * validator, each section keeps the FIRST copy of each ref and drops the rest, deterministically.
 *
 * What this does NOT do: it never adds, rewrites or vouches for anything. Every surviving ref is still
 * resolved against the master, every bullet token still checked, and a ref repeated ACROSS two sections
 * is left alone, so the validator still refuses it (that is a wrong-section claim, not a repeat). The
 * validator itself is unchanged and still refuses duplicates: rebuildOriginal (web tailoredEdits.ts)
 * re-validates the STORED refs, which are this deduplicated profile, so the rebuild still equals the
 * snapshot. And the repair is reported (dedupedRefs), never silent: validator.ts:405 warns that silent
 * repair hides a misbehaving prompt. Exported for the test. */
export function dedupeRepeatedRefs(tailored: TailoredProfile): { readonly profile: TailoredProfile; readonly deduped: readonly DedupedRef[] } {
  // Every dropped copy, in document order.
  const deduped: DedupedRef[] = [];
  // Keeps the first item per ref in one section; the rest are recorded and dropped.
  const firstOnly = <T>(items: readonly T[], refOf: (item: T) => string, where: string): T[] => {
    // Refs already kept in this section only: a repeat across sections is the validator's to refuse.
    const seen = new Set<string>();
    // Order kept: the first copy stays where the model put it.
    return items.filter((item) => {
      // The item's node id.
      const ref = refOf(item);
      // A repeat: recorded, then dropped.
      if (seen.has(ref)) {
        deduped.push({ ref, where });
        return false;
      }
      // The first copy: kept.
      seen.add(ref);
      return true;
    });
  };
  // Each ref-bearing section, named as validator.ts names it in its duplicate_ref violations.
  const profile: TailoredProfile = {
    // Everything that carries no ref list, as parsed.
    ...tailored,
    // The summary's own ref list, when there is a summary.
    summary: tailored.summary === null ? null : { ...tailored.summary, refs: firstOnly(tailored.summary.refs, (ref) => ref, "summary refs") },
    // Each section of {ref, ...} items.
    skills: firstOnly(tailored.skills, (s) => s.ref, "skills"),
    experience: firstOnly(tailored.experience, (e) => e.ref, "experience"),
    projects: firstOnly(tailored.projects, (p) => p.ref, "projects"),
    education: firstOnly(tailored.education, (e) => e.ref, "education"),
    achievements: firstOnly(tailored.achievements, (a) => a.ref, "achievements"),
    certifications: firstOnly(tailored.certifications, (c) => c.ref, "certifications"),
  };
  // A clean answer comes back unchanged in content, with nothing reported.
  return { profile, deduped };
}

/* THE SKILLS ENGINE (rewritten 2026-11-21, tailor #5 parcel 2; plan docs/tailor/2026-11-18-tailoring-findings-and-plan.md).
 *
 * WHY: 1,221 of 1,403 chat edits (87%) were Teja adding skills by hand, the same ones on nearly every resume, because
 * the old shape picked skills only when the posting spelled the master name exactly, and filled ONE printed line.
 *
 * THE RULINGS IT ENFORCES, in code because a prompt rule is not a control (repo §6):
 *   - CORE + JD FILL (Teja 2026-11-18): each group ships its profile core first, then fills with JD-ranked master skills.
 *   - NEVER-LIST (same ruling): a profile `never` skill is blocked, whatever the JD or the model says. Reported as dropped.
 *   - MOST-NEEDED FIRST (2026-11-18 21:47): inside a group, JD-required > preferred > mentioned > core > the rest; groups
 *     ordered by how much of the JD they cover (tier-weighted). Projects and achievements: orderByJdRelevance below.
 *   - GROUP SIZE (2026-11-12 13:57, "at least 5 skill groups with each having up to 7 skills"; the per-group cap raised to 10 on
 *     2026-11-21 14:41, "increase that cap to 3 more skills in each"): >= SKILLS_MIN_GROUPS
 *     groups, at most SKILLS_MAX_GROUPS, each up to min(profile max, SKILLS_PER_GROUP_CAP). The 11-11 floors (every group
 *     >= 4, the leading two >= 6, once called SKILLS_PER_GROUP_FLOOR) are gone; so is the 11-12 ONE-LINE rule:
 *   - COMPACT SKILLS BLOCK (2026-11-18, newer than 11-12's one line): a group may wrap to SKILL_GROUP_MAX_LINES (2) lines,
 *     filled by fillSkillLines, the width model the page fit itself uses, so the tailor and the page never disagree.
 *   - THE AI GROUP (2026-11-10 12:14): always seated when the master has one, >= PAGE_FIT_FLOORS.minAiSkills (5), the most
 *     JD-relevant AI skills first, from the master only. Its floor is the AI profile row's `min`.
 *   - MASTER ONLY: every seated ref is a master skill; a profile core name the master lacks matches nothing and is skipped.
 *
 * WHAT IS DATA (skill-profile.ts): core lists, per-group min/max/order, never-list, twin spellings, JD aliases. WHAT IS
 * CODE (here): how they combine. Runs BEFORE the validator, so the stored tailor_refs re-validate to exactly the stored
 * resume (rebuildOriginal in web tailoredEdits.ts depends on that). Every ref added or dropped is reported, never silent. */
// The most skills one group shows: 10 since Teja 2026-11-21 14:41 ("i wanna increase that cap to 3 more skills in each"),
// 7 from 2026-11-12 13:57. The two-line limit (SKILL_GROUP_MAX_LINES) still binds first when the names run long.
export const SKILLS_PER_GROUP_CAP = 10;
// The most groups one resume shows, and the target the engine FILLS to (orch ruling 2026-11-21, measured by peer 4 r4):
// Teja's 2026-11-12 13:57 ruling is ">= 5 groups, up to 7 skills each" with no group maximum ("max 6" was the 11-11 code,
// not a ruling); his ideals carry 7 groups (25 of 26) and his chat-edited finals 6.7. Filling to 7 still printed 108/108
// stored rows on one real page (0 unsafe).
export const SKILLS_MAX_GROUPS = 7;
// The fewest groups every resume shows (was 3 until 2026-11-11); topped up from the master's groups when needed.
export const SKILLS_MIN_GROUPS = 5;

/* The key two spellings of one skill share ("Express.js" / "express js", "Microsoft Azure" / "azure"): the canonical
   vocabulary term when the one vocabulary knows the name, else the name; either way lowercased with the "Microsoft "
   vendor prefix, spaces, dots, hyphens and a trailing "js" stripped. The SAME normalising runs on both branches, so a
   known spelling ("Express.js" -> term "express") and an unknown one ("express js") still meet. Exported for the test. */
export function skillTwinKey(name: string): string {
  // The shared canonical term when known (the same one resume-assist dedupes twin spellings with), else the name.
  const base = canonicalSkillTerm(name) ?? name;
  // The spelling with its noise removed.
  const key = base.toLowerCase().replace(/^microsoft\s+/, "").replace(/[\s.\-]/g, "").replace(/js$/, "");
  // A name that is ONLY noise ("JS") keeps its own lowercase spelling, never the empty key every such name would share.
  return key === "" ? name.toLowerCase() : key;
}

// Decides the skills section; returns the profile plus the refs it added and dropped, in order.
// `profile` defaults to the live SKILL_PROFILE; tests pass their own so each rule is pinned by data they control.
export function shapeSkillGroups(tailored: TailoredProfile, master: MasterProfile, jobDescription: string, profile: SkillProfile = SKILL_PROFILE): { readonly profile: TailoredProfile; readonly added: readonly string[]; readonly dropped: readonly string[] } {
  // Each master skill by id, so a model pick resolves to its group.
  const byId = new Map(master.skills.map((skill) => [skill.id, skill]));
  // Each master skill's position: the last tie-break everywhere.
  const masterIndex = new Map(master.skills.map((skill, index) => [skill.id, index]));
  // Master categories in first-appearance order: the only source of group names.
  const categories = [...new Set(master.skills.map((skill) => skill.category))];
  // The profile row per category (none = no core, default size).
  const rowOf = new Map(profile.groups.map((row) => [row.category, row]));
  // The AI group's name, from the floors' one home.
  const aiCategory = PAGE_FIT_FLOORS.aiSkillsCategory;
  // The never-list, by twin key, so "slack" and "Slack" are one entry.
  const never = new Set(profile.never.map(skillTwinKey));
  // A name the profile marks as the dropped spelling of a twin, mapped to its kept spelling.
  const twinKeep = new Map(profile.twins.flatMap(([keep, ...drops]) => drops.map((d) => [d, keep] as const)));
  // The posting, classified once into tiered sentences.
  const jd = classifyJd(jobDescription);
  // The posting's AI vocabulary terms (the one extractor), for "RAG" -> "RAG Pipelines" (AI skills only).
  const jdAiTerms = extractJdKeywords(jobDescription).filter((term) => AI_VOCABULARY_TERMS.has(term));
  // A skill's tier: its name and its profile aliases, plus (AI skills only) any posting AI term inside its name. The AI-only
  // restriction keeps "caching" in a backend JD from promoting "Prompt Caching" (review finding, 2026-11-10).
  const tierOf = (skill: { readonly name: string; readonly category: string }): JdTier | null => jdTierOf([
    // The master spelling (alias-aware through the vocabulary: "Postgres" credits PostgreSQL).
    skill.name,
    // How JDs say it differently ("data structures" for DSA).
    ...(profile.aliases[skill.name] ?? []),
    // An AI vocabulary term the posting names, when it sits inside this AI skill's name.
    ...(skill.category === aiCategory ? jdAiTerms.filter((term) => keywordAppearsIn(term, skill.name)) : []),
  ], jd);
  // The tier weight (0 = the posting never names it).
  const weightOf = (skill: { readonly name: string; readonly category: string }): number => { const t = tierOf(skill); return t === null ? 0 : JD_TIER_WEIGHT[t]; };
  // The master skills that may ship at all: not never-listed, and not the dropped spelling of a twin the master also holds.
  const eligible = master.skills.filter((s) => !never.has(skillTwinKey(s.name)) && !(twinKeep.has(s.name) && master.skills.some((k) => k.name === twinKeep.get(s.name) && k.category === s.category)));
  // Per group: how much of the posting it covers, tier-weighted.
  const coverage = new Map(categories.map((c) => [c, eligible.filter((s) => s.category === c).reduce((sum, s) => sum + weightOf(s), 0)]));
  // The groups the model picked a resolvable skill in. An unresolved ref belongs to no group; it is kept below so the
  // validator still refuses it (this function must never launder a fabrication).
  const modelGroups = new Set(tailored.skills.flatMap(({ ref }) => byId.get(ref)?.category ?? []));
  // The model's own group order (D2, 2026-11-07: "its judgement is the best signal left"); groups it skipped go last.
  const modelRank = (c: string): number => { const i = [...modelGroups].indexOf(c); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
  // A group's profile position (rows without one go last), the tie-break after coverage and the model's choice.
  const orderOf = (c: string): number => rowOf.get(c)?.order ?? Number.MAX_SAFE_INTEGER;
  // Groups that hold at least one eligible skill: an all-never group is never seated.
  const seatable = categories.filter((c) => eligible.some((s) => s.category === c));
  // Covered groups first by coverage; then the model's groups in the model's order; then profile order; master order last (stable sort).
  const ranked = [...seatable].sort((a, b) => (coverage.get(b) ?? 0) - (coverage.get(a) ?? 0) || modelRank(a) - modelRank(b) || orderOf(a) - orderOf(b));
  // Covered groups are always candidates; uncovered ones fill up to SKILLS_MAX_GROUPS (2026-11-21: was SKILLS_MIN_GROUPS,
  // which left a median of 5 groups against Teja's 7 and dropped the core of Databases / Tools / CS Fundamentals).
  const covered = ranked.filter((c) => (coverage.get(c) ?? 0) > 0);
  // The fill: the next best uncovered groups, in the same ranking (model's, then profile order, then master).
  const filler = ranked.filter((c) => !covered.includes(c)).slice(0, Math.max(0, SKILLS_MAX_GROUPS - covered.length));
  // The groups in page order, capped at SKILLS_MAX_GROUPS.
  const seated0 = [...covered, ...filler].slice(0, SKILLS_MAX_GROUPS);
  // The AI group always holds a seat when the master has one: where coverage put it, else the last seat.
  const seated = seatable.includes(aiCategory) && !seated0.includes(aiCategory) ? [...seated0.slice(0, SKILLS_MAX_GROUPS - 1), aiCategory] : seated0;
  // The model's resolvable picks, by ref: a seat tie-break after core and the JD.
  const picked = new Set(tailored.skills.filter(({ ref }) => byId.has(ref)).map(({ ref }) => ref));
  // The refs seated, group by group in page order, each group already in display order.
  const chosen: string[] = [];
  // Each seated group.
  for (const category of seated) {
    // Its profile row, if any.
    const row = rowOf.get(category);
    // Its size cap: the row's max, never above the global cap.
    const max = Math.min(row?.max ?? SKILLS_PER_GROUP_CAP, SKILLS_PER_GROUP_CAP);
    // Its core, in profile order, as master skills of THIS group (a core name the master lacks matches nothing).
    const core = (row?.core ?? []).flatMap((name) => eligible.filter((s) => s.category === category && s.name === name));
    // Core position, for the display order.
    const coreRank = new Map(core.map((s, i) => [s.id, i]));
    // The rest of the group, JD-tier first, then the model's picks, then master order.
    const rest = eligible.filter((s) => s.category === category && !coreRank.has(s.id)).sort((a, b) =>
      weightOf(b) - weightOf(a) || Number(picked.has(b.id)) - Number(picked.has(a.id)) || (masterIndex.get(a.id) ?? 0) - (masterIndex.get(b.id) ?? 0));
    // SELECTION order: core first (Teja: "each group ships a fixed core, then fills ... with JD-ranked master skills").
    const candidates = [...core, ...rest];
    // One spelling per canonical term (vocabulary twins such as "Express.js" / "express js"), first in selection order.
    const keys = new Set<string>();
    // Filtered in selection order.
    const unique = candidates.filter((s) => { const k = skillTwinKey(s.name); if (keys.has(k)) return false; keys.add(k); return true; });
    // The group filled to at most two printed lines at every rung, and at most `max` names.
    let names = fillSkillLines(category, unique.map((s) => s.name), max);
    // The group's floor (the AI row's 5), capped at what the master can supply.
    const floor = Math.min(row?.min ?? 0, unique.length, max);
    // Under the floor (long names): refill with the shortest remaining names; real master skills either way.
    if (names.length < floor) {
      // The unseated names, shortest first (stable, so selection order breaks a length tie).
      const spare = unique.map((s) => s.name).filter((n) => !names.includes(n)).sort((a, b) => a.length - b.length);
      // The same two-line rule; the seated names already fit, so they stay.
      names = fillSkillLines(category, [...names, ...spare], max);
    }
    // The seated skills, back from names (unique, so a name names one skill).
    const seatedSkills = names.map((n) => unique.find((s) => s.name === n)!);
    // DISPLAY order (2026-11-18 21:47): JD tier, then core position, then the model's picks, then master order.
    seatedSkills.sort((a, b) => weightOf(b) - weightOf(a) || (coreRank.get(a.id) ?? Infinity) - (coreRank.get(b.id) ?? Infinity) || Number(picked.has(b.id)) - Number(picked.has(a.id)) || (masterIndex.get(a.id) ?? 0) - (masterIndex.get(b.id) ?? 0));
    // Appended in page order.
    chosen.push(...seatedSkills.map((s) => s.id));
  }
  // The refs added: seated, not a model pick.
  const added = chosen.filter((ref) => !picked.has(ref));
  // The model's resolvable picks that did not get a seat (group not shown, never-list, twin, line or cap), reported.
  const dropped = [...picked].filter((ref) => !chosen.includes(ref));
  // The seated entries; a model pick keeps its own object.
  const pool = chosen.map((ref) => tailored.skills.find((k) => k.ref === ref) ?? { ref });
  // Unresolved refs last, kept so the validator still refuses them (never laundered by being left out).
  const skills = [...pool, ...tailored.skills.filter(({ ref }) => !byId.has(ref))];
  // The shaped section.
  return { profile: { ...tailored, skills }, added, dropped };
}

/** A master entry's words for JD ranking: its name or label, description, and bullet texts. */
function entryWords(entry: { readonly name?: string; readonly label?: string; readonly description?: string | null; readonly bullets?: readonly { readonly text: string }[] } | undefined): string {
  // Missing parts are just absent.
  return entry === undefined ? "" : [entry.name ?? entry.label ?? "", entry.description ?? "", ...(entry.bullets ?? []).map((b) => b.text)].join(" ");
}

/**
 * MOST-NEEDED FIRST for projects and achievements (Teja 2026-11-18 21:47: "Projects: same ordering ... Achievements:
 * same ordering"). Each entry is scored by the JD vocabulary terms its master text contains, weighted by the tier the
 * posting gives each term (required > preferred > mentioned); a stable sort keeps the given order on a tie. Ordering
 * only: which entries ship (max 2 projects, every achievement) stays with enforceContentRules. Exported for the test.
 */
export function orderByJdRelevance(tailored: TailoredProfile, master: MasterProfile, jobDescription: string): TailoredProfile {
  // The posting, classified once.
  const jd = classifyJd(jobDescription);
  // The posting's vocabulary terms with their tier weights.
  const termWeights = extractJdKeywords(jobDescription).map((term) => [term, JD_TIER_WEIGHT[jdTierOf([term], jd) ?? "mentioned"]] as const);
  // An entry's score: the weights of the posting terms its master text names.
  const score = (text: string): number => termWeights.reduce((sum, [term, w]) => sum + (keywordAppearsIn(term, text) ? w : 0), 0);
  // Master projects and achievements by id.
  const projects = new Map(master.projects.map((p) => [p.id, p]));
  // Same for achievements.
  const achievements = new Map(master.achievements.map((a) => [a.id, a]));
  // Sorted copies (Array.prototype.sort is stable), highest score first.
  const byScore = <T extends { readonly ref: string }>(list: readonly T[], of: (ref: string) => string): T[] =>
    list.map((e, i) => ({ e, s: score(of(e.ref)), i })).sort((a, b) => b.s - a.s || a.i - b.i).map(({ e }) => e);
  // Both sections reordered; nothing else touched.
  return {
    ...tailored,
    // Projects, most JD-relevant first.
    projects: byScore(tailored.projects, (ref) => entryWords(projects.get(ref) as Parameters<typeof entryWords>[0])),
    // Achievements, same.
    achievements: byScore(tailored.achievements, (ref) => entryWords(achievements.get(ref) as Parameters<typeof entryWords>[0])),
  };
}

/* The bullets a one-shot rewrite may fix, with their untraceable words, or null for "do not retry"
 * (2026-11-05). Retry ONLY when every violation is an unverifiable_token AND sits on a bullet of this
 * profile: the rewrite only rewrites bullets, so a summary, skill, ref or metric problem would waste the
 * call and fail anyway. Exported for the test. */
export function retryableBullets(violations: readonly TailorViolation[], profile: TailoredProfile): Map<string, string[]> | null {
  // Every bullet ref in the first attempt, across every bullet-carrying section.
  const bulletRefs = new Set<string>();
  // The five sections whose nodes carry bullets.
  for (const section of [profile.experience, profile.projects, profile.education, profile.achievements, profile.certifications]) {
    // Each node's bullets, when it has any.
    for (const node of section as readonly { readonly bullets?: readonly { readonly ref: string }[] }[]) for (const b of node.bullets ?? []) bulletRefs.add(b.ref);
  }
  // Grouped by bullet, in the order reported.
  const byBullet = new Map<string, string[]>();
  // Every violation must qualify, or none is retried.
  for (const v of violations) {
    // Any other kind, or a word not on a bullet of this profile: no retry.
    if (v.kind !== "unverifiable_token" || !bulletRefs.has(v.ref)) return null;
    // The word, under its bullet.
    byBullet.set(v.ref, [...(byBullet.get(v.ref) ?? []), v.token]);
  }
  // Nothing to fix is not a retry either.
  return byBullet.size > 0 ? byBullet : null;
}

/* The master text of every bullet, by id, from every bullet-carrying section of the master. */
function masterBulletTexts(master: MasterProfile): Map<string, string> {
  // Id to text.
  const texts = new Map<string, string>();
  // The same five bullet-carrying sections, from the pinned master.
  for (const section of [master.experience, master.projects, master.education, master.achievements, master.certifications]) {
    // Each node's bullets, when it has any.
    for (const node of section as readonly { readonly bullets?: readonly { readonly id: string; readonly text: string }[] }[]) for (const b of node.bullets ?? []) texts.set(b.id, b.text);
  }
  // Complete for the pinned master.
  return texts;
}

/* The rewrite reply, validated: exactly one {ref, text} per asked bullet, no others. Null = unusable. */
function parseRewriteReply(raw: string, asked: ReadonlySet<string>): Map<string, string> | null {
  // Prose or broken JSON is unusable, not a throw: the first verdict is still a verdict.
  let parsed: unknown;
  // A parse failure is the reply's problem, recorded as reply_unusable.
  try { parsed = JSON.parse(raw); } catch { return null; }
  // The one array.
  const bullets = isRecord(parsed) && Array.isArray(parsed.bullets) ? parsed.bullets : null;
  // No array, no answer.
  if (bullets === null) return null;
  // Ref to new text.
  const out = new Map<string, string>();
  // Each entry proven before it is kept.
  for (const b of bullets) {
    // Shape, a ref that was asked for, and no ref twice.
    if (!isRecord(b) || typeof b.ref !== "string" || typeof b.text !== "string" || !asked.has(b.ref) || out.has(b.ref)) return null;
    // Kept.
    out.set(b.ref, b.text);
  }
  // Every asked bullet answered: no partial merge.
  return out.size === asked.size ? out : null;
}

/* The first attempt with exactly these bullets' text replaced; nothing else changes. */
function mergeRewrites(profile: TailoredProfile, rewrites: ReadonlyMap<string, string>): TailoredProfile {
  // One section's nodes, each node's bullets rewritten where asked.
  const rewrite = <T extends { readonly bullets?: readonly { readonly ref: string; readonly text: string }[] }>(nodes: readonly T[]): T[] =>
    // A node without bullets is returned as is.
    nodes.map((node) => (node.bullets === undefined ? node : { ...node, bullets: node.bullets.map((b) => (rewrites.has(b.ref) ? { ...b, text: rewrites.get(b.ref)! } : b)) }));
  // Every bullet-carrying section; the rest as parsed.
  return { ...profile, experience: rewrite(profile.experience), projects: rewrite(profile.projects), education: rewrite(profile.education), achievements: rewrite(profile.achievements), certifications: rewrite(profile.certifications) } as TailoredProfile;
}

// One posting in, one verdict out. Named so call sites read as a noun.
export type Tailorer = (input: TailorJobInput) => Promise<TailorOutcome>;

// Narrow `unknown` to a plain object without asserting anything about its fields.
function isRecord(value: unknown): value is Record<string, unknown> {
  // Arrays are objects to `typeof`, and null is too; both must be excluded before any
  // property access below can be trusted.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every element of the five ref-plus-bullets sections has the same shape, so it is
// checked once here rather than five times inconsistently.
function hasRefAndBullets(value: unknown): boolean {
  // A node without a `ref` names nothing, and the validator would index `undefined`.
  if (!isRecord(value) || typeof value.ref !== "string") return false;
  // `bullets` is walked directly by the validator; a missing array crashes it.
  return Array.isArray(value.bullets);
}

// The arrays the parser refuses to go without. EXPORTED so the structural test can hold
// `TAILOR_RESPONSE_SCHEMA.required` against this exact tuple: the parser demanded the
// two award arrays while the schema never offered them, so with structured output every
// live call threw "no achievements array". One constant, read by both, ends that class.
export const TAILOR_REQUIRED_ARRAY_KEYS = [
  // Bare refs, no bullets.
  "skills",
  // Bullet-bearing parents from here down; the second parser loop walks these.
  "experience",
  // Projects.
  "projects",
  // Qualifications.
  "education",
  // Awards.
  "achievements",
  // Credentials.
  "certifications",
] as const;

// THE SHAPE CHECK, and the reason it lives in this file rather than in the validator.
//
// `validateTailoredProfile` takes a `TailoredProfile` and TRUSTS that type — it walks
// `tailored.skills` (validator.ts:489), `tailored.achievements` (:646) and
// `tailored.certifications` (:688) with no runtime guard. Types are erased at runtime,
// so handing it raw `JSON.parse` output would surface a bad model response as a
// TypeError from inside the honesty checker: our bug's stack trace for their mistake.
//
// §5's rule, applied literally: validate the SHAPE you expect. This asks "is this the
// object I was promised", never "did the parser give up".
function parseTailoredProfile(raw: string): TailoredProfile {
  // Declared outside the try so the thrown message below can stay about SHAPE, not
  // about syntax, once parsing has succeeded.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A model that returned prose has not tailored anything. Rethrown with our own
    // message because `JSON.parse`'s mentions a character offset into text the caller
    // never sees.
    throw new Error("Tailor response was not JSON");
  }

  // Everything below is a claim the validator would otherwise make on our behalf by
  // crashing. Each one is a property the validator dereferences unconditionally.
  if (!isRecord(parsed)) throw new Error("Tailor response was not a JSON object");
  // The pin the validator compares against; a non-number would compare unequal forever.
  if (typeof parsed.master_version !== "number") throw new Error("Tailor response has no numeric master_version");
  // Drives which sections render, and is iterated.
  if (!Array.isArray(parsed.section_order)) throw new Error("Tailor response has no section_order array");
  // Required arrays, possibly empty — the contract makes them required precisely so an
  // omission cannot be mistaken for a deliberate empty selection.
  // Iterates the exported tuple rather than a local list, so the structural test checks
  // the very keys this loop demands and the two cannot drift apart again.
  for (const key of TAILOR_REQUIRED_ARRAY_KEYS) {
    // Checked by name so the error says which one, rather than "malformed response".
    if (!Array.isArray(parsed[key])) throw new Error(`Tailor response has no ${key} array`);
  }
  // The five sections whose elements carry nested bullets the validator walks. `skills`
  // is excluded deliberately: a `TailoredSkill` is a bare ref with no bullets at all.
  for (const key of TAILOR_REQUIRED_ARRAY_KEYS) {
    // Skipped by name, not by a second hand-kept list that could drift from the first.
    if (key === "skills") continue;
    // `as unknown[]` is safe: the loop above already proved each of these is an array.
    if (!(parsed[key] as unknown[]).every(hasRefAndBullets)) {
      throw new Error(`Tailor response has a malformed entry in ${key}`);
    }
  }
  // Summary is nullable, so only a non-null value has a shape to check — and it is the
  // one place the model emits free prose, which the validator checks against its refs.
  // The schema leaves `summary` optional, so a schema-valid response may OMIT it — and
  // the validator dereferences any non-null summary, so `undefined` would crash it.
  // Omission and null mean the same thing here (no paragraph), so normalise to null.
  if (parsed.summary === undefined) parsed.summary = null;
  // Only a present, non-null summary has a shape left to check.
  if (parsed.summary !== null) {
    if (!isRecord(parsed.summary) || typeof parsed.summary.text !== "string" || !Array.isArray(parsed.summary.refs)) {
      throw new Error("Tailor response has a malformed summary");
    }
  }
  // The picked summary variant (pending #11, 2026-11-07): absent, null or a string id, kept AS HELD so
  // tailor_refs re-validates to the stored resume. Any other shape is a malformed reply, never "default".
  if (parsed.summary_variant !== undefined && parsed.summary_variant !== null && typeof parsed.summary_variant !== "string") {
    throw new Error("Tailor response has a malformed summary_variant");
  }

  // THE CONTRACT VERSION. TailoredProfile declares `schema_version: 1`, but the schema sent
  // to Gemini (prompt.ts TAILOR_RESPONSE_SCHEMA) has no such property, so a live reply never
  // carries it, and the cast below used to persist tailor_refs without it. The web editor's
  // gate then refused every live row (applyyy-e8, 2026-10-08). Absent means "the version we
  // asked for", so stamp it; any OTHER value is a contract we do not speak, so refuse it
  // like every other shape failure rather than overwrite it.
  if (parsed.schema_version !== undefined && parsed.schema_version !== 1) {
    throw new Error("Tailor response has an unsupported schema_version");
  }
  // Stamped here, at the one parse boundary, so every stored tailor_refs matches its type.
  parsed.schema_version = 1;

  // Every field the validator touches has now been checked to exist and be the right
  // kind. The assertion is earned by the lines above, not assumed.
  return parsed as unknown as TailoredProfile;
}

/**
 * Fit a validated tailoring on one page (Teja, 2026-11-07: "1 page only, this is rule").
 * page-trim.ts decides on the RESOLVED resume (the same pure call the web makes after an edit);
 * each removal is then applied to the REF profile by ref and the result re-validated by the
 * unchanged gate. The re-validated resume must equal the trimmed one exactly, or the row fails:
 * tailor_refs has to re-validate to precisely the stored resume (rebuildOriginal depends on it),
 * and a mismatch would mean the two shapes disagree about what was removed.
 */
export function fitTailoredToOnePage(
  refs: TailoredProfile,
  resume: ResolvedResume,
  jdKeywords: readonly string[],
  revalidate: (refs: TailoredProfile) => ResolvedResume | null,
): { readonly kind: "fits"; readonly refs: TailoredProfile; readonly resume: ResolvedResume; readonly trimmed: readonly TrimItem[] } | { readonly kind: "overflow"; readonly violation: TailorViolation } {
  // The decision, on the resolved resume.
  const fit = fitToOnePage(resume, jdKeywords);
  // The floors themselves overflow: refused, naming them.
  if (!fit.fits) return { kind: "overflow", violation: { kind: "page_overflow", blockedBy: fit.blockedBy } };
  // Nothing removed: the validated pair stands as it is.
  if (fit.trimmed.length === 0) return { kind: "fits", refs, resume, trimmed: [] };
  // The same removals, applied to the refs.
  const trimmedRefs = fit.trimmed.reduce((acc, item) => withoutTrimmed(acc, item), refs);
  // Re-validated by the unchanged gate: a trim is trusted for nothing.
  const again = revalidate(trimmedRefs);
  // The refs must resolve to exactly the resume page-trim produced; anything else fails closed.
  if (again === null || JSON.stringify(again) !== JSON.stringify(fit.resume)) {
    // Named as a page_overflow with the reason, so the row fails rather than storing a mismatch.
    return { kind: "overflow", violation: { kind: "page_overflow", blockedBy: ["trimmed refs did not re-validate to the trimmed resume"] } };
  }
  // The stored pair.
  return { kind: "fits", refs: trimmedRefs, resume: again, trimmed: fit.trimmed };
}

// Build a tailorer bound to one model and one pinned master profile.
export function createTailorer(deps: TailorDeps): Tailorer {
  // Closes over the trusted inputs so each call supplies only the untrusted posting.
  return async function tailor(stored: TailorJobInput): Promise<TailorOutcome> {
    // The posting as TEXT (N1, 2026-11-07): stored rows may be raw HTML. Converted once, here, so the
    // prompt, the JD keywords and the skills shape all read the same text. postingText never returns
    // null for a string, so the non-null assertion only restores the type.
    const input: TailorJobInput = { ...stored, jobDescription: postingText(stored.jobDescription)! };

    // Assemble with the scraped fields fenced. Only the master and the pin reach the
    // instruction region; the posting goes to the untrusted region as text.
    const prompt = buildTailorPrompt({
      master: deps.master,
      masterVersion: deps.masterVersion,
      jobTitle: input.jobTitle,
      company: input.company,
      jobDescription: input.jobDescription,
    });

    // The one impure step. Everything before and after it is a pure function.
    const raw = await deps.callLlm(prompt);

    // Throws on prose or a wrong-shaped object — see the header on why that is not a
    // refusal. Deliberately before the validator, so the validator only ever sees the
    // type it was written against.
    const parsed = parseTailoredProfile(raw);

    // Repeated refs normalised away BEFORE the gate (see dedupeRepeatedRefs: normalisation, never
    // leniency). The deduplicated profile is the one validated AND the one stored, so tailor_refs
    // re-validates to exactly the stored resume.
    const { profile: deduplicated, deduped } = dedupeRepeatedRefs(parsed);

    // The skills shape (relevant groups, floor per group), after dedupe (so a repeat never counts toward a
    // group) and BEFORE the gate (so every added ref is resolved by the unchanged validator, and the stored
    // refs match the resume).
    // D1 (Teja, 2026-11-07 10:38 IST; live row ef1e796a failed over one invented "skill_openai"): a SKILL
    // ref the master does not hold is dropped here and recorded, never printed and never fatal. Skills only:
    // a skill line is a bare ref with no text, so dropping one removes a claim and writes none. Every other
    // invented ref (bullet, entry, summary) still reaches the gate and is refused.
    const masterSkillIds = new Set(deps.master.skills.map((skill) => skill.id));
    // The invented skill refs, in the model's order, for the event.
    const skillsInvented = deduplicated.skills.filter(({ ref }) => !masterSkillIds.has(ref)).map(({ ref }) => ref);
    // The answer without them (the same object when there are none, so nothing else changes).
    const honest = skillsInvented.length === 0 ? deduplicated : { ...deduplicated, skills: deduplicated.skills.filter(({ ref }) => masterSkillIds.has(ref)) };
    // The shape runs on the honest answer.
    const { profile: shaped, added: skillsAdded, dropped: skillsDropped } = shapeSkillGroups(honest, deps.master, input.jobDescription);

    // The posting's keywords, once: content top-ups and page-fit rank by them, and they are stored with the resume.
    const jdKeywords = extractJdKeywords(input.jobDescription);
    // THE CONTENT RULES (Teja, 2026-11-08 15:36 + 15:46 IST), in code because a prompt is not a control: exactly
    // min(2, master) projects, and every floor topped up from master text verbatim. On the REFS and BEFORE the gate,
    // so every added ref is resolved by the unchanged validator and the stored refs re-validate to the stored resume.
    // The cited summary variant is picked first (LSEG 2b7db9a2), so the gate accepts the summary it cites.
    const { profile: enforcedRaw, changes: contentRuleChanges } = enforceContentRules(pickCitedVariant(shaped, deps.master), deps.master, jdKeywords);
    // MOST-NEEDED FIRST (2026-11-18 21:47): projects and achievements ordered by JD relevance; which ones ship is unchanged.
    const enforced = orderByJdRelevance(enforcedRaw, deps.master, input.jobDescription);
    // Rule 5 (2026-11-08): the header names the role applied for, cleaned of seniority; stored in the refs so the
    // rebuild prints the same title. No usable title: the refs stay as they were and the headline falls back as before.
    const roleTitle = cleanRoleTitle(input.jobTitle);
    // The profile the gate sees and the row stores.
    const tailored: TailoredProfile = roleTitle === null ? enforced : { ...enforced, headline_title: roleTitle };

    // The honesty gate. This is the only call in the codebase that can produce a
    // `ResolvedResume`, which is what makes "the renderer cannot resolve a ref even by
    // accident" a property of the code rather than a promise.
    const validation = validateTailoredProfile(tailored, deps.master, deps.masterVersion);
    // The same gate as a resolver, for re-validating a page-trimmed profile (null = refused).
    const revalidate = (refs: TailoredProfile): ResolvedResume | null => {
      // Same master, same version: a trimmed profile gets no easier treatment.
      const verdict = validateTailoredProfile(refs, deps.master, deps.masterVersion);
      // Only the resume, or null.
      return verdict.ok ? verdict.resume : null;
    };

    // A refusal is DATA, not an exception: the violations are the dashboard's content
    // and the reason the row will be failed with something a human can act on.
    if (!validation.ok) {
      // The one-shot rewrite (2026-11-05), only when every violation is an untraceable word on a bullet.
      const retryable = retryableBullets(validation.violations, tailored);
      // Anything else fails exactly as before, with no extra call.
      if (retryable === null) return { kind: "refused", violations: validation.violations, retry: null };
      // Each failed bullet's master text (the only source) and its failed wording.
      const masterTexts = masterBulletTexts(deps.master);
      const firstTexts = new Map<string, string>();
      // The first attempt's wording of every bullet, by ref.
      for (const section of [tailored.experience, tailored.projects, tailored.education, tailored.achievements, tailored.certifications]) {
        // Each node's bullets, when it has any.
        for (const node of section as readonly { readonly bullets?: readonly { readonly ref: string; readonly text: string }[] }[]) for (const b of node.bullets ?? []) firstTexts.set(b.ref, b.text);
      }
      // The rewrite request: only the failed bullets.
      const items = [...retryable].map(([ref, tokens]) => ({ ref, masterText: masterTexts.get(ref) ?? "", firstText: firstTexts.get(ref) ?? "", bannedTokens: tokens }));
      // The SAME transport (key pool, fallback, usage row); a transport throw propagates exactly like the first call's.
      const reply = await deps.callLlm(buildBulletRewritePrompt(items));
      // A reply that does not answer exactly the asked bullets merges nothing.
      const rewrites = parseRewriteReply(reply, new Set(retryable.keys()));
      // Unusable: refused on the first verdict, the retry recorded as such.
      if (rewrites === null) return { kind: "refused", violations: validation.violations, retry: { firstViolations: validation.violations, result: "reply_unusable" } };
      // The whole profile, re-validated by the UNCHANGED gate: a rewrite is trusted for nothing.
      const merged = mergeRewrites(tailored, rewrites);
      // The gate, run on the whole merged profile against the same pinned master.
      const second = validateTailoredProfile(merged, deps.master, deps.masterVersion);
      // Still failing: refused, with both attempts on record.
      if (!second.ok) return { kind: "refused", violations: second.violations, retry: { firstViolations: validation.violations, result: "still_invalid" } };
      // One page (Teja, 2026-11-07), by the same trimmer the web runs on every edit.
      const fittedRetry = fitTailoredToOnePage(merged, second.resume, jdKeywords, revalidate);
      // Over one page at every floor: refused, the retry still on record.
      if (fittedRetry.kind === "overflow") return { kind: "refused", violations: [fittedRetry.violation], retry: { firstViolations: validation.violations, result: "still_invalid" } };
      // The content rules on what will be stored: broken (a master too short is never broken; see content-rules.ts) = refused.
      const brokenRetry = checkContentRules(fittedRetry.resume, deps.master);
      // Named, never stored.
      if (brokenRetry.length > 0) return { kind: "refused", violations: [{ kind: "content_floor", blockedBy: brokenRetry }], retry: { firstViolations: validation.violations, result: "still_invalid" } };
      // Passed: the (possibly trimmed) merged profile is what is stored, so tailor_refs re-validates to this resume.
      return { kind: "tailored", resume: fittedRetry.resume, refs: fittedRetry.refs, jdKeywords, dedupedRefs: deduped, skillsAdded, skillsDropped, skillsInvented, retry: { firstViolations: validation.violations, rewrittenRefs: [...rewrites.keys()] }, pageFitTrimmed: fittedRetry.trimmed, contentRuleChanges };
    }

    // Clean. The resume is safe to persist and to hand to the Auditor, when one exists.
    // `tailored` is the parsed model output that passed validation — the refs, unresolved.
    // `jdKeywords` comes from the SAME posting the model was given, never re-read later,
    // so the keywords and the resume can never describe two different versions of a job.
    // One page (Teja, 2026-11-07), by the same trimmer the web runs on every edit.
    const fitted = fitTailoredToOnePage(tailored, validation.resume, jdKeywords, revalidate);
    // Over one page at every floor: refused with the floors that held, never stored as two pages.
    if (fitted.kind === "overflow") return { kind: "refused", violations: [fitted.violation], retry: null };
    // The content rules on what will be stored (the trimmer stops at the same floors, so this holds unless the master changed).
    const broken = checkContentRules(fitted.resume, deps.master);
    // Named, never stored.
    if (broken.length > 0) return { kind: "refused", violations: [{ kind: "content_floor", blockedBy: broken }], retry: null };
    // The (possibly trimmed) pair, and what was trimmed, for the event.
    return { kind: "tailored", resume: fitted.resume, refs: fitted.refs, jdKeywords, dedupedRefs: deduped, skillsAdded, skillsDropped, skillsInvented, retry: null, pageFitTrimmed: fitted.trimmed, contentRuleChanges };
  };
}
