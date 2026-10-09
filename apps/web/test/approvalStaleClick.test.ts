/* A refused click must never be silent.
 *
 * When the operator clicks Approve on a row that changed elsewhere (another tab saved an edit, or the
 * row was still saving in the batch), the page refuses the approval and redraws the stored row. Until
 * this test, that refusal said nothing on the card itself: the row simply re-rendered and the operator
 * could believe the click had worked. The contract: every stale-refusal path calls noteStale(), which
 * puts a visible, polite-live notice on THAT card and moves focus to it; the notice is cleared at the
 * start of the next Approve/Reject/edit on the row. The words must be TRUE for the case: a row whose own
 * edit is still saving, or that vanished, is never told "this application changed, review the latest".
 *
 * The page fetches on mount, so it is not rendered here (same reason as approvalBucketMoveFocus.test.ts).
 * The wiring is checked by source shape between anchors that are ASSERTED to exist first, so a renamed
 * anchor fails by name instead of passing on an empty slice. Every slice is then stripped of comments,
 * so a comment that merely MENTIONS "noteStale(id" can never satisfy a test. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// The page source, read once; every test below inspects this one string.
const page = readFileSync(fileURLToPath(new URL('../src/features/approval/ApprovalQueuePage.tsx', import.meta.url)), 'utf8');

/* Code only: block comments (incl. JSX {/* *\/}) and // line comments removed. A // counts as a comment
   only at line start or after whitespace, so a "https://" inside a string survives. */
function code(slice: string): string {
  // Block comments first, so a // inside one cannot cut a line of code after it.
  return slice.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

// The RAW text between two anchors, failing by name if either is missing (a vacuous slice guards nothing).
function between(start: string, end: string): string {
  // The opening anchor.
  const from = page.indexOf(start);
  // Missing means the code moved; say which anchor, never pass on an empty slice.
  assert.ok(from >= 0, `anchor not found: ${start}`);
  // The closing anchor, searched after the opening one so it bounds THIS block.
  const to = page.indexOf(end, from + start.length);
  // Same for the closing anchor.
  assert.ok(to > from, `anchor not found after start: ${end}`);
  // The slice itself.
  return page.slice(from, to);
}

// The same slice with comments stripped: what the assertions read.
function codeBetween(start: string, end: string): string {
  // Anchors are checked on the raw source inside between(); only the result is stripped.
  return code(between(start, end));
}

/* One component-level function, from its declaration to its closing brace, comments stripped.
   Functions inside the component sit at two spaces of indentation, so the first "\n  }" closes it. */
function componentFunction(declaration: string): string {
  // Reuses between() so a missing function is named, not silently empty.
  return codeBetween(declaration, '\n  }');
}

/* Where a slice REMOVES the given row's notice, or -1. Positive shape: a setStaleNotices update that
   deletes or filters out that id, or a call to a dedicated clear helper with that id. Never "the
   absence of noteStale", which would pass on code that does nothing. */
function clearIndex(slice: string, idName: string): number {
  // A state update whose body drops the key: `.delete(id)` on a copied Map, or a `!== id` filter.
  const viaSetter = new RegExp(`setStaleNotices\\([\\s\\S]{0,300}?(\\.delete\\(${idName}\\)|!==\\s*${idName}\\b)`);
  // A named helper the builder may extract (clearStale, clearStaleNotice, ...), called with the id.
  const viaHelper = new RegExp(`clearStale\\w*\\(${idName}\\)`);
  // Whichever shape is present; the index is where the clear starts.
  const match = viaSetter.exec(slice) ?? viaHelper.exec(slice);
  // -1 says "no clear here", which the callers turn into a named failure.
  return match === null ? -1 : match.index;
}

describe('the stale-click notice exists and is wired to focus', () => {
  it('the notice says, in one exact sentence, why the click did nothing and what to do next', () => {
    // Module level, so every refusal path shows the same words and a test can pin them.
    assert.match(
      page,
      /^const STALE_CLICK_MESSAGE =\s*'This application changed since you opened it\. Review the latest version, then click Approve again\.';/m,
    );
  });

  it('each card can hold its own notice (a per-row map, not one page-wide string)', () => {
    // Keyed by application id, so a refusal on one card never shows on another.
    assert.match(code(page), /const \[staleNotices, setStaleNotices\] = useState<ReadonlyMap<string, string>>\(new Map\(\)\);/);
  });

  it('noteStale puts the notice on the row AND moves focus to that card unless told not to', () => {
    // Backward compatible: the default message stays, and focus is an optional, default-true option.
    assert.match(
      code(page),
      /function noteStale\(applicationId: string, message: string = STALE_CLICK_MESSAGE, \{ focus = true \}: \{ focus\?: boolean \} = \{\}\): void/,
    );
    // Its body.
    const body = componentFunction('function noteStale(');
    // Writes the notice map: without this the card shows nothing.
    assert.match(body, /setStaleNotices\(/, 'noteStale must set the notice');
    // Focus follows (gated only by the option), so a keyboard or screen-reader user lands on the card that refused.
    assert.match(body, /if \(focus\) setPendingFocusId\(applicationId\)/, 'noteStale must focus the card when focus is true');
  });
});

describe('every stale refusal produces the notice instead of silence', () => {
  it('a stale Approve (confirmFresh saw a newer row) shows the card notice instead of silence', () => {
    // The confirmFresh "changed" branch, up to the continue that skips the RPC.
    const branch = codeBetween("if (check.kind === 'changed') {", 'continue;');
    // The notice is raised for this row before the branch gives up on it.
    assert.match(branch, /noteStale\(id\b/, 'the confirmFresh stale branch must call noteStale(id)');
  });

  it('an Approve the database refused as stale (PT409) shows the card notice instead of silence', () => {
    // The PT409 branch where the re-read shows the row still awaiting with newer content.
    const branch = codeBetween("else if (staleStamp && outcome.kind === 'not_landed') {", '}');
    // Same notice as the pre-send check: to the operator it is the same event.
    assert.match(branch, /noteStale\(id, STALE_CLICK_MESSAGE\b/, 'the PT409 not_landed branch must call noteStale(id, STALE_CLICK_MESSAGE)');
  });

  it('a batch row skipped because it changed or was still saving shows the card notice instead of silence', () => {
    // The batch's send-time R2 re-check, up to the continue that leaves the row in the queue.
    const branch = codeBetween('if (requireBucketA &&', 'continue;');
    // The skipped card says why it was left behind, not only an aggregate toast.
    assert.match(branch, /noteStale\(id\b/, 'the batch staleness skip must call noteStale(id)');
  });
});

describe('the notice tells the truth about WHY the click was refused', () => {
  it("a batch row skipped because the operator's own edit is still saving says so, not 'changed'", () => {
    // The exact sentence, module level beside STALE_CLICK_MESSAGE.
    assert.match(
      page,
      /^const SAVING_SKIP_MESSAGE =\s*'Your edit is still saving, so this was not batch-approved\. When it has saved, review it, then approve it\.';/m,
    );
    // The batch skip branch.
    const branch = codeBetween('if (requireBucketA &&', 'continue;');
    // The message is CHOSEN by the in-flight edit: saving -> SAVING_SKIP_MESSAGE, otherwise the stale words.
    assert.match(
      branch,
      /noteStale\(id, editing\.current\.has\(id\) \? SAVING_SKIP_MESSAGE : STALE_CLICK_MESSAGE\b/,
      'the batch skip must pick SAVING_SKIP_MESSAGE when editing.current.has(id)',
    );
    // A row that left the queue has no card; the note is behind a latest-exists guard.
    assert.match(branch, /if \(latest !== undefined\) \{\s*noteStale\(/, 'a row no longer in the queue must not be noted');
  });

  it('a row that vanished is never told to review a latest version', () => {
    // The vanished-row sentence, module level.
    assert.match(
      page,
      /^const GONE_MESSAGE =\s*'This application is no longer available to you\. Reload the page to see the current queue\.';/m,
    );
    // The confirmFresh changed branch.
    const branch = codeBetween("if (check.kind === 'changed') {", 'continue;');
    // Every stale-wording note in it.
    const staleCalls = branch.match(/noteStale\(id, STALE_CLICK_MESSAGE\b/g) ?? [];
    // Exactly one, so no second unguarded call can hide beside the guarded one.
    assert.equal(staleCalls.length, 1, 'the changed branch must note STALE_CLICK_MESSAGE exactly once');
    // And no bare noteStale(id) that would fall back to the default stale message.
    assert.doesNotMatch(branch, /noteStale\(id\)/, 'a bare noteStale(id) defaults to the stale wording');
    // That one call sits directly behind "a fresh row was adopted and is still awaiting".
    assert.match(
      branch,
      /if \(check\.stored\?\.status === 'awaiting_approval'\) \{\s*noteStale\(id, STALE_CLICK_MESSAGE\b/,
      'STALE_CLICK_MESSAGE must be noted only when check.stored is still awaiting_approval',
    );
    // The vanished case says GONE, and only while the card is still rendered.
    assert.match(
      branch,
      /check\.stored === undefined && latestDiffs\.current\.has\(id\)\) \{\s*noteStale\(id, GONE_MESSAGE\b/,
      'a vanished row with a card must be noted GONE_MESSAGE',
    );
  });

  it('a PT409 whose re-read failed adds no card notice (the toast speaks; nothing newer was adopted)', () => {
    // From the branch to the next one: the whole failed-re-read statement.
    const branch = codeBetween('else if (staleStamp) unverified.push(id);', 'else if (noAnswer)');
    // Positive anchor: the slice really is that branch.
    assert.match(branch, /unverified\.push\(id\)/, 'slice must hold the failed-re-read branch');
    // No notice: "review the latest version" would point at a version not on screen.
    assert.doesNotMatch(branch, /noteStale\(/, 'the failed-re-read branch must not note the card');
  });
});

describe('a batch moves focus once', () => {
  it('a batch focuses only the first refused card', () => {
    // settle() is where every refusal is noted.
    const settle = codeBetween('async function settle(', 'function approveReviewed(');
    // The per-settle flag, starting false so the first refusal focuses.
    assert.match(settle, /let focusedOne = false;/, 'settle must declare focusedOne = false');
    // Every noteStale call in settle.
    const calls = settle.match(/noteStale\(/g) ?? [];
    // The three refusal paths (confirmFresh stale + gone, batch skip, PT409) at least.
    assert.ok(calls.length >= 3, `expected >= 3 noteStale calls in settle, found ${calls.length}`);
    // Each one asks for focus only if none was given yet, then marks it given.
    const gated = settle.match(/noteStale\(id, [^;]*\{ focus: !focusedOne \}\);\s*focusedOne = true;/g) ?? [];
    // All of them, so no path can steal focus after the first.
    assert.equal(gated.length, calls.length, 'every noteStale in settle must pass { focus: !focusedOne } then set focusedOne = true');
  });
});

describe('the notice is visible and announced on the card itself', () => {
  // The rendered tag: a paragraph with the class, the status role and polite live region, any attribute order.
  const noticeTag = /<p\b(?=[^>]*className="queue__stale-notice")(?=[^>]*role="status")(?=[^>]*aria-live="polite")[^>]*>/;

  it('a Bucket B card renders its notice as a polite status inside the card', () => {
    // From the row callback to the card's closing tag: the card and anything computed for it.
    const card = codeBetween('{bucketB.map((diff) => {', '</li>');
    // The announced paragraph is inside the card.
    assert.match(card, noticeTag, 'Bucket B card must render <p className="queue__stale-notice" role="status" aria-live="polite">');
    // And it shows THIS row's notice, not someone else's.
    assert.match(card, /staleNotices\.get\(diff\.applicationId\)/, 'Bucket B must read the notice for diff.applicationId');
  });

  it('a Bucket A card renders its notice as a polite status inside the card', () => {
    // Same slice shape for the verified bucket.
    const card = codeBetween('{bucketA.map((diff) => {', '</li>');
    // A batch-skipped row is a Bucket A card, so this is where the batch refusal is seen.
    assert.match(card, noticeTag, 'Bucket A card must render <p className="queue__stale-notice" role="status" aria-live="polite">');
    // Keyed by this row.
    assert.match(card, /staleNotices\.get\(diff\.applicationId\)/, 'Bucket A must read the notice for diff.applicationId');
  });

  it('focus landing on a refused card reads the notice with it (aria-describedby to the notice id)', () => {
    // Both buckets, because a stale refusal can leave the row in either.
    for (const start of ['{bucketB.map((diff) => {', '{bucketA.map((diff) => {']) {
      // The card markup for this bucket.
      const card = codeBetween(start, '</li>');
      // The card points at its notice while one exists; a live region inserted already filled is not reliably spoken.
      assert.match(card, /aria-describedby=\{staleNotices\.has\(diff\.applicationId\) \? staleNoticeId\(diff\.applicationId\) : undefined\}/, start + ' card must be described by its notice');
      // And the notice carries the SAME id, from the same builder.
      assert.match(card, /className="queue__stale-notice" id=\{staleNoticeId\(diff\.applicationId\)\}/, start + ' notice must carry staleNoticeId');
    }
  });
});

describe('the notice clears when the operator acts again', () => {
  it('the next Approve or Reject clears the old notice before the database is asked', () => {
    // settle() is where both verbs are sent.
    const settle = codeBetween('async function settle(', 'function approveReviewed(');
    // Where the RPC is sent; the clear must come before it so an old notice never outlives a new answer.
    const rpcAt = settle.indexOf('.rpc(');
    // The RPC is in this slice, or the anchor is wrong.
    assert.ok(rpcAt >= 0, 'settle() no longer calls .rpc(');
    // Where settle drops the row's notice.
    const clearAt = clearIndex(settle, 'id');
    // Inside settle and ahead of the send: one placement, covering Approve, Reject and the batch alike.
    assert.ok(clearAt >= 0 && clearAt < rpcAt, 'settle() must remove the row notice before the approve/reject RPC');
  });

  it('the next edit clears the old notice before the save', () => {
    // editRow, from its declaration to the next helper (same anchors as approvalBucketMoveFocus.test.ts).
    const edit = codeBetween('async function editRow(', '// Flip one id in a set-valued state');
    // Where the save goes out.
    const saveAt = edit.indexOf('await saveTailoredEdit(');
    // The save is in this slice, or the anchor is wrong.
    assert.ok(saveAt >= 0, 'editRow no longer awaits saveTailoredEdit(');
    // Where the notice is dropped.
    const clearAt = clearIndex(edit, 'applicationId');
    // Present and before the save: an edit is the operator acting on the notice.
    assert.ok(clearAt >= 0 && clearAt < saveAt, 'editRow must remove the row notice before saving');
  });
});
