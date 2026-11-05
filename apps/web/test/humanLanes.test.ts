/* Tests for the console's own coverage self-audit.
 *
 * WHY THIS FILE DID NOT EXIST UNTIL NOW, and it is a lesson worth recording:
 * `humanLanes.ts` imported `./contract` without the `.ts` extension. Types are
 * stripped, so tsc and Vite were both happy - but `STATUS_TRANSITIONS` is a
 * VALUE import, and `node --test` runs these sources directly, where Node's ESM
 * resolver requires the extension. Every attempt to import the module from a
 * test died with ERR_MODULE_NOT_FOUND. So the one module whose entire job is to
 * catch a silent gap was itself UNTESTABLE, silently, while every other guard
 * in `src/data` had a dozen tests. A module you cannot import is a module
 * nobody notices is unverified.
 *
 * WHAT THESE PROTECT. That the coverage report stays a PARTITION of the status
 * graph rather than a claim. The defect being guarded against is specific and
 * already happened once: the old single list came back empty and the page said
 * "every human-reachable transition has a screen that offers it", while four of
 * the claimed screens did not exist and no control in the console could perform
 * any transition at all. A false all-clear is worse than no check, because a
 * missing check prompts somebody to look and a green one tells them not to.
 *
 * RUN: `pnpm --filter @applyy/web test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HUMAN_FALLBACK_LANES,
  HUMAN_ONLY_LANES,
  HUMAN_REACHABLE_LANES,
  INOPERABLE_HUMAN_CONTROLS,
  MISSING_HUMAN_CONTROLS,
  OPERABLE_HUMAN_CONTROLS,
  UNBUILT_HUMAN_CONTROLS,
  controlReadiness,
  heldReason,
  humanControlLocation,
  isHumanOnlyLane,
} from '../src/data/humanLanes.ts';
import { STATUS_TRANSITIONS } from '../src/data/contract.ts';

/* An edge as a comparable string, so set arithmetic below reads plainly. */
function key(transition: { from: string; to: string }): string {
  return transition.from + '->' + transition.to;
}

/* --- The two lane sets are genuinely different ----------------------- */

test('human-only is a strict subset of human-reachable', () => {
  /* THE BUG THIS FILE'S SUBJECT WAS REWRITTEN TO FIX. An earlier version
     conflated `allowedAgents === ['human']` with `.includes('human')` and
     produced a false all-clear. If these two sets were ever equal again, the
     conflation would be back. */
  const reachable = new Set(HUMAN_REACHABLE_LANES.map(key));
  for (const lane of HUMAN_ONLY_LANES) {
    assert.ok(reachable.has(key(lane)), key(lane) + ' must be reachable too');
  }
  assert.ok(
    HUMAN_ONLY_LANES.length < HUMAN_REACHABLE_LANES.length,
    'the two predicates must not select the same set',
  );
});

test('every human-only lane really has exactly one allowed agent', () => {
  for (const lane of HUMAN_ONLY_LANES) {
    assert.deepEqual([...lane.allowedAgents], ['human']);
  }
});

test('every human-reachable lane really permits a human', () => {
  /* The accept side: the filter must not be selecting on something else that
     happens to correlate. */
  for (const lane of HUMAN_REACHABLE_LANES) {
    assert.ok(lane.allowedAgents.includes('human'), key(lane));
  }
});

test('lanes an agent can also traverse are excluded from human-only', () => {
  /* Non-vacuity for the human-only filter: there must BE fallback lanes, or
     `HUMAN_ONLY_LANES` is just a copy of the reachable set under a different
     name. */
  assert.ok(HUMAN_FALLBACK_LANES.length > 0);
  for (const lane of HUMAN_FALLBACK_LANES) {
    assert.ok(lane.allowedAgents.length > 1, key(lane));
    assert.equal(isHumanOnlyLane(lane.from, lane.to), false);
  }
});

test('the two sets partition the human-reachable lanes', () => {
  /* Derived as a difference, so they cannot drift apart - asserted here so a
     future refactor that recomputes them independently is caught. */
  assert.equal(
    HUMAN_ONLY_LANES.length + HUMAN_FALLBACK_LANES.length,
    HUMAN_REACHABLE_LANES.length,
  );
});

test('the lane sets are derived from the graph, not transcribed', () => {
  /* Every lane must be an edge that actually exists upstream. Transcribing
     edges by hand is what produced the original bug. */
  const graph = new Set(STATUS_TRANSITIONS.map(key));
  for (const lane of HUMAN_REACHABLE_LANES) {
    assert.ok(graph.has(key(lane)), key(lane) + ' is not in STATUS_TRANSITIONS');
  }
});

/* --- The coverage report is a partition, not a claim ----------------- */

test('the four coverage buckets partition the human-reachable lanes exactly', () => {
  /* THE LOAD-BEARING ASSERTION OF THIS FILE. It is what makes the numbers on
     the panel auditable: if they stopped summing to the graph's own total, some
     edge would be falling out of the report entirely - which is precisely how
     the previous version managed to show zero gaps while eight edges had no
     screen behind them. */
  const total =
    MISSING_HUMAN_CONTROLS.length +
    UNBUILT_HUMAN_CONTROLS.length +
    INOPERABLE_HUMAN_CONTROLS.length +
    OPERABLE_HUMAN_CONTROLS.length;
  assert.equal(total, HUMAN_REACHABLE_LANES.length);
});

test('no edge appears in two coverage buckets', () => {
  /* Summing to the right total is necessary but not sufficient - a double count
     plus an omission would also sum correctly. */
  const seen = new Set<string>();
  for (const bucket of [
    MISSING_HUMAN_CONTROLS,
    UNBUILT_HUMAN_CONTROLS,
    INOPERABLE_HUMAN_CONTROLS,
    OPERABLE_HUMAN_CONTROLS,
  ]) {
    for (const lane of bucket) {
      assert.ok(!seen.has(key(lane)), key(lane) + ' is counted twice');
      seen.add(key(lane));
    }
  }
  assert.equal(seen.size, HUMAN_REACHABLE_LANES.length);
});

test('an unclaimed status and an unbuilt screen are not the same bucket', () => {
  /* Different defects with different owners. Merging them is how one of them
     stops being fixed: an unclaimed status needs a decision about WHERE the
     control lives, an unbuilt screen needs the screen written. */
  const missing = new Set(MISSING_HUMAN_CONTROLS.map(key));
  for (const lane of UNBUILT_HUMAN_CONTROLS) {
    assert.ok(!missing.has(key(lane)));
    /* And the distinguishing fact: an unbuilt edge's status IS claimed. */
    assert.notEqual(humanControlLocation(lane.from), null);
    assert.equal(controlReadiness(lane.from), 'not_built');
  }
});

test('the recovery statuses and the approval gate are operable; audit_flagged is not', () => {
  /* The write path landed (Approval queue 2026-10-08, recovery queues 2026-10-09). The old tripwire
     here asserted "nothing is operable" and was meant to fail when this happened; this is its
     replacement, pinning the new truth status by status so an over-claim fails by name. */
  assert.equal(UNBUILT_HUMAN_CONTROLS.length, 0);
  // Every queue that now sends advance_application_status as 'human'.
  for (const status of ['awaiting_approval', 'applying', 'needs_verification', 'blocked_needs_human', 'failed'] as const) {
    // Readiness is the claim the panel counts.
    assert.equal(controlReadiness(status), 'operable', status);
    // And an operable status must have a named place to perform the move.
    assert.notEqual(humanControlLocation(status), null, status);
  }
  /* No screen sends audit_flagged -> tailored yet; claiming it would be the false all-clear this
     module exists to prevent. */
  assert.equal(controlReadiness('audit_flagged'), 'affordance_only');
});

test('heldReason holds needs_verification -> approved and nothing else out of needs_verification', () => {
  /* -> approved re-arms a real submission under automatic sending, so it must answer with a reason. */
  assert.notEqual(heldReason('needs_verification', 'approved'), null);
  /* The accept twin: an exact-edge match, so the safe sibling move from the same source still fires.
     A heldReason that matched by source alone would kill both. */
  assert.equal(heldReason('needs_verification', 'applied'), null);
});

test('OPERABLE_HUMAN_CONTROLS is exactly the edges the approval and recovery queues send', () => {
  /* Listed, not just counted: a count can stay right while one edge swaps for another. The list is
     read from the graph as of 2026-10-09; a new human edge out of an operable status lands here and
     must be added on purpose, which is the review this test forces. */
  const expected = [
    'awaiting_approval->approved',
    'awaiting_approval->dropped_filter',
    'applying->needs_verification',
    'needs_verification->applied',
    'needs_verification->failed',
    'blocked_needs_human->applied',
    'blocked_needs_human->dropped_filter',
    'blocked_needs_human->failed',
    'failed->needs_verification',
    // 2026-10-31: job-link-intake re-adds a dropped job when its link is pasted.
    'dropped_filter->passed_filters',
    // 2026-11-01: Reject on every Ready to tailor card (DiscoveredJobsPage, rejectJob.ts).
    'passed_filters->dropped_filter',
    // 2026-11-05: Mark applied / Failed on every Manual apply kit card (migration 20261105121500).
    'approved->applied',
    'approved->failed',
    // 2026-11-05: Add to Applied on the Emails page, through track_email_as_applied only (RPC_ONLY_HUMAN_EDGES).
    'discovered->applied',
  ];
  // Sorted on both sides so order in the graph does not matter, only membership.
  assert.deepEqual(OPERABLE_HUMAN_CONTROLS.map(key).sort(), [...expected].sort());
  // Stated as a number too, because the panel shows the number.
  assert.equal(OPERABLE_HUMAN_CONTROLS.length, 14);
});

test('passed_filters is operable for Reject only; its -> failed move is held, not claimed', () => {
  // The Discovered page's Reject performs this edge, so the status is claimed operable.
  assert.equal(controlReadiness('passed_filters'), 'operable');
  // Named for the screen that has the button, since this string is rendered on the Pipeline board.
  assert.equal(humanControlLocation('passed_filters'), 'Discovered jobs, Reject on the Ready to tailor card');
  // Readiness is per source status, so the sibling edge no button performs must be held...
  assert.notEqual(heldReason('passed_filters', 'failed'), null);
  // ...and counted inoperable, never operable: the over-claim this file exists to prevent.
  assert.ok(INOPERABLE_HUMAN_CONTROLS.map(key).includes('passed_filters->failed'));
  // The accept twin: an exact-edge hold, so Reject's own edge still fires.
  assert.equal(heldReason('passed_filters', 'dropped_filter'), null);
});

test('the held edge is counted inoperable and never operable', () => {
  /* A held edge sits on an operable screen, so a filter on readiness alone would count it operable -
     the over-claim HELD_HUMAN_EDGES exists to prevent. */
  const held = 'needs_verification->approved';
  // Shown and disabled: the inoperable bucket's definition.
  assert.ok(INOPERABLE_HUMAN_CONTROLS.map(key).includes(held));
  // And therefore not in the operable count.
  assert.ok(!OPERABLE_HUMAN_CONTROLS.map(key).includes(held));
});

test('every human-reachable status is either unclaimed or has a readiness', () => {
  /* The two accessors must agree: a claimed status has both a screen name and a
     readiness, an unclaimed one has neither. A status with one and not the
     other would drop out of the partition. */
  for (const lane of HUMAN_REACHABLE_LANES) {
    const screen = humanControlLocation(lane.from);
    const readiness = controlReadiness(lane.from);
    assert.equal(
      screen === null,
      readiness === null,
      key(lane) + ': screen and readiness must be present or absent together',
    );
  }
});

test('a status nothing claims returns null rather than a placeholder string', () => {
  /* The accept twin for `humanControlLocation`: it must be capable of returning
     null, or the "no screen claims it" bucket could never be non-empty and the
     check would be structurally incapable of firing. `audit_clean` is the
     probe - it is reached and left only by the Auditor, so no human-reachable
     edge leaves it and no screen claims it. (`approved` was the probe until
     2026-11-01, when approved -> passed_filters gave it a human move.) */
  assert.equal(humanControlLocation('audit_clean'), null);
  assert.equal(controlReadiness('audit_clean'), null);
});

test('the master-change re-run edges are claimed but never counted operable', () => {
  /* Both moves were added 2026-11-01 (migration 20261101173000) and no screen
     performs either yet. Both are HELD because their screens ARE operable for
     other moves: the Approval queue approves and declines, and since 2026-11-05
     the Manual apply kit card marks `approved` rows applied or failed. Counting
     either re-run as operable would be the false all-clear this file exists to prevent. */
  assert.equal(controlReadiness('approved'), 'operable');
  // The approved re-run explains itself like the awaiting_approval one.
  assert.notEqual(heldReason('approved', 'passed_filters'), null);
  // A held edge always explains itself; null here would let the button fire.
  assert.notEqual(heldReason('awaiting_approval', 'passed_filters'), null);
  // Neither re-run edge may appear in the operable bucket.
  const operable = new Set(OPERABLE_HUMAN_CONTROLS.map(key));
  assert.ok(!operable.has(key({ from: 'awaiting_approval', to: 'passed_filters' })));
  assert.ok(!operable.has(key({ from: 'approved', to: 'passed_filters' })));
  // 2026-11-02: the pre-approval re-run out of failed is held the same way; the SQL guard is the control.
  assert.notEqual(heldReason('failed', 'passed_filters'), null);
  // And never counted operable, even though the failed queue itself is.
  assert.ok(!operable.has(key({ from: 'failed', to: 'passed_filters' })));
});

/* --- isHumanOnlyLane -------------------------------------------------- */

test('isHumanOnlyLane accepts a real human-only edge and rejects a fabricated one', () => {
  /* `awaiting_approval -> approved` is THE gate: human-only, and one of only
     two edges into `approved`. */
  assert.equal(isHumanOnlyLane('awaiting_approval', 'approved'), true);
  /* And a pair that is not an edge at all must be false rather than throwing -
     the pipeline board asks this question for every column and every target. */
  assert.equal(isHumanOnlyLane('approved', 'awaiting_approval'), false);
});
