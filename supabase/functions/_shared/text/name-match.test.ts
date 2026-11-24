// The shared "did the owner name this?" matcher (2026-11-21), moved out of resume-assist so the web reads names the
// same way. These pin the cases both sides depend on: the live typo, the whole-run rule, and the short-name strictness.
import { describe, it } from "node:test";
// Strict comparisons.
import assert from "node:assert/strict";
// The unit under test.
import { compactName, namedIn, sameName, withinOneEdit, withinTwoEdits } from "./name-match.ts";

describe("namedIn", () => {
  it("reads Teja's live typo 'rm  vs cod e' as naming VS Code (the run compacts to 'vscode')", () => {
    // The 2026-11-21 09:05 message.
    assert.equal(namedIn("VS Code", ["rm  vs cod e"]), true);
  });

  it("forgives one typo on 6+ letters and two (a swap is one) on 8+, never on a short name", () => {
    // One typo, 10 letters.
    assert.equal(namedIn("TypeScript", ["remove typescrit"]), true);
    // A substitution plus a swap, 10 letters (the 2026-11-11 case).
    assert.equal(namedIn("Typography", ["type grpahy"]), true);
    // Short names are exact: one edit from "Go" is not "Go".
    assert.equal(namedIn("Go", ["rm gp"]), false);
    // Exact short name.
    assert.equal(namedIn("Go", ["rm go"]), true);
  });

  it("matches whole runs only, never a substring, and nothing in a text that does not say it", () => {
    // "os" inside "cost".
    assert.equal(namedIn("OS", ["cut the cost line"]), false);
    // Three edits away.
    assert.equal(namedIn("Code review", ["remove the code reviewing skill"]), false);
    // Any of several texts may name it (the owner's earlier turns).
    assert.equal(namedIn("Kafka", ["add tools", "and kafka too"]), true);
    // A name of pure punctuation is never named.
    assert.equal(namedIn("--", ["--"]), false);
  });

  it("the moved helpers behave as before", () => {
    // + and # survive, so C++ is not C.
    assert.equal(compactName("C++ / C#"), "c++c#");
    // One substitution.
    assert.equal(withinOneEdit("anguarjs", "angularjs"), true);
    // Two apart in length.
    assert.equal(withinOneEdit("ab", "abcd"), false);
    // A swap plus a substitution is two.
    assert.equal(withinTwoEdits("typegrpahy", "typography"), true);
  });
});

describe("sameName", () => {
  it("matches a skill name across spacing, case and namedIn's typo budget (6+: one edit, 8+: two)", () => {
    // The live ask's own words: "harness eng" is not the name, but "harness engineering" with a typo is.
    assert.equal(sameName("harnes engineering", "Harness Engineering"), true);
    // Spacing and case never matter: both compact to "llmslmapiintegration".
    assert.equal(sameName("llm/slm api integration", "LLM/SLM API Integration"), true);
    // A swap plus a substitution on an 8+ name is within two.
    assert.equal(sameName("typogarphy", "Typography"), true);
  });

  it("is exact on short names and never matches an empty target", () => {
    // Group "AI" is 2 letters: one edit away is a different group.
    assert.equal(sameName("Al", "AI"), false);
    // Exact short name still matches.
    assert.equal(sameName("ai", "AI"), true);
    // Pure punctuation compacts to nothing: never a name.
    assert.equal(sameName("", "--"), false);
  });
});
