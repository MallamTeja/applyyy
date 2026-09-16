// The salary gate — docs/harvest/2026-09-16-ai-job-search-harvest-plan.md §Q3.
//
// WHAT THIS ANSWERS, and it is not the question upstream asked: "is THIS POSTING'S
// stated range acceptable?" Upstream's salary feature answered "what does this company
// typically pay?", needed a hand-written external dataset, and shipped empty. §Q3 records
// that the two features shared a name and the wrong one was nearly inherited. This one
// needs no dataset at all — the number comes from the posting.
//
// A GATE, NOT A WEIGHTED DIMENSION. It is pass/fail and unweighted, exactly like the
// location rule beside it in `filter/cascade.ts`. The distinction is load-bearing: a
// veto is not a low score. A job paying half the target is not "a job with a slightly
// worse number", it is a job we will not apply to, and expressing that as lost points
// would let a strong technical match outvote it.
//
// WHY THIS MODULE IS PURE AND LIVES BESIDE THE CASCADE RATHER THAN THE MATCHER:
// `cascade.ts` states the economics — "deterministic filters must run before anything
// costs a call", and the saving compounds across three agents. Running a salary
// comparison AFTER the Matcher would mean spending a Gemini call to score a job we were
// always going to discard. So this file holds the comparison and nothing else; the
// wiring into the cascade is a separate, owned-elsewhere change.
//
// THE DESIGN RULE THAT SHAPES EVERY BRANCH BELOW: this gate only FAILS when it can
// compare honestly. Unknown period, unknown currency, cross-currency, unparseable
// amount, unconfigured band — all PASS. Inventing an exchange rate or assuming "probably
// per year" is a constraint #2 fabrication, and a gate that guesses discards real jobs
// while leaving no evidence a guess occurred. Passing costs at most one Gemini call;
// guessing costs supply that nobody can see going missing.

// How often a stated figure is paid. There is no column for this anywhere in the schema,
// which is exactly why it is an explicit input rather than something inferred — a number
// without a period is not a comparable number.
export type SalaryPeriod = "year" | "month" | "hour";

// The posting's stated compensation, shaped as `jobs` actually stores it.
//
// AMOUNTS ARE STRINGS, NOT NUMBERS. `jobs.salary_min` is `numeric(14,2)` and PostgREST
// serialises numerics as strings to avoid float precision loss. `cascade.ts` documents
// the same convention for `minExperienceYears`. Typing them as `number` here would be a
// lie the caller has to paper over at every call site.
export interface PostingSalary {
  // The advertised floor, or null when the board stated none.
  readonly min: string | null;
  // The advertised ceiling, or null for an open-ended "from X" posting.
  readonly max: string | null;
  // ISO currency code as the board wrote it. Null when unstated.
  readonly currency: string | null;
  // Null means "the board did not say", NOT a default. Collapsing those two is the
  // single most dangerous simplification available in this file.
  readonly period: SalaryPeriod | null;
}

// The user's configured band, from `search_preferences`.
//
// `currency` and `period` are NON-nullable here while the posting's are nullable, and the
// asymmetry is deliberate: the user's own configuration is something we can require the
// caller to state, whereas a third-party board's silence is a fact we must handle.
export interface SalaryPreference {
  // Band floor. Null means the user set none.
  readonly min: string | null;
  // Band ceiling. Null means the user set none.
  readonly max: string | null;
  // What currency the band is expressed in. `search_preferences` defaults this to 'INR'.
  readonly currency: string;
  // What the band's numbers mean. `search_preferences` has no period column, so the
  // caller declares it rather than this module inferring it.
  readonly period: SalaryPeriod;
}

// The verdict, carrying its own justification.
//
// A DISCRIMINATED UNION RATHER THAN A BOOLEAN PLUS AN OPTIONAL STRING, so a `fail` is
// structurally incapable of existing without its evidence. The plan requires the verbatim
// triggering line beside every verdict; making it a required field of the failing arm
// means it cannot be forgotten at a call site.
//
// FLAG IS DELIBERATELY NOT PLUMBED YET, and this is the shape that keeps it cheap later.
// §Q3 rules above-range as FAIL while noting it is the one rule where a false negative
// discards a genuinely good opportunity, and whether it should soften to FLAG is still
// open with Teja. `ScreenOutcome` in `filter/cascade.ts` is binary today, so introducing
// a third state here would be a cross-partition type change riding inside a feature.
// Adding `| { verdict: "flag"; ... }` to this union is additive whenever that is ruled.
export type SalaryGateResult =
  // Comparable and acceptable, or not comparable at all. `reason` records WHICH, because
  // "passed the band" and "we could not read the currency" are very different facts to
  // find in a log six weeks later.
  | { readonly verdict: "pass"; readonly reason: string }
  // Comparable and outside the band. `evidence` is the quotable triggering line.
  | { readonly verdict: "fail"; readonly reason: string; readonly evidence: string };

// How many of a period fit in a year, used to bring both sides onto one scale.
//
// 2080 HOURS IS 40 x 52, THE STANDARD FULL-TIME YEAR. It is an assumption, but it is a
// declared and conventional one rather than a silent guess, and it only ever applies when
// a board explicitly said "per hour" — never as a fallback for an unstated period.
const PERIODS_PER_YEAR: Readonly<Record<SalaryPeriod, number>> = {
  year: 1,
  month: 12,
  hour: 2080,
};

// Turn a PostgREST numeric string into a usable number, or null when it is not one.
//
// THE `Number("")` TRAP IS THE REASON THIS IS NOT A ONE-LINER. Empty string coerces to 0,
// and a silent zero here would read as "this job pays nothing", failing every blank or
// malformed row as below-band. That is the §Q3 backwards failure arriving through a side
// door, so anything not strictly positive and finite is treated as absent instead.
function parseAmount(raw: string | null): number | null {
  // Nothing to read.
  if (raw === null) return null;
  // Whitespace-only is absence, not zero.
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // "negotiable", "competitive", "12-15 LPA" and friends all land here as NaN.
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  // Zero or negative pay is not a range we can meaningfully compare against a band.
  if (value <= 0) return null;
  return value;
}

// Bring an amount onto a per-year basis so the two sides are comparable at all.
function toAnnual(amount: number, period: SalaryPeriod): number {
  return amount * PERIODS_PER_YEAR[period];
}

// Compare one posting's stated compensation against the user's configured band.
//
// Pure: no clock, no database, no network. That is what lets every branch below be
// covered by a plain object literal, including the branches that exist only to refuse to
// answer.
export function evaluateSalaryGate(posting: PostingSalary, preference: SalaryPreference): SalaryGateResult {
  // The user's band, on a per-year basis. Read first because an unconfigured band short
  // -circuits everything else — there is no point parsing a posting we cannot judge.
  const rawBandMin = parseAmount(preference.min);
  const rawBandMax = parseAmount(preference.max);

  // NO BAND MEANS NO PREFERENCE EXPRESSED. Filtering against an empty configuration would
  // drop jobs on a setting the user never chose, which is a filter inventing its own
  // policy.
  if (rawBandMin === null && rawBandMax === null) {
    return { verdict: "pass", reason: "no salary band configured" };
  }

  // The posting's own numbers.
  const rawPostingMin = parseAmount(posting.min);
  const rawPostingMax = parseAmount(posting.max);

  // ROW 1 OF THE RULED TABLE, AND THE ONE MOST LIKELY TO BE WRITTEN BACKWARDS. "Absence
  // of data is not a reason to skip, and must not score as a negative." Most Indian
  // postings state no range at all, so inverting this would silently discard the bulk of
  // discovery and present as thin supply rather than as a bug.
  if (rawPostingMin === null && rawPostingMax === null) {
    return { verdict: "pass", reason: "posting states no salary" };
  }

  // A FIGURE WITHOUT A PERIOD IS NOT A FIGURE. 50,000 per month clears this band and
  // 50,000 per year does not, so assuming either one invents the verdict. §Q3: "a range
  // that cannot be parsed confidently is treated as no salary, never guessed."
  if (posting.period === null) {
    return { verdict: "pass", reason: "posting salary period is unstated, so it is not comparable" };
  }

  // WE HOLD NO EXCHANGE RATES AND MUST NOT INVENT ANY. A USD posting against an INR band
  // is not comparable, and converting it with a hardcoded rate would be both a
  // fabrication and silently wrong the day the rate moves. Comparison is refused instead.
  if (posting.currency === null || posting.currency.trim().toUpperCase() !== preference.currency.trim().toUpperCase()) {
    return { verdict: "pass", reason: "posting currency is absent or differs from the configured band, so it is not comparable" };
  }

  // Both sides onto a per-year basis before anything is compared. Normalisation has to
  // happen BEFORE the comparison or the comparison is meaningless.
  const bandMin = rawBandMin === null ? null : toAnnual(rawBandMin, preference.period);
  const bandMax = rawBandMax === null ? null : toAnnual(rawBandMax, preference.period);
  const postingMin = rawPostingMin === null ? null : toAnnual(rawPostingMin, posting.period);
  const postingMax = rawPostingMax === null ? null : toAnnual(rawPostingMax, posting.period);

  // The best this posting advertises, and the least it advertises. An open-ended "from X"
  // posting collapses both onto the single number it gave, which is still comparable —
  // "the most it offers is below your floor" is a sound judgement from a floor alone.
  const postingCeiling = postingMax ?? postingMin;
  const postingFloor = postingMin ?? postingMax;

  // A quotable description of the posting's own claim, built once and reused by both
  // failing arms so the evidence reads identically wherever it surfaces.
  const statedRange = `${posting.currency} ${posting.min ?? "?"}-${posting.max ?? "?"} per ${posting.period}`;
  const configuredBand = `${preference.currency} ${preference.min ?? "?"}-${preference.max ?? "?"} per ${preference.period}`;

  // ROW 3. The most it pays is under the least we accept.
  if (bandMin !== null && postingCeiling !== null && postingCeiling < bandMin) {
    return {
      verdict: "fail",
      reason: "posting salary is below the configured band",
      evidence: `posting states ${statedRange}, below configured band ${configuredBand}`,
    };
  }

  // ROW 4. The least it pays is over the most we target. A SENIORITY MISMATCH RATHER THAN
  // A WINDFALL — a role paying triple the target is advertising for someone else, and
  // applying reads as not having understood the posting.
  if (bandMax !== null && postingFloor !== null && postingFloor > bandMax) {
    return {
      verdict: "fail",
      reason: "posting salary is above the configured band",
      evidence: `posting states ${statedRange}, above configured band ${configuredBand}`,
    };
  }

  // ROW 2. Comparable, and it overlaps the band.
  return { verdict: "pass", reason: "posting salary is within the configured band" };
}
