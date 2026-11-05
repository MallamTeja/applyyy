/* Apply on approve, browser side (P1-6, 2026-11-05).
 *
 * After an approve moves at least one row, the approval page asks the dispatch-apply edge function to
 * start the applier. The function decides everything (Teja's switch, live approved rows, the GitHub
 * token); this file only asks once and reads the answer into a closed union, so the page can say what
 * happened. A malformed answer is an error, never "dispatched" (CLAUDE.md §6).
 */

// The shared error-body reader and record check, already exported for the discovery panels.
import { isRecord, readErrorBody } from '../discovery/WebScoutPanel';

/* The one slice of the supabase client this needs, so a test can fake it. */
export interface DispatchClient {
  // supabase.functions.invoke, as the approval page's client has it.
  readonly functions: { invoke(name: string): Promise<{ data: unknown; error: unknown }> };
}

/* What the function said. */
export type DispatchResult =
  // A run was started for this many approved rows.
  | { readonly kind: 'dispatched'; readonly approved: number }
  // Nothing was started, on purpose (the switch is off, or nothing is approved).
  | { readonly kind: 'skipped'; readonly reason: string }
  // Something failed; the message is the function's own, or a plain sentence.
  | { readonly kind: 'error'; readonly message: string };

/* Ask dispatch-apply once. Never throws: every outcome is a DispatchResult. */
export async function requestDispatch(client: DispatchClient): Promise<DispatchResult> {
  // The call.
  try {
    // No body: the function reads everything it needs under the caller's session.
    const { data, error } = await client.functions.invoke('dispatch-apply');
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
