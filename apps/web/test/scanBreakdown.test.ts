/* P1-5 (2026-11-05): the Scan popup's honesty.
 *
 * WHY: the popup's "N New Applications" counted every row the scan inserted, including rows born
 * dropped_filter. Teja's 39 "new" were all dropped (26 tech_gate, 12 unclassified, 1 work_auth), and
 * the popup still listed SmartRecruiters, off since the 2026-11-01 robots ruling (0 of 12 boards
 * enabled). scout-ats now reports `new_applications` {passed, dropped, unscreened, drop_reasons};
 * the popup says "X passed -> Ready to tailor, Y dropped" with the top reasons, and never calls a
 * dropped row a new application. An older function without the field gets wording that claims
 * nothing about screening. Rendered with react-dom/server; no DOM. */

// The .tsx loader first, so the modal and the service import.
import './support/registerTsxHooks.ts';
// Strict asserts.
import assert from 'node:assert/strict';
// One before() for the imports.
import { before, describe, it } from 'node:test';

// The service under test.
let service: typeof import('../src/data/discoveryService.ts');
// The modal module (ScanSummary and the copy).
let modal: typeof import('../src/features/pipeline/DiscoveryModal.tsx');
// Static markup.
let render: (element: unknown) => string;
// Element factory.
let h: typeof import('react').createElement;

before(async () => {
  // Transpiled by the hook.
  service = await import('../src/data/discoveryService.ts');
  // Same.
  modal = await import('../src/features/pipeline/DiscoveryModal.tsx');
  // From the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
});

// A full-run 200 body as scout-ats sends it, Teja's 11-05 scan by default.
const runBody = (over: Record<string, unknown> = {}) => ({
  success: true,
  boards_polled: 10,
  jobs_discovered: 412,
  applications_created: 39,
  results: [{ status: 'ok' }],
  new_applications: { passed: 0, dropped: 39, unscreened: 0, drop_reasons: [{ reason: 'tech_gate', count: 26 }, { reason: 'unclassified', count: 12 }, { reason: 'work_auth', count: 1 }] },
  ...over,
});

describe('parseScoutAtsResponse: the screening breakdown', () => {
  it("Teja's scan: 0 passed, 39 dropped with the reasons, and never 'new application'", () => {
    // Parsed.
    const result = service.parseScoutAtsResponse(runBody());
    // Recognised, with the breakdown carried for the modal.
    assert.deepEqual(result?.breakdown, { passed: 0, dropped: 39, unscreened: 0, dropReasons: [{ reason: 'tech_gate', count: 26 }, { reason: 'unclassified', count: 12 }, { reason: 'work_auth', count: 1 }] });
    // The sentence says what happened.
    assert.match(result?.message ?? '', /0 passed screening.*39 dropped \(tech_gate 26, unclassified 12, work_auth 1\)/);
    // And never calls a dropped row a new application.
    assert.doesNotMatch(result?.message ?? '', /new application/i);
  });

  it('shows the top three reasons and counts the rest', () => {
    // Five reasons.
    const result = service.parseScoutAtsResponse(runBody({ applications_created: 15, new_applications: { passed: 0, dropped: 15, unscreened: 0, drop_reasons: [{ reason: 'a', count: 5 }, { reason: 'b', count: 4 }, { reason: 'c', count: 3 }, { reason: 'd', count: 2 }, { reason: 'e', count: 1 }] } }));
    // Three named, the other two counted.
    assert.match(result?.message ?? '', /15 dropped \(a 5, b 4, c 3, 2 more reasons\)/);
  });

  it('an older function without the field: no claim about screening, and no "new application"', () => {
    // The pre-P1-5 body.
    const { new_applications: _dropped, ...old } = runBody();
    // Parsed.
    const result = service.parseScoutAtsResponse(old);
    // Recognised, with no breakdown.
    assert.equal(result?.breakdown, null);
    // Neutral words.
    assert.match(result?.message ?? '', /39 new rows \(this server did not report how many passed screening\)/);
    // Never the old claim.
    assert.doesNotMatch(result?.message ?? '', /new application/i);
  });

  it('a breakdown that does not add up is an unrecognised response, never shown', () => {
    // Parts that miss the total, a reason sum that misses the drops, a negative count, a blank reason.
    for (const bad of [
      { passed: 1, dropped: 39, unscreened: 0, drop_reasons: [{ reason: 'x', count: 39 }] },
      { passed: 0, dropped: 39, unscreened: 0, drop_reasons: [{ reason: 'x', count: 38 }] },
      { passed: -1, dropped: 40, unscreened: 0, drop_reasons: [{ reason: 'x', count: 40 }] },
      { passed: 0, dropped: 39, unscreened: 0, drop_reasons: [{ reason: '', count: 39 }] },
      'oops',
    ]) assert.equal(service.parseScoutAtsResponse(runBody({ new_applications: bad })), null, JSON.stringify(bad));
  });
});

describe('ScanSummary', () => {
  it('names passed and dropped apart, lists the reasons, and has no "New Applications" box', () => {
    // The parsed scan.
    const result = service.parseScoutAtsResponse(runBody({ applications_created: 41, new_applications: { passed: 2, dropped: 39, unscreened: 0, drop_reasons: [{ reason: 'tech_gate', count: 39 }] } }))!;
    // Rendered.
    const html = render(h(modal.ScanSummary, { result }));
    // The passed box, pointing at where they are.
    assert.match(html, /Passed[^<]*Ready to tailor/);
    // The dropped box.
    assert.match(html, />39</);
    // The reason line.
    assert.match(html, /tech_gate 39/);
    // The misleading label is gone.
    assert.doesNotMatch(html, /New Applications/i);
  });

  it('an older function: shows the row count without claiming they passed', () => {
    // No breakdown.
    const { new_applications: _dropped, ...old } = runBody();
    // Rendered.
    const html = render(h(modal.ScanSummary, { result: service.parseScoutAtsResponse(old)! }));
    // Says what it cannot tell.
    assert.match(html, /did not report how many passed screening/);
    // And no "new applications".
    assert.doesNotMatch(html, /New Applications/i);
  });
});

describe('the scan popup copy', () => {
  it('lists the providers the scan polls, without SmartRecruiters', () => {
    // The watchlist popup, before any scan.
    const html = render(h(modal.DiscoveryModal, { mode: 'watchlist', onClose: () => {}, onRefresh: () => {} }));
    // Off since the 2026-11-01 robots ruling.
    assert.doesNotMatch(html, /SmartRecruiters/);
    // Workday is polled (48 enabled boards, 2026-11-05).
    assert.match(html, /Greenhouse, Lever, Ashby and Workday/);
  });
});
