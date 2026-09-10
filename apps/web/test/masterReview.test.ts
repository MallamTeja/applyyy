/* Tests for the master-profile review model.
 *
 * WHAT THESE PROTECT. This module decides what a human is shown before a
 * re-uploaded resume becomes ground truth. The reconciler's similarity
 * threshold provably cannot separate true pairs from false ones - the same
 * bullet reworded scores 0.667 while two different bullets score 0.75 - so
 * this list is the only defence against a mis-carried id. Every test below is
 * about something silently vanishing from it.
 *
 * THE FAILURE MODE THEY ALL CIRCLE. Anything that quietly shrinks this list
 * looks like an improvement: fewer rows, a cleaner screen, a faster accept.
 * There is no failing build and no error when it goes wrong - just a resume
 * that claims a true achievement under the wrong employer, which is the
 * `misattributed_bullet` case the whole package exists to prevent.
 *
 * RUN: `pnpm --filter @applyy/web test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMasterReview,
  isCleanReview,
  looksLikeReflow,
} from '../src/features/settings/masterReview.ts';
import type {
  AmbiguousMatch,
  CarriedNode,
  DroppedNode,
  MintedNode,
  ReconciliationReport,
} from '@applyy/master-ingest';

/* --- Builders --------------------------------------------------------- */

/* Partial-with-defaults builders, so each test states only the field it is
   about. A test that spells out eight irrelevant fields hides which one is
   load-bearing. */
function carried(over: Partial<CarriedNode> = {}): CarriedNode {
  return {
    kind: 'bullet',
    id: 'b1',
    supersededId: 'tmp1',
    path: 'experience[0].bullets[0]',
    match: 'exact_text',
    similarity: null,
    label: 'Shipped the thing',
    previousLabel: 'Shipped the thing',
    parentId: 'e1',
    parentLabel: 'Backend Engineer at Northwind',
    ...over,
  };
}

function minted(over: Partial<MintedNode> = {}): MintedNode {
  return {
    kind: 'bullet',
    id: 'b9',
    path: 'experience[0].bullets[9]',
    reason: 'no_candidate',
    label: 'Something new',
    bestScore: null,
    parentId: 'e1',
    parentLabel: 'Backend Engineer at Northwind',
    ...over,
  };
}

function dropped(over: Partial<DroppedNode> = {}): DroppedNode {
  return {
    kind: 'bullet',
    id: 'b5',
    previousPath: 'projects[1].bullets[0]',
    label: 'A bullet that is gone',
    parentId: 'p1',
    parentLabel: 'Ledger',
    ...over,
  };
}

function ambiguous(over: Partial<AmbiguousMatch> = {}): AmbiguousMatch {
  return {
    kind: 'bullet',
    reason: 'tied_similarity',
    parentId: 'e1',
    parentLabel: 'Backend Engineer at Northwind',
    path: 'experience[0].bullets[3]',
    candidateIds: ['b2', 'b3'],
    score: 0.8,
    detail: 'Two previous bullets scored identically, so neither id was carried.',
    ...over,
  };
}

function report(over: Partial<ReconciliationReport> = {}): ReconciliationReport {
  return { carried: [], minted: [], dropped: [], ambiguous: [], ...over };
}

/* --- Line reflow ------------------------------------------------------ */

test('a hyphen broken across a line is not a change', () => {
  /* The LaTeX case: the document reflowed, the sentence did not change. */
  assert.equal(looksLikeReflow('Used Post-\ngreSQL daily', 'Used PostgreSQL daily'), true);
});

test('a real hyphenated word is not treated as a line break', () => {
  /* "state-of-the-art" has letters on both sides of every hyphen, so folding
     must leave it alone - otherwise it would compare equal to "state of the
     art", and two genuinely different texts would be called reflow. */
  assert.equal(looksLikeReflow('state-of-the-art tooling', 'state of the art tooling'), false);
});

test('reflow folding does not make different sentences look the same', () => {
  /* The guard that matters: if this ever returns true, a real edit gets
     labelled "probably just the document reflowing" and waved past. */
  assert.equal(looksLikeReflow('Built the auth service', 'Built the billing service'), false);
});

test('whitespace and case differences alone count as reflow', () => {
  assert.equal(looksLikeReflow('Cut  p95\nlatency', 'cut p95 latency'), true);
});

/* --- What reaches the human ------------------------------------------ */

test('an exact carry needs no review and is filed as settled', () => {
  const review = buildMasterReview(report({ carried: [carried({ match: 'exact_text' })] }));
  assert.equal(review.rows.length, 0);
  assert.equal(review.settled.length, 1);
  assert.equal(isCleanReview(review), true);
});

test('a fuzzy carry always reaches the human', () => {
  /* The reconciler DECIDED this one by score, and the score provably cannot
     be trusted, so it can never be auto-accepted. */
  const review = buildMasterReview(
    report({ carried: [carried({ match: 'fuzzy_text', similarity: 0.72 })] }),
  );
  assert.equal(review.rows.length, 1);
  assert.equal(review.rows[0]?.cause, 'fuzzy_carry');
  assert.equal(review.rows[0]?.similarity, 0.72);
  assert.equal(isCleanReview(review), false);
});

test('a fuzzy carry carries the previous text so the pair can be compared', () => {
  /* A score with only one side of the comparison is a number to nod at. */
  const review = buildMasterReview(
    report({
      carried: [
        carried({
          match: 'fuzzy_text',
          previousLabel: 'Reduced p95 latency by 40%',
          label: 'Cut p95 latency 40%',
        }),
      ],
    }),
  );
  assert.equal(review.rows[0]?.previousLabel, 'Reduced p95 latency by 40%');
  assert.equal(review.rows[0]?.label, 'Cut p95 latency 40%');
});

test('every review row keeps the parent it sits under', () => {
  /* THE MISATTRIBUTION GUARD. A bullet row without its employer cannot show
     the one error that matters: a true bullet under the wrong job. */
  const review = buildMasterReview(
    report({
      carried: [carried({ match: 'fuzzy_text', parentLabel: 'Backend Engineer at Northwind' })],
      dropped: [dropped({ parentLabel: 'Ledger' })],
      ambiguous: [ambiguous({ parentLabel: 'Backend Engineer at Northwind' })],
      minted: [minted({ reason: 'below_threshold', parentLabel: 'Helios' })],
    }),
  );
  for (const row of review.rows) {
    assert.notEqual(row.parentLabel, null, row.cause + ' lost its parent');
  }
});

test('a reflowed fuzzy carry is explained rather than shown as a bare change', () => {
  const review = buildMasterReview(
    report({
      carried: [
        carried({
          match: 'fuzzy_text',
          previousLabel: 'Used Post-\ngreSQL daily',
          label: 'Used PostgreSQL daily',
        }),
      ],
    }),
  );
  /* Still reviewed - it is not filtered out. It just does not lie about why
     it is there, which is what stops him learning the diff is noisy. */
  assert.equal(review.rows.length, 1);
  assert.equal(review.rows[0]?.reflowSuspected, true);
  assert.match(review.rows[0]?.detail ?? '', /reflow/i);
});

/* --- Drops ------------------------------------------------------------ */

test('every dropped node is listed individually, never summarised', () => {
  /* A dropped id is a dangling reference from an application already sent.
     Five rows for a project with four bullets, not one row saying "project
     removed" and leaving him to work out which references broke. */
  const review = buildMasterReview(
    report({
      dropped: [
        dropped({ id: 'p1', kind: 'project', label: 'Ledger', parentLabel: null }),
        dropped({ id: 'b1' }),
        dropped({ id: 'b2' }),
        dropped({ id: 'b3' }),
        dropped({ id: 'b4' }),
      ],
    }),
  );
  assert.equal(review.rows.filter((r) => r.cause === 'dropped').length, 5);
});

test('a drop explains the consequence rather than naming the event', () => {
  const review = buildMasterReview(report({ dropped: [dropped()] }));
  /* "Removed" sounds like tidying. The fact that matters is that older
     applications still point at it. */
  assert.match(review.rows[0]?.detail ?? '', /still reference/i);
});

/* --- Ambiguity is not double-reported -------------------------------- */

test('an ambiguity appears once, not twice', () => {
  /* The report lists every ambiguity in BOTH `ambiguous` and `minted`, by
     design. Rendering both would put one node on screen twice - once with the
     candidate ids and an explanation, once bare - which reads as two separate
     problems and makes the review list overstate the damage. */
  const review = buildMasterReview(
    report({
      ambiguous: [ambiguous({ path: 'experience[0].bullets[3]' })],
      minted: [minted({ id: 'b7', reason: 'ambiguous' })],
    }),
  );
  assert.equal(review.rows.length, 1);
  assert.equal(review.rows[0]?.cause, 'ambiguous');
  /* And it must not leak into the "nothing to check" bucket either. */
  assert.equal(review.plainlyNew.length, 0);
});

/* --- Mints ------------------------------------------------------------ */

test('an unsurprising mint does not interrupt anyone', () => {
  /* First upload, a new parent, or nothing remotely similar: there is no
     judgement here to second-guess. */
  for (const reason of ['no_previous_profile', 'new_parent', 'no_candidate'] as const) {
    const review = buildMasterReview(report({ minted: [minted({ reason })] }));
    assert.equal(review.rows.length, 0, reason + ' should not need review');
    assert.equal(review.plainlyNew.length, 1, reason + ' should be filed as plainly new');
  }
});

test('a near-miss mint reaches the human and keeps its score', () => {
  /* `below_threshold` with a score of 0.58 means "probably a rewording I
     could not see" - if it is, the original will look dropped and this will
     look new, which is two wrong rows from one missed match. */
  const review = buildMasterReview(
    report({ minted: [minted({ reason: 'below_threshold', bestScore: 0.58 })] }),
  );
  assert.equal(review.rows.length, 1);
  assert.equal(review.rows[0]?.cause, 'uncertain_mint');
  assert.equal(review.rows[0]?.similarity, 0.58);
});

test('a mint that lost a contest reaches the human', () => {
  const review = buildMasterReview(
    report({ minted: [minted({ reason: 'candidate_taken', bestScore: 0.81 })] }),
  );
  assert.equal(review.rows[0]?.cause, 'uncertain_mint');
});

/* --- Reading order ---------------------------------------------------- */

test('rows are ordered by risk, not by source order', () => {
  /* Ambiguity first because the reconciler refused outright; fuzzy carries
     next because those are decisions it MADE and could have made wrongly.
     Built here in deliberately the wrong order to prove the sort runs. */
  const review = buildMasterReview(
    report({
      minted: [minted({ reason: 'below_threshold' })],
      dropped: [dropped()],
      carried: [carried({ match: 'fuzzy_text' })],
      ambiguous: [ambiguous()],
    }),
  );
  assert.deepEqual(
    review.rows.map((r) => r.cause),
    ['ambiguous', 'fuzzy_carry', 'dropped', 'uncertain_mint'],
  );
});

/* --- The clean case --------------------------------------------------- */

test('a re-upload of an unchanged resume needs no review at all', () => {
  /* The five-second glance. Everything matched exactly, so there is nothing
     for a person to do and the screen must not invent something. */
  const review = buildMasterReview(
    report({
      carried: [
        carried({ id: 'b1', match: 'exact_text' }),
        carried({ id: 's1', kind: 'skill', match: 'exact_key', parentLabel: null }),
      ],
    }),
  );
  assert.equal(isCleanReview(review), true);
  assert.equal(review.settled.length, 2);
});

test('isCleanReview agrees with what the screen actually lists', () => {
  /* Derived from rows rather than recomputed from the report, so it cannot
     say "clean" while four rows are on screen. */
  const review = buildMasterReview(report({ dropped: [dropped()] }));
  assert.equal(isCleanReview(review), review.rows.length === 0);
  assert.equal(isCleanReview(review), false);
});
