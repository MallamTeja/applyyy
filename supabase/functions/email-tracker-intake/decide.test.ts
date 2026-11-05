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

// ---- 2026-11-01 W7: the job title breaks a same-company tie ----------------------------

// Builds an application whose job carries a title, which the tiebreak reads.
function appTitled(id: string, slug: string, title: string): ActiveApplication {
  // Same shape as `app`, plus the title.
  return { ...app(id, slug), jobs: { company_name: slug, company_slug: slug, title } };
}

// Two live applications at one company: 1 of 8 in-flight companies had this on 2026-11-01.
const TWO_AT_ACME = [appTitled("a1", "acme", "Backend Engineer"), appTitled("a2", "acme", "Data Analyst")];

test("W7: two applications at one company, the email names one title: it matches that one", () => {
  // Before the tiebreak the second candidate made EVERY Acme email unmatched.
  const invite = { from: "x@acme.com", subject: "Interview invitation: Data Analyst", snippet: "We'd like to schedule an interview." };
  // Domain pool of two, one title named: the named one wins.
  assert.equal(matchApplication(invite, "acme.com", TWO_AT_ACME), "a2");
  // The same tiebreak serves the text-fallback pool (an ATS sender, no employer domain).
  const atsMail = { from: "Acme <no-reply@greenhouse.io>", subject: "Acme: your Backend Engineer application", snippet: "" };
  // Slug named in the display name and subject; title names a1 only.
  assert.equal(matchApplication(atsMail, null, TWO_AT_ACME), "a1");
});

test("W7: the email names neither title: still unmatched", () => {
  // No title evidence: two candidates stay a refusal, never a guess.
  const update = { from: "x@acme.com", subject: "Update on your application", snippet: "Unfortunately we will not be moving forward." };
  // Null, exactly as before the tiebreak.
  assert.equal(matchApplication(update, "acme.com", TWO_AT_ACME), null);
});

test("W7: the email names both titles: still unmatched", () => {
  // A "first title wins" tiebreak would pick a1 here; exactly-one is the rule.
  const both = { from: "x@acme.com", subject: "Backend Engineer and Data Analyst openings", snippet: "" };
  // Two title matches is still ambiguity.
  assert.equal(matchApplication(both, "acme.com", TWO_AT_ACME), null);
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
  // Receipt on an applied row -> stored as an event, status stays put (Teja, 2026-10-23).
  assert.equal(moveFor(confirmation, "applied"), null);
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

// ---- 2026-10-09 (narrowed 2026-10-23): a VERIFIED Greenhouse receipt confirms applying -> applied ----
//
// Teja's ruling: a receipt may close the submit loop automatically, but only when the sender is
// authenticated (DKIM/SPF judged by Gmail's own MX), the email is newer than the row's latest entry
// into `applying`, and exactly one application matches. Spoofs, stale mail and ambiguity do nothing.
//
// Namespace import, not named: a missing export then fails only the test that calls it, instead of
// failing the module link and taking every older test in this file down with it.
import * as receipt from "./decide.ts";

// Gmail's authserv-id, the only one whose verdicts we trust (any relay can prepend its own header).
const GMAIL_AUTHSERV = "mx.google.com";

// A realistic Gmail Authentication-Results value for a Greenhouse receipt: dkim and spf both pass.
const GREENHOUSE_AUTH = `${GMAIL_AUTHSERV};\r\n       dkim=pass header.i=@us.greenhouse-mail.io header.s=s1 header.b=AbCdEf;\r\n       spf=pass (google.com: domain of bounces@us.greenhouse-mail.io designates 198.51.100.7 as permitted sender) smtp.mailfrom=bounces@us.greenhouse-mail.io;\r\n       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=us.greenhouse-mail.io`;

// The realistic receipt Teja's applications actually get from Greenhouse.
const GREENHOUSE_RECEIPT = {
  // Vendor subdomain sender with the company in the display name.
  from: "Acme Hiring Team <no-reply@us.greenhouse-mail.io>",
  // Names the company as a whole word, which matching falls back to for vendor senders.
  subject: "Thank you for applying to Acme",
  // Receipt wording only: no outcome phrase anywhere.
  snippet: "We have received your application for Backend Engineer and our team will review it shortly.",
};

// A confident receipt decision, fixed so the confirm tests do not depend on classifier weights.
const RECEIPT_DECISION = { classification: "application_received", confidence: 0.9 } as const;

// The verification a passing sender check returns, used when the test is about something else.
const VERIFIED = { method: "dkim", domain: "us.greenhouse-mail.io" } as const;

// The latest entry into `applying`; every "after" timestamp below is strictly later than this.
const ENTERED_APPLYING = "2026-10-09T10:00:00.000Z";

// Builds a receiptConfirmsApplied input that SHOULD confirm, so each refusal test changes one field.
function confirmInput(overrides: Record<string, unknown> = {}) {
  // Every gate satisfied: confident receipt, confirmable status, verified, newer than
  // applying, names the job title, and addressed to Teja (review round 2026-10-09).
  return { decision: RECEIPT_DECISION, current: "applying", receivedAt: "2026-10-09T10:05:00.000Z", enteredApplyingAt: ENTERED_APPLYING, verification: VERIFIED, titleMatches: true, addressedToOwner: true, ...overrides } as Parameters<typeof receipt.receiptConfirmsApplied>[0];
}

test("CONFIRMING_VENDOR_DOMAINS and CONFIRMABLE_STATUSES are exactly the ruled sets", () => {
  // Only Greenhouse is ruled in; widening this list widens who can confirm a submit.
  assert.deepEqual([...receipt.CONFIRMING_VENDOR_DOMAINS], ["greenhouse.io", "greenhouse-mail.io"]);
  // Only `applying` (Teja, 2026-10-23): needs_verification is human-only — Greenhouse
  // signs for every tenant, so a genuine receipt is not proof THIS submit landed.
  assert.deepEqual([...receipt.CONFIRMABLE_STATUSES], ["applying"]);
  // Both submit-uncertain lanes stay match candidates: hiding needs_verification from the
  // matcher would let its late receipt confirm the wrong applying row (review, 2026-10-23).
  // Since W6 (2026-11-01) the one candidate list is TRACKED_STATUSES, for every classification.
  assert.ok(receipt.TRACKED_STATUSES.includes("applying") && receipt.TRACKED_STATUSES.includes("needs_verification"));
  // Confirmable is a strict subset of the candidates: visible to the matcher is a weaker
  // privilege than movable, and the two drifting apart silently is this line's job to stop.
  assert.ok(receipt.CONFIRMABLE_STATUSES.every((s) => receipt.TRACKED_STATUSES.includes(s)));
});

test("verifyReceiptSender: a passing dkim for a vendor subdomain verifies", () => {
  // Subdomain of greenhouse-mail.io for both sender and signer: the real-world shape.
  assert.deepEqual(receipt.verifyReceiptSender(GREENHOUSE_RECEIPT.from, GREENHOUSE_AUTH), { method: "dkim", domain: "us.greenhouse-mail.io" });
  // A bare address with the apex vendor domain and a header.d signer also verifies.
  assert.deepEqual(receipt.verifyReceiptSender("no-reply@greenhouse.io", `${GMAIL_AUTHSERV}; dkim=pass header.d=greenhouse.io`), { method: "dkim", domain: "greenhouse.io" });
});

test("verifyReceiptSender: spf=pass for the vendor verifies when dkim is absent", () => {
  // No dkim clause at all, so the spf fallback is the only path to a verdict.
  const auth = `${GMAIL_AUTHSERV}; spf=pass (google.com: domain of bounces@greenhouse.io designates 198.51.100.7 as permitted sender) smtp.mailfrom=bounces@greenhouse.io`;
  // The domain comes from smtp.mailfrom's address.
  assert.deepEqual(receipt.verifyReceiptSender("no-reply@greenhouse.io", auth), { method: "spf", domain: "greenhouse.io" });
});

test("verifyReceiptSender: lookalike sender domains are refused", () => {
  // The vendor name as a LEFT label of an attacker's domain.
  assert.equal(receipt.verifyReceiptSender("no-reply@greenhouse.io.evil.com", `${GMAIL_AUTHSERV}; dkim=pass header.d=greenhouse.io.evil.com`), null);
  // The vendor name as a suffix of a longer label, with no dot boundary.
  assert.equal(receipt.verifyReceiptSender("no-reply@evilgreenhouse.io", `${GMAIL_AUTHSERV}; dkim=pass header.d=evilgreenhouse.io`), null);
  // A real vendor signature does not rescue a non-vendor sender address.
  assert.equal(receipt.verifyReceiptSender("Acme <jobs@acme.com>", `${GMAIL_AUTHSERV}; dkim=pass header.d=greenhouse.io`), null);
});

test("verifyReceiptSender: a dkim pass for a DIFFERENT vendor is refused", () => {
  // Greenhouse sender, Lever signature: authenticated, but not for the domain that claims to send.
  assert.equal(receipt.verifyReceiptSender("no-reply@greenhouse.io", `${GMAIL_AUTHSERV}; dkim=pass header.d=lever.co`), null);
  // Lever is not a confirming vendor at all, even when it signs for itself.
  assert.equal(receipt.verifyReceiptSender("no-reply@hire.lever.co", `${GMAIL_AUTHSERV}; dkim=pass header.d=hire.lever.co`), null);
});

test("spoof: a receipt without a passing dkim/spf for the vendor domain is refused", () => {
  // No Authentication-Results header at all: Apps Script could not read one.
  assert.equal(receipt.verifyReceiptSender(GREENHOUSE_RECEIPT.from, null), null);
  // An empty header is absence, not a verdict.
  assert.equal(receipt.verifyReceiptSender(GREENHOUSE_RECEIPT.from, ""), null);
  // A forged authserv-id: an attacker's relay can write any verdict under its own name.
  // It signs for the SAME vendor family as the sender (greenhouse-mail.io), so ONLY the
  // authserv-id check can refuse it; with header.d=greenhouse.io the vendor-mismatch check
  // refused it instead and this line guarded nothing (found by red-on-revert, 2026-10-09).
  assert.equal(receipt.verifyReceiptSender(GREENHOUSE_RECEIPT.from, "evil.example; dkim=pass header.d=greenhouse-mail.io"), null);
  // A passing signature, but for the attacker's own domain.
  assert.equal(receipt.verifyReceiptSender(GREENHOUSE_RECEIPT.from, `${GMAIL_AUTHSERV}; dkim=pass header.d=attacker.com`), null);
  // The vendor's signature present but failing.
  assert.equal(receipt.verifyReceiptSender(GREENHOUSE_RECEIPT.from, `${GMAIL_AUTHSERV}; dkim=fail header.d=greenhouse-mail.io`), null);
  // And the downstream gate refuses when verification came back null, all else valid.
  assert.equal(receipt.receiptConfirmsApplied(confirmInput({ verification: null })), false);
});

test("classifyMessage reads a realistic Greenhouse receipt as application_received", () => {
  // The exact email the confirm path is built for; a classifier change that drifts it shows here.
  assert.equal(classifyMessage(GREENHOUSE_RECEIPT).classification, "application_received");
});

test("ambiguous: two applications to the same company match neither, so nothing is confirmed", () => {
  // One row mid-submit and one already in needs_verification, both at acme.
  const rows = [appAt("a1", "acme", "applying"), appAt("a2", "acme", "needs_verification")];
  // Parser domain exactly as index.ts passes it (a vendor sender, so the subject carries the match).
  const domain = classifyMessage(GREENHOUSE_RECEIPT).senderDomain;
  // Two candidates: refuse to guess.
  assert.equal(matchApplication(GREENHOUSE_RECEIPT, domain, rows), null);
  // Positive control: with one acme row the same email DOES match, so the null above is ambiguity, not a dead matcher.
  assert.equal(matchApplication(GREENHOUSE_RECEIPT, domain, [rows[0]!]), "a1");
});

test("the stored email event carries the Gmail thread id", () => {
  // The wire fields the row copies; thread_id, to and label_ids all used to be dropped.
  const message = { message_id: "m-1", thread_id: "t-42", to: "teja@x.com", label_ids: ["applyy"], from: "a@b.c", subject: "s", snippet: "sn", received_at: "2026-10-23T05:00:00.000Z" };
  // A row built exactly as index.ts builds it.
  const row = receipt.emailEventRowOf(message, { classification: "other", confidence: 0.5 }, null, "2026-10-23T05:01:00.000Z");
  // The regression this test exists for: thread_id mapped verbatim, not dropped.
  assert.equal(row.thread_id, "t-42");
  // Same bug class, same pin: the To header and label names land in their columns.
  assert.equal(row.recipient_to, "teja@x.com");
  assert.deepEqual(row.label_ids, ["applyy"]);
  // Null stays null — the columns are nullable and older scripts send neither.
  const nulled = receipt.emailEventRowOf({ ...message, thread_id: null, to: null }, { classification: "other", confidence: 0.5 }, null, "x");
  assert.equal(nulled.thread_id, null);
  assert.equal(nulled.recipient_to, null);
  // Spot-check the rest of the shape so a renamed column can't slip past as "extra key".
  assert.equal(row.provider_message_id, "m-1");
  assert.equal(row.matched_application_id, null);
  assert.equal(row.processed_at, "2026-10-23T05:01:00.000Z");
});

test("intake advances no status while the kill switch is off", () => {
  // Off refuses: the one status-writing agent that never consulted the switch now does.
  assert.equal(receipt.mayAdvanceStatus(false), false);
  // Unreadable (failed read, no settings row) is OFF, not a shrug: fail closed.
  assert.equal(receipt.mayAdvanceStatus(null), false);
  // Only a readable, affirmative true permits a move.
  assert.equal(receipt.mayAdvanceStatus(true), true);
});

test("a needs_verification sibling still trips the ambiguity refusal", () => {
  // One row mid-submit, one parked in the human-review lane, same company: the receipt
  // could belong to either attempt, so matching must refuse rather than guess.
  const rows = [appAt("a1", "acme", "applying"), appAt("a2", "acme", "needs_verification")];
  // Parser domain exactly as index.ts passes it.
  const domain = classifyMessage(GREENHOUSE_RECEIPT).senderDomain;
  // The LIVE pool rule: index.ts loads exactly TRACKED_STATUSES and matches every email
  // against all of them (matchPoolFor, which hid these lanes from non-receipts, is gone).
  const pool = rows.filter((row) => receipt.TRACKED_STATUSES.includes(row.status));
  // Both rows visible — hiding the needs_verification sibling was the 2026-10-23 regression.
  assert.equal(pool.length, 2);
  // Two candidates: refuse, so the wrong row can never be confirmed by the sibling's receipt.
  assert.equal(matchApplication(GREENHOUSE_RECEIPT, domain, pool), null);
});

test("W6: an outcome email for a needs_verification row is matched to it, and its move waits", () => {
  // The row parked for a human check; before W6 a non-receipt never saw it, so the
  // rejection below was stored unmatched and lost for good.
  const rows = [appAt("a2", "acme", "needs_verification")];
  // The ATS rejection fixture from the top of this file (subject names Acme).
  const decision = classifyMessage(REJECTION);
  // The match is KEPT, so the replay sweep can apply it once a human resolves the row.
  assert.equal(matchApplication(REJECTION, decision.senderDomain, rows), "a2");
  // Deferred, not applied: the graph gives the tracker no edge out of needs_verification.
  assert.equal(statusMoveFor(decision, "needs_verification"), null);
  // Once a human sets the row to applied, the same stored verdict moves it.
  assert.equal(statusMoveFor(decision, "applied"), "rejected");
});

// ---- 2026-11-01 W6: the replay sweep's pure planner ---------------------------------------

// A stored email_events row as the replay reads it; each test overrides what it is about.
function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // A confident rejection matched to a1, received at 10:00, never moved.
  return { id: "e1", provider_message_id: "m1", matched_application_id: "a1", classification: "rejection", classification_confidence: 0.95, received_at: "2026-11-01T10:00:00+00:00", ...overrides };
}

test("W6 replayQueue: an email the tracker already moved on is done; the rest come oldest first", () => {
  // m1 moved (its note exists); m2 and m3 pending, deliberately listed newest first (the read order).
  const queue = receipt.replayQueue({
    // The read returns newest first.
    emails: [stored({ id: "e3", provider_message_id: "m3", received_at: "2026-11-01T12:00:00+00:00", matched_application_id: "a2" }), stored({ id: "e2", provider_message_id: "m2", received_at: "2026-11-01T11:00:00+00:00", matched_application_id: "a2" }), stored()],
    // The tracker's note for m1's move: written in the same transaction as the move.
    trackerNotes: [{ provider_message_id: "m1" }],
    // No other moves.
    stageMoves: [],
  });
  // m1 is done; m2 before m3, the order the employer sent them.
  assert.deepEqual(queue.map((email) => email.messageId), ["m2", "m3"]);
  // The typed shape the replay loop reads.
  assert.deepEqual(queue[0], { eventId: "e2", messageId: "m2", applicationId: "a2", classification: "rejection", confidence: 0.95, receivedAt: "2026-11-01T11:00:00+00:00" });
});

test("W6 replayQueue: an email older than one the tracker already moved on is stale (the 2026-10-04 OA replay)", () => {
  // The interview invite of 11:00 moved a1; an OA invite of 10:00 whose move failed must
  // not walk interview -> oa_pending (a legal edge) a day later.
  const moved = stored({ id: "e2", provider_message_id: "m2", classification: "interview_invite", received_at: "2026-11-01T11:00:00+00:00" });
  // The older, never-moved OA invite.
  const olderOa = stored({ classification: "oa_invite" });
  // A NEWER OA invite (12:00) is real news and stays eligible.
  const newerOa = stored({ id: "e3", provider_message_id: "m3", classification: "oa_invite", received_at: "2026-11-01T12:00:00+00:00" });
  // Only the newer one survives.
  const queue = receipt.replayQueue({ emails: [newerOa, moved, olderOa], trackerNotes: [{ provider_message_id: "m2" }], stageMoves: [] });
  // m1 superseded, m3 kept.
  assert.deepEqual(queue.map((email) => email.messageId), ["m3"]);
});

test("W6 replayQueue: a human stage move after the email supersedes it; a move into a submit lane does not", () => {
  // Teja recorded the interview by hand at 11:00, after the 10:00 email arrived: stale.
  const humanStage = { application_id: "a1", agent: "human", to_status: "interview", created_at: "2026-11-01T11:00:00+00:00" };
  // Superseded.
  assert.deepEqual(receipt.replayQueue({ emails: [stored()], trackerNotes: [], stageMoves: [humanStage] }), []);
  // A tracker stage move is judged by EMAIL time (via its note), never by move time: a
  // move made late by a replay must not make every older pending email stale.
  assert.equal(receipt.replayQueue({ emails: [stored()], trackerNotes: [], stageMoves: [{ ...humanStage, agent: "tracker" }] }).length, 1);
  // A human resolving needs_verification -> applied is not an employer stage: the email waits for exactly this.
  assert.equal(receipt.replayQueue({ emails: [stored()], trackerNotes: [], stageMoves: [{ ...humanStage, to_status: "applied" }] }).length, 1);
  // A database-written move with no recorded agent counts as non-tracker: it supersedes.
  assert.deepEqual(receipt.replayQueue({ emails: [stored()], trackerNotes: [], stageMoves: [{ ...humanStage, agent: null }] }), []);
});

test("W6 replayQueue: malformed rows never become a move", () => {
  // An unparseable received_at is not a time (Date.parse("-5") is year -5): skipped.
  assert.deepEqual(receipt.replayQueue({ emails: [stored({ received_at: "-5" })], trackerNotes: [], stageMoves: [] }), []);
  // A confidence that is not a number (a string from a changed column type) is skipped.
  assert.deepEqual(receipt.replayQueue({ emails: [stored({ classification_confidence: "0.95" })], trackerNotes: [], stageMoves: [] }), []);
  // A classification that maps to no move is not replay work.
  assert.deepEqual(receipt.replayQueue({ emails: [stored({ classification: "application_received" })], trackerNotes: [], stageMoves: [] }), []);
  // A stage move with an unreadable time could be newer than anything: it supersedes all (fail closed).
  assert.deepEqual(receipt.replayQueue({ emails: [stored()], trackerNotes: [], stageMoves: [{ application_id: "a1", agent: "human", to_status: "interview", created_at: null }] }), []);
  // A moved email with an unreadable time poisons its application the same way.
  const movedBad = stored({ id: "e0", provider_message_id: "m0", received_at: "garbage" });
  // m1 would otherwise be eligible.
  assert.deepEqual(receipt.replayQueue({ emails: [stored(), movedBad], trackerNotes: [{ provider_message_id: "m0" }], stageMoves: [] }), []);
});

test("W6: the replayable classifications are derived from the status mapping", () => {
  // Exactly the classifications targetStatusFor maps to a status; a receipt is not one.
  assert.deepEqual([...receipt.REPLAYABLE_CLASSIFICATIONS].sort(), ["interview_invite", "oa_invite", "offer", "recruiter_outreach", "rejection"]);
});

test("received-before-applying: a receipt older than the latest entry into applying is refused", () => {
  // A receipt from a previous application to the same posting, an hour before this submit began.
  assert.equal(receipt.receiptConfirmsApplied(confirmInput({ receivedAt: "2026-10-09T09:00:00.000Z" })), false);
  // The same instant is not "after": strictly-greater is the rule.
  assert.equal(receipt.receiptConfirmsApplied(confirmInput({ receivedAt: ENTERED_APPLYING })), false);
});

test("receiptConfirmsApplied: no recorded entry into applying is refused", () => {
  // Without the anchor, a stale receipt cannot be told apart from a fresh one: fail closed.
  assert.equal(receipt.receiptConfirmsApplied(confirmInput({ enteredApplyingAt: null })), false);
  // An unparseable anchor is the same absence in disguise (Date.parse gives NaN).
  assert.equal(receipt.receiptConfirmsApplied(confirmInput({ enteredApplyingAt: "not-a-date" })), false);
});

test("a receipt on an applied row records the event and moves nothing", () => {
  // `applied` is not confirmable; the confirm path stays out of the way.
  assert.equal(receipt.receiptConfirmsApplied(confirmInput({ current: "applied" })), false);
  // Ruling of 2026-10-23: a receipt maps to NO status — "we received your application" is
  // not evidence of screening, so the row stays at applied and only the event is stored.
  assert.equal(statusMoveFor(RECEIPT_DECISION, "applied"), null);
  // A genuine recruiter reply still advances; only the receipt classification went inert.
  assert.equal(statusMoveFor({ classification: "recruiter_outreach", confidence: 0.9 }, "applied"), "employer_screening");
});

test("a non-receipt email on an applying row does nothing", () => {
  // A confident rejection and an interview invite, both on a row mid-submit.
  for (const decision of [{ classification: "rejection", confidence: 0.95 }, { classification: "interview_invite", confidence: 0.95 }] as const) {
    // Not a receipt, so never a confirm, even though every other gate passes.
    assert.equal(receipt.receiptConfirmsApplied(confirmInput({ decision })), false, decision.classification);
    // And the ordinary move path has no tracker edge out of applying either.
    assert.equal(statusMoveFor(decision, "applying"), null, decision.classification);
  }
});

test("a low-confidence receipt on an applying row is refused", () => {
  // Below the non-terminal bar the gate fails, whatever else passes.
  assert.equal(receipt.receiptConfirmsApplied(confirmInput({ decision: { classification: "application_received", confidence: 0.5 } })), false);
});

test("a valid receipt moves an applying row to applied", () => {
  // Every gate passes. Also needs status-flow.ts to give 'tracker' the applying->applied edge.
  assert.equal(receipt.receiptConfirmsApplied(confirmInput()), true);
});

test("a receipt cannot clear needs_verification", () => {
  // The sweeper's parking lane stays human-only (Teja, 2026-10-23): a receipt that would
  // pass every other gate is still refused, because anyone can apply anywhere with Teja's
  // email and mint a genuine receipt — it proves Greenhouse sent mail, not that THIS
  // uncertain submit landed.
  assert.equal(receipt.receiptConfirmsApplied(confirmInput({ current: "needs_verification" })), false);
});

// ---- Review round (2026-10-09): wrong job, replayed receipt, two-address From ----------

test("wrong job: a receipt that doesn't name the job title is refused", () => {
  // Greenhouse signs for every employer: a company-name match alone must not confirm.
  assert.equal(receipt.receiptConfirmsApplied(confirmInput({ titleMatches: false })), false);
  // The title must appear as a whole phrase, punctuation aside.
  const msg = { subject: "Thank you for applying to Acme", snippet: "We received your application for Backend Engineer - India." };
  // Same words, different punctuation: it matches.
  assert.equal(receipt.titleNamedIn(msg, "Backend Engineer, India"), true);
  // A different job at the same company: no match.
  assert.equal(receipt.titleNamedIn(msg, "Frontend Engineer"), false);
  // A partial word is not the title ("Engineering" is not "Engineer").
  assert.equal(receipt.titleNamedIn({ subject: "Engineering roles", snippet: "" }, "Engineer"), false);
  // No title on the row, or a uselessly short one: never a match.
  assert.equal(receipt.titleNamedIn(msg, null), false);
  // Under 4 characters is too generic to be evidence.
  assert.equal(receipt.titleNamedIn({ subject: "SDE role", snippet: "" }, "SDE"), false);
});

test("replay: a receipt addressed to someone else is refused", () => {
  // A genuine signed receipt for another applicant, re-sent to Teja, names its first recipient.
  assert.equal(receipt.receiptConfirmsApplied(confirmInput({ addressedToOwner: false })), false);
  // Teja's own address in the To header, in either form, matches.
  assert.equal(receipt.addressedTo("Teja <TejaMallam00@gmail.com>", "tejamallam00@gmail.com"), true);
  // A different recipient does not.
  assert.equal(receipt.addressedTo("attacker@example.com", "tejamallam00@gmail.com"), false);
  // A superstring of Teja's address is not Teja's address.
  assert.equal(receipt.addressedTo("xtejamallam00@gmail.com", "tejamallam00@gmail.com"), false);
  // No To header, or no configured owner: fail closed.
  assert.equal(receipt.addressedTo(null, "tejamallam00@gmail.com"), false);
  // An unset owner env var arrives as undefined.
  assert.equal(receipt.addressedTo("tejamallam00@gmail.com", undefined), false);
});

test("spoof: owner's address in the display name does not pass the owner check", () => {
  // The quoted display name carries Teja's address but the real recipient is evil@x.com;
  // a whole-header scan would match the name text, so only <...> may be scanned.
  assert.equal(receipt.addressedTo('"tejamallam00@gmail.com" <evil@x.com>', "tejamallam00@gmail.com"), false);
  // The inverse stays true: Teja inside brackets passes even with a decoy display name.
  assert.equal(receipt.addressedTo('"evil@x.com" <tejamallam00@gmail.com>', "tejamallam00@gmail.com"), true);
  // A mixed header (bare owner + a bracketed stranger) fails closed by design.
  assert.equal(receipt.addressedTo("tejamallam00@gmail.com, Name <evil@x.com>", "tejamallam00@gmail.com"), false);
});

test("a From carrying two addresses is refused", () => {
  // Resolving to the first <addr> would let a second, attacker address ride along.
  assert.equal(receipt.verifyReceiptSender("<no-reply@greenhouse.io>, <a@evil.com>", `${GMAIL_AUTHSERV}; dkim=pass header.d=greenhouse.io`), null);
});

test("injection: a quoted mailfrom echoed into the header cannot forge a dkim=pass clause", () => {
  // A quoted local-part may legally carry ';' and spaces; if Gmail echoes it raw into the
  // spf comment or smtp.mailfrom, a naive ';' split reads the embedded text as its own
  // "dkim=pass header.d=greenhouse.io" clause. The parser must refuse, not verify.
  const forged = `${GMAIL_AUTHSERV}; spf=softfail (google.com: domain of "x;dkim=pass header.d=greenhouse.io "@evil.com is not permitted) smtp.mailfrom="x;dkim=pass header.d=greenhouse.io "@evil.com`;
  // The visible From claims the vendor — the exact shape the forged clause would vouch for.
  assert.equal(receipt.verifyReceiptSender("<no-reply@greenhouse.io>", forged), null);
  // Any double quote is refused even without an embedded clause: the tokenizer can't parse it.
  assert.equal(receipt.verifyReceiptSender("<no-reply@greenhouse.io>", `${GMAIL_AUTHSERV}; dkim=pass header.d=greenhouse.io header.b="abc"`), null);
  // An unbalanced comment is not Gmail's shape: refused, never split blind.
  assert.equal(receipt.verifyReceiptSender("<no-reply@greenhouse.io>", `${GMAIL_AUTHSERV}; spf=pass (unclosed; dkim=pass header.d=greenhouse.io smtp.mailfrom=bounces@greenhouse.io`), null);
  // The real Gmail shape — balanced comment, no quotes — still verifies after stripping.
  assert.deepEqual(receipt.verifyReceiptSender("no-reply@us.greenhouse-mail.io", GREENHOUSE_AUTH), { method: "dkim", domain: "us.greenhouse-mail.io" });
});

// ---- W32 (2026-11-02): the tracker can classify an offer, conservatively ----
//
// Before this, classifier.ts had no offer outcome, so targetStatusFor's `case "offer"` was
// dead and interview -> offer (tracker, 0.8 bar) was never taken. `offer` is TERMINAL, so a
// false positive is a wrong irreversible move: the spam cases below matter as much as the hit.

// Namespace import: a missing OFFER_SIGNALS export fails only the guard that reads it.
import * as classifier from "../_shared/email/classifier.ts";

// A real offer, employer-direct: the decision phrase plus the offer-letter corroboration.
const OFFER = {
  // Employer domain sender, so the domain matcher can pin the row.
  from: "Stripe Recruiting <recruiting@stripe.com>",
  // The subject names the offer, which only corroborates.
  subject: "Your offer from Stripe",
  // The decision phrase ("delighted to extend you an offer of employment") is the strong signal.
  snippet: "Hi Teja, following your onsite interview we are delighted to extend you an offer of employment for the Software Engineer role. Your offer letter is attached; please sign and return it by Friday.",
};

test("W32: a real offer email is an offer and moves interview to offer", () => {
  // The classification the tracker stores.
  const decision = classifyMessage(OFFER);
  // An offer, not the interview the snippet also mentions: the later stage wins.
  assert.equal(decision.classification, "offer");
  // Clears the terminal gate on its own decision phrase.
  assert.ok(decision.confidence >= TERMINAL_MIN_CONFIDENCE, `confidence ${decision.confidence}`);
  // The one edge the graph gives the tracker into offer.
  assert.equal(moveFor(OFFER, "interview"), "offer");
  // From applied the graph has no offer edge, so the same email moves nothing.
  assert.equal(moveFor(OFFER, "applied"), null);
});

test("W32: 'pleased to offer you the position' is an offer", () => {
  // The other common phrasing, from an ATS sender this time.
  const message = { from: "Acme <no-reply@greenhouse.io>", subject: "Next steps", snippet: "We are pleased to offer you the position of Backend Engineer at Acme." };
  // An offer.
  assert.equal(classifyMessage(message).classification, "offer");
});

test("W32: recruiter spam about offer letter templates is never an offer", () => {
  // Marketing mail that says "offer letter" and "job offer" without anyone offering a job.
  const spam = [
    // The HR-tooling newsletter the audit named.
    { from: "HR Weekly <news@hrtools.example>", subject: "10 offer letter templates every recruiter needs", snippet: "Download our free offer letter template pack and create a job offer letter in minutes. Exclusive offer: 20% off this week." },
    // A discount that borrows the decision verbs.
    { from: "Deals <deals@shop.example>", subject: "A special offer for you", snippet: "We are pleased to extend an offer of 30% off to our best customers. We're excited to offer you free shipping." },
    // A job board pushing listings: "job offers" in the plural is not an offer to Teja.
    { from: "Jobs <alerts@board.example>", subject: "New job offers matching your profile", snippet: "Here are 25 job offers you may like. Apply today." },
  ];
  // Every one of them.
  for (const message of spam) {
    // Not an offer.
    assert.notEqual(classifyMessage(message).classification, "offer", message.subject);
    // And moves nothing from interview, the only stage an offer could leave.
    assert.equal(moveFor(message, "interview"), null, message.subject);
  }
});

test("W32: a refused offer is never an offer", () => {
  // Negations of the decision verbs, with and without the rejection opener.
  const refusals = [
    // No "unfortunately": no rejection rule fires, so only the offer rule's own wording protects it.
    "We will not be extending an offer for the Software Engineer role at this time.",
    // With the opener: a rejection, which must win.
    "Unfortunately, we are unable to offer you the position.",
  ];
  // Each one.
  for (const snippet of refusals) {
    // Same sender and subject as the real offer, so only the body differs.
    const decision = classifyMessage({ ...OFFER, snippet });
    // Not an offer.
    assert.notEqual(decision.classification, "offer", snippet);
  }
});

test("W32: offer corroborate-only rules, all firing at once, never reach an offer", () => {
  // The flagged offer rules; read live from the classifier, never copied.
  const weak = classifier.OFFER_SIGNALS.filter((rule) => rule.corroborateOnly === true);
  // Guard against a vacuous pass.
  assert.ok(weak.length >= 2, `only ${weak.length} flagged offer rules`);
  // Additive worst case.
  const sum = weak.reduce((total, rule) => total + rule.weight, 0);
  // Under the terminal gate, so subject + attachment wording alone never moves a row.
  assert.ok(sum < TERMINAL_MIN_CONFIDENCE, `offer corroborate-only sum ${sum}`);
  // And the live message built from those signals alone is not an offer.
  const weakOnly = { from: "recruiting@stripe.com", subject: "Your offer letter", snippet: "Your offer letter is attached." };
  // Not an offer.
  assert.notEqual(classifyMessage(weakOnly).classification, "offer");
});

// ---- W33 (2026-11-02): an email with no signal and no match is stored without its text ----
//
// Live 2026-11-01: 97/97 email_events were `unclassified` and none matched, including Google
// security mail (OAuth grants). Storing their subject and body text bought nothing.

// One wire message, every field filled so a dropped field is visible.
const STORABLE = { message_id: "m-9", thread_id: "t-9", to: "teja@x.com", label_ids: ["INBOX"], from: "Google <no-reply@accounts.google.com>", subject: "Security alert", snippet: "A new app was granted access to your Google Account", received_at: "2026-11-01T05:00:00.000Z" };

test("W33: an unclassified, unmatched email is stored without its subject, body or To", () => {
  // Built exactly as index.ts builds it.
  const row = receipt.emailEventRowOf(STORABLE, { classification: "unclassified", confidence: 0.3 }, null, "2026-11-01T05:01:00.000Z");
  // The text columns are NOT NULL, so they are emptied, not nulled.
  assert.deepEqual([row.subject, row.snippet, row.recipient_to], ["", "", null]);
  // The dedup key, sender, time and labels stay: they are what tunes the Gmail query.
  assert.deepEqual([row.provider_message_id, row.from_address, row.received_at, row.label_ids], ["m-9", STORABLE.from, STORABLE.received_at, ["INBOX"]]);
});

test("W33: a matched or classified email keeps its text", () => {
  // Unclassified but matched to an application: the human may need the words.
  const matched = receipt.emailEventRowOf(STORABLE, { classification: "unclassified", confidence: 0.3 }, "a1", "x");
  // Kept whole.
  assert.deepEqual([matched.subject, matched.snippet, matched.recipient_to], [STORABLE.subject, STORABLE.snippet, STORABLE.to]);
  // Classified but unmatched: the words show why matching missed.
  const classified = receipt.emailEventRowOf(STORABLE, { classification: "rejection", confidence: 0.95 }, null, "x");
  // Kept whole.
  assert.deepEqual([classified.subject, classified.snippet], [STORABLE.subject, STORABLE.snippet]);
});

// ---- ATS subjects are kept (Teja, 2026-11-04 20:35 IST: "Keep subjects from ATS senders") ----
//
// The re-match below reads From and Subject only. Live, Axiad's Greenhouse mail named the company
// ONLY in its subject ("Security code for your application to Axiad"), so blanking it made the
// email unmatchable forever. Only the subject is kept: body and To stay blanked, which is the
// narrowest reading of the ruling.

test("ATS subject kept: an unclassified, unmatched Greenhouse email keeps its subject, not its body or To", () => {
  // The live Axiad email's sender and subject.
  const ats = { ...STORABLE, from: "Greenhouse <no-reply@us.greenhouse-mail.io>", subject: "Security code for your application to Axiad" };
  // Built exactly as index.ts builds it.
  const row = receipt.emailEventRowOf(ats, { classification: "unclassified", confidence: 0.3 }, null, "x");
  // Subject kept; body and To still blanked.
  assert.deepEqual([row.subject, row.snippet, row.recipient_to], [ats.subject, "", null]);
});

test("ATS subject kept: workable.com is on the allowlist (85's spec, 2026-11-04)", () => {
  // A look-alike that merely ENDS in the vendor's letters: `notworkable.com` is not workable.com.
  const ats = { ...STORABLE, from: "Printful Hiring <noreply@notworkable.com>", subject: "x" };
  // A workable.com subdomain sender, the shape the suffix rule must cover.
  const workable = { ...STORABLE, from: "Printful Hiring <no-reply@apply.workable.com>", subject: "Your application to Printful" };
  // Kept.
  assert.equal(receipt.emailEventRowOf(workable, { classification: "unclassified", confidence: 0.3 }, null, "x").subject, workable.subject);
  // A look-alike domain is NOT workable.com and stays blanked: the list is closed, not a substring.
  assert.equal(receipt.emailEventRowOf(ats, { classification: "unclassified", confidence: 0.3 }, null, "x").subject, "");
});

test("ATS subject kept: a gmail.com sender is still blanked", () => {
  // Webmail is never an ATS, whatever the subject says.
  const webmail = { ...STORABLE, from: "Someone <someone@gmail.com>", subject: "Your application to Acme" };
  // Blanked as before.
  assert.equal(receipt.emailEventRowOf(webmail, { classification: "unclassified", confidence: 0.3 }, null, "x").subject, "");
});

// ---- Re-match (2026-11-04): an email stored unmatched is linked once its row is tracked ----
//
// Live: 0 of 106 emails ever linked. The 2 job emails both arrived while their row was outside the
// match pool (Bjak blocked_needs_human, Axiad applying under the pre-W6 pool) and the match ran once.

// Bjak as the replay's applications read returns it, with its first approval time.
const BJAK_APP: ActiveApplication = { id: "bjak-1", status: "applied", job_id: "j", jobs: { company_name: "Bjak", company_slug: "bjak", title: "Software Engineer" } };
// The live receipt, as email_events stores it (unmatched).
const BJAK_RECEIPT = { id: "e-bjak", matched_application_id: null, from_address: "Bjak Talent Acquisition Team <no-reply@ashbyhq.com>", subject: "We’ve Received Your Application", snippet: "", received_at: "2026-10-29T09:17:26+00:00" };

test("re-match: the live Bjak receipt links to the Bjak row approved before it arrived", () => {
  // Approved 2026-10-24 13:44 IST, five days before the receipt.
  const plan = receipt.rematchUnmatched([BJAK_RECEIPT], [BJAK_APP], new Map([["bjak-1", "2026-10-24T08:14:13+00:00"]]));
  // One link, to that row.
  assert.deepEqual(plan, [{ eventId: "e-bjak", applicationId: "bjak-1" }]);
});

test("re-match: an email received BEFORE the row was approved never attaches to it", () => {
  // Approved after the email arrived: the email is about an earlier application, not this one.
  const plan = receipt.rematchUnmatched([BJAK_RECEIPT], [BJAK_APP], new Map([["bjak-1", "2026-10-30T00:00:00+00:00"]]));
  // Nothing.
  assert.deepEqual(plan, []);
});

test("re-match: no approval time, a malformed time, or an already-matched row links nothing", () => {
  // No approval on record: fail closed (CLAUDE.md §6).
  assert.deepEqual(receipt.rematchUnmatched([BJAK_RECEIPT], [BJAK_APP], new Map()), []);
  // A received_at Date.parse can't read is not "now".
  assert.deepEqual(receipt.rematchUnmatched([{ ...BJAK_RECEIPT, received_at: "soon" }], [BJAK_APP], new Map([["bjak-1", "2026-10-24T08:14:13+00:00"]])), []);
  // An email already matched elsewhere is never re-pointed.
  assert.deepEqual(receipt.rematchUnmatched([{ ...BJAK_RECEIPT, matched_application_id: "other" }], [BJAK_APP], new Map([["bjak-1", "2026-10-24T08:14:13+00:00"]])), []);
});

// ---- Job alerts (2026-11-05, Teja: track "all jobs allerts apply portal application") -------------
// A board's alert used to be `unclassified`, so W33 blanked it. It is now `job_alert`, kept whole,
// and assigned only when no lifecycle class matched, so it can never pre-empt one.

test("job_alert: a LinkedIn job alert is a job alert, not unclassified", () => {
  // LinkedIn's alert sender and its usual subject shape.
  const decision = classifyMessage({ from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", subject: "Software Engineer: Google and 10 more jobs in Hyderabad", snippet: "Your job alert for Software Engineer in Hyderabad." });
  // The new class.
  assert.equal(decision.classification, "job_alert");
  // It maps to no status: an alert says nothing about an application.
  assert.equal(targetStatusFor(decision.classification), null);
});

test("job_alert: an alert phrase from any sender counts (a company's own careers mailer)", () => {
  // Not a board sender; the subject says what it is.
  const decision = classifyMessage({ from: "Acme Careers <careers@acme.com>", subject: "New jobs matching your profile", snippet: "Here are this week's openings." });
  // The phrase alone is enough.
  assert.equal(decision.classification, "job_alert");
});

test("job_alert: a board's non-job notification stays unclassified (precision)", () => {
  // A board sender, but a social notification with no job wording.
  const decision = classifyMessage({ from: "LinkedIn <notifications-noreply@linkedin.com>", subject: "Priya reacted to your post", snippet: "See who reacted." });
  // Not an alert: it keeps the redacted default.
  assert.equal(decision.classification, "unclassified");
});

test("job_alert: a board-sent interview invite is still an interview invite", () => {
  // A lifecycle outcome from a board sender: the outcome wins, the alert reading is a fallback.
  const decision = classifyMessage({ from: "Naukri <info@naukri.com>", subject: "Interview invitation from Acme", snippet: "We would like to invite you to interview for the Backend Engineer role." });
  // Unchanged by the alert rule.
  assert.equal(decision.classification, "interview_invite");
});

test("job_alert: an unmatched alert keeps its subject and body (W33 redacts unclassified only)", () => {
  // The alert, stored as index.ts stores it.
  const row = receipt.emailEventRowOf({ ...STORABLE, from: "Naukri <jobalert@naukri.com>", subject: "Jobs for you", snippet: "5 new jobs" }, { classification: "job_alert", confidence: 0.6 }, null, "2026-11-05T07:00:00.000Z");
  // Kept whole: an alert is job mail Teja asked to keep.
  assert.deepEqual([row.subject, row.snippet, row.recipient_to], ["Jobs for you", "5 new jobs", "teja@x.com"]);
});

// ---- Match-only rows (2026-11-05): approved / awaiting_approval / blocked_needs_human ------------
// Live: HackerRank's "AI Researcher Intern" mail (oa_invite, 11-04 19:19 UTC) never matched its
// application because that row was `approved`, outside TRACKED_STATUSES. These rows are now MATCH
// candidates (the email is linked) but never MOVE candidates (statusMoveFor refuses them), and they
// are tried only after the tracked rows, never for a company that already has a tracked row.

// The live email's shape, from the recon.
const HACKERRANK_MAIL = { from: "HackerRank Careers <careers@hackerrankcareers.com>", subject: "Exciting News: We have received your Application || AI Researcher Intern || HackerRank", snippet: "" };
// A row of a given status at a given company, with a title for the tiebreak.
const poolApp = (id: string, status: ActiveApplication["status"], slug: string, title: string): ActiveApplication => ({ id, status, job_id: `job-${id}`, jobs: { company_name: slug, company_slug: slug, title } });

test("match-only: an approved HackerRank row is matched by the subject, and its status never moves", async () => {
  // Imported here so the earlier tests do not depend on the new exports.
  const { matchTrackedFirst, MATCH_POOL_STATUSES } = await import("./decide.ts");
  // The pool now includes approved.
  assert.ok(MATCH_POOL_STATUSES.includes("approved"));
  // Sender label 'hackerrankcareers' is not the slug; the subject names it as a whole word.
  const id = matchTrackedFirst(HACKERRANK_MAIL, "hackerrankcareers.com", [poolApp("hr-1", "approved", "hackerrank", "AI Researcher Intern")]);
  // Linked.
  assert.equal(id, "hr-1");
  // Its verdict, as the intake stores it, moves nothing from approved.
  assert.equal(statusMoveFor({ classification: "oa_invite", confidence: 0.95 }, "approved"), null);
});

test("match-only: no status move out of any match-only status, even a confident rejection", () => {
  // Every match-only lane.
  for (const status of ["approved", "awaiting_approval", "blocked_needs_human"] as const) {
    // A confident outcome of each kind.
    for (const classification of ["rejection", "interview_invite", "oa_invite", "offer", "recruiter_outreach"] as const) {
      // Refused by the explicit match-only rule, not only by the graph's missing edge.
      assert.equal(statusMoveFor({ classification, confidence: 0.99 }, status), null, `${classification} at ${status}`);
    }
  }
});

test("match-only: a company with a TRACKED row never falls back to its match-only rows", async () => {
  // Imported as above.
  const { matchTrackedFirst } = await import("./decide.ts");
  // Acme: one applied row, one awaiting_approval row for another role.
  const apps = [poolApp("acme-applied", "applied", "acme", "Backend Engineer"), poolApp("acme-queue", "awaiting_approval", "acme", "Data Engineer")];
  // An Acme rejection naming no title: the tracked row wins, exactly as before the pool grew.
  assert.equal(matchTrackedFirst(REJECTION, null, apps), "acme-applied");
  // Two tracked Acme rows and an untitled email stay ambiguous: never resolved to the queue row.
  const twoTracked = [...apps, poolApp("acme-applied-2", "applied", "acme", "SRE")];
  assert.equal(matchTrackedFirst(REJECTION, null, twoTracked), null);
});

test("match-only: the replay's re-match links a stored email to an approved row approved before it arrived", () => {
  // The stored email, unmatched, as the replay reads it.
  const stored = [{ id: "ev-hr", matched_application_id: null, from_address: HACKERRANK_MAIL.from, subject: HACKERRANK_MAIL.subject, snippet: "", received_at: "2026-11-04T19:19:00.000Z" }];
  // The approved HackerRank row, first approved the day before.
  const links = receipt.rematchUnmatched(stored, [poolApp("hr-1", "approved", "hackerrank", "AI Researcher Intern")], new Map([["hr-1", "2026-11-03T10:00:00.000Z"]]));
  // Linked; the move is a separate question statusMoveFor refuses.
  assert.deepEqual(links, [{ eventId: "ev-hr", applicationId: "hr-1" }]);
});

// ---- A receipt that DESCRIBES the process is not an assessment invite (2026-11-05) ---------------
// Live: HackerRank's receipt (f34b7156) was stored as oa_invite at confidence 1.0. Its body says "If you
// are shortlisted, you will receive a take-home assignment" (technical_assessment, 0.95) and the employer
// IS HackerRank (assessment-platform boost +0.6). Once linked and marked applied, the replay would have
// driven applied -> oa_pending from a receipt. In a receipt, screening now needs a direct invitation.

// The stored row, verbatim (trimmed of its social links, which change nothing).
const HACKERRANK_RECEIPT = {
  from: "no-reply@hackerrankcareers.com",
  subject: "Exciting News: We have received your Application || AI Researcher Intern || HackerRank",
  snippet: "Hi Teja, We greatly appreciate your interest in AI Researcher Intern role at HackerRank. Your application has been received, and we're excited to move forward with our selection process. Our team will carefully review your application within 1 week. If you are shortlisted, you will receive a take-home assignment as the next step in the process. If you do not hear from us within this timeframe, it means we are unable to proceed with your application at this time. Also, don't miss \"What's new on HackerRank! ( https://www.hackerrank.com/whats-new/ )\" Thank you again for considering HackerRank, and we wish you the best of luck in your application process. Thank you, HackerRank Talent Team",
};

test("receipt: HackerRank's 'we have received your application' is application_received, not oa_invite", () => {
  // The live email.
  const decision = classifyMessage(HACKERRANK_RECEIPT);
  // A receipt.
  assert.equal(decision.classification, "application_received");
  // Which moves nothing.
  assert.equal(targetStatusFor(decision.classification), null);
});

test("receipt control: a real HackerRank test invitation stays oa_invite", () => {
  // No receipt wording; a direct invitation with the test link.
  const decision = classifyMessage({ from: "HackerRank <support@hackerrankforwork.com>", subject: "Acme has invited you to take a test", snippet: "Hi Teja, Acme has invited you to complete your HackerRank assessment for the Backend Engineer role. Start the test: https://www.hackerrank.com/tests/abc123/login" });
  // Still an assessment invite.
  assert.equal(decision.classification, "oa_invite");
});

test("receipt control: a receipt that ALSO invites to the assessment stays oa_invite", () => {
  // Receipt wording plus a direct invitation: the invitation is the news.
  const decision = classifyMessage({ from: "Acme Careers <careers@acme.com>", subject: "Thank you for applying to Acme", snippet: "Thank you for applying. As the next step, please complete your HackerRank assessment within 5 days: https://www.hackerrank.com/tests/xyz/login" });
  // The invitation wins.
  assert.equal(decision.classification, "oa_invite");
});

// ---- Careers-suffix sender domains (2026-11-05) ---------------------------------------------------
// Live: HackerRank mails from hackerrankcareers.com; the domain rule wanted the label to EQUAL the slug,
// so it never matched. A label now also matches when it is the slug plus one word from a CLOSED list
// (careers, jobs, talent, hr, recruiting, mail, team). Never a bare prefix.

test("careers suffix: hackerrankcareers.com matches the hackerrank row by domain", () => {
  // Domain alone: an empty subject and a display name that names nothing.
  const id = matchApplication({ from: "Talent Team <no-reply@hackerrankcareers.com>", subject: "Update", snippet: "" }, "hackerrankcareers.com", [app("hr", "hackerrank")]);
  // Matched.
  assert.equal(id, "hr");
});

test("careers suffix: a word outside the closed list does not match (hackerrankx, stripeintern)", () => {
  // Not a listed suffix.
  assert.equal(matchApplication({ from: "x@hackerrankx.com", subject: "Update", snippet: "" }, "hackerrankx.com", [app("hr", "hackerrank")]), null);
  // An intern program domain is not the company's careers mail.
  assert.equal(matchApplication({ from: "x@stripeintern.com", subject: "Update", snippet: "" }, "stripeintern.com", [app("st", "stripe")]), null);
  // And a bare prefix never: 'hack' is not HackerRank.
  assert.equal(matchApplication({ from: "x@hackerrank.com", subject: "Update", snippet: "" }, "hackerrank.com", [app("h", "hack")]), null);
});

test("careers suffix: two companies the label could name is ambiguous, so no match", () => {
  // 'acmecareers' is acme + careers, and also a company literally slugged acmecareers.
  const id = matchApplication({ from: "x@acmecareers.com", subject: "Update", snippet: "" }, "acmecareers.com", [app("a1", "acme"), app("a2", "acmecareers")]);
  // Never a guess.
  assert.equal(id, null);
});
