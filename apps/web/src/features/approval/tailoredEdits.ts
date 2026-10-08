/* Editing the tailored resume on the approval page - the PURE half (task 8).
 *
 * No React, no Supabase: every function takes a resume and returns a NEW one, so the
 * page, the save path and the tests all exercise the same transformations, and a
 * failed save can simply keep the old object because nothing was mutated in place.
 *
 * R0 IS THE POINT OF THIS FILE. An edit writes a bullet's `text` or the top-level
 * `summary` string and nothing else. `master_text` is the Auditor's and the diff's
 * ground truth (supabase/functions/_shared/audit/detector.ts:404); writing it would
 * make an operator's wording read back as traced-from-master. Every write below is a
 * spread of the existing node with exactly one field replaced, so there is no code
 * path here that names master_text, ref, identity, master_version or schema_version
 * on the left-hand side of anything.
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

/* The bullet node, derived from ResolvedResume rather than imported, because the
   contract seam re-exports only ResolvedResume and widening it is not this file's call. */
type ResolvedBullet = ResolvedResume['experience'][number]['bullets'][number];

/* Every section whose entries carry `bullets`. Listed once so locate, remove and
   reset cannot disagree about where a bullet may live. */
const BULLET_SECTIONS = ['experience', 'projects', 'education', 'achievements', 'certifications'] as const;
/* The section names as a type, so a typo in a section key fails typecheck. */
type BulletSection = (typeof BULLET_SECTIONS)[number];
/* The sections whose bullet TEXT an operator may change: exactly the ones the diff renders.
   MUST MATCH `bulletGroups` in diffAdapter.ts - the diff's editCount is what moves an edited
   row out of Bucket A (R2), so text changed anywhere the diff does not walk would be saved
   with editCount 0 and batch-approved unseen (D5a). Kept here rather than imported because
   bulletGroups is not exported; tailoredEdits.test.ts reads diffAdapter's source and fails if
   the two lists drift. Exported only so that test can compare against it. */
export const DIFF_BULLET_SECTIONS = ['experience', 'projects', 'education'] as const satisfies readonly BulletSection[];
/* The one thing all five entry shapes share, and the only thing this file touches. */
type BulletEntry = { readonly ref: string; readonly bullets: readonly ResolvedBullet[] };

/* The longest edit accepted. A bullet is a sentence or two; 2000 characters is far past
   any real one, so hitting it means a paste accident, not a resume line. */
const MAX_EDIT_LENGTH = 2000;

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

/* Stable key for one edit target, for React keys and per-line saving state. A bullet's
   ref is already unique across the resume; the summary has no ref, so it gets a fixed one. */
export function editKey(t: EditTarget): string {
  /* Two arms, both explicit, so a third arm added later fails to typecheck here. */
  return t.kind === 'bullet' ? t.ref : 'summary';
}

/* Replace one bullet's text, or the summary, with the operator's wording. */
export function applyTextEdit(current: ResolvedResume, target: EditTarget, text: string): EditOutcome {
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
  /* Index of that entry now; entries are never removed by this file, but verify rather than assume. */
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
  /* skillsLine maps names and the validator indexes ids, so each skill needs both as strings. */
  if (!isArrayOf(row['skills'], (s) => typeof s['id'] === 'string' && typeof s['name'] === 'string')) return null;
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

/* R0 AT THE WRITE BOUNDARY. True only if `next` differs from `previous` in bullet `text`,
 * the `summary` string, and bullets removed or re-inserted by this page - nothing else.
 *
 * The functions above keep R0 by construction (spread, replace one field). That holds
 * only for callers that use them. The save path calls this just before writing, so a
 * resume built any other way - a future caller, a bug, a hand-crafted object - is refused
 * before it can reach tailored_profile. Two independent controls, answering two different
 * questions: "did we build it right" and "is what we are about to write still R0-clean". */
export function onlyTextChanged(previous: ResolvedResume, next: ResolvedResume, original: ResolvedResume): boolean {
  /* Read as records so EVERY top-level key is checked, including ones added to the type later. */
  const prev = previous as unknown as Record<string, unknown>;
  /* Same view of the candidate. */
  const nxt = next as unknown as Record<string, unknown>;
  /* Keys this page may touch at the top level; every other key must be unchanged. */
  const free = new Set<string>(['summary', ...BULLET_SECTIONS]);
  /* Union of both key sets, so a key ADDED to next is checked as well as a changed one. */
  for (const key of new Set([...Object.keys(prev), ...Object.keys(nxt)])) {
    /* schema_version, master_version, identity, section_order, skills, and anything else. */
    if (!free.has(key) && !deepEqual(prev[key], nxt[key])) return false;
  }
  /* The summary is free text, but it must still BE text or null - not an object smuggled in. */
  if (next.summary !== null && typeof next.summary !== 'string') return false;

  /* The validator's bullets by ref, WITH their home: the only bullets this page can emit, and
     the only place each may sit. The parent is part of the claim - the same bullet under
     another employer is fabricated history (validator.ts indexBullets keeps parentRef for
     the same reason) - and the index is what pins relative order (D5b). */
  const originalBullets = new Map<string, { bullet: ResolvedBullet; section: BulletSection; parentRef: string; index: number }>();
  /* Each original entry's bullet count, keyed by section + entry ref, so a hidden section can
     be checked for a removal the diff would never show. */
  const originalCounts = new Map<string, number>();
  /* Every bullet-bearing section of the original. */
  for (const section of BULLET_SECTIONS) {
    /* Each entry's bullets go into the index. */
    for (const entry of entriesOf(original, section)) {
      /* Section-qualified, so an experience and a project sharing a ref cannot collide here. */
      originalCounts.set(section + '/' + entry.ref, entry.bullets.length);
      /* Refs are unique in a validated resume, so set never overwrites. */
      entry.bullets.forEach((bullet, index) => originalBullets.set(bullet.ref, { bullet, section, parentRef: entry.ref, index }));
    }
  }
  /* Refs already seen in next: a re-inserted bullet appearing twice is not a reset. */
  const seen = new Set<string>();

  /* Section by section: entries are fixed, only their bullets may differ. */
  for (const section of BULLET_SECTIONS) {
    /* Raw values, not entriesOf: an absent section must stay absent, not read as []. */
    const before = prev[section];
    /* The candidate's value for the same section. */
    const after = nxt[section];
    /* Neither side an array (e.g. a legacy row with no achievements): must be unchanged. */
    if (!Array.isArray(before) || !Array.isArray(after)) {
      /* deepEqual decides, so an array appearing or vanishing is a change. */
      if (!deepEqual(before, after)) return false;
      /* Nothing to walk. */
      continue;
    }
    /* Same entries in the same order: this page never adds, drops or reorders an entry. */
    if (before.length !== after.length) return false;
    /* Text is free only where the diff shows it; elsewhere a change would carry editCount 0
       into Bucket A (D5a). Widened to a plain string list so `includes` accepts any section. */
    const textFree = (DIFF_BULLET_SECTIONS as readonly string[]).includes(section);
    /* Pairwise by position, since the order is part of what must be unchanged. */
    for (let i = 0; i < after.length; i++) {
      /* Every entry field except `bullets` (company, role, dates, ref, links...) must match. */
      if (!deepEqual(withoutKey(before[i], 'bullets'), withoutKey(after[i], 'bullets'))) return false;
      /* This entry's ref - equal to before[i]'s by the line above - is the home every bullet
         under it must already have had in the original. */
      const parentRef = (after[i] as { ref?: unknown } | null)?.ref;
      /* The candidate entry's bullets, which must be an array to be walked at all. */
      const bullets = (after[i] as { bullets?: unknown } | null)?.bullets;
      /* A non-array here is a malformed entry, never a text edit. */
      if (!Array.isArray(bullets)) return false;
      /* A hidden section must keep every bullet: removeBullet can reach it, but no diff line
         would record the removal, so it would be as unreviewed as a hidden edit. */
      if (!textFree && bullets.length !== originalCounts.get(section + '/' + String(parentRef))) return false;
      /* The previous survivor's position in the original; strictly increasing means the
         survivors are the original's bullets, removed ones filtered out, in order (D5b). */
      let lastIndex = -1;
      /* Each bullet must be one of the validator's, with only its text free. */
      for (const bullet of bullets as unknown[]) {
        /* The bullet's ref, read defensively because `next` is untrusted at this boundary. */
        const ref = (bullet as { ref?: unknown } | null)?.ref;
        /* Where the tailor put it; undefined means the tailor never produced it. */
        const home = typeof ref === 'string' ? originalBullets.get(ref) : undefined;
        /* A ref the tailor never produced is an invented bullet. */
        if (home === undefined) return false;
        /* Twice on one resume is a duplicate, which the validator itself would refuse. */
        if (seen.has(home.bullet.ref)) return false;
        /* Remember it for the duplicate check. */
        seen.add(home.bullet.ref);
        /* Under a different entry (or section) is a relocated claim: real words, wrong employer. */
        if (home.section !== section || home.parentRef !== parentRef) return false;
        /* At or before the previous survivor's position is a reorder, not a removal. */
        if (home.index <= lastIndex) return false;
        /* Advance the floor for the next sibling. */
        lastIndex = home.index;
        /* Text is free but must be a string; master_text, ref and any other field must equal
           the validator's exactly - this is the line that makes R0 checkable. */
        if (typeof (bullet as { text?: unknown }).text !== 'string') return false;
        /* Shown sections: everything but `text` equals the original. Hidden sections: the
           whole bullet does, text included, because nobody reviewed a change there. */
        const same = textFree ? deepEqual(withoutKey(bullet, 'text'), withoutKey(home.bullet, 'text')) : deepEqual(bullet, home.bullet);
        /* Any other difference is outside R0. */
        if (!same) return false;
      }
    }
  }
  /* Nothing outside bullet text, summary and bullet membership changed. */
  return true;
}

/* --- internals -------------------------------------------------------------- */

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
