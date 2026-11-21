// Tailor #5 parcel 1 (2026-11-21): the validator as the STRICT READER of the new tailor output fields.
// Truth model (docs/tailor/2026-11-18-tailoring-findings-and-plan.md section 7): the model may now WRITE a bullet,
// pick the Aczen title and write the headline, so code must prove every fact traces to the master. These tests pin:
//   - an AI-written bullet (`sources` present) is judged by provenance: numbers and tech names trace to its sources,
//     and every number of its `ref` bullet survives a shortening (the Stripe case lost "260+", "878 rows", "59%");
//   - a bullet WITHOUT `sources` is judged exactly as before (old rows and today's prompt keep working);
//   - `role_title` is printed only from the allow-list, only on the experience the list names;
//   - a summary with refs but blank text is refused (Gushwork/Revature shipped with no summary).
import { test } from "node:test";
// Strict, so a truthy-but-wrong value never passes.
import assert from "node:assert/strict";
// The unit under test and its exported allow-list.
import { EXPERIENCE_TITLE_ALLOW_LIST, validateTailoredProfile, type TailorViolation } from "./validator.ts";
// The contract types, through the single re-export module.
import type { MasterProfile, TailoredProfile } from "../contracts/shared-types.ts";

// The pinned master version every fixture uses.
const V = 47;
// A bullet node in one line.
const mb = (id: string, text: string) => ({ id, text, tags: [] as string[] });

// A small master shaped like the live one: an allow-listed Aczen entry with metric bullets, a second employer, one project.
function master(): MasterProfile {
  // Fresh object per test, so no test can leak a mutation into another.
  return {
    // Shape marker.
    schema_version: 1,
    // Identity, copied verbatim by the validator.
    identity: { full_name: "Teja Mallam", headline: "Software Engineer", email: "t@example.com", phone: null, location: "Hyderabad", links: [] },
    // The owner's paragraph, citable by a summary.
    summary: { id: "summary-main", text: "Engineer who ships PostgreSQL-backed services." },
    // No education needed for these rules.
    education: [],
    // Two employers: the allow-listed one and one the list does not name.
    experience: [
      {
        // The live id the allow-list keys on.
        id: "exp_aczen",
        company: "Aczen Technologies",
        role: "Full Stack AI Engineer Intern",
        location: "Hyderabad",
        start_display: "Jun 2026",
        end_display: "Present",
        start_date: null,
        end_date: null,
        // Two metric bullets, so a merge and a shortening can both be expressed.
        bullets: [
          mb("b_idx", "Cut query latency 59% on 878 rows by adding PostgreSQL indexes"),
          mb("b_rag", "Built a RAG pipeline with Gemini and pgvector serving 260+ users"),
        ],
      },
      {
        // An employer the title list does not name.
        id: "exp_st",
        company: "Student Tribe",
        role: "Technical Coordinator",
        location: null,
        start_display: "Nov 2024",
        end_display: "Feb 2025",
        start_date: null,
        end_date: null,
        // One bullet, so a cross-parent source is expressible.
        bullets: [mb("b_st", "Coordinated 12 technical workshops for students")],
      },
    ],
    // One project.
    projects: [{ id: "proj_x", name: "Cache Service", links: [], start_display: "2025", end_display: "2025", start_date: null, end_date: null, bullets: [mb("b_px", "Built a Node.js API with Redis caching")] }],
    // Skills: the tech vocabulary a bullet's names are checked against (Docker and Kafka appear in no bullet).
    skills: [
      { id: "s_pg", name: "PostgreSQL", category: "Databases" },
      { id: "s_gem", name: "Gemini", category: "AI" },
      { id: "s_pgv", name: "pgvector", category: "AI" },
      { id: "s_node", name: "Node.js", category: "Backend" },
      { id: "s_redis", name: "Redis", category: "Databases" },
      { id: "s_docker", name: "Docker", category: "DevOps" },
    ],
    // Not needed here.
    achievements: [],
    certifications: [],
    links: [],
  };
}

// A tailoring with one Aczen bullet; each test swaps in what it needs.
function tailoring(bullets: TailoredProfile["experience"][number]["bullets"], extra: Partial<TailoredProfile["experience"][number]> = {}): TailoredProfile {
  // Same shape every time.
  return {
    schema_version: 1,
    master_version: V,
    section_order: ["experience"],
    summary: null,
    skills: [],
    // The Aczen entry with the bullets under test.
    experience: [{ ref: "exp_aczen", bullets, ...extra }],
    projects: [],
    education: [],
    achievements: [],
    certifications: [],
  };
}

// The violation kinds of a result, for compact assertions.
function kinds(result: ReturnType<typeof validateTailoredProfile>): string[] {
  // Empty when ok, so a test can assert "no violations" and "these violations" the same way.
  return result.ok ? [] : result.violations.map((v: TailorViolation) => v.kind);
}

test("an AI-written bullet passes on provenance: new wording, every number and tech name from its source", () => {
  // "Optimized", "reducing" and "across" are not master words: the old word list would refuse them.
  const result = validateTailoredProfile(tailoring([{ ref: "b_idx", sources: ["b_idx"], text: "Optimized PostgreSQL queries, reducing latency 59% across 878 rows" }]), master(), V);
  // Accepted.
  assert.deepEqual(kinds(result), []);
});

test("a bullet WITHOUT sources is judged by today's word rule, unchanged (old rows and today's prompt)", () => {
  // The same text with no sources: the old rule refuses the unbacked words.
  const result = validateTailoredProfile(tailoring([{ ref: "b_idx", text: "Optimized PostgreSQL queries, reducing latency 59% across 878 rows" }]), master(), V);
  // Refused for words, exactly as before this parcel.
  assert.ok(kinds(result).length > 0 && kinds(result).every((k) => k === "unverifiable_token"), JSON.stringify(kinds(result)));
});

test("an AI-written bullet with a number its sources never state is refused (invented_metric)", () => {
  // 65% is not in b_idx.
  const result = validateTailoredProfile(tailoring([{ ref: "b_idx", sources: ["b_idx"], text: "Cut latency 65% on 878 rows with PostgreSQL indexes, 59% before" }]), master(), V);
  // Named with the value.
  assert.ok(!result.ok && result.violations.some((v) => v.kind === "invented_metric" && v.value === "65"), JSON.stringify(result));
});

test("a shortened AI bullet must keep every number of its ref bullet (dropped_metric: the Stripe case)", () => {
  // "878" is gone.
  const result = validateTailoredProfile(tailoring([{ ref: "b_idx", sources: ["b_idx"], text: "Cut PostgreSQL query latency 59% with indexes" }]), master(), V);
  // Named with the dropped value.
  assert.ok(!result.ok && result.violations.some((v) => v.kind === "dropped_metric" && v.value === "878"), JSON.stringify(result));
});

test("a tech name the cited sources never name is refused (untraced_tech), master skill or not", () => {
  // Redis is a master skill but not in b_idx; Kafka is in no master at all.
  const result = validateTailoredProfile(tailoring([{ ref: "b_idx", sources: ["b_idx"], text: "Cut latency 59% on 878 rows with PostgreSQL indexes, Redis and Kafka" }]), master(), V);
  // Both named.
  const named = result.ok ? [] : result.violations.filter((v) => v.kind === "untraced_tech").map((v) => (v as { term: string }).term);
  // Exactly the two.
  assert.deepEqual(named.sort(), ["Kafka", "Redis"]);
});

test("an alias of a sourced tech traces (Postgres = PostgreSQL)", () => {
  // The short form of the source's long form.
  const result = validateTailoredProfile(tailoring([{ ref: "b_idx", sources: ["b_idx"], text: "Cut Postgres query latency 59% on 878 rows with indexes" }]), master(), V);
  // Accepted.
  assert.deepEqual(kinds(result), []);
});

test("a merge traces against every source; the REF bullet's metrics must all survive, a secondary source may be drawn on partially", () => {
  // Draws Gemini (not 260+) from b_rag, and keeps all of b_idx's numbers: honest (keep7 app15/24/29 shape).
  const result = validateTailoredProfile(tailoring([{ ref: "b_idx", sources: ["b_idx", "b_rag"], text: "Cut PostgreSQL latency 59% on 878 rows and built a Gemini RAG pipeline" }]), master(), V);
  // Accepted.
  assert.deepEqual(kinds(result), []);
  // The same merge without the ref's 878: the bullet being rewritten lost a metric (the Stripe case).
  const cut = validateTailoredProfile(tailoring([{ ref: "b_idx", sources: ["b_idx", "b_rag"], text: "Cut PostgreSQL latency 59% and built a Gemini RAG pipeline for 260+ users" }]), master(), V);
  // Named against the ref bullet.
  assert.ok(!cut.ok && cut.violations.some((v) => v.kind === "dropped_metric" && v.ref === "b_idx" && v.value === "878"), JSON.stringify(cut));
});

test("one master bullet split into two printed bullets keeps its metrics across the pair (keep7 app3 shape)", () => {
  // 59% in one half, 878 in the other: each half alone drops a number, the entry keeps both.
  const result = validateTailoredProfile(tailoring([
    { ref: "b_idx", sources: ["b_idx"], text: "Cut PostgreSQL query latency 59% with indexes" },
    { ref: "b_idx", sources: ["b_idx"], text: "Indexed 878 rows in PostgreSQL" },
  ]), master(), V);
  // Accepted.
  assert.deepEqual(kinds(result), []);
});

test("a digit glued to a name (L1, EC2) is not a metric: neither invented nor dropped", () => {
  // A master bullet with a named loss function and a cloud box.
  const m = master();
  // Swapped in through a cast: the fixture is readonly by contract (see validator.test.ts mutableBullets).
  (m.experience[0]!.bullets as { id: string; text: string; tags: string[] }[])[0] = { id: "b_idx", text: "Trained with L1 loss and deployed on EC2", tags: [] };
  // The rewrite drops "L1" and adds nothing numeric.
  const result = validateTailoredProfile(tailoring([{ ref: "b_idx", sources: ["b_idx"], text: "Trained the model and deployed it on EC2" }]), m, V);
  // Accepted: no dropped "1", no "2".
  assert.deepEqual(kinds(result), []);
});

test("sources that omit ref, are empty, name an unknown id, or reach another parent are refused", () => {
  // ref not listed among its own sources.
  assert.ok(kinds(validateTailoredProfile(tailoring([{ ref: "b_idx", sources: ["b_rag"], text: "Built a RAG pipeline with Gemini and pgvector serving 260+ users" }]), master(), V)).includes("invalid_sources"));
  // An empty list cites nothing.
  assert.ok(kinds(validateTailoredProfile(tailoring([{ ref: "b_idx", sources: [], text: "Cut latency 59% on 878 rows by adding PostgreSQL indexes" }]), master(), V)).includes("invalid_sources"));
  // An id that exists nowhere.
  assert.ok(kinds(validateTailoredProfile(tailoring([{ ref: "b_idx", sources: ["b_idx", "b_ghost"], text: "Cut latency 59% on 878 rows by adding PostgreSQL indexes" }]), master(), V)).includes("unresolved_ref"));
  // A real bullet from Student Tribe credited to Aczen: misattribution through the side door.
  assert.ok(kinds(validateTailoredProfile(tailoring([{ ref: "b_idx", sources: ["b_idx", "b_st"], text: "Cut latency 59% on 878 rows by adding PostgreSQL indexes; ran 12 workshops" }]), master(), V)).includes("misattributed_bullet"));
});

test("role_title: an allow-listed Aczen title prints as the role; any other title, or on another employer, is refused", () => {
  // The list holds exactly Teja's four titles (2026-11-18 21:55).
  assert.deepEqual([...EXPERIENCE_TITLE_ALLOW_LIST.exp_aczen!], ["Full Stack AI Engineer Intern", "Software Engineer Intern", "Backend Engineer Intern", "AI Engineer Intern"]);
  // A listed title.
  const ok = validateTailoredProfile(tailoring([{ ref: "b_idx", text: "Cut query latency 59% on 878 rows by adding PostgreSQL indexes" }], { role_title: "Backend Engineer Intern" }), master(), V);
  // Printed as the role, company untouched.
  assert.ok(ok.ok && ok.resume.experience[0]!.role === "Backend Engineer Intern" && ok.resume.experience[0]!.company === "Aczen Technologies", JSON.stringify(ok));
  // The FamPay title: not on the list.
  assert.ok(kinds(validateTailoredProfile(tailoring([{ ref: "b_idx", text: "Cut query latency 59% on 878 rows by adding PostgreSQL indexes" }], { role_title: "Data Analyst Intern" }), master(), V)).includes("disallowed_role_title"));
  // A listed title on an employer the list does not name.
  const other: TailoredProfile = { ...tailoring([]), experience: [{ ref: "exp_st", bullets: [], role_title: "Software Engineer Intern" }] };
  // Refused.
  assert.ok(kinds(validateTailoredProfile(other, master(), V)).includes("disallowed_role_title"));
});

test("a summary with refs but blank text is refused (empty_summary)", () => {
  // Cited, but prints nothing.
  const result = validateTailoredProfile({ ...tailoring([]), summary: { text: "  ", refs: ["summary-main"] } }, master(), V);
  // Named.
  assert.ok(kinds(result).includes("empty_summary"), JSON.stringify(kinds(result)));
});

test("an old row with neither new field resolves byte-identical to what it resolved to before (rebuild equals snapshot)", () => {
  // No sources, no role_title: the shape of every stored tailor_refs before this parcel.
  const result = validateTailoredProfile(tailoring([{ ref: "b_idx", text: "Cut query latency 59% on 878 rows by adding PostgreSQL indexes" }]), master(), V);
  // The exact resolved experience the pre-parcel validator produced: master role, no extra keys anywhere.
  assert.ok(result.ok, JSON.stringify(result));
  // deepEqual tells an absent key from an undefined one, so a stray `sources: undefined` or `role_title` key fails here.
  assert.deepEqual(result.resume.experience, [{
    ref: "exp_aczen",
    company: "Aczen Technologies",
    role: "Full Stack AI Engineer Intern",
    location: "Hyderabad",
    start_display: "Jun 2026",
    end_display: "Present",
    bullets: [{ ref: "b_idx", text: "Cut query latency 59% on 878 rows by adding PostgreSQL indexes", master_text: "Cut query latency 59% on 878 rows by adding PostgreSQL indexes" }],
  }]);
});
