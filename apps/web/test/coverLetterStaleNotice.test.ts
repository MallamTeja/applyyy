/* The stale-cover-letter notice on the approval page (pinned 2026-10-24).
 *
 * Letters are generated write-once BEFORE awaiting_approval (cover-letter/run.ts:32) and are
 * never regenerated after a human edit; the ONLY defense is the DiffView notice. Until this
 * file, that notice existed only as source text — nothing went red if it was deleted. These
 * tests pin the behavior both ways:
 *   hasCoverLetter && editCount > 0  -> p.diff__edit-note with the exact sentence
 *   letter without edits, or edits without a letter -> no diff__edit-note at all
 * Harness: support/registerTsxHooks.ts (resolve + load hooks; .tsx transpiled, .css
 * emptied). Assertions match markup SHAPE (element + class + sentence), never a bare word. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

// The component under test.
let view: typeof import('../src/features/approval/DiffView.tsx');
// Static server renderer, no DOM.
let render: (element: unknown) => string;
// Element factory, so no JSX in this .ts file.
let h: typeof import('react').createElement;

before(async () => {
  // Loaded after the hooks so both apply.
  view = await import('../src/features/approval/DiffView.tsx');
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  h = (await import('react')).createElement;
});

// A DiffLine with sensible defaults; tests override only editState/runs to move editCount.
const line = (over: Record<string, unknown>) => ({
  id: 'line-1',
  kind: 'bullet',
  masterText: 'Built a REST API serving 500 users',
  masterNodeId: 'b-api',
  tailoredRuns: [{ text: 'Built a REST API', verdict: 'traced', tracesTo: 'b-api' }],
  editTarget: { kind: 'bullet', ref: 'b-api' },
  editState: 'original',
  originalText: 'Built a REST API',
  supersededClaims: [],
  ...over,
});

// An edited line, the thing that makes editCount > 0 the way the adapter counts it.
const editedLine = () =>
  line({ tailoredRuns: [{ text: 'Shipped a REST API', verdict: 'edited', tracesTo: null }], editState: 'edited' });

// Renders DiffView around the given lines; hasCoverLetter is the variable under test.
const page = (lines: unknown[], extra: Record<string, unknown> = {}) =>
  render(
    h(view.DiffView, {
      diff: {
        applicationId: 'app-1',
        jobTitle: 'Engineer',
        companyName: 'Acme',
        masterVersion: 1,
        coverage: { jdKeywords: [], honestlyMatched: [], matchedByFabrication: [], matchedByEdit: [] },
        lines,
        unlocatedClaims: [],
        // Derived the same way the adapter does: any non-original line counts.
        editCount: (lines as { editState: string }[]).filter((l) => l.editState !== 'original').length,
      },
      onApprove: () => undefined,
      onReject: () => undefined,
      // A save path exists, so this is an editing screen (the only screen edits happen on).
      onEdit: async () => ({ ok: true }),
      ...extra,
    } as never),
  );

// The exact notice markup: element + class + full sentence, the positive shape (§6).
const NOTICE = '<p class="diff__edit-note">Cover letter was generated before your edits.</p>';

describe('stale-cover-letter notice', () => {
  it('a row with a letter and an edit shows the notice', () => {
    // The confirmed stale case: a write-once letter exists and the profile diverged after it.
    const html = page([editedLine()], { hasCoverLetter: true });
    // The exact sentence inside its own element, not a substring found elsewhere.
    assert.ok(html.includes(NOTICE), 'expected the stale-letter notice');
  });

  it('a row with a letter but no edits shows no notice', () => {
    // Letter present, profile untouched: the letter still matches the resume, so no warning.
    const html = page([line({})], { hasCoverLetter: true });
    // The exact sentence must be absent. The CLASS cannot be asserted absent: the unrelated
    // "You changed N lines" paragraph (DiffView.tsx:1182) shares `diff__edit-note`.
    assert.ok(!html.includes('Cover letter was generated'), 'notice rendered without edits');
  });

  it('a row with edits but no letter shows no notice', () => {
    // Nothing to go stale: the notice would warn about a letter that does not exist.
    const html = page([editedLine()], { hasCoverLetter: false });
    // Same exact-sentence absence check as above.
    assert.ok(!html.includes('Cover letter was generated'), 'notice rendered without a letter');
  });

  it('an unknown letter state (prop omitted) shows no notice', () => {
    // The prop is optional; `undefined` must read as "no letter", never as "stale".
    const html = page([editedLine()]);
    // The strict `=== true` in DiffView is what this pins.
    assert.ok(!html.includes('Cover letter was generated'), 'notice rendered on undefined prop');
  });
});
