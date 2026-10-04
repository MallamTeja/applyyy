// Tests for the email tracker's pure decisions. Each case is a defect found by the
// 2026-10-04 audit; the first is the one that advanced rejected applications.
import { test } from "node:test";
// Strict equality so null and undefined stay distinct.
import assert from "node:assert/strict";
// Units under test.
import { classifyMessage, matchApplication, targetStatusFor, type ActiveApplication } from "./decide.ts";

// A typical ATS rejection: opens with the receipt phrase the auto-reply detector matches.
const REJECTION = {
  // An ATS vendor sender, so the parser's employer domain is null.
  from: "Acme Recruiting <no-reply@greenhouse.io>",
  // The company named as a whole word, which is what matching falls back to.
  subject: "Your application to Acme",
  // Receipt phrase first, rejection second: the ordering bug's exact trigger.
  snippet: "Thank you for applying to Acme. Unfortunately we will not be moving forward with your application.",
};

test("a rejection that opens with 'thank you for applying' is a rejection, not a receipt", () => {
  // The old ordering read the receipt phrase first and returned application_received.
  const decision = classifyMessage(REJECTION);
  // Classified by its outcome.
  assert.equal(decision.classification, "rejection");
  // And it moves the application to rejected, never to employer_screening.
  assert.equal(targetStatusFor(decision.classification), "rejected");
});

test("a plain receipt with no outcome still reads as application_received", () => {
  // The fallback must survive the reordering.
  const decision = classifyMessage({ from: "jobs@acme.com", subject: "Application received", snippet: "Thank you for applying. We will review your profile." });
  // Receipt is the fallback reading.
  assert.equal(decision.classification, "application_received");
});

test("an out-of-office reply never advances, even when it quotes an interview subject", () => {
  // Quoted thread text would otherwise classify as interviewing.
  const decision = classifyMessage({ from: "Jane <jane@acme.com>", subject: "Out of Office: Re: Interview invitation", snippet: "I am out of office until Monday." });
  // No status for an OOO.
  assert.equal(targetStatusFor(decision.classification), null);
});

// Builds an application row with just the fields matching reads.
function app(id: string, slug: string): ActiveApplication {
  // Status and job id are irrelevant to matching.
  return { id, status: "applied", job_id: `job-${id}`, jobs: { company_name: slug, company_slug: slug } };
}

test("an exact domain label matches; a substring of a longer name does not", () => {
  // `meta` is a substring of `metabase` — the old `includes` matched it.
  const apps = [app("a1", "meta")];
  // Sender is metabase.com, not meta.
  assert.equal(matchApplication({ from: "x@metabase.com", subject: "Hi", snippet: "" }, "metabase.com", apps), null);
  // A real meta.com sender matches.
  assert.equal(matchApplication({ from: "x@meta.com", subject: "Hi", snippet: "" }, "meta.com", apps), "a1");
});

test("an ATS-sent email matches by the slug named as a whole word in the subject", () => {
  // The rejection above comes from greenhouse.io, so the domain is null.
  assert.equal(matchApplication(REJECTION, null, [app("a1", "acme"), app("a2", "acmecorp")]), "a1");
});

test("two applications to the same company match neither", () => {
  // First-match-wins used to pick one arbitrarily.
  assert.equal(matchApplication({ from: "x@acme.com", subject: "Update", snippet: "" }, "acme.com", [app("a1", "acme"), app("a2", "acme")]), null);
});
