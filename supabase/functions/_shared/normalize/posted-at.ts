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
  | { readonly source: "aggregator"; readonly relativeText: string | null }
  // Remote job feeds (RemoteOK `date`/`epoch`, Jobicy `pubDate`, Arbeitnow `created_at`,
  // worker/src/scout/remote-feeds.ts): a genuine publish date, but the TYPE varies by feed
  // (ISO-shaped string, epoch seconds or epoch milliseconds), so the raw value is passed in
  // and judged here rather than in a per-feed local copy of this policy (2026-10-24).
  | { readonly source: "remote_feed"; readonly published: unknown };

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
// WHAT THIS RETURNS AND WHY THE SHAPE MATTERS MORE THAN THE LOGIC.
//
// `null` means "this source gave us nothing usable" — full stop, no confidence
// attached. A successful read returns a date paired with `exact` or `derived`, and
// `unknown` IS NOT IN THAT UNION AT ALL.
//
// THE BUG THIS SHAPE PREVENTS, which was live here until it was made structural.
// These branches used to return `{ date: null, confidence: "unknown" }` on a parse
// failure. Those `unknown`s never reached the output — but only because the CALLER
// reads `confidence` exclusively inside its `if (date !== null)` branch. So the
// system-wide guarantee that *`unknown` means "board not yet trusted" and NEVER means
// a parse failure* held by the caller's control flow, not by anything here.
//
// That is a loaded gun. A refactor that trusted this function's `confidence`
// unconditionally reads like a harmless simplification and would pass review — and it
// would silently start emitting `unknown` for malformed dates. The consequence is not
// cosmetic: `unknown` FAILS the staleness filter, so parse failures would begin
// quietly dropping fresh jobs, and the only visible symptom would be a lower discovery
// count that looks like thin supply. That is §13's own bug class arriving by a
// different door.
//
// Narrowing the return type makes the invariant unexpressible rather than merely
// untriggered: there is now nowhere in this function to write `unknown`. A test would
// have proven the current behaviour; the type prevents the refactor.
function readSourceDate(
  input: PostedAtInput,
  context: PostedAtContext,
): { readonly date: Date; readonly confidence: "exact" | "derived" } | null {
  // Switch on the discriminant so adding a fifth source is a compile error until
  // its date semantics are decided here rather than defaulted.
  switch (input.source) {
    // Greenhouse is the trap: a real timestamp with the wrong meaning.
    case "greenhouse": {
      // Still parsed, because as an upper bound it beats nothing.
      const date = parseTimestamp(input.updatedAt);
      // Unparseable: no verdict at all, so the caller falls back to its own sighting.
      if (date === null) return null;
      // Never `exact`, no matter how well-formed — that downgrade is the point.
      return { date, confidence: "derived" };
    }
    // Lever publishes a true creation instant.
    case "lever": {
      // Epoch milliseconds, with the zero sentinel rejected.
      const date = parseEpochMillis(input.createdAt);
      // Unparseable or the zero sentinel: no verdict.
      if (date === null) return null;
      // Genuine posting date.
      return { date, confidence: "exact" };
    }
    // Ashby publishes a true publication date.
    case "ashby": {
      // ISO string.
      const date = parseTimestamp(input.publishedDate);
      // Unparseable: no verdict.
      if (date === null) return null;
      // Genuine publication date.
      return { date, confidence: "exact" };
    }
    // Adzuna publishes a true creation date.
    case "adzuna": {
      // ISO string.
      const date = parseTimestamp(input.created);
      // Unparseable: no verdict.
      if (date === null) return null;
      // Genuine creation date.
      return { date, confidence: "exact" };
    }
    // Aggregators publish prose, or nothing.
    case "aggregator": {
      // Try to recover a day offset from the prose.
      const daysAgo = parseRelativeDays(input.relativeText);
      // Nothing recoverable: let the caller fall back to our own observation.
      if (daysAgo === null) return null;
      // Anchor the offset to the injected clock, never to the wall clock.
      return { date: new Date(context.now.getTime() - daysAgo * MS_PER_DAY), confidence: "derived" };
    }
    // Remote feeds publish a true date whose JSON type depends on the feed.
    case "remote_feed": {
      // Shape first, parse second (CLAUDE.md section 6). A number is epoch seconds below
      // 1e12 and milliseconds above it; a string must START like an ISO date, because V8
      // reads "-5" as a date in 2001 and a lenient parse would call that `exact`.
      const raw = input.published;
      // Epoch numbers, normalised to milliseconds; parseEpochMillis rejects 0 and negatives.
      const date = typeof raw === "number"
        ? parseEpochMillis(raw < 1e12 ? raw * 1000 : raw)
        // ISO-shaped strings only ("2026-10-22 09:00:00", "2026-10-23T10:00:00+00:00").
        : typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw) ? parseTimestamp(raw) : null;
      // Anything else (absent, prose, junk, a tiny epoch that lands in 1970): no verdict.
      if (date === null || date.getTime() < EARLIEST_REMOTE_POSTING) return null;
      // A genuine publish date.
      return { date, confidence: "exact" };
    }
  }
}

// The earliest believable remote-feed publish date. An epoch like 5 survives
// parseEpochMillis (it is positive) but means 1970, which is a placeholder, not a posting.
const EARLIEST_REMOTE_POSTING = Date.UTC(2000, 0, 1);

// The extractor. Every discovered job goes through this before it is written, so
// that `posted_at` and `posted_at_source` are always decided in one place.
export function extractPostedAt(input: PostedAtInput, context: PostedAtContext): PostedAtResult {
  // What the source itself claims, or `null` when it gave nothing usable. The union
  // deliberately cannot carry `unknown` — see the note above `readSourceDate`.
  const fromSource = readSourceDate(input, context);
  // The source gave us something usable, so no inference of ours is involved.
  // THE COLD-START GUARD DOES NOT APPLY HERE, and that scoping is the whole
  // subtlety: §13's defect lives entirely in the first_seen_at inference below.
  // A Lever `createdAt` is true whether or not we have polled this board before,
  // so downgrading it would discard a fact in order to defend against a guess we
  // never made — and supply is already the scarce thing (§13: a 3-day window over
  // a 50-company watchlist yields single digits per day, not 35).
  if (fromSource !== null) {
    return {
      // ISO-8601 UTC so the value is unambiguous crossing into Postgres.
      postedAt: fromSource.date.toISOString(),
      // `exact` for the three sources publishing a real posting timestamp,
      // `derived` for a Greenhouse edit timestamp or parsed aggregator prose.
      postedAtSource: fromSource.confidence,
    };
  }

  // Nothing usable from the source — the field was absent, empty, malformed or a
  // zero sentinel, all of which carry the same information. The only evidence left
  // is our own sighting, and THIS is the inference §13 warns about: "anything we
  // have never seen must be new" is sound in steady state and false on day one.
  return {
    // The sighting is still the best timestamp available, so it is what we store.
    postedAt: context.firstSeenAt.toISOString(),
    // On a board's first poll the entire back catalogue arrives stamped "today", so
    // the inference is refused outright rather than dressed up as `derived`. The
    // staleness filter reads `unknown` and declines to treat the row as fresh —
    // which is what stops a day of Gemini quota going to postings open since March.
    postedAtSource: context.isFirstPollOfBoard ? "unknown" : "derived",
  };
}
