// THE FAIL-CLOSED GUARD for required questions the bot never saw (peer 4, 2026-11-09, P2-17).
//
// WHY THIS FILE EXISTS. Lever's multiple-choice cards carry no fieldset, no role and no id, so the
// extractor's radio branch drops them (extract-fields.ts: "an unnamed or unaddressable group is
// skipped"). The planner then plans nothing for a REQUIRED question and reports no blocker. The
// only pre-click guard was the browser's own `:invalid`, which (a) is off in a `novalidate` form and
// (b) never sees a question whose only required signal is Lever's ✱ mark. Together that let a live
// run click Submit with a required answer blank. submit() must refuse instead, naming the question,
// so the row parks for a human (the Manual lane) and nothing is sent.
//
// Fixture: fixtures/lever/required-radio-card-shape.html, HAND-BUILT (Lever disallows ClaudeBot), its
// header names the markup it was modelled on. Real Chromium, network fenced to the fixture server.
import { afterAll, beforeAll, expect, test } from 'vitest';
// Real Chromium: the guard reads live DOM state (checked radios, attached files), which a fake cannot.
import { chromium, type Browser, type Page } from 'playwright';
// Serves worker/fixtures on 127.0.0.1, so the form has a real origin and a routable action.
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
// The production adapter; submit() is the one code path that sends an application.
import { createPlaywrightPage, readUnfilledRequiredLabels } from '../src/playwright-page.ts';
// The extractor, to show the question is invisible to the planner (the premise of the guard).
import { extractFields } from '../src/extract-fields.ts';

// One browser and one server for the file: a launch costs ~0.5 s.
let browser: Browser;
// The fixture origin.
let server: FixtureServer;

beforeAll(async () => {
  // Headless, as on the Actions runner.
  browser = await chromium.launch();
  // Same root every fixture test uses.
  server = await startFixtureServer('fixtures');
}, 60_000);

afterAll(async () => {
  // A leaked Chromium keeps a CI job alive until its timeout.
  await browser?.close();
  // And the port.
  await server?.close();
});

// The form's own action path; a request here is the application being sent.
const ACTION_PATH = '/lever/example/apply/submit';
// The required question the extractor cannot see.
const REQUIRED_QUESTION = 'Are you available to join within 30 days?';

/** Open the fixture behind a network fence, fill every control the bot CAN see, and log sends. */
async function openFilled(): Promise<{ raw: Page; port: ReturnType<typeof createPlaywrightPage>; sends: string[] }> {
  // A fresh page per test, so routes and listeners never leak between cases.
  const raw = await browser.newPage();
  // The fixture origin, the only one allowed to answer.
  const origin = new URL(server.url).origin;
  // THE FENCE: anything off-origin is aborted, so nothing can reach a real board.
  await raw.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
  // Every send of the form is recorded here.
  const sends: string[] = [];
  // The action answers 200 with a plain page; the test reads only whether it was hit.
  await raw.route((url) => url.pathname === ACTION_PATH, async (route) => {
    // Recorded before answering, so the log holds even if the page navigates.
    sends.push(route.request().method());
    // A minimal reply; no confirmation logic is under test here.
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>ok</h1>' });
  });
  // Short deadlines: no test here waits on a confirmation.
  const port = createPlaywrightPage(raw, { submitOutcomeTimeoutMs: 1_500, rejectionSettleMs: 200 });
  // Loaded through the adapter, as the applier does.
  await port.goto(`${origin}/lever/required-radio-card-shape.html`);
  // What the bot types: the two text questions it can see.
  await raw.fill('input[name="name"]', 'Asha Rao');
  // Invented address, never real PII.
  await raw.fill('input[name="email"]', 'asha@example.com');
  // The resume, as setInputFiles attaches it; contents are irrelevant to the guard.
  await raw.setInputFiles('#resume-upload-input', { name: 'resume.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  // The page, the adapter and the send log.
  return { raw, port, sends };
}

test('premise: the extractor emits no field for the required radio card, so the planner cannot block on it', async () => {
  // The bot's own read of the form.
  const { raw } = await openFilled();
  try {
    // Labels the planner would see.
    const labels = (await extractFields(raw)).map((field) => field.label);
    // Non-vacuity: the form WAS read (the text questions are there)...
    expect(labels).toContain('Email');
    // ...and the required card is not. If extraction learns it, this flips and the guard is a second line.
    expect(labels).not.toContain(REQUIRED_QUESTION);
  } finally {
    // Always closed.
    await raw.close();
  }
});

test('required radio card left blank in a novalidate form → not_attempted, named, nothing sent', async () => {
  // Everything the bot can see is filled; the required card is not.
  const { raw, port, sends } = await openFilled();
  try {
    // The adapter the worker really runs.
    const result = await port.submit();
    // Refused before the click, as a question for the human: the park reason the Manual lane reads.
    expect(result).toMatchObject({ kind: 'not_attempted', reason: 'unanswerable_question' });
    // The human is told WHICH question, by its Lever label (never an option's "Yes").
    if (result.kind === 'not_attempted') expect(result.detail).toContain(REQUIRED_QUESTION);
    // And the optional card, also blank, is not named: only required questions stop a submit.
    if (result.kind === 'not_attempted') expect(result.detail).not.toContain('How did you hear about us?');
    // Nothing reached the employer.
    expect(sends).toEqual([]);
  } finally {
    // Always closed.
    await raw.close();
  }
});

test('control: the same form with the required card answered is sent (the optional card stays blank)', async () => {
  // Same set-up, then a human-style answer to the required card.
  const { raw, port, sends } = await openFilled();
  try {
    // Answer the required question; the optional one stays blank on purpose.
    await raw.check('input[value="Yes"]');
    // Nothing required is empty now.
    expect(await raw.evaluate(readUnfilledRequiredLabels)).toEqual([]);
    // The click happens; its outcome is not this file's concern.
    await port.submit();
    // Proof the guard does not over-block: the form was sent exactly once.
    expect(sends).toEqual(['POST']);
  } finally {
    // Always closed.
    await raw.close();
  }
});

test('the first bot submit is not over-blocked: TrueFoundry\'s required controls, filled, read as complete', async () => {
  // The Greenhouse embed form the first live submit targets (read only; the file belongs to its preflight test).
  const raw = await browser.newPage();
  try {
    // Loaded straight from the fixture server; this test never submits.
    await raw.goto(`${server.url}/greenhouse/truefoundry-5126892008-backend-interns.html`);
    // Before any fill, the guard names the empty required text boxes (non-vacuity: it reads this form).
    expect(await raw.evaluate(readUnfilledRequiredLabels)).toEqual(expect.arrayContaining(['First Name', 'Email']));
    // The four required text boxes the bot types, with invented values.
    for (const [id, value] of [['first_name', 'Asha'], ['last_name', 'Rao'], ['email', 'asha@example.com'], ['phone', '9999900000']] as const) await raw.fill(`#${id}`, value);
    // Comboboxes (react-select) and their aria-hidden sentinels are verified by the filler's own readback,
    // so the guard skips them; with the text boxes filled, nothing required reads as empty.
    expect(await raw.evaluate(readUnfilledRequiredLabels)).toEqual([]);
  } finally {
    // Always closed.
    await raw.close();
  }
});

test('a CAPTURED Lever form is not over-blocked: Netomi names exactly its ✱ questions, then reads complete once filled', async () => {
  // The one real Lever capture we hold (2026-11-05, before robots barred ClaudeBot); read only, never submitted.
  const raw = await browser.newPage();
  try {
    // Straight from the fixture server; no adapter, because only the guard's reading is under test.
    await raw.goto(`${server.url}/lever/netomi-apply-form.html`);
    // Blank form: every ✱ question is named, by its Lever label, in DOM order (non-vacuity: the guard reads Lever markup).
    expect(await raw.evaluate(readUnfilledRequiredLabels)).toEqual([
      // Required by the ✱ alone: the file input has no `required` attribute.
      'Resume/CV',
      // Native `required` plus ✱.
      'Full name',
      // Same.
      'Email',
      // Same.
      'Phone',
      // A custom-card select: its placeholder option has value "", which is no answer.
      'What is your Current Location?',
      // A custom-card text box.
      'Please share the relevant experience in Kubernetes.',
    ]);
    // What the bot types into the text boxes, with invented values.
    for (const [name, value] of [['name', 'Asha Rao'], ['email', 'asha@example.com'], ['phone', '9999900000'], ['cards[4a073f98-1fdf-49db-8024-f859d2d3cad8][field0]', 'Two years of Kubernetes']] as const) await raw.fill(`[name="${name}"]`, value);
    // The dropdown card, picked as the filler picks a native select.
    await raw.selectOption('select[name="cards[c8afb62e-f85f-45cd-82f8-acaef1a6c56f][field0]"]', 'Bangalore');
    // The resume, attached as setInputFiles does in the applier.
    await raw.setInputFiles('#resume-upload-input', { name: 'resume.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    // Filled: nothing required is empty, and the OPTIONAL Linux card (still blank) never stops the submit.
    expect(await raw.evaluate(readUnfilledRequiredLabels)).toEqual([]);
  } finally {
    // Always closed.
    await raw.close();
  }
});
