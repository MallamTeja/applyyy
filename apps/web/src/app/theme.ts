/* Theme preference: reading it, validating it, storing it, applying it.
 *
 * WHY THIS IS A SEPARATE MODULE FROM THE CONTROL THAT RENDERS IT. Every
 * function here takes the browser objects it touches as arguments rather than
 * reaching for the globals, so the whole module is exercisable under
 * `node --test` with a couple of fakes and no DOM. That is the same
 * dependency-seam shape the rest of this repo uses to keep logic testable
 * while the thing behind it is unavailable or awkward.
 *
 * WHAT THE THREE STATES MEAN, because two of them look alike from the outside.
 * `system` is not "light" - it is "keep following the operating system", and
 * it stays correct when the operator's machine switches at sunset. A toggle
 * that only offers light and dark quietly takes that away and can never give
 * it back, which is why the default here is a real third state rather than a
 * lit/unlit switch.
 *
 * HOW IT REACHES THE PIXELS. Nothing in this file knows a single colour.
 * Applying a preference sets one attribute on <html>, and tokens.css turns
 * that into a `color-scheme`, which re-points every light-dark() colour at
 * the other half of its own declaration. So the palette has exactly one
 * definition site and this module cannot disagree with it.
 */

/* The three states, as a union rather than a boolean, for the reason above. */
export type ThemePreference = 'system' | 'light' | 'dark';

/* The localStorage key.
 * NOTE: this string is duplicated in the inline bootstrap script in
 * index.html, which has to run before React to avoid a flash of the wrong
 * theme and therefore cannot import from here. If it changes, change both -
 * the symptom of missing one is a one-frame flash, which is easy to dismiss
 * as imagination and hard to reproduce on purpose. */
export const THEME_STORAGE_KEY = 'applyy.theme';

/* The attribute tokens.css keys its overrides off. Also duplicated in the
 * bootstrap script, same reason, same warning. */
export const THEME_ATTRIBUTE = 'data-theme';

/* The default when nothing has been chosen, or when what was stored is not
 * something we recognise. Named rather than inlined so the two call sites
 * below cannot drift on what "no preference" means. */
export const DEFAULT_THEME: ThemePreference = 'system';

/* A type guard rather than a cast.
 * WHY IT EXISTS: localStorage is a string bucket shared with anything else on
 * the origin and survives deploys, so it will eventually hand back a value
 * from a version of this app that had different states in it. Trusting that
 * string would stamp `data-theme="sepia"` on the root, which matches no rule
 * in tokens.css and silently renders the light theme with no way for the
 * operator to work out why their choice stopped sticking. */
export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/* Read the stored preference, falling back to the default on anything odd.
 *
 * The try/catch is not defensive padding: reading localStorage THROWS rather
 * than returning null when the browser blocks site data (Safari private mode,
 * a locked-down profile, some embedded webviews). An uncaught throw here
 * happens during the first render and takes the whole console down over a
 * cosmetic preference. */
export function readStoredTheme(storage: Pick<Storage, 'getItem'>): ThemePreference {
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY);
    /* Validate before returning: see isThemePreference above. */
    return isThemePreference(stored) ? stored : DEFAULT_THEME;
  } catch {
    /* Storage unavailable. The operator gets the OS default and a toggle that
       works for this session but will not be remembered - degraded, not
       broken, and silent because there is nothing they could do about it. */
    return DEFAULT_THEME;
  }
}

/* Persist a preference. Same throwing-storage caveat as reading.
 *
 * `system` is REMOVED rather than written as the literal string "system".
 * The difference matters: a stored "system" and an absent key both mean
 * "follow the OS" today, but only the absent key stays honest if this app
 * ever changes what its default is. Storing a value that merely happens to
 * equal the current default records a decision the operator did not make. */
export function storeTheme(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  preference: ThemePreference,
): void {
  try {
    if (preference === DEFAULT_THEME) {
      storage.removeItem(THEME_STORAGE_KEY);
    } else {
      storage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    /* Nothing to do and nothing to tell them. The theme still applies to the
       running page; it just will not survive a reload. */
  }
}

/* Apply a preference to the document root.
 *
 * `system` REMOVES the attribute rather than setting it to anything. This is
 * the whole reason the OS setting keeps working: with no attribute, the only
 * thing deciding the theme is `color-scheme: light dark` on :root, which the
 * browser resolves live from prefers-color-scheme. Stamping an explicit value
 * for the OS's current state would freeze it at whatever it was when the page
 * loaded, and the console would stop following the machine at sunset. */
export function applyTheme(root: Element, preference: ThemePreference): void {
  if (preference === DEFAULT_THEME) {
    root.removeAttribute(THEME_ATTRIBUTE);
  } else {
    root.setAttribute(THEME_ATTRIBUTE, preference);
  }
}

/* The label the operator reads for each state, and the one-line explanation
 * under the control.
 *
 * Held here beside the union so adding a fourth state is a compile error at
 * this table rather than a control that silently renders three buttons for
 * four states. The copy says what the choice DOES, in the interface's own
 * voice - "Match your system" rather than "Auto". */
export const THEME_OPTIONS: readonly {
  readonly value: ThemePreference;
  readonly label: string;
}[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
