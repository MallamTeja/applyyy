/* rebuildOriginal on the REAL row shape: tailor_refs without schema_version (2026-10-08).
 *
 * The bug: the live Gemini tailor never stamps schema_version on tailor_refs, but the edit gate
 * (isTailoredProfileShape) demanded schema_version === 1. Every hand-written fixture carried the key,
 * so the suite stayed green while rebuildOriginal returned null on every real row and the approval
 * page showed "Editing is off". This file pins the fix to the live GitLab row (anonymised): absent
 * is forgiven, exactly 1 is accepted, and any other present value is still refused. */

import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
// The live row, anonymised; kept in its own module so this file stays readable.
import { TAILOR_REFS, STORED_TAILORED_PROFILE, MASTER_V2, MASTER_VERSION } from './fixtures/gitlab-row-anonymised.ts';

// The module under test, typed from its source so a renamed export fails typecheck too.
let edits: typeof import('../src/features/approval/tailoredEdits.ts');

before(async () => {
  // Same dynamic-import style as tailoredEdits.test.ts, so a load failure surfaces as a hook error.
  edits = await import('../src/features/approval/tailoredEdits.ts');
});

// The real master parsed through the page's own gate, so the test sees what the page sees.
const master = () => {
  // masterFromRow is how the approval page turns the jsonb row into a MasterProfile.
  const parsed = edits.masterFromRow(MASTER_V2);
  // A null here means the fixture, not the gate under test, is broken: fail loudly at the cause.
  assert.notEqual(parsed, null, 'fixture master_v2 must parse');
  // Narrowed for the caller after the assertion.
  return parsed!;
};

describe('tailor_refs without schema_version (the live row shape)', () => {
  it('the live GitLab row\'s refs, with no schema_version, rebuild to exactly the stored resume', () => {
    // Precondition: the fixture really lacks the key, else this test cannot catch the regression.
    assert.equal('schema_version' in TAILOR_REFS, false);
    // The whole rebuilt resume must equal what was stored at tailoring time, field for field.
    assert.deepEqual(edits.rebuildOriginal(TAILOR_REFS, master(), MASTER_VERSION), STORED_TAILORED_PROFILE);
  });

  it('schema_version 1 still rebuilds; 2, \'1\' and null are refused', () => {
    // The explicit marker the code was written for is still accepted.
    assert.deepEqual(edits.rebuildOriginal({ ...TAILOR_REFS, schema_version: 1 }, master(), MASTER_VERSION), STORED_TAILORED_PROFILE);
    // A future schema must not be resolved under schema 1's rules.
    assert.equal(edits.rebuildOriginal({ ...TAILOR_REFS, schema_version: 2 }, master(), MASTER_VERSION), null);
    // A string '1' is a lenient-parser trap: only the number 1 counts.
    assert.equal(edits.rebuildOriginal({ ...TAILOR_REFS, schema_version: '1' }, master(), MASTER_VERSION), null);
    // Present-but-null is not absence; only a missing key is forgiven.
    assert.equal(edits.rebuildOriginal({ ...TAILOR_REFS, schema_version: null }, master(), MASTER_VERSION), null);
  });

  it('a refused pin still yields null', () => {
    // Relaxing the marker must not relax the validator: the refs name version 2, so version 3 is refused.
    assert.equal(edits.rebuildOriginal(TAILOR_REFS, master(), 3), null);
  });
});
