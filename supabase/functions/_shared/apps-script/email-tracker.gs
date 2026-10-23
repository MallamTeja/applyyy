/**
 * applyy — Gmail → Supabase email tracker.
 *
 * THE CANONICAL COPY OF THIS SCRIPT LIVES HERE, IN THE REPO. The copy in the Apps
 * Script editor is a deployment of this file, not the source of truth. That direction
 * matters: a script that exists only in a browser editor is un-reviewed, un-diffed and
 * un-recoverable, and the whole reason PROJECT_PLAN §12 chose Apps Script was to keep
 * the intelligence in the repo — so the pipe itself had better be in the repo too.
 *
 * WHAT THIS SCRIPT IS: a dumb pipe. It reads message headers AND the plain-text body
 * (first 4096 chars, see the `snippet` field below), POSTs them, and labels what it sent.
 * It performs ZERO classification — no keyword matching, no "is this a
 * rejection", nothing. All of that happens in the Edge Function where it is
 * version-controlled and testable.
 *
 * WHY APPS SCRIPT AT ALL (PROJECT_PLAN §12): the Gmail API path is dead four times
 * over — OAuth "Testing" mode expires refresh tokens after 7 days, `gmail.readonly` is
 * a restricted scope needing verification review, IMAP + app password has been closed
 * to Workspace accounts since March 2025, and a Workspace admin can block third-party
 * OAuth apps anyway. This script sidesteps every one of them by ALREADY RUNNING AS
 * TEJA, inside his own mailbox, with no OAuth app and no token to expire.
 *
 * ---------------------------------------------------------------------------------
 * SETUP — five steps, all in the browser.
 *
 *  1. Sign in to the tracker mailbox and open https://script.google.com → New project.
 *  2. Paste this entire file over the default `Code.gs`.
 *  3. Project Settings → Script Properties → add two properties:
 *
 *       APPLYY_INTAKE_URL      https://<project-ref>.supabase.co/functions/v1/email-tracker-intake
 *       APPLYY_INTAKE_SECRET   <the same random string set as EMAIL_INTAKE_SHARED_SECRET
 *                               in the Supabase function's environment>
 *
 *     Generate the secret with something like `openssl rand -base64 32`. It goes in
 *     exactly two places — here and Supabase — and NOWHERE ELSE. Never in this file,
 *     never in the repo (constraint #11).
 *
 *  4. Run `applyyTestConnection` once from the editor. Google will ask for Gmail and
 *     external-request permission; grant it. The execution log tells you whether the
 *     URL and secret are right BEFORE any trigger fires.
 *  5. Run `applyyInstallTrigger` once. That creates the 15-minute time trigger and
 *     removes any duplicate it finds, so running it twice is safe.
 * ---------------------------------------------------------------------------------
 */

/**
 * The Gmail label applied to every message this script has successfully handed over.
 *
 * WHY A LABEL AND NOT `is:unread`, WHICH IS WHAT THE PLAN SKETCHED: read state belongs
 * to the human, not to the machine. With an `is:unread` query, Teja opening a
 * recruiter's email on his phone before the trigger fires means that email is NEVER
 * ingested — and it fails silently, which is the worst kind. A dedicated label makes
 * "have we sent this?" a fact this script owns, entirely independent of how Teja reads
 * his mail. It is also non-destructive: nothing is marked read, archived or moved.
 */
var APPLYY_LABEL = 'applyy-ingested';

/**
 * How far back to look. Deliberately much wider than the 15-minute trigger interval:
 * the label already prevents re-sending, so overlap costs nothing, while a window
 * equal to the interval would permanently lose anything that arrived during an
 * outage. Cheap redundancy against a failure mode that is otherwise unrecoverable.
 */
var APPLYY_SEARCH_WINDOW = 'newer_than:2d';

/** Messages per POST. Mirrors MAX_MESSAGES_PER_BATCH in `_shared/intake/email-contract.ts`. */
var APPLYY_BATCH_SIZE = 50;

/** Cap on the plain-body text sent as `snippet` (4096 chars, whitespace-collapsed). Mirrors
 *  MAX_SNIPPET_CHARS; the endpoint re-truncates defensively. This is the body, not Gmail's
 *  ~100-char snippet: see the comment on the `snippet` field in applyyCollectMessages_. */
var APPLYY_SNIPPET_LIMIT = 4096;

/** Threads to pull per run. A ceiling on work, so a backlog drains over several runs
 *  instead of one run timing out against Apps Script's own 6-minute execution limit. */
var APPLYY_MAX_THREADS = 200;

/**
 * THE ENTRY POINT. Called either directly on-demand via Web App HTTP trigger (doGet/doPost)
 * or manually from the Apps Script editor.
 */
function applyyIngest() {
  // Serialise runs against each other.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('applyy: another run holds the lock, skipping this tick');
    return { ok: false, message: 'Another sync run already holds the lock.' };
  }
  try {
    // The configuration lives in Script Properties, never in this file (constraint #11).
    var config = applyyReadConfig_();
    // Fail loudly rather than looping forever against a misconfiguration.
    if (config === null) {
      return { ok: false, message: 'Missing APPLYY_INTAKE_URL or APPLYY_INTAKE_SECRET.' };
    }
    // Find or create the label. Doing it once per run keeps the per-thread work cheap.
    var label = applyyEnsureLabel_();
    // Everything recent that this script has not already handed over.
    var threads = GmailApp.search(APPLYY_SEARCH_WINDOW + ' -label:' + APPLYY_LABEL, 0, APPLYY_MAX_THREADS);
    // Nothing to do is the common case.
    if (threads.length === 0) {
      Logger.log('applyy: nothing new');
      return { ok: true, threadsFound: 0, messagesIngested: 0, message: 'No new emails to ingest.' };
    }
    // Flatten threads to messages: a thread with three replies is three events, and
    // collapsing them would lose the rejection that arrived after the acknowledgement.
    var messages = applyyCollectMessages_(threads);
    // Guard against a thread whose messages are all older than the window.
    if (messages.length === 0) {
      Logger.log('applyy: threads matched but no messages inside the window');
      return { ok: true, threadsFound: threads.length, messagesIngested: 0, message: 'No recent messages in matched threads.' };
    }
    // Send in chunks, labelling each chunk's threads only once it is safely stored.
    applyySendInChunks_(messages, config, label, APPLYY_BATCH_SIZE);
    return {
      ok: true,
      threadsFound: threads.length,
      messagesIngested: messages.length,
      message: 'Ingestion completed successfully.'
    };
  } finally {
    // Always release, even on an exception.
    lock.releaseLock();
  }
}

/**
 * Read and validate configuration. Returns null (after logging) when unusable, so the
 * caller stops rather than POSTing to `undefined`.
 */
function applyyReadConfig_() {
  // Script Properties is the Apps Script equivalent of an environment variable.
  var properties = PropertiesService.getScriptProperties();
  // Where to POST.
  var url = properties.getProperty('APPLYY_INTAKE_URL');
  // What to authenticate with.
  var secret = properties.getProperty('APPLYY_INTAKE_SECRET');
  // Both are mandatory; there is no sensible default for either.
  if (!url || !secret) {
    // Named explicitly so the fix needs no source reading.
    Logger.log('applyy: SET APPLYY_INTAKE_URL AND APPLYY_INTAKE_SECRET in Project Settings → Script Properties');
    return null;
  }
  // Catch the commonest paste error — a URL missing the function path — before it
  // becomes a puzzling 404 from the Supabase gateway.
  if (url.indexOf('/functions/v1/email-tracker-intake') === -1) {
    Logger.log('applyy: APPLYY_INTAKE_URL should end in /functions/v1/email-tracker-intake');
    return null;
  }
  // Usable.
  return { url: url, secret: secret };
}

/**
 * Find the ingest label, creating it on first run so setup needs no manual step.
 */
function applyyEnsureLabel_() {
  // Existing label, if this is not the first run.
  var label = GmailApp.getUserLabelByName(APPLYY_LABEL);
  // Create it on the first run rather than asking Teja to; a manual step that only
  // matters once is a manual step that gets forgotten exactly once.
  return label === null ? GmailApp.createLabel(APPLYY_LABEL) : label;
}

/**
 * Flatten threads into the wire shape, carrying each message's thread alongside it so
 * the caller can label the right threads after a successful POST.
 */
function applyyCollectMessages_(threads) {
  // Accumulator for the flattened result.
  var collected = [];
  // One pass over the threads.
  for (var t = 0; t < threads.length; t += 1) {
    // The thread being flattened.
    var thread = threads[t];
    // Every message in it — replies included, since a rejection is usually a reply.
    var messages = thread.getMessages();
    // One pass over this thread's messages.
    for (var m = 0; m < messages.length; m += 1) {
      // The message being converted.
      var message = messages[m];
      // Build the wire object and remember which thread it belongs to.
      collected.push({
        // What crosses the wire, matching the endpoint's expected shape exactly.
        wire: {
          // THE DEDUPE KEY. Gmail's own immutable id, which is what makes a
          // double-fired trigger a harmless no-op at the database.
          message_id: message.getId(),
          // For future thread-level correlation.
          thread_id: thread.getId(),
          // Who sent it. Used later to match a company.
          from: message.getFrom(),
          // Which alias received it, for a multi-address mailbox.
          to: message.getTo(),
          // Subject line.
          subject: message.getSubject(),
          // NOT A SHORT SNIPPET: this is `getPlainBody()` (not `getBody()`, so no HTML),
          // whitespace-collapsed and cut to 4096 chars by applyyyTruncate_. Up to 4096
          // chars of body text, which can include phone numbers, CTC figures and
          // addresses, leaves the mailbox in every POST. What the intake does with it
          // (verified 2026-10-05): the wire validator accepts it
          // (_shared/intake/email-contract.ts:217), the classifier READS it as
          // `parseEmail({body})` -> `cleanBody` (email-tracker-intake/decide.ts:71,75;
          // _shared/email/classifier.ts:246,249) and it is stored in
          // `email_events.snippet` (email-tracker-intake/index.ts:239). Company matching
          // uses from+subject only (decide.ts:159-165). The body is sent so the
          // classifier can see outcome wording that is not in the subject. Sending less
          // (or none) is the owner's privacy decision, not a code fix: it needs an edit
          // here AND a redeploy of the script in Google, and costs classifier accuracy.
          snippet: applyyTruncate_(message.getPlainBody(), APPLYY_SNIPPET_LIMIT),
          // When it arrived, as ISO-8601 for a timestamptz column.
          received_at: message.getDate().toISOString(),
          // Gmail labels, so the classifier can later tell inbox from archived.
          label_ids: applyyThreadLabelNames_(thread),
          // Gmail's own DKIM/SPF verdict (the TOPMOST Authentication-Results header). The
          // intake confirms a submitted application from a receipt ONLY when this shows the
          // ATS really sent it (email-tracker-intake/decide.ts verifyReceiptSender). Null
          // when unreadable, and then nothing is confirmed.
          authentication_results: applyyTopAuthResults_(message)
        },
        // Kept out of the wire object: which thread to label once this is stored.
        thread: thread
      });
    }
  }
  // Flattened and ready to chunk.
  return collected;
}

/**
 * Read a thread's label names. Apps Script exposes labels per thread, not per message,
 * which is close enough — the classifier only needs coarse context.
 */
function applyyThreadLabelNames_(thread) {
  // The label objects on this thread.
  var labels = thread.getLabels();
  // Accumulator for their names.
  var names = [];
  // Convert each to its display name.
  for (var i = 0; i < labels.length; i += 1) {
    names.push(labels[i].getName());
  }
  // Plain strings, which is what the endpoint validates for.
  return names;
}

/**
 * Cut a string to a maximum length. Defensive on both sides: the endpoint truncates
 * too, but sending less costs nothing and keeps us well inside the 1MB body ceiling.
 */
/**
 * Gmail's own Authentication-Results header value, or null.
 *
 * Gmail PREPENDS this header when the mail arrives, so the FIRST one in the raw message is
 * Google's verdict. A sender can embed its own forged "Authentication-Results: ...
 * dkim=pass" lower down, but can't put one above Google's, so only the first is sent.
 * (getHeader is not used: which of several same-named headers it returns is undocumented.)
 */
function applyyTopAuthResults_(message) {
  // Raw RFC 822 text; any failure (quota, an oversized message) means "unknown".
  try {
    // The whole message as Gmail stored it.
    var raw = message.getRawContent();
    // The header block ends at the first blank line; the body is never scanned.
    var end = raw.search(/\r?\n\r?\n/);
    // No blank line means no parseable header block.
    if (end < 0) return null;
    // Unfold continuation lines (CRLF + whitespace) so one header is one line.
    var headers = raw.substring(0, end).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
    // First match wins: that is Google's.
    for (var i = 0; i < headers.length; i++) {
      // Header names are case-insensitive.
      var match = headers[i].match(/^authentication-results:\s*(.*)$/i);
      // Trimmed and capped to the intake's limit (MAX_AUTH_RESULTS_CHARS).
      if (match) return match[1].trim().substring(0, 4096) || null;
    }
    // No such header at all.
    return null;
  } catch (e) {
    // Unreadable: the intake treats null as "cannot confirm".
    return null;
  }
}

function applyyTruncate_(text, limit) {
  // A message with no plain body is legal — HTML-only mail exists.
  if (!text) return '';
  // Collapse whitespace: a quoted reply chain is mostly newlines, and they consume
  // the body budget without carrying meaning.
  var collapsed = String(text).replace(/\s+/g, ' ').trim();
  // Cut to the ceiling.
  return collapsed.length > limit ? collapsed.substring(0, limit) : collapsed;
}

/**
 * POST the messages in chunks, halving on 413, and labelling only what was stored.
 *
 * THE INVARIANT THIS FUNCTION EXISTS TO PROTECT: a thread is labelled if and only if
 * the endpoint has confirmed it stored the message. Label before the POST and a 500
 * loses the mail forever; never label and every run re-sends everything. So the label
 * write happens after a 202 and after nothing else.
 */
function applyySendInChunks_(messages, config, label, chunkSize) {
  // Walk the flattened list.
  var index = 0;
  // Continue until every message has been attempted.
  while (index < messages.length) {
    // The slice to send this time. `chunkSize` shrinks below on a 413.
    var slice = messages.slice(index, index + chunkSize);
    // Attempt it.
    var outcome = applyyPostBatch_(slice, config);
    // 413: the batch was too large. Halve and retry the SAME messages rather than
    // advancing — advancing would silently skip them.
    if (outcome === 'too_large') {
      // A single message that is still too large cannot be split further; skip it and
      // say so, rather than looping forever on it.
      if (chunkSize <= 1) {
        Logger.log('applyy: a single message exceeds the body limit, skipping it');
        index += 1;
        continue;
      }
      // Halve, minimum one, and retry the same offset.
      chunkSize = Math.max(1, Math.floor(chunkSize / 2));
      Logger.log('applyy: 413, retrying with chunk size ' + chunkSize);
      continue;
    }
    // Stored. Label the threads so no future run re-sends them.
    if (outcome === 'accepted') {
      applyyLabelThreads_(slice, label);
      index += chunkSize;
      continue;
    }
    // 400 or 401: this will fail identically forever, so retrying wastes quota and
    // fills the log. Stop the whole run — if the secret is wrong, every subsequent
    // chunk fails too, and a hundred identical 401s helps nobody.
    if (outcome === 'permanent') {
      Logger.log('applyy: permanent failure, aborting this run. Check the URL and secret.');
      return;
    }
    // 429/500/network: DO NOTHING. Do not label, do not advance, do not retry in this
    // run. The messages stay unlabelled, so the next 15-minute trigger picks them up
    // naturally — the search window IS the retry queue, and building a second one
    // would be a queue that can itself get stuck.
    Logger.log('applyy: transient failure, leaving the rest for the next trigger');
    return;
  }
}

/**
 * POST one chunk. Returns a coarse outcome rather than a status code, so the caller's
 * decision table is about what to DO rather than about HTTP.
 */
function applyyPostBatch_(slice, config) {
  // Strip the thread handles; only the wire objects cross the network.
  var wire = [];
  // One pass over the slice.
  for (var i = 0; i < slice.length; i += 1) {
    wire.push(slice[i].wire);
  }
  // The envelope. `batch_id` is observability only — the DEDUPE KEY IS PER-MESSAGE,
  // deliberately, because a double-fired trigger re-sends the same messages under a
  // different batch id, so deduping on the batch would catch nothing at all.
  var payload = {
    batch_id: Utilities.getUuid(),
    sent_at: new Date().toISOString(),
    messages: wire
  };
  // Attempt the request. A network failure throws rather than returning a response.
  var response;
  try {
    response = UrlFetchApp.fetch(config.url, {
      // The endpoint accepts POST only.
      method: 'post',
      // JSON body.
      contentType: 'application/json',
      // The shared secret. A custom header rather than `Authorization`, which the
      // Supabase gateway has its own opinions about.
      headers: { 'X-Applyy-Intake-Secret': config.secret },
      // Serialised envelope.
      payload: JSON.stringify(payload),
      // WITHOUT THIS, UrlFetchApp THROWS ON ANY NON-2xx AND THE STATUS IS UNREADABLE —
      // which would collapse 400, 401, 413 and 500 into one indistinguishable
      // exception, and the 413 split-and-retry path could never run.
      muteHttpExceptions: true
    });
  } catch (error) {
    // DNS, TLS or timeout. Transient by assumption; the next trigger retries.
    Logger.log('applyy: network error: ' + error);
    return 'transient';
  }
  // The status is the instruction.
  var status = response.getResponseCode();
  // 202 is the only success. 200 would mean something else happened.
  if (status === 202) {
    // Log the counts: `duplicates` being non-zero is the visible evidence that the
    // trigger double-fired and that idempotency absorbed it.
    Logger.log('applyy: accepted ' + response.getContentText());
    return 'accepted';
  }
  // Split and retry.
  if (status === 413) {
    return 'too_large';
  }
  // Do not retry: malformed, or the secret is wrong. Either needs a human.
  if (status === 400 || status === 401 || status === 405) {
    Logger.log('applyy: permanent failure ' + status + ': ' + response.getContentText());
    return 'permanent';
  }
  // 429, 5xx and anything unexpected: leave the mail unlabelled and let the next
  // trigger try again.
  Logger.log('applyy: transient failure ' + status + ': ' + response.getContentText());
  return 'transient';
}

/**
 * Label the threads behind a stored chunk. Deduplicated because several messages in
 * one chunk routinely belong to the same thread, and labelling it five times is five
 * pointless Gmail writes against the daily quota.
 */
function applyyLabelThreads_(slice, label) {
  // Thread ids already labelled during this call.
  var seen = {};
  // One pass over the chunk.
  for (var i = 0; i < slice.length; i += 1) {
    // The thread this message belongs to.
    var thread = slice[i].thread;
    // Its id, used as the dedupe key within this chunk.
    var id = thread.getId();
    // Skip a thread already handled a moment ago.
    if (seen[id]) continue;
    // Remember it.
    seen[id] = true;
    // Apply the label. This is the ONLY mutation this script makes to the mailbox —
    // nothing is read, archived, starred or moved.
    thread.addLabel(label);
  }
}

/**
 * Install the 15-minute trigger. Safe to run repeatedly: it removes any existing
 * trigger for this function first, so a second run replaces rather than duplicates.
 */
function applyyInstallTrigger() {
  // Everything currently scheduled in this project.
  var existing = ScriptApp.getProjectTriggers();
  // Remove any prior trigger for this handler. WITHOUT THIS, running setup twice gives
  // two triggers, which doubles every run — the exact double-fire the lock and the
  // idempotency defend against, made permanent.
  for (var i = 0; i < existing.length; i += 1) {
    if (existing[i].getHandlerFunction() === 'applyyIngest') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  // One trigger, every fifteen minutes.
  ScriptApp.newTrigger('applyyIngest').timeBased().everyMinutes(15).create();
  // Confirm in the execution log, since a trigger's existence is otherwise invisible
  // until the next tick.
  Logger.log('applyy: trigger installed, every 15 minutes');
}

/**
 * Verify the URL and secret WITHOUT touching the mailbox. Run this from the editor
 * before installing the trigger — it turns "why is nothing arriving?" from a
 * fifteen-minute guessing loop into an immediate, readable answer.
 */
function applyyTestConnection() {
  // Same configuration path the real run uses, so this tests the real thing.
  var config = applyyReadConfig_();
  // Already logged the specific problem.
  if (config === null) return;
  // An EMPTY batch. The endpoint accepts zero messages as a legal no-op, which makes
  // it a perfect probe: it exercises the URL, the secret and the JSON contract while
  // storing nothing at all.
  var response = UrlFetchApp.fetch(config.url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Applyy-Intake-Secret': config.secret },
    payload: JSON.stringify({ batch_id: Utilities.getUuid(), sent_at: new Date().toISOString(), messages: [] }),
    muteHttpExceptions: true
  });
  // The status code carries the whole diagnosis.
  var status = response.getResponseCode();
  // Success.
  if (status === 202) {
    Logger.log('applyy: OK — URL and secret are correct. ' + response.getContentText());
    return;
  }
  // The single most likely setup failure, called out by name so the fix is obvious.
  if (status === 401) {
    Logger.log('applyy: 401 — APPLYY_INTAKE_SECRET does not match EMAIL_INTAKE_SHARED_SECRET in Supabase.');
    return;
  }
  // The second most likely: the function is not deployed, or the URL is wrong.
  if (status === 404) {
    Logger.log('applyy: 404 — the function is not deployed at that URL. Check APPLYY_INTAKE_URL.');
    return;
  }
  // Anything else, with the body, which usually names the cause.
  Logger.log('applyy: unexpected ' + status + ': ' + response.getContentText());
}

/**
 * Remove ALL time-driven triggers.
 *
 * RUN THIS FUNCTION ONCE from the Apps Script editor to eliminate continuous
 * 15-minute background polling triggers.
 * After running this, monitoring runs solely on-demand when you open or refresh the web console.
 */
function applyyRemoveTriggers() {
  var existing = ScriptApp.getProjectTriggers();
  var count = 0;
  for (var i = 0; i < existing.length; i += 1) {
    ScriptApp.deleteTrigger(existing[i]);
    count += 1;
  }
  Logger.log('applyy: Successfully deleted ' + count + ' trigger(s). 15-minute background polling is stopped.');
}

/**
 * Web App HTTP GET handler for on-demand sync.
 * Invoked when the web dashboard is opened or when the operator clicks "Refresh Interviews".
 */
function doGet(e) {
  return handleOnDemandSync_(e);
}

/**
 * Web App HTTP POST handler for on-demand sync.
 */
function doPost(e) {
  return handleOnDemandSync_(e);
}

/**
 * Internal handler for Web App HTTP requests.
 * Authenticates against APPLYY_INTAKE_SECRET passed via query parameter ?secret=... or ?key=...
 */
function handleOnDemandSync_(e) {
  var config = applyyReadConfig_();
  if (config === null) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: 'APPLYY_INTAKE_URL or APPLYY_INTAKE_SECRET not configured in Script Properties.'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // Verify authorization secret token
  var secretParam = (e && e.parameter && (e.parameter.secret || e.parameter.key)) || '';
  if (secretParam !== config.secret) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: 'Unauthorized: invalid or missing secret parameter.'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // Execute ingestion
  var result = applyyIngest();
  return ContentService.createTextOutput(JSON.stringify({
    ok: result ? result.ok : true,
    timestamp: new Date().toISOString(),
    details: result
  })).setMimeType(ContentService.MimeType.JSON);
}

