// Tests for persisting a Tailor verdict.
//
// THE RULE UNDER TEST, in one line: THE STATUS IS A CLAIM THAT THE PAYLOAD EXISTS, so
// the payload must be written first and the status must not move if that write failed.
// Reversing the order opens a window in which a row sits at `tailored` with a null
// `tailored_profile` — precisely the state `ApprovalQueuePage.tsx:214` exists to refuse,
// manufactured by the writer instead of by a missing agent.
//
// WHY ORDER IS ASSERTED RATHER THAN ASSUMED: both calls succeed in the happy path, so a
// test that merely checked "profile written" and "status advanced" would pass against
// the broken ordering too. Recording the sequence is the only assertion that can tell
// the two implementations apart.
import { test } from "node:test";
// Strict, so a missing key never compares equal to a key holding `undefined`.
import assert from "node:assert/strict";
// Extension-suffixed specifier so this runs under Deno and `node --test` alike.
import { persistTailorOutcome, type TailorPersistClient } from "./persist.ts";
// The verdict shape produced by the runner this module persists.
import type { TailorOutcome } from "./tailorer.ts";
// The render input, so the fixture below is typed against the contract, not inferred.
import type { ResolvedResume, TailoredProfile } from "../contracts/shared-types.ts";

// The row being written. A literal rather than a generated id, so a failed assertion
// names something searchable.
const APPLICATION_ID = "11111111-2222-3333-4444-555555555555";

// A minimal resolved resume. Its CONTENT is irrelevant here — the validator's tests own
// that — but it must be a real `ResolvedResume` so a contract change breaks this file
// rather than letting it drift on an inferred literal.
const RESUME: ResolvedResume = {
  schema_version: 1,
  master_version: 7,
  identity: {
    full_name: "Teja Mallam",
    headline: "Backend Engineer",
    email: "tejamallam00@gmail.com",
    phone: null,
    location: "Hyderabad",
    links: [],
  },
  section_order: ["experience"],
  summary: null,
  skills: [],
  experience: [],
  projects: [],
  education: [],
  achievements: [],
  certifications: [],
};

// The raw ref-based output the resume was resolved from. Content is irrelevant here;
// identity is what the test checks, so a cast keeps the fixture small.
const REFS = { master_version: 7, summary: null } as unknown as TailoredProfile;

// A clean verdict, ready to persist.
// `jdKeywords` is a recognisable pair so the keyword test can assert it arrived intact.
const TAILORED: TailorOutcome = { kind: "tailored", resume: RESUME, refs: REFS, jdKeywords: ["Go", "PostgreSQL"] };

// One recorded call against the database seam, in the order it was made.
interface RecordedCall {
  // "update" or "rpc" — which half of the write this was.
  readonly kind: string;
  // The payload, so a test can assert on what was actually sent.
  readonly payload: Record<string, unknown>;
}

// A fake client that records every call and can be told to fail a chosen one.
//
// RECORDS RATHER THAN MOCKS: the assertions below are about the sequence and the
// arguments this module produced, which are real behaviour. Nothing here asserts that a
// mock was called — that would test the fake instead of the code.
function recordingClient(failOn?: "update" | "rpc") {
  // Shared across both branches, so ordering between an update and an rpc is visible.
  const calls: RecordedCall[] = [];
  // Built to the narrow shape `persist.ts` declares, not to postgrest's full surface.
  const client: TailorPersistClient = {
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => ({
        eq: (column: string, value: string) => {
          // Capture everything a caller could get wrong: table, columns, and predicate.
          calls.push({ kind: "update", payload: { table, values, column, value } });
          // Errors are DATA on this seam, exactly as postgrest returns them.
          return Promise.resolve({ error: failOn === "update" ? { message: "write refused" } : null });
        },
      }),
    }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      // The status move, captured with its arguments so the agent can be asserted.
      calls.push({ kind: "rpc", payload: { fn, args } });
      return Promise.resolve({ error: failOn === "rpc" ? { message: "transition refused" } : null });
    },
  };
  return { client, calls };
}

test("a clean tailoring writes the profile before it advances the status", async () => {
  const { client, calls } = recordingClient();

  await persistTailorOutcome(client, APPLICATION_ID, TAILORED);

  // THE ORDER IS THE ASSERTION. Both calls succeed, so only the sequence distinguishes
  // a correct implementation from one that advances first and writes after.
  assert.deepEqual(calls.map((c) => c.kind), ["update", "rpc"]);
});

test("the profile write targets the right row and column", async () => {
  const { client, calls } = recordingClient();

  await persistTailorOutcome(client, APPLICATION_ID, TAILORED);

  // The resolved resume lands in the column the approval queue reads.
  assert.equal((calls[0].payload.values as Record<string, unknown>).tailored_profile, RESUME);
  // Scoped to one row. A missing predicate here would rewrite every application.
  assert.equal(calls[0].payload.column, "id");
  assert.equal(calls[0].payload.value, APPLICATION_ID);
});

test("the raw tailor refs are written in the SAME update as the profile", async () => {
  const { client, calls } = recordingClient();

  await persistTailorOutcome(client, APPLICATION_ID, TAILORED);

  // Same statement, not a second write: a row at `tailored` with a profile but no refs
  // would silently disable the Auditor's ref check for that row.
  assert.equal((calls[0].payload.values as Record<string, unknown>).tailor_refs, REFS);
  // Still one update and one rpc — the refs did not add a write that could half-fail.
  assert.deepEqual(calls.map((c) => c.kind), ["update", "rpc"]);
});

test("persist writes selected_jd_keywords alongside tailored_profile", async () => {
  // A clean run against the recording fake.
  const { client, calls } = recordingClient();
  // Persist the clean verdict.
  await persistTailorOutcome(client, APPLICATION_ID, TAILORED);
  // The first call's columns: the one update statement.
  const values = calls[0].payload.values as Record<string, unknown>;
  // The keywords are in the SAME statement as the profile, so the approval page can never
  // read a written resume with an empty ATS denominator (the 0% bug, 2026-10-06).
  assert.deepEqual(values.selected_jd_keywords, ["Go", "PostgreSQL"]);
  // And the profile is in that statement too, which is what "alongside" means.
  assert.equal(values.tailored_profile, RESUME);
  // A plain array, because postgrest serialises it to the `text[]` column.
  assert.ok(Array.isArray(values.selected_jd_keywords));
  // Still exactly one update and one rpc: the keywords added no write that could half-fail.
  assert.deepEqual(calls.map((c) => c.kind), ["update", "rpc"]);
});

test("the status advance names the tailor agent and the tailored status", async () => {
  const { client, calls } = recordingClient();

  await persistTailorOutcome(client, APPLICATION_ID, TAILORED);

  // Through the RPC, never a bare UPDATE: the guard refuses an anonymous status change
  // with SQLSTATE 42501, and the RPC is what sets the acting agent for the transaction.
  assert.equal(calls[1].payload.fn, "advance_application_status");
  const args = calls[1].payload.args as Record<string, unknown>;
  // `scored -> tailored` is the Tailor's only legal edge (status_transition_guard.sql:116).
  assert.equal(args.p_to_status, "tailored");
  // Named agent must match the edge's allowed list, or the guard refuses with 42501.
  assert.equal(args.p_agent, "tailor");
});

test("a failed profile write does not advance the status", async () => {
  // The write fails. THE POINT: a status of `tailored` asserts a profile exists, so
  // moving the row anyway would make the database lie in exactly the way the approval
  // gate was built to catch — and would do it from the trusted side.
  const { client, calls } = recordingClient("update");

  const result = await persistTailorOutcome(client, APPLICATION_ID, TAILORED);

  // The rpc must never have been reached.
  assert.deepEqual(calls.map((c) => c.kind), ["update"]);
  // And the caller is told, rather than the failure being swallowed into a success.
  assert.equal(result.ok, false);
});

test("a refusal advances to failed and writes no profile", async () => {
  // A verdict, not a crash: the row is failed with reasons a human can act on.
  const refused: TailorOutcome = {
    kind: "refused",
    violations: [{ kind: "master_version_mismatch", expected: 7, received: 6 }],
  };
  const { client, calls } = recordingClient();

  await persistTailorOutcome(client, APPLICATION_ID, refused);

  // NO PROFILE WRITE AT ALL. Persisting a partial or empty profile on a refusal is what
  // would put a `'{}'` row past the queue's null check — the hazard is created by a
  // writer, not by the gate, and this is the writer.
  assert.deepEqual(calls.map((c) => c.kind), ["rpc"]);
  const args = calls[0].payload.args as Record<string, unknown>;
  // `scored -> failed` is legal for the tailor (status_transition_guard.sql:118).
  assert.equal(args.p_to_status, "failed");
  assert.equal(args.p_agent, "tailor");
});

test("a refusal carries its violations into the event detail", async () => {
  // The violations are the dashboard's content. `validator.ts:70` requires they be
  // persisted rather than lost in a stack trace, and this is where that happens.
  const refused: TailorOutcome = {
    kind: "refused",
    violations: [{ kind: "master_version_mismatch", expected: 7, received: 6 }],
  };
  const { client, calls } = recordingClient();

  await persistTailorOutcome(client, APPLICATION_ID, refused);

  const args = calls[0].payload.args as Record<string, unknown>;
  const detail = args.p_detail as Record<string, unknown>;
  // Carried as structured data, not a flattened message — the kind is what a UI
  // branches on, and a string would force it to parse prose back into a discriminant.
  assert.deepEqual(detail.violations, refused.kind === "refused" ? refused.violations : []);
});

test("re-tailoring a row clears its cover letter", async () => {
  // A clean run against the recording fake.
  const { client, calls } = recordingClient();
  // Persist the clean verdict — the same write path a re-tailored row would take.
  await persistTailorOutcome(client, APPLICATION_ID, TAILORED);
  // The one update statement's columns.
  const values = calls[0].payload.values as Record<string, unknown>;
  // WHY (2026-10-24 finding): a cover letter quotes the tailored_profile it was built from,
  // is write-once (`cover-letter/run.ts:136` queues only `cover_letter is null`), and nothing
  // else ever clears it. A new profile with the old letter kept would be a stale letter that
  // the approval page cannot flag (editCount resets to 0 against the NEW tailor original).
  // Clearing here makes that state unrepresentable; today it is a no-op (the tailor's only
  // edge is scored -> tailored, where no letter exists yet), it matters the day the
  // audit_flagged -> tailored re-tailor lane (humanLanes.ts:151, affordance_only) is wired.
  assert.equal(values.cover_letter, null);
  // Its CHECK-constraint partner (`applications_cover_letter_consistent`: both null or both
  // set), cleared in the same statement so the constraint can never refuse the write.
  assert.equal(values.cover_letter_generated_at, null);
  // `undefined` would mean "column not sent" — PostgREST drops it and the stale letter stays.
  assert.ok("cover_letter" in values && "cover_letter_generated_at" in values);
  // SAME statement as the profile: a second write could fail alone and leave the stale pair.
  assert.equal(values.tailored_profile, RESUME);
  // Still exactly one update and one rpc: the clear added no write that could half-fail.
  assert.deepEqual(calls.map((c) => c.kind), ["update", "rpc"]);
});

test("persist writes applications.master_version from the resume pin in the SAME update", async () => {
  // A clean run against the recording fake.
  const { client, calls } = recordingClient();
  // Persist the clean verdict.
  await persistTailorOutcome(client, APPLICATION_ID, TAILORED);
  // The first call is the one update statement.
  const values = calls[0].payload.values as Record<string, unknown>;
  // The column must equal the pin the validator stamped into the resume. It was never
  // written before 2026-10-08, so the auditor and the approval page had to read JSON.
  assert.equal(values.master_version, RESUME.master_version);
  // A real number, so the composite FK to master_profiles(user_id, version) can check it.
  assert.equal(typeof values.master_version, "number");
  // Same statement as the profile, so the column can never disagree with the JSON it mirrors.
  assert.equal(values.tailored_profile, RESUME);
  // Still exactly one update and one rpc: the pin added no write that could half-fail.
  assert.deepEqual(calls.map((c) => c.kind), ["update", "rpc"]);
});
