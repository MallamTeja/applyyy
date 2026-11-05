/* postscreen-drain.yml runs MANUALLY only (Teja ruling 2026-11-05, reversing the P1-4
 * `workflow_run` trigger from commit 10e4e63). A disabled flag would not be a control, so the
 * trigger itself is gone; this test holds the `on:` block to its exact allowed set.
 *
 * WHY A SHAPE TEST: the workflow is YAML, and no YAML parser is a declared dependency of
 * apps/web. The `on:` block is cut out by its top-level keys, which are asserted to EXIST
 * first, so a restructured file fails loudly instead of passing vacuously (CLAUDE.md §6).
 */

// node:test, the runner every apps/web test uses.
import { test } from 'node:test';
// Strict asserts, so a near-miss is never treated as equal.
import assert from 'node:assert/strict';
// The workflow is read from disk, so the test always checks the working-tree file.
import { readFileSync } from 'node:fs';

// Resolved from this file, so the cwd the runner is started from does not matter.
const WORKFLOW_URL = new URL('../../../.github/workflows/postscreen-drain.yml', import.meta.url);

/** The trigger names directly under `on:`, comments stripped, or a throw if the block is missing. */
function triggerKeys(yaml: string): string[] {
  // CRLF normalised (Windows checkouts) and full-line comments dropped, so a comment that
  // mentions workflow_run (the ruling note) can never be read as a trigger.
  const lines = yaml.replace(/\r\n/g, '\n').split('\n').filter((line) => !/^\s*#/.test(line));
  // The anchor: the top-level `on:` key. Asserted present, never assumed.
  const start = lines.findIndex((line) => line === 'on:');
  // No anchor means the file changed shape; fail red rather than find zero triggers.
  if (start < 0) throw new Error('postscreen-drain.yml has no top-level `on:` line');
  // The block ends at the next top-level key (a non-indented, non-blank line).
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  // A file with nothing after `on:` is not a workflow this test understands.
  if (end < 0) throw new Error('postscreen-drain.yml has no top-level key after `on:`');
  // Trigger names sit at exactly two spaces of indent; deeper lines are their settings.
  return lines.slice(start + 1, end).flatMap((line) => /^ {2}([a-z_]+):/.exec(line)?.[1] ?? []);
}

test('postscreen-drain.yml triggers on workflow_dispatch only (no workflow_run)', () => {
  // The exact allowed set: a positive shape, so ANY added trigger (workflow_run, schedule,
  // push) goes red, not only the one that was removed.
  assert.deepEqual(triggerKeys(readFileSync(WORKFLOW_URL, 'utf8')), ['workflow_dispatch']);
});

test('the shape check finds a workflow_run trigger when one is present', () => {
  // Proves the extractor can see a second trigger, so the test above cannot pass vacuously.
  const sample = 'name: x\n\non:\n  workflow_run:\n    types: [completed]\n  workflow_dispatch:\n\njobs:\n';
  // Both triggers, in file order.
  assert.deepEqual(triggerKeys(sample), ['workflow_run', 'workflow_dispatch']);
});
