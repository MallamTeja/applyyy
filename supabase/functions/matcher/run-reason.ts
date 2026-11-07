// THE MATCHER RUN'S TOP-LEVEL REASON (2026-11-07, Teja via the orchestrator; peer 3's pipeline worker).
//
// WHY: a targeted run (?application_id=) that selected 0 rows answered `found: 0` and nothing else, so the
// web could not say whether the posting was gone or the row had already moved on; and a Gemini rate limit
// reached the reader only inside failures[].error. This turns both into one readable field. ADDITIVE: every
// other key of the response is unchanged, and failures[].error still carries the rate-limit text, which the
// web's card reads today (peer 3's ask). Pure, so every rule is a named test.

// The closed set of codes. A reader switches on these (peer 3 maps each to a sentence); an unknown code is
// never produced, so the union is the whole contract.
export type MatcherReasonCode = "target_not_found" | "target_not_at_input_status" | "target_posting_gone" | "rate_limited";

// What the response carries under `reason`, or null when there is nothing to explain.
export interface MatcherReason {
  // Which case this is.
  readonly code: MatcherReasonCode;
  // A sentence for a human, or the failure text verbatim for a rate limit.
  readonly message: string;
  // Only for target_not_at_input_status: the status the row is actually at.
  readonly status?: string;
}

// What the run knows when it builds its response.
export interface MatcherRunFacts {
  // Whether the run was asked for one application id.
  readonly targeted: boolean;
  // How many rows the queue select returned.
  readonly found: number;
  // The targeted row as a follow-up lookup read it: null when it does not exist, undefined when the lookup
  // was not made or failed (unknown, which must never read as "not found").
  readonly target: { readonly status: string; readonly disappeared: boolean } | null | undefined;
  // The run's per-row failures, as the response lists them.
  readonly failures: readonly { readonly error: string }[];
}

// How a Gemini rate limit appears in a failure's text: the client's exhausted-retries reason, or HTTP 429.
const RATE_LIMITED = /rate_limited|status=429\b/;

// The input status the matcher scores from; named once for the message.
const INPUT_STATUS = "passed_filters";

// The reason for one run, or null.
export function matcherRunReason(facts: MatcherRunFacts): MatcherReason | null {
  // A targeted run that selected nothing, with a lookup that answered: say which of the three it was.
  if (facts.targeted && facts.found === 0 && facts.target !== undefined) {
    // No such application at all.
    if (facts.target === null) return { code: "target_not_found", message: "No application with that id exists." };
    // At the matcher's status, but its posting left the board (the queue select skips those rows).
    if (facts.target.status === INPUT_STATUS && facts.target.disappeared) return { code: "target_posting_gone", message: "The posting is gone from its board, so the matcher skipped it." };
    // Anywhere else: name the status, so the reader can say "already at scored".
    if (facts.target.status !== INPUT_STATUS) return { code: "target_not_at_input_status", message: `The application is at ${facts.target.status}, not ${INPUT_STATUS}, so the matcher has nothing to score.`, status: facts.target.status };
  }
  // A rate limit anywhere in the run, quoted verbatim (the first one; they share the cause).
  const limited = facts.failures.find((failure) => RATE_LIMITED.test(failure.error));
  // Named at the top level; failures[].error keeps it too.
  if (limited !== undefined) return { code: "rate_limited", message: limited.error };
  // Nothing to explain.
  return null;
}
