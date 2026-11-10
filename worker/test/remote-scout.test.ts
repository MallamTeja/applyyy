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

// One chained builder call (.select, .in, .eq, .upsert, ...) with the arguments it got.
type Call = { method: string; args: unknown[] };
// A fixture that answers by the query's own calls (T12): the fake ignores filters, so a twin read
// (.in('company_slug', ...)) and persistJobBatch's fingerprint read would otherwise look identical.
// `count` overrides the exact count PostgREST would report, so a test can fake a max_rows truncation.
type Answer = (calls: readonly Call[]) => { data: unknown; error?: { message: string } | null; count?: number };

// A recording fake of the supabase-js client. Like the real one it never throws: every
// awaited builder resolves to { data, error }. Every insert/upsert/update/delete is
// recorded by table, which is what the dry-run test counts.
// `failing` names tables whose reads resolve to { data: null, error } (W12: a screener
// context that cannot load), the way supabase-js reports a refused read: as a value.
// T12 extensions: a table fixture may be an Answer function; every chained call is logged in
// `ops` with its args; `rpcAnswer` decides what client.rpc returns, and `rpcs` records each call.
function recordingClient(
  tables: Record<string, unknown>,
  failing: readonly string[] = [],
  rpcAnswer: (name: string, args: unknown) => { data: unknown; error: { message: string } | null } = () => ({ data: null, error: null }),
) {
  // "table.method" for every write attempted.
  const writes: string[] = [];
  // Every chained call with its table and args, so a test can assert the exact filters sent.
  const ops: Array<{ table: string } & Call> = [];
  // Every RPC call, name plus args, so the sweep's moves can be asserted one by one.
  const rpcs: Array<{ name: string; args: unknown }> = [];
  // A chainable, awaitable builder for one table; `single` switches the resolved shape;
  // `calls` is this query's own chain, handed to an Answer fixture.
  const builder = (table: string, single: boolean, calls: readonly Call[]): unknown => new Proxy({}, {
    get(_target, prop) {
      // Awaiting the builder: rows for a list read, one object (or null) for single reads.
      if (prop === 'then') {
        // A failing table answers with an error value, never a throw, like the real client.
        if (failing.includes(table)) return (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: `${table} unavailable` } });
        // The stored fixture for this table.
        const stored = tables[table];
        // A function fixture answers from the chain it was given (T12).
        if (typeof stored === 'function') {
          // The fixture's own answer, error included.
          const answer = (stored as Answer)(calls);
          // Same PostgREST shape as below, count included (the fixture's own count wins, for a truncation).
          return (resolve: (v: unknown) => unknown) => resolve({ data: answer.data, error: answer.error ?? null, count: answer.count ?? (Array.isArray(answer.data) ? answer.data.length : null) });
        }
        // Shaped like PostgREST: an array for lists, an object or null for single.
        const data = single ? (Array.isArray(stored) ? stored[0] ?? null : stored ?? null) : (Array.isArray(stored) ? stored : stored === undefined ? [] : [stored]);
        // A real thenable, so `await` works.
        // `count` too, as PostgREST reports it for a { count: "exact" } read: the screener's
        // history query refuses a page it cannot prove complete. Without it the screener
        // never loaded in this suite, so every real-run test above ran the unscreened path.
        return (resolve: (v: unknown) => unknown) => resolve({ data, error: null, count: Array.isArray(data) ? data.length : null });
      }
      // Every method chains: logged with its args, then a builder that remembers the chain.
      return (...args: unknown[]) => {
        // This call, as the fixture and the test will see it.
        const call: Call = { method: String(prop), args };
        // The flat log the assertions read.
        ops.push({ table, ...call });
        // The four writes are also recorded by name, which is what the dry-run test counts.
        if (prop === 'insert' || prop === 'upsert' || prop === 'update' || prop === 'delete') writes.push(`${table}.${String(prop)}`);
        // single/maybeSingle switch to the one-row shape; everything else keeps the current one.
        return builder(table, single || prop === 'single' || prop === 'maybeSingle', [...calls, call]);
      };
    },
  });
  // The client surface the run uses: from() and rpc() (sign-in happens in the CLI).
  const client = {
    // A fresh chain per table.
    from: (table: string) => builder(table, false, []),
    // Recorded, then answered by the test's rpcAnswer, as a value like supabase-js.
    rpc: async (name: string, args: unknown) => { rpcs.push({ name, args }); return rpcAnswer(name, args); },
  };
  // The fake, plus the three logs.
  return { client: client as unknown as SupabaseClient, writes, ops, rpcs };
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

  it('screener context unavailable fails the real run with screener_not_run instead of a quiet success (W12)', async () => {
    // filter_rules refuses the read, so loadScreenContext returns ok:false.
    const { client, writes } = recordingClient(DB, ['filter_rules']);
    // The live path; the fallback still writes rows at 'discovered'.
    const result = await runRemoteScout({ client, fetchJson: fakeFetch, now: new Date('2026-10-24T08:00:00Z'), dryRun: false, force: false, log: () => {} });
    // Discovery is kept: jobs were still written.
    expect(writes).toContain('jobs.upsert');
    // Red, so the CLI exits 1 (scout-remote.ts sets exitCode on 'failed').
    expect(result.status).toBe('failed');
    // Named first, with the loader's reason, so the run row says why.
    expect(result.errors[0]).toMatch(/^screener_not_run: filter_rules query failed/);
  });

  it('TWIN: the same run with the screener loading closes succeeded, so the failure above is the screener', async () => {
    // Nothing failing.
    const { client } = recordingClient(DB);
    // Same live path.
    const result = await runRemoteScout({ client, fetchJson: fakeFetch, now: new Date('2026-10-24T08:00:00Z'), dryRun: false, force: false, log: () => {} });
    // Green, with no errors at all.
    expect(result.errors).toEqual([]);
    expect(result.status).toBe('succeeded');
  });
});

// T12 (2026-11-10): one posting reached through an aggregator AND through the employer's ATS.
describe('T12: aggregator vs ATS twins', () => {
  // The run clock every T12 test shares.
  const NOW = new Date('2026-11-10T08:00:00Z');
  // Only Jobicy answers, with one tech posting at a company that also has an ATS board.
  async function jobicyOnly(url: string): Promise<unknown> {
    // The one posting: a description so the screener judges it rather than dropping it as empty.
    if (url === REMOTE_FEED_URLS.jobicy) return { jobs: [{ jobTitle: 'Backend Engineer', companyName: 'Acme Labs', url: 'https://jobicy.com/jobs/9', jobGeo: 'Anywhere', jobExcerpt: 'Build Node.js and TypeScript APIs on PostgreSQL.', pubDate: '2026-11-09 09:00:00' }] };
    // RemoteOK: only its legal notice.
    if (url === REMOTE_FEED_URLS.remoteok) return [LEGAL];
    // Arbeitnow: nothing.
    return { data: [] };
  }
  // Feeds that answer with nothing, for the sweep tests (no new rows, only the sweep runs).
  const emptyFeeds = async (url: string): Promise<unknown> => (url === REMOTE_FEED_URLS.remoteok ? [LEGAL] : url === REMOTE_FEED_URLS.jobicy ? { jobs: [] } : { data: [] });
  // The watchlist: Acme Labs' board slug is dash-joined, the aggregator spells the company with a space.
  const WATCHLIST = [{ company_slug: 'acme-labs', company_name: 'Acme Labs' }];
  // Two ATS twins (two locations of one role), deliberately out of order: the smaller id must win.
  const ATS_TWINS = [{ id: 'ats-job-b', company_name: 'Acme Labs', title: 'Backend Engineer' }, { id: 'ats-job-a', company_name: 'Acme Labs', title: 'Backend Engineer' }];
  // True when the chain carries .<method>(<column>, ...).
  const has = (calls: readonly Call[], method: string, column: string): boolean => calls.some((c) => c.method === method && c.args[0] === column);
  // The jobs table: echo ids for the persist upsert, ATS twins for a company_slug read (or `twins`), [] otherwise.
  const jobsTable = (twins: Answer = () => ({ data: ATS_TWINS })): Answer => (calls) => {
    // persistJobBatch's insert: one id per inserted row, so the batch resolves and gets queued.
    const upsert = calls.find((c) => c.method === 'upsert');
    // Echoed with the fingerprint the persist path keys on.
    if (upsert) return { data: (upsert.args[0] as Array<{ fingerprint: string }>).map((r, i) => ({ id: `agg-job-${i + 1}`, fingerprint: r.fingerprint })) };
    // The twin read.
    if (has(calls, 'in', 'company_slug')) return twins(calls);
    // The fingerprint reads: nothing stored yet.
    return { data: [] };
  };
  // The application rows the twin upsert payload carried.
  const upserted = (ops: ReadonlyArray<{ table: string } & Call>) => ops.find((o) => o.table === 'applications' && o.method === 'upsert')?.args[0] as Array<{ job_id: string; status: string; drop_reason: string | null }> | undefined;
  // One aggregator application in the pipeline, plus its twin job's embed.
  const appRow = (id: string, status: string, atsProvider: string) => ({ id, status, updated_at: '2026-11-09T10:00:00.123456+00:00', jobs: { company_name: 'Acme Labs', title: 'Backend Engineer', ats_provider: atsProvider } });
  // Both ATS twins have a live application of their own, so they count as twins (fix round 1, item 1).
  const LIVE_TWIN_APPS = [{ job_id: 'ats-job-a', status: 'scored' }, { job_id: 'ats-job-b', status: 'passed_filters' }];
  // The applications table: the given rows for the jobs!inner embed read (whose chain lands in `seen`,
  // since the screener's history read hits the same table), the twins' own applications for the
  // .in('job_id', ...) liveness read, [] for every other read and the insert.
  // `sweepCount` fakes a sweep read that PostgREST cut at max_rows.
  const appsTable = (rows: unknown[], seen: Call[][] = [], opts: { twinApps?: unknown[]; sweepCount?: number } = {}): Answer => (calls) => {
    // Only the sweep's read embeds jobs!inner.
    const isSweep = calls.some((c) => c.method === 'select' && String(c.args[0]).includes('jobs!inner'));
    // Kept for the filter assertions.
    if (isSweep) seen.push([...calls]);
    // The sweep's rows, with an optional exact count larger than what came back.
    if (isSweep) return opts.sweepCount === undefined ? { data: rows } : { data: rows, count: opts.sweepCount };
    // The liveness read on the twins' own applications.
    if (has(calls, 'in', 'job_id')) return { data: opts.twinApps ?? LIVE_TWIN_APPS };
    // Nothing for anyone else.
    return { data: [] };
  };

  it('T12: a Jobicy posting with an ATS twin inserts as dropped_filter duplicate_of_ats:<id>', async () => {
    // The watchlist resolves the company to the ATS board; the twin read finds two copies.
    const { client, ops } = recordingClient({ ...DB, company_watchlist: WATCHLIST, jobs: jobsTable(), applications: appsTable([]) });
    // The live path.
    await runRemoteScout({ client, fetchJson: jobicyOnly, now: NOW, dryRun: false, force: false, log: () => {} });
    // One application, dropped with the smallest twin id as its reason.
    expect(upserted(ops)?.map((r) => [r.job_id, r.status, r.drop_reason])).toEqual([['agg-job-1', 'dropped_filter', 'duplicate_of_ats:ats-job-a']]);
    // The job itself was still persisted.
    expect(ops.some((o) => o.table === 'jobs' && o.method === 'upsert')).toBe(true);
  });

  it('T12: a Jobicy posting without an ATS twin inserts as the screener planned (passed_filters)', async () => {
    // Same board, but the twin read finds nothing.
    const { client, ops } = recordingClient({ ...DB, company_watchlist: WATCHLIST, jobs: jobsTable(() => ({ data: [] })) });
    // The live path.
    const result = await runRemoteScout({ client, fetchJson: jobicyOnly, now: NOW, dryRun: false, force: false, log: () => {} });
    // The screener's own verdict stands.
    expect(upserted(ops)?.map((r) => [r.job_id, r.status, r.drop_reason])).toEqual([['agg-job-1', 'passed_filters', null]]);
    // Non-vacuity: the twin read really ran, with the board slug, against the four employer ATSes only
    // (fix round 1, item 5: linkedin/manual/unknown rows are not employer-ATS twins).
    expect(ops.filter((o) => o.table === 'jobs' && (o.method === 'neq' || (o.method === 'in' && (o.args[0] === 'company_slug' || o.args[0] === 'ats_provider')))).map((o) => [o.method, ...o.args])).toEqual([['in', 'company_slug', ['acme-labs']], ['in', 'ats_provider', ['greenhouse', 'lever', 'ashby', 'workday']]]);
    // A clean run.
    expect(result.status).toBe('succeeded');
  });

  it('T12: the sweep moves an aggregator application to dropped_duplicate and never the ATS copy', async () => {
    // The fake ignores .eq('jobs.ats_provider','other'), so it also returns the ATS copy: the code must refuse it.
    const { client, rpcs } = recordingClient({ ...DB, company_watchlist: WATCHLIST, jobs: jobsTable(), applications: appsTable([appRow('app-agg', 'scored', 'other'), appRow('app-ats', 'scored', 'greenhouse')]) });
    // The live path with no new postings: only the sweep acts.
    await runRemoteScout({ client, fetchJson: emptyFeeds, now: NOW, dryRun: false, force: false, log: () => {} });
    // Exactly one move, for the aggregator copy, stamped with the row's updated_at.
    expect(rpcs).toEqual([{ name: 'advance_application_status', args: { p_application_id: 'app-agg', p_to_status: 'dropped_duplicate', p_agent: 'scout_aggregator', p_detail: { reason: 'duplicate_of_ats', ats_job_id: 'ats-job-a' }, p_expected_updated_at: '2026-11-09T10:00:00.123456+00:00' } }]);
  });

  it('T12: the sweep never touches an approved aggregator application', async () => {
    // An approved aggregator row comes back (the fake ignores filters); only the scored one may move.
    // The sweep read's chain, captured by the fixture.
    const seen: Call[][] = [];
    // The fixture database.
    const { client, rpcs } = recordingClient({ ...DB, company_watchlist: WATCHLIST, jobs: jobsTable(), applications: appsTable([appRow('app-approved', 'approved', 'other'), appRow('app-agg', 'scored', 'other')], seen) });
    // The live path.
    await runRemoteScout({ client, fetchJson: emptyFeeds, now: NOW, dryRun: false, force: false, log: () => {} });
    // One sweep read, asking for exactly the six pre-human statuses.
    expect(seen.map((chain) => chain.filter((c) => c.method === 'in').map((c) => c.args))).toEqual([[['status', ['passed_filters', 'scored', 'tailored', 'audit_clean', 'audit_flagged', 'awaiting_approval']]]]);
    // And only on aggregator jobs.
    expect(seen[0]?.some((c) => c.method === 'eq' && c.args[0] === 'jobs.ats_provider' && c.args[1] === 'other')).toBe(true);
    // The approved row is never moved, even though the read returned it.
    expect(rpcs.map((r) => (r.args as { p_application_id: string }).p_application_id)).toEqual(['app-agg']);
  });

  it('T12: a failed twin lookup drops nothing and is reported', async () => {
    // The twin read fails as a value, the way supabase-js reports it.
    const { client, ops, rpcs } = recordingClient({ ...DB, company_watchlist: WATCHLIST, jobs: jobsTable(() => ({ data: null, error: { message: 'statement timeout' } })), applications: appsTable([appRow('app-agg', 'scored', 'other')]) });
    // The live path.
    const result = await runRemoteScout({ client, fetchJson: jobicyOnly, now: NOW, dryRun: false, force: false, log: () => {} });
    // Kept as the screener planned: a missing answer is not a twin.
    expect(upserted(ops)?.map((r) => [r.status, r.drop_reason])).toEqual([['passed_filters', null]]);
    // Nothing swept either.
    expect(rpcs).toEqual([]);
    // Reported on the run, which closes failed.
    expect(result.errors.some((e) => /ats twin lookup.*statement timeout/.test(e))).toBe(true);
    expect(result.status).toBe('failed');
  });

  it('T12: a dry run counts twins and sweep candidates but writes and moves nothing', async () => {
    // Both cases present at once.
    const { client, writes, rpcs } = recordingClient({ ...DB, company_watchlist: WATCHLIST, jobs: jobsTable(), applications: appsTable([appRow('app-agg', 'scored', 'other')]) });
    // Collected log lines.
    const lines: string[] = [];
    // The dry path.
    await runRemoteScout({ client, fetchJson: jobicyOnly, now: NOW, dryRun: true, force: false, log: (l) => lines.push(l) });
    // Reads only.
    expect([writes, rpcs]).toEqual([[], []]);
    // Both counts said.
    expect(lines.some((l) => /1 posting\(s\) have an ATS twin/.test(l))).toBe(true);
    expect(lines.some((l) => /sweep would move 1/.test(l))).toBe(true);
  });

  it('T12: an ATS twin whose own application was dropped does not drop the aggregator copy', async () => {
    // ats-job-a's own application was dropped (say its board location failed work-auth); ats-job-b has none at all.
    const twinApps = [{ job_id: 'ats-job-a', status: 'dropped_filter' }];
    // A new posting AND a queued aggregator row, both pointing at those dead twins.
    const { client, ops, rpcs } = recordingClient({ ...DB, company_watchlist: WATCHLIST, jobs: jobsTable(), applications: appsTable([appRow('app-agg', 'tailored', 'other')], [], { twinApps }) });
    // The live path.
    const result = await runRemoteScout({ client, fetchJson: jobicyOnly, now: NOW, dryRun: false, force: false, log: () => {} });
    // The aggregator copy is the only live one: kept as the screener planned.
    expect(upserted(ops)?.map((r) => [r.status, r.drop_reason])).toEqual([['passed_filters', null]]);
    // And the tailored aggregator row is not swept.
    expect(rpcs).toEqual([]);
    // Non-vacuity: the liveness read really asked about both twin ids.
    // (order-free: the ids arrive in the twin read's row order).
    expect(ops.some((o) => o.table === 'applications' && o.method === 'in' && o.args[0] === 'job_id' && JSON.stringify([...(o.args[1] as string[])].sort()) === JSON.stringify(['ats-job-a', 'ats-job-b']))).toBe(true);
    // Not an error: a dead twin is a real answer.
    expect(result.status).toBe('succeeded');
  });

  it('TWIN: one live twin among dead ones is still a twin, and its id is the one named', async () => {
    // ats-job-a dropped, ats-job-b alive.
    const twinApps = [{ job_id: 'ats-job-a', status: 'failed' }, { job_id: 'ats-job-b', status: 'awaiting_approval' }];
    // The fixture database.
    const { client, ops } = recordingClient({ ...DB, company_watchlist: WATCHLIST, jobs: jobsTable(), applications: appsTable([], [], { twinApps }) });
    // The live path.
    await runRemoteScout({ client, fetchJson: jobicyOnly, now: NOW, dryRun: false, force: false, log: () => {} });
    // Dropped against the live twin, not the smaller dead id.
    expect(upserted(ops)?.map((r) => r.drop_reason)).toEqual(['duplicate_of_ats:ats-job-b']);
  });

  it('T12: a twin read cut at max_rows drops nothing and is reported as truncated', async () => {
    // PostgREST returned 2 rows of 1500 with no error: an arbitrary subset.
    const { client, ops } = recordingClient({ ...DB, company_watchlist: WATCHLIST, jobs: jobsTable(() => ({ data: ATS_TWINS, count: 1500 })), applications: appsTable([]) });
    // The live path.
    const result = await runRemoteScout({ client, fetchJson: jobicyOnly, now: NOW, dryRun: false, force: false, log: () => {} });
    // Nothing dropped on a partial answer.
    expect(upserted(ops)?.map((r) => [r.status, r.drop_reason])).toEqual([['passed_filters', null]]);
    // Said, with both numbers.
    expect(result.errors).toContain('ats twin lookup: ats twin lookup truncated (2 of 1500)');
  });

  it('T12: a sweep read cut at max_rows is reported, and the rows read are still processed', async () => {
    // One row came back of 1500 pre-human aggregator rows.
    const { client, rpcs } = recordingClient({ ...DB, company_watchlist: WATCHLIST, jobs: jobsTable(), applications: appsTable([appRow('app-agg', 'scored', 'other')], [], { sweepCount: 1500 }) });
    // The live path.
    const result = await runRemoteScout({ client, fetchJson: emptyFeeds, now: NOW, dryRun: false, force: false, log: () => {} });
    // Visible.
    expect(result.errors.some((e) => /duplicate sweep read truncated \(1 of 1500\)/.test(e))).toBe(true);
    // What was read still moved.
    expect(rpcs.map((r) => (r.args as { p_application_id: string }).p_application_id)).toEqual(['app-agg']);
  });

  it('T12: a company that folds to empty never matches a twin', async () => {
    // A board whose name folds to nothing, and an ATS job at that same nameless company.
    const watchlist = [{ company_slug: 'x-co', company_name: '***' }];
    // The ATS twin a degenerate key "|backend engineer" would match.
    const twins = () => ({ data: [{ id: 'ats-x', company_name: '***', title: 'Backend Engineer' }] });
    // A live application on it, so only the key itself can refuse the match.
    const twinApps = [{ job_id: 'ats-x', status: 'scored' }];
    // A posting from the same nameless company.
    const feed = async (url: string): Promise<unknown> => (url === REMOTE_FEED_URLS.jobicy ? { jobs: [{ jobTitle: 'Backend Engineer', companyName: '***', url: 'https://jobicy.com/jobs/10', jobGeo: 'Anywhere', jobExcerpt: 'Build Node.js and TypeScript APIs on PostgreSQL.', pubDate: '2026-11-09 09:00:00' }] } : emptyFeeds(url));
    // The fixture database.
    const { client, ops } = recordingClient({ ...DB, company_watchlist: watchlist, jobs: jobsTable(twins), applications: appsTable([], [], { twinApps }) });
    // The live path.
    await runRemoteScout({ client, fetchJson: feed, now: NOW, dryRun: false, force: false, log: () => {} });
    // Whatever the screener decided, it was not a twin drop.
    expect(upserted(ops)?.some((r) => r.drop_reason?.startsWith('duplicate_of_ats:'))).toBe(false);
    // Non-vacuity: the posting reached the queue at all.
    expect(upserted(ops)).toHaveLength(1);
  });
});

// T12 (2026-11-10), the orch's check: the remote scout's sweep agent may move a row ONLY from the six pre-approval
// statuses into dropped_duplicate. An edge from approved or later would let an agent overrule a human's decision.
describe('T12: scout_aggregator edges in the status graph', () => {
  // The six statuses the sweep may move an aggregator copy out of.
  const PRE_APPROVAL = ['passed_filters', 'scored', 'tailored', 'audit_clean', 'audit_flagged', 'awaiting_approval'];
  it('T12: scout_aggregator can only take a pre-approval row to dropped_duplicate, never approved or later', async () => {
    // The TS mirror of the live table, kept equal to the migrations by enum-parity.test.ts.
    const { STATUS_TRANSITIONS } = await import('@applyy/shared-types');
    // Every edge this agent may take.
    const mine = STATUS_TRANSITIONS.filter((edge) => edge.allowedAgents.includes('scout_aggregator'));
    // Non-vacuity: exactly the six sweep edges exist (zero would pass the checks below trivially).
    expect(mine.map((edge) => `${edge.from}->${edge.to}`).sort()).toEqual(PRE_APPROVAL.map((from) => `${from}->dropped_duplicate`).sort());
  });
});

// T12 (2026-11-10): the sweep's moves need the agent key header. scout-remote.ts runs main() on import, so it cannot be
// imported here; these read the shipped files and assert the POSITIVE wiring (the exact form cli/apply.ts uses).
describe('T12: the remote scout sends the agent key', () => {
  it('T12: scout-remote.ts builds its client with the agent-key header from APPLYY_AGENT_KEY', async () => {
    // The file system, read lazily so the rest of this suite never depends on it.
    const { readFileSync } = await import('node:fs');
    // The CLI shell, as shipped.
    const source = readFileSync(new URL('../src/cli/scout-remote.ts', import.meta.url), 'utf8');
    // The header option on the client, read from the shared env-var name (never a literal, never logged).
    expect(source).toContain('global: { headers: agentKeyHeaders(process.env[AGENT_KEY_ENV_VAR]) }');
    // And the helper really comes from the one module the database's check is written against.
    expect(source).toMatch(/import \{ AGENT_KEY_ENV_VAR, agentKeyHeaders \} from '\.\.\/\.\.\/\.\.\/supabase\/functions\/_shared\/db\/agent-key\.ts';/);
  });

  it('T12: the helper turns the env value into the header the database checks, and unset into none', async () => {
    // The real helper, so this proves what reaches the wire.
    const { AGENT_KEY_ENV_VAR, agentKeyHeaders } = await import('../../supabase/functions/_shared/db/agent-key.ts');
    // The env var the workflow sets.
    expect(AGENT_KEY_ENV_VAR).toBe('APPLYY_AGENT_KEY');
    // A set value becomes exactly one header (a synthetic value, never the real one).
    expect(Object.keys(agentKeyHeaders('synthetic-test-value'))).toHaveLength(1);
    // Unset sends nothing, so a run without the secret still inserts.
    expect(agentKeyHeaders(undefined)).toEqual({});
  });

  it('T12: scout-remote.yml passes APPLYY_AGENT_KEY from the Actions secret to the run step', async () => {
    // The file system, as above.
    const { readFileSync } = await import('node:fs');
    // The workflow, as shipped.
    const yml = readFileSync(new URL('../../.github/workflows/scout-remote.yml', import.meta.url), 'utf8');
    // The run step's own block: from its `- name:` to the next `- name:` or the end of the file, so a
    // secret moved to job-level env (visible to every step) fails here (fix round 1, item 6).
    const start = yml.indexOf('- name: Run Scout Remote Discovery');
    // Non-vacuity: the step exists.
    expect(start).toBeGreaterThan(-1);
    // Where the next step begins, if any.
    const next = yml.indexOf('- name:', start + 1);
    // The step block itself.
    const step = yml.slice(start, next === -1 ? undefined : next);
    // From the secret, under the exact env name the CLI reads, inside that step.
    expect(step).toContain('APPLYY_AGENT_KEY: ${{ secrets.APPLYY_AGENT_KEY }}');
    // And nowhere else in the file: one scoped copy.
    expect(yml.split('APPLYY_AGENT_KEY: ${{ secrets.APPLYY_AGENT_KEY }}')).toHaveLength(2);
  });
});
