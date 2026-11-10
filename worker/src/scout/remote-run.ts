// One remote-scout run: the feeds in, screened applications out, through the SAME path the
// ATS scout uses (worker/src/cli/scout.ts): dedupe by fingerprint, persistJobBatch, the
// shared screener, checked writes and an honest agent_runs close.
//
// WHY IT IS A FUNCTION WITH INJECTED DEPENDENCIES. The CLI runs main() on import and cannot
// be tested; this can. worker/test/remote-scout.test.ts drives it with a recording client to
// prove the property the scheduled workflow relies on: a dry run performs ZERO writes.
//
// ATS TWINS (T12, 2026-11-10). One posting can reach us through a feed AND through the employer's
// ATS board; the fingerprint keeps them apart (the feed says "Anywhere", the board "Remote, Global").
// crossSourceKey(company, title) joins them. Two moves, both aimed ONLY at the aggregator copy:
//   (A) a new feed posting whose ATS twin exists is queued at dropped_filter, reason duplicate_of_ats:<id>;
//   (B) a sweep moves an already-queued aggregator application (pre-human statuses only) to dropped_duplicate.
// A failed lookup drops nothing: keeping a duplicate beats losing a job (CLAUDE.md §6).
//
// WHAT THE OLD scout-remote.ts BYPASSED (2026-10-24), each now routed through a shared helper:
//   - applications were inserted at 'discovered' with no screening, so remote rows piled up
//     for the drain; now planScreenedApplications lands them at passed_filters/dropped_filter.
//   - a private title/keyword filter dropped postings silently before any row existed; the
//     screener is now the one judge, and its drops are recorded with a reason.
//   - jobs were upserted with ignoreDuplicates:false, rewriting first_seen_at on every
//     re-sighting; persistJobBatch keeps it write-once.
//   - write errors were ignored and the run always closed 'succeeded'.

// The client type the persist and screen helpers take.
import type { SupabaseClient } from '@supabase/supabase-js';
// The shared screener glue, the same import scout.ts uses.
import { planScreenedApplications } from '../../../supabase/functions/_shared/screen/screen-batch.ts';
// The screener's database context and its supabase adapter.
import { loadScreenContext } from '../../../supabase/functions/_shared/screen/context.ts';
import { supabaseScreenQueries } from '../../../supabase/functions/_shared/screen/supabase-queries.ts';
// Rule warnings onto the run row, one format for every screening run.
import { withRuleWarnings } from '../../../supabase/functions/_shared/screen/run-summary.ts';
// The dedupe and the insert/refresh split shared with the ATS scout.
import { dedupeByFingerprint, persistJobBatch, type PreparedJob } from './persist-jobs.ts';
// The feeds and their parsers.
import { REMOTE_FEED_URLS, parseArbeitnow, parseJobicy, parseRemoteOK, remotePreparedJob, type RemoteFeed, type RemoteJob, type RemoteParse } from './remote-feeds.ts';
// The company fold, by relative path the way remote-feeds.ts imports jobFingerprint.
import { normalizeCompany } from '../../../supabase/functions/_shared/normalize/fingerprint.ts';
// The twin key, null when company or title folds to nothing: the same refusal the screener's already_applied uses,
// so a degenerate "|title" or "acme|" key can never match (fix round 1, item 4).
import { twinOf } from '../../../supabase/functions/_shared/filter/cascade.ts';

// Rows per write, the same size scout.ts uses.
const BATCH_SIZE = 50;

// The statuses the sweep may move: everything before a human acts. approved and later are the
// human's alone, so they are never selected and never moved (T12).
const SWEEP_STATUSES = ['passed_filters', 'scored', 'tailored', 'audit_clean', 'audit_flagged', 'awaiting_approval'] as const;
// Moves per run, so a backlog (or a migration that is not live yet, where every move errors) cannot stall the scout.
const SWEEP_CAP = 200;
// Rows the sweep reads per run, oldest first. Larger than the cap, but NOT starvation-proof: if more than this many
// pre-human aggregator rows exist, the oldest page without twins fills every read and newer rows are never looked at.
// The sweep read's exact count makes that visible as a run error instead of silent.
// ponytail: one page; switch to keyset paging (updated_at, id) once >1000 pre-human aggregator rows exist (a handful today).
const SWEEP_READ_LIMIT = 1000;
// The employer ATSes a twin may come from. linkedin, manual, unknown and smartrecruiters rows are not an employer's
// own board posting, so they never make an aggregator copy redundant (fix round 1, item 5).
const TWIN_ATS_PROVIDERS = ['greenhouse', 'lever', 'ashby', 'workday'] as const;
// A twin whose own application sits here is not live: the ATS copy was dropped or failed, so the aggregator copy
// may be the only path to the job left. Dropping it too would lose the job (fix round 1, item 1).
const DEAD_TWIN_STATUSES: readonly string[] = ['dropped_filter', 'dropped_duplicate', 'failed'];

// A lookup that either answered or says why not; a failure is never an empty answer.
type Lookup<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };
// What a twin lookup needs from one posting.
interface TwinQuery { readonly company: string; readonly title: string }

// The company as one token: "Acme Labs" -> "acmelabs", which equals the board slug "acme-labs" without dashes
// (measured on 240/240 live pairs). The aggregator's own company_slug is NOT the board's, so it cannot be used.
function compactCompany(company: string): string {
  // normalizeCompany folds and peels legal suffixes; the spaces between tokens are all that is left to remove.
  return normalizeCompany(company).replaceAll(' ', '');
}

// The watchlist as compact company -> board slug, read once per run.
async function loadBoardSlugs(client: SupabaseClient): Promise<Lookup<Map<string, string>>> {
  // Both columns: the slug is the join key into jobs, the name is a second spelling to match on.
  const { data, error } = await client.from('company_watchlist').select('company_slug, company_name');
  // A refused read is a failure, never "no boards".
  if (error) return { ok: false, reason: `company_watchlist read failed: ${error.message}` };
  // Shape check: anything but an array is an answer we cannot trust.
  if (!Array.isArray(data)) return { ok: false, reason: 'company_watchlist read returned no row array' };
  // Compact company -> board slug.
  const boards = new Map<string, string>();
  // Row by row, skipping any without a usable slug.
  for (const row of data as Array<{ company_slug?: unknown; company_name?: unknown }>) {
    // No slug means no way into jobs for this board.
    if (typeof row.company_slug !== 'string' || row.company_slug === '') continue;
    // The board's name, when present, is a second key; a wrong guess only widens the read, crossSourceKey still decides.
    if (typeof row.company_name === 'string') boards.set(compactCompany(row.company_name), row.company_slug);
    // The measured key: the slug without its dashes. Set last so it wins a collision with a name key.
    boards.set(row.company_slug.replaceAll('-', ''), row.company_slug);
  }
  // The map, possibly empty (no boards is a real answer once the read succeeded).
  return { ok: true, value: boards };
}

// LIVE ATS jobs sharing a twin key with any of `postings`: key -> twin job ids, smallest first.
async function findAtsTwins(client: SupabaseClient, boards: ReadonlyMap<string, string>, postings: readonly TwinQuery[]): Promise<Lookup<Map<string, string[]>>> {
  // Only keys some posting asked about are kept; a posting whose key folds to nothing asks for nothing.
  const wanted = new Set(postings.map((p) => twinOf(p.company, p.title)).filter((k): k is string => k !== null));
  // The board slugs these companies resolve to: only this batch's, never the whole watchlist.
  // A company that compacts to "" has no board (a nameless key would match every nameless board).
  const slugs = [...new Set(postings.map((p) => compactCompany(p.company)).filter((c) => c !== '').map((c) => boards.get(c)).filter((s): s is string => s !== undefined))];
  // The answer, filled below.
  const twins = new Map<string, string[]>();
  // No boards matched or no usable key: a true "no twins", and no pointless round trip.
  if (slugs.length === 0 || wanted.size === 0) return { ok: true, value: twins };
  // Employer-ATS rows only; the exact count exposes a read PostgREST cut at max_rows without saying so.
  const { data, error, count } = await client.from('jobs').select('id, company_name, title', { count: 'exact' }).in('company_slug', slugs).in('ats_provider', [...TWIN_ATS_PROVIDERS]);
  // A refused read is a failure, never "no twins".
  if (error) return { ok: false, reason: error.message };
  // Shape check, as above.
  if (!Array.isArray(data)) return { ok: false, reason: 'jobs read returned no row array' };
  // A partial answer is an arbitrary subset: treated as no answer, so nothing is dropped on it.
  if (count !== data.length) return { ok: false, reason: `ats twin lookup truncated (${data.length} of ${count ?? 'unknown'})` };
  // Twin key -> candidate ids, before the liveness check.
  const candidates = new Map<string, string[]>();
  // Row by row.
  for (const row of data as Array<{ id?: unknown; company_name?: unknown; title?: unknown }>) {
    // A row missing an id cannot be named in a drop reason; skipped rather than guessed.
    if (typeof row.id !== 'string') continue;
    // The ATS row's key; null when its company or title folds to nothing.
    const key = twinOf(row.company_name as string | null | undefined, row.title as string | null | undefined);
    // No key, or not a twin of anything in this batch.
    if (key === null || !wanted.has(key)) continue;
    // Several locations of one role are several candidates; all kept.
    candidates.set(key, [...(candidates.get(key) ?? []), row.id]);
  }
  // Every candidate id, for the one liveness read.
  const ids = [...candidates.values()].flat();
  // No candidates: nothing to check.
  if (ids.length === 0) return { ok: true, value: twins };
  // THE LIVENESS READ: each candidate's own application. UNIQUE(user_id, job_id) caps it at ids.length rows.
  const { data: apps, error: appsErr } = await client.from('applications').select('job_id, status').in('job_id', ids);
  // A refused read drops nothing: a twin we cannot prove live is not a twin.
  if (appsErr) return { ok: false, reason: `twin applications read failed: ${appsErr.message}` };
  // Shape check, as above.
  if (!Array.isArray(apps)) return { ok: false, reason: 'twin applications read returned no row array' };
  // The ids whose application is still alive.
  const live = new Set<string>();
  // Row by row.
  for (const app of apps as Array<{ job_id?: unknown; status?: unknown }>) {
    // A malformed row proves nothing; skipped, so its job is not a twin.
    if (typeof app.job_id !== 'string' || typeof app.status !== 'string') continue;
    // Dropped or failed on the ATS side: the aggregator copy may be the only path left.
    if (DEAD_TWIN_STATUSES.includes(app.status)) continue;
    // Alive.
    live.add(app.job_id);
  }
  // Keep only live candidates. A twin with NO application is not a twin either: nothing would apply through it.
  for (const [key, candidateIds] of candidates) {
    // The live ids for this key.
    const liveIds = candidateIds.filter((id) => live.has(id));
    // Smallest id first, so the drop reason names the same twin on every run.
    if (liveIds.length > 0) twins.set(key, liveIds.sort());
  }
  // The live twins.
  return { ok: true, value: twins };
}

// The deterministic twin for one posting, never the posting's own job (a fingerprint collision can make
// the persisted job an ATS row, and a row must not be dropped as a duplicate of itself).
function pickTwin(twins: ReadonlyMap<string, readonly string[]>, posting: TwinQuery, selfJobId: string | null): string | undefined {
  // The posting's key; null (folds to nothing) never matches.
  const key = twinOf(posting.company, posting.title);
  // No key: no twin.
  if (key === null) return undefined;
  // The first (smallest) live id that is not the job itself.
  return twins.get(key)?.find((id) => id !== selfJobId);
}

// One sweep candidate as read, shape-checked before anything acts on it.
interface SweepRow { readonly id: string; readonly status: string; readonly updated_at: string; readonly jobs: { readonly company_name: string; readonly title: string; readonly ats_provider: string } }

// True only for a row the sweep may move: the right fields, a pre-human status, and an AGGREGATOR job.
function isSweepRow(row: unknown): row is SweepRow {
  // The row itself.
  const r = row as Partial<Record<keyof SweepRow, unknown>> | null;
  // Missing or malformed fields: not a candidate.
  if (!r || typeof r.id !== 'string' || typeof r.status !== 'string' || typeof r.updated_at !== 'string') return false;
  // Re-checked in code: the read filters it, but a status outside the list (approved and later) is never moved.
  if (!(SWEEP_STATUSES as readonly string[]).includes(r.status)) return false;
  // The many-to-one embed is an object.
  const job = r.jobs as { company_name?: unknown; title?: unknown; ats_provider?: unknown } | null | undefined;
  // THE ATS COPY IS NEVER TOUCHED: only a job with ats_provider exactly 'other' is a candidate.
  return !!job && typeof job.company_name === 'string' && typeof job.title === 'string' && job.ats_provider === 'other';
}

// Each feed's parser, keyed like the URL map so the two cannot drift.
const PARSERS: Readonly<Record<RemoteFeed, (body: unknown) => RemoteParse>> = {
  remoteok: parseRemoteOK,
  jobicy: parseJobicy,
  arbeitnow: parseArbeitnow,
};

// Everything a run touches, passed in so a test can supply fakes.
export interface RemoteRunDeps {
  // A signed-in client (RLS applies as the app user).
  readonly client: SupabaseClient;
  // GETs a feed and returns its parsed JSON; THROWS on a non-2xx or unreadable body.
  readonly fetchJson: (url: string) => Promise<unknown>;
  // The run's clock, shared by every row so one run has one first_seen_at.
  readonly now: Date;
  // True: read and screen in memory, write NOTHING (no jobs, no applications, no agent_runs).
  readonly dryRun: boolean;
  // True: discover even while the kill switch is off (submissions stay paused).
  readonly force: boolean;
  // Where progress lines go; console.log in the CLI.
  readonly log: (line: string) => void;
}

// The run's outcome, also used by the CLI to set the exit code.
export interface RemoteRunResult {
  // How the run ended. 'dry_run' is never written anywhere.
  readonly status: 'succeeded' | 'failed' | 'skipped_disabled' | 'dry_run';
  // Feeds that could not be fetched, by name.
  readonly failedFeeds: RemoteFeed[];
  // Postings parsed from the feeds that answered.
  readonly fetched: number;
  // Feed items refused (no title/company or no http(s) apply URL).
  readonly refused: number;
  // Postings left after fingerprint dedupe.
  readonly prepared: number;
  // Screener verdicts (planned, in a dry run).
  readonly passed: number;
  readonly dropped: number;
  // Applications actually created (always 0 in a dry run).
  readonly applications: number;
  // New postings queued at dropped_filter because an ATS twin exists (planned, in a dry run) (T12).
  readonly twinDrops: number;
  // Existing aggregator applications moved to dropped_duplicate (always 0 in a dry run) (T12).
  readonly swept: number;
  // Database write failures, "where: message".
  readonly errors: string[];
}

// Runs the remote scout once.
export async function runRemoteScout(deps: RemoteRunDeps): Promise<RemoteRunResult> {
  // Destructured once for readability below.
  const { client, now, dryRun, log } = deps;
  // Every failed write, recorded rather than thrown so the run still closes honestly.
  const errors: string[] = [];
  // Records one supabase-js error value (it returns errors, it does not throw).
  const noteError = (where: string, error: { message: string } | null): void => {
    // The common case: nothing failed.
    if (!error) return;
    // Logged as it happens, and kept for the run row.
    log(`✗ ${where}: ${error.message}`);
    errors.push(`${where}: ${error.message}`);
  };

  // THE RUN ROW, opened first so a crash leaves a visible stuck row, exactly as scout.ts does.
  // Not in a dry run: a dry run writes nothing, and that includes telemetry.
  let runId: string | null = null;
  // Real runs only.
  if (!dryRun) {
    // agent 'scout_aggregator' is the enum value for tier-3 feeds.
    const { data: runRow, error: runErr } = await client.from('agent_runs').insert({ agent: 'scout_aggregator', status: 'running', started_at: now.toISOString() }).select('id').single();
    // Fatal: a run that cannot record itself would work invisibly.
    if (runErr || !runRow) throw new Error(`could not open agent_runs row: ${runErr?.message ?? 'no row returned'}`);
    // Kept for the close.
    runId = (runRow as { id: string }).id;
  }
  // Closes the run row and CHECKS it landed; a lost close leaves the row 'running' forever.
  const closeRun = async (update: Record<string, unknown>): Promise<void> => {
    // Dry runs never opened one.
    if (runId === null) return;
    // The close itself.
    const { error } = await client.from('agent_runs').update(update).eq('id', runId);
    // Nothing later could report a failure here, so it is thrown.
    if (error) throw new Error(`could not close agent_runs ${runId}: ${error.message}`);
  };

  // The base result, filled in as the run proceeds.
  const result = { failedFeeds: [] as RemoteFeed[], fetched: 0, refused: 0, prepared: 0, passed: 0, dropped: 0, applications: 0, twinDrops: 0, swept: 0, errors };

  // KILL SWITCH, read the way scout.ts reads it: maybeSingle so a missing row is "off"
  // (fail closed), and a read error is a failed run, never mistaken for "switch off".
  const { data: settings, error: settingsErr } = await client.from('system_settings').select('system_enabled').limit(1).maybeSingle();
  // Unknown state: a failed run.
  if (settingsErr) {
    // Recorded on the run row with its reason.
    await closeRun({ status: 'failed', finished_at: new Date().toISOString(), error_count: 1, error_detail: `system_settings read failed: ${settingsErr.message}` });
    // Reported to the CLI too.
    return { ...result, status: 'failed', errors: [`system_settings read failed: ${settingsErr.message}`] };
  }
  // Off unless the row says on.
  const enabled = (settings as { system_enabled?: boolean } | null)?.system_enabled === true;
  // Off and not forced: record the skip and stop.
  if (!enabled && !deps.force) {
    // Said in the log, with how to override it.
    log('⏸️ system_settings.system_enabled is false (kill switch). Pass --force / SCOUT_FORCE=true to discover anyway.');
    // Checked close, so a skip that fails to record reads as a crash rather than as health.
    await closeRun({ status: 'skipped_disabled', finished_at: new Date().toISOString(), error_detail: 'system_settings.system_enabled is false' });
    // Nothing else ran.
    return { ...result, status: 'skipped_disabled' };
  }

  // THE FEEDS, fetched together. A feed that fails is logged and named; the others still run.
  const feeds = Object.keys(REMOTE_FEED_URLS) as RemoteFeed[];
  // One settled result per feed, in feed order.
  const settled = await Promise.allSettled(feeds.map((feed) => deps.fetchJson(REMOTE_FEED_URLS[feed])));
  // Parsed postings from every feed that answered.
  const postings: RemoteJob[] = [];
  // Feed by feed, so each log line names its source.
  settled.forEach((outcome, index) => {
    // The feed this outcome belongs to.
    const feed = feeds[index] as RemoteFeed;
    // An outage or a non-2xx: named, not fatal.
    if (outcome.status === 'rejected') {
      // The reason, for the Actions log.
      log(`⚠️ ${feed} feed failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
      // Counted, so "every feed down" can fail the run below.
      result.failedFeeds.push(feed);
      return;
    }
    // Shape-checked parse; never throws.
    const { jobs, refused } = PARSERS[feed](outcome.value);
    // Per-feed numbers, refusals included, so a feed that went bad is visible.
    log(`${feed}: ${jobs.length} postings, ${refused} refused (no title/company or no http(s) apply URL)`);
    // Tallied for the run.
    result.fetched += jobs.length;
    result.refused += refused;
    // Kept for row building.
    postings.push(...jobs);
  });

  // Rows for every posting, then ONE per fingerprint (a duplicate key inside one statement rejects it whole).
  const built: PreparedJob[] = await Promise.all(postings.map((job) => remotePreparedJob(job, now)));
  // The shared dedupe, which also reports collisions.
  const { kept, collisions } = dedupeByFingerprint(built);
  // Never silent.
  if (collisions > 0) log(`⚠️ ${collisions} posting(s) shared a fingerprint with another; kept one each.`);
  // Tallied.
  result.prepared = kept.length;

  // THE SCREENER'S CONTEXT, loaded once (reads only). A failed load is NOT an empty context:
  // rows are then created at 'discovered', the honest status for an unscreened row, as scout.ts does.
  const screen = await loadScreenContext(supabaseScreenQueries(client, now), now);
  // Rule warnings, de-duplicated across batches.
  const warnings = new Set<string>();
  // Said either way, so "screener off" never looks like "screener passed everything".
  log(screen.ok ? 'screener active: every posting is screened before its queue row exists.' : `⚠️ screener context unavailable (${screen.reason}); rows would be created unscreened at discovered.`);

  // THE BOARDS, read once (a read, so dry runs do it too). A failure is recorded ONCE here and every
  // twin lookup below then answers "unknown", which drops nothing.
  const boards = await loadBoardSlugs(client);
  // Recorded, never silent.
  if (!boards.ok) noteError('ats twin lookup', { message: boards.reason });
  // Twins for some postings, or null when that is unknown (the failure is already recorded).
  const twinLookup = async (postings: readonly TwinQuery[]): Promise<Map<string, string[]> | null> => {
    // No board map: unknown, already recorded above.
    if (!boards.ok) return null;
    // The read.
    const found = await findAtsTwins(client, boards.value, postings);
    // A failed read: recorded per batch, and nothing is dropped for it.
    if (!found.ok) { noteError('ats twin lookup', { message: found.reason }); return null; }
    // The answer.
    return found.value;
  };
  // Aggregator rows only: a feed posting whose apply URL detected an ATS (greenhouse, ...) is not
  // ats_provider 'other', and is left alone here as in the sweep.
  const isAggregator = (row: PreparedJob['row']): boolean => row.ats_provider === 'other';

  // (B) THE SWEEP: aggregator applications queued before their ATS twin existed. Reads in a dry run,
  // moves only in a real one. Every refused move is a run error, never thrown, never silent.
  const sweep = async (): Promise<void> => {
    // Pre-human statuses only, aggregator jobs only (the embed filter), oldest first.
    const { data, error, count } = await client
      // The queue.
      .from('applications')
      // updated_at is the optimistic stamp the RPC compares; the embed brings the job's identity;
      // the exact count shows whether this one page held every candidate.
      .select('id, status, updated_at, jobs!inner(company_name, title, ats_provider)', { count: 'exact' })
      // Never approved or later: those are the human's.
      .in('status', [...SWEEP_STATUSES])
      // Never the ATS copy.
      .eq('jobs.ats_provider', 'other')
      // Oldest first, so a backlog drains in order.
      .order('updated_at', { ascending: true })
      // One page per run.
      .limit(SWEEP_READ_LIMIT);
    // A refused read moves nothing and says so.
    if (error) { noteError('duplicate sweep read', error); return; }
    // Re-checked in code: status list and ats_provider 'other', whatever the read returned.
    // Widened to unknown[] first: supabase-js types the embed as an array, while PostgREST returns a
    // many-to-one embed as an object; isSweepRow checks the real shape, and an array would match nothing.
    const rows = Array.isArray(data) ? (data as unknown[]) : [];
    // More candidates exist than one page holds: newer rows were not looked at this run (see SWEEP_READ_LIMIT).
    // Visible as a run error; the rows that WERE read are still processed below.
    if (typeof count === 'number' && count > rows.length) noteError('duplicate sweep read', { message: `duplicate sweep read truncated (${rows.length} of ${count})` });
    // Only rows the sweep may move.
    const candidates = rows.filter(isSweepRow);
    // Nothing queued from a feed: nothing to look up.
    if (candidates.length === 0) return;
    // Their twins, or unknown.
    const twins = await twinLookup(candidates.map((r) => ({ company: r.jobs.company_name, title: r.jobs.title })));
    // Unknown: nothing moves (already recorded).
    if (!twins) return;
    // The rows with a live twin, each paired with that twin's id.
    const moves: Array<{ row: SweepRow; twin: string }> = [];
    // Row by row, oldest first, stopping at the cap.
    for (const row of candidates) {
      // Enough for this run: the rest wait for the next one.
      if (moves.length >= SWEEP_CAP) break;
      // selfJobId null: an aggregator job is never in the employer-ATS-only twin read.
      const twin = pickTwin(twins, { company: row.jobs.company_name, title: row.jobs.title }, null);
      // Only rows with a live twin move.
      if (twin) moves.push({ row, twin });
    }
    // A dry run only counts.
    if (dryRun) { log(`DRY RUN: duplicate sweep would move ${moves.length} aggregator application(s) to dropped_duplicate.`); return; }
    // One RPC per row; sequential so a failure storm stays readable and the database is not flooded.
    for (const { row, twin } of moves) {
      // Asserted again at the call site: the ATS copy is never moved.
      if (row.jobs.ats_provider !== 'other') continue;
      // The same RPC the gateway uses (supabase-gateway.ts advanceStatus), plus the stamp so a row changed since the read is refused.
      const { error: moveErr } = await client.rpc('advance_application_status', {
        // The aggregator application.
        p_application_id: row.id,
        // Its twin is already in the pipeline.
        p_to_status: 'dropped_duplicate',
        // The enum value for this scout.
        p_agent: 'scout_aggregator',
        // The event says why and which twin.
        p_detail: { reason: 'duplicate_of_ats', ats_job_id: twin },
        // Exactly as read, never parsed.
        p_expected_updated_at: row.updated_at,
      });
      // Refused (e.g. 23514 until the edge migration is live): recorded, the next row still tries.
      if (moveErr) noteError(`duplicate sweep ${row.id}`, moveErr);
      // Counted only when it landed.
      else result.swept += 1;
    }
  };

  // DRY RUN: screen in memory (the fingerprint stands in for the job id) and stop before any write.
  if (dryRun) {
    // (A) counted: the aggregator postings that would be queued as ATS duplicates.
    const aggregatorRows = kept.map((j) => j.row).filter(isAggregator);
    // Read only when there is something to ask about.
    const twins = aggregatorRows.length > 0 ? await twinLookup(aggregatorRows.map((r) => ({ company: r.company_name, title: r.title }))) : null;
    // No job ids exist yet, so nothing can be excluded as "self".
    if (twins) result.twinDrops = aggregatorRows.filter((r) => pickTwin(twins, { company: r.company_name, title: r.title }, null) !== undefined).length;
    // Said either way.
    log(`DRY RUN: ${result.twinDrops} posting(s) have an ATS twin and would be queued at dropped_filter.`);
    // (B) counted.
    await sweep();
    // Only possible with a context; otherwise there is nothing to plan.
    if (screen.ok) {
      // The same plan a real run would make.
      const plan = planScreenedApplications(kept.map((j) => ({ jobId: j.row.fingerprint, row: j.row })), screen.value.rules, screen.value.context, screen.value.preferences);
      // Planned verdicts, reported as such.
      result.passed = plan.passedCount;
      result.dropped = plan.droppedCount;
      // Collected for the summary.
      for (const w of plan.warnings) warnings.add(w);
    }
    // The whole answer of a dry run.
    log(`DRY RUN: ${result.prepared} postings would be written; screener would pass ${result.passed} and drop ${result.dropped}. Nothing was written.`);
    for (const w of warnings) log(`⚠️ screener warning: ${w}`);
    // No close: no run row was opened.
    return { ...result, status: 'dry_run' };
  }

  // LOUD FALLBACK (W12, 2026-11-02): an unscreened real run is a counted error named
  // `screener_not_run`, so it closes `failed` and the CLI exits 1, where it used to close
  // `succeeded` over rows nothing screens on a schedule. Same label as scout.ts's close
  // (worker/src/scout/run-outcome.ts). The rows are still written below: discovery is kept.
  if (!screen.ok) noteError('screener_not_run', { message: screen.reason });

  // REAL RUN: write in batches, each through the shared persist path and the screener.
  for (let i = 0; i < kept.length; i += BATCH_SIZE) {
    // One batch of prepared postings.
    const slice = kept.slice(i, i + BATCH_SIZE);
    // Insert-new / refresh-existing; first_seen_at stays write-once.
    const persisted = await persistJobBatch(client, slice, now);
    // Every persist failure is a run error.
    for (const message of persisted.errors) noteError('persist jobs', { message });
    // Pair each persisted job with its row; unresolved ids are skipped, never guessed.
    const entries = slice.map((j) => j.row).filter((row) => persisted.idByFingerprint.has(row.fingerprint)).map((row) => ({ jobId: persisted.idByFingerprint.get(row.fingerprint) as string, row }));
    // Nothing persisted in this batch: nothing to queue.
    if (entries.length === 0) continue;
    // THE SEAM: screened before the queue row exists, or 'discovered' when the screener could not run.
    let inserts: ReadonlyArray<{ job_id: string; status: string; drop_reason: string | null }>;
    // With a context: the shared screener decides.
    if (screen.ok) {
      // The plan.
      const plan = planScreenedApplications(entries, screen.value.rules, screen.value.context, screen.value.preferences);
      // Tallied for the run.
      result.passed += plan.passedCount;
      result.dropped += plan.droppedCount;
      // Collected for the run row.
      for (const w of plan.warnings) warnings.add(w);
      // Rows at passed_filters / dropped_filter.
      inserts = plan.inserts;
    } else {
      // The honest fallback, identical to scout.ts.
      inserts = entries.map((e) => ({ job_id: e.jobId, status: 'discovered', drop_reason: null }));
    }
    // (A) ATS TWINS: the aggregator entries of this batch.
    const aggregatorEntries = entries.filter((e) => isAggregator(e.row));
    // Looked up only when there are any; null means unknown (recorded) and drops nothing.
    const twins = aggregatorEntries.length > 0 ? await twinLookup(aggregatorEntries.map((e) => ({ company: e.row.company_name, title: e.row.title }))) : null;
    // With an answer, the twin reason overrides whatever the screener planned, so the event says why.
    if (twins) {
      // job id -> its twin's id, for the entries that have one.
      const twinByJob = new Map<string, string>();
      // Entry by entry, never naming the job itself as its own twin.
      for (const e of aggregatorEntries) {
        // The entry's live twin, if any.
        const twin = pickTwin(twins, { company: e.row.company_name, title: e.row.title }, e.jobId);
        // Remembered only when there is one.
        if (twin) twinByJob.set(e.jobId, twin);
      }
      // dropped_filter is an allowed insert status (guard_status_insert); the job row itself stays persisted.
      inserts = inserts.map((ins) => {
        // This insert's twin, if its job has one.
        const twin = twinByJob.get(ins.job_id);
        // No twin: the screener's plan stands.
        if (!twin) return ins;
        // A twin: the reason names it, so the event says why.
        return { ...ins, status: 'dropped_filter', drop_reason: `duplicate_of_ats:${twin}` };
      });
      // Tallied separately from the screener's own verdicts.
      result.twinDrops += twinByJob.size;
    }
    // ignoreDuplicates: a job already queued keeps its existing application and status.
    const { data: apps, error: appErr } = await client.from('applications').upsert(inserts as never, { onConflict: 'user_id,job_id', ignoreDuplicates: true }).select('id');
    // A refused insert means screened jobs never reached the queue: a run error.
    noteError('upsert applications', appErr);
    // Only rows actually created come back.
    if (!appErr && apps) result.applications += apps.length;
  }

  // (B) after every batch, so this run's own inserts are not re-read as candidates mid-loop.
  await sweep();

  // Every feed down is a failed run, not a quiet success with zero rows.
  const allFeedsDown = result.failedFeeds.length === feeds.length;
  // The summary the Actions log shows.
  log(`fetched ${result.fetched}, refused ${result.refused}, kept ${result.prepared}; screener passed ${result.passed}, dropped ${result.dropped}; ${result.twinDrops} queued as ATS duplicates; ${result.swept} swept to dropped_duplicate; ${result.applications} new applications; ${errors.length} write error(s).`);
  // HONEST CLOSE: any write error or a total feed outage makes the run 'failed'.
  const status = errors.length > 0 || allFeedsDown ? 'failed' : 'succeeded';
  // The detail names the cause; rule warnings ride along as on every screening run.
  const detail = allFeedsDown ? ['every remote feed failed', ...errors] : errors;
  // Checked close.
  await closeRun({ status, finished_at: new Date().toISOString(), rows_in: result.prepared, rows_out: result.applications, error_count: errors.length, error_detail: withRuleWarnings(detail.length > 0 ? detail.slice(0, 20).join('\n') : null, warnings) });
  // The result for the CLI's exit code.
  return { ...result, status };
}
