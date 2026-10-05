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

// Exported so the composition root can warn at startup when an operator opts
// in to submission that this build cannot perform. One constant, so the page and
// the warning can never disagree about it.
export const SUBMISSION_IMPLEMENTED = false;

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

// Reads one react-select widget's menu and displayed value, entirely inside the page.
//
// MODULE-LEVEL AND SELF-CONTAINED ON PURPOSE: Playwright serialises a function passed to
// page.evaluate with toString() and runs it in the browser, so this may reference nothing from
// this file. It is called repeatedly (poll for the menu, read + tag options, read back the
// chosen value), so every call agrees on what "this widget" is.
// Scoping rule: the listbox named by aria-controls / aria-owns, else the widget's own subtree;
// NEVER the whole page, because another widget's open or stale menu would be clicked instead.
function readCombobox(args: { inputId: string; mark: boolean }): {
  // False when no scope could be found: the caller must fail closed, never widen the search.
  resolved: boolean;
  // The scoped options' visible texts, compared EXACTLY against the wanted answer.
  texts: string[];
  // The widget's displayed value after a pick, read back so a misclick cannot pass silently.
  shown: string | null;
} {
  // The control we were asked to fill; gone from the DOM means nothing can be resolved.
  const input = document.getElementById(args.inputId);
  // Report "unresolved" rather than throwing, so the caller can fail closed with its own error.
  if (!input) return { resolved: false, texts: [], shown: null };
  // The widget = the highest ancestor (max 6 up) that still holds ONLY this combobox, so it
  // can never swallow a sibling widget and its menu.
  let widget: Element = input;
  // Bounded climb; an unbounded one would reach <body> on a single-combobox page.
  for (let depth = 0; depth < 6; depth += 1) {
    // Stop at the document root.
    const parent: Element | null = widget.parentElement;
    // A parent holding a second combobox belongs to more than one widget; do not step into it.
    if (!parent || parent.querySelectorAll('[role="combobox"]').length !== 1) break;
    // Still exclusively ours; keep climbing.
    widget = parent;
  }
  // First id named by aria-controls, else aria-owns: the ARIA link from input to its listbox.
  const listId = (input.getAttribute('aria-controls') || input.getAttribute('aria-owns') || '')
    .trim()
    .split(/\s+/)[0];
  // With an explicit link, trust ONLY that element; without one, the widget subtree.
  const scope: Element | null = listId ? document.getElementById(listId) : widget;
  // The displayed single value (react-select's `*-single-value`), read from OUR widget only.
  const shown =
    widget.querySelector('[class*="single-value"], [class*="singleValue"]')?.textContent?.trim() ?? null;
  // An explicit link to a menu that is not rendered (yet) is unresolved, not "empty".
  if (!scope) return { resolved: false, texts: [], shown };
  // Option elements strictly inside the resolved scope.
  const found = Array.from(scope.querySelectorAll('[role="option"]'));
  // Tag them so the caller can click by position without any page-wide option query.
  if (args.mark) found.forEach((option, index) => option.setAttribute('data-applyyy-opt', String(index)));
  // Visible text per option, trimmed like every other label in this worker.
  return { resolved: true, texts: found.map((option) => option.textContent?.trim() ?? ''), shown };
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
      const target = page.locator(byId(id));
      // The caller only has (id, value), so the live element decides how to drive it. One
      // cheap read of tag/type/role; `fill()` throws on <select> and types junk into react-select.
      // Arrow returns a plain object because only serialisable data crosses back to Node.
      const live = await target.evaluate((el) => ({
        // Distinguishes <select>, <textarea> and <fieldset> from <input>.
        tag: el.tagName.toLowerCase(),
        // Distinguishes radio / checkbox from text-like inputs; `?? ''` for non-inputs.
        type: (el as HTMLInputElement).type ?? '',
        // role="combobox" is what marks a react-select, which is a text input underneath.
        role: el.getAttribute('role') ?? '',
      }));
      // Exact-match only, everywhere below: a near-miss answer ("Ind" for "India") must fail
      // loudly rather than submit a different true-looking answer in Teja's name (constraint #3).
      const wanted = value.trim();
      // One error shape for every choice control, so callers can match on the prefix.
      const noMatch = () => new Error(`no_matching_option: ${id}: "${value}"`);
      // Removes the option tags readCombobox leaves behind; used on every exit path.
      const clearOptionTags = () =>
        // Runs in the browser: a single sweep removes every tag left by readCombobox.
        page.evaluate(() =>
          document.querySelectorAll('[data-applyyy-opt]').forEach((el) => el.removeAttribute('data-applyyy-opt')),
        );

      if (live.tag === 'select') {
        // Option texts as the user sees them; the same trim the extractor applies.
        const texts = await target.evaluate((el) =>
          // Same text rule as the extractor, so planner and filler see identical options.
          Array.from((el as HTMLSelectElement).options).map((option) => option.text.trim()),
        );
        // Confirm the exact match BEFORE selectOption, which would otherwise throw a timeout
        // rather than our named error, and never fall back to a partial match.
        if (!texts.includes(wanted)) throw noMatch();
        // Safe now: the label is known to exist, so this selects exactly that option.
        await target.selectOption({ label: wanted });
        // Done; nothing else applies to a native select.
        return;
      }

      if (live.role === 'combobox') {
        // Opens the menu; react-select renders its options only while open.
        await target.click();
        // Typing filters the list, so the wanted option is on screen even in a long list.
        await target.fill(wanted);
        // Poll THIS widget's scoped menu for up to 2s. Running out is not an error: a typed
        // value with no matches renders none, and the exact check below handles that case.
        // Bounded poll instead of a page-wide waitFor, which would watch other widgets' menus.
        for (let attempt = 0; attempt < 40; attempt += 1) {
          // Scoped read, untagged, just to see whether options have rendered.
          const peek = await page.evaluate(readCombobox, { inputId: id, mark: false });
          // Options present: stop waiting.
          if (peek.texts.length > 0) break;
          // 50ms x 40 = 2s budget, small enough not to dent the per-application time budget.
          // Short sleep between polls; the loop bound caps the total wait.
          await page.waitForTimeout(50);
        }
        // Read the scoped options and tag them, so the click below never queries page-wide.
        const menu = await page.evaluate(readCombobox, { inputId: id, mark: true });
        // Position of the exact match; indexOf is strict equality, never "closest".
        const index = menu.texts.indexOf(wanted);
        // No scope (neither aria link nor an isolated widget) or no exact match: fail closed.
        if (!menu.resolved || index < 0) {
          // Leave the widget as we found it: close the menu and drop the half-typed text.
          // Closes the menu so it cannot stay open and capture a later click.
          await target.press('Escape');
          // Clears what we typed so the form is not left half-filled.
          await target.fill('');
          // A failed attempt must leave the DOM untouched.
          await clearOptionTags();
          throw noMatch();
        }
        try {
          // Click by tag: only options inside this widget's scope carry it.
          // Targets only the option tagged inside this widget's scope.
          await page.locator(`[data-applyyy-opt="${index}"]`).click();
        } finally {
          // Markers are scaffolding; never leave them behind, whether or not the click worked.
          await clearOptionTags();
        }
        // READ BACK what the widget now displays: a click can land on the wrong thing or be
        // swallowed, and nothing else would notice. Anything but the exact wanted text fails.
        const after = await page.evaluate(readCombobox, { inputId: id, mark: false });
        // The shown value must equal what we meant to choose, character for character.
        if (after.shown !== wanted) throw noMatch();
        // Verified; done.
        return;
      }

      if (live.type === 'radio' || live.tag === 'fieldset' || live.role === 'radiogroup') {
        // THE DUPLICATED BLOCK, whole: group resolution (same `name` + same form, else every
        // radio inside the wrapper fieldset/radiogroup, else the lone radio) AND the option-label
        // rule (aria-label, wrapping <label>, <label for>) MIRROR extract-fields.ts's radio
        // branch. Different runtime, cannot be imported; a change to either half must land in both.
        // The matching radio is tagged with a temporary attribute so it can be clicked even
        // when it has no id of its own.
        const found = await page.evaluate(
          ({ groupId, exact }) => {
            // `id` may be a radio's or the wrapper's (see extract-fields.ts).
            const el = document.getElementById(groupId) as HTMLElement;
            // Typed view for `.type`, `.name`, `.form`.
            const radio = el as HTMLInputElement;
            // A radio's wrapper is its nearest fieldset/group; a non-radio id IS the wrapper.
            const wrapper =
              radio.type === 'radio'
                // A radio id: its wrapper is the nearest enclosing group.
                ? radio.closest<HTMLElement>('fieldset, [role="radiogroup"], [role="group"]')
                // A wrapper id (fieldset/radiogroup): the element itself is the wrapper.
                : el;
            // Named radios group by name + form (the HTML rule); otherwise by wrapper subtree.
            const members =
              radio.type === 'radio' && radio.name
                // Named radio: every radio sharing the name, wherever it sits.
                ? Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter(
                    // Same form only, so a reused name in another form is not merged.
                    (r) => r.name === radio.name && r.form === radio.form,
                  )
                // Unnamed: the wrapper's subtree is the group.
                : Array.from((wrapper ?? el).querySelectorAll<HTMLInputElement>('input[type="radio"]'));
            for (const member of members) {
              // The option's visible label, resolved in the extractor's precedence order.
              const text =
                // Explicit accessible name first.
                member.getAttribute('aria-label')?.trim() ||
                // Then a wrapping <label>.
                member.closest('label')?.textContent?.trim() ||
                // Then <label for>; CSS.escape is valid here, this runs in the browser.
                (member.id
                  ? document.querySelector(`label[for="${CSS.escape(member.id)}"]`)?.textContent?.trim()
                  : '') ||
                // Unlabelled option: empty string can never equal a non-empty wanted value.
                '';
              // Strict equality: "yes" must not select "Yes".
              if (text === exact) {
                // Tag it for the locator below; the first exact match wins.
                member.setAttribute('data-applyyy-pick', '');
                // Stop at the first exact match; labels in one group should be unique.
                return true;
              }
            }
            // No option matched exactly; the caller turns this into no_matching_option.
            return false;
          },
          // Serialisable arguments handed to the in-page function above.
          { groupId: id, exact: wanted },
        );
        // Nothing was tagged, nothing was clicked.
        if (!found) throw noMatch();
        // The single tagged radio.
        const pick = page.locator('[data-applyyy-pick]');
        try {
          // check() (not click) so it is idempotent and verifies the box ended up checked.
          await pick.check();
        } finally {
          // Never leave the marker behind, even if check() throws.
          // Swallow cleanup errors so they cannot mask the real check() failure.
          await pick.evaluate((el) => el.removeAttribute('data-applyyy-pick')).catch(() => undefined);
        }
        // Done; nothing else applies to a radio group.
        return;
      }

      if (live.type === 'checkbox') {
        // DECISION: refuse. No caller needs checkbox auto-fill, and checkboxes on real forms are
        // consents/attestations ("I certify...", "I agree...") that a human must tick (constraint
        // #3). A throw routes the row to a person instead of attesting in Teja's name.
        throw new Error(`checkbox_not_autofilled: ${id}`);
      }

      // text / textarea / email / tel: the original behaviour, unchanged for these kinds.
      // Playwright waits for the element to be editable, so no extra wait is added.
      await target.fill(value);
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

    // Declared false alongside the throw above, so applyToOne learns BEFORE
    // `approved -> applying` that nothing can be sent and takes the dry-run
    // exit. Without it, DRY_RUN=false parked every viable row at `applying`
    // as an unknown outcome. Flip both together, never one alone.
    submissionImplemented: SUBMISSION_IMPLEMENTED,

    async close() {
      // A leaked page keeps Chromium alive and the Actions job billing until
      // its timeout — a real cost against a budget billed in whole minutes.
      await page.close();
    },
  };
}
