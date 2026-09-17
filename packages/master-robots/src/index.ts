// @applyy/master-robots — the robots.txt compliance gate.
//
// WHAT THIS PACKAGE IS FOR. PROJECT_PLAN.md constraint #5: "DON'T bypass CAPTCHAs,
// MFA, authentication controls, robots restrictions, or anti-bot mechanisms." Until
// now that constraint was enforced by a hand-maintained allowlist in
// worker/scripts/capture-fixture.ts, where a human read each host's robots.txt and
// recorded the finding in a comment. That works and is honest, but it is one call
// site carrying a rule the whole system needs — A COMMENT IS NOT A CONTROL. This
// package is the control: one function every fetch path can cross.
//
// THE DESIGN RULE THE WHOLE PACKAGE OBEYS: make the wrong answer UNREPRESENTABLE,
// not merely detected. The failure this exists to prevent is missing or malformed
// data becoming an answer — a soft-200 HTML error page parsing to zero rules and
// reading as "allow all", a 403 read through RFC 9309's "4xx means allow all" and
// GRANTING permission at the moment we were blocked, a garbage Retry-After read as
// "retry immediately" because Date.parse("-5") is the year -5 rather than NaN. Each
// was closed by a type that cannot express the wrong value, not by a check:
//   - A body that fails the shape check never becomes a Ruleset, empty or otherwise.
//   - RobotsSource keeps `definitively-absent` and `indeterminate` apart, so "no
//     policy published" and "we could not tell" cannot be merged and silently flipped.
//   - verdictFor() is total over that union: a new arm fails to COMPILE until
//     somebody decides its verdict.
//   - productToken is required with no default, so omitting it is a compile error
//     rather than a permissive runtime answer.
//
// ZERO RUNTIME DEPENDENCIES ON WORKSPACE PACKAGES, and this is load-bearing rather
// than tidiness: it is what lets `node --test` run this package today, with an empty
// root node_modules and no install. Adding a workspace dependency breaks that. The
// single cross-tree import, in fetch.ts, is to a dependency-free pure function.
//
// WHAT THIS PACKAGE DELIBERATELY DOES NOT DO: it never retries a refusal under a
// different identity. Upstream's gate re-fetches robots.txt with a browser
// User-Agent when the honest request is refused; that defeats the site's refusal and
// is exactly what constraint #5 forbids. Not ported, and it must not be added.

// The gate itself, and the decision table it runs.
export { checkRobots, robotsUrlFor, verdictFor } from './gate.ts';
export {
  DEFAULT_FAILURE_TTL_MS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_SUCCESS_TTL_MS,
  type CacheEntry,
  type RobotsCache,
  type RobotsOptions,
} from './gate.ts';

// The fetch seam, so a caller can supply its own transport without this package
// importing one.
export { DEFAULT_TIMEOUT_MS, fetchRobotsSource, type RobotsFetcher, type RobotsResponse } from './fetch.ts';

// The vocabulary. Exported so callers can hold and switch over a RobotsSource rather
// than re-deriving one, and so a consumer's own exhaustiveness checks work.
export type { GroupSelection, RobotsGroup, RobotsVerdict, RobotsSource, Rule, Ruleset } from './types.ts';

// The pieces below are exported for callers that already hold a robots.txt body —
// worker/scripts/capture-fixture.ts is the intended first consumer — and for tests.
export { classifyRobotsBody, MAX_ROBOTS_BYTES, type BodyShape } from './shape.ts';
export { parseRobotsTxt } from './parse.ts';
// tokenFromUserAgentHeader is the supported way down from a header to a token. It is
// exported rather than applied internally because a caller holding only a header
// should have to see the conversion happen.
export { isPathAllowed, selectGroup, tokenFromUserAgentHeader } from './match.ts';
