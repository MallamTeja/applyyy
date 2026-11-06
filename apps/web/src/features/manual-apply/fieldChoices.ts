/* What a select/radio field shows under its answer (Teja, 2026-11-07, Enterpret card 30889f9e).
 *
 * The card printed EVERY option under the answer: "Choices: United States +1 | Afghanistan +93 | ...
 * Zimbabwe +263" (about 240 entries) under "India". A choice list only helps when the answer is
 * missing, or when it matches nothing and the operator must pick by hand. So a matched answer shows
 * just the option to pick, and everything else collapses behind a count. Pure, so the rule is tested
 * without rendering. */

/* The three things a field can show. A CLOSED union so the renderer handles each by name. */
export type ChoiceView =
  // No options were read: nothing to show.
  | { readonly kind: 'none' }
  // The answer names these options (usually exactly one): show only them.
  | { readonly kind: 'matched'; readonly picks: readonly string[] }
  // Unanswered, or the answer matches no option: every option, to be shown collapsed.
  | { readonly kind: 'all'; readonly options: readonly string[] };

// One comparable form: lower case, whitespace runs collapsed, ends trimmed. Case and spacing carry no
// meaning in an option label, and the form's own spelling is what gets displayed, not this one.
const normal = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

/* Which options does `value` pick? An option matches when it equals the answer, or when it STARTS with
 * the answer followed by a space ("India" picks "India +91"). A bare substring would be wrong: "Niger"
 * would pick "Nigeria +234", and a wrong pick shown as "the" choice is worse than a long list. */
export function choiceView(value: string | null, options: readonly string[] | null): ChoiceView {
  // Nothing was read from the form: nothing to choose from.
  if (options === null || options.length === 0) return { kind: 'none' };
  // No answer: the operator needs the whole list.
  if (value === null || normal(value) === '') return { kind: 'all', options };
  // The answer in comparable form, once.
  const wanted = normal(value);
  // Options equal to the answer, or the answer followed by a space (the "name +code" shape).
  const picks = options.filter((option) => {
    // The option in the same comparable form.
    const have = normal(option);
    // Exact, or the answer as a whole leading word group.
    return have === wanted || have.startsWith(`${wanted} `);
  });
  // A match shows only the matches; no match falls back to the whole list rather than guessing.
  return picks.length > 0 ? { kind: 'matched', picks } : { kind: 'all', options };
}
