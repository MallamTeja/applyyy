/* Tests for the master-profile ingest check.
 *
 * ON THE TEST DATA: every profile below is STRUCTURAL test data, not resume
 * content. Names are "Test Person", companies are "ExampleCo", bullets say
 * things like "Did a measurable thing". That is deliberate on two counts -
 * there is no real master resume in this repo to draw on, and inventing
 * plausible-looking resume content would put fabricated claims in a file that
 * outlives the test. The checker cares about shape and ids, so placeholder text
 * exercises it exactly as well.
 *
 * RUN: `pnpm --filter @applyy/web test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkMasterProfile,
  ingestMasterProfileText,
} from '../src/features/settings/masterIngest.ts';

/* --- A minimal valid profile, built by hand -------------------------- */

/* Returns a fresh object each call so a test that mutates one cannot affect
 * another. A shared const would let the first test that pokes at it silently
 * change the input of every test after it. */
function validProfile(): Record<string, unknown> {
  return {
    schema_version: 1,
    identity: {
      full_name: 'Test Person',
      headline: null,
      email: 'test@example.invalid',
      phone: null,
      location: null,
      /* `.invalid` is a reserved TLD that can never resolve, so nothing here
         can accidentally reference a real person or site. */
      links: [{ id: 'link-1', label: 'GitHub', url: 'https://example.invalid/x' }],
    },
    education: [
      {
        id: 'edu-1',
        institution: 'ExampleU',
        degree: 'BTech',
        field: null,
        start_display: '2022',
        end_display: '2026',
        start_date: null,
        end_date: null,
        grade_display: null,
        bullets: [{ id: 'edu-1-b1', text: 'Studied a thing', tags: ['study'] }],
      },
    ],
    experience: [
      {
        id: 'exp-1',
        company: 'ExampleCo',
        role: 'Intern',
        location: null,
        start_display: 'Jan 2025',
        end_display: 'Present',
        start_date: null,
        end_date: null,
        bullets: [{ id: 'exp-1-b1', text: 'Did a measurable thing', tags: ['node'] }],
      },
    ],
    projects: [
      {
        id: 'proj-1',
        name: 'ExampleProject',
        /* WAS `url: null`. Replaced on 2026-09-11 when `MasterProject.url`
           became `links: DocumentOrdered<MasterLink>` - the scalar is GONE, not
           supplemented. The distinction matters to this fixture specifically:
           the old scalar carried no id, so there was nothing here for the
           uniqueness walk to see, whereas this link draws a `NodeId` from the
           same global pool as every other node. A fixture that kept `url: null`
           would still have passed every test while silently covering none of
           the new nested-link behaviour. */
        links: [{ id: 'proj-1-link-1', label: 'Repo', url: 'https://example.invalid/r' }],
        start_display: '2025',
        end_display: '2025',
        start_date: null,
        end_date: null,
        bullets: [{ id: 'proj-1-b1', text: 'Built a thing', tags: ['react'] }],
      },
    ],
    skills: [{ id: 'skill-1', name: 'TypeScript', category: 'Languages' }],
    /* The summary. A REQUIRED FIELD WITH A NULLABLE VALUE, and this fixture
       supplies a real node rather than null on purpose: null is the easy case
       and would leave the id-bearing branch - the one that can collide with
       every other node in the profile - untested by the happy path. */
    summary: { id: 'summary-1', text: 'A short paragraph about the person.' },
    /* Achievements and certifications, added to the contract on 2026-09-11
       because the real resume had both and ingest was silently truncating them.
       Both carry bullets, which is the second id-bearing place under a new node
       kind and the part a fixture usually forgets. */
    achievements: [
      {
        id: 'ach-1',
        label: 'Winner, Example Hackathon',
        description: null,
        bullets: [{ id: 'ach-1-b1', text: 'Beat 300 teams', tags: ['award'] }],
      },
    ],
    certifications: [
      {
        id: 'cert-1',
        label: 'Example Certified Practitioner',
        description: 'Example Issuer',
        /* A bullet rather than an empty array, so the happy path stays free of
           advisory findings - an empty bullets array is legal but draws a "this
           would render as a heading with nothing under it" advisory, which
           would make the zero-findings assertion below about the fixture rather
           than about the checker. */
        bullets: [{ id: 'cert-1-b1', text: 'Passed the exam', tags: ['cloud'] }],
      },
    ],
    links: [{ id: 'toplink-1', label: 'Portfolio', url: 'https://example.invalid/p' }],
  };
}

/* Every blocking finding, for assertions that care about failure reasons. */
function blockingPaths(findings: readonly { severity: string; path: string }[]): string[] {
  return findings.filter((f) => f.severity === 'blocking').map((f) => f.path);
}

/* --- The happy path -------------------------------------------------- */

test('a complete profile is accepted and counted', () => {
  const result = checkMasterProfile(validProfile());

  /* Asserting `ok` first and separately: if this fails, the findings are the
     diagnostic, so they are worth printing rather than hiding behind a
     narrowing check. */
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  /* The union means `summary` is only reachable after narrowing, which is the
     property the union exists for - this line would not compile otherwise. */
  if (!result.ok) return;

  /* Counts are what the operator sanity-checks against the resume in front of
     them, so they have to be right rather than roughly right. */
  assert.deepEqual(result.summary, {
    skills: 1,
    experience: 1,
    projects: 1,
    education: 1,
    achievements: 1,
    certifications: 1,
    /* Five bullets across FIVE different parent kinds - experience, projects,
       education, achievements and certifications. The number is what proves
       every bulleted kind was walked, and it is the assertion that would have
       caught achievements and certifications being silently skipped when they
       joined the contract on 2026-09-11. */
    bullets: 5,
    /* One link in each of the three arrays that carry them: `identity.links`,
       `projects[0].links` and the top-level `links`. Three rather than one is
       the assertion that proves the nested project links are walked at all -
       they were invisible to this checker until `MasterProject.url` was
       replaced by `links`. */
    links: 3,
    hasSummary: true,
  });
  /* No advisory findings either: this profile has tags on every bullet, at
     least one skill, and experience present. */
  assert.deepEqual(result.findings, []);
});

/* --- THE headline check: duplicate bullet ids ------------------------ */

/* This is the reason the module exists. The tailor validator indexes bullets
 * into one flat Map across experience, projects and education, so a duplicate
 * id makes the later bullet overwrite the earlier one - and the
 * `misattributed_bullet` check then compares against the wrong parent. A
 * genuinely misattributed bullet can pass the audit with no error anywhere. */
test('a bullet id duplicated ACROSS sections is blocking', () => {
  const profile = validProfile();

  /* The collision that a per-section uniqueness check would miss entirely: the
     project bullet takes the experience bullet's id. Both sections are
     internally unique; only the flat index sees the clash. */
  (profile['projects'] as Record<string, unknown>[])[0]!['bullets'] = [
    { id: 'exp-1-b1', text: 'Built a thing', tags: ['react'] },
  ];

  const result = checkMasterProfile(profile);

  assert.equal(result.ok, false);
  if (result.ok) return;

  const paths = blockingPaths(result.findings);
  assert.ok(
    paths.includes('projects[0].bullets[0].id'),
    'expected the duplicate to be reported at the second occurrence, got ' +
      JSON.stringify(paths),
  );

  /* The message must explain the CONSEQUENCE, not just state the rule. "Ids
     must be unique" gets shrugged at; losing the misattribution check does
     not. This asserts the explanation is actually there, because the whole
     value of the finding is that sentence. */
  const finding = result.findings.find((f) => f.path === 'projects[0].bullets[0].id');
  assert.ok(finding !== undefined);
  assert.match(finding.problem, /misattributed|overwrites|wrong parent/i);
  /* And it must name the first location, or the operator has to search for the
     other half of a collision they cannot see. */
  assert.match(finding.problem, /experience\[0\]\.bullets\[0\]/);
});

test('a bullet id duplicated WITHIN one section is blocking', () => {
  const profile = validProfile();

  /* The likelier mistake in practice: copying the bullet above and forgetting
     to change its id. */
  (profile['experience'] as Record<string, unknown>[])[0]!['bullets'] = [
    { id: 'exp-1-b1', text: 'Did a measurable thing', tags: ['node'] },
    { id: 'exp-1-b1', text: 'Did another measurable thing', tags: ['sql'] },
  ];

  const result = checkMasterProfile(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(blockingPaths(result.findings).includes('experience[0].bullets[1].id'));
});

test('a non-bullet id colliding with a bullet id is blocking', () => {
  const profile = validProfile();

  /* Ids share ONE namespace across every node kind, because a tailored resume
     refers to nodes by bare id. A skill that takes a bullet's id is exactly as
     ambiguous as two bullets clashing. */
  (profile['skills'] as Record<string, unknown>[])[0]!['id'] = 'exp-1-b1';

  const result = checkMasterProfile(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  /* Reported at whichever came second in the walk - skills are walked before
     experience, so the experience bullet is the duplicate here. Asserting on
     the SET rather than a specific path keeps this test about the collision
     rather than about walk order. */
  const paths = blockingPaths(result.findings);
  assert.ok(
    paths.includes('experience[0].bullets[0].id') || paths.includes('skills[0].id'),
    'expected a collision to be reported, got ' + JSON.stringify(paths),
  );
});

/* --- Missing and blank required fields ------------------------------- */

test('a bullet with no id is blocking, because nothing could ever select it', () => {
  const profile = validProfile();
  (profile['experience'] as Record<string, unknown>[])[0]!['bullets'] = [
    { text: 'Did a measurable thing', tags: ['node'] },
  ];

  const result = checkMasterProfile(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(blockingPaths(result.findings).includes('experience[0].bullets[0].id'));
});

test('blank bullet text is blocking, because a rewording has nothing to be checked against', () => {
  const profile = validProfile();
  (profile['experience'] as Record<string, unknown>[])[0]!['bullets'] = [
    /* Whitespace-only, not empty - the case a `length > 0` check would let
       through, and it renders as a blank line on a real resume. */
    { id: 'exp-1-b1', text: '   ', tags: ['node'] },
  ];

  const result = checkMasterProfile(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(blockingPaths(result.findings).includes('experience[0].bullets[0].text'));
});

test('a missing display date is blocking, because the renderer will not compute one', () => {
  const profile = validProfile();
  delete (profile['experience'] as Record<string, unknown>[])[0]!['end_display'];

  const result = checkMasterProfile(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(blockingPaths(result.findings).includes('experience[0].end_display'));
});

test('identity name and email are required', () => {
  const profile = validProfile();
  (profile['identity'] as Record<string, unknown>)['full_name'] = '';
  (profile['identity'] as Record<string, unknown>)['email'] = '';

  const result = checkMasterProfile(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  const paths = blockingPaths(result.findings);
  assert.ok(paths.includes('identity.full_name'));
  assert.ok(paths.includes('identity.email'));
});

test('optional identity fields being null is fine', () => {
  const profile = validProfile();
  /* headline, phone and location are nullable in the contract. A checker that
     required them would reject a legitimate profile - a stricter check is not
     a better check. */
  const identity = profile['identity'] as Record<string, unknown>;
  identity['headline'] = null;
  identity['phone'] = null;
  identity['location'] = null;

  assert.equal(checkMasterProfile(profile).ok, true);
});

/* --- The version gate ------------------------------------------------ */

test('a schema_version other than 1 is blocking', () => {
  for (const version of [0, 2, '1', null, undefined]) {
    const profile = validProfile();
    profile['schema_version'] = version;

    const result = checkMasterProfile(profile);
    assert.equal(result.ok, false, 'version ' + JSON.stringify(version) + ' should be refused');
    if (result.ok) continue;
    assert.ok(blockingPaths(result.findings).includes('schema_version'));
  }
});

/* --- Advisory findings, which must NOT block ------------------------- */

test('an untagged bullet is advisory, not blocking', () => {
  const profile = validProfile();
  (profile['experience'] as Record<string, unknown>[])[0]!['bullets'] = [
    { id: 'exp-1-b1', text: 'Did a measurable thing', tags: [] },
  ];

  const result = checkMasterProfile(profile);
  /* The distinction is the point: this profile is storable. Treating it as
     blocking would stop the operator saving a legal master over a formatting
     preference. */
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const advisory = result.findings.filter((f) => f.severity === 'advisory');
  assert.equal(advisory.length, 1);
  assert.equal(advisory[0]!.path, 'experience[0].bullets[0].tags');
});

test('an empty skills list is advisory and explains the consequence', () => {
  const profile = validProfile();
  profile['skills'] = [];

  const result = checkMasterProfile(profile);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const finding = result.findings.find((f) => f.path === 'skills');
  assert.ok(finding !== undefined);
  assert.equal(finding.severity, 'advisory');
  /* Names the actual consequence - coverage stays zero - rather than just
     saying the list is empty, which the operator can already see. */
  assert.match(finding.problem, /coverage/i);
});

test('no experience and no projects is advisory, with nothing for the Tailor to select', () => {
  const profile = validProfile();
  profile['experience'] = [];
  profile['projects'] = [];

  const result = checkMasterProfile(profile);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(
    result.findings.some(
      (f) => f.severity === 'advisory' && /nothing for the Tailor/i.test(f.problem),
    ),
  );
});

/* --- Structural garbage, which must not throw ------------------------ */

/* A paste check that crashes loses the operator's paste, so every one of these
 * must come back as a finding rather than an exception. Table-driven because
 * "garbage" is a family and its members fail at different points. */
const GARBAGE: readonly { what: string; value: unknown }[] = [
  { what: 'null', value: null },
  { what: 'a number', value: 42 },
  { what: 'a string', value: 'not a profile' },
  { what: 'an array', value: [] },
  { what: 'an empty object', value: {} },
  /* Right type, wrong everything else - the case that walks furthest into the
     checker before failing. */
  { what: 'sections that are objects instead of arrays', value: { schema_version: 1, identity: {}, education: {}, experience: {}, projects: {}, skills: {}, links: {} } },
];

for (const { what, value } of GARBAGE) {
  test('does not throw on ' + what, () => {
    /* `doesNotThrow` first, because a thrown error and a blocking finding are
       very different outcomes for the operator and only one is acceptable. */
    assert.doesNotThrow(() => checkMasterProfile(value));
    const result = checkMasterProfile(value);
    assert.equal(result.ok, false);
    if (result.ok) return;
    /* And it must actually say something - an empty findings list with ok:false
       would be a refusal with no explanation. */
    assert.ok(result.findings.length > 0);
  });
}

/* --- The text entry point -------------------------------------------- */

test('invalid JSON is reported as a parse failure, not a crash', () => {
  const result = ingestMasterProfileText('{ "schema_version": 1, ');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.findings[0]!.problem, /not valid json/i);
});

test('valid JSON text round-trips to an accepted profile', () => {
  /* Proves the two entry points agree. A checker that passes on an object but
     fails on the same object serialised would be a real bug, and JSON.parse
     drops `undefined` values - so this is not a redundant test. */
  const result = ingestMasterProfileText(JSON.stringify(validProfile()));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test('every finding carries a path an operator can search for', () => {
  const profile = validProfile();
  /* Break several things at once: the checker must report all of them from one
     paste rather than making the operator fix and re-paste repeatedly. */
  (profile['identity'] as Record<string, unknown>)['email'] = '';
  (profile['experience'] as Record<string, unknown>[])[0]!['bullets'] = [
    { id: 'dup', text: '', tags: [] },
  ];
  (profile['projects'] as Record<string, unknown>[])[0]!['bullets'] = [
    { id: 'dup', text: 'Built a thing', tags: ['react'] },
  ];

  const result = checkMasterProfile(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;

  /* More than one problem reported from a single pass. */
  assert.ok(result.findings.length >= 3);
  for (const finding of result.findings) {
    /* A path that is empty, or that does not point at a real location, makes
       the finding unactionable in a several-thousand-character paste. */
    assert.ok(finding.path.length > 0, 'finding with no path: ' + finding.problem);
    assert.ok(finding.problem.length > 0, 'finding with no explanation at ' + finding.path);
  }
});

/* --- Mutation check: MEASURED ---------------------------------------- */

/* These tests were written after the implementation and all 36 passed on the
 * first run, which is exactly when they deserve to be distrusted. So the
 * checker was broken on purpose to find out which of them were load-bearing.
 *
 * MUTATION APPLIED: gave each bulleted section its own `IdLedger` instead of
 * sharing one - i.e. uniqueness enforced PER SECTION rather than across the
 * flat index. That is the plausible wrong design, and the one that looks more
 * correct at a glance, because "ids unique within experience" reads like a
 * sensible rule.
 *
 * MEASURED RESULT: 36 tests, 34 passed, 2 failed.
 *   KILLED:   "a bullet id duplicated ACROSS sections is blocking" and
 *             "a non-bullet id colliding with a bullet id is blocking".
 *   SURVIVED: everything else, INCLUDING "a bullet id duplicated WITHIN one
 *             section is blocking".
 *
 * That result is the justification for this module existing. A per-section
 * checker passes 34 of 36 tests, catches the duplicate-id mistake people
 * actually make most often, and still leaves the audit's misattribution check
 * corruptible - because the collision it misses is the one the flat index
 * cannot survive. Only the two cross-section tests can tell the two designs
 * apart.
 *
 * The rule this confirms, for the second time in this package: the tests that
 * discriminate between a correct design and a plausible wrong one are almost
 * never the obvious ones. Here it is two tests out of thirty-six.
 */

/* --- The node kinds that landed on 2026-09-11 -------------------------
 *
 * `summary`, `achievements`, `certifications` and `projects[i].links` joined
 * `MasterProfile` on 2026-09-11. Every test below is about the same hazard, and
 * it is a SILENT one: this checker validates `unknown` and casts at the end, so
 * a walk that never learned the new kinds STILL COMPILES and still reports a
 * clean profile. Nothing fails; global uniqueness has just quietly become
 * uniqueness-over-the-kinds-someone-remembered.
 *
 * The cross-kind cases are the ones that matter. `node-id-uniqueness.ts:21`
 * records that a PER-SECTION checker passed 34 of 36 tests written against this
 * very path, and the only two it failed were cross-section collisions - so a
 * within-section duplicate cannot tell a correct implementation from the
 * plausible wrong one. These add the new kinds to that same shape. */

test('a summary id colliding with a bullet id is blocking', () => {
  const profile = validProfile();

  /* The summary is a single node rather than a section, so it is the kind most
     easily left out of a walk - there is no array to loop over and notice. */
  profile['summary'] = { id: 'exp-1-b1', text: 'A summary that stole a bullet id.' };

  const result = checkMasterProfile(profile);

  assert.equal(result.ok, false, JSON.stringify(result, null, 2));
  if (result.ok) return;

  /* Asserted on the MESSAGE naming both ends rather than on which end carries
     the finding's path, and that is deliberate. The walk visits `summary`
     before `experience`, so the finding lands on the experience bullet - the
     older node. Document order cannot say which end was added, so the contract
     worth testing is that both halves are visible, not that the checker guessed
     the culprit. */
  const finding = result.findings.find((f) => f.problem.includes('exp-1-b1'));
  assert.ok(finding !== undefined, 'expected the collision to name the shared id');
  assert.match(finding.problem, /summary/);
});

test('a project link id colliding with a skill id is blocking', () => {
  const profile = validProfile();

  /* Nested TWO levels deep, and it only exists at all because
     `MasterProject.url` - a scalar with no id - was replaced by a link array
     whose entries draw ids from the same global pool as every other node. A
     walk written before that change cannot see this collision. */
  (profile['projects'] as Record<string, unknown>[])[0]!['links'] = [
    { id: 'skill-1', label: 'Repo', url: 'https://example.invalid/r' },
  ];

  const result = checkMasterProfile(profile);

  assert.equal(result.ok, false, JSON.stringify(result, null, 2));
  if (result.ok) return;
  const finding = result.findings.find((f) => f.problem.includes('skill-1'));
  assert.ok(finding !== undefined, 'expected the collision to name the id');
  /* And it must name the other end, or the operator can only see half of a
     collision they have to fix in two places. */
  assert.match(finding.problem, /skills\[0\]/);
});

test('an achievement bullet id colliding with an experience bullet id is blocking', () => {
  const profile = validProfile();

  /* The second id-bearing place under a new node kind: the parent id is obvious
     because it is the thing being added, and the bullets underneath are what a
     walk forgets to descend into. */
  (profile['achievements'] as Record<string, unknown>[])[0]!['bullets'] = [
    { id: 'exp-1-b1', text: 'An achievement bullet with a stolen id', tags: ['award'] },
  ];

  const result = checkMasterProfile(profile);

  assert.equal(result.ok, false, JSON.stringify(result, null, 2));
  if (result.ok) return;
  const finding = result.findings.find((f) => f.path.startsWith('achievements[0].bullets[0]'));
  assert.ok(finding !== undefined, 'expected the finding on the copy, not the original');
  /* Bullet collisions get the longer explanation, because theirs is the one
     with the silent misattribution consequence. */
  assert.match(finding.problem, /misattributed|overwrites|wrong parent/i);
});

/* THE CRASH-SAFETY TESTS, and they guard the seam rather than a rule.
 *
 * Uniqueness is delegated to `findDuplicateNodeIds`, which takes a TYPED
 * profile and dereferences `profile.achievements` with no guard. It is only
 * reached when the structural walk has found nothing blocking. So a profile
 * that is valid in every other respect but missing one of the new fields is
 * exactly the input that would sail through the gate and throw inside the
 * package - turning "this paste has a problem" into a lost paste.
 *
 * These are the tests that fail the day someone adds a node kind to
 * `collectNodeIds` without adding it to this file's walk. */
for (const missing of ['achievements', 'certifications', 'summary'] as const) {
  test('an otherwise-valid profile missing ' + missing + ' is reported, never thrown', () => {
    const profile = validProfile();
    delete profile[missing];

    /* The no-throw assertion is the load-bearing one. */
    assert.doesNotThrow(() => checkMasterProfile(profile));

    const result = checkMasterProfile(profile);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(blockingPaths(result.findings).includes(missing));
  });
}

/* NON-VACUITY TWIN for the three above: the same fields PRESENT must be
 * accepted. Without this, a checker that rejected every profile would pass all
 * three. The happy path asserts it too, and it is restated here because these
 * are the tests that would be edited together. */
test('the new node kinds are accepted when present and well-formed', () => {
  const result = checkMasterProfile(validProfile());

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  if (!result.ok) return;
  assert.equal(result.summary.achievements, 1);
  assert.equal(result.summary.certifications, 1);
  assert.equal(result.summary.hasSummary, true);
});

/* A summary of `null` is the ORDINARY case - most resumes have no summary
 * paragraph - and must not be a finding. The field being ABSENT is a finding,
 * which is the distinction the contract draws by making it a required field
 * with a nullable value. */
test('a null summary is accepted, because most resumes have none', () => {
  const profile = validProfile();
  profile['summary'] = null;

  const result = checkMasterProfile(profile);

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  if (!result.ok) return;
  assert.equal(result.summary.hasSummary, false);
});

test('a blank achievement label is blocking, because it is printed verbatim', () => {
  const profile = validProfile();
  (profile['achievements'] as Record<string, unknown>[])[0]!['label'] = '   ';

  const result = checkMasterProfile(profile);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(blockingPaths(result.findings).includes('achievements[0].label'));
});

/* Top-level links used to be walked by a different inline block from
 * `identity.links`, and the two had already drifted: identity required `label`
 * and `url`, the top-level one checked neither. So a blank-labelled top-level
 * link was accepted and would render as an empty anchor. Both now go through
 * one function, and this is the case that was previously missed. */
test('a blank label on a TOP-LEVEL link is blocking, same as on an identity link', () => {
  const profile = validProfile();
  (profile['links'] as Record<string, unknown>[])[0]!['label'] = '';

  const result = checkMasterProfile(profile);

  assert.equal(result.ok, false, JSON.stringify(result, null, 2));
  if (result.ok) return;
  assert.ok(blockingPaths(result.findings).includes('links[0].label'));
});

/* THE TEST THAT ISOLATES THIS FILE'S PROJECT-LINK WALK, added after mutation
 * testing showed the collision test above could not.
 *
 * WHAT MUTATION TESTING REVEALED. Deleting the `projects[i].links` walk from
 * this module left "a project link id colliding with a skill id is blocking"
 * STILL PASSING - because `findDuplicateNodeIds` walks project links itself and
 * caught the collision on the way past. The test was named for a guard it could
 * not actually isolate; it was testing the composite of two defences, and the
 * package half was carrying it. That is `docs/verification-traps.md` instance 1
 * exactly, and it is the reason the mutation step exists rather than a green
 * suite being taken as proof.
 *
 * A BLANK LABEL is the input only this file can reject. The package's checker
 * compares ids to each other and has no opinion about a link's text, so there
 * is no second defence to hide behind - if this walk is gone, a project link
 * with no label is accepted and renders as an empty anchor on the resume. */
test('a blank label on a PROJECT link is blocking, which only this walk can catch', () => {
  const profile = validProfile();
  (profile['projects'] as Record<string, unknown>[])[0]!['links'] = [
    { id: 'proj-1-link-1', label: '   ', url: 'https://example.invalid/r' },
  ];

  const result = checkMasterProfile(profile);

  assert.equal(result.ok, false, JSON.stringify(result, null, 2));
  if (result.ok) return;
  assert.ok(blockingPaths(result.findings).includes('projects[0].links[0].label'));
});

/* NON-VACUITY TWIN: a well-formed project link must be ACCEPTED and counted.
 * Without this, a walk that rejected every project link would pass the test
 * above - and rejection-only tests cannot tell a correct guard from one that
 * refuses everything. */
test('a well-formed project link is accepted and counted among the links', () => {
  const result = checkMasterProfile(validProfile());

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  if (!result.ok) return;
  /* Three: one in identity.links, one in projects[0].links, one top-level. The
     project link is the middle term, and it is the one that was invisible to
     this checker until `MasterProject.url` became an array. */
  assert.equal(result.summary.links, 3);
});

/* A project whose `links` field is MISSING entirely is blocking, and this is
 * the other half of the crash-safety seam: `findDuplicateNodeIds` dereferences
 * `project.links` with no guard, so an unreported absence here becomes a
 * TypeError inside the package rather than a finding on screen. */
test('a project with no links array is reported, never thrown', () => {
  const profile = validProfile();
  delete (profile['projects'] as Record<string, unknown>[])[0]!['links'];

  assert.doesNotThrow(() => checkMasterProfile(profile));

  const result = checkMasterProfile(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(blockingPaths(result.findings).includes('projects[0].links'));
});

/* --- Absent nullable keys are stored as explicit nulls (2026-10-24) ---
 *
 * master_profiles v2 went in through this check with achievements that had NO
 * `description` key - not null, absent. `checkUndatedNode` rightly does not
 * require a description, but the accepted profile was the raw paste cast to
 * MasterProfile, so the hole was stored as-is. The Tailor copied it into a
 * tailored snapshot and the approval preview crashed on it; a degree with no
 * `field` key would instead have printed "BTech, undefined" onto a submitted PDF.
 * The contract types these fields `string | null` (a required key, a nullable
 * value), so the accepted profile must carry the key with null in it. */

/* Every nullable-VALUE field below the root, as [section or 'identity', key]. The
 * summary is NOT here: an absent summary is already a blocking finding (tests
 * above), because it is an id-bearing node rather than display text. */
const NULLABLE_FIELDS: ReadonlyArray<readonly [string, string]> = [
  /* The three optional identity lines. */
  ['identity', 'headline'],
  ['identity', 'phone'],
  ['identity', 'location'],
  /* A role's location: the 'ExampleCo, undefined' silent-print case. */
  ['experience', 'location'],
  /* Field of study and grade, both printed beside or under the degree. */
  ['education', 'field'],
  ['education', 'grade_display'],
  /* The undated entries' qualifying detail: the live v2 hole. */
  ['achievements', 'description'],
  ['certifications', 'description'],
];

/* The valid fixture with every one of those keys DELETED, the shape v2 has live. */
function profileWithoutNullableKeys(): Record<string, any> {
  /* Fresh copy per call, so the deletions cannot leak into another test. */
  const profile = validProfile() as Record<string, any>;
  /* Identity is one object; the four sections are arrays of nodes. */
  for (const [where, key] of NULLABLE_FIELDS) {
    /* One node for identity, every node of the section otherwise. */
    const nodes = where === 'identity' ? [profile.identity] : profile[where];
    /* Remove the key outright - absent, not null. */
    for (const node of nodes) delete node[key];
  }
  /* The holed profile, typed loosely because it now breaks the contract. */
  return profile;
}

test('a profile with absent nullable keys is accepted with every one stored as an explicit null', () => {
  /* The input under test. */
  const input = profileWithoutNullableKeys();
  /* Non-vacuity: the keys really are gone from the input. */
  assert.equal('description' in input['achievements'][0], false, 'the fixture still has the key; this test would be vacuous');
  /* An absent optional field is not a defect in the paste, so it is not refused. */
  const result = checkMasterProfile(input);
  /* Accepted, with the whole result printed if not. */
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  /* Narrows the union so the profile can be read. */
  if (!result.ok) return;
  /* The stored profile, read untyped so the check sees what JSON will see. */
  const stored = result.profile as unknown as Record<string, any>;
  for (const [where, key] of NULLABLE_FIELDS) {
    /* Same node selection as the builder above. */
    const nodes = where === 'identity' ? [stored['identity']] : stored[where];
    /* Every node of the section is checked, not just the first. */
    for (const node of nodes) {
      /* Present, because JSON.stringify drops an undefined key before the insert. */
      assert.equal(key in node, true, where + '.' + key + ' is missing from the accepted profile');
      /* And null, because absent means "this resume has none". */
      assert.equal(node[key], null, where + '.' + key + ' should be null');
    }
  }
});

/* NON-VACUITY TWIN: a PRESENT value must pass through untouched. Without this, a
 * normaliser that nulled every optional field would pass the test above and wipe
 * the operator's real headline, phone and grades from every stored master. */
test('a present nullable value is stored exactly as pasted, never nulled', () => {
  /* Real values in a representative pair of the fields. */
  const profile = validProfile() as Record<string, any>;
  profile['identity']['headline'] = 'Backend Engineer';
  profile['education'][0]['grade_display'] = 'CGPA 8.0 / 10';
  /* Accepted as before. */
  const result = checkMasterProfile(profile);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  if (!result.ok) return;
  /* Both values survive byte-for-byte; the existing description does too. */
  assert.equal(result.profile.identity.headline, 'Backend Engineer');
  assert.equal(result.profile.education[0]?.grade_display, 'CGPA 8.0 / 10');
  assert.equal(result.profile.certifications[0]?.description, 'Example Issuer');
});

/* The caller's object is the operator's parsed paste. Normalising must build a
 * copy, or a re-check of the same object would see a profile it never pasted. */
test('normalising absent keys never mutates the object that was passed in', () => {
  /* The input, with holes. */
  const input = profileWithoutNullableKeys();
  /* Checked once. */
  checkMasterProfile(input);
  /* Still absent on the caller's object afterwards. */
  assert.equal('description' in input['achievements'][0], false, 'checkMasterProfile wrote into its argument');
});

/* --- Certification and achievement links (optional, since d50775a) ---- */

/* The fixture's certification and achievement, with a links array set on one of them.
   Built from validProfile so every other section stays valid and only the links vary. */
function withEntryLinks(section: 'certifications' | 'achievements', links: unknown): Record<string, any> {
  // A fresh valid profile, so tests cannot leak into each other.
  const profile = validProfile() as Record<string, any>;
  // Only the first entry of the named section gains the key.
  profile[section][0].links = links;
  // The edited profile.
  return profile;
}

// Red-on-revert target: removing the walk makes this throw instead of report (measured).
test('a certification link is walked: a links value that is not an array is a finding, not a throw', () => {
  // Before the walk this reached findDuplicateNodeIds and threw "links.forEach is not a function".
  const result = checkMasterProfile(withEntryLinks('certifications', 'https://example.invalid/c'));
  // Refused, with the path that names the field.
  assert.equal(result.ok, false);
  // The finding sits on the links array itself.
  assert.ok(blockingPaths(result.findings).includes('certifications[0].links'));
});

// Red-on-revert target: only the walk checks label, url and id presence; the package does not.
test('an achievement link with a blank url or a blank id is refused', () => {
  // A blank url would render as an anchor to nowhere; a blank id can never be referenced.
  const result = checkMasterProfile(withEntryLinks('achievements', [{ id: '', label: 'Profile', url: '  ' }]));
  // Both problems reported on the one link.
  assert.deepEqual(blockingPaths(result.findings).sort(), ['achievements[0].links[0].id', 'achievements[0].links[0].url']);
});

// Regression pin, NOT red-on-revert for the walk: the package duplicate check also catches it.
test('a certification link id that collides with another node is refused', () => {
  // 'skill-1' is the fixture's skill id; one global id space covers entry links too.
  const result = checkMasterProfile(withEntryLinks('certifications', [{ id: 'skill-1', label: 'Credential', url: 'https://example.invalid/c' }]));
  // Refused, on the later occurrence.
  assert.ok(blockingPaths(result.findings).includes('certifications[0].links[0].id'));
});

// The accept path, the summary total, and the absent-key rule in one place.
test('valid entry links are accepted and counted; an absent links key stays absent', () => {
  // One link on the certification; the achievement keeps no links key, like every pre-v9 master.
  const result = checkMasterProfile(withEntryLinks('certifications', [{ id: 'cert-1-link-1', label: 'Credential', url: 'https://example.invalid/c' }]));
  // Accepted.
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  // Narrowing for the reads below.
  if (!result.ok) return;
  // Identity 1 + project 1 + top-level 1 + this 1.
  assert.equal(result.summary.links, 4);
  // Never filled in: the approval page compares rebuilt entries byte for byte.
  assert.equal('links' in result.profile.achievements[0]!, false);
});

