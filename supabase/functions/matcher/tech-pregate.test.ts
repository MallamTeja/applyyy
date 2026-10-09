// Tests for the matcher pre-gate: stage 0 re-applied to a passed_filters row BEFORE the
// matcher spends a Gemini call on it.
//
// WHY IT EXISTS: Teja's 2026-10-09 ruling (option (d)) amending the 2026-09-17 design: with
// titles or keywords configured, a non-match is a drop (tech_gate_unclassified); pass+warn
// only when both are empty. The screener applies that to new rows; the pre-gate applies it
// to the backlog already sitting at passed_filters, so those rows cost zero Gemini calls.
//
// Stateful fake of one applications row plus the status RPC, copied in approach from
// write-score.test.ts's fakeRow(): like supabase-js it never throws, every failure is `{ error }`.
import { test } from "node:test";
// Strict, so null and undefined are not conflated.
import assert from "node:assert/strict";
// Units under test.
import { preGateRow, withTechPreGate, type PreGateOutcome } from "./tech-pregate.ts";
// The shared config type, so a fixture cannot drift from what the gate reads.
import type { TechGatePreferences } from "../_shared/screen/tech-gate.ts";
// The client shape the fake must satisfy.
import type { MatchScoreClient } from "./write-score.ts";

// A configured gate: titles AND keywords set, so a non-match drops as unclassified.
const PREFS: TechGatePreferences = {
  titles: ["software engineer"],
  keywords: ["react"],
  excludedKeywords: ["sales"],
};

// Nothing configured: the only config under which a non-match still passes.
const EMPTY: TechGatePreferences = { titles: [], keywords: [], excludedKeywords: [] };

// A non-engineering posting matching no PREFS title or keyword, the 99.6% case Teja measured.
const PARTNERSHIPS = { title: "Partnerships Lead", descriptionRaw: "Grow our channel partners." };

// A posting PREFS recognises by title.
const ENGINEER = { title: "Senior Software Engineer", descriptionRaw: null };

// One applications row plus the RPC, modelling the live semantics (migration 20261008160000):
// the write applies only when every .eq() filter matches, set_updated_at bumps the stamp,
// the PT409 stale-stamp gate runs before the same-status no-op, and a move appends an event.
function fakeRow(opts: { status?: string; writeError?: string } = {}) {
  // The row as the database holds it; the stamp is a counter so every write changes it.
  const row: Record<string, unknown> = {
    id: "a1",
    // Defaults to the matcher's input status; a test overrides it to model a row already moved.
    status: opts.status ?? "passed_filters",
    match_score: null,
    drop_reason: null,
    updated_at: "t0",
  };
  // Monotonic stamp source, standing in for set_updated_at's now().
  let tick = 0;
  // Every update payload attempted, so "no write happened" is assertable.
  const updates: Array<Record<string, unknown>> = [];
  // The application_events the RPC appends, so detail can be compared to the column.
  const events: Array<{ to: string; detail: Record<string, unknown> }> = [];
  // Every RPC call's args, so a test can check the agent and the stamp.
  const rpcArgs: Array<Record<string, unknown>> = [];
  const db: MatchScoreClient = {
    from(_table) {
      return {
        update(values) {
          // Recorded on attempt, before the WHERE is evaluated.
          updates.push(values);
          // Filters collected so the write applies only when ALL of them match, as SQL does.
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(column: string, value: string) {
              // Recorded; evaluated when the chain ends.
              filters.push([column, value]);
              return builder;
            },
            select(columns: string) {
              // A transport/DB failure comes back as { error }, never a throw.
              if (opts.writeError) return Promise.resolve({ data: null, error: { message: opts.writeError } });
              // A WHERE that matches nothing updates nothing and returns no rows.
              if (!filters.every(([c, v]) => row[c] === v)) return Promise.resolve({ data: [], error: null });
              // Apply the payload, then bump the stamp exactly as the trigger would.
              Object.assign(row, values, { updated_at: `t${++tick}` });
              // Return only the asked-for columns, so a select that forgets updated_at shows up.
              const out = Object.fromEntries(columns.split(",").map((c) => [c.trim(), row[c.trim()]]));
              return Promise.resolve({ data: [out], error: null });
            },
          };
          return builder;
        },
      };
    },
    rpc(_fn, args) {
      // Kept for assertions on what the caller sent.
      rpcArgs.push(args);
      // THE STALE-STAMP GATE, first, as in the live function.
      if (args.p_expected_updated_at != null && args.p_expected_updated_at !== row.updated_at) {
        return Promise.resolve({ error: { code: "PT409", message: "application a1 changed since it was read" } });
      }
      // Same-status call: a silent no-op in the live function.
      if (row.status === args.p_to_status) return Promise.resolve({ error: null });
      // Only the matcher's edges out of passed_filters exist; anything else is illegal.
      if (row.status !== "passed_filters") {
        return Promise.resolve({ error: { code: "42501", message: `illegal ${row.status} -> ${args.p_to_status}` } });
      }
      // Move the row, bump the stamp, witness the move with its detail.
      Object.assign(row, { status: args.p_to_status, updated_at: `t${++tick}` });
      // The event is what Health and the audit trail read, so it must agree with the column.
      events.push({ to: String(args.p_to_status), detail: args.p_detail as Record<string, unknown> });
      return Promise.resolve({ error: null });
    },
  };
  return { db, row, updates, events, rpcArgs };
}

// --- preGateRow ------------------------------------------------------------------------

test("pre-gate: a configured non-match is dropped as tech_gate_unclassified, column and event agreeing", async () => {
  // A passed_filters row the gate rejects.
  const { db, row, events, rpcArgs } = fakeRow();
  const outcome = await preGateRow(db, "a1", PARTNERSHIPS, PREFS);
  // The outcome names the code, so the caller can count these drops apart.
  assert.equal(outcome.kind, "dropped");
  // Narrowed so the code is readable.
  assert.equal(outcome.kind === "dropped" && outcome.code, "tech_gate_unclassified");
  // The row moved through the matcher's legal drop edge.
  assert.equal(row.status, "dropped_filter");
  // drop_reason carries the gate's code, as the screener writes it.
  assert.equal(row.drop_reason, "tech_gate_unclassified");
  // Nothing was scored, so match_score stays null.
  assert.equal(row.match_score, null);
  // Exactly one witnessed move.
  assert.equal(events.length, 1);
  // The event's reason matches the column it sits on.
  assert.equal(events[0].detail.reason, "tech_gate_unclassified");
  // And says which stage dropped it, so Health can tell a pre-gate drop from a screener drop.
  assert.equal(events[0].detail.stage, "matcher_pre_gate");
  // The matcher is the acting agent: it owns passed_filters -> dropped_filter.
  assert.equal(rpcArgs[0].p_agent, "matcher");
  // The move was stamp-guarded with our own write's stamp (t1, the first bump).
  assert.equal(rpcArgs[0].p_expected_updated_at, "t1");
});

test("pre-gate: a title match continues with no update and no rpc", async () => {
  // A recognised posting.
  const { db, row, updates, rpcArgs } = fakeRow();
  // The gate has no objection.
  assert.deepEqual(await preGateRow(db, "a1", ENGINEER, PREFS), { kind: "continue" });
  // No write at all: the row is left for the scorer, untouched.
  assert.equal(updates.length, 0);
  // No status move either.
  assert.equal(rpcArgs.length, 0);
  // Still at the matcher's input status.
  assert.equal(row.status, "passed_filters");
});

test("pre-gate: an empty config continues with no writes, even for a non-engineering title", async () => {
  // Nothing configured: the gate has no opinion, so the scorer decides.
  const { db, updates, rpcArgs } = fakeRow();
  // Passes (the verdict's warning is not this function's concern).
  assert.deepEqual(await preGateRow(db, "a1", PARTNERSHIPS, EMPTY), { kind: "continue" });
  // No write.
  assert.equal(updates.length, 0);
  // No move.
  assert.equal(rpcArgs.length, 0);
});

test("pre-gate: an excluded term is dropped with code tech_gate", async () => {
  // Matches the "sales" exclusion AND the "software engineer" title: exclusions win.
  const { db, row } = fakeRow();
  const outcome = await preGateRow(db, "a1", { title: "Sales Software Engineer", descriptionRaw: null }, PREFS);
  // The exclusion code, distinct from the unclassified one.
  assert.equal(outcome.kind === "dropped" && outcome.code, "tech_gate");
  // The column agrees.
  assert.equal(row.drop_reason, "tech_gate");
});

test("pre-gate: a row already moved off passed_filters is skipped_stale, with no rpc", async () => {
  // Another run scored it first.
  const { db, row, rpcArgs } = fakeRow({ status: "scored" });
  // The status-guarded write matched nothing, so this run does not own the row.
  assert.deepEqual(await preGateRow(db, "a1", PARTNERSHIPS, PREFS), { kind: "skipped_stale" });
  // No move attempted on a row that is not ours.
  assert.equal(rpcArgs.length, 0);
  // The other run's status and drop_reason are untouched.
  assert.equal(row.status, "scored");
  // Never overwritten by the guarded update.
  assert.equal(row.drop_reason, null);
});

test("pre-gate: a write error is reported as error, with no rpc", async () => {
  // supabase-js reports a failed write as { error }; the fake does the same.
  const { db, rpcArgs } = fakeRow({ writeError: "boom" });
  // The failure stays a failure, with its message, never folded into skip or continue.
  assert.deepEqual(await preGateRow(db, "a1", PARTNERSHIPS, PREFS), { kind: "error", message: "boom" });
  // Never moved after a failed write.
  assert.equal(rpcArgs.length, 0);
});

// --- withTechPreGate -------------------------------------------------------------------

// A queue row as the matcher reads it, with its embedded job.
type Row = { id: string; job: { title: string; descriptionRaw: string | null } };

// Reads title/body from the row, as the caller's readJob would.
const readJob = (r: Row) => r.job;

test("matcher pre-gate: no Gemini scoring call for a row the gate drops", async () => {
  const { db } = fakeRow();
  // Spy standing in for the Gemini-calling scorer: counts invocations only.
  let scoreCalls = 0;
  // Every row the gate handled itself, with its outcome.
  const gated: Array<{ row: Row; outcome: PreGateOutcome }> = [];
  const handler = withTechPreGate<Row, string>(
    db,
    PREFS,
    readJob,
    // Records the handled row so the caller's count is assertable.
    (row, outcome) => gated.push({ row, outcome }),
    // Must never run for a dropped row: this is the zero-Gemini-cost property.
    async () => {
      scoreCalls++;
    },
  );
  // A non-engineering row under a configured gate.
  await handler({ id: "a1", job: PARTNERSHIPS }, "call-1");
  // THE PROPERTY: the scorer, the only code that calls Gemini, was never reached.
  assert.equal(scoreCalls, 0);
  // The caller was told exactly once.
  assert.equal(gated.length, 1);
  // And told it was a drop, not a skip or an error.
  assert.equal(gated[0].outcome.kind, "dropped");
});

test("matcher pre-gate: a matching row is scored exactly once, with the same row and call", async () => {
  const { db } = fakeRow();
  // Every scorer invocation's arguments, so pass-through is assertable.
  const scored: Array<[Row, string]> = [];
  // Rows the gate handled itself; should stay empty.
  let gatedCalls = 0;
  const handler = withTechPreGate<Row, string>(
    db,
    PREFS,
    readJob,
    // Must not fire for a row that continues.
    () => {
      gatedCalls++;
    },
    // Records exactly what the wrapper handed on.
    async (row, call) => {
      scored.push([row, call]);
    },
  );
  // A recognised row.
  const row: Row = { id: "a1", job: ENGINEER };
  await handler(row, "call-1");
  // Scored exactly once.
  assert.equal(scored.length, 1);
  // With the same row object, unchanged.
  assert.equal(scored[0][0], row);
  // And the same call argument.
  assert.equal(scored[0][1], "call-1");
  // The gate did not also report it as handled.
  assert.equal(gatedCalls, 0);
});

// --- review fixes (independent reviewer, 2026-10-09) -----------------------------------

test("pre-gate: a missing job is an error, never judged as an empty title", async () => {
  // An empty title under a configured gate would be dropped as tech_gate_unclassified:
  // missing data turned into an answer (CLAUDE.md §6). It must be reported instead.
  const { db, updates } = fakeRow();
  // null is what readJob returns when the jobs embed is absent.
  const outcome = await preGateRow(db, "a1", null, PREFS);
  // Reported as this row's failure, so it shows in the run's error_detail.
  assert.equal(outcome.kind, "error");
  // And nothing was written: the row stays at passed_filters for a later run.
  assert.equal(updates.length, 0);
});

test("pre-gate: a drop clears a score an overlapping run already wrote", async () => {
  // An overlapping run's step-1 score landed first; the gate's drop then wins the stamp race.
  const { db, row } = fakeRow();
  // Seed the column the other run wrote.
  row.match_score = 80;
  row.match_reasoning = "other run";
  // The gate rejects this posting under the configured lists.
  const outcome = await preGateRow(db, "a1", PARTNERSHIPS, PREFS);
  // Dropped by the gate...
  assert.equal(outcome.kind, "dropped");
  // ...and no other run's score is left sitting on a row the gate dropped.
  assert.equal(row.match_score, null);
  assert.equal(row.match_reasoning, null);
});

test("matcher pre-gate: a throw inside the gate is contained to its row", async () => {
  // A null element inside a text[] config column reaches `.trim()` and throws. The gate sits
  // outside the scorer's try/catch, so without containment the whole run would 500.
  const { db } = fakeRow();
  // The real trigger, not a stub: a null smuggled into the titles array.
  const broken = { ...PREFS, titles: [null as unknown as string] };
  // Never reached for this row.
  let scoreCalls = 0;
  // Collects what the caller would count.
  const gated: PreGateOutcome[] = [];
  const handler = withTechPreGate<Row, string>(
    db,
    broken,
    readJob,
    // Records the outcome the caller would count as a failure.
    (_row, outcome) => gated.push(outcome),
    // The Gemini-calling scorer.
    async () => {
      scoreCalls++;
    },
  );
  // Must resolve, not reject: a rejection here is what would 500 the run.
  await handler({ id: "a1", job: PARTNERSHIPS }, "call-1");
  // Reported as this row's error...
  assert.equal(gated.length, 1);
  assert.equal(gated[0].kind, "error");
  // ...and the scorer was not reached.
  assert.equal(scoreCalls, 0);
});
