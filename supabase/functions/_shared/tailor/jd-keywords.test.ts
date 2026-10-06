// Tests for the job-description skill extractor behind `selected_jd_keywords`.
//
// THE RULE UNDER TEST: the list is the DENOMINATOR of the approval page's ATS coverage,
// so it must hold skills and requirements, never filler. Positive cases prove real terms
// are found; the negative cases prove the English-word traps ("go", "rest", "said") and
// the substring traps ("SQL" in "PostgreSQL") do not leak in, because each one would
// inflate or deflate a number the operator trusts.
import { test } from "node:test";
// Strict, so an array order difference is a failure, not a coercion.
import assert from "node:assert/strict";
// Extension-suffixed so this runs under Deno and `node --test` alike.
import { extractJdKeywords } from "./jd-keywords.ts";

// A short posting in the shape of the live GitLab one, written for this test.
const POSTING = [
  // The language line: Go capitalised, Ruby on Rails, Rust.
  "Design and ship backend features in Ruby/Rails, Go, or Rust.",
  // Data and infra requirements.
  "Experience with PostgreSQL, caching, queues, Docker, Kubernetes and CI/CD.",
  // Practice requirements.
  "Add unit tests, take part in code review and on-call; observability using metrics and traces.",
  // Boilerplate that must contribute NOTHING.
  "We are an equal opportunity employer regardless of ancestry, age, or veteran status. Equity Compensation &amp; Benefits.",
].join("\n");

test("finds the posting's skill terms, sorted, each once", () => {
  // The exact list, so a vocabulary edit that changes it is a visible decision.
  assert.deepEqual(extractJdKeywords(POSTING), [
    // Code-point order: uppercase-led terms ("CI/CD", "Caching") sort before lowercase-led.
    "CI/CD", "Caching", "Code review", "Docker", "Go", "Kubernetes", "Message queues",
    // "Testing" comes from "unit tests"; "On-call" and "Code review" from the practice line.
    "Observability", "On-call", "PostgreSQL", "Rails", "Ruby", "Rust", "Testing",
    // Absent on purpose: nothing from the boilerplate line, and no "SQL" from "PostgreSQL".
  ]);
});

test("boilerplate contributes no keywords", () => {
  // Equal-opportunity and benefits text, the bulk of the old extractor's 448 tokens.
  assert.deepEqual(extractJdKeywords("We value ancestry, age, citizenship, benefits, equity and parental leave."), []);
});

test("English-word traps are not technologies", () => {
  // "go", "rest", "said", "spring" in prose must not become Go, REST, AI, Spring.
  assert.deepEqual(extractJdKeywords("You will go the extra mile, rest on Fridays, as said, in spring."), []);
});

test("SQL is not found inside PostgreSQL or MySQL", () => {
  // Word boundaries: the databases are found, the bare language is not.
  assert.deepEqual(extractJdKeywords("We run PostgreSQL and MySQL."), ["MySQL", "PostgreSQL"]);
});

test("Go is found as the language, not inside Google", () => {
  // "Google Cloud" names a platform; "Go" alone the language.
  assert.deepEqual(extractJdKeywords("Deploy to Google Cloud using Go."), ["Go", "Google Cloud"]);
});

test("is deterministic: same text, same list, whatever the order of mentions", () => {
  // Reordered mentions give the identical list, which matters once this feeds tailored_hash.
  assert.deepEqual(extractJdKeywords("Docker then Redis."), extractJdKeywords("Redis then Docker."));
});

test("an empty posting yields an empty list, not an error", () => {
  // The column default is '{}'; an empty description must map to exactly that.
  assert.deepEqual(extractJdKeywords(""), []);
});
