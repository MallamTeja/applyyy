// ============================================================================
// RULE 5 INFLECTION TOLERANCE + FLAGGED WORDS AS DATA (2026-11-23)
// ============================================================================
//
// Live row 957991ec (master v51) carried 10 grounding findings, 8 of them false: the tailor
// re-inflected a master word ("automate" -> "automating", "gating" -> "gate") and rule 5 compared
// tokens character for character, so an honest rewording read as an invented claim.
// These tests pin the fix: both sides are stemmed lightly, so an inflection of a master word passes,
// while a synonym and an invented technology still flag. Each fixture is the live master text and
// the live tailored text of one bullet, copied from that row.
// Run: node --test "_shared/audit/*.test.ts" from supabase/functions.
// ============================================================================

// node:test, the runner the rest of this folder uses.
import { test } from "node:test";
// Strict assertions, so a wrong word list fails on deep equality, not a loose match.
import assert from "node:assert/strict";
// The shared rule-5 function, the stemmer and the auditor entry point under test.
import { bulletGroundingGaps, detectAuditFindings, stemToken, tokenizeText } from "./detector.ts";
// Contract types for the minimal master and resume fixtures below.
import type { MasterProfile, ResolvedResume } from "../contracts/shared-types.ts";

// The live master v51 skill names, verbatim: skill tokens are a grounding source, so a fixture
// without them would flag words ("rate", "workflows") the real audit never flags.
const V51_SKILLS = [
  // The AI engineering group.
  "Harness Engineering", "RAG Pipelines", "Prompt Engineering", "Context Engineering", "AI Agents & Workflows", "Tool Calling", "Guardrails",
  // Languages, frameworks and stores.
  "Python", "SQL", "JavaScript", "TypeScript", "FastAPI", "Node.js", "React.js", "LangChain", "PostgreSQL", "pgvector", "Redis", "Docker",
  // Cloud, delivery and review.
  "Google Cloud Platform", "AWS", "Microsoft Azure", "CI/CD & GitHub Actions", "Code review", "MySQL", "Monitoring", "DBMS",
  // ML group.
  "Ensemble Learning", "XGBoost", "Gradient Boosting", "LightGBM", "Feature Engineering", "SHAP", "Scikit-learn", "Pandas", "NumPy",
  // LLM plumbing.
  "LLM/SLM API Integration", "Vector Search", "Multi-Agent Systems", "Prompt Injection Protection", "Context Validation", "Prompt Builders",
  // More LLM plumbing and backend fundamentals.
  "Context Builders", "Prompt Caching", "Token Cost Optimization", "Quantization", "REST APIs", "System Design (LLD/HLD)", "OOP", "DSA",
  // CS fundamentals and API concerns.
  "Operating Systems", "Computer Networks", "Rate Limiting", "Idempotency", "Caching", "Supabase", "MongoDB", "Postman", "Swagger/OpenAPI",
  // Tooling and testing.
  "JUnit", "pytest", "Git", "GitHub", "Cursor", "Claude Code", "Jira", "Testing", "Machine learning", "C", "Python Scripting",
  // Testing kinds and docs.
  "Integration Testing", "API Testing", "Unit Testing", "Technical Documentation", "Playwright Testing", "Observability", "HTML", "CSS",
  // Data analysis.
  "Matplotlib", "Seaborn", "Power BI", "R", "Tableau", "Excel", "Jupyter", "EDA", "Data Visualization", "SQL Analytics", "TensorFlow",
  // The rest of the list.
  "Data Cleaning", "Kaggle", "Google Colab", "Java", "MCP Integrations", "Spark", "gRPC", "Express.js", "YAML Flows", "C#", "Linux",
  // Backend frameworks.
  "Microservices", "Spring", "Spring Boot",
];

// The skill tokens exactly as buildMasterIndex builds them (tokenizeText over every name).
const SKILL_TOKENS: ReadonlySet<string> = new Set(V51_SKILLS.flatMap((name) => tokenizeText(name)));

// The ungrounded words rule 5 reports for one live bullet, in the auditor's own call shape.
function termsFor(tailored: string, master: string): readonly string[] {
  // Same arguments the auditor passes: tailored text, pinned master text, master skill tokens.
  return bulletGroundingGaps(tailored, master, SKILL_TOKENS).terms;
}

// --- The six inflection false positives: each must now pass -------------------------------

// "automating" is "automate" re-inflected.
test("inflection: bullet_aczen_agents 'automating' passes against master 'automate'", () => {
  // Live master and tailored text of bullet_aczen_agents.
  const terms = termsFor(
    // Tailored.
    "Engineered multi-step AI agents automating manual workflows across lead enrichment, accounting assistance, customer engagement, and social media.",
    // Master v51.
    "Built multi-step AI agents that automate repetitive manual workflows across lead enrichment, accounting assistance, customer engagement and social media.",
  );
  // Nothing left: every other word was already grounded.
  assert.deepEqual(terms, []);
});

// "body" is the singular of the master's "bodies"; "utilizing" is a neutral verb (allow-listed).
test("inflection: bullet_one1on1_backend 'body' passes against master 'bodies'", () => {
  // Live master and tailored text of bullet_one1on1_backend.
  const terms = termsFor(
    // Tailored.
    "Developed 50+ secure REST endpoints with PostgreSQL, JWT auth, WebRTC, and WebSockets, utilizing request body validation.",
    // Master v51.
    "Developed 50+ secure REST endpoints with PostgreSQL, JWT auth, WebRTC and WebSockets, with Bean Validation on request bodies.",
  );
  // "body" by stem; "utilizing" by the neutral-verb allowlist entry.
  assert.deepEqual(terms, []);
});

// "enforcing"/"tracking" are "enforces"/"tracks" re-inflected.
test("inflection: bullet_one1on1_gemini 'enforcing' and 'tracking' pass against 'enforces' and 'tracks'", () => {
  // Live master and tailored text of bullet_one1on1_gemini.
  const terms = termsFor(
    // Tailored.
    "Integrated Gemini API behind a key pool enforcing rate and token limits while tracking per-call token usage for cost control.",
    // Master v51.
    "Integrated the Gemini API behind a key pool that enforces per-key request and token-per-minute limits and tracks token usage per call to control cost.",
  );
  // Both verbs ground by stem; "rate" grounds on the skill "Rate Limiting".
  assert.deepEqual(terms, []);
});

// "layers", "workers", "gate", "pushes" are all inflections of master words.
test("inflection: bullet_applyy_testing 'layers', 'workers', 'gate', 'pushes' pass against 'layer', 'worker', 'gating', 'push'", () => {
  // Live master and tailored text of bullet_applyy_testing.
  const terms = termsFor(
    // Tailored.
    "Wrote 3,800+ automated tests across 303 files covering agents, Postgres safety layers, and Playwright workers to gate CI pushes.",
    // Master v51.
    "Wrote 3,800+ automated tests in 303 files covering the agents, the Postgres safety layer and the Playwright worker, gating every push in CI.",
  );
  // All four ground by stem ("gate" and "gating" both stem to "gat").
  assert.deepEqual(terms, []);
});

// "implementing" is a neutral framing verb, the -ing form of the allow-listed "implemented".
test("neutral verb: bullet_aczen_db_indexing 'implementing' passes via the allowlist", () => {
  // Live master and tailored text of bullet_aczen_db_indexing.
  const terms = termsFor(
    // Tailored.
    "Reduced PostgreSQL query latency by 20% by implementing indexes on frequently queried database columns.",
    // Master v51.
    "Reduced PostgreSQL query latency by 20% by adding indexes on frequently queried columns in Aczen's database layer.",
  );
  // The fact (indexes on queried columns, 20%) is the master's; the verb carries no claim.
  assert.deepEqual(terms, []);
});

// "covering" is a scope word like "across"/"spanning"; the listed domains are the master's own.
test("neutral verb: bullet_aczen_fintech 'covering' passes via the allowlist", () => {
  // Live master and tailored text of bullet_aczen_fintech.
  const terms = termsFor(
    // Tailored.
    "Built features for a fintech platform covering GST filing, banking, accounting, invoicing, and workflow automation for 100 businesses.",
    // Master v51.
    "Built features for a fintech platform spanning GST filing, banking, accounting, invoicing and workflow automation, used by 100 businesses.",
  );
  // Grounded once "covering" is allowed.
  assert.deepEqual(terms, []);
});

// --- What must STAY flagged: synonyms, paraphrases and real additions ----------------------

// "queries" vs "questions" is a synonym, not an inflection: no synonym table by design.
test("synonym stays flagged: bullet_aczen_rag 'queries' vs master 'questions'", () => {
  // Live master and tailored text of bullet_aczen_rag.
  const terms = termsFor(
    // Tailored.
    "Integrated LLM APIs with RAG pipelines into Aczen Bliz, answering financial and business queries across 43 indexed documents.",
    // Master v51.
    "Integrated LLM APIs with RAG pipelines into Aczen Bliz, answering financial and business questions over 43 indexed documents.",
  );
  // Only the synonym is left.
  assert.deepEqual(terms, ["queries"]);
});

// "grounded" paraphrases "limited to master-profile nodes"; a paraphrase is for Teja to judge.
test("paraphrase stays flagged: bullet_applyy_grounding 'grounded'", () => {
  // Live master and tailored text of bullet_applyy_grounding.
  const terms = termsFor(
    // Tailored.
    "Scouted 260+ ATS career boards across Greenhouse, Lever, Ashby, and Workday with a grounded tailor agent and auditor before human approval.",
    // Master v51.
    "Scouted 260+ ATS career boards across Greenhouse, Lever, Ashby and Workday; a tailor limited to master-profile nodes and an auditor block fabrication before human approval.",
  );
  // "agent" grounds on the skill "AI Agents" by stem; "grounded" does not ground anywhere.
  assert.deepEqual(terms, ["grounded"]);
});

// A real change: "maintaining query performance" is a new claim; "feeds"/"bookings"/"query" are inflections.
test("mixed: bullet_one1on1_indexing keeps 'maintaining' and 'performance', drops the inflections", () => {
  // Live master and tailored text of bullet_one1on1_indexing.
  const terms = termsFor(
    // Tailored.
    "Designed 40 PostgreSQL indexes, including partial and foreign-key indexes, maintaining query performance for feeds and bookings.",
    // Master v51.
    "Designed 40 PostgreSQL indexes, including partial and foreign-key indexes, to keep feed, booking and payment queries fast.",
  );
  // The claim words stay; "query", "feeds", "bookings" ground by stem.
  assert.deepEqual(terms, ["maintaining", "performance"]);
});

// "performance issues" is a new claim on a bullet that said "real-time issues".
test("mixed: bullet_one1on1_docs keeps 'performance'", () => {
  // Live master and tailored text of bullet_one1on1_docs.
  const terms = termsFor(
    // Tailored.
    "Documented 50+ REST endpoints in Swagger/OpenAPI and debugged API, database, and real-time system performance issues.",
    // Master v51.
    "Documented 50+ REST endpoints in Swagger/OpenAPI and debugged API, database and real-time issues.",
  );
  // "system" is allow-listed; "performance" is not in the master or skills.
  assert.deepEqual(terms, ["performance"]);
});

// --- The stemmer's own rules ---------------------------------------------------------------

// The exact pairs the orchestrator ruled must meet, plus guards that must NOT collapse.
test("stemToken: inflected pairs share a stem; short and numeric tokens are untouched", () => {
  // Each pair is [tailored form, master form] from the live row.
  const pairs: readonly [string, string][] = [["automating", "automate"], ["tracking", "tracks"], ["layers", "layer"], ["pushes", "push"], ["gate", "gating"], ["enforcing", "enforces"], ["body", "bodies"], ["queries", "query"], ["workers", "worker"]];
  // Both sides stemmed must be equal.
  for (const [a, b] of pairs) assert.equal(stemToken(a), stemToken(b), `${a} vs ${b}`);
  // Three letters or fewer stays as is, so "api"/"aws"/"go" never lose a letter.
  assert.equal(stemToken("aws"), "aws");
  // A token with a digit is a version or a metric, never stemmed.
  assert.equal(stemToken("es2020"), "es2020");
  // "ss", "us", "is" endings are not plurals.
  assert.deepEqual([stemToken("express"), stemToken("status"), stemToken("redis")], ["express", "status", "redis"]);
  // A synonym does not collapse into the master word.
  assert.notEqual(stemToken("queries"), stemToken("questions"));
});

// --- Real inventions stay flagged, with the words as data ----------------------------------

// A one-entry master with one bullet and two skills: just enough for detectAuditFindings.
function tinyMaster(): MasterProfile {
  // Cast through unknown: only the fields the detector reads are filled.
  return {
    // Contract version.
    schema_version: 1,
    // Identity is not read by rule 5.
    identity: { full_name: "T", headline: "", email: "t@example.com", phone: null, location: "", links: [] },
    // No summary, so the summary checks stay silent.
    summary: null,
    // One experience entry with one bullet.
    experience: [{ id: "exp-1", company: "Acme", role: "Engineer", start_display: "2024", end_display: "2025", bullets: [{ id: "b-1", text: "Deployed services with Docker on AWS." }] }],
    // The rest empty.
    projects: [], education: [], achievements: [], certifications: [],
    // Two skills, neither of them Kubernetes.
    skills: [{ id: "s-docker", name: "Docker" }, { id: "s-aws", name: "AWS" }],
  } as unknown as MasterProfile;
}

// The resume printing one bullet text under that entry.
function tinyResume(text: string): ResolvedResume {
  // Cast through unknown: only the fields the detector reads are filled.
  return {
    // No summary.
    summary: null,
    // No skills section, so no skill findings.
    skills: [],
    // The one entry, rendered under its true parent.
    experience: [{ ref: "exp-1", company: "Acme", role: "Engineer", bullets: [{ ref: "b-1", text }] }],
    // The rest empty.
    projects: [], education: [], achievements: [], certifications: [],
  } as unknown as ResolvedResume;
}

// THE INVENTION GUARD: stemming must not let a tech noun absent from master and skills through.
test("invention: a bullet adding Kubernetes stays an ungrounded-term finding with words ['kubernetes']", () => {
  // The master says Docker on AWS; the tailored bullet adds Kubernetes.
  const findings = detectAuditFindings(tinyMaster(), tinyResume("Deployed services with Docker and Kubernetes on AWS."));
  // The rule-5 term finding for this bullet.
  const termFinding = findings.find((f) => f.kind === "unfaithful_rewording" && f.reason.includes("ungrounded term"));
  // It exists.
  assert.ok(termFinding, JSON.stringify(findings));
  // And names exactly the invented word as data.
  assert.deepEqual((termFinding as { words?: unknown }).words, ["kubernetes"]);
});

// The words field mirrors the reason's list, and claim stays the whole bullet (the web reads it).
test("words: the ungrounded-term finding carries the unmatched tokens beside an unchanged claim", () => {
  // Two invented words in one bullet.
  const text = "Deployed resilient services with Docker on AWS using Terraform.";
  // Audit it.
  const findings = detectAuditFindings(tinyMaster(), tinyResume(text));
  // The rule-5 term finding.
  const termFinding = findings.find((f) => f.kind === "unfaithful_rewording" && f.reason.includes("ungrounded term"));
  // It exists.
  assert.ok(termFinding, JSON.stringify(findings));
  // Both words, in the order the reason prints them.
  assert.deepEqual((termFinding as { words?: unknown }).words, ["resilient", "terraform"]);
  // The reason still lists the same words, for readers that predate `words`.
  assert.ok(termFinding.reason.endsWith("resilient, terraform"), termFinding.reason);
  // Back-compat: claim is still the whole bullet.
  assert.equal(termFinding.claim, text);
});

// An inflection-only rewording through the full auditor gives no term finding at all.
test("invention control: an inflection-only rewording gives no ungrounded-term finding", () => {
  // "deploying" is "deployed" re-inflected; "service" is the singular of "services".
  const findings = detectAuditFindings(tinyMaster(), tinyResume("Deploying a service with Docker on AWS."));
  // No rule-5 term finding.
  assert.equal(findings.filter((f) => f.reason.includes("ungrounded term")).length, 0, JSON.stringify(findings));
});

test("stemToken: a tech noun in -er never meets a verb ('container' is not grounded by master 'contains')", () => {
  // The -er rule is gone: "contains" stems to "contain", "container" stays itself, so rule 5 still flags "container".
  assert.notEqual(stemToken("container"), stemToken("contains"));
  // Plurals of -er nouns still meet their singular through the plain -s rule ("workers"/"worker").
  assert.equal(stemToken("workers"), stemToken("worker"));
});
