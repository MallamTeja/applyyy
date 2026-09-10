// Binds the `ResumeRenderer` port onto a real browser, on a page of its OWN.
//
// THE REASON THIS MODULE EXISTS RATHER THAN A DIRECT CALL: renderResumePdf works
// by `page.setContent(html)`, which REPLACES the document. Handed the page that
// is holding the employer's half-filled application form, it would wipe the form
// — every typed answer gone, and the screenshot that follows would show a
// resume where §18.6's evidence should be. The dry-run review would then be
// reviewing the wrong document entirely, and nothing would have thrown.
//
// So the renderer gets a dedicated page and the form never shares it. That is
// enforced structurally: this factory takes a `Browser` and opens its own page,
// so there is no parameter through which a caller could pass the form's page in.
//
// ONE PAGE PER RUN, NOT PER APPLICATION. A `newPage()` is cheap next to the
// ~475ms browser launch but not free, and the batch reasoning in claim-loop.ts
// is that per-application costs are the ones multiplied by 35. The page is
// created lazily so a run that renders nothing — a fully dry, fully blocked
// queue — pays nothing at all.
import type { Browser, Page } from 'playwright';
import type { ResolvedResume } from '@applyy/shared-types';
import { renderResumePdf, type RenderedResume } from './render-resume-pdf.ts';
// The port this module implements. Declared by its CONSUMER rather than here, so
// apply-one.ts states what it needs and stays free of any Playwright type.
import type { ResumeRenderer } from './apply-one.ts';

/** The renderer plus the page lifetime it owns. */
export interface OwnedResumeRenderer {
  // The port itself, injected into the loop.
  readonly render: ResumeRenderer;
  // Closed by the composition root. A leaked page keeps Chromium alive and the
  // Actions job billing until its timeout, against a budget billed in whole
  // minutes — the same argument claim-loop.ts makes about form pages.
  close(): Promise<void>;
}

/**
 * Build a renderer over a browser.
 *
 * Takes the browser rather than a page for the reason in this file's header:
 * owning the page is the guarantee, and a page-shaped parameter would give it
 * away.
 */
export function createResumeRenderer(browser: Browser): OwnedResumeRenderer {
  // Held across applications and created on first use. Not a promise-of-a-page,
  // because the loop is strictly sequential — claim-loop.ts processes one
  // application at a time by design — so there is no concurrent first call to
  // race, and a lock here would be machinery guarding against a caller shape
  // the budget argument forbids.
  let page: Page | null = null;

  return {
    async render(resume: ResolvedResume): Promise<RenderedResume> {
      // Opened on demand so a run that never reaches a viable application —
      // every row blocked, or the kill switch off — costs nothing.
      page ??= await browser.newPage();

      // Straight through to the shared renderer. Nothing is added, transformed
      // or defaulted here: this module's whole job is WHERE the render happens,
      // and any content decision taken at this layer would be a second copy of
      // a decision that must live in @applyy/resume-template to keep the
      // approval guarantee true.
      return renderResumePdf({ resume, page });
    },

    async close(): Promise<void> {
      // Idempotent and null-safe, because the composition root closes this in a
      // `finally` that also runs when the run failed before rendering anything.
      await page?.close();
      // Dropped so a second close cannot touch a closed page, which throws.
      page = null;
    },
  };
}
