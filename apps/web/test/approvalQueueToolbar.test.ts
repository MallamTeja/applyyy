/* The approval queue's toolbar (search, sort, work type) and row chips, asked for by Teja 2026-11-04.
 * The view's RULES are tested where they live (queueView.ts's own tests); this file checks the
 * page's WIRING, by reading its source, in the style of approvalQueueOrder.test.ts. apps/web has no
 * DOM lib and the page imports supabase, so it cannot be rendered or imported here.
 * Every assertion is a POSITIVE shape (the wiring that must exist), never the absence of a
 * substring: a check that forbids naming a bug fires on the comment that documents it. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// The page's source, read once; every check below matches against it.
const page = readFileSync(new URL('../src/features/approval/ApprovalQueuePage.tsx', import.meta.url), 'utf8');

describe('approval queue toolbar wiring', () => {
  it('imports the pure view and applies it to the pending rows before the bucket split', () => {
    // The one function that filters, searches and sorts, from the pure module.
    assert.match(page, /import \{[^}]*\bapplyQueueView\b[^}]*\} from '\.\/queueView';/);
    // Applied to the unfiltered pending rows with the toolbar's state.
    assert.match(page, /const shown = applyQueueView\(pending, view\);/);
    // Both buckets are split from the view's OUTPUT, so their visible rows keep the chosen order.
    assert.match(page, /bucketA: shown\.filter\(\(diff\) => deriveBucket\(diff\) === 'A'\)/);
    assert.match(page, /const shownB = shown\.filter\(\(diff\) => deriveBucket\(diff\) === 'B'\);/);
    // Bucket B renders its visible rows FIRST, then the hidden ones, in one keyed list.
    assert.match(page, /bucketB: \[\.\.\.shownB, \.\.\.filteredOutB\]/);
    // Its heading and "Showing X" count only the visible ones.
    assert.match(page, /bucketBShownCount: shownB\.length/);
    assert.match(page, /const shownCount = bucketA\.length \+ bucketBShownCount;/);
  });

  it('keeps refused rows and the counts unfiltered', () => {
    // Refused rows come from the full unreviewable list: a search must never strand one.
    assert.match(page, /pendingRefused: unreviewable\.filter\(\(row\) => !settled\.has\(row\.applicationId\)\)/);
    // The unfiltered count is carried out of the memo for the gates below.
    assert.match(page, /pendingCount: pending\.length/);
    // Each work-type chip counts over every waiting row, not over the filtered ones.
    assert.match(page, /arrangementCounts: countByArrangement\(pending\)/);
  });

  it('says "Queue is empty" only when nothing waits, and names a filtered-out queue as such', () => {
    // The empty branch is gated on the UNFILTERED count plus the refused rows.
    assert.match(page, /if \(pendingCount === 0 && pendingRefused\.length === 0\) \{/);
    // The toolbar stays up whenever a reviewable row waits, even when the filters hide all of them.
    assert.match(page, /\{pendingCount > 0 \? \(\s*<div className="queue__toolbar"/);
    // Filters that hide every row are told apart from an empty queue...
    assert.match(page, /pendingCount > 0 && shownCount === 0/);
    // ...in their own sentence...
    assert.match(page, /No applications match these filters\./);
    // ...and an undo that restores the default view.
    assert.match(page, /setView\(DEFAULT_QUEUE_VIEW\);/);
  });

  it('renders native, labelled controls for search, sort and work type', () => {
    // A real search input with a visible label tied to it...
    assert.match(page, /htmlFor="queue-search"/);
    // ...of type search, so the browser supplies the clear button and Escape.
    assert.match(page, /type="search"/);
    // The sort select, labelled...
    assert.match(page, /htmlFor="queue-sort"/);
    // ...its options worded by the view module, so an option and its sort share one name.
    assert.match(page, /QUEUE_SORT_LABELS\[option\]/);
    // Work type is a named group: the legend is what a screen reader says before each option.
    assert.match(page, /<legend className="field__label">Work type<\/legend>/);
    // Native radios, so arrow keys move between the chips.
    assert.match(page, /type="radio"/);
    // Each chip carries its count, e.g. "Remote only (64)".
    assert.match(page, /\{QUEUE_ARRANGEMENT_LABELS\[option\]\} \(\{arrangementCounts\[option\]\}\)/);
    // The visible count is announced politely.
    assert.match(page, /aria-live="polite">\s*Showing \{shownCount\} of \{pendingCount\}/);
  });

  it('keeps filtered-out Bucket B reviews mounted, and batch-approves only visible rows', () => {
    // A hidden Bucket B row is looked up by id in the filtered-out set...
    assert.match(page, /const isFilteredOut = bucketBFilteredOut\.has\(diff\.applicationId\);/);
    // ...and hidden with the attribute, not unmounted, so its DiffView state survives a search.
    assert.match(page, /hidden=\{isFilteredOut\}/);
    // Approve all sends exactly the Bucket A rows, which are split from the view's output above.
    assert.match(page, /bucketA\.map\(\(diff\) => diff\.applicationId\),\s*'approved'/);
  });
});

describe('approval queue row chips', () => {
  it('latency 2a: the queue select is an explicit column list with no raw_payload read', () => {
    // The applications columns, named one by one: `*` shipped fields this page never reads.
    // The whole select, end to end: the jobs embed closes on description_raw, so no raw_payload key
    // (one ->> de-TOASTs the whole board JSON per row, ~95% of executor time, 2026-11-05) can ride in.
    assert.match(page, /\.select\('id, status, status_changed_at, created_at, updated_at, master_version, tailored_profile, tailor_refs, selected_jd_keywords, match_score, audit_findings, cover_letter, jobs:job_id\(title, company_name, employment_type, work_arrangement, locations, salary_min, salary_max, salary_currency, discovered_via, source_refs, apply_url, description_raw\)'\)/);
  });

  it('labels the master fit "Fit" and the tailored coverage "ATS score", with dashes for unknown', () => {
    /* The matcher's fit, through the one shared formatter (queueView fitChip, 2026-11-05); its
       rounding and its dash for unknown are tested by behaviour in approvalQueueView.test.ts. */
    assert.match(page, /import \{[^}]*\bfitChip\b[^}]*\} from '\.\/queueView';/);
    // The chip calls it on the row's fit.
    assert.match(page, /\{fitChip\(facts\?\.fit\)\}/);
    // The tailored resume's honest coverage, the badge's own figure...
    assert.match(page, /coveragePercent\(diff\.coverage, 'honest'\)/);
    // ...named "ATS score", with a dash when nothing was measured.
    assert.match(page, /`ATS score \$\{measure\.percent\}% · tailored vs JD` : 'ATS score —'/);
  });

  it('reads the queued age from status_changed_at, through an ISO-day shape check', () => {
    // Shape first: an ISO calendar-date prefix before any parse.
    assert.match(page, /const ISO_DATE_PREFIX = \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\/;/);
    // Round-tripped, so a rolled-over day like 2026-02-31 is refused.
    assert.match(page, /new Date\(ms\)\.toISOString\(\)\.slice\(0, 10\) === day/);
    // The queued age is read from the row's entry into review...
    assert.match(page, /queuedAt: app\.status_changed_at/);
    // ...and phrased by the discovery page's own age builder.
    assert.match(page, /`Added to queue \$\{ago\}`/);
  });

  it('draws the same chips in both buckets', () => {
    // Every place the one chip component is drawn, with the same arguments.
    const uses = page.match(/<QueueRowChips diff=\{diff\} facts=\{chipFacts\.get\(diff\.applicationId\)\} \/>/g) ?? [];
    // Exactly two: once in Bucket B, once in Bucket A.
    assert.equal(uses.length, 2);
  });
});
