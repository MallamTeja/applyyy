/* postscreen-drain.yml runs AUTOMATICALLY (Teja ruling 2026-11-09 ~17:20 IST). That reversed the
 * 2026-11-05 manual-only ruling after 55 rows stalled 11-02 -> 11-09
 * (docs/status/2026-11-09-pipeline-stall.md). This test pins the exact trigger set: a scout
 * finishing (workflow_run), one daily sweep (schedule), and manual dispatch. It also pins the
 * concurrency guard that keeps a triggered run and the cron from racing each other.
 * Replaces postscreenDrainManualOnly.test.ts, which pinned the reversed ruling.
 *
 * WHY A SHAPE TEST: the workflow is YAML, and no YAML parser is a declared dependency of
 * apps/web. Blocks are cut out by their keys, and every key is asserted to EXIST first, so a
 * restructured file fails loudly instead of passing vacuously (CLAUDE.md §6).
 */

// node:test, the runner every apps/web test uses.
import { test } from 'node:test';
// Strict asserts, so a near-miss is never treated as equal.
import assert from 'node:assert/strict';
// The workflows are read from disk, so the test always checks the working-tree files.
import { readFileSync } from 'node:fs';

// Resolved from this file, so the cwd the runner is started from does not matter.
const WORKFLOWS = new URL('../../../.github/workflows/', import.meta.url);
// The drain under test.
const DRAIN = readFileSync(new URL('postscreen-drain.yml', WORKFLOWS), 'utf8');
// The two scouts whose completion starts it. Read so their real `name:` can be compared with the trigger.
const SCOUT_FILES = ['scout.yml', 'scout-remote.yml'];

/** The file's lines, CRLF normalised (Windows checkouts) and full-line comments dropped. */
function codeLines(yaml: string): string[] {
  // A comment that mentions workflow_run or schedule (the ruling note) can never be read as config.
  return yaml.replace(/\r\n/g, '\n').split('\n').filter((line) => !/^\s*#/.test(line));
}

/** The lines strictly inside the block that starts at `header` (an exact line), up to the next line indented <= it. */
function block(lines: string[], header: string): string[] {
  // The anchor, asserted present, never assumed.
  const start = lines.findIndex((line) => line === header);
  // No anchor means the file changed shape; fail red rather than read an empty block.
  if (start < 0) throw new Error(`no \`${header.trim()}\` line`);
  // The header's own indent; the block is every following line indented deeper (or blank).
  const indent = /^ */.exec(header)![0].length;
  // The first later non-blank line at the same or a shallower indent ends the block.
  const end = lines.findIndex((line, i) => i > start && line.trim() !== '' && /^ */.exec(line)![0].length <= indent);
  // A block running to end of file is fine for this test's purposes.
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.trim() !== '');
}

/** The trigger names directly under the top-level `on:`, in file order. */
function triggerKeys(yaml: string): string[] {
  // Trigger names sit at exactly two spaces of indent; deeper lines are their settings.
  return block(codeLines(yaml), 'on:').flatMap((line) => /^ {2}([a-z_]+):/.exec(line)?.[1] ?? []);
}

/** The quoted names in the `workflows: [...]` line of the workflow_run trigger. */
function workflowRunNames(yaml: string): string[] {
  // The one line naming the upstream workflows; asserted present below by the caller.
  const line = block(codeLines(yaml), '  workflow_run:').find((l) => /^ {4}workflows:/.test(l));
  // Missing means the trigger can never fire; fail red.
  if (line === undefined) throw new Error('workflow_run has no workflows: line');
  // Each single-quoted name, in order.
  return [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

test('postscreen-drain.yml triggers on exactly: a scout finishing, one daily schedule, and manual dispatch', () => {
  // The exact set, in file order: a positive shape, so ANY added trigger (push, pull_request, a second schedule) goes red.
  assert.deepEqual(triggerKeys(DRAIN), ['workflow_run', 'schedule', 'workflow_dispatch']);
  // The settings of the state-change trigger, read once for the checks below.
  const run = block(codeLines(DRAIN), '  workflow_run:');
  // Only after the scout has FINISHED inserting, never on `requested` (mid-insert).
  assert.ok(run.some((l) => /^ {4}types: \[completed\]$/.test(l)), 'workflow_run must be types: [completed]');
  // Exactly one cron line: one daily sweep, not a polling loop.
  const crons = block(codeLines(DRAIN), '  schedule:').filter((l) => /^ {4}- cron: '[^']+'$/.test(l));
  // One, and only one.
  assert.equal(crons.length, 1, `expected exactly one cron, found ${crons.length}`);
});

test('the workflow_run names are exactly the two scouts, spelled as their own name: lines', () => {
  // GitHub matches `workflows:` against each workflow's `name:`. A renamed scout would silently stop triggering the drain.
  const scoutNames = SCOUT_FILES.map((file) => {
    // The scout's top-level `name:` line.
    const line = codeLines(readFileSync(new URL(file, WORKFLOWS), 'utf8')).find((l) => /^name: /.test(l));
    // A scout without a name cannot be matched; fail red.
    if (line === undefined) throw new Error(`${file} has no top-level name: line`);
    // The value after `name: `.
    return line.slice('name: '.length).trim();
  });
  // Same names, same order.
  assert.deepEqual(workflowRunNames(DRAIN), scoutNames);
});

test('a scout-triggered run and the cron queue behind each other instead of racing', () => {
  // The concurrency block, asserted present.
  const conc = block(codeLines(DRAIN), 'concurrency:');
  // One fixed group, so every run of this drain shares a single queue.
  assert.ok(conc.some((l) => /^ {2}group: postscreen-drain$/.test(l)), 'concurrency group must be postscreen-drain');
  // Never cancel a running drain: a killed request mid-write is worse than a queued run.
  assert.ok(conc.some((l) => /^ {2}cancel-in-progress: false$/.test(l)), 'cancel-in-progress must be false');
});

test('the shape check sees every trigger, so the tests above cannot pass vacuously', () => {
  // A sample with an extra trigger and a commented-out one.
  const sample = "name: x\n\non:\n  push:\n  # schedule:\n  workflow_run:\n    workflows: ['a', 'b']\n    types: [completed]\n\njobs:\n";
  // The commented line is ignored; both real triggers are found, in order.
  assert.deepEqual(triggerKeys(sample), ['push', 'workflow_run']);
  // The names are read from the workflows: line.
  assert.deepEqual(workflowRunNames(sample), ['a', 'b']);
});
