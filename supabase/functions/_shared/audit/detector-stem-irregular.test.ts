// ============================================================================
// SUMMARY GROUNDING: HONEST-VERB FALSE POSITIVES (r5 of S34), 2026-11-24
// ============================================================================
//
// r4 grounded the tailored summary's words against the whole pinned master. On the 31 live
// awaiting_approval rows it flagged honest verbs: "writes" (master says "Wrote"), "cutting" (master
// says "Reduced"), "troubleshoots" (master says "debugged"), "applies" (only an UNPICKED variant says
// "Applied"), "product-facing" (no master word). Only "writes" is an inflection gap (an irregular past);
// the other four are neutral verbs/framing with no master form, so they go on the closed summary list.
// The inventions the check exists for ("pytorch", "researcher", "software", "robust") must still flag.
// Run: node --test "_shared/audit/*.test.ts" from supabase/functions.
// ============================================================================

// node:test, the runner the rest of this folder uses.
import { test } from "node:test";
// Strict assertions, so a wrong word list fails on deep equality.
import assert from "node:assert/strict";
// The auditor entry point and the shared stemmer under test.
import { detectAuditFindings, stemToken } from "./detector.ts";
// Contract types for the minimal fixtures below.
import type { AuditFinding, MasterProfile, ResolvedResume, TailoredProfile } from "../contracts/shared-types.ts";

// Live master v52 bullet texts (verbatim), each holding the master form of one honest verb.
const TESTS = "Wrote 92 pytest tests in 14 classes that gate every push through GitHub Actions CI.";
// "Reduced" is the master's word for what the tailor calls "cutting".
const DB_INDEXING = "Reduced PostgreSQL query latency by 20% by adding indexes on frequently queried columns in Aczen's database layer.";
// "debugged" is the master's word for what the tailor calls "troubleshoots".
const DOCS = "Documented 50+ REST endpoints in Swagger/OpenAPI and debugged API, database and real-time issues.";
// A plain "Built" bullet, for the irregular-past check on the other side.
const AGENTS = "Built multi-step AI agents that automate repetitive manual workflows across lead enrichment, accounting assistance, customer engagement and social media.";

// A trimmed master: one entry with the four bullets, a skill subset WITHOUT PyTorch, and no "software" anywhere.
function master(): MasterProfile {
  // Cast through unknown: only the fields the detector reads are filled.
  return {
    // Contract version.
    schema_version: 1,
    // Identity is not read by the detector.
    identity: { full_name: "T", headline: "", email: "t@example.com", phone: null, location: "", links: [] },
    // A default summary with no honest-verb forms, so only the bullets can ground them.
    summary: { id: "summary_main", text: "Computer Science undergraduate with industry experience as an AI Engineer Intern." },
    // No variants: an unpicked variant must never vouch anyway.
    summary_variants: [],
    // The internship holding every master form the tests rely on.
    experience: [{ id: "exp_aczen", company: "Aczen Technologies", role: "AI Engineer Intern", start_display: "Mar 2026", end_display: "Present", bullets: [{ id: "b_tests", text: TESTS }, { id: "b_db", text: DB_INDEXING }, { id: "b_docs", text: DOCS }, { id: "b_agents", text: AGENTS }] }],
    // The rest empty.
    projects: [], education: [], achievements: [], certifications: [],
    // Skill names ground words too; deliberately no PyTorch, no "software".
    skills: ["Python", "FastAPI", "Machine learning", "PostgreSQL", "Docker", "Node.js", "Data Science"].map((name, i) => ({ id: `skill_${i}`, name, category: "x" })),
  } as unknown as MasterProfile;
}

// A resume that is only a summary: every finding then comes from the summary checks.
function resume(summary: string): ResolvedResume {
  // Cast through unknown: only the fields the detector reads are filled.
  return { summary, skills: [], experience: [], projects: [], education: [], achievements: [], certifications: [] } as unknown as ResolvedResume;
}

// The raw tailor refs for that summary, citing real bullets so the ref checks stay quiet.
function refs(text: string): TailoredProfile {
  // Cast through unknown: the minimal shape the detector reads.
  return {
    // Contract version.
    schema_version: 1,
    // The summary cites all four bullets, as a live summary cites 2-5.
    summary: { text, refs: ["b_tests", "b_db", "b_docs", "b_agents"] },
    // Default headline.
    summary_variant: null,
    // The rest empty.
    experience: [], projects: [], education: [], achievements: [], certifications: [], skills: [],
  } as unknown as TailoredProfile;
}

// The words the summary grounding names for `text`; [] when it raises no finding.
function summaryWords(text: string): string[] {
  // Audit the summary-only resume.
  const findings: readonly AuditFinding[] = detectAuditFindings(master(), resume(text), refs(text));
  // Matched by the reason prefix the summary grounding writes.
  const f = findings.find((x) => x.reason.startsWith("Summary contains ungrounded term")) as (AuditFinding & { words?: string[] }) | undefined;
  // No finding means nothing ungrounded.
  return f?.words ?? [];
}

// --- the stemmer: irregular pasts meet their present forms ------------------------------

// Each pair is a master form and a tailored form that must stem the same.
test("r5 stemToken irregulars: wrote/writes, built/builds, led/leading, taught/teaches, made/making, ran/running", () => {
  // Master past (irregular) beside the tailor's present or -ing form.
  for (const [past, present] of [["wrote", "writes"], ["written", "writing"], ["built", "builds"], ["led", "leading"], ["taught", "teaches"], ["made", "making"], ["ran", "running"]]) {
    // Same stem, or the master's irregular past cannot ground the tailor's present.
    assert.equal(stemToken(past), stemToken(present), `${past} vs ${present}`);
  }
});

// The map must not merge unrelated words: a regular verb keeps its own stem.
test("r5 stemToken control: an unmapped word keeps its r4 stem (gating -> gat, queries -> query)", () => {
  // r4's own example, unchanged.
  assert.equal(stemToken("gating"), "gat");
  // The -ies plural rule r4 already had.
  assert.equal(stemToken("queries"), "query");
});

// --- the five live honest-verb false positives -----------------------------------------

// Live row a06fd6b8: "Writes tested Python services" against master "Wrote 92 pytest tests".
test("r5 honest verb 'writes' grounds against master 'Wrote' (irregular past)", () => {
  // The live sentence, trimmed to grounded words.
  assert.deepEqual(summaryWords("AI Engineer Intern who writes Python tests gating every push through GitHub Actions CI."), []);
});

// Live rows 83078b88, 2dd68caa: "cutting PostgreSQL query latency by 20%" against master "Reduced ... by 20%".
test("r5 honest verb 'cutting' does not flag (summary framing verb; master says 'Reduced')", () => {
  // The live clause, verbatim.
  assert.deepEqual(summaryWords("Added indexes on frequently queried columns, cutting PostgreSQL query latency by 20%."), []);
});

// Live row 83078b88: "builds and troubleshoots backend services" against master "debugged API ... issues".
test("r5 honest verb 'troubleshoots' does not flag (summary framing verb; master says 'debugged')", () => {
  // Grounded words around the verb.
  assert.deepEqual(summaryWords("AI Engineer Intern who troubleshoots API and database issues with Python and PostgreSQL."), []);
});

// Live row a323b808: "Applies data science to research data"; only an unpicked variant says "Applied".
test("r5 honest verb 'applies' does not flag (summary framing verb)", () => {
  // Grounded words around the verb.
  assert.deepEqual(summaryWords("AI Engineer Intern who applies machine learning with Python and FastAPI."), []);
});

// Live row f241448f: "ships product-facing features"; the tokenizer splits it into "product" + "facing".
test("r5 honest compound 'product-facing' does not flag (both parts on the summary framing list)", () => {
  // Grounded words around the compound.
  assert.deepEqual(summaryWords("AI Engineer Intern who built product-facing features with Node.js and PostgreSQL."), []);
});

// --- the inventions still flag ------------------------------------------------------------

// The four words the check exists for, each in an otherwise grounded sentence.
test("r5 still flagged: pytorch, researcher, software (master lacks it), robust", () => {
  // Each word alone, so one cannot hide behind another's finding.
  for (const word of ["PyTorch", "researcher", "software", "robust"]) {
    // A grounded sentence carrying exactly one invention.
    const words = summaryWords(`AI Engineer Intern who built ${word} agents with Python.`);
    // The invention is named, lowercase as tokenized.
    assert.deepEqual(words, [word.toLowerCase()], word);
  }
});

// The postmortem's real fabricated summary (live row cac40516), verbatim.
const HACKERRANK = "Applied AI Researcher and Engineer with extensive experience in developing LLM applications, RAG pipelines, multi-agent AI systems, and end-to-end machine learning models. Proficient in PyTorch ecosystem methodologies, fine-tuning workflows, and optimizing inference pipelines using Python, FastAPI, and cloud infrastructure.";

// r5 widened grounding; the S34 incident must still be caught.
test("r5 cac40516 fabricated summary still flagged with pytorch and researcher", () => {
  // Its words under this master.
  const words = summaryWords(HACKERRANK);
  // Both inventions the postmortem names.
  assert.ok(words.includes("pytorch") && words.includes("researcher"), JSON.stringify(words));
});

// ============================================================================
// DERIVATION (orch re-gate 2026-11-24): the web approve re-check ran the summary check on the anonymised
// live GitLab row and flagged "integration", "automated", "scaling", whose master forms are "Integrated",
// "automation", "scalable". Same word, another part of speech, so each pair must meet on one stem.
// ============================================================================

// Each pair meets on one stem; a red here means the derivation step is gone.
test("derivation: integration/Integrated, automated/automation, scaling/scalable meet on one stem", () => {
  // The three pairs from the approve re-check fixture, tailored form first.
  const pairs: [string, string][] = [["integration", "integrated"], ["automated", "automation"], ["scaling", "scalable"], ["integrations", "integrate"]];
  // Every pair compared on the shared stemmer.
  for (const [tailored, masterForm] of pairs) assert.equal(stemToken(tailored), stemToken(masterForm), `${tailored} vs ${masterForm}`);
});

// The length floors keep short words whole, so derivation never merges unrelated words.
test("derivation floors: action, table, capable keep their own stems", () => {
  // "action" would become "act" without the floor and meet "acted".
  assert.notEqual(stemToken("action"), stemToken("acted"));
  // "table" and "capable" are too short to lose "-able".
  assert.equal(stemToken("table"), "tabl");
  // "capable" stays distinct from "cap".
  assert.notEqual(stemToken("capable"), stemToken("cap"));
});

// End to end: the derived honest words ground; an invention in the same summary still flags.
test("derivation in the summary check: honest derived words pass, 'architectures' still flags", () => {
  // A master bullet carrying the three master forms.
  const m = master();
  // Swap one bullet's text for the master forms (cast: the fixture is a plain object).
  (m as unknown as { experience: { bullets: { text: string }[] }[] }).experience[0]!.bullets[3]!.text =
    "Integrated Gemini API and designed scalable containerized services for workflow automation.";
  // The tailored summary in the fixture's words, plus one word no master node has.
  const text = "Integration of Gemini API, scaling containerized services and automated workflows across architectures.";
  // Same call shape as summaryWords above, with the edited master.
  const f = detectAuditFindings(m, resume(text), refs(text)).find((x) => x.reason.startsWith("Summary contains ungrounded term"));
  // The flagged words, or none when nothing is ungrounded.
  const words = (f as (AuditFinding & { words?: string[] }) | undefined)?.words ?? [];
  // None of the three derived honest words is flagged.
  for (const honest of ["integration", "scaling", "automated"]) assert.ok(!words.includes(honest), JSON.stringify(words));
  // The invention still is.
  assert.ok(words.includes("architectures"), JSON.stringify(words));
});
