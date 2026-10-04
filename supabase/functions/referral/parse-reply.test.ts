// Tests for the referral reply-shape validator. Each rejected case is one the old code
// turned into a stored — and therefore permanent — draft.
import { test } from "node:test";
// Strict, so null and undefined are not conflated.
import assert from "node:assert/strict";
// Unit under test.
import { parseReferralReply } from "./parse-reply.ts";

// A reply that follows the schema exactly.
const GOOD = { recipientRole: "Peer engineer", subject: "Backend role at Initech", body: "Hi Sam, I saw...", notes: "Find a 2nd-degree connection." };

test("a schema-conforming reply parses, trimmed", () => {
  // Padding is stripped, content preserved — the happy path must still work.
  assert.deepEqual(parseReferralReply(JSON.stringify({ ...GOOD, body: `  ${GOOD.body}\n` })), GOOD);
});

test("every off-schema reply is null, so nothing is stored and the next run retries", () => {
  // The old code: prose threw into a catch that stored the template; `{}` stored an empty body.
  const bad: unknown[] = [
    // Prose.
    "Sure! Here is a referral message.",
    // Valid JSON, wrong top-level shape.
    "null",
    "[]",
    // The old `?? ""` default turned this into a stored draft with an empty body.
    "{}",
    // One field missing, blank, or the wrong type.
    JSON.stringify({ ...GOOD, notes: undefined }),
    JSON.stringify({ ...GOOD, body: "   " }),
    JSON.stringify({ ...GOOD, subject: 7 }),
    // No text part from the transport.
    undefined,
  ];
  // One assertion per case, so a failure names it.
  for (const reply of bad) assert.equal(parseReferralReply(reply), null, `accepted: ${String(reply)}`);
});
