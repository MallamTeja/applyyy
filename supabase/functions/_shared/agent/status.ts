// EVERY STATUS WRITE IN THIS STREAM GOES THROUGH HERE.
//
// Two things happen, in this order, and the order is the design:
//
//   1. `canTransition(from, to, agent)` — the shared status graph, in TypeScript.
//   2. `advance_application_status()`   — the RPC, which re-checks the same thing in SQL.
//
// WHY BOTH, since the database already refuses an illegal edge — because "the database
// checks it anyway" is the argument that deletes this layer, and it is wrong for a
// reason that only shows up in an incident. A trigger refusal arrives as an opaque
// `P0001` raised inside a plpgsql function, AFTER the row was claimed and AFTER the
// Gemini call that produced the value being written. The agent then has a string to
// parse and a spent quota unit to explain. Checking first turns that into a NAMED
// outcome it can count, log and release the claim for, and it costs one map lookup.
//
// THE CASE THAT MAKES THIS MORE THAN A NICETY IS THE ACTOR CHECK, and it is easy to get
// wrong in a way review cannot see. `canTransition('audit_flagged', 'tailored')` with no
// agent returns TRUE — the edge genuinely exists. But it is `['human']`-only, because an
// automated retry loop there would burn quota rewriting the same flagged bullet. An
// agent that asks the question without naming itself therefore gets a green light and
// then fails in Postgres. So the actor is a REQUIRED parameter here: the wrong question
// is not askable through this function.
//
// WHAT THIS FUNCTION DELIBERATELY CANNOT DO: write `status` with a bare `.update()`. The
// `ApplicationPatch` type has no `status` field, so the mistake §6 warns about — a write
// that passes the guard but leaves `claimed_by` set, stranding the row until the sweeper
// notices, presenting as "the pipeline is slow" rather than as a bug — is unrepresentable
// rather than merely discouraged.

// The shared status graph's guard, and the actor vocabulary it validates against. VALUES
// rather than types: this check needs the runtime graph, which is why
// `_shared/contracts/shared-types.ts` pays for a runtime dependency at all.
import { canTransition } from "../contracts/shared-types.ts";
// The enums and the row shape, imported and never redefined.
import type { AgentName, ApplicationStatus } from "../contracts/shared-types.ts";
// The queue port. Narrow on purpose: this module cannot claim, release or patch.
import type { QueuePort } from "./port.ts";

// Just enough of a claimed row to decide whether a move is legal. A projection rather
// than `ApplicationRow`, so every test here is a two-field literal and the real
// dependency surface — the row's CURRENT status — is visible in the signature.
export interface AdvanceSubject {
  // Which row to move.
  readonly id: string;
  // Where it is now. The `from` half of the edge, taken from the row rather than from a
  // caller's assumption — an agent that "knows" the status it claimed can be wrong if
  // something else moved the row inside the lease window.
  readonly status: ApplicationStatus;
}

// What happened.
export type AdvanceOutcome =
  // Moved, event recorded, lease released — all in one transaction.
  | { readonly ok: true }
  // OUR graph says no. This is a BUG in the calling agent, not a transient condition,
  // and it is named separately so nobody retries it.
  | { readonly ok: false; readonly reason: "illegal_transition"; readonly detail: string }
  // The graph allowed it and the write failed anyway: a dropped connection, an RLS
  // surprise, or a trigger refusing for a reason TypeScript cannot see. Distinct from
  // the above because it points at the ENVIRONMENT rather than at the code, and
  // collapsing the two would send someone to read the wrong file.
  | { readonly ok: false; readonly reason: "write_failed"; readonly detail: string };

// Move one row, guarded.
export async function guardedAdvance(
  // The queue.
  port: QueuePort,
  // The row, carrying the status it is actually in.
  subject: AdvanceSubject,
  // Where it should end up.
  toStatus: ApplicationStatus,
  // WHO is moving it. Required, never optional — see the header: the optional form of
  // this question has a different and more permissive answer.
  agent: AgentName,
  // Context for the event log, e.g. which filter rule dropped the row.
  detail?: Record<string, unknown>,
): Promise<AdvanceOutcome> {
  // THE GUARD. Fails fast in TypeScript so an illegal edge never costs a round trip and
  // never has to be recovered from an opaque Postgres error.
  if (!canTransition(subject.status, toStatus, agent)) {
    // The message names all three parts, because "illegal transition" without the actor
    // is exactly the log line that sends someone hunting the wrong half of the problem.
    return {
      ok: false,
      reason: "illegal_transition",
      detail: `${subject.status} -> ${toStatus} is not permitted for agent "${agent}"`,
    };
  }
  // Legal by our graph. Now let the database do it — and re-check it.
  const written = await port.advanceStatus(subject.id, toStatus, agent, detail);
  // The database refused or could not be reached.
  if (!written.ok) return { ok: false, reason: "write_failed", detail: written.reason };
  // Moved.
  return { ok: true };
}
