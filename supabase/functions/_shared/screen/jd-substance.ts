/* Is this job description THIN (round 4, 2026-11-21; peer 5's Fractal finding)? The ONE place the rule lives:
 * screen-batch.ts (the scouts' and the screener's verdict) and the web's hasNoDescription (the "No description"
 * pill on a Ready to tailor card) both call isThinDescription, so the screener and the card can never disagree.
 *
 * WHY: "has any non-whitespace text" let Fractal 002b1d10 through, a 513-char Workday tenant wrapper with no role
 * text at all, and it reached awaiting_approval. A JD that is mostly boilerplate is missing data, and missing data
 * must not become an answer (CLAUDE.md section 6). Thin is treated exactly like blank: no new status, no new pill.
 *
 * HOW: split into lines, drop blank lines and lines matching a closed boilerplate list, sum what is left (trimmed).
 * Under MIN_ROLE_TEXT_CHARS is thin. Measured on every live JD under 1500 chars (read-only SELECT, 2026-11-21):
 * after stripping, the thin rows had 0 (Fractal) and 24 (Point72, the title repeated) chars; the shortest REAL JDs
 * had 128 (Zeta, one genuine duty line) and 160 (Fractal 30b68d86, the same wrapper around three duty lines). 100
 * sits in that gap, so a real short JD is never held; at the 200 first guessed, Zeta would have been.
 *
 * NOT covered, on purpose: feed snippets cut at ~375 chars ending "…" (490 rows, ats_provider 'other') carry real
 * role text above the threshold. Whether truncation counts as missing is a separate decision for Teja. */

// The least role text, in characters after stripping, that counts as a description.
export const MIN_ROLE_TEXT_CHARS = 100;

/* Lines that are never about the role. A CLOSED list: each entry is named and has its own test, so a new pattern is a
 * reviewed edit, not a regex that quietly grows. Substring matches (case-insensitive), the same set the live
 * measurement used; "eeo" alone needs word boundaries, since it is three letters that occur inside other words. */
export const BOILERPLATE_LINE_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = Object.freeze([
  // "Equal (Employment) Opportunity employer".
  { name: "equal_opportunity", pattern: /equal (employment )?opportunit/i },
  // The acronym, as a whole word only.
  { name: "eeo", pattern: /\beeo\b/i },
  // US federal-contractor wording.
  { name: "affirmative_action", pattern: /affirmative action/i },
  // A careers site's cookie banner scraped into the body.
  { name: "cookie", pattern: /cookie/i },
  // A call to action, not a duty.
  { name: "apply_now", pattern: /apply now/i },
  // Workday's talent-community footer, first line.
  { name: "not_the_right_fit", pattern: /not the right fit/i },
  // Workday's talent-community footer, its button.
  { name: "introduce_yourself", pattern: /introduce yourself/i },
  // Job-alert sign-up footers.
  { name: "email_alerts", pattern: /email alerts/i },
  // Fractal's Workday tenant wrapper, opening line.
  { name: "workday_fun_to_work", pattern: /fun to work in a company/i },
  // Fractal's wrapper, second line.
  { name: "workday_passion_customer_focus", pattern: /passion and customer focus/i },
  // Fractal's wrapper, closing line (first half).
  { name: "workday_wild_growth", pattern: /wild growth/i },
  // Fractal's wrapper, closing line (second half), also seen alone.
  { name: "workday_over_achievers", pattern: /over-achievers/i },
]);

// The characters of role text left once blank and boilerplate lines are gone. 0 for anything that is not a string.
export function roleTextLength(description: unknown): number {
  // Only a string can carry text; null, absent or a wrong type is none (shape check, never truthiness).
  if (typeof description !== "string") return 0;
  // CRLF and LF alike, so a Windows-authored JD measures the same.
  return description
    .split(/\r?\n/)
    // Each line without its edge whitespace, so indentation is not counted as text.
    .map((line) => line.trim())
    // Blank lines and boilerplate lines carry no role text.
    .filter((line) => line !== "" && !BOILERPLATE_LINE_PATTERNS.some((entry) => entry.pattern.test(line)))
    // What is left, summed.
    .reduce((sum, line) => sum + line.length, 0);
}

// Thin = blank, missing, or under the threshold once boilerplate is gone. Treated exactly like "no description".
export function isThinDescription(description: unknown): boolean {
  // One comparison, so the threshold has one meaning everywhere.
  return roleTextLength(description) < MIN_ROLE_TEXT_CHARS;
}
