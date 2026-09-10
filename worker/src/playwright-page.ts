// Binds the `ApplicationPage` port onto a real Playwright page.
//
// This is the only file that knows Playwright exists, which is what lets every
// other module in the worker be tested with a plain object. It is also where
// the accessibility-tree extraction and the anti-bot detection meet a live DOM.
import type { Page } from 'playwright';
import type { BlockReason } from '@applyy/shared-types';
import { extractFields } from './extract-fields.ts';
import type { ClosableApplicationPage } from './claim-loop.ts';
// The one document shape that crosses into a real employer's form.
import type { AttachedFile } from './apply-one.ts';

/**
 * Thrown if anything ever reaches the submit path before Teja has approved it.
 *
 * A distinct, loudly-named type so it cannot be mistaken for a site error in a
 * log — this is a policy stop, not a failure of the page.
 */
export class SubmissionNotEnabledError extends Error {
  constructor() {
    super(
      'real submission is NOT implemented: it is gated on Teja\'s explicit approval ' +
        'and the §18.6 dry-run trust period. See PROJECT_PLAN.md constraints #15 and #16.',
    );
    this.name = 'SubmissionNotEnabledError';
  }
}

/**
 * Selectors that indicate a wall we must not try to get past.
 *
 * CONSTRAINT #5: never bypass a captcha, MFA, authentication control or
 * anti-bot mechanism. Detection exists to ROUTE TO A HUMAN, never to work
 * around — so this list grows when we find new walls, and nothing downstream of
 * it ever attempts a solve.
 */
const BLOCKER_SELECTORS: ReadonlyArray<readonly [string, BlockReason]> = [
  // Google reCAPTCHA, both the visible widget and the challenge iframe.
  ['iframe[src*="recaptcha"]', 'captcha'],
  ['.g-recaptcha', 'captcha'],
  // hCaptcha, used by Cloudflare-fronted boards.
  ['iframe[src*="hcaptcha"]', 'captcha'],
  ['.h-captcha', 'captcha'],
  // Cloudflare's interstitial challenge.
  ['#challenge-running', 'captcha'],
  // A password field on an application form means the board wants an account
  // before it will accept an application. We have no credentials and must not
  // create any, so this is a human's job.
  ['input[type="password"]', 'login_required'],
];

/**
 * A selector for one element by id, built without `CSS.escape`.
 *
 * THIS FIXED A LIVE BUG, and the bug is worth recording because the shape
 * recurs. Both call sites below used `CSS.escape(id)`, which is a BROWSER global
 * — and this module runs in NODE. Every call threw
 * `ReferenceError: CSS is not defined`, so the applier's `fill` path had never
 * executed even once. `CSS.escape` in extract-fields.ts is correct, because that
 * code is inside `page.evaluate` and really does run in the browser; the two
 * lines here look identical and run somewhere else entirely.
 *
 * It survived because nothing reached it. The unit tests drive a fake page, and
 * the one end-to-end test uses the real GitLab form, whose seven required
 * comboboxes have no answers — so `wouldSubmit` was false, the fill loop was
 * skipped, and the suite stayed green while the only code that types into a real
 * employer's form was dead on arrival. Unmeasured is not the same as passing.
 *
 * An ATTRIBUTE selector rather than an id selector, which also removes the need
 * to escape at all in the common case: `[id="..."]` accepts numeric-leading and
 * punctuation-bearing ids verbatim, which matters because real Greenhouse custom
 * questions are named things like `question_36622854002`.
 */
function byId(id: string): string {
  // Only these two characters can terminate the quoted attribute value early.
  // Backslash first — escaping it after the quote would double-escape the
  // backslash this very substitution introduces.
  const escaped = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[id="${escaped}"]`;
}

export function createPlaywrightPage(page: Page): ClosableApplicationPage {
  return {
    async goto(url: string) {
      // `domcontentloaded` rather than `networkidle`: ATS boards keep analytics
      // sockets open indefinitely, so waiting for idle would burn the whole
      // per-application budget on pages that are already interactive.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    },

    async extractFields() {
      // Delegated so the accessibility-tree logic has exactly one home; see
      // extract-fields.ts for why identification is not attribute-driven.
      return extractFields(page);
    },

    async fill(id: string, value: string) {
      // Addressed by id because modern Greenhouse boards carry NO `name`
      // attributes at all — the classic `job_application[first_name]`
      // convention is gone. Via `byId` because custom-question ids are opaque
      // and numeric-leading, which a bare `#id` selector cannot express.
      await page.locator(byId(id)).fill(value);
    },

    async attachFile(id: string, file: AttachedFile) {
      // `setInputFiles` with an in-memory payload rather than a temp file on
      // disk. Two reasons, and the second is the important one: the bytes never
      // touch the runner's filesystem, so a crashed job cannot leave a rendered
      // resume behind in an Actions workspace; and the buffer handed here is the
      // SAME one that was hashed and uploaded, so no re-read can substitute
      // different bytes for the ones the digest describes.
      //
      // NO ACTIONABILITY WAIT IS NEEDED OR WANTED. The captured Greenhouse form
      // renders its real <input type="file"> as `class="visually-hidden"` behind
      // a styled "Attach" button, so a click-and-wait-for-visible approach would
      // time out on the one real form we have. setInputFiles sets the file list
      // directly and does not require the element to be visible.
      await page.locator(byId(id)).setInputFiles({
        name: file.name,
        mimeType: file.mimeType,
        // Playwright wants a Node Buffer; the port speaks Uint8Array so nothing
        // upstream of here needs a Node type. `Buffer.from` on a Uint8Array
        // VIEWS the same memory rather than copying it.
        buffer: Buffer.from(file.bytes),
      });
    },

    async screenshot() {
      // Full page: the §18.6 review is worthless if it crops the half of the
      // form that carries the questions.
      return page.screenshot({ fullPage: true });
    },

    async detectBlocker(): Promise<BlockReason | null> {
      for (const [selector, reason] of BLOCKER_SELECTORS) {
        // `count()` rather than `isVisible()`: a captcha rendered in a hidden
        // container is still a captcha, and treating it as absent would send us
        // on to fill a form that can never be submitted.
        if ((await page.locator(selector).count()) > 0) return reason;
      }
      return null;
    },

    async submit(): Promise<never> {
      // DELIBERATELY UNIMPLEMENTED, and this is the current state of the repo
      // by design rather than by omission: there is NO code anywhere in the
      // codebase that can send an application to a real employer. DRY_RUN
      // defaults to dry-run at three independent layers, so this is
      // unreachable in normal operation — but leaving it unimplemented means
      // the guarantee does not depend on those layers being correct.
      //
      // Implementing it is one function, and it is Teja's call to make after
      // the §18.6 trust period, not a peer's.
      throw new SubmissionNotEnabledError();
    },

    async close() {
      // A leaked page keeps Chromium alive and the Actions job billing until
      // its timeout — a real cost against a budget billed in whole minutes.
      await page.close();
    },
  };
}
