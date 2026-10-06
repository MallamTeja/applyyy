// Tests for the email tracker's pure decisions. Each case is a defect found by the
// 2026-10-04 audit; the first is the one that advanced rejected applications.
import { test } from "node:test";
// Strict equality so null and undefined stay distinct.
import assert from "node:assert/strict";
// Units under test.
import { classifyMessage, matchApplication, passesConfidenceGate, statusMoveFor, targetStatusFor, TERMINAL_MIN_CONFIDENCE, type ActiveApplication } from "./decide.ts";
// The rule table and moderate cutoff, for the corroborate-only weight guards; read live, never copied.
import { MODERATE_REJECTION_MIN, REJECTION_SIGNALS } from "../_shared/email/classifier.ts";

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

// ---- 2026-10-05: false-rejection and loose-domain fixes -------------------------------

// Builds an application at a chosen status, for the full verdict -> move pipeline.
function appAt(id: string, slug: string, status: ActiveApplication["status"]): ActiveApplication {
  // Same shape as `app`, with the status the transition check needs.
  return { ...app(id, slug), status };
}

// The whole pure pipeline an email takes: classify, then ask what status it moves to.
function moveFor(message: { from: string; subject: string; snippet: string }, current: ActiveApplication["status"]) {
  // Same two calls index.ts makes, in the same order.
  return statusMoveFor(classifyMessage(message), current);
}

test("(a) 'Unfortunately, we need to reschedule your interview' is not a rejection and moves nothing", () => {
  // The exact trigger: a bare "unfortunately, we" used to score 0.85.
  const message = { from: "jobs@acme.com", subject: "Interview scheduling", snippet: "Unfortunately, we need to reschedule your interview. Please pick a new time." };
  // Classified as anything but a rejection.
  assert.notEqual(classifyMessage(message).classification, "rejection");
  // And an application at `interview` stays there.
  assert.equal(moveFor(message, "interview"), null);
});

test("(b) 'Unfortunately, we have decided not to move forward' is a rejection that moves applied to rejected", () => {
  // Strong form: decision phrase after the opener.
  const message = { from: "jobs@acme.com", subject: "Your application", snippet: "Unfortunately, we have decided not to move forward with your application." };
  // Classified as a rejection.
  assert.equal(classifyMessage(message).classification, "rejection");
  // The move clears the terminal gate.
  assert.equal(moveFor(message, "applied"), "rejected");
});

test("(c) 'We regret to inform you' is a rejection", () => {
  // Formal boilerplate opener.
  const message = { from: "jobs@acme.com", subject: "Application update", snippet: "We regret to inform you that your application was unsuccessful." };
  // Classified by outcome.
  assert.equal(classifyMessage(message).classification, "rejection");
  // And it is confident enough to move.
  assert.equal(moveFor(message, "applied"), "rejected");
});

test("(d) a moderate rejection (0.5 to 0.8) is stored as a rejection but moves nothing", () => {
  // Subject signal 0.25 plus the bare opener 0.35 gives 0.6: the classifier's moderate branch.
  const message = { from: "jobs@acme.com", subject: "Update on your application", snippet: "Unfortunately, we are still reviewing candidates." };
  // Classification is kept so the email stays visible.
  const decision = classifyMessage(message);
  // Moderate band: a rejection label with confidence strictly between the two cutoffs.
  assert.equal(decision.classification, "rejection");
  // Confidence sits under the terminal gate.
  assert.ok(decision.confidence >= 0.5 && decision.confidence < 0.8, `confidence ${decision.confidence}`);
  // The gate holds: no status move.
  assert.equal(statusMoveFor(decision, "applied"), null);
  // Unit check of the gate itself, both sides of the terminal bar.
  assert.equal(passesConfidenceGate("rejected", 0.79), false);
  assert.equal(passesConfidenceGate("rejected", 0.8), true);
  // A non-terminal move uses the lower bar, and NaN fails closed.
  assert.equal(passesConfidenceGate("interview", 0.7), true);
  assert.equal(passesConfidenceGate("interview", Number.NaN), false);
});

test("(e) only the registrable label matches the slug", () => {
  // One candidate whose slug is `stripe`.
  const apps = [app("s1", "stripe")];
  // A helper keeps each case to one line.
  const matchDomain = (domain: string) => matchApplication({ from: `x@${domain}`, subject: "Hi", snippet: "" }, domain, apps);
  // The company's own domain, a subdomain of it, and its UK registration all match.
  assert.equal(matchDomain("stripe.com"), "s1");
  assert.equal(matchDomain("mail.stripe.com"), "s1");
  assert.equal(matchDomain("stripe.co.uk"), "s1");
  // Someone else's registrable name with `stripe` as a subdomain does not.
  assert.equal(matchDomain("stripe.evil.com"), null);
  assert.equal(matchDomain("stripe.somevendor.com"), null);
  // A bare multi-part suffix has no registrable label: fail closed.
  assert.equal(matchDomain("co.uk"), null);
});

test("(f) a marketing newsletter from a company applied to moves nothing", () => {
  // Domain matches, but no outcome phrase is present.
  const message = { from: "news@acme.com", subject: "Acme product news: our fall launch", snippet: "Check out what's new at Acme this season." };
  // No status move from any stage.
  assert.equal(moveFor(message, "applied"), null);
  assert.equal(moveFor(message, "interview"), null);
});

test("(g) GitLab-shaped emails each cause only their own outcome", () => {
  // The sender domain resolves to the one GitLab application at `applied`.
  const candidates = [appAt("g1", "gitlab", "applied"), appAt("o1", "other", "applied")];
  // Matching is by registrable label.
  const from = "GitLab Recruiting <talent@gitlab.com>";
  // Confirmation: advances only to the receipt mapping, never rejected or interview.
  const confirmation = { from, subject: "Application received", snippet: "Thank you for applying to GitLab. We have received your application." };
  // Rejection: terminal.
  const rejection = { from, subject: "Your GitLab application", snippet: "We regret to inform you that we will not be moving forward with your candidacy." };
  // Interview invite: the interview stage.
  const invite = { from, subject: "Interview with GitLab", snippet: "We would like to invite you to an interview with the hiring manager." };
  // Each email matches the GitLab application, and only that one.
  for (const message of [confirmation, rejection, invite]) {
    // Domain from the parser, as index.ts passes it.
    assert.equal(matchApplication(message, classifyMessage(message).senderDomain, candidates), "g1");
  }
  // Receipt -> the existing receipt mapping (see report: this is the "acknowledged" gap).
  assert.equal(moveFor(confirmation, "applied"), "employer_screening");
  // Rejection -> rejected.
  assert.equal(moveFor(rejection, "applied"), "rejected");
  // Invite -> interview.
  assert.equal(moveFor(invite, "applied"), "interview");
});

// ---- 2026-10-05 sweep: politeness openers must not reach the confident-rejection band ----

test("'After careful consideration, we have scheduled your final round' is not a rejection and moves nothing", () => {
  // Politeness opener with a scheduling verb: used to score 0.85.
  const message = { from: "jobs@acme.com", subject: "Final round", snippet: "After careful consideration, we have scheduled your final round for Tuesday." };
  // Classify once; both assertions read it.
  const decision = classifyMessage(message);
  // Never a rejection at or above the terminal gate.
  assert.ok(!(decision.classification === "rejection" && decision.confidence >= 0.8));
  // And an application at interview stays put.
  assert.equal(statusMoveFor(decision, "interview"), null);
});

test("'After careful consideration, we have decided to move forward with other candidates' is a rejection", () => {
  // Opener plus decision phrase plus the other-candidates phrase.
  const message = { from: "jobs@acme.com", subject: "Your application", snippet: "After careful consideration, we have decided to move forward with other candidates." };
  // Confident rejection that moves applied to rejected.
  assert.equal(moveFor(message, "applied"), "rejected");
});

test("'Thank you for your interest, we'd love to schedule a call' and a bare sign-off are not rejections", () => {
  // Politeness preamble plus an invitation to talk.
  const interest = { from: "jobs@acme.com", subject: "Next steps", snippet: "Thank you for your interest. We'd love to schedule a call this week." };
  // Not a rejection label at all.
  assert.notEqual(classifyMessage(interest).classification, "rejection");
  // A sign-off alone is politeness, below every gate.
  assert.equal(moveFor({ from: "jobs@acme.com", subject: "Hello", snippet: "We wish you the best in your job search." }, "applied"), null);
});

// ---- 2026-10-06: vendor subdomains, display-name-only fallback, corroborate-only weight budget ----

test("(h) an exact vendor sender 'Stripe Recruiting <no-reply@lever.co>' matches stripe by display name", () => {
  // Domain is nulled by the parser, so only the display name can name the company.
  const message = { from: "Stripe Recruiting <no-reply@lever.co>", subject: "Your application", snippet: "" };
  // Use the parser's domain exactly as index.ts does, so the vendor filter is part of the test.
  assert.equal(matchApplication(message, classifyMessage(message).senderDomain, [app("s1", "stripe"), app("o1", "other")]), "s1");
});

test("(i) a vendor SUBDOMAIN sender 'Stripe Recruiting <no-reply@hire.lever.co>' still matches stripe", () => {
  // The regression: hire.lever.co passed the exact vendor check, became a non-null domain, and the
  // matcher then skipped the display-name fallback entirely.
  const message = { from: "Stripe Recruiting <no-reply@hire.lever.co>", subject: "Your application", snippet: "" };
  // Parser domain, not a hand-picked null, so a parser OR matcher regression turns this red.
  assert.equal(matchApplication(message, classifyMessage(message).senderDomain, [app("s1", "stripe"), app("o1", "other")]), "s1");
});

test("(j) a spoof 'x@stripe.evil.com' with no other signal matches nothing, even with the fallback open", () => {
  // No display name, a neutral subject: the only place 'stripe' appears is the attacker's address.
  const message = { from: "x@stripe.evil.com", subject: "Hi", snippet: "" };
  // The domain rule refuses it, and the fallback must not read the address to win it back.
  assert.equal(matchApplication(message, classifyMessage(message).senderDomain, [app("s1", "stripe")]), null);
  // Same with the bracketed form, which the old fallback also read in full.
  assert.equal(matchApplication({ ...message, from: "<x@stripe.evil.com>" }, "stripe.evil.com", [app("s1", "stripe")]), null);
});

test("every corroborate-only rejection rule, all firing at once, stays under the terminal gate", () => {
  // The flagged rules; scores are ADDITIVE, so the worst case is all of them together.
  const weak = REJECTION_SIGNALS.filter((rule) => rule.corroborateOnly === true);
  // Guard against a vacuous pass: an empty filter would sum to 0.
  assert.ok(weak.length >= 3, `only ${weak.length} flagged rules`);
  // The worst-case total.
  const sum = weak.reduce((total, rule) => total + rule.weight, 0);
  // Imported constant, so moving the gate re-runs this check against the new value.
  assert.ok(sum < TERMINAL_MIN_CONFIDENCE, `corroborate-only sum ${sum} >= ${TERMINAL_MIN_CONFIDENCE}`);
});

test("every rejection rule weaker than the moderate cutoff is flagged corroborate-only", () => {
  // A new weak rule added without the flag would silently escape the sum above.
  const unflagged = REJECTION_SIGNALS.filter((rule) => rule.weight < MODERATE_REJECTION_MIN && rule.corroborateOnly !== true);
  // Name them in the failure so the fix is obvious.
  assert.deepEqual(unflagged.map((rule) => rule.tag), []);
});

test("'Unfortunately, we ... we wish you the best in your job search' alone moves nothing", () => {
  // Two corroborate-only signals with no decision phrase: summed to 0.85 before 2026-10-06.
  const message = { from: "jobs@acme.com", subject: "Hello", snippet: "Unfortunately, we are running behind schedule. We wish you the best in your job search." };
  // No terminal move from an active stage.
  assert.equal(moveFor(message, "applied"), null);
});
