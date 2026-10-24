// The apply-kit SWEEP: kits are made by the system, not dispatched by hand (Teja,
// 2026-10-24 16:20: "the kits need to generated automatically by system, dynamically").
// The sweep picks every row waiting on Teja whose newest kit is older than the row's last
// status change, builds kits for a capped few, and never lets one failure stop the rest.
import { describe, expect, test } from 'vitest';
import { createSweepReader, parseKitTarget, runKitSweep, selectKitCandidates, type KitStamp, type SweepRow } from '../src/apply-kit-sweep.ts';
import type { SupabaseLike } from '../src/supabase-gateway.ts';

// One row as the sweep reads it; the status change is the moment the row needed a kit.
function row(id: string, status: SweepRow['status'], statusChangedAt: string): SweepRow {
  return { id, status, statusChangedAt };
}

// One kit note as the sweep reads it.
function kit(applicationId: string, createdAt: string): KitStamp {
  return { applicationId, createdAt };
}

describe('selectKitCandidates', () => {
  test('a row whose kit is newer than its last status change is skipped', () => {
    // Parked at 10:00, kitted at 10:05: the kit describes the current situation.
    const picked = selectKitCandidates([row('a', 'blocked_needs_human', '2026-10-24T10:00:00Z')], [kit('a', '2026-10-24T10:05:00Z')], 5);
    // Nothing to do, and the count says so.
    expect(picked).toEqual({ eligible: [], selected: [] });
  });

  test('a row whose status changed after its kit is re-kitted', () => {
    // Kitted at 09:00 while approved, then parked at 10:00: the old kit predates the new situation.
    const picked = selectKitCandidates([row('a', 'blocked_needs_human', '2026-10-24T10:00:00Z')], [kit('a', '2026-10-24T09:00:00Z')], 5);
    // Picked again.
    expect(picked.selected).toEqual(['a']);
  });

  test('a row with no kit at all is picked', () => {
    // The Sigma/Perpay/Aiven/Bjak case on the first live sweep.
    expect(selectKitCandidates([row('a', 'needs_verification', '2026-10-24T10:00:00Z')], [], 5).selected).toEqual(['a']);
  });

  test('rows outside the kit statuses are excluded even with no kit', () => {
    // A sent, dropped or not-yet-approved row never needs a kit.
    const rows = [row('applied', 'applied', '2026-10-24T10:00:00Z'), row('waiting', 'awaiting_approval', '2026-10-24T10:00:00Z'), row('dropped', 'dropped_filter', '2026-10-24T10:00:00Z')];
    // None qualifies.
    expect(selectKitCandidates(rows, [], 5)).toEqual({ eligible: [], selected: [] });
  });

  test('the newest kit decides, whatever order the kits arrive in', () => {
    // An old kit listed AFTER a fresh one must not make the row look stale.
    const kits = [kit('a', '2026-10-24T10:05:00Z'), kit('a', '2026-10-24T08:00:00Z')];
    // The fresh one wins: skipped.
    expect(selectKitCandidates([row('a', 'applying', '2026-10-24T10:00:00Z')], kits, 5).selected).toEqual([]);
  });

  test('the cap takes the longest-waiting rows first and counts the rest as eligible', () => {
    // Three rows, cap two: the two that have waited longest go now, the third next run.
    const rows = [row('newest', 'applying', '2026-10-24T12:00:00Z'), row('oldest', 'applying', '2026-10-24T08:00:00Z'), row('middle', 'applying', '2026-10-24T10:00:00Z')];
    // Oldest first, and the eligible count is honest about the one left over.
    expect(selectKitCandidates(rows, [], 2)).toEqual({ eligible: ['oldest', 'middle', 'newest'], selected: ['oldest', 'middle'] });
  });

  test('an unreadable status stamp is re-kitted, and an unreadable kit stamp never counts as fresh (§6)', () => {
    // "-5" parses as a year in V8; neither stamp may pass as a real time.
    const picked = selectKitCandidates(
      [row('junk-row', 'applying', '-5'), row('junk-kit', 'applying', '2026-10-24T10:00:00Z')],
      [kit('junk-row', '2026-10-24T11:00:00Z'), kit('junk-kit', '-5')],
      5,
    );
    // Both are kitted: a kit we cannot prove is fresh is treated as missing.
    expect([...picked.selected].sort()).toEqual(['junk-kit', 'junk-row']);
  });
});

describe('runKitSweep', () => {
  test('one failing row is recorded and the sweep continues with the next', async () => {
    // Built in order; the middle one throws.
    const built: string[] = [];
    // The log lines, so the summary is checked as the operator reads it.
    const lines: string[] = [];
    const summary = await runKitSweep({
      listRows: async () => [row('a', 'applying', '2026-10-24T08:00:00Z'), row('b', 'applying', '2026-10-24T09:00:00Z'), row('c', 'applying', '2026-10-24T10:00:00Z')],
      listKits: async () => [],
      buildOne: async (id) => {
        // The middle row's form is down.
        if (id === 'b') throw new Error('page load timed out');
        built.push(id);
      },
      cap: 5,
      log: (line) => lines.push(line),
    });
    // The rows on either side of the failure were still built.
    expect(built).toEqual(['a', 'c']);
    // The failure is named, not swallowed.
    expect(summary).toEqual({ eligible: 3, attempted: 3, built: 2, failed: [{ id: 'b', reason: 'page load timed out' }] });
    // And it reaches the log with its reason.
    expect(lines.some((line) => line.includes('b') && line.includes('page load timed out'))).toBe(true);
  });

  test('the cap bounds the builds in one run', async () => {
    // Three eligible, cap one.
    const built: string[] = [];
    const summary = await runKitSweep({
      listRows: async () => [row('a', 'applying', '2026-10-24T08:00:00Z'), row('b', 'applying', '2026-10-24T09:00:00Z'), row('c', 'applying', '2026-10-24T10:00:00Z')],
      listKits: async () => [],
      buildOne: async (id) => { built.push(id); },
      cap: 1,
      log: () => {},
    });
    // Only the longest-waiting row was built; the other two wait for the next run.
    expect(built).toEqual(['a']);
    expect(summary).toEqual({ eligible: 3, attempted: 1, built: 1, failed: [] });
  });

  test('zero eligible rows is said out loud, never a silent pass', async () => {
    // Everything already kitted.
    const lines: string[] = [];
    const summary = await runKitSweep({
      listRows: async () => [row('a', 'applying', '2026-10-24T08:00:00Z')],
      listKits: async () => [kit('a', '2026-10-24T09:00:00Z')],
      buildOne: async () => { throw new Error('must not be called'); },
      cap: 5,
      log: (line) => lines.push(line),
    });
    // The exact phrase the brief asked for, so a log search finds it.
    expect(lines.some((line) => line.includes('0 eligible'))).toBe(true);
    expect(summary).toEqual({ eligible: 0, attempted: 0, built: 0, failed: [] });
  });

  test('kits are read only for the rows that could need one', async () => {
    // The ids passed to the kit read.
    let askedFor: readonly string[] = [];
    await runKitSweep({
      listRows: async () => [row('a', 'applying', '2026-10-24T08:00:00Z'), row('sent', 'applied', '2026-10-24T08:00:00Z')],
      listKits: async (ids) => { askedFor = ids; return []; },
      buildOne: async () => {},
      cap: 5,
      log: () => {},
    });
    // The applied row is not a kit candidate, so its notes are never read.
    expect(askedFor).toEqual(['a']);
  });
});

describe('parseKitTarget', () => {
  test('a blank id from a scheduled or workflow_run trigger selects the sweep', () => {
    // GitHub expands a missing workflow input to '', and the env var is still set.
    expect(parseKitTarget('')).toBeUndefined();
    // A local run with no flag and no variable.
    expect(parseKitTarget(undefined)).toBeUndefined();
  });

  test('a malformed id is refused, never read as "no id" (which would run a sweep instead)', () => {
    // A typo must not widen one-row intent into every row.
    expect(() => parseKitTarget('not-a-uuid')).toThrow(/must be an application UUID/);
  });

  test('a real id selects that one row, lower-cased to match the stored uuid', () => {
    // Postgres prints uuids lower-case.
    expect(parseKitTarget(' BA1E5D1D-84A5-4CFB-B5A6-E5A2943BF154 ')).toBe('ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154');
  });
});

describe('createSweepReader', () => {
  // A supabase-js-shaped query: every builder call chains, and awaiting it RESOLVES to
  // {data, error}. supabase-js returns errors, it does not throw them (CLAUDE.md §5).
  function clientAnswering(result: { data: unknown; error: { message: string } | null }): SupabaseLike {
    // The chain object: select/eq/in return it, and it is thenable like a PostgREST builder.
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in']) chain[method] = () => chain;
    chain['then'] = (resolve: (value: unknown) => unknown) => resolve(result);
    return { from: () => chain } as unknown as SupabaseLike;
  }

  test('a refused applications read throws instead of reading as zero eligible', async () => {
    // RLS or a network drop: supabase-js hands back {error}, with data null.
    const reader = createSweepReader(clientAnswering({ data: null, error: { message: 'permission denied' } }));
    // Must be loud: "0 eligible" here would hide a broken sweep forever.
    await expect(reader.listRows()).rejects.toThrow(/read applications failed: permission denied/);
  });

  test('a refused kit-notes read throws instead of reading as "no kits"', async () => {
    // "No kits" would re-kit every row on every run; an error must stop the run instead.
    const reader = createSweepReader(clientAnswering({ data: null, error: { message: 'timeout' } }));
    // Named so the run log says which read failed.
    await expect(reader.listKits(['a'])).rejects.toThrow(/read kit notes failed: timeout/);
  });

  test('rows are narrowed to the sweep shape', async () => {
    // A real answer, in PostgREST's column names.
    const reader = createSweepReader(clientAnswering({ data: [{ id: 'a', status: 'applying', status_changed_at: '2026-10-24T10:00:00+00:00' }], error: null }));
    // Renamed to the sweep's fields.
    expect(await reader.listRows()).toEqual([{ id: 'a', status: 'applying', statusChangedAt: '2026-10-24T10:00:00+00:00' }]);
  });
});
