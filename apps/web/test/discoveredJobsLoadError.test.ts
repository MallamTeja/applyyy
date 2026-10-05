/* DiscoveredJobsPage: a failed load must not also claim "zero jobs".
 *
 * WHY SOURCE SHAPE, NOT A RENDER. The error state is set inside useEffect -> loadData, and
 * react-dom/server never runs effects, so SSR can only ever show the loading state. Forcing
 * loadError would need a DOM renderer this app does not have. So, like discoveryNoFastPath.test.ts,
 * this asserts the code SHAPE of the two guards (never a bare word from a comment). */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// The page source, read once; the path is relative to apps/web where node --test runs.
const source = readFileSync('src/features/discovery/DiscoveredJobsPage.tsx', 'utf8');

describe('DiscoveredJobsPage load-failure rendering', () => {
  it('renders the "Showing N" counter only when loadError is null', () => {
    // The counter span's content must open with the null guard.
    assert.match(source, /className="discovery__meta-count">[\s\S]*?\{loadError === null && \(viewTab === 'matched'/);
  });

  it('short-circuits to null on loadError before the empty-state branch', () => {
    // The null arm must sit between the loading arm and the filteredItems.length === 0 arm.
    assert.match(source, /\) : loadError !== null \?[^\n]*? null : filteredItems\.length === 0 \? \(/);
  });
});
