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
//   - TWO INDEPENDENT GATES must BOTH permit a capture, and resolveCaptureTarget
//     below is the only place either one is evaluated. Read that function's
//     comment for why one gate is not enough.
//   - Scripts are stripped before the file is written, so loading a fixture in
//     Playwright can never fire an analytics beacon back at the employer or
//     execute third-party code on the runner.
//
// WHY THIS SCRIPT IS @applyy/master-robots' FIRST CONSUMER. That package's
// index.ts names this file as its intended first caller, and until 2026-09-17
// the robots decision here was a human reading each host's robots.txt by hand
// and recording the finding in a comment beside the hostname. That record is
// real knowledge and is KEPT below — but it is a snapshot of one afternoon in
// September that nothing re-reads. A COMMENT IS NOT A CONTROL. The live gate is
// now the control; the human notes are its supporting evidence, not its stand-in.
//
// Usage: node worker/scripts/capture-fixture.ts <url> <output-path>

// Node's promise-based fs; the script writes exactly one file per run.
import { writeFile, mkdir } from 'node:fs/promises';
// dirname creates the fixture's parent directory on demand; resolve normalises
// argv[1] so the direct-invocation check at the bottom compares like with like.
import { dirname, resolve } from 'node:path';
// Imported by RELATIVE PATH, not as the bare specifier '@applyy/master-robots',
// and that is deliberate rather than lazy. A bare specifier would require adding
// the package to worker/package.json, which rewrites pnpm-lock.yaml — a
// single-owner file in a tree four sessions share. The relative path costs
// nothing at install time and is the same technique master-robots itself uses to
// reach the shared Retry-After parser. Node 24 strips the types on load, so this
// runs with no build step and no install.
import {
  checkRobots,
  tokenFromUserAgentHeader,
  type RobotsOptions,
} from '../../packages/master-robots/src/index.ts';

// GATE ONE: hosts a human has personally reviewed. Adding a host here is a
// deliberate act that requires re-reading its robots.txt first. This is NOT a
// cached copy of what the live gate computes — see resolveCaptureTarget for why
// the two gates are answering different questions.
const HUMAN_REVIEWED_HOSTS = new Set([
  // robots.txt disallows only /embed/; job pages are permitted. Checked 2026-09-09.
  'boards.greenhouse.io',
  // robots.txt has every rule commented out, so nothing is disallowed. Checked 2026-09-09.
  'job-boards.greenhouse.io',
]);
// DELIBERATELY ABSENT: jobs.ashbyhq.com. Its robots.txt permits /{company}/{id}
// job pages and disallows /meeting/, /b/ and /api/ (re-checked 2026-09-10;
// unchanged, no ClaudeBot-specific rule). A RAW GET of a job page would
// therefore be allowed — but a raw GET is useless here, because Ashby is a
// client-rendered SPA and returns no form fields. The plan calls for a
// Playwright-RENDERED snapshot, and rendering is what makes this impossible:
//
// Measured 2026-09-10 by navigating with every disallowed path ABORTED, so none
// was ever fetched. The SPA attempts `/api/non-user-graphql` and
// `/api/images/...`, both under the disallowed `/api/` prefix. With those
// aborted, the board listing still rendered (146 job links are server-rendered)
// but BOTH a job page and its /application page rendered ZERO inputs. There is
// no way to capture an Ashby application form without fetching a disallowed path.
//
// AND NO SYNTHETIC ASHBY FIXTURE WAS WRITTEN INSTEAD, deliberately. We have
// never seen Ashby's real form DOM, so a hand-authored one would be invented
// markup — precisely the failure PROJECT_PLAN.md section 19 records for
// Greenhouse, where a hand-authored fixture "would have encoded a convention no
// employer actually serves, and it would have looked correct in review". A
// fixture that creates false confidence about a vendor whose DOM we have never
// observed is worse than no fixture. Teja can settle this by saving a page from
// his own browser as a human visitor, or by ruling on the robots question.
//
// DELIBERATELY ABSENT: jobs.lever.co. Its robots.txt carries an explicit
// "User-agent: ClaudeBot / Disallow: /". A Claude-driven agent fetching Lever
// content to store in a repo is exactly what that line asks us not to do, so
// the Lever fixture is hand-authored and labelled synthetic instead. Do not add
// this host without a human deciding otherwise.
//
// LEVER IS ALSO THE PROOF THAT GATE ONE MUST SURVIVE GATE TWO. That Disallow
// addresses the token `claudebot`. We identify honestly as the token derived
// below, `applyy-fixture-capture`, so the live gate selects the `*` group, finds
// no matching restriction, and returns ALLOW. Deleting this list in favour of
// the live check alone would make this script MORE permissive than it is today
// and would quietly overturn a documented human decision. That is why the list
// stays, and why "replace the allowlist with the gate" was the wrong change.

// Identifies the tool honestly rather than impersonating a browser. Spoofing a
// UA to look like a human is an anti-bot circumvention and breaks constraint #5.
const USER_AGENT = 'applyy-fixture-capture/0.1 (personal job-search tool; read-only)';
/**
 * Derive the RFC 9309 product token from our User-Agent, or refuse to start.
 *
 * tokenFromUserAgentHeader returns `string | null` on purpose — it will not guess,
 * because a guessed token silently selects the wildcard group and grants us
 * permissions addressed to somebody else. That makes the null OURS to handle, and
 * the two tempting shortcuts are both fail-opens wearing different hats: a `!`
 * assertion hands the gate `null` at runtime, and a `?? 'applyy-fixture-capture'`
 * fallback re-types by hand the very string this call exists to stop duplicating.
 * Throwing is the honest third option — the script cannot run without a token, so
 * failing at load beats fetching under an identity nobody chose.
 */
function requireProductToken(header: string): string {
  // The package's own supported conversion, so header and token cannot drift apart.
  const token = tokenFromUserAgentHeader(header);
  // Reachable only if someone edits USER_AGENT into a shape with no leading
  // product token — which is precisely when a silent wildcard match would be worst.
  if (token === null) {
    throw new Error(`USER_AGENT has no derivable robots product token: ${header}`);
  }
  return token;
}

// DERIVED from the header rather than written out a second time. A hand-typed
// second copy is exactly the drift bug worth removing: the two would be edited at
// different moments and the gate would end up deciding about a crawler that is not
// the one fetching. checkRobots wants the PRODUCT TOKEN, never the full header.
const PRODUCT_TOKEN = requireProductToken(USER_AGENT);

/**
 * Decide whether `rawUrl` may be captured, and return the exact URL to fetch.
 *
 * THE ONE FUNCTION EVERY PATH CROSSES. It returns the fetch target rather than a
 * boolean so that main() cannot obtain a URL to fetch without passing the gates:
 * an ungated fetch would have to invent its own target, which is a visible act
 * rather than a forgotten call.
 *
 * WHY TWO GATES. They answer different questions and neither subsumes the other:
 *   Gate one — has a HUMAN reviewed this host at all? It encodes judgements no
 *     robots.txt can express: Ashby is excluded because RENDERING it requires
 *     fetching disallowed /api/ paths, and Lever is excluded because its refusal
 *     is addressed to a sibling token (see the note above).
 *   Gate two — does the host's policy permit THIS PATH RIGHT NOW? It catches the
 *     one thing a dated comment structurally cannot: a policy that changed after
 *     a human read it.
 * Both must permit. Either one refusing is a refusal.
 *
 * The query string is stripped BEFORE either gate runs, so the URL that is
 * judged is byte-identical to the URL that is fetched. Gating one URL and
 * fetching another is a hole no amount of strictness in the gate can close.
 */
export async function resolveCaptureTarget(rawUrl: string, options: RobotsOptions = {}): Promise<URL> {
  // Parsing first means a malformed URL fails here rather than mid-request, and
  // gives both gates a real hostname to reason about.
  const target = new URL(rawUrl);
  // Query strings on job links are overwhelmingly tracking parameters (gh_src,
  // utm_*). Dropping them satisfies "strip anything identifying", keeps the
  // recorded provenance URL clean and re-fetchable, and — the part that matters
  // for safety — fixes the path the robots gate is about to match against.
  target.search = '';

  // GATE ONE. A host nobody has checked cannot be fetched by accident.
  if (!HUMAN_REVIEWED_HOSTS.has(target.hostname)) {
    throw new Error(`host not in HUMAN_REVIEWED_HOSTS (robots.txt unreviewed by a human): ${target.hostname}`);
  }

  // GATE TWO. `options` is forwarded whole so a test can inject a fetcher and a
  // clock; in production it is empty and the package uses the global fetch.
  const verdict = await checkRobots(target.toString(), PRODUCT_TOKEN, options);

  // Switching over the discriminated verdict rather than reading a convenience
  // boolean — the package deliberately publishes no `allowed` field, because the
  // moment one exists every caller branches on it and `wait` silently collapses
  // into `refuse` or, worse, into `allow`.
  switch (verdict.kind) {
    // The only branch that yields a fetchable URL.
    case 'allow':
      return target;

    // Covers the deliberate deviation from RFC 9309 as well as an ordinary
    // disallow: a 403 arrives here as a refusal, where the RFC would have read
    // "4xx means allow all" and granted permission at the exact moment a WAF
    // blocked us. `source` is quoted so an operator can tell a policy refusal
    // from a soft-200 without re-running the capture.
    case 'refuse':
      throw new Error(`robots.txt refuses this capture: ${verdict.reason} [${verdict.source}]`);

    // A 429 the host asked us to honour. This script does NOT sleep and retry:
    // it is a one-shot manual capture with a human watching, and a gate that
    // blocks is the kind callers eventually wrap in a timeout that swallows it
    // and proceeds anyway. Refusing with the wait printed fails closed and is
    // honest about what happened.
    case 'wait':
      throw new Error(`host asked us to retry in ${verdict.waitMs}ms; re-run the capture after that`);

    default: {
      // Exhaustiveness check, and it is the actual control: a new verdict arm
      // added upstream fails to COMPILE here rather than falling through to
      // whichever branch happens to be written last.
      const unhandled: never = verdict;
      throw new Error(`unhandled robots verdict: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Remove executable and beacon-firing content from captured markup. */
export function sanitize(html: string): string {
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

  // Both gates run here and nowhere else, and the URL fetched below is the one
  // they returned — main() never constructs a fetch target of its own.
  const target = await resolveCaptureTarget(url);

  // The one network call. GET is the default and is never overridden.
  const response = await fetch(target.toString(), { headers: { 'user-agent': USER_AGENT } });
  // A non-200 means we captured an error page, which is worse than no fixture.
  if (!response.ok) {
    throw new Error(`fetch failed: HTTP ${response.status} for ${target.toString()}`);
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
    `  Source : ${target.toString()}`,
    `  Captured: ${new Date().toISOString()}`,
    '  Method : read-only HTTP GET, human review + live robots.txt gate passed, scripts stripped.',
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

// Run main ONLY when this file is the process entry point. Without this guard a
// test importing resolveCaptureTarget would execute a capture on import — the
// script would reach the network during a test run, or more likely throw a usage
// error that reads like a broken test rather than a misconfigured import.
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  // Surface failures as a non-zero exit so a bad capture cannot pass unnoticed.
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
