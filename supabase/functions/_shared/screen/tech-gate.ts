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
  // Role titles being hunted; matched against the job TITLE only (2026-10-09).
  readonly titles: readonly string[];
  // Terms that make a posting more interesting; the ONLY list also matched against the
  // description head.
  readonly keywords: readonly string[];
  // The cheapest test in the cascade: terms that reject a posting outright; matched against
  // the job TITLE only (2026-10-09).
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

// The ways stage 0 rejects. Distinct codes, so a drop for an excluded term, a drop for
// matching nothing configured, and a campus-only programme can be counted apart, and each
// set recovered wholesale if the rule behind it turns out wrong.
export type TechGateDropCode = "tech_gate" | "tech_gate_unclassified" | "campus_restricted";

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

// Collapse every whitespace run to ONE space. JS `\s` covers spaces, tabs, newlines and the
// Unicode spaces HTML-scraped boards carry (NBSP U+00A0 among them).
// WHY (2026-10-09, a §6 fail-open found live): the title "Staff  Software Engineer" (two
// spaces) slipped past the exclusion "Staff Software", because termPattern escapes a term's
// space literally, so it matched exactly one space. Whitespace carries no meaning in a job
// title, so both sides are normalised here, the one place every match routes through.
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

// Does any configured term appear in the text? Returns the term that matched, so a
// surprising verdict names its cause rather than merely asserting one.
function firstMatch(terms: readonly string[], text: string): string | undefined {
  // The text once, normalised; every term below is tested against this same string.
  const normalisedText = collapseWhitespace(text);
  // Blank entries are skipped: an empty string compiles to a pattern matching
  // everything, which would drop or pass every posting depending on which list it sat in.
  // Each term is normalised (and trimmed) before it is compiled, so "Software  Engineer"
  // typed in the settings field matches a single-spaced title. The ORIGINAL term is
  // returned, so a drop reason names the term as the user configured it.
  return terms
    .filter((term) => term.trim() !== "")
    .find((term) => termPattern(collapseWhitespace(term).trim()).test(normalisedText));
}

// LEVEL WORDS say how senior a role is, never WHAT it is (2026-11-05, P3 #6). Configured as
// title terms they matched any discipline: the term "Intern" passed "Intern, Company
// Secretary" (PhonePe, scored 8/100) because a title term matches the title alone. So a
// level word recognises a posting only when its title also carries a TECH_TITLE_SIGNAL.
// Compared normalised and lower-cased, so "New  Grad" and "new grad" are the same entry.
//
// WHY A BUILT-IN TECH VOCABULARY AND NOT "ALSO NEED A CONFIGURED TERM": measured live on
// 2026-11-05 that stricter rule newly dropped 32 of 393 open rows, most of them real tech
// roles ("Software Engineering Intern", "Machine Learning Intern", 3 already approved),
// because "Software Engineer" does not match "Software Engineering". The configured list is
// what the user hunts; this vocabulary only answers "is this intern role technical at all".
const LEVEL_ONLY_TERMS: ReadonlySet<string> = new Set([
  // The two spellings Teja configured on 2026-11-05.
  "intern",
  "internship",
  // Seniority, not discipline.
  "junior",
  // Graduate schemes span finance, legal and ops as often as engineering.
  "graduate",
  // The US spelling of the same thing.
  "new grad",
  // Common Indian-board spellings of an entry-level role.
  "trainee",
  // Same.
  "fresher",
  // Same.
  "apprentice",
  // Same.
  "entry level",
]);

// Words that make a TITLE technical. Word-bounded, case-insensitive. Deliberately broad: a
// miss here wrongly drops a tech intern, while an extra word only lets a borderline title on
// to the matcher, which scores it. Bare "IT" is left out because /i would match the pronoun.
const TECH_TITLE_SIGNAL =
  /\b(engineer|engineers|engineering|eng|software|developer|development|sde|data|ai|artificial intelligence|ml|machine learning|deep learning|llm|research|researcher|scientist|cloud|devops|sre|security|cyber|qa|test|testing|automation|backend|back-end|frontend|front-end|full[- ]?stack|web|mobile|platform|infrastructure|system|systems|technology|technical|tech|computer|programming|programmer|analytics|analyst|network|networking|embedded|firmware|hardware|silicon|fpga|robotics|quantitative)\b/i;

// Is this configured title term a level word rather than a discipline?
function isLevelOnly(term: string): boolean {
  // Normalised the same way firstMatch normalises before compiling, then lower-cased.
  return LEVEL_ONLY_TERMS.has(collapseWhitespace(term).trim().toLowerCase());
}

// A CAMPUS-ONLY PROGRAMME: "2027 Software Engineer - Campus Graduate Program - IIT BHU"
// (Point72, 2026-11-05). Such a programme recruits only that institute's students. The rule
// needs BOTH signals in the TITLE: the word "campus" and an institute acronym, so "Campus
// Operations Manager" or "Campus Fabric" (no institute) is untouched.
// CANDIDATE-INDEPENDENT BY DESIGN, with a stated assumption: the gate's callers (scouts,
// screener, matcher and auditor pre-gates) carry no education data, and Teja's master
// profile (v15, 2026-11-05) lists MLR Institute of Technology and TKR College of
// Engineering and Technology, neither of which is one of these institutes. If that ever
// changes, this rule must learn the candidate's institutions before it drops anything.
const CAMPUS_WORD = /\bcampus\b/i;
// The institute acronyms that run named-campus hiring. CASE-SENSITIVE on purpose: they are
// always written in capitals, and /i would let ordinary words collide ("nit" in prose).
const NAMED_INSTITUTE = /\b(IIT|IIIT|NIT|BITS|IIM|IISc)\b/;

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
  // Title plus the head of the body, read by KEYWORDS only since 2026-10-09 (titles and
  // exclusions read the title alone). Both are UNTRUSTED board text and are only ever
  // matched against, never interpolated anywhere.
  const haystack = `${title} ${(descriptionRaw ?? "").slice(0, DESCRIPTION_MATCH_LIMIT)}`;

  // EXCLUSIONS FIRST, so a posting carrying both signals is rejected. "Technical
  // Recruiter" contains a technical word and is not a technical job — the design doc's
  // own example of how fine this line is.
  // EXCLUSIONS READ THE TITLE ONLY (Teja, 2026-10-09 15:07, reversing the 09-17 rule that
  // read the description head too). Live: the configured title "Cloud Operations Engineer"
  // was dropped by the exclusion "Head" found in its body — "…MongoDB is at the head of its
  // disruption…". Bare seniority words (Head, Lead, Staff, Manager) are ordinary company
  // prose; in a TITLE they describe the role, which is what an exclusion is for.
  const excluded = firstMatch(preferences.excludedKeywords, title);
  // A genuine rejection, naming the term so a wrong drop is diagnosable.
  if (excluded !== undefined) {
    return { drop: true, code: "tech_gate", reason: `title matches excluded term "${excluded}"` };
  }

  // Then the positive match. A posting titled "Product Engineer" that mentions React is as
  // relevant as one titled "Frontend Developer", so a KEYWORD may match the title or the
  // description head. A configured TITLE term matches the job TITLE ONLY (Teja, 2026-10-09,
  // amending the 09-17 rule that treated both alike): measured live, 111 rows passed only
  // because a title term like "Developer" or "Software Engineer" sat in the body — "work
  // with our developers" — 74 of them sales, finance or business roles.
  // A campus-only programme at a named institute is closed to the candidate, however well its
  // role matches. Checked before the positive match, which it would otherwise pass.
  if (CAMPUS_WORD.test(title) && NAMED_INSTITUTE.test(title)) {
    // Names the institute, so a wrong drop says which campus the rule saw.
    const institute = NAMED_INSTITUTE.exec(title)?.[1] ?? "";
    // Its own code, so these drops are countable and revertible as a set.
    return { drop: true, code: "campus_restricted", reason: `"${title}" is a campus programme restricted to ${institute}` };
  }

  // Discipline title terms and level words, split once (see LEVEL_ONLY_TERMS).
  const disciplineTitles = preferences.titles.filter((term) => !isLevelOnly(term));
  // The level words the user configured.
  const levelTitles = preferences.titles.filter(isLevelOnly);
  // Recognised by a discipline title or a keyword: a real match.
  const matched = firstMatch(disciplineTitles, title) ?? firstMatch(preferences.keywords, haystack);
  // Recognised. No warning, so the warning below keeps meaning something.
  if (matched !== undefined) return { drop: false };

  // Only a level word matched. It recognises the posting when the title is technical, and
  // the drop below names the level term when it is not ("Intern, Company Secretary").
  const levelOnly = firstMatch(levelTitles, title);
  // A technical title at the configured level: recognised, as before this change.
  if (levelOnly !== undefined && TECH_TITLE_SIGNAL.test(title)) return { drop: false };
  // A level word on a non-technical title: say exactly why it did not count.
  if (levelOnly !== undefined) {
    return {
      drop: true,
      code: "tech_gate_unclassified",
      reason: `"${title}" matched only the level term "${levelOnly}" and no technical word`,
    };
  }

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
