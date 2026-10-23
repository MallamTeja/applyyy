/* parseRuleWarnings: reading the `rule_warnings:` segment back out of agent_runs.error_detail.
 *
 * WHY THESE TESTS EXIST. The Health page shows which screening rules were skipped in an agent's
 * latest run, and the only carrier is one free-text column. A lenient reader there is the
 * fail-open this repo keeps finding (CLAUDE.md §5): a substring match would render a failure
 * summary, or a `liveness_refused:` segment, as if it were a list of skipped rules. So every
 * case below pins a SHAPE, and the parity block at the bottom round-trips the real writer so
 * writer and reader cannot drift apart without one of these going red. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The reader under test.
import { parseRuleWarnings, pickRuleWarningRun } from '../src/data/ruleWarnings.ts';
// The real writer, runtime-neutral, imported the way other web tests reach supabase/functions/_shared.
import { withRuleWarnings } from '../../../supabase/functions/_shared/screen/run-summary.ts';

// The two warnings the operator most needs to see (the null-skip returns in cascade.ts's
// experienceCeiling and degreeMismatch — named, not line-cited; the numbers drifted once), used as fixtures.
const EXP = 'experience_ceiling skipped: min_experience_years is missing/null in JD';
// Second real warning, so ordering and the " | " join are both exercised.
const DEG = 'degree_mismatch skipped: requires_advanced_degree is missing/null in JD';

describe('parseRuleWarnings: not-a-segment inputs read as null', () => {
  it('non-strings and the empty string are null, never an empty list', () => {
    // Each is a value the column or a fixture could hold; none of them is a claim about rules.
    for (const value of [null, undefined, 0, 42, {}, [], true, '']) {
      // Null, not { kind: 'warnings', warnings: [] }: "nothing to show" must not render an empty box.
      assert.equal(parseRuleWarnings(value), null, `expected null for ${JSON.stringify(value)}`);
    }
  });

  it('a failure-only summary is null', () => {
    // The screener's own failure text, which mentions rules but is not the segment.
    assert.equal(parseRuleWarnings('1 of 3 rows errored; insert failed: duplicate key'), null);
  });

  it('the marker inside a word or without the "; " boundary is not a segment', () => {
    // Glued to preceding text: only start-of-string or "; " opens a segment.
    assert.equal(parseRuleWarnings('xrule_warnings: a | b'), null);
    // A newline is a failure-summary separator, not a segment separator.
    assert.equal(parseRuleWarnings('db error\nrule_warnings: a'), null);
    // A comma boundary is not the writer's either.
    assert.equal(parseRuleWarnings('oops, rule_warnings: a'), null);
  });

  it('a label with no items is unreadable, not null', () => {
    // A label at a valid boundary means something WAS recorded; rendering nothing would hide it.
    assert.deepEqual(parseRuleWarnings('rule_warnings:  |  | '), { kind: 'unreadable' });
  });
});

describe('parseRuleWarnings: the segment is read as a list', () => {
  it('reads the segment alone', () => {
    // A run with no failures writes the segment as the whole column.
    assert.deepEqual(parseRuleWarnings(`rule_warnings: ${DEG} | ${EXP}`), { kind: 'warnings', warnings: [DEG, EXP], truncated: false });
  });

  it('reads the segment after a failure summary', () => {
    // The screener's "N of M rows errored" summary precedes it.
    assert.deepEqual(parseRuleWarnings('1 of 3 rows errored; rule_warnings: a | b'), { kind: 'warnings', warnings: ['a', 'b'], truncated: false });
  });

  it('a failure summary that itself contains "; " and "\\n" does not leak into the list', () => {
    // Worker joins db errors with "\n", screener joins parts with "; " - both precede the segment.
    const detail = 'insert failed: x\ninsert failed: y; 2 of 9 rows errored; rule_warnings: a | b';
    // Only what follows the LAST boundary-anchored label is read.
    assert.deepEqual(parseRuleWarnings(detail), { kind: 'warnings', warnings: ['a', 'b'], truncated: false });
  });

  it('trims items and drops empties', () => {
    // Defensive against a hand-written or legacy row; the writer never emits these.
    assert.deepEqual(parseRuleWarnings('rule_warnings:  a  |  | b '), { kind: 'warnings', warnings: ['a', 'b'], truncated: false });
  });

  it('uses the last segment when the label appears twice', () => {
    // The writer appends its segment LAST, so the last boundary-anchored label is the real one.
    assert.deepEqual(parseRuleWarnings('rule_warnings: old; rule_warnings: new'), { kind: 'warnings', warnings: ['new'], truncated: false });
  });
});

describe('parseRuleWarnings: liveness_refused and trailing segments', () => {
  it('a liveness_refused segment alone is not rule warnings', () => {
    // scout-ats's non-error segment, which shares the "label: items" shape.
    assert.equal(parseRuleWarnings('greenhouse/acme: 404; liveness_refused: a, b'), null);
  });

  it('liveness_refused BEFORE rule_warnings is the writer\'s order and parses', () => {
    // scout-ats joins board failures, then liveness_refused, then withRuleWarnings appends ours.
    const detail = 'greenhouse/acme: 404; liveness_refused: x, y; rule_warnings: a | b';
    // The liveness list stays out of the rule list.
    assert.deepEqual(parseRuleWarnings(detail), { kind: 'warnings', warnings: ['a', 'b'], truncated: false });
  });

  it('a labelled segment AFTER rule_warnings is unreadable, never a list and never nothing', () => {
    // The writer always appends last, so this layout cannot be listed as rules - but a label was
    // recorded, so "nothing" would claim a clean run we cannot vouch for.
    assert.deepEqual(parseRuleWarnings('rule_warnings: a | b; liveness_refused: x'), { kind: 'unreadable' });
  });

  it('D2: a quoted posted_at containing "; tz: " makes the whole body unreadable, not null', () => {
    // cascade.ts:297 quotes job.postedAt verbatim from the ATS, so this text is reachable.
    const warnings = [EXP, 'job has an unparseable posted_at "2026-10-01; tz: UTC"'];
    // Through the real writer, so the layout is exactly what lands in the column.
    assert.deepEqual(parseRuleWarnings(withRuleWarnings(null, warnings)), { kind: 'unreadable' });
  });
});

/* The writer as it shipped from 9a85f0b until a3c130a: summary first, then the segment, then a bare
   .slice(0, 1000) that could cut the label off entirely. a3c130a gave the segment a reserved budget,
   so the live writer no longer produces these shapes - but rows it wrote before that deploy stay in
   agent_runs, and Health keeps showing an agent's newest screening run (pickRuleWarningRun, over the
   last RUN_WINDOW rows, with no date bound) until that agent screens again. Those rows must still
   parse, so their inputs are rebuilt here as literal strings in the old layout rather than through
   the real writer, which can no longer reach them. */
const preA3c130a = (summary: string, warnings: string[]): string =>
  // The exact old expression: no reserve, no ellipsis, a silent cut at the cap.
  `${summary}; rule_warnings: ${[...new Set(warnings)].sort().join(' | ')}`.slice(0, 1000);

describe('parseRuleWarnings: D1, the cap can delete the segment', () => {
  it('pre-a3c130a row: 20 long db errors push the label past the cap: maybe_cut, not null', () => {
    // worker/src/cli/scout.ts:449 joins up to 20 db errors with "\n" in front of the segment.
    const dbErrors = Array.from({ length: 20 }, (_, i) => `insert failed for job ${i}: ${'x'.repeat(80)}`).join('\n');
    // The OLD writer's layout: summary first, then the segment, then sliced to 1000.
    const detail = preA3c130a(dbErrors, [EXP]);
    // Precondition: the cap really did cut the label off, or this test proves nothing.
    assert.ok(detail.length === 1000 && !detail.includes('rule_warnings: '));
    // We cannot know whether warnings existed, and must say so.
    assert.deepEqual(parseRuleWarnings(detail), { kind: 'maybe_cut' });
  });

  it('pre-a3c130a row: a label cut mid-word at the cap ("...; rule_war") is maybe_cut', () => {
    // A summary sized so the old slice lands inside the label.
    const summary = 'e'.repeat(1000 - '; rule_war'.length);
    // Old-layout output, cut exactly there.
    const detail = preA3c130a(summary, [EXP]);
    // Precondition on where the cut fell.
    assert.ok(detail.endsWith('; rule_war'));
    // Unknowable, said out loud.
    assert.deepEqual(parseRuleWarnings(detail), { kind: 'maybe_cut' });
  });

  it('pre-a3c130a row: a label cut just after its colon is maybe_cut, since the items were the part cut', () => {
    // The old slice lands right after "rule_warnings: ", leaving a label with no items.
    const summary = 'e'.repeat(1000 - '; rule_warnings: '.length);
    // Old-layout output.
    const detail = preA3c130a(summary, [EXP]);
    // Precondition: the label survived whole and nothing follows it, or this is a different case.
    assert.ok(detail.length === 1000 && detail.endsWith('; rule_warnings: '));
    // At the cap with an empty body: the cap, not the writer, emptied it.
    assert.deepEqual(parseRuleWarnings(detail), { kind: 'maybe_cut' });
  });

  it('a3c130a writer: the same 20 db errors no longer delete the segment - a complete list', () => {
    // The input that used to cut the label off, now through the REAL (current) writer.
    const dbErrors = Array.from({ length: 20 }, (_, i) => `insert failed for job ${i}: ${'x'.repeat(80)}`).join('\n');
    // The reserve keeps room for the segment after the capped summary.
    const detail = withRuleWarnings(dbErrors, [EXP]);
    // Precondition: the summary really was long enough to have overflowed the old writer.
    assert.ok(dbErrors.length > 1000);
    // Read back whole: the warning survives, and the list is known complete (under the cap).
    assert.deepEqual(parseRuleWarnings(detail), { kind: 'warnings', warnings: [EXP], truncated: false });
  });

  it('a short failure-only detail is still null: under the cap, no label means no warnings', () => {
    // The writer appends its segment whenever warnings exist, and nothing was cut here.
    assert.equal(parseRuleWarnings('1 of 3 rows errored'), null);
  });
});

describe('parseRuleWarnings: the 1000-character cap', () => {
  it('a string at the writer\'s cap is flagged truncated', () => {
    // Build a real over-long run through the writer so the cap is the writer's, not a guess.
    const many = Array.from({ length: 40 }, (_, i) => `rule_${String(i).padStart(2, '0')} skipped: field is missing/null in JD`);
    // The writer caps at 1000, possibly mid-item.
    const detail = withRuleWarnings('1 of 3 rows errored', many);
    // Precondition: the fixture really hit the cap, or this test proves nothing.
    assert.equal(detail?.length, 1000);
    // Parsed, with the flag that tells the page the last item may be cut.
    const parsed = parseRuleWarnings(detail);
    // A list arm: a truncated list is still a list.
    assert.ok(parsed?.kind === 'warnings');
    // The flag itself.
    assert.equal(parsed.truncated, true);
    // Every item but the last is whole.
    assert.deepEqual(parsed.warnings.slice(0, -1), many.slice(0, parsed.warnings.length - 1));
  });

  it('a string under the cap is not flagged', () => {
    // 999 characters: one short of the cap, so the list is known complete.
    const detail = `rule_warnings: ${'a'.repeat(999 - 'rule_warnings: '.length)}`;
    // Precondition on the fixture's length.
    assert.equal(detail.length, 999);
    // A complete list, not truncated.
    assert.deepEqual(parseRuleWarnings(detail), { kind: 'warnings', warnings: [detail.slice('rule_warnings: '.length)], truncated: false });
  });
});

describe('parity with the writer (withRuleWarnings)', () => {
  // Failure summaries the three real writers produce in front of the segment, including none.
  const prefixes: (string | null)[] = [
    // Clean run apart from the warnings.
    null,
    // Screener's counted-failure summary.
    '1 of 3 rows errored',
    // Screener joins parts with "; ".
    '2 of 9 rows errored; insert failed: duplicate key',
    // Worker joins db errors with "\n".
    'insert failed: a\ninsert failed: b',
    // scout-ats with its own labelled, non-error segment first.
    'lever/acme: 404; liveness_refused: x, y',
  ];
  // Unsorted and duplicated, so dedupe and sort are both part of the round trip.
  const warnings = [EXP, DEG, EXP, 'title_blocklist has no blocked_titles configured'];

  for (const prefix of prefixes) {
    it(`round-trips with prefix ${JSON.stringify(prefix)}`, () => {
      // Writer then reader must give back the distinct warnings, sorted - exactly what was meant.
      assert.deepEqual(parseRuleWarnings(withRuleWarnings(prefix, warnings)), {
        // Sorted distinct, the writer's own normalisation.
        // The success arm of the closed union.
        kind: 'warnings',
        warnings: [...new Set(warnings)].sort(),
        // Well under the cap.
        truncated: false,
      });
    });
  }

  it('no warnings: the writer leaves the detail alone and the reader finds nothing', () => {
    // A clean run keeps a null column; a failure-only run keeps its failure text.
    assert.equal(parseRuleWarnings(withRuleWarnings(null, [])), null);
    // Failure text alone is not a segment.
    assert.equal(parseRuleWarnings(withRuleWarnings('1 of 3 rows errored', [])), null);
  });
});

describe('pickRuleWarningRun: D3, which run the warnings come from', () => {
  // A run row with just the fields the selector reads; overrides vary per case.
  const r = (over: Record<string, unknown>) => ({
    // One agent throughout, except where a case says otherwise.
    agent: 'screener',
    // Opened a minute before it closed; the selector orders on finished_at.
    started_at: '2026-10-08T00:00:00Z',
    // Closed by default.
    finished_at: '2026-10-08T00:01:00Z',
    // Screened rows by default.
    rows_in: 5,
    // Clean by default.
    error_detail: null,
    // The case's own fields.
    ...over,
  });
  // The older run whose warnings the operator must keep seeing.
  const warned = r({ finished_at: '2026-10-08T01:00:00Z', error_detail: `rule_warnings: ${EXP}` });

  it('a newer clean IDLE run (rows_in 0) does not hide the older warnings', () => {
    // An empty queue is normal for the screener and screens nothing, so it says nothing about rules.
    const idle = r({ finished_at: '2026-10-08T02:00:00Z', rows_in: 0 });
    // The warned run is still the one shown.
    assert.equal(pickRuleWarningRun([idle, warned], 'screener'), warned);
  });

  it('a newer OPEN run does not hide the older warnings', () => {
    // Newest by started_at, but error_detail stays null until it closes.
    const open = r({ started_at: '2026-10-08T03:00:00Z', finished_at: null });
    // The warned run is still the one shown.
    assert.equal(pickRuleWarningRun([open, warned], 'screener'), warned);
  });

  it('a newer CLOSED run that screened rows cleanly replaces them', () => {
    // This one did screen, and its clean detail is a real answer: the warnings are resolved.
    const clean = r({ finished_at: '2026-10-08T02:00:00Z' });
    // The clean run is picked, so the block will render nothing.
    assert.equal(pickRuleWarningRun([warned, clean], 'screener'), clean);
  });

  it('other agents and malformed rows are never picked', () => {
    // A different agent's run with warnings.
    const other = r({ agent: 'scout', finished_at: '2026-10-08T05:00:00Z', error_detail: 'rule_warnings: z' });
    // rows_in that is not a positive integer is not evidence of screening.
    const junk = r({ finished_at: '2026-10-08T06:00:00Z', rows_in: '5' });
    // An unparseable finished_at cannot be ordered, so it cannot win.
    const badTime = r({ finished_at: 'not a date' });
    // Only the well-formed screener run remains.
    assert.equal(pickRuleWarningRun([other, junk, badTime, warned], 'screener'), warned);
    // No candidates at all is null, rendered as nothing.
    assert.equal(pickRuleWarningRun([other], 'screener'), null);
  });
});
