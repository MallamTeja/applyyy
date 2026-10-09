/* addableSkillFor chip matrix (QA s6, 2026-10-08).
 *
 * addableSkillFor decides which UNSELECTED master skill a missing JD keyword may offer as
 * "+ Add <skill>". QA script s6 fed the approval page a chip matrix of near-miss keywords and
 * found two over-offers, both caused by deciding with a word-bounded SUBSTRING in either
 * direction instead of by token equality / alias:
 *   1. a LONGER, DIFFERENT technology that contains a master name offers it:
 *      "SQL Server" -> "+ Add SQL" (adding SQL does not satisfy SQL Server);
 *   2. a generic single word inside a multi-word master skill offers it:
 *      "Engineering" -> Prompt Engineering, "Calling" -> Tool Calling & Guardrails.
 *
 * The table holds the matrix's true POSITIVES as well as its negatives, so a "fix" that simply
 * offers nothing cannot pass; the guard test at the bottom asserts the positives exist and pass.
 *
 * Fixture: only the skills list of the real master (generic tech names) and the real row's
 * selection of refs. No identity, contact or link data: the repo is public. addableSkillFor reads
 * only master.skills and resume.skills[].ref, so the minimal shape is the honest one. */

import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

// Loaded in before() (the module exists at HEAD, so this hook cannot cancel the suite).
let edits: typeof import('../src/features/approval/tailoredEdits.ts');

before(async () => {
  // Dynamic import so a load error is reported by the hook, not as a file-level crash.
  edits = await import('../src/features/approval/tailoredEdits.ts');
});

// The function's own parameter types, so the fixture tracks the contract without importing it.
type Resume = Parameters<typeof import('../src/features/approval/tailoredEdits.ts').addableSkillFor>[1];
// Same, for the master.
type Master = Parameters<typeof import('../src/features/approval/tailoredEdits.ts').addableSkillFor>[2];

// The real master's skills, in master order (order is addableSkillFor's tie-break, so it matters).
const MASTER_SKILLS = [
  // AI group: the multi-word skills bug 2 over-offers from a single generic word.
  { id: 'skill_llm_apps', name: 'LLM Applications', category: 'AI' },
  // "Pipelines" alone must not offer this.
  { id: 'skill_rag', name: 'RAG Pipelines', category: 'AI' },
  // "Prompt" / "Engineering" alone must not offer this.
  { id: 'skill_prompt_eng', name: 'Prompt Engineering', category: 'AI' },
  // "Context" alone must not offer this.
  { id: 'skill_context_eng', name: 'Context Engineering', category: 'AI' },
  // Selected on the row, so never offered with the row's selection.
  { id: 'skill_ai_agents', name: 'AI Agents & Workflows', category: 'AI' },
  // "Calling" / "Guardrails" alone must not offer this.
  { id: 'skill_tool_calling', name: 'Tool Calling & Guardrails', category: 'AI' },
  // Languages.
  { id: 'skill_python', name: 'Python', category: 'Languages' },
  // Bug 1's victim: "SQL Server" must not offer plain SQL.
  { id: 'skill_sql', name: 'SQL', category: 'Languages' },
  // Selected on the row.
  { id: 'skill_javascript', name: 'JavaScript', category: 'Languages' },
  // Selected on the row.
  { id: 'skill_typescript', name: 'TypeScript', category: 'Languages' },
  // Frameworks.
  { id: 'skill_fastapi', name: 'FastAPI', category: 'Frameworks' },
  // Selected on the row.
  { id: 'skill_nodejs', name: 'Node.js', category: 'Frameworks' },
  // "React" / "react.js" offer it; "ReactJS" and "React Native" must not.
  { id: 'skill_react', name: 'React.js', category: 'Frameworks' },
  // "LangChain4j" and "Lang Chain" must not offer it.
  { id: 'skill_langchain', name: 'LangChain', category: 'Frameworks' },
  // Databases; selected on the row.
  { id: 'skill_postgres', name: 'PostgreSQL', category: 'Databases' },
  // An unselected exact-name positive.
  { id: 'skill_pgvector', name: 'pgvector', category: 'Databases' },
  // Selected on the row.
  { id: 'skill_redis', name: 'Redis', category: 'Databases' },
  // Selected on the row.
  { id: 'skill_docker', name: 'Docker', category: 'DevOps & Cloud' },
  // Selected on the row.
  { id: 'skill_gcp', name: 'Google Cloud Platform', category: 'DevOps & Cloud' },
  // Selected on the row.
  { id: 'skill_cicd', name: 'CI/CD & GitHub Actions', category: 'DevOps & Cloud' },
] as const;

// The minimal master addableSkillFor reads: the cast is safe because only .skills is touched.
const master = { skills: MASTER_SKILLS.map((s) => ({ ...s })) } as unknown as Master;

// The row's tailor selection when s6 ran: these refs are already printed, so never offered.
const ROW_SELECTED = new Set([
  // Languages the tailor chose.
  'skill_python', 'skill_javascript', 'skill_typescript',
  // Frameworks the tailor chose.
  'skill_fastapi', 'skill_nodejs',
  // Databases the tailor chose.
  'skill_postgres', 'skill_redis',
  // Cloud the tailor chose.
  'skill_docker', 'skill_gcp', 'skill_cicd',
  // AI the tailor chose.
  'skill_llm_apps', 'skill_ai_agents',
]);

// Builds a resume printing exactly the given refs, shaped like the validator's ResolvedSkill.
const resumeWith = (refs: ReadonlySet<string>): Resume =>
  // Only .skills is read, so the rest of the resume is deliberately absent.
  ({ skills: MASTER_SKILLS.filter((s) => refs.has(s.id)).map((s) => ({ ref: s.id, name: s.name, category: s.category })) }) as unknown as Resume;

// The two selections the table runs against.
const RESUMES = {
  // What s6 actually rendered.
  row: resumeWith(ROW_SELECTED),
  // Nothing printed: makes cases about selected skills (PostgreSQL) non-vacuous.
  none: resumeWith(new Set()),
} as const;

// One matrix row. `on` picks the selection; omitted means the real row's.
type Case = { keyword: string; expect: string | null; why: string; on?: keyof typeof RESUMES };

// The s6 chip matrix (s6.mjs line 2 `extra`, plus the row's own keywords from line 3).
const CASES: ReadonlyArray<Case> = [
  // ---- true positives: must keep offering ----
  // s6 extra: exact name, unselected.
  { keyword: 'SQL', expect: 'SQL', why: 'exact name' },
  // Brief: case-insensitive exact name.
  { keyword: 'sql', expect: 'SQL', why: 'exact name, lower case' },
  // s6 extra: the React vocabulary term covers "React.js".
  { keyword: 'React', expect: 'React.js', why: 'vocabulary alias React = React.js' },
  // Brief: case-insensitive exact name.
  { keyword: 'react.js', expect: 'React.js', why: 'exact name, lower case' },
  // Brief: exact name.
  { keyword: 'pgvector', expect: 'pgvector', why: 'exact name' },
  // Brief: the multi-word skill by its full name.
  { keyword: 'Prompt Engineering', expect: 'Prompt Engineering', why: 'exact multi-word name' },
  // s6 extra "Postgresql": equality with PostgreSQL once it is not already printed.
  { keyword: 'Postgresql', expect: 'PostgreSQL', why: 'exact name, case differs', on: 'none' },

  // ---- bug 1: a longer, different technology containing a master name ----
  // s6 extra: SQL Server is not SQL.
  { keyword: 'SQL Server', expect: null, why: 'bug 1: different product containing SQL' },
  // s6 extra: same, longer.
  { keyword: 'Microsoft SQL Server', expect: null, why: 'bug 1: different product containing SQL' },

  // ---- bug 2: a generic word inside a multi-word master skill ----
  // s6 extra.
  { keyword: 'Engineering', expect: null, why: 'bug 2: generic word of Prompt Engineering' },
  // s6 extra.
  { keyword: 'Prompt', expect: null, why: 'bug 2: generic word of Prompt Engineering' },
  // s6 extra.
  { keyword: 'Context', expect: null, why: 'bug 2: generic word of Context Engineering' },
  // s6 extra.
  { keyword: 'Calling', expect: null, why: 'bug 2: generic word of Tool Calling & Guardrails' },
  // s6 extra.
  { keyword: 'Guardrails', expect: null, why: 'bug 2: generic word of Tool Calling & Guardrails' },
  // s6 extra: same shape as the above, not named by the orchestrator (see report).
  { keyword: 'Pipelines', expect: null, why: 'bug 2: generic word of RAG Pipelines' },

  // ---- true negatives that already hold and must keep holding ----
  // s6 extra: PostgreSQL is printed on the row, so no chip whatever the alias rule.
  { keyword: 'Postgres', expect: null, why: 'PostgreSQL already on the resume' },
  /* Pinned 2026-10-09 (task C item 1+2): "Postgres" with PostgreSQL UNSELECTED offers nothing.
     The token rule compares "postgres" with "postgresql", which differ, and the repo has no alias
     table. This is a deliberate choice, not an oversight: an alias would need a reviewed list. */
  { keyword: 'Postgres', expect: null, why: 'no alias table: postgres is not postgresql', on: 'none' },
  // s6 extra "Postgresql" against the real row: matched, not missing.
  { keyword: 'Postgresql', expect: null, why: 'PostgreSQL already on the resume' },
  // s6 extra.
  { keyword: 'ReactJS', expect: null, why: 'not the master spelling' },
  // s6 extra: a different framework.
  { keyword: 'React Native', expect: null, why: 'different technology' },
  // s6 extra: SQL inside another word.
  { keyword: 'NoSQL', expect: null, why: 'different technology' },
  // s6 extra.
  { keyword: 'MySQL', expect: null, why: 'different technology' },
  // s6 extra: Java port, not LangChain.
  { keyword: 'LangChain4j', expect: null, why: 'different technology' },
  // s6 extra: split spelling.
  { keyword: 'Lang Chain', expect: null, why: 'not the master spelling' },
  // s6 extra: not pgvector.
  { keyword: 'Vector databases', expect: null, why: 'category, not a master skill' },
  // s6 extra.
  { keyword: 'Data Engineering', expect: null, why: 'different discipline' },
  // s6 extra.
  { keyword: 'Platform Engineering', expect: null, why: 'different discipline' },
  // s6 extra.
  { keyword: 'Site Reliability Engineering', expect: null, why: 'different discipline' },

  // ---- the row's own selected_jd_keywords (s6 line 3) ----
  // Each is either already printed or absent from the master, so none may offer a chip.
  ...['AI', 'APIs', 'CI/CD', 'Caching', 'Code review', 'Concurrency', 'Debugging', 'Docker', 'Event-driven', 'Go', 'Helm', 'Kubernetes', 'Message queues', 'Observability', 'On-call', 'PostgreSQL', 'Profiling', 'Rails', 'Ruby', 'Rust', 'Schema design', 'Testing', 'gRPC'].map(
    // Real-row keyword: printed already or not a master skill.
    (keyword): Case => ({ keyword, expect: null, why: 'row keyword: printed or not in master' }),
  ),
];

// Runs one case through the function under test.
const offer = (c: Case): string | null =>
  // The chip's label is the master name, or no chip at all.
  edits.addableSkillFor(c.keyword, RESUMES[c.on ?? 'row'], master)?.name ?? null;

describe('addableSkillFor: the s6 chip matrix', () => {
  // One test per row so a failure names the exact keyword.
  for (const c of CASES) {
    // The selection is named when it is not the real row's, so duplicate keywords stay distinct.
    it(`${c.keyword} → ${c.expect ?? 'no chip'} (${c.why}${c.on ? `; selected: ${c.on}` : ''})`, () => {
      // The whole contract: exactly this master skill, or none.
      assert.equal(offer(c), c.expect);
    });
  }

  // Guard: a fix that offers nothing would pass every negative, so the positives must exist and pass.
  it('the matrix has at least 7 positives and they all pass', () => {
    // The rows that expect a chip.
    const positives = CASES.filter((c) => c.expect !== null);
    // Fewer means someone trimmed the table until it passed.
    assert.ok(positives.length >= 7, `only ${positives.length} positive cases`);
    // Every one of them still offers its skill.
    assert.deepEqual(positives.map(offer), positives.map((c) => c.expect));
  });
});

/* C versus C++ (task C item 1+2, 2026-10-09). The real master has neither, so these rows use a
 * two-skill master of their own. Each direction is a different language: offering "C" for a "C++"
 * miss (or the reverse) adds a skill that leaves the JD keyword exactly as missing as before.
 * The tokenizer keeps '+' and '#', so "c" and "c++" are different tokens and must never meet. */
describe('addableSkillFor: C and C++ never stand in for each other', () => {
  // A master holding ONLY "C": the one supplier "C++" could wrongly borrow.
  const onlyC = { skills: [{ id: 'skill_c', name: 'C', category: 'Languages' }] } as unknown as Master;
  // A master holding ONLY "C++": the one supplier "C" could wrongly borrow.
  const onlyCpp = { skills: [{ id: 'skill_cpp', name: 'C++', category: 'Languages' }] } as unknown as Master;
  // Nothing printed, so a null below can only mean "the names do not match", never "already there".
  const none = RESUMES.none;

  it('keyword "C++" with master skill "C" → no chip', () => {
    // "C" is a word-bounded prefix of "C++"; token equality must still refuse it.
    assert.equal(edits.addableSkillFor('C++', none, onlyC), null);
  });

  it('keyword "C" with master skill "C++" → no chip', () => {
    // The reverse direction: a one-letter keyword must not borrow the longer language.
    assert.equal(edits.addableSkillFor('C', none, onlyCpp), null);
  });

  it('positive controls: each language offers itself, so the two nulls above are not "offers nothing"', () => {
    // Same master as the first null: "C" finds "C".
    assert.equal(edits.addableSkillFor('C', none, onlyC)?.name, 'C');
    // Same master as the second null: "c++" finds "C++" case-insensitively.
    assert.equal(edits.addableSkillFor('c++', none, onlyCpp)?.name, 'C++');
  });
});

/* The second guard, keywordAppearsIn(keyword, name) (review 2026-10-09). Equal tokens are not
 * enough: the producer must also read the added name as covering the keyword, or the chip adds
 * a skill and the keyword stays missing. Every row here is token-equal, so only that guard (and
 * the dropped ".js" token) decides the answer; deleting the guard turns the nulls red. */
describe('addableSkillFor: token-equal is not enough, the producer must agree', () => {
  // One-skill masters, so a null can only mean "this skill was refused", never "another won".
  const only = (name: string) => ({ skills: [{ id: 'skill_x', name, category: 'Misc' }] }) as unknown as Master;
  // Nothing printed, so no null below can come from "already on the resume".
  const none = RESUMES.none;

  it('keyword "Node" with master "Node.js" → chip (the ".js" token is dropped and the producer agrees)', () => {
    // "Node" is word-bounded inside "Node.js", so the add really clears the miss.
    assert.equal(edits.addableSkillFor('Node', none, only('Node.js'))?.name, 'Node.js');
  });

  it('keyword "Node.js" with master "Node" → no chip (adding "Node" leaves "Node.js" missing)', () => {
    // Tokens match after the ".js" drop; only the producer guard refuses it.
    assert.equal(edits.addableSkillFor('Node.js', none, only('Node')), null);
  });

  it('keyword "CI-CD" with master "CI/CD" → no chip (same tokens, the producer reads them apart)', () => {
    // The tokenizer splits both on punctuation; the producer's literal does not.
    assert.equal(edits.addableSkillFor('CI-CD', none, only('CI/CD')), null);
  });

  it('keyword "Go" with master "go" → no chip (case-sensitive vocabulary term)', () => {
    // The producer's "Go" pattern is exact-case, so a lowercase "go" skill would not count.
    assert.equal(edits.addableSkillFor('Go', none, only('go')), null);
  });

  it('positive control: keyword "Go" with master "Go" → chip', () => {
    // Proves the null above is the case rule, not a master shape the function cannot read.
    assert.equal(edits.addableSkillFor('Go', none, only('Go'))?.name, 'Go');
  });
});
