/* The reconciler's guards, each paired with an input it must ACCEPT.
 *
 * WHY EVERY GUARD HERE HAS A TWIN. A rejection-only test cannot distinguish a
 * correct guard from one that rejects everything - a reconciler that minted a
 * fresh id for every node would pass every "this must not carry" assertion in
 * this file. So each refusal is paired with the nearest input that must carry,
 * differing in as few dimensions as possible. This is instance 13 of the repo's
 * verification-traps document, which is the entry that closes the hole every
 * mutation measurement leaves open.
 *
 * WHY THE ASSERTIONS ARE ID-PER-PATH RATHER THAN COUNTS. "Zero minted" is
 * satisfied by an implementation that carries all the right ids onto all the
 * WRONG nodes. The order-insensitive assertion is the one that survives
 * mutation while proving nothing - the single most repeated finding in this
 * repo's three mutation measurements - so the checks below compare the exact id
 * at the exact path.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { MasterProfile } from '@applyy/shared-types';
import {
  collectNodeIds,
  findDuplicateNodeIds,
  needsHumanReview,
  nonExactCarries,
  ReconciliationError,
  reconcileMasterProfile,
} from '../src/index.ts';
import {
  achievement,
  bullet,
  certification,
  experience,
  link,
  makeMinter,
  profileOf,
  project,
  reparse,
  skill,
  STORED,
  summary,
} from './fixtures/profiles.ts';

/* Every id in a profile, keyed by the path it sits at. The comparison unit for
 * "the same id landed on the same node", which is the actual claim. */
function idsByPath(profile: MasterProfile): Record<string, string> {
  const map: Record<string, string> = {};
  for (const occurrence of collectNodeIds(profile)) {
    map[occurrence.path] = occurrence.id;
  }
  return map;
}

/* Finds the output bullet at a known position. Returns undefined rather than
   throwing so a test asserts on the value and reports a useful message. */
function bulletIdAt(
  profile: MasterProfile,
  /* All FIVE bulleted sections, not the original three. Achievements and
     certifications became bulleted parents on 2026-09-11, and a helper that
     could not reach their bullets would have quietly pushed their tests towards
     weaker assertions than the sections it did cover. */
  section: 'experience' | 'projects' | 'education' | 'achievements' | 'certifications',
  parentIndex: number,
  bulletIndex: number,
): string | undefined {
  return profile[section][parentIndex]?.bullets[bulletIndex]?.id;
}

/* The id of one link inside one project. Project links are nested two levels
 * deep, which is exactly why they are easy to leave unreconciled - nothing at
 * the top level of the profile changes shape when they churn. */
function projectLinkIdAt(
  profile: MasterProfile,
  projectIndex: number,
  linkIndex: number,
): string | undefined {
  return profile.projects[projectIndex]?.links[linkIndex]?.id;
}

describe('byte-identical re-upload', () => {
  /* TWIN A - the acceptance case. The most important single guarantee: a
     re-upload that changed nothing must change nothing. */
  it('carries every id and mints none', () => {
    const result = reconcileMasterProfile({
      previous: STORED,
      /* A fresh parse with throwaway ids, NOT the stored profile passed back
         in. Feeding STORED as incoming would pass with the reconciler deleted. */
      incoming: reparse(STORED),
      mintId: makeMinter('new'),
    });

    assert.deepEqual(result.report.minted, [], 'nothing may be minted');
    assert.deepEqual(result.report.dropped, [], 'nothing may be dropped');
    assert.deepEqual(result.report.ambiguous, [], 'nothing may be ambiguous');
    /* The strong assertion: same id at same path, for all 20 nodes. */
    assert.deepEqual(idsByPath(result.profile), idsByPath(STORED));
    /* And nothing needed a human, because every match was exact. */
    assert.equal(needsHumanReview(result.report), false);
  });

  it('matches every node by an exact key or exact text, never by score', () => {
    const result = reconcileMasterProfile({
      previous: STORED,
      incoming: reparse(STORED),
      mintId: makeMinter('new'),
    });
    /* Specificity: an implementation that fuzzy-matched everything would also
       carry every id here, and the previous test would not notice. */
    assert.deepEqual(nonExactCarries(result.report), []);
    assert.equal(result.report.carried.length, collectNodeIds(STORED).length);
  });
});

describe('one reworded bullet', () => {
  /* The case actually produced in Overleaf, and the case where a wrong answer
     is invisible. Only the second Northwind bullet changes wording. */
  const incoming = reparse({
    ...STORED,
    experience: STORED.experience.map((exp, index) =>
      index !== 0
        ? exp
        : {
            ...exp,
            bullets: exp.bullets.map((b) =>
              b.id !== 'b-nw-2'
                ? b
                : { ...b, text: 'Reduced p95 latency by 40% using a read-through cache.' },
            ),
          },
    ),
  });

  it('carries that bullet id rather than minting a new one', () => {
    const result = reconcileMasterProfile({
      previous: STORED,
      incoming,
      mintId: makeMinter('new'),
    });
    assert.equal(bulletIdAt(result.profile, 'experience', 0, 1), 'b-nw-2');
    assert.deepEqual(result.report.minted, [], 'a rewording is not new content');
    assert.deepEqual(result.report.dropped, []);
  });

  it('reports it as a fuzzy carry so a human sees it, and reports nothing else as fuzzy', () => {
    const result = reconcileMasterProfile({
      previous: STORED,
      incoming,
      mintId: makeMinter('new'),
    });
    const fuzzy = nonExactCarries(result.report);
    /* Exactly one, not "at least one": every other bullet was untouched, so an
       implementation that scored everything instead of settling exact matches
       first would report several and this assertion catches it. */
    assert.equal(fuzzy.length, 1);
    assert.equal(fuzzy[0]?.id, 'b-nw-2');
    assert.equal(fuzzy[0]?.path, 'experience[0].bullets[1]');
    assert.equal(fuzzy[0]?.match, 'fuzzy_text');
    /* The score is reported, because the number is what a reviewer judges. */
    assert.ok((fuzzy[0]?.similarity ?? 0) > 0.6, 'the score must be reported, not null');
    assert.equal(needsHumanReview(result.report), true);
  });

  /* TWIN - the same shape of edit, pushed past recognition. Without this, a
     reconciler that carried ids for ANY pair of bullets under a matched parent
     would pass the two tests above. */
  it('does NOT carry when the text is genuinely different', () => {
    const rewritten = reparse({
      ...STORED,
      experience: STORED.experience.map((exp, index) =>
        index !== 0
          ? exp
          : {
              ...exp,
              bullets: exp.bullets.map((b) =>
                b.id !== 'b-nw-2'
                  ? b
                  : { ...b, text: 'Mentored three interns through their onboarding month.' },
              ),
            },
      ),
    });
    const result = reconcileMasterProfile({
      previous: STORED,
      incoming: rewritten,
      mintId: makeMinter('new'),
    });
    assert.notEqual(bulletIdAt(result.profile, 'experience', 0, 1), 'b-nw-2');
    assert.equal(result.report.minted.length, 1);
    assert.equal(result.report.minted[0]?.path, 'experience[0].bullets[1]');
    /* And the old claim is reported as dropped, not silently forgotten - a pin
       may still reference it. */
    assert.equal(result.report.dropped.length, 1);
    assert.equal(result.report.dropped[0]?.id, 'b-nw-2');
  });
});

describe('one reworded bullet plus one genuinely new project', () => {
  /* THE PAIR THAT SEPARATES TWO WRONG IMPLEMENTATIONS. A reconciler that only
     ever preserves and one that only ever mints both pass a rejection-only
     test; only an input requiring BOTH behaviours at once tells them apart. */
  const incoming = reparse({
    ...STORED,
    experience: STORED.experience.map((exp, index) =>
      index !== 0
        ? exp
        : {
            ...exp,
            bullets: exp.bullets.map((b) =>
              b.id !== 'b-nw-2'
                ? b
                : { ...b, text: 'Reduced p95 latency by 40% using a read-through cache.' },
            ),
          },
    ),
    projects: [
      ...STORED.projects,
      project('prj-brandnew', 'Telemetry Explorer', [
        bullet('b-bn-1', 'Streamed sensor readings into a columnar store.'),
      ]),
    ],
  });

  it('carries exactly one id by score and mints exactly one project', () => {
    const result = reconcileMasterProfile({
      previous: STORED,
      incoming,
      mintId: makeMinter('new'),
    });

    /* Exactly one fuzzy carry: the reworded bullet. */
    const fuzzy = nonExactCarries(result.report);
    assert.equal(fuzzy.length, 1);
    assert.equal(fuzzy[0]?.id, 'b-nw-2');

    /* Exactly one minted project. */
    const mintedProjects = result.report.minted.filter((m) => m.kind === 'project');
    assert.equal(mintedProjects.length, 1);
    assert.equal(mintedProjects[0]?.path, 'projects[2]');
    assert.equal(mintedProjects[0]?.reason, 'no_candidate');

    /* Its bullet is minted too, and for the CASCADE reason - a new parent means
       no similarity search was attempted, which is the parent-scoping rule
       showing up in the report. */
    const mintedBullets = result.report.minted.filter((m) => m.kind === 'bullet');
    assert.equal(mintedBullets.length, 1);
    assert.equal(mintedBullets[0]?.path, 'projects[2].bullets[0]');
    assert.equal(mintedBullets[0]?.reason, 'new_parent');

    /* And its LINK, which the project fixture gives every project by default.
       Minted for the SAME cascade reason as the bullet rather than
       `no_candidate`: the pool was empty because the parent is new, not because
       this address is new content, and the two read completely differently to
       somebody scanning the report for what to look at. */
    const mintedLinks = result.report.minted.filter((m) => m.kind === 'link');
    assert.equal(mintedLinks.length, 1);
    assert.equal(mintedLinks[0]?.path, 'projects[2].links[0]');
    assert.equal(mintedLinks[0]?.reason, 'new_parent');
    /* The link row names the project it belongs to - a bare "Live <...>" row is
       not reviewable without it. */
    assert.equal(mintedLinks[0]?.parentLabel, 'Telemetry Explorer');

    /* Nothing else moved: three mints total, no drops. */
    assert.equal(result.report.minted.length, 3);
    assert.deepEqual(result.report.dropped, []);

    /* And every pre-existing node kept its exact id at its exact path. */
    const before = idsByPath(STORED);
    const after = idsByPath(result.profile);
    for (const [path, id] of Object.entries(before)) {
      assert.equal(after[path], id, 'id at ' + path + ' must be unchanged');
    }
  });
});

describe('global NodeId uniqueness of the output', () => {
  it('holds for a first upload, a re-upload, and a re-upload with additions', () => {
    const first = reconcileMasterProfile({
      previous: null,
      incoming: reparse(STORED),
      mintId: makeMinter('a'),
    });
    assert.deepEqual(findDuplicateNodeIds(first.profile), []);
    /* First upload mints everything, and says so with one reason rather than
       hundreds of misleading ones. */
    assert.equal(first.report.carried.length, 0);
    assert.equal(first.report.minted.length, collectNodeIds(STORED).length);
    assert.ok(first.report.minted.every((m) => m.reason === 'no_previous_profile'));

    const second = reconcileMasterProfile({
      previous: first.profile,
      incoming: reparse(STORED),
      mintId: makeMinter('b'),
    });
    assert.deepEqual(findDuplicateNodeIds(second.profile), []);

    const third = reconcileMasterProfile({
      previous: second.profile,
      incoming: reparse({
        ...STORED,
        skills: [...STORED.skills, skill('sk-rust', 'Rust', 'Programming')],
      }),
      mintId: makeMinter('c'),
    });
    assert.deepEqual(findDuplicateNodeIds(third.profile), []);
    /* Uniqueness across the whole profile is only interesting if ids from
       different kinds share one space - assert the inventory is global. */
    assert.equal(collectNodeIds(third.profile).length, collectNodeIds(STORED).length + 1);
  });

  /* THE POSTCONDITION, tested by breaking the one thing the construction cannot
     verify: the injected minter. */
  it('throws rather than emitting a profile whose minted ids collide', () => {
    assert.throws(
      () =>
        reconcileMasterProfile({
          previous: null,
          incoming: reparse(STORED),
          /* A caller mistake this package cannot detect any other way. */
          mintId: () => 'always-the-same',
        }),
      (error: unknown) =>
        error instanceof ReconciliationError && /mintId/.test((error as Error).message),
    );
  });

  /* TWIN - the same code path with a well-behaved minter must succeed, so the
     postcondition is not simply refusing every first upload. */
  it('accepts a first upload when the minter is well-behaved', () => {
    const result = reconcileMasterProfile({
      previous: null,
      incoming: reparse(STORED),
      mintId: makeMinter('ok'),
    });
    assert.deepEqual(findDuplicateNodeIds(result.profile), []);
  });

  /* THE PRECONDITION, WITH THE OTHER GUARD NEUTRALISED. A corrupt stored id
     space cannot be reconciled against: which of two nodes sharing an id gets
     carried would be decided by walk order, which is the misattribution with
     extra steps.

     WHY THE INPUT IS SHAPED SO ODDLY - and this is the point of the test. The
     first version of it fed a corrupt profile whose duplicate ids CARRIED into
     the output, so the POSTCONDITION threw and the test passed with the
     precondition disabled. Measured, not guessed: mutating the precondition
     killed zero tests. That is the repo's THE RULE - when two guards can both
     catch a case, isolating one needs an input that ONLY that guard catches.

     So the duplicate here sits on two skills that are BOTH ABSENT from the
     incoming profile. They are dropped rather than carried, the output is
     perfectly clean, and the postcondition has nothing to fire on. */
  it('refuses to reconcile against a corrupt stored profile, even when the output would be clean', () => {
    const corrupt = profileOf({
      skills: [
        skill('shared-id', 'Python', 'Programming'),
        skill('shared-id', 'SQL', 'Programming'),
      ],
    });
    /* Incoming has no skills at all, so neither duplicate reaches the output. */
    const incoming = profileOf({});
    assert.throws(
      () => reconcileMasterProfile({ previous: corrupt, incoming, mintId: makeMinter('new') }),
      (error: unknown) =>
        error instanceof ReconciliationError &&
        /* The MESSAGE is asserted, not merely the fact of an error: both guards
           throw the same class, so "it threw" is exactly the composite result
           the rule warns about. */
        /stored profile/.test((error as Error).message),
    );
  });

  /* The end-to-end version, kept because it is the realistic corruption - and
     now asserting WHICH guard spoke, so it cannot silently start passing for
     the postcondition's reason. */
  it('names the stored profile when a bullet id collides with a skill id there', () => {
    const corrupt = profileOf({
      skills: [skill('shared-id', 'Python', 'Programming')],
      experience: [
        experience('exp-1', 'Northwind Systems', 'Engineer', [
          /* A BULLET id colliding with a SKILL id - one of the only two cases a
             per-section checker misses. */
          bullet('shared-id', 'Shipped the thing.'),
        ]),
      ],
    });
    assert.throws(
      () =>
        reconcileMasterProfile({
          previous: corrupt,
          incoming: reparse(corrupt),
          mintId: makeMinter('new'),
        }),
      (error: unknown) =>
        error instanceof ReconciliationError && /stored profile/.test((error as Error).message),
    );
  });
});

describe('parent scoping - the misattribution guard', () => {
  /* THE MOST IMPORTANT TEST IN THIS FILE. A bullet's text moves from one
     employer to another between uploads. A global bullet matcher would carry the
     id across and produce fabricated experience assembled from true parts, where
     every individual claim survives a fact-check. */
  const previous = profileOf({
    experience: [
      experience('exp-northwind', 'Northwind Systems', 'Engineer', [
        bullet('b-secret', 'Cut p95 latency 40% by adding a read-through cache.'),
      ]),
      experience('exp-helios', 'Helios Analytics', 'Coordinator', [
        bullet('b-helios', 'Organised two hackathons with 340 student attendees.'),
      ]),
    ],
  });

  it('does not carry a bullet id across employers even on an exact text match', () => {
    const incoming = reparse({
      ...previous,
      experience: [
        /* Northwind's bullet is replaced by something unrelated ... */
        experience('exp-northwind', 'Northwind Systems', 'Engineer', [
          bullet('x', 'Documented the deployment runbook.'),
        ]),
        /* ... and its exact text now appears under Helios. */
        experience('exp-helios', 'Helios Analytics', 'Coordinator', [
          bullet('y', 'Cut p95 latency 40% by adding a read-through cache.'),
        ]),
      ],
    });
    const result = reconcileMasterProfile({
      previous,
      incoming,
      mintId: makeMinter('new'),
    });

    /* The migrated bullet must NOT inherit b-secret. */
    const helios = bulletIdAt(result.profile, 'experience', 1, 0);
    assert.notEqual(helios, 'b-secret');
    assert.ok(helios?.startsWith('new-'), 'it must be a freshly minted id');
    /* And b-secret must be reported dropped, which is the honest description:
       the claim is no longer under the employer it was made about. */
    assert.ok(result.report.dropped.some((d) => d.id === 'b-secret'));
    /* Helios's own bullet is also gone, and reported. */
    assert.ok(result.report.dropped.some((d) => d.id === 'b-helios'));
  });

  /* TWIN - the identical bullet text under the SAME employer must carry. Without
     this, a reconciler that never carried any bullet id would pass the test
     above. The two inputs differ in exactly one dimension: which parent the
     text sits under. */
  it('does carry that same bullet id when it stays under its own employer', () => {
    const incoming = reparse(previous);
    const result = reconcileMasterProfile({
      previous,
      incoming,
      mintId: makeMinter('new'),
    });
    assert.equal(bulletIdAt(result.profile, 'experience', 0, 0), 'b-secret');
    assert.deepEqual(result.report.dropped, []);
  });
});

describe('ambiguity fails loud', () => {
  /* One incoming bullet, two equally good previous candidates. */
  const previous = profileOf({
    projects: [
      project('prj-1', 'Analyzer', [
        bullet('b-gamma', 'alpha beta gamma'),
        bullet('b-delta', 'alpha beta delta'),
      ]),
    ],
  });

  it('refuses to pick between two tied candidates and reports both', () => {
    const incoming = reparse({
      ...previous,
      projects: [project('prj-1', 'Analyzer', [bullet('z', 'alpha beta')])],
    });
    const result = reconcileMasterProfile({ previous, incoming, mintId: makeMinter('new') });

    assert.equal(result.report.ambiguous.length, 1);
    const ambiguity = result.report.ambiguous[0];
    assert.equal(ambiguity?.reason, 'tied_similarity');
    assert.equal(ambiguity?.kind, 'bullet');
    /* Localised to the parent, and naming exactly the ids a human chooses
       between. */
    assert.equal(ambiguity?.parentId, 'prj-1');
    assert.deepEqual([...(ambiguity?.candidateIds ?? [])].sort(), ['b-delta', 'b-gamma']);
    /* The bullet got a fresh id, with the reason a human can act on. */
    assert.equal(result.report.minted.length, 1);
    assert.equal(result.report.minted[0]?.reason, 'ambiguous');
    assert.equal(needsHumanReview(result.report), true);
  });

  /* TWIN - break the tie by one token and the id must carry. Same two previous
     bullets, same parent, one word different in the incoming text. */
  it('carries the id when one candidate is strictly better', () => {
    const incoming = reparse({
      ...previous,
      projects: [project('prj-1', 'Analyzer', [bullet('z', 'alpha beta gamma epsilon')])],
    });
    const result = reconcileMasterProfile({ previous, incoming, mintId: makeMinter('new') });
    assert.deepEqual(result.report.ambiguous, []);
    assert.equal(bulletIdAt(result.profile, 'projects', 0, 0), 'b-gamma');
  });

  /* THE AXIS A SINGLE-DIRECTION IMPLEMENTATION MISSES: two incoming bullets
     tied against ONE previous bullet. Whichever inherited the id would be
     arbitrary, and the loser would silently get a fresh one. */
  it('refuses when two incoming bullets tie for one previous bullet', () => {
    const onePrevious = profileOf({
      projects: [project('prj-1', 'Analyzer', [bullet('b-only', 'alpha beta')])],
    });
    const incoming = reparse({
      ...onePrevious,
      projects: [
        project('prj-1', 'Analyzer', [
          bullet('z1', 'alpha beta gamma'),
          bullet('z2', 'alpha beta delta'),
        ]),
      ],
    });
    const result = reconcileMasterProfile({
      previous: onePrevious,
      incoming,
      mintId: makeMinter('new'),
    });
    assert.equal(result.report.ambiguous.length, 2, 'both contenders are reported');
    assert.ok(result.report.ambiguous.every((a) => a.reason === 'tied_similarity'));
    assert.equal(result.report.minted.filter((m) => m.reason === 'ambiguous').length, 2);
    /* The previous bullet went to neither, so it is dropped rather than
       silently attached to whichever came first. */
    assert.ok(result.report.dropped.some((d) => d.id === 'b-only'));
  });
});

describe('the similarity threshold, in both directions', () => {
  /* Evidence for the claim in similarity.ts that this knob fails silently both
     ways: ONE input, two threshold settings, opposite outcomes. */
  const previous = profileOf({
    projects: [project('prj-1', 'Analyzer', [bullet('b-1', 'cut p95 latency 40')])],
  });
  const incoming = reparse({
    ...previous,
    projects: [project('prj-1', 'Analyzer', [bullet('z', 'reduced p95 latency by 40')])],
  });

  it('carries at 0.6 - the reworded bullet is recognised', () => {
    const result = reconcileMasterProfile({
      previous,
      incoming,
      mintId: makeMinter('new'),
      similarityThreshold: 0.6,
    });
    assert.equal(bulletIdAt(result.profile, 'projects', 0, 0), 'b-1');
  });

  it('churns at 0.7 - the same rewording is treated as new content', () => {
    const result = reconcileMasterProfile({
      previous,
      incoming,
      mintId: makeMinter('new'),
      similarityThreshold: 0.7,
    });
    assert.notEqual(bulletIdAt(result.profile, 'projects', 0, 0), 'b-1');
    assert.equal(result.report.minted[0]?.reason, 'below_threshold');
    /* The near-miss score is reported, which is the single most useful number
       for someone deciding whether the threshold is set wrong. */
    const best = result.report.minted[0]?.bestScore ?? 0;
    assert.ok(best > 0.66 && best < 0.67, 'expected ~0.667, got ' + String(best));
  });
});

describe('project taglines and skill categories', () => {
  /* Both come from the real document, and both would churn ids under the
     original brief's match keys. */
  it('carries a project id when only its tagline is reworded, and its bullets with it', () => {
    const incoming = reparse({
      ...STORED,
      projects: STORED.projects.map((p) =>
        p.id !== 'prj-oneonone' ? p : { ...p, name: 'One-on-One - Mentorship Booking Platform' },
      ),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    assert.equal(result.profile.projects[0]?.id, 'prj-oneonone');
    /* The cascade that did NOT happen: both bullets kept their ids. */
    assert.equal(bulletIdAt(result.profile, 'projects', 0, 0), 'b-oo-1');
    assert.equal(bulletIdAt(result.profile, 'projects', 0, 1), 'b-oo-2');
    assert.deepEqual(result.report.minted, []);
  });

  /* TWIN - renaming the project's actual NAME must mint, so the key is not
     simply matching everything. */
  it('mints when the project name itself changes, and reports the cascade', () => {
    const incoming = reparse({
      ...STORED,
      projects: STORED.projects.map((p) =>
        p.id !== 'prj-oneonone' ? p : { ...p, name: 'Mentorly - AI-Powered Learning Platform' },
      ),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    assert.notEqual(result.profile.projects[0]?.id, 'prj-oneonone');
    /* One project, both of its bullets AND both of its links - five mints, four
       of them `new_parent`. The links are in the cascade for the same reason the
       bullets are: their pool is scoped to the previous version of THIS project,
       and there is no previous version of this project any more. */
    assert.equal(result.report.minted.length, 5);
    assert.equal(result.report.minted.filter((m) => m.reason === 'new_parent').length, 4);
    assert.ok(result.report.dropped.some((d) => d.id === 'prj-oneonone'));
    assert.ok(result.report.dropped.some((d) => d.id === 'b-oo-1'));
    assert.ok(result.report.dropped.some((d) => d.id === 'b-oo-2'));
    /* The link ids go dangling too, and dangling is reported rather than
       inferred from the project's own row. */
    assert.ok(result.report.dropped.some((d) => d.id === 'lnk-oo-live'));
    assert.ok(result.report.dropped.some((d) => d.id === 'lnk-oo-repo'));
  });

  it('carries a skill id when it is re-filed under a different category', () => {
    const incoming = reparse({
      ...STORED,
      skills: STORED.skills.map((s) =>
        s.id !== 'sk-docker' ? s : { ...s, category: 'Cloud & DevOps' },
      ),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    assert.equal(result.profile.skills[4]?.id, 'sk-docker');
    assert.deepEqual(result.report.minted, []);
  });

  /* TWIN - a renamed skill is a different skill. */
  it('mints when the skill name changes', () => {
    const incoming = reparse({
      ...STORED,
      skills: STORED.skills.map((s) => (s.id !== 'sk-docker' ? s : { ...s, name: 'Podman' })),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    assert.equal(result.report.minted.length, 1);
    assert.equal(result.report.minted[0]?.kind, 'skill');
    assert.ok(result.report.dropped.some((d) => d.id === 'sk-docker'));
  });

  /* C and C++ must stay distinct. A punctuation-stripping key collapses them,
     both keys go ambiguous, and both ids churn on an upload that changed
     nothing. */
  it('keeps C and C++ as separate skills across a re-upload', () => {
    const result = reconcileMasterProfile({
      previous: STORED,
      incoming: reparse(STORED),
      mintId: makeMinter('new'),
    });
    assert.equal(result.profile.skills[2]?.id, 'sk-c');
    assert.equal(result.profile.skills[3]?.id, 'sk-cpp');
    assert.deepEqual(result.report.ambiguous, []);
  });
});

describe('a deleted project', () => {
  /* `dropped` earns its place here: old pinned applications still reference
     this project's bullets, and that has to be visible rather than inferred. */
  it('reports the project and every id under it - bullets AND links', () => {
    const incoming = reparse({
      ...STORED,
      projects: STORED.projects.filter((p) => p.id !== 'prj-racepace'),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    const droppedIds = result.report.dropped.map((d) => d.id).sort();
    /* THE LINK IS IN THIS LIST BECAUSE OF THIS TEST. The first version of the
       2026-09-11 change listed a deleted project's bullets and silently omitted
       its links - a second nested id-bearing array with exactly the same
       property, added on the same day, dangling with nothing reporting it. An
       exhaustive `deepEqual` on the whole list is what caught it; a
       `dropped.some(...)` per id would have passed unchanged. */
    assert.deepEqual(droppedIds, ['b-rp-1', 'prj-racepace', 'prj-racepace-live']);
    /* Each dropped entry names where it used to live, so a reader can find it
       in the version that still has it. */
    const projectDrop = result.report.dropped.find((d) => d.id === 'prj-racepace');
    assert.equal(projectDrop?.previousPath, 'projects[1]');
    assert.equal(projectDrop?.label, 'Race Pace Predictor');
    /* And the link drop points at the project that went away, so three rows read
       as one deletion rather than three unexplained disappearances. */
    const linkDrop = result.report.dropped.find((d) => d.id === 'prj-racepace-live');
    assert.equal(linkDrop?.previousPath, 'projects[1].links[0]');
    assert.equal(linkDrop?.parentId, 'prj-racepace');
    assert.equal(linkDrop?.parentLabel, 'Race Pace Predictor');
  });
});

describe('determinism', () => {
  it('produces identical output when run twice', () => {
    const incoming = reparse(STORED);
    const first = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('n') });
    const second = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('n') });
    assert.deepEqual(first.profile, second.profile);
    assert.deepEqual(first.report, second.report);
  });

  /* The bug a first-match loop produces: an answer that depends on array order.
     Reordering the PREVIOUS bullets must not change which id lands on which
     text - only the paths those ids sit at. */
  it('pairs the same ids to the same text when the previous bullets are reordered', () => {
    const reversed: MasterProfile = {
      ...STORED,
      experience: STORED.experience.map((exp, index) =>
        index !== 0 ? exp : { ...exp, bullets: [...exp.bullets].reverse() },
      ),
    };
    /* One reworded bullet, so the fuzzy path is genuinely exercised rather than
       the exact-text shortcut. */
    const incoming = reparse({
      ...STORED,
      experience: STORED.experience.map((exp, index) =>
        index !== 0
          ? exp
          : {
              ...exp,
              bullets: exp.bullets.map((b) =>
                b.id !== 'b-nw-2'
                  ? b
                  : { ...b, text: 'Reduced p95 latency by 40% using a read-through cache.' },
              ),
            },
      ),
    });

    const inOrder = reconcileMasterProfile({
      previous: STORED,
      incoming,
      mintId: makeMinter('n'),
    });
    const outOfOrder = reconcileMasterProfile({
      previous: reversed,
      incoming,
      mintId: makeMinter('n'),
    });

    /* Compare id-by-text rather than id-by-path: the incoming document order is
       the same in both runs, so identical pairings must produce identical ids at
       identical paths. */
    const idsByText = (profile: MasterProfile): Record<string, string> => {
      const map: Record<string, string> = {};
      for (const exp of profile.experience) {
        for (const b of exp.bullets) {
          map[b.text] = b.id;
        }
      }
      return map;
    };
    assert.deepEqual(idsByText(inOrder.profile), idsByText(outOfOrder.profile));
  });
});

describe('links are reconciled too', () => {
  /* Without this, every re-upload mints a fresh id for a GitHub profile that
     has not changed since the first upload. */
  it('carries an identity link id when only its label is reworded', () => {
    const incoming = reparse({
      ...STORED,
      identity: {
        ...STORED.identity,
        links: [link('whatever', 'Github', 'https://github.com/example')],
      },
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    assert.equal(result.profile.identity.links[0]?.id, 'lnk-github');
  });

  /* TWIN - a different URL is a different link. */
  it('mints when the URL changes', () => {
    const incoming = reparse({
      ...STORED,
      identity: {
        ...STORED.identity,
        links: [link('whatever', 'GitHub', 'https://github.com/someone-else')],
      },
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    assert.equal(result.report.minted.filter((m) => m.kind === 'link').length, 1);
    assert.ok(result.report.dropped.some((d) => d.id === 'lnk-github'));
  });
});

describe('the summary - one node, one candidate, no pool', () => {
  /* THE ROUND TRIP, AND IT IS NOT VACUOUS. `reparse` re-identifies the summary
     as `p-summary-0` on purpose; feeding STORED straight back in would leave
     `sum-headline` already in place and this assertion would pass with the
     summary reconciler deleted. That is instance 13 of the repo's
     verification-traps document, reintroduced in a brand-new field. */
  it('carries its id across a re-parse', () => {
    const incoming = reparse(STORED);
    assert.equal(incoming.summary?.id, 'p-summary-0', 'the fixture must hand in a throwaway id');
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    assert.equal(result.profile.summary?.id, 'sum-headline');
    assert.deepEqual(result.report.minted, []);
    assert.deepEqual(result.report.dropped, []);
  });

  /* THE CASE THE DESIGN TURNS ON. There is exactly one summary, so a rewritten
     paragraph is still THE summary and its id must not move - `TailoredSummary`
     refs point at it, and Teja rewrites this paragraph constantly. */
  it('carries its id even when the paragraph is completely rewritten', () => {
    const incoming = reparse({
      ...STORED,
      summary: summary('ignored', 'Backend engineer who ships reliable data platforms.'),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    assert.equal(result.profile.summary?.id, 'sum-headline');
    /* Not silent about it: the row carries both texts, so a reader sees the
       rewrite without the id having churned. */
    const carry = result.report.carried.find((entry) => entry.kind === 'summary');
    assert.equal(carry?.path, 'summary');
    assert.equal(carry?.label, 'Backend engineer who ships reliable data platforms.');
    assert.equal(carry?.previousLabel, 'Full stack engineer shipping AI products end to end.');
    /* `exact_key`, not `fuzzy_text`: nothing was scored, and a score here would
       put the summary in the human-review list on every single upload. */
    assert.equal(carry?.match, 'exact_key');
    assert.equal(carry?.similarity, null);
    assert.deepEqual(nonExactCarries(result.report), []);
  });

  /* TWIN to both carries: a profile that had NO summary must mint rather than
     carry, or the two tests above would pass against a reconciler that returned
     `previous.summary` unconditionally. */
  it('mints when the stored profile had no summary', () => {
    const withoutSummary: MasterProfile = { ...STORED, summary: null };
    const incoming = reparse(STORED);
    const result = reconcileMasterProfile({
      previous: withoutSummary,
      incoming,
      mintId: makeMinter('new'),
    });
    assert.equal(result.profile.summary?.id, 'new-1');
    const mint = result.report.minted.find((m) => m.kind === 'summary');
    assert.equal(mint?.path, 'summary');
    /* `no_candidate`, not `no_previous_profile`: there WAS a previous profile,
       it simply had no summary, and the two are different facts. */
    assert.equal(mint?.reason, 'no_candidate');
  });

  it('says no_previous_profile instead on a genuine first upload', () => {
    const result = reconcileMasterProfile({
      previous: null,
      incoming: reparse(STORED),
      mintId: makeMinter('new'),
    });
    assert.equal(
      result.report.minted.find((m) => m.kind === 'summary')?.reason,
      'no_previous_profile',
    );
  });

  /* THE CASE `dropped` EXISTS FOR. A pinned tailoring may hold a ref to this id;
     the paragraph disappearing makes that ref dangling, and a dangling ref is a
     decision for a person rather than a cleanup detail. */
  it('reports a deleted summary as dropped, by id', () => {
    const incoming = reparse({ ...STORED, summary: null });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    assert.equal(result.profile.summary, null);
    const drop = result.report.dropped.find((d) => d.kind === 'summary');
    assert.equal(drop?.id, 'sum-headline');
    /* No index in the path: there is one summary, so `summary[0]` would name a
       section that does not exist in the JSON an operator searches. */
    assert.equal(drop?.previousPath, 'summary');
    assert.equal(drop?.parentId, null);
    /* Exactly one drop - nothing else in the profile moved. */
    assert.equal(result.report.dropped.length, 1);
  });

  /* TWIN to the drop: no summary on either side is not a deletion, and must
     report nothing at all. Without this, a reconciler that emitted a `dropped`
     row whenever the incoming summary was null would pass the test above. */
  it('reports nothing when there was no summary on either side', () => {
    const noSummary: MasterProfile = { ...STORED, summary: null };
    const result = reconcileMasterProfile({
      previous: noSummary,
      incoming: reparse(noSummary),
      mintId: makeMinter('new'),
    });
    assert.deepEqual(result.report.dropped, []);
    assert.deepEqual(result.report.minted, []);
    assert.equal(result.report.carried.filter((entry) => entry.kind === 'summary').length, 0);
  });
});

describe('achievements and certifications', () => {
  it('carry their ids, and their nested bullet ids, across a re-parse', () => {
    const incoming = reparse(STORED);
    /* The throwaway ids the parse hands in, asserted so this round trip cannot
       quietly become the vacuous one. */
    assert.equal(incoming.achievements[0]?.id, 'p-ach-0');
    assert.equal(incoming.certifications[0]?.id, 'p-cert-0');

    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });

    assert.equal(result.profile.achievements[0]?.id, 'ach-sih');
    assert.equal(result.profile.achievements[1]?.id, 'ach-gsoc');
    assert.equal(result.profile.achievements[2]?.id, 'ach-rank');
    assert.equal(result.profile.certifications[0]?.id, 'cert-aws');
    assert.equal(result.profile.certifications[3]?.id, 'cert-sec');
    /* THE DESCENT A NEW BULLETED KIND FORGETS. The parent id is the obvious
       part; the bullets underneath it are the second id-bearing place nobody
       remembers, and they would churn in silence. */
    assert.equal(bulletIdAt(result.profile, 'achievements', 0, 0), 'b-ach-1');
    assert.deepEqual(result.report.minted, []);
    assert.deepEqual(result.report.dropped, []);
  });

  /* THE KEY DECISION, TESTED DIRECTLY. The label is the primary key and the
     description is the reworded half, so rewording the detail line must not
     churn the achievement id - nor, through the parent-scoping cascade, the ids
     of the bullets underneath it. */
  it('carries an achievement id when only its description is reworded, and its bullet with it', () => {
    const incoming = reparse({
      ...STORED,
      achievements: STORED.achievements.map((a) =>
        a.id !== 'ach-sih' ? a : { ...a, description: '312 teams through to the national finals' },
      ),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    assert.equal(result.profile.achievements[0]?.id, 'ach-sih');
    assert.equal(bulletIdAt(result.profile, 'achievements', 0, 0), 'b-ach-1');
    assert.deepEqual(result.report.minted, []);
  });

  /* TWIN - changing the LABEL is changing which achievement this is, so it must
     mint and report the cascade. Without this, the test above would pass against
     a key that matched everything. The two inputs differ in exactly one
     dimension: which half of the line was edited. */
  it('mints when the achievement label itself changes, and reports the cascade', () => {
    const incoming = reparse({
      ...STORED,
      achievements: STORED.achievements.map((a) =>
        a.id !== 'ach-sih' ? a : { ...a, label: 'Runner-up - Smart India Hackathon 2025' },
      ),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    assert.notEqual(result.profile.achievements[0]?.id, 'ach-sih');
    assert.equal(result.report.minted.length, 2, 'the achievement and its one bullet');
    assert.equal(result.report.minted.filter((m) => m.reason === 'new_parent').length, 1);
    assert.ok(result.report.dropped.some((d) => d.id === 'ach-sih'));
    assert.ok(result.report.dropped.some((d) => d.id === 'b-ach-1'));
  });

  it('carries a certification id when only its issuer is reworded', () => {
    const incoming = reparse({
      ...STORED,
      certifications: STORED.certifications.map((c) =>
        c.id !== 'cert-aws' ? c : { ...c, description: 'AWS' },
      ),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    assert.equal(result.profile.certifications[0]?.id, 'cert-aws');
    assert.deepEqual(result.report.minted, []);
    /* The report still shows the change, so the carry is reviewable rather than
       merely silent. */
    const carry = result.report.carried.find((entry) => entry.id === 'cert-aws');
    assert.equal(carry?.kind, 'certification');
    assert.equal(carry?.label, 'AWS Certified Cloud Practitioner - AWS');
    assert.equal(carry?.previousLabel, 'AWS Certified Cloud Practitioner - Amazon Web Services');
  });

  /* TWIN for certifications, separately from achievements: the two are distinct
     types with distinct key functions, and a test of one proves nothing about
     the other. */
  it('mints when the certification name changes', () => {
    const incoming = reparse({
      ...STORED,
      certifications: STORED.certifications.map((c) =>
        c.id !== 'cert-aws' ? c : { ...c, label: 'AWS Certified Solutions Architect' },
      ),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    assert.equal(result.report.minted.length, 1);
    assert.equal(result.report.minted[0]?.kind, 'certification');
    assert.ok(result.report.dropped.some((d) => d.id === 'cert-aws'));
  });

  /* THE REJECTED KEY, MADE VISIBLE. Keying on the DESCRIPTION would collapse
     every description-less entry onto one empty key, make all of them ambiguous
     at once, and carry nothing - so both of these must carry, and neither may be
     reported ambiguous. Most real achievement lines have no description, which
     is what makes this the common case rather than an edge one. */
  it('carries two achievements that both have a null description', () => {
    const previous = profileOf({
      achievements: [
        achievement('ach-one', 'Winner - Regional Hackathon 2025'),
        achievement('ach-two', 'Department rank 2 of 180'),
      ],
    });
    const result = reconcileMasterProfile({
      previous,
      incoming: reparse(previous),
      mintId: makeMinter('new'),
    });
    assert.equal(result.profile.achievements[0]?.id, 'ach-one');
    assert.equal(result.profile.achievements[1]?.id, 'ach-two');
    assert.deepEqual(result.report.ambiguous, []);
    assert.deepEqual(result.report.minted, []);
  });

  /* THE TIEBREAK DOING ITS JOB: one label, two entries, separated by their
     descriptions. This is the case the primary key alone cannot resolve, and the
     acceptance half of the pair below. */
  it('separates two achievements that share a label by their descriptions', () => {
    const previous = profileOf({
      achievements: [
        achievement('ach-spring', 'Winner - Internal Hackathon', 'Spring edition'),
        achievement('ach-autumn', 'Winner - Internal Hackathon', 'Autumn edition'),
      ],
    });
    const result = reconcileMasterProfile({
      previous,
      incoming: reparse(previous),
      mintId: makeMinter('new'),
    });
    assert.equal(result.profile.achievements[0]?.id, 'ach-spring');
    assert.equal(result.profile.achievements[1]?.id, 'ach-autumn');
    assert.deepEqual(result.report.ambiguous, []);
  });

  /* REFUSAL - identical on both halves, so the tiebreak has nothing left. Two
     equally good candidates for one incoming node is a coin flip, and a coin
     flip is the misattribution this package exists to prevent. */
  it('refuses to guess between two achievements identical on both halves', () => {
    const previous = profileOf({
      achievements: [
        achievement('ach-a', 'Winner - Internal Hackathon', 'Spring edition'),
        achievement('ach-b', 'Winner - Internal Hackathon', 'Spring edition'),
      ],
    });
    const result = reconcileMasterProfile({
      previous,
      incoming: reparse(previous),
      mintId: makeMinter('new'),
    });
    assert.equal(result.report.ambiguous.length, 2);
    assert.ok(result.report.ambiguous.every((a) => a.reason === 'duplicate_match_key'));
    assert.ok(result.report.ambiguous.every((a) => a.kind === 'achievement'));
    assert.equal(result.report.minted.filter((m) => m.reason === 'ambiguous').length, 2);
    assert.equal(needsHumanReview(result.report), true);
  });

  /* A deleted achievement is a dangling reference, reported by id rather than
     left for a reader to notice. */
  it('reports a deleted certification and a deleted achievement as dropped', () => {
    const incoming = reparse({
      ...STORED,
      achievements: STORED.achievements.filter((a) => a.id !== 'ach-rank'),
      certifications: STORED.certifications.filter((c) => c.id !== 'cert-pg'),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    const droppedIds = result.report.dropped.map((d) => d.id).sort();
    assert.deepEqual(droppedIds, ['ach-rank', 'cert-pg']);
    assert.equal(
      result.report.dropped.find((d) => d.id === 'ach-rank')?.previousPath,
      'achievements[2]',
    );
    assert.equal(result.report.dropped.find((d) => d.id === 'cert-pg')?.kind, 'certification');
  });

  /* An achievement and a certification with the SAME label must not match each
     other. They are separate pools, and a cross-section carry would be the same
     class of error as a bullet under the wrong employer. */
  it('does not match an achievement against a certification with the same label', () => {
    const previous = profileOf({
      achievements: [achievement('ach-only', 'Machine Learning Specialization')],
      certifications: [],
    });
    const incoming = reparse({
      ...previous,
      achievements: [],
      certifications: [certification('throwaway', 'Machine Learning Specialization')],
    });
    const result = reconcileMasterProfile({ previous, incoming, mintId: makeMinter('new') });
    assert.notEqual(result.profile.certifications[0]?.id, 'ach-only');
    assert.ok(result.report.dropped.some((d) => d.id === 'ach-only'));
  });
});

describe('project links are reconciled inside their own project', () => {
  it('carries both links of a two-link project, and the single link of the other', () => {
    const incoming = reparse(STORED);
    /* The parse hands in positional throwaway ids that span every project, which
       is what a parser numbering anchors down the page actually produces. */
    assert.equal(incoming.projects[0]?.links[0]?.id, 'p-plink-0');
    assert.equal(incoming.projects[1]?.links[0]?.id, 'p-plink-2');

    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });

    /* BOTH, not just the first. The single `url` slot dropped one of these two on
       every upload, and a test asserting only `links[0]` would not have noticed
       the loss it replaced. */
    assert.equal(projectLinkIdAt(result.profile, 0, 0), 'lnk-oo-live');
    assert.equal(projectLinkIdAt(result.profile, 0, 1), 'lnk-oo-repo');
    assert.equal(projectLinkIdAt(result.profile, 1, 0), 'prj-racepace-live');
    assert.deepEqual(result.report.minted, []);
    assert.deepEqual(result.report.dropped, []);
  });

  it('carries a project link when only its label is reworded', () => {
    const incoming = reparse({
      ...STORED,
      projects: STORED.projects.map((p) =>
        p.id !== 'prj-oneonone'
          ? p
          : {
              ...p,
              links: [
                link('whatever', 'Demo', 'https://oneonone.example.invalid'),
                link('whatever2', 'GitHub', 'https://github.com/example/oneonone'),
              ],
            },
      ),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    /* The URL is the stable half and the label is the reworded one - the same
       decision `linkKey` already makes for identity links, now exercised two
       levels deep. */
    assert.equal(projectLinkIdAt(result.profile, 0, 0), 'lnk-oo-live');
    assert.equal(projectLinkIdAt(result.profile, 0, 1), 'lnk-oo-repo');
    assert.deepEqual(result.report.minted, []);
  });

  /* THE MISATTRIBUTION CASE, ONE LEVEL DOWN, AND IT IS A REAL TEST RATHER THAN A
     COMMENT. One URL moves from project A to project B between uploads. A global
     link pool would carry A's link id across - and forks, org renames and
     template repositories make two projects sharing a URL ordinary rather than
     contrived. The result would be a link node whose id says it belongs to a
     project it was never about. */
  const previous = profileOf({
    projects: [
      project('prj-alpha', 'Alpha', [bullet('b-alpha', 'Shipped alpha.')], [
        link('lnk-shared', 'Source', 'https://github.com/example/shared'),
      ]),
      project('prj-beta', 'Beta', [bullet('b-beta', 'Shipped beta.')], []),
    ],
  });

  it('does not let a link id migrate to another project even on an exact URL match', () => {
    const incoming = reparse({
      ...previous,
      projects: [
        /* Alpha loses the address ... */
        project('prj-alpha', 'Alpha', [bullet('b-alpha', 'Shipped alpha.')], []),
        /* ... and the identical address appears under Beta. */
        project('prj-beta', 'Beta', [bullet('b-beta', 'Shipped beta.')], [
          link('throwaway', 'Source', 'https://github.com/example/shared'),
        ]),
      ],
    });
    const result = reconcileMasterProfile({ previous, incoming, mintId: makeMinter('new') });

    const migrated = projectLinkIdAt(result.profile, 1, 0);
    assert.notEqual(migrated, 'lnk-shared');
    assert.ok(migrated?.startsWith('new-'), 'it must be a freshly minted id');
    /* And the original is reported dropped, naming the project it used to hang
       under - which is how a reader tells one relocation from two unrelated
       edits. */
    const drop = result.report.dropped.find((d) => d.id === 'lnk-shared');
    assert.equal(drop?.previousPath, 'projects[0].links[0]');
    assert.equal(drop?.parentId, 'prj-alpha');
    assert.equal(drop?.parentLabel, 'Alpha');
  });

  /* TWIN - the identical URL under the SAME project must carry. Without this, a
     reconciler that never carried any project link id would pass the test above.
     The two inputs differ in exactly one dimension: which project the link sits
     under. */
  it('does carry that same link id when it stays under its own project', () => {
    const result = reconcileMasterProfile({
      previous,
      incoming: reparse(previous),
      mintId: makeMinter('new'),
    });
    assert.equal(projectLinkIdAt(result.profile, 0, 0), 'lnk-shared');
    assert.deepEqual(result.report.dropped, []);
  });

  /* A link ADDED to an existing project is genuinely new content, and must say
     so rather than borrowing the cascade reason. The pair of reasons is the
     whole point of `noCandidateReason`: `new_parent` means "go look at the
     parent", `no_candidate` means "this is new". */
  it('mints a link added to a project that itself carried, with reason no_candidate', () => {
    const incoming = reparse({
      ...previous,
      projects: previous.projects.map((p) =>
        p.id !== 'prj-beta'
          ? p
          : { ...p, links: [link('throwaway', 'Docs', 'https://beta.example.invalid/docs')] },
      ),
    });
    const result = reconcileMasterProfile({ previous, incoming, mintId: makeMinter('new') });
    assert.equal(result.profile.projects[1]?.id, 'prj-beta', 'the parent must have carried');
    const mint = result.report.minted.find((m) => m.kind === 'link');
    assert.equal(mint?.path, 'projects[1].links[0]');
    assert.equal(mint?.reason, 'no_candidate');
    assert.equal(mint?.parentId, 'prj-beta');
  });

  /* A project that keeps its id while losing one of two links: the surviving one
     must keep its id and the other must be reported, rather than the pair being
     treated as one changed slot. This is the case the old single `url` field
     could not even express. */
  it('keeps the surviving link and reports the removed one', () => {
    const incoming = reparse({
      ...STORED,
      projects: STORED.projects.map((p) =>
        p.id !== 'prj-oneonone'
          ? p
          : { ...p, links: p.links.filter((l) => l.id !== 'lnk-oo-live') },
      ),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    assert.equal(result.profile.projects[0]?.id, 'prj-oneonone');
    assert.equal(projectLinkIdAt(result.profile, 0, 0), 'lnk-oo-repo');
    assert.equal(result.report.dropped.length, 1);
    assert.equal(result.report.dropped[0]?.id, 'lnk-oo-live');
  });
});

/* CERTIFICATION AND ACHIEVEMENT LINKS (2026-11-01). Master v9 moves three
   credential/profile URLs off the top-level `links` array onto the cert or
   achievement they belong to. From then on they are nested id-bearing nodes
   exactly like project links, and need the same per-parent reconciliation:
   without it the `...node` spread in `rebuild` would ship the parse's THROWAWAY
   link ids straight into the stored profile. */
describe('certification and achievement links are reconciled inside their own entry', () => {
  /* The link at a known position under a cert or achievement. `?.links?.` because
     the key is optional - absent on every stored master before v9. */
  const entryLinkIdAt = (
    /* The reconciled output under test. */
    profile: MasterProfile,
    /* Which of the two linked sections. */
    section: 'achievements' | 'certifications',
    /* Position of the entry in its section. */
    entryIndex: number,
    /* Position of the link under that entry. */
    linkIndex: number,
  ): string | undefined => profile[section][entryIndex]?.links?.[linkIndex]?.id;

  /* The v9 shape in miniature: one cert and one achievement, each carrying the
     link id v9 hand-writes. */
  const previous = profileOf({
    achievements: [
      /* The LeetCode line, with v9's profile link under it. */
      achievement('ach_leetcode', 'LeetCode', null, [], [
        link('link_leetcode', 'LeetCode profile', 'https://leetcode.com/example'),
      ]),
    ],
    certifications: [
      /* A cert WITH a credential link (v9 shape)... */
      certification('cert_ml', 'Machine Learning', 'IBM SkillsBuild', [], [
        link('link_cert_ml', 'Machine Learning credential', 'https://www.credly.com/badges/example'),
      ]),
      /* ...beside one with NO links key (v1-v8 shape), as v9 really mixes them. */
      certification('cert_sql', 'SQL and Relational Databases', 'IBM Developer Skills Network'),
    ],
  });

  /* TWIN A - the carry. The reparse hands in positional `p-elink-N` ids, so a
     reconciler that skipped these links would ship `p-elink-*` and fail here. */
  it('carries a cert link id and an achievement link id across a re-parse', () => {
    /* The same document, re-identified positionally like a fresh parse. */
    const incoming = reparse(previous);
    /* Non-vacuity: the incoming ids really are throwaways. */
    assert.equal(incoming.achievements[0]?.links?.[0]?.id, 'p-elink-0');
    /* Reconcile against the stored side. */
    const result = reconcileMasterProfile({ previous, incoming, mintId: makeMinter('new') });
    /* The cert's credential link kept its stored id... */
    assert.equal(entryLinkIdAt(result.profile, 'certifications', 0, 0), 'link_cert_ml');
    /* ...and so did the achievement's, through the separate achievements wiring. */
    assert.equal(entryLinkIdAt(result.profile, 'achievements', 0, 0), 'link_leetcode');
    /* An unchanged re-upload mints nothing... */
    assert.deepEqual(result.report.minted, []);
    /* ...and drops nothing. */
    assert.deepEqual(result.report.dropped, []);
  });

  /* TWIN B - the misattribution guard one level down. The identical credential
     URL reappearing under a DIFFERENT cert must not carry the id: a link id that
     says it belongs to "SQL" while it was "Machine Learning"'s credential is the
     bullet-under-the-wrong-employer error in a new field. Differs from twin A in
     one dimension only: which cert the link sits under. */
  it('does not let a cert link id migrate to another cert on an exact URL match', () => {
    /* The same two certs, with the credential moved from ML to SQL. */
    const incoming = reparse({
      ...previous,
      certifications: [
        /* ML loses the link... */
        certification('cert_ml', 'Machine Learning', 'IBM SkillsBuild', [], []),
        /* ...and the identical URL appears under SQL. */
        certification('cert_sql', 'SQL and Relational Databases', 'IBM Developer Skills Network', [], [
          link('throwaway', 'Machine Learning credential', 'https://www.credly.com/badges/example'),
        ]),
      ],
    });
    /* Reconcile against the stored side. */
    const result = reconcileMasterProfile({ previous, incoming, mintId: makeMinter('new') });
    /* The link now under SQL. */
    const migrated = entryLinkIdAt(result.profile, 'certifications', 1, 0);
    /* Must not have inherited ML's link id... */
    assert.notEqual(migrated, 'link_cert_ml');
    /* ...and must be a fresh mint, not some other carried id. */
    assert.ok(migrated?.startsWith('new-'), 'it must be a freshly minted id');
    /* And the original is reported dropped, naming the cert it hung under. */
    const drop = result.report.dropped.find((d) => d.id === 'link_cert_ml');
    /* At its stored path... */
    assert.equal(drop?.previousPath, 'certifications[0].links[0]');
    /* ...under its stored parent. */
    assert.equal(drop?.parentId, 'cert_ml');
  });

  /* THE UPGRADE PATH FROM v8: the stored cert has NO links key and the incoming
     one has a link. The pool must read as empty (not throw), and the mint must
     say `no_candidate` - the parent carried, so the link is genuinely new. */
  it('mints a link added to a v8-shaped cert that has no links key', () => {
    /* The stored side in the v1-v8 shape: one cert, no links key. */
    const v8 = profileOf({ certifications: [certification('cert_ml', 'Machine Learning', 'IBM SkillsBuild')] });
    /* Non-vacuity: the stored side really is key-absent. */
    assert.equal('links' in (v8.certifications[0] ?? {}), false, 'fixture carries a links key; test is vacuous');
    /* The same cert, now carrying a credential link. */
    const incoming = reparse({
      ...v8,
      certifications: [
        certification('cert_ml', 'Machine Learning', 'IBM SkillsBuild', [], [
          link('throwaway', 'Credential', 'https://www.credly.com/badges/example'),
        ]),
      ],
    });
    /* Reconcile: must not throw on the absent stored pool. */
    const result = reconcileMasterProfile({ previous: v8, incoming, mintId: makeMinter('new') });
    /* The cert itself carried. */
    assert.equal(result.profile.certifications[0]?.id, 'cert_ml', 'the parent must have carried');
    /* The one link row minted. */
    const mint = result.report.minted.find((m) => m.kind === 'link');
    /* At the nested path... */
    assert.equal(mint?.path, 'certifications[0].links[0]');
    /* ...as genuinely new content, since its parent matched... */
    assert.equal(mint?.reason, 'no_candidate');
    /* ...under the RECONCILED cert id. */
    assert.equal(mint?.parentId, 'cert_ml');
  });

  /* THE REALISTIC RE-UPLOAD: the PDF parser does not attach annotation links to
     certs (master-pdf extract.ts files every annotation under identity.links), so
     a re-upload hands in the cert with no links. The cert must carry and the
     credential link must be REPORTED dropped - visible in review, never a silent
     loss. */
  it('reports a stored cert link as dropped when the re-parse has none', () => {
    /* What a PDF re-upload hands in: the same certs, rebuilt with no links key. */
    const incoming = reparse({
      ...previous,
      certifications: previous.certifications.map((c) => certification(c.id, c.label, c.description)),
    });
    /* Reconcile against the stored side that has the credential link. */
    const result = reconcileMasterProfile({ previous, incoming, mintId: makeMinter('new') });
    /* The cert still carries: losing a link is not losing the cert. */
    assert.equal(result.profile.certifications[0]?.id, 'cert_ml');
    /* And exactly the credential link is reported - visible in review, never silent. */
    assert.deepEqual(result.report.dropped.map((d) => d.id), ['link_cert_ml']);
  });

  /* A DELETED ACHIEVEMENT TAKES ITS LINKS WITH IT, and a pinned application that
     rendered the link references the LINK id - so the link must be listed, not
     inferred from the parent row. Same rule as a deleted project's links. */
  it('reports a deleted achievement and every link under it', () => {
    /* The achievement section emptied. */
    const incoming = reparse({ ...previous, achievements: [] });
    /* Reconcile against the stored side. */
    const result = reconcileMasterProfile({ previous, incoming, mintId: makeMinter('new') });
    /* Sorted so the assertion is about membership, not walk order. */
    const droppedIds = result.report.dropped.map((d) => d.id).sort();
    /* Both the entry AND its link - the dropNested hook is what adds the second. */
    assert.deepEqual(droppedIds, ['ach_leetcode', 'link_leetcode']);
    /* The link's own drop row. */
    const linkDrop = result.report.dropped.find((d) => d.id === 'link_leetcode');
    /* At its stored nested path... */
    assert.equal(linkDrop?.previousPath, 'achievements[0].links[0]');
    /* ...naming the achievement it hung under. */
    assert.equal(linkDrop?.parentId, 'ach_leetcode');
  });
});

/* ABSENT DESCRIPTION KEY (live 2026-10-24). master_profiles v2 stores two
   achievements with NO `description` key - absent, not null - and it is the
   `previous` profile of every future upload. labelledEntryLabel tested only
   `=== null`, so undefined fell through to concatenation and the upload review
   showed "Winner - Smart India Hackathon 2025 - undefined". Absent must read
   exactly as null: the label alone. */
describe('an achievement whose description key is absent', () => {
  it('labels both sides of a carry without the word "undefined"', () => {
    /* The stored side in v2's shape: ach-sih with its description key deleted. */
    const previous = structuredClone(STORED) as unknown as { achievements: Record<string, unknown>[] };
    /* Delete, not null - the shape the type forbids and the live row has. */
    delete previous.achievements[0]!['description'];
    /* Non-vacuity: the key really is gone from the input under test. */
    assert.equal('description' in previous.achievements[0]!, false, 'the key was not removed; this test would be vacuous');
    /* The incoming side rewords the detail line, so a carry is reported with both labels. */
    const incoming = reparse({
      ...STORED,
      achievements: STORED.achievements.map((a) =>
        a.id !== 'ach-sih' ? a : { ...a, description: '312 teams through to the national finals' },
      ),
    });
    /* Reconcile against the holed stored profile. */
    const result = reconcileMasterProfile({ previous: previous as unknown as MasterProfile, incoming, mintId: makeMinter('new') });
    /* The carry row for the achievement whose stored side has no description. */
    const carry = result.report.carried.find((entry) => entry.id === 'ach-sih');
    /* The previous label is the label alone, exactly as a null description renders it. */
    assert.equal(carry?.previousLabel, 'Winner - Smart India Hackathon 2025');
    /* And the incoming side still shows its real description: the fix is not a blanket drop. */
    assert.equal(carry?.label, 'Winner - Smart India Hackathon 2025 - 312 teams through to the national finals');
  });
});
