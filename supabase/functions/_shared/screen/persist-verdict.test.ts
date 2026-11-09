// Tests for persisting a Screener verdict.
//
// THE BUG THESE GUARD: the screener used to move rows with a bare
// `.update({ status })`. The guard trigger refuses any status change that does not
// declare an acting agent (SQLSTATE 42501, `status_transition_guard.sql:208-215`), so
// every row the screener touched stayed at `deduped` forever. The only sanctioned route
// is `advance_application_status`, which sets `applyy.acting_agent` for the transaction.
//
// So the two things asserted on every verdict are: NO update payload ever carries a
// `status` key, and the status moves through the RPC naming the `screener` agent.
import { test } from "node:test";
// Strict, so a missing key never compares equal to a key holding `undefined`.
import assert from "node:assert/strict";
// Extension-suffixed so this runs under Deno and `node --test` alike.
import { persistScreenVerdict, type ScreenPersistClient } from "./persist-verdict.ts";

// A literal id, so a failed assertion names something searchable.
const APPLICATION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// One recorded call against the seam, in the order it was made.
interface RecordedCall {
  // "update" or "rpc", so the ordering between payload and status is visible.
  readonly kind: string;
  // Everything a caller could get wrong, captured for assertion.
  readonly payload: Record<string, unknown>;
}

// Records calls rather than mocking them: the assertions are about what this module
// actually sent, not about whether a fake was poked.
function recordingClient(failOn?: "update" | "rpc") {
  // Shared by both branches so the order of update vs rpc is observable.
  const calls: RecordedCall[] = [];
  // Built to the narrow seam the module declares, not to postgrest's full surface.
  const client: ScreenPersistClient = {
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => ({
        eq: (column: string, value: string) => {
          // Table, columns and predicate — a missing predicate would rewrite every row.
          calls.push({ kind: "update", payload: { table, values, column, value } });
          // Errors are data on this seam, as postgrest returns them.
          return Promise.resolve({ error: failOn === "update" ? { message: "write refused" } : null });
        },
      }),
    }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      // The status move, with its arguments, so the agent and edge can be asserted.
      calls.push({ kind: "rpc", payload: { fn, args } });
      return Promise.resolve({ error: failOn === "rpc" ? { message: "transition refused" } : null });
    },
  };
  return { client, calls };
}

// Pulls the args of the one rpc call, failing loudly if there is none.
function rpcArgs(calls: readonly RecordedCall[]): Record<string, unknown> {
  // Exactly one status move per verdict; more or fewer is itself the bug.
  const rpcs = calls.filter((c) => c.kind === "rpc");
  assert.equal(rpcs.length, 1, "expected exactly one advance_application_status call");
  return rpcs[0]!.payload.args as Record<string, unknown>;
}

// The regression in its sharpest form: a bare status update anywhere is the 42501 bug.
function assertNoBareStatusWrite(calls: readonly RecordedCall[]): void {
  for (const call of calls.filter((c) => c.kind === "update")) {
    // `status` in an update payload is exactly what the guard refuses.
    assert.equal("status" in (call.payload.values as Record<string, unknown>), false);
  }
}

test("a passing row advances to passed_filters through the RPC as the screener", async () => {
  const { client, calls } = recordingClient();

  const result = await persistScreenVerdict(client, APPLICATION_ID, { status: "passed_filters", reason: null });

  assert.equal(result.ok, true);
  assertNoBareStatusWrite(calls);
  const args = rpcArgs(calls);
  // Through the guarded function, never a bare UPDATE.
  assert.equal(calls.find((c) => c.kind === "rpc")!.payload.fn, "advance_application_status");
  // `deduped -> passed_filters` is the screener's edge (status_transition_guard.sql:106).
  assert.equal(args.p_to_status, "passed_filters");
  assert.equal(args.p_agent, "screener");
  assert.equal(args.p_application_id, APPLICATION_ID);
});

test("a dropped row writes drop_reason BEFORE it advances to dropped_filter", async () => {
  const { client, calls } = recordingClient();

  await persistScreenVerdict(client, APPLICATION_ID, { status: "dropped_filter", reason: "title_blocklist" });

  // Payload first: a row at dropped_filter is a claim that drop_reason names the rule.
  assert.deepEqual(calls.map((c) => c.kind), ["update", "rpc"]);
  assertNoBareStatusWrite(calls);
  // The rule name survives — the RPC has no drop_reason parameter, so this write is
  // the only place it can land.
  assert.equal((calls[0]!.payload.values as Record<string, unknown>).drop_reason, "title_blocklist");
  assert.equal(calls[0]!.payload.value, APPLICATION_ID);
  const args = rpcArgs(calls);
  assert.equal(args.p_to_status, "dropped_filter");
  assert.equal(args.p_agent, "screener");
});

test("a row with no job record fails through the RPC with failure_reason written", async () => {
  const { client, calls } = recordingClient();

  await persistScreenVerdict(client, APPLICATION_ID, { status: "failed", reason: "missing_job_record" });

  assertNoBareStatusWrite(calls);
  // The reason lands in the column the enum comment says carries it.
  assert.equal((calls[0]!.payload.values as Record<string, unknown>).failure_reason, "missing_job_record");
  const args = rpcArgs(calls);
  // `deduped -> failed` admits the screener (status_transition_guard.sql:108).
  assert.equal(args.p_to_status, "failed");
  assert.equal(args.p_agent, "screener");
});

test("a failed payload write does not move the status", async () => {
  const { client, calls } = recordingClient("update");

  const result = await persistScreenVerdict(client, APPLICATION_ID, { status: "dropped_filter", reason: "staleness" });

  // Never reach the rpc: a dropped row with no drop_reason is the lie this order prevents.
  assert.deepEqual(calls.map((c) => c.kind), ["update"]);
  assert.equal(result.ok, false);
});

test("a refused transition is reported, not swallowed", async () => {
  const { client } = recordingClient("rpc");

  const result = await persistScreenVerdict(client, APPLICATION_ID, { status: "passed_filters", reason: null });

  // The caller counts this as a failure; a silent success is how 0 rows moved unnoticed.
  assert.deepEqual(result, { ok: false, message: "transition refused" });
});

test("a failed verdict with a blank or unknown reason is refused before ANY write", async () => {
  // Each shape a lenient caller could produce: empty, whitespace, undefined, a code outside the closed set.
  for (const reason of ["", "   ", undefined, "made_up_reason"]) {
    // A fresh recorder per case, so one case's calls never satisfy another's assert.
    const { client, calls } = recordingClient();
    // Cast: the type already forbids these; this proves the runtime refuses what a cast or a JS caller sneaks past it.
    const result = await persistScreenVerdict(client, APPLICATION_ID, { status: "failed", reason } as never);
    // Refused, never a silent success.
    assert.equal(result.ok, false, `reason ${JSON.stringify(reason)} was accepted`);
    // No payload write either: a blank failure_reason must not land on the row ahead of the RPC's own refusal.
    assert.deepEqual(calls, [], `reason ${JSON.stringify(reason)} reached the database`);
  }
});
