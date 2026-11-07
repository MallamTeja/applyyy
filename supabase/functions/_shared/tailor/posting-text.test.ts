// postingText: the text every edge reader of jobs.description_raw sees (N1, 2026-11-07).
// Red on revert: make postingText return its input unchanged and the HTML tests below go red.

// Node's built-in runner, so the suite runs under `node --test` with no install.
import { test } from "node:test";
// Strict assertions: deepEqual compares by value, equal by ===.
import assert from "node:assert/strict";
// The unit under test.
import { postingText } from "./posting-text.ts";
// The keyword extractor, to prove the stripped text still yields the posting's skills.
import { extractJdKeywords } from "./jd-keywords.ts";

// The live HTML posting excerpt (row 76280e87).
import { CIRCUITHUB_HTML } from "./posting-html.fixture.ts";

test("postingText: a stored HTML posting reads as text, with no tags, attributes or styles", () => {
  // The live sample, stripped.
  const text = postingText(CIRCUITHUB_HTML);
  // No markup survives: no tag, no attribute, no inline style.
  for (const junk of ["<", ">", "style=", "min-height", "href="]) assert.equal(text?.includes(junk), false, `${junk} survived: ${text}`);
  // The prose survives, so nothing a reader needs is lost.
  for (const word of ["Python", "OR-Tools", "Snowflake", "dbt", "Dagster", "PostgreSQL"]) assert.ok(text?.includes(word), `${word} lost: ${text}`);
  // Block tags become line breaks, so the list keeps its shape instead of running together.
  assert.ok(text?.includes("Modelling: Python, OR-Tools, simulation\n"), text ?? "null");
});

test("postingText: the stripped posting still yields its vocabulary skills, and no markup becomes a keyword", () => {
  // The extractor over the stripped text.
  const keywords = extractJdKeywords(postingText(CIRCUITHUB_HTML) ?? "");
  // Python, SQL and PostgreSQL are vocabulary terms (OR-Tools, Snowflake, dbt and Dagster are not, by design).
  for (const term of ["Python", "SQL", "PostgreSQL"]) assert.ok(keywords.includes(term), `${term} missing: ${keywords}`);
  // Exactly those three: no tag, style or footer word became a keyword.
  assert.deepEqual(keywords, ["PostgreSQL", "Python", "SQL"]);
});

test("postingText: an encoded plus is decoded, so a '7+ years' requirement is readable", () => {
  // Workday sends "+" as "&#43;" (492 live rows on 2026-11-06).
  assert.equal(postingText("Requires 7&#43; years of experience."), "Requires 7+ years of experience.");
});

// CLAUDE.md §6: missing data must not become an answer. An all-markup body stripped to nothing must
// not read as "a posting with no requirements"; it falls back to what was stored.
test("postingText: a body that strips to nothing falls back to the stored text, never empty", () => {
  // Tags only.
  assert.equal(postingText("<p></p><br>"), "<p></p><br>");
});

// Absence stays absence, and plain text passes through untouched.
test("postingText: null stays null and plain text is unchanged", () => {
  // No posting.
  assert.equal(postingText(null), null);
  // Already text.
  assert.equal(postingText("Node.js and Express backend."), "Node.js and Express backend.");
});
