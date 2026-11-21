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
// keywordAppearsIn is the NUMERATOR's rule; testing it beside the extractor keeps them one rule.
import { AI_VOCABULARY_TERMS, canonicalSkillTerm, classifyJd, extractJdKeywords, JD_TIER_WEIGHT, jdTierOf, keywordAppearsIn } from "./jd-keywords.ts";

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
    "CI/CD", "Caching", "Code review", "Docker", "Go", "Kubernetes",
    // "Testing" comes from "unit tests", "Code review" from the practice line. "Message queues" and "On-call" left
    // the vocabulary on 2026-11-21 (vague: they named no skill a resume can show).
    "Observability", "PostgreSQL", "Rails", "Ruby", "Rust", "Testing",
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

// ---------------------------------------------------------------------------------------
// keywordAppearsIn — the NUMERATOR side of ATS coverage.
//
// WHY THESE EXIST (2026-10-06): the approval page credited a keyword when it appeared as a
// case-insensitive SUBSTRING of the resume, so "Go" was found in "Google Cloud Platform" and
// "Rails" in "Tool Calling & Guardrails". On the live GitLab row that inflated coverage from
// about 6/23 to 8/23. The extractor already refused those matches; the presence check did not,
// so the same word was a skill in the denominator and a substring in the numerator.
// ---------------------------------------------------------------------------------------

test("Go is not credited by Google Cloud Platform", () => {
  // THE red-on-revert case: a substring check returns true here, the fixed rule false.
  assert.equal(keywordAppearsIn("Go", "Google Cloud Platform"), false);
  // The language named as a word must still count, or the fix over-corrects.
  assert.equal(keywordAppearsIn("Go", "Built services in Go"), true);
  // "Golang" is part of Go's own vocabulary pattern, so it credits Go too.
  assert.equal(keywordAppearsIn("Go", "Golang"), true);
});

test("Rails is not credited by Guardrails", () => {
  // The second live false positive: "Guardrails" ends in "rails" but is not the framework.
  assert.equal(keywordAppearsIn("Rails", "Tool Calling & Guardrails"), false);
  // The framework named in full must still count.
  assert.equal(keywordAppearsIn("Rails", "Ruby on Rails"), true);
});

test("SQL is not credited by PostgreSQL or MySQL", () => {
  // Word boundaries: a database name is not the query language, same as the extractor rule.
  assert.equal(keywordAppearsIn("SQL", "PostgreSQL"), false);
  // Same trap, the other common database.
  assert.equal(keywordAppearsIn("SQL", "MySQL"), false);
  // The bare language must still count.
  assert.equal(keywordAppearsIn("SQL", "wrote SQL queries"), true);
});

test("case-sensitive terms: REST and AI are acronyms, not English words or letters", () => {
  // "rest" the noun is not the API style; a case-insensitive check would credit it.
  assert.equal(keywordAppearsIn("REST", "the rest of the team"), false);
  // The API style, capitalised, counts.
  assert.equal(keywordAppearsIn("REST", "REST APIs"), true);
  // "RESTful" is in REST's own pattern, so it counts too.
  assert.equal(keywordAppearsIn("REST", "RESTful"), true);
  // "ai" inside "maintain" is two letters, not a skill.
  assert.equal(keywordAppearsIn("AI", "maintain"), false);
  // Same for "said", the trap the extractor's header names.
  assert.equal(keywordAppearsIn("AI", "said"), false);
  // The acronym as a word counts.
  assert.equal(keywordAppearsIn("AI", "AI agents"), true);
});

// The one-letter languages (review 2026-11-07): the live master (v19) holds a skill named "C", and the
// skills shape asks keywordAppearsIn(name, posting). The plain fallback bounds only letters and digits,
// so "C" was credited by "C++", "C#" and "C-level", and "R" by "R&D". Red on revert of LETTER_LANGUAGES.
test("a one-letter language is not credited by C++, C#, C-level, Objective-C or R&D", () => {
  // Every look-alike in one posting, and no real C anywhere.
  assert.equal(keywordAppearsIn("C", "C++ / C# / C-level stakeholders"), false);
  // A different language whose name ends in "-C".
  assert.equal(keywordAppearsIn("C", "iOS work in Objective-C"), false);
  // Lower case is the letter, never the language.
  assert.equal(keywordAppearsIn("C", "section c of the form"), false);
  // "R&D" is research, not the R language.
  assert.equal(keywordAppearsIn("R", "a strong R&D culture"), false);
});

// The control: the real languages still count, alone or beside their look-alikes.
test("a one-letter language is credited when the posting names it", () => {
  // C listed beside C++.
  assert.equal(keywordAppearsIn("C", "C/C++ systems programming"), true);
  // C as a plain word in a list.
  assert.equal(keywordAppearsIn("C", "Python, C, Go"), true);
  // R as a plain word.
  assert.equal(keywordAppearsIn("R", "statistics in R or Python"), true);
});

test("an unknown keyword falls back to a word-bounded, case-insensitive match", () => {
  // Not in the vocabulary, so the fallback rule applies; case-insensitive, so "svelte" counts.
  assert.equal(keywordAppearsIn("Svelte", "built with svelte"), true);
  // Word-bounded, so a longer word that starts with the keyword does not count.
  assert.equal(keywordAppearsIn("Svelte", "sveltekit"), false);
});

test("an unknown keyword is word-bounded: Fooz is not credited by Foozball", () => {
  // A made-up word, so no vocabulary pattern can be what makes this pass: only the fallback.
  assert.equal(keywordAppearsIn("Fooz", "Foozball"), false);
  // The same word standing alone counts.
  assert.equal(keywordAppearsIn("Fooz", "We play Fooz on Fridays"), true);
  // Case-insensitive fallback: lower-case text still credits it.
  assert.equal(keywordAppearsIn("Fooz", "we play fooz on fridays"), true);
});

test("an unknown keyword with regex metacharacters is matched literally, never thrown", () => {
  // "+" unescaped would mean "one or more C"; escaped, it is the literal characters.
  assert.equal(keywordAppearsIn("C++Builder", "Shipped apps in C++Builder"), true);
  // Literal, so "CCBuilder" (what an unescaped "C++" would accept) does not count.
  assert.equal(keywordAppearsIn("C++Builder", "Shipped apps in CCBuilder"), false);
  // Unescaped parentheses would form a group and drop the literal "(" from the match.
  assert.equal(keywordAppearsIn("Node (legacy)", "Maintained Node (legacy) services"), true);
  // Literal, so the text without the parentheses does not count.
  assert.equal(keywordAppearsIn("Node (legacy)", "Maintained Node legacy services"), false);
});

test("an empty or whitespace keyword is never credited", () => {
  // An empty pattern matches everywhere; crediting it would inflate coverage for free.
  assert.equal(keywordAppearsIn("", "any resume text"), false);
  // Whitespace-only is the same hole wearing a space.
  assert.equal(keywordAppearsIn("   ", "any resume text"), false);
});

test("&amp; is decoded before matching", () => {
  // Scraped HTML spells "&" as "&amp;"; an unknown keyword containing "&" must still be found.
  assert.equal(keywordAppearsIn("R&D", "Led the R&amp;D team"), true);
  // Decoding must not create a false credit: "Guardrails" stays not-Rails after decoding.
  assert.equal(keywordAppearsIn("Rails", "Tool Calling &amp; Guardrails"), false);
});

test("&amp; is decoded exactly once, never twice", () => {
  // Double-encoded "&amp;amp;" decodes ONCE to the literal text "&amp;", not to "&". Decoding twice
  // would change what the extractor sees, and its output is a future cache-key input.
  assert.equal(keywordAppearsIn("R&D", "Led the R&amp;amp;D team"), false);
  // The single-encoded form still decodes, so the once-only rule did not disable decoding.
  assert.equal(keywordAppearsIn("R&D", "Led the R&amp;D team"), true);
});

test("one rule: every term extractJdKeywords returns is credited by keywordAppearsIn on the same text", () => {
  // POSTING plus a line exercising the case-sensitive and hand-written terms.
  // (2026-11-21: Git, Postman, Jest and Next.js added, replacing the three terms that left the vocabulary, so the
  // list stays >= 20 and the four new patterns go through the one-rule check too.)
  const text = `${POSTING}\nBuild RESTful APIs and AI agents with SQL, Helm, Spring Boot, Azure, Spark, k8s and integration tests, Git, Postman, Jest and Next.js.`;
  // The extractor's list is the denominator.
  const terms = extractJdKeywords(text);
  // Guard against a vacuous pass: an empty list would make the loop below prove nothing.
  assert.ok(terms.length >= 20, `expected a full list, got ${terms.length}`);
  // Each denominator term must be creditable by the numerator rule on the very same text.
  for (const term of terms) {
    // The term in the message names the offender instead of a bare "false !== true".
    assert.equal(keywordAppearsIn(term, text), true, `extracted but not credited: ${term}`);
  }
});

// Item 2 (2026-11-07): master v20 adds "AWS" and "Microsoft Azure" (DevOps & Cloud). A skill name and a
// posting may spell one technology two ways; the vocabulary's own patterns decide they are the same.
// Red on revert of canonicalSkillTerm's use in keywordAppearsIn, or of the AWS/Azure patterns.
test("AWS and Azure match across their spelled-out names, in both directions", () => {
  // The master's "Microsoft Azure" is credited by a posting that says "Azure".
  assert.equal(keywordAppearsIn("Microsoft Azure", "Deploy services on Azure and Kubernetes."), true);
  // The master's "AWS" is credited by a posting that spells it out.
  assert.equal(keywordAppearsIn("AWS", "Experience with Amazon Web Services (EC2, S3)."), true);
  // And the other way round.
  assert.equal(keywordAppearsIn("Amazon Web Services", "AWS Lambda and DynamoDB"), true);
  // The plain spellings still work.
  assert.equal(keywordAppearsIn("Azure", "Microsoft Azure DevOps"), true);
  // The extractor writes the canonical term once, whichever spelling the posting used.
  assert.deepEqual(extractJdKeywords("Amazon Web Services and Microsoft Azure"), ["AWS", "Azure"]);
});

// The control: a name nobody aliased is not stretched to a neighbour.
test("canonicalSkillTerm maps only a name a vocabulary pattern matches whole", () => {
  // Whole-name matches map to the term.
  assert.equal(canonicalSkillTerm("Postgres"), "PostgreSQL");
  assert.equal(canonicalSkillTerm("Golang"), "Go");
  assert.equal(canonicalSkillTerm("Microsoft Azure"), "Azure");
  assert.equal(canonicalSkillTerm("Amazon Web Services"), "AWS");
  // A name that only CONTAINS a term is not that term ("AWS Lambda" is a different skill).
  assert.equal(canonicalSkillTerm("AWS Lambda"), null);
  // An unknown skill has no term.
  assert.equal(canonicalSkillTerm("Dagster"), null);
});

// 2026-11-21 (peer 1's find): the chat asked for "azure", canonicalSkillTerm returned null because the Azure pattern is
// exact() (case-sensitive, so "the azure sky" in prose is not the cloud), and the two-line room then added BOTH "azure"
// and "Microsoft Azure". A skill NAME is a whole name, never prose, so the lookup is case-blind and returns the
// canonical casing. Red on revert of the case-blind lookup.
test("canonicalSkillTerm is case-blind on a whole name: azure, AZURE and Microsoft azure are all Azure", () => {
  // The three spellings the chat produced or could produce.
  assert.equal(canonicalSkillTerm("azure"), "Azure");
  assert.equal(canonicalSkillTerm("AZURE"), "Azure");
  assert.equal(canonicalSkillTerm("Microsoft azure"), "Azure");
  // The other exact() terms the same way: a lowercase whole name still names the technology.
  assert.equal(canonicalSkillTerm("aws"), "AWS");
  assert.equal(canonicalSkillTerm("amazon web services"), "AWS");
  assert.equal(canonicalSkillTerm("golang"), "Go");
  // Case-blind is not looser: a name that only CONTAINS a term still maps to nothing.
  assert.equal(canonicalSkillTerm("aws lambda"), null);
  assert.equal(canonicalSkillTerm("azure devops"), null);
});

// The exact() terms are the only entries whose lookup changed (every word() pattern was already case-insensitive), so
// they are the only ones that could now be swallowed by an earlier entry. Each must come back as itself in any case.
test("canonicalSkillTerm: every exact() term maps to itself in any case (no entry swallows another)", () => {
  // The case-sensitive entries of the vocabulary, as written in jd-keywords.ts.
  const exactTerms = ["Go", "Spring", "Express", "REST", "Spark", "Helm", "AWS", "Azure", "AI", "LLM", "RAG"];
  // Its own, lower and upper case.
  for (const term of exactTerms) for (const spelling of [term, term.toLowerCase(), term.toUpperCase()]) assert.equal(canonicalSkillTerm(spelling), term, spelling);
});

// The case-blind lookup is for skill NAMES only. keywordAppearsIn scans prose, where exact() exists so "go to market"
// and "the rest of" are not Go and REST. Pinned so the name fix cannot leak into the posting matcher.
test("keywordAppearsIn keeps the exact() rule in prose: Go and REST are not credited by English words", () => {
  // The canonical term over prose: case-sensitive as before.
  assert.equal(keywordAppearsIn("Go", "we go to market fast"), false);
  assert.equal(keywordAppearsIn("REST", "the rest of the team"), false);
  // A lowercase keyword over prose behaves exactly as before 2026-11-21 (the escaped, case-insensitive fallback).
  assert.equal(keywordAppearsIn("azure", "deploy on azure"), true);
  // And the capitalised technology is still found.
  assert.equal(keywordAppearsIn("Azure", "deploy on Azure"), true);
});

// AI_VOCABULARY_TERMS (2026-11-10, T13) is a second list beside the vocabulary; this keeps it from drifting. Each term must
// be one the extractor really emits, or shapeSkillGroups would wait for a term that can never arrive.
test("AI_VOCABULARY_TERMS: every AI term is a vocabulary term the extractor emits", () => {
  // Non-vacuity: all five AI terms are listed.
  assert.ok(AI_VOCABULARY_TERMS.size >= 5, `expected the 5 AI terms, got ${AI_VOCABULARY_TERMS.size}`);
  // Each term, written into a posting the way a recruiter would, comes back from the extractor under its own name.
  for (const term of AI_VOCABULARY_TERMS) assert.ok(extractJdKeywords(`Experience with ${term} required.`).includes(term), `${term} is not emitted`);
});

// ---- 2026-11-21, tailor #5 parcel 2 (plan §5 P3): aliases, new terms, vague terms out, requirement tiers ----

test("aliases: JS and TS credit JavaScript and TypeScript, never the .js inside Node.js / Next.js / React.js", () => {
  // The short forms recruiters write.
  assert.equal(keywordAppearsIn("JavaScript", "Strong JS fundamentals"), true);
  // TS, often beside Node.
  assert.equal(keywordAppearsIn("TypeScript", "TS/Node services"), true);
  // The trap: a ".js" suffix is the framework's name, not a JavaScript requirement.
  assert.equal(keywordAppearsIn("JavaScript", "Built with Node.js, Next.js and React.js"), false);
  // And the master spelling maps to the term, so a skill named "JS" is JavaScript.
  assert.equal(canonicalSkillTerm("JS"), "JavaScript");
  // k8s already credits Kubernetes (kept, pinned here beside the new aliases).
  assert.equal(keywordAppearsIn("Kubernetes", "deploy on k8s"), true);
});

test("new terms: Next.js, Postman, Git and Jest are extracted; Git is not found inside GitHub", () => {
  // Each new term in one posting.
  assert.deepEqual(extractJdKeywords("Next.js frontend, Jest tests, API checks in Postman, version control with Git."), ["APIs", "Git", "Jest", "Next.js", "Postman"]);
  // GitHub is not Git (word-bounded).
  assert.equal(extractJdKeywords("Host the code on GitHub.").includes("Git"), false);
});

test("vague terms are out: messaging/queues, profiling, concurrency and on-call extract nothing; APIs stays (restored 14:52)", () => {
  // Soft practice words that matched almost every posting and named no skill a resume can show.
  assert.deepEqual(extractJdKeywords("Build messaging queues, profiling, concurrency, on-call rotation."), []);
  // APIs was restored to the vocabulary (orch, 2026-11-21 14:52).
  assert.deepEqual(extractJdKeywords("Build APIs."), ["APIs"]);
});

// A posting with the usual sections; each skill sits in exactly one of them.
const TIERED = [
  "About the role",
  "You will build services with Docker.",
  "Requirements:",
  "- Strong Python and SQL",
  "- Experience with PostgreSQL",
  "Nice to have:",
  "- Kubernetes",
  "- Redis is a plus",
].join("\n");

test("tiers: a skill under Requirements is required, under Nice to have is preferred, elsewhere mentioned, absent null", () => {
  // The posting's sentences, classified once.
  const jd = classifyJd(TIERED);
  // Under the Requirements heading.
  assert.equal(jdTierOf(["Python"], jd), "required");
  // Also required.
  assert.equal(jdTierOf(["PostgreSQL"], jd), "required");
  // Under Nice to have.
  assert.equal(jdTierOf(["Kubernetes"], jd), "preferred");
  // In the "about the role" prose: mentioned, the weakest present tier.
  assert.equal(jdTierOf(["Docker"], jd), "mentioned");
  // Not in the posting at all.
  assert.equal(jdTierOf(["Java"], jd), null);
  // Alias phrases count: any phrase that matches gives the tier.
  assert.equal(jdTierOf(["Postgres", "PostgreSQL"], jd), "required");
});

test("tiers: an inline 'a plus' / 'preferred' marks its own sentence preferred, even inside Requirements", () => {
  // One required line, one inline-preferred line, under the same heading.
  const jd = classifyJd("Requirements:\n- Java\n- Experience with Kafka is a plus");
  // The plain requirement.
  assert.equal(jdTierOf(["Java"], jd), "required");
  // The inline marker wins for its own sentence.
  assert.equal(jdTierOf(["Kafka"], jd), "preferred");
});

test("tiers: the BEST tier wins when a skill appears in several sections", () => {
  // Docker in the prose and in the requirements.
  const jd = classifyJd("We use Docker everywhere.\nRequirements:\n- Docker");
  // Required beats mentioned.
  assert.equal(jdTierOf(["Docker"], jd), "required");
});

test("tiers: the weights rank required > preferred > mentioned", () => {
  // Strictly ordered, so a sort by weight is the ruling's order.
  assert.ok(JD_TIER_WEIGHT.required > JD_TIER_WEIGHT.preferred && JD_TIER_WEIGHT.preferred > JD_TIER_WEIGHT.mentioned && JD_TIER_WEIGHT.mentioned > 0);
});
