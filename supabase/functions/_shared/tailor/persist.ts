// PERSISTING A TAILOR VERDICT — the first real writer of `applications.tailored_profile`.
//
// Until this file existed, that column had consumers and no producer: the approval queue
// reads it (`ApprovalQueuePage.tsx:223`) and nothing anywhere filled it. That is why the
// queue is empty by construction rather than merely idle.
//
// THE ORDERING RULE, which is the whole design: THE STATUS IS A CLAIM THAT THE PAYLOAD
// EXISTS. Write the profile first, advance the status second, and never advance if the
// write failed. The reverse order opens a window where a row sits at `tailored` with a
// null profile — the exact state the approval gate was built to refuse, manufactured by
// the trusted side instead of by a missing agent. Ordering makes that unrepresentable
// rather than merely unlikely, which is §5's "a comment is not a control".
//
// WHY THE STATUS MOVES THROUGH THE RPC AND NEVER A BARE UPDATE: the guard trigger
// refuses an anonymous status change with SQLSTATE 42501
// (`status_transition_guard.sql:209-215`). `advance_application_status` is what sets
// `applyy.acting_agent` for the transaction, so it is the only sanctioned route.
//
// AND WHY THE PROFILE WRITE IS A BARE UPDATE, which looks inconsistent and is not: the
// same guard short-circuits at `:199` — `if new.status is not distinct from old.status
// then return new` — and its own comment names this case, "an agent writing a score or a
// storage path". A payload-only update is the cheap, intended path.

// The verdict this module persists. Imported rather than re-described, so a new outcome
// kind is a compile error here instead of a silently unhandled branch.
import type { TailorOutcome } from "./tailorer.ts";

// The database surface this module needs, and nothing more.
//
// NARROW ON PURPOSE, mirroring `../screen/supabase-queries.ts`'s `SelectableClient`: a
// seam typed to the full postgrest client would drag its whole surface into every test
// and let a future edit reach for a method this module was never meant to call.
export interface TailorPersistClient {
  // The payload write. Chained exactly as postgrest builds it.
  from(table: string): {
    update(values: Record<string, unknown>): {
      // Returns the error as DATA, the way postgrest does — never throws.
      eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }>;
    };
  };
  // The status move, through the guarded function.
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
}

// What the caller learns. A union rather than a thrown error, because a persistence
// failure is an operational fact the CLI has to report and retry against, not an
// exception that should unwind a batch of otherwise-successful jobs.
export type PersistOutcome =
  // The row is now at the named status, and any payload it implies is already written.
  | { readonly ok: true; readonly status: "tailored" | "failed" }
  // Nothing further was attempted. The message carries postgrest's own text.
  | { readonly ok: false; readonly message: string };

// Persist one verdict against one application row.
export async function persistTailorOutcome(
  client: TailorPersistClient,
  applicationId: string,
  outcome: TailorOutcome,
): Promise<PersistOutcome> {
  // A refusal has no payload to write, so it is a single guarded status move. Handled
  // first because the happy path below depends on having a resume at all.
  if (outcome.kind === "refused") {
    // `scored -> failed` is legal for the tailor (`status_transition_guard.sql:118`).
    // The violations travel in the event detail: they are the dashboard's content, and
    // `validator.ts:70` requires they survive as data rather than as a stack trace.
    const { error } = await client.rpc("advance_application_status", {
      p_application_id: applicationId,
      p_to_status: "failed",
      p_agent: "tailor",
      // Structured, not flattened to a string — a UI branches on `kind`, and prose
      // would force it to parse a discriminant back out of English.
      p_detail: { reason: "tailor_validation_failed", violations: outcome.violations },
    });
    // Carried through rather than absorbed, so a caller can tell "failed cleanly" from
    // "could not even record the failure".
    if (error) return { ok: false, message: error.message };
    return { ok: true, status: "failed" };
  }

  // THE PAYLOAD, FIRST. See the header: the status that follows is a claim this line
  // succeeded, so it must actually have succeeded before the claim is made.
  const write = await client.from("applications")
    // `tailor_refs` rides in the SAME statement as the profile: a second write could fail
    // alone and leave a `tailored` row whose refs the Auditor never sees. The column is
    // `tailor_refs jsonb` (core_tables.sql:351), read by audit/detector.ts:503.
    .update({ tailored_profile: outcome.resume, tailor_refs: outcome.refs })
    // Scoped to one row. Without this predicate the update would rewrite every
    // application the caller's RLS context can see.
    .eq("id", applicationId);

  // STOP HERE ON FAILURE. Advancing anyway would put a row at `tailored` with a null
  // profile — the one state this module exists to make impossible.
  if (write.error) return { ok: false, message: write.error.message };

  // Only now is the claim true. `scored -> tailored`, the Tailor's one legal edge
  // (`status_transition_guard.sql:116`).
  const { error } = await client.rpc("advance_application_status", {
    p_application_id: applicationId,
    p_to_status: "tailored",
    p_agent: "tailor",
    // Enough to reconstruct what was written without re-reading the row.
    p_detail: { reason: "tailored_profile_written" },
  });
  // A failure here leaves the profile written and the status unmoved — recoverable by
  // re-running, and deliberately preferred over the inverse, which is not.
  if (error) return { ok: false, message: error.message };

  return { ok: true, status: "tailored" };
}
