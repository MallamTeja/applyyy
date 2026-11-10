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
  // Written verbatim to the column, and read back through keywordAppearsIn (this module's
  // matcher for resume text) using this entry's own pattern; spelled the way resumes spell it.
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
  // Hand-written pattern: `\b` cannot sit after "+", so only the left edge is bounded.
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
  // Case-sensitive acronym, or the name spelled out (item 2, 2026-11-07: master v20 holds "AWS").
  { term: "AWS", pattern: exact("AWS|Amazon Web Services") },
  // Also "GCP"; written as resumes spell it.
  { term: "Google Cloud", pattern: word("google cloud(?: platform)?|gcp") },
  // Case-sensitive: the cloud, not the colour. "Microsoft Azure" as one match, so the name master v20
  // holds is this term as a whole (canonicalSkillTerm), not just a string that contains it.
  { term: "Azure", pattern: exact("(?:Microsoft )?Azure") },
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
  // AI group. Case-sensitive acronym, never the letters inside "said" or "maintain".
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

// THE AI TERMS (2026-11-10, T13): the vocabulary's AI group above, by term. shapeSkillGroups lets ONLY these count when
// found INSIDE an AI skill's name ("RAG" -> "RAG Pipelines"): a generic term such as "Caching" inside "Prompt Caching" is
// word overlap, not relevance (review finding, 2026-11-10). jd-keywords.test.ts proves each one is a vocabulary term.
export const AI_VOCABULARY_TERMS: ReadonlySet<string> = new Set(["AI", "LLM", "RAG", "Machine learning", "Prompt engineering"]);

// term -> entry, built once at module load so a per-keyword lookup is O(1), not a scan per call.
const VOCABULARY_BY_TERM: ReadonlyMap<string, SkillTerm> = new Map(SKILL_VOCABULARY.map((entry) => [entry.term, entry]));

/* THE ONE-LETTER LANGUAGES, matched but never extracted (review 2026-11-07). The live master (v19) holds
 * a skill named "C", and the skills shape asks keywordAppearsIn(skill name, posting). The fallback below
 * bounds only letters and digits, so it credited "C" from "C++", "C#", "C-level" and "Objective-C", and
 * "R" from "R&D": a C-only group looked relevant to every C++ posting. These patterns are case-SENSITIVE
 * (lower-case "c" is a letter, not a language) and also refuse a following "+", "#", "&" or "-word" and a
 * preceding "word-". Deliberately NOT in SKILL_VOCABULARY: extractJdKeywords' output is a future cache-key
 * input and the ATS denominator, and adding a term there changes both; this map only stops false credit. */
const LETTER_LANGUAGES: ReadonlyMap<string, RegExp> = new Map([
  // C, but not C++, C#, C-level or Objective-C. "C/C++" still credits C: the slash names both.
  ["C", /(?<![A-Za-z0-9]|[A-Za-z]-)C(?![A-Za-z0-9+#&]|-[A-Za-z])/],
  // R, but not R&D, R-squared or a letter inside a word.
  ["R", /(?<![A-Za-z0-9]|[A-Za-z]-)R(?![A-Za-z0-9+#&]|-[A-Za-z])/],
]);

// Entity-decoded so "Ruby &amp; Rails" in scraped HTML reads as text. One helper so the
// extractor and the matcher cannot decode differently.
const decodeEntities = (text: string): string => text.replace(/&amp;/g, "&");

// THE single matching rule, over ALREADY-decoded text. Internal so both exports share it
// and each decodes exactly once (decoding twice would turn "&amp;amp;" into "&", changing
// the extractor's output, which is a future cache-key input).
function appearsInDecoded(keyword: string, decoded: string): boolean {
  // Empty or blank keyword: a bounded empty pattern would match almost anywhere, so it
  // must be an explicit "no", never a vacuous "yes" (CLAUDE.md §5).
  if (keyword.trim() === "") return false;
  // A vocabulary term uses its curated pattern, so "Go" honours its case-sensitive rule.
  const entry = VOCABULARY_BY_TERM.get(keyword);
  // Exact string equality only: "go" is NOT "Go", so it falls through to the fallback,
  // which is case-insensitive and WOULD credit "go to market". Reachable only by a hand-edited
  // row: the column is written solely by extractJdKeywords, which emits canonical terms.
  if (entry) return entry.pattern.test(decoded);
  // Another spelling of a vocabulary term ("Microsoft Azure", "Postgres", "Amazon Web Services") uses
  // that term's curated pattern, so a skill name and a posting that spell one technology two ways agree.
  const canonical = canonicalSkillTerm(keyword);
  // Found: matched exactly as the term itself would be.
  if (canonical !== null) return VOCABULARY_BY_TERM.get(canonical)!.pattern.test(decoded);
  // A one-letter language uses its own stricter pattern (see LETTER_LANGUAGES); exact key, so "c" falls through.
  const letter = LETTER_LANGUAGES.get(keyword);
  // Checked before the fallback, which would credit "C" from "C++".
  if (letter) return letter.test(decoded);
  // Unknown keyword: escaped so "C++"-like text is literal, never a regex; bounded and
  // case-insensitive like word(), so it is never a raw substring ("Svelte" not in "sveltekit").
  return word(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(decoded);
}

/**
 * The vocabulary term a skill NAME spells, or null (item 2, 2026-11-07). A name maps to a term only when
 * that term's own pattern matches the WHOLE name: "Postgres" is PostgreSQL and "Microsoft Azure" is
 * Azure, but "AWS Lambda" is not AWS (it is a different skill that merely contains it). Read from the
 * vocabulary's patterns, so there is no second alias list to drift from them. Exported for resume-assist,
 * which files a requested skill under the master's own entry for it.
 */
export function canonicalSkillTerm(name: string): string | null {
  // Surrounding spaces are not part of a name.
  const trimmed = name.trim();
  // The first entry whose pattern consumes the whole name.
  const entry = SKILL_VOCABULARY.find((candidate) => candidate.pattern.exec(trimmed)?.[0] === trimmed);
  // Its canonical spelling, or none.
  return entry?.term ?? null;
}

/**
 * Does `keyword` appear in `text` under the same rule the extractor uses? Exported for the
 * web approval page, whose case-insensitive substring match credited "Go" from "Google".
 *
 * A keyword that is a vocabulary `term` (exact, case-sensitive equality) uses that entry's
 * own pattern. An UNKNOWN keyword — a legacy or hand-entered row, or one orphaned by a future
 * vocabulary edit — is matched as an escaped literal inside the same word bounds as `word()`,
 * case-insensitive, and NEVER as a substring: a substring is exactly the "Go in Google" bug
 * this replaces. An empty or blank keyword is false. `&amp;` in `text` is decoded first.
 */
export function keywordAppearsIn(keyword: string, text: string): boolean {
  // Decode here, once, exactly as the extractor does.
  return appearsInDecoded(keyword, decodeEntities(text));
}

// The posting's skill terms: every vocabulary term found in it, once, sorted.
export function extractJdKeywords(jobDescription: string): readonly string[] {
  // Decoded once by the shared helper, so this and keywordAppearsIn see the same text.
  const text = decodeEntities(jobDescription);
  // Each term at most once, whatever its frequency: the column is a set, not a histogram.
  // Routed through the shared rule so the extractor and the matcher cannot diverge.
  const found = SKILL_VOCABULARY.filter((entry) => appearsInDecoded(entry.term, text)).map((entry) => entry.term);
  // Code-point order, not locale order, so the cache-key input is identical on every runtime.
  return [...new Set(found)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
