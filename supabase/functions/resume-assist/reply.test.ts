// S45 + S9k item 2 (Teja 2026-11-24 13:42, "very shit reply"): the stored chat reply for a server-applied answer.
// The live reply was "[Applied: Remove skill; Remove skill; Add skill "YAML Flows" under Tools] Proposed 4 changes. See the
// list below." This drives the WHOLE path (handler -> parser -> real applyOnServer on a supabase-shaped fake -> chatRows)
// for Teja's exact prompt and pins the reply he should read, word for word.
import assert from "node:assert/strict";
// The runner.
import { test } from "node:test";
// The handler and its seams type.
import { handleResumeAssist, parseAssistOps, parseAssistRequest, type AssistDeps } from "./assist.ts";
// The real server-side apply, so the reply's subjects come from the code that writes the row, not from a stub.
import { applyOnServer } from "./server-apply.ts";
// The engine's own rebuild, so the fixture row is exactly what a tailoring stores.
import { rebuildOriginal } from "../_shared/resume-edit/tailored-edits.ts";

// The pin.
const V = 7;
// A master whose Tools group has exactly ONE skill not on the resume (YAML Flows): "add 3 more tools" can only add one.
const MASTER = {
  // The master's own shape version.
  schema_version: 1,
  // Who.
  identity: { full_name: "Test Person", headline: "Backend Engineer", email: "test@example.com", phone: null, location: "Hyderabad", links: [] },
  // The summary the tailored one grounds in.
  summary: { id: "summary-master", text: "Backend engineer building REST APIs in Node.js." },
  // One job, two bullets.
  experience: [{ id: "exp-acme", company: "Acme", role: "Backend Intern", location: "Remote", start_display: "Jun 2025", end_display: "Aug 2025", start_date: null, end_date: null, bullets: [{ id: "b-api", text: "Built a REST API with Express and Node.js handling 500 users", tags: [] }, { id: "b-tests", text: "Wrote unit tests for the billing service", tags: [] }] }],
  // Nothing else, so only the skills decide.
  projects: [], education: [], achievements: [], certifications: [],
  // The four Teja named, plus a few that stay, plus YAML Flows (the one Tools skill not printed).
  skills: [
    // Languages.
    { id: "sk-py", name: "Python", category: "Languages" }, { id: "sk-cs", name: "C#", category: "Languages" },
    // Machine Learning.
    { id: "sk-lgbm", name: "LightGBM", category: "Machine Learning" }, { id: "sk-xgb", name: "XGBoost", category: "Machine Learning" }, { id: "sk-pt", name: "PyTorch", category: "Machine Learning" },
    // Backend.
    { id: "sk-ms", name: "Microservices", category: "Backend" }, { id: "sk-node", name: "Node.js", category: "Backend" },
    // Tools: Docker and Git printed, YAML Flows not.
    { id: "sk-docker", name: "Docker", category: "Tools" }, { id: "sk-git", name: "Git", category: "Tools" }, { id: "sk-yaml", name: "YAML Flows", category: "Tools" },
  ],
  // No links.
  links: [],
};
// The printed skills, in print order (every master skill except YAML Flows).
const PRINTED = MASTER.skills.filter((skill) => skill.id !== "sk-yaml");
// The row's tailor_refs.
const REFS = {
  // Shape and pin.
  schema_version: 1, master_version: V, section_order: ["summary", "experience", "skills"],
  // The tailored summary.
  summary: { text: "Backend engineer shipping REST APIs in Node.js.", refs: ["summary-master"] },
  // Every printed skill by ref.
  skills: PRINTED.map((skill) => ({ ref: skill.id })),
  // The job.
  experience: [{ ref: "exp-acme", bullets: [{ ref: "b-api", text: "Built a REST API with Express and Node.js handling 500 users" }, { ref: "b-tests", text: "Wrote unit tests for the billing service" }] }],
  // Empty sections.
  projects: [], education: [], achievements: [], certifications: [],
};

/* A stateful supabase double (server-apply.test's shape): values, never throws (CLAUDE.md §5); every landed update moves
   the stamp, as the database's trigger would. */
function fakeDb() {
  // The stored row.
  const row = { tailored_profile: rebuildOriginal(structuredClone(REFS), structuredClone(MASTER) as never, V), updated_at: "t1", tailor_refs: structuredClone(REFS), selected_jd_keywords: [], status: "awaiting_approval" };
  // Landed updates, for the stamp.
  let updates = 0;
  // The client.
  const db = {
    from(table: string) {
      // Read, update or insert, decided by the methods called.
      let kind: "read" | "update" | "insert" = "read";
      // What an update writes.
      let written: Record<string, unknown> = {};
      // The chainable, thenable builder.
      const builder: Record<string, unknown> = {
        then(resolve: (v: unknown) => unknown) {
          // The pinned master.
          if (table === "master_profiles") return Promise.resolve({ data: { profile: structuredClone(MASTER) }, error: null }).then(resolve);
          // An update of the row: stored, new stamp, one row back.
          if (table === "applications" && kind === "update") { updates += 1; Object.assign(row, written, { updated_at: `t${updates + 1}` }); return Promise.resolve({ data: [{ id: "app-1", updated_at: row.updated_at }], error: null }).then(resolve); }
          // A read of the row.
          if (table === "applications") return Promise.resolve({ data: structuredClone(row), error: null }).then(resolve);
          // The event insert.
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      // Every method the code chains.
      for (const method of ["select", "eq", "maybeSingle", "single", "order", "limit", "insert", "update"]) {
        builder[method] = (...args: unknown[]) => {
          // An update records what it writes.
          if (method === "update") { kind = "update"; written = args[0] as Record<string, unknown>; }
          // An insert is an event.
          if (method === "insert") kind = "insert";
          // Chain on.
          return builder;
        };
      }
      // The builder.
      return builder;
    },
  };
  // The double and the row it holds.
  return { db, row };
}

// Teja's exact words.
const PROMPT = "remove lightgbm, cgboost, microservices, c# and add 3 more tools";
// The reply he should read.
const TARGET = "Done. Removed: LightGBM, XGBoost (you typed 'cgboost'), Microservices, C#. Added to Tools: YAML Flows. Only 1 more Tools skill is in your master, so 2 of the 3 weren't added. Resume still fits one page.";
// Uuid-shaped ids the request validator accepts.
const APP_ID = "11111111-2222-4333-8444-555555555555";
// Same, for the chat.
const CHAT_ID = "99999999-8888-4777-8666-555555555555";

// The handler's seams: a signed-in caller, the switch on, the model's answer, the real apply on the fake, saveChat recorded.
function seams(answer: unknown, written: unknown[], fake: ReturnType<typeof fakeDb>): AssistDeps {
  // The deps object.
  return {
    // One connection per request.
    connect: async () => ({
      // Signed in.
      ok: true,
      // As u1.
      userId: "u1",
      // The auth and kill-switch reads (assist.test's deps shape).
      db: {
        // "good" is u1.
        auth: { getUser: async (jwt: string) => (jwt === "good" ? { data: { user: { id: "u1" } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
        // The switch row: on.
        from: () => ({ select: async () => ({ data: [{ system_enabled: true }], error: null }) }),
      },
      // The model answers with `answer`, as Gemini's JSON body.
      generate: async () => ({ ok: true, keyIndex: 1, attempts: 1, data: { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: "STOP" }] } }),
      // The REAL server-side apply, on the fake row, with fixed seams.
      apply: async (args) => (await applyOnServer(fake.db as never, { ...args, deadline: 2000 }, { now: () => 1000, uuid: () => "u1" })).outcomes,
      // The rows the server would insert.
      saveChat: async (rows) => { written.push(...rows); return true; },
    }) as never,
  };
}

// The request body the web sends for this resume, server-applied, naming its chat.
function body(): Record<string, unknown> {
  // The browser's projection of the row above.
  return {
    // The ask.
    instruction: PROMPT,
    // The job.
    job: { title: "Backend Engineer", company: "Acme", missing: [] },
    // The summary.
    summary: "Backend engineer shipping REST APIs in Node.js.",
    // The two bullets under short ids.
    bullets: [{ id: "b0", text: "Built a REST API with Express and Node.js handling 500 users" }, { id: "b1", text: "Wrote unit tests for the billing service" }],
    // The flat skill line.
    skills: PRINTED.map((skill) => skill.name).join(", "),
    // The printed skills with their groups.
    printedSkills: PRINTED.map((skill) => ({ name: skill.name, category: skill.category })),
    // The owner's groups.
    categories: ["Languages", "Machine Learning", "Backend", "Tools"],
    // The master's skills not on the resume.
    availableSkills: [{ name: "YAML Flows", category: "Tools" }],
    // Server apply on, with the maps.
    server_apply: true,
    // This row.
    application_id: APP_ID,
    // This chat.
    chat_id: CHAT_ID,
    // The id -> ref maps (skills carry their refs).
    apply_maps: { bullets: { b0: "b-api", b1: "b-tests" }, entries: {}, available_bullets: {}, available_entries: {}, skills: PRINTED.map((skill) => ({ name: skill.name, category: skill.category, ref: skill.id })) },
  };
}

// A POST with a bearer token.
const post = (payload: unknown): Request => new Request("http://local/resume-assist", { method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify(payload) });

test("S45 target: 'remove lightgbm, cgboost, microservices, c# and add 3 more tools' stores the readable reply, word for word", async () => {
  // The chat rows written.
  const written: unknown[] = [];
  // The row.
  const fake = fakeDb();
  // The model's answer: Teja's typo kept ("cgboost"), the count as an add_group, a claim note the server must drop.
  const answer = { ops: [{ op: "remove_skill", name: "lightgbm" }, { op: "remove_skill", name: "cgboost" }, { op: "remove_skill", name: "microservices" }, { op: "remove_skill", name: "c#" }, { op: "add_group", name: "Tools", n: 3 }], note: "I removed the four skills and added more tools." };
  // Sent.
  const json = await (await handleResumeAssist(post(body()), seams(answer, written, fake))).json() as { chat_saved?: boolean };
  // The server wrote the exchange itself.
  assert.equal(json.chat_saved, true);
  // The stored answer is exactly the target reply.
  assert.equal((written[1] as { content: string }).content, TARGET);
  // And the row really changed that way: the four gone, YAML Flows printed.
  assert.deepEqual((fake.row.tailored_profile as { skills: { name: string }[] }).skills.map((skill) => skill.name), ["Python", "PyTorch", "Node.js", "Docker", "Git", "YAML Flows"]);
});

// The parsed answer for these ops under body() with overrides, for the shortfall wording below.
function parsed(ops: unknown[], overrides: Record<string, unknown>) {
  // Through the real validator.
  const req = parseAssistRequest({ ...body(), ...overrides });
  // A broken fixture is a broken test.
  if (!req.ok) throw new Error(req.message);
  // The model's answer.
  const out = parseAssistOps(JSON.stringify({ ops, note: "" }), req.request);
  // Always well-formed here.
  if (!out.ok) throw new Error("answer did not parse");
  // Kept, refused, note.
  return out;
}

test("S45 (b): add_group shortfall wording, plural and zero", () => {
  // Two left in the master, three asked.
  const two = parsed([{ op: "add_group", name: "Tools", n: 3 }], { instruction: "add 3 more tools", availableSkills: [{ name: "YAML Flows", category: "Tools" }, { name: "Make", category: "Tools" }] });
  // Plural, and "wasn't" for one.
  assert.equal(two.note, "Only 2 more Tools skills are in your master, so 1 of the 3 wasn't added.");
  // None left, three asked by the owner.
  const none = parsed([{ op: "add_group", name: "Tools", n: 3 }], { instruction: "add 3 more tools", availableSkills: [] });
  // Said as the master running out, not a refused card.
  assert.deepEqual([none.note.endsWith("No more Tools skills are in your master, so none of the 3 were added."), none.rejected], [true, []]);
});

test("S45 (c): a counted ask answered with add_skill ops (no add_group) still says the master ran out", () => {
  // The model sent the one master Tools skill as a plain add.
  const out = parsed([{ op: "add_skill", name: "YAML Flows", category: "Tools" }], { instruction: "add 3 more tools" });
  // Kept.
  assert.deepEqual(out.ops, [{ op: "add_skill", name: "YAML Flows", category: "Tools" }]);
  // RED before S45: silent. Now the add_group wording.
  assert.equal(out.note, "Only 1 more Tools skill is in your master, so 2 of the 3 weren't added.");
});

test("S45 (c): the top-up names the skills its line had no room for, never short in silence", () => {
  // Thirty long master Tools skills: the printed line cannot take them all.
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `Long Tool Name Number ${i}`, category: "Tools" }));
  // An add for Tools from the model; the top-up fills Tools from the master until the line is full.
  const out = parsed([{ op: "add_skill", name: "Long Tool Name Number 0", category: "Tools" }], { instruction: "add tools", availableSkills: many });
  // The reason and the way past it.
  assert.match(out.note, /^\d+ more Tools skills in your master did not fit on that group's printed line; say "all" to add them anyway\.$/);
});

test("S45 (a): the parser takes a unique typo of a printed skill and keeps what was typed; a tie is refused with both", () => {
  // Teja's "cgboost".
  const one = parsed([{ op: "remove_skill", name: "cgboost" }], { instruction: "remove cgboost" });
  // The printed spelling, with the typed one carried for the reply.
  assert.deepEqual(one.ops, [{ op: "remove_skill", name: "XGBoost", typed: "cgboost" }]);
  // Two printed names one edit away.
  const tie = parsed([{ op: "remove_skill", name: "Sxark" }], { instruction: "remove sxark", printedSkills: [{ name: "Spark", category: "Tools" }, { name: "Stark", category: "Tools" }], skills: "Spark, Stark" });
  // Refused, naming both.
  assert.deepEqual([tie.ops, tie.rejected[0]?.why], [[], '"Sxark" is close to "Spark" and "Stark"; say which one.']);
});
