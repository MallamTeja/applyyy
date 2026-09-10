/* Every NodeId in a MasterProfile, in ONE flat list, and the duplicates in it.
 *
 * GLOBAL, NOT PER-SECTION. `profile-nodes.ts` settled this on 2026-09-10 and
 * the reasoning is worth repeating here rather than referenced, because this is
 * the file where getting it wrong is invisible: `TailoredBullet` is
 * `{ ref, text }` and `TailoredSkill` is `{ ref }` - a bare id with no section
 * qualifier and no kind tag. Resolution therefore has nothing to go on but the
 * id itself, so under per-section uniqueness a bullet ref could resolve to a
 * skill, or to a bullet under a different parent, and nothing in the type
 * system lets a consumer disambiguate.
 *
 * WHY THIS FILE EXISTS IN THIS PACKAGE AT ALL, given that the reconciler cannot
 * produce a duplicate by construction - previous ids come from disjoint
 * per-kind pools and each is carried at most once. Two answers, and the second
 * is the real one:
 *
 *   1. `mintId` is INJECTED. A caller that hands in a counter it also uses
 *      elsewhere, or a stub that returns a constant, breaks the one assumption
 *      the construction rests on. The reconciler cannot verify a function; it
 *      can verify the profile that came out.
 *   2. THE PER-SECTION CHECKER IS THE PLAUSIBLE WRONG DESIGN, and it is the
 *      more natural-reading one. It passed 34 of 36 tests written against the
 *      ingest path: the only two it failed were a cross-section collision and a
 *      bullet id colliding with a SKILL id. The within-section duplicate - the
 *      case anyone writes first - passed under BOTH designs. So a fresh
 *      implementation of this check is a fresh chance to reintroduce the wrong
 *      one, and it would look correct and test green.
 *
 * The consequence of the wrong design is silent, which is why it is enforced
 * rather than documented: the tailor validator indexes master bullets into one
 * flat Map keyed by id, a Map overwrites on duplicate key, and the
 * `misattributed_bullet` check then compares a tailored bullet against the
 * WRONG stored parent. A genuine misattribution passes as clean, the Auditor
 * reports clean, and the honesty guarantee has stopped holding with nothing
 * anywhere reporting a problem.
 *
 * NOTE: `apps/web/src/features/settings/masterIngest.ts` already implements
 * this rule correctly, for PASTED JSON before it is stored. This is a second
 * implementation for a different input - a reconciler OUTPUT - and the
 * duplication is worth flagging rather than hiding. See the package README.
 */

import type { MasterBullet, MasterProfile, NodeId } from '@applyy/shared-types';
import type { ReconciledKind } from './report.ts';

/* One id and where it was found. The path uses the same dotted convention as
 * the ingest validator, so an operator can search the identical string in the
 * JSON regardless of which tool complained. */
export interface NodeIdOccurrence {
  readonly id: NodeId;
  readonly path: string;
  readonly kind: ReconciledKind;
}

/* One id claimed more than once, with every place it was claimed. All paths,
 * not just the second one: fixing a duplicate needs to see both ends. */
export interface DuplicateNodeId {
  readonly id: NodeId;
  readonly paths: readonly string[];
}

/* Appends the bullets of one parent. Shared by all three bulleted sections
 * rather than written three times, and that sharing is the point: the tailor
 * validator walks all three into ONE index, so a checker that walked them
 * separately would be shaped like the document instead of like the consumer -
 * which is exactly how the per-section design gets written by accident. */
function pushBullets(
  into: NodeIdOccurrence[],
  bullets: readonly MasterBullet[],
  parentPath: string,
): void {
  bullets.forEach((bullet, index) => {
    into.push({
      id: bullet.id,
      path: parentPath + '.bullets[' + String(index) + ']',
      kind: 'bullet',
    });
  });
}

/* Every id in the profile, in document order.
 *
 * Exported separately from the duplicate check because a caller may want the
 * inventory itself - the reconciler's own tests assert on the total count, and
 * counting occurrences here rather than in the test keeps the walk in one
 * place. A test with its own second walk would drift from this one and then
 * pass against a profile this function cannot see. */
export function collectNodeIds(profile: MasterProfile): readonly NodeIdOccurrence[] {
  const found: NodeIdOccurrence[] = [];

  /* Identity links first, matching the field order in `MasterProfile`. They are
     easy to forget precisely because they are nested one level deeper than
     every other id - and a link id colliding with a bullet id is exactly as
     ambiguous as any other collision. */
  profile.identity.links.forEach((link, index) => {
    found.push({ id: link.id, path: 'identity.links[' + String(index) + ']', kind: 'link' });
  });

  /* Skills. The kind whose collision with a BULLET id was one of the two cases
     the per-section checker missed. */
  profile.skills.forEach((skill, index) => {
    found.push({ id: skill.id, path: 'skills[' + String(index) + ']', kind: 'skill' });
  });

  profile.experience.forEach((experience, index) => {
    const path = 'experience[' + String(index) + ']';
    found.push({ id: experience.id, path, kind: 'experience' });
    pushBullets(found, experience.bullets, path);
  });

  profile.projects.forEach((project, index) => {
    const path = 'projects[' + String(index) + ']';
    found.push({ id: project.id, path, kind: 'project' });
    pushBullets(found, project.bullets, path);
  });

  profile.education.forEach((education, index) => {
    const path = 'education[' + String(index) + ']';
    found.push({ id: education.id, path, kind: 'education' });
    pushBullets(found, education.bullets, path);
  });

  /* Top-level links, which are a DIFFERENT array from `identity.links` in the
     contract. Both exist and both carry ids, so omitting either leaves a real
     collision undetectable. */
  profile.links.forEach((link, index) => {
    found.push({ id: link.id, path: 'links[' + String(index) + ']', kind: 'link' });
  });

  return found;
}

/* Ids claimed more than once anywhere in the profile.
 *
 * Returns a list rather than a boolean so a failure names the collision. "Not
 * unique" is unactionable on a profile with two hundred ids. */
export function findDuplicateNodeIds(profile: MasterProfile): readonly DuplicateNodeId[] {
  /* id -> every path claiming it. Built for ALL ids rather than short-circuiting
     on the first duplicate, because a parser bug produces many at once and
     reporting one at a time turns a single fix into six round trips. */
  const pathsById = new Map<NodeId, string[]>();
  for (const occurrence of collectNodeIds(profile)) {
    const existing = pathsById.get(occurrence.id);
    if (existing === undefined) {
      pathsById.set(occurrence.id, [occurrence.path]);
    } else {
      existing.push(occurrence.path);
    }
  }

  const duplicates: DuplicateNodeId[] = [];
  for (const [id, paths] of pathsById) {
    if (paths.length > 1) {
      duplicates.push({ id, paths });
    }
  }
  return duplicates;
}
