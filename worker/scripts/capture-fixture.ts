// Captures a real ATS application form to worker/fixtures/ as static HTML.
//
// PROJECT_PLAN.md §19 requires fixtures made from REAL Greenhouse/Lever/Ashby
// markup, because the whole point is to catch real-DOM quirks that a
// hand-written form would never reproduce. This script is the reproducible
// record of how each fixture was obtained, so a stale capture can be refreshed
// without anyone guessing what was done the first time.
//
// SAFETY BOUNDARIES, all non-negotiable:
//   - GET only. This script has no code path that can POST, and must never
//     grow one: constraint #16 forbids testing by submitting a real
//     application, and constraint #5 forbids defeating anti-bot measures.
//   - robots.txt is checked by a human before adding a host to ALLOWED_HOSTS
//     below, and the reasoning is recorded there.
//   - Scripts are stripped before the file is written, so loading a fixture in
//     Playwright can never fire an analytics beacon back at the employer or
//     execute third-party code on the runner.
//
// Usage: node worker/scripts/capture-fixture.ts <url> <output-path>

// Node's promise-based fs; the script writes exactly one file per run.
import { writeFile, mkdir } from 'node:fs/promises';
// dirname is used to create the fixture's parent directory on demand.
import { dirname } from 'node:path';

// Hosts whose robots.txt has been read and permits fetching job pages. Adding a
// host here is a deliberate act that requires re-reading its robots.txt first.
const ALLOWED_HOSTS = new Set([
  // robots.txt disallows only /embed/; job pages are permitted. Checked 2026-09-09.
  'boards.greenhouse.io',
  // robots.txt has every rule commented out, so nothing is disallowed. Checked 2026-09-09.
  'job-boards.greenhouse.io',
  // robots.txt disallows /meeting/, /b/ and /api/; /{company}/{id} job pages are
  // permitted. Checked 2026-09-09.
  'jobs.ashbyhq.com',
]);
// DELIBERATELY ABSENT: jobs.lever.co. Its robots.txt carries an explicit
// "User-agent: ClaudeBot / Disallow: /". A Claude-driven agent fetching Lever
// content to store in a repo is exactly what that line asks us not to do, so
// the Lever fixture is hand-authored and labelled synthetic instead. Do not add
// this host without a human deciding otherwise.

// Identifies the tool honestly rather than impersonating a browser. Spoofing a
// UA to look like a human is an anti-bot circumvention and breaks constraint #5.
const USER_AGENT = 'applyy-fixture-capture/0.1 (personal job-search tool; read-only)';

/** Remove executable and beacon-firing content from captured markup. */
function sanitize(html: string): string {
  return (
    html
      // Inline and external scripts go first: a fixture must be inert. Without
      // this, every local test run would phone analytics home from the runner.
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      // noscript bodies are dead weight once scripts are gone.
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
      // Third-party frames are almost always recaptcha or trackers. The
      // surrounding recaptcha DIV is deliberately KEPT so the applier's
      // captcha-detection path (§7 blocked_needs_human) has something real to
      // detect; only the frame that would load remote code is removed.
      .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
      // Preconnect/prefetch hints reach out to third parties on page load.
      .replace(/<link\b[^>]*rel=["'](?:preconnect|dns-prefetch|prefetch|preload)["'][^>]*>/gi, '')
  );
}

/** Fetch one job page and write it as a provenance-stamped fixture. */
async function main(): Promise<void> {
  // Positional args keep the script dependency-free; a flag parser would be
  // more machinery than two arguments justify.
  const [url, outputPath] = process.argv.slice(2);
  // Fail loudly on misuse rather than writing a file somewhere unintended.
  if (!url || !outputPath) {
    throw new Error('usage: node worker/scripts/capture-fixture.ts <url> <output-path>');
  }

  // Parsing before fetching means a malformed URL fails here, not mid-request.
  const parsed = new URL(url);
  // The allowlist is the robots.txt enforcement point. A host nobody has
  // checked cannot be fetched by accident.
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`host not in ALLOWED_HOSTS (robots.txt unreviewed): ${parsed.hostname}`);
  }
  // Query strings on job links are overwhelmingly tracking parameters
  // (gh_src, utm_*). Dropping them satisfies "strip anything identifying"
  // and keeps the recorded provenance URL clean and re-fetchable.
  parsed.search = '';

  // The one network call. GET is the default and is never overridden.
  const response = await fetch(parsed.toString(), { headers: { 'user-agent': USER_AGENT } });
  // A non-200 means we captured an error page, which is worse than no fixture.
  if (!response.ok) {
    throw new Error(`fetch failed: HTTP ${response.status} for ${parsed.toString()}`);
  }
  // Raw markup, exactly as served, before any of our own processing.
  const raw = await response.text();

  // An interstitial is the signal to stop and hand-author this board instead of
  // finding a way through it — working around it would breach constraint #5.
  if (/just a moment|checking your browser|cf-challenge/i.test(raw)) {
    throw new Error('anti-bot interstitial detected; hand-author this fixture instead');
  }

  // Provenance header so a future reader knows what this file is, where it came
  // from and how stale it is. ATS vendors reskin their forms; an undated
  // fixture silently becomes a test of markup nobody serves any more.
  const header = [
    '<!--',
    '  APPLYY TEST FIXTURE — captured real ATS application form.',
    `  Source : ${parsed.toString()}`,
    `  Captured: ${new Date().toISOString()}`,
    '  Method : read-only HTTP GET, robots.txt reviewed, scripts stripped.',
    '  NOT a live page. Served from localhost by worker/src/fixture-server.ts.',
    '  Never submitted to. See PROJECT_PLAN.md §19 and constraint #16.',
    '-->',
    '',
  ].join('\n');

  // Create the fixture subdirectory (greenhouse/, ashby/, ...) if it is new.
  await mkdir(dirname(outputPath), { recursive: true });
  // Sanitized body only; the raw response is intentionally never persisted.
  await writeFile(outputPath, header + sanitize(raw), 'utf8');
  // Report the size so an unexpectedly tiny capture (a JS shell rather than a
  // real form) is obvious immediately rather than at first test failure.
  console.log(`wrote ${outputPath} (${sanitize(raw).length} bytes)`);
}

// Surface failures as a non-zero exit so a bad capture cannot pass unnoticed.
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
