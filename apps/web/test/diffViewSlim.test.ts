/* The slim approval card (Teja's rulings, 2026-11-07 10:25 IST): the AI chat is the ONLY edit path.
 *
 * DiffView keeps the decision and drops everything else. This file pins the POSITIVE shape of what
 * stays (CLAUDE.md section 6) and the absence of each removed control by its own markup, never by a
 * bare substring a comment could carry:
 *   - no hand-edit control renders (click-to-edit, Move, Remove, Add back, keyword "+ Add" chips);
 *   - "Changes by AI (N)" is a collapsed <details> listing only CHANGED lines, each with its Reset;
 *   - one "Keep it, I can defend it" per flagged claim, and Approve is disabled while one is undecided;
 *   - Reject's first click ARMS app/InlineConfirm (no onReject); only its Confirm rejects;
 *   - the facts line carries the posting link and, when the page sends one, the pay-band chip;
 *   - no master version, no node ids, no keyword chips, no JD body.
 * apps/web has no DOM renderer, so markup comes from react-dom/server and the hook-free action bar's
 * click handlers are called by value (the inlineConfirm.test.ts pattern). */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose == never passes a wrong shape.
import assert from 'node:assert/strict';
// The node test runner the web suite uses.
import { afterEach, before, describe, it } from 'node:test';

// The component under test.
let view: typeof import('../src/features/approval/DiffView.tsx');
// The shared confirm slot, read to prove Reject armed it.
let ic: typeof import('../src/app/InlineConfirm.tsx');
// Static server renderer, no DOM.
let render: (element: unknown) => string;
// Element factory, so no JSX in this .ts file.
let h: typeof import('react').createElement;

before(async () => {
  // Loaded after the hooks so the .tsx transform and resolve hooks apply.
  view = await import('../src/features/approval/DiffView.tsx');
  // The SAME module instance DiffView imports, so the slot is shared.
  ic = await import('../src/app/InlineConfirm.tsx');
  // The renderer the other DiffView tests use.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's createElement.
  h = (await import('react')).createElement;
});

// The slot is module-level: close anything a test left open so the next one starts clean.
afterEach(() => {
  // Cancelling an id with nothing open is a no-op.
  ic.cancelPending('reject:app-1');
});

// A DiffLine with defaults; each fixture overrides only what makes it distinct.
const line = (over: Record<string, unknown>) => ({
  // Overridden per line.
  id: 'line',
  // A bullet unless said otherwise.
  kind: 'bullet',
  // The master's words.
  masterText: 'Built a REST API serving 500 users',
  // A node id that must never reach the screen.
  masterNodeId: 'node-id-never-shown',
  // The tailor's traced words.
  tailoredRuns: [{ text: 'Built a REST API', verdict: 'traced', tracesTo: 'node-id-never-shown' }],
  // An editable target.
  editTarget: { kind: 'bullet', ref: 'b-default' },
  // Untouched.
  editState: 'original',
  // The tailor's text.
  originalText: 'Built a REST API',
  // No superseded claims.
  supersededClaims: [],
  // The fixture's own fields win.
  ...over,
});

// Untouched: must NOT be listed under Changes by AI.
const UNCHANGED = line({ id: 'l-same', tailoredRuns: [{ text: 'Kept the tailor wording', verdict: 'traced', tracesTo: 'node-id-never-shown' }], originalText: 'Kept the tailor wording', editTarget: { kind: 'bullet', ref: 'b-same' } });
// Edited by the AI: new text listed, old text muted beside it.
const EDITED = line({ id: 'l-edit', tailoredRuns: [{ text: 'Shipped a REST API in Node.js', verdict: 'edited', tracesTo: null }], editState: 'edited', originalText: 'Built a REST API', editTarget: { kind: 'bullet', ref: 'b-edit' } });
// Removed by the AI: the tailor's words struck.
const REMOVED = line({ id: 'l-gone', tailoredRuns: [], editState: 'removed', originalText: 'Led a team of four', editTarget: { kind: 'bullet', ref: 'b-gone' } });
// A flagged claim the operator must keep (or have the AI cut) before Approve.
const FLAGGED = line({ id: 'l-flag', tailoredRuns: [{ text: 'Deployed on ', verdict: 'traced', tracesTo: 'node-id-never-shown' }, { text: 'Kubernetes', verdict: 'fabricated', tracesTo: null }], originalText: 'Deployed on Kubernetes', editTarget: { kind: 'bullet', ref: 'b-flag' } });

// The JD keywords the old chip list printed; none may render now.
const COVERAGE = { jdKeywords: ['Express', 'Kafka'], honestlyMatched: ['Express'], matchedByFabrication: [], matchedByEdit: [] };

// A whole ResumeDiff around the given lines.
const diffOf = (lines: unknown[], over: Record<string, unknown> = {}) => ({
  // Matches the confirm id the card builds.
  applicationId: 'app-1',
  // The header title.
  jobTitle: 'Backend Engineer',
  // The header company.
  companyName: 'Acme',
  // A version number that must not be printed.
  masterVersion: 42,
  // One of two JD keywords matched: "50% Match".
  coverage: COVERAGE,
  // The lines under test.
  lines,
  // None.
  unlocatedClaims: [],
  // Counted the way the adapter does.
  editCount: (lines as { editState: string }[]).filter((l) => l.editState !== 'original').length,
  // Facts-line fields.
  workArrangement: 'remote',
  // A salary range.
  salaryMin: 1000000,
  // Its top.
  salaryMax: 1500000,
  // Its currency.
  salaryCurrency: 'INR',
  // Dropped from the card; must not render.
  employmentType: 'full_time',
  // The posting link's target.
  applyUrl: 'https://boards.example.com/jobs/1',
  // The JD body that used to sit behind "Read the job description".
  jobDescription: '<p>JD-BODY-SENTINEL: you will build things.</p>',
  // Per-test overrides.
  ...over,
});

// The full card with a save path (editing on) and an AI ask, the way the page mounts it.
const card = (lines: unknown[], extra: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  render(
    h(view.DiffView, {
      diff: diffOf(lines, over),
      // Never called in a static render.
      onApprove: () => undefined,
      // Never called in a static render.
      onReject: () => undefined,
      // Editing on: the old hand controls would have rendered here.
      onEdit: async () => ({ ok: true }),
      // Per-test props.
      ...extra,
    } as never),
  );

// Every <button> element's markup, so absence checks look at controls, not prose.
const buttons = (html: string): string[] => html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];

// A React element as calling a hook-free component returns it.
type El = { readonly type: unknown; readonly props: Record<string, unknown> };
// Every element under `node` matching `match`, depth first through props.children.
function findAll(node: unknown, match: (el: El) => boolean, out: El[] = []): El[] {
  // Arrays of children, including nested ones.
  if (Array.isArray(node)) {
    // Each child in order.
    for (const child of node) findAll(child, match, out);
    // Done with this array.
    return out;
  }
  // Leaves (strings, null, false) end the walk.
  if (typeof node !== 'object' || node === null || !('props' in node)) return out;
  // This element.
  if (match(node as El)) out.push(node as El);
  // Its children.
  findAll((node as El).props['children'], match, out);
  // The matches.
  return out;
}

describe('slim card: no hand-edit controls', () => {
  it('slim card renders no edit, move, remove, add or keyword-add control', () => {
    // An edited, a removed, an untouched and a flagged line, editing on: every old control's trigger.
    const html = card([UNCHANGED, EDITED, REMOVED, FLAGGED]);
    // The only button verbs left: Keep, Reset, Approve, Reject.
    for (const b of buttons(html)) {
      // Each button's visible text, tags dropped.
      const text = b.replace(/<[^>]*>/g, '');
      // Positive shape: one of the four allowed controls.
      assert.match(text, /^(Keep it, I can defend it|Reset to tailor’s version.*|Approve and queue for submission|Reject application)$/, `unexpected control: ${text}`);
    }
    // No click-to-edit text button and no textarea of any kind.
    assert.doesNotMatch(html, /<textarea\b|class="line__text-button"/);
    // No Side-by-side/Unified toggle and no comparison panes.
    assert.doesNotMatch(html, /class="diff__view-toggle"|class="diff__panes/);
  });
});

describe('slim card: Changes by AI', () => {
  it('Changes by AI lists only changed lines, each with its Reset', () => {
    // Two changes and one untouched line.
    const html = card([UNCHANGED, EDITED, REMOVED]);
    // A collapsed native disclosure (no `open` attribute) with the count of CHANGED lines.
    assert.match(html, /<details class="diff__changes"><summary class="diff__changes-summary">Changes by AI \(2\)<\/summary>/);
    // Exactly two rows.
    assert.equal(html.match(/<li class="line diff__change">/g)?.length, 2);
    // The edited line's new words, and the tailor's old ones muted beside them.
    assert.match(html, /Shipped a REST API in Node\.js[\s\S]*<span class="diff__change-old-label">Was: <\/span><del>Built a REST API<\/del>/);
    // The removed line, struck.
    assert.match(html, /<s>Led a team of four<\/s>/);
    // Not listed: the untouched line's words appear nowhere on the card.
    assert.ok(!html.includes('Kept the tailor wording'), 'an unchanged line was listed');
    // One Reset per changed row.
    assert.equal(html.match(/>Reset to tailor’s version</g)?.length, 2);
    // Provenance class the e2e counts (aiEditE2e.test.ts) still marks the edited row.
    assert.match(html, /<p class="line__provenance line__provenance--edited">edited by you<\/p>/);
  });

  it('Changes by AI is absent when nothing changed', () => {
    // An untouched resume.
    const html = card([UNCHANGED]);
    // No empty disclosure.
    assert.doesNotMatch(html, /class="diff__changes"/);
  });

  it('Changes by AI offers no Reset when editing is off', () => {
    // D4: the page says why editing is off.
    const html = card([EDITED], { editDisabledReason: 'The tailor version could not be rebuilt.' });
    // The row is still listed, so the operator sees what changed...
    assert.match(html, /Changes by AI \(1\)/);
    // ...but no Reset, which could not be honest without a tailor version.
    assert.doesNotMatch(html, /Reset to tailor/);
  });
});

describe('slim card: the per-claim gate', () => {
  it('Keep it control renders once per flagged claim and Approve is disabled until kept', () => {
    // One flagged claim.
    const html = card([FLAGGED]);
    // Exactly one Keep control, a real button, not yet pressed.
    assert.equal(html.match(/<button type="button" class="button button--small alarm__keep" aria-pressed="false">Keep it, I can defend it<\/button>/g)?.length, 1);
    // Approve is disabled while the claim is undecided.
    assert.match(html, /<button type="button" class="button button--approve" disabled="">Approve and queue for submission<\/button>/);
    // The instruction no longer offers a cut.
    assert.match(html, /<p class="alarm__instruction">Keep each claim you can defend to unlock approval\. To change or drop one, ask the AI chat\.<\/p>/);
    // Paired control: a clean row's Approve is enabled, so "disabled" above is the claim's doing.
    assert.match(card([UNCHANGED]), /<button type="button" class="button button--approve">Approve and queue for submission<\/button>/);
  });
});

describe('slim card: Reject behind InlineConfirm', () => {
  it('Reject first click arms the inline confirm and does not reject', () => {
    // Calls to the page's reject.
    const rejected: string[] = [];
    // The hook-free action bar, called directly so its real handlers can be clicked.
    const tree = view.ApprovalActions({
      confirmId: 'reject:app-1', subject: 'Backend Engineer at Acme', canApprove: true,
      approveLabel: 'Approve and queue for submission', onApproveClick: () => undefined,
      onReject: (reason) => rejected.push(reason), busy: false,
    });
    // Both buttons sit inside the InlineConfirm, so the question replaces the whole bar.
    assert.equal((tree as unknown as El).type, ic.InlineConfirm);
    // The Reject button, by its visible words.
    const [reject] = findAll(tree, (el) => el.type === 'button' && el.props['children'] === 'Reject application');
    // Missing would make the click below vacuous.
    assert.ok(reject !== undefined, 'Reject button not found');
    // The first click, with a stand-in trigger.
    (reject.props['onClick'] as (e: unknown) => void)({ currentTarget: null });
    // Nothing rejected yet.
    assert.deepEqual(rejected, [], 'the first click must not reject');
    // The confirm is open on this row, naming it.
    assert.equal(ic.pendingConfirm('reject:app-1')?.action, 'Reject: Backend Engineer at Acme');
    // Confirm is the only door: it rejects exactly once.
    assert.equal(ic.confirmPending('reject:app-1'), true);
    // The reason the page has always received.
    assert.deepEqual(rejected, ['rejected at approval gate']);
  });

  it('Approve and Reject sit in one action bar, Approve first', () => {
    // A clean row.
    const html = card([UNCHANGED]);
    // One group, Approve then Reject, inside the inline-confirm cell.
    assert.match(html, /<div class="diff__actions-group"><button type="button" class="button button--approve">[^<]*<\/button><button type="button" class="button button--secondary button--reject">Reject application<\/button><\/div>/);
  });
});

describe('slim card: no repeated title', () => {
  it('slim card renders no h2 with the job title (the row head shows it)', () => {
    // A card with a title the row head already shows.
    const html = card([UNCHANGED]);
    // No h2 at all, so no repeat of "Backend Engineer at Acme".
    assert.doesNotMatch(html, /<h2\b/);
    // The facts line is the card's first content, opening the header.
    assert.match(html, /^<article class="diff"><header class="diff__header"><div class="diff__identity"><div class="diff__tags">/);
  });
});

describe('slim card: the facts line', () => {
  it('facts line carries the posting link, and the pay-band chip only when sent', () => {
    // No warning from the page.
    const plain = card([UNCHANGED]);
    // The posting link, safe-checked, opening in its own tab.
    assert.match(plain, /<a class="diff__posting-link" href="https:\/\/boards\.example\.com\/jobs\/1" target="_blank" rel="noopener noreferrer">Open the original posting<\/a>/);
    // Work type and salary still in the line.
    assert.match(plain, /<span class="tag-pill tag-pill--arrangement">remote<\/span>/);
    // The salary pill.
    assert.match(plain, /class="tag-pill tag-pill--salary"/);
    // No chip without a warning.
    assert.doesNotMatch(plain, /tag-pill--signal/);
    // Null is also nothing.
    assert.doesNotMatch(card([UNCHANGED], { payBandWarning: null }), /tag-pill--signal/);
    // With the warning: one signal chip carrying the literal.
    assert.match(card([UNCHANGED], { payBandWarning: 'Pay band UK/US only' }), /<span class="tag-pill tag-pill--signal">Pay band UK\/US only<\/span>/);
  });
});

describe('slim card: data dumps are gone', () => {
  it('slim card shows no master version, node id, keyword chip, JD body or employment type', () => {
    // A flagged row with an edit: the most the old card would print.
    const html = card([UNCHANGED, EDITED, FLAGGED]);
    // "Tailored from master version 42" and "Master version 42 does not support" are both gone.
    assert.doesNotMatch(html, /[Mm]aster version/);
    // No node id anywhere: not a "traced to <id>" footer, not an identifier span, not a spoken suffix.
    assert.ok(!html.includes('node-id-never-shown'), 'a node id is shown');
    // The ATS panel is back (Teja, 2026-11-07 night) but read-only: none of the old hand-edit controls
    // (the "+ Add" skill chip, the attest group, the Undo, the master link) can return with it.
    assert.doesNotMatch(html, /kw-chip--addable|kw-chip__add|coverage__attest|coverage__master-link/);
    // Positive control: the panel itself did render, so the absence above is not a missing panel.
    assert.match(html, /<span class="coverage__ats-badge">50% Match<\/span>/);
    // No JD body and no posting panel.
    assert.ok(!html.includes('JD-BODY-SENTINEL'), 'the JD body rendered');
    // No posting panel class.
    assert.doesNotMatch(html, /class="job-posting/);
    // Employment type and the always-true awaiting_approval pill left the header.
    assert.doesNotMatch(html, /full time|full_time|awaiting_approval/);
  });
});
