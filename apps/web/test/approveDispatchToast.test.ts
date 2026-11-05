/* The approve toast names what failed honestly (2026-11-05, R1).
 *
 * dispatch-apply now starts apply-kit on EVERY approve and the applier only when Teja's switch is on.
 * The old toast said "the applier did not start" even when only the KIT dispatch failed. The new copy
 * blames neither run: "GitHub did not start the run", and the server message already names the workflow.
 *
 * Checked by SOURCE SHAPE: the page fetches on mount and apps/web has no DOM lib (same as
 * approvalStaleClick.test.ts). The slice is found by an anchor ASSERTED to exist and stripped of
 * comments, so a comment quoting the copy can never satisfy the test. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The page source, read once.
const page = readFileSync(fileURLToPath(new URL('../src/features/approval/ApprovalQueuePage.tsx', import.meta.url)), 'utf8');

test('a failed dispatch after approve says GitHub did not start the run, with the server message', () => {
  // The function that shows the toast; missing means it moved, so say so instead of passing on nothing.
  const from = page.indexOf('async function dispatchAfterApprove(');
  // Anchor present.
  assert.ok(from >= 0, 'anchor not found: async function dispatchAfterApprove(');
  // Its body, up to the component-level close.
  const to = page.indexOf('\n  }', from);
  // Close present.
  assert.ok(to > from, 'no closing brace after dispatchAfterApprove');
  // Code only: block and line comments removed.
  const body = page.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  // The error branch, in its exact positive shape.
  assert.match(body, /else if \(result\.kind === 'error'\) toast\.error\(`Approved, but GitHub did not start the run: \$\{result\.message\}`\);/);
});
