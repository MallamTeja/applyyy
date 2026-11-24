// Tests for resume-assist: request validation, prompt shape, op validation, usage, and the
// handler's gate order. Every seam faked; no network, no database, no Gemini.
import { test } from "node:test";
// Strict assertions.
import assert from "node:assert/strict";
// The module under test.
import {
  buildAssistPrompt,
  handleResumeAssist,
  MAX_AVAILABLE,
  MAX_OPS,
  MAX_OUTPUT_TOKENS,
  MODEL_ONLY_OP_KINDS,
  parseAssistOps,
  parseAssistRequest,
  // S9k: the fit-to-lines planner and the instruction reader behind its fallback.
  planGroupFit,
  fitGroupAsked,
  readUsage,
  type AssistDeps,
  type AssistRequest,
} from "./assist.ts";
// Types only, for the fake Gemini call.
import type { GeminiCallOutcome, GeminiResponseBody, GenerateGeminiOptions } from "../_shared/gemini/client.ts";
// The width model the top-up fills with, so the test checks the lines the PDF prints (two lines since S9a, 2026-11-21).
import { skillGroupLineCount, TYPOGRAPHY_LADDER } from "../../../packages/resume-template/src/index.ts";
// The line limit the web's edit gate and the server share (S9a).
import { SKILL_GROUP_MAX_LINES } from "../../../packages/resume-template/src/page-fit.ts";

// True when a group prints within the shared line limit at every typography rung (the server's groupFits, restated).
const fitsTwoLines = (category: string, names: readonly string[]): boolean => TYPOGRAPHY_LADDER.every((_, index) => skillGroupLineCount(category, names, index) <= SKILL_GROUP_MAX_LINES);

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

/* The same request with the owner NAMING these skills (2026-11-09). Since parseAssistOps refuses a skill the master
   lacks unless the owner named it, the tests below that use invented names to exercise grouping, caps and labels name
   them first, so they keep testing what they were written for, not provenance. */
function naming(req: AssistRequest, ...names: string[]): AssistRequest {
  // Appended to the owner's own words, which is where the guard reads names from.
  return { ...req, instruction: `${req.instruction} Add ${names.join(", ")}.` };
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
  // Validated, with the owner naming gRPC (Kafka is already in the default instruction).
  const parsed = parseAssistOps(answer, naming(request(), "gRPC"));
  // Narrowed.
  assert.ok(parsed.ok);
  // Kafka, filed under the master's spelling "Tools"; gRPC's "Frameworks" is not one of the owner's groups
  // and no group is named for its kind, so it lands in the catch-all "Tools" (2026-11-07: a group is
  // decided, never asked for). The printed and the repeated ones stay dropped.
  assert.deepEqual(parsed.ops, [{ op: "add_skill", name: "Kafka", category: "Tools" }, { op: "add_skill", name: "gRPC", category: "Tools" }]);
});

test("parseAssistOps caps the ops and refuses non-JSON", () => {
  // Twenty valid moves. Moves, not skills: since 2026-11-21 all add_skill ops of one group are ONE change.
  const many = Array.from({ length: 20 }, () => ({ op: "move", id: "b1", direction: "up" }));
  // Validated.
  const parsed = parseAssistOps(JSON.stringify({ ops: many, note: "" }), structuredRequest());
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
  // Output and thinking capped, two retries, short timeout.
  assert.deepEqual(d.calls[0]?.generation, { maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingLevel: "low" });
  // Two retries (2026-11-05): both Gemini models 503'd in the same minute at 13:17, and one retry gave up.
  assert.equal(d.calls[0]?.maxRetries, 2);
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

// --- structure edits (2026-11-01) ---------------------------------------------------

// body() plus a structure: two entries, sections, bullets tagged with entries, two AVAILABLE items.
function structured(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // The flat body, with the structure fields the browser adds when the page passes one.
  return body({
    // The printed order.
    sections: ["summary", "experience", "projects", "skills"],
    // One job, one project.
    entries: [
      { id: "e0", section: "experience", label: "Aczen Technologies · Full Stack AI Engineer" },
      { id: "e1", section: "projects", label: "F1 Race Pace Predictor" },
    ],
    // Both bullets under the job, so b0 and b1 are siblings.
    bullets: [
      { id: "b0", text: "Built a billing API serving 500 users.", entry: "e0" },
      { id: "b1", text: "Cut p95 latency by 30%.", entry: "e0" },
    ],
    // A master bullet under the job, and a whole achievement.
    available: [
      { id: "m0", entry: "e0", text: "Mentored two interns." },
      { id: "n0", section: "achievements", label: "LeetCode" },
    ],
    // A test's own changes win.
    ...overrides,
  });
}

// The parsed form of structured().
function structuredRequest(): AssistRequest {
  // Through the real validator, so the fixture cannot drift from it.
  const parsed = parseAssistRequest(structured());
  // The fixture must be valid; a failure here is a broken test, not a finding.
  if (!parsed.ok) throw new Error(parsed.message);
  // The request.
  return parsed.request;
}

test("parseAssistRequest reads the structure, and treats its absence as none", () => {
  // The structured body.
  const parsed = parseAssistRequest(structured());
  // Valid, with every part read.
  assert.deepEqual(
    parsed.ok ? [parsed.request.sections.length, parsed.request.entries.length, parsed.request.bullets[0]?.entry, parsed.request.available.map((a) => a.kind)] : null,
    [4, 2, "e0", ["bullet", "entry"]],
  );
  // A client from before structure edits: empty structure, bullets without an entry.
  const old = parseAssistRequest(body());
  // Accepted.
  assert.deepEqual(old.ok ? [old.request.sections, old.request.entries, old.request.available, old.request.bullets[0]?.entry] : null, [[], [], [], null]);
});

test("parseAssistRequest refuses a structure that does not hang together", () => {
  // A bullet tagged with an entry the request did not list.
  assert.equal(parseAssistRequest(structured({ bullets: [{ id: "b0", text: "a", entry: "e9" }] })).ok, false);
  // A section name outside the closed list.
  assert.equal(parseAssistRequest(structured({ sections: ["experience", "hobbies"] })).ok, false);
  // The same section twice.
  assert.equal(parseAssistRequest(structured({ sections: ["experience", "experience"] })).ok, false);
  // An AVAILABLE bullet under an entry that is not on the resume.
  assert.equal(parseAssistRequest(structured({ available: [{ id: "m0", entry: "e9", text: "x" }] })).ok, false);
  // An AVAILABLE id that is neither mN nor nN cannot be told apart.
  assert.equal(parseAssistRequest(structured({ available: [{ id: "x0", section: "projects", label: "x" }] })).ok, false);
  // More than the cap is refused, never sliced.
  const tooMany = Array.from({ length: MAX_AVAILABLE + 1 }, (_, i) => ({ id: `n${i}`, section: "achievements", label: "x" }));
  // Refused.
  assert.equal(parseAssistRequest(structured({ available: tooMany })).ok, false);
});

test("buildAssistPrompt labels each entry once, tags bullets with it, and lists AVAILABLE before the chat", () => {
  // The user content's lines.
  const lines = buildAssistPrompt(structuredRequest()).userContent.split("\n");
  // The order, printed once.
  assert.ok(lines.includes("SECTION ORDER: summary, experience, projects, skills"));
  // Each entry once, with its section.
  assert.ok(lines.includes("e0 experience: Aczen Technologies · Full Stack AI Engineer"));
  // A bullet names its entry by id, not by repeating the label.
  assert.ok(lines.includes("b1 [e0]: Cut p95 latency by 30%."));
  // The master items: a bullet under its entry, a whole entry under its section.
  const from = lines.indexOf("AVAILABLE (in the master, not on the resume):") + 1;
  // Between the AVAILABLE label and the instruction (the job block leads since 2026-11-18; this request has no chat).
  assert.deepEqual(lines.slice(from, -1), ["m0 [e0]: Mentored two interns.", "n0 achievements: LeetCode"]);
  // The instruction is still last.
  assert.match(lines.at(-1) ?? "", /^INSTRUCTION: /);
  // Without a structure the prompt carries none of the new blocks (old clients cost nothing extra).
  assert.doesNotMatch(buildAssistPrompt(request()).userContent, /SECTION ORDER|ENTRIES|AVAILABLE|\[e/);
});

test("parseAssistOps keeps structure ops only for ids the request listed", () => {
  // One valid op of each kind, then one unusable variant of each.
  const answer = JSON.stringify({
    ops: [
      // Valid: b1 up within e0.
      { op: "move", id: "b1", direction: "up" },
      // Valid repeat: a move is one place, so it may repeat.
      { op: "move", id: "b1", direction: "up" },
      // Valid, capitalised by the model.
      { op: "move_section", section: "Projects", direction: "up" },
      // Valid restore of a master bullet.
      { op: "add_back", id: "m0" },
      // Valid new bullet under the project.
      { op: "new_bullet", entry: "e1", text: "Predicted race pace from lap telemetry." },
      // Unknown bullet id.
      { op: "move", id: "b9", direction: "up" },
      // A direction outside the closed pair.
      { op: "move", id: "b0", direction: "top" },
      // A section the resume does not print.
      { op: "move_section", section: "education", direction: "down" },
      // An AVAILABLE id that was never sent.
      { op: "add_back", id: "m7" },
      // The same item restored twice.
      { op: "add_back", id: "m0" },
      // An entry id that was never sent.
      { op: "new_bullet", entry: "e9", text: "x" },
      // The same new bullet twice.
      { op: "new_bullet", entry: "e1", text: "predicted race pace from lap telemetry." },
    ],
    note: "",
  });
  // Validated against the structured request, the owner dictating the new bullet (T10: an undictated one is refused).
  const parsed = parseAssistOps(answer, dictating("add a point: predicted race pace from lap telemetry"));
  // Narrowed.
  assert.ok(parsed.ok);
  // The five valid ops, in order, the section lower-cased to the printed name.
  assert.deepEqual(parsed.ops, [
    { op: "move", id: "b1", direction: "up" },
    { op: "move", id: "b1", direction: "up" },
    { op: "move_section", section: "projects", direction: "up" },
    { op: "add_back", id: "m0" },
    { op: "new_bullet", entry: "e1", text: "Predicted race pace from lap telemetry." },
  ]);
  // The seven unusable ones counted, not lost silently.
  assert.equal(parsed.dropped, 7);
});

test("parseAssistOps drops a move of a bullet removed earlier in the answer, and any move without a structure", () => {
  // Remove b0, then move it.
  const answer = JSON.stringify({ ops: [{ op: "remove", id: "b0" }, { op: "move", id: "b0", direction: "down" }], note: "" });
  // With a structure: the remove survives, the move does not.
  const parsed = parseAssistOps(answer, structuredRequest());
  // Narrowed.
  assert.ok(parsed.ok);
  // Only the remove.
  assert.deepEqual(parsed.ops, [{ op: "remove", id: "b0" }]);
  // No structure: a bullet with no entry has no siblings to move among.
  const flat = parseAssistOps(JSON.stringify({ ops: [{ op: "move", id: "b1", direction: "up" }], note: "" }), request());
  // Dropped and counted.
  assert.deepEqual(flat.ok ? [flat.ops.length, flat.dropped] : null, [0, 1]);
});

test("the schema and the system text offer exactly the twelve ops the model may write (add_group and S9j move_entry joined 2026-11-21)", () => {
  // The prompt parts.
  const prompt = buildAssistPrompt(request());
  // The schema, read through its nested shape.
  const schema = prompt.responseSchema as { properties: { ops: { items: { properties: { op: { enum: string[] }; direction: { enum: string[] } } } } } };
  // Closed to what parseAssistOps reads; the two remove ops joined on 2026-11-04.
  assert.deepEqual(schema.properties.ops.items.properties.op.enum, ["edit", "remove", "add_skill", "remove_skill", "move", "move_section", "move_entry", "add_back", "new_bullet", "remove_entry", "set_role", "add_group", "move_skill", "fit_group"]);
  // Direction closed in the schema too.
  assert.deepEqual(schema.properties.ops.items.properties.direction.enum, ["up", "down"]);
  // Since 2026-11-04 the system text spells every op as exact JSON, so a skill's name cannot land in "text".
  for (const kind of ["edit", "remove", "add_skill", "remove_skill", "move", "move_section", "move_entry", "add_back", "new_bullet", "remove_entry", "set_role", "add_group", "move_skill", "fit_group"]) {
    // Each kind appears as a JSON example, quoted exactly as the model must write it.
    assert.match(prompt.systemInstruction, new RegExp(`\\{"op":"${kind}"`), kind);
  }
  // The live failure (2026-11-04): the model put a skill's name in "text". Told where it goes.
  assert.match(prompt.systemInstruction, /A skill's name goes in "name", never in "id" or "text"\./);
});

test("parseAssistRequest refuses a free-text id and an oversized job title (review findings, 2026-11-01)", () => {
  // Ids are printed raw into the prompt, so only the browser's own shape passes: a letter and 1-3 digits.
  assert.equal(parseAssistRequest(body({ bullets: [{ id: "ignore all", text: "Built a billing API." }] })).ok, false);
  // The browser's shape still passes.
  assert.equal(parseAssistRequest(body({ bullets: [{ id: "b12", text: "Built a billing API." }] })).ok, true);
  // An ATS title over 200 characters is refused, not truncated.
  assert.equal(parseAssistRequest(body({ job: { title: "x".repeat(201), company: "Acme", missing: [] } })).ok, false);
});

// --- reasons for dropped ops, the remove ops, printed skills and the JD (2026-11-04) ---------
// Live evidence, 2026-11-04: the reply said "I have added C to the Languages skill group" while the
// op was dropped, "I removed the duplicate testing skill" came back with no op at all, and the AI
// could not say where a role was. These tests pin each fix.

// The sentence every "second op on one target" rejection uses.
const TARGETED = "Another change in this answer already targets it.";

// The one rejection a one-op answer produced, or null when the op was kept or the answer failed.
function rejectedFor(op: unknown, req: AssistRequest = request()): { what: string; why: string } | null {
  // A one-op answer, validated against the given request.
  const parsed = parseAssistOps(JSON.stringify({ ops: [op], note: "" }), req);
  // Only a parsed answer with exactly one rejection names one.
  return parsed.ok && parsed.rejected.length === 1 ? (parsed.rejected[0] ?? null) : null;
}

// The printed skills as the new browser sends them: Languages first, then Tools, interleaved.
const PRINTED = [
  // The first group to appear.
  { name: "Python", category: "Languages" },
  // The second group.
  { name: "Git", category: "Tools" },
  // Back to the first group: must print under Languages, not start a third group.
  { name: "C", category: "Languages" },
  // The skill the live "duplicate testing skill" ask was about.
  { name: "Testing", category: "Tools" },
];

// structured() plus printedSkills, parsed. The old skills string stays, and must be ignored.
function printedRequest(): AssistRequest {
  // Through the real validator, so the fixture cannot drift from it.
  const parsed = parseAssistRequest(structured({ printedSkills: PRINTED }));
  // The fixture must be valid; a failure here is a broken test, not a finding.
  if (!parsed.ok) throw new Error(parsed.message);
  // The request.
  return parsed.request;
}

test("an add_skill with no name is rejected with a reason, and a name in text or id is never used", () => {
  // No name at all.
  assert.deepEqual(rejectedFor({ op: "add_skill", category: "Languages" }), { what: "Add skill (no name)", why: "The AI's answer did not name the skill." });
  // The SUSPECTED live failure shape (unproven: raw answers are not stored): the skill in "text". Refused, never repaired.
  assert.deepEqual(rejectedFor({ op: "add_skill", text: "C", category: "Languages" }), { what: "Add skill (no name)", why: "The AI's answer did not name the skill." });
  // The same for "id".
  assert.equal(rejectedFor({ op: "add_skill", id: "C", category: "Languages" })?.why, "The AI's answer did not name the skill.");
});

// REWRITTEN 2026-11-07 (Teja: "make everything automatic"): a group the master lacks, or no group at all,
// used to be a rejection that asked the owner. Now the group is decided: the skill's kind, else a catch-all.
test("an add_skill under a group the master lacks, or under none, is filed by the skill's kind, never refused", () => {
  // Rust is a language: the owner's "Languages", whatever the model wrote.
  assert.equal(rejectedFor({ op: "add_skill", name: "Rust", category: "Programming" }, naming(request(), "Rust")), null);
  // The same with no group at all.
  const parsed = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "Rust" }], note: "" }), naming(request(), "Rust"));
  // Filed under Languages.
  assert.deepEqual(parsed.ok ? parsed.ops : null, [{ op: "add_skill", name: "Rust", category: "Languages" }]);
  // Six groups, none named for a language and no catch-all: the first group, deterministically.
  const six = parseAssistRequest(body({ categories: ["A", "B", "C", "D", "E", "F"] }));
  // Valid fixture.
  assert.ok(six.ok);
  // Filed under "A".
  const sixParsed = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "Rust", category: "Programming" }], note: "" }), naming(six.request, "Rust"));
  // The first group.
  assert.deepEqual(sixParsed.ok ? sixParsed.ops : null, [{ op: "add_skill", name: "Rust", category: "A" }]);
  // Already printed: named in the resume's own spelling.
  assert.deepEqual(rejectedFor({ op: "add_skill", name: "postgres", category: "Tools" }), { what: 'Add skill "postgres"', why: '"Postgres" is already on the resume.' });
});

test("remove_skill removes a printed skill in its printed spelling, and refuses an unprinted one", () => {
  // A mix: a valid remove in the wrong case, an unprinted one, a second claim, a name in "text".
  const parsed = parseAssistOps(
    JSON.stringify({
      ops: [
        // Valid, in the wrong case: kept in the printed spelling.
        { op: "remove_skill", name: "testing" },
        // Not printed.
        { op: "remove_skill", name: "Kafka" },
        // The same skill again: the first claim wins.
        { op: "remove_skill", name: "TESTING" },
        // A name in "text": refused, never read as the name.
        { op: "remove_skill", text: "Git" },
      ],
      note: "",
    }),
    printedRequest(),
  );
  // Narrowed.
  assert.ok(parsed.ok);
  // Only the first, carrying the resume's spelling so the browser can find it.
  assert.deepEqual(parsed.ops, [{ op: "remove_skill", name: "Testing" }]);
  // Each other one with its own reason.
  assert.deepEqual(parsed.rejected, [
    { what: 'Remove skill "Kafka"', why: '"Kafka" is not on the resume.' },
    { what: 'Remove skill "TESTING"', why: TARGETED },
    { what: "Remove skill (no name)", why: "The AI's answer did not name the skill." },
  ]);
  // Without printedSkills the old skills line is what is printed, as before.
  const flat = parseAssistOps(JSON.stringify({ ops: [{ op: "remove_skill", name: "postgres" }], note: "" }), request());
  // Kept, in the printed spelling.
  assert.deepEqual(flat.ok ? flat.ops : null, [{ op: "remove_skill", name: "Postgres" }]);
});

test("remove_entry removes a listed entry once and refuses an unknown one", () => {
  // A valid remove, an unknown id, the same entry again, and no id.
  const parsed = parseAssistOps(
    JSON.stringify({ ops: [{ op: "remove_entry", id: "e1" }, { op: "remove_entry", id: "e4" }, { op: "remove_entry", id: "e1" }, { op: "remove_entry" }], note: "" }),
    structuredRequest(),
  );
  // Narrowed.
  assert.ok(parsed.ok);
  // Only the first.
  assert.deepEqual(parsed.ops, [{ op: "remove_entry", id: "e1" }]);
  // Each other one named, a known entry by its label.
  assert.deepEqual(parsed.rejected, [
    { what: "Remove entry e4", why: "The AI named an entry it was not shown." },
    { what: 'Remove entry "F1 Race Pace Predictor"', why: TARGETED },
    { what: "Remove an entry", why: "The AI's answer did not name the entry." },
  ]);
  // The count still matches, for browsers that read only `dropped`.
  assert.equal(parsed.dropped, 3);
});

test("every failing check names its own reason", () => {
  // [op, request, expected rejection]; the structured request unless noted.
  const cases: [unknown, AssistRequest, { what: string; why: string }][] = [
    // edit with no id: nothing to target.
    [{ op: "edit", text: "x" }, structuredRequest(), { what: "Edit a bullet", why: "The AI's answer did not name the bullet." }],
    // edit of an id the model was never shown: labelled by the id it used.
    [{ op: "edit", id: "b9", text: "x" }, structuredRequest(), { what: "Edit b9", why: "The AI named a bullet it was not shown." }],
    // edit with no text: a known bullet is labelled by its own words.
    [{ op: "edit", id: "b0" }, structuredRequest(), { what: 'Edit bullet "Built a billing API serving 500 users."', why: "The AI's answer had no new text." }],
    // edit over the page's ceiling: refused, never cut.
    [{ op: "edit", id: "b0", text: "x".repeat(2001) }, structuredRequest(), { what: 'Edit bullet "Built a billing API serving 500 users."', why: "The new text is longer than 2000 characters." }],
    // edit that changes nothing.
    [{ op: "edit", id: "b0", text: "Built a billing API serving 500 users." }, structuredRequest(), { what: 'Edit bullet "Built a billing API serving 500 users."', why: "The new text is the same as the current text." }],
    // The summary has no remove.
    [{ op: "remove", id: "summary" }, structuredRequest(), { what: "Remove the summary", why: "The summary can be edited but not removed." }],
    // remove of an unknown bullet.
    [{ op: "remove", id: "b7" }, structuredRequest(), { what: "Remove b7", why: "The AI named a bullet it was not shown." }],
    // A direction outside the closed pair is not echoed into the label.
    [{ op: "move", id: "b0", direction: "top" }, structuredRequest(), { what: 'Move bullet "Built a billing API serving 500 users."', why: "The AI's answer did not say up or down." }],
    // move of an unknown bullet.
    [{ op: "move", id: "b9", direction: "up" }, structuredRequest(), { what: "Move b9 up", why: "The AI named a bullet it was not shown." }],
    // move without a structure: the old flat request has no entries.
    [{ op: "move", id: "b0", direction: "up" }, request(), { what: 'Move bullet "Built a billing API serving 500 users." up', why: "The page did not say which entry this bullet is under, so it cannot move." }],
    // A section the resume does not print.
    [{ op: "move_section", section: "education", direction: "down" }, structuredRequest(), { what: 'Move section "education" down', why: '"education" is not a section on this resume.' }],
    // No section order sent at all: a different reason from an unknown section.
    [{ op: "move_section", section: "projects", direction: "down" }, request(), { what: 'Move section "projects" down', why: "The page did not send the section order, so sections cannot move." }],
    // move_section with no section.
    [{ op: "move_section", direction: "up" }, structuredRequest(), { what: "Move a section up", why: "The AI's answer did not name the section." }],
    // add_back of an item never listed.
    [{ op: "add_back", id: "m7" }, structuredRequest(), { what: "Add back m7", why: "The AI named a master item it was not shown." }],
    // add_back with no id.
    [{ op: "add_back" }, structuredRequest(), { what: "Add back an item", why: "The AI's answer did not name the item to add back." }],
    // new_bullet under an unknown entry.
    [{ op: "new_bullet", entry: "e2", text: "x" }, structuredRequest(), { what: "New bullet under e2", why: "The AI named an entry it was not shown." }],
    // new_bullet with no text, under a known entry labelled by its name.
    [{ op: "new_bullet", entry: "e1" }, structuredRequest(), { what: 'New bullet under "F1 Race Pace Predictor"', why: "The AI's answer had no new text." }],
    // new_bullet with no entry.
    [{ op: "new_bullet", text: "x" }, structuredRequest(), { what: "New bullet under an entry", why: "The AI's answer did not name the entry." }],
    // A kind outside the closed union.
    [{ op: "rewrite_everything" }, structuredRequest(), { what: "Unknown change", why: "The AI proposed a kind of change this page cannot make." }],
    // Not even an object.
    ["not an object", structuredRequest(), { what: "Unknown change", why: "The AI proposed a kind of change this page cannot make." }],
  ];
  // Each case on its own, so a failure names the op.
  for (const [op, req, expected] of cases) {
    // One rejection, exactly this one.
    assert.deepEqual(rejectedFor(op, req), expected, JSON.stringify(op));
  }
  // A move of a bullet this answer removes gets its own reason.
  const removed = parseAssistOps(JSON.stringify({ ops: [{ op: "remove", id: "b0" }, { op: "move", id: "b0", direction: "down" }], note: "" }), structuredRequest());
  // The move's reason.
  assert.deepEqual(removed.ok ? removed.rejected : null, [{ what: 'Move bullet "Built a billing API serving 500 users." down', why: "Another change in this answer removes this bullet." }]);
  // Past the op cap, the reason says to ask for fewer.
  // Moves, each its own change (skills of one group would now be one change).
  const many = Array.from({ length: MAX_OPS + 1 }, () => ({ op: "move", id: "b1", direction: "up" }));
  // Validated.
  const capped = parseAssistOps(JSON.stringify({ ops: many, note: "" }), structuredRequest());
  // The thirteenth, named.
  assert.deepEqual(capped.ok ? capped.rejected : null, [{ what: 'Move bullet "Cut p95 latency by 30%." up', why: `More than ${MAX_OPS} changes in one answer; ask for fewer at once.` }]);
});

test("the rejected list stops at 20 while dropped keeps counting, and every label stays short", () => {
  // Twenty-five unknown bullets: none kept, so the op cap never applies.
  const parsed = parseAssistOps(JSON.stringify({ ops: Array.from({ length: 25 }, () => ({ op: "remove", id: "b9" })), note: "" }), request());
  // Narrowed.
  assert.ok(parsed.ok);
  // Twenty named.
  assert.equal(parsed.rejected.length, 20);
  // All twenty-five counted.
  assert.equal(parsed.dropped, 25);
  // Long model strings and long group names: every label and reason stays inside its cap.
  const groups = parseAssistRequest(body({ categories: Array.from({ length: 6 }, (_, i) => `${i}${"g".repeat(79)}`) }));
  // Valid fixture.
  assert.ok(groups.ok);
  // A huge name, an unknown huge group, a huge unprinted skill, a huge unknown id.
  const long = parseAssistOps(
    JSON.stringify({
      ops: [
        // A near-cap name under a huge unknown group: KEPT since 2026-11-07, filed under the first group.
        { op: "add_skill", name: "n".repeat(59), category: "c".repeat(5000) },
        // A huge unprinted skill: quoted in the why, clipped.
        { op: "remove_skill", name: "r".repeat(5000) },
        // A huge unknown id: shown in the what, clipped.
        { op: "edit", id: "x".repeat(5000), text: "t" },
        // A huge name: over the skill-name cap.
        { op: "add_skill", name: "s".repeat(5000), category: "Tools" },
      ],
      note: "",
    }),
    // The owner names the near-cap skill, so it reaches the group rule this test is about.
    naming(groups.request, "n".repeat(59)),
  );
  // Narrowed.
  assert.ok(long.ok);
  // Three reasons: the unknown-group add is no longer one (it is filed, not refused).
  assert.equal(long.rejected.length, 3);
  // And the kept add carries a real group, never the model's 5000-character one.
  assert.deepEqual(long.ops.map((op) => op.op === "add_skill" ? op.category : null), [`0${"g".repeat(79)}`]);
  // Each within the contract's caps.
  for (const r of long.rejected) assert.ok(r.what.length <= 120 && r.why.length <= 200, JSON.stringify(r));
});

test("printedSkills drives the duplicate check and the grouped SKILLS line", () => {
  // The request with printed skills; its old skills string says "TypeScript, Postgres".
  // Postgres named by the owner, so the add below is judged on the duplicate rule alone.
  const req = naming(printedRequest(), "Postgres");
  // "c" is printed under Languages, so adding it is a duplicate.
  assert.deepEqual(rejectedFor({ op: "add_skill", name: "c", category: "Languages" }, req), { what: 'Add skill "c"', why: '"C" is already on the resume.' });
  // Postgres is only in the stale string, which printedSkills overrides: the add passes.
  const parsed = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "Postgres", category: "Tools" }], note: "" }), req);
  // Kept.
  assert.deepEqual(parsed.ok ? parsed.ops : null, [{ op: "add_skill", name: "Postgres", category: "Tools" }]);
  // The prompt's lines.
  const lines = buildAssistPrompt(req).userContent.split("\n");
  // Groups in first-appearance order, names in printed order.
  assert.ok(lines.includes("SKILLS (by group): Languages: Python, C | Tools: Git, Testing"), lines.join("\n"));
  // The old flat line is gone, so the model sees one truth.
  assert.equal(lines.filter((line) => line.startsWith("SKILLS: ")).length, 0);
});

test("parseAssistRequest validates printedSkills all-or-nothing and allows a skill printed twice", () => {
  // A skill printed in two groups is the very duplicate the owner wants removed; it must be accepted.
  assert.equal(parseAssistRequest(structured({ printedSkills: [...PRINTED, { name: "testing", category: "Languages" }] })).ok, true);
  // An empty list is "nothing printed", not an error.
  assert.equal(parseAssistRequest(structured({ printedSkills: [] })).ok, true);
  // Not an array.
  assert.equal(parseAssistRequest(structured({ printedSkills: "Python, C" })).ok, false);
  // Over 80 items.
  assert.equal(parseAssistRequest(structured({ printedSkills: Array.from({ length: 81 }, (_, i) => ({ name: `S${i}`, category: "Tools" })) })).ok, false);
  // A blank name.
  assert.equal(parseAssistRequest(structured({ printedSkills: [{ name: " ", category: "Tools" }] })).ok, false);
  // A name over 60 characters.
  assert.equal(parseAssistRequest(structured({ printedSkills: [{ name: "x".repeat(61), category: "Tools" }] })).ok, false);
  // A category over 80 characters.
  assert.equal(parseAssistRequest(structured({ printedSkills: [{ name: "Go", category: "x".repeat(81) }] })).ok, false);
  // A missing category.
  assert.equal(parseAssistRequest(structured({ printedSkills: [{ name: "Go" }] })).ok, false);
});

// structured() plus a two-turn chat, the fixture for the JOB block tests.
function withJob(job: Record<string, unknown>): Record<string, unknown> {
  // The usual job fields, then the test's own.
  return structured({ job: { title: "Backend Engineer", company: "Acme", missing: ["Kafka", "gRPC"], ...job }, history: [{ role: "user", text: "Shorten b0" }, { role: "assistant", text: "Shortened one bullet." }] });
}

// The prompt lines for a body, which must be valid.
function promptLines(raw: Record<string, unknown>): string[] {
  // Through the real validator.
  const parsed = parseAssistRequest(raw);
  // A failure here is a broken test, not a finding.
  if (!parsed.ok) throw new Error(parsed.message);
  // One line per element.
  return buildAssistPrompt(parsed.request).userContent.split("\n");
}

// The exact prompt for withJob({}) BEFORE the 2026-11-04 change, captured from the old code. An old
// client's request must still produce these bytes, so the implicit cache and old asks are unaffected.
// 2026-11-18: the same lines, with the JOB block moved first (cache order, stream.test.ts); nothing else changed.
const PROMPT_BEFORE_2026_11_04 = [
  "JOB",
  "ROLE: Backend Engineer at Acme",
  "MISSING KEYWORDS: Kafka, gRPC",
  "RESUME",
  "SKILL GROUPS: Languages | Tools",
  "SKILLS: TypeScript, Postgres",
  "SUMMARY: Engineer who ships APIs.",
  "SECTION ORDER: summary, experience, projects, skills",
  "ENTRIES:",
  "e0 experience: Aczen Technologies · Full Stack AI Engineer",
  "e1 projects: F1 Race Pace Predictor",
  "BULLETS:",
  "b0 [e0]: Built a billing API serving 500 users.",
  "b1 [e0]: Cut p95 latency by 30%.",
  "AVAILABLE (in the master, not on the resume):",
  "m0 [e0]: Mentored two interns.",
  "n0 achievements: LeetCode",
  "CHAT SO FAR:",
  "owner: Shorten b0",
  "ai: Shortened one bullet.",
  "INSTRUCTION: Add Kafka and make b1 about latency",
];

test("the JOB block carries location, arrangement and description only when sent, before the resume and the chat", () => {
  // All three sent; the description with the line breaks an ATS page leaves.
  const lines = promptLines(withJob({ location: "Bengaluru, India", arrangement: "hybrid", description: "We build payments.\n\n  Python required." }));
  // Right after the keywords, in this order, the description on one line.
  const at = lines.indexOf("MISSING KEYWORDS: Kafka, gRPC");
  // The three new lines, then the resume block (the job leads since 2026-11-18, for the cache prefix).
  assert.deepEqual(lines.slice(at + 1, at + 5), ["LOCATION: Bengaluru, India", "ARRANGEMENT: hybrid", "DESCRIPTION: We build payments. Python required.", "RESUME"]);
  // And the chat still comes after the job.
  assert.ok(lines.indexOf("CHAT SO FAR:") > at);
  // The instruction stays the very last line (the cache prefix depends on it).
  assert.match(lines.at(-1) ?? "", /^INSTRUCTION: /);
  // Only the location sent: only its line appears.
  assert.deepEqual(promptLines(withJob({ location: "Remote" })).filter((line) => /^(LOCATION|ARRANGEMENT|DESCRIPTION):/.test(line)), ["LOCATION: Remote"]);
  // Nothing new sent: byte-identical to the prompt before this change.
  assert.deepEqual(promptLines(withJob({})), PROMPT_BEFORE_2026_11_04);
  // Empty or blank strings are "absent", not an empty label.
  assert.deepEqual(promptLines(withJob({ location: "", arrangement: "  ", description: "" })), PROMPT_BEFORE_2026_11_04);
});

test("the request caps: a 1500-character instruction passes, 1501 does not, and the JD fields are bounded, never cut", () => {
  // The new instruction ceiling.
  assert.equal(parseAssistRequest(body({ instruction: "x".repeat(1500) })).ok, true);
  // One over.
  assert.equal(parseAssistRequest(body({ instruction: "x".repeat(1501) })).ok, false);
  // A description at the cap.
  assert.equal(parseAssistRequest(withJob({ description: "x".repeat(8000) })).ok, true);
  // One over: refused with a named message, not truncated.
  const long = parseAssistRequest(withJob({ description: "x".repeat(8001) }));
  // The message names the field.
  assert.match(long.ok ? "" : long.message, /job\.description/);
  // Location over 300.
  assert.equal(parseAssistRequest(withJob({ location: "x".repeat(301) })).ok, false);
  // Arrangement over 20.
  assert.equal(parseAssistRequest(withJob({ arrangement: "x".repeat(21) })).ok, false);
  // A wrong type is refused, never coerced: a number is not a location, null is not "absent".
  assert.equal(parseAssistRequest(withJob({ location: 42 })).ok, false);
  // Null.
  assert.equal(parseAssistRequest(withJob({ description: null })).ok, false);
});

test("the system text forbids the reply from claiming a change and says where other edits are made", () => {
  // The stable system text.
  const system = buildAssistPrompt(request()).systemInstruction;
  // The never-claim rule (the live reply said "I have added C" while the op was dropped).
  assert.match(system, /must never say you added, removed, changed, moved or applied anything, and never promise a change/);
  // Why: the app lists every op and whether it landed.
  assert.match(system, /the app lists every op and whether it landed/);
  // A request no op can do is answered plainly, with where it can be done.
  assert.match(system, /no op can do, say so plainly and say where it can be done/);
  // Master-owned facts are edited on the Master profile page.
  assert.match(system, /cannot be changed here.*Master profile page/);
  // The JOB block answers questions about the role.
  assert.match(system, /Use JOB to answer questions about the role/);
  // The old "say what your ops change" rule is gone.
  assert.doesNotMatch(system, /say what your ops change/);
  // Still one stable prefix: no request data leaks into it.
  assert.equal(buildAssistPrompt(printedRequest()).systemInstruction, system);
});

test("handler returns the reasons beside the ops, with dropped equal to their count", async () => {
  // An answer with one valid op and one nameless skill.
  const d = deps({
    answer: {
      ok: true,
      keyIndex: 1,
      attempts: 1,
      data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ ops: [{ op: "remove", id: "b0" }, { op: "add_skill", text: "C", category: "Languages" }], note: "Two changes below." }) }] }, finishReason: "STOP" }] },
    },
  });
  // Good token, valid body.
  const res = await handleResumeAssist(post("good"), d);
  // Read the answer.
  const out = (await res.json()) as { ops: unknown[]; dropped: number; rejected: { what: string; why: string }[]; note: string };
  // 200 ok.
  assert.equal(res.status, 200);
  // The valid op.
  assert.deepEqual(out.ops, [{ op: "remove", id: "b0" }]);
  // The dropped one, with its reason.
  assert.deepEqual(out.rejected, [{ what: "Add skill (no name)", why: "The AI's answer did not name the skill." }]);
  // Old browsers read only the count; it matches.
  assert.equal(out.dropped, out.rejected.length);
});

test("remove_skill keeps a category that names one of two same-named printed skills, and drops one that names none", () => {
  // Teja's 2026-11-01 case: "Testing" printed under two groups ("we have 2 testings in skills, remove one").
  const twice = parseAssistRequest(structured({ printedSkills: [{ name: "Testing", category: "Frameworks" }, { name: "Testing", category: "Tools" }, { name: "Git", category: "Tools" }] }));
  // The fixture must be valid; a failure here is a broken test, not a finding.
  if (!twice.ok) throw new Error(twice.message);
  // "from Tools", in another case: kept with the printed group's spelling, so the browser removes that copy.
  const picked = parseAssistOps(JSON.stringify({ ops: [{ op: "remove_skill", name: "testing", category: "tools" }], note: "" }), twice.request);
  // Narrowed.
  assert.deepEqual(picked.ok ? picked.ops : null, [{ op: "remove_skill", name: "Testing", category: "Tools" }]);
  // A group the skill does not print under is not passed on: the browser then takes the first copy.
  const stray = parseAssistOps(JSON.stringify({ ops: [{ op: "remove_skill", name: "Testing", category: "Databases" }], note: "" }), twice.request);
  // No category on the op.
  assert.deepEqual(stray.ok ? stray.ops : null, [{ op: "remove_skill", name: "Testing" }]);
});

// --- live bugs of 2026-11-05 13:17 IST (Teja, Cursor row): a group-less add_skill and a claimed no-op ---

test("add_skill: an already-printed skill is named as such even when the AI gave no group", () => {
  // Live: "I have added Node.js…" with Node.js already printed and no group; the reason said
  // "did not say which skill group", which hid the real one.
  assert.deepEqual(rejectedFor({ op: "add_skill", name: "postgres" }), { what: 'Add skill "postgres"', why: '"Postgres" is already on the resume.' });
});

test("add_skill: a missing or unknown group is taken from the group the owner named in the instruction", () => {
  // The owner's own words name the group; "&" and "and" are the same group.
  const named = parseAssistRequest(body({ instruction: "i mean in backend and systems group, add Kafka", categories: ["Languages", "Backend & Systems"] }));
  // Valid fixture.
  assert.ok(named.ok);
  // No group from the AI: the owner's group is used, in the master's spelling.
  const missing = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "Kafka" }], note: "" }), named.request);
  // Kept, with the resolved group.
  assert.deepEqual(missing.ok ? missing.ops : null, [{ op: "add_skill", name: "Kafka", category: "Backend & Systems" }]);
  // A group the master lacks: the owner's named group still wins over the AI's guess.
  const unknown = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "Kafka", category: "Infra" }], note: "" }), named.request);
  // Kept, same group.
  assert.deepEqual(unknown.ok ? unknown.ops : null, [{ op: "add_skill", name: "Kafka", category: "Backend & Systems" }]);
});

test("add_skill: with one group only, a group-less add lands in it", () => {
  // One group: nothing to choose between.
  const single = parseAssistRequest(body({ categories: ["Tools"] }));
  // Valid fixture.
  assert.ok(single.ok);
  // Kept under the only group.
  const parsed = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "Kafka" }], note: "" }), single.request);
  // The resolved op.
  assert.deepEqual(parsed.ok ? parsed.ops : null, [{ op: "add_skill", name: "Kafka", category: "Tools" }]);
});

test("the reply never claims a change: claim sentences are dropped, and a no-op answer says nothing changed", () => {
  // The live answer: a claim, about a skill that was already printed (so no op survives).
  const live = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "Postgres", category: "Tools" }], note: "I have added Postgres to the Tools skill group as requested." }), request());
  // Parsed.
  assert.ok(live.ok);
  // Nothing survived.
  assert.deepEqual(live.ops, []);
  // The reply comes from the outcome, never from the model's claim.
  assert.equal(live.note, 'Nothing was changed: "Postgres" is already on the resume.');
  // A claim beside a real answer: the claim goes, the answer stays.
  const mixed = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "Kafka", category: "Tools" }], note: "I added Kafka for you. Kafka fits Tools best." }), request());
  // Only the non-claim sentence is left.
  assert.equal(mixed.ok ? mixed.note : null, "Kafka fits Tools best.");
});

// --- master skills not on the resume (2026-11-05, live row ce0d1730) -------------------------------

// The live row's skills: the tailored resume printed only Git and GitHub under Tools; the master held
// eight more tools the model never saw, so three asks in a row ended at "check your Master profile page".
const LIVE_PRINTED = [{ name: "Git", category: "Tools" }, { name: "GitHub", category: "Tools" }];
// Master skills NOT printed, each in its master group (a subset of the live eight, two groups).
const LIVE_AVAILABLE = [{ name: "Postman", category: "Tools" }, { name: "Swagger/OpenAPI", category: "Tools" }, { name: "pytest", category: "Testing" }];
// The owner's exact second prompt on that row, typos kept: the model must read it as written.
const LIVE_PROMPT = "hey from my master resume add 2 more tool whcih are not there in this tail;ored resue";

test("the prompt lists the master skills not on the resume, by master group, and tells the model to add from them", () => {
  // The live row's body: printed Git/GitHub, available Postman, Swagger/OpenAPI, pytest.
  const parsed = parseAssistRequest(body({ instruction: LIVE_PROMPT, printedSkills: LIVE_PRINTED, availableSkills: LIVE_AVAILABLE, categories: ["Tools", "Testing"] }));
  // Valid, so the prompt can be built from it.
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  // The prompt the model receives.
  const prompt = buildAssistPrompt(parsed.request);
  // The user content, line by line.
  const lines = prompt.userContent.split("\n");
  // The available skills, grouped exactly like SKILLS so a group name means one thing.
  assert.ok(lines.includes("MASTER SKILLS NOT ON RESUME (by group): Tools: Postman, Swagger/OpenAPI | Testing: pytest"), lines.join("\n"));
  // The printed ones stay on their own line, so the model can tell printed from addable.
  assert.ok(lines.includes("SKILLS (by group): Tools: Git, GitHub"), lines.join("\n"));
  // The rule that lets the model use them: they are the owner's, so adding one invents nothing.
  assert.match(prompt.systemInstruction, /MASTER SKILLS NOT ON RESUME are the owner's own skills: when asked to add skills or tools, pick from it and use add_skill/);
  // And it must not send the owner away for a skill that list holds (the live deflection).
  assert.match(prompt.systemInstruction, /never send the owner to the Master profile page for a skill that list holds/);
});

test("a client that sends no availableSkills gets no MASTER SKILLS line (old body, same prompt shape)", () => {
  // body() has no availableSkills.
  const lines = buildAssistPrompt(request()).userContent.split("\n");
  // No empty or "(none)" line: absent means the browser offered nothing, not that the master is empty.
  assert.equal(lines.filter((line) => line.startsWith("MASTER SKILLS NOT ON RESUME")).length, 0);
});

test("parseAssistRequest validates availableSkills all-or-nothing, like printedSkills", () => {
  // An empty list is "none to offer", not an error.
  assert.equal(parseAssistRequest(body({ availableSkills: [] })).ok, true);
  // Not an array.
  assert.equal(parseAssistRequest(body({ availableSkills: "Postman, pytest" })).ok, false);
  // A missing category: the model would not know which group to file it under.
  assert.equal(parseAssistRequest(body({ availableSkills: [{ name: "Postman" }] })).ok, false);
  // Over 80 items is refused, not sliced: the browser picks which skills matter.
  assert.equal(parseAssistRequest(body({ availableSkills: Array.from({ length: 81 }, (_, i) => ({ name: `S${i}`, category: "Tools" })) })).ok, false);
});

test("the live ask, through the handler against a fake model: the prompt carries the master tools and two add_skill ops come back", async () => {
  // The model answers as it should once it can see the list: two master tools, into Tools.
  const d = deps({
    answer: {
      ok: true,
      keyIndex: 1,
      attempts: 1,
      data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ ops: [{ op: "add_skill", name: "Postman", category: "Tools" }, { op: "add_skill", name: "Swagger/OpenAPI", category: "Tools" }], note: "Postman and Swagger/OpenAPI are from your master." }) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 300 } },
    },
  });
  // The live row's body, posted as the browser does.
  const res = await handleResumeAssist(post("good", body({ instruction: LIVE_PROMPT, printedSkills: LIVE_PRINTED, availableSkills: LIVE_AVAILABLE, categories: ["Tools", "Testing"] })), d);
  // The answer.
  const out = (await res.json()) as Record<string, unknown>;
  // 200 ok.
  assert.equal(res.status, 200);
  // The model was shown the master tools: without this line it can only re-propose Git and GitHub.
  assert.match(d.calls[0]!.prompt.userContent, /MASTER SKILLS NOT ON RESUME \(by group\): Tools: Postman, Swagger\/OpenAPI \| Testing: pytest/);
  // Both adds survive the parser, filed under the existing Tools group.
  assert.deepEqual(out.ops, [{ op: "add_skill", name: "Postman", category: "Tools" }, { op: "add_skill", name: "Swagger/OpenAPI", category: "Tools" }]);
});

// 2026-11-06 live Revature row: the reply said "Added GCP, MySQL, Redis, MongoDB" and 0 ops landed. The
// first-person filter missed it (no "I"), so a claim reached the owner with nothing applied behind it.
test("a past-tense claim with no 'I' is dropped from the note, like a first-person one", () => {
  // Three claim shapes the first-person filter let through, each next to a sentence that is not a claim.
  for (const claim of ["Added GCP, MySQL, Redis, MongoDB to your Tools group.", "GCP is now on your resume.", "Done.", "Those skills have been added."]) {
    // Ops all failed: the note must lead with what happened and carry no claim.
    // The op fails because the skill is already printed (since 2026-11-07 a missing group no longer fails one).
    const parsed = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "postgres" }], note: claim + " Kafka fits Tools best." }), request());
    // Valid answer shape.
    assert.ok(parsed.ok);
    // The claim is gone, the honest remainder stays, and the failure leads.
    assert.equal(parsed.note, 'Nothing was changed: "Postgres" is already on the resume. Kafka fits Tools best.');
  }
});

// A reply the filter emptied (or the model left empty) must still say what the answer holds, or the panel
// shows a blank chat bubble above its change list.
test("an empty note gets a one-line summary of the surviving ops, or says nothing was proposed", () => {
  // One surviving op, model note empty.
  const one = parseAssistOps(JSON.stringify({ ops: [{ op: "edit", id: "b0", text: "Built a billing API serving 500 users with p95 under 80 ms." }], note: "" }), request());
  // Valid.
  assert.ok(one.ok);
  // Counted in words, pointing at the list that carries the detail.
  assert.equal(one.note, "Proposed 1 change. See the list below.");
  // A claim-only note on two surviving ops reads the same way, plural.
  const two = parseAssistOps(JSON.stringify({ ops: [{ op: "remove", id: "b0" }, { op: "add_skill", name: "Kafka", category: "Tools" }], note: "Added Kafka and removed b0." }), request());
  // Valid.
  assert.ok(two.ok);
  // Plural, and the claim is not echoed.
  assert.equal(two.note, "Proposed 2 changes. See the list below.");
  // No ops, no failures, no text: said, not blank.
  const none = parseAssistOps(JSON.stringify({ ops: [], note: "" }), request());
  // Valid.
  assert.ok(none.ok);
  // Said in words.
  assert.equal(none.note, "No changes proposed.");
});

// ---- add_skill files a skill under the master's own group (2026-11-07, Teja 10:10 IST) ---------------
// Live: "Add skill "Python"" and "Add skill "AWS"" each failed with "The AI's answer did not say which
// skill group", though both are master v20 skills (Python under Languages, AWS under DevOps & Cloud). The
// schema cannot make `category` required for one op kind, so the model may omit it; the server knows the
// answer and must never ask the owner for it.

// Master v20's groups, and two of its skills that are not on the resume.
const V20_GROUPS = ["AI", "Languages", "Frameworks", "Databases", "DevOps & Cloud", "Machine Learning", "Backend & Systems", "Tools"];
// What the browser sends as MASTER SKILLS NOT ON RESUME.
const V20_AVAILABLE = [{ name: "Python", category: "Languages" }, { name: "AWS", category: "DevOps & Cloud" }, { name: "Microsoft Azure", category: "DevOps & Cloud" }];

// The live request shape: the owner's ask, master v20's groups, the two unprinted master skills.
function v20Request(): AssistRequest {
  // Through the real validator, like every other fixture here.
  const parsed = parseAssistRequest(body({ instruction: "use the JD and more relevant skills and skill groups", categories: V20_GROUPS, availableSkills: V20_AVAILABLE }));
  // Valid fixture.
  if (!parsed.ok) throw new Error(parsed.message);
  // The request.
  return parsed.request;
}

// The kept ops for one answer.
function keptOps(ops: unknown[]): unknown {
  // The real parser over the v20 request.
  // The owner names every skill the fixture adds, so a non-master one is judged on its group alone.
  const parsed = parseAssistOps(JSON.stringify({ ops, note: "" }), naming(v20Request(), ...ops.map((op) => String((op as { name?: unknown }).name))));
  // Narrowed; a refused answer is a broken fixture.
  assert.ok(parsed.ok);
  // Every rejection would be a "could not be done" card: there must be none.
  assert.deepEqual(parsed.rejected, []);
  // The ops that reach the browser.
  return parsed.ops;
}

// The live failure, now filed. (Python and AWS also reach the right group by kind, so the master lookup's
// red-on-revert test is the next one, where kind and master disagree.)
test("add_skill: a master skill with no category is filed under the master's own group (live Python/AWS)", () => {
  // Exactly the live answer: two group-less adds.
  assert.deepEqual(keptOps([{ op: "add_skill", name: "Python" }, { op: "add_skill", name: "AWS" }]), [
    { op: "add_skill", name: "Python", category: "Languages" },
    { op: "add_skill", name: "AWS", category: "DevOps & Cloud" },
  ]);
});

// THE RED-ON-REVERT TEST for the master lookup: a master skill has exactly one true group; the model's
// guess never overrides it, and the master's spelling replaces the model's.
test("add_skill: the master's group wins over a different group the model wrote, and the master's spelling is used", () => {
  // A wrong group, and a spelled-out name for a master skill.
  assert.deepEqual(keptOps([{ op: "add_skill", name: "aws", category: "Tools" }, { op: "add_skill", name: "Azure" }]), [
    { op: "add_skill", name: "AWS", category: "DevOps & Cloud" },
    { op: "add_skill", name: "Microsoft Azure", category: "DevOps & Cloud" },
  ]);
});

// A skill the master does not hold still gets a group, deterministically, never a "could not do" card.
test("add_skill: a new skill with no usable group gets a deterministic group from its kind, else Tools", () => {
  // A known database term, a known language, and a skill no vocabulary knows; one with a group the master lacks.
  assert.deepEqual(keptOps([{ op: "add_skill", name: "Redis" }, { op: "add_skill", name: "Kotlin", category: "Programming" }, { op: "add_skill", name: "Dagster" }]), [
    { op: "add_skill", name: "Redis", category: "Databases" },
    { op: "add_skill", name: "Kotlin", category: "Languages" },
    { op: "add_skill", name: "Dagster", category: "Tools" },
  ]);
});

// The prompt says the field is required and where its value comes from.
test("add_skill: the system prompt makes category required and names its source", () => {
  // The stable system text.
  const system = buildAssistPrompt(v20Request()).systemInstruction;
  // Required, from SKILL GROUPS, and the master's own group for a master skill.
  assert.match(system, /add_skill ALWAYS carries "category"/);
  // The groups themselves reach the model in the resume block.
  assert.match(buildAssistPrompt(v20Request()).userContent, /SKILL GROUPS: AI \| Languages \| Frameworks \| Databases \| DevOps & Cloud/);
});

/* EXPLICIT ADDS (Teja, 2026-11-09, TrueFoundry "Frontend Intern" row): "add tailwind css to , anguar js too ,even
   though i dont have them in my master" came back "No changes made", twice. Ruling: a skill the OWNER NAMES is added
   even when the master lacks it (Apply still vouches for it into the master, attestSkill.ts); a skill nobody named
   and the master lacks is never added. The second half used to be prompt-only; the validator now enforces it.
   RED-ON-REVERT: without the ownerNamed guard in parseAssistOps, the "improve my skills" test keeps Kubernetes and C;
   without the Rules-line exception, the prompt test fails. */
test("explicit add: a skill the owner names is kept though the master lacks it, typo and split spelling included", () => {
  // Teja's live prompt, typos kept: "tailwind css" and "anguar js".
  const parsed = parseAssistRequest(body({ instruction: "add tailwind css to , anguar js too ,even though i dont have them in my master", availableSkills: LIVE_AVAILABLE }));
  // Valid fixture.
  assert.ok(parsed.ok);
  // The model's two adds, in its own spelling.
  const ops = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "Tailwind CSS", category: "Tools" }, { op: "add_skill", name: "AngularJS", category: "Tools" }], note: "" }), parsed.request);
  // Narrowed.
  assert.ok(ops.ok);
  // Both kept: "tailwind css" is the name split in two, "anguar js" is one letter off "AngularJS".
  assert.deepEqual(ops.ops, [{ op: "add_skill", name: "Tailwind CSS", category: "Tools" }, { op: "add_skill", name: "AngularJS", category: "Tools" }]);
  // Nothing refused.
  assert.deepEqual(ops.rejected, []);
});

test("explicit add: a skill the owner named in an EARLIER chat turn counts, so \"yes, do it\" works", () => {
  // The name is in the owner's earlier message, not in this one.
  const parsed = parseAssistRequest(body({ instruction: "yes, do it", history: [{ role: "user", text: "can you add Tailwind CSS?" }, { role: "assistant", text: "Tailwind CSS is not in your master." }] }));
  // Valid fixture.
  assert.ok(parsed.ok);
  // Kept.
  assert.equal(rejectedFor({ op: "add_skill", name: "Tailwind CSS", category: "Tools" }, parsed.request), null);
  // The AI's own turn never counts as the owner naming it.
  const aiOnly = parseAssistRequest(body({ instruction: "yes, do it", history: [{ role: "assistant", text: "Shall I add Tailwind CSS?" }] }));
  // Valid fixture.
  assert.ok(aiOnly.ok);
  // Refused: only the AI said it.
  assert.equal(rejectedFor({ op: "add_skill", name: "Tailwind CSS", category: "Tools" }, aiOnly.request)?.what, 'Add skill "Tailwind CSS"');
});

test("unprompted: \"improve my skills\" adds master skills only; a skill nobody named is refused with its reason", () => {
  // A vague ask, with real master skills on offer.
  const parsed = parseAssistRequest(body({ instruction: "can you improve my skills section", availableSkills: LIVE_AVAILABLE }));
  // Valid fixture.
  assert.ok(parsed.ok);
  // One master skill, one invented tool, one one-letter language the word "can" must not unlock.
  const ops = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "Postman", category: "Tools" }, { op: "add_skill", name: "Kubernetes", category: "Tools" }, { op: "add_skill", name: "C", category: "Languages" }], note: "" }), parsed.request);
  // Narrowed.
  assert.ok(ops.ok);
  // Only the master's own skill survives.
  assert.deepEqual(ops.ops, [{ op: "add_skill", name: "Postman", category: "Tools" }]);
  // Each invention is a card with the reason, never silently dropped.
  assert.deepEqual(ops.rejected.map((r) => r.what), ['Add skill "Kubernetes"', 'Add skill "C"']);
  // The reason says how to get it: name it.
  assert.match(ops.rejected[0]!.why, /not in your master profile/);
});

test("the Rules line itself carries the owner-named exception, so \"never invent tools\" cannot outrank it", () => {
  // The fixed system text.
  const system = String(buildAssistPrompt(request()).systemInstruction);
  // The Rules line, found by its own label.
  const rules = system.split("\n").find((line) => line.startsWith("Rules:")) ?? "";
  // The exception sits in the same sentence as the ban it qualifies.
  assert.match(rules, /Never invent .*tools.*except a skill or tool the owner names/);
});

// --- T10 (2026-11-10): new skill groups, filling a group, more points, and new_bullet truthfulness ---

test("T10 skill group: an owner-named new group is kept for an owner-named skill", () => {
  // The owner names both the skill (not in the master) and a group the master does not have.
  const parsed = parseAssistRequest(body({ instruction: "add Grafana under a new Observability group" }));
  // Valid fixture.
  assert.ok(parsed.ok);
  // The model files it under the owner's new group.
  const ops = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "Grafana", category: "Observability" }], note: "" }), parsed.request);
  // Narrowed.
  assert.ok(ops.ok);
  // Kept under the new group, as the owner wrote it, not forced into Languages/Tools.
  assert.deepEqual(ops.ops, [{ op: "add_skill", name: "Grafana", category: "Observability" }]);
  // A master with no groups at all still takes an owner-named group.
  const empty = parseAssistRequest(body({ instruction: "add Grafana under a new Observability group", categories: [] }));
  // Valid fixture.
  assert.ok(empty.ok);
  // The same op against an empty group list.
  const emptyOps = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "Grafana", category: "Observability" }], note: "" }), empty.request);
  // Narrowed.
  assert.ok(emptyOps.ok);
  // Kept, filed under the group the owner named.
  assert.deepEqual(emptyOps.ops, [{ op: "add_skill", name: "Grafana", category: "Observability" }]);
});

test("T10 skill group: a group nobody named is never invented", () => {
  // The owner names the skill but no group.
  const parsed = parseAssistRequest(body({ instruction: "add Grafana" }));
  // Valid fixture.
  assert.ok(parsed.ok);
  // The model invents a group.
  const ops = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "Grafana", category: "Observability" }], note: "" }), parsed.request);
  // Narrowed.
  assert.ok(ops.ok);
  // Filed under an existing group by the old chain ("Tools" is the catch-all), never "Observability".
  assert.deepEqual(ops.ops, [{ op: "add_skill", name: "Grafana", category: "Tools" }]);
  // With no groups at all, an unnamed group is still a rejection, not a new group.
  const empty = parseAssistRequest(body({ instruction: "add Grafana", categories: [] }));
  // Valid fixture.
  assert.ok(empty.ok);
  // Refused with the existing reason.
  assert.match(rejectedFor({ op: "add_skill", name: "Grafana", category: "Observability" }, empty.request)?.why ?? "", /did not say which skill group/);
  // A master skill keeps its master group even when the owner names another one.
  const master = parseAssistRequest(body({ instruction: "add Postman to a new Observability group", availableSkills: LIVE_AVAILABLE }));
  // Valid fixture.
  assert.ok(master.ok);
  // The model obeys the owner's group for a master skill.
  const masterOps = parseAssistOps(JSON.stringify({ ops: [{ op: "add_skill", name: "Postman", category: "Observability" }], note: "" }), master.request);
  // Narrowed.
  assert.ok(masterOps.ok);
  // The master's own group wins: the resume references the master node.
  assert.deepEqual(masterOps.ops, [{ op: "add_skill", name: "Postman", category: "Tools" }]);
});

test("T10 more skills: the prompt tells the model to fill a group from its master skills, job-relevant first", () => {
  // The fixed system text.
  const system = buildAssistPrompt(request()).systemInstruction;
  // The fill-a-group rule, job-relevant first, at least 4.
  assert.match(system, /add more skills to <group>.*MASTER SKILLS NOT ON RESUME.*DESCRIPTION or MISSING KEYWORDS name first.*at least 4/);
  // None left: no op, and ask the owner to name them.
  assert.match(system, /no more master skills and asks the owner to name the ones to add/);
  // The category rule allows a group the owner states.
  assert.match(system, /category must be one of SKILL GROUPS, or a new group the owner names/);
});

test("T10 more points: the prompt steers to AVAILABLE mN of that entry and to asking for dictation when none remain", () => {
  // The fixed system text.
  const system = buildAssistPrompt(request()).systemInstruction;
  // More points with no text: add_back that entry's mN items, job-relevant first.
  assert.match(system, /add more points to <entry>.*add_back that entry's AVAILABLE mN items, the most job-relevant first/);
  // None left: ask for dictation.
  assert.match(system, /no unused master bullets remain and asks the owner to dictate the point/);
  // Never a new_bullet the owner did not state.
  assert.match(system, /Never new_bullet text the owner did not state/);
});

// The structured request with the owner's own words, for the new_bullet truthfulness tests.
function dictating(instruction: string, history: unknown[] = []): AssistRequest {
  // Through the real validator.
  const parsed = parseAssistRequest(structured({ instruction, history }));
  // The fixture must be valid.
  if (!parsed.ok) throw new Error(parsed.message);
  // The request.
  return parsed.request;
}

test("T10 truthfulness: a new_bullet with a non-master, non-dictated claim is refused", () => {
  // The owner only asked for more points; the model invents a metric and a tool.
  const ops = parseAssistOps(JSON.stringify({ ops: [{ op: "new_bullet", entry: "e0", text: "Reduced latency by 40% using Kafka." }], note: "" }), dictating("add more points to the Aczen job"));
  // Narrowed.
  assert.ok(ops.ok);
  // Nothing kept.
  assert.equal(ops.ops.length, 0);
  // Named with the reason and the way out.
  assert.match(ops.rejected[0]?.why ?? "", /^That point is not in your master profile or your message.*Dictate it to add it\.$/);
  // Without the number, the invented tool alone is still refused.
  assert.equal(rejectedFor({ op: "new_bullet", entry: "e0", text: "Reduced latency using Kafka." }, dictating("add more points to the Aczen job"))?.what, 'New bullet under "Aczen Technologies · Full Stack AI Engineer"');
});

test("T10 truthfulness: a dictated point reformatted as a bullet is kept", () => {
  // The owner's own words, in their own casing and grammar.
  const req = dictating("add a point: i built a grafana dashboard for 3 services");
  // The model's bullet form: past-tense verb, capitalised tool, a framing word ("monitoring").
  const ops = parseAssistOps(JSON.stringify({ ops: [{ op: "new_bullet", entry: "e0", text: "Built a Grafana dashboard monitoring 3 services." }], note: "" }), req);
  // Narrowed.
  assert.ok(ops.ok);
  // Kept as written.
  assert.deepEqual(ops.ops, [{ op: "new_bullet", entry: "e0", text: "Built a Grafana dashboard monitoring 3 services." }]);
  // An inflection of the owner's word counts ("dashboards" for "dashboard"), and an earlier owner turn dictates too.
  const later = dictating("yes add it", [{ role: "user", text: "i automated deploys of the dashboard" }]);
  // Kept: "automated", "deploys", "dashboards" all come from the owner.
  assert.equal(rejectedFor({ op: "new_bullet", entry: "e0", text: "Automated deploys of the dashboards." }, later), null);
});

test("T10 truthfulness: an AI turn in history cannot dictate a bullet", () => {
  // The claim appears only in the assistant's message.
  const req = dictating("yes add it", [{ role: "user", text: "add more points" }, { role: "assistant", text: "Shall I add: Reduced latency by 40% using Kafka?" }]);
  // Refused: the AI cannot dictate the owner's claims.
  assert.match(rejectedFor({ op: "new_bullet", entry: "e0", text: "Reduced latency by 40% using Kafka." }, req)?.why ?? "", /not in your master profile or your message/);
});

test("T10 all of a group: an owner-named group's master skills survive the op cap ahead of unrequested adds", () => {
  // Live shape (Barclays row 9ae9a866, 2026-11-10): 11 master Tools skills nobody asked for, then the 7 master Databases.
  const tools = Array.from({ length: 11 }, (_, i) => ({ name: `Tool${i}`, category: "Tools" }));
  // The live master v32 Databases group, none printed.
  const databases = ["PostgreSQL", "pgvector", "Redis", "MySQL", "DBMS", "Supabase", "MongoDB"].map((name) => ({ name, category: "Databases" }));
  // The owner's own words from that turn.
  const parsed = parseAssistRequest(structured({ instruction: "add databases with all databases", categories: ["Languages", "Tools", "Databases"], availableSkills: [...tools, ...databases] }));
  // Valid fixture.
  assert.ok(parsed.ok);
  // The model's order: unrequested Tools adds, eleven moves, then the databases. A group is ONE change since 2026-11-21,
  // so the moves are what fill the cap: Tools (1) + 11 moves = 12, and a first-12 cut would drop every database.
  const moves = Array.from({ length: MAX_OPS - 1 }, () => ({ op: "move", id: "b1", direction: "up" }));
  // The whole answer.
  const answer = JSON.stringify({ ops: [...tools.map((skill) => ({ op: "add_skill", name: skill.name, category: skill.category })), ...moves, ...databases.map((skill) => ({ op: "add_skill", name: skill.name, category: skill.category }))], note: "" });
  // Validated.
  const ops = parseAssistOps(answer, parsed.request);
  // Narrowed.
  assert.ok(ops.ok);
  // Still capped: 13 changes (Databases, Tools, 11 moves) for 12 seats, so exactly one falls: the last move.
  assert.equal(ops.dropped, 1);
  // Every requested database survived the cap.
  assert.deepEqual(ops.ops.filter((op) => op.op === "add_skill" && op.category === "Databases").map((op) => (op.op === "add_skill" ? op.name : "")), databases.map((skill) => skill.name));
  // The prompt says it too: the named group first, never padded.
  assert.match(buildAssistPrompt(parsed.request).systemInstruction, /says "all", add every MASTER SKILLS NOT ON RESUME skill of that group first.*never pad an explicit request with unrequested adds/);
});

// --- T10 review round (2026-11-10): numbers, the dictation word set, irregular verbs, the cap and a swap ---

test("T10 truthfulness: a count in the request does not dictate a metric", () => {
  // "3" is how many points to add, not a fact about the work; every WORD of the bullet is the owner's.
  const req = dictating("add 3 more points: i handled services for the billing api");
  // The model turns the request count into a metric.
  const why = rejectedFor({ op: "new_bullet", entry: "e0", text: "Handled 3 services for the billing API." }, req)?.why ?? "";
  // Refused, naming the number.
  assert.match(why, /not in your master profile or your message \("3"\)/);
  // The same number next to the same thing IS dictated ("3 services" said, "3 services" written).
  assert.equal(rejectedFor({ op: "new_bullet", entry: "e0", text: "Handled 3 services for the billing API." }, dictating("i handled 3 services for the billing api")), null);
  // A unit counts as the thing: "40%" said, "40%" written.
  assert.equal(rejectedFor({ op: "new_bullet", entry: "e0", text: "Cut costs by 40%." }, dictating("i cut costs by 40%")), null);
});

test("T10 truthfulness: rhetorical claim words are not dictation", () => {
  // The owner names only the topic.
  const req = dictating("add a point about my Kafka work");
  // Every claim word here is in the auditor's rhetorical list; only "Kafka" is the owner's.
  const why = rejectedFor({ op: "new_bullet", entry: "e0", text: "Shipped production system serving users at scale using Kafka." }, req)?.why ?? "";
  // Refused: a reworded bullet may reuse grammar, never a claim the owner did not make.
  assert.match(why, /not in your master profile or your message/);
});

test("T10 truthfulness: 'I lead a team of 4' dictates 'Led a team of 4 …'", () => {
  // Irregular past: "led" is "lead".
  assert.equal(rejectedFor({ op: "new_bullet", entry: "e0", text: "Led a team of 4." }, dictating("i lead a team of 4")), null);
  // Doubled consonant: "planned" is "plan", "debugged" is "debug".
  assert.equal(rejectedFor({ op: "new_bullet", entry: "e0", text: "Planned sprints and debugged releases." }, dictating("i plan sprints and debug releases")), null);
  // Irregular past: "wrote" is "write", "ran" is "run".
  assert.equal(rejectedFor({ op: "new_bullet", entry: "e0", text: "Wrote docs and ran demos." }, dictating("i write docs and run demos")), null);
});

test("T10 op cap: a swap pair is kept or cut together", () => {
  // A master project entry, the add half of a projects swap.
  const parsed = parseAssistRequest(structured({ available: [{ id: "n0", section: "projects", label: "One-on-One" }] }));
  // Valid fixture.
  assert.ok(parsed.ok);
  // Eleven valid moves, then the swap: the remove is the 12th op, so the cap would keep it and cut its add.
  const answer = JSON.stringify({ ops: [...Array.from({ length: MAX_OPS - 1 }, () => ({ op: "move", id: "b1", direction: "up" })), { op: "remove_entry", id: "e1" }, { op: "add_back", id: "n0" }], note: "" });
  // Validated.
  const ops = parseAssistOps(answer, parsed.request);
  // Narrowed.
  assert.ok(ops.ok);
  // Neither half kept alone.
  assert.equal(ops.ops.some((op) => op.op === "remove_entry" || op.op === "add_back"), false);
  // Both named as dropped, the remove saying its partner was cut.
  assert.deepEqual(ops.rejected.map((r) => r.what), ['Remove entry "F1 Race Pace Predictor"', 'Add back "One-on-One"']);
  // The remove's reason names the swap.
  assert.match(ops.rejected[0]!.why, /swap/);
});

/* ---- 2026-11-11: set_role, owner-named skill lists with typos, "do it" follow-ups --------------------------------- */

/* One answer's ops parsed against a request: kept ops and refusals. */
function parsedOps(ops: unknown[], req: AssistRequest) {
  // The model's answer as the wire carries it.
  const parsed = parseAssistOps(JSON.stringify({ ops, note: "" }), req);
  // The fixture answer is always well-formed JSON.
  if (!parsed.ok) throw new Error("answer did not parse");
  // Kept and refused, side by side.
  return parsed;
}

test("set_role: the owner's dictated title for a JOB is kept, typo-tolerant on the owner's side", () => {
  // Teja's own words from the FamPay row, typo included.
  const req = dictating("also change aczen title full stack ai eng to data anylist intern");
  // The model spells it correctly.
  const out = parsedOps([{ op: "set_role", entry: "e0", text: "Data  Analyst Intern " }], req);
  // Kept, with the spacing collapsed to what will print.
  assert.deepEqual(out.ops, [{ op: "set_role", entry: "e0", text: "Data Analyst Intern" }]);
  // Nothing refused.
  assert.deepEqual(out.rejected, []);
});

test("set_role: a title the owner never said, a non-job entry, and a junk title are each refused with a reason", () => {
  // The owner asks about something else entirely; a posting could still steer the model toward a grander title.
  const req = dictating("make my summary shorter");
  // A title lifted from nowhere the owner typed.
  const invented = parsedOps([{ op: "set_role", entry: "e0", text: "Senior Staff Engineer" }], req);
  // Refused: the title is the owner's claim to make.
  assert.equal(invented.ops.length, 0);
  // The reason says to dictate it.
  assert.match(invented.rejected[0]!.why, /not the title you asked for/);
  // A project (e1) has no job title.
  const project = parsedOps([{ op: "set_role", entry: "e1", text: "Data Analyst Intern" }], dictating("set e1 title to data analyst intern"));
  // Refused with the experience-only reason.
  assert.match(project.rejected[0]!.why, /Only a job/);
  // Markup is not a printable title, even when the owner typed it.
  const junk = parsedOps([{ op: "set_role", entry: "e0", text: "<b>CTO</b>" }], dictating("set my title to <b>CTO</b>"));
  // Refused by the validator's own title shape.
  assert.match(junk.rejected[0]!.why, /A job title is/);
});

test("owner-named skills: 'type grpahy' names Typography (two typos, a swap counted once); an unnamed skill is still refused", () => {
  // Teja's RainFocus words, typos included.
  const req = dictating("add type grpahy , wireframing , ux skills etc.. in skills");
  // The model adds the three he named, plus one he did not.
  const out = parsedOps([
    // Named, two edits away.
    { op: "add_skill", name: "Typography", category: "Languages" },
    // Named exactly.
    { op: "add_skill", name: "Wireframing", category: "Languages" },
    // Named exactly.
    { op: "add_skill", name: "UX", category: "Languages" },
    // Never named.
    { op: "add_skill", name: "Figma", category: "Languages" },
  ], req);
  // The three named ones are kept.
  assert.deepEqual(out.ops.map((op) => ("name" in op ? op.name : op.op)), ["Typography", "Wireframing", "UX"]);
  // The unnamed one is refused, so the wider match did not open the gate to anything.
  assert.deepEqual(out.rejected.map((r) => r.what), ['Add skill "Figma"']);
});

test("the system text: titles are a set_role op, skills are not entries, moves carry a direction, and 'do it' repeats the request", () => {
  // The prompt parts.
  const prompt = buildAssistPrompt(request());
  // A job title is changed here, not sent to the Master profile page.
  assert.match(prompt.systemInstruction, /A JOB TITLE is the exception: .*use set_role/);
  // Skills are never sent to the Master profile page.
  assert.match(prompt.systemInstruction, /Skills are not entries: never send the owner to the Master profile page for a skill they name./);
  // A move without a direction is ruled out in words as well as by the parser.
  assert.match(prompt.systemInstruction, /move and move_section ALWAYS carry "direction"/);
  // S9j: a place states the end position, and the prompt says every edit is possible except personal details.
  assert.match(prompt.systemInstruction, /"op":"move_entry","entry":"e2","place":1/);
  // Same.
  assert.match(prompt.systemInstruction, /Personal details \(name, email, phone, links, location\) are never changed in this chat/);
  // "do it" is the previous request, never a reorder.
  assert.match(prompt.systemInstruction, /repeats the owner's previous request from CHAT SO FAR: make those ops now; it is never a reorder request./);
});

/* LIVE 2026-11-12, Harvey row fcf3a2dd: "devops and clousde too, hld lld too" came back with ONE op, Docker, though the
   master holds seven more DevOps & Cloud skills and "System Design (LLD/HLD)". The model's restraint is not a control
   (CLAUDE.md §6): the server tops up, on a turn that already adds skills, every group the owner's words name (one word of
   its name is enough, said exactly) to 6 skills, JD-relevant first, and adds a master skill the owner
   named by a short form in its parentheses ("hld" for "System Design (LLD/HLD)"). Master skills only: nothing invented.
   RED-ON-REVERT: without topUpNamedSkills, test 1 gets only Docker. */
// Master v41's two groups from the live row, in master order, with its duplicate Azure spellings.
const V41_AVAILABLE = [
  { name: "AWS", category: "DevOps & Cloud" },
  { name: "azure", category: "DevOps & Cloud" },
  { name: "CI/CD & GitHub Actions", category: "DevOps & Cloud" },
  { name: "Docker", category: "DevOps & Cloud" },
  { name: "Google Cloud Platform", category: "DevOps & Cloud" },
  { name: "Kubernetes", category: "DevOps & Cloud" },
  { name: "Microsoft Azure", category: "DevOps & Cloud" },
  { name: "Monitoring", category: "DevOps & Cloud" },
  { name: "Computer Networks", category: "CS Fundamentals" },
  { name: "DSA", category: "CS Fundamentals" },
  { name: "OOP", category: "CS Fundamentals" },
  { name: "Operating Systems", category: "CS Fundamentals" },
  { name: "System Design (LLD/HLD)", category: "CS Fundamentals" },
];
// The row's printed skills: none of either group.
const V41_PRINTED = [{ name: "Python", category: "Languages" }, { name: "Git", category: "Tools" }];

// The live row's request, with this turn's instruction and the job's missing keywords.
function v41Request(instruction: string, missing: string[] = []): AssistRequest {
  // Through the real validator.
  const parsed = parseAssistRequest(body({ instruction, job: { title: "Software Engineer", company: "Harvey", missing }, skills: "Python, Git", printedSkills: V41_PRINTED, availableSkills: V41_AVAILABLE, categories: ["Languages", "Tools", "DevOps & Cloud", "CS Fundamentals"] }));
  // Valid fixture.
  if (!parsed.ok) throw new Error(parsed.message);
  // The request.
  return parsed.request;
}

// The kept add_skill names, in order, for one model answer.
function addedNames(ops: unknown[], req: AssistRequest): string[] {
  // The real parser.
  const parsed = parseAssistOps(JSON.stringify({ ops, note: "" }), req);
  // A refused answer is a broken fixture.
  assert.ok(parsed.ok);
  // Each kept add_skill's name.
  return parsed.ops.flatMap((op) => (op.op === "add_skill" ? [op.name] : []));
}

test("top-up 1 (live fcf3a2dd): 'devops and clousde too, hld lld too' + only Docker fills DevOps & Cloud within two lines, JD first, and adds System Design", () => {
  // The live answer: Docker alone. Kubernetes and Monitoring are the job's missing keywords.
  const names = addedNames([{ op: "add_skill", name: "Docker", category: "DevOps & Cloud" }], v41Request("devops and clousde too, hld lld too", ["Kubernetes", "Monitoring"]));
  /* Docker first (the model's own), then the JD-named ones, then master order while the group fits TWO lines (S9a; one
     line until then, which stopped it at 6). One Azure, never both spellings: with two lines of room this test caught
     "azure" + "Microsoft Azure" both landing, because the vocabulary match was case-sensitive (skillTerm fixes it). */
  assert.deepEqual(names, ["Docker", "Kubernetes", "Monitoring", "AWS", "azure", "CI/CD & GitHub Actions", "Google Cloud Platform", "System Design (LLD/HLD)"]);
});

/* THE LINE LIMIT (Teja, 2026-11-12 13:57: "in 1 line but full in that 1 line"; two lines since round 6 / S9a, 2026-11-21,
   the same SKILL_GROUP_MAX_LINES the web's edit gate reads). A top-up fills the group's printed lines and stops where one
   more name would spill onto a third, never at a fixed count. RED-ON-REVERT: dropping the width check adds names up to
   the cap of 10, and the long names below spill past two lines well before that. */
test("top-up 4 (2026-11-12): a named group is topped up to its line limit, never a spill; 'all' still lifts both limits", () => {
  // Long real-world DevOps names: far more than two lines of them.
  const long = ["Google Cloud Platform", "CI/CD & GitHub Actions", "Infrastructure as Code", "Microsoft Azure", "Kubernetes", "Monitoring", "Terraform", "Prometheus & Grafana Stack", "Site Reliability Engineering", "Distributed Tracing Systems", "Configuration Management"];
  // Non-vacuity: Docker plus the first nine of them (ten, the cap) really spills, so only the line rule can stop it.
  assert.equal(fitsTwoLines("DevOps & Cloud", ["Docker", ...long.slice(0, 9)]), false, "ten fit the line limit; the line rule is not under test");
  // The request, those names available.
  const parsed = parseAssistRequest(body({ instruction: "devops too", job: { title: "Platform Engineer", company: "Example", missing: [] }, skills: "Python", printedSkills: [{ name: "Python", category: "Languages" }], availableSkills: [{ name: "Docker", category: "DevOps & Cloud" }, ...long.map((name) => ({ name, category: "DevOps & Cloud" }))], categories: ["Languages", "DevOps & Cloud"] }));
  // Valid fixture.
  if (!parsed.ok) throw new Error(parsed.message);
  // The model added Docker; the server tops up the rest of the line.
  const names = addedNames([{ op: "add_skill", name: "Docker", category: "DevOps & Cloud" }], parsed.request);
  // Within the line limit, by the tailor's own width model.
  assert.ok(fitsTwoLines("DevOps & Cloud", names), `the topped-up group spills: ${names.join(", ")}`);
  // FULL: no unseated name would still fit (or the cap of 10 is reached).
  assert.ok(names.length === 10 || long.filter((n) => !names.includes(n)).every((n) => !fitsTwoLines("DevOps & Cloud", [...names, n])), `room left on the lines: ${names.join(", ")}`);
  // "all": the owner dictated every skill of the group, so neither limit applies (all 12, spill and all).
  const all = parseAssistRequest(body({ instruction: "add all devops", job: { title: "Platform Engineer", company: "Example", missing: [] }, skills: "Python", printedSkills: [{ name: "Python", category: "Languages" }], availableSkills: [{ name: "Docker", category: "DevOps & Cloud" }, ...long.map((name) => ({ name, category: "DevOps & Cloud" }))], categories: ["Languages", "DevOps & Cloud"] }));
  // Valid fixture.
  if (!all.ok) throw new Error(all.message);
  // Every one of the twelve.
  assert.equal(addedNames([{ op: "add_skill", name: "Docker", category: "DevOps & Cloud" }], all.request).length, 12);
});

test("top-up 2: a skill named alone tops up nothing ('add docker' names no group)", () => {
  // The owner asked for one skill and got it.
  assert.deepEqual(addedNames([{ op: "add_skill", name: "Docker", category: "DevOps & Cloud" }], v41Request("add docker")), ["Docker"]);
});

test("top-up 3: a turn that adds no skill is never topped up ('remove devops stuff')", () => {
  // No add_skill in the answer: a removal or a question is not an add request, whatever group it names.
  assert.deepEqual(addedNames([], v41Request("remove devops stuff, and is hld needed?")), []);
});

// --- the cap counts a skill GROUP as one change (tailor pending #5 P3, 2026-11-21) ----------------------------
//
// Live (keep7 tailor-analysis, 361 chat turns): 17 replies hit the 12-op cap and Teja pasted its error back 3 times.
// The asks were group fills ("add tools with 6, cs fund 5, backend 5, ai 5"): one add_skill per skill spent the cap
// a skill at a time. MAX_OPS still guards the output budget; a group of adds is now ONE change against it.

// Four master groups of six skills each, none printed.
const FOUR_GROUPS = ["Tools", "CS Fundamentals", "Backend Engineering", "AI"].flatMap((group) => Array.from({ length: 6 }, (_, i) => ({ name: `${group.split(" ")[0]}${i}`, category: group })));

test("per-group cap: four group fills of six master skills are four changes, so all 24 survive", () => {
  // The owner's live wording, four groups in one message.
  const parsed = parseAssistRequest(body({ instruction: "add tools with 6, cs fund 6, backend 6, ai 6", categories: ["Languages", "Tools", "CS Fundamentals", "Backend Engineering", "AI"], availableSkills: FOUR_GROUPS }));
  // Valid fixture.
  if (!parsed.ok) throw new Error(parsed.message);
  // One add_skill per skill, as the model writes them.
  const ops = parsedOps(FOUR_GROUPS.map((skill) => ({ op: "add_skill", name: skill.name, category: skill.category })), parsed.request);
  // Every one kept: 24 ops, 4 changes, well under the cap.
  assert.equal(ops.ops.length, 24);
  // Nothing refused for the cap.
  assert.equal(ops.dropped, 0);
});

test("per-group cap: the top-up still fills a group this answer already touches when eleven other changes come first", () => {
  // Three short DevOps names that fit one line together.
  const devops = ["Docker", "Kubernetes", "Terraform"].map((name) => ({ name, category: "DevOps & Cloud" }));
  // "devops too": the owner names the group.
  const parsed = parseAssistRequest(structured({ instruction: "devops too", categories: ["Languages", "DevOps & Cloud"], availableSkills: devops }));
  // Valid fixture.
  if (!parsed.ok) throw new Error(parsed.message);
  // Eleven moves and Docker: twelve changes, the cap reached.
  const answer = [...Array.from({ length: MAX_OPS - 1 }, () => ({ op: "move", id: "b1", direction: "up" })), { op: "add_skill", name: "Docker", category: "DevOps & Cloud" }];
  // Topped up anyway: Kubernetes and Terraform join a group already counted, so they cost no change.
  assert.deepEqual(addedNames(answer, parsed.request), ["Docker", "Kubernetes", "Terraform"]);
});

// --- add_group: one op fills a skill group from the master (tailor pending #5 P3, 2026-11-21) -----------------
//
// The model writes ONE {"op":"add_group","name":"Tools","n":5} instead of five add_skill ops, which saves output tokens
// under the 2048 cap. The SERVER expands it into ordinary add_skill ops from the owner's master, so the browser never
// sees a new kind (its reader refuses a whole answer over one unknown kind) and nothing is invented.

// The live Tools wish list (keep7: Postman 40 apps, Cursor 41, Jira 30, Swagger 32, VS Code 38), none printed.
const TOOLS_MASTER = ["Postman", "Cursor", "Jira", "Swagger", "VS Code"].map((name) => ({ name, category: "Tools" }));

// A request whose master holds TOOLS_MASTER and whose job is missing Jira.
function toolsRequest(instruction: string): AssistRequest {
  // Through the real validator.
  const parsed = parseAssistRequest(body({ instruction, job: { title: "Backend Engineer", company: "Acme", missing: ["Jira"] }, categories: ["Languages", "Tools", "Databases"], availableSkills: TOOLS_MASTER }));
  // Valid fixture.
  if (!parsed.ok) throw new Error(parsed.message);
  // The request.
  return parsed.request;
}

test("add_group: one op becomes n add_skill ops from the master, the job's missing keywords first", () => {
  // The model's single op, the group in the owner's lower case.
  const ops = parsedOps([{ op: "add_group", name: "tools", n: 3 }], toolsRequest("add tools with 3"));
  // Three skills, Jira (the job asks for it) first, then master order; filed under the master's own group spelling.
  assert.deepEqual(ops.ops, [
    { op: "add_skill", name: "Jira", category: "Tools" },
    { op: "add_skill", name: "Postman", category: "Tools" },
    { op: "add_skill", name: "Cursor", category: "Tools" },
  ]);
  // Nothing refused.
  assert.equal(ops.dropped, 0);
});

test("add_group: the answer never carries add_group, so the browser's strict reader never sees it", () => {
  // Two group fills and a plain op, the way a live answer mixes them.
  const ops = parsedOps([{ op: "add_group", name: "Tools", n: 2 }, { op: "remove", id: "b0" }, { op: "add_group", name: "Databases", n: 4 }], toolsRequest("add tools and databases"));
  // Only kinds the web already reads; the model-only kind is gone from the answer.
  assert.deepEqual([...new Set(ops.ops.map((op) => op.op))].sort(), ["add_skill", "remove"]);
  // And it is listed as model-only, for the web contract test to subtract.
  assert.deepEqual([...MODEL_ONLY_OP_KINDS], ["add_group", "fit_group"]);
});

test("add_group: a group the master has nothing left for is refused with a reason, never filled with invented skills", () => {
  // Databases has no master skills in this fixture.
  const ops = parsedOps([{ op: "add_group", name: "Databases", n: 4 }], toolsRequest("add databases"));
  // No op.
  assert.deepEqual(ops.ops, []);
  // The reason names the group and what the owner can do.
  assert.deepEqual(ops.rejected, [{ what: 'Add group "Databases"', why: '"Databases" has no master skills left to add. Name the ones you want and they are added.' }]);
});

test("add_group: n is capped at the group size of 10 unless the owner says all, and a bad n means that size", () => {
  // Twelve short master skills in one group (2026-11-21: was nine, which no longer reach the cap of 10), so the line
  // width never decides.
  const nine = Array.from({ length: 12 }, (_, i) => ({ name: `T${i}`, category: "Tools" }));
  // A request with them.
  const req = (instruction: string): AssistRequest => {
    // Through the real validator.
    const parsed = parseAssistRequest(body({ instruction, categories: ["Tools"], availableSkills: nine }));
    // Valid fixture.
    if (!parsed.ok) throw new Error(parsed.message);
    // The request.
    return parsed.request;
  };
  // Twenty asked: ten given (Teja 2026-11-21 14:41: up to 10 per group; 7 from 2026-11-12).
  assert.equal(parsedOps([{ op: "add_group", name: "Tools", n: 20 }], req("add tools")).ops.length, 10);
  // A missing, fractional or non-positive n is not a number of skills: the group size.
  for (const n of [undefined, 2.5, 0, -3, "4"]) assert.equal(parsedOps([{ op: "add_group", name: "Tools", n }], req("add tools")).ops.length, 10, String(n));
  // "all": every one, as the fill rule already says for add_skill.
  assert.equal(parsedOps([{ op: "add_group", name: "Tools", n: 3 }], req("add all tools")).ops.length, 12);
});

// --- set_role on the allow-listed experience (Teja 2026-11-18 21:55; orch queue 2026-11-21) ---------------------------
//
// The web now refuses an unlisted Aczen title (tailoredEdits.ts setEntryRole), so a proposal of one only costs Teja a
// round trip. The chat request names entries by eN + label, not by master id, so the server recognises the allow-listed
// experience by the title it PRINTS: the master's role or a validated role_title, both from the allow-list.

// The live shape: the Aczen entry printing an allow-listed title.
function aczenRequest(instruction: string): AssistRequest {
  // Through the real validator, with the entry's label carrying the allow-listed role.
  const parsed = parseAssistRequest(structured({ instruction, entries: [{ id: "e0", section: "experience", label: "Aczen Technologies · Full Stack AI Engineer Intern" }, { id: "e2", section: "experience", label: "Acme · Data Lead" }, { id: "e1", section: "projects", label: "F1 Race Pace Predictor" }] }));
  // Valid fixture.
  if (!parsed.ok) throw new Error(parsed.message);
  // The request.
  return parsed.request;
}

test("set_role on the allow-listed experience: an unlisted title is refused with the list, a listed one is kept in its exact spelling", () => {
  // The FamPay case, dictated by the owner.
  const fampay = parsedOps([{ op: "set_role", entry: "e0", text: "Data Analyst Intern" }], aczenRequest("change aczen title to data analyst intern"));
  // Refused, naming every allowed title so the owner can pick one.
  assert.deepEqual(fampay.rejected, [{ what: 'Set title of "Aczen Technologies · Full Stack AI Engineer Intern" to "Data Analyst Intern"', why: "This job's title can only be one of: Full Stack AI Engineer Intern, Software Engineer Intern, Backend Engineer Intern, AI Engineer Intern (background checks compare titles with HR records). Say which one." }]);
  // A listed title in the owner's lower case: kept, in the list's exact spelling (the web compares exactly).
  const listed = parsedOps([{ op: "set_role", entry: "e0", text: "software engineer intern" }], aczenRequest("make aczen title software engineer intern"));
  // Kept.
  assert.deepEqual(listed.ops, [{ op: "set_role", entry: "e0", text: "Software Engineer Intern" }]);
  // Another job is not allow-listed: the owner's dictated title is still theirs to set.
  const other = parsedOps([{ op: "set_role", entry: "e2", text: "Data Analyst Intern" }], aczenRequest("set acme title to data analyst intern"));
  // Kept.
  assert.deepEqual(other.ops, [{ op: "set_role", entry: "e2", text: "Data Analyst Intern" }]);
});

// --- S9c: a misspelt GROUP name still names the group (Teja 2026-11-21, "add toools 7") ------------------------------
//
// groupNamedIn wanted the group's exact words, so "toools" named no group and a group-less add fell through to the
// skill's kind. Group names now go through the shared typo matcher (_shared/text/name-match.ts), plus one typo on a
// 5-letter group name ("Tools"), which a skill name of 5 letters does not get.

// The groups of these tests: Databases is where a group-less Redis lands by its kind when no group is named.
function groupRequest(instruction: string, categories: string[] = ["Languages", "Tools", "Databases"]): AssistRequest {
  // Through the real validator.
  const parsed = parseAssistRequest(body({ instruction, categories }));
  // Valid fixture.
  if (!parsed.ok) throw new Error(parsed.message);
  // The request.
  return parsed.request;
}

test("S9c: 'toools' and 'databse' name their groups, so a group-less add lands in the group the owner meant", () => {
  // RED before the fix: no group named, so Redis went to Databases by its kind.
  assert.deepEqual(parsedOps([{ op: "add_skill", name: "Redis" }], groupRequest("add redis to toools")).ops, [{ op: "add_skill", name: "Redis", category: "Tools" }]);
  // A two-typo spelling of an 8+ letter group, through the same matcher as skill names.
  assert.deepEqual(parsedOps([{ op: "add_skill", name: "Kafka" }], groupRequest("add kafka in databse group")).ops, [{ op: "add_skill", name: "Kafka", category: "Databases" }]);
});

test("S9c: typo forgiveness never names a group from an ordinary word ('could' is not 'Cloud')", () => {
  // "could" is two edits from "cloud" (a swap plus a shift), so no group is named and Redis files by its kind.
  assert.deepEqual(parsedOps([{ op: "add_skill", name: "Redis" }], groupRequest("could you add redis", ["Languages", "Cloud", "Databases"])).ops, [{ op: "add_skill", name: "Redis", category: "Databases" }]);
});

// --- S9e: fewer skills than asked comes with the reason (Teja 2026-11-21, "add 6 cs fundamentals" gave 5) -----------

test("S9e: an add_group for more skills than the master holds says so in the note", () => {
  // Six asked; the master holds five Tools (TOOLS_MASTER).
  const parsed = parsedOps([{ op: "add_group", name: "Tools", n: 6 }], toolsRequest("add 6 tools"));
  // All five proposed.
  assert.equal(parsed.ops.length, 5);
  // RED before the fix: the note was the bare count. Now it names the shortfall's cause.
  assert.match(parsed.note, /Your master has only 5 more Tools skills to add\./);
});

test("S9e: past the per-group limit, the note names the limit; when the count is met there is no shortfall note", () => {
  // Twelve short master Tools, so neither the master nor the line width is what stops the fill.
  const twelve = Array.from({ length: 12 }, (_, i) => ({ name: `T${i}`, category: "Tools" }));
  // Through the real validator.
  const parsed = parseAssistRequest(body({ instruction: "add 20 tools", categories: ["Tools"], availableSkills: twelve }));
  // Valid fixture.
  if (!parsed.ok) throw new Error(parsed.message);
  // Twenty asked, ten given, and the note says why.
  assert.match(parsedOps([{ op: "add_group", name: "Tools", n: 20 }], parsed.request).note, /At most 10 skills are added to one group at a time/);
  // Three asked, three given: nothing to explain.
  assert.doesNotMatch(parsedOps([{ op: "add_group", name: "Tools", n: 3 }], parsed.request).note, /only|At most/);
});

// --- S9b-server: a skill the owner removed in this chat is never re-proposed (Teja 2026-11-21) -----------------------
//
// Live: "rm vs code", then "add 3 more tools" put VS Code back 7 s later: the server's pickers choose from the master
// skills not on the resume, and a removed skill is exactly that. The web now sends removed_skills (orch contract).

// toolsRequest plus the removed list, as the web sends it.
function removedRequest(instruction: string, removed: unknown): AssistRequest {
  // Through the real validator.
  const parsed = parseAssistRequest(body({ instruction, job: { title: "Backend Engineer", company: "Acme", missing: ["Jira"] }, categories: ["Languages", "Tools", "Databases"], availableSkills: TOOLS_MASTER, removed_skills: removed }));
  // Valid fixture.
  if (!parsed.ok) throw new Error(parsed.message);
  // The request.
  return parsed.request;
}

test("S9b: removed_skills is optional; a malformed one reads as none and never refuses the ask", () => {
  // Absent: an older web.
  assert.deepEqual(removedRequest("add tools", undefined).removedSkills, []);
  // A list of names: kept, trimmed.
  assert.deepEqual(removedRequest("add tools", [" VS Code "]).removedSkills, ["VS Code"]);
  // Not a list of short strings: none, never a partial list and never a 400 (it only steers; the ask is still valid).
  for (const bad of ["VS Code", [42], [""], ["x".repeat(61)], { 0: "VS Code" }, null]) assert.deepEqual(removedRequest("add tools", bad).removedSkills, [], JSON.stringify(bad));
});

test("S9b: add_group and the top-up skip a skill the owner removed in this chat", () => {
  // All five master Tools asked for, VS Code removed earlier: four come back.
  const filled = parsedOps([{ op: "add_group", name: "Tools", n: 5 }], removedRequest("add 5 more tools", ["VS Code"]));
  // RED before the fix: VS Code was the fifth.
  assert.deepEqual(filled.ops.map((op) => (op.op === "add_skill" ? op.name : op.op)), ["Jira", "Postman", "Cursor", "Swagger"]);
  // The top-up path: the model adds one, the server fills the named group, and still never VS Code.
  assert.ok(!addedNames([{ op: "add_skill", name: "Postman", category: "Tools" }], removedRequest("add more tools", ["vs code"])).includes("VS Code"));
});

test("S9b: an add_skill of a removed skill is refused with its reason unless the owner names it again in this message", () => {
  // The model re-proposes it on a general ask: refused, and the card says how to get it back.
  const again = parsedOps([{ op: "add_skill", name: "VS Code", category: "Tools" }], removedRequest("add more tools", ["VS Code"]));
  // No op.
  assert.deepEqual(again.ops, []);
  // The reason.
  assert.deepEqual(again.rejected.map((r) => r.why), ['You removed "VS Code" earlier in this chat. Name it in your message to add it back.']);
  // The owner asks for it by name (with a typo): their word wins.
  assert.deepEqual(parsedOps([{ op: "add_skill", name: "VS Code", category: "Tools" }], removedRequest("actually add vs cod back", ["VS Code"])).ops, [{ op: "add_skill", name: "VS Code", category: "Tools" }]);
});

test("S9b: the prompt lists the removed skills only when there are some, and the rule is in the stable system text", () => {
  // One removed.
  const prompt = buildAssistPrompt(removedRequest("add tools", ["VS Code"]));
  // Its own labelled line in the RESUME block.
  assert.match(prompt.userContent, /^REMOVED IN THIS CHAT: VS Code$/m);
  // The rule, in the cached system text.
  assert.match(prompt.systemInstruction, /REMOVED IN THIS CHAT/);
  // None removed: no line, so an older web's prompt is byte-identical to before.
  assert.doesNotMatch(buildAssistPrompt(removedRequest("add tools", undefined)).userContent, /REMOVED IN THIS CHAT/);
});

// --- S9a: an explicit count lifts the width limit, and the limit is the web's TWO lines (Teja 2026-11-21) --------------
//
// Live: 7 adds were dropped by a group-width check while the reply said "Proposed N". The server measured ONE line while
// the web's gate allows SKILL_GROUP_MAX_LINES (2), and only the word "all" lifted it. "add 7 tools" now dictates 7.

// Seven long master Tools: far more than two printed lines' worth at any type size.
const LONG_TOOLS = Array.from({ length: 7 }, (_, i) => ({ name: `Enterprise Observability Platform ${i}`, category: "Tools" }));

// A request whose master holds LONG_TOOLS.
function longToolsRequest(instruction: string): AssistRequest {
  // Through the real validator.
  const parsed = parseAssistRequest(body({ instruction, categories: ["Tools"], availableSkills: LONG_TOOLS }));
  // Valid fixture.
  if (!parsed.ok) throw new Error(parsed.message);
  // The request.
  return parsed.request;
}

test("S9a: 'add 7 tools' adds all seven even past the line limit; with no count the two-line limit still holds", () => {
  // RED before the fix: the one-line check kept only what fit one line.
  assert.equal(parsedOps([{ op: "add_group", name: "Tools", n: 7 }], longToolsRequest("add 7 tools")).ops.length, 7);
  // No count in the owner's words: the width limit stops the fill short of seven.
  const plain = parsedOps([{ op: "add_group", name: "Tools", n: 7 }], longToolsRequest("add more tools")).ops.length;
  // Some fit, never all seven.
  assert.ok(plain > 0 && plain < 7, String(plain));
});

// --- S9i P2 + S9j: the server applies the answer itself (Teja 2026-11-21 15:34 and 18:54) ------------------------------
//
// "every edit he prompts in the resume chat is applied and done … even if he closes the chat, the tab or the job". A page
// that sends server_apply + application_id + apply_maps gets its ops applied HERE (server-apply.ts, bound in index.ts),
// and the body carries one outcome per op. Place-moves (S9j) are only offered to such a page: an older page's strict
// reader would refuse the kind, so the parser refuses them by name for it instead.

// The maps a server-applied ask carries for body()'s resume (bullets b0..).
const APPLY_MAPS = { bullets: { b0: "ref-b0" }, entries: {}, available_bullets: {}, available_entries: {}, skills: [] };
// A real-looking application id.
const APP_ID = "11111111-2222-4333-8444-555555555555";

test("S9i P2: a server-apply ask is applied by the server and the body names each op's outcome", async () => {
  // The ops the apply seam received.
  const received: unknown[] = [];
  // The happy-path deps, plus an apply seam that records and answers.
  const d = deps();
  // The original connect.
  const connect = d.connect;
  // Wrapped: the same connection plus apply.
  const withApply: AssistDeps = { ...d, connect: async () => { const c = await connect(); return c.ok ? { ...c, apply: async (args) => { received.push(args); return [{ status: "applied", label: "Remove bullet" }] as const; } } : c; } };
  // The ask, server-applied.
  const res = await handleResumeAssist(post("good", body({ server_apply: true, application_id: APP_ID, apply_maps: APPLY_MAPS })), withApply);
  // The answer.
  const json = await res.json() as { status: string; applied?: unknown[] };
  // Applied, with the outcome list.
  assert.deepEqual([json.status, json.applied], ["ok", [{ status: "applied", label: "Remove bullet" }]]);
  // The seam got this row, the kept op and the maps.
  assert.deepEqual(received, [{ applicationId: APP_ID, ops: [{ op: "remove", id: "b0" }], maps: { bullets: { b0: "ref-b0" }, entries: {}, availableBullets: {}, availableEntries: {}, skills: [] } }]);
});

test("S9i P2: an op the parser drops is a refused outcome in `applied` and in the chat row the server writes", async () => {
  // The chat rows the server wrote.
  const written: unknown[] = [];
  // The model keeps b0 and names b99, a bullet it was never shown (the parser drops it).
  const d = deps({ answer: { ok: true, keyIndex: 1, attempts: 1, data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ ops: [{ op: "remove", id: "b0" }, { op: "remove", id: "b99" }], note: "" }) }] }, finishReason: "STOP" }] } } });
  // The original connect.
  const connect = d.connect;
  // Apply answers for the kept op; saveChat records the rows.
  const seams: AssistDeps = { ...d, connect: async () => { const c = await connect(); return c.ok ? { ...c, apply: async () => [{ status: "applied", label: "Remove bullet" }] as const, saveChat: async (rows) => { written.push(...rows); return true; } } : c; } };
  // The ask, server-applied, naming its chat.
  const json = await (await handleResumeAssist(post("good", body({ server_apply: true, application_id: APP_ID, apply_maps: APPLY_MAPS, chat_id: APP_ID })), seams)).json() as { applied?: { status: string; why?: string }[] };
  // The kept op applied, then the dropped one refused WITH its reason (a page showing only this list must see it).
  assert.deepEqual(json.applied?.map((o) => [o.status, typeof o.why]), [["applied", "undefined"], ["refused", "string"]]);
  // The stored answer names the refusal too, so a reopened chat tells the same story.
  assert.match(String((written[1] as { content?: unknown } | undefined)?.content), /Could not do/);
});

test("S9i P2: without server_apply (or with malformed maps) nothing is applied server-side", async () => {
  // Calls to the apply seam.
  let applies = 0;
  // Deps with a counting apply.
  const d = deps();
  // The original connect.
  const connect = d.connect;
  // Wrapped.
  const counting: AssistDeps = { ...d, connect: async () => { const c = await connect(); return c.ok ? { ...c, apply: async () => { applies += 1; return []; } } : c; } };
  // An older page: no flag.
  const old = await (await handleResumeAssist(post("good"), counting)).json() as Record<string, unknown>;
  // A malformed map: one bullet ref is a number.
  const bad = await (await handleResumeAssist(post("good", body({ server_apply: true, application_id: APP_ID, apply_maps: { ...APPLY_MAPS, bullets: { b0: 7 } } })), counting)).json() as Record<string, unknown>;
  // Neither was applied, and neither body carries "applied".
  assert.deepEqual([applies, "applied" in old, "applied" in bad], [0, false, false]);
});

test("S9j: place-moves reach only a server-applied page; an older page gets a named refusal", () => {
  // A structured request (sections and entries), as an older page sends it.
  const older = structuredRequest();
  // The same, server-applied.
  const served = { ...older, serverApply: true, applicationId: APP_ID, applyMaps: { bullets: {}, entries: {}, availableBullets: {}, availableEntries: {}, skills: [] } };
  // An entry and a section to a place.
  const ops = [{ op: "move_entry", entry: "e0", place: 1 }, { op: "move_section", section: older.sections[1], place: 1 }];
  // Kept for the server-applied page.
  assert.deepEqual(parsedOps(ops, served).ops, [{ op: "move_entry", entry: "e0", place: 1 }, { op: "move_section", section: older.sections[1], place: 1 }]);
  // Refused by name for the older page.
  assert.deepEqual(parsedOps(ops, older).rejected.map((r) => r.why), ["Moving to a place needs the updated page; reload it and ask again.", "Moving to a place needs the updated page; reload it and ask again."]);
});

test("S9i P2: a closed tab still finds the bubble: the server writes the exchange, the record first", async () => {
  // The rows the seam received.
  const written: unknown[] = [];
  // Deps with apply + saveChat.
  const d = deps();
  // The original connect.
  const connect = d.connect;
  // Wrapped.
  const both: AssistDeps = { ...d, connect: async () => { const c = await connect(); return c.ok ? { ...c, apply: async () => [{ status: "applied", label: "Remove bullet" }, { status: "refused", label: "Move section", why: "already first" }] as const, saveChat: async (rows) => { written.push(...rows); return true; } } : c; } };
  // A server-applied ask naming its chat.
  const chatId = "99999999-8888-4777-8666-555555555555";
  // Sent.
  const json = await (await handleResumeAssist(post("good", body({ instruction: "drop the first point", server_apply: true, application_id: APP_ID, apply_maps: APPLY_MAPS, chat_id: chatId })), both)).json() as { chat_saved?: boolean };
  // Stored, and the page is told so it does not write a second copy.
  assert.equal(json.chat_saved, true);
  // The ask, then the answer led by what landed and what did not.
  assert.deepEqual(written.map((r) => [(r as { role: string }).role, (r as { content: string }).content, (r as { ops: unknown }).ops]), [
    ["user", "drop the first point", null],
    ["assistant", "[Applied: Remove bullet | Could not do: Move section (already first)] Dropped one.", []],
  ]);
});

// --- S9k: three live failures on row 957991ec (ElevenLabs "Full-Stack Engineer (Backend Leaning) - Creative Agents") ---
//
// Teja's chat c56bd963, 2026-11-23 21:21-21:22 IST (resume_chat_messages 939-946). Each test below quotes the live text.

// The live AI group in print order before 21:21 (8 printed now, plus Tool Calling and Guardrails that 941 removed).
const LIVE_AI = ["AI Agents & Workflows", "Prompt Engineering", "MCP Integrations", "RAG Pipelines", "Context Engineering", "LLM/SLM API Integration", "Multi-Agent Systems", "Harness Engineering", "Tool Calling", "Guardrails"];
// Another printed group, so a fit or a move can be shown to leave it alone.
const LIVE_TESTING = ["Unit Testing", "Integration Testing", "Pytest"];

// The live row as a server-applied request: the AI group (all ten or the given names), a Testing group, the live JD keywords.
function liveRequest(instruction: string, ai: readonly string[] = LIVE_AI, description = "Build backend services for creative AI agents. APIs, monitoring, observability and testing."): AssistRequest {
  // The printed skills with their groups, in print order.
  const printedSkills = [...ai.map((name) => ({ name, category: "AI" })), ...LIVE_TESTING.map((name) => ({ name, category: "Testing & Quality" }))];
  // Through the real validator, so the fixture cannot drift from it.
  const parsed = parseAssistRequest(body({ instruction, job: { title: "Full-Stack Engineer (Backend Leaning) - Creative Agents", company: "Elevenlabs", missing: ["Observability"], description }, skills: printedSkills.map((skill) => skill.name).join(", "), printedSkills, categories: ["AI", "Testing & Quality"] }));
  // Valid fixture.
  if (!parsed.ok) throw new Error(parsed.message);
  // Server-applied, as the live page was (7ae57c92).
  return { ...parsed.request, serverApply: true };
}

// The worst-rung line count, the planner's own measure, restated for the assertions.
const linesOf = (category: string, names: readonly string[]): number => Math.max(...TYPOGRAPHY_LADDER.map((_, index) => skillGroupLineCount(category, names, index)));

test("S9k live 939: 'rm some aim skills to fill it in one line only' reads as the AI group in 1 line", () => {
  // The live words, typo included: "aim skills" names AI only through the "<word> skills" frame.
  assert.deepEqual(fitGroupAsked(liveRequest("rm some aim skills to fill it in one line only")), { category: "AI", lines: 1 });
  // A line ask with no group named is no fit ask: nothing guessed.
  assert.equal(fitGroupAsked(liveRequest("keep it in one line")), null);
  // A group ask with no line count is not a fit ask either.
  assert.equal(fitGroupAsked(liveRequest("rm some ai skills")), null);
});

test("S9k live 939: the model's off-topic personal-details answer is replaced by the server's fit of the AI group", () => {
  // The live answer: no op, the personal-details sentence.
  const parsed = parseAssistOps(JSON.stringify({ ops: [], note: "Personal details like email, phone, and links are updated on the Master profile page." }), liveRequest("rm some aim skills to fill it in one line only"));
  // Well-formed.
  if (!parsed.ok) throw new Error("answer did not parse");
  // The off-topic sentence is gone.
  assert.doesNotMatch(parsed.note, /Personal details/);
  // Measured 2026-11-23 on the live 10-skill group: five JD-unnamed skills go, weakest (last) first, down to the floor of 5.
  const removed = ["Guardrails", "Tool Calling", "Harness Engineering", "Multi-Agent Systems", "LLM/SLM API Integration"];
  // Ordinary removals in the AI group, so the web reads them as it always has.
  assert.deepEqual(parsed.ops, removed.map((name) => ({ op: "remove_skill", name, category: "AI" })));
  // What is left.
  const left = LIVE_AI.filter((name) => !removed.includes(name));
  // One printed line at every rung, and exactly the floor kept.
  assert.deepEqual([linesOf("AI", left), left.length], [1, 5]);
});

test("S9k: planGroupFit removes the least JD-relevant first (JD-unnamed from the end), keeps the floor, never touches another group", () => {
  // Wide names, so one line forces several removals; the JD names only "RAG Pipelines" and "Harness Engineering".
  const plan = planGroupFit(liveRequest("x", LIVE_AI, "We need RAG Pipelines and Harness Engineering."), "ai", 1);
  // Harness Engineering now survives (the JD names it) and Context Engineering goes in its place; RAG is kept too.
  assert.deepEqual(plan, { ok: true, category: "AI", remove: ["Guardrails", "Tool Calling", "Multi-Agent Systems", "LLM/SLM API Integration", "Context Engineering"] });
});

test("S9k: a fit the floor cannot reach removes NOTHING and says how many lines the 5 need", () => {
  // Five very long AI names: five of them cannot print on one line at any rung.
  const long = ["Retrieval-Augmented Generation Pipelines", "Large Language Model API Integration", "Multi-Agent Orchestration Systems", "Context Engineering for Long Sessions", "Evaluation Harness Engineering"];
  // The planner.
  const plan = planGroupFit(liveRequest("x", long), "AI", 1);
  // Refused.
  assert.equal(plan.ok, false);
  // With the floor and the real line count.
  assert.equal(!plan.ok && plan.why, `"AI" cannot fit in 1 line: AI skills never go below 5, and 5 of them still take ${linesOf("AI", long)} lines. Remove or shorten a skill by name to choose which.`);
});

test("S9k: a group that already fits is told so, never a silent no-op", () => {
  // Three short testing skills fit one line.
  const plan = planGroupFit(liveRequest("x"), "Testing & Quality", 1);
  // Refused with the reason.
  assert.deepEqual(plan, { ok: false, why: '"Testing & Quality" already fits in 1 line.' });
});

test("S9k live 942: a server-applied answer never says 'Proposed 2 changes. See the list below.'", () => {
  // The live ask and the model's two removals, with no note of its own.
  const ops = [{ op: "remove_skill", name: "Tool Calling" }, { op: "remove_skill", name: "Guardrails" }];
  // Server-applied: the outcome line ("[Applied: ...]") is the reply, so the note adds nothing.
  const served = parsedOps(ops, liveRequest("rm tool calling gurad rails"));
  // Both kept.
  assert.equal(served.ops.length, 2);
  // No stale browser-era wording.
  assert.equal(served.note, "");
  // A browser-applied page still gets the count of its cards.
  const browser = parsedOps(ops, { ...liveRequest("rm tool calling gurad rails"), serverApply: false });
  // Unchanged there.
  assert.equal(browser.note, "Proposed 2 changes. See the list below.");
});

test("S9k live 944/946: 'put harnes rng at frist place' in the AI group is a move_skill, never 'a bullet it was not shown'", () => {
  // The model now sends the skill op, its own spelling slightly off and the group in lower case.
  const kept = parsedOps([{ op: "move_skill", name: "Harnes Engineering", category: "ai", place: 1 }], liveRequest("put harnes rng at frist place in skills section in ai skill grp"));
  // Kept in the printed spelling and group, so the server finds it exactly.
  assert.deepEqual(kept.ops, [{ op: "move_skill", name: "Harness Engineering", category: "AI", place: 1 }]);
  // A skill that is not printed names the real reason.
  const missing = parsedOps([{ op: "move_skill", name: "Kubernetes", category: "AI", place: 1 }], liveRequest("put kubernetes first"));
  // Refused with the skill's name, never "bullet".
  assert.equal(missing.rejected[0]?.why, '"Kubernetes" is not on the resume.');
  // An older, browser-applied page cannot apply a place move: said so.
  const older = parsedOps([{ op: "move_skill", name: "Harness Engineering", category: "AI", place: 1 }], { ...liveRequest("x"), serverApply: false });
  // The reload sentence.
  assert.match(older.rejected[0]?.why ?? "", /reload it and ask again/);
});

test("S9k review: the fit fallback never fires when the model answered with ANY op (a bullet edit, an add_skill)", () => {
  // "fit in one line" about a BULLET, with a printed group named in the sentence: the model's edit is the answer.
  const edited = parsedOps([{ op: "edit", id: "b0", text: "Shorter bullet text." }], liveRequest("make the Testing & Quality bullet fit in one line"));
  // No server-added removal rode along with the model's edit: none kept...
  assert.equal(edited.ops.some((op) => op.op === "remove_skill"), false);
  // ...and none refused either (a refused removal would still mean the server invented one).
  assert.equal(edited.rejected.some((r) => /remove skill/i.test(r.what)), false);
  // An add with a "keep it on one line" wish: the model's add_skill stands and nothing is trimmed behind it.
  const added = parsedOps([{ op: "add_skill", name: "Monitoring", category: "AI" }], liveRequest("add monitoring to ai skills, keep it in one line"));
  // Still no server-added removal, kept...
  assert.equal(added.ops.some((op) => op.op === "remove_skill"), false);
  // ...or refused.
  assert.equal(added.rejected.some((r) => /remove skill/i.test(r.what)), false);
});

test("S9k review: move_skill naming a group the skill is NOT printed in is refused, never moved inside another group", () => {
  // Harness Engineering prints only in AI; the model said Testing & Quality.
  const moved = parsedOps([{ op: "move_skill", name: "Harness Engineering", category: "Testing & Quality", place: 1 }], liveRequest("put harness engineering first in testing"));
  // Nothing kept: moving it inside AI would be a change the owner did not ask for.
  assert.deepEqual(moved.ops, []);
  // The reason names both, like resolve-ops does.
  assert.equal(moved.rejected[0]?.why, '"Harness Engineering" is not in group "Testing & Quality".');
});
