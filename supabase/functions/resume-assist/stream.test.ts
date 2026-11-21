// Tests for the resume-assist latency work (2026-11-18): the NDJSON stream, the partial-note reader,
// the fail-fast call options and the cache-friendly prompt order. Every seam faked; no network.
import { test } from "node:test";
// Strict assertions.
import assert from "node:assert/strict";
// The module under test.
import { buildAssistPrompt, handleResumeAssist, parseAssistRequest, partialNote, type AssistDeps, type AssistRequest } from "./assist.ts";
// Types only, for the fake Gemini call.
import type { GeminiCallOutcome, GeminiResponseBody, GenerateGeminiOptions } from "../_shared/gemini/client.ts";

// The progress hooks builder A adds to the client; typed here so the fake can call them before A lands.
type StreamOptions = GenerateGeminiOptions & {
  // Accumulated text of the current attempt.
  readonly onText?: (text: string) => void;
  // Fired before each attempt.
  readonly onAttempt?: (info: { attempt: number; model: string; reason: "first" | "retry" | "fallback"; previousStatus?: number }) => void;
  // Short retry gaps, instant model switch.
  readonly interactive?: boolean;
};

// The answer the fake model gives: note first, as the schema now orders it.
const ANSWER = JSON.stringify({ note: 'Dropped "b0" \u2014 done.', ops: [{ op: "remove", id: "b0" }] });

// A valid request body, as the browser sends it.
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Same shape as assist.test.ts's fixture, so both suites test one wire format.
  return {
    instruction: "Add Kafka and make b1 about latency",
    job: { title: "Backend Engineer", company: "Acme", missing: ["Kafka"], description: "Build APIs with Kafka." },
    summary: "Engineer who ships APIs.",
    bullets: [
      { id: "b0", text: "Built a billing API serving 500 users." },
      { id: "b1", text: "Cut p95 latency by 30%." },
    ],
    skills: "TypeScript, Postgres",
    categories: ["Languages", "Tools"],
    ...overrides,
  };
}

// The parsed form of a body.
function parsed(overrides: Record<string, unknown> = {}): AssistRequest {
  // Through the real validator, so the fixture cannot drift from it.
  const out = parseAssistRequest(body(overrides));
  // A failure here is a broken fixture, not a finding.
  if (!out.ok) throw new Error(out.message);
  // The request.
  return out.request;
}

// Deps whose Gemini call runs `script` (which may fire the hooks) and then answers `answer`.
function deps(answer: GeminiCallOutcome<GeminiResponseBody> | Error, script: (o: StreamOptions) => void = () => {}): AssistDeps & { calls: StreamOptions[] } {
  // Every option set the handler passed.
  const calls: StreamOptions[] = [];
  // The deps object.
  return {
    calls,
    // Signs in as "u1", accepts token "good", switch on.
    connect: async () => ({
      ok: true,
      userId: "u1",
      db: {
        // Gate 1: only "good" is the app user.
        auth: { getUser: async (jwt: string) => (jwt === "good" ? { data: { user: { id: "u1" } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
        // Gate 2: the switch row reads enabled.
        from: () => ({ select: async () => ({ data: [{ system_enabled: true }], error: null }) }),
      },
      // Records, fires the hooks the script chooses, then answers (or throws).
      generate: async (options: GenerateGeminiOptions) => {
        // Recorded for the option assertions.
        calls.push(options as StreamOptions);
        // A tick first, so the handler has already returned its streaming Response, as with a real network call.
        await Promise.resolve();
        // The scripted hook calls.
        script(options as StreamOptions);
        // A throw exercises the crash path.
        if (answer instanceof Error) throw answer;
        // The configured answer.
        return answer;
      },
    }),
  };
}

// A successful outcome carrying `text`.
function ok(text: string): GeminiCallOutcome<GeminiResponseBody> {
  // The shape the client returns for a 200.
  return { ok: true, keyIndex: 1, attempts: 1, data: { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 300 } } };
}

// A POST, streaming or not.
function post(stream: boolean): Request {
  // The streaming opt-in is the Accept header, never a body field.
  const headers: Record<string, string> = { authorization: "Bearer good", "content-type": "application/json", ...(stream ? { accept: "application/x-ndjson" } : {}) };
  // Same body either way.
  return new Request("http://local/resume-assist", { method: "POST", headers, body: JSON.stringify(body()) });
}

// The NDJSON lines of a response, parsed.
async function lines(res: Response): Promise<Record<string, unknown>[]> {
  // The whole stream, then one object per non-empty line.
  return (await res.text()).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
}

// --- partialNote ---------------------------------------------------------------------

test("partialNote reads the note so far at every split point and never emits half an escape", () => {
  // Escapes of every kind, a surrogate pair, then the ops after the note.
  const full = JSON.stringify({ note: 'He said "hi" \\ ok\nnext \u00e9 \ud83d\ude00 end', ops: [] }).replace("\u00e9", "\\u00e9").replace("\ud83d\ude00", "\\ud83d\\ude00");
  // The decoded note, which every prefix must be a prefix of.
  const note = (JSON.parse(full) as { note: string }).note;
  // Each prefix length, as a chunk boundary could fall anywhere.
  for (let cut = 0; cut <= full.length; cut++) {
    // What the reader makes of the text so far.
    const got = partialNote(full.slice(0, cut));
    // Before the value starts there is no note yet.
    if (got === null) continue;
    // Always a true prefix of the final note: no half escape, no lone surrogate.
    assert.ok(note.startsWith(got), `cut ${cut}: ${JSON.stringify(got)}`);
    // A lone high surrogate would render as a broken glyph.
    assert.ok(!/[\ud800-\udbff]$/.test(got), `cut ${cut} ends in a lone high surrogate`);
  }
  // The complete text gives the complete note.
  assert.equal(partialNote(full), note);
  // A cut right after the backslash of \" holds the escape back.
  assert.equal(partialNote('{"note":"a\\'), "a");
  // A cut inside \u00e9 holds it back too.
  assert.equal(partialNote('{"note":"a\\u00'), "a");
  // No note key yet.
  assert.equal(partialNote('{"ops":['), null);
});

// --- schema --------------------------------------------------------------------------

test("the response schema puts note first, so the reply streams before the ops", () => {
  // The schema the call sends.
  const schema = buildAssistPrompt(parsed()).responseSchema as { properties: Record<string, unknown>; propertyOrdering?: string[] };
  // Gemini's explicit order (its schema dialect's propertyOrdering).
  assert.deepEqual(schema.propertyOrdering, ["note", "ops"]);
  // Key order matches, for any reader that goes by it.
  assert.equal(Object.keys(schema.properties)[0], "note");
});

// --- fail fast -----------------------------------------------------------------------

test("both paths call Gemini fail-fast: interactive, 15 s per attempt, two retries", async () => {
  // JSON path.
  const plain = deps(ok(ANSWER));
  // Called.
  await handleResumeAssist(post(false), plain);
  // Streaming path.
  const streamed = deps(ok(ANSWER));
  // Called and drained, so the call has run.
  await (await handleResumeAssist(post(true), streamed)).text();
  // Same three levers on both.
  for (const call of [plain.calls[0], streamed.calls[0]]) {
    // The first 503 switches model with no wait.
    assert.equal(call?.interactive, true);
    // 15 s, not 20 s, per attempt.
    assert.equal(call?.timeoutMs, 15_000);
    // Two retries.
    assert.equal(call?.maxRetries, 2);
  }
});

// --- streaming -----------------------------------------------------------------------

test("without the Accept header the answer is today's JSON, with no hooks passed", async () => {
  // Happy path.
  const d = deps(ok(ANSWER));
  // No opt-in.
  const res = await handleResumeAssist(post(false), d);
  // JSON, not NDJSON.
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  // Today's body.
  assert.equal(((await res.json()) as { status: string }).status, "ok");
  // No streaming hooks: the client stays on its non-streaming endpoint.
  assert.equal(d.calls[0]?.onText, undefined);
});

test("the NDJSON stream sends status, cumulative notes, a model switch, then the JSON path's body", async () => {
  // A first attempt that starts a note, a 503 fallback, then the full answer.
  const d = deps(ok(ANSWER), (o) => {
    // Attempt 1.
    o.onAttempt?.({ attempt: 1, model: "lite", reason: "first" });
    // Half a note.
    o.onText?.('{"note":"Dropped \\"b');
    // The same text again: no duplicate line.
    o.onText?.('{"note":"Dropped \\"b');
    // Overloaded: switch.
    o.onAttempt?.({ attempt: 2, model: "flash", reason: "fallback", previousStatus: 503 });
    // The new attempt's whole answer.
    o.onText?.(ANSWER);
  });
  // Opted in.
  const res = await handleResumeAssist(post(true), d);
  // NDJSON, 200, CORS like json().
  assert.equal(res.headers.get("content-type"), "application/x-ndjson");
  // The stream itself always opens with 200; the outcome rides in the result line.
  assert.equal(res.status, 200);
  // Every event, in order.
  const events = await lines(res);
  // What the JSON path would have answered for the same outcome.
  const plain = (await (await handleResumeAssist(post(false), deps(ok(ANSWER)))).json()) as Record<string, unknown>;
  // Exactly the contract's lines.
  assert.deepEqual(events, [
    { type: "status", stage: "thinking", text: "Thinking..." },
    { type: "note", text: 'Dropped "b' },
    { type: "status", stage: "switching_model", text: "Gemini is overloaded - trying the backup model..." },
    { type: "note", text: 'Dropped "b0" \u2014 done.' },
    { type: "result", httpStatus: 200, body: plain },
  ]);
});

test("a retry says so, and a failed outcome still ends in a result line with the JSON path's status and body", async () => {
  // A timeout retry, then every key cooling.
  const d = deps({ ok: false, reason: "all_keys_cooling", attempts: 0 }, (o) => o.onAttempt?.({ attempt: 2, model: "lite", reason: "retry", previousStatus: 0 }));
  // Opted in.
  const events = await lines(await handleResumeAssist(post(true), d));
  // The retry status, between thinking and the result.
  assert.deepEqual(events[1], { type: "status", stage: "retrying", text: "No answer yet - trying again..." });
  // 429 quota, the same body the JSON path sends.
  assert.deepEqual(events.at(-1), { type: "result", httpStatus: 429, body: { status: "quota", message: "The AI quota is used up for now. Try again later." } });
});

test("a crash inside the Gemini call still closes the stream with a 500 result", async () => {
  // The client throws.
  const events = await lines(await handleResumeAssist(post(true), deps(new Error("boom"))));
  // The same body withErrorBoundary answers a crash with, so the web reads one shape.
  assert.deepEqual(events.at(-1), { type: "result", httpStatus: 500, body: { success: false, error: "internal_error" } });
});

// --- prompt order (implicit caching) ---------------------------------------------------

test("the job comes before the resume, so an applied edit keeps the job in the cached prefix", () => {
  // Two asks on the same job, one after an edit changed a bullet.
  const before = buildAssistPrompt(parsed()).userContent;
  // The edited resume.
  const after = buildAssistPrompt(parsed({ bullets: [{ id: "b0", text: "Rewrote the billing API." }, { id: "b1", text: "Cut p95 latency by 30%." }] })).userContent;
  // The job block opens the user content.
  assert.equal(before.split("\n")[0], "JOB");
  // Everything up to the resume block is byte-identical across the edit.
  assert.equal(before.slice(0, before.indexOf("\nRESUME\n")), after.slice(0, after.indexOf("\nRESUME\n")));
});

test("the new message is last and the prefix before the chat is identical across asks", () => {
  // A first ask.
  const first = buildAssistPrompt(parsed()).userContent;
  // A later ask with history and a new message.
  const second = buildAssistPrompt(parsed({ instruction: "Shorter", history: [{ role: "user", text: "Shorten b0" }] })).userContent;
  // The message is the last line.
  assert.equal(second.split("\n").at(-1), "INSTRUCTION: Shorter");
  // The first ask's text minus its instruction is the second's prefix up to the chat.
  assert.equal(second.slice(0, second.indexOf("CHAT SO FAR:")), first.slice(0, first.lastIndexOf("INSTRUCTION: ")));
});


// --- first-chunk timeout (tailor pending #6, 2026-11-21) --------------------------------

test("the streamed chat gives up on a silent attempt after 8 s with no first chunk, not the whole 15 s", async () => {
  // Streaming path: the only path the first-chunk timer acts on.
  const streamed = deps(ok(ANSWER));
  // Called and drained, so the call has run.
  await (await handleResumeAssist(post(true), streamed)).text();
  // 8 s to the first byte: thinking is "low", so a healthy attempt starts streaming well before it.
  assert.equal(streamed.calls[0]?.firstChunkTimeoutMs, 8_000);
  // The total attempt budget is unchanged, so a slow but streaming answer still has 15 s.
  assert.equal(streamed.calls[0]?.timeoutMs, 15_000);
});

// --- the live note never claims a change (tailor pending #5 P0, 2026-11-21) ----------------------------------

test("the streamed note drops change claims while it is still being written, like the final note does", async () => {
  // The model claims a change, then says something true; the claim must never reach the screen, not even for a moment.
  const answer = JSON.stringify({ note: "I added Kafka to Tools. Kafka is in the job.", ops: [] });
  // Half the note, then the whole answer.
  const d = deps(ok(answer), (o) => {
    // Mid-sentence, the claim already complete.
    o.onText?.('{"note":"I added Kafka to Tools. Kaf');
    // Done.
    o.onText?.(answer);
  });
  // Opted in.
  const events = await lines(await handleResumeAssist(post(true), d));
  // Every note line, in order.
  const notes = events.filter((e) => e.type === "note").map((e) => e.text);
  // Only the true sentence, as it grew.
  assert.deepEqual(notes, ["Kaf", "Kafka is in the job."]);
});
