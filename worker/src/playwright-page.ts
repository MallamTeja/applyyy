// Binds the `ApplicationPage` port onto a real Playwright page.
//
// This is the only file that knows Playwright exists, which is what lets every
// other module in the worker be tested with a plain object. It is also where
// the accessibility-tree extraction and the anti-bot detection meet a live DOM.
import type { Page } from 'playwright';
import type { BlockReason } from '@applyy/shared-types';
import { extractFields } from './extract-fields.ts';
import type { ClosableApplicationPage } from './claim-loop.ts';
// The one document shape that crosses into a real employer's form, and the one
// answer shape that comes back from submitting it.
import type { AttachedFile, SubmitResult } from './apply-one.ts';

// Exported so the composition root can say at startup whether this build can
// send anything. One constant, so the page and the log can never disagree.
// True since 2026-10-09 (Teja's ruling: the system submits by itself). DRY_RUN
// still defaults to dry at every layer; this says only that the build CAN.
export const SUBMISSION_IMPLEMENTED = true;

/**
 * Selectors that indicate a wall we must not try to get past.
 *
 * CONSTRAINT #5: never bypass a captcha, MFA, authentication control or
 * anti-bot mechanism. Detection exists to ROUTE TO A HUMAN, never to work
 * around — so this list grows when we find new walls, and nothing downstream of
 * it ever attempts a solve.
 *
 * INVISIBLE reCAPTCHA IS DELIBERATELY NOT A WALL. Greenhouse loads it on every
 * board (GOOGLE_RECAPTCHA_INVISIBLE_KEY in the page). It asks the human nothing;
 * it scores the browser when Submit is pressed and only becomes a wall if Google
 * then shows a challenge. Counting its always-present anchor iframe as a captcha
 * would park every Greenhouse application before a single field was read. The
 * escalation is still caught: VISIBLE_CHALLENGE_SELECTORS runs after the click.
 * Matching invisible ones out is done in the selector, not by a visibility test,
 * so a checkbox widget hidden in a collapsed section is still a wall.
 */
const BLOCKER_SELECTORS: ReadonlyArray<readonly [string, BlockReason]> = [
  // Google reCAPTCHA's widget iframe, except the invisible variant's anchor.
  ['iframe[src*="recaptcha"][src*="/anchor"]:not([src*="size=invisible"])', 'captcha'],
  // The classic checkbox container, except one declared invisible.
  ['.g-recaptcha:not([data-size="invisible"])', 'captcha'],
  // hCaptcha, used by Cloudflare-fronted boards. Its invisible mode is rare and
  // unconfirmed on any board we target, so every hCaptcha frame stays a wall.
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
 * A challenge the user would have to answer, tested for VISIBILITY.
 *
 * Used before the fill (a challenge already on screen) and after the click
 * (invisible reCAPTCHA escalating). Visibility is the right test here, unlike
 * above: reCAPTCHA pre-renders its challenge frame hidden, and only showing it
 * means Google is actually asking.
 */
const VISIBLE_CHALLENGE_SELECTORS: readonly string[] = [
  // reCAPTCHA's challenge frame ("bframe"), standard and enterprise endpoints.
  'iframe[src*="recaptcha"][src*="/bframe"]',
  // Any frame titled as a challenge, whichever provider drew it.
  'iframe[title*="challenge" i]',
  // hCaptcha's challenge frame, for the same post-click escalation.
  'iframe[src*="hcaptcha"][src*="challenge"]',
];

/**
 * THE SHAPE OF A CONFIRMATION, asserted positively (§6).
 *
 * Both must hold: the URL is THIS job's confirmation route (same origin, and the
 * form's own path plus `/confirmation`), and a heading thanks the applicant.
 * Either alone could be something else (a marketing "thank you" banner, another
 * job's confirmation, a redirect to a page that merely contains "confirmation"),
 * and a false "applied" is the one wrong answer that cannot be walked back — so
 * anything short of both is `unconfirmed`.
 */
// Greenhouse's route after a successful application: the job's own path plus
// /confirmation, optionally with a trailing slash. Matched against the path
// derived from the form's URL (see expectedConfirmationPath), never on its own.
const CONFIRMATION_SUFFIX = '/confirmation';
// The heading text Greenhouse shows on that page. Case-insensitive, nothing else loosened.
const CONFIRMATION_HEADING = /thank you for applying/i;

// How long to watch the page after the click before declaring the outcome unknown.
// A real Greenhouse submit is a reCAPTCHA token fetch plus one POST: seconds.
// Long enough for a slow board; short enough that a hung page fails fast.
const SUBMIT_OUTCOME_TIMEOUT_MS = 45_000;
// How often the page is re-read while waiting. A cheap DOM read, so a quarter second.
const SUBMIT_POLL_INTERVAL_MS = 250;
// How long a "nothing was sent" answer (form rejection, visible challenge) must hold,
// with no request that could carry the application, before it is believed. Longer than
// an invisible-reCAPTCHA token round trip, which is what can delay a real send.
const REJECTION_SETTLE_MS = 5_000;
// Request types that can carry form data whatever their method (see submit()).
const SEND_CAPABLE_TYPES: ReadonlySet<string> = new Set(['xhr', 'fetch', 'document', 'ping', 'eventsource']);
// ponytail: WebSocket frames are invisible here (Chromium reports sockets as `websocket`
// events, never as requests). No target board submits over a socket; if one ever does,
// subscribe to context `websocket` + `framesent` and count frames as sends.

/**
 * Whether a request is the CAPTCHA PROVIDER's own traffic, not the employer's.
 *
 * A request from the page after the click is the application leaving, unless it
 * is reCAPTCHA scoring the browser (its `/recaptcha/` endpoints on Google or
 * recaptcha.net, and its assets on gstatic) or hCaptcha. Matched on host AND,
 * for Google's shared domains, on the `/recaptcha/` path: `docs.google.com/forms`
 * or `script.google.com` can carry a real application and must count as a send.
 * Exact host comparison on a parsed URL, so `evilgoogle.com` or a lookalike
 * subdomain of an employer domain is never exempt.
 */
function isCaptchaTraffic(url: string): boolean {
  // Unparseable URLs are NOT exempt: an unknown request counts as possibly the send.
  let parsed: URL;
  try {
    // Host lower-cased by the URL parser already.
    parsed = new URL(url);
  } catch {
    // Treat as employer traffic, the cautious reading.
    return false;
  }
  // Read once for the checks below.
  const host = parsed.hostname;
  // Google's shared hosts are exempt ONLY on reCAPTCHA's own path.
  const recaptchaPath = parsed.pathname.startsWith('/recaptcha/');
  // reCAPTCHA's API endpoints (anchor, bframe, reload, userverify).
  if (['www.google.com', 'google.com', 'www.recaptcha.net', 'recaptcha.net'].includes(host) && recaptchaPath) return true;
  // reCAPTCHA's static assets, served from gstatic under the same path.
  if ((host === 'gstatic.com' || host.endsWith('.gstatic.com')) && recaptchaPath) return true;
  // hCaptcha serves nothing but captchas, so its whole domain is exempt.
  return host === 'hcaptcha.com' || host.endsWith('.hcaptcha.com');
}

/**
 * The only path this form's confirmation may have: the form's own path plus
 * `/confirmation`. Null when the form's URL is ITSELF a confirmation route,
 * because then "we are on a confirmation page" says nothing about this click.
 */
function expectedConfirmationPath(startUrl: string): string | null {
  // The form's path without a trailing slash, so both spellings compare equal.
  const startPath = new URL(startUrl).pathname.replace(/\/$/, '');
  // Already a confirmation page before we clicked: no confirmation can be proved.
  if (startPath.endsWith(CONFIRMATION_SUFFIX)) return null;
  // The one acceptable destination.
  return `${startPath}${CONFIRMATION_SUFFIX}`;
}

/** The heading on the page that thanks the applicant, or null. Runs in the browser. */
function readConfirmationHeading(pattern: { source: string; flags: string }): string | null {
  // RegExp cannot cross into the page, so it is rebuilt from its parts.
  const re = new RegExp(pattern.source, pattern.flags);
  // Headings only: a "thank you" in a footer or cookie banner is not a confirmation.
  for (const heading of Array.from(document.querySelectorAll('h1, h2, h3'))) {
    // Trimmed text, the same normalisation every other label here gets.
    const text = heading.textContent?.trim() ?? '';
    // First matching heading is the evidence.
    if (re.test(text)) return text;
  }
  // No heading matched.
  return null;
}

/**
 * The labels of every field the form has marked invalid. Runs in the browser.
 *
 * Two sources, because two different things can refuse a submit in the browser:
 * - `aria-invalid="true"`, the attribute Greenhouse's form script sets on a
 *   field it rejected;
 * - the browser's OWN constraint validation (`:invalid`, e.g. an empty
 *   `required`), which stops a click before any request and leaves no
 *   attribute behind. Without this a natively-blocked click looked like a hang
 *   and ended `unconfirmed` for an application that provably never left.
 *   Only in forms without `novalidate`, where the browser actually enforces it.
 * The label resolution mirrors the extractor's order (aria-label,
 * aria-labelledby, <label for>, wrapping <label>) so the names the human sees
 * match the names the planner used.
 */
function readInvalidFieldLabels(): string[] {
  // Every field flagged by script, plus every field the browser itself would
  // refuse in an enforcing form. Controls only: `:invalid` also matches the
  // form and its fieldsets, which are containers, not questions.
  const flagged = document.querySelectorAll<HTMLElement>(
    '[aria-invalid="true"], form:not([novalidate]) :is(input, select, textarea):invalid',
  );
  // One selector list returns each element once, in document order, so a field
  // that is both script-flagged and natively invalid is already named only once.
  const invalid = Array.from(flagged);
  // One label per flagged field.
  return invalid.map((el) => {
    // An explicit accessible name wins.
    const aria = el.getAttribute('aria-label')?.trim();
    // Present and non-empty: use it.
    if (aria) return aria;
    // Then the elements the field says label it.
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '')
      // Space-separated ids.
      .split(/\s+/)
      // Each id's text, if the element exists.
      .map((id) => (id ? document.getElementById(id)?.textContent?.trim() ?? '' : ''))
      // Drop the empties.
      .filter(Boolean)
      // One name.
      .join(' ');
    // Present: use it.
    if (labelledBy) return labelledBy;
    // Then a <label for>. CSS.escape is valid here: this runs in the browser.
    const forLabel = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : '';
    // Present: use it.
    if (forLabel) return forLabel;
    // Then a wrapping <label>, and finally the id, so a label is never blank.
    return el.closest('label')?.textContent?.trim() || el.id || el.tagName.toLowerCase();
  });
}

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

/** The value raceDeadline resolves to when time ran out first. A unique symbol, so no read can return it. */
const DEADLINE_PASSED: unique symbol = Symbol("deadline passed");

/**
 * Resolve to the work's value, or to DEADLINE_PASSED after `ms`, whichever is first.
 * Never rejects on the timer's account, and always clears its timer.
 */
async function raceDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof DEADLINE_PASSED> {
  // Kept so the timer can be cleared when the work wins.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // First to settle wins; the timer branch only ever resolves.
    return await Promise.race([
      // The page read being bounded.
      work,
      // The deadline, as a resolved sentinel rather than an error.
      new Promise<typeof DEADLINE_PASSED>((resolve) => {
        // Started inside the executor so the handle exists before the race settles.
        timer = setTimeout(() => resolve(DEADLINE_PASSED), ms);
      }),
    ]);
  } finally {
    // Cleared either way, so a finished run never waits out a stale timer.
    clearTimeout(timer);
  }
}

/** Tunables for tests. Production passes nothing and gets the constants above. */
export interface PlaywrightPageOptions {
  // How long submit() watches for an outcome. A test of the hang case sets it low
  // so it does not sit through 45 real seconds.
  readonly submitOutcomeTimeoutMs?: number;
  // How long a "nothing was sent" answer must hold. Tests set it low for speed.
  readonly rejectionSettleMs?: number;
}

export function createPlaywrightPage(page: Page, options: PlaywrightPageOptions = {}): ClosableApplicationPage {
  // The deadline submit() uses: the test override, or the production constant.
  const submitOutcomeTimeoutMs = options.submitOutcomeTimeoutMs ?? SUBMIT_OUTCOME_TIMEOUT_MS;
  // The settle window submit() uses: the test override, or the production constant.
  const rejectionSettleMs = options.rejectionSettleMs ?? REJECTION_SETTLE_MS;
  /** Whether any challenge frame is on screen now. Shared by detectBlocker and submit. */
  async function visibleChallenge(): Promise<boolean> {
    for (const selector of VISIBLE_CHALLENGE_SELECTORS) {
      // `.first().isVisible()` resolves false when nothing matches, and never waits.
      if (await page.locator(selector).first().isVisible()) return true;
    }
    // No challenge frame is showing.
    return false;
  }

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
      // A challenge already on screen, from a provider whose frames are not in
      // the list above or from invisible reCAPTCHA escalating on page load.
      if (await visibleChallenge()) return 'captcha';
      return null;
    },

    async submit(): Promise<SubmitResult> {
      // THE ONE CODE PATH THAT SENDS AN APPLICATION. Reached only from
      // applyToOne, only when DRY_RUN is exactly "false", only after the row is
      // `applying`. Everything here is ordered so that every case it cannot
      // positively recognise as a confirmation comes back `unconfirmed`.

      // EXACTLY ONE VISIBLE submit control INSIDE A FORM, or no click at all. Two
      // would mean we cannot know which one sends the application (a "save draft"
      // beside "submit"); zero means this is not the form we filled. Scoped to
      // forms so an unrelated page-level button cannot be the one clicked, and
      // visible-only so a hidden control cannot stall the click into a timeout
      // that would read as an unknown outcome for an application never sent.
      const buttons = page.locator('form button[type="submit"]:visible, form input[type="submit"]:visible');
      // Counted, not assumed: a plain locator would click the first of several.
      const buttonCount = await buttons.count();
      // Not exactly one: refuse before touching anything.
      if (buttonCount !== 1) {
        // Nothing was clicked, so this is safe to park as a form-shape problem.
        return { kind: 'not_attempted', reason: 'unsupported_form', detail: `expected 1 visible submit control in a form, found ${buttonCount}` };
      }

      // A field the form ALREADY marks invalid would make the click a rejection
      // at best. Checked before the click, so no click is spent learning it.
      const invalidBefore = await page.evaluate(readInvalidFieldLabels);
      // Any flagged field: park without clicking, naming the fields.
      if (invalidBefore.length > 0) {
        // Same answer shape as a post-click rejection, but nothing was attempted.
        return { kind: 'not_attempted', reason: 'unanswerable_question', detail: `invalid before submit: ${invalidBefore.join('; ')}` };
      }

      // Where we were, so "no navigation" can be told apart from "navigated".
      const startUrl = page.url();
      // This job's own confirmation path, or null if the form URL already is one
      // (in which case no confirmation can be proved, and the loop never confirms).
      const confirmationPath = expectedConfirmationPath(startUrl);
      // The form's origin; a confirmation on any other origin is not this form's.
      const startOrigin = new URL(startUrl).origin;

      // WHAT LEFT THE PAGE after the click. "Blocked" is a claim that nothing was
      // sent, so it must be proved, not inferred from the page's look. A request
      // counts as a possible send if it is not the captcha provider's AND it is
      // either a non-GET (a POST of the form) or a type that can carry data with
      // any method: xhr/fetch (an async submit, even a GET with query
      // parameters), document (a form GET navigating, even back to the same URL),
      // ping (sendBeacon), eventsource. Analytics beacons also land here; that only
      // turns a provable "blocked" into `unconfirmed`, the safe direction.
      // Recorded from just before the click so nothing it causes is missed.
      const employerWrites: string[] = [];
      // The page's whole browser context, not the page alone: a `target="_blank"` form or a
      // window.open submit sends from a POPUP, which page-level events never see. Each
      // application gets its own context (browser.newPage), so nothing else shares it.
      const context = page.context();
      // One listener for the whole wait; removed in `finally` so it cannot outlive this call.
      const onRequest = (request: { method(): string; url(): string; resourceType(): string }) => {
        // Either half makes it a possible carrier of the application.
        const canCarry = request.method() !== 'GET' || SEND_CAPABLE_TYPES.has(request.resourceType());
        // Captcha scoring is the one exempt traffic.
        if (canCarry && !isCaptchaTraffic(request.url())) {
          // Kept as "METHOD type url" so the unknown outcome's detail names what went out.
          employerWrites.push(`${request.method()} ${request.resourceType()} ${request.url()}`);
        }
      };
      // Attached BEFORE the click: a request fired by the click itself is the one that matters most.
      context.on('request', onRequest);

      try {
        // THE CLICK. noWaitAfter: Playwright must not decide when the page is
        // "done"; the loop below does, with its own positive test.
        await buttons.click({ noWaitAfter: true });

        // Poll until a recognisable outcome or the deadline. A loop of cheap reads
        // rather than one waitFor, because three different outcomes are watched at once.
        const deadline = Date.now() + submitOutcomeTimeoutMs;
        // The last page description seen, reported if nothing was recognised.
        let lastSeen = 'no observation';

        /**
         * ONE LOOK AT THE PAGE: a final outcome, a "nothing was sent" outcome that
         * must first survive the settle window (`pending`), or a description.
         * A function so the loop can bound it as a whole (see the race below).
         */
        const observe = async (): Promise<SubmitResult | { readonly pending: SubmitResult } | string> => {
          // 1. CONFIRMED: both halves of the positive shape (see CONFIRMATION_SUFFIX).
          const url = page.url();
          // Parsed once; the path alone, so a query string or fragment cannot fake or hide it.
          const parsed = new URL(url);
          // Same origin AND exactly this job's confirmation path (trailing slash tolerated).
          const pathOk = confirmationPath !== null
            && parsed.origin === startOrigin
            && parsed.pathname.replace(/\/$/, '') === confirmationPath;
          // The heading is read only on the confirmation route, saving a DOM read per poll.
          const heading = pathOk
            ? await page.evaluate(readConfirmationHeading, { source: CONFIRMATION_HEADING.source, flags: CONFIRMATION_HEADING.flags })
            : null;
          // The route, the heading, AND evidence that something left the page. The
          // last is free insurance: a page that shows "thank you" without any
          // request after our click did not get an application from us.
          if (pathOk && heading !== null && employerWrites.length > 0) {
            // Evidence quotes exactly what matched, for the `applied` event.
            return { kind: 'confirmed', evidence: `url=${url} heading="${heading}"` };
          }

          // 2. CHALLENGED: invisible reCAPTCHA escalated to a question for a human.
          if (await visibleChallenge()) {
            // Something reached the employer: the send may have happened.
            if (employerWrites.length > 0) {
              return { kind: 'unconfirmed', detail: `challenge shown after ${employerWrites.join(', ')}` };
            }
            // Nothing sent YET. Pending, not final: see the settle window below.
            return { pending: { kind: 'challenge', reason: 'captcha' } };
          }

          // 3. REJECTED IN THE BROWSER: still on the form, fields now flagged.
          // Only while the URL is unchanged: after a navigation, flags on some
          // other page say nothing about whether this form was sent.
          if (url === startUrl) {
            // The fields the form refused, by the names the human knows them by.
            const invalid = await page.evaluate(readInvalidFieldLabels);
            // Flagged fields AFTER a send: server-side errors on an application that
            // may have been stored. Unknown, never "blocked".
            if (invalid.length > 0 && employerWrites.length > 0) {
              return { kind: 'unconfirmed', detail: `fields flagged (${invalid.join('; ')}) after ${employerWrites.join(', ')}` };
            }
            // Flagged with nothing sent YET. Pending, not final: see the settle window.
            if (invalid.length > 0) return { pending: { kind: 'rejected_by_form', labels: invalid } };
          }

          // Nothing recognised yet; described, in case nothing ever is.
          return `url=${url}${pathOk ? ' (confirmation path, no thank-you heading)' : ''}`;
        };

        // THE SETTLE WINDOW for "nothing was sent" answers. One look is not proof: a
        // validate-on-blur script can flag a field the instant Submit takes focus,
        // while the form's own handler is still waiting on the reCAPTCHA token and
        // POSTs a moment later. Answering "blocked" on that first look would park a
        // SENT application for a human, who would then submit it again by hand. So a
        // pending answer must hold, unchanged and with no send seen, for the whole
        // window; any send in the meantime turns it into `unconfirmed` (observe's
        // other branches), and a deadline inside the window does the same.
        let pending: { readonly result: SubmitResult; readonly since: number } | null = null;

        while (Date.now() < deadline) {
          // EVERY LOOK IS RACED AGAINST THE TIME LEFT. A single page read can block
          // indefinitely (measured: isVisible() during a navigation whose request
          // never completes), and the deadline was only checked between looks, so
          // one stuck read made submit() hang until the job timeout instead of
          // answering `unconfirmed`. The abandoned read settles later, harmlessly:
          // its rejection is caught below, so it is never unhandled.
          const step = await raceDeadline(
            // A read that fails mid-navigation is just "not yet", described as such.
            observe().catch((error: unknown) => `page read failed: ${error instanceof Error ? error.message : String(error)}`),
            // What is left of the budget; never negative.
            Math.max(0, deadline - Date.now()),
          );
          // The deadline won: stop looking, and say why in the unknown outcome.
          if (step === DEADLINE_PASSED) {
            // Recorded so the human verifying it knows the page stopped answering.
            lastSeen = `${lastSeen}; then a page read did not return before the deadline`;
            break;
          }
          if (typeof step === 'string') {
            // A plain description: whatever was pending has cleared, so its clock resets.
            pending = null;
            // Kept, in case nothing is ever recognised.
            lastSeen = step;
          } else if ('pending' in step) {
            // A "nothing sent" answer. Start its clock, or restart it if the answer changed kind.
            if (pending === null || pending.result.kind !== step.pending.kind) {
              pending = { result: step.pending, since: Date.now() };
            } else if (Date.now() - pending.since >= rejectionSettleMs) {
              // Held for the whole window with no send seen. A window only proves "nothing
              // YET": a handler still awaiting a slow reCAPTCHA token could POST after it.
              // So the answer is made TRUE BY CONSTRUCTION: every further request from this
              // context is aborted from here on (the page is closed after the status write
              // and never used again), and only then is the log read one final time.
              // The page too, not only the context: Playwright runs page routes before
              // context routes, and the most recently registered page route first, so this
              // seal wins over any route already on the page. The context seal covers popups.
              await page.route('**/*', (route) => route.abort());
              // Every other page this context opens (a target="_blank" submit, a popup).
              await context.route('**/*', (route) => route.abort());
              // Anything that slipped out while the seal was being installed shows up here.
              if (employerWrites.length > 0) {
                // A send raced the seal: unknown, never "nothing was sent".
                return { kind: 'unconfirmed', detail: `${step.pending.kind} held ${rejectionSettleMs}ms, then ${employerWrites.join(', ')}` };
              }
              // Sealed with nothing sent: now the answer is proof, and stays true.
              return step.pending;
            }
            // Described in case the deadline arrives mid-window.
            lastSeen = `${step.pending.kind} seen, waiting ${rejectionSettleMs}ms for any late send`;
          } else {
            // A final outcome (confirmed, or unconfirmed after a send): done.
            return step;
          }
          // Wait a beat before the next look. A plain timer, not page.waitForTimeout,
          // so even the pause cannot depend on a page that has stopped responding.
          await new Promise((resolve) => setTimeout(resolve, SUBMIT_POLL_INTERVAL_MS));
        }

        // THE DEADLINE PASSED WITH NOTHING PROVED. The click happened, so this is
        // the unknown case: never `failed`, never `applied`, never retried.
        return {
          kind: 'unconfirmed',
          // Names what went out, so the human verifying it knows whether a send happened.
          detail: `no confirmation within ${submitOutcomeTimeoutMs}ms; last seen ${lastSeen}; requests that could carry it: ${employerWrites.join(', ') || 'none'}`,
        };
      } finally {
        // Detached on every exit, so a later page action is never recorded against this submit.
        context.off('request', onRequest);
      }
    },

    // Read by applyToOne BEFORE `approved -> applying`. True now that submit()
    // above is real; it and that implementation change together, never apart.
    submissionImplemented: SUBMISSION_IMPLEMENTED,

    async close() {
      // A leaked page keeps Chromium alive and the Actions job billing until
      // its timeout — a real cost against a budget billed in whole minutes.
      await page.close();
    },
  };
}
