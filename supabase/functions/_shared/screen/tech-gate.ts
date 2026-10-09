// Stage 0 — the tech-role gate, run ahead of the cascade.
//
// TEJA'S DECISION, 2026-09-17 (docs/design/2026-09-17-tech-only-discovery.md): drop
// non-tech postings BEFORE the Matcher rather than at discovery, with the definition
// living in the `search_preferences` columns that already exist. That choice avoids all
// three costs of a new `FilterRuleType` — a migration against a real Postgres enum, an
// enum-parity update in shared-types, and an edit to `cascade.ts` — and Teja explicitly
// asked that the cascade not change. So this sits OUTSIDE the cascade, ahead of it.
//
// WHY AHEAD RATHER THAN INSIDE: the cascade is cost-ordered, cheapest test first, and a
// title comparison is the cheapest test that exists — a string match with no I/O, no
// date parsing and no database lookup. Cheapest-first puts it before the nine rules.
//
// THE DEFAULT IS INVERTED FROM THE BROWSER'S, AND THAT IS THE WHOLE DESIGN.
// `filtersStore.ts`'s `isTechRole()` classifies a title as non-tech when no positive
// pattern matches. That is safe in a browser, where the cost of being wrong is a row
// hidden from a list the user can still re-filter. It is unsafe here, where the cost is
// a posting deleted from a pipeline PROJECT_PLAN:149-152 already describes as yielding
// single digits per day — and a starved pipeline is indistinguishable from a broken one,
// because neither produces an error. So:
//     matches an excluded keyword  -> DROP
//     matches a target or keyword  -> PASS
//     matches neither              -> PASS, and warn
// The third branch is the change. An unrecognised title is a case the classifier has no
// opinion about, and a non-answer must never be recorded as a rejection.
//
// AMENDED BY TEJA, 2026-10-09 (option (d), recorded in the design doc's amendment note):
// the third branch now depends on whether the user configured anything.
//     titles AND keywords both empty -> PASS, and warn   (unchanged: nothing to judge by)
//     either one configured          -> DROP, code `tech_gate_unclassified`
// WHY: the 2026-09-17 rule priced the pass branch at "a few Gemini calls", assuming an
// unrecognised title is the exception. Measured live on 2026-10-09 it was the rule:
// 6636 of 6662 passed_filters rows (99.6%) matched nothing, about 3155 of them sales,
// partnerships, GTM or support roles. Once a user has said what they hunt for, a title
// matching none of it IS an answer. The empty-config case keeps the old branch because
// that is the one the starvation argument was really about: a new user with no lists.

// The config, read from `search_preferences` (supporting_tables.sql:178-183). Named
// rather than passed as three loose arrays so a caller cannot transpose two of them —
// swapping `titles` and `excludedKeywords` would invert the gate and still compile.
export interface TechGatePreferences {
  // Role titles being hunted.
  readonly titles: readonly string[];
  // Terms that make a posting more interesting; matched against the body too.
  readonly keywords: readonly string[];
  // The cheapest test in the cascade: terms that reject a posting outright.
  readonly excludedKeywords: readonly string[];
}

// The verdict, deliberately the same three-outcome shape as `RuleVerdict` in
// `cascade.ts`. Matching the existing vocabulary means a reader who has understood one
// has understood the other, and it makes the "pass but warn" branch look like what it
// is — a known, designed state rather than an oversight.
export type TechGateVerdict =
  // Recognised as relevant. Nothing to report.
  | { readonly drop: false }
  // Not recognised, and the user configured no titles or keywords to recognise it BY.
  // Passes, because with an empty config there is no answer to give, and warns, because
  // the empty config is the gap worth seeing.
  | { readonly drop: false; readonly warning: string }
  // Rejected. `code` is what lands in applications.drop_reason, closed to the two stage-0
  // outcomes so a caller cannot invent a third spelling; `reason` is the prose for logs.
  | { readonly drop: true; readonly code: TechGateDropCode; readonly reason: string };

// The two ways stage 0 rejects. Distinct codes, so a drop for an excluded term and a drop
// for matching nothing configured can be counted apart, and the second can be recovered
// wholesale if the config was what was wrong.
export type TechGateDropCode = "tech_gate" | "tech_gate_unclassified";

// Map a `search_preferences` row (or its absence) to the gate's config. Exported so every
// caller maps it the same way; `?? []` treats a missing row and a null column alike, as
// "nothing configured" — a missing row is a normal state, not a read failure. A FAILED
// read must never reach this function: the caller has to stop instead, or an error would
// be read as an empty config and silently pass everything.
export function toTechGatePreferences(
  // The row as PostgREST returns it, or undefined/null when the user has none.
  row: {
    readonly titles: readonly string[] | null;
    readonly keywords: readonly string[] | null;
    readonly excluded_keywords: readonly string[] | null;
  } | null | undefined,
): TechGatePreferences {
  return {
    // Role titles; null column or no row means none.
    titles: row?.titles ?? [],
    // Keywords; same rule.
    keywords: row?.keywords ?? [],
    // Column name differs from the field name; mapped here once.
    excludedKeywords: row?.excluded_keywords ?? [],
  };
}

// True when a list has at least one usable entry. Blank strings do not count, matching
// `firstMatch`, which skips them: a list of only "  " configures nothing.
function hasTerms(terms: readonly string[]): boolean {
  return terms.some((term) => term.trim() !== "");
}

// Build the matcher for one configured term.
//
// THIS IS THE SAME ALGORITHM AS `blockedTitlePattern` IN cascade.ts:188-198, and it is
// duplicated here only because that function is private to its module and cascade.ts is
// explicitly out of scope for this change. The two must stay in step; the right fix is
// for cascade.ts to import this one, which is a follow-up rather than a change Teja
// asked for. Flagged rather than done, and flagged here rather than only in a report.
//
// TWO FAILURES PULL IN OPPOSITE DIRECTIONS, which is why this is not an inline regex.
// A BARE SUBSTRING MATCH OVER-DROPS, and this is not hypothetical: the prototype at
// `scout-remote.ts:243` tests exclusions with `includes()`, so an excluded keyword of
// "ops" — an entirely reasonable entry for an operations role — deletes "DevOps
// Engineer" and "MLOps Engineer", the most in-demand roles on the list.
// AN UNCONDITIONAL \b UNDER-DROPS, and more subtly: \b marks a word/non-word transition,
// so `\bc\+\+\b` can never match "C++ Developer" — after "++" comes a space, and two
// non-word characters in a row are not a boundary. A term like "c++", ".net" or "c#"
// would look configured and match nothing, which is the worse failure because it is
// invisible from the settings page.
// So each boundary is applied CONDITIONALLY, per end, according to that end's own
// character.
function termPattern(term: string): RegExp {
  // Escape every metacharacter, so a term typed into a settings field is matched as
  // literal text and cannot compile into a pattern — or throw.
  const literal = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A leading boundary is only meaningful when the term STARTS with a word character.
  const leading = /^\w/.test(term) ? "\\b" : "";
  // Likewise a trailing boundary, tested against the term's LAST character.
  const trailing = /\w$/.test(term) ? "\\b" : "";
  // Case-insensitive, because recruiters do not agree on casing.
  return new RegExp(`${leading}${literal}${trailing}`, "i");
}

// Does any configured term appear in the text? Returns the term that matched, so a
// surprising verdict names its cause rather than merely asserting one.
function firstMatch(terms: readonly string[], text: string): string | undefined {
  // Blank entries are skipped: an empty string compiles to a pattern matching
  // everything, which would drop or pass every posting depending on which list it sat in.
  return terms.filter((term) => term.trim() !== "").find((term) => termPattern(term).test(text));
}

// Decide whether one posting is worth screening further.
//
// The description is truncated rather than matched whole: a keyword buried in the
// twelfth paragraph of a boilerplate benefits section says nothing about the role, and
// scanning full bodies across every posting on every board is the kind of cost this
// gate exists to avoid paying.
const DESCRIPTION_MATCH_LIMIT = 300;

export function screenTechRole(
  title: string,
  descriptionRaw: string | null,
  preferences: TechGatePreferences,
): TechGateVerdict {
  // Title plus the head of the body. Both are UNTRUSTED board text and are only ever
  // matched against, never interpolated anywhere.
  const haystack = `${title} ${(descriptionRaw ?? "").slice(0, DESCRIPTION_MATCH_LIMIT)}`;

  // EXCLUSIONS FIRST, so a posting carrying both signals is rejected. "Technical
  // Recruiter" contains a technical word and is not a technical job — the design doc's
  // own example of how fine this line is.
  const excluded = firstMatch(preferences.excludedKeywords, haystack);
  // A genuine rejection, naming the term so a wrong drop is diagnosable.
  if (excluded !== undefined) {
    return { drop: true, code: "tech_gate", reason: `title or description matches excluded term "${excluded}"` };
  }

  // Then the positive match. Titles and keywords are treated alike because a posting
  // titled "Product Engineer" that mentions React is as relevant as one titled
  // "Frontend Developer" — the config names two ways of describing one interest.
  const matched = firstMatch(preferences.titles, haystack) ?? firstMatch(preferences.keywords, haystack);
  // Recognised. No warning, so the warning below keeps meaning something.
  if (matched !== undefined) return { drop: false };

  // Nothing matched. What that MEANS depends on whether anything was configured to match.
  // A user with titles or keywords has stated what they hunt for, so a posting matching
  // none of it is rejected — with its own code, so these drops are countable and, if the
  // config turns out too narrow, recoverable as a set (Teja, 2026-10-09).
  if (hasTerms(preferences.titles) || hasTerms(preferences.keywords)) {
    return {
      drop: true,
      code: "tech_gate_unclassified",
      reason: `"${title}" matched no configured title or keyword`,
    };
  }

  // THE EMPTY-CONFIG BRANCH, kept from 2026-09-17. No titles and no keywords means the
  // classifier has no opinion — not that the answer is no. It passes, and it says so,
  // because the tight default here would be silent starvation that reads as "no jobs today".
  return {
    drop: false,
    warning: `"${title}" passed unclassified: no titles or keywords are configured`,
  };
}
