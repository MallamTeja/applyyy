// Tests for the three resume-chat latency options on generateGeminiContent (2026-11-18):
// onText (streaming), onAttempt (progress hook) and interactive (fail fast + instant fallback).
// Kept apart from client.test.ts so the "absent options = unchanged" proof is that file staying green untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiPacer, generateGeminiContent, type PacerClock } from "./client.ts";
import type { claimKey } from "./pool.ts";

// The db type the client expects; the fakes below are cast to it, like client.test.ts does.
type Db = Parameters<typeof claimKey>[0];

// One scripted fetch step: a status with a JSON error, a plain non-streaming JSON 200, or a 200 whose body is these raw SSE pieces.
type Step = number | "json" | { readonly sse: readonly string[] };

// Rig: one key per step, a recorded virtual sleep, every URL and usage row captured.
function rig(script: readonly Step[]) {
  // Every RPC, so report_gemini_result writes can be read back.
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  // Every gemini_usage insert, so streaming's usage logging is measured, not assumed.
  const rows: Array<Record<string, unknown>> = [];
  // Next key index to hand out; one fresh key per attempt keeps rotation visible.
  let nextKey = 0;
  // Only rpc and from().insert are reached on these paths (every claim returns a key).
  const db = {
    // claim_gemini_key hands out 1, 2, 3...; report_gemini_result just records.
    rpc: (fn: string, args?: unknown) => (rpcCalls.push({ fn, args }), Promise.resolve({ data: fn === "claim_gemini_key" ? ++nextKey : null, error: null })),
    // The usage log write, captured with its table name.
    from: (table: string) => ({ insert: (row: Record<string, unknown>) => (rows.push({ table, ...row }), Promise.resolve({ error: null })) }),
  } as unknown as Db;
  // One clock for sleeps and the budget, so total waiting is exactly the sum of sleepLog.
  let time = 0;
  // Every sleep the loop asked for, in order.
  const sleepLog: number[] = [];
  // The clock seam: sleeping advances virtual time instantly.
  const clock: PacerClock = { now: () => time, sleep: async (ms) => void (sleepLog.push(ms), (time += ms)) };
  // Every requested URL, so the model and the endpoint of each attempt are read from the request.
  const urls: string[] = [];
  // Plays the script, one step per fetch.
  const fetchSeam: typeof fetch = async (input) => {
    // Recorded before answering so a failing attempt is still counted.
    urls.push(String(input));
    // The step for this attempt; the script is sized by each test.
    const step = script[urls.length - 1]!;
    // A bare status is an error answer shaped like Google's overload reply.
    // A plain generateContent success, for the paths that do not stream.
    if (step === "json") return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }), { status: 200 });
    if (typeof step === "number") return new Response(JSON.stringify({ error: { status: "UNAVAILABLE", message: "high demand" } }), { status: step });
    // SSE pieces become separate stream chunks, so the reader sees the split exactly where the test put it.
    const encoder = new TextEncoder();
    // Every piece is enqueued up front, then the stream closes.
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const piece of step.sse) c.enqueue(encoder.encode(piece)); c.close(); } });
    // 200 with the event-stream type Google sends for alt=sse.
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  return {
    db, rpcCalls, rows, sleepLog, urls,
    // The model segment and endpoint of each requested URL, parsed by shape.
    calls: () => urls.map((u) => new URL(u).pathname.match(/^\/v1beta\/models\/([^/:]+):(\w+)$/)?.slice(1, 3).join(":")),
    // The p_error of every failure report, in order.
    errors: () => rpcCalls.filter((c) => c.fn === "report_gemini_result").map((c) => (c.args as { p_error: string | null }).p_error).filter((e) => e !== null),
    // Shared options: instant pacer, max jitter, explicit primary so no env is read.
    base: {
      // Key i is "k<i>"; the loop only needs a non-null string per claimed index.
      readKey: (i: number) => `k${i}`,
      // Zero spacing on its own clock, so pacing never shows up in sleepLog.
      pacer: new GeminiPacer({ minIntervalMs: 0, clock: { now: () => 0, sleep: async () => {} } }),
      // The recorded sleep: every wait the loop chooses lands in sleepLog.
      sleep: clock.sleep,
      // The same virtual clock drives the batch budget arithmetic.
      now: clock.now,
      // Maximum jitter, so batch delays are exact.
      random: () => 1,
      // Explicit primary, so resolveModel never reads an env.
      model: "m-primary",
      // A minimal prompt; these tests are about transport, not content.
      prompt: { systemInstruction: "s", userContent: "u" },
      // Plays the script above.
      fetchSeam,
    },
  };
}

// One SSE event carrying a GenerateContentResponse chunk, CRLF-terminated like a proxy might send it.
const event = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\r\n\r\n`;
// The final chunk Google sends: finish reason plus the usage counts.
const finish = event({ candidates: [{ content: { parts: [{ text: "!" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 16 } });

// --- onText: streaming ---------------------------------------------------------------------------

test("onText streams: SSE split mid-JSON and mid-CRLF with non-data lines parses into the normal body shape", async () => {
  // Comment and event lines Google may interleave, then two text deltas and the finish chunk.
  const whole = ": keep-alive\r\nevent: message\r\n" + event({ candidates: [{ content: { parts: [{ text: "Hel" }] } }] }) + event({ candidates: [{ content: { parts: [{ text: "lo" }] } }] }) + finish;
  // Cut inside the first event's JSON, so the reader must buffer a partial line.
  const cutA = whole.indexOf('"Hel') + 2;
  // Cut between a \r and its \n, so a split CRLF must not corrupt the next payload.
  const cutB = whole.indexOf("\r\n", cutA) + 1;
  // Three network chunks with those two cuts.
  const r = rig([{ sse: [whole.slice(0, cutA), whole.slice(cutA, cutB), whole.slice(cutB)] }]);
  // Every accumulated text the hook saw, in order.
  const seen: string[] = [];
  // Streaming is switched on by passing onText.
  const outcome = await generateGeminiContent(r.db, { ...r.base, onText: (t) => seen.push(t) });
  // The split stream still produced an answer.
  assert.equal(outcome.ok, true);
  // Narrows the outcome for the reads below.
  if (!outcome.ok) return;
  // The streaming endpoint with alt=sse, measured from the request.
  assert.deepEqual(r.calls(), ["m-primary:streamGenerateContent"]);
  // alt=sse is what makes Google answer as event-stream.
  assert.equal(new URL(r.urls[0]!).searchParams.get("alt"), "sse");
  // Cumulative text after each delta, never a fragment.
  assert.deepEqual(seen, ["Hel", "Hello", "Hello!"]);
  // The same shape a non-streaming call returns: one joined part, the finish reason, the usage.
  assert.deepEqual(outcome.data, {
    candidates: [{ content: { parts: [{ text: "Hello!" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 16 },
  });
  // The usage row still carries the token counts from the last chunk.
  // One attempt, one usage row.
  assert.equal(r.rows.length, 1);
  // Logged as a success.
  assert.equal(r.rows[0]!.outcome, "ok");
  // Totals from the finish chunk, not null.
  assert.equal(r.rows[0]!.total_tokens, 16);
  // Input count too, the number the caching work will read.
  assert.equal(r.rows[0]!.prompt_tokens, 10);
});

test("onText: a malformed data line is a transient failure retried on the next key, never a crash", async () => {
  // Attempt 1 streams one good delta then garbage; attempt 2 is clean.
  const r = rig([{ sse: [event({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }), "data: {not json\n\n"] }, { sse: [event({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), finish] }]);
  // What the hook saw across both attempts.
  const seen: string[] = [];
  // Streaming on, hook records every accumulated text.
  const outcome = await generateGeminiContent(r.db, { ...r.base, onText: (t) => seen.push(t) });
  // The retry recovered.
  assert.equal(outcome.ok, true);
  // Narrows for the reads below.
  if (!outcome.ok) return;
  // Retried once: status 0 is transient.
  assert.equal(outcome.attempts, 2);
  // The new attempt's text restarts from empty, it does not append to the dead attempt's.
  assert.deepEqual(seen, ["partial", "ok", "ok!"]);
  // The failed attempt is logged as a network error (status 0) against the model it called.
  assert.match(r.errors()[0]!, /^network error: .*malformed.* model=m-primary$/);
  // And its usage row says network_error, so the log counts it.
  assert.equal(r.rows[0]!.outcome, "network_error");
});

test("onText: a stream that closes before any finishReason is transient, not a truncated answer", async () => {
  // Attempt 1 drops after one delta; attempt 2 finishes.
  const r = rig([{ sse: [event({ candidates: [{ content: { parts: [{ text: "half" }] } }] })] }, { sse: [finish] }]);
  // Streaming on; the texts themselves are not under test here.
  const outcome = await generateGeminiContent(r.db, { ...r.base, onText: () => {} });
  // The second attempt answered.
  assert.equal(outcome.ok, true);
  // Narrows for the reads below.
  if (!outcome.ok) return;
  // The half answer was never returned as the result.
  assert.equal(outcome.attempts, 2);
  // The answer is the second attempt's text only.
  assert.equal(outcome.data.candidates?.[0]?.content?.parts?.[0]?.text, "!");
});

test("onText: an HTTP error before the first chunk is handled exactly like the non-streaming status", async () => {
  // 400 is terminal in the loop, streaming or not.
  const r = rig([400]);
  // Streaming on, same as resume-assist will call it.
  const outcome = await generateGeminiContent(r.db, { ...r.base, onText: () => {} });
  // Failed, not crashed.
  assert.equal(outcome.ok, false);
  // Narrows for the reads below.
  if (outcome.ok) return;
  // The terminal branch, not upstream_unavailable: one attempt only.
  assert.equal(outcome.reason, "http_error");
  // The real HTTP status reaches the caller.
  assert.equal(outcome.status, 400);
});

// --- onAttempt: progress hook ---------------------------------------------------------------------

test("onAttempt fires before each attempt with first / fallback / retry and the previous status", async () => {
  // Primary 503 (switch), fallback 500 (plain retry), fallback succeeds.
  const r = rig([503, 500, { sse: [finish] }]);
  // Every hook call, in order.
  const seen: unknown[] = [];
  // Streaming plus the hook: the combination resume-assist uses.
  const outcome = await generateGeminiContent(r.db, { ...r.base, fallbackModel: "m-fallback", onText: () => {}, onAttempt: (i) => seen.push(i) });
  // The fallback answered.
  assert.equal(outcome.ok, true);
  // Exactly one call per attempt, each naming the model that attempt then called.
  assert.deepEqual(seen, [
    { attempt: 1, model: "m-primary", reason: "first" },
    { attempt: 2, model: "m-fallback", reason: "fallback", previousStatus: 503 },
    { attempt: 3, model: "m-fallback", reason: "retry", previousStatus: 500 },
  ]);
  // Cross-check against the requests themselves.
  assert.deepEqual(r.calls(), ["m-primary:streamGenerateContent", "m-fallback:streamGenerateContent", "m-fallback:streamGenerateContent"]);
});

test("onAttempt reports a 429 rotation as a retry with previousStatus 429", async () => {
  // Quota on key 1, success on key 2 (non-streaming: the hook works without onText).
  const r = rig([429, "json"]);
  // Every hook call, in order.
  const seen: unknown[] = [];
  // No onText, so the plain generateContent path runs.
  const outcome = await generateGeminiContent(r.db, { ...r.base, onAttempt: (i) => seen.push(i) });
  // Quota rotation recovered on key 2.
  assert.equal(outcome.ok, true);
  // The retry names the 429 that caused it.
  assert.deepEqual(seen, [
    { attempt: 1, model: "m-primary", reason: "first" },
    { attempt: 2, model: "m-primary", reason: "retry", previousStatus: 429 },
  ]);
});

// --- interactive: fail fast -----------------------------------------------------------------------

test("interactive: the first 503 switches to the fallback with NO sleep, and all gaps total <= 1.5 s", async () => {
  // Every attempt sheds load, the worst case the chat hit live (42 s and 67 s waits on 2026-11-18).
  const r = rig([503, 503, 503, 503]);
  // Interactive with a fallback: resume-assist's configuration.
  const outcome = await generateGeminiContent(r.db, { ...r.base, fallbackModel: "m-fallback", interactive: true });
  // Every attempt failed, so the verdict is still a failure.
  assert.equal(outcome.ok, false);
  // Switched after the first 503, as without interactive.
  assert.deepEqual(r.calls(), ["m-primary:generateContent", "m-fallback:generateContent", "m-fallback:generateContent", "m-fallback:generateContent"]);
  // No sleep at the switch: only the two later gaps sleep, and briefly.
  assert.equal(r.sleepLog.length, 2);
  // The whole wait budget: today's schedule here sleeps 1250 + 16000 + 48000.
  assert.ok(r.sleepLog.reduce((a, b) => a + b, 0) <= 1500, `slept ${r.sleepLog.join("+")}`);
});

test("interactive without a fallback still caps every gap, even when Google hints Retry-After", async () => {
  // Four 503s on one model; the fetch adds a 10 s Retry-After hint to each.
  const r = rig([503, 503, 503, 503]);
  // Same seam, with the hint header added.
  const fetchSeam: typeof fetch = async (input, init) => {
    // The scripted error answer, re-wrapped to carry the header.
    const res = await r.base.fetchSeam(input, init);
    return new Response(await res.text(), { status: res.status, headers: { "retry-after": "10" } });
  };
  // Interactive, no fallback configured.
  await generateGeminiContent(r.db, { ...r.base, fetchSeam, interactive: true });
  // Three gaps, all short: a 10 s wait would blow the chat's budget.
  assert.equal(r.sleepLog.length, 3);
  // The total stays inside the chat budget despite three 10 s hints.
  assert.ok(r.sleepLog.reduce((a, b) => a + b, 0) <= 1500, `slept ${r.sleepLog.join("+")}`);
});
