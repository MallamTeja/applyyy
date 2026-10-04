/* Per-route document titles. Every tab used to read "applyy — application
 * console", so fourteen open screens were indistinguishable in the tab strip
 * and in browser history. These pin the mapping, not the DOM write. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ALL_ROUTES, DEFAULT_DOCUMENT_TITLE, documentTitleFor } from '../src/app/routes.ts';

describe('documentTitleFor', () => {
  it('names the page for a known route', () => {
    // The case the sweep reported: the approval queue must say so in its tab.
    assert.equal(documentTitleFor('/approvals'), 'Approval queue · applyy');
  });

  it('gives every declared route its own label-based title', () => {
    // Walks the real route table, so a newly added page is covered without
    // anyone remembering to add a case here.
    for (const route of ALL_ROUTES) {
      // Each title must lead with that route's own label.
      assert.equal(documentTitleFor('/' + route.path), `${route.label} · applyy`);
    }
  });

  it('keeps the parent page title on a nested path', () => {
    // A detail URL under a page is still that page from the operator's view.
    assert.equal(documentTitleFor('/pipeline/abc-123'), 'Pipeline · applyy');
  });

  it('falls back to the generic title for root and unknown paths', () => {
    // `/` redirects and a typo 404s; neither should borrow a real page's name.
    assert.equal(documentTitleFor('/'), DEFAULT_DOCUMENT_TITLE);
    // Exact match, not prefix: an unknown path must never adopt "Filters".
    assert.equal(documentTitleFor('/filters-archive'), DEFAULT_DOCUMENT_TITLE);
  });
});
