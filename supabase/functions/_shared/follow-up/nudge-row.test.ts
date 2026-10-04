// Tests for mapping an application row to a `follow_up_nudges` insert.
//
// The bug guarded: the function inserted `{ application_id, subject, body, status:'draft' }`
// into a table whose NOT NULL columns are `user_id`, `job_id`, `draft_subject` and
// `draft_body` (phase3_tables_and_gap_fixes.sql:87-110). Every insert failed, and the
// error was only logged. These tests pin the column names to the migration.
import { test } from "node:test";
// Strict, so a missing key never equals a key holding `undefined`.
import assert from "node:assert/strict";
// Extension-suffixed so this runs under Deno and `node --test` alike.
import { toNudgeInsert, readNudgeSource, parseNudgeReply } from "./nudge-row.ts";

// A row shaped like the follow-up select: application columns plus the joined posting.
const ROW = {
  id: "app-1",
  user_id: "user-1",
  job_id: "job-1",
  applied_at: "2026-09-20T10:00:00Z",
  jobs: { title: "Backend Engineer", company_name: "Acme" },
};

test("the insert names every NOT NULL column the table declares", () => {
  const source = readNudgeSource(ROW);
  assert.ok(source, "a complete row must be readable");

  const insert = toNudgeInsert(source, { subject: "Following up", body: "Hi team" });

  // Exact object: an extra or misspelled key here is the original bug.
  assert.deepEqual(insert, {
    user_id: "user-1",
    application_id: "app-1",
    job_id: "job-1",
    draft_subject: "Following up",
    draft_body: "Hi team",
    // 'pending' is the column default and the only pre-review value the coming CHECK allows.
    status: "pending",
  });
});

test("company and title are read through the jobs join, not the application", () => {
  const source = readNudgeSource(ROW);

  // These columns live on `jobs` (core_tables.sql:190-192); applications has neither.
  assert.equal(source?.companyName, "Acme");
  assert.equal(source?.jobTitle, "Backend Engineer");
});

test("a row without its posting or ids is unreadable rather than half-filled", () => {
  // No join: nothing to put in the prompt, and a nudge about "undefined" is worse than none.
  assert.equal(readNudgeSource({ ...ROW, jobs: null }), null);
  // No user_id: the insert would hit the NOT NULL and fail anyway.
  assert.equal(readNudgeSource({ ...ROW, user_id: null }), null);
});

test("parseNudgeReply: a schema-conforming reply becomes a trimmed draft", () => {
  // The happy path, or the validator is just a wall.
  assert.deepEqual(parseNudgeReply(JSON.stringify({ subject: " Following up ", body: "Hi team,\n\nAny update?\n", extra: 1 })), {
    // Trimmed, and the extra key the model added is dropped.
    subject: "Following up",
    body: "Hi team,\n\nAny update?",
  });
});

test("parseNudgeReply: every off-schema reply is null, so nothing is stored and the next run retries", () => {
  // Each case used to become a stored template that the already-nudged exclusion made permanent.
  const bad: unknown[] = [
    // Prose.
    "Sure! Here is a follow-up email.",
    // Valid JSON, wrong top-level shape.
    "null",
    "[]",
    "{}",
    // One field missing, blank, or the wrong type.
    JSON.stringify({ subject: "Following up" }),
    JSON.stringify({ subject: "  ", body: "Hi" }),
    JSON.stringify({ subject: "Following up", body: 3 }),
    // No text part from the transport.
    undefined,
  ];
  // One assertion per case, so a failure names it.
  for (const reply of bad) assert.equal(parseNudgeReply(reply), null, `accepted: ${String(reply)}`);
});
