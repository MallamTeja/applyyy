// One formatter for a failed Gemini call, used by every caller that records the failure.
//
// WHY THIS EXISTS: callers kept only `outcome.reason`, so every failure in a run read
// "gemini_call_failed: http_error". That one reason has three sources (a 400 or other
// unclassified status; all 4 attempts rejected with 401/403; a 200 whose body was not
// JSON), and agent_runs.error_detail dedupes identical text, so ten different failures
// showed as one opaque line. Diagnosing the 2026-10-05 matcher failures needed a manual
// read of gemini_key_state.last_error, a per-key snapshot that the next success wipes. The
// status and a short detail now travel with the reason, the same way into every table.
//
// SAFETY: `detail` can carry upstream text (Google's error message, a gateway page). It is
// flattened to one line, any API-key-shaped token or `key=` URL parameter is redacted,
// and it is capped, so a failure line can never leak a key or dump a body into Health.
//
// Pure TypeScript with no imports, so Deno edge functions and `node --test` both load it.

// The fields a failure outcome carries (client.ts GeminiResult's failure arm), narrowed to
// what is formatted, so any caller's outcome fits without a cast.
export interface GeminiFailureLike {
  // The closed failure reason, e.g. "http_error", "upstream_unavailable".
  readonly reason: string;
  // The HTTP status when one was received; absent for pool/claim failures and timeouts.
  readonly status?: number;
  // Short upstream or client-side explanation; untrusted text.
  readonly detail?: string;
}

// Longest detail kept, in characters, including the ellipsis that marks a cut.
export const GEMINI_FAILURE_DETAIL_MAX = 120;

// Google API keys: "AIza" plus 35 key characters. Redacted wherever they appear.
const API_KEY_SHAPE = /AIza[0-9A-Za-z_-]{35}/g;
// A key passed as a URL query parameter (the client's pre-2026-10-05 transport).
const KEY_QUERY_PARAM = /([?&]key=)[^&\s"']+/gi;

// Make an untrusted detail safe and short for a one-line run summary.
function sanitizeDetail(detail: string): string {
  const cleaned = detail
    // Redact key-shaped tokens before anything else, so a cut can never expose half a key.
    .replace(API_KEY_SHAPE, "[redacted-key]")
    // And a key carried as ?key=… / &key=… in a quoted URL.
    .replace(KEY_QUERY_PARAM, "$1[redacted]")
    // One line: newlines, tabs and other control characters become spaces.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    // Collapse runs of whitespace left by the step above or by the upstream text.
    .replace(/\s+/g, " ")
    // No leading or trailing blanks to throw off the cap.
    .trim();
  // Short enough already: kept whole.
  if (cleaned.length <= GEMINI_FAILURE_DETAIL_MAX) return cleaned;
  // Cut, marking the cut so a reader knows the text continued.
  return `${cleaned.slice(0, GEMINI_FAILURE_DETAIL_MAX - 1)}…`;
}

// "<reason> status=<n|-> <detail>" — for a seam that adds its own prefix (cover-letter).
export function describeGeminiFailure(outcome: GeminiFailureLike): string {
  // "-" says "no HTTP status was received", which differs from a status being lost.
  const status = typeof outcome.status === "number" ? String(outcome.status) : "-";
  // An absent or blank detail adds nothing, not a trailing space.
  const detail = outcome.detail === undefined ? "" : sanitizeDetail(outcome.detail);
  // Reason and status always; detail only when there is one.
  return detail === "" ? `${outcome.reason} status=${status}` : `${outcome.reason} status=${status} ${detail}`;
}

// "gemini_call_failed: <reason> status=<n|-> <detail>" — the line a caller records or throws.
export function formatGeminiFailure(outcome: GeminiFailureLike): string {
  // The prefix every caller already used, so existing log searches still match.
  return `gemini_call_failed: ${describeGeminiFailure(outcome)}`;
}
