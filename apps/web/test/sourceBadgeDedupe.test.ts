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

// 2026-11-07 audit: a non-array discovered_via crashed the page ("e.map is not a function"). The column is
// text[], but the value arrives off the wire as untrusted JSON, so SourceBadge checks the SHAPE (CLAUDE.md
// section 6) instead of trusting a truthiness test that a non-empty string also passes.
describe("SourceBadge on a malformed discovered_via or source_refs", () => {
  it("a string, an object or a number renders nothing instead of throwing", () => {
    // Each passes the old `!discoveredVia || length === 0` test or has no .map; none is an array.
    for (const value of ["greenhouse", "{greenhouse}", { 0: "greenhouse", length: 1 }, 7]) {
      // Rendered: must not throw, and draws no chip.
      assert.equal(render(h(badge.SourceBadge, { discoveredVia: value as never, sourceRefs: [GREENHOUSE_REF] as never })), "", JSON.stringify(value));
    }
  });

  it("non-string entries are skipped; the string ones still get their chip", () => {
    // A null and a number beside a real source.
    const html = render(h(badge.SourceBadge, { discoveredVia: [null, 3, "greenhouse"] as never, sourceRefs: [GREENHOUSE_REF] as never }));
    // Only the real source draws a chip.
    assert.deepEqual(labels(html), ["Greenhouse career page"]);
  });

  it("a non-array source_refs, or a null ref in it, reads as no refs instead of throwing", () => {
    // The same source with genuinely no refs: the chip a malformed refs value must equal.
    const noRefs = render(h(badge.SourceBadge, { discoveredVia: ["greenhouse"] as never, sourceRefs: [] as never }));
    // Non-vacuity: that baseline draws one chip.
    assert.equal(labels(noRefs).length, 1);
    // A string where the array belongs, and an array holding a null.
    for (const refs of ["oops", [null]]) {
      // The source still draws its chip, exactly as with no refs at all.
      assert.equal(render(h(badge.SourceBadge, { discoveredVia: ["greenhouse"] as never, sourceRefs: refs as never })), noRefs, JSON.stringify(refs));
    }
  });
});
