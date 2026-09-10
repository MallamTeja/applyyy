/* Tests for the theme preference module.
 *
 * WHAT THESE PROTECT. Three behaviours that all look like harmless details
 * and are each the difference between a working toggle and a confusing one:
 *
 *   1. `system` is stored as ABSENCE, not as the string "system". Writing the
 *      current default down records a decision the operator never made, and
 *      it stops being true the day the default changes.
 *   2. `system` REMOVES the root attribute. That is the entire mechanism by
 *      which the console keeps following the OS - an explicit attribute would
 *      freeze the theme at whatever the machine happened to be at page load.
 *   3. A stored value that is not one of the three states is discarded. That
 *      string outlives deploys, so a value from an older build WILL turn up,
 *      and honouring it would stamp an attribute matching no rule in
 *      tokens.css - which renders as light with no clue why.
 *
 * WHY NO DOM AND NO BROWSER. Every function under test takes the object it
 * touches as an argument, so a plain object stands in for Storage and a
 * six-line fake stands in for the root element. That seam is the reason this
 * logic is testable at all under `node --test`.
 *
 * RUN: `pnpm --filter @applyy/web test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_THEME,
  THEME_OPTIONS,
  THEME_STORAGE_KEY,
  applyTheme,
  isThemePreference,
  readStoredTheme,
  storeTheme,
} from '../src/app/theme.ts';

/* --- Fakes ------------------------------------------------------------ */

/* A Storage stand-in over a plain Map. Deliberately NOT a full Storage - the
   functions under test declare exactly the two or three methods they use, so
   the fake only has to satisfy that narrow slice. */
function fakeStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (k: string): string | null => map.get(k) ?? null,
    setItem: (k: string, v: string): void => void map.set(k, v),
    removeItem: (k: string): void => void map.delete(k),
    /* Exposed so a test can assert on what is actually held, rather than
       inferring storage state from a later read. */
    _map: map,
  };
}

/* A Storage stand-in that throws on every access, which is what a browser
   with site data blocked actually does - it does not return null. */
const throwingStorage = {
  getItem(): string {
    throw new DOMException('The operation is insecure.');
  },
  setItem(): void {
    throw new DOMException('The operation is insecure.');
  },
  removeItem(): void {
    throw new DOMException('The operation is insecure.');
  },
};

/* The two Element methods applyTheme uses, over a Map. */
function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    setAttribute: (k: string, v: string): void => void attrs.set(k, v),
    removeAttribute: (k: string): void => void attrs.delete(k),
    getAttribute: (k: string): string | null => attrs.get(k) ?? null,
    _attrs: attrs,
  } as unknown as Element & { _attrs: Map<string, string> };
}

/* --- The guard -------------------------------------------------------- */

test('isThemePreference accepts exactly the three states', () => {
  assert.equal(isThemePreference('system'), true);
  assert.equal(isThemePreference('light'), true);
  assert.equal(isThemePreference('dark'), true);
});

test('isThemePreference rejects anything else, including near-misses', () => {
  /* null and '' are what an empty key reads back as. 'Dark' and 'auto' are
     the shapes a hand-edited or older-build value actually takes. */
  for (const bad of [null, undefined, '', 'Dark', 'DARK', 'auto', 'sepia', 0, {}]) {
    assert.equal(isThemePreference(bad), false, `should reject ${String(bad)}`);
  }
});

/* --- Reading ---------------------------------------------------------- */

test('reads a valid stored preference', () => {
  const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'dark' });
  assert.equal(readStoredTheme(storage), 'dark');
});

test('falls back to the default when nothing is stored', () => {
  assert.equal(readStoredTheme(fakeStorage()), DEFAULT_THEME);
});

test('discards a stored value that is not a known state', () => {
  /* The regression this guards: honouring it would stamp data-theme="sepia",
     which matches no rule in tokens.css, so the console silently renders
     light and the operator's choice appears not to stick. */
  const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'sepia' });
  assert.equal(readStoredTheme(storage), DEFAULT_THEME);
});

test('survives storage that throws instead of returning null', () => {
  /* Blocked site data throws on read. Uncaught, this happens during the first
     render and takes the whole console down over a cosmetic preference. */
  assert.equal(readStoredTheme(throwingStorage), DEFAULT_THEME);
});

/* --- Writing ---------------------------------------------------------- */

test('stores an explicit choice', () => {
  const storage = fakeStorage();
  storeTheme(storage, 'dark');
  assert.equal(storage._map.get(THEME_STORAGE_KEY), 'dark');
});

test('stores the default as absence rather than as the literal "system"', () => {
  /* Starts with a value so the test proves removal, not merely non-writing. */
  const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'dark' });
  storeTheme(storage, 'system');
  assert.equal(storage._map.has(THEME_STORAGE_KEY), false);
});

test('storing survives storage that throws', () => {
  assert.doesNotThrow(() => storeTheme(throwingStorage, 'dark'));
});

/* --- Applying --------------------------------------------------------- */

test('an explicit choice stamps the attribute', () => {
  const root = fakeRoot();
  applyTheme(root, 'dark');
  assert.equal(root.getAttribute('data-theme'), 'dark');
});

test('choosing system REMOVES the attribute rather than setting it', () => {
  /* This is the behaviour that keeps the console following the OS. If this
     ever sets an attribute instead, the theme freezes at whatever the machine
     was when the page loaded and stops changing at sunset. */
  const root = fakeRoot();
  applyTheme(root, 'dark');
  applyTheme(root, 'system');
  assert.equal(root.getAttribute('data-theme'), null);
  assert.equal(root._attrs.size, 0);
});

test('switching between the two explicit themes replaces, never accumulates', () => {
  const root = fakeRoot();
  applyTheme(root, 'dark');
  applyTheme(root, 'light');
  assert.equal(root.getAttribute('data-theme'), 'light');
  /* One attribute, not two - a stale data-theme alongside a new one would let
     CSS specificity decide the theme. */
  assert.equal(root._attrs.size, 1);
});

/* --- The options table ------------------------------------------------ */

test('every offered option is a real state, and the default is offered', () => {
  /* The control renders from THEME_OPTIONS. If a state is added to the union
     without being added here, the operator gets a control that cannot reach
     it - and the reverse would render a segment that stamps a bad value. */
  for (const option of THEME_OPTIONS) {
    assert.equal(isThemePreference(option.value), true, option.value);
    assert.ok(option.label.length > 0, 'every option needs a visible label');
  }
  assert.equal(THEME_OPTIONS.some((o) => o.value === DEFAULT_THEME), true);
  /* No duplicates: two segments for one state would render as two radios that
     both look selected. */
  assert.equal(new Set(THEME_OPTIONS.map((o) => o.value)).size, THEME_OPTIONS.length);
});
