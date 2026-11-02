// PURE DECISIONS FOR THE EMAIL TRACKER: what an email means, which status it implies, and
// which application it belongs to.
//
// Split out of `index.ts` on 2026-10-04 so the decisions can be tested under `node --test`
// with no database, network or Deno. `index.ts` keeps the I/O and the ordering.

// Structural feature extraction (domain, auto-reply flag, cleaned text).
import { parseEmail } from "../_shared/email/parser.ts";
// Outcome classifier; it already ranks outcomes above the auto-reply fallback internally.
import { classifyEmail } from "../_shared/email/classifier.ts";
// Schema-owned enum types, so a typo here is a compile error, not a 22P02 at runtime.
// `isTerminal` and `canTransition` are the runtime mirror of the status graph; read them, never a hand-kept list.
// EmailEventInsert types the stored-row builder below against the schema owner's shape.
// EMAIL_CLASSIFICATIONS (the vocabulary as a runtime list) lets the replay's set be DERIVED
// from the status mapping below rather than hand-kept beside it (W6, 2026-11-01).
import { canTransition, EMAIL_CLASSIFICATIONS, isTerminal, type ApplicationStatus, type EmailClassification, type EmailEventInsert } from "../_shared/contracts/shared-types.ts";

// The wire fields the stored email_events row copies. Narrower than `IntakeMessage` for
// the same reason DecidableMessage is: tests build one without the whole wire contract.
export interface StorableMessage {
  // Dedup key, half of (user_id, provider_message_id).
  readonly message_id: string;
  // Gmail thread id, already validated by the contract; null when Gmail sent none.
  readonly thread_id: string | null;
  // The To header, contract-validated; null when absent.
  readonly to: string | null;
  // Gmail label names on the thread at capture; the contract guarantees an array.
  readonly label_ids: readonly string[];
  // Sender header.
  readonly from: string;
  // Subject line.
  readonly subject: string;
  // Body excerpt.
  readonly snippet: string;
  // When Gmail received it (validated ISO).
  readonly received_at: string;
}

// The three message fields the decisions read. Narrower than `IntakeMessage` so tests can
// build one without the wire contract's other fields.
export interface DecidableMessage {
  // Raw sender header, e.g. `Acme Recruiting <no-reply@greenhouse.io>`.
  readonly from: string;
  // Raw subject line.
  readonly subject: string;
  // The body excerpt Apps Script sends.
  readonly snippet: string;
}

// An application the tracker may move, with the joined job fields used for matching.
export interface ActiveApplication {
  // Primary key, written into `email_events.matched_application_id`.
  readonly id: string;
  // Current status; the transition check reads it.
  readonly status: ApplicationStatus;
  // Foreign key to the job; kept because the select returns it.
  readonly job_id: string;
  // Joined job row, or null when the embed is missing.
  readonly jobs: {
    // Display name; not used for matching (substring matches on names caused false hits).
    readonly company_name: string;
    // Normalized slug: the matching key.
    readonly company_slug: string;
    // The job title. Read ONLY by the receipt confirmation, which requires it in the email:
    // Greenhouse signs mail for every employer, so the company alone doesn't pin the job.
    // Optional because the older reads (and fixtures) don't select it; absent = no confirm.
    readonly title?: string | null;
  } | null;
}

// The classification of one message, plus what the stored event row needs.
export interface MessageDecision {
  // The `email_events.classification` value.
  readonly classification: EmailClassification;
  // Classifier confidence, stored alongside.
  readonly confidence: number;
  // Signals behind the verdict, for the event detail.
  readonly matchedSignals: readonly string[];
  // Human-readable reasoning, for the event detail.
  readonly reasoning: string;
  // Employer domain from the sender, or null for webmail/ATS vendor senders.
  readonly senderDomain: string | null;
}

// Out-of-office replies. Checked BEFORE the outcome classifier because an OOO that quotes
// the thread ("Re: Interview invitation") would otherwise classify as the quoted outcome
// and advance an application on a message that says nothing about it.
const OUT_OF_OFFICE = /\b(?:out\s+of\s+(?:the\s+)?office|automatic\s+reply|auto-reply)\b/i;

// Classifies one message.
//
// ORDER IS THE FIX (2026-10-04). The old version checked the parser's auto-reply flag
// FIRST, and that flag matches "thank you for applying" — the opening line of most ATS
// rejections. So "Thank you for applying… unfortunately we will not be moving forward"
// became `application_received`, which THEN mapped to `employer_screening` (since
// 2026-10-23 a receipt maps to no status at all): a rejection advanced the application.
// Now: out-of-office first (never advances), then real outcomes, and the receipt reading
// only when no outcome matched.
export function classifyMessage(message: DecidableMessage): MessageDecision {
  // Parse once; the classifier and the matcher both read the result.
  const parsed = parseEmail({ subject: message.subject, body: message.snippet, sender: message.from });
  // Shared fields every branch returns.
  const senderDomain = parsed.extractedCompanyDomain;
  // Out-of-office: stored as `other`, which maps to no status.
  if (OUT_OF_OFFICE.test(`${parsed.cleanSubject} ${parsed.cleanBody}`)) {
    // Fixed confidence: the pattern is explicit.
    return { classification: "other", confidence: 0.9, matchedSignals: ["out_of_office"], reasoning: "Out-of-office reply; never advances an application.", senderDomain };
  }
  // Outcome classification over the same parse.
  const result = classifyEmail(parsed);
  // Fields carried through from the classifier.
  const base = { confidence: result.confidence, matchedSignals: result.matchedSignals, reasoning: result.reasoning, senderDomain };
  // Interview invitation.
  if (result.outcome === "interviewing") return { classification: "interview_invite", ...base };
  // Rejection, including ones that open with "thank you for applying".
  if (result.outcome === "rejected") return { classification: "rejection", ...base };
  // Offer (W32, 2026-11-02): before this the classifier had no offer outcome, so the
  // `case "offer"` mapping below was dead and interview -> offer was never taken.
  if (result.outcome === "offer") return { classification: "offer", ...base };
  // Screening splits into an assessment invite or plain recruiter contact.
  if (result.outcome === "employer_screening") {
    // Assessment signals, by the classifier's tags and the platform detector's prefix.
    const isAssessment = result.matchedSignals.some((signal) =>
      // Tag names from `classifier.ts` SCREENING_SIGNALS plus structural matches.
      /assessment|codesignal|hackerrank|technical|platform/.test(signal)
    );
    // `oa_invite` -> oa_pending; recruiter contact -> employer_screening.
    return { classification: isAssessment ? "oa_invite" : "recruiter_outreach", ...base };
  }
  // No outcome matched: only now is the receipt reading allowed.
  if (parsed.isAutoReplyOrConfirmation) return { classification: "application_received", ...base };
  // Nothing recognisable.
  return { classification: "unclassified", ...base };
}

// Minimum classifier confidence to MOVE a status into a terminal state (`rejected`).
// WHY 0.8: terminal is irreversible by the tracker (the graph has no edge out), so a wrong
// move needs a human to notice. 0.8 is the classifier's own "confident rejection" cutoff
// (`rejection.score >= 0.8`) and the lowest score that needs a strong phrase on its own.
export const TERMINAL_MIN_CONFIDENCE = 0.8;
// Minimum confidence for any other (recoverable) move.
// WHY 0.7: every interview/screening verdict the classifier emits is already >= 0.7 and the
// receipt reading is 0.9, so this changes nothing for them; it only blocks the 0.5-0.8
// "moderate rejection" band and any low-confidence future verdict.
export const NON_TERMINAL_MIN_CONFIDENCE = 0.7;

// May the tracker act on this verdict? Pure, so it is tested without a database.
// Below the gate the email is still stored with its classification; only the status stays put.
// This is what stops the classifier's moderate-rejection branch (score 0.5 to 0.8): it is
// labelled `rejection` and targets `rejected`, but its confidence is under 0.8, so it is
// visible in `email_events` and never moves an application.
export function passesConfidenceGate(target: ApplicationStatus, confidence: number): boolean {
  // Terminal targets need the higher bar; everything else the lower one.
  const required = isTerminal(target) ? TERMINAL_MIN_CONFIDENCE : NON_TERMINAL_MIN_CONFIDENCE;
  // NaN compares false, so a malformed confidence fails closed.
  return confidence >= required;
}

// The status a classification implies, or null for none. `other` and `unclassified`
// (which include out-of-office) never move anything.
export function targetStatusFor(classification: EmailClassification): ApplicationStatus | null {
  // One case per advancing classification.
  switch (classification) {
    // Interview invite.
    case "interview_invite":
      // The graph allows the tracker this from applied, screening and oa_pending.
      return "interview";
    // Assessment invite.
    case "oa_invite":
      // Includes interview -> oa_pending, the one machine-walkable backward edge.
      return "oa_pending";
    // Rejection.
    case "rejection":
      // Terminal; legal from every active stage.
      return "rejected";
    // Recruiter contact means the employer engaged; the graph labels
    // `applied -> employer_screening` "Acknowledgement or recruiter contact".
    case "recruiter_outreach":
      // Only legal from applied; later stages make canTransition refuse it.
      return "employer_screening";
    // A receipt moves NOTHING by classification (Teja, 2026-10-23): on an `applied` row it
    // is recorded as an event and the status stays put — "we received your application" is
    // not evidence of screening. Confirming a submit is the separate, guarded
    // receiptConfirmsApplied path, which index.ts takes BEFORE this mapping.
    case "application_received":
      // Event only, no status move.
      return null;
    // Offer.
    case "offer":
      // Only legal from interview.
      return "offer";
    // Everything else: no transition.
    default:
      // No status for other, unclassified or out-of-office.
      return null;
  }
}

// The status this verdict should move an application to from `current`, or null for no move.
// One pure answer for "does anything change": a target exists, the graph lets the tracker walk
// that edge, AND the confidence gate passes. `index.ts` calls this so the tested rule is the live one.
export function statusMoveFor(decision: Pick<MessageDecision, "classification" | "confidence">, current: ApplicationStatus): ApplicationStatus | null {
  // The status the classification implies, if any.
  const target = targetStatusFor(decision.classification);
  // No target, or an edge the tracker may not walk: no move.
  if (target === null || !canTransition(current, target, "tracker")) return null;
  // Confidence gate last; below it the email is stored but nothing moves.
  return passesConfidenceGate(target, decision.confidence) ? target : null;
}

// Escapes a slug for use inside a RegExp; slugs are data, not patterns.
function escapeRegExp(text: string): string {
  // Standard metacharacter set.
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Minimum slug length considered. Two-letter slugs ("ai", "hp") match too much text.
const MIN_SLUG_LENGTH = 3;

// Second-level public suffixes under a country code ("co" in co.uk). The registrable label
// sits one to the left of these. WHY A LIST AND NOT A PACKAGE: the lockfile is single-owner, and
// a short list covers the countries employers actually mail from.
// ponytail: incomplete PSL; a rare suffix (e.g. a .co.zz we missed) makes the registrable label
// look like "co", which matches no slug, so it fails CLOSED (an unmatched email, never a wrong one).
// Upgrade path: vendor the full Public Suffix List when a real miss is observed.
const MULTI_PART_SUFFIXES: ReadonlySet<string> = new Set([
  // United Kingdom.
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk",
  // India.
  "co.in", "net.in", "org.in", "ac.in", "gov.in", "firm.in", "ind.in",
  // Australia and New Zealand.
  "com.au", "net.au", "org.au", "edu.au", "co.nz", "org.nz",
  // Japan, South Korea.
  "co.jp", "ne.jp", "or.jp", "ac.jp", "co.kr", "or.kr",
  // Brazil, Mexico, Argentina.
  "com.br", "net.br", "org.br", "com.mx", "com.ar",
  // South Africa, Singapore, Hong Kong, China, Taiwan, Turkey.
  "co.za", "com.sg", "com.hk", "com.cn", "com.tw", "com.tr",
  // Israel, Indonesia, Malaysia, Philippines, Nigeria, Pakistan, Egypt, Saudi Arabia, Vietnam.
  "co.il", "co.id", "com.my", "com.ph", "com.ng", "com.pk", "com.eg", "com.sa", "com.vn",
]);

// The label directly left of the public suffix (`mail.stripe.co.uk` -> `stripe`), or null when
// it cannot be decided. Null fails closed: the caller treats it as no match.
function registrableLabel(senderDomain: string): string | null {
  // Lowercased labels; a trailing dot or empty label means a malformed domain.
  const labels = senderDomain.toLowerCase().split(".");
  // Malformed input (empty label) or a bare TLD: no registrable label to compare.
  if (labels.length < 2 || labels.some((label) => label.length === 0)) return null;
  // Does the last two labels form a known multi-part suffix?
  const lastTwo = labels.slice(-2).join(".");
  // Multi-part suffix: the registrable label is the third from the end; a bare "co.uk" has none.
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return labels.length >= 3 ? labels[labels.length - 3]! : null;
  // Single-label suffix (.com, .io, ...): the registrable label is second from the end.
  return labels[labels.length - 2]!;
}

// Does the sender's domain name this company? Only the REGISTRABLE label is compared, for
// EQUALITY with the slug or the slug without hyphens. Two earlier bugs: `includes` matched
// `meta` inside `metabase`; and then "any non-TLD label" matched `stripe.evil.com`, where the
// attacker (or an unrelated vendor) controls everything left of their own registrable name.
// Subdomains of the real company (`mail.stripe.com`) still match: that label is theirs to issue.
function domainMatches(senderDomain: string, slug: string): boolean {
  // The one label the sender's owner actually registered.
  const label = registrableLabel(senderDomain);
  // Undecidable: fail closed.
  if (label === null) return false;
  // Hyphenated slugs (`scale-ai`) appear unhyphenated in domains (`scaleai.com`).
  const compact = slug.replace(/-/g, "");
  // Exact label equality with either form.
  return label === slug || label === compact;
}

// The From header's DISPLAY NAME only: `Stripe Recruiting <no-reply@hire.lever.co>` -> `Stripe Recruiting `.
// WHY (2026-10-06): the address part is exactly what the domain rule already judged. Letting the text
// fallback read it again would let `x@stripe.evil.com` supply the slug `stripe` through its own
// address and win back the match `registrableLabel` refused. Stripping it lets the fallback run for
// every sender (vendor subdomains included) without reopening that spoof.
function displayNameOf(from: string): string {
  // Drop the bracketed address first (the RFC 5322 `Name <addr>` form).
  const withoutBracketed = from.replace(/<[^>]*>/g, " ");
  // Then any bare or quoted address token (a header that is only `x@stripe.evil.com`, or a
  // display name that is itself an address), since it carries the same untrusted domain.
  return withoutBracketed.replace(/[^\s"'<>]+@[^\s"'<>]+/g, " ");
}

// Does the slug appear as a whole word sequence in the sender's display name or the subject?
// The snippet is excluded: email bodies mention other companies ("we use Stripe for payments").
// The sender ADDRESS is excluded too; see `displayNameOf`.
function slugNamedIn(message: DecidableMessage, slug: string): boolean {
  // Hyphens in the slug match a space or hyphen in text ("scale-ai" ~ "Scale AI").
  const pattern = new RegExp(`(?:^|[^a-z0-9])${slug.split("-").map(escapeRegExp).join("[\\s-]+")}(?:$|[^a-z0-9])`);
  // Lowercased display name plus subject; never the address.
  return pattern.test(`${displayNameOf(message.from)} ${message.subject}`.toLowerCase());
}

// The single application a message belongs to, or null. Null when NOTHING matches and
// also when MORE THAN ONE does: the old first-match-wins loop picked whichever row the
// database returned first, so an email from a company with two open applications moved
// an arbitrary one. Domain evidence outranks text evidence. Since 2026-11-01 (W7) a
// same-company tie is broken by the job title named in the email, and by nothing else.
export function matchApplication(
  // The message being matched.
  message: DecidableMessage,
  // Employer domain from the parser, or null for webmail/ATS senders.
  senderDomain: string | null,
  // Candidate applications.
  applications: readonly ActiveApplication[],
): string | null {
  // Applications with a usable slug.
  const candidates = applications.filter((app) => (app.jobs?.company_slug.length ?? 0) >= MIN_SLUG_LENGTH);
  // Strongest evidence first: the sender's own domain.
  const byDomain = senderDomain === null
    ? []
    : candidates.filter((app) => domainMatches(senderDomain, app.jobs!.company_slug.toLowerCase()));
  // Any domain match decides the question, ambiguous or not. Otherwise the text fallback runs for
  // EVERY sender, including ones with a non-matching domain. WHY NO `senderDomain !== null` SKIP
  // ANY MORE (removed 2026-10-06): that skip refused `x@stripe.evil.com`, but it also refused every
  // vendor subdomain the parser failed to null (`hire.lever.co`), losing real ATS mail. The spoof
  // is now refused by `displayNameOf` instead: the fallback never reads the address, so a domain
  // cannot supply the slug. The trust boundary is unchanged from the null-domain case: a display
  // name and subject are sender-chosen text, exactly as they were for webmail and ATS senders.
  const pool = byDomain.length > 0
    ? byDomain
    : candidates.filter((app) => slugNamedIn(message, app.jobs!.company_slug.toLowerCase()));
  // Exactly one company candidate: the answer, with no title needed.
  if (pool.length === 1) return pool[0]!.id;
  // W7 (2026-11-01): two applications at one company used to make EVERY email from it
  // unmatched. The job title now breaks the tie, by the same whole-phrase rule the receipt
  // confirmation uses (titleNamedIn). Exactly one titled candidate wins; none or several is
  // still null, so a tie is never resolved by a guess. An empty pool also lands here as null.
  const titled = pool.filter((app) => titleNamedIn(message, app.jobs?.title));
  // Exactly one, or nothing.
  return titled.length === 1 ? titled[0]!.id : null;
}

// ---- Receipt confirmation: a verified ATS receipt marks a submitted row `applied` ----------
//
// Teja ruled (2026-10-09 23:24 IST) that a Greenhouse "application received" email may move
// an application the worker tried to submit to `applied`, with no human check — and
// NARROWED it (2026-10-23 10:44 IST) to `applying` rows only: greenhouse.io signs for ALL
// its tenants, so anyone applying anywhere with Teja's email generates a GENUINE receipt,
// and a receipt may close a minutes-old applying row but never clear the human-review
// lane (`needs_verification` stays human-only). Every guard below is mandatory; a missing
// or malformed input refuses (CLAUDE.md §6). Spoofing is the threat: anyone can send
// "Thank you for applying to Acme", so the sender must be the ATS AND Gmail must say so.

// The ATS domains whose receipts may CONFIRM a submission. Deliberately separate from (and
// narrower than) parser.ts's classification list: confirming is higher stakes than reading
// a reply, so only the vendor Teja ruled on is here. Add one only with a verified DKIM sample.
export const CONFIRMING_VENDOR_DOMAINS: readonly string[] = ["greenhouse.io", "greenhouse-mail.io"];

// The one status a receipt may confirm: a row mid-submit. Never an earlier status (a
// receipt can't jump a row the system never sent past approval), and since 2026-10-23 never
// `needs_verification` either — that lane is human-only (multi-tenant signer, see above).
export const CONFIRMABLE_STATUSES: readonly ApplicationStatus[] = ["applying"];

// Every status whose rows are MATCH CANDIDATES, for every classification; index.ts loads
// exactly these rows, and the replay sweep reads the same list.
// Both submit-uncertain lanes (applying, needs_verification) are in it, not just the
// confirmable one. A needs_verification row hidden from the matcher would stop making a
// same-company receipt ambiguous, and its late receipt could then confirm the WRONG row
// (found by security review, 2026-10-23). CONFIRMABLE_STATUSES and the status graph still
// refuse every tracker move out of needs_verification.
// W6 (2026-11-01): outcome emails now see these lanes too. Before, `matchPoolFor` hid them
// from every non-receipt, so a rejection that arrived while the row waited for a human
// check was stored UNMATCHED and lost for good. Now it is stored matched, its move is
// refused by the graph for now, and the replay sweep applies it once a human sets the row
// to applied. The cost: an outcome email that names no job title, from a company that also
// has a row mid-submit, is now ambiguous (null) instead of matched to the post-submit row.
// That is a refusal, never a wrong move; the W7 title tiebreak resolves the titled ones.
export const TRACKED_STATUSES: readonly ApplicationStatus[] = ["applying", "needs_verification", "applied", "employer_screening", "oa_pending", "interview"];

/**
 * Whether the tracker may ADVANCE any status this run, given the kill switch
 * (`system_settings.system_enabled`). Events are always stored — append-only intel is
 * safe to keep; a status MOVE is the dangerous half, so it needs the switch readable AND
 * on. Null means the read failed or found no row: OFF, fail closed (CLAUDE.md §6).
 */
export function mayAdvanceStatus(systemEnabled: boolean | null): boolean {
  // Only an affirmative, readable `true` permits a move; null and false both refuse.
  return systemEnabled === true;
}

/**
 * The email_events row for one decided message. Pure and exported so the stored shape is
 * node-testable — thread_id was captured by Apps Script and validated by the contract
 * since 2026-10-09, then silently dropped by an inline index.ts map no test could reach
 * (found 2026-10-23). The intersection type mirrors index.ts's upsert typing:
 * EmailEventInsert lacks the later-added columns (thread_id, classification, ...), and
 * the Record half is the deliberate escape that lets them ride along.
 */
export function emailEventRowOf(
  message: StorableMessage,
  decision: Pick<MessageDecision, "classification" | "confidence">,
  matchedApplicationId: string | null,
  processedAt: string,
): EmailEventInsert & Record<string, unknown> {
  // W33 (2026-11-02): an email the classifier read nothing in AND that matched no application
  // carries no tracker value, so its words are not kept. Live on 2026-11-01, 97/97 rows were
  // exactly this, including Google security mail (OAuth grants). WHY A MINIMAL ROW, NOT NO ROW:
  // the row still holds the dedup key (a redelivered batch stays a no-op), and its sender, time
  // and labels are what tells a human whether the Gmail query or the classifier is missing real
  // employer mail. Dropping it would make that miss invisible: Apps Script labels the thread
  // after the 202, so the mail is never re-sent. The cost: such an email's text is not
  // re-readable here if the classifier improves; it is still in Gmail.
  const redact = decision.classification === "unclassified" && matchedApplicationId === null;
  return {
    // Deduplication key, half of `(user_id, provider_message_id)`.
    provider_message_id: message.message_id,
    // Gmail's thread id; null stays null (column is nullable, older scripts sent none).
    thread_id: message.thread_id,
    // The To header; same bug class as thread_id — validated, column existed, never mapped.
    // Nulled on a redacted row: an address list is content, not a tuning signal.
    recipient_to: redact ? null : message.to,
    // Label names; copied so the readonly contract array never aliases the insert payload.
    label_ids: [...message.label_ids],
    // Sender header. Kept even when redacted: it is the signal for tuning the Gmail query.
    from_address: message.from,
    // Subject line; emptied (the column is NOT NULL) on a redacted row.
    subject: redact ? "" : message.subject,
    // Body excerpt; emptied (NOT NULL) on a redacted row.
    snippet: redact ? "" : message.snippet,
    // When Gmail received it.
    received_at: message.received_at,
    // Verdict.
    classification: decision.classification,
    // Verdict confidence.
    classification_confidence: decision.confidence,
    // Null when unmatched or ambiguous; the message is still stored.
    matched_application_id: matchedApplicationId,
    // Processing time.
    processed_at: processedAt,
  };
}

// ---- Replay: re-drive stored outcome emails whose move never happened (W6, 2026-11-01) ----
//
// The tracker used to try each move ONCE, in the call that first stored the email. A move
// skipped by the kill switch, refused by the database, or deferred because the row sat in
// needs_verification was lost for good, and the run still closed green. Pending work is
// now DERIVED FROM DATA every run (a reconcile sweep, the outbox pattern without an outbox
// table): an email is done when the tracker's own note for its move names its message id.
// advance_application_status writes that note (p_detail) in the SAME transaction as the
// move, so "a note exists" and "the move committed" can never disagree.

/** The classifications whose verdict can move a status: derived, so it can't drift from the mapping. */
export const REPLAYABLE_CLASSIFICATIONS: readonly EmailClassification[] = EMAIL_CLASSIFICATIONS.filter(
  // A classification is replay work exactly when targetStatusFor maps it somewhere.
  (classification) => targetStatusFor(classification) !== null,
);

// The non-terminal statuses an employer email moves a row INTO. A move into one of these by
// anyone OTHER than the tracker (Teja recording an interview by hand) supersedes every email
// received before it. Moves into applying, needs_verification or applied are submit
// bookkeeping, not employer news, so they supersede nothing: a rejection that arrived while
// the row waited for a human check must still apply after the human sets it to applied.
export const EMPLOYER_STAGES: readonly ApplicationStatus[] = ["employer_screening", "oa_pending", "interview"];

/** One stored email the replay may act on, after its row passed the shape checks. */
export interface ReplayEmail {
  // email_events.id, for the move's evidence trail.
  readonly eventId: string;
  // provider_message_id: the key the move's note records.
  readonly messageId: string;
  // matched_application_id.
  readonly applicationId: string;
  // The stored verdict; statusMoveFor reads it exactly as on the first try.
  readonly classification: EmailClassification;
  // The stored confidence; the same confidence gate applies.
  readonly confidence: number;
  // When Gmail received it, as stored.
  readonly receivedAt: string;
}

/** An ISO-8601 instant as epoch ms, or null. Shape first: Date.parse("-5") is year -5 (CLAUDE.md §6). */
function instantOf(value: unknown): number | null {
  // Only a string that starts like a date-time is a candidate.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  // Then it must actually parse.
  const ms = Date.parse(value);
  // NaN is not a time.
  return Number.isFinite(ms) ? ms : null;
}

/** A non-empty string, or null: every id the replay keys on must be one. */
function idOf(value: unknown): string | null {
  // An empty or non-string id could never be matched to anything.
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Raises the newest-known instant for an application; an unreadable one becomes +Infinity. */
function raise(newest: Map<string, number>, applicationId: string, at: number | null): void {
  // Unreadable time: it could be newer than anything, so it supersedes everything (fail closed).
  const ms = at ?? Number.POSITIVE_INFINITY;
  // Keep the maximum.
  newest.set(applicationId, Math.max(newest.get(applicationId) ?? Number.NEGATIVE_INFINITY, ms));
}

/**
 * The stored emails whose move is still owed, oldest first. Pure: the I/O lives in replay.ts.
 * Rows arrive untyped from three reads and are shape-checked here, where a test can see it.
 * An email is owed when ALL hold: it carries a replayable verdict; the tracker has no note
 * for its message id; it is strictly newer than every email the tracker already moved its
 * row on (the 2026-10-04 bug: a week-old OA invite walking interview -> oa_pending); and it
 * is strictly newer than every non-tracker move of its row into an employer stage.
 * Whether it moves, and where, is still statusMoveFor's call at the row's current status.
 */
export function replayQueue(input: {
  // email_events rows: id, provider_message_id, matched_application_id, classification,
  // classification_confidence, received_at. Moved and pending alike.
  readonly emails: readonly Record<string, unknown>[];
  // The tracker's note rows, projected to { provider_message_id }.
  readonly trackerNotes: readonly Record<string, unknown>[];
  // status_change rows into EMPLOYER_STAGES: application_id, agent, to_status, created_at.
  readonly stageMoves: readonly Record<string, unknown>[];
}): ReplayEmail[] {
  // Message ids the tracker has already moved a row on.
  const moved = new Set(input.trackerNotes.map((note) => idOf(note.provider_message_id)).filter((id): id is string => id !== null));
  // Per application: the newest instant that makes older emails stale.
  const newestSettled = new Map<string, number>();
  // Pending candidates, before the staleness filter.
  const pending: ReplayEmail[] = [];
  // One pass over the stored emails.
  for (const row of input.emails) {
    // Both keys are required; without them the row can't be tied to anything.
    const messageId = idOf(row.provider_message_id);
    const applicationId = idOf(row.matched_application_id);
    // Untieable: skipped, never moved.
    if (messageId === null || applicationId === null) continue;
    // Already moved on: it supersedes older emails, by the time the EMPLOYER sent it. Move
    // time would be wrong here: a replay that moves an email late would make every older
    // pending email stale, even ones the employer sent after it.
    if (moved.has(messageId)) {
      // Newest settled email for this row.
      raise(newestSettled, applicationId, instantOf(row.received_at));
      // Done; never a candidate.
      continue;
    }
    // The rest of the shape, checked before anything is trusted.
    const eventId = idOf(row.id);
    const classification = row.classification as EmailClassification;
    const confidence = row.classification_confidence;
    // A non-replayable or unknown verdict, a non-number confidence, or no event id: skipped.
    if (eventId === null || !REPLAYABLE_CLASSIFICATIONS.includes(classification) || typeof confidence !== "number") continue;
    // An unreadable receipt time can't be ordered: skipped.
    if (instantOf(row.received_at) === null) continue;
    // A candidate; received_at is a string (instantOf checked it).
    pending.push({ eventId, messageId, applicationId, classification, confidence, receivedAt: row.received_at as string });
  }
  // Non-tracker moves into an employer stage supersede older emails, by MOVE time: the
  // human acted on the state as it stood then. A null agent (a row the database wrote
  // before an actor was known) is treated as non-tracker, which supersedes: fail closed.
  for (const row of input.stageMoves) {
    // Tracker moves are judged by email time above, never here.
    if (row.agent === "tracker") continue;
    // Only employer stages; the read filters on this too, and the planner doesn't trust it.
    if (!EMPLOYER_STAGES.includes(row.to_status as ApplicationStatus)) continue;
    // The row it moved; untieable moves are skipped (application_id is NOT NULL anyway).
    const applicationId = idOf(row.application_id);
    if (applicationId === null) continue;
    // Raised to this move's time; unreadable = +Infinity = supersedes all.
    raise(newestSettled, applicationId, instantOf(row.created_at));
  }
  // Owed = strictly newer than everything that settled its row; then oldest first, the
  // order the employer sent them, with the message id as a stable tiebreak.
  return pending
    // Strictly newer: an email at the same instant as a settled one is not news.
    .filter((email) => instantOf(email.receivedAt)! > (newestSettled.get(email.applicationId) ?? Number.NEGATIVE_INFINITY))
    // Oldest first.
    .sort((a, b) => instantOf(a.receivedAt)! - instantOf(b.receivedAt)! || a.messageId.localeCompare(b.messageId));
}

// The one authserv-id whose verdict is trusted. Gmail PREPENDS its own
// Authentication-Results header; a sender can embed a forged one lower down, but it can't
// make one appear above Google's, and the script sends only the topmost (email-tracker.gs).
const TRUSTED_AUTHSERV_ID = "mx.google.com";

/** The vendor a domain belongs to (the domain itself or a subdomain of it), or null. */
function confirmingVendorOf(domain: string): string | null {
  // Lowercased once; DNS names are case-insensitive.
  const lowered = domain.toLowerCase();
  // Equal, or a true subdomain: the "." prefix stops "evilgreenhouse.io" from matching.
  return CONFIRMING_VENDOR_DOMAINS.find((vendor) => lowered === vendor || lowered.endsWith(`.${vendor}`)) ?? null;
}

/** The domain of the sender's address ("Name <a@b.c>" or a bare "a@b.c"), or null. */
function senderAddressDomain(from: string): string | null {
  // Exactly one address: "<b@greenhouse.io>, <a@evil.com>" or a display name hiding a
  // second address is refused outright rather than resolved to whichever comes first.
  if (from.split("@").length !== 2) return null;
  // The angle-bracket address wins over any address-like text in the display name.
  const angled = from.match(/<([^<>@\s]+)@([^<>@\s]+)>/);
  // A bare address is accepted only when it is the WHOLE header (no display name to hide in).
  const bare = from.trim().match(/^([^<>@\s]+)@([^<>@\s]+)$/);
  // The domain part of whichever matched.
  const domain = angled?.[2] ?? bare?.[2] ?? null;
  // Shape check: letters, digits, dots and hyphens only, with at least one dot.
  return domain !== null && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain.toLowerCase() : null;
}

/** The domain named by an `@domain`, `user@domain` or bare `domain` property value. */
function propertyDomain(value: string): string | null {
  // Strip a leading "user@" or "@"; what remains must be a plain domain.
  const domain = value.includes("@") ? value.slice(value.lastIndexOf("@") + 1) : value;
  // Same shape check as the sender's domain.
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain.toLowerCase() : null;
}

/**
 * Whether Gmail verified this receipt as really sent by a confirming ATS vendor, and how.
 * Null (refuse) unless: the sender is on a vendor domain V; the header's authserv-id is
 * mx.google.com; and a dkim=pass clause signs for V (header.d / header.i) or, failing
 * that, an spf=pass clause names V (smtp.mailfrom). The signing domain must be the SAME
 * vendor as the sender, so a Lever-signed mail can't vouch for a "greenhouse" From.
 */
export function verifyReceiptSender(
  from: string,
  authenticationResults: string | null,
): { readonly method: "dkim" | "spf"; readonly domain: string } | null {
  // The vendor the visible sender claims.
  const senderDomain = senderAddressDomain(from);
  // Not a confirming vendor (or no parseable address): never a confirmation.
  const vendor = senderDomain === null ? null : confirmingVendorOf(senderDomain);
  if (vendor === null) return null;
  // No header (older script, or stripped): fail closed.
  if (authenticationResults === null || authenticationResults.trim() === "") return null;
  // RFC 8601 allows quoted strings, and a quoted mailfrom local-part may carry ';' and
  // spaces — text the naive split below would read as a forged "dkim=pass" clause. Gmail's
  // own result clauses for these vendors never carry a double quote, so any quote means a
  // header this tokenizer cannot parse safely: refuse it outright.
  if (authenticationResults.includes('"')) return null;
  // Parenthesised comments (e.g. Gmail's spf "(google.com: domain of ...)") echo
  // sender-chosen text, so they must vanish BEFORE the ';' split, never feed it.
  let stripped = authenticationResults;
  // Innermost-out so nested comments unwind; the fixed cap bounds a pathological header.
  for (let depth = 0; depth < 10 && /\([^()]*\)/.test(stripped); depth++) {
    // Each innermost "(...)" becomes a space, preserving token boundaries around it.
    stripped = stripped.replace(/\([^()]*\)/g, " ");
  }
  // A surviving paren is an unbalanced or over-deep comment — not Gmail's shape: refuse.
  if (stripped.includes("(") || stripped.includes(")")) return null;
  // RFC 8601: "authserv-id; method=result prop=value ...; method=result ...".
  const clauses = stripped.split(";").map((clause) => clause.trim());
  // Only Gmail's own verdict counts; anything else may be sender-written.
  if (clauses[0]!.toLowerCase() !== TRUSTED_AUTHSERV_ID) return null;

  // The clauses after the authserv-id, each tokenised on whitespace.
  const results = clauses.slice(1).map((clause) => clause.split(/\s+/).map((token) => token.toLowerCase()));
  // DKIM first: it signs the message itself, the stronger evidence.
  for (const tokens of results) {
    // Exactly "dkim=pass" as the method token; "dkim=fail"/"dkim=neutral" never pass.
    if (tokens[0] !== "dkim=pass") continue;
    // The signing domain: header.d= or header.i=@domain.
    const property = tokens.find((token) => token.startsWith("header.d=") || token.startsWith("header.i="));
    // The domain named by that property, if well formed.
    const domain = property === undefined ? null : propertyDomain(property.slice(property.indexOf("=") + 1));
    // It must sign for the SAME vendor the sender claims.
    if (domain !== null && confirmingVendorOf(domain) === vendor) return { method: "dkim", domain };
  }
  // SPF as the fallback: the envelope sender's domain was authorised to send.
  for (const tokens of results) {
    // Exactly "spf=pass".
    if (tokens[0] !== "spf=pass") continue;
    // The envelope sender, smtp.mailfrom=addr or =domain.
    const property = tokens.find((token) => token.startsWith("smtp.mailfrom="));
    // Its domain, if well formed.
    const domain = property === undefined ? null : propertyDomain(property.slice("smtp.mailfrom=".length));
    // Same vendor as the visible sender.
    if (domain !== null && confirmingVendorOf(domain) === vendor) return { method: "spf", domain };
  }
  // Nothing passed for this vendor.
  return null;
}

/**
 * Whether this email confirms that this application was submitted, i.e. may move it to
 * `applied`. Every condition is required; the caller has already matched it to exactly one
 * row (matchApplication) and verified the sender (verifyReceiptSender).
 */
export function receiptConfirmsApplied(input: {
  // What the email is.
  readonly decision: Pick<MessageDecision, "classification" | "confidence">;
  // Where the matched row is now.
  readonly current: ApplicationStatus;
  // When Gmail received the email (validated ISO by the contract).
  readonly receivedAt: string;
  // When the row LAST entered `applying` (application_events), or null if never.
  readonly enteredApplyingAt: string | null;
  // verifyReceiptSender's verdict for this email.
  readonly verification: { readonly method: "dkim" | "spf"; readonly domain: string } | null;
  // titleNamedIn: the email names THIS job, not just this company.
  readonly titleMatches: boolean;
  // addressedTo: the signed To header names Teja, so it isn't someone else's replayed receipt.
  readonly addressedToOwner: boolean;
}): boolean {
  // Another employer's (or another job's) Greenhouse mail is DKIM-valid too: the job title
  // must be named, so a company-name coincidence can't confirm the wrong row.
  if (!input.titleMatches) return false;
  // A genuine signed receipt for SOMEONE ELSE, re-sent to Teja, still passes DKIM; the To
  // it was signed with names the original recipient, so it is refused here.
  if (!input.addressedToOwner) return false;
  // Only rows the worker tried to submit.
  if (!CONFIRMABLE_STATUSES.includes(input.current)) return false;
  // Only a receipt; an interview, rejection or outreach email is not proof of a submit.
  if (input.decision.classification !== "application_received") return false;
  // The same confidence bar as every other tracker move.
  if (!passesConfidenceGate("applied", input.decision.confidence)) return false;
  // The graph must allow it (status-flow.ts mirrors the database guard).
  if (!canTransition(input.current, "applied", "tracker")) return false;
  // Gmail must have verified the vendor.
  if (input.verification === null) return false;
  // No recorded submit attempt: a receipt can't be matched to one in time.
  if (input.enteredApplyingAt === null) return false;
  // Both instants, parsed; a malformed stamp is not a time (Date.parse("-5") is year -5,
  // but the contract and the database only ever hand us ISO strings).
  const received = Date.parse(input.receivedAt);
  const entered = Date.parse(input.enteredApplyingAt);
  if (!Number.isFinite(received) || !Number.isFinite(entered)) return false;
  // STRICTLY after the latest submit attempt: an older receipt is for an earlier
  // application (or a manual one) to the same company, not this submit.
  return received > entered;
}

/** Lowercased words separated by single spaces, so punctuation differences don't matter. */
function wordsOf(text: string): string {
  // "Backend Engineer, India" and "Backend Engineer - India" both become "backend engineer india".
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Whether the email names this job's title, as a whole phrase in the subject or body.
 * Greenhouse's DKIM key signs mail for every Greenhouse employer, and a subject naming the
 * company proves only the company. A missing or very short title never matches.
 */
export function titleNamedIn(message: { readonly subject: string; readonly snippet: string }, title: string | null | undefined): boolean {
  // No title on the job row: nothing to pin the receipt to.
  if (title === null || title === undefined) return false;
  // The title as words.
  const phrase = wordsOf(title);
  // Under 4 characters is too generic to be evidence ("qa", "sde").
  if (phrase.length < 4) return false;
  // Subject and body together, as words; padded so only whole words match.
  const haystack = ` ${wordsOf(`${message.subject} ${message.snippet}`)} `;
  // The whole title phrase, word-bounded.
  return haystack.includes(` ${phrase} `);
}

/**
 * Whether the To header names the owner's address. A DKIM signature covers the To header,
 * so a receipt someone else received and re-sent to Teja still names its first recipient.
 * Fails closed when either side is missing.
 */
export function addressedTo(to: string | null, ownerEmail: string | null | undefined): boolean {
  // Unknown owner (unset env) or no To header: can't prove it was sent to Teja.
  if (to === null || ownerEmail === null || ownerEmail === undefined || ownerEmail.trim() === "") return false;
  // The owner's address, normalised.
  const owner = ownerEmail.trim().toLowerCase();
  // The header, normalised once so bracket detection and matching see the same text.
  const header = to.toLowerCase();
  // A display name is attacker-controlled text: '"owner@real" <evil@x>' would pass a
  // whole-header scan. So when any <...> brackets are present, only the bracketed
  // addr-specs count as recipients; a mixed header's bare addresses are dropped, which
  // fails closed (a false "not Teja") rather than open.
  const scanned = header.includes("<")
    // Join the bracket contents; non-greedy per-bracket via the [^<>] class.
    ? (header.match(/<[^<>]*>/g) ?? []).join(" ")
    // No brackets anywhere: the header is a bare address list, scan it whole.
    : header;
  // Every address in the chosen text ("a@b, c@d").
  // Typed explicitly: `?? []` alone infers never[], which `includes(owner)` rejects.
  const addresses: readonly string[] = scanned.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? [];
  // Exact address equality, never a substring ("xteja@gmail.com" is not "teja@gmail.com").
  return addresses.includes(owner);
}
