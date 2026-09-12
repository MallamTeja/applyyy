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

test('every claimed status has a screen with affordance controls', () => {
  /* All submit-boundary and human recovery queues (applying, needs_verification,
     blocked_needs_human, failed) now have operator recovery panels on System health.
     UNBUILT_HUMAN_CONTROLS is now zero, meaning no status is invisible to the operator. */
  assert.equal(UNBUILT_HUMAN_CONTROLS.length, 0);
  for (const status of ['applying', 'needs_verification', 'blocked_needs_human', 'failed'] as const) {
    assert.equal(controlReadiness(status), 'affordance_only');
    assert.notEqual(humanControlLocation(status), null);
  }
});

test('nothing is operable yet, and that is asserted rather than assumed', () => {
  /* No screen in this console writes to `applications`, deliberately: the write
     path IS the submit gate, because `awaiting_approval -> approved` is
     human-only and one of only two edges into `approved` (constraint #15). So
     it gets built and reviewed on purpose rather than as a side effect of
     wiring a table.
     WHEN THAT LANDS, THIS TEST FAILS - which is the point. It is a tripwire on
     a claim the panel makes, not a permanent expectation. */
  assert.equal(OPERABLE_HUMAN_CONTROLS.length, 0);
  for (const lane of HUMAN_REACHABLE_LANES) {
    assert.notEqual(controlReadiness(lane.from), 'operable');
  }
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
     check would be structurally incapable of firing. `approved` is a good
     probe - it is reached only by a human approval and left only by the
     Applier, so no human-reachable edge leaves it and no screen claims it. */
  assert.equal(humanControlLocation('approved'), null);
  assert.equal(controlReadiness('approved'), null);
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
