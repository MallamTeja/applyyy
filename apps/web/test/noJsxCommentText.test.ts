/* Guard: no .tsx under apps/web/src may render comment syntax as visible JSX text.
 *
 * WHY THIS EXISTS. In JSX children position a bare `// note` line is NOT a comment, it is
 * literal text that renders to users. The repo's comment rule pushes comments into JSX, so
 * the defect class is repo-wide (first fixed in WebScoutPanel.tsx, 71edf45).
 * WHY AN AST. A regex cannot tell JsxText from a string attribute or a JS expression, so
 * `href="https://x"` would need a `://` carve-out that also hides `Note://x`. The parser
 * already separates them: only JsxText nodes are checked, URLs elsewhere need no exemption.
 * Assertions match node SHAPE (JsxText), never bare words.
 * NOT REDUNDANT. tsc cannot see this defect (stray text typechecks) and markup-shape tests do
 * not read text, so this is the only gate on it.
 * DO NOT DELETE OR LOOSEN. Never add a `://` carve-out to JsxText; prose that must show a URL
 * belongs in an expression `{'https://x'}` or an attribute. */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// typescript is a devDependency of apps/web, so it is resolved the same way webScoutPanel.test.ts does.
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

// One offender: 1-based line plus the trimmed text that would render.
export type CommentTextHit = { line: number; text: string };

// Walker under test; exported so the self-tests and the tree-wide case share one implementation.
export function findCommentText(fileName: string, sourceText: string): CommentTextHit[] {
  // setParentNodes=true and ScriptKind.TSX so JSX parses even for a name that is not .tsx.
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Collected here so one pass reports every hit.
  const hits: CommentTextHit[] = [];
  // Recursive visit; forEachChild reaches every node kind without a manual switch.
  const visit = (node: import('typescript').Node): void => {
    // Only JsxText is rendered literally; attributes and expressions are other kinds.
    // The `/*` half exists because a bare `/* x */` between tags also renders as text; only `{/* x */}` is a comment.
    if (ts.isJsxText(node) && (node.text.includes('//') || node.text.includes('/*'))) {
      // getStart skips leading whitespace so the reported line is the text's own line, not the preceding tag's.
      const at = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      // Report the first offending line of the node, which is what a fixer must open.
      const bad = node.text.split('\n').find((l) => l.includes('//') || l.includes('/*')) ?? node.text;
      hits.push({ line: at.line + 1, text: bad.trim() });
    }
    // Descend because JsxText hides inside nested elements and expression arrows; skipping children would miss them.
    ts.forEachChild(node, visit);
  };
  // Enter at the SourceFile so every top-level statement is visited exactly once.
  visit(sf);
  return hits;
}

// Recursive file listing with plain fs, to avoid a glob dependency.
function listTsx(dir: string): string[] {
  // Accumulator for this directory level.
  const out: string[] = [];
  // withFileTypes avoids a stat call per entry.
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // Join manually because dir is a filesystem path, not a URL.
    const p = `${dir}/${e.name}`;
    // Directories recurse; only .tsx files are collected.
    if (e.isDirectory()) out.push(...listTsx(p));
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  // Flat so the caller can iterate without knowing the directory depth.
  return out;
}

describe('findCommentText self-tests (walker is neither vacuous nor over-eager)', () => {
  // (a) the defect itself must be caught, or the guard is vacuous.
  it('flags a bare // line between tags', () => {
    // Multi-line source so the hit's line number is also exercised.
    const src = 'const A = () => (\n  <div>\n    <b/>\n    // planted\n    <i/>\n  </div>\n);';
    // Run the walker once and reuse the result for both assertions.
    const hits = findCommentText('a.tsx', src);
    // Exactly one: zero means vacuous, two means double-reporting.
    assert.equal(hits.length, 1);
    // The text is what a fixer greps for, so it must be the trimmed offending line.
    assert.equal(hits[0]!.text, '// planted');
  });
  // (b) the correct JSX comment form must not be flagged.
  it('allows {/* fine */}', () => {
    // {/* */} is an expression container, the sanctioned way to comment in JSX.
    assert.equal(findCommentText('b.tsx', 'const A = () => <div>{/* fine */}<b/></div>;').length, 0);
  });
  // (c) a URL in a string attribute is not JsxText.
  it('allows a URL in a string attribute', () => {
    // Attribute values are string literals, so no JsxText exists to flag.
    assert.equal(findCommentText('c.tsx', 'const A = () => <a href="https://x">go</a>;').length, 0);
  });
  // (d) a URL in a JS string expression is not JsxText.
  it("allows {'https://y'}", () => {
    // A string inside {} is a JS expression, the sanctioned way to show a URL.
    assert.equal(findCommentText('d.tsx', "const A = () => <p>{'https://y'}</p>;").length, 0);
  });
  // (e) a JS comment inside an arrow body within an expression is code, not JsxText.
  it('allows a // comment inside a .map arrow body', () => {
    // Multi-line source because a // comment needs a newline to end it.
    const src = 'const A = () => (\n  <ul>{xs.map((x) => {\n    // why this is here\n    return <li key={x}>{x}</li>;\n  })}</ul>\n);';
    // Arrow-body comments are code inside {}, which the walker must not mistake for text.
    assert.equal(findCommentText('e.tsx', src).length, 0);
  });
  // (f) a URL as bare JsxText IS flagged by design; pins the no-carve-out stance in the header.
  it('flags a URL written as bare JSX text', () => {
    // Raw text renders the `//` to users exactly like a stray comment, so it is a defect.
    assert.equal(findCommentText('f.tsx', 'const A = () => <p>visit https://x</p>;').length, 1);
  });
});

describe('apps/web/src renders no comment syntax as JSX text', () => {
  it('has zero offending JsxText nodes', () => {
    // Anchored to this file, not process.cwd(), because CI and local runs start in different directories.
    const root = fileURLToPath(new URL('../src', import.meta.url));
    // A moved src dir should read as a clear failure, not a raw ENOENT stack.
    assert.ok(existsSync(root), `src dir missing: ${root}`);
    // Collected after the existence check so the check can actually fire.
    const files = listTsx(root);
    // A wrong path must not pass vacuously.
    assert.ok(files.length > 0, `no .tsx found under ${root}`);
    // Gather every hit as path:line: text so one run lists all fixes.
    const offenders = files.flatMap((f) =>
      findCommentText(f, readFileSync(f, 'utf8')).map((h) => `${f.slice(root.length - 'src'.length)}:${h.line}: ${h.text}`),
    );
    assert.deepEqual(offenders, [], `${offenders.length} offender(s) across ${files.length} files:\n${offenders.join('\n')}`);
  });
});
