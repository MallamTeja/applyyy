// Binds the `ApplicationPage` port onto a real Playwright page.
//
// This is the only file that knows Playwright exists, which is what lets every
// other module in the worker be tested with a plain object. It is also where
// the accessibility-tree extraction and the anti-bot detection meet a live DOM.
import type { Page } from 'playwright';
import type { BlockReason } from '@applyy/shared-types';
import { extractFields } from './extract-fields.ts';
// The ATS posting-API check postingClosed() asks before trusting a page's status (2026-11-09).
import { createListingCheck, type ListingCheck } from './posting-listing.ts';
// The production JSON GET (timeout, non-JSON reads as null), the same one the form-URL resolver uses.
import { fetchJson } from './form-url.ts';
import type { ClosableApplicationPage } from './claim-loop.ts';
// The one document shape that crosses into a real employer's form, and the one
// answer shape that comes back from submitting it.
import type { AttachedFile, SubmitResult } from './apply-one.ts';
// A VALUE import: fill() throws it when a no-match left the control provably empty, the one
// case the caller may degrade to "left blank". No cycle: apply-one.ts never imports this file.
import { OptionNotFoundError } from './apply-one.ts';

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
/* B2 (P1-6, 2026-11-05): the sentences ATS boards print on a closed posting. Whole phrases, so a
   job description that merely mentions "expired" or "filled" does not match. Case-insensitive. */
/* T1 (2026-11-05): a fillable control, the sign that a form has rendered. Ashby boards are a
   client-side app: at `domcontentloaded` the page holds 0 controls and the form appears ~6 s
   later (measured on a live Quora posting: 0 controls at 6.4 s, 22 fields at 9.1 s). Read
   before then, the kit called 11 open Ashby postings closed. Hidden inputs do not count: a
   shell page can carry tokens before any question renders. */
export const FORM_CONTROL_SELECTOR = 'input:not([type="hidden"]), textarea, select';
// How long goto waits for that control before handing the page over as it is. A page that
// never renders one (a careers index, an iframe-only company page) costs this much once per
// load; 15 s clears the measured 6-9 s Ashby render with room for a slow CI runner.
export const FORM_RENDER_TIMEOUT_MS = 15_000;
// T3: the bound on readMenuOptions' click and Escape. A visible widget answers in milliseconds;
// one that cannot be clicked (hidden, covered) costs this once, then the kit lists it without options.
const MENU_ACTION_TIMEOUT_MS = 2_000;
// How long after the first click readMenuOptions keeps re-clicking a widget that still says
// aria-expanded="false" (hydration landed after `load`; the Stripe Country flake, 2026-11-07).
// Live hydration took ~1.8 s from goto, most of it before `load`, so 1.5 s past `load` covers it;
// a widget that truly cannot open costs this once, then reads as "no list".
const MENU_HYDRATION_RETRY_MS = 1_500;
// The beat between those re-clicks: long enough for a handler to attach, short enough that a
// hydrated widget opens within one interval.
const MENU_RECLICK_INTERVAL_MS = 150;

export const CLOSED_POSTING = /no longer accepting applications|(?:this |the )?(?:position|role|job) has been filled|(?:this |the )?(?:job|position|posting)(?: posting)? is no longer (?:available|open|active)|this job (?:has )?(?:expired|closed)|job not found|(?:the )?page you(?:'re| are) looking for (?:could not|cannot|can't) be found/i;

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
 * All three must hold: the URL is THIS job's confirmation route (same origin, and the
 * form's own path plus `/confirmation`), and a heading or the page title thanks
 * the applicant; plus, at the call site, a request left the page after the click.
 * Either alone could be something else (a marketing "thank you" banner, another
 * job's confirmation, a redirect to a page that merely contains "confirmation"),
 * and a false "applied" is the one wrong answer that cannot be walked back — so
 * anything short of all three is `unconfirmed`.
 */
// Greenhouse's route after a successful application: the job's own path plus
// /confirmation, optionally with a trailing slash. Matched against the path
// derived from the form's URL (see expectedConfirmationPath), never on its own.
const CONFIRMATION_SUFFIX = '/confirmation';
// The heading on that page is the EMPLOYER's own rich text, so its wording varies:
// GitLab says "Thank you for applying", Gusto says "Thanks for applying!". Both forms
// are accepted; anything that does not thank the applicant for APPLYING still fails.
const CONFIRMATION_HEADING = /thank(s| you) for applying/i;
// The page <title> is Greenhouse's own template, the same on every board checked
// (8 of 8, Gusto included), so it is the stable signal. Anchored at the start: a title
// that merely mentions applying somewhere is not the confirmation template.
const CONFIRMATION_TITLE = /^thank you for applying/i;

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
// How long attachFile waits for Greenhouse's S3 upload to reach its done state. The
// resume is a few hundred KB, which a runner uploads in a second or two; 30s is an
// order of magnitude of slack for a slow S3 region. It is spent BEFORE `applying`, so a
// timeout costs only run time, never an unknown outcome; and it must be finite, because
// the widget's XHR error handler only logs and a failed upload never leaves its bar.
const FILE_UPLOAD_TIMEOUT_MS = 30_000;
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
 * Whether a URL is on Greenhouse's own hosts (greenhouse.io or a subdomain of it).
 *
 * Scopes the HTTP 428 "security code required" reading (see submit()) to the one board
 * whose meaning of 428 was measured: Axiad, row 3c476629, 2026-10-24 13:46 IST, where the
 * submit POST answered 428 and Greenhouse emailed "Security code for your application" in
 * the same minute. Another server's 428 is only "Precondition Required" in general and
 * proves nothing about whether an application was stored, so it stays `unconfirmed`.
 * Exact host comparison on a parsed URL, so `greenhouse.io.evil.example` never matches.
 */
function isGreenhouseUrl(url: string): boolean {
  // Unparseable URLs are NOT Greenhouse's: the 428 reading then never applies (fail closed).
  let host: string;
  try {
    // The parser lower-cases the host, so the comparison below needs no case folding.
    host = new URL(url).hostname;
  } catch {
    // No host, no scope: the response stays evidence only.
    return false;
  }
  // The apex itself, or any subdomain (job-boards., boards., boards-api.).
  return host === 'greenhouse.io' || host.endsWith('.greenhouse.io');
}

// HTTP 428 Precondition Required. On a Greenhouse submit POST it is the email-verification
// gate: the application was NOT accepted, and Greenhouse emailed a code to paste and resubmit.
// A named constant so the one status the named outcome hangs on is greppable and exact.
const GREENHOUSE_SECURITY_CODE_STATUS = 428;

/**
 * The machine-readable `code` of an error response body, or null.
 *
 * Only a JSON object with a non-empty string `code` counts (Greenhouse:
 * `{"code":"captcha-failed",…}`). An HTML firewall page, a bare string or a numeric
 * code yields null rather than a guess (CLAUDE.md §6: a lenient parse is not an answer).
 */
function readErrorCode(body: string): string | null {
  // Not JSON at all: no code, and no exception escapes into the response listener.
  let parsed: unknown;
  try {
    // The whole body; Greenhouse's refusal is a small JSON object.
    parsed = JSON.parse(body);
  } catch {
    // An HTML or plain-text refusal carries no code.
    return null;
  }
  // An object, not null or an array, holding the field.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  // Read once.
  const code = (parsed as Record<string, unknown>)['code'];
  // A non-empty string only, so it reads as the board wrote it.
  return typeof code === 'string' && code.trim().length > 0 ? code.trim() : null;
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

/**
 * The text on the page that thanks the applicant, as ready-made evidence
 * (`heading="..."` or `title="..."`), or null. Runs in the browser.
 *
 * Either source is enough for the TEXT half of the confirmation; the route and the
 * employer-request checks around it are what make the whole answer safe.
 */
function readConfirmationText(patterns: {
  heading: { source: string; flags: string };
  title: { source: string; flags: string };
}): string | null {
  // RegExp cannot cross into the page, so each is rebuilt from its parts.
  const headingRe = new RegExp(patterns.heading.source, patterns.heading.flags);
  // Same reason for the title pattern.
  const titleRe = new RegExp(patterns.title.source, patterns.title.flags);
  // Headings only: a "thank you" in a footer or cookie banner is not a confirmation.
  for (const heading of Array.from(document.querySelectorAll('h1, h2, h3'))) {
    // Trimmed text, the same normalisation every other label here gets.
    const text = heading.textContent?.trim() ?? '';
    // First matching heading is the evidence; JSON.stringify quotes it unambiguously.
    if (headingRe.test(text)) return `heading=${JSON.stringify(text)}`;
  }
  // document.title is already whitespace-collapsed and trimmed by the browser.
  const title = document.title;
  // Greenhouse's template title: the fallback when the employer reworded the heading.
  if (titleRe.test(title)) return `title=${JSON.stringify(title)}`;
  // Neither source thanked the applicant.
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
 * The labels of every REQUIRED control that holds no value, whatever the form's validation mode.
 * Runs in the browser. Exported for its tests (lever-required-unfilled.test.ts).
 *
 * THE GAP IT CLOSES (P2-17, 2026-11-09). readInvalidFieldLabels sees only what the browser or the
 * board's script already flagged. Lever's form validates in script (`novalidate`), and its custom
 * multiple-choice cards mark required-ness ONLY with a ✱ in `.application-label`: no `required`, no
 * id, no fieldset. The extractor drops such a card, so the planner never sees it and raises no
 * blocker, and the old pre-click check let the click send the application with the answer blank.
 * This reads required-ness the three ways boards declare it and refuses on any empty one. It does
 * not care WHY a control is empty (an extraction gap, a fill that silently missed), which is the
 * point: a required question nobody planned for is caught here too, not only radios.
 *
 * Skipped, each for a reason: aria-hidden (Greenhouse's react-select sentinels, filled by the board's
 * own script, never by us); role="combobox" (react-select's search box is empty AFTER a pick; the
 * filler verifies those by readback); disabled (barred from submission, as native validation agrees).
 */
export function readUnfilledRequiredLabels(): string[] {
  // One label per question, in DOM order; a Set stops a radio group naming itself once per option.
  const labels = new Set<string>();
  // Controls inside forms only: a page-level search box is never part of the application.
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('form :is(input, select, textarea)'))) {
    // Sentinels, react-select search boxes and disabled controls: see the docstring.
    if (el.getAttribute('aria-hidden') === 'true' || el.getAttribute('role') === 'combobox' || el.disabled) continue;
    // Machinery, not questions (`type` is the tag-appropriate value for select and textarea too).
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue;
    // Lever's question wrapper, when there is one: it holds both the ✱ and the human's label.
    const question = el.closest('.application-question');
    // Required by the native attribute, by ARIA, or by Lever's ✱ mark on the enclosing question.
    const required = el.required || el.getAttribute('aria-required') === 'true' || question?.querySelector('.application-label .required') != null;
    // Optional questions never stop a submit.
    if (!required) continue;
    // A radio or checkbox is answered when ANY member of its group (same name, same form) is checked.
    const filled = el.type === 'radio' || el.type === 'checkbox'
      ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="${el.type}"]`)).some(
          // Unnamed: the control is its own group.
          (other) => other.checked && (el.name ? other.name === el.name && other.form === el.form : other === el),
        )
      // A file input is answered when something is attached.
      : el.type === 'file'
        ? (el.files?.length ?? 0) > 0
        // Everything else by its value; whitespace alone is not an answer.
        : el.value.trim() !== '';
    // Answered: nothing to report.
    if (filled) continue;
    // Lever's question text first (never an option's "Yes"), with its ✱ stripped as the extractor does.
    const leverLabel = question?.querySelector('.application-label')?.textContent?.replace(/\s*[*✱]\s*$/, '').trim();
    // Then the usual accessible names, and finally the id or name so a label is never blank.
    labels.add(leverLabel || el.getAttribute('aria-label')?.trim() || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : '') || el.closest('label')?.textContent?.trim() || el.id || el.name || el.tagName.toLowerCase());
  }
  // In DOM order, deduplicated.
  return [...labels];
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
  // True ONLY on the positive shape of an empty react-select (see below). A missing value
  // element is NOT emptiness: it may just be a value this reader cannot see.
  empty: boolean;
} {
  // The control we were asked to fill; gone from the DOM means nothing can be resolved.
  const input = document.getElementById(args.inputId);
  // Report "unresolved" rather than throwing, so the caller can fail closed with its own error.
  if (!input) return { resolved: false, texts: [], shown: null, empty: false };
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
  // EMPTY, asserted positively, because a skip submits whatever the widget holds:
  // react-select renders its placeholder only while nothing is chosen...
  const empty =
    widget.querySelector('[class*="placeholder"]') !== null &&
    // ...no single value is displayed...
    !shown &&
    // ...no multi-select chips (isMulti renders `*-multi-value`, which `shown` never sees)...
    widget.querySelector('[class*="multi-value"], [class*="multiValue"]') === null &&
    // ...the text input itself carries no value (a plain ARIA combobox keeps its answer here)...
    (input as HTMLInputElement).value === '' &&
    // ...and every hidden input in the widget, the value a named react-select really submits, is blank.
    Array.from(widget.querySelectorAll<HTMLInputElement>('input[type="hidden"]')).every((hidden) => hidden.value === '');
  // An explicit link to a menu that is not rendered (yet) is unresolved, not "empty".
  if (!scope) return { resolved: false, texts: [], shown, empty };
  // Option elements strictly inside the resolved scope.
  const found = Array.from(scope.querySelectorAll('[role="option"]'));
  // Tag them so the caller can click by position without any page-wide option query.
  if (args.mark) found.forEach((option, index) => option.setAttribute('data-applyyy-opt', String(index)));
  // Visible text per option, trimmed like every other label in this worker.
  return { resolved: true, texts: found.map((option) => option.textContent?.trim() ?? ''), shown, empty };
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
  // How long attachFile waits for a Greenhouse upload to finish; FILE_UPLOAD_TIMEOUT_MS by default.
  readonly fileUploadTimeoutMs?: number;
  // How long goto waits for a fillable control; FORM_RENDER_TIMEOUT_MS by default. The
  // never-renders test sets it low so it does not sit through 15 real seconds.
  readonly formRenderTimeoutMs?: number;
  // Asks the ATS's own posting API whether the opened job is still listed (2026-11-09); the production
  // Ashby check by default. Tests inject a verdict, so no test reaches the network.
  readonly listingCheck?: ListingCheck;
}

export function createPlaywrightPage(page: Page, options: PlaywrightPageOptions = {}): ClosableApplicationPage {
  // The posting-API check postingClosed() consults first: the test override, or the production one.
  const listingCheck = options.listingCheck ?? createListingCheck(fetchJson);
  // The deadline submit() uses: the test override, or the production constant.
  const submitOutcomeTimeoutMs = options.submitOutcomeTimeoutMs ?? SUBMIT_OUTCOME_TIMEOUT_MS;
  // The settle window submit() uses: the test override, or the production constant.
  const rejectionSettleMs = options.rejectionSettleMs ?? REJECTION_SETTLE_MS;
  // The bound on a Greenhouse file upload finishing; overridable so tests fail fast.
  const fileUploadTimeoutMs = options.fileUploadTimeoutMs ?? FILE_UPLOAD_TIMEOUT_MS;
  // How long goto waits for a form to render: the test override, or the production constant.
  const formRenderTimeoutMs = options.formRenderTimeoutMs ?? FORM_RENDER_TIMEOUT_MS;
  /** Whether any challenge frame is on screen now. Shared by detectBlocker and submit. */
  async function visibleChallenge(): Promise<boolean> {
    for (const selector of VISIBLE_CHALLENGE_SELECTORS) {
      // `.first().isVisible()` resolves false when nothing matches, and never waits.
      if (await page.locator(selector).first().isVisible()) return true;
    }
    // No challenge frame is showing.
    return false;
  }
  // B2 (P1-6): the HTTP status of the last goto, for postingClosed. null before any goto, or when
  // Playwright returned no response (a same-document navigation).
  let lastStatus: number | null = null;
  // The URL of the last goto, for postingClosed's posting-API question. null before any goto.
  let lastUrl: string | null = null;

  return {
    async goto(url: string) {
      // `domcontentloaded` rather than `networkidle`: ATS boards keep analytics
      // sockets open indefinitely, so waiting for idle would burn the whole
      // per-application budget on pages that are already interactive.
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      // Kept for postingClosed: a 404/410 form page is a closed posting, not a form to fill.
      lastStatus = response?.status() ?? null;
      // The requested URL (not the final one): the posting API is asked about the job the row names.
      lastUrl = url;
      // T1: wait (bounded) for the first fillable control, so a client-rendered form is read
      // after it exists, not before. Attached, not visible: Lever hides its real file input.
      // A timeout is not an error here: the page is handed over as it is, and the caller's
      // own checks (zero fields, postingClosed) decide what an empty page means.
      await page.waitForSelector(FORM_CONTROL_SELECTOR, { state: 'attached', timeout: formRenderTimeoutMs }).catch(() => undefined);
    },

    /* B2 (P1-6, 2026-11-05): is the OPENED posting closed? The evidence string, or null. Since 2026-11-09
       the ATS's own posting API decides where one exists (posting-listing.ts, Ashby); elsewhere two page
       signals: an HTTP error status on the form page, and the closed-posting sentences the ATS boards print. ponytail: no redirect heuristic (forms legitimately redirect job page ->
       /apply on Greenhouse, Lever and Ashby, so "the URL changed" would park live postings); add one
       per board if closed postings slip through as unsupported_form. */
    async postingClosed(): Promise<string | null> {
      // THE ATS FIRST (2026-11-09). Cursor's whole hosted Ashby board answers 404 while Ashby's posting API lists
      // ce965450 as open, so on a host with a posting API the API is the evidence and the page is not.
      const listing = lastUrl === null ? ({ kind: 'no_api' } as const) : await listingCheck(lastUrl);
      // The ATS lists it: open, whatever the page's status or text says.
      if (listing.kind === 'listed') return null;
      // The ATS no longer lists it: closed, quoting the API.
      if (listing.kind === 'absent') return listing.evidence;
      // The API could not be read: no trusted evidence on this host (its page status is the unreliable part), so not closed.
      if (listing.kind === 'unknown') return null;
      // 'no_api': a host without a known posting API keeps the page's own signals below.
      // A 4xx/5xx form page: closed, moved or gone.
      if (lastStatus !== null && lastStatus >= 400) return `the form page answered HTTP ${lastStatus}`;
      // The visible text, bounded: closed notices sit at the top of the page.
      const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 20_000);
      // The first closed-posting sentence the page shows, if any.
      const match = CLOSED_POSTING.exec(text);
      // Quoted back, so the human sees what the page said.
      return match === null ? null : `the page says "${match[0]}"`;
    },

    async extractFields() {
      // Delegated so the accessibility-tree logic has exactly one home; see
      // extract-fields.ts for why identification is not attribute-driven.
      return extractFields(page);
    },

    async readMenuOptions(id: string): Promise<string[] | null> {
      // The widget by its id, as fill() addresses it.
      const target = page.locator(byId(id));
      // HYDRATION FIRST. goto returns once the server-rendered input exists, before React attaches its
      // handlers; a click then does nothing (live Stripe form: Country stayed aria-expanded="false" with 0
      // options). Waiting for `load` fixed it in 3 of 3 live runs (~1.8 s after goto). Instant once loaded,
      // so only the first combobox on a page pays it; bounded, and a timeout just proceeds.
      await page.waitForLoadState('load', { timeout: formRenderTimeoutMs }).catch(() => undefined);
      // Opens the menu; react-select renders its options only while open. Bounded: Playwright's
      // default 30 s actionability wait would stall the kit once per widget that cannot be clicked.
      await target.click({ timeout: MENU_ACTION_TIMEOUT_MS });
      // `load` is only a stand-in for "React attached its handlers"; hydration can land later (the
      // Stripe Country flake, 2026-11-07: one look at aria-expanded="false" returned null and the kit
      // shipped Country with no options). So a still-closed widget is re-clicked until this deadline.
      const reclickUntil = Date.now() + MENU_HYDRATION_RETRY_MS;
      try {
        // Bounded poll of THIS widget's scoped menu (readCombobox never reads page-wide). Re-clicks do
        // not count as polls; the deadline above bounds them instead.
        for (let attempt = 0; attempt < 10; ) {
          // Scoped read, untagged: this method only looks.
          const menu = await page.evaluate(readCombobox, { inputId: id, mark: false });
          // Options rendered: these are the exact texts fill() would compare against.
          if (menu.resolved && menu.texts.length > 0) return menu.texts;
          // A widget that still DECLARES itself closed after the click did not open (react-select sets
          // aria-expanded="true" on open, measured on Greenhouse). Only the explicit "false" counts; a
          // widget without the attribute gets the full poll.
          if ((await target.getAttribute('aria-expanded')) === 'false') {
            // Past the hydration allowance: it really will not open, so "no list", never an empty one.
            if (Date.now() >= reclickUntil) return null;
            // Not hydrated yet: give it a beat, then click again. Only while closed, so a click can
            // never toggle an open menu shut.
            await page.waitForTimeout(MENU_RECLICK_INTERVAL_MS);
            // Same bounded click as the first one.
            await target.click({ timeout: MENU_ACTION_TIMEOUT_MS });
            // Re-read at once; this was not a poll of an open menu.
            continue;
          }
          // An open menu: count the poll.
          attempt += 1;
          // 50 ms x 10 = 0.5 s: react-select renders a static list on the click; a search box never does.
          await page.waitForTimeout(50);
        }
        // Nothing rendered: a type-to-search box, honestly "no list", never an empty list.
        return null;
      } finally {
        // Closed whatever happened, so an open menu cannot capture the next widget's click. A failed
        // close must not replace the read's own result or error.
        await target.press('Escape', { timeout: MENU_ACTION_TIMEOUT_MS }).catch(() => undefined);
      }
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
      // One message for every choice control, so callers can match on the prefix. The CLASS
      // carries the stronger claim: OptionNotFoundError only when the control was provably
      // EMPTY, because a caller that skips the field submits whatever the control already
      // holds (a pre-selected default would be an answer nobody chose). Anything less certain
      // is a plain Error, which parks the row for a human.
      const noMatch = (provablyEmpty: boolean) => {
        // Same text either way, so existing message-matching callers and tests are unaffected.
        const message = `no_matching_option: ${id}: "${value}"`;
        // Only proven emptiness earns the class that may degrade to "left blank".
        return provablyEmpty ? new OptionNotFoundError(message) : new Error(message);
      };
      // Removes the option tags readCombobox leaves behind; used on every exit path.
      const clearOptionTags = () =>
        // Runs in the browser: a single sweep removes every tag left by readCombobox.
        page.evaluate(() =>
          document.querySelectorAll('[data-applyyy-opt]').forEach((el) => el.removeAttribute('data-applyyy-opt')),
        );

      if (live.tag === 'select') {
        // Option texts plus whether the select currently holds a real answer, in one read.
        const { texts, empty } = await target.evaluate((el) => {
          // Typed view for options / selectedOptions / value.
          const select = el as HTMLSelectElement;
          // What the form would submit right now if this field were skipped.
          const current = select.selectedOptions[0];
          // Plain data only: this object crosses back from the browser.
          return {
            // Same text rule as the extractor, so planner and filler see identical options.
            texts: Array.from(select.options).map((option) => option.text.trim()),
            // Empty = nothing selected, an empty value ("Select..."), or a disabled placeholder.
            // A multi-select submits EVERY selected option, so only "none selected" is empty there.
            empty: select.multiple ? select.selectedOptions.length === 0 : !current || select.value === '' || current.disabled,
          };
        });
        // Confirm the exact match BEFORE selectOption, which would otherwise throw a timeout
        // rather than our named error, and never fall back to a partial match.
        if (!texts.includes(wanted)) throw noMatch(empty);
        // Safe now: the label is known to exist, so this selects exactly that option.
        await target.selectOption({ label: wanted });
        // Done; nothing else applies to a native select.
        return;
      }

      if (live.role === 'combobox') {
        // What the widget shows BEFORE we touch it: typing below changes the input, so this is
        // the only moment its emptiness can be read honestly.
        const before = await page.evaluate(readCombobox, { inputId: id, mark: false });
        // readCombobox's positive empty shape (placeholder, no value anywhere), never a bare null read.
        const wasEmpty = before.empty;
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
        // THE PHONE COUNTRY PICKER. Greenhouse labels its dial-code options
        // `${country} +${dialCode}` ("India +91") while the planner knows only the country
        // ("India"), and after a pick the box shows just "+91". So an option also qualifies when
        // it is EXACTLY the wanted text, one space, "+", and 1-4 digits, nothing before or after.
        // startsWith on the whole wanted text plus " +" is anchored at both ends of the name:
        // "Indiana +1" and "British Indian Ocean Territory +246" can never qualify for "India".
        const dialSuffix = (text: string): string | null => {
          // The exact prefix this rule allows: the whole wanted text, a space, a plus.
          const prefix = `${wanted} +`;
          // Anything else is not a dial-code label for this country.
          if (!text.startsWith(prefix)) return null;
          // What follows the "+" must be the dial code alone.
          const digits = text.slice(prefix.length);
          // 1-4 ASCII digits and nothing more ("+91 (mobile)" and "+12345" are refused).
          return /^[0-9]{1,4}$/.test(digits) ? `+${digits}` : null;
        };
        // Every option that qualifies, by exact text or by the dial rule, with its position.
        const candidates = menu.texts
          // Kept with the index so the click below targets the right tagged option.
          .map((text, position) => ({ text, position, dial: text === wanted ? null : dialSuffix(text) }))
          // Exact text, or a dial-code label of exactly this country.
          .filter((option) => option.text === wanted || option.dial !== null);
        // EXACTLY ONE, or nothing: two qualifying options means we cannot know which is meant.
        const picked = candidates.length === 1 ? candidates[0] : undefined;
        // No scope (neither aria link nor an isolated widget) or no single match: fail closed.
        if (!menu.resolved || picked === undefined) {
          // Leave the widget as we found it: close the menu and drop the half-typed text.
          // Closes the menu so it cannot stay open and capture a later click.
          await target.press('Escape');
          // Clears what we typed so the form is not left half-filled.
          await target.fill('');
          // A failed attempt must leave the DOM untouched.
          await clearOptionTags();
          // Nothing was clicked, so the widget still holds what it held before we typed.
          throw noMatch(wasEmpty);
        }
        try {
          // Click by tag: only options inside this widget's scope carry it.
          // Targets only the option tagged inside this widget's scope.
          await page.locator(`[data-applyyy-opt="${picked.position}"]`).click();
        } finally {
          // Markers are scaffolding; never leave them behind, whether or not the click worked.
          await clearOptionTags();
        }
        // READ BACK what the widget now displays: a click can land on the wrong thing or be
        // swallowed, and nothing else would notice. Anything but what we clicked fails.
        const after = await page.evaluate(readCombobox, { inputId: id, mark: false });
        // The clicked option's full text, character for character; or, ONLY for a dial-code
        // pick, exactly its "+NN" (the picker displays the code alone).
        // The "+NN" alone proves a pick ONLY if the box showed something else before: dial codes
        // are shared (+1 US/Canada, +44 UK/Jersey), so a swallowed click on "Canada +1" over a
        // US default would read back "+1" unchanged. Unchanged = unproven = park.
        const readbackOk =
          after.shown === picked.text ||
          (picked.dial !== null && after.shown === picked.dial && before.shown !== picked.dial);
        // ALWAYS a plain Error: a click landed, so the widget may now hold an answer nobody chose.
        if (!readbackOk) throw noMatch(false);
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
                return { found: true, anyChecked: false };
              }
            }
            // No option matched exactly; the caller turns this into no_matching_option, and
            // needs to know whether a skip would submit an already-checked answer.
            // ZERO members is not "none checked": a lone unnamed radio outside any group resolves
            // to no members, and may itself be checked. Unknown is reported as not-empty.
            return { found: false, anyChecked: members.length === 0 || members.some((member) => member.checked) };
          },
          // Serialisable arguments handed to the in-page function above.
          { groupId: id, exact: wanted },
        );
        // Nothing was tagged, nothing was clicked; empty only if no member was already checked.
        if (!found.found) throw noMatch(!found.anyChecked);
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

      // GREENHOUSE UPLOADS ASYNCHRONOUSLY, AND THE FILE IS NOT "ATTACHED" UNTIL IT LANDS.
      // Its job-boards widget sends the chosen file to S3 and only then records it; the
      // application POST carries `resume_url` solely from that finished state. Returning
      // here at once meant the click could send an application WITHOUT the resume: every
      // pre-click screenshot of GitLab ba1e5d1d (2026-10-10 and 2026-10-24) showed the
      // required Resume/CV box as an empty progress bar about a second before the click.
      // Scoped to the widget's own DOM shape: a `.file-upload` group around this input.
      // Any other file input keeps the set-and-return path above, unchanged.
      const group = page.locator('.file-upload').filter({ has: page.locator(byId(id)) });
      // No widget around this input: nothing to wait for.
      if ((await group.count()) === 0) return;
      // The widget's DONE state: the file's own name shown in the filename row.
      const done = group.locator('.file-upload__filename', { hasText: file.name });
      // Its UPLOADING state, which must be gone too.
      const uploading = group.locator('[role="progressbar"].file-upload__progressbar');
      try {
        // Bounded, because the widget's XHR error handler only logs: a failed upload
        // never leaves the progress state, and an unbounded wait would hang the job.
        await done.first().waitFor({ state: 'visible', timeout: fileUploadTimeoutMs });
        // The two states are exclusive in the widget's render; checked, not assumed.
        if ((await uploading.count()) > 0) throw new Error('progress bar still shown beside the file name');
      } catch (error) {
        // The label a human sees ("Resume/CV"), read off the group's aria-labelledby; best effort.
        const labelId = await group.first().getAttribute('aria-labelledby').catch(() => null);
        // An absent or unreadable label falls back to the id alone.
        const label = labelId === null ? null : (await page.locator(byId(labelId)).first().textContent().catch(() => null))?.trim() ?? null;
        // THROWN, NOT PARKED: attachFile runs before `approved -> applying` (apply-one.ts),
        // so a throw here is a no-status-write stop. Nothing was clicked and nothing sent;
        // the row keeps its lease, stays `approved`, and the claim loop counts an error.
        throw new Error(
          `file upload ${label === null ? '' : `"${label}" `}(#${id}) did not finish within ${fileUploadTimeoutMs}ms; ` +
            `submitting now would send the application without it (${error instanceof Error ? error.message : String(error)})`,
        );
      }
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

      // A REQUIRED question still blank, which nothing above flags in a `novalidate` form or when the
      // only required signal is Lever's ✱ (P2-17). Same park as above: the human answers it, nothing is sent.
      const unfilledBefore = await page.evaluate(readUnfilledRequiredLabels);
      // Any blank required question: refuse the click, naming every one.
      if (unfilledBefore.length > 0) {
        // Same shape as the invalid branch, so the park path and the Manual lane need no new case.
        return { kind: 'not_attempted', reason: 'unanswerable_question', detail: `required but empty before submit: ${unfilledBefore.join('; ')}` };
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

      // WHAT CAME BACK for each employer write. Evidence only: no verdict below reads it.
      // A refused POST can still mean a stored application on some board, so the answer
      // stays `unconfirmed`; but without this an unknown said only "45000ms, url=…".
      // Greenhouse answers a reCAPTCHA refusal with a non-2xx JSON `code` (captcha-failed,
      // 2026-10-24 GitLab run 40073654094, confirmed by the security-code email it sent)
      // and leaves the page as it was, so the response is the one place the cause shows.
      // `status`, `method` and `url` are kept structured beside the display text for ONE
      // verdict only: the Greenhouse 428 security-code gate (see securityCodeGate below).
      const employerResponses: { text: string; code: string | null; status: number; method: string; url: string }[] = [];
      // Same filter as the request log: non-GET, not the captcha provider's own traffic.
      const onResponse = (response: { status(): number; text(): Promise<string>; request(): { method(): string; url(): string } }) => {
        // The request this response answers.
        const request = response.request();
        // A GET page load or a captcha round trip is not the application coming back.
        if (request.method() === 'GET' || isCaptchaTraffic(request.url())) return;
        // Recorded synchronously, so the status is in the log however soon the loop ends.
        const entry: { text: string; code: string | null; status: number; method: string; url: string } = {
          // The display form every unconfirmed detail already carries.
          text: `${response.status()} ${request.url()}`,
          // Filled in later from the body, best effort (below).
          code: null,
          // The exact status, so only a literal 428 can become the named outcome.
          status: response.status(),
          // The method, so only a POST (the form being sent) can carry that outcome.
          method: request.method(),
          // The endpoint, so only Greenhouse's own host can carry it (isGreenhouseUrl).
          url: request.url(),
        };
        employerResponses.push(entry);
        // A refusal's body names its cause. Best effort: a body still in flight at the
        // deadline is simply absent, and a read failure must not reject unhandled.
        if (response.status() >= 400) response.text().then((body) => { entry.code = readErrorCode(body); }, () => {});
      };
      // Attached with the request listener, and detached beside it in `finally`.
      context.on('response', onResponse);
      // Every unconfirmed detail ends with the responses, so each unknown names its own cause.
      const withResponses = (detail: string): string =>
        employerResponses.length === 0
          ? detail
          : `${detail}; responses: ${employerResponses.map((r) => (r.code === null ? r.text : `${r.text} code=${r.code}`)).join(', ')}`;

      /**
       * THE GREENHOUSE SECURITY-CODE GATE, read from the responses (Axiad, 2026-10-24).
       *
       * 'gate' only when ALL hold, so the named "not sent" outcome is proof, not a guess:
       *  - a POST to a Greenhouse host answered EXACTLY 428 (the board refused the send
       *    pending email verification);
       *  - every non-GET employer write has been answered (none still in flight that
       *    could be a second, accepted send);
       *  - no employer write was answered below 400 (nothing else was accepted).
       * 'none' when no such 428 arrived; 'open' when one did but the other two do not hold
       * yet. Both of those fall through to the ordinary reading, which is `unconfirmed`
       * after any send: the fail-closed direction.
       */
      // Whether a non-GET employer write has gone out with no response recorded yet. The
      // response log records only non-GET writes, so the two counts compare like for like.
      const awaitingResponse = (): boolean => employerResponses.length < employerWrites.filter((w) => !w.startsWith('GET ')).length;

      const securityCodeGate = (): 'none' | 'open' | 'gate' => {
        // The refusal itself: exact status, POST, Greenhouse's own host.
        const refused = employerResponses.some((r) => r.status === GREENHOUSE_SECURITY_CODE_STATUS && r.method === 'POST' && isGreenhouseUrl(r.url));
        // No 428 from Greenhouse: this reading has nothing to say.
        if (!refused) return 'none';
        // A write still in flight could be an accepted send: not proved yet.
        if (awaitingResponse()) return 'open';
        // Any accepted (or redirected) write might have stored an application somewhere.
        if (employerResponses.some((r) => r.status < 400)) return 'open';
        // Refused by the gate, and nothing else went out unanswered or accepted.
        return 'gate';
      };

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
          // The thank-you text is read only on the confirmation route, saving a DOM read per poll.
          const thanks = pathOk
            ? await page.evaluate(readConfirmationText, {
              // Plain {source, flags} pairs: a RegExp does not survive serialisation into the page.
              heading: { source: CONFIRMATION_HEADING.source, flags: CONFIRMATION_HEADING.flags },
              // Same for the title template.
              title: { source: CONFIRMATION_TITLE.source, flags: CONFIRMATION_TITLE.flags },
            })
            : null;
          // The route, the thank-you text, AND evidence that something left the page.
          // The last is NOT optional: a plain GET of /confirmation renders the same
          // thank-you page (measured live), so route + text alone prove nothing about
          // our click. Only a request after the click ties the page to an application.
          if (pathOk && thanks !== null && employerWrites.length > 0) {
            // Evidence quotes exactly what matched (heading= or title=), for the `applied` event.
            return { kind: 'confirmed', evidence: `url=${url} ${thanks}` };
          }

          // 1b. SECURITY CODE REQUIRED: Greenhouse refused the POST with 428 and emailed a
          // code. Read BEFORE the challenge and invalid-field looks, because the page may
          // now show (and flag) a security-code input, which would otherwise read as
          // "fields flagged after a send" and land as an unknown outcome.
          if (securityCodeGate() === 'gate') {
            // MADE TRUE BY CONSTRUCTION, as the settle window does: every further request
            // from this page and its context is aborted (the page is closed after the
            // status write and never used again), so no late send can follow this answer.
            await page.route('**/*', (route) => route.abort());
            // Popups and other pages of the same context.
            await context.route('**/*', (route) => route.abort());
            // Re-read after sealing: a write that slipped out meanwhile demotes it.
            if (securityCodeGate() !== 'gate') {
              // Something changed while sealing: unknown, never "not sent".
              return { kind: 'unconfirmed', detail: withResponses(`HTTP 428 seen, then ${employerWrites.join(', ')}`) };
            }
            // Proved: refused by the gate, nothing else accepted, nothing else can leave.
            return { kind: 'security_code_required', detail: withResponses(`Greenhouse answered HTTP ${GREENHOUSE_SECURITY_CODE_STATUS} after ${employerWrites.join(', ')}`) };
          }

          // 2. CHALLENGED: invisible reCAPTCHA escalated to a question for a human.
          if (await visibleChallenge()) {
            // A send whose response is still on its way: look again, because that response
            // may be Greenhouse's 428 (branch 1b), which decides "not sent". The page can show
            // its reaction before the response event reaches this process (measured in
            // submit-outcome-428.test.ts). A response that never comes ends at the deadline
            // as `unconfirmed`, the same answer as below, only later.
            if (employerWrites.length > 0 && awaitingResponse()) return `challenge shown, awaiting the response to ${employerWrites.join(', ')}`;
            // The 428 can land DURING the await above, after branch 1b already read 'none' on this
            // look: hand it back to the next look, where 1b decides, instead of answering unknown.
            if (securityCodeGate() === 'gate') return `challenge shown, then HTTP ${GREENHOUSE_SECURITY_CODE_STATUS} arrived; re-reading`;
            // Something reached the employer: the send may have happened.
            if (employerWrites.length > 0) {
              return { kind: 'unconfirmed', detail: withResponses(`challenge shown after ${employerWrites.join(', ')}`) };
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
            // may have been stored. Unknown, never "blocked". Held while a response is still
            // on its way, for the same reason as the challenge branch: it may be the 428.
            if (invalid.length > 0 && employerWrites.length > 0 && awaitingResponse()) return `fields flagged (${invalid.join('; ')}), awaiting the response to ${employerWrites.join(', ')}`;
            // Same race as the challenge branch: the 428 arrived while readInvalidFieldLabels ran
            // (measured: the "428 then a flagged field" test, 3/3 runs). The next look's 1b decides.
            if (invalid.length > 0 && employerWrites.length > 0 && securityCodeGate() === 'gate') return `fields flagged (${invalid.join('; ')}), then HTTP ${GREENHOUSE_SECURITY_CODE_STATUS} arrived; re-reading`;
            // Every response is in and none was the gate: unknown.
            if (invalid.length > 0 && employerWrites.length > 0) {
              return { kind: 'unconfirmed', detail: withResponses(`fields flagged (${invalid.join('; ')}) after ${employerWrites.join(', ')}`) };
            }
            // Flagged with nothing sent YET. Pending, not final: see the settle window.
            if (invalid.length > 0) return { pending: { kind: 'rejected_by_form', labels: invalid } };
          }

          // Nothing recognised yet; described, in case nothing ever is.
          // On the route, the detail says which half is missing: the text, or the request.
          const onRoute = thanks === null ? ' (confirmation path, no thank-you heading or title)' : ` (confirmation path, ${thanks}, but no request left the page after the click)`;
          // Off the route, the URL alone describes it.
          return `url=${url}${pathOk ? onRoute : ''}`;
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
                return { kind: 'unconfirmed', detail: withResponses(`${step.pending.kind} held ${rejectionSettleMs}ms, then ${employerWrites.join(', ')}`) };
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
          detail: withResponses(`no confirmation within ${submitOutcomeTimeoutMs}ms; last seen ${lastSeen}; requests that could carry it: ${employerWrites.join(', ') || 'none'}`),
        };
      } finally {
        // Detached on every exit, so a later page action is never recorded against this submit.
        context.off('request', onRequest);
        // The response log likewise ends with this submit.
        context.off('response', onResponse);
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
