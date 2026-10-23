// The wire contract between Google Apps Script and `POST /functions/v1/email-tracker-intake`.
//
// WHY THIS IS A SEPARATE PURE MODULE AND NOT INLINE IN THE HANDLER: the handler needs a
// live Deno server, a database and a secret to exercise even once, so anything living
// inside it is effectively untested. Everything that can be decided from the request
// bytes alone lives here instead — pure, synchronous, no clock, no network — which is
// what lets the whole 400/413/202 decision table be covered by cheap table-driven tests
// (PROJECT_PLAN.md §19).
//
// WHAT THE `snippet` FIELD REALLY CARRIES (corrected 2026-10-05; an earlier version of this
// header said Apps Script "never sends the body", which was false). Despite its name,
// `snippet` holds up to 4096 chars of the PLAIN-TEXT BODY (`getPlainBody()`, whitespace
// collapsed, cut by the script and re-cut at MAX_SNIPPET_CHARS below). WHY THE BODY IS SENT:
// the classifier, out-of-office detection and scheduling/assessment link extraction need
// wording that is not in the subject ("we will not be moving forward" lives in the body).
// Only the application matcher ignores it. The cost is real: a recruiter thread can carry a
// phone number, a CTC figure or a home address, and body text is untrusted input to the
// classifier (constraint #17). Shrinking it is the owner's privacy decision and needs a
// Google-side redeploy of the Apps Script. Apps Script itself performs ZERO classification:
// it is a dumb pipe, so the intelligence stays in this repo where it is version-controlled,
// reviewable and testable, rather than in a script editor nobody diffs.

// The untrusted-string marker from the schema owner. It is `string` to the compiler and
// buys no enforcement — it exists so the danger is visible at every use site.
import type { Untrusted } from "../contracts/shared-types.ts";

// Hard ceiling on messages per POST, mirrored in the Apps Script so the script chunks
// rather than discovering the limit as a rejection. Fifty keeps the worst-case body
// comfortably under the size cap below even with maximal snippets.
export const MAX_MESSAGES_PER_BATCH = 50;

// Hard ceiling on the request body. Apps Script splits and retries on a 413, so this is
// a negotiation signal rather than a failure — which is exactly why it must be a byte
// count we actually measure and not a header we are told.
export const MAX_BODY_BYTES = 1_048_576;

// Snippet ceiling. Apps Script truncates to this before sending; we re-truncate here
// rather than rejecting, because a length overrun is our own bug and dropping a
// recruiter's mail to punish it would be the worse outcome.
export const MAX_SNIPPET_CHARS = 4096;
// One Authentication-Results header is a few hundred chars; 4096 leaves room for long
// DKIM selectors. Truncated beyond (it's read for its leading clauses only).
export const MAX_AUTH_RESULTS_CHARS = 4096;

// Defensive ceilings on the short header fields. Generous — these exist to stop a
// pathological payload from reaching the database, not to enforce a format.
const MAX_ADDRESS_CHARS = 512;
const MAX_SUBJECT_CHARS = 2048;
const MAX_MESSAGE_ID_CHARS = 512;

// One Gmail message as Apps Script serialises it. Every string field here is attacker
// controlled in the general case: anyone can email this mailbox, so `from`, `subject`
// and `snippet` are exactly as untrusted as a scraped job description.
export interface IntakeMessage {
  // Gmail's own message id. THE DEDUPE KEY, and the reason this endpoint is idempotent.
  readonly message_id: string;
  // Gmail's thread id. Stored in email_events.thread_id (column added 20260918213000;
  // mapped into the insert since 2026-10-23 — it was validated here but dropped at the
  // insert for two weeks). Null when Gmail sent none or an older script omits it.
  readonly thread_id: string | null;
  // UNTRUSTED. The sender, used later to match an application by company domain.
  readonly from: Untrusted;
  // UNTRUSTED. Which of the user's addresses received it, for multi-alias mailboxes.
  readonly to: Untrusted | null;
  // UNTRUSTED. Reaches Gemini, so it goes inside a fenced untrusted block like any JD.
  readonly subject: Untrusted;
  // UNTRUSTED. Same fencing rule as the subject.
  readonly snippet: Untrusted;
  // ISO-8601. Validated as parseable here so the Tracker never has to defend against
  // an unparseable timestamp reaching a date comparison.
  readonly received_at: string;
  // Gmail labels, used later to distinguish an inbox message from an archived one.
  readonly label_ids: readonly string[];
  // UNTRUSTED as text, but its SHAPE is checked before use: Gmail's own (topmost)
  // Authentication-Results header, which says whether DKIM/SPF passed for the sender's
  // domain. Only the tracker's receipt confirmation reads it (decide.ts verifyReceiptSender);
  // null when the script didn't send it, and then nothing can be confirmed.
  readonly authentication_results: Untrusted | null;
}

// The envelope Apps Script posts. `batch_id` and `sent_at` are observability, not
// identity: the dedupe key is per-message, deliberately, because a time trigger that
// double-fires produces the SAME messages under a DIFFERENT batch id. Deduping on the
// batch would therefore catch nothing at all.
export interface IntakeBatch {
  // The script's own id for this POST. Logged so a duplicate delivery is diagnosable.
  readonly batch_id: string;
  // When the script sent it, for measuring trigger-to-ingest lag.
  readonly sent_at: string;
  // The messages that survived per-message validation.
  readonly messages: readonly IntakeMessage[];
}

// Why one message was refused. Returned to Apps Script in the 202 body rather than
// swallowed, so a systematic serialisation bug is visible in the script's own logs
// instead of presenting as mail that silently never arrives.
export interface RejectedMessage {
  // The id if we could read one, so the script can name the offender. Null when the
  // id itself was the malformed part.
  readonly message_id: string | null;
  // Which field failed and why, in words a human reading an Apps Script log can act on.
  readonly reason: string;
}

// The outcome of validating one request body. A discriminated union rather than throwing,
// because the HTTP status is part of the answer and an exception would lose it.
export type IntakeValidation =
  // The envelope was well formed. `batch` may still carry fewer messages than were sent
  // — see `rejected`, and see the partial-acceptance note below.
  | { readonly ok: true; readonly batch: IntakeBatch; readonly rejected: readonly RejectedMessage[] }
  // The envelope itself was unusable. `status` is the HTTP code to return, and it is
  // decided here rather than by the handler so the decision table is testable.
  | { readonly ok: false; readonly status: 400 | 413; readonly error: string };

// PARTIAL ACCEPTANCE IS A DELIBERATE CHOICE, AND IT IS THE INTERESTING ONE HERE.
//
// The obvious design rejects the whole batch when any message is malformed. That is
// wrong for this endpoint specifically: a 400 tells Apps Script "do not retry", so one
// bad message would permanently discard the other forty-nine — and the mail is gone,
// because the script has already moved past that window. So a malformed ENVELOPE is a
// 400, while a malformed MESSAGE is dropped, counted, and reported in the 202 body.
//
// The general rule this is an instance of: choose the failure granularity that matches
// what the caller can actually retry. Apps Script can retry a batch and cannot retry a
// message, so message-level failures must not be expressed as batch-level ones.

// Narrow an unknown to a plain JSON object. `typeof null === "object"` is the classic
// hole, and arrays are objects too, so both are excluded explicitly.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Read a required string field, enforcing non-emptiness and a length ceiling. Returns
// null on failure so the caller decides whether that is a 400 or a per-message drop.
function readRequiredString(source: Record<string, unknown>, field: string, maxChars: number): string | null {
  // Pull the raw value; a missing key and an explicit undefined are the same failure.
  const raw = source[field];
  // Anything not a string is malformed regardless of what it coerces to — accepting a
  // number here would let `message_id: 0` become the string "0" and collide.
  if (typeof raw !== "string") return null;
  // Trim before the emptiness test, so a whitespace-only id is rejected rather than
  // becoming a valid-looking dedupe key that matches nothing.
  const trimmed = raw.trim();
  // Empty after trimming carries no information and cannot serve as a key.
  if (trimmed.length === 0) return null;
  // Over-length is refused rather than truncated for identity fields, because a
  // truncated id is a DIFFERENT id and would defeat the dedupe it exists to provide.
  if (trimmed.length > maxChars) return null;
  // Survived every test.
  return trimmed;
}

// Read an optional string field. Missing, null and empty all collapse to null, which is
// what the nullable database columns want — three representations of absence reaching
// the same column is how you get `where to is null` quietly missing rows.
function readOptionalString(source: Record<string, unknown>, field: string, maxChars: number): string | null {
  // Pull the raw value.
  const raw = source[field];
  // Absence in any of its forms.
  if (typeof raw !== "string") return null;
  // Normalise surrounding whitespace before deciding it is empty.
  const trimmed = raw.trim();
  // Empty is absence, not a value.
  if (trimmed.length === 0) return null;
  // Optional fields are truncated rather than refused: they are descriptive, not
  // identity, so a shortened value is still useful and refusing one would drop mail.
  return trimmed.slice(0, maxChars);
}

// Read the label array, tolerating absence. Non-string entries are dropped rather than
// failing the message, because labels are advisory metadata and no decision depends on
// their completeness.
function readLabelIds(source: Record<string, unknown>): readonly string[] {
  // Pull the raw value.
  const raw = source["label_ids"];
  // Absent or the wrong shape means no labels, which is a legal state.
  if (!Array.isArray(raw)) return [];
  // Keep only genuine non-empty strings; anything else is noise from a serialisation bug.
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

// Validate an ISO-8601 timestamp and re-emit it in a canonical form. Canonicalising here
// rather than at the database means every row carries the same shape regardless of what
// Apps Script's `Date.toISOString()` happened to produce on a given runtime.
function readTimestamp(source: Record<string, unknown>, field: string): string | null {
  // The field must be present as a string before it can be a date.
  const raw = readRequiredString(source, field, 64);
  // Missing or malformed as a string; nothing to parse.
  if (raw === null) return null;
  // Parse. `Date.parse` accepts a wide range, which is fine — we only need it to be
  // unambiguous enough to order against other timestamps.
  const parsed = Date.parse(raw);
  // NaN is how `Date.parse` reports failure, and it is the only failure mode it has.
  if (Number.isNaN(parsed)) return null;
  // Re-emit canonically so the stored value does not depend on the sender's formatting.
  return new Date(parsed).toISOString();
}

// Validate one message. Returns the message, or the reason it was dropped — never both,
// and never an exception, because one bad message must not abort the loop over the rest.
function validateMessage(candidate: unknown, index: number): { readonly message: IntakeMessage } | { readonly rejected: RejectedMessage } {
  // A non-object entry cannot even yield an id to name in the rejection.
  if (!isPlainObject(candidate)) {
    return { rejected: { message_id: null, reason: `messages[${index}] is not an object` } };
  }
  // The dedupe key first: without it the message cannot be made idempotent, which is
  // the one property this endpoint exists to guarantee.
  const messageId = readRequiredString(candidate, "message_id", MAX_MESSAGE_ID_CHARS);
  // No usable id means the message cannot be stored safely at all.
  if (messageId === null) {
    return { rejected: { message_id: null, reason: `messages[${index}].message_id missing, empty or over ${MAX_MESSAGE_ID_CHARS} chars` } };
  }
  // The sender. Required, because matching an email to an application starts here.
  const from = readRequiredString(candidate, "from", MAX_ADDRESS_CHARS);
  // A message with no sender cannot be correlated with anything.
  if (from === null) {
    return { rejected: { message_id: messageId, reason: "from missing, empty or over length" } };
  }
  // The receipt time. Required and parseable, so no unparseable date ever reaches a
  // comparison downstream.
  const receivedAt = readTimestamp(candidate, "received_at");
  // An unparseable timestamp would order incorrectly against every other row.
  if (receivedAt === null) {
    return { rejected: { message_id: messageId, reason: "received_at missing or not a parseable timestamp" } };
  }
  // The subject. Optional in the wire sense — Gmail genuinely delivers empty-subject
  // mail — so absence becomes an empty string rather than a rejection.
  const subject = readOptionalString(candidate, "subject", MAX_SUBJECT_CHARS) ?? "";
  // The snippet, truncated rather than refused. Apps Script already truncates; this is
  // the defensive second cut, and it protects the classifier's prompt budget too.
  const snippet = readOptionalString(candidate, "snippet", MAX_SNIPPET_CHARS) ?? "";
  // The recipient alias, genuinely optional.
  const to = readOptionalString(candidate, "to", MAX_ADDRESS_CHARS);
  // The thread id, genuinely optional.
  const threadId = readOptionalString(candidate, "thread_id", MAX_MESSAGE_ID_CHARS);
  // Labels, already tolerant of absence.
  const labelIds = readLabelIds(candidate);
  // Gmail's topmost Authentication-Results header, optional: an older script version
  // doesn't send it, and a message without it simply can never confirm a submission.
  const authenticationResults = readOptionalString(candidate, "authentication_results", MAX_AUTH_RESULTS_CHARS);
  // Assemble. Every field is now either validated or explicitly absent.
  return {
    message: {
      message_id: messageId,
      thread_id: threadId,
      from,
      to,
      subject,
      snippet,
      received_at: receivedAt,
      label_ids: labelIds,
      authentication_results: authenticationResults,
    },
  };
}

// THE ENTRY POINT. Takes the raw request body as text — not a parsed object — because
// the size limit is a property of the bytes and must be enforced before `JSON.parse`
// is handed something enormous. Parsing first and measuring afterwards would spend the
// CPU the 413 exists to protect (the Supabase free tier's binding limit is ~2s of CPU).
export function validateIntakeBody(bodyText: string, byteLength: number): IntakeValidation {
  // Size first, and against MEASURED bytes rather than the Content-Length header — a
  // client-supplied header is exactly the wrong thing to enforce a resource limit with.
  if (byteLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: `body is ${byteLength} bytes, limit is ${MAX_BODY_BYTES}` };
  }
  // Parse inside a try: a syntax error is a caller bug, and a bug that will still be a
  // bug on retry, which is why it maps to 400 rather than to 500.
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, status: 400, error: "body is not valid JSON" };
  }
  // The envelope must be an object before any field can be read from it.
  if (!isPlainObject(parsed)) {
    return { ok: false, status: 400, error: "body is not a JSON object" };
  }
  // Batch identity, for correlating this POST with the script's own log line.
  const batchId = readRequiredString(parsed, "batch_id", 128);
  // A batch with no id is diagnosable by nothing, which defeats the observability the
  // field exists for.
  if (batchId === null) {
    return { ok: false, status: 400, error: "batch_id missing or empty" };
  }
  // When the script sent it. Required and parseable for the same reason as received_at.
  const sentAt = readTimestamp(parsed, "sent_at");
  // Unparseable send time.
  if (sentAt === null) {
    return { ok: false, status: 400, error: "sent_at missing or not a parseable timestamp" };
  }
  // The payload itself.
  const rawMessages = parsed["messages"];
  // A non-array here is an envelope-level bug, not a per-message one.
  if (!Array.isArray(rawMessages)) {
    return { ok: false, status: 400, error: "messages is not an array" };
  }
  // OVER-LENGTH IS 413, NOT 400, AND THE DISTINCTION IS LOAD-BEARING. 413 tells Apps
  // Script to split and retry; 400 tells it to give up. A batch of sixty messages is
  // recoverable by splitting, so calling it malformed would discard recoverable mail.
  if (rawMessages.length > MAX_MESSAGES_PER_BATCH) {
    return { ok: false, status: 413, error: `batch has ${rawMessages.length} messages, limit is ${MAX_MESSAGES_PER_BATCH}` };
  }
  // An empty batch is legal and common: the trigger fires every fifteen minutes whether
  // or not mail arrived. Treating it as an error would produce a permanent error rate
  // that is really just an idle mailbox.
  const messages: IntakeMessage[] = [];
  // Rejections accumulate rather than abort, per the partial-acceptance note above.
  const rejected: RejectedMessage[] = [];
  // Ids seen in THIS batch, so a script bug that repeats a message within one POST is
  // caught here rather than by the database's unique violation.
  const seenIds = new Set<string>();
  // Validate each message independently.
  for (let index = 0; index < rawMessages.length; index += 1) {
    // One message's failure must not stop the others.
    const outcome = validateMessage(rawMessages[index], index);
    // Malformed: record why and continue.
    if ("rejected" in outcome) {
      rejected.push(outcome.rejected);
      continue;
    }
    // An in-batch duplicate is counted as rejected rather than inserted twice; the
    // database would refuse the second anyway, and refusing it here keeps the reported
    // counts honest about what was actually submitted.
    if (seenIds.has(outcome.message.message_id)) {
      rejected.push({ message_id: outcome.message.message_id, reason: "duplicate message_id within the same batch" });
      continue;
    }
    // First sighting in this batch.
    seenIds.add(outcome.message.message_id);
    // Accepted.
    messages.push(outcome.message);
  }
  // The envelope was sound, whatever happened to individual messages.
  return { ok: true, batch: { batch_id: batchId, sent_at: sentAt, messages }, rejected };
}
