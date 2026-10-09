// Tests that the Screener's application history counts only COMMITTED applications.
//
// THE BUG THESE PIN. `applications` holds every pipeline row, not just submitted ones:
// the very row being screened sits there at `deduped`. An unfiltered history read put
// that row into its own applied-set (already_applied would drop it) and counted every
// discovered/dropped row toward the weekly cap as if it had been sent. The read was
// also truncated by PostgREST's max_rows, so the filter must run SERVER-side — these
// tests therefore check both the outcome and the exact predicate sent to the server.
import { test } from "node:test";
// Strict, so a missing Map entry (undefined) never compares equal to a number.
import assert from "node:assert/strict";
// The loader, so the assertion is on what the cascade actually receives.
import { loadScreenContext } from "./context.ts";
// A namespace import, so a not-yet-exported constant reads as undefined and fails an
// assertion rather than breaking module linking before any test runs.
import * as supabaseQueries from "./supabase-queries.ts";

// A fixed clock, so "created today" is inside the trailing week by construction.
const NOW = new Date("2026-09-17T12:00:00.000Z");
// Same day as NOW, so every canned row would count toward this week's cap if kept.
const TODAY = "2026-09-17T08:00:00.000Z";

// The canned `applications` rows: one per side of the committed/pipeline line.
const APPLICATION_ROWS = [
  // The row being screened right now. Must never be its own "already applied".
  { status: "deduped", created_at: TODAY, jobs: { fingerprint: "fp-self", company_slug: "acme" } },
  // A genuine submission. The only row that should reach the cascade.
  { status: "applied", created_at: TODAY, jobs: { fingerprint: "fp-applied", company_slug: "acme" } },
  // A screened-out row. Never sent, so it must not count toward the cap.
  { status: "dropped_filter", created_at: TODAY, jobs: { fingerprint: "fp-dropped", company_slug: "acme" } },
];

// The 11 committed statuses written out literally, so the test pins the positive SHAPE
// of the list rather than trusting the constant under test to describe itself.
const EXPECTED_COMMITTED = [
  "approved",
  "applying",
  "blocked_needs_human",
  "needs_verification",
  "applied",
  "employer_screening",
  "oa_pending",
  "interview",
  "offer",
  "rejected",
  "failed",
];

// A client double shaped like supabase-js: `select()` returns an awaitable builder.
// Awaiting it directly yields EVERY canned row (an unfiltered read); `.in()` records its
// arguments and yields only the matching rows, imitating the server-side predicate.
function fakeClient(rowsForApplications: Array<Record<string, unknown>> = APPLICATION_ROWS) {
  // Every `.in()` call, so the test can assert the exact predicate sent.
  const inCalls: Array<[string, readonly string[]]> = [];
  // The client itself; other tables answer empty so only history is under test.
  const client = {
    from(table: string) {
      // Only `applications` carries rows; the other three reads are legitimately empty.
      const rows: Array<Record<string, unknown>> = table === "applications" ? rowsForApplications : [];
      return {
        // `options` is read because the history read asks for `{ count: "exact" }` to
        // detect a max_rows cut; supabase-js answers count null when it was not asked.
        select: (_columns: string, options?: { count?: string }) =>
          // A real Promise (awaitable, like the builder) with `.in()` bolted on.
          Object.assign(Promise.resolve({ data: rows, error: null, count: options?.count === "exact" ? rows.length : null }), {
            in(column: string, values: readonly string[]) {
              // Record before filtering, so the args are assertable even if empty.
              inCalls.push([column, values]);
              // Keep only rows whose column value is in the list, as Postgres would.
              const kept = rows.filter((row) => values.includes(row[column] as string));
              // count is the FILTERED total, as the server counts after the predicate; these
              // fixtures stay under 1000 rows, so count equals data.length (a complete read).
              return Promise.resolve({ data: kept, error: null, count: options?.count === "exact" ? kept.length : null });
            },
          }),
      };
    },
  };
  // Both halves: the client for the code, the recorder for the assertions.
  return { client, inCalls };
}

// Case A: only committed rows reach already_applied and the weekly cap.
test("history excludes pipeline-only rows from applied fingerprints and the weekly cap", async () => {
  // Build the real adapter over the fake, then run the real loader.
  const { client } = fakeClient();
  // The full production path minus the network.
  const result = await loadScreenContext(supabaseQueries.supabaseScreenQueries(client, NOW), NOW);
  // A load failure would make the next assertions meaningless, so fail loudly here.
  assert.equal(result.ok, true);
  // Narrow the union for the compiler; the assert above already guarantees it.
  if (!result.ok) return;
  // The committed row is remembered.
  assert.equal(result.value.context.appliedFingerprints.has("fp-applied"), true);
  // The row being screened is not its own duplicate.
  assert.equal(result.value.context.appliedFingerprints.has("fp-self"), false);
  // A dropped row was never applied to.
  assert.equal(result.value.context.appliedFingerprints.has("fp-dropped"), false);
  // Exactly one application was SENT to acme this week, not three.
  assert.equal(result.value.context.applicationsThisWeekByCompany.get("acme"), 1);
});

// Case B: the predicate is sent to the server, on `status`, with exactly the 11 members.
test("history filters server-side on status with exactly the committed statuses", async () => {
  // A fresh recorder, so Case A's calls cannot leak in.
  const { client, inCalls } = fakeClient();
  // Only the history read issues `.in()`, so call it alone.
  await supabaseQueries.supabaseScreenQueries(client, NOW).applicationHistory();
  // Exactly one filter, on `status`, with the literal list: the positive shape.
  assert.deepEqual(inCalls, [["status", EXPECTED_COMMITTED]]);
  // And it is the exported constant itself, so callers and the query share one source.
  assert.equal(inCalls[0]![1], supabaseQueries.COMMITTED_STATUSES);
});

// Case C: `failed` is reachable BEFORE approval (discovered/deduped/passed_filters/
// scored/tailored → failed; the auditor writes tailored → failed), so `failed` alone does
// not mean "sent". `approved_at` is stamped only on entering `approved`, which makes it
// the witness: never approved → never sent; approved → may have been sent.
test("a failed row counts as applied only if it was ever approved", async () => {
  // One row per side of the approved_at line, on separate companies so the cap is per-row.
  const { client } = fakeClient([
    // Failed in the pipeline, never approved: provably never submitted.
    { status: "failed", approved_at: null, created_at: TODAY, jobs: { fingerprint: "fp-failed-early", company_slug: "early" } },
    // Failed after approval: the submit may have landed, so it must count (fail closed).
    { status: "failed", approved_at: TODAY, created_at: TODAY, jobs: { fingerprint: "fp-failed-late", company_slug: "late" } },
  ]);
  // The full production path minus the network.
  const result = await loadScreenContext(supabaseQueries.supabaseScreenQueries(client, NOW), NOW);
  // A load failure would make the next assertions meaningless.
  assert.equal(result.ok, true);
  // Narrow the union for the compiler; the assert above already guarantees it.
  if (!result.ok) return;
  // Never approved: not an application, so it must not block a re-offer...
  assert.equal(result.value.context.appliedFingerprints.has("fp-failed-early"), false);
  // ...and must not be charged against its company's weekly cap.
  assert.equal(result.value.context.applicationsThisWeekByCompany.get("early"), undefined);
  // Approved, then failed: possibly submitted, so it stays in the applied-set.
  assert.equal(result.value.context.appliedFingerprints.has("fp-failed-late"), true);
});

// --- the weekly cap is windowed on COMMIT time, not discovery time -------------------
//
// `created_at` is when the scout DISCOVERED the job. The cap limits how many applications
// Teja SENDS per company per week, so it must window on applied_at ?? approved_at (both
// stamped only by the status-transition trigger). A job discovered ten days ago and
// approved today is this week's application.

// Ten days before NOW: outside the trailing week by three days, so no boundary ambiguity.
const TEN_DAYS_AGO = "2026-09-07T12:00:00.000Z";

// Run one row through the real adapter and loader; return that company's weekly count.
async function weeklyCountFor(row: Record<string, unknown>): Promise<number | undefined> {
  // One row, company "co", so the count is attributable to this row alone.
  const { client } = fakeClient([{ ...row, jobs: { fingerprint: "fp-co", company_slug: "co" } }]);
  // The full production path minus the network.
  const result = await loadScreenContext(supabaseQueries.supabaseScreenQueries(client, NOW), NOW);
  // A load failure would make the count meaningless, so fail on it here.
  assert.equal(result.ok, true);
  // Narrow the union; undefined is never a valid count, so it cannot mask a failure.
  return result.ok ? result.value.context.applicationsThisWeekByCompany.get("co") : undefined;
}

// (a) Discovered long ago, approved today: this week's commitment.
test("a job discovered 10 days ago but approved today counts toward this week's cap", async () => {
  // Only approved_at is set; applied_at is null because it is not submitted yet.
  assert.equal(await weeklyCountFor({ status: "approved", created_at: TEN_DAYS_AGO, approved_at: TODAY, applied_at: null }), 1);
});

// (b) A committed row with no stamp at all: the commit time is unknown, so it counts.
test("a committed row with neither approved_at nor applied_at counts toward the cap (fail closed)", async () => {
  // Both stamps null on an `applied` row: not supposed to exist, so it must not escape the cap.
  assert.equal(await weeklyCountFor({ status: "applied", created_at: TEN_DAYS_AGO, approved_at: null, applied_at: null }), 1);
});

// (c) The window still excludes genuinely old commitments.
test("a job approved and applied 10 days ago does not count toward this week's cap", async () => {
  // Both stamps old: a past week's application, so the cap must not charge it now.
  assert.equal(
    await weeklyCountFor({ status: "applied", created_at: TEN_DAYS_AGO, approved_at: TEN_DAYS_AGO, applied_at: TEN_DAYS_AGO }),
    undefined,
  );
});

// (d) A malformed stamp. `Date.parse("-5")` is year -5, which a lenient check would
// call "long ago" and drop from the window; the shape check makes it count instead.
test("a malformed commit stamp counts toward the cap rather than reading as long ago", async () => {
  // "-5" parses (to year -5) but is not a timestamp; it must not leave the window.
  assert.equal(await weeklyCountFor({ status: "approved", created_at: TEN_DAYS_AGO, approved_at: "-5", applied_at: null }), 1);
});
