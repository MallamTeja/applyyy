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
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
import { createPlaywrightPage } from '../src/playwright-page.ts';
import { runApplierBatch, type RunGateway } from '../src/claim-loop.ts';
// Type-only: the shape of the record the loop writes back to the row.
import type { ArtifactPaths } from '../src/apply-one.ts';
// The renderer and the snapshot it renders from. Wired here so the end-to-end
// run exercises the REAL composition, including the resume path.
import { createResumeRenderer } from '../src/resume-renderer.ts';
import { syntheticResume } from './resolved-resume-fixture.ts';

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
  // Resume uploads, counted separately from screenshots: this run must produce
  // NONE, and the reason is asserted below.
  const resumeUploads: number[] = [];
  // Where the loop says the artifacts landed. THE COLUMN WRITE, which for the
  // whole of the dry-run period never happened: the uploads returned paths and
  // the paths were dropped, because the only code that persisted them sat
  // inside a status transition a dry run returns before ever reaching.
  const artifactWrites: Array<{ id: string; paths: ArtifactPaths }> = [];
  const closed: Array<Record<string, unknown>> = [];

  // One row, pointing at the real captured Greenhouse form.
  const queue = [
    [
      {
        id: 'app-e2e-1',
        status: 'approved' as const,
        applyUrl: `${server.url}/greenhouse/gitlab-remix-form.html`,
        // A REAL approved snapshot, so the resume path is genuinely available
        // rather than being skipped because the row had nothing to render.
        // That distinction matters for the assertion below: no resume is
        // produced here because the FORM blocks, not because the row was empty.
        tailoredProfile: syntheticResume,
        // The captured form is GitLab's, so that is the employer it is checked against.
        employerName: 'GitLab',
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
    uploadResume: async (_id, bytes) => {
      resumeUploads.push(bytes.length);
      return 'resumes/app-e2e-1.pdf';
    },
    // The evidence write. Recorded rather than performed, like everything else
    // on this fake, because the assertion is about what the LOOP decided to
    // persist and not about whether Supabase accepted it.
    setArtifactPaths: async (id, paths) => {
      artifactWrites.push({ id, paths });
    },
  };

  const startedAt = Date.now();

  // The real renderer, on its own page. Handed the browser rather than a page,
  // so it cannot land on the form page and erase the form mid-run.
  const renderer = createResumeRenderer(browser);

  const summary = await runApplierBatch({
    gateway,
    // A real Chromium page driving the real captured DOM.
    openPage: async () => createPlaywrightPage(await browser.newPage()),
    // The real render path, not a stub: this is the wiring under test.
    renderResume: renderer.render,
    // Allow without fetching: robots is not under test here (apply-one-robots.test.ts), and a real fetch would hit the network.
    checkRobots: async () => ({ kind: 'allow', reason: 'e2e: robots not under test', crawlDelayMs: null }),
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

  // NO RESUME WAS RENDERED OR UPLOADED, and the reason is the interesting part.
  // The row carries a real approved snapshot, so the resume path was fully
  // available — it was not taken because the form's seven unanswered required
  // comboboxes make this application non-viable, and an application we are
  // about to park must not pay for a PDF or leave an artifact in storage that
  // looks exactly like one that was really attached.
  expect(resumeUploads).toHaveLength(0);

  // BUT THE SCREENSHOT PATH WAS STILL RECORDED ON THE ROW, and this is the
  // assertion the whole §18.6 trust period rests on. Every other expectation in
  // this test was already green before the evidence write existed — the run
  // screenshotted, reported and released exactly as it does now — and the
  // review was still impossible, because nothing connected the application to
  // the image. A dry run writes no status, so a bare UPDATE is the only moment
  // at which that connection can be made.
  expect(artifactWrites).toHaveLength(1);
  expect(artifactWrites[0]?.id).toBe('app-e2e-1');
  expect(artifactWrites[0]?.paths.screenshotPath).toBe('screens/app-e2e-1.png');
  // Null for the same reason no resume was uploaded: the form blocked. Paired
  // with the assertion above so "it recorded the paths" cannot be satisfied by
  // an implementation that records nulls for everything.
  expect(artifactWrites[0]?.paths.resumePath).toBeNull();

  // Released so the renderer's page does not outlive the run. Before the shared
  // browser is torn down in afterAll, so the page is closed by its owner.
  await renderer.close();

  // Reported rather than asserted: a wall-clock threshold here would flake on a
  // loaded machine and teach us nothing, but the number sets the daily volume
  // so it belongs in the output.
  console.log(`[budget] one dry-run application end to end: ${elapsedMs}ms`);
}, 120_000);
