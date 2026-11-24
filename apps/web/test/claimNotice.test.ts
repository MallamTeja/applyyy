/* The approval page's claim notice (S24, 2026-11-24: Teja, "rip empathy ux").
 *
 * Three defects on one block, each pinned here so its revert goes red:
 *   - rule 5 quoted the WHOLE bullet as its claim, so a true Aczen bullet was marked and listed as
 *     invented over one re-inflected verb. The detector now stores `words`; the adapter marks only those;
 *   - a flagged word was located with a bare indexOf, so "ai" would mark the inside of "maintaining";
 *   - the notice spliced the first claim into "...about your {claim} work.", printing
 *     "...social media. work." The copy now takes a count only.
 * Fixture style: findingPathForms.test.ts, cut to one entry carrying the live Aczen bullet. */

// The .tsx loader; first import so it runs before any component loads.
import './support/registerTsxHooks.ts';
// Strict asserts, so a loose == never passes a wrong shape.
import assert from 'node:assert/strict';
// The node test runner the web suite uses.
import { describe, it, before } from 'node:test';

// The adapter: stored findings in, view model out.
let adapter: typeof import('../src/features/approval/diffAdapter.ts');
// The flagged-claim list and the notice copy.
let model: typeof import('../src/features/approval/diffModel.ts');
// The producer, used to build the resume exactly as the page rebuilds it.
let validator: typeof import('../../../supabase/functions/_shared/tailor/validator.ts');

before(async () => {
  // Loaded after the hooks so the resolve hook applies to their extensionless imports.
  adapter = await import('../src/features/approval/diffAdapter.ts');
  // Same.
  model = await import('../src/features/approval/diffModel.ts');
  // Type-stripped Deno module; it has no runtime imports.
  validator = await import('../../../supabase/functions/_shared/tailor/validator.ts');
  // The card itself, for the render test: the copy is only proven where DiffView prints it.
  view = await import('../src/features/approval/DiffView.tsx');
  // Static server renderer, no DOM (apps/web has none), as diffViewSlim.test.ts renders the card.
  render = (await import('react-dom/server')).renderToStaticMarkup as (element: unknown) => string;
  // React's createElement, so this .ts file needs no JSX.
  h = (await import('react')).createElement;
});

// The approval card under the render test.
let view: typeof import('../src/features/approval/DiffView.tsx');
// renderToStaticMarkup, typed loosely so createElement's result passes without a JSX file.
let render: (element: unknown) => string;
// Element factory.
let h: typeof import('react').createElement;

// The pinned master version.
const VERSION = 52;
// Master v52's bullet_aczen_agents, verbatim (live SELECT 2026-11-24).
const MASTER_TEXT = 'Built multi-step AI agents that automate repetitive manual workflows across lead enrichment, accounting assistance, customer engagement and social media.';
// The tailored text that row 957991ec carried on 2026-11-23, ending in a full stop like every bullet.
const TAILORED = 'Engineered multi-step AI agents automating manual workflows across lead enrichment, accounting assistance, customer engagement, and social media.';
// The word-boundary fixture: "ai" occurs first inside "maintaining".
const AI_TEXT = "Kept maintaining AI agents for lead enrichment.";
// The fixture master holds every tailored word: the tailor validator checks tokens, and the adapter
// never re-audits, so the findings below are supplied by hand exactly as the auditor stored them.
const FIXTURE_MASTER_TEXT = MASTER_TEXT + " " + TAILORED + " " + AI_TEXT;
// The line key bulletLines builds for this bullet.
const PATH = 'experience.exp_aczen.bullet_aczen_agents';

// One employer with the one bullet, in the master's shape.
const MASTER = {
  // Shape marker.
  schema_version: 1,
  // Verbatim identity.
  identity: { full_name: 'Test Person', headline: 'AI Engineer', email: 'test@example.com', phone: null, location: 'Hyderabad', links: [] },
  // No summary: only the bullet is under test.
  summary: null,
  // The employer.
  experience: [
    {
      // Identity and dates, all verbatim fields.
      id: 'exp_aczen', company: 'Aczen', role: 'Intern', location: 'Remote', start_display: 'Jun 2025', end_display: 'Aug 2025', start_date: null, end_date: null,
      // The bullet, untagged.
      bullets: [{ id: 'bullet_aczen_agents', text: FIXTURE_MASTER_TEXT, tags: [] }],
    },
  ],
  // Required arrays.
  projects: [], education: [], achievements: [], certifications: [],
  // One skill.
  skills: [{ id: 'skill-py', name: 'Python', category: 'Languages' }],
  // Profile links.
  links: [],
} as never;

// The resume as the validator resolves it, carrying `text` as the bullet's tailored wording.
const resolvedWith = (text: string) => {
  // The tailoring as stored in tailor_refs.
  const refs = {
    // Shape marker.
    schema_version: 1,
    // Matches VERSION.
    master_version: VERSION,
    // Document order.
    section_order: ['experience', 'skills'],
    // No summary.
    summary: null,
    // Chosen by id.
    skills: [{ ref: 'skill-py' }],
    // The one entry and bullet.
    experience: [{ ref: 'exp_aczen', bullets: [{ ref: 'bullet_aczen_agents', text }] }],
    // Required arrays.
    projects: [], education: [], achievements: [], certifications: [],
  } as never;
  // Producer verdict.
  const verdict = validator.validateTailoredProfile(refs, MASTER, VERSION);
  // A refusal here is a fixture bug, named as such.
  assert.equal(verdict.ok, true, 'fixture must validate: ' + JSON.stringify(verdict));
  // The resolved resume.
  return (verdict as { resume: unknown }).resume;
};

// A rule-5 finding as the detector stores it since 2026-11-23: whole-bullet claim plus `words`.
const termsFinding = (claim: string, words: unknown) => ({
  // Rule 5's kind.
  kind: 'unfaithful_rewording',
  // The ref form the auditor writes as ref_path.
  path: PATH,
  // The whole bullet, as rule 5 quotes it.
  claim,
  // The reason text the detector writes.
  reason: 'Bullet text contains ungrounded term(s) not found in master: automating',
  // Rule 5's confidence.
  confidence: 0.85,
  // The field under test.
  words,
});

// The diff the page would build for the stored text and findings (D4: no original, simplest path).
const diff = (text: string, findings: unknown[]) =>
  adapter.buildResumeDiff({
    // Minimal application row.
    application: { id: 'app-1', audit_findings: findings, selected_jd_keywords: [] } as never,
    // Header fields only.
    job: { title: 'AI Engineer', company_name: 'Acme' },
    // What tailored_profile holds.
    resolved: resolvedWith(text) as never,
    // The pinned master.
    master: MASTER,
    // D4: no rebuildable original, the simplest path; the field is required, so null says so explicitly.
    original: null,
  });

// Every flagged claim as `lineId|text`, the exact positive shape each test asserts.
const flagged = (d: ReturnType<typeof diff>) => model.collectFlaggedClaims(d).map((c) => `${c.lineId}|${c.text}`);

describe('claim notice: rule 5 marks only its words', () => {
  it('rule-5 words: a finding with words marks and lists only "automating", not the whole Aczen bullet', () => {
    // The live shape: whole bullet as claim, one word as data.
    const d = diff(TAILORED, [termsFinding(TAILORED, ['automating'])]);
    // Exactly the word, on its line; reverting perWordFindings lists the whole bullet here instead.
    assert.deepEqual(flagged(d), [PATH + '|automating']);
    // The rest of the bullet is still traced text, not part of the mark.
    const line = d.lines.find((l) => l.id === PATH);
    // The flagged runs on the line: the one word, in the resume's own casing.
    assert.deepEqual(line?.tailoredRuns.filter((run) => run.verdict === 'fabricated').map((run) => run.text), ['automating']);
  });

  it('rule-5 words: malformed words fall back to the whole-bullet claim (fail closed)', () => {
    // Each malformed shape the stored jsonb could hold.
    for (const words of [[], [''], [1], 'automating', null]) {
      // Old behaviour: the whole bullet is the claim, so nothing is hidden.
      assert.deepEqual(flagged(diff(TAILORED, [termsFinding(TAILORED, words)])), [PATH + '|' + TAILORED], JSON.stringify(words));
    }
  });

  it('rule-5 words: a word absent from the line stays listed as unlocated, never dropped', () => {
    // A word the text does not contain.
    const d = diff(TAILORED, [termsFinding(TAILORED, ['kubernetes'])]);
    // Listed against its path, so approval still waits on it.
    assert.deepEqual(flagged(d), [PATH + '|kubernetes']);
  });

  it('word boundary: a flagged "ai" marks the standalone word, not the inside of "maintaining"', () => {
    // A bullet where "ai" first occurs inside another word.
    const text = AI_TEXT;
    // The finding names "ai".
    const d = diff(text, [termsFinding(text, ['ai'])]);
    // The runs of the line, as text and verdict.
    const runs = d.lines.find((l) => l.id === PATH)?.tailoredRuns.map((run) => `${run.verdict}:${run.text}`);
    // The standalone word is marked; with a bare indexOf the mark lands inside "maintaining".
    assert.deepEqual(runs, ['traced:Kept maintaining ', 'fabricated:AI', 'traced: agents for lead enrichment.']);
  });
});

describe('claim notice: copy', () => {
  it('notice copy: heading and lead are fixed sentences that never splice a claim in', () => {
    // One claim.
    const one = model.claimNoticeCopy(1);
    // Plain heading.
    assert.equal(one.heading, 'Check 1 phrase before approving');
    // The whole lead, so "...social media. work." can never come back through it.
    assert.equal(one.lead, 'This wording is not in your master profile. It may be a fair rewording, or something you never did. Only you can tell.');
    // Plural forms agree.
    assert.equal(model.claimNoticeCopy(3).heading, 'Check 3 phrases before approving');
    // Plural lead.
    assert.equal(model.claimNoticeCopy(3).lead, 'These words are not in your master profile. Each may be a fair rewording, or something you never did. Only you can tell.');
  });

  it('notice render: a whole-bullet claim ending in a full stop never lands inside the heading or lead', () => {
    // Malformed `words` makes the adapter fall back to the WHOLE bullet as the claim: the live shape that printed "...social media. work.".
    const d = diff(TAILORED, [termsFinding(TAILORED, null)]);
    // The card the page mounts, with no-op handlers: a static render never calls them.
    const html = render(h(view.DiffView, { diff: d, onApprove: () => undefined, onReject: () => undefined, onEdit: async () => ({ ok: true }) } as never));
    // The heading, whole: a count and a verb, no claim text (an exact element match leaves no room for one).
    assert.match(html, /<h3 id="claim-notice-heading" class="claim-notice__heading">Check 1 phrase before approving<\/h3>/);
    // The lead, whole and exact, so a spliced claim anywhere in it fails this line.
    assert.ok(html.includes('<p class="claim-notice__consequence">This wording is not in your master profile. It may be a fair rewording, or something you never did. Only you can tell.</p>'), 'lead sentence missing or altered');
    // The old splice's tell, absent: the bullet's own full stop followed by " work".
    assert.ok(!html.includes('media. work'), 'claim spliced into a sentence');
    // Positive pair: the claim IS on the card, verbatim, in its own list item (so the absence above is not vacuous).
    assert.ok(html.includes(`<span class="claim-notice__claim-text">${TAILORED}</span>`), 'claim not listed verbatim');
  });

  it('line note: quotes each flagged text, so a bullet ending in a full stop reads as a quotation', () => {
    // The live bullet: the note closes its quote right after the full stop.
    assert.equal(model.lineCheckNote([TAILORED]), `Not in your master profile: “${TAILORED}”`);
    // Several words, comma-separated, each quoted.
    assert.equal(model.lineCheckNote(['automating', 'gate']), 'Not in your master profile: “automating”, “gate”');
  });
});
