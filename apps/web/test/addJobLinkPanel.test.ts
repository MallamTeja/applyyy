/* AddJobLinkPanel (2026-10-31): paste one job link, the job skips every filter and runs to the
 * Approval queue. These tests pin the response shape check, the refusal mapping (needs_text,
 * quota and a closed posting are notices, not errors), that the agent run is rendered only for a
 * row that still needs agents, and (2026-11-01) that the panel is one button opening a modal whose
 * only field is the link box: no job text is ever asked for or sent.
 *
 * Rendered with react-dom/server through the shared .tsx hook; assertions match markup SHAPE
 * (ids, roles, attributes), never prose from comments. The auto-start itself is an effect, which
 * static rendering never runs; the card it reuses is covered by drawerSendPipeline.test.ts. */
// The .tsx loader; must be the first import so it runs first.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
// The shared edge-client double, typed against the real EdgeClient so its shape cannot drift (W36).
import { fakeEdgeClient } from './support/fakeEdgeClient.ts';

// The panel module, loaded after the hooks are in place.
let panel: typeof import('../src/features/discovery/AddJobLinkPanel.tsx');
// Static markup, no DOM.
let render: (element: unknown) => string;
// Element factory, so this .ts file needs no JSX.
let h: typeof import('react').createElement;

before(async () => {
  // Transpiled by the hook.
  panel = await import('../src/features/discovery/AddJobLinkPanel.tsx');
  // From the installed react-dom.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's factory.
  h = (await import('react')).createElement;
});

// A 200 body exactly as job-link-intake documents it; mutated per test.
const okBody = (over: Record<string, unknown> = {}) => ({
  status: 'ok',
  application_id: '11111111-1111-4111-8111-111111111111',
  // Since 2026-11-01 the function runs the agents itself and says so.
  pipeline_started: true,
  application_status: 'passed_filters',
  created: true,
  revived_from: null,
  source: 'pasted_text',
  job: { title: 'Backend Engineer', company_name: 'Globex', location_raw: 'Hyderabad', apply_url: 'https://www.linkedin.com/posts/x' },
  ...over,
});

// A client whose invoke answers like supabase-js: non-2xx puts the body behind error.context.
function clientAnswering(status: number, body: unknown, sent: unknown[] = []) {
  return fakeEdgeClient((name: string, options?: { body: Record<string, unknown> }) => {
    // Records what was sent, so the body contract is assertable.
    sent.push({ name, body: options?.body });
    // 2xx: data; otherwise an error carrying a Response-like context.
    return Promise.resolve(status < 300 ? { data: body, error: null } : { data: null, error: { context: { json: () => Promise.resolve(body) } } });
  });
}

// The view with every handler stubbed.
const view = (state: unknown) =>
  render(h(panel.AddJobLinkView, { state: state as never, url: '', onUrlChange: () => {}, onSubmit: () => {}, onClose: () => {}, pipelineDeps: null }));

describe('parseIntakeOk', () => {
  it('accepts the documented body', () => {
    const parsed = panel.parseIntakeOk(okBody());
    assert.equal(parsed?.applicationId, '11111111-1111-4111-8111-111111111111');
    assert.equal(parsed?.companyName, 'Globex');
  });

  it('refuses a non-uuid id, an unknown source, and a missing job', () => {
    assert.equal(panel.parseIntakeOk(okBody({ application_id: 'app-1' })), null);
    assert.equal(panel.parseIntakeOk(okBody({ source: 'rss' })), null);
    assert.equal(panel.parseIntakeOk(okBody({ job: undefined })), null);
    assert.equal(panel.parseIntakeOk(okBody({ revived_from: undefined })), null);
  });

  it('pipeline_started: true is a started run; absent (an older function) is not; a non-boolean is refused', () => {
    assert.equal(panel.parseIntakeOk(okBody())?.pipelineStarted, true);
    // Absent falls to the manual button, the safe side.
    assert.equal(panel.parseIntakeOk(okBody({ pipeline_started: undefined }))?.pipelineStarted, false);
    // A truthy string is not a boolean (repo CLAUDE.md §6).
    assert.equal(panel.parseIntakeOk(okBody({ pipeline_started: 'yes' })), null);
  });
});

describe('describeServerRun', () => {
  it('names the agent at work while inside the server window', () => {
    assert.deepEqual(panel.describeServerRun('passed_filters', 0), { phase: 'running', text: 'Scoring the fit (matcher)…' });
    assert.deepEqual(panel.describeServerRun('scored', 60_000), { phase: 'running', text: 'Tailoring your resume (tailor)…' });
    assert.equal(panel.describeServerRun('audit_flagged', 1).phase, 'running');
    // An unreadable status may be a blip: keep watching.
    assert.equal(panel.describeServerRun(null, 1).phase, 'running');
  });

  it('the queue is ready; drops and failures stop without a button', () => {
    assert.deepEqual(panel.describeServerRun('awaiting_approval', 5), { phase: 'ready' });
    for (const s of ['dropped_filter', 'dropped_duplicate', 'failed', 'approved']) assert.equal(panel.describeServerRun(s, 5).phase, 'stopped', s);
  });

  it('mid-chain at the stall line is stalled, one millisecond before is still running', () => {
    assert.equal(panel.describeServerRun('scored', panel.RUN_STALL_MS - 1).phase, 'running');
    assert.equal(panel.describeServerRun('scored', panel.RUN_STALL_MS).phase, 'stalled');
    assert.equal(panel.describeServerRun(null, panel.RUN_STALL_MS).phase, 'stalled');
    // A finished row is never "stalled", however late the read.
    assert.equal(panel.describeServerRun('awaiting_approval', panel.RUN_STALL_MS * 2).phase, 'ready');
  });
});

describe('runJobLinkIntake', () => {
  it('sends exactly { url }, trimmed, and nothing else (no job text since 2026-11-01)', async () => {
    const sent: unknown[] = [];
    await panel.runJobLinkIntake(clientAnswering(200, okBody(), sent), ' https://x.example/j ');
    // deepEqual on the whole body: a stray `text` key (even empty) fails it.
    assert.deepEqual(sent, [{ name: 'job-link-intake', body: { url: 'https://x.example/j' } }]);
  });

  it('maps needs_text and the other notices to a notice with the server message verbatim, and errors to errors', async () => {
    // needs_text has no remedy box any more: it is a plain notice, the server's words unchanged.
    assert.deepEqual(await panel.runJobLinkIntake(clientAnswering(422, { status: 'needs_text', message: 'This page needs a login.' }), 'https://x.example/j'), { kind: 'notice', message: 'This page needs a login.' });
    for (const status of ['quota', 'posting_closed', 'not_a_job', 'disabled', 'upstream_unavailable']) {
      assert.equal((await panel.runJobLinkIntake(clientAnswering(422, { status, message: 'm' }), 'https://x.example/j')).kind, 'notice', status);
    }
    assert.equal((await panel.runJobLinkIntake(clientAnswering(503, { status: 'error', message: 'db down' }), 'https://x.example/j')).kind, 'error');
    assert.equal((await panel.runJobLinkIntake(clientAnswering(200, { status: 'ok' }), 'https://x.example/j')).kind, 'error');
  });

  it('refuses a blank link without calling the function', async () => {
    const sent: unknown[] = [];
    assert.equal((await panel.runJobLinkIntake(clientAnswering(200, okBody(), sent), '  ')).kind, 'error');
    assert.equal(sent.length, 0);
  });
});

describe('AddJobLinkPanel', () => {
  it('is one chip-btn trigger plus a closed dialog named by its heading', () => {
    // The stateful wrapper as the page mounts it; static rendering runs no click, so the dialog stays closed.
    const html = render(h(panel.AddJobLinkPanel, { client: clientAnswering(200, okBody()) as never, pipelineDeps: null }));
    // The trigger keeps the words humanLanes.ts points people at.
    assert.match(html, /<button type="button" class="chip-btn" aria-haspopup="dialog">Add a job by link<\/button>/);
    // A native dialog, rendered without `open`: nothing shows until the button is pressed.
    assert.match(html, /<dialog class="web-scout add-job-link" aria-labelledby="add-job-link-heading">/);
    // The heading the dialog is labelled by exists inside it.
    assert.match(html, /<h2 id="add-job-link-heading"/);
  });
});

describe('AddJobLinkView', () => {
  it('the modal holds exactly one field: the labelled link box (Teja, 2026-11-01: no job text)', () => {
    const html = view({ kind: 'idle' });
    // Every form control the markup has; the positive shape is "exactly one, and it is the url box".
    const fields = html.match(/<(input|textarea|select)\b[^>]*>/g) ?? [];
    // One field only: a job-text box (or anything else) makes this two.
    assert.equal(fields.length, 1, `fields were ${fields.join(' ')}`);
    // And that one is the url input the label names.
    assert.match(fields[0] ?? '', /id="add-job-link-url"[^>]*type="url"/);
    // Labelled, so a screen reader names it.
    assert.match(html, /<label[^>]*for="add-job-link-url"/);
    // A visible Close button, beside the submit.
    assert.match(html, /<button type="button"[^>]*>Close<\/button>/);
  });

  it('a needs_text notice is a plain notice: the message verbatim, polite, never an alert', () => {
    const html = view({ kind: 'notice', message: 'This page needs a login.' });
    // Inside the polite status region, in the notice box.
    assert.match(html, /role="status"[^>]*>[^]*<p class="web-scout__notice">This page needs a login\.<\/p>/);
    // Not an interruption.
    assert.doesNotMatch(html, /role="alert"/);
  });

  it('a server-started run shows its progress and NO button to press (Teja, 2026-11-01)', () => {
    const result = panel.parseIntakeOk(okBody());
    // A working status reader: with none, the watch is (correctly) stalled from the start.
    const deps = { invoke: () => Promise.resolve({ ok: true, httpStatus: 200, body: {} }), readStatus: () => Promise.resolve('passed_filters') };
    const html = render(h(panel.AddJobLinkView, { state: { kind: 'ok', result } as never, url: '', onUrlChange: () => {}, onSubmit: () => {}, onClose: () => {}, pipelineDeps: deps }));
    assert.match(html, /Scoring the fit \(matcher\)…/);
    assert.doesNotMatch(html, /drawer__send-button/);
    assert.match(html, /href="https:\/\/www\.linkedin\.com\/posts\/x"/);
  });

  it('a stalled watch hands the human the button (no reader means stalled from the start)', () => {
    const html = render(h(panel.ServerRunWatch, { applicationId: '11111111-1111-4111-8111-111111111111', startStatus: 'scored', deps: null, label: 'Globex — Backend Engineer' }));
    assert.match(html, /The server run stopped at scored/);
    assert.match(html, /class="[^"]*drawer__send-button/);
  });

  it('a function that started no run, for a row that still needs agents, gets the manual button', () => {
    const result = panel.parseIntakeOk(okBody({ pipeline_started: undefined }));
    const html = view({ kind: 'ok', result });
    assert.match(html, /class="[^"]*drawer__send-button/);
  });

  it('renders no agent run for a row already at the approval queue', () => {
    const result = panel.parseIntakeOk(okBody({ created: false, application_status: 'awaiting_approval', pipeline_started: false }));
    const html = view({ kind: 'ok', result });
    assert.doesNotMatch(html, /drawer__send-button/);
    assert.equal(panel.needsAgents('awaiting_approval'), false);
    assert.equal(panel.needsAgents('scored'), true);
  });

  it('errors are alerts; notices are not', () => {
    assert.match(view({ kind: 'error', message: 'x' }), /role="alert"/);
    assert.doesNotMatch(view({ kind: 'notice', message: 'x' }), /role="alert"/);
  });
});

// Confirms before adding (2026-11-05). Leak 2: a pasted link used to revive a screener-dropped row
// silently (Scale AI 461f9f6b, dropped work_auth "San Francisco, CA", approved 11-05). Teja's ruling
// (14:12 IST, "Warn, let me confirm"): a NEW pasted job outside the work-authorised countries asks
// too (xAI 0c9fdc58, "Palo Alto, CA"). The function answers 409 needs_confirm with a reason from a
// closed union; only an inline Confirm re-sends the link with confirm: [answers so far].
describe('confirm before adding', () => {
  // The function's question for xAI's paste, as handler.ts words it.
  const paloAlto = { status: 'needs_confirm', reason: 'work_auth', drop_reason: 'work_auth', message: 'Location "Palo Alto, CA" is on-site/hybrid outside the work-authorised countries. Add it anyway?' };

  it('maps a 409 needs_confirm to its own state, carrying the reason, the link and the answers so far', async () => {
    // The first paste, nothing confirmed yet.
    const state = await panel.runJobLinkIntake(clientAnswering(409, paloAlto), ' https://x.example/j ');
    // Neither an error nor "added": a question for the human.
    assert.deepEqual(state, { kind: 'needs_confirm', reason: 'work_auth', message: paloAlto.message, url: 'https://x.example/j', confirmed: [] });
  });

  it('a second question keeps the first answer, so the re-send carries both', async () => {
    // Already confirmed work_auth; now the row turns out to be a dropped one.
    const state = await panel.runJobLinkIntake(clientAnswering(409, { status: 'needs_confirm', reason: 'revive_dropped', message: 'This job was dropped earlier (tech_gate). Add it anyway?' }), 'https://x.example/j', ['work_auth']);
    // The earlier answer travels with the new question.
    assert.deepEqual(state.kind === 'needs_confirm' && [state.reason, state.confirmed], ['revive_dropped', ['work_auth']]);
  });

  it('a reason outside the union is not a question this panel can answer: it is an error with the words', async () => {
    // A future server asking about something this build does not know.
    const state = await panel.runJobLinkIntake(clientAnswering(409, { status: 'needs_confirm', reason: 'tech', message: 'Not a tech role. Add it anyway?' }), 'https://x.example/j');
    // Shown, never confirmable.
    assert.deepEqual(state, { kind: 'error', message: 'Not a tech role. Add it anyway?' });
  });

  it('sends confirm only when there are answers, and nothing extra otherwise', async () => {
    // Every body the fake client received.
    const sent: Array<{ body: Record<string, unknown> }> = [];
    // The ordinary paste.
    await panel.runJobLinkIntake(clientAnswering(200, okBody(), sent), 'https://x.example/j');
    // The confirmed re-send.
    await panel.runJobLinkIntake(clientAnswering(200, okBody(), sent), 'https://x.example/j', ['work_auth', 'revive_dropped']);
    // The first is the old contract exactly; the second adds the answers.
    assert.deepEqual(sent.map((s) => s.body), [{ url: 'https://x.example/j' }, { url: 'https://x.example/j', confirm: ['work_auth', 'revive_dropped'] }]);
  });

  it('the view shows the reason inside the inline confirm slot, never as an alert', () => {
    // The state the wrapper arms the confirm for.
    const html = view({ kind: 'needs_confirm', reason: 'work_auth', message: paloAlto.message, url: 'https://x.example/j', confirmed: [] });
    // The words reach the page (React escapes the quotes).
    assert.match(html, /Palo Alto, CA/);
    // Inside InlineConfirm's grid cell, so the armed question replaces it in place.
    assert.match(html, /class="inline-confirm/);
    // A question, not a failure.
    assert.doesNotMatch(html, /role="alert"/);
  });
});
