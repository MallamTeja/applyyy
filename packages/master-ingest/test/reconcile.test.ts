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
  bullet,
  experience,
  link,
  makeMinter,
  profileOf,
  project,
  reparse,
  skill,
  STORED,
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
function bulletIdAt(profile: MasterProfile, section: 'experience' | 'projects', parentIndex: number, bulletIndex: number): string | undefined {
  return profile[section][parentIndex]?.bullets[bulletIndex]?.id;
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

    /* Nothing else moved: two mints total, no drops. */
    assert.equal(result.report.minted.length, 2);
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
    /* One project plus both of its bullets, and the bullets say new_parent -
       which is how the report makes a cascade legible instead of looking like
       three unrelated mints. */
    assert.equal(result.report.minted.length, 3);
    assert.equal(result.report.minted.filter((m) => m.reason === 'new_parent').length, 2);
    assert.ok(result.report.dropped.some((d) => d.id === 'prj-oneonone'));
    assert.ok(result.report.dropped.some((d) => d.id === 'b-oo-1'));
    assert.ok(result.report.dropped.some((d) => d.id === 'b-oo-2'));
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
  it('reports the project and every bullet under it', () => {
    const incoming = reparse({
      ...STORED,
      projects: STORED.projects.filter((p) => p.id !== 'prj-racepace'),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    const droppedIds = result.report.dropped.map((d) => d.id).sort();
    assert.deepEqual(droppedIds, ['b-rp-1', 'prj-racepace']);
    /* Each dropped entry names where it used to live, so a reader can find it
       in the version that still has it. */
    const projectDrop = result.report.dropped.find((d) => d.id === 'prj-racepace');
    assert.equal(projectDrop?.previousPath, 'projects[1]');
    assert.equal(projectDrop?.label, 'Race Pace Predictor');
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
