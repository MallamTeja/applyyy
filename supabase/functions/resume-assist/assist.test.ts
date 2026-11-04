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

test("buildAssistPrompt labels each entry once, tags bullets with it, and lists AVAILABLE before the job", () => {
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
  // Between the AVAILABLE label and the job block.
  assert.deepEqual(lines.slice(from, lines.indexOf("JOB")), ["m0 [e0]: Mentored two interns.", "n0 achievements: LeetCode"]);
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
  // Validated against the structured request.
  const parsed = parseAssistOps(answer, structuredRequest());
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

test("the schema and the system text offer exactly the nine ops", () => {
  // The prompt parts.
  const prompt = buildAssistPrompt(request());
  // The schema, read through its nested shape.
  const schema = prompt.responseSchema as { properties: { ops: { items: { properties: { op: { enum: string[] }; direction: { enum: string[] } } } } } };
  // Closed to what parseAssistOps reads; the two remove ops joined on 2026-11-04.
  assert.deepEqual(schema.properties.ops.items.properties.op.enum, ["edit", "remove", "add_skill", "remove_skill", "move", "move_section", "add_back", "new_bullet", "remove_entry"]);
  // Direction closed in the schema too.
  assert.deepEqual(schema.properties.ops.items.properties.direction.enum, ["up", "down"]);
  // Since 2026-11-04 the system text spells every op as exact JSON, so a skill's name cannot land in "text".
  for (const kind of ["edit", "remove", "add_skill", "remove_skill", "move", "move_section", "add_back", "new_bullet", "remove_entry"]) {
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

test("an add_skill under a group the master lacks names that group and lists at most five real ones", () => {
  // Two groups: both listed.
  assert.deepEqual(rejectedFor({ op: "add_skill", name: "Rust", category: "Programming" }), { what: 'Add skill "Rust"', why: '"Programming" is not one of your skill groups (Languages, Tools).' });
  // Six groups: five listed, then an ellipsis.
  const six = parseAssistRequest(body({ categories: ["A", "B", "C", "D", "E", "F"] }));
  // Valid fixture.
  assert.ok(six.ok);
  // Capped list.
  assert.equal(rejectedFor({ op: "add_skill", name: "Rust", category: "Programming" }, six.request)?.why, '"Programming" is not one of your skill groups (A, B, C, D, E, …).');
  // No group at all is its own reason, not "is not one of your groups".
  assert.equal(rejectedFor({ op: "add_skill", name: "Rust" })?.why, "The AI's answer did not say which skill group.");
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
  const many = Array.from({ length: MAX_OPS + 1 }, (_, i) => ({ op: "add_skill", name: `Skill${i}`, category: "Tools" }));
  // Validated.
  const capped = parseAssistOps(JSON.stringify({ ops: many, note: "" }), request());
  // The thirteenth, named.
  assert.deepEqual(capped.ok ? capped.rejected : null, [{ what: `Add skill "Skill${MAX_OPS}"`, why: `More than ${MAX_OPS} changes in one answer; ask for fewer at once.` }]);
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
        // A near-cap name under a huge unknown group: the why lists five long groups.
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
    groups.request,
  );
  // Narrowed.
  assert.ok(long.ok);
  // Four reasons.
  assert.equal(long.rejected.length, 4);
  // Each within the contract's caps.
  for (const r of long.rejected) assert.ok(r.what.length <= 120 && r.why.length <= 200, JSON.stringify(r));
});

test("printedSkills drives the duplicate check and the grouped SKILLS line", () => {
  // The request with printed skills; its old skills string says "TypeScript, Postgres".
  const req = printedRequest();
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
const PROMPT_BEFORE_2026_11_04 = [
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
  "JOB",
  "ROLE: Backend Engineer at Acme",
  "MISSING KEYWORDS: Kafka, gRPC",
  "CHAT SO FAR:",
  "owner: Shorten b0",
  "ai: Shortened one bullet.",
  "INSTRUCTION: Add Kafka and make b1 about latency",
];

test("the JOB block carries location, arrangement and description only when sent, before the chat", () => {
  // All three sent; the description with the line breaks an ATS page leaves.
  const lines = promptLines(withJob({ location: "Bengaluru, India", arrangement: "hybrid", description: "We build payments.\n\n  Python required." }));
  // Right after the keywords, in this order, the description on one line.
  const at = lines.indexOf("MISSING KEYWORDS: Kafka, gRPC");
  // The three new lines, then the chat.
  assert.deepEqual(lines.slice(at + 1, at + 5), ["LOCATION: Bengaluru, India", "ARRANGEMENT: hybrid", "DESCRIPTION: We build payments. Python required.", "CHAT SO FAR:"]);
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
