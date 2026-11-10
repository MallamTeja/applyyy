// P1-7 (2026-11-05): ci.yml was the biggest Actions spender (961 of 1,803 billed minutes over
// 14 days) on a Free-plan private repo already over its 2,000-minute quota. It now (1) skips
// docs-only pushes with `paths-ignore` and (2) runs as ONE job instead of six, so setup is
// paid once and per-job minute rounding is paid once.
//
// These tests guard the three ways that change could silently weaken CI:
// - paths-ignore too broad: a push that mixes docs with code must still run. GitHub skips a
//   run only when EVERY changed path matches an ignore pattern; the fixtures below replay
//   that rule over the patterns read from the committed file.
// - a check dropped in the merge: every command the six jobs ran must still be in the file.
// - a check hidden by an earlier failure: in one job a failed step skips later steps unless
//   they opt out, so every check after setup must carry the `!cancelled()` gate.
//
// No YAML parser is installed in this repo, so the file is read as text with exact-line
// matchers, and every matcher refuses to pass on zero matches (CLAUDE.md §6).
import { describe, expect, test } from 'vitest';
// The workflow is read from disk, so the test always checks the committed file.
import { readFileSync } from 'node:fs';
// Node's own glob matcher (stable in Node 24); `**` and `*` mean what they mean in GitHub's filters.
import { matchesGlob } from 'node:path';

// The committed workflow, resolved from this test file so the cwd does not matter.
const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
// Lines without CR, because Windows working copies are CRLF and the matchers below are exact.
const lines = workflow.split(/\r?\n/);

/** The `paths-ignore` list under `on.<event>`, or a throw when the block is missing. */
function pathsIgnore(event: 'push' | 'pull_request'): string[] {
  // The top-level `on:` key.
  const onAt = lines.indexOf('on:');
  // The event key, two spaces in, after `on:`.
  const eventAt = lines.findIndex((line, index) => index > onAt && line === `  ${event}:`);
  // Its `paths-ignore:` key, four spaces in.
  const listAt = lines.findIndex((line, index) => index > eventAt && line === '    paths-ignore:');
  // Every line between the event and its list must belong to the event (indented deeper),
  // so a `paths-ignore` under the OTHER event is never mistaken for this one's.
  const between = lines.slice(eventAt + 1, listAt);
  // Missing or misplaced: fail loudly rather than test an empty list.
  if (onAt < 0 || eventAt < 0 || listAt < 0 || between.some((line) => /^ {0,3}\S/.test(line))) {
    // Named, so the reader knows which block to look at.
    throw new Error(`ci.yml has no on.${event}.paths-ignore block`);
  }
  // The items, collected until the first line that is neither a comment nor an item.
  const items: string[] = [];
  // Walk forward from the key.
  for (const line of lines.slice(listAt + 1)) {
    // Comments inside the list explain each pattern; skip them.
    if (/^\s*#/.test(line)) continue;
    // A quoted list item, six spaces in.
    const item = /^ {6}- '([^']+)'$/.exec(line);
    // Anything else ends the list.
    if (!item) break;
    // Kept without its quotes.
    items.push(item[1]!);
  }
  // An empty list would make every fixture below meaningless.
  if (items.length === 0) throw new Error(`on.${event}.paths-ignore is empty`);
  // The patterns, in file order.
  return items;
}

/** GitHub's rule: a run is skipped only when there are changes and ALL of them match a pattern. */
function skipped(patterns: string[], changed: string[]): boolean {
  // Every changed path must match at least one ignore pattern.
  return changed.length > 0 && changed.every((path) => patterns.some((pattern) => matchesGlob(path, pattern)));
}

describe('ci.yml paths-ignore', () => {
  // Read once; both events must carry the same list.
  const push = pathsIgnore('push');

  test('push and pull_request ignore exactly docs/** and **/*.md', () => {
    // The two patterns the P1-7 measurement priced (22 docs-only runs, 152 minutes).
    expect(push).toEqual(['docs/**', '**/*.md']);
    // A PR must not run checks a push would skip, or the other way round.
    expect(pathsIgnore('pull_request')).toEqual(push);
  });

  test('a docs-only push is skipped, at any depth and at the repo root', () => {
    // A handoff doc.
    expect(skipped(push, ['docs/handoff/2026-11-05-0110-pending-tasks.md'])).toBe(true);
    // A non-markdown file under docs/ is still prose-only.
    expect(skipped(push, ['docs/stack/data.json'])).toBe(true);
    // The repo-root rules file: `**/` matches zero directories.
    expect(skipped(push, ['CLAUDE.md'])).toBe(true);
    // A nested README.
    expect(skipped(push, ['packages/master-ingest/README.md'])).toBe(true);
    // Several docs at once.
    expect(skipped(push, ['README.md', 'docs/a.md', 'worker/README.md'])).toBe(true);
  });

  test('a push that touches any code still runs, even beside docs', () => {
    // The mixed case GitHub's "every path" rule protects.
    expect(skipped(push, ['docs/handoff/x.md', 'worker/src/cli/scout.ts'])).toBe(false);
    // README plus a web source file.
    expect(skipped(push, ['README.md', 'apps/web/src/App.tsx'])).toBe(false);
    // The workflow itself is code.
    expect(skipped(push, ['.github/workflows/ci.yml'])).toBe(false);
    // A migration.
    expect(skipped(push, ['supabase/migrations/20261105000000_x.sql'])).toBe(false);
    // The lockfile.
    expect(skipped(push, ['pnpm-lock.yaml'])).toBe(false);
    // A markdown-looking name that is not .md.
    expect(skipped(push, ['docs.ts'])).toBe(false);
  });
});

describe('ci.yml single job', () => {
  // The index of the last setup step; every check comes after it.
  const setupAt = lines.findIndex((line) => line.trim() === 'id: setup-done');
  // The step list after setup, as text, for the command checks.
  const checks = lines.slice(setupAt + 1).join('\n');

  test('every command the six jobs ran is still run, after setup', () => {
    // Without the setup marker the slice above would be the whole file.
    expect(setupAt).toBeGreaterThan(0);
    // One entry per check the old jobs ran (deno-check, edge-tests, shared-types-tests,
    // package-tests, web, worker), including the guards that assert work happened.
    for (const command of [
      // deno-check and its file-count equality guard.
      'deno check --reload "${files[@]}"',
      // The guard that the check covered every file.
      '[ "$checks" -eq "${#files[@]}" ]',
      // edge-tests.
      'node --test "supabase/functions/**/*.test.ts"',
      // shared-types-tests.
      'node --test "packages/shared-types/test/**/*.test.ts"',
      // package-tests, every package with a test dir.
      'node --test "packages/$pkg/test/**/*.test.ts"',
      // web: plain production build.
      'run: ./node_modules/.bin/vite build\n',
      // web: the e2e bundle the suite serves.
      'run: ./node_modules/.bin/vite build --mode e2e',
      // web: the suite itself.
      'pnpm --filter @applyy/web test',
      // web: the render function's typecheck and tests.
      'apps/web/node_modules/.bin/tsc -p api/tsconfig.json',
      // The render function's tests.
      'node --test "api/_render/*.test.ts"',
      // worker: vitest.
      'run: ./node_modules/.bin/vitest run',
      // web: the TESTS' typecheck (W36, 2026-11-10). Named, not just counted, so dropping the step fails by name.
      'run: ./node_modules/.bin/tsc --noEmit -p tsconfig.test.json',
      // worker: the e2e runner (T6, 2026-11-10). It rotted for five weeks while nothing ran it.
      'run: node --experimental-strip-types test/e2e-runner.mjs',
    ]) {
      // Named in the failure, so a dropped check is obvious.
      expect(checks, `missing check: ${command}`).toContain(command);
    }
    // tsc runs three times: apps/web (src), apps/web tests (tsconfig.test.json, W36), and worker.
    expect(checks.match(/run: \.\/node_modules\/\.bin\/tsc --noEmit/g)?.length).toBe(3);
  });

  test('the worker e2e runner runs by name, after the e2e-mode web build', () => {
    // The step's line, found by its exact name so a rename or removal fails here by name.
    const runnerAt = lines.indexOf('      - name: worker e2e runner');
    // The build it serves; its dist guard refuses the plain (unconfigured) build that runs before it.
    const e2eBuildAt = lines.indexOf('      - name: web vite build (e2e mode)');
    // Both must exist: -1 < -1 is false, but -1 vs a real index would pass the order check vacuously.
    expect(runnerAt, 'missing step: worker e2e runner').toBeGreaterThan(-1);
    // The build step must exist too, or the order below means nothing.
    expect(e2eBuildAt, 'missing step: web vite build (e2e mode)').toBeGreaterThan(-1);
    // Order: the runner reads the bundle the e2e build just wrote.
    expect(runnerAt).toBeGreaterThan(e2eBuildAt);
  });

  test('every step after setup runs even when an earlier check failed', () => {
    // Each step after setup starts with `- name:`.
    const steps = checks.match(/^ {6}- name: /gm)?.length ?? 0;
    // The gate: not cancelled, and setup succeeded.
    const gated = checks.match(/^ {8}if: \$\{\{ !cancelled\(\) && steps\.setup-done\.outcome == 'success' \}\}$/gm)?.length ?? 0;
    // Zero steps would make the equality below pass vacuously.
    expect(steps).toBeGreaterThanOrEqual(11);
    // One gate per check step: a new check without it would hide behind an earlier red step.
    expect(gated).toBe(steps);
    // One job only: a second job would bring back per-job setup and rounding.
    expect(lines.slice(lines.indexOf('jobs:') + 1).filter((line) => /^ {2}[\w-]+:$/.test(line))).toEqual(['  ci:']);
  });
});
