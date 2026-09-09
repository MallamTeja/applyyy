// PROJECT_PLAN.md §13. Two ideas live here and neither is optional:
//
//  1. A date is worthless without a confidence. Greenhouse hands us a timestamp
//     that LOOKS like a posted date and is not one, so the pipeline must be able
//     to tell "posted 2 days ago" apart from "edited 2 days ago".
//  2. The cold-start guard. The first poll of a new board cannot distinguish a
//     job posted today from one open since March, so it declines to guess.
//
// Pure and clock-injected: no `Date.now()` inside, because a function that reads
// the wall clock cannot be tested for "3 days ago" without being flaky.

// Confidence in the accompanying date, in descending order of trust. Mirrors the
// `posted_at_source` column so the value written is the value tested here.
export type PostedAtConfidence =
  // The source published a genuine posting timestamp (Lever, Ashby, Adzuna).
  | "exact"
  // We computed it: a Greenhouse edit timestamp, parsed prose, or our own first
  // sighting of the posting.
  | "derived"
  // We have no defensible claim. The staleness filter must NOT treat this as fresh.
  | "unknown";

// What the extractor returns: the pair, never the date alone.
export interface PostedAtResult {
  // ISO-8601 UTC, and never null: `firstSeenAt` is always available as a last
  // resort, so there is always SOME timestamp. Absence is expressed through the
  // confidence below, not through a null date — which keeps every consumer from
  // having to null-check a field that is never null.
  readonly postedAt: string;
  // How much the rest of the pipeline is allowed to trust the value above. This
  // is the field that carries "we do not know", not the date.
  readonly postedAtSource: PostedAtConfidence;
}

// Everything time-dependent is passed in, which is what keeps this function pure.
export interface PostedAtContext {
  // The scout run's clock, used to resolve relative prose like "3 days ago".
  readonly now: Date;
  // When our system first observed this posting — the steady-state fallback.
  readonly firstSeenAt: Date;
  // True on a board's very first poll, which is when first_seen_at lies (§13).
  readonly isFirstPollOfBoard: boolean;
}

// A discriminated union rather than one loose bag of optional fields: the compiler
// then forces a new adapter to declare which date field it actually has, instead of
// silently landing in the fallback branch.
export type PostedAtInput =
  // Greenhouse: `updated_at` only — a description edit resets it.
  | { readonly source: "greenhouse"; readonly updatedAt: string | null }
  // Lever: genuine `createdAt`, epoch milliseconds.
  | { readonly source: "lever"; readonly createdAt: number | null }
  // Ashby: genuine `publishedDate`, ISO string.
  | { readonly source: "ashby"; readonly publishedDate: string | null }
  // Adzuna: genuine `created`, ISO string.
  | { readonly source: "adzuna"; readonly created: string | null }
  // Aggregated LinkedIn/Naukri: sometimes relative prose, often nothing at all.
  | { readonly source: "aggregator"; readonly relativeText: string | null };

// Milliseconds in a day, named so the relative-date arithmetic below reads as
// arithmetic rather than as a magic constant.
const MS_PER_DAY = 86_400_000;

// Word forms that carry a day offset without a digit, mapped to that offset.
const WORD_OFFSETS_IN_DAYS: ReadonlyMap<string, number> = new Map([
  // "today" and "just posted" both mean zero days back.
  ["today", 0],
  // "yesterday" is the only word form that is unambiguously one day.
  ["yesterday", 1],
]);

// Parse an ISO-ish string into a valid Date, or null. Returning null rather than
// an Invalid Date forces every caller to handle absence explicitly.
function parseTimestamp(value: string | null): Date | null {
  // A missing field is absence, not corruption.
  if (value === null) return null;
  // The Date constructor accepts every shape these four APIs emit.
  const parsed = new Date(value);
  // NaN time is how JavaScript signals an unparseable string; refuse it here so
  // no caller can accidentally serialise an Invalid Date into the database.
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Parse epoch milliseconds, rejecting the sentinels boards use for "never set".
function parseEpochMillis(value: number | null): Date | null {
  // Absent field.
  if (value === null) return null;
  // Zero and negatives are placeholder values, not January 1970 postings — a job
  // dated 1970 would sail through every comparison as "very stale" or, worse, be
  // read as a real date by a future report.
  if (!Number.isFinite(value) || value <= 0) return null;
  // Otherwise it is a genuine instant.
  return new Date(value);
}

// Pull a day offset out of aggregator prose. Deliberately narrow: it recognises
// the handful of phrasings the boards actually emit and refuses everything else,
// because a loose parser that guesses is worse than one that declines.
function parseRelativeDays(text: string | null): number | null {
  // Nothing to parse.
  if (text === null) return null;
  // Lowercase once so every pattern below can ignore casing.
  const normalized = text.toLowerCase();
  // Word forms first, since "today" contains no digit for the numeric branch.
  for (const [word, days] of WORD_OFFSETS_IN_DAYS) {
    // Substring rather than equality, because boards prefix "Posted ".
    if (normalized.includes(word)) return days;
  }
  // Numeric forms: "3 days ago", "30+ days ago", "1 day ago", "5 hours ago".
  const match = /(\d+)\s*\+?\s*(hour|day|week|month)s?\s+ago/.exec(normalized);
  // No recognised quantity means we decline rather than invent one.
  if (match === null) return null;
  // The captured count; the regex guarantees it parses.
  const amount = Number(match[1]);
  // Map the unit onto days. Hours round to zero, which is correct: anything under
  // a day old is today for a 3-day freshness window.
  const unitInDays: Record<string, number> = { hour: 0, day: 1, week: 7, month: 30 };
  // Multiply out. The unit is one of the four the regex allows.
  return amount * (unitInDays[match[2] as string] as number);
}

// Reduce the union to "the best genuine timestamp this source offers, and whether
// that timestamp actually means 'posted'".
function readSourceDate(
  input: PostedAtInput,
  context: PostedAtContext,
): { readonly date: Date | null; readonly confidence: PostedAtConfidence } {
  // Switch on the discriminant so adding a fifth source is a compile error until
  // its date semantics are decided here rather than defaulted.
  switch (input.source) {
    // Greenhouse is the trap: a real timestamp with the wrong meaning.
    case "greenhouse": {
      // Still parsed, because as an upper bound it beats nothing.
      const date = parseTimestamp(input.updatedAt);
      // Never `exact`, no matter how well-formed — that downgrade is the point.
      return { date, confidence: date === null ? "unknown" : "derived" };
    }
    // Lever publishes a true creation instant.
    case "lever": {
      // Epoch milliseconds, with the zero sentinel rejected.
      const date = parseEpochMillis(input.createdAt);
      // Genuine posting date when present.
      return { date, confidence: date === null ? "unknown" : "exact" };
    }
    // Ashby publishes a true publication date.
    case "ashby": {
      // ISO string.
      const date = parseTimestamp(input.publishedDate);
      // Genuine when parseable.
      return { date, confidence: date === null ? "unknown" : "exact" };
    }
    // Adzuna publishes a true creation date.
    case "adzuna": {
      // ISO string.
      const date = parseTimestamp(input.created);
      // Genuine when parseable.
      return { date, confidence: date === null ? "unknown" : "exact" };
    }
    // Aggregators publish prose, or nothing.
    case "aggregator": {
      // Try to recover a day offset from the prose.
      const daysAgo = parseRelativeDays(input.relativeText);
      // Nothing recoverable: let the caller fall back to our own observation.
      if (daysAgo === null) return { date: null, confidence: "unknown" };
      // Anchor the offset to the injected clock, never to the wall clock.
      return { date: new Date(context.now.getTime() - daysAgo * MS_PER_DAY), confidence: "derived" };
    }
  }
}

// The extractor. Every discovered job goes through this before it is written, so
// that `posted_at` and `posted_at_source` are always decided in one place.
export function extractPostedAt(input: PostedAtInput, context: PostedAtContext): PostedAtResult {
  // What the source itself claims.
  const fromSource = readSourceDate(input, context);
  // Fall back to our own sighting when the source gave nothing usable — whether
  // the field was absent, empty, malformed or a zero sentinel, since all four
  // carry the same information. This is sound in steady state: if we poll daily,
  // a posting we have never seen before is genuinely new.
  const resolved: { readonly date: Date; readonly confidence: PostedAtConfidence } =
    fromSource.date === null
      // The observation timestamp is real evidence, but it is inference, so `derived`.
      ? { date: context.firstSeenAt, confidence: "derived" }
      // Otherwise keep what the source gave us, at the confidence it earned.
      : { date: fromSource.date, confidence: fromSource.confidence };

  // THE COLD-START GUARD. On a board's first poll, first_seen_at is meaningless —
  // an entire back catalogue arrives stamped "today". §13 says mark EVERYTHING on
  // that poll `unknown`, including sources with genuine dates. Suppressing a
  // genuine date costs one poll cycle of delay; trusting a false one costs a day
  // of Gemini quota spent on postings that have been open for months.
  if (context.isFirstPollOfBoard) {
    return {
      // The timestamp is still returned so the dashboard can display something,
      // but the confidence beside it forbids any freshness claim.
      postedAt: resolved.date.toISOString(),
      // The staleness filter reads this and declines to treat the row as fresh.
      postedAtSource: "unknown",
    };
  }

  // Steady state: report the date and the confidence it genuinely earned.
  return {
    // ISO-8601 UTC so the value is unambiguous crossing into Postgres.
    postedAt: resolved.date.toISOString(),
    // `exact` only for the three sources that publish a real posting timestamp.
    postedAtSource: resolved.confidence,
  };
}
