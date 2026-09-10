/* The theme control, in the nav rail.
 *
 * WHY THIS EXISTS AT ALL. The palette is designed dark-first, but the console
 * follows the operating system by default - so an operator on a light-mode
 * machine would never see the dark theme and would have no way to ask for it.
 * That is a real gap rather than a preference nicety: the palette's loudest
 * signal, the fabrication band, is tuned against a near-black ground.
 *
 * WHY IT IS A RADIO GROUP AND NOT A SWITCH. There are three states, and one of
 * them - `system` - is the one worth protecting. A two-position switch cannot
 * express "keep following my machine", so the moment an operator touches it
 * they lose that behaviour permanently with no way back. Three radios say
 * plainly that following the system is a choice you can return to.
 *
 * WHY NATIVE RADIOS RATHER THAN BUTTONS WITH aria-pressed. A radio group gets
 * roving arrow-key navigation, the group label, and the one-of-many semantic
 * from the browser for free, and all three are things a hand-rolled button
 * group gets wrong. The segmented look is CSS over real inputs.
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import {
  THEME_OPTIONS,
  applyTheme,
  readStoredTheme,
  storeTheme,
} from './theme';
import type { ThemePreference } from './theme';

export function ThemeToggle(): ReactElement {
  /* Initialised from storage with a lazy initialiser - the function form, so
     localStorage is read once on mount rather than on every render. The
     bootstrap script in index.html has already applied this same value to the
     root before first paint, so this is picking up a decision, not making
     one, and the two cannot disagree because they read the same key. */
  const [preference, setPreference] = useState<ThemePreference>(() =>
    readStoredTheme(window.localStorage),
  );

  /* Apply and persist together, in an effect rather than in the change
     handler.
     WHY AN EFFECT: it also runs on mount, which is what reconciles React's
     state with whatever the bootstrap script stamped. If the two ever drift -
     a stored value the script accepted and this module later rejects, say -
     the effect corrects the DOM instead of leaving the control showing one
     thing and the page rendering another. */
  useEffect(() => {
    applyTheme(document.documentElement, preference);
    storeTheme(window.localStorage, preference);
  }, [preference]);

  return (
    /* A fieldset because this is a group of related controls with one label,
       which is exactly what a fieldset and legend are for - and it gives
       screen readers the group name before each option. */
    <fieldset className="theme">
      {/* Sentence case, and it names the thing being chosen rather than
          instructing. No tracked-out capitals eyebrow. */}
      <legend className="theme__legend">Appearance</legend>

      <div className="theme__options">
        {THEME_OPTIONS.map((option) => (
          /* The label wraps its input, so the whole segment is the hit target
             without needing a matching id/htmlFor pair to be kept in sync. */
          <label
            key={option.value}
            className={
              option.value === preference
                ? 'theme__option theme__option--selected'
                : 'theme__option'
            }
          >
            <input
              type="radio"
              /* One shared name is what makes these one group to the browser
                 and to assistive tech, and what enables arrow-key roving. */
              name="theme"
              value={option.value}
              checked={option.value === preference}
              onChange={() => setPreference(option.value)}
              /* Visually hidden rather than removed: the segment's appearance
                 comes from the label, but the input must stay in the
                 accessibility tree and stay focusable, and it is what draws
                 the focus ring. */
              className="theme__input"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
