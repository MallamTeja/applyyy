// Tests for the remote scout (RemoteOK, Jobicy, Arbeitnow): the feed safety rules in
// src/scout/remote-feeds.ts and the run guarantees in src/scout/remote-run.ts. The CLI
// (src/cli/scout-remote.ts) runs main() on import, so everything it decides lives in those
// two modules and is pinned here.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { REMOTE_FEED_URLS, parseArbeitnow, parseJobicy, parseRemoteOK, remotePreparedJob } from '../src/scout/remote-feeds.ts';
import { runRemoteScout } from '../src/scout/remote-run.ts';

// One RemoteOK item; only the fields the parser reads.
function remoteOkItem(applyUrl: string, url = 'https://remoteok.com/remote-jobs/1') {
  // RemoteOK's own field names.
  return { position: 'Backend Engineer', company: 'ExampleCo', location: 'Worldwide', apply_url: applyUrl, url, description: 'Node.js', date: '2026-10-23T10:00:00+00:00' };
}

// RemoteOK prefixes its array with a legal notice, which must never become a job.
const LEGAL = { legal: 'API terms' };

describe('remote feed URLs', () => {
  it('a Jobicy URL carries industry=dev', () => {
    // Unfiltered Jobicy is mostly non-tech; the filter belongs at the source (Teja, 2026-10-24).
    expect(new URL(REMOTE_FEED_URLS.jobicy).searchParams.get('industry')).toBe('dev');
  });

  it('RemoteOK is fetched whole, with no tag filter (one request, the screener judges)', () => {
    // Teja's ruling: fetch-all; poster tags are lossy and `?tag=` is ignored by RemoteOK anyway.
    expect(new URL(REMOTE_FEED_URLS.remoteok).search).toBe('');
  });
});

describe('apply URL gate', () => {
  it('a non-https remote apply URL is dropped', () => {
    // The XSS vector: a javascript: URL from a feed must never become a stored apply_url.
    const parsed = parseRemoteOK([LEGAL, remoteOkItem('javascript:alert(1)', 'data:text/html,x')]);
    // Refused, and counted rather than silently lost.
    expect(parsed.jobs).toHaveLength(0);
    expect(parsed.refused).toBe(1);
  });

  it('TWIN: an unsafe first URL falls through to a safe second one, which is kept', () => {
    // apply_url is unsafe but the listing url is https: readHttpUrl tries the next candidate.
    const parsed = parseRemoteOK([LEGAL, remoteOkItem('javascript:alert(1)')]);
    // Kept, with the safe URL.
    expect(parsed.jobs.map((j) => j.applyUrl)).toEqual(['https://remoteok.com/remote-jobs/1']);
  });

  it('Jobicy and Arbeitnow apply the same gate', () => {
    // One unsafe item per feed.
    const jobicy = parseJobicy({ jobs: [{ jobTitle: 'Dev', companyName: 'A', url: 'javascript:alert(1)' }] });
    // Arbeitnow keeps only remote rows, so this one is remote.
    const arbeitnow = parseArbeitnow({ data: [{ title: 'Dev', company_name: 'B', url: 'data:text/html,x', remote: true }] });
    // Both refused.
    expect([jobicy.jobs.length, jobicy.refused, arbeitnow.jobs.length, arbeitnow.refused]).toEqual([0, 1, 0, 1]);
  });

  it('the RemoteOK legal notice and malformed envelopes produce no jobs and do not throw', () => {
    // Only the notice: nothing.
    expect(parseRemoteOK([LEGAL]).jobs).toHaveLength(0);
    // An HTML error page parsed as a string, or null, is no jobs rather than a crash.
    expect(parseJobicy('<html>').jobs).toHaveLength(0);
    expect(parseArbeitnow(null).jobs).toHaveLength(0);
  });
});

describe('posted date (shared extractPostedAt, remote_feed variant)', () => {
  // A fixed sighting clock.
  const SEEN = new Date('2026-10-24T08:00:00Z');
  // One feed posting whose publish value each case swaps; everything else is a valid posting.
  // Through the real parser, so the test exercises exactly what a feed would produce.
  const posting = (published: unknown) => parseRemoteOK([LEGAL, { ...remoteOkItem('https://example.com/apply'), date: published }]).jobs[0]!;

  it('a remote row with a real date is exact, through the shared extractor', async () => {
    // The row the persist path would write.
    // A RemoteOK-style ISO date.
    const { row } = await remotePreparedJob(posting('2026-10-23T10:00:00+00:00'), SEEN);
    // The feed's own date, at full confidence.
    expect([row.posted_at, row.posted_at_source]).toEqual(['2026-10-23T10:00:00.000Z', 'exact']);
  });

  it('a remote row with a junk date is derived from first sighting, NEVER unknown (unknown fails the staleness rule)', async () => {
    // The V8 trap: "-5" parses as a 2001 date if nothing checks its shape first.
    const { row } = await remotePreparedJob(posting('-5'), SEEN);
    // Our sighting, honestly labelled; 'unknown' would mean the cold-start guard fired.
    expect([row.posted_at, row.posted_at_source]).toEqual([SEEN.toISOString(), 'derived']);
  });
});

// A recording fake of the supabase-js client. Like the real one it never throws: every
// awaited builder resolves to { data, error }. Every insert/upsert/update/delete is
// recorded by table, which is what the dry-run test counts.
function recordingClient(tables: Record<string, unknown>) {
  // "table.method" for every write attempted.
  const writes: string[] = [];
  // A chainable, awaitable builder for one table; `single` switches the resolved shape.
  const builder = (table: string, single: boolean): unknown => new Proxy({}, {
    get(_target, prop) {
      // Awaiting the builder: rows for a list read, one object (or null) for single reads.
      if (prop === 'then') {
        // The stored fixture for this table.
        const stored = tables[table];
        // Shaped like PostgREST: an array for lists, an object or null for single.
        const data = single ? (Array.isArray(stored) ? stored[0] ?? null : stored ?? null) : (Array.isArray(stored) ? stored : stored === undefined ? [] : [stored]);
        // A real thenable, so `await` works.
        return (resolve: (v: unknown) => unknown) => resolve({ data, error: null });
      }
      // The four writes are recorded, then keep chaining (.select(), .eq(), ...).
      if (prop === 'insert' || prop === 'upsert' || prop === 'update' || prop === 'delete') {
        return () => { writes.push(`${table}.${String(prop)}`); return builder(table, single); };
      }
      // single/maybeSingle switch to the one-row shape.
      if (prop === 'single' || prop === 'maybeSingle') return () => builder(table, true);
      // Every other method (select, eq, in, limit, order, ...) just chains.
      return () => builder(table, single);
    },
  });
  // The client surface the run uses: from() only (sign-in happens in the CLI).
  return { client: { from: (table: string) => builder(table, false) } as unknown as SupabaseClient, writes };
}

// The three feeds, each with one safe tech posting.
async function fakeFetch(url: string): Promise<unknown> {
  // RemoteOK: legal notice plus one job.
  if (url === REMOTE_FEED_URLS.remoteok) return [LEGAL, remoteOkItem('https://example.com/apply/1')];
  // Jobicy: one job.
  if (url === REMOTE_FEED_URLS.jobicy) return { jobs: [{ jobTitle: 'Frontend Developer', companyName: 'Jobi', url: 'https://jobicy.com/jobs/2', pubDate: '2026-10-22 09:00:00' }] };
  // Arbeitnow: one remote job.
  return { data: [{ title: 'Software Engineer', company_name: 'Arbeit', url: 'https://www.arbeitnow.com/jobs/3', remote: true, created_at: 1761300000 }] };
}

// The database the fake answers with: kill switch ON, a run row id, nothing stored yet.
const DB = { system_settings: { system_enabled: true }, agent_runs: { id: 'run-1' } };

describe('remote run', () => {
  it('dry_run performs zero DB writes', async () => {
    // Recording client over the fixture database.
    const { client, writes } = recordingClient(DB);
    // A full dry run over three feeds.
    const result = await runRemoteScout({ client, fetchJson: fakeFetch, now: new Date('2026-10-24T08:00:00Z'), dryRun: true, force: false, log: () => {} });
    // Non-vacuity: the run really got past the kill switch and prepared rows to (not) write.
    expect(result.status).toBe('dry_run');
    expect(result.prepared).toBe(3);
    // THE GUARANTEE: not one insert, upsert, update or delete, telemetry included.
    expect(writes).toEqual([]);
  });

  it('TWIN: the same run with dry_run off does write, so the recorder can see writes', async () => {
    // Same fixture, real run.
    const { client, writes } = recordingClient(DB);
    // The live path.
    await runRemoteScout({ client, fetchJson: fakeFetch, now: new Date('2026-10-24T08:00:00Z'), dryRun: false, force: false, log: () => {} });
    // It opened its run row and wrote jobs, which a broken recorder could not show.
    expect(writes).toContain('agent_runs.insert');
    expect(writes).toContain('jobs.upsert');
  });

  it('a dry run with the kill switch off writes nothing either', async () => {
    // Switch off, not forced.
    const { client, writes } = recordingClient({ ...DB, system_settings: { system_enabled: false } });
    // The skip path.
    const result = await runRemoteScout({ client, fetchJson: fakeFetch, now: new Date(), dryRun: true, force: false, log: () => {} });
    // Skipped, and silent on the database (no run row was opened to close).
    expect(result.status).toBe('skipped_disabled');
    expect(writes).toEqual([]);
  });

  it('every feed down fails the run instead of closing it as a quiet success', async () => {
    // A fetch that always fails, like three outages at once.
    const { client } = recordingClient(DB);
    // The live path with no feed answering.
    const result = await runRemoteScout({ client, fetchJson: async () => { throw new Error('HTTP 503'); }, now: new Date(), dryRun: false, force: false, log: () => {} });
    // Red, with every feed named.
    expect(result.status).toBe('failed');
    expect(result.failedFeeds).toEqual(['remoteok', 'jobicy', 'arbeitnow']);
  });
});
