// The apply-kit SWEEP: kits are made by the system, not dispatched by hand (Teja,
// 2026-10-24 16:20: "the kits need to generated automatically by system, dynamically").
// The sweep picks every row waiting on Teja whose newest kit is older than the row's last
// status change, builds kits for a capped few, and never lets one failure stop the rest.
import { describe, expect, test } from 'vitest';
import { createSweepReader, parseKitTarget, runKitSweep, selectKitCandidates, shouldRedispatch, type KitStamp, type SweepRow } from '../src/apply-kit-sweep.ts';
// B2: the typed skip a kit throws for a robots refusal or a closed posting.
import { KitSkip } from '../src/apply-kit.ts';
// The workflow pins below read apply-kit.yml as text.
import { readFileSync } from 'node:fs';
import type { SupabaseLike } from '../src/supabase-gateway.ts';

// One row as the sweep reads it; the status change is the moment the row needed a kit.
// The park facts default to "never parked", so every older case keeps its meaning (W29).
function row(id: string, status: SweepRow['status'], statusChangedAt: string, park: Partial<Pick<SweepRow, 'blockReason' | 'blockUnusable' | 'blockCode'>> = {}): SweepRow {
  // Unparked unless a case says otherwise; a case overrides only the fact it is about.
  return { id, status, statusChangedAt, blockReason: null, blockUnusable: null, blockCode: null, ...park };
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

  test('W29: a row parked because its form cannot be opened (robots_refused, no_apply_url) is never selected', () => {
    // The same moment for all three, so only the park cause differs.
    const at = '2026-10-24T10:00:00Z';
    // robots.txt refused the form: the kit asks the same gate and would throw every run.
    const robots = row('robots', 'blocked_needs_human', at, { blockReason: 'robots_refused' });
    // The applier's W4 park for a job with no form URL: fetchApplication would throw every run.
    const noUrl = row('no-url', 'blocked_needs_human', at, { blockReason: 'other', blockUnusable: 'no_apply_url' });
    // A login wall: the form opens, so a kit is still worth building.
    const login = row('login', 'blocked_needs_human', at, { blockReason: 'login_required' });
    // Only the openable one is due; the other two are not even counted as eligible.
    expect(selectKitCandidates([robots, noUrl, login], [], 5)).toEqual({ eligible: ['login'], selected: ['login'] });
  });

  test('W29: a row that LEFT the human lane keeps its old block_reason but is kitted again', () => {
    // advance_application_status keeps block_reason on exit (20261004220000), so the reason
    // alone is history; only together with blocked_needs_human does it describe the row now.
    const reapproved = row('again', 'approved', '2026-10-24T10:00:00Z', { blockReason: 'robots_refused' });
    // Teja re-approved it: it is due like any other approved row.
    expect(selectKitCandidates([reapproved], [], 5).selected).toEqual(['again']);
  });
});

describe('runKitSweep', () => {
  test('one failing row is recorded and the sweep continues with the next', async () => {
    // Built in order; the middle one throws.
    const built: string[] = [];
    // The log lines, so the summary is checked as the operator reads it.
    const lines: string[] = [];
    const summary = await runKitSweep({
      // The kill switch ON: these cases are about selection and failure, not W28.
      isSystemEnabled: async () => true,
      listRows: async () => [row('a', 'applying', '2026-10-24T08:00:00Z'), row('b', 'applying', '2026-10-24T09:00:00Z'), row('c', 'applying', '2026-10-24T10:00:00Z')],
      listKits: async () => [],
      buildOne: async (id) => {
        // The middle row's form is down.
        if (id === 'b') throw new Error('page load timed out');
        built.push(id);
      },
      cap: 5,
      // The run budget is not under test here: never out of time.
      outOfTime: () => false,
      // B2: skips are not under test here.
      recordSkip: async () => {},
      log: (line) => lines.push(line),
    });
    // The rows on either side of the failure were still built.
    expect(built).toEqual(['a', 'c']);
    // The failure is named, not swallowed.
    expect(summary).toEqual({ eligible: 3, attempted: 3, remaining: 0, built: 2, skipped: [], failed: [{ id: 'b', reason: 'page load timed out' }] });
    // And it reaches the log with its reason.
    expect(lines.some((line) => line.includes('b') && line.includes('page load timed out'))).toBe(true);
  });

  test('the cap bounds the builds in one run', async () => {
    // Three eligible, cap one.
    const built: string[] = [];
    const summary = await runKitSweep({
      // The kill switch ON: these cases are about selection and failure, not W28.
      isSystemEnabled: async () => true,
      listRows: async () => [row('a', 'applying', '2026-10-24T08:00:00Z'), row('b', 'applying', '2026-10-24T09:00:00Z'), row('c', 'applying', '2026-10-24T10:00:00Z')],
      listKits: async () => [],
      buildOne: async (id) => { built.push(id); },
      cap: 1,
      // The run budget is not under test here: never out of time.
      outOfTime: () => false,
      // B2: skips are not under test here.
      recordSkip: async () => {},
      log: () => {},
    });
    // Only the longest-waiting row was built; the other two wait for the next run.
    expect(built).toEqual(['a']);
    expect(summary).toEqual({ eligible: 3, attempted: 1, remaining: 2, built: 1, skipped: [], failed: [] });
  });

  test('zero eligible rows is said out loud, never a silent pass', async () => {
    // Everything already kitted.
    const lines: string[] = [];
    const summary = await runKitSweep({
      // The kill switch ON: these cases are about selection and failure, not W28.
      isSystemEnabled: async () => true,
      listRows: async () => [row('a', 'applying', '2026-10-24T08:00:00Z')],
      listKits: async () => [kit('a', '2026-10-24T09:00:00Z')],
      buildOne: async () => { throw new Error('must not be called'); },
      cap: 5,
      // The run budget is not under test here: never out of time.
      outOfTime: () => false,
      // B2: skips are not under test here.
      recordSkip: async () => {},
      log: (line) => lines.push(line),
    });
    // The exact phrase the brief asked for, so a log search finds it.
    expect(lines.some((line) => line.includes('0 eligible'))).toBe(true);
    expect(summary).toEqual({ eligible: 0, attempted: 0, remaining: 0, built: 0, skipped: [], failed: [] });
  });

  test('kits are read only for the rows that could need one', async () => {
    // The ids passed to the kit read.
    let askedFor: readonly string[] = [];
    await runKitSweep({
      // The kill switch ON: this case is about which ids are read.
      isSystemEnabled: async () => true,
      listRows: async () => [row('a', 'applying', '2026-10-24T08:00:00Z'), row('sent', 'applied', '2026-10-24T08:00:00Z')],
      listKits: async (ids) => { askedFor = ids; return []; },
      buildOne: async () => {},
      cap: 5,
      // The run budget is not under test here: never out of time.
      outOfTime: () => false,
      // B2: skips are not under test here.
      recordSkip: async () => {},
      log: () => {},
    });
    // The applied row is not a kit candidate, so its notes are never read.
    expect(askedFor).toEqual(['a']);
  });

  test('W28: with system_enabled off the sweep reads no row and opens no page', async () => {
    // Every port the sweep could touch after the switch, in call order.
    const touched: string[] = [];
    // The log, so the skip is checked as the operator reads it.
    const lines: string[] = [];
    const outcome = await runKitSweep({
      // Teja turned the system off.
      isSystemEnabled: async () => false,
      // A due row exists, so only the switch can explain an empty run.
      listRows: async () => { touched.push('listRows'); return [row('a', 'applying', '2026-10-24T08:00:00Z')]; },
      listKits: async () => { touched.push('listKits'); return []; },
      // A build is a page load on an employer's site: exactly what "off" forbids.
      buildOne: async (id) => { touched.push(`build:${id}`); },
      cap: 5,
      // The run budget is not under test here: never out of time.
      outOfTime: () => false,
      // B2: skips are not under test here.
      recordSkip: async () => {},
      log: (line) => lines.push(line),
    });
    // The closed outcome the CLI must narrow on, never a zero summary posing as "nothing due".
    expect(outcome).toBe('skipped_disabled');
    // Nothing read, nothing built.
    expect(touched).toEqual([]);
    // Said in the log with the agent_runs vocabulary, so a log search finds it.
    expect(lines.some((line) => line.includes('skipped_disabled'))).toBe(true);
  });

  test('W28: an unreadable kill switch fails closed: the sweep throws and builds nothing', async () => {
    // Every port touched after the failed read.
    const touched: string[] = [];
    const run = runKitSweep({
      // supabase-gateway's unwrap turns a refused read into a throw, never into "on".
      isSystemEnabled: async () => { throw new Error('isSystemEnabled failed: timeout'); },
      listRows: async () => { touched.push('listRows'); return [row('a', 'applying', '2026-10-24T08:00:00Z')]; },
      listKits: async () => { touched.push('listKits'); return []; },
      buildOne: async (id) => { touched.push(`build:${id}`); },
      cap: 5,
      // The run budget is not under test here: never out of time.
      outOfTime: () => false,
      // B2: skips are not under test here.
      recordSkip: async () => {},
      log: () => {},
    });
    // The run goes red with the database's reason.
    await expect(run).rejects.toThrow(/isSystemEnabled failed: timeout/);
    // And no employer page was opened on an unknown switch.
    expect(touched).toEqual([]);
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
    const reader = createSweepReader(
      clientAnswering({
        data: [
          // An unparked row: PostgREST returns null for both park facts.
          { id: 'a', status: 'applying', status_changed_at: '2026-10-24T10:00:00+00:00', block_reason: null, unusable: null },
          // A W4 park: the cause arrives under the select's `unusable` alias.
          { id: 'b', status: 'blocked_needs_human', status_changed_at: '2026-10-24T11:00:00+00:00', block_reason: 'other', unusable: 'no_apply_url' },
        ],
        error: null,
      }),
    );
    // Renamed to the sweep's fields, park facts included (W29).
    expect(await reader.listRows()).toEqual([
      { id: 'a', status: 'applying', statusChangedAt: '2026-10-24T10:00:00+00:00', blockReason: null, blockUnusable: null, blockCode: null },
      { id: 'b', status: 'blocked_needs_human', statusChangedAt: '2026-10-24T11:00:00+00:00', blockReason: 'other', blockUnusable: 'no_apply_url', blockCode: null },
    ]);
  });
});

// Task 2 (2026-11-05, Teja 14:47 "no limits/caps on apply-kit"): the fixed 5-kit cap is gone. A run
// takes a batch of 25 and stops starting new kits once its 3000 s budget is spent, so the 60-minute
// job kill never lands mid-row; the rows it left untried go to a run it dispatches itself.
describe('apply-kit run budget and self re-dispatch', () => {
  test('the run budget stops the sweep before the next row; the untried rows count as remaining', async () => {
    // Three due rows; the budget runs out after the first kit.
    const built: string[] = [];
    // Flipped by the first build; the budget check reads it.
    let spent = false;
    const summary = await runKitSweep({
      // The kill switch ON: this case is about the budget.
      isSystemEnabled: async () => true,
      listRows: async () => [row('a', 'applying', '2026-10-24T08:00:00Z'), row('b', 'applying', '2026-10-24T09:00:00Z'), row('c', 'applying', '2026-10-24T10:00:00Z')],
      listKits: async () => [],
      // The first build spends the budget.
      buildOne: async (id) => { built.push(id); spent = true; },
      // A batch big enough that only the budget can stop it.
      cap: 25,
      // Checked before each row.
      outOfTime: () => spent,
      // B2: skips are not under test here.
      recordSkip: async () => {},
      log: () => {},
    });
    // One kit, then it stopped.
    expect(built).toEqual(['a']);
    // Two untried rows, counted, so the workflow re-dispatches.
    expect(summary).toEqual({ eligible: 3, attempted: 1, remaining: 2, built: 1, skipped: [], failed: [] });
  });

  test('shouldRedispatch: only when this run left rows untried AND built at least one kit (the chain always ends)', () => {
    // Batch or budget left rows: go again.
    expect(shouldRedispatch({ eligible: 30, attempted: 25, remaining: 5, built: 20, skipped: [], failed: [] })).toBe(true);
    // Everything tried, even with failures: failed rows wait for the daily cron, never a loop.
    expect(shouldRedispatch({ eligible: 3, attempted: 3, remaining: 0, built: 1, skipped: [], failed: [{ id: 'x', reason: 'r' }, { id: 'y', reason: 'r' }] })).toBe(false);
    // A full batch that all failed: those rows sort first again next run, so going again is a loop.
    expect(shouldRedispatch({ eligible: 40, attempted: 25, remaining: 15, built: 0, skipped: [], failed: Array.from({ length: 25 }, (_, i) => ({ id: String(i), reason: 'r' })) })).toBe(false);
    // Nothing tried (budget gone before the first row): a re-dispatch would make no progress.
    expect(shouldRedispatch({ eligible: 3, attempted: 0, remaining: 3, built: 0, skipped: [], failed: [] })).toBe(false);
    // The kill switch's closed outcome never re-dispatches.
    expect(shouldRedispatch('skipped_disabled')).toBe(false);
  });

  test('apply-kit.yml: batch 25, a 60-minute job that fits the 3000 s budget, and the guarded self re-dispatch', () => {
    // The workflow as committed.
    // Line endings normalised: working copies on Windows are CRLF, the committed file is LF.
    const yml = readFileSync(new URL('../../.github/workflows/apply-kit.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    // The batch: exactly '25', never the old '5' (shape-matched, so a renamed key cannot pass vacuously).
    expect([...yml.matchAll(/^\s+APPLY_KIT_SWEEP_CAP:\s*'(\d+)'\s*$/gm)].map((m) => m[1])).toEqual(['25']);
    // Exactly one timeout, and it is 60 minutes.
    const timeouts = [...yml.matchAll(/^\s+timeout-minutes:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));
    // Two jobs, two kill times: the sweep's 60 minutes, then the re-dispatch's 5.
    expect(timeouts).toEqual([60, 5]);
    // Budget + setup + one in-flight kit + teardown fits inside the kit job's kill (run-window.ts's W31 arithmetic).
    expect(3000 + 180 + 300 + 30).toBeLessThanOrEqual(timeouts[0]! * 60);
    // The two job bodies, split at the second job's header (shape-checked, so a rename cannot pass vacuously).
    const [head, redispatchJob] = yml.split('\n  redispatch:\n');
    // Both exist.
    expect(redispatchJob).toBeDefined();
    // The workflow-level grant is read-only: the next line after contents is not another key.
    expect(head).toMatch(/^permissions:\n {2}contents: read\n(?! {2}\w)/m);
    // actions: write appears exactly once in the file, and it is in the re-dispatch job (2026-11-05
    // security review: the kit job runs third-party code and must never hold it).
    // Counted as a YAML key line, so the comments that explain the rule do not count.
    expect(yml.match(/^\s+actions: write\s*$/gm)).toHaveLength(1);
    // There, as that job's whole grant.
    expect(redispatchJob).toMatch(/\n {4}permissions:\n(?: {6}#.*\n)* {6}actions: write\n/);
    // The kit job leaves no token in .git/config for its later steps.
    expect(head).toContain('persist-credentials: false');
    // The kit job hands the worker's verdict out as a job output.
    expect(head).toContain('redispatch: ${{ steps.kit.outputs.redispatch }}');
    // The re-dispatch runs after the sweep, only on its verdict, and even after a red sweep (per-row failures).
    expect(redispatchJob).toContain('needs: kit');
    // Exactly 'true', never after a cancel.
    expect(redispatchJob).toContain("if: ${{ !cancelled() && needs.kit.outputs.redispatch == 'true' }}");
    // And it starts this same workflow from main, as a blank sweep.
    expect(redispatchJob).toContain('gh workflow run apply-kit.yml --ref main --repo "$REPO"');
    // The concurrency group still coalesces (no parallel kit runs on rapid approves).
    expect(yml).toMatch(/group: applyy-apply-kit\n(?:\s+#.*\n)*\s+cancel-in-progress: false/);
  });
});

// B2 (2026-11-05, P3 #8 + starvation): a robots refusal or a closed posting is a REPORTED SKIP, not a
// failure. The skip is recorded once (an apply_kit_skipped note), so the row is not due again until its
// status changes; a parked posting_closed row is never selected; skips count as progress.
describe('kit skips (B2)', () => {
  test('a KitSkip is recorded and reported, never a failure, and the next row still runs', async () => {
    // The recorded skips.
    const recorded: Array<[string, string, string]> = [];
    // Kits built.
    const built: string[] = [];
    const summary = await runKitSweep({
      // Kill switch on.
      isSystemEnabled: async () => true,
      // Two due rows.
      listRows: async () => [row('a', 'approved', '2026-10-24T08:00:00Z'), row('b', 'approved', '2026-10-24T09:00:00Z')],
      // No kits yet.
      listKits: async () => [],
      // The first is robots-refused.
      buildOne: async (id) => { if (id === 'a') throw new KitSkip('robots_refused', 'robots.txt refused (HTTP 403)'); built.push(id); },
      // A big batch.
      cap: 25,
      // Never out of time.
      outOfTime: () => false,
      // Recorded.
      recordSkip: async (id, code, reason) => { recorded.push([id, code, reason]); },
      // Quiet.
      log: () => {},
    });
    // Skipped, recorded once, and the next row built.
    expect(summary).toEqual({ eligible: 2, attempted: 2, remaining: 0, built: 1, skipped: [{ id: 'a', code: 'robots_refused', reason: 'robots.txt refused (HTTP 403)' }], failed: [] });
    // The note's inputs.
    expect(recorded).toEqual([['a', 'robots_refused', 'robots.txt refused (HTTP 403)']]);
    // The next row ran.
    expect(built).toEqual(['b']);
  });

  test('a skip that cannot be recorded is a failure (it would otherwise be retried every run, silently)', async () => {
    const summary = await runKitSweep({
      // Kill switch on.
      isSystemEnabled: async () => true,
      // One due row.
      listRows: async () => [row('a', 'approved', '2026-10-24T08:00:00Z')],
      // No kits yet.
      listKits: async () => [],
      // Closed posting.
      buildOne: async () => { throw new KitSkip('posting_closed', 'no email field'); },
      // A big batch.
      cap: 25,
      // Never out of time.
      outOfTime: () => false,
      // The note insert is refused.
      recordSkip: async () => { throw new Error('insert refused (42501)'); },
      // Quiet.
      log: () => {},
    });
    // Red, naming both causes.
    expect(summary).toMatchObject({ failed: [{ id: 'a', reason: expect.stringMatching(/no email field.*insert refused/) }], skipped: [] });
  });

  test('a row parked as posting_closed (block_detail.code) is never selected; a re-approved one is', () => {
    // Parked by the applier's pre-submit re-check.
    const closed = row('closed', 'blocked_needs_human', '2026-10-24T08:00:00Z', { blockReason: 'other', blockCode: 'posting_closed' });
    // Re-approved after a parking: the code is history.
    const back = row('back', 'approved', '2026-10-24T08:00:00Z', { blockReason: 'other', blockCode: 'posting_closed' });
    // Only the re-approved one is due.
    expect(selectKitCandidates([closed, back], [], 25)).toEqual({ eligible: ['back'], selected: ['back'] });
  });

  test('skips count as progress for the self re-dispatch', () => {
    // Nothing built, but a skip took a row out of the due set for good.
    expect(shouldRedispatch({ eligible: 40, attempted: 25, remaining: 15, built: 0, skipped: [{ id: 'a', code: 'robots_refused', reason: 'r' }], failed: [] })).toBe(true);
  });

  test('the kit-notes read also returns skip notes, so a skipped row is not due until its status changes', async () => {
    // Every call on the builder, recorded.
    const calls: Array<[string, unknown[]]> = [];
    // A recording PostgREST chain.
    const chain: Record<string, unknown> = {};
    // select/eq/in each record their arguments and return the chain.
    for (const method of ['select', 'eq', 'in']) chain[method] = (...args: unknown[]) => { calls.push([method, args]); return chain; };
    // Thenable, like the real builder.
    chain['then'] = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
    // Read.
    await createSweepReader({ from: () => chain } as unknown as SupabaseLike).listKits(['a']);
    // Both note kinds.
    expect(calls).toContainEqual(['in', ['detail->>kind', ['apply_kit', 'apply_kit_skipped']]]);
  });
});
