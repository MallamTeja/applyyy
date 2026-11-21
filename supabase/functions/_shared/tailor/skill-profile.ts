/**
 * The skill preference profile: WHICH master skills every tailored resume ships, as DATA.
 *
 * WHY THIS EXISTS (docs/tailor/2026-11-18-tailoring-findings-and-plan.md §1-§2, §4): 1,221 of 1,403 chat edit ops
 * (87%) were Teja topping up skills by hand, the SAME skills on almost every resume (Cursor 41/64 apps, Postman 40,
 * Git 37, ...). The tailor picked skills by exact JD name only, so the skills a reviewer expects of every SDE intern
 * never shipped unless the JD spelled them. Teja's ruling (2026-11-18): **core + JD fill** — each group ships a fixed
 * core, then fills to its size with JD-ranked master skills; a never-list is blocked.
 *
 * A CODE FILE, NOT A system_settings COLUMN: no migration, versioned with the engine that reads it, reviewed in a diff.
 * The weekly learning loop (§6) proposes edits to THIS file for Teja to accept.
 *
 * TRUTH: every name below is a spelling from the master (v47, 2026-11-18). A core name the master does not hold is
 * simply skipped by the engine (it matches no master skill), so this file can never add a skill the owner lacks:
 * the master stays the only source (repo rule "master-only content").
 *
 * HOW THE VALUES WERE CHOSEN (keep7 eval data, 2026-11-18, read-only; re-derive with §9's queries): a core skill is one
 * present in >= ~60% of Teja's own chat-edited resumes (64 rows) that carry the group, cross-checked against the 33
 * retailor5 ideals. Where the two disagreed (RAG Pipelines / Prompt Engineering: 96% / 93% on Teja's own resumes,
 * absent from the agent-built ideals) Teja's own edits win, because they are his choices and the ideals are not.
 */

/** One display group's preferences. The group IS the master category of the same name (the renderer groups by it). */
export interface SkillGroupPreference {
  // Exact master category name this row applies to.
  readonly category: string;
  // Skills that ship on every resume with this group, in this order of preference, before any JD fill.
  readonly core: readonly string[];
  // The fewest skills the group shows when the master holds that many (the AI group's 5 is Teja's 2026-11-10 ruling).
  readonly min: number;
  // The most skills the group shows (Teja 2026-11-21 14:41: up to 10, "3 more skills in each"; 7 from 2026-11-12).
  readonly max: number;
  // Tie-break position when two groups cover the JD equally (lower first); from the median order on Teja's resumes.
  readonly order: number;
}

/** The whole profile: per-group rows, the never-list, twin spellings, and JD aliases. */
export interface SkillProfile {
  // Per master category.
  readonly groups: readonly SkillGroupPreference[];
  // Skills that never ship, whatever the JD or the model says (removed by Teja and absent from his resumes).
  readonly never: readonly string[];
  // Twin spellings of one skill: the FIRST name is kept, every later one is dropped when the first is seated.
  readonly twins: readonly (readonly string[])[];
  // Extra phrases a JD may use for a master skill ("Data Structures" for DSA); matched word-bounded, case-insensitive.
  readonly aliases: Readonly<Record<string, readonly string[]>>;
}

// The group size cap for every row: 10 since Teja 2026-11-21 14:41 ("increase that cap to 3 more skills in each"), was 7.
const MAX = 10;
// The ordinary floor: four skills read as a real group; fewer only when the master holds fewer.
const MIN = 4;

/** The live profile. Edit THIS (never the engine) to change which skills ship. */
export const SKILL_PROFILE: SkillProfile = {
  groups: [
    // Languages: JavaScript 97%, Python 95%, TypeScript 90%, SQL 87% of Teja's resumes with the group.
    { category: "Languages", core: ["JavaScript", "Python", "TypeScript", "SQL"], min: MIN, max: MAX, order: 1 },
    // Frameworks: FastAPI 100%, Node.js 100%, React.js 93%.
    { category: "Frameworks", core: ["Node.js", "FastAPI", "React.js"], min: MIN, max: MAX, order: 2 },
    // Backend Engineering: REST APIs 95%, Rate Limiting 92%, Idempotency 77%, Caching 69%.
    { category: "Backend Engineering", core: ["REST APIs", "Rate Limiting", "Idempotency", "Caching"], min: MIN, max: MAX, order: 3 },
    // DevOps & Cloud: Docker 98%, AWS 90%, Google Cloud Platform 88%, CI/CD & GitHub Actions 88%.
    { category: "DevOps & Cloud", core: ["Docker", "AWS", "Google Cloud Platform", "CI/CD & GitHub Actions"], min: MIN, max: MAX, order: 4 },
    // Databases: PostgreSQL 100%, Redis 95%, MySQL 65%. pgvector (73%) is NOT core: Teja also removed it twice (ask him).
    { category: "Databases", core: ["PostgreSQL", "Redis", "MySQL"], min: MIN, max: MAX, order: 5 },
    // AI: RAG Pipelines 96%, AI Agents & Workflows 95%, Prompt Engineering 93%, Context Engineering 65%. Floor 5 (2026-11-10).
    { category: "AI", core: ["AI Agents & Workflows", "RAG Pipelines", "Prompt Engineering", "Context Engineering"], min: 5, max: MAX, order: 6 },
    // Tools: Git 100%, GitHub 100%, Postman 94%, Cursor 78%, Claude Code 61% (Swagger/OpenAPI 88% fills next by master order).
    { category: "Tools", core: ["Git", "GitHub", "Postman", "Cursor", "Claude Code"], min: MIN, max: MAX, order: 7 },
    // CS Fundamentals: all five 86-100% on Teja's resumes.
    { category: "CS Fundamentals", core: ["System Design (LLD/HLD)", "DSA", "OOP", "Operating Systems", "Computer Networks"], min: MIN, max: MAX, order: 8 },
    // Testing & Quality: Code review 85%, pytest 81%; Unit Testing is the kept twin of "Testing".
    { category: "Testing & Quality", core: ["Code review", "Unit Testing", "pytest"], min: MIN, max: MAX, order: 9 },
    // Machine Learning: no stable core; JD fill only.
    { category: "Machine Learning", core: [], min: MIN, max: MAX, order: 10 },
    // Data Science: no stable core; JD fill only.
    { category: "Data Science", core: [], min: MIN, max: MAX, order: 11 },
  ],
  // Removed by Teja's own ops AND absent from every resume he finished (keep7: Agile 11 removals, Slack 3, Vector
  // Search 3, .NET 2). VS Code and pgvector were removed too but stay on most of his finished resumes, so they are NOT
  // here: that conflict is Teja's to rule on. "LLM Applications" (retired in v47) is a TWIN below, not a never: on an
  // older master that holds only it, it is still the owner's own real skill.
  never: ["Agile", "Slack", "Vector Search", ".NET", "Process Automation", "YAML Flows"],
  // Teja 2026-11-16: "we have 2 testings in skills, remove one" (kept Unit Testing); the long Debugging form is the
  // one on 16 of 17 resumes; LLM/SLM API Integration replaced LLM Applications in v47.
  twins: [
    ["Unit Testing", "Testing"],
    ["Debugging & Troubleshooting", "Debugging"],
    ["LLM/SLM API Integration", "LLM Applications"],
  ],
  // How JDs say what the master names differently. Phrases only, word-bounded: never a bare short token like "OS".
  aliases: {
    "DSA": ["data structures", "algorithms"],
    "OOP": ["object-oriented", "object oriented", "OOPS"],
    "Operating Systems": ["operating system"],
    "Computer Networks": ["computer networking", "networking", "TCP/IP"],
    "System Design (LLD/HLD)": ["system design", "distributed systems", "low-level design", "high-level design"],
    "DBMS": ["database management", "DBMS"],
    "REST APIs": ["REST", "RESTful", "REST API"],
    "CI/CD & GitHub Actions": ["CI/CD", "GitHub Actions", "continuous integration"],
    "Google Cloud Platform": ["GCP", "Google Cloud"],
    "AI Agents & Workflows": ["AI agents", "agentic", "LLM agents"],
    "RAG Pipelines": ["RAG", "retrieval-augmented", "retrieval augmented"],
    "Prompt Engineering": ["prompt engineering", "prompting"],
    "LLM/SLM API Integration": ["LLM", "LLMs", "large language model", "OpenAI API"],
    "Unit Testing": ["unit test", "unit tests", "unit testing"],
    "Swagger/OpenAPI": ["Swagger", "OpenAPI"],
    "Debugging & Troubleshooting": ["debugging", "troubleshooting"],
    "Observability": ["observability", "logging", "tracing"],
    "Caching": ["caching", "cache"],
    "Machine learning": ["machine learning", "ML"],
  },
};
