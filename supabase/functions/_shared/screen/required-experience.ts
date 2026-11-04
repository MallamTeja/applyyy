// The years-of-experience a job description demands, read from its text (Teja, 2026-11-04).
//
// WHY THIS EXISTS. The cascade has had an experience rule since 2026-09-10
// (filter/cascade.ts experienceCeiling: drop when jobs.min_experience_years > config.max_years),
// and it never fired once: NOTHING writes jobs.min_experience_years, and the live
// filter_rules config was {}. On 2026-11-04 Axiad "AI-First Golang Developer", whose JD says
// "6-8 years of hands-on software development experience", went through Ready to tailor, the
// approval queue and manual apply before Teja caught it. This module is the missing producer.
// It feeds the existing rule rather than adding a second one: the screener passes its answer
// into toScreenableJob, and the matcher's pre-gate re-checks re-run rows with the twin below.
//
// TEJA'S RULING (2026-11-01, confirmed 2026-11-04): drop a HARD minimum above 1 year. Years
// that are preferred / nice to have / a bonus are wishes, not gates. Intern and junior roles,
// junior security included, are kept whatever their JD says. The threshold itself lives in
// filter_rules.config.max_years (migration 20261104193000 sets 1), never in this file.
//
// FAIL-OPEN ON DOUBT (CLAUDE.md section 6). Only a positive, hard, plausible requirement
// counts. A sentence the parser cannot place returns nothing, and nothing never drops. The
// traps below are all live wording that a naive "N years" regex turned into a requirement.

// The HTML stripper the ATS adapters already use; it keeps line breaks, which the section
// logic below depends on, and decodes the entities Greenhouse escapes with.
import { stripHtml } from "../ats/types.ts";

// The one drop_reason this check writes. It is the cascade rule's own name on purpose: the
// screener's drop (via the cascade) and the matcher's re-check (via the twin) are the same
// rule, so the dashboard groups them together.
export type ExperienceDropCode = "experience_ceiling";

// The verdict, in the same three-outcome shape as the other stage gates.
export type ExperienceVerdict =
  // No objection.
  | { readonly drop: false }
  // No objection, but the ceiling is unset or the stored value unreadable, which must be visible.
  | { readonly drop: false; readonly warning: string }
  // Rejected: `code` lands in applications.drop_reason, `reason` is prose for the run log.
  | { readonly drop: true; readonly code: ExperienceDropCode; readonly reason: string };

// What the matcher's twin reads about one job. Narrow on purpose.
export interface ExperienceJob {
  // Read for the entry-level exemption and for a "(3-5)" range.
  readonly title: string;
  // The JD body, raw from the board (HTML or text).
  readonly description: string | null;
  // The stored column. PostgREST sends numerics as strings, so both shapes are accepted.
  readonly minExperienceYears: number | string | null;
}

// Numbers written as words. "two or more years" slipped past the 2026-11-01 cleanup regex.
const WORD_NUMBERS: Readonly<Record<string, number>> = {
  // One through ten covers every live sample; larger word numbers did not appear.
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

// A number: digits (with an optional decimal, so "1.5+ years" reads as 1.5) or a word.
const NUM = String.raw`(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)`;

// "N years", "N+ years", "N-M years", "N to M years", "N or more years", "N+ YOE".
// The number must sit directly before the unit: "USD 1,000 per year" and "2 to 4 weeks per
// year" never match, because "per" or "weeks" stands in between. Group 1 is the lower bound.
const YEARS = new RegExp(
  // Lower bound, optional plus, optional range, optional trailing plus, optional "or more", unit.
  String.raw`\b${NUM}\s*(?:\+|plus\b)?\s*(?:(?:-|–|—|to)\s*${NUM}\s*)?(?:\+\s*)?(?:or more\s+)?(?:years?|yrs?|yoe)\b`,
  // Global for matchAll, case-insensitive because JDs capitalise freely.
  "gi",
);

// A range in the TITLE, "(3-5)", "(3+ years)", "(3-5 years)". It needs a plus or a range
// mark after the number, so "(2027)" is never read as 2027 years.
const TITLE_RANGE = /\(\s*(\d+)\s*(?:\+|-|–|—|to)\s*\d*\s*\+?\s*(?:years?|yrs?)?\s*\)/i;

// The years must be ABOUT the candidate's work, judged on the words right around the number,
// never the whole sentence. "doubling its ARR over the past three years", "competitors for eight
// years", "Paid month off after 5 years" carry a number and a unit and no such word; and "We have
// been building developer tools for 12 years" or "Sabbatical after 5 years of work" (code review,
// 2026-11-04) carry a work word in the WRONG place. So: a work word AFTER the years ("5+ years of
// backend experience", "8+ years building") or a requirement word just BEFORE them ("Experience: 2-4
// years", "at least 3 years"). Bare "work" is deliberately absent from the after-list.
const CONTEXT_AFTER = /experien|\byoe\b|professional|industry|hands[- ]on|\bbuilding\b|\bdeveloping\b|\bdevelopment\b|\bengineering\b|\bworking (?:with|on|in|as)\b|\bcoding\b|\bprogramming\b|\bshipping\b|\bdesigning\b|\bin (?:a |an )?(?:software|backend|frontend|data|devops|security|ml|machine learning|cloud|platform|infrastructure|engineering|development)\b/i;
// The requirement words that may sit before the number instead.
const CONTEXT_BEFORE = /experien|\byoe\b|qualif|requirement|minimum|at least|must have|you have|you bring/i;
// How far after and before the number those words may sit, in characters.
const CONTEXT_AFTER_CHARS = 60;
const CONTEXT_BEFORE_CHARS = 50;

// "4 year degree", "4-year bachelor's": the years belong to a degree, not to work experience
// (code review, 2026-11-04). At most one word may sit between the unit and the degree word, so
// "3+ years OR Master's degree" (two words) is still read as a requirement.
const DEGREE_AFTER = /^\W*(?:[\w'’-]+\W+)?(?:degree|bachelor'?s?|programme?|course|college|university|diploma)\b/i;

// Numbers at or above this are company history ("more than 30 years of investing experience",
// "For 25+ years, we've delivered"), never a hiring bar. Measured on 2026-11-01.
const MAX_PLAUSIBLE_YEARS = 20;

// An upper bound right before the number is fresher-FRIENDLY ("less than one year of
// professional experience"), the opposite of a minimum.
const UPPER_BOUND_BEFORE = /\b(?:less than|fewer than|under|up to|no more than|maximum of|max\.?|at most)\s*$/i;

// Soft words just BEFORE the years soften them: "ideally with 3+ years".
const SOFT_BEFORE = /\b(?:ideally|preferably|preferred|bonus|nice[- ]to[- ]have|desirable|desired|a plus|plus if|good[- ]to[- ]have)\b/i;

// Soft words AFTER the years soften them: "3+ years ... is a plus". "preferably" is NOT here:
// "5+ years of experience building X, preferably with a focus on Y" qualifies the focus.
const SOFT_AFTER = /\b(?:is a plus|a plus|nice[- ]to[- ]have|preferred|is a bonus|a bonus|desirable|desired|advantageous|an advantage)\b/i;

// A sentence that OPENS a preferred section: every requirement after it is a wish until a
// hard heading. Stripe's "Preferred qualifications are a bonus, not a requirement." is one.
// Only a few known lead-ins may come before the soft word: Cloudflare's heading is "Examples of
// desirable skills, knowledge and experience" (live audit, 2026-11-04). ANY three words were
// allowed at first, and the code review caught that "Kubernetes experience preferred", an
// ordinary bullet, then switched the whole rest of the JD to soft and hid "6+ years" after it.
const SOFT_HEADING = /^\W*(?:(?:examples|some|other|additional|bonus|nice)\s+(?:of\s+)?)?(?:preferred|bonus|nice[- ]to[- ]haves?|good[- ]to[- ]haves?|desired|desirable|pluses|extra credit)\b/i;

// A sentence that opens a REQUIRED section, ending any preferred section before it. Stripe's
// "Minimum requirements" right after its "Preferred ..." sentence is the case this exists for.
const HARD_HEADING = /^\W*(?:minimum|basic|required|requirements|must[- ]haves?|what you(?:'|’)ll need|what we(?:'|’)re looking for|qualifications|you have|about you|who you are)\b/i;

// Titles Teja keeps whatever the JD asks (2026-11-01): interns, juniors (junior security
// included), new grads and campus programmes. Their JDs often carry generic years boilerplate.
const ENTRY_LEVEL_TITLE = /\b(?:intern|interns|internship|junior|jr\.?|new grad(?:uate)?|graduate|campus|entry[- ]level|trainee|apprentice(?:ship)?|fresher|early[- ]career)\b/i;

// Zero-width characters a board pasted into "2​+ years" (live, 2026-11-01). Removed
// before matching, or the plus would detach from the number.
const ZERO_WIDTH = /[​-‍﻿]/g;

// A matched number as a number, words included. YEARS only lets a known word or digits (with one
// decimal point) through, so a word lookup or Number() always yields a finite value here.
const toYears = (token: string): number => WORD_NUMBERS[token.toLowerCase()] ?? Number(token);

// The highest HARD minimum years the posting demands, or null when it states none.
// Null is the common case and always means keep.
export function requiredExperienceYears(title: string, description: string | null): number | null {
  // Entry-level roles are kept outright, before any text is read.
  if (ENTRY_LEVEL_TITLE.test(title)) return null;
  // The running answer; null until a hard requirement is seen.
  let need: number | null = null;
  // Record a candidate minimum, ignoring company-history numbers and keeping the highest.
  const take = (years: number): void => {
    // Plausibility first: "30 years of investing experience" is not a hiring bar.
    if (years >= MAX_PLAUSIBLE_YEARS) return;
    // The highest hard minimum wins, because the posting needs all of them.
    need = need === null ? years : Math.max(need, years);
  };

  // A range written into the title ("Engineer (3-5)") is a hard statement of level.
  const titleRange = title.match(TITLE_RANGE);
  // The lower bound is the minimum.
  if (titleRange !== null) take(Number(titleRange[1]));

  // The body as plain text, entities decoded, zero-width characters gone.
  const text = (stripHtml(description) ?? "").replace(ZERO_WIDTH, "");
  // Whether the current section is a preferred one. A JD starts in its requirements.
  let inPreferredSection = false;

  // Lines first (stripHtml turns <li> and <p> into newlines), then sentences within a line.
  for (const line of text.split("\n")) {
    // Sentence ends and bullet glyphs split a line into separately judged statements.
    for (const piece of line.split(/(?<=[.!?;])\s+|•/)) {
      // Whitespace around a piece carries nothing.
      const sentence = piece.trim();
      // Empty pieces come from double separators.
      if (sentence === "") continue;
      // A heading moves the section state BEFORE its own sentence is judged, so
      // "Minimum requirements 4+ years" is read as hard and "Preferred: 3+ years" as soft.
      if (SOFT_HEADING.test(sentence)) inPreferredSection = true;
      // A hard heading ends a preferred section.
      else if (HARD_HEADING.test(sentence)) inPreferredSection = false;
      // Everything under a preferred heading is a wish (Teja, 2026-11-01).
      if (inPreferredSection) continue;
      // Every "N years" in the sentence, judged on its own neighbourhood.
      for (const match of sentence.matchAll(YEARS)) {
        // The lower bound as a number.
        const years = toYears(match[1]!);
        // Where the match starts; matchAll always sets it.
        const at = match.index ?? 0;
        // The 40 characters before the number: the qualifier, if any, sits here.
        const before = sentence.slice(Math.max(0, at - 40), at);
        // The rest of the sentence after the match: "is a plus" sits here.
        const after = sentence.slice(at + match[0].length);
        // "less than one year" is a ceiling on the candidate, not a floor.
        if (UPPER_BOUND_BEFORE.test(before)) continue;
        // "4 year degree": a degree's length, not work experience.
        if (DEGREE_AFTER.test(after)) continue;
        // No work word right after (the match itself included, for "YOE") and no requirement word
        // right before: company prose or a benefit, whatever the rest of the sentence says.
        const near = sentence.slice(at, at + match[0].length + CONTEXT_AFTER_CHARS);
        // The words just before the number.
        const lead = sentence.slice(Math.max(0, at - CONTEXT_BEFORE_CHARS), at);
        // Neither side ties the years to the candidate's work.
        if (!CONTEXT_AFTER.test(near) && !CONTEXT_BEFORE.test(lead)) continue;
        // "ideally with 3+ years" is a wish.
        if (SOFT_BEFORE.test(before)) continue;
        // "3+ years ... is a plus" is a wish.
        if (SOFT_AFTER.test(after)) continue;
        // A hard, plausible minimum.
        take(years);
      }
    }
  }
  // The highest hard minimum, or null when the posting asked for none.
  return need;
}

// filter_rules.config.max_years by SHAPE: a finite, non-negative number (or a numeric string,
// since PostgREST sends numerics as strings). Anything else is "not configured", never 0:
// Number("") is 0, and a 0 ceiling would drop every job that asks for any years at all.
export function experienceCeilingMaxYears(config: unknown): number | null {
  // Only a plain object can hold the key; null and arrays are typeof "object" too.
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  // The raw value, of unknown type.
  const raw = (config as Record<string, unknown>).max_years;
  // A real number is accepted when finite and non-negative.
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;
  // A numeric string is accepted only when it is digits with an optional decimal.
  if (typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw.trim())) return Number(raw.trim());
  // Missing, boolean, object, "", "abc": not configured.
  return null;
}

// The matcher's twin of cascade.ts experienceCeiling, for rows that reach the matcher without
// passing the screener (the master-change re-run, 87fff82). Same rule, same code, same
// max_years. ponytail: two copies of one comparison; fold into one if cascade rules are exported.
export function screenRequiredExperience(job: ExperienceJob, maxYears: number | null): ExperienceVerdict {
  // No ceiling: report rather than invent one, in the cascade's own words.
  if (maxYears === null) return { drop: false, warning: "experience_ceiling has no max_years configured" };
  // A stored column wins over the parser, exactly as the cascade reads it.
  const stored = job.minExperienceYears === null ? null : Number(job.minExperienceYears);
  // An unreadable stored value must not drop ("abc" is NaN, "" is 0, so both are refused here).
  if (stored !== null && (!Number.isFinite(stored) || String(job.minExperienceYears).trim() === "")) {
    return { drop: false, warning: "experience_ceiling skipped: min_experience_years is unparseable" };
  }
  // The column when set, otherwise what the JD says.
  const required = stored ?? requiredExperienceYears(job.title, job.description);
  // No stated requirement: keep.
  if (required === null) return { drop: false };
  // Drop only when the posting demands more than the ceiling.
  return required > maxYears
    ? { drop: true, code: "experience_ceiling", reason: `JD requires ${required} years, ceiling is ${maxYears}` }
    : { drop: false };
}
