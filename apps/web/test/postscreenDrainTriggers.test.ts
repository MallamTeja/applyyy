/* postscreen-drain.yml TAILORS ON DEMAND ONLY (Teja ruling 2026-11-18 21:45 IST: "they don't need to directly reach
 * approval, they need to go to ready to tailor; only the jobs which I add through the Add job link button need to go
 * directly to the approval queue."). That reversed the 2026-11-09 AUTOMATIC ruling (a drain after every scout).
 * This test pins two things, and each one goes red on its own regression:
 * 1. The trigger set is exactly a daily schedule plus manual dispatch. A returning `workflow_run` (drain after a scout)
 *    is red.
 * 2. The scheduled run is the approval-queue re-gate ONLY: REGATE_ONLY is true exactly on the schedule, and the script
 *    exits after the re-gate request and before the first matcher/tailor/auditor call. Moving or deleting that exit is red.
 * It also pins the concurrency guard, so a dispatch and the cron queue behind each other.
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
// The drain under test, CRLF normalised so index and line checks are EOL-proof.
const DRAIN = readFileSync(new URL('postscreen-drain.yml', WORKFLOWS), 'utf8').replace(/\r\n/g, '\n');

/** The file's lines, full-line comments dropped. */
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

/** The offset of the one line matching `pattern` in `text`; throws if absent or repeated, so no check passes on nothing. */
function onlyIndex(text: string, pattern: RegExp, what: string): number {
  // Every match, with the global flag added so matchAll can walk them.
  const hits = [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  // Exactly one: zero means the anchor moved, two means the position check would be ambiguous.
  if (hits.length !== 1) throw new Error(`expected exactly one ${what}, found ${hits.length}`);
  // Its offset in the file.
  return hits[0]!.index!;
}

test('postscreen-drain.yml triggers on exactly: one daily schedule and manual dispatch (no workflow_run since 2026-11-18)', () => {
  // The exact set, in file order: a positive shape, so a returning workflow_run (or any push/pull_request) goes red.
  assert.deepEqual(triggerKeys(DRAIN), ['schedule', 'workflow_dispatch']);
  // Exactly one cron line: one daily re-gate, not a polling loop.
  const crons = block(codeLines(DRAIN), '  schedule:').filter((l) => /^ {4}- cron: '[^']+'$/.test(l));
  // One, and only one.
  assert.equal(crons.length, 1, `expected exactly one cron, found ${crons.length}`);
});

test('REGATE_ONLY is true exactly on the schedule, so a dispatch still runs the full drain', () => {
  // The env line, spelled as the one expression that is 'true' for a scheduled run and 'false' for a dispatch.
  assert.match(DRAIN, /^ {10}REGATE_ONLY: \$\{\{ github\.event_name == 'schedule' \}\}$/m);
});

test('the scheduled run exits after the re-gate and before any matcher/tailor/auditor call', () => {
  // The re-gate request: the one thing a scheduled run must still do.
  const regate = onlyIndex(DRAIN, /fetch\(`\$\{base\}\/functions\/v1\/auditor\?mode=regate_queue`/, 'regate_queue fetch');
  // The guard that ends a scheduled run.
  const guard = onlyIndex(DRAIN, /if \(process\.env\.REGATE_ONLY === 'true'\) \{/, 'REGATE_ONLY guard');
  // The stage loop's request: the call that would score or tailor a row.
  // The fetch itself, not the plan's log line that prints the same URL.
  const stage = onlyIndex(DRAIN, /fetch\(`\$\{base\}\/functions\/v1\/\$\{stage\.name\}\?limit=/, 'stage fetch');
  // The order that keeps a scheduled run from tailoring: re-gate, then exit, then (dispatch only) the stages.
  assert.ok(regate < guard && guard < stage, `order must be regate < guard < stage, got ${regate} / ${guard} / ${stage}`);
  // The guard's body, up to its closing brace: it must exit green and call nothing.
  const body = DRAIN.slice(guard, DRAIN.indexOf('\n          }\n', guard));
  // A clean exit.
  assert.match(body, /process\.exit\(0\);/);
  // And no request of any kind inside it.
  assert.doesNotMatch(body, /fetch\(/);
});

test('a dispatch and the cron queue behind each other instead of racing', () => {
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
  // And the position helper refuses an anchor that is missing, rather than returning a fake offset.
  assert.throws(() => onlyIndex('no anchor here', /REGATE_ONLY/, 'guard'), /found 0/);
});
