/* Apply on approve, browser side (P1-6, 2026-11-05).
 *
 * After an approve moves at least one row, the approval page asks the dispatch-apply edge function to
 * start the runs. Since 5c3ce87 the function starts the KIT builder (apply-kit.yml) on every approve, and
 * the applier's live drain only when Teja's switch is on. It decides everything (the switch, live approved
 * rows, the GitHub token); this file only asks once and reads the answer into a closed union, so the page
 * can say what happened. A malformed answer is an error, never "dispatched" (CLAUDE.md §6).
 *
 * What stays silent and what is surfaced: 'skipped' with auto_apply_off means the kits WERE started and
 * only the applier was skipped (the expected state); 'skipped' with nothing_approved means nothing ran.
 * ANY dispatch failure, the kit's included, is a non-2xx naming the workflow, so it reads as 'error' and
 * is shown, whatever the switch says.
 */

// The shared error-body reader and record check, already exported for the discovery panels.
import { isRecord, readErrorBody } from '../discovery/WebScoutPanel';
// Every browser edge call goes through it: a revoked session refreshes once, else signs out with a plain sentence.
import { invokeEdge, type EdgeClient } from '../../data/edgeCall.ts';

/* The one slice of the supabase client this needs, so a test can fake it: invokeEdge's client
   (functions plus auth, for the one refresh and the local sign-out). */
export type DispatchClient = EdgeClient;

/* What the function said. */
export type DispatchResult =
  // A run was started for this many approved rows.
  | { readonly kind: 'dispatched'; readonly approved: number }
  // The applier was not started, on purpose: the switch is off (kits were still started) or nothing is approved.
  | { readonly kind: 'skipped'; readonly reason: string }
  // Something failed; the message is the function's own, or a plain sentence.
  | { readonly kind: 'error'; readonly message: string };

/* Ask dispatch-apply once. Never throws: every outcome is a DispatchResult. */
export async function requestDispatch(client: DispatchClient): Promise<DispatchResult> {
  // The call.
  try {
    // No body: the function reads everything it needs under the caller's session.
    const answer = await invokeEdge(client, 'dispatch-apply');
    // The session is gone and this browser is signed out: nothing was started, and the sentence says why.
    if (answer.kind === 'signed_out') return { kind: 'error', message: answer.message };
    // The function answered: its own data and error.
    const { data, error } = answer;
    // A non-2xx: the function's own message when it sent one.
    if (error) {
      // The JSON body behind the error, if readable.
      const body = (await readErrorBody(error)) ?? data;
      // Its message, verbatim, when it has the expected shape.
      return { kind: 'error', message: isRecord(body) && typeof body.message === 'string' ? body.message : 'The applier could not be started (no readable answer).' };
    }
    // The ok shape: a dispatch with an integer count.
    if (isRecord(data) && data.status === 'ok' && data.dispatched === true && typeof data.approved === 'number' && Number.isInteger(data.approved)) return { kind: 'dispatched', approved: data.approved };
    // The ok shape: a skip with its reason.
    if (isRecord(data) && data.status === 'ok' && data.dispatched === false && typeof data.reason === 'string') return { kind: 'skipped', reason: data.reason };
    // Anything else is a drifted contract, said as such.
    return { kind: 'error', message: 'The applier answer had an unexpected shape.' };
  } catch (cause) {
    // A network drop or a thrown fetch.
    return { kind: 'error', message: `The applier could not be started: ${cause instanceof Error ? cause.message : 'no answer'}.` };
  }
}
