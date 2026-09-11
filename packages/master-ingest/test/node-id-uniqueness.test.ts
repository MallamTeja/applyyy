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
  achievement,
  bullet,
  certification,
  education,
  experience,
  link,
  profileOf,
  project,
  skill,
  summary,
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

/* THE NODE KINDS ADDED ON 2026-09-11, WHICH ARE WHERE THE PER-SECTION BUG GETS
 * REINTRODUCED WITHOUT ANYONE DECIDING TO REINTRODUCE IT.
 *
 * Nothing in the type system connects a new field on `MasterProfile` to
 * `collectNodeIds`, so a kind left out of the walk compiles, and the collisions
 * involving it silently stop being detectable while the suite stays green.
 * Measured on this very package: when `summary`, `achievements`,
 * `certifications` and `MasterProject.links` landed, the STORED fixture gained
 * twelve ids and all 81 tests still passed - the count assertion below included,
 * because it was comparing the walk against a number copied from the walk.
 *
 * Every test here is therefore a CROSS-KIND collision: a new kind against an old
 * one. A duplicate WITHIN achievements would pass under a per-section checker
 * exactly as it did for experience, so it would prove the walk descends and
 * nothing about whether the id space is global. */
describe('the new node kinds, which are a fresh chance to get it wrong', () => {
  /* The single most discriminating test in the file. A per-section checker with
     an `achievements` section added would report nothing here, because each id
     is used once within its own section. */
  it('detects an achievement id colliding with an experience id', () => {
    const profile = profileOf({
      experience: [experience('collide', 'Northwind Systems', 'Engineer', [])],
      achievements: [achievement('collide', 'Winner - Smart India Hackathon 2025')],
    });
    const duplicates = findDuplicateNodeIds(profile);
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0]?.id, 'collide');
    /* Both ends, in walk order - experience is walked before achievements. A
       length assertion alone would pass against a walk that found the id twice
       in the same place. */
    assert.deepEqual(duplicates[0]?.paths, ['experience[0]', 'achievements[0]']);
  });

  /* Pushing the achievement's own id is the obvious half. DESCENDING INTO ITS
     BULLETS is the half that gets forgotten, and forgetting it is worse: a
     bullet ref is the thing `TailoredBullet` resolves, so an unwalked bullet id
     is exactly the collision that makes the misattribution check compare
     against the wrong stored parent. */
  it('detects an achievement bullet colliding with an experience bullet', () => {
    const profile = profileOf({
      experience: [
        experience('exp-1', 'Northwind Systems', 'Engineer', [bullet('collide', 'Shipped it.')]),
      ],
      achievements: [
        achievement('ach-1', 'Winner - Smart India Hackathon 2025', null, [
          bullet('collide', 'Led a team of six.'),
        ]),
      ],
    });
    assert.deepEqual(findDuplicateNodeIds(profile)[0]?.paths, [
      'experience[0].bullets[0]',
      'achievements[0].bullets[0]',
    ]);
  });

  /* Certifications are a SEPARATE walk segment from achievements even though the
     two types are structurally identical, so they need their own killer. A walk
     that added achievements and stopped would pass every test above and leave
     this one red. */
  it('detects a certification id colliding with an education id', () => {
    const profile = profileOf({
      education: [education('collide', 'Placeholder Institute', 'B.Tech')],
      certifications: [
        certification('collide', 'AWS Certified Cloud Practitioner', 'Amazon Web Services'),
      ],
    });
    assert.deepEqual(findDuplicateNodeIds(profile)[0]?.paths, ['education[0]', 'certifications[0]']);
  });

  /* A certification bullet against a SKILL - the second of the two collisions
     the per-section checker historically missed, re-run against the newest kind.
     Different kinds entirely, so a checker organised by kind sees nothing. */
  it('detects a certification bullet colliding with a skill id', () => {
    const profile = profileOf({
      skills: [skill('collide', 'Docker', 'Tools')],
      certifications: [
        certification('cert-aws', 'AWS Certified Cloud Practitioner', null, [
          bullet('collide', 'Renewed in 2026.'),
        ]),
      ],
    });
    assert.deepEqual(findDuplicateNodeIds(profile)[0]?.paths, [
      'skills[0]',
      'certifications[0].bullets[0]',
    ]);
  });

  /* `MasterProject.links` replaced `url: string | null` on 2026-09-11, and the
     replacement is what created this case: the old scalar carried no id, so
     there was nothing to collide. The new one carries a `NodeId` from the same
     global pool, nested TWO levels deep - the same depth that makes
     `identity.links` the easiest array in the profile to forget. */
  it('detects a project link colliding with an identity link', () => {
    const profile = profileOf({
      identityLinks: [link('collide', 'GitHub', 'https://github.com/example')],
      projects: [
        project('prj-1', 'Analyzer', [], [
          link('collide', 'Source', 'https://github.com/example/analyzer'),
        ]),
      ],
    });
    assert.deepEqual(findDuplicateNodeIds(profile)[0]?.paths, [
      'identity.links[0]',
      'projects[0].links[0]',
    ]);
  });

  /* Pins the NESTED INDEX rather than just the nesting. A walk that emitted a
     hardcoded `.links[0]` would satisfy the test above and fail here, and the
     two-link project is the exact shape that motivated replacing the scalar
     `url` - a live deployment and a source repository on one project. */
  it('reports the second project link at links[1], not links[0]', () => {
    const profile = profileOf({
      projects: [
        project('prj-1', 'Analyzer', [], [
          link('lnk-live', 'Live', 'https://analyzer.example.invalid'),
          link('collide', 'Source', 'https://github.com/example/analyzer'),
        ]),
      ],
      links: [link('collide', 'Portfolio', 'https://example.invalid')],
    });
    assert.deepEqual(findDuplicateNodeIds(profile)[0]?.paths, [
      'projects[0].links[1]',
      'links[0]',
    ]);
  });

  /* The summary is a SINGLE node, so its path is the bare string 'summary' with
     no index - a walk that reached for `summary[0]` would be wrong in a way no
     other section can be. It became a node at all so `TailoredSummary.refs`
     could name it; an id that refs can resolve and this walk cannot see is a
     collision the reconciler carries straight through its own postcondition. */
  it('detects the summary id colliding with a skill id', () => {
    const profile = profileOf({
      summary: summary('collide', 'Full stack engineer shipping AI products end to end.'),
      skills: [skill('collide', 'Python', 'Programming')],
    });
    const duplicates = findDuplicateNodeIds(profile);
    assert.equal(duplicates.length, 1);
    assert.deepEqual(duplicates[0]?.paths, ['summary', 'skills[0]']);
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

  /* ONE TWIN PER NEW WALK SEGMENT, each the near-miss version of a rejection
     test above: the same profile shape, with the colliding id changed. Without
     them every assertion above is satisfied by a function that reports every id
     as a duplicate.

     The twins assert ONLY acceptance - they deliberately do not also assert that
     the new path is present. That positive check belongs to the count test
     below, and putting it here too would make the twins go red under the same
     mutations as the rejection tests, turning a sharp kill signal into a blunt
     one. */
  it('accepts an achievement and an experience whose ids merely resemble each other', () => {
    const profile = profileOf({
      experience: [
        experience('node-1', 'Northwind Systems', 'Engineer', [bullet('node-2', 'Shipped it.')]),
      ],
      achievements: [
        achievement('node-3', 'Winner - Smart India Hackathon 2025', null, [
          bullet('node-4', 'Led a team of six.'),
        ]),
      ],
    });
    assert.deepEqual(findDuplicateNodeIds(profile), []);
  });

  it('accepts a certification whose bullets are distinct from every skill', () => {
    const profile = profileOf({
      skills: [skill('node-1', 'Docker', 'Tools')],
      education: [education('node-2', 'Placeholder Institute', 'B.Tech')],
      certifications: [
        certification('node-3', 'AWS Certified Cloud Practitioner', 'Amazon Web Services', [
          bullet('node-4', 'Renewed in 2026.'),
        ]),
      ],
    });
    assert.deepEqual(findDuplicateNodeIds(profile), []);
  });

  /* The TWO-LINK project accepted. This is the shape the contract change exists
     for, so a guard that rejected it would have made the fix unusable - and a
     walk that pushed both links under one hardcoded path would report a
     duplicate here for two genuinely distinct nodes. */
  it('accepts a project carrying both a live link and a source link', () => {
    const profile = profileOf({
      identityLinks: [link('node-1', 'GitHub', 'https://github.com/example')],
      projects: [
        project('node-2', 'Analyzer', [], [
          link('node-3', 'Live', 'https://analyzer.example.invalid'),
          link('node-4', 'Source', 'https://github.com/example/analyzer'),
        ]),
      ],
      links: [link('node-5', 'Portfolio', 'https://example.invalid')],
    });
    assert.deepEqual(findDuplicateNodeIds(profile), []);
  });

  it('accepts a summary whose id is distinct from every other node', () => {
    const profile = profileOf({
      summary: summary('node-1', 'Full stack engineer shipping AI products end to end.'),
      skills: [skill('node-2', 'Python', 'Programming')],
    });
    assert.deepEqual(findDuplicateNodeIds(profile), []);
  });

  /* NULL IS THE NORMAL CASE, and it must be SKIPPED rather than pushed as an
     occurrence with an undefined id. Two summary-less profiles would otherwise
     be fine individually and a single profile would report a phantom duplicate
     the moment any other unwalked field did the same - so the emptiness of the
     'summary' path is asserted directly, not inferred from the absence of a
     crash. */
  it('emits no summary occurrence at all when the summary is null', () => {
    const profile = profileOf({
      summary: null,
      skills: [skill('node-1', 'Python', 'Programming')],
    });
    const paths = collectNodeIds(profile).map((occurrence) => occurrence.path);
    assert.deepEqual(paths, ['skills[0]']);
    assert.deepEqual(findDuplicateNodeIds(profile), []);
  });

  it('walks every id-bearing array in the contract', () => {
    /* The count is asserted so a section quietly dropped from the walk fails
       here rather than silently making collisions in it undetectable - which is
       precisely how the per-section bug would be reintroduced.

       THIS NUMBER IS ONLY WORTH ANYTHING WHEN IT IS RE-DERIVED FROM THE FIXTURE
       BY HAND. Reading it off a run of `collectNodeIds` makes the assertion
       compare the walk against itself, which is how 20 survived the 2026-09-11
       contract change green while twelve ids in STORED had gone invisible. The
       hand count, section by section down `fixtures/profiles.ts`:

         identity.links   1   lnk-github
         summary          1   sum-headline
         skills           5   python, sql, c, cpp, docker
         experience       6   2 parents + 3 bullets + 1 bullet
         projects         8   2 parents + 3 bullets + 2 links + 1 default link
         education        2   2 parents, no bullets
         achievements     4   3 parents + 1 bullet
         certifications   4   4 parents, no bullets
         links            1   lnk-site
                         --
                         32 */
    const paths = collectNodeIds(STORED).map((occurrence) => occurrence.path);
    assert.equal(paths.length, 32);
    /* One representative from each of the NINE id-bearing places, including the
       four added on 2026-09-11 - the nested ones especially, since a walk can
       push a parent and still never descend. */
    for (const expected of [
      'identity.links[0]',
      'summary',
      'skills[0]',
      'experience[0]',
      'experience[0].bullets[0]',
      'projects[0].bullets[0]',
      'projects[0].links[0]',
      'education[0]',
      'achievements[0]',
      'achievements[0].bullets[0]',
      'certifications[0]',
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
    /* `b-live` IS NOT A TYPO AND IT WAS NOT PLANTED. It is a CASCADE, and it is
       the best evidence in this file that the project-link walk is real: the
       fixture's `project` builder derives its default link id from the project
       id, so reusing `b` for two projects duplicates `b-live` as well. This
       expectation read ['a', 'b', 'c'] and passed green until the walk learned
       to descend into `projects[i].links[j]` on 2026-09-11 - the fourth
       duplicate was sitting in this very test, undetected, the whole time.

       Kept rather than neutralised by handing the two projects explicit links.
       A reused parent id duplicating things NESTED UNDER it is exactly what a
       "report them all at once" test should be demonstrating, and it teaches
       something the planted duplicates do not. The cost is a coupling to that
       builder default, which is why it is spelled out here. */
    assert.deepEqual(
      findDuplicateNodeIds(profile)
        .map((duplicate) => duplicate.id)
        .sort(),
      ['a', 'b', 'b-live', 'c'],
    );
  });
});
