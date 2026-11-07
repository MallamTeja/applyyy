// Greenhouse's HTTP 428 "security code required" gate, end to end (item 1, 2026-11-07).
//
// WHY: Axiad, row 3c476629, 2026-10-24 13:46 IST. The submit POST answered 428 and, in the
// same minute, Greenhouse emailed "Security code for your application to Axiad" ("paste this
// code into the security code field... then resubmit"). Nothing was submitted, yet the row
// landed as submit_outcome_unknown and went to needs_verification. These tests pin the fix:
// an exact 428 on a Greenhouse POST, with nothing else accepted, is a PROVABLE "not sent"
// and parks at blocked_needs_human with an action Teja can take. Everything else near it
// (another status, another host, a second accepted write) stays unknown: fail closed.
//
// NO REAL NETWORK. The real captured form is served from the local fixture server; every
// other request is aborted unless a test routes it, and the "Greenhouse" endpoint is a
// page.route answer. Nothing here can reach Greenhouse or submit anything.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, test, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
import { createPlaywrightPage } from '../src/playwright-page.ts';
// The function that writes the park, its page/gateway seams, and the exact action text.
import { applyToOne, SECURITY_CODE_ACTION, type ApplicationPage, type ApplierGateway, type SubmitResult } from '../src/apply-one.ts';
// A real-shaped tailored resume, so the run reaches the submit.
import { syntheticResume } from './resolved-resume-fixture.ts';
// Every live run needs an open re-check config (B2 fails closed without one).
import { OPEN_RECHECK } from './open-pregate.ts';

// ---- applyToOne: what the named outcome writes ----------------------------------------

/* A plain, answerable form page whose submit answers `result`. */
function fakePage(result: SubmitResult): ApplicationPage {
  // Only what applyToOne calls; the submit answer is the subject.
  return {
    goto: async () => {},
    // One answerable field, so the run reaches the submit.
    extractFields: async () => [{ id: 'first_name', label: 'First Name', kind: 'text', required: true }] as never,
    fill: async () => {},
    attachFile: async () => {},
    screenshot: async () => new Uint8Array([1, 2, 3]),
    detectBlocker: async () => null,
    // The page's verdict, as playwright-page.ts would hand it back.
    submit: vi.fn(async () => result),
    submissionImplemented: true,
    // Live posting: the B2 liveness check passes.
    postingClosed: async () => null,
  };
}

/* A gateway that records every status write with its detail. */
function recordingGateway() {
  // to + detail, in order.
  const writes: { to: string; detail: Record<string, unknown> | undefined }[] = [];
  // Resolves like supabase-js on success; nothing here fails.
  const gateway: ApplierGateway = {
    advanceStatus: async (_id, to, _agent, detail) => { writes.push({ to, detail }); },
    releaseClaim: async () => {},
    uploadScreenshot: async () => 'screens/app-1.png',
    uploadResume: async () => 'resumes/app-1.pdf',
    setArtifactPaths: async () => {},
  };
  // Both.
  return { gateway, writes };
}

/* One live run (DRY_RUN=false) of applyToOne over the given page. */
function run(page: ApplicationPage, gateway: ApplierGateway) {
  // The Axiad row shape: a Greenhouse board, approved, carrying its tailored resume.
  return applyToOne({
    row: { id: 'app-1', status: 'approved', applyUrl: 'https://job-boards.greenhouse.io/axiad/jobs/1', tailoredProfile: syntheticResume, employerName: 'Axiad', atsProvider: 'greenhouse' } as never,
    page,
    gateway,
    // The answer for the one field.
    answers: [{ question_key: 'first_name', answer_value: 'Teja', needs_human: false, answer_type: 'text' }] as never,
    // Live: the submit path runs.
    env: { DRY_RUN: 'false' },
    renderResume: async () => ({ bytes: new Uint8Array([37, 80, 68, 70]), sha256: 'a'.repeat(64) }),
    // Robots allows; robots is not the subject.
    checkRobots: async () => ({ kind: 'allow' as const, reason: 'test', crawlDelayMs: null }),
    recheck: OPEN_RECHECK,
  });
}

describe('applyToOne — security_code_required', () => {
  it('parks applying -> blocked_needs_human as mfa, naming the action and the code', async () => {
    // The verdict playwright-page.ts returns for the Axiad 428.
    const { gateway, writes } = recordingGateway();
    const outcome = await run(fakePage({ kind: 'security_code_required', detail: 'Greenhouse answered HTTP 428; responses: 428 https://job-boards.greenhouse.io/axiad/jobs/1' }), gateway);

    // Through `applying`, then the one edge into the human queue: NOT left at applying.
    expect(writes.map((w) => w.to)).toEqual(['applying', 'blocked_needs_human']);
    // The positive shape of the park: the existing `mfa` reason, the machine code, the
    // action in Teja's words, which post-click case it was, and the proving responses.
    expect(writes[1]?.detail).toMatchObject({
      block_reason: 'mfa',
      code: 'security_code_required',
      reason: SECURITY_CODE_ACTION,
      unanswered: [SECURITY_CODE_ACTION],
      submit_result: 'security_code_required',
      submit_detail: expect.stringContaining('responses: 428'),
    });
    // The text Teja reads is exactly the agreed one.
    expect(SECURITY_CODE_ACTION).toBe("Greenhouse emailed a security code: enter it in the form's security code field and resubmit");
    // Counted as parked, with the reason the row carries.
    expect(outcome).toEqual({ kind: 'blocked', reason: 'mfa', blockers: [] });
  });

  it('an unconfirmed submit that merely MENTIONS 428 stays unknown (only the named kind parks)', async () => {
    // Guard against a text match creeping into apply-one: the decision is the kind, never the detail.
    const { gateway, writes } = recordingGateway();
    const outcome = await run(fakePage({ kind: 'unconfirmed', detail: 'responses: 428 https://example.com/apply' }), gateway);
    // Entered applying and wrote nothing after it: the sweeper routes it to a human check.
    expect(writes.map((w) => w.to)).toEqual(['applying']);
    // Reported as unknown.
    expect(outcome.kind).toBe('submit_outcome_unknown');
  });
});

// ---- playwright-page.ts submit(): when the named outcome is decided ---------------------

// One browser and one server for the file: launching per test costs ~0.5s each.
let browser: Browser;
let server: FixtureServer;

beforeAll(async () => {
  // Headless Chromium, as the worker runs it on Actions.
  browser = await chromium.launch();
  // Serves worker/fixtures on 127.0.0.1, so the form has a real origin.
  server = await startFixtureServer('fixtures');
}, 60_000);

afterAll(async () => {
  // Optional chaining: a failed beforeAll must not mask its error here.
  await browser?.close();
  await server?.close();
});

// The job path the captured form is served at (the same capture submit-outcome-real-form uses).
const JOB_PATH = '/gitlab/jobs/8775507002';
// The captured Greenhouse form, scripts stripped at capture.
const FORM_HTML = readFileSync('fixtures/greenhouse/gitlab-8775507002-backend-india.html', 'utf8');
// A Greenhouse-hosted submit endpoint. Never reached: page.route answers it in the browser.
const GREENHOUSE_POST = 'https://job-boards.greenhouse.io/axiad/jobs/1/apply';

/* Open the real form behind a network fence, wrapped in the production adapter. */
async function openForm(timeoutMs: number): Promise<{ raw: Page; port: ReturnType<typeof createPlaywrightPage>; posts: string[] }> {
  // A fresh page per test, so routes never leak between cases.
  const raw = await browser.newPage();
  // The fixture server's origin, the only one answered by default.
  const origin = new URL(server.url).origin;
  // THE FENCE, first, so every later route takes precedence over it.
  await raw.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
  // The form at its job path.
  await raw.route((url) => url.pathname === JOB_PATH, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: FORM_HTML }));
  // Every POST the page sends, as "status url" once answered (non-vacuity for the send).
  const posts: string[] = [];
  // Short deadline: the negative cases end at it.
  const port = createPlaywrightPage(raw, { submitOutcomeTimeoutMs: timeoutMs });
  // Loaded at the job path, as the worker loads it.
  await port.goto(`${origin}${JOB_PATH}`);
  // The page, the adapter, and the POST log.
  return { raw, port, posts };
}

/* Answer POSTs to `url` (exact href) with `status`, logging each hit. */
async function answer(raw: Page, posts: string[], url: string, status: number): Promise<void> {
  // Exact href match, so other endpoints are untouched.
  await raw.route((u) => u.href === url, (route) => {
    // Logged, so each test proves the POST really left the page.
    posts.push(`${route.request().method()} ${status} ${url}`);
    // A JSON body like Greenhouse's; CORS allowed so the page's fetch completes normally.
    return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
}

/* Make the form's submit POST to each URL in turn (async, staying on the page, like Greenhouse). */
async function submitPosts(raw: Page, urls: string[], flagAfter = false): Promise<void> {
  // Installed in the page: the click runs this instead of a navigation.
  await raw.evaluate(({ urls, flagAfter }) => {
    // The one form on the page, by its captured id.
    const form = document.getElementById('application-form') as HTMLFormElement;
    // Native validation off, so the listener is what runs.
    form.noValidate = true;
    form.addEventListener('submit', (event) => {
      // No navigation whatever the responses.
      event.preventDefault();
      // Sequential, so a second POST is sent after the first is answered.
      void (async () => {
        for (const url of urls) await fetch(url, { method: 'POST', body: '{}' }).catch(() => {});
        // Optionally flag a field, as a page showing a security-code input might.
        if (flagAfter) form.querySelector('input')?.setAttribute('aria-invalid', 'true');
      })();
    });
  }, { urls, flagAfter });
}

describe('submit() — Greenhouse HTTP 428 security-code gate (real Chromium)', () => {
  test('a Greenhouse POST answered 428 -> security_code_required, with the response named', async () => {
    // THE AXIAD CASE.
    const { raw, port, posts } = await openForm(5_000);
    try {
      await answer(raw, posts, GREENHOUSE_POST, 428);
      await submitPosts(raw, [GREENHOUSE_POST]);
      const result = await port.submit();
      // The named, provable "not sent".
      expect(result.kind).toBe('security_code_required');
      // The detail carries the status and endpoint that proved it.
      if (result.kind === 'security_code_required') expect(result.detail).toContain(`responses: 428 ${GREENHOUSE_POST}`);
      // Non-vacuity: the POST really happened, once.
      expect(posts).toEqual([`POST 428 ${GREENHOUSE_POST}`]);
    } finally {
      await raw.close();
    }
  });

  test('428 then a flagged field (a security-code input) -> still security_code_required', async () => {
    // Without the 428 branch running first, "fields flagged after a send" would make it unknown.
    const { raw, port, posts } = await openForm(5_000);
    try {
      await answer(raw, posts, GREENHOUSE_POST, 428);
      await submitPosts(raw, [GREENHOUSE_POST], true);
      const result = await port.submit();
      expect(result.kind).toBe('security_code_required');
      expect(posts).toHaveLength(1);
    } finally {
      await raw.close();
    }
  });

  test('a 428 from a NON-Greenhouse host stays unconfirmed (only Greenhouse 428 was measured)', async () => {
    // Same-origin endpoint on 127.0.0.1: a generic "Precondition Required" proves nothing.
    const { raw, port, posts } = await openForm(3_000);
    try {
      const other = `${new URL(server.url).origin}${JOB_PATH}/apply`;
      await answer(raw, posts, other, 428);
      await submitPosts(raw, [other]);
      const result = await port.submit();
      expect(result.kind).toBe('unconfirmed');
      // Non-vacuity: the 428 really came back and is named as evidence only.
      if (result.kind === 'unconfirmed') expect(result.detail).toContain('responses: 428');
      expect(posts).toHaveLength(1);
    } finally {
      await raw.close();
    }
  });

  test('a Greenhouse POST answered 422 (not exactly 428) stays unconfirmed', async () => {
    // Exactness: a neighbouring status is not the gate.
    const { raw, port, posts } = await openForm(3_000);
    try {
      await answer(raw, posts, GREENHOUSE_POST, 422);
      await submitPosts(raw, [GREENHOUSE_POST]);
      const result = await port.submit();
      expect(result.kind).toBe('unconfirmed');
      expect(posts).toHaveLength(1);
    } finally {
      await raw.close();
    }
  });

  test('a Greenhouse 428 plus a second POST answered 200 stays unconfirmed (something was accepted)', async () => {
    // An accepted write could be a stored application: never "not sent".
    const { raw, port, posts } = await openForm(3_000);
    try {
      const second = 'https://job-boards.greenhouse.io/axiad/jobs/1/apply-again';
      await answer(raw, posts, GREENHOUSE_POST, 428);
      await answer(raw, posts, second, 200);
      // The 200 first, then the 428: both are in the log before the 428 can decide.
      await submitPosts(raw, [second, GREENHOUSE_POST]);
      const result = await port.submit();
      expect(result.kind).toBe('unconfirmed');
      // Both POSTs really happened.
      expect(posts).toHaveLength(2);
    } finally {
      await raw.close();
    }
  });
});
