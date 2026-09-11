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

/* Appends the bullets of one parent. Shared by all FIVE bulleted sections -
 * experience, projects, education, and as of 2026-09-11 achievements and
 * certifications - rather than written five times, and that sharing is the
 * point: the tailor validator walks all of them into ONE index, so a checker
 * that walked them separately would be shaped like the document instead of like
 * the consumer - which is exactly how the per-section design gets written by
 * accident.
 *
 * It also makes adding a bulleted kind cheap enough that there is no excuse for
 * skipping it, which matters because a forgotten descent is SILENT: the new
 * kind's bullets simply stop participating in uniqueness and every existing
 * test stays green. */
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
 * pass against a profile this function cannot see.
 *
 * ADDING A NODE KIND TO `MasterProfile` AND NOT TO THIS WALK IS A SILENT HOLE,
 * NOT A FAILING TEST. Nothing in the type system connects a new field to this
 * function, so the omission compiles, the whole suite stays green, and global
 * uniqueness has quietly become uniqueness-over-the-kinds-someone-remembered.
 * Measured, not theorised: when `summary`, `achievements`, `certifications` and
 * `MasterProject.links` landed on 2026-09-11, the STORED fixture gained twelve
 * ids and this package's 81 tests all still passed - including the one that
 * asserts the exact occurrence count, because it was counting the walk's output
 * against a number written from the walk. So the count test below is only worth
 * anything when the number is re-derived from the FIXTURE by hand; see its note
 * in `node-id-uniqueness.test.ts`. */
export function collectNodeIds(profile: MasterProfile): readonly NodeIdOccurrence[] {
  const found: NodeIdOccurrence[] = [];

  /* Identity links first, matching the field order in `MasterProfile`. They are
     easy to forget precisely because they are nested one level deeper than
     every other id - and a link id colliding with a bullet id is exactly as
     ambiguous as any other collision. */
  profile.identity.links.forEach((link, index) => {
    found.push({ id: link.id, path: 'identity.links[' + String(index) + ']', kind: 'link' });
  });

  /* The summary, which is a SINGLE node rather than a section - one id, no
     index, so its path is the bare string 'summary' with no '[0]'. Walked here
     because `MasterSummary` stopped being a bare string on 2026-09-11 precisely
     so `TailoredSummary.refs` could point at it; an id that refs can name and
     this walk cannot see is a collision the reconciler would carry straight
     through its own postcondition.

     NULL IS THE COMMON CASE and it is SKIPPED, not pushed as an occurrence with
     an undefined id. A profile with no summary is normal, and a
     `{ id: undefined }` occurrence would make every summary-less profile
     collide with every other summary-less profile the moment a second one
     appeared in the same list - a duplicate reported for two nodes that do not
     exist. */
  if (profile.summary !== null) {
    found.push({ id: profile.summary.id, path: 'summary', kind: 'summary' });
  }

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
    /* Project links, which became a THIRD id-bearing link array on 2026-09-11
       when `MasterProject.url: string | null` was replaced by
       `links: DocumentOrdered<MasterLink>`. The replacement is exactly why this
       has to be walked: the old scalar carried no id, so there was nothing here
       to collide; the new one carries a `NodeId` drawn from the same global
       pool as everything else, and it is reconciled across re-uploads like an
       identity link.

       Nested two levels deep, which is the same reason `identity.links` is
       called out above as easy to forget - and the kind is 'link' rather than
       'project' because a review UI groups by kind, and a link filed under
       projects would be invisible in the link bucket a reviewer actually
       opens. */
    project.links.forEach((link, linkIndex) => {
      found.push({
        id: link.id,
        path: path + '.links[' + String(linkIndex) + ']',
        kind: 'link',
      });
    });
  });

  profile.education.forEach((education, index) => {
    const path = 'education[' + String(index) + ']';
    found.push({ id: education.id, path, kind: 'education' });
    pushBullets(found, education.bullets, path);
  });

  /* Achievements and certifications, added to the contract on 2026-09-11
     because the real resume had both and ingest was silently truncating them.
     Walked HERE, between education and the top-level links, so the walk follows
     the field order `MasterProfile` declares for them.

     TWO SEPARATE LOOPS OVER STRUCTURALLY IDENTICAL TYPES, on purpose. They are
     distinct interfaces with distinct match keys, and `kind` is what the review
     UI groups by - collapsing them into one loop would need a shared parameter
     for the kind and the path prefix, which is machinery that buys four saved
     lines and costs the ability to see at a glance that both are present.

     Both descend into bullets. That descent is the part a new kind gets wrong:
     the parent id is obvious because it is the thing being added, and the
     bullets under it are a second id-bearing place nobody remembers. */
  profile.achievements.forEach((achievement, index) => {
    const path = 'achievements[' + String(index) + ']';
    found.push({ id: achievement.id, path, kind: 'achievement' });
    pushBullets(found, achievement.bullets, path);
  });

  profile.certifications.forEach((certification, index) => {
    const path = 'certifications[' + String(index) + ']';
    found.push({ id: certification.id, path, kind: 'certification' });
    pushBullets(found, certification.bullets, path);
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
