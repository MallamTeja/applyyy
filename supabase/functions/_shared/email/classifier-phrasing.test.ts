// Rejection PHRASING coverage: real wordings ATS rejections use, and look-alikes that must not
// be read as rejections.
//
// WHY A SEPARATE FILE: email.test.ts covers the parser and the decision engine's precedence;
// this file is a phrasing table, which grows independently and reads best as one list.
//
// WHY THE NEGATIVES MATTER MORE THAN THE POSITIVES: `rejected` is terminal (the graph has no
// edge out) and rejection OVERRIDES an interview verdict in classifyEmail, so a false rejection
// silently kills a live application. A missed rejection only leaves a row waiting for a human.
// Added 2026-10-06 for the misses logged in 113bf60.
import { test } from "node:test";
// Strict, so a mismatch is never papered over by coercion.
import assert from "node:assert/strict";
// The entrypoint the intake path uses: parse, then classify.
import { classifyRawEmail } from "./classifier.ts";
// The live terminal gate, imported rather than copied, so a change to it re-checks these rows.
import { TERMINAL_MIN_CONFIDENCE } from "../../email-tracker-intake/decide.ts";

// Classify a body under a neutral subject and an employer sender. The subject is deliberately
// NOT "Update on your application", whose corroborating weight would blur what the body alone does.
function classifyBody(body: string) {
  // One fixed envelope, so the body is the only variable in every case below.
  return classifyRawEmail({ subject: "Hello", body, sender: "recruiting@acme.com" });
}

// Rejections that matched NO strong signal before 2026-10-06. Each must clear the terminal gate
// on its own: these are decisions, not tone.
const MUST_REJECT: readonly string[] = [
  // No "Unfortunately," opener: the decision phrase alone used to match nothing.
  "We have decided to move forward with other candidates whose experience more closely matches the role.",
  // Contraction of the same, ASCII apostrophe.
  "We've decided to move forward with other candidates.",
  // Same, typographic apostrophe, which mail clients substitute freely.
  "We’ve decided to move forward with other candidates.",
  // Base form "move forward with", future tense.
  "We will move forward with other applicants for this position.",
  // "another candidate", singular, with "go forward".
  "After careful consideration, we've decided to go forward with another candidate.",
  // Contraction "won't be moving forward", with an application object.
  "We won't be moving forward with your application.",
  // Contraction "aren't moving forward", with a time object.
  "We aren't moving forward at this time.",
  // "we're unable to" after the opener.
  "Unfortunately, we're unable to move forward with your candidacy at this time.",
  // "are not able to offer you" after the opener.
  "Unfortunately, we are not able to offer you a position.",
];

// Look-alikes that share the verbs but not the decision. None may be classified `rejected` at all.
const MUST_NOT_REJECT: readonly string[] = [
  // Enthusiastic "move forward with your application": the object is the candidate, not others.
  "We're excited to move forward with your application!",
  // "decided to move forward with you": an advancement, phrased like a decision.
  "We've decided to move forward with you to the next round.",
  // "won't be able to" a meeting: a scheduling conflict, not a verdict.
  "We won't be able to make Thursday, can we reschedule?",
  // WAS A LIVE FALSE REJECTION before 2026-10-06: "decided" was accepted with no object.
  "After careful consideration, we have decided to move forward with your application to the onsite.",
  // WAS A LIVE FALSE REJECTION: "cannot move" matched a moved interview slot.
  "Unfortunately, we cannot move your interview to Friday.",
  // Opener plus a scheduling conflict: tone word only.
  "Unfortunately, we won't be able to meet on Thursday; could we reschedule?",
  // "not be moving forward with" a STEP, not the candidate: postponement, not rejection.
  "We will not be moving forward with the onsite until the hiring manager returns.",
];

// One test per phrase, so a failure names the exact wording that regressed.
for (const body of MUST_REJECT) {
  // The phrase is the test name: the red line in a run is the email that broke.
  test(`rejects: ${body}`, () => {
    // Classify the phrase alone.
    const result = classifyBody(body);
    // It must be a rejection...
    assert.equal(result.outcome, "rejected", `matched: ${result.matchedSignals.join(", ")}`);
    // ...strong enough to move a status, i.e. a strong phrase fired, not a sum of weak ones.
    assert.ok(result.confidence >= TERMINAL_MIN_CONFIDENCE, `confidence ${result.confidence}`);
  });
}

// One test per look-alike, for the same reason.
for (const body of MUST_NOT_REJECT) {
  // Named by phrase, so the false rejection is readable in the run output.
  test(`does not reject: ${body}`, () => {
    // Classify the look-alike alone.
    const result = classifyBody(body);
    // Not even the moderate (stored, unmoved) band: a look-alike must not read as a rejection.
    assert.notEqual(result.outcome, "rejected", `matched: ${result.matchedSignals.join(", ")} at ${result.confidence}`);
  });
}
