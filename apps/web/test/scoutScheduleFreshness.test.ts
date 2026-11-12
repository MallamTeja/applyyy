/* The scout schedule and everything that assumes it, checked against each other (T5, 2026-11-05).
 *
 * WHY: scout.yml's cron, the Health page's scout_ats threshold and label, and the scan popup's
 * "N times a day" live in three files. scout.yml's own comment said "change together", and nothing
 * enforced it. This test reads the real cron lines, so adding or removing a run without updating the
 * other two goes red here, and so does a gap that would outgrow the stale threshold. */

// Strict asserts.
import assert from 'node:assert/strict';
// Plain test(), the shape agentFreshness.test.ts uses.
import { test } from 'node:test';
// The workflow and the modal are read as text: no YAML parser is installed, and none is needed.
import { readFileSync } from 'node:fs';
// Paths resolved from this file, so the cwd does not matter.
import { fileURLToPath } from 'node:url';

// The threshold and label under test.
import { AGENT_CADENCE } from '../src/data/agentFreshness.ts';

// The repo file at a path relative to this test.
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

// GitHub started scout runs up to 6 h late (measured 2026-10-29..11-01, agentFreshness.ts comment).
const MAX_START_DELAY_HOURS = 6;

// Every run time of day, in hours since 00:00 UTC, from the workflow's `- cron:` lines.
function scoutRunHours(): number[] {
  // The live workflow file.
  const yml = read('../../../.github/workflows/scout.yml');
  // Only "minute hour * * *" crons: a weekday or month field would make "per day" meaningless.
  const crons = [...yml.matchAll(/^\s*- cron: '(\d+) ([\d,]+) \* \* \*'\s*$/gm)];
  // A file with no matching line must fail, never pass vacuously (CLAUDE.md section 6).
  assert.ok(crons.length > 0, 'no daily cron line found in scout.yml');
  // Every (minute, hour) pair, as fractional hours.
  const hours = crons.flatMap((m) => m[2]!.split(',').map((h) => Number(h) + Number(m[1]) / 60));
  // Sorted, so neighbours are consecutive runs.
  return hours.sort((a, b) => a - b);
}

// The words the Health page and the popup use for a run count.
// 10 added 2026-11-12, when scout.yml went to ten runs a day.
const PER_DAY: Readonly<Record<number, string>> = { 1: 'once a day', 2: 'twice a day', 3: 'three times a day', 10: 'ten times a day' };

test('the scout_ats threshold covers the longest gap between scheduled runs plus the start delay', () => {
  // The run times.
  const hours = scoutRunHours();
  // Each gap to the next run, wrapping the last one round midnight.
  const gaps = hours.map((h, i) => (i + 1 < hours.length ? hours[i + 1]! - h : hours[0]! + 24 - h));
  // The worst healthy silence: the longest gap, with the next run starting as late as measured.
  const worst = Math.max(...gaps) + MAX_START_DELAY_HOURS;
  // The configured threshold.
  const cadence = AGENT_CADENCE['scout_ats'];
  // Present, or the Health page has no row to judge.
  assert.ok(cadence !== undefined);
  // Never stale on a healthy schedule.
  assert.ok(worst <= cadence.staleAfterHours, `worst gap ${worst} h exceeds staleAfterHours ${cadence.staleAfterHours}`);
});

test('the Health label and the scan popup name the run count scout.yml schedules', () => {
  // How many runs a day.
  const runs = scoutRunHours().length;
  // Its words, which must exist (a count outside the table is a new schedule to describe).
  const words = PER_DAY[runs];
  // Named.
  assert.ok(words !== undefined, `no wording for ${runs} runs a day`);
  // The Health page's expected cadence.
  assert.equal(AGENT_CADENCE['scout_ats']?.expected, words);
  // The popup's sentence, as the string literal it renders.
  assert.match(read('../src/features/pipeline/DiscoveryModal.tsx'), new RegExp(`scanned automatically ${words};`));
});
