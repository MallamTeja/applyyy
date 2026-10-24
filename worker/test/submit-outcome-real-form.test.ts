// submit() and detectBlocker() against the REAL captured Greenhouse form, in
// real Chromium.
//
// WHY A REAL BROWSER. submit() is the one function that sends an application,
// and every answer it gives is a reading of a live page: a URL after a
// redirect, a heading, an aria-invalid flag, an iframe's visibility, a request
// leaving the page. A fake page would let each of those be whatever the test
// wanted; here they are what Chromium actually reports for the form the worker
// will really meet.
//
// NO REAL NETWORK. Every request not addressed to the local fixture server is
// aborted unless a test routes it explicitly, and the form's own submit target
// is answered by page.route. Nothing in this file can reach Greenhouse, Google,
// or anyone else.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
import { createPlaywrightPage } from '../src/playwright-page.ts';

// One browser and one server for the file: launching per test costs ~0.5s each.
let browser: Browser;
let server: FixtureServer;

beforeAll(async () => {
  // Headless Chromium, as the worker runs it on Actions.
  browser = await chromium.launch();
  // Serves worker/fixtures on 127.0.0.1, so the form has a real origin to live on.
  server = await startFixtureServer('fixtures');
}, 60_000);

afterAll(async () => {
  // Optional chaining: a failed beforeAll must not mask its error with a TypeError here.
  await browser?.close();
  await server?.close();
});

// The job's own path. The form is SERVED here, because submit() only accepts a
// confirmation at the form's own path + '/confirmation', on the form's origin.
const JOB_PATH = '/gitlab/jobs/8775507002';
// This job's confirmation route: the only one that may confirm.
const CONFIRMATION_PATH = `${JOB_PATH}/confirmation`;
// The captured form, read once. Scripts were stripped at capture.
const FORM_HTML = readFileSync('fixtures/greenhouse/gitlab-8775507002-backend-india.html', 'utf8');

/**
 * Open the real form at its real job path, behind a network fence, wrapped in
 * the production adapter.
 *
 * Returns the raw page (for routing and DOM set-up), the adapter under test,
 * and a log of every SUBMIT of the form (its GET with a query string), which is
 * how the "nothing was clicked" tests prove nothing was sent.
 */
// settleMs: the "nothing was sent" settle window; undefined keeps the production 5s.
async function openForm(timeoutMs = 10_000, settleMs?: number): Promise<{
  raw: Page;
  port: ReturnType<typeof createPlaywrightPage>;
  actionHits: string[];
}> {
  // A fresh page per test, so routes and listeners never leak between cases.
  const raw = await browser.newPage();
  // The fixture server's origin: the ONLY one allowed to answer by default.
  const origin = new URL(server.url).origin;
  // THE FENCE, registered first so every route below takes precedence
  // (Playwright runs the most recently registered matching route first).
  await raw.route('**/*', (route) =>
    // Same origin goes to the fixture server; everything else is aborted.
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  // The form itself, at the job path with NO "?": the page load, not a submit.
  // The literal "?" is the discriminator, NOT `url.search`: the captured inputs
  // carry no `name`, so the GET submit is `<path>?` with an EMPTY search, and a
  // `search === ''` test would serve the form again in place of the submit.
  await raw.route(
    // Disjoint from onSubmit's predicate, which requires the "?".
    (url) => url.pathname === JOB_PATH && !url.href.includes('?'),
    // The captured bytes, served as the board would serve them.
    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: FORM_HTML }),
  );
  // Every submit of the form (the GET action carries the fields as a query).
  const actionHits: string[] = [];
  raw.on('request', (request) => {
    // Parsed once for both checks.
    const url = new URL(request.url());
    // The job path WITH a "?" is the form being sent; the bare path is the page load.
    if (url.pathname === JOB_PATH && url.href.includes('?')) actionHits.push(request.url());
  });
  // The adapter the worker really runs, with a test-sized deadline.
  // Spread so an absent settleMs is truly absent (exactOptionalPropertyTypes), not undefined.
  const port = createPlaywrightPage(raw, { submitOutcomeTimeoutMs: timeoutMs, ...(settleMs === undefined ? {} : { rejectionSettleMs: settleMs }) });
  // Loaded at the job path, so the expected confirmation path is derived from it.
  await port.goto(`${origin}${JOB_PATH}`);
  // The page, the adapter, and the submit log.
  return { raw, port, actionHits };
}

/**
 * Turn off native constraint validation on the captured form.
 *
 * The capture carries React-Select's hidden `required` helper inputs, which
 * the stripped scripts would normally fill when an option is chosen. Left
 * empty, Chromium's own validation blocks the submit before any request, so a
 * test of what happens AFTER a sent form must disable it.
 */
async function allowNativeSubmit(raw: Page): Promise<void> {
  // noValidate is the form-level switch for constraint validation.
  await raw.evaluate(() => {
    // The one form on the page, by its captured id.
    (document.getElementById('application-form') as HTMLFormElement).noValidate = true;
  });
}

/** Route the form's GET submit (the job path WITH a "?", see openForm) to a handler. */
async function onSubmit(raw: Page, handler: Parameters<Page['route']>[1]): Promise<void> {
  // A predicate rather than a glob, so a literal "?" in a pattern is never in question.
  await raw.route((url) => url.pathname === JOB_PATH && url.href.includes('?'), handler);
}

/**
 * A submit handler that answers with a CLIENT-SIDE redirect to `path`.
 *
 * Not a 302: Playwright follows a fulfilled 302, but the routed fulfil of the
 * redirect target then arrives with an EMPTY body (measured: the page lands on
 * the right URL showing nothing). A heading test against that page would pass
 * or fail for the wrong reason, so the redirect is done by the page instead.
 */
function redirectTo(path: string): Parameters<Page['route']>[1] {
  // JSON.stringify quotes the path safely for the inline script.
  return (route) => route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(path)})</script>` });
}

/** Serve a page at a path on the fixture origin. */
async function servePath(raw: Page, path: string, body: string): Promise<void> {
  // Exact pathname match, so neighbouring routes are unaffected.
  await raw.route((url) => url.pathname === path, (route) =>
    // Minimal HTML: only the features submit() is allowed to rely on.
    route.fulfill({ status: 200, contentType: 'text/html', body }),
  );
}

describe('submit() on the real Greenhouse form', () => {
  test('submit: confirmation page with thank-you heading → confirmed', async () => {
    // THE ONLY PATH TO `applied`. Every half of the positive shape is present:
    // same origin, exactly this job's confirmation path, and a thank-you heading.
    const { raw, port, actionHits } = await openForm();
    try {
      // The form submits for real once validation is out of the way.
      await allowNativeSubmit(raw);
      // The board answers the submit with a redirect to this job's confirmation.
      await onSubmit(raw, redirectTo(CONFIRMATION_PATH));
      // And the confirmation route shows the thank-you heading.
      await servePath(raw, CONFIRMATION_PATH, '<h1>Thank you for applying</h1>');

      // The real adapter's click and poll.
      const result = await port.submit();

      // Confirmed, with evidence naming the URL it matched.
      expect(result.kind).toBe('confirmed');
      if (result.kind === 'confirmed') expect(result.evidence).toContain(CONFIRMATION_PATH);
      // Non-vacuity: the form really was sent once.
      expect(actionHits).toHaveLength(1);
    } finally {
      // Closed even on failure, so a stuck page cannot hold the browser open.
      await raw.close();
    }
  });

  test('submit: confirmation path WITHOUT the heading → unconfirmed', async () => {
    // THE POSITIVE-SHAPE TEST. A URL alone is not proof: a redirect to a path
    // that merely looks like a confirmation must never become `applied`, which
    // is the one wrong answer that cannot be walked back.
    const { raw, port } = await openForm(1500);
    try {
      // The form submits for real once validation is out of the way.
      await allowNativeSubmit(raw);
      // Same redirect as the confirmed case...
      await onSubmit(raw, redirectTo(CONFIRMATION_PATH));
      // ...to a page with no thank-you heading.
      await servePath(raw, CONFIRMATION_PATH, '<h1>Something went wrong</h1><p>confirmation</p>');

      // Polls until the short deadline.
      const result = await port.submit();

      // No proof, so no `confirmed`.
      expect(result.kind).toBe('unconfirmed');
      // And the detail says the path matched but the heading did not, for the log.
      if (result.kind === 'unconfirmed') expect(result.detail).toContain('no thank-you heading');
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('submit: confirmation for a DIFFERENT job → unconfirmed', async () => {
    // A thank-you on SOME job's confirmation page is not proof that THIS job's
    // form was sent (a stale tab, a redirect to another posting). The path must
    // be this form's own path + '/confirmation'.
    const otherConfirmation = '/gitlab/jobs/1111/confirmation';
    // The short deadline: the outcome is the timeout.
    const { raw, port } = await openForm(1500);
    try {
      // The form submits for real once validation is out of the way.
      await allowNativeSubmit(raw);
      // Redirected to another job's confirmation...
      await onSubmit(raw, redirectTo(otherConfirmation));
      // ...which DOES carry the heading, so only the path check can refuse it.
      await servePath(raw, otherConfirmation, '<h1>Thank you for applying</h1>');

      // Polls until the short deadline.
      const result = await port.submit();

      // Not this job's confirmation, so unknown.
      expect(result.kind).toBe('unconfirmed');
      // Non-vacuity: the page really did reach the other confirmation.
      expect(new URL(raw.url()).pathname).toBe(otherConfirmation);
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('a Gusto-style \'Thanks for applying!\' heading with the standard title confirms', async () => {
    // REAL GREENHOUSE WORDING. Gusto's confirmation shows "Thanks for applying!"
    // in its h1 while the page title keeps the standard "Thank you for applying".
    // A heading-only /thank you for applying/ check parks a SENT application as
    // unknown, so the title (or the "thanks" heading) must be able to confirm.
    const { raw, port, actionHits } = await openForm();
    try {
      // The form submits for real once validation is out of the way.
      await allowNativeSubmit(raw);
      // The board answers the submit with a redirect to this job's confirmation.
      await onSubmit(raw, redirectTo(CONFIRMATION_PATH));
      // The confirmation exactly as Gusto renders it: standard title, informal heading.
      await servePath(raw, CONFIRMATION_PATH, '<title>Thank you for applying</title><h1>Thanks for applying!</h1>');

      // The real adapter's click and poll.
      const result = await port.submit();

      // Confirmed: right path, a real send, and a recognised thank-you.
      expect(result.kind).toBe('confirmed');
      // The evidence still names the URL it matched, for the audit trail.
      if (result.kind === 'confirmed') expect(result.evidence).toContain(CONFIRMATION_PATH);
      // Non-vacuity: the form really was sent once.
      expect(actionHits).toHaveLength(1);
    } finally {
      // Closed even on failure, so a stuck page cannot hold the browser open.
      await raw.close();
    }
  });

  test('the title alone without an employer request is NOT confirmed', async () => {
    // THE EMPLOYER-WRITE GUARD. Path and title can both be faked client-side
    // with no request leaving the page (pushState plus a title change), so the
    // new title check must not stand in for proof that something was sent.
    // The short deadline: the outcome is the timeout.
    const { raw, port, actionHits } = await openForm(1500);
    try {
      // Validation off, so the listener below is what handles the click.
      await allowNativeSubmit(raw);
      // A submit handler that fakes a confirmation without any network traffic.
      await raw.evaluate((confirmationPath) => {
        // The one form on the page, by its captured id.
        const form = document.getElementById('application-form') as HTMLFormElement;
        // Runs on the adapter's real click, standing in for a SPA's submit handler.
        form.addEventListener('submit', (event) => {
          // No navigation, so no request: the send never happens.
          event.preventDefault();
          // pushState changes the URL without a request, giving the right path.
          history.pushState(null, '', confirmationPath);
          // And the right title, so only the employer-write check can refuse.
          document.title = 'Thank you for applying';
        });
      }, CONFIRMATION_PATH);

      // Polls until the short deadline.
      const result = await port.submit();

      // Nothing was sent, so nothing can be confirmed.
      expect(result.kind).toBe('unconfirmed');
      // Non-vacuity: the page really did reach this job's confirmation path...
      expect(new URL(raw.url()).pathname).toBe(CONFIRMATION_PATH);
      // ...with the standard thank-you title...
      expect(await raw.title()).toBe('Thank you for applying');
      // ...and the form was provably never submitted.
      expect(actionHits).toHaveLength(0);
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('a wrong path with the right title is NOT confirmed', async () => {
    // The title check must not widen the path rule: a thank-you title on
    // ANOTHER job's confirmation is still not proof that THIS form was sent.
    const otherConfirmation = '/gitlab/jobs/1111/confirmation';
    // The short deadline: the outcome is the timeout.
    const { raw, port } = await openForm(1500);
    try {
      // The form submits for real once validation is out of the way.
      await allowNativeSubmit(raw);
      // Redirected to another job's confirmation...
      await onSubmit(raw, redirectTo(otherConfirmation));
      // ...carrying the title but no heading, so only the title can match and only the path can refuse.
      await servePath(raw, otherConfirmation, '<title>Thank you for applying</title><p>Your application was received.</p>');

      // Polls until the short deadline.
      const result = await port.submit();

      // Not this job's confirmation, so unknown.
      expect(result.kind).toBe('unconfirmed');
      // Non-vacuity: the page really did reach the other confirmation...
      expect(new URL(raw.url()).pathname).toBe(otherConfirmation);
      // ...and it really carried the thank-you title.
      expect(await raw.title()).toBe('Thank you for applying');
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('the standard title alone, after a real send, confirms and says so', async () => {
    // PINS THE TITLE HALF on its own. The Gusto test above carries both a title and
    // a "Thanks" heading, so it stays green if either half is removed; this page has
    // no heading at all, so only the title fallback can confirm it.
    const { raw, port, actionHits } = await openForm();
    try {
      // The form submits for real once validation is out of the way.
      await allowNativeSubmit(raw);
      // The board answers the submit with a redirect to this job's confirmation.
      await onSubmit(raw, redirectTo(CONFIRMATION_PATH));
      // An employer whose rich text has no heading: the template title is the only signal.
      await servePath(raw, CONFIRMATION_PATH, '<title>Thank you for applying</title><p>We will be in touch.</p>');

      // The real adapter's click and poll.
      const result = await port.submit();

      // Confirmed by the title.
      expect(result.kind).toBe('confirmed');
      // The evidence names the title as its source, so the `applied` event is auditable.
      if (result.kind === 'confirmed') expect(result.evidence).toContain('title="Thank you for applying"');
      // Non-vacuity: the form really was sent once.
      expect(actionHits).toHaveLength(1);
    } finally {
      // Closed even on failure, so a stuck page cannot hold the browser open.
      await raw.close();
    }
  });

  test('a "Thanks for applying!" heading under a non-template title confirms by heading', async () => {
    // PINS THE WIDENED HEADING on its own. The title here is not Greenhouse's
    // template, so only /thank(s| you) for applying/ on the h1 can confirm it.
    const { raw, port, actionHits } = await openForm();
    try {
      // The form submits for real once validation is out of the way.
      await allowNativeSubmit(raw);
      // The board answers the submit with a redirect to this job's confirmation.
      await onSubmit(raw, redirectTo(CONFIRMATION_PATH));
      // An employer-branded title, with the informal heading.
      await servePath(raw, CONFIRMATION_PATH, '<title>Acme Careers</title><h1>Thanks for applying!</h1>');

      // The real adapter's click and poll.
      const result = await port.submit();

      // Confirmed by the heading.
      expect(result.kind).toBe('confirmed');
      // The evidence names the heading as its source, quoted exactly.
      if (result.kind === 'confirmed') expect(result.evidence).toContain('heading="Thanks for applying!"');
      // Non-vacuity: the form really was sent once.
      expect(actionHits).toHaveLength(1);
    } finally {
      // Closed even on failure, so a stuck page cannot hold the browser open.
      await raw.close();
    }
  });

  test('submit: inline validation with no navigation → rejected_by_form', async () => {
    // The live Greenhouse form validates in JS: it cancels the submit and flags
    // the fields with aria-invalid. Nothing left the page, so this is a human's
    // fix and safe to park, naming the field by the label the human knows.
    const { raw, port, actionHits } = await openForm();
    try {
      // Stands in for the stripped React validation, using the same attribute.
      await raw.evaluate(() => {
        // The one form on the page.
        const form = document.getElementById('application-form') as HTMLFormElement;
        // Native validation off, so the JS listener is what refuses (as live).
        form.noValidate = true;
        form.addEventListener('submit', (event) => {
          // The send is cancelled in the browser.
          event.preventDefault();
          // And one labelled field is flagged, as Greenhouse flags it.
          document.getElementById('email')?.setAttribute('aria-invalid', 'true');
        });
      });

      // The real adapter's click and poll.
      const result = await port.submit();

      // Rejected by the form, naming the flagged field's label.
      expect(result.kind).toBe('rejected_by_form');
      if (result.kind === 'rejected_by_form') expect(result.labels).toContain('Email');
      // Provably not sent.
      expect(actionHits).toEqual([]);
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('submit: field errors AFTER an employer POST → unconfirmed, never rejected_by_form', async () => {
    // THE H1 CASE. A form can send by async POST and THEN show server-side
    // field errors. The page looks exactly like a browser-side rejection, but
    // the application may be stored. "Blocked" claims nothing was sent, so it
    // needs proof; a non-captcha POST destroys that proof.
    const { raw, port } = await openForm();
    // Every hit on the employer's POST endpoint (non-vacuity for the send).
    const posts: string[] = [];
    try {
      // The employer's async submit endpoint answers 200, as a real one would.
      await raw.route((url) => url.pathname === `${JOB_PATH}/apply`, (route) => {
        // Recorded so the test proves the POST really left the page.
        posts.push(route.request().method());
        // Accepted by the "server".
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      // A submit handler that POSTs, then flags a field from the "response".
      await raw.evaluate((jobPath) => {
        // The one form on the page.
        const form = document.getElementById('application-form') as HTMLFormElement;
        // Native validation off, so the listener is what runs.
        form.noValidate = true;
        form.addEventListener('submit', (event) => {
          // No navigation: the async path, as a SPA form submits.
          event.preventDefault();
          // The POST first, the field error only after its response.
          void fetch(`${jobPath}/apply`, { method: 'POST' }).then(() => {
            // Server-side validation, shown after the send.
            document.getElementById('email')?.setAttribute('aria-invalid', 'true');
          });
        });
      }, JOB_PATH);

      // The real adapter's click and poll.
      const result = await port.submit();

      // Unknown, never a park that claims the application did not go out.
      expect(result.kind).toBe('unconfirmed');
      // The detail names the write, so the human verifying knows a POST happened.
      if (result.kind === 'unconfirmed') expect(result.detail).toContain(`POST`);
      // Non-vacuity: the POST really happened.
      expect(posts).toEqual(['POST']);
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('submit: a POST the server REFUSES (captcha-failed) → unconfirmed whose detail names the status and code', async () => {
    // THE GITLAB CASE (run 40073654094). Greenhouse's job-boards client navigates to
    // /confirmation only on a 2xx POST; a reCAPTCHA refusal comes back non-2xx with a
    // JSON `code` and the page stays put, flagging no field. The verdict stays unknown
    // (a stored application cannot be ruled out from here), but the detail must carry
    // the response so the human verifying it sees WHY instead of "45000ms, url=…".
    const { raw, port } = await openForm(3_000);
    // Every hit on the employer's POST endpoint (non-vacuity for the send).
    const posts: string[] = [];
    try {
      // The refusal, shaped like Greenhouse's: non-2xx JSON with a machine-readable code.
      await raw.route((url) => url.pathname === `${JOB_PATH}/apply`, (route) => {
        // Recorded so the test proves the POST really left the page.
        posts.push(route.request().method());
        // The status and body the worker must surface.
        return route.fulfill({ status: 422, contentType: 'application/json', body: '{"code":"captcha-failed","security_code_recipient":"t***@example.com"}' });
      });
      // A submit handler that POSTs and, like Greenhouse on a refusal, stays on the page.
      await raw.evaluate((jobPath) => {
        // The one form on the page.
        const form = document.getElementById('application-form') as HTMLFormElement;
        // Native validation off, so the listener is what runs.
        form.noValidate = true;
        // Async submit: no navigation whatever the response.
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          void fetch(`${jobPath}/apply`, { method: 'POST', body: '{}' });
        });
      }, JOB_PATH);

      // The real adapter's click and poll, to the deadline.
      const result = await port.submit();

      // Still unknown: the verdict policy is unchanged.
      expect(result.kind).toBe('unconfirmed');
      // The response is named: status, endpoint and the board's own code.
      if (result.kind === 'unconfirmed') {
        expect(result.detail).toContain('responses: 422');
        expect(result.detail).toContain('code=captcha-failed');
      }
      // Non-vacuity: the POST really happened.
      expect(posts).toEqual(['POST']);
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('submit: a refused POST with a non-JSON body → the status is named, no code is invented', async () => {
    // A WAF or proxy page answers HTML. The status is still evidence; a `code` parsed
    // out of non-JSON would be made up (§6: a lenient parser's guess is not an answer).
    const { raw, port } = await openForm(3_000);
    try {
      // An HTML 403, as a firewall in front of a board would send.
      await raw.route((url) => url.pathname === `${JOB_PATH}/apply`, (route) =>
        route.fulfill({ status: 403, contentType: 'text/html', body: '<html>Access denied</html>' }),
      );
      // Same async submit that stays on the page.
      await raw.evaluate((jobPath) => {
        const form = document.getElementById('application-form') as HTMLFormElement;
        form.noValidate = true;
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          void fetch(`${jobPath}/apply`, { method: 'POST', body: '{}' });
        });
      }, JOB_PATH);

      const result = await port.submit();

      expect(result.kind).toBe('unconfirmed');
      if (result.kind === 'unconfirmed') {
        // The status, named.
        expect(result.detail).toContain('responses: 403');
        // And no code, because none was sent.
        expect(result.detail).not.toContain('code=');
      }
    } finally {
      await raw.close();
    }
  });

  test('submit: field flagged FIRST, then a POST 500ms later → unconfirmed, never rejected_by_form', async () => {
    // THE SECOND REVIEW'S M-1. A validate-on-blur script can flag a field the
    // instant Submit takes focus, while the form's own handler is still waiting on
    // the reCAPTCHA token and POSTs a moment later. One look would see "flagged,
    // nothing sent" and park a SENT application; the settle window must catch the
    // late POST and answer unknown instead.
    // A 2s settle and a 10s deadline: the POST at 500ms lands well inside the window.
    const { raw, port } = await openForm(10_000, 2_000);
    // Every hit on the employer's POST endpoint (non-vacuity for the send).
    const posts: string[] = [];
    try {
      // The employer's async submit endpoint answers 200.
      await raw.route((url) => url.pathname === `${JOB_PATH}/apply`, (route) => {
        // Recorded so the test proves the POST really left the page.
        posts.push(route.request().method());
        // Accepted by the "server".
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      // A handler that flags first and POSTs 500ms later, the blur-then-token race.
      await raw.evaluate((jobPath) => {
        // The one form on the page.
        const form = document.getElementById('application-form') as HTMLFormElement;
        // Native validation off, so the listener is what runs.
        form.noValidate = true;
        form.addEventListener('submit', (event) => {
          // No navigation: the async path.
          event.preventDefault();
          // The flag, immediately: what one look would see.
          document.getElementById('email')?.setAttribute('aria-invalid', 'true');
          // The real send, after the "token" delay.
          setTimeout(() => void fetch(`${jobPath}/apply`, { method: 'POST' }), 500);
        });
      }, JOB_PATH);

      // The real adapter's click and poll.
      const result = await port.submit();

      // Unknown: a field was flagged, but the application left afterwards.
      expect(result.kind).toBe('unconfirmed');
      // Non-vacuity: the late POST really happened.
      expect(posts).toEqual(['POST']);
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('submit: a POST AFTER the settle window is blocked, so "rejected" stays true', async () => {
    // THE RE-REVIEW'S F1. The window only proves "nothing yet": a handler still
    // awaiting a slow reCAPTCHA token could POST after it, while the row is being
    // written as blocked. submit() seals the context before answering, so that late
    // POST must never reach the employer. Settle 1s; the POST fires at 2.5s, after it.
    const { raw, port } = await openForm(10_000, 1_000);
    // Every request that REACHES the employer's endpoint (the claim under test: none).
    const posts: string[] = [];
    try {
      // The employer's endpoint; anything that arrives here was really sent.
      await raw.route((url) => url.pathname === `${JOB_PATH}/apply`, (route) => {
        // Recorded: a hit here would make "rejected_by_form" a lie.
        posts.push(route.request().method());
        // Accepted, as a real endpoint would.
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      // Flag at once, POST well after the settle window.
      await raw.evaluate((jobPath) => {
        // The one form on the page.
        const form = document.getElementById('application-form') as HTMLFormElement;
        // Native validation off, so the listener is what runs.
        form.noValidate = true;
        form.addEventListener('submit', (event) => {
          // No navigation: the async path.
          event.preventDefault();
          // The flag a one-look reader would act on.
          document.getElementById('email')?.setAttribute('aria-invalid', 'true');
          // The late send; its rejection (aborted) is swallowed like a real page would.
          setTimeout(() => void fetch(`${jobPath}/apply`, { method: 'POST' }).catch(() => undefined), 2_500);
        });
      }, JOB_PATH);

      // The real adapter: it settles at ~1s and seals before answering.
      const result = await port.submit();
      // A browser-side rejection, as before.
      expect(result.kind).toBe('rejected_by_form');
      // Wait past the late POST's timer, so it has had every chance to go out.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      // THE PROPERTY: it never arrived. "Nothing was sent" is true, not just likely.
      expect(posts).toEqual([]);
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('submit: hang → unconfirmed', async () => {
    // A submit whose response never comes back. The request may well have
    // reached the employer, so the only honest answer is "unknown": never
    // `confirmed`, never a park that claims it was not sent.
    const { raw, port, actionHits } = await openForm(1500);
    try {
      // The form submits for real once validation is out of the way.
      await allowNativeSubmit(raw);
      // The route is held open and never answered.
      await onSubmit(raw, () => {
        // Deliberately neither fulfilled, continued nor aborted.
      });

      // Polls until the short deadline.
      const result = await port.submit();

      // Unknown, the direction every unfamiliar outcome must fail.
      expect(result.kind).toBe('unconfirmed');
      // Non-vacuity: the click did send a request; it just never returned.
      expect(actionHits).toHaveLength(1);
    } finally {
      // Closing abandons the pending route.
      await raw.close();
    }
  });

  test('submit: visible captcha challenge after click → challenge', async () => {
    // Invisible reCAPTCHA scores the browser on Submit and may escalate to a
    // visible challenge. Constraint #5: never solved, routed to a human.
    const { raw, port, actionHits } = await openForm();
    try {
      // The challenge appears in place of the send, as Google's would.
      await raw.evaluate(() => {
        // The one form on the page.
        const form = document.getElementById('application-form') as HTMLFormElement;
        // Native validation off, so the listener below is what runs.
        form.noValidate = true;
        form.addEventListener('submit', (event) => {
          // The send is held while the challenge is shown.
          event.preventDefault();
          // A visible challenge frame, titled the way reCAPTCHA titles it.
          const frame = document.createElement('iframe');
          // The title is what the challenge selector keys on.
          frame.title = 'recaptcha challenge expires in two minutes';
          // Sized like the real challenge, so it is visible.
          frame.style.width = '300px';
          frame.style.height = '300px';
          // Inline content: no network request for the frame.
          frame.srcdoc = '<p>select all images with traffic lights</p>';
          // On the page, where the poll will see it.
          document.body.appendChild(frame);
        });
      });

      // The real adapter's click and poll.
      const result = await port.submit();

      // A challenge, carrying the captcha reason.
      expect(result).toEqual({ kind: 'challenge', reason: 'captcha' });
      // Not sent.
      expect(actionHits).toEqual([]);
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('submit: captcha-provider POST does not count as a send', async () => {
    // reCAPTCHA itself POSTs to Google while scoring. That traffic is not the
    // application, so it must not turn a provable "not sent" challenge into an
    // unknown that sends Teja to check an employer site for nothing.
    const reloadUrl = 'https://www.google.com/recaptcha/api2/reload';
    const { raw, port } = await openForm();
    // Every hit on the provider endpoint (non-vacuity for the exemption).
    const providerPosts: string[] = [];
    try {
      // Answered locally: the fence would otherwise abort it, and nothing may reach Google.
      await raw.route(reloadUrl, (route) => {
        // Recorded so the test proves the POST really left the page.
        providerPosts.push(route.request().method());
        // CORS header so the cross-origin fetch resolves cleanly in the page.
        return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: 'ok' });
      });
      // A submit handler that POSTs to the provider, then shows its challenge.
      await raw.evaluate((url) => {
        // The one form on the page.
        const form = document.getElementById('application-form') as HTMLFormElement;
        // Native validation off, so the listener is what runs.
        form.noValidate = true;
        form.addEventListener('submit', (event) => {
          // The send is held while Google decides.
          event.preventDefault();
          // Scoring traffic first; a failure would still have sent the request.
          void fetch(url, { method: 'POST' }).catch(() => undefined).then(() => {
            // Then the visible challenge, as an escalation looks.
            const frame = document.createElement('iframe');
            // The title the challenge selector keys on.
            frame.title = 'recaptcha challenge expires in two minutes';
            // Visible size.
            frame.style.width = '300px';
            frame.style.height = '300px';
            // Inline content, no network.
            frame.srcdoc = '<p>challenge</p>';
            // On the page.
            document.body.appendChild(frame);
          });
        });
      }, reloadUrl);

      // The real adapter's click and poll.
      const result = await port.submit();

      // Still a challenge: provider traffic is not an employer write.
      expect(result).toEqual({ kind: 'challenge', reason: 'captcha' });
      // Non-vacuity: the provider POST really happened.
      expect(providerPosts).toEqual(['POST']);
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('submit: two submit controls → not_attempted, nothing clicked', async () => {
    // With two VISIBLE submit buttons we cannot know which one sends (a "save
    // draft" beside "submit"), so the adapter must refuse before any click.
    const { raw, port, actionHits } = await openForm();
    try {
      // Validation off, so a click WOULD send: the refusal is the only guard.
      await allowNativeSubmit(raw);
      // A second, visible submit control inside the form.
      await raw.evaluate(() => {
        // Built rather than parsed, so no markup quoting is involved.
        const extra = document.createElement('button');
        // A real submit control, the shape the count looks for.
        extra.type = 'submit';
        // A plausible second action, with text so it renders with a size.
        extra.textContent = 'Save draft';
        // Inside the form, where a click would send it.
        document.getElementById('application-form')?.appendChild(extra);
      });
      // Where the page was before the call.
      const before = raw.url();

      // The real adapter.
      const result = await port.submit();

      // Refused, as an unsupported form shape.
      expect(result).toMatchObject({ kind: 'not_attempted', reason: 'unsupported_form' });
      // Nothing was sent and the page did not move.
      expect(actionHits).toEqual([]);
      expect(raw.url()).toBe(before);
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('submit: a hidden extra submit button is ignored', async () => {
    // Boards ship hidden submit controls (templates, collapsed sections). Only
    // a VISIBLE one can be the button the applicant presses, so a hidden extra
    // must neither block the submit nor be the control clicked.
    const { raw, port, actionHits } = await openForm();
    try {
      // The form submits for real once validation is out of the way.
      await allowNativeSubmit(raw);
      // A second submit control, inside the form but hidden.
      await raw.evaluate(() => {
        // Built rather than parsed.
        const hidden = document.createElement('button');
        // A real submit control by type...
        hidden.type = 'submit';
        // ...that nobody can see or press.
        hidden.style.display = 'none';
        // Text, so only display:none (not emptiness) makes it invisible.
        hidden.textContent = 'Hidden';
        // Inside the form.
        document.getElementById('application-form')?.appendChild(hidden);
      });
      // The full confirmed path, so the result proves the visible button was the one clicked.
      await onSubmit(raw, redirectTo(CONFIRMATION_PATH));
      // This job's confirmation, with the heading.
      await servePath(raw, CONFIRMATION_PATH, '<h1>Thank you for applying</h1>');

      // The real adapter.
      const result = await port.submit();

      // Not refused: the hidden control does not count.
      expect(result.kind).toBe('confirmed');
      // Sent exactly once.
      expect(actionHits).toHaveLength(1);
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('submit: browser-native required field empty → not_attempted, nothing clicked', async () => {
    // The captured form as-is: React-Select's hidden `required` inputs are empty
    // and native validation is ON. Chromium would refuse the click without any
    // request or aria-invalid, which used to wait out the deadline and report
    // an UNKNOWN outcome for an application provably never sent.
    const { raw, port, actionHits } = await openForm();
    try {
      // Non-vacuity: the raw fixture really is natively invalid.
      expect(await raw.evaluate(() => (document.getElementById('application-form') as HTMLFormElement).checkValidity())).toBe(false);

      // The real adapter, on the untouched form.
      const result = await port.submit();

      // Refused before the click, as a question for the human.
      expect(result).toMatchObject({ kind: 'not_attempted', reason: 'unanswerable_question' });
      // Nothing was sent.
      expect(actionHits).toEqual([]);
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('submit: field invalid before click → not_attempted', async () => {
    // A field already flagged invalid makes the click a rejection at best, so
    // no click is spent learning it, and the field is named for the human.
    const { raw, port, actionHits } = await openForm();
    try {
      // Validation off, so a click WOULD send: the pre-check is the only guard.
      await allowNativeSubmit(raw);
      // The form already says this field is wrong.
      await raw.evaluate(() => {
        // Flagged with the attribute Greenhouse uses.
        document.getElementById('email')?.setAttribute('aria-invalid', 'true');
      });

      // The real adapter.
      const result = await port.submit();

      // Not attempted, as a question for the human, naming the field.
      expect(result).toMatchObject({ kind: 'not_attempted', reason: 'unanswerable_question' });
      if (result.kind === 'not_attempted') expect(result.detail).toContain('Email');
      // Nothing was sent.
      expect(actionHits).toEqual([]);
    } finally {
      // Always closed.
      await raw.close();
    }
  });
});

describe('detectBlocker() on the real Greenhouse form', () => {
  /** Append an iframe built from the given attributes to the page body. */
  async function injectFrame(raw: Page, attrs: Record<string, string>): Promise<void> {
    // Built in the page from plain attributes, so no HTML string is parsed.
    await raw.evaluate((attributes) => {
      // A fresh frame element.
      const frame = document.createElement('iframe');
      // Every attribute the caller asked for.
      for (const [name, value] of Object.entries(attributes)) frame.setAttribute(name, value);
      // On the page, where detectBlocker looks.
      document.body.appendChild(frame);
    }, attrs);
  }

  test('detectBlocker: invisible reCAPTCHA anchor is not a wall', async () => {
    // Greenhouse loads invisible reCAPTCHA on every board. Counting its anchor
    // as a captcha would park every Greenhouse application before a field was
    // read. The fence aborts the frame's request, so nothing reaches Google.
    const { raw, port } = await openForm();
    try {
      // Baseline: the bare form has no wall, so the null below is about the frame.
      expect(await port.detectBlocker()).toBeNull();
      // The anchor iframe exactly as the invisible variant loads it.
      await injectFrame(raw, { src: 'https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible' });

      // Not a wall.
      expect(await port.detectBlocker()).toBeNull();
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('detectBlocker: hidden challenge frame is not a wall; visible one is captcha', async () => {
    // reCAPTCHA pre-renders its challenge frame hidden. Only SHOWING it means
    // Google is asking, so visibility, not presence, is the test.
    const { raw, port } = await openForm();
    try {
      // A challenge frame, present but hidden.
      await injectFrame(raw, {
        id: 'challenge',
        title: 'recaptcha challenge expires in two minutes',
        style: 'display:none',
        srcdoc: '<p>challenge</p>',
      });
      // Hidden: no wall.
      expect(await port.detectBlocker()).toBeNull();

      // The same frame, now shown.
      await raw.evaluate(() => {
        // Visible at challenge size.
        document.getElementById('challenge')?.setAttribute('style', 'width:300px;height:300px');
      });
      // Shown: a captcha.
      expect(await port.detectBlocker()).toBe('captcha');
    } finally {
      // Always closed.
      await raw.close();
    }
  });

  test('detectBlocker: checkbox reCAPTCHA is still a wall', async () => {
    // The invisible exemption must not widen into "no reCAPTCHA is a wall": the
    // checkbox widget asks the human a question and must still park the row.
    const { raw, port } = await openForm();
    try {
      // An anchor WITHOUT size=invisible: the checkbox variant.
      await injectFrame(raw, { src: 'https://www.google.com/recaptcha/api2/anchor?k=x&size=normal' });

      // A wall.
      expect(await port.detectBlocker()).toBe('captcha');
    } finally {
      // Always closed.
      await raw.close();
    }
  });
});
