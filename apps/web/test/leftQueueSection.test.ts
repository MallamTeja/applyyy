/* The "Left your queue" section of Manual apply (2026-11-07): jobs Teja approved that are no longer
 * waiting for him, with who moved them and why. These tests pin the static render of the section: the
 * collapsed default, the three read states, the actor wording, the Re-open button rules and the
 * shape-proven times and links. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose equality cannot pass a wrong shape.
import assert from 'node:assert/strict';
// The runner; before() loads the modules once.
import { describe, it, before } from 'node:test';
// Reads the page source for the wiring check.
import { readFileSync } from 'node:fs';
// Turns the test-relative URL into a path readFileSync takes on Windows too.
import { fileURLToPath } from 'node:url';

// The component module under test.
let mod: typeof import('../src/features/manual-apply/LeftQueueSection.tsx');
// Static render, so the test reads exactly the HTML the section produces.
let render: (element: unknown) => string;
// createElement, to build the tree without JSX in a .ts test.
let h: typeof import('react').createElement;

before(async () => {
  // Dynamic import, after the tsx hook is registered; a missing component fails here (the red step).
  mod = await import('../src/features/manual-apply/LeftQueueSection.tsx');
  // The static renderer.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // createElement.
  h = (await import('react')).createElement;
});

// One full row as the data module returns it; `over` replaces fields per case.
const row = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  status: 'failed',
  label: 'Backend Intern at Zomato',
  applyUrl: 'https://jobs.lever.co/zomato/1',
  stamp: '2026-11-05T09:10:00.123456+00:00',
  approvedAt: '2026-11-04T08:00:00+00:00',
  leftAt: '2026-11-05T09:10:00+00:00',
  leftFrom: 'approved',
  actor: 'human',
  source: 'retro_script',
  stage: 'retro_liveness_2026_11_05',
  code: 'posting_stale',
  reason: 'The posting was gone when the liveness check ran.',
  ...over,
});

// A fake target rule: only failed has a way back, so the test never calls the real (parallel-built) one.
const fakeTarget = (status: string) => (status === 'failed' ? 'needs_verification' : null);

// Renders the section for a read, with optional lock/frozen predicates.
function view(read: unknown, over: { locked?: (id: string) => boolean; frozen?: (id: string) => boolean } = {}): string {
  // No locks by default: most cases are about what is shown.
  return render(h(mod.LeftQueueSection, {
    read: read as never,
    locked: over.locked ?? (() => false),
    frozen: over.frozen ?? (() => false),
    reopenTarget: fakeTarget as never,
    onReopen: () => undefined,
  }));
}

describe('LeftQueueSection', () => {
  it('is collapsed by default and counts the rows in the summary', () => {
    // Two rows, so the count is not a constant.
    const html = view({ kind: 'ready', rows: [row(), row({ id: 'a2' })] });
    // A native details with no open attribute is collapsed.
    assert.match(html, /<details[^>]*class="panel left-queue"/);
    assert.doesNotMatch(html.slice(0, html.indexOf('>') + 1), / open/);
    // The count is in the summary.
    assert.match(html, /<summary[^>]*>Left your queue \(2\)<\/summary>/);
  });

  it('says loading, error and empty honestly', () => {
    // Loading: no count yet.
    assert.match(view({ kind: 'loading' }), /<summary[^>]*>Left your queue<\/summary>/);
    // Error: the summary says so and the body alerts.
    const err = view({ kind: 'error', message: 'boom' });
    assert.match(err, /Left your queue \(could not read\)/);
    assert.match(err, /role="alert"[^>]*>[^<]*boom/);
    // Empty after a good read.
    assert.match(view({ kind: 'ready', rows: [] }), /Nothing has left your queue\./);
  });

  it('shows a clean-up-script failure with its sentence and a Re-open button', () => {
    // A failed row moved by a retro stage under Teja's JWT.
    const html = view({ kind: 'ready', rows: [row()] });
    // The actor is named for what it was.
    assert.match(html, /by a clean-up script/);
    // The human sentence is the reason line.
    assert.match(html, /The posting was gone when the liveness check ran\./);
    // The way back exists for failed.
    assert.match(html, /<button[^>]*>Re-open<\/button>/);
  });

  it('reads a human actor outside a retro stage as you, and other actors by name', () => {
    // Human, a non-retro stage.
    assert.match(view({ kind: 'ready', rows: [row({ stage: 'manual_apply' })] }), /by you/);
    // The applier.
    assert.match(view({ kind: 'ready', rows: [row({ actor: 'applier', stage: null })] }), /by the applier/);
  });

  it('falls back to the code, then to No reason was recorded', () => {
    // Code only: underscores become spaces.
    assert.match(view({ kind: 'ready', rows: [row({ reason: null })] }), /posting stale/);
    // Neither.
    assert.match(view({ kind: 'ready', rows: [row({ reason: null, code: null })] }), /No reason was recorded\./);
  });

  it('offers no Re-open for a row with no target', () => {
    // dropped_filter has no human edge back.
    const html = view({ kind: 'ready', rows: [row({ status: 'dropped_filter' })] });
    // No button at all.
    assert.doesNotMatch(html, /Re-open/);
  });

  it('disables the button while locked, and adds the reload sentence when frozen', () => {
    // Locked only.
    const locked = view({ kind: 'ready', rows: [row()] }, { locked: () => true });
    assert.match(locked, /<button[^>]*disabled=""[^>]*>Re-open<\/button>/);
    assert.doesNotMatch(locked, /Reload the page before moving this again\./);
    // Frozen (which also locks).
    const frozen = view({ kind: 'ready', rows: [row()] }, { locked: () => true, frozen: () => true });
    assert.match(frozen, /Reload the page before moving this again\./);
  });

  it('draws no link for an unsafe apply URL and a safe one for https', () => {
    // A javascript: URL must never become an href.
    const bad = view({ kind: 'ready', rows: [row({ applyUrl: 'javascript:alert(1)' })] });
    assert.doesNotMatch(bad, /<a /);
    // The label is still shown as text.
    assert.match(bad, /Backend Intern at Zomato/);
    // A safe URL opens in a new tab, safely.
    const ok = view({ kind: 'ready', rows: [row()] });
    assert.match(ok, /<a [^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  });

  it('says time unknown for a malformed time, and never prints null', () => {
    // A string that Date.parse would accept as a year.
    const html = view({ kind: 'ready', rows: [row({ leftAt: '-5', approvedAt: 'soon' })] });
    // Said, not guessed.
    assert.match(html, /time unknown/);
    // No wrong date and no null leak.
    assert.doesNotMatch(html, /null/);
  });

  it('renders a ready row whose every optional part is null', () => {
    // Only the required fields held.
    const html = view({ kind: 'ready', rows: [row({ approvedAt: null, leftAt: null, leftFrom: null, actor: null, source: null, stage: null, code: null, reason: null, applyUrl: null })] });
    // Still a row, with the honest reason and no null.
    assert.match(html, /No reason was recorded\./);
    assert.doesNotMatch(html, /null/);
  });

  it('is mounted on the Manual apply page, its Re-open logged as manual_apply_reopen from the row status', () => {
    // The page's source: the wiring is the page's job, and a static render would show only the loading state.
    const src = readFileSync(fileURLToPath(new URL('../src/features/manual-apply/ManualApplyPage.tsx', import.meta.url)), 'utf8');
    // A second move path under its own event-log source (not the cards' 'manual_apply'), reloading both lists.
    assert.match(src, /const reopen = useRecoveryMoves\(loadAll, 'manual_apply_reopen'\);/);
    // The section is rendered with the data module's rule.
    assert.match(src, /<LeftQueueSection[\s\S]*?reopenTarget=\{reopenTarget\}/);
    // Its Re-open goes through that path, from the row's own status (never a hard-coded 'failed').
    assert.match(src, /onReopen=\{\(row, to\) => void reopen\.move\(row, row\.status, to\)\}/);
    // And that path's outcomes are shown.
    assert.match(src, /<RecoveryNotes notes=\{reopen\.notes\} \/>/);
  });
});
