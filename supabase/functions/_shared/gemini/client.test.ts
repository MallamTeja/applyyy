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

  const fakeFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
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

  assert.ok(capturedUrl.includes("gemini-secret-key-01"));
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
      return new Response(JSON.stringify({ candidates: [{ groundingMetadata: grounding }] }), { status: 200 });
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
