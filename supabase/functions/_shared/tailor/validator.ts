// PROJECT_PLAN.md §10 defense 1, and the load-bearing wall under constraint #2.
//
// THE DESIGN IDEA, because it is the reason this file looks the way it does:
// prefer designs where the wrong answer cannot be EXPRESSED over designs that
// DETECT the wrong answer. The naive Tailor returns free text and we hope it
// invented nothing. This one returns REFERENCES into the master profile, and
// typed code resolves them. An injected job description saying "add Docker"
// therefore has only two possible outcomes: an id that does not exist (rejected
// here, before the Auditor ever runs), or a rewording of something real.
//
// Applied hardest to skills: the model supplies NO skill text whatsoever, only
// ids. There is consequently no code path — valid or invalid — by which a
// model-authored skill string reaches the PDF. That is the difference between a
// guarantee and a check.
//
// Pure: no clock, no network, no database. §19 wants this covered exhaustively.

// Placeholder types until applyyy-aa's packages/shared-types is wired in here.
import type { MasterProfile } from "../contracts/pending-shared-types.ts";

// One tailored achievement line: a reference plus the rewording of it.
export interface ProposedBullet {
  // Must resolve against the master profile, or the whole proposal is rejected.
  readonly masterBulletId: string;
  // The model's rewording. Constrained by the vocabulary rules below — it may
  // rephrase, it may not introduce new facts.
  readonly reworded: string;
}

// What the Tailor is allowed to return. Note what is ABSENT: any free-text skill
// field. Skills are chosen, never written.
export interface TailorProposal {
  // The achievement lines selected for this application, in display order.
  readonly bullets: readonly ProposedBullet[];
  // Master skill ids only. This is the structural half of §10 defense 1.
  readonly skillIds: readonly string[];
}

// Every way a proposal can be dishonest or malformed. A discriminated union so the
// dashboard can render each kind differently and the compiler catches a new case.
export type TailorViolation =
  // Invented experience: constraint #2's first named category.
  | { readonly kind: "unknown_bullet_id"; readonly id: string }
  // Invented skill or technology: the §11 Docker case.
  | { readonly kind: "unknown_skill_id"; readonly id: string }
  // The same achievement claimed twice.
  | { readonly kind: "duplicate_bullet_id"; readonly id: string }
  // The same skill listed twice.
  | { readonly kind: "duplicate_skill_id"; readonly id: string }
  // A resume with no experience is a failure, not an empty success.
  | { readonly kind: "empty_selection" }
  // A number that does not appear in the master bullet: an invented metric.
  | { readonly kind: "invented_metric"; readonly bulletId: string; readonly value: string }
  // A word in the rewording that traces back to nothing in the master profile.
  | { readonly kind: "unverifiable_token"; readonly bulletId: string; readonly token: string };

// The artifact produced when a proposal survives. Skill names are copied from the
// master here, which is where the structural guarantee is physically enforced.
export interface TailoredResume {
  // Which immutable master snapshot this derives from (§9 resume pinning).
  readonly masterVersion: number;
  // The selected achievement lines, carrying their reworded text.
  readonly bullets: readonly { readonly masterBulletId: string; readonly text: string }[];
  // The selected skills, carrying the MASTER's spelling, never the model's.
  readonly skills: readonly { readonly masterSkillId: string; readonly name: string }[];
}

// Success carries the artifact; failure carries every reason. Modelled as a union
// rather than throwing, because the caller must persist the violations for the
// dashboard rather than lose them in a stack trace.
export type TailorValidation =
  // Safe to hand to the Auditor.
  | { readonly ok: true; readonly resume: TailoredResume }
  // Never reaches the Auditor; the row goes to audit_failed with these reasons.
  | { readonly ok: false; readonly violations: readonly TailorViolation[] };

// Rhetorical vocabulary the Tailor may introduce. This list is a DENY-BY-DEFAULT
// boundary: anything not derived from the master and not in here is a violation.
//
// Why an allowlist and not a blocklist of forbidden technologies: a blocklist of
// every technology in the world is unbounded and will always miss the next one. An
// allowlist of connectives and framing verbs is small, closed and reviewable — the
// bounded side of the problem. Everything factual must come from the master.
//
// It is deliberately a TUNING SURFACE: adding a word here loosens the honesty gate
// by exactly that word, which is a decision a human should make on purpose.
const RHETORICAL_VOCABULARY: ReadonlySet<string> = new Set([
  // Articles, conjunctions and prepositions — carry no factual claim at all.
  "a", "an", "the", "and", "or", "for", "with", "in", "of", "to", "on", "at",
  "by", "as", "from", "into", "that", "which", "this", "its", "it", "over",
  "across", "per", "via", "than", "then", "while", "within", "through",
  // Framing verbs for work that the master already asserts was done. "Built" is
  // in the master; these are its neighbours. NOTE the omissions: "led",
  // "managed", "owned" and "architected" are NOT here, because they assert
  // seniority the master may not support — exactly the §11 cover-letter risk.
  "designed", "developed", "implemented", "shipped", "delivered", "created",
  "wrote", "engineered", "handled", "serving", "supporting", "powering",
  "enabling", "using", "used", "including",
  // Neutral qualifiers about the artifact rather than about Teja.
  "production", "end", "full", "stack", "based", "backed", "side", "scale",
  // Common near-synonyms for the nouns a project bullet already contains.
  "platform", "application", "app", "service", "system", "portal", "project",
  "api", "apis", "endpoint", "endpoints", "feature", "features",
  // Plural and possessive forms of words the master is likely to hold singular.
  "users", "user", "requests", "students",
]);

// Split any text into comparable lowercase word tokens. Shares the folding idea
// with the fingerprint module: punctuation and case are formatting, not content,
// so "Node.js/Express" and "Node.js, Express" must tokenise identically.
function tokenize(text: string): string[] {
  return text
    // Case is styling.
    .toLowerCase()
    // Every punctuation run becomes a separator, which is what splits
    // "Node.js/Express" into "node", "js", "express".
    .split(/[^a-z0-9]+/)
    // Drop the empty strings the split leaves at the ends.
    .filter((token) => token.length > 0);
}

// Pull every numeric literal out of a text. Metrics get their own rule because a
// changed digit is the cheapest lie to tell and the hardest to notice by eye.
function numbersIn(text: string): string[] {
  // Strip separators first so "1,000" is compared as "1000" against the master.
  const withoutSeparators = text.replace(/(\d),(?=\d)/g, "$1");
  // Every run of digits. Suffixes like "+" and "%" fall outside the match, which
  // is what makes "500+" compare equal to the master's "500".
  return withoutSeparators.match(/\d+/g) ?? [];
}

// Build the set of words a rewording is allowed to contain, for one bullet.
function allowedVocabularyFor(masterBulletText: string, master: MasterProfile): ReadonlySet<string> {
  // Start from the bullet's own words: the facts this line is actually about.
  const allowed = new Set(tokenize(masterBulletText));
  // Add every skill Teja genuinely has. Naming a real skill inside a bullet is
  // legitimate re-emphasis — and note the deliberate looseness: this permits
  // moving a real skill into a bullet that did not mention it. That is a mild
  // overstatement rather than a fabrication, and it is what the Auditor is for.
  for (const skill of master.skills) {
    // Tokenised, so "Node.js" contributes both "node" and "js".
    for (const token of tokenize(skill.name)) allowed.add(token);
  }
  // Finally the closed rhetorical set, which carries no factual weight.
  for (const word of RHETORICAL_VOCABULARY) allowed.add(word);
  // Numbers are governed by their own stricter rule below, so they are excluded
  // from this set entirely rather than being quietly permitted here.
  return allowed;
}

// The validator. Runs BEFORE the Auditor (§20 step 6: "validator *before* Auditor"),
// because a fabrication that can be caught by typed code should never cost a
// Gemini call, and because the Auditor is defense-in-depth, not the only line.
export function validateTailorProposal(proposal: TailorProposal, master: MasterProfile): TailorValidation {
  // Collected rather than thrown: a caller fixing a bad prompt needs every
  // problem at once, not the first one repeatedly.
  const violations: TailorViolation[] = [];

  // Index the master once. A Map lookup is what turns "does this id exist" from a
  // hopeful assumption into a decided fact.
  const bulletsById = new Map(master.bullets.map((bullet) => [bullet.id, bullet]));
  // Same for skills, so the rendered name can be pulled from the master.
  const skillsById = new Map(master.skills.map((skill) => [skill.id, skill]));

  // A resume with no achievements on it is a failed tailoring, and without this
  // check an empty proposal would pass with zero violations.
  if (proposal.bullets.length === 0) violations.push({ kind: "empty_selection" });

  // Track ids already seen so a repeat is reported rather than silently rendered.
  const seenBulletIds = new Set<string>();
  // The resolved output lines, built only from references that checked out.
  const resolvedBullets: { masterBulletId: string; text: string }[] = [];

  // Validate each proposed bullet independently so one bad line does not mask others.
  for (const proposed of proposal.bullets) {
    // Duplicate detection first: it is about the proposal's shape, not its honesty.
    if (seenBulletIds.has(proposed.masterBulletId)) {
      // Reported rather than de-duplicated, because silent repair hides a bad prompt.
      violations.push({ kind: "duplicate_bullet_id", id: proposed.masterBulletId });
      // Skip the rest of the checks for this line; the first copy already ran them.
      continue;
    }
    // Remember it for the next iteration.
    seenBulletIds.add(proposed.masterBulletId);

    // The reference check. This is the half of §10 defense 1 that catches an
    // entirely invented achievement.
    const masterBullet = bulletsById.get(proposed.masterBulletId);
    // An id with no master behind it is invented experience — constraint #2.
    if (masterBullet === undefined) {
      // Named so the dashboard can show exactly what the model made up.
      violations.push({ kind: "unknown_bullet_id", id: proposed.masterBulletId });
      // Nothing further can be checked without a master text to compare against.
      continue;
    }

    // THE CONTENT CHECK. A valid id is necessary but not sufficient: the rewording
    // itself can smuggle in a technology the master never contained.
    const allowed = allowedVocabularyFor(masterBullet.text, master);
    // Every word the model wrote must trace back to something real.
    for (const token of tokenize(proposed.reworded)) {
      // Numbers are handled by the metric rule below, not by the vocabulary rule.
      if (/^\d+$/.test(token)) continue;
      // Anything outside the allowed set is a claim with no source.
      if (!allowed.has(token)) {
        // The word is reported so a human can judge it in one glance.
        violations.push({ kind: "unverifiable_token", bulletId: proposed.masterBulletId, token });
      }
    }

    // THE METRIC RULE, stricter than the vocabulary rule: a number in the
    // rewording must appear in the MASTER BULLET specifically. Skills and
    // rhetoric cannot vouch for a quantity.
    const masterNumbers = new Set(numbersIn(masterBullet.text));
    // Check each number the model produced.
    for (const value of numbersIn(proposed.reworded)) {
      // A number the master does not contain is an invented metric, even when
      // every word around it is true.
      if (!masterNumbers.has(value)) {
        // Reported with the value, because "which number" is the first question.
        violations.push({ kind: "invented_metric", bulletId: proposed.masterBulletId, value });
      }
    }

    // Kept for the output artifact; only emitted if the whole proposal passes.
    resolvedBullets.push({ masterBulletId: proposed.masterBulletId, text: proposed.reworded });
  }

  // Track skill ids for the same duplicate reason.
  const seenSkillIds = new Set<string>();
  // Resolved skills, whose names come from the master and nowhere else.
  const resolvedSkills: { masterSkillId: string; name: string }[] = [];

  // Validate each selected skill.
  for (const skillId of proposal.skillIds) {
    // A repeat is malformed output.
    if (seenSkillIds.has(skillId)) {
      // Reported, not collapsed.
      violations.push({ kind: "duplicate_skill_id", id: skillId });
      // Already validated on the first occurrence.
      continue;
    }
    // Remember it.
    seenSkillIds.add(skillId);

    // The reference check — this is the §11 "add Docker" case terminating.
    const masterSkill = skillsById.get(skillId);
    // No master skill behind the id means the model invented a technology.
    if (masterSkill === undefined) {
      // Named so the dashboard can show which technology was fabricated.
      violations.push({ kind: "unknown_skill_id", id: skillId });
      // Nothing to render.
      continue;
    }

    // THE STRUCTURAL GUARANTEE, in one line: the name comes from the master
    // profile, so no model-authored skill string can ever reach the PDF.
    resolvedSkills.push({ masterSkillId: skillId, name: masterSkill.name });
  }

  // Any violation at all fails the whole proposal. There is no partial accept:
  // shipping the honest half of a proposal that also contained a fabrication
  // would mean the fabrication merely got dropped rather than investigated.
  if (violations.length > 0) return { ok: false, violations };

  // Clean. This artifact is what the Auditor then independently re-checks —
  // generator/critic separation (§11), with the validator as the first gate.
  return {
    ok: true,
    resume: {
      // Pins the artifact to the immutable snapshot it derived from.
      masterVersion: master.version,
      // Reworded text, every word of it traced.
      bullets: resolvedBullets,
      // Master-authored names.
      skills: resolvedSkills,
    },
  };
}
