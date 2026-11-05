// Tests for the Tailor runner — the piece that turns `buildTailorPrompt` and
// `validateTailoredProfile` into one unit of work.
//
// THE LINE UNDER TEST, in one sentence: A MODEL THAT DID NOT ANSWER AND A MODEL THAT
// ANSWERED DISHONESTLY ARE DIFFERENT EVENTS, and this runner must never collapse them.
// A transport or schema failure THROWS — nothing was judged, so there is no verdict to
// report. A fabrication RETURNS a refusal carrying its violations, because that IS a
// verdict and `validator.ts:70` requires it be persisted for the dashboard "rather than
// lose them in a stack trace". Collapsing either into the other is the §5 failure this
// repo keeps finding: malformed data becoming an answer.
//
// WHY THE SHAPE CHECK LIVES HERE AND NOT IN THE VALIDATOR, since a reader will ask:
// `validateTailoredProfile` takes a `TailoredProfile` and trusts that type — it walks
// `tailored.skills` at `validator.ts:489` and `tailored.achievements` at `:646` with no
// runtime guard at all. Types are erased at runtime, so handing it `JSON.parse` output
// directly would crash inside the validator with a TypeError instead of reporting a bad
// model response. The parse boundary is this module's job; §5's rule is to validate the
// shape you expect rather than ask a lenient parser whether it gave up.
import { test } from "node:test";
// Strict, so a missing key never compares equal to a key holding `undefined`.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { createTailorer, TAILOR_REQUIRED_ARRAY_KEYS } from "./tailorer.ts";
// The schema Gemini is actually sent, and the section tuple its enum is built from —
// imported, never restated, so these tests check the shipped values.
import { TAILOR_RESPONSE_SCHEMA, TAILOR_SECTION_KINDS } from "./prompt.ts";
// The contract types, reached through this stream's single re-export module. Nothing
// here redefines one — a redefined type does not fail, it drifts.
import type { MasterProfile, TailoredProfile } from "../contracts/shared-types.ts";

// The pinned version every test resolves against. A literal rather than a variable the
// tests can nudge, so a "mismatch" test has to state its own wrong number out loud.
const MASTER_VERSION = 7;

// A small but COMPLETE master. Complete matters more than small here: the validator
// indexes every array, so an omitted one would fail for a reason unrelated to the
// behaviour under test and teach the reader nothing.
const MASTER: MasterProfile = {
  // Shape marker from the schema owner, not the row version.
  schema_version: 1,
  identity: {
    // Copied verbatim into the resolved resume; the Tailor may never touch it.
    full_name: "Teja Mallam",
    headline: "Backend Engineer",
    email: "tejamallam00@gmail.com",
    phone: null,
    location: "Hyderabad",
    links: [],
  },
  // Null rather than absent: the contract makes this a required field with a nullable
  // value precisely so a construction site cannot drop it silently.
  summary: null,
  education: [],
  experience: [
    {
      // The one substantive node. The validator refuses a tailoring that selects no
      // experience, project or education, so every happy-path test must cite this.
      id: "exp-eventportal",
      company: "College Event Cell",
      role: "Backend Intern",
      location: "Hyderabad",
      start_display: "Jun 2025",
      end_display: "Aug 2025",
      start_date: null,
      end_date: null,
      bullets: [
        {
          // Ground truth for every honesty judgement below.
          id: "bullet-rest-api",
          text: "Built a REST API with Express and Node.js for a college event portal, handling 500 users",
          tags: ["node", "express", "rest"],
        },
      ],
    },
  ],
  projects: [],
  skills: [
    {
      // One skill, so a citation of a real skill ref is exercised alongside a fake one.
      id: "skill-node",
      name: "Node.js",
      category: "Languages",
    },
  ],
  achievements: [],
  certifications: [],
  links: [],
};

// A tailoring that cites only real nodes and rewords nothing. Identity rewording is
// deliberate: it isolates the RUNNER's behaviour from the validator's honesty rules,
// which have their own 54KB of tests and are not what this file is measuring.
const HONEST_TAILORING: TailoredProfile = {
  schema_version: 1,
  // Echoes the pin, which is what lets the validator detect a stale tailoring.
  master_version: MASTER_VERSION,
  section_order: ["experience", "skills"],
  summary: null,
  skills: [{ ref: "skill-node" }],
  experience: [
    {
      ref: "exp-eventportal",
      bullets: [
        {
          ref: "bullet-rest-api",
          text: "Built a REST API with Express and Node.js for a college event portal, handling 500 users",
        },
      ],
    },
  ],
  projects: [],
  education: [],
  achievements: [],
  certifications: [],
};

// The posting, held once so the untrusted-region test and the happy path agree on it.
const POSTING = {
  jobTitle: "Backend Engineer Intern",
  company: "Acme Corp",
  jobDescription: "We need someone who knows Node.js and REST APIs.",
};

// Build a tailorer whose model returns exactly this text. The seam is the whole reason
// the runner is testable without Gemini, a network or a key pool.
function tailorerReturning(raw: string) {
  return createTailorer({
    // Resolves immediately: the runner's job is what it does with the text, not waiting.
    callLlm: () => Promise.resolve(raw),
    master: MASTER,
    masterVersion: MASTER_VERSION,
  });
}

test("an honest tailoring resolves to a ResolvedResume", async () => {
  // The model returns exactly what the schema asked for.
  const tailor = tailorerReturning(JSON.stringify(HONEST_TAILORING));

  const outcome = await tailor(POSTING);

  // The discriminant first — a wrong kind makes every field assertion below meaningless.
  assert.equal(outcome.kind, "tailored");
  // Narrow for the compiler, and fail loudly rather than silently skipping the rest.
  if (outcome.kind !== "tailored") return;
  // Identity is carried across verbatim from the master, never from the model.
  assert.equal(outcome.resume.identity.full_name, "Teja Mallam");
  // The pin travels into the resolved resume so a stale render is detectable later.
  assert.equal(outcome.resume.master_version, MASTER_VERSION);
  // The bullet resolved against the master rather than being echoed from the response.
  assert.equal(outcome.resume.experience[0].bullets[0].master_text, MASTER.experience[0].bullets[0].text);
});

test("an honest tailoring carries its raw refs for the Auditor", async () => {
  const tailor = tailorerReturning(JSON.stringify(HONEST_TAILORING));

  const outcome = await tailor(POSTING);

  // Narrow for the compiler; the kind itself is asserted by the test above.
  assert.equal(outcome.kind, "tailored");
  if (outcome.kind !== "tailored") return;
  // The raw ref-based output, before resolution. The Auditor's summary-ref check
  // (detector.ts:503) reads `tailor_refs` and could never fire while nothing kept these.
  assert.deepEqual(outcome.refs, HONEST_TAILORING);
});

test("a tailoring citing a ref absent from the master is refused, not thrown", async () => {
  // One fabricated skill ref. Everything else is honest, so a refusal here can only be
  // about the fake ref — the test names one cause, not a soup of them.
  const fabricated: TailoredProfile = {
    ...HONEST_TAILORING,
    skills: [{ ref: "skill-kubernetes-never-used" }],
  };
  const tailor = tailorerReturning(JSON.stringify(fabricated));

  const outcome = await tailor(POSTING);

  // A REFUSAL, NOT A THROW. This is the assertion the whole module exists to satisfy:
  // a fabrication is a verdict the dashboard has to render, so it must survive as data.
  assert.equal(outcome.kind, "refused");
  if (outcome.kind !== "refused") return;
  // Carrying at least one reason is the difference between a refusal and a shrug.
  assert.ok(outcome.violations.length > 0);
});

test("a tailoring computed against a different master version is refused", async () => {
  // The model echoed a version we did not pin. §9's resume pinning depends on this
  // being caught: resolving it would produce a resume nobody approved.
  const stale: TailoredProfile = { ...HONEST_TAILORING, master_version: MASTER_VERSION + 1 };
  const tailor = tailorerReturning(JSON.stringify(stale));

  const outcome = await tailor(POSTING);

  // Refused rather than thrown, for the same reason as a fabrication: it is a verdict.
  assert.equal(outcome.kind, "refused");
  if (outcome.kind !== "refused") return;
  // Named distinctly by the validator so retry logic can tell it from a fabrication.
  assert.ok(outcome.violations.some((v) => v.kind === "master_version_mismatch"));
});

test("a response that is not JSON throws rather than returning a refusal", async () => {
  // A model that returned prose has not tailored anything. Reporting that as a refusal
  // would file a transport failure as a dishonesty finding — the wrong bug, in the
  // wrong dashboard, against a model that may be working fine.
  const tailor = tailorerReturning("I'm sorry, I can't help with that request.");

  // MATCHED ON MESSAGE, NOT MERELY ON REJECTING. A bare `assert.rejects` passes on ANY
  // error, including a TypeError thrown from somewhere we never intended to reach —
  // which would let this test stay green while guarding nothing. §5: a guard that can
  // pass vacuously is not a guard.
  await assert.rejects(() => tailor(POSTING), /not JSON/);
});

test("a response missing a required array throws rather than reaching the validator", async () => {
  // `achievements` dropped. THE POINT: the validator walks this array with no runtime
  // guard (`validator.ts:646`), so without a shape check here the failure surfaces as a
  // TypeError from inside the honesty checker — a crash that reads like our bug when it
  // is actually a malformed model response.
  const { achievements: _dropped, ...missingArray } = HONEST_TAILORING;
  const tailor = tailorerReturning(JSON.stringify(missingArray));

  // NAMES THE ARRAY, so this fails if the validator's TypeError surfaces instead of our
  // shape check. Delete the check in `parseTailoredProfile` and the run still rejects —
  // with a TypeError from `validator.ts:646` — so a bare `assert.rejects` here would
  // guard the exact bug it was written to catch, and pass anyway.
  await assert.rejects(() => tailor(POSTING), /achievements array/);
});

test("the posting text reaches the model as untrusted content, never as instruction", async () => {
  // Capture what the runner actually sends. Asserting on the prompt the seam receives
  // is the only way to prove the trust boundary survived the wiring — the fence is
  // built in prompt.ts, but a runner is free to hand it the wrong field.
  let seen: { systemInstruction: string; userContent: string } | null = null;
  const tailor = createTailorer({
    callLlm: (prompt) => {
      // Record, then answer honestly so the test fails on the boundary, not on parsing.
      seen = { systemInstruction: prompt.systemInstruction, userContent: prompt.userContent };
      return Promise.resolve(JSON.stringify(HONEST_TAILORING));
    },
    master: MASTER,
    masterVersion: MASTER_VERSION,
  });

  await tailor(POSTING);

  // Prove the call happened at all — an assertion against a null capture would pass
  // vacuously, which §5 names as the shape of a guard that is not a guard.
  assert.ok(seen !== null);
  // The scraped description belongs in the untrusted region.
  assert.ok(seen!.userContent.includes("Node.js and REST APIs"));
  // And must never appear in the instruction region, where it could steer the model.
  assert.equal(seen!.systemInstruction.includes("Node.js and REST APIs"), false);
});

// ---------------------------------------------------------------------------
// SCHEMA <-> PARSER AGREEMENT. Found by a live rehearsal, not by this suite: the
// parser demanded `achievements` and `certifications` while `TAILOR_RESPONSE_SCHEMA`
// never offered them, and structured output cannot emit a key the schema lacks — so
// every real call threw. Every test above hand-builds its response, which is why
// nothing caught it. These tests derive both sides from the shipped constants.
// ---------------------------------------------------------------------------

// The schema's top-level `required` and `properties`, read off the shipped object.
const schemaRequired: readonly string[] = TAILOR_RESPONSE_SCHEMA.required;
// Property names the model is permitted to emit at all.
const schemaProperties = Object.keys(TAILOR_RESPONSE_SCHEMA.properties);

test("every array the parser requires is required and declared by the response schema", () => {
  // Guard against a vacuous pass: an empty tuple would satisfy every loop below.
  assert.ok(TAILOR_REQUIRED_ARRAY_KEYS.length > 0);
  // The parser's OWN constant, not a list written here, so a key added to the parser
  // without the schema fails this test by name.
  for (const key of TAILOR_REQUIRED_ARRAY_KEYS) {
    // Declared: otherwise structured output can never emit it.
    assert.ok(schemaProperties.includes(key), `schema.properties lacks ${key}`);
    // Required: otherwise the model may legally omit what the parser cannot do without.
    assert.ok(schemaRequired.includes(key), `schema.required lacks ${key}`);
  }
  // The two scalars the parser also refuses to go without are required too.
  for (const key of ["master_version", "section_order"]) {
    // Named in the message so a failure points at the missing key.
    assert.ok(schemaRequired.includes(key), `schema.required lacks ${key}`);
  }
});

test("section_order's enum offers exactly the contract's section kinds", () => {
  // The enum as actually shipped, dug out of the schema rather than restated.
  const sectionEnum = TAILOR_RESPONSE_SCHEMA.properties.section_order.items.enum;
  // Exactly the tuple whose agreement with `TailoredSectionKind` deno check enforces,
  // so the chain type -> tuple -> schema has no hand-written link.
  assert.deepEqual(sectionEnum, [...TAILOR_SECTION_KINDS]);
  // And the two award sections specifically, because they are the ones that were missing.
  assert.ok(sectionEnum.includes("achievements") && sectionEnum.includes("certifications"));
});

// Build an instance of a JSON-schema node: every declared property, one item per array.
// Walking the schema itself is what makes the response "shaped by the schema" rather
// than shaped by whoever wrote the test.
function instanceOf(node: Record<string, unknown>): unknown {
  // An enum takes its first value, so `section_order` holds a legal section name.
  if (Array.isArray(node.enum)) return node.enum[0];
  // Objects get EVERY property the schema declares, required or not.
  if (node.type === "object") {
    // Properties walked in declaration order; absent means an empty object.
    const props = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
    // Recurse per property.
    return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, instanceOf(v)]));
  }
  // One item, so the parser's per-entry ref-and-bullets check is actually exercised.
  if (node.type === "array") return [instanceOf(node.items as Record<string, unknown>)];
  // The pin; any number would parse, the real one keeps the verdict about refs only.
  if (node.type === "integer") return MASTER_VERSION;
  // Strings become a ref no master holds, so the validator answers instead of crashing.
  if (node.type === "string") return "schema-shaped-ref";
  // A schema type this walker does not know is a test bug; fail loudly, never guess.
  throw new Error(`instanceOf: unhandled schema node ${JSON.stringify(node)}`);
}

test("a response shaped by the schema parses and reaches the validator", async () => {
  // Every schema property present, every array holding one schema-shaped item.
  const shaped = instanceOf(TAILOR_RESPONSE_SCHEMA) as Record<string, unknown>;
  // Non-vacuity: the instance really carries the award arrays the parser demands.
  assert.ok(Array.isArray(shaped.achievements) && Array.isArray(shaped.certifications));

  // Parsed, then judged. A shape failure would REJECT; reaching "refused" proves the
  // parser accepted it and the validator ran (the refs resolve to nothing, by design).
  const outcome = await tailorerReturning(JSON.stringify(shaped))(POSTING);
  // The discriminant is the evidence of a verdict rather than a thrown shape error.
  assert.equal(outcome.kind, "refused");
});

test("a schema-legal response that omits the optional summary still parses", async () => {
  // `summary` is declared but not required, so the model may leave it out entirely.
  const { summary: _omitted, ...withoutSummary } = instanceOf(TAILOR_RESPONSE_SCHEMA) as Record<string, unknown>;
  // Guard that the omission actually happened, or this is the test above twice.
  assert.equal("summary" in withoutSummary, false);

  // Before the parser normalised absence to null, `undefined !== null` sent this down
  // the malformed-summary branch and a schema-legal answer threw.
  const outcome = await tailorerReturning(JSON.stringify(withoutSummary))(POSTING);
  // A verdict, not a throw.
  assert.equal(outcome.kind, "refused");
});

// THE LIVE REPLY SHAPE, not a fixture. HONEST_TAILORING carries schema_version: 1, but the
// schema Gemini is SENT has no such property, so a real reply never contains it. That gap
// kept every test green while live tailor_refs lacked the field and the web editor's gate
// refused every row (found by applyyy-e8, 2026-10-08). This keeps ONLY the keys the shipped
// schema declares, i.e. exactly what a schema-conforming model can return.
const LIVE_SHAPED_REPLY = Object.fromEntries(
  // Every key of the fixture that the sent schema also declares; nothing else survives.
  Object.entries(HONEST_TAILORING).filter(([key]) => key in (TAILOR_RESPONSE_SCHEMA.properties as Record<string, unknown>)),
);

test("a schema-shaped reply (no schema_version) is stamped schema_version 1 in the stored refs", async () => {
  // Precondition, so this test cannot pass vacuously if the schema ever gains the field.
  assert.equal("schema_version" in LIVE_SHAPED_REPLY, false);
  // The model returns only what the schema allowed it to.
  const tailor = tailorerReturning(JSON.stringify(LIVE_SHAPED_REPLY));
  // Run the real parse -> validate path.
  const outcome = await tailor(POSTING);
  // A clean tailoring, so the refs are what persist.ts writes into tailor_refs.
  assert.equal(outcome.kind, "tailored");
  // Narrow for the compiler.
  if (outcome.kind !== "tailored") return;
  // The producer now matches its own type: TailoredProfile declares schema_version: 1.
  assert.equal(outcome.refs.schema_version, 1);
});

test("a reply claiming a different schema_version is refused, never restamped", async () => {
  // A model (or a future schema) asserting another contract version is not ours to coerce.
  const tailor = tailorerReturning(JSON.stringify({ ...LIVE_SHAPED_REPLY, schema_version: 2 }));
  // Thrown as a shape failure, like every other malformed reply.
  await assert.rejects(tailor(POSTING), /schema_version/);
});


// ---- A ref the model emitted twice is normalised, not refused (2026-11-05) -------------------------
// Live: EA "Data Science Intern" (match 84) failed with one violation, duplicate_ref skill_python in
// skills: the model listed one master skill twice. The validator still refuses duplicates (its own test
// stays); the TAILORER now drops the second copy BEFORE validating, and says so in the outcome.

test("a skill listed twice is deduplicated before the validator, and the dedupe is reported", async () => {
  // EA's shape: an honest tailoring whose one skill appears twice.
  const repeated: TailoredProfile = { ...HONEST_TAILORING, skills: [{ ref: "skill-node" }, { ref: "skill-node" }] };
  const outcome = await tailorerReturning(JSON.stringify(repeated))(POSTING);
  // Tailored, not refused.
  assert.equal(outcome.kind, "tailored");
  if (outcome.kind !== "tailored") return;
  // The stored refs hold the skill once: tailor_refs must re-validate to the same resume.
  assert.deepEqual(outcome.refs.skills, [{ ref: "skill-node" }]);
  // The repair is visible, never silent: one dropped copy, named by ref and section.
  assert.deepEqual(outcome.dedupedRefs, [{ ref: "skill-node", where: "skills" }]);
});

test("control: a FABRICATED ref is still refused, duplicate or not", async () => {
  // The same repeat plus a ref the master does not have.
  const fabricated: TailoredProfile = { ...HONEST_TAILORING, skills: [{ ref: "skill-node" }, { ref: "skill-node" }, { ref: "skill-kubernetes-never-used" }] };
  const outcome = await tailorerReturning(JSON.stringify(fabricated))(POSTING);
  // Normalisation never vouches for content: the fabrication is refused as before.
  assert.equal(outcome.kind, "refused");
  if (outcome.kind !== "refused") return;
  // For the fabricated ref, not for the repeat.
  assert.ok(outcome.violations.some((v) => v.kind === "unresolved_ref"), JSON.stringify(outcome.violations));
  assert.ok(!outcome.violations.some((v) => v.kind === "duplicate_ref"), JSON.stringify(outcome.violations));
});
