// Tests for Gemini in-flight failover middleware (1a) and deterministic token pacer (1c).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GeminiPacer,
  callGeminiWithFailover,
  generateGeminiContent,
  GEMINI_DEFAULT_MODEL,
  type PacerClock,
  type GeminiExecutionResult,
} from "./client.ts";
import type { claimKey } from "./pool.ts";

// Virtual clock for deterministic 0ms pacer tests.
function createVirtualClock(initialTime = 1000): PacerClock & { advance: (ms: number) => void; sleepLog: number[] } {
  let currentTime = initialTime;
  const sleepLog: number[] = [];

  return {
    now: () => currentTime,
    sleep: async (ms: number) => {
      sleepLog.push(ms);
      currentTime += ms;
    },
    advance: (ms: number) => {
      currentTime += ms;
    },
    sleepLog,
  };
}

// Hand-rolled fake Supabase client for testing claim and report loop.
function fakeClient(options: {
  readonly claimSequence?: Array<{ data: unknown; error: { message: string } | null }>;
  readonly reportCalls?: Array<{ fn: string; args: unknown }>;
}) {
  let claimIndex = 0;
  const reportCalls = options.reportCalls ?? [];

  return {
    rpc(fn: string, args?: unknown) {
      reportCalls.push({ fn, args });
      if (fn === "claim_gemini_key") {
        const claim = options.claimSequence?.[claimIndex] ?? { data: null, error: null };
        claimIndex += 1;
        return Promise.resolve(claim);
      }
      return Promise.resolve({ data: null, error: null });
    },
    from() {
      return {
        select() {
          return Promise.resolve({ count: 1, error: null });
        },
      };
    },
  } as unknown as Parameters<typeof claimKey>[0];
}

function keysFrom(available: Readonly<Record<number, string>>) {
  return (index: number): string | null => available[index] ?? null;
}

// --- DETERMINISTIC TOKEN PACER TESTS (1c) --------------------------------------

test("GeminiPacer spaces sequential requests by minIntervalMs", async () => {
  const clock = createVirtualClock(1000);
  const pacer = new GeminiPacer({ minIntervalMs: 500, clock });

  const timestamps: number[] = [];

  const task1 = pacer.pace(async () => {
    timestamps.push(clock.now());
    return "result-1";
  });

  const task2 = pacer.pace(async () => {
    timestamps.push(clock.now());
    return "result-2";
  });

  const task3 = pacer.pace(async () => {
    timestamps.push(clock.now());
    return "result-3";
  });

  const [r1, r2, r3] = await Promise.all([task1, task2, task3]);

  assert.equal(r1, "result-1");
  assert.equal(r2, "result-2");
  assert.equal(r3, "result-3");

  // Task 1 runs immediately at 1000.
  // Task 2 waits 500ms and runs at 1500.
  // Task 3 waits 500ms and runs at 2000.
  assert.deepEqual(timestamps, [1000, 1500, 2000]);
  assert.deepEqual(clock.sleepLog, [500, 500]);
});

test("GeminiPacer continues executing subsequent tasks if a task fails", async () => {
  const clock = createVirtualClock(1000);
  const pacer = new GeminiPacer({ minIntervalMs: 200, clock });

  await assert.rejects(
    () =>
      pacer.pace(async () => {
        throw new Error("Task 1 boom");
      }),
    { message: "Task 1 boom" },
  );

  const result2 = await pacer.pace(async () => "Task 2 success");
  assert.equal(result2, "Task 2 success");
});

// --- IN-FLIGHT MULTI-KEY RETRY TESTS (1a) -------------------------------------

test("callGeminiWithFailover succeeds immediately on first healthy key", async () => {
  const reportCalls: Array<{ fn: string; args: unknown }> = [];
  const db = fakeClient({
    claimSequence: [{ data: 1, error: null }],
    reportCalls,
  });

  const readKey = keysFrom({ 1: "key-1-value" });
  const clock = createVirtualClock(1000);
  const pacer = new GeminiPacer({ minIntervalMs: 0, clock });

  const outcome = await callGeminiWithFailover(db, {
    readKey,
    pacer,
    execute: async (apiKey, keyIndex) => {
      assert.equal(apiKey, "key-1-value");
      assert.equal(keyIndex, 1);
      return { ok: true, data: { generatedText: "Resume tailored successfully" } };
    },
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.keyIndex, 1);
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.data.generatedText, "Resume tailored successfully");

  // Verified reportResult was called with success = true
  const report = reportCalls.find((c) => c.fn === "report_gemini_result");
  assert.ok(report);
  assert.deepEqual(report.args, {
    p_key_index: 1,
    p_success: true,
    p_retry_after_seconds: null,
    p_error: null,
  });
});

test("callGeminiWithFailover handles 429 on key 1 and transparently succeeds on key 2 (Zero Mid-Way Abort)", async () => {
  const reportCalls: Array<{ fn: string; args: unknown }> = [];
  const db = fakeClient({
    // Key 1 claimed first, then key 2 claimed on retry
    claimSequence: [
      { data: 1, error: null },
      { data: 2, error: null },
    ],
    reportCalls,
  });

  const readKey = keysFrom({ 1: "key-1-value", 2: "key-2-value" });
  const clock = createVirtualClock(1000);
  const pacer = new GeminiPacer({ minIntervalMs: 0, clock });

  const rotatedEvents: Array<{ fromKeyIndex: number; retryAfterSeconds: number | null; attempt: number }> = [];

  const mock429Response = new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), {
    status: 429,
    statusText: "Too Many Requests",
    headers: { "retry-after": "30" },
  });

  let callCount = 0;

  const outcome = await callGeminiWithFailover(db, {
    readKey,
    pacer,
    maxRetries: 3,
    onKeyRotated: (info) => rotatedEvents.push(info),
    execute: async (apiKey, keyIndex): Promise<GeminiExecutionResult<{ content: string }>> => {
      callCount += 1;
      if (keyIndex === 1) {
        return {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          errorBody: { error: { message: "Quota exceeded" } },
          rawResponse: mock429Response,
        };
      }
      return {
        ok: true,
        data: { content: `Tailored with key ${apiKey}` },
      };
    },
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  // Zero mid-way abort: caller gets valid data from key 2!
  assert.equal(outcome.keyIndex, 2);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.data.content, "Tailored with key key-2-value");
  assert.equal(callCount, 2);

  // Rotation callback fired
  assert.equal(rotatedEvents.length, 1);
  assert.equal(rotatedEvents[0].fromKeyIndex, 1);
  assert.equal(rotatedEvents[0].retryAfterSeconds, 30);
  assert.equal(rotatedEvents[0].attempt, 1);

  // Assert reports to Postgres
  const reports = reportCalls.filter((c) => c.fn === "report_gemini_result");
  assert.equal(reports.length, 2);

  // First report: Key 1 cooled with 30s retry_after
  assert.equal((reports[0].args as { p_key_index: number }).p_key_index, 1);
  assert.equal((reports[0].args as { p_success: boolean }).p_success, false);
  assert.equal((reports[0].args as { p_retry_after_seconds: number }).p_retry_after_seconds, 30);

  // Second report: Key 2 succeeded
  assert.equal((reports[1].args as { p_key_index: number }).p_key_index, 2);
  assert.equal((reports[1].args as { p_success: boolean }).p_success, true);
});

test("callGeminiWithFailover stops immediately on non-429 client error (e.g. 400 Bad Request)", async () => {
  const reportCalls: Array<{ fn: string; args: unknown }> = [];
  const db = fakeClient({
    claimSequence: [{ data: 1, error: null }],
    reportCalls,
  });

  const readKey = keysFrom({ 1: "key-1-value" });
  const clock = createVirtualClock(1000);
  const pacer = new GeminiPacer({ minIntervalMs: 0, clock });

  let callCount = 0;

  const outcome = await callGeminiWithFailover(db, {
    readKey,
    pacer,
    maxRetries: 3,
    execute: async () => {
      callCount += 1;
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        errorBody: { error: "Invalid JSON Schema" },
      };
    },
  });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;

  assert.equal(outcome.reason, "http_error");
  assert.equal(outcome.status, 400);
  assert.equal(outcome.attempts, 1);
  assert.equal(callCount, 1); // Does NOT uselessly retry across keys
});

test("callGeminiWithFailover returns all_keys_cooling if key pool has no eligible keys", async () => {
  const db = fakeClient({
    claimSequence: [{ data: null, error: null }],
  });

  const clock = createVirtualClock(1000);
  const pacer = new GeminiPacer({ minIntervalMs: 0, clock });

  const outcome = await callGeminiWithFailover(db, {
    readKey: keysFrom({}),
    pacer,
    execute: async () => ({ ok: true, data: {} }),
  });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "all_keys_cooling");
});

test("generateGeminiContent packages payload and calls fetchSeam", async () => {
  const db = fakeClient({
    claimSequence: [{ data: 1, error: null }],
  });

  const readKey = keysFrom({ 1: "gemini-secret-key-01" });
  const clock = createVirtualClock(1000);
  const pacer = new GeminiPacer({ minIntervalMs: 0, clock });

  let capturedUrl = "";
  let capturedBody = "";
  let capturedKeyHeader = "";

  const fakeFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedKeyHeader = new Headers(init?.headers).get("x-goog-api-key") ?? "";
    capturedBody = String(init?.body);
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ master_version: 7 }) }],
            },
            finishReason: "STOP",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const outcome = await generateGeminiContent(db, {
    readKey,
    pacer,
    fetchSeam: fakeFetch,
    prompt: {
      systemInstruction: "<system_policy>Tailor resume</system_policy>",
      userContent: "<untrusted_job_posting>Job description</untrusted_job_posting>",
      responseSchema: { type: "object" },
    },
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  // The key now rides in the header, not the URL (see the dedicated key-leak tests below).
  assert.equal(capturedKeyHeader, "gemini-secret-key-01");
  const parsedBody = JSON.parse(capturedBody);
  assert.equal(parsedBody.contents[0].parts[0].text, "<untrusted_job_posting>Job description</untrusted_job_posting>");
  assert.equal(parsedBody.systemInstruction.parts[0].text, "<system_policy>Tailor resume</system_policy>");
  assert.deepEqual(parsedBody.generationConfig.responseSchema, { type: "object" });
});

// --- 404 = CONFIGURATION ERROR, NOT A KEY ERROR -----------------------------------
// Earned 2026-10-04: `gemini-1.5-flash` was retired, every call 404'd, and the old generic
// branch blamed a different key each call until all 40 rows read "HTTP 404".

test("callGeminiWithFailover treats 404 as model_not_found: one call, no retry, no key blamed", async () => {
  // Captures every RPC so we can prove report_gemini_result was never sent.
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  // Two keys available, so a rotating implementation WOULD have somewhere to go.
  const db = fakeClient({ claimSequence: [{ data: 1, error: null }, { data: 2, error: null }], reportCalls: rpcCalls });
  // Zero-spacing pacer keeps the test instant.
  const pacer = new GeminiPacer({ minIntervalMs: 0, clock: createVirtualClock(1000) });
  // Counts executions so a retry-across-keys regression is visible.
  let callCount = 0;

  const outcome = await callGeminiWithFailover(db, {
    readKey: keysFrom({ 1: "k1", 2: "k2" }),
    pacer,
    maxRetries: 3,
    // Exactly what Google sends for a retired model id.
    execute: async () => {
      callCount += 1;
      return { ok: false, status: 404, statusText: "Not Found", errorBody: { error: { code: 404, status: "NOT_FOUND" } } };
    },
  });

  // Narrow first so the reason field is typed.
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  // The named configuration reason, not the generic http_error.
  assert.equal(outcome.reason, "model_not_found");
  assert.equal(outcome.status, 404);
  // Fail fast: one attempt, one execution.
  assert.equal(outcome.attempts, 1);
  assert.equal(callCount, 1);
  // The key's failure streak and last_error must be untouched — no report RPC at all.
  assert.deepEqual(rpcCalls.map((c) => c.fn), ["claim_gemini_key"]);
});

test("generateGeminiContent defaults to GEMINI_DEFAULT_MODEL in the request URL", async () => {
  // Shared fixture; one healthy key.
  const db = fakeClient({ claimSequence: [{ data: 1, error: null }] });
  // Records the URL so the model path segment can be inspected.
  let capturedUrl = "";
  await generateGeminiContent(db, {
    readKey: keysFrom({ 1: "k1" }),
    pacer: new GeminiPacer({ minIntervalMs: 0, clock: createVirtualClock(1000) }),
    // Minimal 200 so the call completes.
    fetchSeam: async (input) => {
      capturedUrl = String(input);
      return new Response("{}", { status: 200 });
    },
    prompt: { systemInstruction: "s", userContent: "u" },
  });
  // Shape check on the path segment, not a substring: the model must be exactly the constant.
  assert.equal(new URL(capturedUrl).pathname, `/v1beta/models/${GEMINI_DEFAULT_MODEL}:generateContent`);
  // Guard the regression itself: the retired id must never come back as the default.
  assert.notEqual(GEMINI_DEFAULT_MODEL, "gemini-1.5-flash");
});

// --- GROUNDING TOOLS ----------------------------------------------------------------

test("generateGeminiContent forwards tools verbatim and exposes groundingMetadata", async () => {
  // One healthy key.
  const db = fakeClient({ claimSequence: [{ data: 1, error: null }] });
  // Captures the outgoing body for inspection.
  let capturedBody = "";
  // A grounded response carries groundingMetadata on the candidate.
  const grounding = { webSearchQueries: ["q"] };
  const outcome = await generateGeminiContent(db, {
    readKey: keysFrom({ 1: "k1" }),
    pacer: new GeminiPacer({ minIntervalMs: 0, clock: createVirtualClock(1000) }),
    fetchSeam: async (_input, init) => {
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "grounded answer" }] }, groundingMetadata: grounding }] }), { status: 200 });
    },
    tools: [{ google_search: {} }],
    prompt: { systemInstruction: "s", userContent: "u" },
  });
  // The tools array reaches the wire unchanged.
  assert.deepEqual(JSON.parse(capturedBody).tools, [{ google_search: {} }]);
  // And the grounding metadata survives the typed return.
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.data.candidates?.[0]?.groundingMetadata, grounding);
});

test("generateGeminiContent refuses tools + responseSchema before claiming a key", async () => {
  // Records RPCs: a refusal must not claim (and so not spend) a key.
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const db = fakeClient({ claimSequence: [{ data: 1, error: null }], reportCalls: rpcCalls });
  // Any fetch at all is a failure of the refusal.
  let fetched = false;
  const outcome = await generateGeminiContent(db, {
    readKey: keysFrom({ 1: "k1" }),
    pacer: new GeminiPacer({ minIntervalMs: 0, clock: createVirtualClock(1000) }),
    fetchSeam: async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    },
    tools: [{ google_search: {} }],
    prompt: { systemInstruction: "s", userContent: "u", responseSchema: { type: "object" } },
  });
  // Typed failure with the named reason.
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "invalid_request");
  // Nothing sent, nothing claimed.
  assert.equal(fetched, false);
  assert.deepEqual(rpcCalls, []);
});

// --- TRANSIENT UPSTREAM FAILURES (5xx / network) RETRY ON THE NEXT KEY ----------------
// Earned 2026-10-05: gemini-3.8-flash intermittently answered 503 and one call ended the run.

// Shared rig: recorded sleeps (never really waits), fixed jitter, zero-spacing pacer.
function transientRig(keyCount = 4) {
  // Records every RPC so report calls and claims can be inspected.
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  // One distinct key per attempt, so rotation is visible.
  const claimSequence = Array.from({ length: keyCount }, (_, i) => ({ data: i + 1, error: null }));
  const db = fakeClient({ claimSequence, reportCalls: rpcCalls });
  // Sleep recorder: resolves immediately.
  const sleeps: number[] = [];
  return {
    rpcCalls,
    sleeps,
    db,
    base: {
      readKey: keysFrom({ 1: "k1", 2: "k2", 3: "k3", 4: "k4" }),
      pacer: new GeminiPacer({ minIntervalMs: 0, clock: createVirtualClock(1000) }),
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      // Constant 1 -> maximum jitter (+25%), making the upper bound exact.
      random: () => 1,
    },
  };
}

const fail = (status: number, statusText: string): GeminiExecutionResult<{ ok: 1 }> => ({ ok: false, status, statusText });

test("transient: 503, 503, 200 succeeds on the third key with null-cooldown reports and backoff", async () => {
  const rig = transientRig();
  const claimed: number[] = [];
  const outcome = await callGeminiWithFailover(rig.db, {
    ...rig.base,
    execute: async (_k, keyIndex) => {
      claimed.push(keyIndex);
      return claimed.length < 3 ? fail(503, "Service Unavailable") : { ok: true, data: { ok: 1 as const } };
    },
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.attempts, 3);
  // Three different keys.
  assert.deepEqual(claimed, [1, 2, 3]);
  // Two failure reports, both with NULL retry_after (the model is down, not the key).
  const failures = rig.rpcCalls.filter((c) => c.fn === "report_gemini_result").map((c) => c.args as { p_success: boolean; p_retry_after_seconds: unknown; p_error: string });
  assert.equal(failures.filter((a) => !a.p_success).length, 2);
  assert.ok(failures.filter((a) => !a.p_success).every((a) => a.p_retry_after_seconds === null));
  assert.equal(failures[0]!.p_error, "HTTP 503: Service Unavailable");
  // Backoff 1s then 3s, each with 0-25% jitter.
  assert.equal(rig.sleeps.length, 2);
  assert.ok(rig.sleeps[0]! >= 1000 && rig.sleeps[0]! <= 1250);
  assert.ok(rig.sleeps[1]! >= 3000 && rig.sleeps[1]! <= 3750);
});

test("transient: 503 on every attempt returns upstream_unavailable and does not sleep after the last attempt", async () => {
  const rig = transientRig();
  const outcome = await callGeminiWithFailover(rig.db, { ...rig.base, maxRetries: 3, execute: async () => fail(503, "Service Unavailable") });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "upstream_unavailable");
  assert.equal(outcome.status, 503);
  // maxRetries + 1 attempts.
  assert.equal(outcome.attempts, 4);
  // Sleeps between attempts only: 3, not 4.
  assert.equal(rig.sleeps.length, 3);
});

test("transient: 400 stays terminal http_error with one call and no sleep", async () => {
  const rig = transientRig();
  let calls = 0;
  const outcome = await callGeminiWithFailover(rig.db, {
    ...rig.base,
    execute: async () => {
      calls += 1;
      return fail(400, "Bad Request");
    },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "http_error");
  assert.equal(calls, 1);
  assert.deepEqual(rig.sleeps, []);
});

test("transient: a network error (fetch throws) then 200 succeeds after two attempts", async () => {
  const rig = transientRig();
  let fetches = 0;
  const outcome = await generateGeminiContent(rig.db, {
    ...rig.base,
    prompt: { systemInstruction: "s", userContent: "u" },
    // First fetch throws like a dropped connection; second answers normally.
    fetchSeam: async () => {
      fetches += 1;
      if (fetches === 1) throw new Error("connection reset");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }), { status: 200 });
    },
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.attempts, 2);
  // The failure was reported with the explicit network-error wording.
  const failure = rig.rpcCalls.filter((c) => c.fn === "report_gemini_result").map((c) => c.args as { p_error: string | null })[0]!;
  // Ends with the default model's tag: no option and no Deno env under node, so resolveModel fell
  // through to the constant — and last_error must say so rather than leave the model unstated.
  assert.equal(failure.p_error, `network error: connection reset model=${GEMINI_DEFAULT_MODEL}`);
});

test("transient: 429 then 503 x3 ends as upstream_unavailable (last failure was transient)", async () => {
  const rig = transientRig();
  let calls = 0;
  const outcome = await callGeminiWithFailover(rig.db, {
    ...rig.base,
    maxRetries: 3,
    execute: async () => {
      calls += 1;
      return calls === 1 ? fail(429, "Too Many Requests") : fail(503, "Service Unavailable");
    },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "upstream_unavailable");
  assert.equal(outcome.attempts, 4);
});

test("transient: 503 then final 429 keeps the rate_limited reason", async () => {
  const rig = transientRig();
  let calls = 0;
  const outcome = await callGeminiWithFailover(rig.db, {
    ...rig.base,
    maxRetries: 1,
    execute: async () => {
      calls += 1;
      return calls === 1 ? fail(503, "Service Unavailable") : fail(429, "Too Many Requests");
    },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "rate_limited_all_retries_exhausted");
});

test("empty 200 (safety block) is empty_response: no retry, key not blamed, detail names the block", async () => {
  const rig = transientRig();
  let fetches = 0;
  const outcome = await generateGeminiContent(rig.db, {
    ...rig.base,
    prompt: { systemInstruction: "s", userContent: "u" },
    fetchSeam: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ candidates: [], promptFeedback: { blockReason: "SAFETY" } }), { status: 200 });
    },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "empty_response");
  assert.ok(outcome.detail?.includes("SAFETY"));
  assert.equal(fetches, 1);
  assert.deepEqual(rig.sleeps, []);
  // No failure report: the only report is the transport-level success.
  assert.ok(rig.rpcCalls.filter((c) => c.fn === "report_gemini_result").every((c) => (c.args as { p_success: boolean }).p_success));
});

test("transient: 404 is still model_not_found after one call with no sleep", async () => {
  const rig = transientRig();
  let calls = 0;
  const outcome = await callGeminiWithFailover(rig.db, {
    ...rig.base,
    execute: async () => {
      calls += 1;
      return fail(404, "Not Found");
    },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "model_not_found");
  assert.equal(calls, 1);
  assert.deepEqual(rig.sleeps, []);
});

// --- EMPTY / MALFORMED 200s, TIMEOUTS (round 2) ----------------------------------------

// Runs generateGeminiContent against a fetch that always answers with `body` as a 200.
async function with200(body: string) {
  const rig = transientRig();
  const outcome = await generateGeminiContent(rig.db, {
    ...rig.base,
    prompt: { systemInstruction: "s", userContent: "u" },
    fetchSeam: async () => new Response(body, { status: 200 }),
  });
  return { outcome, rig };
}

test("200 with null body is empty_response and does not throw", async () => {
  const { outcome } = await with200("null");
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "empty_response");
});

test("200 with candidates:[{}] is empty_response", async () => {
  const { outcome } = await with200(JSON.stringify({ candidates: [{}] }));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "empty_response");
});

test("200 with a content-less SAFETY candidate is empty_response naming SAFETY", async () => {
  const { outcome } = await with200(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "empty_response");
  assert.ok(outcome.detail?.includes("SAFETY"));
});

test("200 with an empty-string text part is empty_response", async () => {
  const { outcome } = await with200(JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] } }] }));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "empty_response");
});

test("200 with a real text part is ok", async () => {
  const { outcome } = await with200(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hello" }] } }] }));
  assert.equal(outcome.ok, true);
});

test("a fetch timeout is transient: retried, and the report says timeout", async () => {
  const rig = transientRig();
  let fetches = 0;
  const outcome = await generateGeminiContent(rig.db, {
    ...rig.base,
    prompt: { systemInstruction: "s", userContent: "u" },
    fetchSeam: async () => {
      fetches += 1;
      // What AbortSignal.timeout produces.
      if (fetches === 1) throw new DOMException("The operation timed out.", "TimeoutError");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }), { status: 200 });
    },
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.attempts, 2);
  const failure = rig.rpcCalls.filter((c) => c.fn === "report_gemini_result").map((c) => c.args as { p_error: string | null })[0]!;
  assert.ok(failure.p_error?.includes("timeout after 25000ms"));
});

test("non-JSON 200 is terminal http_error: one call, no sleep", async () => {
  const rig = transientRig();
  let fetches = 0;
  const outcome = await generateGeminiContent(rig.db, {
    ...rig.base,
    prompt: { systemInstruction: "s", userContent: "u" },
    fetchSeam: async () => {
      fetches += 1;
      return new Response("<html>oops</html>", { status: 200 });
    },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "http_error");
  assert.equal(fetches, 1);
  assert.deepEqual(rig.sleeps, []);
  // The malformed body is the upstream's fault: no failure report, so no key is blamed.
  assert.equal(outcome.detail, "invalid JSON body");
  assert.deepEqual(rig.rpcCalls.filter((c) => c.fn === "report_gemini_result"), []);
});

// Guards the `signal: AbortSignal.timeout(...)` line itself: the hand-thrown TimeoutError test
// above passes even if that line is deleted, so these two exercise the real signal.
test("every attempt passes an AbortSignal to fetch", async () => {
  const rig = transientRig();
  let signal: unknown = null;
  await generateGeminiContent(rig.db, {
    ...rig.base,
    prompt: { systemInstruction: "s", userContent: "u" },
    fetchSeam: async (_input, init) => {
      signal = init?.signal;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }] }), { status: 200 });
    },
  });
  assert.ok(signal instanceof AbortSignal);
});

test("a hung fetch is aborted by timeoutMs, retried, and reported as a timeout", async () => {
  const rig = transientRig();
  // AbortSignal.timeout timers are unref'd, so keep the loop alive with a ref'd timer.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    const outcome = await generateGeminiContent(rig.db, {
      ...rig.base,
      maxRetries: 1,
      timeoutMs: 20,
      prompt: { systemInstruction: "s", userContent: "u" },
      // Hangs until the signal fires, then rejects with its reason like real fetch.
      fetchSeam: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return; // no signal: hangs forever, the test's keepAlive/timeout fails it
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, "upstream_unavailable");
    assert.equal(outcome.attempts, 2);
    const errors = rig.rpcCalls.filter((c) => c.fn === "report_gemini_result").map((c) => (c.args as { p_error: string }).p_error);
    assert.ok(errors.every((e) => e.includes("timeout after 20ms")));
  } finally {
    clearTimeout(keepAlive);
  }
});

// --- API KEY NEVER IN THE URL ------------------------------------------------------------

test("the API key travels only in the x-goog-api-key header, never in the URL", async () => {
  const rig = transientRig();
  let url = "";
  let headers: Record<string, string> = {};
  await generateGeminiContent(rig.db, {
    ...rig.base,
    prompt: { systemInstruction: "s", userContent: "u" },
    fetchSeam: async (input, init) => {
      url = String(input);
      // The client passes a plain record; normalise through Headers so either shape would work.
      headers = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }] }), { status: 200 });
    },
  });
  assert.ok(!url.includes("key="));
  assert.ok(!url.includes("k1"));
  assert.equal(headers["x-goog-api-key"], "k1");
});

test("a failed call's outcome never contains the API key", async () => {
  const rig = transientRig();
  const outcome = await generateGeminiContent(rig.db, {
    ...rig.base,
    prompt: { systemInstruction: "s", userContent: "u" },
    // A distinctive key value so a substring hit cannot be a coincidence.
    readKey: keysFrom({ 1: "SECRET-KEY-VALUE-123" }),
    fetchSeam: async () => new Response(JSON.stringify({ error: "bad" }), { status: 400, statusText: "Bad Request" }),
  });
  assert.equal(outcome.ok, false);
  // rawResponse is not part of the outcome, but errorBody/detail are: serialise the lot.
  assert.ok(!JSON.stringify(outcome).includes("SECRET-KEY-VALUE-123"));
});

// --- 401/403 = ONE BAD KEY, NOT A DEAD CALL -----------------------------------------------
// Earned 2026-10-05: key 17 answered 403 on the first attempt and ended the whole matcher call
// while 19 other keys were healthy.

type ReportArgs = { p_key_index: number; p_success: boolean; p_retry_after_seconds: number | null; p_error: string | null };
const reportsOf = (rig: ReturnType<typeof transientRig>) =>
  rig.rpcCalls.filter((c) => c.fn === "report_gemini_result").map((c) => c.args as ReportArgs);

test("403 then 200: ok on the second key, first key parked for 3600s, no sleep", async () => {
  const rig = transientRig();
  let calls = 0;
  const outcome = await callGeminiWithFailover(rig.db, {
    ...rig.base,
    execute: async () => {
      calls += 1;
      return calls === 1 ? fail(403, "Forbidden") : { ok: true, data: { ok: 1 as const } };
    },
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.attempts, 2);
  const first = reportsOf(rig)[0]!;
  assert.equal(first.p_key_index, 1);
  assert.equal(first.p_success, false);
  assert.equal(first.p_retry_after_seconds, 3600);
  // Not an overload: rotating must not wait.
  assert.deepEqual(rig.sleeps, []);
});

test("403 on every attempt ends as http_error 403 saying every key was rejected", async () => {
  const rig = transientRig();
  const outcome = await callGeminiWithFailover(rig.db, { ...rig.base, maxRetries: 3, execute: async () => fail(403, "Forbidden") });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "http_error");
  assert.equal(outcome.status, 403);
  assert.equal(outcome.attempts, 4);
  assert.ok(outcome.detail?.includes("every attempted key was rejected"));
  assert.deepEqual(rig.sleeps, []);
});

test("401 then 200 is ok", async () => {
  const rig = transientRig();
  let calls = 0;
  const outcome = await callGeminiWithFailover(rig.db, {
    ...rig.base,
    execute: async () => {
      calls += 1;
      return calls === 1 ? fail(401, "Unauthorized") : { ok: true, data: { ok: 1 as const } };
    },
  });
  assert.equal(outcome.ok, true);
});

test("400 is still terminal after one call (a malformed request fails on every key)", async () => {
  const rig = transientRig();
  let calls = 0;
  const outcome = await callGeminiWithFailover(rig.db, {
    ...rig.base,
    execute: async () => {
      calls += 1;
      return fail(400, "Bad Request");
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(calls, 1);
});

// --- 400 API_KEY_INVALID = A DEAD KEY, NOT A BAD REQUEST -----------------------------------
// Google answers an expired or deleted key with HTTP 400 INVALID_ARGUMENT whose
// error.details[] carries reason "API_KEY_INVALID" — per KEY, not per request. Before the
// fix (TODO 2026-10-09) this fell into the terminal 400 branch: no rotation, no cooldown,
// so one dead key kept failing calls. These tests pin the rotation and the fail-closed
// shape check (CLAUDE.md §6: a lenient reader is the fail-open).

// Google's real envelope for a dead key, shape per the API error docs (google.rpc.ErrorInfo).
const apiKeyInvalidBody = {
  error: {
    code: 400,
    message: "API key not valid. Please pass a valid API key.",
    status: "INVALID_ARGUMENT",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }],
  },
};

test("400 API_KEY_INVALID then 200: rotates like a 403 — dead key parked 3600s, ok on the next key, no sleep", async () => {
  const rig = transientRig();
  // Counts attempts so the test proves the SECOND key answered, not a retry of the first.
  let calls = 0;
  const outcome = await callGeminiWithFailover(rig.db, {
    ...rig.base,
    execute: async () => {
      calls += 1;
      // First key is dead at Google; the second behaves.
      return calls === 1
        ? { ok: false as const, status: 400, statusText: "Bad Request", errorBody: apiKeyInvalidBody }
        : { ok: true as const, data: { ok: 1 as const } };
    },
  });
  // The call survived the dead key: that is the whole point of the rotation.
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.attempts, 2);
  const first = reportsOf(rig)[0]!;
  // The DEAD key (index 1) took the blame, so the LRU skips it.
  assert.equal(first.p_key_index, 1);
  assert.equal(first.p_success, false);
  // Exactly the 401/403 path's cooldown: the key, not the request, is at fault.
  assert.equal(first.p_retry_after_seconds, 3600);
  // Not an overload: rotating must not wait.
  assert.deepEqual(rig.sleeps, []);
});

test("400 WITHOUT reason API_KEY_INVALID stays a terminal request error after one call", async () => {
  const rig = transientRig();
  // Counts calls: a malformed request fails identically on every key, so exactly one attempt.
  let calls = 0;
  const outcome = await callGeminiWithFailover(rig.db, {
    ...rig.base,
    execute: async () => {
      calls += 1;
      // A real 400 shape WITH a details array but a different reason: only API_KEY_INVALID rotates.
      return {
        ok: false as const,
        status: 400,
        statusText: "Bad Request",
        errorBody: { error: { code: 400, message: "Invalid JSON payload", status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.BadRequest", reason: "FIELD_ERROR" }] } },
      };
    },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  // The terminal branch, not rotation: reason and single attempt prove it.
  assert.equal(outcome.reason, "http_error");
  assert.equal(calls, 1);
});

test("a 400 whose error.details is missing or malformed is NOT treated as API_KEY_INVALID", async () => {
  // Every odd shape must read as an ordinary 400 (fail closed): rotating on a guess would park a
  // healthy key for an hour on each malformed request.
  for (const errorBody of [undefined, null, "plain text", {}, { error: null }, { error: {} }, { error: { details: "API_KEY_INVALID" } }, { error: { details: [null, { reason: 42 }] } }]) {
    const rig = transientRig();
    // One counter per shape so the failure message names the shape that rotated.
    let calls = 0;
    const outcome = await callGeminiWithFailover(rig.db, {
      ...rig.base,
      execute: async () => {
        calls += 1;
        return { ok: false as const, status: 400, statusText: "Bad Request", errorBody };
      },
    });
    // Terminal on the first call, never rotated, for every shape in the sweep.
    assert.equal(outcome.ok, false, JSON.stringify(errorBody));
    assert.equal(calls, 1, JSON.stringify(errorBody));
  }
});

test("a 403 errorBody's error.status and message reach last_error", async () => {
  const rig = transientRig();
  await callGeminiWithFailover(rig.db, {
    ...rig.base,
    maxRetries: 0,
    execute: async () => ({ ok: false, status: 403, statusText: "Forbidden", errorBody: { error: { status: "PERMISSION_DENIED", message: "API key not valid" } } }),
  });
  assert.ok(reportsOf(rig)[0]!.p_error?.includes("PERMISSION_DENIED"));
  assert.ok(reportsOf(rig)[0]!.p_error?.includes("API key not valid"));
});

test("an AIza key echoed in an error message is redacted from last_error", async () => {
  const rig = transientRig();
  const fakeKey = "AIza" + "A".repeat(35);
  await callGeminiWithFailover(rig.db, {
    ...rig.base,
    maxRetries: 0,
    execute: async () => ({ ok: false, status: 403, statusText: "Forbidden", errorBody: { error: { status: "X", message: `bad key ${fakeKey} here` } } }),
  });
  assert.ok(!reportsOf(rig)[0]!.p_error?.includes(fakeKey));
});

// --- last_error NAMES THE MODEL ---------------------------------------------------------
// Earned 2026-10-06: two live tailor runs failed with 503 "high demand", and last_error could
// not say which model had been called, so GEMINI_MODEL had to be INFERRED from isolate boot
// times. The tag makes it measured. Driven through generateGeminiContent, not the loop directly,
// because the forward from resolveModel into the loop is half of what is being guarded.

test("last_error keeps its HTTP prefix and Google bracket, then ends with model=<the id the URL used>", async () => {
  // Records the report RPCs so the exact p_error strings can be read back.
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  // Two keys: first answers 503, second answers 403, so both write branches are exercised.
  const db = fakeClient({ claimSequence: [{ data: 1, error: null }, { data: 2, error: null }], reportCalls: rpcCalls });
  // Records the URL so the tag can be compared against what was actually requested.
  const urls: string[] = [];
  // A non-default id, so a tag that silently fell back to the constant would be caught.
  const model = "gemini-3.6-flash";
  await generateGeminiContent(db, {
    // The explicit option is the most specific source resolveModel honours.
    model,
    // One key per attempt so each failure lands on its own report.
    readKey: keysFrom({ 1: "k1", 2: "k2" }),
    // Zero spacing so the test never waits on the pacer.
    pacer: new GeminiPacer({ minIntervalMs: 0, clock: createVirtualClock(1000) }),
    // Never really sleeps between the transient retry and the next key.
    sleep: async () => {},
    // One retry: exactly two attempts, the 503 then the 403.
    maxRetries: 1,
    // Google's real error envelope, so the bracket is built the way it is live.
    fetchSeam: async (input) => {
      // Kept to compare against the tag.
      urls.push(String(input));
      // First call overloaded, second rejected: the two branches that wrote live last_errors.
      return urls.length === 1
        ? new Response(JSON.stringify({ error: { status: "UNAVAILABLE", message: "high demand" } }), { status: 503, statusText: "Service Unavailable" })
        : new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "denied" } }), { status: 403, statusText: "Forbidden" });
    },
    prompt: { systemInstruction: "s", userContent: "u" },
  });
  // The model segment of the URL actually requested, parsed from its path, not assumed.
  const requested = new URL(urls[0]!).pathname.match(/^\/v1beta\/models\/([^/:]+):generateContent$/)?.[1];
  // Non-vacuity: the URL really carried the id, so the comparison below is against a measurement.
  assert.equal(requested, model);
  // Every failure report's p_error, in order.
  const errors = rpcCalls
    .filter((c) => c.fn === "report_gemini_result")
    .map((c) => (c.args as { p_error: string | null }).p_error);
  // Both failures were reported; zero would make every check below pass vacuously.
  assert.equal(errors.length, 2);
  // SHAPE, not substring: the unchanged prefix, Google's bracket, then the tag as the LAST token.
  assert.match(errors[0]!, /^HTTP 503: Service Unavailable \[UNAVAILABLE - high demand\] model=([^\s]+)$/);
  // The id after "model=" is exactly the one the URL was built from.
  assert.equal(errors[0]!.match(/ model=([^\s]+)$/)?.[1], requested);
  // The 403 branch carries the same tag, so a key rejection also names its model.
  assert.match(errors[1]!, /^HTTP 403: Forbidden \[PERMISSION_DENIED - denied\] model=gemini-3\.6-flash$/);
});

// --- OVERLOAD BACKOFF AND FALLBACK MODEL ------------------------------------------------
// Earned 2026-10-06 (run 37423817507): four 503 "high demand" answers on four keys within ~17 s,
// every one returned in seconds. The attempts were spent inside one spike. These tests pin the
// budget-aware backoff (spread the SAME attempts across the time the caller already budgeted)
// and the optional GEMINI_FALLBACK_MODEL switch.

// One rig for this section: virtual clock shared by sleep and the budget, URLs recorded per call.
function overloadRig(script: ReadonlyArray<number | { status: number; headers?: Record<string, string> }>, attemptMs = 0) {
  // Records report RPCs so the per-attempt last_error tags can be read back.
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  // One key per scripted response, so no claim ever runs dry.
  const claimSequence = script.map((_, i) => ({ data: i + 1, error: null }));
  // The fake pool behind every claim and report.
  const db = fakeClient({ claimSequence, reportCalls: rpcCalls });
  // ONE clock for sleeps and the budget, so "elapsed" is exactly what the loop chose to spend.
  const clock = createVirtualClock(0);
  // Every requested URL, in order, so the model of each attempt is measured from the request.
  const urls: string[] = [];
  return {
    rpcCalls, clock, urls, db,
    // Model segment of each requested URL, parsed by shape rather than substring.
    models: () => urls.map((u) => new URL(u).pathname.match(/^\/v1beta\/models\/([^/:]+):generateContent$/)?.[1]),
    // The p_error of every failure report, in order.
    errors: () => rpcCalls.filter((c) => c.fn === "report_gemini_result").map((c) => (c.args as { p_error: string | null }).p_error).filter((e) => e !== null),
    // Shared options; each test adds model/fallback/budget knobs.
    base: {
      readKey: keysFrom(Object.fromEntries(script.map((_, i) => [i + 1, `k${i + 1}`]))),
      // Zero spacing on a SEPARATE clock, so pacer bookkeeping never touches the budget clock.
      pacer: new GeminiPacer({ minIntervalMs: 0, clock: createVirtualClock(0) }),
      sleep: clock.sleep,
      now: clock.now,
      // Maximum jitter, so every expected delay is exact.
      random: () => 1,
      prompt: { systemInstruction: "s", userContent: "u" },
      // Plays the script; `attemptMs` models how long each attempt held the connection.
      fetchSeam: async (input: string | URL | Request) => {
        urls.push(String(input));
        clock.advance(attemptMs);
        const step = script[urls.length - 1]!;
        const { status, headers } = typeof step === "number" ? { status: step, headers: undefined } : step;
        if (status === 200) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }), { status: 200 });
        return new Response(JSON.stringify({ error: { status: "UNAVAILABLE", message: "high demand" } }), { status, ...(headers ? { headers } : {}) });
      },
    },
  };
}

test("overload backoff: fast 503s are spread 4s/16s/48s across the budget, not burned in ~17s", async () => {
  // Four 503s that return instantly, as live: the case the short 1s/3s/7s schedule wasted.
  const rig = overloadRig([503, 503, 503, 503]);
  const outcome = await generateGeminiContent(rig.db, { ...rig.base, model: "m-primary" });
  // Still the honest exhaustion reason: backoff changes timing, not the verdict.
  assert.equal(outcome.ok, false);
  // Same attempt count as before (maxRetries 3 => 4): the budget is spent more wisely, not raised.
  assert.equal(rig.urls.length, 4);
  // Equal jitter at random()=1 hits each ceiling exactly; the short schedule's max was 1250/3750/8750.
  assert.deepEqual(rig.clock.sleepLog, [4000, 16000, 48000]);
});

test("overload backoff never outlives the caller's planned worst case when every attempt times out", async () => {
  // Each attempt holds its full 25 s timeout: the exact worst case deadline.ts plans for.
  const rig = overloadRig([503, 503, 503, 503], 25000);
  await generateGeminiContent(rig.db, { ...rig.base, model: "m-primary" });
  // With no slack, each gap shrinks to deadline.ts's reservation (base x 1.25).
  assert.deepEqual(rig.clock.sleepLog, [1250, 3750, 8750]);
  // worstCaseCallMs({timeoutMs:25000, maxRetries:3}) = 4x25000 + 13750; ended at it, not past it.
  assert.equal(rig.clock.now(), 113750);
});

test("overload backoff honours Google's Retry-After instead of its own schedule", async () => {
  // A 503 carrying an explicit 10 s hint, then success.
  const rig = overloadRig([{ status: 503, headers: { "retry-after": "10" } }, 200]);
  const outcome = await generateGeminiContent(rig.db, { ...rig.base, model: "m-primary" });
  assert.equal(outcome.ok, true);
  // 10000, not the 4000 the schedule would pick at random()=1.
  assert.deepEqual(rig.clock.sleepLog, [10000]);
});

test("fallback: the primary's first 503 switches every remaining attempt, tags name the model called", async () => {
  // Primary sheds load once; the fallback 503s twice, then answers.
  const rig = overloadRig([503, 503, 503, 200]);
  const outcome = await generateGeminiContent(rig.db, { ...rig.base, model: "m-primary", fallbackModel: "m-fallback" });
  assert.equal(outcome.ok, true);
  // Measured from the requests: switched after the first 503 and never switched back.
  assert.deepEqual(rig.models(), ["m-primary", "m-fallback", "m-fallback", "m-fallback"]);
  // Each last_error names the model that produced it (shape: the tag is the final token).
  assert.deepEqual(rig.errors().map((e) => e!.match(/ model=([^\s]+)$/)?.[1]), ["m-primary", "m-fallback", "m-fallback"]);
  // The switch waits only the brief gap (1000 x 1.25); later fallback 503s get the overload backoff.
  assert.deepEqual(rig.clock.sleepLog, [1250, 16000, 48000]);
});

test("a fallback attempt still calls claim_gemini_key: the kill switch and budget gate every attempt", async () => {
  // Same switching script as above.
  const rig = overloadRig([503, 503, 503, 200]);
  await generateGeminiContent(rig.db, { ...rig.base, model: "m-primary", fallbackModel: "m-fallback" });
  // claim_gemini_key is where system_enabled and the daily budget are checked and every call is
  // counted. One claim per attempt, fallback attempts included; reusing a key without claiming
  // would let retries bypass the kill switch, which is why this is pinned.
  const claims = rig.rpcCalls.filter((c) => c.fn === "claim_gemini_key").length;
  // Non-vacuity: four attempts really happened, three of them on the fallback.
  assert.equal(rig.urls.length, 4);
  // Exactly one claim per attempt.
  assert.equal(claims, rig.urls.length);
});

test("fallback unset (or equal to the primary) never switches: today's behaviour", async () => {
  // The exact script that switches in the previous test.
  for (const fallbackModel of [undefined, "m-primary", "  "]) {
    const rig = overloadRig([503, 503, 503, 200]);
    await generateGeminiContent(rig.db, { ...rig.base, model: "m-primary", ...(fallbackModel !== undefined ? { fallbackModel } : {}) });
    // Every attempt stays on the primary; the label names which unset form broke.
    assert.deepEqual(rig.models(), ["m-primary", "m-primary", "m-primary", "m-primary"], `fallbackModel=${JSON.stringify(fallbackModel)}`);
  }
});

test("only a 503 switches: a 429 (4xx) and a 500 stay on the primary, then the 503 switches", async () => {
  // A quota 429 and a non-overload 500 first; neither is "high demand". Then the 503, then success.
  const rig = overloadRig([429, 500, 503, 200]);
  await generateGeminiContent(rig.db, { ...rig.base, model: "m-primary", fallbackModel: "m-fallback" });
  // The first three attempts stay on the primary; only the attempt after the 503 moves.
  assert.deepEqual(rig.models(), ["m-primary", "m-primary", "m-primary", "m-fallback"]);
});

test("429 last_error goes through withGoogleError: key shapes redacted, size bounded (review N2)", async () => {
  // The 429 branch used to store JSON.stringify(errorBody) raw: every other branch redacts
  // key shapes and caps at 200 chars, and last_error is shown on the Health page.
  const reportCalls: Array<{ fn: string; args: unknown }> = [];
  // Key 1 rate-limited, key 2 succeeds, as in the test above.
  const db = fakeClient({ claimSequence: [{ data: 1, error: null }, { data: 2, error: null }], reportCalls });
  // A FAKE key-shaped token built here, never a real key.
  const fakeKey = "AIza" + "x".repeat(35);
  // An upstream body echoing the key, plus a large details array a raw stringify would store whole.
  const errorBody = {
    error: { status: "RESOURCE_EXHAUSTED", message: `Quota exceeded for ${fakeKey}`, details: Array.from({ length: 50 }, (_, i) => ({ i, pad: "y".repeat(40) })) },
  };
  await callGeminiWithFailover(db, {
    readKey: keysFrom({ 1: "k1", 2: "k2" }),
    // No pacing delay; this test is about the stored text only.
    pacer: new GeminiPacer({ minIntervalMs: 0, clock: createVirtualClock(1000) }),
    maxRetries: 3,
    // 429 on key 1 with the body above, success on key 2.
    execute: async (_apiKey, keyIndex): Promise<GeminiExecutionResult<{ content: string }>> =>
      keyIndex === 1
        ? { ok: false, status: 429, statusText: "Too Many Requests", errorBody, rawResponse: new Response("", { status: 429 }) }
        : { ok: true, data: { content: "ok" } },
  });
  // The failure report for key 1.
  const failure = reportCalls.find((c) => c.fn === "report_gemini_result" && (c.args as { p_success: boolean }).p_success === false);
  // It exists, or the assertions below would pass on nothing.
  assert.ok(failure);
  const stored = (failure.args as { p_error: string }).p_error;
  // The status line leads, with Google's status/message in brackets, as on every other branch.
  assert.ok(stored.startsWith("HTTP 429: Too Many Requests [RESOURCE_EXHAUSTED - Quota exceeded for [redacted-key]"), stored);
  // The fake key never reaches the stored row.
  assert.ok(!stored.includes("AIza"));
  // Bounded: the 50-entry details array is not dumped (cap 200 + status line + model tag).
  assert.ok(stored.length < 320, `stored ${stored.length} chars`);
});
