/* The auditor's jd_keyword_dropped finding on the approval page (P2 #17, coordinator ruling 2026-11-07).
 *
 * The finding says a TRUE word was lost, not that a false one was written. Its `claim` is the whole
 * tailored bullet (detector.ts:503-514), so the fabricated path would mark the entire bullet
 * "traces to nothing", the accusation diffAdapter.ts:119-122 says must never be made. The rulings:
 *   - no fabricated run and no "claims ... trace to nothing" entry for this kind;
 *   - still VISIBLE as its own note: a heading plus the producer's `reason` VERBATIM (capped);
 *   - still keeps the row out of Bucket A (fail closed: it needs a look, not the batch button);
 *   - a malformed one (no string reason) falls back to the generic fabricated/unlocated path.
 * Fixture: the validator-accepted master + tailoring shape approvalEdits.test.ts uses, cut down. */

// The .tsx loader; must be the first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose == never passes a wrong shape.
import assert from 'node:assert/strict';
// The node test runner the web suite uses.
import { describe, it, before } from 'node:test';

// The adapter: stored findings in, view model out.
let adapter: typeof import('../src/features/approval/diffAdapter.ts');
// The bucket and the flagged-claim list the batch button and the alarm both read.
let model: typeof import('../src/features/approval/diffModel.ts');
// The producer, used to build the resume exactly as the page rebuilds it.
let validator: typeof import('../../../supabase/functions/_shared/tailor/validator.ts');
// The component, for the rendered note.
let view: typeof import('../src/features/approval/DiffView.tsx');
// Static server renderer, no DOM.
let render: (element: unknown) => string;
// Element factory, so no JSX in this .ts file.
let h: typeof import('react').createElement;

before(async () => {
  // Loaded after the hooks so the resolve hook applies to their extensionless imports.
  adapter = await import('../src/features/approval/diffAdapter.ts');
  // Same.
  model = await import('../src/features/approval/diffModel.ts');
  // Type-stripped Deno module; it has no runtime imports.
  validator = await import('../../../supabase/functions/_shared/tailor/validator.ts');
  // The .tsx component, transpiled by the hooks.
  view = await import('../src/features/approval/DiffView.tsx');
  // The renderer the other DiffView tests use.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's createElement.
  h = (await import('react')).createElement;
});

// The pinned master version.
const VERSION = 3;
// The tailored bullet the finding names; its whole text is the producer's `claim`.
const BULLET = 'Built a REST API with Express and Node.js handling 500 users';

// One employer, one bullet, one skill: the least the validator accepts.
const MASTER = {
  // Shape marker.
  schema_version: 1,
  // Verbatim identity.
  identity: { full_name: 'Test Person', headline: 'Backend Engineer', email: 'test@example.com', phone: null, location: 'Hyderabad', links: [] },
  // A citable summary node.
  summary: { id: 'summary-master', text: 'Backend engineer building REST APIs in Node.js.' },
  // The one employer.
  experience: [{
    id: 'exp-acme', company: 'Acme', role: 'Backend Intern', location: 'Remote',
    start_display: 'Jun 2025', end_display: 'Aug 2025', start_date: null, end_date: null,
    // The one bullet.
    bullets: [{ id: 'b-api', text: BULLET, tags: [] }],
  }],
  // Required arrays.
  projects: [], education: [], achievements: [], certifications: [],
  // One skill.
  skills: [{ id: 'skill-node', name: 'Node.js', category: 'Frameworks' }],
  // Profile links.
  links: [],
} as never;

// The tailoring as stored in tailor_refs.
const TAILOR_REFS = {
  // Shape marker.
  schema_version: 1,
  // Matches VERSION.
  master_version: VERSION,
  // Document order.
  section_order: ['summary', 'experience', 'skills'],
  // Cites the master summary.
  summary: { text: 'Backend engineer building REST APIs in Node.js.', refs: ['summary-master'] },
  // Chosen by id.
  skills: [{ ref: 'skill-node' }],
  // The bullet, verbatim.
  experience: [{ ref: 'exp-acme', bullets: [{ ref: 'b-api', text: BULLET }] }],
  // Required arrays.
  projects: [], education: [], achievements: [], certifications: [],
} as never;

// The adapter's own path for the bullet: a finding here would be LOCATED, i.e. a fabricated run.
const ADAPTER_PATH = 'experience.exp-acme.b-api';
// The detector's path form (detector.ts:409): a finding here would be UNLOCATED, i.e. the alarm list.
const DETECTOR_PATH = 'experience[0].bullets[0]';
// The producer's reason, as detector.ts:511 writes it.
const REASON = 'Bullet dropped posting keyword(s) the master bullet has: Kafka';

// The resume as the validator resolves it.
const resolved = () => {
  // Producer verdict.
  const verdict = validator.validateTailoredProfile(TAILOR_REFS, MASTER, VERSION);
  // A refusal here is a fixture bug, named as such.
  assert.equal(verdict.ok, true, 'fixture must validate');
  // Narrowed; the cast is safe after the assert.
  return (verdict as { resume: unknown }).resume;
};

// One jd_keyword_dropped finding exactly as the producer stores it; `over` breaks a field.
const dropped = (path: string, over: Record<string, unknown> = {}) => ({
  kind: 'jd_keyword_dropped', path, claim: BULLET, reason: REASON, confidence: 1, ...over,
});

// The diff the page would build for the given findings.
const diff = (findings: unknown[]) =>
  adapter.buildResumeDiff({
    // Minimal application row: id, pinned version, findings and JD keywords.
    application: { id: 'app-1', master_version: VERSION, audit_findings: findings, selected_jd_keywords: ['Express'] } as never,
    // Header fields only.
    job: { title: 'Backend Engineer', company_name: 'Acme' },
    // What tailored_profile holds.
    resolved: resolved() as never,
    // The pinned master.
    master: MASTER,
    // Unedited: current equals original.
    original: resolved() as never,
  });

// Every fabricated run on every line, the marker this kind must never get.
const fabricatedRuns = (d: ReturnType<typeof diff>) => d.lines.flatMap((line) => line.tailoredRuns.filter((run) => run.verdict === 'fabricated'));

describe('jd_keyword_dropped on the approval page', () => {
  it('jd_keyword_dropped is not a fabricated run over the bullet, at either path form', () => {
    // Both path forms: the adapter's (would be located) and the detector's (would be unlocated).
    for (const path of [ADAPTER_PATH, DETECTOR_PATH]) {
      // The diff with only this finding.
      const d = diff([dropped(path)]);
      // No line carries a fabricated run: the bullet's words are all true.
      assert.deepEqual(fabricatedRuns(d), [], `fabricated run at ${path}`);
      // Nothing reaches the "trace to nothing" alarm either.
      assert.deepEqual(model.collectFlaggedClaims(d), [], `flagged claim at ${path}`);
    }
  });

  it('jd_keyword_dropped is listed as its own note with the reason verbatim', () => {
    // The diff with only this finding.
    const d = diff([dropped(DETECTOR_PATH)]);
    // One note, carrying the producer's words unparsed.
    assert.deepEqual(d.keywordDrops?.map((note) => note.reason), [REASON]);
  });

  it('jd_keyword_dropped still keeps the row out of Bucket A', () => {
    // A dropped keyword needs a look; it must never ride the batch button (fail closed).
    assert.equal(model.deriveBucket(diff([dropped(DETECTOR_PATH)])), 'B');
    // Positive control: the same row with no findings is Bucket A, so the B above is the finding's.
    assert.equal(model.deriveBucket(diff([])), 'A');
  });

  it('jd_keyword_dropped with no string reason falls back to the generic flagged path', () => {
    // A reason that is not a string: the note cannot be shown, so it must not vanish either.
    const d = diff([dropped(DETECTOR_PATH, { reason: 42 })]);
    // No note was made from it.
    assert.deepEqual(d.keywordDrops ?? [], []);
    // It is in the alarm instead, exactly as any other unreadable finding.
    assert.equal(model.collectFlaggedClaims(d).length, 1);
  });

  it('jd_keyword_dropped with structured keywords names them, not the reason prose', () => {
    // The producer's structured field (1866e7f): the words to name, in vocabulary spelling.
    const d = diff([dropped(DETECTOR_PATH, { keywords: ['Kafka', 'Redis'] })]);
    // The note names the keywords plainly; the prose is no longer needed.
    assert.deepEqual(d.keywordDrops?.map((note) => note.reason), ['Kafka, Redis']);
  });

  it('jd_keyword_dropped with malformed keywords falls back to the reason verbatim', () => {
    // Each malformed shape: empty list, a non-string member, a blank member, not a list at all.
    for (const keywords of [[], ['Kafka', 7], ['  '], 'Kafka']) {
      // The diff with the broken field.
      const d = diff([dropped(DETECTOR_PATH, { keywords })]);
      // Never a half-list or a guess: the producer's own words instead.
      assert.deepEqual(d.keywordDrops?.map((note) => note.reason), [REASON], `keywords ${JSON.stringify(keywords)}`);
    }
  });

  it('jd_keyword_dropped reason over the cap is cut and ends with an ellipsis', () => {
    // A reason far past any real one.
    const d = diff([dropped(DETECTOR_PATH, { reason: 'x'.repeat(5000) })]);
    // The shown text.
    const shown = d.keywordDrops?.[0]?.reason ?? '';
    // Capped well below the input, and marked as cut.
    assert.ok(shown.length <= 301 && shown.endsWith('…'), `not capped: ${shown.length}`);
  });

  it('jd_keyword_dropped renders its heading and reason, and no alarm or "0 changes" line', () => {
    // The page as DiffView draws it for this row.
    const html = render(h(view.DiffView, { diff: diff([dropped(DETECTOR_PATH)]), onApprove: () => undefined, onReject: () => undefined } as never));
    // The plain-words heading.
    assert.ok(html.includes('Dropped a JD keyword your master had'), 'heading missing');
    // The producer's reason, verbatim.
    assert.ok(html.includes(REASON), 'reason missing');
    // Not the fabrication alarm.
    assert.ok(!html.includes('trace to\nnothing') && !html.includes('alarm-heading'), 'rendered as fabrication');
    // Not the edits-only notice with a zero count.
    assert.ok(!html.includes('You made 0 changes'), 'rendered a zero-change notice');
  });
});
