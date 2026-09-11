/* The fields a human review is rendered from.
 *
 * WHY THIS FILE IS SEPARATE FROM `reconcile.test.ts`. Those tests ask "did the
 * right id land on the right node" - the correctness of the reconciliation.
 * These ask "can a person actually review the decision that was made" - the
 * correctness of the REPORT. The second is not a lesser question: the
 * similarity threshold cannot be set safely in either direction, so the report
 * is the only real defence in the design, and a report a reviewer cannot act on
 * is the same as no defence at all.
 *
 * All three of the fields tested here were missing from the first shipped
 * version, and two of them were missing while a message claimed they were
 * present. Caught by the consumer reading the code rather than the claim.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  needsHumanReview,
  nonExactCarries,
  reconcileMasterProfile,
  reviewableRows,
} from '../src/index.ts';
import { bullet, experience, makeMinter, profileOf, project, reparse, STORED } from './fixtures/profiles.ts';

/* A bullet the length of a real one. The fixture bullets elsewhere are short
 * enough that an 80-character truncation would not have shown up. */
const LONG_PREVIOUS =
  'Developed backend services, REST APIs, event-driven workflows and AI orchestration pipelines using FastAPI, Node.js, PostgreSQL, Supabase, Docker and Google Cloud Platform.';
const LONG_INCOMING =
  'Built backend services, REST APIs, event-driven workflows and AI orchestration pipelines using FastAPI, Node.js, PostgreSQL, Supabase, Docker and Google Cloud Platform.';

describe('a fuzzy carry is reviewable on its own', () => {
  const previous = profileOf({
    experience: [
      experience('exp-northwind', 'Northwind Systems', 'Full Stack AI Engineer', [
        bullet('b-1', LONG_PREVIOUS),
      ]),
    ],
  });
  const incoming = reparse({
    ...previous,
    experience: [
      experience('exp-northwind', 'Northwind Systems', 'Full Stack AI Engineer', [
        bullet('throwaway', LONG_INCOMING),
      ]),
    ],
  });

  it('names the parent the bullet sits under', () => {
    /* THE FIELD THAT MATTERS MOST. Misattribution is a true bullet under the
       wrong parent, so a row a reviewer can confirm without seeing the parent
       cannot surface the only error that matters. */
    const result = reconcileMasterProfile({ previous, incoming, mintId: makeMinter('new') });
    const carry = nonExactCarries(result.report)[0];
    assert.equal(carry?.id, 'b-1');
    assert.equal(carry?.parentId, 'exp-northwind');
    /* Pre-rendered, so every consumer shows the same string rather than each
       inventing its own join of company and role. */
    assert.equal(carry?.parentLabel, 'Full Stack AI Engineer at Northwind Systems');
  });

  it('carries both texts in full, so the review needs no second lookup', () => {
    const result = reconcileMasterProfile({ previous, incoming, mintId: makeMinter('new') });
    const carry = nonExactCarries(result.report)[0];
    /* NOT TRUNCATED. An earlier version cut labels at 80 characters, which
       would have severed every real bullet mid-sentence - and a fuzzy carry is
       reviewed by reading these two strings against each other. */
    assert.equal(carry?.label, LONG_INCOMING);
    assert.equal(carry?.previousLabel, LONG_PREVIOUS);
    assert.ok(LONG_PREVIOUS.length > 80, 'the fixture must exceed any truncation limit');
    /* And they must actually differ, or the test would pass against a report
       that echoed the same string into both fields. */
    assert.notEqual(carry?.label, carry?.previousLabel);
  });

  it('reports a score alongside them rather than instead of them', () => {
    const result = reconcileMasterProfile({ previous, incoming, mintId: makeMinter('new') });
    const carry = nonExactCarries(result.report)[0];
    assert.ok((carry?.similarity ?? 0) > 0.9);
  });
});

describe('placement on nodes that have no parent', () => {
  /* TWIN to the parent tests: null must mean "has no parent", not "parent
     unknown". Without this, a report that left the fields null everywhere would
     pass nothing above and nothing here would notice. */
  /* A row is NESTED when its path steps through an index - `projects[0].links[0]`
     but not `identity.links[0]`, which is a root section that merely happens to
     live under a key. That string test is the same distinction the reconciler
     makes structurally, written in the one form a test can check without
     re-implementing the walk. */
  const isNested = (path: string): boolean => path.includes('].');

  it('is null for every section that sits at the root of the profile', () => {
    const result = reconcileMasterProfile({
      previous: STORED,
      incoming: reparse(STORED),
      mintId: makeMinter('new'),
    });
    const rootLevel = result.report.carried.filter(
      (entry) => entry.kind !== 'bullet' && !isNested(entry.path),
    );
    assert.ok(rootLevel.length > 0, 'the fixture must contain root-level nodes');
    for (const entry of rootLevel) {
      assert.equal(entry.parentId, null, entry.path + ' must have no parent');
      assert.equal(entry.parentLabel, null, entry.path + ' must have no parent label');
    }
    /* Naming the kinds explicitly, so a section that stopped being reconciled
       altogether could not pass this by simply not appearing. The summary is in
       the list because it is the one root node with no index in its path. */
    const kinds = [...new Set(rootLevel.map((entry) => entry.kind))].sort();
    assert.deepEqual(kinds, [
      'achievement',
      'certification',
      'education',
      'experience',
      'link',
      'project',
      'skill',
      'summary',
    ]);
  });

  /* THE COUNTERPART, ADDED 2026-09-11 WITH PROJECT LINKS. A project link is not a
     root node, and a row claiming `parentId: null` for it would assert "this has
     no parent" - which report.ts says is a different fact from "the parent is
     unknown", and in this case a false one. A link row is only reviewable beside
     the project it is claimed to belong to, exactly as a bullet row is only
     reviewable beside its employer. */
  it('names the owning project on every project-link row', () => {
    const result = reconcileMasterProfile({
      previous: STORED,
      incoming: reparse(STORED),
      mintId: makeMinter('new'),
    });
    const projectLinks = result.report.carried.filter(
      (entry) => entry.kind === 'link' && isNested(entry.path),
    );
    assert.equal(projectLinks.length, 3, 'two on the first project, one on the second');
    for (const entry of projectLinks) {
      assert.notEqual(entry.parentId, null, entry.path + ' must name its project');
    }
    const first = projectLinks.find((entry) => entry.path === 'projects[0].links[1]');
    assert.equal(first?.id, 'lnk-oo-repo');
    assert.equal(first?.parentId, 'prj-oneonone');
    /* Pre-rendered, so a consumer shows the same project name the diff shows. */
    assert.equal(first?.parentLabel, 'One-on-One - AI-Powered Learning Platform');
  });

  it('is populated on every bullet row, with no exceptions', () => {
    const result = reconcileMasterProfile({
      previous: STORED,
      incoming: reparse(STORED),
      mintId: makeMinter('new'),
    });
    const bullets = result.report.carried.filter((entry) => entry.kind === 'bullet');
    /* Eight, not seven: the achievement bullet joined the fixture on 2026-09-11.
       A bulleted ACHIEVEMENT is the descent a new kind forgets, and this count is
       where forgetting it shows up rather than passing silently. */
    assert.equal(bullets.length, 8, 'the fixture has eight bullets, one of them an achievement');
    assert.ok(
      bullets.some((entry) => entry.path === 'achievements[0].bullets[0]'),
      'the achievement bullet must be reconciled, not skipped',
    );
    for (const entry of bullets) {
      assert.notEqual(entry.parentId, null, entry.path + ' must name its parent');
      assert.ok(
        (entry.parentLabel ?? '').length > 0,
        entry.path + ' must carry a rendered parent label',
      );
    }
  });

  /* A project's tagline is reworded, so the project keeps its id while its
     label changes. That is the case where `previousLabel` earns its place on a
     non-bullet row too. */
  it('shows the previous label of a parent whose name changed but whose id carried', () => {
    const incoming = reparse({
      ...STORED,
      projects: STORED.projects.map((p) =>
        p.id !== 'prj-oneonone' ? p : { ...p, name: 'One-on-One - Mentorship Booking Platform' },
      ),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    const carry = result.report.carried.find((entry) => entry.id === 'prj-oneonone');
    assert.equal(carry?.label, 'One-on-One - Mentorship Booking Platform');
    assert.equal(carry?.previousLabel, 'One-on-One - AI-Powered Learning Platform');
  });
});

describe('dropped rows name the parent that went with them', () => {
  it('attributes every orphaned bullet to its deleted parent', () => {
    /* Four bullet drops all naming one parent read as ONE deletion. Four drops
       naming nothing read as four unexplained disappearances. */
    const incoming = reparse({
      ...STORED,
      projects: STORED.projects.filter((p) => p.id !== 'prj-racepace'),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    const droppedBullet = result.report.dropped.find((d) => d.id === 'b-rp-1');
    assert.equal(droppedBullet?.parentId, 'prj-racepace');
    assert.equal(droppedBullet?.parentLabel, 'Race Pace Predictor');
    /* The parent's own row has no parent of its own. */
    const droppedParent = result.report.dropped.find((d) => d.id === 'prj-racepace');
    assert.equal(droppedParent?.parentId, null);
  });
});

describe('reviewableRows - the gate the accept button uses', () => {
  it('is empty for a re-upload that changed nothing', () => {
    const result = reconcileMasterProfile({
      previous: STORED,
      incoming: reparse(STORED),
      mintId: makeMinter('new'),
    });
    assert.deepEqual(reviewableRows(result.report), []);
    assert.equal(needsHumanReview(result.report), false);
  });

  it('has exactly one row for one reworded bullet', () => {
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
    const rows = reviewableRows(
      reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') }).report,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.reviewKind, 'fuzzy_carry');
  });

  /* THE DOUBLE-COUNT GUARD. Every ambiguity appears in BOTH `minted` (reason
     `ambiguous`) and `ambiguous`, by design - but a gate must count one
     decision once, or a reviewer sees two problems where there is one and has
     to acknowledge the same refusal twice. */
  it('counts one ambiguity once, not twice', () => {
    const previous = profileOf({
      projects: [
        project('prj-1', 'Analyzer', [
          bullet('b-gamma', 'alpha beta gamma'),
          bullet('b-delta', 'alpha beta delta'),
        ]),
      ],
    });
    const incoming = reparse({
      ...previous,
      projects: [project('prj-1', 'Analyzer', [bullet('z', 'alpha beta')])],
    });
    const result = reconcileMasterProfile({ previous, incoming, mintId: makeMinter('new') });

    /* Both lists still describe it - that redundancy is deliberate. */
    assert.equal(result.report.ambiguous.length, 1);
    assert.equal(result.report.minted.filter((m) => m.reason === 'ambiguous').length, 1);
    /* But the GATE sees one row, and it is the rich one. */
    const rows = reviewableRows(result.report);
    const ambiguousRows = rows.filter((row) => row.reviewKind === 'ambiguous');
    const mintRows = rows.filter((row) => row.reviewKind === 'uncertain_mint');
    assert.equal(ambiguousRows.length, 1);
    assert.equal(mintRows.length, 0, 'the bare mint must not appear as a second row');
  });

  it('includes a near-miss mint, which is the reason a threshold can be wrong', () => {
    const previous = profileOf({
      projects: [project('prj-1', 'Analyzer', [bullet('b-1', 'cut p95 latency 40')])],
    });
    const incoming = reparse({
      ...previous,
      projects: [project('prj-1', 'Analyzer', [bullet('z', 'reduced p95 latency by 40')])],
    });
    const rows = reviewableRows(
      reconcileMasterProfile({
        previous,
        incoming,
        mintId: makeMinter('new'),
        /* Set high on purpose, so a genuine rewording lands as a mint. */
        similarityThreshold: 0.7,
      }).report,
    );
    const mintRow = rows.find((row) => row.reviewKind === 'uncertain_mint');
    assert.equal(mintRow?.reviewKind, 'uncertain_mint');
    assert.equal(
      mintRow?.reviewKind === 'uncertain_mint' ? mintRow.minted.reason : null,
      'below_threshold',
    );
  });

  /* A deliberate deletion still needs acknowledging, and that is the point. If
     the PDF parse silently loses a bullet, this is the only place it surfaces -
     so making Teja confirm the deletion he MEANT is the price of catching the
     one he did not. */
  it('includes every dropped node, even on a deliberate deletion', () => {
    const incoming = reparse({
      ...STORED,
      projects: STORED.projects.filter((p) => p.id !== 'prj-racepace'),
    });
    const result = reconcileMasterProfile({ previous: STORED, incoming, mintId: makeMinter('new') });
    const dropped = reviewableRows(result.report).filter((row) => row.reviewKind === 'dropped');
    assert.equal(dropped.length, 3, 'the project, its one bullet and its one link');
    assert.equal(needsHumanReview(result.report), true);
  });

  /* Keeps the boolean and the list from ever disagreeing, which is the reason
     one is derived from the other rather than computed twice. */
  it('agrees with needsHumanReview in both directions', () => {
    const clean = reconcileMasterProfile({
      previous: STORED,
      incoming: reparse(STORED),
      mintId: makeMinter('new'),
    });
    assert.equal(reviewableRows(clean.report).length, 0);
    assert.equal(needsHumanReview(clean.report), false);

    const dirty = reconcileMasterProfile({
      previous: STORED,
      incoming: reparse({
        ...STORED,
        projects: STORED.projects.filter((p) => p.id !== 'prj-racepace'),
      }),
      mintId: makeMinter('new'),
    });
    assert.ok(reviewableRows(dirty.report).length > 0);
    assert.equal(needsHumanReview(dirty.report), true);
  });
});
