// Tests for the required-experience parser and its ceiling check (Teja, 2026-11-04).
//
// EVERY CASE IS LIVE WORDING. The hard cases are the postings that reached Teja although
// they asked for years he does not have (Axiad "6-8 years", the 11-04 incident). The keep
// cases are the boilerplate traps the 2026-11-01 bulk cleanup hit, plus sentences sampled
// from 617 live pre-approval JDs on 2026-11-04. A parser that over-drops costs real
// fresher jobs, so the keep cases matter as much as the drops.

// node:test, the runner the rest of _shared/screen uses.
import { describe, it } from "node:test";
// Strict assertions, so 0 and null are never confused.
import assert from "node:assert/strict";
// The module under test.
import { experienceCeilingMaxYears, requiredExperienceYears, screenRequiredExperience } from "./required-experience.ts";

// A neutral title, so title-based exemptions never mask a description test.
const SWE = "Software Engineer";

describe("requiredExperienceYears: hard minimums are read", () => {
  // The 11-04 incident: a range reads as its lower bound.
  it("Axiad '6-8 years of hands-on software development experience' is 6", () => {
    assert.equal(requiredExperienceYears("AI-First Golang Developer", "6-8 years of hands-on software development experience, specializing in Go."), 6);
  });
  // The plain plus form.
  it("'5+ years backend engineering experience' is 5", () => {
    assert.equal(requiredExperienceYears(SWE, "5+ years backend engineering experience of running Node services."), 5);
  });
  // A labelled field, no "of".
  it("'Experience Level: 3+ years' is 3", () => {
    assert.equal(requiredExperienceYears(SWE, "Experience Level: 3+ years"), 3);
  });
  // "At least".
  it("'At least 2 years of demonstrable experience is required' is 2", () => {
    assert.equal(requiredExperienceYears(SWE, "At least 2 years of demonstrable experience is required for each of the following."), 2);
  });
  // "A minimum of".
  it("'A minimum of 3+ years of relevant experience' is 3", () => {
    assert.equal(requiredExperienceYears(SWE, "A minimum of 3+ years of relevant experience"), 3);
  });
  // A number written as a word (missed by the 11-01 regex).
  it("'two or more years of professional experience' is 2", () => {
    assert.equal(requiredExperienceYears(SWE, "You have two or more years of professional experience."), 2);
  });
  // The YOE abbreviation (missed on 11-01).
  it("'3+ YOE in backend systems' is 3", () => {
    assert.equal(requiredExperienceYears(SWE, "3+ YOE in backend systems"), 3);
  });
  // A zero-width space between the digit and the plus (missed on 11-01).
  it("a zero-width space inside '2​+ years of experience' is 2", () => {
    assert.equal(requiredExperienceYears(SWE, "2​+ years of experience with Python"), 2);
  });
  // No word "experience", only a verb (missed on 11-01).
  it("'8+ years building and operating software systems' is 8", () => {
    assert.equal(requiredExperienceYears(SWE, "Typically 8+ years building and operating sophisticated software systems."), 8);
  });
  // Stripe: the "preferred" sentence must not soften the minimum that follows it.
  it("Stripe 'Preferred ... a bonus, not a requirement. Minimum requirements 4+ years' is 4", () => {
    const stripe = "Preferred qualifications are a bonus, not a requirement. Minimum requirements\n4+ years of professional software development experience";
    assert.equal(requiredExperienceYears(SWE, stripe), 4);
  });
  // "preferably" AFTER the years qualifies the focus, not the years.
  it("'5+ years of experience ..., preferably with a focus on X' stays hard at 5", () => {
    assert.equal(requiredExperienceYears(SWE, "5+ years of experience building internet-scale software, preferably with a focus on distributed systems."), 5);
  });
  // A range in the TITLE is read too.
  it("a title '(3-5 years)' is 3", () => {
    assert.equal(requiredExperienceYears("Backend Engineer (3-5 years)", "Build APIs."), 3);
  });
  // A bare range in the title, the 11-01 "(3-5)" titles; a year in brackets is not a range.
  it("a title 'Software Engineer (3-5)' is 3, '(2027)' is not read", () => {
    assert.equal(requiredExperienceYears("Software Engineer (3-5)", "Build APIs."), 3);
    assert.equal(requiredExperienceYears("Software Engineer (2027)", "Build APIs."), null);
  });
  // An en dash range in a labelled field.
  it("'Experience: 2–4 years development' is 2", () => {
    assert.equal(requiredExperienceYears(SWE, "Experience: 2–4 years development"), 2);
  });
  // HTML from an ATS is stripped before reading.
  it("'<li>5+ years of experience</li>' inside HTML is 5", () => {
    assert.equal(requiredExperienceYears(SWE, "<ul><li>5+ years of experience in Go</li></ul>"), 5);
  });
  // Entity-escaped HTML (Greenhouse) is decoded first.
  it("entity-escaped '&lt;li&gt;4+ years of experience&lt;/li&gt;' is 4", () => {
    assert.equal(requiredExperienceYears(SWE, "&lt;li&gt;4+ years of experience&lt;/li&gt;"), 4);
  });
  // Code review 2026-11-04: an ordinary "... preferred" bullet must NOT silence the bullets after it.
  it("'Kubernetes experience preferred' then '6+ years of ... experience' is 6", () => {
    assert.equal(requiredExperienceYears(SWE, "• Kubernetes experience preferred\n• 6+ years of professional software development experience"), 6);
  });
  // The highest hard minimum wins when a JD lists several.
  it("the highest of several hard minimums wins", () => {
    assert.equal(requiredExperienceYears(SWE, "2+ years of experience with SQL.\n5+ years of software engineering experience."), 5);
  });
});

describe("requiredExperienceYears: boilerplate and soft wording are NOT requirements", () => {
  // Point72: a number >= 20 is company history.
  it("Point72 'more than 30 years of investing experience' is null", () => {
    assert.equal(requiredExperienceYears(SWE, "Building on more than 30 years of investing experience, Point72 seeks to deliver superior returns."), null);
  });
  // A budget, not a requirement.
  it("'development budget of USD 1,000 per year' is null", () => {
    assert.equal(requiredExperienceYears(SWE, "Personal learning and development budget of USD 1,000 per year"), null);
  });
  // Company growth prose with a word number.
  it("'doubling its ARR over the past three years' is null", () => {
    assert.equal(requiredExperienceYears(SWE, "It recently surpassed $100M in ARR, doubling its ARR over the past three years."), null);
  });
  // Company history with a big number.
  it("'For 25+ years, we've delivered extraordinary impact' is null", () => {
    assert.equal(requiredExperienceYears(SWE, "For 25+ years, we've delivered extraordinary impact together with our clients."), null);
  });
  // A merger story.
  it("'competitors for eight years, joined forces' is null", () => {
    assert.equal(requiredExperienceYears(SWE, "In August 2025, Prefect and Dagster, competitors for eight years, joined forces."), null);
  });
  // An upper bound is fresher-friendly, never a minimum.
  it("'less than one year of professional experience' is null", () => {
    assert.equal(requiredExperienceYears(SWE, "You have less than one year of professional experience working as a developer."), null);
  });
  // "ideally" BEFORE the years softens them.
  it("'ideally with 3+ years building production services' is null", () => {
    assert.equal(requiredExperienceYears(SWE, "Proficient in Go, ideally with 3+ years building production services."), null);
  });
  // "is a plus" AFTER the years softens them.
  it("'3+ years of experience with Kubernetes is a plus' is null", () => {
    assert.equal(requiredExperienceYears(SWE, "3+ years of experience with Kubernetes is a plus."), null);
  });
  // Years listed under a Preferred heading are wishes (Teja's 11-01 ruling).
  it("years under a 'Preferred Qualifications' heading are null", () => {
    assert.equal(requiredExperienceYears(SWE, "Preferred Qualifications\n- 3+ years of experience in ML"), null);
  });
  // Cloudflare's heading puts the soft word third (live audit, 2026-11-04 19:55 IST).
  it("years under 'Examples of desirable skills, knowledge and experience' are null", () => {
    assert.equal(requiredExperienceYears(SWE, "Examples of desirable skills, knowledge and experience\nAt least 4 years of hands-on software development experience"), null);
  });
  // Code review 2026-11-04: a work word BEFORE the years is company history, not a requirement.
  it("'We have been building developer tools for 12 years.' is null", () => {
    assert.equal(requiredExperienceYears(SWE, "We have been building developer tools for 12 years."), null);
  });
  // Code review 2026-11-04: bare "work" after the years is a benefit, not a requirement.
  it("'Sabbatical after 5 years of work.' is null", () => {
    assert.equal(requiredExperienceYears(SWE, "Sabbatical after 5 years of work."), null);
  });
  // Code review 2026-11-04: a degree's length is not experience, even in an engineering sentence.
  it("'4 year degree in Computer Engineering' is null", () => {
    assert.equal(requiredExperienceYears(SWE, "Bachelor's: 4 year degree in Computer Engineering or equivalent"), null);
  });
  // A benefit milestone.
  it("'Paid month off after 5 years & every 5 years thereafter' is null", () => {
    assert.equal(requiredExperienceYears(SWE, "- Paid month off after 5 years & every 5 years thereafter"), null);
  });
  // Travel frequency.
  it("'travel for 2 to 4 weeks per year' is null", () => {
    assert.equal(requiredExperienceYears(SWE, "Work from home with global travel for 2 to 4 weeks per year for internal events."), null);
  });
  // No mention at all.
  it("a JD with no years is null", () => {
    assert.equal(requiredExperienceYears(SWE, "Build developer tools with a small team."), null);
  });
  // Missing description.
  it("a null description is null", () => {
    assert.equal(requiredExperienceYears(SWE, null), null);
  });
});

describe("requiredExperienceYears: entry-level titles are exempt (Teja's 11-01 ruling)", () => {
  // An intern posting that boilerplates years is still a fresher job.
  it("'Software Engineering Intern' with '2+ years of experience' is null", () => {
    assert.equal(requiredExperienceYears("Software Engineering Intern", "2+ years of experience with Python."), null);
  });
  // Junior roles, including junior security, are kept.
  it("'Junior Security Engineer' with '2+ years of experience' is null", () => {
    assert.equal(requiredExperienceYears("Junior Security Engineer", "2+ years of experience in security."), null);
  });
  // Campus graduate programmes are kept.
  it("Point72 'Campus Graduate Program' is null", () => {
    assert.equal(requiredExperienceYears("2027 Software Engineer - Campus Graduate Program", "3+ years of experience."), null);
  });
});

describe("experienceCeilingMaxYears: reads filter_rules.config.max_years by shape", () => {
  // The live config on 2026-11-04 before the migration: no threshold.
  it("{} is null", () => {
    assert.equal(experienceCeilingMaxYears({}), null);
  });
  // The migrated config.
  it("{ max_years: 1 } is 1", () => {
    assert.equal(experienceCeilingMaxYears({ max_years: 1 }), 1);
  });
  // PostgREST numeric-as-string is accepted only when it is a real number.
  it("{ max_years: '1' } is 1, '' and 'abc' are null", () => {
    assert.equal(experienceCeilingMaxYears({ max_years: "1" }), 1);
    assert.equal(experienceCeilingMaxYears({ max_years: "" }), null);
    assert.equal(experienceCeilingMaxYears({ max_years: "abc" }), null);
  });
  // Not an object at all.
  it("null and an array are null", () => {
    assert.equal(experienceCeilingMaxYears(null), null);
    assert.equal(experienceCeilingMaxYears([1]), null);
  });
});

describe("screenRequiredExperience: the matcher's twin of cascade experienceCeiling", () => {
  // The incident row, with the migrated ceiling.
  it("drops Axiad '6-8 years' at max_years 1 with code experience_ceiling", () => {
    const verdict = screenRequiredExperience({ title: "AI-First Golang Developer", description: "6-8 years of hands-on software development experience", minExperienceYears: null }, 1);
    assert.equal(verdict.drop, true);
    assert.equal(verdict.drop && verdict.code, "experience_ceiling");
  });
  // One year is within Teja's ceiling (">1 year" drops).
  it("keeps '1+ years of experience' at max_years 1", () => {
    assert.equal(screenRequiredExperience({ title: SWE, description: "1+ years of experience", minExperienceYears: null }, 1).drop, false);
  });
  // A stored column beats the parser.
  it("a stored min_experience_years of '0' keeps even when the JD says 5+", () => {
    assert.equal(screenRequiredExperience({ title: SWE, description: "5+ years of experience", minExperienceYears: "0" }, 1).drop, false);
  });
  // No ceiling configured: keep and say so.
  it("no max_years keeps and warns", () => {
    const verdict = screenRequiredExperience({ title: SWE, description: "5+ years of experience", minExperienceYears: null }, null);
    assert.equal(verdict.drop, false);
    assert.ok("warning" in verdict);
  });
});

// P1 #7 (2026-11-06): senior roles reached Ready to tailor. Every case is a live title or JD.
describe("requiredExperienceYears: P1 #7 leaks", () => {
  // Cisco's JD: Workday encodes "+" as "&#43;", which the parser could not see.
  it("Cisco JD 'BS ... with 7&#43; years of relevant experience' is 7", () => {
    assert.equal(requiredExperienceYears(SWE, "Qualifications:\nBS in Computer Science, Engineering, or a related field with 7&#43; years of relevant experience"), 7);
  });
  // A title range without brackets: "4 to 8yrs" between dashes.
  it("title 'Cloud Engineer -  4 to 8yrs - Java, Python' is 4", () => {
    assert.equal(requiredExperienceYears("Cloud Engineer -  4 to 8yrs - Java, Python, AI Tools, Distributed Systems", null), 4);
  });
  // A bare plus form at the end of a title.
  it("title '... Distributed Systems, Cloud- 4+ Years' is 4", () => {
    assert.equal(requiredExperienceYears("Software Engineer - Backend, Python/Go, Distributed Systems, Cloud- 4+ Years", null), 4);
  });
  // A range after a pipe.
  it("title '... | L0/L1 Optical Testing 8 - 10 years' is 8", () => {
    assert.equal(requiredExperienceYears("Software Test Engineer – IOS XR | Python Automation | L0/L1 Optical Testing 8 - 10 years", null), 8);
  });
  // Keep: a year number is not a duration.
  it("title 'Software Engineer - 2026 Grad' is null", () => {
    assert.equal(requiredExperienceYears("Software Engineer - 2026 Grad", null), null);
  });
  // Keep: months are not years.
  it("title 'Backend Engineer (3-6 months contract)' is null", () => {
    assert.equal(requiredExperienceYears("Backend Engineer (3-6 months contract)", null), null);
  });
  // Keep: a fresher-friendly upper bound in the title is not a minimum.
  it("title 'Software Engineer (up to 2 years)' is null", () => {
    assert.equal(requiredExperienceYears("Software Engineer (up to 2 years)", null), null);
  });
  // Keep: a degree's length in the title.
  it("title 'Software Engineer - 4 year degree required' is null", () => {
    assert.equal(requiredExperienceYears("Software Engineer - 4 year degree required", null), null);
  });
  // Keep: an entry-level title stays exempt whatever its years say.
  it("title 'Graduate Engineer (2 year programme)' is null", () => {
    assert.equal(requiredExperienceYears("Graduate Engineer (2 year programme)", null), null);
  });
});
