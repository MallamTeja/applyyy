/* Discovered option B (Teja, 2026-11-08 17:06 IST): the list stops downloading the full job description
 * (~1.9 MB and cold TOAST reads per page) WITHOUT a visible change. The card shows a generated 600-char
 * preview; the degree filter reads a generated boolean computed from the full text; search matches the rest
 * of the description on the server; the JD modal reads the full text on open. Each piece is pinned here, so
 * reverting any one of them turns a named test red.
 */
// Strict asserts: deepEqual compares by structure and type.
import assert from 'node:assert/strict';
// Reads the page source for the shape checks (apps/web has no DOM renderer).
import { readFileSync } from 'node:fs';
// The runner apps/web uses everywhere.
import { describe, it } from 'node:test';
// Resolves source paths relative to this file, so cwd does not matter.
import { fileURLToPath } from 'node:url';

// The list module under test, by path with its extension, as node's ESM resolver requires.
import { DISCOVERED_LIST_SELECT, ilikeLiteral, searchLoadedDescriptions } from '../src/features/discovery/discoveredList.ts';
// The filter cascade under test.
import { evaluateJobMatch } from '../src/features/settings/filtersStore.ts';
// Types only.
import type { CascadeJobFields, FilterRuleConfig } from '../src/features/settings/filtersStore.ts';

// The page's source, for the shape checks.
const page = readFileSync(fileURLToPath(new URL('../src/features/discovery/DiscoveredJobsPage.tsx', import.meta.url)), 'utf8');

/** A job that passes every rule except, possibly, the degree rule. */
function job(requiresDegree: boolean): CascadeJobFields {
  // Fields chosen so no other rule can drop it.
  return {
    title: 'Software Engineer',
    locations: ['Hyderabad, India'],
    location_raw: 'Hyderabad, India',
    work_arrangement: 'remote',
    employment_type: 'full_time',
    min_experience_years: null,
    requires_advanced_degree: null,
    description_requires_degree: requiresDegree,
  } as unknown as CascadeJobFields;
}

// Only the degree rule enabled, so its verdict is the cascade's.
const DEGREE_ONLY: readonly FilterRuleConfig[] = [{ ruleType: 'degree_mismatch', isEnabled: true, config: {} }];

/** A fake supabase-js client that records the query chain and answers with `answer`. */
function recordingClient(answer: { data: unknown; error: { message: string } | null }) {
  // Every builder call, in order, as [method, ...args].
  const calls: unknown[][] = [];
  // The builder: every method records itself and returns the builder; awaiting it yields `answer`.
  const builder: Record<string, unknown> = {};
  // Each method the search uses.
  for (const method of ['select', 'eq', 'gte', 'ilike', 'limit']) {
    // Recorded, chainable.
    builder[method] = (...args: unknown[]) => {
      // Kept for the assertions.
      calls.push([method, ...args]);
      // Chainable, like PostgREST's builder.
      return builder;
    };
  }
  // Thenable, so `await` resolves to the supabase-js result shape ({ data, error }; it never throws).
  builder['then'] = (resolve: (value: unknown) => unknown) => resolve(answer);
  // The client: from() records the table.
  const client = { from: (table: string) => { calls.push(['from', table]); return builder; } };
  // Both, for the test.
  return { client: client as never, calls };
}

describe('Discovered option B: the full description stays on the server (2026-11-08)', () => {
  it('discovered list never selects description_raw', () => {
    // The preview and the degree flag are selected...
    assert.match(DISCOVERED_LIST_SELECT, /description_preview, description_requires_degree/);
    // ...and the full description is not.
    assert.doesNotMatch(DISCOVERED_LIST_SELECT, /description_raw/);
  });

  it('the degree rule reads the generated column, not the description text', () => {
    // Flagged by Postgres: dropped with the description reason.
    assert.deepEqual(evaluateJobMatch(job(true), DEGREE_ONLY, false), { passed: false, dropReason: "Job description requires Master's or PhD degree" });
    // Not flagged: passes.
    assert.deepEqual(evaluateJobMatch(job(false), DEGREE_ONLY, false), { passed: true });
  });

  it('search asks the server for the loaded window, with the term made literal', async () => {
    // One matching row.
    const { client, calls } = recordingClient({ data: [{ id: 'app-1' }], error: null });
    // A term with LIKE wildcards in it.
    const answer = await searchLoadedDescriptions(client, 'passed_filters', '2026-11-08T00:00:00Z', '100%_go', 300);
    // The matching ids.
    assert.deepEqual('ids' in answer ? [...answer.ids] : answer, ['app-1']);
    // The chain: the lane, the window's lower bound, the literal pattern on the joined full text, bounded.
    assert.deepEqual(calls, [
      ['from', 'applications'],
      ['select', 'id, job:job_id!inner(id)'],
      ['eq', 'status', 'passed_filters'],
      ['gte', 'created_at', '2026-11-08T00:00:00Z'],
      ['ilike', 'job.description_raw', '%100\\%\\_go%'],
      ['limit', 300],
    ]);
  });

  it('a failed server search is an error to say, never an empty match set', async () => {
    // supabase-js returns the error as data.
    const { client } = recordingClient({ data: null, error: { message: 'timeout' } });
    // Asked.
    const answer = await searchLoadedDescriptions(client, 'passed_filters', '2026-11-08T00:00:00Z', 'kafka', 300);
    // Said by name.
    assert.deepEqual(answer, { error: 'timeout' });
  });

  it('ilikeLiteral escapes every LIKE and PostgREST wildcard', () => {
    // Backslash, percent, underscore and PostgREST's star each get a backslash.
    assert.equal(ilikeLiteral('a\\b%c_d*e'), 'a\\\\b\\%c\\_d\\*e');
  });

  it('the card shows the preview and the modal reads the full description on open', () => {
    // The card's excerpt comes from the generated preview.
    assert.match(page, /jdPlainText\(job\.description_preview\)\.slice\(0, 220\)/);
    // The modal reads one job's full text by id.
    assert.match(page, /\.from\('jobs'\)\.select\('description_raw'\)\.eq\('id', jobId\)\.maybeSingle\(\)/);
    // And renders what it read, not the list's preview.
    assert.match(page, /jdPlainText\(jdFull\.text\)/);
  });

  it('local search unions the preview with the server answer for the same term', () => {
    // The server half is used only for the exact term it answered.
    assert.match(page, /descSearch\.term === q && 'ids' in descSearch/);
    // Either half matching counts.
    assert.match(page, /description_preview\?\.toLowerCase\(\)\.includes\(q\) \?\? false\) \|\| serverMatch/);
  });
});
