// Tests for the Gemini key pool client.
//
// THE PROPERTY THAT MATTERS MOST HERE is that the two NULLs are told apart.
// `claim_gemini_key()` returns NULL for two situations demanding OPPOSITE responses —
// "all keys are cooling" (normal, self-healing, should not even be logged as unusual)
// and "no keys exist at all" (the pipeline is quietly dead and needs a human). The SQL
// cannot distinguish them. If this module does not, the system loses the ability to
// tell waiting from death, and the second one presents as the §14 silent stop.
import { test } from "node:test";
// Strict, so a `false` verdict never compares equal to a reason string.
import assert from "node:assert/strict";
// Extension-suffixed specifier for Deno/Node convergence. `SupabaseClient` is a
// type-only import inside pool.ts, so it is erased and `node --test` never has to
// resolve the `jsr:` specifier.
import { claimKey, discoverConfiguredKeyIndices, parseRetryAfterSeconds, reportResult } from "./pool.ts";

// A stand-in for the Supabase client.
//
// A HAND-ROLLED FAKE RATHER THAN A MOCKING LIBRARY, because the surface being faked
// is two methods and the fake is then readable at a glance — and because a fake whose
// behaviour is visible in the test file cannot silently disagree with what the test
// claims it does.
function fakeClient(options: {
  // What `rpc('claim_gemini_key')` resolves to.
  readonly claim?: { data: unknown; error: { message: string } | null };
  // How many rows `gemini_key_state` reports. Only consulted on the NULL path.
  readonly keyRowCount?: number;
  // Force the count query to fail, to exercise the un-disambiguatable case.
  readonly countError?: string;
  // Collects every rpc call so a test can assert what was sent.
  readonly calls?: Array<{ fn: string; args: unknown }>;
}) {
  return {
    // Stands in for `db.rpc(...)`.
    rpc(fn: string, args?: unknown) {
      // Record the call for assertions about `report_gemini_result`.
      options.calls?.push({ fn, args });
      // The claim path.
      if (fn === "claim_gemini_key") return Promise.resolve(options.claim ?? { data: null, error: null });
      // Everything else succeeds silently.
      return Promise.resolve({ data: null, error: null });
    },
    // Stands in for `db.from('gemini_key_state').select(...)`.
    from() {
      return {
        select() {
          // A forced failure, for the case where the two NULLs cannot be separated.
          if (options.countError !== undefined) return Promise.resolve({ count: null, error: { message: options.countError } });
          // Otherwise report the configured row count.
          return Promise.resolve({ count: options.keyRowCount ?? 0, error: null });
        },
      };
    },
    // The real client has far more on it; the cast is confined to this one helper so
    // no production code ever sees a partial client.
  } as unknown as Parameters<typeof claimKey>[0];
}

// A fake key reader, supplied through the pool's dependency seam.
//
// INJECTED RATHER THAN SET IN THE ENVIRONMENT, and that is the point of the seam:
// `Deno.env` does not exist under `node --test`, so a pool that read it directly
// could only be tested by running a second test runner. Passing the reader in keeps
// the two-NULLs logic — the thing most worth covering — in the same suite as
// everything else, and makes each test state its own key configuration locally
// instead of mutating global state a later test might inherit.
function keysFrom(available: Readonly<Record<number, string>>) {
  return (index: number): string | null => available[index] ?? null;
}

// The reader for a runtime with no keys configured at all.
const NO_KEYS = keysFrom({});

// --- THE TWO NULLS ---------------------------------------------------------------

// The normal case. Keys exist, all of them are cooling or the budget is spent. This
// must be reported as an ordinary condition, NOT as an error — a health page that
// cries wolf about routine quota behaviour is a page Teja stops reading, which is the
// same failure mode as an over-eager human-review queue.
test("NULL with keys present reports all_keys_cooling", async () => {
  // Claim returns NULL; three key rows exist.
  const result = await claimKey(fakeClient({ claim: { data: null, error: null }, keyRowCount: 3 }));
  // Not a claim.
  assert.equal(result.ok, false);
  if (result.ok) return;
  // And specifically the benign reason.
  assert.equal(result.reason, "all_keys_cooling");
});

// The dangerous case — NO LONGER production state (CORRECTED 2026-10-24:
// `applyy_internal.seed_user_defaults` has seeded `gemini_key_state` on signup since
// `20261009150000`; live rows re-measured today). A mis-provisioned account can still
// hit an empty pool: every agent then dutifully releases its claim and the pipeline
// looks merely idle with no error anywhere — the exact §14 silent stop this guards.
test("NULL with an empty pool reports no_keys_configured", async () => {
  // Claim returns NULL; zero key rows.
  const result = await claimKey(fakeClient({ claim: { data: null, error: null }, keyRowCount: 0 }));
  // Not a claim.
  assert.equal(result.ok, false);
  if (result.ok) return;
  // The reason that needs a human.
  assert.equal(result.reason, "no_keys_configured");
});

// THE DISCRIMINATING PAIR, asserted together so a future refactor that collapses the
// two branches back into one NULL cannot pass. If these two ever return the same
// reason, the module has stopped doing the only thing it exists to do.
test("the two NULL cases are genuinely distinguished, not merely both reported", async () => {
  // Empty pool.
  const empty = await claimKey(fakeClient({ claim: { data: null, error: null }, keyRowCount: 0 }));
  // Populated but cooling.
  const cooling = await claimKey(fakeClient({ claim: { data: null, error: null }, keyRowCount: 6 }));
  // Both refused.
  assert.equal(empty.ok, false);
  assert.equal(cooling.ok, false);
  if (empty.ok || cooling.ok) return;
  // And refused DIFFERENTLY, which is the whole point.
  assert.notEqual(empty.reason, cooling.reason);
});

// When the pool cannot even be counted, guessing which NULL this was would send a
// human to look at the wrong thing. Reporting the uncertainty is better than a
// confident wrong answer.
test("a failed count reports claim_failed rather than guessing which NULL it was", async () => {
  // Claim NULL and the count query errors.
  const result = await claimKey(fakeClient({ claim: { data: null, error: null }, countError: "permission denied" }));
  // Refused.
  assert.equal(result.ok, false);
  if (result.ok) return;
  // As a genuine failure, not as either quota reason.
  assert.equal(result.reason, "claim_failed");
});

// --- the scalar return shape ------------------------------------------------------

// `claim_gemini_key()` is `returns smallint`, so PostgREST yields a BARE NUMBER.
// `tables.ts` declares `{ key_index: number }` and is wrong. Reading `data.key_index`
// would be `undefined` on every call and would present as a permanently empty pool —
// an error whose symptom is indistinguishable from the normal cooling case.
test("a claimed key is read from a bare number, not from an object property", async () => {
  // The SQL hands back the index itself.
  const claim = await claimKey(fakeClient({ claim: { data: 4, error: null } }), keysFrom({ 4: "test-key-value-04" }));
  // Claimed.
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  // Both halves came through.
  assert.equal(claim.index, 4);
  assert.equal(claim.apiKey, "test-key-value-04");
});

// The database believing in a key the runtime cannot see is a THIRD condition,
// distinct from both NULLs: the pool is neither exhausted nor unconfigured, the
// environment is simply out of step with `gemini_key_state`.
test("a claimed index with no environment variable is its own distinct failure", async () => {
  // Index 7 claimed, but nothing configured for it.
  const claim = await claimKey(fakeClient({ claim: { data: 7, error: null } }), NO_KEYS);
  // Refused.
  assert.equal(claim.ok, false);
  if (claim.ok) return;
  // Named so the fix is obvious, and carrying the index so it is actionable.
  assert.equal(claim.reason, "key_env_missing");
  assert.equal(claim.reason === "key_env_missing" && claim.index, 7);
});

// A key index of zero must not be mistaken for absence. `if (!data)` would treat it as
// NULL, which is the classic falsy-zero bug — and it would silently disable one key.
test("key index 0 is treated as a claim, not as a null", async () => {
  // Index 0 with a value configured.
  const result = await claimKey(fakeClient({ claim: { data: 0, error: null } }), keysFrom({ 0: "zero-index-key" }));
  // Claimed, not refused. `if (!data)` would have treated 0 as absent — the classic
  // falsy-zero bug, and here it would silently disable one key out of six.
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.index, 0);
});

// A failure of the RPC itself is a genuine error and must not be laundered into a
// quota reason — that would hide a broken database behind "we are just waiting".
test("an RPC error reports claim_failed with the message", async () => {
  // The call itself fails.
  const result = await claimKey(fakeClient({ claim: { data: null, error: { message: "connection reset" } } }));
  // Refused as an error.
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "claim_failed");
  assert.equal(result.reason === "claim_failed" && result.detail, "connection reset");
});

// --- reporting back ----------------------------------------------------------------

// Reporting unconditionally is what makes the pool reactive. Skipping the report on
// success would leave `consecutive_failures` permanently non-zero after one bad call,
// so the streak would stop meaning "currently broken" and start meaning "has ever
// failed" — a metric that only ever goes up is not a signal.
test("a success is reported with no cooldown and no error text", async () => {
  // Capture the outgoing call.
  const calls: Array<{ fn: string; args: unknown }> = [];
  // Report a success.
  await reportResult(fakeClient({ calls }), 3, true);
  // One call, to the right function.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.fn, "report_gemini_result");
  // With the expected arguments, and critically a NULL retry_after: a success must
  // not idle the key it just used.
  assert.deepEqual(calls[0]?.args, { p_key_index: 3, p_success: true, p_retry_after_seconds: null, p_error: null });
});

// A non-quota failure must NOT set a cooldown. Idling a working key because a
// response failed to parse would shrink the pool for a reason unrelated to quota.
test("a non-quota failure reports without a cooldown", async () => {
  // Capture.
  const calls: Array<{ fn: string; args: unknown }> = [];
  // A parse failure, with no retry_after.
  await reportResult(fakeClient({ calls }), 2, false, null, "malformed JSON");
  // Cooldown left null so the SQL leaves the existing one alone.
  assert.deepEqual(calls[0]?.args, { p_key_index: 2, p_success: false, p_retry_after_seconds: null, p_error: "malformed JSON" });
});

// --- retry_after parsing -----------------------------------------------------------
//
// BELIEVE THE SERVER, NEVER INVENT A BACKOFF. Google's own value is the only
// trustworthy number available, because they no longer publish the limits any
// invented backoff would be guessing at.

// The plain form.
test("a numeric Retry-After header is read as seconds", () => {
  // Standard delay-seconds form.
  const response = new Response(null, { status: 429, headers: { "retry-after": "42" } });
  // Read straight through.
  assert.equal(parseRetryAfterSeconds(response), 42);
});

// The HTTP-date form is equally legal and a header-only integer parse would miss it.
test("an HTTP-date Retry-After header is converted to a delay", () => {
  // Sixty seconds in the future.
  const future = new Date(Date.now() + 60_000).toUTCString();
  // Build the response.
  const response = new Response(null, { status: 429, headers: { "retry-after": future } });
  // Parsed.
  const seconds = parseRetryAfterSeconds(response);
  // Allow a second of slack for the clock moving between construction and parse.
  assert.equal(seconds !== null && seconds > 55 && seconds <= 61, true);
});

// A date already in the past must not produce a negative cooldown, which would set
// `cooldown_until` in the past and make the key look permanently available.
test("a past HTTP-date Retry-After yields null rather than a negative delay", () => {
  // An hour ago.
  const past = new Date(Date.now() - 3_600_000).toUTCString();
  // Build.
  const response = new Response(null, { status: 429, headers: { "retry-after": past } });
  // Declined rather than negative.
  assert.equal(parseRetryAfterSeconds(response), null);
});

// GOOGLE PUTS THE DELAY IN THE BODY, NOT THE HEADER, on exactly the responses that
// matter. A header-only implementation would return null for every real 429 and the
// pool would never set a cooldown — it would retry the exhausted key immediately,
// forever, which is the opposite of reactive.
test("a RetryInfo detail in the JSON body is read when the header is absent", () => {
  // No header at all.
  const response = new Response(null, { status: 429 });
  // Google's documented error shape.
  const body = {
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      details: [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" },
      ],
    },
  };
  // Recovered from the body.
  assert.equal(parseRetryAfterSeconds(response, body), 37);
});

// A fractional duration is legal in the protobuf duration format.
test("a fractional RetryInfo delay is floored to whole seconds", () => {
  // "12.5s".
  const body = { error: { details: [{ retryDelay: "12.5s" }] } };
  // Whole seconds is what `make_interval(secs => …)` wants.
  assert.equal(parseRetryAfterSeconds(new Response(null, { status: 429 }), body), 12);
});

// When the server says nothing, we must NOT invent a number — the SQL then leaves the
// existing cooldown alone rather than idling a key on a guess.
test("no header and no body detail yields null rather than an invented backoff", () => {
  // Nothing to go on.
  assert.equal(parseRetryAfterSeconds(new Response(null, { status: 429 })), null);
  // And a body of the wrong shape is equally declined.
  assert.equal(parseRetryAfterSeconds(new Response(null, { status: 429 }), { error: "rate limited" }), null);
});

// A malformed body must not throw — this runs on an error path, so it is precisely
// the response least likely to have the structure we expect.
test("a malformed error body is handled without throwing", () => {
  // Several shapes that would break a naive accessor chain.
  for (const body of [null, undefined, 42, "text", { error: null }, { error: { details: "not an array" } }, { error: { details: [null, 7] } }]) {
    // Must return null rather than raising.
    assert.equal(parseRetryAfterSeconds(new Response(null, { status: 429 }), body), null);
  }
});

// --- key discovery ------------------------------------------------------------

// THE ZERO-PADDING BUG APPEARS AT EXACTLY TEN KEYS, i.e. never during development.
// Discovery must return numeric order, not string order, or key 10 would be tried
// before key 2 and the LRU ordering in SQL would be fed a scrambled index space.
test("discovery returns indices in numeric order, not string order", () => {
  // A configuration that would sort wrongly as strings.
  const reader = keysFrom({ 1: "a", 2: "b", 10: "c", 11: "d" });
  // Scanned.
  assert.deepEqual([...discoverConfiguredKeyIndices(reader)], [1, 2, 10, 11]);
});

// A GAP MUST NOT TERMINATE THE SCAN. Stopping at the first missing index would mean
// removing key 3 silently disables keys 4, 5 and 6 — a five-sixths capacity loss
// whose only symptom is quota running out sooner.
test("a gap in the key sequence does not hide later keys", () => {
  // Index 3 deliberately absent.
  const reader = keysFrom({ 1: "a", 2: "b", 4: "d", 6: "f" });
  // All present keys found regardless of the hole.
  assert.deepEqual([...discoverConfiguredKeyIndices(reader)], [1, 2, 4, 6]);
});

// THE POOL MUST BE CORRECT WITH EXACTLY ONE KEY. Teja has six, not the fifteen the
// plan was originally written around, and a pool that only works at scale is a pool
// that does not work.
test("a single configured key is discovered", () => {
  // One key.
  assert.deepEqual([...discoverConfiguredKeyIndices(keysFrom({ 1: "only" }))], [1]);
});

// No keys is a legal state to observe — it is what production looks like right now —
// and discovery must report it as empty rather than failing.
test("no configured keys yields an empty list rather than an error", () => {
  // Nothing set.
  assert.deepEqual([...discoverConfiguredKeyIndices(NO_KEYS)], []);
});

// A FULL 20-KEY POOL IS DISCOVERED AND RESOLVED IN EXACT NUMERIC SEQUENCE.
// Confirms that all 20 configured Gemini keys (01 through 20) are discovered
// without truncation, sorting bugs, or boundary issues.
test("discovers all 20 keys in exact numeric order up to key 20", () => {
  const twentyKeys: Record<number, string> = {};
  for (let i = 1; i <= 20; i += 1) {
    twentyKeys[i] = `key_${i}`;
  }
  const reader = keysFrom(twentyKeys);
  const discovered = discoverConfiguredKeyIndices(reader);
  assert.equal(discovered.length, 20);
  assert.equal(discovered[0], 1);
  assert.equal(discovered[19], 20);
  assert.deepEqual([...discovered], Array.from({ length: 20 }, (_, i) => i + 1));
});

