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
import type { ApplicationStatus, EmailClassification } from "../_shared/contracts/shared-types.ts";

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
// became `application_received`, which maps to `employer_screening`: a rejection advanced
// the application. Now: out-of-office first (never advances), then real outcomes, and the
// receipt reading only when no outcome matched.
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
    // Recruiter contact and an acknowledgement both mean the employer engaged; the graph
    // labels `applied -> employer_screening` "Acknowledgement or recruiter contact".
    case "recruiter_outreach":
    case "application_received":
      // Only legal from applied; later stages make canTransition refuse it.
      return "employer_screening";
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

// Escapes a slug for use inside a RegExp; slugs are data, not patterns.
function escapeRegExp(text: string): string {
  // Standard metacharacter set.
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Minimum slug length considered. Two-letter slugs ("ai", "hp") match too much text.
const MIN_SLUG_LENGTH = 3;

// Does the sender's domain name this company exactly? Compares each domain label except
// the TLD (`careers.stripe.com` -> `careers`, `stripe`) for EQUALITY with the slug or the
// slug without hyphens. Equality, not `includes`: the old substring test matched
// `meta` inside `metabase` and `ola` inside `motorola`.
function domainMatches(senderDomain: string, slug: string): boolean {
  // Labels without the final TLD.
  const labels = senderDomain.toLowerCase().split(".").slice(0, -1);
  // Hyphenated slugs (`scale-ai`) appear unhyphenated in domains (`scaleai.com`).
  const compact = slug.replace(/-/g, "");
  // Exact label equality with either form.
  return labels.some((label) => label === slug || label === compact);
}

// Does the slug appear as a whole word sequence in the sender or subject? The snippet is
// excluded: email bodies mention other companies ("we use Stripe for payments").
function slugNamedIn(message: DecidableMessage, slug: string): boolean {
  // Hyphens in the slug match a space or hyphen in text ("scale-ai" ~ "Scale AI").
  const pattern = new RegExp(`(?:^|[^a-z0-9])${slug.split("-").map(escapeRegExp).join("[\\s-]+")}(?:$|[^a-z0-9])`);
  // Lowercased header text only.
  return pattern.test(`${message.from} ${message.subject}`.toLowerCase());
}

// The single application a message belongs to, or null. Null when NOTHING matches and
// also when MORE THAN ONE does: the old first-match-wins loop picked whichever row the
// database returned first, so an email from a company with two open applications moved
// an arbitrary one. Domain evidence outranks text evidence.
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
  // Any domain match decides the question, ambiguous or not.
  const pool = byDomain.length > 0
    ? byDomain
    : candidates.filter((app) => slugNamedIn(message, app.jobs!.company_slug.toLowerCase()));
  // Exactly one, or nothing.
  return pool.length === 1 ? pool[0]!.id : null;
}
