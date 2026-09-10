/* The global NodeId invariant, and the two cases that separate the right design
 * from the plausible wrong one.
 *
 * THE MEASUREMENT THIS SUITE IS BUILT AROUND. A per-section uniqueness checker
 * - the more natural-reading design - passed 34 of 36 tests written against the
 * ingest path. The only two it failed were a CROSS-SECTION collision and a
 * bullet id colliding with a SKILL id. The within-section duplicate, which is
 * the case anyone writes first, passed under BOTH designs.
 *
 * So a suite that tests the obvious case proves nothing about which design is
 * implemented, and the wrong design leaves the audit corruptible: the tailor
 * validator indexes all master bullets into one flat Map, a Map overwrites on
 * duplicate key, and the misattribution check then compares against the wrong
 * stored parent. The tests below are ordered worst-discriminator last, so it is
 * obvious which ones are doing the work.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { collectNodeIds, findDuplicateNodeIds } from '../src/index.ts';
import {
  bullet,
  education,
  experience,
  link,
  profileOf,
  project,
  skill,
  STORED,
} from './fixtures/profiles.ts';

describe('the two cases a per-section checker misses', () => {
  /* CASE 1 - one id used by a bullet under an experience AND a bullet under a
     project. Both are "unique within their section". */
  it('detects a bullet id colliding across two different sections', () => {
    const profile = profileOf({
      experience: [
        experience('exp-1', 'Northwind Systems', 'Engineer', [bullet('collide', 'Shipped it.')]),
      ],
      projects: [project('prj-1', 'Analyzer', [bullet('collide', 'Analysed it.')])],
    });
    const duplicates = findDuplicateNodeIds(profile);
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0]?.id, 'collide');
    /* Both paths, because fixing a duplicate needs to see both ends. */
    assert.deepEqual(duplicates[0]?.paths, [
      'experience[0].bullets[0]',
      'projects[0].bullets[0]',
    ]);
  });

  /* CASE 2 - a BULLET id colliding with a SKILL id. Different kinds entirely,
     so a checker organised by kind sees nothing at all. This is the collision
     that lets a bullet ref resolve to a skill, since `TailoredBullet.ref` is a
     bare id with no kind tag. */
  it('detects a bullet id colliding with a skill id', () => {
    const profile = profileOf({
      skills: [skill('collide', 'Python', 'Programming')],
      experience: [
        experience('exp-1', 'Northwind Systems', 'Engineer', [bullet('collide', 'Shipped it.')]),
      ],
    });
    const duplicates = findDuplicateNodeIds(profile);
    assert.equal(duplicates.length, 1);
    assert.deepEqual(duplicates[0]?.paths, ['skills[0]', 'experience[0].bullets[0]']);
  });

  /* CASE 3 - identity.links against top-level links. Two DIFFERENT arrays in
     the contract, one level apart in nesting, and the easiest pair in the whole
     profile to forget to walk. */
  it('detects a collision between an identity link and a top-level link', () => {
    const profile = profileOf({
      identityLinks: [link('collide', 'GitHub', 'https://github.com/example')],
      links: [link('collide', 'Portfolio', 'https://example.invalid')],
    });
    assert.deepEqual(findDuplicateNodeIds(profile)[0]?.paths, [
      'identity.links[0]',
      'links[0]',
    ]);
  });

  it('detects a parent id colliding with a parent id in another section', () => {
    const profile = profileOf({
      experience: [experience('collide', 'Northwind Systems', 'Engineer', [])],
      education: [education('collide', 'Placeholder Institute', 'B.Tech')],
    });
    assert.deepEqual(findDuplicateNodeIds(profile)[0]?.paths, ['experience[0]', 'education[0]']);
  });
});

describe('the case both designs catch', () => {
  /* Listed explicitly as the WEAK test. It is the one anyone writes first, it
     passes under the wrong design too, and on its own it is not evidence that
     the checker is global. */
  it('detects two bullets under the same parent sharing an id', () => {
    const profile = profileOf({
      experience: [
        experience('exp-1', 'Northwind Systems', 'Engineer', [
          bullet('collide', 'Shipped it.'),
          bullet('collide', 'Shipped it again.'),
        ]),
      ],
    });
    assert.equal(findDuplicateNodeIds(profile).length, 1);
  });
});

describe('the non-vacuity twin', () => {
  /* Without this, every assertion above is satisfied by a function that reports
     every id as a duplicate. */
  it('reports no duplicates for a profile whose ids are all distinct', () => {
    assert.deepEqual(findDuplicateNodeIds(STORED), []);
  });

  it('walks every id-bearing array in the contract', () => {
    /* The count is asserted so a section quietly dropped from the walk fails
       here rather than silently making collisions in it undetectable - which is
       precisely how the per-section bug would be reintroduced. */
    const paths = collectNodeIds(STORED).map((occurrence) => occurrence.path);
    assert.equal(paths.length, 20);
    /* One representative from each of the six id-bearing places. */
    for (const expected of [
      'identity.links[0]',
      'skills[0]',
      'experience[0]',
      'experience[0].bullets[0]',
      'projects[0].bullets[0]',
      'education[0]',
      'links[0]',
    ]) {
      assert.ok(paths.includes(expected), 'missing ' + expected);
    }
  });

  it('reports every collision at once rather than stopping at the first', () => {
    /* A parser bug produces many duplicates simultaneously, and reporting one
       at a time turns a single fix into six round trips. */
    const profile = profileOf({
      skills: [skill('a', 'Python', 'Programming'), skill('a', 'SQL', 'Programming')],
      projects: [
        project('b', 'Analyzer', [bullet('c', 'One.'), bullet('c', 'Two.')]),
        project('b', 'Explorer', []),
      ],
    });
    assert.deepEqual(
      findDuplicateNodeIds(profile)
        .map((duplicate) => duplicate.id)
        .sort(),
      ['a', 'b', 'c'],
    );
  });
});
