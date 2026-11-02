// Tests for the Apps Script pipe (W33, W16; 2026-11-02). The .gs runs in Google, so it had no
// test at all; here it is evaluated in a node:vm context with the Apps Script globals stubbed,
// which runs the REAL file text rather than a copy that could drift from it.
import { test } from "node:test";
// Strict equality so null and undefined stay distinct.
import assert from "node:assert/strict";
// Reads the script as text: it is not a module and has no exports.
import { readFileSync } from "node:fs";
// A fresh global scope per test, so one test's stubs never leak into the next.
import vm from "node:vm";
// The classifier's vendor vocabulary: the Gmail query must name every sender it knows.
import { ATS_VENDOR_DOMAINS } from "../email/parser.ts";

// The script under test, read once; resolved from this file so any cwd works.
const SOURCE = readFileSync(new URL("./email-tracker.gs", import.meta.url), "utf8");

// The two secrets W16 separates: the intake's (header to email-tracker-intake) and the sync's.
const INTAKE_SECRET = "intake-secret-t3st";
// The on-demand sync's own secret, sent by gmail-sync in the POST body.
const SYNC_SECRET = "sync-secret-t3st";

// Loads the script into a context with every Apps Script service it touches stubbed.
function loadScript(properties: Record<string, string | null>) {
  // What the script stored, and whether ingestion ran: the assertions read these.
  const state = { ingestCalls: 0, searches: [] as string[] };
  // Script Properties: reads the canned map, writes into it (the cooldown stamp).
  const props = { getProperty: (key: string) => properties[key] ?? null, setProperty: (key: string, value: string) => void (properties[key] = value) };
  // The globals the script references at call time.
  const context = vm.createContext({
    // Configuration reads.
    PropertiesService: { getScriptProperties: () => props },
    // The JSON reply: keeps the text so a test can parse what the Web App answered.
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (text: string) => ({ text, setMimeType() { return this; } }) },
    // A lock that is always free.
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }) },
    // Records every query the script runs; returns no threads.
    GmailApp: { search: (query: string) => (state.searches.push(query), []), getUserLabelByName: () => ({}), createLabel: () => ({}) },
    // The heartbeat POST; answered 202 so nothing retries.
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 202, getContentText: () => "{}" }) },
    // Logging goes nowhere.
    Logger: { log: () => undefined },
    // Batch ids.
    Utilities: { getUuid: () => "uuid", sleep: () => undefined },
  });
  // Runs the file: its top-level `var`s and functions become context properties.
  vm.runInContext(SOURCE, context);
  // Typed view of what the tests call.
  const script = context as unknown as { doGet: (e: unknown) => { text: string }; doPost: (e: unknown) => { text: string }; applyyIngest: () => unknown; applyySearchQuery_: () => string };
  // Ingestion replaced by a counter, so the auth tests never reach Gmail.
  script.applyyIngest = () => ((state.ingestCalls += 1), { ok: true });
  // Both handles for the test.
  return { script, state };
}

// Both secrets configured, as after the orchestrator's setup steps.
const CONFIGURED = { APPLYY_INTAKE_URL: "https://x.supabase.co/functions/v1/email-tracker-intake", APPLYY_INTAKE_SECRET: INTAKE_SECRET, APPLYY_SYNC_SECRET: SYNC_SECRET };

// A doPost event the way Apps Script builds it: the JSON body arrives as postData.contents.
const postWith = (body: unknown, parameter: Record<string, string> = {}) => ({ parameter, postData: { contents: JSON.stringify(body), type: "application/json" } });

test("W33: the Gmail search names the ATS senders and job phrases, not the whole inbox", () => {
  // The query the hourly run uses.
  const { script } = loadScript({ ...CONFIGURED });
  // Built by the one function applyyIngest calls.
  const query = script.applyySearchQuery_();
  // Still bounded in time and still skips what was already sent.
  assert.match(query, /newer_than:2d/);
  // The label exclusion that makes re-runs idempotent.
  assert.match(query, /-label:applyy-ingested/);
  // Every vendor the classifier treats as an ATS sender is searched by sender.
  for (const domain of ATS_VENDOR_DOMAINS) assert.ok(query.includes(`from:${domain}`), `query misses from:${domain}`);
  // Employer-direct mail is caught by job-lifecycle phrases, one per outcome the tracker reads.
  for (const phrase of ['"your application"', '"interview"', '"assessment"', '"offer letter"']) assert.ok(query.includes(phrase), `query misses ${phrase}`);
  // The old whole-inbox query is exactly the window plus the label: refused here by shape.
  assert.notEqual(query.trim(), "newer_than:2d -label:applyy-ingested");
});

test("W33: the ingest run searches with that query", () => {
  // A run with no threads, so it only searches and sends a heartbeat.
  const { script, state } = loadScript({ ...CONFIGURED });
  // The real ingest, not the counter: restore it from the file for this one test.
  vm.runInContext(SOURCE, script as unknown as vm.Context);
  // One run.
  script.applyyIngest();
  // It searched once, with the narrowed query.
  assert.deepEqual(state.searches, [script.applyySearchQuery_()]);
});

test("W16: the on-demand sync accepts its own secret in the POST body", () => {
  // Configured.
  const { script, state } = loadScript({ ...CONFIGURED });
  // gmail-sync's request shape.
  const reply = JSON.parse(script.doPost(postWith({ secret: SYNC_SECRET })).text);
  // Ran once.
  assert.deepEqual([reply.ok, state.ingestCalls], [true, 1]);
});

test("W16: the intake secret no longer opens the on-demand sync", () => {
  // Configured with two DIFFERENT secrets.
  const { script, state } = loadScript({ ...CONFIGURED });
  // The old shared secret, in the body.
  const reply = JSON.parse(script.doPost(postWith({ secret: INTAKE_SECRET })).text);
  // Refused, nothing ran.
  assert.deepEqual([reply.ok, state.ingestCalls], [false, 0]);
});

test("W16: a secret in the URL query is refused, by GET or by POST", () => {
  // Configured.
  const { script, state } = loadScript({ ...CONFIGURED });
  // The old route: GET /exec?secret=...
  const viaGet = JSON.parse(script.doGet({ parameter: { secret: SYNC_SECRET } }).text);
  // A POST whose secret rides in the query instead of the body.
  const viaPostQuery = JSON.parse(script.doPost({ parameter: { secret: SYNC_SECRET, key: SYNC_SECRET } }).text);
  // Both refused, nothing ran.
  assert.deepEqual([viaGet.ok, viaPostQuery.ok, state.ingestCalls], [false, false, 0]);
});

test("W16: an unset sync secret fails closed, even for a body that matches the intake secret", () => {
  // The state between pasting this script and setting the new property.
  const { script, state } = loadScript({ ...CONFIGURED, APPLYY_SYNC_SECRET: null });
  // Neither the intake secret nor an empty one opens it.
  const withIntake = JSON.parse(script.doPost(postWith({ secret: INTAKE_SECRET })).text);
  // An empty secret must not equal an empty property.
  const withEmpty = JSON.parse(script.doPost(postWith({ secret: "" })).text);
  // Both refused, nothing ran.
  assert.deepEqual([withIntake.ok, withEmpty.ok, state.ingestCalls], [false, false, 0]);
});
