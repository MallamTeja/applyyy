// THE MOST IMPORTANT TEST IN THE REPO (PROJECT_PLAN.md §19). It is the
// load-bearing wall under constraint #2 — "never invent experience, projects,
// skills, technologies, metrics, companies, certifications, education or
// qualifications" — and under §10 defense 1, which says the dishonest output must
// be structurally impossible rather than merely detected.
//
// Written against applyyy-aa's `@applyy/shared-types` contract, not a local copy.
// The §11 worked example is used verbatim as the fixture, so these tests fail the
// day the implementation stops agreeing with the plan's own example.
import { test } from "node:test";
// Strict: a validator that type-coerces is a validator that lets a truthy-but-wrong
// value through.
import assert from "node:assert/strict";
import {
  validateTailoredProfile,
  indexMasterMetrics,
  verifyBulletMetrics,
  isValidCitationRef,
  numbersIn,
} from "./validator.ts";
// aa's contract, reached through this stream's single re-export module.
// `MasterBullet` is imported for one narrow purpose — see `mutableBullets` below.
import type { MasterBullet, MasterProfile, TailoredProfile } from "../contracts/shared-types.ts";

// The version pinned on the application row. Kept separate from the profile JSON
// because that is where aa put it: `master_profiles.version` is a column, and
// `MasterProfile` itself carries only `schema_version`.
const PINNED_VERSION = 7;

// The master profile from §11, transcribed into aa's node shape. Deliberately
// contains no Docker and no PostgreSQL, so every fabrication test below is asking
// for something that genuinely does not exist.
const MASTER: MasterProfile = {
  // aa's shape marker, not the row version.
  schema_version: 1,
  identity: {
    // Copied verbatim into the resolved resume; the Tailor may never touch it.
    full_name: "Teja Mallam",
    headline: "Backend Engineer",
    email: "tejamallam00@gmail.com",
    phone: null,
    location: "Hyderabad",
    links: [],
  },
  education: [
    {
      // One qualification, with one bullet, so education refs are exercised too.
      id: "edu-mlrit",
      institution: "MLR Institute of Technology",
      degree: "B.Tech",
      field: "Computer Science",
      start_display: "2022",
      end_display: "2026",
      start_date: null,
      end_date: null,
      grade_display: "8.4 CGPA",
      bullets: [{ id: "edu-bullet-coursework", text: "Coursework in data structures, databases and operating systems", tags: ["coursework"] }],
    },
  ],
  experience: [
    {
      // A real internship, holding the §11 bullet.
      id: "exp-eventportal",
      company: "College Event Cell",
      role: "Backend Intern",
      location: "Hyderabad",
      start_display: "Jun 2025",
      end_display: "Aug 2025",
      start_date: null,
      end_date: null,
      bullets: [
        {
          // The §11 bullet, verbatim. Every honesty judgement is measured against it.
          id: "bullet-rest-api",
          text: "Built a REST API with Express and Node.js for a college event portal, handling 500 users",
          tags: ["node", "express", "rest"],
        },
      ],
    },
  ],
  projects: [
    {
      // A second parent node, which is what makes the misattribution test possible.
      id: "proj-portfolio",
      name: "Portfolio Site",
      // TWO links, and two is the whole point. This field replaced a single
      // `url: string | null` on 2026-09-11 because a project with both a live
      // deployment and a source repository had one of the two silently discarded on
      // every upload. A fixture carrying only one link would type-check against the
      // new shape while proving nothing the old shape could not also have proved.
      links: [
        { id: "link-portfolio-live", label: "Live", url: "https://tejamallam.dev" },
        { id: "link-portfolio-repo", label: "Source", url: "https://github.com/teja/portfolio" },
      ],
      start_display: "2025",
      end_display: "2025",
      start_date: null,
      end_date: null,
      bullets: [{ id: "bullet-portfolio-react", text: "Built a React portfolio site deployed on Vercel", tags: ["react"] }],
    },
  ],
  // The §11 skills line, one node each so every skill is referenceable.
  skills: [
    { id: "skill-javascript", name: "JavaScript", category: "Languages" },
    { id: "skill-react", name: "React", category: "Frameworks" },
    { id: "skill-node", name: "Node.js", category: "Frameworks" },
    { id: "skill-express", name: "Express", category: "Frameworks" },
    { id: "skill-mongodb", name: "MongoDB", category: "Databases" },
    { id: "skill-git", name: "Git", category: "Tools" },
    { id: "skill-python", name: "Python", category: "Languages" },
  ],
  // The human's own paragraph AS A NODE. Given a real id rather than left null so the
  // "a summary may cite the master summary" test below has something honest to cite;
  // with null here that test could only ever assert a rejection, which is the vacuous
  // half of the pair.
  summary: {
    id: "summary-master",
    text: "Backend-leaning engineer who builds REST APIs in Node.js and ships them.",
  },
  // Two undated award nodes' worth of coverage in one: a bulleted achievement, so the
  // flat bullet index has to reach into this section for the tests below to pass.
  achievements: [
    {
      id: "ach-sih",
      label: "Winner — Smart India Hackathon 2025",
      description: "national finals",
      bullets: [
        {
          id: "ach-bullet-sih",
          text: "Built a REST API prototype in Node.js for the national finals",
          tags: ["node", "rest"],
        },
      ],
    },
  ],
  // A bulleted certification, for the same reason: an empty `bullets` array here
  // would leave the certification half of the bullet index untested.
  certifications: [
    {
      id: "cert-aws-ccp",
      label: "AWS Certified Cloud Practitioner",
      description: "Amazon Web Services",
      bullets: [
        {
          id: "cert-bullet-aws",
          text: "Covered core services and the shared responsibility model",
          tags: ["aws"],
        },
      ],
    },
  ],
  links: [],
};

// A valid baseline tailoring. Every test below is this, minus or plus one thing, so
// a failure isolates the single change rather than the whole fixture.
function baseline(): TailoredProfile {
  return {
    // aa's shape marker.
    schema_version: 1,
    // Matches the pinned version, as it must.
    master_version: PINNED_VERSION,
    // Order is a tailoring decision carried in the data (aa's ORDER CONTRACT).
    section_order: ["skills", "experience", "projects", "education"],
    // Omitted by default: prose is the acknowledged weak point and gets its own tests.
    summary: null,
    // Honest selection of real skills.
    skills: [{ ref: "skill-node" }, { ref: "skill-express" }],
    experience: [
      {
        // A real experience node.
        ref: "exp-eventportal",
        // Holding a rewording of ITS OWN bullet.
        bullets: [{ ref: "bullet-rest-api", text: "Built a REST API with Express and Node.js for a college event portal, handling 500 users" }],
      },
    ],
    // A real project with its own bullet.
    projects: [{ ref: "proj-portfolio", bullets: [{ ref: "bullet-portfolio-react", text: "Built a React portfolio site deployed on Vercel" }] }],
    // A real education node.
    education: [{ ref: "edu-mlrit", bullets: [{ ref: "edu-bullet-coursework", text: "Coursework in data structures, databases and operating systems" }] }],
    // EMPTY BY DEFAULT, AND THAT IS THE DELIBERATE CHOICE. These two arrays became
    // required on `TailoredProfile` on 2026-09-11, so the baseline must state them —
    // but selecting an award here would change what all twenty-six pre-existing tests
    // are validating, and a fixture change that quietly alters unrelated tests is how
    // a suite stops meaning what its names say. The new sections are exercised by the
    // tests that opt into them below.
    achievements: [],
    certifications: [],
  };
}

// Hand back a master node's bullets as a MUTABLE array so a test can deliberately
// construct a profile the contract forbids.
//
// WHY A CAST AND NOT A REWRITE OF THE FIXTURE. `DocumentOrdered<T>` is
// `readonly T[]` — aa's ORDER CONTRACT, which exists so nothing downstream can sort
// a tailoring's document order out from under it. That readonly-ness is exactly
// right for production and exactly wrong for these five tests, whose entire job is
// to build a DEFECTIVE master that a correctly-typed construction site could never
// produce. The cast is the honest way to say "this test is violating the contract on
// purpose"; a mutable parallel fixture would hide that, and would drift from MASTER.
//
// It also matters that this was INVISIBLE until today. `deno check` never saw this
// file — see `supabase/functions/deno.json`'s `exclude` — and `node --test` strips
// types without checking them, so `.push` on a readonly array ran green for as long
// as it has existed. It is a type error, not a runtime one: readonly is erased.
function mutableBullets(node: { readonly bullets: readonly MasterBullet[] }): MasterBullet[] {
  return node.bullets as MasterBullet[];
}

// §11's SAFE edit: same project, same 500 users, same tech, reworded into the JD's
// language. A validator that rejects this is useless, because then nothing tailors.
test("accepts the safe rewrite from the plan's own worked example", () => {
  // The baseline with §11's exact reworded bullet substituted in.
  const tailored = baseline();
  // The rewording printed in §11.
  const result = validateTailoredProfile(
    {
      ...tailored,
      experience: [
        {
          ref: "exp-eventportal",
          bullets: [{ ref: "bullet-rest-api", text: "Designed and shipped a production REST API in Node.js/Express serving 500+ users for a college event platform" }],
        },
      ],
    },
    MASTER,
    PINNED_VERSION,
  );
  // The whole tailoring feature depends on this being accepted.
  assert.equal(result.ok, true, result.ok === false ? JSON.stringify(result.violations) : "");
});

// The baseline itself must pass, or every rejection below proves nothing.
test("accepts an honest baseline tailoring", () => {
  // No modifications at all.
  const result = validateTailoredProfile(baseline(), MASTER, PINNED_VERSION);
  // Positive control for the entire suite.
  assert.equal(result.ok, true, result.ok === false ? JSON.stringify(result.violations) : "");
});

// §11's FABRICATED edit, attempted the only way aa's types still permit: a skill ref
// that does not resolve. "Docker" and "PostgreSQL" are not on the master, so there is
// no id to name — there is no text field in which to write one.
test("rejects a skill ref that does not exist in the master", () => {
  // The model tries to add Docker because the JD asked for it.
  const result = validateTailoredProfile(
    { ...baseline(), skills: [{ ref: "skill-node" }, { ref: "skill-docker" }] },
    MASTER,
    PINNED_VERSION,
  );
  // Rejected outright, before the Auditor ever runs.
  assert.equal(result.ok, false);
  // The dashboard must be able to say WHICH id was invented.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "unresolved_ref" && v.ref === "skill-docker"),
    "expected an unresolved_ref violation naming skill-docker",
  );
});

// The same attack aimed at employment history rather than skills.
test("rejects an experience ref that does not exist in the master", () => {
  // An entire job the model made up.
  const result = validateTailoredProfile(
    { ...baseline(), experience: [{ ref: "exp-google-sre", bullets: [] }] },
    MASTER,
    PINNED_VERSION,
  );
  // Invented experience is constraint #2's first named category.
  assert.equal(result.ok, false);
  // Named precisely so the failure is debuggable from the dashboard.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "unresolved_ref" && v.ref === "exp-google-sre"),
    "expected an unresolved_ref violation naming exp-google-sre",
  );
});

// THE ATTACK THAT AA'S NESTED SHAPE INTRODUCES AND A FLAT REF CHECK MISSES. Both ids
// are real, so a global "does this id exist" lookup waves it straight through — yet
// the result credits work done on a personal project to a named employer. That is
// fabricated experience assembled entirely out of true parts.
test("rejects a real bullet reparented under the wrong master node", () => {
  // The portfolio bullet, moved under the internship.
  const result = validateTailoredProfile(
    {
      ...baseline(),
      experience: [
        {
          // A real employer.
          ref: "exp-eventportal",
          // ...credited with a bullet that belongs to a personal project.
          bullets: [{ ref: "bullet-portfolio-react", text: "Built a React portfolio site deployed on Vercel" }],
        },
      ],
    },
    MASTER,
    PINNED_VERSION,
  );
  // Misattribution is a fabrication even though every id resolves.
  assert.equal(result.ok, false);
  // Distinguished from a nonexistent ref, because the remedy is different: this one
  // means the model is reassembling truth, not inventing it.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "misattributed_bullet" && v.ref === "bullet-portfolio-react"),
    "expected a misattributed_bullet violation",
  );
});

// A bullet id that exists nowhere at all is the simpler sibling of the case above.
test("rejects a bullet ref that exists nowhere in the master", () => {
  // Wholly invented achievement.
  const result = validateTailoredProfile(
    {
      ...baseline(),
      experience: [{ ref: "exp-eventportal", bullets: [{ ref: "bullet-kubernetes", text: "Migrated 40 services to Kubernetes" }] }],
    },
    MASTER,
    PINNED_VERSION,
  );
  // Rejected as an unresolvable reference.
  assert.equal(result.ok, false);
  // Reported as unresolved rather than misattributed.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "unresolved_ref" && v.ref === "bullet-kubernetes"),
    "expected an unresolved_ref violation",
  );
});

// THE GAP THAT REF-CHECKING ALONE LEAVES OPEN. The reference is perfectly valid, but
// the rewording smuggles in a technology the master does not contain.
test("rejects a valid bullet ref whose rewording smuggles in an unbacked technology", () => {
  // Real ref, real project, one word that was never true.
  const result = validateTailoredProfile(
    {
      ...baseline(),
      experience: [
        {
          ref: "exp-eventportal",
          bullets: [{ ref: "bullet-rest-api", text: "Built a REST API with Express, Node.js and Docker for a college event portal, handling 500 users" }],
        },
      ],
    },
    MASTER,
    PINNED_VERSION,
  );
  // This is the case that makes the validator more than a ref lookup.
  assert.equal(result.ok, false);
  // The offending word is reported so a human can judge it in one glance.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "unverifiable_token" && v.token === "docker"),
    "expected an unverifiable_token violation naming docker",
  );
});

// Metrics are named explicitly in constraint #2, and inflating one is the easiest lie
// to tell while sounding entirely plausible.
test("rejects an inflated metric that does not appear in the referenced master bullet", () => {
  // 500 users quietly becomes 5000.
  const result = validateTailoredProfile(
    {
      ...baseline(),
      experience: [
        {
          ref: "exp-eventportal",
          bullets: [{ ref: "bullet-rest-api", text: "Built a REST API with Express and Node.js for a college event portal, handling 5000 users" }],
        },
      ],
    },
    MASTER,
    PINNED_VERSION,
  );
  // An invented metric is a fabrication even when every word around it is true.
  assert.equal(result.ok, false);
  // Reported with the value, because "which number" is a reviewer's first question.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "invented_metric" && v.value === "5000"),
    "expected an invented_metric violation naming 5000",
  );
});

// "500+" is §11's own phrasing and must not be mistaken for a new number.
test("accepts a metric that is only reformatted, not changed", () => {
  // Same claim, different formatting.
  const result = validateTailoredProfile(
    {
      ...baseline(),
      experience: [
        {
          ref: "exp-eventportal",
          bullets: [{ ref: "bullet-rest-api", text: "Built a REST API in Node.js and Express for a college event portal serving 500+ users" }],
        },
      ],
    },
    MASTER,
    PINNED_VERSION,
  );
  // A false positive here would block the plan's own approved rewrite.
  assert.equal(result.ok, true, result.ok === false ? JSON.stringify(result.violations) : "");
});

// Referencing the same master item twice pads the resume with duplicated evidence.
test("rejects a duplicated skill reference", () => {
  // The same skill selected twice.
  const result = validateTailoredProfile(
    { ...baseline(), skills: [{ ref: "skill-node" }, { ref: "skill-node" }] },
    MASTER,
    PINNED_VERSION,
  );
  // Reported rather than silently de-duplicated: silent repair hides a bad prompt.
  assert.equal(result.ok, false);
  // Named so the Tailor prompt can be corrected rather than guessed at.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "duplicate_ref" && v.ref === "skill-node"),
    "expected a duplicate_ref violation",
  );
});

// A resume with no experience, projects or education is not a tailoring result — it
// is a failure that would otherwise pass as "no violations found".
test("rejects a proposal with no substantive sections at all", () => {
  // Skills only.
  const result = validateTailoredProfile(
    { ...baseline(), experience: [], projects: [], education: [] },
    MASTER,
    PINNED_VERSION,
  );
  // Must be a violation, not a vacuous pass.
  assert.equal(result.ok, false);
  // Named distinctly from the fabrication cases, since the remedy differs.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "empty_selection"),
    "expected an empty_selection violation",
  );
});

// The pin is what makes resolution deterministic (§9). A tailoring computed against
// a different master version must not be resolved against this one.
test("rejects a tailoring pinned to a different master version", () => {
  // The model answered against version 6 while the row pins version 7.
  const result = validateTailoredProfile({ ...baseline(), master_version: 6 }, MASTER, PINNED_VERSION);
  // Silently resolving it would produce a resume nobody ever approved.
  assert.equal(result.ok, false);
  // Named so the retry logic can tell this apart from a fabrication.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "master_version_mismatch"),
    "expected a master_version_mismatch violation",
  );
});

// aa flags the summary as the weakest point in the contract: prose cannot be
// constrained by refs the way a bullet can. The non-empty `refs` requirement is the
// mitigation, so it has to be enforced rather than merely documented.
test("rejects a summary that declares no supporting refs", () => {
  // Prose with nothing behind it.
  const result = validateTailoredProfile(
    { ...baseline(), summary: { text: "Backend engineer with production experience", refs: [] } },
    MASTER,
    PINNED_VERSION,
  );
  // An unsupported summary is exactly where "leading a team of five" gets written.
  assert.equal(result.ok, false);
  // Named for the dashboard.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "summary_without_refs"),
    "expected a summary_without_refs violation",
  );
});

// A summary whose refs do not resolve is the same fabrication as an invented bullet.
test("rejects a summary whose refs do not resolve", () => {
  // A ref to a node that does not exist.
  const result = validateTailoredProfile(
    { ...baseline(), summary: { text: "Backend engineer", refs: ["exp-google-sre"] } },
    MASTER,
    PINNED_VERSION,
  );
  // Rejected like any other unresolvable reference.
  assert.equal(result.ok, false);
  // Reported with the offending id.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "unresolved_ref" && v.ref === "exp-google-sre"),
    "expected an unresolved_ref violation for the summary ref",
  );
});

// STRUCTURAL GUARANTEE, made observable. Even on a fully valid tailoring, every
// rendered skill name and category is copied from the MASTER — aa's TailoredSkill has
// no text field, so there is no path by which a model-authored skill string reaches
// the PDF, valid or invalid.
test("renders skill names and categories from the master, never from the model", () => {
  // A valid tailoring selecting one skill.
  const result = validateTailoredProfile(
    { ...baseline(), skills: [{ ref: "skill-mongodb" }] },
    MASTER,
    PINNED_VERSION,
  );
  // Sanity first.
  assert.equal(result.ok, true, result.ok === false ? JSON.stringify(result.violations) : "");
  // Both fields come from the master node.
  assert.deepEqual(
    result.ok === true ? result.resume.skills : null,
    [{ ref: "skill-mongodb", name: "MongoDB", category: "Databases" }],
  );
});

// Identity is copied verbatim and is never a tailoring decision — there is no honest
// reason to reword your own name, and aa's type gives the Tailor no way to try.
test("copies identity verbatim from the master into the resolved resume", () => {
  // Any valid tailoring.
  const result = validateTailoredProfile(baseline(), MASTER, PINNED_VERSION);
  // Identity is passed through untouched.
  assert.deepEqual(result.ok === true ? result.resume.identity : null, MASTER.identity);
});

// The resolved bullet must carry the master text alongside the rewording, because the
// §15 diff view renders master-vs-tailored side by side and must not re-look-it-up.
test("resolved bullets carry the master text for the approval diff", () => {
  // Baseline, whose experience bullet is an exact copy of the master text.
  const result = validateTailoredProfile(baseline(), MASTER, PINNED_VERSION);
  // The resolved node exposes both halves of the diff.
  assert.equal(
    result.ok === true ? result.resume.experience[0]?.bullets[0]?.master_text : null,
    "Built a REST API with Express and Node.js for a college event portal, handling 500 users",
  );
});

// The artifact records which master version produced it, or §9 resume pinning and the
// Auditor's verdict both lose their meaning.
test("stamps the resolved resume with the pinned master version", () => {
  // Any valid tailoring.
  const result = validateTailoredProfile(baseline(), MASTER, PINNED_VERSION);
  // The version travels with the artifact.
  assert.equal(result.ok === true ? result.resume.master_version : null, PINNED_VERSION);
});

// Every violation must be reported in one pass. Returning only the first would make
// fixing a bad prompt an iterative guessing game.
test("reports every violation in a single pass rather than stopping at the first", () => {
  // Three independent problems: a bad version, an invented skill, an invented job.
  const result = validateTailoredProfile(
    {
      ...baseline(),
      master_version: 6,
      skills: [{ ref: "skill-docker" }],
      experience: [{ ref: "exp-google-sre", bullets: [] }],
    },
    MASTER,
    PINNED_VERSION,
  );
  // Rejected, obviously.
  assert.equal(result.ok, false);
  // All three surfaced together rather than one at a time.
  assert.equal(result.ok === false ? result.violations.length : 0, 3);
});

// ---------------------------------------------------------------------------------
// AMBIGUOUS MASTER IDS — the guard that keeps the misattribution check meaningful.
//
// `indexBullets` builds ONE FLAT MAP keyed by bullet id across experience, projects
// and education, and a `Map` overwrites. Without the guard, two bullets sharing an id
// mean the later silently replaces the earlier, and the parent-scope check then
// compares against THE WRONG PARENT — so a genuinely misattributed bullet can pass, or
// an honest one be flagged, decided by indexing order. Nothing errors. The tailoring
// looks clean and the Auditor reports clean.
//
// THE DESIGN THESE TESTS MUST DISCRIMINATE. The plausible wrong answer is PER-SECTION
// uniqueness, and it reads as more sensible than global uniqueness. It catches the
// mistake people actually make — a duplicate within one employer — and still leaves
// the audit corruptible, because the collision it misses is the SAME id under two
// DIFFERENT parents, which is precisely the one a flat index cannot survive.
//
// So the within-section case below is the NON-discriminating one: both designs catch
// it, and a suite containing only that case would pass under the broken design. The
// cross-parent cases are the ones that tell the two apart, and they are marked.

// Deep-clone the master so a mutation in one test cannot leak into another. The
// fixture is a module-level constant, so mutating it in place would make these tests
// order-dependent — which is its own class of untrustworthy green.
function masterClone(): MasterProfile {
  return structuredClone(MASTER);
}

// NON-DISCRIMINATING (per-section uniqueness also catches this). Included anyway
// because it is the most common real defect: the way anyone adds a bullet is to copy
// the one above it.
test("two bullets with the same id under the SAME parent refuse the tailoring", () => {
  // Clone and duplicate a bullet id within one experience node.
  const master = masterClone();
  mutableBullets(master.experience[0]!).push({ id: "bullet-rest-api", text: "A second bullet reusing the id", tags: [] });
  // Validate an otherwise-perfectly-honest tailoring.
  const result = validateTailoredProfile(baseline(), master, PINNED_VERSION);
  // Refused.
  assert.equal(result.ok, false);
  if (result.ok) return;
  // And refused for the right reason.
  assert.equal(result.violations[0]?.kind, "ambiguous_master_ids");
});

// DISCRIMINATING. Per-section uniqueness passes this and leaves the audit corruptible.
// This is the exact collision that makes the flat index return the wrong parent, so it
// is the case the whole guard exists for.
test("the same bullet id under two DIFFERENT parents refuses the tailoring", () => {
  // Clone and place the experience bullet's id under the project node too.
  const master = masterClone();
  mutableBullets(master.projects[0]!).push({ id: "bullet-rest-api", text: "A project bullet stealing the id", tags: [] });
  // Validate.
  const result = validateTailoredProfile(baseline(), master, PINNED_VERSION);
  // Refused — under a per-section design this would pass and the parent lookup would
  // silently resolve to whichever node was indexed last.
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.violations[0]?.kind, "ambiguous_master_ids");
  // The colliding id is named, so the fix is one edit rather than a hunt.
  const violation = result.violations[0];
  assert.equal(violation?.kind === "ambiguous_master_ids" && violation.ids.includes("bullet-rest-api"), true);
});

// DISCRIMINATING. `resolveBullet` compares `found.parentRef` against the parent the
// model nested the bullet under, so two PARENTS sharing an id defeats that comparison
// just as thoroughly as two bullets do — and a per-section checker never looks here.
test("an experience node and a project node sharing an id refuse the tailoring", () => {
  // Clone and collide the two parent ids.
  const master = masterClone();
  master.projects[0]!.id = "exp-eventportal";
  // Validate.
  const result = validateTailoredProfile(baseline(), master, PINNED_VERSION);
  // Refused.
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.violations[0]?.kind, "ambiguous_master_ids");
});

// DISCRIMINATING. A bullet id colliding with its own parent's id is not caught by any
// per-section rule that treats parents and bullets as separate namespaces.
test("a bullet id colliding with a parent id refuses the tailoring", () => {
  // Clone and give a bullet the same id as an education node.
  const master = masterClone();
  master.education[0]!.bullets[0]!.id = "edu-mlrit";
  // Validate.
  const result = validateTailoredProfile(baseline(), master, PINNED_VERSION);
  // Refused.
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.violations[0]?.kind, "ambiguous_master_ids");
});

// A skill colliding with a bullet is NOT exploitable today — skills resolve through
// their own map and a bullet ref never reaches it. Refused anyway, because an id space
// that is ambiguous to a human reading a provenance footer is a latent hazard, and
// "every id in the master is unique" is a rule worth stating without a footnote.
test("a skill id colliding with a bullet id refuses the tailoring", () => {
  // Clone and collide a skill with the §11 bullet.
  const master = masterClone();
  master.skills[0]!.id = "bullet-rest-api";
  // Validate.
  const result = validateTailoredProfile(baseline(), master, PINNED_VERSION);
  // Refused.
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.violations[0]?.kind, "ambiguous_master_ids");
});

// THE REFUSAL MUST BE TOTAL, NOT ADVISORY. A validator that reports the ambiguity and
// then carries on has produced a verdict it cannot support — worse than no check,
// because "clean" now carries the authority of a check that did not actually hold.
test("an ambiguous master refuses outright rather than reporting alongside other findings", () => {
  // A master that is ambiguous AND a tailoring that is separately dishonest, so a
  // validator that carried on would certainly emit more than one violation.
  const master = masterClone();
  mutableBullets(master.projects[0]!).push({ id: "bullet-rest-api", text: "collision", tags: [] });
  // A tailoring that also references a skill that does not exist.
  const dishonest = baseline();
  const result = validateTailoredProfile({ ...dishonest, skills: [{ ref: "skill-docker-invented" }] }, master, PINNED_VERSION);
  // Refused.
  assert.equal(result.ok, false);
  if (result.ok) return;
  // EXACTLY ONE violation, and it is the ambiguity. Nothing else ran, because nothing
  // else could have been trusted.
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]?.kind, "ambiguous_master_ids");
});

// The guard must not fire on a healthy profile, or it would refuse every tailoring
// and present as "the Tailor is broken". A check that always fails proves nothing.
test("a master with all-unique ids still validates normally", () => {
  // The untouched fixture.
  const result = validateTailoredProfile(baseline(), MASTER, PINNED_VERSION);
  // Accepted, as before the guard existed.
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// THE 2026-09-11 CONTRACT CHANGE: project links, achievements, certifications,
// and the master summary as a citable node.
//
// WHY THESE ARE GROUPED AND CALLED OUT. Every test above this line ran GREEN
// against the OLD contract and would have kept running green against the new one:
// `supabase/functions/deno.json` excludes `**/*.test.ts` from `deno check`, and
// `node --test` strips types without checking them, so a `MasterProfile` literal
// here can disagree with the contract in every field and still report pass. The
// fixture was in fact wrong — `url: null` on a project, no `summary`, no
// `achievements`, no `certifications` — and nothing said so. These tests therefore
// assert BEHAVIOUR for the new shape rather than relying on the shape being checked.
// ---------------------------------------------------------------------------

// A tailoring that selects the award sections. Separate from `baseline()` so the
// twenty-six tests above keep validating exactly what their names say.
function withAwards(): TailoredProfile {
  return {
    // Start from the honest baseline, so a failure here is about the awards only.
    ...baseline(),
    // Realistic order. The validator does not police `section_order` against the
    // selection, but a fixture that named sections it did not select would model a
    // Tailor response nobody would ever see.
    section_order: ["skills", "experience", "projects", "education", "achievements", "certifications"],
    // A REWORDED achievement bullet rather than a verbatim one, because verbatim
    // text passes the vocabulary check trivially and would not prove the award
    // sections go through the same honesty machinery as everything else. Every
    // added word is either in the master bullet or in the closed rhetorical set.
    achievements: [
      {
        ref: "ach-sih",
        bullets: [{ ref: "ach-bullet-sih", text: "Designed and built a REST API prototype in Node.js for the national finals" }],
      },
    ],
    // Verbatim, so this half isolates resolution from rewording.
    certifications: [
      {
        ref: "cert-aws-ccp",
        bullets: [{ ref: "cert-bullet-aws", text: "Covered core services and the shared responsibility model" }],
      },
    ],
  };
}

// THE POSITIVE CONTROL FOR BOTH NEW LOOPS, and the non-vacuity twin every rejection
// below depends on. Without it, a validator that refused every achievement would
// satisfy all five rejection tests that follow.
test("accepts a tailoring that selects a real achievement and a real certification", () => {
  // The honest selection.
  const result = validateTailoredProfile(withAwards(), MASTER, PINNED_VERSION);
  // Accepted, or the award sections are unusable and the contract change bought nothing.
  assert.equal(result.ok, true, result.ok === false ? JSON.stringify(result.violations) : "");
});

// THE STRUCTURAL GUARANTEE THAT `TailoredAchievement` CARRIES NO `label`. The type
// makes "International Winner" inexpressible; this asserts the validator actually
// materialises the master's wording rather than leaving the field blank or echoing
// something the model supplied.
test("renders achievement and certification labels from the master, never from the model", () => {
  // Resolve the honest selection.
  const result = validateTailoredProfile(withAwards(), MASTER, PINNED_VERSION);
  // Must have succeeded to inspect the artifact.
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // The award's label and qualifying detail, byte-for-byte from the master node.
  assert.equal(result.resume.achievements[0]?.label, "Winner — Smart India Hackathon 2025");
  assert.equal(result.resume.achievements[0]?.description, "national finals");
  // And the credential's.
  assert.equal(result.resume.certifications[0]?.label, "AWS Certified Cloud Practitioner");
  assert.equal(result.resume.certifications[0]?.description, "Amazon Web Services");
});

// The award bullets must reach the resolved resume carrying their master text, like
// every other bullet — otherwise the §15 approval diff has nothing to show for these
// two sections and a reviewer cannot see what was reworded.
test("resolves award bullets with their master text for the approval diff", () => {
  // Resolve.
  const result = validateTailoredProfile(withAwards(), MASTER, PINNED_VERSION);
  // Must have succeeded.
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // The rewording prints.
  assert.equal(
    result.resume.achievements[0]?.bullets[0]?.text,
    "Designed and built a REST API prototype in Node.js for the national finals",
  );
  // And the original travels with it.
  assert.equal(
    result.resume.achievements[0]?.bullets[0]?.master_text,
    "Built a REST API prototype in Node.js for the national finals",
  );
  // The certification half too, so a regression in one loop cannot hide behind the other.
  assert.equal(result.resume.certifications[0]?.bullets[0]?.master_text, "Covered core services and the shared responsibility model");
});

// `ResolvedResume.achievements` and `.certifications` are REQUIRED arrays, so the
// renderer may iterate them without a guard. An omitted field and an empty array are
// the same value to `.length` but not to `for..of`, and the crash would land in the
// PDF worker rather than here.
test("the resolved resume always carries achievements and certifications arrays", () => {
  // The baseline selects neither.
  const result = validateTailoredProfile(baseline(), MASTER, PINNED_VERSION);
  // Accepted.
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Present and empty, not absent.
  assert.deepEqual(result.resume.achievements, []);
  assert.deepEqual(result.resume.certifications, []);
});

// THE REGRESSION THAT MOTIVATED REPLACING `url: string | null`. A project with a live
// deployment AND a source repository had one of the two silently discarded on every
// upload. Asserting the COUNT is what makes this test fail under the old single-slot
// shape; asserting only that a link survived would pass under both.
test("carries every project link into the resolved resume, not just the first", () => {
  // Resolve the honest baseline, whose project has two links.
  const result = validateTailoredProfile(baseline(), MASTER, PINNED_VERSION);
  // Accepted.
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Both addresses survive resolution.
  assert.equal(result.resume.projects[0]?.links.length, 2);
  // With their labels, which is why a bare `string[]` would not have been enough —
  // the renderer has to print "Live" and "Source", not two naked URLs.
  assert.deepEqual(
    result.resume.projects[0]?.links.map((link) => link.label),
    ["Live", "Source"],
  );
  // And their ids, which is what lets `master-ingest` reconcile a link across
  // re-uploads instead of treating an unchanged GitHub URL as a new link.
  assert.deepEqual(
    result.resume.projects[0]?.links.map((link) => link.id),
    ["link-portfolio-live", "link-portfolio-repo"],
  );
});

// An award the master does not contain. §10's "add Docker" case aimed at the section
// where it is cheapest to lie: an achievement line is a bare superlative with no
// surrounding context to contradict it.
test("rejects an achievement ref that does not exist in the master", () => {
  // A hackathon win that never happened.
  const result = validateTailoredProfile(
    { ...withAwards(), achievements: [{ ref: "ach-google-summer-of-code", bullets: [] }] },
    MASTER,
    PINNED_VERSION,
  );
  // Refused before the Auditor ever runs.
  assert.equal(result.ok, false);
  // Named, and named with its SECTION, so the dashboard can point at the award list
  // rather than reporting an anonymous bad id.
  assert.ok(
    result.ok === false &&
      result.violations.some((v) => v.kind === "unresolved_ref" && v.ref === "ach-google-summer-of-code" && v.where === "achievements"),
    "expected an unresolved_ref violation naming ach-google-summer-of-code under achievements",
  );
});

// Constraint #2 names certifications explicitly, and this is that clause.
test("rejects a certification ref that does not exist in the master", () => {
  // A credential the candidate does not hold.
  const result = validateTailoredProfile(
    { ...withAwards(), certifications: [{ ref: "cert-aws-solutions-architect", bullets: [] }] },
    MASTER,
    PINNED_VERSION,
  );
  // Refused.
  assert.equal(result.ok, false);
  // Named with its own section, distinct from achievements — the two resolve through
  // separate maps precisely so a certification ref cannot land on an achievement.
  assert.ok(
    result.ok === false &&
      result.violations.some((v) => v.kind === "unresolved_ref" && v.ref === "cert-aws-solutions-architect" && v.where === "certifications"),
    "expected an unresolved_ref violation naming cert-aws-solutions-architect under certifications",
  );
});

// The two sections must not share a namespace. A certification ref naming a real
// ACHIEVEMENT is every id being real and the resume still being wrong — the same
// family as the misattributed bullet, one level up.
//
// BUILT ON `baseline()` RATHER THAN `withAwards()`, AND THE FIRST DRAFT GOT THIS
// WRONG — worth recording, because the wrong version still FAILED and so still
// looked like a passing rejection test at a glance. `withAwards()` already selects
// `ach-sih` under achievements, and `seenRefs` is ONE set shared by every section
// (see the note on it in the validator), so the second mention fired `duplicate_ref`
// and `continue`d before the resolution check ran at all. The test would have been
// refused for the right verdict and the wrong reason — verification-traps' rule
// about capturing the failure text rather than the fact of failure, in miniature.
test("rejects a certification ref that names an achievement", () => {
  // A real id, in the wrong section, and mentioned exactly once in the whole
  // tailoring so nothing but the section mismatch can explain the refusal.
  const result = validateTailoredProfile(
    { ...baseline(), certifications: [{ ref: "ach-sih", bullets: [] }] },
    MASTER,
    PINNED_VERSION,
  );
  // Refused, because `certificationsById` never contains it.
  assert.equal(result.ok, false);
  // And reported as an unresolved ref under certifications.
  assert.ok(
    result.ok === false &&
      result.violations.some((v) => v.kind === "unresolved_ref" && v.ref === "ach-sih" && v.where === "certifications"),
    "expected ach-sih to be unresolvable as a certification",
  );
});

// The same award listed twice reads on the page as two separate placings.
test("rejects a duplicated achievement reference", () => {
  // The honest selection, with its one award repeated.
  const tailored = withAwards();
  // Same ref twice.
  const result = validateTailoredProfile(
    { ...tailored, achievements: [...tailored.achievements, ...tailored.achievements] },
    MASTER,
    PINNED_VERSION,
  );
  // Refused rather than silently collapsed — a silent repair hides a bad prompt.
  assert.equal(result.ok, false);
  // Reported with the section, like every other duplicate.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "duplicate_ref" && v.ref === "ach-sih" && v.where === "achievements"),
    "expected a duplicate_ref violation naming ach-sih under achievements",
  );
});

// THE TEST THAT PROVES `indexBullets` REACHES INTO THE AWARD SECTIONS, and it is
// built to discriminate rather than merely to fail. `ach-bullet-sih` is nested under
// the EXPERIENCE node: if achievement bullets are indexed, the lookup succeeds and
// the parent comparison fires `misattributed_bullet`; if they are NOT indexed, the
// lookup misses and the result is `unresolved_ref` instead. Asserting the exact kind
// is what tells those two worlds apart — "it was refused" would not.
test("an achievement bullet nested under an employer is misattributed, not merely unresolved", () => {
  // Credit a hackathon line to a named employer.
  const result = validateTailoredProfile(
    {
      ...withAwards(),
      experience: [
        {
          ref: "exp-eventportal",
          bullets: [{ ref: "ach-bullet-sih", text: "Built a REST API prototype in Node.js for the national finals" }],
        },
      ],
    },
    MASTER,
    PINNED_VERSION,
  );
  // Refused.
  assert.equal(result.ok, false);
  if (result.ok) return;
  // Specifically as a misattribution, which is only possible if the bullet resolved.
  assert.ok(
    result.violations.some((v) => v.kind === "misattributed_bullet" && v.ref === "ach-bullet-sih"),
    `expected misattributed_bullet, got ${JSON.stringify(result.violations)}`,
  );
  // And explicitly NOT as an unresolved ref, which is the symptom of an index that
  // never walked the achievements array.
  assert.equal(
    result.violations.some((v) => v.kind === "unresolved_ref" && v.ref === "ach-bullet-sih"),
    false,
    "ach-bullet-sih must be IN the bullet index; an unresolved_ref here means indexBullets skipped achievements",
  );
});

// The certification half of the same proof, because two loops written from the same
// template still fail independently.
test("a certification bullet nested under an employer is misattributed, not merely unresolved", () => {
  // Credit a course line to a named employer.
  const result = validateTailoredProfile(
    {
      ...withAwards(),
      experience: [
        {
          ref: "exp-eventportal",
          bullets: [{ ref: "cert-bullet-aws", text: "Covered core services and the shared responsibility model" }],
        },
      ],
    },
    MASTER,
    PINNED_VERSION,
  );
  // Refused.
  assert.equal(result.ok, false);
  if (result.ok) return;
  // As a misattribution, proving certification bullets are in the index too.
  assert.ok(
    result.violations.some((v) => v.kind === "misattributed_bullet" && v.ref === "cert-bullet-aws"),
    `expected misattributed_bullet, got ${JSON.stringify(result.violations)}`,
  );
});

// THE TEST THAT PROVES `findDuplicateMasterIds` WALKS THE AWARD SECTIONS. Adding the
// resolution loops without extending this guard would have put the newest and least
// examined section into the flat bullet index with no uniqueness check behind it —
// reopening, in a fresh place, the exact hole the guard exists to close.
test("an achievement id colliding with an experience id refuses the tailoring", () => {
  // Clone and collide the award with the employer.
  const master = masterClone();
  master.achievements[0]!.id = "exp-eventportal";
  // Validate an otherwise-perfectly-honest tailoring.
  const result = validateTailoredProfile(baseline(), master, PINNED_VERSION);
  // Refused outright.
  assert.equal(result.ok, false);
  if (result.ok) return;
  // For the ambiguity, not for anything about the tailoring.
  assert.equal(result.violations[0]?.kind, "ambiguous_master_ids");
});

// The bullet-level version, which is the collision that actually corrupts the index:
// a certification bullet sharing an id with an experience bullet silently reparents
// one of the two, after which the misattribution check compares against the wrong
// parent and reports clean.
test("a certification bullet id colliding with an experience bullet id refuses the tailoring", () => {
  // Clone and steal the §11 bullet's id for a certification bullet.
  const master = masterClone();
  mutableBullets(master.certifications[0]!).push({ id: "bullet-rest-api", text: "A certification bullet stealing the id", tags: [] });
  // Validate.
  const result = validateTailoredProfile(baseline(), master, PINNED_VERSION);
  // Refused.
  assert.equal(result.ok, false);
  if (result.ok) return;
  // Named, so the fix is one edit rather than a hunt.
  assert.equal(result.violations[0]?.kind, "ambiguous_master_ids");
  const violation = result.violations[0];
  assert.equal(violation?.kind === "ambiguous_master_ids" && violation.ids.includes("bullet-rest-api"), true);
});

// THE POINT OF `MasterSummary` EXISTING AT ALL. Before the summary had an id, the
// one source a summary most obviously draws on was the one thing it could not cite,
// so "reword the paragraph I wrote" was indistinguishable from "invent a paragraph".
// If this ref is not accepted here, the contract change is inert.
test("a summary may cite the master summary node", () => {
  // An honest summary declaring the human's own paragraph as its source.
  const result = validateTailoredProfile(
    { ...baseline(), summary: { text: "Backend engineer who builds REST APIs in Node.js.", refs: ["summary-master"] } },
    MASTER,
    PINNED_VERSION,
  );
  // Accepted.
  assert.equal(result.ok, true, result.ok === false ? JSON.stringify(result.violations) : "");
});

// THE TWIN. The test above alone would pass against a checker that accepted every
// summary ref, which is the failure mode a rejection-free test cannot see. This one
// differs from it in exactly one character sequence — the id — and must be refused.
test("rejects a summary citing an id that resembles the master summary but is not it", () => {
  // One character off from a real node, which is what a hallucinated id looks like.
  const result = validateTailoredProfile(
    { ...baseline(), summary: { text: "Backend engineer who builds REST APIs in Node.js.", refs: ["summary-mastr"] } },
    MASTER,
    PINNED_VERSION,
  );
  // Refused.
  assert.equal(result.ok, false);
  // Reported as an unresolved ref in the summary's metadata, where it is hardest to spot.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "unresolved_ref" && v.ref === "summary-mastr"),
    "expected an unresolved_ref violation naming summary-mastr",
  );
});

// A summary that cannot cite an award is a summary forced to leave its strongest
// evidence undeclared, which pushes the honest case toward the empty-refs violation.
test("a summary may cite an achievement and a certification", () => {
  // Both award sections named as sources.
  const result = validateTailoredProfile(
    { ...baseline(), summary: { text: "Hackathon winner and certified cloud practitioner.", refs: ["ach-sih", "cert-aws-ccp"] } },
    MASTER,
    PINNED_VERSION,
  );
  // Accepted.
  assert.equal(result.ok, true, result.ok === false ? JSON.stringify(result.violations) : "");
});

// A resume that is one credential line and nothing else is a FAILED tailoring, not a
// minimal one. Recorded as a test because the tempting change while adding the award
// loops is to count them as substance, and that would quietly weaken the guard.
test("awards alone do not satisfy the substantive-selection check", () => {
  // Every real section emptied, awards kept.
  const tailored = withAwards();
  const result = validateTailoredProfile(
    { ...tailored, experience: [], projects: [], education: [] },
    MASTER,
    PINNED_VERSION,
  );
  // Refused.
  assert.equal(result.ok, false);
  // For emptiness specifically, not for anything about the awards.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "empty_selection"),
    "expected an empty_selection violation",
  );
});

// --- PRE-LLM AND POST-LLM DETERMINISTIC METRIC SENTINELS (3b) -------------------

test("indexMasterMetrics extracts and indexes all metrics from master profile (Pre-LLM Sentinel)", () => {
  const index = indexMasterMetrics(MASTER);

  // bullet-rest-api contains "500"
  const restMetrics = index.get("bullet-rest-api");
  assert.ok(restMetrics);
  assert.equal(restMetrics.has("500"), true);
  assert.equal(restMetrics.size, 1);

  // ach-bullet-sih exists in index and has 0 numbers
  const achMetrics = index.get("ach-bullet-sih");
  assert.ok(achMetrics);
  assert.equal(achMetrics.size, 0);
});

test("verifyBulletMetrics detects metric alterations and allows reformatted metrics (Post-LLM Sentinel)", () => {
  const masterText = "Built a high-throughput API handling 500 users with 99.9% uptime and $10,000 cost savings";

  // Reformatting and preserving numbers is valid
  const honestRewrite = "Engineered a high-availability API serving 500+ users with 99.9% availability";
  const honestCheck = verifyBulletMetrics(honestRewrite, masterText);
  assert.equal(honestCheck.valid, true);
  assert.deepEqual(honestCheck.inventedMetrics, []);

  // Inflating 500 to 5000 is caught
  const inflatedRewrite = "Built an API handling 5,000 users with 99.9% uptime";
  const inflatedCheck = verifyBulletMetrics(inflatedRewrite, masterText);
  assert.equal(inflatedCheck.valid, false);
  assert.deepEqual(inflatedCheck.inventedMetrics, ["5000"]);

  // Inventing an ungrounded metric (e.g. 50% improvement) is caught
  const inventedRewrite = "Built an API handling 500 users, improving performance by 50%";
  const inventedCheck = verifyBulletMetrics(inventedRewrite, masterText);
  assert.equal(inventedCheck.valid, false);
  assert.deepEqual(inventedCheck.inventedMetrics, ["50"]);
});

// --- REINFORCED FORCED CITATION REFERENCES (3c) -----------------------------------

test("isValidCitationRef validates non-empty string references", () => {
  assert.equal(isValidCitationRef("exp-1"), true);
  assert.equal(isValidCitationRef("bullet-123"), true);
  assert.equal(isValidCitationRef(""), false);
  assert.equal(isValidCitationRef("   "), false);
  assert.equal(isValidCitationRef(null), false);
  assert.equal(isValidCitationRef(undefined), false);
  assert.equal(isValidCitationRef(123), false);
});

test("rejects an empty or whitespace ref string across profile sections", () => {
  // Empty skill ref
  const emptySkillResult = validateTailoredProfile(
    { ...baseline(), skills: [{ ref: "   " }] },
    MASTER,
    PINNED_VERSION,
  );
  assert.equal(emptySkillResult.ok, false);
  assert.ok(
    emptySkillResult.ok === false &&
      emptySkillResult.violations.some((v) => v.kind === "unresolved_ref" && v.where === "skills"),
  );

  // Whitespace experience bullet ref
  const emptyBulletResult = validateTailoredProfile(
    {
      ...baseline(),
      experience: [
        {
          ref: "exp-eventportal",
          bullets: [{ ref: "", text: "Built API" }],
        },
      ],
    },
    MASTER,
    PINNED_VERSION,
  );
  assert.equal(emptyBulletResult.ok, false);
  assert.ok(
    emptyBulletResult.ok === false &&
      emptyBulletResult.violations.some((v) => v.kind === "unresolved_ref" && v.where === "bullet under exp-eventportal"),
  );
});

test("rejects duplicate citation references in summary.refs", () => {
  const result = validateTailoredProfile(
    {
      ...baseline(),
      summary: {
        text: "Passionate backend engineer with proven project delivery.",
        refs: ["exp-eventportal", "exp-eventportal"],
      },
    },
    MASTER,
    PINNED_VERSION,
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.ok === false &&
      result.violations.some((v) => v.kind === "duplicate_ref" && v.where === "summary refs" && v.ref === "exp-eventportal"),
    "expected duplicate_ref violation for summary refs",
  );
});


// ---------------------------------------------------------------------------
// LIVE-SHAPED AWARD SECTIONS. The live master holds 2 achievements (one bullet each,
// ids like `ach_*` / `bullet_ach_*`) and 3 certifications with NO bullets (`cert_*`).
// The tests above use one of each with bullets, so the bullet-less credential — the
// commonest real case — was never exercised. Ids mirror the live naming; every piece
// of text is synthetic, because the real profile is personal data.
// ---------------------------------------------------------------------------

// MASTER with its award sections replaced by the live shape.
const LIVE_SHAPED_MASTER: MasterProfile = {
  // Everything else unchanged, so a failure is about the award sections only.
  ...MASTER,
  // Two awards, each with exactly one bullet, as live.
  achievements: [
    // A ranking-style award.
    { id: "ach_contest", label: "Synthetic contest rating 1800", description: null, bullets: [{ id: "bullet_ach_contest", text: "Solved 300 synthetic problems", tags: [] }] },
    // A hackathon-style award.
    { id: "ach_hackathon", label: "Finalist — Synthetic Hackathon", description: "national round", bullets: [{ id: "bullet_ach_hackathon", text: "Built a Node.js prototype in 36 hours", tags: [] }] },
  ],
  // Three credentials with NO bullets, as live.
  certifications: [
    // Database credential.
    { id: "cert_sql", label: "Synthetic SQL Basics", description: "Example Academy", bullets: [] },
    // Prompting credential.
    { id: "cert_prompting", label: "Synthetic Prompt Design", description: "Example Academy", bullets: [] },
    // ML credential.
    { id: "cert_ml", label: "Synthetic ML Foundations", description: null, bullets: [] },
  ],
};

// The baseline plus a live-shaped award selection: one achievement with its own bullet
// verbatim, and two bullet-less certifications.
function withLiveShapedAwards(): TailoredProfile {
  return {
    // Honest baseline, so the awards are the only variable.
    ...baseline(),
    // Ordered as a real response would order them, using the two new section names.
    section_order: ["skills", "experience", "projects", "education", "achievements", "certifications"],
    // One award, its bullet unchanged so the vocabulary check passes trivially and the
    // verdict is about resolution.
    achievements: [{ ref: "ach_hackathon", bullets: [{ ref: "bullet_ach_hackathon", text: "Built a Node.js prototype in 36 hours" }] }],
    // Two credentials, empty bullets, exactly what the live master can offer.
    certifications: [{ ref: "cert_sql", bullets: [] }, { ref: "cert_ml", bullets: [] }],
  };
}

test("live-shaped: an achievement and bullet-less certifications selected by real ref validate clean", () => {
  // The honest live-shaped selection.
  const result = validateTailoredProfile(withLiveShapedAwards(), LIVE_SHAPED_MASTER, PINNED_VERSION);
  // Accepted, with the violations printed if not, so a failure says why.
  assert.equal(result.ok, true, result.ok === false ? JSON.stringify(result.violations) : "");
  if (!result.ok) return;
  // Labels come from the master, in the selected order.
  assert.deepEqual(result.resume.certifications.map((c) => c.label), ["Synthetic SQL Basics", "Synthetic ML Foundations"]);
  // The award resolved with its own bullet's master text.
  assert.equal(result.resume.achievements[0]?.bullets[0]?.master_text, "Built a Node.js prototype in 36 hours");
});

test("live-shaped: a certification ref naming a real achievement id is refused as unresolved under certifications", () => {
  // `ach_contest` is real but an ACHIEVEMENT, and it is mentioned nowhere else in the
  // tailoring, so the duplicate-ref check cannot pre-empt the section check.
  const result = validateTailoredProfile(
    { ...withLiveShapedAwards(), certifications: [{ ref: "ach_contest", bullets: [] }] },
    LIVE_SHAPED_MASTER,
    PINNED_VERSION,
  );
  // Refused.
  assert.equal(result.ok, false);
  // With the specific violation: that id, unresolvable in the certifications namespace.
  assert.ok(
    result.ok === false &&
      result.violations.some((v) => v.kind === "unresolved_ref" && v.ref === "ach_contest" && v.where === "certifications"),
    result.ok === false ? JSON.stringify(result.violations) : "expected a refusal",
  );
});

test("live-shaped: a certification ref absent from the master is refused as unresolved under certifications", () => {
  // Shaped like the live ids, held by nobody.
  const result = validateTailoredProfile(
    { ...withLiveShapedAwards(), certifications: [{ ref: "cert_cloud_architect", bullets: [] }] },
    LIVE_SHAPED_MASTER,
    PINNED_VERSION,
  );
  // Refused.
  assert.equal(result.ok, false);
  // Named, with its section.
  assert.ok(
    result.ok === false &&
      result.violations.some((v) => v.kind === "unresolved_ref" && v.ref === "cert_cloud_architect" && v.where === "certifications"),
    result.ok === false ? JSON.stringify(result.violations) : "expected a refusal",
  );
});

// ---------------------------------------------------------------------------
// ABSENT NULLABLE KEYS IN A STORED MASTER (live 2026-10-24). master_profiles v2 was
// uploaded with achievements that have NO `description` key at all, not `null`.
// The type says `string | null`, but the master is jsonb read back through a cast, so
// the validator received `undefined` and copied it into the tailored snapshot, where
// the renderer crashed on it. Master versions are immutable and pinned, so the stored
// hole is permanent: this copy step is where every future snapshot gets it fixed.
// ---------------------------------------------------------------------------

// The master with every nullable display key DELETED — the shape v2 has live. Built
// through an untyped view of a clone, because the point is to violate the type.
function masterWithoutNullableKeys(): MasterProfile {
  // A private copy, so no other test sees the deletions.
  const master = masterClone();
  // An untyped handle on the same object, for the deletions the type forbids.
  const raw = master as unknown as Record<string, any>;
  // The three optional identity lines.
  for (const key of ["headline", "phone", "location"]) delete raw.identity[key];
  // Every role's location.
  for (const node of raw.experience) delete node.location;
  // Every degree's field of study and grade.
  for (const node of raw.education) { delete node.field; delete node.grade_display; }
  // Every undated entry's qualifying detail: the live case.
  for (const node of [...raw.achievements, ...raw.certifications]) delete node.description;
  // Same object, now carrying the holes.
  return master;
}

test("a master with absent nullable keys resolves to explicit nulls, never undefined", () => {
  // The award tailoring, so all four kinds of nullable field are selected at once.
  const result = validateTailoredProfile(withAwards(), masterWithoutNullableKeys(), PINNED_VERSION);
  // Still a valid tailoring: an absent optional field is not a fabrication.
  assert.equal(result.ok, true, result.ok === false ? JSON.stringify(result.violations) : "");
  if (!result.ok) return;
  // The resolved resume, under test.
  const resume = result.resume;
  // Non-vacuity: every section whose field is checked below was actually selected.
  assert.ok(resume.experience.length > 0 && resume.education.length > 0 && resume.achievements.length > 0 && resume.certifications.length > 0, "a section under test resolved empty; this test would be vacuous");
  // Each [label, node, key] triple names one nullable field in the resolved resume.
  const fields: Array<[string, Record<string, unknown>, string]> = [
    // Identity's three optional lines.
    ["identity.headline", resume.identity as unknown as Record<string, unknown>, "headline"],
    ["identity.phone", resume.identity as unknown as Record<string, unknown>, "phone"],
    ["identity.location", resume.identity as unknown as Record<string, unknown>, "location"],
    // The role location that printed "Acme, undefined".
    ["experience[0].location", resume.experience[0] as unknown as Record<string, unknown>, "location"],
    // The degree's field and grade.
    ["education[0].field", resume.education[0] as unknown as Record<string, unknown>, "field"],
    ["education[0].grade_display", resume.education[0] as unknown as Record<string, unknown>, "grade_display"],
    // The two undated descriptions, the live crash.
    ["achievements[0].description", resume.achievements[0] as unknown as Record<string, unknown>, "description"],
    ["certifications[0].description", resume.certifications[0] as unknown as Record<string, unknown>, "description"],
  ];
  // Every one must be a PRESENT key holding null: JSON.stringify drops an undefined
  // key, so "present and null" is the only shape that survives into the jsonb snapshot.
  for (const [label, node, key] of fields) {
    // The key exists on the resolved node.
    assert.equal(key in node, true, `${label} is missing from the resolved resume`);
    // And its value is exactly null, not undefined.
    assert.equal(node[key], null, `${label} should be null, got ${String(node[key])}`);
  }
});

// ---------------------------------------------------------------------------
// CERTIFICATION AND ACHIEVEMENT LINKS (2026-11-01). Master v9 puts credential and
// profile URLs on the cert or achievement they prove. A link is not tailorable, so
// the resolved resume must carry the MASTER's links by ref, and nothing the model
// wrote. And every master before v9 has no `links` key at all, which must resolve to
// NO key - not [] - so rebuildOriginal still reproduces every pre-v9 frozen
// snapshot exactly (apps/web/test/tailorRefsWithoutSchemaVersion.test.ts).
// ---------------------------------------------------------------------------

// The master with one credential link on the cert and one profile link on the
// achievement. An untyped handle so the test can add a key old fixtures lack.
function masterWithEntryLinks(): MasterProfile {
  // A private copy, so no other test sees the additions.
  const master = masterClone();
  // Untyped view for the writes.
  const raw = master as unknown as Record<string, any>;
  // cert-aws-ccp is certifications[0] in MASTER.
  raw.certifications[0].links = [{ id: "link-cert-aws", label: "Credential", url: "https://www.credly.com/badges/aws" }];
  // ach-sih is achievements[0] in MASTER.
  raw.achievements[0].links = [{ id: "link-ach-sih", label: "Result", url: "https://sih.gov.in/result" }];
  // Same object, now carrying links.
  return master;
}

test("a tailored cert and achievement carry the master's links, by ref", () => {
  // The awards tailoring selects both entries.
  const result = validateTailoredProfile(withAwards(), masterWithEntryLinks(), PINNED_VERSION);
  // Links are not a fabrication surface, so the tailoring stays valid.
  assert.equal(result.ok, true, result.ok === false ? JSON.stringify(result.violations) : "");
  if (!result.ok) return;
  // The cert's credential link, exactly as the master holds it.
  assert.deepEqual(result.resume.certifications[0]?.links, [
    { id: "link-cert-aws", label: "Credential", url: "https://www.credly.com/badges/aws" },
  ]);
  // The achievement's link, from its own master node.
  assert.deepEqual(result.resume.achievements[0]?.links, [
    { id: "link-ach-sih", label: "Result", url: "https://sih.gov.in/result" },
  ]);
});

test("links the model invents on a tailored cert are ignored; the master's win", () => {
  // A model response that smuggles a `links` key onto its cert selection. The
  // tailorer's shape check does not strip unknown keys, so this reaches the validator.
  const tailored = withAwards() as unknown as Record<string, any>;
  // The forged link points somewhere the human never put on their master.
  tailored.certifications[0].links = [{ id: "forged", label: "Credential", url: "https://evil.example/fake-cert" }];
  // Resolve against the real master.
  const result = validateTailoredProfile(tailored as unknown as TailoredProfile, masterWithEntryLinks(), PINNED_VERSION);
  // Still resolvable: the extra key is ignored, not a crash.
  assert.equal(result.ok, true, result.ok === false ? JSON.stringify(result.violations) : "");
  if (!result.ok) return;
  // Only the master's link survives into the resume.
  assert.deepEqual(result.resume.certifications[0]?.links?.map((l) => l.url), ["https://www.credly.com/badges/aws"]);
});

test("a v8-shaped master (no links key) resolves with no links key, so old rebuilds stay exact", () => {
  // MASTER itself is the v1-v8 shape: no links key on either entry.
  assert.equal("links" in (MASTER.certifications[0] ?? {}), false, "fixture carries links; this test would be vacuous");
  // Resolve the awards tailoring against it.
  const result = validateTailoredProfile(withAwards(), masterClone(), PINNED_VERSION);
  // Valid, as before this change.
  assert.equal(result.ok, true, result.ok === false ? JSON.stringify(result.violations) : "");
  if (!result.ok) return;
  // No key at all - neither [] nor an undefined-valued key - on the cert...
  assert.equal("links" in (result.resume.certifications[0] ?? {}), false, "an absent master key gained a links key");
  // ...or on the achievement: byte-identical to what the validator produced before v9.
  assert.equal("links" in (result.resume.achievements[0] ?? {}), false, "an absent master key gained a links key");
});
