/* A REFUSED edit save keeps the operator's typed words one click away (task C item 4, 2026-10-09).
 *
 * Before: submit() closed the editor on any result, so a refused save (stale row, validator
 * refusal) threw away whatever the operator had typed. Contract in DiffView.tsx's `Line`:
 *   - submit stores the draft in `unsavedDraft` when `!result.ok && action.kind === 'edit'`;
 *   - a successful attempt clears it (it is reset at the start of every attempt);
 *   - a button with className `line__restore-draft`, text "Re-open my unsaved edit", appears
 *     beside the error and, when clicked, puts the draft back (setDraftText) and opens the editor
 *     (setIsEditing(true)).
 *
 * WHY SOURCE SHAPE: renderToStaticMarkup cannot click or await onEdit, and this repo has no DOM
 * test runner. So the file text is read and the POSITIVE shape is asserted: each required
 * statement must be present, inside the function or element it belongs to. Removing any one of
 * them (or moving it out of its scope) turns a named test red.
 * Comments are stripped first, so a comment that merely names a call can never satisfy a check. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// The component under test, read as text.
const SOURCE_PATH = fileURLToPath(new URL('../src/features/approval/DiffView.tsx', import.meta.url));
// Comments removed (block, JSX-block and line comments) so only executable code can match.
const CODE = readFileSync(SOURCE_PATH, 'utf8')
  // Block comments, including {/* */} JSX comments' inner part.
  .replace(/\/\*[\s\S]*?\*\//g, '')
  // Line comments; the lookbehind spares "://" inside URLs.
  .replace(/(?<![:'"`])\/\/.*$/gm, '');

// Returns the text of the brace-balanced block that starts at the first "{" after `start`.
const blockAfter = (code: string, start: number): string => {
  // The opening brace of the body.
  const open = code.indexOf('{', start);
  // No body at all is a shape failure the caller names.
  assert.ok(open >= 0, 'no opening brace after the anchor');
  // Brace depth; strings in this file do not contain unbalanced braces in the scanned bodies.
  let depth = 0;
  // Walk until the matching close brace.
  for (let i = open; i < code.length; i++) {
    // One level deeper.
    if (code[i] === '{') depth++;
    // One level out; at zero the body is complete.
    if (code[i] === '}' && --depth === 0) return code.slice(open, i + 1);
  }
  // Unbalanced means the parse assumption broke; say so rather than pass.
  assert.fail('unbalanced braces after the anchor');
};

// A named function's body; asserts it exists exactly once so the wrong one is never checked.
const functionBody = (name: string): string => {
  // Declarations of this name, async or not.
  const matches = [...CODE.matchAll(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g'))];
  // Exactly one: two would make "which one did we check" ambiguous.
  assert.equal(matches.length, 1, `expected one function ${name}() in DiffView.tsx, found ${matches.length}`);
  // Its body.
  return blockAfter(CODE, matches[0]!.index!);
};

// Whitespace-insensitive "contains this statement", so formatting changes do not break the test.
const has = (haystack: string, needle: RegExp, what: string): void =>
  // The message names the missing piece of the contract.
  assert.match(haystack, needle, `missing: ${what}`);

describe('DiffView Line: a refused edit keeps the draft', () => {
  it('declares unsavedDraft as string | null state starting at null', () => {
    // The state that holds the refused words; null means "nothing kept".
    has(CODE, /const\s*\[\s*unsavedDraft\s*,\s*setUnsavedDraft\s*\]\s*=\s*useState<\s*string\s*\|\s*null\s*>\(\s*null\s*\)/, 'useState<string | null>(null) for unsavedDraft');
  });

  it('submit stores action.text when the result is refused AND the action is an edit', () => {
    // The save handler.
    const submit = functionBody('submit');
    // The exact guard and the store, in one statement: an edit refused keeps its words.
    has(submit, /if\s*\(\s*!result\.ok\s*&&\s*action\.kind\s*===\s*'edit'\s*\)\s*setUnsavedDraft\(\s*action\.text\s*\)/, "if (!result.ok && action.kind === 'edit') setUnsavedDraft(action.text)");
  });

  it('submit clears any kept draft before awaiting onEdit, so a successful save leaves none', () => {
    // The save handler.
    const submit = functionBody('submit');
    // Where the clear sits.
    const clearAt = submit.search(/setUnsavedDraft\(\s*null\s*\)/);
    // Where the save is awaited.
    const awaitAt = submit.search(/await\s+onEdit\(/);
    // Both must exist, or the ordering check below is vacuous.
    assert.ok(clearAt >= 0, 'missing: setUnsavedDraft(null) in submit');
    // Same.
    assert.ok(awaitAt >= 0, 'missing: await onEdit( in submit');
    // Cleared first: only a refusal (the store above) can put a draft back after the await.
    assert.ok(clearAt < awaitAt, 'setUnsavedDraft(null) must run before await onEdit');
  });

  it('the restore handler puts the draft into the editor and opens it', () => {
    // The button's click handler, found by what the button calls.
    const onClick = /className="[^"]*\bline__restore-draft\b[^"]*"[\s\S]*?onClick=\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(CODE)?.[1];
    // The button must name a handler; an inline arrow would need a different check.
    assert.ok(onClick, 'missing: line__restore-draft button with onClick={handler}');
    // The handler's body.
    const body = functionBody(onClick);
    // The editor starts from the kept words, not the stored text.
    has(body, /setDraftText\(\s*unsavedDraft\s*\)/, 'setDraftText(unsavedDraft)');
    // The editor opens.
    has(body, /setIsEditing\(\s*true\s*\)/, 'setIsEditing(true)');
    // Draft text set BEFORE the editor opens, so the textarea never mounts with stale text.
    assert.ok(body.search(/setDraftText\(\s*unsavedDraft\s*\)/) < body.search(/setIsEditing\(\s*true\s*\)/), 'setDraftText must precede setIsEditing(true)');
  });

  it('the line__restore-draft button is a type="button" saying "Re-open my unsaved edit", shown only while a draft is kept', () => {
    // From the visibility guard to the end of the button element.
    const block = /\{\s*unsavedDraft\s*!==\s*null[^?]*\?\s*\(\s*<button\b([\s\S]*?)<\/button>/.exec(CODE);
    // The button is rendered conditionally on a kept draft.
    assert.ok(block, 'missing: {unsavedDraft !== null ... ? (<button ...>...</button>) guard');
    // The whole guard, so its other two conditions are pinned too (review 2026-10-09).
    const guard = /\{\s*(unsavedDraft\s*!==\s*null[^?]*)\?\s*\(\s*<button\b[^>]*line__restore-draft/.exec(CODE)?.[1] ?? '';
    // Only where typed text may land; a skills line has no editor to reopen.
    has(guard, /textTarget\s*!==\s*null/, 'guard includes textTarget !== null');
    // Never while the editor is already open, where it would offer to replace the live draft.
    has(guard, /!isEditing/, 'guard includes !isEditing');
    // Its className.
    has(block[1]!, /className="[^"]*\bline__restore-draft\b[^"]*"/, 'className containing line__restore-draft');
    // Not a form submit.
    has(block[1]!, /type="button"/, 'type="button"');
    // The visible text the contract names.
    has(block[1]!, />\s*Re-open my unsaved edit\b/, 'text "Re-open my unsaved edit"');
  });

  it('the restore button sits next to the line error', () => {
    // Where the error message is rendered.
    const errorAt = CODE.search(/\{\s*error\s*!==\s*null\s*\?/);
    // Where the restore button is rendered.
    const restoreAt = CODE.search(/line__restore-draft/);
    // Both must exist.
    assert.ok(errorAt >= 0 && restoreAt >= 0, `error render at ${errorAt}, restore button at ${restoreAt}`);
    // The button follows the error closely (same JSX region), so it reads as the error's remedy.
    assert.ok(restoreAt > errorAt && restoreAt - errorAt < 1500, `restore button is ${restoreAt - errorAt} chars from the error render`);
  });
});
