/* The Discovered Jobs page must not advance an application's status.
 *
 * WHY THIS IS A SOURCE-LEVEL TEST AND NOT A RENDER TEST. apps/web has no component
 * render harness, and adding one means a dependency, which means a package.json edit
 * and a lockfile rewrite in a tree four sessions share. The thing worth guarding here
 * is not how the page LOOKS — it is that one specific call is absent from it, and a
 * source assertion guards that exactly, with no new dependency and no runtime.
 *
 * WHAT WAS REMOVED, so a future reader knows what these assertions are defending.
 * The "Tailor & Queue" button walked six status transitions naming six agents and
 * executed NONE of them. Two of those agents — the Normalizer and the Auditor — do not
 * exist as code anywhere in the repo. The button therefore stamped rows `audit_clean`,
 * a verdict attributed to an agent that was never written, and then navigated the
 * operator straight to the batch-approve screen.
 *
 * The consequence reached production: with no Tailor having run, `tailored_profile` was
 * null, so the approval page compared a resume built FROM the master profile AGAINST
 * the master profile, found no discrepancy, and reported "Bucket A — safe to
 * batch-approve". THE CLEAN VERDICT WAS MANUFACTURED BY THE ABSENCE OF THE ARTIFACT IT
 * CLAIMED TO HAVE CHECKED. Teja ruled on 2026-09-17 to delete the affordance rather
 * than disable it or make it honest.
 *
 * These tests fail if anyone restores it, including "temporarily".
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// Resolved from this file rather than from process.cwd(), so the suite passes whether
// it is run from apps/web or from the repo root.
const PAGE_PATH = fileURLToPath(new URL('../src/features/discovery/DiscoveredJobsPage.tsx', import.meta.url));

// Read once in a before hook; every assertion below reads the same snapshot, so a
// failure cannot be blamed on the file changing between cases.
let source = '';
before(async () => {
  source = await readFile(PAGE_PATH, 'utf8');
});

/* EVERY ASSERTION BELOW MATCHES CODE, NOT PROSE — quoted string literals, a call with
 * its opening paren, a className. The first draft matched the bare word `audit_clean`
 * and went red against the page's own comment EXPLAINING why the fast path was removed.
 * That is the wrong trade: the comment is the most valuable thing left at that site, and
 * a guard that forbids describing the bug it guards against will be deleted by the first
 * person it inconveniences. Match the shape that would actually reintroduce the defect.
 */
describe('DiscoveredJobsPage performs no status mutation', () => {
  it('never calls the advance_application_status RPC', async () => {
    // The page's only direct database mutation was this RPC. Its absence is the whole
    // ruling in one assertion: the page may CREATE discovered rows, never advance them.
    assert.equal(
      source.includes("rpc('advance_application_status'"),
      false,
      'DiscoveredJobsPage must not advance application status; the pipeline agents do that',
    );
  });

  it('never stamps the audit_clean status', async () => {
    // Asserted as a quoted literal because that is the only form that can reach the
    // database. This is the specific forgery: audit_clean is the Auditor's verdict, and
    // no Auditor exists anywhere in the repo to produce it.
    assert.equal(
      source.includes("'audit_clean'"),
      false,
      'audit_clean is the Auditor verdict; no Auditor exists, so nothing here may stamp it',
    );
  });

  it('does not route the operator to the approval queue', async () => {
    // Not incidental — this call delivered the operator to the one-click batch-approve
    // lane holding the rows the button had just mislabelled.
    assert.equal(
      source.includes("navigate('/approvals')"),
      false,
      'the page must not push the operator onto the batch-approve screen',
    );
  });

  it('leaves behind no disabled or commented-out fast path', async () => {
    // A greyed-out button, a TODO or a commented-out handler all still assert that the
    // capability exists and is merely unavailable. The ruling was that the UI stop
    // claiming it at all, so the tombstones are checked for too. These three identifiers
    // appear nowhere in prose, so matching them bare is safe.
    assert.equal(source.includes('handleFastTailor'), false, 'the fast-path handler must be gone, not commented out');
    assert.equal(source.includes('tailoringId'), false, 'the fast-path button state must be gone with the button');
    assert.equal(
      source.includes('job-card__tailor-btn'),
      false,
      'the button class must not survive; its CSS rules were deleted with it',
    );
  });
});

describe('what the page must still do', () => {
  it('still creates discovered rows through the Scout modal', async () => {
    // The acceptance criterion for the excision being SURGICAL. The page's job is to
    // discover jobs; only the fraudulent advance was removed. If this goes red, the
    // deletion took the page's actual purpose with it.
    assert.ok(source.includes('DiscoveryModal'), 'the Scout discovery modal must survive the deletion');
  });

  it('still honours the tech-only preference', async () => {
    // The other live feature sharing this file, and the one most likely to be collateral
    // damage in a careless cut.
    assert.ok(source.includes('setTechOnlyPreference'), 'the tech-only toggle must survive the deletion');
  });

  it('allows the operator to trigger the deployed pipeline modal', async () => {
    // Discovered rows trigger the real deployed agent pipeline modal (PipelineRunModal)
    // rather than performing local status mutation.
    assert.ok(
      source.includes('PipelineRunModal') && source.includes('setPipelineModalOpen'),
      'the card footer triggers the deployed agent pipeline modal to process discovered jobs',
    );
  });
});
