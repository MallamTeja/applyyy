// The single choke point every status write in the worker passes through.
//
// WHY THIS EXISTS WHEN THE DATABASE ALREADY ENFORCES THE GRAPH: the guard
// trigger in Postgres would reject an illegal edge, but it rejects it AFTER the
// worker has driven a real browser at a real employer's form. Failing in
// TypeScript before the attempt means a bad edge costs nothing; failing in
// Postgres after the attempt leaves a row whose real-world outcome is unknown,
// and an unknown submit is not a retryable submit (constraint #7).
//
// The rule this encodes: VALIDATE AT THE BOUNDARY YOU CAN STILL BACK OUT OF.
// The database is the authority on what is legal; this is the cheapest place to
// discover you were about to ask it something illegal.
import { canTransition, type AgentName, type ApplicationStatus } from '@applyy/shared-types';

/**
 * The narrow slice of the gateway this module needs.
 *
 * Deliberately not the whole gateway: a guard that can only perform one kind of
 * write cannot be refactored into one that performs a different kind by
 * accident, and it lets the tests supply a two-line fake instead of a mock.
 */
export interface StatusWriter {
  advanceStatus(
    applicationId: string,
    to: ApplicationStatus,
    agent: AgentName,
    detail?: Record<string, unknown>,
  ): Promise<void>;
}

/** One requested move through the status graph. */
export interface TransitionRequest {
  readonly applicationId: string;
  // The status the row is believed to be in. Supplied by the caller rather than
  // re-read here, because the caller holds the claimed row and a second read
  // would open a window in which the two disagree.
  readonly from: ApplicationStatus;
  readonly to: ApplicationStatus;
  // The actor. Required, never defaulted: the graph's human-only recovery lanes
  // are only closed to automation if automation must name itself to move a row.
  readonly agent: AgentName;
  // Extra context, written to application_events by the RPC.
  readonly detail?: Record<string, unknown>;
}

/**
 * Thrown instead of writing when the graph forbids the move.
 *
 * A distinct type so the run loop can tell "this edge is illegal" (a bug in the
 * worker, and never retryable) apart from "the network failed" (transient).
 * Conflating them is how a permanent error acquires a retry loop.
 */
export class IllegalTransitionError extends Error {
  // Carried as fields so a caller can log structurally rather than re-parsing
  // the message, which is the usual reason error messages become load-bearing.
  readonly from: ApplicationStatus;
  readonly to: ApplicationStatus;
  readonly agent: AgentName;

  constructor(from: ApplicationStatus, to: ApplicationStatus, agent: AgentName) {
    // The message names the edge AND the actor, because "illegal transition" on
    // its own sends the reader to the graph to work out which half was wrong.
    super(
      `illegal transition ${from} -> ${to} for agent "${agent}": ` +
        'refusing to write. See packages/shared-types/src/status-flow.ts.',
    );
    // Without this the class name is lost through the Error constructor and
    // instanceof-adjacent logging shows every subclass as plain "Error".
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
    this.agent = agent;
  }
}

/**
 * Move a row, or refuse without writing.
 *
 * There is no force parameter and no bypass. An escape hatch here would be
 * reachable from the one component that touches real employers.
 */
export async function guardedAdvance(
  writer: StatusWriter,
  request: TransitionRequest,
): Promise<void> {
  // Both questions at once: does this edge exist, and may THIS actor make it.
  // Passing the agent is what keeps `applying -> needs_verification` closed to
  // the applier — that edge is real and sweeper/human-only, so an agent-blind
  // check would wave through the single most dangerous move in the graph.
  if (!canTransition(request.from, request.to, request.agent)) {
    throw new IllegalTransitionError(request.from, request.to, request.agent);
  }

  // Legal: hand it straight to the gateway, unmodified. The guard is a gate,
  // not a translator — rewriting anything here would let it drift from the
  // database's own view of the same transition.
  await writer.advanceStatus(request.applicationId, request.to, request.agent, request.detail);
}
