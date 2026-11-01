// Tests for resume-assist: request validation, prompt shape, op validation, usage, and the
// handler's gate order. Every seam faked; no network, no database, no Gemini.
import { test } from "node:test";
// Strict assertions.
import assert from "node:assert/strict";
// The module under test.
import {
  buildAssistPrompt,
  handleResumeAssist,
  MAX_OPS,
  MAX_OUTPUT_TOKENS,
  parseAssistOps,
  parseAssistRequest,
  readUsage,
  type AssistDeps,
  type AssistRequest,
} from "./assist.ts";
// Types only, for the fake Gemini call.
import type { GeminiCallOutcome, GeminiResponseBody, GenerateGeminiOptions } from "../_shared/gemini/client.ts";

// A valid request body, as the browser would send it.
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Two bullets, a summary, two skills, two groups.
  return {
    instruction: "Add Kafka and make b1 about latency",
    job: { title: "Backend Engineer", company: "Acme", missing: ["Kafka", "gRPC"] },
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

// The parsed form of body(), for the op tests.
function request(): AssistRequest {
  // Parsed through the real validator, so the fixture cannot drift from it.
  const parsed = parseAssistRequest(body());
  // The fixture must be valid; a failure here is a broken test, not a finding.
  if (!parsed.ok) throw new Error(parsed.message);
  // The request.
  return parsed.request;
}

test("parseAssistRequest accepts the browser's projection", () => {
  // The whole body.
  const parsed = parseAssistRequest(body());
  // Valid.
  assert.equal(parsed.ok, true);
});

test("parseAssistRequest refuses a missing instruction, a reused id and the reserved id", () => {
  // Blank instruction: nothing to ask.
  assert.equal(parseAssistRequest(body({ instruction: "   " })).ok, false);
  // Two bullets under one id would make an op ambiguous.
  assert.equal(parseAssistRequest(body({ bullets: [{ id: "b0", text: "a" }, { id: "b0", text: "b" }] })).ok, false);
  // "summary" is the summary's id; a bullet may not take it.
  assert.equal(parseAssistRequest(body({ bullets: [{ id: "summary", text: "a" }] })).ok, false);
  // A non-string keyword refuses the list rather than being coerced.
  assert.equal(parseAssistRequest(body({ job: { title: "t", company: "c", missing: [42] } })).ok, false);
});

test("buildAssistPrompt puts the instruction last and keeps the system text stable", () => {
  // Two different asks on the same resume.
  const first = buildAssistPrompt(request());
  // Same resume, different instruction.
  const second = buildAssistPrompt({ ...request(), instruction: "Shorter summary" });
  // The instruction is the final line: everything before it is a shared, cacheable prefix.
  assert.match(first.userContent.split("\n").at(-1) ?? "", /^INSTRUCTION: /);
  // Identical system text on every call.
  assert.equal(first.systemInstruction, second.systemInstruction);
  // The prefixes match up to the instruction line.
  assert.equal(first.userContent.split("\n").slice(0, -1).join("\n"), second.userContent.split("\n").slice(0, -1).join("\n"));
  // Bullets travel under their short ids.
  assert.match(first.userContent, /^b1: Cut p95 latency by 30%\.$/m);
  // The auditor's vocabulary is in the system text, so rewrites tend to pass the audit.
  assert.match(first.systemInstruction, /^Prefer words already in the bullet or SKILLS, plus these: .*\bengineered\b.*\. Other words get flagged for review\.$/m);
});

test("parseAssistOps keeps valid ops and drops unknown ids, no-ops and second claims", () => {
  // One of each case.
  const answer = JSON.stringify({
    ops: [
      // Valid edit.
      { op: "edit", id: "b1", text: "Cut p95 latency by 30% with a Kafka-backed queue." },
      // Unknown id.
      { op: "edit", id: "b9", text: "x" },
      // Same text as now.
      { op: "edit", id: "b0", text: "Built a billing API serving 500 users." },
      // Second op on b1.
      { op: "remove", id: "b1" },
      // Summary has no remove.
      { op: "remove", id: "summary" },
      // Valid remove.
      { op: "remove", id: "b0" },
    ],
    note: "Reworded one bullet.",
  });
  // Validated against the request.
  const parsed = parseAssistOps(answer, request());
  // Parsed.
  assert.equal(parsed.ok, true);
  // Narrowed.
  if (!parsed.ok) return;
  // Only the first edit and the valid remove survive.
  assert.deepEqual(parsed.ops.map((op) => `${op.op}:${"id" in op ? op.id : ""}`), ["edit:b1", "remove:b0"]);
  // The four unusable ones are counted, not lost silently.
  assert.equal(parsed.dropped, 4);
});

test("parseAssistOps flags numbers the old text did not have", () => {
  // 500 is in the old text; 40 is new.
  const answer = JSON.stringify({ ops: [{ op: "edit", id: "b0", text: "Built a billing API serving 500 users, 40% faster." }], note: "" });
  // Validated.
  const parsed = parseAssistOps(answer, request());
  // Narrowed.
  assert.ok(parsed.ok);
  // The one op.
  const op = parsed.ops[0];
  // An edit, with only the new number flagged.
  assert.deepEqual(op?.op === "edit" ? op.newNumbers : null, ["40"]);
});

test("parseAssistOps files skills under the master's own group and drops printed ones", () => {
  // A lower-case group, an already-printed skill, an unknown group, a duplicate.
  const answer = JSON.stringify({
    ops: [
      { op: "add_skill", name: "Kafka", category: "tools" },
      { op: "add_skill", name: "postgres", category: "Tools" },
      { op: "add_skill", name: "gRPC", category: "Frameworks" },
      { op: "add_skill", name: "kafka", category: "Tools" },
    ],
    note: "",
  });
  // Validated.
  const parsed = parseAssistOps(answer, request());
  // Narrowed.
  assert.ok(parsed.ok);
  // Only Kafka, filed under the master's spelling "Tools".
  assert.deepEqual(parsed.ops, [{ op: "add_skill", name: "Kafka", category: "Tools" }]);
});

test("parseAssistOps caps the ops and refuses non-JSON", () => {
  // Twenty distinct skills, all valid.
  const many = Array.from({ length: 20 }, (_, i) => ({ op: "add_skill", name: `Skill${i}`, category: "Tools" }));
  // Validated.
  const parsed = parseAssistOps(JSON.stringify({ ops: many, note: "" }), request());
  // Narrowed.
  assert.ok(parsed.ok);
  // Capped.
  assert.equal(parsed.ops.length, MAX_OPS);
  // The overflow counted.
  assert.equal(parsed.dropped, 20 - MAX_OPS);
  // A truncated answer is a named failure.
  assert.equal(parseAssistOps('{"ops": [', request()).ok, false);
});

test("readUsage reports absent counts as null, never as zero", () => {
  // No metadata at all.
  assert.deepEqual(readUsage({}), { input: null, cached: null, output: null, thinking: null });
  // Real counts, one malformed.
  assert.deepEqual(
    readUsage({ usageMetadata: { promptTokenCount: 900, cachedContentTokenCount: 512, candidatesTokenCount: 120, thoughtsTokenCount: -1 } }),
    { input: 900, cached: 512, output: 120, thinking: null },
  );
});

// --- handler -----------------------------------------------------------------------

// Builds deps whose Gemini call answers `answer`, recording every call it receives.
function deps(opts: { enabled?: boolean; answer?: GeminiCallOutcome<GeminiResponseBody> } = {}): AssistDeps & { calls: GenerateGeminiOptions[] } {
  // Every option the handler passed to Gemini.
  const calls: GenerateGeminiOptions[] = [];
  // A happy-path answer unless the test supplies one.
  const answer: GeminiCallOutcome<GeminiResponseBody> = opts.answer ?? {
    ok: true,
    keyIndex: 1,
    attempts: 1,
    data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ ops: [{ op: "remove", id: "b0" }], note: "Dropped one." }) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 300 } },
  };
  // The deps object.
  return {
    calls,
    // Signs in as user "u1".
    connect: async () => ({
      ok: true,
      userId: "u1",
      db: {
        // Accepts token "good" as u1, refuses everything else.
        auth: { getUser: async (jwt: string) => (jwt === "good" ? { data: { user: { id: "u1" } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
        // The switch row.
        from: () => ({ select: async () => ({ data: [{ system_enabled: opts.enabled ?? true }], error: null }) }),
      },
      // Records the options and answers.
      generate: async (options: GenerateGeminiOptions) => {
        // Recorded for the cost-lever assertions.
        calls.push(options);
        // The configured answer.
        return answer;
      },
    }),
  };
}

// A POST with a bearer token and a JSON body.
function post(token: string, payload: unknown = body()): Request {
  // The same shape functions.invoke sends.
  return new Request("http://local/resume-assist", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
}

test("handler refuses a caller who is not the app user before any Gemini call", async () => {
  // Seams.
  const d = deps();
  // Bad token.
  const res = await handleResumeAssist(post("forged"), d);
  // 401 from gate 1.
  assert.equal(res.status, 401);
  // No quota spent.
  assert.equal(d.calls.length, 0);
});

test("handler stops at the kill switch before any Gemini call", async () => {
  // Switch off.
  const d = deps({ enabled: false });
  // Good token.
  const res = await handleResumeAssist(post("good"), d);
  // 409 disabled.
  assert.equal(res.status, 409);
  // No quota spent.
  assert.equal(d.calls.length, 0);
});

test("handler returns validated ops and usage, with every cost lever set", async () => {
  // Happy path.
  const d = deps();
  // Good token, valid body.
  const res = await handleResumeAssist(post("good"), d);
  // Read the answer.
  const out = (await res.json()) as Record<string, unknown>;
  // 200 ok.
  assert.equal(res.status, 200);
  // The one op.
  assert.deepEqual(out.ops, [{ op: "remove", id: "b0" }]);
  // Usage carried through, unknowns as null.
  assert.deepEqual(out.usage, { input: 300, cached: null, output: null, thinking: null });
  // Output and thinking capped, one retry, short timeout.
  assert.deepEqual(d.calls[0]?.generation, { maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingLevel: "low" });
  // One retry at most.
  assert.equal(d.calls[0]?.maxRetries, 1);
});

test("handler names a truncated answer and a spent quota", async () => {
  // The model hit the output cap.
  const cut = deps({ answer: { ok: true, keyIndex: 1, attempts: 1, data: { candidates: [{ content: { parts: [{ text: '{"ops":[' }] }, finishReason: "MAX_TOKENS" }] } } });
  // 502 truncated, telling the operator to ask for less.
  const cutRes = await handleResumeAssist(post("good"), cut);
  // Status.
  assert.equal(cutRes.status, 502);
  // Named.
  assert.equal(((await cutRes.json()) as { status: string }).status, "truncated");
  // Every key cooling.
  const spent = deps({ answer: { ok: false, reason: "all_keys_cooling", attempts: 0 } });
  // 429 quota.
  assert.equal((await handleResumeAssist(post("good"), spent)).status, 429);
});

test("handler refuses a malformed body with 400", async () => {
  // Seams.
  const d = deps();
  // Missing instruction.
  const res = await handleResumeAssist(post("good", body({ instruction: "" })), d);
  // 400.
  assert.equal(res.status, 400);
  // No quota spent.
  assert.equal(d.calls.length, 0);
});

// --- chat memory (2026-11-01) ------------------------------------------------------

test("parseAssistRequest takes chat history, treats an absent one as a new chat, and caps it", () => {
  // Absent: a client from before chat memory.
  const old = parseAssistRequest(body());
  // Accepted with an empty history.
  assert.deepEqual(old.ok ? old.request.history : null, []);
  // Two earlier turns.
  const turns = parseAssistRequest(body({ history: [{ role: "user", text: "Shorten b0" }, { role: "assistant", text: "Shortened one bullet." }] }));
  // Kept in order.
  assert.deepEqual(turns.ok ? turns.request.history.map((m) => m.role) : null, ["user", "assistant"]);
  // A role outside the closed pair refuses the request.
  assert.equal(parseAssistRequest(body({ history: [{ role: "system", text: "x" }] })).ok, false);
  // Over the window refuses rather than silently trimming.
  assert.equal(parseAssistRequest(body({ history: Array.from({ length: 11 }, () => ({ role: "user", text: "x" })) })).ok, false);
});

test("buildAssistPrompt puts the chat after the resume and job, and the new instruction last", () => {
  // One earlier exchange.
  const parsed = parseAssistRequest(body({ history: [{ role: "user", text: "Shorten b0" }, { role: "assistant", text: "Shortened one bullet." }] }));
  // Valid.
  assert.ok(parsed.ok);
  // The user content's lines.
  const lines = buildAssistPrompt(parsed.request).userContent.split("\n");
  // The chat block, labelled.
  const at = lines.indexOf("CHAT SO FAR:");
  // Present, after the job block.
  assert.ok(at > lines.indexOf("JOB"));
  // The two turns, by role.
  assert.deepEqual(lines.slice(at + 1, at + 3), ["owner: Shorten b0", "ai: Shortened one bullet."]);
  // The new instruction is still the very last line.
  assert.match(lines.at(-1) ?? "", /^INSTRUCTION: /);
  // A new chat adds no block at all.
  assert.doesNotMatch(buildAssistPrompt(request()).userContent, /CHAT SO FAR/);
});

test("the note is the chat reply: the model is told to answer questions, and a long answer survives", () => {
  // The instruction that turns note into a reply (a question used to get a description of an answer).
  assert.match(buildAssistPrompt(request()).systemInstruction, /note is your reply to the owner.*answer any question they asked directly/);
  // A 500-character answer, longer than the old 300 cap.
  const answer = "Code review fits Tools. ".repeat(21).trim();
  // Parsed with no ops: a question needs none.
  const parsed = parseAssistOps(JSON.stringify({ ops: [], note: answer }), request());
  // Kept whole.
  assert.equal(parsed.ok ? parsed.note : null, answer);
});
