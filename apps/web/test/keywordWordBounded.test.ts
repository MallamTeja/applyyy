/* Approval page JD-keyword matching is WORD-BOUNDED, never a raw substring. Pinned 2026-10-06.
 *
 * Earned 2026-10-06: diffAdapter's keywordAppearsInTracedText / keywordAppearsInFlaggedText
 * matched by case-insensitive substring, so "Go" was credited from "Google Cloud Platform" and
 * "Rails" from "Guardrails" - inflating the ATS Match Score with skills the resume never named.
 * Both now delegate to the producer's rule in supabase/functions/_shared/tailor/jd-keywords.ts,
 * so the page and the extractor that wrote selected_jd_keywords cannot disagree.
 *
 * Vocabulary facts used (read from jd-keywords.ts, not assumed):
 *   Go    -> exact("Go|Golang")   case-SENSITIVE, word-bounded
 *   Rails -> word("rails")        case-insensitive, word-bounded
 *   SQL   -> word("sql")          case-insensitive, word-bounded
 *   AI    -> exact("AI")          case-SENSITIVE, word-bounded
 *
 * Tested THROUGH the two diffAdapter exports (the web's real path), not the producer helper,
 * so a regression in the delegation itself goes red here. Assertions are booleans only. */

import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// Copied verbatim from coverageUnmeasured.test.ts: diffAdapter.ts has extensionless relative
// imports that Vite resolves and Node does not.
registerHooks({
  // Extensionless RELATIVE imports only: try the original, then .tsx, then .ts.
  resolve(specifier, context, nextResolve) {
    // Packages and already-extended paths resolve normally.
    if (!specifier.startsWith('.') || /\.[cm]?[jt]sx?$|\.css$/.test(specifier)) return nextResolve(specifier, context);
    // First the way Vite would write it, so a real .js sibling still wins.
    try { return nextResolve(specifier, context); } catch { /* fall through to TS extensions */ }
    // A component is the usual case for an extensionless import here.
    try { return nextResolve(`${specifier}.tsx`, context); } catch { /* then a plain module */ }
    // Last resort; a genuine miss throws from here with the .ts path named.
    return nextResolve(`${specifier}.ts`, context);
  },
  // Same load hook as the other web render tests.
  load(url, context, nextLoad) {
    // Stylesheets have no runtime meaning in Node.
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    // Only .tsx needs transpiling; .ts is type-stripped by Node itself.
    if (!url.endsWith('.tsx')) return nextLoad(url, context);
    // apps/web's own typescript, no new dependency.
    const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
    // nextLoad refuses .tsx, so read it directly.
    const source = readFileSync(fileURLToPath(url), 'utf8');
    // react-jsx matches tsconfig.
    const out = ts.transpileModule(source, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    // Plain ESM for Node.
    return { format: 'module', source: out.outputText, shortCircuit: true };
  },
});

// The module under test; typed from its source so a renamed export fails typecheck too.
let adapter: typeof import('../src/features/approval/diffAdapter.ts');

before(async () => {
  // Loaded after the hooks so the resolve hook applies to its imports.
  adapter = await import('../src/features/approval/diffAdapter.ts');
});

// One DiffLine holding a single run: the two functions read only tailoredRuns[].text/.verdict,
// so the rest of the heavy DiffLine shape is irrelevant and cast away.
const lines = (text: string, verdict: 'traced' | 'fabricated' = 'traced') =>
  [{ tailoredRuns: [{ text, verdict }] }] as never;
// Traced-text shorthand, since most cases are about the match rule, not the verdict split.
const traced = (keyword: string, text: string) => adapter.keywordAppearsInTracedText(keyword, lines(text));

describe('JD keyword matching on the approval page is word-bounded', () => {
  it('Google Cloud Platform does not credit Go', () => {
    // The red-on-revert case: a substring match finds "go" inside "Google".
    assert.equal(traced('Go', 'Google Cloud Platform'), false);
  });

  it('Guardrails does not credit Rails', () => {
    // "rails" is the tail of "Guardrails"; the left word bound must refuse it.
    assert.equal(traced('Rails', 'Tool Calling & Guardrails'), false);
  });

  it('Ruby on Rails does credit Rails', () => {
    // The positive control: without it, a function returning false always would pass the above.
    assert.equal(traced('Rails', 'Ruby on Rails'), true);
  });

  it('PostgreSQL alone does not satisfy SQL, but a standalone SQL does', () => {
    // "SQL" is the tail of "PostgreSQL"; a substring match would credit it.
    assert.equal(traced('SQL', 'PostgreSQL'), false);
    // Same text plus a bounded "SQL" proves the refusal above is about bounds, not the word.
    assert.equal(traced('SQL', 'SQL and PostgreSQL'), true);
  });

  it('Go is case-sensitive: the language matches, the verb does not', () => {
    // Capitalised and bounded: the technology.
    assert.equal(traced('Go', 'Built services in Go'), true);
    // The pattern also accepts the alternate name, so a resume saying Golang is credited.
    assert.equal(traced('Go', 'Golang microservices'), true);
    // Lowercase "go" is the English verb; exact() must refuse it.
    assert.equal(traced('Go', 'owned the go to market plan'), false);
  });

  it('AI is case-sensitive and never found inside English words', () => {
    // The capitalised acronym as its own word: the technology.
    assert.equal(traced('AI', 'AI agents'), true);
    // "ai" inside "said" fails the word bound.
    assert.equal(traced('AI', 'the lead said so'), false);
    // "ai" inside "maintain" fails the word bound.
    assert.equal(traced('AI', 'maintain the pipeline'), false);
    // Lowercase standalone "ai" fails the case rule, isolating exact() from the bounds.
    assert.equal(traced('AI', 'ai agents'), false);
  });

  it('a keyword outside the vocabulary is still word-bounded and case-insensitive', () => {
    // Unknown terms fall back to a bounded case-insensitive literal: lowercase still matches.
    assert.equal(traced('Zorblax', 'zorblax tool'), true);
    // ...but never as a prefix of a longer word, i.e. never a substring.
    assert.equal(traced('Zorblax', 'Zorblaxify'), false);
  });

  it('verdict split: fabricated text counts only as flagged, traced text only as traced', () => {
    // A fabricated run carrying a real bounded match.
    const fab = lines('Ruby on Rails', 'fabricated');
    // A flagged claim must never earn honest coverage.
    assert.equal(adapter.keywordAppearsInTracedText('Rails', fab), false);
    // It is reported as matched-by-fabrication instead.
    assert.equal(adapter.keywordAppearsInFlaggedText('Rails', fab), true);
    // The same text, traced to the master.
    const ok = lines('Ruby on Rails', 'traced');
    // Honest coverage.
    assert.equal(adapter.keywordAppearsInTracedText('Rails', ok), true);
    // And not double-counted as fabrication.
    assert.equal(adapter.keywordAppearsInFlaggedText('Rails', ok), false);
  });
});
