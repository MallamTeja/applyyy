/* Tests for safeHref, the one gate between a stored URL and an <a href>.
 *
 * React 18 renders a `javascript:` href (a dev-console warning only), and `data:`
 * can carry a whole document. apply_url and profile links come from job boards and
 * parsed resumes, so every href that renders one goes through safeHref.
 *
 * RUN: `node --test "test/**\/*.test.ts"` from apps/web.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { safeHref } from '../src/app/safeHref.ts';

/* The two schemes that execute or embed instead of navigating. */
test('safeHref refuses javascript: and data: URLs', () => {
  assert.equal(safeHref('javascript:alert(document.cookie)'), undefined);
  assert.equal(safeHref('data:text/html,<script>alert(1)</script>'), undefined);
});

/* Casing and leading whitespace are how a prefix test gets fooled. */
test('safeHref is not fooled by casing or leading whitespace', () => {
  assert.equal(safeHref('  JavaScript:alert(1)'), undefined);
});

/* A real link passes, normalised by the URL parser. */
test('safeHref passes an https URL', () => {
  assert.equal(safeHref('https://boards.greenhouse.io/stripe/jobs/1'), 'https://boards.greenhouse.io/stripe/jobs/1');
});

/* Absent or unparseable is "no link", never a dead or relative anchor. */
test('safeHref returns undefined for empty, missing or relative values', () => {
  assert.equal(safeHref(null), undefined);
  assert.equal(safeHref(undefined), undefined);
  assert.equal(safeHref('   '), undefined);
  assert.equal(safeHref('/jobs/1'), undefined);
});
