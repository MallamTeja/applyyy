/* What makes a node "the same node" across two uploads.
 *
 * ONE MATCH KEY PER KIND, BECAUSE THE KINDS HAVE DIFFERENT STABILITY. A skill
 * name is atomic and never reworded, so it is a strong key. A bullet is prose
 * Teja rewrites, so it has no usable key at all and is matched by similarity
 * instead (see `assign.ts`). Using one scheme for everything would mean either
 * fuzzy-matching skills, where an exact key was available and free, or
 * exact-matching bullets, where every rewording would churn an id.
 *
 * EVERY KEY IS EXACT. Bullets are the ONLY fuzzy match in this package, and
 * that is a settled decision rather than a convenience: a fuzzy parent match
 * would let a whole employer drift onto the wrong previous entry, taking all of
 * its bullet ids with it.
 *
 * EVERY KEY HAS A TIEBREAK, and the tiebreak is not a nicety. A key that
 * matches two previous nodes carries nothing - the reconciler refuses to guess -
 * so an ambiguous key costs every id under it. The tiebreak is tried only when
 * the primary key is ambiguous, and that ordering is the point: it must not be
 * part of the primary key, because then editing the tiebreak field alone would
 * churn ids the primary key could have carried.
 *
 * SHAPES VERIFIED AGAINST THE REAL RESUME on 2026-09-10 rather than inferred
 * from the type contract. Each function below records what the document
 * actually contains, because one of these keys would otherwise have been wrong.
 */

import type {
  MasterAchievement,
  MasterCertification,
  MasterEducation,
  MasterExperience,
  MasterLink,
  MasterProject,
  MasterSkill,
} from '@applyy/shared-types';
import { normaliseKey } from './normalise.ts';

/* A two-level key. `primary` decides; `tiebreak` is consulted only when the
 * primary turns out to be ambiguous on either side. */
export interface MatchKey {
  readonly primary: string;
  readonly tiebreak: string;
}

/* Joins the parts of a composite key.
 *
 * NUL is used because it cannot survive `normaliseKey` - every fold there
 * either preserves printable characters or collapses whitespace, and NUL is
 * neither. A printable separator could appear inside a field and let two
 * different pairs produce one key: with a pipe separator, company "a|b" with
 * role "c" and company "a" with role "b|c" become indistinguishable. That is a
 * collision that silently carries an id onto the wrong employer. */
const KEY_SEPARATOR = '\u0000';

function composite(...parts: readonly string[]): string {
  return parts.join(KEY_SEPARATOR);
}

/* SKILLS - keyed on the normalised name ALONE, with category as the tiebreak.
 *
 * VERIFIED: the real resume groups skills under eight bolded categories, so
 * `MasterSkill.category` has a real source in the document and is not invented.
 *
 * WHY CATEGORY IS THE TIEBREAK AND NOT PART OF THE KEY. Both failure modes are
 * real, so this is a choice between them:
 *   - key on (name, category): re-filing "Docker" from "Tools" to
 *     "Cloud & DevOps" churns its id, and reorganising the skills block is
 *     something that happens every few uploads.
 *   - key on name alone: the same skill name appearing under two categories
 *     makes the key ambiguous, and then neither one carries.
 * The first fires on a routine edit; the second needs a duplicate that is a
 * mistake anyway. So name alone, with the category there to resolve the
 * duplicate case if it ever occurs. */
export function skillKey(skill: MasterSkill): MatchKey {
  return {
    /* `normaliseKey`, NOT the tokeniser: it preserves symbols, so C, C++ and C#
       stay three distinct keys instead of collapsing onto "c". */
    primary: normaliseKey(skill.name),
    tiebreak: composite(normaliseKey(skill.name), normaliseKey(skill.category)),
  };
}

/* EXPERIENCE - keyed on (company, role), tiebroken by the start date.
 *
 * VERIFIED: the real resume writes each entry as "Role - Company" followed by a
 * date range, so company and role ARE separate strings in the document and this
 * key has two real fields to read. The order is role-then-company, which
 * matters for the parser and not for the key.
 *
 * WHY THE START DATE IS THE TIEBREAK: two stints at one company in the same
 * role is the only way this key goes ambiguous, and when it does the dates are
 * exactly what a human uses to tell them apart. `start_display` rather than
 * `start_date`, because the ISO field is nullable in the contract and the
 * display string is not - a tiebreak that can be null is not a tiebreak. */
export function experienceKey(experience: MasterExperience): MatchKey {
  const base = composite(normaliseKey(experience.company), normaliseKey(experience.role));
  return { primary: base, tiebreak: composite(base, normaliseKey(experience.start_display)) };
}

/* EDUCATION - keyed on (institution, degree), tiebroken by the start date.
 *
 * VERIFIED: the real resume renders education as a three-column table with a
 * "Degree / Institute / Duration" header and three rows, so both fields exist.
 * One row's degree is "High School", which is a degree only by courtesy - it
 * still works as a key, because a key has to be stable rather than meaningful. */
export function educationKey(education: MasterEducation): MatchKey {
  const base = composite(normaliseKey(education.institution), normaliseKey(education.degree));
  return { primary: base, tiebreak: composite(base, normaliseKey(education.start_display)) };
}

/* Separates a project's NAME from its descriptive tagline.
 *
 * The space-hyphen-space form only. `normaliseKey` has already folded en and em
 * dashes to a plain hyphen, and requiring the surrounding spaces is what keeps
 * "one-on-one" and "end-to-end" intact. */
const TAGLINE_SEPARATOR = ' - ';

/* PROJECTS - keyed on the name UP TO the first tagline separator, tiebroken by
 * the full name. This is the key the original brief got wrong, and the
 * correction came out of the real document rather than out of reasoning.
 *
 * VERIFIED: one of the two real projects is titled "One-on-One - AI-Powered
 * Learning Platform" and the other is plain "F1 Race Pace Predictor". The first
 * is a NAME plus a REWORDABLE TAGLINE, and keying on the whole string makes
 * that tagline load-bearing.
 *
 * WHY THAT MATTERS MORE THAN IT LOOKS - this is the one cascade in the package.
 * Bullets are matched ONLY within an already-reconciled parent, so a project
 * whose key fails to match is treated as brand new and every bullet under it is
 * minted with no similarity search attempted at all. Rewording four words of a
 * subtitle would therefore churn one project id AND all four of its bullet ids,
 * on an upload where every claim was identical. One edit, five broken
 * references, nothing reported anywhere.
 *
 * Truncating at the separator is a change of KEY DERIVATION, not a move to
 * fuzzy matching: the comparison stays exact and deterministic, and it simply
 * stops reading the half of the string that is a description rather than an
 * identity. Two projects sharing a head ("Portfolio - v1", "Portfolio - v2")
 * make the primary key ambiguous and the full name resolves them, which is the
 * same shape as every other key in this file. */
export function projectKey(project: MasterProject): MatchKey {
  const full = normaliseKey(project.name);
  const separatorAt = full.indexOf(TAGLINE_SEPARATOR);
  /* No separator means the whole name IS the identity, which is the plain case
     and must not be truncated to nothing. */
  const head = separatorAt === -1 ? full : full.slice(0, separatorAt);
  return { primary: head, tiebreak: full };
}

/* LINKS - keyed on the normalised URL, tiebroken by (url, label).
 *
 * Links carry ids in the same global space as everything else, so they need
 * reconciling too; otherwise every re-upload mints a fresh id for a GitHub
 * profile that has not changed since the first upload.
 *
 * URL rather than label, because the label is the reworded half: one address
 * gets called "GitHub", "Github" or "Code" across drafts, while the address
 * itself is the part that is actually stable. */
export function linkKey(link: MasterLink): MatchKey {
  const url = normaliseKey(link.url);
  return { primary: url, tiebreak: composite(url, normaliseKey(link.label)) };
}

/* ACHIEVEMENTS - keyed on the normalised LABEL alone, tiebroken by
 * (label, description).
 *
 * VERIFIED: the real resume writes achievements as undated lines of the form
 * "Winner - Smart India Hackathon 2025", optionally followed by a qualifying
 * detail ("national finals, 312 teams"). The parser splits those two halves into
 * `label` and `description`, and `description` is null on the lines where the
 * label already says everything - which is most of them.
 *
 * WHY THE LABEL ALONE IS THE PRIMARY KEY. Same reasoning as `linkKey`, where the
 * URL is the stable half and the human-facing label is the reworded one: here it
 * is the label that names the thing and the description that gets rephrased
 * between drafts ("national finals, 312 teams" -> "312 teams, national finals").
 * Keying on the pair makes that rephrasing load-bearing, and an achievement is a
 * BULLETED PARENT - bullets only match inside an already-reconciled parent - so a
 * failed parent key mints the achievement id AND every bullet id under it with no
 * similarity search attempted at all. Reordering four words of a subtitle would
 * break every pinned reference beneath it, on an upload where the achievement
 * itself was untouched. That is the exact cascade `projectKey` was corrected for.
 *
 * WHY NOT THE DESCRIPTION AS THE PRIMARY, the alternative worth naming: it is
 * null on most lines, so every description-less achievement would normalise to
 * the SAME empty key, the key would be ambiguous across all of them at once, and
 * nothing in the section would carry anything. A key that collapses the common
 * case is worse than no key.
 *
 * The tiebreak then handles the only way the label alone goes ambiguous - two
 * achievements genuinely sharing a label, separated by their detail lines. */
export function achievementKey(achievement: MasterAchievement): MatchKey {
  const label = normaliseKey(achievement.label);
  /* `?? ''` rather than skipping the tiebreak: `composite` needs a string, and a
     null description is a real distinguishing value - "label with no detail" and
     "label with a detail" are two different nodes, which is exactly what the
     tiebreak is being asked to separate. */
  return { primary: label, tiebreak: composite(label, normaliseKey(achievement.description ?? '')) };
}

/* CERTIFICATIONS - the same key, and written out separately rather than aliased.
 *
 * VERIFIED: four entries in the real resume, each written "Name - Issuer", so the
 * halves land in `label` and `description` exactly as they do for an achievement.
 * The issuer is the half that gets rewritten across drafts ("Amazon Web Services"
 * / "AWS" / "AWS Training"), so the same argument applies unchanged: label
 * primary, (label, description) as the tiebreak.
 *
 * NOT `achievementKey` UNDER A SECOND NAME, and not a shared generic over the
 * structural shape. `MasterAchievement` and `MasterCertification` are separate
 * interfaces on purpose - `profile-nodes.ts` says a future divergence should be an
 * added field rather than a breaking rename - and a shared key function would make
 * that divergence a change to BOTH sections, which is the moment somebody writes a
 * cast and a certification starts matching against an achievement pool. Two
 * functions cost a duplicated body once; sharing costs a wrong match forever. */
export function certificationKey(certification: MasterCertification): MatchKey {
  const label = normaliseKey(certification.label);
  return {
    primary: label,
    tiebreak: composite(label, normaliseKey(certification.description ?? '')),
  };
}
