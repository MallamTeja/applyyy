// Pure email parser for extracting structured metadata and signals from incoming hiring emails.
//
// WHY THIS IS A PURE SYNCHRONOUS MODULE: Email text from hiring teams (ATS systems, recruiters,
// automated services) arrives as arbitrary untrusted text. Parsing must be pure, deterministic,
// and free of network or database dependencies so that every edge case can be covered by fast
// unit tests without mocks or external infrastructure.
//
// WHY EXTRACTING STRUCTURAL SIGNALS MATTERS: Incoming emails contain noise (HTML markup, tracking pixels,
// boilerplate signatures, and variable formatting). Extracting clean text, company domains, scheduling
// URLs (e.g. Calendly), and assessment platform indicators (e.g. HackerRank, CodeSignal) provides
// high-precision features for outcome classification before keyword heuristics or LLM evaluation.

// Public interface for the parsed email structure returned by `parseEmail`.
export interface ParsedEmail {
  // The raw unmodified subject line as received from the email provider.
  readonly rawSubject: string;
  // The raw unmodified body or snippet text as received from the email provider.
  readonly rawBody: string;
  // The raw sender header string (e.g. "Stripe Recruiting <careers@stripe.com>").
  readonly sender: string;
  // Normalized lowercase subject with collapsed whitespace for case-insensitive matching.
  readonly cleanSubject: string;
  // Sanitized body with HTML tags removed, lowercased, and whitespace collapsed.
  readonly cleanBody: string;
  // The extracted target hiring company domain (e.g. "stripe.com"), filtering out public webmail and ATS hosts.
  readonly extractedCompanyDomain: string | null;
  // Extracted scheduling URL if a known scheduling service link is detected in the email body.
  readonly detectedSchedulingUrl: string | null;
  // Extracted name of technical assessment platform if an online test is detected (e.g. "HackerRank").
  readonly detectedAssessmentPlatform: string | null;
  // Flag indicating whether the email is an automated receipt confirmation or out-of-office reply.
  readonly isAutoReplyOrConfirmation: boolean;
}

// Input payload parameters for the `parseEmail` function.
export interface ParseEmailInput {
  // Raw subject line from email header.
  readonly subject: string;
  // Raw body content or message snippet.
  readonly body: string;
  // Optional sender header string.
  readonly sender?: string;
}

// Known generic webmail providers that should NOT be treated as company domain matches.
//
// WHY WE FILTER THESE: Recruiter emails sent from personal or generic addresses (e.g. Gmail)
// do not represent the hiring entity's organizational domain.
const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "aol.com",
  "mail.com",
  "protonmail.com",
  "zoho.com",
]);

// Known ATS and hiring software domains that host recruiter emails on behalf of employers.
//
// WHY WE FILTER THESE: An email from "no-reply@greenhouse.io" belongs to an ATS vendor,
// not the employer hiring the candidate. Filtering vendor domains isolates the real target domain when available.
// Exported (W33, 2026-11-02) only so the Apps Script test can hold the Gmail query to this list.
export const ATS_VENDOR_DOMAINS: ReadonlySet<string> = new Set([
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "myworkday.com",
  "workday.com",
  "smartrecruiters.com",
  "bamboohr.com",
  "jobvite.com",
  "recruitee.com",
  "breezy.hr",
  "rippling.com",
  "icims.com",
  // Greenhouse notification domain, observed as `us.greenhouse-mail.io` in Greenhouse-sent mail;
  // NOT yet verified against our own mailbox (added 2026-10-06 from general knowledge, not a captured header).
  // Listed as the registrable name so the suffix rule below also covers any regional subdomain.
  "greenhouse-mail.io",
  // Workable (added 2026-11-04 by 85's spec for the ATS-subject allowlist). Its candidate-mail
  // sender domain is NOT yet verified against our mailbox (no Workable mail has arrived).
  "workable.com",
]);

// Is this host a vendor domain or a subdomain of one? (`hire.lever.co` -> lever.co.)
//
// WHY SUFFIX-AWARE (2026-10-06): vendors send from subdomains (`hire.lever.co`), and an exact
// `Set.has` let those through as "employer domains". The email tracker then skipped its
// display-name fallback for them, so "Stripe Recruiting <no-reply@hire.lever.co>" matched nothing.
// WHY THE LEADING DOT: a bare `endsWith("lever.co")` would also swallow an unrelated
// `notlever.co`; the dot makes it a whole-label suffix.
function isAtsVendorHost(domain: string): boolean {
  // Linear scan: twelve-ish entries, called once per email.
  for (const vendor of ATS_VENDOR_DOMAINS) {
    // Exact vendor host, or any subdomain of it.
    if (domain === vendor || domain.endsWith(`.${vendor}`)) return true;
  }
  // Not a known vendor.
  return false;
}

// Known scheduling platform patterns used by recruiters to set up interview calls.
//
// WHY THIS LIST IS EXPLICIT: Scheduling link presence is a direct structural indicator
// of an active interview invitation or screening request.
const SCHEDULING_URL_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  // Calendly scheduling links.
  { name: "Calendly", pattern: /https?:\/\/(?:www\.)?calendly\.com\/[^\s"<>()]+/i },
  // ChiliPiper meeting scheduler links.
  { name: "ChiliPiper", pattern: /https?:\/\/(?:www\.)?[a-z0-9-]+\.chilipiper\.com\/[^\s"<>()]+/i },
  // SavvyCal scheduling links.
  { name: "SavvyCal", pattern: /https?:\/\/(?:www\.)?savvycal\.com\/[^\s"<>()]+/i },
  // HubSpot meetings scheduling links.
  { name: "HubSpot Meetings", pattern: /https?:\/\/meetings\.hubspot\.com\/[^\s"<>()]+/i },
  // YouCanBookMe scheduling links.
  { name: "YouCanBookMe", pattern: /https?:\/\/[a-z0-9-]+\.youcanbook\.me\/[^\s"<>()]+/i },
  // Google Calendar booking / appointment schedule links.
  { name: "Google Calendar", pattern: /https?:\/\/calendar\.google\.com\/calendar\/appointments\/[^\s"<>()]+/i },
];

// Technical screening / online assessment (OA) platform detectors.
//
// WHY WE RECOGNIZE THESE PLATFORMS: Assessment invites from HackerRank, CodeSignal, etc.
// unequivocally indicate an `employer_screening` outcome state.
const ASSESSMENT_PLATFORM_PATTERNS: readonly { readonly platform: string; readonly pattern: RegExp }[] = [
  // HackerRank online assessments.
  { platform: "HackerRank", pattern: /\b(?:hackerrank\.com|hackerrank)\b/i },
  // CodeSignal skills evaluations.
  { platform: "CodeSignal", pattern: /\b(?:codesignal\.com|codesignal)\b/i },
  // Byteboard project assessments.
  { platform: "Byteboard", pattern: /\b(?:byteboard\.dev|byteboard)\b/i },
  // Codility coding challenges.
  { platform: "Codility", pattern: /\b(?:codility\.com|codility)\b/i },
  // TestGorilla pre-employment tests.
  { platform: "TestGorilla", pattern: /\b(?:testgorilla\.com|testgorilla)\b/i },
  // Karat technical interview assessments.
  { platform: "Karat", pattern: /\b(?:karat\.com|karat\.io|karat interview)\b/i },
  // HackerEarth coding challenges.
  { platform: "HackerEarth", pattern: /\b(?:hackerearth\.com|hackerearth)\b/i },
  // Criteria Corp assessment platform.
  { platform: "Criteria Corp", pattern: /\b(?:criteriacorp\.com|criterianet\.com)\b/i },
];

// Patterns that identify generic application receipt acknowledgments or automated out-of-office notes.
//
// WHY WE DETECT THESE SEPARATELY: Application receipt emails ("Thank you for applying") do not change
// application status to interview/screen/rejected, and must be classified as 'unknown' outcome.
const AUTO_REPLY_PATTERNS: readonly RegExp[] = [
  // Standard application receipt subject/body phrases.
  /\bthank\s+you\s+for\s+applying\b/i,
  /\bapplication\s+(?:has\s+been\s+)?received\b/i,
  // "we have" OR the contraction "we've"/"we’ve" (either apostrophe): Bjak's live Ashby receipt
  // (2026-11-04) said "We’ve Received Your Application" and went unclassified under "we have" alone.
  /\bwe(?:\s+have|['’]ve)\s+received\s+your\s+application\b/i,
  /\bapplication\s+confirmation\b/i,
  /\bout\s+of\s+office\b/i,
  /\bautomatic\s+reply\b/i,
  /\bauto-reply\b/i,
];

// Clean HTML tags and unescape common HTML entities from raw text.
//
// WHY HTML STRIPPING IS MANDATORY: Incoming email bodies from ATS systems are formatted with HTML tags
// (`<p>`, `<div>`, `<a href="...">`) which add noise and break keyword proximity analysis.
export function sanitizeHtml(raw: string): string {
  // Return empty string immediately if input is missing or empty.
  if (!raw) return "";

  // Strip script and style blocks entirely along with their contents.
  const codeFree = raw.replace(/<(?:script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/gi, " ");

  // Strip all remaining HTML tags, replacing them with single spaces to prevent concatenating adjacent words.
  const tagFree = codeFree.replace(/<[^>]+>/g, " ");

  // Unescape standard HTML entity encodings into plain text characters.
  const unescaped = tagFree
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  // Collapse consecutive whitespace sequences into a single space and trim surrounding whitespace.
  return unescaped.replace(/\s+/g, " ").trim();
}

// Extract clean lowercased text with whitespace normalized.
//
// WHY REGULARIZING TEXT IS NECESSARY: Pattern matching across subjects and bodies requires
// consistent lowercase formatting and predictable single-space delimiting between terms.
export function normalizeText(text: string): string {
  // Sanitize any HTML elements first.
  const plainText = sanitizeHtml(text);
  // Convert text to lowercase for case-insensitive processing.
  return plainText.toLowerCase();
}

// Extract sender domain from an email header value, filtering out generic email providers and ATS domains.
//
// WHY DOMAIN EXTRACTION IS ISOLATED: Identifying the employer's domain allows matching an incoming
// email event to existing application records in the database by company domain.
export function extractCompanyDomain(senderHeader: string): string | null {
  // The sender's host, or null when the header holds no parseable address.
  const rawDomain = senderHost(senderHeader);
  // Nothing parseable: no employer domain.
  if (rawDomain === null) return null;

  // If raw domain is in public email provider list, it does not represent an employer domain.
  if (PUBLIC_EMAIL_DOMAINS.has(rawDomain)) return null;

  // If raw domain is a known ATS vendor domain OR a subdomain of one, filter it out as vendor infra.
  // Suffix-aware here, in the one shared function, so every caller of the parse gets it.
  if (isAtsVendorHost(rawDomain)) return null;

  // Return valid extracted domain.
  return rawDomain;
}

// Is this sender an ATS vendor (on ATS_VENDOR_DOMAINS, or a subdomain of one)?
//
// WHY (2026-11-04): Teja ruled "Keep subjects from ATS senders". The tracker blanks the subject of
// an unclassified, unmatched email, and Axiad's Greenhouse mail named the company ONLY in its
// subject, so blanking it made a later re-match impossible. A closed list, never a substring
// test (CLAUDE.md §6): `notgreenhouse.io` must not pass.
export function isAtsVendorSender(senderHeader: string): boolean {
  // The same address parse extractCompanyDomain uses, so the two can never disagree on the host.
  const host = senderHost(senderHeader);
  // No address, no vendor.
  return host !== null && isAtsVendorHost(host);
}

// The lowercased host of the sender's address, or null. Shared by extractCompanyDomain and
// isAtsVendorSender (split out 2026-11-04) so one header is never parsed two different ways.
function senderHost(senderHeader: string): string | null {
  // Return null if sender header is empty or undefined.
  if (!senderHeader || senderHeader.trim().length === 0) return null;

  // Extract address portion within angle brackets (e.g. "Name <user@domain.com>") or fallback to raw string.
  const emailMatch = senderHeader.match(/<([^>]+)>/) ?? senderHeader.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);

  // If no valid email address format is present, return null.
  if (!emailMatch) return null;

  // Extract the target email address string.
  const emailAddress = (emailMatch[1] ?? emailMatch[0]).trim().toLowerCase();

  // Split on '@' character to isolate local part and domain part.
  const parts = emailAddress.split("@");

  // If address does not have exactly 2 parts (local@domain), domain cannot be parsed.
  if (parts.length !== 2) return null;

  // The host, trimmed; the caller decides what it means.
  return parts[1]!.trim();
}

// Scan body content for known interview scheduling tool URLs.
//
// WHY SCHEDULING LINK DETECTION HAS ITS OWN HELPER: The presence of an active scheduling URL
// is one of the strongest features for identifying an interview invitation.
export function extractSchedulingUrl(bodyText: string): string | null {
  // Return null if body text is empty.
  if (!bodyText) return null;

  // Iterate over supported scheduling platform patterns.
  for (let i = 0; i < SCHEDULING_URL_PATTERNS.length; i += 1) {
    // Access pattern definition.
    const entry = SCHEDULING_URL_PATTERNS[i]!;
    // Match pattern against raw body text to preserve original URL casing.
    const match = bodyText.match(entry.pattern);
    // If a match is found, return the extracted URL string.
    if (match) {
      return match[0]!;
    }
  }

  // Return null if no scheduling URL was detected.
  return null;
}

// Scan subject and body text for mentions of technical assessment platforms.
//
// WHY ASSESSMENT PLATFORM DETECTION IS SEPARATE: When an email references CodeSignal, HackerRank, etc.,
// it is classified as an employer screening / technical test step.
export function extractAssessmentPlatform(text: string): string | null {
  // Return null if input text is empty.
  if (!text) return null;

  // Iterate over assessment platform detection patterns.
  for (let i = 0; i < ASSESSMENT_PLATFORM_PATTERNS.length; i += 1) {
    // Access pattern definition.
    const entry = ASSESSMENT_PLATFORM_PATTERNS[i]!;
    // Match pattern against input text.
    if (entry.pattern.test(text)) {
      // Return platform name upon first match.
      return entry.platform;
    }
  }

  // Return null if no assessment platform was recognized.
  return null;
}

// Detect if an email is an automated receipt acknowledgment or out-of-office notification.
//
// WHY AUTO-REPLY DETECTION IS ISOLATED: Receipts must not be misclassified as active interviews or rejections.
export function detectAutoReplyOrConfirmation(subject: string, body: string): boolean {
  // Combine cleaned subject and snippet for pattern scanning.
  const combined = `${subject} ${body}`;

  // Check each auto-reply pattern against the combined text.
  for (let i = 0; i < AUTO_REPLY_PATTERNS.length; i += 1) {
    // Access regex pattern.
    const pattern = AUTO_REPLY_PATTERNS[i]!;
    // If pattern matches, flag email as auto-reply / receipt.
    if (pattern.test(combined)) {
      return true;
    }
  }

  // Return false if no auto-reply pattern matched.
  return false;
}

// The main parsing entry point. Takes raw subject, body, and optional sender header,
// and returns a fully parsed, normalized, and feature-annotated `ParsedEmail` object.
//
// WHY THIS FUNCTION ENCAPSULATES ALL PARSING STEPS: Single entry point guarantees
// consistent feature extraction across all email ingestion and classification callers.
export function parseEmail(input: ParseEmailInput): ParsedEmail {
  // Fallback to empty string for missing subject input.
  const rawSubject = input.subject ?? "";
  // Fallback to empty string for missing body input.
  const rawBody = input.body ?? "";
  // Fallback to empty string for missing sender input.
  const sender = input.sender ?? "";

  // Normalize subject text to clean lowercase.
  const cleanSubject = normalizeText(rawSubject);
  // Normalize body text by sanitizing HTML and lowercasing.
  const cleanBody = normalizeText(rawBody);

  // Extract hiring company domain from sender header if present.
  const extractedCompanyDomain = extractCompanyDomain(sender);

  // Extract interview scheduling link from body content.
  const detectedSchedulingUrl = extractSchedulingUrl(rawBody);

  // Extract assessment platform name from subject and body content.
  const detectedAssessmentPlatform = extractAssessmentPlatform(`${rawSubject} ${rawBody}`);

  // Check whether the email is an automated application receipt or out-of-office note.
  const isAutoReplyOrConfirmation = detectAutoReplyOrConfirmation(cleanSubject, cleanBody);

  // Return the immutable parsed email structure.
  return {
    rawSubject,
    rawBody,
    sender,
    cleanSubject,
    cleanBody,
    extractedCompanyDomain,
    detectedSchedulingUrl,
    detectedAssessmentPlatform,
    isAutoReplyOrConfirmation,
  };
}
