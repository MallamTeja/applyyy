// ============================================================================
// RULE 5 OVER A BULLET'S SOURCES (S43) + SUMMARY PROSE GROUNDING (S34), 2026-11-24
// ============================================================================
//
// S43: an AI-written bullet lists in `sources` every master bullet it draws on. Rule 5 grounded only
// against the `ref` bullet, so an honest merge of two siblings was flagged for the second one's words.
// S34: live row cac40516 (HackerRank, postmortem docs/audit/2026-11-23-rejection-postmortem.md) printed
// "Applied AI Researcher ... Proficient in PyTorch" with zero findings; nothing grounded summary words.
// Fixture texts are the live master v52 texts of the named nodes.
// Run: node --test "_shared/audit/*.test.ts" from supabase/functions.
// ============================================================================

// node:test, the runner the rest of this folder uses.
import { test } from "node:test";
// Strict assertions, so a wrong word list fails on deep equality.
import assert from "node:assert/strict";
// The auditor entry point under test.
import { detectAuditFindings } from "./detector.ts";
// Contract types for the minimal fixtures below.
import type { AuditFinding, MasterProfile, ResolvedResume, TailoredProfile } from "../contracts/shared-types.ts";

// Live master v52 texts of the bullets the fixtures use.
const RAG = "Integrated LLM APIs with RAG pipelines into Aczen Bliz, answering financial and business questions over 43 indexed documents.";
// Sibling of RAG under the same experience entry.
const AGENTS = "Built multi-step AI agents that automate repetitive manual workflows across lead enrichment, accounting assistance, customer engagement and social media.";
// A third sibling, cited by the honest summary.
const DB_INDEXING = "Reduced PostgreSQL query latency by 20% by adding indexes on frequently queried columns in Aczen's database layer.";
// A bullet under a DIFFERENT parent (a project), for the cross-parent rule.
const DEVOPS = "Deployed the frontend on Vercel and the backend on AWS EC2 through GitHub Actions CI/CD, including blockchain-based certificate verification.";

// A trimmed master v52: the default summary, two entries and a skill subset (skill tokens ground words too).
function master(): MasterProfile {
  // Cast through unknown: only the fields the detector reads are filled.
  return {
    // Contract version.
    schema_version: 1,
    // Identity is not read by the detector.
    identity: { full_name: "T", headline: "", email: "t@example.com", phone: null, location: "", links: [] },
    // The live v52 default summary, verbatim: the owner's own prose is part of the summary corpus.
    summary: { id: "summary_main", text: "Computer Science undergraduate specializing in Data Science with industry experience as a Full Stack AI Engineer Intern. Experienced in building LLM-powered applications, RAG systems, AI agents, agentic workflows, and AI-driven automation for fintech and business applications. Proficient in Python, SQL, FastAPI, PostgreSQL, pgvector, JavaScript, Node.js, Docker, Google Cloud Platform, prompt engineering, context engineering, and AI orchestration." },
    // No variants: the default summary is the printed headline.
    summary_variants: [],
    // The internship with three sibling bullets.
    experience: [{ id: "exp_aczen", company: "Aczen Technologies", role: "Full Stack AI Engineer Intern", start_display: "Mar 2026", end_display: "Present", bullets: [{ id: "b_rag", text: RAG }, { id: "b_agents", text: AGENTS }, { id: "b_db", text: DB_INDEXING }] }],
    // One project with the cross-parent bullet.
    projects: [{ id: "proj_one", name: "One-on-One", bullets: [{ id: "b_devops", text: DEVOPS }] }],
    // The rest empty.
    education: [], achievements: [], certifications: [],
    // A v52 skill subset; none of them PyTorch, Kubernetes or Vercel.
    skills: ["Python", "FastAPI", "RAG Pipelines", "AI Agents & Workflows", "Machine learning", "PostgreSQL", "AWS", "CI/CD & GitHub Actions", "Docker", "Node.js", "LLM/SLM API Integration", "Multi-Agent Systems"].map((name, i) => ({ id: `skill_${i}`, name, category: "x" })),
  } as unknown as MasterProfile;
}

// A resume with one experience bullet under exp_aczen and an optional summary.
function resume(bulletText: string | null, summary: string | null = null): ResolvedResume {
  // Cast through unknown: only the fields the detector reads are filled.
  return {
    // The printed summary, or none.
    summary,
    // No skills section, so no skill findings.
    skills: [],
    // The bullet, rendered under its true parent; no bullet means no experience section.
    experience: bulletText === null ? [] : [{ ref: "exp_aczen", company: "Aczen Technologies", role: "Full Stack AI Engineer Intern", bullets: [{ ref: "b_rag", text: bulletText, master_text: RAG }] }],
    // The rest empty.
    projects: [], education: [], achievements: [], certifications: [],
  } as unknown as ResolvedResume;
}

// The raw tailor refs: the same bullet with the given `sources` value (held as-is, malformed included) and a summary.
function refs(bulletText: string | null, sources: unknown, summary: { text: string; refs: string[] } | null = null): TailoredProfile {
  // Cast through unknown: `sources` is deliberately any shape here, to test the shape checks.
  return {
    // Contract version.
    schema_version: 1,
    // The summary and its refs, or none.
    summary,
    // Default headline.
    summary_variant: null,
    // The one bullet; `sources` omitted entirely when undefined, like a pre-tailor-#5 row.
    experience: bulletText === null ? [] : [{ ref: "exp_aczen", bullets: [{ ref: "b_rag", text: bulletText, ...(sources === undefined ? {} : { sources }) }] }],
    // The rest empty.
    projects: [], education: [], achievements: [], certifications: [], skills: [],
  } as unknown as TailoredProfile;
}

// Rule 5's ungrounded-term finding for the bullet, if any.
function termFinding(findings: readonly AuditFinding[]): (AuditFinding & { words?: unknown }) | undefined {
  // Matched by the reason prefix rule 5 writes.
  return findings.find((f) => f.reason.startsWith("Bullet text contains ungrounded term"));
}

// The S34 summary finding, if any.
function summaryTerms(findings: readonly AuditFinding[]): (AuditFinding & { words?: unknown }) | undefined {
  // Matched by the reason prefix the summary grounding writes.
  return findings.find((f) => f.reason.startsWith("Summary contains ungrounded term"));
}

// An honest merge of b_rag and b_agents: every word is in one of the two.
const MERGED = "Integrated LLM APIs with RAG pipelines into Aczen Bliz and built multi-step AI agents that automate manual workflows across lead enrichment.";

// --- S43 ------------------------------------------------------------------------------

// THE FIX: both sources listed, so the second sibling's words ground.
test("S43 sibling merge: a bullet built from 2 listed sibling sources gives no ungrounded-term finding", () => {
  // Audit the merge with both sources declared.
  const findings = detectAuditFindings(master(), resume(MERGED), refs(MERGED, ["b_rag", "b_agents"]));
  // No rule-5 term finding.
  assert.equal(termFinding(findings), undefined, JSON.stringify(findings));
});

// Control: only the ref listed, so the second sibling's words stay ungrounded.
test("S43 control: the same merge with only its ref in sources is still flagged", () => {
  // Audit with sources = [ref] only.
  const findings = detectAuditFindings(master(), resume(MERGED), refs(MERGED, ["b_rag"]));
  // The term finding exists.
  const f = termFinding(findings);
  // Present.
  assert.ok(f, JSON.stringify(findings));
  // Names the agents bullet's words.
  assert.deepEqual(f.words, ["step", "automate", "manual", "lead", "enrichment"]);
});

// An invention survives the wider corpus.
test("S43 invention: Kubernetes in no source is still flagged with both sources listed", () => {
  // The honest merge plus one invented technology.
  const text = MERGED.replace("AI agents", "AI agents on Kubernetes");
  // Audit with both sources.
  const findings = detectAuditFindings(master(), resume(text), refs(text, ["b_rag", "b_agents"]));
  // Exactly the invented word.
  assert.deepEqual(termFinding(findings)?.words, ["kubernetes"]);
});

// Fail closed: an id the master lacks widens nothing and is reported.
test("S43 unknown source id: no widening, plus an unresolved_ref finding naming it", () => {
  // The merge, citing a ghost id instead of the real sibling.
  const findings = detectAuditFindings(master(), resume(MERGED), refs(MERGED, ["b_rag", "b_ghost"]));
  // The sibling's words are still ungrounded.
  assert.deepEqual(termFinding(findings)?.words, ["step", "automate", "manual", "lead", "enrichment"]);
  // And the ghost id is reported under the existing kind.
  assert.ok(findings.some((f) => f.kind === "unresolved_ref" && f.reason.includes('"b_ghost"')), JSON.stringify(findings));
});

// A real bullet under another parent does not vouch.
test("S43 cross-parent source: a project bullet listed as a source does not ground an experience bullet", () => {
  // The RAG text plus a word only the project bullet has.
  const text = "Integrated LLM APIs with RAG pipelines into Aczen Bliz on Vercel.";
  // Audit with the project bullet as a source.
  const findings = detectAuditFindings(master(), resume(text), refs(text, ["b_rag", "b_devops"]));
  // "vercel" stays ungrounded.
  assert.deepEqual(termFinding(findings)?.words, ["vercel"]);
});

// Malformed shape: a bare string instead of a list is "no sources".
test("S43 malformed sources (a string, not a list): falls back to ref-only grounding", () => {
  // The merge with sources as a bare id string.
  const findings = detectAuditFindings(master(), resume(MERGED), refs(MERGED, "b_agents"));
  // Same as the control: the sibling's words flag.
  assert.deepEqual(termFinding(findings)?.words, ["step", "automate", "manual", "lead", "enrichment"]);
});

// --- S34 ------------------------------------------------------------------------------

// The postmortem's real fabricated summary (live row cac40516), verbatim.
const HACKERRANK = "Applied AI Researcher and Engineer with extensive experience in developing LLM applications, RAG pipelines, multi-agent AI systems, and end-to-end machine learning models. Proficient in PyTorch ecosystem methodologies, fine-tuning workflows, and optimizing inference pipelines using Python, FastAPI, and cloud infrastructure.";

// THE FIX: the invented role noun and framework are named.
test("S34 fabricated summary: the cac40516 summary is flagged summary_unsupported with words incl. pytorch and researcher", () => {
  // Cited refs as the live row had them: skills only.
  const findings = detectAuditFindings(master(), resume(null, HACKERRANK), refs(null, undefined, { text: HACKERRANK, refs: ["skill_0", "skill_1", "skill_2"] }));
  // The summary words finding.
  const f = summaryTerms(findings);
  // Present, under the summary's own kind and path.
  assert.ok(f, JSON.stringify(findings));
  // The summary kind enums.ts defines for unsupported prose.
  assert.equal(f.kind, "summary_unsupported");
  // At the path the review page keys the summary line by.
  assert.equal(f.path, "summary");
  // The words, as data.
  const words = f.words as string[];
  // Both inventions the postmortem names.
  assert.ok(words.includes("pytorch") && words.includes("researcher"), JSON.stringify(words));
  // Claim stays the whole summary, as every summary finding has it.
  assert.equal(f.claim, HACKERRANK);
});

// Control: a live honest summary (row 337ed4a4) built from master wording.
test("S34 honest summary: a summary built from master wording gives no summary word finding", () => {
  // Live row 337ed4a4's summary, verbatim.
  const text = "Developed backend services and deployed applications on AWS EC2 through GitHub Actions CI/CD. Reduced PostgreSQL query latency by 20% by adding indexes on frequently queried columns.";
  // Audit with its live refs.
  const findings = detectAuditFindings(master(), resume(null, text), refs(null, undefined, { text, refs: ["b_devops", "b_db"] }));
  // No summary finding of any kind.
  assert.equal(findings.filter((f) => f.path === "summary").length, 0, JSON.stringify(findings));
});

// A summary sentence about a person ("intern WHO built") is framing, not a claim.
test("S34 framing: 'who' in an honest summary does not flag (SUMMARY_FRAMING_WORDS)", () => {
  // Grounded words joined by a relative pronoun.
  const text = "AI Engineer Intern who built multi-step AI agents and integrated LLM APIs with RAG pipelines.";
  // Audit with real refs.
  const findings = detectAuditFindings(master(), resume(null, text), refs(null, undefined, { text, refs: ["b_rag", "b_agents"] }));
  // No summary words finding.
  assert.equal(summaryTerms(findings), undefined, JSON.stringify(findings));
});

// No refs: the existing zero-refs finding only, unchanged.
test("S34 summary with no refs: only the existing zero-references finding, no word finding", () => {
  // The fabricated summary, citing nothing.
  const findings = detectAuditFindings(master(), resume(null, HACKERRANK), refs(null, undefined, { text: HACKERRANK, refs: [] }));
  // The pre-existing finding is there.
  assert.ok(findings.some((f) => f.reason === "Summary paragraph declares zero supporting master references"), JSON.stringify(findings));
  // The new check stays out of it.
  assert.equal(summaryTerms(findings), undefined);
});
