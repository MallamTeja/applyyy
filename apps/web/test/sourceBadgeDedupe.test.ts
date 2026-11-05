/* SourceBadge draws one chip per DISTINCT source chip, not one per discovered_via entry (A3, 2026-11-05).
 *
 * WHY. Live row 0c9fdc58 (xAI) has discovered_via {greenhouse, manual} and one source_ref, the
 * Greenhouse one: the job was scouted, then pasted in by hand. `manual` has no ref of its own, so it
 * borrowed refs[0] and drew a second "Greenhouse career page" chip with the same link. These tests pin
 * the dedupe and that genuinely different sources still get their own chips. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose equality cannot pass a wrong shape.
import assert from 'node:assert/strict';
// The runner; before() loads the modules once.
import { describe, it, before } from 'node:test';

// The component under test.
let badge: typeof import('../src/app/SourceBadge.tsx');
// Static render, so the test reads exactly the HTML the chips produce.
let render: (element: unknown) => string;
// createElement, to build the tree without JSX in a .ts test.
let h: typeof import('react').createElement;

before(async () => {
  // Dynamic import, after the tsx hook is registered.
  badge = await import('../src/app/SourceBadge.tsx');
  // The static renderer.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // createElement.
  h = (await import('react')).createElement;
});

// The live xAI row's one ref, as stored.
const GREENHOUSE_REF = { provider: 'greenhouse', url: 'https://job-boards.greenhouse.io/xai/jobs/5255111007', metadata: { ats_provider: 'greenhouse', tier: 1, type: 'career_page' } };

// The chip labels in render order.
const labels = (html: string): string[] => [...html.matchAll(/<span class="source-badge__label">([^<]*)<\/span>/g)].map((m) => m[1] ?? '');

describe('SourceBadge chips', () => {
  it('the xAI row {greenhouse, manual} with one Greenhouse ref shows ONE "Greenhouse career page" chip', () => {
    // The live shape.
    const html = render(h(badge.SourceBadge, { discoveredVia: ['greenhouse', 'manual'] as never, sourceRefs: [GREENHOUSE_REF] as never }));
    // Exactly one chip, the career page.
    assert.deepEqual(labels(html), ['Greenhouse career page']);
  });

  it('two different sources, each with its own ref, keep two chips in order', () => {
    // A Greenhouse board and a LinkedIn hiring post.
    const post = { provider: 'linkedin_post', url: 'https://www.linkedin.com/posts/x', metadata: { author: 'A Founder' } };
    // Both sources.
    const html = render(h(badge.SourceBadge, { discoveredVia: ['greenhouse', 'linkedin_post'] as never, sourceRefs: [GREENHOUSE_REF, post] as never }));
    // One chip each, in discovered_via order.
    assert.deepEqual(labels(html), ['Greenhouse career page', 'LinkedIn post']);
  });
});
