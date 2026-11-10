// PROJECT_PLAN.md §10 defense 1, and the load-bearing wall under constraint #2.
//
// THE DESIGN IDEA, because it is why this file looks the way it does: prefer designs
// where the wrong answer cannot be EXPRESSED over designs that DETECT the wrong
// answer. applyyy-aa's `TailoredProfile` already does most of that work as a type —
// a tailored bullet cannot exist without a `ref`, and a tailored skill has no text
// field at all. This module is the second half: it RESOLVES every ref against the
// pinned master version and refuses the whole tailoring if any of them lies.
//
// It runs BEFORE the Auditor (§20 step 6: "validator *before* Auditor"), because a
// fabrication catchable by typed code should never cost a Gemini call, and because
// the Auditor is defense-in-depth rather than the only line.
//
// Pure: no clock, no network, no database. Only this module may construct a
// `ResolvedResume`, which is what makes "the renderer cannot resolve a ref even by
// accident" a property of the code rather than a promise.

// aa's contract, reached through this stream's single re-export module. Nothing here
// redefines one of these — a redefined type does not fail, it drifts.
import type {
  MasterProfile,
  MasterBullet,
  NodeId,
  // The two new resolved node kinds. Named explicitly rather than inferred, so the
  // arrays below are checked against aa's contract instead of against whatever shape
  // this file happens to build — an inferred literal agrees with itself by definition.
  ResolvedAchievement,
  ResolvedBullet,
  ResolvedCertification,
  ResolvedEducation,
  ResolvedExperience,
  ResolvedProject,
  ResolvedResume,
  ResolvedSkill,
  TailoredBullet,
  TailoredProfile,
} from "../contracts/shared-types.ts";

// The only shape a header role title may have (2026-11-08): starts with a letter; letters, digits, spaces and
// & + # . / - after it; 2-60 characters. Exported so cleanRoleTitle (content-rules.ts) emits exactly what this accepts.
export const ROLE_TITLE_SHAPE = /^[A-Za-z][A-Za-z0-9 &+#./-]{1,59}$/;

// Every way a tailoring can be dishonest or malformed. A discriminated union so the
// dashboard can render each kind differently and the compiler catches a new case.
export type TailorViolation =
  // A ref that resolves to nothing anywhere in the pinned master: invented content.
  | { readonly kind: "unresolved_ref"; readonly ref: NodeId; readonly where: string }
  // A bullet that exists, but under a DIFFERENT master node than the one it was
  // nested beneath. Every id is real and the result is still fabricated experience.
  | { readonly kind: "misattributed_bullet"; readonly ref: NodeId; readonly parentRef: NodeId }
  // The same master node referenced twice.
  | { readonly kind: "duplicate_ref"; readonly ref: NodeId; readonly where: string }
  // Nothing substantive on the resume: not a tailoring, a failure.
  | { readonly kind: "empty_selection" }
  // Answered against a master version other than the one pinned to this application.
  | { readonly kind: "master_version_mismatch"; readonly expected: number; readonly received: number }
  // Prose with nothing declared behind it — aa's own stated weak point.
  | { readonly kind: "summary_without_refs" }
  // A number that does not appear in the referenced master bullet.
  | { readonly kind: "invented_metric"; readonly ref: NodeId; readonly value: string }
  // A word in a rewording that traces back to nothing in the master profile.
  | { readonly kind: "unverifiable_token"; readonly ref: NodeId; readonly token: string }
  // THE MASTER ITSELF IS AMBIGUOUS: two nodes share an id, so no ref naming that id
  // can be resolved to a single source. This is not a fabrication by the model — it
  // is a defect in the profile that makes the honesty check unable to reach a verdict
  // at all. Reported distinctly for exactly that reason: the remedy is to fix the
  // master, not to re-run the Tailor.
  | { readonly kind: "ambiguous_master_ids"; readonly ids: readonly NodeId[] }
  // The one-page rule (Teja, 2026-11-07): the resume is over one A4 page at the readable-minimum
  // typography even after page-trim.ts removed everything above its floors. `blockedBy` names the
  // floors that held, so the fix (lower a floor, or shorten the master) is readable from the event.
  // Produced by the tailorer, not by validateTailoredProfile: the validator answers "is it honest",
  // and a two-page resume is honest but still must not be stored.
  | { readonly kind: "page_overflow"; readonly blockedBy: readonly string[] }
  // The content rules (Teja, 2026-11-08; numbers live in PAGE_FIT_FLOORS, page-trim.ts: 2 projects x 3-4 bullets, Aczen
  // >= 4, certifications >= 5, every achievement, education >= 2) still broken after the tailor topped up from the master and fitted the page. `blockedBy` names each
  // broken rule (content-rules.ts checkContentRules). Produced by the tailorer, like page_overflow.
  | { readonly kind: "content_floor"; readonly blockedBy: readonly string[] };

// Success carries the render input; failure carries every reason. A union rather than
// a throw, because the caller must persist the violations for the dashboard rather
// than lose them in a stack trace.
export type TailorValidation =
  // Safe to hand to the Auditor, and the only way a ResolvedResume comes into being.
  | { readonly ok: true; readonly resume: ResolvedResume }
  // Never reaches the Auditor; the row goes to audit_failed carrying these reasons.
  | { readonly ok: false; readonly violations: readonly TailorViolation[] };

// Rhetorical vocabulary a rewording may introduce. This is a DENY-BY-DEFAULT
// boundary: anything not derived from the master and not listed here is a violation.
//
// WHY AN ALLOWLIST AND NOT A BLOCKLIST OF FORBIDDEN TECHNOLOGIES: a blocklist of
// every technology in the world is unbounded and will always miss the next one. An
// allowlist of connectives and framing verbs is small, closed and reviewable — the
// bounded side of the problem. Everything factual must come from the master.
//
// It is deliberately a TUNING SURFACE: adding a word here loosens the honesty gate by
// exactly that word, which is a decision a human should make on purpose.
const RHETORICAL_VOCABULARY: ReadonlySet<string> = new Set([
  // Articles, conjunctions and prepositions — they carry no factual claim at all.
  "a", "an", "the", "and", "or", "for", "with", "in", "of", "to", "on", "at",
  "by", "as", "from", "into", "that", "which", "this", "its", "it", "over",
  "across", "per", "via", "than", "then", "while", "within", "through", "plus",
  // Framing verbs for work the master already asserts was done. NOTE the
  // omissions: "led", "managed", "owned", "architected" and "mentored" are NOT
  // here, because they assert seniority the master may not support — which is
  // precisely the "during my time leading a team of five" failure §18.8 warns about.
  "designed", "developed", "implemented", "shipped", "delivered", "created",
  "wrote", "engineered", "handled", "serving", "supporting", "powering",
  "enabling", "using", "used", "including", "built", "deployed",
  // Neutral qualifiers about the artifact rather than about the candidate.
  "production", "end", "full", "stack", "based", "backed", "side", "scale",
  // Common near-synonyms for nouns a project bullet already contains.
  "platform", "application", "app", "service", "system", "portal", "project",
  "site", "api", "apis", "endpoint", "endpoints", "feature", "features",
  // Plural and singular forms of words the master may hold in the other number.
  "users", "user", "requests", "students", "services",
]);

// Split text into comparable lowercase word tokens. Shares the folding idea with the
// fingerprint module: punctuation and case are formatting, not content, so
// "Node.js/Express" and "Node.js, Express" must tokenise identically.
function tokenize(text: string): string[] {
  return text
    // Case is styling.
    .toLowerCase()
    // Every punctuation run becomes a separator, splitting "Node.js/Express" into
    // "node", "js", "express".
    .split(/[^a-z0-9]+/)
    // Drop the empty strings the split leaves at the ends.
    .filter((token) => token.length > 0);
}

// Pull every numeric literal out of a text. Metrics get their own rule because a
// changed digit is the cheapest lie to tell and the hardest to notice by eye.
export function numbersIn(text: string): string[] {
  // Strip thousands separators first, so "1,000" compares against the master's "1000".
  const withoutSeparators = text.replace(/(\d),(?=\d)/g, "$1");
  // Every run of digits. Suffixes like "+" and "%" fall outside the match, which is
  // what makes "500+" compare equal to the master's "500".
  return withoutSeparators.match(/\d+/g) ?? [];
}

// Pre-LLM Metric Sentinel (3b): extracts and indexes all metrics from master profile bullets.
export function indexMasterMetrics(master: MasterProfile): ReadonlyMap<NodeId, ReadonlySet<string>> {
  const metricIndex = new Map<NodeId, Set<string>>();
  for (const parent of [
    ...master.experience,
    ...master.projects,
    ...master.education,
    ...master.achievements,
    ...master.certifications,
  ]) {
    for (const bullet of parent.bullets) {
      metricIndex.set(bullet.id, new Set(numbersIn(bullet.text)));
    }
  }
  return metricIndex;
}

// Post-LLM Metric Sentinel (3b): verifies that every number in tailored text appears in the master bullet.
export function verifyBulletMetrics(
  tailoredText: string,
  masterBulletText: string,
): { readonly valid: boolean; readonly inventedMetrics: readonly string[] } {
  const masterNumbers = new Set(numbersIn(masterBulletText));
  const invented: string[] = [];
  for (const value of numbersIn(tailoredText)) {
    if (!masterNumbers.has(value)) {
      invented.push(value);
    }
  }
  return {
    valid: invented.length === 0,
    inventedMetrics: invented,
  };
}

// Citation Reference Sentinel (3c): ensures a ref is non-empty and non-whitespace.
export function isValidCitationRef(ref: unknown): ref is NodeId {
  return typeof ref === "string" && ref.trim().length > 0;
}

// A nullable master display field, as the snapshot must store it: present, and null
// when the master has none. The master is jsonb read back through a cast, and a stored
// master that LEFT OUT the key (master_profiles v2, live 2026-10-24) hands this file
// `undefined`; JSON then drops the key from tailored_profile and the renderer crashed
// on the hole. Versions are immutable and pinned, so the stored hole is permanent and
// this copy step is the one place every future snapshot can be made whole.
// Nullable fields ONLY: a missing REQUIRED field is a broken master, not an absence.
function nullIfAbsent(value: string | null | undefined): string | null {
  // `??` maps exactly undefined and null to null; '' and real text pass unchanged,
  // so a present value is still copied byte-for-byte (the honesty guarantee).
  return value ?? null;
}

// Collect every skill token in the profile once, so a rewording may legitimately name
// a real skill. Computed a single time per validation rather than per bullet.
function masterSkillTokens(master: MasterProfile): ReadonlySet<string> {
  // Accumulator.
  const tokens = new Set<string>();
  // Every skill the candidate genuinely has.
  for (const skill of master.skills) {
    // Tokenised, so "Node.js" contributes both "node" and "js".
    for (const token of tokenize(skill.name)) tokens.add(token);
  }
  // Returned as a read-only view.
  return tokens;
}

// Find every id that appears more than once anywhere in the master profile.
//
// WHY THIS EXISTS, AND WHY IT REFUSES RATHER THAN REPAIRS. `indexBullets` below builds
// ONE FLAT MAP keyed by bullet id across experience, projects and education — and a
// `Map` overwrites. So if two bullets share an id, the later one silently replaces the
// earlier, and the misattribution check then compares a tailored bullet against THE
// WRONG PARENT. A genuinely misattributed bullet can pass, or an honest one be
// flagged, decided purely by which duplicate happened to be indexed last. No error
// anywhere: the tailoring looks clean and the Auditor reports clean, while the honesty
// guarantee has quietly stopped holding.
//
// The same hazard applies to PARENT ids. `resolveBullet` compares `found.parentRef`
// against the parent the model nested the bullet under, so if an experience node and
// a project node share an id, a bullet moved between them passes that comparison.
//
// AND IT IS THE MOST LIKELY DEFECT IN A HAND-MAINTAINED PROFILE, which is what makes
// it worth a hard failure rather than a warning: the way anyone adds a bullet is to
// copy the one above it. `TailoredBullet.ref` is a bare `NodeId` with no section
// qualifier, so nothing downstream can disambiguate after the fact.
//
// WHY GLOBAL UNIQUENESS AND NOT PER-SECTION UNIQUENESS — this distinction is the whole
// point, and per-section is the plausible wrong answer that reads as more sensible.
// Per-section uniqueness catches the mistake people make most often (a duplicate
// within one employer) and still leaves the audit corruptible, because the collision
// it misses — the SAME id under two different parents — is precisely the one a flat
// index cannot survive. A checker that catches the common mistake and misses the
// dangerous one is worse than none, because it produces confidence it has not earned.
//
// Skills are included even though `skillsById` is a separate map that a bullet ref
// never reaches, so a skill/bullet collision is not exploitable today. It is refused
// anyway: an id space that is ambiguous to a human reading a provenance footer is a
// latent hazard, and "every id in the master is unique" is a rule worth being able to
// state without a footnote.
//
// KNOWN AND DELIBERATE GAP: LINK IDS ARE NOT CHECKED HERE. `MasterLink` carries a
// `NodeId`, and `MasterProject.links` added a third population of them on 2026-09-11
// alongside `MasterIdentity.links` and `MasterProfile.links`. None of the three is
// reachable from any ref this file resolves — links are copied wholesale into the
// resolved resume and never looked up — so a colliding link id cannot corrupt a
// verdict HERE, and widening this function to cover them would change what a
// tailoring is refused for without making any tailoring safer. The contract's global
// uniqueness rule still applies to them; it is enforced at ingest, by
// `packages/master-ingest`'s `collectNodeIds`/`findDuplicateNodeIds`, which is the
// place the contract names. The rule for this function is narrower and stated so it
// can be checked: EVERY ID THIS FUNCTION CAN RESOLVE IS AN ID IT CHECKS. Add a link
// id to a resolution path and it must be added here in the same edit.
function findDuplicateMasterIds(master: MasterProfile): readonly NodeId[] {
  // Ids seen at least once.
  const seen = new Set<NodeId>();
  // Ids seen more than once. A Set so one id repeated three times is reported once.
  const duplicates = new Set<NodeId>();
  // Record one id, promoting it to `duplicates` on a second sighting.
  const note = (id: NodeId): void => {
    // Already seen means this is a collision.
    if (seen.has(id)) duplicates.add(id);
    // Otherwise remember it.
    else seen.add(id);
  };
  // Skills occupy the same declared id space even though they resolve through their
  // own map — see the note above about hygiene versus exploitability.
  for (const skill of master.skills) note(skill.id);
  // The human's own summary paragraph, which became a node with an id on 2026-09-11.
  // Included the moment it became RESOLVABLE: the summary-refs check below now treats
  // this id as a legitimate citation target, and every id that can be resolved must
  // also be an id that is guaranteed to name one thing. Skipping it would leave the
  // newest ref target as the only one with no uniqueness guarantee behind it.
  if (master.summary !== null) note(master.summary.id);
  // The FIVE bullet-owning node kinds, walked exactly as `indexBullets` walks them so
  // this check cannot drift out of alignment with the index it is protecting.
  //
  // ACHIEVEMENTS AND CERTIFICATIONS JOINED THIS LIST ON 2026-09-11 AS A MATTER OF
  // SAFETY, NOT TIDINESS. They are bullet-bearing parents, so their bullets now land
  // in the same flat `indexBullets` map as everybody else's — which means the overwrite
  // hazard described above reaches them too. An achievement bullet colliding with an
  // experience bullet would silently reparent one of the two, and the misattribution
  // check would then compare against the wrong parent and report clean. Adding the
  // resolution loops without adding these two lines would have reopened exactly the
  // hole this function exists to close, in the newest and least-examined section.
  for (
    const parent of [
      ...master.experience,
      ...master.projects,
      ...master.education,
      ...master.achievements,
      ...master.certifications,
    ]
  ) {
    // The parent's own id, which `resolveBullet` compares against.
    note(parent.id);
    // Every bullet beneath it, which is the flat-index collision proper.
    for (const bullet of parent.bullets) note(bullet.id);
  }
  // Sorted so the violation is deterministic — an unstable order would make the same
  // defect produce different output run to run and break byte-comparison tests.
  return [...duplicates].sort();
}

// Index every bullet in the master by id, remembering WHICH node it belongs to. The
// parent is the load-bearing part: without it, moving a real bullet under a different
// employer passes a flat existence check while fabricating employment history.
//
// SAFE ONLY BECAUSE `findDuplicateMasterIds` HAS ALREADY REFUSED an ambiguous master.
// The overwrite hazard described above is real and is handled by that guard failing
// closed before this function is ever called — not by anything in here.
function indexBullets(master: MasterProfile): ReadonlyMap<NodeId, { bullet: MasterBullet; parentRef: NodeId }> {
  // Accumulator keyed by bullet id.
  const index = new Map<NodeId, { bullet: MasterBullet; parentRef: NodeId }>();
  // The five node kinds that own bullets, walked uniformly. Achievements and
  // certifications are here because their bullets are ordinary `MasterBullet`s that
  // the Tailor reworks through `TailoredBullet` — omitting them would make every
  // achievement bullet an `unresolved_ref`, so the two new sections would resolve to
  // nothing and the resume would render with empty award lines. Kept in the same
  // order and the same shape as `findDuplicateMasterIds` above, deliberately: that
  // function is only a valid guard for this index while the two walk the same nodes.
  for (
    const parent of [
      ...master.experience,
      ...master.projects,
      ...master.education,
      ...master.achievements,
      ...master.certifications,
    ]
  ) {
    // Each bullet records the node it hangs from.
    for (const bullet of parent.bullets) index.set(bullet.id, { bullet, parentRef: parent.id });
  }
  // Returned as a read-only view.
  return index;
}

// Validate one reworded bullet against the master bullet it claims to rework, and
// return the resolved node. Violations are appended rather than thrown so a single
// bad line does not hide the rest.
function resolveBullet(
  tailored: TailoredBullet,
  parentRef: NodeId,
  bulletIndex: ReadonlyMap<NodeId, { bullet: MasterBullet; parentRef: NodeId }>,
  skillTokens: ReadonlySet<string>,
  violations: TailorViolation[],
): ResolvedBullet | null {
  // Validate citation reference integrity (3c).
  if (!isValidCitationRef(tailored.ref)) {
    violations.push({ kind: "unresolved_ref", ref: tailored.ref, where: `bullet under ${parentRef}` });
    return null;
  }
  // Look the reference up.
  const found = bulletIndex.get(tailored.ref);
  // A bullet id that exists nowhere is wholly invented experience — constraint #2.
  if (found === undefined) {
    // Named so the dashboard can show exactly what the model made up.
    violations.push({ kind: "unresolved_ref", ref: tailored.ref, where: `bullet under ${parentRef}` });
    // Nothing further can be checked without a master text to compare against.
    return null;
  }
  // THE MISATTRIBUTION CHECK. Both ids are real, so a flat existence lookup would
  // wave this through — yet crediting a personal project's work to a named employer
  // is fabricated experience assembled entirely out of true parts.
  if (found.parentRef !== parentRef) {
    // Distinguished from an unresolved ref because the remedy differs: this means the
    // model is reassembling the truth rather than inventing it.
    violations.push({ kind: "misattributed_bullet", ref: tailored.ref, parentRef });
    // Refused rather than silently reparented.
    return null;
  }

  // THE CONTENT CHECK. A valid ref is necessary but not sufficient: the rewording can
  // still smuggle in a technology the master never contained.
  const allowed = new Set(tokenize(found.bullet.text));
  // A rewording may legitimately name a skill the candidate genuinely has. NOTE the
  // deliberate looseness: this permits moving a real skill into a bullet that did not
  // mention it — an overstatement rather than a fabrication, and what the Auditor is for.
  for (const token of skillTokens) allowed.add(token);
  // Plus the closed rhetorical set, which carries no factual weight.
  for (const word of RHETORICAL_VOCABULARY) allowed.add(word);
  // Every word the model wrote must trace back to something real.
  for (const token of tokenize(tailored.text)) {
    // Numbers are governed by the stricter metric rule below, not by vocabulary.
    if (/^\d+$/.test(token)) continue;
    // Anything outside the allowed set is a claim with no source.
    if (!allowed.has(token)) {
      // The word is reported so a human can judge it in one glance.
      violations.push({ kind: "unverifiable_token", ref: tailored.ref, token });
    }
  }

  // Post-LLM Metric Sentinel (3b): verify that every number in tailored text appears in master bullet.
  const metricCheck = verifyBulletMetrics(tailored.text, found.bullet.text);
  if (!metricCheck.valid) {
    for (const value of metricCheck.inventedMetrics) {
      violations.push({ kind: "invented_metric", ref: tailored.ref, value });
    }
  }

  // Resolved. `master_text` travels with it so the §15 diff view can render
  // master-vs-tailored side by side without a second lookup into the profile.
  return { ref: tailored.ref, text: tailored.text, master_text: found.bullet.text };
}

// Small helper: record a duplicate reference and report whether this ref is a repeat.
// Extracted because the same three lines are needed for five different node kinds.
function isDuplicate(ref: NodeId, seen: Set<NodeId>, where: string, violations: TailorViolation[]): boolean {
  // First sighting is fine.
  if (!seen.has(ref)) {
    // Remember it for next time.
    seen.add(ref);
    // Not a duplicate.
    return false;
  }
  // Reported rather than collapsed: silent repair hides a misbehaving prompt.
  violations.push({ kind: "duplicate_ref", ref, where });
  // Caller skips this entry.
  return true;
}

// THE VALIDATOR. `masterVersion` is passed separately because that is where aa put
// it: `master_profiles.version` is a database column, while `MasterProfile` itself
// carries only `schema_version`. Passing the pin explicitly is also what lets this
// function refuse a tailoring computed against a different snapshot.
export function validateTailoredProfile(
  tailored: TailoredProfile,
  master: MasterProfile,
  masterVersion: number,
): TailorValidation {
  // FAIL CLOSED BEFORE ANY OTHER CHECK. If the master's id space is ambiguous, every
  // ref lookup below is resolving against an index that may name the wrong node, so
  // no verdict this function could reach would be supportable.
  //
  // THIS RETURNS RATHER THAN ACCUMULATING, AND THAT IS THE POINT. A validator that
  // proceeds on an index it knows is ambiguous is worse than one with no check at
  // all: it reports "clean" with the full authority of a check that did not actually
  // hold. Refusing outright means the failure is loud, the remedy is obvious (fix the
  // master, do not re-run the Tailor), and nothing downstream ever sees a
  // `ResolvedResume` built on a corrupted lookup.
  const duplicateMasterIds = findDuplicateMasterIds(master);
  // Any collision at all is disqualifying — there is no safe subset to proceed with.
  if (duplicateMasterIds.length > 0) {
    // The whole tailoring is refused, carrying every colliding id so the fix is
    // one edit rather than a hunt.
    return { ok: false, violations: [{ kind: "ambiguous_master_ids", ids: duplicateMasterIds }] };
  }

  // Collected rather than thrown: someone fixing a bad prompt needs every problem at
  // once, not the first one repeatedly.
  const violations: TailorViolation[] = [];

  // THE PIN. Resolving a tailoring against a master version it never saw would
  // produce a resume nobody approved — §9's resume pinning depends on this check.
  if (tailored.master_version !== masterVersion) {
    // Named distinctly so retry logic can tell it apart from a fabrication.
    violations.push({ kind: "master_version_mismatch", expected: masterVersion, received: tailored.master_version });
  }

  // Index the master once. A Map lookup is what turns "does this ref exist" from a
  // hopeful assumption into a decided fact.
  const bulletIndex = indexBullets(master);
  // Skill tokens, computed once and shared by every bullet check.
  const skillTokens = masterSkillTokens(master);
  // Node lookups for the four referenceable top-level kinds.
  const experienceById = new Map(master.experience.map((node) => [node.id, node]));
  // Projects.
  const projectsById = new Map(master.projects.map((node) => [node.id, node]));
  // Education.
  const educationById = new Map(master.education.map((node) => [node.id, node]));
  // Skills.
  const skillsById = new Map(master.skills.map((node) => [node.id, node]));
  // Achievements. Built exactly like the four above rather than folded in with
  // certifications: they are separate resume sections with separate refs, and one
  // shared map would let an achievement ref resolve to a certification.
  const achievementsById = new Map(master.achievements.map((node) => [node.id, node]));
  // Certifications, for the same reason in the other direction.
  const certificationsById = new Map(master.certifications.map((node) => [node.id, node]));

  // A resume with no experience, projects or education is a failed tailoring; without
  // this check an empty selection would pass with zero violations.
  //
  // ACHIEVEMENTS AND CERTIFICATIONS ARE DELIBERATELY NOT COUNTED AS SUBSTANCE, and
  // leaving them out is the change here rather than an oversight. Adding them to this
  // disjunction would WEAKEN the guard: a tailoring that selected one certification
  // and nothing else would then pass as substantive, and a resume that is a single
  // credential line with no employment, projects or education behind it is exactly
  // the failed tailoring this check exists to catch. Awards qualify a resume; they do
  // not constitute one.
  if (tailored.experience.length === 0 && tailored.projects.length === 0 && tailored.education.length === 0) {
    // Named distinctly from the fabrication cases, since the remedy differs.
    violations.push({ kind: "empty_selection" });
  }

  // Duplicate tracking. ONE SET SHARED BY EVERY SECTION, not one per kind — the
  // comment that stood here until 2026-09-11 said "one set per namespace so a skill
  // and a project may share an id", which describes code that was never written and
  // a rule `findDuplicateMasterIds` above directly contradicts: the master's id space
  // is GLOBAL, so a skill and a project sharing an id is a refused master, not an
  // allowed one. The single set is correct; only its description was wrong.
  //
  // The consequence is worth knowing when writing a test against this function: an
  // id mentioned in two DIFFERENT sections of one tailoring is reported as
  // `duplicate_ref` by whichever section is walked second, and that section's own
  // resolution check never runs. That is the right verdict — the same master node
  // cannot honestly appear twice on one resume, whatever sections it appears under.
  const seenRefs = new Set<NodeId>();

  // --- Skills -------------------------------------------------------------
  // Resolved skills, whose names and categories come from the master and nowhere else.
  const resolvedSkills: ResolvedSkill[] = [];
  // Walk the selection in order; aa's ORDER CONTRACT says array order is document order.
  for (const selected of tailored.skills) {
    // Validate citation reference integrity (3c).
    if (!isValidCitationRef(selected.ref)) {
      violations.push({ kind: "unresolved_ref", ref: selected.ref, where: "skills" });
      continue;
    }
    // A repeat is malformed output.
    if (isDuplicate(selected.ref, seenRefs, "skills", violations)) continue;
    // The reference check — this is the §11 "add Docker" case terminating.
    const masterSkill = skillsById.get(selected.ref);
    // No master skill behind the ref means the model invented a technology.
    if (masterSkill === undefined) {
      // Named so the dashboard can show which technology was fabricated.
      violations.push({ kind: "unresolved_ref", ref: selected.ref, where: "skills" });
      // Nothing to render.
      continue;
    }
    // THE STRUCTURAL GUARANTEE, physically enforced in one line: name and category
    // are copied from the master, so no model-authored skill string reaches the PDF.
    resolvedSkills.push({ ref: selected.ref, name: masterSkill.name, category: masterSkill.category });
  }

  // --- Experience ---------------------------------------------------------
  // Resolved employment history.
  const resolvedExperience: ResolvedExperience[] = [];
  // Same pattern for each of the three bullet-bearing kinds.
  for (const selected of tailored.experience) {
    // Validate citation reference integrity (3c).
    if (!isValidCitationRef(selected.ref)) {
      violations.push({ kind: "unresolved_ref", ref: selected.ref, where: "experience" });
      continue;
    }
    // Repeated employer entry.
    if (isDuplicate(selected.ref, seenRefs, "experience", violations)) continue;
    // Resolve the employer itself.
    const node = experienceById.get(selected.ref);
    // An employer that does not exist is invented employment — constraint #2.
    if (node === undefined) {
      // Reported with its location, so the dashboard can point at the section.
      violations.push({ kind: "unresolved_ref", ref: selected.ref, where: "experience" });
      // Its bullets cannot be scope-checked without a parent to check against.
      continue;
    }
    // Resolve each bullet, scoped to THIS employer.
    const bullets = selected.bullets
      // Null entries are the ones that failed; they are already reported.
      .map((bullet) => resolveBullet(bullet, selected.ref, bulletIndex, skillTokens, violations))
      // Narrowed so the resolved node contains only bullets that checked out.
      .filter((bullet): bullet is ResolvedBullet => bullet !== null);
    // Every display field is materialised from the master, never from the model —
    // which is why aa's TailoredExperience carries no company or role text.
    resolvedExperience.push({
      ref: node.id,
      company: node.company,
      role: node.role,
      // Nullable: an absent key in the stored master becomes an explicit null here.
      location: nullIfAbsent(node.location),
      start_display: node.start_display,
      end_display: node.end_display,
      bullets,
    });
  }

  // --- Projects -----------------------------------------------------------
  // Resolved projects.
  const resolvedProjects: ResolvedProject[] = [];
  // Identical shape to experience, kept explicit rather than abstracted: the three
  // node types have genuinely different display fields, and a clever generic here
  // would obscure exactly the field-copying that makes the guarantee true.
  for (const selected of tailored.projects) {
    // Validate citation reference integrity (3c).
    if (!isValidCitationRef(selected.ref)) {
      violations.push({ kind: "unresolved_ref", ref: selected.ref, where: "projects" });
      continue;
    }
    // Repeated project entry.
    if (isDuplicate(selected.ref, seenRefs, "projects", violations)) continue;
    // Resolve the project.
    const node = projectsById.get(selected.ref);
    // An invented project.
    if (node === undefined) {
      // Reported.
      violations.push({ kind: "unresolved_ref", ref: selected.ref, where: "projects" });
      // Skip its bullets.
      continue;
    }
    // Bullets scoped to this project.
    const bullets = selected.bullets
      // Resolve each.
      .map((bullet) => resolveBullet(bullet, selected.ref, bulletIndex, skillTokens, violations))
      // Keep only those that resolved.
      .filter((bullet): bullet is ResolvedBullet => bullet !== null);
    // Display fields from the master.
    resolvedProjects.push({
      ref: node.id,
      name: node.name,
      // EVERY address the project has, carried across whole. This replaced
      // `url: node.url` on 2026-09-11, when the scalar was deleted from the contract
      // because a project with both a live URL and a GitHub URL had one of the two
      // silently discarded on every upload. Copied by reference rather than rebuilt:
      // a link has no tailorable part, so there is nothing here for the validator to
      // resolve and nothing a model could have touched.
      links: node.links,
      start_display: node.start_display,
      end_display: node.end_display,
      bullets,
    });
  }

  // --- Education ----------------------------------------------------------
  // Resolved qualifications.
  const resolvedEducation: ResolvedEducation[] = [];
  // Same pattern again.
  for (const selected of tailored.education) {
    // Validate citation reference integrity (3c).
    if (!isValidCitationRef(selected.ref)) {
      violations.push({ kind: "unresolved_ref", ref: selected.ref, where: "education" });
      continue;
    }
    // Repeated education entry.
    if (isDuplicate(selected.ref, seenRefs, "education", violations)) continue;
    // Resolve the qualification.
    const node = educationById.get(selected.ref);
    // An invented degree is constraint #2's "education" and "qualifications" clauses.
    if (node === undefined) {
      // Reported.
      violations.push({ kind: "unresolved_ref", ref: selected.ref, where: "education" });
      // Skip its bullets.
      continue;
    }
    // Bullets scoped to this qualification.
    const bullets = selected.bullets
      // Resolve each.
      .map((bullet) => resolveBullet(bullet, selected.ref, bulletIndex, skillTokens, violations))
      // Keep only those that resolved.
      .filter((bullet): bullet is ResolvedBullet => bullet !== null);
    // Display fields from the master, grade included — the template must not decide
    // how to render a grade (aa's DATE CONTRACT reasoning applied to grades).
    resolvedEducation.push({
      ref: node.id,
      institution: node.institution,
      degree: node.degree,
      // Nullable: absent becomes null (see nullIfAbsent).
      field: nullIfAbsent(node.field),
      start_display: node.start_display,
      end_display: node.end_display,
      // Nullable, same rule.
      grade_display: nullIfAbsent(node.grade_display),
      bullets,
    });
  }

  // --- Achievements -------------------------------------------------------
  // Resolved awards and placings.
  const resolvedAchievements: ResolvedAchievement[] = [];
  // The same pattern a fourth time, and kept literally the same on purpose. A reader
  // who has checked the experience loop above should be able to skim this one and
  // trust it without re-deriving anything; a cleverer generic over the five kinds
  // would hide the field-by-field copying, which is the part that makes the honesty
  // guarantee true rather than merely claimed.
  for (const selected of tailored.achievements) {
    // Validate citation reference integrity (3c).
    if (!isValidCitationRef(selected.ref)) {
      violations.push({ kind: "unresolved_ref", ref: selected.ref, where: "achievements" });
      continue;
    }
    // Repeated award entry — the same placing listed twice reads as two placings.
    if (isDuplicate(selected.ref, seenRefs, "achievements", violations)) continue;
    // Resolve the achievement itself.
    const node = achievementsById.get(selected.ref);
    // An award that does not exist is constraint #2's cheapest lie: a bare
    // superlative with no surrounding context to contradict it.
    if (node === undefined) {
      // Reported with its location so the dashboard can point at the section.
      violations.push({ kind: "unresolved_ref", ref: selected.ref, where: "achievements" });
      // Its bullets cannot be scope-checked without a parent to check against.
      continue;
    }
    // Bullets scoped to THIS achievement.
    const bullets = selected.bullets
      // Resolve each.
      .map((bullet) => resolveBullet(bullet, selected.ref, bulletIndex, skillTokens, violations))
      // Keep only those that resolved.
      .filter((bullet): bullet is ResolvedBullet => bullet !== null);
    // `label` and `description` are materialised from the master and nowhere else —
    // which is exactly why `TailoredAchievement` carries neither. This one line is
    // what stops "Winner" being tailored into "International Winner".
    resolvedAchievements.push({
      ref: node.id,
      label: node.label,
      // The live 2026-10-24 hole: master v2 stores achievements with no description key.
      description: nullIfAbsent(node.description),
      bullets,
      // Profile/proof links (2026-11-01), from the MASTER node and nowhere else -
      // `node` is the master achievement found by ref, so a `links` key the model
      // wrote onto its selection is never read. Copied AS THE MASTER HOLDS IT: an
      // absent key stays absent, NOT normalised to [] like nullIfAbsent does for
      // description. Reason: rebuildOriginal re-runs this validator over old
      // tailor_refs and the approval page derives "edited" from rebuild vs the
      // frozen snapshot, so a rebuild must reproduce a pre-v9 snapshot byte for
      // byte (measured: `links: []` broke tailorRefsWithoutSchemaVersion.test.ts).
      // `links: node.links` would set an undefined-valued key, which deepEqual
      // also tells apart from an absent one - hence the conditional spread.
      ...(node.links === undefined ? {} : { links: node.links }),
    });
  }

  // --- Certifications -----------------------------------------------------
  // Resolved credentials.
  const resolvedCertifications: ResolvedCertification[] = [];
  // Fifth and last repetition of the pattern. Certifications resolve through their
  // own map rather than sharing the achievements one, so a certification ref can
  // never quietly land on an achievement of the same id — the two sections are
  // separate in the contract and separate here.
  for (const selected of tailored.certifications) {
    // Validate citation reference integrity (3c).
    if (!isValidCitationRef(selected.ref)) {
      violations.push({ kind: "unresolved_ref", ref: selected.ref, where: "certifications" });
      continue;
    }
    // Repeated credential entry.
    if (isDuplicate(selected.ref, seenRefs, "certifications", violations)) continue;
    // Resolve the certification itself.
    const node = certificationsById.get(selected.ref);
    // An invented credential is constraint #2's "certifications" clause verbatim.
    if (node === undefined) {
      // Reported.
      violations.push({ kind: "unresolved_ref", ref: selected.ref, where: "certifications" });
      // Skip its bullets.
      continue;
    }
    // Bullets scoped to this certification.
    const bullets = selected.bullets
      // Resolve each.
      .map((bullet) => resolveBullet(bullet, selected.ref, bulletIndex, skillTokens, violations))
      // Keep only those that resolved.
      .filter((bullet): bullet is ResolvedBullet => bullet !== null);
    // Name and issuer detail from the master, so neither can be upgraded in wording.
    resolvedCertifications.push({
      ref: node.id,
      label: node.label,
      // Nullable, same rule as an achievement's description.
      description: nullIfAbsent(node.description),
      bullets,
      // Credential links from the master cert by ref, copied as held (absent stays
      // absent) for the rebuild-equals-snapshot reason on the achievement's.
      ...(node.links === undefined ? {} : { links: node.links }),
    });
  }

  // --- Summary variant (pending #11, 2026-11-07) ----------------------------
  // The owner-written headline + summary the Tailor picked, or none. Null and absent both mean "the
  // default", so every tailor_refs stored before this field rebuilds to its stored resume unchanged.
  const variantId = tailored.summary_variant ?? null;
  // Looked up by exact id in the master's own list (absent list = no variants).
  const variant = variantId === null ? undefined : (master.summary_variants ?? []).find((candidate) => candidate.id === variantId);
  // A picked id the master does not hold is a fabricated ref, never quietly read as the default.
  if (variantId !== null && variant === undefined) violations.push({ kind: "unresolved_ref", ref: variantId, where: "summary_variant" });
  // The header role title (2026-11-08): when present it must be the cleaned shape cleanRoleTitle produces (words,
  // digits and & + # . / - only, 2-60 characters). Anything else (markup, a sentence, an empty string) is refused,
  // never printed: a free-text header would be the one line of the resume nobody traced (CLAUDE.md section 6).
  if (tailored.headline_title !== undefined && !ROLE_TITLE_SHAPE.test(tailored.headline_title)) violations.push({ kind: "unresolved_ref", ref: String(tailored.headline_title), where: "headline_title" });

  // --- Summary ------------------------------------------------------------
  // aa names this the weakest point in the contract, and states why: prose cannot be
  // constrained by refs the way a bullet can. The non-empty `refs` requirement is the
  // stated mitigation, so it is enforced here rather than merely documented.
  if (tailored.summary !== null) {
    // Prose with nothing declared behind it is exactly where a model writes "leading
    // a team of five" about something that never happened.
    if (tailored.summary.refs.length === 0) {
      // Named for the dashboard.
      violations.push({ kind: "summary_without_refs" });
    }
    // Every declared ref must resolve against some real master node, with no duplicate citations (3c).
    const seenSummaryRefs = new Set<NodeId>();
    for (const ref of tailored.summary.refs) {
      if (!isValidCitationRef(ref)) {
        violations.push({ kind: "unresolved_ref", ref, where: "summary refs" });
        continue;
      }
      if (seenSummaryRefs.has(ref)) {
        violations.push({ kind: "duplicate_ref", ref, where: "summary refs" });
        continue;
      }
      seenSummaryRefs.add(ref);

      // THE HUMAN'S OWN SUMMARY IS NOW A CITABLE SOURCE, and it has to be, or the
      // 2026-09-11 contract change buys nothing. `MasterSummary` exists so that
      // "reword the paragraph I wrote" stops being indistinguishable from "invent a
      // paragraph" — but that only works if the id is ACCEPTED here. Leave this line
      // out and a tailoring that honestly cites the master summary is rejected as a
      // fabrication, which is the loudest possible way to punish the honest case.
      // The PICKED variant's paragraph is the owner's own text too (2026-11-07), so it is citable; a
      // variant that is not picked is not, so a default-headline resume cannot borrow another framing.
      const citesMasterSummary = (master.summary !== null && master.summary.id === ref) || (variant !== undefined && variant.summary.id === ref);
      // The summary may cite any node kind, so every index is consulted — including
      // the two added on 2026-09-11. A summary drawing on an award it cannot name is
      // a summary forced to leave its strongest evidence undeclared.
      const exists = citesMasterSummary || experienceById.has(ref) || projectsById.has(ref) ||
        educationById.has(ref) || skillsById.has(ref) || achievementsById.has(ref) ||
        certificationsById.has(ref) || bulletIndex.has(ref);
      // A citation to something that does not exist is the same fabrication as an
      // invented bullet, just harder to spot because it sits in the metadata.
      if (!exists) violations.push({ kind: "unresolved_ref", ref, where: "summary refs" });
    }
  }

  // Any violation at all fails the whole tailoring. There is no partial accept:
  // shipping the honest half of a tailoring that also contained a fabrication would
  // mean the fabrication was merely dropped rather than investigated.
  if (violations.length > 0) return { ok: false, violations };

  // Clean. This artifact is what the Auditor then independently re-checks —
  // generator/critic separation (§11), with the validator as the first gate.
  return {
    ok: true,
    resume: {
      // aa's shape marker.
      schema_version: 1,
      // The pin, so a stale snapshot is detected rather than silently rendered.
      master_version: masterVersion,
      // Verbatim from the master. There is no honest reason to tailor a name or a
      // phone number, and aa's type gives the Tailor no way to try.
      // The three optional lines are normalised so an absent key cannot ride along;
      // every other identity field is the master's own value, unchanged.
      identity: {
        // Name, email and links, exactly as stored.
        ...master.identity,
        // Absent becomes null for each optional line (see nullIfAbsent).
        // The role applied for (2026-11-08, headline_title, shape-checked above), else the picked variant's headline
        // (2026-11-07), else the master's own, exactly as before.
        headline: tailored.headline_title ?? (variant !== undefined ? variant.headline : nullIfAbsent(master.identity.headline)),
        phone: nullIfAbsent(master.identity.phone),
        location: nullIfAbsent(master.identity.location),
      },
      // Order is a tailoring decision, carried through untouched.
      section_order: tailored.section_order,
      // Prose if there was any, already checked for declared support above.
      summary: tailored.summary === null ? null : tailored.summary.text,
      // Every field below was copied out of the pinned master by typed code, which
      // is what makes a ResolvedResume unconstructible by an LLM.
      skills: resolvedSkills,
      experience: resolvedExperience,
      projects: resolvedProjects,
      education: resolvedEducation,
      // REQUIRED ARRAYS ON `ResolvedResume`, POSSIBLY EMPTY. Present here as plain
      // assignments rather than conditional spreads because the contract made them
      // required precisely so that an omission is a compile error at this, the only
      // production construction site, instead of a resume that silently renders
      // without two of its sections.
      achievements: resolvedAchievements,
      certifications: resolvedCertifications,
    },
  };
}
