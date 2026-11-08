// Tests for the tracker's replay sweep (W6, 2026-11-01): the I/O glue around replayQueue.
// The bug lived in glue (moves tried once, errors only logged), so the glue is what is tested.
import { test } from "node:test";
// Strict equality so null and undefined stay distinct.
import assert from "node:assert/strict";
// Unit under test, plus its two bounds so the tests read them instead of copying numbers.
import { HISTORY_PAGE_SIZE, ID_CHUNK_SIZE, MAX_HISTORY_PAGES, REPLAY_WINDOW, replayStoredMoves } from "./replay.ts";
// The decision shape a fresh email carries, for the evidence-enrichment case.
import type { MessageDecision } from "./decide.ts";

// What supabase-js resolves a query to: data or error, never a throw (CLAUDE.md §5).
type Result = { data: unknown; error: { message: string } | null };

// A canned answer: one Result, or one per query, decided from that query's recorded filters
// (Review #3: a paged read must be able to fail on its SECOND page).
type Canned = Result | ((filters: Record<string, unknown>) => Result);

// A supabase-js double. Every chain method returns the builder; awaiting it resolves the
// canned Result for that table. application_events is read twice, told apart by event_type.
// `.range(from, to)` slices an array answer the way PostgREST pages one (Review #3).
function fakeDb(canned: {
  apps?: Canned;
  emails?: Canned;
  notes?: Canned;
  stageMoves?: Canned;
  // The first-approval read the re-match uses (2026-11-04); told apart by its to_status filter.
  approvals?: Canned;
  // What an email_events UPDATE (the re-match link) resolves to; success when unset.
  updateError?: { message: string } | null;
  rpcError?: { message: string } | null;
}) {
  // Every RPC call's arguments, and every query's recorded filters, for the assertions.
  const calls = { rpc: [] as Record<string, unknown>[], queries: [] as { table: string; filters: Record<string, unknown> }[] };
  // Empty-but-successful by default, so each test sets only what it is about.
  const ok = (data: unknown): Result => ({ data, error: null });
  // The query builder for one from(table) call.
  const from = (table: string) => {
    // Filters recorded as "op:column" -> value.
    const filters: Record<string, unknown> = {};
    // Recorded once, when the query is built.
    calls.queries.push({ table, filters });
    // The canned answer for this table, before paging.
    const answer = (): Canned => {
      // The tracked-applications read.
      if (table === "applications") return canned.apps ?? ok([]);
      // The stored-emails read.
      if (table === "email_events") return canned.emails ?? ok([]);
      // The tracker's own move notes.
      if (filters["eq:event_type"] === "note") return canned.notes ?? ok([]);
      // The re-match's first-approval read: status_change rows INTO approved.
      if (filters["eq:to_status"] === "approved") return canned.approvals ?? ok([]);
      // Everything else on application_events is the stage-move read.
      return canned.stageMoves ?? ok([]);
    };
    // Which canned result this query resolves to, paged when the query asked for a range.
    const pick = (): Result => {
      // An UPDATE resolves { error } only, as supabase-js does without .select().
      if (filters.update !== undefined) return { data: null, error: canned.updateError ?? null };
      // A per-query answer sees the filters, range included.
      const raw = answer();
      // Resolved to one Result.
      const result = typeof raw === "function" ? raw(filters) : raw;
      // The rows PostgREST would return for [from, to], inclusive, when a range was asked for.
      const range = filters.range as [number, number] | undefined;
      // Unpaged queries, errors and non-array data come back as canned.
      if (range === undefined || !Array.isArray(result.data)) return result;
      // One page.
      return { data: result.data.slice(range[0], range[1] + 1), error: result.error };
    };
    // A thenable builder, the shape supabase-js's PostgrestFilterBuilder has.
    const builder = {
      // Projection is not modelled.
      select: () => builder,
      // Recorded so a test can pin which rows the read asks for.
      in: (column: string, values: unknown) => ((filters[`in:${column}`] = values), builder),
      // `.is(column, null)`: the re-match's "still unmatched" filter, read and write alike.
      is: (column: string, value: unknown) => ((filters[`is:${column}`] = value), builder),
      // An UPDATE's payload, recorded so a test can assert exactly what was written.
      update: (payload: unknown) => ((filters.update = payload), builder),
      // Same.
      eq: (column: string, value: unknown) => ((filters[`eq:${column}`] = value), builder),
      // Order recorded for the window test, plus the SEQUENCE of order calls, because which
      // column sorts first (not just which columns appear) decides the plan (2026-11-08).
      order: (column: string, options: unknown) => {
        // Keyed by column, as the window test reads it.
        filters[`order:${column}`] = options;
        // Appended in call order: [column, options] pairs, first sort key first.
        filters.orders = [...((filters.orders as unknown[] | undefined) ?? []), [column, options]];
        // Chainable, like the real builder.
        return builder;
      },
      // The bound, recorded.
      limit: (n: number) => ((filters.limit = n), builder),
      // A page, recorded and applied by pick().
      range: (from: number, to: number) => ((filters.range = [from, to]), builder),
      // Awaiting the builder runs the "query": resolve, never reject.
      then: (resolve: (value: Result) => unknown) => Promise.resolve(pick()).then(resolve),
    };
    // The builder is the query.
    return builder;
  };
  // The RPC: records its arguments; resolves the canned error or success.
  const rpc = (name: string, args: Record<string, unknown>) => {
    // Recorded with the function name so a wrong RPC is visible.
    calls.rpc.push({ name, ...args });
    // { error } on refusal, exactly as supabase-js reports a 409 or 42501.
    return Promise.resolve({ data: null, error: canned.rpcError ?? null });
  };
  // Cast at the boundary: the double implements only what replay.ts calls.
  return { db: { from, rpc } as unknown as Parameters<typeof replayStoredMoves>[0], calls };
}

// A tracked application row as the applications read returns it.
const APPLIED = { id: "a1", status: "applied" };
// A stored, matched, confident rejection whose move never happened.
const STORED_REJECTION = { id: "e1", provider_message_id: "m1", matched_application_id: "a1", classification: "rejection", classification_confidence: 0.95, received_at: "2026-11-01T10:00:00+00:00" };
// No fresh decisions from this call: a pure replay.
const NO_LIVE = new Map<string, MessageDecision>();

test("W6: a stored rejection whose move never happened is re-driven", async () => {
  // The kill-switch-paused (or refused) move from an earlier call.
  const { db, calls } = fakeDb({ apps: { data: [APPLIED], error: null }, emails: { data: [STORED_REJECTION], error: null } });
  // Switch on.
  const result = await replayStoredMoves(db, true, NO_LIVE);
  // Moved once, nothing wrong.
  assert.deepEqual(result, { moved: 1, errors: [] });
  // Through the one correct RPC, as the tracker, to the mapped status.
  assert.equal(calls.rpc.length, 1);
  // The arguments the database guard checks.
  const call = calls.rpc[0]!;
  // Function, row, target, agent.
  assert.deepEqual([call.name, call.p_application_id, call.p_to_status, call.p_agent], ["advance_application_status", "a1", "rejected", "tracker"]);
  // The detail carries provider_message_id: the note it becomes is the replay's done-marker.
  assert.equal((call.p_detail as Record<string, unknown>).provider_message_id, "m1");
  // And names the stored row, for a human audit.
  assert.equal((call.p_detail as Record<string, unknown>).email_event_id, "e1");
  // The emails read asks only for matched rows of tracked applications, move classifications only.
  // The MATCHED read, told apart from the re-match's unmatched read (2026-11-04) by its filter.
  const emailsQuery = calls.queries.find((query) => query.table === "email_events" && query.filters["in:matched_application_id"] !== undefined)!;
  // Matched to the tracked rows.
  assert.deepEqual(emailsQuery.filters["in:matched_application_id"], ["a1"]);
  // Newest first, bounded.
  assert.deepEqual([emailsQuery.filters["order:received_at"], emailsQuery.filters.limit], [{ ascending: false }, REPLAY_WINDOW]);
});

test("W6: a fresh email's move keeps its classifier evidence in the detail", async () => {
  // The same email, decided in THIS call: its signals and reasoning are in memory.
  const live = new Map<string, MessageDecision>([["m1", { classification: "rejection", confidence: 0.95, matchedSignals: ["regret_to_inform"], reasoning: "explicit rejection", senderDomain: null }]]);
  // Same rows as above.
  const { db, calls } = fakeDb({ apps: { data: [APPLIED], error: null }, emails: { data: [STORED_REJECTION], error: null } });
  // Switch on.
  await replayStoredMoves(db, true, live);
  // The note shape the first-try path always wrote.
  const detail = calls.rpc[0]!.p_detail as Record<string, unknown>;
  // Signals and reasoning ride along.
  assert.deepEqual([detail.matched_signals, detail.reasoning], [["regret_to_inform"], "explicit rejection"]);
});

test("W6: an email the tracker already moved on is not moved again", async () => {
  // The tracker's note for m1 exists: the move committed.
  const { db, calls } = fakeDb({ apps: { data: [APPLIED], error: null }, emails: { data: [STORED_REJECTION], error: null }, notes: { data: [{ provider_message_id: "m1" }], error: null } });
  // Switch on.
  const result = await replayStoredMoves(db, true, NO_LIVE);
  // Nothing to do, nothing wrong.
  assert.deepEqual(result, { moved: 0, errors: [] });
  // No RPC at all.
  assert.equal(calls.rpc.length, 0);
});

test("W6: a refused move is a run error, not a log line", async () => {
  // The database refuses (e.g. 42501 without the agent key, or a concurrent move).
  const { db } = fakeDb({ apps: { data: [APPLIED], error: null }, emails: { data: [STORED_REJECTION], error: null }, rpcError: { message: "agent tracker requires a valid x-applyy-agent-key header" } });
  // Switch on.
  const result = await replayStoredMoves(db, true, NO_LIVE);
  // Not moved.
  assert.equal(result.moved, 0);
  // Counted, so Health shows "succeeded with 1 error" instead of green.
  assert.equal(result.errors.length, 1);
  // And it names the row and the reason.
  assert.match(result.errors[0]!, /a1.*rejected.*agent-key/);
});

test("W6: the kill switch off moves nothing; unreadable moves nothing and is an error", async () => {
  // Off: a deliberate pause, so no error and no reads at all.
  const off = fakeDb({ apps: { data: [APPLIED], error: null }, emails: { data: [STORED_REJECTION], error: null } });
  // Off.
  assert.deepEqual(await replayStoredMoves(off.db, false, NO_LIVE), { moved: 0, errors: [] });
  // Not a single query or RPC.
  assert.deepEqual([off.calls.queries.length, off.calls.rpc.length], [0, 0]);
  // Unreadable: fail closed (no move) AND visible (an error).
  const unreadable = fakeDb({ apps: { data: [APPLIED], error: null }, emails: { data: [STORED_REJECTION], error: null } });
  // Null is "could not read".
  const result = await replayStoredMoves(unreadable.db, null, NO_LIVE);
  // No move, one error.
  assert.deepEqual([result.moved, result.errors.length, unreadable.calls.rpc.length], [0, 1, 0]);
});

test("W6: unreadable or truncated move history never becomes 'move anyway'", async () => {
  // The notes read fails: every email would look pending, so nothing may move.
  const notesDown = fakeDb({ apps: { data: [APPLIED], error: null }, emails: { data: [STORED_REJECTION], error: null }, notes: { data: null, error: { message: "boom" } } });
  // Refused, with an error.
  const a = await replayStoredMoves(notesDown.db, true, NO_LIVE);
  // No RPC, one error.
  assert.deepEqual([a.moved, a.errors.length, notesDown.calls.rpc.length], [0, 1, 0]);
  // The stage-move read fails: a human move could make the email stale, so nothing may move.
  const stagesDown = fakeDb({ apps: { data: [APPLIED], error: null }, emails: { data: [STORED_REJECTION], error: null }, stageMoves: { data: null, error: { message: "boom" } } });
  // Refused, with an error.
  const b = await replayStoredMoves(stagesDown.db, true, NO_LIVE);
  // No RPC, one error.
  assert.deepEqual([b.moved, b.errors.length, stagesDown.calls.rpc.length], [0, 1, 0]);
  // Review #3: a history read that fails on a LATER page is the same refusal, not "page 1 was enough".
  const full = Array.from({ length: HISTORY_PAGE_SIZE }, () => ({ provider_message_id: "other" }));
  // Page 1 succeeds in full; page 2 errors.
  const secondPageDown = (filters: Record<string, unknown>): Result => ((filters.range as number[] | undefined)?.[0] ?? 0) === 0 ? { data: full, error: null } : { data: null, error: { message: "boom on page 2" } };
  // Same rows plus that notes read.
  const truncated = fakeDb({ apps: { data: [APPLIED], error: null }, emails: { data: [STORED_REJECTION], error: null }, notes: secondPageDown });
  // Refused, with an error.
  const c = await replayStoredMoves(truncated.db, true, NO_LIVE);
  // No RPC, one error naming the read.
  assert.deepEqual([c.moved, c.errors.length, truncated.calls.rpc.length], [0, 1, 0]);
});

test("W6: an email for a needs_verification row waits, then moves once a human sets applied", async () => {
  // While the row sits in the human-review lane, the stored match is kept but not acted on.
  const waiting = fakeDb({ apps: { data: [{ id: "a1", status: "needs_verification" }], error: null }, emails: { data: [STORED_REJECTION], error: null } });
  // No move, and waiting is not an error.
  assert.deepEqual(await replayStoredMoves(waiting.db, true, NO_LIVE), { moved: 0, errors: [] });
  // Teja verified the submit and set applied: the next run applies the rejection.
  const resolved = fakeDb({ apps: { data: [APPLIED], error: null }, emails: { data: [STORED_REJECTION], error: null } });
  // Moved.
  assert.deepEqual(await replayStoredMoves(resolved.db, true, NO_LIVE), { moved: 1, errors: [] });
  // To rejected.
  assert.equal(resolved.calls.rpc[0]!.p_to_status, "rejected");
});

test("W6: a full replay window is reported, so a backlog is never silent", async () => {
  // A page of REPLAY_WINDOW rows means older ones may exist beyond it.
  const page = Array.from({ length: REPLAY_WINDOW }, () => ({}));
  // Shape-invalid rows: they also prove a malformed row is skipped, not moved.
  const { db, calls } = fakeDb({ apps: { data: [APPLIED], error: null }, emails: { data: page, error: null } });
  // Switch on.
  const result = await replayStoredMoves(db, true, NO_LIVE);
  // One error naming the window, and nothing moved.
  assert.deepEqual([result.moved, result.errors.length, calls.rpc.length], [0, 1, 0]);
  // The message says what happened.
  assert.match(result.errors[0]!, /window/);
});

// ---- Review #3 (2026-11-02): reads scale with tracked rows instead of refusing ----
//
// The sweep scoped every read with ONE `.in(column, ids)` over every tracked row (applied rows
// only pile up), so the URL grew without bound, and a history read that hit 1000 rows refused
// every move. Now ids go in bounded chunks and history is paged until an empty page.

// N tracked applied rows, ids a0..a{N-1}.
const tracked = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, status: "applied" }));

test("Review #3: tracked ids are sent in bounded chunks that together cover every row", async () => {
  // Two and a half chunks' worth of tracked rows.
  const rows = tracked(ID_CHUNK_SIZE * 2 + ID_CHUNK_SIZE / 2);
  // Nothing stored: only the reads matter here.
  const { db, calls } = fakeDb({ apps: { data: rows, error: null } });
  // Switch on.
  const result = await replayStoredMoves(db, true, NO_LIVE);
  // Nothing to move, nothing wrong.
  assert.deepEqual(result, { moved: 0, errors: [] });
  // Every id-scoped filter the sweep sent, per read.
  for (const [table, column] of [["email_events", "in:matched_application_id"], ["application_events", "in:application_id"]] as const) {
    // The id lists of this read's queries.
    const lists = calls.queries.filter((query) => query.table === table && query.filters[column] !== undefined).map((query) => query.filters[column] as string[]);
    // No single filter is longer than the chunk bound.
    assert.ok(lists.every((list) => list.length <= ID_CHUNK_SIZE), `${table}: a filter exceeded ${ID_CHUNK_SIZE} ids`);
    // Together they name every tracked row (the notes and stage reads each cover them all).
    assert.deepEqual([...new Set(lists.flat())].sort(), rows.map((row) => row.id).sort(), table);
  }
});

test("Review #3: a done-marker on the second history page is honoured, not refused", async () => {
  // A full first page of unrelated notes, then the note that marks m1 as already moved.
  const notes = [...Array.from({ length: HISTORY_PAGE_SIZE }, () => ({ provider_message_id: "other" })), { provider_message_id: "m1" }];
  // The stored rejection whose move already committed.
  const { db, calls } = fakeDb({ apps: { data: [APPLIED], error: null }, emails: { data: [STORED_REJECTION], error: null }, notes: { data: notes, error: null } });
  // Switch on.
  const result = await replayStoredMoves(db, true, NO_LIVE);
  // Not refused (the old cap), and not moved again (page 2 was read).
  assert.deepEqual([result, calls.rpc.length], [{ moved: 0, errors: [] }, 0]);
});

test("Review #3: a history longer than the page cap is refused, never read forever", async () => {
  // One row more than MAX_HISTORY_PAGES full pages.
  const huge = Array.from({ length: HISTORY_PAGE_SIZE * MAX_HISTORY_PAGES + 1 }, () => ({ provider_message_id: "other" }));
  // A pending email beside it.
  const { db, calls } = fakeDb({ apps: { data: [APPLIED], error: null }, emails: { data: [STORED_REJECTION], error: null }, notes: { data: huge, error: null } });
  // Switch on.
  const result = await replayStoredMoves(db, true, NO_LIVE);
  // Fail closed: no move, one error.
  assert.deepEqual([result.moved, result.errors.length, calls.rpc.length], [0, 1, 0]);
});

test("Review #3: an email outside the first id chunk is still replayed, oldest first", async () => {
  // Two chunks of tracked rows.
  const rows = tracked(ID_CHUNK_SIZE * 2);
  // A pending rejection for a row in the FIRST chunk; the older email.
  const older = { ...STORED_REJECTION, id: "e-old", provider_message_id: "m-old", matched_application_id: "a0", received_at: "2026-11-01T09:00:00+00:00" };
  // The newer one, for a row in the SECOND chunk.
  const newer = { ...STORED_REJECTION, id: "e-new", provider_message_id: "m-new", matched_application_id: `a${ID_CHUNK_SIZE}`, received_at: "2026-11-01T11:00:00+00:00" };
  // Each email query answers only the rows its chunk asked for, as PostgREST would.
  const emails = (filters: Record<string, unknown>): Result => ({ data: [older, newer].filter((row) => (filters["in:matched_application_id"] as string[]).includes(row.matched_application_id)), error: null });
  // Both stored.
  const { db, calls } = fakeDb({ apps: { data: rows, error: null }, emails });
  // Switch on.
  const result = await replayStoredMoves(db, true, NO_LIVE);
  // Both moved: an email outside the first chunk is not lost.
  assert.deepEqual(result, { moved: 2, errors: [] });
  // Oldest first, the order the employer sent them.
  assert.deepEqual(calls.rpc.map((call) => call.p_application_id), ["a0", `a${ID_CHUNK_SIZE}`]);
});

// ---- Re-match (2026-11-04): unmatched stored emails are linked once their row is tracked ----
//
// Live: 0 of 106 emails ever linked. Bjak's receipt (10-29) arrived while its row sat in
// blocked_needs_human; a human set applied on 11-01; the ingest-time match never ran again.

// The Bjak row as the applications read returns it, joined job included.
const BJAK_ROW = { id: "bjak-1", status: "applied", jobs: { company_name: "Bjak", company_slug: "bjak", title: "Software Engineer" } };
// Its first approval, 2026-10-24 13:44 IST: five days before the receipt.
const BJAK_APPROVED = { application_id: "bjak-1", created_at: "2026-10-24T08:14:13+00:00" };
// The live receipt as email_events holds it: stored, classified, never matched.
const BJAK_UNMATCHED = { id: "e-bjak", provider_message_id: "1a186f32ebc6fc08", matched_application_id: null, from_address: "Bjak Talent Acquisition Team <no-reply@ashbyhq.com>", subject: "We’ve Received Your Application", snippet: "", classification: "application_received", classification_confidence: 0.9, received_at: "2026-10-29T09:17:26+00:00" };
// The unmatched read (it filters `is matched_application_id null`) sees the receipt; the matched read sees nothing.
const unmatchedOnly = (filters: Record<string, unknown>): Result => ({ data: filters["is:matched_application_id"] === null ? [BJAK_UNMATCHED] : [], error: null });

test("links a stored unmatched email once its company's row enters a tracked status", async () => {
  // The live Bjak state.
  const { db, calls } = fakeDb({ apps: { data: [BJAK_ROW], error: null }, approvals: { data: [BJAK_APPROVED], error: null }, emails: unmatchedOnly });
  // Switch on.
  const result = await replayStoredMoves(db, true, NO_LIVE);
  // Nothing moved, nothing wrong.
  assert.deepEqual(result, { moved: 0, errors: [] });
  // Exactly one write: the link, guarded so a row matched meanwhile is never re-pointed.
  const writes = calls.queries.filter((query) => query.filters.update !== undefined);
  // One update, on the stored receipt, only while it is still unmatched; link only, since its stored body is empty (redacted) and the stored verdict stands (Q3).
  assert.deepEqual(writes.map((w) => [w.table, w.filters.update, w.filters["eq:id"], w.filters["is:matched_application_id"]]), [["email_events", { matched_application_id: "bjak-1" }, "e-bjak", null]]);
  // A receipt maps to no status: Bjak is linked as application_received with NO status move.
  assert.equal(calls.rpc.length, 0);
});

// Q3 (2026-11-05): the live HackerRank receipt (f34b7156) was stored as oa_invite by the classifier of
// its day; the classifier now reads it as application_received. Linked with the old verdict, the replay
// would drive applied -> oa_pending from a receipt, so the re-match writes TODAY's verdict with the link.
const HACKERRANK_ROW = { id: "hr-1", status: "applied", jobs: { company_name: "HackerRank", company_slug: "hackerrank", title: "AI Researcher Intern" } };
// Its first approval, the day before the email arrived.
const HACKERRANK_APPROVED = { application_id: "hr-1", created_at: "2026-11-03T10:00:00+00:00" };
// The stored row: text kept (it was classified, so W33 never redacted it), verdict stale.
const HACKERRANK_STALE = { id: "e-hr", provider_message_id: "f34b7156", matched_application_id: null, from_address: "no-reply@hackerrankcareers.com", subject: "Exciting News: We have received your Application || AI Researcher Intern || HackerRank", snippet: "Hi Teja, We greatly appreciate your interest in AI Researcher Intern role at HackerRank. Your application has been received. If you are shortlisted, you will receive a take-home assignment as the next step in the process.", classification: "oa_invite", classification_confidence: 1, received_at: "2026-11-04T19:19:00+00:00" };

test("a re-match re-runs the classifier on the re-linked email", async () => {
  // Only the unmatched read sees the stale row, as with Bjak above.
  const { db, calls } = fakeDb({ apps: { data: [HACKERRANK_ROW], error: null }, approvals: { data: [HACKERRANK_APPROVED], error: null }, emails: (filters) => ({ data: filters["is:matched_application_id"] === null ? [HACKERRANK_STALE] : [], error: null }) });
  // Switch on.
  const result = await replayStoredMoves(db, true, NO_LIVE);
  // Linked cleanly.
  assert.deepEqual(result, { moved: 0, errors: [] });
  // The one write.
  const writes = calls.queries.filter((query) => query.filters.update !== undefined);
  // The link carries the fresh verdict, not the stored oa_invite (the classifier fixed on 11-05).
  assert.deepEqual(writes.map((w) => (w.filters.update as Record<string, unknown>).classification), ["application_received"]);
  // A receipt maps to no status: nothing moves.
  assert.equal(calls.rpc.length, 0);
});

test("re-match: a link write that fails is a run error, never a crash", async () => {
  // Same state; the UPDATE is refused.
  const { db } = fakeDb({ apps: { data: [BJAK_ROW], error: null }, approvals: { data: [BJAK_APPROVED], error: null }, emails: unmatchedOnly, updateError: { message: "permission denied" } });
  // Switch on.
  const result = await replayStoredMoves(db, true, NO_LIVE);
  // Counted on the run row, naming the email and the reason.
  assert.deepEqual([result.moved, result.errors.length], [0, 1]);
  // Named.
  assert.match(result.errors[0]!, /e-bjak.*permission denied/);
});

// THE RED-ON-REVERT TEST (2026-11-08): the tracked-applications read must sort by created_at
// first and id second. Reverting to order("id") alone puts Postgres back on a full walk of
// applications_pkey under RLS (938 ms and 36,160 buffers per page, measured), so this pins
// the exact sort sequence, not just "some order exists".
test("replay: the applications read orders by created_at, then id as the unique tiebreak", async () => {
  // One tracked row is enough to make the read run; nothing else is under test here.
  const { db, calls } = fakeDb({ apps: { data: [APPLIED], error: null } });
  // Switch on, so the sweep reads at all.
  await replayStoredMoves(db, true, NO_LIVE);
  // Every page of the applications read, in the order they were sent.
  const appReads = calls.queries.filter((q) => q.table === "applications");
  // Paged until empty: page 1 holds the row, page 2 proves the read is complete.
  assert.equal(appReads.length, 2);
  // Each page sorts identically, or the pages would not line up.
  for (const read of appReads) {
    // created_at first, then id: a total order, because id is unique.
    assert.deepEqual(read.filters.orders, [["created_at", { ascending: true }], ["id", { ascending: true }]]);
  }
});
