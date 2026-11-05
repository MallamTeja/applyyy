/* Add to Applied (2026-11-05): the slug the web sends to track_email_as_applied, and the guard that no
 * screen ever offers discovered -> applied on a scouted row (the orchestrator's condition 2).
 *
 * WHY THE GUARD: migration 20261105124600 adds discovered -> applied for ONE database function. Offered
 * as a button on a scouted discovered row, it would mark a never-applied posting as applied in one click.
 * Every screen builds its moves through humanLanes.ts screenMoves(), which drops RPC-only edges; the
 * source scan below goes red if any screen calls nextStatuses(..., 'human') directly again. */

// The .tsx loader, for ManualApplyPage's kitResolveMoves.
import './support/registerTsxHooks.ts';
// Strict asserts.
import assert from 'node:assert/strict';
// File walk for the source scan.
import { readdirSync, readFileSync } from 'node:fs';
// Paths.
import { join } from 'node:path';
// node:test.
import { describe, it, before } from 'node:test';
// Plain .ts modules under test.
import { companySlugOf } from '../src/features/emails/emailView.ts';
import { RPC_ONLY_HUMAN_EDGES, screenMoves } from '../src/data/humanLanes.ts';
import { APPLICATION_STATUSES, nextStatuses } from '../src/data/contract.ts';

// The Manual apply page, for its card move filter.
let page: typeof import('../src/features/manual-apply/ManualApplyPage.tsx');
// The Emails page, for its Add to Applied refusal text.
let emails: typeof import('../src/features/emails/EmailMonitoringPage.tsx');

before(async () => {
  // Transpiled by the hook.
  page = await import('../src/features/manual-apply/ManualApplyPage.tsx');
  // Same hook; the page module exports the pure text builder beside the component.
  emails = await import('../src/features/emails/EmailMonitoringPage.tsx');
});

describe('companySlugOf: the one slug rule (scout-web slugFromToken: lowercase, non-alphanumerics to "-", trimmed)', () => {
  it('matches the shape the RPC accepts, across awkward names', () => {
    // [input, expected]: spaces, &, Inc./Ltd, accents, unicode, punctuation runs, digits, edges.
    const cases: [string, string][] = [
      ['Acme', 'acme'],
      ['Johnson & Johnson', 'johnson-johnson'],
      ['Acme Inc.', 'acme-inc'],
      ['Tata Consultancy Services Ltd', 'tata-consultancy-services-ltd'],
      ['Zoë Labs', 'zo-labs'],
      ['  --Stripe--  ', 'stripe'],
      ['3M', '3m'],
      ['日本', ''],
      ['AT&T / Bell Labs', 'at-t-bell-labs'],
    ];
    // Each one, named on failure.
    for (const [input, expected] of cases) assert.equal(companySlugOf(input), expected, input);
    // Every non-empty result satisfies the SQL check in track_email_as_applied.
    for (const [input] of cases) {
      // The slug.
      const slug = companySlugOf(input);
      // Empty is refused by the page before any call; anything else must pass the SQL regex.
      if (slug !== '') assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, input);
    }
  });
});

describe('Add to Applied refusal text: says what to do, never a raw SQLSTATE', () => {
  it('a refused Add to Applied names the pipeline status and says to open it there', () => {
    // The supabase-js shape: the RPC RETURNS { data, error }, it does not throw. 23514 = the transition guard.
    const result = { data: null, error: { code: '23514', message: 'illegal status transition awaiting_approval -> applied' } };
    // The status in words (underscores as spaces, as StatusBadge shows it) plus the action; no raw message.
    assert.equal(emails.addRefusalText(result.error), 'Not added: this job is already in your pipeline at awaiting approval; open it there.');
  });

  it('an unrelated error keeps its old text', () => {
    // A different SQLSTATE: the database's own words, as before.
    assert.equal(emails.addRefusalText({ code: '42501', message: 'permission denied' }), 'Not added: permission denied');
  });

  it('23514 with any other message shape is not mapped (no substring match)', () => {
    // Same code, a different check constraint: shown as-is, never guessed into a pipeline status.
    assert.equal(emails.addRefusalText({ code: '23514', message: 'new row violates check constraint "jobs_company_slug_check"' }), 'Not added: new row violates check constraint "jobs_company_slug_check"');
    // The shape with a target other than applied: not this refusal either.
    assert.equal(emails.addRefusalText({ code: '23514', message: 'illegal status transition scored -> dropped' }), 'Not added: illegal status transition scored -> dropped');
  });
});

describe('no screen offers discovered -> applied', () => {
  it('the graph has the edge, and it is RPC-only', () => {
    // Present: the migration and the mirror agree (enum-parity checks the SQL side).
    assert.ok(nextStatuses('discovered', 'human').includes('applied'));
    // Listed as RPC-only.
    assert.ok(RPC_ONLY_HUMAN_EDGES.some((e) => e.from === 'discovered' && e.to === 'applied'));
  });

  it('screenMoves never returns an RPC-only edge, for any status', () => {
    // Every status the console can draw.
    for (const status of APPLICATION_STATUSES) {
      // The moves a screen may draw.
      const moves = screenMoves(status);
      // None of them is RPC-only.
      for (const edge of RPC_ONLY_HUMAN_EDGES) if (edge.from === status) assert.ok(!moves.includes(edge.to), `${status} -> ${edge.to} offered`);
    }
  });

  it('the Manual apply card offers no applied move on a discovered row', () => {
    // The card filter is the one with "applied" in its target set.
    assert.ok(!page.kitResolveMoves('discovered').includes('applied'));
  });

  it('no screen builds moves from nextStatuses(..., "human") directly (they must go through screenMoves)', () => {
    // Every source file under src/.
    const root = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    // Recursive listing, .ts/.tsx only.
    const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.tsx?$/.test(e.name)).map((e) => join(e.parentPath, e.name));
    // Non-vacuous: the walk found the app.
    assert.ok(files.length > 50, `only ${files.length} files found`);
    // Code calls, comments stripped first so a doc mention is not a hit.
    const offenders = files.filter((f) => !f.endsWith('humanLanes.ts') && /nextStatuses\([^)]*'human'\)/.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/<span[^>]*>nextStatuses\([^<]*<\/span>/g, '')));
    // None outside humanLanes.ts.
    assert.deepEqual(offenders, []);
  });
});
