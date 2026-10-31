/* AddJobLinkPanel (2026-10-31): paste one job link, the job skips every filter and runs to the
 * Approval queue. These tests pin the response shape check, the refusal mapping (needs_text asks
 * for pasted text; quota/closed posting are notices, not errors), and that the agent run is
 * rendered only for a row that still needs agents.
 *
 * Rendered with react-dom/server through the shared .tsx hook; assertions match markup SHAPE
 * (ids, roles, attributes), never prose from comments. The auto-start itself is an effect, which
 * static rendering never runs; the card it reuses is covered by drawerSendPipeline.test.ts. */
// The .tsx loader; must be the first import so it runs first.
import './support/registerTsxHooks.ts';
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

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
  application_status: 'passed_filters',
  created: true,
  revived_from: null,
  source: 'pasted_text',
  job: { title: 'Backend Engineer', company_name: 'Globex', location_raw: 'Hyderabad', apply_url: 'https://www.linkedin.com/posts/x' },
  ...over,
});

// A client whose invoke answers like supabase-js: non-2xx puts the body behind error.context.
function clientAnswering(status: number, body: unknown, sent: unknown[] = []) {
  return {
    functions: {
      invoke: (name: string, options: { body: Record<string, unknown> }) => {
        // Records what was sent, so the body contract is assertable.
        sent.push({ name, body: options.body });
        // 2xx: data; otherwise an error carrying a Response-like context.
        return Promise.resolve(status < 300 ? { data: body, error: null } : { data: null, error: { context: { json: () => Promise.resolve(body) } } });
      },
    },
  };
}

// The view with every handler stubbed.
const view = (state: unknown) =>
  render(h(panel.AddJobLinkView, { state: state as never, url: '', text: '', onUrlChange: () => {}, onTextChange: () => {}, onSubmit: () => {}, pipelineDeps: null }));

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
});

describe('runJobLinkIntake', () => {
  it('sends only the url when the text box is blank, and the text when it is not', async () => {
    const sent: unknown[] = [];
    await panel.runJobLinkIntake(clientAnswering(200, okBody(), sent), ' https://x.example/j ', '   ');
    await panel.runJobLinkIntake(clientAnswering(200, okBody(), sent), 'https://x.example/j', ' the post ');
    assert.deepEqual(sent, [
      { name: 'job-link-intake', body: { url: 'https://x.example/j' } },
      { name: 'job-link-intake', body: { url: 'https://x.example/j', text: 'the post' } },
    ]);
  });

  it('maps needs_text, the notices, and errors', async () => {
    assert.equal((await panel.runJobLinkIntake(clientAnswering(422, { status: 'needs_text', message: 'paste it' }), 'https://x.example/j', '')).kind, 'needs_text');
    for (const status of ['quota', 'posting_closed', 'not_a_job', 'disabled', 'upstream_unavailable']) {
      assert.equal((await panel.runJobLinkIntake(clientAnswering(422, { status, message: 'm' }), 'https://x.example/j', '')).kind, 'notice', status);
    }
    assert.equal((await panel.runJobLinkIntake(clientAnswering(503, { status: 'error', message: 'db down' }), 'https://x.example/j', '')).kind, 'error');
    assert.equal((await panel.runJobLinkIntake(clientAnswering(200, { status: 'ok' }), 'https://x.example/j', '')).kind, 'error');
  });

  it('refuses a blank link without calling the function', async () => {
    const sent: unknown[] = [];
    assert.equal((await panel.runJobLinkIntake(clientAnswering(200, okBody(), sent), '  ', 'text')).kind, 'error');
    assert.equal(sent.length, 0);
  });
});

describe('AddJobLinkView', () => {
  it('labels both fields and ties the needs_text notice to the text box', () => {
    const html = view({ kind: 'needs_text', message: 'Paste the job text.' });
    assert.match(html, /<label[^>]*for="add-job-link-url"/);
    assert.match(html, /<label[^>]*for="add-job-link-text"/);
    assert.match(html, /<textarea[^>]*aria-describedby="add-job-link-needs-text"/);
    assert.match(html, /<p id="add-job-link-needs-text"/);
  });

  it('renders the agent run for a row that still needs agents', () => {
    const result = panel.parseIntakeOk(okBody());
    const html = view({ kind: 'ok', result });
    assert.match(html, /class="[^"]*drawer__send-button/);
    assert.match(html, /href="https:\/\/www\.linkedin\.com\/posts\/x"/);
  });

  it('renders no agent run for a row already at the approval queue', () => {
    const result = panel.parseIntakeOk(okBody({ created: false, application_status: 'awaiting_approval' }));
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
