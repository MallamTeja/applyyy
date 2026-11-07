/**
 * Every browser edge call goes through invokeEdge (2026-11-07, handoff item 4).
 *
 * WHY: bbfb872 made the AI chat survive a session revoked elsewhere (refresh once, retry once, else
 * sign out THIS browser with a plain sentence). The other seven callers still called
 * functions.invoke directly, so the same revoked session gave each of them a raw 401 and left the
 * dead session in the tab. These tests drive each caller's own entry point with a revoked session
 * and a refresh that fails, and pin the one routing rule with a scan of the source tree.
 *
 * The doubles behave like supabase-js: invoke RETURNS { data, error } (never throws for an HTTP
 * error), and the error is the real FunctionsHttpError around a real Response.
 */
// The .tsx loader and extensionless-import resolver; must run before any app module loads.
import './support/registerTsxHooks.ts';
// Node's own runner and strict asserts, as every web test here uses.
import assert from 'node:assert/strict';
// describe/it from the same runner; before() loads the app modules after the hook.
import { before, describe, it } from 'node:test';
// The source scan reads files and walks the tree.
import { readdirSync, readFileSync, statSync } from 'node:fs';
// Paths built from this file's location, so the scan works from any cwd.
import { dirname, join, relative } from 'node:path';
// This file's own path, for the source root.
import { fileURLToPath } from 'node:url';
// The real error class, so the double's error is exactly what supabase-js hands back on a non-2xx.
import { FunctionsHttpError } from '@supabase/supabase-js';

// The sentence every caller must show.
let SIGNED_OUT_MESSAGE: string;
// Caller 1: the Watchlist scan.
let runWatchlistScan: typeof import('../src/data/discoveryService.ts').runWatchlistScan;
// Caller 2: the batch pipeline runner.
let runPipeline: typeof import('../src/data/pipelineRunner.ts').runPipeline;
// Caller 3: apply on approve.
let requestDispatch: typeof import('../src/features/approval/dispatchApply.ts').requestDispatch;
// Caller 4: add a job by link.
let runJobLinkIntake: typeof import('../src/features/discovery/AddJobLinkPanel.tsx').runJobLinkIntake;
// Caller 5: the web search.
let runWebScout: typeof import('../src/features/discovery/WebScoutPanel.tsx').runWebScout;
// Caller 6: the Gmail sync.
let syncGmailInbox: typeof import('../src/features/emails/emailSync.ts').syncGmailInbox;
// Caller 7: the per-row pipeline.
let makeRowPipelineDeps: typeof import('../src/features/pipeline/rowPipelineDeps.ts').makeRowPipelineDeps;

before(async () => {
  // Loaded after the hook, so the app's extensionless imports resolve.
  ({ SIGNED_OUT_MESSAGE } = await import('../src/data/edgeCall.ts'));
  // Each caller from its own module.
  ({ runWatchlistScan } = await import('../src/data/discoveryService.ts'));
  // Same.
  ({ runPipeline } = await import('../src/data/pipelineRunner.ts'));
  // Same.
  ({ requestDispatch } = await import('../src/features/approval/dispatchApply.ts'));
  // Same.
  ({ runJobLinkIntake } = await import('../src/features/discovery/AddJobLinkPanel.tsx'));
  // Same.
  ({ runWebScout } = await import('../src/features/discovery/WebScoutPanel.tsx'));
  // Same.
  ({ syncGmailInbox } = await import('../src/features/emails/emailSync.ts'));
  // Same.
  ({ makeRowPipelineDeps } = await import('../src/features/pipeline/rowPipelineDeps.ts'));
});

// A non-2xx answer the way functions-js builds one: the raw Response, body unread, behind `context`.
function httpError(status: number, body: unknown): { data: null; error: FunctionsHttpError } {
  // A real Response, so json() and clone() behave as in the browser.
  const response = new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  // Returned with data null, as functions-js does on an HTTP error.
  return { data: null, error: new FunctionsHttpError(response) };
}

// The exact body the edge gate sends for a revoked session (_shared/db/gates.ts).
const revoked = () => httpError(401, { status: 'unauthorized', message: 'invalid_session' });

// A fake client: invoke answers from a script, refreshSession fails or succeeds, every call is recorded.
function fakeClient(answers: Array<Record<string, unknown>>, refreshOk: boolean) {
  // What the caller did, read by the asserts.
  const calls = { invoke: [] as Array<{ name: string; options: unknown }>, refresh: 0, signOut: [] as unknown[] };
  // The slice of supabase-js invokeEdge touches, plus readStatusRow for the row pipeline.
  const client = {
    functions: {
      // Each call takes the next scripted answer; running out is a test bug, so it throws loudly.
      invoke: async (name: string, options?: unknown) => {
        // Recorded with its options, so "no body sent" can be asserted.
        calls.invoke.push({ name, options });
        // The next answer in order.
        const next = answers.shift();
        // A missing answer means the caller invoked more than the test allowed.
        if (next === undefined) throw new Error('invoke called more times than scripted');
        // Returned, never thrown, as the real invoke does.
        return next;
      },
    },
    auth: {
      // auth-js shape: a revoked refresh token gives an error.
      refreshSession: async () => {
        // Counted so "exactly one refresh" can be asserted.
        calls.refresh += 1;
        // Success or the revoked-token error.
        return refreshOk ? { data: {}, error: null } : { data: {}, error: { name: 'AuthApiError', message: 'Invalid Refresh Token: Refresh Token Not Found', status: 400 } };
      },
      // Records the scope; local sign-out succeeds.
      signOut: async (options?: unknown) => {
        // Recorded verbatim.
        calls.signOut.push(options);
        // As auth-js answers.
        return { error: null };
      },
    },
    // Only the row pipeline reads this; a row still at its input status.
    readStatusRow: async () => ({ data: { status: 'passed_filters', match_score: null }, error: null }),
  };
  // Both handed to the test.
  return { client, calls };
}

// Each caller's entry point, run against a client, returning whatever the caller returns.
const CALLERS: ReadonlyArray<{ readonly name: string; readonly run: (client: never) => Promise<unknown>; readonly said: (result: never) => unknown }> = [
  // The scan's message field.
  { name: 'runWatchlistScan (scout-ats)', run: (c) => runWatchlistScan(undefined, c), said: (r: { message: string }) => r.message },
  // The first step's message: the session is dead for every agent, so the runner stops there.
  { name: 'runPipeline (batch agents)', run: (c) => runPipeline(c), said: (r: { steps: Array<{ message?: string }> }) => r.steps[0]?.message },
  // The dispatch error's message.
  { name: 'requestDispatch (dispatch-apply)', run: (c) => requestDispatch(c), said: (r: { message: string }) => r.message },
  // The intake error's message.
  { name: 'runJobLinkIntake (job-link-intake)', run: (c) => runJobLinkIntake(c, 'https://example.com/jobs/1'), said: (r: { message: string }) => r.message },
  // The web search's message.
  { name: 'runWebScout (scout-web)', run: (c) => runWebScout(c, ''), said: (r: { message: string }) => r.message },
  // The Gmail sync's message.
  { name: 'syncGmailInbox (gmail-sync)', run: (c) => syncGmailInbox(c), said: (r: { message: string }) => r.message },
  // The row pipeline's error words.
  { name: 'rowPipelineDeps.invoke (matcher)', run: (c) => makeRowPipelineDeps(c).invoke('matcher', 'a1111111-1111-4111-8111-111111111111'), said: (r: { body: { error: string } }) => r.body.error },
];

describe('every browser edge call survives a revoked session (invokeEdge)', () => {
  for (const caller of CALLERS) {
    it(`${caller.name}: a revoked session that cannot refresh signs this browser out and says so plainly`, async () => {
      // One session 401; the refresh fails, so there must be no retry.
      const { client, calls } = fakeClient([revoked()], false);
      // The caller's own entry point.
      const result = await caller.run(client as never);
      // The plain sentence, never the raw invalid_session code.
      assert.equal(caller.said(result as never), SIGNED_OUT_MESSAGE);
      // One call, one refresh, no retry.
      assert.deepEqual([calls.invoke.length, calls.refresh], [1, 1]);
      // Signed out THIS browser only.
      assert.deepEqual(calls.signOut, [{ scope: 'local' }]);
    });
  }

  it('the batch runner marks every later agent not run after a sign-out, with one call in total', async () => {
    // The same revoked session, no recovery.
    const { client, calls } = fakeClient([revoked()], false);
    // The whole batch.
    const result = await runPipeline(client as never);
    // Every step after the first is recorded as not run.
    assert.ok(result.steps.slice(1).every((s) => s.status === 'not_run'), JSON.stringify(result.steps));
    // Only the first agent was ever called.
    assert.equal(calls.invoke.length, 1);
  });

  it('after a good refresh the row pipeline retries once and still reports the HTTP status of the answer', async () => {
    // The 401, then a 200 whose raw Response newer supabase-js returns beside data.
    const { client, calls } = fakeClient([revoked(), { data: { success: true, processed: 1 }, error: null, response: new Response(null, { status: 200 }) }], true);
    // One step for one row.
    const result = await makeRowPipelineDeps(client as never).invoke('matcher', 'a1111111-1111-4111-8111-111111111111');
    // The retry's answer, with its real status passed through.
    assert.deepEqual(result, { ok: true, httpStatus: 200, body: { success: true, processed: 1 } });
    // Two calls, one refresh, no sign-out.
    assert.deepEqual([calls.invoke.length, calls.refresh, calls.signOut.length], [2, 1, 0]);
  });

  it('callers that sent no body still send none, and the query suffix survives', async () => {
    // A plain 200, one per caller below.
    const ok = () => ({ data: {}, error: null });
    // Fresh client, enough answers for the two calls.
    const { client, calls } = fakeClient([ok(), ok()], true);
    // dispatch-apply sends no body.
    await requestDispatch(client as never);
    // The row pipeline sends no body; the id rides in the query string.
    await makeRowPipelineDeps(client as never).invoke('matcher', 'a1111111-1111-4111-8111-111111111111');
    // Name and options exactly as before the routing change.
    assert.deepEqual(calls.invoke, [
      { name: 'dispatch-apply', options: undefined },
      { name: 'matcher?application_id=a1111111-1111-4111-8111-111111111111', options: undefined },
    ]);
  });
});

describe('the routing rule, over the whole source tree', () => {
  it('functions.invoke is called only inside src/data/edgeCall.ts', () => {
    // apps/web/src, from this file's location.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    // Every .ts/.tsx file under it.
    const files: string[] = [];
    // Depth-first walk; the tree is small.
    const walk = (dir: string): void => {
      // Each entry once.
      for (const name of readdirSync(dir)) {
        // Its full path.
        const path = join(dir, name);
        // Directories recurse; source files are collected.
        if (statSync(path).isDirectory()) walk(path);
        // Only code can call invoke.
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    // From the root.
    walk(root);
    // Non-vacuity: the scan really read the tree, not an empty glob.
    assert.ok(files.length > 100, `scanned only ${files.length} files`);
    // A call, not a mention in a comment: the dot-call with its opening parenthesis.
    const callers = files
      // Files whose text contains such a call.
      .filter((f) => /\.functions\.invoke\(/.test(readFileSync(f, 'utf8')))
      // Relative and slash-separated, so the assert reads the same on Windows and CI.
      .map((f) => relative(root, f).split('\\').join('/'));
    // Exactly the helper itself.
    assert.deepEqual(callers, ['data/edgeCall.ts']);
  });
});
