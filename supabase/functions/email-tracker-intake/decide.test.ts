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
