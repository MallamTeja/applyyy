// STRICT URL SHAPE CHECK — the first of the two deterministic gates between the LLM's
// proposal and the database. The model may SUGGEST a URL; only a URL that matches one of
// the three shapes below, exactly, is allowed to cost us a network request.
//
// WHY A SHAPE CHECK AND NOT "DID new URL() THROW?": a lenient parser answers "is this
// some URL", which is true of `https://greenhouse.io.evil.com/x`. Repo rule (§5): the
// permissiveness of the reader is the fail-open, so we validate the shape we expect.

// The only providers this function can verify, mirroring the adapters in _shared/ats.
export type WebProvider = "greenhouse" | "lever" | "ashby";

// A URL that passed the shape check, reduced to the three facts verification needs.
export interface ParsedJobUrl {
  // Which adapter will fetch the board.
  readonly provider: WebProvider;
  // The board token, as it appeared in the path (already charset-validated).
  readonly token: string;
  // The posting id the board must contain for the URL to count as real.
  readonly jobId: string;
}

// Closed result so a caller must handle the rejection reason, not just a null.
export type UrlParseResult =
  // Accepted: the three facts verification needs.
  | { readonly ok: true; readonly parsed: ParsedJobUrl }
  // Rejected: a short reason the UI displays.
  | { readonly ok: false; readonly reason: string };

// One rule per accepted host. Hosts are matched by EXACT string equality, never by
// suffix or `includes`, which is what makes `greenhouse.io.evil.com` fail.
const RULES: ReadonlyArray<{
  // Exact hostname this rule applies to.
  readonly host: string;
  // Which adapter family owns that host.
  readonly provider: WebProvider;
  // Anchored on both ends; group 1 is the token, group 2 the job id.
  readonly path: RegExp;
// The table is a closed list; adding a host means adding a row and a test.
}> = [
  // Greenhouse's current board host; ids are numeric.
  { host: "job-boards.greenhouse.io", provider: "greenhouse", path: /^\/([A-Za-z0-9_-]+)\/jobs\/(\d+)\/?$/ },
  // Greenhouse's older board host, same path shape.
  { host: "boards.greenhouse.io", provider: "greenhouse", path: /^\/([A-Za-z0-9_-]+)\/jobs\/(\d+)\/?$/ },
  // Lever posting ids are UUIDs; `/apply` is the form page for the same posting.
  {
    // Lever's board host, matched exactly.
    host: "jobs.lever.co",
    // Lever postings are fetched through the lever adapter.
    provider: "lever",
    // Token, then a UUID posting id, optionally the apply page.
    path: /^\/([A-Za-z0-9_-]+)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/apply)?\/?$/,
  },
  // Ashby posting ids are UUIDs; `/application` is the form page for the same posting.
  {
    // Ashby's board host, matched exactly.
    host: "jobs.ashbyhq.com",
    // Ashby postings are fetched through the ashby adapter.
    provider: "ashby",
    // Token, then a UUID posting id, optionally the application page.
    path: /^\/([A-Za-z0-9_-]+)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/application)?\/?$/,
  },
];

// Check one candidate URL against the closed set of shapes.
export function parseJobUrl(raw: string): UrlParseResult {
  // `new URL` is used only to split the string; it is NOT the verdict.
  let url: URL;
  // URL parsing only splits the string; the verdict comes from the rules below.
  try {
    // May throw on garbage input, which is exactly the not_a_url case.
    url = new URL(raw);
  // Swallowing is correct here: the failure IS the answer.
  } catch {
    // Not a URL at all.
    return { ok: false, reason: "not_a_url" };
  }
  // https only: a downgraded scheme is never what a real board link looks like.
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  // Userinfo (`https://greenhouse.io@evil.com`) and custom ports are classic lookalike tricks.
  if (url.username !== "" || url.password !== "" || url.port !== "") return { ok: false, reason: "userinfo_or_port" };
  // The rule whose host equals ours exactly; `hostname` is already lower-cased by the URL parser.
  const rule = RULES.find((r) => r.host === url.hostname);
  // Any other host, including lookalikes, stops here.
  if (rule === undefined) return { ok: false, reason: "host_not_allowed" };
  // The path must match the whole shape, not merely contain it.
  const match = rule.path.exec(url.pathname);
  // Right host, wrong path (a board index, a search page, a blog post).
  if (match === null) return { ok: false, reason: "path_shape_mismatch" };
  // Groups are guaranteed by the regexes but typed optional under noUncheckedIndexedAccess.
  const token = match[1];
  // Same reason as above, for the id.
  const jobId = match[2];
  // Unreachable by construction; refusing keeps the type honest instead of using `!`.
  if (token === undefined || jobId === undefined) return { ok: false, reason: "path_shape_mismatch" };
  // The three facts verification needs, and nothing else from the LLM's string.
  return { ok: true, parsed: { provider: rule.provider, token, jobId } };
}

// Pull every http(s) URL out of free text. Deliberately loose: this only NOMINATES
// candidates, and every one still has to pass parseJobUrl.
export function extractUrls(text: string): string[] {
  // Stops at whitespace and the brackets/quotes that wrap URLs in prose and markdown.
  const found = text.match(/https?:\/\/[^\s)\]>"'<,]+/g) ?? [];
  // Trailing sentence punctuation is not part of a URL but sticks to the match.
  return found.map((u) => u.replace(/[.;:!?]+$/, ""));
}
