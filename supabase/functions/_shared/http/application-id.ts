// The `?application_id=` single-row target, parsed ONCE for every pipeline agent.
//
// WHY SHARED: the same inline UUID regex had been copied into normalizer, screener, auditor,
// matcher and tailor, and the copies had already drifted in the one thing that matters —
// WHERE they ran. The normalizer refused a bad id before opening its agent_runs row; the
// screener refused it after, leaving a `failed` run that told the health page the agent broke
// when only the request was wrong. One parser makes the rule one place to read.
// Used by all five pipeline agents (normalizer, screener, matcher, tailor, auditor), each of
// which refuses a bad id BEFORE opening its agent_runs row — application-id.test.ts guards the order.
//
// WHY A CLOSED UNION, not `string | null`: null already means "no target, whole queue", so a
// parser that also returned null for garbage would turn a malformed id into a whole-queue run —
// the fail-open this repo forbids. Here "invalid" is its own case the caller must handle.
//
// Pure TypeScript with no imports, so Deno edge functions and `node --test` both load it.

// Lowercase or uppercase canonical 8-4-4-4-12 hex UUID, anchored at both ends so surrounding
// whitespace or trailing junk fails instead of being trimmed into a match.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The three answers a request can give, and nothing else: no target, a usable id, or a refusal.
export type ApplicationIdParam =
  // Param missing entirely: the unchanged whole-queue behaviour.
  | { kind: "absent" }
  // A well-formed UUID the handler may filter on.
  | { kind: "valid"; id: string }
  // Present but malformed — including `?application_id=` (empty), which is NOT absent.
  | { kind: "invalid" };

// Classifies the request's `application_id` query parameter.
export function parseApplicationIdParam(params: URLSearchParams): ApplicationIdParam {
  // The one rule, applied to this parameter name.
  return parseUuidParam(params, "application_id");
}

// The same closed classification for ANY uuid-valued query parameter (e.g. the matcher's
// pre-gate sweep cursor `after_id`), so a second parameter never grows a second regex.
export function parseUuidParam(params: URLSearchParams, name: string): ApplicationIdParam {
  // get() returns null ONLY when the key is missing; an empty value comes back as "".
  const raw = params.get(name);
  // Missing key is the one case that means "absent".
  if (raw === null) return { kind: "absent" };
  // Everything else must match exactly; "" fails the pattern and so lands in invalid.
  return UUID_PATTERN.test(raw) ? { kind: "valid", id: raw } : { kind: "invalid" };
}
