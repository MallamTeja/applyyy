// postscreen-drain.yml is MANUAL ONLY (Teja ruling 2026-11-05). The `workflow_run` trigger that
// ran it after both scouts (P1-4, commit 10e4e63) was removed the same day. The workflow still
// skips green, calling no agent, when nothing is eligible. These tests hold both halves:
// - the trigger: the `on:` block holds workflow_dispatch and nothing else, so an automatic
//   trigger (workflow_run, schedule) cannot come back unnoticed;
// - the gate: 0 eligible rows means no agent call; any count it cannot read EXACTLY stops the
//   run red instead of being taken as 0 (CLAUDE.md §6), because a wrong 0 skips real rows.
//
// WHY THIS RUNS THE WORKFLOW'S OWN SCRIPT, not a copy: the step text IS the control. Same
// approach as pregate-sweep-log.test.ts: the Node heredoc is cut out of the yml and run with a
// fake `fetch` in front of it, so no network and no bash are needed. Agent pages answer empty,
// so the drain breaks before any 45 s pacing sleep.
import { describe, expect, test } from 'vitest';
// The workflows are read from disk, so the test always checks the committed files.
import { readFileSync } from 'node:fs';
// Node runs the script once per case, synchronously, from stdin like the step does.
import { spawnSync } from 'node:child_process';

/** A committed workflow file, resolved from this test so the cwd does not matter. */
function workflowText(file: string): string {
  // Read as text; CRLF is normalised so line matchers work on Windows checkouts too.
  return readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

// The drain workflow under test.
const drain = workflowText('postscreen-drain.yml');

/** The body of the step's `node --input-type=module <<'JS'` heredoc, dedented, or a throw. */
function drainScript(workflow: string): string {
  // Lines, so indentation can be measured.
  const lines = workflow.split('\n');
  // The heredoc's opening line.
  const start = lines.findIndex((line) => line.includes("node --input-type=module <<'JS'"));
  // A restructured step must fail loudly, never run an empty script that passes (§6).
  if (start < 0) throw new Error("postscreen-drain.yml has no `node --input-type=module <<'JS'` heredoc");
  // The heredoc body is indented like its opening line inside the `run: |` block.
  const indent = lines[start]!.length - lines[start]!.trimStart().length;
  // The terminator, the first line that is exactly `JS` after the opening.
  const end = lines.findIndex((line, index) => index > start && line.trim() === 'JS');
  // Same rule: no terminator, no test.
  if (end < 0) throw new Error('the heredoc has no JS terminator line');
  // Dedented, as YAML hands it to bash and bash hands it to node.
  return lines.slice(start + 1, end).map((line) => line.slice(indent)).join('\n');
}

// The drain's script, cut out once.
const script = drainScript(drain);

// One empty page per agent, in the exact shape each agent returns, so a run that passes the
// gate ends at once: a page that reads 0 rows ends its stage before the pacing sleep.
const EMPTY_PAGES = {
  // matcher/index.ts: rows_in plus the four advance counters and failures.
  matcher: { status: 'succeeded', rows_in: 0, scored: 0, dropped: 0, tech_gate_dropped: 0, failed: 0, failures: [] },
  // tailor/index.ts: tailored, refused, skipped and failures.
  tailor: { status: 'succeeded', tailored: 0, refused: 0, skipped: [], failures: [] },
  // auditor/index.ts: audited, resumed, failed and failures.
  auditor: { status: 'succeeded', audited: 0, resumed: 0, failed: 0, failures: [] },
};

/** Runs the drain with a fake count response; every fetch is logged as `FETCH <method> <url>`. */
function runDrain(count: { status: number; contentRange: string | null }, fromStage = ''): { code: number | null; stdout: string } {
  // The fake fetch, as source text, so the child needs nothing from this process.
  const fakeFetch = [
    // The count response the case wants, and the empty agent pages.
    `const COUNT = ${JSON.stringify(count)}; const PAGES = ${JSON.stringify(EMPTY_PAGES)};`,
    // Replaces the global the script calls; Response is global in Node 18+.
    'globalThis.fetch = async (url, init = {}) => {',
    // Every call is logged, so a case can assert which endpoints were (not) reached.
    "  console.log(`FETCH ${init.method ?? 'GET'} ${url}`);",
    // The password grant gets a session.
    "  if (String(url).includes('/auth/v1/token')) return new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 });",
    // The count gate's HEAD: the case's status and Content-Range header.
    "  if (String(url).includes('/rest/v1/applications')) return new Response(null, { status: COUNT.status, headers: COUNT.contentRange === null ? {} : { 'content-range': COUNT.contentRange } });",
    // An agent page, chosen by the function name in the URL.
    "  const agent = /functions\\/v1\\/(\\w+)/.exec(String(url))?.[1];",
    // An unexpected endpoint is a test bug; say so.
    "  if (!agent || !(agent in PAGES)) throw new Error(`unexpected fetch ${url}`);",
    // The empty page for that agent.
    '  return new Response(JSON.stringify(PAGES[agent]), { status: 200 });',
    '};',
  ].join('\n');
  // Node ESM from stdin, as the step runs it, with the fake placed before the script.
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    // The fake first, then the workflow's own script, unchanged.
    input: `${fakeFetch}\n${script}`,
    // Captured as text.
    encoding: 'utf8',
    // The step's variables with harmless values; FROM_STAGE '' is a dispatch with no input set.
    env: {
      PATH: process.env['PATH'] ?? '',
      DRY_COUNT_ONLY: '',
      FROM_STAGE: fromStage,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'anon-key',
      APPLYY_APP_USER_EMAIL: 'user@example.com',
      APPLYY_APP_USER_PASSWORD: 'password',
    },
  });
  // stdout carries the FETCH lines and the script's own log; stderr is appended for failures.
  return { code: result.status, stdout: result.stdout + result.stderr };
}

/** The FETCH lines that called an agent function. */
function agentCalls(stdout: string): string[] {
  // Only the edge-function calls, never sign-in or the count.
  return stdout.split('\n').filter((line) => line.startsWith('FETCH ') && line.includes('/functions/v1/'));
}

describe('postscreen-drain.yml trigger', () => {
  test('runs on workflow_dispatch only (manual-only ruling 2026-11-05, no workflow_run)', () => {
    // Full-line comments dropped, so the ruling note that NAMES workflow_run is never read as a trigger.
    const lines = drain.split('\n').filter((line) => !/^\s*#/.test(line));
    // The anchor: the top-level `on:` key, asserted present so the check cannot pass over nothing.
    const start = lines.indexOf('on:');
    // A restructured file fails loudly (§6).
    expect(start, 'no top-level `on:` line').toBeGreaterThanOrEqual(0);
    // The block ends at the next top-level key.
    const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
    // Same rule: no end, no test.
    expect(end, 'no top-level key after `on:`').toBeGreaterThan(start);
    // Trigger names sit at exactly two spaces of indent; deeper lines are their settings.
    const triggers = lines.slice(start + 1, end).flatMap((line) => /^ {2}([a-z_]+):/.exec(line)?.[1] ?? []);
    // The exact allowed set: a positive shape, so ANY added trigger goes red.
    expect(triggers).toEqual(['workflow_dispatch']);
  });
});

describe('postscreen-drain.yml count gate', () => {
  test('0 eligible rows: green, SKIP logged, and no agent is called', () => {
    // PostgREST's empty-result Content-Range.
    const run = runDrain({ status: 200, contentRange: '*/0' });
    // Green: an empty queue is the normal state after most scans.
    expect(run.code, run.stdout).toBe(0);
    // The run says why it did nothing.
    expect(run.stdout).toContain('SKIP: nothing eligible; no agent called.');
    // And it really called nothing.
    expect(agentCalls(run.stdout)).toEqual([]);
  });

  test('the count asks for every status the three agents read', () => {
    // Any count; only the request is inspected.
    const run = runDrain({ status: 200, contentRange: '*/0' });
    // The one count request, by HEAD, with the full status set from each agent's query.
    expect(run.stdout).toContain('FETCH HEAD https://example.supabase.co/rest/v1/applications?select=id&status=in.(passed_filters,scored,tailored,audit_clean,audit_flagged)');
  });

  test('from_stage narrows the count to the stages that run', () => {
    // An auditor-only re-run.
    const run = runDrain({ status: 200, contentRange: '*/0' }, 'auditor');
    // Only the auditor's input statuses.
    expect(run.stdout).toContain('status=in.(tailored,audit_clean,audit_flagged)');
  });

  test('eligible rows: every stage is drained', () => {
    // 23 rows, as measured live on 2026-11-05 12:05 IST (8 passed_filters + 15 scored).
    const run = runDrain({ status: 200, contentRange: '0-22/23' });
    // Green, with the count logged.
    expect(run.code, run.stdout).toBe(0);
    // The count is stated.
    expect(run.stdout).toContain('count gate: 23 application(s)');
    // Each agent was called once (its page read 0 rows, which ends the stage).
    expect(agentCalls(run.stdout).map((line) => line.split('/functions/v1/')[1]!.split('?')[0])).toEqual(['matcher', 'tailor', 'auditor']);
  });

  test.each([
    // A server error is not a count.
    ['HTTP 500', { status: 500, contentRange: '*/0' }, 'count gate: HTTP 500'],
    // No header: PostgREST without count=exact, or a proxy that dropped it.
    ['no Content-Range', { status: 200, contentRange: null }, 'count gate: unreadable Content-Range'],
    // A total that is not a number, e.g. count=planned's "*".
    ['a non-numeric total', { status: 200, contentRange: '0-9/*' }, 'count gate: unreadable Content-Range'],
    // A soft-200 page carrying something else entirely.
    ['garbage', { status: 200, contentRange: 'bytes 0-1/2' }, 'count gate: unreadable Content-Range'],
  ])('%s stops the run red and calls no agent', (_label, count, reason) => {
    // The case's count response.
    const run = runDrain(count);
    // Red, never a silent skip.
    expect(run.code).toBe(1);
    // With the reason.
    expect(run.stdout).toContain(`::error::ABORT: ${reason}`);
    // No agent ran on a count nobody could read.
    expect(agentCalls(run.stdout)).toEqual([]);
  });
});
