// One remote-scout run: the feeds in, screened applications out, through the SAME path the
// ATS scout uses (worker/src/cli/scout.ts): dedupe by fingerprint, persistJobBatch, the
// shared screener, checked writes and an honest agent_runs close.
//
// WHY IT IS A FUNCTION WITH INJECTED DEPENDENCIES. The CLI runs main() on import and cannot
// be tested; this can. worker/test/remote-run.test.ts drives it with a recording client to
// prove the property the scheduled workflow relies on: a dry run performs ZERO writes.
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

// Rows per write, the same size scout.ts uses.
const BATCH_SIZE = 50;

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
  const result = { failedFeeds: [] as RemoteFeed[], fetched: 0, refused: 0, prepared: 0, passed: 0, dropped: 0, applications: 0, errors };

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

  // DRY RUN: screen in memory (the fingerprint stands in for the job id) and stop before any write.
  if (dryRun) {
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
    // ignoreDuplicates: a job already queued keeps its existing application and status.
    const { data: apps, error: appErr } = await client.from('applications').upsert(inserts as never, { onConflict: 'user_id,job_id', ignoreDuplicates: true }).select('id');
    // A refused insert means screened jobs never reached the queue: a run error.
    noteError('upsert applications', appErr);
    // Only rows actually created come back.
    if (!appErr && apps) result.applications += apps.length;
  }

  // Every feed down is a failed run, not a quiet success with zero rows.
  const allFeedsDown = result.failedFeeds.length === feeds.length;
  // The summary the Actions log shows.
  log(`fetched ${result.fetched}, refused ${result.refused}, kept ${result.prepared}; screener passed ${result.passed}, dropped ${result.dropped}; ${result.applications} new applications; ${errors.length} write error(s).`);
  // HONEST CLOSE: any write error or a total feed outage makes the run 'failed'.
  const status = errors.length > 0 || allFeedsDown ? 'failed' : 'succeeded';
  // The detail names the cause; rule warnings ride along as on every screening run.
  const detail = allFeedsDown ? ['every remote feed failed', ...errors] : errors;
  // Checked close.
  await closeRun({ status, finished_at: new Date().toISOString(), rows_in: result.prepared, rows_out: result.applications, error_count: errors.length, error_detail: withRuleWarnings(detail.length > 0 ? detail.slice(0, 20).join('\n') : null, warnings) });
  // The result for the CLI's exit code.
  return { ...result, status };
}
