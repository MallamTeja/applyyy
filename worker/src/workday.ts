/* The one answer to "is this a Workday job?" (moved out of apply-one.ts on 2026-11-07).
 *
 * WHY ITS OWN FILE. Three callers ask it: apply-one's guard (parks the row), the rehearse CLI
 * (must refuse before it launches a browser) and the web's Manual apply card (says "Bot can't
 * apply: Workday ..."). The web imports worker code by relative path, and apply-one.ts drags in
 * the gateway and the submit path, so the predicate lives here with ZERO imports: any caller,
 * browser included, gets the same definition and none can drift. apply-one re-exports it. */

// Workday's job hosts. A posting on either domain needs a Workday candidate account
// before any form appears, which the applier cannot and must not create.
const WORKDAY_APEXES = ['myworkdayjobs.com', 'myworkdaysite.com'] as const;

// The refusal line every caller prints, so the event log, the CLI table and the card say one thing.
export const WORKDAY_REFUSAL = 'Workday requires a candidate account; applying through Workday is out of scope, so a human applies by hand.';

/**
 * True when the apply URL's HOST is a Workday host: an apex exactly, or a subdomain of
 * one (a dot-anchored suffix, so `evilmyworkdayjobs.com` is not a match). The host
 * comes from `new URL`, never from a substring of the raw string, so a Workday name in
 * a path or query cannot match. An unparseable URL is not Workday; the robots gate
 * refuses it downstream.
 */
export function isWorkdayApplyUrl(applyUrl: string): boolean {
  // The parsed, lower-cased host; null when the string is not a URL.
  let host: string;
  // URL throws on garbage; that is "no host", not an error.
  try {
    // The WHATWG parser lower-cases the host and drops any port.
    host = new URL(applyUrl).hostname;
  } catch {
    // No host, so no match.
    return false;
  }
  // Exact apex, or a label boundary before it.
  return WORKDAY_APEXES.some((apex) => host === apex || host.endsWith(`.${apex}`));
}

/**
 * Either signal is enough. The host catches a Workday link whatever its provider (a pasted
 * link can arrive as `unknown`); the provider catches a tenant fronted on careers.company.com.
 * Null inputs are "not known", never a match: the card shows "—" rather than a guess.
 */
export function isWorkdayJob(applyUrl: string | null, atsProvider: string | null): boolean {
  // Host first (no URL, no host signal), then the provider column.
  return (applyUrl !== null && isWorkdayApplyUrl(applyUrl)) || atsProvider === 'workday';
}
