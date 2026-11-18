// Tests for the Lever adapter's description: the requirement bullets must reach the screen (2026-11-18).
//
// WHY THIS FILE EXISTS. Lever splits a posting into `descriptionPlain` (the intro prose), `lists[]` (the
// sections: Responsibilities, Requirements, …, each `{ text: heading, content: HTML <li> items }`) and
// `additional` (closing text). The adapter stored only the intro, so Netomi "Data Engineer I" (2+ years),
// Keyloop "Cloud Engineer" (6+ years) and Egen "ML Platform Engineer" (5+ years) reached Teja's queue: the
// years lived in `lists[]` and the experience screen never saw them. The fixture below is the live Netomi
// shape from api.lever.co, trimmed to the lines that matter.

// node:test, the runner every _shared suite uses.
import { test } from "node:test";
// Strict, so null and "" are never confused.
import assert from "node:assert/strict";
// The adapter under test.
import { leverAdapter } from "./lever.ts";
// The experience screen, to prove the bullet now reaches the rule end to end.
import { screenRequiredExperience } from "../screen/required-experience.ts";

// The live Netomi posting (api.lever.co/v0/postings/netomi, 2026-11-18), keys and nesting verbatim.
const NETOMI_DE1 = {
  // Lever's posting id.
  id: "02b45afd-5a49-41b2-a244-b0ca76306692",
  // Lever calls the title `text`.
  text: "Data Engineer I",
  // Epoch milliseconds.
  createdAt: 1761900000000,
  // Location and commitment live under categories.
  categories: { commitment: "Full Time", location: "Gurugram", team: "Analytics" },
  // The intro only: no years anywhere in it, which is why the row leaked.
  descriptionPlain: "Netomi is seeking a highly analytical and detail-oriented candidate to join the Analytics team in Gurugram.",
  // The same intro as HTML.
  description: "<div>Netomi is seeking a highly analytical and detail-oriented candidate to join the Analytics team in Gurugram.</div>",
  // The sections, each a heading plus <li> HTML, as Lever ships them.
  lists: [
    // A plain section.
    { text: "Responsibilities", content: "<div>\n\n<li>Architect and implement scalable data pipelines using <strong>Spark, Airflow</strong>.</li>\n</div>" },
    // THE section the screen needs: the live bullet, markup included.
    { text: "Requirements:", content: "<div>\n\n<li>2+ years of hands-on experience in data engineering or backend software development roles.</li>\n<li>Strong <strong>SQL</strong> skills.</li>\n</div>" },
  ],
  // The closing text, plain form.
  additionalPlain: "Netomi is an equal opportunity employer committed to diversity in the workplace.\n",
  // The closing text, HTML form.
  additional: "<div>Netomi is an equal opportunity employer committed to diversity in the workplace.</div>",
  // The posting page.
  hostedUrl: "https://jobs.lever.co/netomi/02b45afd-5a49-41b2-a244-b0ca76306692",
  // The form itself.
  applyUrl: "https://jobs.lever.co/netomi/02b45afd-5a49-41b2-a244-b0ca76306692/apply",
  // On-site in Gurugram.
  workplaceType: "onsite",
};

// Parse one posting and hand back its description, failing loudly on any other outcome.
function descriptionOf(entry: Record<string, unknown>): string | null {
  // The adapter reads a top-level array.
  const result = leverAdapter.parse([entry]);
  // A parse failure here is a fixture bug, not a description bug.
  assert.equal(result.ok, true);
  // Narrow for the type checker; the assert above already proved it.
  if (!result.ok) return null;
  // Exactly one posting in, one out.
  assert.equal(result.postings.length, 1);
  // The field under test.
  return result.postings[0]!.descriptionRaw;
}

// The bullet text, the heading and the closing text are all in the stored description.
test("lever: Netomi lists[] Requirements bullet and additional text are kept in descriptionRaw", () => {
  // The description the scout would store.
  const text = descriptionOf(NETOMI_DE1) ?? "";
  // The intro still comes first.
  assert.ok(text.startsWith("Netomi is seeking"), text);
  // The section heading survives, so the parser's section logic can see "Requirements".
  assert.match(text, /^Requirements:$/m);
  // The bullet itself, with its markup gone.
  assert.match(text, /^2\+ years of hands-on experience in data engineering or backend software development roles\.$/m);
  // No HTML leaks through.
  assert.doesNotMatch(text, /<[a-z/]/i);
  // The closing text is appended too (location wording often sits there).
  assert.match(text, /equal opportunity employer/);
});

// End to end: the same posting now trips the experience ceiling Teja set at 1 year.
test("lever: Netomi 'Data Engineer I' 2+ years bullet now drops at ceiling 1", () => {
  // The description the screener would read.
  const description = descriptionOf(NETOMI_DE1);
  // The screen the cascade and the matcher both run.
  const verdict = screenRequiredExperience({ title: "Data Engineer I", description, minExperienceYears: null }, 1);
  // Dropped, with the rule's own code.
  assert.deepEqual(verdict, { drop: true, code: "experience_ceiling", reason: "JD requires 2 years, ceiling is 1" });
});

// A posting with no lists and no additional text keeps exactly the old description.
test("lever: a posting without lists[] or additional keeps descriptionPlain unchanged", () => {
  // The bare intro-only shape the older fixture uses.
  const bare = { ...NETOMI_DE1, lists: undefined, additional: undefined, additionalPlain: undefined };
  // Identical to the plain intro: no stray separators or headings.
  assert.equal(descriptionOf(bare), NETOMI_DE1.descriptionPlain);
});

// Malformed list entries are skipped, never crash the board read.
test("lever: malformed lists[] entries are skipped, the good ones kept", () => {
  // Wire noise mixed with one real section.
  const noisy = { ...NETOMI_DE1, lists: [null, "x", { text: 5, content: 7 }, { text: "Requirements", content: "<li>3+ years of experience</li>" }] };
  // The good section is there.
  const text = descriptionOf(noisy) ?? "";
  // Its heading and bullet survive.
  assert.match(text, /^Requirements\n3\+ years of experience$/m);
});

// No text anywhere is still null, the column's one representation of "nothing".
test("lever: no description, lists or additional is null", () => {
  // Every text field absent.
  const empty = { ...NETOMI_DE1, descriptionPlain: undefined, description: undefined, lists: [], additional: undefined, additionalPlain: undefined };
  // Null, never "".
  assert.equal(descriptionOf(empty), null);
});
