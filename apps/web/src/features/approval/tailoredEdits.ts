/* Editing the tailored resume on the approval page - the PURE half (task 8).
 *
 * No React, no Supabase: every function takes a resume and returns a NEW one, so the
 * page, the save path and the tests all exercise the same transformations, and a
 * failed save can simply keep the old object because nothing was mutated in place.
 *
 * R0' IS THE POINT OF THIS FILE (2026-11-01; it replaced R0, "only text changed"). Every node
 * on the resume traces to the pinned master under its true parent. An edit may write a bullet's
 * `text` or the top-level `summary` string, (T3) append a skill built field for field from a
 * pinned-master node, reorder bullets and sections, take bullets and entries off, and put master
 * bullets and entries back on - copied whole from FULL, the entire master as the validator
 * resolves it - and nothing else. `master_text` is the Auditor's and the diff's
 * ground truth (supabase/functions/_shared/audit/detector.ts:404); writing it would
 * make an operator's wording read back as traced-from-master. Every write below either
 * spreads an existing node with exactly one field replaced or copies a validator-built node
 * whole, so there is no code path here that names master_text, ref, identity, master_version
 * or schema_version on the left-hand side of anything.
 *
 * "Edited" is never stored. It is derived by comparing the stored resume with the
 * ORIGINAL rebuilt from `tailor_refs` + the pinned master (rebuildOriginal below),
 * which is why this file needs the validator and nothing new needs a column. */

/* Type-only: the resume and master shapes, from the app's single contract seam. */
import type { MasterProfile, ResolvedResume, TailoredProfile } from '../../data/contract';
/* Type-only: the edit target union is owned by the view model that renders it. */
import type { EditTarget } from './diffModel';
/* The SAME validator that produced the stored resume, reached by relative path into
   the Deno tree (precedent: jd-keywords.ts in diffAdapter.ts). Rebuilding the
   original with any other code would let "original" drift from what the tailor
   actually produced. Safe to bundle: pure, with type-only imports. */
import { validateTailoredProfile } from '../../../../../supabase/functions/_shared/tailor/validator.ts';
/* THE PRODUCER'S keyword rule (T3), the same relative-path import diffAdapter.ts uses: the tailor
   chose the JD keywords with this word-bounded matcher, so deciding which master skill supplies a
   keyword with any looser rule ("Go" inside "Google") would offer the wrong skill. Pure, no imports. */
import { keywordAppearsIn } from '../../../../../supabase/functions/_shared/tailor/jd-keywords.ts';
/* THE PRODUCER'S list of section kinds (R0' rule 3), by the same relative path: the tailor's JSON
   schema offers exactly these to the model, with a compile-time check against the contract type, so
   "a known kind" here can never drift from what a tailoring may name. Type-only imports, no I/O. */
import { TAILOR_SECTION_KINDS } from '../../../../../supabase/functions/_shared/tailor/prompt.ts';

/* The bullet node, derived from ResolvedResume rather than imported, because the
   contract seam re-exports only ResolvedResume and widening it is not this file's call. */
type ResolvedBullet = ResolvedResume['experience'][number]['bullets'][number];
/* The resolved skill node {ref, name, category}, derived for the same reason. Exported because
   addableSkillFor returns one and its callers (page, tests) need to name the type. */
export type ResolvedSkill = ResolvedResume['skills'][number];

/* Every section whose entries carry `bullets`. Listed once so locate, remove and
   reset cannot disagree about where a bullet may live. */
const BULLET_SECTIONS = ['experience', 'projects', 'education', 'achievements', 'certifications'] as const;
/* The section names as a type, so a typo in a section key fails typecheck. */
export type BulletSection = (typeof BULLET_SECTIONS)[number];
/* The sections the diff renders, which since R0' (2026-11-01) is all five: the gate lets an operator
   change every bullet section, and D5a says anything the gate allows must be visible in the diff and
   count as an edit, or the row would be saved with editCount 0 and batch-approved unseen. So this IS
   BULLET_SECTIONS, by reference, and the two cannot disagree. It still MUST MATCH `bulletGroups` in
   diffAdapter.ts (not exported, so not imported); tailoredEdits.test.ts reads diffAdapter's source
   and fails if the lists drift. Exported only so that test can compare against it. */
export const DIFF_BULLET_SECTIONS = BULLET_SECTIONS;
/* The one thing all five entry shapes share, and the only thing this file touches. */
type BulletEntry = { readonly ref: string; readonly bullets: readonly ResolvedBullet[] };

/* The longest edit accepted. A bullet is a sentence or two; 2000 characters is far past
   any real one, so hitting it means a paste accident, not a resume line. Exported (2026-11-01)
   so attestBullet.ts holds a NEW master bullet to the same cap as an edited one. */
export const MAX_EDIT_LENGTH = 2000;

/* The result of every mutation. A union rather than a throw, so the UI must handle the
   refusal arm to compile - a thrown error is one missing try away from a blank page. */
export type EditOutcome =
  /* The new resume plus the before/after text the save path records as the event detail. */
  | { readonly ok: true; readonly resume: ResolvedResume; readonly before: string | null; readonly after: string | null }
  /* Why nothing changed, phrased for the operator. */
  | { readonly ok: false; readonly reason: string };

/* Rebuild what the tailor produced, so the page can tell an edit from the tailor's text.
 *
 * `tailor_refs` on the application row IS the validated TailoredProfile, and the
 * validator is deterministic, so validate(tailor_refs, pinnedMaster, version)
 * reproduces the resume the tailor stored before any edit. Returns null - never
 * throws - when that is impossible; the page then disables editing and says why (D4). */
export function rebuildOriginal(tailorRefs: unknown, master: MasterProfile, version: number): ResolvedResume | null {
  /* tailor_refs is jsonb: it may be null, an array, or a pre-task-8 shape. Validate the
     SHAPE the validator walks before handing it over, rather than letting it throw. */
  if (!isTailoredProfileShape(tailorRefs)) return null;
  /* The validator indexes nested arrays it trusts the type for; a deeply malformed row
     could still throw inside it. Caught so the page degrades to D4 instead of crashing. */
  try {
    /* The validator is the only producer of a ResolvedResume; reuse it, never re-implement. */
    const result = validateTailoredProfile(tailorRefs, master, version);
    /* A refusal means the pin or the master no longer supports this tailoring: no original. */
    return result.ok ? result.resume : null;
  } catch {
    /* Malformed beyond the top-level check: the honest answer is "no original", which
       disables editing and shows the reason (D4) - never a throw that blanks the page. */
    return null;
  }
}

/* Stable key for one edit target, for React keys, per-line saving state and p_detail.edited_refs.
   A bullet's ref is already unique across the resume; the summary and the skills list have no
   ref of their own, so each gets a fixed key that no NodeId is expected to take. */
export function editKey(t: EditTarget): string {
  /* A switch with no default: the `never` check below makes a fourth arm fail typecheck here. */
  switch (t.kind) {
    /* The bullet's own ref. */
    case 'bullet':
      return t.ref;
    /* The one summary. */
    case 'summary':
      return 'summary';
    /* The whole skills list (T3), which the page records as one edited line. */
    case 'skills':
      return 'skills';
  }
  /* Unreachable while the union has three arms; a new arm turns this into a compile error. */
  const unhandled: never = t;
  /* Kept for the type check above; returned so the function still has a string at runtime. */
  return String(unhandled);
}

/* Replace one bullet's text, or the summary, with the operator's wording. */
export function applyTextEdit(current: ResolvedResume, target: EditTarget, text: string): EditOutcome {
  /* T3: the skills list takes no typed text, ever. A skill is a ref into the master, so a typed
     skill would be an invented one - the exact claim the auditor exists to stop. Refused before
     anything else, so no later branch can treat the skills target as a bullet. */
  if (target.kind === 'skills') return { ok: false, reason: 'Skills are chosen from your master profile, not typed. Use Add or Remove.' };
  /* Leading/trailing whitespace is never intentional on a resume line and would make an
     unchanged line compare as edited. */
  const trimmed = text.trim();
  /* An empty edit is a deletion in disguise; Remove is the explicit path for that (D2). */
  if (trimmed === '') return { ok: false, reason: 'The text cannot be empty. Use Remove to drop a bullet.' };
  /* Refuse rather than truncate: silently cutting the operator's text is worse than saying no. */
  if (trimmed.length > MAX_EDIT_LENGTH) {
    /* The limit is named so the operator knows how far over they are. */
    return { ok: false, reason: `The text is longer than ${MAX_EDIT_LENGTH} characters.` };
  }

  /* The summary is a bare top-level string, so it is replaced directly. */
  if (target.kind === 'summary') {
    /* Saving identical text would record an edit event for a change that did not happen. */
    if (current.summary === trimmed) return { ok: false, reason: 'Nothing changed.' };
    /* New object, only `summary` replaced; every other field carried by reference. */
    return { ok: true, resume: { ...current, summary: trimmed }, before: current.summary, after: trimmed };
  }

  /* Find the bullet by ref; refs are unique, so the first hit is the only hit. */
  const at = locateBullet(current, target.ref);
  /* An unknown ref means the page and the stored resume disagree: refuse, never guess. */
  if (at === null) return { ok: false, reason: 'That bullet is no longer on this resume.' };
  /* The bullet as stored now, for the event's `before`. */
  const old = entriesOf(current, at.section)[at.entryIndex]!.bullets[at.bulletIndex]!;
  /* Same reason as the summary: no event for a no-op. */
  if (old.text === trimmed) return { ok: false, reason: 'Nothing changed.' };
  /* R0 in one line: spread the bullet and replace `text` only, so ref and master_text
     are copied, never assigned. */
  const resume = replaceBullets(current, at.section, at.entryIndex, (bullets) =>
    /* Only the targeted index changes; the rest keep their identity. */
    bullets.map((bullet, i) => (i === at.bulletIndex ? { ...bullet, text: trimmed } : bullet)),
  );
  /* before/after are what the save path writes into the event detail. */
  return { ok: true, resume, before: old.text, after: trimmed };
}

/* Delete one whole bullet from wherever it lives (D2). Reset puts it back. */
export function removeBullet(current: ResolvedResume, target: { kind: 'bullet'; ref: string }): EditOutcome {
  /* Locate it first; there is nothing to remove if the ref is unknown. */
  const at = locateBullet(current, target.ref);
  /* Refuse rather than return the resume unchanged, so the UI never shows "removed" for a no-op. */
  if (at === null) return { ok: false, reason: 'That bullet is no longer on this resume.' };
  /* Kept for the event's `before`, so the audit trail records what was deleted. */
  const old = entriesOf(current, at.section)[at.entryIndex]!.bullets[at.bulletIndex]!;
  /* New array without that one index; the entry itself stays even if it empties. */
  const resume = replaceBullets(current, at.section, at.entryIndex, (bullets) =>
    /* Filter by index, not by ref, because the index is what locate just proved. */
    bullets.filter((_, i) => i !== at.bulletIndex),
  );
  /* after is null: there is no text any more. */
  return { ok: true, resume, before: old.text, after: null };
}

/* Put one line back to the tailor's version: restore edited text, or re-insert a
   removed bullet at its original position. */
export function resetTarget(current: ResolvedResume, original: ResolvedResume, target: EditTarget): EditOutcome {
  /* The summary: copy the original string back, whatever it was (including null). */
  if (target.kind === 'summary') {
    /* No-op reset would record an event for nothing. */
    if (current.summary === original.summary) return { ok: false, reason: 'Nothing to reset.' };
    /* Only `summary` replaced. */
    return { ok: true, resume: { ...current, summary: original.summary }, before: current.summary, after: original.summary };
  }

  /* T3: the skills list goes back to EXACTLY the tailor's list - every added skill dropped, the
     tailor's own in the tailor's order. Copying the validator's array (by reference) is restoring,
     not assigning, so every skill arrives exactly as the validator resolved it from the master. */
  if (target.kind === 'skills') {
    /* Already the tailor's list: no event for a no-op. */
    if (deepEqual(current.skills, original.skills)) return { ok: false, reason: 'Nothing to reset.' };
    /* Only `skills` replaced; every other field carried by reference. */
    const resume: ResolvedResume = { ...current, skills: original.skills };
    /* before/after as the printed lists, so the event alone shows what the reset undid. */
    return { ok: true, resume, before: skillNames(current.skills), after: skillNames(original.skills) };
  }

  /* Where the bullet lived in the tailor's version - the only source of its text. */
  const from = locateBullet(original, target.ref);
  /* A ref the tailor never produced has no original to restore. */
  if (from === null) return { ok: false, reason: "That bullet is not in the tailor's version, so there is nothing to reset to." };
  /* The tailor's bullet, verbatim from the validator. */
  const originalBullet = entriesOf(original, from.section)[from.entryIndex]!.bullets[from.bulletIndex]!;

  /* Still on the resume: an edit to undo. */
  const at = locateBullet(current, target.ref);
  /* Edited case: restore text only, R0 - the stored node keeps its own ref and master_text. */
  if (at !== null) {
    /* The current wording, for the event's `before`. */
    const old = entriesOf(current, at.section)[at.entryIndex]!.bullets[at.bulletIndex]!;
    /* Already the tailor's text: nothing to undo. */
    if (old.text === originalBullet.text) return { ok: false, reason: 'Nothing to reset.' };
    /* Spread and replace `text` only, exactly like an edit. */
    const resume = replaceBullets(current, at.section, at.entryIndex, (bullets) =>
      /* Only that index changes. */
      bullets.map((bullet, i) => (i === at.bulletIndex ? { ...bullet, text: originalBullet.text } : bullet)),
    );
    /* after is the restored tailor text. */
    return { ok: true, resume, before: old.text, after: originalBullet.text };
  }

  /* Removed case: the entry that held it, found by ref in the CURRENT resume. */
  const originalEntry = entriesOf(original, from.section)[from.entryIndex]!;
  /* Index of that entry now; removeEntry (R0') can take it off, so this lookup can genuinely miss. */
  const entryIndex = entriesOf(current, from.section).findIndex((entry) => entry.ref === originalEntry.ref);
  /* No entry to put it back into means the stored resume diverged in a way no edit here produces. */
  if (entryIndex === -1) return { ok: false, reason: 'The entry that held this bullet is no longer on this resume.' };
  /* The original order of every bullet in that entry, by ref. */
  const originalOrder = originalEntry.bullets.map((bullet) => bullet.ref);
  /* "Its ORIGINAL index" means its place relative to the bullets still present: count the
     current bullets the tailor put before it. A raw index would land wrong once an earlier
     sibling is also removed ([a,b,c] minus a and b, reset b -> [b,c], not [c,b]). */
  const insertAt = entriesOf(current, from.section)[entryIndex]!.bullets.filter(
    /* Bullets the tailor did not produce rank as "before" nothing, so they stay put after it. */
    (bullet) => {
      /* Position of this sibling in the tailor's order; -1 if the tailor never had it. */
      const rank = originalOrder.indexOf(bullet.ref);
      /* Only siblings that preceded it in the original push it rightwards. */
      return rank !== -1 && rank < from.bulletIndex;
    },
  ).length;
  /* Re-insert the validator's own bullet object: copying a validated node verbatim is
     restoring, not assigning, so R0's ground truth arrives exactly as the validator wrote it. */
  const resume = replaceBullets(current, from.section, entryIndex, (bullets) => [
    /* Everything that precedes it in the original order. */
    ...bullets.slice(0, insertAt),
    /* The restored bullet. */
    originalBullet,
    /* Everything after. */
    ...bullets.slice(insertAt),
  ]);
  /* before is null: the bullet was not on the resume. */
  return { ok: true, resume, before: null, after: originalBullet.text };
}

/* --- Skills (T3, Option A, 2026-10-08) ------------------------------------------
 *
 * A resume skill is ONLY a ref into the master: ResolvedSkill {ref, name, category}, with
 * name and category copied from the master by the validator. So the one honest skills edit
 * is a SELECTION change - put an unselected master skill on, or take an added one back off.
 * Every skill these functions emit is built from a master node, field for field; there is no
 * parameter through which a caller could supply a name or a category. */

/* A skill-ish phrase reduced to the TOKENS that name it, for "do these denote the same thing?".
 * Lowercased; split on anything that is not a letter, digit, '+' or '#' (so "C++" and "C#" stay
 * themselves, never "c"); and one alias: a trailing "js" token is dropped, so "React" = "React.js"
 * and "Node" = "Node.js". Deliberately NOT "reactjs": that is one token, and the producer rule does
 * not find "ReactJS" in "React.js" either, so adding React.js would not clear that miss.
 * Exported 2026-11-04 so attestSkill's "already printed?" check uses this same identity rule. */
export function skillTokens(phrase: string): string {
  /* Tokens in order; empty pieces from leading/trailing punctuation are dropped. */
  const tokens = phrase.toLowerCase().split(/[^a-z0-9+#]+/).filter((token) => token !== '');
  /* The ".js" alias only when something precedes it: a bare "JS" keyword stays "js", never "". */
  if (tokens.length > 1 && tokens[tokens.length - 1] === 'js') tokens.pop();
  /* Joined so equality of the whole token sequence is one string compare. */
  return tokens.join(' ');
}

/* The unselected master skill that would supply a missing JD keyword, or null if the master
 * has none. Rule (changed 2026-10-08, QA s6): the keyword and the skill name must DENOTE THE SAME
 * THING - equal token sequences (skillTokens) - AND adding the skill must actually clear the miss
 * by the producer's rule (keywordAppearsIn(keyword, name)), with no case-insensitive shortcut
 * (that let "Go" offer a skill spelled "go" that the producer still reads as missing). The old rule was a word-bounded substring in BOTH directions, which
 * failed open (CLAUDE.md §6): "SQL Server" offered "SQL" (adding SQL leaves SQL Server missing),
 * and a generic word offered a specific skill ("Engineering" -> Prompt Engineering, "Calling" ->
 * Tool Calling & Guardrails). Token equality subsumes the old "C" in "C++" guard: "c++" != "c".
 * Deterministic: the first qualifying skill in MASTER order. */
export function addableSkillFor(keyword: string, resume: ResolvedResume, master: MasterProfile): ResolvedSkill | null {
  /* A blank keyword would match vacuously; it is never a reason to offer a skill. */
  if (keyword.trim() === '') return null;
  /* Refs already printed, so a skill the resume has is never offered twice. */
  const onResume = new Set(resume.skills.map((skill) => skill.ref));
  /* The keyword's identity, computed once rather than per master skill. */
  const wanted = skillTokens(keyword);
  /* Master order is the tie-break, so `find` (first hit) is the whole rule. */
  const hit = master.skills.find(
    (skill) =>
      /* Already on the resume: adding it again would be a duplicate the validator refuses. */
      !onResume.has(skill.id) &&
      /* Same thing by name: same tokens, so neither side may be a fragment of the other. */
      skillTokens(skill.name) === wanted &&
      /* AND the add provably clears the miss by the producer's own rule - "CI-CD" vs "CI/CD"
         tokenize alike, yet the latter would not count. No case-insensitive shortcut (review
         2026-10-09): case-sensitive vocabulary terms ("Go", "AI", "RAG") would be offered a
         lowercase skill the producer then still reads as missing. Non-vocabulary words already
         match case-insensitively inside keywordAppearsIn, so "go"/"Go" needs no extra branch. */
      keywordAppearsIn(keyword, skill.name),
  );
  /* No master skill supplies it: the UI says "Not in your master profile". */
  if (hit === undefined) return null;
  /* Exactly the validator's resolved shape, every field from the master node. */
  return { ref: hit.id, name: hit.name, category: hit.category };
}

/* Append one unselected master skill to the resume. Refuses anything that is not a master skill
 * or is already printed, so the only skills this can produce are ones the master holds. */
export function addSkill(resume: ResolvedResume, master: MasterProfile, skillRef: string): EditOutcome {
  /* The master node by id; the caller supplies ONLY the ref, never the name. */
  const node = master.skills.find((skill) => skill.id === skillRef);
  /* Not a master skill: adding it would be inventing one. */
  if (node === undefined) return { ok: false, reason: 'That skill is not in your master profile, so it cannot be added.' };
  /* Already printed: a duplicate is no change, and the validator would refuse it. */
  if (resume.skills.some((skill) => skill.ref === skillRef)) return { ok: false, reason: 'That skill is already on this resume.' };
  /* Built field for field from the master, the same shape validator.ts resolves. */
  const added: ResolvedSkill = { ref: node.id, name: node.name, category: node.category };
  /* A NEW array and a NEW resume; the tailor's skills keep their order, the addition goes last. */
  return { ok: true, resume: { ...resume, skills: [...resume.skills, added] }, before: null, after: node.name };
}

/* Take one printed skill off the resume, whoever chose it. Until 2026-11-04 this was
 * removeAddedSkill and refused the tailor's own choices as "out of scope"; then Teja asked the AI
 * chat to drop a duplicate "Testing" and nothing on the page could. Removing any skill is safe:
 * what remains is still a subset of master skills, so tracesToMaster passes, editState turns
 * 'edited' (the row leaves Bucket A), and Reset on the skills line brings the tailor's list back. */
export function removeSkill(resume: ResolvedResume, skillRef: string): EditOutcome {
  /* The printed skill, for the event's `before`. */
  const old = resume.skills.find((skill) => skill.ref === skillRef);
  /* Not on the resume: nothing to remove, and "removed" must never be shown for a no-op. */
  if (old === undefined) return { ok: false, reason: 'That skill is no longer on this resume.' };
  /* A new array without it; every other skill keeps its place. */
  return { ok: true, resume: { ...resume, skills: resume.skills.filter((skill) => skill.ref !== skillRef) }, before: old.name, after: null };
}

/* The gate the save path runs before writing tailored_profile. Checks the shape the
   renderer and the worker depend on, so a malformed object can never be persisted as the
   resume that gets sent. Validates SHAPE: typeof and Array.isArray, never "did a parse fail". */
export function isResumeShape(value: unknown): value is ResolvedResume {
  /* Must be a plain object before any field can be read. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  /* Indexed as a record for the field checks below. */
  const v = value as Record<string, unknown>;
  /* Only schema 1 exists; any other value is a shape this renderer has never seen. */
  if (v['schema_version'] !== 1) return false;
  /* The pin: a positive integer, because 0, NaN or 1.5 are not master versions. */
  if (typeof v['master_version'] !== 'number' || !Number.isInteger(v['master_version']) || v['master_version'] < 1) return false;
  /* Identity is an object the renderer reads fields from. */
  if (typeof v['identity'] !== 'object' || v['identity'] === null || Array.isArray(v['identity'])) return false;
  /* The four sections the contract names; each must be an array, never absent. */
  return ['experience', 'skills', 'projects', 'education'].every((key) => Array.isArray(v[key]));
}

/* 7b (2026-10-08): which master version a tailored resume is pinned to, judged EXACTLY as the
 * auditor's resolvePinnedMaster judges it (supabase/functions/_shared/audit/pinned-master.ts;
 * held by a parity test, not by this comment). Stops before the lookup: the page fetches the
 * version itself, and a pin whose version is not stored is its own refusal there. A closed
 * union, so the page names WHY a row has no pin instead of falling back to another master. */
export type PinRead =
  // The one version this resume may be compared against.
  | { readonly kind: 'pinned'; readonly version: number }
  // No pin recorded at all.
  | { readonly kind: 'unpinned' }
  // A pin of the wrong shape, kept so the refusal can show what was there.
  | { readonly kind: 'invalid_pin'; readonly pin: unknown };

// Exported for the page's classifier and the auditor-parity test.
export function readPin(pin: unknown): PinRead {
  // Absent is its own reason, distinct from malformed, matching the auditor.
  if (pin === null || pin === undefined) return { kind: 'unpinned' };
  // typeof first, so '2' is refused rather than coerced; safe-integer rejects NaN, fractions, Infinity.
  if (typeof pin !== 'number' || !Number.isSafeInteger(pin) || pin <= 0) return { kind: 'invalid_pin', pin };
  // The exact version; there is deliberately no "latest" branch.
  return { kind: 'pinned', version: pin };
}

/* 7b review fix (2026-10-08): WHY a tailored_profile cannot be reviewed, so the refusal names the
 * true cause. `no_pin` ONLY when everything but the pin is resume-shaped: a first version checked the
 * pin first, so `{}` (no resume at all) was labelled "master version missing" and sent the operator
 * to fix a pin instead of re-running the tailor - the very mislabel 7b set out to remove. */
export function classifyTailored(profile: unknown): 'resume' | 'no_pin' | 'not_a_resume' {
  // A full, pinned resume: reviewable.
  if (isResumeShape(profile)) return 'resume';
  // Only a plain object can be "a resume with a bad pin"; null, arrays and strings are no resume.
  if (!isPlainObject(profile)) return 'not_a_resume';
  // The pin, by the auditor's rules.
  const pin = readPin(profile['master_version']);
  // A valid pin here means some OTHER field broke the shape: that is a broken resume, not a pin problem.
  if (pin.kind === 'pinned') return 'not_a_resume';
  // Bad pin: blame it only if a valid pin would have made this a resume.
  return isResumeShape({ ...profile, master_version: 1 }) ? 'no_pin' : 'not_a_resume';
}

/* The master_profiles row's `profile` column as a MasterProfile, or null (D9).
 *
 * The page used to accept any object (`typeof profile === 'object'`), so `{}` became a master
 * and the diff and rebuildOriginal ran against it - the fail-open shape repo CLAUDE.md §5
 * names. This checks the fields those two actually dereference: skillsLine maps
 * `skills[].name`; the validator reads `summary.id`, `skills[].id`, and walks every bullet
 * section's `[].id` and `[].bullets[].{id,text}`; identity is copied verbatim. Returns the
 * input itself, never a copy, so a check cannot quietly become a normalisation. */
export function masterFromRow(row: unknown): MasterProfile | null {
  /* jsonb can hold anything; only a plain object can be a profile. */
  if (!isPlainObject(row)) return null;
  /* Schema 1 is the only shape the validator and diff were written against. */
  if (row['schema_version'] !== 1) return null;
  /* Copied verbatim into every resume; read field by field by the renderer. */
  if (!isPlainObject(row['identity'])) return null;
  /* Required-but-nullable; when present the validator reads its id and the preview its text. */
  const summary = row['summary'];
  /* Null is a legal "no summary"; anything else must carry a string id and text. */
  if (summary !== null && !(isPlainObject(summary) && typeof summary['id'] === 'string' && typeof summary['text'] === 'string')) return null;
  /* skillsLine maps names and the validator indexes ids, so each skill needs both as strings.
     Review fix (2026-10-08): category too. addSkill and the R0 check copy it into {ref, name,
     category} and deepEqual it against the stored skill; a missing category made every row
     load as "edited" (Bucket B) and refused every add, so the row is refused here instead. */
  if (!isArrayOf(row['skills'], (s) => typeof s['id'] === 'string' && typeof s['name'] === 'string' && typeof s['category'] === 'string')) return null;
  /* Required array; not dereferenced here, but a non-array would break the next reader that is. */
  if (!Array.isArray(row['links'])) return null;
  /* All five bullet-bearing sections: the validator walks every one with `for..of parent.bullets`. */
  const sectionsOk = BULLET_SECTIONS.every((section) =>
    /* Each entry: a string id (its parentRef) and a bullets array of string id + text. */
    isArrayOf(row[section], (entry) => typeof entry['id'] === 'string' && isArrayOf(entry['bullets'], (b) => typeof b['id'] === 'string' && typeof b['text'] === 'string')),
  );
  /* The cast is earned by the checks above; the same object goes back unchanged. */
  return sectionsOk ? (row as unknown as MasterProfile) : null;
}

/* R0' AT THE WRITE BOUNDARY (2026-11-01; replaces onlyTextChanged). True only if every node on
 * `next` traces to the pinned master under its true parent. The rules, numbered as in
 * docs/ui/2026-11-01-review-structure-edits-contract.md:
 *   1. every top-level key except summary, skills, section_order and the five bullet sections
 *      equals `previous` (identity, schema_version and the pin never move here; a re-pin relabels
 *      `previous` in saveTailoredEdit before this runs);
 *   2. summary is a string or null; skills are unchanged, or the tailor's plus master skills (T3);
 *   3. a CHANGED section_order lists unique known kinds, and no section an edit touched is left
 *      without a slot (see sectionOrderHolds for why unchanged ones are not re-judged);
 *   4. every entry is FULL's entry in the same section, field for field except `bullets`, once;
 *   5. every bullet is FULL's bullet under the same section and the same parent entry, field for
 *      field except `text`, and appears once on the whole resume.
 * So entries and bullets may be added (from FULL), removed and reordered - the R0' widening - while
 * an invented node, a relocated claim, a renamed employer or a rewritten master_text still fail.
 *
 * The functions in this file keep R0' by construction. That holds only for callers that use them,
 * so the save path calls this just before writing: a resume built any other way - a future caller,
 * an AI op, a bug, a hand-crafted object - is refused before it can reach tailored_profile. Two
 * independent controls answering two questions: "did we build it right" and "does what we are about
 * to write still trace to the master". */
export function tracesToMaster(
  /* The resume the edit was computed from (what is stored now). */
  previous: ResolvedResume,
  /* The candidate about to be written. */
  next: ResolvedResume,
  /* The tailor's version, rebuilt by the validator: the base the skills rule measures against. */
  original: ResolvedResume,
  /* The PINNED master: FULL is resolved from it, and an added skill may come only from it.
     Required, so no caller can forget it and silently fall back to a weaker rule. */
  master: MasterProfile,
): boolean {
  /* Read as records so EVERY top-level key is checked, including ones added to the type later. */
  const prev = previous as unknown as Record<string, unknown>;
  /* Same view of the candidate, which is untrusted at this boundary. */
  const nxt = next as unknown as Record<string, unknown>;
  /* Rule 1: the keys an edit may touch. Each one has its own rule below; none is left unchecked. */
  const free = new Set<string>(['summary', 'skills', 'section_order', ...BULLET_SECTIONS]);
  /* Union of both key sets, so a key ADDED to next is checked as well as a changed one. */
  for (const key of new Set([...Object.keys(prev), ...Object.keys(nxt)])) {
    /* Own keys only: `prev['__proto__']` would read Object.prototype, which deep-equals `{}`, so a
       smuggled own "__proto__" key would pass as "unchanged" (review finding, 2026-11-01). */
    if (!free.has(key) && Object.prototype.hasOwnProperty.call(prev, key) !== Object.prototype.hasOwnProperty.call(nxt, key)) return false;
    /* schema_version, master_version, identity, and anything else must be untouched. */
    if (!free.has(key) && !deepEqual(prev[key], nxt[key])) return false;
  }
  /* Rule 2: the summary is free text, but it must still BE text or null - not an object smuggled in. */
  if (next.summary !== null && typeof next.summary !== 'string') return false;
  /* Rule 2: unchanged skills are always fine, so an unrelated edit is never blocked by them; a
     CHANGED list must be the tailor's list plus master skills only (T3, unchanged by R0'). */
  if (!deepEqual(prev['skills'], nxt['skills']) && !skillsAreOriginalPlusMaster(nxt['skills'], original, master)) return false;
  /* Rule 3: the order itself, and a slot for every section the edit changed. */
  if (!sectionOrderHolds(prev, nxt)) return false;
  /* FULL: every master node as the validator resolves it, at the pin rule 1 just held fixed. */
  const full = resolveFullMaster(master, next.master_version);
  /* No FULL means nothing can be traced, so nothing passes: fail closed, as D4 does. */
  if (full === null) return false;

  /* FULL's entries keyed by section + ref: an entry is real only in its own section. */
  const fullEntries = new Map<string, BulletEntry>();
  /* FULL's bullets by ref, WITH their home. The parent is part of the claim - the same bullet under
     another employer is fabricated history (validator.ts indexBullets keeps parentRef for the same
     reason). Ids are globally unique in a master the validator accepted, so set never overwrites. */
  const fullBullets = new Map<string, { bullet: ResolvedBullet; section: BulletSection; parentRef: string }>();
  /* Every section of FULL, walked once. */
  for (const section of BULLET_SECTIONS) {
    /* Each entry, and each bullet beneath it. */
    for (const entry of entriesOf(full, section)) {
      /* Section-qualified, so an achievement ref cannot pass as an experience entry. */
      fullEntries.set(section + '/' + entry.ref, entry);
      /* Each bullet, remembered with the section and entry it hangs from. */
      for (const bullet of entry.bullets) fullBullets.set(bullet.ref, { bullet, section, parentRef: entry.ref });
    }
  }
  /* Every entry and bullet ref seen in next. One id space (the validator refuses a master that
     reuses an id anywhere), so a ref twice anywhere on the resume is a duplicate. */
  const seen = new Set<string>();

  /* Rules 4 and 5, section by section. */
  for (const section of BULLET_SECTIONS) {
    /* Raw value, not entriesOf: an absent section must stay absent, not read as []. */
    const after = nxt[section];
    /* Not an array (e.g. a legacy row with no achievements key): must be exactly what was stored. */
    if (!Array.isArray(after)) {
      /* deepEqual decides, so a section vanishing or turning into garbage is a change. */
      if (!deepEqual(prev[section], after)) return false;
      /* Nothing to walk. */
      continue;
    }
    /* Each entry must be proven to be one of FULL's. */
    for (const entry of after as unknown[]) {
      /* An entry must be an object before its fields can be read. */
      if (!isPlainObject(entry)) return false;
      /* Its ref, read defensively. */
      const ref = entry['ref'];
      /* No string ref, or one already seen: not a traced entry. */
      if (typeof ref !== 'string' || seen.has(ref)) return false;
      /* Remembered for the duplicate check. */
      seen.add(ref);
      /* FULL's entry with the same ref in the SAME section; undefined means invented or relocated. */
      const home = fullEntries.get(section + '/' + ref);
      /* Not in FULL there: an invented employer, project, degree, award or credential. */
      if (home === undefined) return false;
      /* Every display field (company, role, dates, links, label...) is the master's, verbatim. */
      if (!deepEqual(withoutKey(entry, 'bullets'), withoutEmptyKeysAbsentFrom(withoutKey(home, 'bullets'), entry))) return false;
      /* The entry's bullets, which must be an array to be walked at all. */
      const bullets = entry['bullets'];
      /* A non-array here is a malformed entry. */
      if (!Array.isArray(bullets)) return false;
      /* Each bullet must be one of FULL's, under THIS entry, with only its text free. */
      for (const bullet of bullets as unknown[]) {
        /* A bullet must be an object before its fields can be read. */
        if (!isPlainObject(bullet)) return false;
        /* Its ref, read defensively. */
        const bulletRef = bullet['ref'];
        /* No string ref, or one already seen anywhere: not a traced bullet. */
        if (typeof bulletRef !== 'string' || seen.has(bulletRef)) return false;
        /* Remembered for the duplicate check. */
        seen.add(bulletRef);
        /* Where the master holds it. */
        const at = fullBullets.get(bulletRef);
        /* Absent from FULL is an invented bullet; another section or entry is a relocated claim. */
        if (at === undefined || at.section !== section || at.parentRef !== ref) return false;
        /* Text is free, but it must be a non-blank string within the edit cap. Checked HERE, not
           only in applyTextEdit, so a hand-built object or a future caller cannot save an empty or
           runaway bullet past the boundary (review finding, 2026-11-01). */
        const text = bullet['text'];
        /* A string, not blank, at most MAX_EDIT_LENGTH: anything else is not a printable bullet. */
        if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_EDIT_LENGTH) return false;
        /* master_text, ref and any other field must equal FULL's exactly: the line that makes R0' checkable. */
        if (!deepEqual(withoutKey(bullet, 'text'), withoutKey(at.bullet, 'text'))) return false;
      }
    }
  }
  /* Every node traced to the pinned master under its own parent. */
  return true;
}

/* R0' rule 3, for tracesToMaster. A CHANGED section_order must be an array of unique kinds the
 * tailor's schema offers: a duplicate prints a section twice, an unknown kind prints nothing. An
 * UNCHANGED order is the tailor's own and is not re-judged: the tailor checks only that it is an
 * array (tailorer.ts parseTailoredProfile), so refusing a stored quirk would lock every edit on that
 * row while protecting nothing this edit did. Then every non-empty bullet section needs a slot -
 * unless the edit left it exactly as stored, for the same reason - because a section an edit
 * changed but the PDF never prints is a change nobody can review. addMasterEntry appends the slot,
 * so the page's own output always passes. */
function sectionOrderHolds(prev: Record<string, unknown>, nxt: Record<string, unknown>): boolean {
  /* The candidate order, untrusted. */
  const order = nxt['section_order'];
  /* Only a changed order is held to the shape rule. */
  if (!deepEqual(prev['section_order'], order)) {
    /* Not an array: not an order at all. */
    if (!Array.isArray(order)) return false;
    /* A kind listed twice would render that section twice. */
    if (new Set(order).size !== order.length) return false;
    /* Every kind must be one the producer's schema offers; widened so `includes` accepts unknown. */
    if (!order.every((kind) => (TAILOR_SECTION_KINDS as readonly unknown[]).includes(kind))) return false;
  }
  /* The slots the PDF prints; an unchanged non-array order has none. */
  const slots = new Set<unknown>(Array.isArray(order) ? order : []);
  /* Each bullet section must be empty, slotted, or untouched by this edit. */
  return BULLET_SECTIONS.every((section) => {
    /* The candidate's entries for this section. */
    const entries = nxt[section];
    /* Absent or empty needs no slot; slotted prints; unchanged is the tailor's own choice. */
    return !Array.isArray(entries) || entries.length === 0 || slots.has(section) || deepEqual(prev[section], entries);
  });
}

/* --- internals -------------------------------------------------------------- */

/* T3's save-boundary rule for a CHANGED skills list. True only when:
 *   1. it is an array of plain objects;
 *   2. every one of the tailor's skills is present, deep-equal to the validator's node, and in
 *      the tailor's relative order (a subsequence walk) - none dropped, none altered, none moved
 *      past another;
 *   3. every other entry deep-equals {ref, name, category} of a master skill, built from the
 *      master node - so no invented skill, and no real ref wearing an edited name or category;
 *   4. no ref appears twice.
 * Positive shape throughout: each entry must be proven to be one of the two allowed kinds. */
function skillsAreOriginalPlusMaster(candidate: unknown, original: ResolvedResume, master: MasterProfile): boolean {
  /* Not an array: not a skills list at all. */
  if (!Array.isArray(candidate)) return false;
  /* A missing master (an old 3-argument caller at runtime) can vouch for nothing: fail closed. */
  if (!isPlainObject(master) || !Array.isArray(master.skills)) return false;
  /* The master's skills by id, each as the exact node an add would build. */
  const fromMaster = new Map<string, ResolvedSkill>(
    /* Field for field, the same construction addSkill uses, so "deep-equal" means "built by addSkill". */
    master.skills.map((skill) => [skill.id, { ref: skill.id, name: skill.name, category: skill.category }]),
  );
  /* The tailor's skills by ref, with their position, so order can be enforced. */
  const tailorIndex = new Map<string, number>(original.skills.map((skill, index) => [skill.ref, index]));
  /* Refs seen so far, for the duplicate check. */
  const seen = new Set<string>();
  /* How many of the tailor's skills have been seen, which must reach all of them by the end. */
  let tailorSeen = 0;
  /* The last tailor skill's position; strictly increasing means the tailor's order is kept. */
  let lastTailorIndex = -1;
  /* Every entry, proven to be either a tailor skill or a master addition. */
  for (const entry of candidate as unknown[]) {
    /* Each skill must be an object before its ref can be read. */
    if (!isPlainObject(entry)) return false;
    /* The ref, read defensively: `next` is untrusted at this boundary. */
    const ref = entry['ref'];
    /* A skill without a string ref is not a skill. */
    if (typeof ref !== 'string') return false;
    /* Twice on one resume is a duplicate the validator itself would refuse. */
    if (seen.has(ref)) return false;
    /* Remember it. */
    seen.add(ref);
    /* Where the tailor put it, if the tailor chose it. */
    const at = tailorIndex.get(ref);
    /* A tailor skill: must be the validator's node verbatim, in the tailor's order. */
    if (at !== undefined) {
      /* Any field changed (a renamed skill) is outside R0. */
      if (!deepEqual(entry, original.skills[at])) return false;
      /* Behind an earlier tailor skill is a reorder, not an addition. */
      if (at <= lastTailorIndex) return false;
      /* Advance the floor. */
      lastTailorIndex = at;
      /* Count it toward "all of the tailor's skills are still here". */
      tailorSeen += 1;
      /* Proven; next entry. */
      continue;
    }
    /* Otherwise it must be a master skill, exactly as the master holds it. */
    const node = fromMaster.get(ref);
    /* Not in the master: an invented skill. Or in it with any other field: a relabelled one. */
    if (node === undefined || !deepEqual(entry, node)) return false;
  }
  /* Every one of the tailor's skills is still printed; dropping one is not this page's edit. */
  return tailorSeen === original.skills.length;
}

/* A skills list as it prints, for an event's before/after: names in order, comma-separated. */
function skillNames(skills: readonly ResolvedSkill[]): string {
  /* The same separator the diff's skills line uses, so the log reads like the screen. */
  return skills.map((skill) => skill.name).join(', ');
}

/* Structural equality for JSON-shaped values. Key order is ignored, because a resume read
   back from jsonb comes out with Postgres's key order, not the order we spread in - a
   JSON.stringify comparison would refuse every honest save of a stored resume. */
/* Exported (2026-10-08) so saveTailoredEdit.ts reads the SAME equality rule when it checks
   whether an unconfirmed write landed, instead of keeping a copy that can drift. */
export function deepEqual(a: unknown, b: unknown): boolean {
  /* Same primitive or same reference. */
  if (a === b) return true;
  /* Different primitives, or one side null/undefined: unequal. */
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  /* An array never equals a plain object, even an index-keyed one. */
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  /* Read both as records for key-wise comparison (arrays included: indices are keys). */
  const ra = a as Record<string, unknown>;
  /* The other side. */
  const rb = b as Record<string, unknown>;
  /* Own keys of each; undefined-valued keys count, which is the strict reading. */
  const ka = Object.keys(ra);
  /* Same count first, so the loop below only has to look one way. */
  if (ka.length !== Object.keys(rb).length) return false;
  /* Every key present on b, with an equal value. */
  return ka.every((key) => Object.prototype.hasOwnProperty.call(rb, key) && deepEqual(ra[key], rb[key]));
}

/* A non-null, non-array object, narrowed to a record so its fields can be read. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  /* Arrays and null both report typeof 'object'; neither is a record here. */
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* An array whose every element is a plain object passing `check` - the shape every master
   section has. An empty array passes: empty sections are legal masters. */
function isArrayOf(value: unknown, check: (item: Record<string, unknown>) => boolean): boolean {
  /* Shape first, then each element, so `check` only ever sees a record. */
  return Array.isArray(value) && value.every((item) => isPlainObject(item) && check(item));
}

/* A shallow copy without one key, for "equal except this field" comparisons. Copies, so
   the caller's object is never mutated. */
function withoutKey(value: unknown, key: string): unknown {
  /* Non-objects have no key to drop; returned as-is so deepEqual still compares them. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  /* Rest-destructuring drops the key without touching the source. */
  const { [key]: _dropped, ...rest } = value as Record<string, unknown>;
  /* The copy without that key. */
  return rest;
}

/* FULL's entry minus every key that CARRIES NO CONTENT there (null or an empty array) and that the
   stored entry does not have at all. Added 2026-11-01: the validator began filling `links: []` on
   achievements and certifications, so a resume stored before that has no `links` key while FULL
   has `[]`, and a strict compare refused EVERY edit on all 26 live rows (measured). An absent key
   claims nothing, so it may stay absent when the master has nothing there either. Deliberately
   narrow: a key PRESENT on the entry is still compared verbatim, and a missing key whose master
   value has content (a company, a date, a non-empty link list) still fails the compare. */
function withoutEmptyKeysAbsentFrom(full: unknown, entry: Record<string, unknown>): unknown {
  /* Only a plain object has keys to drop. */
  if (!isPlainObject(full)) return full;
  /* A copy, so FULL itself is never mutated. */
  const trimmed: Record<string, unknown> = { ...full };
  /* Each of FULL's keys considered once. */
  for (const [key, value] of Object.entries(full)) {
    /* Content-free on the master's side: null, or an empty list. */
    const empty = value === null || (Array.isArray(value) && value.length === 0);
    /* Dropped only when the stored entry lacks the key entirely (not when it holds a value). */
    if (empty && !Object.prototype.hasOwnProperty.call(entry, key)) delete trimmed[key];
  }
  /* What the entry is compared against. */
  return trimmed;
}

/* Minimal pre-validator shape check on tailor_refs: exactly the top-level fields the
   validator iterates, so it is handed an object it can walk. Deeper malformation is
   left to the validator's own checks plus the catch in rebuildOriginal. */
function isTailoredProfileShape(value: unknown): value is TailoredProfile {
  /* A jsonb column can hold anything; only a plain object can be a TailoredProfile. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  /* Indexed as a record for the field checks. */
  const v = value as Record<string, unknown>;
  /* Schema 1 is the only shape the validator understands. An ABSENT marker is also schema 1:
     the live tailor stores Gemini's parsed output as tailor_refs and never stamps the key
     (tailorer.ts parseTailoredProfile), so requiring it disabled editing on every real row
     while every fixture carried it. Only absence is forgiven - any present value other
     than 1 (2, '1', null) is still a shape this code was not written for. The validator
     below remains the real check: every ref must still resolve against the pinned master. */
  if (!(v['schema_version'] === 1 || !('schema_version' in v))) return false;
  /* The validator compares this against the pin; a non-number would compare unequal anyway,
     but refusing here keeps the reason in one place. */
  if (typeof v['master_version'] !== 'number') return false;
  /* The summary is null or an object; a string here is a pre-contract row. */
  if (v['summary'] !== null && (typeof v['summary'] !== 'object' || Array.isArray(v['summary']))) return false;
  /* Every array the validator loops over must be an array. */
  return ['section_order', 'skills', 'experience', 'projects', 'education', 'achievements', 'certifications'].every(
    /* Absent or non-array would throw inside the validator's for..of. */
    (key) => Array.isArray(v[key]),
  );
}

/* The entries of one bullet-bearing section, typed as the shared shape. Tolerates an
   absent array (a row stored before achievements/certifications existed) as empty,
   because "no entries" is the truthful reading and a throw would blank the page. */
function entriesOf(resume: ResolvedResume, section: BulletSection): readonly BulletEntry[] {
  /* All five entry types extend BulletEntry; the cast only forgets their extra fields. */
  const entries = resume[section] as readonly BulletEntry[] | undefined;
  /* Array.isArray rather than `?? []`, so a non-array value is also treated as empty. */
  return Array.isArray(entries) ? entries : [];
}

/* Where one bullet lives, by ref. Refs are unique across the resume (the validator rejects
   duplicates), so the first match is the only match. */
function locateBullet(
  /* The resume to search - current or original, the walk is identical for both. */
  resume: ResolvedResume,
  /* The bullet's NodeId; the only identifier an edit target carries. */
  ref: string,
  /* All three coordinates, because replaceBullets needs section + entry and the caller
     needs the bullet index; null rather than -1s so "not found" cannot be indexed with. */
): { section: BulletSection; entryIndex: number; bulletIndex: number } | null {
  /* Every bullet-bearing section, in the fixed order. */
  for (const section of BULLET_SECTIONS) {
    /* The entries of this section. */
    const entries = entriesOf(resume, section);
    /* Index loops, because the indices are the result. */
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      /* findIndex on the entry's bullets. */
      const bulletIndex = entries[entryIndex]!.bullets.findIndex((bullet) => bullet.ref === ref);
      /* Found: report all three coordinates. */
      if (bulletIndex !== -1) return { section, entryIndex, bulletIndex };
    }
  }
  /* Not anywhere on the resume. */
  return null;
}

/* Return a NEW resume in which one entry's bullets array is replaced. Every other section,
   entry and field is carried by reference, so the caller's object is never mutated. */
function replaceBullets(
  /* The resume to copy from; read only, never written. */
  resume: ResolvedResume,
  /* Which bullet-bearing section holds the entry - a closed union, so no typo reaches here. */
  section: BulletSection,
  /* The entry's position, as locateBullet proved it a moment ago. */
  entryIndex: number,
  /* The change itself, as a pure function of the old bullets, so each caller states only
     what differs and the copying discipline lives in one place. */
  update: (bullets: readonly ResolvedBullet[]) => readonly ResolvedBullet[],
  /* A whole new resume, so a failed save can keep the old object untouched. */
): ResolvedResume {
  /* Map over the section so only the targeted entry gets a new object. */
  const entries = entriesOf(resume, section).map((entry, i) =>
    /* Spread the entry and replace `bullets` only; ref and display fields are copied. */
    i === entryIndex ? { ...entry, bullets: update(entry.bullets) } : entry,
  );
  /* The cast restores the section's full entry type, which the spread preserved at runtime. */
  return { ...resume, [section]: entries } as ResolvedResume;
}

/* --- STRUCTURAL EDITS (R0', 2026-11-01) ------------------------------------------------------
 * Signatures from docs/ui/2026-11-01-review-structure-edits-contract.md. Each returns a NEW resume
 * or a named refusal, exactly like the text edits above. Every node they ADD is copied whole from
 * FULL (resolveFullMaster), never assembled from caller-supplied fields, so a stale UI or an AI op
 * can only NAME a master node by ref, never supply its words - and tracesToMaster passes their
 * output by construction. */

/* A section key exactly as section_order spells it. */
export type SectionKind = ResolvedResume['section_order'][number];
/* Which way a bullet or section moves by one place. */
export type MoveDirection = 'up' | 'down';
/* A master bullet not on the resume, with the entry it belongs under (for "Add back"). */
export interface AddableBullet { readonly ref: string; readonly text: string; readonly section: BulletSection; readonly parentRef: string; readonly parentLabel: string }
/* A whole master entry not on the resume (for "Add back"). */
export interface AddableEntry { readonly ref: string; readonly section: BulletSection; readonly label: string }

/* FULL: the whole master resolved by the validator, the ground truth for every node a resume may carry.
 *
 * Selects EVERY master node - each skill, each entry of all five sections with all its bullets, each
 * bullet in the master's own words - and runs the SAME validator the tailor's output went through, so
 * FULL holds every entry and bullet exactly as a tailoring would render it (master_text, display
 * dates, explicit nulls for absent optional fields). One resolver, never a hand-built copy that could
 * drift from it. The summary is left null: the validator accepts that, and FULL's summary is never
 * compared with anything. Returns null - never throws - when the master cannot be resolved
 * (ambiguous ids, no experience/projects/education, a malformed object); editing is then off, as D4
 * does when rebuildOriginal returns null. */
export function resolveFullMaster(master: MasterProfile, version: number): ResolvedResume | null {
  /* A malformed master can throw inside the selection maps or the validator; caught below. */
  try {
    /* One section's selection: every entry by id, every bullet by id with its master text verbatim. */
    const everything = (nodes: readonly { readonly id: string; readonly bullets: readonly { readonly id: string; readonly text: string }[] }[]) =>
      /* Master order is kept: FULL's order is what "relative position" is measured in. */
      nodes.map((node) => ({ ref: node.id, bullets: node.bullets.map((bullet) => ({ ref: bullet.id, text: bullet.text })) }));
    /* The selection a tailoring that picked everything would return. */
    const selection: TailoredProfile = {
      /* The only schema. */
      schema_version: 1,
      /* The pin the validator checks this against; equal by construction. */
      master_version: version,
      /* Every kind in the producer's order, so FULL is a complete resume. */
      section_order: [...TAILOR_SECTION_KINDS],
      /* Null passes the summary_without_refs rule, and FULL's summary is never used. */
      summary: null,
      /* Every skill, by id. */
      skills: master.skills.map((skill) => ({ ref: skill.id })),
      /* Every employer with every bullet. */
      experience: everything(master.experience),
      /* Every project. */
      projects: everything(master.projects),
      /* Every qualification. */
      education: everything(master.education),
      /* Every award. */
      achievements: everything(master.achievements),
      /* Every credential. */
      certifications: everything(master.certifications),
    };
    /* The validator is the only producer of a ResolvedResume; reuse it, never re-implement it. */
    const result = validateTailoredProfile(selection, master, version);
    /* A refusal means this master cannot vouch for anything: no FULL. */
    return result.ok ? result.resume : null;
  } catch {
    /* Malformed beyond what the types promised: "no FULL" is the honest answer, never a throw. */
    return null;
  }
}

/* One bullet one place up or down among its siblings in the same entry. A move never crosses
 * entries: that would re-parent a claim, which tracesToMaster rule 5 refuses anyway. */
export function moveBullet(current: ResolvedResume, ref: string, direction: MoveDirection): EditOutcome {
  /* Where the bullet sits now. */
  const at = locateBullet(current, ref);
  /* An unknown ref means the page and the stored resume disagree: refuse, never guess. */
  if (at === null) return { ok: false, reason: 'That bullet is no longer on this resume.' };
  /* Its siblings, in printed order. */
  const bullets = entriesOf(current, at.section)[at.entryIndex]!.bullets;
  /* The neighbour it trades places with. */
  const to = at.bulletIndex + (direction === 'up' ? -1 : 1);
  /* Already at the edge: a no-op must never be recorded as a move. */
  if (to < 0 || to >= bullets.length) return { ok: false, reason: `That bullet is already ${direction === 'up' ? 'first' : 'last'} in its entry.` };
  /* The new order: the two neighbours swapped, every bullet object carried as is. */
  const moved = swapped(bullets, at.bulletIndex, to);
  /* Only that entry's bullets array is replaced. */
  const resume = replaceBullets(current, at.section, at.entryIndex, () => moved);
  /* before/after are the entry's bullet order by ref, so the event alone can replay the move. */
  return { ok: true, resume, before: refList(bullets), after: refList(moved) };
}

/* One section one place up or down in section_order. Only the order changes: no section is added or dropped. */
export function moveSection(current: ResolvedResume, section: SectionKind, direction: MoveDirection): EditOutcome {
  /* The printed order now. */
  const order = current.section_order;
  /* Where this section sits. */
  const from = order.indexOf(section);
  /* Not printed at all: there is nothing to move. */
  if (from === -1) return { ok: false, reason: 'That section is not on this resume.' };
  /* The neighbour it trades places with. */
  const to = from + (direction === 'up' ? -1 : 1);
  /* At the edge: refuse the no-op. */
  if (to < 0 || to >= order.length) return { ok: false, reason: `That section is already ${direction === 'up' ? 'first' : 'last'}.` };
  /* The new order. */
  const next = swapped(order, from, to);
  /* Only section_order replaced; before/after are the whole order, readable in the log as is. */
  return { ok: true, resume: { ...current, section_order: next }, before: order.join(', '), after: next.join(', ') };
}

/* A master bullet back onto the resume under its own entry, in the master's words (FULL's node,
 * copied whole). The parent entry must already be printed: the bullet alone would be a claim with
 * no employer above it. It goes right after the last printed sibling that precedes it in FULL, so
 * the master's order holds relative to whatever the operator left in place. */
export function addMasterBullet(current: ResolvedResume, full: ResolvedResume, ref: string): EditOutcome {
  /* Already printed: a second copy is a duplicate, which rule 5 refuses. */
  if (locateBullet(current, ref) !== null) return { ok: false, reason: 'That bullet is already on this resume.' };
  /* Where the master holds it; the caller supplies only the ref, never the words. */
  const from = locateBullet(full, ref);
  /* Not a master bullet: adding it would be inventing one. */
  if (from === null) return { ok: false, reason: 'That bullet is not in your master profile, so it cannot be added.' };
  /* The master entry it belongs to. */
  const parent = entriesOf(full, from.section)[from.entryIndex]!;
  /* The same entry on the resume, by ref, in the same section. */
  const entryIndex = entriesOf(current, from.section).findIndex((entry) => entry.ref === parent.ref);
  /* Parent not printed: say what to do first rather than add an orphan. */
  if (entryIndex === -1) return { ok: false, reason: 'The entry this bullet belongs to is not on this resume. Add the entry first.' };
  /* FULL's bullet, verbatim: text and master_text are both the master's own words. */
  const bullet = parent.bullets[from.bulletIndex]!;
  /* Its place among the bullets the resume prints now. */
  const insertAt = insertionIndex(entriesOf(current, from.section)[entryIndex]!.bullets, parent.bullets, from.bulletIndex);
  /* A new bullets array with it spliced in; every other node carried by reference. */
  const resume = replaceBullets(current, from.section, entryIndex, (bullets) => [...bullets.slice(0, insertAt), bullet, ...bullets.slice(insertAt)]);
  /* before is null: the bullet was not on the resume. */
  return { ok: true, resume, before: null, after: bullet.text };
}

/* A whole master entry onto the resume, with all of FULL's bullets for it, at FULL's relative
 * position. A section with no slot in section_order gets one appended, or the entry would be saved
 * but never printed (tracesToMaster rule 3). */
export function addMasterEntry(current: ResolvedResume, full: ResolvedResume, section: BulletSection, ref: string): EditOutcome {
  /* The section's entries as printed now. */
  const present = entriesOf(current, section);
  /* Already printed: a duplicate, which rule 4 refuses. */
  if (present.some((entry) => entry.ref === ref)) return { ok: false, reason: 'That entry is already on this resume.' };
  /* The master's entries for this section, in master order. */
  const masterEntries = entriesOf(full, section);
  /* Its position in the master. */
  const fullIndex = masterEntries.findIndex((entry) => entry.ref === ref);
  /* Not a master entry of this section: adding it would be inventing one. */
  if (fullIndex === -1) return { ok: false, reason: 'That entry is not in your master profile, so it cannot be added.' };
  /* FULL's entry, verbatim: display fields and bullets alike. */
  const entry = masterEntries[fullIndex]!;
  /* Its place among the entries the resume prints now. */
  const insertAt = insertionIndex(present, masterEntries, fullIndex);
  /* A slot for the section if it had none; otherwise the order is untouched. */
  const order = current.section_order.includes(section) ? current.section_order : [...current.section_order, section];
  /* The cast restores the section's entry type, which FULL's node carries at runtime. */
  const resume = { ...current, [section]: [...present.slice(0, insertAt), entry, ...present.slice(insertAt)], section_order: order } as ResolvedResume;
  /* before is null; after names the entry the way the operator reads it. */
  return { ok: true, resume, before: null, after: entryLabel(section, entry) };
}

/* A whole entry off the resume, its bullets with it. The section keeps its slot in section_order:
 * the renderer drops a section that renders empty, and the slot keeps its place if it comes back. */
export function removeEntry(current: ResolvedResume, section: BulletSection, ref: string): EditOutcome {
  /* The section's entries now. */
  const present = entriesOf(current, section);
  /* The entry, for the event's `before`. */
  const old = present.find((entry) => entry.ref === ref);
  /* Not printed: "removed" must never be shown for a no-op. */
  if (old === undefined) return { ok: false, reason: 'That entry is no longer on this resume.' };
  /* A new array without it; every other entry keeps its place and identity. */
  const resume = { ...current, [section]: present.filter((entry) => entry.ref !== ref) } as ResolvedResume;
  /* after is null: the entry is gone. */
  return { ok: true, resume, before: entryLabel(section, old), after: null };
}

/* The display fields that name an entry, per section, in heading order. The master node and the
   resolved entry use the same names, so one table labels both. */
const LABEL_FIELDS: Readonly<Record<BulletSection, readonly string[]>> = {
  // "Aczen Technologies · Full Stack AI Engineer".
  experience: ['company', 'role'],
  // "F1 Race Pace Predictor".
  projects: ['name'],
  // The institution, then the degree.
  education: ['institution', 'degree'],
  // "LeetCode".
  achievements: ['label'],
  // The credential's own label.
  certifications: ['label'],
};

/* A human label for an entry, for the AI chat's view and the "Add back" list. Takes `unknown` because
 * callers label raw master nodes as well as resolved entries; never throws. Falls back to the node's
 * ref (resolved) or id (master), then '', so a label is never "undefined". */
export function entryLabel(section: BulletSection, entry: unknown): string {
  /* Only a plain object has fields to read. */
  const fields = isPlainObject(entry) ? entry : {};
  /* The naming fields that hold real text, in heading order. */
  const parts = LABEL_FIELDS[section].map((key) => fields[key]).filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  /* Joined the way the diff heading reads. */
  if (parts.length > 0) return parts.join(' · ');
  /* Nothing names it: its identifier is still better than a blank. */
  const id = fields['ref'] ?? fields['id'];
  /* A string id, or nothing at all. */
  return typeof id === 'string' ? id : '';
}

/* Master items not on the resume, for "Add back": the missing bullets of every entry the resume
 * prints, and every entry it does not print. A missing entry's bullets are not listed one by one -
 * they come with the entry. FULL order throughout, so the list reads like the master. */
export function addableFromMaster(current: ResolvedResume, full: ResolvedResume): { readonly bullets: readonly AddableBullet[]; readonly entries: readonly AddableEntry[] } {
  /* Every bullet ref printed anywhere, so an offered bullet is never one already there. */
  const printed = new Set(BULLET_SECTIONS.flatMap((section) => entriesOf(current, section).flatMap((entry) => entry.bullets.map((bullet) => bullet.ref))));
  /* The addable bullets, filled below. */
  const bullets: AddableBullet[] = [];
  /* The addable entries, filled below. */
  const entries: AddableEntry[] = [];
  /* Section by section in the fixed order. */
  for (const section of BULLET_SECTIONS) {
    /* The entry refs this section prints. */
    const onResume = new Set(entriesOf(current, section).map((entry) => entry.ref));
    /* Each master entry, in master order. */
    for (const entry of entriesOf(full, section)) {
      /* Its label, computed once for the entry and for each of its bullets. */
      const label = entryLabel(section, entry);
      /* Not printed: the whole entry is addable, and its bullets come with it. */
      if (!onResume.has(entry.ref)) {
        /* Offered as one item. */
        entries.push({ ref: entry.ref, section, label });
        /* Its bullets are not offered separately. */
        continue;
      }
      /* Printed: each master bullet it lacks is addable under it, in the master's words. */
      for (const bullet of entry.bullets) {
        /* Skipped when already printed. */
        if (!printed.has(bullet.ref)) bullets.push({ ref: bullet.ref, text: bullet.text, section, parentRef: entry.ref, parentLabel: label });
      }
    }
  }
  /* Both lists, in master order. */
  return { bullets, entries };
}

/* A copy of `list` with positions i and j traded; the input is never mutated (it is React state). */
function swapped<T>(list: readonly T[], i: number, j: number): T[] {
  /* A fresh array, so the caller's stays as it was. */
  const copy = [...list];
  /* Destructuring swap; both indices were bounds-checked by the caller. */
  [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  /* The reordered copy. */
  return copy;
}

/* An entry's bullet order as one string, for a move event's before/after. */
function refList(bullets: readonly ResolvedBullet[]): string {
  /* Refs, not text: stable under later edits, so the log can replay the move. */
  return bullets.map((bullet) => bullet.ref).join(', ');
}

/* Where a node from FULL goes among the nodes the resume prints now: right after the LAST printed
 * node that precedes it in FULL's order, or first when none does. A printed node FULL does not know
 * ranks as "not before", so it never pulls the new one past itself. Shared by addMasterBullet and
 * addMasterEntry so the two cannot place things by different rules. */
function insertionIndex(present: readonly { readonly ref: string }[], fullOrder: readonly { readonly ref: string }[], fullIndex: number): number {
  /* Each FULL ref's position, for constant-time ranking. */
  const rank = new Map(fullOrder.map((node, index) => [node.ref, index]));
  /* First, unless a predecessor is found below. */
  let insertAt = 0;
  /* Every printed node, in printed order; the last predecessor wins. */
  present.forEach((node, index) => {
    /* This node's place in the master, if it has one. */
    const position = rank.get(node.ref);
    /* A master predecessor moves the insertion point to just after it. */
    if (position !== undefined && position < fullIndex) insertAt = index + 1;
  });
  /* The index to splice at. */
  return insertAt;
}
