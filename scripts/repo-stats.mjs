// repo-stats.mjs — regenerates every count in docs/stack/*-languages-loc-files.md.
// Why it exists: the docs rule (CLAUDE.md, docs/README.md) bans counts in living docs
// unless a command regenerates them. A dated snapshot names THIS script as that command.
// Usage (from the repo root): node scripts/repo-stats.mjs [rev]   (rev defaults to HEAD)
// Read-only: it reads blobs out of git and never writes, so it is safe on a shared tree.
// It reads a COMMIT, not the working copy: several sessions edit this tree at once, and
// two working-copy runs minutes apart disagreed (2026-11-05). A pinned rev makes a dated
// snapshot reproducible to the line: `node scripts/repo-stats.mjs <the sha in the doc>`.

// execFileSync over exec: no shell, so a path with spaces or quotes can't be re-parsed.
import { execFileSync } from 'node:child_process';

// The commit to measure; a doc's snapshot names its sha so anyone can re-run it.
const rev = process.argv[2] ?? 'HEAD';
// Lockfile and big fixtures make the blob stream large; the default 1 MB buffer would throw.
const maxBuffer = 512e6;
// -r recurses, -z NUL-separates so a path with a newline or space can't split a row.
const tree = execFileSync('git', ['ls-tree', '-r', '-z', rev], { maxBuffer })
  // Each entry is "<mode> <type> <sha>\t<path>"; filter drops the trailing empty entry.
  .toString().split('\0').filter(Boolean)
  // Split off the path at the tab, then the type and sha out of the space-separated meta.
  .map((l) => { const [meta, path] = l.split('\t'); const [, type, sha] = meta.split(' '); return { type, sha, path }; })
  // Only blobs are files; a 'commit' entry would be a submodule pointer with no content.
  .filter((e) => e.type === 'blob');
// One cat-file process for every blob: one spawn instead of ~1k `git show` calls.
const stream = execFileSync('git', ['cat-file', '--batch'], { input: tree.map((e) => e.sha).join('\n') + '\n', maxBuffer });
// path → content Buffer. Buffers, not strings, so binary detection sees the raw bytes.
const blobs = new Map();
// Read cursor into the batch stream.
let off = 0;
// cat-file answers in request order: "<sha> blob <size>\n<size bytes>\n" per blob.
for (const e of tree) {
  // End of the header line (10 = '\n').
  const nl = stream.indexOf(10, off);
  // The size is the third header field; it tells us exactly how many bytes to take.
  const size = Number(stream.toString('utf8', off, nl).split(' ')[2]);
  // Slice the content without copying.
  blobs.set(e.path, stream.subarray(nl + 1, nl + 1 + size));
  // Skip the content plus the trailing newline cat-file adds after each blob.
  off = nl + 1 + size + 1;
}
// File list in tree order; every later pass reads from `blobs`.
const files = [...blobs.keys()];
// Content as text for the line-based passes.
const readFileSync = (f) => blobs.get(f).toString('utf8');

// Extension → language label. A closed map, so an unknown extension shows up as itself
// in the report instead of being silently folded into some other language.
const LANG = {
  // Plain TS and module TS share one label: same language, same tooling.
  ts: 'TypeScript', mts: 'TypeScript',
  // TSX kept separate: it is the React UI share, which the docs report on its own.
  tsx: 'TypeScript (TSX)',
  // Every JS flavour is one label; there are only a handful of JS files.
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
  // Database migrations, snippets and tests.
  sql: 'SQL',
  // Styling and markup for the web console and test fixtures.
  css: 'CSS', html: 'HTML',
  // Prose; reported as docs, never as code.
  md: 'Markdown',
  // Config and data formats.
  json: 'JSON', jsonc: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML',
  // Google Apps Script (the Gmail tracker) is JS syntax but a different runtime.
  gs: 'Apps Script',
};

// Lockfiles are machine-written; counting them as code would swamp the real numbers.
const GENERATED = new Set(['pnpm-lock.yaml', 'supabase/functions/deno.lock']);

// Which comment syntax a language uses. 'none' = every non-blank line counts as code.
const commentStyle = (ext) => ({
  // C-family: // line comments and /* */ blocks (TSX {/* */} handled in classify).
  ts: 'c', mts: 'c', tsx: 'c', js: 'c', mjs: 'c', cjs: 'c', jsx: 'c', css: 'c', jsonc: 'c', gs: 'c',
  // SQL adds -- line comments on top of /* */ blocks.
  sql: 'sql',
  // Config formats and shells use # comments.
  yml: 'hash', yaml: 'hash', toml: 'hash',
  // HTML uses <!-- --> blocks.
  html: 'html',
// Anything not listed has no comment syntax we recognise.
}[ext] ?? 'none');

// Split one file's text into blank / comment / code line counts.
// ponytail: a line-start heuristic — a trailing `x(); // why` counts as code, so the
// comment share is a FLOOR. Swap in a real tokenizer only if the floor misleads.
function classify(text, style) {
  // Running totals plus whether we are inside a multi-line block comment.
  let blank = 0, comment = 0, code = 0, inBlock = false;
  // \r?\n because working copies here are CRLF; a bare \n split would leave \r on every line.
  for (const raw of text.split(/\r?\n/)) {
    // Indentation never changes a line's kind.
    const l = raw.trim();
    // Empty after trim = blank, whatever the language.
    if (!l) { blank++; continue; }
    // No known comment syntax: the line is code.
    if (style === 'none') { code++; continue; }
    // Inside a block: count it, and leave the block on the line that closes it.
    if (inBlock) { comment++; if (l.includes(style === 'html' ? '-->' : '*/')) inBlock = false; continue; }
    // C-family and SQL share block syntax, so one branch handles both.
    if (style === 'c' || style === 'sql') {
      // Line comments; SQL's -- only applies to SQL.
      if (l.startsWith('//') || (style === 'sql' && l.startsWith('--'))) { comment++; continue; }
      // Block opener; {/* is the JSX form the repo's .tsx rule requires.
      if (l.startsWith('/*') || l.startsWith('{/*')) { comment++; if (!l.includes('*/')) inBlock = true; continue; }
      // Anything else in a C-family file is code.
      code++; continue;
    }
    // # comments for YAML/TOML.
    if (style === 'hash') { if (l.startsWith('#')) comment++; else code++; continue; }
    // HTML: a <!-- line is a comment and may open a block.
    if (l.startsWith('<!--')) { comment++; if (!l.includes('-->')) inBlock = true; } else code++;
  }
  // Return all three so callers can choose code-only or code+comment totals.
  return { blank, comment, code };
}

// Group a path into the area the docs report on (one row per deployable or package).
const area = (f) => {
  // Path segments; git always uses / even on Windows.
  const p = f.split('/');
  // apps/<app> — today just apps/web.
  if (p[0] === 'apps') return `apps/${p[1]}`;
  // supabase/<part> — functions, migrations, snippets and tests are separate concerns.
  if (p[0] === 'supabase') return `supabase/${p[1]}`;
  // packages/<pkg> — each workspace package is its own row.
  if (p[0] === 'packages') return `packages/${p[1]}`;
  // Files at the repo root (package.json, README.md…) get one bucket.
  if (p.length === 1) return '(root)';
  // Everything else by top-level dir (worker, api, scripts, docs, .github).
  return p[0];
};

// A test is anything named *.test.* / *.spec.* or living under test/, tests/ or e2e/.
const isTest = (f) => /\.test\.|\.spec\.|(^|\/)(test|tests|e2e)\//.test(f);

// Accumulators: per language, per area, and [lines, path] pairs for the size table.
const byLang = {}, byArea = {}, sizes = [];
// Lines in tests vs source, for the "how much of the code is tests" split.
const split = { src: 0, test: 0 };

// One pass over every tracked file.
for (const f of files) {
  // Last extension, lower-cased; '' for dotfiles like .npmrc with no second dot.
  const ext = (f.match(/\.([^./]+)$/)?.[1] ?? '').toLowerCase();
  // Unknown extensions report as themselves (see LANG note).
  const lang = LANG[ext] ?? (ext ? `.${ext}` : '(no ext)');
  // Every tree entry has a blob, so this read can't miss (unlike a working-copy read).
  const text = readFileSync(f);
  // NUL bytes mean binary (a PDF, an image); its "lines" mean nothing.
  const binary = blobs.get(f).includes(0);
  // Lockfiles are counted separately from real code.
  const gen = GENERATED.has(f);
  // Binary files contribute zero lines; everything else is classified.
  const c = binary ? { blank: 0, comment: 0, code: 0 } : classify(text, commentStyle(ext));
  // Language row, created on first sight.
  const L = (byLang[lang] ??= { files: 0, code: 0, comment: 0, blank: 0, generated: 0 });
  // Every tracked file counts toward its language's file count.
  L.files++;
  // Generated lines go in their own column so they never inflate code totals.
  if (gen) L.generated += c.blank + c.comment + c.code;
  // Real files add to the three line kinds.
  else { L.code += c.code; L.comment += c.comment; L.blank += c.blank; }
  // Area row, created on first sight.
  const A = (byArea[area(f)] ??= { files: 0, srcFiles: 0, testFiles: 0, code: 0, comment: 0, mdLines: 0 });
  // Every tracked file counts toward its area's file count.
  A.files++;
  // Generated and binary files stop here: they have no meaningful lines.
  if (gen || binary) continue;
  // Prose is reported apart from code so docs don't read as engineering volume.
  if (lang === 'Markdown') { A.mdLines += c.blank + c.comment + c.code; continue; }
  // Code and comment lines for this area.
  A.code += c.code; A.comment += c.comment;
  // Source vs test, by file count and by non-blank line count.
  if (isTest(f)) { A.testFiles++; split.test += c.code + c.comment; } else { A.srcFiles++; split.src += c.code + c.comment; }
  // JSON is data, not hand-written logic, so it stays out of the largest-files table.
  if (lang !== 'JSON') sizes.push([c.blank + c.comment + c.code, f]);
}

// Header: which commit was measured and how many files it holds.
console.log(`rev: ${execFileSync('git', ['rev-parse', rev]).toString().trim()}`);
// Tracked files at that commit.
console.log(`tracked files: ${files.length}`);
// Language table, biggest by code first.
console.log('\nlanguage | files | code | comment | blank | generated');
// Sort descending by code lines so the dominant languages lead.
for (const [k, v] of Object.entries(byLang).sort((a, b) => b[1].code - a[1].code))
  // One pipe-separated row per language, ready to paste into a markdown table.
  console.log([k, v.files, v.code, v.comment, v.blank, v.generated].join(' | '));

// Language share = code lines only, over the languages that are hand-written logic.
// Markdown, JSON and dotfiles are excluded: they are prose, data and config, not code.
const CODE_LANGS = ['TypeScript', 'TypeScript (TSX)', 'CSS', 'SQL', 'YAML', 'HTML', 'JavaScript', 'Apps Script', 'TOML'];
// Denominator for the percentages.
const total = CODE_LANGS.reduce((s, k) => s + (byLang[k]?.code ?? 0), 0);
// Percent table; one decimal is enough precision for a share.
console.log(`\nlanguage share of ${total} code lines`);
// Same order as CODE_LANGS, which is already largest-first.
for (const k of CODE_LANGS) console.log(`${k} | ${((100 * (byLang[k]?.code ?? 0)) / total).toFixed(1)}%`);

// Area table, biggest by code first.
console.log('\narea | files | src files | test files | code | comment | comment/code | md lines');
// Sort descending by code lines.
for (const [k, v] of Object.entries(byArea).sort((a, b) => b[1].code - a[1].code))
  // comment/code is the comment-rule density floor for that area (see classify note).
  console.log([k, v.files, v.srcFiles, v.testFiles, v.code, v.comment, v.code ? (v.comment / v.code).toFixed(2) : '-', v.mdLines].join(' | '));

// Source vs test split by non-blank lines.
console.log(`\nnon-blank lines: source ${split.src}, tests ${split.test}`);

// Size distribution over hand-written logic files only (no config, no fixtures' JSON).
const logic = sizes.filter(([, f]) => /\.(tsx?|mjs|js|sql|css)$/.test(f)).map(([n]) => n).sort((a, b) => a - b);
// Mean, median and long-file counts show whether a few giant files dominate.
console.log(`\nlogic files: ${logic.length}, mean lines ${Math.round(logic.reduce((s, n) => s + n, 0) / logic.length)}, median ${logic[Math.floor(logic.length / 2)]}, >500 lines ${logic.filter((n) => n > 500).length}, >1000 lines ${logic.filter((n) => n > 1000).length}`);
// The 15 biggest files: the refactor and review hot spots.
console.log('\nlargest files');
// Descending by line count.
for (const [n, f] of sizes.sort((a, b) => b[0] - a[0]).slice(0, 15)) console.log(`${n} | ${f}`);

// Direct npm dependencies per manifest, and the union across the workspace.
console.log('\nmanifest | dependencies | devDependencies');
// A Set dedupes a dependency declared in two manifests (e.g. playwright).
const direct = new Set();
// Every tracked package.json, root included.
for (const f of files.filter((p) => /(^|\/)package\.json$/.test(p))) {
  // Parse; a malformed manifest should crash loudly, not be skipped.
  const j = JSON.parse(readFileSync(f));
  // Names only; versions live in the frameworks doc.
  const d = Object.keys(j.dependencies ?? {}), dd = Object.keys(j.devDependencies ?? {});
  // Add both kinds to the union.
  for (const x of [...d, ...dd]) direct.add(x);
  // One row per manifest.
  console.log([f, d.length, dd.length].join(' | '));
}
// Union size: how many distinct packages the repo asks for by name.
console.log(`unique direct npm packages: ${direct.size}`);

// Resolved package count from the lockfile = direct + transitive, what actually installs.
const lock = readFileSync('pnpm-lock.yaml').split(/\r?\n/);
// Walk the top-level `packages:` section; its 2-space-indented keys are name@version.
let inPackages = false, resolved = 0;
// One pass over lockfile lines.
for (const l of lock) {
  // Entering the section.
  if (/^packages:/.test(l)) { inPackages = true; continue; }
  // Any unindented line ends it (the next top-level key, e.g. snapshots:).
  if (inPackages && /^\S/.test(l)) inPackages = false;
  // A package key: exactly two spaces, then name@version, then a colon.
  if (inPackages && /^ {2}\S.*:$/.test(l)) resolved++;
}
// Final line of the report.
console.log(`lockfile resolved packages (direct + transitive): ${resolved}`);
