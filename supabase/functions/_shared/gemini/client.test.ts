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
  assert.equal(failure.p_error, "network error: connection reset");
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
