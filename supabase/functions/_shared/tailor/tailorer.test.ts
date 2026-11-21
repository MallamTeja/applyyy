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
import { createTailorer, orderByJdRelevance, shapeSkillGroups, SKILLS_MAX_GROUPS, SKILLS_MIN_GROUPS, SKILLS_PER_GROUP_CAP, skillTwinKey, TAILOR_REQUIRED_ARRAY_KEYS } from "./tailorer.ts";
// The one-line width model the shaper filled with until 2026-11-21; kept to prove the 2-line engine goes past it.
import { skillGroupFitsOneLine } from "../../../../packages/resume-template/src/index.ts";
// The 2-line engine (2026-11-21): the line counter at every rung, and the ladder itself.
import { skillGroupLineCount, TYPOGRAPHY_LADDER } from "../../../../packages/resume-template/src/page-fit.ts";
// The skill preference profile: the live one, and its type for the per-test profiles.
import { SKILL_PROFILE, type SkillProfile } from "./skill-profile.ts";
// The live HTML posting excerpt (row 76280e87), shared with the postingText suite.
import { CIRCUITHUB_HTML } from "./posting-html.fixture.ts";
// The schema Gemini is actually sent, and the section tuple its enum is built from —
// imported, never restated, so these tests check the shipped values.
import { TAILOR_RESPONSE_SCHEMA, TAILOR_SECTION_KINDS } from "./prompt.ts";
// The contract types, reached through this stream's single re-export module. Nothing
// here redefines one — a redefined type does not fail, it drifts.
import type { MasterProfile, TailoredProfile } from "../contracts/shared-types.ts";
// The floors' single home: the AI-group tests read the AI category name and its minimum from here, never restated.
import { PAGE_FIT_FLOORS } from "./page-trim.ts";

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
  // Plus the header role title the tailor adds from the posting (rule 5, 2026-11-08), so the rebuild prints it too.
  assert.deepEqual(outcome.refs, { ...HONEST_TAILORING, headline_title: "Backend Engineer Intern" });
});

test("a tailoring citing a ref absent from the master is refused, not thrown", async () => {
  // One fabricated EXPERIENCE ref (an employer never held). Everything else is honest, so a refusal here
  // can only be about the fake ref. A fabricated SKILL ref is dropped before the gate since D1 (2026-11-07),
  // so an entry ref is what exercises the refusal now.
  const fabricated: TailoredProfile = {
    ...HONEST_TAILORING,
    experience: [...HONEST_TAILORING.experience, { ref: "exp-never-held", bullets: [] }],
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
  // The same repeat plus an ENTRY ref the master does not have (a fabricated skill is dropped since D1).
  const fabricated: TailoredProfile = { ...HONEST_TAILORING, skills: [{ ref: "skill-node" }, { ref: "skill-node" }], experience: [...HONEST_TAILORING.experience, { ref: "exp-never-held", bullets: [] }] };
  const outcome = await tailorerReturning(JSON.stringify(fabricated))(POSTING);
  // Normalisation never vouches for content: the fabrication is refused as before.
  assert.equal(outcome.kind, "refused");
  if (outcome.kind !== "refused") return;
  // For the fabricated ref, not for the repeat.
  assert.ok(outcome.violations.some((v) => v.kind === "unresolved_ref"), JSON.stringify(outcome.violations));
  assert.ok(!outcome.violations.some((v) => v.kind === "duplicate_ref"), JSON.stringify(outcome.violations));
});


// ---- One-shot bullet rewrite (2026-11-05) ----------------------------------------------------------
// 97 of 130 tailor violations in 30 days were unverifiable_token: a bullet reworded with a word the
// master never says ("robust", "ensure", "auditing"). When EVERY violation is such a word on a BULLET, the
// tailorer asks the model once to rewrite only those bullets, then re-validates the WHOLE profile with the
// unchanged validator. Anything else fails as before, with no extra call.

// The first attempt: the one bullet reworded with an invented adjective.
const INVENTED_ONCE: TailoredProfile = {
  ...HONEST_TAILORING,
  experience: [{ ref: "exp-eventportal", bullets: [{ ref: "bullet-rest-api", text: "Built a robust REST API with Express and Node.js for a college event portal, handling 500 users" }] }],
};

// A tailorer whose model answers each call with the next reply, counting the calls.
function tailorerReplying(replies: string[]) {
  // Calls made, and the prompts they carried.
  const prompts: { systemInstruction: string; userContent: string }[] = [];
  const tailor = createTailorer({
    // One reply per call, in order; a third call would be a bug.
    callLlm: (prompt) => {
      prompts.push(prompt);
      const next = replies.shift();
      return next === undefined ? Promise.reject(new Error("unexpected extra call")) : Promise.resolve(next);
    },
    master: MASTER,
    masterVersion: MASTER_VERSION,
  });
  return { tailor, prompts };
}

test("retry: a bullet with one invented word is rewritten once and the whole profile passes", async () => {
  // First: the invented word. Retry: the master's own wording.
  const { tailor, prompts } = tailorerReplying([
    JSON.stringify(INVENTED_ONCE),
    JSON.stringify({ bullets: [{ ref: "bullet-rest-api", text: "Built a REST API with Express and Node.js for a college event portal, handling 500 users" }] }),
  ]);
  const outcome = await tailor(POSTING);
  // Tailored, after exactly two calls.
  assert.equal(outcome.kind, "tailored");
  assert.equal(prompts.length, 2);
  if (outcome.kind !== "tailored") return;
  // The retry is on record: what failed first, and which bullets were rewritten.
  assert.deepEqual(outcome.retry, { firstViolations: [{ kind: "unverifiable_token", ref: "bullet-rest-api", token: "robust" }], rewrittenRefs: ["bullet-rest-api"] });
  // The retry prompt names the banned word and carries the master text, and never the posting.
  assert.match(prompts[1]!.userContent, /robust/);
  assert.match(prompts[1]!.systemInstruction, /Built a REST API with Express and Node\.js/);
  assert.doesNotMatch(prompts[1]!.systemInstruction + prompts[1]!.userContent, /We need someone who knows/);
});

test("retry: a rewrite that still invents a word fails, with BOTH attempts' violations", async () => {
  // The retry swaps one invented word for another.
  const { tailor, prompts } = tailorerReplying([
    JSON.stringify(INVENTED_ONCE),
    JSON.stringify({ bullets: [{ ref: "bullet-rest-api", text: "Built a scalable REST API with Express and Node.js for a college event portal, handling 500 users" }] }),
  ]);
  const outcome = await tailor(POSTING);
  // Refused after two calls: the gate is unchanged.
  assert.equal(outcome.kind, "refused");
  assert.equal(prompts.length, 2);
  if (outcome.kind !== "refused") return;
  // The final violations, and the first attempt's.
  assert.deepEqual(outcome.violations, [{ kind: "unverifiable_token", ref: "bullet-rest-api", token: "scalable" }]);
  assert.deepEqual(outcome.retry, { firstViolations: [{ kind: "unverifiable_token", ref: "bullet-rest-api", token: "robust" }], result: "still_invalid" });
});

test("retry: an unresolved ref is not retried (one call, fails as before)", async () => {
  // A fabricated entry plus the invented word: not ONLY unverifiable tokens (an entry, since a fabricated
  // skill is dropped before the gate under D1).
  const { tailor, prompts } = tailorerReplying([JSON.stringify({ ...INVENTED_ONCE, experience: [...INVENTED_ONCE.experience, { ref: "exp-never-held", bullets: [] }] })]);
  const outcome = await tailor(POSTING);
  // Refused on the first verdict.
  assert.equal(outcome.kind, "refused");
  assert.equal(prompts.length, 1);
  if (outcome.kind !== "refused") return;
  // No retry on record.
  assert.equal(outcome.retry, null);
});

test("retry: a word problem alongside a summary problem is not retried (one call)", async () => {
  // A summary with prose but no refs fails summary_without_refs, which a bullet rewrite cannot fix.
  const { tailor, prompts } = tailorerReplying([JSON.stringify({ ...INVENTED_ONCE, summary: { text: "Backend engineer.", refs: [] } })]);
  const outcome = await tailor(POSTING);
  // One call, refused.
  assert.equal(outcome.kind, "refused");
  assert.equal(prompts.length, 1);
});

test("retry: retryableBullets refuses any word violation that is not on a bullet of this profile", async () => {
  // Imported here so earlier tests do not depend on the new export.
  const { retryableBullets } = await import("./tailorer.ts");
  // On the bullet: retryable, grouped by bullet. Re-pinned 2026-11-21 (S4b): each bullet now carries the words
  // to drop AND the numbers to keep, because a dropped_metric is fixed by the same rewrite.
  assert.deepEqual(retryableBullets([{ kind: "unverifiable_token", ref: "bullet-rest-api", token: "robust" }], INVENTED_ONCE), new Map([["bullet-rest-api", { drop: ["robust"], keep: [] }]]));
  // On the summary or a skill (refs that are not bullets here): no retry, the rewrite only fixes bullets.
  assert.equal(retryableBullets([{ kind: "unverifiable_token", ref: "skill-node", token: "robust" }], INVENTED_ONCE), null);
  assert.equal(retryableBullets([{ kind: "unverifiable_token", ref: "summary", token: "robust" }], INVENTED_ONCE), null);
  // Any other kind in the list: no retry.
  assert.equal(retryableBullets([{ kind: "unverifiable_token", ref: "bullet-rest-api", token: "robust" }, { kind: "empty_selection" }], INVENTED_ONCE), null);
});

// ---- S4b (2026-11-21): the one-shot rewrite also fixes untraced_tech and dropped_metric ----------------------
// On the 26-row golden run (peer 3 r5) 5 of 26 tailorings were refused: 2 dropped_metric, 2 untraced_tech, 1
// misattributed_bullet. The first two are bullet-TEXT faults the existing rewrite can repair (drop a tech name the
// sources never state; put back a number the master states). misattributed_bullet needs a move or a source edit,
// which a {ref, text} rewrite cannot express, so it stays a refusal with no extra call.

// A bullet on the sources path, in the shape the live prompt asks for: it cites itself.
const withSources = (text: string): TailoredProfile => ({ ...HONEST_TAILORING, experience: [{ ref: "exp-eventportal", bullets: [{ ref: "bullet-rest-api", text, sources: ["bullet-rest-api"] }] }] });

test("S4b retry gate: untraced_tech joins the words to drop, dropped_metric the numbers to keep, both on one bullet", async () => {
  // The gate under test.
  const { retryableBullets } = await import("./tailorer.ts");
  // Three faults on the same bullet: one invented word, one untraced tech name, one lost number.
  const got = retryableBullets([
    { kind: "unverifiable_token", ref: "bullet-rest-api", token: "robust" },
    { kind: "untraced_tech", ref: "bullet-rest-api", term: "Docker" },
    { kind: "dropped_metric", ref: "bullet-rest-api", value: "500" },
  ], INVENTED_ONCE);
  // One rewrite item carries all three.
  assert.deepEqual(got, new Map([["bullet-rest-api", { drop: ["robust", "Docker"], keep: ["500"] }]]));
});

test("S4b retry gate: misattributed_bullet, or a fault off this profile's bullets, is never retried", async () => {
  // The gate under test.
  const { retryableBullets } = await import("./tailorer.ts");
  // A source from another entry: a text rewrite cannot remove a citation.
  assert.equal(retryableBullets([{ kind: "untraced_tech", ref: "bullet-rest-api", term: "Docker" }, { kind: "misattributed_bullet", ref: "bullet-other", parentRef: "exp-eventportal" }], INVENTED_ONCE), null);
  // A number on a bullet this profile does not print: nothing to rewrite.
  assert.equal(retryableBullets([{ kind: "dropped_metric", ref: "bullet-not-here", value: "500" }], INVENTED_ONCE), null);
  // An untraced name on a ref that is not a bullet here.
  assert.equal(retryableBullets([{ kind: "untraced_tech", ref: "summary", term: "Docker" }], INVENTED_ONCE), null);
});

test("S4b retry: a bullet that names a tech its sources never state is rewritten once and passes", async () => {
  // First: Docker, which the master bullet never names. Retry: the master's own wording.
  const { tailor, prompts } = tailorerReplying([
    JSON.stringify(withSources("Built a REST API with Express, Node.js and Docker for a college event portal, handling 500 users")),
    JSON.stringify({ bullets: [{ ref: "bullet-rest-api", text: "Built a REST API with Express and Node.js for a college event portal, handling 500 users" }] }),
  ]);
  const outcome = await tailor(POSTING);
  // Tailored after exactly two calls.
  assert.equal(outcome.kind, "tailored");
  assert.equal(prompts.length, 2);
  if (outcome.kind !== "tailored") return;
  // The first verdict was the untraced name, and it is on record.
  assert.ok(outcome.retry !== null && outcome.retry.firstViolations.some((v) => v.kind === "untraced_tech" && v.term === "Docker"));
  // The rewrite prompt told the model to drop it.
  assert.match(prompts[1]!.userContent, /words to drop: [^\n]*Docker/);
});

test("S4b retry: a bullet that lost the master's number is rewritten once with that number named as kept", async () => {
  // First: the "500 users" fact cut. Retry: put back.
  const { tailor, prompts } = tailorerReplying([
    JSON.stringify(withSources("Built a REST API with Express and Node.js for a college event portal")),
    JSON.stringify({ bullets: [{ ref: "bullet-rest-api", text: "Built a REST API with Express and Node.js for a college event portal, handling 500 users" }] }),
  ]);
  const outcome = await tailor(POSTING);
  // Tailored after exactly two calls.
  assert.equal(outcome.kind, "tailored");
  assert.equal(prompts.length, 2);
  if (outcome.kind !== "tailored") return;
  // The first verdict was the dropped number.
  assert.deepEqual(outcome.retry?.firstViolations, [{ kind: "dropped_metric", ref: "bullet-rest-api", value: "500" }]);
  // The number to keep is TRUSTED (it comes from the master), so it sits in the system region, never the fence.
  assert.match(prompts[1]!.systemInstruction, /bullet-rest-api must keep: 500/);
  assert.doesNotMatch(prompts[1]!.userContent, /must keep/);
});

test("S4b retry: a rewrite that still drops the number is refused with both attempts on record", async () => {
  // The retry ignores the keep line.
  const { tailor, prompts } = tailorerReplying([
    JSON.stringify(withSources("Built a REST API with Express and Node.js for a college event portal")),
    JSON.stringify({ bullets: [{ ref: "bullet-rest-api", text: "Built a REST API with Express and Node.js for a college event portal" }] }),
  ]);
  const outcome = await tailor(POSTING);
  // Refused after two calls: the gate itself is unchanged.
  assert.equal(outcome.kind, "refused");
  assert.equal(prompts.length, 2);
  if (outcome.kind !== "refused") return;
  // Both verdicts recorded.
  assert.deepEqual(outcome.retry, { firstViolations: [{ kind: "dropped_metric", ref: "bullet-rest-api", value: "500" }], result: "still_invalid" });
});

test("retry: a reply naming a bullet that did not fail is unusable (no partial merge)", async () => {
  // The rewrite answers for a ref that was never asked for.
  const { tailor, prompts } = tailorerReplying([
    JSON.stringify(INVENTED_ONCE),
    JSON.stringify({ bullets: [{ ref: "bullet-other", text: "Built a REST API" }] }),
  ]);
  const outcome = await tailor(POSTING);
  // Refused after the two calls, the reply recorded as unusable.
  assert.equal(outcome.kind, "refused");
  assert.equal(prompts.length, 2);
  if (outcome.kind !== "refused") return;
  assert.deepEqual(outcome.retry, { firstViolations: [{ kind: "unverifiable_token", ref: "bullet-rest-api", token: "robust" }], result: "reply_unusable" });
  // The final violations are the first attempt's: nothing was merged.
  assert.deepEqual(outcome.violations, [{ kind: "unverifiable_token", ref: "bullet-rest-api", token: "robust" }]);
});

// --- the skills section shape (Teja, 2026-11-06: 1-2 skills per group "is not enough"; "I don't need
// all these groups"; "make groups from master and skills for them according to the JD") --------------

// A master with four groups of different sizes: one the floor fills, one smaller than the floor, one a
// backend posting names but the model may skip, and one (Machine Learning) a backend posting never names.
const SHAPE_MASTER: MasterProfile = {
  // Everything but skills is the honest fixture's, so only the skills shape varies.
  ...MASTER,
  skills: [
    // Languages: five in all, so the floor of 4 is reachable and one is left out.
    { id: "skill-node", name: "Node.js", category: "Languages" },
    { id: "lang-python", name: "Python", category: "Languages" },
    { id: "lang-go", name: "Go", category: "Languages" },
    { id: "lang-sql", name: "SQL", category: "Languages" },
    { id: "lang-ts", name: "TypeScript", category: "Languages" },
    // DevOps: only two, so the floor is capped at the group's size.
    { id: "dev-docker", name: "Docker", category: "DevOps" },
    { id: "dev-gcp", name: "Google Cloud Platform", category: "DevOps" },
    // Machine Learning: a group the backend posting never mentions.
    { id: "ml-xgboost", name: "XGBoost", category: "Machine Learning" },
    { id: "ml-shap", name: "SHAP", category: "Machine Learning" },
    // Tools: shown only when the posting names one of them.
    { id: "tool-git", name: "Git", category: "Tools" },
    { id: "tool-jira", name: "Jira", category: "Tools" },
    { id: "tool-postman", name: "Postman", category: "Tools" },
    { id: "tool-slack", name: "Slack", category: "Tools" },
  ],
};

// A backend posting naming Node.js, SQL, TypeScript and Docker, and nothing from ML or Tools.
const BACKEND_POSTING = { ...POSTING, jobDescription: "Backend role: SQL and TypeScript on Node.js services, shipped with Docker." };

// Runs the real tailorer over SHAPE_MASTER with a model that returns exactly `skills`.
async function shapeOutcome(skills: readonly { ref: string }[], posting: typeof POSTING) {
  // The honest tailoring with only its skills replaced, so the rest always validates.
  const answer: TailoredProfile = { ...HONEST_TAILORING, skills };
  // The real runner: dedupe, shape, validate, exactly as production runs it.
  const tailor = createTailorer({ callLlm: () => Promise.resolve(JSON.stringify(answer)), master: SHAPE_MASTER, masterVersion: MASTER_VERSION });
  return await tailor(posting);
}

// Group sizes on a resolved resume, by category, in first-appearance order.
function groupSizes(resume: { readonly skills: readonly { readonly category: string }[] }): Record<string, number> {
  // Counted per group.
  const sizes = new Map<string, number>();
  // One pass over the printed skills.
  for (const skill of resume.skills) sizes.set(skill.category, (sizes.get(skill.category) ?? 0) + 1);
  // A plain object, so deepEqual compares it against a literal.
  return Object.fromEntries(sizes);
}

// THE RED-ON-REVERT TEST: drop the shapeSkillGroups call in createTailorer and this goes red.
test("skills shape: a backend posting shows its relevant groups first, topped up to five groups (2026-11-11), leading groups at min(6, size)", async () => {
  // The live 1-per-group shape, plus an ML pick the backend posting gives no reason for.
  const outcome = await shapeOutcome([{ ref: "skill-node" }, { ref: "dev-docker" }, { ref: "ml-xgboost" }], BACKEND_POSTING);
  // Topped-up refs still pass the unchanged validator: only master refs are ever added.
  assert.equal(outcome.kind, "tailored");
  if (outcome.kind !== "tailored") return;
  // Re-pinned 2026-11-21 (skills engine): Languages and DevOps lead (the posting covers them), D2 adds the model's ML
  // group, Tools fills toward 5 groups (this master holds only 4). Every group shows all it can (up to 7, two lines);
  // Tools is 3 because Slack is on the live never-list (Teja removed it; skill-profile.ts).
  assert.deepEqual(groupSizes(outcome.resume), { Languages: 5, DevOps: 2, "Machine Learning": 2, Tools: 3 });
  // Added in page order: Languages' JD-mentioned TypeScript and SQL, then its core Python, then Go; DevOps' GCP; ML's SHAP;
  // Tools' core Git and Postman, then Jira.
  assert.deepEqual(outcome.skillsAdded, ["lang-ts", "lang-sql", "lang-python", "lang-go", "dev-gcp", "ml-shap", "tool-git", "tool-postman", "tool-jira"]);
  // Nothing dropped: the ML pick fills the third group.
  assert.deepEqual(outcome.skillsDropped, []);
  // The stored refs are the shaped profile, so tailor_refs re-validates to this exact resume. Inside Languages the three
  // the posting mentions lead (a tie, so live-profile core rank orders TypeScript before SQL; Node.js is not a Languages
  // core), then the core Python, then master order (2026-11-18 21:47: mentioned > core > the rest).
  assert.deepEqual(outcome.refs.skills.map((s) => s.ref), ["lang-ts", "lang-sql", "skill-node", "lang-python", "lang-go", "dev-docker", "dev-gcp", "ml-xgboost", "ml-shap", "tool-git", "tool-postman", "tool-jira"]);
});

// RED 1 (review 2026-11-07; Teja: "rank by the JD"): inside a group, a skill the posting names comes
// before a model pick it does not name. The old shape kept the model's picks first. Red on revert.
test("skills shape: inside a group, a posting-named skill ranks ahead of a model pick the posting never names", async () => {
  // The model leads with Python and Go; the posting names neither, only SQL, TypeScript and Node.js.
  const outcome = await shapeOutcome([{ ref: "lang-python" }, { ref: "lang-go" }, { ref: "skill-node" }, { ref: "lang-sql" }], BACKEND_POSTING);
  assert.equal(outcome.kind, "tailored");
  if (outcome.kind !== "tailored") return;
  // The Languages refs in page order (re-pinned 2026-11-21): the three the posting names first (a tie, ordered by live
  // core rank, TypeScript before SQL, then Node.js), then the model's Python (core) and Go. Neither model pick leads.
  const languages = outcome.refs.skills.map((s) => s.ref).filter((ref) => ref.startsWith("lang-") || ref === "skill-node");
  assert.deepEqual(languages, ["lang-ts", "lang-sql", "skill-node", "lang-python", "lang-go"]);
});

// Yellow (review 2026-11-07): the page orders groups by first appearance, so the shape must emit the
// most relevant group first, not whichever group the model happened to list first. Red on revert.
test("skills shape: the most relevant group comes first on the page even when the model listed it last", async () => {
  // The model lists DevOps (1 posting-named skill) before Languages (3).
  const outcome = await shapeOutcome([{ ref: "dev-docker" }, { ref: "skill-node" }], BACKEND_POSTING);
  assert.equal(outcome.kind, "tailored");
  if (outcome.kind !== "tailored") return;
  // Group order on the resolved resume, by first appearance.
  // Relevant groups first by relevance; the master's other groups follow (min 5 groups, 2026-11-11), since 2026-11-21 in
  // the live profile's group order (Tools before Machine Learning) rather than master order.
  assert.deepEqual(Object.keys(groupSizes(outcome.resume)), ["Languages", "DevOps", "Tools", "Machine Learning"]);
});

// RED 2 (review 2026-11-07): the live master holds a skill named "C". A posting that names only C++ must
// give that group relevance 0, so a C-only group is not shown on its strength. Red on revert.
test("skills shape: a master skill named C is not made relevant by a C++ posting", () => {
  // Four groups: one holding only "C", three the posting really names (three, so D2's top-up to three
  // groups never has to reach for Systems: this test is about relevance, not the top-up).
  const master: MasterProfile = { ...MASTER, skills: [
    // The one-letter language from the live master.
    { id: "lang-c", name: "C", category: "Systems" },
    // Skills the posting does name, one per group.
    { id: "skill-node", name: "Node.js", category: "Backend" },
    { id: "db-pg", name: "PostgreSQL", category: "Databases" },
    { id: "dev-docker", name: "Docker", category: "DevOps" },
  ] };
  // Only the look-alikes for C, plus the three real skills.
  const shaped = shapeSkillGroups({ ...HONEST_TAILORING, skills: [{ ref: "lang-c" }, { ref: "skill-node" }] }, master, "C++ and C# services on Node.js with PostgreSQL in Docker; C-level reporting.");
  // Systems earns no relevance from "C++": the three relevant groups come first, and Systems is seated LAST only by
  // the min-5-groups top-up (2026-11-11), never ranked by relevance. Revert keywordAppearsIn's word bound and C ranks first.
  assert.deepEqual(shaped.profile.skills.map((s) => s.ref), ["skill-node", "db-pg", "dev-docker", "lang-c"]);
});

// The groups come from the master by the posting, not from the model's choice alone.
test("skills shape: a group the posting names is shown even when the model skipped it", async () => {
  // The posting names Jira; the model chose only Node.js.
  const outcome = await shapeOutcome([{ ref: "skill-node" }], { ...BACKEND_POSTING, jobDescription: "Node.js backend, tickets tracked in Jira." });
  assert.equal(outcome.kind, "tailored");
  if (outcome.kind !== "tailored") return;
  // Languages and Tools lead (the posting covers both), then the other groups toward 5 in live-profile order (ML is a
  // profile row, this test's "DevOps" is not). Tools is 3: Slack is never-listed (re-pinned 2026-11-21).
  assert.deepEqual(groupSizes(outcome.resume), { Languages: 5, Tools: 3, "Machine Learning": 2, DevOps: 2 });
  // Jira leads its group because the posting names it.
  assert.equal(outcome.refs.skills.find((s) => s.ref.startsWith("tool-"))?.ref, "tool-jira");
});

// A group already at the floor, with no other relevant group, is left exactly as the model chose it.
test("skills shape: an answer that already fits comes back unchanged", async () => {
  // Every master skill, already in the shape's order (2026-11-11: 5 groups wanted, this master holds 4; Languages
  // leads with its posting-named Node.js, SQL, TypeScript first), and a posting that touches only Languages.
  // Re-pinned 2026-11-21 to the engine's order: mentioned TypeScript/SQL/Node.js (core rank breaks the tie), core
  // Python, Go; Tools' core Git and Postman before Jira; no Slack (never-listed, so a pick of it is always dropped).
  const picks = ["lang-ts", "lang-sql", "skill-node", "lang-python", "lang-go", "dev-docker", "dev-gcp", "ml-xgboost", "ml-shap", "tool-git", "tool-postman", "tool-jira"].map((ref) => ({ ref }));
  const outcome = await shapeOutcome(picks, { ...BACKEND_POSTING, jobDescription: "SQL and TypeScript on Node.js services." });
  assert.equal(outcome.kind, "tailored");
  if (outcome.kind !== "tailored") return;
  // Nothing added, nothing dropped.
  assert.deepEqual([outcome.skillsAdded, outcome.skillsDropped], [[], []]);
  // Nothing reordered.
  assert.deepEqual(outcome.refs.skills.map((s) => s.ref), picks.map((p) => p.ref));
});

// A posting that names no master skill cannot judge relevance, so the model's groups stand (floored).
test("skills shape: with no relevant group, the model's own groups are kept rather than emptied", async () => {
  // A posting with no skill words at all.
  const outcome = await shapeOutcome([{ ref: "ml-xgboost" }], { ...BACKEND_POSTING, jobDescription: "Join a friendly team." });
  assert.equal(outcome.kind, "tailored");
  if (outcome.kind !== "tailored") return;
  // The model's ML group stays first, holding its whole master group of 2; the other groups follow toward 5 (2026-11-11),
  // since 2026-11-21 in live-profile order and with Slack never-listed (Tools 3).
  assert.deepEqual(groupSizes(outcome.resume), { "Machine Learning": 2, Languages: 5, Tools: 3, DevOps: 2 });
});

// N1 (2026-11-07): a stored HTML posting reaches the model as text. Red on revert of the postingText
// line in createTailorer: the prompt then carries every tag and inline style of live row 76280e87.
test("N1: an HTML posting reaches the tailor prompt as text, with no <h2>, style= or min-height", async () => {
  // Every prompt the model was sent.
  const prompts: string[] = [];
  // A model that records the prompt and answers honestly.
  const tailor = createTailorer({ callLlm: (prompt) => { prompts.push(JSON.stringify(prompt)); return Promise.resolve(JSON.stringify(HONEST_TAILORING)); }, master: MASTER, masterVersion: MASTER_VERSION });
  // The live CircuitHub excerpt as the posting.
  const outcome = await tailor({ ...POSTING, jobDescription: CIRCUITHUB_HTML });
  // Still a normal tailoring.
  assert.equal(outcome.kind, "tailored");
  // No markup in what the model saw.
  for (const junk of ["<h2>", "style=", "min-height"]) assert.equal(prompts[0].includes(junk), false, `${junk} reached the prompt`);
  // The posting's words did reach it.
  assert.ok(prompts[0].includes("OR-Tools"));
  // And the stored keywords come from the same text.
  if (outcome.kind === "tailored") assert.deepEqual(outcome.jdKeywords, ["PostgreSQL", "Python", "SQL"]);
});

// Control: the shape must not launder a fabricated skill. An unresolved ref joins no group, is kept,
// and is still refused by the validator.
// REWRITTEN for Teja's ruling D1 (2026-11-07 10:38 IST, live row ef1e796a: the model invented
// "skill_openai" and the whole row failed): an invented SKILL ref is dropped before the gate and recorded,
// never printed and never fatal. Red on revert of the drop in createTailorer.
test("D1: an invented skill ref is dropped before the gate, recorded, and the row is still tailored", async () => {
  // One real pick plus one ref the master does not hold.
  const outcome = await shapeOutcome([{ ref: "skill-node" }, { ref: "skill-kubernetes" }], BACKEND_POSTING);
  // Tailored, not refused.
  assert.equal(outcome.kind, "tailored");
  if (outcome.kind !== "tailored") return;
  // Never printed: no resolved skill carries the invented ref.
  assert.equal(outcome.refs.skills.some((s) => s.ref === "skill-kubernetes"), false);
  // Recorded, so the drop is visible on the dashboard.
  assert.deepEqual(outcome.skillsInvented, ["skill-kubernetes"]);
});

// The control: only SKILLS are forgiven. An invented bullet ref is still a fabrication the gate refuses.
test("D1 control: an invented bullet ref is still refused", async () => {
  // The honest answer with one bullet ref the master lacks.
  const answer = { ...HONEST_TAILORING, experience: HONEST_TAILORING.experience.map((entry, i) => i === 0 ? { ...entry, bullets: [...entry.bullets, { ref: "bullet-made-up", text: "Built a REST API" }] } : entry) };
  // The real tailorer.
  const tailor = createTailorer({ callLlm: () => Promise.resolve(JSON.stringify(answer)), master: MASTER, masterVersion: MASTER_VERSION });
  // Refused.
  assert.equal((await tailor(POSTING)).kind, "refused");
});

// D2 (Teja, 2026-11-07 10:38 IST): fewer than 3 JD-relevant groups are topped up to 3 with the model's own
// groups, in the model's order, each still filled to the floor. Red on revert of the top-up.
test("D2: one relevant group is topped up with the model's groups first, in the model's order (min 5 groups, 2026-11-11)", async () => {
  // A posting naming only Python; the model picked from DevOps, Tools and Machine Learning, in that order.
  const outcome = await shapeOutcome([{ ref: "dev-docker" }, { ref: "tool-git" }, { ref: "ml-xgboost" }], { ...BACKEND_POSTING, jobDescription: "We write Python." });
  assert.equal(outcome.kind, "tailored");
  if (outcome.kind !== "tailored") return;
  // Languages (relevant) first, then the model's groups in ITS order (Tools before ML, though master order is ML first).
  assert.deepEqual(Object.keys(groupSizes(outcome.resume)), ["Languages", "DevOps", "Tools", "Machine Learning"]);
  // Nothing dropped: five groups are wanted and the master holds four.
  assert.deepEqual(outcome.skillsDropped, []);
});

// ---- summary variants end to end (pending #11, 2026-11-07) ---------------------------------------------
test("summary variant: a picked variant flows through the tailorer into the stored refs; the role title wins the headline", async () => {
  // The fixture master plus one variant.
  const master: MasterProfile = { ...MASTER, summary_variants: [{ id: "variant-swe", label: "Software engineering", headline: "Software Engineer", summary: { id: "summary-swe", text: "Software engineer who ships Node.js services." } }] };
  // A model that picks it.
  const tailor = createTailorer({ callLlm: () => Promise.resolve(JSON.stringify({ ...HONEST_TAILORING, summary_variant: "variant-swe" })), master, masterVersion: MASTER_VERSION });
  // Run.
  const outcome = await tailor(POSTING);
  // Tailored.
  assert.equal(outcome.kind, "tailored");
  if (outcome.kind !== "tailored") return;
  // The pick is stored as held, so tailor_refs rebuilds this resume.
  assert.equal(outcome.refs.summary_variant, "variant-swe");
  // The header names the role applied for (rule 5, 2026-11-08), over the variant's own headline.
  assert.equal(outcome.resume.identity.headline, "Backend Engineer Intern");
});

// The control: a reply whose summary_variant is not a string is malformed, not quietly the default.
test("summary variant: a non-string summary_variant is a malformed reply", async () => {
  // A number where an id belongs.
  const tailor = createTailorer({ callLlm: () => Promise.resolve(JSON.stringify({ ...HONEST_TAILORING, summary_variant: 7 })), master: MASTER, masterVersion: MASTER_VERSION });
  // Thrown, like every other shape failure.
  await assert.rejects(tailor(POSTING), /malformed summary_variant/);
});

// ---- AI skills group (Teja, 2026-11-10 12:14 IST) -------------------------------------------------------
// "every resume needs to contain an AI skill group with min 5 AI skills, the most relevant AI skills to that
// job, from now on". RED until shapeSkillGroups enforces it: these pin the contract the implementation meets.

// The live master v32 AI category, in its master order (copied from the live row, so the names are real).
const AI_SKILL_NAMES_V32 = ["LLM Applications", "RAG Pipelines", "Prompt Engineering", "Context Engineering", "AI Agents & Workflows", "Tool Calling & Guardrails", "LLM/SLM API Integration", "Vector Search", "Multi-Agent Systems", "Prompt Injection Protection", "Context Validation", "Prompt Builders", "Context Builders", "Prompt Caching", "Token Cost Optimization", "Quantization", "MCP Integrations", "Harness Engineering"];

// A stable id from a name, so a test can name a ref ("ai-rag-pipelines") without a lookup table.
const aiId = (name: string): string => `ai-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "")}`;

// The non-AI groups, v32 category names, four skills each where a Java backend JD can name one per group.
const NON_AI_SKILLS: MasterProfile["skills"] = [
  // Languages: Java is what a backend JD names.
  { id: "lang-java", name: "Java", category: "Languages" }, { id: "lang-python", name: "Python", category: "Languages" }, { id: "lang-ts", name: "TypeScript", category: "Languages" }, { id: "lang-sql", name: "SQL", category: "Languages" },
  // Frameworks: Spring Boot, the second group a Java JD names.
  { id: "fw-spring", name: "Spring Boot", category: "Frameworks" }, { id: "fw-react", name: "React", category: "Frameworks" }, { id: "fw-express", name: "Express", category: "Frameworks" }, { id: "fw-fastapi", name: "FastAPI", category: "Frameworks" },
  // Databases: PostgreSQL ("Postgres" in a JD canonicalises to it).
  { id: "db-pg", name: "PostgreSQL", category: "Databases" }, { id: "db-mysql", name: "MySQL", category: "Databases" }, { id: "db-redis", name: "Redis", category: "Databases" }, { id: "db-mongo", name: "MongoDB", category: "Databases" },
  // DevOps & Cloud: Docker.
  { id: "dev-docker", name: "Docker", category: "DevOps & Cloud" }, { id: "dev-aws", name: "AWS", category: "DevOps & Cloud" }, { id: "dev-k8s", name: "Kubernetes", category: "DevOps & Cloud" }, { id: "dev-gha", name: "GitHub Actions", category: "DevOps & Cloud" },
  // Testing & Quality: JUnit.
  { id: "test-junit", name: "JUnit", category: "Testing & Quality" }, { id: "test-jest", name: "Jest", category: "Testing & Quality" }, { id: "test-pw", name: "Playwright", category: "Testing & Quality" }, { id: "test-vitest", name: "Vitest", category: "Testing & Quality" },
  // Tools: Git.
  { id: "tool-git", name: "Git", category: "Tools" }, { id: "tool-jira", name: "Jira", category: "Tools" }, { id: "tool-postman", name: "Postman", category: "Tools" }, { id: "tool-vscode", name: "VS Code", category: "Tools" },
  // Backend Engineering: REST APIs.
  { id: "be-rest", name: "REST APIs", category: "Backend Engineering" }, { id: "be-micro", name: "Microservices", category: "Backend Engineering" }, { id: "be-design", name: "System Design", category: "Backend Engineering" }, { id: "be-cache", name: "Caching", category: "Backend Engineering" },
  // Data Science, Machine Learning, CS Fundamentals: present in v32, never named by these JDs.
  { id: "ds-pandas", name: "Pandas", category: "Data Science" }, { id: "ml-xgb", name: "XGBoost", category: "Machine Learning" }, { id: "cs-dsa", name: "Data Structures", category: "CS Fundamentals" },
];

// A master shaped like v32: the non-AI groups first and AI LAST, so master order never seats AI by accident.
function aiMaster(aiNames: readonly string[]): MasterProfile {
  // The literal "AI" is the contract's category name (PAGE_FIT_FLOORS.aiSkillsCategory); a literal here so the
  // fixture is still well-formed while that field is undefined, and the red stays an assertion, not a TypeError.
  return { ...MASTER, skills: [...NON_AI_SKILLS, ...aiNames.map((name) => ({ id: aiId(name), name, category: "AI" }))] };
}

// The refs of the shaped section whose master category is AI, in page order.
function aiRefsOf(skills: readonly { readonly ref: string }[], master: MasterProfile): string[] {
  // Each master skill's category by id; an unresolved ref has none and is not AI.
  const categoryById = new Map(master.skills.map((s) => [s.id, s.category]));
  // Page order kept, so R3 can read the first AI skill.
  return skills.map((s) => s.ref).filter((ref) => categoryById.get(ref) === "AI");
}

// The distinct groups the shaped section shows, in page order.
function groupsOf(skills: readonly { readonly ref: string }[], master: MasterProfile): string[] {
  // Each master skill's category by id.
  const categoryById = new Map(master.skills.map((s) => [s.id, s.category]));
  // First appearance wins, exactly as the renderer groups them.
  return [...new Set(skills.flatMap((s) => categoryById.get(s.ref) ?? []))];
}

// A pure Java/Spring backend JD: no AI term at all (no "AI", "LLM", "RAG", "machine learning").
const JAVA_JD = "Java backend developer: Spring Boot services on PostgreSQL.";
// The same backend role naming seven non-AI groups, so every one of them outranks AI on relevance.
const SEVEN_GROUP_JD = "Java and Spring Boot services on PostgreSQL in Docker, tested with JUnit, versioned in Git, exposing REST APIs.";

// The contract's two new floors, read where every other floor lives. Red until page-trim.ts exports them.
test("AI group (2026-11-10): PAGE_FIT_FLOORS names the AI category and its minimum of 5", () => {
  // The category name the shape matches exactly, read through a loose type so the test runs before the field exists.
  assert.equal((PAGE_FIT_FLOORS as { aiSkillsCategory?: string }).aiSkillsCategory, "AI");
  // The minimum AI skills per resume (Teja: "min 5 AI skills").
  assert.equal((PAGE_FIT_FLOORS as { minAiSkills?: number }).minAiSkills, 5);
});

// R1 PRESENT: the model picked no AI skill and the JD names none, yet the resume still carries >= 5.
test("AI group (2026-11-10): R1 a Java backend JD still gets >= 5 AI skills", () => {
  // The full v32 AI group of 18.
  const master = aiMaster(AI_SKILL_NAMES_V32);
  // The model picked Java only: the AI group must come from the rule, not the model.
  const shaped = shapeSkillGroups({ ...HONEST_TAILORING, skills: [{ ref: "lang-java" }] }, master, JAVA_JD);
  // The AI refs on the page.
  const ai = aiRefsOf(shaped.profile.skills, master);
  // min(5, 18) = 5 at least; a literal 5 so a missing PAGE_FIT_FLOORS field cannot make this pass vacuously.
  assert.ok(ai.length >= 5, `expected >= 5 AI skills on a Java JD, got ${ai.length}: ${JSON.stringify(ai)}`);
  // Every AI ref was added by the shape (the model picked none), so each must be reported in `added`.
  for (const ref of ai) assert.ok(shaped.added.includes(ref), `AI ref ${ref} was added but not reported in added`);
});

// R2 SEAT: seven non-AI groups outrank AI on relevance; AI still takes one of the SKILLS_MAX_GROUPS seats.
test("AI group (2026-11-10): R2 the AI group takes a seat even when 5+ other groups are more JD-relevant", () => {
  // The full v32 AI group.
  const master = aiMaster(AI_SKILL_NAMES_V32);
  // One pick per JD-named group, so the model agrees with the posting on every non-AI group.
  const picks = ["lang-java", "fw-spring", "db-pg", "dev-docker", "test-junit", "tool-git", "be-rest"].map((ref) => ({ ref }));
  // Shape against the seven-group posting.
  const shaped = shapeSkillGroups({ ...HONEST_TAILORING, skills: picks }, master, SEVEN_GROUP_JD);
  // The groups the page shows.
  const groups = groupsOf(shaped.profile.skills, master);
  // AI is one of them.
  assert.ok(groups.includes("AI"), `AI group missing; groups shown: ${JSON.stringify(groups)}`);
  // Still at least 5 AI skills in it.
  assert.ok(aiRefsOf(shaped.profile.skills, master).length >= 5, "AI group holds fewer than 5 skills");
  // And the cap holds: AI took a seat, it did not add a group past SKILLS_MAX_GROUPS (6 from 2026-11-11, 7 since 2026-11-21).
  assert.ok(groups.length <= SKILLS_MAX_GROUPS, `more than ${SKILLS_MAX_GROUPS} groups shown: ${JSON.stringify(groups)}`);
});

// R3 RANKED: a JD-relevant AI skill is pulled in past the floor and leads the group.
test("AI group (2026-11-10): R3 a RAG posting puts RAG Pipelines in the AI group and first, even 8th in master order", () => {
  // The first eight in the R3 order: RAG Pipelines moved to 8th, so a master-order fill of 5 never reaches it.
  const firstEight = ["LLM Applications", "Prompt Engineering", "Context Engineering", "AI Agents & Workflows", "Tool Calling & Guardrails", "LLM/SLM API Integration", "Vector Search", "RAG Pipelines"];
  // The rest of v32 after them, in v32 order.
  const reordered = [...firstEight, ...AI_SKILL_NAMES_V32.filter((n) => !firstEight.includes(n))];
  // Guard the fixture itself: RAG Pipelines really is past position 5, or the test proves nothing.
  assert.equal(reordered.indexOf("RAG Pipelines"), 7);
  // The master with that order.
  const master = aiMaster(reordered);
  // extractJdKeywords emits "RAG" from this (case-sensitive exact term); the full name "RAG Pipelines" is NOT in
  // the JD, so only the term-in-name half of the relevance rule can rank it.
  const shaped = shapeSkillGroups({ ...HONEST_TAILORING, skills: [{ ref: "lang-java" }] }, master, "You will build RAG systems on Postgres.");
  // The AI refs, page order.
  const ai = aiRefsOf(shaped.profile.skills, master);
  // RAG Pipelines leads the AI group (which also proves it is in it).
  assert.equal(ai[0], aiId("RAG Pipelines"), `first AI skill should be RAG Pipelines; AI group: ${JSON.stringify(ai)}`);
  // And the group still meets the minimum.
  assert.ok(ai.length >= 5, `expected >= 5 AI skills, got ${ai.length}`);
});

// R4 NEVER INVENT: a 3-skill AI group yields exactly those 3, and nothing outside the master.
test("AI group (2026-11-10): R4 a master with only 3 AI skills yields exactly those 3, never an invented one", () => {
  // Three real AI skills only.
  const master = aiMaster(["LLM Applications", "RAG Pipelines", "Prompt Engineering"]);
  // Java pick, Java JD: three relevant non-AI groups, so the D2 top-up never seats AI today.
  const shaped = shapeSkillGroups({ ...HONEST_TAILORING, skills: [{ ref: "lang-java" }] }, master, JAVA_JD);
  // Exactly the three, as a set (order is R3's concern).
  assert.deepEqual(aiRefsOf(shaped.profile.skills, master).sort(), ["LLM Applications", "RAG Pipelines", "Prompt Engineering"].map(aiId).sort());
  // Every shaped ref is a master id: the floor min(5, 3) never pads with a made-up skill.
  const masterIds = new Set(master.skills.map((s) => s.id));
  // Checked ref by ref so a failure names the invented one.
  for (const { ref } of shaped.profile.skills) assert.ok(masterIds.has(ref), `ref ${ref} is not in the master`);
});

// R4 control: a master without an "AI" category is shaped exactly as before; no AI group is forced.
test("AI group (2026-11-10): R4 control, a master with no AI category gets no AI group and an unchanged shape", () => {
  // The non-AI groups only.
  const master: MasterProfile = { ...MASTER, skills: NON_AI_SKILLS };
  // Java pick, Java JD.
  const shaped = shapeSkillGroups({ ...HONEST_TAILORING, skills: [{ ref: "lang-java" }] }, master, JAVA_JD);
  // The three JD-relevant groups, then the filler in live-profile order (Backend Engineering 3, DevOps & Cloud 4, Tools 7,
  // CS Fundamentals 8) up to SKILLS_MAX_GROUPS = 7 (2026-11-21): no AI seat, nothing else.
  assert.deepEqual(groupsOf(shaped.profile.skills, master), ["Languages", "Frameworks", "Databases", "Backend Engineering", "DevOps & Cloud", "Tools", "CS Fundamentals"]);
  // The full shaped list (re-pinned 2026-11-21): each group shows all 4; inside it the JD-mentioned skill first, then the
  // live core in profile order (Python, TypeScript, SQL; FastAPI; Redis, MySQL; REST APIs, Caching), then master order.
  // Any change at all to the no-AI path goes red here.
  // Since 2026-11-21 the filler reaches 7 groups: Tools (core Git, Postman, then master order) and CS Fundamentals (its one skill).
  assert.deepEqual(shaped.profile.skills.map((s) => s.ref), ["lang-java", "lang-python", "lang-ts", "lang-sql", "fw-spring", "fw-fastapi", "fw-react", "fw-express", "db-pg", "db-redis", "db-mysql", "db-mongo", "be-rest", "be-cache", "be-micro", "be-design", "dev-docker", "dev-aws", "dev-k8s", "dev-gha", "tool-git", "tool-postman", "tool-jira", "tool-vscode", "cs-dsa"]);
});

// R5 KEEPS PICKS, UP TO THE LINE (2026-11-12): model picks win the line's seats over unpicked skills, but the line is
// ONE printed line (Teja 13:57), so seven long AI picks keep only those that fit; the rest are reported, never silent.
test("AI group (2026-11-12): R5 seven model-picked AI skills fill the one line first; the ones past it are reported dropped", () => {
  // The full v32 AI group.
  const master = aiMaster(AI_SKILL_NAMES_V32);
  // The model's seven AI picks, by v32 position.
  const aiPicks = AI_SKILL_NAMES_V32.slice(0, 7).map(aiId);
  // Plus Java, against the seven-group posting where AI is the least relevant group (dropped by the pre-AI rule).
  const shaped = shapeSkillGroups({ ...HONEST_TAILORING, skills: [{ ref: "lang-java" }, ...aiPicks.map((ref) => ({ ref }))] }, master, SEVEN_GROUP_JD);
  // The AI refs on the page.
  const ai = aiRefsOf(shaped.profile.skills, master);
  // The AI line holds the floor of 5 at least.
  assert.ok(ai.length >= 5, `AI group under its floor: ${JSON.stringify(ai)}`);
  // Re-pinned 2026-11-21 (core + JD fill): the live AI core seats first whatever the model picked, so a pick no longer
  // outranks a core skill; every core skill the master holds is on the line.
  for (const name of SKILL_PROFILE.groups.find((g) => g.category === "AI")!.core) assert.ok(ai.includes(aiId(name)), `core ${name} missing`);
  // At most two printed lines (the compact skills block), by the same model the PDF is fitted with, at most 7.
  assert.ok(ai.length <= SKILLS_PER_GROUP_CAP && TYPOGRAPHY_LADDER.every((_, i) => skillGroupLineCount("AI", ai.map((ref) => master.skills.find((s) => s.id === ref)!.name), i) <= 2), "the AI group passes two lines");
  // Every pick that lost its seat is reported dropped, none silently.
  assert.deepEqual(shaped.dropped.filter((ref) => aiPicks.includes(ref)), aiPicks.filter((ref) => !ai.includes(ref)), "a pick past the line was not reported");
});

// Review finding 2 (2026-11-10): a generic posting term inside an AI skill's name is word overlap, not relevance.
test("AI group (2026-11-10): R6 a backend JD saying caching and APIs does not promote Prompt Caching or LLM/SLM API Integration", () => {
  // The full v32 AI group: Prompt Caching is 14th and LLM/SLM API Integration 7th, both past the floor of 5.
  const master = aiMaster(AI_SKILL_NAMES_V32);
  // Generic words that ARE vocabulary terms elsewhere (caching, APIs, monitoring, agents), and no AI term at all.
  const shaped = shapeSkillGroups({ ...HONEST_TAILORING, skills: [{ ref: "lang-java" }] }, master, "Java backend: caching, REST APIs, agents and monitoring.");
  // The AI group on the page.
  const ai = aiRefsOf(shaped.profile.skills, master);
  // THE RULE UNDER TEST: neither generic-word match takes a seat on its strength. Prompt Caching (14th) never seats.
  assert.equal(ai.includes(aiId("Prompt Caching")), false, "caching promoted Prompt Caching");
  // Re-pinned 2026-11-21: with no AI term in the posting, the live AI core leads in profile order, then master order fills
  // until two lines are full (cap 10 since 14:41; long names stop it at 9, skipping the ones that would add a third line);
  // LLM Applications is the twin of the master's LLM/SLM API Integration, so only the kept spelling shows.
  assert.deepEqual(ai, ["AI Agents & Workflows", "RAG Pipelines", "Prompt Engineering", "Context Engineering", "Tool Calling & Guardrails", "LLM/SLM API Integration", "Multi-Agent Systems", "Prompt Injection Protection", "Quantization"].map(aiId));
});

// Review finding 2b (2026-11-10): five model picks the posting never names must not keep out an AI skill it does name.
test("AI group (2026-11-10): R7 five unnamed model AI picks still let the JD-named RAG Pipelines in, first", () => {
  // RAG Pipelines moved to 8th, so neither the model's five picks nor the floor reaches it.
  const firstEight = ["LLM Applications", "Prompt Engineering", "Context Engineering", "AI Agents & Workflows", "Tool Calling & Guardrails", "LLM/SLM API Integration", "Vector Search", "RAG Pipelines"];
  // The rest of v32 after them.
  const master = aiMaster([...firstEight, ...AI_SKILL_NAMES_V32.filter((n) => !firstEight.includes(n))]);
  // The model picked the first five AI skills: the floor is already met, so only the "named joins" rule can add RAG.
  const picks = firstEight.slice(0, 5).map((name) => ({ ref: aiId(name) }));
  // A posting that names RAG.
  const shaped = shapeSkillGroups({ ...HONEST_TAILORING, skills: [{ ref: "lang-java" }, ...picks] }, master, "You will build RAG systems on Postgres.");
  // The AI group in page order.
  const ai = aiRefsOf(shaped.profile.skills, master);
  // RAG Pipelines is in and leads (since 2026-11-12 the picks follow it only as far as the ONE line reaches).
  assert.equal(ai[0], aiId("RAG Pipelines"), `the JD-named RAG Pipelines does not lead: ${JSON.stringify(ai)}`);
  // Re-pinned 2026-11-21: the rest of the live AI core follows in profile order, then the model's remaining pick (Tool
  // Calling & Guardrails), then master order (Vector Search is never-listed; LLM Applications yields to its kept twin).
  // (Cap 10 since 2026-11-21 14:41: master order continues until two lines are full.)
  assert.deepEqual(ai.slice(1), ["AI Agents & Workflows", "Prompt Engineering", "Context Engineering", "Tool Calling & Guardrails", "LLM/SLM API Integration", "Multi-Agent Systems", "Prompt Injection Protection", "Quantization"].map(aiId));
  // Still the floor of 5, and at most two printed lines.
  assert.ok(ai.length >= 5 && TYPOGRAPHY_LADDER.every((_, i) => skillGroupLineCount("AI", ai.map((ref) => master.skills.find((s) => s.id === ref)!.name), i) <= 2), `AI line wrong: ${JSON.stringify(ai)}`);
});

// ---- ONE GROUP = ONE FULL LINE (Teja, 2026-11-12 13:57 IST) ---------------------------------------------------
// "every resume need atleast 5+ skill groups with each having up to 7 skills ... the skill section need to be in 1 line
// but full in that 1 line". These pin it with the live v41 Testing & Quality group (9 skills, some long).

// Live v41 Testing & Quality, master order (real names: the long ones are what make a line wrap).
const TESTING_V41 = ["Code review", "JUnit", "pytest", "Testing", "Debugging & Troubleshooting", "Integration Testing", "API Testing", "Unit Testing", "Playwright Testing"];
// A master with that group first plus the AI fixture group, so the floors still apply.
const lineMaster = (): MasterProfile => ({ ...MASTER, skills: [...TESTING_V41.map((name, i) => ({ id: `tq-${i}`, name, category: "Testing & Quality" })), ...NON_AI_SKILLS.filter((s) => s.category !== "Testing & Quality"), ...AI_SKILL_NAMES_V32.map((name) => ({ id: aiId(name), name, category: "AI" }))] });
// The page's groups: category -> names, in page order.
const lineGroupsOf = (skills: readonly { readonly ref: string }[], master: MasterProfile): Map<string, string[]> => {
  // Insertion order is page order.
  const out = new Map<string, string[]>();
  // Every resolvable ref, into its group.
  for (const { ref } of skills) { const s = master.skills.find((m) => m.id === ref); if (s) out.set(s.category, [...(out.get(s.category) ?? []), s.name]); }
  // The groups.
  return out;
};

// L1 THE RULE. RED-ON-REVERT: the 11-11 shaper kept every model pick, so 9 picked Testing skills printed 9 (two lines).
// Re-pinned 2026-11-21 (compact skills block, Teja 2026-11-18, newer than this 11-12 one-line rule): TWO lines.
test("skills line (2026-11-21): L1 a model that picks all 9 Testing skills gets at most 7 in at most TWO lines, filled", () => {
  // The master above.
  const master = lineMaster();
  // The model picks every Testing skill, on a posting that names testing.
  const shaped = shapeSkillGroups({ ...HONEST_TAILORING, skills: TESTING_V41.map((_, i) => ({ ref: `tq-${i}` })) }, master, "QA engineer: JUnit, pytest, integration testing and API testing.");
  // The page's groups.
  const groups = lineGroupsOf(shaped.profile.skills, master);
  // Non-vacuity: the Testing group is on the page.
  const testing = groups.get("Testing & Quality");
  assert.ok(testing !== undefined && testing.length > 0, "the Testing group is missing; the case under test is absent");
  // Two printed lines at most, at every rung (the shared width model the PDF is fitted with).
  const twoLines = (category: string, names: readonly string[]): boolean => TYPOGRAPHY_LADDER.every((_, i) => skillGroupLineCount(category, names, i) <= 2);
  // Every group on the page: at most two lines, at most 7.
  for (const [category, names] of groups) {
    // At most the cap.
    assert.ok(names.length <= SKILLS_PER_GROUP_CAP, `${category} holds ${names.length} > ${SKILLS_PER_GROUP_CAP}`);
    // Two printed lines at most at every typography rung.
    assert.ok(twoLines(category, names), `${category} passes two lines: ${names.join(", ")}`);
  }
  // FULL: no unseated Testing skill would still fit in the two lines (unless the cap is reached). "Testing" itself is
  // the dropped twin of "Unit Testing" (live profile), so it is out by rule, not for room.
  const unseated = TESTING_V41.filter((n) => !testing.includes(n) && n !== "Testing");
  // At the cap, or nothing left fits.
  assert.ok(testing.length === SKILLS_PER_GROUP_CAP || unseated.every((n) => !twoLines("Testing & Quality", [...testing, n])), `the Testing group has room left: ${testing.join(", ")}`);
  // And the four skills the posting names hold the first seats (a tie of "mentioned"; core pytest leads the tie).
  assert.deepEqual(testing.slice(0, 4), ["pytest", "JUnit", "Integration Testing", "API Testing"]);
});

// L2 THE CAP: a group of nine very short names fits nine on a line, but shows seven.
test("skills line (2026-11-21): L2 thirteen short skills that would all fit two lines still stop at the cap of 10", () => {
  // Thirteen short Languages names (re-pinned 2026-11-21 for the cap of 10: nine no longer reach the cap).
  const short = ["C", "R", "Go", "SQL", "Java", "HTML", "CSS", "Rust", "Bash", "Perl", "Lua", "Dart", "Zig"];
  // Non-vacuity: all thirteen fit two lines at every rung, so only the cap can stop them.
  assert.ok(TYPOGRAPHY_LADDER.every((_, i) => skillGroupLineCount("Languages", short, i) <= 2), "thirteen short names pass two lines; the cap is not what is under test");
  // A master of that group plus the AI fixture.
  const master: MasterProfile = { ...MASTER, skills: [...short.map((name, i) => ({ id: `ln-${i}`, name, category: "Languages" })), ...AI_SKILL_NAMES_V32.map((name) => ({ id: aiId(name), name, category: "AI" }))] };
  // The model picks all thirteen.
  const shaped = shapeSkillGroups({ ...HONEST_TAILORING, skills: short.map((_, i) => ({ ref: `ln-${i}` })) }, master, "Systems engineer: C, Go, SQL.");
  // Exactly the cap.
  assert.equal(lineGroupsOf(shaped.profile.skills, master).get("Languages")?.length, SKILLS_PER_GROUP_CAP);
});

// L3 TWINS: v41 holds "Express.js" and "express js"; a filled line must not print both.
test("skills line (2026-11-12): L3 two spellings of one skill take one seat, the better-ranked spelling", () => {
  // The twin key itself, on the live v41 pairs.
  assert.equal(skillTwinKey("Express.js"), skillTwinKey("express js"));
  // And the vendor-prefixed pair.
  assert.equal(skillTwinKey("Microsoft Azure"), skillTwinKey("azure"));
  // Non-vacuity of the key: distinct skills keep distinct keys.
  assert.notEqual(skillTwinKey("Node.js"), skillTwinKey("Express.js"));
  // A Frameworks group carrying both spellings.
  const master: MasterProfile = { ...MASTER, skills: [{ id: "fw-a", name: "Express.js", category: "Frameworks" }, { id: "fw-b", name: "express js", category: "Frameworks" }, { id: "fw-c", name: "FastAPI", category: "Frameworks" }, ...AI_SKILL_NAMES_V32.map((name) => ({ id: aiId(name), name, category: "AI" }))] };
  // The model picks both.
  const shaped = shapeSkillGroups({ ...HONEST_TAILORING, skills: [{ ref: "fw-a" }, { ref: "fw-b" }] }, master, "Node backend with Express.js.");
  // Only the JD's own spelling prints.
  assert.deepEqual(lineGroupsOf(shaped.profile.skills, master).get("Frameworks"), ["Express.js", "FastAPI"]);
});

// ---- TAILOR #5 PARCEL 2 (2026-11-21): the skills engine — core + JD fill, never-list, twins, tiers, 2-line groups ----
// Rulings: core + JD fill (Teja 2026-11-18); most-needed first in skills, groups, projects and achievements (2026-11-18
// 21:47); >= 5 groups of up to 7 skills (2026-11-12 13:57); a group may wrap to 2 lines (2026-11-18 "compact skills
// block"); AI group >= 5 from the master (2026-11-10). Each test passes its OWN profile, so a rule is pinned by data the
// test controls, not by today's live profile (which the learning loop will keep editing).

// A profile with nothing in it: the engine must still work (JD fill and master order only).
const EMPTY_PROFILE: SkillProfile = { groups: [], never: [], twins: [], aliases: {} };

// A wider master: two-line groups need more names than one line holds.
const ENGINE_MASTER: MasterProfile = {
  ...MASTER,
  skills: [
    // Languages, master order: Go, Python, SQL, Java, Rust.
    { id: "l-go", name: "Go", category: "Languages" },
    { id: "l-py", name: "Python", category: "Languages" },
    { id: "l-sql", name: "SQL", category: "Languages" },
    { id: "l-java", name: "Java", category: "Languages" },
    { id: "l-rust", name: "Rust", category: "Languages" },
    // Tools, including a never-list candidate (Slack).
    { id: "t-jira", name: "Jira", category: "Tools" },
    { id: "t-slack", name: "Slack", category: "Tools" },
    { id: "t-git", name: "Git", category: "Tools" },
    { id: "t-postman", name: "Postman", category: "Tools" },
    // CS Fundamentals, named in JDs by other words ("data structures").
    { id: "c-dsa", name: "DSA", category: "CS Fundamentals" },
    { id: "c-os", name: "Operating Systems", category: "CS Fundamentals" },
    // Testing: two spellings of one skill, and long names that wrap past one line.
    { id: "q-testing", name: "Testing", category: "Testing & Quality" },
    { id: "q-unit", name: "Unit Testing", category: "Testing & Quality" },
    { id: "q-review", name: "Code review", category: "Testing & Quality" },
    { id: "q-debug", name: "Debugging & Troubleshooting", category: "Testing & Quality" },
    { id: "q-int", name: "Integration Testing", category: "Testing & Quality" },
    { id: "q-api", name: "API Testing", category: "Testing & Quality" },
    { id: "q-pw", name: "Playwright Testing", category: "Testing & Quality" },
    { id: "q-junit", name: "JUnit", category: "Testing & Quality" },
    // DevOps, a fifth group.
    { id: "d-docker", name: "Docker", category: "DevOps & Cloud" },
    { id: "d-aws", name: "AWS", category: "DevOps & Cloud" },
  ],
};

// Shapes `skills` refs over ENGINE_MASTER with a profile; returns the printed names per group, in page order.
function engine(skills: readonly string[], jd: string, profile: SkillProfile) {
  // The model's answer: only its skills vary.
  const tailored: TailoredProfile = { ...HONEST_TAILORING, skills: skills.map((ref) => ({ ref })) };
  // The engine itself.
  const shaped = shapeSkillGroups(tailored, ENGINE_MASTER, jd, profile);
  // Names by id, for readable assertions.
  const byId = new Map(ENGINE_MASTER.skills.map((s) => [s.id, s]));
  // Group -> names, in first-appearance (= page) order.
  const groups = new Map<string, string[]>();
  // One pass over the printed refs.
  for (const { ref } of shaped.profile.skills) {
    // The master skill behind the ref.
    const s = byId.get(ref)!;
    // Appended to its group.
    groups.set(s.category, [...(groups.get(s.category) ?? []), s.name]);
  }
  // Both views.
  return { groups, shaped };
}

test("engine constants: >= 5 groups of up to 10 skills (Teja 2026-11-21 14:41), up to 7 groups (2026-11-21), groups may wrap to 2 lines (2026-11-18)", () => {
  // Up to 10 per group (Teja 2026-11-21 14:41: "increase that cap to 3 more skills in each"; was 7 since 2026-11-12).
  assert.equal(SKILLS_PER_GROUP_CAP, 10);
  // At least 5 groups.
  assert.equal(SKILLS_MIN_GROUPS, 5);
  // Up to 7 groups (orch ruling 2026-11-21: Teja's 11-12 ruling sets no group max; his ideals have 7 groups, 25 of 26).
  assert.equal(SKILLS_MAX_GROUPS, 7);
  // The live profile never sets a group above the cap.
  assert.ok(SKILL_PROFILE.groups.every((g) => g.max <= SKILLS_PER_GROUP_CAP), "a profile row above the cap");
  // And every live row uses the full cap of 10 (the ruling raised every group, not some).
  assert.ok(SKILL_PROFILE.groups.every((g) => g.max === SKILLS_PER_GROUP_CAP), "a profile row below the cap of 10");
  // The AI row keeps its floor of 5.
  assert.equal(SKILL_PROFILE.groups.find((g) => g.category === PAGE_FIT_FLOORS.aiSkillsCategory)?.min, PAGE_FIT_FLOORS.minAiSkills);
});

test("CORE: a profile's core skills ship even when the JD never names them and the model never picked them", () => {
  // Tools core = Postman, Git, in a group of only 2 seats; the posting names Jira, not them. Without the core rule the
  // JD-named Jira and then master order (Jira, Slack) would take both seats, so this is red on revert.
  const { groups, shaped } = engine(["l-go"], "Requirements:\n- Go and Jira", { ...EMPTY_PROFILE, groups: [{ category: "Tools", core: ["Postman", "Git"], min: 2, max: 2, order: 1 }] });
  // Exactly the two core skills (core ships first; the JD fill only takes seats the core leaves).
  assert.deepEqual([...(groups.get("Tools") ?? [])].sort(), ["Git", "Postman"], `Tools = ${groups.get("Tools")}`);
  // Reported as added (never silent).
  assert.ok(shaped.added.includes("t-postman") && shaped.added.includes("t-git"));
});

test("CORE: a core name the master does not hold is skipped, never invented (master-only rule)", () => {
  // "Kubernetes" is not an ENGINE_MASTER skill.
  const { shaped } = engine(["l-go"], "Go", { ...EMPTY_PROFILE, groups: [{ category: "DevOps & Cloud", core: ["Kubernetes", "Docker"], min: 1, max: 7, order: 1 }] });
  // Every printed ref resolves to the master.
  assert.ok(shaped.profile.skills.every(({ ref }) => ENGINE_MASTER.skills.some((s) => s.id === ref)));
});

test("NEVER: a never-list skill is blocked even when the JD names it and the model picked it, and the drop is reported", () => {
  // The posting names Slack; the model picked it.
  const { groups, shaped } = engine(["t-slack", "t-jira"], "Requirements:\n- Slack and Jira", { ...EMPTY_PROFILE, never: ["Slack"] });
  // Not printed anywhere.
  assert.ok(![...groups.values()].flat().includes("Slack"), "Slack printed");
  // Reported.
  assert.ok(shaped.dropped.includes("t-slack"));
});

test("TWINS: two spellings of one skill print once, the profile's kept spelling", () => {
  // The model picked both spellings.
  const { groups } = engine(["q-testing", "q-unit"], "unit tests", { ...EMPTY_PROFILE, twins: [["Unit Testing", "Testing"]] });
  // The printed group.
  const q = groups.get("Testing & Quality") ?? [];
  // Unit Testing in, Testing out.
  assert.ok(q.includes("Unit Testing") && !q.includes("Testing"), `Testing & Quality = ${q}`);
});

test("ALIAS: a JD that says 'data structures' makes DSA JD-relevant (alias match, not exact name)", () => {
  // The alias maps the JD's words to the master name.
  const { groups } = engine(["l-go"], "Requirements:\n- Strong data structures", { ...EMPTY_PROFILE, aliases: { DSA: ["data structures"] } });
  // The alias gives CS Fundamentals the only JD coverage, so it leads the PAGE (without the alias it would follow the
  // model's Languages group: DSA is first in its group by master order anyway, so that alone could not go red).
  assert.equal([...groups.keys()][0], "CS Fundamentals");
  // And DSA leads it.
  assert.equal(groups.get("CS Fundamentals")?.[0], "DSA");
});

test("TIERS: inside a group, required before preferred before mentioned before core, then master order", () => {
  // Rust required, Java preferred, SQL mentioned; Python is core; Go is only in the master.
  const jd = "We like SQL.\nRequirements:\n- Rust\nNice to have:\n- Java";
  // Python core in Languages.
  const { groups } = engine([], jd, { ...EMPTY_PROFILE, groups: [{ category: "Languages", core: ["Python"], min: 1, max: 7, order: 1 }] });
  // The ruling's order exactly.
  assert.deepEqual(groups.get("Languages"), ["Rust", "Java", "SQL", "Python", "Go"]);
});

test("TIERS: groups are ordered by how much of the JD they cover (tier-weighted), not by master order", () => {
  // Two required DevOps skills outweigh one mentioned language.
  const { groups } = engine([], "We like Go.\nRequirements:\n- Docker\n- AWS", EMPTY_PROFILE);
  // DevOps first.
  assert.equal([...groups.keys()][0], "DevOps & Cloud");
});

test("TWO LINES: a group seats more than one printed line holds, never more than two, never more than the cap", () => {
  // Every Testing name ranked; no profile limits.
  const { groups } = engine([], "unit tests", EMPTY_PROFILE);
  // The printed group.
  const q = groups.get("Testing & Quality") ?? [];
  // More than the one-line fill could hold.
  assert.ok(!skillGroupFitsOneLine("Testing & Quality", q), `still one line: ${q}`);
  // Never a third line at any rung.
  assert.ok(TYPOGRAPHY_LADDER.every((_, i) => skillGroupLineCount("Testing & Quality", q, i) <= 2));
  // And within the cap.
  assert.ok(q.length <= SKILLS_PER_GROUP_CAP);
});

test("MAX: a profile row's max caps its group below 7", () => {
  // Languages max 2.
  const { groups } = engine([], "Go Python SQL Java Rust", { ...EMPTY_PROFILE, groups: [{ category: "Languages", core: [], min: 1, max: 2, order: 1 }] });
  // Exactly two.
  assert.equal(groups.get("Languages")?.length, 2);
});

test("GROUP COUNT: at least 5 groups when the master holds 5, even for a one-skill posting", () => {
  // A posting naming only Go.
  const { groups } = engine(["l-go"], "Go", EMPTY_PROFILE);
  // Five groups.
  assert.equal(groups.size, 5);
});

test("PROJECTS + ACHIEVEMENTS: the most JD-relevant entry first, the rest in their given order", () => {
  // Two projects and two achievements, the second of each about Kubernetes.
  const master = {
    ...MASTER,
    projects: [
      { id: "p-a", name: "Portal", bullets: [{ id: "pa1", text: "Built a Python portal", tags: [] }] },
      { id: "p-b", name: "Cluster", bullets: [{ id: "pb1", text: "Ran Kubernetes clusters", tags: [] }] },
    ],
    achievements: [
      { id: "a-a", label: "Python award", description: null, bullets: [] },
      { id: "a-b", label: "Kubernetes award", description: null, bullets: [] },
    ],
  } as unknown as MasterProfile;
  // The model's order: A then B.
  const tailored = { ...HONEST_TAILORING, projects: [{ ref: "p-a", bullets: [] }, { ref: "p-b", bullets: [] }], achievements: [{ ref: "a-a", bullets: [] }, { ref: "a-b", bullets: [] }] } as unknown as TailoredProfile;
  // A posting that requires Kubernetes and only mentions Python.
  const ordered = orderByJdRelevance(tailored, master, "We use Python.\nRequirements:\n- Kubernetes");
  // B first in projects.
  assert.deepEqual(ordered.projects.map((p) => p.ref), ["p-b", "p-a"]);
  // Same for achievements.
  assert.deepEqual(ordered.achievements.map((a) => a.ref), ["a-b", "a-a"]);
  // A posting naming neither keeps the given order (stable).
  assert.deepEqual(orderByJdRelevance(tailored, master, "Rust").projects.map((p) => p.ref), ["p-a", "p-b"]);
});

// RED-ON-REVERT for the CALL in createTailorer: the unit test above calls orderByJdRelevance directly, so it would stay
// green if the tailor stopped calling it. This runs the real tailorer end to end.
test("PROJECTS + ACHIEVEMENTS: the tailor itself stores achievements most JD-relevant first (call-site guard)", async () => {
  // MASTER plus two achievements, the second about Kubernetes.
  const master: MasterProfile = { ...MASTER, achievements: [{ id: "a-a", label: "Python award", description: null, bullets: [] }, { id: "a-b", label: "Kubernetes award", description: null, bullets: [] }] };
  // The model lists them A then B, and prints the section.
  const answer: TailoredProfile = { ...HONEST_TAILORING, section_order: ["experience", "skills", "achievements"], achievements: [{ ref: "a-a", bullets: [] }, { ref: "a-b", bullets: [] }] };
  // The real runner over that master.
  const tailor = createTailorer({ callLlm: () => Promise.resolve(JSON.stringify(answer)), master, masterVersion: MASTER_VERSION });
  // A posting that requires Kubernetes.
  const outcome = await tailor({ ...POSTING, jobDescription: "Requirements:\n- Kubernetes" });
  // Stored, not refused.
  assert.equal(outcome.kind, "tailored");
  if (outcome.kind !== "tailored") return;
  // B first in the stored refs.
  assert.deepEqual(outcome.refs.achievements.map((a) => a.ref), ["a-b", "a-a"]);
});

// SEVEN GROUPS (orch ruling 2026-11-21 on peer 4's r4 measurement): Teja's 11-12 13:57 ruling is ">= 5 groups, up to 7
// skills each" with no group maximum; his 33 ideals carry 7 groups (25 of 26 matched) and his chat-edited finals 6.7. The
// r3 engine filled only to the floor of 5, so Databases / Tools / CS Fundamentals (core PostgreSQL, Git, GitHub, Redis)
// lost their seat on 13-20 of 26 ideals. Red on revert of the filler target (back to SKILLS_MIN_GROUPS) or of the cap.
test("SEVEN GROUPS: a posting that covers 1 group still shows 7 when the master holds 7 or more (filler up to SKILLS_MAX_GROUPS)", () => {
  // Ten master groups of two skills each, none named by the posting except Go.
  const master: MasterProfile = { ...MASTER, skills: Array.from({ length: 10 }, (_, g) => [0, 1].map((k) => ({ id: `g${g}-${k}`, name: g === 0 && k === 0 ? "Go" : `Skill ${g}-${k}`, category: `Group ${g}` }))).flat() };
  // A posting that names only Go.
  const shaped = shapeSkillGroups({ ...HONEST_TAILORING, skills: [] }, master, "Go", EMPTY_PROFILE);
  // The groups on the page.
  const groups = new Set(shaped.profile.skills.map(({ ref }) => master.skills.find((s) => s.id === ref)!.category));
  // Exactly the cap: filled past the floor of 5, never past 7.
  assert.equal(groups.size, SKILLS_MAX_GROUPS);
  // And the covered group leads.
  assert.equal(master.skills.find((s) => s.id === shaped.profile.skills[0]!.ref)?.category, "Group 0");
});
