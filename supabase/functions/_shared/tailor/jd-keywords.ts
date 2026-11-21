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
  // Frontend and Node work, or its "JS" short form (2026-11-21). The left bound also refuses ".", so the
  // ".js" inside "Node.js", "Next.js" or "React.js" (a framework's NAME) never credits JavaScript.
  { term: "JavaScript", pattern: /(?<![A-Za-z0-9.])(?:javascript|js)(?![A-Za-z0-9])/i },
  // Typed JavaScript, or its "TS" short form (2026-11-21); same "." bound as JavaScript (a ".ts" file is not the skill).
  { term: "TypeScript", pattern: /(?<![A-Za-z0-9.])(?:typescript|ts)(?![A-Za-z0-9])/i },
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
  // React framework, written "Next.js" or "NextJS" (2026-11-21: missed before, plan §2 item 6).
  { term: "Next.js", pattern: word("next\\.?js") },
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
  // API design and integration; "API" or "APIs". Dropped as vague earlier on 2026-11-21, RESTORED the same day on the
  // orch's instruction (14:52), so the ATS coverage denominator keeps it.
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
  // "Message queues" LEFT on 2026-11-21 (vague): bare "messaging" or "queues" matched chat products and support
  // queues. Kafka and RabbitMQ above are the concrete forms.
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
  // Version control (2026-11-21). Word-bounded, so "GitHub" and "GitLab" do not count as "Git".
  { term: "Git", pattern: word("git") },
  // API client, on 40 of 64 of Teja's hand-edited resumes (2026-11-21).
  { term: "Postman", pattern: word("postman") },
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
  // JavaScript test runner (2026-11-21).
  { term: "Jest", pattern: word("jest") },
  // Reviewing others' code, a listed responsibility.
  { term: "Code review", pattern: word("code reviews?") },
  // A listed fundamental.
  { term: "Debugging", pattern: word("debugging") },
  // "Profiling", "Concurrency" and "On-call" LEFT on 2026-11-21 (vague practice words, plan §5 P3): no master skill or
  // resume line answers them, so they only lowered the ATS coverage figure.
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
  // CASE-KEPT lookup (2026-11-21): canonicalSkillTerm went case-blind for skill names, but this matcher keeps its old
  // behaviour exactly, so a lowercase keyword still falls through to the escaped fallback below as it always did.
  const canonical = termForWholeName(keyword, CASE_KEPT_PATTERNS);
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
  // CASE-BLIND (2026-11-21): a skill name is a whole name, never prose, so exact()'s guard against English words
  // ("go to", "the rest of") has nothing to guard here. Case-sensitive, "azure" read as unknown and the chat added both
  // "azure" and "Microsoft Azure" (peer 1's find). The canonical casing comes back either way.
  return termForWholeName(name, CASE_BLIND_PATTERNS);
}

// Every vocabulary pattern with the "i" flag added, built once, in vocabulary order, for canonicalSkillTerm only.
const CASE_BLIND_PATTERNS: readonly RegExp[] = SKILL_VOCABULARY.map(({ pattern }) => (pattern.flags.includes("i") ? pattern : new RegExp(pattern.source, `${pattern.flags}i`)));
// The vocabulary's own patterns, case rules intact, for the prose matcher (appearsInDecoded).
const CASE_KEPT_PATTERNS: readonly RegExp[] = SKILL_VOCABULARY.map(({ pattern }) => pattern);

/* The term of the first vocabulary entry whose pattern (from `patterns`, index-aligned with SKILL_VOCABULARY)
 * consumes the whole trimmed name, or null. One body for both case modes, so they cannot drift apart. */
function termForWholeName(name: string, patterns: readonly RegExp[]): string | null {
  // Surrounding spaces are not part of a name.
  const trimmed = name.trim();
  // The first entry whose pattern consumes the whole name.
  const index = patterns.findIndex((pattern) => pattern.exec(trimmed)?.[0] === trimmed);
  // Its canonical spelling, or none.
  return index === -1 ? null : SKILL_VOCABULARY[index]!.term;
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

// ---- REQUIREMENT TIERS (2026-11-21, Teja's 2026-11-18 21:47 ruling "most-needed first") --------------------------
// "Inside each group, JD-required skills first, then JD-preferred, then core; groups ordered by how much of the JD
// they cover; projects and achievements the same." That needs to know WHERE in the posting a skill is named, not only
// THAT it is. A posting is read line by line: a short heading line opens a section (Requirements / Nice to have / other
// prose), and an inline marker ("is a plus", "preferred") overrides its own sentence. The heading words below mirror
// _shared/screen/required-experience.ts's SOFT/HARD headings (that file is the screener's and module-local, so they are
// restated here rather than shared across the two owners).

/** Where a posting names a skill: under its requirements, its nice-to-haves, or anywhere else. */
export type JdTier = "required" | "preferred" | "mentioned";

/** The weight of each tier for ranking: required > preferred > mentioned (> 0, so any mention beats none). */
export const JD_TIER_WEIGHT: Readonly<Record<JdTier, number>> = { required: 3, preferred: 2, mentioned: 1 };

/** One sentence of a posting with the tier its position gives it. */
export interface JdSentence {
  // The sentence, entity-decoded once (the same decoding the matcher uses).
  readonly text: string;
  // Its tier.
  readonly tier: JdTier;
}

// A nice-to-have heading. Checked FIRST, because "Preferred Qualifications" also contains a required word.
const PREFERRED_HEADING = /\b(?:nice[- ]to[- ]haves?|preferred|bonus(?: points)?|good[- ]to[- ]haves?|pluses|desired|desirable|optional)\b/i;
// A requirements heading.
const REQUIRED_HEADING = /\b(?:requirements?|required|qualifications?|must[- ]haves?|what (?:you(?:'ll)?|we(?:'re)?) (?:need|bring|look(?:ing)? for|expect)|you (?:have|bring|should have)|who you are|about you|skills)\b/i;
// Any other heading (the role, the company, benefits): closes a requirements section, so its prose is "mentioned".
const OTHER_HEADING = /\b(?:about (?:us|the (?:company|team|role|job))|the role|benefits|perks|what we offer|why (?:join|us)|responsibilities|what you(?:'ll)? do|compensation|salary|equal opportunity|how to apply)\b/i;
// An inline nice-to-have marker: the sentence is preferred wherever it sits.
const PREFERRED_INLINE = /\b(?:nice to have|good to have|(?:is |are |would be )?a (?:big )?plus|preferred|bonus|is an advantage|desirable)\b/i;
// An inline requirement marker, for postings without headings.
const REQUIRED_INLINE = /\b(?:required|must|mandatory|essential)\b/i;

/** A heading's shape: an UNBULLETED short line, at most 8 words, no sentence inside it (a trailing colon is allowed). */
function headingShaped(line: string): boolean {
  // A bulleted line is a list item, never a heading ("- Python skills" is content, though it says "skills").
  if (/^[\-*•]/.test(line)) return false;
  // Markdown hashes and a trailing colon are layout, not words.
  const bare = line.replace(/^#+\s*/, "").replace(/:\s*$/, "").trim();
  // Short, and not a sentence (a heading has no full stop in the middle and no list of items).
  return bare !== "" && bare.split(/\s+/).length <= 8 && !/[.;,]/.test(bare);
}

/**
 * The posting split into sentences, each tagged with its tier. Lines before any heading, and lines under a non-
 * requirements heading, are "mentioned". Pure and deterministic; call once per posting and reuse the result.
 */
export function classifyJd(jobDescription: string): readonly JdSentence[] {
  // The section the current line sits in; prose until a requirements heading says otherwise.
  let section: JdTier = "mentioned";
  // The tagged sentences.
  const out: JdSentence[] = [];
  // Line by line: headings are lines.
  for (const raw of decodeEntities(jobDescription).split(/\r?\n|•/)) {
    // Surrounding space is not content.
    const line = raw.trim();
    // Blank lines carry nothing.
    if (line === "") continue;
    // A heading switches the section and is not itself a requirement. Only a KNOWN heading counts: a short line that
    // names no section ("Experience with Kafka is a plus") is content and gets the inline check below.
    // Nice-to-have first ("Preferred Qualifications"), then requirements, then any other heading closes the section.
    const heading = !headingShaped(line) ? null : PREFERRED_HEADING.test(line) ? "preferred" : REQUIRED_HEADING.test(line) ? "required" : OTHER_HEADING.test(line) ? "mentioned" : null;
    // A heading: switch, and move on.
    if (heading !== null) { section = heading; continue; }
    // A content line, split into sentences so an inline marker only marks its own sentence.
    for (const sentence of line.split(/(?<=[.;!?])\s+/)) {
      // An inline nice-to-have wins everywhere; an inline requirement lifts prose; otherwise the section decides.
      const tier: JdTier = PREFERRED_INLINE.test(sentence) ? "preferred" : section === "mentioned" && REQUIRED_INLINE.test(sentence) ? "required" : section;
      // Tagged.
      out.push({ text: sentence, tier });
    }
  }
  // Every sentence, in posting order.
  return out;
}

/** The BEST tier at which any of `phrases` appears in the classified posting, or null when none appears. */
export function jdTierOf(phrases: readonly string[], sentences: readonly JdSentence[]): JdTier | null {
  // The best tier so far.
  let best: JdTier | null = null;
  // Each sentence that names any phrase.
  for (const { text, tier } of sentences) {
    // Already the top tier: nothing beats it.
    if (best === "required") break;
    // Not named here, or no better than what we have.
    if (best !== null && JD_TIER_WEIGHT[tier] <= JD_TIER_WEIGHT[best]) continue;
    // Named by any phrase (the one matching rule, alias-aware: "Postgres" credits PostgreSQL).
    if (phrases.some((phrase) => appearsInDecoded(phrase, text))) best = tier;
  }
  // The best, or null for "the posting never names it".
  return best;
}
