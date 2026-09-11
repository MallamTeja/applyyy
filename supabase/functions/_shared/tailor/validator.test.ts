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
// Explicit .ts extension — required by Deno, accepted by Node.
import { validateTailoredProfile } from "./validator.ts";
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
