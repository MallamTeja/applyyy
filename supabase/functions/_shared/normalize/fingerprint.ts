// Dedupe primitive for PROJECT_PLAN.md §9: `jobs` holds a posting ONCE globally,
// so the same requisition seen on Greenhouse, LinkedIn and Naukri must reduce to
// one identical key. Pure and synchronous — no clock, no network, no database —
// because §19 wants this covered by cheap table-driven tests.

// The identity fields a fingerprint is allowed to consider. Anything not listed
// here is deliberately excluded from dedupe.
export interface JobIdentity {
  // The employer, as whichever board happened to spell it.
  readonly company: string;
  // The role title, as posted.
  readonly title: string;
  // Optional because aggregators routinely omit location entirely.
  readonly location?: string | undefined;
  // Present in the type ONLY to document that it is ignored: requisition ids are
  // per-board, so including one would give the same job three fingerprints.
  readonly reqId?: string | undefined;
}

// Legal-entity suffixes that appear on aggregators and not on the ATS board.
// Kept to incorporation words only — stripping "Technologies" would merge
// genuinely different employers such as "Zoho" and "Zoho Technologies".
const COMPANY_LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  // Indian private-limited forms, which arrive as two separate tokens.
  "pvt", "private", "ltd", "limited", "llp",
  // American and European forms seen on Greenhouse/Lever/Ashby boards.
  "inc", "incorporated", "corp", "corporation", "co", "llc", "plc", "gmbh", "bv", "ag",
]);

// Cities whose official rename never reached the job boards, so both spellings
// are live in the same week. Mapping to one side is what makes them collapse.
const CITY_ALIASES: ReadonlyMap<string, string> = new Map([
  // Official since 2014, still posted as Bangalore by most recruiters.
  ["bengaluru", "bangalore"],
  // Renamed 2016; Naukri listings use both interchangeably.
  ["gurugram", "gurgaon"],
  // Pre-rename spellings that still appear on older or foreign-run boards.
  ["bombay", "mumbai"],
  ["calcutta", "kolkata"],
  ["madras", "chennai"],
]);

// Country tokens stripped from the tail of a location. Deliberately narrow: this
// system only targets Indian and remote roles (§8 location allowlist), and a
// broad list would merge "Remote - US" into "Remote - India".
const TRAILING_COUNTRY_TOKENS: ReadonlySet<string> = new Set(["india", "bharat"]);

// Shared text fold: everything below reduces to a lowercase, punctuation-free,
// single-spaced token stream so that only real word differences survive.
function foldText(value: string): string {
  return value
    // Decompose accented characters so the combining marks become separate code
    // points that the next step can delete.
    .normalize("NFKD")
    // Drop the combining marks themselves, so "Bengalūru" folds onto "Bengaluru".
    .replace(/[̀-ͯ]/g, "")
    // Case is pure board styling — Greenhouse title-cases, Naukri shouts.
    .toLowerCase()
    // Any non-alphanumeric run becomes a single space, which is what makes
    // "Back-End", "Back/End" and "Back End" the same two tokens.
    .replace(/[^a-z0-9]+/g, " ")
    // Collapse the runs the previous step may have doubled up.
    .replace(/\s+/g, " ")
    // Leading/trailing space would otherwise change the joined key.
    .trim();
}

// Company normalization: fold, then peel legal suffixes off the tail. Exported since 2026-11-10 (T12): the remote scout
// matches an aggregator's company to an ATS board with it (company_slug is a separate dash-joined slug, so it cannot).
export function normalizeCompany(company: string): string {
  // Start from the folded token stream.
  const tokens = foldText(company).split(" ");
  // Peel from the end because "Zomato Pvt Ltd" carries two suffixes stacked.
  while (tokens.length > 1 && COMPANY_LEGAL_SUFFIXES.has(tokens[tokens.length - 1] as string)) {
    // Drop the suffix and re-check, so both "Pvt" and "Ltd" go.
    tokens.pop();
  }
  // Rejoin what is left — the actual brand name.
  return tokens.join(" ");
}

// Title normalization: strip bracketed noise BEFORE folding, because folding
// destroys the brackets that mark it as noise.
function normalizeTitle(title: string): string {
  // "(Remote)", "[Hyderabad]" and "{Urgent}" are board decoration, not the role.
  const withoutBrackets = title.replace(/[([{][^)\]}]*[)\]}]/g, " ");
  // Seniority words are intentionally preserved: §8 filters on them, and
  // "Senior Backend Engineer" is a different job from "Backend Engineer".
  return foldText(withoutBrackets);
}

// Location normalization: fold, alias cities, then drop a trailing country.
function normalizeLocation(location: string | undefined): string {
  // A missing location is normal input, not an error — it folds to empty.
  if (location === undefined) return "";
  // Parentheses are NOT stripped here (unlike titles): "remote (india)" and
  // "Remote - India" must land on the same tokens, so the inner word must stay.
  const tokens = foldText(location).split(" ").filter((token) => token.length > 0);
  // Apply the rename map token-by-token so "bengaluru" meets "bangalore".
  const aliased = tokens.map((token) => CITY_ALIASES.get(token) ?? token);
  // Only the tail is checked, so a company literally named "India" survives.
  while (aliased.length > 1 && TRAILING_COUNTRY_TOKENS.has(aliased[aliased.length - 1] as string)) {
    // "hyderabad india" becomes "hyderabad"; "remote india" becomes "remote".
    aliased.pop();
  }
  // Rejoin into the comparable form.
  return aliased.join(" ");
}

// The human-readable dedupe key. Returned as a string rather than a hash so a
// SQL query can show WHY two postings merged — hash-only dedupe is undebuggable.
export function canonicalJobKey(identity: JobIdentity): string {
  // "|" is safe as a separator because foldText has already removed every
  // non-alphanumeric character from the three parts, so it cannot appear inside.
  return [
    normalizeCompany(identity.company),
    normalizeTitle(identity.title),
    normalizeLocation(identity.location),
  ].join("|");
}

/**
 * THE CROSS-SOURCE KEY (2026-11-10, T12): one posting reached through an aggregator (Jobicy, RemoteOK, Arbeitnow) and
 * through the employer's ATS. canonicalJobKey cannot see them as one: the feeds report a feed region ("Anywhere") and the
 * ATS reports the board location ("Remote, Global"), so 257 live pairs sat as two rows each, 3 of them twice in the
 * approval queue. NOT a replacement for the fingerprint (re-keying 36k rows is out; docs/status/2026-11-09-identity-drift.md).
 *
 * Location-free, and the title is folded WITHOUT normalizeTitle's bracket strip: a false twin DROPS a real job, and the
 * live data showed "(New Grad 2027)", "(Spanish speaking)", "(L3)" and "(Fintech)" variants that are different roles.
 * Measured on 2026-11-10: 240 of the 257 pairs match; the 17 lost are 8 distinct roles split correctly and ~9 true twins
 * whose bracket holds a place or "(Remote)" (a missed twin costs a duplicate, never a job).
 */
export function crossSourceKey(company: string, title: string): string {
  // "|" cannot occur inside either part: foldText removed every non-alphanumeric character.
  return `${normalizeCompany(company)}|${foldText(title)}`;
}

// Fixed-width digest of the canonical key, for the UNIQUE index in §9. Async
// because Web Crypto is the one hashing API present in BOTH Deno (Edge
// Functions) and Node (the worker) without importing anything.
export async function jobFingerprint(identity: JobIdentity): Promise<string> {
  // All the normalization decisions live in the tested pure function above; this
  // layer must never add rules of its own or the two would drift.
  const key = canonicalJobKey(identity);
  // UTF-8 bytes, so the digest is stable regardless of host string encoding.
  const bytes = new TextEncoder().encode(key);
  // SHA-256 rather than a fast 32-bit hash: at tens of thousands of jobs a
  // 32-bit collision is ~1% likely, and a collision silently deletes a real job.
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  // Fixed-width lowercase hex is what the database column stores.
  return Array.from(new Uint8Array(digest))
    // Two hex chars per byte, zero-padded so the length is always 64.
    .map((byte) => byte.toString(16).padStart(2, "0"))
    // One flat string.
    .join("");
}
