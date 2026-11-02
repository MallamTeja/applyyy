#!/usr/bin/env node
// =============================================================================
// deploy-drift.mjs: which edge functions run code that is older than origin/main?
//
// WHY THIS EXISTS (audit W37, 2026-11-01): nothing records which commit each edge
// function was deployed from. A function's code is not just its own folder: it is
// every file its index.ts reaches through relative imports (_shared, packages/*,
// even apps/web/src). packages/shared-types/src/status-flow.ts, for example, is
// RUNTIME code inside every function that calls canTransition, so a "types" edit
// can silently split prod from main. This script finds that split.
//
// HOW: for each deployed function it walks the import closure on origin/main, then
// lists the origin/main commits that touch the closure and were committed AFTER the
// function's last deploy (updated_at from `supabase functions list`).
//
// READ-ONLY: it runs `git` and `supabase functions list` and writes nothing.
// Usage and the limits of the method: docs/tooling/2026-11-02-deploy-drift.md.
// =============================================================================

// Runs git and the supabase CLI synchronously; a report script has nothing to overlap.
import { execFileSync, execSync } from 'node:child_process';
// POSIX path rules, because git paths use "/" even on Windows.
import path from 'node:path/posix';

// The one Supabase project this repo deploys to (CLAUDE.md §3).
const PROJECT_REF = 'xynqxekcqizwhtskzqrq';
// The ref a deploy is compared with. A stale local copy hides drift, so its sha and
// date are printed below; run `git fetch` first.
const MAIN = 'origin/main';

// Every git call goes through here: utf8 text, and a large buffer for `git log`.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

// The user env SUPABASE_ACCESS_TOKEN belongs to the WRONG account and turns this
// call into a 403 (CLAUDE.md §4), so the child process gets a copy without it.
const env = { ...process.env };
// Removed, not blanked: an empty token is still a token to the CLI.
delete env.SUPABASE_ACCESS_TOKEN;
// On Windows the CLI is an npm .cmd shim that execFile cannot start, so this one
// fully static command string goes through the shell (no user input reaches it).
const listing = execSync(`supabase functions list --project-ref ${PROJECT_REF} -o json`, {
  // Text, not a Buffer, for JSON.parse.
  encoding: 'utf8',
  // The token-free environment built above.
  env,
  // stderr carries the CLI's "new version available" notice; keep it off stdout.
  stdio: ['ignore', 'pipe', 'inherit'],
});
// Parse the SHAPE we need and refuse anything else (CLAUDE.md §6): an error page or
// an empty array must not read as "nothing is deployed, so nothing drifted".
const deployed = JSON.parse(listing);
// An empty or non-array listing is a failed read, not an empty project.
if (!Array.isArray(deployed) || deployed.length === 0) throw new Error('supabase functions list returned no functions');
// Each row must carry a slug and a numeric deploy time, or its drift cannot be judged.
for (const f of deployed) if (typeof f.slug !== 'string' || !Number.isFinite(f.updated_at)) throw new Error(`unexpected row: ${JSON.stringify(f)}`);

// Every file on origin/main, so an import can be resolved without touching the
// working tree (which holds peers' uncommitted edits on this shared checkout).
const onMain = new Set(git('ls-tree', '-r', '--name-only', MAIN).split('\n').filter(Boolean));
// One `git show` per file, cached: closures overlap heavily through _shared.
const cache = new Map();
// Reads a file's content as of origin/main.
const read = (file) => {
  // First reader pays for the spawn; every later closure reuses it.
  if (!cache.has(file)) cache.set(file, git('show', `${MAIN}:${file}`));
  // The cached text.
  return cache.get(file);
};

// Relative specifiers and @applyy/* bare names, in `from '…'`, `import('…')` and
// side-effect `import '…'`. npm:, jsr: and https: imports are external and skipped.
// A match inside a comment only adds a file, which errs toward reporting drift.
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"]((?:\.{1,2}\/|@applyy\/)[^'"]+)['"]/g;

// Turns one import specifier into a file path on origin/main, or null.
function resolve(fromFile, spec) {
  // A bare @applyy/<pkg> name goes to that package's "." export (all point at src/index.ts).
  if (spec.startsWith('@applyy/')) {
    // The package folder is the name after the scope.
    const pkgJson = `packages/${spec.slice('@applyy/'.length)}/package.json`;
    // Unknown package: let the caller record it as unresolved.
    if (!onMain.has(pkgJson)) return null;
    // The export map entry, resolved relative to the package root.
    return path.normalize(path.join(path.dirname(pkgJson), JSON.parse(read(pkgJson)).exports['.']));
  }
  // A relative specifier is relative to the importing file's folder.
  const base = path.normalize(path.join(path.dirname(fromFile), spec));
  // Deno requires the extension, but try the usual fallbacks so nothing is missed.
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (onMain.has(candidate)) return candidate;
  // Not on origin/main at all.
  return null;
}

// Depth-first walk from one entry point; returns every reachable file plus misses.
function closure(entry) {
  // Visited files; also the result.
  const seen = new Set();
  // Files still to scan.
  const stack = [entry];
  // Specifiers that resolved to nothing: a closure with holes under-reports drift.
  const missing = [];
  // Until every reachable file has been scanned.
  while (stack.length) {
    // Next file to scan.
    const file = stack.pop();
    // Already scanned through another path.
    if (seen.has(file)) continue;
    // Mark before scanning, so an import cycle terminates.
    seen.add(file);
    // Every import in this file.
    for (const [, spec] of read(file).matchAll(IMPORT)) {
      // Where it points on origin/main.
      const target = resolve(file, spec);
      // Found: scan it too. Not found: record it, so the reader sees the hole.
      if (target) stack.push(target); else missing.push(`${file} -> ${spec}`);
    }
  }
  // Sorted, so two runs print the same thing.
  return { files: [...seen].sort(), missing };
}

// verify_jwt is deployed WITH the function but lives in config.toml, outside any
// import closure, so it is compared directly: live value vs origin/main's value.
const repoVerifyJwt = new Map();
// The [functions.<name>] section the parser is currently inside, if any.
let section = null;
// One pass over the TOML; only two line shapes matter.
for (const line of read('supabase/config.toml').split(/\r?\n/)) {
  // A section header: remember which function it belongs to (null for any other table).
  const header = line.match(/^\s*\[([^\]]+)\]/);
  // Entering a new table ends the previous function's section.
  if (header) { section = header[1].startsWith('functions.') ? header[1].slice('functions.'.length) : null; continue; }
  // A verify_jwt setting inside a function section.
  const setting = section && line.match(/^\s*verify_jwt\s*=\s*(true|false)\b/);
  // Recorded as a real boolean, never as the raw string.
  if (setting) repoVerifyJwt.set(section, setting[1] === 'true');
}

// Function folders on origin/main: an index.ts directly under a non-underscore dir.
const onMainFns = [...onMain].filter((f) => /^supabase\/functions\/[^/_][^/]*\/index\.ts$/.test(f)).map((f) => f.split('/')[2]);
// Live slugs, for the two set differences below.
const liveSlugs = new Set(deployed.map((f) => f.slug));
// Deploy times are shown in IST, the zone every log and handoff in this repo uses.
const ist = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 16);
// The comparison point, so a stale origin/main is visible rather than silent.
const [mainSha, mainDate] = git('log', '-1', '--format=%h|%cI', MAIN).trim().split('|');

// Header lines.
console.log(`${MAIN} = ${mainSha} (${mainDate}); ${deployed.length} functions live on ${PROJECT_REF}`);
// A folder with no deploy at all is the most extreme drift.
console.log(`on main, never deployed: ${onMainFns.filter((f) => !liveSlugs.has(f)).join(' ') || '(none)'}`);
// A live function whose source left main is code nobody can rebuild.
console.log(`live, not on main:       ${[...liveSlugs].filter((s) => !onMainFns.includes(s)).join(' ') || '(none)'}`);
// Blank line before the table.
console.log('');

// One table row per live function that still exists on main.
const rows = [];
// Commit lists for the drifted functions, printed after the table.
const details = [];
// Alphabetical, so the table reads the same every run.
for (const fn of deployed.filter((f) => onMainFns.includes(f.slug)).sort((a, b) => a.slug.localeCompare(b.slug))) {
  // Everything this function's index.ts reaches.
  const { files, missing } = closure(`supabase/functions/${fn.slug}/index.ts`);
  // git %ct is in seconds; updated_at is in milliseconds.
  const deployedSec = Math.floor(fn.updated_at / 1000);
  // Commits on origin/main touching the closure, newest first. config.toml is left out
  // on purpose: one commit there would count against all 17 functions; verify_jwt is
  // compared directly instead (column below).
  const commits = git('log', '--format=%h|%ct|%cI|%s', MAIN, '--', ...files)
    // One line per commit.
    .split('\n').filter(Boolean).map((l) => l.split('|'))
    // Committed after the deploy. Proxy, not proof: see the doc's "limits" section.
    .filter(([, ct]) => Number(ct) > deployedSec);
  // The value a deploy from origin/main would set; the CLI default is true.
  const repoJwt = repoVerifyJwt.get(fn.slug) ?? true;
  // Closure files outside the function's own folder and _shared, e.g. packages/*.
  const outside = files.filter((f) => !f.startsWith('supabase/functions/')).length;
  // The table row.
  rows.push({
    // Function name.
    function: fn.slug,
    // Live version number (counts that function's deploys; says nothing about age).
    v: fn.version,
    // When it was last deployed.
    deployed_ist: ist(fn.updated_at),
    // Closure size, and how much of it lives outside supabase/functions.
    closure: `${files.length} (${outside} outside)`,
    // The headline: commits the live code does not have.
    commits_since: commits.length,
    // Live vs repo; a mismatch is drift even with zero commits.
    verify_jwt: fn.verify_jwt === repoJwt ? String(repoJwt) : `LIVE ${fn.verify_jwt} != main ${repoJwt}`,
    // Unresolved imports make the closure (and so the count) a lower bound.
    unresolved: missing.length,
  });
  // Drifted functions get their commit list, with the closure files each one touched.
  if (commits.length) details.push(`${fn.slug}:\n` + commits.map(([h, , date, subject]) => {
    // Which closure files this commit changed, so the reader can judge if it matters.
    const touched = git('show', '--format=', '--name-only', h, '--', ...files).split('\n').filter(Boolean);
    // One indented line per commit, then its files.
    return `  ${h} ${date.slice(0, 16)} ${subject}\n      ${touched.join('\n      ')}`;
  }).join('\n'));
  // Holes are printed, never swallowed.
  if (missing.length) details.push(`${fn.slug} UNRESOLVED imports:\n  ${missing.join('\n  ')}`);
}

// The drift table.
console.table(rows);
// Then the evidence behind every non-zero row.
if (details.length) console.log(`\n${details.join('\n\n')}`);
