// Tests for how a scheduled ATS scout run ENDS (worker/src/scout/run-outcome.ts).
//
// W40 (2026-11-02): scout.yml's 15-minute job timeout killed both scheduled runs after
// ~917 s and 246 of 262 boards. A killed run never closes its agent_runs row, so it read
// `running` for ~6 h and the workflow read `cancelled`. The fix stops STARTING boards once
// a budget is spent and closes the run itself; these tests pin that with a fake clock.
// W12 (worker half): a screener that could not load used to warn and close `succeeded`
// with exit 0. These tests pin the loud close: counted, named, and a red Actions step.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// The shared countdown the matcher and tailor use; the clock is injected here.
import { createDeadline } from '../../supabase/functions/_shared/agent/deadline.ts';
// The units under test.
import { boardsWithinBudget, scoutRunClose } from '../src/scout/run-outcome.ts';

// A run that reached every board, so a test changes only the one input it is about.
const FULL_RUN = { processed: 4, skippedForDeadline: 0, stoppedEarly: false };
// The close inputs of a clean run; each test overrides what it exercises.
const CLEAN = {
  dbErrors: [] as string[],
  screenerNotRun: null as string | null,
  budget: FULL_RUN,
  screenWarnings: [] as string[],
  rowsIn: 10,
  rowsOut: 7,
  finishedAt: new Date('2026-11-02T06:30:00Z'),
};

describe('scout run outcome', () => {
  it('stops starting boards after the budget and closes the run succeeded with a budget note', () => {
    // A fake clock in ms, advanced by hand as each "board" takes time.
    let nowMs = 0;
    // A 10 ms budget, counted from here exactly as scout.ts counts from main().
    const deadline = createDeadline({ budgetMs: 10, clock: () => nowMs });
    // Four boards; each takes 4 ms, so the third ends at 12 ms, past the budget.
    const gate = boardsWithinBudget(['a', 'b', 'c', 'd'], deadline);
    // The boards the loop body actually started, in order.
    const started: string[] = [];
    // The same `for...of` shape scout.ts uses, so the stop happens BETWEEN boards.
    for (const board of gate.boards) {
      // The loop body ran for this board.
      started.push(board);
      // The board's poll time.
      nowMs += 4;
    }
    // 'c' started at 8 ms (budget left) and was finished; 'd' would start at 12 ms: never.
    expect(started).toEqual(['a', 'b', 'c']);
    // The tally names the stop, so the close can report it.
    expect(gate.outcome()).toEqual({ processed: 3, skippedForDeadline: 1, stoppedEarly: true });
    // The close for that tally, with no errors.
    const close = scoutRunClose({ ...CLEAN, budget: gate.outcome() });
    // A budget stop is not a failure: the skipped board goes first next run.
    expect(close.update.status).toBe('succeeded');
    // Zero errors, so the health page's error count stays honest.
    expect(close.update.error_count).toBe(0);
    // The one trace of the stop, in the shared `deadline:` wording the matcher uses.
    expect(close.update.error_detail).toBe('deadline: attempted 3 of 4; 1 left for next run');
    // A green Actions step.
    expect(close.exitCode).toBe(0);
  });

  it('TWIN: a run with budget left starts every board and closes with no note', () => {
    // A frozen clock: no time passes, so the budget never runs out.
    const deadline = createDeadline({ budgetMs: 10, clock: () => 0 });
    // The same four boards.
    const gate = boardsWithinBudget(['a', 'b', 'c', 'd'], deadline);
    // Spread drives the generator to the end, as the loop does.
    expect([...gate.boards]).toEqual(['a', 'b', 'c', 'd']);
    // Not stopped early, so the gate above was not vacuously cutting nothing.
    expect(gate.outcome()).toEqual({ processed: 4, skippedForDeadline: 0, stoppedEarly: false });
    // The clean close: succeeded, null detail, exit 0.
    const close = scoutRunClose({ ...CLEAN, budget: gate.outcome() });
    expect(close.update).toMatchObject({ status: 'succeeded', error_count: 0, error_detail: null, rows_in: 10, rows_out: 7 });
    expect(close.exitCode).toBe(0);
  });

  it('screener-unavailable run is recorded with error_count>0 and exits non-zero', () => {
    // The fallback ran: rows went in at 'discovered' (rowsOut 7 kept), unscreened.
    const close = scoutRunClose({ ...CLEAN, screenerNotRun: 'filter_rules query failed: timeout' });
    // Counted, so the run row is no longer a green "success" over an unscreened queue.
    expect(close.update.error_count).toBe(1);
    // Named with the reason, in the label the audit (W12) asked for.
    expect(close.update.error_detail).toBe('screener_not_run: filter_rules query failed: timeout');
    // `failed`, the file's honest-close rule: any error means the run is not a success.
    expect(close.update.status).toBe('failed');
    // Discovery is not lost: the inserted rows are still reported on the row.
    expect(close.update.rows_out).toBe(7);
    // The Actions step goes red, which is what someone not already suspicious sees.
    expect(close.exitCode).toBe(1);
  });

  it('every segment survives together: screener, budget, then database errors', () => {
    // A bad run on every axis at once.
    const close = scoutRunClose({
      ...CLEAN,
      screenerNotRun: 'search_preferences query failed: 500',
      budget: { processed: 2, skippedForDeadline: 3, stoppedEarly: true },
      dbErrors: ['Acme: upsert applications: x', 'Beta: record poll result: y'],
    });
    // One error per db write plus one for the screener.
    expect(close.update.error_count).toBe(3);
    // Short facts first, so the length cap can only ever eat the tail of the db list.
    expect(close.update.error_detail).toBe(
      'screener_not_run: search_preferences query failed: 500; deadline: attempted 2 of 5; 3 left for next run; Acme: upsert applications: x\nBeta: record poll result: y',
    );
    // Red either way.
    expect(close.update.status).toBe('failed');
    expect(close.exitCode).toBe(1);
  });

  it('scout.ts (the file on cron) wires the budget gate, the honest close and its exit code', () => {
    // Read as text: scout.ts runs main() on import, so a source check is the only test
    // that the CRON file uses the helpers above rather than its own inline copy.
    const source = readFileSync(new URL('../src/cli/scout.ts', import.meta.url), 'utf8');
    // The board loop iterates the budgeted boards, not the raw list.
    expect(source).toMatch(/for \(const board of budget\.boards\)/);
    // The budget comes from the one constant, counted from main()'s start.
    expect(source).toMatch(/createDeadline\(\{ budgetMs: SCOUT_BUDGET_MS \}\)/);
    // The screener fallback reaches the close as its reason.
    expect(source).toMatch(/screenerNotRun: screenContext\.ok \? null : screenContext\.reason/);
    // The close's verdict sets the process exit code.
    expect(source).toMatch(/process\.exitCode = close\.exitCode/);
  });
});
