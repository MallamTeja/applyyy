// PERSISTING A SCREENER VERDICT.
//
// WHY THIS FILE EXISTS: the screener used to write `.update({ status })` directly. The
// guard trigger refuses every status change that does not name an acting agent
// (SQLSTATE 42501, `status_transition_guard.sql:208-215`), so no row ever left
// `deduped`. Pulled out of `screener/index.ts` so the fix can be tested — an index.ts
// imports `jsr:` and cannot run under `node --test`.
//
// THE ORDERING RULE, same as `../tailor/persist.ts`: THE STATUS IS A CLAIM THAT THE
// PAYLOAD EXISTS. `advance_application_status` takes no drop_reason parameter, so the
// reason is written by a payload-only update first (the guard short-circuits when the
// status is unchanged, `:199`) and the status moves second, through the RPC.

// The narrow database surface this module needs, mirroring `TailorPersistClient`, so a
// test can fake it without dragging in the postgrest client.
export interface ScreenPersistClient {
  // The payload write, chained exactly as postgrest builds it.
  from(table: string): {
    update(values: Record<string, unknown>): {
      // Errors come back as data, never thrown — the postgrest contract.
      eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }>;
    };
  };
  // The guarded status move.
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
}

// The three verdicts the screener can reach from `deduped` — a closed union so an edge
// the graph does not hold is a compile error rather than a 42501 at runtime.
export type ScreenVerdict =
  // Survived every rule. `reason` is null because there is nothing to name.
  | { readonly status: "passed_filters"; readonly reason: null }
  // A rule rejected it; `reason` is the rule (or `tech_gate`), stored in drop_reason.
  | { readonly status: "dropped_filter"; readonly reason: string | null }
  // The row could not be evaluated at all; `reason` is stored in failure_reason.
  | { readonly status: "failed"; readonly reason: string };

// The caller learns whether the row moved. A union, not a throw, so one bad row never
// unwinds a batch of good ones.
export type ScreenPersistOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

// Persist one verdict against one application row.
export async function persistScreenVerdict(
  client: ScreenPersistClient,
  applicationId: string,
  verdict: ScreenVerdict,
): Promise<ScreenPersistOutcome> {
  // Which column carries the reason. passed_filters CLEARS drop_reason: a previous run
  // may have written one and then failed its RPC, and a passed row must not keep it.
  const payload = verdict.status === "failed"
    ? { failure_reason: verdict.reason }
    : { drop_reason: verdict.reason };

  // PAYLOAD FIRST. No `status` key, so the guard lets it through as a plain data write.
  const write = await client.from("applications").update(payload).eq("id", applicationId);
  // Stop on failure: a dropped row without its drop_reason is the state this prevents.
  if (write.error) return { ok: false, message: write.error.message };

  // STATUS SECOND, through the only route that declares the acting agent.
  const { error } = await client.rpc("advance_application_status", {
    p_application_id: applicationId,
    // Every edge used here is seeded for `screener` (status_transition_guard.sql:106-108).
    p_to_status: verdict.status,
    // Must match the edge's allowed_agents, or the guard refuses.
    p_agent: "screener",
    // Duplicated into the event so the audit trail reads without joining the row.
    p_detail: { reason: verdict.reason },
  });
  // Carried through so the batch counts it as a failure instead of a silent success.
  if (error) return { ok: false, message: error.message };

  // Payload and status both landed.
  return { ok: true };
}
