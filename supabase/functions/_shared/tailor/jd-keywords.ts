// THE JOB DESCRIPTION'S SKILL TERMS — what `applications.selected_jd_keywords` holds.
//
// WHY THIS EXISTS (2026-10-06): nothing wrote that column, so every tailored row carried
// `'{}'` and the approval page's ATS coverage read 0% after a successful tailoring. The
// web computes coverage as keywords-present / keywords-listed (diffAdapter.ts:322-337),
// so this list is the DENOMINATOR of a number the operator trusts.
//
// WHY A VOCABULARY AND NOT EVERY TOKEN. `ats-simulator.ts`'s extractor returns every
// non-stopword token: 448 of them for the live GitLab posting, starting "accelerate,
// accommodation, acquisition…" and including "ancestry", "armed" and "badge" from the
// equal-opportunity boilerplate. As a denominator that pins coverage near zero for any
// resume — a different wrong number, not a real one. A term counts here only if it is in
// the curated vocabulary below, so the list reads as skills and requirements, never filler.
// That trades recall for precision on purpose: a missed skill under-counts honestly; a
// filler word corrupts the score for everyone.
//
// DETERMINISTIC ON PURPOSE. core_tables.sql:353 names `selected_jd_keywords` as half of
// `tailored_hash`'s input. Nothing computes that hash yet, but when something does, this
// output becomes a cache key, so it is sorted and free of any clock or randomness. Editing
// the vocabulary CHANGES that key's meaning for every future row; say so in the commit.
//
// PURE: no network, no database, no Deno APIs, so `node --test` runs it directly.

// One vocabulary entry: the canonical spelling written to the column, and the pattern
// that finds it in a posting.
interface SkillTerm {
  // Written verbatim to the column, and matched by the web as a case-insensitive
  // SUBSTRING of resume text, so it is spelled the way resumes spell it.
  readonly term: string;
  // Word-bounded, so "Go" is not found in "Google" and "SQL" not in "PostgreSQL".
  readonly pattern: RegExp;
}

// Case-insensitive, word-bounded pattern for an ordinary term.
const word = (source: string): RegExp => new RegExp(`(?<![A-Za-z0-9])(?:${source})(?![A-Za-z0-9])`, "i");
// CASE-SENSITIVE, for terms that are also English words ("Go", "REST", "AI"): the
// capitalised form is the technology; "go to", "the rest of" and "said" are not.
const exact = (source: string): RegExp => new RegExp(`(?<![A-Za-z0-9])(?:${source})(?![A-Za-z0-9])`);

// THE VOCABULARY. Kept to terms a recruiter's ATS would match as a requirement. Grouped
// for review; order is irrelevant because the output is sorted.
const SKILL_VOCABULARY: readonly SkillTerm[] = [
  // Languages. `exact` for Go: "Go" the language vs "go" the verb.
  // The most-requested backend and data language; unambiguous as a word.
  { term: "Python", pattern: word("python") },
  // Frontend and Node work; spelled out, so no abbreviation trap.
  { term: "JavaScript", pattern: word("javascript") },
  // Typed JavaScript; postings list it separately from JavaScript.
  { term: "TypeScript", pattern: word("typescript") },
  // Bounded, so it is not found inside "JavaScript".
  { term: "Java", pattern: word("java") },
  // Case-sensitive: "Go" the language, never "go" the verb; also matches "Golang".
  { term: "Go", pattern: exact("Go|Golang") },
  // The language; GitLab's own stack.
  { term: "Ruby", pattern: word("ruby") },
  // The framework; bounded so "guardrails" in a posting does not count.
  { term: "Rails", pattern: word("rails") },
  // The language; "rust" as a word is rare enough in postings to accept.
  { term: "Rust", pattern: word("rust") },
  // Hand-written pattern: `` cannot sit after "+", so only the left edge is bounded.
  { term: "C++", pattern: /(?<![A-Za-z0-9])c\+\+/i },
  // Same reason as C++: the trailing "#" defeats a word boundary.
  { term: "C#", pattern: /(?<![A-Za-z0-9])c#/i },
  // JVM and Android language.
  { term: "Kotlin", pattern: word("kotlin") },
  // JVM language common in data engineering.
  { term: "Scala", pattern: word("scala") },
  // Web backend language.
  { term: "PHP", pattern: word("php") },
  // Bounded on both sides, so it is NOT found inside "PostgreSQL" or "MySQL".
  { term: "SQL", pattern: word("sql") },
  // Frameworks and protocols.
  // UI library, with or without the .js suffix.
  { term: "React", pattern: word("react(?:\\.js)?") },
  // Runtime, written "Node.js", "NodeJS" or "nodejs".
  { term: "Node.js", pattern: word("node\\.?js") },
  // Python web framework.
  { term: "FastAPI", pattern: word("fastapi") },
  // Python web framework.
  { term: "Django", pattern: word("django") },
  // Python micro-framework.
  { term: "Flask", pattern: word("flask") },
  // Case-sensitive: the Java framework, not the season.
  { term: "Spring", pattern: exact("Spring(?: Boot)?") },
  // Case-sensitive: the Node framework, not the verb "express".
  { term: "Express", pattern: exact("Express(?:\\.js)?") },
  // API query language.
  { term: "GraphQL", pattern: word("graphql") },
  // RPC framework; written in its canonical casing.
  { term: "gRPC", pattern: word("grpc") },
  // Case-sensitive: the API style, never "the rest of".
  { term: "REST", pattern: exact("REST(?:ful)?") },
  // API design and integration; "API" or "APIs".
  { term: "APIs", pattern: word("apis?") },
  // LLM orchestration library.
  { term: "LangChain", pattern: word("langchain") },
  // Data stores and pipelines.
  // Also written "Postgres".
  { term: "PostgreSQL", pattern: word("postgres(?:ql)?") },
  // Relational database.
  { term: "MySQL", pattern: word("mysql") },
  // Document database, "Mongo" or "MongoDB".
  { term: "MongoDB", pattern: word("mongo(?:db)?") },
  // In-memory store.
  { term: "Redis", pattern: word("redis") },
  // Search engine, with or without the space.
  { term: "Elasticsearch", pattern: word("elastic ?search") },
  // Event streaming platform.
  { term: "Kafka", pattern: word("kafka") },
  // Message broker.
  { term: "RabbitMQ", pattern: word("rabbitmq") },
  // Postgres vector extension; lower-case is its canonical name.
  { term: "pgvector", pattern: word("pgvector") },
  // Case-sensitive: Apache Spark, not "spark" as in "spark ideas".
  { term: "Spark", pattern: exact("Spark") },
  // Workflow orchestrator.
  { term: "Airflow", pattern: word("airflow") },
  // A requirement in its own right ("caching", "cache", "caches").
  { term: "Caching", pattern: word("cach(?:e|es|ing)") },
  // Queues, messaging or brokers: one requirement, many spellings.
  { term: "Message queues", pattern: word("queues?|messaging|message brokers?") },
  // Only with design/evolution/migration, so a passing "schema" is not a skill.
  { term: "Schema design", pattern: word("schema (?:design|evolution|migrations?)") },
  // Infrastructure and delivery.
  // Container tooling.
  { term: "Docker", pattern: word("docker") },
  // Also its "k8s" abbreviation.
  { term: "Kubernetes", pattern: word("kubernetes|k8s") },
  // Case-sensitive: the Kubernetes package manager, not "at the helm".
  { term: "Helm", pattern: exact("Helm") },
  // Infrastructure as code.
  { term: "Terraform", pattern: word("terraform") },
  // Case-sensitive acronym.
  { term: "AWS", pattern: exact("AWS") },
  // Also "GCP"; written as resumes spell it.
  { term: "Google Cloud", pattern: word("google cloud(?: platform)?|gcp") },
  // Case-sensitive: the cloud, not the colour.
  { term: "Azure", pattern: exact("Azure") },
  // Operating system.
  { term: "Linux", pattern: word("linux") },
  // With or without spaces around the slash.
  { term: "CI/CD", pattern: word("ci ?/ ?cd") },
  // Named CI system.
  { term: "GitHub Actions", pattern: word("github actions") },
  // Architecture style, hyphenated or not.
  { term: "Microservices", pattern: word("micro-?services?") },
  // Architecture style, hyphen or space.
  { term: "Event-driven", pattern: word("event[- ]driven") },
  // Metrics, logs and traces as a discipline.
  { term: "Observability", pattern: word("observability") },
  // Operational monitoring.
  { term: "Monitoring", pattern: word("monitoring") },
  // Engineering practice, named only when a posting asks for it as a skill.
  // Only concrete test kinds, so "test" in prose ("put to the test") does not count.
  { term: "Testing", pattern: word("unit tests?|integration tests?|end-to-end|automated (?:tests?|testing|coverage)|test automation") },
  // Reviewing others' code, a listed responsibility.
  { term: "Code review", pattern: word("code reviews?") },
  // A listed fundamental.
  { term: "Debugging", pattern: word("debugging") },
  // Performance profiling.
  { term: "Profiling", pattern: word("profiling") },
  // Concurrent programming.
  { term: "Concurrency", pattern: word("concurrency") },
  // Operational duty; the hyphen distinguishes it from "on call" in prose.
  { term: "On-call", pattern: word("on-call") },
  // AI. `exact` for AI: the capitalised acronym, never "said" or "maintain".
  // Case-sensitive acronym, never the letters inside "said" or "maintain".
  { term: "AI", pattern: exact("AI") },
  // Case-sensitive acronym, singular or plural.
  { term: "LLM", pattern: exact("LLMs?") },
  // Case-sensitive: retrieval-augmented generation, not "rag".
  { term: "RAG", pattern: exact("RAG") },
  // Spelled out; the acronym ML is too ambiguous to match.
  { term: "Machine learning", pattern: word("machine learning") },
  // A named skill in AI postings.
  { term: "Prompt engineering", pattern: word("prompt engineering") },
];

// The posting's skill terms: every vocabulary term found in it, once, sorted.
export function extractJdKeywords(jobDescription: string): readonly string[] {
  // Entity-decoded so "Ruby &amp; Rails" in scraped HTML reads as text.
  const text = jobDescription.replace(/&amp;/g, "&");
  // Each term at most once, whatever its frequency: the column is a set, not a histogram.
  const found = SKILL_VOCABULARY.filter((entry) => entry.pattern.test(text)).map((entry) => entry.term);
  // Code-point order, not locale order, so the cache-key input is identical on every runtime.
  return [...new Set(found)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
