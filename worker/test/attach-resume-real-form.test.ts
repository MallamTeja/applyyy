// Attaching the rendered resume to a REAL captured ATS form, in real Chromium.
//
// WHY THIS CANNOT BE A UNIT TEST. Three of the assumptions the attachment path
// rests on are facts about a live DOM and a real browser, and every one of them
// would be a guess if written against hand-authored markup:
//
//   1. The resume input on the captured Greenhouse form is
//      `class="visually-hidden"` — the real control sits behind a styled
//      "Attach" button. Anything that waited for visibility would time out on
//      the ONE real form in the repository.
//   2. What extract-fields.ts actually recovers for those inputs. The plan
//      module's classifier is built on the answer being `label: 'Attach'` for
//      BOTH uploads with `required: false`, which is surprising enough that it
//      must be measured rather than asserted in a comment.
//   3. Whether Playwright's `setInputFiles` genuinely populates a hidden input's
//      FileList, which is the only thing that makes the attachment real.
//
// worker/fixtures/ holds exactly one genuinely-captured form (Greenhouse). No
// Lever or Ashby substitute is hand-authored here: we have never seen either
// real DOM, and an invented fixture would convert a known coverage gap into an
// unknown one that passes review.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.ts';
import { createPlaywrightPage } from '../src/playwright-page.ts';
import { extractFields } from '../src/extract-fields.ts';
import { planResumeAttachment, resumeFileName } from '../src/plan-resume-attachment.ts';
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

/** The real captured GitLab-on-Greenhouse application form. */
function formUrl(): string {
  return `${server.url}/greenhouse/gitlab-remix-form.html`;
}

/** Open the real form and hand back both the raw page and the port over it. */
// fileUploadTimeoutMs: the upload-wait bound; undefined keeps the production value.
async function openRealForm(fileUploadTimeoutMs?: number): Promise<{ raw: Page; port: ReturnType<typeof createPlaywrightPage> }> {
  const raw = await browser.newPage();
  // Wrapped in the production adapter rather than driven directly, so what is
  // measured below is the code the applier really runs.
  // Spread so an absent bound is truly absent (exactOptionalPropertyTypes).
  const port = createPlaywrightPage(raw, fileUploadTimeoutMs === undefined ? {} : { fileUploadTimeoutMs });
  await port.goto(formUrl());
  return { raw, port };
}

/**
 * Stand in for Greenhouse's uploader, which the capture stripped with every other script.
 *
 * The live widget (job-boards entry.client bundle, read 2026-10-24) uploads the chosen
 * file to S3 and renders one of two states inside the `.file-upload` group: a
 * `[role=progressbar].file-upload__progressbar` while uploading, then a
 * `.file-upload__filename` holding the name once done. Only the DONE state puts
 * `resume_url` into the application POST. `completes` reaches it after 300ms;
 * `stuck` stays at 0% forever, as the live uploader does when its XHR errors
 * (its onerror only logs). The markup copies the bundle's class names exactly.
 */
async function simulateGreenhouseUploader(raw: Page, mode: 'completes' | 'stuck'): Promise<void> {
  await raw.evaluate((uploadMode) => {
    // Every upload group on the form, each wired the way the widget wires its own input.
    for (const group of Array.from(document.querySelectorAll<HTMLElement>('.file-upload'))) {
      // The hidden input setInputFiles writes to.
      const input = group.querySelector<HTMLInputElement>('input[type="file"]');
      // Where the widget renders its states.
      const wrapper = group.querySelector<HTMLElement>('.file-upload__wrapper');
      if (input === null || wrapper === null) continue;
      input.addEventListener('change', () => {
        // The uploading state: buttons hidden, an empty bar at 0%. Hidden, not removed:
        // the input lives inside the button container, and removing it would drop the
        // FileList the tests read back.
        const buttons = wrapper.querySelector<HTMLElement>('.button-container');
        if (buttons !== null) buttons.style.display = 'none';
        const bar = document.createElement('div');
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuenow', '0');
        bar.className = 'file-upload__progressbar';
        wrapper.append(bar);
        // A stuck upload never leaves this state.
        if (uploadMode === 'stuck') return;
        setTimeout(() => {
          // The done state: the bar replaced by the file name, set as text (never as HTML).
          bar.remove();
          const done = document.createElement('div');
          done.className = 'file-upload__filename';
          const name = document.createElement('span');
          name.textContent = input.files?.[0]?.name ?? '';
          done.append(name);
          wrapper.append(done);
        }, 300);
      });
    }
  }, mode);
}

describe('attaching the resume to the real Greenhouse form', () => {
  test('extract-fields yields both uploads labelled "Attach" and not required', async () => {
    // THE MEASUREMENT THE CLASSIFIER IS BUILT ON. If this ever changes — a
    // vendor markup change, or an extractor that learns to read the wrapper's
    // aria-labelledby — the id-based classifier stops being necessary and this
    // test is where that becomes visible, instead of the day a resume lands in
    // the wrong box.
    const raw = await browser.newPage();
    try {
      await raw.goto(formUrl(), { waitUntil: 'domcontentloaded' });
      const fields = await extractFields(raw);
      const uploads = fields.filter((field) => field.kind === 'file');

      // Exactly two uploads: resume and cover letter.
      expect(uploads.map((field) => field.id)).toEqual(['resume', 'cover_letter']);

      // BOTH carry the same useless label, which is the finding. The visible
      // "Resume/CV" text lives on a wrapper div reachable only through
      // aria-labelledby, and the extractor walks `input, textarea, select`.
      expect(uploads.map((field) => field.label)).toEqual(['Attach', 'Attach']);

      // And neither reads as required, because `aria-required="true"` is on the
      // same wrapper. This is why nothing in the attachment planner branches on
      // `required` for file fields — such a branch would be dead code here.
      expect(uploads.map((field) => field.required)).toEqual([false, false]);
    } finally {
      await raw.close();
    }
  }, 60_000);

  test('puts the rendered PDF in the resume input and leaves the cover letter empty', async () => {
    // THE END-TO-END ATTACHMENT PROOF, on a hidden input, with real PDF bytes
    // rendered by the same function the approval preview calls.
    const { raw, port } = await openRealForm();
    // The renderer owns its OWN page — handing it `raw` would `setContent` over
    // the employer's form and erase it. See the next test, which measures that.
    const renderer = createResumeRenderer(browser);
    try {
      const fields = await port.extractFields();
      const plan = planResumeAttachment(fields, { hasResumeSnapshot: true });

      // The planner found the resume box on the real DOM.
      expect(plan.target?.id).toBe('resume');

      const rendered = await renderer.render(syntheticResume);
      const expectedName = resumeFileName(syntheticResume);

      // The live widget's upload finishing, so attachFile's upload wait is satisfied.
      await simulateGreenhouseUploader(raw, 'completes');
      await port.attachFile(plan.target!.id, {
        name: expectedName,
        mimeType: 'application/pdf',
        bytes: rendered.bytes,
      });

      // Read the FileList back out of the live DOM. This is the assertion that
      // proves `setInputFiles` works on a `visually-hidden` control — the
      // property the whole approach depends on and the one that would have
      // failed silently if the adapter had tried to click the styled button.
      const attached = await raw.evaluate(() => {
        const resume = document.querySelector<HTMLInputElement>('#resume');
        const cover = document.querySelector<HTMLInputElement>('#cover_letter');
        return {
          resumeName: resume?.files?.[0]?.name ?? null,
          resumeSize: resume?.files?.[0]?.size ?? 0,
          resumeType: resume?.files?.[0]?.type ?? null,
          // The count, not the name: what matters is that nothing landed here.
          coverCount: cover?.files?.length ?? -1,
        };
      });

      // The filename the recruiter will see, deterministic and derived from the
      // approved snapshot alone.
      expect(attached.resumeName).toBe(expectedName);
      // The real bytes arrived, all of them. A size floor alone would pass on a
      // truncated file, so this is exact.
      expect(attached.resumeSize).toBe(rendered.bytes.length);
      // Declared type survives the crossing; some boards validate on it.
      expect(attached.resumeType).toBe('application/pdf');

      // THE COVER LETTER STAYS EMPTY. This is the assertion that a "first file
      // input wins" implementation cannot satisfy on a form where the ordering
      // differs, and it is the difference between sending a resume and sending
      // a resume filed as a cover letter.
      expect(attached.coverCount).toBe(0);
    } finally {
      await renderer.close();
      await raw.close();
    }
  }, 120_000);

  test('the form survives the render, because the renderer never shares its page', async () => {
    // WHY THE DEDICATED PAGE IS STRUCTURAL AND NOT A STYLE CHOICE. The second
    // half of this test performs the mistake deliberately, on a throwaway page,
    // to show the hazard is real rather than theoretical — `setContent` REPLACES
    // the document, so a renderer handed the form's page would erase every typed
    // answer and the screenshot that follows would picture a resume where the
    // §18.6 evidence should be. Nothing would throw.
    const { raw, port } = await openRealForm();
    const renderer = createResumeRenderer(browser);
    try {
      // Type into the real form first, so there is state to lose.
      await port.fill('first_name', 'Ada');

      // Render while the form is loaded. The renderer opens its own page.
      await renderer.render(syntheticResume);

      // The form is intact and still holds what was typed.
      const survived = await raw.evaluate(
        () => document.querySelector<HTMLInputElement>('#first_name')?.value ?? null,
      );
      expect(survived).toBe('Ada');

      // ---- The hazard, demonstrated on a page we are about to discard -------
      const doomed = await browser.newPage();
      try {
        await doomed.goto(formUrl(), { waitUntil: 'domcontentloaded' });
        await doomed.locator('#first_name').fill('Ada');
        // Exactly what renderResumePdf does internally.
        await doomed.setContent('<p>a resume would be here</p>', {
          waitUntil: 'domcontentloaded',
        });

        // The entire form is gone — the input no longer exists to have a value.
        const afterRenderOnFormPage = await doomed.evaluate(
          () => document.querySelector('#first_name') === null,
        );
        expect(afterRenderOnFormPage).toBe(true);
      } finally {
        await doomed.close();
      }
    } finally {
      await renderer.close();
      await raw.close();
    }
  }, 120_000);
});

/**
 * THE UPLOAD WAIT (2026-10-24, GitLab ba1e5d1d). Every pre-click screenshot of that row
 * showed the required Resume/CV box as an empty progress bar: attachFile set the file and
 * returned, the click came about 1s later, and Greenhouse only puts `resume_url` in the
 * POST once its S3 upload has finished. attachFile now waits for the widget's done state
 * inside a `.file-upload` group, and throws when it never comes (before `applying`, so
 * nothing is sent). Any other file input keeps the old set-and-return path.
 */
describe('attachFile waits for the Greenhouse upload to finish', () => {
  // The payload: content is irrelevant to the wait, only the name is read back.
  const file = { name: 'Teja_Mallam_Resume.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70]) };

  test('an upload that completes → attachFile resolves once the file name shows', async () => {
    // A generous bound: the simulated upload finishes at 300ms.
    const { raw, port } = await openRealForm(5_000);
    try {
      await simulateGreenhouseUploader(raw, 'completes');
      await port.attachFile('resume', file);
      // Resolved in the done state: the name is shown and the bar is gone.
      const state = await raw.evaluate(() => ({
        name: document.querySelector('.file-upload .file-upload__filename')?.textContent ?? null,
        bars: document.querySelectorAll('.file-upload__progressbar').length,
      }));
      expect(state).toEqual({ name: file.name, bars: 0 });
    } finally {
      await raw.close();
    }
  }, 60_000);

  test('an upload stuck at 0% → attachFile throws naming the field, and nothing is sent', async () => {
    // A short bound so the stuck case fails fast.
    const { raw, port } = await openRealForm(1_500);
    // Every request that could carry an application, from the attach on.
    const sends: string[] = [];
    raw.on('request', (request) => {
      if (request.method() !== 'GET') sends.push(`${request.method()} ${request.url()}`);
    });
    try {
      await simulateGreenhouseUploader(raw, 'stuck');
      // Thrown, naming the field by the label a human sees and by its id.
      await expect(port.attachFile('resume', file)).rejects.toThrow(/Resume\/CV.*#resume.*did not finish within 1500ms/);
      // Non-vacuity: the widget really was stuck uploading when it threw.
      expect(await raw.locator('.file-upload__progressbar').count()).toBe(1);
      // Nothing left the page: no click, no POST.
      expect(sends).toEqual([]);
    } finally {
      await raw.close();
    }
  }, 60_000);

  test('a file input outside a Greenhouse .file-upload group keeps the old set-and-return path', async () => {
    // A bound far above the assertion below, so a wait would be caught as slowness.
    const { raw, port } = await openRealForm(10_000);
    try {
      // The same real form with the widget's class removed: no group, so no wait applies.
      await raw.evaluate(() => {
        for (const group of Array.from(document.querySelectorAll('.file-upload'))) group.classList.remove('file-upload');
      });
      const started = Date.now();
      await port.attachFile('resume', file);
      // Returned at once, not after the 10s bound.
      expect(Date.now() - started).toBeLessThan(2_000);
      // And the file is set, as before.
      expect(await raw.evaluate(() => document.querySelector<HTMLInputElement>('#resume')?.files?.[0]?.name ?? null)).toBe(file.name);
    } finally {
      await raw.close();
    }
  }, 60_000);
});
