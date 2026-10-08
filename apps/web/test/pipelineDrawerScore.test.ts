/* PipelineDrawer read a column that does not exist (2026-10-08).
 *
 * It selected `fit_score`, which no migration defines and the live `applications` table does not
 * have (checked by information_schema the same day; the column is `match_score`). PostgREST refuses
 * an unknown column, so the drawer listed nothing for every status. The page cannot be mounted here
 * without a Supabase double, so this holds the CODE SHAPE of the select and the mapping, on the
 * source with comments stripped: the comment explaining the old bug cannot trip these assertions. */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// apps/web's own typescript, to strip comments without a new dependency.
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
// The drawer as written.
const raw = readFileSync(fileURLToPath(new URL('../src/features/pipeline/PipelineDrawer.tsx', import.meta.url)), 'utf8');
// Comment-free code, literals kept as written.
const code = ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile('d.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));

describe('PipelineDrawer reads the score column that exists', () => {
  it('selects match_score, and never fit_score', () => {
    // The applications select, by its leading columns.
    const select = code.match(/\.select\('id, created_at, [^']*'\)/)?.[0];
    // A missing select must fail, not pass vacuously.
    assert.ok(select !== undefined, 'the drawer select was not found');
    // The real column.
    assert.match(select, /\bmatch_score\b/);
    // The phantom one, anywhere in the code.
    assert.doesNotMatch(code, /\bfit_score\b/);
  });

  it('maps the score only when it is a finite number', () => {
    // Shape check, not `?? null`: a string or NaN must not print as "Match: NaN%".
    assert.match(code, /score: typeof row\.match_score === 'number' && Number\.isFinite\(row\.match_score\) \? row\.match_score : null/);
  });
});
