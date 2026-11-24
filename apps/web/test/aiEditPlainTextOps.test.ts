/* S44a (2026-11-24, Teja: "rm The old Apply / 'Apply all' cards in resume chat"). The resume chat lost its op cards,
 * Apply / Apply all buttons and previews; the server applies every answer. Nine open applications still hold OLD
 * assistant messages with non-empty `ops`, and an old server deploy could still answer without `applied`. Such a
 * bubble must read as plain text: the AI's words plus one line per proposal, led by a line that never implies the
 * change landed. These tests pin that it is never blank, never offers a button, and never throws on a stored op
 * this build cannot read (a database row is untrusted).
 * RED-ON-REVERT: making AssistantReply render nothing for ops (or call describeOp on an unread op) turns
 * "an old stored reply with ops renders its proposals as text, with no button" (or the malformed-op test) red.
 * Harness: support/registerTsxHooks.ts + react-dom/server, like aiEditJdPending.test.ts (apps/web has no DOM lib). */

// The .tsx render hooks and Vite-style extensionless imports, before anything imports the panel.
import './support/registerTsxHooks.ts';
// Strict asserts.
import assert from 'node:assert/strict';
// Reads the panel source for the one wiring check below.
import { readFileSync } from 'node:fs';
// The runner.
import { before, describe, it } from 'node:test';
// Type only (erased at run time): the stored message shape, so a fixture cannot drift from what the panel reads.
import type { ChatMessage } from '../src/features/approval/resumeChat.ts';

// The panel module, loaded after the hooks.
let panel: typeof import('../src/features/approval/AiEditPanel.tsx');
// Static markup: enough to read what a bubble shows.
let render: (element: unknown) => string;
// React's element factory.
let h: typeof import('react').createElement;

before(async () => {
  // Loaded after the hooks so they apply.
  panel = await import('../src/features/approval/AiEditPanel.tsx');
  // The server renderer: no DOM needed.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // The factory.
  h = (await import('react')).createElement;
});

/* One stored assistant message with the given content and ops; the rest is what any stored row carries. */
function reply(content: string, ops: unknown): ChatMessage {
  // Cast once: the malformed-op test deliberately stores shapes the type forbids, as a drifted row would.
  return { id: 1, chatId: 'c1', role: 'assistant', content, ops: ops as ChatMessage['ops'], usage: null, createdAt: '2026-11-20T10:00:00.000Z' };
}

/* The bubble's markup with React's text separators removed, so a regex reads it as one string. */
function bubble(message: ChatMessage): string {
  // AssistantReply is what the panel renders inside every assistant <li>.
  return render(h(panel.AssistantReply, { message })).replace(/<!-- -->/g, '');
}

describe('S44a: a reply that still carries ops renders as plain text', () => {
  it('an old stored reply with ops renders its proposals as text, with no button', () => {
    // A pre-S9i reply: the AI's note plus two proposals the old page showed as cards.
    const html = bubble(reply('Here are two changes.', [
      // A master skill on.
      { op: 'add_skill', name: 'Kafka', category: 'Tools', inMaster: true },
      // A printed skill off.
      { op: 'remove_skill', ref: 'sk_os', name: 'OS' },
    ]));
    // The AI's words are kept.
    assert.match(html, /Here are two changes\./);
    // Led by the line that says nothing here was applied.
    assert.ok(html.includes(panel.PROPOSED_LEAD), html);
    // One readable line per proposal, in the outcome history's own wording.
    assert.match(html, /<li>Add skill &quot;Kafka&quot;<\/li><li>Remove skill &quot;OS&quot;<\/li>/);
    // No button of any kind: no Apply, Apply all, Retry or group picker.
    assert.doesNotMatch(html, /<button|<select|Apply all|>Apply</);
  });

  it('a refused proposal says it could not be done, with its reason', () => {
    // A stored "Could not do" entry.
    const html = bubble(reply('', [{ op: 'rejected', what: 'Add skill "C"', why: 'The AI named a skill it was not shown.' }]));
    // What was asked and why, never as a pending change.
    assert.match(html, /Could not do: Add skill &quot;C&quot; \(The AI named a skill it was not shown\.\)/);
  });

  it('a malformed or unknown stored op becomes a generic line, never a throw or a blank bubble', () => {
    // A kind this build does not know, a known kind missing its fields, a null and a bare string: all from a drifted row.
    const ops = [{ op: 'move_entry', ref: 'x', place: 2 }, { op: 'add_skill' }, null, 'remove everything'];
    // Rendering must not throw.
    const html = bubble(reply('', ops));
    // The two objects each get the generic line (null and the string are not ops at all, so they are dropped).
    assert.equal(html.split(panel.UNKNOWN_PROPOSAL).length - 1, 2, html);
    // The pure line function is just as safe on any value.
    assert.deepEqual([undefined, 42, {}, { op: 'edit' }].map(panel.proposalLine), Array(4).fill(panel.UNKNOWN_PROPOSAL));
  });

  it('a reply with no ops and no text is never blank', () => {
    // An empty reply: no words, no ops (a claim-only note would be hidden the same way by replyNote).
    const html = bubble(reply('', []));
    // Says plainly that nothing changed.
    assert.match(html, /No changes made to the resume\./);
    // An ops field that is not an array at all reads as "no ops", not as a crash.
    assert.match(bubble(reply('', { op: 'remove' })), /No changes made to the resume\./);
  });

  it('a server-applied reply shows its record and no proposal list', () => {
    // The server's record (server-plan.ts outcomeText) with ops [], as every reply since 2026-11-23 is stored.
    const html = bubble(reply('[Applied: remove skill "VS Code"] Done.', []));
    // The record is the reply.
    assert.match(html, /\[Applied: remove skill &quot;VS Code&quot;\] Done\./);
    // No "proposed" lead and no "no changes" line under a record of changes.
    assert.ok(!html.includes(panel.PROPOSED_LEAD) && !html.includes('No changes made'), html);
  });

  it('the panel renders every assistant bubble through AssistantReply, and has no Apply control left', () => {
    // The panel source, read as text (the panel loads messages in an effect, which a static render never runs).
    const src = readFileSync(new URL('../src/features/approval/AiEditPanel.tsx', import.meta.url), 'utf8');
    // The one assistant render path.
    assert.match(src, /<AssistantReply message=\{message\} \/>/);
    // No Apply / Retry button label and no "Apply all (n)" footer: the shapes the old cards rendered them in.
    assert.doesNotMatch(src, /'Apply'|'Retry'|Apply all \(/);
  });
});

/* S45 + S9k item 2 (Teja 13:42, "very shit reply"): the server now stores one readable sentence run (server-plan.ts
   replyText), opening "Done. " or "Nothing changed.", and the bubble no longer shows the token bill.
   RED-ON-REVERT: dropping the new openings from aiEdit.isServerRecord hides the "Done. Removed: …" reply behind the claim
   filter (first test red); putting formatUsage back in the footer turns the token test red. */
describe('S45: the readable server reply', () => {
  // Teja's target wording for "remove lightgbm, cgboost, microservices, c# and add 3 more tools".
  const target = "Done. Removed: LightGBM, XGBoost (you typed 'cgboost'), Microservices, C#. Added to Tools: YAML Flows. Only 1 more Tools skill is in your master, so 2 of the 3 weren't added. Resume still fits one page.";

  it('a "Done. Removed: …" reply renders whole, with no "no changes" line', () => {
    // Stored by the server with ops [], as every server-applied reply is.
    const html = bubble(reply(target, []));
    // The whole sentence run, apostrophes escaped by React.
    assert.ok(html.replace(/&#x27;/g, "'").includes(target), html);
    // Never contradicted by the "no changes" line, never led by the "proposed" line.
    assert.ok(!html.includes('No changes made') && !html.includes(panel.PROPOSED_LEAD), html);
  });

  it('a "Nothing changed." reply renders whole, so the refusal reasons are read', () => {
    // A reply where the one ask was refused.
    const text = 'Nothing changed. Could not do: Remove skill "Kafka" (It is not on this resume.)';
    // Rendered from a stored row with no ops.
    const html = bubble(reply(text, []));
    // Shown, quotes escaped by React.
    assert.ok(html.replace(/&quot;/g, '"').includes(text), html);
  });

  it('the bubble shows no token bill, even when the usage was reported', () => {
    // A stored reply with a full bill.
    const message: ChatMessage = { ...reply(target, []), usage: { input: 900, cached: 512, output: 120, thinking: 80 } };
    // Rendered.
    const html = bubble(message);
    // No "Tokens: …" and no "Token use not reported." line.
    assert.doesNotMatch(html, /Token/);
  });

  it('the panel stores replyText (the server\'s own wording) when it writes a server-applied exchange itself', () => {
    // The panel source: the write happens in ask(), which a static render never runs.
    const src = readFileSync(new URL('../src/features/approval/AiEditPanel.tsx', import.meta.url), 'utf8');
    // The same function chatRows uses on the server, so a page-written and a server-written bubble read the same.
    assert.match(src, /replyText\(result\.applied, result\.note\)/);
  });
});
