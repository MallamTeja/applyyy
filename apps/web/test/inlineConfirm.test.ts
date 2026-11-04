/* Inline confirm in place of the browser popup (Teja's order, 2026-11-01 14:04 IST).
 *
 * WHAT THIS PINS. The two writes with no undo, a recovery move (RecoveryRowView) and deleting a custom
 * Answer Bank question (AnswerBankRowActions), still ask first, but in place:
 *   1. the trigger only ARMS the confirm: no write on the first click;
 *   2. armed, the cell shows the same sentence the popup showed, with Confirm/Cancel named for the row,
 *      and the guarded buttons hidden (kept in the box, so the row keeps its height);
 *   3. Confirm calls the write path exactly once, even when clicked twice;
 *   4. Cancel and Escape write nothing and return focus to the button that opened the confirm;
 *   5. one confirm at a time across instances: arming another closes the first;
 *   6. no file under src raises a browser-native dialog: alert/confirm/prompt or a beforeunload
 *      listener (AST, so a comment cannot trip it; widened from the two call sites 2026-11-04).
 *
 * HOW, WITHOUT A DOM. apps/web has no DOM renderer. RecoveryRowView, AnswerBankRowActions and
 * ConfirmActions are hook-free, so calling them returns their element tree, and this file calls the
 * REAL onClick/onKeyDown handlers found in it. The armed markup comes from a static render after the
 * real trigger handler has run (InlineConfirm reads the slot through useSyncExternalStore, whose
 * server snapshot is the same read). A spy stands in for the write behind onMove / onDelete. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, before, describe, it } from 'node:test';

// The shared component and its slot.
let ic: typeof import('../src/app/InlineConfirm.tsx');
// The recovery queue's row view.
let queue: typeof import('../src/features/health/RecoveryQueue.tsx');
// The Answer Bank page module, for its row actions.
let bank: typeof import('../src/features/settings/AnswerBankPage.tsx');
// The real confirm sentence, so this file never keeps its own copy.
let recovery: typeof import('../src/features/health/advanceRecovery.ts');
// The graph, so the rendered moves are the real human edges.
let contract: typeof import('../src/data/contract.ts');
// Static markup, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;

before(async () => {
  // Transpiled by the hook; the same module instance the two call sites import.
  ic = await import('../src/app/InlineConfirm.tsx');
  // Transpiled by the hook.
  queue = await import('../src/features/health/RecoveryQueue.tsx');
  // Transpiled by the hook; its store import loads without a network call.
  bank = await import('../src/features/settings/AnswerBankPage.tsx');
  // Plain .ts.
  recovery = await import('../src/features/health/advanceRecovery.ts');
  // Plain .ts.
  contract = await import('../src/data/contract.ts');
  // The server renderer the other render tests use.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
});

/* ---- element-tree helpers ---- */

// A React element as calling a hook-free component returns it.
type El = { readonly type: unknown; readonly props: Record<string, unknown> };

// True for an element object; strings, numbers, null and false are rendered leaves.
function isEl(node: unknown): node is El {
  // jsx() returns plain objects with type and props.
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node;
}

// Every element under `node` (itself included) that matches, depth first. Function-component elements
// are not rendered, but their props.children are walked, which is where the guarded buttons live.
function findAll(node: unknown, match: (el: El) => boolean, out: El[] = []): El[] {
  // Children arrays, including the nested arrays a .map() produces.
  if (Array.isArray(node)) {
    // Each child in order.
    for (const child of node) findAll(child, match, out);
    // Done with this array.
    return out;
  }
  // A leaf.
  if (!isEl(node)) return out;
  // This element.
  if (match(node)) out.push(node);
  // Its children.
  findAll(node.props['children'], match, out);
  // The collected matches.
  return out;
}

// The one <button> with this exact accessible name; anything else fails loudly, never vacuously.
function buttonNamed(tree: unknown, name: string): El {
  // Matched on aria-label, which every button here carries.
  const hits = findAll(tree, (el) => el.type === 'button' && el.props['aria-label'] === name);
  // Exactly one, or the name is ambiguous or missing.
  assert.equal(hits.length, 1, `expected one button named ${JSON.stringify(name)}, found ${hits.length}`);
  // The button.
  return hits[0] as El;
}

// The InlineConfirm element's id in a tree, so a test uses the id the component chose.
function confirmIdIn(tree: unknown): string {
  // The wrapper element, matched by component identity.
  const hits = findAll(tree, (el) => el.type === ic.InlineConfirm);
  // Exactly one wrapper per row.
  assert.equal(hits.length, 1, 'expected one InlineConfirm in the row');
  // Its id prop.
  return String((hits[0] as El).props['id']);
}

// A stand-in for the clicked button: counts focus() calls, the only method the confirm uses.
function fakeTrigger(): { el: HTMLElement; focused: () => number } {
  // Calls so far.
  let n = 0;
  // Just enough of an HTMLElement.
  const el = { focus: () => { n += 1; } } as unknown as HTMLElement;
  // The element and its counter.
  return { el, focused: () => n };
}

// Runs a button's real onClick with a click event whose currentTarget is `trigger`.
function click(button: El, trigger: HTMLElement | null = null): void {
  // The handler the component wired.
  const onClick = button.props['onClick'] as (e: unknown) => void;
  // A click event shape: only currentTarget is read.
  onClick({ currentTarget: trigger });
}

// The open confirm's Confirm/Cancel strip, as ConfirmActions draws it for instance `id`.
function actionsFor(id: string): El {
  // The open request; null here means the trigger did not arm anything.
  const request = ic.pendingConfirm(id);
  // A missing request would make every later click vacuous.
  assert.ok(request !== null, `no confirm is open for ${id}`);
  // The hook-free strip, called directly.
  return ic.ConfirmActions({ id, request }) as unknown as El;
}

// React escapes " in text and attributes; compare against the escaped form.
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---- fixtures ---- */

// The live GitLab row from the 2026-10-24 incident (needsYouQueues.test.ts uses the same one).
const ROW_RAW = {
  // The real id.
  id: 'ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154',
  // The move's stale-stamp guard.
  updated_at: '2026-10-24T07:35:00.000000+00:00',
  // Swept rows carry no lease.
  claim_expires_at: null,
  // No block reason at needs_verification.
  block_reason: null,
  // Nor a failure reason.
  failure_reason: null,
  // The embedded job.
  jobs: { title: 'Intermediate Backend Engineer, India', company_name: 'GitLab', apply_url: 'https://example.com/job' },
};

// The row's label, as the queue and the confirm both name it.
const LABEL = 'Intermediate Backend Engineer, India at GitLab';

// RecoveryRowView's props for the needs_verification queue, with a spy behind onMove.
function rowProps(onMove: (to: string) => void) {
  // Parsed exactly as the queue's read parses it.
  const row = queue.parseQueueRow('needs_verification', ROW_RAW);
  // A null row would make every assertion vacuous.
  assert.ok(row !== null, 'the GitLab row must parse');
  // The props HealthPage's needs_verification queue passes.
  return {
    // The queue.
    status: 'needs_verification' as const,
    // The parsed row.
    row,
    // The real human edges.
    moves: contract.nextStatuses('needs_verification', 'human'),
    // The page's wording.
    verb: queue.manualActionVerb,
    // And its meaning lines.
    meaning: queue.manualActionMeaning,
    // Not in flight.
    locked: false,
    // Not frozen.
    frozen: false,
    // No lease.
    lease: null,
    // The spy standing in for move() -> advanceRecovery.
    onMove,
  };
}

// The row drawn inside a table, where the queue draws it.
function renderRow(props: ReturnType<typeof rowProps>): string {
  // Static markup of the real component tree, InlineConfirm included.
  return render(h('table', null, h('tbody', null, h(queue.RecoveryRowView, props))));
}

// A custom Answer Bank question; only custom ones offer Delete.
const QUESTION = {
  // Unique bank key.
  key: 'custom_portfolio_url',
  // The prompt the sentence names.
  asks: 'Portfolio URL',
  // Short text.
  type: 'text',
  // Custom questions file under general.
  category: 'general',
  // The stored answer.
  value: 'https://example.com',
  // No seeded default.
  defaultValue: '',
  // Why it exists.
  why: 'Asked by design portals.',
  // Answered.
  needsHuman: false,
  // Never injected yet.
  timesUsed: 0,
  // Never used.
  lastUsedAt: null,
  // The Delete button renders only for custom rows.
  isCustom: true,
} as const;

// Every confirm id a test may leave open; closed after each test so the module slot starts empty.
const OPEN_IDS = new Set<string>();

afterEach(() => {
  // cancelPending only closes its own id, so every id used is closed.
  for (const id of OPEN_IDS) ic.cancelPending(id);
  // Fresh for the next test.
  OPEN_IDS.clear();
});

/* ---- RecoveryRowView: a recovery move ---- */

describe('recovery move: inline confirm in RecoveryRowView', () => {
  it('the move button only arms the confirm: no write on the first click', () => {
    // Write calls.
    const writes: string[] = [];
    // The row's element tree, with the real handlers.
    const tree = queue.RecoveryRowView(rowProps((to) => writes.push(to)));
    // The id the component chose for this row.
    const id = confirmIdIn(tree);
    // Closed after the test.
    OPEN_IDS.add(id);
    // Nothing open before the click.
    assert.equal(ic.pendingConfirm(id), null);
    // The real "I applied" button.
    click(buttonNamed(tree, `I applied (mark applied): ${LABEL}`), fakeTrigger().el);
    // Armed...
    assert.ok(ic.pendingConfirm(id) !== null, 'the click must open the confirm');
    // ...and nothing written.
    assert.deepEqual(writes, []);
  });

  it('armed: shows the confirmText sentence, Confirm/Cancel named for the row, and hides the moves in place', () => {
    // Write calls.
    const writes: string[] = [];
    // Props shared by the click and the render.
    const props = rowProps((to) => writes.push(to));
    // Tree for the click.
    const tree = queue.RecoveryRowView(props);
    // This row's id.
    const id = confirmIdIn(tree);
    // Closed after the test.
    OPEN_IDS.add(id);
    // Positive control first: unarmed, the moves show and no Confirm exists.
    const before = renderRow(props);
    // The move button is drawn...
    assert.match(before, /<button[^>]*>I applied \(mark applied\)<\/button>/);
    // ...visible...
    assert.equal(before.includes('inline-confirm__controls--hidden'), false, 'unarmed moves must be visible');
    // ...with the live region already mounted and empty, so its first sentence is announced.
    assert.match(before, /<p class="inline-confirm__sentence" aria-live="polite"><\/p>/);
    // Arm through the real button.
    click(buttonNamed(tree, `I applied (mark applied): ${LABEL}`), fakeTrigger().el);
    // Armed markup.
    const html = renderRow(props);
    // The exact sentence the popup showed, from the real confirmText, in the live region.
    const sentence = recovery.confirmText(LABEL, { from: 'needs_verification', to: 'applied' });
    // Same text, escaped as React writes it.
    assert.ok(html.includes(`aria-live="polite">${esc(sentence)}</p>`), 'the confirm sentence must be in the live region');
    // Confirm, named for the action and the row.
    assert.match(html, new RegExp(`<button[^>]*aria-label="${esc(`Confirm: I applied (mark applied): ${LABEL}`).replace(/[()]/g, '\\$&')}"[^>]*>Confirm</button>`));
    // Cancel, named the same way.
    assert.match(html, new RegExp(`<button[^>]*aria-label="${esc(`Cancel: I applied (mark applied): ${LABEL}`).replace(/[()]/g, '\\$&')}"[^>]*>Cancel</button>`));
    // The moves are still in the markup (they hold the row's height) but hidden.
    assert.match(html, /class="inline-confirm__controls inline-confirm__controls--hidden"><div class="recovery__moves">/);
    // Arming wrote nothing.
    assert.deepEqual(writes, []);
  });

  it('Cancel is the focused default when the confirm opens', () => {
    // The tree.
    const tree = queue.RecoveryRowView(rowProps(() => {}));
    // This row's id.
    const id = confirmIdIn(tree);
    // Closed after the test.
    OPEN_IDS.add(id);
    // Arm.
    click(buttonNamed(tree, `Failed / skip: ${LABEL}`), fakeTrigger().el);
    // The strip.
    const strip = actionsFor(id);
    // Cancel carries autoFocus (React focuses it on mount, i.e. when the confirm opens)...
    assert.equal(buttonNamed(strip, `Cancel: Failed / skip: ${LABEL}`).props['autoFocus'], true);
    // ...and Confirm does not: Enter on open must not write.
    assert.notEqual(buttonNamed(strip, `Confirm: Failed / skip: ${LABEL}`).props['autoFocus'], true);
  });

  it('Confirm calls the write path exactly once, with the clicked move, even when clicked twice', () => {
    // Write calls.
    const writes: string[] = [];
    // The tree.
    const tree = queue.RecoveryRowView(rowProps((to) => writes.push(to)));
    // This row's id.
    const id = confirmIdIn(tree);
    // Closed after the test.
    OPEN_IDS.add(id);
    // Arm "I applied".
    click(buttonNamed(tree, `I applied (mark applied): ${LABEL}`), fakeTrigger().el);
    // The strip as drawn for the open request.
    const confirm = buttonNamed(actionsFor(id), `Confirm: I applied (mark applied): ${LABEL}`);
    // First click.
    click(confirm);
    // A double click: the same handler again before any re-render.
    click(confirm);
    // One write, for the move that was armed.
    assert.deepEqual(writes, ['applied']);
    // And the confirm is closed.
    assert.equal(ic.pendingConfirm(id), null);
  });

  it('Cancel writes nothing and returns focus to the move button', () => {
    // Write calls.
    const writes: string[] = [];
    // The tree.
    const tree = queue.RecoveryRowView(rowProps((to) => writes.push(to)));
    // This row's id.
    const id = confirmIdIn(tree);
    // Closed after the test.
    OPEN_IDS.add(id);
    // The button the operator clicked.
    const trigger = fakeTrigger();
    // Arm.
    click(buttonNamed(tree, `I applied (mark applied): ${LABEL}`), trigger.el);
    // Cancel.
    click(buttonNamed(actionsFor(id), `Cancel: I applied (mark applied): ${LABEL}`));
    // No write.
    assert.deepEqual(writes, []);
    // Closed.
    assert.equal(ic.pendingConfirm(id), null);
    // Focus went back once.
    assert.equal(trigger.focused(), 1);
  });

  it('Escape cancels (no write, focus back); any other key leaves the confirm open', () => {
    // Write calls.
    const writes: string[] = [];
    // The tree.
    const tree = queue.RecoveryRowView(rowProps((to) => writes.push(to)));
    // This row's id.
    const id = confirmIdIn(tree);
    // Closed after the test.
    OPEN_IDS.add(id);
    // The clicked button.
    const trigger = fakeTrigger();
    // Arm.
    click(buttonNamed(tree, `I applied (mark applied): ${LABEL}`), trigger.el);
    // The strip's key handler.
    const onKeyDown = actionsFor(id).props['onKeyDown'] as (e: unknown) => void;
    // Default-prevented count.
    let prevented = 0;
    // Enter first: positive control that the handler is selective.
    onKeyDown({ key: 'Enter', preventDefault: () => { prevented += 1; } });
    // Still open.
    assert.ok(ic.pendingConfirm(id) !== null, 'a non-Escape key must not close the confirm');
    // Escape.
    onKeyDown({ key: 'Escape', preventDefault: () => { prevented += 1; } });
    // Closed, nothing written, focus back, and only Escape's default prevented.
    assert.equal(ic.pendingConfirm(id), null);
    // Nothing written.
    assert.deepEqual(writes, []);
    // Focus restored once.
    assert.equal(trigger.focused(), 1);
    // Only the Escape.
    assert.equal(prevented, 1);
  });
});

/* ---- AnswerBankRowActions: deleting a custom question ---- */

describe('answer bank delete: inline confirm in AnswerBankRowActions', () => {
  // The sentence the popup asked, verbatim.
  const SENTENCE = 'Are you sure you want to delete "Portfolio URL" from the Answer Bank?';

  it('Delete only arms; armed, the sentence shows and Copy/Delete are hidden in place', () => {
    // Delete calls.
    let deletes = 0;
    // Props shared by click and render.
    const props = { question: QUESTION, onCopy: () => {}, onDelete: () => { deletes += 1; } };
    // The tree with the real handlers.
    const tree = bank.AnswerBankRowActions(props);
    // The id the component chose.
    const id = confirmIdIn(tree);
    // Closed after the test.
    OPEN_IDS.add(id);
    // Unarmed: Copy and Delete visible, no Confirm.
    const before = render(h(bank.AnswerBankRowActions, props));
    // Delete is named for its question.
    assert.match(before, /<button[^>]*aria-label="Delete &quot;Portfolio URL&quot;"/);
    // Not hidden yet.
    assert.equal(before.includes('inline-confirm__controls--hidden'), false);
    // Click the real Delete.
    click(buttonNamed(tree, 'Delete "Portfolio URL"'), fakeTrigger().el);
    // Nothing deleted by the click.
    assert.equal(deletes, 0);
    // Armed markup.
    const html = render(h(bank.AnswerBankRowActions, props));
    // The popup's sentence, in the live region.
    assert.ok(html.includes(`aria-live="polite">${esc(SENTENCE)}</p>`), 'the delete sentence must be in the live region');
    // The strip is hidden but still drawn.
    assert.match(html, /class="inline-confirm__controls inline-confirm__controls--hidden"><div class="answer-bank__row-actions">/);
    // Confirm and Cancel named for the question.
    assert.match(html, /aria-label="Confirm: Delete &quot;Portfolio URL&quot;"[^>]*>Confirm<\/button>/);
    // Cancel too.
    assert.match(html, /aria-label="Cancel: Delete &quot;Portfolio URL&quot;"[^>]*>Cancel<\/button>/);
  });

  it('Confirm deletes exactly once; Cancel deletes nothing and refocuses Delete', () => {
    // Delete calls.
    let deletes = 0;
    // The tree.
    const tree = bank.AnswerBankRowActions({ question: QUESTION, onCopy: () => {}, onDelete: () => { deletes += 1; } });
    // The id.
    const id = confirmIdIn(tree);
    // Closed after the test.
    OPEN_IDS.add(id);
    // The Delete button.
    const del = buttonNamed(tree, 'Delete "Portfolio URL"');
    // The clicked element.
    const trigger = fakeTrigger();
    // Arm, then Cancel.
    click(del, trigger.el);
    // Cancel.
    click(buttonNamed(actionsFor(id), 'Cancel: Delete "Portfolio URL"'));
    // Nothing deleted, focus back on Delete.
    assert.equal(deletes, 0);
    // Focused once.
    assert.equal(trigger.focused(), 1);
    // Arm again, then Confirm twice.
    click(del, trigger.el);
    // The Confirm button for the new request.
    const confirm = buttonNamed(actionsFor(id), 'Confirm: Delete "Portfolio URL"');
    // First click.
    click(confirm);
    // Double click.
    click(confirm);
    // Exactly one delete.
    assert.equal(deletes, 1);
  });

  it('a seeded (non-custom) question has no Delete at all', () => {
    // Same row, not custom.
    const html = render(h(bank.AnswerBankRowActions, { question: { ...QUESTION, isCustom: false }, onCopy: () => {}, onDelete: () => {} }));
    // Positive control: Copy is drawn.
    assert.match(html, /Copy<\/button>/);
    // No Delete.
    assert.equal(html.includes('aria-label="Delete'), false);
  });
});

/* ---- one confirm at a time ---- */

describe('one pending confirm across instances', () => {
  it('arming a second instance closes the first without moving focus; the first Confirm then writes nothing', () => {
    // Recovery writes.
    const moves: string[] = [];
    // Answer Bank deletes.
    let deletes = 0;
    // A recovery row.
    const rowTree = queue.RecoveryRowView(rowProps((to) => moves.push(to)));
    // Its id.
    const rowId = confirmIdIn(rowTree);
    // An Answer Bank row.
    const bankTree = bank.AnswerBankRowActions({ question: QUESTION, onCopy: () => {}, onDelete: () => { deletes += 1; } });
    // Its id.
    const bankId = confirmIdIn(bankTree);
    // Both closed after the test.
    OPEN_IDS.add(rowId).add(bankId);
    // Distinct ids, or this test proves nothing.
    assert.notEqual(rowId, bankId);
    // The recovery button.
    const rowTrigger = fakeTrigger();
    // Arm the recovery move.
    click(buttonNamed(rowTree, `I applied (mark applied): ${LABEL}`), rowTrigger.el);
    // Its Confirm, captured while open (a stale button the operator could still hit).
    const staleConfirm = buttonNamed(actionsFor(rowId), `Confirm: I applied (mark applied): ${LABEL}`);
    // Arm the delete.
    click(buttonNamed(bankTree, 'Delete "Portfolio URL"'), fakeTrigger().el);
    // The recovery confirm closed...
    assert.equal(ic.pendingConfirm(rowId), null);
    // ...without taking focus back...
    assert.equal(rowTrigger.focused(), 0);
    // ...and the delete confirm is the open one.
    assert.ok(ic.pendingConfirm(bankId) !== null);
    // The stale recovery Confirm now does nothing.
    click(staleConfirm);
    // No move written.
    assert.deepEqual(moves, []);
    // And the delete is still pending, untouched.
    assert.equal(deletes, 0);
    // The recovery row renders unarmed again.
    assert.equal(renderRow(rowProps(() => {})).includes('inline-confirm__controls--hidden'), false);
  });
});

/* ---- no browser-native dialog anywhere in the app ----
 * Teja, 2026-11-04 19:06 IST: "i dont need that popup not at all in any page". The browser draws four
 * modal dialogs the app cannot style: alert(), confirm(), prompt(), and the "Leave site?" box a
 * beforeunload listener raises. None may exist in apps/web/src; an in-page UI (InlineConfirm) asks instead. */

describe('no browser-native dialog (alert/confirm/prompt/beforeunload) anywhere in apps/web/src', () => {
  // typescript is a devDependency of apps/web; resolved as noJsxCommentText.test.ts does.
  const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
  // The three dialog functions the browser puts on window.
  const DIALOG_FNS = ['alert', 'confirm', 'prompt'];
  // The global objects they hang off; window.confirm and globalThis.confirm are the same function.
  const GLOBALS = ['window', 'globalThis', 'self'];

  // Counts native-dialog sites and armConfirm() calls in one file, by AST, so a comment or a string
  // that documents the old popup (or an XSS payload like 'javascript:alert(1)') cannot trip it.
  function calls(path: URL): { nativeDialog: number; armConfirm: number } {
    // Parsed as TSX; a plain .ts file parses the same way.
    const sf = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    // Tallies.
    const out = { nativeDialog: 0, armConfirm: 0 };
    // Every node.
    const visit = (node: import('typescript').Node): void => {
      // Calls: the dialog functions, the beforeunload listener, and the inline confirm's door.
      if (ts.isCallExpression(node)) {
        // The callee as written.
        const callee = node.expression;
        // alert(...), confirm(...), prompt(...)
        if (ts.isIdentifier(callee) && DIALOG_FNS.includes(callee.text)) out.nativeDialog += 1;
        // window.confirm(...), globalThis.alert(...), self.prompt(...)
        if (ts.isPropertyAccessExpression(callee) && DIALOG_FNS.includes(callee.name.text) && ts.isIdentifier(callee.expression) && GLOBALS.includes(callee.expression.text)) out.nativeDialog += 1;
        // The first argument, which names the event for an addEventListener call.
        const first = node.arguments[0];
        // x.addEventListener('beforeunload', ...): the listener is what makes the browser ask "Leave site?".
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'addEventListener' && first !== undefined && ts.isStringLiteralLike(first) && first.text === 'beforeunload') out.nativeDialog += 1;
        // The inline confirm's door.
        if (ts.isIdentifier(callee) && callee.text === 'armConfirm') out.armConfirm += 1;
      }
      // window.onbeforeunload = ...: the property form of the same listener.
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'onbeforeunload') out.nativeDialog += 1;
      // Recurse.
      ts.forEachChild(node, visit);
    };
    // Walk the file.
    visit(sf);
    // The tallies.
    return out;
  }

  it('RecoveryQueue.tsx: no native dialog; its moves open the inline confirm', () => {
    // The file's calls.
    const c = calls(new URL('../src/features/health/RecoveryQueue.tsx', import.meta.url));
    // Positive shape first: the moves go through armConfirm.
    assert.ok(c.armConfirm >= 1, 'RecoveryQueue.tsx must open the inline confirm');
    // And no popup.
    assert.equal(c.nativeDialog, 0, 'RecoveryQueue.tsx must not raise a browser dialog');
  });

  it('AnswerBankPage.tsx: no native dialog; Delete opens the inline confirm', () => {
    // The file's calls.
    const c = calls(new URL('../src/features/settings/AnswerBankPage.tsx', import.meta.url));
    // Positive shape first.
    assert.ok(c.armConfirm >= 1, 'AnswerBankPage.tsx must open the inline confirm');
    // And no popup.
    assert.equal(c.nativeDialog, 0, 'AnswerBankPage.tsx must not raise a browser dialog');
  });

  it('every .ts/.tsx file under src: zero native dialogs', () => {
    // The source root.
    const srcRoot = new URL('../src/', import.meta.url);
    // Every source file, nested included (Node's recursive listing, as attestBullet.test.ts uses).
    const files = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f));
    // Positive shape: the walk saw the real tree (90 files on 2026-11-04), so a broken path can't pass on zero.
    assert.ok(files.length >= 50, `expected the whole src tree, saw ${files.length} files`);
    // Each offending file with its count.
    const offenders: string[] = [];
    // Total inline-confirm doors, to prove the visitor reads real call sites.
    let doors = 0;
    // Scan each file.
    for (const f of files) {
      // Its tallies.
      const c = calls(new URL(f.replaceAll('\\', '/'), srcRoot));
      // Collected, so one run names every offender.
      if (c.nativeDialog > 0) offenders.push(`${f}: ${c.nativeDialog}`);
      // Summed.
      doors += c.armConfirm;
    }
    // Positive shape: the two known call sites were seen through this same walk.
    assert.ok(doors >= 2, `expected armConfirm() at RecoveryQueue and AnswerBankPage, saw ${doors}`);
    // The rule itself.
    assert.deepEqual(offenders, [], 'browser-native dialogs found; use an in-page UI such as InlineConfirm');
  });
});
