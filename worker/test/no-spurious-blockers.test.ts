// NAMED REGRESSION TEST for the failure that would kill this product quietly.
//
// Real Greenhouse forms contain aria-hidden, tabindex="-1" inputs that carry
// the native `required` attribute. They exist only to block native browser
// submit for custom React-select dropdowns; they are machinery, not questions.
//
// If extraction ever counts them as real fields, they become required fields
// with no recoverable label and therefore no possible answer — so planFill
// blocks, and EVERY SINGLE APPLICATION routes to blocked_needs_human. The
// human queue stops being an occasional captcha and becomes the entire day's
// work, and the symptom Teja sees is "the automation doesn't work" rather than
// anything that looks like a parsing bug. That is why this gets its own file
// and its own name: it is the kind of thing a future refactor of
// extract-fields.ts silently reintroduces.
import { afterAll, beforeAll, expect, test } from 'vitest';
// Read the fixture's raw markup so the expected counts are derived from the
// hazard itself rather than pinned by a human who might miscount — as happened.
import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
import { extractFields } from '../src/extract-fields.ts';
import { planFill } from '../src/plan-fill.ts';

// Shared browser/server; launching per test would cost billable seconds (§2).
let browser: Browser;
let server: FixtureServer;
let page: Page;

beforeAll(async () => {
  // Headless, as on a GitHub Actions runner with no display.
  browser = await chromium.launch();
  // Serve the checked-in captures so the test fails loudly if one is removed.
  server = await startFixtureServer('fixtures');
  page = await browser.newPage();
  // The real GitLab Greenhouse form captured 2026-09-09, scripts stripped.
  await page.goto(`${server.url}/greenhouse/gitlab-remix-form.html`);
}, 60_000);

afterAll(async () => {
  // A leaked Chromium keeps a CI job alive until its timeout.
  await browser?.close();
  await server?.close();
});

test('extraction excludes every aria-hidden required sentinel in the fixture', async () => {
  // Derived from the fixture's own markup rather than pinned by hand, because a
  // hand-pinned count cannot distinguish "someone recounted" from "sentinels
  // leaked" — and this file's entire purpose is telling those two apart. The
  // first version of this test pinned 9 required fields when the real answer was
  // 10, so it failed for a reason that had nothing to do with the bug it guards.
  const markup = await readFile(
    new URL('../fixtures/greenhouse/gitlab-remix-form.html', import.meta.url),
    'utf8',
  );
  // The sentinels: aria-hidden, tabindex="-1", carrying native `required` purely
  // to block browser submit behind the React-select dropdowns.
  const sentinels = markup.match(/<input[^>]*aria-hidden="true"[^>]*>/g) ?? [];

  // NON-VACUITY GUARD, and it is the load-bearing line. Without it, deleting the
  // sentinels from the fixture would make this test pass while proving nothing —
  // the same way the fixture-server traversal test originally passed against no
  // guard at all. The test must fail if the hazard stops being present.
  expect(sentinels.length).toBeGreaterThan(0);
  // Every one of them must carry `required`, or they are not the hazard case.
  expect(sentinels.every((tag) => tag.includes('required'))).toBe(true);

  const fields = await extractFields(page);

  // The mutation this detects: disable the aria-hidden filter in
  // extract-fields.ts and the sentinels are counted as required fields with no
  // recoverable label, so `required` jumps by exactly sentinels.length and
  // planFill then blocks EVERY application. Expressed as arithmetic over the
  // fixture so the relationship is visible instead of encoded in a magic number.
  const required = fields.filter((formField) => formField.required);
  // 10 genuine required questions, verified by reading the rendered form; a leak
  // would make this 10 + 7 = 17.
  expect(required).toHaveLength(10);
  // Total fillable controls surfaced; a leak would make this 22 + 7 = 29.
  expect(fields).toHaveLength(22);

  // The property behind both numbers: a sentinel has no recoverable label, so
  // no extracted field may be unlabelled. This holds even if the fixture is
  // later replaced with a different board's capture, where 10 and 22 would not.
  expect(required.every((formField) => formField.label.trim().length > 0)).toBe(true);
});

test('every blocker names a question a human could actually answer', async () => {
  // The sentinel failure mode expressed as a property rather than a count: a
  // leaked sentinel has no recoverable label, so it would surface as a blocker
  // that Teja cannot act on — an item permanently stuck in the queue, which is
  // worse than a visible error because it looks like normal backlog.
  const fields = await extractFields(page);
  // An empty answer bank maximises the number of blockers, so this exercises
  // every required field at once rather than only the unanswered ones.
  const plan = planFill(fields, []);
  // Every blocker must carry human-readable question text.
  expect(plan.blockers.every((blocker) => blocker.label.trim().length > 0)).toBe(true);
  // And with nothing answered, the form must NOT proceed — the constraint #4
  // guarantee, asserted end to end against real DOM rather than a stub.
  expect(plan.canProceed).toBe(false);
});

test('extraction surfaces real questions, not form machinery', async () => {
  // A second angle on the same bug: a sentinel leak inflates the field count
  // with unlabelled entries even when the planner happens not to block.
  const fields = await extractFields(page);
  // Every surfaced field must carry a human-readable question. An empty label
  // is definitionally machinery, because a human could not answer it either.
  expect(fields.every((formField) => formField.label.length > 0)).toBe(true);
  // Sanity floor: the real form has ~22 fillable controls. Zero would mean the
  // extractor silently matched nothing and the tests above passed vacuously.
  expect(fields.length).toBeGreaterThan(5);
});

test('a LABELLED aria-hidden sentinel is still excluded', async () => {
  // WHY THIS TEST EXISTS, and it is the most important note in this file.
  //
  // Mutation testing the test above revealed it was security theatre: with the
  // aria-hidden guard in extract-fields.ts commented out, it still PASSED. The
  // real GitLab sentinels carry no aria-label, no aria-labelledby and no id, so
  // they are dropped by the `if (!label) continue` guard further down — not by
  // the aria-hidden check the test is named after. Both guards are present;
  // only one was load-bearing, and the tests could not tell them apart.
  //
  // The failure that would reopen the bug is a plausible improvement, not a
  // mistake: adding a label fallback to `name`, `placeholder` or `id` so other
  // ATS vendors parse. The moment labels resolve more eagerly, the sentinels
  // acquire names, the label guard stops catching them, and aria-hidden becomes
  // the ONLY defence — with nothing proving it works.
  //
  // So this uses a SYNTHETIC DOM, deliberately not the real capture: it needs a
  // sentinel that has a label, which real Greenhouse does not currently serve.
  // It is labelled synthetic explicitly, and that label is load-bearing: a
  // synthetic DOM proves something different from a real capture, and
  // conflating the two is how a test comes to look like evidence it is not.
  //
  // CORRECTED 2026-09-11. This previously read "for the same reason the Lever
  // fixture is". THERE IS NO LEVER FIXTURE, and there never has been —
  // `worker/fixtures/` holds exactly one real capture,
  // `greenhouse/gitlab-remix-form.html`. The sentence was worth deleting rather
  // than softening, because a comment that casually cites a fixture nobody has
  // ever captured does the same damage as hand-authoring one: it converts a
  // KNOWN gap (we have never seen a Lever DOM, so we cannot claim the extractor
  // handles it) into an unknown one, by leaving the next reader believing the
  // coverage exists. A missing fixture is an honest gap; a phantom one is not.
  const isolated = await browser.newPage();
  // One genuine question and one sentinel that differs ONLY by aria-hidden.
  // Every other attribute is identical, so the assertion below can attribute
  // the difference in outcome to that attribute and nothing else.
  await isolated.setContent(`
    <form>
      <label for="real_q">Preferred name</label>
      <input id="real_q" required />
      <label for="sentinel_q">Preferred name</label>
      <input id="sentinel_q" required tabindex="-1" aria-hidden="true" />
    </form>
  `);

  const fields = await extractFields(isolated);
  await isolated.close();

  // The genuine question survives, proving the extractor is working at all and
  // that this test is not passing because extraction returned nothing.
  expect(fields.map((formField) => formField.id)).toContain('real_q');
  // The sentinel does not, and ONLY the aria-hidden guard can be responsible:
  // it has a resolvable <label for>, so the label guard would let it through.
  // Comment out the aria-hidden line in extract-fields.ts and this fails.
  expect(fields.map((formField) => formField.id)).not.toContain('sentinel_q');
});
