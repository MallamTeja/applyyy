// Unit tests for the offline ATS Resume Parse Simulator Engine.
// Evaluates keyword matching, section header parsing, formatting readability,
// and edge-case handling under Node test runner and Deno.

import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateAtsParse } from "./ats-simulator.ts";

test("perfect match produces high score and zero missing keywords", () => {
  // Candidate profile containing all required sections and matching keywords
  const profile = {
    contact: { name: "Alice Developer", email: "alice@example.com", phone: "555-0199" },
    summary: "Senior Full Stack Engineer with extensive TypeScript and Node.js expertise.",
    experience: [
      {
        title: "Senior Software Engineer",
        company: "Tech Corp",
        bullets: ["Built scalable microservices using TypeScript, Node.js, and PostgreSQL."],
      },
    ],
    skills: ["TypeScript", "Node.js", "PostgreSQL", "React", "Docker"],
    education: [{ degree: "BS Computer Science", university: "State University" }],
  };

  // Job posting requiring TypeScript, Node.js, PostgreSQL, and React
  const job = {
    title: "Senior Full Stack Engineer",
    description_raw: "Looking for an engineer skilled in TypeScript, Node.js, PostgreSQL, and React.",
  };

  const result = simulateAtsParse(profile, job);

  // Assert match score is high (>= 90%)
  assert.ok(result.parseScore >= 90, `Expected parseScore >= 90, got ${result.parseScore}`);
  // Assert no missing keywords
  assert.deepEqual(result.missingKeywords, []);
});

test("partial match correctly identifies missing keywords", () => {
  // Candidate profile with TypeScript and React, but missing Docker and Kubernetes
  const profile = {
    contact: { email: "bob@example.com" },
    summary: "Frontend Developer experienced in React and TypeScript.",
    skills: ["TypeScript", "React"],
    experience: [{ title: "Frontend Developer", description: "Built web applications in React." }],
    education: [{ degree: "BS Computer Science" }],
  };

  // Job posting requiring React, TypeScript, Docker, and Kubernetes
  const job = {
    title: "DevOps Engineer",
    description_raw: "We need React, TypeScript, Docker, and Kubernetes.",
  };

  const result = simulateAtsParse(profile, job);

  // Assert parseScore is lower than perfect match (e.g. between 40 and 85)
  assert.ok(result.parseScore < 90, `Expected parseScore < 90, got ${result.parseScore}`);
  assert.ok(result.parseScore > 30, `Expected parseScore > 30, got ${result.parseScore}`);

  // Assert missingKeywords contains docker and kubernetes
  assert.ok(result.missingKeywords.includes("docker"), "Expected docker to be missing");
  assert.ok(result.missingKeywords.includes("kubernetes"), "Expected kubernetes to be missing");
});

test("empty profile returns 0 parseScore and lists all job keywords as missing", () => {
  const job = {
    title: "Backend Engineer",
    description_raw: "Seeking Python, Django, and AWS specialist.",
  };

  // Run simulator with null and empty profile variants
  const nullResult = simulateAtsParse(null, job);
  const emptyObjResult = simulateAtsParse({}, job);

  assert.equal(nullResult.parseScore, 0);
  assert.ok(nullResult.missingKeywords.length > 0);

  assert.equal(emptyObjResult.parseScore, 0);
  assert.ok(emptyObjResult.missingKeywords.length > 0);
});

test("empty job description returns 100 parseScore and empty missingKeywords", () => {
  const profile = {
    contact: { email: "dev@example.com" },
    summary: "Software Engineer",
    skills: ["Python", "Java"],
    experience: [{ title: "Engineer" }],
    education: [{ degree: "BS CS" }],
  };

  const result = simulateAtsParse(profile, null);

  assert.equal(result.parseScore, 100);
  assert.deepEqual(result.missingKeywords, []);
});

test("section header parsing rewards profiles with complete standard sections", () => {
  // Complete profile with all 5 standard sections
  const completeProfile = {
    contact: { email: "dev@test.com" },
    summary: "Software Developer",
    experience: [{ title: "Developer" }],
    skills: ["JavaScript"],
    education: [{ degree: "Bachelor" }],
  };

  // Incomplete profile missing experience and education sections
  const incompleteProfile = {
    skills: ["JavaScript"],
  };

  const job = { description_raw: "Developer needed with JavaScript skills." };

  const completeResult = simulateAtsParse(completeProfile, job);
  const incompleteResult = simulateAtsParse(incompleteProfile, job);

  assert.ok(
    completeResult.parseScore > incompleteResult.parseScore,
    `Complete profile score (${completeResult.parseScore}) should be higher than incomplete profile score (${incompleteResult.parseScore})`
  );
});

test("handles raw string inputs for profile and job gracefully", () => {
  const profileString = "Contact: dev@example.com. Experience: Senior Developer at Acme. Skills: Java, Spring, SQL. Education: BS. Summary: Developer.";
  const jobString = "We are looking for a Java Developer with Spring and SQL skills.";

  const result = simulateAtsParse(profileString, jobString);

  assert.ok(typeof result.parseScore === "number");
  assert.ok(result.parseScore >= 0 && result.parseScore <= 100);
  assert.ok(Array.isArray(result.missingKeywords));
});
