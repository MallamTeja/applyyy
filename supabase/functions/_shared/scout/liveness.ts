// Deciding which stored jobs have dropped off a board, and which have come back.
//
// THE RULE THIS FILE HOLDS: A POLL MAY ONLY MARK JOBS DEAD WHEN IT IS EVIDENCE THAT THEY
// ARE. "Not in this poll" is only a fact about the job when the poll itself is
// trustworthy AND recognisably the same board we stored last time. Every refusal below
// is a way a poll can look like "these jobs closed" while actually saying "this poll, or
// our identity for these jobs, is broken" (CLAUDE.md §5: missing data becoming an
// answer — here, an absent posting becoming a verdict of death).
//
// A refusal is CHEAP and a wrong mark is not: refusing writes nothing, and the next poll
// (six hours later) simply asks again. A wrong mark hides live jobs from the Tailor.
// So every threshold here errs towards refusing.
//
// Pure: no database, no clock. scout-ats does the I/O and hands the sets here, which
// is what makes these guards testable while the Edge Function entrypoint is not.

// THE IDENTITY-DRIFT THRESHOLD. If fewer than this share of the board's stored live
// fingerprints appear in the poll, the fingerprints changed — a parser, a normaliser or
// the board's id scheme moved — and "half the company's jobs closed at once" is the far
// less likely story. 0.5 because a real board turns over a few percent per poll interval;
// losing half of what we knew in six hours is a different event from hiring churn.
export const MIN_FINGERPRINT_OVERLAP_SHARE = 0.5;

// THE MASS-DISAPPEARANCE CAP. Even with healthy overlap, more than this share vanishing
// in one poll is refused and logged instead of written. Deliberately LOWER than the
// drift threshold's complement (0.5): if both were 0.5 the two guards would be the same
// inequality written twice (absent share = 1 - overlap share), and one of them could
// never fire. The band between 25% and 50% absent is "plausibly real, too big to trust
// unreviewed" — e.g. a board serving a partial page that still parsed.
export const MAX_DISAPPEARANCE_SHARE = 0.25;

// Below this many absentees the share cap does not apply. Without it a 2-job board
// that closes one opening (50% absent) would be refused forever and never mark anything.
// The drift guard still applies, so this cannot open the whole-inventory hole.
// ponytail: a 1-job board can still never mark (overlap 0% reads as drift); acceptable,
// add a per-board history check if single-posting boards start to matter.
export const MASS_DISAPPEARANCE_FLOOR = 1;

// One stored job that is currently live (disappeared_at IS NULL) on the polled board.
export interface StoredJob {
  // The row to mark; the only thing the caller writes against.
  readonly id: string;
  // The identity compared against the poll.
  readonly fingerprint: string;
}

// Why a poll was not allowed to mark anything. A closed union so a caller can count
// refusals by cause and a new cause cannot be invented at a call site.
export type RefusalReason =
  | "poll_not_ok"
  | "batch_errors"
  | "empty_poll"
  | "no_stored_jobs"
  | "identity_drift"
  | "mass_disappearance";

// The verdict. A discriminated union with NO convenience boolean on purpose (§5: a
// boolean beside a union collapses it back into the thing it replaced, and every caller
// branches on the boolean).
export type DisappearancePlan =
  | { readonly kind: "mark"; readonly ids: readonly string[] }
  | {
      readonly kind: "refuse";
      readonly reason: RefusalReason;
      // Numbers behind the refusal, so a log line is diagnosable without a re-poll.
      readonly detail: string;
    };

// The facts one board poll hands the planner.
export interface DisappearanceInput {
  // The board's live jobs AS THEY STOOD BEFORE THIS POLL WROTE ANYTHING. Snapshot order
  // matters: read after the inserts, a fingerprint drift would add every posting as a new
  // row, the new rows would "overlap" 100%, and both guards below would pass vacuously.
  readonly storedLive: readonly StoredJob[];
  // Every fingerprint this poll produced. Duplicates are tolerated.
  readonly polledFingerprints: readonly string[];
  // Did the fetch and the parse both succeed?
  readonly pollOk: boolean;
  // Write errors during this poll. Any at all means the poll's view is partial.
  readonly batchErrors: number;
}

// Decide which stored-live jobs to mark disappeared, or refuse to mark any.
export function planDisappearances(input: DisappearanceInput): DisappearancePlan {
  // A failed fetch or parse says nothing about the jobs; it says the poll failed.
  if (!input.pollOk) return { kind: "refuse", reason: "poll_not_ok", detail: "fetch or parse failed" };
  // A partial write means part of this poll's picture is missing; never act on half.
  if (input.batchErrors > 0) {
    return { kind: "refuse", reason: "batch_errors", detail: `${input.batchErrors} batch error(s)` };
  }
  // Set, so duplicate postings and the membership test below are both handled once.
  const polled = new Set(input.polledFingerprints);
  // A 200 with zero jobs is likelier an error page, a WAF or an emptied API than a
  // company with no openings — and acting on it would mark the whole board dead.
  if (polled.size === 0) return { kind: "refuse", reason: "empty_poll", detail: "poll returned 0 postings" };
  // First poll of the board: nothing stored, so nothing to compare and nothing to mark.
  if (input.storedLive.length === 0) {
    return { kind: "refuse", reason: "no_stored_jobs", detail: "no stored live jobs for this board" };
  }

  // The stored jobs this poll did NOT list: the candidate set.
  const absent = input.storedLive.filter((job) => !polled.has(job.fingerprint));
  // Share of what we knew that the poll recognised.
  const overlapShare = (input.storedLive.length - absent.length) / input.storedLive.length;
  // The numbers, formatted once for whichever refusal fires.
  const counts = `stored=${input.storedLive.length} polled=${polled.size} absent=${absent.length}`;

  // Identity drift: the poll does not recognise most of the board. See the constant.
  if (overlapShare < MIN_FINGERPRINT_OVERLAP_SHARE) {
    return { kind: "refuse", reason: "identity_drift", detail: `overlap ${overlapShare.toFixed(2)} < ${MIN_FINGERPRINT_OVERLAP_SHARE}; ${counts}` };
  }
  // Mass disappearance: recognised board, implausibly many closures at once.
  if (absent.length > MASS_DISAPPEARANCE_FLOOR && absent.length / input.storedLive.length > MAX_DISAPPEARANCE_SHARE) {
    return { kind: "refuse", reason: "mass_disappearance", detail: `absent share > ${MAX_DISAPPEARANCE_SHARE}; ${counts}` };
  }
  // Trusted poll, recognised board, plausible churn: mark exactly the absentees.
  return { kind: "mark", ids: absent.map((job) => job.id) };
}

// Keep the FIRST item per fingerprint, preserving order.
//
// WHY THIS LIVES WITH LIVENESS: both are about a board poll's identity set. The
// fingerprint is company+title+location, NOT the board's posting id, so two DIFFERENT
// live postings can share one (10 such pairs on Stripe's live board, 2026-10-05). An
// `ON CONFLICT DO UPDATE` batch holding both fails whole with "cannot affect row a
// second time", which fails the board and hides it from liveness too.
// FIRST, not last: board order is the only stable tie-break we have, and either posting
// maps to the same single row anyway — the row can hold one apply_url, not two.
export function firstPerFingerprint<T>(items: readonly T[], fingerprintOf: (item: T) => string): T[] {
  // Fingerprints already kept.
  const seen = new Set<string>();
  // Filter keeps order; `add` after the check makes the first occurrence win.
  return items.filter((item) => {
    // The key for this item.
    const fp = fingerprintOf(item);
    // A later duplicate is dropped.
    if (seen.has(fp)) return false;
    // First sighting: remember and keep.
    seen.add(fp);
    return true;
  });
}

// One stored job previously marked disappeared on the polled board.
export interface DisappearedJob extends StoredJob {
  // Carried so the caller can write repost_count + 1 without a second read.
  readonly repost_count: number;
}

// Which disappeared jobs this poll lists again. Their disappeared_at is cleared and
// repost_count bumped — a reposting is a stronger hiring signal than a fresh one
// (core_tables.sql, repost_count's comment).
//
// NOT guarded by the drift/mass checks, deliberately: a reappearance is a positive
// MATCH of a stored fingerprint, which a broken poll cannot fabricate by omission. The
// only guard is that the poll itself succeeded, so a refused poll changes nothing at all.
export function planReappearances(input: {
  // Disappeared jobs on this board.
  readonly storedDisappeared: readonly DisappearedJob[];
  // Every fingerprint this poll produced.
  readonly polledFingerprints: readonly string[];
  // Did the fetch and the parse both succeed?
  readonly pollOk: boolean;
}): readonly DisappearedJob[] {
  // A failed poll matched nothing trustworthy; no writes.
  if (!input.pollOk) return [];
  // Set for O(1) membership.
  const polled = new Set(input.polledFingerprints);
  // Exactly the disappeared jobs whose fingerprint is back.
  return input.storedDisappeared.filter((job) => polled.has(job.fingerprint));
}
