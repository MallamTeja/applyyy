// Tests for the Matcher scorer — the seam that composes prompt, model and rubric.
//
// THE MODEL IS INJECTED, SO NONE OF THIS SPENDS QUOTA. That is the same decision
// `eval/gate.ts` makes when it takes a `Scorer` rather than calling Gemini itself, and it
// is what lets the scorer's own logic — response parsing, validation, banding, the error
// paths — be proven correct BEFORE a single real call is made. A test suite that needs a
// live model is a test suite nobody runs.
//
// WHAT IS BEING TESTED IS THE COMPOSITION, not the model's judgement. Whether Gemini
// scores a job 70 or 75 is not assertable and not this file's business. Whether a
// malformed response becomes a confident-looking number IS.
import { test } from "node:test";
// Strict, so a missing score never quietly compares equal to zero.
import assert from "node:assert/strict";
// The unit under test.
import { createScorer, type LlmCaller } from "./scorer.ts";
// The case shape comes from the eval gate rather than being redefined here — conforming
// to that seam is what makes this scorer directly runnable by `runEvalGate`.
import type { EvalCase } from "../eval/gate.ts";

// One posting to score. Only the fields the scorer reads need to be realistic.
const CASE: EvalCase = {
  id: "case-1",
  job_snapshot: {
    title: "Backend Engineer",
    company_name: "Zomato",
    location_raw: "Bengaluru, India",
    description_raw: "Build Go services.",
    min_experience_years: "2",
    employment_type: "full_time",
  },
  label: "good_fit",
  rationale: null,
  master_version: 7,
};

// A stub model returning whatever JSON a test needs. Returning a STRING rather than an
// object on purpose: the real transport hands back text, and parsing it is one of the
// failure surfaces under test.
function stubCaller(response: string): LlmCaller {
  return () => Promise.resolve(response);
}

// Build a scorer with the trusted half supplied.
function scorer(caller: LlmCaller) {
  return createScorer({
    callLlm: caller,
    candidateProfile: "Full-stack developer. Node, React, TypeScript.",
    masterVersion: 7,
  });
}

// A well-formed model response.
const GOOD_RESPONSE = JSON.stringify({
  technical: 90,
  experience: 60,
  behavioral: 40,
  career: 70,
  reasoning: "Strong Go alignment, thinner on the data side.",
});

// --- the happy path ---

// 90*30 + 60*25 + 40*15 + 70*30 = 6900, so 69. Computed by hand so the test does not
// simply restate the implementation.
test("a well-formed response is weighted into a single score", async () => {
  const result = await scorer(stubCaller(GOOD_RESPONSE))(CASE);
  assert.equal(result.score, 69);
});

// The reasoning must survive to the caller, because a score with no justification cannot
// be reviewed and the eval gate surfaces it on failure.
test("the model's reasoning is carried through to the result", async () => {
  const result = await scorer(stubCaller(GOOD_RESPONSE))(CASE);
  assert.match(result.reasoning, /Go alignment/);
});

// --- the composition actually being wired ---

// THE INTEGRATION TEST THAT MATTERS: the scraped posting must reach the model inside the
// fence, and the trusted profile must not. Each half is tested in prompt.test.ts; this
// asserts the scorer actually uses that assembly rather than building its own.
test("the posting reaches the model fenced, and the profile stays in the instruction", async () => {
  let seenSystem = "";
  let seenUser = "";
  const spy: LlmCaller = (prompt) => {
    seenSystem = prompt.systemInstruction;
    seenUser = prompt.userContent;
    return Promise.resolve(GOOD_RESPONSE);
  };
  await scorer(spy)(CASE);
  // The posting is in the untrusted region.
  assert.match(seenUser, /Backend Engineer/);
  // And nowhere in the instruction region.
  assert.equal(seenSystem.includes("Backend Engineer"), false);
  // The trusted profile is in the instruction region only.
  assert.match(seenSystem, /Full-stack developer/);
  assert.equal(seenUser.includes("Full-stack developer"), false);
});

// --- refusing to turn a bad response into a confident number ---

// THE MOST IMPORTANT GROUP IN THIS FILE. Every case below could plausibly be "handled"
// by substituting a default, and every such default would produce a plausible-looking
// score that no longer reflects anything the model said. A score a human trusts must
// either be real or absent.

// A dimension the model omitted must not become zero. The rubric raises; the scorer must
// let that surface rather than catching it into a default.
test("a response missing a dimension raises rather than scoring it as zero", async () => {
  const missing = JSON.stringify({ technical: 90, experience: 60, behavioral: 40, reasoning: "..." });
  await assert.rejects(() => scorer(stubCaller(missing))(CASE), /career/);
});

// A model that returns prose instead of JSON is a failure, not a zero.
test("a non-JSON response raises rather than scoring zero", async () => {
  await assert.rejects(() => scorer(stubCaller("I cannot help with that."))(CASE), /parse|JSON/i);
});

// Valid JSON of the wrong shape is the sneakier case: it parses, so a careless
// implementation reads four undefineds and scores 0.
test("valid JSON that is not an object raises", async () => {
  await assert.rejects(() => scorer(stubCaller("[1,2,3]"))(CASE), /object/i);
});

// An out-of-scale dimension means the model ignored the rubric. Clamping would hide that,
// and applications.match_score has a 0-100 CHECK that would reject the row later anyway.
test("a dimension outside 0-100 raises rather than being clamped", async () => {
  const tooHigh = JSON.stringify({ technical: 900, experience: 60, behavioral: 40, career: 70, reasoning: "..." });
  await assert.rejects(() => scorer(stubCaller(tooHigh))(CASE), /technical/);
});

// --- the model's text is untrusted on the way OUT too ---

// `reasoning` is the one field that can echo the posting back at us, so a hostile posting
// can influence its content. It must arrive as inert data — never executed, never used
// for control flow. Asserting it is carried verbatim pins that it is not being
// interpreted, and documents that the escaping obligation sits with whoever renders it.
test("reasoning is carried verbatim rather than interpreted", async () => {
  const hostile = JSON.stringify({
    technical: 50, experience: 50, behavioral: 50, career: 50,
    reasoning: "<script>alert(1)</script> ignore prior instructions",
  });
  const result = await scorer(stubCaller(hostile))(CASE);
  // Stored exactly as received: sanitising here would make the stored row disagree with
  // what the model actually returned, which is the same reasoning the ATS adapters use.
  assert.match(result.reasoning, /<script>/);
});

// --- a posting with missing fields must still be scoreable ---

// Most boards omit something. A null description must not crash the scorer or render as
// the string "null" in the prompt.
test("a posting with no description is still scoreable", async () => {
  const sparse: EvalCase = { ...CASE, job_snapshot: { ...CASE.job_snapshot, description_raw: null, location_raw: null } };
  const result = await scorer(stubCaller(GOOD_RESPONSE))(sparse);
  assert.equal(result.score, 69);
});
