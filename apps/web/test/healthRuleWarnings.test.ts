/* Health page: each agent's latest run shows the rules the screener skipped.
 *
 * WHY. The last screener runs dropped 50 of 50 rows with no visible reason, and since 9a85f0b the
 * reason is persisted - but only into agent_runs.error_detail, which the page did not even select.
 * These tests pin the two ends of the wiring: the read asks for the column, and the per-agent block
 * renders a list for a run that carries warnings and NOTHING for one that does not.
 *
 * Rendered, not grepped: RuleWarningsNote is the component the freshness table draws in each
 * agent's row, rendered by react-dom/server through the same transpile hook the other .tsx tests use. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

// The page module, loaded after the hooks are in place.
let page: typeof import('../src/features/health/HealthPage.tsx');
// The read module, for the column list it sends to PostgREST.
let runs: typeof import('../src/data/useAgentRuns.ts');
// Static markup, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;

before(async () => {
  // Transpiled by the hook.
  page = await import('../src/features/health/HealthPage.tsx');
  // Plain .ts; Node strips the types.
  runs = await import('../src/data/useAgentRuns.ts');
  // From the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
});

// A screener run row as the read returns it; only error_detail varies between cases.
const run = (error_detail: unknown) => ({
  // The agent whose warnings motivated this feature.
  agent: 'screener',
  // A succeeded run is the misleading case: it "worked" and still filtered nothing.
  status: 'succeeded',
  // Timestamps are irrelevant to this block but part of the row's shape.
  started_at: '2026-10-08T00:00:00Z',
  // Closed run; its time is shown in the heading.
  finished_at: '2026-10-08T00:01:00Z',
  // Screened rows, so it is a run whose detail answers the question.
  rows_in: 5,
  // The column under test.
  error_detail,
});

// The block exactly as the freshness table draws it for one agent's latest run.
const block = (r: unknown) => render(h(page.RuleWarningsNote as never, { run: r }));

describe('useAgentRuns selects error_detail', () => {
  it('the column list names error_detail, and is still an explicit list', () => {
    // Split the projection into its columns so a substring like "error_detail_x" cannot pass.
    const columns = runs.AGENT_RUN_COLUMNS.split(',').map((c) => c.trim());
    // The new column, without which the page can never show a warning.
    assert.ok(columns.includes('error_detail'), `columns were ${runs.AGENT_RUN_COLUMNS}`);
    // D3: rows_in is how the page tells a run that screened jobs from an idle one.
    assert.ok(columns.includes('rows_in'), `columns were ${runs.AGENT_RUN_COLUMNS}`);
    // The narrow-projection discipline the file documents: never select('*').
    assert.ok(!columns.includes('*'));
  });
});

describe('RuleWarningsNote renders the latest run\'s skipped rules', () => {
  it('a run with warnings renders a heading and one list item per warning', () => {
    // The two warnings the operator needs to see.
    const html = block(run('1 of 3 rows errored; rule_warnings: degree_mismatch skipped: x | experience_ceiling skipped: y'));
    // The heading scopes the claim to the latest run.
    assert.match(html, /Rules skipped in the last run that screened jobs \(<span class="identifier">2026-10-08T00:01:00Z<\/span>\)/);
    // A real list, one item per warning, in the writer's order.
    assert.match(html, /<ul[^>]*><li[^>]*>degree_mismatch skipped: x<\/li><li[^>]*>experience_ceiling skipped: y<\/li><\/ul>/);
    // The failure summary in front is not rendered as a warning.
    assert.doesNotMatch(html, /rows errored/);
    // Complete list: no truncation note.
    assert.doesNotMatch(html, /list truncated/);
  });

  it('a null, failure-only or missing detail renders NOTHING', () => {
    // A clean run: the column is null.
    assert.equal(block(run(null)), '');
    // A failure with no warnings is the error column's job, not this block's.
    assert.equal(block(run('1 of 3 rows errored')), '');
    // No run at all for this agent.
    assert.equal(block(null), '');
    // A row from a read that predates the column.
    assert.equal(block({ agent: 'screener', status: 'succeeded', started_at: 'x', finished_at: null }), '');
  });

  it('a capped detail says the list is truncated', () => {
    // Exactly the writer's 1000-character cap.
    const detail = `rule_warnings: a | ${'b'.repeat(1000 - 'rule_warnings: a | '.length)}`;
    // Precondition: the fixture really sits at the cap.
    assert.equal(detail.length, 1000);
    // The note that tells the operator the last item may be cut.
    assert.match(block(run(detail)), /\(list truncated\)/);
  });

  it('D1: a detail at the cap with no label says warnings may have been cut off', () => {
    // 1000 characters of failure summary: the writer's slice removed any segment that followed.
    const html = block(run('e'.repeat(1000)));
    // Said out loud, never rendered as nothing.
    assert.match(html, /Rule warnings may have been cut off: this run(&#x27;|')s error detail hit its 1000-character limit\./);
  });

  it('D2: a label whose body cannot be read says so instead of rendering nothing', () => {
    // A trailing labelled segment the writer never produces.
    const html = block(run('rule_warnings: a | b; tz: UTC'));
    // The operator is pointed at the raw column.
    assert.match(html, /Rule warnings were recorded but could not be read; see this run(&#x27;|')s error_detail\./);
  });

  it('warning text is escaped as data, never parsed as markup', () => {
    // A hostile job field can reach a warning (cascade.ts's posted_at message quotes it).
    const html = block(run('rule_warnings: job has an unparseable posted_at "<img src=x onerror=alert(1)>"'));
    // React escaped it: no live tag in the output.
    assert.doesNotMatch(html, /<img/);
    // And the text survives, escaped.
    assert.match(html, /&lt;img src=x/);
  });
});
