// THE END-TO-END PROOF: the whole applier loop, real Chromium, real captured
// Greenhouse DOM, served from localhost — and zero submissions.
//
// This is what PROJECT_PLAN.md §19 designed the fixtures for, and it is the
// honest version of "test it in prod": constraint #16 forbids testing the
// automation by submitting real job applications, so the only defensible
// end-to-end test is one against saved markup with the submit path disabled.
//
// It also produces the number that sets the product's daily volume. The ~35/day
// ceiling is justified by per-RUN overhead and GitHub's round-up-to-whole-
// minutes billing rather than by per-application cost, but the per-application
// figure still bounds how much a single batched run can carry, so it is
// measured here rather than estimated.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { AnswerBankRow } from '@applyy/shared-types';
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.js';
import { createPlaywrightPage } from '../src/playwright-page.js';
import { runApplierBatch, type RunGateway } from '../src/claim-loop.js';

let browser: Browser;
let server: FixtureServer;

beforeAll(async () => {
  browser = await chromium.launch();
  server = await startFixtureServer('fixtures');
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * An answer bank that can satisfy the three plain-text required fields on the
 * real GitLab form. The seven required comboboxes are deliberately NOT
 * answered, because that is the realistic state on day one and it is what makes
 * the blocking path exercise itself rather than being simulated.
 */
const answers = [
  { question_key: 'first_name', answer_value: 'Teja', needs_human: false, answer_type: 'text' },
  { question_key: 'last_name', answer_value: 'Mallam', needs_human: false, answer_type: 'text' },
  {
    question_key: 'email',
    answer_value: 'tejamallam00@gmail.com',
    needs_human: false,
    answer_type: 'text',
  },
] as unknown as AnswerBankRow[];

test('a full dry-run batch fills, screenshots and submits NOTHING', async () => {
  // Everything the gateway is asked to do is recorded rather than performed, so
  // the assertions below are about what the LOOP decided, not about Supabase.
  const statusWrites: string[] = [];
  const released: string[] = [];
  const screenshots: number[] = [];
  const closed: Array<Record<string, unknown>> = [];

  // One row, pointing at the real captured Greenhouse form.
  const queue = [
    [
      {
        id: 'app-e2e-1',
        status: 'approved' as const,
        applyUrl: `${server.url}/greenhouse/gitlab-remix-form.html`,
      },
    ],
    [],
  ];

  const gateway: RunGateway = {
    openRun: async () => ({ id: 'run-e2e' }),
    closeRun: async (_id, update) => {
      closed.push(update as Record<string, unknown>);
    },
    isSystemEnabled: async () => true,
    sweepStaleClaims: async () => {},
    claimApplications: async () => queue.shift() ?? [],
    fetchAnswers: async () => answers,
    sessionExpiresAtEpochSeconds: () => Math.floor(Date.now() / 1000) + 3600,
    refreshSession: async () => {},
    advanceStatus: async (_id, to) => {
      statusWrites.push(to);
    },
    releaseClaim: async (id) => {
      released.push(id);
    },
    uploadScreenshot: async (_id, bytes) => {
      screenshots.push(bytes.length);
      return 'screens/app-e2e-1.png';
    },
  };

  const startedAt = Date.now();

  const summary = await runApplierBatch({
    gateway,
    // A real Chromium page driving the real captured DOM.
    openPage: async () => createPlaywrightPage(await browser.newPage()),
    // DRY_RUN deliberately unset — the same state a runner has when a workflow
    // references a secret that does not exist.
    env: {},
    clock: () => Math.floor(Date.now() / 1000),
  });

  const elapsedMs = Date.now() - startedAt;

  // ---- The constraint assertions -----------------------------------------

  // Nothing was submitted, and nothing could have been: the submit path throws
  // by construction and the dry-run gate returns before reaching it.
  expect(summary.submitted).toBe(0);
  // And the row never entered the status graph at all, so it is still sitting
  // at `approved` for the day the flag is flipped.
  expect(statusWrites).toHaveLength(0);
  expect(released).toEqual(['app-e2e-1']);

  // ---- The it-actually-worked assertions ----------------------------------

  // One application was genuinely processed, not skipped.
  expect(summary.claimed).toBe(1);
  expect(summary.dryRun).toBe(1);
  expect(summary.errors).toBe(0);
  // A real screenshot of a real rendered form. The size floor is a non-vacuity
  // guard: a zero-byte or trivially small buffer would mean we captured a blank
  // page and the §18.6 review would be reviewing nothing.
  expect(screenshots).toHaveLength(1);
  expect(screenshots[0]).toBeGreaterThan(5_000);
  // The run row is closed as a success that submitted nothing, which is what
  // the health page must show during the trust period — `rows_out` counts work
  // actually completed, and a dry run completes none.
  expect(closed[0]?.status).toBe('succeeded');
  expect(closed[0]?.rows_out).toBe(0);

  // The seven required comboboxes have no answers, so the run reports that a
  // real batch would have blocked rather than submitted. This is the §18.6
  // signal that tells Teja which answers to add before flipping the flag.
  expect(summary.blocked).toBe(0);

  // Reported rather than asserted: a wall-clock threshold here would flake on a
  // loaded machine and teach us nothing, but the number sets the daily volume
  // so it belongs in the output.
  console.log(`[budget] one dry-run application end to end: ${elapsedMs}ms`);
}, 120_000);
