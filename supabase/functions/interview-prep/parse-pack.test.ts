// Tests for the prep-pack shape validator. The cases are the replies the old code turned
// into permanent empty packs.
import { test } from "node:test";
// Strict assertions so `null` and `undefined` are not conflated.
import assert from "node:assert/strict";
// Unit under test.
import { parsePrepPack } from "./parse-pack.ts";

// A reply that follows the schema exactly.
const GOOD = {
  // Non-blank overview.
  companyResearchOverview: "Acme builds payment rails.",
  // Each list non-empty and all strings.
  roleSpecificQuestions: ["How would you design idempotent payouts?"],
  experienceHighlights: ["Led the ledger migration"],
  talkingPoints: ["Ask about on-call rotation"],
};

test("a schema-conforming reply parses into a pack", () => {
  // The happy path must still work, or the validator is just a wall.
  const pack = parsePrepPack(JSON.stringify(GOOD));
  // Field-by-field equality with the input.
  assert.deepEqual(pack, GOOD);
});

test("non-JSON text is rejected, not thrown", () => {
  // The old code threw here and the catch stored the fallback template as a real pack.
  assert.equal(parsePrepPack("Sure! Here is your prep pack:"), null);
});

test("a missing list is rejected rather than coerced to []", () => {
  // Drop one required field.
  const { talkingPoints: _dropped, ...partial } = GOOD;
  // Old behaviour: `Array.isArray(undefined) ? … : []` stored an empty list.
  assert.equal(parsePrepPack(JSON.stringify(partial)), null);
});

test("a blank overview is rejected rather than stored as empty text", () => {
  // `String("")` was accepted before.
  assert.equal(parsePrepPack(JSON.stringify({ ...GOOD, companyResearchOverview: "  " })), null);
});

test("a list containing a non-string is rejected, not stringified", () => {
  // `.map(String)` would have turned this object into "[object Object]".
  assert.equal(parsePrepPack(JSON.stringify({ ...GOOD, experienceHighlights: [{ x: 1 }] })), null);
});

test("an array at the top level is rejected", () => {
  // Arrays are objects to `typeof`, so this needs its own check.
  assert.equal(parsePrepPack(JSON.stringify([GOOD])), null);
});
