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
//
// ─── READER SIDE: HOW A FUNCTION EXCLUDES DISAPPEARED JOBS ─────────────────────────────
//
// Every edge function that reads `applications` with an embedded `jobs(...)` must not act
// on a posting scout-ats marked gone. Disappeared rows are LEFT AT THEIR STATUS (never moved
// to `failed`), so planReappearances below can bring a reposted job back to life; the
// reader's job is to not SELECT them. The supabase-js shape that does that:
//
//     .from("applications")
//     .select("id, jobs!inner (title, ..., disappeared_at)")
//     .is("jobs.disappeared_at", null)
//
// WHY `!inner` IS NOT OPTIONAL. supabase-js does no join logic of its own: `.is()` only
// appends the URL param `jobs.disappeared_at=is.null` (postgrest-js 1.19.4,
// src/PostgrestFilterBuilder.ts:279-280). What that param MEANS is PostgREST's: a filter on
// an embedded column filters the EMBED, not the parent. Without `!inner` the application
// row still comes back with `jobs: null` — a dead job turned into a "missing job", which a
// reader then either fails or, worse, treats as a different problem. With `!inner` the
// embed becomes an inner join and the filter removes the parent row. postgrest-js's own
// types encode the same rule: a non-`!inner` to-one embed is typed `T | null`, an `!inner`
// one plain `T` (src/select-query-parser/result.ts:375-377), and its `.order()` doc says
// ordering by a referenced table "only affects the ordering of the parent table if you use
// `!inner`" (src/PostgrestTransformBuilder.ts:82-83). PostgREST's docs name this
// "Resource Embedding > Top-level Filtering"; not fetched here (no network), so the
// local source above is the citation that was actually read.
//
// THE TRADE-OFF, stated so nobody rediscovers it: `!inner` also drops an application
// whose job row does not join at all. That is acceptable, in fact desired — no job means
// nothing to read — and it is near-impossible anyway: `applications.job_id` is
// `not null references jobs on delete cascade` (core_tables.sql:309), so only RLS hiding
// the job could produce one. The cost is that such a row now sits silently instead of
// being failed as `no_job_joined`. No current reader depends on the left join to SEE
// job-less rows; the normalizer already uses `jobs!inner` (normalizer/index.ts:158).
//
// The query filter is the control; classifyJobLiveness below is defence in depth, for a
// reader whose select forgot the column or the filter. It FAILS CLOSED: a job object
// without the `disappeared_at` KEY is 'unknown', never 'live' (§5).
//
// Index note: `jobs_user_disappeared_idx` is partial `WHERE disappeared_at IS NOT NULL`
// (core_tables.sql:289-290), so it does not serve this IS NULL filter. Fine at today's
// volume; the join is driven by the applications status filter anyway.

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

// THE RECENT-BASIS RULE (leak 3, 2026-11-05). The two guards above judge a poll against the rows
// the PREVIOUS poll saw, not against every stored live row. GitLab's board stored 505 live rows:
// 242 re-sighted every poll and 249 not seen since September. Judged against all 505, a perfectly
// healthy poll overlapped 0.48 < 0.5 and was refused as identity_drift on every one of 197 polls,
// so the 249 dead postings (one of them approved) could never be marked and the backlog only grew.
// The stale rows are not evidence about THIS poll: they were already absent from the last one.
// Once the guards pass on the recent rows, every absent row is marked, the backlog included.
//
// A sighting this long before the recorded poll time still belongs to that poll: scout-ats writes
// both from one clock, but the worker scout reads the clock separately for each.
export const RECENT_SIGHTING_TOLERANCE_MS = 15 * 60_000;

// The recent rows are trusted as the basis only when they account for at least this share of what
// the previous poll listed (company_watchlist.last_poll_job_count). Without it, rows whose
// last_seen_at is wrong (the 2026-10-05 diagnosis) could leave a tiny "recent" set, and a broken
// poll listing exactly those few would pass both guards and mark the whole board dead.
export const MIN_RECENT_SHARE_OF_PREVIOUS_POLL = 0.5;

// Outside the recent basis, a row is marked only when its last sighting is at least this much older
// than the previous poll: a dead BACKLOG, not a row one bad poll lost. Found by the commit-time
// security review (2026-11-05): last_polled_at and last_poll_job_count are written even when liveness
// refuses, so a board that PERSISTENTLY truncates (lists 30 of 240) makes its next poll's basis those
// 30; without this bar the other 210, seen hours earlier, would be marked dead on that second poll.
// 14 days: GitLab's 267-row backlog still clears 182 at once (last seen 2026-09/10, measured
// 2026-11-05) and the rest as they age; a breakage has two weeks of refusals in the log first.
export const STALE_BACKLOG_MIN_AGE_MS = 14 * 24 * 60 * 60_000;

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

// A live stored job plus when a poll last listed it, for the recent-basis rule.
export interface LiveStoredJob extends StoredJob {
  // jobs.last_seen_at; null or unparseable reads as "not seen recently" (it only narrows the basis).
  readonly lastSeenAt: string | null;
}

// The previous successful poll of this board, as company_watchlist recorded it before this poll.
export interface PreviousPoll {
  // company_watchlist.last_polled_at.
  readonly at: string;
  // company_watchlist.last_poll_job_count: how many postings that poll listed.
  readonly jobCount: number;
}

// The facts one board poll hands the planner.
export interface DisappearanceInput {
  // The board's live jobs AS THEY STOOD BEFORE THIS POLL WROTE ANYTHING. Snapshot order
  // matters: read after the inserts, a fingerprint drift would add every posting as a new
  // row, the new rows would "overlap" 100%, and both guards below would pass vacuously.
  readonly storedLive: readonly LiveStoredJob[];
  // Every fingerprint this poll produced. Duplicates are tolerated.
  readonly polledFingerprints: readonly string[];
  // Did the fetch and the parse both succeed?
  readonly pollOk: boolean;
  // Write errors during this poll. Any at all means the poll's view is partial.
  readonly batchErrors: number;
  // The previous poll, or null for a board never polled (or with no count): then the guards judge
  // every stored live row, exactly as before 2026-11-05. Required, so no caller forgets it.
  readonly previousPoll: PreviousPoll | null;
}

// The rows the drift and mass guards judge, and the cut-off for marking a row outside them: the
// rows the previous poll saw, when their timestamps can explain that poll; otherwise every stored
// live row (the pre-2026-11-05 rule) with no cut-off, because then every row is in the basis.
function guardBasis(input: DisappearanceInput): { readonly rows: readonly LiveStoredJob[]; readonly staleBefore: number | null } {
  // No previous poll (the ?? also covers a caller built before this field existed).
  const previous = input.previousPoll ?? null;
  // Its time, parsed once; NaN for anything that is not a date.
  const at = previous === null ? Number.NaN : Date.parse(previous.at);
  // Nothing trustworthy to compare against: the whole set, as before.
  if (previous === null || !Number.isFinite(at) || !Number.isInteger(previous.jobCount) || previous.jobCount <= 0) return { rows: input.storedLive, staleBefore: null };
  // The rows that poll listed: last seen at (or just before) its recorded time.
  const recent = input.storedLive.filter((job) => {
    // Unparseable or null is "not recent"; it can only shrink the basis.
    const seen = job.lastSeenAt === null ? Number.NaN : Date.parse(job.lastSeenAt);
    // Inside the tolerance window of the previous poll, or later.
    return Number.isFinite(seen) && seen >= at - RECENT_SIGHTING_TOLERANCE_MS;
  });
  // Too few to explain the previous poll's count: the timestamps are not trusted. See the constant.
  if (recent.length < previous.jobCount * MIN_RECENT_SHARE_OF_PREVIOUS_POLL) return { rows: input.storedLive, staleBefore: null };
  // The recent rows are the basis; a row outside it is marked only if not seen for 14 days.
  return { rows: recent, staleBefore: at - STALE_BACKLOG_MIN_AGE_MS };
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

  // The stored jobs this poll did NOT list: the candidate set, stale backlog included.
  const absent = input.storedLive.filter((job) => !polled.has(job.fingerprint));
  // What the guards judge: the rows the previous poll saw, when trustworthy (see guardBasis).
  const { rows: basis, staleBefore } = guardBasis(input);
  // The basis rows this poll did not list.
  const absentInBasis = basis.filter((job) => !polled.has(job.fingerprint));
  // Share of the basis the poll recognised.
  const overlapShare = (basis.length - absentInBasis.length) / basis.length;
  // The numbers, formatted once for whichever refusal fires; basis is the guards' denominator.
  const counts = `stored=${input.storedLive.length} basis=${basis.length} polled=${polled.size} absent=${absent.length} absent_in_basis=${absentInBasis.length}`;

  // Identity drift: the poll does not recognise most of the board. See the constant.
  if (overlapShare < MIN_FINGERPRINT_OVERLAP_SHARE) {
    return { kind: "refuse", reason: "identity_drift", detail: `overlap ${overlapShare.toFixed(2)} < ${MIN_FINGERPRINT_OVERLAP_SHARE}; ${counts}` };
  }
  // Mass disappearance: recognised board, implausibly many closures at once.
  if (absentInBasis.length > MASS_DISAPPEARANCE_FLOOR && absentInBasis.length / basis.length > MAX_DISAPPEARANCE_SHARE) {
    return { kind: "refuse", reason: "mass_disappearance", detail: `absent share > ${MAX_DISAPPEARANCE_SHARE}; ${counts}` };
  }
  // The basis rows, by id, for the split below.
  const inBasis = new Set(basis.map((job) => job.id));
  // Trusted poll, recognised board, plausible churn: mark the basis absentees, plus only the OLD
  // stale backlog outside it (see STALE_BACKLOG_MIN_AGE_MS). With no cut-off every row is in the basis.
  const marked = absent.filter((job) => {
    // Absent from a poll the guards just trusted: normal churn, as before.
    if (inBasis.has(job.id)) return true;
    // Outside the basis: only a sighting older than the cut-off; null or unparseable never marks.
    const seen = job.lastSeenAt === null ? Number.NaN : Date.parse(job.lastSeenAt);
    // A cut-off exists whenever a row can be outside the basis.
    return staleBefore !== null && Number.isFinite(seen) && seen < staleBefore;
  });
  // The ids to write.
  return { kind: "mark", ids: marked.map((job) => job.id) };
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

// What a reader may conclude about one embedded job. A closed union rather than a boolean:
// "is it live?" has THREE answers, and a boolean would have to fold 'unknown' into one of
// the other two — which is exactly the fail-open this file exists to prevent.
export type JobLiveness = "live" | "disappeared" | "unknown";

// Classify one embedded `jobs` object, as postgrest returned it.
//
// TAKES `unknown`: the embed is untrusted until shape-checked, and typing it as the happy
// shape would move the check to a cast at the call site, where nobody sees it.
export function classifyJobLiveness(job: unknown): JobLiveness {
  // No object at all (null embed, undefined, an array from a mis-declared relation): we
  // know nothing about liveness, so we must not call it live.
  if (typeof job !== "object" || job === null || Array.isArray(job)) return "unknown";
  // FAIL CLOSED ON AN ABSENT KEY. postgrest omits an unselected column entirely, so a
  // select that forgot `disappeared_at` hands over objects WITHOUT the key, and a
  // `!= null` check would read every one as live. `in` tells "not selected" apart from
  // "selected and null" — the only distinction that stops this passing vacuously.
  if (!("disappeared_at" in job)) return "unknown";
  // Selected and null: scout-ats has not seen it drop off its board. Strict `=== null`
  // because `undefined` (key present, value undefined) is not a value postgrest sends
  // for a live job; it falls through to 'disappeared' rather than to 'live'.
  if ((job as { disappeared_at: unknown }).disappeared_at === null) return "live";
  // Any non-null value means marked gone. The timestamp's format is not second-guessed:
  // a malformed one is still not evidence of liveness, so it errs towards not acting.
  return "disappeared";
}

// The run-level reading: did EVERY row come back without liveness?
//
// True only for a non-empty batch where all are 'unknown'. That shape means the select
// lost the column (or the embed), not that the data is odd: per-row 'unknown' fails each
// row closed, which is right per row and SILENT per run — 100% skipped reads as "nothing
// to do" on the health page. An empty batch is an idle queue and a mixed one proves the
// column arrived for some row, so both are false.
export function allLivenessUnknown(classifications: readonly JobLiveness[]): boolean {
  // `every` on an empty array is true; the length check is what makes idle read as idle.
  return classifications.length > 0 && classifications.every((c) => c === "unknown");
}

// The exact agent_runs.error_detail for an all-unknown batch. One function, so every reader
// that adopts it (today only the Tailor) says the same words and a health-page search for
// it finds every one of them.
// Phrased as the question the reader should go and answer.
export function LIVENESS_UNKNOWN_DETAIL(n: number): string {
  // `n` is the batch size, so the line says how much work the defect silently skipped.
  return `all ${n} rows lacked disappeared_at; is the select missing the column?`;
}
