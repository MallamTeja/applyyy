// Binds the `ApplicationPage` port onto a real Playwright page.
//
// This is the only file that knows Playwright exists, which is what lets every
// other module in the worker be tested with a plain object. It is also where
// the accessibility-tree extraction and the anti-bot detection meet a live DOM.
import type { Page } from 'playwright';
import type { BlockReason } from '@applyy/shared-types';
import { extractFields } from './extract-fields.js';
import type { ClosableApplicationPage } from './claim-loop.js';

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
      // convention is gone. Escaped because custom-question ids are opaque and
      // numeric-leading, which a bare `#id` selector cannot express.
      await page.locator(`#${CSS.escape(id)}`).fill(value);
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
