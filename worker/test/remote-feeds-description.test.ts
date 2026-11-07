// Tests that remote-feed descriptions are stored as clean text, not HTML (N1, 2026-11-07).
//
// WHY: Teja saw literal `<h2>About CircuitHub</h2><p style=...>` and Arbeitnow's
// "Find <a href=...>Jobs in Germany</a> on Arbeitnow" footer on a ready-to-tailor card
// (job 6a6ed836, Arbeitnow). Measured the same day: 129 of 218 Arbeitnow rows and 52 of 150
// RemoteOK rows store HTML; 14 Jobicy rows carry raw entities. That markup fed the matcher
// and tailor prompts and the keyword match as if it were prose.
import { describe, expect, it } from 'vitest';
// The three feed parsers, so the wiring is pinned per feed, not only a helper.
import { parseArbeitnow, parseJobicy, parseRemoteOK } from '../src/scout/remote-feeds.ts';

// Teja's sample, shortened but shape-exact: h2, a styled p, an hr, strong, ul/li, entities,
// and the footer with its stray closing </a> exactly as the live row ends.
const CIRCUITHUB_HTML =
  '<h2>About CircuitHub</h2><p style="min-height:1.5em">CircuitHub is reshaping electronics manufacturing with <strong>The Grid</strong> &amp; robotics.</p>' +
  '<hr><p>Compensation: £80K – £125K • Offers Equity</p>' +
  '<ul><li>UK • £80K – £125K</li><li>US • $125K – $250K</li></ul>' +
  '<p>Find <a href="https://www.arbeitnow.com">Jobs in Germany</a> on Arbeitnow</a>';

// What the card should show: one line per block, entities decoded, no tags, no footer.
const CIRCUITHUB_TEXT = [
  'About CircuitHub',
  'CircuitHub is reshaping electronics manufacturing with The Grid & robotics.',
  'Compensation: £80K – £125K • Offers Equity',
  'UK • £80K – £125K',
  'US • $125K – $250K',
].join('\n');

// One remote Arbeitnow posting carrying a given description.
function arbeitnow(description: string) {
  // Only `remote: true` rows are kept by the parser.
  return { data: [{ title: 'Software Engineer, Operations Research', company_name: 'CircuitHub', location: 'London', remote: true, url: 'https://www.arbeitnow.com/jobs/companies/circuithub/x', description, created_at: 1762473600 }] };
}

describe('remote-feed descriptions are stored as clean text', () => {
  it('Arbeitnow: Teja\'s CircuitHub HTML becomes line-broken text with the footer gone', () => {
    // The parse result for the live shape.
    const { jobs } = parseArbeitnow(arbeitnow(CIRCUITHUB_HTML));
    // Exactly the clean text, so a leftover tag, entity or footer line all fail it.
    expect(jobs[0]?.description).toBe(CIRCUITHUB_TEXT);
  });

  it('Arbeitnow: a footer glued to a dash rule on the last line goes, dashes and all (job 3f73f9cc)', () => {
    // The one row the 10:39 backfill left: no newline before "Find", a "-----" rule in front of it.
    const { jobs } = parseArbeitnow(arbeitnow('<p>If you require assistance, please submit a request to: -----Find more English Speaking Jobs in France on Arbeitnow</p>'));
    // The sentence stays; the rule and the footer go.
    expect(jobs[0]?.description).toBe('If you require assistance, please submit a request to:');
  });

  it('ReDoS: a 50k-dash run with no footer parses in well under a second', () => {
    // Peer 2's security review (2026-11-07): an unanchored /\s*-*\s*Find .../ retried at every offset
    // of a long whitespace/dash run, which is polynomial. Description text is attacker-controlled.
    // One unbroken dash run: `-*` eats it from every offset, then backtracks (stripHtml already
    // collapses space runs, so dashes are the input that reaches the regex intact).
    const hostile = `${'-'.repeat(50_000)}x`;
    // Timed around the whole parse, the path a real feed item takes.
    const started = performance.now();
    const { jobs } = parseArbeitnow(arbeitnow(hostile));
    const elapsedMs = performance.now() - started;
    // Generous for CI, far below the quadratic blow-up (seconds at this size).
    expect(elapsedMs).toBeLessThan(250);
    // Non-vacuity: the posting was parsed and kept its text.
    expect(jobs[0]?.description.endsWith('x')).toBe(true);
  });

  it('RemoteOK: HTML paragraphs become text lines too', () => {
    // The legal-notice element first, as the live feed sends it.
    // (An escaped "&lt;tag&gt;" is dropped as a tag: stripHtml decodes before stripping, by design.)
    const { jobs } = parseRemoteOK([{ legal: 'API terms' }, { position: 'Engineer', company: 'Acme', apply_url: 'https://remoteok.com/remote-jobs/1', description: '<p>Build APIs &amp; tools.</p><p>Ship.</p>' }]);
    // One line per paragraph, the ampersand decoded.
    expect(jobs[0]?.description).toBe('Build APIs & tools.\nShip.');
  });

  it('Jobicy: a plain-text excerpt with an entity is decoded and otherwise untouched', () => {
    // Jobicy's envelope; no tags, one entity, as in the 14 live rows.
    const { jobs } = parseJobicy({ jobs: [{ jobTitle: 'Engineer', companyName: 'Acme', url: 'https://jobicy.com/jobs/1', jobExcerpt: 'R&amp;D role' }] });
    // The entity decoded; nothing else changed.
    expect(jobs[0]?.description).toBe('R&D role');
  });

  it('§6: markup with no text keeps the raw description, never an empty "no description"', () => {
    // Stripping this yields nothing; the raw text must survive so the row is not silently blank.
    const { jobs } = parseArbeitnow(arbeitnow('<div><img src="x"></div>'));
    // Kept as received.
    expect(jobs[0]?.description).toBe('<div><img src="x"></div>');
  });

  it('a feed with no description at all still stores the empty string, as before', () => {
    // No description key: the old default stands.
    const { jobs } = parseJobicy({ jobs: [{ jobTitle: 'Engineer', companyName: 'Acme', url: 'https://jobicy.com/jobs/1' }] });
    // Unchanged contract.
    expect(jobs[0]?.description).toBe('');
  });
});
