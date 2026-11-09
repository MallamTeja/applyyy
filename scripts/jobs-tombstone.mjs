// scripts/jobs-tombstone.mjs — the weekly jobs TOMBSTONE run (Teja, 2026-11-05 15:31).
//
// WHAT IT DOES: signs in as the app user, opens an agent_runs row (agent 'jobs_tombstone'),
// calls public.tombstone_dropped_jobs(min_age_days, batch_size) until it returns 0 or a
// batch cap is hit, then closes the run with the count. The SQL function does the real
// work and every guard (dropped_filter only, bounded batch, SKIP LOCKED); see migration
// 20261105200000 and docs/db/2026-11-05-jobs-tombstone-policy.md.
//
// WHY PLAIN fetch AND NO supabase-js: Node 24 ships fetch, so the workflow needs no
// `pnpm install` (no lockfile, no 2-minute install for three HTTP calls), and the REST
// shapes used here (password grant, POST/PATCH a row, POST an RPC) are stable public API.
//
// WHY THE APP USER AND NOT THE SERVICE ROLE: same rule as keepalive.yml. No workflow holds
// an RLS-bypassing key; RLS ("own jobs") scopes the function to the app user's rows.

// Turns argv[1] into a URL, so the "run as a script" check below works on Windows paths.
import { pathToFileURL } from "node:url";

// The smallest batch the run will shrink to after statement timeouts. Below this, a timeout
// is not "the batch is too big" any more; it is a slow or sick database, and the run fails
// loudly instead of crawling through 50 one-row calls.
export const MIN_BATCH_SIZE = 25;

// Thrown by the RPC caller when PostgreSQL cancelled the call for statement_timeout (SQLSTATE
// 57014). A distinct class, so runBatches can tell "too big, retry smaller" from every other
// failure, which must still end the run.
export class StatementTimeoutError extends Error {}

// Is this failed PostgREST response a statement timeout? Reads the SHAPE (CLAUDE.md §6): the
// body must parse as JSON and carry code "57014". A substring match on the raw text would also
// fire on, say, a 57014 that appears inside some other error's message.
export function isStatementTimeout(bodyText) {
  // A non-JSON body (an HTML gateway page, an empty 502) is some other failure.
  try {
    // PostgREST error bodies are a JSON object with a `code` field.
    const body = JSON.parse(bodyText);
    // Exactly the statement_timeout SQLSTATE, and only on an object.
    return body !== null && typeof body === "object" && body.code === "57014";
  } catch {
    // Unparseable: not a timeout we know how to recover from.
    return false;
  }
}

// Call `callBatch(size)` until it reports 0 rows or `maxBatches` calls have been made.
//
// STOPS ONLY ON 0, NOT ON "FEWER THAN THE BATCH SIZE": under SKIP LOCKED a batch can come
// back short while more rows remain, so a short batch is not proof the backlog is empty.
//
// HALVES THE BATCH ON A STATEMENT TIMEOUT (2026-11-08 failure, run 42486953107): the API role
// `authenticated` runs with statement_timeout=8s, and the first real 1000-row batch through it
// was cancelled. A cancelled call rolls its whole transaction back, so nothing was half-written
// and retrying smaller is safe. The timed-out call still counts toward the cap, so a database
// that times out on everything cannot loop forever.
// Exported so the test can drive it with a fake, with no network.
export async function runBatches(callBatch, maxBatches, batchSize) {
  // A missing or bad starting size would make the halving below produce NaN batches.
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`runBatches needs a positive integer batch size, got ${JSON.stringify(batchSize)}`);
  // Rows tombstoned across every call this run.
  let total = 0;
  // The size the next call asks for; only ever shrinks, on a timeout.
  let size = batchSize;
  // One call per iteration, never more than the cap: a runaway loop is a cost, not a fix.
  for (let calls = 1; calls <= maxBatches; calls++) {
    // The call's answer, or undefined when it timed out and we retry smaller.
    let n;
    // One bounded batch on the database side.
    try {
      // The RPC with this call's batch size.
      n = await callBatch(size);
    } catch (err) {
      // Any failure other than a timeout ends the run: it is not a sizing problem.
      if (!(err instanceof StatementTimeoutError)) throw err;
      // Already at the floor: shrinking further would hide a sick database, so fail.
      if (size <= MIN_BATCH_SIZE) throw new Error(`tombstone_dropped_jobs timed out even at batch ${size}: ${err.message}`);
      // Halve, but never below the floor.
      size = Math.max(MIN_BATCH_SIZE, Math.floor(size / 2));
      // Say so in the Actions log, so a shrinking run is visible, not silent.
      console.log(`[jobs-tombstone] statement timeout; retrying with batch ${size}`);
      // Next call, smaller.
      continue;
    }
    // Validate the SHAPE (CLAUDE.md §6): a non-integer or negative answer is a broken
    // contract, and treating it as 0 would end the run "drained" on garbage.
    if (!Number.isInteger(n) || n < 0) throw new Error(`tombstone_dropped_jobs returned ${JSON.stringify(n)}, not a row count`);
    // Count what this call did.
    total += n;
    // Nothing left to tombstone: done, and say so (with the size it ended on).
    if (n === 0) return { total, calls, drained: true, batch: size };
  }
  // The cap was hit with work possibly left; next week's run (or a manual one) continues.
  return { total, calls: maxBatches, drained: false, batch: size };
}

// Read a positive integer setting, or its default when unset.
//
// A STRICT DIGITS CHECK, NOT Number(): Number("") is 0 and Number(" 7 ") is 7, so a blank
// workflow input would silently become a zero-day window. Anything else is refused.
export function positiveInt(name, raw, fallback) {
  // Unset or empty means "use the default", which is a decision the workflow made visibly.
  if (raw === undefined || raw === "") return fallback;
  // Only plain digits; no signs, spaces, decimals or exponents.
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  // Safe now: the string is digits only.
  const value = Number(raw);
  // Zero is a positive-integer spelling of "do nothing"; refuse it like the SQL function does.
  if (value < 1) throw new Error(`${name} must be >= 1, got ${value}`);
  // A validated setting.
  return value;
}

// A required secret from the step's env; a missing one is a loud failure, never a no-op run.
function required(name) {
  // Read it once.
  const value = process.env[name];
  // Empty counts as missing: an unset GitHub secret arrives as "".
  if (!value) throw new Error(`missing required env ${name}`);
  // Present.
  return value;
}

// Throw with the response body when a REST call fails, so the Actions log says why.
async function ok(res, what) {
  // 2xx is success for every call made here.
  if (res.ok) return res;
  // The PostgREST / GoTrue error body names the cause (e.g. permission denied, timeout).
  throw new Error(`${what} failed: HTTP ${res.status} ${await res.text()}`);
}

// The real run: sign in, open a run row, loop, close the run row.
async function main() {
  // Project URL, without a trailing slash so the paths below join cleanly.
  const url = required("SUPABASE_URL").replace(/\/+$/, "");
  // The public anon key; every request carries it as `apikey`.
  const anon = required("SUPABASE_ANON_KEY");
  // Grace window in days: drops younger than this keep their text (default 7, see the doc).
  const minAgeDays = positiveInt("MIN_AGE_DAYS", process.env.MIN_AGE_DAYS, 7);
  // Rows per call. 250, not 1000: 1000 rows overran the API role's 8 s statement_timeout on
  // 2026-11-08 (the pick query is ~46 ms; the cost is the UPDATE). runBatches halves further
  // on a timeout, so this is a starting point, not a promise.
  const batchSize = positiveInt("BATCH_SIZE", process.env.BATCH_SIZE, 250);
  // Calls per run: 50 x 250 = 12,500 covers ~2-3x a normal week's drops (500-1,000 a day).
  const maxBatches = positiveInt("MAX_BATCHES", process.env.MAX_BATCHES, 50);

  // Password grant for the app user, exactly the identity keepalive.yml uses.
  const auth = await ok(await fetch(`${url}/auth/v1/token?grant_type=password`, {
    // GoTrue's sign-in endpoint is a POST.
    method: "POST",
    // apikey routes the request to the project; JSON body.
    headers: { apikey: anon, "content-type": "application/json" },
    // The credentials, read from step-scoped secrets.
    body: JSON.stringify({ email: required("APPLYY_APP_USER_EMAIL"), password: required("APPLYY_APP_USER_PASSWORD") }),
  }), "sign-in");
  // The user's JWT; RLS evaluates every call below as this user.
  const { access_token: token } = await auth.json();
  // A 200 without a token is a contract break, not a signed-in session.
  if (typeof token !== "string" || token === "") throw new Error("sign-in returned no access_token");
  // Headers every PostgREST call shares.
  const headers = { apikey: anon, authorization: `Bearer ${token}`, "content-type": "application/json" };

  // Open the run row FIRST, so a crash mid-run leaves a visible `running` row instead of
  // nothing (the Health page reads "no row" exactly like "cron is dead").
  const opened = await ok(await fetch(`${url}/rest/v1/agent_runs?select=id`, {
    // Insert one row.
    method: "POST",
    // Ask for the inserted id back.
    headers: { ...headers, prefer: "return=representation" },
    // Its own identity (migration 20261105201000), never a borrowed one.
    body: JSON.stringify({ agent: "jobs_tombstone", status: "running" }),
  }), "open agent_runs");
  // PostgREST returns an array of the inserted rows.
  const [run] = await opened.json();
  // No id means every later close would write to nothing.
  if (!run || typeof run.id !== "string") throw new Error("agent_runs insert returned no id");

  // Closes the run row; a failed close is thrown, because nothing later could report it.
  const close = async (fields) => ok(await fetch(`${url}/rest/v1/agent_runs?id=eq.${run.id}`, {
    // Update the one row by id.
    method: "PATCH",
    // Shared auth headers.
    headers,
    // Status, finish time and counts.
    body: JSON.stringify({ finished_at: new Date().toISOString(), ...fields }),
  }), "close agent_runs");

  // The loop, with errors recorded on the run row before the process exits non-zero.
  try {
    // One RPC per batch, at the size runBatches picks.
    const result = await runBatches(async (size) => {
      // The function returns the integer row count as the JSON body.
      const res = await fetch(`${url}/rest/v1/rpc/tombstone_dropped_jobs`, {
        // RPCs are POSTs.
        method: "POST",
        // Shared auth headers.
        headers,
        // Named arguments matching the SQL signature.
        body: JSON.stringify({ p_min_age_days: minAgeDays, p_batch_size: size }),
      });
      // Success: runBatches validates the shape of the count.
      if (res.ok) return res.json();
      // The body is read once, for both the timeout check and the error message.
      const text = await res.text();
      // A statement timeout is "batch too big": runBatches retries smaller.
      if (isStatementTimeout(text)) throw new StatementTimeoutError(`HTTP ${res.status} ${text}`);
      // Anything else ends the run with the cause in the log, as ok() does.
      throw new Error(`tombstone_dropped_jobs failed: HTTP ${res.status} ${text}`);
    }, maxBatches, batchSize);
    // The run's outcome, in the log as well as the row; batch shows where any halving ended.
    console.log(`[jobs-tombstone] tombstoned ${result.total} rows in ${result.calls} calls (min_age_days=${minAgeDays}, start_batch=${batchSize}, end_batch=${result.batch}, drained=${result.drained})`);
    // A capped run still succeeded; error_detail says more remain so the Health page shows it.
    await close({ status: "succeeded", rows_out: result.total, error_detail: result.drained ? null : `batch cap ${maxBatches} hit; more rows remain` });
  } catch (err) {
    // The message, for both the row and the log.
    const detail = err instanceof Error ? err.message : String(err);
    // Recorded as a failure, never a success over an error.
    await close({ status: "failed", error_count: 1, error_detail: detail });
    // Re-thrown so the workflow run is red.
    throw err;
  }
}

// Run only when executed directly, so the test can import runBatches/positiveInt freely.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Any failure exits non-zero, which turns the Actions run red.
  main().catch((err) => {
    // The cause, for the Actions log.
    console.error(`[jobs-tombstone] ${err instanceof Error ? err.message : err}`);
    // Non-zero so the failure is visible on the workflow.
    process.exit(1);
  });
}
