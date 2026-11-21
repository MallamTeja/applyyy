// Wiring checks for the 2026-11-18 Workday recovery in worker/src/cli/scout.ts (D1, D3, D10).
//
// scout.ts runs main() on import, so no test can call it. The behaviour lives in tested modules
// (board-pages.ts: RobotsUnavailableError; persist-jobs.ts: dueForPoll, backfill); these checks
// pin that the CRON file actually uses them, in the order that makes them work.
import { readFileSync } from 'node:fs';
// vitest, like every worker suite.
import { describe, expect, it } from 'vitest';

// The cron file's source, read once.
const source = readFileSync(new URL('../src/cli/scout.ts', import.meta.url), 'utf8');

describe('scout.ts wiring: Workday recovery (2026-11-18)', () => {
  it('a robots-unavailable board is skipped BEFORE the catch writes failureMark', () => {
    // The board loop's catch: the LAST `catch (err: unknown)` before the skip (scout.ts has
    // earlier catches of the same text, so the first occurrence is the wrong block).
    const catchStart = source.lastIndexOf('} catch (err: unknown) {', source.indexOf('if (err instanceof RobotsUnavailableError) {'));
    // Found, or this check is vacuous.
    expect(catchStart).toBeGreaterThan(-1);
    // The type check the skip hangs on.
    const skipAt = source.indexOf('if (err instanceof RobotsUnavailableError) {', catchStart);
    // The catch's own failure mark.
    const markAt = source.indexOf('failureMark(board, now)', catchStart);
    // Both present.
    expect(skipAt).toBeGreaterThan(catchStart);
    expect(markAt).toBeGreaterThan(catchStart);
    // The skip comes first...
    expect(skipAt).toBeLessThan(markAt);
    // ...and leaves the iteration before reaching the mark: its own `continue;` comes first...
    const continueAt = source.indexOf('continue;', skipAt);
    expect(continueAt).toBeGreaterThan(skipAt);
    expect(continueAt).toBeLessThan(markAt);
    // ...with no watchlist write between the type check and that continue.
    expect(source.slice(skipAt, continueAt)).not.toMatch(/company_watchlist/);
  });

  it('the board loop polls only boards dueForPoll keeps (failing boards rest 24 h)', () => {
    // The filter feeds the budget gate...
    expect(source).toMatch(/\.filter\(\(board\) => dueForPoll\(board, now\)\)/);
    // ...and the budget gate is fed the filtered list, not the raw one.
    expect(source).toMatch(/boardsWithinBudget\(dueBoards, deadline\)/);
  });

  it('the stored-row backfill runs before the board loop, which always ends on the budget', () => {
    // Where the backfill is called.
    const backfillAt = source.indexOf('await backfillWorkdayDescriptions(client, workdayRun)');
    // Where the board loop starts.
    const loopAt = source.indexOf('for (const board of budget.boards)');
    // Both present.
    expect(backfillAt).toBeGreaterThan(-1);
    expect(loopAt).toBeGreaterThan(-1);
    // Backfill first.
    expect(backfillAt).toBeLessThan(loopAt);
  });
});
