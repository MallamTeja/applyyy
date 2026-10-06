// Tests for form field extraction, run against a REAL captured Greenhouse form.
//
// This is the payoff for PROJECT_PLAN.md §19 insisting on real fixtures. The
// capture at worker/fixtures/greenhouse/ disproved the assumption this module
// would otherwise have been built on: modern Greenhouse forms carry NO `name`
// attributes at all. The classic job_application[first_name] convention is
// gone. Fields are identified by `id`, and custom questions get opaque numeric
// ids like question_36622854002 whose human meaning exists ONLY in aria-label.
//
// Extraction is therefore accessibility-tree-driven, and these tests pin that.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
// The real browser; a simulated DOM would defeat the purpose of a real capture.
import { chromium, type Browser, type Page } from 'playwright';
// Serves the saved fixture over localhost so the page loads exactly as a real
// one would, without any request reaching an employer (constraint #16).
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';

// Subject under test; absent, which is what makes this file RED.
import { extractFields } from '../src/extract-fields.ts';

// Shared across tests in this file: launching Chromium per test would triple
// the runtime, and runtime here is charged against the Actions budget (§2).
let browser: Browser;
let server: FixtureServer;
let page: Page;

beforeAll(async () => {
  // Headless because the worker runs on a GitHub Actions runner with no display.
  browser = await chromium.launch();
  // Serve the checked-in fixtures directory itself, not a temp copy, so these
  // tests fail loudly if a fixture is deleted or renamed.
  server = await startFixtureServer('fixtures');
  // One page reused by every test; extraction is read-only so there is no
  // cross-test contamination to worry about.
  page = await browser.newPage();
  // The real GitLab Greenhouse form, captured 2026-09-09 with scripts stripped.
  await page.goto(`${server.url}/greenhouse/gitlab-remix-form.html`);
}, 60_000);

afterAll(async () => {
  // Release the browser and the port; a leaked Chromium keeps CI alive forever.
  await browser?.close();
  await server?.close();
});

describe('extractFields on a real Greenhouse form', () => {
  test('reads the human label for a field that has no name attribute', async () => {
    // Extraction over the whole form.
    const fields = await extractFields(page);
    // First Name is a plain text input identified only by id + label. If this
    // fails, the extractor is still looking for name= and found nothing.
    const firstName = fields.find((field) => field.id === 'first_name');
    // The label is what the answer-bank lookup will key on, so it must be the
    // human string and must not carry the asterisk from the required marker.
    expect(firstName?.label).toBe('First Name');
    // aria-required="true" on the real element; required-ness drives whether an
    // unanswerable field blocks the application or can simply be skipped.
    expect(firstName?.required).toBe(true);
  });

  test('recovers the question text for an opaque numeric question id', async () => {
    // The case that only a real capture reveals.
    const fields = await extractFields(page);
    // This id is meaningless on its own; the JD-specific question text lives in
    // aria-label. An extractor keyed on id alone would hand the answer-bank
    // "question_36622854002" and get nothing back for every custom question on
    // every job — silently routing all of them to blocked_needs_human.
    const linkedin = fields.find((field) => field.id === 'question_36622854002');
    // The recovered human label.
    expect(linkedin?.label).toBe('LinkedIn Profile');
  });

  test('excludes the hidden sentinel inputs that back React-select widgets', async () => {
    // Extraction over the whole form.
    const fields = await extractFields(page);
    // The real form contains aria-hidden, tabindex="-1" inputs carrying the
    // native `required` attribute, used to block browser submit for custom
    // dropdowns. They have no label and no user-fillable value. Treated as real
    // fields they would look like unanswerable required questions and route
    // EVERY application to blocked_needs_human — turning the human queue from
    // an occasional captcha into the entire day's work.
    const unlabelled = fields.filter((field) => field.label === '');
    // Nothing unlabelled should survive extraction.
    expect(unlabelled).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GROUP METADATA — the wrapper-level label and required-ness.
//
// THE DEFECT THESE COVER: on this capture both file inputs report
// label 'Attach' and required false, because "Resume/CV" and
// aria-required="true" sit on a <div role="group"> five levels above the input
// and the extractor only ever read the control element. The mandatory resume
// box was therefore indistinguishable from the optional cover-letter box.
//
// WHAT THE FIX DELIBERATELY DOES NOT DO: it does not move the wrapper text into
// `label`. 'Attach' IS the accessible name of that input per accname, so
// `label` is already correct; preferring the wrapper would put every
// answer-bank key in the system permanently downstream of that choice. The
// wrapper text is a better KEY, not a corrected NAME, so it lives in its own
// field and the tests below pin `label` and `required` as UNCHANGED.
// ---------------------------------------------------------------------------
describe('group metadata on the real Greenhouse form', () => {
  test('the resume upload gains Resume/CV + required WITHOUT its label or required changing', async () => {
    // Extraction over the whole real form.
    const fields = await extractFields(page);
    // The mandatory upload, the field the whole change exists for.
    const resume = fields.find((field) => field.id === 'resume');

    // REGRESSION PIN, and the most important pair of lines in this file. If a
    // later refactor "improves" the extractor by promoting the wrapper text
    // into `label`, these fail — which is the point. Every stored answer-bank
    // key was computed from `label`, so silently changing it invalidates the
    // bank for every question on every board at once.
    expect(resume?.label).toBe('Attach');
    // Likewise `required`: the control itself carries no required marker, and
    // that remains the honest reading of the control.
    expect(resume?.required).toBe(false);

    // THE NEW INFORMATION. Recovered from
    // <div role="group" aria-labelledby="upload-label-resume"> five levels up.
    expect(resume?.groupLabel).toBe('Resume/CV');
    // The asterisk is stripped: the heading renders as
    // Resume/CV<span class="required">*</span>, and a key carrying the marker
    // would not match the same question on a board that marks required-ness
    // any other way. Asserted separately so a failure says WHY.
    expect(resume?.groupLabel).not.toContain('*');
    // And the obligation the control hid: aria-required="true" on the wrapper.
    // This is what tells an attachment planner the resume box is not optional,
    // which `required: false` above actively denies.
    expect(resume?.groupRequired).toBe(true);
  });

  test('the cover letter upload is distinguishable from the resume ONLY by group metadata', async () => {
    // Extraction over the whole real form.
    const fields = await extractFields(page);
    // The two uploads.
    const resume = fields.find((field) => field.id === 'resume');
    const cover = fields.find((field) => field.id === 'cover_letter');

    // NON-VACUITY FOR THE WHOLE FEATURE: the two controls really are identical
    // on every pre-existing property. Without these three lines the test above
    // could be passing on a form where `label` alone already separated them,
    // and the group walk would be doing no work at all.
    expect(cover?.label).toBe(resume?.label);
    expect(cover?.required).toBe(resume?.required);
    expect(cover?.kind).toBe(resume?.kind);

    // And the group metadata is the ONLY thing that tells them apart: a
    // different name...
    expect(cover?.groupLabel).toBe('Cover Letter');
    // ...and a different obligation, aria-required="false" against "true".
    expect(cover?.groupRequired).toBe(false);
  });

  test('exactly two fields carry a group label, and exactly one a different required-ness', async () => {
    // THE MEASUREMENT. Written as a census over the whole form rather than as
    // two spot checks, because the risk this change carries is not "the resume
    // is wrong" — it is "some OTHER field quietly acquired a group label from a
    // distant wrapper and its answer-bank key moved". A census catches that; a
    // spot check on #resume cannot.
    const fields = await extractFields(page);

    // Total control count, restated here so this test fails loudly if the
    // fixture is ever swapped: the counts below are only meaningful against a
    // known denominator.
    expect(fields).toHaveLength(22);

    // Fields whose wrapper supplies a name the control itself does not.
    const differingLabel = fields.filter(
      (field) => field.groupLabel !== undefined && field.groupLabel !== field.label,
    );
    // Named rather than merely counted, so a regression reports WHICH field
    // moved instead of "expected 2, got 3" with no way to tell which one.
    expect(differingLabel.map((field) => field.id)).toEqual(['resume', 'cover_letter']);
    // The predicted count, asserted separately from the identities so a length
    // change and an identity change fail distinguishably.
    expect(differingLabel).toHaveLength(2);

    // Fields whose wrapper contradicts the control's own required-ness. Only
    // the resume: the cover letter's wrapper says aria-required="false", which
    // AGREES with its control and so must not be counted here.
    const differingRequired = fields.filter(
      (field) => field.groupRequired !== undefined && field.groupRequired !== field.required,
    );
    expect(differingRequired.map((field) => field.id)).toEqual(['resume']);
    expect(differingRequired).toHaveLength(1);

    // THE OTHER TWENTY. Every remaining field must have picked up nothing at
    // all: the fixture has exactly two role="group" wrappers and both are file
    // uploads. This is the assertion that fails if the ancestor walk ever
    // starts reaching page-level landmarks, and it is why the bound exists.
    const untouched = fields.filter(
      (field) => field.groupLabel === undefined && field.groupRequired === undefined,
    );
    expect(untouched).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// GUARD TESTS, on SYNTHETIC DOM.
//
// These deliberately do NOT use the real capture, and the distinction matters:
// the captured form contains no group carrying aria-describedby and no group
// twenty levels up, so it cannot exercise either guard. Per
// docs/verification-traps.md, a guard no available input can reach is untested
// no matter how green the suite looks.
//
// Synthetic markup is labelled as such for the same reason this repository
// refuses to hand-author a Lever or Ashby fixture: these snippets prove a
// property of the ALGORITHM, not a fact about any vendor's DOM, and a reader
// must never be able to mistake one for the other.
// ---------------------------------------------------------------------------

/**
 * Run the extractor over a synthetic document.
 *
 * A fresh page per call rather than the shared one, because setContent on the
 * page the fixture tests use would erase the real form under them and turn
 * this file's failures into someone else's.
 */
async function extractFromMarkup(markup: string) {
  // Its own tab, closed before returning so no Chromium target leaks.
  const isolated = await browser.newPage();
  // setContent, not a fixture file: nothing here is a captured form.
  await isolated.setContent(markup);
  // Extract before teardown; the result is plain data and outlives the page.
  const fields = await extractFields(isolated);
  await isolated.close();
  return fields;
}

describe('group label resolution guards', () => {
  test('a legitimate aria-labelledby group label IS picked up', async () => {
    // THE NON-VACUITY TWIN for both rejection tests below. A guard that
    // refuses every input is indistinguishable from a correct guard unless
    // something proves it still ACCEPTS what it is supposed to accept. This is
    // the minimal accept case: one group, one aria-labelledby, no describedby
    // and no deep nesting.
    const fields = await extractFromMarkup(`
      <div role="group" aria-labelledby="grp-name" aria-required="true">
        <div id="grp-name">Resume/CV</div>
        <input id="upload" type="file" aria-label="Attach" />
      </div>
    `);
    // The control is found at all — without this the rejections below could
    // both be passing because extraction returned an empty array.
    const upload = fields.find((field) => field.id === 'upload');
    expect(upload).toBeDefined();
    // The control's own name is untouched, exactly as on the real form.
    expect(upload?.label).toBe('Attach');
    // And the wrapper's name arrives.
    expect(upload?.groupLabel).toBe('Resume/CV');
    // As does the wrapper's obligation, which the control does not carry.
    expect(upload?.groupRequired).toBe(true);
  });

  test('aria-describedby content does NOT leak into the group label', async () => {
    // THE MOST DANGEROUS MISTAKE AVAILABLE IN THIS MODULE, pinned.
    //
    // On the real form aria-describedby resolves to
    // "first_name-description first_name-error first_name-help" — description,
    // ERROR and help text. If the group-label resolver ever fell back to
    // aria-describedby, validation text would be spliced into the answer-bank
    // key, so the key would CHANGE the moment a submit failed and the bank
    // would silently stop matching answers it had already stored. That defect
    // is invisible to every test that never triggers an error state, which is
    // every other test in this repository.
    //
    // The group here carries BOTH attributes, which is what makes this
    // non-vacuous: the group IS found and it DOES get a label, so the only
    // question under test is which attribute supplied it.
    const fields = await extractFromMarkup(`
      <div
        role="group"
        aria-labelledby="grp-name"
        aria-describedby="grp-description grp-error grp-help"
        aria-required="true"
      >
        <div id="grp-name">Resume/CV</div>
        <div id="grp-description">Upload your most recent CV</div>
        <div id="grp-error">Please attach a file before continuing</div>
        <div id="grp-help">Accepted file types: pdf, doc, docx</div>
        <input id="upload" type="file" aria-label="Attach" />
      </div>
    `);
    const upload = fields.find((field) => field.id === 'upload');

    // The label is EXACTLY the aria-labelledby text and nothing more. An
    // equality assertion, not a "contains", because a describedby fallback
    // that APPENDED would still satisfy a contains check.
    expect(upload?.groupLabel).toBe('Resume/CV');
    // Named per describedby target so a failure says which text leaked rather
    // than only that the string was wrong. The error string matters most: it
    // is the one that varies with validation state.
    expect(upload?.groupLabel).not.toContain('Please attach a file');
    expect(upload?.groupLabel).not.toContain('Upload your most recent CV');
    expect(upload?.groupLabel).not.toContain('Accepted file types');
  });

  test('a group with ONLY aria-describedby yields no group label at all', async () => {
    // The second half of the same guard. The test above proves describedby
    // cannot CONTAMINATE a real label; this proves it cannot SUBSTITUTE for a
    // missing one. A fallback implementation passes the test above and fails
    // here, so both are needed — the composite-result trap from
    // docs/verification-traps.md.
    const fields = await extractFromMarkup(`
      <div role="group" aria-describedby="grp-error" aria-required="true">
        <div id="grp-error">Please attach a file before continuing</div>
        <input id="upload" type="file" aria-label="Attach" />
      </div>
    `);
    const upload = fields.find((field) => field.id === 'upload');

    // Extraction still happened and the control is present, so the assertion
    // below is about the group label and not about an empty result set.
    expect(upload?.label).toBe('Attach');
    // No name, because the only attribute that may name a group is absent.
    expect(upload?.groupLabel).toBeUndefined();
    // But the group WAS located — aria-required came off it. This separates
    // "the walk failed to find the group" from "the walk found it and
    // correctly refused to name it from describedby", which a bare
    // toBeUndefined() on groupLabel cannot distinguish.
    expect(upload?.groupRequired).toBe(true);
  });
});

describe('the ancestor-walk bound', () => {
  /**
   * Wrap `inner` in `depth` plain divs.
   *
   * Built programmatically so the two tests below differ in exactly one
   * number. Hand-typing twenty nested divs would make them differ in ways a
   * reader cannot check by eye, which is how a "control" stops controlling.
   */
  function nest(depth: number, inner: string): string {
    // Reduce over a fixed-length array: each step adds one more enclosing div.
    return Array.from({ length: depth }).reduce<string>(
      (accumulated) => `<div>${accumulated}</div>`,
      inner,
    );
  }

  /** The input plus its group heading, with a configurable gap between them. */
  function groupedUpload(gap: number): string {
    // aria-label so the control survives the "no recoverable label" drop and
    // the test is about the walk rather than about label resolution.
    const input = '<input id="upload" type="file" aria-label="Attach" />';
    // The heading sits directly under the group; only the INPUT moves, so the
    // two cases differ solely in ancestor distance.
    return `
      <div role="group" aria-labelledby="grp-name" aria-required="true">
        <div id="grp-name">Resume/CV</div>
        ${nest(gap, input)}
      </div>
    `;
  }

  test('a group at the real form depth IS found', async () => {
    // THE NON-VACUITY TWIN for the rejection below. Greenhouse buries the file
    // input five levels inside its upload group
    // (group > file-upload__wrapper > button-container > secondary-button >
    // div > input), so this is the depth the bound MUST clear. If the bound is
    // ever tightened past the one real DOM we have, this is what says so.
    const fields = await extractFromMarkup(groupedUpload(4));
    const upload = fields.find((field) => field.id === 'upload');
    // Found, named, and carrying the wrapper's obligation.
    expect(upload?.groupLabel).toBe('Resume/CV');
    expect(upload?.groupRequired).toBe(true);
  });

  test('a distant page-level group is NOT treated as the field group', async () => {
    // THE BOUND ITSELF. Without it the walk climbs to <html>, so a page that
    // wraps the whole form in role="group" stamps ONE section heading onto all
    // 22 fields — collapsing 22 distinct answer-bank keys into a single key,
    // which makes the bank return the WRONG stored answer rather than no
    // answer. That is a constraint #3 hazard (a false statement submitted in
    // Teja's name), not merely a miss.
    //
    // Twenty levels rather than nine: the claim under test is "a distant
    // landmark is not this field's group", not "the constant is exactly 8".
    // Pinning the constant would make a legitimate bump of it look like a
    // regression.
    const fields = await extractFromMarkup(groupedUpload(20));
    const upload = fields.find((field) => field.id === 'upload');

    // The field is still extracted in full — only the group metadata is
    // withheld. Without this line a bug that dropped the control entirely
    // would pass the two assertions below.
    expect(upload?.label).toBe('Attach');
    expect(upload?.kind).toBe('file');
    // Neither piece of group metadata may cross a twenty-level gap.
    expect(upload?.groupLabel).toBeUndefined();
    expect(upload?.groupRequired).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SELECT / RADIO / CHECKBOX awareness.
//
// The gitlab capture has no native select, radio or checkbox, so the new kinds are
// exercised on a SYNTHETIC fixture (fixtures/synthetic/native-controls.html), and the
// real capture is only asserted for what must NOT change: its react-select widgets
// stay 'combobox'.
// ---------------------------------------------------------------------------
describe('choice controls', () => {
  test('the real form\'s react-select widgets stay combobox, with no options', async () => {
    // Fields read off the shared real capture.
    const fields = await extractFields(page);
    // The country widget is a role=combobox input, not a native <select>.
    // The id comes from the real capture's react-select input.
    const country = fields.find((field) => field.id === 'country');
    expect(country?.kind).toBe('combobox');
    // react-select options render only when opened, so none may be claimed up front.
    expect(country?.options).toBeUndefined();
    // Non-vacuity: the real form really has combobox fields, and none became native_select.
    expect(fields.filter((field) => field.kind === 'combobox').length).toBeGreaterThan(0);
    expect(fields.filter((field) => field.kind === 'native_select')).toEqual([]);
  });

  test('native select, radio group and checkbox get the right kind, label and options', async () => {
    // Own tab: this fixture must not disturb the shared page.
    // Served by the same fixture server as the real capture.
    const isolated = await browser.newPage();
    await isolated.goto(`${server.url}/synthetic/native-controls.html`);
    const fields = await extractFields(isolated);
    await isolated.close();

    // The select: placeholder (value "") excluded, real options in DOM order.
    const select = fields.find((field) => field.id === 'country_native');
    expect(select).toMatchObject({ kind: 'native_select', label: 'Country', required: true });
    expect(select?.options).toEqual(['India', 'United States']);

    // The radio group: ONE field, labelled by the legend (asterisk stripped), id = the fieldset's.
    // Exactly one group expected, so find() is enough; toMatchObject checks the rest.
    const radio = fields.find((field) => field.kind === 'radio_group');
    expect(radio).toMatchObject({
      id: 'located_in_india',
      label: 'Are you located in India?',
      options: ['Yes', 'No'],
      required: true,
    });

    // The single checkbox is named by its wrapping label.
    expect(fields.find((field) => field.id === 'agree')).toMatchObject({
      kind: 'checkbox',
      label: 'I agree to the terms',
    });

    // The bug being fixed: option text must never surface as a field of its own.
    expect(fields.filter((field) => field.label === 'Yes' || field.label === 'No')).toEqual([]);
  });
});

// hCaptcha guard: Lever-like pages carry a hidden, unlabelled h-captcha-response textarea that
// must never surface as a field, or the planner would see a required-looking unanswerable item.
describe('hCaptcha response sink', () => {
  test('is never extracted, while the labelled field beside it is', async () => {
    // Own tab so the shared page is undisturbed.
    const isolated = await browser.newPage();
    // Synthetic fixture served by the same fixture server.
    await isolated.goto(`${server.url}/synthetic/hcaptcha-lever-like.html`);
    // Extract everything the planner would be shown.
    const fields = await extractFields(isolated);
    // Close the tab so it cannot leak into other tests.
    await isolated.close();
    // Non-vacuity: the normal field IS extracted, so an empty result cannot pass this test.
    expect(fields.map((field) => field.id)).toContain('full_name');
    // The captcha textarea is absent by id.
    expect(fields.some((field) => field.id === 'h-captcha-response')).toBe(false);
  });
});
