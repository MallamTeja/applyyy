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
  noNodeIdentityChanges,
} from '../src/features/settings/masterReview.ts';
/* The package's own policy, imported so the drift test below compares this
   module against the real thing rather than against a number typed by hand. */
import { reviewableRows } from '@applyy/master-ingest';
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

/* --- The review POLICY lives in the package, not here ------------------
 *
 * These were added on 2026-09-11 with the change that deleted this module's
 * second copy of it. `buildMasterReview` used to keep its own
 * `MINT_REASONS_NEEDING_REVIEW = ['below_threshold', 'candidate_taken']` - a
 * literal duplicate of `REVIEWABLE_MINT_REASONS` in `report.ts` - and rebuilt
 * the risky-row set by hand from the four report arrays. `report.ts:288` says
 * the policy lives there and nowhere else, because two implementations "will
 * disagree about the only question that matters".
 *
 * They agreed. That is exactly what made it dangerous: nothing connected them,
 * so agreement was a coincidence that the first upstream policy change would
 * have ended, silently, with this screen quietly dropping a row nobody was then
 * asked about.
 *
 * THE TEST THAT ACTUALLY CATCHES DRIFT is the last one: it asserts this
 * module's row count against `reviewableRows()` itself rather than against a
 * number written by hand. A hand-written number is a second copy of the policy
 * in the test file, which is the same defect one layer out - and
 * `docs/verification-traps.md` records precisely that failure, where an
 * occurrence-count assertion passed because it counted the walk's own output. */

test('a mint reason the policy does not flag is collapsed, not shown', () => {
  /* `no_candidate` is genuinely new content with no counterpart. Asking for an
     acknowledgement on it buries the reasons that matter in noise, and a
     reviewer shown too much stops reading. */
  const review = buildMasterReview(report({ minted: [minted({ reason: 'no_candidate' })] }));

  assert.equal(review.rows.length, 0);
  assert.equal(review.plainlyNew.length, 1);
});

/* THE TWIN. Same shape, a reason the policy DOES flag - so a `buildMasterReview`
 * that collapsed everything would pass the test above and fail this one. */
test('a mint reason the policy flags reaches the human', () => {
  const review = buildMasterReview(
    report({ minted: [minted({ reason: 'below_threshold', bestScore: 0.61 })] }),
  );

  assert.equal(review.rows.length, 1);
  assert.equal(review.rows[0]?.cause, 'uncertain_mint');
  /* And it is NOT also counted as plainly new, or one node would be described
     twice - once as needing a look and once as nothing to worry about. */
  assert.equal(review.plainlyNew.length, 0);
});

test('a fuzzy carry is shown and is NOT counted among the settled', () => {
  const review = buildMasterReview(
    report({
      carried: [
        carried({ id: 'b1', match: 'exact_text' }),
        carried({ id: 'b2', match: 'fuzzy_text', similarity: 0.71, previousLabel: 'Old text' }),
      ],
    }),
  );

  /* The fuzzy one is on screen... */
  assert.equal(review.rows.length, 1);
  assert.equal(review.rows[0]?.cause, 'fuzzy_carry');
  /* ...and the collapsed list is its exact complement. A row that appeared in
     both would be shown as risky and counted as safe in the same breath. */
  assert.deepEqual(
    review.settled.map((entry) => entry.id),
    ['b1'],
  );
});

test('the rows this module shows are exactly the rows the package calls reviewable', () => {
  /* One of every kind, so no single-variant implementation can pass by
     accident. */
  const full = report({
    carried: [
      carried({ id: 'c-exact', match: 'exact_key' }),
      carried({ id: 'c-fuzzy', match: 'fuzzy_text', similarity: 0.7 }),
    ],
    minted: [
      minted({ id: 'm-plain', reason: 'no_candidate' }),
      minted({ id: 'm-near', reason: 'below_threshold', bestScore: 0.6 }),
      minted({ id: 'm-taken', reason: 'candidate_taken', bestScore: 0.8 }),
      /* Present in BOTH arrays by design - the package puts every ambiguity in
         `minted` too - and it must produce exactly ONE row, the richer one. */
      minted({ id: 'm-amb', reason: 'ambiguous' }),
    ],
    dropped: [dropped({ id: 'd1' })],
    ambiguous: [ambiguous()],
  });

  /* Derived from the package, never hand-counted. If `report.ts` widens or
     narrows its policy, THIS is the assertion that notices - which is the whole
     reason the duplicate was deleted. */
  assert.equal(buildMasterReview(full).rows.length, reviewableRows(full).length);
});

/* --- "Nothing moved" is not the same question as "nothing changed" ----- */

test('a re-upload where every node kept its id reports no identity changes', () => {
  const review = buildMasterReview(
    report({ carried: [carried({ match: 'exact_key' }), carried({ id: 'b2', match: 'exact_text' })] }),
  );

  assert.equal(noNodeIdentityChanges(review), true);
});

/* THE TWIN THAT MAKES IT MEAN SOMETHING, and the case `isCleanReview` gets
 * right for a different question. A brand-new bullet with no counterpart needs
 * no ACKNOWLEDGEMENT - so there are zero rows and the review is "clean" - but a
 * node id has still appeared that did not exist before. Telling Teja "nothing
 * moved" there would be false.
 *
 * A `noNodeIdentityChanges` that just returned `rows.length === 0` would pass
 * the test above and fail this one, which is exactly why the two predicates are
 * separate functions rather than one. */
test('a plainly-new node means identity DID change, even with nothing to review', () => {
  const review = buildMasterReview(report({ minted: [minted({ reason: 'no_candidate' })] }));

  /* Nothing to acknowledge... */
  assert.equal(isCleanReview(review), true);
  /* ...but something is genuinely new, so the quiet wording must not be used. */
  assert.equal(noNodeIdentityChanges(review), false);
});

test('a dropped node means identity changed', () => {
  const review = buildMasterReview(report({ dropped: [dropped()] }));

  assert.equal(noNodeIdentityChanges(review), false);
});
