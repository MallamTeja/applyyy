/* Read-only verifier for 2026-11-01-master-v9-entry-links.sql. Run BEFORE applying.
 *
 *   node supabase/snippets/2026-11-01-master-v9-entry-links.verify.ts
 *
 * Runs two SELECTs through the linked Supabase CLI (the v8 row, and the snippet as
 * it ships - a preview SELECT while its APPLY lines are commented) and checks the
 * computed v9 with the repo's OWN code, not a re-implementation:
 *   1. the preview returned exactly one row (every SQL guard passed);
 *   2. every v8 NodeId survives into v9, and v9 has no duplicate id (master-ingest's
 *      collectNodeIds / findDuplicateNodeIds, which walk cert and achievement links);
 *   3. each moved link sits under its owner, identical to its v8 copy;
 *   4. NOTHING ELSE CHANGED: undoing the three moves gives back v8 exactly;
 *   5. the master preview renders all three as clickable anchors (the web's
 *      masterAsResume + the shared renderer, i.e. what Teja will actually see).
 * Prints ids and verdicts only - never profile text, which holds personal data.
 * Exits 1 on any failure. Writes nothing anywhere.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The real id walk and duplicate check - the same code reconcile's postcondition uses.
import { collectNodeIds, findDuplicateNodeIds } from '../../packages/master-ingest/src/index.ts';
// The renderer's own escaping, so the expected anchor is byte-exact.
import { escapeHtml, renderResumeHtml, safeHref } from '../../packages/resume-template/src/index.ts';
// The web preview's master->resume mapping, the path the master editor renders through.
import { masterAsResume } from '../../apps/web/src/features/resume-preview/renderPreview.ts';
// Contract types, erased at runtime.
import type { MasterLink, MasterProfile } from '../../packages/shared-types/src/index.ts';

// The v8 row's digest, the same anchor the snippet's SQL uses.
const V8_HASH = '495786a21d886b7d62489fecf72a4fca5062d8332770a9425e2de6bd987d8fe7';
// The moves the snippet makes, restated so the check is independent of the SQL text.
const MOVES = [
  { linkId: 'link_cert_prompt_eng', section: 'certifications', ownerId: 'cert_prompt_eng' },
  { linkId: 'link_cert_ibm_ml', section: 'certifications', ownerId: 'cert_ibm_ml' },
  { linkId: 'link_leetcode', section: 'achievements', ownerId: 'ach_leetcode' },
] as const;

// Runs one read-only query through the linked CLI and returns its rows.
function query(args: readonly string[]): Record<string, unknown>[] {
  // Unset the user env token: it belongs to the WRONG account (repo CLAUDE.md section 4).
  const env = { ...process.env };
  // Delete rather than blank, so the CLI falls back to its own linked login.
  delete env['SUPABASE_ACCESS_TOKEN'];
  // shell on Windows, where `supabase` is a .cmd/.exe shim the plain spawn cannot find.
  const shell = process.platform === 'win32';
  // A shell joins args with bare spaces, so a SQL argument must be double-quoted
  // or cmd splits it into words (measured: the CLI then printed its help text).
  const quoted = shell ? args.map((a) => (a.includes(' ') ? `"${a}"` : a)) : [...args];
  // JSON pinned explicitly: the CLI's default is text, and JSON only by agent auto-detect.
  const run = spawnSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', ...quoted], { env, encoding: 'utf8', shell });
  // A CLI failure is a failed check, never an empty result.
  assert.equal(run.status, 0, `supabase db query failed: ${run.stderr}`);
  // The CLI prints { rows: [...] } (plus a boundary/warning); only rows are data.
  const parsed = JSON.parse(run.stdout) as { rows?: Record<string, unknown>[] };
  // Shape check: no rows array means the output format changed, not "zero rows".
  assert.ok(Array.isArray(parsed.rows), 'CLI output had no rows array; format changed?');
  return parsed.rows;
}

// A jsonb column may arrive as an object or as its JSON text, depending on CLI version.
function asProfile(value: unknown): MasterProfile {
  // Text -> parse; object -> as is.
  return (typeof value === 'string' ? JSON.parse(value) : value) as MasterProfile;
}

// Every id in a profile, sorted, so two profiles compare as multisets.
function sortedIds(profile: MasterProfile): string[] {
  return collectNodeIds(profile).map((o) => o.id).sort();
}

// The snippet file, resolved next to this script so cwd does not matter.
const sqlPath = fileURLToPath(new URL('./2026-11-01-master-v9-entry-links.sql', import.meta.url));

// 0. The v8 row, by digest.
const v8Rows = query([`select profile from public.master_profiles where content_hash = '${V8_HASH}'`]);
// Exactly one row, or the anchor is wrong.
assert.equal(v8Rows.length, 1, `expected 1 v8 row by content_hash, got ${v8Rows.length}`);
// Parsed.
const v8 = asProfile(v8Rows[0]?.['profile']);

// 1. The snippet as shipped (APPLY lines commented) is the preview SELECT.
const previewRows = query(['-f', sqlPath]);
// One row means all three SQL guards passed; zero means one failed.
assert.equal(previewRows.length, 1, `preview returned ${previewRows.length} rows; a SQL guard failed`);
// The computed v9.
const v9 = asProfile(previewRows[0]?.['profile']);
console.log('PASS 1 preview returned 1 row (guards passed)');

// 2. Every v8 id survives, nothing new appears, nothing collides.
assert.deepEqual(sortedIds(v9), sortedIds(v8), 'v9 id multiset differs from v8');
// The postcondition reconcile itself enforces.
assert.deepEqual(findDuplicateNodeIds(v9), [], 'v9 has a duplicate NodeId');
console.log(`PASS 2 all ${sortedIds(v8).length} v8 ids kept, no duplicates`);

// 3. Each link under its owner, identical to the v8 top-level copy, and gone from the top.
for (const move of MOVES) {
  // The link as v8 held it.
  const original = v8.links.find((l) => l.id === move.linkId);
  // Missing in v8 means the brief's facts are stale.
  assert.ok(original !== undefined, `${move.linkId} not in v8 top-level links`);
  // Its owner in v9.
  const owner = (v9[move.section] as readonly { id: string; links?: readonly MasterLink[] }[]).find((n) => n.id === move.ownerId);
  // The owner's copy, byte-identical.
  assert.deepEqual(owner?.links?.find((l) => l.id === move.linkId), original, `${move.linkId} not under ${move.ownerId}`);
  // And not left behind at the top.
  assert.equal(v9.links.some((l) => l.id === move.linkId), false, `${move.linkId} still in top-level links`);
}
console.log('PASS 3 three links under their owners, removed from top-level');

// 4. Undo the moves on a copy; what remains must be v8 exactly.
const undone = structuredClone(v9) as unknown as Record<string, any>;
// The three owners had no links key in v8, so the undo deletes it.
for (const move of MOVES) delete undone[move.section].find((n: { id: string }) => n.id === move.ownerId).links;
// Top-level links back to v8's.
undone['links'] = v8.links;
// Deep equality with the stored v8: any other drift fails here.
assert.deepEqual(undone, v8, 'v9 differs from v8 beyond the three moves');
console.log('PASS 4 nothing else changed');

// 5. The master preview renders each as a clickable anchor.
const html = renderResumeHtml(masterAsResume(v9, 9));
// One byte-exact anchor per moved link.
for (const move of MOVES) {
  // The renderer's own escaping of this link.
  const link = v8.links.find((l) => l.id === move.linkId)!;
  // Present in the HTML.
  assert.ok(html.includes(`<a href="${safeHref(link.url)}">${escapeHtml(link.label)}</a>`), `${move.linkId} did not render as an anchor`);
}
// And v8 still renders (the absent-key shape) without throwing.
renderResumeHtml(masterAsResume(v8, 8));
console.log('PASS 5 three anchors render; v8 still renders');
console.log('ALL PASS - safe to apply (orchestrator only).');
