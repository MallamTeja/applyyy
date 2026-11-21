// THE TAILOR GOLDEN-SET SCORER (tailor plan §6 + §8 parcel 4, 2026-11-21).
//
// Why it exists: a tailor change (peer 4's skills engine, peer 3's prompt) must be judged by NUMBERS against what Teja
// actually wanted before it deploys, not by reading three resumes. Plan §6 rule: a change ships only if golden-set
// recall rises and fabrication stays 0.
//
// Shape: PURE functions over one normalised resume (EvalResume), so the same rules score three very different inputs:
// an ideal file (names), a ref-only tailoring (the tailor's own output) and a stored resolved profile (post-chat).
// The personal data is read by scripts/tailor-golden-eval.mjs at runtime; nothing here touches the filesystem.
//
// Every check reuses the repo's own rule where one exists, so the eval cannot drift from what ships:
// checkHeadline (content-rules.ts), EXPERIENCE_TITLE_ALLOW_LIST + numbersIn (validator.ts), extractJdKeywords +
// keywordAppearsIn + canonicalSkillTerm (jd-keywords.ts). Provenance is the real validator, run by the caller.

// The headline rule the tailor ships with.
import { checkHeadline } from "../content-rules.ts";
// The JD vocabulary, its one matching rule, and the alias folder (Postgres = PostgreSQL).
import { canonicalSkillTerm, extractJdKeywords, keywordAppearsIn } from "../jd-keywords.ts";
// The Aczen title allow-list and the number extractor the provenance checks use.
import { EXPERIENCE_TITLE_ALLOW_LIST, numbersIn } from "../validator.ts";
// Types only, erased at runtime.
import type { MasterProfile, TailoredProfile } from "../../contracts/shared-types.ts";

// One printed skill, in page order: its name and the group it prints under.
export interface EvalSkill {
  // As printed.
  readonly name: string;
  // The group (category) it prints under.
  readonly group: string;
}

// A resume reduced to exactly what the rules read. Every adapter below produces this shape.
export interface EvalResume {
  // The whole-resume title, or null when none prints.
  readonly headline: string | null;
  // The summary paragraph, or null when the resume has none (2 live resumes were applied with none).
  readonly summary: string | null;
  // Skills in page order, groups in page order.
  readonly skills: readonly EvalSkill[];
  // How many projects, certifications and achievements print.
  readonly projects: number;
  // Certifications printed.
  readonly certifications: number;
  // Achievements printed.
  readonly achievements: number;
  // The title printed on the allow-listed experience (exp_aczen), or null when that experience is not on the resume.
  readonly aczenTitle: string | null;
}

// What a score needs besides the resume.
export interface EvalContext {
  // The full job description, for the JD-keyword rule.
  readonly jd: string;
  // The posting's job title, for the headline trace; null when unknown.
  readonly jobTitle: string | null;
  // The master the resume was built from: the floors are min(rule, what the master holds), like content-rules.ts.
  readonly master: MasterProfile;
  // The skills Teja wanted, in his order (an ideal's, or the post-chat final set); absent = no skill comparison.
  readonly target?: readonly EvalSkill[];
}

// The skill comparison against a target.
export interface SkillScore {
  // Share of the resume's skills the target wants (1 when the resume prints none: nothing unwanted).
  readonly precision: number;
  // Share of the target's skills the resume prints (the plan §6 headline metric).
  readonly recall: number;
  // Pairwise order agreement over the shared skills (most-needed first); null with fewer than 2 shared.
  readonly order: number | null;
  // Target skills the resume lacks, in target order.
  readonly missing: readonly string[];
  // Resume skills the target does not want, in page order.
  readonly extra: readonly string[];
}

// One resume's score.
export interface EvalScore {
  // Every rule that applied and failed, by its stable name (the table's column keys).
  readonly failedRules: readonly string[];
  // How many rules applied (a rule whose input is absent, e.g. no allow-listed experience, does not apply).
  readonly rulesApplied: number;
  // Passed / applied.
  readonly rulePassRate: number;
  // The target comparison, or null without a target.
  readonly skills: SkillScore | null;
}

// Rule thresholds, each from a Teja ruling. Named so the table and the tests share one spelling.
// >=5 groups (Teja 2026-11-11 "min 5 groups"); <=10 per group (2026-11-21: 7 + 3, was "up to 7" of 2026-11-12 13:57);
// AI >=5 (2026-11-10, W).
const MIN_GROUPS = 5;
// The per-group ceiling.
const MAX_PER_GROUP = 10;
// The AI group floor.
const MIN_AI = 5;
// Certifications floor (2026-11-09 20:41).
const MIN_CERTS = 5;
// Projects ceiling (2026-11-08: max 2 projects).
const MAX_PROJECTS = 2;

// A skill's comparison key: its vocabulary term when it has one (aliases fold), else its trimmed lower-case name.
function skillKey(name: string): string {
  // "Postgres" and "PostgreSQL" share "PostgreSQL"; an unknown name compares by spelling, case aside.
  return canonicalSkillTerm(name) ?? name.trim().toLowerCase();
}

// Text folded for the verbatim check: case and runs of whitespace ignored, punctuation kept.
function folded(text: string): string {
  // Lower case, single spaces, trimmed.
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// The master's own summary paragraphs (main + every variant): a summary equal to one of these is a copy.
function masterSummaries(master: MasterProfile): string[] {
  // The main summary, when the master has one.
  const main = master.summary?.text ?? null;
  // Each variant's paragraph.
  const variants = (master.summary_variants ?? []).map((variant) => variant.summary.text);
  // Non-null, folded.
  return [main, ...variants].filter((text): text is string => typeof text === "string" && text.trim() !== "").map(folded);
}

// Sentences in a paragraph: runs ending in . ! or ? (a trailing run without one still counts).
function sentenceCount(text: string): number {
  // Number-safe: "3.5" does not split, because a sentence end needs whitespace or the end after it.
  return text.split(/(?<=[.!?])\s+/).filter((part) => part.trim() !== "").length;
}

// The pairwise order agreement of two orders over their shared keys: concordant pairs / all pairs.
function orderAgreement(resumeKeys: readonly string[], targetKeys: readonly string[]): number | null {
  // Each target key's rank.
  const targetRank = new Map(targetKeys.map((key, index) => [key, index]));
  // The shared keys, in resume order.
  const shared = resumeKeys.filter((key) => targetRank.has(key));
  // Fewer than two: no pair to agree on, so no score (never a fake 1).
  if (shared.length < 2) return null;
  // Concordant pair count.
  let agree = 0;
  // Every pair counted.
  let pairs = 0;
  // i before j in the resume.
  for (let i = 0; i < shared.length; i += 1) {
    // Each later key.
    for (let j = i + 1; j < shared.length; j += 1) {
      // One more pair.
      pairs += 1;
      // The target agrees when it also ranks i first.
      if (targetRank.get(shared[i]!)! < targetRank.get(shared[j]!)!) agree += 1;
    }
  }
  // The share.
  return agree / pairs;
}

// The skill comparison: alias-folded sets for precision/recall, page order for agreement.
function compareSkills(skills: readonly EvalSkill[], target: readonly EvalSkill[]): SkillScore {
  // Resume keys, deduped, in page order.
  const resumeKeys = [...new Set(skills.map((skill) => skillKey(skill.name)))];
  // Target keys, deduped, in Teja's order.
  const targetKeys = [...new Set(target.map((skill) => skillKey(skill.name)))];
  // Fast membership.
  const targetSet = new Set(targetKeys);
  // Fast membership.
  const resumeSet = new Set(resumeKeys);
  // Shared count.
  const hit = resumeKeys.filter((key) => targetSet.has(key)).length;
  // Names for the table: the target's spelling for missing, the resume's for extra.
  const missing = target.filter((skill, index, all) => !resumeSet.has(skillKey(skill.name)) && all.findIndex((other) => skillKey(other.name) === skillKey(skill.name)) === index).map((skill) => skill.name);
  // The resume's unwanted ones.
  const extra = skills.filter((skill, index, all) => !targetSet.has(skillKey(skill.name)) && all.findIndex((other) => skillKey(other.name) === skillKey(skill.name)) === index).map((skill) => skill.name);
  // The three numbers; an empty side scores 1 (nothing unwanted / nothing wanted), never NaN.
  return { precision: resumeKeys.length === 0 ? 1 : hit / resumeKeys.length, recall: targetKeys.length === 0 ? 1 : hit / targetKeys.length, order: orderAgreement(resumeKeys, targetKeys), missing, extra };
}

// Scores one resume against the rules (and against the target, when given).
export function scoreResume(resume: EvalResume, ctx: EvalContext): EvalScore {
  // Each rule that applies: [name, passed].
  const rules: Array<[string, boolean]> = [];
  // Skills per group, in page order of first appearance.
  const groups = new Map<string, number>();
  // Counted.
  for (const skill of resume.skills) groups.set(skill.group, (groups.get(skill.group) ?? 0) + 1);
  // At least 5 groups.
  rules.push(["groups>=5", groups.size >= MIN_GROUPS]);
  // No group over 10.
  rules.push(["group<=10", [...groups.values()].every((count) => count <= MAX_PER_GROUP)]);
  // The master's AI skills, so a master with 3 is not asked for 5 (content-rules' min(rule, master)).
  const masterAi = ctx.master.skills.filter((skill) => /^ai\b/i.test(skill.category)).length;
  // The resume's AI group: a group named like "AI" / "AI & LLM" (check.js's rule).
  const ai = [...groups.entries()].filter(([group]) => /^ai\b/i.test(group)).reduce((sum, [, count]) => sum + count, 0);
  // Applies only when the master has AI skills at all.
  if (masterAi > 0) rules.push(["ai>=5", ai >= Math.min(MIN_AI, masterAi)]);
  // Certifications: at least 5, or all of them when the master holds fewer.
  rules.push(["certs>=5", resume.certifications >= Math.min(MIN_CERTS, ctx.master.certifications.length)]);
  // Every achievement (2026-11-09).
  rules.push(["all_achievements", resume.achievements >= ctx.master.achievements.length]);
  // At most 2 projects.
  rules.push(["projects<=2", resume.projects <= MAX_PROJECTS]);
  // The allow-listed experience's printed title, when the master has one and it prints.
  const allowed = ctx.master.experience.flatMap((node) => EXPERIENCE_TITLE_ALLOW_LIST[node.id] ?? []);
  // Applies only when there is a list and a title to check.
  if (allowed.length > 0 && resume.aczenTitle !== null) rules.push(["title_allowed", allowed.includes(resume.aczenTitle)]);
  // The headline, by the shipped rule (null = pass); no headline at all fails. Applies only with a job title to trace
  // to: without one, checkHeadline passes only the fallbacks, which would fail an ideal for a missing input (§6).
  if (ctx.jobTitle !== null) rules.push(["headline", resume.headline !== null && checkHeadline(resume.headline, ctx.jobTitle) === null]);
  // The summary rules: present first, the rest only when there is text to read.
  rules.push(["summary_present", resume.summary !== null && resume.summary.trim() !== ""]);
  // Only with text.
  if (resume.summary !== null && resume.summary.trim() !== "") {
    // The paragraph.
    const text = resume.summary;
    // 2-3 sentences (plan §5 P2).
    const sentences = sentenceCount(text);
    // In range.
    rules.push(["summary_2_3_sentences", sentences >= 2 && sentences <= 3]);
    // The JD's vocabulary terms the summary names, by the one matching rule.
    const named = extractJdKeywords(ctx.jd).filter((keyword) => keywordAppearsIn(keyword, text));
    // At least ONE (calibrated 2026-11-21, orch ruling: a plan-derived rule is tuned until the ideals pass). The plan said
    // 2+, but Teja's own ideals name only 1 in 9 of 26 cases (4 JDs yield just 2 terms): >=2 passed 17/26, >=1 passes
    // 25/26 on HEAD's vocabulary. Applies only when the JD yields a term at all (an empty or stub JD names nothing).
    if (extractJdKeywords(ctx.jd).length > 0) rules.push(["summary_jd_keyword", named.length >= 1]);
    // At least one number (that it is REAL is the validator's provenance job, scored separately).
    rules.push(["summary_metric", numbersIn(text).length >= 1]);
    // Not a master summary or variant word for word (case and spacing aside).
    rules.push(["summary_not_verbatim", !masterSummaries(ctx.master).includes(folded(text))]);
  }
  // The names that failed, in rule order.
  const failedRules = rules.filter(([, passed]) => !passed).map(([name]) => name);
  // The score.
  return { failedRules, rulesApplied: rules.length, rulePassRate: rules.length === 0 ? 1 : (rules.length - failedRules.length) / rules.length, skills: ctx.target === undefined ? null : compareSkills(resume.skills, ctx.target) };
}

// The aggregate over a set of scores.
export interface EvalAggregate {
  // How many resumes.
  readonly n: number;
  // Mean recall / precision / order over the scores that have them (null when none do).
  readonly meanRecall: number | null;
  // Mean precision.
  readonly meanPrecision: number | null;
  // Mean order agreement over the scores where it is defined.
  readonly meanOrder: number | null;
  // Mean per-resume rule pass rate.
  readonly meanRulePassRate: number;
  // Share of resumes that pass EVERY rule that applied.
  readonly allRulesPassRate: number;
  // How many resumes failed each rule.
  readonly ruleFailures: Readonly<Record<string, number>>;
}

// The mean of the defined values, or null when there are none.
function mean(values: readonly (number | null | undefined)[]): number | null {
  // Only real numbers.
  const real = values.filter((value): value is number => typeof value === "number");
  // None: no mean (never 0, which would read as "all bad").
  return real.length === 0 ? null : real.reduce((sum, value) => sum + value, 0) / real.length;
}

// Aggregates a set of scores.
export function aggregate(scores: readonly EvalScore[]): EvalAggregate {
  // Failures per rule.
  const ruleFailures: Record<string, number> = {};
  // Counted.
  for (const score of scores) for (const rule of score.failedRules) ruleFailures[rule] = (ruleFailures[rule] ?? 0) + 1;
  // The summary numbers.
  return {
    // How many resumes the means are over.
    n: scores.length,
    // The plan §6 headline number: how much of what Teja wanted the tailor printed.
    meanRecall: mean(scores.map((score) => score.skills?.recall)),
    // How much of what the tailor printed Teja wanted.
    meanPrecision: mean(scores.map((score) => score.skills?.precision)),
    // Most-needed-first agreement, over the resumes where it is defined.
    meanOrder: mean(scores.map((score) => score.skills?.order)),
    // An empty set has no failed rule, so 1 rather than null keeps the gate comparable.
    meanRulePassRate: mean(scores.map((score) => score.rulePassRate)) ?? 1,
    // The strict view: a resume counts only when nothing at all failed.
    allRulesPassRate: scores.length === 0 ? 1 : scores.filter((score) => score.failedRules.length === 0).length / scores.length,
    // Which rule to fix first.
    ruleFailures,
  };
}

// --- adapters: three input shapes, one EvalResume ---------------------------------------------------------------

// A plain-object reader for untrusted JSON: the value at a key, or undefined.
function field(value: unknown, key: string): unknown {
  // Only an object has keys.
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

// A string, or null for anything else (§6: never coerce a missing value into an answer).
function text(value: unknown): string | null {
  // Only a real string.
  return typeof value === "string" ? value : null;
}

// An array's length, or 0 when it is not an array.
function count(value: unknown): number {
  // Only an array counts.
  return Array.isArray(value) ? value.length : 0;
}

// The id of the master's allow-listed experience (exp_aczen today), or null when it has none.
function allowListedExperienceId(ids: readonly string[]): string | null {
  // The first id the allow-list names.
  return ids.find((id) => EXPERIENCE_TITLE_ALLOW_LIST[id] !== undefined) ?? null;
}

// An ideal file (retailor5/appN-ideal.json): names, not ids; skills grouped; the Aczen title given outright.
export function fromIdeal(ideal: unknown): EvalResume {
  // Groups in page order, each skill in its group's order.
  const groups = Array.isArray(field(ideal, "skills")) ? (field(ideal, "skills") as unknown[]) : [];
  // Flattened, shape-checked: a non-string name is skipped, never stringified.
  const skills = groups.flatMap((group) => {
    // The group's name.
    const name = text(field(group, "group")) ?? "";
    // Its skills.
    const list = Array.isArray(field(group, "skills")) ? (field(group, "skills") as unknown[]) : [];
    // Each real name under this group.
    return list.filter((skill): skill is string => typeof skill === "string").map((skill) => ({ name: skill, group: name }));
  });
  // The normalised resume.
  return {
    // The ideal's own headline string.
    headline: text(field(ideal, "headline")),
    // Its summary paragraph (sources are provenance, scored by check.js, not here).
    summary: text(field(field(ideal, "summary"), "text")),
    // The grouped names, flattened in page order above.
    skills,
    // Entries are counted, not resolved: the ideals name them by label.
    projects: count(field(ideal, "projects")),
    // Certification labels.
    certifications: count(field(ideal, "certifications")),
    // Achievement labels.
    achievements: count(field(ideal, "achievements")),
    // Given outright by the ideal.
    aczenTitle: text(field(ideal, "aczen_title")),
  };
}

// A ref-only tailoring (applications.tailor_refs: the tailor's own output), resolved through ITS master version.
export function fromTailorRefs(refs: TailoredProfile, master: MasterProfile): EvalResume {
  // Master skills by id.
  const skillById = new Map(master.skills.map((skill) => [skill.id, skill]));
  // Skills in the tailoring's order; an unknown ref is dropped (the validator reports it), never named.
  const skills = (refs.skills ?? []).flatMap((selected) => {
    // The master node.
    const node = skillById.get(selected.ref);
    // Its name and group, or nothing.
    return node === undefined ? [] : [{ name: node.name, group: node.category }];
  });
  // The picked variant, when one was picked and exists.
  const variant = (master.summary_variants ?? []).find((candidate) => candidate.id === refs.summary_variant);
  // The headline in the validator's precedence: headline_title, else the variant's, else the master's.
  const headline = refs.headline_title ?? variant?.headline ?? master.identity.headline ?? null;
  // The allow-listed experience, when the tailoring prints it.
  const aczenId = allowListedExperienceId((refs.experience ?? []).map((entry) => entry.ref));
  // Its printed title: the role_title when one was picked, else the master's role.
  const aczenEntry = (refs.experience ?? []).find((entry) => entry.ref === aczenId);
  // The master node for its role.
  const aczenNode = master.experience.find((node) => node.id === aczenId);
  // The title, or null when the experience is not on this resume.
  const aczenTitle = aczenEntry === undefined ? null : (aczenEntry as { role_title?: string }).role_title ?? aczenNode?.role ?? null;
  // The normalised resume.
  return {
    // Resolved in the validator's precedence above.
    headline,
    // The model's paragraph; null when the tailor wrote none.
    summary: refs.summary?.text ?? null,
    // Master names in the tailoring's order.
    skills,
    // Entries selected, by count.
    projects: count(refs.projects),
    // Certifications selected.
    certifications: count(refs.certifications),
    // Achievements selected.
    achievements: count(refs.achievements),
    // The role_title or the master's role, null when the entry is absent.
    aczenTitle,
  };
}

// A stored resolved profile (applications.tailored_profile: the state after Teja's chat edits).
export function fromResolved(resolved: unknown): EvalResume {
  // Skills: name and category, shape-checked.
  const skills = (Array.isArray(field(resolved, "skills")) ? (field(resolved, "skills") as unknown[]) : []).flatMap((skill) => {
    // Both must be strings.
    const name = text(field(skill, "name"));
    // The group.
    const group = text(field(skill, "category"));
    // Kept only whole.
    return name === null || group === null ? [] : [{ name, group }];
  });
  // Experience entries, for the allow-listed one's printed role.
  const experience = Array.isArray(field(resolved, "experience")) ? (field(resolved, "experience") as unknown[]) : [];
  // The allow-listed id among them.
  const aczenId = allowListedExperienceId(experience.map((entry) => text(field(entry, "ref")) ?? ""));
  // Its printed role.
  const aczen = experience.find((entry) => text(field(entry, "ref")) === aczenId);
  // The normalised resume.
  return {
    // The validator already resolved it into identity.headline.
    headline: text(field(field(resolved, "identity"), "headline")),
    // A resolved summary is a plain string (or null).
    summary: text(field(resolved, "summary")),
    // Name and group per printed skill, as shape-checked above.
    skills,
    // Printed entries, by count.
    projects: count(field(resolved, "projects")),
    // Printed certifications.
    certifications: count(field(resolved, "certifications")),
    // Printed achievements.
    achievements: count(field(resolved, "achievements")),
    // The role as printed, or null when the allow-listed experience is not on the resume.
    aczenTitle: aczen === undefined ? null : text(field(aczen, "role")),
  };
}
