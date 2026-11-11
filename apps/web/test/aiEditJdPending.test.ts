/* The AI chat waits for the job description (2026-11-09).
 *
 * WHY. The Approval queue now reads job descriptions after its first paint, so for a moment a card's diff
 * has none. An ask built then would send an EMPTY description that looks, to the model, like a job with no
 * text, and it would tailor blind. So `jobDescription === undefined` ("not loaded yet") holds Send, with a
 * visible reason; `null` ("loaded, none stored") and a string do not.
 * RED-ON-REVERT: AiEditPanel without the jdPending lock fails test 1 (no status line, Send not held). */

// The .tsx render hooks and Vite-style extensionless imports, before anything imports the panel.
import './support/registerTsxHooks.ts';
// Strict asserts.
import assert from 'node:assert/strict';
// The runner.
import { before, describe, it } from 'node:test';
// Types only (erased at run time): the panel seams return the real result unions, so a stub cannot return a shape the panel would never get.
import type { EditResult } from '../src/features/approval/DiffView.tsx';
// Same, the assist seam's closed union.
import type { AssistResult } from '../src/features/approval/aiEdit.ts';

// The panel, loaded after the hooks.
let panel: typeof import('../src/features/approval/AiEditPanel.tsx');
// Static markup, enough to read the composer's state.
let render: (element: unknown) => string;
// React's element factory.
let h: typeof import('react').createElement;

before(async () => {
  // Loaded after the hooks so they apply.
  panel = await import('../src/features/approval/AiEditPanel.tsx');
  // The server renderer: no DOM needed.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // The factory.
  h = (await import('react')).createElement;
});

/* A minimal diff, with jobDescription set per test. Lines are empty: the composer does not read them. */
function diffWith(jobDescription: string | null | undefined): never {
  // Only what the panel's first render touches.
  return { applicationId: 'app-jd', jobTitle: 'Backend Engineer', companyName: 'Acme', coverage: { jdKeywords: [], honestlyMatched: [], matchedByFabrication: [], matchedByEdit: [] }, lines: [], jobDescription } as never;
}

/* The panel's markup for one diff, with seams that are never called by a static render. */
function markup(jobDescription: string | null | undefined): string {
  // A session-only chat (no store), not busy; the batch-save stub is required since T16 and never called.
  return render(h(panel.AiEditPanel, { diff: diffWith(jobDescription), onEdit: async (): Promise<EditResult> => ({ ok: true }), onEditBatch: async (): Promise<EditResult> => ({ ok: true }), onAssist: async (): Promise<AssistResult> => ({ kind: 'error', message: '' }), busy: false, categories: [] }));
}

describe('AiEditPanel waits for the job description (2026-11-09)', () => {
  it('1. not loaded yet (undefined): the composer says so', () => {
    // The status line, as a polite status so a screen reader hears why Send is off.
    assert.match(markup(undefined), /<span class="ai-chat__meta" role="status">Loading the job description…<\/span>/);
  });

  it('2. loaded, with text or with none stored (null): no waiting line', () => {
    // A description: ready.
    assert.doesNotMatch(markup('<p>A backend role.</p>'), /Loading the job description/);
    // None stored is an answer, not a wait: the AI may be asked without one.
    assert.doesNotMatch(markup(null), /Loading the job description/);
  });
});
