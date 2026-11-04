// 2026-11-04 20:43 IST: pregate-sweep.yml run 41855425210 moved 358 rows passed_filters -> failed
// (missing_description) and its log said only "dropped=71 ... unjudged_errors=0" and CLEAN. The
// matcher already returned `failed: 358` (matcher/index.ts:868) and `pre_gate_dropped_by_code`
// (:866); the workflow read neither. These tests make the log state both, and make a response
// that lacks them stop the run instead of passing as "nothing failed" (CLAUDE.md §6).
//
// WHY THIS RUNS THE WORKFLOW'S OWN SCRIPT, not a copy: the step text IS the control. Same
// approach as apply-workflow-dry-run.test.ts. The Node heredoc is cut out of the yml and run
// with a fake `fetch` placed in front of it, so no network and no bash are needed.
import { describe, expect, test } from 'vitest';
// The workflow is read from disk, so the test always runs the committed step.
import { readFileSync } from 'node:fs';
// Node runs the script once per case, synchronously, from stdin like the step does.
import { spawnSync } from 'node:child_process';

/** The body of the step's `node --input-type=module <<'JS'` heredoc, dedented, or a throw. */
function sweepScript(workflow: string): string {
  // Lines, so indentation can be measured; the repo checks this file out with LF.
  const lines = workflow.split('\n');
  // The heredoc's opening line.
  const start = lines.findIndex((line) => line.includes("node --input-type=module <<'JS'"));
  // A renamed or restructured step must fail loudly, never run an empty script that passes (§6).
  if (start < 0) throw new Error("pregate-sweep.yml has no `node --input-type=module <<'JS'` heredoc");
  // The heredoc body is indented like its opening line inside the `run: |` block.
  const indent = lines[start]!.length - lines[start]!.trimStart().length;
  // The terminator, the first line that is exactly `JS` after the opening.
  const end = lines.findIndex((line, index) => index > start && line.trim() === 'JS');
  // Same rule: no terminator, no test.
  if (end < 0) throw new Error('the heredoc has no JS terminator line');
  // Dedented, as YAML hands it to bash and bash hands it to node.
  return lines.slice(start + 1, end).map((line) => line.slice(indent)).join('\n');
}

// The committed workflow, resolved from this test file so the cwd does not matter.
const workflow = readFileSync(new URL('../../.github/workflows/pregate-sweep.yml', import.meta.url), 'utf8');
// The sweep's script, cut out once.
const script = sweepScript(workflow);

// One matcher page shaped like the 11-04 incident: 358 failed, 71 pre-gate drops, done, clean.
const INCIDENT_PAGE = {
  // The fields the workflow reads, with the incident's values.
  success: true,
  // Printed on the page line.
  status: 'succeeded',
  // What the matcher sets when it fails rows (index.ts:811).
  error_detail: 'matcher_failed: 358 row(s) moved to failed (missing_description)',
  // Rows judged on this page.
  rows_in: 500,
  // The pre-gate's drops, printed as dropped=.
  tech_gate_dropped: 71,
  // The same drops by code, which must add up to tech_gate_dropped.
  pre_gate_dropped_by_code: { work_auth: 1, tech_gate: 70 },
  // The count the old log never printed.
  failed: 358,
  // The sweep mode's own fields.
  mode: 'pregate_only',
  // Rows that passed the gate.
  pregate_survivors: 71,
  // Rows whose gate errored; 0 keeps the pass clean.
  unjudged_errors: 0,
  // The end of the backlog.
  next_after_id: null,
  // Done, so one page ends the pass.
  done: true,
  // A sweep must make no Gemini call.
  gemini_calls: 0,
};

/** Runs the sweep against fake sign-in and matcher responses (one per page, in order). */
function runSweep(pages: readonly object[]): { code: number | null; stdout: string; stderr: string } {
  // The fake fetch: sign-in answers a token, each matcher call answers the next page.
  const fakeFetch = [
    // The pages, embedded as JSON text, so the child needs nothing from this process.
    `const PAGES = ${JSON.stringify(pages.map((page) => JSON.stringify(page)))};`,
    // The next page to hand out.
    'let next = 0;',
    // Replaces the global the script calls; Response is global in Node 18+.
    'globalThis.fetch = async (url) => {',
    // The password grant gets a session.
    "  if (String(url).includes('/auth/v1/token')) return new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 });",
    // Running out of pages is a test bug; say so rather than hang.
    "  if (next >= PAGES.length) throw new Error('the sweep asked for more pages than the test supplied');",
    // A matcher page.
    '  return new Response(PAGES[next++], { status: 200 });',
    '};',
  ].join('\n');
  // Node ESM from stdin, as the step runs it, with the fake placed before the script.
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    // The fake first, then the workflow's own script, unchanged.
    input: `${fakeFetch}\n${script}`,
    // Captured as text.
    encoding: 'utf8',
    // The step's variables with harmless values; PATH only from the caller, so nothing leaks in.
    env: {
      PATH: process.env['PATH'] ?? '',
      DRY_COUNT_ONLY: 'false',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'anon-key',
      APPLYY_APP_USER_EMAIL: 'user@example.com',
      APPLYY_APP_USER_PASSWORD: 'password',
    },
  });
  // Everything a failing case needs to explain itself.
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The log line that starts with `prefix`, or a throw naming what the log did hold. */
function line(stdout: string, prefix: string): string {
  // The first matching line.
  const found = stdout.split('\n').find((text) => text.startsWith(prefix));
  // A missing line must fail with the log in hand, never as an undefined comparison.
  if (found === undefined) throw new Error(`no line starting ${JSON.stringify(prefix)} in:\n${stdout}`);
  // The line.
  return found;
}

describe('pregate-sweep.yml log', () => {
  // The incident: the run must SAY that 358 rows failed, on the page and in the summary.
  test('the page line and CLEAN summary print failed and the by-code drops', () => {
    // One clean page.
    const run = runSweep([INCIDENT_PAGE]);
    // Failed rows are terminal, not unjudged: the run is still clean and green.
    expect(run.code, run.stdout + run.stderr).toBe(0);
    // The page line carries both, by-code sorted so the log is stable.
    expect(line(run.stdout, 'pass 1 page 1:')).toContain('failed=358 by_code=tech_gate:70,work_auth:1');
    // The summary carries the run totals.
    expect(line(run.stdout, 'CLEAN:')).toContain('failed=358 by_code=tech_gate:70,work_auth:1');
  });

  // The count says how many; the matcher's error_detail says why (the set of reasons).
  test("a page with failed rows prints the matcher's error_detail", () => {
    // The same page.
    const run = runSweep([INCIDENT_PAGE]);
    // Printed under its own label, beside the page.
    expect(line(run.stdout, 'pass 1 page 1 failed_detail:')).toContain('(missing_description)');
  });

  // Totals are summed across pages, and by-code maps are merged key by key.
  test('CLEAN sums failed and the by-code drops across pages', () => {
    // A first page that is not the end of the backlog.
    const first = { ...INCIDENT_PAGE, done: false, next_after_id: 'ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154', failed: 8, tech_gate_dropped: 3, pre_gate_dropped_by_code: { tech_gate: 3 } };
    // A last page with a different mix and no failures.
    const last = { ...INCIDENT_PAGE, failed: 0, error_detail: null, tech_gate_dropped: 2, pre_gate_dropped_by_code: { work_auth: 2 } };
    // Both pages, in order.
    const run = runSweep([first, last]);
    // Still clean.
    expect(run.code, run.stdout + run.stderr).toBe(0);
    // 8 + 0 failed; tech_gate 3 and work_auth 2.
    expect(line(run.stdout, 'CLEAN:')).toContain('failed=8 by_code=tech_gate:3,work_auth:2');
  });

  // A matcher that stopped reporting the count must not read as "nothing failed".
  test('a page without a failed count stops the run', () => {
    // The incident page minus the field.
    const { failed: _dropped, ...withoutFailed } = INCIDENT_PAGE;
    // One page.
    const run = runSweep([withoutFailed]);
    // Red.
    expect(run.code).toBe(1);
    // With the reason.
    expect(run.stdout).toContain('::error::ABORT: failed is missing or not a non-negative integer');
  });

  // The by-code map must be an object of non-negative integer counts, nothing looser.
  test.each([
    // Absent.
    ['absent', undefined],
    // Null.
    ['null', null],
    // An array is an object to typeof.
    ['an array', [3]],
    // A count sent as text.
    ['a string count', { tech_gate: '3' }],
    // A negative count.
    ['a negative count', { tech_gate: -1 }],
  ])('a by-code map that is %s stops the run', (_label, byCode) => {
    // The incident page with the map replaced (undefined drops the key in JSON).
    const run = runSweep([{ ...INCIDENT_PAGE, pre_gate_dropped_by_code: byCode }]);
    // Red.
    expect(run.code).toBe(1);
    // With the reason.
    expect(run.stdout).toContain('::error::ABORT: pre_gate_dropped_by_code is not an object of non-negative integers');
  });
});
