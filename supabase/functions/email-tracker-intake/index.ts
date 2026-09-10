// POST /functions/v1/email-tracker-intake
//
// The one endpoint in this system that must be publicly reachable. Google Apps Script
// runs inside Google's infrastructure as Teja and cannot mint a Supabase JWT, so this
// function is deployed with `verify_jwt = false` and defends itself with a shared
// secret instead (see `_shared/intake/auth.ts` for why the anon key would be theatre).
//
// WHAT THIS FUNCTION DELIBERATELY DOES NOT DO: classify. Apps Script is a dumb pipe
// and so is this handler — it authenticates, validates, and stores. Classification is
// the Tracker's job, running later against `processed_at is null`. Splitting them is
// what makes a Gemini outage DELAY mail rather than LOSE it: the row is already
// durable before any model is involved.
//
// STATUS CODES ARE INSTRUCTIONS TO APPS SCRIPT, NOT DESCRIPTIONS OF WHAT HAPPENED:
//   202  stored (or already had it) — mark the thread processed
//   400  malformed        — DO NOT RETRY, this will fail identically forever
//   401  bad/absent secret— DO NOT RETRY, go fix the script property
//   405  wrong method     — DO NOT RETRY
//   413  too large        — SPLIT THE BATCH AND RETRY
//   500  our fault        — do nothing; the next 15-minute trigger re-reads the mail
// Returning the wrong one does not surface as an error. It surfaces as mail that
// silently never arrives, weeks later, with nothing in any log pointing at the cause.

// The RLS-bound client factory. No service-role key in this stream — see that file.
import { createAppUserClient } from "../_shared/db/client.ts";
// Shared-secret authentication, with a constant-time comparison.
import { authenticateIntake, INTAKE_SECRET_ENV_VAR, INTAKE_SECRET_HEADER } from "../_shared/intake/auth.ts";
// The pure wire-contract validator: everything decidable from the request bytes alone.
import { MAX_BODY_BYTES, validateIntakeBody, type IntakeMessage } from "../_shared/intake/email-contract.ts";
// The insert shape from the schema owner. Imported, never redefined: a redefined type
// does not fail, it DRIFTS, and drift between the row shape and the code writing that
// row is invisible until production.
import type { EmailEventInsert } from "../_shared/contracts/shared-types.ts";

// Emit a JSON response with the given status. Centralised so no handler path can
// forget the content type and hand Apps Script a body it parses as plain text.
function json(status: number, body: Record<string, unknown>): Response {
  // `Response` is web-standard and available in Deno without an import.
  return new Response(JSON.stringify(body), {
    // The instruction to Apps Script.
    status,
    // Explicit charset so a non-ASCII subject in an error echo cannot be mis-decoded.
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Map one validated wire message onto the database row.
//
// NOTE WHAT IS DROPPED HERE, because it is a real gap and not an oversight:
// `thread_id`, `to` and `label_ids` are validated on the way in and then discarded,
// because `email_events` has no column for them. Thread id in particular is the field
// a future "did this recruiter already reply?" query would want. Validating fields we
// then drop is still worth it — it means the day a column is added, the parser already
// produces the value and only this function changes. Flagged to the schema owner
// rather than quietly dropped in silence.
function toRow(message: IntakeMessage): EmailEventInsert {
  return {
    // `user_id` is deliberately absent: the column defaults to `auth.uid()`, so the
    // signed-in session decides the owner. Supplying it from the request would let a
    // caller nominate whose mailbox this belongs to, which RLS would then have to
    // catch — much better that it is unexpressible.
    provider_message_id: message.message_id,
    // UNTRUSTED, stored inert. Escaped on display, fenced before Gemini.
    from_address: message.from,
    // UNTRUSTED.
    subject: message.subject,
    // UNTRUSTED, and the field most likely to carry an injection payload.
    snippet: message.snippet,
    // Already canonicalised to ISO-8601 by the validator.
    received_at: message.received_at,
  };
}

// The handler. Registered with `Deno.serve`, which is the supported entry point for
// Supabase Edge Functions.
Deno.serve(async (request: Request): Promise<Response> => {
  // METHOD FIRST, and before anything expensive. A GET from a scanner should cost us
  // nothing — not a body read, not a database sign-in.
  if (request.method !== "POST") {
    // 405 rather than 404: the route exists, the verb is wrong, and saying so costs
    // an attacker nothing they could not learn by trying POST.
    return json(405, { error: "method not allowed" });
  }

  // AUTHENTICATE BEFORE READING THE BODY. This ordering is the point: an unauthorised
  // caller must not be able to make us buffer a megabyte, which would turn the
  // endpoint into a cheap way to spend the CPU the free tier bills us for (~2s per
  // invocation, and it is the binding limit — not the 150s wall clock).
  const auth = authenticateIntake(request.headers.get(INTAKE_SECRET_HEADER), Deno.env.get(INTAKE_SECRET_ENV_VAR));
  // Refused, for one of two very different reasons.
  if (!auth.ok) {
    // Log the real reason server-side, where Teja can read it.
    console.error(`[email-tracker-intake] auth refused: ${auth.reason}`);
    // But return a bare code. A 401 body saying "header absent" versus "secret wrong"
    // is free reconnaissance for anyone probing a public URL.
    return json(auth.status, { error: auth.status === 401 ? "unauthorized" : "server misconfigured" });
  }

  // Read the body once, as text. Text rather than `request.json()` because the size
  // limit is a property of the BYTES and must be enforced before `JSON.parse` is
  // handed something enormous.
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch (cause) {
    // A truncated upload is a transport failure, so it is worth retrying — but the
    // next trigger will re-read the same unread mail anyway, so 400 is honest about
    // the fact that THIS body is unusable.
    console.error(`[email-tracker-intake] could not read body: ${String(cause)}`);
    return json(400, { error: "could not read request body" });
  }
  // Measure the ENCODED bytes, never `Content-Length` — a client-supplied header is
  // exactly the wrong thing to enforce a resource limit with.
  const byteLength = new TextEncoder().encode(bodyText).length;

  // Validate the envelope and every message. Pure, and covered by its own tests.
  const validated = validateIntakeBody(bodyText, byteLength);
  // A malformed envelope, or an over-large batch.
  if (!validated.ok) {
    // Log the detail for diagnosis.
    console.error(`[email-tracker-intake] rejected body: ${validated.error}`);
    // Echo the reason here: unlike the auth path, this caller is authenticated, and
    // the reason is precisely what makes an Apps Script bug fixable from its own log.
    return json(validated.status, {
      error: validated.error,
      // Repeat the ceiling so the script can size its chunks without reading source.
      max_body_bytes: MAX_BODY_BYTES,
    });
  }
  // From here the envelope is sound. Individual messages may still have been dropped.
  const { batch, rejected } = validated;

  // An empty batch is the common case — the trigger fires every fifteen minutes
  // whether or not mail arrived. Answer before signing in: a database round trip to
  // insert nothing is pure waste, ninety-six times a day.
  if (batch.messages.length === 0) {
    return json(202, { accepted: 0, duplicates: 0, rejected: rejected.length, batch_id: batch.batch_id });
  }

  // Now, and only now, reach for the database.
  const client = await createAppUserClient();
  // Could not sign in: missing credentials, or a user that was never created.
  if (!client.ok) {
    // Server-side only. The reason distinguishes "no such user" from "wrong password",
    // which is not something a response body should ever say.
    console.error(`[email-tracker-intake] database unavailable: ${client.reason}`);
    // 500 tells Apps Script to do nothing. The mail is still unread in the mailbox, so
    // the next trigger picks it up — the retry mechanism is the script's search window,
    // not a queue we have to build.
    return json(500, { error: "storage unavailable" });
  }

  // IDEMPOTENCY, AND IT IS LOAD-BEARING RATHER THAN POLITENESS. Apps Script time
  // triggers genuinely double-fire, and without this a duplicate delivery would be
  // classified twice — two Gemini calls, on six keys of unmeasured capacity, for zero
  // new information. `ignoreDuplicates` compiles to `ON CONFLICT DO NOTHING` against
  // `email_events_user_message_key`, so the second delivery is a no-op in the database
  // rather than a race we have to lose gracefully.
  const { data: inserted, error } = await client.db
    .from("email_events")
    .upsert(batch.messages.map(toRow), {
      // The unique constraint that makes `message_id` the dedupe key.
      onConflict: "user_id,provider_message_id",
      // DO NOTHING, not DO UPDATE. An update would overwrite a classification the
      // Tracker has already written, silently re-queueing mail that was already handled.
      ignoreDuplicates: true,
    })
    // Only genuinely-inserted rows come back, which is what makes the count below real
    // rather than an assumption about what the database did.
    .select("provider_message_id");

  // A database error is ours, not the caller's.
  if (error !== null) {
    // Full detail server-side.
    console.error(`[email-tracker-intake] insert failed: ${error.message}`);
    // 500: do nothing, the mail is still unread, the next trigger retries it.
    return json(500, { error: "storage failed" });
  }

  // What actually landed. `?? []` because a null `data` with a null `error` should be
  // read as "nothing inserted" rather than crashing on `.length`.
  const acceptedCount = (inserted ?? []).length;
  // Everything submitted that the database already had. Derived by subtraction rather
  // than by a second query — the difference IS the duplicate count, and asking again
  // would cost a round trip to learn something we already know.
  const duplicateCount = batch.messages.length - acceptedCount;

  // 202 Accepted, not 200 OK: the mail is stored but not yet classified, and the
  // status should say so. Apps Script may now mark these threads processed.
  return json(202, {
    // New rows.
    accepted: acceptedCount,
    // Rows we already had — a double-fired trigger reports every message here.
    duplicates: duplicateCount,
    // Messages that never reached the database because they were malformed. Reported
    // rather than swallowed, so a systematic serialisation bug is visible in the
    // script's own log instead of presenting as mail that never arrives.
    rejected: rejected.length,
    // The reasons, so that log line is actionable rather than just a count.
    rejected_detail: rejected,
    // Echoed for correlation with the script's own log line.
    batch_id: batch.batch_id,
  });
});
