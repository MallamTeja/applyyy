// Checked-in robots.txt bodies used by the tests.
//
// NOTHING HERE IS FETCHED AT TEST TIME, and that is a deliberate safety property,
// not only a speed one. A test that reaches the network is a flake with an opinion —
// and in the Lever case below, a live fetch in CI would itself be crawling a host
// that has asked us not to. The gate's own tests must not violate the rule the gate
// exists to enforce.
//
// PROVENANCE IS RECORDED PER FIXTURE because these are evidence, and evidence whose
// origin is unstated gets mistaken for a real capture the first time someone reuses
// it. Where a body is synthetic, it says so in the constant's own comment.

// SYNTHETIC — NOT A CAPTURE. Encodes exactly one documented fact and nothing more.
//
// Source of the fact: PROJECT_PLAN.md §19, "`jobs.lever.co` robots.txt — a respected
// restriction, not an obstacle", which records that jobs.lever.co/robots.txt carries
// `User-agent: ClaudeBot` -> `Disallow: /`. Also recorded independently at
// supabase/functions/_shared/ats/lever.ts:7-18 and
// worker/scripts/capture-fixture.ts:57-61.
//
// WHY SYNTHETIC RATHER THAN CAPTURED: fetching it to build a fixture is the exact
// act §19 declined to perform. applyyy-21 set that precedent on 2026-09-09 by
// hand-authoring the Lever DOM fixture and labelling it, and this follows it.
// THE HONEST LIMIT: this proves our matcher handles the rule as DOCUMENTED. It is
// not evidence about the rest of Lever's live file, which we have never read.
export const LEVER_CLAUDEBOT_SYNTHETIC = [
  '# SYNTHETIC FIXTURE — hand-authored from PROJECT_PLAN.md §19, not captured.',
  '# Real source: https://jobs.lever.co/robots.txt (NOT fetched — see §19)',
  '# Authored: 2026-09-17',
  'User-agent: ClaudeBot',
  'Disallow: /',
  '',
  'User-agent: *',
  'Allow: /',
  '',
].join('\n');

// SYNTHETIC — the shape recorded at worker/scripts/capture-fixture.ts:31 on
// 2026-09-09: "robots.txt has every rule commented out, so nothing is disallowed."
//
// THIS IS THE REGRESSION FIXTURE. Upstream's rule-count guard scores this
// identically to an HTML error page, which would refuse a host our own repo lists in
// ALLOWED_HOSTS as human-verified permitted. If a test using this body ever goes
// red, someone has reverted the shape check to counting rules.
export const GREENHOUSE_JOB_BOARDS_ALL_COMMENTED = [
  '# SYNTHETIC — shape from capture-fixture.ts:31, not a capture.',
  '# User-agent: *',
  '# Disallow: /',
  '',
].join('\n');

// SYNTHETIC — the shape recorded at worker/scripts/capture-fixture.ts:29:
// "robots.txt disallows only /embed/; job pages are permitted. Checked 2026-09-09."
export const GREENHOUSE_BOARDS_EMBED_ONLY = [
  '# SYNTHETIC — shape from capture-fixture.ts:29, not a capture.',
  'User-agent: *',
  'Disallow: /embed/',
  '',
].join('\n');

// SYNTHETIC — the shape recorded at worker/scripts/capture-fixture.ts:34-36: Ashby
// "permits /{company}/{id} job pages and disallows /meeting/, /b/ and /api/
// (re-checked 2026-09-10; unchanged, no ClaudeBot-specific rule)".
export const ASHBY_API_DISALLOWED = [
  '# SYNTHETIC — shape from capture-fixture.ts:34-36, not a capture.',
  'User-agent: *',
  'Disallow: /meeting/',
  'Disallow: /b/',
  'Disallow: /api/',
  '',
].join('\n');

// A soft-200: status 200 carrying an HTML error page. The single most important
// negative fixture in the package.
export const SOFT_200_HTML_ERROR = [
  '<!DOCTYPE html>',
  '<html><head><title>404 Not Found</title></head>',
  '<body><h1>Not Found</h1></body></html>',
  '',
].join('\n');
